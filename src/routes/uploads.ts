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
import { Hono, type Context } from "hono";
import { and, eq, isNull, like } from "drizzle-orm";

import type { AppEnv } from "../env";
import { db, type DB } from "../db";
import {
  files as filesTable,
  revisions as revisionsTable,
} from "../db/schema";
import { sha256Hex } from "../lib/hash";
import { escapeLike, normalizePath, PathError, splitParent } from "../lib/path";
import { ensureFolderPath, ensureRepoOwned } from "../lib/repo-ops";
import { buildTar, parseTarGz, type TarEntry, type TarWriteEntry } from "../lib/tar";
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
export async function commitRevision(
  handle: DB,
  env: AppEnv["Bindings"],
  args: {
    repoId: string;
    path: string;
    bytes: Uint8Array;
    mime: string | null;
    message: string | null;
    authorLogin: string;
    /**
     * When true, skip writing a new revision if the file already exists with
     * an identical sha256 as its current revision. Used by the durable
     * bulk-upload Workflow so a step that retries (after a partial failure)
     * does not append duplicate revisions for files it already committed.
     */
    skipIfSameSha?: boolean;
  },
): Promise<{ file: FileRow; revision: RevisionRow; created: boolean; skipped: boolean }> {
  const { repoId, path, bytes, mime, message, authorLogin } = args;
  const { parent: parentPath, name } = splitParent(path);
  const folder = await ensureFolderPath(handle, repoId, parentPath);
  const now = new Date().toISOString();
  const sha = await sha256Hex(bytes);
  const size = bytes.byteLength;

  const existing = await loadFileByPath(handle, repoId, path);
  if (existing) {
    if (args.skipIfSameSha) {
      const curRows = (await handle
        .select()
        .from(revisionsTable)
        .where(
          and(
            eq(revisionsTable.fileId, existing.id),
            eq(revisionsTable.revNumber, existing.currentRevisionNumber),
          ),
        )
        .limit(1)
        .all()) as RevisionRow[];
      const cur = curRows[0];
      if (cur && cur.sha256 === sha) {
        return { file: existing, revision: cur, created: false, skipped: true };
      }
    }
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
      skipped: false,
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
  return { file: fileRow, revision: revRow, created: true, skipped: false };
}

export function joinPath(base: string, rel: string): string {
  const cleanRel = rel.replace(/^\/+/, "");
  if (base === "") return cleanRel;
  return `${base}/${cleanRel}`;
}

/** R2 key under which `PUT /upload/:token` stages a tar.gz for the Workflow. */
export function stagingKey(token: string): string {
  return `uploads/staging/${token}`;
}

/**
 * Commit one tar entry under `basePath`. Returns null for directory / empty
 * sentinel entries and unparseable names (mirrors the inline loop's skips).
 * Shared by the inline fallback and the durable Workflow so the path
 * normalisation + commit semantics live in one place.
 */
export async function commitTarEntry(
  handle: DB,
  env: AppEnv["Bindings"],
  args: {
    entry: TarEntry;
    basePath: string;
    repoId: string;
    message: string | null;
    ownerLogin: string;
    skipIfSameSha?: boolean;
  },
): Promise<{
  path: string;
  file_id: string;
  revision_id: string;
  size: number;
  sha256: string;
  skipped: boolean;
} | null> {
  const { entry, basePath, repoId, message, ownerLogin, skipIfSameSha } = args;
  if (entry.bytes.byteLength === 0 && entry.name.endsWith("/")) return null;
  let rel: string;
  try {
    rel = normalizePath(entry.name.replace(/\/+$/, ""));
  } catch {
    return null;
  }
  if (rel === "") return null;
  const path = joinPath(basePath, rel);
  const result = await commitRevision(handle, env, {
    repoId,
    path,
    bytes: entry.bytes,
    mime: null,
    message,
    authorLogin: ownerLogin,
    skipIfSameSha,
  });
  return {
    path: result.file.path,
    file_id: result.file.id,
    revision_id: result.revision.id,
    size: result.revision.size,
    sha256: result.revision.sha256,
    skipped: result.skipped,
  };
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

  // tar.gz bulk.
  let basePath = "";
  try {
    basePath = normalizePath(row.path);
  } catch {
    basePath = "";
  }

  // Durable path (prod): stage the raw archive in R2 and hand the per-file
  // commit loop to a Workflow instance so it runs off the request lifecycle —
  // no 60s client-timeout / partial-commit (Refs #33). The PUT returns 202
  // immediately; the caller polls `bulk_upload_status(workflow_id)`.
  if (c.env.BULK_UPLOAD_WORKFLOW) {
    const key = stagingKey(token);
    await c.env.BLOBS.put(key, bytes, {
      httpMetadata: { contentType: "application/gzip" },
    });
    const instance = await c.env.BULK_UPLOAD_WORKFLOW.create({
      params: {
        token,
        repoId: row.repoId,
        basePath,
        ownerLogin: row.ownerLogin,
        message: row.message,
        stagingKey: key,
      },
    });
    return c.json(
      {
        mode: "workflow",
        workflow_id: instance.id,
        status: "queued",
        size: bytes.byteLength,
      },
      202,
    );
  }

  // Inline fallback (test env / no Workflow binding): commit synchronously and
  // mark the token consumed, preserving the original `{ files, count }` shape.
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

  const results: Array<{ path: string; file_id: string; revision_id: string; size: number; sha256: string; skipped: boolean }> = [];
  for (const entry of entries) {
    const committed = await commitTarEntry(handle, c.env, {
      entry,
      basePath,
      repoId: row.repoId,
      message: row.message,
      ownerLogin: row.ownerLogin,
    });
    if (committed) results.push(committed);
  }
  await markConsumed(handle, token);
  return c.json({ mode: "inline", files: results, count: results.length }, 201);
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
  if (row.kind === "tar_gz_folder") {
    return streamFolderTarGz(c, handle, row);
  }
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

/**
 * kind=`tar_gz_folder`: stream every live file under `row.path` (recursive)
 * as a single tar.gz. Paths inside the archive are repo-relative (so
 * `tar xzf -` reproduces the same layout the caller would see from
 * folder_list recursive=true).
 */
async function streamFolderTarGz(
  c: Context<AppEnv>,
  handle: DB,
  row: { token: string; repoId: string; path: string; ownerLogin: string },
): Promise<Response> {
  let path: string;
  try {
    path = normalizePath(row.path);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }

  const repo = await ensureRepoOwned(handle, row.repoId, row.ownerLogin);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  let fileRows: FileRow[];
  if (path === "") {
    fileRows = (await handle
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.repoId, row.repoId), isNull(filesTable.deletedAt)))
      .all()) as FileRow[];
  } else {
    const likeExpr = `${escapeLike(`${path}/`)}%`;
    fileRows = (await handle
      .select()
      .from(filesTable)
      .where(
        and(
          eq(filesTable.repoId, row.repoId),
          like(filesTable.path, likeExpr),
          isNull(filesTable.deletedAt),
        ),
      )
      .all()) as FileRow[];
  }

  const entries: TarWriteEntry[] = [];
  for (const file of fileRows) {
    const obj = await c.env.BLOBS.get(
      blobKey(file.repoId, file.id, file.currentRevisionNumber),
    );
    if (!obj) continue; // blob lost — skip rather than fail the whole archive
    const ab = await obj.arrayBuffer();
    // Strip the requested folder prefix so the archive is rooted at the
    // download target (matches `tar -czf out.tgz -C parent folder/`).
    const archiveName = path === "" ? file.path : file.path.slice(path.length + 1);
    entries.push({ name: archiveName, bytes: new Uint8Array(ab) });
  }

  const tarBytes = buildTar(entries);
  const gz = new Response(tarBytes).body!.pipeThrough(new CompressionStream("gzip"));
  await markConsumed(handle, row.token);

  const filename = path === "" ? "repo.tar.gz" : `${path.split("/").pop()}.tar.gz`;
  const headers = new Headers();
  headers.set("Content-Type", "application/gzip");
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  headers.set("X-File-Count", String(entries.length));
  headers.set("Cache-Control", "private, max-age=60");
  return new Response(gz, { status: 200, headers });
}
