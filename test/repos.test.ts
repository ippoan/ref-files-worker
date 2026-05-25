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

describe("repos_list", () => {
  it("returns only repos owned by the authenticated user", async () => {
    // alice has 2 repos, bob has 1.
    const h1 = authHeader({ github_login: "rl-alice" });
    const h2 = authHeader({ github_login: "rl-bob" });
    for (const name of ["one", "two"]) {
      await worker.fetch(
        new Request("https://x/v1/repos", { method: "POST", headers: h1, body: JSON.stringify({ name }) }),
        env,
        ctx,
      );
    }
    await worker.fetch(
      new Request("https://x/v1/repos", { method: "POST", headers: h2, body: JSON.stringify({ name: "carol" }) }),
      env,
      ctx,
    );

    const res = await worker.fetch(
      new Request("https://x/v1/repos", { headers: h1 }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: { id: string; owner_login: string; name: string }[] };
    const names = body.repos.map((r) => r.name).sort();
    expect(names).toEqual(["one", "two"]);
    for (const r of body.repos) {
      expect(r.owner_login).toBe("rl-alice");
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("returns an empty list for a user with no repos", async () => {
    const res = await worker.fetch(
      new Request("https://x/v1/repos", { headers: authHeader({ github_login: "rl-nobody" }) }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });
});

describe("ensureRepoOwned hint on name-shaped repo_id", () => {
  it("attaches { hint: { resolved_id, name } } when caller passed a name instead of the UUID", async () => {
    const headers = authHeader({ github_login: "hint-alice" });
    const init = await worker.fetch(
      new Request("https://x/v1/repos", { method: "POST", headers, body: JSON.stringify({ name: "skills" }) }),
      env,
      ctx,
    );
    const { id: realId } = (await init.json()) as { id: string };

    // Pass the name as repo_id — this is the footgun we want to catch.
    const res = await worker.fetch(
      new Request("https://x/v1/folders?repo_id=skills", { headers }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; reason?: string; hint?: { resolved_id: string; name: string } };
    expect(body.error).toBe("not_found");
    expect(body.reason).toBe("repo");
    expect(body.hint).toEqual({ resolved_id: realId, name: "skills" });
  });

  it("does NOT leak hints across owners", async () => {
    const ownerHeaders = authHeader({ github_login: "hint-owner" });
    await worker.fetch(
      new Request("https://x/v1/repos", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "private" }) }),
      env,
      ctx,
    );
    // A different user probes the same name — must not get a hint back.
    const res = await worker.fetch(
      new Request("https://x/v1/folders?repo_id=private", {
        headers: authHeader({ github_login: "hint-snooper" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; hint?: unknown };
    expect(body.error).toBe("not_found");
    expect(body.hint).toBeUndefined();
  });
});
