/**
 * `/v1/repos` — repo_init (Phase 1).
 *
 * Mounted by `src/index.ts` at `/v1/repos`. Phase 0 returns 501; the handler
 * shape is left so Phase 1 can swap in the Drizzle insert without touching
 * the router.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const repos = new Hono<AppEnv>();

// POST /v1/repos — repo_init
repos.post("/", (c) => c.json({ error: "not_implemented", tool: "repo_init", phase: "0" }, 501));
