/**
 * MCP tool registry — shared between the durable (DO+WS) `/mcp` transport
 * (`src/durable.ts`) and any future stateless surface.
 *
 * Each tool handler **re-dispatches through the existing `/v1/*` Hono routes**
 * via the `Dispatch` callback so the D1 / R2 business logic and owner scoping
 * live in exactly one place. The caller wires `dispatch` to either an internal
 * `app.fetch(...)` (durable path, see `src/durable.ts`) or a Service Binding.
 *
 * Auth: identical to `/v1/*` — HS256 MCP-JWT (`MCP_JWT_SECRET` shared with
 * auth-worker). The dispatch wrapper attaches the caller's bearer so the
 * `/v1/*` middleware re-verifies the JWT on every sub-request.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Dispatch an internal request through the worker's own `/v1/*` routes. */
export type Dispatch = (
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

export function buildQuery(query?: Record<string, string | undefined>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function registerTools(server: McpServer, dispatch: Dispatch): void {
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
    "folder_download_url",
    {
      description:
        "Issue a pre-signed URL that streams the folder (recursive) as a single tar.gz. Use this instead of file_get when reading multiple files — the URL can be piped to `tar xzf -` and avoids base64 token bloat. Root path = \"\" downloads the whole repo.",
      inputSchema: { repo_id: z.string(), path: z.string().default("") },
    },
    async ({ repo_id, path }) =>
      toResult(
        await dispatch("GET", "/v1/folders/download-url", {
          query: { repo_id, path },
        }),
      ),
  );

  server.registerTool(
    "file_put",
    {
      description:
        "Append a new revision (or create the file at rev 1). content_base64 is the raw file bytes, base64-encoded. Prefer `file_upload_url` (single file) or `folder_upload_url` (tar.gz bulk) when the payload exceeds a few hundred KB — base64 in JSON blows up assistant output tokens.",
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
    "file_upload_url",
    {
      description:
        "Issue a pre-signed PUT URL for a single-file upload. Use this instead of file_put when the file is large (e.g. >100KB) — uploads bytes directly to R2 and avoids base64 token bloat. Send the bytes with `curl -X PUT --data-binary @<file> <upload_url>`.",
      inputSchema: {
        repo_id: z.string(),
        path: z.string(),
        mime: z.string().nullish(),
        message: z.string().nullish(),
      },
    },
    async ({ repo_id, path, mime, message }) =>
      toResult(
        await dispatch("POST", "/v1/files/upload-init", {
          body: {
            repo_id,
            path,
            mime: mime ?? null,
            message: message ?? null,
          },
        }),
      ),
  );

  server.registerTool(
    "folder_upload_url",
    {
      description:
        "Issue a pre-signed PUT URL for a tar.gz bulk upload. Use this instead of repeated file_put when uploading many files — avoids base64 token bloat. Mirror of folder_download_url. Send the archive with `curl -X PUT --data-binary @<bundle.tar.gz> <upload_url>`. base_path = \"\" extracts at the repo root. The PUT stages the archive and returns 202 `{ workflow_id }`: extraction runs in a durable Workflow off the request lifecycle (no client-timeout / partial-commit), so poll `bulk_upload_status(workflow_id)` until status is `complete`.",
      inputSchema: {
        repo_id: z.string(),
        base_path: z.string().default(""),
        message: z.string().nullish(),
      },
    },
    async ({ repo_id, base_path, message }) =>
      toResult(
        await dispatch("POST", "/v1/files/bulk-upload-init", {
          body: {
            repo_id,
            base_path,
            message: message ?? null,
          },
        }),
      ),
  );

  server.registerTool(
    "bulk_upload_status",
    {
      description:
        "Poll the durable Workflow that extracts a folder_upload_url tar.gz. Pass the workflow_id from the 202 PUT response. Returns the instance status (queued|running|complete|errored|...); on `complete`, `output` holds { count, files }.",
      inputSchema: { workflow_id: z.string() },
    },
    async ({ workflow_id }) =>
      toResult(
        await dispatch("GET", "/v1/files/bulk-upload-status", {
          query: { id: workflow_id },
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

