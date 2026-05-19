/**
 * Drizzle config — used by `drizzle-kit generate` to emit SQL migrations
 * from `src/db/schema.ts`. We keep `migrations/0001_init.sql` as the canonical
 * D1 migration (applied via `wrangler d1 migrations apply`), so `drizzle-kit`
 * is mostly used for diff/inspect; new migrations should still land as hand-
 * written SQL under `migrations/` until we've fully validated the Drizzle
 * output against D1's SQLite dialect.
 */
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  driver: "d1-http",
} satisfies Config;
