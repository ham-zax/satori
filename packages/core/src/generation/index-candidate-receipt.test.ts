import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PublicationStore } from './publication-store';
import {
    RootMutationRuntime,
    getCurrentRootMutationLease,
    getRootMutationCoordinator,
} from './root-mutation-runtime';

test('candidate receipt survives the old mutation and is reclaimable by a newer root lease', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-candidate-receipt-'));
    const repoRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(repoRoot);
    const runtime = new RootMutationRuntime({
        stateDir: path.join(tempRoot, 'mutations'),
        ownerId: 'candidate-test-owner',
    });
    const store = new PublicationStore({
        stateRoot: path.join(tempRoot, 'state'),
        mutationCoordinator: getRootMutationCoordinator(runtime),
    });
    const collectionName = 'code_chunks_deadbeef__gen_candidate';

    try {
        await runtime.run(repoRoot, 'create', async () => {
            const lease = getCurrentRootMutationLease(runtime, repoRoot);
            const reserved = store.reserveIndexCandidate(repoRoot, collectionName, lease);
            assert.equal(reserved.phase, 'reserved');
            assert.equal(reserved.generation, lease.generation);

            const created = store.markIndexCandidateCollectionCreated(
                repoRoot,
                lease.operationId,
                lease,
            );
            assert.equal(created.phase, 'collection_created');
        });

        const persisted = store.listIndexCandidateReceipts();
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0]?.collectionName, collectionName);
        assert.equal(persisted[0]?.phase, 'collection_created');

        await runtime.run(repoRoot, 'reindex', async () => {
            const lease = getCurrentRootMutationLease(runtime, repoRoot);
            assert.ok(lease.generation > (persisted[0]?.generation ?? 0));
            assert.equal(
                store.clearIndexCandidateForCollection(repoRoot, collectionName, lease),
                true,
            );
        });

        assert.deepEqual(store.listIndexCandidateReceipts(), []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
