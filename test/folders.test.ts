import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { applyMigrations, authHeader } from "./helpers";

beforeAll(applyMigrations);

const ctx = {} as ExecutionContext;

async function initRepo(login: string, name: string): Promise<string> {
  const res = await app.fetch(
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
    const res = await app.fetch(
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
    const list = await app.fetch(
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
    const res = await app.fetch(
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
    const res = await app.fetch(
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

describe("folder_download_url", () => {
  async function seed(login: string, repo: string): Promise<string> {
    const repoId = await initRepo(login, repo);
    const h = authHeader({ github_login: login });
    for (const [path, body] of [
      ["a/b/hello.txt", "hi"],
      ["a/b/c/deep.txt", "deeper"],
      ["a/sibling.md", "# top"],
    ] as const) {
      await app.fetch(
        new Request("https://x/v1/files", {
          method: "POST",
          headers: h,
          body: JSON.stringify({ repo_id: repoId, path, content_base64: btoa(body) }),
        }),
        env,
        ctx,
      );
    }
    return repoId;
  }

  it("issues a download-url and streams a tar.gz of the subtree", async () => {
    const repoId = await seed("alice", "fd-a");
    const h = authHeader({ github_login: "alice" });
    const issue = await app.fetch(
      new Request(`https://x/v1/folders/download-url?repo_id=${repoId}&path=a/b`, { headers: h }),
      env,
      ctx,
    );
    expect(issue.status).toBe(201);
    const body = (await issue.json()) as { download_url: string; token: string; content_type: string };
    expect(body.content_type).toBe("application/gzip");
    expect(body.download_url).toMatch(/\/download\//);

    const dl = await app.fetch(new Request(`https://x/download/${body.token}`), env, ctx);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("application/gzip");
    expect(dl.headers.get("X-File-Count")).toBe("2");
    const decompressed = dl.body!.pipeThrough(new DecompressionStream("gzip"));
    const { parseTar } = await import("../src/lib/tar");
    const tarBuf = new Uint8Array(await new Response(decompressed).arrayBuffer());
    const entries = parseTar(tarBuf);
    expect(entries.map((e) => e.name).sort()).toEqual(["c/deep.txt", "hello.txt"]);
    const map = new Map(entries.map((e) => [e.name, new TextDecoder().decode(e.bytes)]));
    expect(map.get("hello.txt")).toBe("hi");
    expect(map.get("c/deep.txt")).toBe("deeper");
  });

  it("supports root path = whole repo", async () => {
    const repoId = await seed("alice", "fd-root");
    const h = authHeader({ github_login: "alice" });
    const issue = await app.fetch(
      new Request(`https://x/v1/folders/download-url?repo_id=${repoId}&path=`, { headers: h }),
      env,
      ctx,
    );
    expect(issue.status).toBe(201);
    const { token } = (await issue.json()) as { token: string };
    const dl = await app.fetch(new Request(`https://x/download/${token}`), env, ctx);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("X-File-Count")).toBe("3");
  });

  it("404 on missing folder", async () => {
    const repoId = await initRepo("alice", "fd-missing");
    const r = await app.fetch(
      new Request(`https://x/v1/folders/download-url?repo_id=${repoId}&path=nope`, {
        headers: authHeader({ github_login: "alice" }),
      }),
      env,
      ctx,
    );
    expect(r.status).toBe(404);
  });

  it("rejects missing repo_id", async () => {
    const r = await app.fetch(
      new Request("https://x/v1/folders/download-url", { headers: authHeader() }),
      env,
      ctx,
    );
    expect(r.status).toBe(400);
  });

  it("forbids cross-owner download", async () => {
    const repoId = await seed("alice", "fd-cross");
    const r = await app.fetch(
      new Request(`https://x/v1/folders/download-url?repo_id=${repoId}&path=a`, {
        headers: authHeader({ github_login: "mallory" }),
      }),
      env,
      ctx,
    );
    expect(r.status).toBe(403);
  });

  it("token consumed after first GET", async () => {
    const repoId = await seed("alice", "fd-consume");
    const issue = await app.fetch(
      new Request(`https://x/v1/folders/download-url?repo_id=${repoId}&path=a`, {
        headers: authHeader({ github_login: "alice" }),
      }),
      env,
      ctx,
    );
    const { token } = (await issue.json()) as { token: string };
    const first = await app.fetch(new Request(`https://x/download/${token}`), env, ctx);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const second = await app.fetch(new Request(`https://x/download/${token}`), env, ctx);
    expect(second.status).toBe(410);
  });
});

describe("folder_list recursive", () => {
  it("returns nested folders + files when recursive=true", async () => {
    const repoId = await initRepo("alice", "fl-r");
    const h = authHeader({ github_login: "alice" });
    await app.fetch(
      new Request("https://x/v1/folders", { method: "POST", headers: h, body: JSON.stringify({ repo_id: repoId, path: "a/b/c" }) }),
      env,
      ctx,
    );
    await app.fetch(
      new Request("https://x/v1/files", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ repo_id: repoId, path: "a/b/hello.txt", content_base64: btoa("hi") }),
      }),
      env,
      ctx,
    );
    const r = await app.fetch(
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
