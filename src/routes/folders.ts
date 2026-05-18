/**
 * `/v1/folders` — folder_create + folder_list (Phase 1).
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const folders = new Hono<AppEnv>();

// POST /v1/folders — folder_create
folders.post("/", (c) => c.json({ error: "not_implemented", tool: "folder_create", phase: "0" }, 501));

// GET /v1/folders — folder_list (query: repo_id, path, recursive)
folders.get("/", (c) => c.json({ error: "not_implemented", tool: "folder_list", phase: "0" }, 501));
