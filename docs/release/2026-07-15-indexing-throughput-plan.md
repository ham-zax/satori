# Satori indexing-throughput investigation

Status: throughput implementation accepted operationally. Generation `2801`
completed authoritatively, repository validation is green, and a frozen paired
hermetic comparison now proves unchanged search-quality results. The live
discovery checks remain authority and transport smoke evidence rather than a
semantic answer-quality benchmark. Further vector-write tuning is a separate
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
quality or the now-proven ingestion reliability. As observed on July 15, 2026,
the available Voyage quota exceeded 100 million tokens and was not a binding
constraint for these runs. That account observation is not a durable design
assumption. Provider calls still matter because they consume latency and
rate-limit capacity.

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

Voyage documentation retrieved on July 15, 2026 states that `voyage-code-3`
accepts at most 1,000 texts and 120,000 total tokens per embedding request.
Larger batches are recommended for throughput. The embeddings endpoint
defaults `truncation` to true. The TypeScript client accepts per-request
`timeoutInSeconds` and `maxRetries`.

The tested runtime used `voyageai@0.3.1`, `voyage-code-3`, document input, and
1,024 output dimensions. Its generated type comments still describe an old
128-item limit, while its runtime serializer does not enforce that old limit.
This documentation mismatch is why larger batches were tested against the live
service before being proposed. The Zilliz path used
`@zilliz/milvus2-sdk-node@2.6.17` over gRPC.

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

Generation `2801` completed 72.2% faster end to end on its final accepted
corpus. This is not an isolated same-tree batching A/B: the run combines
batching, narrow artifact exclusion, instrumentation, and intervening tree
changes. The phase measurements establish the new operational result and the
remaining bottleneck, but do not attribute the entire 72.2% delta to one
change.

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

Normalized generation `2801` rates, using decimal MB for the byte rate:

| Normalized metric | Generation 2801 |
| --- | ---: |
| Embedding seconds per million provider tokens | 60.364s |
| Write seconds per thousand submitted rows | 55.876s |
| Write seconds per 100 MB serialized | 391.285s |
| Total seconds per thousand chunks | 74.298s |

The current pipeline ends each logical vector write at an embedding-batch
boundary, then the Milvus adapter independently splits that logical write at
100 rows. Generation `2801` had 22 embedding requests and 98 provider writes;
a globally perfect 100-row packing of 8,803 rows would require 89 writes. The
nine-request fragmentation overhead is therefore consistent with logical-write
boundaries, but generation `2801` did not record per-attempt rows, bytes, or
flush reasons. The review instrumentation below is required to prove the exact
distribution before changing the ceiling.

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
call-graph, outline, open-symbol, bounded-read, and architecture requests all
returned successfully. Those checks prove transport, authority, and envelope
health. Their outputs were not captured with expected-owner, symbol-ID, edge,
or span assertions, so they are not claimed as semantic answer validation.

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

### Frozen paired quality comparison

The pre-throughput quality reference is the accepted structural-route artifact,
not the older 17-workload program baseline. It has the same 19 workloads, five
limits, schema, fixture manifest, and provider contract as the post-throughput
run. The candidate was rerun after commits `f361339` and `5ca9f32`; deleting
only the repository-identity object from both JSON documents produced an exact
byte comparison (`cmp` exit `0`). All 95 paired workload/limit observations,
including result IDs, ranks, roles, provider counters, response bytes, routes,
warnings, and budget checks, are identical.

| Metric | Frozen pre-throughput | Accepted throughput | Delta | Gate |
| --- | ---: | ---: | ---: | --- |
| Owner at rank 1 | 0.947368 | 0.947368 | 0 | non-regressing |
| Owner within top 3 | 0.989474 | 0.989474 | 0 | non-regressing |
| Macro reciprocal rank | 0.968421 | 0.968421 | 0 | non-regressing |
| Mean required-role coverage | 0.929474 | 0.929474 | 0 | non-regressing |
| Deterministic result mismatches | 0 | 0 | 0 | zero |

Frozen identities:

- pre-throughput artifact SHA-256:
  `a3d2dca2736aeced28f871b89685f14b5a8e7e6855927cb63075f286de27fb0c`;
- pre-throughput repository identity: HEAD
  `5d75c3728c844f45b32a0635886c7c5c39a8cd26`, index tree
  `826a106068ca977d4015c7796094064e916290d5`, unstaged diff
  `b991f481548fed03001e857c5dde08e3f51818087a8e10dabaac35ded090b065`,
  staged diff
  `7bc99f15f166bd10f8fb16e2e24479c00917f642facdb1c562c544b6b65ac7b8`,
  working content
  `c1473e0448b3388d42ee3c3aec950c5eb6e8891ae0a610ddf7e2225a6ca99d7d`;
- candidate artifact SHA-256:
  `3982964f4140f85660003098af6c56edff0d806714b7b8bba4cbf8ae96d3b9e6`;
- candidate repository identity: HEAD
  `5ca9f32b5131cd9fab046a512802eecf8faf83c5`, index tree
  `10d351aa81108bad6d7116231e115abeaa6344e8`, empty unstaged diff
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
  staged diff
  `fdfe744ef9895e54b2e7877eb286d21bdf88f96474c9863665b75e4996759b2d`,
  working content
  `b0cf556f0d9d86d4072f3f278da6907fa8033a5c041ebcc364564fcaa4763670`;
- accepted throughput HEAD tree:
  `6c3bb0f6ccb17e53ecf430bd15ae61a57207c85c`;
- task-set and fixture-manifest SHA-256:
  `7bd2f30fb2b279d5f1d220051bdec6abac9565ecf3863d6ed0d71ee8ba58b965`;
- evaluator SHA-256:
  `1ea33b7655d2112f3ff5baa90a0c64d093fcaa6517465a1b87643dc176893c6d`;
- runner SHA-256:
  `b75b5e7e5b77cdae226da398b49afbcfe5c38f989499df699d114ddf34aa3250`.

The candidate artifact was intentionally written to `/tmp` and not committed,
in accordance with the generated-artifact policy. Its hash and complete
repository identity are recorded above; the retained frozen reference remains
`docs/release/artifacts/2026-07-15-search-quality-after-structural-routes.json`.

The first broad MCP run exposed five lifecycle fixtures whose structural
embedding doubles do not inherit `Embedding`. The new policy and metrics calls
therefore threw even though those capabilities are observational. The accepted
correction uses optional capability detection for both calls. The five focused
fixtures then passed, followed by the full MCP gate. This is a compatibility
fix, not a ranking or authority change.

## Next measured throughput experiment

Do not increase the fixed Milvus row ceiling blindly. Generation `2801`
recorded total serialized bytes but not individual request sizes or boundary
reasons, and mixed dense/sparse/text rows vary materially. Maximums alone
cannot describe that distribution.

The review correction adds a bounded 4,096-attempt scalar window at the Milvus
provider boundary. Each sample contains only a monotonic sequence, row count,
serialized byte count, and one of `row_limit`, `logical_write_end`, or `retry`.
The operation summary reports min, p50, p90, p95, and max rows/bytes; flush
reason counts; the theoretical global minimum; fragmentation overhead; and
whether every attempt in the operation was captured. Source, vectors, paths,
IDs, credentials, and payloads are never retained. The production row ceiling
remains 100 until this evidence is collected.

The controlled experiment order is:

1. run an instrumented fresh-runtime 100-row cold control on the final tree;
2. capture request distribution, logical-write boundaries, maximum resident
   memory from the external harness, normalized phase rates, authority, and the
   exact paired quality artifact;
3. before running the candidate, freeze a byte ceiling from the control
   distribution and the smallest explicit provider/transport constraint; never
   exceed 200 rows;
4. run the candidate on the same source tree, provider, model, dimension,
   cluster, region, and fresh-runtime lifecycle;
5. accept only if every frozen gate below passes;
6. if two candidates whose byte or row ceilings differ by at least 25% fail,
   restore 100 rows and move to one-batch embedding/write overlap.

Frozen acceptance gates:

- zero Zilliz and Voyage retries, transport failures, or silent truncation;
- completed vector authority, matching source checkpoint, navigation seal,
  fresh-runtime `status=ok`, and no-change sync;
- exact equality for all 95 normalized hermetic workload/limit observations;
- candidate p95 request bytes at or below the predeclared byte ceiling;
- at least 20% lower cumulative vector-write duration than the same-tree
  100-row control;
- at least 10% lower total cold-rebuild wall time;
- no more than 10% higher fresh-process peak resident memory;
- no more than 10 seconds absolute regression in finalization/index-build
  duration.

A candidate is an economic failure if it is reliable but misses both latency
gates. It is a safety failure if it retries, loses authority, exceeds the byte
or memory gate, changes paired quality, or violates deterministic failure
behavior. These classifications are fixed before observing the candidate.

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
| Write-distribution and boundary metrics | Implemented; focused validation green | The review correctly identified that maxima cannot explain 98 writes or support a controlled larger-batch experiment. The instrumented cold control remains pending. |
| Larger byte-bounded Zilliz writes | Deferred with measured justification | Write time is dominant, but the instrumented 100-row control and a predeclared byte ceiling are required first. |
| Add concurrency or caches | Deferred | Sequential byte-bounded batching remains the smaller independent experiment. |
