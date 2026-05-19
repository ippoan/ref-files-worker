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
│   └── auth.ts       # /v1/* JWT middleware (HS256 verify, test-mode unsigned bearer)
├── routes/
│   ├── repos.ts      # /v1/repos        -> repo_init
│   ├── folders.ts    # /v1/folders      -> folder_create, folder_list
│   └── files.ts      # /v1/files{,/*}   -> file_put/get/history/move/delete/search
├── db/
│   ├── schema.ts     # Drizzle table defs matching migrations/0001_init.sql
│   └── index.ts      # `db(env)` factory
├── lib/
│   ├── jwt.ts        # HS256 verifier (Web Crypto, constant-time, 30s skew)
│   ├── path.ts       # POSIX-style path normalization + LIKE escape
│   ├── hash.ts       # SHA-256 hex + base64 helpers
│   └── repo-ops.ts   # repo ownership gate + mkdir -p helpers
└── types/            # ts-rs generated DTOs (do not edit — see src/types/README.md)

test/                 # vitest-pool-workers (in-process miniflare D1 + R2)
├── auth.test.ts      # verifyMcpJwt happy/sad paths + /health + 401 gate
├── repos.test.ts     # repo_init idempotency + owner isolation
├── folders.test.ts   # mkdir -p + recursive listing + ownership 403
└── files.test.ts     # put/get/history/move/delete/search semantics
```

## Type contract

Rust (`ref-files-mcp-server-rs/src/types/`) is the single source of truth.
`.github/workflows/sync-types.yml` regenerates `src/types/` via `cargo run --bin gen-ts` and fails the PR on drift.

## Local dev

```bash
npm ci
npm run d1:migrate:local
npm run dev          # wrangler dev
npm test             # vitest run (24 specs, ~3s)
npm run typecheck    # tsc --noEmit
```

## Phase 0

- `wrangler.toml` (D1 + R2 bindings, JWT vars)
- `migrations/0001_init.sql` (4 tables)
- Modular Hono skeleton — every `/v1/*` route returns 501 with the matching `tool` name
- Drizzle schema mirroring the SQL
- `sync-types.yml` ts-rs drift gate
- `ci.yml` via `ippoan/ci-workflows/frontend-ci.yml@main`

## Phase 1 (this branch)

All 9 MCP tools end-to-end, real HS256 JWT verify, and a vitest suite that
exercises the routes through `worker.fetch(...)` against an in-process
miniflare D1 + R2.

| Tool | Method + Path | Notes |
|------|--------------|-------|
| `repo_init` | `POST /v1/repos` | Idempotent on `(owner_login, name)`. `owner_login` is taken from the JWT, never the request body. |
| `folder_create` | `POST /v1/folders` | mkdir -p — walks ancestors, inserts any that don't exist. |
| `folder_list` | `GET /v1/folders` | Flat (children of `path`) or `recursive=true` (subtree via `path LIKE`). Root path = `""`. |
| `file_put` | `POST /v1/files` | Appends a new revision (or creates the file at rev 1). R2 key: `files/{repo_id}/{file_id}/{rev_number}`. |
| `file_get` | `GET /v1/files` | Latest revision by default; explicit `?revision=N` stays reachable after `file_delete`. |
| `file_history` | `GET /v1/files/history` | Newest-first. `limit` clamped to `1..=100`, default 20. |
| `file_move` | `POST /v1/files/move` | Auto-creates the destination folder chain; 409 on existing target. |
| `file_delete` | `DELETE /v1/files` | Soft (sets `deleted_at`); revisions are kept so `file_history` still resolves. |
| `file_search` | `GET /v1/files/search` | LIKE on `name` + `path`. Optional `under_path` scope, `include_deleted` toggle. |

### Path & input validation

- Every user-supplied path goes through `normalizePath()` — leading slashes /
  `.` / `..` / embedded NUL / non-segment characters all return `400`.
- `escapeLike()` neutralises `%` / `_` / `\` in `query` and `under_path`
  before they reach the D1 `LIKE` clause.
- Repo names must match `^[a-z0-9][a-z0-9._-]{0,62}$`.

### Auth

`Authorization: Bearer <jwt>` is required for every `/v1/*` route.

- **prod / staging** (`WORKER_ENV` ≠ `"test"`): HMAC-SHA-256 signature
  recomputed with `MCP_JWT_SECRET`, constant-time compared; `alg` pinned to
  `HS256`; `aud === MCP_JWT_AUDIENCE`; `exp` enforced with 30s skew.
  Missing `MCP_JWT_SECRET` returns 500 (`server_misconfigured`).
- **test** (`WORKER_ENV === "test"`): bearer shape checked but signature is
  trusted — vitest fixtures (`test/helpers.ts::mintToken`) can mint cheap
  unsigned tokens. Staging / prod are unaffected.

`/health` is unauthenticated and returns `{ ok, env, version }`.

### Error wire shape

Non-2xx responses are `{ "error": <code>, "reason"?: <detail> }`. Codes used:

- `bad_request` — input shape / path / base64 / repo name / etc.
- `unauthorized` — missing or invalid bearer (`reason` ∈ `missing_bearer`,
  `bad_token`, `expired`, `audience`, `alg`, `signature`, ...)
- `forbidden` — JWT `github_login` doesn't match the repo's `owner_login`
- `not_found` — repo / folder / file / blob (with `reason` distinguishing)
- `conflict` — `file_put` race or `file_move` destination exists
- `server_misconfigured` — secrets missing in non-test envs
- `internal_error`

## Tests

`vitest-pool-workers` boots an in-process miniflare with the same D1 + R2
bindings the deployed worker uses, so the route handlers exercise the same
`c.env.DB` / `c.env.BLOBS` types they will hit in prod.

```bash
$ npm test
 ✓ test/auth.test.ts    (8)
 ✓ test/repos.test.ts   (4)
 ✓ test/folders.test.ts (4)
 ✓ test/files.test.ts   (8)

 Test Files  4 passed (4)
      Tests  24 passed (24)
```

`test/helpers.ts::applyMigrations` replays `migrations/0001_init.sql` into
the per-suite D1 instance so each test file starts from a fresh schema.

## Phase 2 (deferred)

- `auth-worker` MCP JWT minting end-to-end (mirrors `auth-worker/src/lib/mcp-jwt.ts`).
- `wrangler.toml [env.staging]` once `wrangler d1 create ref_files` runs.
- Real-content full-text search on `revisions` (Phase 1 is SQL `LIKE` on path + name only).
