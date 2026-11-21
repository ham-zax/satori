import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRootMutationLeasePort, createSharedPublicationRuntime, createStorageMaintenanceReaderGuard, RootMutationRuntime } from '../integration';
import { getSharedPublicationStore } from './publication-store';
import { getCurrentRootMutationLease } from './root-mutation-runtime';
import { buildPublicationPackageOwnership } from '../packages/ownership';
import { buildPublicationSourceCheckpoint } from '../sync/snapshot-codec';
import {
    inspectSatoriStorage,
    runPublicationStorageMaintenance,
} from './storage-maintenance';

function rootKey(canonicalRoot: string): string {
    return crypto.createHash('sha256').update(canonicalRoot).digest('hex');
}

function leasePortForStateRoot(stateRoot: string) {
    return createRootMutationLeasePort({
        stateDir: path.join(stateRoot, 'runtime', 'mutation-leases'),
    });
}

function writePublicationFixture(options: {
    stateRoot: string;
    canonicalRoot: string;
    currentId: string;
    retiredIds?: string[];
    incompatibleRetiredIds?: string[];
    lastUsedAtIso?: string;
    payloadBytes?: number;
    vectorDbPath?: string;
}) {
    const key = rootKey(options.canonicalRoot);
    const pubRoot = path.join(options.stateRoot, 'publications', key);
    const vectorRoot = options.vectorDbPath ?? path.join(options.stateRoot, 'vector', 'lancedb');
    const tsRoot = path.join(options.stateRoot, 'typescript-resolution');
    fs.mkdirSync(pubRoot, { recursive: true });
    fs.mkdirSync(vectorRoot, { recursive: true });
    fs.mkdirSync(tsRoot, { recursive: true });

    const writeGen = (id: string, version: number) => {
        const genDir = path.join(pubRoot, 'generations', id);
        fs.mkdirSync(genDir, { recursive: true });
        const collectionName = `hybrid_code_chunks_${key.slice(0, 8)}__gen_${id}`;
        fs.writeFileSync(
            path.join(genDir, 'publication.json'),
            JSON.stringify({
                version,
                id,
                canonicalRoot: options.canonicalRoot,
                createdAt: options.lastUsedAtIso ?? '2026-01-01T00:00:00.000Z',
                vector: { collectionName },
            }, null, 2),
        );
        if (options.payloadBytes && options.payloadBytes > 0) {
            fs.writeFileSync(path.join(genDir, 'payload.bin'), Buffer.alloc(options.payloadBytes, 0x61));
        }
        const lanceDir = path.join(vectorRoot, `${collectionName}.lance`);
        fs.mkdirSync(lanceDir, { recursive: true });
        fs.writeFileSync(path.join(lanceDir, 'data.lance'), Buffer.alloc(4096, 0x62));
        return collectionName;
    };

    const currentCollection = writeGen(options.currentId, 2);
    const retiredCollections = (options.retiredIds ?? []).map((id) => writeGen(id, 2));
    const incompatCollections = (options.incompatibleRetiredIds ?? []).map((id) => writeGen(id, 1));

    fs.writeFileSync(
        path.join(pubRoot, 'current.json'),
        JSON.stringify({ version: 1, publicationId: options.currentId }, null, 2),
    );
    if (options.lastUsedAtIso) {
        fs.writeFileSync(
            path.join(pubRoot, 'last-used.json'),
            JSON.stringify({ version: 1, canonicalRoot: options.canonicalRoot, lastUsedAt: options.lastUsedAtIso }),
        );
    }
    fs.writeFileSync(path.join(tsRoot, `${key}.json`), '{"cached":true}');
    return { key, pubRoot, currentCollection, retiredCollections, incompatCollections };
}

test('storage maintenance sweeps orphaned roots, retired generations, unreferenced collections, and ts caches', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-maint-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, 'state');
    const liveRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'live-repo-')));
    const deletedRepo = path.join(tmp, 'deleted-repo');

    const live = writePublicationFixture({
        stateRoot,
        canonicalRoot: liveRepo,
        currentId: 'gen-2',
        retiredIds: ['gen-1'],
        incompatibleRetiredIds: ['gen-0'],
        lastUsedAtIso: '2026-11-19T00:00:00.000Z',
    });
    const orphan = writePublicationFixture({
        stateRoot,
        canonicalRoot: deletedRepo,
        currentId: 'gen-a',
        lastUsedAtIso: '2026-11-19T00:00:00.000Z',
    });

    const strayLance = path.join(stateRoot, 'vector', 'lancedb', 'hybrid_code_chunks_deadbeef__gen_stray.lance');
    fs.mkdirSync(strayLance, { recursive: true });
    fs.writeFileSync(path.join(strayLance, 'data.lance'), Buffer.alloc(8192, 0x63));

    const leasePort = leasePortForStateRoot(stateRoot);
    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');
    const dry = runPublicationStorageMaintenance({ stateRoot, soleOwner: true, dryRun: true, nowMs, ...leasePort });
    assert.equal(dry.removedRoots.length, 1);
    assert.equal(dry.removedRoots[0]?.reason, 'orphaned_root');
    assert.equal(dry.removedRetiredGenerations.length, 2);
    assert.ok(dry.removedOrphanCollections.some((c) => c.collectionName === 'hybrid_code_chunks_deadbeef__gen_stray'));
    assert.equal(dry.before.vectorCollectionCount, 5);
    assert.equal(dry.after.vectorCollectionCount, 1);
    assert.equal(fs.existsSync(orphan.pubRoot), true, 'dry-run never deletes');

    const applied = runPublicationStorageMaintenance({ stateRoot, soleOwner: true, dryRun: false, nowMs, ...leasePort });
    assert.equal(applied.removedRoots.length, 1);
    assert.equal(applied.removedRetiredGenerations.length, 2);
    assert.equal(applied.reclaimedBytes, dry.reclaimedBytes);
    assert.equal(applied.after.publicationsBytes, dry.after.publicationsBytes);
    assert.equal(applied.after.vectorBytes, dry.after.vectorBytes);
    assert.equal(applied.after.typescriptResolutionBytes, dry.after.typescriptResolutionBytes);
    assert.equal(applied.after.publicationRootCount, dry.after.publicationRootCount);
    assert.equal(applied.after.vectorCollectionCount, dry.after.vectorCollectionCount);
    assert.equal(fs.existsSync(orphan.pubRoot), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'vector', 'lancedb', `${orphan.currentCollection}.lance`)), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'typescript-resolution', `${orphan.key}.json`)), false);
    assert.equal(fs.existsSync(strayLance), false);
    // Live repo current generation and its collection remain intact, while retired generations & their collections are gone.
    assert.equal(fs.existsSync(path.join(live.pubRoot, 'generations', 'gen-2', 'publication.json')), true);
    assert.equal(fs.existsSync(path.join(live.pubRoot, 'generations', 'gen-1')), false);
    assert.equal(fs.existsSync(path.join(live.pubRoot, 'generations', 'gen-0')), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'vector', 'lancedb', `${live.currentCollection}.lance`)), true);
    assert.equal(fs.existsSync(path.join(stateRoot, 'vector', 'lancedb', `${live.retiredCollections[0]}.lance`)), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'vector', 'lancedb', `${live.incompatCollections[0]}.lance`)), false);
});

test('storage maintenance evicts idle Git worktrees and enforces LRU budget while respecting active leases and protected roots', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-policy-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, 'state');

    const oldWorktree = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'wt-old-')));
    fs.writeFileSync(path.join(oldWorktree, '.git'), 'gitdir: /tmp/main/.git/worktrees/wt-old\n');
    const freshWorktree = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'wt-fresh-')));
    fs.writeFileSync(path.join(freshWorktree, '.git'), 'gitdir: /tmp/main/.git/worktrees/wt-fresh\n');
    const oldRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-old-')));
    const protectedRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-protected-')));
    const leasedRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-leased-')));

    const wtOld = writePublicationFixture({
        stateRoot,
        canonicalRoot: oldWorktree,
        currentId: 'g1',
        lastUsedAtIso: '2026-11-10T00:00:00.000Z',
        payloadBytes: 16_384,
    });
    const wtFresh = writePublicationFixture({
        stateRoot,
        canonicalRoot: freshWorktree,
        currentId: 'g1',
        lastUsedAtIso: '2026-11-19T12:00:00.000Z',
        payloadBytes: 16_384,
    });
    const repoOld = writePublicationFixture({
        stateRoot,
        canonicalRoot: oldRepo,
        currentId: 'g1',
        lastUsedAtIso: '2026-11-12T00:00:00.000Z',
        payloadBytes: 32_768,
    });
    const repoProt = writePublicationFixture({
        stateRoot,
        canonicalRoot: protectedRepo,
        currentId: 'g1',
        lastUsedAtIso: '2026-11-01T00:00:00.000Z',
        payloadBytes: 32_768,
    });
    const repoLeased = writePublicationFixture({
        stateRoot,
        canonicalRoot: leasedRepo,
        currentId: 'g1',
        lastUsedAtIso: '2026-11-01T00:00:00.000Z',
        payloadBytes: 32_768,
    });

    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');
    const result = runPublicationStorageMaintenance({
        stateRoot,
        soleOwner: true,
        worktreeIdleDays: 3,
        maxStorageBytes: 80_000,
        protectedRoots: [protectedRepo],
        ...leasePortForStateRoot(stateRoot),
        isRootMutationActive: (root) => root === leasedRepo,
        nowMs,
    });

    const reasons = new Map(result.removedRoots.map((r) => [r.canonicalRoot, r.reason]));
    assert.equal(reasons.get(oldWorktree), 'idle_worktree');
    assert.equal(reasons.get(freshWorktree), 'storage_budget', 'worktrees evict before regular repos under budget');
    assert.equal(reasons.get(oldRepo), 'storage_budget');
    assert.equal(fs.existsSync(wtOld.pubRoot), false);
    assert.equal(fs.existsSync(wtFresh.pubRoot), false);
    assert.equal(fs.existsSync(repoOld.pubRoot), false);
    assert.equal(fs.existsSync(repoProt.pubRoot), true, 'protected root survives');
    assert.equal(fs.existsSync(repoLeased.pubRoot), true, 'active-mutation root survives');
    assert.equal(inspectSatoriStorage(stateRoot).publicationRootCount, 2);
});

test('non-sole-owner mode retains publication roots and retired generations', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-non-sole-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, 'state');
    const liveRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'live-')));
    const deletedRepo = path.join(tmp, 'gone');

    const live = writePublicationFixture({
        stateRoot,
        canonicalRoot: liveRepo,
        currentId: 'gen-2',
        retiredIds: ['gen-1'],
        lastUsedAtIso: '2026-01-01T00:00:00.000Z',
    });
    const orphan = writePublicationFixture({
        stateRoot,
        canonicalRoot: deletedRepo,
        currentId: 'gen-a',
        lastUsedAtIso: '2026-01-01T00:00:00.000Z',
    });

    // Without reader-admission guard, non-sole-owner Phase B apply fails closed.
    const blocked = runPublicationStorageMaintenance({
        stateRoot,
        soleOwner: false,
        idleDays: 1,
        ...leasePortForStateRoot(stateRoot),
        nowMs: Date.parse('2026-11-20T00:00:00.000Z'),
    });
    assert.equal(blocked.removedRoots.length, 0);
    assert.equal(fs.existsSync(orphan.pubRoot), true);

    // A local read guard cannot account for leases held by other runtimes.
    const result = runPublicationStorageMaintenance({
        stateRoot,
        soleOwner: false,
        idleDays: 1,
        ...leasePortForStateRoot(stateRoot),
        withRootLeaseGuard: (_root, fn) => fn(),
        nowMs: Date.parse('2026-11-20T00:00:00.000Z'),
    });
    assert.equal(result.removedRoots.length, 0);
    assert.equal(result.removedRetiredGenerations.length, 0);
    assert.equal(fs.existsSync(orphan.pubRoot), true);
    assert.equal(fs.existsSync(path.join(live.pubRoot, 'generations', 'gen-1')), true);
});

test('held MutationLeaseCoordinator sync lease, active reader guard, and current-root eviction', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-lease-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, 'state');
    const leasedRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'leased-repo-')));
    const readerRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'reader-repo-')));
    const evictableRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'evictable-repo-')));

    const runtime = new RootMutationRuntime({ stateDir: path.join(stateRoot, 'runtime', 'mutation-leases') });
    const pubRuntime = createSharedPublicationRuntime(runtime, { stateRoot });
    const store = getSharedPublicationStore(pubRuntime, runtime);
    const leasePort = createRootMutationLeasePort(runtime);
    const readerGuard = createStorageMaintenanceReaderGuard(pubRuntime, runtime);

    const activate = async (repoRoot: string, id: string, lastUsedAtIso: string) => {
        await runtime.run(repoRoot, 'create', async () => {
            const lease = getCurrentRootMutationLease(runtime, repoRoot);
            store.stageSourceCheckpoint(repoRoot, id, buildPublicationSourceCheckpoint(repoRoot, {
                fileHashes: new Map(), fileStats: new Map(), unprocessedPaths: [],
            }), lease);
            store.stagePackageOwnership(repoRoot, id, buildPublicationPackageOwnership(repoRoot, [], new Map()), lease);
            store.activate({
                version: 2,
                id,
                canonicalRoot: repoRoot,
                createdAt: lastUsedAtIso,
                status: 'partial',
                policy: {
                    profile: 'default', customExtensions: [], customIgnorePatterns: [],
                    fileBasedIgnorePatterns: [], supportedExtensions: ['.ts'], effectiveIgnorePatterns: [],
                    policyHash: 'p', controlSignature: 'c',
                },
                format: { indexFormatVersion: 'f', embeddingIdentity: 'e', relationshipVersion: 'r' },
                vector: { collectionName: `hybrid_code_chunks_${rootKey(repoRoot).slice(0, 8)}__gen_${id}`, indexedFiles: 0, totalChunks: 0 },
                packageOwnership: true,
                navigation: null,
            }, lease);
        });
        fs.writeFileSync(
            path.join(stateRoot, 'publications', rootKey(repoRoot), 'last-used.json'),
            JSON.stringify({ version: 1, canonicalRoot: repoRoot, lastUsedAt: '2026-01-01T00:00:00.000Z' }),
        );
    };

    await activate(leasedRepo, 'g1', '2026-01-01T00:00:00.000Z');
    await activate(readerRepo, 'g1', '2026-01-01T00:00:00.000Z');
    await activate(evictableRepo, 'g1', '2026-01-01T00:00:00.000Z');

    const readLease = store.acquireCurrentRead(readerRepo);
    assert.ok(readLease, 'reader acquires current publication');

    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');
    await runtime.run(leasedRepo, 'sync', async () => {
        const result = runPublicationStorageMaintenance({
            stateRoot,
            soleOwner: true,
            idleDays: 1,
            nowMs,
            ...leasePort,
            ...readerGuard,
        });
        assert.deepEqual(
            result.removedRoots.map((r) => r.canonicalRoot),
            [evictableRepo],
            'only the unleased, unread current root is evicted',
        );
        assert.equal(fs.existsSync(path.join(stateRoot, 'publications', rootKey(leasedRepo))), true);
        assert.equal(fs.existsSync(path.join(stateRoot, 'publications', rootKey(readerRepo))), true);
        assert.equal(fs.existsSync(path.join(stateRoot, 'publications', rootKey(evictableRepo))), false);
    });
    readLease.release();

    // Without lease authority, apply fails closed while dry-run still inspects.
    const dryInspect = runPublicationStorageMaintenance({ stateRoot, soleOwner: true, dryRun: true, idleDays: 1, nowMs });
    assert.ok(dryInspect.before.publicationRootCount >= 2);
    const noAuthorityApply = runPublicationStorageMaintenance({ stateRoot, soleOwner: true, dryRun: false, idleDays: 1, nowMs });
    assert.equal(noAuthorityApply.removedRoots.length, 0);
    assert.equal(noAuthorityApply.reclaimedBytes, 0);
    assert.ok(noAuthorityApply.warnings.some((w) => /lease authority is unavailable/i.test(w)));
});

test('malformed or invalid current.json fails closed for root generations and vector collections', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-bad-ptr-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, 'state');
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-')));
    const fixture = writePublicationFixture({
        stateRoot,
        canonicalRoot: repo,
        currentId: 'gen-1',
        retiredIds: ['gen-0'],
        lastUsedAtIso: '2026-01-01T00:00:00.000Z',
    });

    // Corrupt current.json
    fs.writeFileSync(path.join(fixture.pubRoot, 'current.json'), '{not-valid-json');

    // Empty root with truly absent current.json is still safely cleaned.
    const emptyKey = rootKey(path.join(tmp, 'never-existed'));
    const emptyPubRoot = path.join(stateRoot, 'publications', emptyKey);
    fs.mkdirSync(emptyPubRoot, { recursive: true });

    const result = runPublicationStorageMaintenance({
        stateRoot,
        soleOwner: true,
        idleDays: 1,
        nowMs: Date.parse('2026-11-20T00:00:00.000Z'),
        ...leasePortForStateRoot(stateRoot),
    });

    assert.ok(result.skippedRoots.some((s) => s.rootKey === fixture.key && s.reason === 'uncertain_state'));
    assert.equal(fs.existsSync(path.join(fixture.pubRoot, 'generations', 'gen-1', 'publication.json')), true);
    assert.equal(fs.existsSync(path.join(fixture.pubRoot, 'generations', 'gen-0', 'publication.json')), true);
    assert.equal(fs.existsSync(path.join(stateRoot, 'vector', 'lancedb', `${fixture.currentCollection}.lance`)), true);
    assert.equal(fs.existsSync(path.join(stateRoot, 'vector', 'lancedb', `${fixture.retiredCollections[0]}.lance`)), true);
    assert.equal(fs.existsSync(emptyPubRoot), false, 'truly absent pointer empty root is still cleaned');
});

test('dry-run and apply match on orphan + existing repo budget eviction and hard-linked files', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-parity-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const setupState = (sub: string) => {
        const base = path.join(tmp, sub);
        fs.mkdirSync(base, { recursive: true });
        const stateRoot = path.join(base, 'state');
        const liveRepo = fs.realpathSync(fs.mkdtempSync(path.join(base, 'live-')));
        const orphanRepo = path.join(base, 'deleted-repo');
        const live = writePublicationFixture({
            stateRoot,
            canonicalRoot: liveRepo,
            currentId: 'gen-2',
            retiredIds: ['gen-1'],
            lastUsedAtIso: '2026-11-19T00:00:00.000Z',
            payloadBytes: 8192,
        });
        // Hard-link a shard between gen-1 and gen-2 so Phase A cannot double-free it.
        const sharedSrc = path.join(live.pubRoot, 'generations', 'gen-2', 'payload.bin');
        const sharedDst = path.join(live.pubRoot, 'generations', 'gen-1', 'shared.bin');
        fs.linkSync(sharedSrc, sharedDst);

        const orphan = writePublicationFixture({
            stateRoot,
            canonicalRoot: orphanRepo,
            currentId: 'gen-a',
            lastUsedAtIso: '2026-11-19T00:00:00.000Z',
            payloadBytes: 8192,
        });
        return { stateRoot, live, orphan };
    };

    const a = setupState('dry');
    const b = setupState('apply');
    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');
    // Budget smaller than remaining live repo after orphan + retired gen-1 are removed.
    const maxStorageBytes = 4096;

    const dry = runPublicationStorageMaintenance({
        stateRoot: a.stateRoot,
        soleOwner: true,
        dryRun: true,
        maxStorageBytes,
        nowMs,
        ...leasePortForStateRoot(a.stateRoot),
    });
    const applied = runPublicationStorageMaintenance({
        stateRoot: b.stateRoot,
        soleOwner: true,
        dryRun: false,
        maxStorageBytes,
        nowMs,
        ...leasePortForStateRoot(b.stateRoot),
    });

    assert.deepEqual(
        dry.removedRoots.map((r) => [r.reason, r.bytesFreed]),
        applied.removedRoots.map((r) => [r.reason, r.bytesFreed]),
    );
    assert.equal(dry.removedRoots.length, 2, 'both dry-run and apply predict orphan + storage_budget eviction');
    assert.equal(dry.reclaimedBytes, applied.reclaimedBytes);
    assert.equal(dry.after.publicationsBytes, applied.after.publicationsBytes);
    assert.equal(dry.after.vectorBytes, applied.after.vectorBytes);
    assert.equal(dry.after.typescriptResolutionBytes, applied.after.typescriptResolutionBytes);
    assert.equal(dry.after.publicationRootCount, applied.after.publicationRootCount);
    assert.equal(dry.after.vectorCollectionCount, applied.after.vectorCollectionCount);
});

test('custom LANCEDB_PATH is accounted and swept while Milvus and unowned DBs are untouched', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-vectordb-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, 'state');
    const customLance = path.join(tmp, 'custom-lancedb');
    const liveRepo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'live-repo-')));
    const orphanRepo = path.join(tmp, 'gone-repo');
    const live = writePublicationFixture({
        stateRoot,
        canonicalRoot: liveRepo,
        currentId: 'gen-1',
        lastUsedAtIso: '2026-11-19T00:00:00.000Z',
        vectorDbPath: customLance,
    });
    const orphan = writePublicationFixture({
        stateRoot,
        canonicalRoot: orphanRepo,
        currentId: 'gen-1',
        lastUsedAtIso: '2026-11-19T00:00:00.000Z',
        vectorDbPath: customLance,
    });
    const stray = path.join(customLance, 'hybrid_code_chunks_deadbeef__gen_stray.lance');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'data.lance'), Buffer.alloc(4096, 0x55));

    const leasePort = leasePortForStateRoot(stateRoot);
    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');
    // Milvus mode must never sweep LanceDB.
    const milvusRes = runPublicationStorageMaintenance({
        stateRoot,
        soleOwner: true,
        vectorStoreProvider: 'Milvus',
        vectorDbPath: customLance,
        dryRun: true,
        nowMs,
        ...leasePort,
    });
    assert.equal(milvusRes.before.vectorCollectionCount, 0);
    assert.equal(fs.existsSync(stray), true);

    // Unowned external DB containing non-Satori entries must not be swept or budgeted.
    const foreignFile = path.join(customLance, 'foreign-user-notes.txt');
    fs.writeFileSync(foreignFile, 'do not touch');
    const unownedRes = runPublicationStorageMaintenance({
        stateRoot,
        soleOwner: true,
        vectorStoreProvider: 'LanceDB',
        vectorDbPath: customLance,
        dryRun: true,
        nowMs,
        ...leasePort,
    });
    assert.equal(unownedRes.before.vectorCollectionCount, 0);
    assert.ok(unownedRes.warnings.some((w) => /non-Satori entries/i.test(w)));
    fs.rmSync(foreignFile);

    // Valid custom LANCEDB_PATH sweeps explicitly owned orphan collection while keeping live and unowned external stray tables.
    const lanceRes = runPublicationStorageMaintenance({
        stateRoot,
        soleOwner: true,
        vectorStoreProvider: 'LanceDB',
        vectorDbPath: customLance,
        dryRun: false,
        nowMs,
        ...leasePort,
    });
    assert.equal(lanceRes.before.vectorCollectionCount, 3);
    assert.equal(lanceRes.after.vectorCollectionCount, 2);
    assert.equal(fs.existsSync(path.join(customLance, `${live.currentCollection}.lance`)), true);
    assert.equal(fs.existsSync(path.join(customLance, `${orphan.currentCollection}.lance`)), false);
    assert.equal(fs.existsSync(stray), true, 'external DB skips arbitrary unreferenced-table sweep without namespace proof');
});

test('storage maintenance refuses symlinked publication and TypeScript cache directories and targets', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-storage-symlinks-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, 'state');
    const outside = path.join(tmp, 'outside');
    const fixture = writePublicationFixture({
        stateRoot: outside, canonicalRoot: path.join(tmp, 'orphan'), currentId: 'gen-1',
    });
    const publicationFile = path.join(fixture.pubRoot, 'generations', 'gen-1', 'publication.json');
    const outsideCache = path.join(outside, 'typescript-resolution', `${fixture.key}.json`);
    const originalPublication = fs.readFileSync(publicationFile, 'utf8');
    const originalCache = fs.readFileSync(outsideCache, 'utf8');
    fs.mkdirSync(stateRoot);
    const publications = path.join(stateRoot, 'publications');
    const tsCache = path.join(stateRoot, 'typescript-resolution');
    fs.symlinkSync(path.join(outside, 'publications'), publications, 'dir');
    fs.symlinkSync(path.dirname(outsideCache), tsCache, 'dir');

    const options = { stateRoot, soleOwner: true, ...leasePortForStateRoot(stateRoot) };
    const readDir = t.mock.method(fs, 'readdirSync');
    const result = runPublicationStorageMaintenance(options);
    assert.equal(readDir.mock.calls.some(call => call.arguments[0] === publications || call.arguments[0] === tsCache), false);
    assert.match(result.warnings.join('\n'), /unsafe publications directory/);
    assert.match(result.warnings.join('\n'), /unsafe typescript-resolution directory/);
    assert.deepEqual(result.removedRoots, []);
    assert.equal(result.removedTypescriptResolutionFiles, 0);
    assert.equal(fs.readFileSync(publicationFile, 'utf8'), originalPublication);
    assert.equal(fs.readFileSync(outsideCache, 'utf8'), originalCache);

    fs.unlinkSync(publications);
    fs.mkdirSync(publications);
    fs.unlinkSync(tsCache);
    fs.mkdirSync(tsCache);
    const linkedCache = path.join(tsCache, path.basename(outsideCache));
    fs.symlinkSync(outsideCache, linkedCache);
    assert.equal(runPublicationStorageMaintenance(options).removedTypescriptResolutionFiles, 0);
    assert.equal(fs.lstatSync(linkedCache).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outsideCache, 'utf8'), originalCache);
});
