# Q5: recovering the owners behind click validation

Status: retrieval and ranking repair implemented as `definition_discovery` and
enabled by default on 2026-10-04. In a paired live run on one clean Colonist publication,
`nextClickStillLegal` and `legal_actions` move from absent in the visible ten
to ranks 4 and 8; `validatedClick` remains visible at rank 1. Both narrower
legality queries retain their owner at rank 1. See the
[engine results and limits](reranker-owner-investigation.md#definition-discovery-engine).

The later [four-repository reranker comparison](reranker-owner-investigation.md#four-repository-reranker-comparison)
used fresh Colonist questions rather than this Q5 wording or its focused
controls. It supports the combined default's top-rank gain, but does not
supersede the Q5 replay or guarantee owner visibility on other questions.
Its stage diagnostics matched file paths only; an exact owner's admission or
disclosure loss requires canonical symbol identity, not a same-file candidate.

The earlier symbol-metadata BM25 retrieval
experiment, behind the off-by-default `symbol_metadata_bm25` flag,
recovers both missing Q5 candidates but alone does not improve the disclosed
answers; callback-based recovery remains a proposal.
Recorded 2026-10-03. Complements
[implementation ownership in discovery](implementation-owner-ranking.md).

## Finding

In the baseline, for `click executor state signature legal target validation`, neither
`nextClickStillLegal` nor `legal_actions` reaches the reranker. Changing the
ordering policy cannot recover those missing candidates. Increasing the main
retrieval pool from 40 to its current maximum of 80 did not recover them either.

However, the results are not uniformly irrelevant. `validatedClick` is a real
execution guard and ranks first in the latest verified-publication replay.
Its validation callback delegates the board legality decision to the overlay.
The missing connection is between a relevant guard and the owners of the
checks behind it, with a separate rules layer for legal action generation.

Both named owners are discoverable through more specific natural-language
queries on the same Publication. The reranker then helps: it promotes
`legal_actions` from input rank 32 to result rank 1. This distinguishes a
retrieval failure for Q5's wording from a general inability to index or rank
those symbols.

## What an agent should expect for this question

The query bundles three responsibilities. Source inspection in
`colonist-assistant` identifies these boundaries:

| Responsibility | Owner in the inspected source | Evidence |
|---|---|---|
| Gate a click before dispatch | `src/content/action-guide.ts:1366`, `validatedClick` | Calls `options.validate`; on failure reports that the state signature or legal target set changed and returns before `element.click()` |
| Check the current signature and board target | `src/content/overlay.ts:2233`, callback wiring; `:2474`, `nextClickStillLegal` | The supplied callback compares `actionGuideSignature` with `nextSignature` and calls `nextClickStillLegal`; that method checks current board state, target IDs, turn and action conditions |
| Enumerate phase-legal engine actions | `engine/crates/catan-core/src/state.rs:688`, `legal_actions` | Branches on game phase and delegates to the relevant rule generators |

The overlay also supplies distinct continuation and commit callbacks. A
generic click helper alone does not explain all of that contract. Conversely,
`legal_actions` does not own the UI signature check. No direct call edge from
`validatedClick` to the Rust method was established by this investigation.

For an agent investigating execution safety, the useful first result can be
`validatedClick`, provided navigation leads to the supplied validator. For an
agent investigating rules legality, `legal_actions` is the primary owner.
Tests and audit scripts can support either investigation; they do not replace
the implementation boundary.

The original benchmark's two named targets remain useful recall checks. They
are insufficient as the entire relevance oracle: counting every action-guide
helper as noise would incorrectly reject the relevant execution guard. An
evaluation should distinguish immediate guard relevance, delegated-owner
recall and cross-layer completeness.

## Evidence and reproduction boundary

Satori source inspected at `5277eb492aa8f0f7722cfe4c99d42d9895e350a1`.
Colonist HEAD was `40a7c1261a2af2df901d8e85bcbd538306c66805`, with concurrent
uncommitted changes. No Colonist files were modified by this investigation.

Earlier probes against Publication
`0660631a-c4e0-4511-8704-b353a6449364` reported changed source. Dirty-source
suppression and replacement affected their final results, so their ranks are
not treated as a controlled comparison.

The table below uses the later Publication
`4ac2b48f-bb40-4c07-9ce7-dbc52d282895`, policy hash
`3529c6d76d082e00754b82db7a4ad0fbc38b402b7e4f6ee284f5f0e9127f45ed`.
Status checks before and after the controls returned that same Publication.
Natural-language replies reported source freshness verified through exact
source comparison, at approximately 13:39–13:41 UTC on 2026-10-03. This is a
freshness-verified snapshot of an edited tree, not a recreation of the user's
clean-tree weekly benchmark.

Searches used `scope=runtime`, `resultMode=grouped`, `groupBy=symbol`,
`debugMode=full`, `debugCandidateLimit=160`, and default ranking. The deeper
control used `limit=20`, `disclosureLimit=5`; other prose controls used
`limit=5`. One trial per control; no latency conclusion is drawn.

| Query or control | Observed result |
|---|---|
| Original Q5, main depth 40 | `validatedClick` dense rank 1 and final rank 1; neither named owner in the main pool or reranker input |
| Original Q5, diagnostic depth 160 | Neither named owner in dense or any-terms lexical diagnostic candidates; neighboring overlay chunks do appear, under other owners |
| Original Q5, main depth 80 | Neither named owner recovered; no reranker projection failures |
| `validate next click against current board legal targets` | `nextClickStillLegal` dense rank 1, reranker input rank 1 and final rank 1 |
| `legal action generation` | Neither named owner recovered in the inspected diagnostic arms; tests and scripts lead the results |
| `generate legal actions for the current game phase` | `legal_actions` dense rank 22, reranker input rank 32, final rank 1 |
| Exact identifiers: `legal_actions`, `nextClickStillLegal`, `validatedClick` | Each returns one correct symbol with graph navigation ready |

The two successful prose controls contain no exact symbol identifier. They
show that narrower responsibilities can bridge the vocabulary gap; they do
not establish an automatic query-rewriting algorithm.

## Where the candidates are lost

### Retrieval is bounded before reranking

[`search-policy.ts`](../../packages/mcp/src/core/search-policy.ts) derives
the main candidate budget from the retrieval result limit, with a minimum of
32 and multiplier of 8. The current cap is 80 in
[`search-constants.ts`](../../packages/mcp/src/core/search-constants.ts).
The observed limit-5 query gets 40; the limit-20 control gets 80.

[`semantic-search-service.ts`](../../packages/core/src/core/semantic-search-service.ts)
requests bounded dense and lexical arms, then
[`vector-candidate-fusion.ts`](../../packages/core/src/core/vector-candidate-fusion.ts)
deduplicates owners within each arm and fuses contributions with reciprocal
rank fusion. The fused product pool is cut to the main budget. Separate
depth-160 requests supply diagnostic evidence; their extra rows are not
automatically admitted to the product pool or reranker.

For original Q5, precise lexical retrieval uses `all_terms` and returns zero
rows. The query has seven terms: click, executor, state, signature, legal,
target and validation. The product's any-terms fallback runs and returns 40
rows, but neither named owner is present. Dense retrieval likewise does not
return them. This is not a case where a target appears in the raw arms and
is then demoted by owner deduplication or final ranking.

Absence through diagnostic depth 160 is a bounded observation, not proof of
absence from the entire index or a measurement of the owners' global ranks.
Exact lookup proves symbol publication; the successful prose controls also
prove semantic retrieval can return their owned chunks on this Publication.

### A full pool is mistaken for sufficient discovery

[`search-execution.ts`](../../packages/mcp/src/core/search-execution.ts)
contains a conditional expansion policy. On the neutral conceptual Q5 route,
five scoped primary candidates are sufficient to skip the expanded pass.
Original Q5 reports `primary_candidate_pool_sufficient` with 40 candidates;
the deeper control reports 80.

That gate counts distinct scoped spans, rather than demonstrated coverage of
the requested responsibilities. Many related executor snippets can satisfy
the count while the delegated validator and rules owner remain absent.

Opening this gate alone is not a proven repair. Without caller-supplied terms,
the existing expanded query appends `implementation runtime source entrypoint`.
That does not explicitly introduce the successful controls' board-target or
game-phase concepts. The repository vocabulary experiment is separately
documented and remains off by default.

### Current symbol recovery cannot follow the handoff

[`search-file-symbol-supplement.ts`](../../packages/mcp/src/core/search-file-symbol-supplement.ts)
recovers functions and methods inside already-retrieved files. It considers
up to three files in retrieval order plus three declaration-supported files,
at most six symbols per file, with matching source hashes, at least two query
term matches, and a maximum span of 400 lines.

The coordinator admits this lane only for implementation answer focus and
an eligible Publication in
[`search-request-coordinator.ts`](../../packages/mcp/src/core/search-request-coordinator.ts).
Q5's noun phrase gets neutral focus under
[`search-answer-focus.ts`](../../packages/mcp/src/core/search-answer-focus.ts).
Even when enabled, this file-local lane cannot discover an absent rules file
or follow a callback to another file.

`legal_actions` spans 55 lines and `nextClickStillLegal` spans 97 in the
inspected snapshot. Their absence is not explained by this lane's 400-line
span limit. That separate limit affected `buildSnapshot` in the earlier
investigation and should not be generalized to Q5.

## Why having BM25 in fusion did not recover these owners

The existing lexical arm and CBM's lexical search score different documents.
BM25 is a scoring formula; the document boundary, fields, query matching and
candidate budget determine which evidence that formula can supply.

CBM's local implementation builds its FTS index over symbol names, qualified
names, labels, paths and docstrings. It splits camel-case names, uses OR
matching for discovery, gives Function/Method nodes an additional ranking
bonus, and excludes file, folder, variable and project nodes from this search.
The body field here is a docstring, not the complete source body. These are
verified in `src/store/store.c` and `src/mcp/mcp.c` in the local
`codebase-memory-mcp` checkout. It is therefore more than an untuned BM25
baseline.

Satori's existing
[`search-projections.ts`](../../packages/core/src/core/search-projections.ts)
combines source bodies, metadata and identifier components into chunk lexical
text. Its LanceDB FTS arm does use BM25. For Q5, the initial all-terms query
returns no rows; the product OR fallback runs, but neither canonical owner
enters its bounded chunk pool. Fusion cannot contribute a symbol that none of
its arms supplies. Identifier splitting already existed; its absence was not
the cause.

A fresh CBM replay of the exact Q5 wording returned `legal_actions` first and
`nextClickStillLegal` third. A file-constrained replay also found
`validatedClick`; it should not be described as absent from CBM's lexical
index merely because it was not in the unconstrained top results. The CBM
checkout and the pinned clean Satori evaluation are different source
witnesses, so this is explanatory evidence rather than a paired benchmark.

The implemented experiment introduces a separate
[`symbol-metadata BM25 arm`](../../packages/mcp/src/core/search-symbol-metadata-bm25.ts)
over published non-file symbol names, qualified names and paths, without
source bodies. It splits identifiers, uses conventional BM25, and supplies
at most twelve candidates to the existing fusion and reranker. It does not
copy CBM's node-type bonuses or apply an implementation-path preference.
The existing chunk and Potion arms remain available for evidence such as
`validatedClick` that this smaller metadata budget may not select.

The metadata corpus is cached by registry object and manifest hash. Existing
scope/operator filters apply before selection. Selected files are read once
per request; full source hashes must agree with the symbol and manifest, and
the excerpts retain truthful line and byte bounds. This uses the existing
256 KiB source-read limit. The flag stays off for explicit test, documentation,
reference and configuration routes, path-constrained requests, and searches
served from a previous publication. It adds no persistent index, schema,
dependency or model change.

### Paired result of the metadata experiment

The corrected implementation was evaluated on clean Colonist commit
`40a7c1261a2af2df901d8e85bcbd538306c66805`, Publication
`fb96d5ed-1b50-4c09-945c-fbd7b38323c8`. Flag off and on used that same
publication and compiled runtime, with three alternating repeats per arm.
Search used runtime scope, symbol grouping, limit 20, default disclosure of
ten results, and full candidate-survival diagnostics. Exact-name controls
resolved canonical owner IDs from this same publication before the prose
queries ran. Both the disclosed results and stage ranks agreed across repeats.

| Q5 evidence | Baseline reranker input | New metadata arm rank | Enabled reranker input | Enabled grouped rank | Disclosed top ten |
|---|---|---|---|---|---|
| `nextClickStillLegal` | Absent | 3 | 8 | 34 | Absent |
| `legal_actions` | Absent | 8 | 17 | 55 | Absent |
| `validatedClick` | 1 | Outside the twelve-candidate arm | 5 | 2 | 2, unchanged |

The new arm therefore repairs candidate admission for the two legality owners.
The reranker still pushes them below disclosure. Their canonical identity is
preserved in grouping; final absence is a visible-limit outcome, not another
retrieval miss. An initial run exposed a missing-byte-bounds defect in the new
excerpts; it was corrected and this table uses the subsequent full rerun.

The other documented queries provide no reason to enable the flag by default:
`tracker.ts` moves from grouped rank 8 to 9, `search_maxn` remains 13, and
`tradeWorkflow` moves from 34 to 36. Explicit test, caller, configuration and
path-constrained controls are identical off/on, four of four. This remains one
repository and four discovery queries, not a general quality verdict or a
latency benchmark.

Run `node evals/real-repo-quality/symbol-metadata-bm25-ablation.mjs` after
`pnpm -C packages/mcp build:runtime` to reproduce the comparison. The harness
requires the clean pinned checkout under `~/.cache/satori-eval-repos`, verifies
publication and runtime stability, records owner traces, and deletes its owned
temporary index after a successful run. Its result artifact is
`/tmp/satori-symbol-metadata-bm25.json`.

Keep the flag off. The experiment demonstrates why symbol-focused lexical
evidence can recover candidates that chunk BM25 misses. It also demonstrates
that retrieval recovery alone does not establish useful default discovery:
ranking the recovered ownership evidence remains unresolved.

## Interpretation and bounded improvement direction

The original baseline failure is responsibility coverage before reranking.
The metadata-on experiment also demonstrates a separate ordering failure:
both recovered legality owners enter the reranker but finish below disclosure.
Q5's broad wording strongly retrieves the generic execution guard, while the
legality owners become retrievable when the question names their particular
responsibilities. Chunk-local context and query vocabulary are the leading
explanation; this investigation does not isolate an embedding-model defect
or establish which historical change caused the weekly regression.

The complementary retrieval proposal is **one bounded owner-recovery pass
before reranking, anchored to relevant retrieved implementation evidence**.
For this case, source-proven validation callback wiring can lead from the
click guard to `nextClickStillLegal`. A separate phase-legality retrieval
hypothesis can cover the engine responsibility when that is part of the
question. Published semantic relationships may guide recovery where they
exist; source evidence must establish callback handoffs when graph coverage
does not. A mention must not be promoted into a claimed call edge.

Keep the original intent and candidate provenance, impose a small recovery
budget, and then apply the proposed ownership policy and reranker. Do not
hardcode these Colonist identifiers or assume every UI query needs a Rust
rules result. The need for another owner should come from the requested
behavior and the observed delegation boundary.

This callback-based direction is supported by the successful controls, but
automatic callback recovery remains unimplemented and unevaluated. The metadata
experiment above already supplies both Q5 owners without following a callback;
it leaves their ranking unresolved. Simply increasing all
candidate pools, forcing generic expansion, or disabling reranking is not
supported as the repair by these results.

## Conditions for accepting a repair

Evaluate on one recorded Publication and source witness. Measure separately:

1. Whether relevant guards and delegated owners enter the candidate pool,
   including where admission happens.
2. Whether the ranking policy preserves valid ownership and the reranker
   improves order once those candidates exist.
3. Whether callback navigation supplies evidence without inventing semantic
   edges or claiming complete impact coverage.
4. Additional retrieval and reranking latency, plus regressions on explicit
   test, reference and configuration questions.

Retain original Q5 and the narrower controls. Also include other callback
delegations and broad queries so that success cannot depend on memorizing
these two symbols. A guard-only answer can be relevant but incomplete; an
unrelated production symbol cannot pass solely on path category.

The original investigation changed only documentation and used live search
diagnostics, exact-identifier controls and source inspection. The later metadata
experiment also changed source and added focused regression checks. Its checks
pass for scoring, filtering, cache isolation, cancellation, source validation,
UTF8/CRLF excerpt byte bounds, fusion wiring, canonical ownership and default-off
behavior. Lint and the runtime build/typecheck pass. Removing the cache's
manifest-hash witness in a disposable mutation copy causes the regression test
to fail as expected; the unchanged implementation passes. The paired real-repo
comparison above verifies candidate recovery and records the remaining ranking
limitation.

The [consolidated reranker investigation](reranker-owner-investigation.md)
records the subsequent fixed-pool experiments. Removing the query wrapper,
changing the document projection and blending ranks caused regressions. A
budgeted window policy recovered only one additional strict owner in twenty-four
development cases, at slot 16; it did not recover `legal_actions` or the trade
owner. That mechanism is not being implemented. Generalizing verified symbol
admission and preserving admitted owners through ranking remain unvalidated
work, and both experimental flags remain off.
