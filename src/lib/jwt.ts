/**
 * HS256 MCP-JWT verifier — `@ippoan/mcp-cf-workers` の `./auth` export を消費する
 * 薄い adapter (Refs ippoan/mcp-cf-workers#46 — 自前 Web Crypto コピーの解消)。
 *
 * 本 repo の契約として維持するもの:
 *   - claim 形 (github_login が正規 identity)
 *   - aud は `"*"` で不問 — shared HS256 secret が auth-worker 由来を既に証明し、
 *     claude.ai connector は可変 aud を mint するため。security-inventory と同じ
 *     confused-deputy tradeoff を受け入れつつ、introspect round-trip を避けて
 *     ローカル検証する設計判断も従来どおり (Refs ippoan/secrets-inventory#43)
 *   - 失敗 reason の粒度 (sub / github_login を "claims" に丸めない —
 *     middleware が reason を wire に出すため test が pin している)
 *   - `JwtVerifyError` という名前 (call site の instanceof / reason 参照)
 */
import {
  verifyHs256Jwt,
  Hs256JwtError,
  type Hs256BaseClaims,
} from "@ippoan/mcp-cf-workers/auth";

export interface McpJwtClaims extends Hs256BaseClaims {
  sub: string;
  github_login: string;
  scope: string;
  aud: string;
}

export { Hs256JwtError as JwtVerifyError };

export async function verifyMcpJwt(
  token: string,
  secret: string,
  expectedAudience: string | readonly string[],
): Promise<McpJwtClaims> {
  return verifyHs256Jwt<McpJwtClaims>(token, secret, {
    audience: expectedAudience,
    validateClaims: (c) => {
      if (typeof c.sub !== "string" || c.sub.length === 0) {
        throw new Hs256JwtError("sub");
      }
      if (typeof c.github_login !== "string" || c.github_login.length === 0) {
        throw new Hs256JwtError("github_login");
      }
    },
  });
}
