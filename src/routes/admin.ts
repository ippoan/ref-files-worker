/**
 * `/ui/*` — human-facing surface behind Cloudflare Access.
 *
 * This is the "see which file is wired to which repo" view a person opens in
 * a browser. Authentication is **not** the MCP JWT — it's Cloudflare Access
 * SSO, re-verified by `middleware/cf-access.ts`. Because Access policy decides
 * who gets in, the listing spans **every owner** (a global inventory), unlike
 * `/v1/inventory` which is scoped to the JWT's own `owner_login`.
 *
 * Mounted with the `cfAccess` middleware in `src/index.ts`.
 */
import { Hono } from "hono";

import type { AppEnv } from "../env";
import { db } from "../db";
import { listInventory } from "./inventory";

export const admin = new Hono<AppEnv>();

// GET /ui/inventory — global cross-repo, cross-owner file listing (admin view).
//   ?owner=<login>        filter to one owner
//   ?repo=<name>          filter to one repo by name
//   ?include_deleted=true include soft-deleted files
admin.get("/inventory", async (c) => {
  const owner = c.req.query("owner") || undefined;
  const repo = c.req.query("repo") || undefined;
  const includeDeleted = c.req.query("include_deleted") === "true";

  const handle = db(c.env);
  const entries = await listInventory(handle, { owner, repo, includeDeleted });
  return c.json(
    {
      viewer: c.get("accessUser").email,
      count: entries.length,
      files: entries,
    },
    200,
  );
});
