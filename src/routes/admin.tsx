/**
 * `/ui/*` — human-facing surface behind Cloudflare Access.
 *
 * This is the "see which file is wired to which repo" view a person opens in
 * a browser. Authentication is **not** the MCP JWT — it's Cloudflare Access
 * SSO, re-verified by `middleware/cf-access.ts`. Because Access policy decides
 * who gets in, the listing spans **every owner** (a global inventory), unlike
 * `/v1/inventory` which is scoped to the JWT's own `owner_login`.
 *
 * `GET /ui/inventory` content-negotiates:
 *   - browsers (Accept: text/html) or `?format=html` → a rendered folder tree
 *     (hono/jsx, server-side rendered, zero client deps). Folders are native
 *     <details>/<summary> so they collapse without JS; inline JS only adds a
 *     filter box.
 *   - everything else (fetch/curl/MCP, `Accept: application/json`, `*\/*`,
 *     or `?format=json`) → the original JSON, so existing callers are
 *     unaffected.
 *
 * Mounted with the `cfAccess` middleware in `src/index.ts`.
 */
import { Hono } from "hono";
import type { FC } from "hono/jsx";

import type { AppEnv } from "../env";
import { db } from "../db";
import { listInventory, type InventoryEntry } from "./inventory";

export const admin = new Hono<AppEnv>();

/** Human-readable byte size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Tree model ─────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  /** Full POSIX path from the repo root (used as the localStorage key). */
  path: string;
  children: Map<string, TreeNode>;
  /** Present iff this node is a file leaf. */
  file?: InventoryEntry;
  /** Lowercase haystack for client-side filtering (own path + descendants). */
  search: string;
}

interface RepoTree {
  repoName: string;
  ownerLogin: string;
  repoId: string;
  fileCount: number;
  root: TreeNode;
}

function newNode(name: string, path: string): TreeNode {
  return { name, path, children: new Map(), search: "" };
}

/** Split each file's POSIX path into folder nodes + a file leaf. */
function buildTree(repoName: string, ownerLogin: string, files: InventoryEntry[]): TreeNode {
  const root = newNode("", "");
  for (const f of files) {
    const parts = f.path.split("/").filter((p) => p.length > 0);
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = newNode(part, parts.slice(0, i + 1).join("/"));
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.file = f;
        // file leaves are searchable by path + repo + owner
        child.search = `${f.path} ${repoName} ${ownerLogin}`.toLowerCase();
      }
      node = child;
    });
  }
  // Folders aggregate their descendants' search strings (bottom-up).
  const aggregate = (n: TreeNode): string => {
    if (n.file && n.children.size === 0) return n.search;
    let s = n.search;
    for (const c of n.children.values()) s += " " + aggregate(c);
    n.search = s;
    return s;
  };
  aggregate(root);
  return root;
}

function countFiles(n: TreeNode): number {
  if (n.file && n.children.size === 0) return 1;
  let total = 0;
  for (const c of n.children.values()) total += countFiles(c);
  return total;
}

/** Folders first, then files; each alphabetically. */
function sortedChildren(n: TreeNode): TreeNode[] {
  return [...n.children.values()].sort((a, b) => {
    const aIsDir = a.children.size > 0 || !a.file;
    const bIsDir = b.children.size > 0 || !b.file;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── View ────────────────────────────────────────────────────────────────────

const STYLES = `
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;margin:0;color:#1a1a1a;background:#f6f7f9}
header{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #e2e4e8;padding:16px 24px}
header h1{margin:0 0 4px;font-size:18px}
header p{margin:0 0 12px;color:#666;font-size:13px}
#q{width:100%;max-width:440px;padding:8px 12px;border:1px solid #ccc;border-radius:6px;font-size:14px}
section.repo{margin:20px 24px;background:#fff;border:1px solid #e2e4e8;border-radius:8px;overflow:hidden}
section.repo>h2{margin:0;padding:11px 16px;font-size:15px;background:#fafbfc;border-bottom:1px solid #e2e4e8}
.owner{color:#888;font-weight:400;font-size:13px;margin-left:6px}
.cnt{float:right;color:#667;font-weight:400;font-size:12px;background:#eef;padding:2px 9px;border-radius:10px}
details.folder>summary,.file{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:5px 16px;border-bottom:1px solid #f4f5f7;font-size:13px}
details.folder>summary{cursor:pointer;list-style:none;font-weight:500;background:#fcfcfd}
details.folder>summary::-webkit-details-marker{display:none}
details.folder>summary .nm::before{content:"▸ ";color:#aab;display:inline-block;transition:transform .1s}
details.folder[open]>summary .nm::before{content:"▾ "}
.folder-body{margin-left:15px;border-left:1px solid #eceef1}
.file .nm{color:#222;word-break:break-all}
.file .nm::before{content:"📄 ";opacity:.7}
.folder>summary .nm::after{content:"";}
.nm{flex:1;min-width:0}
.fcnt{color:#aab;font-size:11px;font-weight:400}
.meta{color:#888;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px}
.deleted .nm{color:#b00;text-decoration:line-through}
.empty{margin:40px 24px;color:#888}
`;

const SCRIPT = `
(function(){
  var LS='rfinv:';
  var suppress=false; // don't persist search-driven auto-opens
  document.querySelectorAll('details.folder').forEach(function(d){
    var k=d.getAttribute('data-key');
    if(k){
      var v=null;try{v=localStorage.getItem(LS+k);}catch(e){}
      // restore BEFORE wiring the listener so this doesn't get re-saved
      if(v==='1')d.open=true;else if(v==='0')d.open=false;
    }
    d.addEventListener('toggle',function(){
      if(suppress)return;
      var kk=d.getAttribute('data-key');if(!kk)return;
      try{localStorage.setItem(LS+kk,d.open?'1':'0');}catch(e){}
    });
  });
  var q=document.getElementById('q');
  if(!q)return;
  q.addEventListener('input',function(){
    var t=(q.value||'').trim().toLowerCase();
    document.querySelectorAll('.file').forEach(function(el){
      el.style.display=(!t||el.getAttribute('data-search').indexOf(t)>=0)?'':'none';
    });
    suppress=true;
    document.querySelectorAll('details.folder').forEach(function(d){
      var hit=!t||d.getAttribute('data-search').indexOf(t)>=0;
      d.style.display=hit?'':'none';
      if(t&&hit)d.open=true;
    });
    suppress=false;
    document.querySelectorAll('section.repo').forEach(function(sec){
      var anyFile=sec.querySelector('.file:not([style*="none"])');
      sec.style.display=(!t||anyFile)?'':'none';
    });
  });
})();
`;

const FileRow: FC<{ node: TreeNode }> = ({ node }) => {
  const f = node.file as InventoryEntry;
  return (
    <div class={f.deleted_at ? "file deleted" : "file"} data-search={node.search}>
      <span class="nm">{node.name}</span>
      <span class="meta">
        {formatSize(f.size)} · r{f.revision} · {f.updated_at}
      </span>
    </div>
  );
};

const FolderTree: FC<{ node: TreeNode; repoId: string }> = ({ node, repoId }) => (
  <>
    {sortedChildren(node).map((c) =>
      c.file && c.children.size === 0 ? (
        <FileRow node={c} />
      ) : (
        <details class="folder" open data-search={c.search} data-key={`${repoId}:${c.path}`}>
          <summary>
            <span class="nm">{c.name}</span>
            <span class="fcnt">{countFiles(c)}</span>
          </summary>
          <div class="folder-body">
            <FolderTree node={c} repoId={repoId} />
          </div>
        </details>
      ),
    )}
  </>
);

const InventoryPage: FC<{ viewer: string; count: number; repos: RepoTree[] }> = ({
  viewer,
  count,
  repos,
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>ref-files inventory</title>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </head>
    <body>
      <header>
        <h1>ref-files inventory</h1>
        <p>
          viewer: {viewer} · {count} files · {repos.length} repos
        </p>
        <input id="q" type="search" placeholder="filter by path / repo / owner…" autocomplete="off" />
      </header>
      {repos.length === 0 ? (
        <p class="empty">No files.</p>
      ) : (
        repos.map((r) => (
          <section class="repo">
            <h2>
              {r.repoName}
              <span class="owner">{r.ownerLogin}</span>
              <span class="cnt">{r.fileCount}</span>
            </h2>
            <FolderTree node={r.root} repoId={r.repoId} />
          </section>
        ))
      )}
      <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
    </body>
  </html>
);

// NOTE: STYLES and SCRIPT are static module constants with no interpolation,
// so the two `dangerouslySetInnerHTML` uses (inline <style>/<script>) never
// carry user input — no XSS surface. All user-derived values (file/folder
// names, repo/owner) are rendered via JSX expressions, which hono/jsx escapes.

/** Build per-repo trees, sorted by repo name. */
function buildRepoTrees(entries: InventoryEntry[]): RepoTree[] {
  const byRepo = new Map<string, InventoryEntry[]>();
  for (const e of entries) {
    const arr = byRepo.get(e.repo_id);
    if (arr) arr.push(e);
    else byRepo.set(e.repo_id, [e]);
  }
  const trees: RepoTree[] = [];
  for (const files of byRepo.values()) {
    const first = files[0];
    trees.push({
      repoName: first.repo_name,
      ownerLogin: first.owner_login,
      repoId: first.repo_id,
      fileCount: files.length,
      root: buildTree(first.repo_name, first.owner_login, files),
    });
  }
  return trees.sort((a, b) => a.repoName.localeCompare(b.repoName));
}

// GET /ui/inventory — global cross-repo, cross-owner file listing (admin view).
//   ?owner=<login>        filter to one owner
//   ?repo=<name>          filter to one repo by name
//   ?include_deleted=true include soft-deleted files
//   ?format=html|json     force content type (default: negotiate on Accept)
admin.get("/inventory", async (c) => {
  const owner = c.req.query("owner") || undefined;
  const repo = c.req.query("repo") || undefined;
  const includeDeleted = c.req.query("include_deleted") === "true";

  const handle = db(c.env);
  const entries = await listInventory(handle, { owner, repo, includeDeleted });
  const viewer = c.get("accessUser").email;

  const format = c.req.query("format");
  const accept = c.req.header("Accept") || "";
  // HTML only when the client actually asked for it (browser) or forced it.
  // Default — and any JSON/`*\/*`/no-Accept caller — stays JSON for back-compat.
  const wantsHtml = format === "html" || (format !== "json" && accept.includes("text/html"));

  if (!wantsHtml) {
    return c.json({ viewer, count: entries.length, files: entries }, 200);
  }
  return c.html(<InventoryPage viewer={viewer} count={entries.length} repos={buildRepoTrees(entries)} />);
});
