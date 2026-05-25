/**
 * Pre-signed upload / download routes (no JWT — token-authenticated).
 *
 * Mounted on the root app **before** `app.use("/v1/*", mcpAuth)` so the JWT
 * middleware doesn't fire. The token is a one-shot row in `pending_uploads`
 * issued by the JWT-protected `*-init` endpoints under `/v1/files/`.
 *
 * Surface:
 *   - `PUT /upload/:token`  — raw bytes (single) or tar.gz bytes (bulk).
 *   - `GET /download/:token` — streams the matching R2 blob.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import type { AppEnv } from "../env";
import { db, type DB } from "../db";
import {
  files as filesTable,
  revisions as revisionsTable,
} from "../db/schema";
import { sha256Hex } from "../lib/hash";
import { normalizePath, PathError, splitParent } from "../lib/path";
import { ensureFolderPath, ensureRepoOwned } from "../lib/repo-ops";
import { parseTarGz, type TarEntry } from "../lib/tar";
import { loadToken, markConsumed } from "../lib/upload-token";

import {
  fileRowToDto,
  revRowToDto,
  type FileRow,
  type RevisionRow,
} from "./files";

export const uploads = new Hono<AppEnv>();

function blobKey(repoId: string, fileId: string, revNumber: number): string {
  return `files/${repoId}/${fileId}/${revNumber}`;
}

async function loadFileByPath(
  handle: DB,
  repoId: string,
  path: string,
): Promise<FileRow | null> {
  const rows = (await handle
    .select()
    .from(filesTable)
    .where(and(eq(filesTable.repoId, repoId), eq(filesTable.path, path)))
    .limit(1)
    .all()) as FileRow[];
  return rows[0] ?? null;
}

/** Shared "append-or-create revision" core, called per file by both single + tar.gz paths. */
async function commitRevision(
  handle: DB,
  env: AppEnv["Bindings"],
  args: {
    repoId: string;
    path: string;
    bytes: Uint8Array;
    mime: string | null;
    message: string | null;
    authorLogin: string;
  },
): Promise<{ file: FileRow; revision: RevisionRow; created: boolean }> {
  const { repoId, path, bytes, mime, message, authorLogin } = args;
  const { parent: parentPath, name } = splitParent(path);
  const folder = await ensureFolderPath(handle, repoId, parentPath);
  const now = new Date().toISOString();
  const sha = await sha256Hex(bytes);
  const size = bytes.byteLength;

  const existing = await loadFileByPath(handle, repoId, path);
  if (existing) {
    const revNumber = existing.currentRevisionNumber + 1;
    const revId = crypto.randomUUID();
    const key = blobKey(repoId, existing.id, revNumber);
    await env.BLOBS.put(key, bytes, {
      httpMetadata: mime ? { contentType: mime } : undefined,
    });
    const revRow: RevisionRow = {
      id: revId,
      fileId: existing.id,
      revNumber,
      blobKey: key,
      size,
      sha256: sha,
      mime,
      authorLogin,
      message,
      createdAt: now,
    };
    await handle.insert(revisionsTable).values(revRow).run();
    await handle
      .update(filesTable)
      .set({
        currentRevisionId: revId,
        currentRevisionNumber: revNumber,
        size,
        mime,
        updatedAt: now,
        deletedAt: null,
        folderId: folder ? folder.id : null,
      })
      .where(eq(filesTable.id, existing.id))
      .run();
    return {
      file: {
        ...existing,
        currentRevisionId: revId,
        currentRevisionNumber: revNumber,
        size,
        mime,
        updatedAt: now,
        deletedAt: null,
        folderId: folder ? folder.id : null,
      },
      revision: revRow,
      created: false,
    };
  }

  const fileId = crypto.randomUUID();
  const revNumber = 1;
  const revId = crypto.randomUUID();
  const key = blobKey(repoId, fileId, revNumber);
  await env.BLOBS.put(key, bytes, {
    httpMetadata: mime ? { contentType: mime } : undefined,
  });
  const fileRow: FileRow = {
    id: fileId,
    repoId,
    folderId: folder ? folder.id : null,
    name,
    path,
    currentRevisionId: revId,
    currentRevisionNumber: revNumber,
    size,
    mime,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const revRow: RevisionRow = {
    id: revId,
    fileId,
    revNumber,
    blobKey: key,
    size,
    sha256: sha,
    mime,
    authorLogin,
    message,
    createdAt: now,
  };
  try {
    await handle.insert(filesTable).values(fileRow).run();
  } catch {
    await env.BLOBS.delete(key);
    // Race: another caller created the path between select & insert.
    // Re-load and retry as an "existing" revision append.
    const after = await loadFileByPath(handle, repoId, path);
    if (!after) throw new Error("file_race");
    return commitRevision(handle, env, args);
  }
  await handle.insert(revisionsTable).values(revRow).run();
  return { file: fileRow, revision: revRow, created: true };
}

function joinPath(base: string, rel: string): string {
  const cleanRel = rel.replace(/^\/+/, "");
  if (base === "") return cleanRel;
  return `${base}/${cleanRel}`;
}

// PUT /upload/:token — consume a pre-signed upload token.
uploads.put("/upload/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "bad_request", reason: "token" }, 400);
  if (!c.req.raw.body) return c.json({ error: "bad_request", reason: "body" }, 400);

  const handle = db(c.env);
  const loaded = await loadToken(handle, token);
  if (!loaded.ok) {
    const status = loaded.reason === "not_found" ? 404 : 410;
    return c.json({ error: "gone", reason: loaded.reason }, status);
  }
  const row = loaded.row;
  if (row.kind === "download") {
    return c.json({ error: "bad_request", reason: "wrong_kind" }, 400);
  }

  // Re-check repo ownership in case it was renamed / transferred between
  // issue and consume.
  const repo = await ensureRepoOwned(handle, row.repoId, row.ownerLogin);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  const ab = await c.req.raw.arrayBuffer();
  const bytes = new Uint8Array(ab);

  if (row.kind === "single") {
    let path: string;
    try {
      path = normalizePath(row.path);
    } catch (err) {
      return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
    }
    if (path === "") return c.json({ error: "bad_request", reason: "root_file" }, 400);
    const result = await commitRevision(handle, c.env, {
      repoId: row.repoId,
      path,
      bytes,
      mime: row.mime,
      message: row.message,
      authorLogin: row.ownerLogin,
    });
    await markConsumed(handle, token);
    return c.json(
      { file: fileRowToDto(result.file), revision: revRowToDto(result.revision) },
      result.created ? 201 : 200,
    );
  }

  // tar.gz bulk
  const stream = new Response(bytes).body;
  if (!stream) return c.json({ error: "internal_error", reason: "no_body_stream" }, 500);
  let entries: TarEntry[];
  try {
    entries = await parseTarGz(stream);
  } catch (err) {
    return c.json(
      { error: "bad_request", reason: "tar_parse", message: (err as Error).message },
      400,
    );
  }

  let basePath = "";
  try {
    basePath = normalizePath(row.path);
  } catch {
    basePath = "";
  }

  const results: Array<{ path: string; file_id: string; revision_id: string; size: number; sha256: string }> = [];
  for (const entry of entries) {
    if (entry.bytes.byteLength === 0 && entry.name.endsWith("/")) continue;
    let rel: string;
    try {
      rel = normalizePath(entry.name.replace(/\/+$/, ""));
    } catch {
      continue;
    }
    if (rel === "") continue;
    const path = joinPath(basePath, rel);
    const result = await commitRevision(handle, c.env, {
      repoId: row.repoId,
      path,
      bytes: entry.bytes,
      mime: null,
      message: row.message,
      authorLogin: row.ownerLogin,
    });
    results.push({
      path: result.file.path,
      file_id: result.file.id,
      revision_id: result.revision.id,
      size: result.revision.size,
      sha256: result.revision.sha256,
    });
  }
  await markConsumed(handle, token);
  return c.json({ files: results, count: results.length }, 201);
});

// GET /download/:token — stream a single revision's bytes.
uploads.get("/download/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "bad_request", reason: "token" }, 400);

  const handle = db(c.env);
  const loaded = await loadToken(handle, token);
  if (!loaded.ok) {
    const status = loaded.reason === "not_found" ? 404 : 410;
    return c.json({ error: "gone", reason: loaded.reason }, status);
  }
  const row = loaded.row;
  if (row.kind !== "download") {
    return c.json({ error: "bad_request", reason: "wrong_kind" }, 400);
  }

  let path: string;
  try {
    path = normalizePath(row.path);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }
  const file = await loadFileByPath(handle, row.repoId, path);
  if (!file) return c.json({ error: "not_found", reason: "file" }, 404);
  const revNumber = row.revision ?? file.currentRevisionNumber;

  const revRows = (await handle
    .select()
    .from(revisionsTable)
    .where(and(eq(revisionsTable.fileId, file.id), eq(revisionsTable.revNumber, revNumber)))
    .limit(1)
    .all()) as RevisionRow[];
  const rev = revRows[0];
  if (!rev) return c.json({ error: "not_found", reason: "revision" }, 404);

  const obj = await c.env.BLOBS.get(rev.blobKey);
  if (!obj) return c.json({ error: "not_found", reason: "blob" }, 404);

  const filename = file.name;
  const headers = new Headers();
  headers.set("Content-Type", rev.mime ?? "application/octet-stream");
  headers.set("Content-Length", String(rev.size));
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  headers.set("Cache-Control", "private, max-age=60");
  headers.set("X-Sha256", rev.sha256);
  return new Response(obj.body, { status: 200, headers });
});
