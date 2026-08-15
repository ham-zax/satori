# Stale-While-Sync Qualification and MVCC Read Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish stale-while-sync as a publication-consistent MVCC read mode: every search result and ranking signal served during an active sync must come from one proven immutable publication, old-generation readers must survive a concurrent activation, and semantic worker resources must have an explicit production lifecycle owner.

**Architecture:** `served_previous_generation` is a publication-only read mode, not a working-tree overlay. The request pins one `ProvenVectorGenerationReceipt` plus any sealed navigation receipt, executes only publication-bound retrieval/navigation evidence, and holds the existing publication read lease until completion. Current working-tree state may still appear as clearly labelled freshness/debug metadata, but it must never generate, suppress, rewrite, preview, or rerank results in this mode.

**Tech Stack:** TypeScript, Node.js (`node:test`, `worker_threads`), LanceDB/Milvus publication receipts, Satori `SearchRequestCoordinator`, `PreparedPublicationReadSession`, and `IndexAuthorityCoordinator`.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-15-concurrent-published-reads-during-sync-design.md`.
- `served_previous_generation` requires an exact proven vector publication; never fall back to unpinned `semanticSearch(request)` in stale mode.
- Current working-tree bytes may be observed for diagnostics, but may not affect result generation, suppression, previews, reranker documents, or ranking while serving the previous publication.
- Keep the existing single publication authority. Do not introduce a second generation cache or read coordinator.
- Candidate generation remains private until activation; old readers remain valid under a publication read lease.
- Navigation may degrade independently of vector search. Missing navigation proof must not force a safe proven vector read to use an unpinned vector path.
- TDD: each behavior change gets a failing test before production code.
- Do not fold reranker reliability, package-scoped semantic invalidation, Go public `calls_v0` promotion, or installer protocol design into this repair.

---

### Task 1: Enforce Publication-Only Candidate and Ranking Evidence

**Files:**
- Create: `packages/mcp/src/core/search-execution.stale-publication.test.ts`
- Modify: `packages/mcp/src/core/search-execution.ts`

**Interfaces:**
- Consumes: `SearchExecutionInput.freshnessMode`.
- Produces: publication-only execution when `freshnessMode === "served_previous_generation"`.

**Behavior contract:**
- Pinned semantic/lexical backend retrieval remains allowed.
- `buildDirtyFileSearchResults()` must not run.
- `buildLivePathScopedSearchResults()` must not run.
- `buildTrackedLexicalSearchResults()` must not run because it scans current files from disk.
- Reranking that depends on current-source projection must not run in this first repair. Preserve retrieval order and expose normal stale-sync freshness metadata. A publication-native rerank projection can be added later.
- Working-tree divergence remains observable in freshness/debug metadata; do not erase the fact that source is newer than the served publication.

- [x] **Step 1: Write the failing stale-publication isolation test**

Create `packages/mcp/src/core/search-execution.stale-publication.test.ts` using the same `runSearchExecution` test style as `search-execution.native-order.test.ts`. Configure a non-empty changed-file set, an exact `path:` operator, and an enabled fake reranker. Each filesystem-backed search method and the reranker increments a counter.

Required assertions:

```ts
assert.equal(outcome.kind, "ok");
assert.equal(calls.dirtyOverlay, 0);
assert.equal(calls.trackedLexical, 0);
assert.equal(calls.livePath, 0);
assert.equal(calls.reranker, 0);
assert.deepEqual(
    outcome.scored.map((entry) => entry.result.relativePath),
    ["a.ts", "b.ts", "c.ts"],
);
assert.equal(outcome.orderAuthority, "retrieval_order");
assert.equal(outcome.freshnessSummary.syncMode, "served_previous_generation");
```

The production change that makes this test pass is the explicit publication-only gate. The test must fail on the current branch because current execution invokes filesystem-backed lexical evidence and reranking.

- [x] **Step 2: Run the focused test and observe RED**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test:raw src/core/search-execution.stale-publication.test.ts
```

Expected: FAIL because at least one current-source lane or reranker was invoked.

- [x] **Step 3: Implement the minimal execution gate**

In `search-execution.ts`, separate source divergence from live-evidence permission:

```ts
const publicationOnlyStaleRead = input.freshnessMode === "served_previous_generation";
const workingTreeDivergedFromPublication = observedChangedFilesState.available
    && observedChangedFilesCount > 0
    && input.freshnessMode !== "synced"
    && input.freshnessMode !== "skipped_source_unchanged"
    && input.freshnessMode !== "reconciled_ignore_change";
const allowLiveWorkingTreeEvidence = workingTreeDivergedFromPublication
    && !publicationOnlyStaleRead;
```

Use `allowLiveWorkingTreeEvidence` for dirty-source suppression and `buildDirtyFileSearchResults()`. Guard tracked lexical and live-path calls with `!publicationOnlyStaleRead`. Skip the current rerank phase for `publicationOnlyStaleRead`, retaining retrieval order and `rerankerAttempted === false`.

Do **not** redefine divergence to false: freshness/debug output may still truthfully report that working tree source is ahead of the served publication.

- [x] **Step 4: Re-run focused test and observe GREEN**

Run the focused test above; expected PASS.

- [x] **Step 5: Run neighboring search-execution tests**

```bash
pnpm --filter @zokizuan/satori-mcp test:raw \
  src/core/search-execution.native-order.test.ts \
  src/core/search-execution.must-lane.test.ts
```

Expected: PASS; normal settled-search behavior remains unchanged.

- [x] **Step 6: Commit**

```bash
git add packages/mcp/src/core/search-execution.ts \
  packages/mcp/src/core/search-execution.stale-publication.test.ts
git commit -m "fix(mcp): isolate stale publication search evidence"
```

---

### Task 2: Remove Current-Source Exact-Registry Dependence in Stale Mode

**Files:**
- Modify: `packages/mcp/src/core/search-exact-fast-path.ts`
- Create: `packages/mcp/src/core/search-exact-fast-path.stale-publication.test.ts`

**Interfaces:**
- Consumes: existing `SearchExactFastPathInput.freshnessDecision`.
- Produces: exact symbol/navigation evidence from the sealed publication without reading current source bytes in stale mode.

**Behavior contract:** exact registry and sealed relationship graph are publication-owned and may remain usable. Current-source span repair and preview extraction are not publication-owned and must be disabled in `served_previous_generation`.

- [x] **Step 1: Write a failing test**

Inject a current-source reader/validation seam using the existing test-host pattern. In stale mode, a valid exact registry hit must not call current-source validation or preview reading; result preview may be empty if publication-native source bytes are unavailable.

Required assertions:

```ts
assert.equal(currentSourceReadCalls, 0);
assert.equal(currentSourceValidationCalls, 0);
assert.equal(outcome.kind, "handled");
```

- [x] **Step 2: Run focused test and observe RED**

```bash
pnpm --filter @zokizuan/satori-mcp test:raw src/core/search-exact-fast-path.stale-publication.test.ts
```

Expected: FAIL because the current fast path calls `readCurrentSourceEvidence()` for previews.

- [x] **Step 3: Implement stale exact-path behavior**

Add:

```ts
const publicationOnlyStaleRead =
    input.freshnessDecision.mode === "served_previous_generation";
```

When true:
- do not run dirty current-source symbol span repair;
- do not call `readCurrentSourceEvidence()`;
- use sealed registry/relationship symbols as-is;
- construct an empty preview when no publication-native source bytes are available.

Normal non-stale exact search remains unchanged.

- [x] **Step 4: Re-run focused and existing exact-registry tests**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/mcp/src/core/search-exact-fast-path.ts \
  packages/mcp/src/core/search-exact-fast-path.stale-publication.test.ts
git commit -m "fix(mcp): keep stale exact search publication bound"
```

---

### Task 3: Require a Proven Vector Publication Before Stale Admission

**Files:**
- Modify: `packages/mcp/src/core/search-frontdoor.ts`
- Modify: `packages/mcp/src/core/tracked-root-readiness.ts` only if needed to make the readiness meaning truthful.
- Modify/Test: `packages/mcp/src/core/search-frontdoor.test.ts`
- Modify/Test: `packages/mcp/src/core/search-concurrent-published-reads.test.ts`

**Interfaces:**
- Consumes: `trackedRootState.searchableRead.vectorReceipt`.
- Produces: `served_previous_generation` only when a concrete `ProvenVectorGenerationReceipt` exists.

**Behavior contract:**
- Require `searchableRead.vectorReceipt` for stale vector search.
- Do not trust `searchableGenerationAvailable` as publication proof by itself.
- Do not require a navigation generation receipt merely to perform safe vector search. If navigation is advertised but cannot be proven, navigation must degrade independently rather than making vector retrieval unpinned.
- A stale request must never reach the fallback `semanticSearch(request)` path.

- [x] **Step 1: Add failing front-door test for missing vector receipt**

Host returns active sync + `searchableRead` but no vector receipt. Assert the result does **not** enter `served_previous_generation`.

- [x] **Step 2: Add failing coordinator test for unpinned fallback**

For a stale-mode request, configure the host so `semanticSearchInProvenGeneration` records calls and plain `semanticSearch` throws. Assert the stale request invokes only the proven-generation path.

- [x] **Step 3: Run focused tests and observe RED**

- [x] **Step 4: Implement strict vector receipt admission**

Add `trackedRootState.searchableRead.vectorReceipt` to the stale-admission gate. If a valid receipt is missing, retain the existing blocked/wait path instead of manufacturing stale readiness.

- [x] **Step 5: Re-run tests and observe GREEN**

- [x] **Step 6: Commit**

```bash
git add packages/mcp/src/core/search-frontdoor.ts \
  packages/mcp/src/core/search-frontdoor.test.ts \
  packages/mcp/src/core/search-concurrent-published-reads.test.ts
git commit -m "fix(mcp): require proven publication for stale reads"
```

---

### Task 4: Prove and Repair the N-to-N+1 MVCC Activation Race

**Files:**
- Modify: `packages/mcp/src/core/search-request-coordinator.ts`
- Modify/Test: `packages/mcp/src/core/search-concurrent-published-reads.test.ts`
- Modify/Test only if required: `packages/core/src/generation/index-authority-coordinator.test.ts`

**Interfaces:**
- Consumes: `PreparedPublicationReadSession`, `acquirePublicationReadLease()`, generation-bound semantic retrieval, and publication retention gates.
- Produces: Search A that starts on N finishes on N even when N+1 activates; Search B started after activation binds N+1.

**Known current risk:** after the lease is acquired, `SearchRequestCoordinator` still compares `preparedObservation` with the current authority observation. Activation can legitimately change that pointer while the pinned old generation remains retained, so stale-mode N readers must not be invalidated solely by N+1 activation.

- [x] **Step 1: Replace simulation-only test with real coordinator behavior**

The test must instantiate/exercise the actual `SearchRequestCoordinator`/`PreparedPublicationReadSession` path. Do not manually construct a fake `frontDoorResult` and call that “coordinator execution.”

Use deferred promises to:
1. bind Search A to receipt N;
2. acquire its publication read lease;
3. hold retrieval;
4. switch the host's current prepared authority to N+1;
5. start Search B and prove it uses receipt N+1;
6. release A and prove A completes from N.

Assertions must include:

```ts
assert.deepEqual(boundCollectionsForA, ["col_gen_n"]);
assert.deepEqual(boundCollectionsForB, ["col_gen_n1"]);
assert.equal(unpinnedSemanticSearchCalls, 0);
```

- [x] **Step 2: Add/retain Core retention-gate proof**

Using real `IndexAuthorityCoordinator.acquirePublicationReadLease()`, prove retention cleanup waits while A's lease is held and can proceed after release. Keep this separate from MCP retrieval assertions so each ownership boundary is testable.

- [x] **Step 3: Run tests and observe RED if activation invalidates A**

- [x] **Step 4: Implement minimal stale-session authority revalidation rule**

For `served_previous_generation`, current-authority pointer movement after lease acquisition is not itself a stale condition. Revalidation must preserve the pinned receipt identity and lease, not require the global current pointer to remain N.

Non-stale/current-source reads retain existing authority/source-drift checks.

- [x] **Step 5: Re-run focused tests and observe GREEN**

- [x] **Step 6: Commit**

```bash
git add packages/mcp/src/core/search-request-coordinator.ts \
  packages/mcp/src/core/search-concurrent-published-reads.test.ts \
  packages/core/src/generation/index-authority-coordinator.test.ts
git commit -m "fix(mcp): preserve pinned readers across publication activation"
```

---

### Task 5: Give the Semantic Worker a Real Production Lifecycle Owner

**Files:**
- Modify: `packages/core/src/semantic/analyzer-port.ts`
- Modify: `packages/core/src/core/context.ts`
- Modify/Test: `packages/core/src/semantic/wasm/wasm-threaded-analyzer.test.ts`
- Modify: `packages/mcp/src/server/shared-runtime.ts`
- Modify: `packages/mcp/src/server/provider-runtime.ts`
- Modify/Test: `packages/mcp/src/server/provider-runtime.test.ts`
- Add a focused Core Context lifecycle test if no suitable existing test exists.

**Interfaces:**
- `SemanticProjectAnalyzer.dispose?(): Promise<void>`.
- `Context.dispose(): Promise<void>`.

**Behavior contract:** Context owns the semantic analyzer it passes to `IndexGenerationWorkflow`; runtime shutdown owns Context disposal. Shutdown is idempotent and happens only after active sync lifecycle work is drained.

- [x] **Step 1: Add failing analyzer-port type/lifecycle test**

Use a fake analyzer with a dispose counter. The test must prove Context, not test code, owns disposal.

- [x] **Step 2: Add the lifecycle contract in the correct interface file**

In `packages/core/src/semantic/analyzer-port.ts`:

```ts
export interface SemanticProjectAnalyzer {
    supportsLanguage(language: string): boolean;
    analyze(input: SemanticProjectInput): Promise<SemanticProjectEvidence>;
    dispose?(): Promise<void>;
}
```

- [x] **Step 3: Make Context own the analyzer**

Add optional `semanticAnalyzer?: SemanticProjectAnalyzer` to `ContextConfig`, store:

```ts
private readonly semanticAnalyzer: SemanticProjectAnalyzer;
```

Initialize with injected analyzer or `new ThreadedWasmSemanticProjectAnalyzer()`, pass that field to the workflow, and add idempotent `Context.dispose()` that awaits `this.semanticAnalyzer.dispose?.()`.

- [x] **Step 4: Wire actual runtime owners**

After sync lifecycle drain:
- `SharedRuntimeHost.shutdown()` calls `await this.localContext.dispose()`.
- `ProviderRuntime.shutdown()` calls `await toolContext.context.dispose()` for each active provider context before/alongside closing remaining provider resources.

Avoid double-closing shared resources; analyzer disposal must be idempotent.

- [x] **Step 5: Run Core and MCP lifecycle tests**

Expected: fake analyzer dispose count is exactly one per Context; worker-backed analyzer terminates cleanly.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/semantic/analyzer-port.ts \
  packages/core/src/core/context.ts \
  packages/core/src/semantic/wasm/wasm-threaded-analyzer.test.ts \
  packages/mcp/src/server/shared-runtime.ts \
  packages/mcp/src/server/provider-runtime.ts \
  packages/mcp/src/server/provider-runtime.test.ts
git commit -m "fix(runtime): own semantic worker lifecycle through Context"
```

---

### Task 6: Make Freshness Trigger Diagnostics Causal Without Dropping Existing Reasons

**Files:**
- Modify: `packages/mcp/src/core/sync.ts`
- Modify/Test: `packages/mcp/src/core/sync-diagnostic-triggers.test.ts`

**Interfaces:**
- Consumes: `FreshnessTriggerInput`.
- Produces: stable `FreshnessTriggerReason` without inventing an undeclared `unknown` state.

**Behavior contract:** preserve `ignore_control_changed` and `checkpoint_changed`; actual completed `differs` evidence is more causal than generic watcher pending; watcher pending remains more informative than an unavailable comparison.

- [x] **Step 1: Write failing precedence tests**

```ts
assert.equal(determineFreshnessTriggerReason({
    watcherPending: true,
    fullComparison: { status: "differs" },
}), "full_compare_differs");

assert.equal(determineFreshnessTriggerReason({
    checkpointChanged: true,
    fullComparison: { status: "differs" },
}), "checkpoint_changed");

assert.equal(determineFreshnessTriggerReason({
    watcherPending: true,
    fullComparison: { status: "unavailable" },
}), "watcher_pending");
```

- [x] **Step 2: Run tests and observe RED**

- [x] **Step 3: Implement precedence**

```ts
if (input.ignoreControlChanged) return "ignore_control_changed";
if (input.checkpointChanged) return "checkpoint_changed";
if (input.exactComparison?.status === "differs") return "exact_compare_differs";
if (input.fullComparison?.status === "differs") return "full_compare_differs";
if (input.watcherPending) return "watcher_pending";
if (input.exactComparison?.status === "unavailable") return "exact_compare_unavailable";
if (input.fullComparison?.status === "unavailable") return "full_compare_unavailable";
if (input.thresholdMs === 0) return "manual_zero_threshold";
return "threshold_expired";
```

- [x] **Step 4: Re-run tests and observe GREEN**

- [x] **Step 5: Commit**

```bash
git add packages/mcp/src/core/sync.ts packages/mcp/src/core/sync-diagnostic-triggers.test.ts
git commit -m "fix(mcp): report causal freshness sync triggers"
```

---

### Task 7: Exact-Head Qualification

**Files:** none unless qualification exposes a defect.

> **Status after branch-history alignment:** intentionally pending. Tasks 1-6 are implemented, but the compatibility identity, CI fixture, evidence ancestry, and real product harness were aligned after the earlier qualification receipts. Run every item below on the exact pulled final head before marking Task 7 complete.

- [ ] Run semantic artifact verification:

```bash
pnpm semantic:verify
```

- [ ] Run workspace checks:

```bash
pnpm run check
```

- [ ] Run Core tests:

```bash
pnpm --filter @zokizuan/satori-core test
```

- [ ] Run MCP tests:

```bash
pnpm --filter @zokizuan/satori-mcp test
```

- [ ] Run installer tests because runtime lifecycle ownership changed:

```bash
node --test scripts/install-local-mcp-runtime.test.mjs
```

- [ ] Run packed/release verification:

```bash
pnpm run release:check
```

- [ ] Product characterization on the exact qualified head:
  1. Run `pnpm --filter @zokizuan/satori-mcp exec tsx ../../scripts/trufflehog-mvcc-product-run.ts` from the repository after pulling the final branch head. Set `SATORI_TASK7_REPO` if the TruffleHog checkout is elsewhere.
  2. The harness must observe a real sync in `writing` after creating a reversible tracked Go-source delta.
  3. It must fire five parallel searches without a settle/throwaway ritual and require 5/5 `status=ok` responses.
  4. Every response must identify the same immutable publication N and the exact pending sync generation.
  5. The exact sync must complete and activate a distinct publication N+1; a post-activation search must succeed while N+1 remains authoritative.

## Explicit Follow-Ups — Not Part of This Repair

The following remain separate tracks and must not be claimed as fixed by Tasks 1-7:

1. **Reranker reliability:** investigate intermittent `RERANKER_FAILED` and quantify fallback quality loss; the benchmark showed that fallback can change the top result set, not merely reorder it.
2. **Semantic invalidation scope:** replace “one changed Go file → rebuild all Go files” with package/dependency-aware invalidation before multiplying CBM languages.
3. **Graceful installer protocol:** evolve local runtime replacement from PID termination toward an explicit runtime drain handshake. Context/worker disposal in Task 5 is a prerequisite, not the complete installer protocol.
4. **Go public call graph promotion:** promote Go from `symbol_only` to `calls_v0` only after relationship qualification.
