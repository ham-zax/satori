# 2026-07-23 Operational Search and Navigation Findings

## Status and scope

This document began as the implementation-ready remediation contract for the
frozen witnesses below. R1-R6 have now been implemented and verified in the
working tree based on Satori revision
`36310a3f6e9bd255046a155d7997c46053950e79`. No user publication was cleared or
reindexed, and this result does not authorize a configuration or release
decision.

The investigation checked a reported operational run against:

- Satori source revision `36310a3f6e9bd255046a155d7997c46053950e79`;
- installed MCP runtime `@zokizuan/satori-mcp@6.1.0`;
- indexed repository `/home/hamza/repo/tradingview_ratio` at Git revision
  `9bd2f7681f2b55a17393b00172f06586b7181617`;
- the live Potion/LanceDB publication; and
- two simultaneously active Satori MCP runtime owners.

The target repository had one tracked modified file (`opencode.jsonc`) and one
untracked file (`cc.json`) during the investigation. Live evidence is therefore
specific to that source observation and the publication generations observed
during the run.

A later artifact review also checked target revision
`8d65bf288a4c8b297ce53d0563e3ff4d9d5ba3c7` after its reported full reindex.
That later readback is recorded separately below; it does not reinterpret the
earlier observations or authorize another reindex.

Priority meanings:

- `P1`: a valid public identity or correctness input can produce a false result.
- `P2`: a material availability, cross-tool consistency, or diagnostic defect.
- `P3`: a bounded product limitation already disclosed by the public contract.

## Verdict

| ID | Priority | Status | Finding |
| --- | --- | --- | --- |
| O1 | P1 | implemented and verified | A valid `symbolId` is authoritative; optional display labels no longer veto it. |
| O2 | P2 | implemented and verified | Exact unchanged dirty-source observations skip publication, and compatible cross-process sync callers join one durable owner. |
| O3 | P2 | implemented and verified | Multiline and stacked Python decorators retain one canonical decorator-inclusive span. |
| O4 | P2 | diagnostic attribution implemented | Failed semantic passes retain only redacted stable classifier evidence; the actual transient backend cause remains U1. |
| U1 | — | unresolved | The reported transient semantic failures were not proven to originate in LanceDB. |
| K1 | P3 | confirmed limitation | Python cross-file calls remain heuristic and can be served only through bounded source fallback. |
| K2 | — | not a defect | File-level search results cannot enter `call_graph`, but remain readable through their canonical span. |

### Follow-up artifact assessment

| ID | Priority | Status | Finding |
| --- | --- | --- | --- |
| F8 | P2 | implemented and verified | Operator-only queries derive retrieval text only from positive `must:`, `path:`, or `lang:` values; negative-only input is rejected. |
| F9 | — | disproven as stated; bounded follow-up complete | Call-graph storage is bidirectional. A later Phase 5B0/5B1 follow-up models exact same-class and uniquely authorized class-qualified Python member calls; typed, dynamic, external, and ambiguous receivers remain deliberately unresolved. |
| F10 | — | resolved with O2 | A successful coalesced freshness result can immediately drive the chained `search_codebase -> call_graph` path. |
| F11 | P3 | verified product gap | Arbitrary semantic queries return nearest-neighbor candidates without a calibrated no-answer decision. The supplied reranker explanation is false. |
| F12 | — | expected contract | Compact ordinary reads use a one-line transport envelope containing complete exact source; compact does not mean truncated. |
| F13 | — | expected scope; relevance affected by F8 | Runtime scope intentionally includes runtime configuration such as YAML. The operator-only query favored config chunks; an explicit implementation query returned Python ownership. |
| F14 | — | not an independent defect | Unicode is valid input. Mixed Chinese/English retrieval used the English code term; Chinese-only weak results reduce to the F11 no-answer/calibration question. |
| F15 | — | duplicate of F11 | A one-character query is valid and returns nearest neighbors. A hard minimum would also reject legitimate one-character identifiers. |
| F16/F19/F25 | P2 | implemented and verified | Noise guidance is suppressed when positive path intent already explains the result set or when runtime is already the active scope. |
| F17 | — | expected ownership | Module-level imports are file-owned evidence, so `groupBy="symbol"` can legitimately return a file group with no graph identity. |
| F18 | — | confirmed correct | A nonexistent filesystem path fails cleanly as `not_indexed`. |
| F20 | — | consistent with F8 | `lang:` plus one strong `must:` succeeds; this does not establish a path-filter intersection defect. |
| F21/F23 | — | duplicate of F12 | Compact ordinary reads annotate a one-line envelope but intentionally retain complete exact source. |
| F22 | — | not a new defect | A class is a container, not an aggregate call site. Method-level traversal now includes Phase 5B0/5B1's bounded exact Python receivers and remains conservative outside that contract. |
| F24 | — | duplicate of K2 | File grouping has no symbol identity and therefore cannot enter `call_graph`; its canonical source span remains readable. |
| F26 | — | expected contract | `limitSymbols` truncates a deterministic source-ordered outline; it is not an importance ranking. |
| F27/F28 | — | confirmed correct | Python keyword filters and newline-normalized queries behaved as documented. |
| F29 | P2 | implemented and verified | Rechecking an unchanged dirty observation preserves the prior continuation authority; actual source or publication changes still invalidate handles. |

## Execution contract

### Outcome

The implementation sequence is complete when:

- exact call-graph identity cannot be vetoed by optional display metadata;
- all public consumers project the same canonical multiline-decorator span;
- operator syntax never becomes lexical or semantic retrieval text;
- noise guidance respects explicit path intent and never recommends the active
  scope;
- an exact already-published dirty-source observation does not create another
  publication or stale a continuation;
- compatible cross-process freshness work has one durable owner and one
  deterministic outcome; and
- an otherwise unclassified semantic-pass failure retains enough redacted,
  stable evidence to identify its responsible subsystem.

These outcomes do not include broader call-graph recall, no-answer calibration,
file-level graph identities, outline importance ranking, compact-read
truncation, or multilingual retrieval.

### Baseline and repository safety

Before each implementation batch:

1. record the current Satori Git SHA and worktree status;
2. preserve all pre-existing staged, unstaged, and untracked changes;
3. reproduce that batch's smallest witness in a task-owned fixture or
   non-destructive invocation;
4. identify the exact files owned by the batch; and
5. stop if the witness no longer reproduces or evidence points to a different
   owner.

Do not clear or reindex the user's Satori or `tradingview_ratio` publication.
No full repository reindex is required for O1, O3, F8, the noise hint, or O4.
O2 must be proven with isolated state shared by two independent MCP runtimes.

### Batch boundaries

Each batch is independently reviewable and does not authorize the next:

| Batch | Finding | Primary owner | Expected change class |
| --- | --- | --- | --- |
| R1 | O1 | `packages/mcp/src/core/navigation-handlers.ts` | Call-graph identity resolution |
| R2 | O3 | `packages/mcp/src/core/python-call-fallback.ts` | Python source-span repair |
| R3 | F8 | `packages/mcp/src/core/search-query-planning.ts` | Operator-only retrieval query synthesis |
| R4 | F16/F19/F25 | `packages/mcp/src/core/search-query-support.ts` and its callers | Intent-aware diagnostic hint |
| R5a | O2/F29 | Core source-checkpoint comparison and `packages/mcp/src/core/sync.ts` | Exact unchanged-observation fast path |
| R5b | O2/F10 | Mutation lease, durable operation receipt, and `SyncManager` | Cross-process compatible-sync joining |
| R6 | O4/U1 | Search execution diagnostics and `backend-diagnostics.ts` | Redacted cause preservation only |

### Implementation result

| Batch | Result |
| --- | --- |
| R1 | Exact instance ID lookup ignores optional label drift while preserving file scope and retired-ID rejection. |
| R2 | Balanced decorator parsing preserves single-line, multiline, and stacked decorators without absorbing a sibling or unrelated comment. |
| R3 | Operator syntax is excluded from retrieval text; positive operator-only queries are explicit and negative-only queries fail validation. |
| R4 | Noise guidance accounts for explicit positive path intent and the already-active runtime scope. |
| R5a | A read-only descriptor-bound comparison proves whether explicit dirty paths still match the active source checkpoint; matching observations do not publish or stale continuations. |
| R5b | Separate runtime coordinators join the exact durable sync operation. Completion is accepted only with compatible runtime identity, a valid active checkpoint, and a matching requested source observation; failure, owner loss, incompatibility, and timeout fail closed. |
| R6 | Per-pass diagnostics retain only pass ID, allowlisted error name, stable classifier code, classifier owner, and known retryability. Arbitrary messages and custom error names are discarded. |

Verification used task-owned roots and the focused commands defined by each
batch. Affected Core synchronizer/context tests, the full MCP sync test file,
call-graph and query-planning tests, focused handler witnesses, Core/MCP
typecheck and lint, Core build, MCP runtime build, and `git diff --check`
passed. No paid provider, user index, or full repository reindex was used.

Python receiver-aware `CALLS` was excluded from R1-R6. After this operational
sequence was accepted, a separate authorization completed only Phase 5B0/5B1
from `docs/plans/SYMBOL_OWNED_RETRIEVAL_IMPLEMENTATION_PLAN.md`. That follow-up
does not alter this remediation's frozen findings or verification.

## O1 — Optional call-graph label vetoes a valid identity

### Witness

The same graph-ready target was invoked three ways:

| Input | Result |
| --- | --- |
| valid `symbolId`, no label | `status: ok`, callers returned |
| same valid `symbolId`, bare label `calculate_spread_from_frames` | `status: not_found`, `reason: missing_symbol` |
| same valid `symbolId`, canonical label `function calculate_spread_from_frames` | `status: ok`, callers returned |

The target was:

```text
file: src/python/core/spread_calculation.py
symbolId: syminst_9703cc2bb9f215821e4da38bc5dbd27b
span: 37-152
```

### First wrong boundary

`call_graph` requires `symbolId` and describes `symbolLabel` as optional display
metadata. `NavigationHandlers.handleCallGraph()` nevertheless forwards both to
`findExactRegistrySymbols()`. That function applies both predicates
conjunctively, so an incorrect optional label rejects the correct instance ID.

The canonical grouped-search flow is not broken: passing its `target` directly
omits the label and succeeds. The defect affects callers that add stale,
shortened, or otherwise non-canonical display metadata.

### Required invariant and later proof

When an exact `symbolId` is present, it is authoritative. Optional display
metadata must not change which symbol it identifies.

A later repair must prove:

1. valid ID with no label succeeds;
2. the same ID with a stale or bare label resolves the same symbol;
3. an invalid ID still fails closed;
4. file scoping and current symbol-instance validation remain enforced; and
5. legacy symbol keys and retired IDs remain rejected.

## O2 — Repeated dirty-source synchronization and cross-process contention

### Witness

Multiple sequential searches returned `freshnessDecision.mode: synced` with
zero changes while creating successive sync operation generations. During the
same run, a docs search returned:

```text
status: not_ready
reason: indexing
recommended action: manage_index status
```

An immediate status call showed that a zero-change sync owned by the other live
MCP process had completed. Retrying the same docs search succeeded.

### First wrong boundary

Search treats the presence of any Git-dirty file as requiring an exact source
comparison and calls `ensureFreshness()` with a zero threshold. Even when the
published source checkpoint already matches the current dirty file bytes, the
zero threshold proceeds into another sync.

`SyncManager.activeSyncs` is process-local. A second MCP process can observe the
shared snapshot's `indexing` state, but it cannot join the first process's
in-memory promise and returns `skipped_indexing`/`not_ready` instead.

The original `ready` status was a valid point-in-time observation, so this is
not proof that status lied. The defect is repeated unnecessary work plus weak
cross-process coordination, which makes a ready publication transiently
unavailable to another caller.

### Required invariant and later proof

An unchanged source observation already represented by the active publication
must not purchase another publication merely because it differs from Git
`HEAD`. Overlapping compatible freshness work must have deterministic
cross-process behavior and expose the durable owning operation.

A later repair must use two independent MCP runtimes and prove:

1. an already-published dirty file does not trigger repeated zero-change syncs;
2. a newly changed file is still detected and published before stale evidence
   is served as current;
3. a compatible in-flight sync is joined, waited on, or reported through one
   explicit durable operation rather than a process-local collision;
4. failed freshness work does not make an unproven generation searchable; and
5. clean, watcher-disabled, restart, and ordinary single-process behavior do
   not regress.

An estimated duration is optional presentation. It does not repair the owning
coordination defect.

## O3 — Multiline Python decorators produce inconsistent canonical spans

### Witness

For `TestPortfolioScanner.test_combination_generation` in
`tests/test_portfolio_scanner.py`, the source contains a multiline
`@pytest.mark.parametrize(...)` decorator beginning at line 121 and the `def`
at line 128.

For the same `symbolId`:

- `search_codebase` returned span `128-151` and
  `SEARCH_SPAN_START_BEFORE_DEF`;
- `file_outline(resolveMode="exact")` returned span `121-151`, correctly
  retaining the decorator.

### First wrong boundary

The persisted extractor span is not the demonstrated defect. The search-side
`findPythonDecoratedDefinitionStart()` walks upward only through lines whose
trimmed text begins with `@`. The closing line of a multiline decorator is `)`,
so the repair stops immediately and incorrectly moves the start to the `def`.

This creates conflicting canonical targets across public tools and a false
warning that the stored span began before the actual definition.

### Required invariant and later proof

Search, exact outline, exact symbol reads, and graph preparation must agree on
the same decorator-inclusive Python definition span.

A later repair must cover a plain function, a single-line decorator, a
multiline decorator, stacked decorators, and a following sibling definition.
It must prove the repair never absorbs unrelated comments or the previous
symbol.

## O4 and U1 — Backend failure attribution remains unproven

The reported run observed `search_backend_failed` and one
`SEARCH_PASS_FAILED:expanded` warning. Those observations establish degraded
search calls, but not a LanceDB root cause.

Four bounded replays of the two reported queries all succeeded:

```text
testing framework pytest fixtures       2/2 ok
pair discovery cointegration test       2/2 ok
```

`search_backend_failed` is emitted after every attempted semantic pass rejects
and neither the embedding nor vector classifier recognizes the rejection. The
public response then replaces the underlying cause with a generic message.
Local LanceDB errors are not currently a stable diagnostic category, so the
same envelope could represent LanceDB, embedding-helper, lifecycle, or another
unclassified failure.

The expanded pass is not a separate vector space. It sends a second query with
`implementation runtime source entrypoint` appended through the same semantic
search boundary and active publication.

### Required diagnostic proof

Before attributing or repairing a backend failure, capture a redacted stable
cause code for each rejected pass. Do not persist query text, source text,
vectors, credentials, or opaque upstream error payloads.

The stopping condition is one reproduced failure with enough classified
evidence to name its responsible owner. A successful retry alone is not a root
cause.

## K1 — Python call-graph confidence is bounded and heuristic

The live traversal for `calculate_spread_from_frames` returned 26 dynamic edges
at confidence `0.65`. It also returned 24 suppressed relationship candidates
at confidence `0.35`.

This is not Pyright or compiler-level evidence. The relationship builder marks
cross-file direct calls low-confidence, and the fallback validates suppressed
Python callers from bounded source-line and unambiguous-name evidence. Absolute
Python imports are not currently used to promote these calls to stronger
binding-backed evidence.

This matches the public contract: `call_graph` is heuristic, bounded,
incomplete, advisory, and requires independent inbound verification. Improving
absolute-import resolution is separate product work, not a prerequisite for
repairing O1-O4.

## K2 — File-level results remain readable

A file-level result correctly reports `navigation.graph: missing_symbol`
because it has no symbol registry identity. It is not a navigation dead end:
the search envelope returns a canonical `read_file` action using the result's
validated span. A live docs search returned such an action for ADR-001.

No call-graph fallback should invent a symbol identity for file-owned evidence.

## F8 — Operator-only retrieval text is contaminated by filter syntax

### Witness

The reported combination failed:

```text
must:spread path:src/python/core -path:scripts
-> 0 results, FILTER_MUST_UNSATISFIED
```

It is not a general filter-composition failure. Keeping the same operators and
adding a semantic query succeeded:

```text
must:spread path:src/python/core -path:scripts spread calculation
-> 14 available groups, 10 returned
```

Operator order did not change that result. `must:spread path:src/python/core`
without the exclusion also returned 10 results. The `-path:scripts` form with
no semantic text returned zero, while the same exclusion with `spread
calculation` returned the expected source groups.

The filter pipeline applies scope, language, path inclusion, path exclusion,
and then `must:` in that order. The supplied explanation that `must:` runs
before path scoping is therefore false.

### First wrong boundary

`parseSearchOperators()` correctly extracts the operators. When no ordinary
semantic token remains, `deriveOperatorOnlySemanticQuery()` derives a clean
query only for one strong identifier-like `must:` value. For weak identifiers,
multiple `must:` values, or other operator-only forms, it falls back to the
complete original query.

Retrieval therefore sees text such as:

```text
must:spread path:src/python/core -path:scripts
```

rather than a clean retrieval query such as `spread`. The path tokens influence
the bounded lexical/dense candidate set before the correctly ordered filters
run. By the time `-path:scripts` removes script candidates, relevant source
candidates may never have entered the bounded set.

The documented usage includes semantic text after the operator prefix, so this
is a P2 operator-only edge rather than a critical failure of normal composed
queries. The warning is still misleading because the `must:` token is valid;
retrieval candidate starvation caused the empty intersection.

### Required invariant and later proof

Operator syntax must never become semantic or lexical retrieval content. If an
operator-only request is supported, its retrieval terms must be derived
explicitly from the applicable value-bearing operators. Otherwise the request
must fail validation with a precise instruction to add semantic text.

A later repair must compare:

1. weak `must:` alone;
2. strong identifier `must:` alone;
3. multiple `must:` values;
4. `must:` plus `path:`;
5. `must:` plus `-path:`;
6. the same filters with explicit semantic text; and
7. escaped operator literals that must remain ordinary query text.

The proof must show identical parsed filters and that path syntax never enters
the provider or lexical retrieval query.

## F9 — Empty callees reflect unsupported call categories, not reversed edges

`calculate_spread_from_frames` returned only its root node for
`direction="callees"`. The function primarily invokes:

- member calls such as `pd.merge`, `model.calculate_metrics`, and
  `SpreadModelFactory.create_model`;
- Python class construction such as `SpreadModelConfig(...)` and
  `SpreadCalculationResult(...)`; and
- built-ins such as `isinstance`, `getattr`, `ValueError`, and `TypeError`.

The current relationship builder persists direct function calls and supported
constructor forms. It does not model Python member dispatch, and a Python call
node naming a class is not classified as a constructor by the current
tree-sitter adapter. The reported root therefore has no eligible outgoing
relationship.

The graph is not unidirectional. A live `direction="callees"` traversal of
`run_validation` returned six outgoing edges: five relationship-backed edges
at confidence `0.95` and one source-fallback edge at `0.65`.

The current output can still be mistaken for proof that a function is a leaf.
That is already bounded by the public advisory contract: empty or short graph
results are not proof of no calls. Adding Python member/constructor resolution
or a structured coverage note is separate navigation-quality work, not a
correctness repair for reversed graph storage.

## F10 — Call-graph freshness blocking shares O2's owner

`call_graph` checks the same publication readiness state and intentionally
returns `not_ready/indexing` rather than reading a partially activated
navigation generation. A search that completes its own in-process sync can be
followed by `call_graph`; the failure arises when another MCP process owns a
shared publication that the current process cannot join.

Do not weaken call-graph generation consistency. Repair O2's redundant
dirty-source work and cross-process joining, then retain one focused chained
`search_codebase -> call_graph` proof under two runtime owners.

## F11 — Arbitrary semantic queries lack a no-answer contract

A live `xylophone banana nonexistent` query returned 72 available groups and
exposed the requested 15. The first ten public scores were approximately
`0.019-0.023`.

The diagnostic record showed:

```text
retrieval mode: hybrid
score policy: topk_only
semantic candidates: 79
lexical candidates: 0
reranker calls: 0
backend score kind: rrf_fusion
```

The supplied explanation that a reranker admitted weak results is false. No
reranker was available or invoked. The active query plan deliberately asks for
top-K candidates without a minimum dense-similarity threshold.

The public group score is a fused/ranking score, not a portable cosine or
relevance probability. `quality.semantic="medium"` currently describes the
kind of evidence used; it is not a calibrated claim that the result is relevant.

This behavior is normal for nearest-neighbor retrieval and does not prove that
Potion is uniquely defective. It becomes a product defect only if Satori
adopts a no-answer or minimum-relevance contract. Such a contract requires
provider-specific negative-query evidence and must preserve useful weak lexical
and exact-owner recovery. Do not select a threshold from this one query.

## F12 — Compact reads preserve complete exact source by design

A bounded replay produced a single-line JSON transport envelope with:

```text
presentation: compact
requested range: 1-170
clamped file range: 1-152
source lines in envelope: 152
```

This matches the documented contract and `compactSourceRange()` implementation:
compact removes raw multiline transport presentation while retaining the
complete exact `source` field. `presentation="full"` emits raw multiline source.
Neither mode promises truncation or summarization.

No implementation repair is required. Documentation may use the phrase
"single-line envelope with complete source" wherever the shorter word
"compact" could be misread as a token budget.

## F13 — Runtime scope intentionally includes configuration

`scope="runtime"` excludes docs, generated output, artifacts, landing pages,
and fixtures. It does not mean source-code extensions only. Neutral runtime
configuration paths such as `config/profiles/*.yaml` are intentionally
eligible.

`must:Kelly must:fractional` returned four YAML files where both tokens occur
together. Adding explicit intent:

```text
must:Kelly must:fractional position sizing implementation
```

returned `src/python/core/risk_manager.py` and its
`calculate_position_size_usd` owner. This is useful configuration evidence plus
the operator-only candidate-selection behavior described in F8, not a scope
violation.

## F14 — Unicode acceptance is correct; multilingual relevance is unqualified

The mixed query `散度 模型 copula` returned relevant copula configuration and
runtime owners because the literal English code term `copula` supplied strong
lexical evidence. The Chinese-only query `散度 模型` returned weak nearest-neighbor
groups with scores around `0.016-0.027` and no lexical evidence.

Satori should continue accepting valid Unicode. The current Potion contract
does not promise Chinese natural-language retrieval or translation. Weak
Unicode-only results are another instance of F11; rejecting non-ASCII input
would neither establish relevance nor be a correct repair.

## F15 — One-character queries are valid nearest-neighbor requests

A live `a` query returned 27 available groups and exposed the requested five,
with scores around `0.025-0.033`. This is the same top-K behavior established
by F11, not a separate correctness defect.

The public schema deliberately accepts any non-empty string. A hard minimum
length would also reject valid code queries such as `x`, `i`, or another
one-character identifier. Query cost control or a calibrated no-answer policy
would require a separate product contract; length alone is not a sound
relevance boundary.

## F16, F19, and F25 — Noise mitigation ignores declared search intent

### Witness

The live request:

```text
query: must:def path:tests
scope: runtime
```

returned ten test-owned groups. Its hint correctly measured the top five as
`tests: 1.0`, but then reported `top_results_noise_dominant` and advised:

```text
recommendedScope: runtime
Use scope="runtime" to reduce noise.
```

The recommendation is both redundant—runtime was already active—and
contradictory because `path:tests` explicitly requested test evidence.

### First wrong boundary

`buildNoiseMitigationHint()` receives only the codebase root, returned file
paths, and current scope. It does not receive the parsed operators or any
record of explicit path intent. Except for docs scope, it classifies tests as
noise and always recommends runtime when the top-file ratio crosses its fixed
threshold. It therefore cannot distinguish accidental test dominance from an
explicit request for tests, and it cannot notice that its recommendation is
already active.

This is one P2 diagnostic defect, not three independent failures. A later
repair must prove that:

1. explicit `path:tests` intent suppresses test-noise remediation;
2. a recommendation equal to the active scope is not emitted;
3. genuinely unintended test-heavy mixed/runtime results still receive an
   actionable, non-redundant hint; and
4. docs-scope and root-ignore behavior remain unchanged.

## F17 — Import evidence can be file-owned by design

The exact `must:import pandas must:numpy` request returned file groups for
modules whose top-level import region contains the required evidence. Import
statements outside a function or class do not have an honest function-level
owner, so symbol grouping falls back to the file contribution. Those results
correctly report `navigation.graph: missing_symbol` and retain canonical source
spans.

Inventing a function owner would be incorrect. If import/module navigation is
later desired, it needs an explicit module-level identity contract rather than
relabeling file evidence as a callable symbol.

## F18, F27, and F28 — Positive boundary behavior

The supplied observations are consistent with the current public contract:

- a nonexistent absolute path fails cleanly as `not_indexed`;
- Python keyword values can participate in `must:` filters; and
- newlines in query text are normalized as whitespace.

They require no remediation entry.

## F20 — `lang:` success reinforces the narrowed F8 diagnosis

`lang:python must:calculate_spread` succeeding does not prove that `path:` is
implemented as a broken intersection. The strong single identifier allows
`deriveOperatorOnlySemanticQuery()` to produce clean retrieval text, after
which the language and must filters compose normally.

F8 remains specifically about operator syntax leaking into retrieval text when
the operator-only fallback cannot derive a clean semantic query. Its required
proof should cover both `lang:` and path filters, but the responsible boundary
is query synthesis rather than filter ordering.

## F21 and F23 — Compact names transport, not source quantity

These observations repeat F12. `presentation="compact"` wraps the requested
range in a compact one-line JSON representation with a preview and the complete
exact source. It does not promise summarization or truncation.

The wording can be misunderstood, but the tool description already states
"one-line compact envelope" and "complete exact source." No code change is
required by the observed response.

## F22 — A class root does not aggregate method call sites

The live outline for `CircuitBreaker` records the class at lines `171-493` and
its methods as separate symbol instances. Traversing the class identity does
not aggregate calls made inside every child method, so a root-only class graph
does not establish that the class's methods are isolated.

Method-level traversal remains subject to F9's known Python limitations,
especially unresolved member dispatch such as `self.method(...)`. The reported
class result adds no evidence of reversed storage or a new graph defect.

## F24 — File grouping has no graph identity

This repeats K2. `groupBy="file"` deliberately produces file-owned targets,
which have no callable symbol identity and therefore report
`navigation.graph: missing_symbol`. They remain actionable through their
canonical `read_file` request. Call-graph workflows must start from a concrete
graph-ready symbol, normally found through symbol grouping or `file_outline`.

## F26 — Outline limits preserve source order

A live `limitSymbols: 3` outline returned `class CircuitState`, `method __str__`,
and `method emoji`, followed by `hasMore: true`. This is deterministic and
matches `sortFileOutlineSymbols()`, which orders by source span before applying
the limit.

`limitSymbols` is documented only as a maximum after line filtering. It is not
an importance or public-API ranking. A caller seeking `check_drawdown` should
use an exact symbol request or a line window, not infer importance from a
truncated outline.

## F29 — Continuation invalidation exposes O2's repeated publication

### Witness

A broad grouped search produced a continuation handle at offset 2. Continuing
that handle directly succeeded and returned the next two frozen groups.

A second bounded run then performed:

```text
search A -> continuation handle
search B on the same working tree
continue search A
```

Both searches reported `syncMode: synced`, `changedFileCount: 1`, and distinct
`lastSyncAt` values for the same already-published Git-dirty working tree.
Continuation A then failed explicitly with:

```text
SEARCH_RESULT_SET_STALE
Search publication or source observation changed.
```

This disproves the claim that the handle simply expires after roughly 0.3
seconds: direct continuation remained valid. It also narrows the impact. A
second search invalidates the handle on this dirty root because O2 purchases a
new publication authority for the same source bytes, not because every search
unconditionally clears the continuation cache.

### Correctness boundary

`continue_search` freezes ranked results but also binds them to the proven
vector/navigation generation and exact source observation. It revalidates both
before and after page projection. Invalidating a handle after a genuine source
or publication change is required; serving the old target as current would be
incorrect.

The defect is O2's redundant dirty-source publication. It makes pagination
operationally fragile in an actively edited repository even when the bytes have
not changed between searches. This is a P2 availability consequence, not an
independent critical continuation-correctness failure.

Repair O2 rather than weakening continuation authority. The later proof must
show:

1. immediate continuation remains stable and retrieval-free;
2. another search over the identical already-published dirty observation does
   not change authority or stale the handle;
3. a real source change still invalidates the handle before disclosure;
4. a publication change, restart, expiry, and unavailable owner still fail
   closed with their existing codes; and
5. continuation never holds or reads a garbage-collected generation.

## Later full-reindex artifact review

The later probe summary mixed valid observations with conclusions contradicted
by the current source and live post-reindex publication.

| Claim | Review |
| --- | --- |
| Optional `symbolLabel` vetoes a valid `symbolId` | Confirmed O1. |
| Satori's Python relationship sidecar contains no `CALLS` edges | Disproved. A post-reindex `run_validation` traversal returned six outgoing edges. |
| An unchanged `sidecarBuiltAt` across zero-change generations proves staleness | Disproved. Unchanged relationship contributions should reuse their sealed sidecar. The full reindex advanced `sidecarBuiltAt` from `01:46:05.691Z` to `02:33:28.490Z`. |
| `callGraph="degraded"` means Python `CALLS` was never enabled | Disproved. Status declared Python `calls_v0` with compatible relationship evidence; degradation was `symbol_evidence_partial` because 902 of 944 eligible Python files contained non-file symbols. |
| Search and outline now agree on the multiline decorator span | Disproved after the reindex. Search returned `128-151`; exact outline returned `121-151` for the same `symbolId`. O3 remains open. |
| Intermittent semantic failure is a pure LanceDB connectivity/locking issue | Unproven. O4 still lacks a stable classified failure cause. |
| F8 no longer reproduces | Disproved. The probe used only the strong-identifier branch. The original weak operator-only witness still returned `FILTER_MUST_UNSATISFIED`, while adding `spread calculation` returned 14 groups. |
| Adding tracked files to `.satoriignore` mitigates O2 | Disproved for `opencode.jsonc`. Search still reported it as the one changed file and purchased another sync. |

### Python graph coverage is partial, not empty

The post-reindex exact outline resolved `function run_validation` with a
compatible graph hint. `call_graph(direction="callees")` returned six edges:
five relationship-backed calls at confidence `0.95` and one bounded fallback at
`0.65`.

The selected zero-edge probes are dominated by Python member calls such as:

```text
self._determine_new_state(...)
self._handle_state_transition(...)
self._build_state_snapshot(...)
model.calculate_metrics(...)
dashboard.portfolio_scanner(...)
```

The language-analysis adapter already records these as `CallSite` values with
`kind="member"`, `receiverText`, and `qualifiedCallee`. The first wrong boundary
is `buildCallRelationshipsForRegistry()`, which currently accepts only
`direct` and `constructor` calls. Empty graphs for those functions therefore
measure missing receiver/type resolution, not a missing, stale, or wrongly
queried relationship store.

The separate codebase-memory graph is not Satori's "actual relationship
store." Its reported 11,529 `CALLS` records belong to a different parser,
resolver, node ontology, and SQLite publication. It is useful comparator
evidence, but its edge count is not interchangeable with Satori's conservative
repository-symbol graph.

### Reindex and ignore changes were not repairs for these owners

A full reindex rebuilt a compatible current sidecar, but it could not create
member-call edges that the relationship builder intentionally drops. Another
reindex is therefore not a repair for Python receiver coverage.

`.satoriignore` controls index eligibility. The search freshness precheck uses
tracked paths from `git status --porcelain --untracked-files=no` and does not
apply `.satoriignore`; Git also continues to report modifications to a tracked
file even when another ignore file names it. The live freshness diagnostic
still identified `opencode.jsonc`, so the committed ignore entry did not
mitigate O2's repeated dirty-source comparison.

`SEARCH_TRUNCATED_SYMBOL_SPAN` on the one-line protocol declaration is a source
repair warning, not evidence that the relationship store is empty. It remains
an adjacent span-extraction observation unless a concrete wrong public span or
edge is demonstrated.

## Implementation batches

### R1 — Make call-graph instance identity authoritative

Visible failure:

```text
valid symbolId + non-canonical optional symbolLabel
-> missing_symbol
```

Responsible owner:

- causal repair:
  `packages/mcp/src/core/navigation-handlers.ts::handleCallGraph`;
- existing exact-match primitive:
  `packages/mcp/src/core/registry-file-outline.ts::findExactRegistrySymbols`;
- nearest proof:
  `packages/mcp/src/core/handlers.call_graph.test.ts`.

Implementation:

1. When `symbolRef.symbolId` is present, resolve the call-graph root by
   `symbolInstanceId` within the already-bound registry and file/root
   authority.
2. Do not pass `symbolLabel` as a second veto predicate in that path.
3. Retain label matching only for legacy/no-ID resolution paths where the
   public contract still permits it.
4. Do not globally weaken `findExactRegistrySymbols()` without proving its
   `file_outline` and exact-open consumers require the same precedence.

Acceptance:

- valid ID with no label, canonical label, bare label, and stale label all
  resolve the same root;
- an invalid, retired, wrong-root, or wrong-file ID remains rejected;
- two same-label symbols remain deterministic by ID; and
- response schema, graph traversal, ordering, and readiness behavior do not
  change.

Focused check:

```bash
pnpm --dir packages/mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/core/handlers.call_graph.test.ts
```

Stop after R1 when the public witness and this focused file pass. Do not add
Python relationship edges in this batch.

### R2 — Preserve complete Python decorator spans

Visible failure:

```text
same symbolId
-> search span 128-151
-> exact outline span 121-151
```

Responsible owner:

- causal repair:
  `packages/mcp/src/core/python-call-fallback.ts::findPythonDecoratedDefinitionStart`;
- nearest unit proof:
  `packages/mcp/src/core/python-call-fallback.test.ts`;
- public cross-tool proof:
  the existing search/outline handler tests closest to Python span repair.

Implementation:

1. Validate the stored prefix between its start and the definition, then walk
   upward through balanced multiline decorator expressions at the same
   indentation. Preserve stacked decorators.
2. Stop at the first unrelated statement, comment block, blank separator, or
   different indentation.
3. Reuse the repaired span in existing search, outline, exact-read, and
   call-graph preparation paths; do not create a second span algorithm.
4. Preserve the stored extractor span as indexed evidence. This batch repairs
   its source-backed public projection only.

Acceptance:

- plain, single-line-decorated, multiline-decorated, and stacked-decorator
  fixtures return the expected start;
- a following sibling and preceding unrelated comment are never absorbed;
- search and exact outline return identical spans for the same ID; and
- warnings describe an actual repair rather than claiming the valid decorator
  prefix is before the definition.

Focused check:

```bash
pnpm --dir packages/mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/core/python-call-fallback.test.ts
```

Run one existing handler-level cross-tool case after the unit proof. Do not
change the Core Python extractor unless that public proof demonstrates that
source repair cannot produce one canonical span.

### R3 — Derive operator-only retrieval text explicitly

Visible failure:

```text
must:spread path:src/python/core -path:scripts
-> provider/lexical query contains operator syntax
-> bounded candidate starvation
```

Responsible owner:

- causal repair:
  `packages/mcp/src/core/search-query-planning.ts::deriveOperatorOnlySemanticQuery`;
- parser and plan proof:
  `packages/mcp/src/core/search-query-support.test.ts`;
- one public search proof:
  `packages/mcp/src/core/handlers.scope.test.ts`.

Implementation:

1. If ordinary semantic text exists, preserve it exactly as the retrieval
   query.
2. If a request contains one or more `must:` values and no ordinary semantic
   text, derive retrieval text only from those normalized values in input
   order.
3. Never include `path:`, `-path:`, `lang:`, `exclude:`, or their raw syntax in
   semantic or lexical provider text.
4. Preserve escaped operator-looking literals as ordinary query text.
5. Preserve the exact-identifier route for a single strong identifier.
6. If an operator-only form has no positive retrieval-bearing value, reject it
   with existing invalid-query machinery rather than sending raw operator
   syntax to retrieval.

Acceptance:

- weak, strong, quoted, and multiple `must:` values produce explicit clean
  retrieval text;
- `must:` plus path inclusion/exclusion changes filters but not retrieval text;
- adding explicit semantic text preserves that text;
- escaped literals remain searchable; and
- handler-level evidence shows the backend request never receives path syntax.

Focused check:

```bash
pnpm --dir packages/mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/core/search-query-support.test.ts
```

Stop after the known `must:spread` witness returns an eligible source result.
Do not change filter ordering, ranking, candidate budgets, or provider policy.

### R4 — Make noise guidance respect declared intent

Visible failure:

```text
path:tests + scope=runtime
-> 100% intended test results
-> recommends scope=runtime
```

Responsible owner:

- causal repair:
  `packages/mcp/src/core/search-query-support.ts::buildNoiseMitigationHint`;
- affected consumers:
  `search-result-finalization.ts`, `search-exact-fast-path.ts`,
  `search-exact-registry-hit.ts`, and continuation projection in
  `handlers.ts`;
- nearest proof:
  `packages/mcp/src/core/handlers.scope.test.ts`.

Implementation:

1. Pass parsed positive path intent to the existing hint builder.
2. Suppress category-noise remediation when the returned category was
   explicitly selected through a positive path constraint.
3. Suppress any recommendation equal to the already-active scope.
4. Preserve genuine mixed-scope noise guidance when no explicit path explains
   the noisy result set.
5. Recompute continuation hints from the frozen query and result set; do not
   change continuation authority or ranking.

Acceptance:

- `path:tests` does not advise removing the requested tests;
- `scope=runtime` never recommends `scope=runtime`;
- an unscoped mixed result dominated by accidental test/fixture/generated
  files retains one useful hint;
- docs scope remains silent; and
- exact, raw, grouped, and continuation projections use the same intent rule.

Focused check:

```bash
pnpm --dir packages/mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  --test-name-pattern='noiseMitigation|continuation' \
  src/core/handlers.scope.test.ts
```

Do not change search scope semantics or exclude YAML from runtime scope.

### R5a — Skip an exact already-published dirty observation

Visible failure:

```text
dirty tracked path bytes already equal active source checkpoint
-> ensureFreshness(0)
-> new zero-change publication authority
```

Responsible owner:

- source comparison authority: the active Core `FileSynchronizer` checkpoint
  and the publication receipt bound to it;
- orchestration:
  `packages/mcp/src/core/sync.ts::ensureFreshness`;
- changed-path observation:
  `packages/mcp/src/core/working-tree-state.ts`;
- nearest proofs:
  Core synchronizer/context tests, `packages/mcp/src/core/sync.test.ts`, and
  the continuation cases in `handlers.scope.test.ts`.

Implementation:

1. Add one read-only Core comparison that binds:
   - the proven active publication/source checkpoint;
   - the exact normalized tracked paths reported dirty;
   - current safe file observations for those paths; and
   - the checkpoint's stored path/hash membership.
2. Return only `matches`, `differs`, or `unavailable`; do not mutate or commit
   the synchronizer checkpoint during comparison.
3. Treat a missing current path, a newly indexable path, changed bytes,
   changed ignore authority, observation drift during comparison, or an
   incompatible/missing checkpoint as `differs` or `unavailable`, never
   `matches`.
4. When the exact comparison returns `matches`, preserve the active receipt
   and source observation and return a truthful non-publication freshness
   decision such as `skipped_source_unchanged`.
5. When it returns `differs` or `unavailable`, retain the existing fenced sync
   path.
6. Do not use a TTL, Git `HEAD`, file mtime, size alone, or an in-memory-only
   cache as freshness authority.

Acceptance:

- two searches over identical dirty bytes retain the same publication/source
  authority;
- the second search performs no vector, lexical, navigation, graph,
  checkpoint, proof, or receipt writes;
- immediate continuation and continuation after the second identical search
  both succeed without retrieval;
- a byte edit, deletion, addition, rename, ignore-policy change, or observation
  race still enters fenced synchronization;
- a real accepted publication still stales the old continuation; and
- restart can make the same decision from durable checkpoint authority.

Focused checks:

```bash
pnpm --dir packages/core exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/sync/synchronizer.test.ts src/core/context.test.ts
pnpm --dir packages/mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/core/sync.test.ts
```

The Core package run is justified only if its checkpoint comparison contract is
changed. Use an isolated root and state directory; do not exercise the user's
publication.

### R5b — Join compatible cross-process freshness work

Visible failure:

```text
runtime A owns compatible sync
runtime B observes indexing but cannot join A's in-memory promise
-> not_ready/indexing
```

Responsible owner:

- durable exclusion: `packages/mcp/src/core/mutation-lease.ts`;
- durable progress/result: operation receipts in
  `packages/mcp/src/core/snapshot.ts`;
- orchestration: `packages/mcp/src/core/sync.ts`;
- public readiness: search and navigation front doors.

Implementation:

1. Keep `SyncManager.activeSyncs` as the same-process fast join.
2. When lease acquisition reports a live `sync` for the same canonical root
   and compatible runtime/publication authority, observe that exact durable
   operation rather than starting another sync.
3. Wait within the existing bounded tool/freshness deadline, then re-read the
   terminal operation receipt, active receipt, and source checkpoint.
4. Return `coalesced` only when the completed operation proves the requested
   source observation current. Preserve the operation identity in the
   freshness decision.
5. If the owner fails, loses its lease, changes authority incompatibly, or does
   not finish within the bound, fail closed with the durable operation;
   do not serve a mixed or unproven generation.
6. Do not create a second coordination file, lock, or receipt authority.

Acceptance:

- two independent MCP runtimes over one isolated root produce one sync
  operation and one activated generation;
- the waiter reports the owner's durable operation and can search/call graph
  after its successful activation;
- failure, abandoned owner, incompatible runtime, timeout, and restart remain
  fail-closed;
- no completion proof is withdrawn by the waiter; and
- single-process coalescing and ordinary watcher-disabled behavior remain
  unchanged.

Focused check:

```bash
pnpm --dir packages/mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/core/sync.test.ts
```

Add one handler-level chained `search_codebase -> call_graph` proof only because
F10 is a direct consumer of this coordination boundary. Do not redesign
freshness debounce or watcher policy.

### R6 — Preserve a redacted semantic-pass cause

Visible failure:

```text
all semantic passes reject
-> neither existing classifier recognizes the error
-> search_backend_failed with no stable responsible-owner evidence
```

Responsible owner:

- pass capture: `packages/mcp/src/core/search-execution.ts`;
- recognized backend classification:
  `packages/mcp/src/core/backend-diagnostics.ts`;
- response projection and test-only failure injection:
  `packages/mcp/src/core/handlers.ts` and
  `packages/mcp/src/core/handlers.scope.test.ts`.

Implementation:

1. Preserve, per failed pass, only an allowlisted error class/name, stable
   machine code, classifier result, retryability when known, and pass ID.
2. Never expose or persist arbitrary messages, query text, source text,
   vectors, credentials, URLs containing credentials, or opaque provider
   payloads.
3. Keep recognized embedding/vector diagnostics authoritative.
4. For an unrecognized failure, expose the redacted diagnostic only through
   the existing diagnostic/debug channel while retaining the normal generic
   user message.
5. Use the existing deterministic test fault seam to prove partial-pass and
   all-pass behavior. Do not add retries or a backend repair in this batch.

Acceptance:

- a synthetic unclassified error retains the same redacted identity across
  primary and expanded pass records;
- recognized embedding and vector errors preserve their current public codes;
- partial failure still returns usable results with one degraded warning;
- all-pass failure remains `search_backend_failed`;
- a secret-bearing error message does not appear in normal output, debug
  output, logs captured by the test, or persisted diagnostics; and
- one future real reproduction can distinguish embedding, vector, lifecycle,
  or still-unclassified ownership without revealing sensitive data.

Focused check:

```bash
pnpm --dir packages/mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  --test-name-pattern='semantic pass|backend|embedding' \
  src/core/handlers.scope.test.ts
```

Stop after diagnostic attribution. Repair the newly identified backend only
under a separate witness and authorization.

## Sequence and completion

Executed in this order:

```text
R1 -> R2 -> R3 -> R4 -> R5a -> R5b -> R6
```

After each batch:

1. inspect the complete batch diff;
2. run its focused witness and nearest deterministic tests;
3. run MCP typecheck and focused lint only for files whose contract changed;
4. record any pre-existing failure separately; and
5. stop if the batch acceptance fails.

Do not run the broad MCP suite after every batch. Run affected Core tests only
for R5a and affected cross-process/handler tests only for R5b. After the final
accepted batch, run:

```bash
pnpm --dir packages/mcp typecheck
pnpm --dir packages/mcp lint
pnpm --dir packages/mcp build:runtime
git diff --check
```

R1-R6 met their individual acceptance criteria in the current working tree.
The remaining U1 result is intentionally a classified diagnostic unknown, not
a backend repair claim. A later separately authorized follow-up completed
Phase 5B0/5B1 with frozen relationship-builder fixtures; Phase 5B2 remains
unimplemented and unauthorized.
