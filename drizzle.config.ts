/**
 * Drizzle config — `src/db/schema.ts` is the **source-of-truth** for the
 * D1 schema. `drizzle-kit generate` produces matching `migrations/*.sql`
 * files; new migrations should NOT be hand-written from this point on
 * (= edit schema.ts, run `npm run drizzle:generate`, commit both schema +
 * generated SQL + `meta/` snapshot).
 *
 * Pre-drizzle migrations (`0001_init.sql`, `0002_pending_uploads.sql`)
 * were hand-written and are now grandfathered into `meta/0002_snapshot.json`
 * as the baseline. `drizzle-kit generate` recognises that snapshot as the
 * current state and produces `0003_*.sql` for the next schema change.
 *
 * Apply migrations:
 *   - `npm run d1:migrate:local`  — vitest / wrangler dev (local D1)
 *   - `npm run d1:migrate:prod`   — remote prod D1 (requires CF API token
 *     with D1:Edit scope; CI's CLOUDFLARE_API_TOKEN currently lacks this,
 *     so apply is done from a developer workstation, not from CI)
 */
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  driver: "d1-http",
} satisfies Config;
