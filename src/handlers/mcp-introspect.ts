/**
 * `POST /mcp/introspect`
 *
 * RFC 7662 OAuth 2.0 Token Introspection. The endpoint mirrors the shape
 * `auth-worker` exposes (`handlers/mcp-introspect.ts`) so the
 * `ref-files-mcp-server-rs` binary can hit either worker with a single
 * embedded shared secret. ref-files-worker stores file data in D1+R2 and
 * has no GitHub PAT to hand back, so the response shape is auth-worker's
 * minus the `github_token` field — the binary only needs the JWT to be
 * verified and the identity claims confirmed before it switches to
 * relay-mode against `/v1/*`.
 *
 * Auth modes (the first one that succeeds wins):
 *   1. **Bearer JWT** — `Authorization: Bearer <MCP_JWT>`. The bearer is
 *      verified against `MCP_JWT_SECRET` (shared with auth-worker) and
 *      becomes the introspect subject.
 *   2. **Shared secret (legacy)** — `Authorization: <INTERNAL_SHARED_SECRET>`
 *      (raw value, no `Bearer` prefix) plus body `{ "token": "<JWT>" }`.
 *      Kept for the existing binary; new callers should prefer mode 1.
 *
 * Responses (RFC 7662 §2.2):
 *   - 200 `{ active: true, scope, sub, github_login, aud, exp }` on success
 *   - 200 `{ active: false }` on caller-authenticated-but-token-invalid
 *   - 401 when neither auth mode is satisfied
 *   - 503 `{ active: false, error: "server_error" }` when env is missing
 *
 * `Cache-Control: no-store` per RFC 7662 §4.
 */
import type { Env } from "../env";
import { verifyMcpJwt, type McpJwtClaims } from "../lib/jwt";

function jsonNoStore(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function activeFromClaims(claims: McpJwtClaims) {
  return {
    active: true as const,
    scope: claims.scope,
    sub: claims.sub,
    github_login: claims.github_login,
    aud: claims.aud,
    exp: claims.exp,
  };
}

/**
 * Resolve a bearer-shaped string to verified claims. Mirrors the test-mode
 * branch in `src/middleware/auth.ts`: when `WORKER_ENV === "test"` and no
 * `MCP_JWT_SECRET` is bound, the payload is parsed without signature check
 * so vitest fixtures stay cheap. Staging / prod always go through HS256.
 */
async function resolveClaims(token: string, env: Env): Promise<McpJwtClaims | null> {
  if (env.WORKER_ENV === "test" && !env.MCP_JWT_SECRET) {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(json) as Partial<McpJwtClaims>;
      if (
        typeof payload.sub !== "string" ||
        typeof payload.github_login !== "string" ||
        typeof payload.scope !== "string" ||
        typeof payload.aud !== "string" ||
        typeof payload.exp !== "number"
      ) {
        return null;
      }
      return payload as McpJwtClaims;
    } catch {
      return null;
    }
  }
  if (!env.MCP_JWT_SECRET) return null;
  try {
    return await verifyMcpJwt(token, env.MCP_JWT_SECRET, env.MCP_JWT_AUDIENCE);
  } catch {
    return null;
  }
}

export async function handleMcpIntrospect(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.INTERNAL_SHARED_SECRET) {
    return jsonNoStore({ active: false, error: "server_error" }, 503);
  }
  if (env.WORKER_ENV !== "test" && !env.MCP_JWT_SECRET) {
    return jsonNoStore({ active: false, error: "server_error" }, 503);
  }

  const authz = request.headers.get("Authorization") ?? "";

  // Mode 1 — Bearer JWT.
  const bearer = /^Bearer\s+(.+)$/i.exec(authz);
  if (bearer && bearer[1]) {
    const claims = await resolveClaims(bearer[1], env);
    if (!claims) {
      return jsonNoStore({ error: "unauthorized" }, 401);
    }
    return jsonNoStore(activeFromClaims(claims));
  }

  // Mode 2 — raw INTERNAL_SHARED_SECRET + body { token }.
  if (!authz || !constantTimeEquals(authz, env.INTERNAL_SHARED_SECRET)) {
    return jsonNoStore({ error: "unauthorized" }, 401);
  }

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return jsonNoStore({ active: false });
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    return jsonNoStore({ active: false });
  }

  const claims = await resolveClaims(token, env);
  if (!claims) {
    return jsonNoStore({ active: false });
  }
  return jsonNoStore(activeFromClaims(claims));
}
