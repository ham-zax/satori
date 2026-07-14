# Satori search-quality improvement program

Date: 2026-07-15

Status: implementation and repository validation complete; external paired-agent evaluation pending

This document is the durable implementation journal for the program defined by
`2026-07-14-satori-search-quality-pipeline-investigation.md`. It records the
unchanged baseline, accepted and rejected experiments, validation evidence, and
the disposition of every recommendation. The investigation remains the design
roadmap; this document records what the current repository and measurements
actually justify.

## Continuation checkpoint

This is the current handoff point for a later validation session. The justified
implementation program, hermetic corpus, live provider measurements, controlled
safety checks, and repository gates are complete. The pinned smaller-model
native-versus-Satori paired-agent evaluation requires an external model harness
and remains the only completion-contract blocker.

### Progress at this checkpoint

- Every investigation recommendation is now classified. Items 7.2 through 7.6
  are implemented and accepted, 7.7 was tested and reverted for measured cost,
  and 7.8 through 7.11 are deferred with measured justification. Live traces do
  not justify a cache or indexing-contract change in this slice.
- The repository-controlled completion work is complete. The hermetic corpus,
  focused safety controls, full 403-test Core suite, full 884-test MCP suite,
  112-test CLI suite, 30-test integration suite, 60-test repository-script
  suite, lint, typecheck, version checks, build, live benchmark, and native
  command comparison are green. The external paired-agent run remains.
- The latest accepted hermetic artifact is
  `2026-07-15-search-quality-after-structural-routes.json`, SHA-256
  `a3d2dca2736aeced28f871b89685f14b5a8e7e6855927cb63075f286de27fb0c`.
  It contains schema 2, 19 workloads, five limits, and an immutable repository
  and working-tree identity for the evaluated state.
- The final no-change diagnostic artifact is
  `.satori/benchmarks/live-latency/2026-07-14T19-02-04-188Z-diagnostic-search-quality-no-change.json`,
  SHA-256 `7ea7caa85ebe44ab0d718218e206e66f77e077db3959ca4f2d087393f76bcee1`.
  The matching comparison artifact is
  `.satori/benchmarks/live-latency/2026-07-14T19-02-50-049Z-comparison-search-quality-no-change.json`,
  SHA-256 `3c908c59abb1f09acc4230fff3daa9d1c182a2582115ace2b6a57864ed3b2ccb`.
- The repository remains a mixed staged, unstaged, and untracked working tree.
  Preserve it. Do not stage, commit, reset, stash, or discard work without
  explicit authorization.

### Accepted behavior currently in the tree

1. A caught-and-ignored collection liveness query no longer runs before every
   hybrid search pass.
2. Nine internal query routes are classified deterministically.
3. Exact identifier, exact path, quoted literal, and configuration routes use
   sparse-only retrieval on a hybrid generation and do not require an embedding
   provider.
4. Semantic expansion runs only when the bounded primary-pass gate requires it;
   primary and expansion are no longer unconditional parallel fanout.
5. Reranker input prefers distinct immutable owner families, retains up to two
   additional already-ranked chunks per family in owner-fair rounds so long
   split owners keep body evidence, and uses an adaptive bounded budget.
6. The attempted role-enriched reranker document format is not present. It was
   reverted after increasing provider input by 52.7%. That experiment proves
   the cost regression; its manifest-ordered hermetic reranker cannot measure a
   possible provider-quality benefit.
7. Conceptual `where is ...` queries stay conceptual unless they carry a strong
   identifier-shaped target; exact target forms such as `where is
   rankCandidates handled` retain ownership routing.
8. Bounded debug and telemetry now record route, retrieval mode, semantic
   attempts, contract-derived embedding/dense/sparse operations, reranker
   calls/candidates/input bytes, candidate-source counts, expansion reason, and
   actual returned-result count without query or source text.
9. Hybrid lexical retrieval uses the optional direct sparse operation when it
   exists and otherwise issues one sparse-only request through the required
   hybrid-search contract. The fallback performs no embedding or dense query.
10. Implementation-owner ranking neutralizes public tool and CLI wrappers, but
    keeps provider/backend adapters eligible as canonical implementations.
    Canonical ownership follows query and path evidence rather than treating
    every adapter directory as non-owning.
11. Ownership queries with one strong exact identifier resolve directly through
    the validated registry. Caller/callee queries resolve that identifier and
    then traverse the generation-bound relationship store. Successful
    structural routes perform no embedding, dense, sparse, or reranker work;
    ambiguity, unavailable navigation, empty edges, or dirty participants fall
    back to the existing provider-backed path.

### Reviewed risks and remaining falsification work

These findings remain after the review fixes and broad MCP run. They must not be
described as completed:

1. `SearchRouteContract` declares `deterministicFirst`, `navigation`,
   `allowedSources`, and `currentProviderBudget`. Exact ownership and reference
   routes now govern execution through registry/relationship evidence, while
   the remaining fields still primarily describe and diagnose the route. This
   is a bounded maintainability risk, not a demonstrated correctness defect.
2. `search_codebase` builds a query plan to choose `vector_only` versus
   `embedding_vector`, and `ToolHandlers.handleSearchCode()` builds the plan
   again for execution. Both call the same pure planner today, so no mismatch is
   proven. It remains documented rather than redesigned; a production change
   requires an actual planner/runtime disagreement.
3. Expansion sufficiency currently counts distinct scoped chunks, not immutable
   owner families. Five overlapping chunks from one owner can therefore appear
   sufficient. The corpus now contains a repeated-owner reranker workload, but
   it is not an expansion-recall falsification case. Change the gate only if a
   deterministic case proves that owner-family counting recovers missing
   evidence without regressing current quality or provider budgets.
4. Production provider counters are derived from the currently verified Core
   retrieval contract. They accurately distinguish exact, sparse, dense and
   hybrid paths in focused tests, but they are not provider-SDK interceptors.
   Validate them against live traces before using them for billing claims.

### Immediate continuation order

1. From a clean pinned revision, run `pnpm eval:agent-discovery`. The executable
   now selects both fixed tasks, launches three alternating native/Satori pairs
   in fresh OpenCode sessions, records authoritative OpenCode timing/token/tool
   events, grades them, and writes the comparison under
   `.satori/benchmarks/agent-discovery/`.
2. Add the generated paired-agent summary and model/OpenCode/Satori identity to
   this journal. Do not substitute the earlier shared-session manual attempt;
   it leaked the Satori answer into the native arm and had no harness-owned
   timing or token record.
3. Recompute the final HEAD identity after the executable harness changes are
   committed, then run the clean-tree evaluation and issue the final program
   verdict.

Do not reopen caches, indexing metadata, ranking weights, or expansion-family
counting merely because the external evaluation is pending. Those changes need
a new measured failure.

The hard stop still applies: do not continue into ranking-weight tuning,
generation-bound caches, or indexing-contract changes unless the deterministic
or live measurements show a concrete unresolved failure.

## Frozen safety and compatibility boundaries

The program must not weaken vector authority, completion-marker validation,
source-freshness checkpoints, mutation-generation or mutation-lease fencing,
navigation seals and manifests, generation-bound prepared receipts, or
deterministic degraded and failure behavior. Public MCP tool names, request
schemas, and response envelope versions remain unchanged. Ranking confidence,
cache age, watcher state, and provider success never substitute for authority
evidence.

## Repository state at program start

- Baseline commit: `1a01969eff7b6300bb9609efc7843a5eb3f9ba5b`
- Upstream baseline: `60b91f2`
- Working tree: clean
- Existing investigation: committed at the baseline commit
- Existing reusable latency benchmark:
  `scripts/satori-live-latency-benchmark.mjs`
- Existing agent discovery comparison:
  `evals/agent-discovery/`

The investigation's main static findings were rechecked against the current
sources before implementation:

- `runSearchExecution()` still launches primary and expanded retrieval before
  observing primary-pass quality for most non-exact requests.
- Core still implements `lexical` as embedding-backed dense plus sparse hybrid
  retrieval.
- Core still performs a caught-and-ignored one-row vector query before each
  hybrid pass.
- Reranking still occurs before owner-family grouping and accepts up to 50
  chunks.
- Reranker documents still omit explicit evidence roles and retrieval source.
- Existing `search.eval.test.ts` checks deterministic scope behavior, not owner
  rank, role coverage, duplicate-family rate, or provider economics.

These are direct source observations. Their product impact remains subject to
the corpus measurements below.

## Measurement contract

The hermetic release gate uses `fixtures/search-quality/v1/`, fixed provider
rows, a fixed clock, and a pinned generation receipt. It records, per workload
and display limit:

- owner rank and reciprocal rank;
- required evidence-role coverage;
- duplicate-family rate;
- embedding, sparse, dense, vector, expansion, and reranker calls;
- pre-rerank family counts and reranker input bytes;
- response bytes and estimated tokens;
- one tool invocation and whether the owner is available in that initial search;
- selected route, fallback reason, warnings, and repeated-run determinism.

The hermetic evaluator does not measure agent steps. Its former
`stepsToOwner` field was a mislabeled constant derived from owner presence and
has been replaced in schema 2 by `ownerAvailableInInitialSearch`. Actual steps
to the owner belong only to the native-versus-Satori agent harness, which can
observe searches, reads, branches, and retries across a complete task.

The required limits are 1, 3, 5, 10, and 20. Provider rows are deterministic
and their insertion order is shuffled in a second run to prove stable semantic
ordering rather than stable input order.

## Baseline

The unchanged product behavior was measured before any production routing,
ranking, or retrieval edit.

- Artifact:
  `docs/release/artifacts/2026-07-15-search-quality-baseline.json`
- Artifact SHA-256:
  `5ffe2588af970f49eba01c0d2b71bd3ff7bfa989fe914a9a5b7a50014cfb9b23`
- Fixture manifest SHA-256:
  `81250601c27b505aaf98ed8216428fca773aeb76eb908626d1d13cc09c72e2da`
- Product HEAD: `1a01969eff7b6300bb9609efc7843a5eb3f9ba5b`
- Tracked tree: `67fe7776879124385b919c50d735ec95503de862`
- Unstaged tracked diff SHA-256:
  `aba6cb28883293051984ffb2d438b457c1baa44d0f25bc7146c1d617a387b85e`
- Staged diff SHA-256: empty SHA-256
- Full tracked-and-untracked working-content SHA-256:
  `c20726ebf8a62440044a9458671b98c48581f6cff3e9bee9904ae2c5e9c11e87`

The working-content hash identifies the evaluator and fixture that produced the
baseline. The generated artifact itself was written afterward and is identified
separately by its artifact hash.

Baseline aggregate results across 85 workload/limit observations:

| Metric | Baseline |
|---|---:|
| Owner at rank 1 | 0.882353 |
| Owner within top 3 | 0.976471 |
| Macro reciprocal rank | 0.921569 |
| Mean required-role coverage | 0.912941 |
| Mean duplicate-family rate | 0.290420 |
| Semantic search calls | 135 |
| Embedding calls under the current Core contract | 135 |
| Dense queries under the current Core contract | 135 |
| Sparse queries under the current Core contract | 135 |
| Caught-and-ignored liveness queries under the current Core contract | 135 |
| Reranker calls | 55 |
| Reranker input bytes | 53,960 |
| Model-visible response bytes | 201,252 |

Important baseline observations:

- Known exact identifier, exact path plus owner, and exact rerank-skip workloads
  all resolve at rank 1 with zero semantic or reranker calls.
- The only missing owners are at display limit 1 for caller discovery and the
  conceptual router workload; both owners appear by limit 3.
- Every response stays within its workload byte budget, but repeated checkpoint
  evidence produces duplicate-family rates up to 0.8 at common limits.
- Conceptual and mixed requests normally consume two semantic passes. The
  exact-literal route also consumes two embedding-backed hybrid passes even
  though bounded lexical evidence is available.
- The provider counts are contract-derived from the directly verified Core
  implementation. Focused Core spies are still required for each provider-path
  change; the corpus does not substitute for adapter tests.

## Decision log

### 2026-07-15 — corpus before behavior changes

Decision: accepted.

Reason: the current focused tests cannot determine whether expansion,
reranking, grouping, or file diversity helps the owning-code objective. Tuning
or deleting those stages before a corpus would make acceptance subjective.

### 2026-07-15 — reuse the agent-discovery harness only for the final comparison

Decision: accepted.

Reason: `evals/agent-discovery/` already defines the native-versus-Satori arm
protocol and deterministic task accounting. It does not provide controlled
dense, sparse, reranker, owner-rank, or role-coverage measurements, so it cannot
replace the hermetic search-quality gate.

### 2026-07-15 — remove the non-gating hybrid collection probe

Decision: implemented and accepted.

Hypothesis: deleting the caught-and-ignored one-row `query()` call will reduce
remote work without changing candidates, ordering, warnings, or failure
semantics because `hybridSearch()` is already the operation that initializes,
loads, and reads the selected collection.

Evidence:

- Focused Core test: hybrid search issues zero `query()` calls and one embedding
  while returning the same indexed results.
- Focused failure test: a missing collection still rejects from the hybrid
  search boundary, with zero preliminary `query()` calls.
- Core typecheck: green.
- Hermetic corpus: all quality, ordering, response, semantic-pass, embedding,
  dense, sparse, reranker, and context measurements are identical after
  removing only the probe counter.
- Caught-and-ignored vector queries: 135 -> 0 across the 85 observations.

The change was retained.

### 2026-07-15 — introduce explicit result-preserving route contracts

Decision: implemented and accepted.

The query plan now classifies `exact_identifier`, `exact_path`, `literal`,
`configuration`, `ownership`, `references`, `structural`, `conceptual`, and
`mixed` routes. Each internal contract records a bounded reason, deterministic
first-stage policy, navigation requirement, allowed evidence sources, and the
current legacy-compatible provider ceiling. Ranking and full debug modes expose
the selected contract; the public request and response envelope versions are
unchanged.

Evidence:

- Focused route classification covers all nine routes.
- Compact debug projection and public-envelope tests remain green.
- MCP typecheck is green.
- All 85 corpus observations are identical to baseline after ignoring the new
  route diagnostic fields and the already-removed probe counter.
- Repeated corpus execution remains deterministic.

This phase intentionally does not use the route to change retrieval. It creates
the typed owner for the next measured behavior changes.

### 2026-07-15 — make lexical retrieval sparse-only

Decision: implemented and accepted.

Hypothesis: exact identifiers after a registry miss, exact paths, quoted
literals, and configuration lookups can use the generation-bound Milvus BM25
field without embedding, dense ANN, query expansion, or reranking while
preserving owning-code quality and dirty-worktree safety.

Implementation:

- Core now maps `retrievalMode: "lexical"` to one sparse BM25 request on hybrid
  generations. Dense and hybrid modes retain their existing behavior.
- Both Milvus SDK and REST adapters expose the same bounded sparse-search
  contract and preserve filter expressions.
- Lexical routes run one primary pass and do not issue the generic semantic
  expansion query.
- Configuration routes now join identifier, path, and literal routes in the
  sparse-only class and skip reranking.
- The public tool selects the vector-only runtime for sparse routes, so a
  missing embedding credential no longer blocks a route that will not embed.
  Dense and hybrid routes still acquire the embedding-capable runtime.
- Stale indexed candidates for dirty paths remain suppressed and are replaced
  only by current-source lexical evidence under the existing freshness policy.

Measured artifact:

- Artifact: `2026-07-15-search-quality-after-sparse.json`
- Artifact SHA-256:
  `d7c3d76e7d14345a7a3519eeeee922dd061e708d1568a3b71737ecd8e795b1f9`
- Observations: 17 workloads x five limits = 85.

| Metric | Baseline | Sparse routes | Delta |
|---|---:|---:|---:|
| Owner at rank 1 | 0.882353 | 0.882353 | 0 |
| Owner within top 3 | 0.976471 | 0.976471 | 0 |
| Macro reciprocal rank | 0.921569 | 0.921569 | 0 |
| Mean required-role coverage | 0.912941 | 0.912941 | 0 |
| Mean duplicate-family rate | 0.290420 | 0.289440 | -0.000980 |
| Search passes | 135 | 120 | -15 |
| Embedding calls | 135 | 100 | -35 |
| Dense queries | 135 | 100 | -35 |
| Sparse queries | 135 | 120 | -15 |
| Reranker calls | 55 | 50 | -5 |
| Reranker input bytes | 53,960 | 50,785 | -3,175 |
| Model-visible response bytes | 201,252 | 200,427 | -825 |

Focused evidence covers zero embedding/dense calls, one sparse call, SDK/REST
request parity, remote collection failure, vector-only versus embedding runtime
selection, and stale dirty-file replacement. The change was retained.

### 2026-07-15 — make semantic expansion evidence-triggered

Decision: implemented and accepted.

An all-primary experiment first forced every expanded pass to fail. It cut 50
embedding/dense calls but regressed owner-at-one from 0.882353 to 0.823529,
macro reciprocal rank from 0.921569 to 0.894118, and role coverage from 0.912941
to 0.897647. Unconditional removal was therefore rejected.

The accepted gate runs the primary pass first and expands only when bounded
evidence says it is necessary:

- mixed routes retain expansion for conceptual role coverage;
- `must:`-constrained searches retain expansion;
- a failed non-lexical primary pass expands as the deterministic fallback;
- ambiguous conceptual searches with fewer than five scoped primary candidates
  expand;
- lexical, ownership, reference and structural routes do not expand;
- explicit implementation, writer or test cues do not expand when the primary
  pass succeeds;
- a sufficiently large scoped primary pool does not expand.

The decision records whether expansion ran, its bounded reason, and the scoped
primary-candidate count in ranking/full debug output. Expansion-required calls
are sequential; this avoids paying for expansion before it is justified but
can make a genuinely ambiguous request slower than the old parallel fanout.
That trade-off remains a required live-benchmark measurement.

Measured artifact:

- Artifact: `2026-07-15-search-quality-after-expansion.json`
- Artifact SHA-256:
  `69e52444b1117fbcfedf55a0452a9ebef66ca0f51ae84305daf884ce807e507a`
- Observations: 17 workloads x five limits = 85.

| Metric | Sparse routes | Conditional expansion | Delta |
|---|---:|---:|---:|
| Owner at rank 1 | 0.882353 | 0.882353 | 0 |
| Owner within top 3 | 0.976471 | 0.976471 | 0 |
| Macro reciprocal rank | 0.921569 | 0.929412 | +0.007843 |
| Mean required-role coverage | 0.912941 | 0.921176 | +0.008235 |
| Mean duplicate-family rate | 0.289440 | 0.265098 | -0.024342 |
| Search passes | 120 | 85 | -35 |
| Embedding calls | 100 | 65 | -35 |
| Dense queries | 100 | 65 | -35 |
| Sparse queries | 120 | 85 | -35 |
| Reranker calls | 50 | 50 | 0 |
| Reranker input bytes | 50,785 | 44,685 | -6,100 |
| Model-visible response bytes | 200,427 | 195,116 | -5,311 |

No workload/limit observation regressed in owner rank, role coverage or its
declared response/tool budget. Primary failure fallback and expanded-pass
failure warning behavior remain covered. The conditional design was retained.

### 2026-07-15 — bound reranker input by immutable owner families

Decision: owner-family selection implemented and accepted; role-enriched
reranker documents tested and rejected in this slice.

Before the provider call, candidates are now partitioned using only indexed
owner evidence:

- `ownerSymbolInstanceId` is preferred;
- `ownerSymbolKey` is the fallback;
- missing owner metadata uses exact chunk identity and is never collapsed by
  label, file proximity or similar content;
- every family keeps its strongest ranked representative;
- up to two additional already-ranked chunks per family are retained, without
  guessing a role from coarse owner metadata;
- distinct family representatives are placed before supplemental candidates,
  and supplemental rounds remain fair across owners;
- the provider budget is bounded by requested limit and family ambiguity, with
  the existing 50-candidate constant remaining the hard maximum;
- the complete scored array remains untouched, so provider failure returns the
  same deterministic pre-rerank order.

Focused coverage proves a long owner split across three chunks retains the
third family member when the declaration and first body chunk do not contain
the query-relevant behavior. A handler-level test
proves that a five-chunk, four-owner input sends all four representatives plus
one supplemental chunk, exposes exact reranker bytes/candidate counters, and
avoids semantic expansion when the five-candidate primary pool is sufficient.
Missing-owner, shuffled-row and 30-family adaptive budget cases are also
covered.

Measured corpus artifact:

- Artifact: `2026-07-15-search-quality-after-review-fixes.json`
- Artifact SHA-256:
  `9a8316e11e641fa6dd423ce21412bad4b0628a0835a04c0de80f6ee1ad4fb93f`
- Observations: 19 workloads x five limits = 95.

The schema-2 corpus adds two cases. `split_owner_relevant_body` models three
chunks sharing one immutable owner, puts the useful behavior only in the third
family member behind a higher-ranked competing owner and a generic sibling,
verifies that chunk reaches reranking at every limit, and returns the owner
family at rank one. `conceptual_where_is` verifies that `where is search
quality enforced` remains conceptual and attempts semantic expansion at every
limit. Every declared budget passes for both workloads.

Across the 85 observations shared with
`2026-07-15-search-quality-after-rerank.json`, owner rank, reciprocal rank, role
coverage, result IDs, warnings, provider operations, reranker candidates, and
reranker bytes are unchanged. Response size changed by -6 to 0 bytes per
observation (-21 bytes total) from the diagnostic naming correction; no
model-visible context regression occurred.

The first role-enriched document experiment prepended path, role, retrieval
source and owner fields and increased reranker input from 44,685 to 68,250 bytes
(+52.7%). The document change was reverted. Its hermetic reranker follows a
manifest-provided ordering and cannot react to document content, so the run
proves the byte regression but does not measure a quality benefit. Deterministic
role metadata remains useful for local selection, but provider enrichment needs
a pinned live reranker, a content-sensitive deterministic fixture, or recorded
provider responses before it can be accepted or rejected on quality.

### 2026-07-15 — defer role-budget selection and score calibration

Decision: 7.8 and 7.9 deferred with measured justification.

The accepted corpus does not show a response-budget failure that would justify
another final-selection policy. All 95 response/tool budgets pass. The largest
model-visible response is 4,326 bytes. The architecture workload reaches all
five required evidence roles at `limit=5` in 3,301 bytes and keeps that coverage
at larger limits. Its lower coverage at limits one and three is the unavoidable
cardinality bound, not evidence that a different selector displaced a role.

The runtime also lacks trustworthy caller/configuration/documentation role
metadata on every group. Inferring those roles from names and paths would add a
second heuristic ranking layer and could hide the highest-scoring proven owner.
Because the provider-document role experiment was rejected and the existing
file/symbol caps already satisfy every context budget, role-budget selection is
deferred rather than implemented speculatively.

Score calibration is also not justified by the current corpus. It contains 19
scripted workloads and no held-out slice; fitting constants to its two repeated
rank-two classes would be direct overfitting. Caller discovery is primarily a
structural-routing limitation, not evidence that a global score weight is
wrong. Existing weights remain unchanged until a separate held-out fixture or
live labeled sample can falsify them.

### 2026-07-15 — close sparse-capability and canonical-owner regressions

Decision: both failures from the first broad MCP run were real, bounded
correctness gaps. Both were fixed and accepted after focused, affected-suite,
full-package, and corpus validation.

The degraded-navigation test proved the sparse capability mismatch. After a
symbol shard was removed, exact registry lookup correctly degraded to lexical
retrieval, but Core threw because `VectorDatabase.sparseSearch` is optional.
Every vector adapter is already required to expose `hybridSearch`, and lexical
mode is only legal for a hybrid generation. Core now uses the direct
`sparseSearch` shortcut when available and otherwise sends one request with
`anns_field: "sparse_vector"` through `hybridSearch`. The fallback keeps the
`lexical_rank` score contract and performs zero embedding and dense calls. A
Core regression test verifies the exact request shape, and the original MCP
navigation-degradation test now remains vector-readable with repair guidance.

The canonical-owner test exposed a separate ranking regression created when
conditional expansion removed a duplicated semantic pass. The prior duplicate
pass had accidentally contributed enough fusion weight for the canonical Core
owner to narrowly outrank a higher-lexical public tool wrapper. Reintroducing
that provider work would be incorrect. Instead, implementation queries now
reserve the implementation-symbol owner-fit boost for non-adapter paths;
adapter/tool symbols remain eligible but receive neutral owner fit. Existing
runtime path multipliers then restore the declared canonical-owner ordering.
No global score constant changed. The full 150-test affected MCP handler slice
and the hermetic corpus show no unrelated ranking regression.

Measured corpus artifact:

- Artifact: `2026-07-15-search-quality-after-capability-owner-fix.json`
- Artifact SHA-256:
  `975cdd14951e474d332cd22a1c6a3dc17f0886123167b1f7c526eace1905f39a`
- Observations: 19 workloads x five limits = 95.
- Compared with `2026-07-15-search-quality-after-review-fixes.json`: zero
  differences in status, owner rank, reciprocal rank, role coverage,
  duplicate-family rate, result IDs, provider work, route observations,
  warnings or budget checks. Aggregate metrics and response bytes are
  unchanged.

Validation at this checkpoint:

- Core lexical direct-sparse and fallback tests: 2/2 green.
- Full Core `context.test.ts`: green.
- Affected MCP handler suites: 150/150 green.
- Core and MCP typechecks: green.
- Full MCP package suite: 877/877 green.
- `git diff --check`: green.

### 2026-07-15 — structural ownership/reference execution and long-owner correction

Decision: the review identified three real search-quality gaps. All were
reproduced with failing focused tests, fixed, and accepted after corpus and
package validation. The economic-counter naming concern was outdated: the
fields already carry the `ByCurrentContract` qualifier and no rename was made.

Ownership and reference route contracts previously described deterministic
sources without executing them. A strong natural-language target such as
`who owns rankCandidates` now resolves through the validated symbol registry.
`who calls writeSourceCheckpoint` resolves the target and traverses the
generation-bound relationship store, returning direct peers before the target
supporting evidence. Both successful routes perform zero semantic, embedding,
dense, sparse, and reranker work. The path deliberately falls back when the
target is ambiguous, navigation is unavailable, relationship evidence is
empty, or either target or peer is dirty and was not freshened. Empty graph
evidence is not treated as proof that no callers exist.

The adapter-owner neutralization was also too broad. It now applies only to
public tool and CLI wrappers; actual provider/backend implementations under
`adapter` or `adapters` retain implementation-owner eligibility. An adversarial
handler test proves the provider adapter remains the canonical result.

Finally, owner-family rerank selection now admits two bounded supplemental
chunks in round-robin owner order. The corpus was strengthened so the relevant
behavior exists only in the third member of one owner family, behind both a
generic sibling and a higher-ranked competing owner. The preceding
one-supplemental artifact sent four candidates (1,283 bytes) per sample; the
accepted, whitespace-normalized fixture sends five (1,534 bytes), a
cross-artifact increase of 251 bytes per sample and 1,255 bytes across five
limits while restoring the correct owner at rank one. Because fixture EOF
whitespace was normalized during commit validation, candidate count—not that
byte delta—is the isolated policy comparison.

Measured corpus artifact:

- Artifact: `2026-07-15-search-quality-after-structural-routes.json`
- Artifact SHA-256:
  `a3d2dca2736aeced28f871b89685f14b5a8e7e6855927cb63075f286de27fb0c`
- Observations: 19 workloads x five limits = 95.
- Repeated writes to the same output path now produce the same recorded
  repository identity. The evaluator excludes only that exact generated output
  path from diff/content hashing, avoiding self-contamination by the prior
  artifact, and raises the Git capture bound above the measured 1 MiB staged
  diff.

Compared with `2026-07-15-search-quality-after-review-fixes.json`:

| Metric | Review fixes | Structural routes | Delta |
|---|---:|---:|---:|
| Owner at rank 1 | 0.894737 | 0.947368 | +0.052631 |
| Owner within top 3 | 0.978947 | 0.989474 | +0.010527 |
| Macro reciprocal rank | 0.936842 | 0.968421 | +0.031579 |
| Mean required-role coverage | 0.929474 | 0.929474 | 0 |
| Mean duplicate-family rate | 0.253333 | 0.241579 | -0.011754 |
| Semantic search calls | 100 | 90 | -10 |
| Embedding calls | 80 | 70 | -10 |
| Dense queries | 80 | 70 | -10 |
| Sparse queries | 100 | 90 | -10 |
| Reranker calls | 60 | 50 | -10 |
| Reranker input bytes | 55,995 | 47,795 | -8,200 net |
| Model-visible response bytes | 220,784 | 214,829 | -5,955 |

The ownership workload remains rank one while removing five complete provider
passes. Caller discovery improves from missing at limit one and rank two at
larger limits to rank one at every limit, also removing five provider passes.
The long-owner safety cost is included in the net reranker-byte figure above.

Current-diff validation: focused structural/rerank suites 162/162, hermetic
evaluation determinism green, root typecheck green, full workspace build green,
full MCP package 884/884, and `git diff --check` green.

### 2026-07-15 — live provider validation and final optional-phase decisions

Decision: live instrumentation accepted; 7.10 and 7.11 deferred with measured
justification.

The durable live benchmark initially had two reproducibility defects. Its
search serializer read obsolete top-level reranker fields and read pass counts
from `debugSearch` even though the public response owns them. It also named a
function `requireNoChangeSync()` but accepted any successful sync. The first
exploratory run therefore absorbed a 164-second index mutation before recording
samples. The benchmark now records bounded route, retrieval, provider-work,
semantic-expansion, reranker-family/candidate, readiness and pass-count evidence.
It also requires complete `syncStats` and fails unless `added`, `removed`, and
`modified` are all zero. Six focused benchmark tests and the full 60-test script
suite cover the corrected contracts. The exploratory mutation-bearing artifact
is not the final measurement.

The corrected no-change diagnostic used the configured VoyageAI/Milvus runtime,
three samples per warm workload, a 500 ms post-warm-up settle, and a sync receipt
of `{ added: 0, removed: 0, modified: 0 }`. These are observational medians and
ranges, not percentiles:

| Workload | Previous warm diagnostic | Current warm diagnostic | Observation |
|---|---:|---:|---|
| Exact identifier | 571.3 ms (564.9-574.2) | 586.9 ms (570.8-595.4) | Stable within 2.7%; zero provider calls and zero recounts |
| Conceptual semantic | 2,991.7 ms (2,885.8-4,056.9) | 1,931.2 ms (1,853.6-4,412.9) | Median 35.5% lower; high provider-tail variability remains |
| Exact outline | 546.1 ms (542.5-547.8) | 552.9 ms (549.2-553.0) | Stable within 1.2% |

The warm exact and semantic samples each reported one prepared-cache hit, one
warm receipt revalidation, zero cold readiness checks, zero post-freshness cold
checks, zero exact payload recounts, zero registry loads and zero navigation
validation runs. Exact search made no embedding, dense, sparse or reranker call.
Each repeated conceptual sample made one embedding, one dense query, one sparse
query and one reranker call. Semantic expansion was not attempted because the
primary pool had 14 scoped candidates. The reranker saw 17 candidates from 17
distinct owner families, retained zero supplemental duplicates and received
6,778 bytes.

This trace does not justify a generation-bound result cache. The identical
conceptual calls are deliberate benchmark repetitions, not evidence that user
queries repeat at a rate that offsets cache identity, source-warning and memory
complexity. It does prove the potential upper bound: an exact repeat currently
reissues provider work. Reconsider 7.10 only with real repeated-query frequency
or a paired-agent trace showing a repeated conceptual query on an unchanged
generation. The 17-of-17 owner-family trace also shows no remaining family
duplication in this workload, so no indexing/chunk metadata change is justified.
Reconsider 7.11 only after a deterministic or live failure survives the accepted
retrieval-time policy.

The one-sample all-tool comparison is retained separately from the diagnostic
distribution. Satori observed 560.5 ms exact, 4,250.6 ms conceptual, 566.6 ms
outline, 736.6 ms call graph, 674.0 ms open symbol, 2.3 ms bounded read and
2,364.5 ms architecture discovery. Native command comparators observed 28.8,
42.0, 23.8, 104.5, 76.6, 75.5 and 28.2 ms respectively. Native conceptual and
architecture rows are lexical task comparators, not semantic equivalents. The
single conceptual Satori sample was 31.3% slower than the prior 3,236.8 ms
comparison sample while its response shrank from 4,982 to 4,092 bytes; the
three-sample semantic median above is the appropriate warm distribution and
improved materially. Satori returned far less context than native for mutation
discovery and call-graph discovery; raw command latency alone is not a quality
or agent-step comparison.

Final live artifacts for the tested code state:

- Diagnostic:
  `.satori/benchmarks/live-latency/2026-07-14T19-02-04-188Z-diagnostic-search-quality-no-change.json`,
  SHA-256 `7ea7caa85ebe44ab0d718218e206e66f77e077db3959ca4f2d087393f76bcee1`.
- Satori/native/previous comparison:
  `.satori/benchmarks/live-latency/2026-07-14T19-02-50-049Z-comparison-search-quality-no-change.json`,
  SHA-256 `3c908c59abb1f09acc4230fff3daa9d1c182a2582115ace2b6a57864ed3b2ccb`.
- Watcher-disabled control:
  `.satori/benchmarks/live-latency/2026-07-14T19-04-03-028Z-watcher-disabled-search-quality-control-no-sync.json`,
  SHA-256 `882b679256b82d2bbf79946bfb7338ef48a60fb72bca8775a0f7ea7bbf6f72e4`.
- Fresh disabled-watcher status:
  `.satori/benchmarks/live-latency/2026-07-14T19-03-39-772Z-status-watcher-disabled-status.json`,
  SHA-256 `02303de3979b272df49d160e417647d761e696bdc7b0d67682640db6f397feb1`.

The benchmarked implementation identity was HEAD
`1a01969eff7b6300bb9609efc7843a5eb3f9ba5b`, tracked-diff SHA-256
`0e9773b37855aa47f1f5620b6e3b2991330217c411b7fbd23a88ee64b8a6648e`,
staged-diff SHA-256
`8b63b37098d276994d13363f6c89ef54ce20ec0ba39e5376d373bce6ae33305f`,
plus the untracked manifest embedded in each artifact. Runtime version was
Satori MCP 6.0.0 with VoyageAI `voyage-code-3`, dimension 1024, Milvus
`hybrid_v3`, and the full parser/extractor/relationship fingerprint recorded in
the status artifact. Provider credentials are not stored.

The watcher-disabled warm control was run after a separate full status proof and
with in-run sync skipped to avoid conflating watcher behavior with a just-started
mutation operation. It returned `ok` in 595.1 ms, kept vector authority usable,
reported `SOURCE_FRESHNESS_UNVERIFIED`, exposed reason `watcher_disabled`, and
performed one warm revalidation with zero cold checks, recounts, registry loads,
navigation validations or provider calls.

Controlled focused harnesses also prove:

- proof expiry produces `proofMode=cold`,
  `invalidationReason=proof_expired`,
  `auditClassification=proof_expiry_audit`, one cold check and one exact recount;
- an expired proof is not retained or replaced by a shallower parent proof;
- missing or corrupt generation checkpoints disable incremental sync while
  preserving vector use with the source-checkpoint warning;
- mutation completion after cached-receipt validation forces a new proof;
- watcher maintenance failure preserves successful exact/vector results.

Repository validation after the final production diff: Core 403/403, MCP
884/884, CLI 112/112, integration 30/30, repository scripts 60/60, hermetic
corpus 95 observations with deterministic repeat, root lint/typecheck/version
checks, full workspace build, and `git diff --check` are green.

After this journal was updated, the live authority correctly refused incremental
sync because its source checkpoint no longer matched a completed generation.
The explicitly authorized reindex completed as operation
`8b2eb559-3016-4abe-acc5-262b48279f26`, generation 2775, with 395 files, 8,758
chunks, compatible navigation evidence and `symbol_rich` status. After mutation
lease release, sync generation 2776 returned
`{ added: 0, removed: 0, modified: 0 }`. This was index-state recovery; no code
change was made in response.

## Recommendation disposition

| Investigation item | Current disposition | Evidence / next gate |
|---|---|---|
| 7.1 Deterministic quality and economic instrumentation | Implemented and accepted | Schema-2 corpus has 19 workloads x five limits. Debug/telemetry and the live recorder expose route, retrieval/provider/reranker work, candidate sources, expansion, response bytes, family counts, readiness operations and actual returned count without query/source content. Focused contracts and live trace correlation are green. |
| 7.2 Remove non-gating hybrid liveness query | Implemented and accepted | Zero probe calls; corpus otherwise identical; missing-collection failure preserved. |
| 7.3 Explicit route contracts | Implemented and accepted; descriptive-field cleanup not justified | Nine typed routes and bounded debug reason are present. Broad `where is` routing was corrected and corpus-covered. Exact ownership and caller/callee routes now execute through validated registry/relationship evidence with conservative fallback. Duplicate pure planning remains documented because no runtime divergence is proven. |
| 7.4 Real no-embedding lexical/sparse route | Implemented, corrected and accepted | Quality and role coverage unchanged; 35 embedding and dense calls removed; SDK/REST parity, dirty-path safety, provider selection and remote failure tests green. Optional direct sparse capability now falls back to one sparse-only `hybridSearch` request with zero embedding/dense calls. |
| 7.5 Evidence-triggered semantic expansion | Implemented and accepted, with one open falsification case | Unconditional removal was measured and rejected; the bounded gate removes 35 further embedding/dense calls with improved reciprocal rank, role coverage and duplicate-family rate. Sufficiency still counts chunks; change it only after an expansion-specific repeated-owner failure. |
| 7.6 Owner-family deduplication and adaptive rerank budget | Implemented, corrected and accepted | Immutable owner-instance/key families, exact-chunk fallback, up to two supplemental chunks in owner-fair rounds, adaptive budget, failure restoration and exact provider counters are covered. The repeated-owner corpus places relevant evidence only in the third family member and recovers owner rank one at all limits. |
| 7.7 Role-enriched reranker documents | Cost regression proven; quality benefit unmeasured; reverted | Reranker bytes regressed 44,685 -> 68,250 (+52.7%). Manifest ordering made the hermetic reranker content-insensitive, so a live/content-sensitive evaluation is required for any quality conclusion. |
| 7.8 Role and context-budget evidence selection | Deferred with measured justification | All 95 budgets pass; max response 4,326 bytes; architecture reaches 5/5 roles at limit 5 in 3,301 bytes. Trustworthy group roles are incomplete, so heuristic allocation would add risk without a measured gap. |
| 7.9 Calibrated fusion and confidence | Deferred with measured justification | The 19 scripted workloads have no held-out slice. Tuning the two repeated rank-two classes would overfit and would not solve structural caller routing. |
| 7.10 Generation-bound caches | Deferred with measured justification | Identical diagnostic repetitions reissue one embedding, dense, sparse and reranker call, but the repetition is imposed by the benchmark and does not establish user-query frequency. Add cache identity/source-warning/memory complexity only after a real paired-agent or workload trace shows repeated queries on one generation. |
| 7.11 Index metadata or chunk changes | Deferred with measured justification | The live conceptual trace presented 17 candidates from 17 owner families with zero supplemental duplicates; the hermetic repeated-owner case is already recovered before reranking. No remaining family-noise failure justifies an indexing-contract/reindex change. |

## Validation ledger

| Phase | Command / evidence | Result |
|---|---|---|
| Corpus determinism | `node --import tsx --test ../../evals/search-quality/search-quality-evaluation.test.ts` from `packages/mcp` | Green; 19 workloads x 5 limits, evaluator repeated twice. |
| No-probe focused Core behavior | Core `context.test.ts` with name pattern `Context hybrid search` | Green; 2 tests. |
| No-probe type safety | `pnpm --filter @zokizuan/satori-core typecheck` | Green. |
| No-probe corpus comparison | Baseline artifact versus `/tmp/satori-search-quality-after-no-probe.json` with the probe field removed | Exact equality; probe calls 135 -> 0. |
| Route contracts | Focused query-support and compact-contract tests | Green; 11 tests. |
| Route type safety | MCP typecheck | Green. |
| Route corpus comparison | Baseline artifact versus `/tmp/satori-search-quality-after-routing.json`, excluding route diagnostics and the removed probe | Exact equality. |
| Route determinism | Hermetic evaluation test after route addition | Green; repeated 85-observation output. |
| Sparse adapter parity | Core `milvus-sparse-search.test.ts` | Green; SDK and REST each issue one filtered BM25 request. |
| Sparse Core routing | Focused `Context` lexical and sparse failure tests | Green; zero embedding/dense/hybrid calls, one sparse call, collection failure preserved. |
| Sparse public provider gate | Focused `search_codebase.test.ts` | Green; lexical route requests `vector_only`, conceptual route requests `embedding_vector`. |
| Sparse dirty-path safety | Focused MCP scope tests | Green; stale dirty candidates suppressed, current-source replacement and unavailable warning preserved. |
| Sparse corpus comparison | Baseline versus `2026-07-15-search-quality-after-sparse.json` | Owner rank, reciprocal rank and role coverage unchanged; provider and context costs reduced as recorded above. |
| Primary-only expansion experiment | Expanded-pass fault injection across the corpus | Rejected: owner-at-one, reciprocal rank and role coverage regressed despite 50 fewer embedding/dense calls. |
| Expansion decision contract | Focused `search-execution-expansion.test.ts` | Green; deterministic skip, retain and primary-failure reasons covered. |
| Expansion failure behavior | Focused MCP search-pass tests | Green; primary failure falls back, expanded failure preserves primary results with warning, all-pass failure remains explicit. |
| Conditional expansion corpus | `2026-07-15-search-quality-after-expansion.json` | Green; no per-workload regression, 35 further embedding/dense calls removed, quality and context metrics improved. |
| Rerank family policy | Focused `search-rerank-policy.test.ts` and handler rerank tests | Green; distinct owners first, up to two supplemental chunks in owner-fair rounds, third-member split-owner retention, missing-owner isolation, adaptive budget, shuffled-row stability and failure restoration. |
| Review routing correction | Focused query-support tests and `conceptual_where_is` corpus workload | Green; three broad conceptual `where is` cases remain conceptual, exact identifier target remains ownership, and all five corpus limits return the owner at rank one. |
| Review split-owner correction | Focused red/green policy test and `split_owner_relevant_body` corpus workload | Green; only the third owner-family member contains relevant behavior, it reaches reranking behind a competing owner and generic sibling, and the owner family ranks first at all five limits. |
| Structural ownership/reference execution | Focused planner and handler tests | Green; exact ownership and caller discovery use registry/relationship evidence with zero provider work. Ambiguity, unavailable navigation, empty relationships, dirty target/peer, and limit-one ordering are covered. |
| Production scalar diagnostics | Exact registry, sparse literal, conceptual primary-only, expanded-pass failure, reranker, and tool telemetry tests | Green; provider counts and reranker bytes match actual bounded calls; telemetry omits query/source text and retired `parallel_fanout`. |
| Returned-result telemetry | Tool response with nine candidates before filtering, five eligible, and one returned | Green; telemetry reports 9 before, 5 after, and 1 returned rather than copying the eligible count. |
| Review-fix corpus | `2026-07-15-search-quality-after-review-fixes.json` | Green; 95 observations. All 85 overlapping observations retain identical quality/result/provider behavior; response delta is -21 bytes total. |
| Sparse capability fallback | Core direct-sparse/fallback tests and MCP degraded-navigation lifecycle test | Green; fallback issues one sparse hybrid request, performs zero embedding/dense calls, preserves `lexical_rank`, and keeps vector search usable when exact navigation degrades. |
| Canonical owner restoration | Canonical-owner handler test plus full affected handler suites | Green; Core owner precedes the public tool adapter, adapter remains eligible with neutral owner fit, and no global score constant changed. |
| Post-capability corpus | `2026-07-15-search-quality-after-capability-owner-fix.json` | Green; 95 observations and zero quality/result/provider/route/warning/budget differences from the prior accepted artifact. |
| Post-structural corpus | `2026-07-15-search-quality-after-structural-routes.json` | Green; ownership/reference routes remove ten complete provider passes, caller owner rank improves to one at every limit, aggregate quality improves, and the long-owner case remains rank one. |
| Artifact identity repeatability | Two consecutive evaluator writes to the same repository output path | Green; HEAD, index tree, staged/unstaged diff hashes and working-tree content hash are byte-identical because the exact generated output path is excluded from its own identity. |
| Role-enriched reranker experiment | First after-rerank corpus run | Reverted: input bytes 44,685 -> 68,250. Quality was not measurable because the hermetic reranker ordering ignores document content. |
| Rerank MCP type safety | `pnpm typecheck` from `packages/mcp` | Green. |
| Broad MCP package gate | `pnpm test` from `packages/mcp` | Green; 884/884 after structural routing and fallback/fencing coverage. |
| Post-review architecture audit | Current staged, unstaged and untracked diff; graph trace and first-party adapter inspection | Optional sparse capability became a proven runtime defect and is fixed. Duplicate pure planning remains unchanged because no divergence is proven. Expansion family-count falsification remains conditional. |
| Live benchmark recorder contract | `node --test scripts/satori-live-latency-benchmark.test.mjs` and `pnpm test:scripts` | Green; 6 focused benchmark tests and 60/60 repository script tests. Recorder now persists current provider/family/readiness evidence and rejects non-zero or missing sync statistics. |
| Live no-change diagnostic | `2026-07-14T19-02-04-188Z-diagnostic-search-quality-no-change.json` | Green; sync +0/-0/~0, exact median 586.9 ms, semantic median 1,931.2 ms, outline median 552.9 ms. Warm exact has zero provider work; semantic skips expansion and makes one bounded provider pass. |
| Live previous/native comparison | `2026-07-14T19-02-50-049Z-comparison-search-quality-no-change.json` | Recorded; all eight read workloads succeed. Native conceptual/architecture rows remain lexical task comparators, not semantic equivalents; one-sample provider variability is reported separately from the three-sample warm diagnostic. |
| Watcher-disabled control | Fresh status artifact plus `2026-07-14T19-04-03-028Z-watcher-disabled-search-quality-control-no-sync.json` | Green; warm vector search remains `ok`, source freshness is unverified with reason `watcher_disabled`, and readiness/provider counters remain warm/zero as required. |
| Controlled proof/checkpoint/mutation controls | Focused handler, front-door, sync and prepared-read-cache tests | Green; 5 targeted cross-file cases plus 10/10 prepared-cache cases prove proof-expiry audit, expired-proof eviction, checkpoint degradation, mutation reproof and watcher-failure preservation. |
| Full Core package gate | `pnpm --filter @zokizuan/satori-core test` | Green; 403/403. |
| Full CLI package gate | `pnpm --filter @zokizuan/satori-cli test` | Green; 112/112. |
| Full integration gate | `pnpm test:integration` | Green; 30/30. |
| Repository static/build gate | `pnpm check` and `pnpm build` | Green; all-package lint/typecheck, version freshness, generated docs/manifest and full workspace build. |
| OpenCode paired-agent harness | `evals/agent-discovery/run-opencode.mjs`, restricted agents/guard, fixed v2 task key, and focused script tests | Implemented; task/arm/profile questions are removed, exact and conceptual tasks are automatic, sessions are isolated, arm order alternates, forbidden tools are rejected, OpenCode events own timing/tokens/steps, and the final report compares correct native/Satori runs. Current AST spans are validated before model calls. |
| External paired-agent evaluation | `pnpm eval:agent-discovery` with pinned `opencode/deepseek-v4-flash-free` and OpenCode 1.17.20 | Pending the clean-tree 12-arm run. A read-only OpenCode smoke call proved restricted Satori tool exposure and caught guard-hook boundary errors before acceptance. The executable fails before measured calls when Satori readiness is not `ok`. |
| Diff hygiene | `git diff --check` | Green. |
