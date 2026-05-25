/**
 * Test helpers shared by every spec.
 *
 * - `applyMigrations` — exec the canonical `migrations/0001_init.sql`. The
 *   vitest-pool-workers D1 binding is empty per test file by default; we
 *   replay the SQL so each suite hits the same schema as prod.
 * - `mintToken` — produce a phase-1-shaped JWT-ish string. `WORKER_ENV=test`
 *   means the auth middleware reads the payload without verifying the
 *   signature; we still emit 3 dot-separated b64url segments so the shape
 *   check passes.
 */
import { env } from "cloudflare:test";
import migration0001 from "../migrations/0001_init.sql?raw";
import migration0002 from "../migrations/0002_pending_uploads.sql?raw";

let applied = false;

async function execSqlBatch(sql: string): Promise<void> {
  // Strip line comments first so a comment block at the top of the file
  // doesn't poison the first split chunk (which contains CREATE TABLE).
  const stripped = sql
    .split("\n")
    .filter((l: string) => !l.trim().startsWith("--"))
    .join("\n");
  const statements = stripped
    .split(";")
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
  // Sequential — FOREIGN KEY parents must exist before children.
  for (const stmt of statements) {
    await (env as any).DB.prepare(stmt).run();
  }
}

export async function applyMigrations() {
  if (applied) return;
  for (const sql of [migration0001, migration0002]) {
    await execSqlBatch(sql);
  }
  applied = true;
}

function b64url(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function mintToken(claims: {
  sub?: string;
  github_login?: string;
  scope?: string;
}): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: claims.sub ?? "u-1",
      github_login: claims.github_login ?? "tester",
      scope: claims.scope ?? "mcp.write",
      aud: "https://ref-files.test.invalid",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

export const authHeader = (claims?: Parameters<typeof mintToken>[0]) => ({
  Authorization: `Bearer ${mintToken(claims ?? {})}`,
  "Content-Type": "application/json",
});
