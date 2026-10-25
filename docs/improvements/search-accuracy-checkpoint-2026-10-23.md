# Search accuracy: investigation checkpoint, 23 October 2026

Status (historical, 23 October 2026): two bounded fixes were integrated and checked. The remaining
search misses stayed open. No complete-set production accuracy gain existed at that date.

Current status (24 October 2026): quota removal is committed as `11889927`. The Swift signature
and grouped-owner repairs are committed as `cc9651b8`. One live f9 check after those repairs
returns the exact owner at visible rank 4. The complete 28-query effect is still unmeasured. The
p3 acceptance later added `crates/polars-core/src/frame/column/mod.rs`; the resulting score change
is rubric-only. Historical statements below keep their dates. `/tmp` evidence paths are local
transient artifacts, not versioned; raw reproducibility may be unavailable after cleanup.

Later status (25 October 2026, HEAD `fb125738`): `0a2aa66c` makes definition fusion match
inflected query words, and `fb125738` sends Voyage the canonical projection. The same 28-question
set then measures LateOn at hit@1/5/10 13/21/23 and MRR 0.5545, and Voyage `rerank-3-lite` at
22/26/26 and MRR 0.8452 (commit message of `fb125738`). Every table below is the `b26af3d1`
capture, scored with the pre-`5f96827c` rubric and the pre-`0a2aa66c` fusion rule. Its hit@10 is
therefore two lower than the current build.

## Intent and current state

Hamza requests continued investigation of f1 and related search failures.
He authorizes targeted fixes through medium-effort `gpt-6.1-sol` workers.
He also requests this durable record before session usage ends.

Parent checkout: `/home/hamza/repo/satori`, branch `master`.
Baseline HEAD: `b26af3d16d6812ee6a787cbad73a09457fefa7d2`.
The two existing changes under `issue-visualiser/` belong to earlier work. Preserve them.
Do not commit, rebuild indexes, install dependencies, or change the oracle.

The original budget improvement already exists in commit `26eba5c8`.
Commit `fcf5db5a` changes default disclosure to twenty results.
The older brief incorrectly says the current default remains ten.

## Checked findings

The saved baseline contains 28 questions, not 76.
React contributes nine, Polars nine, and FlatBuffers ten.
Overall hit@10 is 21/28. Strict symbol hit@10 is 20/28.
FlatBuffers f1 passes both scores at rank one. It is not a current failing question.
The f9 file hit accounts for the difference between overall and strict counts.

Baseline evidence: `/tmp/orch/bench/quality/result.json`.
The requests use `limit=10`, full debug, and diagnostic candidate depth 80.
They supply no disclosure override or caller alternative terms.
All 28 requests apply reranking.

| Question | Observed boundary |
|---|---|
| r1 | Indexed acceptable owners never enter the recorded retrieval arms. |
| r3 | Recovery admits the real comparator. Provider rank 60 becomes grouped rank 19. Disclosure records the file cap. |
| p3 | The accepted cast.rs path reaches reranking, then grouped rank 40. |
| f3 | StartVector enters lexical rank 1. Provider rank 91 becomes grouped rank 14. |
| f5 | Acceptable owners exist, but retrieval misses them. Neutral focus excludes source recovery. |
| f7 | ParseField and ParseAnyValue identities are absent. ParseEnum exists but retrieval misses it. |
| f9 | The intended string create enters expanded lexical rank 52. Core fusion removes it. |
| f10 | requestCapacity reaches provider rank 14. Definition fusion lowers it to grouped rank 20. |

The intended f9 string method differs from regex-accepted `createShared` and `createVector`.
The unchanged oracle uses unanchored `create`. Do not tighten it to claim a search improvement.
The f7 oracle accepts ParseAnyValue, ParseField, or ParseEnum. It does not name ParseRoot or SerializeRootFile.

Detailed checked evidence lives in `/tmp/orch/resume/stage-synthesis/{report.md,evidence.json}`.
The synthesis joins indexed symbol identities instead of trusting display labels.

## Invalid earlier comparisons

S2's probes rerank only one of eight questions. The saved baseline reranks all 28.
S2's probe drops the freshness envelope and other parts of the full response.
Its ranks cannot establish a regression or improvement against the baseline.
The served-previous-generation guard explains the observed skip pattern, but historical freshness remains unknown.

S8's earlier baseline recheck requests twenty results without an explicit disclosure override.
It returns twenty. Its f3 and f10 rank-fourteen matches are not hit@10 gains.
Scoring only its first ten results reproduces all 28 original score objects.

The capture auditor checks source, runtime, model, oracle, and Publication identities.
Before the fixes, source and runtime hashes match the saved baseline.
The accepted source changes follow that audit. The old capture does not measure their search behavior.
Audit evidence: `/tmp/orch/resume/capture-audit/{report.md,audit.json}`.

## Harness defect and checked fix

`buildFusedPoolEntries` joins grouped labels to fusion candidates using candidate ID alone.
Grouping can retain that ID while replacing its owner and source span.
The sidecar then attaches a later symbol name to an earlier source location.

The actual r3 candidate is `chunk_147219204377335a`.
Its fusion span is 2769–2781. Its grouped comparator span is 456–503.
Both its owner identity and source span change between those stages.

Responsible code: `evals/real-repo-quality/harness-logger.mjs`, function `buildFusedPoolEntries`.
The integrated patch requires equal candidate ID, owner ID, path, and start/end lines before copying a grouped label.
Absent matches retain an empty symbol. Ranking, scoring, admission, and the output shape remain unchanged.

Worker checkout: `/home/hamza/.t3/worktrees/satori/t3-3eedd4f8`.
Branch: `fix/fusion-stage-identity`. Two files change, including focused regression tests.
The parent runs all 26 harness tests. All pass, including both new regressions.
Replaying all 28 saved responses checks 2,240 sidecar rows.
The fix rejects 365 label joins that lack matching stage identity.
Every non-label field remains equal to the original output.
Replay evidence: `/tmp/orch/resume/harness-real-capture-check.json`.
Focused command: `node --test evals/real-repo-quality/harness-logger.test.mjs`.

## C++ extraction evidence and checked fix

ParseField and ParseAnyValue have individually clean syntax nodes.
Their namespace ancestor contains a parse error and spans lines 30–1726.
The visitor's aggregate-error guard skips the entire namespace.
Responsible code: `packages/core/src/language-analysis/tree-sitter-adapter.ts`, function `extractSymbols`.

The local CBM checkout exists at `/home/hamza/repo/codebase-memory-mcp`, HEAD `3457b21b`.
Satori's copied extractor sources pin upstream `11b662f9`.
The vendored C++ semantic parser and scanner match the current local CBM files byte for byte.
However, Satori's C++ symbol analyzer uses `@vscode/tree-sitter-wasm` through its TypeScript adapter.
The CBM semantic grammar does not own this symbol-extraction path.
CBM's `cpp_branch_views` helper applies to Haskell, despite its filename. It does not repair this C++ case.

The integrated patch permits recovery only with a clean named namespace header and real body delimiters.
It preserves the namespace path for clean children and suppresses the malformed namespace symbol.
Explicit error nodes, malformed callables, and uncertain namespace boundaries remain excluded.
The extractor identity changes from v22 to v23 because persisted symbols change.
Parser and dependency versions remain unchanged.

Worker checkout: `/home/hamza/.t3/worktrees/satori/t3-3662310b`.
Branch: `fix/cpp-namespace-recovery`. Three files change, including five regression cases.
The parent runs all 76 tests in the service file. All pass.
The parent also parses the pinned FlatBuffers `src/idl_parser.cpp` with both source versions.
Extracted symbol count rises from 87 to 120. These counts exclude the synthesized file symbol.
All 87 original symbols retain their kind, qualified name, and exact byte span.
The recovered methods include `flatbuffers.Parser.ParseField` at 919–1344 and `flatbuffers.Parser.ParseAnyValue` at 1362–1492.
Analysis remains recovered and publishes no call facts.
Real-source evidence: `/tmp/orch/resume/cpp-real-source-check.log`.
Recovering two symbol identities does not establish an f7 hit@10 improvement.

From `packages/core`, run:

```bash
node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/language-analysis/service.test.ts
```

## Rejected or unproved changes

Wider rerank budgets and larger family supplements show no demonstrated recovery for these failures.
Frozen output-cap replays at 3, 4, and unlimited recover none of the eight strict failures.
The apparent cap64 gain uses a probe that skips reranking. It does not isolate the reservation policy.
Current path penalties do not cause the checked owner losses.
Neutral source-recovery exclusion is explicit policy. No inspected contract proves that exclusion incorrect.
Candidate admission in a frozen replay does not establish a final quality gain.

## Completed flag comparison and resume references

The flag worker finishes baseline and three separate variants: symbol_metadata_bm25, neutral_owner_preference, and first_stage_owner_floor.
Requests use `limit=20`, `disclosureLimit=10`, no caller alternative terms, and unchanged Publications.
All four variants complete all 28 questions. No oracle ranks improve or regress.
Hit@1/5/10 remains 13/21/21 at `b26af3d1`. Strict MRR@10 remains 0.554762.
Each variant records 46 semantic attempts and 3,192 reranked candidates across its 28 calls.
The first two flags preserve visible order. The owner-floor flag changes eight result lists without changing oracle ranks.
No default flag changes are selected. No inference process remains.
Single-call durations are exploratory measurements, not performance medians.

Driver and outputs: `/tmp/orch/resume/flag-grid/`.
Read `summary.json`, `paired.json`, `identity.json`, and `final-check.json` for completed results.
All source, runtime, model, and Publication identities stay fixed throughout that comparison.

| Work | T3 delegated task ID |
|---|---|
| Flag comparison | `node:delegated-task:command%3Amcp%3A810b1914-ba1e-4b94-a8e5-291cf18d8c27%3Adelegate-task%3Asatori-20261023-resume-s8-grid` |
| Harness patch | `node:delegated-task:command%3Amcp%3A810b1914-ba1e-4b94-a8e5-291cf18d8c27%3Adelegate-task%3Asatori-20261023-fix-harness-stage-identity` |
| C++ patch | `node:delegated-task:command%3Amcp%3A810b1914-ba1e-4b94-a8e5-291cf18d8c27%3Adelegate-task%3Asatori-20261023-fix-cpp-namespace-recovery` |

Both implementers use `gpt-6.1-sol` at medium effort.
Separate specification and correctness reviewers pass both patches.
The parent applies both accepted patches without committing.
Focused ESLint and the core TypeScript check pass. The TypeScript check emits no build output.
The parent checks that the existing HTML edits remain byte-identical.
The two managed worktrees retain their reviewed patches. No commits or branch merges occur.
No index rebuild or end-to-end search-quality run uses the new extractor version.
Existing Publications therefore retain their previous symbols.
Further search work needs a controlled comparison before claiming that these extraction changes improve final ranks.
The `/tmp` evidence is local scratch data. This document retains the findings if that data disappears.

## Session lessons and deferred proposal

Context recovery prints oversized timeline records several times. Future resumes need filtered fields and bounded excerpts before displaying tool results.
The shared probe omits freshness and full request context. A future probe change can retain those fields to prevent comparisons across different search conditions.
That probe change remains a proposal. This session changes only the two reviewed defects and this checkpoint.

## Measurement run, 23 October 2026

Status: COMPLETE at 2026-10-23T14:07:09.727Z. Runtime build complete. The final pass contains all 28 queries.
This section records the start state so an interrupted run stays auditable.

Task identity: `node:delegated-task:command%3Amcp%3A810b1914-ba1e-4b94-a8e5-291cf18d8c27%3Adelegate-task%3Asatori-20261023-deepseek-v23-measurement-1`.
Model: `pi` provider instance, `opencode2api/deepseek-v4.1-flash-free`, thinking `high`.
The DeepSeek task failed with HTTP429 `FreeUsageLimitError`.
Fallback task: `node:delegated-task:command%3Amcp%3A810b1914-ba1e-4b94-a8e5-291cf18d8c27%3Adelegate-task%3Asatori-20261023-v23-measurement-codex-low-1`.
Fallback model: `gpt-6.1-sol`, `reasoningEffort: low`.
The saved preflight failed because the driver compared a full React HEAD with the short pin `7c6ac13e19fe`.
No index or quality result exists from that attempt. The completed build and saved artifacts remain available.

Hamza authorizes task-owned test indexes for this run.
That authorization supersedes the earlier blanket no-rebuild note for these three pinned checkouts only.
It does not authorize touching `/tmp/orch/state`, `~/.satori`, or any production index.

Fresh state and output root: `/tmp/orch/measurement-v23/`.
State root for this run: `/tmp/orch/measurement-v23/state`, created empty with no Publications.
Indexes are built there one repo at a time from the existing clean pinned checkouts.
No clone, checkout, fetch, `clear`, or state sync occurs.

Selected request shape matches the saved baseline: 28 unchanged questions, `limit=20`, `disclosureLimit=10`, full debug, diagnostic candidate depth 80, default flags, no caller alternative terms.
Publication IDs will differ from the baseline because extraction and index contents changed.
This is therefore not a same-Publication comparison.

Next investigation order, proposed and not measured:
1. The f9 core-fusion loss, via frozen-arm replay across all 28 cases.
2. The r1 and f5 projection-versus-query mismatch.
3. Low rerank scores.

The accepted insight stays "better evidence use within the current budget".
Raising the output count is not a quality repair, and the oracle is not changed after seeing results.
The parent separates retrieval, fusion, and rerank stages as IS / IS-NOT evidence and inverts assumptions before proposing repairs.

### Completed v23 measurement

The final pass uses HEAD `b26af3d16d6812ee6a787cbad73a09457fefa7d2` on `master`, plus the existing reviewed source changes.
Node is v24.19.0. The extractor identity is `language-analysis-v23` with the installed extended pack present.
The complete extractor, runtime, source, scorer, cases, model hashes, and resolved flags are in `/tmp/orch/measurement-v23/preflight.json`.
The final checks confirm those inputs stayed unchanged. Both dirty HTML files remain byte-identical.
No source, test, oracle, flags, installed runtime, pinned checkout, or previous index changes occur during this measurement.

Scratch orchestration corrections and interruptions:
- Resolve each short commit pin with `git rev-parse <pin>^{commit}`. Compare full HEADs against those pins and the recorded baseline session HEADs.
- The first resumed attempt completes React indexing, then fails its identity assertion before searching.
  The driver imports version constants without the installed extended-pack setting, while the MCP child uses that setting.
  The corrected driver reads the existing offline profile before importing version constants.
  The driver reuses the completed React Publication after checking its extractor identity.
- The next attempt calls r1, then fails before saving its response because the scratch driver omits the harness classifier injection.
  The driver now injects the same production classifier as `run.mjs`.
  The final pass calls r1 again. This extra interrupted call means the overall procedure contains 29 search calls, with 28 retained final responses.
  No score-directed rerun or parameter change occurs.
- The original scratch f7 summary expects display fields that the candidate records do not contain.
  Offline analysis uses `relativePath` and joins `ownerId` to sidecar `symbolInstanceId` instead.
  `/tmp/orch/measurement-v23/f7-check-driver.json` preserves the original derived summary.
- `/tmp/orch/measurement-v23/lane-metrics.json` restores lane metrics from saved responses using the unchanged harness.
  The driver's compact `lanes` fields are empty because its field names do not match the harness return shape.
  Stage counts and full responses remain available. These offline corrections make no search calls.

Scores, all denominators 28 (measured at `b26af3d1`, pre-`5f96827c` rubric, pre-`0a2aa66c` fusion):
- Ordinary hit@1/5/10: `13/21/21 → 13/21/21`.
- Ordinary MRR@10: `0.572619 → 0.575595`, delta `+0.002976`.
- Strict hit@1/5/10: `13/20/20 → 13/20/21`.
- Strict MRR@10: `0.554762 → 0.561706`, delta `+0.006944`.
- r2 ordinary and strict rank: `4 → 3`.
- f9 ordinary rank stays `2`. Strict rank changes from miss to `9`.
- The f9 rank-nine symbol is `createShared` at lines 738–747. The unchanged unanchored `create` regex accepts it.
- That strict-score gain does not establish recovery of the intended `create(string:)` method at lines 706–717.
- No rank regressions occur. The other 26 cases keep both ranks unchanged.
- Unchanged cases: r1, r3–r9, p1–p9, f1–f8, f10.

The requests and query strings do not change.
Every request equals its saved baseline request before the call.
The unchanged `normalizeHit` and `scoreQuery` functions produce the scores.
All 28 complete responses include freshness envelopes in `response-<id>.json` and `queries-<repo>.json`.
No response serves a previous generation. Each repo keeps one Publication throughout its queries.
These new Publications differ from the baseline:
- React: `9dbbcb40-8b68-4061-a91b-db460a6eedcb`.
- Polars: `cbd34c4b-c08f-4d28-a791-6e0dba58e10c`.
- FlatBuffers: `136befd0-ae2e-4369-9d05-939611328444`.

f7 remains an ordinary and strict miss.
The new FlatBuffers sidecar contains 120 non-file symbols in `src/idl_parser.cpp`, plus its file symbol.
Recovered owners include `ParseField` at lines 919–1344 and `ParseAnyValue` at lines 1362–1492.
The identity join finds recovered-owner candidates at dense ranks 2, 9, 68, and 76.
One recovered-owner candidate reaches core fusion at 6, MCP fusion at 11, and reranker input at 11.
The provider places that candidate at 37. Reranker fusion places it at 53, and disclosure excludes it.
Recovered symbols therefore reach retrieval and reranking, but f7 gains no final top-ten hit.
`f7-check.json` records exact owner identities, spans, and the complete candidate path.
These observations do not prove why each changed rank occurs across different Publications.

Resource and timing limits:
- Sampled peak RSS for the final driver's process tree: 4209.1 MiB, sampled every 500 ms.
- Load averages before: `1.58, 1.56, 1.33`. After: `7.92, 5.20, 2.99` for 1, 5, and 15 minutes.
- Polars indexing takes 105911 ms. FlatBuffers indexing takes 37942 ms.
- React's completed index is reused. Its first attempt logs writing through 57 seconds, but retains no exact completed wall time.
- Direct query calls range from 1931.367 to 6212.735 ms. Each query has one retained duration.
- These durations are not three-run medians and establish no speed improvement.
- Peak RSS excludes React indexing in the earlier interrupted attempt and can miss peaks between samples.

Exact run commands from `/home/hamza/repo/satori`:
- `node --check /tmp/orch/measurement-v23/driver.mjs`
- `node /tmp/orch/measurement-v23/driver.mjs > /tmp/orch/measurement-v23/resume-stdout.log 2>&1`
- `node /tmp/orch/measurement-v23/driver.mjs > /tmp/orch/measurement-v23/resume2-stdout.log 2>&1`
- `node /tmp/orch/measurement-v23/driver.mjs > /tmp/orch/measurement-v23/resume3-stdout.log 2>&1`
- `node /tmp/orch/measurement-v23/finalize.mjs`

The existing successful build is reused. No build repeats.
`completion.json` records zero remaining tracked child processes.
`final-validation.json` also finds no process with this task's state-root identity.
All owned sessions close, including failed attempts. Three task-owned Publications remain intact.
The final driver exits 0. No measurement blocker remains.

Result paths:
- `/tmp/orch/measurement-v23/result.json`: scores, per-query ranks, counts, direct durations, resource measurements, and Publication identities.
- `/tmp/orch/measurement-v23/response-*.json`: complete responses and exact requests.
- `/tmp/orch/measurement-v23/f7-check.json`: sidecar identities and corrected f7 candidate path.
- `/tmp/orch/measurement-v23/lane-metrics.json`: corrected lane metrics and stage counts from retained responses.
- `/tmp/orch/measurement-v23/completion.json` and `/tmp/orch/measurement-v23/final-validation.json`: completion and frozen-input checks.

The earlier proposed investigation order remains a proposal for the parent.
The measurement adds no production repair, tuning, or new investigation.

### Parent check of retained responses

The parent independently normalizes and scores all 28 retained responses with the unchanged production classifier and scorer.
Every request matches its saved baseline request. The independently computed ranks and aggregate scores match the recorded results.
Only r2 and f9 change. This check starts no model or index process.
Evidence: `/tmp/orch/measurement-v23/parent-verification.json`.
Different Publications and regenerated index identities prevent attributing every rank change to C++ recovery alone.

The parent also checks the intended f9 string-method span at 706–717 in the new response.
It appears at expanded lexical fallback rank 54 and replay-signals rank 8, but not in reranker input.
The earlier baseline records lexical rank 52. Its older core-cut diagnosis alone does not explain the complete new path.
The next bounded check must trace removal between recovery evidence and provider admission before selecting a production repair.

## f9 fusion trace, 23 October 2026

The next trace corrects the interpretation above. `mcp_replay_signals` is a diagnostic shadow inventory, not recovered admission.
Its second page starts after 160 records. The target's local rank eight therefore represents overall position 168.
`search-execution.ts:1164–1263` constructs that inventory separately from the admitted candidate list.
The target never enters `mcp_fusion`, `mcp_filtered`, or reranker input.

A low-effort Codex worker replays the existing core fusion function with the recorded score-relevant inputs.
All 46 recorded passes across 28 responses reproduce exact candidate IDs, order, and numeric scores.
Core fusion uses k=100. MCP multi-pass fusion uses a separate k=60 policy.
The expanded fallback arm finds the target at native rank 54, or rank 45 after repeated owners are removed.
Its only vote is 1/(100+45), or 0.006896551724137931.
Full fusion places it at rank 87. The rank-80 cutoff score is 0.0070921985815602835.
The target falls below that cutoff without a score tie.

The replay reconstructs score-relevant identity fields. It does not reconstruct source content or claim source-document equivalence.
Evidence: `/tmp/orch/f9-fusion-replay/{replay.mjs,evidence.json,report.md}`.
No production policy, budget, or source code changes occur in this trace.

Source supplementation runs but adds no candidate from the target file.
The saved trace alone does not identify its selected files or exact exclusion gate.
The target's published qualified name is only `create`, with no parent segments.
A fix cannot assume that the registry supplies `FlatBufferBuilder.create`.
The next bounded check replays the existing supplementation helper with actual registry records and matching source evidence.

### Source-recovery gates and one candidate experiment

The helper replay reproduces all 16 saved additions by exact owner, path, and span.
FlatBufferBuilder.swift ranks eighth by retrieval order and twelfth in the declaration lane. Each lane admits three files.
The actual helper therefore never reads that file.
An isolated diagnostic call passes its manifest hash and span checks, but the intended method matches only normalized `str`.
The helper requires two source terms. The top-six symbol cap never applies because that method is ineligible.
Evidence: `/tmp/orch/f9-fusion-replay/recovery/{check.mjs,evidence.json,report.md}`.

One experimental change now tests existing file context inside the source-recovery owner.
Two distinct whole-query path terms can prioritize a file inside the existing three-file declaration lane.
That same witness can permit one independent source match instead of two.
Path-only evidence remains insufficient. Stronger source matches retain their existing per-file priority.
The original retrieval lane, six-file maximum, six symbols per file, source hash checks, and candidate budgets stay fixed.
This is a candidate policy, not a confirmed accuracy improvement.
Retain it only if the intended f9 method reaches the visible ten and the unchanged 28-question comparison shows no rank regressions.

### Path-context candidate rejected before model inference

The candidate exists only in `/home/hamza/.t3/worktrees/satori/t3-eeb5f754`.
It changes the source-recovery helper and adds three regression tests. All ten focused tests pass.
The parent reviews the complete diff, then replays actual f9 candidates, registry records, and hash-matched source.
The candidate reads six files and returns 22 identities. It now reads FlatBufferBuilder.swift, but still excludes the intended method.

Diagnostic-only instrumentation of the candidate's exact ranking finds 13 eligible symbols in that file.
The intended create(string:) ranks twelfth, with one source match and no name match.
The first six are finish, four add overloads, and clear.
The six-symbol window therefore becomes another exclusion gate after file selection and matching are relaxed.
Evidence: `/tmp/orch/f9-context-candidate/{replay.json,replay-ranking.json}`.

The failed real-input assertion rejects this experiment. No candidate source changes enter the main checkout.
No model call, index rebuild, or 28-query tuning run uses this candidate.
The worktree retains the rejected patch and tests for review. The earlier integrated fixes remain unchanged.
Further admission changes need a diagnostic check of the intended method's reranker result before more selection rules change.

The current read-only task searches for an existing faithful reranker replay entrypoint. It runs no inference.
Task ID: `node:delegated-task:command%3Amcp%3A810b1914-ba1e-4b94-a8e5-291cf18d8c27%3Athread-send%3Asatori-20261023-f9-rerank-replay-seam-1`.
Its evidence belongs under `/tmp/orch/f9-rerank-replay-plan/`. A faithful replay or an exact missing-input limit is the stopping condition.

### Fixed-window provider diagnostic

The replay-seam check finds current projection and provider APIs, but no existing f9 injection entrypoint or saved canonical document text.
The baseline retains hashes, byte counts, identities, and provider scores for 128 documents.
The parent defines one diagnostic window: replace only input slot 128 with the intended string method.
The first 127 identities and document bytes must remain unchanged. Both requests retain 128 documents and the existing byte budget.
This is an experimental input, not a production selection rule or final search-quality test.

Before inference, all 128 regenerated baseline documents must match their saved SHA-256 hashes and byte counts.
Projection must use real published owners, compatible relationships, and hash-matched source with the existing v5/v2 contract.
A mismatch stops the diagnostic before provider construction. Missing context must not be replaced with invented text.
If the gate passes, one baseline request and one substituted request establish the target's provider rank in that window.
Later fusion, grouping, and disclosure remain outside that result.
Evidence belongs under `/tmp/orch/f9-rerank-diagnostic/`.

### Provider diagnostic result

The baseline gate passes for all 128 hashes, byte counts, roles, focus, and v5/v2 projection identities.
Exactly two provider requests run. The intended create(string:) scores 20.06631248665158 and ranks 28 of 128 in the substituted window.
All 128 fresh baseline scores and ranks match the saved results exactly. All 127 surviving candidates retain identical scores across requests.
Baseline input uses 149,139 bytes. The variant uses 149,110 bytes. Both fit the 1,048,576-byte budget.
All 14 frozen source, runtime, and model identity checks pass. The provider closes and leaves no owned inference process.
The parent independently checks the packet hashes, saved scores, score deltas, target rank, byte bounds, and recorded cleanup.
Evidence: `/tmp/orch/f9-rerank-diagnostic/{driver.mjs,evidence.json,report.md,target-document.json,parent-verification.json}`.

Provider rank alone does not establish final search rank.
The unchanged baseline moves createShared from provider rank 45 to definition-fusion rank 14 and visible rank nine.
One final offline check now replays those existing post-provider policies before drawing an admission conclusion.

The intended method's canonical `signature_or_declaration` currently contains `@inline(__always)`.
The actual function declaration appears in its source excerpt on the next line.
This is an observed representation detail, not a measured cause or an approved projection change.

### Post-provider order and second admission trial

The offline replay reproduces all 128 baseline identities after definition fusion and implementation preference.
In the fixed diagnostic window, the intended create(string:) moves from provider rank 28 to rank eight after both policies.
Final grouping and disclosure remain unmeasured. The diagnostic establishes no production search gain.
Evidence: `/tmp/orch/f9-rerank-diagnostic/post-order/{replay.mjs,evidence.json,report.md}`.

The first admission trial remains rejected in its isolated worktree. The main helper and its tests still equal HEAD.
The second trial keeps both three-file lanes, all source guards, and the existing total allowance of 36 returned symbols.
Path context orders the declaration lane. A new one-term match must occur in source beyond the path and declared name.
Each file keeps its initial six selections. Context-backed files can share unused total capacity in deterministic rounds.
Provider limits, input bytes, projection, family selection, fusion, and indexes remain outside this trial.

Task-start state: HEAD `b26af3d16d6812ee6a787cbad73a09457fefa7d2`, branch `master`.
Existing harness, C++ v23, checkpoint, README, and user HTML changes remain intact.
Decision: code-change trial at the existing request-local source-admission owner. No new persistence or public parameter.
TDD mode remains off. Focused regression tests precede actual-input replay and any live model check.
Task ID: `node:delegated-task:command%3Amcp%3A810b1914-ba1e-4b94-a8e5-291cf18d8c27%3Adelegate-task%3Asatori-20261023-f9-capacity-recovery-candidate-1`.
The worker owns only the helper and its focused test file in a new isolated worktree.
Retain the trial only if the exact intended owner reaches final visible ten without regressions in the same 28 queries.
If this second trial fails, stop admission tuning and record the result.

The second trial passes all 11 focused helper tests and `git diff --check` in its isolated worktree.
Worktree: `/home/hamza/.t3/worktrees/satori/t3-42f8975e`.
The parent replays the saved production query, ordered candidates, published symbols, and hash-matched source.
The exact intended owner at lines 706–717 now returns at admission position 24 of 25 candidates.
The helper reads six files and stays below its existing 36-result maximum. Baseline recovery reads five files and returns 19 candidates.
Evidence: `/tmp/orch/f9-capacity-candidate/{replay.mjs,replay.json}`.
No source changes enter the main checkout yet. Spec review, correctness review, and final disclosure checks remain pending.

Both independent reviews pass. Neither review finds a concrete contract or correctness defect.
The parent applies only the two reviewed helper files to the main checkout. All 11 focused tests pass there.
The patch remains provisional until the exact f9 owner reaches final disclosure and the unchanged comparison shows no regressions.
The later live check after commit `cc9651b8` meets the exact-owner half of this condition. A
complete 28-query regression comparison is not recorded.
The parent rebuilds the changed MCP runtime before measurement. The existing v23 Publications remain intact.

### Overall recovery budget, 24 October 2026

The user requests removal of the per-file quota and its allocation complexity.
The parent replaces initial six-slot reservations and round-robin overflow with one global selection of at most 36 candidates.
The named limit now lives in `search-constants.ts`. Existing match scores determine order across all selected files.
Original file order and source lines break ties. No file receives reserved slots or a separate candidate allowance.
Source selection still reads at most six files. Publication hash checks and source-only match requirements remain unchanged.
The source reader still rejects files above 256 KiB. Symbols still span at most 400 lines.
Provider admission still uses its existing 128-document and 1 MiB input bounds.
These bounds apply to source recovery and reranking. They do not guarantee memory use during initial indexing.

The parent records the current dirty state before edits and preserves all earlier work.
TDD mode remains off. Only the provisional quota assertions change, while the original seven helper tests remain intact.
All 12 focused helper tests pass. They cover stronger later-file selection, a full global budget from one file, and exact candidate references.
The earlier reviews concern the superseded quota design. Live accuracy for the new global selection remains unmeasured.

The global-only trial fails the saved-input admission check. It returns 36 candidates and excludes the exact intended f9 owner.
One generated Swift file takes 31 slots. `include/flatbuffers/flexbuffers.h` takes the other five.
The earlier quota design returns the intended owner at position 24 of 25. Both replays read six hash-matched source files.
This is an admission regression against that provisional design. It is not a measured final-search regression.

The parent preserves the rejected source, tests, constants, patch, and replay under `/tmp/orch/f9-global-candidate/`.
The parent restores the previous reviewed quota design and rebuilds MCP successfully. The constants file again equals HEAD.
The restored helper and tests equal the worktree whose 11 tests passed. No earlier user work is removed.
No model request, new index, or 28-query comparison runs for this rejected global-only trial.
Stop condition: the intended owner fails admission. Do not increase another limit or start another tuning loop in this pass.

The evidence supports cross-file allocation as a quality concern. It does not establish six as an optimal quota or a RAM safeguard.
The earlier live measurement remains interrupted. Final accuracy of the restored provisional patch remains unproved at this stage. The later live f9 check recovers the exact owner, but complete-set accuracy remains unmeasured.

### No recovery symbol-count quotas, 24 October 2026

The user clarifies that the derived total of 36 must also disappear. The earlier global-only trial did not test that request.
The new slice removes both the per-file symbol quota and total recovery-count cap, with no replacement count quota.
Source-file selection, eligibility, ordering, exact identities, and existing source-byte and provider bounds remain unchanged.
The parent prepares a 106-line helper, down from 125 lines, while preserving the live baseline source for measurement.
The focused quota test will require all 180 eligible symbols from three files, including a file without path context.

One worker measures three identical f9 requests before the edit. The changed arm will use three identical requests afterward.
Both arms must use the same existing FlatBuffers Publication, model artifacts, profile, query, and parameters.
Record all call durations, median elapsed time, peak sampled memory, candidate counts, and the exact intended owner's final rank.
Each arm starts a fresh session. The first call may include model startup, so report it separately from later calls.
This comparison establishes evidence for f9 only. It does not establish a broad repository accuracy or latency gain.

An ambiguous brief made the first worker read `.request` as a filename suffix. That attempt makes zero model calls.
The parent supplies the actual JSON filename and identifies `request` as its property. The same worker continues the baseline task.
Evidence belongs under `/tmp/orch/f9-no-quota-measurement/`. Prepared source and tests belong under `/tmp/orch/f9-no-quota-candidate/`.

The live baseline stops before its first search: status reports `not_ready`, reason `indexing`.
The active mutation is sync `5fd9ace9-3da2-4e3c-96fa-826b328eb9e7`, generation two, writing at 5 percent.
The measurement worker issues status only, closes its session, and reports no remaining owned child processes.
No end-to-end call latency or final search rank is available from that attempt.

The parent applies the user's clarified removal without waiting for a live baseline that cannot run.
The helper now returns every eligible symbol from the selected files. Both six-per-file and total36 count quotas disappear.
The quota and overflow code shrinks from 125 to 106 helper lines. All 11 focused tests pass, including 180 returned symbols.
MCP rebuild, focused ESLint, and `git diff --check` pass.
The same saved-input replay reads six files, returns 118 candidates, and includes the exact f9 owner at return position 18.
That position is a helper result, not a provider or final search rank.

The parent also measures the helper alone with three runs per arm, using identical saved inputs and source files.
The baseline uses the preserved quota source. The changed arm uses the edited source. Neither arm runs a model.
These timings exclude retrieval and reranking, so they cannot establish end-to-end latency.
Memory records include TypeScript transpilation and module loading in each helper process.
Evidence: `/tmp/orch/f9-no-quota-candidate/{measure-helper.mjs,baseline-helper.json,variant-helper.json,replay.json}`.
One Luna Max worker checks the indexing blocker read-only. It must not alter state or start an index operation.

Helper-only measurement uses three fresh processes per arm, with three calls inside each process.
The median of process medians is 27.124 ms before removal and 28.496 ms afterward, a 1.372 ms increase on this fixture.
The median process peak is 162.738 MiB before and 162.664 MiB afterward, measured with `/proc/self/status` `VmHWM`.
Baseline peaks range from 162.363 to 163.727 MiB. Changed peaks range from 162.195 to 163.125 MiB.
Machine load during the earlier helper trials ranges around 1.32–1.37 over one minute. All raw trials retain their own load records.
Earlier `resourceUsage().maxRSS` samples vary with invocation and include 428.414 MiB readings. Preserve those raw records without attributing them to quota removal.
The repeated measurements use fresh child processes and the process memory high-water mark instead.
Evidence: `/tmp/orch/f9-no-quota-candidate/{helper-comparison.json,rss-comparison.json,measure-helper-rss.mjs}` and per-process JSON files.
Recovery returns 25 candidates before removal and 118 afterward. The exact intended owner remains present in every helper run.
These data establish helper cost only. They do not establish final search quality, end-to-end latency, or safety for arbitrary repositories.

The Luna blocker check finds that the sync completed 397 ms after the saved status response.
Both recorded PIDs have exited. The current Publication pointer remains unchanged.
The normal search route can be retried without removing state or rebuilding the index.

The user then explicitly requests the quota removal commit before another live comparison.
Commit `11889927` records only the recovery helper and its focused tests: `fix(search): recover source-backed symbols without file quotas`.
The parent rebuilds MCP, reruns all 11 focused tests, checks the commit contents, and confirms both committed files are clean.
Earlier harness, C++ extraction, documentation, and user HTML changes remain outside that commit.
Full-search timing and final quality remain unmeasured for the no-quota change.

The user also requests a separate policy-rationale audit through T3 orchestration V2.
The child runs Pi with `opencode2api/deepseek-v4.1-flash-free` and `thinking=max`.
The audit distinguishes documented reasons, bounded inferences, and `REVIEW REQUIRED` policies.
It may write only `docs/improvements/search-policy-rationale-audit-2026-10-24.md`, with no production edits.
Task ID: `node:delegated-task:command%3Amcp%3A4bdc1ebc-d1c5-4f60-920d-24f88d8c15d3%3Adelegate-task%3Asatori-20261024-search-policy-rationale-audit-1`.

The first Pi/DeepSeek audit ends with `Upstream response aborted before completion`.
No audit report exists at that point. The parent starts one retry in the same child thread with the same model settings.
The parent also uses live Satori search and source reads directly. They locate search-policy, rerank-family, and source-recovery owners.
Source comments explain output-independent retrieval and owner diversity. Exact recovery-window and span values remain audit candidates.

The retry also ends with `Upstream response aborted before completion`. The parent stops provider retries.
Neither Pi/DeepSeek attempt produces an audit report. The requested independent review remains blocked.
The parent records a preliminary source-based list in `search-policy-rationale-audit-2026-10-24.md` and registers it in the README.
It marks eight policy/value groups for review and preserves the distinction between inferred purpose and justified numeric choice.
The report identifies its parent authorship and provider failure explicitly. It makes no production changes and claims no completed DeepSeek audit.

The user authorizes another attempt after the two upstream aborts.
The parent starts a fresh T3 task on Pi/DeepSeek V4.1 Flash with `thinking=max`.
The worker must preserve the preliminary report and append a clearly attributed independent audit section.
Task ID: `node:delegated-task:command%3Amcp%3A4bdc1ebc-d1c5-4f60-920d-24f88d8c15d3%3Adelegate-task%3Asatori-20261024-search-policy-rationale-audit-3`.

The third Pi/DeepSeek attempt returns HTTP 429, `FreeUsageLimitError`, with message `Free usage limit reached`.
No independent audit section is produced. The parent marks the audit blocked by provider quota and stops retries.
The preliminary parent report remains available. Commit `11889927` and all production files remain unchanged.

The user's later continuation succeeds. Pi/DeepSeek appends an independent audit to the report while preserving the preliminary parent section.
The parent checks the main claims and adds §7 with factual corrections. The raw independent text is preserved in `/tmp/orch/`.
The 25-candidate baseline is reproducible. The 22-candidate artifact belongs to an earlier trial.
The preferred reservation is half the provider budget, so at 128 documents its allowance is 64, not 16.
Source recovery appends after retrieval fusion. It is not clipped back to 80 after recovery.
The review also qualifies retry diagnostics, byte arithmetic, source-limit coupling, and grouping exceptions.
The remaining policy topics are review candidates, not proved production regressions. No code changes follow the audit.

### First live no-quota f9 probe, 24 October 2026

The source harness completes exactly one saved f9 search at commit `11889927`.
The exact request, model identities, default flags, pinned source, and Publication `136befd0-ae2e-4369-9d05-939611328444` pass their checks.
The first status read sees indexing. The second sees the same ready Publication. No manual index or sync command runs.

The exact owner at `FlatBufferBuilder.swift:706–717` is absent from the final ten results.
It reaches reranker input position 87, provider rank 22, adjusted reranker rank 19, and MCP ranked position 19.
The final response includes a broader file result at position three, spanning lines 690–717. That is not the exact owner.
The parent independently checks the raw response, exact request equality, owner identity, stage ranks, and cleanup records.

The grouped trace records 160 of 250 occurrences and does not contain the exact owner. It omits the other 90 occurrences.
This absence alone does not prove that a specific grouping rule removes the owner. The complete final list proves non-disclosure.
Replay-signal page positions are diagnostic positions, not final search ranks.

The call takes 4,929.5 ms. Sampled peak RSS is 2,416.2 MiB for the driver and observed descendants.
Provider work is two semantic attempts, two embedding calls, and one reranker request over 128 documents with 167,336 input bytes.
Load before the call is 0.65 / 0.61 / 0.70. Load afterward is 1.31 / 0.75 / 0.75.
This is the first search in that session. One call cannot establish a latency median, speed improvement, or performance regression.
The session closes, no owned processes remain at cleanup, and protocol error count is zero.

Evidence: `/tmp/orch/f9-current-head-probe/{result.json,response.json,preflight.json,completion.json,parent-check.json}`.
Admission succeeds, while the exact f9 answer still misses. No end-to-end accuracy gain for this
target is demonstrated at this stage. This remains the pre-repair failure result; the later live
check after commit `cc9651b8` returns the exact owner at rank 4.
The committed quota removal remains unchanged as the user requests. Stop after the one call.
No 28-query run, further policy tuning, or production change follows this probe.

### Swift declaration-field repair, 24 October 2026

The user authorizes a separate repair after the live f9 miss.
The existing projector uses `firstStructuralDeclaration` to populate the mandatory declaration field.
For non-file symbols, that function previously returned the first nonempty physical line.
The real f9 packet therefore contained `@inline(__always)` as its declaration, while its source excerpt contained the actual function header.

Decision: code change at the existing pure projection owner. No new service, state, parser dependency, public field, or index format.
The invariant is that the declaration field describes the callable while the source excerpt preserves its original attributes and body.
The repair recognizes complete standalone Swift attributes before selecting the next line.
Mixed, nested, and multiline attribute syntax retains previous behavior. Other languages and file-level selection remain unchanged.
This repairs the existing field contract without changing v5 document shape, owner identity, source spans, or byte budgets.

The parent checks repository status before editing. Only the projection primitive and its document test file change.
TDD mode remains off. A focused regression first reproduces the wrong `@inline(__always)` declaration on the old code.
After the repair, 14 document tests, 16 projection tests, and eight request-contract tests pass. MCP rebuild and focused ESLint pass.
The new fixtures cover stacked attributes, inline declarations, uncertain syntax, non-Swift behavior, and missing callable declarations.

The parent rebuilds the exact real-source target packet and checks its source hash against the existing Publication.
Only `signature_or_declaration` changes. It now reads `mutating public func create(string str: String?) -> Offset {`.
The packet remains v5 and uses 1,447 UTF-8 bytes. Evidence: `/tmp/orch/f9-signature-repair/projection-check.json`.

Luna Max receives one live f9 comparison against the previous actual request, with the same query, Publication, models, and flags.
It must report the exact final owner and whether the provider input window stays identical, then stop.
Evidence belongs under `/tmp/orch/f9-signature-live-probe/`. No final accuracy gain is claimed before that result.
At that date the repair remained uncommitted after the live check. It is now part of commit
`cc9651b8`.

The repaired live f9 request completes once against the same Publication, query, models, profile, flags, and ordered 128-candidate window.
The parent independently checks exact request equality, all 128 input IDs and order, stage ranks, final results, and cleanup.
The target remains at input position 87. Provider rank improves 22 → 17, and adjusted rank improves 19 → 12.
The exact owner still does not appear in the final ten. The response contains a broader same-file result at position four.
The grouped snapshot records 160 of 250 occurrences, so its missing exact identity does not establish a complete-group exclusion mechanism.

The live target packet grows from 1,404 to 1,447 bytes. Its document hash changes, while v5/v2 projection identities remain unchanged.
The request takes 4,441.1 ms, with sampled peak RSS 2,468.9 MiB across the driver and observed descendants.
Provider work remains two embedding calls and one reranker call over 128 documents, now with 168,398 aggregate input bytes.
Load before is 0.29 / 1.09 / 1.53. Load afterward is 1.07 / 1.24 / 1.57.
These single-call measurements do not establish a speed or memory improvement. The session closes with no owned processes or protocol errors.

A preflight-only attempt uses the wrong TypeScript emit target for token comparison and stops before opening a session.
The worker corrects that measurement check. The corrected driver makes exactly one live search, with no production edits.
Evidence: `/tmp/orch/f9-signature-live-probe/{result.json,response.json,preflight.json,completion.json,parent-check.json}`.

At this stage the declaration-field defect was repaired and intermediate ranks improved. The final
exact-owner target still failed. The later grouped-owner repair is described below.
No further ranking or budget edit follows this result. Under the user's two-attempt rule, one fresh Luna Max worker diagnoses the paired raw traces.
It receives the goal and raw artifacts, not the parent or audit theories. It may not edit code or run another model/search.

### Polars p3: cue exonerated, acceptance narrow, 24 October 2026

A polars run (`--repos polars`) indexes in 99 s and scores hit@1 5/9 and hit@5 8/9.
The only total miss is `p3`, "where does polars cast a column to a different dtype".
`focus_cue_wide` off versus on gives `p3` absent→absent and `p5` rank 1→1, and the other seven queries return identical hits.
The intent cue is therefore not the repair for this miss.
In the same run, two `crates/polars-core/src/chunked_array/cast.rs` chunks enter dense retrieval at ranks 46 and 55. One survives core fusion at rank 80, the last of the 80-candidate pool, then moves to MCP fusion rank 89, reranker input 88 of 89, provider rank 61, reranked fusion rank 41, and grouped rank 40. The kernel path is therefore present in the fused pool, at its last position. The dispatch owner `Column::cast` at `crates/polars-core/src/frame/column/mod.rs:486` follows a different path: reranker input rank 3, provider rank 30, reranked fusion rank 14.
The top-10 holds seven candidate results that Jev rates `answers`: six at 0.83–0.98 confidence and one at 0.40. None is `Column::cast` at `crates/polars-core/src/frame/column/mod.rs:486`.
At this date the acceptable set named the kernel file only, so the observed closure was an
acceptance gap. The approved path-level acceptance later added
`crates/polars-core/src/frame/column/mod.rs` with `symbolRegex: null`. Rescoring three saved
captures then adds one hit@10 and one strict hit@10, with MRR@10 +0.005102 and unchanged hit@1 and
hit@5. The returned hits are `cast_unchecked` at rank 7 and `strict_cast` at rank 10. They do not
prove `Column::cast`. The acceptance change is rubric-only and changes no retrieval.
One product observation remains: the kernel chunk enters reranking at input 88 of 89 and finishes at reranked fusion rank 41 and grouped rank 40. That rank chain describes the historical p3 capture, not the current `cast_unchecked` and `strict_cast` hits.
Triage counts and the adapter live in `jev-judgement-workflow.md`.


### f9 canonical owner survives a documentation member, 24 October 2026

A target-specific check follows the candidate ID through the saved signature probe.
The derived 706–717 candidate is present in the grouped and disclosed snapshots at group four.
Its owner changes from the exact function to a file owner, with span 690–717 and label `file nameOffset`.
Thus, the earlier exact-owner absence is real, but the candidate does not disappear from those snapshots.
Candidate rank 12 does not explain this miss. The group already occupies visible position four.

The published documentation chunk at 690–706 resolves to the same function through the existing documentation repair.
That attribution deliberately carries no containment proof. The source candidate at 706–717 carries a byte containment proof.
An offline reproduction uses the actual published chunk, registry records, production owner resolver, and group builder.
Both members resolve to `syminst_93e4f4c44929083e8d51c77e65cd57be`.
The group builder requires every member to carry a proof, so the leading documentation makes the group fail validation.
Its combined preview starts before the function, and compact-target resolution falls back to a file identity.
Evidence: `/tmp/orch/f9-group-identity/before.json`.

Decision: change the canonical group owner validation in `search-group-results.ts`.
A contained member proves the shared owner. Additional members already attributed to that owner do not erase the proof.
The documentation member still receives no containment proof. No owner-resolution, retrieval, ranking, or disclosure policy changes.
A new regression first fails on the old file fallback, then passes with the repair.
It checks both member orders, documentation alone, and unrelated executable code remaining in a separate group.
Existing tests still reject cross-file ownership, broad-only nested owners, and contradictory byte evidence.

One current-checkout live f9 search now returns the exact owner at visible rank four, span 706–717.
The query, Publication `136befd0-ae2e-4369-9d05-939611328444`, models, defaults, and output parameters match the signature probe.
All 128 reranker candidate IDs, their order, and rerank-input metadata match exactly.
The target remains at input 87, provider 17, adjusted 12, and MCP-ranked 12.
Grouping and disclosure preserve its canonical identity at rank four. The final response still contains ten results.
This is measured recovery of the exact intended f9 owner, not an intermediate-rank claim.

The call takes 5,411.5 ms. Sampled peak RSS is 2,571.6 MiB for the driver and observed descendants.
The prior signature probe takes 4,441.1 ms with sampled peak RSS 2,468.9 MiB.
These single calls do not establish a performance difference.
Load averages before are 0.79 / 0.42 / 0.60 and afterward 1.12 / 0.49 / 0.63.
Available memory changes from 7,448.5 MiB to 6,170.9 MiB.
Provider work remains two embedding calls and one reranker call over 128 documents and 168,398 input bytes.
Source/dist token equivalence and freshness pass for the grouping repair.
The session closes, no owned processes remain, and protocol errors are zero.
Evidence: `/tmp/orch/f9-group-identity-live-probe/{driver.mjs,result.json,response.json,preflight.json,completion.json,parent-check.json}`.

Focused verification passes 106 tests across nine affected grouping, owner, projection, finalization, and disclosure files.
The MCP TypeScript build, focused ESLint, and `git diff --check` pass.
At this stage the signature repair and group repair were uncommitted. Both are now in commit
`cc9651b8`. Existing unrelated work remained intact.
No further search, tuning, index operation, or 28-query measurement follows this result.
The exact f9 target passes. Effects on the complete evaluation set remain unmeasured.
