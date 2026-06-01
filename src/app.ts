/**
 * Hono app — composition only: middleware + sub-app mounts. Actual handlers
 * live under `src/routes/`, schema under `src/db/`, auth under
 * `src/middleware/`.
 *
 * Each `/v1/*` route corresponds 1:1 to an MCP tool registered in
 * `src/routes/mcp.ts`. The MCP transport itself (`/mcp`) is wired in
 * `src/index.ts` via the durable (DO + WebSocket) path — see `src/durable.ts`.
 *
 * Exported separately from the worker entry so the Durable Object can re-use
 * the same Hono app for internal `/v1/*` dispatch.
 */
import { Hono } from "hono";

import type { AppEnv } from "./env";
import { handleMcpIntrospect } from "./handlers/mcp-introspect";
import { mcpAuth } from "./middleware/auth";
import { cfAccess } from "./middleware/cf-access";
import { admin } from "./routes/admin";
import { files } from "./routes/files";
import { folders } from "./routes/folders";
import { inventory } from "./routes/inventory";
import { repos } from "./routes/repos";
import { uploads } from "./routes/uploads";

export const app = new Hono<AppEnv>();

// Liveness — no auth, no DB hit.
app.get("/health", (c) =>
  c.json({ ok: true, env: c.env.WORKER_ENV, version: "0.1.0-phase0" }),
);

// RFC 7662 introspection — has its own auth (Bearer JWT or raw shared
// secret), so it lives outside the `/v1/*` JWT middleware.
app.post("/mcp/introspect", (c) => handleMcpIntrospect(c.req.raw, c.env));

// Pre-signed upload / download — the path-bound token IS the credential,
// no JWT. Mounted at root before `/v1/*` so the JWT middleware doesn't fire
// for `/upload/:token` and `/download/:token`.
app.route("/", uploads);

// JWT-required surface.
app.use("/v1/*", mcpAuth);
app.route("/v1/repos", repos);
app.route("/v1/folders", folders);
app.route("/v1/files", files);
app.route("/v1/inventory", inventory);

// Cloudflare Access-gated human surface. SSO is terminated by Access in front
// of the worker; `cfAccess` re-verifies the forwarded assertion. Spans every
// owner (global inventory) — Access policy is the authorization boundary.
app.use("/ui/*", cfAccess);
app.route("/ui", admin);

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error("[ref-files-worker]", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;
