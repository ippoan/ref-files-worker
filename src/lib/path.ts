/**
 * POSIX-style path helpers for the D1 layer.
 *
 * Rules (matching `src/types/` doc-comments):
 *   - paths use `/`, no leading slash, no `.`/`..` segments
 *   - empty string `""` means repo root
 *   - segment must be non-empty and cannot contain `/` or `\0`
 */

const SEGMENT_RE = /^[^/\0]+$/;

export class PathError extends Error {
  constructor(public readonly reason: string) {
    super(`path_${reason}`);
  }
}

/** Strip leading slashes, collapse `//`, reject `.`/`..`. Empty string is OK. */
export function normalizePath(raw: string): string {
  if (raw === "" || raw === "/") return "";
  if (typeof raw !== "string") throw new PathError("type");
  // forbid embedded NUL anywhere
  if (raw.includes("\0")) throw new PathError("nul");
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return "";
  const segs = trimmed.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") throw new PathError("segment");
    if (!SEGMENT_RE.test(s)) throw new PathError("segment");
  }
  return segs.join("/");
}

/** Split a normalized file path into `(parentPath, name)`. parentPath="" → root. */
export function splitParent(path: string): { parent: string; name: string } {
  if (path === "") throw new PathError("empty");
  const i = path.lastIndexOf("/");
  if (i < 0) return { parent: "", name: path };
  return { parent: path.slice(0, i), name: path.slice(i + 1) };
}

/** Ancestor folder paths of `path`, root-first, excluding `""` and `path` itself. */
export function ancestorFolders(path: string): string[] {
  if (path === "") return [];
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 1; i <= segs.length; i++) {
    out.push(segs.slice(0, i).join("/"));
  }
  return out;
}

/** SQL `LIKE` escape — `%` / `_` / `\` are special. Used by `file_search`. */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export function validRepoName(name: string): boolean {
  return REPO_NAME_RE.test(name);
}
