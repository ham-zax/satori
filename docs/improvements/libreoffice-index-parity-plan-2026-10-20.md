# LibreOffice full-index parity plan, 20 October 2026

Status: plan. Slices 0 and 1 are measurement only; every product change needs
Hamza's approval of its design before code.

## Goal

A complete full index of the LibreOffice corpus
(`/home/hamza/repo/bench-bugs/polyglot-2026-10-19-222137/corpus/libreoffice`)
in **under 200 s**, with no fixed file, chunk, or byte limit, and memory that
works on 2 GB to 500 GB machines. Search results must be correct and at least
as good as now; identical output is not required.

Done: one full index completes under a 6 GiB cap, and the median of 3 runs is
under 200 s, with peak memory and the search-quality eval reported.

## Baseline (measured)

| Stage | Satori r4 (450k cap) | Semble (1 run) |
|---|---|---|
| Total wall | 368.3 s | 134.2 s (median of 3: 120.55 s) |
| File scan | 33.4 s | 9.7 s |
| Main loop (wall) | 192.6 s | 118.3 s |
| Wait for analysis / chunk workers | 114.5 s | 1.7 s |
| Embedding | 310.5 s summed over overlapping calls | 83.0 s wall, one thread |
| Vector storage | 89.4 s LanceDB writes (summed) + 15.5 s finalize | 4.7 s save at end |
| Peak memory | 5,524 MiB | 5,958 MiB RSS |
| Files / chunks | 29,675 / 450,000 (cap) | 29,066 / 496,339 |

Run r5 (no cap, 20 October): 35,760 files, 547,349 chunks, then the kernel
killed the indexer (`oom-kill`, 4.8 GB anon) 6 s after the main loop, before
finalize and navigation. Run data: `bench-bugs/libreoffice-perf-20261020/full-r{4-pool,5-nolimit}/`.
Semble stage wrapper: `semble_stages.py` (scratch); semble evaluation:
`bench-bugs/semble-eval-20261020/report.md`.

## Known causes (evidence)

1. Analysis: 4 workers on 16 CPUs; `indexing/resources.ts:200` divides memory
   by `ANALYSIS_JOB_BYTES` (512 MiB). Workers extract symbols, call sites and
   bindings, not only chunks.
2. Embedding text: about 990 bytes per chunk (445 MB / 450k); each text has a
   header (path, language, symbol kind, symbol, symbol terms, breadcrumbs,
   `core/search-projections.ts:88-102`). Semble: about 750 characters, no header.
3. Writes: 256-row batches; per-value `writeFloatLE` loop
   (`vectordb/lancedb-vectordb.ts:369`, about 115M calls); 15.5 s finalize.
4. Memory grows with chunk count (r2: 208 to 4,076 MiB at 450k). Per-run
   collections in `core/indexing-pipeline.ts` (~line 660): `symbolRecords`,
   `analysisByFile`, `sourceFiles`. Not yet measured by owner.
5. Files: 6,952 files Satori indexes and semble does not; 5,479 are `.xml`
   (4,106 in `extras/source`, about 640 in `*/uiconfig`), 53 MiB of 333 MiB.

## Rules

- One change at a time; full run after each; report wall, stage spans, peak
  memory, files, chunks, load. Medians of 3 for final claims.
- Heavy jobs one at a time, under `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0`.
- Every rule change that alters output needs a stated reason and a quality
  check (search eval MRR or the real-repo quality eval) showing no loss.
- Logs and data files are read only through `jq`, `tail`, `rg -c`, or scripts that print a summary.

## Slices

### Slice 0: memory owners (measurement, blocks a complete index)

Run the full index with the sampling heap profiler (not a heap snapshot) and
report the 3 largest owners in MiB near 300k chunks. Stop: owners named.
Then propose a flat-memory design (for example: spill per-file records to
disk, or stream them to their publication owner). Needs approval.

### Slice 1: "parity mode" speed ceiling (measurement)

Hamza's idea: turn off what semble does not do, measure the real speed, then
turn features back on one at a time and pay only for what improves results.
An experiment-only switch (environment variable, not a public option) that:
analysis does chunking only (no symbols, call sites, bindings, navigation);
embedding text is the chunk content only. Measure wall and stages. Stop: the
ceiling is known. If the ceiling is not under 200 s, the cause is outside
analysis and embedding text, and Slices 2-3 come first.

### Slice 2: analysis throughput

Check `SATORI_ANALYSIS_WORKERS=12` with no code change; then measure the cost
split per file (parse, chunk, symbols, relationships). Candidates: more
workers sized by measured per-worker memory, cheaper symbol extraction, or
symbols computed after search is published. Learn from codebase-memory-mcp,
which builds BM25 + symbols + call graph for large repositories in seconds.

### Slice 3: vector storage

Profile the write path. Candidates: build Arrow `Float32Array` columns
directly, larger write batches, or semble's approach: keep vectors in memory
or in an append-only file and build the table once at the end. Must keep
crash safety (no partial publication).

### Slice 4: embedding text

Measure which header fields help retrieval (eval MRR with and without each).
Remove the fields that do not help. Even a few characters per chunk matter at
547k chunks.

### Slice 5: file selection

Decide (Hamza) whether data XML (`extras/source`, `*/uiconfig`, test data) is
indexed. Measure search quality with and without. Semble excludes `.xml`.

## Research by workers (done)

Three read-only claive workers returned evidence; citations were spot-checked.

- codebase-memory-mcp (cbm): pthreads share memory, workers pull files
  largest-first from one atomic counter, results merge without per-file IPC;
  SQLite pages are written directly and BM25 (FTS5) is built once in bulk;
  near its budget cbm spills extraction results to append-only files.
  Satori copies source to workers and back, and keeps `analysisByFile` and
  `symbolRecords` until navigation staging (`indexing-pipeline.ts:667-871`).
- LanceDB: writes were capped at 256 rows (`indexing-pipeline.ts:661`), split
  again at 512 inside the adapter; each `table.add` is a table version.
  Rows pass through JS objects and `number[]`; Arrow `TableLike` input is
  accepted. Semble keeps float32 vectors in memory and saves once (`np.save`).
- Embedding text: the header adds about 182 B to a 796 B mean chunk (about
  93 MB over 547k chunks); `symbol-terms` repeats symbol + breadcrumbs and has
  no measurement behind it. Semble embeds content only and skips `.xml`.
  Eval harness: `evals/real-repo-quality/run.mjs` (fresh state root per arm).

## Slice 0 results (memory owners at the 6 GiB OOM)

Sampling heap profiles and `/proc/PID/smaps` (runs r6, r7a, attempts in
`bench-bugs/libreoffice-perf-20261020/full-r6-heapprof`, `full-r7-arena2`):

1. Mutation index worker, glibc malloc arenas: 1.9 GiB in 146 arenas,
   growing through the write phase. Isolated probe: 547k rows at 256 rows per
   add take 42 s and fill LanceDB's default 1 GiB metadata cache (manifest of
   every version); at 16,384 rows per add, 9 s and 1 MiB.
2. Mutation worker, other anonymous memory (V8 heaps of main and analysis
   threads, WASM memory): 1.8 GiB. Main JS heap 1.2 GiB at the OOM: about
   460 MiB deserialized analysis results, 250 MiB symbol registry, 250 MiB
   source strings kept alive after use (retainer not yet known).
3. MCP server process: 1.27 GiB, mostly the chokidar watcher
   (`mcp/src/core/sync.ts:2173`) over the whole tree.

## Decisions (made by Claude on Hamza's behalf, 20 October 2026)

Hamza asked Claude to follow what semble and cbm do, decide, and record.

- D1. Memory before speed: a complete index must finish within 6 GiB first.
- D2. Remove the 256-row vector write cap. Rows per write come from the
  resource plan (`queuedEmbeddingTextBytes / 8 KiB`, 8,192 rows at 64 MiB);
  the adapter no longer splits below that (default 16,384).
- D3. Bound LanceDB's metadata cache to 128 MiB per connection; keep the
  index cache default because search reads the FTS index through it.
- D4. Dependency upgrades that improve speed are approved (LanceDB 0.40.0
  next), each measured on its own.
- D5. Replacing LanceDB with a semble-style store is allowed if the
  measurements after D2-D4 still show the write path as a top cost.
- D6. Data XML (Slice 5) and the Potion pool: decided after Slice 1 and the
  eval, by measured MRR and wall time.
- D7 (Hamza approved). Mutation worker gets `MALLOC_ARENA_MAX=2` on Linux at
  every budget (`indexing/resources.ts`), not only at 4 GiB or less. Reason:
  r9 completed within 6 GiB with it (arenas 420 MiB vs 2.2 GiB in r8).
- D8 (Hamza approved, option 1). The C++ semantic provider (cbm WASM engine)
  fails on LibreOffice: "Total source bytes limit exceeded (100MB)"
  (`third_party/cbm-semantic/satori_semantic.c:303`; also 20,000 sources max,
  22,312 C++ files here). Fail fast: `provableLimitFailure` on the analyzer
  port proves the limit from captured file sizes and the workflow skips the
  source re-read, with the same degraded coverage. C++ call-graph coverage
  stays degraded; splitting into sessions (option 2) is the later real fix.

## Run r8 (D2 + D3, 20 October)

Payload loop complete (35,760 files, 547,349 chunks) at about 319 s, no
faster than r6/r7. Kernel `oom-kill` at 6 GiB at 420 s, in navigation
staging (progress 90). Mutation worker malloc arenas: about 1.0 GiB up to
87 %, then 2.2 GiB in navigation staging; D3 did not stop arena growth.

## Run r9 (D2 + D3 + `MALLOC_ARENA_MAX=2`, 20 October)

First complete index within 6 GiB: 35,760 files, 547,349 chunks, published
about 740 s after the run started. Peak anonymous memory 4,445 MiB, cgroup
peak 5.7 GiB. Worker arenas about 420 MiB in 26 arenas (r8: 2.2 GiB).
Spans: scan 34.2 s, payload loop 323.3 s (r8 about 319 s, so the arena limit
did not slow it), analysis wait 194.0 s, vector writes 55.1 s summed,
finalize 26.5 s (overlaps navigation), navigation 258.4 s (stage 139.9 s,
relationships 59.1 s), publication 0.6 s. About 125 s of the 740 s are not in
these spans (not yet explained). Isolated FTS build: the arena limit costs
about 5 s there.

## Store prototype (D5 check, 20 October)

Scratch prototype: the 547,349 real r8 rows written to a flat float32 vector
file plus SQLite FTS5 (`node:sqlite`), against LanceDB 0.39 with 8,192-row
writes and the product FTS config. Same input, one process each.

| Measure | LanceDB | Flat file + SQLite FTS5 |
|---|---|---|
| Writes (summed) | 23.4 s | 20.7 s (vectors 1.9 s) |
| Finalize (FTS index) | 15.7 s | 9.3 s |
| Disk | 1,691 MiB | 1,607 MiB |
| Dense query, exact cosine, median of 20 | 162 ms | 118 ms (plain JS loop) |
| Keyword query, median of 20 | 5.7 ms | 96.9 ms |
| Top-10 overlap with LanceDB | - | dense 1.0, keyword median 1.0, min 0.8 |

Result: a replacement saves about 9 s of index time and makes keyword search
about 17 times slower. Store writes are no longer a top cost after D2, so D5
does not apply. LanceDB stays.

## D8 verification (20 October)

- `wasm-stress.test.ts`: 7 pass. Mutation `bytes > max` (for `bytes * 3 > max`)
  fails the new limit test. Restored.
- `index-generation-workflow.test.ts`: new test proves the skip path reads no
  semantic source and does not call `analyze()`. 9 pass. Mutation (skip
  disabled) fails the test. Restored.
- `tsc --noEmit` clean in `packages/core`. Core and mcp `dist` not rebuilt.

## Review of the staged diff (cloud review, 20 October)

The review covered the staged diff only, not the gaps or the comparisons.
Claude checked each finding against the code. No finding is fixed yet.

| # | Finding | Status | Proposed action |
|---|---|---|---|
| 1 | `getPublicationSourceSynchronizer` (`core/context.ts:821-835`) now awaits `collectPublicationSourceControls` with no catch. `discoverPackageOwnership` throws on a bad `pnpm-workspace.yaml` (`packages/ownership.ts:138-164`). `search-request-coordinator.ts:1607` and `:1975` do not catch, so the search fails instead of `unavailable`. | Confirmed, regression | Catch and return `null`. Callers map `null` to `unavailable`. Add a test with a bad workspace file. |
| 2 | The diff removes `INDEX_CHUNK_LIMIT` and `MAX_INDEXED_SOURCE_BYTES_PER_PUBLICATION`. `symbolRecords`, `symbolManifestFiles` and `analysisByFile` grow with repository size. `packages/mcp/README.md:119-122` still documents the 512 MiB cap. | Confirmed. The claim "cause of the LibreOffice OOM" is out of date: r9 completed in 6 GiB after D7. | No new cap. Stream the accumulators with navigation staging (gap 1). Update the README. |
| 3 | The final `flushChunkBuffer('final chunk batch')` (`core/indexing-pipeline.ts:972`) is outside a try. If it throws, `stopPayload` does not run and embedding requests continue after the reject. This breaks the invariant at lines 781-783. | Confirmed | Wrap the final flush, call `stopPayload(error)`, then throw. Add a fault-injection test. |
| 4 | Each freshness check recomputes the source controls: sync `discoverPackageOwnership` reads and a TS resolution worker request on every search. | Confirmed (no cache in code). Cost not measured. | Cache per checkpoint ID behind the control files' stat signatures. Add a differential test and a mutation check. |
| 5 | `IndexingPipeline` no longer returns `limit_reached`. The union types and branches stay (`generation/index-generation-workflow.ts:1054`, `mcp/src/tools/list_codebases.ts:44`, `mcp/src/core/manage-maintenance-handlers.ts:520`). | Confirmed, dead code | Remove with finding 2 if no cap returns. |

Order: findings 1 and 3 first (correctness), then 4, then 2 and 5.

## cbm comparison on LibreOffice (20 October)

Upstream cbm (`codebase-memory-mcp` 0.12.1, `~/repo/codebase-memory-mcp` at
`11b662f9`) has no whole-project C++ session and no 100 MB / 20,000-source
limit. Those limits are Satori's own (`third_party/cbm-semantic/satori_semantic.h:26-35`).
cbm parses each file once in parallel (`src/pipeline/pass_parallel.c`, phase
3A), builds one registry serially (3B), then resolves calls per file in
parallel against that registry (phase 4, `resolve_worker`, with the fused
cross-file LSP step in `pass_lsp_cross.c`). Retained source is capped at
1 GiB total and 32 MiB per file. A file outside retention is read again on
demand. Memory has back-pressure and spills to disk near the budget.

Run: `codebase-memory-mcp cli index_repository` mode `full`, under
`systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0`, private
`CBM_CACHE_DIR` and `CBM_RUNTIME_DIR`, one run.

| Measure | cbm 0.12.1 | Satori r9 |
|---|---|---|
| Wall time to complete index | 236 s | about 740 s |
| Memory | budget 2,990 MiB (auto, RAM fraction), spill started at 2,804 MiB charged. Peak RSS not measured (the daemon did the work). | anon peak 4,445 MiB, cgroup peak 5.7 GiB |
| Files indexed | 44,065 File nodes (91,585 excluded) | 35,760 files |
| Partial parses | 7,621 partial, 61 unusable | 9,175 recovered (syntax_error) |
| Symbols / nodes | 602,680 nodes (220,603 Method, 94,565 Class, 88,680 Field, 36,839 Function, 23,402 Macro) | 380,839 symbols |
| Edges | 3,115,365 (USAGE 1,321,901, CALLS 698,194, DEFINES 576,845, IMPORTS 212,506) | not counted |
| CALLS by source language | C/C++ 646,370, Java 36,849, Python 10,759, other 4,216 | C++ semantic provider degraded (D8) |
| Vector search | cbm `node_vectors` per symbol | 547,349 chunk embeddings |
| On-disk store | 3.3 GiB SQLite | about 1.5-1.7 GiB state |

Findings:
- cbm completes C++ call resolution on LibreOffice in 236 s within a 3 GiB
  budget. Satori gives up C++ semantic coverage and takes about 3 times longer.
- The file sets differ (44,065 vs 35,760), so counts are not like for like.
- The cbm method (per-file parallel resolution against one shared registry)
  is the model for D8 option 2, instead of one 100 MB session.
- Satori r9 relationship edge count is not measured yet. Measure it before a
  CALLS comparison.

## Risks

- Removing the cap without Slice 0 leaves a complete index failing at 6 GiB.
- Parity mode results do not transfer if navigation is later run eagerly.
