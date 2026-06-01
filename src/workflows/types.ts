/**
 * Shared params shape for the durable bulk-upload Workflow.
 *
 * Kept import-free so both `src/env.ts` (binding type) and
 * `src/workflows/bulk-upload.ts` (the entrypoint) can reference it without a
 * runtime import cycle.
 *
 * The tar.gz bytes themselves are **not** carried here — Workflow params must
 * be small/serializable, so the `PUT /upload/:token` handler stages the raw
 * archive in R2 under `stagingKey` and the Workflow reads it back per step.
 */
export interface BulkUploadParams {
  /** `pending_uploads.token` — consumed (markConsumed) once all files land. */
  token: string;
  repoId: string;
  /** Normalised base path the archive extracts under ("" = repo root). */
  basePath: string;
  ownerLogin: string;
  message: string | null;
  /** R2 key of the staged tar.gz (`uploads/staging/{token}`). */
  stagingKey: string;
}

/** One committed file in the Workflow's terminal output. */
export interface BulkUploadFileResult {
  path: string;
  file_id: string;
  revision_id: string;
  size: number;
  sha256: string;
  /** true when an identical-sha revision already existed (idempotent retry). */
  skipped: boolean;
}

export interface BulkUploadOutput {
  count: number;
  files: BulkUploadFileResult[];
}
