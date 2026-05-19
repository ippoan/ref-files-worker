/**
 * Shared `Env` / Hono variables shape — imported by every route module so
 * each one declares the same `Hono<{ Bindings: Env; Variables: Variables }>`
 * type and stays compatible with the root app's `app.route(...)` mount.
 */

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  AUTH_WORKER_ORIGIN: string;
  MCP_JWT_AUDIENCE: string;
  /** HS256 secret shared with auth-worker. Optional in Phase 0 (auth is stubbed). */
  MCP_JWT_SECRET?: string;
  WORKER_ENV: string;
}

/** Auth claims attached by the `/v1/*` middleware in `src/index.ts`. */
export interface AuthContext {
  sub: string;
  github_login: string;
  scope: string;
}

export interface Variables {
  auth: AuthContext;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
