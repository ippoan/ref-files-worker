#!/usr/bin/env node
// 実装は @ippoan/test-utils に集約 (Refs ippoan/auth-worker#257 タスク 3)。
// frontend-ci が `scripts/check_coverage_100.mjs` を auto-detect して実行する
// ため、このパスを 1 行 wrapper として維持する。bin 経由 (npx) は npm publish
// の bin 正規化で mapping が剥がれたため deep import を使う。
import '@ippoan/test-utils/bin/check-coverage-100.mjs'
