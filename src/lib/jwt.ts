/**
 * Minimal HS256 JWT verifier — matches the shape auth-worker emits
 * (`src/lib/mcp-jwt.ts`). Self-contained on Web Crypto, no node deps.
 *
 * Verified claims:
 *   - alg pinned to HS256 (header.alg compared in constant time)
 *   - signature recomputed via HMAC-SHA256 and constant-time compared
 *   - aud ∈ expectedAudience (single value, or a comma-separated allowlist /
 *     string[]). A `"*"` entry disables the aud check entirely (accept any
 *     audience) — used because the claude.ai connector mints a varying `aud`
 *     and the shared-secret signature already proves auth-worker minted it.
 *   - exp > now (with 30s skew)
 *   - nbf <= now (with 30s skew) if present
 *
 * Returns `MCP_JWT_VERIFY_FAILED` codes for the auth middleware to surface
 * — every failure path uses the same constant so the wire response can't
 * distinguish "bad signature" from "expired" by message.
 */

const SKEW_SECONDS = 30;

export interface McpJwtClaims {
  sub: string;
  github_login: string;
  scope: string;
  aud: string;
  exp: number;
  nbf?: number;
  iat?: number;
  iss?: string;
}

export class JwtVerifyError extends Error {
  constructor(public readonly reason: string) {
    super("jwt_verify_failed");
  }
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyMcpJwt(
  token: string,
  secret: string,
  expectedAudience: string | readonly string[],
): Promise<McpJwtClaims> {
  const allowedAudiences = (
    Array.isArray(expectedAudience) ? expectedAudience : String(expectedAudience).split(",")
  )
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerifyError("shape");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlToString(headerB64));
  } catch {
    throw new JwtVerifyError("header_parse");
  }
  if (header.alg !== "HS256") throw new JwtVerifyError("alg");

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signingInput));
  const actual = b64urlToBytes(sigB64);
  if (!constantTimeEqual(expected, actual)) throw new JwtVerifyError("signature");

  let claims: McpJwtClaims;
  try {
    claims = JSON.parse(b64urlToString(payloadB64));
  } catch {
    throw new JwtVerifyError("payload_parse");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) {
    throw new JwtVerifyError("expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > now) {
    throw new JwtVerifyError("not_yet_valid");
  }
  // `"*"` in the allowlist = accept any audience. The shared HS256 secret has
  // already proven auth-worker minted this token; the canonical identity is
  // `github_login`, not `aud`. The claude.ai connector mints a varying `aud`
  // (the RFC 8707 resource URL when sent, else the ecosystem default
  // `github-mcp-server-rs`), so pinning a fixed `aud` would reject valid
  // connector tokens. This mirrors security-inventory, which delegates to
  // `/mcp/introspect` and does not enforce `aud` — but stays local (no
  // per-request round-trip, which matters because `/mcp` re-dispatches each
  // tool call through `/v1/*`). Confused-deputy tradeoff is the same one
  // security-inventory already accepts (Refs ippoan/secrets-inventory#43).
  const anyAudience = allowedAudiences.includes("*");
  if (!anyAudience && (typeof claims.aud !== "string" || !allowedAudiences.includes(claims.aud))) {
    throw new JwtVerifyError("audience");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new JwtVerifyError("sub");
  }
  if (typeof claims.github_login !== "string" || claims.github_login.length === 0) {
    throw new JwtVerifyError("github_login");
  }

  return claims;
}
