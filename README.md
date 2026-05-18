# ref-files-worker

Cloudflare Worker backend for [`ref-files-mcp-server-rs`](https://github.com/ippoan/ref-files-mcp-server-rs).

- **D1** — `repos` / `folders` / `files` / `revisions` (see `migrations/0001_init.sql`).
- **R2** — blob storage. Key format: `files/{repo_id}/{file_id}/{rev_number}`.
- **Auth** — HS256 JWT verification, sharing the secret with `auth-worker` (`src/lib/mcp-jwt.ts`).

## Layout

```
src/
├── index.ts          # Hono root: composition only (middleware + sub-app mounts)
├── env.ts            # Bindings + Variables types shared by all routes
├── middleware/
│   └── auth.ts       # /v1/* JWT middleware
├── routes/
│   ├── repos.ts      # /v1/repos       -> repo_init
│   ├── folders.ts    # /v1/folders     -> folder_create, folder_list
│   └── files.ts      # /v1/files{,/*}  -> file_put/get/history/move/delete/search
├── db/
│   ├── schema.ts     # Drizzle table defs matching migrations/0001_init.sql
│   └── index.ts      # `db(env)` factory
└── types/            # ts-rs generated DTOs (do not edit — see src/types/README.md)
```

## Type contract

Rust (`ref-files-mcp-server-rs/src/types/`) is the single source of truth.
`.github/workflows/sync-types.yml` regenerates `src/types/` via `cargo run --bin gen-ts` and fails the PR on drift.

## Local dev

```bash
npm ci
npm run d1:migrate:local
npm run dev      # wrangler dev
```

## Phase 0 (this PR)

- `wrangler.toml` (D1 + R2 bindings, JWT vars)
- `migrations/0001_init.sql` (4 tables)
- Modular Hono skeleton — every `/v1/*` route returns 501 with the matching `tool` name
- Drizzle schema mirroring the SQL
- `sync-types.yml` ts-rs drift gate
- `ci.yml` via `ippoan/ci-workflows/frontend-ci.yml@main`

## Phase 1

Implement the 9 MCP tools end-to-end + real JWT verify + vitest + staging deploy.
