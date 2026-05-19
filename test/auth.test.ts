/**
 * Auth middleware contract. Phase 1 verifies HS256 against `MCP_JWT_SECRET`;
 * the test env runs without that secret to keep fixtures cheap, so we cover
 * the signed path with a unit-level call into `verifyMcpJwt` instead of
 * piping a real signature through the worker entrypoint.
 */
import { describe, expect, it } from "vitest";
import { JwtVerifyError, verifyMcpJwt } from "../src/lib/jwt";
import worker from "../src/index";
import { env } from "cloudflare:test";

const AUD = "https://ref-files.test.invalid";

function b64url(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signHs256(headerB64: string, payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    ),
  );
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function mintSigned(secret: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: "u-1",
      github_login: "alice",
      scope: "mcp.write",
      aud: AUD,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    }),
  );
  const sig = await signHs256(header, payload, secret);
  return `${header}.${payload}.${sig}`;
}

describe("verifyMcpJwt", () => {
  it("accepts a valid HS256 token", async () => {
    const tok = await mintSigned("s3cret");
    const claims = await verifyMcpJwt(tok, "s3cret", AUD);
    expect(claims.github_login).toBe("alice");
  });

  it("rejects a wrong signature", async () => {
    const tok = await mintSigned("s3cret");
    await expect(verifyMcpJwt(tok, "different", AUD)).rejects.toBeInstanceOf(JwtVerifyError);
  });

  it("rejects an expired token", async () => {
    const tok = await mintSigned("s3cret", { exp: Math.floor(Date.now() / 1000) - 600 });
    await expect(verifyMcpJwt(tok, "s3cret", AUD)).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects a wrong audience", async () => {
    const tok = await mintSigned("s3cret", { aud: "https://other.invalid" });
    await expect(verifyMcpJwt(tok, "s3cret", AUD)).rejects.toMatchObject({ reason: "audience" });
  });

  it("rejects an unsigned (alg=none) token", async () => {
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ sub: "x", github_login: "x", aud: AUD, exp: Math.floor(Date.now() / 1000) + 60 }));
    await expect(verifyMcpJwt(`${header}.${payload}.`, "s3cret", AUD)).rejects.toMatchObject({ reason: "alg" });
  });

  it("rejects shape errors", async () => {
    await expect(verifyMcpJwt("not.even.a.jwt", "s3cret", AUD)).rejects.toMatchObject({
      reason: "shape",
    });
  });
});

describe("worker /health & /v1 gating", () => {
  it("/health is unauthenticated", async () => {
    const res = await worker.fetch(new Request("https://x/health"), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; env: string };
    expect(body.ok).toBe(true);
    expect(body.env).toBe("test");
  });

  it("/v1/* without Authorization is 401", async () => {
    const res = await worker.fetch(
      new Request("https://x/v1/repos", { method: "POST" }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});
