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
CBM 11b662f9; the separate CBM checkout is at 3457b21b. No map regeneration is authorized or performed.

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
| T1 | review | - | deepseek-v4.1-flash-free (T3 `node:delegated-task:command%3Amcp%3A39d636c5-d402-4155-a6a1-53cddf9f88cd%3Adelegate-task%3At1-blend-heldout-20261025-r1`) | Held-out 30q (gin, Flask) on LateOn, same build and indexes: blend-on keeps every hit blend-off has, and improves hit@1 or MRR. Per-query ranks, provenance and metric table reported. | Met on hits and on hit@1/MRR; not met on per-query rank. `/tmp/satori-blend-heldout-20261025/{off,on}`. git `8f72ce70`, dirtyTreeHash `8c327d53…`, lateon, only `rerank_blend` differs. hit@1 10→12, hit@5 20→20, MRR 0.4712→0.5078, fused recall 28/30 both, hits 24/24 with no hit lost or gained. Ranks moved on 6 cases: gained g10 6→1, g12 7→1, f4 3→1; lost g3 1→5, g8 2→8, g14 4→6. 3 up, 3 down. Verified by the orchestrator from both `result.json` and `harness-summary.md`. Logs: `/tmp/satori-blend-heldout-20261025/logs/{off,on}.log`. |
| T2 | blocked | T1 | unassigned | `rerank_blend` is enabled only for the LateOn provider; an explicit `false` from the caller and from `SATORI_SEARCH_FLAGS` both win over the gate; focused tests cover both explicit-off paths. | Blocked by T1: the held-out split shows +2 hit@1 and +0.037 MRR against 3 gained and 3 lost ranks on 6 changed cases out of 30. That is not a provider-specific win, so the gate has no evidence to key on. Needs Hamza's decision. |
| TS71-A | review | - | OpenCode DeepSeek V4.1 Flash, max | Port all first-party TypeScript runtime/build consumers to 7.1.0-beta, including analyzer/session/AST/config APIs and compiler-version state identity. Preserve existing semantics and resource/process cleanup. Update manifests, lockfile, affected documentation and tests. `pnpm run check`, build, existing TypeScript configured-project/provider/adversarial/resolution-state tests and TypeScript publication/equivalence tests pass. Report third-party peer constraints honestly. Refs and constraints above. | Dispatch 1/2. T3 taskId `node:delegated-task:command%3Amcp%3Ae4c682c1-b486-4947-8484-45cf645f6dad%3Adelegate-task%3Asatori-ts71-a-20261025-r1`. Returned running, provider `opencode`, model `zengate/deepseek-v4.1-flash-free`, variant `max`. Continuation authorized the parent to implement inline. All acceptance checks pass after fix round 1: `pnpm run check`, build, publication/equivalence, provider/adversarial, configured-project/resolution-state, MCP, CLI and script tests. Awaiting Hamza. |
| TS71-R | review | TS71-A | OpenCode DeepSeek V4.1 Flash, max | One read-only independent review of the complete migration diff against TS71-A, preservation of existing edits, public evidence contracts, process cleanup, resource limits, version identity, mapper execution disabled, and regression coverage. Report concrete defects with files and checks, or no findings. | Dispatch 2/2, T3 taskId `node:delegated-task:command%3Amcp%3A69ffc3e2-54fb-488f-a5c4-ed1efd0f46e6%3Adelegate-task%3Asatori-ts71-r-review-20261025-r1`. Verdict PASS WITH FINDINGS: 1 major, 6 minor, 1 nit. No blocker. Findings 1 and 2 fixed in round 1, finding 3 fixed with a regression test, finding 5 hardened, finding 7 corrected. Findings 4, 6 and 8 documented as accepted. Re-verified by the parent. Awaiting Hamza. |
| TS71-F | review | TS71-A, TS71-R | parent inline | Regression tests reproduce directory outputs accepted as declarations and metadata counted as source. Repair both without bypassing JSON-source budgets. Focused semantic and publication checks plus pnpm run check pass. Commit the scoped fix on master, preserving existing migration commits. | Inline repair from clean e2cd3ce8. Three regression cases failed before repair. Final checks pass: pnpm run check, 43 core tests across five files, 37 agent-discovery eval tests, 507 script tests. Task-key start remains line 227. Only this ledger, the two owning files and their focused test file change. The scoped commit integrates on master, which already contains all handoff commits. Awaiting Hamza. |
| TS71-M | review | TS71-F | parent inline | Bound JSON allocation before native parsing without treating metadata as source. Bound and own reference-cache retention, with cleanup and unchanged readiness results. Three-run measurements, mutation checks, focused tests and repository check pass. Integrate on local master. | Authorized inline follow-up from clean 8886865b. No new dispatch. Three-run evidence above: oversized JSON data reads 8388620→0 bytes, phase median 120.883→11.072 ms. Cache disposal releases proof entries, warm lookups avoid recomputation, stale-fingerprint mutation fails the regression. Final checks pass: 76 core tests across 12 files, 507 script tests, pnpm run check, git diff --check. Exact-target start remains line 227. Scoped integration on local master preserves all handoff commits. Awaiting Hamza. |
| DEP-A | review | TS71-M | parent inline | Update npm dependencies across all first-party manifests and both lockfiles to current latest releases. Preserve TypeScript 7.1 beta and workspace links. Raise Node minimum to 22.22, as Hamza authorizes, and synchronize managed native-runtime versions. Repository check, build, scripts, affected runtime tests and experiment checks pass. Record upstream constraints. | Direct request on 25 October 2026. Snapshot: clean master 7cfee54f. No dispatches. Updated 13 direct npm dependencies including napi CLI 3.10.9 and Chokidar 6. Both outdated checks return {}. Check/build/507 scripts pass. Core reports 1083 passed, 2 skipped. MCP: 1251 source tests and 2 compiled real-model tests pass on Node 22.22. CLI: 482 pass on Node 22.22. Native Chokidar event/cleanup passes. Napi debug/release builds, typecheck, 20 fault tests and 17 release tests pass (3 release-only skips). Upstream constraints and source-harness limits below. Final diff checked. Integrate on local master. Awaiting Hamza. |
| LOCAL-A | review | DEP-A | parent inline | Show how agents use the unpublished local build. Measure current LateOn and Voyage rerank-3-lite through local MCP on the same 28 pinned queries, current oracle and frozen build. Use the same task-owned index and local embeddings. Activate all supported clients after Hamza selects them, preserving unrelated settings, models and ranking code. Report quality and execution failures honestly. | Code build 9753ced1. No dispatch. Matched current-oracle runs: LateOn MRR 0.585, hit@1 14/28, hit@5 22/28; Voyage rerank-3-lite MRR 0.958, hit@1 26/28, hit@5 28/28. All queries return ok, with no reranker failure markers. Same source commits, navigation manifests, flags and oracle hash. Both process scopes exit 0. Hamza selects all clients. Canonical local activation and preflight pass, and config readback checks Codex/Claude/OpenCode/AGY use the stable launcher. Launcher now selects repo packages/mcp/dist/index.js with offline/LateOn. Restart existing MCP client connections to load it. Evidence below. Awaiting Hamza. |
| VS-A | review | LOCAL-A | OpenCode DeepSeek V4.1 Flash, max | Benchmark local offline Satori against codebase-memory-mcp on QAP. Freeze 12 balanced source-backed tasks before scored tool calls. Check coverage and current APIs. Save raw replies, task answers, citations, score method, reproducible commands and setup failures. Read-only source. Refs: cross-repository protocol below. | Dispatch 1/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-qap-20261025-r1. Returned running, provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Parent baseline b7ef625d, clean. QAP HEAD 2ce9820d has user staged/unstaged work, so snapshot committed HEAD without altering that checkout. Child writes only its qap artifact directory. Parent checks artifacts on return. VS-B and VS-C may run in parallel, each with one scoped task. Parent artifact check: Final handoff received. Parent checks 12-task frozen pack hash and complete result record. Both sessions closed. Readiness adapter caused 45.1-minute wait after publication completed in about 14 seconds, corrected without rerun. CBM call-path path normalization rescored from preserved raw replies, with original scores archived. Citation-rule and architecture scoring disclosures require final review. Scores remain provisional pending VS-R. |
| VS-B | review | LOCAL-A | OpenCode DeepSeek V4.1 Flash, max | Choose a different local repository and justify the choice. Apply the same 12-task protocol against local offline Satori and codebase-memory-mcp. Use a different artifact directory and snapshot. Save evidence and limitations. Refs: cross-repository protocol below. | Dispatch 2/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-selected-20261025-r1. Returned running. Provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Independent of VS-A/C. Agent selects a repository other than Satori, QAP, Claive, React, Polars or FlatBuffers. Heavy indexing uses the shared resource gate. Checkpoint: Lingua OS selected at 4b18dfc1. Index report records unchanged snapshot and 15 oracle files. Frozen pack has 12 tasks. All 24 provider reply files and a finished run manifest exist. Initial task summary covers setup only, and T3 reports later child work pending. Final scoring/report and parent acceptance remain incomplete. QAP and Claive still run. Parent artifact check: Lingua OS final handoff received through latestTerminalSummary, no pending child runs. Parent checks frozen pack hash, completed 24-reply final manifest and report. Three runs exist: two harness iterations archived and excluded. All sessions/processes closed. Rank and citation normalization, excluded iterations and report aggregate need final review. Scores remain provisional pending VS-R. |
| VS-C | review | LOCAL-A | OpenCode DeepSeek V4.1 Flash, max | Benchmark local offline Satori against codebase-memory-mcp on /home/hamza/repo/claive using the same frozen 12-task protocol. Own only the claive artifact directory and snapshot. Save raw evidence, citations, scoring and setup limits. Read-only source. | Dispatch 3/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-claive-20261025-r1. Returned running. Provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Independent of VS-A/B. Claive is reserved from VS-B selection. Heavy indexing uses the shared resource gate. Parent artifact check: Final handoff received. Parent checks 98-file integrity manifest and frozen pack hash. Sessions/processes closed. Report and deterministic scores exist. Known objection: zero completed CBM discovery tasks still yield a nonzero MRR; reviewer must distinguish answer completion from tool support and incidental overlap. Both architecture responses lack required responsibilities. Scores remain provisional pending VS-R. |
| VS-R | in-progress | VS-A, VS-B, VS-C | OpenCode DeepSeek V4.1 Flash, max | One independent review of all three benchmark artifacts. Check source witnesses, frozen oracles, equal task conditions, coverage, unsupported-call classification, citations, scoring arithmetic and limits. Read-only. No new benchmark or second review round. | Dispatch 4/4. T3 taskId node:delegated-task:command%3Amcp%3A7adb6ac5-3b14-49d0-8b26-91c95021e181%3Adelegate-task%3Asatori-vs-final-review-20261025-r1. Returned running. Provider opencode, model zengate/deepseek-v4.1-flash-free, variant=max checked. Packet includes all three original scopes, reports, parent checks and six unresolved method/scoring objections. Advisory artifact audit only, no new runs or product edits. Only Hamza marks done. |
| FIX-A | review | VS-A, VS-C | parent inline | Investigate the reported missing Python channels.send_peer caller and scoring defects. Reproduce before changing Satori. Fix only demonstrated owners with focused regression checks. Preserve frozen benchmark oracles and no full reruns. | User authorizes fixing issues found by agents. Parent reproduces the missing second repeated-import call before repair. One regression covers module and named imports plus conflicting modules and rebinding. Python import proof now accepts identical repeated declarations and rejects later assignments. Provider revision and relationship cache witness advance to v3. 49 focused core tests, 507 script tests, pnpm run check/build pass. Real unchanged Claive source restores main→send_peer at cli.py:2560. Fresh isolated MCP publication and trace_path confirm CALLS, direct_binding, targetProofBacked=true, with no truncation or warnings. Local activation for all clients passes. Source baseline b7ef625d. No original benchmark score is changed. Final artifact audit remains independent and pending. |

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
