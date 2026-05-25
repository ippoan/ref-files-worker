/**
 * `/v1/files` — file_put / file_get / file_history / file_move / file_delete / file_search.
 *
 * Blob bytes live in R2 under `files/{repo_id}/{file_id}/{rev_number}`. D1 is
 * the source of truth for metadata; R2 holds the content. Each `file_put`
 * appends a revision row, never updates one. `file_delete` is soft (flips
 * `deleted_at` on the files row); revisions are kept so `file_history` walks
 * still resolve.
 */
import { Hono } from "hono";
import { and, desc, eq, isNull, like, or } from "drizzle-orm";

import type { AppEnv } from "../env";
import { db, type DB } from "../db";
import {
  files as filesTable,
  revisions as revisionsTable,
} from "../db/schema";
import { decodeBase64, encodeBase64, sha256Hex } from "../lib/hash";
import { escapeLike, normalizePath, PathError, splitParent } from "../lib/path";
import { ensureFolderPath, ensureRepoOwned } from "../lib/repo-ops";
import type { File as FileDto } from "../types/File";
import type { FileGetResponse } from "../types/FileGetResponse";
import type { FileMoveArgs } from "../types/FileMoveArgs";
import type { FilePutArgs } from "../types/FilePutArgs";
import type { FileSearchResult } from "../types/FileSearchResult";
import type { RevisionList } from "../types/RevisionList";
import type { Revision as RevisionDto } from "../types/Revision";

export const files = new Hono<AppEnv>();

export interface FileRow {
  id: string;
  repoId: string;
  folderId: string | null;
  name: string;
  path: string;
  currentRevisionId: string;
  currentRevisionNumber: number;
  size: number;
  mime: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface RevisionRow {
  id: string;
  fileId: string;
  revNumber: number;
  blobKey: string;
  size: number;
  sha256: string;
  mime: string | null;
  authorLogin: string;
  message: string | null;
  createdAt: string;
}

/**
 * ts-rs maps Rust `u64` to `bigint` in TS, but the wire-format is JSON which
 * has no native bigint. D1 returns sizes as JS numbers (good for ≤ 2^53);
 * we cast to satisfy the type contract here without ever materialising a
 * `BigInt` value (`JSON.stringify(BigInt)` throws).
 */
export function fileRowToDto(r: FileRow): FileDto {
  return {
    id: r.id,
    repo_id: r.repoId,
    folder_id: r.folderId,
    name: r.name,
    path: r.path,
    current_revision_id: r.currentRevisionId,
    current_revision_number: r.currentRevisionNumber,
    size: r.size as unknown as bigint,
    mime: r.mime,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    deleted_at: r.deletedAt,
  };
}

function revRowToDto(r: RevisionRow): RevisionDto {
  return {
    id: r.id,
    file_id: r.fileId,
    rev_number: r.revNumber,
    blob_key: r.blobKey,
    size: r.size as unknown as bigint,
    sha256: r.sha256,
    mime: r.mime,
    author_login: r.authorLogin,
    message: r.message,
    created_at: r.createdAt,
  };
}

async function loadFileByPath(
  handle: DB,
  repoId: string,
  path: string,
  includeDeleted: boolean,
): Promise<FileRow | null> {
  const where = includeDeleted
    ? and(eq(filesTable.repoId, repoId), eq(filesTable.path, path))
    : and(
        eq(filesTable.repoId, repoId),
        eq(filesTable.path, path),
        isNull(filesTable.deletedAt),
      );
  const rows = (await handle.select().from(filesTable).where(where).limit(1).all()) as FileRow[];
  return rows[0] ?? null;
}

function blobKey(repoId: string, fileId: string, revNumber: number): string {
  return `files/${repoId}/${fileId}/${revNumber}`;
}

// POST /v1/files — file_put
files.post("/", async (c) => {
  let body: FilePutArgs;
  try {
    body = await c.req.json<FilePutArgs>();
  } catch {
    return c.json({ error: "bad_request", reason: "json" }, 400);
  }
  if (
    !body ||
    typeof body.repo_id !== "string" ||
    typeof body.path !== "string" ||
    typeof body.content_base64 !== "string"
  ) {
    return c.json({ error: "bad_request", reason: "shape" }, 400);
  }
  let path: string;
  try {
    path = normalizePath(body.path);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }
  if (path === "") return c.json({ error: "bad_request", reason: "root_file" }, 400);

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(body.content_base64);
  } catch {
    return c.json({ error: "bad_request", reason: "base64" }, 400);
  }

  const auth = c.get("auth");
  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, body.repo_id, auth.github_login);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  const { parent: parentPath } = splitParent(path);
  const folder = await ensureFolderPath(handle, body.repo_id, parentPath);

  const now = new Date().toISOString();
  const sha = await sha256Hex(bytes);
  const size = bytes.byteLength;
  const mime = body.mime ?? null;
  const message = body.message ?? null;

  const existing = await loadFileByPath(handle, body.repo_id, path, true);
  let fileRow: FileRow;
  let revNumber: number;
  let fileId: string;

  if (existing) {
    fileId = existing.id;
    revNumber = existing.currentRevisionNumber + 1;
    const revId = crypto.randomUUID();
    const key = blobKey(body.repo_id, fileId, revNumber);
    await c.env.BLOBS.put(key, bytes, {
      httpMetadata: mime ? { contentType: mime } : undefined,
    });
    const revRow: RevisionRow = {
      id: revId,
      fileId,
      revNumber,
      blobKey: key,
      size,
      sha256: sha,
      mime,
      authorLogin: auth.github_login,
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
      .where(eq(filesTable.id, fileId))
      .run();
    fileRow = {
      ...existing,
      currentRevisionId: revId,
      currentRevisionNumber: revNumber,
      size,
      mime,
      updatedAt: now,
      deletedAt: null,
      folderId: folder ? folder.id : null,
    };
    return c.json(
      { file: fileRowToDto(fileRow), revision: revRowToDto(revRow) },
      200,
    );
  }

  fileId = crypto.randomUUID();
  revNumber = 1;
  const revId = crypto.randomUUID();
  const key = blobKey(body.repo_id, fileId, revNumber);
  await c.env.BLOBS.put(key, bytes, {
    httpMetadata: mime ? { contentType: mime } : undefined,
  });
  const { name } = splitParent(path);
  fileRow = {
    id: fileId,
    repoId: body.repo_id,
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
    authorLogin: auth.github_login,
    message,
    createdAt: now,
  };
  try {
    await handle.insert(filesTable).values(fileRow).run();
  } catch (err) {
    // race: someone created the same path between our select and insert.
    await c.env.BLOBS.delete(key);
    return c.json({ error: "conflict", reason: "path_taken" }, 409);
  }
  await handle.insert(revisionsTable).values(revRow).run();
  return c.json({ file: fileRowToDto(fileRow), revision: revRowToDto(revRow) }, 201);
});

// GET /v1/files — file_get (query: repo_id, path, revision?)
files.get("/", async (c) => {
  const repoId = c.req.query("repo_id");
  const rawPath = c.req.query("path");
  const revStr = c.req.query("revision");
  if (!repoId || !rawPath) return c.json({ error: "bad_request", reason: "args" }, 400);
  let path: string;
  try {
    path = normalizePath(rawPath);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }
  if (path === "") return c.json({ error: "bad_request", reason: "path" }, 400);

  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, repoId, c.get("auth").github_login);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  const file = await loadFileByPath(handle, repoId, path, true);
  if (!file) return c.json({ error: "not_found", reason: "file" }, 404);

  let revNumber: number;
  if (revStr === undefined) {
    if (file.deletedAt) return c.json({ error: "not_found", reason: "deleted" }, 404);
    revNumber = file.currentRevisionNumber;
  } else {
    const n = Number.parseInt(revStr, 10);
    if (!Number.isFinite(n) || n < 1) {
      return c.json({ error: "bad_request", reason: "revision" }, 400);
    }
    revNumber = n;
  }

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
  const buf = await obj.arrayBuffer();

  const resp: FileGetResponse = {
    file: fileRowToDto(file),
    revision: revRowToDto(rev),
    content_base64: encodeBase64(new Uint8Array(buf)),
  };
  return c.json(resp, 200);
});

// DELETE /v1/files — file_delete (soft) (query: repo_id, path)
files.delete("/", async (c) => {
  const repoId = c.req.query("repo_id");
  const rawPath = c.req.query("path");
  if (!repoId || !rawPath) return c.json({ error: "bad_request", reason: "args" }, 400);
  let path: string;
  try {
    path = normalizePath(rawPath);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }
  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, repoId, c.get("auth").github_login);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  const file = await loadFileByPath(handle, repoId, path, false);
  if (!file) return c.json({ error: "not_found", reason: "file" }, 404);
  const now = new Date().toISOString();
  await handle
    .update(filesTable)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(filesTable.id, file.id))
    .run();
  return c.json(fileRowToDto({ ...file, deletedAt: now, updatedAt: now }), 200);
});

// GET /v1/files/history — file_history (query: repo_id, path, limit?)
files.get("/history", async (c) => {
  const repoId = c.req.query("repo_id");
  const rawPath = c.req.query("path");
  const limitStr = c.req.query("limit");
  if (!repoId || !rawPath) return c.json({ error: "bad_request", reason: "args" }, 400);
  let path: string;
  try {
    path = normalizePath(rawPath);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }
  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, repoId, c.get("auth").github_login);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  const file = await loadFileByPath(handle, repoId, path, true);
  if (!file) return c.json({ error: "not_found", reason: "file" }, 404);

  let limit = 20;
  if (limitStr !== undefined) {
    const n = Number.parseInt(limitStr, 10);
    if (Number.isFinite(n) && n >= 1) limit = Math.min(n, 100);
  }
  const revRows = (await handle
    .select()
    .from(revisionsTable)
    .where(eq(revisionsTable.fileId, file.id))
    .orderBy(desc(revisionsTable.revNumber))
    .limit(limit)
    .all()) as RevisionRow[];

  const body: RevisionList = { revisions: revRows.map(revRowToDto) };
  return c.json(body, 200);
});

// POST /v1/files/move — file_move
files.post("/move", async (c) => {
  let body: FileMoveArgs;
  try {
    body = await c.req.json<FileMoveArgs>();
  } catch {
    return c.json({ error: "bad_request", reason: "json" }, 400);
  }
  if (
    !body ||
    typeof body.repo_id !== "string" ||
    typeof body.from_path !== "string" ||
    typeof body.to_path !== "string"
  ) {
    return c.json({ error: "bad_request", reason: "shape" }, 400);
  }
  let fromPath: string;
  let toPath: string;
  try {
    fromPath = normalizePath(body.from_path);
    toPath = normalizePath(body.to_path);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }
  if (fromPath === "" || toPath === "") {
    return c.json({ error: "bad_request", reason: "path" }, 400);
  }
  if (fromPath === toPath) return c.json({ error: "bad_request", reason: "same_path" }, 400);

  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, body.repo_id, c.get("auth").github_login);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  const file = await loadFileByPath(handle, body.repo_id, fromPath, false);
  if (!file) return c.json({ error: "not_found", reason: "file" }, 404);

  const collision = await loadFileByPath(handle, body.repo_id, toPath, true);
  if (collision) return c.json({ error: "conflict", reason: "to_path_taken" }, 409);

  const { parent: toParentPath, name: toName } = splitParent(toPath);
  const toFolder = await ensureFolderPath(handle, body.repo_id, toParentPath);
  const now = new Date().toISOString();
  await handle
    .update(filesTable)
    .set({
      path: toPath,
      name: toName,
      folderId: toFolder ? toFolder.id : null,
      updatedAt: now,
    })
    .where(eq(filesTable.id, file.id))
    .run();

  return c.json(
    fileRowToDto({
      ...file,
      path: toPath,
      name: toName,
      folderId: toFolder ? toFolder.id : null,
      updatedAt: now,
    }),
    200,
  );
});

// GET /v1/files/search — file_search
files.get("/search", async (c) => {
  const repoId = c.req.query("repo_id");
  const query = c.req.query("query");
  const underPathRaw = c.req.query("under_path");
  const includeDeleted = c.req.query("include_deleted") === "true";
  const limitStr = c.req.query("limit");
  if (!repoId || !query) return c.json({ error: "bad_request", reason: "args" }, 400);

  let limit = 20;
  if (limitStr !== undefined) {
    const n = Number.parseInt(limitStr, 10);
    if (Number.isFinite(n) && n >= 1) limit = Math.min(n, 100);
  }

  let underPath: string | null = null;
  if (underPathRaw !== undefined && underPathRaw !== "") {
    try {
      underPath = normalizePath(underPathRaw);
    } catch (err) {
      return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
    }
  }

  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, repoId, c.get("auth").github_login);
  if ("error" in repo) return c.json(repo, repo.error === "forbidden" ? 403 : 404);

  const likeNeedle = `%${escapeLike(query)}%`;
  const conditions = [
    eq(filesTable.repoId, repoId),
    or(like(filesTable.path, likeNeedle), like(filesTable.name, likeNeedle)),
  ];
  if (underPath) {
    conditions.push(like(filesTable.path, `${escapeLike(`${underPath}/`)}%`));
  }
  if (!includeDeleted) {
    conditions.push(isNull(filesTable.deletedAt));
  }
  const rows = (await handle
    .select()
    .from(filesTable)
    .where(and(...conditions))
    .limit(limit)
    .all()) as FileRow[];

  const body: FileSearchResult = { files: rows.map(fileRowToDto) };
  return c.json(body, 200);
});
