# Concurrent Published Reads During Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Concurrent Published Reads During Mutation (stale-while-sync) so background syncs never take search offline, isolate CBM WASM semantic analysis onto a `worker_threads` worker to prevent event loop starvation, add structured freshness trigger diagnostics, and implement graceful installer drain.

**Architecture:** 
1. **Read-Policy Seam**: `search-frontdoor.ts` checks active syncs and, when a valid `ProvenGenerationReceipt` exists, serves queries against the immutable published snapshot using `acquirePublicationReadLease()`, attaching `freshness: { state: "sync_in_progress", servedGeneration, pendingOperation }` metadata.
2. **CBM Worker Isolation**: Native WebAssembly semantic resolution is wrapped in a dedicated `worker_threads` Worker (`ThreadedWasmSemanticProjectAnalyzer`), preserving 100% MCP event loop responsiveness during AST parsing and call graph extraction.
3. **Diagnostics & Lifecycle Drain**: `ensureFreshness()` logs explicit structured trigger reasons, and `install-local-mcp-runtime.mjs` requests `stopAndDrainLifecycle()` before terminating servers.

**Tech Stack:** TypeScript, Node.js (`worker_threads`), LanceDB, WebAssembly / Emscripten, Node test runner (`node:test`).

## Global Constraints

* Follow the approved design in `docs/superpowers/specs/2026-08-15-concurrent-published-reads-during-sync-design.md`.
* Do not mutate the currently published LanceDB collection in place; rely on COW candidate generations and atomic activation.
* Every search/navigation read must bind to exactly one immutable proven publication (`PreparedPublicationReadSession`) for its entire lifecycle.
* Pure read operations (`search_codebase`, `read_file`, `file_outline`) must never take a global mutex.
* Only initial `create` (no prior publication), format corruption, or unprovable generation states may return `not_ready`.
* The CBM WASM binary and ABI v1 contract are immutable deliverables verified by `pnpm semantic:verify`.

---

### Task 1: Stale-While-Sync Read-Policy Seam & Freshness Response Annotation

**Files:**
- Modify: `packages/mcp/src/core/search-frontdoor.ts`
- Modify: `packages/mcp/src/core/search-types.ts`
- Modify: `packages/mcp/src/core/search-response-helpers.ts`
- Test: `packages/mcp/src/core/search-frontdoor.test.ts`
- Test: `packages/mcp/src/core/search-concurrent-published-reads.test.ts`

**Interfaces:**
- Consumes: `TrackedRootReadinessState` with `state: "indexing"`, `operation.action === "sync"`, `searchableGenerationAvailable: true`, and `searchableRead`.
- Produces: `SearchFrontDoorReady` with `freshnessDecision: { mode: "served_previous_generation", servedGeneration: number, pendingOperation?: { action: string, generation: number } }`, and response envelope `meta.freshness: { state: "sync_in_progress", servedGeneration: number, pendingOperation?: { action: string, generation: number } }`.

- [ ] **Step 1: Write failing unit test for stale-while-sync front door readiness**

In `packages/mcp/src/core/search-frontdoor.test.ts`:
```ts
test('runSearchFrontDoor serves previous published generation when sync is actively indexing', async () => {
    const preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }> = {
        state: 'ready',
        codebasePath: '/repo',
        collectionName: 'col_gen_15',
        manifestHash: 'man-15',
        root: { path: '/repo', displayName: 'repo', files: 100, customName: 'repo' },
        proofDebugHint: { completionProof: 'valid', indexPolicyMatches: true },
        vectorReceipt: { generation: 15, collectionName: 'col_gen_15', dimension: 256 },
        generationReceipt: { generation: 15, manifestHash: 'man-15' },
        navigationStatus: 'valid',
        preparedObservation: 'obs-15',
    };

    const host: SearchFrontDoorHost = createMockSearchFrontDoorHost({
        prepareInitialTrackedRootRead: async () => ({
            state: 'indexing',
            codebasePath: '/repo',
            operation: { action: 'sync', generation: 16, phase: 'writing', id: 'op-16' },
            searchableGenerationAvailable: true,
            searchableRead: preparedRead,
        }),
    });

    const result = await runSearchFrontDoor(
        { path: '/repo', query: 'test query' },
        host,
    );

    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') {
        assert.equal(result.generationReceipt?.generation, 15);
        assert.equal(result.freshnessDecision.mode, 'served_previous_generation');
        assert.equal(result.freshnessDecision.servedGeneration, 15);
        assert.deepEqual(result.freshnessDecision.pendingOperation, { action: 'sync', generation: 16 });
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zokizuan/satori-mcp test:raw src/core/search-frontdoor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement stale-while-sync readiness in `search-frontdoor.ts` & metadata in `search-response-helpers.ts`**

Update `packages/mcp/src/core/search-frontdoor.ts`:
```ts
    let trackedRootState = await host.prepareInitialTrackedRootRead(absolutePath);
    let activeSyncServingPrevious = false;
    let servedPreviousGeneration: number | undefined;
    let pendingSyncOperation: { action: string; generation: number } | undefined;

    if (
        trackedRootState.state === "indexing"
        && trackedRootState.operation?.action === "sync"
        && trackedRootState.searchableGenerationAvailable
        && trackedRootState.searchableRead
    ) {
        // Stale-while-sync: serve the proven readable generation immediately without blocking
        activeSyncServingPrevious = true;
        servedPreviousGeneration = trackedRootState.searchableRead.generationReceipt?.generation;
        if (trackedRootState.operation) {
            pendingSyncOperation = {
                action: trackedRootState.operation.action,
                generation: trackedRootState.operation.generation,
            };
        }
        trackedRootState = trackedRootState.searchableRead;
    }
```
And in `packages/mcp/src/core/search-response-helpers.ts`:
```ts
if (freshnessDecision.mode === 'served_previous_generation') {
    responseEnvelope.meta = {
        ...responseEnvelope.meta,
        freshness: {
            state: 'sync_in_progress',
            servedGeneration: freshnessDecision.servedGeneration,
            pendingOperation: freshnessDecision.pendingOperation,
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zokizuan/satori-mcp test:raw src/core/search-frontdoor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/core/search-frontdoor.ts packages/mcp/src/core/search-types.ts packages/mcp/src/core/search-response-helpers.ts packages/mcp/src/core/search-frontdoor.test.ts
git commit -m "feat(mcp): implement stale-while-sync readiness and freshness metadata"
```

---

### Task 2: Parallel Search Concurrency & Generation Pinning Tests

**Files:**
- Create: `packages/mcp/src/core/search-concurrent-published-reads.test.ts`
- Modify: `packages/mcp/src/core/search-request-coordinator.ts`

**Interfaces:**
- Consumes: Concurrent search queries while sync is actively held in `phase: "writing"`.
- Produces: All concurrent queries complete with `status: "ok"` and `meta.freshness.state: "sync_in_progress"`.

- [ ] **Step 1: Write integration test for parallel searches during active sync**

Create `packages/mcp/src/core/search-concurrent-published-reads.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('parallel searches succeed concurrently during active sync without blocking', async () => {
    // Dispatch 5 concurrent searches against mock host with held sync
    const queries = ['aws credential', 'git commit', 'entropy check', 'archive utils', 'source manager'];
    const outcomes = await Promise.all(
        queries.map((query) => mockSearchFrontDoorAndExecute(query)),
    );

    assert.equal(outcomes.length, 5);
    for (const outcome of outcomes) {
        assert.equal(outcome.status, 'ok');
        assert.equal(outcome.meta?.freshness?.state, 'sync_in_progress');
        assert.equal(outcome.meta?.freshness?.servedGeneration, 15);
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zokizuan/satori-mcp test:raw src/core/search-concurrent-published-reads.test.ts`
Expected: FAIL.

- [ ] **Step 3: Ensure read lease coordinator allows concurrent published readers**

In `packages/mcp/src/core/search-request-coordinator.ts`, verify that each request acquires its independent read lease and executes against the pinned `searchableRead` session.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zokizuan/satori-mcp test:raw src/core/search-concurrent-published-reads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/core/search-concurrent-published-reads.test.ts packages/mcp/src/core/search-request-coordinator.ts
git commit -m "test(mcp): add parallel search concurrency tests during active sync"
```

---

### Task 3: Off-Thread CBM Semantic Analyzer Worker (`worker_threads`)

**Files:**
- Create: `packages/core/src/semantic/wasm/wasm-worker-runner.ts`
- Create: `packages/core/src/semantic/wasm/wasm-threaded-analyzer.ts`
- Modify: `packages/core/src/semantic/index.ts`
- Test: `packages/core/src/semantic/wasm/wasm-threaded-analyzer.test.ts`

**Interfaces:**
- Consumes: `SemanticProjectInput` `{ language: string, sourceFiles: SemanticSourceFile[], auxiliaryFiles: SemanticAuxiliaryFile[] }`.
- Produces: `Promise<SemanticProjectEvidence>` resolved asynchronously in a Node.js `worker_threads` Worker.

- [ ] **Step 1: Write failing test verifying event loop responsiveness during heavy WASM analysis**

Create `packages/core/src/semantic/wasm/wasm-threaded-analyzer.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadedWasmSemanticProjectAnalyzer } from './wasm-threaded-analyzer';

test('ThreadedWasmSemanticProjectAnalyzer executes analysis without blocking main event loop', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    assert.equal(analyzer.supportsLanguage('go'), true);

    let eventLoopTicks = 0;
    const timer = setInterval(() => { eventLoopTicks += 1; }, 5);

    const result = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [{ role: 'go.mod', path: 'go.mod', source: 'module example.com/test\n\ngo 1.21\n' }],
        sourceFiles: [
            { path: 'main.go', source: 'package main\n\nfunc Helper() {}\nfunc main() {\n    Helper()\n}\n' },
        ],
    });

    clearInterval(timer);
    assert.ok(eventLoopTicks > 0, 'Main event loop ticked during WASM analysis');
    assert.equal(result.language, 'go');
    assert.ok(result.occurrencesByFile.has('main.go'));
    await analyzer.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zokizuan/satori-core test:raw src/semantic/wasm/wasm-threaded-analyzer.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement Worker Runner and Threaded Analyzer**

Create `packages/core/src/semantic/wasm/wasm-worker-runner.ts` and `packages/core/src/semantic/wasm/wasm-threaded-analyzer.ts`.
Export `ThreadedWasmSemanticProjectAnalyzer` from `packages/core/src/semantic/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zokizuan/satori-core test:raw src/semantic/wasm/wasm-threaded-analyzer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/semantic/wasm/wasm-worker-runner.ts packages/core/src/semantic/wasm/wasm-threaded-analyzer.ts packages/core/src/semantic/wasm/wasm-threaded-analyzer.test.ts packages/core/src/semantic/index.ts
git commit -m "feat(semantic): add ThreadedWasmSemanticProjectAnalyzer worker pool"
```

---

### Task 4: Diagnostic Structured Logging for `ensureFreshness` Triggers

**Files:**
- Modify: `packages/mcp/src/core/sync.ts:1380-1450`
- Test: `packages/mcp/src/core/sync-diagnostic-triggers.test.ts`

**Interfaces:**
- Consumes: Freshness evaluation inputs.
- Produces: Explicit structured trigger reason: `'watcher_pending' | 'exact_compare_differs' | 'exact_compare_unavailable' | 'full_compare_differs' | 'full_compare_unavailable' | 'ignore_control_changed' | 'threshold_expired' | 'checkpoint_changed' | 'none'`.

- [ ] **Step 1: Write failing test for structured trigger reason calculation**

Create `packages/mcp/src/core/sync-diagnostic-triggers.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { determineFreshnessTriggerReason } from './sync';

test('determineFreshnessTriggerReason categorizes ignore_control_changed', () => {
    const reason = determineFreshnessTriggerReason({
        ignoreControlChanged: true,
        watcherPending: false,
        exactComparison: { status: 'matches' },
    });
    assert.equal(reason, 'ignore_control_changed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zokizuan/satori-mcp test:raw src/core/sync-diagnostic-triggers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement trigger determination and logging in `sync.ts`**

Implement `determineFreshnessTriggerReason` and add log in `ensureFreshness()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zokizuan/satori-mcp test:raw src/core/sync-diagnostic-triggers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/core/sync.ts packages/mcp/src/core/sync-diagnostic-triggers.test.ts
git commit -m "feat(sync): add structured diagnostic triggers to ensureFreshness"
```

---

### Task 5: Graceful Installer Drain Before Host Termination

**Files:**
- Modify: `scripts/install-local-mcp-runtime.mjs`
- Modify: `packages/cli/src/terminate.ts`
- Test: `scripts/install-local-mcp-runtime.test.mjs`

**Interfaces:**
- Consumes: Active Satori runtime host socket / process.
- Produces: Graceful drain request (`stopAndDrainLifecycle`) before sending `SIGTERM`.

- [ ] **Step 1: Write test for graceful drain before termination**

In `scripts/install-local-mcp-runtime.test.mjs`:
```ts
test('terminateSatoriServers requests graceful drain and waits for active sync flights', async () => {
    let drainRequested = false;
    const mockRuntimeHost = {
        stopAndDrain: async () => { drainRequested = true; },
    };
    await terminateSatoriServersWithDrain(mockRuntimeHost);
    assert.equal(drainRequested, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/install-local-mcp-runtime.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement graceful drain in `scripts/install-local-mcp-runtime.mjs` and `terminate.ts`**

Update `packages/cli/src/terminate.ts` and `scripts/install-local-mcp-runtime.mjs` to attempt socket-based drain before fallback to `SIGTERM`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/install-local-mcp-runtime.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-local-mcp-runtime.mjs packages/cli/src/terminate.ts scripts/install-local-mcp-runtime.test.mjs
git commit -m "feat(cli): request graceful drain before terminating Satori server hosts"
```

---

### Task 6: Full Qualification & TruffleHog Benchmark Re-verification

**Files:**
- Run full qualification suite across monorepo.

- [ ] **Step 1: Verify semantic reproducibility**
Run: `pnpm semantic:verify`
Expected: PASS with matching digests.

- [ ] **Step 2: Run typecheck, lint, and all workspace tests**
Run: `pnpm run check && pnpm test`
Expected: 0 errors, 100% pass across core, mcp, and cli.

- [ ] **Step 3: Reinstall local MCP runtime**
Run: `pnpm run dev:install-local-mcp -- --client opencode`
Expected: Activation successful, preflight verified.

- [ ] **Step 4: Verify doctor diagnostics**
Run: `satori doctor --verbose`
Expected: 0 problems, 0 abandoned leases.

- [ ] **Step 5: Commit and final inspect**
```bash
git status
```
Verify clean git tree and inspect diff.
