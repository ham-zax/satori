# Indexing memory budget — implementation plan

Approved scope: Turn 3 resource planning and status hint; no parser/payload/FTS process redesign and no new dependencies. Baseline `6979e346` is clean. This plan is required by Aegis writing-plans because one new owner crosses stage and status contracts.

The indexing resource planner owns observation and policy. Its frozen plan lives for one full index or sync; the generation workflow distributes it through narrow stage ports. Context only constructs/wires. The env manager owns override validation. Root mutation operations remain the sole progress/status writer and retain the last budget hint. Compiler project closure, claims and optional-provider failure semantics stay unchanged.

TDD Route: off/skipped as a general workflow; deterministic failure-path reproduction before the scheduler change is separately required by repository policy. Table tests, actual stage wiring, publication equivalence and lifecycle checks supply regression evidence.

1. Add injectable Linux/portable memory observation, validated budget/analysis overrides, conservative measured envelopes, CPU caps, frozen plan and status summary. Test finite/unlimited/missing cgroups, ancestors, current usage, overrides and CPU/host sizes.
2. Pass the plan from full/sync workflows to operation-scoped parser pools, analysis/payload/write queues and compiler jobs. Replace the fixed full compiler count with bounded continuous scheduling; preserve cleanup/failure precedence and warm delta cache policy. Test stages and concurrent failures; mutation-check cleanup.
3. Carry the budget summary through existing core operation state and MCP worker progress/status. Verify terminal readback; document the override beside existing resource limits. Run the established MCP contract/docs/manifest checks and update generated assets only if their inputs changed.
4. Run small/large-plan publication equivalence, affected tests, pnpm check, offline capped measurements (3×7G, 1×3G, 1×2G); report actual plans and any OOM peak owner. Inspect the final diff.

Risks: a single compiler project or native FTS can exceed the estimate; snapshots/analysis data remain resident. The plan is admission guidance rather than an allocator guarantee. Large hosts must reach TS 3/parser 8; small budgets must retain complete semantics with minimal concurrency. Existing SATORI_ANALYSIS_WORKERS precedence is retained. The only new public option is the `SATORI_INDEX_MEMORY_BUDGET_MB` override; stages have no memory heuristics of their own.

Checkpoint: implemented and verified. Twelve focused files pass (93 tests), including full/warm publication equivalence and deterministic cleanup mutations; pnpm check and MCP contract/docs/manifest checks pass. 7G median: 4.460 GiB / 44.92 s; 3G and 2G OOM during parser/payload work with one worker. Peak owner is native/anonymous memory in the mutation process, beyond the sampled V8 heaps; finer native attribution remains unresolved. Design B (parser/payload memory) follows separately.
