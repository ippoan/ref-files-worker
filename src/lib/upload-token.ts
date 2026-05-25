/**
 * Token helpers for the pre-signed upload / download endpoints.
 *
 * Token: 32 random bytes encoded as 43-char url-safe base64. Stored as the
 * primary key of `pending_uploads`. Random-only (no HMAC) is safe because
 * lookups go through D1 and the row carries the authoritative repo / path
 * / owner — there's nothing for an attacker to forge offline.
 */
import { and, eq } from "drizzle-orm";

import type { DB } from "../db";
import { pendingUploads } from "../db/schema";

export type PendingKind = "single" | "tar_gz" | "download";

const TOKEN_BYTES = 32;
const DEFAULT_TTL_SEC = 600; // 10 min

export function newToken(): string {
  const buf = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(buf);
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export interface IssueArgs {
  kind: PendingKind;
  repoId: string;
  path: string;
  mime?: string | null;
  message?: string | null;
  revision?: number | null;
  ownerLogin: string;
  ttlSec?: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

export async function issueToken(handle: DB, args: IssueArgs): Promise<IssuedToken> {
  const token = newToken();
  const now = new Date();
  const exp = new Date(now.getTime() + (args.ttlSec ?? DEFAULT_TTL_SEC) * 1000);
  await handle.insert(pendingUploads).values({
    token,
    kind: args.kind,
    repoId: args.repoId,
    path: args.path,
    mime: args.mime ?? null,
    message: args.message ?? null,
    revision: args.revision ?? null,
    ownerLogin: args.ownerLogin,
    createdAt: now.toISOString(),
    expiresAt: exp.toISOString(),
    consumedAt: null,
  }).run();
  return { token, expiresAt: exp.toISOString() };
}

export interface LoadedToken {
  token: string;
  kind: PendingKind;
  repoId: string;
  path: string;
  mime: string | null;
  message: string | null;
  revision: number | null;
  ownerLogin: string;
  expiresAt: string;
  consumedAt: string | null;
}

export type LoadResult =
  | { ok: true; row: LoadedToken }
  | { ok: false; reason: "not_found" | "expired" | "consumed" };

export async function loadToken(handle: DB, token: string): Promise<LoadResult> {
  const rows = await handle
    .select()
    .from(pendingUploads)
    .where(eq(pendingUploads.token, token))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.consumedAt) return { ok: false, reason: "consumed" };
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    row: {
      token: row.token,
      kind: row.kind as PendingKind,
      repoId: row.repoId,
      path: row.path,
      mime: row.mime,
      message: row.message,
      revision: row.revision,
      ownerLogin: row.ownerLogin,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    },
  };
}

export async function markConsumed(handle: DB, token: string): Promise<void> {
  await handle
    .update(pendingUploads)
    .set({ consumedAt: new Date().toISOString() })
    .where(and(eq(pendingUploads.token, token)))
    .run();
}

/**
 * Build an absolute upload/download URL using the inbound request's origin.
 * Falls back to the path-only form when no origin is supplied (test runs
 * against `worker.fetch(new Request("https://x/..."))`).
 */
export function buildUploadUrl(origin: string, token: string): string {
  if (!origin) return `/upload/${token}`;
  return `${origin.replace(/\/$/, "")}/upload/${token}`;
}

export function buildDownloadUrl(origin: string, token: string): string {
  if (!origin) return `/download/${token}`;
  return `${origin.replace(/\/$/, "")}/download/${token}`;
}
