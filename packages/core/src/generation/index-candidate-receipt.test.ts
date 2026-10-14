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

async function assertCandidateReceiptSurvives(action: 'create' | 'sync'): Promise<void> {
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
        await runtime.run(repoRoot, action, async () => {
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
}

for (const action of ['create', 'sync'] as const) {
    test(`${action} candidate receipt survives the old mutation and is reclaimable by a newer root lease`, async () => {
        await assertCandidateReceiptSurvives(action);
    });
}

for (const failurePoint of ['write', 'fsync'] as const) {
    test(`candidate receipt ${failurePoint} failure leaves no receipt and startup remains usable`, async (t) => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-candidate-write-'));
        t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
        const repoRoot = path.join(tempRoot, 'repo');
        fs.mkdirSync(repoRoot);
        const runtime = new RootMutationRuntime({ stateDir: path.join(tempRoot, 'mutations') });
        const options = {
            stateRoot: path.join(tempRoot, 'state'),
            mutationCoordinator: getRootMutationCoordinator(runtime),
        };
        const store = new PublicationStore(options);
        await runtime.run(repoRoot, 'create', async () => {
            const lease = getCurrentRootMutationLease(runtime, repoRoot);
            const failure = Object.assign(new Error(`injected candidate ${failurePoint} ENOSPC`), { code: 'ENOSPC' });
            const originalOpen = fs.openSync;
            const originalWrite = fs.writeFileSync;
            const originalFsync = fs.fsyncSync;
            let candidateDescriptor: number | undefined;
            let receiptDirectory: string | undefined;
            t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
                const descriptor = originalOpen(...args);
                if (typeof args[0] === 'string' && path.basename(args[0]).startsWith(lease.operationId)) {
                    candidateDescriptor = descriptor;
                    const directory = path.dirname(args[0]);
                    receiptDirectory = path.basename(directory) === 'candidates'
                        ? directory
                        : path.join(directory, 'candidates');
                }
                return descriptor;
            });
            t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
                if (args[0] === candidateDescriptor && failurePoint === 'write') {
                    originalWrite(candidateDescriptor!, '{"version":', 'utf8');
                    throw failure;
                }
                return originalWrite(...args);
            });
            t.mock.method(fs, 'fsyncSync', (descriptor: number) => {
                if (descriptor === candidateDescriptor && failurePoint === 'fsync') throw failure;
                return originalFsync(descriptor);
            });
            assert.throws(() => store.reserveIndexCandidate(repoRoot, 'candidate', lease), (error) => error === failure);
            t.mock.restoreAll();
            assert.ok(receiptDirectory);
            assert.deepEqual(fs.readdirSync(receiptDirectory), [], 'no incomplete receipt is published');
            const restarted = new PublicationStore(options);
            // Construction is cached per state root in this process; explicitly
            // exercise the cold-start path that a fresh process would run.
            (restarted as unknown as { pruneStartupOrphans(): void }).pruneStartupOrphans();
            assert.deepEqual(restarted.listIndexCandidateReceipts(), []);
            assert.equal(store.reserveIndexCandidate(repoRoot, 'candidate', lease).phase, 'reserved');
        });
    });
}

test('candidate receipt publication is exclusive against a competing creator', async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-candidate-exclusive-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const repoRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(repoRoot);
    const runtime = new RootMutationRuntime({ stateDir: path.join(tempRoot, 'mutations') });
    const store = new PublicationStore({
        stateRoot: path.join(tempRoot, 'state'),
        mutationCoordinator: getRootMutationCoordinator(runtime),
    });
    await runtime.run(repoRoot, 'create', async () => {
        const lease = getCurrentRootMutationLease(runtime, repoRoot);
        const originalLink = fs.linkSync;
        const competingContents = '{"competing":"receipt"}';
        let target: string | undefined;
        t.mock.method(fs, 'linkSync', (source: fs.PathLike, destination: fs.PathLike) => {
            target = String(destination);
            fs.writeFileSync(destination, competingContents, { flag: 'wx' });
            return originalLink(source, destination);
        });
        assert.throws(() => store.reserveIndexCandidate(repoRoot, 'candidate', lease), { code: 'EEXIST' });
        t.mock.restoreAll();
        assert.ok(target);
        assert.equal(fs.readFileSync(target, 'utf8'), competingContents);
    });
});
