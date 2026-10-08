# MCP request latency: findings and improvement lanes

Recorded 2026-10-08. Measurement only: no Satori source was changed, in the
checkout or in the scratch clone, and nothing was committed. The only repository
edits are this document and one row in `README.md`. All runs used a scratch clone
of HEAD `84d1ae52`. The checkout's `packages/mcp/dist` is an older 10-07 build
that was not rebuilt, so numbers from that checkout are not HEAD numbers.

## Problem

Agents call the Satori MCP tools many times per task. This pass measured which
tools are slow in a live server process, where the time goes, and which changes
are worth trying.

## Method

- Server: `packages/mcp/dist/index.js` over stdio JSON-RPC (protocol
  2025-06-18), Node v24.19.0, `SATORI_PERF_TRACE=1`, LanceDB, Potion embeddings,
  and the LateOn reranker on CPU (ONNX Runtime) with the offline quality profile.
- Index: `manage_index create` on the clone. 64.2 s wall, 6105 MB peak
  process-tree RSS, 1152 of 1254 tracked files indexed.
- Driver: one server process per benchmark. Cold is run 0 of a workload, the
  first time that workload runs in the process. Earlier workloads that share state
  (for example the other NL workloads) may already have warmed it, so cold is not
  a first-use-in-process figure for every workload. Warm is the median of the later
  3–5 runs. The driver waits 20 ms after each response so `[perf]` lines on stderr
  are collected.
- Memory: the bench and index runs used a
  `systemd-run --user --scope -p MemoryMax=…` cap (9G in the final runs; 7G was
  also used earlier). Machine: WSL2, 16 logical CPUs in `/proc/cpuinfo` (`nproc`
  reports 15), about 12 GB RAM by `free -m` (CLAUDE.md says about 7 GB).
- The driver lives in the session scratchpad, not the repository. It follows the
  protocol of `scripts/perf/index-probe.mjs`.

## Results: bench1 (steady state)

One process, 19 workloads. No response reported `freshness.state =
sync_in_progress`; some carry per-result freshness fields (`outline_summary`,
`call_graph_callers`, `read_open_symbol`, `find_references_fn`). The run's perf
trace did contain one `sync.incremental_publication` span and three
`sync.checkpoint_proof` spans, so a sync ran at some point; it is not visible in
any response state. Times in ms.

| Workload | Cold | Warm median | Warm bytes |
|---|---:|---:|---:|
| list_codebases | 410 | 437 | 222 |
| status_full (`manage_index` status, detail full) | 2494 | 1853 | 21506 |
| search_nl_grouped | 3969 | 2158 | 7670 |
| search_nl_paged (`disclosureLimit` 3) | 1995 | 1940 | 3783 |
| search_nl_raw (`limit` 10) | 1981 | 2075 | 13485 |
| continue_search | 6.0 | 3.1 | 3625 |
| search_exact_class | 25.2 | 22.1 | 1706 |
| search_fn_identifier | 20.9 | 20.9 | 1917 |
| find_references_fn | 1288 | 1601 | 3392 |
| call_graph_callers | 70 | 30.8 | 7255 |
| search_read_identifier | 147.5 | 122.2 | 2134 |
| read_open_symbol | 159.2 | 14.0 | 2805 |
| outline_summary | 15.9 | 11.5 | 48514 |
| trace_path_fn | 2287 | 386 | 761 |
| architecture_overview | 2030 | 2610 | 23952 |
| detect_changes | 49.3 | 50.0 | 868 |
| read_range_small (error) | 1.5 | 1.0 | 359 |
| read_range_large (error) | 0.9 | 0.7 | 343 |
| outline_relationships (error) | 0.6 | 0.6 | 123 |

Three workloads returned errors (`read_range_small`, `read_range_large`,
`outline_relationships`). Their timings are error paths and do not measure
success. Fix their arguments before using them.

Process start: `initialize` 672 ms. Peak RSS 1450 MB for the server, 2750 MB for
the process tree.

## Findings

1. **NL search is the slow path, about 2 s per call in steady state.** Warm:
   grouped 2158 ms, raw 2075 ms, paged 1940 ms. Identical repeated calls stayed
   near 2 s, so no cache hit was visible in that state.
2. **The first NL call in a process pays about 1.8 s more** (grouped cold 3969 ms
   vs warm 2158 ms). The next NL workload, paged, showed no penalty (cold 1995 vs
   warm 1940); raw did not either (1981 vs 2075) but ran after `continue_search`.
   `status_full` ran immediately before grouped and may have warmed shared state,
   so the penalty is confounded with run order. The cause is not isolated; the
   LateOn session is the likely one.
3. **NL time is not attributed.** The only NL span is `search.coordinator_total`
   (`packages/mcp/src/core/search-request-coordinator.ts`). Query embedding,
   vector search, rerank, and serialization are not timed separately. Earlier
   cost notes (`.claude/HANDOFF.md`, git-ignored, 2026-10-06; not re-measured
   here) put rerank at about 75% of a request and LateOn ONNX inference at about
   89% of rerank. They also report the `wt4x2` worker configuration at 1.23 s
   against 2.08 s serial, with bit-identical scores. The pool is committed as `dbad8671` ("perf(lateon):
   size a parallel encoder pool to the host", 2026-10-06), an ancestor of HEAD
   `84d1ae52`.
4. **LateOn path, read but not profiled.** Each document gets its own
   `session.run` (batch 1). `encodeText` copies each token vector with
   `Array.from(tensor.data.slice(...))` and normalizes per token. `maxSimScore`
   is a JS triple loop. No document-encoding or score cache exists on this path
   (searched `lateon-reranker*.ts`). `search-result-set-cache.ts` is bounded
   (`MAX_RESULT_SET_CACHE_ENTRIES` 32, `MAX_RESULT_SET_CACHE_BYTES` 16 MiB); it did
   not serve repeated NL calls in steady state.
5. **Status and architecture overview take 2–2.6 s each time.** `status_full`
   (21.5 KB): 2494 cold, 1853 warm. `architecture_overview`: 2030 cold, 2610
   warm. Neither is profiled.
6. **`trace_path_fn` has a ~1.9 s first-call penalty** (2287 cold, 386 warm).
   **`find_references_fn` is slower warm than cold** (1601 vs 1288). Both are
   unexplained and unprofiled.
7. **Fast paths:** exact and identifier search 21–25 ms, `read_open_symbol` warm
   14 ms, `continue_search` 3 ms, `detect_changes` 50 ms.
8. **Index coverage:** 102 of 1254 tracked files are not in the published index.
   Not explained. Check the publication policy's exclusions before calling it a
   defect.

## Index state changes the NL numbers

- bench1 (stable): `search_nl_grouped` returned 7670 bytes and 64 available
  groups, warm about 2158 ms.
- The profiled run and a recheck on 2026-10-08 (`workloads.nl.json`, 5 warm runs
  each) both started in `freshness.state = "sync_in_progress"`, with a pending
  sync (generation 5 in the profiled run, 6 in the recheck). Grouped responses
  were 9212 bytes with 61 available groups in both; raw responses were 16896
  bytes. Grouped: cold 2450 ms (profiled) and 2906 ms (recheck), warm 93–142 ms.
  Raw: cold 82–86 ms, warm 79–91 ms.
- The ~100 ms figures are a sync-state result, not steady state. Do not quote
  them as NL latency.
- The only untracked entry in the scratch clone is the `node_modules` symlink
  (`git status`). That is a candidate cause of the persistent sync state. It is
  not verified.

## Improvement lanes (proposed; none implemented)

Each lane gives the claim, the check that would disprove it, and where to stop.

1. **Stable measurement (prerequisite).** Find out why the clone stays in
   `sync_in_progress`: add the `node_modules` symlink to `.git/info/exclude`,
   restart, and confirm `freshness` is absent. Then make the harness refuse to
   time while `freshness` is present, use distinct NL queries (so a result cache cannot
   hide the cost; none was visible here), run 3 processes per workload, record load and RSS, and fix the three
   error workloads. Stop when a rerun reproduces bench1 within run-to-run spread.
2. **Attribute NL time (scratch clone first).** Add spans for query embedding,
   vector search, candidate build, rerank queue wait, per-document encode
   (aggregated), MaxSim, disclosure, and serialization. Disproving check: the
   spans sum to within 5% of `search.coordinator_total`. If rerank is under 50%
   of a steady-state request, lanes 3 and 5 drop in rank. Stop when the top two
   stages are named, with medians of 3 processes.
3. **In-process cache of LateOn document encodings.** Key: content hash plus
   model and profile fingerprint. Bound by bytes (LRU). Uncached fallback
   whenever the key is missing. Check first: how many candidates in the pool
   recur across distinct queries (the pool is 80 per the handoff notes, not
   verified in code; see `buildRerankCandidatePool` in `search-rerank-policy.ts`
   and `rerankerResultLimit` in `search-policy.ts`). Without recurrence the cache
   gains nothing. Stop once recurrence is measured; drop the lane if candidates
   rarely recur. Verify: a differential test (cached vs uncached
   scores bit-identical over fixtures) and a mutation check (drop the fingerprint
   from the key; the test must fail). Ask before setting the memory bound. An
   on-disk cache is a separate decision.
4. **Warm the LateOn session at server start.** Targets the ~1.8 s first-call
   penalty. Verify: time to first search, cold vs warm; RSS delta; medians of 3
   processes. Stop once the first-call penalty is measured with and without
   warm-up across 3 processes. Ask before: this changes startup cost and resident memory.
5. **Scoring loop without per-token allocations** (MaxSim and normalize). Do this
   only if lane 2 shows a material JS share; stop after lane 2 if the JS scoring
   stages are not among the top two stages; ONNX is the larger share per the
   earlier notes. The code comment says every score must match the serial path,
   so the test is bit-identical per score (`Object.is`) plus a mutation check.
6. **Status and architecture overview.** Profile `manage_index status
   detail=full` and `architecture_overview` once each before choosing a change;
   stop once each call's dominant stage is named.
   If the `status` cost is constant per publication, cache it behind the
   publication generation, with an uncached fallback. Verify: a differential test
   against uncached output and a mutation check on the generation witness.

## Limits

- One machine (WSL2, CPU inference) and one clone.
- No stage split for NL search yet (lane 2).
- Earlier cost figures come from handoff notes and were not re-run.
- Steady-state NL numbers come from one process (bench1). Three-process medians
  are not yet measured.
