import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSearchFrontDoor } from './search-frontdoor.js';
import type { SearchFrontDoorHost } from './search-frontdoor.js';

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

test('search front door preserves vector search with a source-checkpoint warning', async () => {
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
        if (result.kind !== 'ready') return;
        assert.equal(
            result.partialIndexSearchWarnings.includes('SOURCE_FRESHNESS_CHECKPOINT_UNAVAILABLE'),
            true,
        );
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

test('search front door reuses initial readiness when the proof observation remains stable', async () => {
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
        assert.equal(postReads, 0);
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
