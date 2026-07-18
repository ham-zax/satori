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

## Track C — local reranker

**Trigger:** lean evidence shows that expected owners survive candidate
admission, but scoring or ordering remains the first responsible boundary for
the answer loss.

If a retrieved owner is first lost through deterministic grouping or
disclosure, correct that responsible stage. Such a loss does not by itself
justify or trigger a neural reranker.

Before evaluating a model:

1. prove that the owner survives candidate admission and localize scoring or
   ordering as the first wrong boundary;
2. determine whether a bounded deterministic fusion or ranking correction
   resolves the demonstrated failures;
3. introduce a backend-neutral reranker interface only if a neural reranker
   remains justified; and
4. preserve Voyage's current behavior through that interface.

Then:

* freeze at most two small ONNX candidates;
* pin complete model, tokenizer, runtime, checksum, and license bundles;
* disallow Python, mutable remote code, and runtime code fetching;
* replay bounded candidate counts from identical frozen captures;
* preserve exact-evidence pinning and required path/symbol evidence;
* measure answer improvement, truncation, latency, RSS, and context;
* select at most one finalist from tuning tasks; and
* run it on held-out tasks only if it crosses the predeclared improvement gate.

Admission requires material answer value, such as removing a hard miss or
correcting several answer failures without introducing a new hard miss. The
exact integer rule must be checksum-sealed before candidate scores are visible.

A Potion-only reranker adapter that does not alter shared retrieval or ranking
behavior does not require Milvus requalification. Any shared Core/MCP fusion,
admission, grouping, ranking, or disclosure change requires focused Milvus
non-regression evidence for the changed boundary before admission.

If no candidate adds material value, retain `offline_lite` without a neural
reranker.

**Exit:** zero or one local reranker is admitted by the frozen rule; otherwise
the no-reranker path remains authoritative.

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

candidate recall passes but later ranking loses answers
    -> Track C local reranker

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
