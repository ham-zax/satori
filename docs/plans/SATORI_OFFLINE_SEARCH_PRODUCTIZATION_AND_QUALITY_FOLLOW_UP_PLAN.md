# Satori Offline Search Productization and Quality Follow-up Plan

**Status:** the direct paired Potion/Voyage retrieval comparison is complete;
Track A0 is authorized for opt-in Linux x64 experimental productization; Track
A0.1, Track A1 implementation, and Tracks B--F remain conditional

**Date:** 2026-07-19

**Entry condition:** each track has its own authority. Track A0 may proceed
under the explicit authorization recorded here. Lean L4 directly compared the
two existing publications and recorded `direct_relevance_useful_with_java_gap`.
That result does not activate Track A0.1, Track A1 implementation, or Tracks
B--F.

This plan owns work deliberately excluded from lean qualification. Each track
has its own trigger, decision, and stopping condition. A track may begin only
under separate execution authorization.

The completed direct comparison queried the same 36-task authority against the
existing Potion and Voyage publications without an agent or judge. On the 30
tasks with a required owner, Potion placed the owner file in the top five on
23 tasks and Voyage on 25; paired owner rank favored Potion on 3 tasks, Voyage
on 11, and tied on 16. Potion's main gap was Java (`2/5` top-five owner
reachability versus Voyage's `4/5`). This supports Potion as a useful offline
first-stage baseline while requiring the Java limitation to remain explicit.
It does not establish agent-answer or negative-answer behavior.

---

## Track A0 — opt-in experimental productization

**Authority:** authorized now. This authorization covers an explicit Linux x64
experimental installation path. It does not represent an L4 quality pass, a
default change, a recommendation, or GA support.

### A0 public configuration contract

Add one public CLI selection:

```text
--offline-lite
```

The option is explicit and mutually exclusive with `--offline` and connected
runtime selection. Existing `--offline` behavior remains the existing Ollama
installation path. Do not migrate an installation, infer Potion from available
artifacts, or change a provider because Potion happens to be installed.

`--offline-lite` is an installer preset, not a new value of
`SATORI_RUNTIME_PROFILE` and not an index profile. It expands to the ordinary
runtime configuration below:

```text
SATORI_RUNTIME_PROFILE=offline
VECTOR_STORE_PROVIDER=LanceDB
LANCEDB_PATH=<the installer's existing managed absolute LanceDB path>
EMBEDDING_PROVIDER=Potion
EMBEDDING_MODEL=minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b
EMBEDDING_OUTPUT_DIMENSION=256
POTION_HELPER_PATH=<managed absolute helper path>
POTION_MODEL_PATH=<managed absolute model-bundle path>
POTION_REQUEST_TIMEOUT_MS=5000
```

The model identity and its
`bfda80d97aeb585e20650b1c54e9063a65068ce284317f0e0a812e20964dcee7`
inference-contract digest come from the already-qualified L0/L1 authority. The
installer manifest carries the pinned helper, model, tokenizer, configuration,
license, file-size, and SHA-256 authorities; it must not substitute a mutable
model name or download a newer revision. Runtime bootstrap derives and verifies
the inference-contract digest rather than accepting a user-selected digest.

Preflight must reject conflicting selection-defining CLI, environment, or
persisted configuration. The error identifies the conflicting field, its
observed value, and the value required by `--offline-lite`, with guidance to
remove the conflict or choose the existing `--offline` path. Agreeing explicit
values may be retained. A separately configurable, valid request timeout is an
operational override, not a provider-identity conflict.

### A0 platform and artifact lifecycle

Initial support is exactly Linux x64. Preflight checks the operating system and
architecture before downloading, extracting, or changing active configuration.
Every other platform fails with an actionable unsupported-platform error and
leaves the existing installation unchanged. A0 makes no portability claim and
does not require Rust or another development toolchain on the end-user machine.

Implement only the Potion-specific managed lifecycle, reusing existing managed
runtime seams where they fit:

* a network-assisted artifact manifest with immutable URLs, sizes, SHA-256
  checksums, target identity, license, and required notices;
* an air-gapped bundle containing the same manifest and complete artifact
  closure;
* download or import into task-owned candidate storage;
* checksum and completeness verification before activation;
* atomic activation only after the complete candidate passes validation;
* rollback that preserves the previously active installation after download,
  verification, extraction, configuration, or activation failure;
* idempotent reinstall plus restart, corrupt-artifact, upgrade, downgrade, and
  uninstall coverage; and
* uninstall behavior that removes only installer-owned artifacts and
  configuration, not user indexes or repository state.

Air-gapped installation must perform no network request. After installation,
Potion embedding and Satori runtime telemetry make zero network requests.
Source content is never part of installation traffic, manifests, diagnostics,
or logs.

The CLI help and installation result label `--offline-lite` experimental and
opt-in. A0 may not change ranking, disclosure, freshness, default-provider, or
automatic-migration behavior.

### A0 experimental performance disposition

Preserve the original L3 resource failure and the later prospective latency
misses unchanged. The one-second warm add/edit/delete target and 1.5-second
rename target remain performance goals, not A0 installation blockers.

For the experimental-release decision, report the observed approximately
three-second changed-file publication separately from installation correctness.
It may be accepted for A0 only when atomic publication remains proven, the
previous complete generation stays searchable while the replacement is being
prepared, freshness/status does not claim the replacement is active early, and
the measured delay is disclosed as an experimental limitation. Otherwise A0
records a lifecycle or correctness failure. Do not revise the frozen threshold
or reinterpret the original L3 result as passing.

**Exit:** on Linux x64, both network-assisted and air-gapped `--offline-lite`
installation are reproducible, checksum-verified, reversible, license-complete,
and exercised through the bounded lifecycle above without an end-user
development toolchain. Existing `--offline` Ollama installation remains
unchanged. Record the experimental performance disposition separately.

---

## Track A0.1 — additional experimental platforms

**Trigger:** the Linux x64 A0 lifecycle passes and a platform-specific
qualification is separately authorized. This track expands experimental
installer coverage only. It does not authorize default, recommended, or GA
promotion.

A platform becomes experimentally supported only when all of these are true:

* it has a pinned helper and model-bundle manifest;
* its OS, architecture, ABI, and CPU requirements are explicit;
* both network-assisted and air-gapped installation pass;
* checksum verification, rollback, restart, upgrade, and uninstall coverage
  pass;
* a network-blocked embedding and runtime test records zero attempted runtime
  requests; and
* installation and runtime require no end-user compiler or development
  toolchain.

Evaluate candidates in this order:

1. Windows through WSL2;
2. native Windows x64;
3. macOS arm64; and
4. macOS x64.

Each candidate has its own manifest, runtime closure, evidence, and support
decision. Passing one candidate does not establish compatibility for another,
and the ordering does not itself authorize implementation. Unsupported or
unqualified platforms continue to fail during preflight before installation
state changes.

For WSL2, qualify the complete Windows-host-to-WSL2 user path while treating the
helper as a pinned Linux guest artifact; do not describe that result as native
Windows support. Native Windows and each macOS architecture require their own
helper authority rather than reusing the Linux x64 manifest.

Reuse the A0 installer lifecycle and manifest shape where applicable. Do not
build a general native-runtime platform framework solely for these candidates.

**Exit:** record a separate experimental support or rejection decision for the
authorized candidate. Its pass adds only that platform to experimental
`--offline-lite` support and does not activate A1.

---

## Track A1 — default or recommended promotion

**Trigger:** the direct L4 relevance result remains accepted with its Java
limitation disclosed; the A0 lifecycle passes for every platform included in
the intended release claim; and a separate product decision authorizes
promotion. Agent-answer or negative-answer evidence is required only when the
intended release claim explicitly makes those claims.

A0 does not authorize A1. Until A1 passes:

* do not change any default;
* do not recommend Potion as the general offline choice;
* do not migrate existing Ollama or manually configured Potion installations;
* do not promote any A0.1 platform beyond its separately proven experimental
  support; and
* do not describe `--offline-lite` as GA or fully supported.

A1 owns the exact new-install recommendation or default decision, release
documentation and disclosures, complete licenses/notices/SBOM, release-candidate
upgrade/downgrade/uninstall evidence, and multiple-repository qualification.
Any platform beyond Linux x64 requires a passing A0.1 decision before it may
enter an A1 release claim. If the intended release claim requires broader
answer-quality evidence, Track B must also pass; A1 does not implicitly
authorize Track B.

The existing explicit `--offline` Ollama behavior and the prohibition on
automatic migration remain compatibility contracts even if `--offline-lite`
later becomes the recommended path for new installations. Any proposal to
change those contracts requires separate authority.

**Exit:** approve or reject default/recommended promotion under the direct L4
retrieval result and release-lifecycle evidence. A1 may not reinterpret an A0
experimental pass as release evidence.

---

## Track B — expanded release qualification

**Trigger:** the intended release claim requires fresh agent-answer,
negative-answer, multi-repository, or broader platform evidence that the direct
lean retrieval comparison does not supply.

Scope:

* expand to a checksum-sealed 90-task, six-language suite;
* maintain tuning and held-out splits;
* add exact language and task-class accounting;
* use blinded judging and consolidated human adjudication;
* report paired task-level results;
* use bootstrap intervals only as supporting analysis;
* preserve hard integer safety gates;
* qualify the operating systems and CPU classes claimed for the Track A1
  release; and
* run the complete release-candidate installer and publication flow.

The 90 tasks use exactly 30 tuning and 60 held-out tasks. Each task has one
primary language and class. The manifest freezes repositories, revisions,
owners, acceptable evidence, answer facts, criticality, agent and judge
identity, disclosure path, hardware, publications, and integer gates before
contender output is visible.

The expanded suite validates a release candidate. It must not become a
mechanism for repeatedly tuning against held-out failures.

**Exit:** the release claim is either supported by the frozen 90-task result or
rejected without revising held-out tasks or gates.

---

## Track C — late-interaction or reranking improvement

**Trigger:** Potion passes candidate-owner recall, but expected owners are lost
or poorly exposed after retrieval.

First localize the responsible stage:

```text
grouping or disclosure loss
-> correct grouping or disclosure

fusion or deterministic-ranking loss
-> test a bounded deterministic correction

semantic ordering remains responsible
-> admit a second-stage model experiment
```

A neural scorer must not disguise a grouping or disclosure defect. Any shared
Core/MCP fusion, admission, grouping, ranking, or disclosure change requires
focused Milvus non-regression evidence for the changed boundary. A LateOn-only
adapter that leaves those shared paths unchanged does not require Milvus
requalification.

### C0 — LateOn artifact and runtime conformance

Public artifacts exist for `lightonai/LateOn-Code-edge` and
`lightonai/LateOn-Code-edge-pretrain`. No checkpoint is admitted until its
exact revision, files, checksums, tokenizer behavior, ONNX output contract,
MaxSim implementation, and reference conformance are frozen. Record the pinned
Apache-2.0 license and required notices as routine artifact provenance.

When Track C's semantic-ordering trigger is satisfied, LateOn edge is the first
conditional second-stage candidate. It is not part of the offline first-stage
baseline.

The default checkpoint is:

```text
lightonai/LateOn-Code-edge
```

Use the pre-trained checkpoint instead only if contamination analysis shows
that the fine-tuned checkpoint's CoIR training data overlaps the frozen Satori
evaluation repositories or tasks. CoIR training is not itself leakage when the
evaluation repositories and tasks are disjoint. Do not score both checkpoints
and choose retrospectively.

The proposal-time public description reports Apache-2.0 licensing,
48-dimensional token vectors, MaxSim scoring, a 2048-token document limit, and
a 256-token query limit. The repository currently exposes FP32 ONNX and
safetensors files plus an approximately 17.2 MB INT8 ONNX file and 3.58 MB
tokenizer. These mutable observations are discovery evidence only; C0 replaces
them with an exact revision and file hashes.

Freeze:

* repository revision and every required file hash;
* tokenizer and special-token behavior;
* query/document distinction;
* query and document limits;
* output shape and runtime dtype;
* token masking and pruning;
* normalization;
* exact MaxSim reduction;
* ONNX Runtime version and target;
* model load, model-related RSS, and warm latency; and
* reference query vectors, document vectors, masks, and scores from the pinned
  official PyLate path.

Hash the canonical artifact, runtime, and inference contract as the
`lateOnContractDigest`. The Satori runtime must reproduce the pinned PyLate
vectors, masks, and scores within a checksum-sealed numerical tolerance. Python
may create reference evidence but must not become a Satori runtime dependency.

Do not assume that the INT8 ONNX file emits INT8 token vectors. Quantized model
weights may still produce FP32 output; measure and freeze the actual output
dtype.

LightOn's NextPlaid/ColGrep implementation is a Rust/ONNX reference and possible
bounded component. It does not replace Satori's chunks, primary retrieval,
publication identity, freshness, grouping, or disclosure authority.

Authority used to start C0:

* model card and comparison:
  https://huggingface.co/lightonai/LateOn-Code-edge
* artifact files:
  https://huggingface.co/lightonai/LateOn-Code-edge/tree/main
* pre-trained checkpoint:
  https://huggingface.co/lightonai/LateOn-Code-edge-pretrain
* Rust/ONNX multi-vector reference:
  https://github.com/lightonai/next-plaid

**Exit:** exactly one checkpoint and native runtime pass artifact provenance,
shape, mask, vector, MaxSim, determinism, and resource conformance. Otherwise
close Track C without scoring Satori tasks.

### C1 — query-time scoring prototype

At the start of C1, capture one candidate union from the exact production
candidate arms and depths then active. Reuse that identical captured union for
all C1 arms. Do not substitute arbitrary fixed BM25 or Potion depths, rerun
retrieval differently for a contender, or change production ranking.

Record the source revision and source-projection digest with that C1 capture.
Reconstruct candidate text from the recorded source revision and require the
digest to match before encoding. Do not store a second source-text copy in
Track C evidence.

Compare only:

| Arm | Second stage |
| --- | ------------ |
| B | Baseline ordering |
| B-L16 | LateOn scores at most 16 eligible candidates |
| B-L32 | LateOn scores at most 32 eligible candidates |

Rules:

* Candidate membership is identical across all three arms.
* Mandatory exact/path/configuration evidence remains pinned and cannot be
  displaced below required disclosure.
* LateOn changes only eligible semantic ordering.
* Canonical per-file, per-owner, and repository-region diversity is applied
  before selecting eligible candidates.
* Dense, lexical, and exact provenance remains attached to every candidate.
* The unscored tail retains baseline relative order.
* Candidate text uses the frozen Satori source projection.
* One query embedding is reused across all candidate scoring for that query.
* LateOn semantic order passes through Satori's unchanged grouping and
  diversity stages; their resulting final ranked result set is frozen before
  initial disclosure.
* `continue_search` performs no encoding or scoring; it exposes more of the
  frozen result set.
* Load failure, timeout, malformed output, out-of-memory failure, or explicit
  disablement returns the byte-equivalent baseline result.

Measure cold and warm operation separately:

* query encoding;
* candidate-document encoding;
* MaxSim scoring;
* end-to-end total latency;
* peak model-related and total RSS;
* retained token-vector count and bytes per candidate; and
* answer corrections, regressions, and candidate-owner recall.

Do not change LanceDB schema, publication identity, incremental indexing,
chunk lifecycle, sidecar recovery, primary retrieval, or Milvus behavior in C1.

### C2 — bounded experimental cache

Only if C1 passes the net-positive qualification gate, add an in-memory LRU
keyed by:

```text
lateOnContractDigest
+ candidate ID
+ exact source-projection digest
```

The cache is experimental and non-authoritative:

* missing entries are recomputed;
* invalid or mismatched entries are discarded;
* it cannot affect source freshness or candidate membership;
* entry count, bytes, TTL, and LRU behavior are bounded; and
* cold-cache and warm-cache latency are reported separately.

If any candidate required by the selected LateOn policy cannot be loaded or
encoded within the deadline, discard all LateOn scores for that query and return
the complete byte-equivalent baseline ordering. Never partially rerank from
whichever cache entries happened to exist.

### C3 — persisted sidecar

Admit a persisted multi-vector sidecar only when all of these are true:

* C1 passes the net-positive qualification gate;
* candidate-document encoding materially harms search latency;
* observed token-vector count and storage are acceptable;
* incremental invalidation is proven against Satori chunk identity and exact
  source-projection digest; and
* missing or corrupt sidecar state safely returns the byte-equivalent baseline
  result.

If any candidate required by the selected LateOn policy cannot be loaded or
encoded within the deadline, discard all LateOn scores for that query and return
the complete byte-equivalent baseline ordering. Never partially rerank from the
subset available in the sidecar or cache.

The sidecar is optional derived ranking acceleration. It is not source,
freshness, primary retrieval, or LanceDB publication authority. Missing entries
are recomputed within the all-or-nothing deadline; sidecar state never makes the
primary publication unsearchable. The `lateOnContractDigest` enters ranking and
evaluation identity.

If runtime output is FP32, each retained token vector costs at least:

```text
48 dimensions x 4 bytes = 192 bytes
```

For illustration only:

```text
128 retained tokens per chunk ~= 24.6 KB per chunk
10,000 chunks ~= 246 MB before metadata and index overhead
```

These are warnings, not predictions. C1 must measure the actual output dtype,
retained-token distribution, bytes per encoded chunk, and runtime pruning
before C3 can estimate or gate sidecar storage.

### C4 — cross-encoder fallback

Consider a small MiniLM or Jina ONNX cross-encoder only if:

* LateOn is unavailable, operationally unsuitable, or ineffective; and
* evidence still proves a post-retrieval semantic-ordering problem.

Do not test LateOn plus multiple cross-encoders simultaneously. A fallback
experiment requires its own checksum-sealed artifact, runtime, input, scoring,
latency, memory, and admission contract.

### Track C qualification rule

The revealed 36-task Potion suite may decide whether LateOn deserves further
engineering. Once used to design or select C0–C3, it is diagnostic evidence and
cannot become fresh held-out evidence.

The C1 prototype may continue only if one of these quality conditions holds:

* it fixes at least two previously incorrect answers; or
* it removes at least one hard miss.

It must also satisfy all of these:

* total correct-answer count is at least one higher than baseline Arm B;
* introduce no critical, exact-identifier, path, or configuration regression;
* preserve mandatory exact/path/configuration evidence;
* preserve candidate membership and candidate-owner recall;
* remain deterministic for identical fixed candidates; and
* remain within the checksum-sealed latency and memory envelope.

Passing this gate authorizes at most C2 or C3 investigation; it does not
authorize production. Production admission requires a new checksum-sealed
held-out evaluation, normally under Track B expanded release qualification.

**Exit:** stop unless C1 produces net-positive Satori answer evidence under the
frozen gate. Persist token vectors only when quality passes and measured
document encoding makes persistence decision-relevant. Otherwise retain the
Potion + BM25 + exact baseline.

---

## Track D — Semble diagnostic comparison

**Trigger:** Satori's Potion hybrid misses owners or answers that a lightweight
external system may plausibly recover, and that comparison could change the
responsible Satori owner or next decision.

Scope:

* pin one Semble revision and the model it actually loads;
* run it against the same repository revisions and tasks;
* report it as a separate full-stack diagnostic;
* do not treat it as an embedding-only comparison;
* localize any gain to chunking, lexical enrichment, dense retrieval, ranking,
  grouping, or disclosure; and
* port only the responsible idea when it fits Satori's backend-neutral and
  publication-aware architecture.

Semble's own chunking, storage, freshness, ranking, and disclosure remain
separate from Satori authority. A full Semble-engine adapter requires a separate
architectural RFC.

**Exit:** the comparison identifies a causal, decision-relevant difference or
closes without a Satori change.

---

## Track E — freshness improvements

**Trigger:** Potion's measured speed materially changes the feasible freshness
experience and the independent freshness authority approves investigation of a
semantic change.

Scope remains owned by `INCREMENTAL_INDEX_FRESHNESS_PLAN.md`:

* dirty epochs;
* adaptive coalescing;
* search joining a required update;
* maximum publication delay;
* continuous-edit behavior; and
* honest freshness reporting.

Do not couple freshness redesign to the Potion provider or productization
merge.

**Exit:** the freshness plan accepts or rejects its own change under its own
publication and recovery evidence.

---

## Track F — alternative local embeddings

**Trigger:** Potion fails because critical expected owners are absent before
reranking, or it materially exceeds the resource envelope.

First produce a bounded failure analysis identifying whether the cause is:

* model representation;
* document projection;
* lexical recall;
* fusion;
* unsupported-language behavior; or
* runtime/resource cost.

Selecting CodeRankEmbed, CodeSage, or another model requires a new
checksum-sealed proposal with:

* artifact and license review;
* native runtime and resource analysis;
* a new embedding inference-contract digest and publication fingerprint;
* a fresh publication; and
* focused comparison against the failed Potion cases.

Do not automatically begin an open-ended model tournament. A new model is
decision-relevant only when the Potion failure analysis identifies a model or
resource boundary that the candidate could plausibly change.

**Exit:** approve one bounded candidate proposal or close local-model selection
without implementation.

---

## Program order

```text
A0 explicit authorization
    -> implement opt-in Linux x64 --offline-lite installation lifecycle
    -> retain Ollama --offline behavior and every existing default

separately authorized A0.1 platform candidate
    -> evaluate one candidate in the fixed order
    -> add only a passing candidate to experimental support
    -> retain every existing default

direct L4 retrieval-relevance comparison
    -> query the existing Potion and Voyage publications with identical inputs
    -> compare required-owner ranks without an agent or judge layer
    -> record the Java gap and keep negative-answer claims out of scope

direct L4 result is accepted and A0 release-lifecycle evidence passes
    -> consider Track A1 under a separate promotion decision
    -> Track B only when the intended claim requires evidence L4 did not measure

Potion candidate recall passes but post-retrieval exposure loses answers
    -> capture the current production candidate union once for C1
    -> localize grouping, disclosure, fusion, ranking, or semantic ordering
    -> correct the deterministic owner when it is responsible
    -> C0 LateOn conformance only when semantic ordering remains responsible
    -> C1 B / B-L16 / B-L32 on the revealed diagnostic tasks
    -> stop if there is no material answer gain
    -> C2 cache or C3 sidecar only when its own trigger passes
    -> fresh Track B held-out evidence before production admission

Satori-specific quality remains causally unexplained
    -> Track D Semble diagnostic

freshness improvement is independently authorized
    -> Track E

Potion retrieval or resources fail
    -> Track F under a new proposal
```

Track A0 is the only active follow-up track. The direct lean L4 comparison is
complete. Track A0.1, Track A1 implementation, and Tracks B--F may run only when
their triggers are demonstrated and they receive their required authority.
Track order does not grant authority, and no track is a prerequisite merely
because it appears in this document.

The comprehensive offline plan that preceded this split remains historical
source material in version control. It is not an active execution sequence.
