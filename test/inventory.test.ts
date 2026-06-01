import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { applyMigrations, authHeader } from "./helpers";

beforeAll(applyMigrations);

const ctx = {} as ExecutionContext;
const h = (login: string) => authHeader({ github_login: login });

async function initRepo(login: string, name: string): Promise<string> {
  const res = await app.fetch(
    new Request("https://x/v1/repos", { method: "POST", headers: h(login), body: JSON.stringify({ name }) }),
    env,
    ctx,
  );
  return ((await res.json()) as { id: string }).id;
}

async function put(repoId: string, path: string, text: string, login: string): Promise<Response> {
  return app.fetch(
    new Request("https://x/v1/files", {
      method: "POST",
      headers: h(login),
      body: JSON.stringify({ repo_id: repoId, path, content_base64: btoa(text) }),
    }),
    env,
    ctx,
  );
}

async function del(repoId: string, path: string, login: string): Promise<Response> {
  return app.fetch(
    new Request(`https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: h(login),
    }),
    env,
    ctx,
  );
}

interface InvEntry {
  repo_id: string;
  repo_name: string;
  owner_login: string;
  file_id: string;
  path: string;
  size: number;
  mime: string | null;
  revision: number;
  updated_at: string;
  deleted_at: string | null;
}

async function inventory(login: string, qs = ""): Promise<{ status: number; files: InvEntry[] }> {
  const res = await app.fetch(
    new Request(`https://x/v1/inventory${qs}`, { headers: h(login) }),
    env,
    ctx,
  );
  const body = (await res.json()) as { files?: InvEntry[] };
  return { status: res.status, files: body.files ?? [] };
}

describe("GET /v1/inventory", () => {
  it("lists files across every repo the caller owns, with repo wiring", async () => {
    const owner = "inv-alice";
    const repoA = await initRepo(owner, "notes");
    const repoB = await initRepo(owner, "specs");
    await put(repoA, "docs/intro.md", "hello", owner);
    await put(repoA, "docs/guide.md", "guide", owner);
    await put(repoB, "rfc/0001.md", "rfc", owner);

    const { status, files } = await inventory(owner);
    expect(status).toBe(200);

    // 3 files spanning 2 repos.
    expect(files.length).toBe(3);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["docs/intro.md"].repo_name).toBe("notes");
    expect(byPath["docs/intro.md"].repo_id).toBe(repoA);
    expect(byPath["rfc/0001.md"].repo_name).toBe("specs");
    expect(byPath["rfc/0001.md"].repo_id).toBe(repoB);
    for (const f of files) {
      expect(f.owner_login).toBe(owner);
      expect(f.revision).toBe(1);
      expect(f.deleted_at).toBeNull();
      expect(f.file_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("isolates by owner — never leaks another user's files", async () => {
    const repoX = await initRepo("inv-iso-x", "x");
    await put(repoX, "secret.md", "top secret", "inv-iso-x");
    const repoY = await initRepo("inv-iso-y", "y");
    await put(repoY, "mine.md", "mine", "inv-iso-y");

    const { files } = await inventory("inv-iso-y");
    expect(files.every((f) => f.owner_login === "inv-iso-y")).toBe(true);
    expect(files.some((f) => f.path === "secret.md")).toBe(false);
  });

  it("filters by ?repo=<name>", async () => {
    const owner = "inv-filter";
    const r1 = await initRepo(owner, "alpha");
    await initRepo(owner, "beta");
    await put(r1, "a.md", "a", owner);
    const rBeta = await inventory(owner, "?repo=beta");
    expect(rBeta.files.length).toBe(0);
    const rAlpha = await inventory(owner, "?repo=alpha");
    expect(rAlpha.files.map((f) => f.path)).toEqual(["a.md"]);
  });

  it("hides soft-deleted files unless ?include_deleted=true", async () => {
    const owner = "inv-del";
    const repo = await initRepo(owner, "trash");
    await put(repo, "keep.md", "k", owner);
    await put(repo, "gone.md", "g", owner);
    await del(repo, "gone.md", owner);

    const visible = await inventory(owner);
    expect(visible.files.map((f) => f.path).sort()).toEqual(["keep.md"]);

    const all = await inventory(owner, "?include_deleted=true");
    const gone = all.files.find((f) => f.path === "gone.md");
    expect(gone).toBeDefined();
    expect(gone?.deleted_at).not.toBeNull();
  });

  it("returns an empty list for a user with no files", async () => {
    const { status, files } = await inventory("inv-empty");
    expect(status).toBe(200);
    expect(files).toEqual([]);
  });

  it("requires a bearer token (401 without auth)", async () => {
    const res = await app.fetch(new Request("https://x/v1/inventory"), env, ctx);
    expect(res.status).toBe(401);
  });
});
