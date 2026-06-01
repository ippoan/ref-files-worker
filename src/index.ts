/**
 * ref-files-worker — HTTP facade for the ref-files MCP toolset.
 *
 * Splits the worker entrypoint by path:
 *
 *   - `/mcp` → durable transport (DO + WebSocket). See `src/durable.ts`.
 *     Stateful, supports `notifications/tools/list_changed`, survives deploys
 *     via WS-drop-and-reconnect (Refs #31).
 *   - everything else → existing Hono app (`src/app.ts`):
 *     `/health`, `/mcp/introspect`, `/upload/:token`, `/download/:token`,
 *     `/v1/*`, `/ui/*`.
 *
 * The DO re-uses the same Hono app for internal `/v1/*` dispatch, so the
 * D1 / R2 business logic and owner scoping live in exactly one place.
 */
import app from "./app";
import { mcpFetch, RefFilesMcp } from "./durable";
import type { Env } from "./env";
import { BulkUploadWorkflow } from "./workflows/bulk-upload";

// Re-exported so wrangler picks the Durable Object class up via the
// `class_name = "RefFilesMcp"` binding in wrangler.toml.
export { RefFilesMcp };

// Re-exported so wrangler picks the Workflow class up via the
// `class_name = "BulkUploadWorkflow"` entry in wrangler.toml ([[workflows]]).
export { BulkUploadWorkflow };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Exact-path mount — `/mcp/introspect` (handled by `app`) and any future
    // `/mcp/*` sub-routes must not be shadowed by the durable transport.
    if (url.pathname === "/mcp") {
      return mcpFetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
