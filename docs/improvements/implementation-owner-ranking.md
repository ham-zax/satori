# Implementation ownership in default code discovery

Status: definition discovery implemented, evaluated and enabled by default on
2026-10-04. Set `flags: { definition_discovery: false }` to compare the baseline.
The new path admits
published symbol metadata, combines definition BM25 with LateOn order, and
selects the most specific query-matching definition within each file's
existing slots. It retains one reranker call and the existing result budget.
The [current results and limitations](reranker-owner-investigation.md#definition-discovery-engine)
include recovery of the judged targets from the four replayed Colonist queries
within ten visible results, with tracker judged by path. This is not a general
recall guarantee. The cross-repository check preserved accepted owners within
ten results, but includes two head-rank regressions and remaining retrieval misses.

The later [four-repository reranker comparison](reranker-owner-investigation.md#four-repository-reranker-comparison)
supports retaining the combined default for implementation discovery: among
nineteen named-symbol questions, owner@1 was 68.4% with the pipeline enabled
versus 21.1% with the reranker disabled; owner@10 was 78.9% in both arms.
That gain costs seconds per eligible query. The comparison also disables
definition fusion in its OFF arm, so it does not isolate LateOn's contribution.
Exact owners can still be demoted or omitted, even when their file ranks first.

The earlier first step is implemented behind the off-by-default
`neutral_owner_preference` search flag. A paired evaluation on clean
`colonist-assistant` commit `40a7c12` did not restore the missing owners to the
disclosed top 10; the flag remains off by default. A separate
[`symbol_metadata_bm25` experiment](q5-retrieval-investigation.md#paired-result-of-the-metadata-experiment)
recovers the missing Q5 owners into the reranker, but alone they finish at ranks
34 and 55 and remain undisclosed. It also stays off by default. Recorded 2026-10-03.

The [consolidated investigation](reranker-owner-investigation.md) records the
later reranker labs and their negative results. Ownership remains a
relevance-qualified goal, not a justification for the unsuccessful blanket
path partition. Wrapper removal and windowed ranking are not accepted repairs.

## Ownership policy and adopted implementation

**Make implementation ownership the primary ranking policy for default code
discovery, and let the reranker order candidates within that policy.**

Here, default discovery means a coding agent asking where a described behavior
lives, without already knowing its identifiers. The primary result should lead
the agent to the boundary that implements or authoritatively declares that
behavior. Tests, callers, examples and explanatory comments remain useful
evidence, but should not displace that boundary merely by describing it more
fluently.

The implemented engine retains LateOn as one ranking signal. Definitions
receive a separate query-matching metadata signal; tests and fixtures retain
their semantic evidence. Explicit test, documentation, configuration, reference
and constrained-path requests bypass the definition engine; they do not all
bypass LateOn. Default adoption is complete, with measured gains and known
regressions documented. Neither definition fusion nor this policy pins every
owner above every supporting result.

The qualification matters: ownership preference applies among relevant
candidates. An unrelated production function must not outrank a directly
relevant test just because its path looks more production-like. When the
question asks for a test, reference, configuration or explanation, that role
can be primary.

## Why a coding agent needs Satori

I can read files and search exact text without repository intelligence. If I
already know `tradeWorkflow` or a particular path, exact lookup and a direct
source read are usually enough.

The harder starting point is a user describing a behavior in words that the
implementation does not use: "stop identical rejected trade offers" or
"validate the next click after the board changes." Those words can occur in a
test, an audit script, a fixture, a caller and the implementation itself.

I need Satori to shorten the path from that description to a defensible next
action. For implementation discovery, that normally means:

1. Identify the likely behavior owner or a small set of cooperating owners.
2. Read the implementation and its contract.
3. Inspect the relevant caller or entry point to confirm reachability.
4. Find the nearest meaningful test to understand expected behavior.
5. Assess affected consumers if a change is actually requested.

Search is the entry point to this investigation. It does not itself prove the
root cause, authorize an edit, or establish complete impact coverage. A useful
top result makes the next source read productive; a misleading one sends the
agent into a subsystem that only talks about the behavior.

The goal is fewer wrong reads and fewer query rewrites, rather than a longer
list of semantically similar snippets.

## What I expect from each kind of question

| Agent question | Primary evidence | Useful secondary evidence |
|---|---|---|
| "Where is this behavior implemented?" | The function, method, module or authoritative declaration that performs it | One relevant caller, the contract and a focused test |
| "Why does this behavior happen?" | The decision or state transition responsible for it | Triggering caller, inputs, downstream consumer and regression evidence |
| "Where is this default chosen?" | Active configuration, initialization or selection logic | Call site and a test asserting the default; an enum listing choices is insufficient by itself |
| "Who calls or consumes this?" | References, callers and consumers of the identified target | The target definition and relationship-coverage limits |
| "What breaks if I change this?" | Affected consumers and contracts anchored to a known target | Relevant tests and unresolved dynamic or cross-language edges |
| "Which test covers this failure?" | A test whose assertions exercise the failure | The implementation and the fixture used to reach it |
| "How does this subsystem work?" | A bounded explanation grounded in its central implementation and contracts | Architecture documentation, important callers and examples |

These are different jobs. Default code discovery should not interpret every
mention of "calls" as a request for references, nor require the agent to add
"where is this implemented" to every descriptive phrase.

A configuration file can be the correct owner even without a function target.
A release script can own release behavior. An adapter can own protocol
translation. Generated bindings can be relevant consumers while a schema or
generator remains the authoring boundary. Path category alone does not settle
which of these is primary.

## Owner, execution path, impact and supporting evidence

The **behavior owner** is the boundary that controls the requested decision,
state or contract. It may differ from the file containing the best keyword
match.

The **execution path** connects that boundary to the triggering caller and
relevant consumer. It helps me check that I found the live implementation
rather than an unused helper or experimental alternative.

The **blast radius** is an impact question anchored to a target and a proposed
change. An initial prose search cannot establish it exhaustively. Search
ranking does not turn an observational reference into a proven call edge, and
missing results do not prove that no other consumers exist.

**Supporting evidence** helps establish intent or reproduce a condition. A
test may be the best source for a rejected-offer scenario while the workflow
owns the runtime transition. A fixture may explain hidden-card assumptions
while the tracker maintains them. This evidence should remain discoverable
without being mistaken for the place to change the behavior.

Some requests genuinely span owners. Click safety involves both legal action
generation and validation at execution time. Returning only the UI helper or
only the engine rules can leave half the question unanswered. Prefer a bounded
set of relevant owners over inventing one universal owner.

## Evidence motivating the proposal

The user supplied a September 26 versus October 3 comparison on
`colonist-assistant`. Read-only probes in the October 3 agent session captured
candidate-survival and phase diagnostics. The complete Q2–Q5 strings were
available; Q1 was abbreviated, so its original query was not replayed exactly.
These observations are session evidence, not newly committed evaluation
fixtures.

File-level ranks can select different candidates at different stages. In the
later captured-pool lab, the best tracker-path document improved from reranker
input position 62 to rank 8. The table below records the earlier probe and must
not be generalized into a claim that all tracker evidence was demoted.

| Query | Observed failure | Implication |
|---|---|---|
| `belief tracker hidden card probabilities` | A `tracker.ts` file/comment candidate reached fused rank 3, then reranking moved it to 9 and promoted `crop6309_fixture.rs` to 1 | Retrieval found relevant evidence, but final ranking preferred supporting material |
| `MaxN search default AlphaBeta defensive simulator` | `search_maxn` was dense rank 1, entered reranking, and finished at grouped rank 15 | Finding a relevant implementation does not guarantee it survives the final order |
| `trade workflow idempotent rejected bundle loop` | `tradeWorkflow` was dense rank 16 and remained outside the top five while tests became leading results | Both owner retrieval position and final role preference need attention |
| `click executor state signature legal target validation` | Neither expected owner entered the main candidate pool | Ordering alone cannot repair missing retrieval |

The first probe ran on a clean tree. Another actor edited `overlay.ts` and
tests during subsequent probes; those searches included dirty-source handling
and are not clean-tree replicas of the supplied report. Current source spans
also differ from several historical line references. Use published identities
and verified source rather than carrying old line numbers forward.

All four complete phrases resolved to `neutral` answer focus. Consequently,
existing implementation preference and path demotion did not apply. Fixture
classification recognizes fixture directories but did not recognize the
`crop6309_fixture.rs` basename. Runtime scope permits tests and scripts.

Adding an implementation cue to the trade query removed test-first results,
but `tradeWorkflow` still finished at rank 15. That is evidence against treating
a query rewrite or a broader intent cue as a sufficient repair.

Comment-only hits also explain some file targets. The retrieved tracker chunk
preceded the `seedPublicResourceWorlds` declaration and had a file owner; it
was not a verified function owner incorrectly downgraded during grouping.
Exact lookup of `buildSnapshot` succeeded, while its 1,068-line span exceeded
the separate symbol-supplement lane's 400-line limit. This limits one recovery
mechanism; it does not establish the cause of the unreplayed Q1 query.

Reranking took roughly 1.4–2.4 seconds in the diagnostic probes, compared with
71–392 ms for semantic retrieval. Exact-name lookups bypassed that work. These
are phase observations, not a controlled performance benchmark.

## Why reranking can help and still hurt here

The existing [retrieval investigation](retrieval-quality-investigation.md)
records historical owner@1 gains from reranking on another task set. That
supports retaining the model. It does not establish that its order should be
the final authority for every repository and question.

The leading explanation for the Colonist misses is that topical similarity
and behavioral ownership are different signals. A fixture or test can describe
the requested concept explicitly, while a short implementation relies on
types, callees or surrounding configuration. The observed ordering supports
this explanation; it does not isolate the model's internal mechanism.

Relevant inputs changed between the two reported dates: lexical retrieval,
index inventory, candidate admission, and the reranker document projection.
Commit `31d3be0a` widened admission and moved documents from v4 to v5 with source
references. No paired rollback identified a single regression-causing change.
The [repository vocabulary experiment](repository-vocabulary-experiment.md)
is off by default and is not the proposed remedy.

## Proposed ranking responsibility

Keep retrieval, ownership evidence and semantic relevance distinct:

1. **Retrieve relevant candidates.** Preserve enough alternatives to find the
   actual boundary. Owner preference cannot manufacture a missing candidate.
2. **Determine the requested evidence role.** Default behavior discovery seeks
   implementation ownership; explicit test, documentation, configuration and
   reference questions retain their own primary role.
3. **Establish what each candidate proves.** A source-contained symbol proves
   where a snippet belongs. Body evidence, contract evidence and relationships
   help establish whether that symbol owns the requested behavior. A path or
   graph-ready flag alone is insufficient.
4. **Apply role preference among relevant candidates.** Supporting artifacts
   should not replace a credible implementation owner solely through stronger
   prose similarity. If ownership evidence is insufficient, preserve that
   uncertainty rather than force a production-looking result into first place.
5. **Use the reranker within the eligible role.** It distinguishes relevant
   implementations or relevant tests without deciding that a supporting test
   is the implementation boundary.

The relevance and ownership eligibility rule remains an implementation design
question. This document does not invent a score threshold, a filename-wide
demotion rule, or a new response schema. A blanket sort of all production code
ahead of everything else would violate the proposal's relevance qualification.

Role preference must survive final grouping and disclosure. Applying it only
to one candidate slice is insufficient if unranked or supplemented results
can displace the selected primary evidence afterwards.

Use the existing canonical targets, source previews, navigation state and
recommended next actions to make the result inspectable. Never relabel a
comment chunk as a function merely to improve symbol-hit metrics. Tests and
secondary owners must remain reachable even when they are not the first
result.

## How this would be evaluated

Before adopting a change, compare current and proposed ranking on the same
publication, checkout, model and candidate evidence. Pin publication identity;
an operation-generation counter also advances for no-op syncs and is not a
publication identifier. Source edits invalidate a paired comparison.

Separate three questions in the evaluation:

- Was a valid owner retrieved at all?
- If retrieved, did ranking and disclosure preserve it in the primary results?
- Can the agent follow the result to verify the behavior, caller and contract?

Judge valid owner sets rather than one frozen function name. For defaults, the
active configuration owner can be a better answer than a wrapper function or
an assertion. For click safety, both rule generation and execution validation
can be required. Update line references from verified source.

Acceptance requires improved primary-owner ranks on the reproduced misses,
preserved explicit test/configuration/reference searches, and preserved cases
where reranking previously helped. Include a relevant test paired with an
irrelevant production function: the latter must not win on category alone.
Include a script-owned behavior and a configuration-owned default so that path
classification cannot become a substitute for ownership.

Track file-only fallbacks separately from verified symbol results. Report
candidate recall, owner ranks, supporting-evidence availability and latency
separately; a faster wrong answer or an artificially relabelled hit is not a
success. Q5's missing owners remain a retrieval limitation unless the evaluated
change actually brings them into the pool.

The [Q5 retrieval investigation](q5-retrieval-investigation.md) examines that
limitation separately. It also refines the relevance judgment: `validatedClick`
is a relevant execution guard, while `nextClickStillLegal` owns the delegated
board check and `legal_actions` owns phase legality in the engine. Focused
prose retrieves both missing owners; on the phase query, the reranker promotes
`legal_actions` from input rank 32 to first. Ownership policy and owner recovery
address different boundaries, and useful guard hits should not be labelled
noise merely because they differ from the original benchmark targets.

## Scope and current decision

The proposed improvement is one policy change: make relevant ownership govern
default discovery, with reranking operating inside that policy. It builds on
existing answer-focus, role, grouping and owner-resolution machinery; it does
not authorize implementation in this documentation task.

Code touchpoints for a future bounded design are
[`search-answer-focus.ts`](../../packages/mcp/src/core/search-answer-focus.ts),
[`search-ranking-policy.ts`](../../packages/mcp/src/core/search-ranking-policy.ts),
[`search-execution.ts`](../../packages/mcp/src/core/search-execution.ts),
[`search-owner-resolution.ts`](../../packages/mcp/src/core/search-owner-resolution.ts)
and [`search-group-results.ts`](../../packages/mcp/src/core/search-group-results.ts).
Their existing contracts should be used before adding new machinery.

Unexpected publication replacement is a separate investigation. The retained
content-identical publications do not identify their rebuild trigger, and
ranking policy should not compensate for availability or freshness failures.
