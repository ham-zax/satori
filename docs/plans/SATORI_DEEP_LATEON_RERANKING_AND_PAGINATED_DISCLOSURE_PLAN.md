# Satori Deep LateOn Reranking and Paginated Disclosure Plan

**Status:** complete for every authorized track. Track P and Track I are
qualified; Track L is terminal with baseline `B` retained. Track O is terminal:
the O3 opening was consumed without a valid quality decision, so no held-out
quality authority was produced. Any future held-out evaluation and all
production activation remain closed.

**Date:** 2026-08-02

## 1. Outcome

Improve offline semantic-search ordering by letting LateOn evaluate a deeper,
owner-diverse candidate pool while letting an agent inspect every result in the
frozen ranked set through bounded pages.

The intended pipeline is:

```text
Potion dense retrieval + BM25 lexical retrieval
    -> adaptively sized first-stage arms/passes, maximum depth 80
    -> deduplicated frozen candidate union
    -> eligibility and authoritative evidence
    -> owner-family deduplication
    -> compact reranker projections
    -> selected LateOn candidate depth: 16, 32, or 50
    -> deterministic grouping and final order
    -> 10 full results initially
    -> optional compact title/path index
    -> continuation until the frozen set is exhausted
```

This plan separates four limits that the current capability contract partially
conflates:

| Limit | Meaning | Planned behavior |
| --- | --- | --- |
| Retrieval depth | Candidates requested from each first-stage arm/pass | Keep the existing maximum depth of 80 |
| Reranker depth | Eligible owner-diverse candidates scored by LateOn | Qualify 16, 32, and 50; select from evidence |
| Logical result-set request | How much of the frozen ranking the caller may eventually inspect | No performance-profile ceiling below the available frozen set |
| Disclosure page size | Full results returned in one response | Keep bounded; default to 10 and continue from the same frozen set |

Execution is split into three independent tracks:

```text
Track P  frozen result-set pagination
Track L  LateOn projection and depth qualification
Track I  optional compact result index
```

Track P may qualify even if every LateOn contender is rejected. Track I may be
rejected or deferred without blocking Track P or Track L. Each track requires
its own authority, receipt, and terminal outcome.

Current execution state:

| Track | State | Receipt or next boundary |
| --- | --- | --- |
| P — pagination | `pagination_complete_frozen_set_qualified` | `docs/evidence/deep-pagination-p2-20260802/P2_QUALIFICATION_RECEIPT.md` |
| L — LateOn | `baseline_b_retained` | `docs/evidence/deep-lateon-l3-20260804/L3_QUALIFICATION_RECEIPT.md` |
| I — compact result index | `compact_result_index_qualified` | `docs/evidence/deep-result-index-i2-20260804/I2_QUALIFICATION_RECEIPT.md` |
| O — offline operationalization | `D32 operationally qualified; held-out opening consumed without decision; disabled` | `docs/evidence/lateon-track-o-merge-qualification-20260804/MERGE_QUALIFICATION_RECEIPT.md`, `docs/evidence/lateon-track-o-portable-20260804/PORTABLE_EVIDENCE_RECEIPT.md`, and `docs/evidence/lateon-track-o-finalization-20260804/TRACK_O_CORRECTION_FINALIZATION_RECEIPT.md` |

The Track O merge-qualification receipt is the latest pre-merge integration
authority. The portable-evidence receipt is the latest portability authority,
and the evidence-correction finalization remains the decision authority. The
earlier O2 carry-forward and Track O closure receipts remain historical inputs
to that finalization.

“No limit on how much the agent can request” does not mean an unbounded response
or unbounded retrieval work. A caller may request the complete available frozen
set and page through it until exhaustion. Multiple bounded arms and semantic
passes may produce a deduplicated union larger than one arm's depth of 80.
Per-page response-byte, cache-byte, safe-integer, and expiry bounds remain
mandatory.

## 2. Current evidence authority

The current implementation has these independent facts:

```text
SEARCH_MAX_CANDIDATES             80 per first-stage request
SEARCH_RERANK_TOP_K               50
SEARCH_DEFAULT_DISCLOSURE_LIMIT   10
LateOn candidateDepth             16
slow-profile maximum request      15
```

The generic reranker path can construct a pool of up to 50 candidates, but the
runtime-qualified LateOn provider reports a maximum of 16 documents. The
offline Potion profile is also classified as slow, which currently prevents an
agent from requesting more than 15 results even though first-stage retrieval
may already have produced a larger frozen pool.

The completed cross-repository experiment remains the baseline authority:

```text
docs/plans/SATORI_CROSS_REPOSITORY_RANKING_ABLATION_PLAN.md
docs/evidence/lateon-runtime-profile-20260730/LATEON_RUNTIME_PROFILE_RECEIPT.md
```

The evidence must be interpreted narrowly:

| Arm | Previously observed quality | Authority |
| --- | --- | --- |
| `B` | Macro MRR `0.3602`, owner-at-three `0.3722` | Default qualified product ranking policy |
| `D-L16` projection v1 | Macro MRR `0.4011`, owner-at-three `0.4944` | Directional tuning quality; failed the frozen owner-at-three interval gate |
| `D-L32` projection v1 | Macro MRR `0.4174`, owner-at-three `0.4944`; MRR `+0.0163` over D-L16 | Previously observed diagnostic winner; failed the same frozen quality gate |
| Optimized D-L16 runtime | Reproduced the prior D-L16 scores and order | Runtime-qualified for optional isolated implementation, not quality-qualified as default policy |

The frozen R3 decision remains authoritative: neither D-L16 nor D-L32 passed
every quality gate, and `B` remains the default qualified ranking policy. The
later runtime receipt replaced the assumed resource envelope; it did not
replace the R3 quality decision.

The original D-L16/D-L32 resource failures were already observed, and the
optimized runtime receipt remeasured D-L16 only. L0 subsequently preregistered
the unopened D-L50 projection-v1 and projection-v2 arms before any new output
was inspected.

The completed L3 qualification now supersedes the earlier tuning-only status
for those new arms. All four passed every frozen quality gate; projection-v2 at
depth 32 was strongest on owner-at-three and MRR. None passed the frozen local
WSL CPU resource profile, so no contender was selected, held-out remained
sealed, and baseline `B` remains product policy. See
`docs/evidence/deep-lateon-l3-20260804/L3_QUALIFICATION_RECEIPT.md`.

That L3 terminal result applies only to the deployment profile frozen by L0. It
does not assert that D32 is unusable on the measured host or under every product
service class. A separate prospective operational authority may evaluate D32
without rewriting L3.

Metric provenance must remain explicit. The earlier three-family diagnostic
suite produced baseline MRR `0.3602` and owner-at-three `0.3722`. The later
six-family decision-bearing tuning suite produced baseline MRR `0.2900` and
owner-at-three `0.3611`, with projection-v2 D32 at MRR `0.5046` and
owner-at-three `0.6389`. These are different denominators and must not be
presented as measurements from one benchmark population.

## 3. Non-negotiable invariants

Every contender and implementation must preserve:

1. Candidate membership and eligibility are owned before neural reranking.
2. LateOn can reorder only admitted candidates; it cannot restore an owner that
   is absent from the frozen retrieval union.
3. Exact identifiers, `must:` controls, configuration ownership, source
   freshness, publication authority, scope filtering, and no-answer behavior
   remain deterministic and fail closed.
4. Candidate-family identity uses canonical owner evidence when available and
   never guesses ownership from a display label.
5. A LateOn timeout, crash, unavailable model, invalid response, or incomplete
   order restores the deterministic product result state: candidate
   membership, scores, relative order, grouping, and disclosure are
   byte-identical to the no-reranker baseline. The complete response need not
   be byte-identical because truthful `RERANKER_FAILED` warning and failure-phase
   diagnostics remain permitted.
6. Continuation performs no new embedding, retrieval, eligibility decision,
   grouping, or reranking.
7. Pagination exposes one immutable ranked set. It cannot mix pages from
   different publications, source observations, policy identities, or model
   executions.
8. Model weights remain in one verified shared directory outside versioned MCP
   runtime closures. This work must not recreate per-version model duplication.
9. No source code or model inputs enter telemetry.
10. No query-specific exceptions, repository-specific weights, or new blanket
    path constants are permitted.

Rerank application must be transactional. Validate the complete provider order
and compute every adjusted score on a detached candidate copy before committing
any score or rank to product state. Any failure discards the detached copy and
retains the untouched deterministic baseline while diagnostics record the
attempt.

## 4. Track P — frozen result-set pagination

Track P is deterministic product work and does not depend on LateOn admission.

### P0 — freeze the independent values and bounds

Before implementation, derive and freeze:

```text
requestedTotal
    caller's positive safe-integer request; not capped by performance profile

effectiveFrozenTotal
    groups actually retained in the immutable result set after applying the
    pipeline-derived MAX_FROZEN_RESULTS bound

retrievalDepth
    adaptive per first-stage arm/pass depth; maximum 80

rerankerDepth
    provider-qualified neural input depth; independent of pagination

pageSize
    groups disclosed in one response after applying MAX_PAGE_SIZE and the
    response-byte budget
```

Freeze the calculation exactly as:

```text
effectiveFrozenTotal = min(
    requestedTotal,
    availableGroupedResults,
    MAX_FROZEN_RESULTS
)
```

P0 must also freeze the separate bounds and their consumers:

| Bound/value | Required consumer |
| --- | --- |
| `requestedTotal` | `search_codebase` schema/handler only; positive safe integer, no performance-profile maximum |
| `effectiveFrozenTotal` | grouping finalization and result-set construction |
| `retrievalDepth` | `resolveSearchPolicy` and first-stage arm/pass requests |
| `rerankerDepth` | reranker selection, provider profile, worker protocol, and diagnostics |
| `MAX_FROZEN_RESULTS` | result-set construction, continuation cursor/offset validation, and cache admission |
| `MAX_PAGE_SIZE` | initial `disclosureLimit`, `continue_search.limit`, and page projection |
| `MAX_RESULT_SET_ENTRY_BYTES` | admission of one serialized frozen set plus its reserved maximum replay page |
| `MAX_RESULT_SET_CACHE_BYTES` | aggregate storage, eviction, and capacity accounting across every live handle |
| `MIN_RESIDENT_RESULT_SETS` | concurrency/lifecycle-derived minimum number of maximum-size entries the global cache must retain |
| grouped response-byte limits | initial disclosure, continuation pages, and optional compact-index admission |

The current `getMaxSearchLimit()` must no longer be reused for logical total,
page size, and cursor validation. Each consumer must use the bound it actually
owns.

`MAX_FROZEN_RESULTS` must be derived from the bounded arm/pass union,
deduplication, grouping, per-entry cache byte budget, and lifecycle—not from
`performanceProfile`. `MAX_PAGE_SIZE` must be derived from the grouped response
byte contract. P0 must ensure:

```text
MAX_RESULT_SET_ENTRY_BYTES < MAX_RESULT_SET_CACHE_BYTES

MAX_RESULT_SET_ENTRY_BYTES * MIN_RESIDENT_RESULT_SETS
    <= MAX_RESULT_SET_CACHE_BYTES
```

`MIN_RESIDENT_RESULT_SETS` must be derived from the frozen concurrency and
result-set lifecycle rather than selected to preserve the existing cache size.
P0 must record the exact numeric values, formulae, and policy identity before
P1 changes validation or observes new pagination results. P1 and P2 remain
closed until that P0 receipt exists.

### P1 — decouple request size from performance profile

The public search contract must stop using `performanceProfile` to reject a
logical request merely because it exceeds 10, 15, 20, 30, or 50 results.

Freeze a compatibility-preserving contract with these semantics:

```text
limit
    positive safe integer expressing the caller's desired total result set
    normalized to the number of results actually available from the frozen
    retrieval/grouping pipeline

disclosureLimit
    bounded number of full groups returned in the initial response
    defaults to 10

continue_search.limit
    bounded page size, not a total-result ceiling

continuation
    remains available until every group in the frozen set has been disclosed
```

The response must report the requested, effective, available, returned, and
remaining counts. A request larger than the available frozen set is satisfied
by exhausting that set rather than rejected by the embedding performance tier.

The first implementation may keep the existing adaptive first-stage policy
with maximum depth 80. It must report arm, pass, union, eligible, grouped,
frozen, disclosed, and remaining counts separately instead of implying either
an 80-result total ceiling or repository-wide recall.

### P1.1 — bind the immutable ranked set

Extend the frozen result-set contract with:

```text
rankedSetDigest
queryPolicyDigest
rankingPolicyIdentity
disclosurePolicyVersion
publication identity
prepared/source observation identities
reranker provider/model/profile identity, or deterministic-baseline identity
reranker projection identity, or not_applicable
ordered canonical group records:
    canonical group identity
    canonical pageable-group projection digest
```

Compute `rankedSetDigest` from a canonical serialization of every field above,
including the complete ordered group-record sequence. Each group-projection
digest must cover the exact cached target, score components, evidence,
navigation metadata, and recommended action that continuation can disclose.
It excludes only explicitly non-pageable request diagnostics. Store the ranked
set digest with the cached set, publish it in the initial continuation contract,
and echo it on every page. The existing `queryPolicyDigest` becomes an input to
this binding; it must not remain computed-but-unconsumed metadata.

The digest identifies one frozen search-result instance. Independent cold and
warm executions may have different digests when their pageable diagnostics,
such as request-time graph validation evidence, differ. Qualification compares
candidate traces, ranked result identities, and disclosure order across those
executions; it requires digest equality only between the initial response and
continuations of the same frozen instance.

Continuation must revalidate publication and source observations as it does
today, verify the cached binding before projecting a page, and remove the
handle on any digest or identity mismatch. A page never adopts a later runtime
model, projection, ranking policy, or disclosure policy.

### P1.2 — define cache admission failure

Enforce `MAX_RESULT_SET_ENTRY_BYTES` independently from the global cache
capacity. Reserve within that per-entry bound enough bytes for the frozen set
plus one maximum-size replay page. Construct `effectiveFrozenTotal` from final
rank order so the complete retained set is cache-admissible before issuing a
handle. Global admission and eviction then use `MAX_RESULT_SET_CACHE_BYTES`
without allowing one valid entry to consume the entire cache. If the configured
count bound and actual serialized bytes disagree:

```text
do not create a continuation handle
return the valid initial result page
publish SEARCH_RESULT_SET_NOT_CACHE_ADMISSIBLE
report available, frozen, returned, and omitted counts
recommend a new narrower search
```

Do not throw away an otherwise valid initial search response, fabricate a
handle, silently drop tail results, or persist a set that cannot retain one
idempotent replay page. P0/P2 qualification fails until every maximum-shape
fixture is cache-admissible under the frozen bounds.

### P2 — qualify frozen continuation

Qualify complete traversal independently with LateOn disabled. Require every
frozen group to appear exactly once, in final order, with no new retrieval,
eligibility, grouping, or ranking work. Expiry, eviction, server-owner shutdown,
wrong offsets, retries, and response-byte truncation must fail explicitly and
must never create a replacement ranking under the old handle.

Track P terminal outcomes are:

```text
pagination_complete_frozen_set_qualified
pagination_bound_derivation_blocked
pagination_identity_or_order_rejected
```

## 5. Track I — optional compact result index

Track I begins with an I0 public-contract receipt. No implementation begins
until it freezes:

```text
search_codebase input
    includeResultIndex?: boolean
    valid only for grouped results; default false

initial grouped response
    resultIndex.contractVersion
    resultIndex.rankedSetDigest
    resultIndex.disclosurePolicyVersion
    resultIndex.availableEntryCount
    resultIndex.returnedEntryCount
    resultIndex.complete
    resultIndex.entries

continuation response
    echoes rankedSetDigest but does not repeat the complete index
```

Evaluate an optional compact index generated from the final frozen order. Each
entry may contain only:

```text
rank
canonical final-group identity
display label
repository-relative path
symbol or file kind
one bounded reason/evidence label
```

It must not contain source excerpts, model scores, internal filesystem paths,
or a separately computed order. Its byte budget and truncation state must be
explicit. The index is navigation assistance; normal full results and
`read_file` remain the evidence surface.

I0 must freeze `MAX_RESULT_INDEX_ENTRIES` and `MAX_RESULT_INDEX_BYTES`. Both are
independent from `MAX_PAGE_SIZE` but count toward the initial grouped response
byte budget. Entries must be the exact prefix of the final frozen group order.
If the requested index cannot fit, return its bounded prefix with
`complete=false` and truthful counts; never remove full result groups to make
room for the optional index. Every index identity must resolve to exactly one
full group in the same ranked set, whether that group appears initially or
through continuation.

The I0 authority narrowed qualification to the bounded opt-in contract and did
not authorize an agent-utility claim. Track I therefore qualifies only the
index's ordering, identity, byte, continuation, and fail-closed invariants;
production activation remains a separate closed decision.

Track I is independently terminal:

```text
compact_result_index_qualified
compact_result_index_rejected
compact_result_index_deferred
```

## 6. Track L — owner-diverse LateOn input

Retain the existing owner-family pool as the single authority for reranker
admission:

1. Admit one representative per canonical owner family before siblings.
2. Admit bounded supplemental chunks in fair rounds across owners.
3. Retain exact chunk identity when canonical owner evidence is unavailable.
4. Record every candidate admitted, omitted, or truncated and the responsible
   reason.
5. Keep the selected candidate order deterministic before neural scoring.

The qualification receipt must report:

```text
eligible candidate count
unique owner-family count
representative count
supplemental count
provider-depth omissions
projection-byte omissions
reranked count
```

## 7. Compact projection qualification

Do not change projection and depth in the same uncontrolled comparison.

Reuse the immutable projection-v1 D-L16 and D-L32 scores when their model,
query, candidate identities, and projection digest are unchanged. Do not spend
new scoring work to rediscover known quality results.

Define one prospective projection v2, then freeze its D-L16, D-L32, and D-L50
arms before viewing any projection-v2 output. Those are new factorial arms and
may receive preregistered authority. Projection-v1 D-L50 is also unopened and
may be preregistered. Do not tune projection v2 after viewing its D-L16 result.

The prospective projection should contain, when authoritative evidence exists:

```text
repository-relative path
language and symbol kind
canonical symbol label
signature or declaration
bounded verbatim docstring or documentation excerpt
query-relevant bounded source excerpt
bounded owner siblings only when required
```

File-level Markdown and configuration candidates need an explicit projection
using their path, heading/declaration evidence, and bounded relevant text; they
must not be forced through a symbol-only format.

The projection owner must guarantee:

* deterministic UTF-8 bytes for the same publication, query, and candidate;
* a versioned projection identity and digest;
* explicit per-document and aggregate byte observations;
* no split UTF-8 sequences or partially serialized fields;
* no mutable working-tree evidence without a valid prepared-source barrier;
* no silent loss of the declaration merely to retain a lower-value excerpt.

“Query-relevant” must be mechanical. Reuse the versioned
`selectBoundedSource` policy with normalized query tokens, authoritative symbol
spans, validated evidence spans, deterministic byte/line windows, and its
existing stable tie order. Do not add an LLM-generated summary, an undisclosed
heuristic, or a model-selected source window. Any selector change requires a
new selection-policy identity and its own isolated comparison.

If the compact projection changes D-L16 ordering or scores, record that as a
projection experiment. Do not attribute the change to candidate depth.

## 8. Track L — LateOn depth qualification

### L0 — freeze authority

Final executable tuning authority: the version 3 manifest is sealed at
`05fb273715d6205bcdf5adc1fdec94a892d8b40fc651a386ab36ccfb9475b7bc`
and binds the committed scorer/evaluator boundary. The preregistered tuning arms
were opened under this authority and reached `baseline_b_retained`; held-out
model outputs remain unopened. Earlier descriptive seals are superseded and
have no execution authority.

Before viewing new contender output, freeze:

* tuning task and negative-control identities;
* candidate captures and publication bindings;
* model, tokenizer, ONNX artifact, and loader digests;
* query formatting and compact projection identity;
* owner-family admission policy;
* hashes of the already-observed projection-v1 D-L16/D-L32 artifacts and their
  original frozen quality decision;
* unopened projection-v1 D-L50 and projection-v2 D-L16/D-L32/D-L50 executable
  policy artifacts;
* process isolation, thread count, warmup, and measurement order;
* exact quality, safety, practical-effect, and uncertainty rules.

Any revised selection rule applied to the already-observed projection-v1
D-L16/D-L32 results must be declared post-hoc and reported separately. It cannot
retroactively qualify either arm or replace `B`.

New-arm quality rules extend the frozen cross-repository contract:

* A decision-bearing split requires at least six independent repository
  families, at least six positive owner tasks and two reviewed negative tasks
  per repository, and therefore at least 48 tasks. The existing three-family
  split remains valid diagnostic evidence but is insufficient by itself for a
  Track L selection or default-policy conclusion.
* Aggregate paired task deltas within each repository, then use the unweighted
  repository mean.
* Use 10,000 deterministic repository-cluster bootstrap resamples with the seed
  derived from the sealed manifest digest.
* Treat projection-v1 D-L50 and projection-v2 D-L16/D-L32/D-L50 as one family
  of at most four new contenders. Use two-sided `98.75%` Bonferroni-adjusted
  percentile intervals (`0.05 / 4`) when all four are admitted; freeze the
  divisor to the actual preregistered arm count if fewer arms are admitted.
* A candidate must improve repository-macro owner-at-three by at least `0.05`
  and macro reciprocal rank by at least `0.03` versus `B`, with adjusted lower
  bounds above zero for both.
* Protected non-inferiority margins remain `-0.02` for owner-at-one, `-0.01`
  for owner-at-ten and required-role coverage, and `+0.02` for hard-negative
  and unacceptable-owner exposure at three.
* Exact identifier, `must:`, configuration pin, candidate-membership,
  eligibility, fallback, and frozen-pagination controls permit zero failures.
* Among safe candidates, prefer the shallower depth unless a deeper arm improves
  repository-macro MRR by at least `0.01` and clears every protected margin.

The executable L0 authority keeps query controls outside the quality estimator.
Every repository retains six independently reviewed quality-owner tasks; exact,
`must:`, and configuration-pin controls are additive and carry explicit sealed
`safetyControls` metadata through suite compilation, capture, scoring, and replay.
This prevents easy control queries from diluting the quality comparison or creating
unequal per-repository denominators.

Required-role coverage is not decision-bearing in this corpus because the task
oracle does not declare independently reviewed required roles. L0 records it as
`not_applicable_no_required_role_oracle`; it must not be inferred from path classes
or approximated after results are visible. Owner-at-ten remains the protected
retrieval-depth metric.

The `+0.05` owner-at-three and `+0.03` MRR practical-effect thresholds are
reused from the cross-repository contract frozen in `fe86a1a`, before the
D-L16/D-L32 outcomes recorded in `3b7b731`; they were not selected around those
results. Their product meaning is conjunctive: at least a five-percentage-point
increase in the repository-macro rate of exposing the expected owner among the
first three results, plus a `0.03` repository-macro reciprocal-rank improvement
so that the gain is not merely a boundary shuffle at rank three.

The optimized D-L16 receipt's `1,000 ms` model-load, `900 ms` warm-p95,
`2,000 ms` request-deadline, `832 MiB` peak-RSS, and `640 MiB` retained-RSS
values are the current measured-profile reference. L0 must either adopt those
exact values or publish a new target deployment profile with exact absolute
numbers and derivation before any optimized D-L32/D-L50 resource result is
opened. Resource limits cannot be revised after observing the new arms.

Ten thousand bootstrap resamples control Monte Carlo precision; they do not
create independent repository evidence. If the six-family/task minima are not
met, an adjusted interval is inconclusive, or evidence cannot distinguish
contenders under the frozen practical-effect rules, record
`insufficient_evidence`; do not describe a three-family interval as strong
statistical proof or select the numerically highest point estimate.

Held-out tasks remain sealed during L0 through L4.

### L1 — validate and replay known authority

Validate the immutable D-L16/D-L32 artifact hashes, model identity, candidate
captures, and projection-v1 identity. Replay their existing scores without new
model scoring and require identical candidate membership, eligibility, scores,
and order.

Stop if either known arm cannot be reproduced; new depth comparisons would lack
a trustworthy control.

### L2 — measure new quality arms and optimized resources

For projection v1, score only the unopened D-L50 quality arm. Reuse the known
D-L16/D-L32 scores. If projection v2 was admitted, score its preregistered
D-L16/D-L32/D-L50 factorial arms.

Rerun resource measurements for depths 16, 32, and 50 under the optimized
runtime in isolated processes. Counterbalance execution order so later depths
cannot inherit model caches or allocator state.

Measure separately:

```text
repository-macro MRR
owner-at-one, owner-at-three, and owner-at-ten
per-task rank transitions
hard-negative exposure
exact-identifier invariants
no-answer correctness
candidate and eligibility identity
cold model-load latency
warm score p50, p95, and maximum
peak and retained total-process RSS
worker startup, timeout, and fallback behavior
projected bytes and tokens per candidate and request
```

Resource thresholds must be derived from the actual target deployment profile,
not copied from the obsolete assumed 512 MiB contract. L0 must freeze the
decision procedure before results are opened. A small latency miss is not an
automatic rejection: quality, latency, memory, and failure containment must be
reported as a Pareto comparison with the preregistered practical-effect rule.

### L3 — select at most one disabled neural candidate

Selection is mechanical:

```text
Any safety, identity, or fallback regression
    -> reject that depth

New arm misses either +0.05 owner@3, +0.03 MRR, adjusted-positive lower
bounds, a protected non-inferiority margin, or the frozen absolute resource
profile
    -> reject that arm

Deeper safe arm improves MRR by less than 0.01 over a shallower safe arm
    -> retain the shallower arm

All admitted arms are inconclusive under the frozen sample/interval rules
    -> insufficient_evidence

One safe arm clears every gate, or a deeper safe arm clears the 0.01 depth
effect over every shallower safe arm
    -> select that arm as the disabled candidate

No depth improves safely
    -> retain deterministic baseline B; D-L16 remains runtime-qualified but
       quality-directional and optional
```

Do not select D-L50 merely because it is the largest. Do not reduce first-stage
retrieval or disclosure safety to compensate for model cost.

Projection-v1 D-L16/D-L32 retain their original failed quality verdict. A new
candidate may advance only from an unopened preregistered arm. Selection at L3
creates a disabled candidate implementation; `B` remains the default policy.

### L4 — extend the existing provider as a disabled candidate

Isolated D-L16 provider support already exists. Only after L3 selects a new
candidate:

1. Publish a new versioned LateOn runtime profile containing the selected depth
   and measured defaults.
2. Verify that `getMaxDocuments()` continues to report the selected profile
   depth and that admission never substitutes an unrelated code constant.
3. Keep explicit operator overrides within the qualified contract.
4. Preserve worker isolation and all-or-nothing fallback.
5. Keep deterministic grouping, disclosure, and continuation downstream of the
   complete reranked order.
6. Add diagnostics that distinguish retrieval pool, eligible pool, reranker
   pool, reranked count, disclosed count, and remaining continuation count.
7. Keep the candidate disabled by default and require an explicit experimental
   selection until held-out adjudication passes.
8. Freeze maximum simultaneous reranks, bounded queue length, admission
   behavior, cancellation semantics, shutdown behavior, and worker-termination
   deadlines in the versioned runtime profile.
9. When the queue is full, a request is cancelled, or its deadline expires
   while queued, discard all neural work for that request and restore its
   deterministic baseline without a partial order.

Projection v2 requires an explicit runtime-contract change. Version the
projection identity in `lateon-reranker-protocol.ts`, the worker handshake, and
the runtime profile loader. The provider and worker must reject an unknown or
mismatched projection identity before scoring; a profile cannot silently feed
projection-v2 bytes through the `search_rerank_document_v1` contract.

The concurrency receipt must prove active and queued counts remain bounded,
deadlines include queue wait, shutdown rejects and drains every queued/pending
request, and no worker or promise remains live after cancellation or closure.
Focused tests must cover queue saturation, cancellation before admission,
cancellation while queued, cancellation during worker execution, and shutdown
with both queued and active requests.

### L5 — held-out adjudication

Open held-out evidence once, only after the implementation reproduces its
tuning receipt. A held-out failure retains the previous product policy. Do not
tune depth, projection, weights, or thresholds after opening held-out results.

### L6 — default-policy decision

Default activation may be considered only after L5 passes every frozen quality,
safety, identity, resource, and fallback gate. Otherwise `B` remains default.
An L5 pass is necessary but does not authorize release or activation by itself;
record that decision in a separate production-policy receipt.

## 9. Implementation ownership

Use the existing owners rather than adding policy to `Context`:

| Responsibility | Owner |
| --- | --- |
| Retrieval and logical/disclosure limits | `packages/mcp/src/core/search-policy.ts` |
| Capability advertisement | `packages/mcp/src/core/capabilities.ts` |
| Public search and continuation validation | `packages/mcp/src/tools/search_codebase.ts`, `continue_search.ts` |
| Frozen result-set lifecycle | `packages/mcp/src/core/search-result-set-cache.ts` |
| Ranked-set identity and continuation binding | `packages/mcp/src/core/handlers.ts`, `search-result-set-cache.ts` |
| Owner-family reranker admission | `packages/mcp/src/core/search-rerank-policy.ts` |
| Reranker execution and deterministic fallback | `packages/mcp/src/core/search-execution.ts` |
| Reranker document serialization | `packages/mcp/src/core/search-rerank-document.ts` |
| Mechanical bounded source selection | `packages/mcp/src/core/bounded-source-selector.ts` |
| LateOn model/runtime contract | `packages/mcp/src/server/lateon-reranker*.ts` and the versioned profile asset |
| LateOn concurrency and backpressure | `packages/mcp/src/server/lateon-reranker.ts` |
| Grouping and disclosure | existing search grouping/finalization owners |

`Context` remains the composition root and compatibility façade. This work must
not move search policy, model lifecycle, continuation state, or disclosure
state back into it.

## 10. Verification matrix

At minimum, cover:

* default offline Potion searches requesting 1, 10, 15, 16, 32, 50, 80, and a
  value larger than the available frozen set;
* complete pagination with no duplicate, missing, reordered, or recomputed
  groups;
* pagination over a LateOn-ranked frozen set preserves the exact neural final
  order across the initial page and every continuation while recording zero
  additional reranker calls, candidates, or bytes;
* handle expiry, eviction, owner shutdown, retry, and wrong-offset behavior;
* a compact index whose identities and order exactly match final grouping;
* D-L16, D-L32, and D-L50 with zero, partial, and complete candidate pools;
* exact and `must:` queries that skip or preserve reranking as required;
* multiple chunks from one owner and many distinct owners;
* file-level Markdown, configuration, tests, scripts, and source symbols;
* model missing, digest mismatch, timeout, crash, malformed output, incomplete
  output, and out-of-order identities;
* simultaneous requests at, below, and above the frozen active/queue bounds;
* cancellation before admission, while queued, and during worker execution;
* shutdown with queued and active work and proof that the worker is terminated;
* aggregate projection-byte exhaustion;
* unchanged candidate membership and eligibility across every depth;
* deterministic baseline restoration after every failure.

## 11. Independent completion receipts

Tracks P, L, and I each produce a separate receipt. A combined summary may link
them but must not turn one track's rejection into another track's failure.

Each applicable receipt must include:

```text
source revision and tree digest
benchmark seal and split authority
publication and candidate-capture identities
model/tokenizer/ONNX/loader/profile identities
projection identity
depth-policy artifact hashes
complete quality and rank-transition results
complete latency and memory observations
negative and exact-control results
pagination and compact-index invariants
fallback evidence
selected depth or explicit retain-baseline decision
held-out opening record, if L5 was authorized
```

Track P records one of:

```text
pagination_complete_frozen_set_qualified
pagination_bound_derivation_blocked
pagination_identity_or_order_rejected
```

Track I records one of:

```text
compact_result_index_qualified
compact_result_index_rejected
compact_result_index_deferred
```

Track L records one of:

```text
baseline_b_retained
lateon_depth_32_disabled_candidate
lateon_depth_50_disabled_candidate
lateon_projection_v2_disabled_candidate
lateon_default_policy_qualified_after_held_out
insufficient_evidence
blocked_by_projection_authority
blocked_by_candidate_replay
rejected_for_safety_regression
rejected_for_deployment_profile
```

The plan is complete when every authorized track has its own terminal receipt.
Track P completion does not require Track L or Track I authorization or success.
