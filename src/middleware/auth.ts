/**
 * `/v1/*` JWT auth middleware.
 *
 * Phase 1: HS256 verification against `MCP_JWT_SECRET` shared with auth-worker.
 * `MCP_JWT_SECRET` may be omitted only in `WORKER_ENV === "test"` (vitest /
 * miniflare); in that mode the middleware still requires a Bearer header but
 * trusts the unsigned payload, which keeps test fixtures cheap while staging /
 * prod stay locked down.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { JwtVerifyError, verifyMcpJwt } from "../lib/jwt";

export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized", reason: "missing_bearer" }, 401);
  }
  const token = header.slice(7);
  const secret = c.env.MCP_JWT_SECRET;
  const isTestEnv = c.env.WORKER_ENV === "test";

  if (!secret) {
    if (!isTestEnv) {
      return c.json({ error: "server_misconfigured", reason: "no_jwt_secret" }, 500);
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return c.json({ error: "unauthorized", reason: "bad_token" }, 401);
    }
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      c.set("auth", {
        sub: payload.sub ?? "test-sub",
        github_login: payload.github_login ?? "test-user",
        scope: payload.scope ?? "mcp.write",
      });
      await next();
      return;
    } catch {
      return c.json({ error: "unauthorized", reason: "bad_token" }, 401);
    }
  }

  try {
    const claims = await verifyMcpJwt(token, secret, c.env.MCP_JWT_AUDIENCE);
    c.set("auth", {
      sub: claims.sub,
      github_login: claims.github_login,
      scope: claims.scope,
    });
    await next();
  } catch (err) {
    const reason = err instanceof JwtVerifyError ? err.reason : "verify";
    return c.json({ error: "unauthorized", reason }, 401);
  }
};
