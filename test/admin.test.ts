import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { accessHeader, applyMigrations, authHeader } from "./helpers";

beforeAll(applyMigrations);

const ctx = {} as ExecutionContext;

async function seed(login: string, repoName: string, path: string, text: string): Promise<void> {
  const init = await worker.fetch(
    new Request("https://x/v1/repos", {
      method: "POST",
      headers: authHeader({ github_login: login }),
      body: JSON.stringify({ name: repoName }),
    }),
    env,
    ctx,
  );
  const repoId = ((await init.json()) as { id: string }).id;
  await worker.fetch(
    new Request("https://x/v1/files", {
      method: "POST",
      headers: authHeader({ github_login: login }),
      body: JSON.stringify({ repo_id: repoId, path, content_base64: btoa(text) }),
    }),
    env,
    ctx,
  );
}

interface AdminBody {
  viewer: string;
  count: number;
  files: { owner_login: string; repo_name: string; path: string }[];
}

async function uiInventory(headers: Record<string, string>, qs = ""): Promise<Response> {
  return worker.fetch(new Request(`https://x/ui/inventory${qs}`, { headers }), env, ctx);
}

describe("GET /ui/inventory (Cloudflare Access)", () => {
  it("rejects requests without the Access assertion (401)", async () => {
    const res = await uiInventory({});
    expect(res.status).toBe(401);
    expect((await res.json()) as { reason: string }).toMatchObject({ reason: "missing_access_jwt" });
  });

  it("rejects a malformed Access assertion (401)", async () => {
    const res = await uiInventory({ "Cf-Access-Jwt-Assertion": "not-a-jwt" });
    expect(res.status).toBe(401);
  });

  it("spans every owner once Access is satisfied, and echoes the viewer", async () => {
    await seed("admin-u1", "repo1", "u1.md", "one");
    await seed("admin-u2", "repo2", "u2.md", "two");

    const res = await uiInventory(accessHeader({ email: "ops@ippoan.org" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminBody;
    expect(body.viewer).toBe("ops@ippoan.org");

    const owners = new Set(body.files.map((f) => f.owner_login));
    // Global view: both owners visible through the same request.
    expect(owners.has("admin-u1")).toBe(true);
    expect(owners.has("admin-u2")).toBe(true);
    expect(body.count).toBe(body.files.length);
  });

  it("filters by ?owner= across the global view", async () => {
    await seed("admin-only", "solo", "solo.md", "x");
    const res = await uiInventory(accessHeader(), "?owner=admin-only");
    const body = (await res.json()) as AdminBody;
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files.every((f) => f.owner_login === "admin-only")).toBe(true);
  });

  it("the MCP JWT does not unlock /ui/* (wrong credential type → 401)", async () => {
    // A valid /v1/* bearer is NOT a CF Access assertion.
    const res = await uiInventory(authHeader({ github_login: "whoever" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /ui/inventory — HTML view", () => {
  it("renders an HTML folder tree for ?format=html", async () => {
    await seed("html-u", "htmlrepo", "docs/readme.md", "hi");
    const res = await uiInventory(accessHeader(), "?format=html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("ref-files inventory");
    expect(body).toContain("htmlrepo");
    // path split into a <details> folder ("docs") + a file leaf ("readme.md")
    expect(body).toContain("<details");
    expect(body).toContain(">docs<");
    expect(body).toContain(">readme.md<");
  });

  it("renders HTML when the client sends a browser Accept header", async () => {
    const res = await uiInventory(
      { ...accessHeader(), Accept: "text/html,application/xhtml+xml" },
      "",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("?format=json forces JSON even with a browser Accept header", async () => {
    const res = await uiInventory({ ...accessHeader(), Accept: "text/html" }, "?format=json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toHaveProperty("files");
  });

  it("HTML-escapes user-derived values (no XSS via owner_login)", async () => {
    // Insert a repo + file directly with a hostile owner_login so it reaches
    // the renderer unfiltered (the /v1/* validation would normally reject it).
    const repoId = `xss-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await (env as unknown as { DB: D1Database }).DB.prepare(
      "INSERT INTO repos (id, owner_login, name, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
      .bind(repoId, "<script>alert(1)</script>", "xssrepo", now, now)
      .run();
    await (env as unknown as { DB: D1Database }).DB.prepare(
      "INSERT INTO files (id, repo_id, name, path, current_revision_id, current_revision_number, size, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(crypto.randomUUID(), repoId, "a.md", "a.md", crypto.randomUUID(), 1, 3, now, now)
      .run();

    const res = await uiInventory(accessHeader(), "?format=html");
    const body = await res.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
