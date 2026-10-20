# LibreOffice 200 s implementation plan, 20 October 2026

Status: revised after the read-only fundamentals review. Product changes
remain proposals. Hamza implements each accepted task and returns with the
results. The reviewer checks the results and updates this plan.

Revision: memory spill now precedes the semantic redesign. A measured C++
prototype decides the runtime. The plan now includes cancellation and
durability checks.

Revision 2 (Hamza's decisions, 20 October 2026): the MRR loss limit is 0.01
("search ranking can stay same or nearly the same"). Cheap measured time
gains come before spill. Spill is a requirement for Task 7b, not for every
task. Task 7a runs as a scratch prototype while Task 8 is built. The 2 GiB
configuration, incremental-edit equivalence, and search latency are follow-up
work (Tasks 8b and 9b). They do not block the 200 s goal. The fundamentals
review's "no MRR loss" line is superseded by this decision.

## Progress (batch 1, 20 October 2026)

Batch 1 is Tasks 0, 0b (R1, R2), 1, 2, 3 and 4a. Workers wrote the slices in
separate worktrees from `9dfffaaf`. The reviewer merged them into the main
tree. Commits: `e9f5f725` (batch 1), `88e80b78` (Task 4a helper).

| Task | State | Evidence |
| --- | --- | --- |
| 0 | Done | `?.sourceStat?.size`. `semantic-workflow-delta.test.ts` and `index-generation-workflow.test.ts` pass. |
| 0b R1 | Done | `attachResolutionClaims` replaces claims for every rebuilt file. New assertion expects 0 stale claims. A mutation (old builder) fails with `1 !== 0`. |
| 0b R2 | Done | `settleShardBatch` (`Promise.allSettled`, first rejection in input order) in symbol, relationship and fsync batches. Two gated fault-injection tests. A mutation (`Promise.all`) fails both. |
| 1, 2 | Done | 12 files. r10 tables below. About 197 s of payload main-thread CPU has no span yet. |
| 3 | Done, target missed | Set for selected paths, extension set once per scan, reject before `stat`. A mutation (no reject) fails "a proven rejection must not call stat". r10 scan: 30.1 s (r9 34.2 s). The target is under 10 s. |
| 4a | Shipped, committed (`88e80b78`) | Batch pooling at about 3.2 times the old speed, output bit-identical. New helper sha256 `1b2aa8b6…`, 4,325,240 bytes. Manifest, CLI pin and contract fixture updated. |
| D11 | Not approved | Not in batch 1. |

Focused checks after the merge: ESLint is clean on the changed core files. 11 core test files pass
(`indexing-pipeline`, `index-generation-workflow`, `semantic-workflow-delta`,
`sidecar-writes`, `oxc-adapter`, `parallel-service`, Go and Python structural
analysis, `builder`, `resolution-coverage`, `cbm-multi-language-acceptance`).
`tsc --noEmit` is clean in `packages/core` and `packages/mcp`.

Findings:

- R1: a file without claims must omit `resolutionClaims`, not store `[]`.
  `symbols/sidecar-writes.ts` writes only defined claims, so `[]` would
  change the stored output.
- Task 3: the plan's frozen-value witness for the extension set never hits.
  The main scan passes mutable arrays. `getCodeFiles` now builds the set once
  per scan, and the worker's cache and its two tests were removed.
- Task 1: when `SATORI_PERF_TRACE` is on, the analysis worker measures result
  sizes with `JSON.stringify`. This cost exists only in traced runs. Treat
  traced payload timings as an upper bound.
- Task 4a: `StrictPotionModel` copies model2vec-rs `pool_ids` and tokenizes
  each batch once. At load, a witness compares the copy with
  `encode_with_args` bit for bit (`f32::to_bits`) on five texts (ASCII,
  Unicode, over 512 tokens, unknown token). If the witness or the
  unknown-token rule fails, the library path runs.
- Task 4a benchmark (20,000 TypeScript and C chunks, 500-1,450 characters,
  three-run medians, one WSL run, load 2.75 to 3.33, peak RSS 666 MiB):

  | Mode | Library | Tokenize once |
  | --- | --- | --- |
  | Single-threaded | 1,096.5 chunks/s | 2,388.7 chunks/s |
  | Batch size 1,024 | 5,261.4 chunks/s | 16,690.3 chunks/s |

- Task 4a: the shipped model has only `embeddings` (F16, 63,457 x 256). It
  has no `weights` and no `mapping` tensor. A mutation that drops the weight
  scale therefore changes nothing. A mutation that skips one token fails both
  witness tests.
- Task 4a: the worker's version kept two embedding copies (+62 MiB per
  helper, 3 helpers per index). The reviewer removed the duplicate.
  `RawReferenceModel` owns the pooling table. `StrictPotionModel::load`
  builds both paths, runs the witness, and keeps one copy: the own table if
  the witness passes, else the library model. The duplicate decode code and
  the copied `pool_ids` body in the model were removed. `cargo test --lib`: 4
  pass, 1 ignored. A mutation (skip the first id in `mean_pool`) fails 3.
- Task 4a ship checks: release build with the pinned toolchain 1.97.1
  (`--locked --offline`). `conformance` passes with max difference 0.0.
  A differential run sent 2,000 real chunks (TypeScript, Rust, C, Markdown,
  empty, Unicode, 20,000 characters) in 16 batch frames and 200 single
  frames to the old and the new helper: all 218 output frames are
  byte-identical. `potion-embedding.test.ts` (25) and CLI
  `install-preflight.test.ts` plus `install.test.ts` (171) pass.
- Task 4a: the helper digest is not part of the index fingerprint, so
  existing indexes stay valid. The manifest `sourceRevision` still names
  `62de5798`. A commit of the crate source must come first, then a second
  commit that names it in the manifest.

r10 diagnostic run (`SATORI_PERF_TRACE=1`, MemoryMax=6G, one run, traced,
the codebase-memory indexer used about 589 % CPU at the start). Publication
`ac3d5da6`, 35,760 files (20,051 complete, 9,175 recovered, 6,534
unsupported). Script wall 752 s (r9 790 s), peak anonymous memory 4,222 MiB
(r9 4,445 MiB). Spans: `full-r10-diag/r10-spans.tsv` in the bench folder.

Critical path, create accepted to `publication.commit`: about 696 s (r9
740 s). The parts sum to the total within 5 %.

| Phase | r10 | r9 |
| --- | --- | --- |
| `policy.observe_inputs` | 35.2 s | |
| Gap | 5 s | |
| `index.scanFiles` | 30.1 s | 34.2 s |
| `index.payloadPipeline` | 352.8 s | 323.3 s |
| `prepare_changes` (`finalize_collection` 28.5 s overlaps) | 55.6 s | |
| `index.navigation` | 177.1 s | 258.4 s |
| Publication tail (`source_current` 35.9 s, `policy_current` 2.3 s, package ownership 1.6 s, activate 0.45 s) | 40 s | |

Navigation (Task 2):

| Part | r10 | r9 |
| --- | --- | --- |
| Registry | 2.2 s | |
| Semantic Java (C++ fails fast in 0.02 s) | 10.2 s | |
| Relationships | 59.7 s | |
| Stage total | 103.7 s | 139.9 s |
| Stage symbols | 9.2 s | |
| Stage relationships | 13.4 s | |
| Stage `fsync_tree` | 81.1 s (78 %) | |

`stage.mkdir` and `stage.write` (264.9 s and 276.1 s) sum concurrent
operations. They are not wall time.

Payload (Task 1): main-thread CPU 272.7 s of 352.8 s wall (77 % busy).
Process CPU 667.8 s. Worker sums over 4 overlapping workers: analysis 243 s,
parse 106 s, traversal 125 s, queue 100 s, transfer 156 s, CPU 182 s,
result sizing 3.9 s (traced runs only). Main thread: chunk plan 1.5 s, chunk
count 0.8 s, symbol facts 7.7 s, vector writes 64.8 s, analysis wait
213.8 s. Embedding requests sum to 1,405 s (concurrent, not wall). r10 ran
without the Task 4a helper.

Findings from r10:

- `fsync_tree` is 78 % of the stage. The Task 2 rule (over 50 %) says:
  measure a paged-store prototype. The data supports Task 9.
- About 197 s of payload main-thread CPU has no span. Attribute it next.
- Freshness work repeats: `observe_inputs` 35.2 s + `prepare_changes`
  55.6 s + `source_current` 35.9 s = 127 s. Task 5 owns this.
- Task 3 cut the scan by 4.1 s only. The scan remains 30.1 s.
- After publication, the watcher started a `sync` (generation 2). This note
  does not change the numbers above.

### Progress after batch 1 (r11-r13)

Two fixes, each committed with a differential or fault test and mutation checks:

- `664051e3`: `createIdentifierSplitter` in `core/search-projections.ts`
  splits each identifier token once per chunk. The r11 profile showed
  `buildSearchProjections` at 104.8 s inclusive in the payload window. A
  differential test compares the memo with an uncached reference copy.
  Mutations (lowercase key, length key) fail. Microbenchmark on 26,938
  LibreOffice chunks: 7,275 ms to 3,317 ms (median of 3).
- `71cc4659`: `syncStagedFileSystem` in `symbols/sidecar-lifecycle.ts`. On
  Linux, if the staged tree is on one ext4, xfs or btrfs device, one
  `sync -f` replaces the per-file fsync. Else, or on failure, the per-file
  fsync runs. `sidecar-lifecycle.test.ts` (4 tests). Mutations M1-M4 each
  fail at least 1 test. No test covers the device-mismatch branch.
  Benchmark (ext4 on WSL2, 71,523 files of 14.6 KB): 66.2 s to 7.7-8.1 s.

Runs (MemoryMax=6G, one run each, r11 with CPU profiling, 35,760 files,
all published). Spans: `full-rNN/rNN-spans.tsv` in the bench folder.

| Metric | r10 | r11 (profiled) | r12 (`664051e3`) | r13 (`71cc4659`) |
| --- | --- | --- | --- | --- |
| Script wall | 752.2 s | 677.5 s | 643.4 s | 544.1 s |
| Critical path | 696.1 s | 628.8 s | 600.6 s | 494.0 s |
| Peak anonymous memory | 4,222 MiB | 4,283 MiB | 4,248 MiB | 4,310 MiB |
| `index.scanFiles` | 30.1 s | 29.4 s | 28.9 s | 28.6 s |
| `index.payloadPipeline` | 352.8 s | 299.7 s | 232.9 s | 238.2 s |
| Analysis wait | 213.8 s | 180.3 s | 169.2 s | 173.6 s |
| Vector writes | 64.8 s | 57.7 s | 54.3 s | 56.2 s |
| `prepare_changes` | 55.6 s | 55.7 s | 52.5 s | 53.1 s |
| `index.navigation` | 177.1 s | 166.8 s | 213.1 s | 100.1 s |
| `fsync_tree` | 81.1 s | 83.7 s | 123.4 s | 8.0 s |
| Publication tail | 40.5 s | 43.8 s | 40.4 s | 41.4 s |

Remaining costs, largest first: analysis wait 174 s (worker throughput),
repeated freshness (`observe_inputs` + `prepare_changes` + `source_current`,
about 125 s, Task 5), navigation relationships about 60 s, vector writes
56 s, scan 29 s, embedding JSON transport about 20 s.

Parent documents:

- `libreoffice-index-parity-plan-2026-10-20.md` (goal, decisions D1-D8, runs
  r4-r9, review findings, cbm comparison).
- `libreoffice-fundamentals-review-2026-10-20.md` (source evidence, defects
  R1-R4, ranked changes, and measurement limits). This plan uses that evidence
  and does not replace it.

Aegis visibility: this work changes the core indexing owners, the semantic
engine ABI and the navigation storage format, so a durable plan with
compatibility and retirement tracks is necessary.

## Goal

A complete full index of the LibreOffice corpus (35,760 files, 547,349
chunks), with symbols and a call graph that includes C++ calls, in 200 s or
less, under `MemoryMax=6G`. Hamza's direction: "copy all that we can" from
cbm (MIT license) and semble.

Acceptance:

1. The median of 3 full runs is 200 s or less, from the index request to the
   published state, on the frozen corpus.
2. Peak cgroup memory stays under 6 GiB. Report the anonymous peak too.
3. The C++ provider processes the full admitted source set and publishes
   cross-file calls. No whole-language resource skip remains. Report per-file
   complete, degraded, and unavailable coverage with reasons. Do not label
   unsupported syntax complete merely because the provider returns.
4. The search-quality eval (`evals/real-repo-quality/run.mjs`) gives MRR no
   more than 0.01 below the recorded baseline. Use fresh state roots and fixed
   cases, caller `alt_terms`, model assets, and reranker configuration.
5. Each task passes its own focused tests and its equivalence test.
6. Failure and cancellation publish nothing. Every submitted worker and
   writer stops before cleanup and lease release. Crash tests retain a
   readable previous generation. Equal scores and same-line calls have
   deterministic ordering.
Follow-up, not a gate for the 200 s goal (Tasks 8b and 9b): a small edit, a
C++ header edit, a rename, and a deletion match a fresh full index. Memory
stays bounded on the 2 GiB configuration. Record full-corpus cold and warm
search latency. Preserve dense retrieval, BM25, `alt_terms`, fusion, and the
reranker throughout.

## Where the 740 s goes (r9, measured)

| Stage | r9 | Owner | Target (a budget, not a forecast) |
|---|---:|---|---:|
| Startup and policy observation before the resource plan | about 32 s | `generation/index-generation-workflow.ts`, `config/index-policy.ts` | 3 s |
| Scan | 34.2 s | `core/indexing-pipeline.ts`, `sync/sync-scan.ts` | 10 s |
| Payload loop (analysis, chunks, embedding, writes) | 323.3 s | `core/indexing-pipeline.ts`, `language-analysis/*`, `embedding/*` | 110 s |
| Gap between payload and navigation | about 53 s | `generation/index-generation-workflow.ts` | 5 s |
| Navigation: semantic re-read + relationships + stage | 258.4 s (stage 139.9 s, relationships 59.1 s) | `generation/index-generation-workflow.ts`, `symbols/*`, `relationships/*`, `semantic/*` | 50 s, overlapped with finalize |
| Tail before publication | about 42 s | `generation/index-generation-workflow.ts` | 5 s |
| Finalize (FTS index) | 26.5 s, overlaps navigation | `vectordb/lancedb-vectordb.ts` | overlapped |

Those owner targets are not additive. Use this nonoverlapping acceptance
budget to evaluate a prototype. Every interval remains unproven:

| Interval | Budget |
|---|---:|
| Discovery, policy, and source observation | 10 s |
| Extraction, chunks, embeddings, and payload writes | 120 s |
| Resolution tail after definitions | 30 s |
| Keyword finalization, graph sealing, and durability | 30 s |
| Final source reconciliation and activation | 10 s |
| Total | 200 s |

Overlap is allowed only when the memory budget admits both stages. If the
keyword build serializes behind navigation, include that tail in the budget.

r4 (368 s) stopped at 450,000 chunks and 29,675 files. It is not a complete
baseline. The scan-plus-payload sums are 225 s and 357 s, but the runs process
different workloads and use different configurations. Their 132 s difference
is not a measured regression. Task 1 explains r9's critical path and gaps.

cbm 0.12.1 completed in 236 s with 698,194 CALLS edges. Its 44,065 `File`
nodes represent 36,383 actual file paths plus 7,682 diagnostic nodes. Cbm
charged about 2.8 GiB against a 2,990 MiB allocation budget. Its peak RSS was
not measured. Cbm alone does not prove the 200 s target.

The reviewed r9 artifacts contain 23,171 relationships, including 18,441
CALLS and no C++ semantic calls. Cbm contains 646,370 C/C++ CALLS. The file
sets differ: 35,367 common paths, 393 Satori-only, and 1,016 cbm-only. Compare
normalized records on common files before drawing a coverage conclusion.

## What we copy from cbm and semble

| Copy | Source (cbm at `11b662f9` unless stated) | Satori task |
|---|---|---|
| Retain extraction results, spill them, and bound source retention | `src/pipeline/pass_parallel.c:44-70,1242-1248` (source retention: min(budget/8, 1 GiB), 32 MiB per file) | Tasks 8 and 6 |
| One shared registry, then per-file parallel call resolution | `src/pipeline/pass_parallel.c` phases 3B and 4 (`resolve_worker`, line 3452), `src/pipeline/registry.c`, `src/pipeline/pass_lsp_cross.c` | Task 7 |
| Memory budget from RAM, back-pressure, spill to disk | `src/foundation/mem.c`, `mem.h`, `PP_BACKPRESSURE_*` in `pass_parallel.c:29-37`, log `mem.spill.on` | Task 8 |
| One graph database per generation instead of one file per shard | `src/store/store.c`, `src/graph_buffer/graph_buffer.c` | Task 9 |
| File discovery that filters by extension before `stat` | `src/discover/discover.c`, `src/discover/language.c`; semble walker | Task 3 |
| Tokenize each document once | semble `model2vec` path; Satori `experiments/potion-l0-l1/src/lib.rs` | Task 4 |

Attribution: every copied cbm file or function keeps its MIT header. Record
each copy in `third_party/cbm-semantic/UPSTREAM.md` with the upstream commit.

Cbm's resolver can re-parse retained source. It does not prove one parse for
every phase. Copy its bounded data flow first. Measure parse reuse separately.

## Architecture after this plan

- TypeScript keeps MCP, policy, leases, publication and coordination.
- Start with C++ extraction and resolution. A prototype compares the existing
  WASM path with a native process using the cbm-derived sources. Keep other
  language providers while that comparison runs.
- The selected engine builds one authoritative registry and resolves files
  in parallel. Sources and extracted records have byte limits and spill.
  Parse reuse is a measured goal, not a property of the current ABI.
- A memory budget owner admits work and spills corpus-sized records to a
  generation-private spool.
- If Task 2 supports D10, navigation writes a private paged database per
  generation. The storage owner seals the database and syncs the required
  files and directories before existing publication code activates it.
- Lance vectors and BM25 remain the first payload-storage candidate. The
  low-memory FTS experiment decides whether that builder can meet the budget.

## Tech stack

Node 22.13+ (local 24.19), TypeScript, Emscripten WASM (current cbm-derived engine),
LanceDB 0.39, Potion embeddings (Rust helper), proposed `node:sqlite` (type
declarations already exist in `packages/core/src/node-sqlite.d.ts`, no product
import yet). D9 decides any native runtime or packaging requirement before
product integration.

## Compatibility boundary

- MCP tool outputs keep their shapes. `call_graph`, `trace_path`,
  `find_references` and `file_outline` give equal or more results.
- Existing published generations stay readable. The navigation reader keeps
  the shard reader while a retained publication or read lease needs it.
  A format-version change alone does not prove that retirement is safe.
- Persisted `status: 'partial'` publications stay readable (old r4 state).
- Version any changed ABI and its assets together. Remove a replaced API
  only after all first-party callers migrate. The C++ slice does not retire
  the session API that other language providers still use.

## TDD route

Mode `auto`, decision `strict`. Authority: AGENTS.md "Verification" and
"Changes that claim unchanged behavior". Reason: core, contract, persistence
and concurrency changes. Every task writes its failure-path or equivalence
test first and confirms that the test fails on the old code or on a mutation.

## Verification rules for every task

- Focused tests only. One file:
  `cd packages/core && systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 timeout 600 node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-concurrency=1 --test-reporter=../../scripts/satori-test-reporter.mjs <file>`
- Type check: `pnpm exec tsc --noEmit -p .` in `packages/core` and `packages/mcp`.
- Every cache, fast path or consolidated check: a differential test against
  the old path, and a mutation check (break the key or witness, see the test
  fail, restore).
- Timing claims: median of 3 full runs. Harness:
  `bench-bugs/libreoffice-perf-20261020/full-r9-arena2/run.mjs`, copied to a new
  run directory, launched with
  `systemd-run --user --scope -q --unit=<name> -p MemoryMax=6G -p MemorySwapMax=0 env -u NODE_OPTIONS -u SATORI_ANALYSIS_WORKERS -u SATORI_INDEX_MEMORY_BUDGET_MB MALLOC_ARENA_MAX=2 node run.mjs`.
  Rebuild first: `pnpm --filter @satori-code/core build && pnpm --filter @satori-code/mcp build:runtime`.
- Report the before and after medians, the cgroup peak, the anonymous peak and
  the machine load.
- Run one changed mechanism at a time. A diagnostic run can collect several
  spans. Do not combine several optimizations into one attribution result.
- Freeze the corpus file manifest and hashes. Save exact commits, dirty
  patches, native/WASM assets, model identities, CPU allocation, and settings.
  Reject runs that publish fewer selected files or omit a required artifact.
- Read the final publication and coverage, not only the harness exit code.
  The r9 harness catches errors and can exit successfully after failure.
  Use publication timestamps for the 200 s gate. Its five-second status poll
  adds observation delay. Keep profiled runs separate from acceptance runs.
- Never run full indexes in parallel on this host. Do not rebuild another
  session's checkout. Use an isolated checkout for product experiments.

## Open decisions (Claude's recommendation first)

- D9. Open: choose the C++ engine after Task 7a. Compare WASM workers with a
  native sidecar using the same files and evidence contract. Prefer one
  shared registry and compact output. Include extraction, transport,
  resolution, packaging, memory, and cancellation. A resolve-only threshold
  cannot decide the 200 s goal. A new native build requirement needs Hamza's
  approval before product integration.
- D10. Navigation storage becomes one SQLite file per generation
  (`node:sqlite`). Reason: 71,520 shard files and their `fsync` walk are the
  plausible owner of the 140 s stage. Task 2 must confirm this first. This
  adds a persistent component, so Hamza must approve it before Task 9.
- D11. Rewrite `generation/auxiliary-publication.test.ts:123` ("Quiet partial
  Publication retains its checkpoint") to create the partial publication
  directly through the publication store, then remove the `limit_reached`
  producer chain (review finding 5). Reason: the read path for old partial
  publications needs a test, and the producer no longer exists.
- D12. Keep Satori's selected file set. Cbm has 36,383 actual file paths,
  not 44,065 source files. Compare normalized calls and unresolved cases on
  common files. Node and edge counts alone do not prove graph quality.
- D13. Keep Lance initially. Test unused FTS positions and builder isolation
  before a payload-store migration. If the keyword builder cannot fit the
  low-memory configuration, benchmark a bounded alternative. The prototype's
  5.7 to 96.9 ms keyword regression is a real tradeoff, not a free saving.

## Plan pressure test

- Owner fit: every task names an existing owner, except the memory budget
  (Task 8) and the graph store (Task 9). Both are new domain owners and depend
  on narrow ports, not on `Context` (AGENTS.md "Ownership").
- Higher-level path: measure first, then spill before adding retained
  sources or registry copies. Cheap scan changes remain separate experiments.
- Verification: each task has a focused test and a measurable span.
- Executability: Tasks 6 and 7 depend on Task 8. Task 7a decides D9 before
  the new ABI or process integration. Task 9 needs D10 and its durability
  tests. Incremental publication tests are follow-up work (Task 9b). Correctness findings owned by Hamza remain his work.

## Tasks

### Task 0: fix the D8 regression (blocker)

- Defect: `generation/index-generation-workflow.ts:500` reads
  `capturedSourcesByPath.get(...)?.sourceStat.size`. A captured source without
  `sourceStat` throws. Three tests in `generation/semantic-workflow-delta.test.ts`
  fail with "Cannot read properties of undefined (reading 'size')" (checked on
  20 October after commit `d04572f4`).
- Fix: use `?.sourceStat?.size`. A missing size means "unsure", so the
  workflow takes the slow path. Keep the fixture unchanged.
- Verify: `semantic-workflow-delta.test.ts` and `index-generation-workflow.test.ts` pass.

### Task 0b: confirmed correctness defects from the review

- R1 stale resolution claims after a failed semantic delta
  (`generation/index-generation-workflow.ts:1841`, `relationships/builder.ts:125`).
  Replace claims for every rebuilt owner, also for an empty result. Add the
  review's assertion (expects 0 stale claims, now 1) to
  `generation/semantic-workflow-delta.test.ts`. Copy retained evidence before
  replacing claims so the old publication remains unchanged.
- R2 shard writers continue after a failed staging
  (`symbols/sidecar-writes.ts:198`, `:551`, `symbols/sidecar-lifecycle.ts:326`).
  Use `Promise.allSettled`, keep the first failure, then clean up. Add a gated
  fault-injection test. Retirement: Task 9 removes shard writes. Do R2 now,
  because Task 9 needs D10 first.
- D11 when Hamza approves it.

Hamza already owns the four earlier review repairs: workspace metadata,
final embedding drain, repeated source-control discovery, and obsolete caps.
Check their current state before starting overlapping work. R2 concerns
shard writers and is separate from the final embedding drain.

### Task 1: attribute every second (measurement, no behavior change)

- Add `perfSpan` spans (the existing `[perf]` mechanism) around:
  policy resolution and the observed index profile (the 32 s start),
  `prepareChanges({capturedFullIndexSource})`, `assertSourceObservationCurrent`,
  the semantic loop per language, `buildSymbolRegistry`,
  `admitAuthoritativeProofBackedCalls`, the publication tail (the 42 s).
- In the payload loop, split the analysis time into worker parse, worker
  traversal, queue delay, source/result bytes, `createAnalysisChunkPlan`,
  chunk counting and symbol-fact construction. Add worker timestamps and
  correlate request IDs. Round-trip time alone cannot isolate clone CPU.
  Owners: `core/indexing-pipeline.ts`, `language-analysis/parallel-service.ts`.
- Capture main-thread and worker CPU separately. Measure native embedding
  service time separately from the 1,331 s summed request durations.
- Acceptance: one diagnostic run partitions the core wall time within 5 %.
  Record startup outside that total separately. Do not sum overlapping spans.
- Stop: when the critical path and 32/53/42 s gaps have measured owners.
  Do not infer a regression by comparing capped r4 with complete r9.

### Task 2: split `navigation.stage` (measurement)

- Add spans inside `symbols/sidecar-writes.ts` and `symbols/sidecar-lifecycle.ts`:
  JSON serialization, `mkdir`, file writes, `fsyncDirectoryTree`.
- Acceptance: the r10 table gives the share of each part of the 139.9 s.
- Decision input: if file creation and `fsync` are more than 50 % of the
  stage, measure a paged-store prototype. Also measure serialization and cold
  reads. A time share alone does not choose the database or its sync policy.

### Task 3: scan and source-selection fixes (proven costs)

- `selectedSourcePaths.includes` runs for each consumed source: about
  639 million comparisons at 35,760 files. Use a `Set` built once.
- `toExtensionSet` builds a set on each policy call
  (`config/index-policy.ts`). Build it once per resolved policy (a frozen
  value is the witness).
- Filter by extension before `stat` in the main scan, as cbm `discover.c` and
  semble do, only where policy proves rejection without metadata. Preserve
  shebang admission for every unrecognized extension, not just extensionless
  files. Preserve exact filenames, all-text mode, auxiliary observation,
  generated-file exclusions, ignore rules, and symlink containment.
- Equivalence test: on fixtures for each branch (known extension, unknown
  extension with shebang, unknown without shebang, ignored path, symlink,
  oversize file), the old and new scans give the same selected list in the same
  order.
- Split the membership set, compiled policy, and discovery fast path into
  separate changes and measurements. Target: scan under 10 s.

### Task 4: embedding work (proven costs)

- 4a, tokenize once: `StrictPotionModel.encode_batch` calls `retained_token_counts`
  and then `model.encode_with_args`. Both tokenize
  (`experiments/potion-l0-l1/src/lib.rs`). Tokenize once and pass the
  encodings to native pooling. Identify the pinned library's API first.
  Preserve retained-token counts, unknown-token rejection, and normalization.
- 4b, CPU plan: size helper processes and native tokenizer threads against
  analysis workers. Use one resource plan. Measure one helper first, then
  increase one count at a time. Requests queued in a serial helper do not
  prove concurrent embedding. Check foreground-query delay during indexing.
- 4c, batches: the provider caps batches at 64 items. The 1 MiB frame limit
  lives in `embedding/potion-embedding.ts`. Change byte admission, provider
  policy, pending limits, and timeout handling together. Measure throughput
  and retained bytes. Do not treat the plan's 1,000 items as the actual batch.
- 4d, optional: replace JSON float transport only if profiling attributes
  material CPU or memory to it. Compare binary transport separately from
  batch sizing and direct Arrow construction.
- Equivalence tests: exact float32 vectors, retained counts, empty/unknown
  input behavior, errors, cancellation, and ordering on fixed samples.
- Measure each subtask alone. Stop when CPU or RSS rises without a wall-time
  benefit. Summed embedding duration is not wall time.

### Task 5: remove repeated freshness work

- `prepareChanges({capturedFullIndexSource})` runs a validating scan and
  `assertSourceObservationCurrent` runs another scan before activation
  (`generation/index-generation-workflow.ts`). A stat signature and hash from
  the payload describe an old observation. They do not prove that no edit,
  new file, deletion, or policy change occurs afterward.
- First remove repeated computation within each observation. Consolidate
  scans only after identifying a current witness. A complete change journal
  needs a start boundary, overflow detection, and a reconciliation boundary.
  If that witness is absent or uncertain, keep the validating scan.
- Keep the final race check and name its held invariant. Use deterministic
  injections for edits, new files, deletes, renames, ignore/workspace changes,
  restored timestamps, and a missing or overflowed watcher journal.
- Target: reduce the measured owners of the 53 s and 42 s gaps. The current
  trace does not establish that either gap consists only of a scan.

### Task 6: bounded extraction handoff (after Task 8 and Task 7a)

- Now: the semantic loop reads each language again. Source gathering occurs
  before the provider timer. The unaccounted portion of r9's 258 s navigation
  span is about 59 s after subtracting stage and relationship spans, not a
  measured 100 s of source reads. D8 skips the doomed full-index C++ read.
- Source retention alone does not remove parsing. The structural adapter
  parses at `language-analysis/tree-sitter-adapter.ts:1559`. C++ semantic
  resolution parses again at `third_party/cbm-semantic/satori_semantic.c:2693`.
  The current ABI transfers source, not reusable syntax trees.
- First specify the handoff from Task 7a: definitions, imports, call sites,
  source identities, byte spans, diagnostics, and authority evidence. Define
  serialization and lifetime. Do not assume serialized C pointers or syntax
  trees work across independent WASM instances.
- Start with C++ only. Stream output into the Task 8 spool. Retain source
  only within a charged budget, using cbm's retention policy as a candidate.
  A miss rereads one file and checks its hash. Other language providers keep
  their existing contracts until a separate measured change justifies more.
- Retire the language-wide reread only when the replacement preserves its
  source witnesses. Measure read reuse and parse reuse separately.
- Tests: equivalence of navigation output (symbols, relationships, provider
  coverage) between the old and new paths on a mixed fixture (TS, Java,
  Python, C++), with a retention budget of 0 bytes (all misses) and an
  large bounded budget (all hits). Include Unicode spans, parse recovery,
  conditional preprocessing, overloads, inheritance, imports, and receivers.

### Task 7: shared registry and per-file parallel resolution (copy cbm phases 3B and 4)

- Now: `satori_semantic_add_source` adds every source to one session, and
  `satori_semantic_resolve` resolves them all
  (`third_party/cbm-semantic/satori_semantic.h:173-177`). Limits: 20,000
  sources, 100 MB. LibreOffice has 22,312 C++ files, so C++ coverage is
  unavailable.
- 7a, scratch prototype: compare a native C++ extraction/resolution process
  with WASM workers on one frozen, representative file manifest. Include
  extraction, registry construction, transport, resolution, and final output.
  Record CPU, wall time, total charged memory, parse counts, and unresolved
  cases. Keep product code unchanged during this runtime decision.
- Start with correctness fixtures, then exercise all 22,312 admitted C++
  files before choosing the runtime. A small subset cannot expose the global
  registry limit or its peak. Record the existing whole-session failure as
  the baseline failure, rather than silently reducing the file set.
- Decide D9 from those results. Existing cbm finishes in 236 s and supplies
  evidence for native shared-memory resolution, not proof of a 200 s combined
  index. A runtime choice must fit the integrated critical path.
- 7b, integration after D9: one engine owns authoritative definitions and
  per-file resolution. The design note names the input schema, identity and
  proof rules, failure codes, cancellation boundary, and versioned artifacts
  before a new ABI is implemented. Keep ABI names provisional until then.
- Send bounded records to the private spool. The TypeScript coordinator
  receives progress and artifact identities instead of retaining a full
  cloned analysis result for every file.
- Prefer one shared registry. If WASM requires one registry per worker,
  specify the portable encoding and charge the coordinator plus every copy.
  Compare that cost with the native shared registry. Worker count comes from
  the existing resource plan and Task 8 admission.
- Replace whole-session limits with budgeted storage and per-job admission.
  A registry limit must spill or reduce residency. Do not replace a source
  cap with another cap that skips the whole C++ graph. Remove D8 only after
  the new path proves full-corpus progress without its failed session.
- Tests: preserve normalized relationships and proof admission on existing
  supported fixtures. Add cross-file C++ cases that the old session cannot
  handle at scale. Compare matched-file calls with cbm, inspect disagreements,
  and report degraded files honestly. Counts alone are insufficient.
- Stop before product integration if neither prototype meets the memory
  envelope or makes the integrated time budget credible. Re-rank measured
  costs. Do not proceed on a resolve-only 40 s threshold.

### Task 8: memory budget owner and spill (copy cbm `mem.c` and back-pressure)

- Execute this task before adding retained sources or parallel registries.
  `indexing/resources.ts` remains the policy and worker-count owner. A narrow
  admission/spool owner enforces that plan. Do not derive a second budget.
- Reserve bytes for the entire process tree and native working sets. Charge
  source, analysis, lexical and dense text, vector conversion, registry
  indexes, and every worker copy. Measure actual RSS and cgroup memory too.
- Back-pressure must preserve progress: a writer or spiller can drain work
  while admission pauses. Corpus-wide facts that cannot be freed until the
  resolution barrier must spill before they fill the budget. A fixed spin
  count followed by failure does not prove full-corpus progress.
- Spill: write `symbolRecords`, `symbolManifestFiles` and `analysisByFile` to a
  generation-private spool as the payload produces them. Navigation reads the
  spool. Release consumed evidence instead of reconstructing the whole map.
  A bounded paged registry is the next step if the remaining registry exceeds
  its charge. Do not count all 710 MiB as removed while a full copy remains.
- Tests: a run with a small budget gives the same navigation output as an
  ample budget. Force spill at a deterministic threshold. Test cancellation,
  spill failure, a large single-file result, and the all-workers-paused case.
  The run must finish or fail explicitly without publishing partial output.
- Include R4: lexical prefix aliases can exceed the dense byte estimate by
  164.7 times in the reproduced fixture. Charge actual retained lexical bytes.
  Keep any prefix-policy change separate and subject to the quality gate.
- Acceptance: graph evidence does not accumulate in corpus-sized JS maps
  through staging. Compare heap snapshots and cgroup peaks before and after.
  The supplied 710 MiB is a gross opportunity, not a measured net saving.

### Task 8b (follow-up): watcher, graph-reader, and keyword-build budgets

- The MCP watcher accounts for most of the supplied 1.27 GiB server footprint.
  Measure it independently. Keep file bytes and corpus records out of the
  watcher. A smaller watcher or reconciliation journal must detect directory
  creation, ignore changes, event loss, and overflow before claiming freshness.
- Bound graph-reader caches by bytes. Root counts alone do not bound a large
  registry. Check cold reads and lease-held old generations during indexing.
- Test Lance FTS with unused token positions disabled. Inspect declared query
  consumers first and compare lexical results and quality on fresh indexes.
  The metadata-cache setting does not bound FTS construction.
- Schedule the keyword builder after large evidence owners release memory
  unless measured headroom permits overlap. A short-lived builder can release
  retained native arenas but does not by itself bound the builder's live peak.
- Run 6 GiB and 2 GiB experiments separately. If the keyword builder still
  cannot fit, D13 requires a bounded alternative before low-memory acceptance.
  Do not claim that the current Lance path meets the 2 GiB requirement.
- Keep each mechanism separate. Stop on missed changes, unbounded cold reads,
  changed required keyword behavior, or a total peak above its budget.

### Task 9: one SQLite graph database per generation (copy cbm store; needs D10)

- Now: one symbol shard and one relationship shard per file (71,520 files for
  r9), then `fsyncDirectoryTree`.
- Change: the new graph store owner writes symbols, relationships and file
  records to a generation-private database with bounded prepared batches.
  Start with ordinary SQL, not cbm's custom SQLite page writer. Measure row
  conversion, transaction size, indexes, cache bytes, and sealing separately.
  Indexes: file, symbol, caller, callee (the reverse index serves
  `call_graph`). The generation manifest binds the database hash.
- Define the journal and durability protocol before implementation. Close or
  checkpoint required journal state, sync the durable database and directory
  entries, then use existing pointer publication. One transaction does not
  imply one `fsync`. Readers must never depend on an omitted WAL file.
- Put synchronous SQLite work in the supervised indexing process or a worker,
  outside the MCP request thread. Define cancellation between bounded batches.
  Join writers before cleanup. Keep the source-validation boundary intact.
- Readers: `navigation/store.ts` and `navigation/query.ts` read through a port
  with two adapters: the shard reader (old generations) and the SQLite reader.
- Retirement: remove the shard writer in this task. Remove the shard reader
  only when no retained generation or read lease needs that format.
- Tests: an equivalence test on fixtures gives the same `call_graph`,
  `trace_path`, `find_references` and `file_outline` outputs from both readers.
  A crash between the write and the manifest publication leaves the old
  generation active.
- Add corruption, disk-full, cancellation, read-during-replacement, and stable
  ordering cases. Compare complete records and query output, not just counts.
- Target: navigation stage under 20 s.

### Task 9b (follow-up): incremental publication and search at scale

- Preserve immutable generations. Apply changed contributions and tombstones
  to a private candidate. Keep old readers under their leases. Persist reverse
  dependencies where required to invalidate affected semantic contributions.
- Measure a one-file edit, a cross-file C++ header edit, a rename, and a
  deletion. Compare each candidate with a fresh full index of that edited
  snapshot. Record registry work, language rereads, database-copy bytes,
  keyword work, sealing, and publication separately.
- A full database copy per edit can erase incremental gains. Measure ordinary
  private-copy cost first. Consider page reuse or immutable delta segments
  only if that cost dominates. Do not add both formats in advance.
- Use the existing latency probe:
  `node scripts/satori-live-latency-benchmark.mjs --repo "$LO" --mode diagnostic --samples 20 --skip-sync --output-dir "$OUT/latency"`.
  Inspect its workloads before treating them as representative LibreOffice
  queries. Record cold and warm latency and latency during indexing.
- Profile caller-term retrieval, query embedding, and reranking before changing
  them. The second dense pass for `alt_terms` is an experiment candidate.
  Preserve caller-term keyword/fusion evidence and run the fixed-term quality
  comparison if that experiment proceeds.
- Test all-tied search results without materializing the full collection.
  Preserve deterministic ordering through a bounded retrieval strategy.
- Stop if small edits still require corpus-sized retained JS state, stale
  claims survive, a failed candidate affects active readers, or query memory
  exceeds its admitted budget. Report remaining corpus-wide work honestly.

### Task 10: final runs and delivery

- Three full runs on the final build. Report the stage table, medians, the
  cgroup and anonymous peaks, C++ coverage, the CALLS comparison with cbm on
  the same files, and the quality eval against r9.
- Run quality checks on separate fresh roots. Keep `--alt-terms-file` fixed.
  Reject missing reranker assets or a fallback to `none`.
  `node evals/real-repo-quality/run.mjs --state-root "$OUT/quality-state" --out "$OUT/quality"`
- Use a separate state root for conceptual cases too:
  `node evals/real-repo-quality/run.mjs --cases evals/real-repo-quality/conceptual-cases.json --state-root "$OUT/conceptual-state" --out "$OUT/conceptual"`.
- Include failure and cancellation checks. Tasks 8b and 9b report
  separately as follow-up work. No full-index benchmark ran during the review.
- Update `packages/mcp/README.md` and the parity plan with the measured
  results.

## Order

1. Task 0, then 0b. Both fix correctness and are small.
2. Tasks 1 and 2 in one diagnostic run. Establish exact corpus provenance.
   If Task 1 shows GC pauses or memory stalls on the critical path, move
   Task 8 to step 3.
3. Cheap measured time gains: Task 3, then the measured Task 4 subtasks.
   Task 5 keeps current validation unless an explicit freshness witness
   supports consolidation. Measure each change alone.
4. Task 9 if Task 2 confirms the shard cost and Hamza approves D10.
5. Task 8 (spill). Task 7a runs as a scratch prototype in the same period.
   Run only one heavy job at a time (about 7 GB RAM).
6. D9 from Task 7a. Task 6 implements the selected bounded handoff. Task 7b
   integrates per-file C++ resolution using Task 8 admission.
7. Task 10 checks the complete result. Re-rank after each measured slice.
8. Follow-up after the 200 s goal: Tasks 8b and 9b.

## Risks

- Independent WASM instances do not share a C registry by default. Copies
  multiply memory and need an explicit serialization contract. D9 stays open.
- Source caching does not eliminate a second parse. Cbm itself can re-parse
  during cross-file resolution. Count parses before claiming parse reuse.
- All 698,194 cbm calls are not a Satori quality oracle. Different file sets,
  languages, diagnostics, and authority rules affect counts.
- A completed C++ provider can still report unsupported or unresolved files.
  Keep honest coverage and cross-file correctness as separate checks.
- Native integration adds packaging and ABI work. The prototype must justify
  that cost before product changes or a new build requirement.
- The current FTS build peak and watcher prevent a supported claim at 2 GiB
  (follow-up only).
- SQLite journal handling and full-copy delta cost need measured contracts.
- The quality eval needs fresh state roots after any chunk or embedding change.
- The 200 s target is not proven. Cbm takes 236 s on a different file set.
  Check every proposed critical path against the budget before integration.
  Stop and re-rank when measured costs cannot fit. Do not wait for a late
  full rewrite or treat a 300 s intermediate run as evidence for 200 s.

## Removed or retained paths

| Path | Action | Trigger |
|---|---|---|
| Language-wide semantic re-read loop | removed when Task 6 preserves its witnesses | bounded handoff passes equivalence and failure checks |
| C++ whole-session path | replaced in Task 7b | full-corpus per-file path passes its checks; other language callers retain their API |
| C++ D8 skip (`provableLimitFailure`) | retired with the replaced C++ session | budgeted engine processes the full corpus; keep other providers' limit reporting |
| `limit_reached` producer chain | removed with D11 | Hamza approves D11 |
| Shard writer | removed in Task 9 | - |
| Shard reader | retained for old generations | no retained publication or read lease needs the format |

## Document check

The reviewer checked local links, README entries, code references, file-count
arithmetic, edge-count arithmetic, and the 200 s budget. Git whitespace checks
passed. Jevify also scored seven plan constraints through `jev-1.13.0`.
The call used 10,164 input tokens and returned 107 output tokens in 0.670 s.
Scores ranged from 2.80 to 2.97 on a 0-to-3 coverage scale. Those judgments
are not runtime evidence. No implementation, full index, or quality run forms
part of this plan update.
