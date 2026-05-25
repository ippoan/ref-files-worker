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

/**
 * Look up a repo owned by `ownerLogin` whose `name` equals `candidate`.
 * Returns null when no match (or when `candidate` clearly isn't a name).
 *
 * Used to power the `hint` field of `ensureRepoOwned`'s not_found response —
 * a common smoke-test footgun is to pass `repo_id: "claude-skills"` (the
 * name) instead of the UUID. We probe the (owner, name) index and surface
 * the resolved UUID so the caller can fix the call shape.
 */
export async function lookupRepoByName(
  handle: DB,
  ownerLogin: string,
  candidate: string,
): Promise<RepoRow | null> {
  if (!candidate) return null;
  const rows = await handle
    .select()
    .from(reposTable)
    .where(and(eq(reposTable.ownerLogin, ownerLogin), eq(reposTable.name, candidate)))
    .limit(1)
    .all();
  return (rows[0] as RepoRow | undefined) ?? null;
}

export interface RepoNotFound {
  error: "not_found";
  reason: "repo";
  /**
   * Set when `repoId` failed UUID lookup but matched a repo `name` owned
   * by the same user — almost always the smoke-test footgun "I passed the
   * name instead of the id".
   */
  hint?: { resolved_id: string; name: string };
}

export interface RepoForbidden {
  error: "forbidden";
}

export async function ensureRepoOwned(
  handle: DB,
  repoId: string,
  ownerLogin: string,
): Promise<RepoRow | RepoNotFound | RepoForbidden> {
  const repo = await loadRepo(handle, repoId);
  if (!repo) {
    const named = await lookupRepoByName(handle, ownerLogin, repoId);
    if (named) {
      return {
        error: "not_found",
        reason: "repo",
        hint: { resolved_id: named.id, name: named.name },
      };
    }
    return { error: "not_found", reason: "repo" };
  }
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
