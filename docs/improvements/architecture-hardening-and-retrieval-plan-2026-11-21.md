# Architecture Hardening, Compiler Guardrails & Retrieval Speed Plan, 21 November 2026

Sequenced execution plan turning the [21 November 2026 security & concurrency audit](bughunter-skill-audit-2026-11-21.md) into structural prevention, compile/lint enforcement, and a measured offline-retrieval latency improvement.

## Execution Protocol

Every slice follows five fixed steps before moving on:

1. **Owner check:** State `invariant | lifecycle | authoritative writer | persistence boundary | callers`.
2. **Failure-path test first:** Write deterministic regression tests (no sleeps) proving the broken behavior fails before the fix.
3. **Smallest complete repair at the authoritative owner:** Consolidate duplicated primitives rather than patching call sites ad hoc.
4. **Focused verification:** Run the slice's targeted unit tests plus `pnpm run check` (lint, typecheck, version freshness, package scope).
5. **Adversarial review & scope check:** Re-read changed paths trying to break them; verify `git diff --stat` stays scoped to the slice.

---

## Phase 1 — Close Architecture Leaks (Single Authoritative Owners)

### Slice 1A — Read-Only Git Runner (`P1-1`)
- **Status:** Done (`packages/mcp/src/core/read-only-git.ts`; migrated `working-tree-state.ts` and `change-impact.ts`; 38/38 tests + `pnpm run check` green)
- **Owner:** `packages/mcp/src/core/read-only-git.ts`
- **Invariant:** Every read-only Git subprocess prepends `["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.preloadIndex=false"]` before `-C <root>`.
- **Callers:** `packages/mcp/src/core/working-tree-state.ts`, `packages/mcp/src/core/change-impact.ts`.
- **Disproving checks:** Regression tests proving (a) repo-local `core.fsmonitor` does not execute during `getChangedFilesForCodebase`, `getWorkingTreeChangedPathsForPreflight`, or `detectChangeImpact`, and (b) `.git/index` is not modified by read-only probes.

### Slice 1B — Atomic File-Locking & Uninstall Mutual Exclusion (`P3-1`, `P2-8`, `P3-2`, `P3-4`, `P3-5`)
- **Status:** Done (`packages/core/src/utils/file-lock.ts` exported via `@satori-code/core/integration`; migrated `root-mutation-coordinator.ts`, `runtime-owner.ts`, `shared-runtime-lifecycle.ts`; split read-only `inspectManagedRuntimeLeases` from locked `inspectAndPruneManagedRuntimeLeasesUnderLock` in `managed-runtime-store.ts`/`runtime-activation.ts`; added `.mutation.lock` acquisition on `uninstall` and post-termination inode/ownership re-verification in `install.ts`)
- **Targets:**
  - `packages/mcp/src/core/runtime-owner.ts` (`withOwnerLock`): atomic hard-link publication, `bootId` + `processStartTime` liveness check, hard-link stale claim (`nlink === 2`), `fstatSync(fd)` identity verification before unlink, cleanup on write failure.
  - `packages/mcp/src/server/shared-runtime-lifecycle.ts` (`acquireLifecycleLock.release()`): capture `dev`/`ino` at acquisition, verify identity before unlink, ignore `ENOENT`.
  - `packages/core/src/generation/root-mutation-coordinator.ts` (`withRootKeyLock`): hold open fd or hard-link stale claim during break/release.
  - `packages/cli/src/install.ts` (`executeInstallCommand`, `purgeSatoriData`): acquire `acquireManagedRuntimeMutationLock` for non-dry-run `uninstall`, and re-verify `dev`/`ino` / detach-rename after `terminateSatoriServers` before `fs.rmSync` (`P2-7`).
  - `packages/cli/src/managed-runtime-store.ts` (`inspectManagedRuntimeLeases`): separate read-only inspection from destructive stale-lease deletion.

### Slice 1C — Root-Bound Filesystem, Symlinks, Integrity & Network Hygiene
- **Status:** Done (1C-1 through 1C-5 complete; `P2-1` collection-family hash deferred)
- **1C-1 (`P4-1` — High) — Done:** Constrained TypeScript 7.1 `ts.API` FS callbacks (`typescript-fs-boundary.ts`, `typescript-configured-project.ts`, `typescript-program-session.ts`, `typescript-bounded-reader.ts`, `typescript-fs-observation.ts`, `typescript-reference-cache.ts`, `typescript-semantic-analyzer.ts`) to canonical repo root + installed `typescript` `lib/`; rejected escaping symlinks and non-regular files (FIFOs) before `openSync` (49/49 focused TS semantic tests + `pnpm run check` green).
- **1C-2 (`P4-2`, `P4-3` — High/Medium-High) — Done:** Rejected live/dangling symlinks and non-regular files in `prepareProjectProfileInstall` (`satori.toml`), `prepareSkillInstall`/`prepareSkillRemoval` (`SKILL.md`), and `prepareSessionHookInstall` (`satori-hook.js`) via `writeTextFileAtomicNoFollow`; replaced unsafe `JSON.stringify` shell quoting with POSIX single-quote escaping (`formatSessionHookCommand`) and matched both legacy and single-quoted entries in `withoutSatoriSessionHooks` (`packages/cli/src/client-config-mutations.ts`, `client-config-mutations.security.test.ts`; 4/4 + 22/22 tests + `pnpm run check` green).
- **1C-3 (`P1-2`, `P1-3` — Medium) — Done:** Removed pre-authorization `existsSync`/`statSync` oracle in `packages/mcp/src/tools/read_file.ts`, moved final-symlink check ahead of manifest lookup in `published-file-authorization.ts` so symlink targets are never leaked, echoed `resolvedPath` on denials, and made `buildReadFileIgnoreMatcher` fail closed on missing/empty patterns while consulting live witness-cached `observeIndexPolicyInputs` (`read_file-security.test.ts`; 47/47 focused MCP tests + `pnpm run check` green).
- **1C-4 (`P1-4`, `P3-3`, `P4-4`, `P4-5`, `P4-6`, `P1-5`, `P1-6`) — Done:**
  - `model-store.ts`: added `O_NOFOLLOW` staging writes (`openStagingFileNoFollow`), corrupt-dir detach-rename, and in-process + cross-process hard-link `.lock` serialization (`acquireModelStagingLock`).
  - `ownership.ts`: added `createGlobExclude` (skipping `node_modules`, `.git`, `target`, symlinks) to all `fs.globSync` calls, capped matches at 2,000, and added 1 MiB `O_NOFOLLOW | O_NONBLOCK` cap in `readControlFile`.
  - `cbm-extractor-host.ts` / `cbm-extractor-child.ts`: added runtime `sizeBytes` + SHA-256 + non-symlink + containment verification on CBM WASM modules and 30 s timeout / 16 MiB stdout cap / `AbortSignal` kill for Swift child.
  - `env-manager.ts` & `voyage-api-key.ts`: validated key names, rejected `/[\r\n\0]/`, rejected symlinks via `lstatSync` + `O_NOFOLLOW`, preserved CRLF, and warned on broad `.env` perms (`mode & 0o077`).
  - `session-hook.ts`: stripped ANSI escapes, control chars, bidi overrides/isolates, zero-width chars, and Unicode Tags (`U+E0000–U+E007F`), and `JSON.stringify`-quoted paths in `additionalContext`.
- **1C-5 (`P2-2`, `P2-4`, `P2-5`, `P2-6`) — Done (Phase 1 complete; `P2-1` collection-family hash expansion deferred for live-index migration planning):**
  - `milvus-restful-vectordb.ts` & `zilliz-utils.ts`: defaulted non-loopback schemeless Milvus REST addresses to `https://` and set `redirect: 'error'` on authenticated requests.
  - `voyageai-reranker.ts`: set `redirect: 'error'` and truncated HTTP error bodies in thrown errors to 512 chars.
  - `.github/workflows/ci.yml` & `release.yml`: added `permissions: contents: read` to `ci.yml`, pinned all actions to immutable 40-char commit SHAs, and removed `cache: 'pnpm'` from `release.yml`.

---

## Phase 2 — Compiler & Oxlint Guardrails

### Slice 2A — Zero-Dependency `satori-guardrails` Oxlint JS Plugin & Type-Aware Lint
- **Status:** Done (local JS plugin live; `oxlint-tsgolint` / `@interfere/landmines` remain opt-in pending dependency approval)
- Probed `oxlint --type-aware` across `packages/{core,mcp,cli}`: Oxlint 1.89 requires the optional `oxlint-tsgolint` binary package (not currently installed).
- Created zero-dependency local Oxlint JS plugin `scripts/oxlint-satori-guardrails.mjs` (wired into `.oxlintrc.json` as `"error"` with tests in `scripts/oxlint-satori-guardrails.test.mjs`), enforcing:
  - `satori-guardrails/no-raw-git-exec` (production Git calls must go through `packages/mcp/src/core/read-only-git.ts`)
  - `satori-guardrails/no-shell-true` (no `shell: true` in production `child_process` calls)
  - `satori-guardrails/no-json-stringify-shell-hook` (no `JSON.stringify` interpolation inside shell hook `command:` templates)
  - `satori-guardrails/no-raw-lock-unlink` (no raw `unlinkSync`/`rmSync` on lock paths outside designated lock owners)

### Slice 2B — TypeScript Compiler Tightening
- **Status:** Done (`noImplicitOverride: true` and `noFallthroughCasesInSwitch: true` enabled across root and `packages/{core,mcp,cli}/tsconfig.json`, fixing all 8 missing `override` modifiers; `noUncheckedIndexedAccess` and branded boundary types deferred for a dedicated typing pass)

---

## Phase 3 — Offline Retrieval Speed & Accuracy Experiment (LateOn Reranking Bottleneck)

### Slice 3A — Baseline Profile & Measurement
- **Status:** Done (3-run baseline + micro-breakdown + depth scaling recorded on WSL2 16 CPUs, 4.8–4.9 GiB available RAM, `3 sessions × 4 threads`, pinned `lightonai/LateOn-Code-edge@07ef20f406c86badca122464808f4cac2f6e4b25`, 128 real `repo/satori` `search_rerank_document_v5` candidates)
- **Key profile findings:**
  - **Bottleneck:** Per-document ONNX forward pass dominates (`18.72 ms/doc` ONNX vs. `1.69 ms` tokenization, `0.09 ms` normalization; `3.38 ms` query encode; `94.78 ms` JS `maxSimScore` across all 128 docs).
  - **Cross-query byte-identity of unmodified `search_rerank_document_v5`:** `91.4%–93.0%` identical across unrelated queries (`86.7%–90.6%` with live `buildSearchRerankSourceReferences`, `98.4%` identical refs), proving query-independent ColBERT document-vector caching yields high hit rates without touching the frozen `search_rerank_document_v5` contract.
  - **Baseline 3-run medians (load `0.75–1.19`, peak process-tree RSS `921 MiB`):** `readyMs: 623 ms`, `q1ColdMs (128 unseen): 1460 ms`, `q1WarmMs (same query): 3.76 ms`, `q2SameDocsMs (new query, 100% doc overlap, 0% scoreCache): 1410 ms`, `q3RealProjMs (new query, real v5 projections, 93% overlap, 0% scoreCache): 1424 ms`.
  - **Cold depth scaling medians (`16 / 32 / 64 / 128` unseen docs):** `240 ms / 404 ms / 789 ms / 1487 ms`.

### Slice 3B — Byte-Bounded Bit-Identical ColBERT Document Vector Cache
- **Status:** Done (`packages/mcp/src/server/lateon-reranker-protocol.ts`, `lateon-reranker-encoder.ts`, `lateon-reranker-worker.ts`, `lateon-reranker.test.ts`; 36/36 passed + mutation check + `pnpm run check` green)
- **Implementation:**
  - Added `ByteBoundedCache` (`DOCUMENT_CACHE_MAX_BYTES = 64 MiB`, `DOCUMENT_CACHE_ENTRY_OVERHEAD_BYTES = 256`, `sha256(documentText)` witness key) in `lateon-reranker-worker.ts`, zero-copy `ArrayBuffer` transfer of normalized `Float64Array` vectors from encoder threads (`lateon-reranker-encoder.ts`, `lateon-reranker-protocol.ts`), within-request duplicate-document deduplication, and minimal `set_query` dispatch to only active miss lanes.
  - Strictly preserves `tokenCount` budget accounting and `search_rerank_document_v5` / `runtime-profile-v6-d128.json` contracts.
- **Before vs. After (3-run medians, same `3 × 4` plan, load `0.39–1.32`):**
  - `q2SameDocsMs` (new query, 100% overlap): **`1410 ms → 85 ms`** (**`16.6×` faster**, `-94.0%`).
  - `q3RealProjMs` (new query, real v5 projections, 93% overlap): **`1424 ms → 214 ms`** (**`6.7×` faster**, `-85.0%`).
  - `q1ColdMs` (128 unseen docs): `1460 ms → 1468 ms` (`+0.5%`, within noise).
  - `readyMs`: `623 ms → 623 ms`.
  - Peak process-tree RSS: **`921 MiB → 859 MiB`** (`-62 MiB`).
  - **Bit-identity verified:** All 5 rerank output SHA-256 digests (`r1`, `r1Warm`, `r2Same`, `r2Real`, `r3Real`) matched baseline bit-for-bit across all 3 trials, plus `Object.is` unit equivalence and real `createDocumentCacheKey` mutation check (failed 2/2 when broken, passed 2/2 restored).

### Slice 3C — Multi-Repo End-to-End Speed & Accuracy Improvements (5 Real Repos)
- **Status:** Done (`inspectable-source.ts`, `current-source-symbols.ts`, `search-rerank-source-references.ts`, `search-rerank-projection.ts`, `search-request-coordinator.ts`, `lateon-reranker-encoder.ts`, `search-ranking-policy.ts`, `search-rerank-execution.ts`, `search-definition-discovery.ts` + focused tests; 156/156 passed + witness mutation check + `pnpm run check` green)
- **Implemented levers (all evidence-gated):**
  1. **Zero-risk hashing & I/O removal (bit-identical):** Added `VerifiedRerankSourceCache` (32 MiB byte-bounded cross-request stat-witnessed cache with 1 s racily-clean guard + root-bound `openRegularFileWithIdentityInsideRoot`), per-request file read/line-split coalescing (`createSearchRerankProjectionRequestCache`, eliminating `61%–68%` duplicate reads/SHA-256 hashes per query), O(1) `WeakMap` manifest-file index, 8-entry LRU for `prepareSearchRerankStructuralRelationships`, and bit-identical 48-dim unrolled `maxSimScore48` (`90.62 ms → 71.27 ms`, `-21.4%`).
  2. **Pre-rerank implementation priority (`partitionImplementationCandidates` + `totalWindowSize` RRF scaling):** On implementation-focused queries with `>= max(limit, 8)` production/adapter candidates in the selected window, skips projecting and reranking supporting/test chunks that post-rerank role ordering would unconditionally demote, while preserving provider rank spread via `totalWindowSize`.
  3. **Polyglot natural-language language affinity (`extractExplicitQueryLanguages`):** Adds a soft RRF vote (`+1/(SEARCH_RRF_K + 1)`) in `fuseDefinitionDiscovery` when a query explicitly names a programming language and the rerank window spans `>= 2` languages (no-op on single-language repos or explicit `lang:` queries).
- **Ruled out with evidence:** Token truncation (`512/384` — tiny gain or top-1 drop), ONNX length-bucketed batching (`b=4/8` slower on CPU), blind LateOn depth cuts (`128 → 32` drops React `r2` owner at `#98`), and global `isGeneratedPath` filename suffixes (conflicts with `search-definition-discovery.test.ts` oracle).
- **End-to-end 3-repo benchmark (`cases.json`, 28 queries across `react`, `flatbuffers`, `polars`, full offline `Potion + LanceDB + LateOn`):**
  - `react` (9q): `hit@1 5/9 → 5/9`, `hit@5 7/9 → 7/9`, `MRR 0.633 → 0.633`; wall median **`4519 ms → 2858 ms` (`-36.8%`)**, rerank median **`3197 ms → 1946 ms` (`-39.1%`)** (`r8`: `3762 → 296 ms`, `12.7×`; `r9`: `3074 → 676 ms`, `4.5×`).
  - `flatbuffers` (10q): `hit@1 4/10 → 4/10`, **`hit@5 5/10 → 6/10`**, **`hit@10 7/10 → 9/10`**, **`MRR 0.461 → 0.497`**, zero regressions (`f3`: `absent → 9`, `f10`: `absent → 4`).
  - `polars` (9q): `hit@5 8/9 → 8/9`, `hit@10 9/9 → 9/9`, `p1: 3→2`, `p2: 3→2`, `p6: 1→2` (`stream.rs`); wall median **`4072 ms → 3284 ms` (`-19.4%`)**, rerank median **`3189 ms → 2609 ms` (`-18.2%`)**.
  - **Combined 28q:** `hit@5 20/28 → 21/28`, `hit@10 23/28 → 25/28`, `MRR 0.611 → 0.618`, mean candidates reranked **`116.3 → 77.7` (`-33.2%`)**, wall median **`3507 ms → 3158 ms`**.
- **Strict held-out validation (`cases-heldout.json`, untouched during tuning):**
  - `gin` (15q Go): `hit@1 4/15`, `hit@5 9/15`, `hit@10 11/15`, `MRR 0.397`, **wall median `821 ms`**, **rerank median `661 ms`**, `31.3%` cross-query `documentCache` hit rate, peak RSS `1623 MiB`.
  - `flask` (15q Python): `hit@1 7/15`, `hit@5 11/15`, `hit@10 11/15`, `MRR 0.567`, **wall median `1047 ms`**, **rerank median `762 ms`**, `35.2%` cross-query `documentCache` hit rate, peak RSS `1590 MiB`.
