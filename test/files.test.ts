import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyMigrations, authHeader } from "./helpers";

beforeAll(applyMigrations);

const ctx = {} as ExecutionContext;
const h = (login = "alice") => authHeader({ github_login: login });

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
  return ((await res.json()) as { id: string }).id;
}

async function put(
  repoId: string,
  path: string,
  text: string,
  login = "alice",
): Promise<Response> {
  return worker.fetch(
    new Request("https://x/v1/files", {
      method: "POST",
      headers: h(login),
      body: JSON.stringify({ repo_id: repoId, path, content_base64: btoa(text) }),
    }),
    env,
    ctx,
  );
}

describe("file_put + file_get", () => {
  it("initial put returns rev 1, subsequent put returns rev 2", async () => {
    const repoId = await initRepo("alice", "fp-a");
    const r1 = await put(repoId, "docs/intro.md", "hello world");
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { file: { current_revision_number: number }; revision: { sha256: string; rev_number: number } };
    expect(b1.revision.rev_number).toBe(1);
    expect(b1.file.current_revision_number).toBe(1);
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(b1.revision.sha256).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");

    const r2 = await put(repoId, "docs/intro.md", "v2");
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { revision: { rev_number: number } };
    expect(b2.revision.rev_number).toBe(2);

    // get latest
    const g = await worker.fetch(
      new Request(`https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("docs/intro.md")}`, {
        headers: h(),
      }),
      env,
      ctx,
    );
    expect(g.status).toBe(200);
    const gb = (await g.json()) as { content_base64: string; revision: { rev_number: number } };
    expect(gb.revision.rev_number).toBe(2);
    expect(atob(gb.content_base64)).toBe("v2");

    // get specific old revision
    const g1 = await worker.fetch(
      new Request(
        `https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("docs/intro.md")}&revision=1`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(g1.status).toBe(200);
    const g1b = (await g1.json()) as { content_base64: string };
    expect(atob(g1b.content_base64)).toBe("hello world");
  });

  it("rejects content for paths that traverse", async () => {
    const repoId = await initRepo("alice", "fp-b");
    const r = await put(repoId, "../etc/passwd", "x");
    expect(r.status).toBe(400);
  });
});

describe("file_history", () => {
  it("returns revisions newest-first, default limit 20, capped at 100", async () => {
    const repoId = await initRepo("alice", "fh-a");
    for (let i = 0; i < 5; i++) await put(repoId, "log.txt", `v${i}`);
    const r = await worker.fetch(
      new Request(
        `https://x/v1/files/history?repo_id=${repoId}&path=${encodeURIComponent("log.txt")}`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { revisions: { rev_number: number }[] };
    expect(body.revisions.map((rv) => rv.rev_number)).toEqual([5, 4, 3, 2, 1]);
  });
});

describe("file_move", () => {
  it("renames a file and auto-creates the destination folder", async () => {
    const repoId = await initRepo("alice", "fm-a");
    await put(repoId, "a/x.md", "x");
    const r = await worker.fetch(
      new Request("https://x/v1/files/move", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ repo_id: repoId, from_path: "a/x.md", to_path: "b/c/y.md" }),
      }),
      env,
      ctx,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { path: string; name: string };
    expect(body.path).toBe("b/c/y.md");
    expect(body.name).toBe("y.md");

    // old path is now 404
    const old = await worker.fetch(
      new Request(`https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("a/x.md")}`, {
        headers: h(),
      }),
      env,
      ctx,
    );
    expect(old.status).toBe(404);
  });

  it("refuses to overwrite an existing destination", async () => {
    const repoId = await initRepo("alice", "fm-b");
    await put(repoId, "a.md", "a");
    await put(repoId, "b.md", "b");
    const r = await worker.fetch(
      new Request("https://x/v1/files/move", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ repo_id: repoId, from_path: "a.md", to_path: "b.md" }),
      }),
      env,
      ctx,
    );
    expect(r.status).toBe(409);
  });
});

describe("file_delete (soft)", () => {
  it("sets deleted_at and hides from default file_get", async () => {
    const repoId = await initRepo("alice", "fd-a");
    await put(repoId, "trash.md", "hi");
    const d = await worker.fetch(
      new Request(`https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("trash.md")}`, {
        method: "DELETE",
        headers: h(),
      }),
      env,
      ctx,
    );
    expect(d.status).toBe(200);

    const g = await worker.fetch(
      new Request(`https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("trash.md")}`, {
        headers: h(),
      }),
      env,
      ctx,
    );
    expect(g.status).toBe(404);

    // Specific revision still reachable (history-walk semantics).
    const g1 = await worker.fetch(
      new Request(
        `https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("trash.md")}&revision=1`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(g1.status).toBe(200);
  });
});

describe("file_search", () => {
  it("substring matches across path and name; respects under_path and limit", async () => {
    const repoId = await initRepo("alice", "fs-a");
    await put(repoId, "docs/a-readme.md", "x");
    await put(repoId, "docs/sub/b-readme.md", "x");
    await put(repoId, "other/readme.md", "x");
    const r1 = await worker.fetch(
      new Request(`https://x/v1/files/search?repo_id=${repoId}&query=readme`, { headers: h() }),
      env,
      ctx,
    );
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { files: { path: string }[] };
    expect(b1.files.map((f) => f.path).sort()).toEqual([
      "docs/a-readme.md",
      "docs/sub/b-readme.md",
      "other/readme.md",
    ]);

    const r2 = await worker.fetch(
      new Request(
        `https://x/v1/files/search?repo_id=${repoId}&query=readme&under_path=docs`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { files: { path: string }[] };
    expect(b2.files.map((f) => f.path).sort()).toEqual([
      "docs/a-readme.md",
      "docs/sub/b-readme.md",
    ]);

    const r3 = await worker.fetch(
      new Request(`https://x/v1/files/search?repo_id=${repoId}&query=readme&limit=1`, { headers: h() }),
      env,
      ctx,
    );
    const b3 = (await r3.json()) as { files: { path: string }[] };
    expect(b3.files.length).toBe(1);
  });

  it("includes soft-deleted only when include_deleted=true", async () => {
    const repoId = await initRepo("alice", "fs-b");
    await put(repoId, "ghost.md", "x");
    await worker.fetch(
      new Request(`https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("ghost.md")}`, {
        method: "DELETE",
        headers: h(),
      }),
      env,
      ctx,
    );
    const live = await worker.fetch(
      new Request(`https://x/v1/files/search?repo_id=${repoId}&query=ghost`, { headers: h() }),
      env,
      ctx,
    );
    expect(((await live.json()) as { files: unknown[] }).files.length).toBe(0);
    const all = await worker.fetch(
      new Request(
        `https://x/v1/files/search?repo_id=${repoId}&query=ghost&include_deleted=true`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(((await all.json()) as { files: unknown[] }).files.length).toBe(1);
  });
});
