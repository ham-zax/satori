# Satori indexing-throughput investigation

Status: throughput implementation accepted and validated. Generation `2801`
completed authoritatively; further vector-write tuning remains a separate
measured follow-up.

## Scope and invariants

This work starts from the reliability fix committed as `60b54c1`
(`fix(core): stabilize Zilliz ingestion connections`). It must preserve:

- completion-marker and vector-generation authority;
- source-freshness checkpoints;
- mutation leases and generation fencing;
- deferred index construction and load;
- stable-ID upserts;
- fresh-client recovery after retryable transport failure;
- deterministic ordering and failure behavior.

The goal is to reduce cold-rebuild wall time without trading away search
quality or the now-proven ingestion reliability. Provider tokens are not a
binding cost constraint for the experiments because the current Voyage tier
has more than 100 million free tokens. Provider calls still matter because
they consume latency and rate-limit capacity.

Generated benchmark outputs must not be committed as results of this work.
The existing user-owned bounded-context doc and corpus changes remain outside
the indexing commit boundary.

## Confirmed unchanged baseline

The live rebuild that proved the reliability change completed successfully:

- operation: `9bca8120-6cc5-425b-b7ec-663e0d59d17f`;
- generation: `2799`;
- accepted: `2026-07-15T00:48:06.363Z`;
- completed: `2026-07-15T01:27:19.408Z`;
- elapsed: approximately 39 minutes 13 seconds;
- files: 405;
- chunks: 9,180;
- Zilliz transport retries or disconnects: zero observed;
- dense and sparse indexes completed after ingestion;
- collection loaded and authoritative marker published;
- source checkpoint remained unchanged;
- navigation published 4,811 symbols and 4,819 relationships.

Generation `2800` then passed a no-change sync with `+0/-0/~0`.

Repository validation for the reliability slice is green:

- Core focused tests: 170/170;
- MCP indexing tests: 49/49;
- full Core: 412/412;
- full MCP: 884/884;
- full CLI: 112/112;
- builds, lint, typecheck, and `git diff --check`: green.

## Deterministic local workload measurement

A provider-free analysis through the current `Context` file policy and
language-analysis service reproduced the live corpus exactly: 405 files and
9,180 chunks. This establishes that the following measurements describe the
same payload as generation 2799 rather than an approximate file scan.

| Category | Files | Source bytes | Chunks | Embedded chunk bytes |
| --- | ---: | ---: | ---: | ---: |
| Runtime and scripts | 236 | 2,823,979 | 5,924 | 4,231,123 |
| Tests | 113 | 2,752,878 | 2,096 | 3,092,366 |
| Docs | 37 | 1,819,284 | 843 | 2,061,084 |
| Evaluation source and data | 17 | 225,043 | 312 | 242,526 |
| Fixtures | 1 | 101 | 1 | 101 |
| Generated path | 1 | 267 | 4 | 266 |
| Total | 405 | 7,621,552 | 9,180 | 9,627,466 |

The largest chunk producers are:

| File | Source bytes | Chunks | Embedded/source ratio |
| --- | ---: | ---: | ---: |
| `packages/core/src/core/context.ts` | 287,282 | 457 | 2.12x |
| `packages/mcp/src/core/handlers.ts` | 157,183 | 318 | 2.05x |
| `packages/core/src/core/context.test.ts` | 323,725 | 226 | 1.16x |
| `packages/mcp/src/core/handlers.scope.test.ts` | 399,136 | 212 | 1.13x |
| `packages/mcp/src/core/snapshot.ts` | 82,850 | 194 | 2.09x |

The approximately 2x ratios in large class-based runtime files are direct
evidence that the current chunker embeds both container-class spans and member
spans. That is a measured duplication opportunity, but removal is not yet
accepted: container chunks may carry declaration or cross-member context and
must be evaluated against owner and supporting-evidence recall first.

## Generation 2799 baseline request shape

The baseline execution path was:

```text
Context.processFileList
-> fixed chunk-count buffer
-> Context.processChunkBuffer
-> Context.processChunkBatch
-> Embedding.embedBatch
-> MilvusVectorDatabase.insertHybrid
-> stable-ID upsert in 25-row sub-batches
```

Generation `2799` constants and behavior:

- default embedding batch: 100 chunks;
- maximum environment override: 1,000 chunks;
- batch logging estimates one token per four characters but does not control
  the boundary;
- Voyage truncation is not explicitly disabled, so its API default is true;
- the Voyage SDK request timeout is not overridden;
- Zilliz write batch: 25 rows;
- one dedicated write channel;
- SDK same-channel write retries: disabled;
- application write attempts: three, using a fresh client after retryable
  transport failure;
- embeddings and Zilliz writes are sequential, not pipelined.

At 9,180 chunks this produces:

- 92 sequential Voyage requests;
- approximately 368 sequential Zilliz upserts;
- fixed Voyage-batch estimated-token distribution:
  minimum 5,253, median 19,868, p90 56,240, maximum 62,500.

## Generated evaluation output

The following checked-in files are evidence artifacts, not useful indexed
source:

- `docs/release/artifacts/*.json`;
- `evals/agent-discovery/bounded-symbol-context-phase-0.json`.

Keeping the executable evaluation harness and its task definitions indexed is
useful. Excluding only the generated JSON outputs removes:

- 452 chunks, 4.9% of the corpus;
- 278,893 estimated embedding tokens, 11.6% of the current estimated load.

These files should remain in the repository when they are release evidence.
The proposed change is a narrow repo-local indexing exclusion, not deletion.

## Voyage authority and live probes

Current Voyage documentation states that `voyage-code-3` accepts at most 1,000
texts and 120,000 total tokens per embedding request. Larger batches are
recommended for throughput. The embeddings endpoint defaults `truncation` to
true. The TypeScript client accepts per-request `timeoutInSeconds` and
`maxRetries`.

The installed `voyageai@0.3.1` generated type comments still describe an old
128-item limit. Its runtime serializer does not enforce that old limit. This
documentation mismatch is why larger batches were tested against the live
service before being proposed.

All probes used `voyage-code-3`, `inputType=document`, output dimension 1,024,
`truncation=false`, a 180-second deadline, and the current corpus after the
narrow artifact exclusion.

Single-prefix probes:

| Estimated-token target | Items | Actual tokens | Latency | Result |
| ---: | ---: | ---: | ---: | --- |
| 60,000 | 104 | 55,515 | 3,448 ms | Success |
| 80,000 | 137 | 71,585 | 4,221 ms | Success |
| 100,000 | 170 | 88,528 | 5,261 ms | Success |

Five deterministic windows from a 100,000-estimated-token packing:

| Window | Items | Estimated tokens | Actual tokens | Latency |
| ---: | ---: | ---: | ---: | ---: |
| 0/22 | 170 | 99,388 | 88,528 | 4,631 ms |
| 5/22 | 204 | 99,637 | 77,855 | 5,052 ms |
| 10/22 | 630 | 99,985 | 85,760 | 5,408 ms |
| 15/22 | 269 | 99,819 | 70,667 | 4,879 ms |
| 21/22 | 177 | 35,953 | 33,010 | 4,245 ms |

The sampled actual/estimated ratio ranged from 0.71 to 0.92. A 100,000
estimated-token target therefore has measured headroom under the 120,000-token
service limit for this corpus. `truncation=false` remains mandatory so a future
corpus or tokenizer drift fails explicitly instead of silently weakening
indexed evidence.

Packing this corpus to that target reduces projected Voyage requests from 92
to 22. At the measured 4.25-5.41 second response times, Voyage alone still does
not explain the 39-minute rebuild.

## Pre-implementation leading hypothesis

The strongest remaining latency suspect is the 25-row Zilliz split, because it
creates approximately 368 sequential upserts. This is an inference, not yet a
confirmed root cause: generation 2799 did not persist per-phase or per-request
durations.

The 25-row split and deferred-index lifecycle were introduced together for
reliability. The successful generation therefore proves the combined design,
not that 25 rows is necessary. Deferred index construction may make the old
100-row provider batch reliable again. That alternative must be tested before
adding concurrency or accepting a 39-minute rebuild as the cost of safety.

## Original implementation and experiment order

### 1. Add bounded ingestion measurements without changing behavior

Record one summary per indexing operation, with no source content or secrets:

- analysis/file-scan duration;
- chunks and embedded input bytes;
- embedding requests, items, provider-reported tokens, retries, and cumulative
  latency;
- Zilliz upsert requests, rows, serialized bytes, retries, and cumulative
  latency;
- index-build and load duration;
- navigation-build and authority-publication duration.

Counters named as provider calls must be incremented at the actual provider or
adapter boundary, not inferred from a selected mode. Logs should be bounded to
an operation summary; per-batch detail is debug-only.

### 2. Exclude only measured generated evaluation outputs

Add a repo-local indexing policy for the two patterns above. Run a normal sync
and verify that only those 452 currently measured chunks are removed. Run the
hermetic search-quality corpus before and after. Owner rank, reciprocal rank,
role coverage, and result determinism must not regress.

### 3. Test whether 100-row Zilliz writes are reliable after deferred indexing

Keep every other reliability property unchanged. Run one cold staged rebuild
with a 100-row write ceiling and the new measurements.

Accept only if:

- no transport failure or retry occurs;
- authority, source checkpoint, marker, navigation, and no-change sync pass;
- Zilliz call count falls from approximately 368 to approximately 88 after
  artifact exclusion;
- cumulative write time and total wall time improve materially.

If 100 rows fails, test 50 rows once. If both materially different sizes fail,
retain 25 and move to bounded pipelining rather than continuing to tune the
constant.

### 4. Implement provider-owned token-aware Voyage batching

The provider must own its service limits. Other embedding providers retain
their current 100-item behavior unless they declare a measured capability.

For `voyage-code-3`:

- maximum items: 1,000;
- target estimated tokens: 100,000;
- hard documented service limit: 120,000;
- truncation: false;
- request deadline: 180 seconds for indexing batches;
- stable input ordering and flattened output ordering;
- explicit validation that output count equals input count;
- an over-limit response may split deterministically and retry, but must never
  enable truncation.

Environment configuration may reduce these ceilings. It must not silently
raise them above provider-declared limits.

### 5. Run the combined cold rebuild

Compare against generation 2799:

- wall-clock duration and phase durations;
- 405/9,180 baseline adjusted only by accepted ignore rules;
- Voyage calls (projected 92 -> 22);
- Zilliz calls (projected 368 -> 88 if 100 rows is accepted);
- actual provider tokens;
- retries and errors;
- completion authority, source checkpoint, navigation manifest, and no-change
  sync;
- hermetic search-quality results and live exact, sparse, conceptual, outline,
  graph, and symbol-open checks.

Initial acceptance target: cold rebuild below 10 minutes. A result above 15
minutes requires another measured bottleneck analysis before acceptance.

### 6. Evaluate chunk duplication only after transport batching is stable

The class/member duplication is real, but deleting container chunks changes
retrieval evidence. Add corpus workloads for:

- exact class ownership;
- a method whose relevant behavior is in a later chunk;
- a conceptual query requiring class-level context across members;
- caller/callee and declaration evidence;
- lexical versus semantic disagreement.

Test the smallest policy that avoids embedding full container bodies when
member chunks already cover them while retaining the container declaration and
uncovered fields. Accept only with unchanged owner recall and supporting-role
coverage. Otherwise retain the chunks and rely on batching improvements.

### 7. Consider concurrency or embedding caches only if still measured

Bounded overlap between embedding the next batch and writing the current batch
may help if both phases remain material. It is not the first change because it
complicates cancellation, mutation fencing, error ownership, and deterministic
progress.

Embedding caches remain deferred unless repeated unchanged cold rebuilds are a
measured product workload after batching and chunk cleanup. Cache entries would
need generation-bound model, dimension, preprocessing, and content identities.

## Accepted implementation

The accepted implementation keeps provider limits at their owning boundary and
does not change authority or publication semantics:

- `EmbeddingBatchPolicy` lets a provider declare preferred and hard item/token
  ceilings without raising the generic global ceiling.
- `voyage-code-3` packs stable input order to a 1,000-item/100,000-estimated-
  token target under the documented 120,000-token hard limit.
- Voyage requests use `truncation=false`, a 180-second deadline, no hidden SDK
  retries, three observable application attempts, and deterministic binary
  splitting only after an explicit provider batch-limit failure.
- Embedding and vector adapters expose cumulative attempt-boundary counters;
  `Context` records deltas in one bounded operation summary without source,
  paths, payloads, or credentials.
- Provider counters are exact for the isolated cold rebuild used here. Because
  they are cumulative adapter snapshots, concurrent provider work in the same
  runtime would contribute to the same measurement window and must be reported
  as a benchmark caveat rather than misattributed to indexing.
- Metrics and batch policies remain optional observational capabilities.
  Structural adapters that do not inherit the base class keep the generic
  100-item policy and emit null provider metrics.
- Milvus writes remain sequential and idempotent, retain fresh-client transport
  recovery, and use the live-proven 100-row ceiling.
- `.satoriignore` excludes only the measured generated JSON evidence while
  retaining executable evaluation sources and product documentation.

## Generation 2801 cold-rebuild result

The accepted cold rebuild used operation
`19044432-b39b-4ac8-b839-15958c69fd04`, generation `2801`:

| Metric | Generation 2799 baseline | Generation 2801 | Change |
| --- | ---: | ---: | ---: |
| Total wall time | 39m 13s | 10m 54.046s | -72.2% |
| Files | 405 | 400 | -5 net; the tree evolved and 8 artifacts were excluded |
| Chunks | 9,180 | 8,803 | -377 net; isolated exclusion removed 452 chunks |
| Embedded input bytes | 9,627,466 | 8,588,815 | -10.8% net on the final tree |
| Voyage provider requests | 92 | 22 | -76.1% |
| Voyage provider tokens | not recorded | 1,796,570 | measured |
| Voyage duration | not recorded | 108.449s | measured |
| Voyage retries | 0 observed | 0 | unchanged |
| Zilliz provider writes | approximately 368 | 98 | -73.4% |
| Zilliz submitted rows | not recorded | 8,803 | measured |
| Zilliz serialized bytes | not recorded | 125,706,957 | measured |
| Zilliz write duration | not recorded | 491.873s | measured |
| Zilliz retries | 0 observed | 0 | unchanged |

Phase evidence for generation `2801`:

- prepare collection: 42.211s;
- payload pipeline: 604.392s;
- analysis inside the payload pipeline: 2.739s;
- finalize collection: 5.984s;
- navigation: 1.364s;
- publication inside `Context`: below the 1ms clock resolution;
- dense and sparse indexes completed, the collection loaded, navigation
  published 4,840 symbols and 4,827 relationships, and the durable operation
  transitioned to `completed` at `2026-07-15T02:39:15.568Z`.

The fresh-runtime status reported `status=ok`, matching runtime/indexed
fingerprints, and `symbolQuality=symbol_rich`. A fresh-runtime sync then passed
with `added=0`, `removed=0`, and `modified=0`. Live semantic, mutation, exact,
call-graph, outline, open-symbol, bounded-read, and architecture workloads all
returned successfully.

The 10-minute stretch target was missed by 54.046 seconds, but the run was
below the 15-minute diagnosis threshold. The measurements make the next owner
unambiguous: sequential Zilliz persistence consumed 75.2% of total wall time;
Voyage consumed 16.6%. Free embedding quota does not change that conclusion.

## Validation and compatibility correction

Final repository validation:

- Core: 417/417;
- MCP: 884/884;
- CLI: 112/112;
- integration: 30/30;
- lint, typecheck, version checks, and all-package build: green;
- hermetic search quality across 19 workloads: owner@1 `0.947368`, owner@3
  `0.989474`, MRR `0.968421`, role coverage `0.929474`.

The first broad MCP run exposed five lifecycle fixtures whose structural
embedding doubles do not inherit `Embedding`. The new policy and metrics calls
therefore threw even though those capabilities are observational. The accepted
correction uses optional capability detection for both calls. The five focused
fixtures then passed, followed by the full MCP gate. This is a compatibility
fix, not a ranking or authority change.

## Next measured throughput experiment

Do not increase the fixed Milvus row ceiling blindly. Generation `2801`
recorded total serialized bytes but not the maximum individual request size,
and mixed dense/sparse/text rows vary materially. The smallest justified next
experiment is:

1. add bounded `maxSubmittedRows` and `maxSubmittedBytes` attempt metrics;
2. derive the live 100-row request-size distribution without logging payloads;
3. test a deterministic row-and-byte-bounded ceiling near 200 rows while
   retaining sequential writes and fresh-client retries;
4. accept only after another cold rebuild has zero retries, complete authority,
   a no-change sync, unchanged quality, and a material wall-time reduction;
5. if two materially different larger ceilings fail, revert and test one-batch
   embedding/write overlap rather than continuing constant tuning.

Container-chunk deletion, caches, and broad concurrency remain out of this
accepted slice. Provider quota is ample, container removal has retrieval risk,
and the measured sequential write bottleneck should be exhausted first.

## Current disposition

| Candidate change | Status | Reason |
| --- | --- | --- |
| Reliability lifecycle and fresh-client retry | Implemented and accepted | Live generation and all applicable tests passed. |
| Increase Voyage item count blindly | Rejected | Token limit, not item count alone, owns the safe boundary. |
| Token-aware 100k Voyage batching | Implemented and accepted | Generation 2801 completed with 22 requests, zero retries, and truncation disabled. |
| Exclude all docs or all evaluations | Rejected | Executable harness and product docs are useful evidence. |
| Exclude generated evaluation JSON | Implemented and accepted | Narrow ignore policy reduced indexed noise without deleting evidence files or changing quality. |
| Keep 25-row Zilliz writes permanently | Superseded | The 100-row run completed with zero retries and materially lower time. |
| Restore 100-row Zilliz writes | Implemented and accepted | Generation 2801 used 98 writes with zero retries; vector persistence is now measured. |
| Remove class/container chunks | Hypothesis only | Duplication is measured; quality impact is not. |
| Larger byte-bounded Zilliz writes | Deferred with measured justification | Write time is dominant, but maximum request bytes must be observed before raising the ceiling safely. |
| Add concurrency or caches | Deferred | Sequential byte-bounded batching remains the smaller independent experiment. |
