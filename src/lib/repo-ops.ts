/**
 * Shared D1 helpers used by folder/file routes.
 *
 * `ensureRepoOwned` — gates every write on the JWT `github_login` matching the
 * repo's `owner_login`. Centralising it keeps each route handler one-liner.
 *
 * `ensureFolderPath` — idempotent mkdir-p; returns the deepest folder row.
 * Returns `null` when path === "" (root, which has no folder row).
 */
import { and, eq, isNull } from "drizzle-orm";

import type { DB } from "../db";
import { folders as foldersTable, repos as reposTable } from "../db/schema";
import { ancestorFolders, splitParent } from "./path";

export interface RepoRow {
  id: string;
  ownerLogin: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FolderRow {
  id: string;
  repoId: string;
  parentId: string | null;
  name: string;
  path: string;
  createdAt: string;
}

export async function loadRepo(handle: DB, repoId: string): Promise<RepoRow | null> {
  const rows = await handle.select().from(reposTable).where(eq(reposTable.id, repoId)).limit(1).all();
  return rows[0] ?? null;
}

export async function ensureRepoOwned(
  handle: DB,
  repoId: string,
  ownerLogin: string,
): Promise<RepoRow | { error: "not_found" } | { error: "forbidden" }> {
  const repo = await loadRepo(handle, repoId);
  if (!repo) return { error: "not_found" };
  if (repo.ownerLogin !== ownerLogin) return { error: "forbidden" };
  return repo;
}

export async function loadFolderByPath(
  handle: DB,
  repoId: string,
  path: string,
): Promise<FolderRow | null> {
  if (path === "") return null;
  const rows = await handle
    .select()
    .from(foldersTable)
    .where(and(eq(foldersTable.repoId, repoId), eq(foldersTable.path, path)))
    .limit(1)
    .all();
  return (rows[0] as FolderRow | undefined) ?? null;
}

/**
 * mkdir -p. Walks ancestors root-first, inserting any that don't exist.
 * Returns the deepest folder row (or null if path === "").
 */
export async function ensureFolderPath(
  handle: DB,
  repoId: string,
  path: string,
): Promise<FolderRow | null> {
  if (path === "") return null;
  const chain = ancestorFolders(path);
  let parent: FolderRow | null = null;
  for (const p of chain) {
    const existing = await loadFolderByPath(handle, repoId, p);
    if (existing) {
      parent = existing;
      continue;
    }
    const { name } = splitParent(p);
    const row: FolderRow = {
      id: crypto.randomUUID(),
      repoId,
      parentId: parent ? parent.id : null,
      name,
      path: p,
      createdAt: new Date().toISOString(),
    };
    try {
      await handle.insert(foldersTable).values(row).run();
      parent = row;
    } catch {
      // race: another tx inserted same path — re-read.
      const after = await loadFolderByPath(handle, repoId, p);
      if (!after) throw new Error("folder_race");
      parent = after;
    }
  }
  return parent;
}

export async function listFoldersUnder(
  handle: DB,
  repoId: string,
  parentId: string | null,
): Promise<FolderRow[]> {
  const rows = await handle
    .select()
    .from(foldersTable)
    .where(
      and(
        eq(foldersTable.repoId, repoId),
        parentId === null ? isNull(foldersTable.parentId) : eq(foldersTable.parentId, parentId),
      ),
    )
    .all();
  return rows as FolderRow[];
}

export function folderRowToDto(r: FolderRow) {
  return {
    id: r.id,
    repo_id: r.repoId,
    parent_id: r.parentId,
    name: r.name,
    path: r.path,
    created_at: r.createdAt,
  };
}
