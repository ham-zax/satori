# 2026-07-10 Codebase Review Remediation

## Scope

Repository-wide correctness, determinism, security, lifecycle, public-contract, and dependency review at `3de819a`.

Status values are `open`, `in_progress`, and `verified`. A finding is `verified` only after its focused regression test and the relevant package gate pass.

## Findings

| ID | Severity | Boundary and observed behavior | Required invariant | Proof path | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | High | `FileSynchronizer.scanDirectory` follows directory symlinks outside the indexed root. | Index and sync file reads remain inside the canonical codebase root and do not traverse symlink cycles. | Core synchronizer regression test plus core tests. | verified |
| R2 | High | Production MCP startup does not call `runPostConnectStartupLifecycle`. | MCP startup runs interrupted-index recovery, background sync, and optional watcher startup exactly once; CLI mode runs recovery only. | Production-start lifecycle test plus MCP server tests. | verified |
| R3 | High | The installer-managed launcher does not forward `SIGINT` or `SIGTERM` to its runtime child. | Stopping the launcher stops and reaps the runtime child without leaving a registered owner. | Generated-launcher process test plus CLI tests. | verified |
| R4 | Medium | Incremental sync persists the filesystem checkpoint before vector/navigation mutation succeeds. | Failed or interrupted remote mutation leaves the previous committed checkpoint available for deterministic retry. | Core failure/retry regression test plus core tests. | verified |
| R5 | Medium | `deleteFileChunks` does not escape quotes in Milvus string literals. | Every legal relative path produces a valid Milvus filter expression. | Core filter regression test plus core tests. | verified |
| R6 | Medium | The production local `ToolContext` omits `runtimeOwnerGate`, so `list_codebases` omits owner diagnostics. | `list_codebases` and `manage_index status` observe the same runtime-owner source. | Production-context/list test plus MCP tests. | verified |
| R7 | Medium | `satori-cli doctor` reports unsupported embedding providers as healthy. | Doctor rejects every provider value outside the runtime-supported provider set. | Doctor regression test plus CLI tests. | verified |
| R8 | Medium | The Pi bridge omits `manage_index repair` and pins stale CLI `0.4.2`; version checks do not scan it. | Bridge schema and fallback version match the authoritative MCP/CLI contracts. | Pi bridge tests and version-freshness tests. | verified |
| R9 | Medium | Production resolution includes vulnerable `ws@8.18.3`. | Production dependency resolution contains no known high-severity advisory with an available compatible fix. | `pnpm audit` and relevant provider/package tests. | verified |
| R10 | Low | Maintainer/features documentation describes a stale four-tool surface and obsolete create/reindex polling. | Public and maintainer documentation matches the six-tool, kickoff-response contract. | Documentation/manifest checks plus scoped literal checks. | verified |

## Review Baseline

- `pnpm run check`: passed.
- Core tests: 183 passed.
- CLI tests: 71 passed.
- Pi bridge tests: 10 passed.
- Script tests: 16 passed.
- Integration tests: 30 passed.
- MCP tests: 589 passed.
- `pnpm --filter @zokizuan/satori-mcp docs:check`: passed.
- `pnpm --filter @zokizuan/satori-mcp manifest:check`: passed.
- `pnpm audit`: failed with five advisories, including high-severity `ws` CVE-2026-48779.

## Change Policy

- Fix the owning boundary; do not add compatibility aliases or new public tools.
- Add the failing regression test before each behavior change.
- Update authoritative docs in the same patch when public behavior changes.
- Do not mark a finding verified from static inspection alone.
- Treat provider-backed `create` and `reindex` as expensive full rebuilds. Require explicit user approval before invoking either action.

## Live Sync Incident

- Before the reported restart, `manage_index status` already returned `missing_marker_doc`; the restart exposed an existing inconsistent state rather than creating it.
- The first recovery sync refused to refresh readiness because the remote collection contained stale chunks outside the current source set. Search proof also observed 50 missing expected chunks; a later sync observed 340 missing expected chunks in generation `gen_run_7d0b826b_423f_46b8_bcb7_350e4a31c41c`.
- The owning R4 defect was the old `checkForChanges()` contract: it persisted the new filesystem checkpoint before remote vector/navigation mutation and completion proof succeeded. A partial failure therefore removed the completion marker, left remote payload incomplete or stale, and erased the local delta needed by the next sync.
- The R4 fix now prepares the filesystem delta, performs remote mutation and readiness proof, and commits the checkpoint only after success. The failure/retry regression test proves the same modified file remains visible to the next sync attempt.
- A review worker invoked `reindex` despite low-confidence preflight; the tool returned `status: ok`, `REINDEX_PREFLIGHT_UNKNOWN`, and started background indexing. This invocation was not justified by an approved cost decision.
- A subsequent proof-only `repair` made no embedding calls but refused because it selected stale generation `gen_run_9badfb3e_12e8_48c1_9148_ca61461b5892`, while the failed local snapshot names generation `gen_run_7d0b826b_423f_46b8_bcb7_350e4a31c41c`.
- Repair now treats the snapshot `collectionName` as authoritative, forwards it through the MCP handler, and fails closed if that collection is absent. A regression test proves repair selects the snapshot-designated generation when multiple staged generations exist.

## Final Verification

- Core tests: 190 passed.
- MCP tests: 592 passed.
- CLI tests: 73 passed.
- Integration tests: 30 passed.
- Pi bridge tests: 12 passed.
- Script tests: 17 passed.
- `pnpm run check`, documentation checks, manifest checks, frozen install, and the high-severity audit gate passed.
- Three existing low/moderate audit advisories remain.
