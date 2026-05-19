/**
 * `/v1/folders` — folder_create + folder_list.
 *
 * `folder_create` is mkdir -p. `folder_list` returns folders + (live) files at
 * (or under, when recursive=true) the requested path.
 */
import { Hono } from "hono";
import { and, eq, isNull, like } from "drizzle-orm";

import type { AppEnv } from "../env";
import { db } from "../db";
import { files as filesTable, folders as foldersTable } from "../db/schema";
import { escapeLike, normalizePath, PathError } from "../lib/path";
import {
  ensureFolderPath,
  ensureRepoOwned,
  folderRowToDto,
  loadFolderByPath,
} from "../lib/repo-ops";
import type { FolderCreateArgs } from "../types/FolderCreateArgs";
import type { FolderListing } from "../types/FolderListing";
import { fileRowToDto, type FileRow } from "./files";

export const folders = new Hono<AppEnv>();

// POST /v1/folders — folder_create
folders.post("/", async (c) => {
  let body: FolderCreateArgs;
  try {
    body = await c.req.json<FolderCreateArgs>();
  } catch {
    return c.json({ error: "bad_request", reason: "json" }, 400);
  }
  if (!body || typeof body.repo_id !== "string" || typeof body.path !== "string") {
    return c.json({ error: "bad_request", reason: "shape" }, 400);
  }
  let path: string;
  try {
    path = normalizePath(body.path);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }
  if (path === "") {
    return c.json({ error: "bad_request", reason: "root_implicit" }, 400);
  }

  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, body.repo_id, c.get("auth").github_login);
  if ("error" in repo) return c.json({ error: repo.error }, repo.error === "forbidden" ? 403 : 404);

  const row = await ensureFolderPath(handle, body.repo_id, path);
  if (!row) return c.json({ error: "internal" }, 500);
  return c.json(folderRowToDto(row), 201);
});

// GET /v1/folders — folder_list (query: repo_id, path?, recursive?)
folders.get("/", async (c) => {
  const repoId = c.req.query("repo_id");
  const rawPath = c.req.query("path") ?? "";
  const recursive = c.req.query("recursive") === "true";
  if (!repoId) return c.json({ error: "bad_request", reason: "repo_id" }, 400);

  let path: string;
  try {
    path = normalizePath(rawPath);
  } catch (err) {
    return c.json({ error: "bad_request", reason: (err as PathError).reason ?? "path" }, 400);
  }

  const handle = db(c.env);
  const repo = await ensureRepoOwned(handle, repoId, c.get("auth").github_login);
  if ("error" in repo) return c.json({ error: repo.error }, repo.error === "forbidden" ? 403 : 404);

  const baseFolder = path === "" ? null : await loadFolderByPath(handle, repoId, path);
  if (path !== "" && !baseFolder) {
    return c.json({ error: "not_found", reason: "folder" }, 404);
  }

  let folderRows;
  let fileRows: FileRow[];
  if (recursive) {
    const prefix = path === "" ? "" : `${path}/`;
    const likeExpr = `${escapeLike(prefix)}%`;
    folderRows = path === ""
      ? await handle.select().from(foldersTable).where(eq(foldersTable.repoId, repoId)).all()
      : await handle
          .select()
          .from(foldersTable)
          .where(and(eq(foldersTable.repoId, repoId), like(foldersTable.path, likeExpr)))
          .all();
    fileRows = (path === ""
      ? await handle.select().from(filesTable).where(and(eq(filesTable.repoId, repoId), isNull(filesTable.deletedAt))).all()
      : await handle
          .select()
          .from(filesTable)
          .where(
            and(
              eq(filesTable.repoId, repoId),
              like(filesTable.path, likeExpr),
              isNull(filesTable.deletedAt),
            ),
          )
          .all()) as FileRow[];
  } else {
    const parentId = baseFolder ? baseFolder.id : null;
    folderRows = await handle
      .select()
      .from(foldersTable)
      .where(
        and(
          eq(foldersTable.repoId, repoId),
          parentId === null ? isNull(foldersTable.parentId) : eq(foldersTable.parentId, parentId),
        ),
      )
      .all();
    fileRows = (await handle
      .select()
      .from(filesTable)
      .where(
        and(
          eq(filesTable.repoId, repoId),
          parentId === null ? isNull(filesTable.folderId) : eq(filesTable.folderId, parentId),
          isNull(filesTable.deletedAt),
        ),
      )
      .all()) as FileRow[];
  }

  const body: FolderListing = {
    folders: folderRows.map((r) => folderRowToDto(r as any)),
    files: fileRows.map(fileRowToDto),
  };
  return c.json(body, 200);
});
