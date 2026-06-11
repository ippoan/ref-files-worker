---
name: ref-files-worker-map
generated-from: ref-files-worker:3bd2f2a21875d5172e5f412921f755bf881f96d5
paths: [src/, migrations/]
description: ippoan/ref-files-worker (Cloudflare Workers + Hono、参照ファイル/spec 保管庫の HTTP+MCP facade) の構造ナビゲーション。D1 メタ (repos/folders/files/revisions, Drizzle) + R2 blob + pre-signed upload/download + bulk-upload Workflow + durable `/mcp` (DO+WS) の配置と gotcha を 1 枚にまとめる。トリガー:「ref-files-worker」「ref-files」「folder_download_url」「file_put / file_get」「bulk_upload」「RefFilesMcp」「pre-signed upload」「ref-files.ippoan.org」「/ui CF Access」等。
---

# ref-files-worker-map — ippoan/ref-files-worker 構造ナビゲーション

Cloudflare Workers (Hono) ベース。ref-files MCP toolset の HTTP facade。
**D1 メタ (repos/folders/files/revisions, Drizzle) + R2 blob** を保管し、
`/mcp` (durable DO+WS) と `/v1/*` (REST) で同じ business logic を露出する。
各 `/v1/*` route が MCP tool と 1:1 対応。

> 細部 (関数シグネチャ・正確な行) は repo 側が正。ここは「どこを見るか」の索引。
> frontmatter の `generated-from` が現在の tree-sha とズレたら
> session-start-skill-coverage hook が再生成を促す → その時 tree-sha を更新する。

## 区画

| module | 主要ファイル | 役割 |
|---|---|---|
| **entry** | `src/index.ts` | path 分岐: `/mcp` → durable (DO+WS)、それ以外 → Hono `app`。DO/Workflow export |
| **Hono 合成** | `src/app.ts` | middleware + sub-app mount のみ。handler は `routes/` に分離 |
| **durable MCP** | `src/durable.ts` (`RefFilesMcp` DO) | agents SDK McpAgent ベース `/mcp` transport。`src/routes/mcp.ts` の `registerTools` を消費 |
| **REST routes** | `src/routes/{repos,folders,files,inventory,uploads}.ts` | `/v1/*` JWT surface + pre-signed `/upload|/download/:token` |
| **human UI** | `src/routes/admin.tsx` | `/ui/*` (CF Access gated) |
| **D1 schema** | `src/db/schema.ts` `src/db/index.ts` | Drizzle schema (repos/folders/files/revisions)。`migrations/` が canonical |
| **auth** | `src/middleware/auth.ts` (`mcpAuth`) `middleware/cf-access.ts` `handlers/mcp-introspect.ts` `lib/jwt.ts` `lib/cf-access-jwt.ts` | HS256 JWT (`/v1`) / CF Access (`/ui`) / RFC7662 introspect |
| **lib** | `src/lib/{repo-ops,tar,hash,path,upload-token}.ts` | repo 操作 / tar / pre-signed token |
| **Workflow** | `src/workflows/bulk-upload.ts` (`BulkUploadWorkflow`) | folder tar.gz の per-file commit を request 外で durably 実行 |

### MCP tools (`src/routes/mcp.ts` の `registerTools`)

`repo_init` `repos_list` `folder_create` `folder_list` `folder_download_url`
`file_put` `file_upload_url` `folder_upload_url` `bulk_upload_status`
`file_get` `file_history` `file_move` `file_delete` `file_search` `inventory`

## entrypoint (`src/index.ts` + `src/app.ts`)

- `src/index.ts`: `url.pathname === "/mcp"` → `mcpFetch` (DO+WS)、それ以外 → `app.fetch`。`export { RefFilesMcp, BulkUploadWorkflow }`
- `src/app.ts` mount: `GET /health` (no auth) / `POST /mcp/introspect` (自前 auth) / `/upload|/download/:token` (pre-signed, JWT 無し) / `/v1/*` (`mcpAuth` JWT) → repos/folders/files/inventory / `/ui/*` (`cfAccess`) → admin

## gotcha (README / wrangler.toml / drizzle.config 由来)

- **D1 schema は `src/db/schema.ts` (Drizzle) が SoT**。手書き migration はやめ、`drizzle-kit generate` で `migrations/*.sql` + `meta/` を生成。**prod 適用は CF API token に D1:Edit が要る → CI ではなく開発者 workstation から** (`npm run d1:migrate:prod`)。
- **`compatibility_date = "2025-05-01"` + `nodejs_compat`**: agents SDK (durable MCP) が `mimetext`→`mime-types` の bare `require("path")` を引くため。旧日付だと "Could not resolve 'path'" で build fail。
- **`PUBLIC_ORIGIN` を pin** (`https://ref-files.ippoan.org`): DO は内部 dispatch で `https://ref-files.internal/...` を使うため `c.req.url` から origin を導くと到達不能 host を leak する (Refs #33)。
- **`MCP_JWT_AUDIENCE = "*"`**: connector が mint する `aud` が経路で変わる (RFC 8707 resource 送信有無) ため固定 aud に pin しない。identity は `github_login`、署名 (共有鍵) が auth-worker mint を保証。confused-deputy は secrets-inventory#43 の許容範囲。
- **`AUTH_WORKER_ORIGIN = auth-staging.ippoan.org`**: ippoan の MCP エコシステムは staging auth-worker 運用 (prod は `v*` tag でしか deploy されない)。allowlist 追加が即反映されるのは staging 側。
- **INTERNAL_SHARED_SECRET / MCP_JWT_SECRET は同一 Secrets Store entry を 2 binding で受ける** (role 分離だが値は drift しない)。
- **single-env**: `ref-files-staging.ippoan.org` は廃止、`ref-files.ippoan.org` 1 本 (Refs #6)。
- **`/ui/*` は CF Access (Zero Trust SSO)** で守る (`/v1/*` の MCP JWT とは別系統)。`CF_ACCESS_AUD` は dashboard で発行される application AUD tag。

## CCoW / CI から見た立ち位置

- **spec / 往復メール / 参照ファイルの保管庫**。`ref-files-bulk` skill が `folder_download_url` で folder を tar.gz 一括取得、`eml-read` が .eml を decode する相補関係。
- MCP auth は **auth-worker** mint の HS256 JWT を**ローカル検証** (introspect 往復ゼロ)。`/mcp` は claude.ai connector / Claude Code から接続。

## 関連 skill

- `ref-files-bulk` — `folder_download_url` で一括取得 (token 節約)
- `eml-read` — ref-files から落とした .eml の decode
- `auth-worker-map` — JWT mint 元 / resource metadata allowlist
- `worker-vitest` / `cross-repo-symbol-index` — テスト / 鮮度 hook
