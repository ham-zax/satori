# Satori Potion Offline Embedding Lean Qualification Plan

**Status:** L0 and L1 passed; L2 experimental provider integration passed
focused conformance; no supported runtime configuration or production default
has changed

**Date:** 2026-07-18

**Primary decision:** determine whether
`minishlab/potion-code-16M-v2` can support a useful, safe, lightweight Satori
offline-search mode.

**Current execution boundary:** stop after L2. L3 publication/indexing, L4
product qualification, and every follow-up-plan track remain separately
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
but it is not a supported product configuration until L4 passes and
Productization Track A completes.

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

**Decision:** L2 passed. Stop here. No LanceDB publication, document indexing,
reranking, installer work, L3, or L4 was performed or authorized.

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

### L4 — frozen 36-task product qualification

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

Every task has one primary language and cell for counting.

Compare only:

* **Arm A:** Voyage connected reference using the existing production-quality
  path.
* **Arm B:** Potion plus the existing Satori lexical, exact-evidence, fusion,
  grouping, and disclosure path, with no neural reranker.

Before either arm runs, checksum-seal:

* repositories and revisions;
* expected owners, acceptable evidence, and answer facts;
* criticality, the ambiguous-task adjudication rule, and the exact classifier
  for a confident false answer;
* task and answer-key hashes;
* agent and judge versions, system prompts, and whether each is local or remote;
* tool schemas and descriptions;
* tool-call ceiling plus continuation-page and source-read ceilings;
* temperature and seed where supported, trial count, and execution order;
* blind cell labels and the complete adjudication procedure;
* publication identities;
* hardware and measurement method; and
* the acceptance gates below.

Arm B reuses the single network-blocked Potion publication created in L3. L4
does not authorize another full Potion publication. If its frozen repositories,
revisions, or identity cannot use that publication, stop and revise the plan
before running either arm.

The L4 diagnostic capture freezes the exact candidate arms, per-arm depths, and
candidate union produced by Arm B's frozen production configuration. It also
captures a predeclared diagnostic superset without feeding additional candidates
into production ranking or disclosure. For each candidate it records the
candidate ID, dense/lexical/exact provenance, original source rank, owner ID,
exact source-projection digest, and final survival stage. Do not copy additional
source text into the evidence bundle. A later Track C experiment reconstructs
candidate text from the frozen source revision and rejects a projection whose
digest does not match.

Arm B passes only if all of these are true:

* correctness is at least `30/36`;
* correctness is no more than two answers behind Arm A;
* correctness is at least `4/6` in every language;
* correctness is no more than one answer behind Arm A in every language;
* there is no additional critical hard miss versus Arm A;
* the required exact-identifier or path owner is reachable `6/6` through the
  frozen result and continuation path;
* no paired exact-identifier or path task is correct under Arm A and incorrect
  under Arm B;
* there is no critical configuration/runtime owner miss;
* at most one paired configuration/runtime task is correct under Arm A and
  incorrect under Arm B;
* there are zero confident false answers across all six negative tasks;
* any ambiguous result is decided under the frozen adjudication rule without
  rewriting the task or answer key;
* required evidence comes only from the frozen result and continuation path;
  and
* Satori-runtime offline, resource, fingerprint, publication, and lifecycle
  checks pass.

Unresolved ambiguity is not a separate veto: frozen adjudication assigns the
task outcome consumed by the integer gates.

Exit: record pass or fail without tuning against the 36-task result.

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
| Potion stays close to Voyage and meets offline/resource gates | Approve explicit `offline_lite` productization under Follow-up Track A. |
| Owners survive retrieval but answers are lost after retrieval | Open Follow-up Track C; do not add a reranker in this plan. |
| Quality is useful but below the release floor | Keep the provider experimental or do not expose it. |
| Potion passes | Proceed only to the independently triggered follow-up tracks needed for the intended release claim. |

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
