# Satori Lightweight Offline Embedding and Reranker Qualification Plan

**Status:** proposed execution plan; no runtime behavior has changed

**Date:** 2026-07-18

**Primary decision:** first prove `minishlab/potion-code-16M-v2` is technically
feasible as a lightweight local embedding provider without changing a LanceDB
publication. Keep Voyage `voyage-code-3` as the connected quality reference.
Only after the runtime, configuration, and qualification contracts below are
frozen may Potion enter production implementation and full agent-answer
qualification. Add a small offline reranker only if a frozen experiment proves
that it improves practical answers enough to justify its latency, memory, and
packaging cost.

**Relationship to existing work:** this is a separate offline qualification
track. It does not replace the existing Phase 4 multi-field lexical design or
Phase 5 LanceDB maintenance work in
`docs/plans/LANCEDB_SEARCH_TUNING_AND_AGENT_ANSWER_QUALIFICATION_PLAN.md`.

---

## 1. Executive decision

Satori should not assume that a 16M-parameter static model will outperform
Voyage on semantic code retrieval. There is no authoritative same-runtime,
same-corpus evidence showing that it does. Voyage remains the expected quality
leader.

The local model can nevertheless be the better product for many users because
it can provide:

* fully offline runtime operation after an explicit connected install or
  air-gapped bundle import;
* no API key, paid embedding calls, telemetry, or source-content transfer from
  the qualified offline runtime;
* no Ollama, GPU, Python service, or large generative model;
* a small model download and low vector-storage cost;
* very fast full and incremental embedding on ordinary CPUs; and
* predictable operation in air-gapped and privacy-sensitive environments.

The product should expose installer/UI presets rather than add new runtime
profiles. A preset expands once into ordinary configuration values; runtime
behavior remains owned by that configuration:

| Preset or existing configuration | Execution policy | Embedding             | Reranker         |
| -------------------------------- | ---------------- | --------------------- | ---------------- |
| `connected_quality`              | `connected`      | Voyage                | Voyage           |
| `offline_lite`                   | `offline`        | Potion                | none             |
| `offline_quality`                | `offline`        | Potion                | local ONNX       |
| Existing Ollama configuration    | `offline`        | Ollama                | existing behavior |

The first three rows are conveniences, not values of the existing index-profile
contract. The existing `default`, `minimal`, and `all-text` index profiles keep
their current meaning.

Compatibility rules are mandatory:

* Existing `offline + Ollama` installations continue unchanged.
* Selecting Potion is explicit until it qualifies; no fallback or upgrade may
  silently migrate an Ollama installation.
* Reject `offline + Voyage` at configuration validation.
* Expert configuration may select Potion under `connected`, but no preset,
  migration, or automatic fallback may do so. `connected` permits network use;
  it does not choose the embedding provider.
* Persist only the expanded ordinary configuration. The preset must not become
  a second source of runtime truth.

Milvus remains supported. LanceDB remains the default local storage backend.
This work changes embedding identity, not storage ownership.

### 1.1 Honest answer to “will it be better than Voyage?”

Probably not on raw semantic quality. It may be better on total product utility
when privacy, offline availability, startup simplicity, latency, and cost are
included.

The local presets are releasable only if they cross a frozen minimum answer-
quality bar. It does not need rank-for-rank agreement with Voyage, but it must
not become a fast search system that regularly hides the owning code from the
agent.

### 1.2 What is deliberately not proposed

* Do not replace Satori with the Semble MCP server.
* Do not introduce a Python or `uv` runtime into Satori's default installation.
* Do not make Semble's full-rebuild cache the authority for Satori freshness.
* Do not copy Semble ranking constants without Satori-specific evidence.
* Do not advertise “99% of transformer quality” from Semble's own benchmark as
  a Satori result.
* Do not make the offline reranker mandatory before testing the no-reranker
  baseline.
* Do not remove Voyage or Milvus support.

### 1.3 Why not use Semble wholesale?

Semble is a valuable external baseline and implementation reference. It is also
a complete Python search engine with its own tree-sitter chunking, BM25 index,
flat in-memory dense index, cache invalidation, ranking, MCP server, and response
format. Running it as Satori's production engine would create two owners for
most of the search lifecycle:

| Concern           | Semble owns                                 | Satori already owns                                                             |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| Chunking          | Semble tree-sitter/line chunker             | Versioned Core source projections and symbol ownership                          |
| Dense storage     | In-memory/persisted flat vector array       | LanceDB or Milvus adapters and publication identity                             |
| Lexical retrieval | `bm25s` index and enrichment                | Core lexical projection plus backend FTS/BM25                                   |
| Freshness         | Cache validation and full rebuild on change | Incremental sync, leases, receipts, generations, and recovery                   |
| Ranking           | Semble RRF and code heuristics              | Core/MCP fusion, exact evidence, reranking, grouping, and diversity             |
| Disclosure        | Semble top snippets                         | Satori grouped results, byte budgets, stable continuation, and source authority |

Direct adoption would be appropriate if the product goal were only to ship a
standalone offline code-search MCP quickly. It is not the best integration for
Satori's existing backend-neutral and publication-aware architecture.

Use Semble in three narrower ways:

1. use its Model2Vec approach as a lightweight dense-provider reference after
   recording the model its pinned revision actually loads;
2. reproduce and test its BM25 enrichment and code-aware ranking ideas inside
   Satori's stage-aware replay harness; and
3. run the pinned Semble application as an external end-to-end benchmark arm so
   Satori can detect whether its own chunking, lexical retrieval, ranking, or
   disclosure is leaving quality on the table.

The external Semble arm is diagnostic. Because its chunking, retrieval, and
ranking all differ, it is not a causal embedding-model comparison and cannot be
classified as `storage_only`.

### 1.4 Implementation boundary

An isolated feasibility prototype may begin before the 90-task suite exists.
It may pin artifacts, build the native runtime, load the model persistently,
exercise inference, and measure its own process. It must not add a production
provider, change configuration defaults, create a new LanceDB publication, or
claim product qualification.

No production provider change may merge until all of these are settled:

* preset expansion and provider-policy validation;
* native query/document, pooling, normalization, and long-input semantics;
* persistent inference ownership and failure behavior; and
* mechanically exact qualification gates and task counts.

---

## 2. Starting authority and integration boundary

The obsolete Phase 2 worktree and pre-integration O0 instructions are not
execution authority. At the start of each phase, record the accepted repository
revision, clean-tree status, active provider/configuration contracts, and the
specific evidence inputs that the phase consumes. Historical worktree paths and
old experiment ledgers may be provenance, but they cannot override the current
accepted code and contracts.

Current contract owners to inspect from the recorded starting revision are:

* retrieval and answer behavior:
  `docs/plans/LANCEDB_SEARCH_TUNING_AND_AGENT_ANSWER_QUALIFICATION_PLAN.md`;
* freshness and publication behavior:
  `docs/plans/INCREMENTAL_INDEX_FRESHNESS_PLAN.md`; and
* backend/offline release behavior:
  `docs/release/2026-07-15-lancedb-voyage-offline-plan.md`.

This plan does not authorize reconciling, committing, or rewriting unrelated
Phase 2 or Phase 3 work. If the recorded starting revision does not contain a
contract this plan depends on, stop and identify the missing accepted authority
instead of importing it from an old worktree.

New durable evidence belongs under:

```text
/home/hamza/satori-evidence/offline-embedding/<immutable-runtime-sha>/
```

No authoritative evidence should live only under `/tmp`.

---

## 3. Proposed runtime architecture

### 3.1 Embedding provider

Use the MIT-licensed `minishlab/potion-code-16M-v2` artifact through the
official Rust `model2vec-rs` implementation or an equivalently small,
deterministic native helper.

The inference operation is static token embedding plus pooling. It does not
perform a transformer forward pass and does not require Ollama.

```text
source/query bytes
    -> pinned tokenizer
    -> static token-vector lookup
    -> configured pooling and normalization
    -> 256-dimensional vector
```

Core continues to own:

* the exact document projection supplied to the model;
* query/document embedding roles;
* normalization policy;
* embedding fingerprint and compatibility;
* chunk identity and publication behavior; and
* backend-neutral search meaning.

The native helper owns only deterministic inference for an immutable model
artifact. It must not enrich source text, choose ranking policy, or write
directly to LanceDB.

#### 3.1.1 Frozen inference semantics

Potion uses one symmetric transform. Satori may retain separate query and
document operations for provider compatibility, but the Potion implementation
must not add Voyage-style query or document prefixes. The embedding fingerprint
records and conformance tests prove all of:

```text
query treatment: symmetric, no prefix
document treatment: symmetric, no prefix
pooling: arithmetic mean after pinned token filtering, mapping, and weights
normalization: L2 enabled from the pinned model configuration
dimensions: 256
maximum input: explicit Satori-owned token limit
```

The reviewed Potion revision
`e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b` declares normalization enabled.
The final manifest must pin the exact model and `model2vec-rs` revisions and
prove their output against a reference fixture; a library upgrade that changes
token filtering, pooling, normalization, or floating-point output changes the
fingerprint.

Do not call the library's default `encode` operation. It silently truncates at
512 tokens. Core owns bounded chunks and supplies the helper with an explicit
maximum that is part of the provider contract. The helper rejects an oversized
input with its observed token count instead of truncating it. Core may
deterministically split a projection before inference when the projection
contract permits it. Unlimited input is excluded because generated or
pathological files must not create unbounded work.

#### 3.1.2 Persistent inference ownership

Production inference must use one of these frozen ownership models:

1. an in-process native library with one model-loaded instance per owned
   runtime; or
2. a persistent model-loaded worker using a versioned, bounded, framed
   protocol.

Starting a CLI and loading the model for every embedding request is forbidden.
The selected owner must define readiness and health checks, bounded queues and
batch sizes, request cancellation and deadlines, crash classification and
restart limits, shutdown, and behavior for in-flight work. Protocol frames,
errors, and logs must not contain or record source content. Repeated worker
failure degrades through the existing classified provider path rather than
creating an unbounded restart loop.

### 3.2 Vector storage

LanceDB stores the resulting 256-dimensional vectors and the existing Core-
generated lexical/source/control fields. For the existing 9,872-chunk
qualification corpus, raw FP32 vector payload is approximately 9.6 MiB before
LanceDB metadata, source text, FTS data, and version overhead.

Switching from Voyage's 1,024 dimensions to Potion's 256 dimensions changes
embedding compatibility. It therefore requires a new publication and full
reindex. Dense vectors must never be reused across these fingerprints.

### 3.3 Artifact and security contract

Every model installation records:

* model repository and exact revision;
* every downloaded file name, size, and SHA-256;
* tokenizer identity;
* dimensions, pooling, normalization, and maximum supported input behavior;
* license and notice files;
* native runtime revision, build features, executable or library hash, and
  platform identity; and
* provider policy document digest.

Runtime loading must use local pinned files. It must not execute mutable remote
code. Build `model2vec-rs` without default features and with the required
tokenizer backend plus `local-only`; the production closure must contain no Hub
download path. A partial download, checksum mismatch, incompatible artifact, or
failed preflight leaves the previous working runtime active and produces a
classified error.

The native feasibility baseline uses:

```text
cargo build --no-default-features --features onig,local-only
```

If a supported platform requires a different tokenizer backend, freeze that
feature set separately and require the same inference fixtures.

Support two installation paths:

1. connected first install followed by fully offline use; and
2. an air-gapped bundle containing the exact model, helper, checksums, license,
   and manifest.

The connected installer may fetch only the pinned, checksummed artifacts in the
installation manifest. It must not receive repository source content. After
installation, an offline test blocks network access and proves runtime startup,
document and query embedding, indexing, restart, search, continuation, and
incremental update all succeed with zero attempted requests.

### 3.4 Mandatory Potion + BM25 hybrid contract

Potion is not qualified as a dense-only product. The release candidate is the
complete hybrid path:

```text
Potion 256-dimensional dense candidates -----+
                                               +-> Core fusion and exact evidence
LanceDB FTS/BM25 lexical candidates ----------+          |
exact registry/path/symbol evidence ---------------------+
                                                          v
                                               MCP fusion, grouping,
                                               diversity, disclosure
```

The lexical arm uses Core-generated lexical text and backend search. It must
preserve exact identifiers, paths, symbol/breadcrumb evidence, and diagnostic
source ranks. Dense and lexical candidates are captured separately before
fusion so the experiment can distinguish:

* a weak Potion embedding;
* insufficient BM25 recall;
* a fusion or weighting loss;
* reranker admission loss; and
* grouping or disclosure loss.

Test a Semble-compatible lexical/ranking replay from the same frozen tasks, but
do not silently replace production BM25 tokenization or ranking. Any admitted
change must remain backend-neutral or receive explicit Milvus non-regression
qualification.

---

## 4. Offline reranker decision

An offline reranker is useful only if the correct owner reaches its input. It
cannot recover a candidate already lost during embedding retrieval, lexical
retrieval, Core fusion, or MCP fusion.

The first offline baseline therefore uses no neural reranker:

```text
Potion dense + existing lexical evidence
    -> existing Satori fusion and exact evidence
    -> deterministic ranking/grouping
    -> progressive disclosure
```

Only after stage-aware traces identify answer losses after candidate survival
may a local cross-encoder be admitted.

### 4.1 Frozen reranker shortlist

Screen at most these two small, Apache-2.0 candidates:

| Candidate                             | Reported INT8 ONNX file | Strength                                         | Main risk                                                                                                                        |
| ------------------------------------- | ----------------------: | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `cross-encoder/ms-marco-MiniLM-L6-v2` | about 23.2 MB            | Very small, standard architecture, broad support | General passage model; 512-token limit may truncate code evidence                                                                |
| `jinaai/jina-reranker-v1-tiny-en`     | about 33.4 MB            | Longer input support, still small                | General English; its normal Transformers path uses remote custom code, so the native export is conditional on exact conformance |

These figures describe one reported ONNX file, not installed size. Before
admission, record the complete bundle: ONNX graph and external weights,
tokenizer/configuration, native runtime libraries, notices, manifest, and any
platform-specific files. Apply download and installed-footprint gates to that
complete bundle rather than quoting the graph alone.

Do not add more candidates after observing results. A third candidate requires a
new frozen experiment, not a runner-up search on the held-out set.

### 4.2 Reranker runtime contract

* Use pinned ONNX bytes through the existing native/runtime installation
  mechanism; do not require Python.
* Keep Jina ineligible unless its pinned ONNX graph and tokenizer reproduce
  reference scores without Python, `trust_remote_code`, or runtime code fetches.
* Rerank only a diversity-preserving bounded candidate set.
* Preserve exact-match pinning and mandatory lexical/path evidence.
* Enforce both candidate-count and exact document-string UTF-8 byte ceilings.
* Record truncation and omitted-candidate reasons.
* Run zero reranking during `continue_search`; continuation consumes the frozen
  ranked result-set handle.
* Treat failure as classified degradation to deterministic offline ranking,
  never as loss of the searchable publication.

Candidate limits `16`, `24`, and `32` may be replayed from one frozen capture.
Select the smallest limit that passes the quality gate. Never exceed the
existing production maximum or byte ceiling without a separately frozen
experiment.

### 4.3 Admission rule

Do not ship a local reranker merely because its rankings differ. It must:

* on the tuning set, remove at least one answer failure or improve at least two
  answers without creating a new hard miss before it may become the sole
  finalist;
* preserve exact identifier and configuration-owner tasks;
* stay within the offline-quality resource budget;
* produce deterministic ordering for identical inputs; and
* beat the no-reranker offline baseline, not merely a synthetic rank metric.

If the Potion baseline passes the product quality gate and neither reranker
adds material answer value, ship `offline_lite` without a neural reranker.

---

## 5. Experimental design

### 5.1 Separate experiments

Do not blend these measurements:

1. **Embedding retrieval:** whether Potion places the expected evidence in the
   candidate superset.
2. **Ranking/disclosure:** whether Satori preserves and exposes that evidence.
3. **Reranker:** whether a tiny local cross-encoder improves final ordering.
4. **Agent answer:** whether a real agent reaches the correct answer within the
   frozen tool, context, and disclosure budget.
5. **Performance:** model install, load, indexing, incremental update, search,
   reranking, and end-to-end wall time.

Offline replay may measure candidate survival and ranking changes. It cannot
substitute for live database latency, native-model memory, cold start, or final
agent behavior.

### 5.2 Comparison matrix

| Arm | Storage                                 | Embedding                                | Reranker                    | Purpose                           |
| --- | --------------------------------------- | ---------------------------------------- | --------------------------- | --------------------------------- |
| A   | LanceDB                                 | Voyage `voyage-code-3`                   | Current Voyage policy       | Connected quality reference       |
| B   | LanceDB FTS/BM25 hybrid                 | Potion Code 16M v2                       | None                        | Offline-lite release candidate    |
| C   | LanceDB FTS/BM25 hybrid                 | Potion Code 16M v2                       | One frozen local finalist   | Offline-quality candidate         |
| S   | Semble's own flat dense + `bm25s` stack | Model loaded by pinned Semble revision   | Semble deterministic ranker | External diagnostic baseline only |

Arm C is created only if a reranker passes tuning. Arm A may reuse an existing
publication only when its source, runtime compatibility, task suite, and
publication authority satisfy the new manifest. Otherwise build a new frozen
reference.

This is a deliberate full-stack comparison, not `storage_only`: embedding
model, dimensions, provider, and possibly reranker differ.

Arm S is run from one pinned Semble revision against the same source revisions
and answer tasks. Its result is reported separately because it does not share
Satori's chunks, candidates, publication receipt, grouping, or disclosure.

The reviewed Semble commit
`f4c397e2ede0c16ab1772adeee9a0af1024043bf` loads
`minishlab/potion-code-16M-v2` in its runtime default while its public README
and benchmark text still name `minishlab/potion-code-16M`. Pin a commit and
capture its resolved model configuration in the arm manifest. Either configure
v2 explicitly and prove that identity, or label Arm S with the model it
actually loads; public benchmark labels are not runtime evidence.

### 5.3 Frozen task suite

Before running a contender, freeze exactly 90 tasks across at least eight
repositories and small/medium/large repository bands. Use these six product
languages because they exercise Satori's intended navigation surface:

| Primary language | Tuning | Held-out | Total |
| ---------------- | -----: | -------: | ----: |
| TypeScript       |      5 |       10 |    15 |
| JavaScript       |      5 |       10 |    15 |
| Python           |      5 |       10 |    15 |
| Go               |      5 |       10 |    15 |
| Java             |      5 |       10 |    15 |
| Rust             |      5 |       10 |    15 |
| **Total**        | **30** |   **60** | **90** |

TypeScript and Rust are deliberate product-generalization coverage. Potion's
model card names Python, Java, JavaScript, Go, PHP, and Ruby as training
languages; the benchmark must not substitute the training list for the users
Satori intends to support.

Allocate the same tasks by primary class exactly as follows:

| Primary class                                 | Tuning | Held-out | Total |
| --------------------------------------------- | -----: | -------: | ----: |
| Exact symbol/identifier                       |      5 |       10 |    15 |
| Natural-language implementation owner         |      7 |       13 |    20 |
| Architecture/module ownership                 |      5 |       10 |    15 |
| Configuration/build/runtime ownership         |      5 |       10 |    15 |
| Cross-file relationships and callers          |      3 |        7 |    10 |
| Changed-file and freshness-sensitive queries  |      3 |        7 |    10 |
| Negative/no-supported-answer cases            |      2 |        3 |     5 |
| **Total**                                     | **30** |   **60** | **90** |

Every task has exactly one primary language and one primary class for counting,
even when its answer crosses files or languages.

Benchmark definitions must not be included in the indexed corpus. Each task
records expected owners, acceptable secondary evidence, answer facts, critical
failure classification, and the permitted disclosure path.

Split once before observation into the 30 tuning and 60 sealed held-out tasks
shown above.

The answering-agent contract freezes model, prompts, tools, maximum calls,
continuation policy, context budget, temperature/seed where supported,
repetition rule, blind judge, and human-adjudication procedure.

### 5.4 Immutable identity

Every arm records and validates:

* clean Git revision and tree state;
* Core, MCP, CLI, helper, policy, recorder, and comparator hashes;
* package manifests, lockfile, native libraries, Node, and OS/architecture;
* source corpus revision and canonical-root digest;
* embedding/reranker artifact manifests;
* task, expected-owner, answer-key, agent, judge, and disclosure hashes;
* publication receipt before and after every live sample; and
* sample order, warm/cold classification, and hardware identity.

Comparators reject missing, malformed, drifting, or unequal identities where
equality is required.

### 5.5 Publication and mutation isolation

For each arm:

```text
full index
-> status and publication receipt
-> explicit zero-change sync
-> require added=0, removed=0, modified=0
-> freeze publication
-> disable watcher/background mutation
-> execute samples through published_index or equivalent no-sync path
-> validate receipt before and after every sample
```

Timed runs disable detailed tracing. Separate untimed runs capture complete
candidate-survival diagnostics.

---

## 6. Frozen acceptance gates

These numerical gates must be copied into the signed experiment manifest before
contender output is visible. If the final reference hardware or task count
changes, publish a new manifest before running the candidates.

### 6.1 Offline-lite answer quality

On the 60-task sealed held-out set, Arm B must satisfy all of:

* final-answer correctness at least `54/60`;
* no more than one fewer correct answer than Arm A;
* correctness at least `9/10` in each of the six primary-language cells and no
  language cell more than one correct answer behind Arm A;
* no additional critical hard miss versus Arm A;
* at most one additional noncritical hard miss versus Arm A;
* exact symbol/identifier owner reachability exactly `10/10` within the allowed
  disclosure path;
* configuration/build/runtime owner reachability exactly `10/10` within the
  allowed disclosure path;
* zero new confident false answers versus Arm A across the three held-out
  negative/no-answer tasks; and
* no answer depends on evidence outside the frozen result and continuation
  path.

Report all paired counts, including every language and class cell. Use paired
bootstrap confidence intervals and a predeclared human adjudication rule only
as supporting evidence, not as permission to revise the integer thresholds.

### 6.2 Offline reranker quality

Arm C must satisfy the Arm B gates and additionally:

* improve at least three held-out final answers or remove at least one hard miss
  compared with Arm B;
* introduce zero new hard misses;
* introduce zero exact-identifier regressions;
* not increase average follow-up searches, expansions, or context bytes by more
  than 10%; and
* preserve deterministic continuation ordering and authority.

If no reranker passes tuning, do not reveal the reranker validation cells and do
not choose a runner-up.

### 6.3 Resource gates

Reference hardware must be a declared CPU-only user machine with no discrete
GPU. Record CPU model, logical/physical cores, RAM, storage, OS, power mode, and
background-load policy.

For `offline_lite`, additional model/runtime cost must satisfy:

* complete downloadable embedding artifact bundle no more than 75 MiB;
* peak model-related RSS no more than 500 MiB;
* cold model initialization no more than 2 seconds;
* full embedding/index publication for the approximately 10k-chunk reference
  corpus no more than 30 seconds;
* one changed-file incremental publication p95 no more than 1 second;
* warm search p50 no more than 200 ms and p95 no more than 500 ms; and
* zero network requests after installation.

For `offline_quality`, the reranker additionally must satisfy:

* complete downloadable reranker bundle no more than 50 MiB;
* combined peak model-related RSS no more than 1 GiB;
* reranker p50 no more than 300 ms and p95 no more than 750 ms at the selected
  candidate and byte budget; and
* end-to-end warm search p95 no more than 1.5 seconds.

These limits measure incremental model/runtime cost, not the pre-existing Core,
MCP, LanceDB, source, or FTS footprint. Also publish total process RSS and total
installed footprint so this distinction cannot mislead users.

### 6.4 Performance measurement contract

Measure and report these boundaries separately:

1. embedding-only throughput plus per-batch and per-item latency;
2. model load time and model-related RSS after readiness;
3. full indexing from explicit invocation through completed publication
   receipt;
4. warm end-to-end search through the public result; and
5. one changed-file incremental publication from explicit sync invocation
   through completed publication receipt.

A watcher event is not the start boundary for incremental publication timing.
Before any contender is measured, freeze the repetitions, discarded warmups,
batch and corpus identity, cold/warm cache state, background-load policy,
clock, and percentile calculation. Do not combine model load, embedding,
database publication, and public-search latency into one unlabeled number.

---

## 7. Execution phases

Use `O` phase names to avoid collision with the existing search-tuning plan.

### O0 — establish current execution authority

1. Record the accepted starting revision and require a clean task-owned tree.
2. Resolve the current configuration, embedding-provider, publication,
   continuation, and freshness contract owners named in Section 2.
3. Record the exact historical evidence inputs that remain applicable; label
   old worktrees and superseded ledgers as reference-only.
4. Run only the focused checks needed to prove the recorded starting contracts.

Exit: the phase has one current revision and explicit contract owners; it does
not depend on an obsolete worktree or authorize unrelated integration work.

### O1 — prove technical feasibility without a publication

1. Pin Potion model revision, tokenizer, license, files, and checksums.
2. Pin `model2vec-rs` and build it with no default features, the required
   tokenizer backend, and `local-only`.
3. Load the model once through a minimal in-process runtime or persistent
   bounded worker; do not invoke a model-loading CLI per request.
4. Prove deterministic, finite 256-dimensional output, symmetric query/document
   treatment, and the frozen pooling and normalization rule.
5. Prove that oversized input is rejected under an explicit maximum and never
   silently truncated at the library's 512-token default.
6. Measure model load time, warm inference latency, throughput, and
   model-related RSS under a recorded environment.
7. Block network access and prove the loaded runtime attempts no request.
8. Do not add a production provider, change defaults, or create/reindex a
   LanceDB publication in this phase.

Exit: a small evidence bundle establishes feasibility or rejects the native
approach without mutating a production index.

### O2 — freeze production and qualification contracts

1. Freeze preset expansion, execution-policy validation, existing Ollama
   compatibility, and the rule for explicit Potion use under `connected`.
2. Freeze the 90-task split, owners, answer keys, per-language cells, agent,
   judge, disclosure policy, resource hardware, and integer gates.
3. Freeze the persistent inference owner, framed protocol if applicable,
   explicit input limit, cancellation, queue, recovery, and logging behavior.
4. Freeze exact model and runtime revisions, build closure, inference fixture,
   fingerprint, and failure classifications.
5. Create complete connected-install and air-gapped bundle manifests.

Exit: no tuning or held-out answer output has been observed, all authorities
are immutable, and production-provider implementation is unblocked.

### O3 — implement the local embedding provider

1. Add a backend-neutral Core embedding-provider implementation.
2. Add an immutable native runtime installer/preflight path.
3. Implement document and query embedding roles with finite-value, dimension,
   normalization, batching, cancellation, and identity checks.
4. Prove deterministic byte-for-byte output within the supported platform
   contract or define a numerically stable tolerance and resulting identity.
5. Add corrupt-download, interrupted-install, offline-restart, version-upgrade,
   and rollback tests.
6. Ensure local-only startup owns no unrelated embedding background lifecycle.

Exit: provider conformance passes without LanceDB or paid services.

### O4 — index and lifecycle qualification

1. Create one fresh LanceDB/Potion publication.
2. Validate 256-dimensional schema and embedding fingerprint.
3. Run zero-change sync and prove receipt stability.
4. Change, add, rename, and delete representative files.
5. Prove only required chunks are re-embedded and unchanged authority is reused.
6. Test crash recovery, close/reopen, concurrent reads, watcher disabled, and
   fully blocked network.
7. Measure full and incremental indexing, peak RSS, disk, and cold start.

Exit: a searchable offline publication is correct and operationally usable.

### O5 — qualify the no-reranker offline baseline

1. Capture separate maximum Potion-dense, BM25/FTS-lexical, exact-registry, and
   stage-survival evidence once.
2. Prove exact replay of the production hybrid baseline.
3. Run the 30 tuning tasks without a neural reranker.
4. Run pinned Semble on the same tuning tasks as a separately labeled external
   baseline.
5. Localize every miss to dense retrieval, lexical retrieval, fusion,
   admission, grouping, disclosure,
   or answering.
6. If the expected owner is absent from the captured candidates, do not use a
   reranker to claim a fix.
7. If Semble finds an owner that Arm B misses, replay its chunking, BM25, and
   ranker contributions separately before proposing a production change.
8. Freeze Arm B if it meets the tuning gates.

Exit: Potion's practical baseline is known before optional reranking.

### O6 — screen the offline reranker, only if justified

1. Freeze both candidate artifact manifests before scoring either.
2. Replay candidate limits 16, 24, and 32 from identical captured inputs.
3. Measure answer effects, truncation, exact evidence, latency, RSS, context,
   and continuation invariants.
4. Select at most one finalist using tuning tasks only.
5. If no candidate crosses the predeclared improvement gate, retain Arm B and
   close the reranker experiment.

Exit: zero or one offline-quality finalist exists.

### O7 — one-shot held-out agent qualification

1. Run Arm A and Arm B on the sealed 60-task set under their frozen
   publications.
2. Run Arm C only if O6 selected a finalist.
3. Blind backend/preset names from automated judges and human adjudicators.
4. Record all initial results, continuations, opened evidence, extra searches,
   tool calls, latency, context, memory, and provider/network activity.
5. Apply the numerical gates without adjusting the rubric.
6. Archive raw observations, receipts, manifests, ledgers, judgments, and
   checksums durably.

Exit: the product preset and provider decision is evidence-backed.

### O8 — release polish

1. Make preset expansion and provider selection explicit and reversible.
2. Explain initial model download size, disk/RAM estimate, offline status, and
   quality tradeoff before installation.
3. Display index progress, cancellation, recovery, and actionable failures.
4. Prove uninstall never deletes repository data or unrelated caches.
5. Produce SBOM, license notices, checksums, platform support, and a privacy
   statement.
6. Test clean install, upgrade, downgrade, corrupt cache, no-network install,
   air-gapped bundle, restart, and multiple repositories.
7. Document that LanceDB has no artificial collection-count limit.

Exit: a normal developer can install and use offline search without operating
an AI service.

### O9 — contingency only if Potion fails retrieval quality

If Arm B fails because expected owners are absent before reranking, stop. Do not
hide the failure with disclosure tuning.

The only first contingency is a separately frozen CodeRankEmbed INT8 local
arm. It requires its own artifact manifest, resource gate, embedding fingerprint,
and full reindex. Do not automatically proceed to CodeSage, SFR, or an open-
ended model tournament.

SFR remains excluded from a commercial default while its published artifact is
CC-BY-NC/research-oriented. CodeSage Small remains a later Apache-2.0 comparator
only if CodeRankEmbed also fails or exceeds resource limits.

---

## 8. Freshness and “real-time” behavior

This plan does not replace the authority in
`INCREMENTAL_INDEX_FRESHNESS_PLAN.md`. A cheap local embedder makes faster
freshness possible but does not make watcher races or publication authority
disappear.

After offline indexing qualifies, a separate freshness experiment may replace
the fixed five-second user experience with:

```text
watcher event -> increment dirty epoch immediately
edit burst -> adaptive coalescing
search -> join or request coverage of the latest required epoch
maximum delay -> force a pass even during continuous edits
publication -> expose only complete authority
```

The debounce is then an implementation detail, not a promise that every edit is
searchable after exactly five seconds. Generated artifacts remain controlled by
ignore policy and adaptive coalescing. A search requiring current evidence can
join the latest update; ordinary searches can use the last publication with an
honest freshness statement.

Do not couple this semantic change to the initial Potion provider patch.

---

## 9. Autonomous execution loop

An implementation agent may proceed autonomously inside this scope:

```text
inspect current clean authority
-> state one measurable hypothesis
-> make the smallest scoped change
-> run focused tests
-> run integration-invalidated gates
-> capture immutable evidence
-> apply frozen acceptance rule
-> accept, revert contender behavior, or localize the next failure
```

Starting in O4, the agent may perform required reindexes when embedding
compatibility changes. O1 feasibility expressly does not reindex LanceDB. There
is no artificial indexing-attempt ceiling. However, a reindex must have a
documented reason, immutable input identity, and expected decision value. Do
not repeat paid or local indexing merely to fish for a favorable result.

The agent stops and reports rather than guessing when:

* held-out evidence would need to be unsealed early;
* a license or redistribution right is unclear;
* a model/runtime change expands installation requirements materially;
* evidence authority cannot be reconstructed;
* a production or user-state mutation is outside the declared worktree and
  evidence roots; or
* the next action would delete or overwrite unproven user data.

---

## 10. Final decision table

| Evidence outcome                                                         | Product decision                                                                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Potion passes answer and resource gates; reranker adds no material value | Ship `offline_lite` as the default offline preset                                                                                                           |
| Potion passes; one tiny reranker also passes its incremental gate        | Ship `offline_lite` plus optional `offline_quality`                                                                                                         |
| Potion misses owners before reranking                                    | Do not ship it as quality-equivalent; run the single CodeRankEmbed contingency                                                                              |
| Pinned Semble passes while Satori's Potion+BM25 arm fails                | Localize the gain; port the responsible component, or open a separate Semble-engine adapter RFC if the gain cannot be reproduced without its complete stack |
| Potion answers well but exceeds resource limits                          | Optimize native packaging/runtime once, then rerun under a new manifest                                                                                     |
| Potion is useful but below connected quality gate                        | Offer it as explicitly lower-quality offline mode only if it still meets the absolute safety/answer floor                                                   |
| No local candidate meets the floor                                       | Keep Voyage connected and do not advertise released offline semantic search                                                                                 |

The desired result is not “Potion beats Voyage.” It is:

> Satori provides a small, private, operationally simple offline search mode
> that agents can genuinely use, while preserving Voyage as the connected
> quality option for users who prefer it.

---

## 11. Primary external references

* Semble implementation and benchmark:
  https://github.com/MinishLab/semble
* Semble benchmark methodology:
  https://github.com/MinishLab/semble/tree/main/benchmarks
* Reviewed Semble runtime model default:
  https://github.com/MinishLab/semble/blob/f4c397e2ede0c16ab1772adeee9a0af1024043bf/src/semble/utils.py
* Potion Code 16M v2 model card and license:
  https://huggingface.co/minishlab/potion-code-16M-v2
* Reviewed Potion configuration:
  https://huggingface.co/minishlab/potion-code-16M-v2/blob/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b/config.json
* Official Model2Vec Rust implementation:
  https://github.com/MinishLab/model2vec-rs
* Model2Vec Rust pooling, truncation, and local-only implementation:
  https://github.com/MinishLab/model2vec-rs/blob/main/src/model.rs
* MiniLM reranker artifact:
  https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2
* Jina tiny reranker artifact:
  https://huggingface.co/jinaai/jina-reranker-v1-tiny-en
