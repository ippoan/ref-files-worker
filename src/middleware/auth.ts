/**
 * `/v1/*` + `/mcp` JWT auth middleware.
 *
 * Phase 1: HS256 verification against `MCP_JWT_SECRET` shared with auth-worker.
 * `MCP_JWT_SECRET` may be omitted only in `WORKER_ENV === "test"` (vitest /
 * miniflare); in that mode the middleware still requires a Bearer header but
 * trusts the unsigned payload, which keeps test fixtures cheap while staging /
 * prod stay locked down.
 *
 * Every 401 carries an RFC 6750 + RFC 9728 `WWW-Authenticate` challenge so the
 * claude.ai connector can auto-discover the authorization server: it follows
 * `resource_metadata` to auth-worker's per-resource Protected Resource Metadata
 * (`/.well-known/oauth-protected-resource/ref-files`), reads `authorization_servers`,
 * does Dynamic Client Registration, and mints a token whose `aud` is the
 * resource URL `https://ref-files.ippoan.org` (accepted by `MCP_JWT_AUDIENCE`).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { resolveMcpJwtSecret } from "../handlers/mcp-introspect";
import { JwtVerifyError, verifyMcpJwt } from "../lib/jwt";

/**
 * Resource slug under auth-worker's per-resource metadata endpoint. By the
 * `MCP_RESOURCE_ORIGINS_ALLOWLIST` convention this is the hostname's first
 * label of `https://ref-files.ippoan.org` (Refs ippoan/auth-worker#195).
 */
const RESOURCE_METADATA_SLUG = "ref-files";

/** RFC 6750 + RFC 9728 challenge pointing the connector at the AS metadata. */
function wwwAuthenticate(authOrigin: string, error?: string): string {
  const base = `Bearer realm="MCP", resource_metadata="${authOrigin}/.well-known/oauth-protected-resource/${RESOURCE_METADATA_SLUG}"`;
  return error ? `${base}, error="${error}"` : base;
}

function unauthorized(
  c: Context<AppEnv>,
  reason: string,
  error: string = "invalid_token",
): Response {
  c.header(
    "WWW-Authenticate",
    wwwAuthenticate(c.env.AUTH_WORKER_ORIGIN ?? "https://auth.ippoan.org", error),
  );
  return c.json({ error: "unauthorized", reason }, 401);
}

export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return unauthorized(c, "missing_bearer", "invalid_request");
  }
  const token = header.slice(7);
  const secret = await resolveMcpJwtSecret(c.env);
  const isTestEnv = c.env.WORKER_ENV === "test";

  if (!secret) {
    if (!isTestEnv) {
      return c.json({ error: "server_misconfigured", reason: "no_jwt_secret" }, 500);
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return unauthorized(c, "bad_token");
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
      return unauthorized(c, "bad_token");
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
    return unauthorized(c, reason);
  }
};
