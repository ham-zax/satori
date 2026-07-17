# LanceDB Search Tuning and Agent-Answer Qualification Plan

**Status:** Phase 0/1 authority and diagnostics are complete. The frozen Phase 2
experiment is complete and negative: all four predeclared tuning contenders
failed the `+1` owner-survival gate, no finalist was selected, validation remains
unrevealed, and the production baseline is retained. Phase 3 infrastructure
steps 1–5 are complete, but smaller-disclosure and agent-answer qualification
remain pending. Phase 4 and Phase 5 have not been admitted.
**Date:** 2026-07-17
**Related implementation authority:**
`docs/release/2026-07-15-lancedb-voyage-offline-plan.md`, current code under
`packages/core` and `packages/mcp`, and the immutable connected-storage evidence
under
`~/satori-evidence/vector-stacks/6e4aaf792b2083756cb98a7290910c6fdda63249/`.

**Implementation policy:** change production behavior only after a real
correctness, reproducibility, or measured retrieval-quality gap is localized to
the owner being changed. Do not tune against aggregate backend agreement alone.

---

## Executive decision

LanceDB is operationally qualified and appears practically useful on the
available owner-search tasks. It is substantially faster in the connected
storage comparison, but broader agent-answer quality and hard-miss frequency
are not yet qualified.

The objective is not to make LanceDB reproduce Milvus ordering. It is to:

1. eliminate avoidable hard misses;
2. ensure the correct evidence reaches the agent under the real progressive-
   disclosure policy;
3. separate retrieval recall, reranker admission, and visible-response budgets
   so a smaller answer does not silently search a smaller candidate set;
4. minimize extra searches, expansions, context bytes, and provider work; and
5. preserve LanceDB's local latency advantage.

The first work is query-time diagnostics and replay. It does not require a full
reindex or new Voyage document embeddings. Multi-field lexical projections are
a later option only if query-time tuning leaves proven hard misses.

Milvus remains supported. This plan does not retire it, impose a shared ranking
profile, or add a collection-count limit to LanceDB.

---

## 1. Evidence baseline and limits

### 1.1 Authoritative connected-storage comparison

The corrected Milvus/Voyage and LanceDB/Voyage comparison used one clean
runtime at revision `6e4aaf792b2083756cb98a7290910c6fdda63249`, the same
Voyage `voyage-code-3` 1024-dimensional embeddings, the same reranker policy,
and separately frozen publications. Four tasks were each observed once cold and
five times warm, producing 24 observations per arm.

`topResultMatches: 12/24` is backend agreement, not correctness and not 24
independent semantic questions:

| Retrieval class | Same top result | Exact order | Mean Jaccard |
|---|---:|---:|---:|
| Lexical | 6/6 | 6/6 | 1.000000 |
| Structural | 6/6 | 0/6 | 0.302326 |
| Hybrid | 0/6 | 0/6 | 0.454545 |
| Configuration | 0/6 | 0/6 | 0.274510 |

Expected-owner-in-top-three on the four cold tasks was 2/4 for Milvus and 1/4
for LanceDB. That set is too small to establish general semantic quality.

### 1.2 Provisional fifteen-query bakeoff

The separate human-judged owner-search bakeoff reported:

| Measure | Milvus | LanceDB |
|---|---:|---:|
| Query wins | 3 | 2 |
| Ties | 10 | 10 |
| Relevance sum | 67 | 64 |
| Primary owner in top five | 14/15 | 13/15 |
| Mean latency | 4,966.8 ms | 1,558.1 ms |
| Median latency | 5,449 ms | 1,212 ms |

The raw values establish two different ratios:

- mean-latency ratio: `4,966.8 / 1,558.1 = 3.19x`;
- median-latency ratio: `5,449 / 1,212 = 4.50x`.

The previously reported “about 3.2x” value is therefore a correct statement
about the **mean** of these fifteen one-shot observations. It is not the frozen
comparison's warm-p50 ratio, even though that independently happens to be about
3.21x (`2,250 / 701`). Future reports must name the statistic and experiment.

This bakeoff is provisional because its raw files remain under `/tmp`, and it
does not freeze the answer key, scoring ledger, runtime identity, publication
receipt, disclosure rule, or repetition rule. It suggests a narrow Milvus
ranking advantage and one concrete LanceDB hard miss; it does not prove final
agent-answer success.

### 1.3 Owner rank is a proxy, not the product outcome

The product question is:

> Did the agent reach the correct answer within the configured disclosure,
> context, latency, and tool-call budgets?

Record these distinct stages:

1. expected owner present in raw backend candidates;
2. retained after Core dense/lexical fusion;
3. retained after MCP multi-pass fusion and filtering;
4. admitted to reranker input;
5. retained and ranked after reranking;
6. retained after owner grouping and diversity;
7. visible in the initial response;
8. reached after supported expansion or follow-up search;
9. used in a correct final answer.

An owner at rank five can be useful or effectively hidden depending on the
actual disclosure budget. An owner absent from the candidate set cannot be
recovered by reranking.

### 1.4 Response-size, recorder, and contamination findings

The frozen connected-storage tasks used `debugMode: "full"` and did not supply
an explicit result limit. Under the connected Voyage capability profile, that
means the existing default limit can reach 50 groups. The largest 44–70 KB
responses are therefore **full diagnostic responses**, not ordinary product
responses.

Reprojecting the same frozen responses after removing each result's `debug`
member gives this diagnostic estimate of the normal grouped envelope:

| Arm | Full-debug cold response range | Normal-projection range | Largest returned group count |
|---|---:|---:|---:|
| Milvus/Voyage | 5,974–70,255 bytes | 5,343–33,610 bytes | 50 |
| LanceDB/Voyage | 5,972–44,440 bytes | 5,341–22,027 bytes | 30 |

This estimate is not a replacement for a clean normal-mode measurement. It
does establish that response size remains a real agent-context concern after
the diagnostic payload is removed. Future qualification records normal and
full-debug response sizes separately.

The reported `ts` and `json` pseudo-symbols are a recorder defect, not the
current product presentation. Product output correctly represents those rows
as file-level results such as `file path/to/file.ts:1`. The recorder currently
parses the final identifier from `displayLabel` and can reinterpret the file
extension as a symbol. The qualification schema must preserve a tagged union:

```ts
type RecordedResultIdentity =
    | { kind: "symbol"; file: string; symbol: string }
    | { kind: "file"; file: string };
```

Finally, the connected-storage task definitions were stored inside the indexed
repository, and one task retrieved its own `tasks.json` fixture. That does not
invalidate lifecycle or latency evidence, but it contaminates semantic-quality
claims. Every evaluation-authority artifact—tasks, expected-owner ledgers,
rubrics, prompts, and judge fixtures—must live outside the indexed corpus or be
excluded by an evaluation-specific, recorded ignore policy. If any such
artifact appears at any candidate stage, invalidate the run or create a clean
publication; never silently filter it after retrieval.

---

## 2. Current implementation baseline

### 2.1 Retrieval and fusion

Current hybrid retrieval is intentionally split across two ownership layers:

```text
Core vector retrieval
  dense arm + lexical arm
  → equal-arm RRF, k=100

MCP search execution
  primary / expanded / tracked lexical / live-path / dirty-overlay passes
  → pass RRF, k=60
  → lexical, path, changed-file, and agent-fit scoring
  → optional Voyage reranker, at most 50 selected candidates, rank k=10
  → exact-match pinning, owner grouping, and diversity
```

The initial candidate-depth policy is still:

```ts
Math.min(Math.max(resultLimit * 8, 32), 80)
```

Core's backend-arm fusion currently returns `rrf_fusion` without preserving the
dense and lexical source ranks through every later stage. MCP records pass and
backend-score-kind provenance, but that is insufficient to reconstruct raw arm
survival for a hybrid result. Instrumentation must close this observability gap
before tuning either RRF layer.

Adding another generic hybrid layer is not a goal. Any change must identify the
stage that lost the expected candidate.

### 2.2 LanceDB dense retrieval

The LanceDB adapter performs exhaustive cosine retrieval with
`bypassVectorIndex()` and converts native distance to a higher-is-better score.
ANN parameter tuning is therefore not the first relevance lever.

### 2.3 LanceDB lexical retrieval

The adapter currently searches one Core-produced `lexicalText` field with a
typed `MatchQuery` using `Operator.And`.

The current FTS index is explicitly configured for code rather than LanceDB's
prose-oriented defaults:

```text
baseTokenizer: simple
withPosition: true
maxTokenLength: 255
lowercase: false
stem: false
removeStopWords: false
asciiFolding: false
```

Consequences:

- phrase queries are structurally supported now because positions are stored
  and stop words are retained;
- typed fuzzy `MatchQuery` is a query-time option;
- a typed `Operator.Or` fallback is a query-time option;
- n-gram substring retrieval requires a differently built FTS index;
- per-field `MultiMatchQuery` boosts require separate indexed columns and a new
  lexical schema/projection.

Do not put literal `AND` or `OR` tokens into an ordinary FTS query string.
Core should own the term plan and fallback decision; the adapter should only
translate that typed policy to LanceDB queries.

### 2.4 What the aggregate diagnostics suggest—and do not prove

The frozen comparison counted:

| Diagnostic total | Milvus | LanceDB |
|---|---:|---:|
| Candidates with semantic evidence | 684 | 864 |
| Candidates with lexical evidence | 396 | 102 |
| Reranker calls | 12 | 12 |
| Reranker candidates | 522 | 588 |

This makes weak LanceDB lexical contribution a strong hypothesis. It is not yet
a root-cause diagnosis: totals can differ because of raw matches, AND semantics,
tokenization, candidate limits, duplicate identities, fusion loss, grouping, or
repeated evidence accounting.

### 2.5 Retrieval, reranker, and disclosure are currently coupled

The current search `limit` is not only a presentation limit. MCP passes it to
`resolveSearchPolicy()`, where it controls the bounded 32-to-80 candidate-depth
formula, and later passes it to owner grouping/diversity to select visible
groups. Lowering the default visible result count to 3–6 without first splitting
these responsibilities could hide the correct owner **and** prevent it from
being retrieved or reranked.

Current grouping already enforces useful diversity before returning results:

- normally at most two groups per file;
- at most one group per symbol when grouping by symbol; and
- a relaxed file cap of three when needed to fill the requested limit.

The missing boundary is a final exact response budget. The grouped envelope
projects every selected group and has no final UTF-8 byte ceiling. The reranker
has a fixed candidate-count ceiling and per-candidate content limits, but no
single aggregate input-byte contract. The target policy therefore needs five
separate values:

```text
retrieval candidate budget
reranker candidate budget
reranker aggregate UTF-8 input-byte budget
initial disclosure group budget
final response UTF-8 byte budget
```

The same policy caps apply to both backends. Actual usage may differ because
candidate generation differs; diagnostics record source, count, and exact
UTF-8 bytes so that difference is visible rather than silently normalized.

### 2.6 Freshness is a dependency, not another ranking parameter

`docs/plans/INCREMENTAL_INDEX_FRESHNESS_PLAN.md` owns the full freshness model.
This plan depends on two of its unfinished contracts:

1. A successful zero-change comparison must remain available as proof-bearing
   per-root evidence, so the response can say when disk was compared and that
   no changes were found. A later `skipped_recent` decision must not erase that
   fact or claim a new comparison.
2. Watcher events need covering epochs. An event arriving during a sync must
   force a follow-up unless the completed pass proves it covered that event.

Do not create a watcher-only build-artifact filter. Watch scheduling and
indexing must continue to use the same active ignore policy, including visibility
of ignore-control files. `manage_index sync` already serves as the explicit
agent “editing batch complete” signal; a second agent protocol is unnecessary.

Freshness copy is changed only with the evidence contract. After a proven
zero-change comparison it may say:

> Files were compared with the index at `<time>` and no changes were found.
> Continuous watching is disabled, so edits made after that time may not yet be
> indexed.

After restart or when comparison proof is unavailable, retain the weaker
`SOURCE_FRESHNESS_UNVERIFIED` warning. Do not infer a durable comparison from a
process-local timestamp alone.

---

## 3. Qualification contract

### 3.1 Frozen task and answer authority

Before observing a contender:

- freeze natural-language queries;
- freeze expected owner files and symbols;
- freeze acceptable alternate owners where the architecture genuinely has more
  than one correct entry point;
- freeze the final-answer rubric;
- freeze initial disclosure and permitted expansion rules;
- split tasks into tuning, validation, and sealed held-out evaluation sets;
- record full Git SHA, clean/dirty state, task hash, runtime and harness hashes,
  Node version, provider/model/dimension, backend identity, and publication
  receipt;
- freeze numerical acceptance gates for hard misses, final-answer
  non-inferiority, context bytes, expansions, follow-up searches, reranker
  candidates and bytes, latency regression, and the minimum validation gain
  required to adopt a contender; and
- freeze the answering-agent and judge contract: exact model identities, system
  prompt, tool schemas and descriptions, maximum tool calls, expansion policy,
  context budget, temperature and seed where supported, repetition rule, judge
  method, and human-adjudication rule.

Do not revise expected owners after seeing backend output. Fifteen tasks are too
few to tune several fusion parameters and also claim held-out quality. Do not
report cold p95 or percentage-style agent-quality claims when the frozen task or
repetition count is too small to support them; report the underlying counts and
observations instead.

Tune on the tuning tasks and select at most one smallest contender using the
validation tasks. Freeze its policy digest before revealing held-out results.
The held-out set runs once. If the contender fails its held-out gates, retain the
baseline; do not select a runner-up or retune against the revealed set. Candidate
supersets may be captured early to control provider cost, but held-out payloads
and diagnostics remain sealed until selection. Only their authority hashes are
visible before that point.

### 3.2 Stable candidate, owner, and evidence identities

One tuple cannot safely represent persisted candidates, logical owners, and
repeated evidence occurrences. Freeze three canonical JSON identities:

```ts
candidateId = persistedDocument.id;

ownerId = JSON.stringify([
  canonicalRelativePath,
  ownerSymbolInstanceId ?? null,
]);

evidenceOccurrenceId = JSON.stringify([
  candidateId,
  retrievalArm,
  retrievalPass,
  sourceRank,
]);
```

`candidateId` is scoped to the frozen publication receipt. `ownerId` may be
file-level when no symbol instance exists. Line ranges, language, scores, and
grouping labels are attributes, not identity components: expansion or grouping
must not turn one persisted candidate into several unique candidates merely
because its displayed range changed.

`evidenceOccurrenceId` is additionally scoped to the frozen query, policy, and
candidate capture. The enclosing artifact records those authorities rather
than redundantly embedding them in every occurrence key.

Diagnostics must distinguish unique candidates, unique owners, and total
evidence occurrences. Every deduplication and grouping decision must state
which identity it uses.

### 3.3 Frozen publication and mutation isolation

Evaluation flow:

```text
explicit zero-change sync
→ freeze publication receipt
→ disable watcher/background mutation during samples
→ capture/replay against published_index behavior or its harness equivalent
→ verify the same receipt before and after each live sample
```

Unexpected publication or mutation changes invalidate timing observations.

The public `published_index` freshness mode is a dependency, not an assumed
current capability. Until it exists, the evaluation harness must provide an
equivalent no-sync read path with watcher and background mutation disabled and
mandatory pre-read and post-read receipt validation. Detailed survival traces
belong in untimed runs. Timed runs disable tracing unless a frozen experiment
proves its overhead negligible.

### 3.4 Same-runtime policy comparison

Baseline and contender policies must execute in one immutable binary. The
evaluation entry point selects a frozen policy identifier such as `baseline` or
`contender-a`; it must not compare a capture from one revision with replay code
from another. Record the policy identifier, policy-document digest, executable
manifest, candidate-capture digest, and publication receipt with every result.

The same rule applies to final live validation: use one executable with a
frozen selector so the selected retrieval policy is the only intended software
difference.

Every candidate capture also freezes and records:

```text
exact query bytes and query-embedding hash
precise-AND and fallback-OR term lists
operators and fuzziness
canonical filters
MCP pass configuration
expansion rules
requested maximum depth
publication receipt
queryPlanDigest
passConfigurationDigest
```

`queryPlanDigest` canonically serializes the query bytes and embedding hash,
term lists, operators, fuzziness, filters, expansion rules, and maximum depth.
`passConfigurationDigest` canonically serializes the complete MCP pass plan.
The capture authority binds both digests to the publication receipt. A term,
filter, operator, fuzziness, pass, expansion, or depth change requires a new
declared capture. It must never silently reuse candidates produced by a
different query plan.

### 3.5 Required measures

Per query and per stage record:

- expected-owner presence and rank;
- unique candidate count;
- source arm/pass and source rank;
- score before and after each fusion/scoring stage;
- filter, deduplication, grouping, or diversity reason if removed;
- reranker admission and output rank;
- initial disclosure visibility;
- expansion and follow-up-search count;
- final answer correctness;
- context bytes, response bytes, latency, and tool calls;
- query-embedding and reranker calls, candidates, and input bytes.

Backend agreement is diagnostic only. The acceptance metrics are hard-miss rate,
agent-answer correctness, and the cost of reaching the answer.

Agent trials must either use a reproducible deterministic configuration and
state its limitations or run the frozen repetition count. Judges are blind to
backend and policy identity. Model/human disagreements use the predeclared
human-adjudication rule rather than an after-the-fact rubric change.

### 3.6 Progressive-disclosure binding

Expansion must operate on the ranked set already returned, not silently run a
new search. The evaluation harness must issue a result-set handle bound to:

```text
publication receipt
query and policy hash
ranked-result-set digest
disclosure-policy version
```

Each expansion reads the next permitted evidence from that same set and rejects
a stale publication or policy. A new retrieval request is a follow-up search
and is counted separately. This is initially a harness contract; it becomes a
public runtime contract only if the product exposes progressive expansion.

The public response contract, if admitted, is additive and deterministic:

```ts
interface SearchDisclosureSummary {
    policyVersion: "search_disclosure_v1";
    availableGroupCount: number;
    returnedGroupCount: number;
    omittedGroupCount: number;
    truncated: boolean;
    reasons: Array<
        "initial_budget"
        | "caller_limit"
        | "utf8_byte_budget"
        | "group_content_truncated"
    >;
}
```

Apply the exact UTF-8 JSON byte ceiling after final grouping and response
projection. Publication/freshness authority, warnings, and the recommended next
action are mandatory envelope fields and are never dropped to fit result
content. Full debug output has a separate, explicitly larger diagnostic budget
and is measured separately from normal output.

Add complete groups in deterministic order while they fit. Never byte-slice
serialized JSON. If the first group alone exceeds the envelope budget, preserve
its authority and target metadata and truncate only its content at a UTF-8-safe
boundary, or return metadata and the bounded snippet alone. Report
`group_content_truncated`; full source remains available through the existing
source-reading tools.

Initial disclosure uses a small set of frozen categorical policy classes such
as `compact`, `standard`, and `wide`, based on query type, exact-match evidence,
route agreement, and conflict/uncertainty facts. Do not tune page size from raw
score gaps until those scores are calibrated across providers and backends. Do
not aggressively reduce the initial page before stable continuation exists and
the agent-answer gate proves the correct evidence remains reachable.

The result-set handle owns already-ranked and already-grouped DTOs, not raw
backend candidates and not a recipe for rerunning search. Its cache entry binds:

```text
canonical root
publication receipt and mutation/source observation
query, operator, scope, grouping, ranking, and policy digest
disclosure-policy version
ordered frozen result DTOs plus cross-page diversity state
creation time and expiry
```

The initial implementation may be process-local, but it must be a bounded LRU
by entry count **and** UTF-8 bytes. Handles are opaque. Restart means expired;
publication or policy drift means stale. Continuation performs no query
embedding, database retrieval, or reranking. Existing source-reading tools
remain the mechanism for expanding file content; continuation primarily exposes
more groups from the frozen set.

Current diversity selection stops after the visible limit. Pagination cannot
rerun that truncating pass independently for each page because it could repeat
files, violate caps, or permanently discard later groups. The frozen result set
must either retain the complete deterministic disclosure order or retain the
selection state needed to continue the same diversity pass.

---

## 4. Provider and reindex cost ceiling

Voyage document embedding is the expensive boundary. This plan deliberately
separates it from query-time search tuning.

### Phases 0–3

- Full document reindexes: **zero**.
- New document embeddings: **zero**.
- Reuse current compatible LanceDB and Milvus publications.
- Cache each query embedding by provider, model, dimension, normalization
  policy, and exact query bytes.
- Capture one declared maximum superset per unique query: dense top 160,
  precise-AND lexical top 160, conditional-OR lexical top 160, and every MCP
  pass output required by the frozen replay contract.
- Replay fusion, quotas, and candidate depths locally from captured candidates.
- Cache reranker results only for the exact ordered candidate payload. A policy
  that admits unseen candidates requires a new reranker call and must be counted,
  not described as free replay.

Offline replay measures relevance, survival, and fusion behavior. It cannot
measure database latency at a smaller requested depth, the live cost of the
additional OR request, or complete end-to-end latency. Measure those separately
with frozen-publication live queries, then run only the baseline and smallest
successful contender end to end.

Before executing the suite, freeze separate numerical budgets for:

- Voyage query-embedding calls and input bytes;
- Voyage reranker calls, candidate count, and input bytes;
- answering-agent calls, input/output tokens, and tool calls;
- model-judge calls and input/output tokens; and
- human adjudications.

Parameter grids run from cached candidates. Live end-to-end qualification uses
the frozen repetition count. When shared Core/MCP behavior changes, its final
matrix is `baseline | contender` by `LanceDB | Milvus`; each cell uses the same
binary, tasks, agent, judge, and repetition rule. A backend-specific contender
does not create an unrelated Milvus matrix, but it still must not alter shared
behavior. Cached replay cannot substitute for the live matrix's latency or
agent/provider-cost evidence.

The manifest calculates and approves the total calls, tokens, candidates,
bytes, and adjudications implied by that matrix before execution. Expanding the
budget requires an explicit evidence-based decision, not an automatic retry
loop. None of these query-time or agent runs requires a document reindex.

### Phase 4, only if index-changing work is admitted

- Planned full LanceDB/Voyage reindexes: **one**.
- Contingency after a proven schema/harness defect: **one**.
- Milvus reindex: **zero** only if the change is proven not to alter Milvus's
  persisted schema, projection versions, or compatibility fingerprint.
- Stop after the contingency; diagnose rather than purchasing more reindexes.

If a shared Core projection or schema change invalidates Milvus publications,
stop and establish a separate backend-compatibility and requalification plan.
Do not silently spend another reindex or claim that a Lance-only migration is
safe.

If the lifecycle can mechanically rebuild lexical state while proving reuse of
compatible dense vectors, that optimization needs its own authority and tests.
Do not assume partial rebuild safety merely because the embedding projection did
not change.

This budget is not a product limit. Local LanceDB has no Satori collection-count
cap. Zilliz collection and vector-field quotas are separate hosted-service
limits and must not constrain LanceDB. As documented on 2026-07-17, Zilliz Free
allows five collections, Serverless allows 100 collections, and both allow four
vector fields per collection.

---

## 5. Phased work

Execute the phases in this order:

1. correct recorder identity, separate normal/debug measurements, and remove
   evaluation-authority contamination from the semantic suite;
2. freeze identities, tasks, agent/disclosure contract, and numerical gates;
3. add bounded survival tracing;
4. capture the maximum dense, AND, OR, and MCP-pass supersets;
5. prove that `policy=baseline` in the shared binary reproduces the frozen
   baseline capture;
6. localize the ignore-reconciliation hard miss;
7. test conditional OR fallback and source quotas;
8. replay fusion and depth contenders in one executable;
9. split retrieval, reranker, and disclosure budgets before shrinking visible
   responses;
10. measure live latency for only the baseline and smallest successful
    contender;
11. run held-out progressive-disclosure qualification on both backends; and
12. admit a multi-field lexical schema only if a hard miss remains localized to
   lexical retrieval.

### Phase 0 — preserve and correct evidence

1. Move or reproduce the fifteen-query raw results outside `/tmp`.
2. Correct the recorder's result identity to preserve file-level versus
   symbol-level results and add the exact `#`-collision regression examples.
3. Measure normal and full-debug response bytes separately; do not present the
   diagnostic maximum as the ordinary product envelope.
4. Move every semantic evaluation-authority artifact—tasks, expected-owner
   ledgers, rubrics, prompts, and judge fixtures—outside the indexed corpus or
   exclude it with a frozen evaluation-specific ignore policy. Fail
   qualification if any authority path appears at any candidate stage; do not
   post-filter it. Report exact query-text matches in the corpus as
   contamination diagnostics.
5. Freeze the queries, expected-owner ledger, scoring rubric, and source/runtime
   identities before any new run.
6. Freeze the answering-agent contract, disclosure policy,
   tuning/validation/held-out split, repetition rule, and numerical acceptance
   gates before observing a contender.
7. Freeze the candidate, owner, and evidence-occurrence identity encodings.
8. Record both latency statistics explicitly:
   - mean: 4,966.8 ms versus 1,558.1 ms, ratio 3.19x;
   - median: 5,449 ms versus 1,212 ms, ratio 4.50x.
9. Keep the original run labeled exploratory; do not retrofit missing authority.
10. Preserve the known ignore-reconciliation query as a tuning regression. It
    cannot count as held-out improvement because its baseline outcome is already
    known.

Exit: evidence can be reproduced and no statistic is transferred between the
exploratory and frozen experiments.

### Phase 1 — candidate-survival diagnostics

Add bounded evaluation/debug diagnostics at these boundaries:

```text
raw dense
raw precise lexical
raw lexical fallback, when attempted
Core fusion
MCP fusion and filters
reranker selection
reranker output
grouping/diversity
initial disclosure
expansion/follow-up
```

Requirements:

- preserve dense/lexical source rank and membership through Core fusion;
- report removal reasons deterministically;
- record unique candidate and owner identities as well as evidence occurrences;
- keep detailed traces behind evaluation or bounded debug mode;
- do not expand the default MCP response with unbounded candidate dumps;
- add focused synthetic tests where the expected candidate is lost at each
  individual boundary.

Exit: the Q8 hard miss and every tuning/validation miss can be localized to one
first losing stage. Any miss revealed by the one final held-out run receives the
same post-run diagnosis, but cannot feed another contender selection.

### Phase 2 — query-time experiments without reindexing

Run one-variable-at-a-time experiments from one maximum candidate superset. The
baseline and all contenders execute in the same binary through the frozen policy
selector.

Execution result on 2026-07-18:

- one status-only top-160 LanceDB/Voyage capture completed against a single
  stable publication with 28/28 observations;
- exact baseline replay reproduced all 14 tasks, including 12 fusion routes and
  two policy-invariant exact-registry routes;
- conditional OR fallback, precise lexical fallback, candidate depth 120, and
  lexical weight 1.5 each produced zero qualifying owner-survival gain;
- no contender was selected, validation was not replayed or scored, and normal
  production ranking remains unchanged; and
- the frozen inputs, observations, capture, replays, scores, selection ledger,
  and committed harness manifest are checksum-verified under
  `~/satori-evidence/search-phase2/648b47518c642410de713c01041ad17476feeab6/`.

The live capture consumed 20 reranker calls, 994 candidates, and 1,575,518
reranker document UTF-8 bytes. Capture replay and scoring consumed no provider
calls, synchronization, document embedding, or reindexing.

Before replay, capture top 160 for dense, precise-AND lexical, conditional-OR
lexical, and each required MCP pass. Slice that immutable capture for depths 80,
120, and 160. A smaller baseline capture cannot support a deeper replay.

Before evaluating a contender, replay `policy=baseline` through the shared
binary and require exact reproduction of the frozen baseline ordering and all
policy-relevant diagnostics from the same capture. A mismatch means the shared
binary is not an authoritative baseline; stop and correct the harness or policy
implementation first.

Held-out supersets may be captured at this point, but their contents, owner
presence, ranks, and diagnostics are sealed. Before contender selection the
harness may expose only their hashes and capture-validity status.

#### 2A. Conditional OR fallback

1. Run the current typed AND query first.
2. Use the frozen query plan to select high-signal terms; do not require every
   natural-language filler word.
3. Trigger a bounded typed OR fallback only when measured lexical evidence is
   insufficient under a frozen rule.
4. Reserve a small, fixed number of unique fallback candidates rather than
   replacing precise lexical results.
5. Record fallback reason, term set, raw count, unique count, and owner rank.

The production owner split, if accepted, is:

- Core/query planning decides terms and whether fallback is allowed;
- the LanceDB adapter translates the typed policy to `MatchQuery` with
  `Operator.And` or `Operator.Or`;
- adapters do not invent semantic query terms.

#### 2B. Candidate-source quotas

Before the fixed reranker budget, test minimum representation for:

- dense candidates;
- precise lexical candidates;
- lexical-fallback candidates;
- exact path or identifier evidence.

Candidate quotas deduplicate by `candidateId`; owner diversity is measured and
enforced separately by `ownerId`. They do not increase the reranker or response
budget automatically.

#### 2C. Candidate-depth replay

Evaluate local arm depths `80`, `120`, and `160` in the harness. Replay measures
owner recall, fusion latency, unique candidates, candidate bytes, reranker
admissions, and final context. It does not measure database latency; collect
that with separate live frozen-publication queries for only the baseline and
smallest successful contender. Do not change the production maximum until
held-out evidence justifies it.

#### 2D. Fusion replay

Evaluate a small predeclared set of:

- Core RRF `k` values;
- dense/lexical weights;
- intent-aware weights based on an already-frozen query classification;
- normalized convex score combination;
- candidate quotas.

Because Satori has both Core and MCP RRF stages, replay must cover the complete
pipeline. Tuning the first RRF in isolation is not an acceptance result.

Exit: choose at most one smallest contender using tuning evidence only. Freeze
its policy digest before revealing validation exactly once. It must then satisfy
the predeclared validation non-regression measure without violating latency,
provider-work, or context budgets. If no tuning contender passes, or the frozen
finalist fails validation, retain the current policy without selecting a
runner-up. This experiment exited by retaining the baseline before validation.

### Phase 3 — progressive-disclosure and agent-answer qualification

Use the real grouped response and expansion policy, not only ranked arrays.

Implementation order inside this phase:

1. Split the retrieval-candidate budget from the visible group budget while
   preserving the existing retrieval baseline.
2. Add an aggregate exact UTF-8 reranker input-byte ceiling without increasing
   the existing candidate-count or provider-call budgets.
3. Build the complete deterministic grouped disclosure order; retain diversity
   state across pages.
4. Add the response disclosure summary and exact UTF-8 response ceiling.
5. Add the bounded, opaque result-set handle and continuation path.
6. Only then test smaller initial disclosure classes. Keep the existing visible
   default until the continuation contract and held-out reachability gate pass.

Implementation state on 2026-07-18:

- Steps 1–5 are implemented. Retrieval, reranker admission, and disclosure
  limits are separate; selected reranker document strings and grouped responses
  have exact UTF-8 byte guards; grouping freezes one diversity-preserving order;
  and `continue_search` pages a bounded process-local frozen result set.
- Continuation is bound to the proven vector generation, prepared authority,
  and the exact source-observation state, including unavailable `null` evidence.
  Authority or source drift is checked before and after projection. Exact cursor
  retries replay the prior serialized page; offset/limit conflict, expiry,
  process restart, and completed consumption fail with classified outcomes.
- Continuation performs no query embedding, storage retrieval, or reranking.
- Step 6 is deliberately not admitted. `disclosureLimit` is opt-in and omitting
  it preserves the existing visible-result count. A smaller default still
  requires the frozen held-out agent-answer gate on both backends.

This phase does not invent a second source-expansion mechanism. Agents continue
to use the existing file-reading tools for full source; the new continuation
path exposes more ranked groups from the original frozen search.

For each held-out task:

1. present the initial response exactly as a client receives it;
2. bind expansion to the original ranked-result-set handle;
3. allow only the frozen expansion/follow-up budget;
4. record which evidence was opened;
5. judge the final answer using the frozen blind-judgment contract;
6. record extra searches, source reads, context bytes, tool calls, and latency.

Run the sealed held-out set once after contender selection. If the contender
fails, retain the baseline. Do not choose another contender or adjust the
policy, rubric, disclosure budget, or gates using those revealed outcomes.

Primary gates:

- no regression in final-answer correctness versus the frozen baseline;
- hard misses do not increase; when the frozen baseline cell exhibits a hard
  miss under the predeclared rubric, the contender must remove at least one to
  support a hard-miss improvement claim;
- expected evidence visible within the allowed disclosure path;
- mandatory authority fields and warnings survive every byte-budget boundary;
- continuation returns the next groups from the frozen set without embedding,
  retrieval, or reranking, and fails deterministically when expired or stale;
- lowering visible disclosure does not lower retrieval or reranker admission
  unless a separately named contender intentionally changes those budgets;
- when the sample size supports them, bounded p50/p95 latency and context
  growth; otherwise the predeclared observation-level bounds;
- no unapproved increase in query embeddings or reranker work;
- if shared Core/MCP policy changed, Milvus stays within the frozen
  non-regression bounds for hard misses, final-answer correctness, context,
  provider work, and latency.

Run the held-out agent evaluation against both LanceDB and Milvus whenever the
shared query planner, fusion, quotas, reranking admission, grouping, or
disclosure policy changes. Query-time changes reuse the frozen publications and
do not require a Milvus reindex.

Exit: the product can state practical agent-answer quality, not merely owner
rank.

### Phase 4 — index-changing lexical design, only if still required

Admit this phase only when Phase 1 proves misses originate in lexical retrieval
and Phases 2–3 fail to correct them.

Candidate fields:

```text
path
symbol
breadcrumbs
identifierTokens
sourceContent
proseMetadata
```

Potential changes:

- Core emits a versioned multi-field lexical projection;
- the adapter persists and indexes supplied fields without enrichment;
- `MultiMatchQuery` applies frozen per-field boosts;
- original and normalized identifier aliases remain additive;
- n-gram indexing, if used, is isolated to a suitable identifier/path field
  rather than applied indiscriminately to source prose.

This is an indexing-format change. It requires a new lexical projection/schema
version, migration behavior, golden serialization tests, and the reindex budget
above. Do not change the embedding projection unless dense retrieval evidence
separately requires it. Before admitting a Lance-only reindex, prove that the
shared change leaves Milvus's persisted compatibility identity unchanged;
otherwise stop and use a separate backend-compatibility plan.

### Phase 5 — safe FTS maintenance

LanceDB documents that appended rows remain searchable through a flat scan of
unindexed fragments until `optimize()` incorporates them into the FTS index.
That supports keeping optimization outside publication correctness.

Future maintenance may measure:

- `num_unindexed_rows` where the installed API exposes it;
- data-modification count;
- lexical latency as the unindexed tail grows;
- close/reopen and concurrent-reader behavior;
- failure recovery without changing publication authority.

Do not put `optimize()` back on the publication path. The current 0.31.x
multi-file UTF-8 failure remains a known reason to keep compaction as separately
qualified maintenance.

### Phase 6 — documentation and default claims

Until Phase 3 passes, README wording stays conservative:

> LanceDB is the default local backend and Milvus remains supported. In a frozen
> four-task connected-storage comparison using identical Voyage embeddings and
> runtime artifacts, LanceDB had substantially lower end-to-end search latency,
> while rankings differed between backends. See the versioned qualification
> report for corpus, methodology, and limitations.

Do not put the exploratory fifteen-query relevance figures in the README while
their raw evidence remains under `/tmp`. Detailed metrics belong in the
versioned qualification document. A stronger usability claim requires the
agent-answer gate.

---

## 6. Acceptance and stop rules

### Query-time contender selection

A contender must:

- improve the predeclared tuning/validation expected-owner survival or
  final-answer measure;
- preserve or reduce tuning/validation hard-miss count;
- avoid material regression on exact identifier/lexical tasks;
- preserve deterministic ordering and stable candidate identities;
- stay within frozen latency, context, and provider budgets;
- preserve backend-neutral ownership boundaries;
- preserve Milvus within the predeclared non-regression bounds when shared
  retrieval or disclosure behavior changes;
- pass focused Core, MCP, adapter, and evaluation-harness tests.

The manifest contains the numerical bounds before contender output is visible.
Terms such as "bounded" or "no material regression" are not acceptance rules
without those values.

### Sealed held-out gate

After selecting and freezing one contender, reveal and run the held-out set
once. The contender must:

- satisfy the frozen final-answer non-inferiority margin;
- introduce no new hard miss;
- preserve exact identifier/lexical task bounds;
- stay within the frozen latency, context, disclosure, provider, agent, and
  judge budgets; and
- preserve Milvus non-regression bounds when shared behavior changed.

A zero-hard-miss baseline cannot be improved on that metric; matching zero is
success, not a hard-miss improvement. An improvement claim requires the frozen
baseline cell to exhibit a miss and the contender to remove it under the owner
and rubric definitions frozen before selection. The baseline outcome itself
remains sealed until the one-shot run. The known Q8 miss is a tuning regression
and is not held-out evidence. Failure at this gate retains the baseline and ends
the experiment for this held-out set.

### Disclosure and response-budget acceptance

A disclosure change must also prove:

- the retrieval and reranker baselines are unchanged unless the contender
  explicitly names and evaluates those changes;
- ordinary and full-debug envelopes each stay within their own exact UTF-8
  byte budget;
- `availableGroupCount`, `returnedGroupCount`, `omittedGroupCount`,
  `truncated`, and truncation reasons are internally consistent;
- authority, freshness, warnings, and next-action fields are never removed by
  truncation;
- complete groups are admitted only when they fit; an oversized first group
  preserves metadata, truncates content only at a UTF-8-safe boundary, and
  reports `group_content_truncated` without slicing serialized JSON;
- the initial page and every continuation page are deterministic for one
  frozen result-set handle;
- no candidate is duplicated or permanently skipped because diversity state
  was reset between pages;
- stale, expired, restarted-process, and publication-changed handles fail with
  stable classified outcomes; and
- continuation creates zero query-embedding, storage-retrieval, and reranker
  work.

Do not adopt a 3–6 result initial default merely because it reduces bytes. It
is accepted only when the held-out agent-answer suite shows that the correct
evidence remains reachable within the frozen expansion and tool-call budget.

### Stop conditions

Stop tuning and retain the current policy when:

- improvements appear only on the tuning set;
- the owner is already present but disclosure, not retrieval, is the first loss;
- extra candidate depth increases noise or reranker work without validation
  gain;
- a proposed backend-specific trick would move query semantics into the adapter;
- evidence cannot distinguish the losing stage;
- the provider or reindex budget is exhausted.

---

## 7. Source and implementation references

Repository owners:

- `packages/core/src/core/context.ts`
- `packages/core/src/core/vector-candidate-fusion.ts`
- `packages/core/src/vectordb/lancedb-vectordb.ts`
- `packages/core/src/core/search-projections.ts`
- `packages/mcp/src/core/search-execution.ts`
- `packages/mcp/src/core/search-rerank-policy.ts`
- `packages/mcp/src/core/search-result-finalization.ts`
- `packages/mcp/src/core/search-group-results.ts`
- `packages/mcp/src/core/search-grouping.ts`
- `packages/mcp/src/core/search-response-envelopes.ts`
- `packages/mcp/src/core/capabilities.ts`
- `packages/mcp/src/core/search-policy.ts`
- `packages/mcp/src/core/sync.ts`
- `scripts/satori-useful-context-record.mjs`

Related plan authority:

- `docs/plans/INCREMENTAL_INDEX_FRESHNESS_PLAN.md` owns comparison evidence,
  watcher epochs, strict/published search modes, and freshness copy.
- `docs/release/2026-07-15-lancedb-voyage-offline-plan.md` owns backend rollout,
  qualification status, and the separate offline gate.

External primary references:

- LanceDB typed `MatchQuery`:
  <https://lancedb.github.io/lancedb/js/classes/MatchQuery/>
- LanceDB typed `MultiMatchQuery`:
  <https://lancedb.github.io/lancedb/js/classes/MultiMatchQuery/>
- LanceDB FTS configuration, phrase/fuzzy/ngram behavior, and maintenance:
  <https://docs.lancedb.com/search/full-text-search>
- Hybrid fusion analysis:
  <https://arxiv.org/abs/2210.11934>
- Zilliz hosted limits:
  <https://docs.zilliz.com/docs/limits>

These references describe available mechanisms. They do not establish that a
mechanism improves Satori; only the frozen, stage-aware evaluation can do that.

---

## 8. Review disposition

| Review proposal | Disposition | Reason |
|---|---|---|
| Replace “good enough” with an operationally qualified but not agent-answer-qualified conclusion | Accept | Owner rank is not final-answer proof. |
| Treat 12/24 as backend agreement rather than correctness | Accept | It is four repeated tasks across mixed retrieval classes. |
| Treat the 3.2x ratio as potentially copied from warm p50 | Reject after checking raw data | The bakeoff mean ratio is 3.19x; its median ratio is 4.50x. The warm-p50 ratio is independently 3.21x. The statistic must be named. |
| Diagnose LanceDB FTS from aggregate lexical counts | Narrow | The counts create a strong hypothesis, not a diagnosis. Phase 1 localizes the first losing stage per query. |
| Add per-stage candidate-survival measurements | Accept | Current provenance does not retain raw dense/lexical ranks through the complete pipeline. |
| Test typed conditional OR fallback | Accept as first experiment | It is query-time, bounded, and targets the current all-terms requirement without a reindex. |
| Preserve minimum representation from candidate sources | Accept as experiment | It can prevent smaller lexical sets from being crowded out without increasing the reranker budget. |
| Test 80/120/160 candidate depths | Accept in replay/harness only | Production remains capped at 80 until held-out benefit and cost are proven. |
| Replay RRF and normalized fusion alternatives | Accept with a train/evaluation split | Two RRF stages mean first-stage-only replay is insufficient, and fifteen tasks cannot support broad tuning. |
| Describe all PhraseQuery use as index-changing | Narrow | Phrase search needs positions and retained stop words; the current Satori FTS index already has both. |
| Treat fuzzy search as query-time | Accept | The installed typed `MatchQuery` supports bounded fuzziness. |
| Treat n-gram and multi-field search as index-changing | Accept | Both require new index/schema state; multi-field projection remains Phase 4. |
| Keep optimize outside publication correctness | Accept | Unindexed fragments remain searchable through a complete flat scan; optimize is performance maintenance and currently has a known 0.31.x failure. |
| Avoid explaining the earlier Zilliz “four” figure | Accept | Current documentation states separate collection and vector-field quotas; its historical source is irrelevant. |
| Keep exploratory relevance numbers out of README | Accept | Raw authority and agent-answer evaluation are incomplete. |
| Use separate candidate, owner, and evidence-occurrence identities | Accept | One line-range tuple is unstable across grouping and expansion and cannot distinguish repeated retrieval evidence. |
| Capture top-160 supersets before replaying 80/120/160 | Accept | A depth cannot be replayed from a shallower capture; replay and live latency prove different contracts. |
| Compare policies in one executable | Accept | Cross-revision policy comparisons cannot isolate the intended retrieval-policy change. |
| Freeze the answering agent and blind judgment contract | Accept | Owner presence alone does not reproduce stochastic agent-answer behavior. |
| Bind expansion to the original ranked set | Accept in the harness first | Silent re-search would confound disclosure with retrieval; a public handle is needed only if the product exposes this expansion behavior. |
| Freeze numerical gates before tuning | Accept | Post-hoc meanings for "bounded" and "material" would make contender admission subjective. |
| Require Milvus non-regression for shared policy changes | Accept | Functional startup is insufficient when Core or MCP behavior changes for both backends. |
| Treat `published_index` as a dependency | Accept | Until the public mode exists, the harness needs an equivalent no-sync path and receipt checks. |
| Keep Phase 4 Lance-only only when Milvus compatibility is unchanged | Accept | A shared projection-version change can invalidate both publications even when only LanceDB lexical fields are intended to change. |
| Do not select a contender using held-out output | Accept | Selection now uses tuning/validation only; one frozen contender sees the sealed held-out set once. |
| Budget the complete provider, agent, judge, and adjudication matrix | Accept | Cached candidate replay does not establish end-to-end latency or the cost of final agent qualification. |
| Bind captures to the complete query and pass plan | Accept | A term, operator, filter, pass, or depth change produces different retrieval evidence and requires a new capture. |
| Require hard-miss non-increase rather than unconditional reduction | Accept | A zero-miss baseline cannot improve on that metric; an improvement claim requires a predeclared baseline miss. |
| Reproduce the baseline in the shared policy binary before tuning | Accept | Otherwise the nominal baseline may be a changed reimplementation rather than authoritative prior behavior. |
