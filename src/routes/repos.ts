/**
 * `/v1/repos` — repo_init.
 *
 * Idempotent: re-init of an existing (owner_login, name) returns the existing row.
 * `owner_login` always comes from the verified JWT — never from the request body.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import type { AppEnv } from "../env";
import { db } from "../db";
import { repos as reposTable } from "../db/schema";
import { validRepoName } from "../lib/path";
import type { RepoInitArgs } from "../types/RepoInitArgs";
import type { Repo } from "../types/Repo";

export const repos = new Hono<AppEnv>();

// POST /v1/repos — repo_init
repos.post("/", async (c) => {
  let body: RepoInitArgs;
  try {
    body = await c.req.json<RepoInitArgs>();
  } catch {
    return c.json({ error: "bad_request", reason: "json" }, 400);
  }
  if (!body || typeof body.name !== "string" || !validRepoName(body.name)) {
    return c.json({ error: "bad_request", reason: "name" }, 400);
  }
  const owner = c.get("auth").github_login;
  const handle = db(c.env);

  const existing = await handle
    .select()
    .from(reposTable)
    .where(and(eq(reposTable.ownerLogin, owner), eq(reposTable.name, body.name)))
    .limit(1)
    .all();
  if (existing.length > 0) {
    return c.json(rowToRepo(existing[0]), 200);
  }

  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    ownerLogin: owner,
    name: body.name,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await handle.insert(reposTable).values(row).run();
  } catch (err) {
    const after = await handle
      .select()
      .from(reposTable)
      .where(and(eq(reposTable.ownerLogin, owner), eq(reposTable.name, body.name)))
      .limit(1)
      .all();
    if (after.length > 0) return c.json(rowToRepo(after[0]), 200);
    throw err;
  }
  return c.json(rowToRepo(row), 201);
});

function rowToRepo(r: {
  id: string;
  ownerLogin: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}): Repo {
  return {
    id: r.id,
    owner_login: r.ownerLogin,
    name: r.name,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}
