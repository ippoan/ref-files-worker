/**
 * Minimal tar reader for the bulk-upload endpoint.
 *
 * Workers have `DecompressionStream("gzip")` built in; we pipe the request
 * body through it and buffer the resulting tar bytes (the bulk endpoint is
 * for spec / reference docs in the low-MB range, not multi-GB archives).
 *
 * Supported entry types:
 *   - `'0'` / `'\0'` — regular file
 *   - `'5'`          — directory (skipped, we mkdir-p per file path)
 *   - `'L'`          — GNU long-name extension (`./@LongLink`); the data
 *                      block of this entry holds the name of the next entry,
 *                      which is required for UTF-8 / nested paths > 100 chars.
 *
 * Anything else (`'x'` pax headers, symlinks, hardlinks, char/block devices,
 * fifos) is skipped — they don't appear in archives produced by `tar -czf`
 * of a regular file tree, and silently ignoring them keeps the parser
 * resilient against future tar tooling changes.
 */

export interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

const BLOCK = 512;

function readCString(buf: Uint8Array, off: number, max: number): string {
  let end = off;
  const limit = off + max;
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(buf.subarray(off, end));
}

function isAllZero(buf: Uint8Array, off: number, len: number): boolean {
  for (let i = 0; i < len; i++) if (buf[off + i] !== 0) return false;
  return true;
}

/**
 * Decompress + parse. Returns regular-file entries only, in archive order.
 * Throws on truncated archives or malformed size fields.
 */
export async function parseTarGz(body: ReadableStream<Uint8Array>): Promise<TarEntry[]> {
  const decompressed = body.pipeThrough(new DecompressionStream("gzip"));
  const ab = await new Response(decompressed).arrayBuffer();
  return parseTar(new Uint8Array(ab));
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Tar writer (USTAR format) — used by folder bulk-download.                 */
/*                                                                           */
/* Each entry: 1 header block (512 B) + data padded to a multiple of 512 B. */
/* Archive ends with 2 zero blocks (1024 B). Paths longer than 100 B that   */
/* don't fit USTAR's `name` (100 B) + `prefix` (155 B) split fall back to   */
/* the GNU `'L'` (`./@LongLink`) extension so non-ASCII / deep paths work.  */
/* ──────────────────────────────────────────────────────────────────────── */

const TAR_END = new Uint8Array(BLOCK * 2);

function writeAscii(buf: Uint8Array, off: number, max: number, s: string): void {
  const bytes = new TextEncoder().encode(s);
  const n = Math.min(bytes.length, max);
  buf.set(bytes.subarray(0, n), off);
}

function writeOctal(buf: Uint8Array, off: number, width: number, value: number): void {
  // Trailing NUL is required by the spec (width-1 octal digits + NUL).
  const s = value.toString(8).padStart(width - 1, "0");
  writeAscii(buf, off, width - 1, s);
  buf[off + width - 1] = 0;
}

function applyChecksum(header: Uint8Array): void {
  // Checksum field (offset 148, 8 B): spaces while computing, then
  // 6-octal-digit + NUL + space.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  const s = sum.toString(8).padStart(6, "0");
  writeAscii(header, 148, 6, s);
  header[154] = 0;
  header[155] = 0x20;
}

function splitUstarName(path: string): { name: string; prefix: string } | null {
  const bytes = new TextEncoder().encode(path);
  if (bytes.length <= 100) return { name: path, prefix: "" };
  // Find a split at a '/' so prefix ≤ 155 B and name ≤ 100 B (both byte counts).
  // We scan slashes right-to-left and pick the rightmost one that satisfies both.
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] !== 0x2f /* '/' */) continue;
    const prefixLen = i;
    const nameLen = bytes.length - i - 1;
    if (prefixLen > 0 && prefixLen <= 155 && nameLen > 0 && nameLen <= 100) {
      const prefix = new TextDecoder("utf-8").decode(bytes.subarray(0, prefixLen));
      const name = new TextDecoder("utf-8").decode(bytes.subarray(i + 1));
      return { name, prefix };
    }
  }
  return null;
}

function buildHeader(opts: {
  name: string;
  prefix: string;
  size: number;
  typeflag: "0" | "L";
  mtime: number;
}): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeAscii(h, 0, 100, opts.name);
  writeOctal(h, 100, 8, 0o644); // mode
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, opts.size); // size
  writeOctal(h, 136, 12, opts.mtime); // mtime
  // checksum filled below
  h[156] = opts.typeflag.charCodeAt(0); // typeflag
  // linkname (157, 100) — empty
  writeAscii(h, 257, 6, "ustar\0"); // magic + version
  // version 2 B (offset 263) — leave as "\0\0" (older POSIX form);
  // GNU tar also accepts "00" but readers commonly accept both.
  h[263] = 0x20;
  h[264] = 0x20;
  // uname / gname (265, 32) / (297, 32) — empty
  // devmajor / devminor (329, 8) / (337, 8) — empty
  writeAscii(h, 345, 155, opts.prefix);
  applyChecksum(h);
  return h;
}

export interface TarWriteEntry {
  /** Path inside the archive (no leading slash). UTF-8 OK. */
  name: string;
  bytes: Uint8Array;
}

/**
 * Build an uncompressed tar archive from an array of entries.
 * For streaming use, prefer wrapping the output in `new Response(...).body`
 * and piping it through `new CompressionStream("gzip")`.
 */
export function buildTar(entries: TarWriteEntry[], mtime: number = Math.floor(Date.now() / 1000)): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const split = splitUstarName(entry.name);
    let nameForHeader: string;
    let prefixForHeader: string;
    if (split) {
      nameForHeader = split.name;
      prefixForHeader = split.prefix;
    } else {
      // GNU long-name fallback: emit an 'L' entry whose data block IS the
      // full name (NUL-terminated), then a normal entry with name truncated
      // to 100 B (readers ignore it in favor of the 'L' payload).
      const nameBytes = new TextEncoder().encode(entry.name + "\0");
      const longHeader = buildHeader({
        name: "././@LongLink",
        prefix: "",
        size: nameBytes.length,
        typeflag: "L",
        mtime,
      });
      parts.push(longHeader);
      total += BLOCK;
      const paddedLen = Math.ceil(nameBytes.length / BLOCK) * BLOCK;
      const padded = new Uint8Array(paddedLen);
      padded.set(nameBytes);
      parts.push(padded);
      total += paddedLen;
      // Use a truncated UTF-8-safe name for the real header.
      const truncBytes = new TextEncoder().encode(entry.name).subarray(0, 100);
      // Trim trailing partial-codepoint bytes (10xxxxxx) to keep UTF-8 valid.
      let end = truncBytes.length;
      while (end > 0 && (truncBytes[end - 1] & 0xc0) === 0x80) end--;
      nameForHeader = new TextDecoder("utf-8").decode(truncBytes.subarray(0, end));
      prefixForHeader = "";
    }
    const header = buildHeader({
      name: nameForHeader,
      prefix: prefixForHeader,
      size: entry.bytes.byteLength,
      typeflag: "0",
      mtime,
    });
    parts.push(header);
    total += BLOCK;
    const paddedLen = Math.ceil(entry.bytes.byteLength / BLOCK) * BLOCK;
    const padded = new Uint8Array(paddedLen);
    padded.set(entry.bytes);
    parts.push(padded);
    total += paddedLen;
  }
  parts.push(TAR_END);
  total += TAR_END.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

export function parseTar(data: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let pendingLongName: string | null = null;

  while (off + BLOCK <= data.length) {
    if (isAllZero(data, off, BLOCK)) {
      // End marker is two consecutive zero blocks; one zero block alone is
      // still treated as EOF here (the trailing block may be missing on
      // small archives produced by some tar implementations).
      break;
    }

    const sizeStr = readCString(data, off + 124, 12).trim();
    const size = sizeStr === "" ? 0 : Number.parseInt(sizeStr, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`tar_bad_size:${sizeStr}`);
    }
    const typeflag = String.fromCharCode(data[off + 156] || 0);
    let name = readCString(data, off, 100);
    // ustar prefix (`prefix` field at offset 345, 155 bytes) is concatenated
    // with `name` when present — handles long paths that fit in ustar without
    // needing GNU 'L'.
    const prefix = readCString(data, off + 345, 155);
    if (prefix.length > 0) name = `${prefix}/${name}`;

    off += BLOCK;
    const dataLen = size;
    const dataPadded = Math.ceil(dataLen / BLOCK) * BLOCK;

    if (typeflag === "L") {
      // GNU long name: the data block IS the name (NUL-terminated).
      const raw = data.subarray(off, off + dataLen);
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      pendingLongName = new TextDecoder("utf-8").decode(raw.subarray(0, end));
      off += dataPadded;
      continue;
    }

    const effectiveName = pendingLongName ?? name;
    pendingLongName = null;

    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      const bytes = data.subarray(off, off + dataLen);
      // Copy out of the underlying buffer so the caller can safely hold the
      // slice past the lifetime of `data`.
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      entries.push({ name: effectiveName, bytes: copy });
    }
    // typeflag '5' (dir), 'x'/'g' (pax), symlinks, etc. — skip data.

    off += dataPadded;
  }
  return entries;
}
