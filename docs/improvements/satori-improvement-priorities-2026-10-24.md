# Satori improvement priorities, 24 October 2026

Status (current, 24 October 2026): the baseline reconciliation, saved-capture rescoring,
current-runtime measurement, f6 diagnosis, and f6 disjoint-lane implementation are complete.
The disjoint-lane fix is committed as `6b31381b`. The later roadmap in steps 3-5 is still
proposed. Historical stage statuses below keep their dates. Where an earlier stage says
"uncommitted" or "not implemented", read it as the state at that stage, not the current state.
Read "Current state after f6" before resuming any step.

## Purpose and decision

Improve the complete agent workflow: install, index, find the owner, read evidence,
edit, and find the updated owner. Prioritize correct answers, freshness, and resource use.
Assumption: these core workflows take priority over new features and platform expansion.

Three possible approaches are a repository-wide audit, a TypeScript migration first,
or measured improvements to these workflows. Recommend the third approach.
An audit adds investigation without a demonstrated failure. A compiler migration
does not establish a Satori memory gain. Workflow measurements can identify the owner
and a stopping condition for each repair.

This document orders existing work. Linked investigation documents retain their
evidence and detailed designs. Their historical statuses require a current check.

## Current state after f6, 24 October 2026

- **Baseline and replay are complete.** Three saved captures rescore under the current
  p3 acceptance. The change is rubric-only: hit@10 +1, strict hit@10 +1, and MRR@10 +0.005102.
  Hit@1 and hit@5 are unchanged. The p3 hits are `cast_unchecked` at rank 7 and `strict_cast` at
  rank 10. Neither hit proves `Column::cast`. No retrieval changed.
- **One live 28-query measurement exists.** At HEAD `11889927`, overall hit@10 is 21/28 and
  strict hit@10 is 20/28. It is a baseline. It does not attribute a score change to the quota
  removal, because capture settings and runtime bytes also differ from the earlier capture.
- **The f6 implementation is committed.** Commit `6b31381b` adds the disjoint declaration-lane
  filter. The paired run recorded workspace HEAD `5f7e906c`, and the fix was uncommitted then. Its
  tested source hash `93ad6a8c8fda2c69f25d024613c51d5dfe56e864aedd19bd14e06760c6ee3304` equals the
  committed file. The paired 28-query comparison gives hit@10 21 to 22. Exact `GenTable` moves from absent
  to rank 2. `GenTablePost` is rank 1 and satisfies the case regex, so the hit@1 gain is a regex
  acceptance, not exact-owner recovery.
- **The f6 query cost is unresolved.** Five paired f6 runs give a median query delta of
  +300.4 ms (+5.51%), positive in 4/5 pairs. The sample is too small to separate a small real
  cost from run-to-run drift. Do not record it as proof of no effect, and do not claim that
  no regression exists. It is also not a speedup.
- **No RAM-saving claim follows.** The paired median peak process-tree RSS delta is -129.8 MiB.
  That is one snapshot on one host, not a memory improvement.
- **The rest is still proposed.** Edit freshness, indexing and memory cost, delivery, and the
  TypeScript proof remain later proposals.

Evidence for the f6 numbers:
`/tmp/satori-disjoint-lanes-paired-20261024/raw/analysis.json` and
`/tmp/satori-disjoint-lanes-paired-20261024/raw/latency-summary.json`. These are local transient
artifacts, not versioned. The raw files may be unavailable after cleanup.

## 1. Establish a current baseline

Start with the existing 28-question React, Polars, and FlatBuffers evaluation.
Use the revised p3 acceptance and record its identity separately from earlier rubrics.
Preserve the existing dirty checkout. Record the source revision, local changes,
built runtime, model settings, publication identities, and result limits.

First rescore a compatible saved capture, if available, without retrieval changes.
Report the rubric-only difference separately. Adding an accepted path does not prove
that the current results contain that path or that search improves.
Then capture current search behavior when an equivalent capture does not exist.
Keep model costs explicit before any paid measurement.

Record owner rank, file acceptance, strict symbol acceptance, and missing-owner stage.
Keep file and symbol scores separate. Use Jev disagreements as review candidates.
Resolve disputed acceptance against pinned source, not model confidence alone.

Deliverable: one reproducible baseline with every miss assigned to extraction,
retrieval, admission, reranking, fusion, disclosure, or an unresolved rubric question.
Stop when each miss has a supported stage or an explicit evidence gap.
Do not restart intent-cue work without evidence that the earlier negative result changes.

## 2. Repair demonstrated search failures

Choose one failure mechanism from the baseline. Repair its responsible owner.
Prioritize missing owners before low-ranked tail noise unless rank damage proves otherwise.

Existing leads, subject to current reproduction:

- Check f7 after the C++ extraction repair. Recovered symbols alone do not prove a search gain.
- Measure the committed recovery-quota removal through the full search route.
  Helper timing alone does not establish final quality or latency.
- Resume the S1 call-backed admission and final owner-selection experiment only if
  its original query still misses. Compare admission and fusion separately.
- Inspect the Polars p2 word collision only if it still displaces the correct owner.
  One unrelated high result does not justify a global ranking penalty.

For each candidate, freeze the query, rubric, publication, provider, and limits.
Require improvement on its target and preserve the existing control owners.
Check explicit helper, test, reference, and path intents when the changed policy affects them.
Run the broader search checks required for changes to this hot path.
Reject rules that only rescue one example or move failures to other queries.
Stop each experiment when it disproves the mechanism or passes its acceptance checks.

## 3. Reduce edit-to-answer delay

Resume the [edit freshness plan](agent-ready-sync-plan-2026-10-22.md).
Its recorded one-file median is 13.005 seconds. The earlier 12-second target remains unmet.
Reproduce the current N=1,16,32 probes before choosing a repair.
Measure worker startup, analysis, persisted-state loading, staging, and publication.
Optimize the largest current cost. Do not assume a warm worker is the answer.

Preserve first-search freshness, completed cancellation, lease ownership, and cleanup.
Use deterministic failure checks when the changed mechanism affects those guarantees.
Compare at least three before and after runs on identical inputs.
Report medians, peak memory, machine load, and exact commands.
Stop when the existing target passes without correctness or memory regressions.
If measurements disprove the proposed mechanism, return to the profile.

## 4. Reduce measured indexing and memory costs

Resume the current [indexing record](indexing-architecture-and-optimizations-2026-10-21.md).
Use the [offline profile](offline-index-performance-plan.md) as historical evidence only.
Its October 16 measurements precede later optimizations and contain only one run.

Measure one small and one large representative repository on the current runtime.
Run heavy jobs serially on this host. Separate idle, search, sync, and full-index memory.
Measure the owned process tree. Do not attribute other app sessions to the trial.
Rank current costs before selecting one bounded change and its numerical target.
Require identical published results for optimizations, plus failure-path checks
when concurrency, cancellation, or publication ownership changes.
Report three-run medians, peak memory, load, and commands before accepting a gain.
Stop after the selected target passes. Open another optimization only from the new profile.

## 5. Check delivery, then consider capability expansion

Check install, doctor, indexing, search, source reading, and edit freshness through
the actual supported client and packaged runtime before preparing a release.
Reproduce any failure before proposing a repair. Refresh historical release findings
against current package versions. Do not apply old version-bump instructions blindly.
Publication and branch operations remain separate user decisions.

Keep the [TypeScript mapper investigation](typescript-content-mapper-proof-plan-2026-10-24.md)
as a separate capability project. The record reports no measured Satori RAM saving.
Before implementation, resolve the API migration and repository-executable trust boundary.
Require evidence of useful framework coverage and correct source spans.
Do not add dependencies, execution services, or compatibility layers through this plan.

## Execution and completion

Execute one bounded slice at a time. Each slice names the visible failure, invariant,
owner, repair hypothesis, disproving check, and stopping condition before code changes.
Use the linked plan when it already covers the design. Preserve earlier work.
After two failed attempts without measured gain, stop and obtain a fresh diagnosis.

For delegated work, use one scoped brief with exact files and checks.
The parent checks the returned artifact before another slice starts.
Do not create a standing audit, benchmark service, or parallel heavy-job queue.

At the time of writing, the immediate next action was baseline reconciliation in step 1.
That slice is now complete; see the execution record below. It stopped when
the current acceptance and saved results yielded a reproducible, correctly attributed score.
The later stages remain proposals until their evidence supports a concrete slice.

## Baseline reconciliation execution, 24 October 2026

Status: complete for saved-capture rescoring and runtime compatibility. No live search run,
index build, build, model call, or paid API call. The only repository write is this section.

### Identity

| Item | Value |
|---|---|
| Source HEAD | `118899275f2c1f62ada97eecb3dfcc2c90528848` (`fix(search): recover source-backed symbols without file quotas`) |
| Tracked dirty diff | `git diff --binary HEAD` sha256 `fe1c487d6e2d5bb7d3a75f9bc2ba48e8fd295cb74c5a1f9947c411280fff9966` |
| Status identity | `git status --porcelain=v2` sha256 `431f0ede77d4c9b20c97e3c6d55e82552c1d8559aa91e13ca1f5b222b704f4c5`, 16 entries |
| `cases.json` | sha256 `6144f67803cbd12f4bb19f5e57b776a4d4ae867f02feb7c24b71aa02c1e9be09`, 28 queries, topK 10 |
| `score.mjs` | sha256 `011f7944bd11eb7dcf15fd075fe3ecfeb7873ea96f30da82aabd86ac35b67dd2`, equal to HEAD |
| Rubric diff | +6/-1 lines in `cases.json`, only p3's added column owner and justification |

The p3 acceptable set is the only rubric difference between the working tree and HEAD.
The pre-existing dirty and untracked files stayed untouched.

### Captures

| Capture | Result file | sha256 | Generated | HEAD | Publications | Extractor | Request | Returned |
|---|---|---|---|---|---|---|---|---|
| A baseline v22 | `/tmp/orch/bench/quality/result.json` | `66e548730422efeac1c1f4c7baedb9b3af99f8e37728ad60418bdfbd3bc46550` | 2026-10-23T12:22:03Z | b26af3d | d49ad19b, b5e7183d, 75463d95 | v22 | limit 10, no disclosureLimit | 10 |
| B S8 recheck v22 | `/tmp/orch/S8/baseline-recheck/quality/result.json` | `e1f497e46829f455576f894f34af9fdd213d65adb627e91cd178570c71da6d24` | 2026-10-23T13:02:05Z | b26af3d | same as A | v22 | limit 20, no disclosureLimit | 20 |
| C v23 | `/tmp/orch/measurement-v23/result.json` and `response-*.json` | `20a9d57453877624873b1bf204e271ff99794e77e75751b1fd89c139d715903d` | 2026-10-23T14:07:09Z | b26af3d | 9dbbcb40, cbd34c4b, 136befd0 | v23 | limit 20, disclosureLimit 10 | 10 of 20 |

A and B share the same three Publications. They are not independent measurements.
Their first ten results are identical for all 28 queries.

Capture C identity: node v24.19.0, offline profile, LanceDB, Potion
`minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b`, dimension 256,
reranker `lateon_offline_quality_projection_v6_d128_v1`, activation
`lateon_context_v6_d128_owner_default_v1`. Resolved flags are `compound_join`, `path_demotion`,
`definition_discovery`, `definition_alt_terms`, and `rerank_alt_terms`. The other flags are off.
Model file hashes are in `preflight.json` and in the reconciliation output.

Pinned revisions: react `7c6ac13e19fef500b7f669a16bbd01ecc95965ca`, polars
`74dd736d655cc3c7a70857d859030d957deba7ac`, flatbuffers
`b8431fbcd7a5c71817f314e18b332c0648554efa`.

Capture C output limits: requested 20, effective 20, returned 10. Disclosure policy is
`search_disclosure_v1` with reasons `initial_budget` and `caller_limit`. Available groups
range from 37 to 122.

Captures A and B record no runtime hash. Their runtime identity is unknown beyond the server
log (v0.10.4, offline, Potion, lateon).

### Method

The rescore imports the repository `score.mjs`. It builds hits from each saved response with
`normalizeHit` and positional ranks. It keeps the first 10 results, which is the committed
`topK`. The old rubric is an in-memory copy of `cases.json` with exactly one change: removal of
p3's `^crates/polars-core/src/frame/column/mod\.rs$` owner. The script does not write `cases.json`.

Metrics: hit@k counts rank <= k. MRR@10 is the mean of 1/rank for rank <= 10 and 0 otherwise.
Strict metrics use `strictRank` under the same cutoffs. Strict means a symbol-granularity hit for
an owner with `symbolRegex`, or any symbol hit for an owner without one. It is not proof of a
named symbol.

Checks:
- Each capture scores twice and the results are deep-equal.
- Only p3 changes between rubrics in every capture.
- Each capture has the 28 case ids, with no duplicates or extras.
- The old rubric reproduces the recorded v23 totals exactly (13/21/21, MRR@10 0.575595, strict 13/20/21, 0.561706).
- The old rubric reproduces the checkpoint baseline counts (hit@10 21/28, strict 20/28).
- A and B have identical first-ten outputs for all 28 queries.

### Scores

| Capture | Rubric | hit@1 | hit@5 | hit@10 | MRR@10 | strict hit@1 | strict hit@5 | strict hit@10 | strict MRR@10 |
|---|---|---|---|---|---|---|---|---|---|
| A | old | 13 | 21 | 21 | 0.572619 | 13 | 20 | 20 | 0.554762 |
| A | current | 13 | 21 | 22 | 0.577721 | 13 | 20 | 21 | 0.559864 |
| B | old | 13 | 21 | 21 | 0.572619 | 13 | 20 | 20 | 0.554762 |
| B | current | 13 | 21 | 22 | 0.577721 | 13 | 20 | 21 | 0.559864 |
| C | old | 13 | 21 | 21 | 0.575595 | 13 | 20 | 21 | 0.561706 |
| C | current | 13 | 21 | 22 | 0.580697 | 13 | 20 | 22 | 0.566808 |

The rubric-only delta is the same in all three captures: hit@1 0, hit@5 0, hit@10 +1,
MRR@10 +0.005102, strict hit@1 0, strict hit@5 0, strict hit@10 +1, strict MRR@10 +0.005102.
The MRR delta is exactly 1/7/28, from p3 moving from absent to rank 7.

### p3

All three captures return the new accepted path at rank 7.

| Field | Current rubric | Old rubric |
|---|---|---|
| rank | 7 | absent |
| strictRank | 7 | absent |
| granularity | symbol | - |
| path | `crates/polars-core/src/frame/column/mod.rs` | - |
| symbol | `cast_unchecked` | - |

A second accepted hit is `strict_cast` at rank 10 on the same path. The hit granularity is symbol.
The symbol is unconstrained, because the added owner has `symbolRegex: null`. The curated dispatch
symbol `Column::cast` exists in the v23 Publication at line 486. It is not the returned hit.
`strictRank` 7 therefore proves a symbol-level result in the accepted file, not recovery of
`Column::cast`.

The original kernel path `crates/polars-core/src/chunked_array/cast.rs` is absent from the top 10
in all three captures. Its symbols exist in the Publication, including `cast_impl_inner` at line 75
and `cast_impl` at line 126. The rubric correction therefore changes the score without any search
change. It is not a search gain.

### Remaining misses

Capture C, current rubric, 28 queries, 6 misses. Under the old rubric there were 7. p3 left the miss
set only through the rubric change.

| id | Earliest supported stage | Recorded path | Evidence |
|---|---|---|---|
| r1 | retrieval | no stage contains the owner | Both owners exist in the Publication (`commitHookEffectListUnmount` line 248, `safelyCallDestroy` line 907). All four lanes and every later stage are null. |
| r3 | admission | rerank input 110, provider 60, fusion 62, output 27, grouped 19 | `areHookInputsEqual` exists at line 456. It is absent from all four lanes and enters at the rerank boundary at 110. |
| f3 | fusion | lexical 1, core fusion 20, mcp fusion 32, provider 91, fusion 15, grouped 15 | `StartVector` exists and enters at lexical rank 1. Core and MCP fusion put it outside the top 10. |
| f5 | retrieval | no stage contains the owner | `ParseDecl` line 2869 and `DoParse` line 3777 exist. All four lanes and every later stage are null. |
| f7 | fusion | dense 2, core fusion 6, mcp fusion 11, provider 37, fusion 53 | `ParseField` line 919, `ParseAnyValue` line 1362, and `ParseEnum` line 2552 exist. The recovered owner reaches rerank input at 11 and leaves at 53. |
| f10 | fusion | lexical 2 and 1, core fusion 3, mcp fusion 15, provider 14, fusion 21 | `prep` and `requestCapacity` exist. MCP fusion puts the owner at 15. |

Stage rule: the earliest recorded stage where the accepted owner is outside the top-10 cutoff, after
the Publication symbol registry proves the owner exists. Retrieval means no lane or later stage
contains it. Admission means it is absent from all lanes and enters at the rerank boundary.
The stage rows come from `/tmp/orch/measurement-v23/result.json` and `lane-metrics.json`. Both
belong to the same Publication and extractor identity as the responses.

No current miss is a disclosure miss. All six have grouped rank greater than 10. The 10-result
disclosure hides ranks 11 to 20, but that does not change hit@10.
Historical findings from the v22 captures are not restated as current evidence. In particular, the
checkpoint's p3 and f9 observations belong to A and its older Publications.

### Runtime compatibility

The v23 C++ extraction fix is represented in capture C. The preflight source hashes for
`tree-sitter-adapter.ts`, `versions.ts`, and `service.test.ts` equal the current working-tree
hashes. All three C Publications record `language-analysis-v23`. The captured adapter runtime hash
equals the current one.

Quota removal commit `11889927` is not represented in capture C. Its HEAD `b26af3d` is the parent of
`11889927`. The capture ran from 14:02Z to 14:07Z. The commit is at 20:52Z.
`packages/mcp/dist/core/search-file-symbol-supplement.js` was rewritten at 02:22:10+05:30, after
the capture, and it contains the new `pathContextScore` and `sourceOnlyMatch` code.

The current dist is fresh against current source for core, mcp, and cli. The four captured runtime
hashes still match. Current dist tree hashes are mcp
`156280aeda28d60fd567266302a448419b969def9b6c2573497db9d05d95aae3` and core
`2cfc9f5fe651d9f134cbcca737cf2806b0d0af1c311606dfbe7584131337c398`. However, 44 JavaScript
files under `packages/mcp/dist` and `packages/core/dist` were rewritten after the capture. Their
captured bytes are not recorded. Full runtime equality is therefore unknown, and the quota change
is present in the current dist.

Conclusion: no saved capture is a current-runtime baseline. The saved captures support rubric-only
rescoring, not a claim about current search behavior.

### Missing evidence and next command

Missing evidence for a current baseline:
- No 28-query capture at HEAD `11889927` with the current built runtime and a full dist tree hash.
- No captured bytes for the 44 rewritten dist files.
- No runtime hash at all for captures A and B.

Smallest next live command, not run:

```bash
node evals/real-repo-quality/run.mjs \
  --repos react,polars,flatbuffers \
  --state-root /tmp/satori-baseline-reconciliation-20261024/live-state \
  --out /tmp/satori-baseline-reconciliation-20261024/live-out
```

This command incurs no paid API calls. It uses the offline profile with local Potion embeddings and
the local lateon ONNX reranker. It builds three indexes in a fresh state root, about 1.6 GB.
Historical index times are 65 s for React, 106 s for Polars, and 38 s for FlatBuffers. The v23 run
peaked at 4209 MiB RSS. Run it alone on this host. It is the smallest command that measures
`11889927` in the built runtime with recorded identity.

The command uses the committed `topK` 10, so it requests 10 results. `run.mjs` has no
`disclosureLimit` option. A same-shape comparison with capture C needs a temporary cases copy with
`topK` 20, and still cannot set the disclosure limit.

### Next repair candidate

The best-evidenced near miss is f7. Extraction now proves `ParseField`, `ParseAnyValue`, and
`ParseEnum` exist. The owner reaches rerank input at 11, the provider moves it to 37, and fusion
leaves it at 53. The saved response keeps the reranker input document and the provider and fusion
scores. The next bounded check is a frozen replay of those rows, to test whether the provider score
or the fusion blend causes the 11 to 37 to 53 move. It makes no search call. The missing-owner class
(r1 and f5) has higher priority under the plan, but no mechanism is identified yet.

### Checks and artifacts

- `node --check /tmp/satori-baseline-reconciliation-20261024/scripts/reconcile.mjs` passes.
- Two full runs produce byte-identical `reconcile.json`, sha256 `8e910117c7cff6e90967e799179adc74b7b8e5f7b2a6c389558da35eaf872092`.
- `git diff --check` reports no whitespace error.
- The tracked diff is unchanged. This document is the only file written by this slice.
- No background process, build, index, model call, or paid call ran.

Artifacts:
- `/tmp/satori-baseline-reconciliation-20261024/scripts/reconcile.mjs`
- `/tmp/satori-baseline-reconciliation-20261024/out/reconcile.json`
- `/tmp/satori-baseline-reconciliation-20261024/out/reconcile.sha256`
- `/tmp/satori-baseline-reconciliation-20261024/out/summary.json`

Limitations:
- A and B are the same Publications. They are not independent runs.
- Stage assignment uses harness-derived joins, not source-level proof of the mechanism.
- Capture C returns 10 of 20 requested results.
- No capture records a full dist tree hash.
- The p3 strict rank is not a curated-symbol match.

## Current-runtime measurement, 24 October 2026

Status: one live 28-query run of the current runtime completed. Exit code 0, wall time 334.4 s,
peak tree RSS 4306.9 MiB. The run built three Publications from an empty state root and used the
local Potion embedder and the local lateon ONNX reranker for all 28 queries. It made no remote or
paid call. The only repository write in this slice is this section.

### Identity

| Item | Value |
|---|---|
| Source HEAD | `118899275f2c1f62ada97eecb3dfcc2c90528848` (`fix(search): recover source-backed symbols without file quotas`) |
| Status identity | `git status --porcelain=v2` sha256 `fe33f597f20e6ca3bf1a97c2ca6ae1189e586e74f8f8474c270bd59b227d12ea`, 16 entries |
| Tracked dirty diff | `git diff --binary HEAD` sha256 `1e50b3c67965a5404b484feb2c070da8202a3a0bc7c67d3db72a2bc666456e8c` |
| `cases.json` | sha256 `6144f67803cbd12f4bb19f5e57b776a4d4ae867f02feb7c24b71aa02c1e9be09`, 28 queries, topK 10 |
| `score.mjs` | sha256 `011f7944bd11eb7dcf15fd075fe3ecfeb7873ea96f30da82aabd86ac35b67dd2` |
| `run.mjs` | sha256 `91734fef18202c70f0a03fa148f0dd502654e9554160ce2028fd9811b3641d91` |
| `packages/core/dist` | tree sha256 `1eb46b943397568b253f26a2cc44610671495c40a4fbc47a4f5c87b824f91508`, 1105 files |
| `packages/mcp/dist` | tree sha256 `38ebb8f7a4e77920ef05a01ce6a99b5e7d0b02489ad911c7b7fa49b34fd81dd8`, 1200 files |
| `packages/cli/dist` | tree sha256 `d7807f00b78ae69844e2f6b3ccab93d9004d436fbd819cc6f18273a63ecff34d`, 293 files |
| Dist freshness | 352 modules checked, 0 violations |
| Node, platform | v24.19.0, linux 6.18.54.1-microsoft-standard-WSL2, 16 logical CPUs |
| react | `7c6ac13e19fef500b7f669a16bbd01ecc95965ca` |
| polars | `74dd736d655cc3c7a70857d859030d957deba7ac` |
| flatbuffers | `b8431fbcd7a5c71817f314e18b332c0648554efa` |

Tree hashes cover sorted relative path, NUL, content sha256, and LF. The harness imports search
code from `packages/*/dist` and starts the MCP server from `packages/mcp/dist/index.js`. The dist
trees above are therefore the measured runtime.

Provider and model identity:

- Runtime profile `offline`, vector store LanceDB.
- Embeddings: `minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b`, 256
  dimensions, local helper `satori-potion` sha256
  `1b2aa8b6a61a17135adc908a6904d8081e867d7d14cdf05cb1f476edda141b55`.
- Reranker: profile `lateon_offline_quality_projection_v6_d128_v1`, activation
  `lateon_context_v6_d128_owner_default_v1`, local ONNX model
  `LateOn-Code-edge@07ef20f406c86badca122464808f4cac2f6e4b25`.
- No API key was present in the harness process.

Extractor identity:
`language-analysis-v23+oxc-0.139.0+web-tree-sitter-0.26.10+vscode-grammars-0.3.1+scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3+cbm-extractor-11b662f9f7fb-emscripten-3.1.64+cbm-extended-present`.
The extended extractor tree hash is
`21a0a41bed78e292190463362a8b72f7e859d602133ff272f47087402fdc962a` over 101 files.

Search policy:

- Flags on: `compound_join`, `path_demotion`, `definition_discovery`, `definition_alt_terms`,
  `rerank_alt_terms`. All other resolved flags are off.
- Reservation policy `cap55`, cap 55, alternate terms capped at 4.
- Request limit 10, no `disclosureLimit`, 10 returned, disclosure reason `caller_limit`.

### Method

The authorized command ran once in a managed session:

```bash
node evals/real-repo-quality/run.mjs \
  --repos react,polars,flatbuffers \
  --state-root /tmp/satori-baseline-reconciliation-20261024/live-state \
  --out /tmp/satori-baseline-reconciliation-20261024/live-out
```

The state root was empty at start. The run used the existing `cases.json` with `topK` 10 and the
unchanged matcher. It applied no temporary case copy, no topK or disclosure override, no dist
rebuild, and no environment change.

`live-out/scripts/analyze.mjs` reads the stored hits from `result.json`, calls the repository
`scoreQuery`, and uses array position for rank. Recomputed scores equal stored scores for all 28
cases (0 mismatches). Rank absent means the accepted owner is outside the returned ten.

Completeness checks:

- 28 case ids in the result, no duplicates, no missing or extra ids.
- Every response has `status: "ok"`; all three indexes succeeded; 0 protocol errors.
- All 28 freshness checks report `verified`; 0 freshness skips.
- 28 reranker telemetry events, 28 with `reranker_used: true`, 28 reranker calls, 9 lateon init
  lines, 0 error lines. Reranker candidate counts range from 80 to 128.
- No task-owned process remained after the run.

Index wall time by repo: react 60.1 s, polars 98.2 s, flatbuffers 31.8 s.

### Scores

| Window | hit@1 | hit@5 | hit@10 | MRR@10 |
|---|---|---|---|---|
| overall | 13/28 | 20/28 | 21/28 | 0.544983 |
| strict | 13/28 | 19/28 | 20/28 | 0.533078 |

| Repo | overall hit@10 | strict hit@10 |
|---|---|---|
| react | 7/9 | 7/9 |
| polars | 9/9 | 9/9 |
| flatbuffers | 5/10 | 4/10 |

Strict uses `scoreQuery` `strictRank` unchanged. For an owner with `symbolRegex: null`, a strict hit
proves a symbol-granularity result on the accepted path, not a curated named symbol.

### Per-case results

`top result` is the highest-ranked result for the query. It is not necessarily the accepted owner.

| repo | id | rank | strict | granularity | top result |
|---|---|---|---|---|---|
| react | r1 | absent | absent | - | `packages/react/src/ReactHooks.js` |
| react | r2 | 3 | 3 | symbol | `packages/react-reconciler/src/ReactFiberHooks.js` |
| react | r3 | absent | absent | - | `packages/react-reconciler/src/ReactFiberHooks.js` |
| react | r4 | 1 | 1 | symbol | `packages/react-server/src/ReactFlightServer.js` |
| react | r5 | 1 | 1 | symbol | `packages/react-reconciler/src/ReactFiberWorkLoop.js` |
| react | r6 | 1 | 1 | file | `packages/eslint-plugin-react-hooks/src/rules/ExhaustiveDeps.ts` |
| react | r7 | 5 | 5 | symbol | `packages/react-devtools-shared/src/hooks/__tests__/__source__/__untransformed__/ComponentWithUseEffect.js` |
| react | r8 | 1 | 1 | symbol | `packages/react-reconciler/src/ReactFiberBeginWork.js` |
| react | r9 | 1 | 1 | symbol | `packages/react-reconciler/src/ReactFiberHooks.js` |
| polars | p1 | 3 | 3 | file | `py-polars/src/polars/io/spreadsheet/functions.py` |
| polars | p2 | 3 | 3 | symbol | `py-polars/src/polars/dataframe/frame.py` |
| polars | p3 | 7 | 7 | symbol | `py-polars/src/polars/catalog/unity/models.py` |
| polars | p4 | 1 | 1 | file | `crates/polars-compute/src/rolling/mean.rs` |
| polars | p5 | 1 | 1 | symbol | `crates/polars-plan/src/plans/optimizer/predicate_pushdown/mod.rs` |
| polars | p6 | 1 | 1 | symbol | `crates/polars-stream/src/nodes/io_sources/parquet/mod.rs` |
| polars | p7 | 4 | 4 | symbol | `crates/polars-lazy/src/tests/aggregations.rs` |
| polars | p8 | 1 | 1 | file | `crates/polars-python/src/interop/numpy/to_numpy_series.rs` |
| polars | p9 | 1 | 1 | symbol | `py-polars/src/polars/dataframe/_html.py` |
| flatbuffers | f1 | 1 | 1 | symbol | `net/FlatBuffers/FlatBufferBuilder.cs` |
| flatbuffers | f2 | 3 | 3 | symbol | `net/FlatBuffers/FlatBufferVerify.cs` |
| flatbuffers | f3 | absent | absent | - | `rust/flexbuffers/src/builder/vector.rs` |
| flatbuffers | f4 | 1 | 1 | symbol | `go/builder.go` |
| flatbuffers | f5 | absent | absent | - | `include/flatbuffers/reflection_generated.h` |
| flatbuffers | f6 | absent | absent | - | `src/idl_gen_cpp.cpp` |
| flatbuffers | f7 | absent | absent | - | `include/flatbuffers/idl.h` |
| flatbuffers | f8 | 1 | 1 | symbol | `tests/swift/Tests/Flatbuffers/FlatbuffersVerifierTests.swift` |
| flatbuffers | f9 | 3 | absent | file | `dart/lib/src/builder.dart` |
| flatbuffers | f10 | absent | absent | - | `go/builder.go` |

f9 reaches `swift/Sources/FlatBuffers/FlatBufferBuilder.swift` at rank 3, but the hit has
`symbolKind: file` and no symbol. It misses the accepted `create` symbol, so it has no strict hit.
p1 also has file granularity, and its strict rank equals its rank because the owner has no
`symbolRegex`.

### p3

| Field | Value |
|---|---|
| rank | 7 |
| strictRank | 7 |
| granularity | symbol |
| path | `crates/polars-core/src/frame/column/mod.rs` |
| symbol | `cast_unchecked` |

A second accepted hit is `strict_cast` at rank 10 on the same path. The accepted owner has
`symbolRegex: null`, so strict rank 7 does not prove the curator symbol `Column::cast`. It proves a
symbol-level result in the accepted file. The rank-1 result is `get_polars_dtype` in
`py-polars/src/polars/catalog/unity/models.py`, which the per-case table shows as the top result.

### Capture C comparison

The comparison uses the same rubric and the first ten stored results, which is the like-shaped
window. C requested 20 and returned 10 of 20. Both sides are rescored with the current `scoreQuery`
and the current `cases.json`, so the p3 owner correction applies to both.

| Capture | hit@1 | hit@5 | hit@10 | MRR@10 | strict hit@10 | strict MRR@10 |
|---|---|---|---|---|---|---|
| C, current rubric | 13/28 | 21/28 | 22/28 | 0.580697 | 22/28 | 0.566808 |
| current runtime | 13/28 | 20/28 | 21/28 | 0.544983 | 20/28 | 0.533078 |

Five cases differ. The other 23 do not change place.

| repo | id | C rank / strict / granularity | current rank / strict / granularity |
|---|---|---|---|
| react | r8 | 2 / 2 / symbol | 1 / 1 / symbol |
| polars | p1 | 2 / 2 / symbol | 3 / 3 / file |
| polars | p2 | 2 / 2 / symbol | 3 / 3 / symbol |
| flatbuffers | f6 | 1 / 1 / symbol | absent / absent / - |
| flatbuffers | f9 | 2 / 9 / file | 3 / absent / file |

Capture C ran at parent `b26af3d16d6812ee6a787cbad73a09457fefa7d2` with request limit 20 and
`disclosureLimit` 10, and returned 10 of 20. This run used HEAD `11889927`, request limit 10, no
`disclosureLimit`, and returned 10 of 10. Capture C records no dist tree hash. The rubric is
identical, so the deltas are capture differences. This comparison does not attribute any delta to
quota-removal commit `11889927`, because source changes between `b26af3d` and `11889927`, the dist
rebuild, the request-limit change, and the new Publications all vary at the same time.

### Misses

| id | Recorded stage anchor | Best recorded | Grouped |
|---|---|---|---|
| r1 | no recorded stage contains the owner | unknown | absent |
| r3 | 110 at `mcp_filtered` (primary), then 60 provider, 62 fusion | 19 at grouped | 19 |
| f3 | last inside 10: 1 at `raw_lexical` (primary); next 20 at `core_fusion` | 1 at `raw_lexical` | 12 |
| f5 | no recorded stage contains the owner | unknown | absent |
| f6 | 70 at `raw_dense` (primary); next record 152 at `mcp_replay_signals` | 70 at `raw_dense` | absent |
| f7 | last inside 10: 6 at `mcp_pass` (primary); next 11 at `mcp_fusion` | 6 at `mcp_pass` | 53 |
| f10 | last inside 10: 3 at `mcp_pass` (expanded); next 15 at `mcp_fusion` | 1 at expanded lexical fallback | 20 |

The stage anchor is the earliest recorded rank outside the top ten, not a causal mechanism. Recorded
ranks are not output cutoffs, and reranker input ranks are not output cutoffs. A capped list that
does not contain the owner does not prove retrieval never produced it. For r1 and f5 the mechanism
is unknown: no recorded stage contains an accepted owner chunk.

### Reranking and publications

Reranking ran on every query. Telemetry records 28 events, 28 attempts, 28 calls, and 9 lateon
initialization lines for the three repos. Candidate counts range from 80 to 128 and the provider
returned no error line. These events prove the local reranker ran. They do not prove which rank move
each query's owner took.

| repo | publication dir id | generation id | files | created (UTC) |
|---|---|---|---|---|
| react | `4ae4832c56ac2f9074d85bcdc81403a079bb4565bf48f3fca06c73c3bd2800df` | `c86a8e70-3246-49c0-8444-dd033f6fca35` | 6852 | 2026-10-24T07:01:29.027Z |
| polars | `909de36b82a8134e4412fad44aa74540bd71bacc4811b745db224433618b5ed4` | `39cf0bd2-4514-4144-816d-1913d8e6d1b6` | 3285 | 2026-10-24T07:03:46.692Z |
| flatbuffers | `534ff052ff8f0126be4063fcd438362eb9a3a1ea82abc9b4050d0c8b7edcc533` | `4848d46b-414b-4f20-af8b-9b75fda878c6` | 1527 | 2026-10-24T07:05:16.457Z |

### Retained state and artifacts

The retained state is `/tmp/satori-baseline-reconciliation-20261024/live-state`, 1,628,369,050 bytes
(1.52 GiB). It holds the three Publications and the LanceDB vector state, kept so these 28 scores
can be re-read without re-indexing. Do not delete it before the parent accepts this baseline.

Artifacts under `/tmp/satori-baseline-reconciliation-20261024/live-out`:

- `result.json`, sha256 `20e64251ee4f4f972d90af6a5e4aaa48df69d93a307fe0414670892519990b64`
- `analysis.json`, sha256 `13faf47cb98ef60ec9773cbe1f2bdec3049fbcc34307a7b4986de7400bd2c92a`
- `analysis.md`, sha256 `a9614cfb3755f75b6d4c36ec385d3e5d078757f37e7ed9a88c97f0af86d76178`
- `preflight.json`, sha256 `681429d234b27bcc422987de74cd952ee974254f2d78a3fc69249c95739b49e1`
- `postflight.json`, sha256 `a2d51da23cf768c24b2ff357664dc173dc433ce986389222923a408115ad6c7c`
- `execution.json`, sha256 `05f5cbf6173ecf5ac0899c66d0242e1700b2d8f7bb52c0a88f5167d750480869`
- `harness-log.json`, sha256 `3557d399884b01bd3e56811fb697cb2eefbba9a1fa59bcaf0ec4ab80fe7ca8e4`
- `fused-pool.json`, sha256 `7f880834b374c8e7395a95b1148f9aa6eb811b6fddbb624c4e5b6e78298580ac`
- `scripts/analyze.mjs`, `scripts/preflight.mjs`, `scripts/run-sample.mjs`

### Limitations

- `packages/mcp/src/core/search-rerank-document.test.ts` and
  `packages/mcp/src/core/search-rerank-projection-primitives.ts` changed at 12:35:38 local time,
  while the run was active (12:30:36 to 12:36:10). The change adds Swift standalone-attribute
  handling in `firstStructuralDeclaration`. `packages/mcp/dist` was rebuilt at 12:38:04, after the
  run. The measured bytes are the preflight dist trees. The current mcp dist tree is
  `bd6d7f25145b8856f925bd422afb2df4fb365577c9cc39fbe0a6ef335448cd9f`, so it differs from capture.
  Post-run HEAD is `118899275f2c1f62ada97eecb3dfcc2c90528848` (unchanged), status sha
  `606d9a7e48e37bc352a11fc12b6acdb36266d900f34386e296e5a71466fff2c9` over 18 entries, and tracked
  diff sha `1189d7822e4e5ae4bd828194af68dd6df2841f88d75d971159d03ed6e5345ead`. No re-run or rebuild
  was authorized.
- One run only. There is no repeat measurement, so run-to-run variation is unknown. Load average
  rose from 0.42 to 7.56 during the run.
- Stage anchors come from capped harness lists and do not prove a mechanism. r1 and f5 remain
  unknown.
- The strict metric does not prove a curated symbol match when `symbolRegex` is null.
- The C comparison cannot separate the quota-removal commit from the other capture changes listed
  above.
- `run.mjs` has no `disclosureLimit` option. The effective request limit is the committed `topK`
  10. A limit-20 comparison would need a temporary case copy and a separate disclosure setting.

### Checks

- `git diff --check` exits 0.
- This document is the only file this slice wrote. The other status entries predate the run or come
  from the external mcp edit above.
- `analysis.mjs` recomputes all 28 scores and matches the stored scores.
- All 28 queries have the expected id and `status: "ok"`. Freshness skips and protocol errors are
  empty.
- The reranker executed 28 times and left no error line.
- No background process, index build, rebuild, model download, or paid call remained after the
  slice.

### Next falsifiable hypothesis

f6 is the sharpest bounded case. `GenTable` in `src/idl_gen_cpp.cpp` appears at `raw_dense` rank 70
of a recorded 80, then is absent at `core_fusion` (80 recorded), `mcp_fusion` (132), reranker input
(128), and grouped (144). The recorded drop is between the dense list and core fusion.

Hypothesis: the owner enters the dense candidate list, but fusion does not carry it into the
recorded fused 80, either because the fusion input excludes part of the dense list or because its
fused score falls below the 80th entry.

Falsifying check: replay the saved f6 payload with no search call. Confirm whether the owner chunk
id is present in the saved dense primary candidates. If present, inspect the core-fusion input and
output membership and, if the payload stores the fused score, compare that score with the cut
score. If the owner is absent from the saved dense candidate payload, stop: the drop precedes
fusion and the fusion-cap hypothesis is false. If the payload has no fused score for the owner,
report that the saved data cannot separate the two mechanisms. Record the membership result and any
score at the cut. Do not change ranking code in this slice.

The missing-owner class (r1, f5) has higher plan priority, but no recorded stage identifies a
boundary, so it has no bounded falsifier yet. The f7 case remains the documented next candidate in
the previous section.

## f6 frozen diagnosis, 24 October 2026

Status: diagnosis only. This slice changed no ranking code, test, case, index, dist, or
Publication. It confirms the previous fusion hypothesis, identifies the current-versus-C
difference, and records one falsifiable repair hypothesis. It does not implement the repair.

### Result

The previous section asked whether fusion drops the owner because its input excludes part of the
dense list or because its score is below the 80th entry. The replay selects the second branch:
the dense input contains the chunk, and its fused score is below the cut. That branch is also true
in capture C, so it does not explain the current miss by itself.

The current-versus-C difference is the file-symbol supplement. C re-admits the whole `GenTable`
symbol as a derived candidate; the current declaration lane never reads `src/idl_gen_cpp.cpp`.
The reranker is not the first failing stage. The fusion drop is contract-defined and occurs in
both captures.

### Identity

| Field | Value |
|---|---|
| query | `where does the C++ generator emit code for a table` |
| accepted path | `^src/idl_gen_cpp\.cpp$` |
| accepted symbol | `GenTable` |
| curated evidence | `src/idl_gen_cpp.cpp:132 class CppGenerator; :3046 void GenTable(const StructDef&)` |
| exact owner | `GenTable`, `syminst_453c42f2e1d628e78a9c9a7452dcb21f`, method, span `3046-3236` |
| regex sibling | `GenTablePost`, `syminst_34c252e2c5ee728a310640696306507a`, method, span `3968-4127` |
| owner chunk | `chunk_e7380f568c174477`, span `3103-3176`, raw dense rank `70`, score `0.4449169635772705` |
| current f6 | no `GenTable*` symbol; `rank: null`, `strictRank: null`; top result `NewCppCodeGenerator` at `4609-4611` |
| C f6 | rank 1 `GenTablePost`; rank 2 `GenTable`; rank 3 `GenNativeTable` |

The curation regex `GenTable` also matches `GenTablePost`. C's regex-accepted rank 1 is the
sibling; the exact curated owner is rank 2. The report's C rank 1 remains correct for the rubric.
The current response contains neither symbol.

### Recorded stage trace

| Stage | Pass | Entries | Owner |
|---|---|---:|---|
| `raw_dense` | `attempt:1/primary` | 80 | rank 70 |
| `raw_lexical` | `attempt:1/primary` | 0 | absent |
| `raw_lexical_fallback` | `attempt:1/primary` | 80 | absent |
| `core_fusion` | `attempt:1/primary` | 80 | removed, `core_fusion_limit` |
| `raw_dense` | `attempt:1/expanded` | 80 | absent |
| `core_fusion` | `attempt:1/expanded` | 80 | absent |
| `mcp_pass` | `attempt:1/primary` | 80 | absent |
| `mcp_pass` | `attempt:1/expanded` | 80 | absent |
| `mcp_pass` | `attempt:1/symbol_metadata_bm25` | 12 | absent |
| `mcp_fusion` | `attempt:1` | 132 | absent |
| `mcp_filtered` | `attempt:1` | 145 | absent |
| `mcp_replay_signals` | `attempt:1/replay:1` | 160 | rank 152 (diagnostic only) |
| `reranker_input` | - | 128 | absent |
| `reranker_provider_output` | - | 128 | absent |
| `reranker_fusion_output` | - | 128 | absent |
| `reranker_output` | - | 128 | absent |
| `mcp_ranked` | - | 145 | absent |
| `grouped` | - | 144 | absent |
| `disclosed` | - | 10 | absent |

The removal list records the exact drop in both the current and C responses:

```
candidateId: chunk_e7380f568c174477
afterStage:  core_fusion
reason:      core_fusion_limit
passId:      attempt:1/primary
```

The `mcp_replay_signals` stage is a 160-entry diagnostic replay, not the product path. Its rank
152 shows the owner remains available to a wider diagnostic pool. The product path never carries
it after `core_fusion`. Every stage used above records `omittedOccurrences: 0`, so the recorded
absences are complete for their stage definitions.

### Core fusion replay

The replay reads the saved f6 response and the saved dense and fallback payloads. It applies the
current fusion contract: RRF `k = 100`, per-owner deduplication, descending score, then the
product limit of 80. The saved fused list has 80 entries; the replay reproduces its set, order,
and all 80 scores exactly.

| Quantity | Value |
|---|---|
| dense arm | 80 chunks, 71 unique owners |
| fallback arm | 80 chunks, 30 unique owners |
| union | 101 unique owners, no overlap |
| fused limit | 80 |
| owner dense rank | 70 (chunk), 62 (unique owner) |
| owner score | `1 / 162 = 0.006172839506172839` |
| cut candidate | `chunk_cb209c1039a8f0e1` |
| cut score | `1 / 150 = 0.006666666666666667` |
| owner union rank | 92 of 101 |

The arithmetic is the whole mechanism. The 30 fallback-only owners score `1/101` to `1/130`.
The top 50 dense owners score `1/101` to `1/150`. Those 80 owners fill the slice. The owner is
the 62nd dense owner, so its score is `1/162`, below the cut. The owner is in the dense arm and
absent from the fallback arm, so it has one contribution only.

No implementation error is involved. `packages/core/src/core/vector-candidate-fusion.ts:12` sets
`k = 100`, lines 99-112 deduplicate by owner, line 115 computes `1 / (k + rank)`, and line 157
slices at `input.limit`. The limit chain is `SEARCH_MAX_CANDIDATES = 80`
(`packages/mcp/src/core/search-constants.ts:18`) -> `candidateLimit`
(`packages/mcp/src/core/search-policy.ts:66`) -> `topK`
(`packages/mcp/src/core/search-retrieval-passes.ts:110`) -> `limit`
(`packages/core/src/core/semantic-search-service.ts:743`) -> `slice(0, input.limit)`.

### Supplement replay

The supplement reads the 132 `mcp_fusion` candidates, takes the first three distinct files as the
retrieval lane, then selects three declaration files. It reads only files whose source hash
matches the Publication and emits only symbols whose source body passes the evidence rule.

| Variant | Declaration lane | Emitted | New extras | Saved match |
|---|---|---|---:|---:|---|
| current | `include/flatbuffers/code_generator.h`, `tests/namespace_test/NamespaceA/TableInC.cs`, `tests/monster_test_suffix/ext_only/monster_test_generated.hpp` | 18 | 13 | current `mcp_filtered` 13/13 |
| pre-`11889927` | `tests/monster_test_suffix/ext_only/monster_test_generated.hpp`, `src/idl_gen_cpp.cpp`, `src/idl_gen_dart.cpp` | 20 | 17 | C `mcp_filtered` 17/17 |

The retrieval lane is `src/idl_gen_csharp.cpp`, `src/idl_gen_csharp.h`, and
`include/flatbuffers/code_generator.h`. The current declaration ordering is:

| File | Context | Declaration matches | Emitted |
|---|---:|---:|---:|
| `include/flatbuffers/code_generator.h` | 2 | 7 | 0 |
| `tests/namespace_test/NamespaceA/TableInC.cs` | 2 | 5 | 0 |
| `tests/monster_test_suffix/ext_only/monster_test_generated.hpp` | 0 | 29 | 16 |
| `src/idl_gen_cpp.cpp` | 0 | 19 | not read |
| `src/idl_gen_dart.cpp` | 0 | 8 | not read |

`code_generator.h` is already in the retrieval lane, so its declaration slot adds no new file.
`TableInC.cs` emits no source-backed symbol. The only file that contributes new extras is the
test fixture. The implementation file that owns the curated symbol is fourth.

The saved lexical terms include `c++`. `normalizedTerms` turns `c++` into `c`, so the whole-term
set is `[c, generator, emit, code, table]`. `TableInC.cs` matches `table` and `c` in its path and
gets context 2. `src/idl_gen_cpp.cpp` matches none of the terms in its path and gets context 0.
The context-first sort on line 45 therefore places the test file above the implementation file.

The pre-`11889927` variant reconstructs the old sort, source-body rule, and six-symbol-per-file
cap. It reads `src/idl_gen_cpp.cpp` and emits `GenTable` (`3046-3236`) and `GenTablePost`
(`3968-4127`). The per-file cap removal in `11889927` is not the exclusion cause: the old cap
still emits `GenTable`. The declaration file selection is the stage-level cause.

The current `mcp_filtered` has 145 entries: 132 fused plus 13 monster_test extras. C has 149:
132 fused plus 17 extras (6 monster_test, 6 `idl_gen_cpp`, 5 `idl_gen_dart`). C's `GenTable`
entry is:

```
candidateId: derived:["src/idl_gen_cpp.cpp",3046,3236,"cpp"]
candidateIdKind: derived
ownerId: ["symbol","src/idl_gen_cpp.cpp","syminst_453c42f2e1d628e78a9c9a7452dcb21f"]
rank: 143
score: 0
```

The current response has no such entry. Its 13 derived extras are all from
`tests/monster_test_suffix/ext_only/monster_test_generated.hpp`.

### Invariant and owner

The supplement's stated contract has three parts:

1. The retrieval lane preserves the first three distinct files.
2. The declaration lane adds bounded files outside that lane so precise generator symbols remain
   discoverable.
3. Every emitted symbol must have source evidence whose hash matches the Publication.

The current code keeps the per-lane bound but does not meet the second part for this query. It
selects from all candidate files, and one selected file is already in the retrieval lane. The
lane therefore adds at most two new files, and the file that owns `GenTable` is not read. The
mismatch is between the comment's declared intent
(`packages/mcp/src/core/search-file-symbol-supplement.ts:38-40`) and the selected files.

Owner: `packages/mcp/src/core/search-file-symbol-supplement.ts`, function
`supplementSearchFileSymbols`, `declarationFiles` selection at lines 41-47. Commit `11889927`
changed line 45 from matches-first to context-first. The per-file cap removal in the same commit
is not the exclusion cause. The fusion cap is not the owner: it drops the chunk in both captures,
and its replay is exact. Downstream admission
(`packages/mcp/src/core/search-execution.ts:1135-1160`) adds every supplement that passes
`evaluateCandidate`, with no per-request cap, so a `GenTable` emission would reach
`mcp_filtered`.

### Falsifiable repair hypothesis

Filter the retrieval-lane files out of the declaration candidate set before the sort and
`slice(0, MAX_FILES)`:

```ts
const declarationFiles = [...new Set(input.candidates.map((candidate) => candidate.relativePath))]
    .filter((file) => !files.includes(file)) // the only change
    .map(/* existing context and matches mapping */)
    .sort(/* existing context-first comparison */)
    .slice(0, MAX_FILES).map(({ file }) => file);
```

The lane then adds up to three new files. For f6, the new declaration top three are
`TableInC.cs` (context 2), the monster_test fixture (29 matches), and `src/idl_gen_cpp.cpp` (19
matches). `src/idl_gen_cpp.cpp` is read. The pre-`11889927` replay shows that its source hash
matches and that it ranks 27 symbols, including `GenTable` at `3046-3236`. The current emission
loop has no per-file cap, so it would emit all 27, including the derived candidate
`derived:["src/idl_gen_cpp.cpp",3046,3236,"cpp"]`.

This hypothesis does not claim the final rank. The current monster_test emission is 16, not 6,
so the derived candidate would sit later than C's rank 143. Reranker admission and rank need a
separate measurement.

### Smallest next experiment and stopping condition

Use a `/tmp` copy of the supplement replay. Add the filter above; do not edit production. Run the
same frozen inputs. Pass when all four conditions hold:

1. The control (unfiltered) still reproduces the saved 13 extras and excludes
   `src/idl_gen_cpp.cpp`.
2. The filtered run lists `src/idl_gen_cpp.cpp` in its considered files.
3. The filtered run emits `derived:["src/idl_gen_cpp.cpp",3046,3236,"cpp"]` with owner
   `syminst_453c42f2e1d628e78a9c9a7452dcb21f`.
4. The unfiltered run fails condition 3.

If the filtered run does not emit `GenTable`, stop: the hypothesis is false. If it emits the
candidate but the candidate is absent from `reranker_input`, the file-selection hypothesis is
supported only at the supplement stage. The next question is then reranker input capacity, not
this lane.

### Limits of the evidence

- The frozen f6 response was produced by the current-runtime preflight dist: core
  `1eb46b943397568b253f26a2cc44610671495c40a4fbc47a4f5c87b824f91508`, mcp
  `38ebb8f7a4e77920ef05a01ce6a99b5e7d0b02489ad911c7b7fa49b34fd81dd8`, cli
  `d7807f00b78ae69844e2f6b3ccab93d9004d436fbd819cc6f18273a63ecff34d`. The current on-disk
  dist is core `023d95a530c1816d26903ad22c8086a4d510af1ff9902915b2f19358e254b774`, mcp
  `b872d1001b10460864bd94d27895bdec3c4f1afecbcc87dd01b3e7dbb1d3445a`, cli
  `d7807f00b78ae69844e2f6b3ccab93d9004d436fbd819cc6f18273a63ecff34d`. The supplement source
  is unchanged in the working tree, and the current replay reproduces the saved 13 extras
  exactly. Capture C records no dist tree hash, so no byte-level dist comparison with C is
  possible.
- C ran at parent `b26af3d16d6812ee6a787cbad73a09457fefa7d2` with request limit 20 and
  `disclosureLimit` 10. The current run used HEAD `118899275f2c1f62ada97eecb3dfcc2c90528848`
  with request limit 10 and no `disclosureLimit`. The supplement replay uses the current
  Publication symbol shards and the pinned source tree
  (`c2483c448ec6980127960fb0205c7c756750171d49b1d7444322f54ab5f9c748`, 2320 files). It
  reproduces C's 17 extras exactly. It does not reproduce C's embeddings, ANN, or reranker bytes.
- C's rank 1 is `GenTablePost`, which the regex accepts; the exact curated `GenTable` is rank 2.
  The current response has neither.
- One run only. The C reranker promoted `GenTable` from input rank 122 to output rank 2. This
  does not prove the current reranker would do the same.
- The `b26af3d` source and dist bytes are not replayed. The pre-`11889927` variant reconstructs
  the old selection and six-symbol cap from the commit diff and the saved C response.

### Checks and artifacts

- `git diff --check` exits 0.
- The document is untracked, so `git diff --check` covers the tracked tree. A trailing-whitespace
  scan of the appended section found none.
- This document is the only file this slice wrote. The other status entries predate the slice.
- No search call, model call, install, build, index write, or state deletion ran. The replay
  scripts read saved JSON and pinned source files only.
- `verify-owner-identity.mjs` passes its identity assertions, including the exact spans and the
  absence of a `GenTable*` symbol from the current 10 results.
- `replay-core-fusion.mjs` passes set, order, and score assertions for the saved 80.
- `replay-file-symbol-supplement.mjs` passes both extra-set checks: current 13/13, C 17/17.
- `replay-core-fusion-capture-c.mjs` passes set, order, score, dense-presence, and fused-absence
  assertions.

Artifacts in `/tmp/satori-f6-frozen-diagnosis-20261024`:

| File | sha256 |
|---|---|
| `verify-owner-identity.mjs` | `48fb8a02f14610868819929fb1befa340c6ac5721780e3482c1f171f4336ced4` |
| `owner-identity.json` | `6e6b03cfad7a9b2373688fa7546d688c3d7d531598a981001994ce90f91f475b` |
| `replay-core-fusion.mjs` | `86ddff2cdb8717555aed18991eec25a3596c5481f53a6b23580fff65836b8e41` |
| `replay-core-fusion.json` | `4d92c0192c0c6a815c6f59d4b65700d48f66ff5fb9b7e61ccba65bbd3416cec2` |
| `replay-core-fusion-capture-c.mjs` | `715e619a7f313561033230f4852f2e3502d0cc0beb44b5734a27009048af4235` |
| `replay-core-fusion-capture-c.json` | `685f9b5f952ff480c9359b9965c44585121bcc9f64c6fd2817f0aaf1a5cabc3f` |
| `replay-file-symbol-supplement.mjs` | `fb82aa577c7c1c7c8b47cd97eb4806e0237dea4f58d94b8f72d8c70905e5b9c3` |
| `replay-file-symbol-supplement.json` | `71dde73e381c20d366c5ad2810c4ac7fd61236fb75dffeedacfe998f30191544` |
| `source-tree-hash.json` | `924ab3c79965662813786e16dc3bf6ac5692d5b88f3c21d019740be72fe991ee` |

Frozen inputs: `result.json`
`20e64251ee4f4f972d90af6a5e4aaa48df69d93a307fe0414670892519990b64`; C response
`fe3437f15f12a0beb4642e3be9d7caa0fbb7e2701a417204204d60076d02100c`.

Commands:

```
node /tmp/satori-f6-frozen-diagnosis-20261024/verify-owner-identity.mjs
node /tmp/satori-f6-frozen-diagnosis-20261024/replay-core-fusion.mjs
node /tmp/satori-f6-frozen-diagnosis-20261024/replay-file-symbol-supplement.mjs
node /tmp/satori-f6-frozen-diagnosis-20261024/replay-core-fusion-capture-c.mjs
node /tmp/satori-f6-frozen-diagnosis-20261024/tree-hash.mjs /home/hamza/.cache/satori-eval-repos/flatbuffers@b8431fbcd7a5
```

## f6 disjoint declaration lane, 24 October 2026

Status (historical at this stage, 24 October 2026): frozen experiment, followed by an implementation
that was uncommitted at this stage. The implementation is now committed as `6b31381b`; see
"Current state after f6". The experiment changed no
production code, test, case, index, dist, or Publication. The section records one falsifiable
experiment and the brief that was later implemented. Measured validation follows under
"End-to-end paired validation".

### Decision

Supported with bounded risks at the supplement stage. On the frozen f6 input, the actual
production supplement source with one added filter emits the curated owner `GenTable`
(`syminst_453c42f2e1d628e78a9c9a7452dcb21f`, span `3046-3236`). The unmodified control does not
emit it. Across all 28 frozen queries, the variant adds 156 extra candidates, reads, and files. It
loses zero baseline candidates, outputs, or files. The initial three-file retrieval lane never
changes. The six-file bound, hash guard, span guard, duplicate-read check, and uncapped symbol
behavior all hold. Admission, reranker input, reranker output, and published hit@10 are not
measured.

### Method

The control is a byte-identical copy of
`packages/mcp/src/core/search-file-symbol-supplement.ts`
(`8101c4c355bc7555a85d97fad32d06c37dd550e2b5aff9a2e6f2111bd1f97f64`). The variant copy
(`596233255738290638b645cde943cbb74f221967af3cf2031ec049f74ef20394`) inserts one line after the
distinct-path collection and before the declaration `.map`:

```ts
.filter((file) => !files.includes(file))
```

The scoring map, sort, `slice(0, MAX_FILES)`, retrieval lane, result construction, and every
hash/span/source guard are unchanged. No filename check or new owner policy exists. The two copies
were imported as TypeScript modules and run through the real function with saved f6
`mcp_fusion` candidates, the frozen flatbuffers Publication symbol shards, and the pinned source
tree. The function's supported `readSourceEvidence` override reads the pinned bytes and mirrors the
production 256 KiB bound. Candidate projection keeps only fields the function reads. The registry
keeps the full manifest and loads shards only for candidate paths.

On f6, the control reproduces the saved `mcp_filtered` 13 extras exactly, by candidate id, owner
id, and span. It does not emit `GenTable`. The variant reads `src/idl_gen_cpp.cpp` and emits it.

| f6 item | Control | Variant |
|---|---|---|
| Retrieval lane | `src/idl_gen_csharp.cpp`, `src/idl_gen_csharp.h`, `include/flatbuffers/code_generator.h` | same |
| Declaration lane | `include/flatbuffers/code_generator.h`, `tests/namespace_test/NamespaceA/TableInC.cs`, `tests/monster_test_suffix/ext_only/monster_test_generated.hpp` | `TableInC.cs`, `monster_test_generated.hpp`, `src/idl_gen_cpp.cpp` |
| Evidence reads | 5 | 6 |
| Emitted results | 18 | 45 |
| New extras | 13 | 38 |
| Saved 13 extras | exact identity match | not compared to saved |
| `GenTable` | absent | emitted |
| Lost baseline outputs | - | 0 |

Variant identity:

```
candidateId:           derived:["src/idl_gen_cpp.cpp",3046,3236,"cpp"]
ownerId:               ["symbol","src/idl_gen_cpp.cpp","syminst_453c42f2e1d628e78a9c9a7452dcb21f"]
ownerSymbolInstanceId: syminst_453c42f2e1d628e78a9c9a7452dcb21f
span:                  3046-3236
contentBytes:          6806
contentSha256:         03ca93303b02c1a4bc611ef7d49fb991ec215f91dee2dbde0b9c7122b1764d81
source/manifest hash:  a0f90bc0258d37f302393670adba21b2e01cf26b1268c7be2b400b3bb7555bb8
sourceBytes:           173991
```

The variant also returns two fusion candidates from `src/idl_gen_cpp.cpp` as existing identities
(`chunk_18e1586ecc313dcc` span `4609-4611`, `chunk_2c15ca3a780d098d` span `1190-1194`). They are
already in `mcp_fusion`, so they change no filtered set.

### Other 27 frozen queries

All repositories had a complete frozen Publication and a pinned source tree. The variant ran on
all 28 queries, not 27 only. Total fusion candidates: 3216. Total evidence reads (control plus
variant): 312. The control selected-file list is a prefix of the variant list on every query. The
filter therefore adds files and outputs and removes none.

| Quantity | Value |
|---|---:|
| Queries with added extra candidates | 10 |
| Queries with added reads only | 5 |
| Queries unchanged | 13 |
| Added extras | 156 |
| Lost extras | 0 |
| Lost outputs | 0 |
| Removed files | 0 |
| Duplicate reads | 0 |
| Six-file bound violations | 0 |
| Hash or span guard violations | 0 |

Changed candidate sets:

| Query | Focus | Added files | Added extras | Relevant target adds |
|---|---|---|---:|---|
| r1 | implementation | `packages/react/src/__tests__/ReactProfiler-test.internal.js` | 35 | 0 |
| r5 | implementation | `profilingCommitTreeBuilder-test.js`, `SidebarCommitInfo.js` | 1 | 0 |
| r9 | implementation | `packages/react-dom/src/__tests__/ReactCompositeComponentState-test.js` | 7 | 0 |
| p3 | neutral | `crates/polars-core/src/frame/column/scalar.rs` | 8 | 0 |
| p5 | neutral | `crates/polars-plan/src/plans/optimizer/predicate_pushdown/utils.rs` | 5 | 5 path owners |
| p7 | tests | `crates/polars-time/.../dispatch.rs`, `py-polars/tests/unit/operations/rolling/test_map.py` | 7 | 7 path owners |
| p8 | implementation | `crates/polars-python/src/interop/numpy/to_numpy_df.rs` | 6 | 6 path owners |
| f1 | implementation | `swift/Sources/FlatBuffers/FlatBufferBuilder.swift`, `tests/FlatBuffers.Test/FlatBufferBuilderTests.cs` | 61 | 0 |
| f4 | implementation | `java/src/main/java/com/google/flatbuffers/FlatBufferBuilder.java` | 1 | 0 |
| f6 | implementation | `src/idl_gen_cpp.cpp` | 25 | 25 path owners, 6 accepted symbols |

Read-only additions with no candidate-set change: r3, r6, p4, p9, f5. No query lost a file, an
extra, or an output.

The f6 accepted-symbol additions are `GenTable`, `GenTablePost`, `GenTableFieldGetter`,
`GenTableFieldType`, `GenTableFieldSetter`, and `GenTableUnionAsGetters`. The exact curated owner
is `GenTable` at `3046-3236`. p3, p5, and p7 are non-implementation queries, so the production
caller would skip the supplement for them. Their changed sets are counterfactual. r1, r9, and f1
add test-file extras, not curated owners. r5 adds one devtools-view extra. Admission may drop
those extras.

### Control fidelity and seam

Ten of 28 saved `mcp_filtered` extra sets equal the raw function output exactly. For the other 18,
the saved set is a strict subset of the raw output, and no saved identity is missing from the
control. The saved stage runs after `evaluateCandidate`, so the difference is caller admission,
not a function divergence. f6 is in the exact-match group at 13/13. Raw emission is therefore not
admission evidence.

### Limits

- The compiled dist is not executed. The saved responses came from a preflight dist whose hash
  differs from the current dist. The control still reproduces the saved f6 13 extras exactly.
- Candidates are projected to the fields the function reads. The registry loads shards only for
  candidate paths. The reader is the function's supported override, not its default reader.
- No admission, reranker, or published-output replay ran. The 18 strict subsets prove that
  admission removes raw emissions. `GenTable` admission and final rank remain unknown.
- The change adds extra candidates. On f6 the reranker input would gain 25 new extras. On f1 it
  would gain 61 test-file extras. Rank effects are not measured.
- The run used one frozen snapshot. On-disk source, test, and dist hashes were identical before
  and after the run.

### Proposed implementation brief, not implemented at this stage (historical)

This brief was implemented after the experiment. It is now committed as `6b31381b`.

Change `packages/mcp/src/core/search-file-symbol-supplement.ts` at the declaration selection
(line 41). Filter retrieval-lane files from the declaration candidate set before `.map`, sort, and
`slice(0, MAX_FILES)`. Keep `MAX_FILES = 3`, context/matches scoring, tie order, retrieval order,
the six-file total bound, the hash/span/source guards, and uncapped symbol emission.

Add focused tests in `packages/mcp/src/core/search-file-symbol-supplement.test.ts`:

1. Overlap case. The retrieval lane contains the first declaration-scored file. Assert the exact
   six selected files in order, one read per file, and a fourth declaration-supported file is
   read. Assert `GenTable` `syminst_453c42f2e1d628e78a9c9a7452dcb21f` at `3046-3236` is emitted.
2. Negative control. Three distinct candidate files produce three reads, not six.
3. Negative control. The overlapping retrieval file is read once and is not read again in the
   declaration lane.
4. Existing guards. Keep the hash-mismatch, path-context, six-file bound, and 180-symbol uncapped
   tests. Assert exact owner identity and span, not candidate counts.

Run the package test with the file path in place of the `test:raw` glob:

```
cd packages/mcp
node --import tsx --import ./src/test-state-root.ts --test \
  --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=8 \
  src/core/search-file-symbol-supplement.test.ts
```

Search hot-path validation after implementation: run one real f6 search through the MCP path.
Confirm the derived candidate `derived:["src/idl_gen_cpp.cpp",3046,3236,"cpp"]` reaches
`reranker_input` with the exact owner. Record evidence reads (must stay at six or fewer), latency,
and the reranker input and output. Evaluate hit@10 only from that run. This replay does not prove
it.

### Artifacts and checks

Artifacts in `/tmp/satori-f6-disjoint-lanes-20261024`:

| File | sha256 |
|---|---|
| `harness.mjs` | `cd96f9554f47214e11c7ca30c5705170ca2c08e8fedd621112c7d35ea5917124` |
| `evidence.json` | `da2070b12a5ac9446ad3ac14ed80779d39d0ac3e6ada52c146adbef15557c21d` |
| `summary.json` | `9093e3d705b4c7eb8803a87fac8f1322d7b7294725db70de681e7a579710c8a5` |
| `findings.md` | `9927c56412dc79c77963b45991f4893d0861a4f0bf061ed54f76df164a3c2be5` |
| `src/supplement-current.ts` | `8101c4c355bc7555a85d97fad32d06c37dd550e2b5aff9a2e6f2111bd1f97f64` |
| `src/supplement-variant.ts` | `596233255738290638b645cde943cbb74f221967af3cf2031ec049f74ef20394` |
| `src/current-source-symbols.js` | `e1194e3cb7d6c9b1cb4f4394ec1e6b1ff131223ddc07e0720126a45b3a75afa8` |

Frozen inputs: `result.json`
`20e64251ee4f4f972d90af6a5e4aaa48df69d93a307fe0414670892519990b64`; cases
`6144f67803cbd12f4bb19f5e57b776a4d4ae867f02feb7c24b71aa02c1e9be09`. Publications: react
`4ae4832c...`/`c86a8e70-3246-49c0-8444-dd033f6fca35`, polars
`909de36b...`/`39cf0bd2-4514-4144-816d-1913d8e6d1b6`, flatbuffers
`534ff052...`/`4848d46b-414b-4f20-af8b-9b75fda878c6`.

Checks: `node --check harness.mjs` passed. The TypeScript copies imported under `tsx`. The harness
exited 0 and printed `F6 DISJOINT-LANE ASSERTIONS PASSED`. `git diff --check` exited 0. A trailing
whitespace scan of this section found none. No search, model, index, build, install, commit, or
state deletion ran.

### End-to-end paired validation, 24 October 2026

Status (historical at measurement time): the brief above was implemented in the working tree and
uncommitted. It was later committed as `6b31381b`. This section adds measured
evidence to the frozen experiment. It changes no source, test, case, index, or Publication.

#### Setup and controls

The fixed variant is the current dist, built once with
`cd packages/mcp && node ../../node_modules/typescript7/bin/tsc --build` from
`packages/mcp/src/core/search-file-symbol-supplement.ts`
(`93ad6a8c8fda2c69f25d024613c51d5dfe56e864aedd19bd14e06760c6ee3304`). The build changed only the
supplement JS and maps, its compiled test, and `tsconfig.tsbuildinfo`. The supplement dist is
`ff20bf903aaea3ac384cee9966a3a5f38890c0044568fcb2dd0107b7450c014a`. The baseline is the same
file loaded through a process-local ESM hook that removes exactly one statement,
`.filter((file) => !files.includes(file))`. The hook matched 12 module loads, including all three
MCP servers and their workers, with zero failures. Its loaded hash is
`2879379f6a5940371f6f3ffc94b8934b93c02c269730ded2302d32e746998e49`. Removing the retained
explanatory comment line reproduces the pre-fix dist
`131a4ba6c8c795aa69ade9d4302558be2f1f124c96b410ce12554db8ccc674eb` byte for byte.

Both variants ran the unmodified harness with the same 28 cases
(`6144f67803cbd12f4bb19f5e57b776a4d4ae867f02feb7c24b71aa02c1e9be09`), topK 10, reservation policy
cap55, no flags and no alt terms. Both used `--reuse-index` and the same retained state root
`/tmp/satori-baseline-reconciliation-20261024/live-state`. Publication identities were react
`c86a8e70-3246-49c0-8444-dd033f6fca35`, polars `39cf0bd2-4514-4144-816d-1913d8e6d1b6`, and
flatbuffers `4848d46b-414b-4f20-af8b-9b75fda878c6`.

#### Quality result

All 28 queries in both variants returned `ok` with `freshness: verified`. Each variant made 28
reranker calls at limit 10; telemetry reports 28 searches, 28 reranker attempts, and candidate
counts from 80 to 128.

| Metric | Baseline | Fixed | Delta |
|---|---:|---:|---:|
| hit@1 | 12/28 | 13/28 | +1 |
| hit@5 | 20/28 | 21/28 | +1 |
| hit@10 | 21/28 | 22/28 | +1 |
| MRR@10 | 0.515221 | 0.550935 | +0.035714 |

The only accepted-owner change is f6. Baseline has no accepted owner and does not emit `GenTable`.
Fixed returns `GenTablePost` at rank 1, which matches the `GenTable` path/symbol regex, and exact
`GenTable` at rank 2. `GenTablePost` is not the curated owner; the hit@1 gain comes from the regex
acceptance. No query loses an accepted owner, and `regressions` is empty. Hit-set changes are
limited to p8, f1, and f6. p8 and f1 keep rank 1 and the same accepted owner, with lower top-10
composition changes only. Supplement additions rise from 446 across 44 paths to 490 across 47
paths, over 20 queries.

#### f6 exact identity chain

The exact `GenTable` owner (`syminst_453c42f2e1d628e78a9c9a7452dcb21f`, span 3046-3236) travels
through every stage:

| Stage | Rank | Evidence |
|---|---:|---|
| supplement / `mcp_filtered` | 150 | `derived:["src/idl_gen_cpp.cpp",3046,3236,"cpp"]` |
| `reranker_input` | 108 | candidate role `implementation`, document sha `33a1469c...` |
| reranker provider output | 6 | score 20.399763979021593 |
| reranker fusion output | 2 | score 20.399763979021593 |
| `reranker_output`, grouped, disclosed | 2 | `method GenTable`, exact lexical match |

The final output places `GenTablePost` (span 3968-4127) at rank 1 and exact `GenTable` at rank 2.
The chain proves identity through admission, reranker input, reranker output, grouping, and
disclosure. It does not make `GenTablePost` equal to `GenTable`.

#### Paired f6 latency

Five baseline/fixed pairs ran sequentially from 14:27:26 to 14:33:24 local time. Each run started a
fresh MCP server on the same Publication and ran only f6 through the same cases copy
(`/tmp/satori-disjoint-lanes-paired-20261024/f6-cases.json`), with every setting unchanged.

| Pair | Baseline query ms | Fixed query ms | Paired delta ms | Baseline wall ms | Fixed wall ms | Paired wall delta ms |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 6068.7 | 5859.1 | -209.6 | 36228 | 35444 | -784 |
| 2 | 5904.4 | 5952.8 | +48.4 | 35883 | 37128 | +1245 |
| 3 | 5450.5 | 5750.9 | +300.4 | 35202 | 35333 | +131 |
| 4 | 5410.9 | 5826.5 | +415.6 | 35478 | 35310 | -168 |
| 5 | 5268.7 | 5864.1 | +595.4 | 35159 | 35926 | +767 |
| median | 5450.5 | 5859.1 | +300.4 (+5.51%) | 35478 | 35444 | +131 |

The median row reports each variant's median and the median of the paired differences separately.
The paired median is not the difference between the two variant medians.

Peak process-tree RSS medians are 3063.1 MiB baseline and 2936.6 MiB fixed, a paired median delta
of -129.8 MiB. This is one snapshot on one host, so it is not a justified RAM-saving claim.
Host load before runs ranged 0.31-2.42, and available memory ranged 8.28-8.54 GiB.
Query time is the harness `search_codebase` call; wall time includes startup, freshness checks,
index reuse resolution, and teardown.

Startup dominates the wall time: wall minus query is 29.98 s median for baseline and 29.58 s for
fixed, or 84.5% and 83.5% of wall. The query call is 5.3-6.1 s. The fixed median query time is
300.4 ms (5.51%) higher, and the delta is positive in 4/5 pairs. Baseline query time spans 800 ms
(5268.7-6068.7 ms), while fixed spans 202 ms (5750.9-5952.8 ms). The five-pair sample is too small
to separate a small real cost from run-to-run drift. It is not enough evidence to accept or reject
a small real cost, and it does not prove a regression or its absence. Do not record the delta
as proof of no effect. Keep the +5.51% median as an unresolved cost note: the extra
candidates can add admission and rerank work. The wall medians differ by 131 ms on a
startup-dominated base, so this sample does not resolve wall-time cost. Future comparisons must
report the query call separately, because startup hides it.

Command per run:

```
node /tmp/satori-disjoint-lanes-paired-20261024/scripts/run-variant.mjs \
  --variant baseline|fixed --cases /tmp/satori-disjoint-lanes-paired-20261024/f6-cases.json \
  --out /tmp/satori-disjoint-lanes-paired-20261024/latency/pairN-VARIANT \
  --hook-log /tmp/satori-disjoint-lanes-paired-20261024/raw/hook-latency-pairN.jsonl
```

The wrapper passes the unmodified harness `--repos react,polars,flatbuffers --reuse-index
--state-root /tmp/satori-baseline-reconciliation-20261024/live-state`; the cases copy narrows
execution to flatbuffers f6.

#### Invariants

Across the 28-case runs and the latency runs, the Publication content tree stayed
`8019d7d1e2004b121e735a6105a0735ffd9bd35942b8a80fb89965d6afdafead`, the Publication stats
snapshot stayed `2ae131e7f91398011ca4984bd1d2b224a43ff08ac6fa2e919084e0d6823a1e34`, and the
vector stats stayed `13050752105fd42e2fe809b5f26d1b1e6327d804fdcc400b3c26bafc74598399`.
Every `current.json`, `publication.json`, `source.json`, and `ownership.json` hash is unchanged.
The source supplement, core dist tree (`1eb46b94...`), and mcp dist tree (`20d62a5d...`) are
unchanged. Dist freshness reports zero violations before and after.

`--reuse-index` still starts a freshness sync for each root. Logs show `[Context] ✅ No file changes
detected`, and no Publication or vector byte changed. The only state-root change is the timestamp
in `runtime-owner/owners.json`, whose owner list stays empty. The sync is a no-op, but it is part
of the measured wall time. No task background process remained, and `git diff --check` exits 0.

#### Artifacts

| File | sha256 |
|---|---|
| `raw/analysis.json` | `d138f507b7e446521c25af66d1929e7c54ace5d36e89408065f4f599e407d57a` |
| `raw/latency-summary.json` | `f12a1f0b035e52f79cac4bb6d897a952d8e781a3fe7242552266ec6278467225` |
| `f6-cases.json` | `c412d9941f76f023f7c06771dedc861751fca764a5d8f7931335835c1797a265` |
| `scripts/run-variant.mjs` | `f041ce4c6be2d9f2ff199ae6bdc2b23bc55b91e3435c1581a52fe9d5ea3da47b` |
| `scripts/baseline-supplement-hook.mjs` | `ee7dc4776e0b5f2402d76ccc45c99d2db49a5f2e9652abfaaaf476cf4e61c1f6` |
| `scripts/summarize-latency.mjs` | `112161ecc5b2d338bfc3abf9b2b4ad3e43108bf9f1883d53711e7f06fcdef72b` |

The 28-case raw runs are `baseline-out/` and `fixed-out/` under
`/tmp/satori-disjoint-lanes-paired-20261024/`. Preflight identity captures are
`raw/preflight-{before-build,after-build,baseline-before,baseline-after,fixed-before,fixed-after}.json`.
Five paired f6 runs (ten invocations) and their execution records are in `latency/`.

#### Limits

- One Publication snapshot and one host. The latency sample has five pairs on one query. It cannot
  detect a difference below the observed run-to-run spread.
- The baseline depends on a process-local loader hook. It proves the comparison only, not a
  shipped artifact.
- The 28-case run uses the user-modified cases file. This validation did not edit it.
- f6 rank 1 is `GenTablePost`. Exact `GenTable` is rank 2. Only the regex acceptance gains hit@1.
- Wall time is startup-dominated. The query delta is reported separately. The five-pair sample is
  small, and the observed +5.51% median is an unresolved cost. It does not establish that no
  regression exists.
