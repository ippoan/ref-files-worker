#!/usr/bin/env node
/**
 * coverage_100.toml に登録されたファイルが 100% カバレッジを維持しているか検証する。
 * coverage/coverage-summary.json を読み込み、登録ファイルの lines.pct を確認。
 * branches = true のファイルは branches.pct も 100% を要求する。
 *
 * frontend-ci.yml は `scripts/check_coverage_100.mjs` の存在を auto-detect して
 * "Coverage 100% regression check" step でこれを実行する (ci-workflows)。
 * default test_command が `npx vitest run --coverage ...` を回すので、その前段で
 * coverage/coverage-summary.json (vitest.config.ts の json-summary reporter 由来)
 * が生成されている前提。
 *
 * Usage: node scripts/check_coverage_100.mjs
 * Exit 0: 全ファイル 100% or 登録ファイルなし
 * Exit 1: 100% 未満のファイルあり
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TOML_PATH = join(ROOT, 'coverage_100.toml')
const SUMMARY_PATH = join(ROOT, 'coverage', 'coverage-summary.json')

// Parse coverage_100.toml — extract [[files]] entries with optional branches flag
function parseToml(content) {
  const entries = []
  let current = null
  for (const line of content.split('\n')) {
    if (line.trim() === '[[files]]') {
      current = { path: '', branches: false }
      entries.push(current)
      continue
    }
    if (!current) continue
    const pathMatch = line.match(/^path\s*=\s*"(.+)"/)
    if (pathMatch) { current.path = pathMatch[1]; continue }
    const branchMatch = line.match(/^branches\s*=\s*true/)
    if (branchMatch) current.branches = true
  }
  return entries.filter(e => e.path)
}

// Main
const tomlContent = readFileSync(TOML_PATH, 'utf-8')
const registeredFiles = parseToml(tomlContent)

if (registeredFiles.length === 0) {
  console.log('coverage_100.toml: No files registered yet. Skipping check.')
  process.exit(0)
}

if (!existsSync(SUMMARY_PATH)) {
  console.error(`ERROR: ${SUMMARY_PATH} not found. Run "npm run test:coverage" first.`)
  process.exit(1)
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf-8'))
let failed = false
let branchChecked = 0

for (const { path: filePath, branches: checkBranches } of registeredFiles) {
  // coverage-summary.json uses absolute paths as keys
  const absPath = resolve(ROOT, filePath)
  const entry = summary[absPath]

  if (!entry) {
    console.error(`FAIL: ${filePath} — not found in coverage report`)
    failed = true
    continue
  }

  const linesPct = entry.lines.pct
  const branchPct = entry.branches.pct

  if (linesPct < 100) {
    console.error(`FAIL: ${filePath} — lines ${linesPct}% (expected 100%)`)
    failed = true
  } else if (checkBranches && branchPct < 100) {
    console.error(`FAIL: ${filePath} — branches ${branchPct}% (expected 100%)`)
    failed = true
  } else {
    const branchLabel = checkBranches ? ` branches ${branchPct}%` : ''
    console.log(`  OK: ${filePath} — lines 100%${branchLabel}`)
  }

  if (checkBranches) branchChecked++
}

if (failed) {
  console.error('\ncoverage_100 regression detected!')
  process.exit(1)
} else {
  console.log(`\nAll ${registeredFiles.length} files at 100% lines (${branchChecked} also checked branches).`)
  process.exit(0)
}
