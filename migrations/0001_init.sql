-- ref-files-worker: D1 initial schema.
--
-- 4 tables matching `ref-files-mcp-server-rs/src/types/`:
--   repos      — (owner_login, name) — top-level container
--   folders    — hierarchical, `path` denormalized for cheap lookups
--   files      — logical file + pointer to current revision (soft delete)
--   revisions  — append-only history (R2 key, sha256, author, message)
--
-- All `id` columns are UUIDv4 strings (`crypto.randomUUID()` in the worker).
-- All timestamps are RFC 3339 strings — D1 has no native datetime and we want
-- the JSON wire-format to be the same as the DB value.

CREATE TABLE repos (
  id TEXT PRIMARY KEY NOT NULL,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_login, name)
);

CREATE INDEX idx_repos_owner ON repos (owner_login);

CREATE TABLE folders (
  id TEXT PRIMARY KEY NOT NULL,
  repo_id TEXT NOT NULL,
  -- NULL for the implicit root row (path = "").
  parent_id TEXT,
  name TEXT NOT NULL,
  -- POSIX-style, no leading slash. Root = "".
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos (id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE,
  UNIQUE (repo_id, path)
);

CREATE INDEX idx_folders_repo_parent ON folders (repo_id, parent_id);

CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL,
  repo_id TEXT NOT NULL,
  -- NULL → file lives at repo root.
  folder_id TEXT,
  name TEXT NOT NULL,
  -- Denormalized `folder.path + "/" + name`. Updated on rename / move.
  path TEXT NOT NULL,
  -- Points at the latest revision. May be the deleted row's id immediately
  -- after `file_delete` — clients should check `deleted_at` first.
  current_revision_id TEXT NOT NULL,
  current_revision_number INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- RFC 3339 when soft-deleted, NULL for live files.
  deleted_at TEXT,
  FOREIGN KEY (repo_id) REFERENCES repos (id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE SET NULL,
  UNIQUE (repo_id, path)
);

CREATE INDEX idx_files_repo_folder ON files (repo_id, folder_id);
CREATE INDEX idx_files_path_search ON files (repo_id, path);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL,
  rev_number INTEGER NOT NULL,
  -- R2 key. `files/{repo_id}/{file_id}/{rev_number}`.
  blob_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- Lowercase hex sha-256 of the raw (pre-base64) bytes.
  sha256 TEXT NOT NULL,
  mime TEXT,
  -- GitHub login resolved from MCP JWT.
  author_login TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
  UNIQUE (file_id, rev_number)
);

CREATE INDEX idx_revisions_file ON revisions (file_id, rev_number DESC);
