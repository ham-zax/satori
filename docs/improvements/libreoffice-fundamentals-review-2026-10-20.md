# LibreOffice fundamentals review, 20 October 2026

Status: original and follow-up read-only reviews complete. This reviewer made no product repairs.
Hamza requested this document to preserve the review across context compaction.
Update this document as evidence changes. Keep observations separate from estimates.

Latest checkpoint: R5 and R6 are committed. Hamza reports focused tests, typecheck, ESLint, and mutation checks passing.
The preceding follow-up review at `207496e6` reproduced both findings below.
Earlier implementation status and priorities describe the initial review, not the current tree.
See "Follow-up review of implemented changes" for measured progress and two new reproduced safety findings.

## Task and boundaries

Review Satori, semble, and codebase-memory-mcp (cbm). Deliver:

1. Root causes for indexing time and memory, with source evidence.
2. Ranked changes for indexing, memory, search latency, and quality.
3. A target architecture for a complete index within 200 s and 6 GiB.
4. Independent measurement steps, with the memory repair first.
5. Additional correctness, cancellation, ordering, and crash risks.
6. Work to remove when evidence shows no benefit.

Keep dense Potion embeddings, BM25, `alt_terms`, fusion, and the reranker.
Keep symbols, references, call graphs, trace paths, and incremental sync.
Keep immutable generations, atomic publication, bounded memory, and cancellation ownership.
Do not edit product code, run a full index, or delete stored indexes for this review.
Documentation changes are now explicitly authorized. Do not commit or push.

Hamza fixes four adjacent items concurrently. Do not duplicate that work:

- Bad workspace metadata must produce unavailable freshness, not fail search.
- A failed final embedding flush must drain all submitted payload work.
- Repeated source-control discovery during search needs a valid cache witness.
- Remove obsolete cap documentation and unreachable `limit_reached` code.

The parity plan records those items as findings 1, 3, 4, and 2 plus 5.
See [the parity plan](libreoffice-index-parity-plan-2026-10-20.md).

## Source provenance

- Satori inspection started at `94bb37ca019a7c26733004b8a36360e60c99b8ff`, branch `master`, plus existing dirty work.
- Semble: `/home/hamza/repo/bench-bugs/semble-eval-20261020/src`, commit `8ee6463efbb1ff755c339e965c7298b7afd7db5b`.
- Cbm: `/home/hamza/repo/codebase-memory-mcp`, commit `11b662f9f7fba92012b872dd4fcaef7ee0c1300d`.
- Remote heads checked: Satori and semble matched those commits. Cbm remote HEAD was newer, `4c80d89edf1283cfeaa7e60ecbf40c9d2eb2b689`.
- Cbm measurements below use the author's 0.12.1 run and its retained database, not an assumed upstream performance claim.
- The code graph index dated 6 October was stale for several owners. Source reads supply the evidence here.
- Existing staged and unstaged edits belong to Hamza. Concurrent edits can move line numbers and invalidate earlier checks.
- HEAD later moved to `d04572f4cdf2a359e3703ebd553fd10d395d1d40` during concurrent work. This review did not commit or stage files.

One Claive worker reviewed navigation through `gpt-6.1-sol`, reasoning `xhigh`, read-only.
Worker `042ade278ed3` completed and closed. Managed terminal `35333` completed.
Report: `/home/hamza/.local/state/claive/042ade278ed3/result.txt`.
The parent checked material findings against current source and reproduced two defects independently.
No other worker belongs to this review.

## Baseline corrections

- The 368.3 s r4 run stopped at 450,000 chunks. It is not a complete-index baseline.
- Full r9 published 35,760 files and 547,349 chunks in about 740 s.
- R9 fit within 6 GiB after `MALLOC_ARENA_MAX=2`. It did not provide complete C++ calls.
- D8 now skips a provably failing C++ semantic session. D8 preserves degraded graph coverage.
- Hamza reports D8 focused tests and type checks passing. He has not rebuilt core or MCP dist.
- Semble source builds BM25 as well as dense vectors. Its timing is not the cost of navigation or an equivalent reranker.
- Cbm actually took 236 s. The earlier estimate below 100 s is superseded.
- Cbm's charged allocations are not peak RSS. Do not claim a memory ratio from charged bytes versus Satori anonymous memory.
- `use_multiprocessing=False` does not establish a single native tokenizer thread.

The 200 s target remains unproven. Cbm alone exceeds it on a different, larger file set.
A combined implementation must share extraction, overlap bounded stages, and remove repeated work.
Do not add overlapping spans or projected savings as independent wall time.

## Existing artifacts and measured graph counts

Correct cbm run directory, after resolving the abbreviated path Hamza supplied:

`/tmp/claude-1000/-home-hamza-repo-satori/0ec295a5-ec10-4e0b-9954-1414cf46ae13/scratchpad/cbm-lo/`

Database:

`cache/home-hamza-repo-bench-bugs-polyglot-2026-10-19-222137-corpus-libreoffice.db`

Read-only SQL checked:

- `SELECT type, count(*) FROM edges GROUP BY type`: 698,194 CALLS, 1,321,901 USAGE, 576,845 DEFINES, 212,506 IMPORTS.
- `SELECT count(*) FROM node_vectors`: 257,442 rows. These are not evidence of equivalent Potion chunk embeddings.
- The author reports 602,680 nodes, 44,065 File nodes, and 3,115,365 edges.
- `COUNT(DISTINCT file_path)` over File nodes returns **36,383 actual paths**. The remaining File nodes are 7,621 parse-partial diagnostics and 61 parse-unusable diagnostics.
- Checked example: `UnoControls/inc/basecontainercontrol.hxx` has a normal File node and a second File node with `properties.kind = parse_partial`.
- File-set intersection: 35,367 paths common to r9 and cbm, 393 Satori-only paths, and 1,016 cbm-only paths. Compare real paths rather than File-node totals.
- The author reports 646,370 C/C++ calls. This language split was not independently recomputed yet.
- The time wrapper reports 236.50 s. Its 13,580 KiB maximum RSS measures the CLI, not the indexing daemon.

Satori r9 state:

`/home/hamza/repo/bench-bugs/libreoffice-perf-20261020/full-r9-arena2/state/`

Publication:

`ba841e429f38f0b40411846e6799f907312bd0c03480dfa98df101312cedd71a/generations/a14a0624-bb6b-4b66-b5a1-c212e44040e9`

Read the relationship manifest and its 1,218 nonempty shards. Counts checked:

| Relationship | R9 count |
|---|---:|
| CALLS | 18,441 |
| EXPORTS | 2,051 |
| IMPORTS | 2,663 |
| TESTS | 16 |
| Total | 23,171 |

The manifest covers 35,760 relationship shards. Its C++ provider coverage is unavailable for all 22,312 source files.
These counts have different semantics and file sets from cbm. A ratio is not a graph recall measurement.

Keep the cbm database and r9 state until the remaining comparison finishes.
Older vector stores can be removed after preserving logs, profiles, commands, source versions, and results.
Do not delete whole run directories without separating those records from generated state.
No data was deleted during this review.

## Checked time mechanisms

### Payload scheduling and main-thread work

Owners: `core/indexing-pipeline.ts`, `language-analysis/parallel-service.ts`, `language-analysis/tree-sitter-adapter.ts`, `language-analysis/chunks.ts`, `symbols/registry.ts`.

- `scheduleAnalyses` admits a bounded window, but consumes promises in file order. One slow file can stall consumption and later scheduling.
- Thread workers receive copied source strings through `postMessage`. Results return through structured cloning.
- C++ analysis uses Tree-sitter WASM and JavaScript symbol/call extraction. It does more work than semble chunking.
- Chunk plans return to the main thread. `createAnalysisChunkPlan` reconstructs byte storage and source maps there.
- The pipeline traverses chunk spans once to count them and again to materialize them.
- `resolveOwnerSymbolForChunk` filters symbols and sorts candidates per chunk.
- `analysisMs` includes the wait, chunk-plan construction, chunk counting, and symbol-fact construction. It is not pure worker execution or pure IPC time.
- `symbolRecords` and `analysisByFile` grow through the corpus and remain reachable during navigation.

Native extraction can help, but the relative costs of parsing, JS traversal, copying, queueing, and GC still need separate timings.
Thread scheduling alone cannot explain the full difference from semble from these measurements.

### Embedding work

Owners: `embedding/potion-embedding.ts`, `embedding/potion-embedding-pool.ts`, `experiments/potion-l0-l1/src/lib.rs`, `experiments/potion-l0-l1/src/main.rs`.

- The resource plan allows 1,000 items. The actual Potion provider caps a batch at 64.
- R9 stderr confirms `Embedding batch policy: max_items=64` and 8,553 logical embedding requests.
- `StrictPotionModel.encode_batch` calls `retained_token_counts`, then `model.encode_with_args`.
- Both functions call the native tokenizer. Documents therefore tokenize twice.
- The pinned model2vec-rs implementation tokenizes a batch, then pools vectors per encoding.
- The helper request loop executes frames serially. Multiple pending requests per helper include queue time.
- Pool sizing uses CPU count, independently of analysis worker CPU demand. Tokenizer native pools can contend across helpers.
- JSON transports float vectors into JS `number[]`. The write adapter then converts row objects to Arrow.
- A larger batch also needs protocol work. The current worker frame limit is 1 MiB. Do not simply raise the item constant to 1,000.
- R9's 1,331 s embedding sum includes overlapping requests and queueing. It is not 1,331 s of measured CPU time.

`core/search-projections.ts` adds identity headers and repeated symbol terms to dense input.
The supplied sample attributes about 93 MB to headers over this corpus. Bytes are not tokenizer work.
Semble embeds raw chunk content. Header removal needs fresh indexes and quality checks.

### Scan and uncovered intervals

Owners: `core/indexing-pipeline.ts`, `config/index-policy.ts`, `core/index-policy-input-observer.ts`, `core/ignore-file-inputs.ts`, `sync/synchronizer.ts`, `sync/sync-scan.ts`, `generation/index-generation-workflow.ts`.

- Main scanning stats files before policy rejection. Unknown extensions can require content probes for shebang admission.
- `IndexingPolicy.supportedExtensions` is an array. `toExtensionSet` normalizes and reconstructs a set for each policy call.
- Semble's walker filters extensions before its later stat pass. Semble's file and size policies differ.
- Nested ignore discovery walks directories separately. Source validation later scans them again.
- `selectedSourcePaths.includes` runs for every consumed source. At 35,760 files, complete coverage requires about 639 million element comparisons.
- `prepareChanges({capturedFullIndexSource})` performs a validating scan. `assertSourceObservationCurrent` performs another scan before activation.

R9 timestamps locate the unexplained wall time:

- Server startup at 03:52:49.427, resource plan at 03:53:21.456: about 32 s.
- The background operation resolves policy before launching the candidate. Its observed-profile log follows about 30 s after operation start.
- Payload loop return at 03:59:16.301, navigation start inferred near 04:00:09.184: about 53 s.
- Navigation ends at 04:04:27.623, core performance record at 04:05:09.526: about 42 s.

Policy observation, source preparation, final observation, and other publication work occupy those boundaries.
Exact attribution needs spans around the calls. The existing trace does not prove the duration of each owner.
The core total is 708.056 s. The remaining startup and polling time explains the larger external total.

### Navigation and storage

Owners: `generation/index-generation-workflow.ts`, `symbols/registry.ts`, `relationships/admission.ts`, `relationships/builder.ts`, `symbols/sidecar-writes.ts`, `symbols/sidecar-lifecycle.ts`.

- `buildSymbolRegistry` attaches parent keys, sorts symbols, and creates six indexes.
- `admitAuthoritativeProofBackedCalls` reconstructs an instance map that the registry already owns. Language passes repeat that work.
- Semantic timings start after source loading and hashing. R9 reloads an entire language before the C++ session fails.
- Current D8 avoids that full-index read. The delta path still reloads all sources for the affected semantic language.
- Symbol and relationship staging each create one shard per file: 71,520 files for r9.
- Only 1,218 relationship shards contain relationships, but all 35,760 persist analysis evidence or empty contributions.
- `writeSerializedJson` repeats recursive directory creation for each shard.
- `fsyncDirectoryTree` enumerates, stats, opens, syncs, and closes the new files. Do not remove durability without a replacement invariant.
- R9 stage time is 139.875 s. File operations and JSON serialization are plausible major owners, but their shares remain unmeasured.
- Lance FTS finalization overlaps navigation, combining native and JS peaks.
- The supplied store prototype saves about 9 s with flat vectors plus SQLite FTS5, but slows keyword queries from 5.7 to 96.9 ms.

Replacing payload storage alone is not supported as the first performance change.
Changing navigation storage has a separate justification: corpus-sized objects and tens of thousands of durable files.

## Memory conclusions and limits

- Proven retention: relationship evidence, symbol records, registry indexes, queued payloads, and watcher state.
- Supplied profiles attribute about 460 MiB to analysis results and 250 MiB to registry data.
- Spilling those owners can remove roughly 710 MiB of JS residency. Actual savings need a heap comparison.
- The additional 250 MiB source-string retainer remains unresolved.
- Navigation's per-language `sourceFiles` explicitly holds source text before semantic analysis. The same source-read helper supplies those strings.
- A source allocation stack does not prove whether payload closures, substring backing storage, or semantic rereads retain those specific strings.
- D7 reduces arena retention substantially. It does not bound live FTS construction or corpus-sized JS maps.
- Root-count and queue-size limits do not bound a registry's total bytes or one oversized file's extracted evidence.
- `navigation/publication-state-cache.ts` limits roots, not resident bytes. A single full graph remains large.
- The current Lance FTS peak alone prevents claiming a bounded LibreOffice build on a 2 GiB machine.

Need a memory budget across the complete process tree and cgroup page cache.
Treat worker counts as admission limits, not proof of a memory bound.

## Newly reproduced defects

### R1: stale claims after failed semantic delta

Checked owners: `generation/index-generation-workflow.ts:1841`, `relationships/builder.ts:125`, `navigation/store.ts:583`.

The delta retains unchanged evidence with old `resolutionClaims`.
The failed provider returns no occurrences. `attachResolutionClaims` replaces entries only when the new map contains that file.
An old claim can survive even though its target symbol instance and CALLS edge no longer exist.

Independent temporary fixture output:

```json
{"staleResolvedClaims":1,"target":"helper-1","callEdges":0}
```

The fixture adds an assertion to the existing provider-failure scenario from `generation/semantic-workflow-delta.test.ts`.
It supplies captured stat signatures to match the current full-index port.
The new assertion expects no resolved claim targeting `helper-1` after replacement by `helper-2`. It fails, `1 !== 0`.
No repository test or fixture changed.

Proposed repair: replace claims for every rebuilt owner, including an empty result. Avoid mutating retained publication evidence.

### R2: shard writes outlive failed staging

Checked owners: `symbols/sidecar-writes.ts:198`, `:551`, and `symbols/sidecar-lifecycle.ts:326`.

Shard batches use `Promise.all`. First failure starts cleanup before sibling writers settle.
A deterministic fixture holds one writer behind a gate and fails its sibling.
Staging rejects while the held writer remains active. Releasing the gate makes that writer continue after rejection.

```json
{"pendingAtReturn":true,"continuedAfterRejection":true}
```

The invariant assertion fails. The fixture joins the held operation and removes its own temporary directory afterward.

Proposed repair: settle every started writer before cleanup. Preserve the first failure and surface unresolved cleanup.
This is separate from Hamza's final-embedding-flush repair.

### R3: existing provider-failure test currently fails earlier

Executed from `packages/core`:

```bash
node --liftoff-only --import tsx --import ./src/test-state-root.ts --test \
  --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 \
  --test-name-pattern='delta rebuild removes stale semantic calls when the provider fails' \
  src/generation/semantic-workflow-delta.test.ts
```

Result: one failed, zero passed. `Cannot read properties of undefined (reading 'size')`.
Current `index-generation-workflow.ts:500` dereferences `sourceStat.size` on the older fixture's captured source.
Hamza received this result. Do not conflate this failure with his passing new D8 focused test.

### R4: lexical aliases escape the queue's byte estimate

Checked owners: `core/search-projections.ts:35`, `core/indexing-pipeline.ts:752`, and `indexing/resources.ts:194`.

`buildLexicalIdentifierAliases` generates every prefix from length four to the component's full length.
The serialized prefix text grows quadratically with identifier length.
Queue admission charges dense embedding text, while the resource plan assumes about four times that size for other fields.

A temporary check calls the actual projection builder on valid C++ function names:

| Identifier characters | Dense bytes | Lexical bytes | Lexical / dense |
|---:|---:|---:|---:|
| 39 | 247 | 951 | 3.9 |
| 135 | 536 | 9,256 | 17.3 |
| 519 | 1,688 | 134,632 | 79.8 |
| 1,031 | 3,225 | 531,177 | 164.7 |

This is a deterministic mechanism check, not a LibreOffice frequency measurement.
It disproves the general four-times-size bound. Generated identifiers can defeat the memory plan before the dense queue reaches its limit.
Lance also sets `maxTokenLength: 255`, so many long generated aliases cannot become complete indexed tokens.

Proposed repair: bound amplification at the lexical projection boundary and charge actual retained bytes.
Do not silently discard a projection after admission. Compare tokenization and query results before changing aliases.
The backend-neutral projection needs an explicit contract if it uses a backend's token limit.

## Other source-supported risks

- C++ call completeness: Satori's 100 MiB and 20,000-source session limits belong to its fork, not upstream cbm.
- Incremental cost: registry reconstruction, language-wide source loading, evidence scans, and per-file links still scale with corpus size.
- Cancellation: CBM resolution and registry sorting can execute within one synchronous generator step. Staging lacks a cancellation contract.
- Existing MCP containment waits for process-group quiescence after forced termination. Core cooperative cancellation is still coarse.
- Search ties: `retrieveStableWindow` doubles fetches until the score boundary closes. An all-tied query can materialize the full collection.
- Search dense path: `retrieveDense` explicitly calls `bypassVectorIndex`. Creating an ANN index alone will not accelerate it.
- Query expansion: `search-execution.ts` always runs caller `alt_terms` through a second semantic pass after the primary pass.
- Core hybrid retrieval waits for query embedding before starting BM25. Those independent operations can overlap.
- Reranker encoders compute document vectors on each request. A byte-bounded cache keyed by immutable document/model identity is a candidate, not a proven benefit.
- Cold navigation loads complete sidecars. Idle expiry can recreate a large read and allocation cost.
- Manifest hashes do not bind full shard contents. Valid-shaped, count-preserving corruption is not ruled out by those hashes alone.
- Navigation readers return cached records and arrays directly. No first-party mutation was found, but immutability depends on callers.
- Relationship ordering omits byte and column tie-breakers. Same-line calls can compare equal.
- Generated or adversarial files can produce much more evidence than their source-byte reservation predicts.
- Nested-symbol chunk spans can embed enclosing bodies and child bodies. Measure duplicate token work before changing chunk boundaries.
- Lexical projections generate identifier prefixes. Their size and quality contribution need an ablation.
- Lance FTS stores token positions, but inspected first-party retrieval uses `MatchQuery`, not phrase queries. Positions are a concrete build-cost ablation.
- The installed 0.39 FTS options expose no writer-memory budget. Metadata-cache limits do not bound FTS construction.
- An incremental FTS-rebuild hypothesis was rejected: `finalizePreparedCollection` is called on the full-index path, not on every delta. Do not attribute a full FTS rebuild to small edits without new evidence.
- Raw call arguments have consumers: `relationships/builder.ts:304` attaches them to edges, and MCP traversal exposes them. They are not an unconsumed-field deletion candidate.
- `Utf8SourceMap` already proves ASCII identity, but its UTF-16-to-byte path still constructs a per-character number array. A witness-backed identity path is a lower-priority candidate.

## Ranked changes, not implementation approval

All time estimates below are hypotheses or upper bounds unless marked measured.
An eliminated cost can overlap another stage and save no wall time.
`B`, `Q`, and `L` refer to the commands in the measurement section.
For each experiment, change one mechanism, keep the corpus fixed, and compare three runs.

| Rank | Change and owning files | Saving basis | Risk and evidence | Isolated measurement and stop condition |
|---|---|---|---|---|
| 1 | Spill symbol records and relationship evidence while extracting. Owners: `core/indexing-pipeline.ts`, `generation/index-generation-workflow.ts`, `symbols/registry.ts`, and sidecar/store ports. | About **710 MiB gross JS residency** is the opportunity in the supplied 460 + 250 MiB attribution. Native indexes and disk caches consume part of that saving. Source strings add at most another supplied 250 MiB only after their retainer is proved. | High: retain cross-file resolution, source witnesses, and private publication ownership. Cbm proves spill-backed extraction is practical on this corpus. It does not prove these exact savings. | `B` with spill as the only change. Compare retained bytes before navigation, cgroup peak, graph results, and cancellation cleanup. Stop on missing claims, changed source coverage, or memory that still grows with the complete evidence set. |
| 2 | Replace per-file navigation artifacts with a paged graph store or packed immutable contributions. Owners: `symbols/sidecar-writes.ts`, `symbols/sidecar-lifecycle.ts`, `navigation/store.ts`. | **140 s is the measured stage ceiling**, not a forecast. A 50–100 s saving is plausible only if file operations dominate. There are 71,520 shard files and per-file sync operations. | High: crash durability, symbol identity, query behavior, and delta reuse. Cbm proves bulk graph storage. SQL prepared batches are a safer first trial than copying its custom SQLite page writer. | `B`, with separate serialization, write, stat, and fsync spans. Preserve normalized records and inject failure before/after sealing. Stop if reduced file count does not reduce the measured owner or if crash outcomes change. |
| 3 | Use shared native extraction and per-file resolution against one global registry. Owners: `language-analysis/tree-sitter-adapter.ts`, worker services, `semantic/wasm/*`, `relationships/contributions/cbm.ts`, and the existing native sources. | The current payload span is **323 s** and analysis-related wait is **194 s**. Removing one third to two thirds of that wait would save roughly **65–130 s**, but the eliminated share is unmeasured. Complete C++ calls add work absent from r9. | High: extraction parity, proof admission, packaging, cancellation, and Unicode spans. Cbm proves complete large C++ resolution without Satori's session limits. Its **236 s** run does not prove a combined 200 s result. | `B` with the same admitted file manifest. Measure read, parse, extraction, transport, consumption wait, and resolution separately. Check cross-file C++ cases and normalized output. Stop if gains come from missing files, missing evidence, or weakened call authority. |
| 4 | Consolidate scan observations. Compile extension policy once and use set membership. Owners: `core/indexing-pipeline.ts`, `config/index-policy.ts`, policy observation, `sync/synchronizer.ts`, and the workflow. | Initial scan is **34 s**. The additional 32/53/42 s intervals contain repeated work. A **20–60 s** saving is a planning range, conditional on measured repeated scans. A set removes about 639 million membership comparisons. | Medium: new files, deletes, policy edits, and source races. Semble proves a roughly 10 s discovery pass under its different policy. It does not prove equivalent freshness. | `B` after changing one scan owner. Count directory/file operations and time each validation boundary. Preserve behavior under edits during indexing. Stop if a journal gap or changed policy can pass final validation. |
| 5 | Tokenize once, coordinate CPU demand, and enlarge embedding frames by bytes. Owners: Potion Rust code, `potion-embedding.ts`, pool, and resource planning. | **0–40 s wall** is an initial experiment range, not a measured forecast. Current 8,553 requests contain duplicate tokenization and queue time. A 1,024-item ceiling would reduce the item-count request floor to about 535, but the byte limit can require more frames. | Medium to high: preserve unknown-token filtering, retained counts, normalization, deadlines, and foreground service. Semble proves simpler batched content embedding. Do not copy pooling mathematics into TypeScript. | `B` with helper count and native thread count fixed, then vary one count at a time. Record native tokenize/pool time and queue time. Compare vectors and error behavior. Stop when throughput stops improving or total CPU/RSS rises without wall reduction. |
| 6 | Disable unused FTS positions as an isolated trial. Owners: `vectordb/lancedb-vectordb.ts` and index identity if required. | **0–26.5 s** is the full measured finalize ceiling. Memory saving is unknown within the measured **1.7 GiB build peak**. Installed FTS documentation states positions increase build cost and support phrase queries. | Low to medium: first-party calls use word matching, but check all declared consumers and scores. Neither reference proves the saving for Lance. | `B` with `withPosition: false`, followed by lexical differential queries and `Q`. Stop if supported matching changes, MRR falls, or the measured peak remains unsuitable. This trial precedes a keyword-store migration. |
| 7 | Reduce dense headers. Owner: `core/search-projections.ts`, projection identity, and affected consumers. | The supplied whole-header estimate is **93 MB**. At the old supplied rate, that is about **65 s summed embedding duration**. It is not 65 s wall. A **0–30 s wall** range is conditional on token counts and the critical path. | Medium: metadata can help semantic retrieval and keep otherwise unknown chunks embeddable. Semble proves content-only input, not equivalent Satori quality. | Fresh-index `B` and `Q`, one field group at a time. Keep lexical metadata and fixed caller terms. Stop if final MRR falls below the agreed baseline. Report recall and per-case changes. |
| 8 | Bound watcher and graph-reader residency. Owners: `mcp/core/sync.ts`, navigation store/cache, and source-observation handoff. | The server owner is about **1.27 GiB**, mostly watcher state. Reducing it toward a 200–400 MiB total suggests roughly **0.8–1.0 GiB** opportunity. That target is unmeasured. Paged graph reads also avoid complete-registry cold loads. | Medium to high: directory creation, ignore changes, event loss, startup races, and old-generation readers. Cbm supplies relevant native process and storage patterns. | `B` with watcher memory separated from indexer memory. Use `L` for cold navigation. Inject event loss and directory changes. Stop if new files can remain invisible or unknown coverage can count as current. |
| 9 | Remove redundant dense work for caller terms and overlap keyword retrieval with query embedding. Owners: `mcp/core/search-execution.ts`, `search-retrieval-passes.ts`, and `core/semantic-search-service.ts`. | Each avoided extra dense pass removes about **162 ms** in the supplied store experiment, plus one query embedding. This is a component estimate, not full-request latency. Initial BM25 overlap saves at most the overlapping branch's duration. | Medium: preserve primary dense retrieval, separate caller-term keyword evidence, fusion, and reranker context. Neither reference proves quality for Satori's caller terms. | `L` plus `Q` with a fixed `--alt-terms-file`. Count embedding and dense calls per request. Stop if MRR falls or caller-term evidence disappears. Measure cold, warm, and concurrent-index cases. |
| 10 | Bound lexical amplification and charge retained bytes. Owners: projections, pipeline queues, and resource planning. | The checked 1,031-character identifier produces **531,177 lexical bytes** against **3,225 dense bytes**. Bounding this removes a demonstrated **164.7×** amplification case. LibreOffice savings are unmeasured. | Medium: prefix matching and backend contracts. Preserve useful identifier lookup while eliminating terms the backend cannot index. | Replay the small projection fixture, then `B` and `Q`. Measure actual queued text, vectors, and metadata. Stop if queue accounting can still understate an admitted batch or required keyword matches change. |
| 11 | Use binary vectors or direct Arrow batches after profiling. Owners: Potion protocol, `embedChunkBatch`, and `vectordb/lancedb-vectordb.ts`. | The 547,349 × 256 float32 matrix is **534.5 MiB**. Decimal JSON and JS arrays add conversion and copies. **55.1 s** is the r9 write-duration ceiling, which also includes native work and I/O. A specific saving is not defensible yet. | Medium: IPC framing, validation, cancellation, and adapter types. Semble proves compact arrays. It does not prove a JS/Rust conversion saving. | `B` after a replay profile attributes time to serialization or row conversion. Compare vector values, stored fields, and errors. Stop if conversion was not material or transferred buffers outlive their owner. |
| 12 | Replace payload storage or upgrade Lance. Owners: vector adapter, package versions, and storage contracts. | Prototype: about **9 s** index saving, dense **162 → 118 ms**, keyword **5.7 → 96.9 ms**. Lance 0.40 has no measured benefit here. | High for replacement, lower but unmeasured for upgrade. Existing data does not make payload storage the first target. | Replay the same rows and queries, then `B` and `Q` if the result justifies integration. Stop on slower required queries without an accepted tradeoff, changed atomic behavior, or negligible critical-path gain. |

Lower-priority experiments: parser/source-map allocation, nonoverlapping chunk coverage, and path-specific XML admission.
The ASCII source-map witness can support a safe identity conversion, but its wall cost is not measured.
Removing XML changes corpus coverage. The existing quality cases do not establish XML usefulness on LibreOffice.
Do not claim a like-for-like 200 s result after silently changing the admitted file manifest.

## Target architecture under consideration

Keep TypeScript for MCP, policy composition, leases, and publication coordination.
Use a native build owner for shared source extraction and global-registry call resolution.
Keep only bounded source, parse, evidence, embedding, and storage batches resident.
Spill records to private generation files before corpus-sized JS graphs form.

Candidate artifact layout:

- Private scan manifest with content hashes, stat identities, policy identity, and change-observation witness.
- Compact extraction spool, with symbol and call identifiers instead of retained raw strings.
- Paged graph database with file, symbol, call, reference, and reverse-dependency indexes.
- Dense vectors stored in contiguous float32 blocks. 547,349 by 256 float32 values require about 534.5 MiB on disk.
- Keyword postings built once through a bounded-memory builder.
- One sealed generation manifest binds all artifacts. Publication changes one durable pointer after every worker and writer settles.

Near-term: keep Lance payload storage while measuring navigation changes.
Strict support for 2 GiB needs an external-memory lexical build as well. The measured Lance FTS peak is not such a guarantee.
A final flat-vector plus SQLite design is possible, but must address the measured slower keyword query. It is not justified by the 9 s write saving alone.

Do not claim this architecture reaches 200 s without a full uncapped run and complete C++ calls.
The revised cbm baseline makes that claim harder, not established.

### Process and thread model

1. A small MCP process owns requests, leases, the active-generation pointer, and a bounded change journal.
2. One supervised indexing process owns the private generation. Its lifetime contains every parser, embedding request, writer, and resolver.
3. Native extraction workers consume a largest-first queue. Each worker opens and hashes one source observation, parses it, and emits chunks, symbols, and call evidence.
4. One shared CPU plan accounts for parser workers, tokenizer threads, embedding work, and storage work. Pending requests do not create extra CPU capacity.
5. After definitions become authoritative, native resolver workers process files against that immutable registry. Spill records and query paged indexes when the budget requires them.
6. One bounded writer persists contributions. A short-lived finalizer builds keyword readiness after large evidence owners release memory, unless measured headroom permits overlap.

TypeScript can remain the coordinator. Node itself is not a demonstrated speed ceiling.
The smallest substantial native move is C++ extraction and cross-file resolution, with compact output.
Potion already runs natively. Moving MCP request handling to native code has no demonstrated benefit.

### Artifact ownership and publication

| Artifact | Authoritative owner | Resident versus disk |
|---|---|---|
| Resolved policy and scan observation | Source-observation/index policy owner | One compact manifest, not repeated independent walks. Retain file identities and policy witnesses. |
| Source text and syntax tree | Per-file extraction job | A bounded number resident. Spill source needed later, rather than retaining the full language in JS. |
| Definitions, references, call facts, resolution claims | Native navigation owner | Private paged graph tables plus append-only extraction spool. Keep a bounded page cache. |
| Chunks and dense vectors | Payload storage owner | Private generation storage, byte-bounded batches, stable row identities. No complete JS vector matrix. |
| BM25 postings | Keyword storage owner | One bulk build with bounded working memory. Preserve caller-term retrieval and declared match modes. |
| Current publication | Existing publication coordinator/store | One durable pointer to the sealed graph and payload artifacts. Readers hold generation leases. |
| Edit invalidation | Navigation owner plus source-observation ports | Persist reverse dependencies. Update changed contributions and the necessary semantic dependents. |

Keep the existing publication protocol: finish and join work, seal artifacts, sync data and directories, then durably replace the pointer.
Do not activate vectors before graph readiness. A failed candidate never becomes current.
Cancellation joins all writers and workers before candidate cleanup and lease release.

For incremental sync, start from the current immutable generation under a read lease.
Write a private candidate with changed contributions and tombstones. Reuse unchanged artifacts only under their identity witnesses.
Measure database copying separately. A full SQLite copy per edit can erase incremental gains.
If that copy becomes the owner of latency, evaluate immutable delta segments or page-level copy-on-write then.
Do not add that complexity before the measurement.

### Storage decision and the 2 GiB floor

The first measured implementation path keeps Lance vectors and BM25 and replaces navigation's object graph and small files.
It avoids a payload migration for the already-measured 9 s saving.

The full low-memory target requires a bounded keyword builder too.
Test positions first. If Lance still cannot build within the smallest budget, a native SQLite FTS5 store is the supported alternative to measure.
That alternative can share paged storage with navigation and contiguous float32 vector blocks.
Its measured keyword penalty remains a real cost. It must enter the latency and quality comparison.

On a 2 GiB host, run fewer parsers, one model instance, small byte queues, and a small page cache. Large artifacts stay on disk.
The 200 s acceptance target applies to the stated 6 GiB test, not every CPU and RAM configuration.
On large hosts, add workers only until CPU or storage throughput stops improving. Do not allocate a corpus-sized JS heap merely because RAM exists.
At every size, reserve memory for the MCP process, query workers, native live allocations, and cgroup-charged file cache.

### A 200 s acceptance budget, not a forecast

| Nonoverlapping interval | Budget |
|---|---:|
| Discovery, policy, and source-observation setup | 10 s |
| Shared extraction, chunking, embeddings, and payload writes | 120 s |
| Resolution tail after definitions, including graph writes | 30 s |
| Keyword finalization, graph sealing, and durability | 30 s |
| Final source reconciliation and pointer activation | 10 s |
| Total | 200 s |

This allocation states what experiments must establish. Current measurements do not establish the 120 s or 30 s native intervals.
The 236 s cbm run already exceeds the total target. Integrating its current path unchanged cannot prove the goal.
Keep a per-phase rejection rule: if the measured critical path cannot fit this budget, revise the architecture or the target assessment.

### Reference comparison

| Reference | Copy | Do not copy blindly |
|---|---|---|
| Semble | Simple discovery, cached native parsers, compact arrays, content-embedding ablation, and bulk persistence. | Complete in-memory chunk/vector accumulation, mtime-only reuse, narrower defaults, or direct multi-file saves as an atomic publication design. Its supplied RSS is already about 5.96 GiB. |
| Cbm | Shared native workers, largest-first jobs, one registry, per-file parallel resolution, source retention limits, spill under memory pressure, and private staged publication. | The whole feature set, all graph semantics, custom SQLite page generation, or the assumption that native code makes the result fit 200 s. Preserve Satori's proof and consumer contracts. |

Relevant source:

- [Semble creation pipeline](https://github.com/MinishLab/semble/blob/8ee6463efbb1ff755c339e965c7298b7afd7db5b/src/semble/index/create.py).
- [Semble dense embeddings](https://github.com/MinishLab/semble/blob/8ee6463efbb1ff755c339e965c7298b7afd7db5b/src/semble/index/dense.py).
- [Semble chunking](https://github.com/MinishLab/semble/blob/8ee6463efbb1ff755c339e965c7298b7afd7db5b/src/semble/chunking/core.py).
- [Semble persistence](https://github.com/MinishLab/semble/blob/8ee6463efbb1ff755c339e965c7298b7afd7db5b/src/semble/index/index.py).
- [Cbm parallel extraction and spill](https://github.com/DeusData/codebase-memory-mcp/blob/11b662f9f7fba92012b872dd4fcaef7ee0c1300d/src/pipeline/pass_parallel.c).
- [Cbm pipeline and publication](https://github.com/DeusData/codebase-memory-mcp/blob/11b662f9f7fba92012b872dd4fcaef7ee0c1300d/src/pipeline/pipeline.c).
- [Cbm bulk graph storage](https://github.com/DeusData/codebase-memory-mcp/blob/11b662f9f7fba92012b872dd4fcaef7ee0c1300d/src/graph_buffer/graph_buffer.c).

## Order of work

1. Preserve D7 and finish the four repairs Hamza owns. Rebuild dist before claiming a new performance baseline.
2. Resolve the two reproduced publication/evidence defects. Check current D8 test compatibility. These remain proposals in this review.
3. Spill corpus-sized evidence first. This is the largest direct next memory repair after the existing arena limit.
4. Split missing time into policy, scan validation, ownership, serialization, and durability spans. Measure worker execution separately from waiting.
5. Apply small independent reductions: compiled extension policy, set membership, reused registry indexes, and the positional-FTS trial.
6. Compare paged navigation or packed contributions against the 140 s shard stage. Keep the payload adapter fixed for that experiment.
7. Restore complete C++ calls with per-file native extraction and shared-registry resolution. Check cross-file cases and admitted proof semantics.
8. Measure embedding tokenization, batching, and shared CPU use. Then ablate dense text, with fresh-index quality results.
9. Measure full-corpus queries and one-file edit sync. Change query arms or storage only when those profiles justify them.
10. Run the complete acceptance check: same uncapped file set, complete intended navigation, MRR at least baseline, cancellation/crash checks, and median wall at most 200 s within 6 GiB.

Steps are experiments, not permission to implement. Stop each when its stated outcome passes or its mechanism is disproved.

## Work to remove or avoid

Remove redundant work after equivalent checks:

- Repeated extension normalization per file and array membership scans per source.
- Registry instance-map reconstruction when the registry already owns the index.
- Per-shard recursive directory creation under an already-created owned staging directory.
- Duplicate tokenization by returning counts from the same native tokenization used for vectors.
- A second chunk-span traversal when a single streaming pass can count and emit the same chunks.
- Corpus-wide JS evidence residency after private contributions persist.
- C++ session aggregation and duplicate project parsing when shared per-file extraction supplies both search and navigation.

Delete only after an ablation or consumer check:

- Token positions without a phrase-query contract.
- Overlong or unused lexical prefix aliases.
- Dense `symbol-terms`, the `content:<length>` marker, or other header fields without quality benefit.
- Duplicate body coverage from enclosing and nested symbols.
- Data XML only when explicit coverage and representative queries support the admission change.
- The extra dense pass for `alt_terms`, while preserving its keyword/fusion and reranker input.

Keep raw call-argument evidence, final race checks, graph proof admission, cancellation joins, and publication durability.
Do not replace those requirements with cheaper behavior under a performance label.

## Measurement commands and acceptance

`B` means the full probe below, with one changed mechanism and a fresh output directory.
`Q` means both quality commands. `L` means the latency probe.
Build the specific variant first, sequentially:

```bash
pnpm --filter @satori-code/core build
pnpm --filter @satori-code/mcp build:runtime
```

Existing full probe, for a fresh built variant:

```bash
systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 \
  env MALLOC_ARENA_MAX=2 SATORI_PERF_TRACE=1 \
  node scripts/perf/index-probe.mjs "$LO" --log "$OUT/index.log" --cpu-prof "$OUT/cpu"
```

The probe writes isolated state. It can silently choose reranker `none` when model assets are missing.
Reject that configuration for requirement acceptance. Check dense, BM25, reranker, and full graph coverage explicitly.
Measure the cgroup and full process tree. CLI RSS alone misses the cbm daemon.
Use at least three runs of each accepted variant, on the same frozen corpus and CPU conditions.

Quality checks require separate fresh state roots after embedding or chunk changes:

```bash
node evals/real-repo-quality/run.mjs --state-root "$OUT/quality-state" --out "$OUT/quality"
node evals/real-repo-quality/run.mjs \
  --cases evals/real-repo-quality/conceptual-cases.json \
  --state-root "$OUT/conceptual-state" --out "$OUT/conceptual"
```

Keep the caller-term fixture fixed through `--alt-terms-file` when comparing `alt_terms` behavior.
Do not use `--reuse-index` after a projection or chunking change.
Check per-case losses, dense and fused recall, final MRR, and cold/warm latency.

Existing latency probe:

```bash
node scripts/satori-live-latency-benchmark.mjs --repo "$LO" \
  --mode diagnostic --samples 20 --skip-sync --output-dir "$OUT/latency"
```

The probe's fixed workloads need inspection before treating them as a representative LibreOffice query set.
No full index or quality run was executed during this review.

## Implementation-plan review and revisions

Hamza also requested review and revision of the
[200 s implementation plan](libreoffice-200s-implementation-plan-2026-10-20.md).
The revision changes documentation only. It does not authorize or implement a new runtime or database.

- Quality: the original plan allowed a 0.01 MRR loss. The hard requirement allows none. The gate now requires baseline MRR or better.
- Memory: Task 7 depended on Task 8 admission but ran before it. Spill now precedes source retention and parallel registries.
- Runtime: the plan selected WASM before measuring extraction, transport, and registry copies. Task 7a now compares WASM with a native C++ process before integration.
- Parsing: the original Task 6 called source caching "parse once." The structural adapter parses at `tree-sitter-adapter.ts:1559`. C++ semantics parses again at `satori_semantic.c:2693`.
- Reference evidence: cbm's own `pass_parallel.c:1242-1248` explicitly permits resolver reparsing. Bounded source retention proves read reuse, not universal parse reuse.
- Freshness: an old stat signature and hash cannot prove absence of later edits or new files. Task 5 retains validation without a current, complete witness.
- Durability: one SQLite transaction does not establish one required `fsync`. Task 9 now requires a journal, sealing, directory-sync, and pointer-publication contract.
- Incremental cost: the plan omitted database-copy cost and cross-file invalidation. Task 9b adds edit/full-index comparisons and old-reader leases.
- Low memory: watcher state and live FTS construction remain separate limits after spill. Task 8b now measures them before claiming 2 GiB support.
- Measurement: r4 and r9 have different workloads. Their scan-plus-payload difference is 132 s, not an established 90 s regression. Cbm's diagnostic File nodes are no longer counted as source files.
- Harness: r9's driver can catch failure and exit zero. Acceptance now checks the publication, required artifacts, and publication timestamp.

Recommended difference from the original approach: fix retained corpus state first.
Then use a C++ prototype to choose the extraction and resolution runtime.
Keep the payload-store migration conditional on the measured low-memory keyword-build result.
The 200 s budget remains an acceptance target, not a performance prediction.

## Coverage check and evidence limits

Jevify checked all six requested report deliverables through `jev-1.13.0`.
The call used 12,402 input tokens and returned 91 output tokens in 0.659 s.
Coverage scores ranged from 2.92 to 2.99 on a 0-to-3 scale.
Those judgments check documentation coverage. They do not prove runtime correctness or projected speed.
The revised implementation plan received seven further coverage checks: 10,164 input tokens, 107 output tokens, and 0.670 s.
Those scores ranged from 2.80 to 2.97. The reviewer also checked the underlying constraints directly.
The existing key loads through interactive `.bashrc`. Its value was neither printed nor written.

Direct evidence consists of source reads, retained artifact queries, the failing existing focused test, and deterministic temporary checks.
No full index, quality benchmark, runtime rewrite, or product repair ran during this review.
The 200 s target, net memory savings, exact source-string retainer, and full-corpus query latency remain unmeasured.

Brief reflection: the stale code graph and abbreviated artifact path caused avoidable repeated discovery.
Record exact commits, verified paths, commands, and measured-versus-inferred counts before resuming.
Patch context also failed twice during documentation edits. Exact hunks succeeded without changing product files.

## Follow-up review of implemented changes

Scope: `d04572f4..207496e6`, plus the author's existing uncommitted Rust-loop notes.
Hamza requested a code review and explicitly prohibited benchmarks.
This follow-up ran two isolated correctness fixtures. It ran no benchmark, full index, build, or repository test suite.
Product files remain unchanged by this reviewer.

The diff covers 75 files, including documentation, fixtures, locks, and the shipped Potion helper.
The reviewer checked native projection dispatch, the bounded projection stream, pipeline integration, pooling, policy admission, and analysis instrumentation.
One read-only Claive worker checked publication, mutation ownership, shard staging, and source-scan changes.
Worker `f210c0a00041` used `gpt-6.1-sol` with `xhigh` reasoning and closed after its report.
Report: `/home/hamza/.local/state/claive/f210c0a00041/result.txt`.
The parent checked both findings against source and reproduced their failed invariants independently.
The code graph still dates from 6 October. Source reads supplied current evidence.

### Progress that changes the earlier recommendations

- The current plan records R1, R2, and the optional-`sourceStat` regression as repaired. The inspected code contains those repairs.
- `attachResolutionClaims` copies retained evidence and removes old claims for every rebuilt owner.
- `settleShardBatch` joins every shard writer and chooses the first rejection in input order.
- The documented `syncfs` change reduces `fsync_tree` from 123.4 s in r12 to 8.0 s in r13. A navigation database rewrite is no longer the first justified time optimization.
- The documented analysis profiles show mostly idle parser workers and a busy main thread. The old analysis-wait span did not isolate worker cost.
- Per-chunk identifier memoization, cheaper filesystem calls, fewer lease checks, and native projections target measured owners without changing stored projection versions.
- The controlled native-projection comparison uses three interleaved runs per variant. Critical-path medians are 375.1 s reference and 337.0 s native.
- Payload medians are 244.3 s and 211.3 s. Reported anonymous peaks are 4,311-4,352 MiB reference and 4,381-4,408 MiB native.
- Artifact equality is recorded for the compared pairs. No fresh performance or quality measurement was performed by this reviewer.
- Native projections remain opt-in. The current source does not replace the C++ semantic provider's whole-session design. The complete 200 s graph-and-search goal remains open.

These facts come from the implementation, the current plan, and
[the performance findings](libreoffice-performance-findings-2026-10-20.md) and
[Rust acceleration loop](rust-acceleration-loop-2026-10-20.md).
The current plan also records Hamza's revised 0.01 MRR tolerance and deferred follow-up gates.
This review records those decisions without rewriting them.

### R5: recovery can assign a stale receipt to another root

Priority: P1. Checked owners:
`generation/publication-store.ts:442`, `:542`, and
`packages/mcp/src/core/vector-backend-maintenance.ts:352`.

Trigger: root A retains a candidate receipt after publication. Its path later becomes a symlink to root B.
A newer mutation holds B's lease. Receipt enumeration still returns A's receipt.
Recovery canonicalizes the stored root again, which selects that receipt as B's candidate.
The publication-reference check searches B's publications, so A's current collection has no protection there.
The subsequent deletion branch can drop A's collection while holding B's lease.

The moved-root repair skips A in current-publication enumeration but does not exclude its candidate receipt.
The new moved-root tests contain no candidate receipts.

Independent fixture output:

```json
{"probe":"moved-receipt","activeRoot":"B","generation":2,"receiptGeneration":1,"eligibleReceipts":1,"publishedCollectionUnprotected":true}
```

The fixture uses the real PublicationStore and RootMutationRuntime with private temporary state.
It reserves A's receipt, writes A's current descriptor, replaces A with a symlink to B, and evaluates recovery's guards under B's newer lease.
The assertion expects zero eligible receipts. It fails with one.
No vector backend was opened and no actual collection was deleted. Deletion eligibility was reproduced, and the deletion branch was traced in source.

Proposed repair: at the destructive recovery boundary, compare the stored canonical root directly with the active canonical root.
Do not grant authority by resolving an old stored name to a new root.
Preserve A's receipt and descriptor. Keep the publication-root-key validation.
An enumeration-time check alone can race another directory replacement before recovery.

Focused test recipe: extend the moved-root fixture with a receipt for A's current collection.
Run recovery under B's generation-2 lease with a recording backend.
Assert zero backend deletions and unchanged A descriptor and receipt bytes.

### R6: the directory-check fast path probes outside the root

Priority: P1. Checked owners:
`sync/sync-scan.ts:350`, `:361`, `:452`, and `config/index-policy.ts:171`.

Trigger: the scan reads a regular extensionless script through a verified directory descriptor.
After `lstatSync`, another writer moves that directory and replaces its old pathname with an outside symlink.
The new fast path constructs `fileReal` from the old pathname and sends it to the policy probe.
That probe opens and reads the pathname without a containment check.
The directory check runs afterward. It rejects the observation after outside bytes were already read.

Independent fixture output:

```json
{"probe":"scan-containment","moved":true,"outsideReads":2,"partialScan":true,"previousHashPreserved":true}
```

The fixture moves the directory deterministically inside an `lstatSync` hook.
An `fs.readSync` hook records the descriptor target through `/proc/self/fd`.
The assertion expects zero outside reads. It fails with two.
The existing directory-move test uses `.ts` files and deliberately avoids policy probes, so it misses this path.

Proposed repair: feed policy admission a root-checked file descriptor through the observation-based policy port.
Retain the final directory-identity check. A check after the read cannot enforce source containment.

Focused test recipe: use an extensionless shebang script in the existing directory-move test.
Replace its directory with an outside symlink after metadata inspection.
Assert zero outside reads, partial-scan reporting, and preserved previous evidence.

### R5/R6 repair and verification update from Hamza

Status: committed on `exp/napi-projections`: R5 `1bda2f2e`, R6 `63d7e2df`.

- R5 recovery now requires `receipt.canonicalRoot` to equal the active canonical root exactly. It does not resolve the stored name again.
- Its new A-to-B symlink test asserts zero backend calls and zero cleared receipts.
- R6 policy probing uses the verified directory descriptor through `openRegularFileAtDirectoryDescriptorSync` in `root-bound-fs.ts`.
- The helper uses `O_NOFOLLOW` and checks device and inode identity. A symlink swap or changed identity marks the file unreadable and preserves its previous hash.
- Its extensionless-script regression test asserts zero outside reads, a partial scan, and the preserved hash.

Hamza reports focused checks passing: sync-scan 19, root-bound-fs 18, and vector-backend-maintenance 3.
Core and MCP typecheck and changed-file ESLint also pass. Full suites were not run.
Restoring the old R5 filter makes its test attempt deletion of A's collection.
For R6, either the descriptor read or the identity check independently blocks outside reads. Removing both restores the two-read failure.
This update records the author's checks. The reviewer did not rerun them.
R6 adds one `fstat` per probed file. Its full-run timing effect is unmeasured.

### B1 decision and next architecture direction

Commit `a2176eff` records B1 and D results. B1 is dropped and uncommitted.
Pair 2 critical paths are 354.6 s candidate and 357.9 s base. Pair 1 payload spans are 221.0 s and 221.1 s.
Artifacts match. The results do not establish a gain beyond the recorded approximately 10 s noise.
The saved patch stays at `napi-loop/screen-B1/candB1.patch`. No monitor or new benchmark was started by this reviewer.

The selected next direction is option 2: a bounded architecture investigation before B2 binary transport.
First map dependencies and actual overlap from the existing traces.
Current `index-generation-workflow.ts:855` already drains payload writes and finalizes the collection concurrently with navigation.
Its 22-25 s finalization span is not automatically an additional serial tail after 63-70 s of navigation.
Identify the part that actually delays publication before changing concurrency.

The design must name when definitions become authoritative, the earliest legal navigation start, and a byte-bounded handoff.
Avoid cloning complete evidence and registry maps into another worker.
Preserve the 6 GiB whole-process limit, final source validation, joined cancellation, immutable artifacts, and atomic publication.
No runtime or architecture implementation began during this decision check.

Separate safety follow-up: `buildPublicationCollectionOwnership` still resolves stored receipt roots again.
The map also feeds `dropZillizCollectionForCreate`, not only collection-limit guidance.
Review that ownership path independently before treating the alias issue as closed across every deletion route.

### Follow-up verification and checkpoint

The temporary fixture process reported two failed invariants and exited 1 as expected.
It removed all fixture directories in `finally`. The reviewer then removed the private scripts and prompt.
No stored benchmark state, model, index, database, or user worktree was deleted.

R5 and R6 are committed with focused and mutation checks reported passing.
Keep the measured acceleration loop for remaining main-thread work.
The source review found no additional supported blocker in the inspected native projection and pooling paths.
Existing tests were read, not rerun. Full failure, quality, performance, and platform coverage remain limited to the recorded evidence.

## Resume checklist

1. Read Hamza's latest messages, this report, and the revised implementation plan.
2. Check current Git status and HEAD. Preserve all concurrent edits.
3. R1-R3 have repairs. R5/R6 are committed with focused and mutation checks reported passing. R4 remains a separate finding.
4. Recheck the D8/provider-failure test only when its source or fixture changes.
5. B1 is dropped. Start option 2 with an existing-trace overlap and dependency map. Preserve the separate Zilliz ownership follow-up.
6. Use the commands and stopping conditions above. Keep one changed mechanism per measurement.

Temporary reproduction detail is preserved in R1-R4 above.
The review removed its temporary fixture scripts and coverage response files after recording the results.
Never remove the author's benchmark state or cbm database without his explicit deletion instruction.
