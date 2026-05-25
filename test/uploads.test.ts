/**
 * Pre-signed upload / download flow tests.
 *
 * Exercises the JWT-protected `/v1/files/{upload-init,bulk-upload-init,download-url}`
 * issue endpoints plus the JWT-less `/upload/:token` / `/download/:token`
 * consume endpoints. tar.gz fixtures are built in-test (no Node deps) so the
 * vitest-pool-workers env can run them.
 */
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

function tokenFromUrl(url: string): string {
  // upload_url / download_url contain `/upload/<token>` or `/download/<token>`.
  const m = url.match(/\/(?:upload|download)\/([A-Za-z0-9_\-]+)$/);
  if (!m) throw new Error(`no token in url: ${url}`);
  return m[1];
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** Build a minimal ustar header block (512 bytes, no checksum). */
function tarHeader(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const nameBytes = new TextEncoder().encode(name);
  block.set(nameBytes.subarray(0, 100), 0);
  const mode = octal(0o644, 8);
  const uid = octal(0, 8);
  const gid = octal(0, 8);
  const sz = octal(size, 12);
  const mtime = octal(0, 12);
  const enc = new TextEncoder();
  block.set(enc.encode(mode), 100);
  block.set(enc.encode(uid), 108);
  block.set(enc.encode(gid), 116);
  block.set(enc.encode(sz), 124);
  block.set(enc.encode(mtime), 136);
  // checksum field (8 bytes at offset 148) — spaces during computation.
  for (let i = 148; i < 156; i++) block[i] = 0x20;
  block[156] = 0x30; // '0' = regular file
  // ustar magic & version
  block.set(enc.encode("ustar\x0000"), 257);
  // compute checksum
  let chk = 0;
  for (let i = 0; i < 512; i++) chk += block[i];
  const chkStr = chk.toString(8).padStart(6, "0") + "\0 ";
  block.set(enc.encode(chkStr), 148);
  return block;
}

async function buildTarGz(entries: Array<{ name: string; bytes: Uint8Array }>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.bytes.byteLength));
    parts.push(e.bytes);
    const pad = (512 - (e.bytes.byteLength % 512)) % 512;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  // two 512-byte zero blocks as end marker
  parts.push(new Uint8Array(1024));
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const tar = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    tar.set(p, off);
    off += p.byteLength;
  }
  // gzip via CompressionStream
  const gzStream = new Response(tar).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gzStream).arrayBuffer());
}

describe("single-file pre-signed upload", () => {
  it("init → PUT bytes → file_get returns same bytes", async () => {
    const repoId = await initRepo("alice", "up-single-a");

    const initRes = await worker.fetch(
      new Request("https://x/v1/files/upload-init", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({
          repo_id: repoId,
          path: "spec/openapi.json",
          mime: "application/json",
          message: "via pre-signed",
        }),
      }),
      env,
      ctx,
    );
    expect(initRes.status).toBe(201);
    const initBody = (await initRes.json()) as {
      upload_url: string;
      token: string;
      method: string;
    };
    expect(initBody.method).toBe("PUT");
    expect(initBody.upload_url).toMatch(/\/upload\//);
    const token = initBody.token;

    const payload = new TextEncoder().encode('{"hello":"world"}');
    const putRes = await worker.fetch(
      new Request(`https://x/upload/${token}`, {
        method: "PUT",
        body: payload,
      }),
      env,
      ctx,
    );
    expect(putRes.status).toBe(201);
    const putBody = (await putRes.json()) as {
      file: { path: string };
      revision: { rev_number: number; sha256: string; size: number | bigint };
    };
    expect(putBody.file.path).toBe("spec/openapi.json");
    expect(putBody.revision.rev_number).toBe(1);
    expect(Number(putBody.revision.size)).toBe(payload.byteLength);

    // Read it back through the existing JSON file_get.
    const getRes = await worker.fetch(
      new Request(
        `https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("spec/openapi.json")}`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { content_base64: string };
    const decoded = atob(getBody.content_base64);
    expect(decoded).toBe('{"hello":"world"}');
  });

  it("replay returns 410 (token consumed)", async () => {
    const repoId = await initRepo("alice", "up-single-b");
    const init = await worker.fetch(
      new Request("https://x/v1/files/upload-init", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ repo_id: repoId, path: "x.txt" }),
      }),
      env,
      ctx,
    );
    const { token } = (await init.json()) as { token: string };
    const first = await worker.fetch(
      new Request(`https://x/upload/${token}`, { method: "PUT", body: "first" }),
      env,
      ctx,
    );
    expect(first.status).toBe(201);
    const second = await worker.fetch(
      new Request(`https://x/upload/${token}`, { method: "PUT", body: "second" }),
      env,
      ctx,
    );
    expect(second.status).toBe(410);
  });

  it("unknown token returns 404", async () => {
    const res = await worker.fetch(
      new Request("https://x/upload/no-such-token", { method: "PUT", body: "x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("wrong-kind token (download token used for PUT) returns 400", async () => {
    const repoId = await initRepo("alice", "up-single-c");
    // seed a file so download-url can succeed
    await worker.fetch(
      new Request("https://x/v1/files", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ repo_id: repoId, path: "seed.txt", content_base64: btoa("seed") }),
      }),
      env,
      ctx,
    );
    const init = await worker.fetch(
      new Request(
        `https://x/v1/files/download-url?repo_id=${repoId}&path=seed.txt`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    const { token } = (await init.json()) as { token: string };
    const wrong = await worker.fetch(
      new Request(`https://x/upload/${token}`, { method: "PUT", body: "x" }),
      env,
      ctx,
    );
    expect(wrong.status).toBe(400);
  });
});

describe("tar.gz bulk upload", () => {
  it("init → PUT tar.gz → all entries land at base_path", async () => {
    const repoId = await initRepo("alice", "bulk-a");
    const tarGz = await buildTarGz([
      { name: "spec/a.txt", bytes: new TextEncoder().encode("alpha") },
      { name: "spec/sub/b.json", bytes: new TextEncoder().encode('{"k":1}') },
      { name: "spec/sub/c.bin", bytes: new Uint8Array([0, 1, 2, 3, 255, 128]) },
    ]);

    const init = await worker.fetch(
      new Request("https://x/v1/files/bulk-upload-init", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ repo_id: repoId, base_path: "", message: "bulk" }),
      }),
      env,
      ctx,
    );
    expect(init.status).toBe(201);
    const initBody = (await init.json()) as { token: string; content_type: string };
    expect(initBody.content_type).toBe("application/gzip");

    const put = await worker.fetch(
      new Request(`https://x/upload/${initBody.token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/gzip" },
        body: tarGz,
      }),
      env,
      ctx,
    );
    expect(put.status).toBe(201);
    const body = (await put.json()) as {
      files: Array<{ path: string; size: number; sha256: string }>;
      count: number;
    };
    expect(body.count).toBe(3);
    const paths = body.files.map((f) => f.path).sort();
    expect(paths).toEqual(["spec/a.txt", "spec/sub/b.json", "spec/sub/c.bin"]);

    // verify one binary entry round-trips byte-exact
    const binFile = body.files.find((f) => f.path === "spec/sub/c.bin")!;
    expect(binFile.size).toBe(6);
    const get = await worker.fetch(
      new Request(
        `https://x/v1/files?repo_id=${repoId}&path=${encodeURIComponent("spec/sub/c.bin")}`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(get.status).toBe(200);
    const { content_base64 } = (await get.json()) as { content_base64: string };
    const bin = atob(content_base64);
    expect(bin.charCodeAt(0)).toBe(0);
    expect(bin.charCodeAt(4)).toBe(255);
    expect(bin.charCodeAt(5)).toBe(128);
  });

  it("base_path prefixes every entry", async () => {
    const repoId = await initRepo("alice", "bulk-b");
    const tarGz = await buildTarGz([
      { name: "x.md", bytes: new TextEncoder().encode("# x") },
    ]);
    const init = await worker.fetch(
      new Request("https://x/v1/files/bulk-upload-init", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ repo_id: repoId, base_path: "imported/v1" }),
      }),
      env,
      ctx,
    );
    const { token } = (await init.json()) as { token: string };
    const put = await worker.fetch(
      new Request(`https://x/upload/${token}`, { method: "PUT", body: tarGz }),
      env,
      ctx,
    );
    expect(put.status).toBe(201);
    const body = (await put.json()) as { files: Array<{ path: string }> };
    expect(body.files[0]?.path).toBe("imported/v1/x.md");
  });
});

describe("pre-signed download", () => {
  it("download-url → GET streams the blob with attachment header", async () => {
    const repoId = await initRepo("alice", "dl-a");
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
    // file_put expects base64 string
    await worker.fetch(
      new Request("https://x/v1/files", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({
          repo_id: repoId,
          path: "binary.bin",
          content_base64: btoa(String.fromCharCode(...payload)),
          mime: "application/octet-stream",
        }),
      }),
      env,
      ctx,
    );

    const init = await worker.fetch(
      new Request(
        `https://x/v1/files/download-url?repo_id=${repoId}&path=binary.bin`,
        { headers: h() },
      ),
      env,
      ctx,
    );
    expect(init.status).toBe(201);
    const { download_url, token } = (await init.json()) as { download_url: string; token: string };
    expect(download_url).toMatch(/\/download\//);
    expect(tokenFromUrl(download_url)).toBe(token);

    const dl = await worker.fetch(
      new Request(`https://x/download/${token}`),
      env,
      ctx,
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(dl.headers.get("Content-Disposition")).toContain("binary.bin");
    expect(dl.headers.get("X-Sha256")).toMatch(/^[0-9a-f]{64}$/);
    const got = new Uint8Array(await dl.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(payload));
  });

  it("download token is reusable until expiry", async () => {
    const repoId = await initRepo("alice", "dl-b");
    await worker.fetch(
      new Request("https://x/v1/files", {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ repo_id: repoId, path: "r.txt", content_base64: btoa("reread") }),
      }),
      env,
      ctx,
    );
    const init = await worker.fetch(
      new Request(`https://x/v1/files/download-url?repo_id=${repoId}&path=r.txt`, { headers: h() }),
      env,
      ctx,
    );
    const { token } = (await init.json()) as { token: string };
    const a = await worker.fetch(new Request(`https://x/download/${token}`), env, ctx);
    expect(a.status).toBe(200);
    expect(await a.text()).toBe("reread");
    // second fetch on the same token still works (download tokens are not
    // marked consumed — only upload tokens are single-shot).
    const b = await worker.fetch(new Request(`https://x/download/${token}`), env, ctx);
    expect(b.status).toBe(200);
    expect(await b.text()).toBe("reread");
  });

  it("download-url 404s for unknown path", async () => {
    const repoId = await initRepo("alice", "dl-c");
    const res = await worker.fetch(
      new Request(`https://x/v1/files/download-url?repo_id=${repoId}&path=missing.txt`, {
        headers: h(),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});
