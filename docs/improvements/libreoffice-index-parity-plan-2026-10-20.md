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

## Run r8 (D2 + D3, 20 October)

Payload loop complete (35,760 files, 547,349 chunks) at about 319 s, no
faster than r6/r7. Kernel `oom-kill` at 6 GiB at 420 s, in navigation
staging (progress 90). Mutation worker malloc arenas: about 1.0 GiB up to
87 %, then 2.2 GiB in navigation staging; D3 did not stop arena growth.

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

## Risks

- Removing the cap without Slice 0 leaves a complete index failing at 6 GiB.
- Parity mode results do not transfer if navigation is later run eagerly.
