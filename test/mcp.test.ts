/**
 * `/mcp` native Streamable HTTP endpoint.
 *
 * Drives the worker the way an MCP client would (JSON-RPC over POST /mcp) and
 * asserts that each tool delegates to the corresponding `/v1/*` route. Auth is
 * the same HS256 MCP-JWT path as `/v1/*`; in `WORKER_ENV=test` the middleware
 * trusts the unsigned payload (see test/helpers.ts).
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyMigrations, mintToken } from "./helpers";

beforeAll(applyMigrations);

const ctx = {} as ExecutionContext;

function rpc(body: unknown, login = "mcpuser"): Request {
  return new Request("https://x/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mintToken({ github_login: login })}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function readRpc(res: Response): Promise<any> {
  // enableJsonResponse + Accept: application/json → plain JSON body.
  return JSON.parse(await res.text());
}

async function callTool(name: string, args: Record<string, unknown>, login = "mcpuser") {
  const res = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, login),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  const body = await readRpc(res);
  const result = body.result;
  // The first text content block is the JSON the /v1 route returned.
  const text = result?.content?.[0]?.text;
  return { result, parsed: text ? JSON.parse(text) : undefined };
}

describe("POST /mcp (routing + auth)", () => {
  it("requires a bearer token", async () => {
    const res = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("does not shadow /mcp/introspect", async () => {
    // POST /mcp/introspect must still resolve to the RFC 7662 introspection
    // handler, not the MCP transport. A valid Bearer yields `active:true` with
    // identity claims; the MCP transport would instead return a JSON-RPC error
    // for this non-protocol body. So `active:true` proves no shadowing — and
    // that the `/mcp` mcpAuth middleware does not gate the `/mcp/introspect`
    // sub-path (which has its own auth).
    const res = await worker.fetch(
      new Request("https://x/mcp/introspect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mintToken({ sub: "u-7", github_login: "introspector" })}`,
        },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active?: boolean; github_login?: string };
    expect(body.active).toBe(true);
    expect(body.github_login).toBe("introspector");
  });
});

// The functional tool tests boot `createWorkerMcp` → `@modelcontextprotocol/sdk`'s
// `McpServer`, which eagerly imports `ajv`. `@cloudflare/vitest-pool-workers`
// (the workerd test runtime) cannot resolve ajv's nested `require("./refs/data.json")`,
// so these cannot run in-pool. The path IS exercised elsewhere:
//   - `@ippoan/mcp-cf-workers` tests `createWorkerMcp` end-to-end in node.
//   - the `/v1/*` logic each tool delegates to is covered by the suites above.
//   - mcp-cf-workers#12 verified `createWorkerMcp` on a live Cloudflare deploy.
// Production (esbuild bundle) inlines ajv normally; this is a test-runtime-only gap.
// Re-enable once the worker pool is bumped to a version that loads ajv's JSON deps.
describe.skip("POST /mcp (tools — needs node/full pool, see comment)", () => {
  it("lists all ref-files tools", async () => {
    const res = await worker.fetch(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    const names = (body.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "file_delete",
        "file_get",
        "file_history",
        "file_move",
        "file_put",
        "file_search",
        "folder_create",
        "folder_list",
        "inventory",
        "repo_init",
        "repos_list",
      ].sort(),
    );
  });

  it("repo_init → file_put → file_get round-trips through MCP", async () => {
    const init = await callTool("repo_init", { name: "mcp-roundtrip" });
    const repoId = init.parsed.id as string;
    expect(repoId).toBeTruthy();
    expect(init.parsed.owner_login).toBe("mcpuser");

    const put = await callTool("file_put", {
      repo_id: repoId,
      path: "notes/hello.txt",
      content_base64: btoa("hello mcp"),
    });
    expect(put.parsed.revision.rev_number).toBe(1);

    const get = await callTool("file_get", { repo_id: repoId, path: "notes/hello.txt" });
    expect(atob(get.parsed.content_base64)).toBe("hello mcp");
  });

  it("file_search and inventory are owner-scoped", async () => {
    const init = await callTool("repo_init", { name: "mcp-search" });
    const repoId = init.parsed.id as string;
    await callTool("file_put", {
      repo_id: repoId,
      path: "spec/egov.md",
      content_base64: btoa("egov spec"),
    });

    const search = await callTool("file_search", { repo_id: repoId, query: "egov" });
    expect(search.parsed.files.length).toBeGreaterThan(0);
    expect(search.parsed.files[0].path).toContain("egov");

    const inv = await callTool("inventory", {});
    const paths = (inv.parsed.files as { path: string }[]).map((f) => f.path);
    expect(paths).toContain("spec/egov.md");
  });

  it("surfaces /v1 errors as isError tool results", async () => {
    // repo_init with an invalid name → 400 from /v1/repos → isError result.
    const bad = await callTool("repo_init", { name: "Invalid Name With Spaces" });
    expect(bad.result.isError).toBe(true);
    expect(bad.parsed.error).toBe("bad_request");
  });
});
