import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyMigrations, authHeader } from "./helpers";

beforeAll(applyMigrations);

const ctx = {} as ExecutionContext;

describe("repo_init", () => {
  it("creates a repo and returns 201", async () => {
    const res = await worker.fetch(
      new Request("https://x/v1/repos", {
        method: "POST",
        headers: authHeader({ github_login: "alice" }),
        body: JSON.stringify({ name: "mynotes" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; owner_login: string; name: string };
    expect(body.owner_login).toBe("alice");
    expect(body.name).toBe("mynotes");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is idempotent on (owner, name)", async () => {
    const headers = authHeader({ github_login: "alice" });
    const r1 = await worker.fetch(
      new Request("https://x/v1/repos", { method: "POST", headers, body: JSON.stringify({ name: "shared" }) }),
      env,
      ctx,
    );
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { id: string };
    const r2 = await worker.fetch(
      new Request("https://x/v1/repos", { method: "POST", headers, body: JSON.stringify({ name: "shared" }) }),
      env,
      ctx,
    );
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { id: string };
    expect(b2.id).toBe(b1.id);
  });

  it("isolates by github_login", async () => {
    const a = await worker.fetch(
      new Request("https://x/v1/repos", {
        method: "POST",
        headers: authHeader({ github_login: "alice" }),
        body: JSON.stringify({ name: "iso" }),
      }),
      env,
      ctx,
    );
    const b = await worker.fetch(
      new Request("https://x/v1/repos", {
        method: "POST",
        headers: authHeader({ github_login: "bob" }),
        body: JSON.stringify({ name: "iso" }),
      }),
      env,
      ctx,
    );
    const aBody = (await a.json()) as { id: string };
    const bBody = (await b.json()) as { id: string };
    expect(aBody.id).not.toBe(bBody.id);
  });

  it("rejects bad repo names", async () => {
    const res = await worker.fetch(
      new Request("https://x/v1/repos", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ name: "Bad Name!" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
