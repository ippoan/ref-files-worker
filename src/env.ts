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
  /**
   * Raw shared secret used by `POST /mcp/introspect` to authenticate the
   * legacy `ref-files-mcp-server-rs` binary path (mode 2). Must equal the
   * `INTERNAL_SHARED_SECRET` bound on `auth-worker` for the same env so
   * the binary can introspect against either worker with one value.
   *
   * Two binding shapes are tolerated so the same code path works through
   * a migration to Cloudflare Secrets Store:
   *   - `string`     — legacy `wrangler secret put` (and vitest bindings).
   *   - `SecretsStoreSecret` — account-level Secrets Store binding via
   *                  `[[secrets_store_secrets]]`. Read with `await .get()`.
   * Use `resolveInternalSharedSecret(env)` (in handlers/mcp-introspect.ts)
   * to normalise both into `string | null` before comparing.
   */
  INTERNAL_SHARED_SECRET?: string | SecretsStoreSecret;
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
