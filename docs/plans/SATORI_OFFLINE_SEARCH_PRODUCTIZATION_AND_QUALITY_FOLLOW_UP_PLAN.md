# Satori Offline Search Productization and Quality Follow-up Plan

**Status:** the direct paired Potion/Voyage retrieval comparison is complete;
Linux x64 Track A productization and the Potion default for new offline
installations are authorized and implemented; Track A0.1 and Tracks B--F remain
conditional

**Date:** 2026-07-19

**Entry condition:** each track has its own authority. Lean L4 directly compared
the two existing publications and recorded
`direct_relevance_useful_with_observed_java_and_configuration_gaps`. The user
subsequently authorized Linux x64 productization and the new-offline default.
That decision does not activate Track A0.1 or Tracks B--F.

This plan owns work deliberately excluded from lean qualification. Each track
has its own trigger, decision, and stopping condition. A track may begin only
under separate execution authorization.

The completed direct comparison queried the same 36-task authority against the
existing Potion and Voyage publications without an agent or judge. On the 30
tasks with a required owner, Potion placed the owner file in the top five on
23 tasks and Voyage on 25; paired owner rank favored Potion on 3 tasks, Voyage
on 11, and tied on 16. Potion's main gap was Java (`2/5` top-five owner
reachability versus Voyage's `4/5`); configuration/runtime top-one reachability
was also lower (`1/6` versus `4/6`). This supports Potion as a useful offline
first-stage baseline while requiring both observed limitations to remain
explicit. It does not establish agent-answer or negative-answer behavior.

---

## Track A0 — Linux x64 managed Potion productization

**Authority:** authorized and implemented for the existing managed installer.
This is bounded Linux x64 support; it is not a multi-platform quality claim.

### A0 public configuration contract

The existing offline runtime selection is the public entry point:

```text
satori-cli install --runtime offline
```

For a new Linux x64 offline installation with no model override, the installer
selects Potion. `--ollama-model <model>` explicitly selects the existing Ollama
path. Reinstalling an installer-owned Ollama configuration without a new model
retains Ollama; it is never silently migrated to Potion. The runtime profile
remains `offline`, and the existing `default | minimal | all-text` index profiles
are unchanged.

The Potion selection expands to the ordinary runtime configuration below:

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

Preflight rejects conflicting provider, model, or dimension state instead of
silently overriding it. An explicit Ollama model is the supported provider
override. Existing installer-owned Ollama identity is preserved.

### A0 platform and artifact lifecycle

Initial support is exactly Linux x64. Other platforms fail during preflight with
guidance to select Ollama explicitly. The exact qualified helper, model,
tokenizer, configuration, model card, dependency license, file sizes, and
SHA-256 checksums ship inside the managed MCP package. The package manifest pins
the model revision, helper source revision, model2vec-rs revision, Rust
toolchain, target, features, and inference-contract digest.

The existing managed-runtime candidate lifecycle remains the activation owner:
the package candidate is installed outside the active generation, its LanceDB
runtime and Potion closure are verified, and only then is the stable launcher
switched. Failure leaves the previous launcher target unchanged. npm normalizes
non-bin package files to mode 0644, so preflight restores only the owner's
execute bit after the helper bytes pass checksum verification. The MCP package
continues to expose only its established `satori` binary.

No Rust toolchain or separate runtime model fetch is required on the end-user
machine; the model arrives inside the managed package. After installation,
Potion embedding and Satori runtime telemetry make zero network requests. Source
content is never part of installation traffic, manifests, diagnostics, or logs.
A0 changes no ranking, disclosure, freshness, or existing publication.

### A0 experimental performance disposition

Preserve the original L3 resource failure unchanged. The later checksum-sealed
qualification at `c6511bb` separately recorded `delta_publication_pass` under
the prospective one-second add/edit/delete, 1.5-second rename, and 500 ms warm
search gates. This later result supersedes the intermediate prospective latency
misses; it does not revise the original L3 thresholds or reinterpret L3 as
passing.

**Exit:** on Linux x64, the managed offline installation is reproducible,
checksum-verified, reversible before launcher activation, and usable without an
end-user development toolchain. Explicit and existing managed Ollama
installations remain Ollama. The historical resource evidence remains separate.

---

## Track A0.1 — additional experimental platforms

**Trigger:** the Linux x64 A0 lifecycle passes and a platform-specific
qualification is separately authorized. This track expands experimental
installer coverage only. It does not authorize default, recommended, or GA
promotion for the candidate platform.

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
`--runtime offline` support and does not extend the Linux x64 default decision
to another platform automatically.

---

## Track A1 — default or recommended promotion

**Trigger:** satisfied by the accepted direct retrieval result, the bounded
Linux x64 lifecycle, and the user's explicit promotion decision. The promotion
claim remains narrow: Potion is the default dense provider for a **new Linux x64
offline installation**. The CLI's general install default remains the connected
Voyage runtime.

The implementation rules are:

* `install --runtime offline` with no model override selects Potion;
* `install --runtime offline --ollama-model <model>` selects Ollama;
* reinstalling an existing managed Ollama configuration preserves Ollama;
* conflicting ambient provider/model/dimension values fail rather than silently
  overriding the selected contract;
* unsupported platforms receive an explicit Ollama fallback instruction; and
* no existing publication or installation is automatically migrated.

The promotion does not claim Potion matches Voyage, does not erase the observed
Java and configuration/runtime gaps, and does not establish agent-answer or
negative-answer quality. Any platform beyond Linux x64 still requires a passing
A0.1 decision. Broader quality claims still require the separately triggered
Track B.

**Exit:** the new-offline default, explicit Ollama override, existing-Ollama
preservation, immutable bundled identity, and unsupported-platform failure are
implemented and pass focused installer, runtime, and package checks.

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
direct L4 retrieval-relevance comparison accepted
    -> package and checksum-verify the pinned Linux x64 Potion runtime
    -> make Potion the default for new Linux x64 offline installations
    -> preserve explicit and existing managed Ollama installations
    -> keep the general connected Voyage install default unchanged

separately authorized A0.1 platform candidate
    -> evaluate one candidate in the fixed order
    -> add only a passing candidate to experimental support
    -> do not extend the default decision automatically

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

The direct lean L4 comparison and Linux x64 Track A implementation are complete.
Track A0.1 and Tracks B--F may run only when their triggers are demonstrated and
they receive their required authority. Track order does not grant authority, and
no track is a prerequisite merely because it appears in this document.

The comprehensive offline plan that preceded this split remains historical
source material in version control. It is not an active execution sequence.
