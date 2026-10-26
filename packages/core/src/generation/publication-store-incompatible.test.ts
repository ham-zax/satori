import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPublicationSourceCheckpoint } from '../sync/snapshot-codec';
import { PublicationStore, resolvePublicationGenerationRoot } from './publication-store';
import type { Publication } from './contracts';
import { RootMutationRuntime, getCurrentRootMutationLease, getRootMutationCoordinator } from './root-mutation-runtime';

const INCOMPATIBLE_ID = 'legacy-publication';

function writeCurrent(stateRoot: string, canonicalRoot: string): string {
    const publication: Publication = {
        version: 2,
        id: 'current',
        canonicalRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'partial',
        policy: {
            profile: 'default', customExtensions: [], customIgnorePatterns: [],
            fileBasedIgnorePatterns: [], supportedExtensions: ['.ts'], effectiveIgnorePatterns: [],
            policyHash: 'test-policy', controlSignature: 'test-control',
        },
        format: { indexFormatVersion: 'test', embeddingIdentity: 'test', relationshipVersion: 'test' },
        vector: { collectionName: 'test-collection', indexedFiles: 0, totalChunks: 0 },
        packageOwnership: false,
        navigation: null,
    };
    const generationRoot = resolvePublicationGenerationRoot(canonicalRoot, publication.id, stateRoot);
    fs.mkdirSync(generationRoot, { recursive: true });
    fs.writeFileSync(path.join(generationRoot, 'publication.json'), JSON.stringify(publication));
    const publicationRoot = path.dirname(path.dirname(generationRoot));
    fs.writeFileSync(path.join(publicationRoot, 'current.json'), JSON.stringify({ version: 1, publicationId: publication.id }));
    return publicationRoot;
}

for (const phase of ['startup', 'listing'] as const) {
    test(`${phase} skips a moved canonical root and preserves its state`, (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-moved-publication-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const staleRoot = path.join(directory, 'stale');
        const healthyRoot = path.join(directory, 'healthy');
        const targetRoot = path.join(directory, 'target');
        for (const root of [staleRoot, healthyRoot, targetRoot]) fs.mkdirSync(root);
        const runtime = new RootMutationRuntime({ stateDir: path.join(directory, 'mutations') });
        const options = { stateRoot: path.join(directory, 'state'), mutationCoordinator: getRootMutationCoordinator(runtime) };
        const stalePublicationRoot = writeCurrent(options.stateRoot, staleRoot);
        const healthyPublicationRoot = writeCurrent(options.stateRoot, healthyRoot);
        const store = phase === 'listing' ? new PublicationStore(options) : undefined;
        const staleOrphan = path.join(stalePublicationRoot, 'generations', 'orphan', 'source.json');
        const healthyOrphan = path.join(healthyPublicationRoot, 'generations', 'orphan', 'source.json');
        for (const [file, canonicalRoot] of [[staleOrphan, staleRoot], [healthyOrphan, healthyRoot]]) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ canonicalRoot }));
        }
        const staleFiles = [
            path.join(stalePublicationRoot, 'current.json'),
            path.join(stalePublicationRoot, 'generations', 'current', 'publication.json'),
            staleOrphan,
        ];
        const before = staleFiles.map((file) => fs.readFileSync(file, 'utf8'));
        fs.renameSync(staleRoot, `${staleRoot}-original`);
        fs.symlinkSync(targetRoot, staleRoot, 'dir');
        const warnings: string[] = [];
        t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
        const checkWarning = () => {
            assert.equal(warnings.length, 1);
            for (const value of [stalePublicationRoot, staleRoot, targetRoot]) assert.ok(warnings[0].includes(value));
            warnings.length = 0;
        };
        const restarted = store ?? new PublicationStore(options);
        if (phase === 'startup') {
            checkWarning();
            assert.equal(fs.existsSync(healthyOrphan), false, 'startup continues pruning healthy roots');
        }
        assert.deepEqual(restarted.listCurrent().map((ref) => ref.publication.canonicalRoot), [healthyRoot]);
        checkWarning();
        assert.deepEqual(staleFiles.map((file) => fs.readFileSync(file, 'utf8')), before);
    });

    test(`${phase} still rejects a Publication root key mismatch`, (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publication-key-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const root = path.join(directory, 'repo');
        fs.mkdirSync(root);
        const runtime = new RootMutationRuntime({ stateDir: path.join(directory, 'mutations') });
        const options = { stateRoot: path.join(directory, 'state'), mutationCoordinator: getRootMutationCoordinator(runtime) };
        const publicationRoot = writeCurrent(options.stateRoot, root);
        const store = phase === 'listing' ? new PublicationStore(options) : undefined;
        const wrongRoot = path.join(path.dirname(publicationRoot), '0'.repeat(64));
        fs.renameSync(publicationRoot, wrongRoot);
        assert.throws(() => store ? store.listCurrent() : new PublicationStore(options), {
            message: phase === 'startup'
                ? `Publication startup state at '${wrongRoot}' has inconsistent root ownership.`
                : `Current Publication state at '${wrongRoot}' has inconsistent root/id ownership.`,
        });
    });
}

/** Lays out a current Publication whose descriptor is from a previous format version. */
function writeIncompatibleCurrent(tempRoot: string, repoRoot: string): { stateRoot: string; generationRoot: string } {
    const stateRoot = path.join(tempRoot, 'state');
    const generationRoot = resolvePublicationGenerationRoot(repoRoot, INCOMPATIBLE_ID, stateRoot);
    fs.mkdirSync(generationRoot, { recursive: true });
    fs.writeFileSync(
        path.join(generationRoot, 'publication.json'),
        JSON.stringify({ version: 1, id: INCOMPATIBLE_ID, canonicalRoot: repoRoot }),
    );
    fs.writeFileSync(
        path.join(path.dirname(path.dirname(generationRoot)), 'current.json'),
        JSON.stringify({ version: 1, publicationId: INCOMPATIBLE_ID }),
    );
    return { stateRoot, generationRoot };
}

function withFixture(run: (input: {
    repoRoot: string;
    stateRoot: string;
    generationRoot: string;
    createStore: () => PublicationStore;
}) => void | Promise<void>): () => Promise<void> {
    return async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-incompatible-publication-'));
        const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'repo-')));
        const runtime = new RootMutationRuntime({
            stateDir: path.join(tempRoot, 'mutations'),
            ownerId: 'incompatible-publication-test',
        });
        try {
            const { stateRoot, generationRoot } = writeIncompatibleCurrent(tempRoot, repoRoot);
            await run({
                repoRoot,
                stateRoot,
                generationRoot,
                createStore: () => new PublicationStore({
                    stateRoot,
                    mutationCoordinator: getRootMutationCoordinator(runtime),
                }),
            });
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    };
}

test('a store starts with an incompatible current Publication and leaves its generation on disk', withFixture(
    ({ createStore, generationRoot }) => {
        assert.doesNotThrow(() => createStore());
        assert.ok(fs.existsSync(path.join(generationRoot, 'publication.json')));
    },
));

test('the current-state reader reports an incompatible current Publication without parsing it', withFixture(
    ({ createStore, repoRoot }) => {
        const store = createStore();
        assert.deepEqual(store.getCurrentState(repoRoot), { kind: 'incompatible', publicationId: INCOMPATIBLE_ID });
        assert.equal(store.getCurrent(repoRoot), null);
        assert.equal(store.acquireCurrentRead(repoRoot), null);
        assert.deepEqual(store.listCurrent(), []);
    },
));

test('an unindexed root reports a missing current state', withFixture(({ createStore, repoRoot }) => {
    const store = createStore();
    const otherRoot = path.join(repoRoot, 'other');
    fs.mkdirSync(otherRoot);
    assert.deepEqual(store.getCurrentState(otherRoot), { kind: 'missing' });
}));

test('cold startup still rejects previously corrupted source metadata without a current pointer', async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-corrupt-source-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'repo-')));
    const runtime = new RootMutationRuntime({ stateDir: path.join(tempRoot, 'mutations') });
    const options = {
        stateRoot: path.join(tempRoot, 'state'),
        mutationCoordinator: getRootMutationCoordinator(runtime),
    };
    const store = new PublicationStore(options);
    const generationRoot = resolvePublicationGenerationRoot(repoRoot, 'corrupt-source', options.stateRoot);
    const sourcePath = path.join(generationRoot, 'source.json');
    await runtime.run(repoRoot, 'create', async () => {
        store.stageSourceCheckpoint(repoRoot, 'corrupt-source', buildPublicationSourceCheckpoint(repoRoot, {
            fileHashes: new Map(),
            fileStats: new Map(),
            unprocessedPaths: [],
        }), getCurrentRootMutationLease(runtime, repoRoot));
        fs.truncateSync(sourcePath, 10);
    });
    const corruptContents = fs.readFileSync(sourcePath, 'utf8');
    const restarted = new PublicationStore(options);
    // Bypass only the per-process constructor cache, keeping startup validation intact.
    assert.throws(() => {
        (restarted as unknown as { pruneStartupOrphans(): void }).pruneStartupOrphans();
    }, SyntaxError);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), corruptContents);
});

test('a corrupt current pointer fails only its own root at startup and in listing', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-corrupt-pointer-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const corruptRoot = fs.realpathSync(fs.mkdtempSync(path.join(directory, 'corrupt-')));
    const healthyRoot = fs.realpathSync(fs.mkdtempSync(path.join(directory, 'healthy-')));
    const runtime = new RootMutationRuntime({ stateDir: path.join(directory, 'mutations') });
    const options = { stateRoot: path.join(directory, 'state'), mutationCoordinator: getRootMutationCoordinator(runtime) };
    const corruptPublicationRoot = writeCurrent(options.stateRoot, corruptRoot);
    const healthyPublicationRoot = writeCurrent(options.stateRoot, healthyRoot);
    const pointerPath = path.join(corruptPublicationRoot, 'current.json');
    fs.writeFileSync(pointerPath, '{"version":');
    const corruptOrphan = path.join(corruptPublicationRoot, 'generations', 'orphan', 'source.json');
    const healthyOrphan = path.join(healthyPublicationRoot, 'generations', 'orphan', 'source.json');
    for (const [file, canonicalRoot] of [[corruptOrphan, corruptRoot], [healthyOrphan, healthyRoot]]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ canonicalRoot }));
    }
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });

    const store = new PublicationStore(options);
    assert.equal(fs.existsSync(corruptOrphan), true, 'cleanup leaves a root without a trusted pointer untouched');
    assert.equal(fs.existsSync(healthyOrphan), false, 'cleanup continues for healthy roots');
    assert.deepEqual(store.listCurrent().map((ref) => ref.publication.canonicalRoot), [healthyRoot]);
    assert.throws(() => store.getCurrentState(corruptRoot), SyntaxError);
    assert.equal(warnings.length, 2);
    for (const warning of warnings) assert.ok(warning.includes(pointerPath));
    assert.equal(fs.readFileSync(pointerPath, 'utf8'), '{"version":');
});
