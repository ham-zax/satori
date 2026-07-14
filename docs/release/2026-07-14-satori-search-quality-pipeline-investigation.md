# Satori search-quality pipeline investigation

Date: 2026-07-14

Status: investigation complete; static evidence only

This is a read-only product and architecture investigation of the search-quality
pipeline. Production code is not being changed. Findings below distinguish
directly proven behavior from inferred impact and proposed experiments.

## Evidence and investigation boundaries

- The public request path, candidate generation, ranking, reranking, grouping,
  response construction, chunk construction, and Milvus adapters were read
  directly from the current checkout.
- Focused search tests were inspected to distinguish intended policy from
  incidental behavior. No test suite has been run for this investigation yet.
- The code knowledge graph was used first for symbol and call-path discovery.
  It is partly stale: for example, it still references the deleted
  `packages/core/src/splitter/ast-splitter.ts`. Current chunking evidence comes
  from `packages/core/src/language-analysis/chunks.ts`.
- A live `satori/search_codebase` probe failed with `Transport closed`, so the
  current report does not treat live MCP behavior as independently verified.
  Static call counts and existing benchmark records are identified separately.
- Authority, source-freshness checkpoints, mutation fencing, and navigation
  seals are treated as frozen safety boundaries. Recommendations must not
  weaken them.

### Bounded evidence index

The following ranges are the primary static proof used by this report. Line
numbers refer to the 2026-07-14 checkout and may move after later edits.

| Contract | Bounded code reference | Directly proven behavior |
|---|---|---|
| Public MCP entry and provider gate | `packages/mcp/src/tools/search_codebase.ts:171-219` | Validates the public request and requires `embedding_vector` context before handler execution. |
| Prepared-read/freshness front door | `packages/mcp/src/core/search-frontdoor.ts:231-347` | Proves the tracked root, runs freshness, and either reuses or refreshes prepared evidence before search. |
| Query parsing and coarse intent | `packages/mcp/src/core/search-query-planning.ts:105-195`, `266-372` | Parses prefix operators and emits the four current intents plus auxiliary flags. |
| Exact registry route | `packages/mcp/src/core/search-exact-fast-path.ts:147-262`; `packages/mcp/src/core/search/exact-registry.ts:132-156`, `214-300` | Gates the exact path on grouped symbol output and valid navigation, then applies deterministic match tiers. |
| Retrieval fan-out and cross-pass fusion | `packages/mcp/src/core/search-execution.ts:223-425` | Starts primary/expanded passes, deduplicates by chunk location, and applies rank RRF. |
| Filtering, score construction and reranking | `packages/mcp/src/core/search-execution.ts:444-558`, `588-669` | Applies scope/operators/lexical/path/agent-fit policy, then optionally sends up to 50 chunks to Voyage and fuses returned rank. |
| Core dense/hybrid execution | `packages/core/src/core/context.ts:2600-2726`, `2799-2821` | Treats every non-dense mode as hybrid, performs the non-gating query, embeds, and requests dense plus sparse Milvus retrieval. |
| Backend hybrid request | `packages/core/src/vectordb/milvus-vectordb.ts:924-1010`; `packages/core/src/vectordb/milvus-restful-vectordb.ts:920-1002` | Sends dense and BM25 sparse requests and accepts backend RRF order. |
| Reranker document and policy | `packages/mcp/src/core/search-query-support.ts:1176-1198`, `1248-1259`; `packages/core/src/reranker/voyageai-reranker.ts:44-126` | Shows the skip policy, document fields, API contract and returned relevance score. |
| Owner grouping and semantic label | `packages/mcp/src/core/search-group-results.ts:345-369`, `522-686` | Groups by owner/fallback proximity, adds bounded support, assigns semantic confidence and applies final diversity. |
| Near ties and diversity | `packages/mcp/src/core/search-group-ordering.ts:21-117`, `153-198`; `packages/mcp/src/core/search-grouping.ts:33-89` | Applies 5% near-tie preferences, conditional declaration collapse and file/symbol caps. |
| Response warnings and projection | `packages/mcp/src/core/search-response-helpers.ts:25-190`; `packages/mcp/src/core/search-response-envelopes.ts:130-220` | Converts deterministic warning codes, selects a top action and projects the compact v2 response. |
| Chunk duplication mechanism | `packages/core/src/language-analysis/chunks.ts:56-90`, `92-166` | Chunks each symbol independently and uses merged coverage only for otherwise uncovered source. |
| Current telemetry | `packages/mcp/src/telemetry/search.ts:1-25` | Records total latency, counts, pass totals, rerank booleans and response bytes, but not route/provider/role budgets. |
| Existing synthetic evaluation | `packages/mcp/src/core/search.eval.test.ts:81-195` | Uses five preordered results to verify scope and repeat ordering; it is not a retrieval-quality corpus. |

## 1. Executive assessment

Satori's strongest quality property is that it does more than return vector
chunks. It has a deterministic exact-registry path, explicit source-freshness
handling, query-intent heuristics, current-source recovery for dirty paths,
owner-aware grouping, stable tie-breaking, bounded previews, navigation proof,
and detailed diagnostics. A unique exact symbol can reach the owner without an
embedding, vector query, or reranker call once the public provider context has
been established.

Its largest weakness is that fallback retrieval is still semantic-first even
for query classes that have stronger and cheaper deterministic evidence. The
internal retrieval mode named `lexical` is not lexical-only: Core treats every
non-`dense` mode as hybrid, generates a query embedding, and runs both dense
and sparse retrieval. Quoted strings, error codes after an exact-registry miss,
configuration lookups, and many partially known identifiers can therefore pay
for remote semantic work before or alongside a bounded local lexical scan.

The highest-leverage opportunity is to make routing explicit and optimize for
the fastest trustworthy path to owning code, then allocate the remaining
evidence budget by role. The first changes should be smaller than a ranking
rewrite: remove non-gating remote probes, make lexical routing real, make the
expanded semantic pass confidence-triggered, deduplicate owner families before
reranking, and measure all changes against a deterministic quality-and-cost
corpus.

The current optimization objective is inferred rather than declared: favor
runtime implementation owners, exact lexical evidence, changed source and
diverse files while demoting tests/docs/generated-like paths. It does not
currently optimize a measured probability of correctness, minimum provider
cost, minimum agent steps, or useful evidence per token. Those outcomes may
improve, but they are not the quantity the ranking function computes.

## 2. Current search pipeline

### Public execution path

```text
search_codebase
-> searchCodebaseTool.execute
-> providerRuntime.requireToolContext("embedding_vector")
-> ToolHandlers.handleSearchCode
-> runSearchFrontDoor
-> parseSearchOperators + buildSearchQueryPlan
-> runExactRegistryFastPath
   -> findExactRegistryMatch
   -> exact grouped response on one safe unique hit
   -> otherwise continue with registry fallback evidence
-> runSearchExecution
   -> primary retrieval pass
   -> expanded retrieval pass unless exact-registry eligible
   -> optional dirty-file overlay
   -> optional tracked lexical scan
   -> optional exact-path live-source supplement
   -> deduplicate by chunk location
   -> deterministic filters
   -> RRF + lexical/path/agent-fit ranking
   -> optional Voyage reranking
-> finalizeSearchResults
   -> raw projection, or registry-backed owner repair
   -> symbol/file grouping
   -> near-tie owner preference
   -> conditional declaration collapse
   -> file/symbol diversity caps
   -> bounded previews, navigation, warnings and debug
-> format-version 2 response envelope
-> search telemetry
```

Primary ownership:

| Stage | File | Symbols | Role |
|---|---|---|---|
| Public contract | `packages/mcp/src/tools/search_codebase.ts` | `searchCodebaseTool.execute` | Validates arguments, requires the embedding/vector provider context, invokes the handler, records telemetry. |
| Front door | `packages/mcp/src/core/search-frontdoor.ts` | `runSearchFrontDoor` | Coordinates prepared read, freshness, exact path, search execution, and finalization. |
| Query parsing | `packages/mcp/src/core/search-query-planning.ts` | `parseSearchOperators`, `buildSearchQueryPlan` | Parses prefix operators and derives coarse intent and route flags. |
| Exact registry | `packages/mcp/src/core/search-exact-fast-path.ts`, `packages/mcp/src/core/search/exact-registry.ts` | `runExactRegistryFastPath`, `shouldAttemptExactRegistryLookup`, `findExactRegistryMatch` | Provides deterministic no-search resolution for one safe unique symbol. |
| Candidate retrieval/ranking | `packages/mcp/src/core/search-execution.ts` | `runSearchExecution` | Runs retrieval passes, merges candidates, filters, scores, reranks. |
| Core retrieval | `packages/core/src/core/context.ts` | `semanticSearchWithReceipt` | Resolves the proven collection and calls embedding and Milvus providers. |
| Backend hybrid | `packages/core/src/vectordb/milvus-vectordb.ts`, `packages/core/src/vectordb/milvus-restful-vectordb.ts` | `hybridSearch` | Performs dense + BM25 sparse search and backend RRF with `k=100`. |
| Lexical scan | `packages/mcp/src/core/search-query-support.ts` | `buildTrackedLexicalSearchResults` | Bounded source scan used only for selected exact/path/literal fallbacks. |
| Ranking policy | `packages/mcp/src/core/search-lexical-scoring.ts`, `packages/mcp/src/core/search-ranking-policy.ts` | `scoreCandidateLexicalEvidence`, `resolveAgentFitMultiplier`, `sortSearchCandidates` | Applies exact/usage heuristics, path policy, role policy and deterministic ordering. |
| Reranking | `packages/core/src/reranker/voyageai-reranker.ts` | `VoyageAIReranker.rerank` | Calls Voyage and returns ordered indexes plus relevance scores. |
| Group/final response | `packages/mcp/src/core/search-result-finalization.ts`, `search-group-results.ts`, `search-group-ordering.ts`, `search-grouping.ts` | `finalizeSearchResults`, `buildVisibleGroupedSearchResults`, `sortGroupedSearchResults`, `applyGroupDiversity` | Repairs owners, groups, orders, caps, projects and explains results. |
| Telemetry | `packages/mcp/src/telemetry/search.ts` | `emitSearchTelemetry` | Records latency, result counts, pass counts, rerank flags and response bytes. |

### Query classification

`buildSearchQueryPlan()` currently emits only four primary intents:

- `identifier`
- `mixed`
- `semantic`
- `uncertain`

It separately derives `referenceSeeking`, `testSeeking`,
`implementationSeeking`, `writerSeeking`, and quoted-literal intent. These flags
drive weights and penalties but do not form an explicit route type.

Identifier detection is regex-based. A token is identifier-like when it has an
uppercase letter, punctuation such as `_ / . - :`, or a digit. A single bare
lowercase token is `uncertain`, deliberately preventing vague words from using
the exact registry fast path. There is no first-class classification for exact
file/path, configuration lookup, error/string lookup, ownership, architecture,
or mixed identifier-plus-concept beyond the generic `mixed` class.

### Candidate generation and provider calls

`runSearchExecution()` starts with:

```text
candidateLimit = clamp(max(limit * 8, 32), 1, 80)
expandedQuery = query + "implementation runtime source entrypoint"
```

It launches primary and expanded passes concurrently. The expanded pass is
omitted only when exact-registry eligibility is true; it is not conditioned on
the quality of the primary result. With a `must:` filter, candidate retrieval
can retry twice, doubling the candidate limit up to 80.

In `Context.semanticSearchWithReceipt()`:

```ts
const isHybrid = resolvedRequest.retrievalMode !== 'dense'
    && this.getIsHybrid() === true;
```

Consequently both `lexical` and `hybrid` modes do all of the following:

1. Run a one-row remote collection query as an apparent liveness check.
2. Generate a remote query embedding.
3. Submit dense ANN and sparse BM25 requests through one hybrid-search call.
4. Let Milvus combine those two lists with RRF `k=100`.

The liveness query is non-gating: its failure is caught and logged, after which
embedding and hybrid search still run. A normal conceptual request with two
successful passes therefore statically contains two liveness queries, two
embeddings, two hybrid-search requests, and normally one reranker request. The
passes are concurrent, so call count is not wall-time addition, but it is still
provider cost and load.

The 2026-07-14 live benchmark observed a post-stabilization semantic median of
2.992 seconds. Its representative phase breakdown was about 1.898 seconds for
semantic retrieval, 451 milliseconds for reranking, and 94 milliseconds for
tracked lexical work. Earlier direct provider samples measured a median
352.4 ms Voyage query embedding and 668.7 ms Voyage rerank for 41 synthetic
documents. These are environment observations, not general service claims.

### Exact registry fast path

The exact path is available only for grouped symbol results with valid
navigation authority and a strong identifier/qualified identifier/label, or an
identifier paired with an exact `path:` filter. It loads the registry, applies
scope and operator filters, then tests deterministic match tiers:

1. symbol instance ID;
2. exact symbol name;
3. exact qualified name;
4. normalized identifier identity;
5. exact label.

Exactly one match returns immediately. Ambiguity or a miss continues to normal
retrieval. The immediate hit performs no embedding, vector query or reranking,
but the public tool currently requires an `embedding_vector` provider context
before the handler can reach this path. Thus it is call-free after context
creation, not provider-configuration-independent.

### Local lexical and dirty-source retrieval

`buildTrackedLexicalSearchResults()` is bounded to:

- 128 files;
- 192 KiB per file;
- 2 MiB total source bytes;
- 16 returned candidates;
- two context lines around the selected line.

It runs only for an exact-registry fallback, exact path filter, quoted literal,
or upper-case warning/error/status-like token. It is not the general
implementation of retrieval mode `lexical`.

When source freshness has not been established and git reports dirty paths,
semantic candidates from those paths are suppressed. A bounded current-source
overlay may replace them. This is conservative and source-correct, but a
conceptual change with no lexical overlap can disappear until synchronization.

### Failure, warning and fallback behavior

Failure behavior is deliberately partial rather than all-or-nothing:

- One failed primary/expanded retrieval pass is omitted and produces a stable
  `SEARCH_PASS_FAILED:<pass>` warning; search continues if another semantic
  pass succeeds. If every pass fails, the front door returns a vector-backend
  or all-passes-failed response instead of presenting an empty success.
- Reranker API or result-parse failure preserves the retrieval ordering and
  emits `RERANKER_FAILED`.
- Missing or incompatible navigation evidence preserves vector results but
  removes graph-ready claims and emits a repair or sidecar warning.
- Unverified watcher continuity and unavailable source checkpoints preserve a
  proven vector generation with explicit non-blocking freshness warnings.
- Invalid group targets are omitted rather than projected with unsafe paths,
  spans or scores.

The response envelope deterministically sorts warning details, publishes one
top-level recommended next action, and keeps debug projections opt-in. This is
a strong failure contract. The quality limitation is that most warnings occur
after retrieval; they explain degradation but cannot restore a better candidate
that was displaced earlier.

## 3. Ranking and prioritization logic

### Score domains and fusion

Scores from retrieval systems are not directly compared. Backend dense
similarity, Milvus hybrid RRF, and local lexical ranks are retained as debug
metadata, but cross-source fusion uses rank only:

```ts
sourceContribution = passWeight * (1 / (60 + rank));
```

Candidates are deduplicated by:

```text
relativePath:startLine:endLine:language
```

The final pre-rerank score is:

```ts
(fusionScore + lexicalScore)
* pathMultiplier
* changedFilesMultiplier
* agentFitMultiplier
```

This avoids pretending dense, sparse and RRF backend scores share one scale.
However, the separately scaled lexical term is not calibrated to RRF. Rank one
contributes about `1 / 61 = 0.0164`, while exact lexical evidence can contribute
roughly 1-2 before multipliers. Lexical evidence can therefore dominate the
semantic fusion score by orders of magnitude. This appears intentional for
exact evidence, but no learned calibration or evaluation-derived weights were
found.

### Fixed constants

Candidate and fusion policy (`search-constants.ts`):

| Rule | Value |
|---|---:|
| Cross-pass RRF `k` | 60 |
| Maximum candidates | 80 |
| Initial candidate pool | `max(limit * 8, 32)`, capped at 80 |
| `must:` retry rounds | 2 |
| Retry multiplier | 2 |
| Group fallback proximity window | 25 lines |
| Changed-file multiplier | 1.10 |
| Changed-file precision cap | 50 files |

Reranking policy:

| Rule | Value |
|---|---:|
| Maximum rerank candidates | 50 |
| Rerank RRF `k` | 10 |
| Rerank weight | 1.0 |
| Maximum lines per document | 200 |
| Maximum characters per document | 4,000 |

Grouping and response policy:

| Rule | Value |
|---|---:|
| Normal max results per file | 2 |
| Relaxed max results per file | 3 |
| Max results per symbol | 1 |
| Group support boost | `min(log1p(chunkCount) * 0.01, 0.03)` |
| Near-tie ratio | 5% |
| Group preview | 768 UTF-8 bytes, at most five retained lines |
| Evidence span | 40 lines |

Runtime path multipliers include `core=1.35`, `entrypoint=1.20`,
`srcRuntime=1.10`, `tests=0.90`, `adapter=0.70`, `example=0.60`,
`fixture=0.35`, and `generated=0.30`. Runtime scope removes docs, generated,
artifacts, landing paths and fixtures, but keeps tests.

Agent-fit multipliers include:

- test intent: 1.25;
- ordinary test demotion: 0.45 in runtime, 0.65 in mixed;
- implementation-query test demotion: 0.25;
- implementation symbol: 1.25;
- implementation chunk without symbol metadata: 1.15;
- script implementation: 1.30;
- writer owner: 2.25;
- writer non-owner: 0.55;
- type: 0.72;
- schema: 0.80;
- anonymous: 0.70.

Lexical scoring uses maxima rather than summing every occurrence, then adds
bounded coverage/structural terms. Examples before `lexicalWeight` include:

- quoted symbol 1.75, quoted content 1.70, quoted path 1.60;
- exact symbol token 1.30, exact path token 1.20, exact content token 0.90;
- reference-seeking executable use 1.60, import use 0.75;
- coverage boost up to 0.24 normally or 0.54 for implementation/writer intent;
- structural-anchor boost 0.80 for mixed or 0.55 for semantic;
- corresponding sibling-anchor near-miss penalties.

Fragment terms are discounted to 0.18 for identifier/reference queries and
0.35 otherwise. Reference-seeking declaration matches are deliberately weak:
0.02 for symbol/path boundaries and 0.10 for content boundaries, while
executable use is 1.60 and import use 0.75. Structural sibling near-misses
subtract exactly the corresponding mixed/semantic structural boost (0.80 or
0.55) before query lexical weight is applied.

Query lexical weights are 1.35 for identifiers and quoted literals, 0.60 for
uncertain queries, 0.10 for ordinary mixed queries, 0 for ordinary semantic
queries, and small nonzero weights for reference/implementation/writer intent.

### Reranking

Reranking is skipped for docs scope, identifiers, quoted literals, and a
definitive top exact pin. Otherwise up to 50 already-ranked chunks are sent to
Voyage. Each reranker document contains only:

```text
relative path
language
symbol label
up to 200 lines / 4,000 characters of chunk content
```

It does not explicitly encode owner role, definition/reference role, test or
generated category, caller/callee evidence, retrieval source, freshness, chunk
position, or duplicate-family identity.

Voyage returns relevance scores, but `runSearchExecution()` discards those
values and uses only returned order. Each returned rank adds
`1 / (10 + rank)` to fusion score. The top rerank contribution is therefore
about 0.0909: much larger than one source-pass RRF contribution, but often much
smaller than exact lexical evidence.

Default capability policy enables reranking whenever a Voyage key is present
and the performance profile is not `slow`. The MCP provider runtime defaults to
`rerank-2.5`; the lower-level reranker class defaults to the cheaper
`rerank-2.5-lite` when constructed without a model.

### Result-limit sensitivity

The public `limit` changes more than response truncation. The initial retrieval
pool is `max(limit * 8, 32)` capped at 80, while reranking is capped at 50 and
diversity is applied only after grouping. Therefore limits 1-4 all start with a
32-candidate pool, limits 5-10 expand the pool from 40 to 80, and limits above
10 cannot increase it. A larger limit can expose more owners, but it can also
change which candidates enter the top-50 reranker and final ranking. Current
tests do not measure owner-rank or evidence-role stability across limits. This
is a directly proven mechanism; whether instability is material is an
evaluation question.

### Ordering, grouping and tie-breaking

- Candidate sort pins `must:` matches first when applicable, then exact lexical
  matches when pinning is enabled, then descending final score.
- Stable candidate ties use file, start line, symbol label, then symbol ID.
- Symbol groups use owner identity when proven; otherwise they use 25-line
  proximity buckets. File grouping merges all hits for the file.
- A group's score is its best representative score plus at most 0.03 support;
  the relevance of multiple chunks is not meaningfully aggregated.
- Within a 5% score near-tie, methods/functions beat class/file spans,
  declarations beat prose-like groups, and smaller spans win within one file.
- Duplicate declaration collapse runs only for identifier or reference-seeking
  queries.
- Diversity then admits at most two results per file and one per symbol, with a
  second pass permitting a third result from a file.

### Explicit policy versus emergent priority

| Priority source | Classification | Consequence |
|---|---|---|
| Query lexical weights, path and agent-fit multipliers, exact pinning, near-tie rules and diversity caps | Explicit policy | Stable and testable, though mostly heuristic rather than corpus-calibrated. |
| Milvus dense/sparse RRF order | Provider/backend behavior accepted as rank | Comparable across the two backend lists only through backend RRF; raw similarity is not used cross-source. |
| Primary plus expanded pass both contributing equal rank RRF | Execution-order policy with no evidence gate | A candidate present in both receives an automatic fusion advantage; expansion always consumes provider budget on non-exact routes. |
| Top 50 chunks selected before owner grouping | Accidental stage-order effect | Repeated chunks from one owner can crowd out distinct owners before the reranker sees them. |
| Lexical term scale versus RRF scale | Independently chosen constants | Exact evidence can dominate semantic ranks by orders of magnitude without calibrated probability meaning. |
| Voyage model order | Provider behavior | Relevance scores are validated but discarded; only order affects Satori scoring. |
| Candidate pool derived from requested result limit | Execution policy | Changing `limit` can change reranker membership and ranking, not only final truncation. |

## 4. Noise-reduction logic

### Index-time exclusion

Default ignores remove common dependencies, builds, coverage, caches, VCS,
temporary files, secrets, lockfiles, minified/bundled/vendor-suffixed files,
maps, database dumps and snapshots. Tests and fixtures remain indexed.
Arbitrary `vendor/` directories are not excluded by name, generated files
outside recognized paths/suffixes remain indexable, and declaration files such
as `.d.ts` are ordinary TypeScript input.

### Chunk construction

`buildAnalysisChunks()` emits chunks for every extracted symbol and then chunks
uncovered source. Default chunk size is 2,500 bytes with 300-byte overlap.
Coverage spans are merged only to find uncovered text; symbol chunks themselves
are not deduplicated. Nested or overlapping symbols therefore produce repeated
bytes at multiple ownership levels, and long symbols also repeat overlap bytes.

This repeated-content mechanism is directly proven. Its real-repository
frequency and effect on ANN/rerank capacity remain measurement hypotheses.
Current language-analysis tests verify bounded and searchable chunks but do not
appear to assert a duplicate-byte or nested-owner budget.

### Retrieval and finalization

- Runtime scope removes docs, generated, artifact, landing and fixture
  categories before final scoring.
- Tests remain and are demoted unless explicitly requested.
- Dirty-path vector hits are suppressed when current-source freshness is not
  established.
- Exact path, language, include/exclude path, `must:` and `exclude:` filters are
  applied before final scoring.
- Grouping reduces repeated chunks under a proven owner, and previews remove
  blank/punctuation-only lines, duplicate lines, repeated declarations and
  neighboring declarations.
- A noise diagnostic inspects only the top five visible files. If at least 60%
  are tests, fixtures, docs or generated paths, it emits a scope/ignore hint.
  This is diagnostic after selection; it does not recover candidates that noise
  displaced before reranking or final limits.

### Remaining noise risks

| Source | Entry point | Cheapest safe removal | Evidence status |
|---|---|---|---|
| Nested/overlapping symbol chunks | `buildAnalysisChunks` | Attach a duplicate-family/owner hierarchy during indexing; avoid embedding derivative spans or cap them per owner before rerank. | Mechanism confirmed; magnitude unmeasured. |
| Tests competing with runtime | Indexed normally; retained in runtime scope | Preserve index coverage, but use explicit evidence roles and query-class quotas rather than only a global multiplier. | Confirmed policy. |
| Generated/vendor variants | Incomplete path/suffix heuristics | Add deterministic index metadata from known generators and configurable vendor policy; keep explicit user override. | Confirmed limitation. |
| Imports/re-exports/wrappers | Lexical and semantic candidates | Mark declaration/reference/wrapper roles at indexing and diversify by role before rerank. | Role gap confirmed; quality impact to measure. |
| Large owner families | Multiple overlapping chunks enter top 50 | Deduplicate/cap per owner before reranking while retaining the strongest and one complementary chunk. | Confirmed capacity risk; impact to measure. |
| Broad docs/config | Indexed and available in mixed/docs | Route exact config/string queries lexically; keep docs scope explicit. | Confirmed routing gap. |
| Reranker lacks role context | `buildRerankDocument` | Add deterministic role/source/path metadata to the reranker document. | Confirmed context omission. |
| Stale worktree evidence | Vector candidate suppression + lexical overlay | Keep current conservative contract; improve conceptual dirty overlay only with source-safe local retrieval. | Confirmed behavior. |

## 5. Query-class analysis

This table is provisional until the deterministic evaluation corpus is run.

| Query class | Current route | Economical target route | Provider budget target |
|---|---|---|---:|
| Exact identifier | Exact registry when the identifier is strong and unique; otherwise one hybrid pass labelled `lexical`; no rerank. | Registry -> exact owner; on ambiguity return bounded candidates or sparse/local lexical under the same authority. | 0 for a hit; 0 embedding for lexical fallback. |
| Exact file/path | No first-class route. `path:` acts as a filter; path-only input can fall through awkwardly. | Canonical path validation -> registry/file outline or bounded file evidence. | 0 embedding, 0 rerank. |
| Symbol ownership | Usually mixed/semantic unless phrased with a strong identifier. | Registry ownership first; semantic fallback only when owner is unknown or conceptual. | 0 for known symbol; <=1 embedding otherwise. |
| Reference/caller discovery | Regex sets `referenceSeeking`; lexical usage boosts, declaration demotions, semantic candidates, optional rerank; call graph is a separate follow-up. | Exact registry -> structural relationships -> bounded lexical verification; semantic only for unresolved indirect behavior. | 0 for exact structural path. |
| Structural/architecture | Generic hybrid primary + expanded pass + rerank. | Registry/relationship/file-role retrieval, then semantic retrieval only to fill missing architectural roles. | <=1 embedding initially; rerank only if ordering ambiguity remains. |
| Behavioral/conceptual | Two hybrid passes + rerank by default. | One primary hybrid pass -> confidence/coverage check -> optional expansion -> role-aware rerank. | 1 embedding + 1 vector query normally; one conditional expansion. |
| Error/string lookup | Quoted literals disable rerank but still normally run two hybrid passes plus bounded lexical scan. | Exact indexed sparse or bounded source literal scan first; semantic only if exact evidence is absent and the user asks for behavior. | 0 embedding normally. |
| Configuration lookup | No explicit class; often identifier/mixed/semantic. | Exact path/key/value lexical lookup, then owner/readers/writers structural expansion. | 0 embedding for exact key/path. |
| Mixed identifier + concept | `mixed`, two hybrid passes, small lexical weight, usually rerank. | Registry candidates for identifier -> apply conceptual evidence to those owners/callers -> semantic expansion only if coverage is weak. | 0-1 embedding. |

## 6. Product and architecture findings

### Confirmed correctness and contract problems

1. **`lexical` has no no-embedding economic meaning.** Debug and types expose a
   distinct retrieval mode, but Core deliberately defines both `lexical` and
   `hybrid` as requiring hybrid support and maps them to dense-plus-sparse
   search. Focused Core tests encode that requirement. This is not an accidental
   branch leak; it is a misleading public/internal contract for exact-ish
   fallbacks because the route still requires an embedding and dense ANN work.
2. **Semantic confidence is not calibrated relevance.** Group quality becomes
   `high` whenever dense-score evidence exists and the query intent is semantic
   or mixed. It does not inspect the score, margin, owner agreement or reranker
   confidence. Exact lexical evidence can conversely be labelled semantic
   `low` even when it is the strongest answer. This field describes evidence
   provenance, not confidence, and can mislead consumers.
3. **The hybrid liveness query is non-gating remote work.** Its failure is
   ignored, so it adds load and latency without establishing a condition used
   by the algorithm.

### Confirmed quality limitations

1. Query routing is too coarse for exact path, strings, configuration,
   ownership, callers and architecture.
2. Lexical heuristics are much larger than cross-source RRF and are not
   empirically calibrated.
3. The expanded semantic pass is unconditional for most non-exact queries.
4. Reranking occurs before owner grouping, so duplicate owner chunks can
   consume the 50-candidate budget.
5. Reranker documents omit evidence roles needed to distinguish definitions,
   uses, tests, docs, generated code and wrappers.
6. File-level diversity can suppress several useful symbols from the true
   owning file in favor of weaker cross-file evidence.
7. Group relevance is almost entirely the best chunk; supporting evidence adds
   at most 0.03.

### Confirmed latency limitations

1. Most conceptual queries issue two embeddings and two hybrid vector calls.
2. Each hybrid pass also issues a caught-and-ignored one-row collection query.
3. The public wrapper requires an embedding/vector provider context even for a
   registry path that makes no embedding or vector call.
4. No query-embedding cache is present; primary and expanded strings differ, so
   sharing within the current two-pass request is not possible without changing
   expansion policy, but identical queries across the exact generation are
   cacheable.

### Confirmed cost limitations

1. Normal conceptual search consumes two embedding requests, two vector hybrid
   requests and two extra vector queries even when the primary result is enough.
2. Reranking can send roughly 200,000 characters before request overhead
   (`50 * 4,000`), even when the requested result limit is small.
3. Dense and sparse retrieval always run together for `lexical`, so exact-ish
   queries consume dense ANN/vector-database capacity unnecessarily.
4. Model-visible response selection is limit- and file-cap-driven rather than
   explicitly optimized for accepted evidence roles per token.

### Confirmed maintainability limitations

1. `runSearchExecution()` owns retrieval fan-out, source overlays, filtering,
   scoring, retries, reranking and diagnostics in one large function. This
   makes route-specific guarantees difficult to encode and test.
2. Query class is represented by one coarse enum plus a growing set of booleans
   and regexes. New behavior can emerge from flag combinations rather than an
   explicit route contract.
3. Ranking constants are centralized, which is good, but their rationale and
   calibration corpus are absent.
4. Existing telemetry cannot explain economic quality. It records total
   latency, result counts, semantic pass counts, rerank booleans and response
   bytes, but not selected route, embedding/vector calls, candidate source
   contributions, duplicate owner families, reranker input bytes, expected
   owner rank, or evidence-role coverage.

### Evaluation gap

`search.eval.test.ts` uses five preordered synthetic results and proves runtime
versus docs scope plus deterministic repeat ordering. `handlers.scope.test.ts`
contains substantial focused policy tests for exact matching, owner repair,
test demotion, writer boosts, reranking, diversity and noise hints. What is
missing is a corpus that measures owner success, reciprocal rank, evidence-role
coverage, provider calls, latency and model-visible bytes together. Existing
tests prove local invariants, not end-to-end search quality or economic value.

### Apparently valid but degraded results

Several failures intentionally preserve `status: "ok"` with warnings: one of
the two semantic passes can fail, reranking can fail, navigation can be
unavailable, watcher continuity can be unverified, and stale dirty-file evidence
can be suppressed without replacement. These are not silent when callers
inspect structured warnings, but a consumer that reads only `status` and the
top result can mistake degraded evidence for a fully healthy answer.

Two weaker cases are less visible: `quality.semantic="high"` can be assigned
from dense-source presence rather than calibrated confidence, and a successful
expanded pass can influence rank without explaining whether it was necessary.
The recommended instrumentation should expose a compact evidence basis without
turning every normal response into a diagnostic payload.

### Hypotheses requiring measurement

- Overlapping nested symbol chunks materially reduce ANN and reranker diversity.
- Two-result-per-file diversity removes useful same-file architectural roles at
  common result limits.
- The expanded query improves enough conceptual workloads to justify running on
  every request.
- Reranker relevance scores would be more stable than rank-only fusion after
  calibration.
- A sparse-first path will preserve or improve exact/string/config recall on
  large repositories within the local-scan bounds.

## 7. Recommended improvements

### 7.1 Deterministic quality and economic instrumentation

- **Problem:** focused tests prove policy branches but not owner rank, evidence
  usefulness or provider/context cost. Current telemetry cannot attribute those
  outcomes to a route or candidate source.
- **Proposed change:** add the hermetic corpus in section 9 and bounded counters
  for route, embedding/sparse/dense/vector/rerank calls, expansion reason,
  candidates by source/role, duplicate families before rerank, reranker input
  bytes, owner rank and final response bytes. Keep detailed candidate data in
  tests or opt-in debug; do not emit source content in normal telemetry.
- **Code ownership:** `packages/mcp/src/core/search-execution.ts`,
  `search-debug-helpers.ts`, `packages/mcp/src/telemetry/search.ts`, and a new
  focused evaluation fixture/test beside `search.eval.test.ts`.
- **Expected quality impact:** no direct ranking change; makes regressions and
  accidental source domination visible.
- **Latency/cost impact:** negligible when counters are scalar and debug detail
  is lazy; the hermetic suite adds CI time only.
- **Safety risks:** telemetry cardinality or source leakage. Use enums/counts,
  hash fixture identities, and never log query/source text by default.
- **Tests required:** deterministic repeated output, counter accounting, debug
  off/on equivalence, and no source-text telemetry.
- **Scope / priority:** medium, **P0 prerequisite**.

### 7.2 Remove the non-gating hybrid liveness query

- **Problem:** every hybrid pass performs `vectorDatabase.query(..., 1)`, catches
  any failure, and proceeds. It neither gates the request nor changes fallback.
- **Proposed change:** delete that query. Let `hybridSearch()` and the existing
  proven collection receipt be the authoritative failure points.
- **Code ownership:** `Context.semanticSearchWithReceipt()` in
  `packages/core/src/core/context.ts`.
- **Expected quality impact:** none; candidate generation is unchanged.
- **Latency/cost impact:** removes one vector-database round trip per pass: two
  on the current normal conceptual route and one on exact-registry fallback.
- **Safety risks:** an adapter could have relied on the query for lazy loading,
  but both Milvus adapters already call `ensureInitialized()` and
  `ensureLoaded()` inside `hybridSearch()`.
- **Tests required:** identical controlled results, missing/deleted collection
  still fails deterministically, and a query-call spy remains at zero.
- **Scope / priority:** small, **P0**.

### 7.3 Introduce explicit route contracts

- **Problem:** four intents plus booleans allow routing to emerge from regex and
  execution order. Exact path, literal/error, configuration, caller/owner,
  structural and conceptual requests have materially different cheapest proof.
- **Proposed change:** derive an internal discriminated route after operator
  parsing: `exact_identifier`, `exact_path`, `literal`, `configuration`,
  `ownership`, `references`, `structural`, `conceptual`, or `mixed`. Each route
  declares allowed retrieval sources, provider budget, rerank policy and
  required navigation capability. Preserve the public MCP schema.
- **Code ownership:** `search-query-planning.ts`, `search-frontdoor.ts`, and a
  thinner route dispatch around `runSearchExecution()`.
- **Expected quality impact:** stronger deterministic evidence cannot be
  accidentally weakened by a generic semantic path; fallback becomes explicit.
- **Latency/cost impact:** many exact/path/literal/config/caller requests need no
  provider call; conceptual work remains unchanged initially.
- **Safety risks:** misclassification can reduce recall. Low-confidence routes
  must retain a bounded fallback and expose the selected route/reason in debug.
- **Tests required:** one positive and adversarial case per route, mixed-query
  fallback, ambiguous exact symbol, and unchanged authority/freshness fencing.
- **Scope / priority:** medium, **P1** after the corpus exists.

### 7.4 Add a real no-embedding lexical/sparse route

- **Problem:** current `lexical` is an explicitly tested hybrid mode, so exact
  strings and partially known identifiers still pay for embedding and dense ANN.
- **Proposed change:** add sparse-only retrieval against the already proven
  generation, with the bounded current-source scanner retained for freshness
  overlays and small exact fallbacks. Acquire embedding provider context lazily
  only for routes that need it. Do not change authority or public envelopes.
- **Code ownership:** Core semantic-search request routing, vector-database
  adapters, `search-query-support.ts`, and the public tool provider gate.
- **Expected quality impact:** exact literal, error, key and identifier recall
  should improve or remain stable because sparse evidence is no longer diluted
  by dense results; large-repository coverage is better than local scan alone.
- **Latency/cost impact:** zero embedding and zero dense ANN for lexical routes;
  one sparse vector-database query at most.
- **Safety risks:** sparse behavior differs between SDK and REST adapters, and
  current-source dirty files must not be replaced by stale sparse evidence.
- **Tests required:** adapter parity, zero embedding calls, exact literal/path
  fixtures, dirty-path suppression, missing provider config on exact routes,
  and remote collection failure.
- **Scope / priority:** medium-to-large, **P1**.

### 7.5 Make semantic expansion evidence-triggered

- **Problem:** almost every non-exact request launches the original and expanded
  queries before seeing whether the primary pass already found an adequate owner.
- **Proposed change:** run one primary pass, evaluate deterministic coverage
  signals (owner presence, top margin, source agreement, role coverage and
  result count), then run expansion only for an explicit `insufficient_coverage`
  reason. Do not use an uncalibrated vector score alone.
- **Code ownership:** `runSearchExecution()` and query-plan/debug types.
- **Expected quality impact:** unchanged on confident primary results; ambiguous
  workloads retain expansion. The corpus must prove where expansion helps.
- **Latency/cost impact:** removes one embedding and one hybrid query on the
  common adequate-primary path; introduces sequential latency only on genuinely
  ambiguous requests that previously ran both passes concurrently.
- **Safety risks:** a weak confidence gate could suppress useful recall or make
  ambiguous queries slower. Start conservatively and record the trigger.
- **Tests required:** controlled primary-sufficient and expansion-required
  cases, one-pass failure fallback, exact role coverage, and provider counters.
- **Scope / priority:** medium, **P1**.

### 7.6 Deduplicate owner families before reranking and adapt its budget

- **Problem:** overlapping chunks from one owner can occupy much of the 50-item
  reranker input before grouping. The budget ignores requested result limit and
  certainty.
- **Proposed change:** form owner/duplicate families before rerank, retain the
  strongest representative plus at most one complementary evidence role, and
  choose rerank count from requested limit, ambiguity and family count. Preserve
  all candidates for deterministic fallback if the reranker fails.
- **Code ownership:** `search-execution.ts`, owner-resolution helpers and
  rerank debug structures.
- **Expected quality impact:** more distinct owners and roles reach the reranker;
  less capacity is spent comparing derivative chunks.
- **Latency/cost impact:** smaller requests and lower provider cost; local family
  construction is linear in at most 80 candidates.
- **Safety risks:** incorrect owner metadata could collapse distinct evidence.
  Unknown owners must use exact chunk identity and conservative proximity rules.
- **Tests required:** nested owner chunks, missing owner metadata, two genuinely
  distinct roles in one owner, reranker failure restoration, and deterministic
  order under shuffled provider rows.
- **Scope / priority:** medium, **P1**.

### 7.7 Enrich reranker documents with evidence roles

- **Problem:** reranker input lacks definition/reference/owner role, path
  category, test/generated status and retrieval provenance.
- **Proposed change:** prepend compact deterministic fields such as
  `role=definition`, `pathRole=runtime`, `source=sparse+dense`,
  `owner=<label>` and `relationship=caller`; retain bounded source content.
- **Code ownership:** `SearchQuerySupport.buildRerankDocument()` and metadata
  production in search execution.
- **Expected quality impact:** helps distinguish owners from tests, wrappers and
  declarations that share vocabulary.
- **Latency/cost impact:** small added characters per retained family, offset by
  the smaller adaptive candidate set.
- **Safety risks:** inferred roles may bias the provider incorrectly. Only emit
  deterministic roles with an `unknown` fallback.
- **Tests required:** exact document snapshots, byte cap, role omission/fallback,
  and a controlled reranker case where owner metadata changes the expected rank.
- **Scope / priority:** small-to-medium, **P1**, paired with 7.6.

### 7.8 Select final evidence by role and token budget

- **Problem:** file caps provide diversity but do not ensure the answer contains
  the owner, a caller, configuration and a test when those are distinct useful
  roles. They can also spend context on weaker cross-file chunks.
- **Proposed change:** after ranking, allocate a byte/token budget across
  query-required roles, then apply deterministic per-family and per-file caps.
  Keep the current compact target, preview and navigation contracts.
- **Code ownership:** `search-group-results.ts`, `search-grouping.ts`, response
  debug types and envelope tests.
- **Expected quality impact:** higher useful evidence per token and better
  architectural/caller coverage, especially for smaller models.
- **Latency/cost impact:** local bounded selection only; response/model input
  should shrink or become more useful at the same size.
- **Safety risks:** role allocation can hide a high-scoring result. Always retain
  the best proven owner and expose skipped-role/cap counts in debug.
- **Tests required:** owner retention, multi-role architecture query, repeated
  same-file symbols, byte-budget boundary, and stable tie order.
- **Scope / priority:** medium, **P1/P2** after role evidence is measured.

### 7.9 Calibrate fusion weights and confidence from the corpus

- **Problem:** lexical scores, RRF contributions, path multipliers and rerank RRF
  use hand-set scales; `quality.semantic` describes provenance more than
  calibrated confidence.
- **Proposed change:** retain per-source evidence, fit or grid-search simple
  query-class weights on the frozen corpus, and define confidence from observable
  agreement/margin/owner evidence. Rename or redefine semantic confidence only
  through a versioned public-contract decision; do not silently change meaning.
- **Code ownership:** lexical scoring, ranking policy, group quality projection,
  contract docs and golden tests.
- **Expected quality impact:** reduces accidental domination and makes confidence
  actionable.
- **Latency/cost impact:** negligible runtime arithmetic; evaluation work is the
  main cost.
- **Safety risks:** overfitting and public-contract drift. Keep a held-out fixture
  slice and explicit backward-compatibility decision.
- **Tests required:** calibration artifact hash, held-out regression, score
  monotonicity, stable ties and compact-contract golden tests.
- **Scope / priority:** medium, **P2**.

### 7.10 Add generation-bound caches only after routing is stable

- **Problem:** repeated conceptual queries regenerate deterministic embeddings
  and results even when the exact authority generation is unchanged.
- **Proposed change:** optionally cache query embeddings by normalized query,
  provider/model/dimension and cache final search results by full query plan plus
  marker run ID, policy digest, navigation seal and mutation generation. Cache
  only successful results and clear on every relevant authority change.
- **Code ownership:** provider runtime/read coordinator, not ranking policy.
- **Expected quality impact:** none if identity is complete.
- **Latency/cost impact:** large for repeated queries; no benefit for unique ones.
- **Safety risks:** stale authority/source evidence and memory growth. TTL is
  eviction only, never proof; exact generation binding is mandatory.
- **Tests required:** mutation/marker/policy/seal invalidation, failed-call retry,
  bounded eviction and source-freshness warning preservation.
- **Scope / priority:** medium, **P2 optional experiment**.

### 7.11 Change indexing metadata only if measured failures remain

- **Problem:** chunk overlap and missing role/family metadata may continue to
  create noise after retrieval-time deduplication.
- **Proposed change:** only if the corpus proves the need, publish explicit owner
  hierarchy, derivative-family and evidence-role metadata, or avoid embedding
  redundant parent/child spans. Treat this as an indexing-contract change with
  normal fingerprint/reindex handling.
- **Code ownership:** language analysis, chunk/index document construction,
  registry metadata and runtime fingerprint.
- **Expected quality impact:** potentially the largest ANN diversity gain.
- **Latency/cost impact:** lower index size and retrieval load, but reindex and
  migration cost are substantial.
- **Safety risks:** lost searchable context, cross-language parser differences
  and incompatible generations.
- **Tests required:** per-language nested symbols, byte coverage, searchable
  owner/body evidence, fingerprint mismatch and reindex publication/recovery.
- **Scope / priority:** large, **P2 conditional**, not justified yet.

## 8. Proposed target architecture

```text
request + exact authority receipt
-> explicit query classifier
-> route planner with provider and evidence-role budget
-> deterministic retrieval first
   -> registry / exact path / literal / structural relationships
-> optional sparse lexical retrieval
-> optional one-pass semantic retrieval
-> confidence and coverage gate
-> optional expansion retrieval
-> normalize within each source; preserve source-specific evidence
-> owner-family deduplication and role tagging
-> query-class ranking policy
-> adaptive, role-enriched reranking only when uncertain
-> evidence-role-aware selection under byte/token budget
-> deterministic grouping, navigation proof, warnings and debug
```

The route planner should make the economic contract explicit:

| Route | First evidence | Optional fallback | Normal provider budget |
|---|---|---|---:|
| Exact identifier | Registry | Sparse lexical on ambiguity | 0 embedding, 0 rerank |
| Exact path/file | Canonical path + registry/outline | Bounded source evidence | 0 |
| Literal/error/config | Sparse lexical or bounded literal scan | Structural readers/writers, then semantic | 0 normally |
| Ownership | Registry owner | Sparse/semantic owner discovery | 0-1 embedding |
| References/callers | Relationship sidecar + lexical verification | Semantic indirect-behavior search | 0 normally |
| Structural/architecture | Registry/file/relationship roles | One semantic pass for missing roles | 0-1 embedding |
| Conceptual | One hybrid pass | Evidence-triggered expansion and rerank | 1 embedding/vector normally |
| Mixed identifier + concept | Registry-scoped owners | One semantic pass over unresolved evidence | 0-1 embedding |

Ranking should preserve separate source evidence until a query-class policy
combines it. It should distinguish at least these final evidence roles:

- owning definition or implementation;
- caller/reference;
- configuration/schema;
- runtime adapter/entrypoint;
- test/verification;
- documentation/explanation;
- generated/derivative/unknown.

Candidate relevance and model usefulness are different objectives. Retrieval
and reranking should estimate relevance; final selection should choose the
smallest role-complete evidence set under a byte/token budget. Authority proof,
source freshness and navigation authority remain independent prerequisites and
must not be inferred from ranking confidence.

The target objective should not be “highest-scoring chunks.” It should be:

> Reach the owning code with the minimum trustworthy evidence and provider cost,
> then add only the distinct supporting roles needed to answer correctly.

This can be measured as owner success and evidence-role coverage subject to
tool-call, provider-call, latency and context budgets.

## 9. Deterministic evaluation plan

The suite should have two layers:

1. A hermetic quality layer with a fixed source fixture, fixed index documents,
   controlled dense/sparse/reranker outputs, and a pinned authority identity.
   This is the release gate.
2. A live-provider observational layer with pinned provider/model/configuration
   and recorded artifact hashes. It measures realistic latency/cost but must not
   be the sole correctness gate.

Every workload records:

- expected owner rank and reciprocal rank;
- acceptable evidence roles and forbidden/noisy files;
- tool calls and agent steps to first owner;
- embedding, sparse, dense, vector and rerank calls;
- candidate counts before/after deduplication and by source/role;
- reranker input characters;
- response bytes and estimated tokens;
- wall time and internal phase times;
- warnings, fallback route and confidence basis.

### Immutable fixture corpus

Create `fixtures/search-quality/v1/` as a self-contained TypeScript repository
with a committed SHA-256 manifest. Its source must not import Satori production
code, so production refactors cannot silently change expected answers.

| Fixture file | Required immutable evidence role and relationship |
|---|---|
| `src/public/search-api.ts` | Exports `searchCodebase`; calls `planQuery`, `executeSearch`, then `finalizeResults`. Public entry role. |
| `src/search/query-router.ts` | Owns `planQuery` and the exact/lexical/structural/conceptual route decision. Canonical conceptual owner. |
| `src/search/execution.ts` | Owns `executeSearch`; calls `retrieveCandidates`, `rankCandidates`, `finalizeResults`. Orchestrator role. |
| `src/search/retrieval.ts` | Owns `retrieveCandidates` and `expandSemanticCandidates`. Retrieval role. |
| `src/search/ranking.ts` | Owns `rankCandidates`, `normalizeSourceScores` and `applyRoleBoosts`. Ranking role. |
| `src/search/finalize.ts` | Owns `finalizeResults` and `selectEvidenceGroups`. Final-selection role. |
| `src/checkpoints/checkpoint-store.ts` | Owns `writeSourceCheckpoint` and literal `SOURCE_CHECKPOINT_MISSING`. Canonical runtime owner. |
| `src/checkpoints/checkpoint-service.ts` | Owns wrapper `refreshCheckpoint`, which calls `writeSourceCheckpoint` but does not write files itself. Derivative-wrapper role. |
| `src/config/search-config.ts` | Defines `RERANK_TOP_K = 24` and `SearchPolicy`. Configuration role. |
| `src/generated/checkpoint-client.generated.ts` | Repeats checkpoint terms and delegates to the service. Generated-noise role. |
| `test/checkpoint-store.test.ts` | Calls `writeSourceCheckpoint` and repeats the error literal. Test/support role. |
| `fixtures/checkpoint.json` | Repeats checkpoint keys without executable ownership. Fixture-noise role. |
| `docs/search-pipeline.md` | Describes every pipeline term but owns no runtime behavior. Documentation-noise role. |

Required call edges are fixed:

```text
searchCodebase
-> planQuery
-> executeSearch
   -> retrieveCandidates
   -> rankCandidates
   -> finalizeResults

refreshCheckpoint
-> writeSourceCheckpoint
```

The fixture generator is not allowed to synthesize expected outputs. Expected
owners, roles, calls and literals live in a reviewed manifest. Dense, sparse
and reranker stubs consume fixed per-query rows from that manifest and count
calls. A fixed clock and pinned generation receipt remove time-dependent output.

### Workload matrix

| Workload | Exact query | Expected owner/support | Forbidden or noisy result | Calls and context budget |
|---|---|---|---|---|
| Known exact identifier | `writeSourceCheckpoint` | `checkpoint-store.ts` rank 1 | Wrapper/test/generated above owner | 1 tool; 0 embedding/vector/rerank; <=4 KiB |
| Known file and owner | `path:src/search/ranking.ts rankCandidates` | `rankCandidates` rank 1 | Any other file above owner | 1 tool; 0 embedding/rerank; <=4 KiB |
| Partially known identifier | `writeSourceCheck` | `writeSourceCheckpoint` in top 3 | Generated client above owner | 1 tool; <=1 sparse; 0 embedding/rerank; <=6 KiB |
| Exact error/string | `"SOURCE_CHECKPOINT_MISSING"` | Runtime owner rank 1; test may support | Docs/generated/fixture in runtime output | 1 tool; <=1 sparse; 0 embedding/rerank; <=6 KiB |
| Configuration lookup | `where is RERANK_TOP_K configured` | `search-config.ts` rank 1 | Documentation as owner | 1 tool; <=1 sparse; 0 rerank; <=6 KiB |
| Symbol ownership | `who owns rankCandidates` | `ranking.ts` rank 1 | `execution.ts` presented as owner | 1 tool; 0 provider when registry resolves; <=6 KiB |
| Caller discovery | `who calls writeSourceCheckpoint` plus graph traversal | `refreshCheckpoint` caller; test as optional support | Empty graph treated as proof of no caller | <=2 tools; 0 semantic calls; <=8 KiB |
| Conceptual behavior | `decide whether exact or semantic retrieval is needed` | `planQuery` top 3 | Docs-only explanation above runtime owner | 1 tool; <=1 embedding/vector; <=1 rerank; <=8 KiB |
| Architecture discovery | `trace public search through retrieval ranking and final selection` | Entry, orchestrator, retrieval, ranking and finalization roles all visible by limit 5 | Five chunks from one role/owner | 1 tool; <=1 initial semantic pass; conditional expansion; <=12 KiB |
| Common noisy term | `checkpoint search state` | Runtime owner in top 3; at most one wrapper | Generated/test/fixture family consumes majority | 1 tool; <=1 vector; <=1 rerank; <=8 KiB |
| Generated interference | `write checkpoint implementation` | Handwritten store above generated client | Generated file in runtime results | 1 tool; <=1 vector; <=1 rerank; <=6 KiB |
| Test/runtime ambiguity | `implementation that writes source checkpoint` | Runtime store rank 1; test only supporting | Test above runtime owner | 1 tool; <=1 vector; <=1 rerank; <=6 KiB |
| Multiple plausible owners | `search pipeline` | Orchestrator plus distinct retrieval/ranking/final roles | Duplicate chunks consume role slots | 1 tool; <=1 vector/rerank; <=10 KiB |
| Mixed identifier and concept | `rankCandidates diversity policy` | Ranking owner top 3 and finalizer support | Generic docs above both | 1 tool; <=1 embedding/vector/rerank; <=8 KiB |
| Rerank helps | Stub dense order: wrapper, docs, owner; rerank order: owner, wrapper, docs | Owner moves to rank 1 | Rerank called more than once | 1 tool; exactly 1 rerank |
| Rerank should skip | Exact `rankCandidates` with a noisy candidate tail | Exact owner remains rank 1 | Any provider call | 1 tool; 0 provider calls |
| Lexical/semantic disagreement | Sparse puts literal owner first; dense puts conceptual wrapper first | Literal route selects sparse owner and exposes source disagreement in debug | Dense wrapper wins exact literal query | 1 tool; 0 embedding; 0 rerank |

### Metrics and deterministic acceptance

Use these definitions:

```text
owner reciprocal rank = 1 / owner rank, or 0 when absent
role coverage@k = required distinct roles present in top k / required roles
duplicate-family rate@k = derivative results in repeated owner families / k
context efficiency = accepted evidence roles / estimated model-visible tokens
steps to owner = completed tool calls before the owning target is available
```

Release-gate acceptance for the hermetic layer:

1. Exact identifier, exact path, literal, configuration and ownership workloads
   have owner@1 of 100%; exact identifier/path/ownership make zero provider calls.
2. Every conceptual/mixed/noise workload has the expected owner in the top 3;
   macro owner MRR across those workloads is at least 0.75 and cannot regress
   from the recorded baseline.
3. Architecture role coverage at limit 5 is 100% for entry/orchestrator,
   retrieval, ranking and finalization (entry and orchestrator may share one
   slot only when the fixture manifest says so).
4. Runtime scope returns zero generated/docs/fixture results. A test may appear
   only as supporting evidence and never above the runtime owner unless the
   query explicitly requests tests.
5. No owner family consumes more than two pre-rerank slots, and the second slot
   must have a distinct evidence role.
6. Expansion runs only in the manifest's ambiguous-primary case. Reranking runs
   exactly in the `rerank helps` case and remains off for deterministic routes.
7. Repeating a workload with shuffled provider-row insertion order produces the
   same semantic ordering, warnings, route and counters after normalizing only
   explicitly time-dependent fields.
8. All authority, source-freshness, mutation and navigation tests remain green;
   quality confidence never substitutes for those receipts.

### Result-limit sensitivity

Run every workload at limits 1, 3, 5, 10 and 20. Record owner rank, role
coverage, duplicate-family rate, provider calls, reranker candidates and bytes.

- Exact-route owner rank must remain 1 at every limit.
- Conceptual owners must be present by limit 3 and remain present as the limit
  grows.
- Required role coverage must be non-decreasing with limit.
- Provider-call count must not grow merely because the display limit grows.
- Reranker input may grow only up to its documented adaptive cap.
- Response bytes must stay within the requested evidence budget; a larger limit
  is not permission to repeat derivative evidence.

### Agent-step and context evaluation

Run the same known-target and unknown-target fixture tasks in two isolated
arms using one pinned small model and harness version:

1. **Native arm:** expose only that harness's normal repository search and
   bounded file-read capabilities. Do not prescribe a tool name; record the
   actual commands/tools and allow iterative search from one result to the next.
2. **Satori arm:** expose `search_codebase`, `file_outline`, `read_file`
   open-symbol and `call_graph`; prohibit native discovery until the target is
   found.

Pin the prompt, fixture tree hash, model, system instructions, maximum turns,
temperature (zero when supported), tool schemas and success judge. Record wall
time, steps to owner, every tool call, input/output tokens reported by the
harness, response bytes and first-owner correctness. If the harness exposes no
token count, report exact bytes and label `bytes / 4` only as an estimate. A
correct answer after excess searching does not pass the same efficiency grade
as a first-call owner result.

### Live-provider observational layer

Reuse `scripts/satori-live-latency-benchmark.mjs` and save its immutable JSON
artifact. It already covers warm exact, semantic, outline, concurrent exact,
open-symbol and call-graph operations plus native comparisons. Add the fixture
quality queries only after the hermetic gate passes.

- Record revision/tree hash, runtime fingerprint, provider/model, index
  generation, checkpoint status, arguments, samples, median/range, response
  bytes and provider counters.
- Use at least five warm samples for exact, lexical, conceptual and outline
  observations; do not present them as population percentiles.
- Warm exact and lexical targets are below 1 second with zero embedding/rerank.
- Conceptual median must not regress more than 10% from the recorded 2.992 s
  baseline while quality gates pass; approximately 2.5 s is the first target,
  not a correctness blocker when provider latency dominates.
- A live improvement is accepted only when provider-call reduction and quality
  evidence agree; wall time alone is insufficient.

## 10. Recommended implementation order

1. **Baseline:** land the immutable fixture, expected-answer manifest, stub
   providers and route/provider/candidate/context counters. Record the current
   quality/economic baseline before changing behavior.
2. **Remove proven waste:** delete the hybrid liveness query. Require identical
   hermetic ordering and deterministic missing-collection failure, then rerun
   the live benchmark.
3. **Make routing explicit without changing retrieval:** introduce the route
   discriminated union and debug reason, map it initially to current behavior,
   and prove byte/order equivalence. This isolates later changes.
4. **Deliver deterministic routes:** move provider acquisition behind routing
   and add exact path/literal/config/ownership/reference execution. Then add the
   sparse-only backend path. Stop if owner quality regresses.
5. **Reduce conceptual fan-out:** add the measured primary-coverage gate for
   expanded retrieval. Keep expansion for every corpus workload where it proves
   useful.
6. **Fix rerank economics:** owner-family deduplication, adaptive candidate count
   and role-enriched documents should land together so quality and cost are
   evaluated as one contract.
7. **Optimize evidence shown:** add role/token-budget selection while preserving
   the compact v2 envelope and navigation proof.
8. **Calibrate:** tune simple class-specific weights and confidence only from
   baseline/held-out evidence. Do not adopt raw-score blending without a proven
   calibration model.
9. **Optional repeated-query optimization:** add generation-bound embedding or
   result caches only if live traces show repeated-query cost remains material.
10. **Conditional indexing work:** change chunks or index metadata only if the
    post-routing corpus still demonstrates duplicate-family or role failures.

Each phase must pass the affected focused tests, the hermetic suite and frozen
authority/freshness/mutation/navigation contracts before the next begins. Stop
when an added phase fails to improve owner rank, role coverage, provider calls,
latency or context efficiency. The current evidence does not justify a ranking
rewrite, provider replacement, vector-database replacement or new authority
schema.
