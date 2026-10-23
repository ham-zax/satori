# S1: ownership evidence through retrieval and reranking

Status: normalization, declaration-evidence, and graph-label replays complete.
None establishes a sufficient repair. No product repair is selected or implemented.
The measured selection and fusion losses replace the earlier graph-first ordering.

## Wrap-up and resume point

The user closes this investigation on 23 October 2026. S1 remains open.
The earlier S2 and harness repairs are committed in `6ecf531a`. The
task does not install a runtime, publish a release, or update the managed index.
The existing product-test results belong to those earlier repair slices.
This documentation closeout does not claim a new product-test run.

The evidence is complete for three bounded experiments:

- [Normalization](s1-normalization-experiment-2026-10-23.md) improves internal
  ranks but does not admit the handler or reach fusion rank ten.
- [Declaration priority](s1-declaration-evidence-experiment-2026-10-23.md) admits
  S1 with trial normalization but removes the React state-update control owner.
- [Graph labels](s1-graph-evidence-experiment-2026-10-23.md) improve provider
  rank from 58 to 52 while fusion stays at 16. The parent reproduces exact scores.

Both experiment workers are closed. Task scratch is removed. Scripts, frozen
inputs, successful results, checksums, reproduction commands, failed-attempt
explanations, and the parent check remain linked from the reports. Earlier
repairs remain intact. No further S1 implementation starts in this closeout.

### User experience target

The user asks whether the problem can become unobtrusive. The working reading
is that ordinary callers must not need identifier guesses, alternate terms,
or repeated manual navigation to find the requested owner. The original query
must work through the existing search interface. Optional `alt_terms` remains
useful caller input, but cannot substitute for this acceptance requirement.

One candidate direction uses the already-retrieved tool declaration and proven
calls to recover the requested handler internally, then carries that evidence
into final owner selection. This is an untested direction, not an implemented
or proven repair. Existing local graph evidence makes it testable without
adding an external service. Additional request cost remains unmeasured.

Internal mechanics need not burden callers. Unsupported or ambiguous evidence
must still remain distinguishable from an authoritative owner result. Hiding
freshness warnings, increasing limits silently, or always substituting a nearby
helper would not repair the demonstrated failure.

### Next deciding experiment, not yet executed

Test call-backed admission and ownership-aware fusion separately, then together.
Use the real resolved entrypoint-to-handler path. Freeze the seed rule,
admitted relations, ordering, and existing budgets before measurement.
Do not assume a retrieved declaration automatically represents its callable child.

Acceptance requires the original query without alternate terms to return the
actual handler in its first ten grouped symbol results. Preserve the React
state-update owner and explicit helper, test, reference, and path intent.
The existing external file probes alone cannot establish full-search preservation.
Reject a rule that succeeds only on the known S1 example or displaces controls.
Only a sufficient comparison justifies a production change and broader gates.

Latest completed experiment: the real call path after S2 passes the artifact roundtrip.
All 692 selected TypeScript files parse completely. Both required edges retain
exact instance identities, resolved claims, and `direct_binding` authority after
production sidecar write/read. The parent independently checks those bytes.
This is not a sealed vector publication or a managed reindex. The completed
ranking comparison holds admission fixed and changes only structural context.
Its expanded registry also extracts three non-TypeScript files required by
the frozen window, for 695 files and 15,071 symbols in total.

The entrypoint has 35 source call sites, 27 admitted calls, and 19 distinct
resolved targets. Its serialized three-callee context includes `handleSearchCode`
as the third entry. The earlier prediction that lexical truncation necessarily
removes that handler is false for the measured graph. The handler's context
contains its actual caller and callee. The
[graph experiment](s1-graph-evidence-experiment-2026-10-23.md) measures provider
rank 58 with empty context, 52 with handler-only context, and 53 with context
on all candidates. Unmodified fusion keeps the target at rank 16 in every arm.
The empty-context repeat reproduces exact scores and ordering. Labels help
learned similarity, but do not resolve the measured fusion loss. Automatic
graph admission and final grouped acceptance remain untested.

## Outcome and scope

The original query must return `handleSearchCode` in its first ten grouped
symbol results, without caller-supplied identifiers. Rank one is the secondary
target. Keep the existing oracle in `evals/code-intelligence-vs/tasks.json`.
Queries for envelopes, tests, references, configuration, and constrained paths
must still return the requested kind of answer.

Use systematic debugging, scientific-method thinking, and plan writing.
The two observed losses require separate checks. A retrieval improvement alone
does not establish a repair.

## Baseline and evidence

Checkout: `5188f61226bee31556a55bd3cf9b56dad1b3631f`, with the earlier staged
S2 and harness repairs. Preserve those edits. The live managed runtime is
`0.10.3`. Its measured publication is
`330c18e2-af44-4491-a85a-6af3d468c5ae`, with 48,308 chunks.

Original query:

```text
search_codebase grouped result handler freshness warnings next actions
```

Requests use `scope: runtime`, `resultMode: grouped`, `groupBy: symbol`, and
`limit: 10`. The following measurements use the live publication:

| Observation | Result | Meaning |
|---|---|---|
| Target payload | Indexed method at lines 2036–2038 | The index contains the handler |
| Original dense query | Target rank 997 across the full index | The 80-candidate arm misses it |
| Default expanded dense query | Target rank 2,456 across the full index | Generic expansion does not recover it |
| Original fallback lexical query | Target rank 2,053 across the full index | Lexical retrieval also misses it |
| Local and live query vectors | Both SHA-256 hashes match for both passes | The local dense probe reproduces the live embedder |
| Query `search code handler` | Exact target first in dense and final grouped results | Search can return the target without symbol-name guesses |
| Original query plus alternate phrase `search code handler` | Target sixth before reranking | A controlled intervention recovers admission |
| Same intervention, provider order | Target rank 58 of 64 | Admission alone fails |
| Same intervention, definition fusion | Target grouped rank 15 | Existing fusion does not repair final disclosure |
| Replace `handler` with `envelope` | Envelope builders still lead | Current ordering does not distinguish these requested roles sufficiently |
| Split `search_codebase` into words | Target still absent from the first ten | Identifier splitting alone is insufficient |

The rank probes sort all returned LanceDB rows explicitly. Their ranks include
all indexed paths, before MCP runtime filtering. Live traces establish the
actual admission failure. Neither rank is a runtime-only rank.

The target body only delegates to `searchRequestCoordinator.attempt`.
`buildSearchProjections` indexes local identity and body text. Helpers contain
the requested grouped-results and freshness vocabulary.

The original query already retrieves the `searchCodebaseTool` declaration.
That candidate enters the reranker at rank 12. The provider places it tenth,
definition fusion places it 39th, and final grouping places it 35th.
Therefore a public-tool anchor exists before final ranking loses it.

## Causal status and competing explanations

The confirmed mechanisms are loss before admission and loss after reranking.
Their upstream relationship is not closed. Treat the diagnosis as
deepest-confirmed-root-unknown, rather than two proven independent roots.

The first hypothesis is inconsistent lexical normalization at existing search
boundaries. Metadata tokenization splits identifiers but does not normalize
`handler`, `handlers`, and `handle`. File-symbol supplementation removes some
suffixes but leaves `handler` and `handle` different. These observations do
not prove that normalization will admit the target or improve final ranking.

Supplementation matches source and symbol-name terms. It does not score the
qualified name. It selects three retrieved files plus a bounded declaration
lane, then at most six symbols per selected file. Check each gate separately.
A method passing the term threshold can still miss file or symbol selection.

Falsifiers: the target remains below metadata rank twelve, supplementation
still excludes it, or frozen-window fusion still places it below ten.
Report each result separately. Do not treat an internal rank as grouped rank.

The next alternatives are structural evidence and model/query representation.
Earlier work in `owner-ranking-handoff.md` measures several projection and
fusion changes without a general gain. Those results limit confidence in
another prompt or score adjustment. They do not prove graph evidence works.

S2 may remove useful caller evidence. Current rerank documents already accept
resolved caller and callee labels. However, S2 alone does not add a candidate
retrieval arm. Do not claim that its repair also fixes S1.

## First experiment: normalization only

Completed. The [experiment report](s1-normalization-experiment-2026-10-23.md)
records exact baseline reproduction and the limitations. Runtime metadata
rank changes from 1,792 to 715 with plural aliases and 663 with role aliases.
Neither reaches the twelve-symbol limit. Role normalization reads `handlers.ts`
and passes the target's two-term threshold. The eligible target ranks 17th
among 37 symbols before the six-symbol cut, which selects six other symbols.
The already-admitted target's fusion rank changes from 16 to 13.
Do not ship these variants as a sufficient repair.

Use `evals/code-intelligence-vs/s1-normalization-experiment.mjs` with the frozen
capture in its `fixtures/` directory. The script reads the existing publication
without changing it. Load the actual ranking and supplementation functions.
Alter only their tokenization in disposable experiment copies.

Compare baseline, plural-only additive terms, and plural-plus-role additive
terms. Preserve original metadata tokens. Namespace additional aliases so
the report can distinguish them. Trial suffix rules are not an established
English stemmer. Do not add S1-specific exceptions or tune after seeing ranks.

1. Rank the real registry with the production BM25 formula and tie order.
   Record target rank, matching terms, top twelve, and the exact corpus filter.
   Distinguish all-symbol and package-source measurements from production ranks.
2. Run file-symbol supplementation on captured baseline `mcp_fusion`, before
   the supplement executes. `mcp_filtered` already includes its output.
   Record selected files, source reads, hash acceptance, symbol selection,
   and target admission. Keep file, symbol, and source-size limits unchanged.
3. Replay definition fusion on the frozen admitted-control window, preserving
   provider ranks, input positions, caller terms, and metadata resolution.
   Reproduce the captured baseline order before reporting variant results.
   If reproduction fails, stop this arm and report the mismatch.
4. Replay the original window too. Tokenization during fusion cannot admit
   a target that the window does not contain.
5. Report negative controls and collisions, including `user/use`, `server/serve`,
   `buffer/buff`, and plural forms. An exact token plus its alias must not
   count as two independent concepts for supplementation's two-term threshold.

The replay measures metadata, supplementation, and fusion. It does not run
LateOn, change dense/lexical retrieval, apply full grouping, or establish
end-to-end acceptance. Preserve those limits in every report.

The capture contains persisted chunks and source-derived candidates. Query
Lance only for persisted chunk IDs. Reconstruct source-derived candidates
from captured spans and exact published owner identities. Do not discard them
or treat them as missing vector data. Source-hash checks remain authoritative.

## Later experiments, only when the first results require them

The [declaration-evidence experiment](s1-declaration-evidence-experiment-2026-10-23.md)
is complete. Under trial role normalization, name priority moves S1 from
17th to fourth among 37 eligible symbols and admits it. The shipped tokenizer
still excludes it under both orders. The intervention removes an accepted
React state-update owner from supplementation under both tokenizers.
Reject name priority as an unconditional replacement. Keep the six-symbol cap.

The frozen experiment compares shipped ordering (total matches, then name
matches) against name matches, then total matches, with the same source-line
tie order. Total matches combine declaration-name terms and all source-span
terms, including declarations and comments. They are not independent body-only
evidence. Cross both orders with the prior baseline and trial role tokenizers.
Keep eligibility, selected-file policy, and all budgets unchanged.

Controls use the unchanged React `r1`–`r5`, `r8`, and `r9` questions and
acceptable owners from `evals/real-repo-quality/cases.json`. A second source
cohort uses FlatBuffers `ts/builder.ts`: table completion (`endObject`), buffer
finalization (`finish`), and UTF8 string encoding (`createString`). Those queries
and owners are fixed in the experiment fixture before results. They are new
source controls, not additions to the established evaluation oracle.

External probes deliberately supply known implementation files, then use the
production parser and source checks. Report this oracle-assisted file selection.
These probes measure supplementation, not retrieval or end-to-end quality.
Production Flow recovery may supply valid declarations. Record recovery status
and check intact target spans against source. Mark missing or incomplete targets
unscorable. Preserve actual source identities and every original acceptable owner.

DeepSeek runs the experiment through Claive. MiniMax reviews it when available.
The user permits one retry after failure, then a Codex fallback. Workers use
their default tools without added step or time caps. The parent checks artifacts.
MiniMax returns HTTP 400 twice. The authorized Codex reviewer checks the
implementation, and the parent independently reproduces the final results.

The next investigation needs ownership evidence that distinguishes a requested
delegating handler from helpers without displacing body-relevant implementations.
Do not tune another global score or cap on the eleven diagnostic cases.
Before testing graph admission, check the S2 call path in a task-owned index
and identify which observed loss that evidence can repair. Preserve separate
admission and post-rerank falsifiers. A source-only gain is not final acceptance.

The subsequent review identifies another admission hypothesis: implementation
lanes spend bounded slots on supporting files. In the captured shipped metadata
top twelve, every symbol belongs to one of two test files. Supplementation uses
two of its first three retrieved-file slots on a test and the evaluation JSON.
Its separate declaration lane remains relevant, so three is not its total
file budget. A category-gating replay must measure both lanes and metadata
separately, retaining explicit test, documentation, configuration, and path intent.
Do not equate `runtime` scope with a contract that excludes tests.

A parent read-only check applies the production path classifier to distinct
files in the frozen baseline `mcp_fusion` order. After excluding supporting
categories and configuration paths, the first three files are
`search-exact-registry-hit.ts`, `tools/search_codebase.ts`, and
`search-result-finalization.ts`. `handlers.ts` remains eleventh. Category gating
alone therefore does not recover it through the initial three-file lane.
This check does not replay the declaration lane, metadata retrieval, or fusion.

Removing tests is not yet a sufficient repair. The diagnostic package-source
filter still places the role-normalized target 355th. Container-name terms also
apply to every method in a class. That is valid context but weak role evidence.
Trial exact terms and stem aliases can separately count in fusion coverage.
Isolate container evidence from alias counting before proposing a fusion change.
The graph comparison uses none of these interventions. Its negative result
does not select category gating, container-term removal, or reserved slots.

Test variable definitions and explicitly named adapters separately. The
current definition-kind set excludes variables. Current adapter preference
checks generic integration terms rather than the named file identifier.
Those facts do not establish that changing either fixes the handler result.

Graph admission remains a candidate if existing lanes cannot recover the owner.
First check the published path after S2 in a task-owned index. Use resolved
call targets and published parent identity. Parent containment is not call proof.
`PreparedSearchRerankStructuralRelationships` already keeps all admitted edges.
The three-callee limit belongs to serialized document context, not that index.
Do not apply lexicographic display truncation before candidate relevance checks.

Measure fan-out and utility-call admission before selecting any graph rule.
One matching query term does not prove that a callee is the requested owner.
Do not adopt a two-to-four-candidate cap, a half-weight neighborhood vote, or
a bridge bonus without a deciding comparison. Existing budgets still apply.

Structural labels may affect LateOn even without exact behavioral words.
Definition fusion does not consume those labels directly, but changed provider
ranks can change its output. Neither success nor failure follows by inspection.

## Decision rules and alternatives

| Candidate | Decision now | Deciding check |
|---|---|---|
| Larger candidate or response limits | Reject as the primary repair | Target lies beyond small increases and still loses after admission |
| Hard-coded synonyms or `handleSearchCode` boost | Reject | Cannot explain another repository or a helper-focused query |
| Enable repository vocabulary | Do not select | Current publication lacks its optional artifact and earlier broad results regressed |
| Enable the existing owner floor | Do not select | Its guarantee applies to the first candidate, whereas this target enters sixth |
| Change the reranker or add a remote model | Outside this plan | Adds cost or dependencies without proving a local repair |
| Normalize identifier spelling only | Reject as sufficient | The live split-spelling control still fails |
| Metadata and supplement normalization | Tested; insufficient | Runtime rank 663, target not supplemented, admitted-control fusion rank 13 |
| Declaration priority in supplementation | Tested; reject unconditional replacement | Role-plus-name priority admits S1 but removes an accepted React state-update owner under both tokenizers |
| Variable definitions and named adapters | Separate experiments | Must explain their own measured losses without promoting unrelated declarations |
| Resolved ownership evidence | Real path proven; serialized labels insufficient | Fan-out is 19 targets and labels improve provider rank without changing fusion rank 16. Automatic admission and graph-aware fusion remain untested. |
| Role-focused query or projection | Separate ranking hypothesis | Must work on other owners and preserve behavior-focused questions |

Do not combine unproven graph expansion, query rewriting, and fusion weights.
If two interventions are necessary, measure each alone and together.
Stop after two failed interventions on the same mechanism and re-establish
the causal path.

## Conditional implementation boundary

Decision: no product change until the experiment selects a sufficient repair.
Documentation or caller guidance alone cannot satisfy the original request.
TDD mode is off. Add focused regression checks without a mandatory RED/GREEN
sequence. Preserve the existing test oracle.

If an experiment succeeds, MCP search owns candidate admission and final
ordering. Core relationship publication remains the authority for any call proof.
Keep `Context` as the composition root. Use a pure, bounded search helper if
the existing coordinator cannot accommodate the experiment's proven policy.

Before implementation, specify the exact seed rule, admitted relation,
deterministic order, and budget within the existing candidate limit.
Parent containment is not call proof. Low-confidence, unresolved, stale,
wrong-publication, or cross-scope evidence must never become asserted ownership.
Do not add persistent state, a new dependency, an unbounded graph walk, or a
second relationship resolver.

Existing boundaries to read and change only when the experiment requires it:

- `search-query-planning.ts` owns query intent, not target-specific synonyms.
- `search-execution.ts` coordinates candidate discovery and its current budget.
- `search-definition-discovery.ts` owns the current definition vote.
- `search-rerank-structural-context.ts` supplies admitted structural evidence.
- `search-rerank-projection.ts` and `search-rerank-document.ts` own model input.
- `search-rerank-request-contract.ts` owns the pinned request contract.
- `packages/core/src/symbols/contracts.ts` defines published parent identities.
- `packages/core/src/core/search-projections.ts` owns indexed search text.

The MCP filenames above are relative to `packages/mcp/src/core/`.
Do not change indexed projection text unless the experiment proves that
boundary necessary. Such a change requires its projection-version and
reindex consequences in a revised plan.

Populating existing fields does not itself change their semantics. If the
experiment requires new query or document semantics, update the version,
contract fixtures, asset, routing, and first-party consumers together.
Do not silently reuse the old projection identity.

## Verification and stop conditions

Keep the original query as an acceptance regression. It already informed this
diagnosis, so it is not held-out evidence. Reserve cases from another
repository before choosing a rule. Evaluate those cases without tuning.
Include another delegating handler, a direct implementation, an unrelated
same-name method, a helper-only question, and explicit test/reference/path
requests. Include missing, ambiguous, and wrong-generation relationship cases.

Use the current real-repository harness and scorer for the existing 72-query
set. Report strict symbol rank separately from correct-file rank. Compare
matched builds and publications. Do not tune a parameter on the evaluation
cases. Reject a sample-only gain or a reproducible aggregate regression.

Run focused tests for the changed boundary first. Existing relevant files are
`search-query-planning.test.ts`, `search-definition-discovery.test.ts`,
`search-rerank-structural-context.test.ts`, and
`search-native-rerank.integration.test.ts`. Run a file with the MCP package's
`test:raw` command, replacing its glob with that file path.
If query or document semantics change, run
`pnpm --filter @satori-code/mcp contract:check`.
Run `pnpm run check` and the search suites required by the final changed scope.
Run heavy checks serially.

Measure request cost on the same input over at least three runs. Report median
latency, peak process memory, machine load, graph work, and provider calls.
The repair must retain bounded work and require no new provider call.

Completion requires the original top-ten outcome, representative controls,
unchanged user work, and no required work running. Then document the selected
mechanism and remaining limits in the existing runtime-findings report.
No production repair, commit, merge, runtime replacement, or publication
is authorized by this documentation-and-experiment task.

## Baseline references

- `wild-runtime-findings-2026-10-23.md`: S2 changes and contract provenance.
- `owner-ranking-handoff.md`: prior experiments and the current code map.
- `owner-recall-design-checkpoint.md`: admission and budget experiments.
- `agent-alt-terms-definition-discovery.md`: caller terms and negative controls.
- `evals/real-repo-quality/README.md`: reproducible evaluation commands.
