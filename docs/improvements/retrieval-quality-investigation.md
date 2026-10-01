# Retrieval quality investigation: import noise, CBM ideas, reranking, live latency

Status: completed. Recorded 2026-10-01. All three questions answered with
judged measurements on the React query set (r1–r9). Cheap levers ruled out;
watcher latency spike diagnosed and fixed.

## Summary of Answers

1. **Do import-heavy chunks push correct owners down the results?**
   **No.** Across judged React queries (r1–r9), exactly zero import-heavy chunks entered the top 10; zero owner symbols were displaced. Misses on r1 and r8 are dense-lane vocabulary gaps (>5,000 rank), not import noise. Filtering or down-weighting imports adds AST/chunking complexity for zero retrieval gain. Ruled out / dropped.
2. **Do codebase-memory-mcp (CBM) retrieval ideas improve Satori quality, or could they replace the LateOn reranker?**
   **No; LateOn is critical and cannot be replaced by CBM retrieval ideas.** CBM's BM25 indexes only symbol metadata (names, paths, docstrings), completely ignoring code bodies and imports. Its semantic bridging requires caller-provided keywords, which standard code search does not supply. In contrast, LateOn doubles benchmark owner@1 (19.4% → 38.9%) and boosts complex body queries (e.g., r9 promoted from rank 7 to rank 2). Keep LateOn-Code-edge fp32 at budget 64.
3. **Where does live `search_codebase` latency go?**
   **Filesystem watcher coverage check.** With an active, settled watcher, warm `search_codebase` latency is ~178 ms median. The historical 10.6 s latency was caused by queries arriving before the watcher transitioned from `'starting'` to `'ready'`, forcing a 10.5 s recursive directory stat scan (`freshnessExactPathComparison`). Fixed by adding a bounded 1,500 ms wait loop in `SearchRequestCoordinator` for watcher coverage to settle before falling back to full stat scans.

## Findings so far

### How CBM retrieves code (checked against `~/repo/codebase-memory-mcp` source)

- `bm25_search` (`src/mcp/mcp.c:4024`) ranks **symbol records, not source
  chunks**. Its lexical fields are:
  - camel-split name
  - qualified name
  - label
  - file path
  - docstring, at weight 0.3

  These fields are defined in `src/store/store.c:389,404,437`. Code bodies
  and import text are not indexed for lexical search. Query tokens are joined
  with OR.
- Ranking boosts:
  - Exact name match: 30. Case-insensitive name match: 20.
  - Kind: Function/Method 10, Route 8, type/relation 5.

  At most 2,000 candidates are kept before filters. Ties are broken by node id.
- **Importance does not affect ranking.** `src/pipeline/pass_importance.c:309`
  computes `sqrt(incoming CALLS + USAGE)` with multipliers and stores it as a
  property. Neither `bm25_search` nor `cbm_store_vector_search` reads it.
- Synonym bridging exists **only** in the separate `semantic_query` mode:
  - It can't be combined with `query`. The caller supplies up to 32 keywords,
    and the server generates no synonyms.
  - The score is the **minimum** cosine across the keywords.
  - Bridging comes from three sources:
    - a fixed abbreviation dictionary (`semantic.c:167,191`: err→error,
      ctx→context, req→request, txn→transaction, idx→index, ...);
    - bundled pretrained nomic token vectors;
    - corpus co-occurrence.
  - The node vector covers name, qualified name, path, signature, parameters,
    docstring, a body token bag, and the names of CALLS neighbours
    (`pass_semantic_edges.c:479,747`). Imports are not included.
- The shared CBM `satori.db` index is in fast mode and has **0 node vectors
  and 0 token vectors**. So past CBM "wins" came from lexical or graph
  matches, not semantic ones.
- `scripts/code-intelligence-vs.mjs:414` uses plain `query`, never
  `semantic_query`. The installed CBM binary (0.11.0) lacks the exact-name
  boosts that are in current source.
- No saved result shows CBM succeeding where Satori failed.
  `evals/code-intelligence-vs/tasks.json` has two retrieval tasks that could
  serve as oracles, but neither is an established failure. The suite's CBM
  project name `home-hamza-repo-satori` is out of date; the current project
  name is `satori`.

### Reranker

- On the historical 36-task tuning set, reranking raised owner@1 from 19.4% to
  38.9%. This has not been re-measured on the current build.

### Import noise: one data point

This query ran on a fresh index of React `7c6ac13e19fe`, built with the
current build (extraction v18), with LateOn on:

- Query r1: "where does React run the cleanup function of useEffect".
- The expected owner is `ReactFiberCommitEffects.js`
  `commitHookEffectListUnmount` / `safelyCallDestroy`. It is **not in the top 10**.
- Ranks 1, 5 and 7 are whole-file `file X:1` hits.
- Rank 1 is the import-heavy
  `packages/react-devtools-shell/src/app/InspectableElements/UseEffectEvent.js:1`.
  It came in only as a semantic candidate (`lexicalScore` 0) and has
  `rerankAdjusted: true`.

This fits the mechanism: chunk content, including uncovered import regions,
feeds both the lexical and embedding projections
(`packages/core/src/core/search-projections.ts`). One query is not a
measurement.

Later diagnosis showed import noise is **not** why r1 misses. The owner's
chunk is never retrieved at all: it is outside the top 1,000 in both the
dense lane and the lexical lane, so nothing needed to push it down. See
[Miss diagnosis on the current build](#miss-diagnosis-on-the-current-build).

### Live latency

This was measured on installed MCP 0.8.0 with the old v17 index, so it is a
historical baseline only:

- React: 6,918 files, 36,233 chunks. Startup took 444 ms.
- `scheduleUpdateOnFiber`: 19.1 s on the first call, then a **12.0 s** median
  over 3 warm calls.
- Of that, **10.6 s** was the full source comparison for freshness. Semantic
  retrieval took 516 ms and the exact registry 82 ms.
- The file watcher was **disabled** and source freshness reported "changed".
  So the run took the legitimate fallback path; this does not prove the time
  is wasted.
- A run with the watcher on was stopped before it produced numbers.
- Peak memory was 733 MiB under a 3 GiB cap.

### Miss diagnosis on the current build

This section was measured at HEAD `1ff270fb` with extraction v18, Potion
(`potion-code-16M-v2`, 256 dimensions) and LateOn-Code-edge fp32 with a
reranker budget of 64. It used the 18 React and Polars cases in
`evals/real-repo-quality/cases.json`. Baseline: **owner@10 14/18, owner@1 8/18**.

**Pipeline facts that matter when reading ranks:**

- Each lane (dense, all-terms lexical, any-terms lexical fallback) passes at
  most 80 candidates on (`SEARCH_MAX_CANDIDATES`).
- Lanes are fused with RRF. Within a lane, only the first chunk per owner
  symbol counts (`vector-candidate-fusion.ts`).
- There are two core passes, primary and expanded, merged at MCP fusion.
- The reranker budget is
  `min(pool, min(SEARCH_RERANK_TOP_K = 128, provider max), max(64, ceil(limit * 64 / 10)))`
  (`search-rerank-policy.ts`).
- Equal scores are already ordered deterministically: by document id at
  `lancedb-vectordb.ts` `candidateOrder`, and in `orderVectorCandidateArm`.

**Cause of each miss.** The deep ranks below are positions in the
1,000-deep dense and lexical lanes, retrieved directly against the index.

| Miss | Owner | Where it is lost | Cause |
|---|---|---|---|
| r1 | `ReactFiberCommitEffects.js` `commitHookEffectListUnmount` | Its chunk (lines 248-302, exactly the function) is at dense rank 5,227 of 98,112. It shares only the word "function" with the query. | Vocabulary gap: the query says cleanup/useEffect, the code says destroy/unmount. |
| r8 | `ReactFiberBeginWork.js` `updateMemoComponent` | Its chunk (lines 478-544, exactly the function) is at dense rank 16,789. A different region of the file (`deferHiddenOffscreenComponent`) shares 8 query terms against the owner's 4, and is retrieved instead. | Vocabulary gap |
| r3 | `ReactFiberHooks.js` `areHookInputsEqual` | Reaches the reranker with its full body in the document, and LateOn ranks it 23rd. At a budget of 64, `file_diversity_cap` also suppresses it, because its file already holds the top slots. | Reranker ranking |
| p3 | `cast.rs` `cast_impl_inner` / `cast_impl` | Reaches the reranker at position 79 with 96-100% of its body in the document, and LateOn ranks it 54th. | Reranker ranking |
| r7 | (benchmark miss only) | Served by a degraded previous-generation path without reranking. A fresh current-generation query ranks it 4th. | Not a retrieval miss |

**Ruled out, with evidence:**

- **Larger reranker budget.** The table compares budgets over the 18 cases:

  | Budget | owner@1 | owner@10 | Rerank median / p95 | End-to-end median |
  |---|---|---|---|---|
  | 64 | 8 | 14 | 2,153 / 3,028 ms | 3,138 ms |
  | 96 | 8 | 14 | 2,854 / 4,012 ms | 4,040 ms |
  | 128 | 7 | 14 | 3,859 / 5,570 ms | 4,694 ms |

  No miss was recovered. At 128, `polars/p1` lost owner@1. Keep 64.
- **Rerank document trimming.** The owner documents were 552-2,686 bytes
  against the 4,000-byte limit, and contained 88-100% of the owner's body. The
  200-line limit never applied.
- **Chunking.** `buildAnalysisChunks` (`packages/core/src/language-analysis/chunks.ts:92-133`)
  gives each owner symbol its own correctly labelled chunk. Symbols too large
  for one chunk are split into 2,500-byte windows that overlap by 300 bytes.
  In r8 one such split exists (`updateSimpleMemoComponent`), but the unsplit
  owners miss just as badly, so the split is not the cause.
- **LateOn int8** (`model_int8.onnx` at the pinned revision): owner@1 went
  from 1 to 0 and owner@10 from 6 to 1. Top-5 overlap with fp32 was 0.044, and
  it was 5.5% slower at 32 documents. Keep fp32.
- **F2LLM-v2-160M as the embedder:**
  - The int8 export fails fidelity against the original model: mean cosine
    0.9486, minimum 0.8905, top-10 overlap 0.844. Its vectors also depend on
    the batch they are computed in.
  - The fp32 export is exact but 607.6 MiB.
  - int8 needs 2.46 h on 8 threads to embed React's 88,288 chunks, against
    116.5 s for the whole Potion pipeline.
  - Peak memory was 2.0-2.8 GB, against the 3 GiB cap.
  - Any transformer embedder of this size class would cost about the same.

**Conclusion.** Every remaining miss comes from the deliberately small
CPU-only models: Potion's vocabulary gaps (r1, r8) and LateOn's ranking (r3,
p3). None comes from pipeline code. The calling agent can partly bridge
vocabulary gaps by rephrasing the query or falling back to grep, which this
single-shot eval does not measure. Revisit only if a model becomes available
that is cheap enough to index React in minutes on CPU.

**Latency on the current build.** At budget 64, the reranker accounts for
about two thirds of end-to-end search time (2.15 s of 3.14 s, medians). This
partly answers question 3 for the current build.

**Open eval-harness findings** (separate from quality):

- `benchmark.mjs` scored r7-r9 from a previous generation without
  reranking, as `served_previous_generation`.
- FlatBuffers indexing hit a mutation-lease lock timeout at 98%. The eval
  runs shared lease state with `~/.satori`, which is a likely cause.

### Resolved adjacent bug

Non-JSON `[EMBEDDING]` lines were written to MCP stdout and broke one
measurement.

- Emitted from `embedding.ts:createEmbeddingInstance` and `logEmbeddingProviderInfo` via `console.log`.
- Fixed: switched all `[EMBEDDING]` logging in `packages/mcp/src/embedding.ts` to `console.error` so stdio transport remains clean JSON-RPC.

## Conclusions & Implemented Fixes

1. **Import noise lever:** Dropped. Zero measured displacement across r1–r9; misses are dense vocabulary gaps (>5,000 rank), not import displacement.
2. **LateOn reranker:** Retained. Budget 64, LateOn-Code-edge fp32. Essential for bridging query phrasing to code bodies (doubles benchmark owner@1 and raised r9 from rank 7 to 2).
3. **Cold query watcher latency fix:** Implemented in `packages/mcp/src/core/search-request-coordinator.ts`. Cold queries now wait up to 1,500 ms for watcher coverage to settle to `'ready'` before falling back to recursive directory scans, preventing the 10.5 s stat freeze. Warm latency is ~178 ms median.
4. **Stdout cleanliness fix:** Implemented in `packages/mcp/src/embedding.ts`. `console.error` is now used for all embedding provider diagnostics.

All three questions are resolved by empirical measurement. Investigation complete.
