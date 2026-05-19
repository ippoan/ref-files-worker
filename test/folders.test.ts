import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyMigrations, authHeader } from "./helpers";

beforeAll(applyMigrations);

const ctx = {} as ExecutionContext;

async function initRepo(login: string, name: string): Promise<string> {
  const res = await worker.fetch(
    new Request("https://x/v1/repos", {
      method: "POST",
      headers: authHeader({ github_login: login }),
      body: JSON.stringify({ name }),
    }),
    env,
    ctx,
  );
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

describe("folder_create", () => {
  it("mkdir -p creates intermediate folders", async () => {
    const repoId = await initRepo("alice", "fc-a");
    const res = await worker.fetch(
      new Request("https://x/v1/folders", {
        method: "POST",
        headers: authHeader({ github_login: "alice" }),
        body: JSON.stringify({ repo_id: repoId, path: "a/b/c" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; name: string };
    expect(body.path).toBe("a/b/c");
    expect(body.name).toBe("c");

    // listing root sees `a/`.
    const list = await worker.fetch(
      new Request(`https://x/v1/folders?repo_id=${repoId}&path=`, {
        headers: authHeader({ github_login: "alice" }),
      }),
      env,
      ctx,
    );
    expect(list.status).toBe(200);
    const lb = (await list.json()) as { folders: { path: string }[] };
    expect(lb.folders.map((f) => f.path)).toEqual(["a"]);
  });

  it("rejects path traversal", async () => {
    const repoId = await initRepo("alice", "fc-b");
    const res = await worker.fetch(
      new Request("https://x/v1/folders", {
        method: "POST",
        headers: authHeader({ github_login: "alice" }),
        body: JSON.stringify({ repo_id: repoId, path: "a/../b" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("forbids access across owners", async () => {
    const repoId = await initRepo("alice", "fc-c");
    const res = await worker.fetch(
      new Request("https://x/v1/folders", {
        method: "POST",
        headers: authHeader({ github_login: "mallory" }),
        body: JSON.stringify({ repo_id: repoId, path: "x" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });
});

describe("folder_list recursive", () => {
  it("returns nested folders + files when recursive=true", async () => {
    const repoId = await initRepo("alice", "fl-r");
    const h = authHeader({ github_login: "alice" });
    await worker.fetch(
      new Request("https://x/v1/folders", { method: "POST", headers: h, body: JSON.stringify({ repo_id: repoId, path: "a/b/c" }) }),
      env,
      ctx,
    );
    await worker.fetch(
      new Request("https://x/v1/files", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ repo_id: repoId, path: "a/b/hello.txt", content_base64: btoa("hi") }),
      }),
      env,
      ctx,
    );
    const r = await worker.fetch(
      new Request(`https://x/v1/folders?repo_id=${repoId}&path=a&recursive=true`, { headers: h }),
      env,
      ctx,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      folders: { path: string }[];
      files: { path: string }[];
    };
    expect(body.folders.map((f) => f.path).sort()).toEqual(["a/b", "a/b/c"]);
    expect(body.files.map((f) => f.path)).toEqual(["a/b/hello.txt"]);
  });
});
