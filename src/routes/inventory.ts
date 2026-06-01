/**
 * `/v1/inventory` — cross-repo file listing.
 *
 * Every other `/v1/*` route is scoped to a single `repo_id`; this one answers
 * "which file lives in which repo" by joining `files` × `repos` and returning
 * one flat list across all of the caller's repos. Ownership is enforced the
 * same way as the rest of the surface: `repos.owner_login === JWT github_login`.
 *
 * The same `listInventory()` helper backs the human-facing `/ui/inventory`
 * admin view (see `src/routes/admin.ts`), which passes `owner: undefined` to
 * span every owner — that path is gated by Cloudflare Access instead of the
 * MCP JWT.
 *
 * NOTE: the response shape is inline (not from `src/types/`) because there is
 * no matching ts-rs DTO in `ref-files-mcp-server-rs` yet; keeping it out of
 * `src/types/` avoids tripping the `sync-types.yml` drift gate. If/when an MCP
 * tool maps to this endpoint, mirror the Rust DTO here.
 */
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";

import type { AppEnv } from "../env";
import { db } from "../db";
import { files as filesTable, repos as reposTable } from "../db/schema";

export interface InventoryEntry {
  repo_id: string;
  repo_name: string;
  owner_login: string;
  file_id: string;
  path: string;
  size: number;
  mime: string | null;
  revision: number;
  updated_at: string;
  deleted_at: string | null;
}

type Handle = ReturnType<typeof db>;

/**
 * Join files → repos and return a flat cross-repo listing.
 *
 * @param owner          when set, restrict to this `repos.owner_login`; when
 *                       `undefined`, span every owner (admin/global view).
 * @param repo           optional `repos.name` exact-match filter.
 * @param includeDeleted include soft-deleted files (`deleted_at` set).
 */
export async function listInventory(
  handle: Handle,
  opts: { owner?: string; repo?: string; includeDeleted?: boolean },
): Promise<InventoryEntry[]> {
  const conds = [];
  if (opts.owner !== undefined) conds.push(eq(reposTable.ownerLogin, opts.owner));
  if (opts.repo) conds.push(eq(reposTable.name, opts.repo));
  if (!opts.includeDeleted) conds.push(isNull(filesTable.deletedAt));

  const rows = await handle
    .select({
      repoId: reposTable.id,
      repoName: reposTable.name,
      ownerLogin: reposTable.ownerLogin,
      fileId: filesTable.id,
      path: filesTable.path,
      size: filesTable.size,
      mime: filesTable.mime,
      revision: filesTable.currentRevisionNumber,
      updatedAt: filesTable.updatedAt,
      deletedAt: filesTable.deletedAt,
    })
    .from(filesTable)
    .innerJoin(reposTable, eq(filesTable.repoId, reposTable.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .all();

  return rows.map((r) => ({
    repo_id: r.repoId,
    repo_name: r.repoName,
    owner_login: r.ownerLogin,
    file_id: r.fileId,
    path: r.path,
    size: r.size,
    mime: r.mime ?? null,
    revision: r.revision,
    updated_at: r.updatedAt,
    deleted_at: r.deletedAt ?? null,
  }));
}

export const inventory = new Hono<AppEnv>();

// GET /v1/inventory — the authenticated user's files across every repo they own.
//   ?repo=<name>          filter to a single repo by name
//   ?include_deleted=true include soft-deleted files
inventory.get("/", async (c) => {
  const owner = c.get("auth").github_login;
  const repo = c.req.query("repo") ?? undefined;
  const includeDeleted = c.req.query("include_deleted") === "true";
  const repoFilter = repo && repo.length > 0 ? repo : undefined;

  const handle = db(c.env);
  const entries = await listInventory(handle, { owner, repo: repoFilter, includeDeleted });
  return c.json({ files: entries }, 200);
});
