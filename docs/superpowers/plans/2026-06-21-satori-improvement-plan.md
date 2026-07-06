# Satori MCP Search and Readiness Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining `search_codebase` contract hole, keep cross-tool readiness and navigation ownership coherent, decompose the remaining search code by real owners, reduce the next measured search hotspot, and split the giant handler search test file into stable suites.

**Architecture:** Keep the six-tool MCP surface unchanged. Correctness work lands first: every `search_codebase` outcome must serialize through a stable JSON envelope, and every read/navigation tool must derive readiness from the same tracked-root/proof/collection/fingerprint logic. After that, shrink the search path by ownership boundaries already present in `search-frontdoor.ts`, `search-execution.ts`, `search-result-finalization.ts`, `tracked-root-readiness.ts`, and `tool-response-builders.ts`, then profile and trim the tracked lexical fallback without adding speculative caches or new public knobs.

**Tech Stack:** TypeScript, Node.js `node:test`, `perf_hooks`, `process.cpuUsage`, `node:inspector/promises`, pnpm, existing MCP/tool contract docs

---

## Research Summary

- Local contract hole: `packages/mcp/src/core/handlers.ts:2342-2348` still returns plain text for `all_semantic_passes_failed`, while the documented `search_codebase` contract is a JSON envelope.
- Local failing regression: `packages/mcp/src/core/handlers.scope.test.ts:7561` currently expects JSON after a post-freshness failure path.
- Existing ownership seams already exist and should be reused:
  - `packages/mcp/src/core/search-frontdoor.ts`
  - `packages/mcp/src/core/search-execution.ts`
  - `packages/mcp/src/core/search-result-finalization.ts`
  - `packages/mcp/src/core/tracked-root-readiness.ts`
  - `packages/mcp/src/core/tool-response-builders.ts`
- Main current search hotspot is still tracked lexical fallback in `packages/mcp/src/core/search-query-support.ts:444`.
- Largest search-specific test burden is `packages/mcp/src/core/handlers.scope.test.ts` at about 7.8k lines.
- External references used for this plan:
  - Official Node inspector docs support repeatable CPU profiles via `node:inspector/promises`.
  - Official Node test runner supports `--test-name-pattern` and `--test-shard` for splitting and targeted execution.
  - Official Node perf APIs (`perf_hooks.performance`, `process.cpuUsage`, `process.resourceUsage`) are sufficient for a local search benchmark harness.

## Constraints

- Do not change the six-tool public MCP surface.
- Do not add a wall-clock readiness cache.
- Do not widen sync-on-read behavior beyond `search_codebase`; `docs/INDEX_STATE_STABILITY_PLAN.md` keeps that as the one compatibility exception.
- Do not hide the current test override surface behind private helpers if it causes unrelated churn in `handlers.scope.test.ts`.
- Do not mix correctness work and speculative ranking/performance work in the same patch.

## Execution Order

1. `search_codebase` error-envelope fix.
2. Readiness and navigation ownership hardening across tools.
3. Test-suite split for search handler coverage.
4. Search-code decomposition by real owners.
5. Profile-led performance work on tracked lexical fallback.

## Phase 1: Fix `search_codebase` Error Envelope Consistency

### Task 1: Remove the plain-text error branch from `handleSearchCode`

**Files:**
- Modify: `packages/mcp/src/core/handlers.ts`
- Modify: `packages/mcp/src/core/search-types.ts`
- Modify: `packages/mcp/src/core/tool-response-builders.ts`
- Modify: `packages/mcp/src/core/search-response-envelopes.ts`
- Test: `packages/mcp/src/core/handlers.scope.test.ts`
- Test: `packages/mcp/src/core/handlers.golden.test.ts`
- Test: `packages/mcp/src/tools/search_codebase.test.ts`
- Doc: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

- [ ] **Step 1: Write the failing contract tests**

Add or update tests so these cases parse JSON and assert stable fields:

```ts
assert.equal(payload.status, "not_ready");
assert.equal(payload.reason, "search_backend_failed");
assert.equal(Array.isArray(payload.results), true);
assert.equal(payload.results.length, 0);
```

Required coverage:
- generic `all_semantic_passes_failed`
- classified vector-backend failure still returns the structured backend diagnostic payload
- post-freshness fail-closed tests keep JSON parsing

- [ ] **Step 2: Choose one stable non-ok reason and encode it in the type surface**

Use one envelope family instead of plain text. The least disruptive shape is:

```ts
type NonOkReason = /* existing cases */ | "search_backend_failed";
type SearchResponseEnvelope = {
  status: "not_ready" | /* existing */;
  reason?: NonOkReason;
  results: [];
};
```

Do not add a new tool or a plain-text fallback branch.

- [ ] **Step 3: Move search failure payload construction into `ToolResponseBuilders`**

Add a dedicated builder, for example:

```ts
buildSearchBackendFailedPayload(searchContext, message, hints?)
```

Then replace the plain-text return in `handleSearchCode` with:

```ts
return {
  content: [{ type: "text", text: this.stringifyToolJson(payload) }],
  isError: true,
  meta: { searchDiagnostics },
};
```

- [ ] **Step 4: Update golden/spec evidence**

Document that `search_codebase` always returns JSON in `content[0].text`, including semantic-pass exhaustion.

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.scope.test.ts
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.golden.test.ts
pnpm --filter @zokizuan/satori-mcp test -- src/tools/search_codebase.test.ts
```

Expected: PASS, and no test needs to special-case plain text.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/core/handlers.ts \
  packages/mcp/src/core/search-types.ts \
  packages/mcp/src/core/tool-response-builders.ts \
  packages/mcp/src/core/search-response-envelopes.ts \
  packages/mcp/src/core/handlers.scope.test.ts \
  packages/mcp/src/core/handlers.golden.test.ts \
  packages/mcp/src/tools/search_codebase.test.ts \
  docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md
git commit -m "fix(search): return json envelope for backend failures"
```

**Acceptance:**
- No `search_codebase` branch returns plain text for a valid request.
- `handlers.scope.test.ts:7561`-style post-freshness failures parse JSON.
- Golden output stays deterministic.

**Non-goals:**
- Ranking changes.
- Search performance work.
- New public status enums beyond the smallest needed reason addition.

## Phase 2: Keep Readiness and Response Ownership Strict Across Tools

### Task 2: Make search, navigation, and manage status agree on readiness

**Files:**
- Modify: `packages/mcp/src/core/tracked-root-readiness.ts`
- Modify: `packages/mcp/src/core/tool-response-builders.ts`
- Modify: `packages/mcp/src/core/handlers.ts`
- Modify: `packages/mcp/src/core/search-result-finalization.ts`
- Test: `packages/mcp/src/core/handlers.index_state_stability.test.ts`
- Test: `packages/mcp/src/core/handlers.scope.test.ts`
- Doc: `docs/INDEX_STATE_STABILITY_PLAN.md`
- Doc: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

- [ ] **Step 1: Freeze the intended readiness contract in tests**

Add or tighten fixtures for:
- search returns actionable navigation only when downstream exact symbol navigation is ready
- stale proof / missing collection / incompatible navigation state fail closed consistently
- search may still be the only sync-on-read path, but it reruns readiness after freshness before emitting results

Use assertions like:

```ts
assert.equal(payload.results[0]?.nextActions?.openSymbol, undefined);
assert.equal(payload.results[0]?.navigationFallback?.readSpan, undefined);
assert.equal(payload.recommendedNextAction?.tool, "manage_index");
```

for non-navigable exact-symbol states.

- [ ] **Step 2: Keep `TrackedRootReadiness` as the read-side SSOT**

Do not introduce a separate readiness cache or second classifier. Expand or reuse the existing state mapping so:
- `search_codebase`
- `file_outline`
- `call_graph`
- `read_file(open_symbol)`
- `manage_index status`

all route through the same proof/collection/fingerprint decision path.

- [ ] **Step 3: Split symbol-navigation readiness from graph-navigation readiness**

`openSymbol` and `callGraph` must not be coupled in one boolean. Add or use a boundary like:

```ts
type NavigationState = {
  symbolNavigationReady: boolean;
  graphNavigationReady: boolean;
};
```

Then enforce:
- exact symbol navigation may stay available when graph sidecar is missing
- graph actions stay suppressed unless graph navigation is ready

- [ ] **Step 4: Remove preview-span escape hatches when exact navigation is unavailable**

When exact navigation is not ready, suppress:
- `navigationFallback.readSpan`
- per-result `recommendedNextAction`
- top-level `recommendedNextAction` that points to preview-span reads
- `fallbacks` entries that resolve to preview-span `read_file`

Do not emit fake actionable paths from grouped preview spans.

- [ ] **Step 5: Update status/docs/tests together**

Make the spec explicit that `search_codebase` is still the compatibility sync-on-read exception, but readiness emission must match downstream tool legality.

- [ ] **Step 6: Run focused verification**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.index_state_stability.test.ts
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.scope.test.ts
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.golden.test.ts
```

Expected: PASS, with no search/manage/navigation disagreement for the same root state.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/core/tracked-root-readiness.ts \
  packages/mcp/src/core/tool-response-builders.ts \
  packages/mcp/src/core/handlers.ts \
  packages/mcp/src/core/search-result-finalization.ts \
  packages/mcp/src/core/handlers.index_state_stability.test.ts \
  packages/mcp/src/core/handlers.scope.test.ts \
  docs/INDEX_STATE_STABILITY_PLAN.md \
  docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md
git commit -m "fix(readiness): unify search and navigation readiness"
```

**Acceptance:**
- Search never emits navigation actions the downstream tools would reject for the same root.
- `manage_index status` and read/navigation tools describe the same terminal state family.
- No new foreground mutation path is introduced outside existing `search_codebase` freshness.

**Non-goals:**
- New readiness cache.
- Ranking work.
- Dynamic caller/callee recovery changes.

## Phase 3: Split `handlers.scope.test.ts` by Behavior Seams

### Task 3: Replace the monolith with stable behavior-focused suites

**Files:**
- Create: `packages/mcp/src/core/handlers.search.navigation.test.ts`
- Create: `packages/mcp/src/core/handlers.search.ranking.test.ts`
- Create: `packages/mcp/src/core/handlers.search.lexical.test.ts`
- Create: `packages/mcp/src/core/handlers.search.failclosed.test.ts`
- Create: `packages/mcp/src/core/handlers.search.fixtures.ts`
- Modify: `packages/mcp/src/core/handlers.scope.test.ts`
- Test: `packages/mcp/src/core/handlers.index_state_stability.test.ts`

- [ ] **Step 1: Map the current test seams before moving code**

Use the existing cases already clustered in `handlers.scope.test.ts`:
- navigation / symbol-span / fallback cases
- ranking and anchor scoring cases
- tracked lexical and changed-files cases
- fail-closed / freshness / backend failure cases

Preserve the current test override surface, including:

```ts
getChangedFilesForCodebase
parseGitStatusChangedPaths
changedFilesCache
evaluateReindexPreflight
shouldForceSearchPassFailure
```

- [ ] **Step 2: Extract shared fixtures, not hidden behavior**

Create a focused helper file for repo setup, handler construction, and stable payload parsing:

```ts
export function parseSearchPayload(response: ToolResponse): SearchResponseEnvelope
export async function withSearchTempRepo(...)
export function createTestHandlers(...)
```

Do not move product logic into test helpers.

- [ ] **Step 3: Move tests into 4 behavior suites**

Target split:
- `handlers.search.navigation.test.ts`
- `handlers.search.ranking.test.ts`
- `handlers.search.lexical.test.ts`
- `handlers.search.failclosed.test.ts`

Leave `handlers.scope.test.ts` as either:
- a thin compatibility barrel removed entirely, or
- a very small residual suite for cases that still span multiple seams

- [ ] **Step 4: Keep targeted execution fast**

Use the Node test runner features the repo already has:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.search.navigation.test.ts
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.search.failclosed.test.ts
node --test --test-name-pattern="all semantic passes fail"
```

- [ ] **Step 5: Run the whole handler search surface**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.search.navigation.test.ts src/core/handlers.search.ranking.test.ts src/core/handlers.search.lexical.test.ts src/core/handlers.search.failclosed.test.ts src/core/handlers.index_state_stability.test.ts
```

Expected: PASS with equivalent or better coverage and easier targeted reruns.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/core/handlers.search.navigation.test.ts \
  packages/mcp/src/core/handlers.search.ranking.test.ts \
  packages/mcp/src/core/handlers.search.lexical.test.ts \
  packages/mcp/src/core/handlers.search.failclosed.test.ts \
  packages/mcp/src/core/handlers.search.fixtures.ts \
  packages/mcp/src/core/handlers.scope.test.ts \
  packages/mcp/src/core/handlers.index_state_stability.test.ts
git commit -m "refactor(test): split search handler scope suite"
```

**Acceptance:**
- The big file is replaced by smaller suites with stable behavioral ownership.
- Existing override hooks remain reachable without private-field hacks.
- The fail-closed and readiness coverage remains explicit, not diluted.

**Non-goals:**
- Changing production behavior.
- Renaming large parts of the tool contract.

## Phase 4: Decompose Search Code by Ownership, Not Line Count

### Task 4: Make `handleSearchCode` a coordinator over existing search owners

**Files:**
- Modify: `packages/mcp/src/core/handlers.ts`
- Create or modify: `packages/mcp/src/core/search-request-validation.ts`
- Create or modify: `packages/mcp/src/core/search-error-responses.ts`
- Modify: `packages/mcp/src/core/search-execution.ts`
- Modify: `packages/mcp/src/core/search-result-finalization.ts`
- Modify: `packages/mcp/src/core/tool-response-builders.ts`
- Test: `packages/mcp/src/core/handlers.scope.test.ts` or the split suites from Phase 3

- [ ] **Step 1: Freeze the current boundary in a small inventory**

Document the intended owner split in code comments or module docblocks:
- request parsing and validation
- tracked-root front door and freshness
- search execution
- response finalization
- error payload construction

`handlers.ts` should remain the MCP entrypoint, not the owner of every branch.

- [ ] **Step 2: Extract request validation and diagnostics initialization**

Move the search request parsing/validation block near the top of `handleSearchCode` into a helper like:

```ts
export function parseSearchRequest(args: ToolArgs): SearchRequestInput | InvalidSearchRequest
```

This helper owns:
- defaults
- enum validation
- empty-query rejection

It should not own freshness, semantic search, or envelope emission.

- [ ] **Step 3: Extract backend-failure and final emit branching**

Move the `execution.kind` response branching into a small response mapper like:

```ts
export function buildSearchExecutionResponse(execution, context): SearchResponseEnvelope
```

This is the clean seam after Phases 1 and 2 because it owns:
- vector backend unavailable mapping
- all-pass failure mapping
- `ok` handoff into result finalization

It does not own ranking or readiness.

- [ ] **Step 4: Keep working-tree state ownership intact**

Do not absorb `getChangedFilesForCodebase`, `parseGitStatusChangedPaths`, or cache state into a generic coordinator module. Those belong with working-tree/read-path helpers until there is a stronger boundary than “handlers is large.”

- [ ] **Step 5: Run the smallest high-signal verification**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.search.failclosed.test.ts src/core/handlers.search.lexical.test.ts src/core/handlers.search.navigation.test.ts
pnpm run lint
pnpm run typecheck
```

Expected: PASS, with `handleSearchCode` materially smaller and no ownership regression.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/core/handlers.ts \
  packages/mcp/src/core/search-request-validation.ts \
  packages/mcp/src/core/search-error-responses.ts \
  packages/mcp/src/core/search-execution.ts \
  packages/mcp/src/core/search-result-finalization.ts \
  packages/mcp/src/core/tool-response-builders.ts
git commit -m "refactor(search): narrow handler ownership"
```

**Acceptance:**
- `handlers.ts` stays as the MCP adapter/coordinator.
- Search execution, readiness, and response assembly each have one clear owner.
- No “new giant coordinator” module appears.

**Non-goals:**
- Rewriting search ranking.
- Moving every helper out of `handlers.ts` just to reduce file length.

## Phase 5: Improve Search Performance at the Next Real Hotspot

### Task 5: Profile and trim tracked lexical fallback

**Files:**
- Create: `packages/mcp/src/core/search-benchmark.test.ts` or `packages/mcp/src/core/search-benchmark.ts`
- Modify: `packages/mcp/src/core/search-query-support.ts`
- Modify: `packages/mcp/src/core/search-execution.ts`
- Test: `packages/mcp/src/core/handlers.search.lexical.test.ts`
- Doc: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` or an internal perf note if one already exists

- [ ] **Step 1: Add a repeatable local measurement harness**

Build a small benchmark/probe that records:

```ts
performance.now()
process.cpuUsage()
process.resourceUsage()
```

and optionally writes a CPU profile when explicitly enabled:

```ts
import { Session } from "node:inspector/promises";
```

Do not add a runtime dependency or always-on profiling.

- [ ] **Step 2: Benchmark the current tracked lexical path**

Measure at least:
- exact-ish tracked lexical recovery
- non-exact fallback that still scans line-by-line
- path-scoped tracked file recovery

Record:
- wall-clock
- CPU
- files scanned
- bytes read

- [ ] **Step 3: Replace the `content.split()` fallback with a single-pass scanner**

The current fallback still allocates `lines = content.split(...)`. Replace it with a single-pass line scanner that:
- tracks best lexical line evidence
- computes the final context window from offsets or bounded line bookkeeping
- avoids materializing every line in large files

Sketch:

```ts
for each line window in content:
  score line
  keep best line index / offsets
build final bounded window once
```

- [ ] **Step 4: Preserve deterministic ranking and caps**

Do not change:
- `SEARCH_TRACKED_LEXICAL_MAX_FILES`
- `SEARCH_TRACKED_LEXICAL_TOTAL_BYTES`
- sort order
- operator filtering semantics

This phase is performance-only unless profiling proves a correctness bug.

- [ ] **Step 5: Prove the improvement with focused tests and one before/after measurement**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.search.lexical.test.ts
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.search.ranking.test.ts
```

Then run the benchmark harness and capture one checked-in note or PR evidence snippet showing the delta.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/core/search-benchmark.test.ts \
  packages/mcp/src/core/search-query-support.ts \
  packages/mcp/src/core/search-execution.ts \
  packages/mcp/src/core/handlers.search.lexical.test.ts \
  packages/mcp/src/core/handlers.search.ranking.test.ts
git commit -m "perf(search): trim tracked lexical fallback cost"
```

**Acceptance:**
- The next hotspot is measured, not guessed.
- The tracked lexical fallback allocates less and scans less expensively on large files.
- No cache, worker pool, or async filesystem rewrite is introduced without evidence.

**Non-goals:**
- Reranker redesign.
- Global search cache.
- Cross-process profiling infrastructure.

## Final Verification Gate

- [ ] Run the minimum relevant gates after the last phase:

```bash
pnpm run lint
pnpm run typecheck
pnpm --filter @zokizuan/satori-mcp test
```

- [ ] If any public response shape changed, re-check:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.golden.test.ts
```

- [ ] If readiness or navigation behavior changed, re-check:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.index_state_stability.test.ts
```

## Self-Review

- Scope is intentionally split: correctness before cleanup, cleanup before performance.
- The plan does not rely on a readiness TTL cache.
- The plan keeps `search_codebase` as the only sync-on-read exception and says so explicitly.
- The plan does not introduce new public MCP tools or knobs.
- The plan keeps test override reachability as a first-class constraint during suite splitting.
