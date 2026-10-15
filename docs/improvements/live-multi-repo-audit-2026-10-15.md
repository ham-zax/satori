# Live Satori audit, 15 October 2026

Current repair status: F02, F03, F05, F09, F10, and F13 have checked repairs in the checkout. F05 returns the complete guard for the audited request. F04 ranking quality and F11 latency remain open. Earlier observations and checkpoints remain chronological below.

Integration requirement: keep the generated request contract, runtime profile, and acquisition manifest synchronized. The runtime profile pins the request-contract digest. The acquisition manifest pins the SHA-256 digest of the exact runtime-profile bytes. A profile edit also requires an acquisition-manifest update.

Evidence storage: the generated evidence directory is local only and Git ignores it. References below name local artifacts. A clone does not contain them.

## Scope and running record

The user requests reindexing, live tests across repositories under `/home/hamza/repo`, and a report that grows during the investigation. Product fixes are proposals only. No commits or configuration changes are authorized.

Plan: observe the existing Satori and Colonist Assistant rebuilds, index two additional repositories sequentially, then test search relevance, source read recommendations, outlines, relationships, references, continuation, and error recovery. Compare selected answers with current source. Keep raw MCP responses beside this report. Do not treat a small query sample as a quality benchmark.

Initial state: Satori MCP responds as version 0.9.2. `list_codebases` lists two roots requiring reindexing. A subsequent status request starts a supervised rebuild for each root. Initial report state: in progress.

## Findings

### F01: Status requests can start expensive rebuilds

- Observation: `manage_index(status)` starts automatic `reindex` operations for both tracked incompatible roots. Operation IDs: `f1f65838-8600-4852-8b1b-3f29a4065c60` and `9d8703dc-dc5c-42dc-b29c-8afaf2d669ae`.
- Impact: a caller that treats status as read-only can start two indexing jobs by checking readiness in parallel. The host shares memory with other applications.
- Classification: documented behavior and agent friction. No resource failure demonstrated.
- Proposal: expose rebuild intent before mutation, or provide a passive status option. Tell agents that status can start work and that cross-root status calls need resource awareness.
- Evidence: initial-status-0.json and initial-status-1.json.

## Checkpoint

Next: wait for active rebuilds, select two additional roots, and run bounded live checks. Append all later observations without deleting earlier findings. Add corrections when later evidence changes a conclusion.

## Append 1: first rebuild and search checks

- Colonist Assistant rebuilt successfully in 30.4 seconds according to operation timestamps. Status reports 403 files and 12,781 chunks.
- Satori's first rebuild failed at 90% with `Source observation changed while the candidate Publication was being prepared`. The audit wrote report files inside that root during the rebuild. Those writes may have contributed, but the exact changed path is not disclosed. Evidence now goes outside the indexed roots during indexing.
- Explicit Satori retry accepted operation `4415debb-32f3-4d1d-b204-a533c8cd898d`. The tool returned a generic `REINDEX_PREFLIGHT_UNKNOWN` warning without an explanation beyond low confidence.
- Colonist stale-result query took 12,542 ms. Rank 1 was `executeBoardAction`, which posts a board action and contains no stale-result guard. Ranks 2 and 3 were a related options interface and rendering code. The final three results included an unrelated player state signature and two Rust search routines. This query does not establish a benchmark failure. It demonstrates that the first recommended read does not answer the stated guard question.
- The recommended symbol read worked and matched current source. Search continuation returned the remaining three items with the same ranking digest.
- Potential friction: the final continuation says `disclosure.truncated=false` while 37 groups remain beyond the caller's frozen limit. Top-level counts disclose the omission. Agents must inspect both fields.
- Potential friction: several just-rebuilt results show `indexedAt=null` and `stalenessBucket=unknown`, while status reports verified current-source parity. These fields measure different evidence and need clear interpretation.

Next: finish the Satori retry, then index Claive and JevShelf sequentially. Continue source-backed navigation checks.

## Append 2: navigation and capability checks

- TypeScript callers returned three direct-binding edges for `executeBoardAction`. The retry caller at line 1352 matches direct source inspection.
- Rust outline returned real function and type symbols with graph handles. Capabilities report Rust graph support as degraded, with reason `relationship_provider_degraded:satori-cbm-semantic-rust`. Do not confuse the 136 unsupported files with Rust: Rust has 76 indexed files and 74 definition-bearing files. Many unsupported files are searchable text or data.
- A search scoped to `src/worker` preserved that boundary in all five returned paths. Root resolution correctly returned the parent repository. The question may place the stale-response guard in the wrong component, so this sample cannot establish a ranking defect.
- Agent improvement: test the location premise before adding a narrow subtree. A correct scope filter cannot find an owner outside that scope.
- Evidence: colonist-callers.json, colonist-rust-outline.json, colonist-capabilities.json, and colonist-search-worker.json.

## Append 3: recovery of the guard owner

- The source-backed guard query returned `decision-worker.ts` at ranks 1–3. Rank 1 is `reset`, which increments the generation. The rejection itself appears later in the response handler. File discovery succeeded, but the recommended symbol does not contain the entire requested mechanism.
- The query changed both wording and alternative terms. Do not attribute the improvement to `alt_terms` alone.
- Reference search and one-edge path tracing succeeded for the TypeScript action sender. Exact result evidence remains in colonist-references.json and colonist-trace.json.
- Claive and JevShelf contain pre-existing user changes. Index their current working trees. Do not alter, stage, or revert those changes.

## Append 4: bounded context can omit the decisive guard

- Reproduction: open the returned `DecisionWorkerClient` symbol with implementation context and query `reject stale worker responses`. The response selects excerpts at lines 63–69, 235–239, 250–254, 255–259, and 402–408.
- The actual rejection checks generation, desired key, and response ID at lines 311–316. The selected excerpts omit that guard. This is a demonstrated context-selection miss for this request, not a claim that every context request fails.
- Source remains recoverable through explicit line reads. The response reports bounded mode and incomplete source honestly.
- Search reports the class target span as 63–102. Exact symbol read and outline report 63–428 for the same symbol ID. Potential contract friction: an agent may interpret target.span as the full declaration. Separate the canonical symbol span from the matched excerpt span, or document the distinction.
- Rust graph returns direct-binding call sites and explicit partial inbound-coverage warnings. A low graph edge limit correctly emits a traversal-limit warning. Do not treat a degraded graph as complete impact evidence.
- Manifest read succeeds for Colonist Assistant package.json. Do not generalize older manifest exclusion findings to this runtime without a current reproduction.
- Architecture overview succeeds for `src/content` with bounded output.

## Append 5: input and scope recovery checks

- Relative search paths fail with a clear absolute-path instruction.
- Invalid continuation syntax fails with the exact handle format requirement.
- Missing files return an explicit not-found message.
- A call-graph target outside the requested subtree returns no nodes or edges and explains the scope mismatch. Minor friction: its machine-readable reason is `missing_symbol`, although the symbol exists outside scope.
- Source inspection locates the rebuild refusal in `packages/core/src/sync/synchronizer.ts`. Multiple observation checks share the same error string. The message does not identify the changed path or observation stage, so the user cannot distinguish an active editor from an audit artifact or ignore-policy change.
- Proposal: include a bounded changed-path list and the failing observation stage. Preserve the refusal to publish a candidate built from changed inputs.

## Append 6: rebuild recovery

- Satori retry completed successfully in 110.7 seconds according to operation timestamps. The successful run used a 3,269 MB budget. The first failed run used 5,538 MB. Different source and concurrency conditions prevent a speed comparison.
- Keeping new evidence outside the indexed repository allowed this retry to complete. That supports the artifact-churn hypothesis but does not identify the exact path behind the first refusal.
- JevShelf initial indexing started after the Satori worker completed. New roots use ordinary `create`, with no force or custom ignore changes.
- Continuation replay returned the same result objects and ranking digest. A syntactically valid unknown handle returned an actionable instruction to repeat the search.

## Append 7: Satori owner discovery

- Source-observation search ranks the interface method `assertSourceObservationCurrent(): Promise<void>` first. The recommended implementation-context read returns only that declaration. The actual mismatch checks appear in Synchronizer implementation around lines 324, 333, and 389. This is a demonstrated declaration-over-implementation miss for the sampled query.
- Search for continuation handle storage and expiry ranks `evals/agent-disclosure/disclosure-pilot.mjs` first. The helper parses a continuation response. It does not store handles or enforce expiry. Remaining top-five results include a coordinator constructor, symbol-context continuation validation, hint freezing, and result-set attachment.
- Proposal: judge implementation questions against behavior owners, not only related names. Add these exact queries to a small regression oracle before changing ranking.
- JevShelf indexing completed in 4.5 seconds. Claive indexing starts next, without overlapping another index worker from this audit.

## Append 8: Python repository results

- JevShelf digest-continuation query returns `_load` at rank 1. Its recommended source read includes the expected-digest guard and matches current source.
- JevShelf excerpt-selection query returns `skill_excerpt` at rank 1. The original question says byte budget, while source documentation and configuration use a character budget. Correct the oracle wording to character budget. This query cannot prove byte accounting.
- Python callers and exact-symbol analysis respond successfully. The caller check uses the published symbol from search.
- `detect_changes` responds successfully against the existing JevShelf working-tree changes. It does not require an artificial product edit.
- Claive becomes searchable, then reports a pending background sync. Its create operation is replaced by the current sync operation in status, which limits historical duration recovery from that endpoint.

## Append 9: Claive checks and repeated search timing

- Claive timeout search returns `parse_turn_timeout` at rank 1. The recommended source includes rejection of nonpositive, NaN, and infinite values. Direct source matches.
- Claive inbox query returns `check_consumer` at rank 1 and `read_new` at rank 3. `read_new` owns the cursor and lock, then calls `_read_from`. The name validator alone does not implement message consumption.
- Claive source reads and architecture overview succeed. Its pending sync completes. Source freshness returns to verified.
- Three repeats of the original Colonist query take 3,025 ms, 2,438 ms, and 2,440 ms. Median: 2,440 ms. All three preserve the same first three targets. These are request timings in one live session with other applications active. They are not cold-start or isolated performance benchmarks.
- The first observed request took 12,542 ms. Model startup, concurrent indexing, and cache state were not isolated. Treat that delay as observed friction, not an attributed regression.
- The corrected character-budget question still returns `skill_excerpt` at rank 1.

## Results and limits

The bounded live audit covers four repositories and all 11 exposed MCP tools. It reindexes the two tracked roots and creates indexes for JevShelf and Claive. The first Satori rebuild fails. One explicit retry succeeds. No product fixes or commits form part of this audit.

The evidence checker records 35 checks: 26 operational checks pass. Nine selected quality checks record three owner/context successes and six misses. These checks include adversarial examples discovered during the audit. They are not an unbiased repository-quality score. A quality miss does not imply an MCP transport failure.

| Repository | Lifecycle result | Search and navigation result |
|---|---|---|
| Satori | Reindex retry completes in 110.7 s | Broad queries recommend a declaration and an evaluation helper. A path-scoped cache query recovers the actual cache methods. Docs scope returns relevant README files. |
| Colonist Assistant | Reindex completes in 30.4 s | Broad stale-result search misses the client. Grounded search finds its file. Bounded class context omits the decisive guard. TypeScript and Rust navigation work with disclosed limits. |
| JevShelf | Initial create completes in 4.5 s | Digest and excerpt questions find their owners first. Python navigation, exact analysis, and change detection work. Change detection reports partial coverage. |
| Claive | Initial create succeeds, then automatic sync completes | Timeout owner ranks first. Inbox reader ranks third. Source reads and architecture overview work. |

Operation durations use server timestamps. Request latency uses client wall time. Claive's status replaces the create operation with a later sync operation, so this report does not infer its create duration.

## Prioritized findings and proposals

| ID | Priority and classification | Evidence and impact | Proposed action |
|---|---|---|---|
| F01 | Medium, documented lifecycle friction | Status starts rebuilds. Parallel readiness checks start two index workers. No memory failure occurs. | Offer passive status, or make the mutation explicit in agent guidance. |
| F02 | Medium, observed recovery friction | Satori rejects changed source at 90%. The error omits changed paths and observation stage. Audit writes may contribute. | Keep evidence outside active index roots. Report a bounded path delta and the failing stage. |
| F03 | Low, warning clarity | Explicit retry returns `REINDEX_PREFLIGHT_UNKNOWN` with low confidence and no diagnostic reason. | Explain the unknown condition and its operational consequence. |
| F04 | High for agent usefulness, observed ranking misses | Observation search recommends an interface declaration. Handle search recommends an evaluation helper. Inbox search recommends a name validator. | Add source-backed owner cases before tuning ranking. Distinguish behavior owners from declarations, consumers, and validators. |
| F05 | High for agent usefulness, observed context miss | Class context omits the actual stale-response guard at lines 311–316. An explicit line read succeeds. | Evaluate context selection against decisive guards. Preserve the current bounded-source disclosure. |
| F06 | Medium, metadata contract ambiguity | Search class span is 63–102. Outline and exact read give 63–428 for the same symbol ID. | Separate canonical symbol span from matched evidence span, or document their different meanings. |
| F07 | Low, freshness interpretation | Fresh nodes can show `indexedAt=null` and `stalenessBucket=unknown`. Graph also reports `sourceState=fresh`. | Explain index age separately from current-source parity in one compact field description. |
| F08 | Low, truncation interpretation | Final continuation has `disclosure.truncated=false`, while 37 groups remain outside the caller limit. Other fields disclose that count. | Make page completion and total-result omission explicit. |
| F09 | Medium, readiness wording | Claive says fully indexed and ready while `SOURCE_FRESHNESS_UNVERIFIED` and a pending sync also appear. The old Publication remains readable by design. | Make the human summary distinguish readable index from verified source parity. |
| F10 | Low, recovery code precision | Graph refuses an out-of-scope target with reason `missing_symbol`. Its message correctly explains the boundary. | Use a distinct scope-mismatch reason so agents do not retry symbol discovery. |
| F11 | Medium, observed latency friction | First search takes 12.542 s. Three same-query repeats have a 2.440 s median. Causes are not isolated. | Separate initialization from request-stage timing before a performance change. |
| F12 | Medium, disclosed coverage limitation | Rust graph reports degraded provider coverage and partial inbound analysis. Python claims also show unresolved constructs. | Preserve warnings in agent summaries. Use exact references and direct source for important impact decisions. |
| F13 | Low, recommendation wording | A docs result without a symbol receives the explanation that the symbol is large. | Tailor recommendation reasons to file results and symbol results. |

## Agent practices supported by this run

1. Keep report and raw evidence writes outside a repository during full indexing. Copy completed artifacts after the worker finishes.
2. Check readiness serially when a status call can start indexing.
3. Test a question's component premise before restricting search to a subtree.
4. Read the recommendation, then ask whether its source contains the requested mechanism. A related name alone is insufficient.
5. If bounded source omits the decisive branch, use the outline and explicit line reads. Preserve the missing-context finding.
6. Distinguish finding the correct file from finding the correct function or method.
7. Use source-backed alternative terms. A changed question and changed terms cannot isolate the benefit of either.
8. Read freshness, omission counts, and graph warnings before making completeness claims.
9. Use `rg --files` before guessing filenames. Two source lookups in this audit guessed nonexistent filenames and cost an extra call.
10. Keep ordinary code edits outside a testing-and-reporting request. Treat proposed repairs as proposals.

## Brief retrospective

- Audit artifacts may have invalidated the first Satori candidate. Proposed fix: place the active evidence directory outside every index root.
- Several early responses consumed unnecessary context. Proposed fix: save full responses and display only status, targets, timings, and warning summaries.
- Initial checker execution missed files saved before the evidence directory moved. Proposed fix: select one evidence directory before the first request.
- Some source commands stopped after a missing path or printed errors from guessed filenames. Proposed fix: locate paths first and keep independent reads independent.
- No silent product failure or memory exhaustion is demonstrated. The source-change refusal preserves publication consistency. The report requests better diagnosis, not removal of that guard.

## Reproduce and continue

Raw request arguments, responses, timestamps, and durations remain local in `live-multi-repo-audit-2026-10-15-evidence/`. `evidence-checks.json` records check outcomes, repository HEAD values, dirty states, and hashes for the sampled source files. `check-evidence.mjs` reruns evidence checks against current source. Later source changes can invalidate those comparisons. The command below requires these local artifacts.

```bash
node docs/improvements/live-multi-repo-audit-2026-10-15-evidence/check-evidence.mjs
```

The checker exits nonzero for failed operational checks. It records selected quality misses without hiding them behind that exit status. Read `qualityFindings` in its output and the `quality` checks in its JSON.

All observations apply to installed MCP version 0.9.2 and these working trees. This audit does not test paid or remote providers, crash recovery, Windows, model changes, complete language coverage, large-scale quality, or all source mutations. It does not alter product code, skills, or user configuration. Index lifecycle calls can maintain their own index state and background syncs.

The audit ends after the artifact checks and a final readiness check. Append future findings below, with request evidence and a source comparison. Do not overwrite earlier observations. Add a correction when later evidence changes a conclusion.

## Verification update, 15 October 2026

The user requests a check of the findings and repair proposals. This update records that check. Earlier observations remain historical evidence. The corrections below govern their current interpretation. No product repair is approved or implemented.

Method: systematic-debugging, root-cause tracing, the root-cause claim contract, and the Map Territory critical-thinking skill. These methods separate observed failures, demonstrated mechanisms, and unresolved causes. Design guidance keeps proposed behavior changes separate from approved implementation.

### Checks and corrections

- The existing evidence checker runs again with its output-file write intercepted in memory. All 26 operational checks pass. The same six quality checks fail. The saved JSON remains unchanged.
- Seven of eight sampled source hashes match the saved record. `claive/bin/claivelib/cli.py` changed. Its returned timeout excerpt still matches current source. The earlier whole-file hash no longer describes that file.
- The checker evaluates saved responses against current source. This check does not repeat live searches, lifecycle operations, or latency measurements.
- The span-equality check treats intentional behavior as a miss. Five checks demonstrate relevance or context misses. The sixth records an expected span difference. Preserve the original nine-check result as historical data.
- The existing large-declaration test passes. Its contract keeps the exact symbol ID but uses matched evidence as the search target span. Exact symbol reads retain the declaration span.

Focused test, run from `packages/mcp`, exits 0 with one passing test:

```bash
pnpm exec node --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-name-pattern='large declaration search targets matched evidence' src/core/search-group-results.ownership.test.ts
```

| Finding | Checked conclusion | Cause status |
|---|---|---|
| F01 | Status can start rebuilds through shared readiness preparation. Automatic admission coalesces requests per root. Different roots can rebuild concurrently. | Documented lifecycle policy, not a demonstrated resource failure. |
| F02 | Three source-observation checks use the same error text without changed paths or the observation stage. | Diagnostic gap confirmed. The exact trigger for the first failed rebuild remains unknown. Audit writes remain a hypothesis. |
| F03 | Preflight returns `unknown` for several conditions, including no working-tree changes and changes outside its ignore-only case. | Warning detail is insufficient. `unknown` does not itself indicate a failed probe or an unsafe rebuild. |
| F04 | Saved recommendations select declarations, consumers, or validators instead of the requested mechanisms. | Sample failures confirmed. Retrieval, candidate admission, reranking, and fusion remain unseparated causes for these queries. |
| F05 | The current selector reproduces the exact missing guard. Explicit evidence returns the guard within the same budget. | Selection mechanism confirmed. The general repair still needs evidence beyond this sample. |
| F06 | Search uses the matched span for a large owner. Exact reads and outlines use its declaration span. | Intentional behavior covered by an existing test. Contract clarity remains a proposal. Span inequality alone is not a defect. |
| F07 | Missing timestamps produce an unknown age bucket. Source parity uses separate evidence. | Interpretation issue. The observation does not prove stale source. |
| F08 | Continuation disclosure describes the current page. Separate fields disclose groups outside the frozen caller limit. | Interpretation issue. The observation does not prove hidden results or broken pagination. |
| F09 | The short message says ready. Full human text already explains unverified parity and pending sync. | Short-summary wording issue. Readability of the completed Publication remains intentional. |
| F10 | An out-of-scope symbol returns `missing_symbol` with a correct explanatory message. | Machine-readable reason is imprecise. Scope enforcement works. |
| F11 | Saved timings support 12.542 seconds initially and a 2.440-second repeat median. | Delay confirmed as an observation. Startup, indexing, cache, and request-stage costs remain unseparated. |
| F12 | Responses disclose degraded or partial relationship coverage. | Supported capability limitation. No complete-impact claim is justified. |
| F13 | The recommendation branch can describe a file result as a large symbol. | Wording defect confirmed in the recommendation owner. |

### F05 mechanism and bounded counterfactual

Owner path: `symbol-context-composer.ts:904` calls `selectBoundedSource`. The call supplies source, symbol span, budgets, capabilities, and query. It supplies neither evidence spans nor structural anchors. `inspectable-source.ts:75` declares syntax and control-flow anchors unavailable for this source path.

The selector tokenizes the query and ranks matching lines in `bounded-source-selector.ts:261`. Its candidate order includes the declaration, lexical matches, and a terminal window. The excerpt limit can exclude the decisive branch even when the response has unused byte and line capacity.

The replay uses current `DecisionWorkerClient` source at lines 63–428 and query `reject stale worker responses`. Budgets are 12,288 source bytes, 200 source lines, five excerpts, 8,192 bytes per excerpt, and 24,576 serialized source bytes. The query context setting is two lines.

| Replay | Selected line ranges | Guard at 311–316 | Returned source bytes |
|---|---|---|---|
| Original selector inputs | 63–69, 235–239, 250–254, 255–259, 402–408 | Omitted | 1,335 |
| Same inputs plus evidence span 311–316 | 63–69, 235–239, 250–254, 309–317, 402–408 | Returned | 1,390 |

The intervention disproves an unavoidable byte-budget explanation for this sample. The added span is diagnostic input from direct source inspection. It is not an implemented discovery strategy. More query terms also fail to recover the full guard in a sampled replay. Do not prescribe keyword exceptions or a larger budget as an established repair.

### Repair proposals and deciding checks

These proposals identify the smallest next action and the evidence needed before implementation. They do not authorize product changes, new parameters, new reason codes, or dependencies.

| Findings | Responsible owner and proposal | Deciding check and stopping condition |
|---|---|---|
| F04 | Use the existing [owner-discovery investigation](owner-recall-design-checkpoint.md). Add these exact questions and source-backed mechanism expectations. Capture the expected owner at retrieval, admission, rerank, fusion, and final selection. Change only the stage that loses or demotes the owner. | Distinguish absence from misordering for each query. Stop diagnosis when one demonstrated stage explains the failure. Evaluate a proposed change against neighboring queries before recommending it. |
| F05 | Use `symbol-context-composer.ts`, `inspectable-source.ts`, and `bounded-source-selector.ts`. Compare validated evidence spans, structural anchors, and candidate diversity. Prefer existing authoritative evidence where available. | First establish a current-source evidence producer. Test unrelated lexical matches, an internal rejection guard, and a different terminal branch. Preserve byte limits, deterministic order, freshness checks, and honest incompleteness. No repair is selected yet. |
| F02 | Improve diagnostics at `Synchronizer` source-observation checks. Identify the observation stage and report a bounded, deterministic path delta when the available evidence supports one. | Deterministically change an observed file before each check. The candidate must still fail publication. Output must identify the stage and cap path disclosure. |
| F03 | Keep preflight ownership in `working-tree-state.ts`. Distinguish its existing unknown conditions and explain what the warning means. | Cover unchanged trees, ordinary source changes, ignore-only changes, missing Publication, and failed Git probes. Preserve their current admission outcomes. |
| F09, F13 | Adjust wording in `manage-maintenance-handlers.ts` and `search-response-helpers.ts`. Describe readable Publication state separately from parity. Describe file and symbol recommendations accurately. | Check ready plus unverified, ready plus verified, partial publication, file results, and symbol results. Preserve navigation arguments and admission behavior. |
| F06–F08 | Clarify the existing contracts for target spans, timestamp age, source parity, page completion, and caller-limit omissions. Reclassify the audit's span-equality expectation. | Existing responses remain valid. The audit distinguishes expected span differences from relevance failures. Do not make all spans equal or fabricate timestamps. |
| F10 | Assess a distinct scope-mismatch reason in `navigation-handlers.ts`. First check the public reason union and first-party consumers. | A caller can distinguish an absent symbol from an out-of-scope symbol. Both responses retain empty graph output and the current boundary. A reason-code change needs contract approval. |
| F01 | First make the existing status mutation explicit in agent guidance. Consider passive status only as a separate behavior decision. | Guidance describes automatic maintenance and per-root concurrency. A passive mode needs a reviewed contract and proof that it starts no maintenance. |
| F11 | Continue the existing [latency investigation](mcp-request-latency-findings.md). Separate initialization from steady-state request stages before proposing optimization. | Use the same input, at least three runs per condition, and record medians, peak memory, machine load, and command. Stop when measured stage costs identify the worthwhile owner. |
| F12 | Preserve coverage warnings and require direct source evidence for important impact decisions. Broader language coverage is a separate outcome. | Agent summaries retain limitations. No provider expansion follows from this audit alone. |

Recommended order: correct the audit expectation, establish F04 stage evidence, and establish F05 evidence production. Wording and diagnostic proposals can follow as separately approved changes. Preserve source-change publication refusal, exact symbol identity, caller limits, and coverage warnings throughout.

Current decision: `docs/config-only` for this record update, with no configuration change. Product proposals remain unapproved. Ranking roots, the first rebuild trigger, the general context-selection repair, and latency attribution remain open.

## First repair batch, 15 October 2026

The user's later request, `start fixing systematically`, authorizes this batch of recorded repair proposals. This section supersedes the earlier approval state for the repairs below. The original audit remains a historical read-only run. This batch changes product code in the checkout. It does not commit, install, or deploy those changes.

### Implemented repairs

| Findings | Result and owner | Evidence |
|---|---|---|
| F02 | `FileSynchronizer` error details identify captured-hash validation, captured-file-set validation, or final observation. Details report up to ten sorted relative paths and an omission count. Final-observation errors also report partial scans and bounded unscanned prefixes. | Three new failure-path tests fail before the repair and pass after it. They check modified and added files, bounded final deltas, and unchanged checkpoint state after refusal. |
| F03 | `working-tree-state.ts` explains each uncertain preflight condition. `tool-response-builders.ts` appends that explanation to human text. Existing admission outcomes and the machine-readable preflight shape remain unchanged. | Focused tests cover unchanged trees, ordinary changes, ignore-only changes, no current index, failed probes, and response projection. |
| F09 | The short status message describes a complete readable index and states source parity separately. Partial-index wording remains unchanged. | The status test covers verified, unverified, changed, snapshot, and partial states. It also checks that unverified parity retains the pending-sync receipt and warning. |
| F10 | The call-graph response now uses `symbol_outside_scope` for a target outside the requested subtree. The public reason union and reference documentation include it. | The new handler test first fails on `missing_symbol`, then passes. The response retains empty graph output and releases its lease. |
| F13 | The recommendation owner says `Open the matched source evidence before requesting more context.` The wording applies to both file and symbol evidence. | The new file-result case checks the wording and preserves line-read arguments. All 20 helper tests pass. |
| F06 audit expectation | The evidence checker now checks canonical symbol identity and containment of the matched span within the declaration. It classifies that check as an operational contract check. | The checker records 27 passing operational checks and five misses among eight quality checks. The original saved JSON remains unchanged. |
| F01, F06–F08 | README guidance explicitly warns that status can start maintenance. The reference explains matched spans, index age, source parity, and page-local disclosure. | The documented fields match their existing owners. No passive-status mode, timestamp fabrication, span unification, or pagination change is added. |

Change necessity: code changes repair observed wording, diagnostics, and reason precision at their existing owners. Documentation explains intentional behavior. No new state owner, dependency, persistence component, or fallback is added. Source-observation refusal, exact symbol identity, and graph scope enforcement remain in force. The three generic mismatch throws now delegate to one diagnostic formatter in the synchronizer.

### Focused checks

All commands below exit 0. Each command runs from its stated directory. Earlier passing results are reused while their inputs remain unchanged.

| Directory | Command | Result |
|---|---|---|
| `packages/mcp` | `pnpm exec node --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs src/core/search-response-helpers.test.ts` | 20 tests pass. |
| `packages/mcp` | `pnpm exec node --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/core/manage-maintenance-handlers.test.ts src/core/working-tree-state.test.ts src/core/tool-response-builders.test.ts` | 24 tests pass. |
| `packages/mcp` | `pnpm exec node --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/tools/call_graph.test.ts src/core/search-types.test.ts` | 21 tests pass. |
| `packages/core` | `pnpm exec node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/sync/synchronizer-observation.test.ts src/sync/synchronizer-ignore.test.ts` | Four tests pass. |
| `packages/core` | `pnpm exec node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/sync/sync-scan.test.ts src/generation/index-generation-workflow.test.ts` | 18 tests pass. |
| Repository root | `node --test --test-concurrency=1 --test-reporter=./scripts/satori-test-reporter.mjs tests/integration/synchronizer.integration.test.mjs` | Ten integration tests pass against the compiled Core output. |
| Repository root | `pnpm run check` | Lint, all package typechecks, version references, and package scopes pass before the F10 edit. Lint reports warnings in unchanged files. |
| `packages/mcp` | `pnpm exec eslint src/core/navigation-handlers.ts src/core/search-types.ts src/tools/call_graph.test.ts` followed by `pnpm run typecheck` | Changed-file lint and typecheck pass after F10. |

The test files above record 97 passing tests. The evidence checker also passes with its JSON write intercepted in memory. It evaluates saved responses, not the repaired runtime. This batch does not rerun an installed runtime after deployment.

### F04: admission hypothesis disproved for one current query

The read-only Claive worker identifies an instrumentation gap: `applyRerankOrder` records `reranker_output` after definition fusion and implementation preference. The existing trace does not expose raw provider order separately.

One live search repeats the observation question with `debugMode=full` and `debugCandidateLimit=160`. Its local-only trace, `live-multi-repo-audit-2026-10-15-evidence/repair-observation-stage-trace.json`, includes the exact expected owner from a published outline: `FileSynchronizer.prepareChanges`, symbol ID `syminst_bff8402bd83c47615d85035677609763`.

| Stage | Expected owner's best rank |
|---|---|
| Primary fallback lexical retrieval | 18 |
| Primary Core fusion | 25 |
| MCP fusion | 32 |
| Reranker input | 28 |
| Combined reranker/fusion output | 18 |
| Grouped results | 16 |
| Disclosed caller-limited set | Absent from five results |

These stages report no omitted occurrences. The owner reaches reranker input, which disproves the admission-loss hypothesis for this current query. Ordering remains the demonstrated problem. The trace cannot attribute that ordering to the provider or definition fusion.

This run follows source edits and automatic synchronization. Its source freshness reports `changed`. It is not a controlled replay of the original audit Publication. Do not attribute the changed recommendations to a ranking repair. No ranking algorithm changes in this batch.

Next action: capture raw provider order before policy fusion on the same candidate input. That distinction is necessary before selecting a ranking repair. Stop when evidence identifies which stage demotes the expected owner.

### F05: existing producer experiment

The second read-only worker inventories current-source evidence producers. `createLanguageAnalysisService().analyze` uses Oxc for TypeScript. Its current result exposes declarations and calls, without branch spans. `composeSource` passes neither evidence spans nor structural anchors to selection.

A scratch check reads the 14,304-byte `decision-worker.ts` through `prepareInspectableSource`, then analyzes those inspected bytes. Structural analysis reports `complete`. The spans overlapping guard lines 311–316 are:

- Class `DecisionWorkerClient`: 63–428.
- Method `pump`: 189–341.
- Call `then`: 273–325.
- Call `finally`: 273–340.

Final observation reports `available` and `current_at_final_observation`. The scratch check releases its descriptor. Existing declaration and call spans do not isolate the guard in this sample. Wiring those spans alone is not a demonstrated repair. A branch-evidence producer and its selection policy still need a design and deciding experiment. No context-selection change is implemented.

### Remaining limits and brief retrospective

- F04 and F05 remain open. F11 still needs separate initialization and request-stage measurements. F12 remains a disclosed coverage limit.
- A diagnostic projection printed too many candidate objects and truncated the result. Proposed practice: save the full trace first and print exact owner IDs with ranks and omission counts.
- Several guessed paths caused failed reads. Proposed practice: locate files before reading them and bound each source window.
- The combined reranker trace hides the provider/fusion distinction. Proposed code improvement: add a bounded provider-order diagnostic at the validated-result boundary. This remains a proposal.
- No skill, CI rule, configuration, or additional product change follows from the retrospective.

Current state: first repair batch checked, broader audit repair incomplete. The next investigation has a bounded hypothesis and stopping condition. Existing user work and original raw evidence remain present.

## Parallel investigation, Luna and Haiku

The user requests Luna and Haiku at max effort, parallel starts, peer communication, and parent steering. Both configured engines accept these settings.

| Worker | Engine and model | Initial responsibility | Managed terminal |
|---|---|---|---|
| `23a7796e3427` | Codex, `gpt-6-luna`, `max` | F04: separate provider order from policy fusion on identical candidate input. | `90517` |
| `31b07cadbc44` | Claude, `claude-haiku-5-5`, `max` | F05: test syntax-derived guard evidence and selection priority independently. | `27687` |

Both workers initially report `running`. Both enable live steering and acknowledge the parent's peer instructions. Channel `satori-remaining-20261015` permits messages between them. The parent owns channel management, synthesis, design decisions, and any later product edits.

These turns permit scratch experiments in separate temporary directories. Product code, configuration, tests, and repository documentation remain outside worker write ownership. Heavy model runs require parent scheduling. Parent-controlled conversations can exchange findings after the initial turns.

The existing F04 trace also contains F11 timing evidence: client elapsed time is 9,848 ms. Read preparation takes 3,356 ms, including a 3,328 ms completion proof. The rerank phase takes 3,673 ms, while the provider reports 2,096 ms. Semantic search takes 908 ms. These nested measurements must not be summed as independent costs. One changed-source request cannot establish a steady-state median or a performance repair.

### Parent checkpoint: F04 diagnostics implemented

The user directs the parent to implement a repair once sufficient evidence exists, while workers continue. The parent adds two bounded candidate-survival stages in `applyRerankOrder`:

- `reranker_provider_output`: validated provider order before policy changes.
- `reranker_fusion_output`: order after definition fusion or optional rank blending, before implementation preference.

The existing `reranker_output` remains the order after implementation preference. The new stages retain provider scores in copied diagnostic candidates. They do not overwrite ranking state. This repairs the demonstrated attribution gap. It does not repair or explain the actual query's ranking yet.

The new integration test first fails on the missing provider stage, then on the missing fusion stage. After implementation, all 65 tests in `search-native-rerank.integration.test.ts`, `search-candidate-survival.test.ts`, and `search-execution.golden.test.ts` pass. Changed-file lint and MCP typecheck also pass.

Ten golden scenarios initially reject the added stages. A targeted snapshot update adds only diagnostic records. An independent comparison checks all 33 prior snapshots after removing only the two newly introduced stage names from the comparison input. Every pre-existing value remains identical. The tests retain their complete snapshot assertions and ranking expectations.

Luna's scratch experiment uses the real validator and `applyRerankOrder` with synthetic provider results. It shows a provider-rank-four owner at rank one after fusion on identical candidate input. This supports the diagnostic boundary, rather than a ranking-policy change. The original live trace still lacks these new stages.

Luna encounters two non-blocking shell errors: a mistaken skill alias in a filesystem path and an unavailable `python` command. It continues with Node. The parent reports both errors to the user. A parent snapshot-comparison command also uses the wrong working directory once. The corrected absolute-path comparison passes.

Both workers send a peer message through the open channel. Haiku remains active at this checkpoint. Parent steering narrows its reading and identifies a scratch-oracle defect: interval overlap does not prove complete guard coverage. The parent requests full condition-and-branch coverage and correct UTF-16-to-UTF-8 span handling before trusting the experiment. No F05 product change is accepted from that draft.

### Haiku timeout and parent F05 experiment

Haiku's first turn times out after 900 seconds with exit 143 and no final report. One context handoff occurs. Two parent steering waits also expire during the turn. The parent reports these errors to the user. Claive later reports a reasoning-heavy call with 44,508 output tokens. The requested max effort remains unchanged.

The parent preserves the worker's script and runs an isolated corrected copy. The copy changes the oracle from interval overlap to full guard containment. It maps Oxc UTF-16 positions through the source string rather than treating them as UTF-8 offsets. The original file contains non-ASCII text at line 110.

| Real-file counterfactual | Complete guard 311–317 returned |
|---|---|
| Original selector | No |
| Source-derived guard evidence, current order | No |
| Source-derived branch anchors, current order | No |
| Earlier anchor placement without a producer | No |
| Producer and earlier placement without query ranking | No |
| Producer and query ranking without earlier placement | No |
| Producer, earlier placement, and query ranking | Yes, within excerpt 309–317 |
| Source-derived evidence spans with query ranking | Yes, within excerpt 309–317 |

The five-excerpt budget and existing byte limits stay fixed. Two small neighboring synthetic cases already return their guards on the baseline and continue to do so. All three fixtures match the original selector when the scratch policy is unchanged. These neighboring cases do not establish broad quality or semantic-binding coverage.

The prototype searches backward for a declaration used by an early-exit condition. That search remains a heuristic, without compiler binding proof. The experiment proves a useful selection counterfactual for the sample. It does not authorize publishing inferred bindings as facts or bypassing final source observation. The parent requests a short Haiku recovery report before the joint review, since Claive refuses conversations involving an unresolved failed turn.

### Parent checkpoint: instrumented real query

The parent starts a temporary direct MCP session from the compiled checkout. The session uses the existing offline provider settings and existing index. It does not replace the installed runtime. The search completes in 11,060 ms. Its source freshness remains `changed`, so its ranks do not reproduce the original audit Publication.

The local-only response, `live-multi-repo-audit-2026-10-15-evidence/repair-observation-provider-trace.json`, records the same expected symbol and candidate `chunk_e80d84aa8fd960ac` through each ranking stage:

| Stage | Candidate rank | Omitted occurrences |
|---|---|---|
| Reranker input | 33 | 0 |
| Validated provider output | 10 | 0 |
| Definition fusion output | 19 | 0 |
| Implementation preference output | 18 | 0 |
| MCP ranked candidates | 20 | 0 |
| Grouped owners | 16 | 0 |
| Disclosed owners | Absent from five | 0 |

The new stages expose a real fusion demotion in this sample. Provider order also misses the top five. Disabling fusion alone therefore does not establish a complete repair. This observation justifies a controlled ranking experiment, rather than a guessed ranking rule. No ranking policy changes form part of this checkpoint.

Haiku completes its report-only recovery with exit 0. Joint conversation `3b2783cd375d` then completes with exit 0 and one reply from each model. Haiku responds to Luna's critique. Both challenge the source-selection prototype. A late parent steering message initially reports `unconfirmed` because the turn ends before provider acknowledgement. Haiku's final response nevertheless includes the new ranks. The response establishes consumption of those facts, rather than the steering receipt alone.

The local-only archive, `live-multi-repo-audit-2026-10-15-evidence/repair-parallel-experiments.json`, retains the checked prototypes and rejected worker drafts with content hashes. Parent assessment corrects two review uncertainties. The new input rank is 33, rather than the older trace's 28. The response records `orderAuthority=definition_fusion_order`, and the implementation excludes optional blending when definition fusion applies. The 10-to-19 change therefore belongs to definition fusion for this sample.

Haiku proposes a concrete unexecuted counterexample for the scratch producer: an arrow parameter named `stale` can cause the identifier-name search to include an unrelated outer declaration. The parent retains that concern as a required discriminating fixture, rather than claiming a demonstrated production failure. Both workers' latest analysis turns receive parent acceptance. The parent closes the peer channel and both workers. Both managed launcher sessions exit 0.

The F05 production boundary remains unresolved. Matching source hashes currently avoid structural re-parsing in the composer. A new producer must preserve that ownership and cost boundary, bind spans to the inspected bytes, and retain the final source-observation check. The scratch declaration lookup must not become a public semantic-binding claim.

Checkpoint status: F02, F03, F09, F10, and F13 have checked repairs. F04 has checked diagnostics and a newly attributed sample, while ranking quality remains open. F05 has a useful counterfactual, without an accepted production repair. F11 remains an unattributed latency observation. No commit, installed-runtime change, or ranking-policy change occurs. `git diff --check` passes. The next bounded F05 check must distinguish nested declarations and edited source before product integration.

## F05 repair: exact guard context and final source checks

The user directs work to proceed. The repair addresses the demonstrated omission of the stale-response guard from bounded implementation context. It does not change F04 ranking policy or the installed MCP runtime.

### Baseline and ownership

The starting checkout contains the earlier repairs and user documentation. The parent preserves that work. The baseline read set covers `symbol-context-composer.ts`, `bounded-source-selector.ts`, `inspectable-source.ts`, `current-source-symbols.ts`, and the Oxc language-analysis adapter, service, types, and nearest tests. Codebase Memory reports no recorded path issues with a best-effort freshness caveat. Source reads establish the actual contracts.

The causal path has two missing mechanisms. The composer supplies neither source-derived guard spans nor structural anchors. The selector gives all supplied evidence spans the same score, then chooses source order. A scratch producer plus query-ranked evidence recovers the guard within the existing budget. The parent reproduces that result through the actual compiled MCP handler after the repair.

- Invariant: selected spans refer to the inspected source bytes. The existing final observation remains the authority for publishing source evidence.
- Lifecycle: the new evidence owner retains one transient analysis result per process. A different root, file, language, or source hash replaces that entry.
- Authoritative writer: Oxc supplies syntax spans. The selector owns query-based ordering. The cache stores frozen spans and does not establish source freshness.
- Persistence boundary: no new persisted state or index schema. The optional producer runs only for bounded context with a nonempty query. Ordinary indexing does not request its spans.
- Caller: the symbol-context composer requests the evidence and awaits completion before final source observation or descriptor release.
- Owner fit: the 1,343-line composer gains wiring only. `SourceContextEvidenceOwner` owns transient evidence reuse. `Context` gains no domain logic or state.

The producer accepts a no-else `if` whose consequent ends with `return` or `throw`. It includes a preceding declaration only when the immediately adjacent statement is a single const declaration whose identifier is the entire condition. It never searches recursively for matching names. The producer maps UTF-16 parser offsets through the canonical UTF-8 source map. The context owner reuses the existing 256 KiB current-source analysis limit and Oxc language boundary. Unavailable evidence retains the existing lexical selection path.

### Implementation and contract

- Core adds opt-in `includeEarlyExitSpans` and optional `earlyExitSpans`. The new tests compare every other analysis field with ordinary analysis.
- MCP adds the transient evidence owner. The cache key includes the inspected source hash. Same-key concurrent callers await one analysis. Unexpected failures clear only their own cache entry.
- The composer requests evidence only after the initial projection proves bounded. Complete source, empty queries, and unsupported analysis keep their established paths.
- The selector orders evidence spans by distinct existing query terms, then source order. Limits on bytes, lines, excerpts, and serialized output remain enforced.
- Selection policy version becomes `bounded_source_selection_v3`. The rerank contract asset follows that identity. An independent comparison checks that only this identity and its digest change. All document fixture fields remain identical.

### Checks and observed outcome

The original `read_file` request for `DecisionWorkerClient` uses the same symbol, query, root, and five-excerpt budget. Before the repair, all three reads omit the complete guard. After the repair, all three return excerpts at 63–69, 90, 104, 309–317, and 402–408. The excerpt at 309–317 contains the full const declaration, condition, and branch body. The response reports syntax and control-flow capabilities as available for this source.

Focused checks pass:

| Boundary | Passing checks |
|---|---|
| Core producer and language service | 9 Oxc tests and 69 service tests |
| Evidence owner, composer, and selector | 3 owner tests, 14 composer tests, and 14 selector tests |
| Existing source, finalizer, continuation, and public contract | 44 tests |
| Rerank projections, execution, and architecture | 94 tests |
| Independent syntax experiment | 25 assertions across six fixture sets |
| Independent finalizer experiment | Six actual temporary-file cases |

The finalizer cases cover unchanged source, appended content, a same-size edit with restored mtime, path replacement, an authority-check exception, and release without finalization. Every case releases its descriptor. A new composer test edits source during syntax collection and checks that the response contains no source excerpts or continuation. Another checks descriptor release when analysis throws.

The source-hash mutation check removes `observedHash` from the cache key. The regression fails. The parent restores the original file and checks that the focused regression passes. A separate deterministic test first exposes an error-masking race between rejected analyses for different files. The repair preserves each original error without clearing another request's entry.

Luna's review identifies an adjacent-declaration omission inside `SwitchCase.consequent`. A new fixture fails before the repair and passes after the producer handles that statement list. All three workspace packages pass typecheck. Changed-file lint passes. The workspace check passes before the review correction, and the affected lint and workspace typechecks pass again afterward. The unchanged version and scope checks retain their passing results. The generated rerank contract check and `git diff --check` pass.

The local-only artifact, `live-multi-repo-audit-2026-10-15-evidence/repair-f05-guard-context.json`, contains the request responses, measurements, mutation output, experiment sources, reports, and source hashes.

At the user's checkpoint request, `.gitignore` gains one exact rule for this generated evidence directory. The evidence remains available locally. The report, product code, and regression tests remain visible to Git. `git check-ignore` checks all five representative paths. No files are deleted by the ignore change.

### Measurements and limits

Command: `node read-context.mjs before|after`, saved in the evidence artifact. Each invocation starts a temporary direct MCP session from the compiled checkout and sends three identical reads. The first read includes initialization. Peak RSS comes from `/usr/bin/time`; load is the host's 1-, 5-, and 15-minute load average before the reads.

| State | Median of three reads | Peak RSS | Host load |
|---|---|---|---|
| Before F05 | 167.6 ms | 364,812 KiB | 0.26 / 0.28 / 0.22 |
| Initial repair | 182.4 ms | 361,296 KiB | 1.57 / 2.03 / 1.11 |
| Final repair after the switch-case correction | 191.4 ms | 364,120 KiB | 1.25 / 1.13 / 0.99 |

These observations establish guard recovery, not a speed improvement. Different host loads prevent attributing the latency difference to the repair alone. The cache test proves reuse for an unchanged source hash. The source owner retains one file only. Other files can require another analysis after eviction. The small query sample does not establish general context quality or semantic dependency coverage.

### Worker outcomes and brief retrospective

Luna (`220d1061458a`, max) supplies the syntax experiment and the review finding. The parent checks the experiment independently and repairs the reviewed defect. Luna initially tries the native collaboration tool with a Claive worker ID. That peer message fails. The parent relays the evidence through Claive. The channel stays open during the run, but no direct peer message is recorded in this round.

Haiku (`13d53415adb0`, max) reaches a 98k context count above Claive's 95k stop limit. Claive denies a write and performs two handoffs. Native TypeScript and custom-loader attempts then fail at imports. The parent requests a final handoff before another experiment. Haiku reports no successful mutation result. The parent does not accept that experiment as evidence and instead completes the six actual-file cases independently. No worker product edits are integrated. Both managed launcher sessions exit 0 after closure. The peer channel and both workers are closed.

Two parent checks also need correction. A new stale-response test initially assumes an absent `excerpts` field, while the established contract returns an empty array. The corrected test checks the exact empty array and absence of source content. No existing test oracle changes for that correction. The first cache-mutation gate expects TAP text while Node chooses another reporter. An explicit TAP reporter makes the negative check deterministic. A later changed-file lint check catches an unused local in the new differential test. The parent fixes that local and reruns lint.

Proposals from this run: give future scratch briefs the exact repository runner, distinguish Claive IDs from native agent names, and select a reporter explicitly for machine-checked negative tests. These remain workflow proposals. No skill or configuration changes follow from them.

Current state: six audit findings have checked repairs in the checkout. F04 ranking quality and F11 latency attribution remain open. The next bounded ranking step must compare the same candidates across provider and fusion order with a declared query oracle. No commit or installed-runtime change occurs.

## Review corrections: F05 relevance and capabilities, F09 CLI fallback

The user identifies three defects in the earlier repairs. Four new regressions reproduce them before the corrections. The earlier checks prove the sampled guard recovery but miss unrelated guards, empty syntax evidence, and the CLI's new text fallback.

- F05 relevance: every supplied guard starts at 20,000 points. A guard with no query terms displaces an exact lexical phrase. The selector now excludes zero-coverage evidence when the query has lexical terms. Relevant evidence keeps its existing priority. Evidence selection without query terms retains its established behavior.
- F05 capabilities: an empty array passes the previous truthiness check. The composer now requires `spans?.length` before changing capabilities or repeating selection. A real-analysis differential test checks that empty evidence produces the same response as unavailable evidence.
- F09 consumer: the status producer changes its text, but the CLI fallback still recognizes only the old wording. The CLI now recognizes the complete readable index message and retains the existing old-text case. Tests cover verified, changed, and unverified source parity. The CLI mock and its no-poll assertions use the current wording.

The relevance regression runs at both the selector and composer boundaries. A large function contains two unrelated guards and one exact phrase match. With three one-line excerpts, both tests retain the declaration, phrase match, and terminal line. The existing guard-recovery test still passes. The composer test uses the actual source-evidence owner and Oxc analysis.

Checks: 42 focused tests pass across the selector, composer, and CLI. Another 100 tests pass across rerank projection, native rerank, golden execution, the generated contract, source continuations, the public context contract, and maintenance status. The golden snapshot requires no update. Changed-file lint, MCP typecheck, the generated contract check, and `git diff --check` pass. The CLI's 11 tests pass again after its no-poll assertions change to the current wording.

The user also notes analysis-error propagation as a risk. The existing injected-error test checks descriptor release before propagation. No fallback behavior changes in this correction. General context quality and F04/F11 remain outside these passing checks.

## Approved correction: optional analysis errors retain the first selection

The user approves fallback at `SourceContextEvidenceOwner.collect`. A failed optional analysis now returns `undefined`. The owner clears only the cache entry for that failed promise. Both new and cached callers await analysis inside the same error boundary. Synchronous analysis failures also return `undefined`. The composer needs no change.

Four regression cases fail before this repair. After the repair, 46 tests pass across the evidence owner, composer, selector, and public context contract. The composer test injects analyzer failure through the real owner. Its result equals the first selection, including capabilities and continuations, and its source descriptor is released. Other tests check concurrent callers, retry after failure, and preservation of another file's pending cache entry. Changed-file lint, MCP typecheck, and `git diff --check` pass.

The earlier propagation test describes historical behavior. Optional analysis errors no longer fail the request. The staged user changes remain intact. No commit, installation, or ranking-policy change occurs.

## F04 diagnosis after the fallback repair

Systematic debugging separates the first lost owner from later ranking changes. Codebase Memory locates the owners. Source inspection checks their actual mechanisms. Satori guidance governs readiness and warning interpretation. Completion checks cover each repair without treating the ranking investigation as a completed fix.

### Contract consumer missed by the earlier F05 checks

The first capture fails before retrieval with `LateOn v6 runtime profile is malformed or unsupported`. F05 changes the generated request-contract digest to `59c4ed4d5669708f8eeffa1021291359788ba4971bd046447ed70ec2a3df9ff7`. The runtime profile still pins `c794b9254d8b8bfedf86dbc6705a2c0b7cf44f7bce74c1c288ef9c1e3bb48022`. The existing default-profile test reproduces the failure. Earlier focused checks omit this consumer, so the previous repair claim misses a real runtime failure.

The repair synchronizes only `identity.requestContractSha256` in `runtime-profile-v6-d128.json`. It preserves model artifacts, projection versions, qualification status, and activation policy. The existing profile and request-contract suites now pass 35 tests, with two skipped. This restores profile loading. It does not establish new ranking quality or held-out qualification.

A scratch baseline experiment encounters package resolution failure, then produces no usable candidate trace. Those attempts provide no ranking evidence. The successful captures use the compiled checkout after the pin correction. Session-only automatic workspace indexing is disabled. Existing read freshness behavior remains enabled. No explicit create, sync, reindex, or clear call occurs. An earlier attempt logs automatic maintenance. Both temporary servers terminate, and process inspection finds no owned scratch runtime or indexing worker. The existing installed MCP process remains untouched.

### Declared query owners and captured stages

Before capture, the oracle declares `FileSynchronizer.prepareChanges`, `SearchResultSetCache`, and Claive's `read_new`. The cache class owns handle creation and expiry through `store` and `lookup`. `read_new` serializes named consumers and delegates cursor advancement to `_read_from`. The oracle requires the implementation owner among the first five grouped results. The original query arguments, including `alt_terms`, remain unchanged apart from diagnostic fields.

| Query | Observed owner path | Supported conclusion |
|---|---|---|
| Observation | Persisted method evidence reaches MCP input passes. Admission removes it with `dirty_source_suppressed` before the admitted pool is recorded. A containing file fallback goes from provider rank 2 to fusion rank 42, then grouped rank 39. | The first loss is dirty-source admission. The file fallback has a separate, demonstrated fusion demotion. The fallback is not a canonical method result. Preserve the freshness guard. No single ranking rule is established as a complete repair. |
| Handle | The canonical cache class survives admission at rank 9. Provider rank is 8, fusion rank is 8, and final/grouped rank is 7. | The class misses the five-result oracle before post-provider fusion. That fusion does not cause this class's miss. Provider or projection changes still need a discriminating check. |
| Inbox | Input rank 4, provider rank 2, fusion rank 4, grouped/disclosed rank 3. | The named-consumer owner satisfies the five-result oracle in this capture. The earlier miss does not reproduce. |

The handle request in the shared session serves a previous generation and skips reranking. One separate first-request capture supplies its provider and fusion stages. Initial source-range matches include child methods. The final analysis binds the declared cache class to its exact canonical span, 108–239, and symbol ID. It does not count a nearby method as the class owner.

The first owner loss is recorded by `runSearchExecution` and enforced by `fuseCandidateSets` in `search-candidate-fusion.ts`. The latter rejects persisted dirty-file candidates when current-source evidence must replace them. The source and removal trace agree. Diagnosis stops at this demonstrated boundary. The dirty-source replacement and provider-input questions remain open rather than becoming guessed policy changes.

The local-only artifact `live-multi-repo-audit-2026-10-15-evidence/repair-f04-three-query-stages.json` preserves the declared oracle, exact requests, responses, identity binding, removals, and runner sources. The local-only artifact `live-multi-repo-audit-2026-10-15-evidence/repair-f04-preflight-blocker.json` preserves the contract failure and its resolution. Expected source hashes, repository HEAD values, and Git-status hashes remain identical before and after each successful capture. Satori source freshness is changed, so these captures do not reproduce the original publication.

F04 now has source-backed stage evidence, not a ranking repair. F11 remains open. These requests do not supply the required cold/warm medians. The three-query process peaks at 1,104,592 KiB RSS. The standalone handle capture has no peak-memory result. Neither observation supports a performance claim. Future contract changes must include the existing runtime-profile test in their focused checks.

## Acquisition manifest correction after the CLI suite

The user's CLI suite exposes another consumer missed by the profile repair. `readLateOnAcquisitionAuthority` hashes the exact runtime-profile bytes. The acquisition manifest still pins the old profile digest, so installation rejects the package. The existing `acquisition manifest binds the exact frozen profile digest` test reproduces this failure before the correction.

The repair changes only `runtimeProfileSha256` in `runtime-profile-v6-d128.acquisition.json` to `1b0021653d7330c3676eadd9e60d2b94e75eb5e1879964f49d831ef4a5e521e5`. A comparison against HEAD checks that every other manifest field remains identical. The runtime profile itself remains unchanged. Existing model-store and installation-preflight tests pass: 101 tests across two files. The digest assertion remains intact. No new tests, code, dependencies, installation, or commit are needed. `git diff --check` passes.
