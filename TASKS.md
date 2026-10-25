# TASKS

Task ledger for the rerank-blend / LateOn decision and the authorized TypeScript 7.1 migration. The orchestrator reads this file first and
takes the first task whose status is `open` with every dependency at `review` or `done`.
Only Hamza marks a task `done`. Run budget for the current run: 2 dispatches.

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

| id | status | depends | owner | acceptance | evidence |
|---|---|---|---|---|---|
| T1 | review | - | deepseek-v4.1-flash-free (T3 `node:delegated-task:command%3Amcp%3A39d636c5-d402-4155-a6a1-53cddf9f88cd%3Adelegate-task%3At1-blend-heldout-20261025-r1`) | Held-out 30q (gin, Flask) on LateOn, same build and indexes: blend-on keeps every hit blend-off has, and improves hit@1 or MRR. Per-query ranks, provenance and metric table reported. | Met on hits and on hit@1/MRR; not met on per-query rank. `/tmp/satori-blend-heldout-20261025/{off,on}`. git `8f72ce70`, dirtyTreeHash `8c327d53…`, lateon, only `rerank_blend` differs. hit@1 10→12, hit@5 20→20, MRR 0.4712→0.5078, fused recall 28/30 both, hits 24/24 with no hit lost or gained. Ranks moved on 6 cases: gained g10 6→1, g12 7→1, f4 3→1; lost g3 1→5, g8 2→8, g14 4→6. 3 up, 3 down. Verified by the orchestrator from both `result.json` and `harness-summary.md`. Logs: `/tmp/satori-blend-heldout-20261025/logs/{off,on}.log`. |
| T2 | blocked | T1 | unassigned | `rerank_blend` is enabled only for the LateOn provider; an explicit `false` from the caller and from `SATORI_SEARCH_FLAGS` both win over the gate; focused tests cover both explicit-off paths. | Blocked by T1: the held-out split shows +2 hit@1 and +0.037 MRR against 3 gained and 3 lost ranks on 6 changed cases out of 30. That is not a provider-specific win, so the gate has no evidence to key on. Needs Hamza's decision. |
| TS71-A | review | - | OpenCode DeepSeek V4.1 Flash, max | Port all first-party TypeScript runtime/build consumers to 7.1.0-beta, including analyzer/session/AST/config APIs and compiler-version state identity. Preserve existing semantics and resource/process cleanup. Update manifests, lockfile, affected documentation and tests. `pnpm run check`, build, existing TypeScript configured-project/provider/adversarial/resolution-state tests and TypeScript publication/equivalence tests pass. Report third-party peer constraints honestly. Refs and constraints above. | Dispatch 1/2. T3 taskId `node:delegated-task:command%3Amcp%3Ae4c682c1-b486-4947-8484-45cf645f6dad%3Adelegate-task%3Asatori-ts71-a-20261025-r1`. Returned running, provider `opencode`, model `zengate/deepseek-v4.1-flash-free`, variant `max`. Continuation authorized the parent to implement inline. All acceptance checks pass after fix round 1: `pnpm run check`, build, publication/equivalence, provider/adversarial, configured-project/resolution-state, MCP, CLI and script tests. Awaiting Hamza. |
| TS71-R | review | TS71-A | OpenCode DeepSeek V4.1 Flash, max | One read-only independent review of the complete migration diff against TS71-A, preservation of existing edits, public evidence contracts, process cleanup, resource limits, version identity, mapper execution disabled, and regression coverage. Report concrete defects with files and checks, or no findings. | Dispatch 2/2, T3 taskId `node:delegated-task:command%3Amcp%3A69ffc3e2-54fb-488f-a5c4-ed1efd0f46e6%3Adelegate-task%3Asatori-ts71-r-review-20261025-r1`. Verdict PASS WITH FINDINGS: 1 major, 6 minor, 1 nit. No blocker. Findings 1 and 2 fixed in round 1, finding 3 fixed with a regression test, finding 5 hardened, finding 7 corrected. Findings 4, 6 and 8 documented as accepted. Re-verified by the parent. Awaiting Hamza. |
| TS71-F | review | TS71-A, TS71-R | parent inline | Regression tests reproduce directory outputs accepted as declarations and metadata counted as source. Repair both without bypassing JSON-source budgets. Focused semantic and publication checks plus pnpm run check pass. Commit the scoped fix on master, preserving existing migration commits. | Inline repair from clean e2cd3ce8. Three regression cases failed before repair. Final checks pass: pnpm run check, 43 core tests across five files, 37 agent-discovery eval tests, 507 script tests. Task-key start remains line 227. Only this ledger, the two owning files and their focused test file change. The scoped commit integrates on master, which already contains all handoff commits. Awaiting Hamza. |
