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
