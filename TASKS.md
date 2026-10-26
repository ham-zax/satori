# TASKS

Task ledger for the rerank-blend / LateOn decision and the authorized TypeScript 7.1 migration. The orchestrator reads this file first and
takes the first task whose status is `open` with every dependency at `review` or `done`.
Only Hamza marks a task `done`. Current cross-repository benchmark run budget: 4 dispatches (3 benchmark agents, 1 final reviewer).
Earlier TypeScript migration run budget was 2 dispatches and is exhausted.

Derivation: the previous review of the 28-query A/B concluded "do not implement the LateOn gate
yet; run the held-out A/B first". No task was created for it, so T1 records that conclusion and
nothing else is invented here.

## TypeScript 7.1 run

Hamza authorizes the migration and its ledger entries on 25 October 2026. Use T3 orchestration V2,
OpenCode `zengate/deepseek-v4.1-flash-free`, `variant=max`. Run budget: 2 dispatches total,
one implementation and one independent review. One task at a time. One fix round maximum.
The orchestrator checks acceptance and moves tasks to review. Only Hamza marks done.

Goal: replace TypeScript 6 runtime APIs and the 7.0.2 build compiler with TypeScript 7.1.0-beta
throughout the first-party repository. The registry reports latest=7.0.2, beta=7.1.0-beta,
next=7.1.0-dev.20261024.1. Use beta, not a daily build.
Documentation instruction: use Open Web Search or Context7 for 7.1 docs. Open Web Search
found and fetched Microsoft's announcement with no search-engine failures:
https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/ .
The API section documents `API` from `typescript/sync`, snapshot-based incremental updates,
layered filesystems, separate AST entry points, and mandatory API/program/snapshot disposal.
Use that source plus exact beta package declarations. Content mapper protocol source:
https://github.com/microsoft/typescript-go/pull/4712 .
Refs: `docs/improvements/typescript-content-mapper-proof-plan-2026-10-24.md`,
`packages/core/src/semantic/typescript-configured-project.ts`,
`packages/core/src/semantic/typescript-compiler-provider.ts`,
`packages/core/src/relationships/typescript-semantic-analyzer.ts`, workspace manifests,
`scripts/typecheck-all.mjs`, existing TypeScript semantic and publication tests.
Design boundary: configured-project/session owns native API lifecycle and resource budgets.
Compiler-provider owns resolution and published evidence. Relationship analyzer delegates and
owns persisted resolution identity. Preserve public evidence shapes, conservative decisions,
UTF-16 to UTF-8 span conversion, config/reference semantics, budget failures, incremental updates,
and cleanup. Use `typescript/sync` and supported 7.1 AST APIs. No TypeScript 6 compatibility copy.
Keep external mapper execution disabled. Mapper trust and framework rollout remain outside this run.
No ranking changes, unrelated upgrades, new services, or git lifecycle mutations.

TaskStartSnapshot: `/home/hamza/repo/satori`, branch `master`, HEAD
`f13424902951f2123b6bcc1e27170b58286ddda7`. Pre-existing unstaged changes:
`package.json`, `packages/cli/package.json`, `packages/mcp/package.json`, `pnpm-lock.yaml`.
`TASKS.md` is pre-existing untracked work. Preserve all existing edits, including overrides and
MCP SDK/Zod updates. Use this ledger as the sole task/checkpoint carrier. No commits or branch changes.
Baseline read-set: proof plan, root/core/CLI/MCP manifests, configured-project session,
compiler-provider evidence boundary, typecheck runner. TDD Mode: off. Existing regression oracles
must remain intact. Add tests only for uncovered mechanisms introduced by the port.

Continuation: Hamza requests a solution and permits the parent to implement the port inline.
Dispatch 1 returned blocked with no runtime changes. Parent reproduced the API/CLI mismatch,
then found the probe's built=true label did not guarantee built output. Parent emitted the
reference declaration with 7.1's own getDeclarationEmit. With actual built output,
disableSourceOfProjectReferenceRedirect=true selects lib/dist/index.d.ts and reports no errors.
Use that native option to preserve declaration authority. Continue TS71-A inline, preserving
existing test oracles. Dispatch 2 remains reserved for TS71-R. No extra task or dispatch.
Hamza rejects retaining TypeScript 6 for lint tooling and requests replacing that tooling.
Replace ESLint/typescript-eslint with Oxlint 1.89.0. Preserve supported rule severities.
The compiler/parser own duplicate-parameter and legacy-octal errors, whose old ESLint rules
have no Oxlint equivalents. Native lint flags unsafe optional assertions ignored by ESLint.
Strengthen those test preconditions with assert.ok, preserving their expected outputs.
Native TypeScript deduplicates diamond-reference outputs. Keep the existing disposal fixture
and assert zero duplicate outputs plus successful disposal, replacing the TS6-bug precondition.
Checkpoint: 11 provider tests pass, 11 configured-project tests pass, 2 resolution-state tests pass,
and the extractor-script test passes. Full check, build, publication/equivalence and review remain.
Observed concurrent user state: HEAD is now b8be486e (rerank-blend change). Existing work was
staged externally during this run. Parent performs no staging, reset, commits or branch operations.
Checkpoint: build passes. All 45 publication, equivalence, Flow and lazy-analyzer tests pass
across eight files (4m 18s). Updated configured-project and resolution-state checks pass 14 tests,
including injected snapshot-disposal failure with native process closure. Four lint smoke tests
pass, including compiler coverage for the two retired ESLint rules. The workspace dependency graph shows
only TypeScript 7.1.0-beta. Focused MCP/CLI checks and final repository check are running.
Review round 1 (TS71-R) returned PASS WITH FINDINGS: 1 major, 6 minor, 1 nit. The major was a
vacuous reference-readiness check that ran whole-program diagnostics, with a test that could not
fail. Fix round 1 ran inline, with no extra dispatch:
- `referenceAuthorityReady` proves TS6305 is impossible from the referenced declaration outputs
  and returns `undefined` when outputs cannot prove it, so native diagnostics stay authoritative.
- Declaration outputs are cached by config-chain and file-list fingerprint: 1240 ms to 49 ms on
  the CLI project, and the repo's CLI/MCP projects prove readiness.
- `require()` edges in TypeScript files are restored through a session-owned module resolver,
  with a regression test that failed before the resolver existed.
- Session disposal catches and reports per-session failures, so the idle timer cannot throw and
  one failure cannot leave a disposed entry cached.
- The standalone `experiments/napi-search-projections` manifest and lockfile move to 7.1.0-beta.
Accepted and documented, not fixed: config diagnostics lose the circularity file chain (`{0}`
placeholders), Flow recovery starts one native client per file, and `getDefinitionAtPosition`
returns a reduced test probe. `@napi-rs/cli` still pins TypeScript 6.0.3 for the excluded
experiment toolchain. Re-verified: `pnpm run check`, 31 heavy publication/equivalence tests, 32
focused provider/equivalence/lazy/Flow tests, 15 configured-project/resolution-state tests, 30
MCP, 34 CLI and 5 script tests.
Adjacent finding, not a migration failure: `node scripts/sync-cbm-language-map.mjs --check`
successfully uses the new transpiler but reports a stale generated map. The unchanged map pins
CBM 11b662f9; the separate CBM checkout is at 3457b21b. Regeneration was authorized and attempted,
then reverted: CBM 3457b21b moves the definition span fields away from the `CBMDefinition` tail and
adds fields after them, so `scripts/cbm-extractor-sync.mjs` fails with `span fields are not at
CBMDefinition tail`. `emcc` 3.1.64 is available at `~/emsdk/upstream/emscripten/emcc`, but the map
cannot move until the sync script and all shipped extractor modules are upgraded together. The map
and `packages/core/assets/cbm-extractor/manifest.json` stay pinned to 11b662f9.

Follow-up authorized by Hamza: add coverage for the two reproduced review findings, fix their
owners, and integrate into the main branch. This authorizes the additional inline repair and
commit, overriding the earlier one-fix-round and no-commit limits for this follow-up only.
No new dispatches. Snapshot: clean master at e2cd3ce8, origin/HEAD=origin/master. Both migration
commits 0ffc2a51 and 344dcedd are already ancestors of master. No separate merge remains.
Repair boundary: require regular declaration files for readiness. Keep JSON metadata outside
source budgets, while charging JSON imports that the native program identifies as sources.
Native filesystem callbacks do not identify JSON read roles, so JSON source accounting occurs
after program creation. Non-JSON source reads retain their checks before reading content.
The agent-discovery handoff remains authoritative: preserve b8be486e opt-in reranking and the
measured changes in e34dd857, a395d9cf and d09c2fe8. The inspector stays on TypeScript 7.1 and
closes its API. Check run-opencode.test.mjs (37 tests), test:scripts (507 tests) and the exact
runExactRegistryFastPath start at line 227 before the follow-up commit. Eval lint warnings stay
outside this repair. The four new regression cases cover directory outputs, JSON metadata,
JSON source per-file limits and JSON override project limits. The first three failed before repair.

## Memory follow-up

Hamza authorizes the two proposed memory repairs. Start from clean master at 8886865b.
Keep the fixes inline because the two-dispatch run budget is exhausted. Preserve the handoff
commits and continue integration on local master. No new dependency or external component.
Use the session owner for bounded JSON reads, and a dedicated analyzer-owned cache for reference
state retention. Metadata must remain outside source-byte accounting. Native compiler results
remain authoritative for source identity and declaration output paths.
Acceptance targets: oversized JSON sources cannot be fully read or parsed before rejection.
Metadata remains usable within an explicit bounded read. The reference cache has byte and entry
bounds, preserves fingerprint invalidation and falls back to recomputation after eviction.
Analyzer disposal and idle cleanup release its reference cache. Compare uncached/cached results
and test mutations. Record three-run before/after measurements and focused regression evidence.
Stop when both bounds and the affected checks pass. Leave the experimental toolchain unchanged.
Reasoning checkpoint: user requests first-principles analysis before retaining any large-JSON
allowance. JevShelf selected thinking-first-principles, which was applied to three direct probes.
The CLI program reads 61 distinct package.json files and three configs, 153332 distinct-file bytes, largest
7323 bytes, with no JSON source files. resolveJsonModule=false reads no imported JSON data.
With it enabled, an imported JSON key changes a real Satori call from unresolved to Yes.run.
Two package.json files of the same 50-byte size select different executable targets, a.ts and b.ts.
Filesystem metadata can reject oversized inputs, but cannot replace compiler-required contents.
Keep native resolution/typing authoritative. Bound transport reads, retain source classification
in the native program, and do not introduce JSON type stubs or a compiler-policy copy.
JSON transport uses max(source file quota, existing 1 MiB metadata allowance) per file, and the
source project quota plus the existing 64 MiB config/metadata allowance per session. Those are
allocation ceilings, not reasons to read a file. Stat-known oversized JSON is rejected without
reading data. Growing files stop at one sentinel byte. Reference cache: 128 entries, 4 MiB of
estimated retained data per analyzer, eviction on least recent use, clear on idle cleanup/disposal.
Measurement receipt: identical 8 MiB JSON fixture, three fresh-process runs per version. Baseline
owners are copied from 8886865b into temporary modules with the same current dependencies, so
only the relevant owner changes. Command: `/usr/bin/time -f 'total_peak_kib=%M wall_s=%e' node
--expose-gc --import tsx /tmp/satori-ts71-memory-probe.mjs json` (baseline sets
`SATORI_MEMORY_BASELINE=1`). The temporary harness is removed after evidence recording.
Before/after medians: full JSON read bytes 8388620 -> 0; request phase 120.883 -> 11.072 ms;
whole-process wall time 0.57 -> 0.32 s. Node-client peak RSS median 139860 -> 106128 KiB
(136.6 -> 103.6 MiB). GNU time maximum RSS across the three runs: 141600 -> 107724 KiB.
These are process high-water marks, not a summed Node-plus-native RSS measurement.
One-minute load: 0.44-0.56 before, 0.56 after. No general repository RAM-saving claim follows.
Cache lifecycle fixture: warm proof recomputations remain zero. Disposal-retained proof entries
fall from one to zero, and a new analyzer recomputes its own proof. Before/after lifecycle phase
medians: 164.596 -> 154.419 ms; Node-client peak RSS medians 104804 -> 101220 KiB. Cache limits
and ownership, not a timing percentage, are the acceptance criteria.
Cache instrumentation initially observed a different API module instance. Those preliminary
cache counters are discarded. Final measurements observe retained cache entries directly.
Mutation evidence: returning a stale fingerprint's proof makes the real config/output mutation
test fail (cached true versus expected undefined). The original guard is restored. Thirty focused
tests and pnpm run check pass, including JSON-dependent call targets, growth sentinels, LRU/byte
bounds, fingerprint invalidation, per-analyzer disposal and metadata-only idle cleanup.

| id | status | depends | owner | acceptance | evidence |
|---|---|---|---|---|---|
| T1 | review | - | deepseek-v4.1-flash-free (T3 `node:delegated-task:command%3Amcp%3A39d636c5-d402-4155-a6a1-53cddf9f88cd%3Adelegate-task%3At1-blend-heldout-20261025-r1`) | Held-out 30q (gin, Flask) on LateOn, same build and indexes: blend-on keeps every hit blend-off has, and improves hit@1 or MRR. Per-query ranks, provenance and metric table reported. | Met on hits and on hit@1/MRR; not met on per-query rank. `/tmp/satori-blend-heldout-20261025/{off,on}`. git `8f72ce70`, dirtyTreeHash `8c327d53…`, lateon, only `rerank_blend` differs. hit@1 10→12, hit@5 20→20, MRR 0.4712→0.5078, fused recall 28/30 both, hits 24/24 with no hit lost or gained. Ranks moved on 6 cases: gained g10 6→1, g12 7→1, f4 3→1; lost g3 1→5, g8 2→8, g14 4→6. 3 up, 3 down. Verified by the orchestrator from both `result.json` and `harness-summary.md`. Logs: `/tmp/satori-blend-heldout-20261025/logs/{off,on}.log`. Decision: the aggregate hit@1/MRR gain with no hit lost outweighs the mixed per-query ranks; T2 proceeds as a LateOn-only default. |
| T2 | review | T1 | parent inline | `rerank_blend` is enabled only for the LateOn provider; an explicit `false` from the caller and from `SATORI_SEARCH_FLAGS` both win over the gate; focused tests cover both explicit-off paths. | Implemented from T1's aggregate evidence after Hamza's decision. `resolveSearchFlags` takes an optional provider default; the rerank path passes `rerankBlend: provider === "lateon"`, so the blend is on for LateOn only. `SATORI_SEARCH_FLAGS=no-rerank_blend` and an explicit `rerank_blend:false` both override it. Four new end-to-end tests cover LateOn-on, both off paths, and a non-LateOn default. Full MCP suite 1275 passed, 2 skipped. The `reranker_lateon_applied` golden snapshot now records the blended order (alpha and winner swap); no other scenario changed. |
| TS71-A | review | - | OpenCode DeepSeek V4.1 Flash, max | Port all first-party TypeScript runtime/build consumers to 7.1.0-beta, including analyzer/session/AST/config APIs and compiler-version state identity. Preserve existing semantics and resource/process cleanup. Update manifests, lockfile, affected documentation and tests. `pnpm run check`, build, existing TypeScript configured-project/provider/adversarial/resolution-state tests and TypeScript publication/equivalence tests pass. Report third-party peer constraints honestly. Refs and constraints above. | Dispatch 1/2. T3 taskId `node:delegated-task:command%3Amcp%3Ae4c682c1-b486-4947-8484-45cf645f6dad%3Adelegate-task%3Asatori-ts71-a-20261025-r1`. Returned running, provider `opencode`, model `zengate/deepseek-v4.1-flash-free`, variant `max`. Continuation authorized the parent to implement inline. All acceptance checks pass after fix round 1: `pnpm run check`, build, publication/equivalence, provider/adversarial, configured-project/resolution-state, MCP, CLI and script tests. Awaiting Hamza. |
| TS71-R | review | TS71-A | OpenCode DeepSeek V4.1 Flash, max | One read-only independent review of the complete migration diff against TS71-A, preservation of existing edits, public evidence contracts, process cleanup, resource limits, version identity, mapper execution disabled, and regression coverage. Report concrete defects with files and checks, or no findings. | Dispatch 2/2, T3 taskId `node:delegated-task:command%3Amcp%3A69ffc3e2-54fb-488f-a5c4-ed1efd0f46e6%3Adelegate-task%3Asatori-ts71-r-review-20261025-r1`. Verdict PASS WITH FINDINGS: 1 major, 6 minor, 1 nit. No blocker. Findings 1 and 2 fixed in round 1, finding 3 fixed with a regression test, finding 5 hardened, finding 7 corrected. Findings 4, 6 and 8 documented as accepted. Re-verified by the parent. Awaiting Hamza. |
| TS71-F | review | TS71-A, TS71-R | parent inline | Regression tests reproduce directory outputs accepted as declarations and metadata counted as source. Repair both without bypassing JSON-source budgets. Focused semantic and publication checks plus pnpm run check pass. Commit the scoped fix on master, preserving existing migration commits. | Inline repair from clean e2cd3ce8. Three regression cases failed before repair. Final checks pass: pnpm run check, 43 core tests across five files, 37 agent-discovery eval tests, 507 script tests. Task-key start remains line 227. Only this ledger, the two owning files and their focused test file change. The scoped commit integrates on master, which already contains all handoff commits. Awaiting Hamza. |
| TS71-M | review | TS71-F | parent inline | Bound JSON allocation before native parsing without treating metadata as source. Bound and own reference-cache retention, with cleanup and unchanged readiness results. Three-run measurements, mutation checks, focused tests and repository check pass. Integrate on local master. | Authorized inline follow-up from clean 8886865b. No new dispatch. Three-run evidence above: oversized JSON data reads 8388620→0 bytes, phase median 120.883→11.072 ms. Cache disposal releases proof entries, warm lookups avoid recomputation, stale-fingerprint mutation fails the regression. Final checks pass: 76 core tests across 12 files, 507 script tests, pnpm run check, git diff --check. Exact-target start remains line 227. Scoped integration on local master preserves all handoff commits. Awaiting Hamza. |
| DEP-A | review | TS71-M | parent inline | Update npm dependencies across all first-party manifests and both lockfiles to current latest releases. Preserve TypeScript 7.1 beta and workspace links. Raise Node minimum to 22.22, as Hamza authorizes, and synchronize managed native-runtime versions. Repository check, build, scripts, affected runtime tests and experiment checks pass. Record upstream constraints. | Direct request on 25 October 2026. Snapshot: clean master 7cfee54f. No dispatches. Updated 13 direct npm dependencies including napi CLI 3.10.9 and Chokidar 6. Both outdated checks return {}. Check/build/507 scripts pass. Core reports 1083 passed, 2 skipped. MCP: 1251 source tests and 2 compiled real-model tests pass on Node 22.22. CLI: 482 pass on Node 22.22. Native Chokidar event/cleanup passes. Napi debug/release builds, typecheck, 20 fault tests and 17 release tests pass (3 release-only skips). Upstream constraints and source-harness limits below. Final diff checked. Integrate on local master. Awaiting Hamza. |
| LOCAL-A | review | DEP-A | parent inline | Show how agents use the unpublished local build. Measure current LateOn and Voyage rerank-3-lite through local MCP on the same 28 pinned queries, current oracle and frozen build. Use the same task-owned index and local embeddings. Activate all supported clients after Hamza selects them, preserving unrelated settings, models and ranking code. Report quality and execution failures honestly. | Code build 9753ced1. No dispatch. Matched current-oracle runs: LateOn MRR 0.585, hit@1 14/28, hit@5 22/28; Voyage rerank-3-lite MRR 0.958, hit@1 26/28, hit@5 28/28. All queries return ok, with no reranker failure markers. Same source commits, navigation manifests, flags and oracle hash. Both process scopes exit 0. Hamza selects all clients. Canonical local activation and preflight pass, and config readback checks Codex/Claude/OpenCode/AGY use the stable launcher. Launcher now selects repo packages/mcp/dist/index.js with offline/LateOn. Restart existing MCP client connections to load it. Evidence below. Awaiting Hamza. |
| VS-A | review | LOCAL-A | OpenCode DeepSeek V4.1 Flash, max | Benchmark local offline Satori against codebase-memory-mcp on QAP. Freeze 12 balanced source-backed tasks before scored tool calls. Check coverage and current APIs. Save raw replies, task answers, citations, score method, reproducible commands and setup failures. Read-only source. Refs: cross-repository protocol below. | Dispatch 1/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-qap-20261025-r1. Returned running, provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Parent baseline b7ef625d, clean. QAP HEAD 2ce9820d has user staged/unstaged work, so snapshot committed HEAD without altering that checkout. Child writes only its qap artifact directory. Parent checks artifacts on return. VS-B and VS-C may run in parallel, each with one scoped task. Parent artifact check: Final handoff received. Parent checks 12-task frozen pack hash and complete result record. Both sessions closed. Readiness adapter caused 45.1-minute wait after publication completed in about 14 seconds, corrected without rerun. CBM call-path path normalization rescored from preserved raw replies, with original scores archived. Citation-rule and architecture scoring disclosures require final review. Scores remain provisional pending VS-R. |
| VS-B | review | LOCAL-A | OpenCode DeepSeek V4.1 Flash, max | Choose a different local repository and justify the choice. Apply the same 12-task protocol against local offline Satori and codebase-memory-mcp. Use a different artifact directory and snapshot. Save evidence and limitations. Refs: cross-repository protocol below. | Dispatch 2/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-selected-20261025-r1. Returned running. Provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Independent of VS-A/C. Agent selects a repository other than Satori, QAP, Claive, React, Polars or FlatBuffers. Heavy indexing uses the shared resource gate. Checkpoint: Lingua OS selected at 4b18dfc1. Index report records unchanged snapshot and 15 oracle files. Frozen pack has 12 tasks. All 24 provider reply files and a finished run manifest exist. Initial task summary covers setup only, and T3 reports later child work pending. Final scoring/report and parent acceptance remain incomplete. QAP and Claive still run. Parent artifact check: Lingua OS final handoff received through latestTerminalSummary, no pending child runs. Parent checks frozen pack hash, completed 24-reply final manifest and report. Three runs exist: two harness iterations archived and excluded. All sessions/processes closed. Rank and citation normalization, excluded iterations and report aggregate need final review. Scores remain provisional pending VS-R. |
| VS-C | review | LOCAL-A | OpenCode DeepSeek V4.1 Flash, max | Benchmark local offline Satori against codebase-memory-mcp on /home/hamza/repo/claive using the same frozen 12-task protocol. Own only the claive artifact directory and snapshot. Save raw evidence, citations, scoring and setup limits. Read-only source. | Dispatch 3/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-claive-20261025-r1. Returned running. Provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Independent of VS-A/B. Claive is reserved from VS-B selection. Heavy indexing uses the shared resource gate. Parent artifact check: Final handoff received. Parent checks 98-file integrity manifest and frozen pack hash. Sessions/processes closed. Report and deterministic scores exist. Known objection: zero completed CBM discovery tasks still yield a nonzero MRR; reviewer must distinguish answer completion from tool support and incidental overlap. Both architecture responses lack required responsibilities. Scores remain provisional pending VS-R. |
| VS-R | review | VS-A, VS-B, VS-C | OpenCode DeepSeek V4.1 Flash, max | One independent review of all three benchmark artifacts. Check source witnesses, frozen oracles, equal task conditions, coverage, unsupported-call classification, citations, scoring arithmetic and limits. Read-only. No new benchmark or second review round. | Dispatch 4/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-final-review-20261025-r1. Returned running. Provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Packet includes all three original scopes, reports, parent checks and six unresolved method/scoring objections. Advisory artifact audit only, no new runs or product edits. Final execution failed on OpenCode free-usage quota, with no pending child runs. A complete written advisory report.md and claims.json were saved first (13 findings, 9 conditions, conditional pass only for bounded repository/task-type claims). Parent checks key scorer predicates and reporting issues, applies them in cache final-summary.md, and stops the failed task queue. No clean terminal reviewer handoff is claimed. No retry or new provider dispatch; budget 4/4 exhausted. Original benchmark scores remain frozen. Only Hamza marks done. |
| FIX-A | review | VS-A, VS-C | parent inline | Investigate the reported missing Python channels.send_peer caller and scoring defects. Reproduce before changing Satori. Fix only demonstrated owners with focused regression checks. Preserve frozen benchmark oracles and no full reruns. | User authorizes fixing issues found by agents. Parent reproduces the missing second repeated-import call before repair. One regression covers module and named imports plus conflicting modules and rebinding. Python import proof now accepts identical repeated declarations and rejects later assignments. Provider revision and relationship cache witness advance to v3. 49 focused core tests, 507 script tests, pnpm run check/build pass. Real unchanged Claive source restores main→send_peer at cli.py:2560. Fresh isolated MCP publication and trace_path confirm CALLS, direct_binding, targetProofBacked=true, with no truncation or warnings. Local activation for all clients passes. Source baseline b7ef625d. No original benchmark score is changed. Final artifact audit remains independent and pending. |
| SEARCH-F | review | VS-B, VS-C | parent inline and Claive Pi diagnosis | Repair split dense/lexical votes for a published owner and definition ordering that suppresses relevant bodies. Preserve evidence chunks, abstention for unknown owners, existing definition gains, Voyage authority and frozen benchmark scores. Focused regression tests, candidate replay and local MCP diagnosis pass. | Hamza authorizes both repairs and separate logical commits with the staged semantic work. Claive e9254bfc3e03, session 2a5bd9d1-0ab8-4c75-87cb-419395c84eb0, uses Pi deepseek-v4.1-flash-free at max and completes read-only diagnosis. Parent checks its diversity-cap explanation, repairs ordering upstream, and adds a dense-representative budget regression. Worker closes. Core fusion/projection checks: 29 pass. Semantic checks for staged repairs: 85 pass. MCP search/grouping/disclosure/cache checks: 290 pass. pnpm run check passes. Fresh LateOn MCP returns recordAssessment at rank 2 and applyAsrAttributionPolicy at rank 7, previously absent from ten. Four control ranks stay 1, 3, 2, 2. Pending-sync replies are excluded explicitly. Final representative check repeats both target ranks and selection rank 1. Exact baseline replay succeeds on 25 cached definition inputs. Final replay retains every rank-one owner, with r2 5 to 6, r3 32 to 14, and f7 10 to 8 before disclosure. This is no full 28-query quality claim. Original benchmark oracles and scores remain unchanged. Evidence: selected/evidence/diagnosis under the existing cache artifact root. Semantic work commits separately as 8f6a8ec9. Only Hamza marks done. |

| ID-A | review | - | Claive Pi DeepSeek max | Derive parser identities from installed parser/compiler package versions. Compose relationship identity from lightweight provider-owned revisions, preserving existing provider exports and stable environment identities. Replace the duplicated literal test with regression evidence for dependency/provider invalidation. No behavior hashes or schema changes. | Authorized identity repair. Baseline clean master f12c9c31. Claive worker bc8611e54e3f, session 14c3961e-d1b6-4c13-b61f-55bc0659c0b2, Pi/opencode2api deepseek-v4.1-flash-free at max, completed ID-A. Parent independently runs 11 focused tests and the core build, both pass. Refs: language-analysis/versions.ts, relationships/resolution.ts, semantic/typescript-compiler-provider.ts, semantic/descriptor.test.ts and core package metadata. |
| ID-B | review | ID-A | Claive Pi DeepSeek high | Own embedding/lexical/Potion identities in one dependency-free core leaf module. Reuse them in core and CLI without adding a CLI runtime dependency on core. Package the leaf through the existing CLI build copy step. Add scoped contract and packaged-startup checks to existing verification, preserving unrelated version owners. | Claive worker bc8611e54e3f reused for turn 2 at high, scoped implementation packet id-b.md. Completed. Parent independently checks 96 CLI tests, eight script tests and the ownership check. All pass. Core and CLI builds pass. Refs: core/core/search-projections.ts, core/embedding/potion-embedding.ts, core/index.ts, cli/local-runtime-contract.ts, CLI build/files metadata, scripts/check-version-freshness.mjs and tests. |
| ID-R | review | ID-A, ID-B | independent Claive Pi DeepSeek max | Review the complete identity repair once. Check installed dependency authority, cache invalidation, stable schemas/config identities, lightweight imports, standalone CLI packaging and tests. No broad version migration or new service. | Final independent review after parent checks. Claive reviewer fb44699bed2a, Pi/opencode2api deepseek-v4.1-flash-free at max, checked running. Parent checks 175 focused tests, builds, pnpm run check and the 99-file CLI tarball. Reviewer finds no high/medium defects. Parent fix round strengthens the complete identity-component oracle using provider-owned revisions and builds CLI artifacts in its standard test command. That full command passes all 486 CLI tests. Final verification covers 71 core tests, 486 CLI tests, eight script tests, repository check, standalone runtime/types and final tarball contents. Default dependency-layout failure testing remains a low gap. Copied optional source-map references are informational. Package versions stay unchanged by explicit request. The release-bump CI guard remains a known policy limitation. Three Claive turns are used and both workers are closed. Only Hamza marks done. |

| RT-A | review | ID-R | parent read-only | Check the supplied LateOn readiness/restart finding against current owner code and tests. Report confirmed paths, exceptions and missing coverage. No runtime source changes. | User queues this inspection after identity repair. Identity repair commits and pushes as e4892d67 with no package bumps. Parent confirms stale readiness during termination and missing recoverable-unhealthy restart with a deterministic compiled-owner state probe. No worker/model process starts. Evidence cache: satori-runtime-findings-20261025/lateon.json. Existing idle path already awaits termination. Refs: packages/mcp/src/server/lateon-reranker.ts and its test. |
| RT-B | review | ID-R | parent read-only | Check the supplied shared-runtime idle shutdown/handshake finding against current lifecycle locking and tests. Report evidence and limits. No runtime source changes. | Parent confirms closing before lifecycle lock acquisition and onlyIfIdle closing an active session. Deterministic probe uses a held disposable lock and fake runtime, no live sockets. Evidence cache: satori-runtime-findings-20261025/shared-runtime.json. Normal attach test does not hold the lifecycle lock. Default idle 60s versus handshake timeout 10s narrows the separate pending-handshake scenario. Refs: packages/mcp/src/server/shared-runtime-host.ts and its test. |
| RT-C | review | ID-R | parent read-only | Check the supplied Python fallback allocation, file-read caching and triple-quoted span findings against current owner code and tests. Report evidence and limits. No runtime source changes. | Parent reproduces a column-zero triple-quoted body ending at line 2 instead of line 5, two concurrent reads for one file, and three repeated denied reads. Evidence: `/home/hamza/.cache/satori-runtime-findings-20261025/python-fallback.json`. |
| RF-A | review | RT-A | Claive Pi DeepSeek high | Repair LateOn readiness during worker termination and restart from recoverable unhealthy state. Add deterministic tests for waiters during replacement, replacement bootstrap failure, and close interaction. Preserve initial bounded bootstrap retries, terminal failure, cancellation and queue behavior. Own only `packages/mcp/src/server/lateon-reranker.ts` and `packages/mcp/src/server/lateon-reranker.test.ts`. | Claive 38a524388e2c, Pi/opencode2api deepseek-v4.1-flash-free high. Parent reviewed the 24-line source diff and three event-gated tests. Focused command `env -u SATORI_LATEON_MODEL_PATH pnpm --filter @satori-code/mcp exec node --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=8 src/server/lateon-reranker.test.ts` passes 28 tests, 2 optional model tests skip. `git diff --check` passes. |
| RF-B | review | RT-B | Claive Pi DeepSeek high | Repair idle shutdown locking and session/handshake accounting. Track pending handshake sockets, acquire the lifecycle lock before closing admission, recheck idleness under lock, and clean pending sockets on forced shutdown. Add deterministic tests using owned disposable locks/sockets. Preserve protocol, authorization and session shutdown order. Own only `packages/mcp/src/server/shared-runtime-host.ts` and `packages/mcp/src/server/shared-runtime-host.test.ts`. | Claive 10819b33eaa0 timed out at 600 seconds after writing the assigned source and test files; no follow-up used. Parent reviewed the diff and applied it. Focused `shared-runtime-host.test.ts` first had one 2-second oversized-frame timeout; the isolated case passed, then the full file passed 21 tests. `git diff --check` passes. |
| RF-C | review | RT-C | Claive Pi DeepSeek high; parent completes | Repair Python fallback index construction, per-file read deduplication and triple-quoted function span recovery. Preserve candidate order, source authorization and uncertain-span abstention. Add focused tests for both triple-quote styles, strings/comments, sibling boundaries, cached denied reads and same-file index scope. Own only `packages/mcp/src/core/python-call-fallback.ts` and `packages/mcp/src/core/python-call-fallback.test.ts`. | Claive e293ae446ef1 timed out at 600 seconds during test edits. Parent reviewed and applied its saved diff, then narrowed the span scanner to preserve existing header behavior and added a guard against repository-wide symbol access. Focused `python-call-fallback.test.ts` passes 17 tests. `pnpm --filter @satori-code/mcp run typecheck` exits 0. `git diff --check` passes. |
| RF-R | review | RF-A, RF-B, RF-C | independent Claive Pi DeepSeek max | Review the integrated runtime fixes once. Check lifecycle invariants, deterministic failure-path tests, output equivalence and scoped changes. No new implementation or test runs. | Claive 7f98cdbea476, Pi/opencode2api deepseek-v4.1-flash-free max, timed out at 600 seconds before issuing a report. Parent completed a manual audit of all six MCP source/test files. No additional blocker found. Only Hamza marks done. |

## Runtime defect repair

Hamza authorizes repairs for the three confirmed findings. Use three independent Pi DeepSeek
high implementation turns and one final independent Pi DeepSeek max review. One fix round.
Keep package versions unchanged. Parent integrates worktree diffs, runs focused checks serially,
then commits and pushes the scoped repair.

## Identity repair run

Hamza authorizes the relevant confirmed fixes and Claive Pi delegation at max or high.
Use Pi/opencode2api deepseek-v4.1-flash-free: ID-A max, ID-B high, final review max.
Run cap: three scoped Claive turns,
two implementation tasks on one reusable worker and one independent final review.
Old benchmark and migration budgets remain unchanged. Parent owns ledger and Git operations.
Hamza explicitly forbids package version bumps. Preserve current package versions. After the
identity repair, inspect the separately supplied LateOn restart, shared-runtime idle shutdown,
and Python fallback findings. Those investigations do not expand the identity patch.
Snapshot: clean master f12c9c31. Decision: code-change at identity owners. No new dependency,
service, schema migration or code-content hashing. Existing CLI build copying can bundle a
dependency-free core contract so the installer works before the managed core is installed.
Retire duplicate values, preserve established exports, and keep configuration identities
separate from behavior revisions. Tests cover invalidation and packaged startup. Only Hamza marks done.

Brief retrospective: repository-root package probes missed pnpm-local dependencies. Resolve
from the owning package, as the new reader does. The new packaged-contract tests exposed a
build prerequisite in the CLI test entry. The standard entry now builds it explicitly.
Existing checks cover both failures, so no additional guard or workflow rule is proposed.

## Dependency refresh checkpoint

Scope: npm dependencies in the root, core, MCP, CLI and standalone napi experiment. The static
landing manifest has no dependencies. Rust crates and the pnpm executable are separate toolchains.
Registry `/latest` metadata is the version authority. TypeScript remains 7.1.0-beta, newer than
the registry's stable 7.0.2. Transitive dependencies keep their upstream constraints. In particular,
the Express router still requires path-to-regexp 8, so its security override advances to 8.4.2,
not the incompatible 9.0.0. Existing fast-uri resolution was already 4.2.3.

Updated manifests include napi CLI 3.10.9, tsx 4.23.15, Node types 26.6.5, LanceDB 0.40.0,
Oxc parser 0.155.0, Transformers 4.3.1, OpenAI 7.43.0, Google GenAI 2.31.0, ignore 7.0.14,
web-tree-sitter 0.27.1, MCP SDK 1.32.2 and Zod 4.6.7. Other direct dependencies already match
latest. The CLI native closure and active LateOn profile now match the new runtime versions.
The acquisition manifest binds the updated profile digest. Historical evaluation receipts stay intact.

Node types 26 remove an incidental ES2022 library reference and tighten worker error, socket
data, IPC and assertion signatures. The explicit compiler library becomes ES2022, supported by
the existing Node minimum. Worker rejection types now accept unknown values without changing
the rejection or cleanup. Test assertions retain their conditions. Existing IPC connectivity
proves the disconnect method exists. No new runtime branch or compatibility copy is added.

Checks passed: pnpm run check, pnpm run build, 507 script tests. Core tests run with concurrency
two, heavy publication tests with concurrency one, to bound WSL memory. Remaining: core result,
MCP/CLI runtime checks including the real local LateOn model, standalone napi build/tests/typecheck,
final diff and registry comparison. Hamza approves Node >=22.22 and Chokidar 6. Update all
published engine floors, doctor boundary cases, current support docs and the CI minimum matrix.
Existing historical measurements retain their original Node versions. Install Chokidar after
the active core run finishes, then check the watcher and full MCP/CLI suites.
Upstream LanceDB still declares an Arrow <=18.1 peer despite the existing Arrow 21.2 dependency.
The napi CLI still carries its own TypeScript 6.0.3, isolated from first-party TypeScript 7.1.

Runtime evidence: the final registry comparison reports `{}` for both workspace and standalone
outdated checks. Chokidar 6 observes a real file change and closes on Node 22.22.0. MCP's source
run on that Node passes 1251 tests, but its two opt-in real-model tests fail: the unchanged encoder
thread requests `src/server/lateon-reranker-encoder.js`, which does not exist in the source tree.
A direct worker launch reproduces ERR_MODULE_NOT_FOUND. Both unchanged real-model oracles pass
from `dist/server/lateon-reranker.test.js` on Node 22.22.0, including exact scores/ranking across
encoder pools. This checks the production runtime without changing the oracle or worker code.

Final evidence: both installs and pnpm run check/build pass. Both pnpm outdated checks return
`{}`. Core's normal and heavy commands report 1051 and 32 passes respectively, with two skips.
MCP's unchanged default source LateOn file passes with its two real-model cases skipped. Those
two cases pass against compiled output. All 482 CLI tests pass on actual Node 22.22.0.
The first CLI run used an npm-provided Node executable beneath node_modules, exposing four
existing broad installer assertions. The identical binary copied to an ordinary temporary path
passes all cases without assertion changes. The standalone napi package passes TypeScript 7.1
typecheck, debug/release builds, all 20 fault tests and 17 release tests (three fault-only skips).
The final addon is the ordinary release build. No Rust source or Cargo lockfile changes.

Retrospective: source-model checks hide the missing JavaScript worker entry until enabled.
Installer assertions confuse the Node executable with a direct managed-runtime module path.
Both code follow-ups remain proposals in docs/improvements/dependency-refresh-test-followups-2026-10-25.md.
The initial standalone install omitted --ignore-workspace and selected the root workspace.
Its README already gives the correct command, which the final install and checks use.
Future runs must read standalone commands before invoking pnpm. Final self-review finds no
additional in-scope defect. Runtime code changes only widen rejection types and preserve the
guarded IPC call. No new runtime owner, branch, fallback or compatibility layer is introduced.

## Local build comparison, 25 October 2026

LOCAL-A uses the fresh build at 9753ced1. Only this ledger differs from that commit.
Do not edit the build or ledger between provider runs. The harness connects an MCP client to
packages/mcp/dist/index.js directly, reuses installed local model files, and makes no client
configuration or npm-release changes. Model paths and the Voyage credential are available.
Fresh state: /home/hamza/.cache/satori-eval-state-local-9753ced1-20261025-r1 .
Results: /home/hamza/.cache/satori-eval-results/local-9753ced1-20261025-r1/{lateon,voyage} .
Use the current unchanged evals/real-repo-quality/cases.json, 28 queries. Run run.mjs with
--flags rerank_blend=false and that state root. LateOn builds the fresh index. Voyage reuses
it with --reuse-index and rerank-3-lite. SATORI_EVAL_RUNTIME_ENV sets only the reranker and,
for Voyage, its model. Embeddings remain Potion, storage remains LanceDB. Scope both runs
sequentially with systemd MemoryMax=4G. The tool environment needs the existing user bus at
/run/user/1000/bus. No performance percentage, latency median, or held-out generalization claim
follows from these two quality runs. Next: check terminal indexing/coverage, provider identity,
tool errors and quality summaries, then explain local activation commands and report results.

Final LOCAL-A evidence: both runs exit 0. All three repositories publish readable indexes with
verified source parity. Each arm uses the same six repository-head/manifest-path metadata
records (index-witness.tsv), and the state contains exactly three navigation manifests.
Provenance matches: git 9753ced1d326799013f5a4e1a9e68e2d88270bc1, ledger-only dirty hash
4910b7c9ed5f9a6d415af349a12570e9d09d37ea84c20acc00c1a3b298895e90, oracle SHA256
9266efeb025d8836619e5328380303d8ba99ae8a756426066a6e3840aa9f2bc7. Both arms retain
rerank_blend=false and behavior_alt_terms=true. Dense/lexical/fused owner recall is identical:
21/28, 20/28, 25/28. The provider is the only changed runtime selection.
LateOn: MRR 0.585, hit@1 14/28, hit@5 22/28. Voyage rerank-3-lite: MRR 0.958,
hit@1 26/28, hit@5 28/28. No RERANKER_FAILED or LateOn failure markers appear in either
harness log. This is one quality run per provider on the 28-query benchmark.

Hamza then selects all supported clients. Run:
pnpm run dev:install-local-mcp -- --client all --runtime offline --reranker lateon --no-build .
The installer reuses the checked build, performs MCP initialization/tool preflight, and updates
Codex, Claude, OpenCode and AGY without an npm release or installation. Parsed configuration
readback checks every client points to ~/.satori/bin/satori-mcp.js. Parsed launcher readback
checks Node 24.19.0 and /home/hamza/repo/satori/packages/mcp/dist/index.js, with offline/LateOn.
Voyage comparison does not persistently change the active profile. Existing client connections
need a restart. No ranking code, model data or unrelated client setting is edited.
The results, activation log and task-owned index remain in the cache paths above for inspection
and future comparisons. Both systemd process scopes terminate. Repository delta is this ledger
only, recording the successful run and activation. No new implementation task remains.

## Cross-repository MCP benchmark protocol, 25 October 2026

Direct user request: two or three OpenCode DeepSeek workers through T3 orchestration V2.
Use provider opencode, model zengate/deepseek-v4.1-flash-free, target option variant=max.
Hamza clarifies: one scoped task at a time PER AGENT, with parallel agents permitted.
Four dispatches: three parallel benchmark workers, then one independent review of all results.
VS-A, VS-B and VS-C are independent. VS-R waits for all three to reach review. No recursive delegation. Parent alone edits this ledger
and performs Git lifecycle operations. Workers share the Satori checkout but own disjoint
artifacts at /home/hamza/.cache/satori-agent-vs-20261025/{qap,selected,claive,review}. They are not
alone in the workspace and must preserve every existing edit. No source fixes or refactors.

Baseline read-set: evals/code-intelligence-vs/README.md and tasks.json,
scripts/code-intelligence-vs.mjs, evals/real-repo-quality/session.mjs,
packages/cli/assets/skills/satori/SKILL.md, target README and applicable AGENTS.md.
The first two references describe an existing deterministic retrieval/navigation harness,
not a blinded LLM answer-quality experiment. Do not claim a blinded agent comparison.
The existing harness may describe retired call_graph APIs. Inspect live schemas before use.
Current Satori exposes trace_path and find_references. Stale adapter calls are harness defects,
not evidence of provider failure. Task-owned adapters outside the source checkout are allowed.

Freeze the selected repository's committed HEAD in a task-owned source snapshot, for example
with git archive into a new artifact directory. Record original HEAD, initial dirty status and
snapshot content witness. Never reset, stash, checkout, delete, execute application scripts,
trade, contact exchanges, or change the original target repository. QAP currently has user
edits, so do not benchmark its moving working tree or silently claim those edits are included.
Use the same immutable snapshot for both providers. No target dependency installation needed.

Freeze questions and acceptable evidence before scored calls: six owner-discovery tasks, two
call-path tasks, two reference tasks, one file outline and one architecture task. Derive each
oracle from source with file, symbol and relevant lines. Use naturally worded questions. Do not
put exact owner paths or symbols in discovery questions. Exact navigation tasks may name their
target. Preserve the oracle after seeing responses. Record calls and useful citations for every
answer. Source reads establish goldens and check returned citations, not repair a failed tool arm.
Counterbalance provider order across tasks and disclose the shared-agent/open-book limitation.
Count answer correctness, citation validity, task completion, unsupported operations, failures
and tool calls. Rank/MRR applies only to the six owner-discovery tasks with ordered candidates.
Unsupported/not-ready calls cannot pass from incidental text overlap. State task-type results
separately instead of inventing one aggregate capability score. No latency superiority claim
from one run; record timings as observations only.

Use the current local Satori dist build directly, active offline Potion/LanceDB/LateOn settings,
and a dedicated SATORI_STATE_ROOT per worker. No npm release/install, provider config rewrites,
Voyage disclosure of private target source, external services, ranking changes or oracle widening.
Local models are installed. evals/real-repo-quality/session.mjs provides an existing MCP session
owner for isolated Satori state. Build must remain frozen during measurement.
CBM binary: /home/hamza/.local/bin/codebase-memory-mcp. Its native tools are already available.
Use its canonical existing cache/daemon. CBM refuses a different CBM_CACHE_DIR while another
canonical session is live. Do not stop or replace shared services, binaries or existing indexes.
Create a uniquely named project for the snapshot and check cited-path index coverage before
scoring. Existing home-hamza-repo-qap refers to the mutable original and is not the frozen copy.
Parallel research and question preparation are allowed. Heavy provider indexing shares a
resource gate. VS-A creates qap/setup/resource-gate-ready.json only after its existing heavy
job drains and it adopts the shared gate. VS-B and VS-C may prepare immediately but wait for
that marker before heavy indexing. All workers then use an exclusive OS flock at
/home/hamza/.cache/satori-agent-vs-20261025/indexing.lock around each heavy indexing session,
held until its indexing work and owned session have closed. This shared lock file is the only
shared write permitted beyond each artifact directory. Never kill another worker or service.
Bound Satori with
the established systemd user scope MemoryMax=4G when available, using the existing user bus
/run/user/1000/bus. End owned MCP sessions and processes before returning. Retain result/index
artifacts for inspection and report their paths. If setup cannot be completed safely, stop with
raw blocker evidence, not substitutions or changes to the product. TDD off, research only.

Each worker returns: selected repository/snapshot identity, methods, provider versions and tool
surfaces, index/coverage readiness, frozen task pack, per-task raw evidence and scored answers,
summary by task category, commands, unresolved limits and side effects. Parent checks artifacts
and arithmetic, appends evidence, and moves the row to review before the final review. Independent ready rows can be dispatched together.


## Benchmark delay checkpoint

User reports a 40-minute delay. Parent confirms QAP adapter satori-index-wait.mjs checks
status ready at lines 9/21 although live manage_index returns ok. Its 45-minute deadline
held up the shared resource gate. Lingua OS task pack existed at 15:04:35 IST, gate opened
at 15:23:42, and its index report completed 15:24:39. Its first 24-call run took about
28 seconds. Extra repeat manifests also exist and need disclosure in the final review.
Parent should have caught the readiness predicate mismatch when earlier polls showed ok.
All workers now have score artifacts. Parent steers each to final handoff with no new runs.
VS-A is asked to correct only its task-owned readiness helper for reproduction and preserve
original logs. VS-C final report arrived: owned sessions/processes closed, 98-file manifest.
Parent has not accepted the Claive scoring yet: the report lists CBM discovery completion
as zero but still computes an MRR from incidental ranks, which must be audited against the
protocol before any provider ranking. Final reviewer must examine this objection and the
readiness defect. No final winner is claimed.


## Python call-proof repair receipt

User authorizes fixing issues reported by the agents. FIX-A is an owner-local repair in
pythonFallbackProofSteps, with no new service, state, API shape or dependency. Two identical
visible imports previously made imported.length differ from one, suppressing exact import proof
for the later call even though target resolution found the same destination. A minimal regression
failed before repair. The shared import-proof append step compares binding kind, module and
imported name, and refuses a binding overwritten by a visible assignment before the call.
The test exercises repeated module/named imports and preserves abstention for conflicting
modules and unknown rebound values. Existing resolution checks remain intact.

Native provider version is bounded-origin-v3. The Python relationship-builder identity advances
to python-native-resolution-v3 so persisted evidence is refreshed rather than reusing old misses.
The semantic environment settings identity remains unchanged. Parent checks 49 focused tests
across Python resolution/contribution, semantic identity, sidecar validation and publication
workflow. pnpm run check, pnpm run build and all 507 script tests pass.

Source and MCP checks live at /home/hamza/.cache/satori-agent-vs-20261025/fixes/python-proof .
real-source-probe.mts reads three unchanged Claive source files and confirms direct-binding
main→send_peer at bin/claivelib/cli.py:2560. mcp-c2-probe.mjs indexes the unchanged full Claive
snapshot into a new isolated state, then resolves exact symbols and calls public trace_path.
mcp-c2-result.json reports found=true with one CALLS edge at line 2560, direct_binding and
targetProofBacked=true, no warnings and no traversal truncation. The original benchmark state,
oracles and scores are untouched. The probe closes its session and its systemd scope exits.
All four client configurations retain the local runtime. Canonical local activation/preflight
passes after rebuilding. Existing MCP connections need reconnection, and affected existing
indexes need fresh relationship evidence to expose the new edge. No new full benchmark runs.


## Benchmark final reporting checkpoint

VS-R provider execution fails on the free-usage limit after saving
/home/hamza/.cache/satori-agent-vs-20261025/review/report.md and claims.json.
Repeated quota notifications do not authorize extra review rounds. Parent stops the failed
delegated task queue and does not dispatch another model. The written audit is recovered
advisory evidence, with no successful terminal handoff claimed. Parent checks its central
findings against scorer code, preserved replies, manifests and the existing report history.

Corrected bounded publication is /home/hamza/.cache/satori-agent-vs-20261025/final-summary.md .
Owner-discovery MRR@10 stays repository-specific: QAP Satori 1.0000 vs CBM 0.7500; Lingua OS
0.3889 vs 0.1556; Claive 0.4722 vs 0.0750. No pooled score or general provider ranking.
Claive completed means met top-3 threshold, not an unsupported MCP call. QAP call paths
check names/files, not site lines; stale CBM citation precision is withheld. Lingua publishes
run 3 after two disclosed adapter iterations, with architecture citation N/A for CBM. QAP
class-level pair-rotation evidence is present at rank 3 but fails the unchanged exact-method
oracle. Different architecture predicates do not establish one comparable capability.
The later Python production fix has independent regression/MCP proof and does not rewrite
these pre-fix scores. All source work is already committed and pushed as 1fa26e08.


## Priority repair run, 26 October 2026

User authorizes P0 inline, P1 on GPT-6.1-sol low/medium, and P2/P3 on OpenCode
DeepSeek max through T3 V2. The model reading follows the existing DeepSeek naming.
Run budget: four scoped worker turns. Latest user instruction replaces the delegated review with a handoff follow-up and final parent review.
One scoped task per agent. Independent nodes may run in parallel, as Hamza clarified.
One fix round, two only for a demonstrated public-contract risk. Parent alone edits this ledger.
No package version bumps, publishing, model downloads, live index deletion or original-score edits.
TaskStartSnapshot: master 47821dde. Twelve staged files contain the existing installer repair
and benchmark reports. Preserve every staged edit. P0 reuses that repair and strengthens its
packed native-API check. Each worker owns separate files and must preserve peer edits.
Method: subagent-driven-development and long-task-continuation with this ledger as sole state.
Fit gate: preserved transcripts and the common corpus define failures; focused regression checks
are executable; a wrong proof claim corrupts evidence, so preserve abstention; delegation splits
three independent owners while parent checks client installation.

| id | status | depends | owner | acceptance | evidence |
| PR-P0 | review | - | parent | Required TypeScript 7.1 platform compiler installs with optional dependencies omitted. Existing closure manifests invalidate missing compiler identity. Packed runtime creates and closes the native API and parses a source file. Preserve versions and staged work. Refs: packages/cli/src/managed-runtime-closure.ts, install-application.ts, managed-package.ts, CLI manifest, packages/cli/scripts/release-smoke.ts, scripts/release-graph.mjs and focused tests. | Existing staged repair. Clean isolated omit-only install fails and explicit binary install starts/closes API. 110 installer tests and 30 release-graph tests pass. Packed API proof runs in managed exec session 7448, log /tmp/satori-pr-p0-packed-smoke.log. Parent added a real API createSourceFile call with retained-file disposal and API close in finally. Packed smoke exits 1 after native TypeScript API parse/disposal/close pass, during the later independent Potion readiness check. Log: /tmp/satori-pr-p0-packed-smoke.log. Packed runtime size 963988221 bytes stays below 1006632960-byte budget. Full release smoke is not green; Potion timeout remains an integration limitation. |
| PR-P1A | review | - | T3 GPT-6.1-sol medium | Investigate and repair lost TypeScript proof evidence and authority at the actual converter/provider owner. Preserve exact targets, abstention and immutable common-corpus assertions. Run common qualification and focused semantic checks. Explain any unsupported oracle expectation rather than synthesizing proofs. Own core relationship TypeScript converter/provider evidence and their tests plus scripts/semantic-qualification-adapter-helpers.mjs and its focused tests only. Refs: packages/core/src/relationships/typescript-resolution.ts, packages/core/src/semantic/typescript-compiler-provider.ts, scripts/typescript-semantic-qualification.mjs, scripts/semantic-relationship-qualification.mjs, evals/semantic-relationship-qualification/corpus.json. | Baseline common corpus: semantic 12/12, strict evidence 1/12, wrong targets zero. No child may edit corpus assertions or claim this proves a TS7 regression. T3 taskId node:delegated-task:command%3Amcp%3Ad4311d0b-fa29-40eb-b094-6ddfaf5a0997%3Adelegate-task%3Asatori-pr-p1a-20261026-r1. Running, selected model/options checked. Parent independently checks 13 focused core tests, two adapter tests and a fresh common qualification: semantic 12/12, evidence 4/12, strict 3/12, wrong targets/false resolutions zero. Retained gaps: field/constructor assignment/alias/optional/inheritance/interface/branch proofs and dynamic authority mismatch. Parent advances internal ts-compiler identity v10 to v11 to invalidate old evidence, with package versions unchanged. Seven descriptor/persisted-state tests pass after the internal identity change. Score artifact /tmp/satori-pr-parent-qualification-score.json. This is a partial proof repair, not full corpus acceptance. |
| PR-P1B | review | - | T3 GPT-6.1-sol medium | Bound raw search disclosure at the response owner so a valid limit-20 request cannot exceed the 32768-byte visible-result budget. Preserve valid JSON, ranking and full results below budget. Make omissions explicit through established disclosure contracts. Add Unicode, oversized chunk and ordinary-result regression checks. Own MCP search response serialization/envelopes, affected types and tool tests only. Refs: packages/mcp/src/core/search-response-envelopes.ts, search-types.ts, packages/mcp/src/tools/search_codebase.ts and tests. | Original bench-full Satori r3 emits 41387 bytes. Later bench-full2 emits 43080 bytes. Grouped response policy and semantic ranking are out of scope. T3 taskId node:delegated-task:command%3Amcp%3Ad4311d0b-fa29-40eb-b094-6ddfaf5a0997%3Adelegate-task%3Asatori-pr-p1b-20261026-r1. Running, selected model/options checked. Parent immediately reviews public response contract and independently checks 59 focused MCP tests, all pass. Real archived r3 response shrinks 41387 to 31975 UTF-8 bytes, retains the identical first 12 of 20 complete hits and adds the existing omission warning. Old transcript remains unchanged. Single oversized hit/metadata yields existing SEARCH_RESULT_SET_PAGE_TOO_LARGE; full diagnostics keep their separate budget. |
| PR-P23 | review | - | T3 OpenCode DeepSeek max | Repair freshness task definition/reference ambiguity in a new versioned task specification without changing archived scores. Clarify allowed search-root guidance, implementation-versus-call-site relationships, and run/metric/validity reporting. Add focused harness tests. Analyze extra calls and the later incorrect fact from preserved evidence without changing agent answers or expanding benchmark claims. Own evals/agent-discovery/evaluator-tasks.json, run-opencode.mjs, run-opencode.test.mjs and docs/improvements/agent-discovery-benchmark-2026-10-26.md only. | Original bench-full r1/r2 fail only callback-file match; r3 also exceeds byte limit. All original Satori facts/owner/span match. Later bench-full2 has an independent wrong fact. Two tasks and curated first query remain disclosed limits. T3 taskId node:delegated-task:command%3Amcp%3Ad4311d0b-fa29-40eb-b094-6ddfaf5a0997%3Adelegate-task%3Asatori-pr-p23-20261026-r1. Running, selected model/options checked. Parent independently checks all 42 harness tests. Parent synchronizes AGENT_INSTRUCTIONS.md and HARNESS_PROTOCOL.md to v4 and fixes the staged README rows to distinguish valid/invalid suites and the current Potion smoke failure. New wording remains unmeasured; original artifacts/scores stay unchanged. |
| PR-HANDOFF | review | PR-P23 | existing OpenCode worker, handoff only | Return owned changes, tests, unresolved defects and owned processes. No new edits, tests, models or review. | Latest direct user request. Steer sent to existing PR-P23 thread. Follow-up taskId node:delegated-task:65515b87-ceb4-4dfd-8218-d6a3eb8fac2e, running. Final review belongs to the parent. Parent recovers completed implementation handoff from original terminal result. Extra cleanup reply is blocked in worker-native nested review started at 07:28, outside packet scope. After explicit handoff request at 07:36 cannot return, parent stops follow-up task and its review descendants per latest user direction. No implementation work is lost. |
| PR-BENCH | review | PR-P0, PR-P1A, PR-P1B, PR-P23 | parent | Check the integrated diff, build once serially, and rerun the benchmark only against an immutable checkout with distinct run identity. Keep old scores and identify total task time separately from source-discovery time. Stop on model quota or environmental blocker and report it honestly. | No delegated dispatch reserved. Baseline bench-full final clean-worktree check fails. Integrated build and a task-owned frozen snapshot are next. Main retains partial semantic work uncommitted under the latest commit instruction. Retry suite opencode-2026-10-26T07-30-15-360Z-24baa346 completes with valid 12/12 measurement records. Satori exact/freshness 3/3 and 3/3; native 3/3 and 2/3. Exit 1 reflects one native budget-exhausted attempt, not invalid measurement. Snapshot stays clean. Tested task manifest is version 3; final parent clarification version 4 remains unmeasured. |
| PR-REVIEW | review | PR-HANDOFF | parent Codex, per latest user instruction | One final review of the complete graph diff and acceptance evidence. Check proof authenticity, bounded disclosure, packed native installation, benchmark validity and preserved staged work. Report concrete findings. | Latest user instruction: parent reviews personally after agent handoff, then commits checked work. No delegated reviewer. Parent moves rows to review, never done. Parent reviews the full graph personally per latest user instruction. Corrected the proof authority regression, synchronized protocol docs/status claims, and clarified the freshness boolean exception in task manifest version 4 while preserving archived keys/scores. No remaining known blocker in the reviewed repair code. Remaining limitations: partial proof coverage, unmeasured final question wording, and separate Potion smoke timeout. Parent checks 36 publication/provider tests, 42 harness tests, 21 qualification/adapter tests, seven identity/state tests, builds and workspace check. No delegated final reviewer. |


Priority-run commit checkpoint: Hamza requests committing only the checked repairs.
Parent commits PR-P0 as e13623bd (`fix(cli): install the required TypeScript native compiler`)
and PR-P1B as 0d1708f4 (`fix(mcp): bound raw search responses by UTF-8 bytes`).
Only the nine installer/release-code paths and three raw-response paths enter those commits.
Existing staged documentation, partial proof work, benchmark edits and this ledger remain intact
and uncommitted. Fresh pnpm run check exits 0. Existing focused acceptance results remain valid.
No package versions change. Full smoke still fails at the later Potion readiness check.
The graph remains active and retains its one final independent review after integrated checks.


Integration checkpoint: parent checks PR-P23 with 42 passing tests and synchronizes its two
protocol documents and the staged summary rows. Builds pass for core, MCP and CLI. The initial
publication check exposes three authority regressions in the uncommitted proof patch. Parent
narrows origin_flow to cases where allocation changes the static target set. Same-target
allocation retains constructor proof and direct_binding. A regression covers both cases.
All 36 focused/provider/publication tests now pass without changing old assertions. The fresh
workspace check passes. The two earlier checked commits remain unchanged.
Benchmark snapshot is /home/hamza/.cache/satori-priority-20261026/snapshot-0vmt4a8j, frozen SHA
06dca384d6740b0f23ef363c652a2bf084129a82. Its earlier candidate snapshot was never measured.
Original global opencode now reports v2.1.4 and lacks the expected resolved Satori config.
Use existing pinned /tmp/opencode/oc118/node_modules/.bin/opencode v1.18.35 and the prior
benchmark's profile through task-owned opencode-benchmark, with isolated state/vector paths.
The temporary shell wrapper passes shellcheck. No global/client settings change. Isolated
snapshot index preparation is running in exec session 2991, log /tmp/satori-pr-index-setup.log.
Do not start a scored run until status is ok. Do not edit snapshot source/runtime after that.


Snapshot index preparation completes with status ok and closes its MCP session. The readiness
witness is /home/hamza/.cache/satori-priority-20261026/index-ready.json. Parent starts one v4
scored run on the frozen snapshot: pinned OpenCode 1.18.35, DeepSeek V4.1 max, three repetitions
per task/arm, prepare=status, separate results directory. Managed exec session 46493. Log /tmp/satori-pr-v4-benchmark.log.
Max effort differs from the old high-effort runs, so cross-run timing deltas cannot isolate the
repair. The run's internal paired arms retain identical model settings. No snapshot files or
runtime outputs may change while the run is active. A cancellation notification for task
node:delegated-task:28b64a2c-560f-4284-a3ae-a5736f1614df does not match this graph's completed
PR-P23 taskId. No replacement worker or extra dispatch is started.


First v4 launch stops in preflight before any scored task: prepareSatori sees not_ready.
Exec 46493 exits 1. No scores are claimed. A separate reopened status check returns ok for the
same immutable snapshot and isolated state, with an active startup sync reported. The exact
reason for the first transient not_ready is not captured by the harness error, so do not claim
a root cause. Parent permits one retry after the observed ok status, preserving first log.
Retry log /tmp/satori-pr-v4-benchmark-retry.log. If readiness fails again, stop this branch,
record the blocker, and proceed to the single final audit rather than retrying blindly.


The single retry passes index preflight and writes run-manifest.json under
results/opencode-2026-10-26T07-30-15-360Z-24baa346. Managed exec session 55832 owns the run.
Source/runtime snapshot stays clean and frozen. Scored attempts remain pending.


Hamza explicitly changes the final-review method: request agent handoff, review personally as
parent Codex, then commit. That overrides the earlier delegated-review requirement. Parent
steers the already active PR-P23 follow-up, without spawning a reviewer. Existing P1A/P1B
terminal summaries are recovered as handoff evidence. The frozen benchmark continues separately
and cannot be invalidated by main-checkout review or commits.


Final parent-review result: reviewed changes commit as b4c56e1f (supported TypeScript binding
proofs) and 80cdf946 (freshness reference-site/exception wording, canonical
root guidance and run reporting). No package version changes. Original scores and frozen
snapshot remain intact. Only Hamza marks rows done. The worker-native extra review is
interrupted after the handoff request cannot return while that review tool runs. Its original
completed implementation handoff is retained. No further agent work is pending in that task.
Brief retrospective: a worker started a nested review outside its no-delegation packet and
blocked cleanup handoff. Use its saved terminal result and stop extra turns once parent takes
review ownership. A cold status returned not_ready before a later ok status; preserve that
unscored failure and one successful preflight retry rather than hiding it in scored results.
Remaining work is explicitly limited to the retained proof gaps, the separate Potion readiness
failure, and measurement of final manifest version 4 wording. No release-readiness claim.


Commit preparation: final code and report review covers tracked staged/unstaged changes and
both new focused test files against the 47821dde baseline. The semantic patch is explicitly
partial (12/12 decisions, 4/12 evidence, 3/12 strict). The new v4 run is valid with 12 records,
Satori 6/6 and native 5/6 across the two tasks. Final manifest version 4 wording remains
unmeasured. Broad product/latency claims are withheld. The parent performs the required brief
retrospective using the loaded retro guidance; the benchmark document records a diagnostic
proposal only. No global rule, CI policy, compatibility fallback or dependency is added.
All implementation/benchmark commands are finished. Handoff follow-up task is interrupted
with no pending child runs. Final documentation/ledger commit follows the two reviewed code
commits. No push or release occurs in this closeout.


## Remaining repair run, 26 October 2026

User authorizes deciding and implementing the two partial repairs and two open failures,
then benchmarking. Parent reads the request as TypeScript proof evidence, authority labels,
extra investigation calls and the Potion startup timeout. Proof evidence and labels share one
owner and are merged. Broader benchmark coverage uses existing held-out/production corpora,
not new invented oracles. Parent performs final review under the latest explicit instruction.
TaskStartSnapshot: clean master 42cadef1. No processes or agents remain from the previous run.
Execution update: user authorizes one T3 benchmark worker, GPT-6-luna at max effort.
Dispatch budget one, no nested delegation or agent review. Parent keeps implementation and
final review. Existing TASKS.md is the plan and state carrier. TDD mode off; deterministic failure regressions follow repository policy.
No package version bumps, new dependencies/services, CI bypass, oracle weakening, model downloads,
client-setting changes or live index deletion. Internal evidence identity changes only if needed.
Changes follow demonstrated failure paths. No timeout increase without startup timing evidence.
Stop a repair branch after two unsuccessful repairs and re-establish its mechanism.

| id | status | depends | owner | acceptance | evidence |
| FX-P | review | - | parent | Reproduce Potion readiness failure using the packed helper/model path, measure three runs with load/memory, identify the responsible boundary, and repair it with regression evidence. Packed compiler API and full release smoke pass, or report an unreproduced/environmental limit without inventing a fix. Refs: packages/core/src/embedding/potion-embedding.ts and tests, packages/cli/scripts/release-smoke.ts, existing /tmp/satori-pr-p0-packed-smoke.log. | Default startup budget is 5000 ms. The previous packed smoke reaches this timeout after native TypeScript checks pass. Cause unknown. Startup regression fails before repair and passes after it. All 29 Potion tests pass. Updated core build passes. Full post-repair packed smoke passes, including actual TypeScript API, Potion execution and LateOn native checks. Runtime size 963995060 bytes stays below the existing budget. No timeout increase. Logs in satori-remaining-repairs-20261026. |
| FX-S | review | - | parent | Preserve supported alias/optional/field/constructor/inheritance/interface/branch proof facts from native compiler observations and classify authority correctly. Keep immutable common and held-out oracles, exact targets and conservative abstention. Add only justified proof kinds at the shared owner and persistence validator if required. Focused provider/converter/validation/publication tests pass, with zero wrong targets/false resolutions. Record every remaining unsupported expectation. Refs: TypeScript provider/converter, relationships/resolution.ts and resolution-claim-validation.ts, qualification adapter/corpora. | Baseline decisions 12/12, evidence 4/12, strict 3/12. Existing local allocations confirming static targets retain direct_binding. Immutable common corpus passes 12/12 strict/evidence/authority. Existing combined common+held-out/production corpus passes 21/21 for decisions, strict evidence, strategy and authority, with zero false resolutions/wrong targets. Typed proof kinds are additive and validated at the shared owner. Constructor-field links abstain for overwritten/uninitialized fields; mutable origin alternatives remain candidate-only with explicit unknown reachability. Internal provider identity v12 invalidates old sidecars. 37 publication/state/validation tests and 22 final focused tests pass; workspace check passes before final additive mutable-proof detail. Canonical dynamic abstention becomes unresolved while non-indexable unsupported remains unsupported, covered by both positive and negative assertions. |
| FX-T | review | - | parent | Inspect the preserved freshness attempt with 16 calls and 265410 ms. Separate necessary verification, missing tool evidence and model/provider overhead. Repair only an evidenced Satori disclosure/navigation/guidance gap, preserving query quality and correctness. Compare before/after tool evidence on the same input and retain an unchanged control. Refs: priority snapshot suite opencode-2026-10-26T07-30-15-360Z-24baa346, search response owners and recommendedNextAction contracts. | Extra calls are observed. No cause is established. Do not cap calls or force final answers to improve the benchmark. Preserved transcript proves two retry calls fail at Potion readiness and one range read mixes codebaseRoot with top-level lines. First gap is repaired in FX-P. The read_file root description now explicitly separates exact-symbol continuation from ordinary ranges; runtime validation, authorization and outputs are unchanged. Other later calls inspect helper/constructor/caller source and are not declared unnecessary solely from the string-match milestone. No ranking change, forced answer or tool-call cap is added. Existing read-file root contract and 21 adapter/scorer tests pass. Agent-level improvement remains to measure. |
| FX-B | review | FX-P, FX-S, FX-T | parent prepares; T3 GPT-6-luna max executes | Build the checked implementation once, freeze source/runtime, run existing common and held-out semantic corpora and final task manifest version 4 in paired agent runs with the same model/options as the prior max run. Also run the existing 30-query held-out search corpus on pinned gin/Flask sequentially, using task-owned state and installed offline models. Keep its retrieval metrics separate from autonomous-agent metrics. Report per-task correctness, complete timing ranges, calls/tokens, machine load/memory, run identity and failures. Do not pool unlike metrics or claim a causal speedup across changed tasks. | Prior valid max run: Satori 3/3 exact and 3/3 freshness, native 3/3 and 2/3. Final manifest wording is unmeasured. T3 worker taskId node:delegated-task:command%3Amcp%3Ad4311d0b-fa29-40eb-b094-6ddfaf5a0997%3Adelegate-task%3Asatori-fx-b-luna-20261026-r1. Returned running on codex/gpt-6-luna, reasoningEffort=max, serviceTier=default, worktree isolation requested. Parent supplies committed source 2f52b298. One scoped worker, no nested delegation/reviews. Luna returns complete on clean worktree 2f52b298. Cohort A manifest v4: valid 12 records, Satori 6/6 and native 5/6; freshness Satori 3/3 with five calls each, zero Potion/provider errors. Cohort B LateOn: 30 queries, Gin hit@1 4/15 and hit@5 9/15, Flask 6/15 and 11/15. g15 has zero target chunks; denominator remains 30. Reranker model label rerank-3 is stale for active LateOn, disclosed rather than used as identity evidence. All owned sessions closed. Report: /home/hamza/.cache/satori-remaining-benchmark-luna-20261026/report.md and report.json. |
| FX-R | review | FX-B | parent | Review the complete repair personally, run necessary focused checks, commit only checked repairs and report residual limits. Preserve user work and original scores. Agents never mark done. | Latest user instruction retains parent review and commit ownership. No delegated reviewer. Latest user instruction waives a deep audit and extra reruns. Parent collects the terminal handoff and report, checks the completed counts against the already-read summary artifacts, and records limitations only. Implementation was already personally reviewed and committed. This is a bounded receipt, not an independent benchmark audit or broad product-readiness claim. Only Hamza marks done. |


FX-P diagnosis: baseline full packed smoke passes when run serially on the quiet host.
Three fresh-process source-helper runs have median 363.025 ms startup and peak 208504 KiB RSS.
Three matching TS-API-first runs have median 346.823 ms and peak 208364 KiB RSS. Machine load
ranges 0.43-0.56 (one minute). Identical helper SHA256 at source and installed paths excludes
binary drift for these probes. Logs: satori-remaining-repairs-20261026/potion-sequence-probes.log.
The longest freshness attempt contains two actual Potion readiness errors before search succeeds,
so retry overhead is a demonstrated component of FX-T, not merely model over-investigation.
A deterministic worker-marker/parent-stall regression fails before repair with the same readiness
error even though a complete valid frame reaches the pipe before the deadline. A silent-worker
control passes its expected rejection. Existing request-expiry code already handles this Node
poll ordering. Decision: code-change at Potion startup expiry, using one setImmediate poll catchup
and current-child/starting-state guards. No timeout increase, retry loop or stderr disclosure.
This closes the reproduced false-expiry class. The historical smoke's exact event-loop timing
was not recorded, so that particular occurrence is not claimed as causally proved.


Commit and delegation checkpoint: user requests committing checked repairs and delegating
benchmark work, then prefers Luna max over OpenCode DeepSeek max as the worker. Live catalog
advertises codex/gpt-6-luna with reasoningEffort=max. The measured autonomous agent stays
DeepSeek V4.1 max to preserve comparison settings; this is distinct from the Luna coordinator.
Fit gate: existing runners, frozen task manifests and prior raw outputs define the workload;
valid 12-record agent results and the unchanged 30-query held-out scorer are executable checks;
a wrong preparation can waste a run or invalidate evidence, so parent commits/builds first;
one isolated worker can execute the sequential benchmarks while parent owns review.
Final workspace check passes after all source edits, and full build passes. Required reports
remain bounded: 21/21 semantic cases does not mean all TypeScript programs are proven. Full
packed smoke passes after the startup repair. Source commits below preserve package versions.


Checked implementation commits: 7c69c685 fixes queued Potion readiness versus startup expiry;
7c69c685 retains the same configured timeout. The subsequent semantic commit preserves typed
provenance and canonical authority, with strict/evidence/authority 21/21 and zero false targets.
A separate read_file description commit distinguishes exact-symbol and range parameters.
Final workspace check and build are in satori-remaining-repairs-20261026/{final-check,final-build}.log.
Full packed smoke passes in packed-smoke-after.log. The benchmark worker must use the final
committed source and current built runtime, with no edits during measurement.


Luna benchmark worker confirmed running in T3-owned worktree
/home/hamza/.t3/worktrees/satori/t3-45e3fd9f at committed source 2f52b298. Parent implementation
and generated runtime stay fixed for its inputs. Parent updates only ledger/status documentation
in main while the isolated worker runs. Implemented proof commit is 42ebc0ef, and read guidance
commit is ea93fb8f. Current report status now records the full packed-smoke pass after the
startup fix; historical timeout evidence remains intact. Model downloads and nested reviews
remain forbidden. Benchmark results are still pending, with parent verification owed.


Luna closeout: all requested benchmark cohorts finish. User explicitly declines a costly audit,
so parent performs no new benchmark, test rerun or deep audit. Measurements remain separate:
autonomous tasks are still two, with three repetitions each; held-out retrieval adds 30 questions
on two repositories; semantic qualification remains a separate 21-case result. Native's sole
failure is tool budget plus read-before-discovery. Satori freshness uses five calls in every
attempt and has no Potion startup errors. Broader retrieval remains mixed, not release proof.
Worker reports clean worktree, no tracked edits and all owned sessions closed. The task-created
worktree is retained with its raw evidence for reproducibility. No package/version changes,
source fixes, model downloads or publication occur during closeout.

## ARM search follow-up, 26 October 2026

Hamza authorizes starting the search follow-up and one Luna max or OpenCode DeepSeek worker.
Start from committed evidence. No new benchmark, broad audit, model download, dependency change,
or original-result rewrite is authorized. Parent owns design and acceptance. Agents move checked
tasks to review. Only Hamza marks done. Dispatch budget for this follow-up: one scoped worker.
TaskStartSnapshot: clean a599f3acb2f552cf04417a91d042548507754b1e on /home/ubuntu/repo/satori.
The original /home/hamza cache and its /home/ubuntu equivalent are absent on this server.

| id | status | depends | owner | acceptance | evidence |
| SF-M | review | - | parent design; Luna max implementation | Correct provider-specific model provenance in evals/real-repo-quality/run.mjs. Preserve its output shape. Record VOYAGEAI_RERANKER_MODEL only for the explicit voyage provider, otherwise null. Add focused runner coverage for LateOn with a stale Voyage value, explicit Voyage, and absent provider. Preserve scores, oracle, runtime selection and original artifacts. Run only the focused runner test. | Dispatch 1/1: satori-arm-sf-m-20261026-r1, codex/gpt-6-luna, reasoningEffort=max, serviceTier=default. Parent inspects and applies the two-file diff. Initial runner checks fail because the core LanceDB link points to absent 0.39.0. Follow-up dependency restoration preserves the lockfile and package versions. Offline install lacks cached packages; online frozen install stops with ENOSPC while copying ONNX Runtime. Parent removes only its newly created v10 cache and restores the core link to downloaded locked LanceDB 0.40.0 with its ARM native package. The pre-existing v11 cache is untouched. Full workspace dependency installation is not claimed. node --test evals/real-repo-quality/run.test.mjs passes all 11 tests, including actual output for LateOn with a stale Voyage model, explicit Voyage and absent provider. Syntax and diff checks pass. No benchmark or original-result rewrite. Worker checkout remains retained. Only Hamza marks done. |
| SF-Q | open | SF-M | parent | Read saved Cohort B query scores and capped stage records. Separate observed ranking losses, retrieval uncertainty and missing target coverage. Reconcile report labels and denominators only where saved evidence proves a mismatch. Stop without search changes when evidence does not identify the responsible boundary. | Raw cohort artifacts are missing here. Committed receipt records Gin 4/15 and 9/15, Flask 6/15 and 11/15. Stage absence alone does not prove retrieval absence when records are capped. Artifact transfer from the previous machine is required. No benchmark rerun. |
| SF-C | open | SF-Q | parent | Diagnose g15 against the pinned source, publication manifest and parse outcomes. Establish whether go.mod is excluded, unsupported, missing from publication, or inconsistent with the frozen oracle. Repair only a demonstrated Satori defect. Preserve the 30-query denominator. | The frozen case targets go.mod. Saved receipt reports zero target chunks. Pinned source and original publication evidence are not available at the handoff paths here. No index deletion or oracle changes. |
| SF-D | review | - | parent inline | Hamza authorizes work that needs no benchmark on 26 October 2026. Check source-level go.mod admission and text chunking. Correct the false warning that zero-target queries leave scored metrics. Preserve scoring, denominators, oracles and original artifacts. Use bounded direct checks without dependencies or a benchmark. | Corrected only the target-resolution warning and its comment. Actual default/all-text filename sets admit go.mod, minimal excludes it, and a synthetic go.mod produces one complete text chunk without symbols. Direct Node source probe passes with --experimental-transform-types and extension resolution hooks. Initial strip-only probe cannot handle an existing TypeScript parameter property, so the corrected probe uses Node's transform mode. Actual computeCohortAggregates retains a zero-target miss: count 2, hit1 0.5, MRR 0.5. Actual resolveRepoTargetChunkIds with a database fixture keeps g15 and emits the corrected denominator warning. Syntax and diff checks pass. No new test files, dependencies, benchmark runs or score changes. Historical coverage cause remains unknown. Only Hamza marks done. |
