/**
 * Shared `Env` / Hono variables shape — imported by every route module so
 * each one declares the same `Hono<{ Bindings: Env; Variables: Variables }>`
 * type and stays compatible with the root app's `app.route(...)` mount.
 */

import type { BulkUploadParams } from "./workflows/types";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  AUTH_WORKER_ORIGIN: string;
  MCP_JWT_AUDIENCE: string;
  /**
   * Public origin advertised in pre-signed `upload_url` / `download_url`
   * responses. Required because the durable `/mcp` transport re-dispatches
   * `*-init` calls through the DO with an internal request URL
   * (`https://ref-files.internal/...`), so `new URL(c.req.url).origin` no
   * longer reflects the reachable public host. Set to the worker's custom
   * domain (`https://ref-files.ippoan.org`). Optional so test / direct REST
   * runs can fall back to the inbound request origin.
   */
  PUBLIC_ORIGIN?: string;
  /**
   * Durable bulk-upload Workflow binding. `PUT /upload/:token` (kind=tar_gz)
   * stages the archive in R2 and triggers an instance so the per-file commit
   * loop runs off the request lifecycle — no 60s client-timeout / partial
   * commit. Optional: in `WORKER_ENV === "test"` (miniflare has no Workflow
   * binding) the handler falls back to an inline synchronous commit.
   */
  BULK_UPLOAD_WORKFLOW?: Workflow<BulkUploadParams>;
  /**
   * HS256 secret shared with auth-worker.
   *
   * Two binding shapes are tolerated:
   *   - `string`            — `wrangler secret put` / vitest 用 plain binding。
   *   - `SecretsStoreSecret` — account-level Secrets Store binding (prod).
   *                          `secret_name = "INTERNAL_SHARED_SECRET"` を
   *                          auth-worker と共有する設計 (Refs #6)。
   * Optional のままにしておくのは `WORKER_ENV === "test"` モードで未 bind
   * を許す経路 (`src/middleware/auth.ts` test branch) があるため。
   * 値の取り出しは `resolveMcpJwtSecret(env)` (handlers/mcp-introspect.ts)
   * で `string | null` に正規化する。
   */
  MCP_JWT_SECRET?: string | SecretsStoreSecret;
  /**
   * Raw shared secret used by `POST /mcp/introspect` to authenticate the
   * legacy `ref-files-mcp-server-rs` binary path (mode 2). Must equal the
   * `INTERNAL_SHARED_SECRET` bound on `auth-worker` for the same env so
   * the binary can introspect against either worker with one value.
   *
   * Same dual binding shape as `MCP_JWT_SECRET`. Use
   * `resolveInternalSharedSecret(env)` to normalise.
   */
  INTERNAL_SHARED_SECRET?: string | SecretsStoreSecret;
  WORKER_ENV: string;
  /**
   * Cloudflare Access team domain for the human-facing `/ui/*` surface —
   * e.g. `ippoan.cloudflareaccess.com`. The JWKS used to verify the
   * `Cf-Access-Jwt-Assertion` header is fetched from
   * `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`.
   * Optional: omitted only in `WORKER_ENV === "test"` (see
   * `src/middleware/cf-access.ts` test branch).
   */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** AUD tag of the Access Application protecting `/ui/*`. */
  CF_ACCESS_AUD?: string;
}

/** Auth claims attached by the `/v1/*` middleware in `src/index.ts`. */
export interface AuthContext {
  sub: string;
  github_login: string;
  scope: string;
}

/** Cloudflare Access identity attached by the `/ui/*` middleware. */
export interface AccessUser {
  email: string;
  sub: string;
}

export interface Variables {
  auth: AuthContext;
  accessUser: AccessUser;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
