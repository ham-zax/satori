# Production readiness audit: verified findings

An external agent audited `400c15d7` and returned NO-GO with three release blockers. Each claim was checked
on 2026-10-15 against `5186f4f4` (code reads, focused test runs, `npm pack --dry-run`, the npm registry).
Result: no P0 or P1 issue. The three blockers are either out of date or not reproduced.

## Priority scale

- P0: data loss, security breach or a broken install for every user. Stop the launch.
- P1: a core feature fails for normal users, or CI cannot release. Fix before the launch.
- P2: a real defect with a narrow trigger, or a release-quality problem. Fix before the next publish.
- P3: developer tooling or repository hygiene. Fix when convenient.

## Verified findings

| ID | Priority | Status | Finding | Evidence |
|---|---|---|---|---|
| F-009 | P2 | Confirmed | `logConfigurationSummary()` logs `MILVUS_ADDRESS` and `GEMINI_BASE_URL` without redaction; `OPENAI_BASE_URL` is redacted. Credentials in those URLs reach the startup log. | `packages/mcp/src/config.ts:559`, `:584`; redaction at `:567-575` |
| F-006 | P2 | Confirmed | The npm tarballs ship compiled tests: 212 test files in core, 50 in cli. The `files` globs `dist/**/*.js` and `dist/**/*.d.ts` include them. | `npm pack --dry-run` in `packages/core` and `packages/cli` |
| F-004 | P3 | Confirmed | Dev scripts still require synchronous `syncStats` from `manage_index sync`, which is now a supervised background operation. | `scripts/satori-live-latency-benchmark.mjs:303-306`, `scripts/satori-useful-context-record.mjs:927-930` |
| F-005a | P3 | Confirmed | `.env.example` lists removed Ollama settings and `SPLITTER_TYPE=ast`, and line 5 says `cp env.example`. | `.env.example:5`, `:61-64`, `:82`; `EmbeddingProvider` in `packages/mcp/src/config.ts:31` |
| F-007 | P3 | Partly confirmed | `.vscode/launch.json` and `settings.json` refer to the removed `packages/vscode-extension`; root `package.json` keeps browserify polyfills. The `.omc` part is out of date (untracked in `6cc01f0e`). | `.vscode/launch.json:13-16`, `.vscode/settings.json:18`, `package.json:64-74` |
| F-008 | P3 | Confirmed, wider than claimed | `scripts/check-piolium-findings.test.mjs` fails 28 of 36 tests in a `--depth 1` clone (unknown commit `94a3dc65…`), not only the live-repository subtest. CI is not affected: every checkout uses `fetch-depth: 0`. | full clone 36/36 pass; shallow clone 8 pass, 28 fail; `.github/workflows/ci.yml:18,51,126` |

## Rejected or out-of-date claims

| ID | Claimed | Status | Evidence |
|---|---|---|---|
| F-001 | P1: local packed tarballs differ from published 0.7.1 / 0.9.1 / 0.6.4 without a version bump | Out of date | `6cc01f0e` bumped core 0.8.0, mcp 0.9.2, cli 0.6.5; npm has mcp 0.9.1. The cited `docs/release/published-package-snapshots.json` does not exist; `scripts/check-release-graph.mjs` reads the registry. |
| F-002 | P1: `lateon-reranker.test.ts` fails deterministically | Not reproduced | 27 pass, 2 skipped, 4 s at HEAD; the file and `lateon-reranker.ts` are unchanged since `400c15d7`. The described `execArgv` filter is also wrong: it removes only `--input-type`. A failure under the auditor's container load is possible. |
| F-003 | P1: `index-equivalence-typescript-project-jobs.test.ts` exceeds the 90 s file budget under 8-way concurrency | Not reproduced | The 8-way core batch (100 files, includes that file) passed 713 tests in 51 s with no budget failure. The file is in the 8-way batch, so heavy load can still slow it. |
| F-005b | `start:with-env` uses the missing `dotenv` binary | False | `packages/mcp/package.json:32` sets variables inline and runs `tsx src/index.ts`. |

## Decision

The NO-GO depended on F-001 to F-003; none holds at `5186f4f4`. F-009 and F-006 should be fixed before the
next npm publish. The P3 items do not affect users.
