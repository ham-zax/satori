# Satori Potion Offline Embedding Lean Qualification Plan

**Status:** L0 and L1 passed; L2 experimental provider integration passed
focused conformance; L3 functional qualification passed and its frozen resource
qualification failed; atomic delta publication and bounded generation staging
are correct; receipt-driven readiness proof reuse passed focused qualification,
but the prospective delta resource qualification still fails in other measured
publication stages; the direct paired L4 retrieval-relevance comparison is
complete and shows Potion is useful but weaker than Voyage overall, with a
specific Java gap; opt-in experimental productization is separately authorized
under Follow-up Track A0, while no production default has changed

**Date:** 2026-07-19

**Primary decision:** determine whether
`minishlab/potion-code-16M-v2` can support a useful, safe, lightweight Satori
offline-search mode.

**Current execution boundary:** the authorized receipt-driven readiness-proof
follow-up is complete. Redundant exact publication proofs are removed, but the
prospective ordinary delta and rename latency gates still fail in navigation and
graph delta work, candidate publication verification, discovery and hashing,
and remaining generation-finalization work. L4 now directly compares retrieval
relevance on the two existing publications; no agent or judge layer is part of
that decision. Follow-up Track A0 is separately authorized for opt-in
experimental installation; Track A1 and all other follow-up tracks remain
unauthorized.

---

## 1. Decision boundary

This plan answers one question:

> Can Potion, used through Satori's existing hybrid retrieval stack, provide
> practically useful offline code search on an ordinary CPU without
> unacceptable answer-quality loss?

Voyage remains the connected-quality reference. Existing Ollama configurations
remain unchanged.

Potion plus Satori's existing BM25 and exact-evidence paths remains the offline
first-stage baseline. A later second-stage scorer is optional and must not
replace or weaken that baseline.

A successful result may authorize an explicit experimental or release-candidate
`offline_lite` configuration. It does not authorize a local neural reranker, a
new freshness model, a model tournament, broad release packaging, or a
production-default change.

### 1.1 Repository boundary

The lean work follows these existing owners:

| Concern | Repository owner |
| ------- | ---------------- |
| Runtime policy | `packages/core/src/config/execution-profile.ts` |
| CLI validation | `packages/cli/src/runtime-config.ts` and `install-preflight.ts` |
| MCP configuration | `packages/mcp/src/config.ts` |
| Embedding contract and providers | `packages/core/src/embedding/` |
| Provider construction and lifecycle | `packages/mcp/src/embedding.ts` and `server/provider-runtime.ts` |
| Persisted compatibility | `packages/core/src/core/persisted-index-authority.ts` and MCP fingerprint construction |
| Local vector publication | `packages/core/src/vectordb/lancedb-vectordb.ts` |

LanceDB already accepts a configured positive vector dimension and validates
query/write dimension equality. This plan qualifies one fresh 256-dimensional
publication; it does not introduce a Potion-specific storage schema.

---

## 2. Explicitly out of scope

The following belong to
`SATORI_OFFLINE_SEARCH_PRODUCTIZATION_AND_QUALITY_FOLLOW_UP_PLAN.md`:

* local neural reranking;
* Late-interaction scoring, LateOn artifacts, multi-vector caching, and sidecar
  indexes, all of which belong to Follow-up Track C;
* a full Semble benchmark arm;
* a 90-task release benchmark;
* generic native artifact installation infrastructure;
* polished connected and air-gapped installers;
* multi-platform release qualification;
* upgrade, downgrade, uninstall, and SBOM work;
* freshness or watcher semantic changes;
* alternative embedding-model selection; and
* production-default changes.

---

## 3. Non-negotiable contracts

### 3.1 Configuration

* Preserve `SATORI_RUNTIME_PROFILE` as `connected | offline`.
* Preserve the existing `default | minimal | all-text` index profiles.
* Add Potion only as an explicit embedding-provider selection.
* Existing `offline + Ollama` configurations continue unchanged.
* Reject `offline + Voyage`.
* When a preset and an explicit provider are both supplied, require agreement
  or reject the configuration.
* Do not silently migrate an existing installation to Potion.

Presets are installer/UI conveniences, not runtime profiles or index profiles.
L2 does not add a user-facing preset.

### 3.2 Exact inference semantics

The Potion implementation must use this frozen sequence:

```text
tokenize the complete input with truncation disabled
-> remove unknown-token IDs
-> count retained tokens
-> reject above Satori's explicit retained-token limit
-> map each original token ID to its embedding row
-> multiply the row by that token ID's weight, or 1.0 when absent
-> sum the weighted rows
-> divide by retained-token count, not by total weight
-> L2 normalize when required by the pinned model configuration
```

It must:

* reject empty and all-unknown input;
* reject zero-norm and non-finite output;
* return exactly 256 finite dimensions;
* use symmetric query and document treatment with no provider-added prefixes;
* never call `encode`, `encode_single`, or
  `encode_with_args(..., Some(limit), ...)`, because those paths truncate; and
* verify the behavior with fixtures pinned to the selected model and native
  runtime revisions.

Core may deterministically split a projection before inference only when the
existing projection contract permits it. The native owner never silently
truncates.

### 3.3 Runtime ownership

Use either:

* one in-process model-loaded native owner per MCP runtime; or
* one persistent bounded worker per MCP runtime.

Do not launch and reload a command-line model for each request.

The minimal qualification contract includes:

* readiness;
* bounded batch size;
* request timeout;
* cancellation where supported;
* classified failure;
* clean shutdown; and
* no source content in logs, diagnostics, or errors.

Source text may enter native inference only through a bounded, ephemeral local
request. For worker ownership, it may appear only in that local request frame.
It is never persisted, echoed, or transmitted over a network.

For an in-process Rust integration, panics must be contained at the native
boundary. They must not unwind across FFI or terminate Satori. If that cannot be
demonstrated reliably, use an isolated worker.

Sophisticated queue scheduling, health supervision, and restart policy are not
part of lean qualification. The minimal owner must remain bounded and must not
accumulate work after a timeout or shutdown.

### 3.4 Identity and compatibility

Create a canonical Potion inference-contract manifest containing:

* model and tokenizer revisions and artifact digests;
* native runtime revision, target, features, and binary digest;
* query and document treatment;
* token filtering and input-limit behavior;
* token mapping, weighting, pooling denominator, and normalization;
* dimensions and invalid-output behavior; and
* reference-fixture digest and numerical tolerance.

Hash its canonical bytes as a lowercase SHA-256
`embeddingInferenceContractDigest`.

For Potion, carry this complete inference-contract digest through the existing
Core `artifactDigest` / persisted `embeddingArtifactDigest` authority seam. The
value represents the full Potion inference contract, not merely the model-file
checksum. A missing or changed Potion digest is incompatible and requires a
fresh publication and full reindex.

Reusing the existing field avoids a second fingerprint shape and does not
rewrite or invalidate existing Voyage, OpenAI, Gemini, or Ollama publications.

### 3.5 Offline claim

Keep two claims distinct:

* **Satori-runtime offline:** after artifacts are installed, Satori embedding,
  storage, installation telemetry, and runtime telemetry make zero network
  requests. A connected artifact fetch is not telemetry and sends no repository
  content.
* **End-to-end offline:** Satori, the MCP client, answering agent, and judge are
  all local, so repository evidence leaves neither Satori nor the client.

A qualification run using a remote answering agent or judge may prove
Satori-runtime offline behavior and answer quality under that disclosed
configuration. It must not be described as end-to-end offline.

---

## 4. Execution phases

### L0 — establish authority and native build path

1. Record a clean accepted Git revision and the configuration, embedding,
   fingerprint, publication, and LanceDB owners named in Section 1.1.
2. Select either:

   * a pinned Rust toolchain and recorded build environment; or
   * a checksummed prebuilt helper with recorded source revision, target,
     features, build manifest, and digest.

3. Pin the Potion model, tokenizer, license, files, and checksums.
4. Pin the exact `model2vec-rs` revision and record a commit permalink to the
   inference source. A mutable branch URL is not authority.
5. Record the reference hardware and the isolated evidence root.

Exit: the model and executable runtime closure are reproducible. No production
configuration or index has changed.

### L1 — native feasibility without a publication

1. Load the model once.
2. Prove the exact non-truncating inference sequence.
3. Prove the mapping, weighting, retained-count denominator, and normalization
   formula.
4. Prove empty, all-unknown, oversized, zero-norm, and non-finite rejection.
5. Prove deterministic 256-dimensional output within a frozen numerical
   tolerance.
6. Prove symmetric query and document behavior.
7. If in-process, inject a native failure and prove panic containment.
8. Measure separately:

   * complete artifact size;
   * cold load time;
   * model-related RSS;
   * batch throughput; and
   * warm per-item latency.

9. Block network access and prove zero attempted runtime requests.
10. Do not add a production provider, alter defaults, or create a LanceDB
    publication.

Exit: reject Potion immediately if inference correctness or basic CPU
feasibility fails.

#### Recorded L0/L1 result — 2026-07-18

L0 and L1 ran from clean accepted revision
`d04eac35af2addad7b68525f91b0c6dacd8b94da` in an isolated worktree. The
checksum-sealed evidence root is
`/home/hamza/repo/satori-l0-l1-evidence/20260718-d04eac35`; its manifest digest
is `adf633304ed03e0e3611fd79cecf1d12ad68dbde8beed0cbfcc749b685666381`.

Pinned authority:

* Potion model revision:
  `e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b`;
* `model2vec-rs` revision:
  `6f51c7afe2436bcb76fc467bad54eaa94f8db30d`;
* Rust `1.97.1`, target `x86_64-unknown-linux-gnu`, with
  `default-features=false`, `local-only`, and `fancy-regex`;
* helper SHA-256:
  `2e42f3165b96927bb365f74a11b0495661ac3c44e1a194c55a8f0613b5bb2e12`;
  and
* embedding inference-contract digest:
  `bfda80d97aeb585e20650b1c54e9063a65068ce284317f0e0a812e20964dcee7`.

The strict path disables the tokenizer artifact's serialized 512-token
truncation and batch padding in memory before model load. It rejects more than
`4096` retained tokens, empty/all-unknown input, zero-norm or non-finite output,
and any output other than exactly 256 dimensions. A 513-token witness retained
all 513 tokens. Frozen fixtures, a separately implemented raw pooling check,
and symmetric query/document operations matched exactly under the declared
`1e-6` maximum-absolute-difference and `0.999999` minimum-cosine tolerances.

The persistent worker loaded the model once, contained an injected panic, and
served the next request. The complete model repository plus helper measured
`37,745,961` bytes; model-related RSS was `109,379,584` bytes; model load was
`232.404` ms; the frozen short-input 64-item batch workload measured
`19,282.79` items/s; warm per-item p95 was `0.03198` ms; and 50 repetitions had
zero component variance. The load measurement used a cold process/model
instance with uncontrolled OS page cache, and the throughput workload used
short fixtures, so neither figure is production performance authority.

All authoritative fixture, conformance, worker, and benchmark runs used a
blocked network namespace and recorded zero runtime network attempts. No
Satori provider, configuration, publication, index, or user state changed.

**Decision:** L1 passed and supports L2 experimental integration only. It does
not authorize L3 or establish product quality, production performance, or
release support.

### L2 — minimal experimental provider integration

1. Add Potion behind an explicit experimental provider value.
2. Add only the configuration changes required to select it safely.
3. Add one persistent runtime owner per MCP runtime.
4. Add batching, timeout, cancellation where supported, classified errors, and
   close behavior.
5. Add the inference-contract digest and fail-closed publication compatibility
   checks.
6. Ensure Potion bypasses inherited approximate character truncation.
7. Add focused provider tests for dimensions, finite and nonzero output,
   normalization, identity, timeout, shutdown, panic containment or worker
   isolation, and invalid input.

Do not add a polished installer, user-facing preset, reranker, or new freshness
behavior. The helper may be provisioned only through the recorded experimental
path established by L0.

L2 may merge behind an experimental, undocumented-by-default provider flag,
but the manually provisioned L2 path is not an installer-supported product
configuration. Follow-up Track A0 may add the explicit experimental installer;
L4 and Track A1 govern later default or recommended promotion.

Exit: the provider passes focused Core and MCP conformance tests without a paid
service. No supported product configuration has been created.

#### Recorded L2 result — 2026-07-18

The experimental `Potion` provider is selectable only with the existing
`offline` runtime profile. It requires explicit, manually provisioned absolute
helper and model paths; verifies the pinned helper, model, tokenizer, and
configuration checksums before starting native code; and always starts the
persistent L1 worker with its network block enabled.

The Core adapter reuses the sealed L1 worker and existing embedding contracts:
one model-loaded worker per provider runtime, a bounded 32-item provider batch,
bounded request frames, a five-second default request timeout, classified and
redacted failures, output validation, worker-isolated native failure, and clean
shutdown through `ProviderRuntime`. It passes exact source text through only the
ephemeral local worker request and does not use Core's approximate character
preprocessing.

Potion's complete inference-contract digest is carried in the existing
`artifactDigest` / `embeddingArtifactDigest` authority field. Focused tests prove
that the pinned real L1 helper satisfies the Core adapter, changed or missing
contract identity fails persisted compatibility, and existing local-provider
policy and runtime shutdown behavior remain intact.

**Recorded L2 decision:** L2 passed. At that boundary no LanceDB publication,
document indexing, reranking, installer work, L3, or L4 had been performed or
authorized.

### L3 — real publication and lifecycle smoke test

1. Provision and verify the pinned artifacts through the experimental L0 path.
2. Block outbound network access before starting Potion or LanceDB.
3. While that block remains active, create the single authorized fresh
   256-dimensional LanceDB/Potion publication and perform every remaining L3
   lifecycle and search operation. Do not perform a second full index.
4. Verify fingerprint and dimension compatibility.
5. Restart and search the publication.
6. Run an explicit zero-change sync and verify receipt stability.
7. Test one add, edit, rename, and deletion.
8. Verify unchanged chunks are not unnecessarily re-embedded.
9. Test one runtime failure and recovery.
10. Run a checksum-sealed 12–18 task smoke suite covering:

   * exact identifiers;
   * paths;
   * natural-language ownership;
   * configuration ownership;
   * one cross-file relationship;
   * one freshness-sensitive query; and
   * one negative query.

11. Capture dense, lexical, and exact-evidence candidate survival separately.

Exit: proceed only if every critical smoke-task owner survives in the captured
candidate union and all publication/lifecycle checks pass. Otherwise stop and
record the first failing retrieval or lifecycle boundary.

#### Recorded L3 result

The immutable L3 decision is `functional_pass_resource_fail`. Its canonical
manifest is
`/home/hamza/repo/satori-l3-evidence/20260718-8f637bc/manifests/l3-final-decision.json`
with SHA-256
`6ecc3654ec6574f5371eac362574fd22145ed7b836bbd0704b859f7f22e4ebf8`.
The complete evidence root is
`/home/hamza/repo/satori-l3-evidence/20260718-8f637bc`.

Functional qualification passed. The single completed publication contains
488 files, 10,830 chunks, and 256-dimensional Potion vectors. Fingerprint and
dimension compatibility, restart and search, zero-change synchronization,
add/edit/rename/delete lifecycle behavior, runtime-failure recovery, and zero
Satori-runtime network attempts passed. All 12 base smoke calls returned `ok`;
all 7 critical and all 11 positive expected owners survived the captured
candidate union. Ten of the 11 positive owners reached disclosure, and the
negative task disclosed no result.

The frozen resource qualification failed and remains a failure:

* cold public publication was 34.457 seconds against 30 seconds;
* the internal indexing timer was 29.985 seconds, leaving 4.472 seconds of
  public accepted-to-completed time outside that internal timer;
* one-file incremental publication p95 was 6,517.76 ms against 1,000 ms; and
* warm public search p95 was 139.72 ms against 500 ms and passed.

The incremental result came from 10 measured edits after 2 discarded warmups,
not from only the add/edit/rename/delete lifecycle observations. The samples
ranged from 6,231.75 to 6,517.76 ms. They establish a large and consistent
resource miss, but nearest-rank p95 over 10 samples is the maximum and is
descriptive rather than a statistically stable tail estimate.

L3 also exposed a publication-fingerprint propagation defect: the persisted
Potion inference digest was lost by the vector-only runtime identity used for
public search. Commit `b651fbb2769b5592fbc3e12eadaf772eaf19a6ca`
preserves the configured digest. Focused MCP tests and the same publication's
incremental synchronization verified the repair without another full index.

No measurement, threshold, or original L3 evidence is changed by this record.
At this decision point L4 remained blocked pending an explicit decision about
the confirmed resource miss. The later execution-boundary decision recorded at
the top of this plan authorizes L4 independently without changing this result.

#### Recorded L3 resource investigation

The bounded investigation decision is `resource_miss_confirmed` (decision C).
Its canonical manifest is
`/home/hamza/repo/satori-l3-resource-evidence/20260718-b651fbb/manifests/l3-resource-investigation-decision.json`
with SHA-256
`414b00729e5ce25616867aa3b9b06c70205b0618847b421d17c645f656c616c5`.
The task-owned evidence root is
`/home/hamza/repo/satori-l3-resource-evidence/20260718-b651fbb`.

The 4.472-second cold value is an arithmetic residual, not a directly observed
post-index-only interval: it includes work before and after the Context timer.
Bounded measurements on the compatible 488-file task copy attributed 4.369
seconds (97.7%) to the same cold-path owners: synchronizer initialization
(658.68 ms), the forced full-hash checkpoint (573.78 ms), full call-graph
rebuild (2,144.01 ms comparable mean), and navigation publication (992.08 ms
comparable mean).

Four warm changed-file cases averaged 6,719.16 ms. Repository-wide navigation
rebuild averaged 2,973.06 ms (44.25%) and full call-graph rebuild averaged
2,144.01 ms (31.91%). Potion embedding itself averaged 1.90 ms as nested
attribution. Each add, edit, or rename embedded exactly two changed chunks;
deletion embedded none, zero-change synchronization embedded none, and no
incremental FTS finalization occurred. One model-loaded Potion worker was reused
within each MCP runtime; restart created one new worker for the new runtime.

No repair was made. Crossing the frozen 1,000 ms incremental gate would require
delta-safe changes to both immutable navigation publication and call-graph
sidecar ownership. Skipping either current publication step would weaken
searchable-publication correctness, while implementing both is not a bounded
repair. No additional full publication was run, and the isolated diagnostic
recorded zero network attempts. The frozen L3 resource failure and its original
gates remain unchanged.

#### Prospective delta-publication decision

This is a separate product decision for a delta-publication follow-up. It does
not modify or reinterpret the immutable L3 measurements, thresholds, or failed
resource decision.

* A one-time CPU-only publication of approximately 10,000 chunks may be
  accepted under a future 40-second cold-publication envelope; the observed
  34.457-second L3 publication is within that prospective envelope.
* The observed 139.72 ms warm-search p95 passes its existing 500 ms gate.
* Warm zero-change synchronization below one second passes.
* Ordinary changed-file publication at the observed 6.5--8.1 seconds is not
  acceptable. The prospective empirical p95 target remains 1,000 ms for an
  ordinary warm one-file add, edit, or deletion.
* Rename is measured and reported separately against a prospective 1,500 ms
  empirical p95 target.

Only a separately qualified delta-publication result may satisfy this
prospective envelope. Such a result does not convert the original L3 resource
failure into a pass and does not authorize L4 automatically.

#### Recorded delta-publication qualification stop

The bounded delta-publication qualification started from
`b651fbb2769b5592fbc3e12eadaf772eaf19a6ca` and stopped with
`shared_bottleneck_relocalized` before implementation. The existing L3 decision
seal above was verified without regenerating or modifying it.

The shared publication lifecycle, rather than Potion, is the blocking owner.
Incremental synchronization currently withdraws the completion marker and
mutates the active vector and lexical collection in place before navigation is
rebuilt. Navigation then publishes its generation pointer before the source
checkpoint and replacement completion marker are committed. The MCP call-graph
sidecar is rebuilt afterward, before the final MCP operation receipt is marked
complete. Existing focused tests confirm that a failed incremental mutation
leaves the marker and navigation authority absent so the exact mutation can be
retried; the previous generation is not left searchable.

Consequently, adding delta symbol, relationship, or call-graph artifacts alone
cannot meet the required invariant that readers see the complete previous
generation or the complete new generation and that a failed or crashed
publication leaves the previous generation searchable. The minimum next
architectural change is to extend the existing staged-generation authority to
the vector and lexical delta and bind the staged collection, navigation
generation, call-graph generation, source checkpoint, completion proof, and MCP
receipt under one publication decision. That is a broader publication-authority
change than this qualification permits.

No navigation, call-graph, vector, lexical, ranking, provider, or retrieval code
was changed. No performance qualification or representative reindex was run.
The prospective latency targets remained unqualified, and L4 was blocked at
this decision point. The later independent L4 authorization does not
reinterpret this evidence.
The task-owned decision evidence is recorded under
`/home/hamza/repo/satori-delta-publication-evidence/20260718-b651fbb`.

#### Recorded atomic delta-publication follow-up

The broader shared-publication follow-up started from
`c803bba6a29bac25beb42dd402af5e64bdc5647c`. Commit
`75c3e2ca00dec4de9234e8ea6d48b6f0f7cbc081` established one durable
activation authority for vector and lexical state, navigation, relationship
graph, source checkpoint, completion proof, and receipt. Its frozen baseline
was atomic and correct but physically copied complete LanceDB and navigation
generations. That baseline remains immutable under
`/home/hamza/repo/satori-delta-publication-evidence/20260718-75c3e2c`; its
existing decision SHA-256 is
`9dbe2da3e153475941d261274485b49f3d4aa8fd187117be4693ddb6c603dc01`.

Subsequent commits removed only the two demonstrated physical-copy owners:

* `338a5e5` shares immutable Lance generation files through same-filesystem
  hard links and independently copies the mutable 15-byte version hint;
* `c9d7365` persists versioned per-file symbol and relationship contributions,
  writes only changed or affected shards, and shares exact-hash-compatible
  shards; and
* `c99a681` batches Lance generation sharing without changing activation or
  compatibility semantics.

Both mechanisms fail closed to a safe full rebuild when the filesystem cannot
provide the required same-filesystem link behavior. Active and retained
generations have independent directory entries, cleanup remains outside the
activation path, and removing an older generation does not remove files still
owned by another generation. Milvus continues to reject unsupported atomic
candidate publication truthfully rather than claiming an unimplemented
guarantee.

Focused failure, restart, retention, missing/corrupt-metadata, reverse-resolution,
and deterministic full-rebuild-oracle tests passed. The oracle covers additions,
body and signature/export edits, deletion, rename, multi-file mutation,
resolution and ambiguity changes. The complete Core run passed 532 tests with
one skip, the focused Core run passed 244 tests, and the affected MCP run passed
158 tests. Unchanged chunks were not embedded, a single Potion worker was reused
within the measured MCP runtime, and network-blocked qualification recorded zero
runtime network attempts.

The one authorized representative run used revision
`c99a681af0f14e81eadd28d4a1e8f63bcf782408`, 488 files, 10,951 chunks,
and 256-dimensional Potion vectors. It produced these nearest-rank empirical
results:

| Operation | Samples | Median | p95 | Prospective target | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Zero change | 20 | 1,264.50 ms | 1,287.52 ms | 1,000 ms | fail |
| One-file addition | 20 | 3,201.16 ms | 3,338.09 ms | 1,000 ms | fail |
| One-file body edit | 20 | 3,290.47 ms | 3,365.13 ms | 1,000 ms | fail |
| One-file signature edit | 20 | 3,308.31 ms | 3,719.98 ms | 1,000 ms | fail |
| One-file deletion | 20 | 3,252.26 ms | 3,501.85 ms | 1,000 ms | fail |
| Rename | 10 | 3,321.77 ms | 3,395.66 ms | 1,500 ms | fail |
| Warm public search | 30 | not used as a gate | 157.04 ms | 500 ms | pass |

The cold public publication took 45.142 seconds against the prospective
40-second envelope and also failed. Its internal index timer was 39.822 seconds,
including 8.818 seconds of first-generation navigation construction. This does
not change the original 34.457-second L3 measurement or its frozen 30-second
failure, and cold optimization was outside this follow-up's priority.

The authorized physical-copy repairs worked. Lance candidate staging fell from
a 2,778.85 ms baseline median to 200.59 ms in the isolated representative-size
stage check; a changed representative generation shared 1,043--1,433 files and
copied one 15-byte file before applying changed-row mutations. Navigation and
graph staging fell from a 3,665.56 ms baseline median to 272.91 ms in its
isolated stage check. Representative changed-file generations shared
986--1,064 files and physically wrote 489,820--523,494 bytes across four to
seven changed contribution/manifest files instead of copying the complete
approximately 27.5 MB tree.

The remaining miss is no longer physical generation copying. Warm changed-file
samples spent median 1,055.19--1,072.71 ms in readiness proof plus
497.13--507.40 ms in publication verification. Zero-change synchronization
spent a 997.60 ms median in readiness proof alone. Ordinary changed-file
publication performed seven exact proof reads; rename performed eight. These
shared proof/readiness owners are now the demonstrated stopping boundary.

**Decision:** `shared_bottleneck_relocalized`. Atomic/delta correctness and
physical generation sharing pass, but the prospective cold, zero-change,
ordinary changed-file, and rename latency gates remain failed. L4 remains
blocked and is not authorized automatically. The checksum-sealed evidence root
is `/home/hamza/repo/satori-delta-publication-evidence/20260718-c99a681`;
the decision SHA-256 is
`5b12d53cbc9e653e3e3c13e33aa5bc471de89c8e5b64250393111c0eb5fe4598`,
and the checksum-manifest seal is
`7c31c5dc81cdfe57ec99b4b65d13cb12687a05028751ef9fc93a9eacf83dc082`.

#### Recorded receipt-driven readiness-proof follow-up

The readiness follow-up started from
`80045d800777c07dfc59de2d186fceb226d2c6fc`. Commit
`89c567d4a0f1c613564b1a02e617172350d043b3` implements the smallest
backend-capability-bound proof reuse:

* successful activation publishes a process-local generation receipt;
* compatible Core contexts owned by one provider runtime share a single-flight
  proof coordinator;
* warm status, search, and synchronization validate the receipt against current
  policy, navigation, and backend publication observations without an exact
  payload recount;
* a restarted compatible process performs one exact proof, while concurrent
  callers join it;
* Lance observations bind the data and control version hints to the content of
  both current manifests, so drop/recreate with the same collection name and
  version numbers cannot reuse a prior receipt; and
* backends without a safe cheap observation, including Milvus, retain their
  established receipt-bound marker and policy validation and do not receive a
  cache guarantee that they cannot prove.

There is no TTL. Policy drift, navigation changes, completion-marker loss or
replacement, same-name Lance collection replacement, missing metadata, and
restart invalidate reuse. Identity is checked again before a cached or joined
proof is returned. Activation establishes the receipt, cold validation reports
`exact`, concurrent callers report `joined`, and later cache hits report
`reused`.

The final clean-commit focused run used 24 files and 48 chunks. Across 20 warm
proofs, median latency was 5.96 ms and empirical p95 was 6.73 ms. Every sample
reported `reused` and zero exact payload recounts. A three-caller restart
performed exactly one exact recount; the other two callers reported `joined`.
The focused zero-change synchronization took 21.23 ms, and the first proof read
after activation took 11.54 ms with no exact recount. These are focused proof
and lifecycle measurements, not representative product gates.

One preserved 20-sample representative run from the intermediate receipt-reuse
implementation established that removing redundant readiness proofs was not
enough to satisfy ordinary delta latency:

| Operation | Samples | Median | p95 | Prospective target | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Zero change | 20 | 255.69 ms | 276.54 ms | 1,000 ms | pass |
| One-file addition | 20 | 2,917.60 ms | 2,970.33 ms | 1,000 ms | fail |
| One-file body edit | 20 | 3,125.01 ms | 3,515.08 ms | 1,000 ms | fail |
| One-file signature edit | 20 | 3,204.83 ms | 3,649.93 ms | 1,000 ms | fail |
| One-file deletion | 20 | 2,978.00 ms | 3,012.30 ms | 1,000 ms | fail |
| Rename | 10 | 2,717.96 ms | 3,357.59 ms | 1,500 ms | fail |
| Warm public search | 30 | 146.91 ms | 154.38 ms | 500 ms | pass |

The later bounded diagnostic used only two or three mutation samples per type,
so its p95 values are descriptive rather than qualification evidence. It
reduced ordinary operations to approximately 2.1--2.7 seconds and localized
the remaining inclusive owners to navigation and graph delta work
(approximately 0.63--0.72 seconds), candidate publication verification
(approximately 0.46--0.49 seconds), discovery and hashing (approximately
0.20--0.23 seconds), and remaining generation, finalization, checkpoint, and
snapshot work. Readiness proof itself was approximately 1.4--2.2 ms before the
final current-manifest binding; the final focused p95 with manifest binding is
6.73 ms.

No representative rerun or full reindex was purchased after the final review
corrections. The focused committed-runtime measurement showed that proof cost
remains negligible while the measured ordinary path is still more than twice
the target, so another representative qualification was not yet plausible.
The preserved representative run recorded zero runtime network attempts, and
the final focused run used only the embedded local backend.

Focused and affected verification passed 210 Core tests and 88 MCP tests, plus
Core and MCP typecheck, focused lint, Core build, MCP runtime build, and diff
checks. A broad MCP run passed 1,001 of 1,007 tests. The one readiness-affected
cached-navigation failure was repaired and passed; five failures remain outside
the affected readiness verification set, including the already recorded
tracked-lexical fixture, so this record does not claim that the complete broad
suite is green.

**Decision:** `readiness_proof_pass_delta_latency_fail`. Receipt reuse and
single-flight cold validation pass, but the prospective add, edit, delete, and
rename gates remain failed under the last representative evidence. This remains
a performance miss, but it no longer blocks the independently authorized L4
direct retrieval-relevance comparison. The checksum-sealed evidence root is
`/home/hamza/repo/satori-readiness-proof-evidence/20260719-80045d8`; the
decision SHA-256 is
`d1c193b850d001053eb2f36ab8c9c48bfdd7597d7a5f8d1ecd1eec264cb186d8`,
and the checksum-manifest seal is
`5c9952b64a6af198254b87800e6c00625c6ab5c2b0c3efc2becc8610f86cc173`.

### L4 — direct paired retrieval-relevance qualification

Freeze exactly 36 tasks:

```text
6 languages x 6 tasks each = 36 tasks
```

The languages are TypeScript, JavaScript, Python, Go, Java, and Rust. Each
language contributes exactly one task in each of these primary cells:

1. exact identifier or path, with three identifier and three path tasks across
   the complete suite;
2. natural-language implementation ownership;
3. architecture or cross-file ownership;
4. configuration or runtime ownership;
5. changed-file or freshness-sensitive retrieval; and
6. negative or no-supported-answer behavior.

Every task has one primary language and cell for counting. The six negative
tasks remain useful future answer-behavior cases, but direct retrieval alone
cannot determine whether an agent would make a confident false claim. L4
therefore reports retrieval relevance on the 30 tasks with a required owner and
does not manufacture a negative-answer result.

Compare only the two already-published indexes:

* **Arm A:** Voyage connected reference using the existing production path.
* **Arm B:** Potion plus the existing Satori lexical, exact-evidence, fusion,
  grouping, and disclosure path, with no neural reranker.

For each frozen query, call `search_codebase` directly against both compatible
publications with the same grouped runtime scope and the same `limit: 15` and
`disclosureLimit: 15`. Record required-owner file rank, required symbol-label
rank when available, the first five result identities and scores, and wall
latency. Do not call an answering model, judge, OpenCode, MimoCode, or another
agent harness. Those layers answer a different question and are not required to
decide whether Potion retrieves relevant repository evidence.

Before either arm runs, freeze:

* repositories and revisions;
* expected owners, acceptable evidence, and answer facts;
* task and answer-key hashes;
* publication identities;
* the exact search request and result projection; and
* hardware and measurement method.

Arm B reuses the single network-blocked Potion publication created in L3. L4
does not authorize another full Potion publication. If its frozen repositories,
revisions, or identity cannot use that publication, stop and revise the plan
before running either arm.

The completed comparison produced these results on the 30 positive tasks:

| Metric | Potion | Voyage |
| --- | ---: | ---: |
| Required owner file at rank 1 | 13/30 | 14/30 |
| Required owner file in top 5 | 23/30 | 25/30 |
| Required owner file in top 15 | 25/30 | 27/30 |
| Required symbol label in top 5 | 16/30 | 21/30 |
| Required symbol label in top 15 | 20/30 | 24/30 |
| Search latency p50 | 94.64 ms | 1,009.46 ms |
| Search latency p95 | 1,251.00 ms | 1,813.34 ms |

Paired required-owner file rank favored Potion on 3 tasks, Voyage on 11, and
tied on 16. Top-five owner-file reachability by language was:

| Language | Potion | Voyage |
| --- | ---: | ---: |
| TypeScript | 5/5 | 5/5 |
| JavaScript | 4/5 | 4/5 |
| Python | 4/5 | 4/5 |
| Go | 3/5 | 3/5 |
| Java | 2/5 | 4/5 |
| Rust | 5/5 | 5/5 |

Both arms missed the frozen owner within the top 15 for the JavaScript path,
Python runtime-configuration, and Go path cases. Potion additionally missed the
Java natural-language owner and Java runtime-configuration owners that Voyage
reached. Exact/path top-five reachability tied at 4/6. Potion led freshness
top-one reachability 5/6 to 3/6; Voyage led configuration/runtime top-one
reachability 4/6 to 1/6.

The latency numbers are descriptive for this paired run, not replacements for
the frozen resource qualification. They include each arm's normal query-time
path and were not collected with the repetition contract required for a product
latency gate.

The frozen and prospective resource results are reported alongside L4 but are
not retrieval-relevance gates. L4 must not reinterpret either result, revise its
thresholds, or describe the original L3 resource qualification as passing.

**Decision:** `direct_relevance_useful_with_java_gap`. Potion retrieves the
required owner in the top five for 23/30 positive tasks and is materially faster
at the median in this run, so it is a useful offline first-stage baseline. It
does not match Voyage overall and has a clear Java weakness that must be
disclosed or addressed before making a broad cross-language quality claim. This
result is retrieval evidence, not agent-answer or negative-answer evidence.

The local result artifact is
`/home/hamza/repo/satori-l4-evidence/20260719-c6511bb/execution/direct-relevance-results.json`
with SHA-256
`1ba9db86314f9d6b66a5392e92a1484232c00d14f8ead37e38cabbcfaa35e939`.

Exit: complete. Do not tune against these revealed tasks and then describe them
as fresh evidence.

---

## 5. Initial resource expectations

Measure model-only and product-level costs separately.

Model-only:

* complete Potion artifact and helper bundle;
* cold model load;
* model-related RSS;
* embedding throughput; and
* per-batch and per-item latency.

Product-level:

* full publication;
* one-file incremental publication;
* warm public search;
* total process RSS; and
* total installed footprint.

The initial target envelope is:

* embedding bundle no more than 75 MiB;
* model-related RSS no more than 500 MiB;
* cold model load no more than 2 seconds;
* approximately 10k chunks published in no more than 30 seconds;
* one-file incremental publication p95 no more than 1 second;
* warm public search p95 no more than 500 ms; and
* zero Satori runtime network requests after installation.

Before measuring throughput or latency, checksum-seal the sample count,
discarded warmups, cold/warm cache state, operation order, background-load
policy, timing clock, and percentile calculation.

If L1 or the first applicable L3 measurement shows that a resource threshold is
unrealistic, retain the original measurement as a miss. Record any revised
threshold as an explicit product tradeoff in a new checksum-sealed manifest and
rerun the affected measurement. Never reinterpret the original run as a pass or
revise a threshold after observing contender quality results.

---

## 6. Decision

| Result | Action |
| ------ | ------ |
| Native inference or resource feasibility fails | Stop; do not implement a production provider. |
| Publication works but critical owners are absent from candidates | Do not ship; record the first retrieval-failure boundary. |
| Direct paired retrieval shows useful owner reachability with bounded, disclosed gaps | Proceed with the separately authorized Track A0 lifecycle without claiming agent-answer or negative-answer qualification. |
| Owners survive retrieval but answers are lost after retrieval | Open Follow-up Track C; do not add a reranker in this plan. |
| A broader release claim needs agent-answer, negative-answer, or multi-repository evidence | Open Track B only for that explicit claim. |
| Retrieval quality is not useful for the intended offline mode | Keep the provider experimental or do not expose it. |

The desired result is not proof that Potion beats Voyage. It is proof that
Potion supports a genuinely useful, small, private, and operationally simple
offline mode.

---

## 7. Current external evidence

* Potion model card and license:
  https://huggingface.co/minishlab/potion-code-16M-v2
* Reviewed Potion configuration:
  https://huggingface.co/minishlab/potion-code-16M-v2/blob/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b/config.json
* Official Model2Vec Rust repository:
  https://github.com/MinishLab/model2vec-rs
* Versioned Model2Vec Rust source reviewed for this proposal only:
  https://docs.rs/crate/model2vec-rs/0.2.1/source/src/model.rs

L0 replaces proposal-time upstream evidence with the exact selected model and
runtime revisions, checksums, and commit permalinks.
