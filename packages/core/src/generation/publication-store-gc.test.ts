import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildPublicationPackageOwnership } from '../packages/ownership';
import { buildPublicationSourceCheckpoint } from '../sync/snapshot-codec';
import { PublicationStore } from './publication-store';
import { RootMutationRuntime, getCurrentRootMutationLease, getRootMutationCoordinator } from './root-mutation-runtime';
import type { Publication } from './contracts';

function publication(repoRoot: string, id: string): Publication {
    return {
        version: 2,
        id,
        canonicalRoot: repoRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'partial',
        policy: {
            profile: 'default', customExtensions: [], customIgnorePatterns: [],
            fileBasedIgnorePatterns: [], supportedExtensions: ['.ts'], effectiveIgnorePatterns: [],
            policyHash: 'test-policy', controlSignature: 'test-control',
        },
        format: { indexFormatVersion: 'test', embeddingIdentity: 'test', relationshipVersion: 'test' },
        vector: { collectionName: `${id}-collection`, indexedFiles: 0, totalChunks: 0 },
        packageOwnership: true,
        navigation: null,
    };
}

async function gcFixture(t: TestContext) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publication-gc-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'repo-')));
    const runtime = new RootMutationRuntime({ stateDir: path.join(tempRoot, 'mutations') });
    const store = new PublicationStore({
        stateRoot: path.join(tempRoot, 'state'),
        mutationCoordinator: getRootMutationCoordinator(runtime),
        singleRuntimeReaderCoordination: true,
    });
    for (const id of ['old', 'new']) {
        await runtime.run(repoRoot, 'create', async () => {
            const lease = getCurrentRootMutationLease(runtime, repoRoot);
            store.stageSourceCheckpoint(repoRoot, id, buildPublicationSourceCheckpoint(repoRoot, {
                fileHashes: new Map(), fileStats: new Map(), unprocessedPaths: [],
            }), lease);
            store.stagePackageOwnership(repoRoot, id, buildPublicationPackageOwnership(repoRoot, [], new Map()), lease);
            store.activate(publication(repoRoot, id), lease);
        });
    }
    const collectGarbage = (deleteVectorCollection: (name: string) => Promise<void>) => runtime.run(
        repoRoot,
        'gc',
        async () => store.collectGarbage(repoRoot, getCurrentRootMutationLease(runtime, repoRoot), deleteVectorCollection),
    );
    return { repoRoot, store, collectGarbage };
}

test('GC removes a retired generation and then its vector collection', async (t) => {
    const { repoRoot, store, collectGarbage } = await gcFixture(t);
    const deleted: string[] = [];
    const removed = await collectGarbage(async (name) => {
        assert.equal(store.getById(repoRoot, 'old'), null, 'descriptor is removed before its collection');
        deleted.push(name);
    });
    assert.deepEqual(removed, ['old-collection']);
    assert.deepEqual(deleted, ['old-collection']);
    assert.equal(store.getCurrent(repoRoot)?.id, 'new');
});

test('GC keeps the vector collection when generation removal fails', async (t) => {
    const { repoRoot, store, collectGarbage } = await gcFixture(t);
    t.mock.method(store as unknown as { removeGeneration(): void }, 'removeGeneration', () => {
        throw new Error('injected generation removal failure');
    });
    const deleted: string[] = [];
    await assert.rejects(collectGarbage(async (name) => { deleted.push(name); }), /injected generation removal failure/);
    assert.deepEqual(deleted, []);
    assert.equal(store.getById(repoRoot, 'old')?.id, 'old');
});
