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
pass, including compiler coverage for the two retired ESLint rules. The dependency graph shows
only TypeScript 7.1.0-beta. Focused MCP/CLI checks and final repository check are running.
Adjacent finding, not a migration failure: `node scripts/sync-cbm-language-map.mjs --check`
successfully uses the new transpiler but reports a stale generated map. The unchanged map pins
CBM 11b662f9; the separate CBM checkout is at 3457b21b. No map regeneration is authorized or performed.

| id | status | depends | owner | acceptance | evidence |
|---|---|---|---|---|---|
| T1 | review | - | deepseek-v4.1-flash-free (T3 `node:delegated-task:command%3Amcp%3A39d636c5-d402-4155-a6a1-53cddf9f88cd%3Adelegate-task%3At1-blend-heldout-20261025-r1`) | Held-out 30q (gin, Flask) on LateOn, same build and indexes: blend-on keeps every hit blend-off has, and improves hit@1 or MRR. Per-query ranks, provenance and metric table reported. | Met on hits and on hit@1/MRR; not met on per-query rank. `/tmp/satori-blend-heldout-20261025/{off,on}`. git `8f72ce70`, dirtyTreeHash `8c327d53…`, lateon, only `rerank_blend` differs. hit@1 10→12, hit@5 20→20, MRR 0.4712→0.5078, fused recall 28/30 both, hits 24/24 with no hit lost or gained. Ranks moved on 6 cases: gained g10 6→1, g12 7→1, f4 3→1; lost g3 1→5, g8 2→8, g14 4→6. 3 up, 3 down. Verified by the orchestrator from both `result.json` and `harness-summary.md`. Logs: `/tmp/satori-blend-heldout-20261025/logs/{off,on}.log`. |
| T2 | blocked | T1 | unassigned | `rerank_blend` is enabled only for the LateOn provider; an explicit `false` from the caller and from `SATORI_SEARCH_FLAGS` both win over the gate; focused tests cover both explicit-off paths. | Blocked by T1: the held-out split shows +2 hit@1 and +0.037 MRR against 3 gained and 3 lost ranks on 6 changed cases out of 30. That is not a provider-specific win, so the gate has no evidence to key on. Needs Hamza's decision. |
| TS71-A | in-progress | - | OpenCode DeepSeek V4.1 Flash, max | Port all first-party TypeScript runtime/build consumers to 7.1.0-beta, including analyzer/session/AST/config APIs and compiler-version state identity. Preserve existing semantics and resource/process cleanup. Update manifests, lockfile, affected documentation and tests. `pnpm run check`, build, existing TypeScript configured-project/provider/adversarial/resolution-state tests and TypeScript publication/equivalence tests pass. Report third-party peer constraints honestly. Refs and constraints above. | Dispatch 1/2. T3 taskId `node:delegated-task:command%3Amcp%3Ae4c682c1-b486-4947-8484-45cf645f6dad%3Adelegate-task%3Asatori-ts71-a-20261025-r1`. Returned running, provider `opencode`, model `zengate/deepseek-v4.1-flash-free`, variant `max`. Parent checks acceptance on return. |
| TS71-R | open | TS71-A | OpenCode DeepSeek V4.1 Flash, max | One read-only independent review of the complete migration diff against TS71-A, preservation of existing edits, public evidence contracts, process cleanup, resource limits, version identity, mapper execution disabled, and regression coverage. Report concrete defects with files and checks, or no findings. | Not dispatched. |
