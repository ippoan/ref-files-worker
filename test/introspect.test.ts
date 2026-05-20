/**
 * `POST /mcp/introspect` contract.
 *
 * The test env binds `INTERNAL_SHARED_SECRET=test-internal-shared-secret`
 * but no `MCP_JWT_SECRET`, so the handler's test-mode branch parses the
 * payload unsigned — the same shortcut the `/v1/*` middleware uses to
 * keep fixtures cheap. Staging / prod paths run through the real HS256
 * `verifyMcpJwt` and have separate coverage in `auth.test.ts`.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { mintToken } from "./helpers";

const SHARED = "test-internal-shared-secret";

async function post(headers: Record<string, string>, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request("https://x/mcp/introspect", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );
}

describe("POST /mcp/introspect — mode 1 (Bearer JWT)", () => {
  it("returns active:true with identity claims for a valid bearer", async () => {
    const token = mintToken({ sub: "u-42", github_login: "alice", scope: "mcp.write" });
    const res = await post({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      active: true,
      sub: "u-42",
      github_login: "alice",
      scope: "mcp.write",
      aud: "https://ref-files.test.invalid",
    });
    expect(typeof body.exp).toBe("number");
    // ref-files-worker never hands out a GitHub PAT.
    expect(body).not.toHaveProperty("github_token");
  });

  it("returns 401 when the bearer is malformed", async () => {
    const res = await post({ Authorization: "Bearer not-a-jwt" });
    expect(res.status).toBe(401);
  });

  it("does not fall back to mode 2 when a Bearer prefix is present but invalid", async () => {
    const res = await post({ Authorization: `Bearer ${SHARED}` });
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp/introspect — mode 2 (shared secret)", () => {
  it("returns active:true when the secret matches and the body token is valid", async () => {
    const token = mintToken({ sub: "u-9", github_login: "bob" });
    const res = await post({ Authorization: SHARED }, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ active: true, sub: "u-9", github_login: "bob" });
  });

  it("returns 401 when the shared secret is wrong", async () => {
    const token = mintToken({});
    const res = await post({ Authorization: "wrong-secret" }, { token });
    expect(res.status).toBe(401);
  });

  it("returns 401 when no Authorization header is sent", async () => {
    const res = await post({}, { token: mintToken({}) });
    expect(res.status).toBe(401);
  });

  it("returns 200 active:false when the body is not JSON", async () => {
    const res = await worker.fetch(
      new Request("https://x/mcp/introspect", {
        method: "POST",
        headers: { Authorization: SHARED, "Content-Type": "application/json" },
        body: "not json",
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });

  it("returns 200 active:false when the body has no token field", async () => {
    const res = await post({ Authorization: SHARED }, { not_token: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });

  it("returns 200 active:false when the body token is malformed", async () => {
    const res = await post({ Authorization: SHARED }, { token: "garbage" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });
});
