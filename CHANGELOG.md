# Changelog

All notable changes to this repository are documented in this file.

## [2026-02-28] Manage Index Envelope + Reindex Preflight Guardrails and Search Ignore-Hint Hardening

### Added
- Added structured `manage_index` envelope types in:
  - `packages/mcp/src/core/manage-types.ts`
- Added warning-code SSOT registry in:
  - `packages/mcp/src/core/warnings.ts`
- Added deterministic preflight/contract regression coverage:
  - `packages/mcp/src/core/handlers.manage_index_preflight.test.ts`
  - `packages/mcp/src/core/warnings.test.ts`
- Expanded search noise-mitigation regressions in:
  - `packages/mcp/src/core/handlers.scope.test.ts` for:
    - root `.gitignore` redundant-suggestion suppression,
    - partial suppression with order stability,
    - forced reload cadence under unchanged `mtime`/size.

### Modified
- Evolved `manage_index` handler outputs from text-only responses to structured envelope JSON (serialized in `content[0].text`) with stable fields:
  - `tool`, `version`, `action`, `path`, `status`, `reason?`, `message`, `humanText`, `warnings?`, `hints?`, `preflight?`
  - implemented in `packages/mcp/src/core/handlers.ts`.
- Added `reindex` preflight guardrails in `handlers.ts`:
  - blocks ignore-only churn by default (`status="blocked"`, `reason="unnecessary_reindex_ignore_only"`),
  - supports explicit override via `allowUnnecessaryReindex`,
  - forwards non-authoritative preflight outcomes (`unknown`, `probe_failed`) as warn-only diagnostics while proceeding.
- Hardened search noise mitigation in `handlers.ts`:
  - root `.gitignore` matcher cache keyed by canonical root identity,
  - cache invalidation by `mtimeMs + size`,
  - deterministic forced reload cadence (`SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N`),
  - path-observed filtering of `suggestedIgnorePatterns`,
  - deterministic next-step messaging for empty/non-empty suggestion outcomes.
- Fixed initial `.gitignore` cache-load short-circuit so first lookup attempts real matcher load.
- Updated manage tool schema/description in:
  - `packages/mcp/src/tools/manage_index.ts`
  - added `allowUnnecessaryReindex` input.
- Updated CLI manage status inference for expanded envelope status/reason combinations in:
  - `packages/mcp/src/cli/format.ts`.
- Migrated manage-index handler tests to envelope assertions in:
  - `packages/mcp/src/core/handlers.manage_index_blocking.test.ts`
  - `packages/mcp/src/core/handlers.index_validation.test.ts`.
- Updated PI example bridge/tooling contracts for reindex preflight override support:
  - `examples/pi-extension/satori-bridge/index.ts` (`allowUnnecessaryReindex` schema field + manage tool description)
  - `examples/pi-extension/satori-bridge/README.md` (blocked ignore-only reindex guidance)
  - `examples/pi-extension/satori-bridge/skills/satori-cli/SKILL.md` (gating precedence + override routing guidance).

### Docs
- Updated behavior contract docs for envelope-native `manage_index` responses, reindex preflight semantics, and root `.gitignore`-aware noise-hint filtering in:
  - `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`.

### Validation
- `pnpm -C packages/mcp typecheck`
- `pnpm -C packages/mcp test`

## [2026-02-28] SnapshotManager Lock/Merge Hardening Follow-up

### Added
- Added execution plan doc:
  - `docs/SNAPSHOT_MANAGER_HARDENING_PLAN.md`
- Added SnapshotManager regression tests in `packages/mcp/src/core/snapshot.test.ts` for:
  - explicit `fingerprintSource` override on `setCodebaseSyncCompleted`,
  - immutable `setIndexedFileCount` behavior,
  - stale-lock PID liveness handling,
  - bounded no-spin lock retry behavior when wait path is unavailable,
  - bounded no-spin behavior in stale-lock break branch when wait path is unavailable,
  - merge precedence with stale indexing records,
  - save-on-load migration gating,
  - malformed persisted snapshot handling in merge/save path when payload is not v1/v2/v3,
  - malformed `indexFingerprint` rejection during v3 load,
  - malformed-entry partial skip behavior,
  - corrupt snapshot quarantine preservation,
  - metadata-only persistence on next save,
  - dirty-flag behavior on lock-timeout save skips.
- Added startup lifecycle regressions in `packages/mcp/src/server/start-server.lifecycle.test.ts` for:
  - CLI one-shot recovery behavior,
  - CLI recovery-error handling without enabling watcher/background loops.

### Modified
- Hardened snapshot lock behavior in `packages/mcp/src/core/snapshot.ts`:
  - removed CPU-spin fallback in lock wait path,
  - stale lock break now checks lock metadata owner PID liveness,
  - stale-lock break attempts now use the same bounded wait/abort behavior as normal lock retries,
  - lock retries fail gracefully when wait path is unavailable.
- Hardened CLI startup lifecycle recovery in `packages/mcp/src/server/start-server.ts`:
  - `cli` mode now runs one-shot interrupted-index recovery (`verifyCloudState`) pre-connect (before first tool request is accepted),
  - watcher/background sync loops remain disabled in CLI mode.
- Hardened merge precedence with deterministic state-class rules:
  - `indexing` > `indexfailed|requires_reindex` > `indexed|sync_completed`,
  - stale indexing protection avoids old high-progress records overriding fresh indexing state.
- Hardened load/save behavior:
  - `loadCodebaseSnapshot` persists only on semantic representation change,
  - canonical compare uses normalized `codebases` map (not snapshot-level `lastUpdated`),
  - persisted snapshot merge loader now rejects malformed non-v1/v2/v3 payloads deterministically (warn + local-only merge fallback),
  - corrupt snapshots are preserved as `.corrupt-<pid>-<timestamp>-<suffix>.json`.
- Improved type/API safety:
  - narrowed `AccessGateResult.reason` to explicit union,
  - `getCodebaseStatus` now returns `CodebaseInfo['status'] | 'not_found'`.
- Added metadata setter guard rails:
  - metadata-only setters cannot mutate derived-state-driving fields (`status`, `indexingPercentage`, `indexedFiles`),
  - metadata updates set dirty state and persist on next successful save without rebuilding derived state.

### Docs
- Updated `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` with snapshot persistence hardening semantics and evidence anchors.

## [2026-02-28] PI Satori Bridge Contract Alignment and Robust Parsing

### Modified
- Hardened `examples/pi-extension/satori-bridge/index.ts` CLI JSON parsing:
  - first parses full stdout as JSON,
  - falls back deterministically to parsing the last non-empty stdout line,
  - returns combined parse diagnostics when both attempts fail.
- Preserved structured envelope JSON text blocks from truncation in bridge normalization to avoid corrupting `status`/`hints` payloads consumed by deterministic navigation flows.
- Cleaned bridge extension registration formatting and health-check message transport labeling consistency.
- Removed unused `extractEnvelopeStatus` helper from `examples/pi-extension/satori-bridge/recovery.ts`.
- Aligned PI extension docs/config defaults with runtime call-timeout default (`callTimeoutMs=600000`) in:
  - `examples/pi-extension/satori-bridge/README.md`
  - `examples/pi-extension/satori-bridge/config.example.json`
  - `examples/pi-extension/satori-bridge/config.json`
- Updated `examples/pi-extension/satori-bridge/skills/satori-cli/SKILL.md` to make required argument contracts explicit for:
  - `file_outline(path, file, resolveMode="exact", ...)`
  - `read_file(path=<absolute file>, open_symbol=...)`
  - plus explicit sync-vs-reindex and extension-unavailable fallback guidance.

### Tests
- Extended `examples/pi-extension/satori-bridge/index.test.ts` with deterministic coverage for:
  - strict JSON parse,
  - noisy-stdout last-line parse fallback,
  - dual-failure parse diagnostics,
  - normalization behavior for plain text truncation vs structured envelope pass-through.
- Validation completed:
  - `pnpm -C examples/pi-extension/satori-bridge test`
  - `pnpm -C examples/pi-extension/satori-bridge typecheck`

## [2026-02-28] Backfilled Coverage: CLI, Bridge, and Index Readiness Follow-ups

### Added
- Added index-state planning documentation in `docs/INDEX_STATE_STABILITY_PLAN.md` (`27a50d5`).
- Added/expanded CLI implementation contract details in `docs/SATORI_CLI_IMPLEMENTATION_PLAN.md` (`4823565`), including:
  - stdout JSON-only invariants for `help`/`version`,
  - non-ok structured envelope exit behavior,
  - long-running `manage_index create|reindex` wait/poll expectations.
- Added bridge reliability hardening artifacts (`cd22074`):
  - `docs/SATORI_BRIDGE_RELIABILITY_HARDENING_PLAN.md`
  - `examples/pi-extension/satori-bridge/recovery.test.ts`
  - `examples/pi-extension/satori-bridge/recovery.ts`
  - `examples/pi-extension/satori-bridge/.env.satori.example`

### Modified
- Backfilled `fix(mcp): stabilize index readiness and enforce manage_index poll floor` (`fc27fbc`):
  - enforced a minimum polling timeout floor for `manage_index create|reindex`,
  - emitted deterministic JSON tool-error payloads on call timeout instead of empty stdout,
  - hardened `list_codebases` completion-proof handling (stale local, fingerprint mismatch, probe-failed stability behavior) with expanded deterministic tests.
- Backfilled `fix(list_codebases): remove unnecessary note field from ready status entries` (`78e24e7`) to keep Ready output clean/stable.
- Backfilled `fix(cli): support source-mode launch and harden bridge timeout floor` (`b86a393`):
  - added source-mode server entry resolution (`index.ts` with `--import tsx` fallback when dist JS is unavailable),
  - propagated/manage-index timeout floor handling in the PI bridge path with deterministic tests.
- Backfilled `feat(example): sync pi satori-bridge extension snapshot` (`c223c44`):
  - synchronized extension snapshot files and lockfile,
  - updated bridge config/docs defaults and repo-agnostic config guidance,
  - introduced the `satori-cli` skill path and aligned extension test scaffolding.
- Backfilled `fix(bridge): harden cli stdio recovery and add protocol smoke tests` (`cd22074`):
  - migrated bridge transport to shell-first `satori-cli` invocation flow,
  - added protocol-failure retry classification/recovery mechanics and smoke tests,
  - updated bridge README/config contracts around guard and reliability behavior.

## [2026-02-28] MCP Index State Stability Hardening

### Release Versions
- Repository version: `0.3.0`
- `@zokizuan/satori-mcp`: `4.2.0`

### Added
- Added deterministic index-state stability coverage:
  - `packages/mcp/src/core/handlers.index_state_stability.test.ts`
  - repeated-read stability assertion in `packages/mcp/src/tools/list_codebases.test.ts`

### Modified
- Removed foreground destructive cloud reconciliation from search/file outline/call graph/index create paths.
- Added shared completion-proof validation with explicit outcomes:
  - `valid`
  - `stale_local`
  - `fingerprint_mismatch`
  - `probe_failed`
- Enforced marker-doc canonical-path + strict runtime fingerprint validation gates.
- Mapped `fingerprint_mismatch` to `requires_reindex` envelopes and stale-local proof failures to deterministic `not_indexed` envelopes.
- Kept `probe_failed` non-authoritative to avoid response-level flapping while preserving local indexed status.
- Updated `manage_index status` messaging for stale-local and probe-failed proof states.
- Updated docs contract in `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` to reflect maintenance-only non-destructive cloud reconcile.

## [2026-02-27] Satori CLI v1.1 (Hardened stdio) + Regression Follow-ups

### Release Versions
- Repository version: `0.3.0`
- `@zokizuan/satori-mcp`: `4.1.0` (bin/interface expansion in-package)

### Added
- Added a second executable in `@zokizuan/satori-mcp`:
  - `satori` (MCP server entrypoint)
  - `satori-cli` (shell-first client over MCP stdio)
- Added CLI modules under `packages/mcp/src/cli/`:
  - command routing (`tools list`, `tool call`, wrapper mode)
  - MCP stdio client transport (`Client` + `StdioClientTransport`)
  - raw argument modes (`--args-json`, `--args-file`, `--args-json @-`)
  - schema-subset wrapper parsing with deterministic fallback to raw JSON args
  - structured output/error formatting and deterministic error tokens
- Added server bootstrap split under `packages/mcp/src/server/`:
  - shared server factory `start-server.ts`
  - stdio hardening utilities in `stdio-safety.ts`
- Added targeted tests:
  - `packages/mcp/src/server/stdio-safety.test.ts`
  - `packages/mcp/src/server/start-server.lifecycle.test.ts`
  - `packages/mcp/src/cli/index.test.ts`
  - `packages/mcp/src/cli/args.test.ts`

### Modified
- Refactored MCP entrypoint bootstrap (`packages/mcp/src/index.ts`) to be ESM-safe for stdio patch ordering:
  - no project static imports before patching
  - dynamic import of server modules after stdio safety setup
- Introduced run-mode behavior split with `SATORI_RUN_MODE=cli`:
  - disables startup background sync loop, watcher startup, and startup reconciliation
  - preserves on-demand tool execution semantics
- Hardened stdio discipline:
  - console output redirected to stderr
  - cli-mode stdout guard for accidental non-protocol writes
  - transport writes routed through preserved protocol stdout writable
- CLI error mapping aligned with indexing-lock envelopes:
  - exits `1` on `isError=true`
  - exits `1` on structured envelopes where `status != "ok"` even when `isError=false`
- Added `manage_index create|reindex` wait behavior with status polling to avoid premature child shutdown for long-running indexing actions.
- Updated package wiring:
  - `package.json` `bin` includes `satori-cli`
  - `fix:bin-perms` applies executable bit to both `dist/index.js` and `dist/cli/index.js`

### Fixed
- Fixed symlinked-bin execution detection so `satori-cli` runs correctly when installed via linked/symlinked package managers.
- Fixed wrapper `--debug` handling by parsing global flags only from the leading argv segment, preserving tool-level `--debug` in wrapper mode.
- Fixed `manage_index create|reindex` flow to evaluate the initial call result before polling, preventing immediate errors/non-ok envelopes from being masked by status polling.

### Docs
- Updated implementation/status docs:
  - `docs/SATORI_CLI_IMPLEMENTATION_PLAN.md`
  - `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`
- Expanded MCP README with shell CLI usage/contract details:
  - output + exit-code contract
  - run-mode semantics
  - wrapper parsing subset and global-flag placement rule
  - boolean wrapper-flag behavior

## [2026-02-27] Repository Minor Version Bump and Rerelease

### Release Versions
- Repository version: `0.2.0`
- Git tag: `v3.9.0`

### Modified
- Bumped repository minor version from `0.1.5` to `0.2.0` for the rerelease cycle.

## [2026-02-27] Indexing Lock Hardening Plan Contract Finalization

### Modified
- Added and finalized [`docs/INDEXING_LOCK_HARDENING_PLAN.md`](/home/hamza/repo/satori/docs/INDEXING_LOCK_HARDENING_PLAN.md) as the execution contract for indexing-state hardening.
- Locked deterministic decisions in the plan for:
  - per-codebase indexing lock behavior,
  - stable non-`ok` reason codes (`indexing`, `requires_reindex`, `not_indexed`),
  - single completion SSOT (`marker_doc`),
  - deterministic call-graph note capping/truncation metadata.
- Added explicit actionable tasks (`T1`-`T14`) and enforced red-green-refactor execution order.
- Updated the plan checklist to completion and aligned validation checklist status with executed test/build gates.

## [2026-02-26] MCP Determinism and Documentation Alignment

### Modified
- Enforced deterministic `list_codebases` presentation ordering:
  - fixed section order (`Ready`, `Indexing`, `Requires Reindex`, `Failed`),
  - lexicographic path ordering inside each section with locale-independent string comparison.
- Updated `call_graph` tool description and MCP README wording to capability-driven language support phrasing (current default support: TS/JS/Python via `callGraphQuery` capability set).
- Updated the authoritative end-to-end behavior spec to:
  - mark hand-maintained contract expectations explicitly,
  - reflect verified deterministic `list_codebases` ordering,
  - remove resolved drift items from “Known Gaps”.

### Tests
- Added `packages/mcp/src/tools/list_codebases.test.ts`:
  - asserts deterministic bucket order and intra-bucket sorted paths from unsorted snapshot input,
  - validates indexing progress formatting remains stable,
  - validates no cross-bucket path duplication,
  - preserves empty-state output contract.

## [2026-02-26] P0 Sync Identity and Determinism Hardening

### Modified
- Enforced snapshot-path SSOT in `@zokizuan/satori-core` `FileSynchronizer`:
  - added explicit identity helpers (`canonicalizeSnapshotIdentityPath`, `snapshotPathFromCanonicalPath`, `getSnapshotPathForCodebase`),
  - routed constructor snapshot initialization and `deleteSnapshot(...)` through the same identity path flow.
- Added a dedicated CI gate job for core sync invariants:
  - `core_sync_gate` on Ubuntu/Node 20,
  - runs `pnpm --filter @zokizuan/satori-core build` and `pnpm --filter @zokizuan/satori-core test:integration`.
- Clarified docs-scope rerank policy text in MCP docs/schema descriptions:
  - `scope:"docs"` skips reranking by policy in the current public tool surface.
- Updated core package README sync description to reflect stat-first + hash-on-change behavior.

### Tests
- Expanded `tests/integration/synchronizer.integration.test.mjs` with P0 determinism/identity coverage:
  - snapshot identity parity across real/trailing-slash/resolve/symlink variants,
  - deleteSnapshot parity across path variants (A deletes B),
  - true file removal detection (no over-preservation),
  - unreadable file hash-fail preservation with `partialScan` assertions,
  - unreadable directory preservation (no bogus removals),
  - normalization SSOT checks for persisted snapshot keys and diff outputs (including backslash forms and `..` rejection),
  - deterministic prefix normalization/compression vector coverage.

## [2026-02-26] MCP Surface Simplification and Self-Healing Navigation

### Release Versions
- `@zokizuan/satori-mcp`: `3.10.0`

### Modified
- Simplified `search_codebase` rerank control to policy-only behavior:
  - removed public `useReranker` input from schema/handlers/docs/tests,
  - docs-scope now deterministically skips reranking by policy,
  - expanded debug observability under `hints.debugSearch.rerank` (`enabledByPolicy`, capability/instance flags, attempted/applied, candidate counts, and failure phase).
- Removed `manage_index.splitter` from the public contract and indexing handlers:
  - public create/reindex flow is AST-based without user-selectable splitter knobs,
  - removed splitter validation/fallback log paths from MCP handler flow.
- Added deterministic grouped-result navigation recovery when call graph traversal is unavailable:
  - new `results[].navigationFallback` sibling field (kept separate from `callGraphHint`),
  - always includes runnable `readSpan`,
  - includes `fileOutlineWindow` only when outline extension support and v3 sidecar readiness are both present.
- Hardened `read_file` annotated/open_symbol remediation hints:
  - removed misleading `path.dirname(file)` reindex advice,
  - emits structured runnable `hints.nextSteps` tool calls,
  - treats `indexing` roots as discovery-only (status check suggested, no forced reindex step),
  - filters non-searchable candidate roots out of remediation steps.

### Compatibility Notes
- `search_codebase.useReranker` and `manage_index.splitter` are removed from the public schema.
- Older clients sending these fields are ignored by the non-strict input parsing path and receive no behavioral override from them.

### Tests
- Updated contract tests for schema/tool-description drift removal (`useReranker`, `splitter`).
- Added deterministic coverage for:
  - rerank policy debug-state contracts,
  - grouped `navigationFallback` shape/gating,
  - structured `read_file` remediation `nextSteps` behavior.

## [2026-02-26] Core Sync Determinism and Hash-on-Change Refactor

### Release Versions
- `@zokizuan/satori-core`: `0.3.0`

### Modified
- Replaced full-content rehash-on-every-sync in `@zokizuan/satori-core` `FileSynchronizer` with a stat-first flow:
  - scans file metadata first,
  - reuses prior hashes when stat signatures are unchanged,
  - hashes bytes only for changed/new candidates.
- Replaced Merkle DAG serialization/compare with deterministic `merkleRoot` computation from sorted `(relativePath, hash)` entries.
- Added canonical codebase-path snapshot identity alignment (realpath-normalized path hashing), matching collection identity behavior.
- Added deterministic partial-scan preservation semantics:
  - unreadable paths/directories no longer create bogus `removed` churn,
  - unscanned prefixes are normalized, segment-safe, sorted, and compressed.
- Extended synchronizer diagnostics/controls:
  - `checkForChanges` now emits `hashedCount`, `partialScan`, `unscannedDirPrefixes`, and `fullHashRun`,
  - added optional env controls `SATORI_SYNC_HASH_CONCURRENCY` and `SATORI_SYNC_FULL_HASH_EVERY_N`.
- Migrated synchronizer snapshot state to v2 (`fileHashes`, `fileStats`, `merkleRoot`, partial-scan metadata, counter) with backward-compatible load/migration behavior.

### Tests
- Added deterministic integration coverage in `tests/integration/synchronizer.integration.test.mjs` for:
  - unchanged-run no-rehash behavior,
  - restart detection correctness,
  - binary hashing update detection,
  - partial-scan preservation,
  - segment-safe prefix handling (`a` vs `ab`).
- Updated `reindex_by_change` integration assertions to include `changedFiles` in expected payloads.

## [2026-02-26] Neural Reranker Integration (Post-Filter, Pre-Group)

### Modified
- Integrated VoyageAI neural reranking into `search_codebase` candidate flow:
  - runs after hard filters (`scope/path/must/exclude`) and must-retry expansion settles,
  - runs before grouping/diversity selection,
  - applies rank-only rerank signal with deterministic tie-breaking.
- Hardened deterministic response stability in `search_codebase` by:
  - normalizing warnings with sorted unique ordering before envelope emission,
  - using nullable-safe path tie-break comparators in candidate and group ranking sorts.
- Stabilized `auto_changed_first` ranking inputs to reduce run-to-run ordering drift:
  - git changed-file discovery now reads tracked changes only (`--untracked-files=no`),
  - transient git-status failures now reuse cached changed-file state instead of flipping boost availability to empty.
- Added reranker control input:
  - `useReranker` (`true` force, `false` disable, omitted = auto),
  - auto mode is performance-profile-aware via `CapabilityResolver`,
  - auto mode skips `scope:"docs"` by default unless explicitly forced.
- Improved reranker debuggability without leaking exceptions:
  - under `debug:true`, rerank failures include `hints.debugSearch.rerank.errorCode` and `failurePhase`.
- Added deterministic reranker configuration constants:
  - `SEARCH_RERANK_TOP_K = 50`,
  - `SEARCH_RERANK_RRF_K = 10`,
  - `SEARCH_RERANK_WEIGHT = 1.0`,
  - bounded rerank document construction (`max lines/chars`).
- Fixed MCP server initialization ordering so `ToolHandlers` receives initialized reranker instances (preventing silent no-rerank runtime behavior).
- Updated telemetry to emit real reranker diagnostics:
  - `reranker_attempted`,
  - `reranker_used`.

### Added
- Added/expanded test coverage for reranker behavior:
  - docs-scope auto skip + explicit enable,
  - missing-capability warning path,
  - reranker-failure degraded path,
  - representative chunk change before grouping,
  - telemetry reranker usage reporting,
  - changed-files boost determinism guards (ignore untracked status entries + stale-cache fallback on git-status failures).

## [2026-02-26] Sole-User Retrieval Precision Upgrades (Deterministic)

### Modified
- Extended `search_codebase` query handling with deterministic prefix operators:
  - `lang:`, `path:`, `-path:`, `must:`, `exclude:` (with quoted values and `\` escape for literal tokens).
- Added bounded must-satisfaction retries with stable degraded warning:
  - `FILTER_MUST_UNSATISFIED` when constraints remain unsatisfied after capped retries.
- Added `rankingMode` input (`default` | `auto_changed_first`) and defaulted to `auto_changed_first` for changed-file-aware ranking.
- Enabled deterministic grouped diversity selection by default (caps per file/symbol with one deterministic relaxation pass).
- Added debug explainability payload under `debug:true` via `hints.debugSearch` (operator summary, filter summary, retries, changed-file boost, diversity summary).

### Added
- Added retrieval eval regression suite:
  - `packages/mcp/src/core/search.eval.test.ts` with deterministic matrix checks for runtime/docs scope invariants and ranking determinism.

### Tests
- Added focused `handleSearchCode` coverage for:
  - operator parsing + deterministic filter behavior,
  - must retry degradation warning path,
  - diversity default behavior,
  - changed-files boost behavior vs `rankingMode:"default"`.

## [2026-02-26] Deterministic Jump Contract Tightening

### Release Versions
- `@zokizuan/satori-mcp`: `3.8.0`
- `@zokizuan/satori-core`: `0.2.0`

### Modified
- Hardened exact symbol resolution determinism in `file_outline(resolveMode:"exact")` by explicitly sorting exact matches before truncation/response emission.
- Clarified `read_file.open_symbol` contract:
  - exact symbol resolution is scoped to the same file passed in `read_file.path`.
  - unresolved repo-root cases now return a safer structured `requires_reindex` guidance flow (discover root via `list_codebases` / `manage_index status`, then reindex that root), without guessing `path.dirname(file)` as repo root.
- Updated generated MCP docs text to align with the exact-file `open_symbol` behavior.

### Added
- Added explicit README reference for `read_file.open_symbol` object fields (`symbolId`, `symbolLabel`, `start_line`, `end_line`) outside generated tool blocks to avoid doc drift.

### Tests
- Added `file_outline` exact-mode regression for unmatched symbol queries in existing files (`status:"not_found"` + `outline:null`).
- Strengthened ambiguity determinism coverage by feeding unsorted sidecar nodes and asserting stable candidate order.

## [2026-02-26] Agent-Native Search Noise Mitigation Hints

### Release Versions
- `@zokizuan/satori-mcp`: `3.7.0`
- `@zokizuan/satori-core`: `0.2.0`

### Added
- Added deterministic `search_codebase` response hints for noisy top results:
  - `hints.version = 1`
  - `hints.noiseMitigation` with `topK`, category ratios, suggested `.satoriignore` patterns, debounce target, and next-step guidance.
- Added category-based noise analysis with fixed precedence (`generated > tests > fixtures > docs > runtime`) to keep hint behavior stable across runs.

### Modified
- Updated MCP tool descriptions to teach zero-context agents the remediation flow directly from tool metadata:
  - `search_codebase`: use `scope:"runtime"` first, use `scope:"mixed"` when docs + runtime are both needed, and mitigate persistent noise via repo-root `.satoriignore`.
  - `manage_index`: clarifies `sync` as immediate convergence path after ignore edits and reserves `reindex` for rebuild/recovery.
- Unified watch debounce fallback around a shared default constant to avoid drift in emitted guidance.

### Tests
- Added/extended regression coverage for:
  - tool description remediation guidance
  - noise-mitigation hint emission for noise-dominant top results
  - omission of hints for runtime-dominant top results

## [2026-02-26] Ignore-Control Live Validation and Docs Alignment

### Validated
- Verified live in `/home/hamza/repo/satori` that `.satoriignore` updates reconcile without full reindex:
  - Newly ignored file disappeared from `search_codebase` results after the debounce window.
  - Removing ignore rules made the same file searchable again via normal sync/reconcile flow.
  - No `manage_index action:"reindex"` was required during the roundtrip.

### Docs
- Updated documentation surfaces to reflect no-reindex ignore reconciliation behavior and debounce expectations:
  - `README.md`
  - `ARCHITECTURE.md`
  - `satori-landing/index.html`
  - `satori-landing/architecture.html`

## [2026-02-26] Ignore-Reconciliation Hardening (No-Reindex Path)

### Release Versions
- `@zokizuan/satori-mcp`: `3.6.0`
- `@zokizuan/satori-core`: `0.2.0`

### Fixed
- Hardened ignore-rule reconciliation to stay correct without full reindex in multi-codebase scenarios:
  - ignore matcher state is now sourced from Context as the single authority (removed duplicate repo-ignore loading in SyncManager).
  - reconciliation delete source is guaranteed from pre-reload indexed manifest state, preventing missed removals when post-reload synchronizer tracking changes.
  - added self-healing delete behavior for paths now ignored by the active matcher.
- Improved codebase identity and path normalization stability:
  - canonical collection identity uses realpath-normalized roots.
  - relative-path normalization now includes a symlink-safe fallback to resolved root when canonical-root relative calculation is invalid.

### Tests
- Added regression coverage for pre-reload manifest ordering during ignore reconciliation to prevent future deletion regressions.
- Extended sync watcher/reconcile tests for ignore-change handling and deterministic outcomes.

## [2026-02-25] Language Adapter Registry and JavaScript Symbol Flow

### Release Versions
- `@zokizuan/satori-mcp`: `3.5.0`
- `@zokizuan/satori-core`: `0.1.7`

### Added
- Added a shared language adapter registry in `@zokizuan/satori-core` to centralize language IDs, aliases, extensions, and capabilities (`astSplitter`, `symbolMetadata`, `callGraphBuild`, `callGraphQuery`, `fileOutline`).

### Modified
- Refactored splitter/runtime language mapping to use the shared registry as the single source of truth.
- Extended JS support across symbol/navigation flow:
  - `call_graph` query gating now supports JavaScript extensions (`.js`, `.jsx`, `.mjs`, `.cjs`) in addition to TS/Python.
  - `file_outline` support gating now includes JavaScript files.
  - `read_file(mode:"annotated")` now treats JavaScript files as outline-capable.
- Updated MCP docs/tool descriptions to reflect TS/JS/Python call-graph support.

### Tests
- Added regression coverage for JavaScript call-graph query routing and JavaScript outline-capable paths (`file_outline`, `read_file(mode:"annotated")`).

## [2026-02-26] Fingerprint Diagnostics and Version-Bump Guard

### Release Versions
- `@zokizuan/satori-mcp`: `3.4.0`
- `@zokizuan/satori-core`: `0.1.7`

### Added
- Added explicit compatibility diagnostics for migration visibility:
  - `search_codebase` requires-reindex responses now include `compatibility` with runtime/index fingerprints and reindex metadata.
  - `call_graph` requires-reindex responses now include the same `compatibility` diagnostics.
  - `manage_index action:"status"` now prints runtime/index fingerprint diagnostics and reindex reason when available.
- Added CI enforcement for MCP package versioning:
  - New script `scripts/check-mcp-version-bump.sh`.
  - CI now fails when package-relevant MCP source changes are made without a `packages/mcp/package.json` version bump.

### Tests
- Added/expanded regression coverage for:
  - `search_codebase` requires-reindex compatibility diagnostics.
  - `call_graph` requires-reindex compatibility diagnostics.
  - `manage_index status` fingerprint diagnostics (including access-gate blocked paths).

## [2026-02-25] Call Graph Alias Compatibility and Search Fault-Injection Coverage

### Release Versions
- `@zokizuan/satori-mcp`: `3.3.0`
- `@zokizuan/satori-core`: `0.1.7`

### Fixed
- Added `call_graph.direction="bidirectional"` compatibility and normalized dispatch to canonical `direction:"both"`.
- Preserved strict validation for invalid direction values outside the supported canonical/alias set.

### Tests
- Added `call_graph` tool tests for alias normalization and invalid-direction validation.
- Added deterministic, test-only fault-injection coverage for `search_codebase` semantic pass failures (`primary|expanded|both`), including:
  - partial failure warning emission
  - full failure structured error path
  - non-test-mode guard behavior

## [2026-02-26] Call Graph Declaration Parsing Hardening

### Release Versions
- `@zokizuan/satori-mcp`: `3.2.0`
- `@zokizuan/satori-core`: `0.1.7`

### Fixed
- Prevented false-positive self-loop edges in `call_graph` caused by declaration lines being parsed as call sites.
- Hardened definition detection to be case-insensitive for `function|class|def` and method signatures.

### Tests
- Added regression coverage that asserts non-recursive symbols do not emit declaration self-loop edges.

## [2026-02-26] Runtime Scope Filter Hardening

### Release Versions
- `@zokizuan/satori-mcp`: `3.1.0`
- `@zokizuan/satori-core`: `0.1.7`

### Fixed
- Hardened `search_codebase` path categorization for strict scope filtering:
  - Top-level `tests/` and `test/` paths are now classified as test paths.
  - Top-level `docs/` plus `doc/`, `documentation/`, `guide/`, and `guides/` paths are now classified as docs paths.
- Closed runtime leakage where `scope:"runtime"` could include top-level test fixture files (for example `tests/fixtures/...`).

### Tests
- Extended scope regression coverage:
  - Runtime scope now explicitly verifies exclusion of `tests/fixtures/offline-corpus/...`.
  - Docs scope now verifies inclusion of non-markdown files under `docs/` (for example `docs/runtime-helper.ts`).

## [2026-02-26] Navigation-First Fast Path

### Added
- New first-class `file_outline` MCP tool:
  - Input: `{ path: <codebaseRoot>, file: <relativePath>, start_line?, end_line?, limitSymbols? }`
  - Output statuses: `ok | not_found | requires_reindex | unsupported`
  - Sidecar-backed symbol navigation with deterministic ordering and per-symbol `callGraphHint`
  - `hasMore` flag for truncation awareness after line-window filtering
- New handler-level and tool-level regression tests for `file_outline`.

### Modified
- `read_file` now supports `mode: "plain" | "annotated"`:
  - `plain` behavior remains backward-compatible text output.
  - `annotated` returns content plus `outlineStatus`, `outline`, and `hasMore`.
  - Content reads no longer fail when outline metadata is unavailable (`requires_reindex`/`unsupported` graceful degradation).
- `search_codebase` internal two-pass retrieval is now concurrent via `Promise.allSettled`:
  - deterministic fusion order preserved
  - partial-pass degradation is explicit via `warnings[]`
  - full pass failure returns structured tool error
- Search telemetry now includes pass diagnostics:
  - `search_pass_count`
  - `search_pass_success_count`
  - `search_pass_failure_count`
  - `parallel_fanout`
- Search response envelope now formally includes optional `warnings?: string[]`.

### Docs
- Updated:
  - `README.md`
  - `docs/ARCHITECTURE.md`
  - `packages/mcp/README.md`
  - `satori-landing/index.html`
  - `satori-landing/architecture.html`
- Documentation now reflects:
  - 6-tool MCP surface
  - `file_outline` workflow
  - `read_file(mode="annotated")`
  - parallel search pass warning behavior

## [2026-02-25] Satori UX Overhaul

### Release Versions
- `@zokizuan/satori-mcp`: `3.0.0`
- `@zokizuan/satori-core`: `0.1.7`

### Added
- New first-class `call_graph` MCP tool for callers/callees traversal.
- Persistent call-graph sidecar index (built during index/sync lifecycle, loaded via snapshot state).
- Structured call-graph diagnostic notes:
  - `missing_symbol_metadata`
  - `dynamic_edge`
  - `unresolved_edge`
- Deterministic sorting guarantees for:
  - search groups
  - call-graph nodes
  - call-graph edges (`src`, `dst`, `kind`, `site.startLine`)
  - call-graph notes
- Hard `requires_reindex` response envelopes with explicit remediation (`hints.reindex`) in `search_codebase` and `call_graph`.
- `manage_index` action `reindex` (idempotent rebuild path).
- New regression coverage for sidecar metadata gaps, deterministic ordering, requires-reindex envelopes, and tool-surface registration.

### Removed
- Embedded call-graph flags from `search_codebase` (graph traversal is now isolated to `call_graph`).
- Synthetic/fabricated symbol ID generation in call-graph sidecar build.
- Regex fallback symbol extraction path used to invent symbol identities when metadata was missing.
- Legacy `search_codebase` parameter surface (`extensionFilter`, `excludePatterns`, ignore toggles, and related legacy switches).

### Modified
- `search_codebase` public contract now uses:
  - `scope: runtime | mixed | docs`
  - `resultMode: grouped | raw`
  - `groupBy: symbol | file`
  - `limit` semantics: max groups (grouped) / max chunks (raw)
  - optional `debug` traces
- Grouped search results now include:
  - stable `groupId`
  - nullable `symbolId` / `symbolLabel`
  - `collapsedChunkCount`
  - aggregated `indexedAt` (`indexedAtMax`)
  - `stalenessBucket`
  - discriminated `callGraphHint` (`supported: true|false`)
- Freshness reporting now returns structured `freshnessDecision` envelopes.
- Staleness bucketing standardized to:
  - Fresh: `<= 30m`
  - Aging: `<= 24h`
  - Stale: `> 24h`
- Sidecar behavior for missing metadata now skips node/edge emission and records explicit notes.

### Docs
- Updated root `README.md`, architecture docs, and landing pages (`satori-landing/index.html`, `satori-landing/architecture.html`) to reflect:
  - 5-tool MCP surface
  - runtime-first grouped search contract
  - first-class call-graph workflow
  - v3 reindex gate semantics
