/**
 * Durable (DO + WebSocket) MCP transport for `/mcp`.
 *
 * Replaces the stateless `createWorkerMcp` path. Motivation (Refs #31):
 *
 *   - stateless transport cannot push `notifications/tools/list_changed`.
 *     After a deploy that adds/removes a tool, live sessions stay frozen on
 *     the old `tools/list` until the client reconnects.
 *   - the durable transport (McpAgent + WebSocket inside a Durable Object)
 *     drops the WS on deploy, which makes Claude Code's MCP client auto-
 *     reconnect and re-run `initialize` / `tools/list`. This is the
 *     "Phase 0 Gate A" pass documented in mcp-cf-workers/CLAUDE.md.
 *   - it also advertises `capabilities.tools.listChanged: true`, so once the
 *     upstream client bug (anthropics/claude-code#13646) is fixed, runtime
 *     `sendToolListChanged` will also work without a reconnect.
 *
 * The DO re-uses the **same Hono `app`** (`src/app.ts`) for internal
 * `/v1/*` dispatch — no business logic is duplicated. The bearer captured
 * at the edge in `authenticate()` is replayed on every sub-request so
 * `/v1/*`'s `mcpAuth` middleware re-verifies and owner scoping stays
 * single-sourced.
 */
import { createDurableMcp, mountDurableMcp } from "@ippoan/mcp-cf-workers/durable";

import app from "./app";
import type { Env } from "./env";
import { JwtVerifyError, verifyMcpJwt } from "./lib/jwt";
import { resolveMcpJwtSecret } from "./handlers/mcp-introspect";
import { buildQuery, registerTools, type Dispatch } from "./routes/mcp";

/**
 * Props attached to each DO session by the edge `authenticate()` step.
 *
 * `bearer` is the raw token the client sent on the upgrade request — we keep
 * it so internal `/v1/*` dispatch can re-present it and the `mcpAuth`
 * middleware re-verifies under the same code path used by REST callers.
 */
export interface RefFilesProps extends Record<string, unknown> {
  github_login: string;
  sub: string;
  scope: string;
  bearer: string;
}

export const RefFilesMcp = createDurableMcp<Env, RefFilesProps>({
  name: "ref-files",
  version: "0.1.0",
  registerTools(server, env, props) {
    const dispatch: Dispatch = async (method, path, opts) => {
      const url = `https://ref-files.internal${path}${buildQuery(opts?.query)}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${props.bearer}`,
      };
      const init: RequestInit = { method, headers };
      if (opts?.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
      const res = await app.fetch(new Request(url, init), env);
      const raw = await res.text();
      let json: unknown;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = raw;
      }
      return { status: res.status, json };
    };
    registerTools(server, dispatch);
  },
});

/**
 * Edge fetch handler for `/mcp`. Verifies the MCP-JWT (same path as the
 * `mcpAuth` middleware on `/v1/*`), then hands props to `mountDurableMcp`
 * which routes to the Durable Object.
 *
 * Returns a 401 with the RFC 6750 + RFC 9728 `WWW-Authenticate` challenge on
 * verification failure so the claude.ai connector can auto-discover the AS.
 */
export const mcpFetch = mountDurableMcp<Env>({
  agent: RefFilesMcp,
  path: "/mcp",
  binding: "MCP_OBJECT",
  async authenticate(request, env) {
    const authOrigin = env.AUTH_WORKER_ORIGIN ?? "https://auth-staging.ippoan.org";
    const header = request.headers.get("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      throw new McpAuthError("missing_bearer", "invalid_request", authOrigin);
    }
    const bearer = header.slice(7);
    const secret = await resolveMcpJwtSecret(env);
    const isTestEnv = env.WORKER_ENV === "test";

    if (!secret) {
      if (!isTestEnv) {
        throw new McpAuthError("no_jwt_secret", "server_error", authOrigin);
      }
      // Test env: trust the unsigned payload (same trade-off as `mcpAuth`).
      const parts = bearer.split(".");
      if (parts.length !== 3) throw new McpAuthError("bad_token", "invalid_token", authOrigin);
      try {
        const payload = JSON.parse(
          atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
        );
        return {
          sub: payload.sub ?? "test-sub",
          github_login: payload.github_login ?? "test-user",
          scope: payload.scope ?? "mcp.write",
          bearer,
        } satisfies RefFilesProps;
      } catch {
        throw new McpAuthError("bad_token", "invalid_token", authOrigin);
      }
    }

    try {
      const claims = await verifyMcpJwt(bearer, secret, env.MCP_JWT_AUDIENCE);
      return {
        sub: claims.sub,
        github_login: claims.github_login,
        scope: claims.scope,
        bearer,
      } satisfies RefFilesProps;
    } catch (err) {
      const reason = err instanceof JwtVerifyError ? err.reason : "verify";
      throw new McpAuthError(reason, "invalid_token", authOrigin);
    }
  },
  onAuthError(err, _request) {
    const reason = err instanceof McpAuthError ? err.reason : "unauthorized";
    const errorTag = err instanceof McpAuthError ? err.errorTag : "invalid_token";
    const authOrigin =
      err instanceof McpAuthError ? err.authOrigin : "https://auth-staging.ippoan.org";
    const challenge =
      `Bearer realm="MCP", resource_metadata="${authOrigin}/.well-known/oauth-protected-resource/ref-files", error="${errorTag}"`;
    return new Response(JSON.stringify({ error: "unauthorized", reason }), {
      status: errorTag === "server_error" ? 500 : 401,
      headers: {
        "WWW-Authenticate": challenge,
        "content-type": "application/json",
      },
    });
  },
});

class McpAuthError extends Error {
  constructor(
    readonly reason: string,
    readonly errorTag: string = "invalid_token",
    readonly authOrigin: string = "https://auth-staging.ippoan.org",
  ) {
    super(reason);
  }
}
