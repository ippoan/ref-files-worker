/**
 * `/ui/*` Cloudflare Access middleware.
 *
 * The `/ui/*` surface is for humans hitting the worker through a browser
 * behind a Cloudflare Access application (SSO: Google / GitHub / etc). Access
 * terminates the SSO in front of the worker and forwards a signed assertion
 * in the `Cf-Access-Jwt-Assertion` header (also dropped as the `CF_Authorization`
 * cookie). We re-verify that assertion here so a request that somehow reaches
 * the worker without going through Access is rejected.
 *
 * Config (Worker vars, see wrangler.toml):
 *   - `CF_ACCESS_TEAM_DOMAIN` — e.g. `ippoan.cloudflareaccess.com`
 *   - `CF_ACCESS_AUD`         — the Access Application's AUD tag
 *
 * Test mode (`WORKER_ENV === "test"`): the header shape is checked but the
 * RS256 signature is trusted, mirroring `middleware/auth.ts`. This keeps the
 * vitest fixtures cheap (no RSA keypair / JWKS server) while prod stays locked.
 * Outside test, missing config returns 500 `server_misconfigured`.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { AccessVerifyError, verifyAccessJwt } from "../lib/cf-access-jwt";

const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

export const cfAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header(ACCESS_HEADER);
  if (!token) {
    return c.json({ error: "unauthorized", reason: "missing_access_jwt" }, 401);
  }

  const isTestEnv = c.env.WORKER_ENV === "test";
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = c.env.CF_ACCESS_AUD;

  if (!teamDomain || !aud) {
    if (!isTestEnv) {
      return c.json({ error: "server_misconfigured", reason: "no_cf_access_config" }, 500);
    }
    // Test branch: trust the unsigned payload's `email` / `sub`.
    const parts = token.split(".");
    if (parts.length !== 3) {
      return c.json({ error: "unauthorized", reason: "bad_token" }, 401);
    }
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (typeof payload.email !== "string" || payload.email.length === 0) {
        return c.json({ error: "unauthorized", reason: "email" }, 401);
      }
      c.set("accessUser", { email: payload.email, sub: payload.sub ?? "test-access-sub" });
      await next();
      return;
    } catch {
      return c.json({ error: "unauthorized", reason: "bad_token" }, 401);
    }
  }

  try {
    const claims = await verifyAccessJwt(token, teamDomain, aud);
    c.set("accessUser", { email: claims.email, sub: claims.sub });
    await next();
  } catch (err) {
    const reason = err instanceof AccessVerifyError ? err.reason : "verify";
    return c.json({ error: "unauthorized", reason }, 401);
  }
};
