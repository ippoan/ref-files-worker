import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * vitest, running inside workerd via @cloudflare/vitest-pool-workers.
 * The pool spins up a real D1 (sqlite-backed) and real R2 (in-memory) so the
 * route handlers exercise the same `c.env.DB` / `c.env.BLOBS` types they will
 * hit in prod.
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2024-12-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["BLOBS"],
          bindings: {
            WORKER_ENV: "test",
            AUTH_WORKER_ORIGIN: "https://auth.test.invalid",
            MCP_JWT_AUDIENCE: "https://ref-files.test.invalid",
          },
        },
      },
    },
  },
});
