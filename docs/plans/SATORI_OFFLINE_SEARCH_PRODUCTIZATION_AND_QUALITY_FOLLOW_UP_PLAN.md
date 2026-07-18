# Satori Offline Search Productization and Quality Follow-up Plan

**Status:** proposed planning-only conditional follow-up; no track is active

**Date:** 2026-07-18

**Entry condition:** consider this document only after
`SATORI_POTION_OFFLINE_EMBEDDING_LEAN_QUALIFICATION_PLAN.md` reaches a recorded
decision. Passing lean qualification does not automatically authorize any
track.

This plan owns work deliberately excluded from lean qualification. Each track
has its own trigger, decision, and stopping condition. A track may begin only
under separate execution authorization.

---

## Track A — productization

**Trigger:** Potion passes the lean answer-quality, Satori-runtime-offline,
publication, lifecycle, and resource gates, and Satori intends to offer it as a
supported configuration.

Scope:

* `offline_lite` preset expansion;
* user-facing provider selection and reversibility;
* immutable Potion model/helper installation using reusable managed-runtime
  seams where practical;
* atomic activation and rollback;
* connected installation manifest;
* air-gapped bundle;
* supported-platform matrix;
* packaging that does not require end-user Rust;
* checksums, licenses, notices, and SBOM;
* install, restart, corrupt-artifact, upgrade, downgrade, and uninstall tests;
* disk, memory, privacy, and quality disclosures; and
* multiple-repository qualification.

The supported installer owns pinned artifact retrieval, verification, atomic
activation, and rollback. Source content is never sent during installation;
installation and runtime telemetry remain disabled for the offline
configuration.

This track may not change search ranking, disclosure, or freshness semantics.

**Exit:** the supported `offline_lite` installation is reproducible,
reversible, checksummed, license-complete, and qualified on its declared
platforms without requiring a development toolchain.

---

## Track B — expanded release qualification

**Trigger:** the lean 36-task result passes and the intended release claim
requires broader evidence than the lean suite supplies.

Scope:

* expand to a checksum-sealed 90-task, six-language suite;
* maintain tuning and held-out splits;
* add exact language and task-class accounting;
* use blinded judging and consolidated human adjudication;
* report paired task-level results;
* use bootstrap intervals only as supporting analysis;
* preserve hard integer safety gates;
* qualify the operating systems and CPU classes declared by Track A; and
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

Reuse the exact frozen production candidate arms and diagnostic superset
captured by the lean L4 authority. Do not substitute fixed BM25 or Potion depths
and do not rerun retrieval at altered depths. This experiment must not change
production ranking or retrieval depth.

Reconstruct candidate text from the frozen source revision and require the
source-projection digest captured by L4 to match before encoding. Do not store a
second source-text copy in Track C evidence.

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
lean qualification passes
    -> Track A productization, when a supported configuration is intended
    -> Track B expanded release qualification, when the release claim requires it

Potion candidate recall passes but post-retrieval exposure loses answers
    -> preserve the lean candidate authority
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

Tracks may run only when their trigger is demonstrated. Track order does not
grant authority, and no track is a prerequisite merely because it appears in
this document.

The comprehensive offline plan that preceded this split remains historical
source material in version control. It is not an active execution sequence.
