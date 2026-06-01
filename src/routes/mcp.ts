/**
 * `/mcp` — native Streamable HTTP MCP endpoint.
 *
 * Until now the only MCP surface for ref-files was the out-of-process
 * `ref-files-mcp-server-rs` binary, which calls the `/v1/*` REST routes over
 * the network. This module lets the worker speak MCP itself: it borrows
 * `createWorkerMcp` from `@ippoan/mcp-cf-workers` (one `McpServer` +
 * `WebStandardStreamableHTTPServerTransport` per request, stateless) and
 * registers the same nine tools as MCP tools.
 *
 * To avoid duplicating the D1 / R2 business logic, each tool handler
 * **re-dispatches through the existing `/v1/*` Hono routes** with the caller's
 * bearer token. The `/mcp` route is gated by the same `mcpAuth` middleware as
 * `/v1/*`, and the internal sub-request re-verifies the JWT, so authorization
 * (owner scoping, scope checks) stays in exactly one place.
 *
 * Auth: identical to `/v1/*` — HS256 MCP-JWT (`MCP_JWT_SECRET` shared with
 * auth-worker). The `mcpJwtMiddleware` helper that ships in
 * `@ippoan/mcp-cf-workers@>=0.3` is the framework-agnostic equivalent of the
 * `mcpAuth` middleware reused here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context, Hono } from "hono";
import { z } from "zod";

import type { AppEnv, Env } from "../env";

/** Dispatch an internal request through the worker's own `/v1/*` routes. */
type Dispatch = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts?: { query?: Record<string, string | undefined>; body?: unknown },
) => Promise<{ status: number; json: unknown }>;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function toResult(res: { status: number; json: unknown }): ToolResult {
  const text =
    typeof res.json === "string" ? res.json : JSON.stringify(res.json, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(res.status >= 400 ? { isError: true } : {}),
  };
}

function buildQuery(query?: Record<string, string | undefined>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function registerTools(server: McpServer, dispatch: Dispatch): void {
  server.registerTool(
    "repo_init",
    {
      description:
        "Create (or idempotently return) a repo owned by the caller. owner_login is taken from the JWT.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => toResult(await dispatch("POST", "/v1/repos", { body: { name } })),
  );

  server.registerTool(
    "repos_list",
    { description: "List repos owned by the authenticated caller.", inputSchema: {} },
    async () => toResult(await dispatch("GET", "/v1/repos")),
  );

  server.registerTool(
    "folder_create",
    {
      description: "mkdir -p: create a folder and any missing ancestors in a repo.",
      inputSchema: { repo_id: z.string(), path: z.string() },
    },
    async ({ repo_id, path }) =>
      toResult(await dispatch("POST", "/v1/folders", { body: { repo_id, path } })),
  );

  server.registerTool(
    "folder_list",
    {
      description:
        "List folder children (flat) or the whole subtree (recursive=true). Root path = \"\".",
      inputSchema: {
        repo_id: z.string(),
        path: z.string().default(""),
        recursive: z.boolean().default(false),
      },
    },
    async ({ repo_id, path, recursive }) =>
      toResult(
        await dispatch("GET", "/v1/folders", {
          query: { repo_id, path, recursive: recursive ? "true" : "false" },
        }),
      ),
  );

  server.registerTool(
    "file_put",
    {
      description:
        "Append a new revision (or create the file at rev 1). content_base64 is the raw file bytes, base64-encoded.",
      inputSchema: {
        repo_id: z.string(),
        path: z.string(),
        content_base64: z.string(),
        mime: z.string().nullish(),
        message: z.string().nullish(),
      },
    },
    async ({ repo_id, path, content_base64, mime, message }) =>
      toResult(
        await dispatch("POST", "/v1/files", {
          body: {
            repo_id,
            path,
            content_base64,
            mime: mime ?? null,
            message: message ?? null,
          },
        }),
      ),
  );

  server.registerTool(
    "file_get",
    {
      description:
        "Fetch a file's latest revision (or an explicit revision). Returns metadata + content_base64.",
      inputSchema: {
        repo_id: z.string(),
        path: z.string(),
        revision: z.number().int().nullish(),
      },
    },
    async ({ repo_id, path, revision }) =>
      toResult(
        await dispatch("GET", "/v1/files", {
          query: {
            repo_id,
            path,
            revision: revision != null ? String(revision) : undefined,
          },
        }),
      ),
  );

  server.registerTool(
    "file_history",
    {
      description: "List a file's revisions, newest first. limit is clamped to 1..=100 (default 20).",
      inputSchema: {
        repo_id: z.string(),
        path: z.string(),
        limit: z.number().int().nullish(),
      },
    },
    async ({ repo_id, path, limit }) =>
      toResult(
        await dispatch("GET", "/v1/files/history", {
          query: { repo_id, path, limit: limit != null ? String(limit) : undefined },
        }),
      ),
  );

  server.registerTool(
    "file_move",
    {
      description: "Move/rename a file; auto-creates the destination folder chain. 409 if the target exists.",
      inputSchema: { repo_id: z.string(), from_path: z.string(), to_path: z.string() },
    },
    async ({ repo_id, from_path, to_path }) =>
      toResult(
        await dispatch("POST", "/v1/files/move", { body: { repo_id, from_path, to_path } }),
      ),
  );

  server.registerTool(
    "file_delete",
    {
      description: "Soft-delete a file (sets deleted_at). Revisions are kept so file_history still resolves.",
      inputSchema: { repo_id: z.string(), path: z.string() },
    },
    async ({ repo_id, path }) =>
      toResult(await dispatch("DELETE", "/v1/files", { query: { repo_id, path } })),
  );

  server.registerTool(
    "file_search",
    {
      description: "LIKE search on file name + path within a repo. Optional under_path scope / include_deleted.",
      inputSchema: {
        repo_id: z.string(),
        query: z.string(),
        under_path: z.string().nullish(),
        include_deleted: z.boolean().default(false),
        limit: z.number().int().nullish(),
      },
    },
    async ({ repo_id, query, under_path, include_deleted, limit }) =>
      toResult(
        await dispatch("GET", "/v1/files/search", {
          query: {
            repo_id,
            query,
            under_path: under_path ?? undefined,
            include_deleted: include_deleted ? "true" : undefined,
            limit: limit != null ? String(limit) : undefined,
          },
        }),
      ),
  );

  server.registerTool(
    "inventory",
    {
      description:
        "Cross-repo file listing scoped to the caller's owner_login. Optional repo-name filter / include_deleted.",
      inputSchema: {
        repo: z.string().nullish(),
        include_deleted: z.boolean().default(false),
      },
    },
    async ({ repo, include_deleted }) =>
      toResult(
        await dispatch("GET", "/v1/inventory", {
          query: {
            repo: repo ?? undefined,
            include_deleted: include_deleted ? "true" : undefined,
          },
        }),
      ),
  );
}

/**
 * Hono handler for `POST /mcp`. `app` is the root app, reused for internal
 * `/v1/*` dispatch. Auth is enforced by `mcpAuth` mounted on `/mcp` upstream,
 * and again on each internal sub-request.
 */
export async function handleMcp(c: Context<AppEnv>, app: Hono<AppEnv>): Promise<Response> {
  const authHeader = c.req.header("Authorization") ?? "";

  const dispatch: Dispatch = async (method, path, opts) => {
    const url = `https://ref-files.internal${path}${buildQuery(opts?.query)}`;
    const headers: Record<string, string> = { Authorization: authHeader };
    const init: RequestInit = { method, headers };
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    // No ExecutionContext is forwarded: the `/v1/*` tool routes are fully
    // synchronous (no `waitUntil`), and `c.executionCtx` throws in test envs.
    const res = await app.fetch(new Request(url, init), c.env);
    const raw = await res.text();
    let json: unknown;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = raw;
    }
    return { status: res.status, json };
  };

  // Dynamic import: `createWorkerMcp` pulls in `@modelcontextprotocol/sdk`'s
  // `McpServer`, which eagerly imports `ajv`. Loading that at module-eval time
  // would break every worker test under `@cloudflare/vitest-pool-workers`
  // (workerd's module fallback can't resolve ajv's nested `./refs/data.json`).
  // Deferring it to the first `/mcp` request keeps the rest of the worker —
  // and its test suite — clean; the production bundle (esbuild) inlines ajv
  // normally.
  const { createWorkerMcp } = await import("@ippoan/mcp-cf-workers");

  const handler = createWorkerMcp<Env>({
    name: "ref-files",
    version: "0.1.0",
    registerTools: (server) => registerTools(server, dispatch),
  });

  return handler(c.req.raw, c.env);
}
