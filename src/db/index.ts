/**
 * Drizzle handle factory — one place to wire `c.env.DB` to the schema so
 * route handlers can do `db(c.env).select().from(repos)...` without each
 * importing the driver.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type DB = DrizzleD1Database<typeof schema>;

export function db(env: { DB: D1Database }): DB {
  return drizzle(env.DB, { schema });
}

export * as schema from "./schema";
