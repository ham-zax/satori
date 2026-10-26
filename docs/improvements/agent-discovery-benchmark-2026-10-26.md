# Satori vs native agent discovery, 26 October 2026

Status: complete for the valid suite
`opencode-2026-10-26T06-01-46-184Z-3430c008`. The earlier suite
`opencode-2026-10-26T05-35-22-920Z-89bc825d` failed the final clean-worktree
check and has no published aggregate. The two suites are not merged. In the
valid suite one graded relation needed an oracle clarification, and one Satori
result exceeded the harness's 32 KiB limit.

## Question

How much wall time, API tokens, and tool calls does an agent spend to find the
owning file, symbol, and span, with Satori and with native search?

## Method

- Harness: `evals/agent-discovery/run-opencode.mjs`. It owns isolation, the
  immutable-revision check, pairing, event capture, and grading.
- Reported measurement: suite
  `opencode-2026-10-26T06-01-46-184Z-3430c008`, revision `47821dde`, protocol
  `satori-agent-discovery-v3`, harness validity `valid` (12/12 runs). The
  earlier suite is invalid and excluded from every table and delta.
- Agent: OpenCode 1.18.35, `zengate/deepseek-v4.1-flash-free`, variant `high`
  (reasoning effort).
- Design: two frozen tasks under protocol v3, two arms, three repetitions,
  alternating arm order. Both arms receive the same task text on revision
  `47821dde`.
- Satori arm: the local MCP runtime with Potion embeddings on CPU, Voyage
  `rerank-3`, and an index of the same revision. Its tools are
  `satori_search_codebase`, `satori_read_file`, `satori_file_outline`, and
  `satori_call_graph`.
- Native arm: OpenCode `grep`, `glob`, and `read` only, with a 200-line cap per
  read and a grep-or-glob call before each read.
- Fixed first query: the harness gives the Satori arm the exact first search
  call (`task.satoriQuery`, grouped by symbol, limit 5) and rejects any other
  first call. The native arm composes its own queries. The first-call advantage
  therefore measures retrieval from a curated query, not query formation.
- Grading: owner file, owner symbol, complete 1-based inclusive span, five task
  facts, and every required relation with its file. A run passes only when all
  items match.
- Harness limits: 24 tool calls and 32,768 visible bytes per tool result.

## Results

The tables below use only the valid suite
`opencode-2026-10-26T06-01-46-184Z-3430c008`. The invalid earlier suite is not
included.

### Time to the owner, all attempts

Target and source milestones below are measured from visible tool evidence.
Total arm wall time is reported separately in the cost tables.

| Task | Arm | Correct | First target ms | Target call | First source ms | Source call |
|---|---|---:|---:|---:|---:|---:|
| known-exact-target | native | 2/3 | 7,890 [4,691-22,711] | 2 [2-4] | 12,457 [10,247-25,831] | 3 [3-5] |
| known-exact-target | satori | 3/3 | 4,879 [4,235-12,358] | 1 [1-1] | 9,080 [8,542-15,745] | 2 [2-2] |
| unknown-freshness-reuse | native | 1/3 | 42,059 [40,481-74,271] | 16 [14-24] | 42,059 [40,481-74,271] | 16 [14-24] |
| unknown-freshness-reuse | satori | 1/3 | 9,611 [6,801-18,743] | 1 [1-1] | 13,605 [10,388-22,212] | 2 [2-2] |

Satori showed the owner source at call 2 on both tasks. Native search needed 3
calls on the exact-name task and 16 on the unknown-target task.

### Cost of correct runs

| Task | Arm | Correct | Total wall ms | Input tokens | Output tokens | Tool calls | Visible bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| known-exact-target | native | 2/3 | 49,107 [39,415-49,107] | 16,440 [12,314-16,440] | 1,620 [1,523-1,620] | 14 [14-14] | 52,990 [40,406-52,990] |
| known-exact-target | satori | 3/3 | 32,088 [22,501-50,021] | 12,300 [11,948-14,319] | 1,132 [937-1,133] | 6 [5-6] | 46,220 [44,339-46,230] |
| unknown-freshness-reuse | native | 1/3 | 143,929 | 63,576 | 2,312 | 23 | 117,492 |
| unknown-freshness-reuse | satori | 1/3 | 84,246 | 17,463 | 1,483 | 7 | 51,419 |

Satori minus native on correct runs:

| Task | Total wall | Input tokens | Tool calls | Visible bytes |
|---|---:|---:|---:|---:|
| known-exact-target | -17,019 (-34.7%) | -4,140 (-25.2%) | -8 (-57.1%) | -6,770 (-12.8%) |
| unknown-freshness-reuse | -59,683 (-41.5%) | -46,113 (-72.5%) | -16 (-69.6%) | -66,073 (-56.2%) |

The task 2 row compares one correct run per arm.

### Pass and failure detail

- `known-exact-target`: Satori 3/3, native 2/3. Native repetition 1 made a
  `.test.ts` path visible, which the native-arm rules reject.
- `unknown-freshness-reuse`: 1/3 on both arms.
  - Repetition 2, both arms: the `second_readiness_proof` relation failed
    because of the oracle file mismatch described below. Satori also reported
    `freshnessBlockedStopsBeforeSecondProof=false`; the expected value is
    `true`.
  - Repetition 3, native: the caller relation was missing and the run exceeded
    the 24-call ceiling (26 calls).
  - Repetition 3, Satori: one raw search (`"preparePostFreshnessTrackedRootRead"`,
    limit 20) returned 43,080 visible bytes, above the 32 KiB limit.
- Earlier suite `opencode-2026-10-26T05-35-22-920Z-89bc825d` (invalid): all
  three Satori freshness answers named the correct owner, span, and facts.
  All three attached the callback relation to the implementation definition
  `search-request-coordinator.ts`; repetitions 1 and 2 failed only that item,
  and repetition 3 also returned 41,387 visible bytes. The final worktree check
  failed, so no aggregate is published and these observations are not merged
  with the valid suite.
- Evidence completion, `unknown-freshness-reuse`: Satori reached the complete
  evidence set at call 2 in all three runs and then spent 5 to 8 calls
  verifying. Native reached it in 2 of 3 runs at call 21 [16-21] with a 4-call
  tail. Satori's extra calls are voluntary verification, not failed discovery.

## Reading the result

- Satori reduced discovery cost on both tasks in this sample: fewer calls,
  fewer input tokens, and less wall time.
- The gap is largest when the target is not name-exact. Native search needed 16
  calls to first see the `runSearchFrontDoor` source; Satori needed 2.
- Correctness did not improve on task 2. Both arms passed one of three runs.
  Two failures were the relation-file oracle (one also reported a wrong task
  fact); one missed the caller and exceeded the 24-call ceiling; one exceeded
  the 32 KiB result cap.
- The fixed first query favors Satori on the first step. The later call and
  token savings arise after that fixed call, so that step does not explain them.
- The 43 KB raw result is a Satori output-budget defect: `resultMode: "raw"`
  with limit 20 can exceed a 32 KiB visible cap. It is reported here, not
  fixed.

## Investigation tail and the later wrong fact

In the valid suite, every Satori `unknown-freshness-reuse` run reached the
complete graded evidence set by call 2. The first search at call 1 already
showed the caller path and symbol; the owner read at call 2 contained the
owner and both owner-file relation symbols. Repetitions 1, 2, and 3 then made
5, 8, and 5 more calls. Those calls were outline, repeated search,
coordinator, and handlers reads. Satori repetition 3 spent its last call on the 43,080-byte
search that broke the 32 KiB cap. The tail is voluntary verification, not
failed discovery, but final wall time, tokens, and the repetition 3 failure
include it.

The valid suite grades Satori repetition 2's
`freshnessBlockedStopsBeforeSecondProof=false` as a wrong fact. The model read
both the early return and the `skipped_requires_reindex` exception, which can
reach the second proof before returning a blocked payload. The old boolean
name did not state whether that exception was excluded. The mismatch alone
therefore does not prove an agent reasoning error. Manifest version 4 now
limits this boolean to other freshness modes and asks for the exception in the
conclusion. Recorded scores remain unchanged.

## Oracle ambiguity: `unknown-freshness-reuse`

The task asks for the second readiness proof after freshness. The expected
relation names `preparePostFreshnessTrackedRootRead` at
`packages/mcp/src/core/search-frontdoor.ts`. That symbol has no definition
there. Its definition is the callback in
`packages/mcp/src/core/search-request-coordinator.ts:996`.
`search-frontdoor.ts` declares the host contract at line 57 and calls it at
line 306. The graded file is the reference site, not the definition.

The v3 prompt said only "the second-readiness-proof callback referenced by the
owner code"; it did not say whether `file` meant the definition or the reference
site. The v4 task manifest now asks for the reference site explicitly and keeps
the same expected file. The v3 oracle and its scores remain unchanged; no run
is rescored. Each archived run embeds the v3 task manifest in its
`run-manifest.json`, so the old oracle remains auditable.

In the valid suite, all six freshness attempts reported the correct owner
(`search-frontdoor.ts`, `runSearchFrontDoor`, 207-345). Four attached the
relation to the reference file and passed that item. Two attached it to the
definition file and failed. The v4 wording makes the requested file explicit
for future runs; the archived v3 result stays as measured.

## Canonical index root

The Satori tools require the canonical index root for every root-accepting
`path` argument. A subdirectory belongs in a `path:` query filter, not in
`path`. In the invalid earlier suite, Satori repetitions 1 and 3 passed
`packages/mcp/src` as the root and the guard rejected the calls. The v4 Satori
prompt states the canonical-root rule and gives
`path:packages/mcp/src/core` as the filter example. Native-arm rules are
unchanged: `grep`, `glob`, and bounded `read` under the two production source
roots.

## Limits

- Two tasks, one model, one host, three repetitions. The sample supports
  per-task observations, not a general claim.
- The Satori arm used a warm index of the revision. The native arm searches a
  cold tree with `grep`. This matches daily use but is not equal work.
- The Satori arm started from a curated query supplied by the harness.
- Free-tier provider latency varies between sessions, so wall time carries
  noise that token and tool-call counts do not.
- The task 2 cost row rests on one correct run per arm.
- The v4 task wording and Satori root guidance are not measured here. The
  tables above remain v3 results.
- Suite `opencode-2026-10-26T06-01-46-184Z-3430c008` with
  `/tmp/opencode/bench-full2.log`, and invalid suite
  `opencode-2026-10-26T05-35-22-920Z-89bc825d` with
  `/tmp/opencode/bench-full.log`, are local artifacts, not versioned.


## Parent review clarification

Protocol v4 defines the collection and reporting contract. Task manifest
version 4 also clarifies the freshness boolean's domain: exclude
`skipped_requires_reindex` when answering it, and describe the exception in the
conclusion. The completed frozen-snapshot run uses manifest version 3. Its results
must not be presented as measurements of the final version 4 question. No
snapshot, archived prompt, or old score changes during that run.


## Separate v4 run on the frozen priority snapshot

Suite `opencode-2026-10-26T07-30-15-360Z-24baa346` uses snapshot
`06dca384d6740b0f23ef363c652a2bf084129a82`, OpenCode 1.18.35, DeepSeek V4.1
max, protocol v4, and task manifest version 3. Measurement validity is `valid`,
with all 12 expected run records. The command exits 1 because one native
attempt fails, not because the measurement is invalid. The snapshot stays clean.
The first launch stops before scoring on a transient `not_ready` result. One
retry follows an independently observed `ok` status. Both logs are retained.

The following values are total agent time in seconds, not discovery time:

| Task | Attempt | Native | Satori |
|---|---|---:|---:|
| known-exact-target | r1 | 80.5 pass | 44.7 pass |
| known-exact-target | r2 | 64.0 pass | 42.8 pass |
| known-exact-target | r3 | 75.4 pass | 32.5 pass |
| unknown-freshness-reuse | r1 | 126.3 fail | 265.4 pass |
| unknown-freshness-reuse | r2 | 133.4 pass | 39.9 pass |
| unknown-freshness-reuse | r3 | 165.3 pass | 53.3 pass |

Satori passes 3/3 on each task. Native passes 3/3 and 2/3. Native's failed
freshness attempt exhausts its tool budget. Satori's first freshness attempt
is slower than native's failed attempt; report that outlier rather than only
the lower median. These are two task-specific samples, not a product ranking.
Max effort differs from the older high-effort suites. Cross-run timing changes
cannot isolate the repair. The final manifest version 4 boolean clarification
is not measured by this run. Original v3 scores remain unchanged.

Artifacts live at
`/home/hamza/.cache/satori-priority-20261026/results/opencode-2026-10-26T07-30-15-360Z-24baa346`.
The retry log is `/tmp/satori-pr-v4-benchmark-retry.log`; the unscored first
preflight log is `/tmp/satori-pr-v4-benchmark.log`.


## Closeout observation and proposal

The implementation worker starts a nested review outside its packet, which
blocks the requested cleanup handoff. The parent uses the completed handoff,
stops the extra turn after the unanswered handoff request, and reviews the
changes personally. Reuse a completed result instead of restarting a finished
worker merely to repeat it.

Proposed follow-up: include the structured readiness reason in the harness's
preflight error. The first launch only reports `not_ready`, so its exact cause
cannot be established from that log. No readiness-policy change is proposed
without that evidence, and this run does not implement one.


## Luna final-manifest benchmark receipt

The later suite `opencode-2026-10-26T08-58-40-256Z-464ba326` measures final task
manifest version 4, protocol v4, on clean worktree commit `2f52b298`, with
OpenCode 1.18.35 and DeepSeek V4.1 max. Luna coordinates execution and reports
valid measurements for all 12 records. This receipt does not replace the older
suite tables above. The user declines a deep audit or extra reruns.

| Autonomous task | Satori | Native |
|---|---:|---:|
| known-exact-target | 3/3 | 3/3 |
| unknown-freshness-reuse | 3/3 | 2/3 |

Satori uses five tool calls in every freshness attempt. No Potion startup,
provider, or quota error is observed. Native's failed freshness attempt exceeds
the tool budget and reads before discovery. No scored attempt is repeated.
Maximum visible tool result is 17,831 bytes. The autonomous task count stays two.

A separate installed-LateOn retrieval cohort completes all 30 existing held-out
Gin/Flask questions:

| Repository | Hit at rank 1 | Hit within rank 5 |
|---|---:|---:|
| Gin | 4/15 | 9/15 |
| Flask | 6/15 | 11/15 |

These retrieval metrics are separate from the autonomous-agent and 21-case
semantic results. Query `g15` has zero target chunks; its miss remains in the
30-query denominator. The runner's `rerankerModel=rerank-3` field is stale for
the active LateOn provider. The report discloses the mismatch and records 28
LateOn calls; two Flask queries make no reranker call. This receipt does not
claim general retrieval quality or a causal speedup across changed questions.

The worker reports no tracked source edits, a clean worktree, and all owned
sessions closed. Report and raw-artifact references:
`/home/hamza/.cache/satori-remaining-benchmark-luna-20261026/report.md` and
`/home/hamza/.cache/satori-remaining-benchmark-luna-20261026/report.json`.

## WSL saved-artifact classification, 27 October 2026

Continuation of SF-Q after the ARM handoff. Source HEAD is b83f9e00. No new benchmark runs.
The original 30-query results and oracles remain unchanged: hit@1 10/30, hit@5 20/30, hit@10 23/30.

Evidence root: `/home/hamza/.cache/satori-remaining-benchmark-luna-20261026/cohort-b/results`.
`result.json` owns final scores. `harness-log.json` and saved response diagnostics own the stage observations.

| Query | Final score rank | Provider rank | Fusion rank | Post-policy rank | Classification |
|---|---:|---:|---:|---:|---|
| g1 | 2 | 8 | 2 | 2 | Lower-ranked hit |
| g2 | 4 | 1 | 6 | 6 | Lower-ranked hit |
| g3 | 5 | 3 | 5 | 5 | Lower-ranked hit |
| g4 | — | — | — | — | Candidate admission loss; target appears in dense retrieval and fusion |
| g5 | — | 2 | 44 | 44 | Post-provider definition-fusion demotion |
| g6 | — | 5 | 6 | 6 | Disclosure loss: explicit file_diversity_cap removal |
| g7 | 5 | 15 | 5 | 5 | Lower-ranked hit |
| g8 | 2 | 3 | 2 | 2 | Lower-ranked hit |
| g9 | 1 | 1 | 1 | 1 | Rank-1 hit |
| g10 | 6 | 6 | 6 | 6 | Lower-ranked hit |
| g11 | 1 | 1 | 1 | 1 | Rank-1 hit |
| g12 | 1 | 1 | 1 | 1 | Rank-1 hit |
| g13 | 1 | 1 | 1 | 1 | Rank-1 hit |
| g14 | 7 | 4 | 7 | 7 | Lower-ranked hit |
| g15 | — | — | — | — | Zero target coverage; trace source and publication separately |
| f1 | — | 18 | 13 | 13 | Ranking below disclosure cutoff |
| f2 | 3 | 9 | 3 | 3 | Lower-ranked hit |
| f3 | 3 | 1 | 3 | 3 | Lower-ranked hit |
| f4 | 3 | 3 | 2 | 2 | Lower-ranked hit |
| f5 | 1 | 1 | 1 | 1 | Rank-1 hit |
| f6 | 6 | 4 | 6 | 6 | Lower-ranked hit |
| f7 | 2 | — | — | — | Lower-ranked hit |
| f8 | 3 | 4 | 3 | 3 | Lower-ranked hit |
| f9 | 1 | 5 | 1 | 1 | Rank-1 hit |
| f10 | 1 | — | — | — | Rank-1 hit |
| f11 | 1 | 1 | 1 | 1 | Rank-1 hit |
| f12 | — | 1 | 60 | 60 | Post-provider definition-fusion demotion |
| f13 | 1 | 1 | 1 | 1 | Rank-1 hit |
| f14 | 1 | 1 | 1 | 1 | Rank-1 hit |
| f15 | — | 2 | 39 | 49 | Definition-fusion demotion, then implementation preference |

The seven top-10 misses separate into one zero-target query, three post-provider ranking losses,
one explicit diversity removal, one candidate-admission loss, and one lower-ranked result.
No query with target chunks is proven wholly absent from raw retrieval by this saved evidence.
A null rank in a capped trace means not recorded, not absent from every candidate pool.

### Demonstrated boundaries

- g5: provider rank 2 becomes definition-fusion rank 44. f12: provider rank 1 becomes fusion rank 60.
- f15: provider rank 2 becomes fusion rank 39, then post-policy rank 49.
- The saved `rerank.orderAuthority` is `definition_fusion_order` for these cases.
- `search-rerank-execution.ts:applyRerankOrder` records provider output, applies `fuseDefinitionDiscovery`, then records fusion output.
- `preferImplementationCandidates` runs after that trace, explaining the distinct second boundary for f15.
- The definition vote owner is `packages/mcp/src/core/search-definition-discovery.ts:fuseDefinitionDiscovery`.
  The traces establish a proximate demotion, not a proven faulty policy or a safe replacement.
- g6: target chunk `chunk_dc89fa59890fecbb` reaches grouped rank 6. The saved removal reason is `file_diversity_cap`.
  `search-grouping.ts` owns this selection policy. The first three disclosed routergroup.go results are BasePath,
  calculateAbsolutePath, and Any. The correct Group method is omitted.
- g4: dense target ranks 80 and 58, MCP fusion rank 101, no recorded reranker-input target, grouped rank 91.
  The recorded reranker input contains 128 candidates. Do not call this missing index coverage.
- f1: provider rank 18 becomes combined rank 13 and remains outside the disclosed top ten.

### Measurement limits and reporting

The stage matcher accepts chunk IDs and evidence-line overlap. The final scorer checks displayed paths and symbol names.
Those are different contracts. For f4, a class span includes the save_session evidence line, so the stage matcher reports
rank 2 for SecureCookieSessionInterface. The final scorer correctly reports the actual save_session method at rank 3.
This difference does not justify changing the frozen oracle or silently replacing final scores.

The selected case file is cases-heldout.json, while the historical harness labels Gin and Flask as tune.
The source defaults split from repository name in harness-logger.mjs. The control cohort is a separate default,
not proof that these questions belong to a different case pack. Treat original split metadata as unreliable.
Model provenance and the false zero-target exclusion warning were repaired on ARM.
Preserve the original artifact values and the 30-query denominator. No fresh provider comparison exists.

### Decision

Decision: no search code change for SF-Q. Classification passes from saved evidence.
Policy changes need a separate falsifiable repair and fixed-input validation.
SF-C now investigates g15 using the saved policy, source snapshot, and navigation manifest.

### g15 diagnosis: semantic input excluded from search

SF-C checks the original Gin publication, not a rebuilt index. The pinned go.mod exists and has 1,600 bytes.
Its SHA-256 is `9b7bd3c7674e6154d5d5fe93dc51c79e4b225302473e64fb94b421555ae69665`.
The same hash appears in the publication's source.json. There are 124 source observations, 123 navigation files,
and no unprocessed paths. go.mod is the only source-observed path absent from navigation.
The original target set is empty, and the original navigation manifest has no go.mod entry.
This is not evidence of a lost parser result or a partial publication.

The producer path accounts for that partition:

1. `assets/semantic-engine/semantic-languages.json` declares **/go.mod as a Go auxiliary with role manifest.
2. `semantic/descriptor.ts:DefaultSemanticLanguageRegistry.isAuxiliaryPath` classifies the path from that declaration.
3. `config/index-policy.ts:isObservableFileObservationByPolicy` admits auxiliary files for source observation.
4. `isIndexableFileObservationByPolicy` returns false for auxiliaries before checking extensions or exact filenames.
5. `core/indexing-pipeline.ts:readIndexableFileObservationInsideRoot` returns null when that search policy rejects the path.

A direct check of the actual policy functions returns observable=true, searchable=false under both default
and all-text profiles, with zero content-probe reads. README.md remains searchable as a neighboring case.
The measured source commit 2f52b298 contains the same early exclusion. This is not a later ARM change.

The earlier SF-D probe established that the exact-filename catalog includes go.mod and that a synthetic text
chunker can produce a chunk. Those facts remain true, but they do not prove final search admission.
The semantic-auxiliary guard runs first. The complete policy check corrects that earlier implication.

Causal status: root for the absent search coverage under the measured contract. The auxiliary declaration
and the explicit search/observation partition regenerate this outcome. Default ignore patterns and source
absence are excluded by the original source observation and saved default policy. The guard acts before
parsing, so changing the parser or reranker cannot restore this file. A catalog-only admission check is an
invalid counterfactual because it omits the authoritative auxiliary guard.

Decision: no product change in SF-C. The current contract deliberately excludes auxiliary files from search.
`docs/improvements/manifest-file-search.md` already records this limitation and defers its redesign.
`generation/auxiliary-publication.test.ts` requires the analogous Cargo manifest partition.
The proposed feature must reconcile full/delta indexing, checkpoints, ownership, and file/config ranking.
Do not remove one admission guard or weaken the 30-query oracle as a local fix.

SF-C reaches review with the diagnosis established. The capability gap remains, with its existing deferred
status. The original hit@1 10/30 and hit@5 20/30 scores remain unchanged. No new benchmark, source repair,
index mutation, model download, or deployment occurs during this investigation.

### Definition-fusion demotion: mechanism and rejected repair, 27 October 2026

Source HEAD 7ef689d6. The fusion code is unchanged since the measured commit 2f52b298. No benchmark run.

Mechanism. `fuseDefinitionDiscovery` gives each candidate a provider vote. It gives a second vote from definition-name
BM25 or, for a multi-term query, an abstention prior at rank `scores.size + 1`. Commit f12c9c31 (SEARCH-F) limits
that prior to implementation definitions with owner terms. Other candidates get only the provider vote. They then
fall below almost every implementation definition, also definitions with low provider rank. The three demoted
targets are all in that group:

- g5: the target chunk context.go:488-502 belongs to the file symbol `context.go` (kind file).
- f12: the targets are module-level `LocalProxy` variables in src/flask/globals.py, which have no definition kind.
- f15: pyproject.toml is a configuration path, so the code classifies it as supporting evidence.

Replay. `/tmp/sf-replay/replay.mts` (not kept) maps the saved `reranker_provider_output` candidates to the saved
publication symbols and runs the actual function. The replay reproduces the saved fusion order exactly for all 22
queries with `definition_fusion_order`. The other 8 queries use provider or retrieval order.

Candidate repair A gives the abstention prior to every candidate without a name match. Fusion-stage target ranks:
f12 60→3, f15 39→3, g5 44→25. Regressions: g7 5→12, g10 6→9. The other 15 replayed ranks do not change.
Decision: repair A is rejected and not committed. The regression of g7 out of the top ten disproves it as a safe
policy. g5 also stays outside the top ten.

Next falsifiable step: explain the g7 and g10 regressions from the replay before any other variant. Claim: a
narrower prior (for example, configuration and variable owners only) recovers f12 and f15 without a regression.
Disproof: any current fusion rank becomes worse. Stop after two variants with a regression and reset the diagnosis.
Post-policy steps (`preferImplementationCandidates`, grouping, diversity) still apply after fusion. Only a fresh
benchmark can confirm final scores.
