/**
 * Durable bulk-upload Workflow (Refs #33).
 *
 * Motivation: `folder_upload_url` issues a pre-signed `PUT /upload/:token`
 * that does **not** go through the durable `/mcp` Durable Object — it is a
 * plain synchronous Hono request. The old handler buffered the whole tar.gz
 * and committed every entry (D1 + R2) inline, ~1.5s/file. For a 42-file /
 * 8MB bundle that exceeds the client HTTP timeout (60s), the connection drops
 * mid-commit, `markConsumed` never runs, and the upload lands partially
 * (observed: 37/42). Nothing about the DO/WS transport helped, because the
 * heavy work never touched it.
 *
 * Fix: `PUT /upload/:token` now stages the raw archive in R2 and triggers an
 * instance of this Workflow, returning `202 { workflow_id }` immediately. The
 * commit loop runs here — off the request lifecycle, with each batch as a
 * durably-checkpointed `step.do` that is retried independently on failure.
 * `commitTarEntry(skipIfSameSha)` keeps a retried batch idempotent (no
 * duplicate revisions for files an earlier attempt already committed). The
 * caller polls completion via the `bulk_upload_status` MCP tool.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { db } from "../db";
import type { Env } from "../env";
import { parseTarGz } from "../lib/tar";
import { markConsumed } from "../lib/upload-token";
import { commitTarEntry } from "../routes/uploads";
import type {
  BulkUploadFileResult,
  BulkUploadOutput,
  BulkUploadParams,
} from "./types";

/** Files committed per durable step — bounds step-output size + retry blast radius. */
const BATCH = 8;

export class BulkUploadWorkflow extends WorkflowEntrypoint<Env, BulkUploadParams> {
  async run(event: WorkflowEvent<BulkUploadParams>, step: WorkflowStep): Promise<BulkUploadOutput> {
    const { token, repoId, basePath, ownerLogin, message, stagingKey } = event.payload;
    const handle = db(this.env);

    // Manifest pass: how many entries does the staged archive hold? Memoised
    // so batch bounds stay stable across any later replay.
    const total = await step.do("parse-manifest", async () => {
      const entries = await this.loadEntries(stagingKey);
      return entries.length;
    });

    const files: BulkUploadFileResult[] = [];
    for (let start = 0; start < total; start += BATCH) {
      const end = Math.min(start + BATCH, total);
      const batch = await step.do(`commit-${start}-${end}`, async () => {
        // Re-read + re-parse inside the step so it is fully self-contained and
        // safe to retry. tar order is deterministic, so index `i` is stable.
        const entries = await this.loadEntries(stagingKey);
        const out: BulkUploadFileResult[] = [];
        for (let i = start; i < end; i++) {
          const committed = await commitTarEntry(handle, this.env, {
            entry: entries[i],
            basePath,
            repoId,
            message,
            ownerLogin,
            skipIfSameSha: true,
          });
          if (committed) out.push(committed);
        }
        return out;
      });
      files.push(...batch);
    }

    await step.do("finalize", async () => {
      await markConsumed(handle, token);
      await this.env.BLOBS.delete(stagingKey);
    });

    return { count: files.length, files };
  }

  private async loadEntries(stagingKey: string) {
    const obj = await this.env.BLOBS.get(stagingKey);
    if (!obj) throw new Error(`staging_blob_missing: ${stagingKey}`);
    return parseTarGz(obj.body);
  }
}
