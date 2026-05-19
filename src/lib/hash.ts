/** Lowercase hex SHA-256 of raw bytes — matches `revisions.sha256` shape. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Force the input through a fresh ArrayBuffer copy so the call site never has
  // to worry about SharedArrayBuffer-vs-ArrayBuffer typing (Web Crypto only
  // accepts the latter).
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  const out = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < out.length; i++) {
    hex += out[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
