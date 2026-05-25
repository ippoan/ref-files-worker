/**
 * Drizzle schema — mirrors `migrations/0001_init.sql`.
 *
 * The SQL file is the canonical migration applied to D1; this schema lives
 * alongside it so Drizzle can produce type-safe queries. Keep them in sync
 * by hand for Phase 1; if drift becomes a problem we'll switch to
 * `drizzle-kit generate` as the source of truth and emit the SQL from here.
 *
 * Row shapes deliberately match `ref-files-mcp-server-rs/src/types/`
 * (the ts-rs-generated DTOs land under `src/types/` here), so query results
 * can be returned to the MCP server without remapping.
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable(
  "repos",
  {
    id: text("id").primaryKey().notNull(),
    ownerLogin: text("owner_login").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    ownerNameUq: uniqueIndex("repos_owner_name_uq").on(t.ownerLogin, t.name),
    ownerIdx: index("idx_repos_owner").on(t.ownerLogin),
  }),
);

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey().notNull(),
    repoId: text("repo_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    path: text("path").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    repoPathUq: uniqueIndex("folders_repo_path_uq").on(t.repoId, t.path),
    repoParentIdx: index("idx_folders_repo_parent").on(t.repoId, t.parentId),
  }),
);

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey().notNull(),
    repoId: text("repo_id").notNull(),
    folderId: text("folder_id"),
    name: text("name").notNull(),
    path: text("path").notNull(),
    currentRevisionId: text("current_revision_id").notNull(),
    currentRevisionNumber: integer("current_revision_number").notNull(),
    size: integer("size").notNull(),
    mime: text("mime"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => ({
    repoPathUq: uniqueIndex("files_repo_path_uq").on(t.repoId, t.path),
    repoFolderIdx: index("idx_files_repo_folder").on(t.repoId, t.folderId),
    pathSearchIdx: index("idx_files_path_search").on(t.repoId, t.path),
  }),
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey().notNull(),
    fileId: text("file_id").notNull(),
    revNumber: integer("rev_number").notNull(),
    blobKey: text("blob_key").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    mime: text("mime"),
    authorLogin: text("author_login").notNull(),
    message: text("message"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    fileRevUq: uniqueIndex("revisions_file_rev_uq").on(t.fileId, t.revNumber),
    // descending index: file_history walks newest-first
    fileIdx: index("idx_revisions_file").on(t.fileId, sql`${t.revNumber} DESC`),
  }),
);

export type Repo = typeof repos.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type Revision = typeof revisions.$inferSelect;

/**
 * Pre-signed upload / download token tracking. Mirrors
 * `migrations/0002_pending_uploads.sql`.
 *
 * One row per outstanding `upload_url` / `download_url`. Issued by the
 * JWT-protected `*-init` endpoints, consumed by the JWT-less
 * `PUT /upload/:token` / `GET /download/:token`. `consumed_at` flips on
 * success so replays return 409 instead of duplicating revisions.
 */
export const pendingUploads = sqliteTable(
  "pending_uploads",
  {
    token: text("token").primaryKey().notNull(),
    kind: text("kind").notNull(),
    repoId: text("repo_id").notNull(),
    path: text("path").notNull(),
    mime: text("mime"),
    message: text("message"),
    revision: integer("revision"),
    ownerLogin: text("owner_login").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (t) => ({
    expiryIdx: index("idx_pending_uploads_expiry").on(t.expiresAt),
  }),
);

export type PendingUpload = typeof pendingUploads.$inferSelect;
