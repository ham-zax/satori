import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSearchFrontDoor } from './search-frontdoor.js';
import type { SearchFrontDoorHost } from './search-frontdoor.js';
import { DEFAULT_MANAGE_RETRY_AFTER_MS } from '../config.js';

test('search front door rebinds freshness when post-freshness root identity changes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-'));
    const rootA = path.join(tempRoot, 'repo');
    const rootB = path.join(rootA, 'nested');
    fs.mkdirSync(rootB, { recursive: true });
    const freshnessRoots: string[] = [];
    let postReads = 0;
    const ready = (rootPath: string) => ({
        state: 'ready' as const,
        root: { path: rootPath, info: { status: 'indexed' as const } },
    });
    const host = {
        prepareInitialTrackedRootRead: async () => ready(rootA),
        preparePostFreshnessTrackedRootRead: async () => {
            postReads += 1;
            return ready(rootB);
        },
        ensureSearchFreshness: async (rootPath: string) => {
            freshnessRoots.push(rootPath);
            return {
                mode: 'skipped_recent' as const,
                changed: false,
                checkedAt: rootPath === rootA ? 'A' : 'B',
                thresholdMs: 60_000,
            };
        },
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;

    try {
        const result = await runSearchFrontDoor({
            path: rootB,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);

        assert.equal(result.kind, 'ready');
        if (result.kind !== 'ready') return;
        assert.equal(result.effectiveRoot, rootB);
        assert.equal(result.freshnessDecision.checkedAt, 'B');
        assert.deepEqual(freshnessRoots, [rootA, rootB]);
        assert.equal(postReads, 2);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door blocks when the source checkpoint is unavailable', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-checkpoint-warning-'));
    const ready = {
        state: 'ready' as const,
        root: { path: tempRoot, info: { status: 'indexed' as const } },
    };
    const host = {
        prepareInitialTrackedRootRead: async () => ready,
        preparePostFreshnessTrackedRootRead: async () => ready,
        ensureSearchFreshness: async () => ({
            mode: 'skipped_source_checkpoint_unavailable' as const,
            checkedAt: 'now',
            thresholdMs: 60_000,
            checkpointStatus: 'missing' as const,
        }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => ({
            status: 'requires_reindex',
            reason: 'requires_reindex',
            results: [],
        }),
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal(result.payload.status, 'requires_reindex');
        assert.equal(result.payload.reason, 'requires_reindex');
        assert.deepEqual(result.payload.results, []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door rebinds root identity before returning a freshness block', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-blocked-'));
    const rootA = path.join(tempRoot, 'repo');
    const rootB = path.join(rootA, 'nested');
    fs.mkdirSync(rootB, { recursive: true });
    const freshnessRoots: string[] = [];
    let postReads = 0;
    const ready = (rootPath: string) => ({
        state: 'ready' as const,
        root: { path: rootPath, info: { status: 'indexed' as const } },
    });
    const host = {
        prepareInitialTrackedRootRead: async () => ready(rootA),
        preparePostFreshnessTrackedRootRead: async () => {
            postReads += 1;
            return ready(rootB);
        },
        ensureSearchFreshness: async (rootPath: string) => {
            freshnessRoots.push(rootPath);
            return { mode: 'failed' as const, changed: false, checkedAt: rootPath, thresholdMs: 60_000 };
        },
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: (rootPath: string) => ({ status: 'not_ready', path: rootPath }),
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;

    try {
        const result = await runSearchFrontDoor({
            path: rootB,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal((result.payload as { path?: string }).path, rootB);
        assert.deepEqual(freshnessRoots, [rootA, rootB]);
        assert.equal(postReads, 2);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door returns rebound root readiness instead of an old-root freshness block', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-readiness-rebind-'));
    const rootA = path.join(tempRoot, 'repo');
    const rootB = path.join(rootA, 'nested');
    fs.mkdirSync(rootB, { recursive: true });
    const host = {
        prepareInitialTrackedRootRead: async () => ({
            state: 'ready' as const,
            root: { path: rootA, info: { status: 'indexed' as const } },
        }),
        preparePostFreshnessTrackedRootRead: async () => ({
            state: 'requires_reindex' as const,
            codebasePath: rootB,
            message: 'new-root-proof-failed',
        }),
        ensureSearchFreshness: async () => ({
            mode: 'failed' as const,
            changed: false,
            checkedAt: 'A',
            thresholdMs: 60_000,
        }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: (rootPath: string) => ({ status: 'not_ready', path: rootPath, reason: 'old-root' }),
        buildRequiresReindexPayload: (rootPath: string, detail: string) => ({ status: 'requires_reindex', path: rootPath, reason: detail }),
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: rootB,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal((result.payload as { path?: string }).path, rootB);
        assert.equal((result.payload as { reason?: string }).reason, 'new-root-proof-failed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door rejects a second root change while freshness remains blocked', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-repeat-rebind-'));
    const rootA = path.join(tempRoot, 'repo');
    const rootB = path.join(rootA, 'nested');
    const rootC = path.join(rootB, 'deeper');
    fs.mkdirSync(rootC, { recursive: true });
    let postReads = 0;
    const ready = (rootPath: string) => ({
        state: 'ready' as const,
        root: { path: rootPath, info: { status: 'indexed' as const } },
    });
    const host = {
        prepareInitialTrackedRootRead: async () => ready(rootA),
        preparePostFreshnessTrackedRootRead: async () => {
            postReads += 1;
            return ready(postReads === 1 ? rootB : rootC);
        },
        ensureSearchFreshness: async () => ({ mode: 'failed' as const, changed: false, checkedAt: 'x', thresholdMs: 60_000 }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: (rootPath: string) => ({ status: 'not_ready', path: rootPath }),
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        await assert.rejects(
            () => runSearchFrontDoor({
                path: rootC,
                query: 'owner',
                scope: 'runtime',
                groupBy: 'symbol',
                resultMode: 'grouped',
                limit: 5,
            }, host),
            /changed repeatedly/,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door reuses initial readiness after a no-mutation freshness decision when authority remains stable', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-reuse-'));
    let postReads = 0;
    const ready = {
        state: 'ready' as const,
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        preparedObservation: 'generation=7;epoch=3',
    };
    const host = {
        prepareInitialTrackedRootRead: async () => ready,
        preparePostFreshnessTrackedRootRead: async () => {
            postReads += 1;
            return ready;
        },
        getPreparedReadObservation: () => 'generation=7;epoch=3',
        ensureSearchFreshness: async (_root: string, preparedRead?: typeof ready) => {
            assert.equal(preparedRead, ready);
            return {
            mode: 'skipped_recent' as const,
            checkedAt: 'now',
            thresholdMs: 60_000,
            };
        },
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'ready');
        assert.equal(postReads, 0);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door reproves after a committed sync even when a test double leaves authority observation unchanged', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-sync-reprove-'));
    let postReads = 0;
    const ready = {
        state: 'ready' as const,
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        preparedObservation: 'generation=7;epoch=3',
    };
    const host = {
        prepareInitialTrackedRootRead: async () => ready,
        preparePostFreshnessTrackedRootRead: async () => {
            postReads += 1;
            return ready;
        },
        getPreparedReadObservation: () => 'generation=7;epoch=3',
        ensureSearchFreshness: async () => ({
            mode: 'synced' as const,
            checkedAt: 'now',
            thresholdMs: 60_000,
            stats: { added: 0, removed: 0, modified: 0 },
        }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'ready');
        assert.equal(postReads, 1);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door reproves readiness when the observation changes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-reprove-'));
    let observation = 'generation=7;epoch=3';
    let postReads = 0;
    const ready = {
        state: 'ready' as const,
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        preparedObservation: 'generation=7;epoch=3',
    };
    const host = {
        prepareInitialTrackedRootRead: async () => ready,
        preparePostFreshnessTrackedRootRead: async () => {
            postReads += 1;
            return ready;
        },
        getPreparedReadObservation: () => observation,
        ensureSearchFreshness: async () => {
            observation = 'generation=7;epoch=4';
            return { mode: 'skipped_recent' as const, checkedAt: 'now', thresholdMs: 60_000 };
        },
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(postReads, 1);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door returns bounded retry hint for create or reindex indexing without waiting', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-reindex-'));
    let waitCalls = 0;
    let prepareCalls = 0;
    const host = {
        prepareInitialTrackedRootRead: async () => {
            prepareCalls += 1;
            return {
                state: 'indexing' as const,
                codebasePath: tempRoot,
                operation: { action: 'reindex' as const, phase: 'writing', generation: 4 },
                searchableGenerationAvailable: true,
            };
        },
        waitForSearchableSync: async () => {
            waitCalls += 1;
            return true;
        },
        buildNotReadySearchPayload: (codebasePath: string) => ({
            formatVersion: 'test',
            status: 'not_ready',
            reason: 'indexing',
            codebasePath,
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
            results: [],
        }),
        canSyncStaleLocal: () => false,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal(result.payload.status, 'not_ready');
        assert.equal(result.payload.reason, 'indexing');
        assert.equal(result.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.deepEqual(result.payload.indexingOperation, { action: 'reindex', phase: 'writing', generation: 4 });
        assert.equal(waitCalls, 0);
        assert.equal(prepareCalls, 1);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door joins a transient sync once over a searchable generation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-sync-join-'));
    const waitCalls: Array<{ codebasePath: string; timeoutMs: number }> = [];
    let prepareCalls = 0;
    const indexingState = {
        state: 'indexing' as const,
        codebasePath: tempRoot,
        operation: { action: 'sync' as const, phase: 'writing', generation: 5 },
        searchableGenerationAvailable: true,
    };
    const readyState = {
        state: 'ready' as const,
        root: { path: tempRoot, info: { status: 'sync_completed' as const } },
    };
    const host = {
        prepareInitialTrackedRootRead: async () => {
            prepareCalls += 1;
            return prepareCalls === 1 ? indexingState : readyState;
        },
        preparePostFreshnessTrackedRootRead: async () => readyState,
        waitForSearchableSync: async (codebasePath: string, timeoutMs: number) => {
            waitCalls.push({ codebasePath, timeoutMs });
            return true;
        },
        ensureSearchFreshness: async () => ({
            mode: 'skipped_recent' as const,
            checkedAt: 'now',
            thresholdMs: 60_000,
        }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'ready');
        assert.equal(waitCalls.length, 1);
        assert.deepEqual(waitCalls[0], { codebasePath: tempRoot, timeoutMs: DEFAULT_MANAGE_RETRY_AFTER_MS });
        assert.equal(prepareCalls, 2);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door keeps the bounded retry hint when the transient sync does not resolve', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-sync-unresolved-'));
    let waitCalls = 0;
    let prepareCalls = 0;
    const indexingState = {
        state: 'indexing' as const,
        codebasePath: tempRoot,
        operation: { action: 'sync' as const, phase: 'writing', generation: 5 },
        searchableGenerationAvailable: true,
    };
    const host = {
        prepareInitialTrackedRootRead: async () => {
            prepareCalls += 1;
            return indexingState;
        },
        waitForSearchableSync: async () => {
            waitCalls += 1;
            return false;
        },
        buildNotReadySearchPayload: (codebasePath: string) => ({
            formatVersion: 'test',
            status: 'not_ready',
            reason: 'indexing',
            codebasePath,
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
            results: [],
        }),
        canSyncStaleLocal: () => false,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal(result.payload.status, 'not_ready');
        assert.equal(result.payload.reason, 'indexing');
        assert.equal(result.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.deepEqual(result.payload.indexingOperation, { action: 'sync', phase: 'writing', generation: 5 });
        assert.equal(waitCalls, 1);
        assert.equal(prepareCalls, 1);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door does not wait for a sync without a searchable generation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-sync-nosearchable-'));
    let waitCalls = 0;
    const indexingState = {
        state: 'indexing' as const,
        codebasePath: tempRoot,
        operation: { action: 'sync' as const, phase: 'writing', generation: 1 },
        searchableGenerationAvailable: false,
    };
    const host = {
        prepareInitialTrackedRootRead: async () => indexingState,
        waitForSearchableSync: async () => {
            waitCalls += 1;
            return true;
        },
        buildNotReadySearchPayload: (codebasePath: string) => ({
            formatVersion: 'test',
            status: 'not_ready',
            reason: 'indexing',
            codebasePath,
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
            results: [],
        }),
        canSyncStaleLocal: () => false,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal(result.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.equal(waitCalls, 0);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door enriches a freshness-blocked indexing payload with retry and operation metadata', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-freshness-indexing-'));
    const indexingPayload = {
        formatVersion: 'test',
        status: 'not_ready' as const,
        reason: 'indexing' as const,
        codebasePath: tempRoot,
        path: tempRoot,
        query: 'owner',
        scope: 'runtime',
        groupBy: 'symbol',
        resultMode: 'grouped',
        limit: 5,
        results: [],
    };
    const host = {
        prepareInitialTrackedRootRead: async () => ({
            state: 'ready' as const,
            root: { path: tempRoot, info: { status: 'indexed' as const } },
        }),
        preparePostFreshnessTrackedRootRead: async () => ({
            state: 'ready' as const,
            root: { path: tempRoot, info: { status: 'indexed' as const } },
        }),
        ensureSearchFreshness: async () => ({
            mode: 'skipped_indexing' as const,
            changed: false,
            checkedAt: 'x',
            thresholdMs: 60_000,
        }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => indexingPayload,
        getIndexingOperation: () => ({ action: 'reindex' as const, phase: 'writing', generation: 4 }),
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal(result.payload.status, 'not_ready');
        assert.equal(result.payload.reason, 'indexing');
        assert.equal(result.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.deepEqual(result.payload.indexingOperation, { action: 'reindex', phase: 'writing', generation: 4 });
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door still reports the retry hint when a freshness indexing block has no operation receipt', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-freshness-indexing-noop-'));
    const indexingPayload = {
        formatVersion: 'test',
        status: 'not_ready' as const,
        reason: 'indexing' as const,
        codebasePath: tempRoot,
        path: tempRoot,
        query: 'owner',
        scope: 'runtime',
        groupBy: 'symbol',
        resultMode: 'grouped',
        limit: 5,
        results: [],
    };
    const host = {
        prepareInitialTrackedRootRead: async () => ({
            state: 'ready' as const,
            root: { path: tempRoot, info: { status: 'indexed' as const } },
        }),
        preparePostFreshnessTrackedRootRead: async () => ({
            state: 'ready' as const,
            root: { path: tempRoot, info: { status: 'indexed' as const } },
        }),
        ensureSearchFreshness: async () => ({
            mode: 'skipped_indexing' as const,
            changed: false,
            checkedAt: 'x',
            thresholdMs: 60_000,
        }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => indexingPayload,
        getIndexingOperation: () => undefined,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'blocked');
        if (result.kind !== 'blocked') return;
        assert.equal(result.payload.status, 'not_ready');
        assert.equal(result.payload.reason, 'indexing');
        assert.equal(result.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.equal(result.payload.indexingOperation, undefined);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('search front door reproves readiness when a mutation completed after cached receipt validation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-frontdoor-rebased-'));
    let postReads = 0;
    const staleReady = {
        state: 'ready' as const,
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        preparedObservation: 'generation=7;epoch=3',
    };
    const currentReady = {
        ...staleReady,
        preparedObservation: 'generation=8;epoch=4',
    };
    const host = {
        prepareInitialTrackedRootRead: async () => staleReady,
        preparePostFreshnessTrackedRootRead: async () => {
            postReads += 1;
            return currentReady;
        },
        getPreparedReadObservation: () => 'generation=8;epoch=4',
        ensureSearchFreshness: async () => ({
            mode: 'skipped_recent' as const,
            checkedAt: 'now',
            thresholdMs: 60_000,
        }),
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        trackedRootReadiness: {},
    } as unknown as SearchFrontDoorHost;
    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'owner',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);
        assert.equal(result.kind, 'ready');
        assert.equal(postReads, 1);
        if (result.kind === 'ready') {
            assert.equal(result.preparedObservation, 'generation=8;epoch=4');
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runSearchFrontDoor serves previous published generation when sync is actively indexing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-stale-sync-'));
    const preparedRead = {
        state: 'ready' as const,
        codebasePath: tempRoot,
        collectionName: 'col_gen_15',
        manifestHash: 'man-15',
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        proofDebugHint: undefined,
        vectorReceipt: { collectionName: 'col_gen_15', marker: { runId: 'run-15' } },
        generationReceipt: { marker: { runId: 'run-15' } },
        navigationStatus: 'valid' as const,
        preparedObservation: 'obs-15',
        navigationAuthorityMode: 'canonical_v4' as const,
    };

    const host = {
        prepareInitialTrackedRootRead: async () => ({
            state: 'indexing' as const,
            codebasePath: tempRoot,
            operation: { action: 'sync' as const, generation: 16, phase: 'writing', id: 'op-16' },
            searchableGenerationAvailable: true,
            searchableRead: preparedRead,
        }),
        getPreparedReadObservation: () => 'obs-15',
        ensureSearchFreshness: async () => {
            throw new Error('ensureSearchFreshness should not be called when serving previous generation during sync');
        },
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        buildBlockedReadinessPayload: () => null,
        trackedRootReadiness: {
            buildMissingLocalCollectionSearchPayload: () => ({}),
            buildIndexFailedSearchPayload: () => ({}),
        },
    } as unknown as SearchFrontDoorHost;

    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'test query',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);

        assert.equal(result.kind, 'ready');
        if (result.kind === 'ready') {
            assert.equal(result.freshnessDecision.mode, 'served_previous_generation');
            assert.equal(result.freshnessDecision.servedCollection, 'col_gen_15');
            assert.equal(result.freshnessDecision.servedRunId, 'run-15');
            assert.deepEqual(result.freshnessDecision.pendingOperation, { action: 'sync', generation: 16 });
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runSearchFrontDoor does not enter served_previous_generation if searchableRead lacks vectorReceipt', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-stale-no-vector-'));
    const preparedReadWithoutVector = {
        state: 'ready' as const,
        codebasePath: tempRoot,
        collectionName: 'col_gen_15',
        manifestHash: 'man-15',
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        proofDebugHint: undefined,
        vectorReceipt: undefined,
        generationReceipt: { marker: { runId: 'run-15' } },
        navigationStatus: 'valid' as const,
        preparedObservation: 'obs-15',
        navigationAuthorityMode: 'canonical_v4' as const,
    };

    const host = {
        prepareInitialTrackedRootRead: async () => ({
            state: 'indexing' as const,
            codebasePath: tempRoot,
            operation: { action: 'sync' as const, generation: 16, phase: 'writing', id: 'op-16' },
            searchableGenerationAvailable: true,
            searchableRead: preparedReadWithoutVector,
        }),
        getPreparedReadObservation: () => 'obs-15',
        ensureSearchFreshness: async () => {
            throw new Error('ensureSearchFreshness unexpected call');
        },
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        buildBlockedReadinessPayload: () => ({
            status: 'not_ready',
            code: 'INDEXING_IN_PROGRESS',
            message: 'Indexing in progress',
        }),
        buildNotReadySearchPayload: (codebasePath: string) => ({
            formatVersion: 'test',
            status: 'not_ready',
            reason: 'indexing',
            codebasePath,
            path: tempRoot,
            query: 'test query',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
            results: [],
        }),
        trackedRootReadiness: {
            buildMissingLocalCollectionSearchPayload: () => ({}),
            buildIndexFailedSearchPayload: () => ({}),
        },
    } as unknown as SearchFrontDoorHost;

    try {
        const result = await runSearchFrontDoor({
            path: tempRoot,
            query: 'test query',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        }, host);

        assert.equal(result.kind, 'blocked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

