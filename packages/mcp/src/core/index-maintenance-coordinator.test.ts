import assert from 'node:assert/strict';
import test from 'node:test';
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

test('a failed workspace attempt does not loop or block another workspace', async () => {
    const started: string[] = [];
    const coordinator = new IndexMaintenanceCoordinator({
        ...options,
        startCreate: async (root) => {
            started.push(root);
            if (root === '/a') throw new Error('fixture failure');
            return { accepted: true, operationId: root, completion: Promise.resolve() };
        },
    });
    await assert.rejects(coordinator.requestWorkspaceIndexing('/a'), /fixture failure/);
    await coordinator.requestWorkspaceIndexing('/b');
    await assert.rejects(coordinator.requestWorkspaceIndexing('/a'), /fixture failure/);
    assert.deepEqual(started, ['/a', '/b']);
});

test('disabled automatic maintenance never creates a workspace index', async () => {
    const coordinator = new IndexMaintenanceCoordinator({
        ...options, enabled: false,
        startCreate: async () => { throw new Error('must not create'); },
    });
    await coordinator.requestWorkspaceIndexing('/a');
});
