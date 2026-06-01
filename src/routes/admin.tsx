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
 *   - browsers (Accept: text/html) or `?format=html` → a rendered HTML table
 *     (hono/jsx, server-side rendered, zero client deps; inline JS only for
 *     client-side filter + column sort).
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

interface RepoGroup {
  repoName: string;
  ownerLogin: string;
  repoId: string;
  files: InventoryEntry[];
}

/** Group a flat inventory into per-repo sections, sorted by repo name. */
function groupByRepo(entries: InventoryEntry[]): RepoGroup[] {
  const map = new Map<string, RepoGroup>();
  for (const e of entries) {
    let g = map.get(e.repo_id);
    if (!g) {
      g = { repoName: e.repo_name, ownerLogin: e.owner_login, repoId: e.repo_id, files: [] };
      map.set(e.repo_id, g);
    }
    g.files.push(e);
  }
  return [...map.values()].sort((a, b) => a.repoName.localeCompare(b.repoName));
}

// NOTE: STYLES and SCRIPT below are static module constants with no
// interpolation, so the two `dangerouslySetInnerHTML` uses (the inline <style>
// and <script>) never carry user input — no XSS surface. All user-derived
// values (file paths, repo/owner names) are rendered via JSX expressions
// (`{f.path}` etc.), which hono/jsx HTML-escapes automatically.
const STYLES = `
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;margin:0;color:#1a1a1a;background:#f6f7f9}
header{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #e2e4e8;padding:16px 24px}
header h1{margin:0 0 4px;font-size:18px}
header p{margin:0 0 12px;color:#666;font-size:13px}
#q{width:100%;max-width:440px;padding:8px 12px;border:1px solid #ccc;border-radius:6px;font-size:14px}
section.repo{margin:20px 24px;background:#fff;border:1px solid #e2e4e8;border-radius:8px;overflow:hidden}
section.repo h2{margin:0;padding:11px 16px;font-size:15px;background:#fafbfc;border-bottom:1px solid #e2e4e8}
.owner{color:#888;font-weight:400;font-size:13px;margin-left:6px}
.cnt{float:right;color:#667;font-weight:400;font-size:12px;background:#eef;padding:2px 9px;border-radius:10px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 16px;border-bottom:1px solid #f0f1f3;font-size:13px;vertical-align:top}
th{color:#555;font-weight:600;user-select:none;cursor:pointer;white-space:nowrap}
th:hover{color:#000}
tbody tr:hover{background:#f9fafb}
td.path{word-break:break-all}
td.num{white-space:nowrap;color:#555;font-variant-numeric:tabular-nums}
tr.deleted td{color:#b00;text-decoration:line-through}
.empty{margin:40px 24px;color:#888}
`;

const SCRIPT = `
(function(){
  var q=document.getElementById('q');
  function filter(){
    var t=(q.value||'').trim().toLowerCase();
    document.querySelectorAll('section.repo').forEach(function(sec){
      var vis=0;
      sec.querySelectorAll('tbody tr').forEach(function(tr){
        var hit=!t||tr.getAttribute('data-search').indexOf(t)>=0;
        tr.style.display=hit?'':'none';
        if(hit)vis++;
      });
      sec.style.display=vis?'':'none';
    });
  }
  if(q)q.addEventListener('input',filter);
  document.querySelectorAll('th[data-col]').forEach(function(th){
    th.addEventListener('click',function(){
      var table=th.closest('table'),tbody=table.querySelector('tbody');
      var idx=Array.prototype.indexOf.call(th.parentNode.children,th);
      var col=th.getAttribute('data-col');
      var asc=th.getAttribute('data-asc')!=='true';th.setAttribute('data-asc',asc);
      var rows=Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      rows.sort(function(a,b){
        var av,bv;
        if(col==='size'){av=+a.children[idx].getAttribute('data-size');bv=+b.children[idx].getAttribute('data-size');}
        else if(col==='rev'){av=+a.children[idx].textContent;bv=+b.children[idx].textContent;}
        else{av=a.children[idx].textContent;bv=b.children[idx].textContent;}
        return (av<bv?-1:av>bv?1:0)*(asc?1:-1);
      });
      rows.forEach(function(r){tbody.appendChild(r);});
    });
  });
})();
`;

const InventoryPage: FC<{ viewer: string; count: number; groups: RepoGroup[] }> = ({
  viewer,
  count,
  groups,
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
          viewer: {viewer} · {count} files · {groups.length} repos
        </p>
        <input id="q" type="search" placeholder="filter by path / repo / owner…" autocomplete="off" />
      </header>
      {groups.length === 0 ? (
        <p class="empty">No files.</p>
      ) : (
        groups.map((g) => (
          <section class="repo">
            <h2>
              {g.repoName}
              <span class="owner">{g.ownerLogin}</span>
              <span class="cnt">{g.files.length}</span>
            </h2>
            <table>
              <thead>
                <tr>
                  <th data-col="path">path</th>
                  <th data-col="size">size</th>
                  <th data-col="rev">rev</th>
                  <th data-col="updated">updated</th>
                </tr>
              </thead>
              <tbody>
                {g.files.map((f) => (
                  <tr
                    data-search={`${f.path} ${g.repoName} ${g.ownerLogin}`.toLowerCase()}
                    class={f.deleted_at ? "deleted" : undefined}
                  >
                    <td class="path">{f.path}</td>
                    <td class="num" data-size={String(f.size)}>
                      {formatSize(f.size)}
                    </td>
                    <td class="num">{f.revision}</td>
                    <td class="num">{f.updated_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
      <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
    </body>
  </html>
);

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
  return c.html(<InventoryPage viewer={viewer} count={entries.length} groups={groupByRepo(entries)} />);
});
