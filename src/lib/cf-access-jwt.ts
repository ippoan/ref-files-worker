/**
 * Cloudflare Access JWT verifier — for the human-facing `/ui/*` surface.
 *
 * Unlike `lib/jwt.ts` (HS256, machine-to-machine secret shared with
 * auth-worker), Access mints an **RS256** assertion signed by the team's
 * rotating keypair. We pull the public JWKS from
 * `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, match on
 * `kid`, and verify with Web Crypto (`RSASSA-PKCS1-v1_5` / SHA-256).
 *
 * Verified claims:
 *   - alg pinned to RS256
 *   - signature verified against the JWKS key whose `kid` matches the header
 *   - iss === `https://<team>.cloudflareaccess.com`
 *   - aud contains the Access Application AUD tag (`CF_ACCESS_AUD`)
 *   - exp > now (30s skew)
 *
 * The verified `email` becomes the request's Access identity. JWKS responses
 * are cached per team domain for `JWKS_TTL_MS` so each request doesn't re-fetch.
 */

const SKEW_SECONDS = 30;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h — Access rotates keys slowly.

export interface AccessClaims {
  /** Verified end-user email (the `email` claim). */
  email: string;
  /** Subject — Access user UUID. */
  sub: string;
  aud: string[];
  iss: string;
  exp: number;
}

export class AccessVerifyError extends Error {
  constructor(public readonly reason: string) {
    super("cf_access_verify_failed");
  }
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

const jwksCache = new Map<string, JwksCacheEntry>();

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

/** `https://<team>.cloudflareaccess.com` from a bare team domain or full URL. */
function teamIssuer(teamDomain: string): string {
  const trimmed = teamDomain.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

async function fetchJwks(teamDomain: string): Promise<Jwk[]> {
  const issuer = teamIssuer(teamDomain);
  const cached = jwksCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessVerifyError("jwks_fetch");
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
  return keys;
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string,
): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessVerifyError("shape");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlToString(headerB64));
  } catch {
    throw new AccessVerifyError("header_parse");
  }
  if (header.alg !== "RS256") throw new AccessVerifyError("alg");
  if (!header.kid) throw new AccessVerifyError("kid");

  const keys = await fetchJwks(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessVerifyError("unknown_kid");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sigB64),
    signingInput,
  );
  if (!ok) throw new AccessVerifyError("signature");

  let claims: { email?: string; sub?: string; aud?: string | string[]; iss?: string; exp?: number };
  try {
    claims = JSON.parse(b64urlToString(payloadB64));
  } catch {
    throw new AccessVerifyError("payload_parse");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) {
    throw new AccessVerifyError("expired");
  }
  if (claims.iss !== teamIssuer(teamDomain)) throw new AccessVerifyError("issuer");

  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.includes(expectedAud)) throw new AccessVerifyError("audience");

  if (typeof claims.email !== "string" || claims.email.length === 0) {
    throw new AccessVerifyError("email");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new AccessVerifyError("sub");
  }

  return { email: claims.email, sub: claims.sub, aud, iss: claims.iss, exp: claims.exp };
}
