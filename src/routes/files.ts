/**
 * `/v1/files` — file_put / file_get / file_history / file_move / file_delete
 *               / file_search (Phase 1).
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const files = new Hono<AppEnv>();

// POST /v1/files — file_put (body: FilePutArgs)
files.post("/", (c) => c.json({ error: "not_implemented", tool: "file_put", phase: "0" }, 501));

// GET /v1/files — file_get (query: repo_id, path, revision?)
files.get("/", (c) => c.json({ error: "not_implemented", tool: "file_get", phase: "0" }, 501));

// DELETE /v1/files — file_delete (query: repo_id, path) — soft delete
files.delete("/", (c) => c.json({ error: "not_implemented", tool: "file_delete", phase: "0" }, 501));

// GET /v1/files/history — file_history (query: repo_id, path, limit?)
files.get("/history", (c) =>
  c.json({ error: "not_implemented", tool: "file_history", phase: "0" }, 501),
);

// POST /v1/files/move — file_move (body: FileMoveArgs)
files.post("/move", (c) =>
  c.json({ error: "not_implemented", tool: "file_move", phase: "0" }, 501),
);

// GET /v1/files/search — file_search (query: repo_id, query, under_path?, include_deleted?, limit?)
files.get("/search", (c) =>
  c.json({ error: "not_implemented", tool: "file_search", phase: "0" }, 501),
);
