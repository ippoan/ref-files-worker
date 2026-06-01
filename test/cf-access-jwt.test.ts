/**
 * Real RS256 verification of `verifyAccessJwt` — exercises the production
 * path (`WORKER_ENV=test` bypass is NOT involved here; we call the verifier
 * directly). We generate an in-process RSA keypair, publish its public half
 * as a JWKS via a stubbed `fetch`, and sign assertions with the private half.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccessVerifyError, verifyAccessJwt } from "../src/lib/cf-access-jwt";

const TEAM = "ippoan.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "test-app-aud";
const KID = "unit-kid-1";

let privateKey: CryptoKey;
// JWKS entry: a JsonWebKey plus the `kid` Access matches on. Typed loosely
// because `wrangler types`' generated `JsonWebKey` has no `kid` field (and
// `exportKey("jwk")` resolves to `JsonWebKey | ArrayBuffer`), which would trip
// excess-property / union checks if we annotated it as `JsonWebKey`.
let jwk: Record<string, unknown>;

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signJwt(
  payload: Record<string, unknown>,
  opts: { alg?: string; kid?: string; sign?: boolean } = {},
): Promise<string> {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? KID };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  if (opts.sign === false) return `${h}.${p}.badsignature`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(`${h}.${p}`),
    ),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

function validPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "user@ippoan.org",
    sub: "access-sub-xyz",
    aud: [AUD],
    iss: ISS,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

function stubJwks(keys: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ keys }), { status: ok ? 200 : 500 }),
    ),
  );
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  jwk = { ...pub, kid: KID, alg: "RS256" };
});

afterEach(() => vi.unstubAllGlobals());

describe("verifyAccessJwt — happy path", () => {
  it("verifies a well-formed assertion and returns the email", async () => {
    stubJwks([jwk]);
    const token = await signJwt(validPayload());
    const claims = await verifyAccessJwt(token, TEAM, AUD);
    expect(claims.email).toBe("user@ippoan.org");
    expect(claims.sub).toBe("access-sub-xyz");
    expect(claims.aud).toContain(AUD);
  });

  it("accepts a bare team domain without the https:// scheme", async () => {
    stubJwks([jwk]);
    const token = await signJwt(validPayload());
    const claims = await verifyAccessJwt(token, TEAM, AUD);
    expect(claims.iss).toBe(ISS);
  });
});

describe("verifyAccessJwt — rejection paths", () => {
  const cases: { name: string; build: () => Promise<string>; reason: string }[] = [
    { name: "wrong number of segments", build: async () => "a.b", reason: "shape" },
    { name: "non-RS256 alg", build: () => signJwt(validPayload(), { alg: "HS256" }), reason: "alg" },
    { name: "missing kid", build: () => signJwt(validPayload(), { kid: "" }), reason: "kid" },
    { name: "kid not in JWKS", build: () => signJwt(validPayload(), { kid: "other-kid" }), reason: "unknown_kid" },
    { name: "bad signature", build: () => signJwt(validPayload(), { sign: false }), reason: "signature" },
    { name: "expired", build: () => signJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 120 })), reason: "expired" },
    { name: "wrong issuer", build: () => signJwt(validPayload({ iss: "https://evil.cloudflareaccess.com" })), reason: "issuer" },
    { name: "wrong audience", build: () => signJwt(validPayload({ aud: ["someone-else"] })), reason: "audience" },
    { name: "missing email", build: () => signJwt(validPayload({ email: undefined })), reason: "email" },
    { name: "missing sub", build: () => signJwt(validPayload({ sub: undefined })), reason: "sub" },
  ];

  for (const { name, build, reason } of cases) {
    it(`rejects: ${name} → ${reason}`, async () => {
      stubJwks([jwk]);
      const token = await build();
      await expect(verifyAccessJwt(token, TEAM, AUD)).rejects.toMatchObject({ reason });
    });
  }

  it("rejects when the JWKS endpoint errors", async () => {
    stubJwks([jwk], false);
    // Use a fresh team domain so the 1h JWKS cache from earlier tests misses.
    const token = await signJwt(validPayload({ iss: "https://fresh.cloudflareaccess.com" }));
    await expect(
      verifyAccessJwt(token, "fresh.cloudflareaccess.com", AUD),
    ).rejects.toBeInstanceOf(AccessVerifyError);
  });

  it("rejects a header that isn't valid JSON", async () => {
    stubJwks([jwk]);
    const bad = `${b64url("{not json")}.${b64url(JSON.stringify(validPayload()))}.sig`;
    await expect(verifyAccessJwt(bad, TEAM, AUD)).rejects.toMatchObject({ reason: "header_parse" });
  });
});
