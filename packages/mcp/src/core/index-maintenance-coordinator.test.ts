import assert from 'node:assert/strict';
import test from 'node:test';
import type { RootMutationOperation } from '@zokizuan/satori-core/integration';
import { IndexMaintenanceCoordinator } from './index-maintenance-coordinator.js';

const options = {
    enabled: true,
    runtimeEpoch: 'fixture',
    getActiveMutation: () => undefined,
    getOperation: () => undefined,
    startReindex: async () => ({ accepted: false, operationId: '', completion: null }),
};

test('workspace auto-indexing coalesces roots and serializes completion across roots', async () => {
    const started: string[] = [];
    let release!: () => void;
    const firstCompletion = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        startCreate: async (root) => {
            started.push(root);
            return { accepted: true, operationId: root, completion: root === '/a' ? firstCompletion : Promise.resolve() };
        },
    });
    const first = coordinator.requestWorkspaceIndexing('/a');
    assert.equal(coordinator.requestWorkspaceIndexing('/a'), first);
    const second = coordinator.requestWorkspaceIndexing('/b');
    await Promise.resolve();
    assert.deepEqual(started, ['/a']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(started, ['/a', '/b']);
    await coordinator.requestWorkspaceIndexing('/a');
    assert.deepEqual(started, ['/a', '/b']);
});

test('transient workspace failure retries only after bounded backoff and does not block another workspace', async () => {
    const started: string[] = [];
    let now = 0;
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        now: () => now,
        retryBackoffMs: 100,
        maxRetryBackoffMs: 1000,
        startCreate: async (root) => {
            started.push(root);
            if (root === '/a') throw new Error('ECONNRESET fixture failure');
            return { accepted: true, operationId: root, completion: Promise.resolve() };
        },
    });

    await assert.rejects(coordinator.requestWorkspaceIndexing('/a'), /ECONNRESET/);
    await coordinator.requestWorkspaceIndexing('/b');
    await coordinator.requestWorkspaceIndexing('/a');
    assert.deepEqual(started, ['/a', '/b']);

    now = 100;
    await assert.rejects(coordinator.requestWorkspaceIndexing('/a'), /ECONNRESET/);
    assert.deepEqual(started, ['/a', '/b', '/a']);

    now = 200;
    await coordinator.requestWorkspaceIndexing('/a');
    assert.deepEqual(started, ['/a', '/b', '/a']);

    now = 300;
    await assert.rejects(coordinator.requestWorkspaceIndexing('/a'), /ECONNRESET/);
    assert.deepEqual(started, ['/a', '/b', '/a', '/a']);
});

test('deterministic workspace failure stays suppressed for the runtime epoch', async () => {
    const started: string[] = [];
    let now = 0;
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        now: () => now,
        retryBackoffMs: 10,
        startCreate: async (root) => {
            started.push(root);
            throw new Error('missing embedding configuration');
        },
    });

    await assert.rejects(coordinator.requestWorkspaceIndexing('/a'), /configuration/);
    now = 10_000;
    await coordinator.requestWorkspaceIndexing('/a');
    assert.deepEqual(started, ['/a']);
});

test('automatic reindex retries transient failures after exponential backoff', async () => {
    let now = 0;
    let launchCount = 0;
    let currentOperation: RootMutationOperation | undefined;
    let releaseCompletion: (() => void) | undefined;
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        now: () => now,
        retryBackoffMs: 100,
        maxRetryBackoffMs: 1000,
        getOperation: () => currentOperation,
        startReindex: async () => {
            launchCount += 1;
            const operationId = `auto-${launchCount}`;
            currentOperation = {
                id: operationId,
                action: 'reindex',
                canonicalRoot: '/repo',
                generation: launchCount,
                acceptedAt: new Date(0).toISOString(),
                phase: 'failed',
                updatedAt: new Date(0).toISOString(),
                error: 'ECONNRESET from vector backend',
            };
            const completion = new Promise<void>((resolve) => {
                releaseCompletion = resolve;
            });
            return { accepted: true, operationId, completion };
        },
    });

    assert.deepEqual(
        await coordinator.requestAutomaticReindex('/repo', 'requires_reindex'),
        { outcome: 'started' },
    );
    releaseCompletion?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(
        await coordinator.requestAutomaticReindex('/repo', 'requires_reindex'),
        { outcome: 'suppressed' },
    );

    now = 100;
    assert.deepEqual(
        await coordinator.requestAutomaticReindex('/repo', 'requires_reindex'),
        { outcome: 'started' },
    );
    releaseCompletion?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    now = 200;
    assert.deepEqual(
        await coordinator.requestAutomaticReindex('/repo', 'requires_reindex'),
        { outcome: 'suppressed' },
    );

    now = 300;
    assert.deepEqual(
        await coordinator.requestAutomaticReindex('/repo', 'requires_reindex'),
        { outcome: 'started' },
    );
    assert.equal(launchCount, 3);
    releaseCompletion?.();
});

test('resource-blocked automatic reindex stays suppressed until a later manual success', async () => {
    let now = 0;
    let launchCount = 0;
    let currentOperation: RootMutationOperation | undefined;
    let releaseCompletion: (() => void) | undefined;
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        now: () => now,
        retryBackoffMs: 10,
        getOperation: () => currentOperation,
        startReindex: async () => {
            launchCount += 1;
            const operationId = `resource-${launchCount}`;
            currentOperation = {
                id: operationId,
                action: 'reindex',
                canonicalRoot: '/repo',
                generation: launchCount,
                acceptedAt: new Date(0).toISOString(),
                phase: 'failed',
                updatedAt: new Date(0).toISOString(),
                error: 'replacement candidate reached an indexing resource limit',
            };
            const completion = new Promise<void>((resolve) => {
                releaseCompletion = resolve;
            });
            return { accepted: true, operationId, completion };
        },
    });

    assert.equal(
        (await coordinator.requestAutomaticReindex('/repo', 'requires_reindex')).outcome,
        'started',
    );
    releaseCompletion?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    now = 100_000;
    assert.equal(
        (await coordinator.requestAutomaticReindex('/repo', 'requires_reindex')).outcome,
        'suppressed',
    );
    assert.equal(launchCount, 1);

    currentOperation = {
        id: 'manual-success',
        action: 'reindex',
        canonicalRoot: '/repo',
        generation: 99,
        acceptedAt: new Date(0).toISOString(),
        phase: 'completed',
        updatedAt: new Date(0).toISOString(),
    };
    assert.equal(
        (await coordinator.requestAutomaticReindex('/repo', 'requires_reindex')).outcome,
        'started',
    );
    assert.equal(launchCount, 2);
    releaseCompletion?.();
});

test('a worker abort is resource-blocked and does not trigger another automatic reindex', async () => {
    let now = 0;
    let launchCount = 0;
    let currentOperation: RootMutationOperation | undefined;
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        now: () => now,
        retryBackoffMs: 10,
        getOperation: () => currentOperation,
        startReindex: async () => {
            launchCount += 1;
            const operationId = `abort-${launchCount}`;
            currentOperation = {
                id: operationId,
                action: 'reindex',
                canonicalRoot: '/repo',
                generation: launchCount,
                acceptedAt: new Date(0).toISOString(),
                phase: 'failed',
                updatedAt: new Date(0).toISOString(),
                error: 'Mutation worker exited without a terminal operation message (signal SIGABRT).',
            };
            return { accepted: true, operationId, completion: Promise.resolve() };
        },
    });

    assert.equal((await coordinator.requestAutomaticReindex('/repo', 'requires_reindex')).outcome, 'started');
    await new Promise<void>((resolve) => setImmediate(resolve));
    now = 100_000;
    assert.equal((await coordinator.requestAutomaticReindex('/repo', 'requires_reindex')).outcome, 'suppressed');
    assert.equal(launchCount, 1);
});

test('cancelled automatic reindex never retries automatically', async () => {
    let now = 0;
    let launchCount = 0;
    let currentOperation: RootMutationOperation | undefined;
    let releaseCompletion: (() => void) | undefined;
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        now: () => now,
        retryBackoffMs: 10,
        getOperation: () => currentOperation,
        startReindex: async () => {
            launchCount += 1;
            const operationId = `cancelled-${launchCount}`;
            currentOperation = {
                id: operationId,
                action: 'reindex',
                canonicalRoot: '/repo',
                generation: launchCount,
                acceptedAt: new Date(0).toISOString(),
                phase: 'cancelled',
                updatedAt: new Date(0).toISOString(),
                cancelReason: 'requested_by_manage_index',
            };
            const completion = new Promise<void>((resolve) => {
                releaseCompletion = resolve;
            });
            return { accepted: true, operationId, completion };
        },
    });

    assert.equal(
        (await coordinator.requestAutomaticReindex('/repo', 'requires_reindex')).outcome,
        'started',
    );
    releaseCompletion?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    now = 100_000;
    assert.equal(
        (await coordinator.requestAutomaticReindex('/repo', 'requires_reindex')).outcome,
        'suppressed',
    );
    assert.equal(launchCount, 1);
});

test('disabled automatic maintenance never creates a workspace index', async () => {
    const coordinator = new IndexMaintenanceCoordinator({
        ...options, enabled: false,
        startCreate: async () => { throw new Error('must not create'); },
    });
    await coordinator.requestWorkspaceIndexing('/a');
});
