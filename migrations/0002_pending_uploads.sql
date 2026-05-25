-- ref-files-worker: pending uploads for pre-signed URL flow.
--
-- The "upload init" endpoints (`POST /v1/files/upload-init`,
-- `POST /v1/files/bulk-upload-init`) issue a random token and store the
-- caller-supplied metadata here. The raw upload endpoint
-- (`PUT /upload/:token`, no JWT) looks the row up, validates expiry, and
-- commits the resulting revision rows. Token is consumed on success
-- (`consumed_at` set) but the row is kept for a short window so the same
-- PUT replayed within expiry returns the same result (idempotent enough).
--
-- Same idea covers downloads: `GET /v1/files/download-url` issues a token,
-- `GET /download/:token` streams the R2 blob without JWT. Downloads have
-- no payload so a stateless HMAC token would also work, but reusing the
-- table keeps revocation simple (delete the row to revoke).

CREATE TABLE pending_uploads (
  token TEXT PRIMARY KEY NOT NULL,
  -- "single" | "tar_gz" | "download"
  kind TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- For "single": target path. For "tar_gz": base path (often "" = repo root).
  -- For "download": file path the link resolves to.
  path TEXT NOT NULL,
  -- "single" / "tar_gz" only: optional mime override / commit message.
  mime TEXT,
  message TEXT,
  -- "download" only: specific revision number to serve (NULL = current).
  revision INTEGER,
  -- The JWT subject that issued the token. Used to keep the upload bound
  -- to the same identity at consume-time even though the consume endpoint
  -- itself is JWT-less.
  owner_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- RFC 3339 timestamp when the upload PUT / download GET completed.
  -- Reused PUTs within expiry see `consumed_at` and short-circuit to 409.
  consumed_at TEXT,
  FOREIGN KEY (repo_id) REFERENCES repos (id) ON DELETE CASCADE
);

CREATE INDEX idx_pending_uploads_expiry ON pending_uploads (expires_at);
