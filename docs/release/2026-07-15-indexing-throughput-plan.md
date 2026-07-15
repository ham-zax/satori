# Satori indexing-throughput investigation

Status: provider batching, the sequential row-and-byte-bounded Milvus write
path, and single-owner staged-collection preparation are accepted
operationally. Generation `2822` proved the selected 117-row/4-MiB policy;
generation `2823` proved that 126 rows removes requests without improving wall
time; generation `2824` removed the redundant staged create/drop/create cycle
with zero retries and complete authority. The one-shot prepared-collection
receipt is implemented and repository-validated, and reduced accepted-to-
scanning latency from 43.415 seconds to 2.141-3.390 seconds in live runs.
It is not yet accepted operationally: generations `2826` and `2827` both
exhausted fresh-client recovery on their first Zilliz write at 117 and 100 rows
respectively. Both candidates were cleaned and the previous proven generation
remained authoritative. A terminal live rebuild and its downstream no-change
and quality gates remain pending current-backend write stability. Live
discovery checks remain authority and transport smoke evidence rather than a
semantic answer-quality benchmark.

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
  recovery, and use independently enforced 117-row and 4-MiB request ceilings.
  Environment overrides are bounded and intended for controlled experiments;
  they do not assert that larger requests are provider-safe.
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

## Aggressive sequential write-limit search

The follow-up used deterministic row-and-byte packing while preserving stable
input order, sequential stable-ID upserts, fresh-client recovery, deferred
index creation, staged publication, and every authority/freshness fence. No
concurrent write experiment was mixed into the search. The decision rule was
fixed before the final comparison: a candidate had to complete with zero
retries, and settings within 5% end-to-end performance would prefer the smaller
payload because the provider had already demonstrated a sharp failure cliff.

All live candidates used VoyageAI `voyage-code-3` at 1,024 dimensions,
Milvus/Zilliz `hybrid_v3`, and `@zilliz/milvus2-sdk-node@2.6.17`. The final two
runs used the identical 400-file/8,831-chunk corpus and 1,804,076 provider
tokens. Their tested runtime artifacts are immutable under these SHA-256
identities:

- source base HEAD: `e0a0cecc0cbe9b25c283464cfa04a6c7c3a4740f`;
- source base tree: `be7ff2ec650ce4eb148122e5c034109e073c0677`;
- Core Milvus runtime:
  `085937af159f48acec29ff6ef8e35cdfaaeab4e7079c6fc2ec2b9e35ec4eebb1`;
- Core context runtime:
  `88abff1a1a97ec12df535450dcbd0e0ffce3c8656acd35f33b7277f1242e6f67`;
- MCP entry runtime:
  `b8e2b0e549838ecc6bc39d2a50fbefb2f5d5380fd374991e564af2f8a6eafa95`.

The row limit was supplied explicitly to each fresh runtime, so the later
source-default change does not alter the tested artifact or candidate identity.

| Candidate | Operation / generation | Result | Direct evidence | Disposition |
| --- | --- | --- | --- | --- |
| 100 rows, original row-only policy | `19044432-b39b-4ac8-b839-15958c69fd04` / `2801` | Completed, zero retries | 98 writes, 491.873s provider-write time, 654.046s total | Prior accepted control; corpus differs slightly from the final pair. |
| 1,000 rows / 8 MiB | `076981c3-7f12-4f60-b72d-7193571230db` / `2818` | Failed near 37% | A 598-chunk logical write exhausted fresh-client recovery. Exact failed request size was not yet logged. | Safety rejection; staged collection cleaned. |
| 1,000 rows / 4 MiB | `2d241e9e-1b1d-440e-b889-17bbcba6d64c` / `2819` | Failed | 170 rows, 2,652,205 bytes, 3/3 attempts, `14 UNAVAILABLE: Connection dropped` | Safety rejection; proves 4 MiB alone does not control the failure. |
| 135 rows / 4 MiB | `42c27523-4925-4620-ada4-255534ddaf8b` / `2820` | Failed | 135 rows, 2,104,562 bytes, 3/3 attempts, same transport error | Safety rejection; staged collection cleaned. |
| 117 rows / 4 MiB | `9537786a-35f9-4d11-aa08-bb8c27f837c8` / `2822` | Completed, zero retries | 89 writes, 72.705s provider-write time, 227.933s total, authority `ok` | Accepted operating point. |
| 126 rows / 4 MiB | `e796bc4f-f435-4b7e-b16f-0c1867e3d2de` / `2823` | Completed, zero retries | 77 writes, 72.396s provider-write time, 227.994s total, authority `ok` | Economic rejection: no end-to-end gain and less failure margin. |

The failed staged generations were removed, and the previous proven collection
remained authoritative throughout. Generation `2821` was a successful
four-file incremental sync after the 135-row failure; it was not a cold-rebuild
candidate.

### Same-corpus 117-versus-126 comparison

| Metric | 117 rows | 126 rows | 126 minus 117 |
| --- | ---: | ---: | ---: |
| Total wall time | 227.933s | 227.994s | +0.061s (+0.03%) |
| Prepare collection | 41.550s | 41.825s | +0.275s |
| Payload pipeline | 177.185s | 178.586s | +1.401s |
| Voyage provider time | 99.852s | 101.505s | +1.653s |
| Vector provider time | 72.705s | 72.396s | -0.309s (-0.43%) |
| Finalize collection | 7.766s | 6.144s | -1.622s |
| Provider writes | 89 | 77 | -12 |
| Theoretical minimum writes | 76 | 71 | -5 |
| Fragmentation overhead | 13 | 6 | -7 |
| p95 request rows | 117 | 126 | +9 |
| p95 request bytes | 1,828,298 | 1,979,257 | +150,959 |
| Maximum request bytes | 1,848,749 | 1,984,514 | +135,765 |
| Retries | 0 | 0 | 0 |

The 126-row setting removes 12 provider calls but saves only 309ms of provider
write time and is 61ms slower end to end. That directly disproves the idea that
request count is still the dominant limiter in this range. Because 135 rows
reliably failed, 117 rows is the smaller equally fast setting and therefore the
accepted default. The 4-MiB byte ceiling remains as deterministic protection
against future payload-size drift even though no accepted request approached
it in this corpus.

Generation `2822` is 65.1% faster than generation `2801` end to end and its
provider-write time is 85.2% lower. That comparison is operational rather than
a same-tree causal A/B because the corpus and instrumentation evolved. The
117-versus-126 comparison above is the controlled same-corpus decision.

### Single-owner collection-preparation result

Generation `2824` tested removal of the background worker's redundant staged
collection preparation. `Context.indexCodebase()` remains the sole mandatory
full-rebuild preparation owner; the synchronous collection-limit probe remains
unchanged. This preserves immediate limit diagnostics while removing only the
fresh collection that the full-index owner immediately deleted and recreated.

| Metric | Generation 2822 | Generation 2824 | Delta |
| --- | ---: | ---: | ---: |
| Context cold-rebuild wall time | 227.933s | 186.065s | -41.868s (-18.37%) |
| Prepare collection | 41.550s | 0.401s | -41.149s (-99.03%) |
| Payload pipeline | 177.185s | 176.210s | -0.975s |
| Voyage provider time | 99.852s | 100.227s | +0.375s |
| Vector provider time | 72.705s | 70.992s | -1.713s |
| Finalize collection | 7.766s | 7.828s | +0.062s |
| Provider writes | 89 | 88 | -1 |
| Voyage retries | 0 | 0 | 0 |
| Zilliz retries | 0 | 0 | 0 |

Direct run identity and evidence:

- operation `0945b7f6-1cdf-417e-9136-ce6016807327`, generation `2824`;
- 400 files, 8,834 chunks, 1,806,461 provider tokens;
- no log event dropped the newly selected staged collection before indexing;
- final status `ok`, runtime and indexed fingerprints matched, registry evidence
  was compatible, relationship evidence was compatible, and symbol quality was
  `symbol_rich`;
- no-change sync operation `d4ad8dab-ab5f-46a7-9a37-ad595d5c8452`, generation
  `2825`, reported `added=0`, `removed=0`, and `modified=0`;
- deterministic search-quality evaluation remained at owner@1 `0.947368`,
  owner@3 `0.989474`, MRR `0.968421`, and role coverage `0.929474` with zero
  harness failures. Its repository identity was HEAD
  `08bbbd462d37a525a525760edb0bc5c102cca5d1`, tree
  `8016225616179e57c8ddfe6b5e71cade8a60de4c`, diff SHA-256
  `593582158c6c3ef20bfcfbed145116189ff254d79a1ba5aa488f6681f943084c`,
  and working-tree content SHA-256
  `c501fa24d4cfdc9905699468ed4ae80f6204810c86579f49115da75b817b175f`.

Generation `2824` contains the required implementation edits and therefore has
three more chunks than generation `2822`; it is not a byte-identical-corpus
A/B. The phase attribution is nevertheless strong: preparation fell by
41.149s while the complete run fell by 41.868s, and every other measured phase
moved by less than two seconds. The frozen acceptance gates of at least 20
seconds lower preparation time, at least 10% lower Context wall time, zero
retries, and complete final authority all passed.

## Next measured opportunities

### 1. Prepared staged-collection receipt result

The implementation now prepares the real staged collection synchronously,
returns a process-local one-shot receipt bound to canonical root, staged
collection, mutation generation, and operation ID, and requires
`Context.indexCodebase()` to consume that exact receipt before skipping its own
preparation. Weak identity prevents a caller from forging matching receipt
fields. Consumption also proves that the collection still exists. Missing,
stale, mismatched, forged, deleted, or reused receipts fail closed.

The foreground owner discards the receipt and deletes the unproven staged
collection if failure occurs before worker handoff. The background owner does
the same after handoff. This cleanup gap was found during final diff review and
is covered by the watcher-launch failure test; prior proven authority remains
unchanged.

Repository validation is green:

- focused Core receipt tests: 5/5;
- full Core suite: 423/423;
- focused MCP indexing suites: 76/76 before the final fixture audit;
- final MCP suite: 887/887;
- focused foreground-cleanup suite: 49/49;
- Core and MCP typecheck, targeted lint, runtime builds, and
  `git diff --check`: green.

The live timing benefit is established, but end-to-end acceptance is not:

| Metric | Generation 2824 baseline | Generation 2826 | Generation 2827 |
| --- | ---: | ---: | ---: |
| Effective write ceiling | 117 rows | 117 rows | 100 rows |
| Operation | `0945b7f6-1cdf-417e-9136-ce6016807327` | `e759cf18-5859-4b45-90b5-5adda9c2921d` | `e3b470d3-6dee-4036-bf38-1c86b267e646` |
| Accepted-to-scanning | 43.415s | 3.390s | 2.141s |
| Accepted-to-terminal receipt | 236.986s completed | 129.176s failed | 114.599s failed |
| First failed request | none | 117 rows / 1,821,903 bytes | 100 rows / 1,555,817 bytes |
| Fresh-client attempts | no retry | 3/3 failed | 3/3 failed |
| Candidate publication | completed | none | none |
| Staged cleanup | not applicable | completed | completed |
| Previous authority | replaced successfully | preserved | preserved |

Generation `2826` crossed the frozen latency gate by reducing accepted-to-
scanning latency by 40.025 seconds. It then failed its first Zilliz write with
`14 UNAVAILABLE: Connection dropped`. Generation `2827` was a falsification
run at the last lower-risk 100-row ceiling; it failed identically on its first
smaller write. Therefore the evidence does not isolate row size as the cause
and does not justify changing the accepted 117-row default. It does show that
the current backend condition cannot validate any candidate against the frozen
zero-retry and terminal-success gates.

No no-change sync or deterministic quality run is attributed to these failed
candidates because neither published a generation. The next action is one
default-policy live rebuild after Zilliz write stability returns, followed by
the already-frozen no-change, authority, and quality gates. Do not retry until
the backend can accept a bounded first write; repeated full rebuilds would add
cost without discriminating the implementation.

#### Managed free-cluster evidence

The July 15 Zilliz Cloud documentation and dashboard observations do not
support quota or collection pressure as the cause of the failed writes:

- the Free plan allows 5 GB of storage, 2.5 million vCUs per month, and up to
  five collections;
- the dashboard showed at most two collections during staged rebuilds, then
  returned to one after cleanup;
- the proven collection contained 8,835 entities with both vector indexes
  finished, far below the documented storage scale;
- observed server-side write latency was roughly 15-30 ms, recorded write
  failures were 0%, and write QPS was low.

These observations rule against the leading quota, collection-count, and slow
server-processing explanations. They do not prove that a response-lost upsert
committed: aggregate server dashboards do not expose the client-side gRPC
channel or establish per-request acknowledgement. The remaining interpretation
is therefore a transport/channel hypothesis, not a confirmed Zilliz backend
defect.

The referenced serving-cluster bulk-import sequence is specifically a Zilliz
BYOC workflow that imports prepared files from external object storage. This
repository uses an ordinary managed Free cluster and stable-primary-key SDK
upserts, so adopting that sequence would change deployment, ingestion, and
failure-recovery contracts. The Zilliz Skill, Plugin, MCP server, and AI prompts
are operator/agent interfaces around Cloud operations; they do not alter the
runtime reliability of the Node SDK write path. Neither source justifies an
implementation change here.

### 2. Re-evaluate Voyage packing with explicit token headroom

Voyage is now the largest provider phase at about 100 seconds. The current
100,000-estimated-token target produces 22 requests under the documented
120,000-token hard limit. A higher target is justified only after computing the
full-corpus actual/estimated distribution, freezing headroom for tokenizer and
corpus drift, and retaining `truncation=false`. A provider limit error must fail
or split deterministically; it may never silently truncate evidence.

### 3. Do not optimize write-boundary fragmentation in isolation

The 126-row experiment reduced fragmentation overhead from 13 requests to 6
and total writes from 89 to 77 without improving provider or wall time. That is
direct evidence that cross-embedding-batch write coalescing has little isolated
economic value on this workload. Reconsider it only as part of a separately
measured one-batch embedding/write pipeline, not as a standalone abstraction.

### 4. Keep concurrency and caching behind the sequential work

One-batch overlap could theoretically hide part of the approximately 73-second
write phase behind the approximately 100-second embedding phase, but it changes
cancellation, mutation fencing, progress, and error ownership. Broad write
concurrency is especially risky because the live service has a demonstrated
request-size failure cliff. Embedding caches remain deferred until repeated
unchanged cold rebuilds are a measured product workload and cache authority can
bind content, model, dimension, preprocessing, and generation identities.

Container-chunk removal remains a search-quality experiment, not a throughput
shortcut. The duplication is measured, but owner and supporting-evidence recall
must remain green before any evidence is removed.

## Current disposition

| Candidate change | Status | Reason |
| --- | --- | --- |
| Reliability lifecycle and fresh-client retry | Implemented and accepted | Live generation and all applicable tests passed. |
| Increase Voyage item count blindly | Rejected | Token limit, not item count alone, owns the safe boundary. |
| Token-aware 100k Voyage batching | Implemented and accepted | Generation 2801 completed with 22 requests, zero retries, and truncation disabled. |
| Exclude all docs or all evaluations | Rejected | Executable harness and product docs are useful evidence. |
| Exclude generated evaluation JSON | Implemented and accepted | Narrow ignore policy reduced indexed noise without deleting evidence files or changing quality. |
| Keep 25-row Zilliz writes permanently | Superseded | The 100-row run completed with zero retries and materially lower time. |
| Restore 100-row Zilliz writes | Rejected as explanation for current failure | Generation 2827 failed its first 100-row write identically to the 117-row failure, so the current evidence does not isolate the accepted row ceiling. |
| Remove class/container chunks | Hypothesis only | Duplication is measured; quality impact is not. |
| Write-distribution and boundary metrics | Implemented and accepted | Generations 2822 and 2823 captured complete row/byte distributions and exact flush reasons without retaining payloads. |
| 1,000 rows / 8 MiB | Rejected for safety | Generation 2818 failed near 37%; the failed staged collection was removed. |
| 1,000 rows / 4 MiB | Rejected for safety | A 170-row, 2,652,205-byte request exhausted all attempts, proving bytes alone were not controlling reliability. |
| 135 rows / 4 MiB | Rejected for safety | A 135-row, 2,104,562-byte request exhausted all attempts. |
| 117 rows / 4 MiB | Implemented; historically accepted operationally | Generation 2822 completed in 227.933s with 89 writes, zero retries, complete authority, and unchanged source checkpoint. Generation 2826 later failed its first write under a backend condition that also failed at 100 rows. |
| 126 rows / 4 MiB | Rejected economically | It completed safely but was 61ms slower end to end and only 309ms faster in provider writes, while sitting closer to the 135-row failure cliff. |
| Remove duplicate collection preparation | Implemented and accepted | Generation 2824 reduced preparation from 41.550s to 0.401s and Context wall time from 227.933s to 186.065s with zero retries, complete authority, and a zero-change sync. |
| Replace dummy limit probe with the actual staged collection | Implemented and repository-validated; live acceptance pending | The one-shot receipt reduced accepted-to-scanning latency to 2.141-3.390s and preserved cleanup/authority, but generations 2826 and 2827 both failed their first bounded Zilliz write before publication. |
| Increase Voyage target above 100k estimated tokens | Deferred measurement | Voyage is now the largest provider phase, but token headroom must be frozen before a live candidate. |
| Coalesce writes across embedding boundaries | Rejected as an isolated optimization | Removing 12 writes at 126 rows produced no material time gain. |
| Add concurrency or caches | Deferred | Sequential duplicate preparation and provider-token tuning remain smaller independent experiments. |
