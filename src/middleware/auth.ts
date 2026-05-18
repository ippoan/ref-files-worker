/**
 * `/v1/*` JWT auth middleware.
 *
 * Phase 0: requires `Authorization: Bearer <token>` but does **not** verify
 * the JWT signature — `MCP_JWT_SECRET` is optional in `wrangler.toml` so
 * smoke tests can hit the route surface without provisioning a secret.
 *
 * Phase 1 swaps this for HS256 verification matching
 * `auth-worker/src/lib/mcp-jwt.ts` (audience = `MCP_JWT_AUDIENCE`, alg pinned
 * to HS256, constant-time signature compare).
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized", reason: "missing_bearer" }, 401);
  }
  // TODO(phase-1): verifyMcpJwt(header.slice(7), c.env.MCP_JWT_SECRET, c.env.MCP_JWT_AUDIENCE)
  c.set("auth", {
    sub: "phase0-stub",
    github_login: "phase0-stub",
    scope: "mcp.write",
  });
  await next();
};
