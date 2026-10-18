import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildPublicationPackageOwnership, parsePublicationPackageOwnership } from '../packages/ownership';
import { buildPublicationSourceCheckpoint, parsePublicationSourceCheckpoint } from '../sync/snapshot-codec';
import { PublicationStore, resolvePublicationGenerationRoot } from './publication-store';
import { RootMutationRuntime, getCurrentRootMutationLease, getRootMutationCoordinator } from './root-mutation-runtime';
import type { Publication } from './contracts';
import type { RootMutationLease } from './root-mutation-coordinator';

const PUBLICATION_ID = 'cached-publication';

function withStore(run: (input: {
    repoRoot: string;
    generationRoot: string;
    store: PublicationStore;
}) => void): () => void {
    return () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-immutable-files-'));
        const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'repo-')));
        const stateRoot = path.join(tempRoot, 'state');
        const runtime = new RootMutationRuntime({
            stateDir: path.join(tempRoot, 'mutations'),
            ownerId: 'immutable-files-test',
        });
        try {
            const store = new PublicationStore({ stateRoot, mutationCoordinator: getRootMutationCoordinator(runtime) });
            const generationRoot = resolvePublicationGenerationRoot(repoRoot, PUBLICATION_ID, stateRoot);
            fs.mkdirSync(generationRoot, { recursive: true });
            run({ repoRoot, generationRoot, store });
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    };
}

function checkpointJson(repoRoot: string, files: string[]): string {
    return JSON.stringify(buildPublicationSourceCheckpoint(repoRoot, {
        fileHashes: new Map(files.map((file) => [file, 'a'.repeat(64)])),
        fileStats: new Map(files.map((file, index) => [file, { size: index, mtimeMs: index, ctimeMs: index }])),
        unprocessedPaths: [],
    }));
}

/** Replaces a file the way GC plus re-staging would: a new inode with new content. */
function replaceFile(filePath: string, content: string): void {
    fs.rmSync(filePath, { force: true });
    fs.writeFileSync(filePath, content);
}

test('cached Publication file reads match an uncached parse across file lifecycle changes', withStore(
    ({ repoRoot, generationRoot, store }) => {
        const sourcePath = path.join(generationRoot, 'source.json');
        const ownershipPath = path.join(generationRoot, 'ownership.json');
        const readers = [
            {
                filePath: sourcePath,
                read: () => store.getSourceCheckpoint(repoRoot, PUBLICATION_ID),
                parse: (content: string) => parsePublicationSourceCheckpoint(content, repoRoot),
                versions: [checkpointJson(repoRoot, ['a.ts']), checkpointJson(repoRoot, ['a.ts', 'b.ts'])],
            },
            {
                filePath: ownershipPath,
                read: () => store.getPackageOwnership(repoRoot, PUBLICATION_ID),
                parse: (content: string) => parsePublicationPackageOwnership(content, repoRoot),
                versions: [
                    JSON.stringify(buildPublicationPackageOwnership(repoRoot, ['a.ts'], new Map())),
                    JSON.stringify(buildPublicationPackageOwnership(repoRoot, ['a.ts', 'b.ts'], new Map())),
                ],
            },
        ];

        for (const reader of readers) {
            const expectRead = () => {
                const content = fs.existsSync(reader.filePath) ? fs.readFileSync(reader.filePath, 'utf8') : null;
                if (content === null) {
                    assert.equal(reader.read(), null);
                    return;
                }
                let expected: unknown;
                try {
                    expected = reader.parse(content);
                } catch (error) {
                    assert.throws(() => reader.read(), { message: (error as Error).message });
                    return;
                }
                assert.deepEqual(reader.read(), expected);
            };

            expectRead();
            fs.writeFileSync(reader.filePath, reader.versions[0]);
            expectRead();
            const first = reader.read();
            assert.equal(reader.read(), first, 'unchanged files reuse the parsed value');
            assert.throws(() => { (first as { canonicalRoot: string }).canonicalRoot = 'mutated'; }, TypeError);

            replaceFile(reader.filePath, reader.versions[1]);
            expectRead();
            replaceFile(reader.filePath, '{"truncated":');
            expectRead();
            expectRead();
            replaceFile(reader.filePath, reader.versions[0]);
            expectRead();
            fs.rmSync(reader.filePath);
            expectRead();
        }
    },
));

function stagingFixture(t: TestContext) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-durable-metadata-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'repo-')));
    const runtime = new RootMutationRuntime({ stateDir: path.join(tempRoot, 'mutations') });
    const options = {
        stateRoot: path.join(tempRoot, 'state'),
        mutationCoordinator: getRootMutationCoordinator(runtime),
    };
    const store = new PublicationStore(options);
    const generationRoot = resolvePublicationGenerationRoot(repoRoot, PUBLICATION_ID, options.stateRoot);
    const checkpoint = parsePublicationSourceCheckpoint(checkpointJson(repoRoot, ['a.ts']), repoRoot);
    const ownership = buildPublicationPackageOwnership(repoRoot, ['a.ts'], new Map());
    const publication: Publication = {
        version: 2,
        id: PUBLICATION_ID,
        canonicalRoot: repoRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'partial',
        policy: {
            profile: 'default',
            customExtensions: [],
            customIgnorePatterns: [],
            fileBasedIgnorePatterns: [],
            supportedExtensions: ['.ts'],
            effectiveIgnorePatterns: [],
            policyHash: 'test-policy',
            controlSignature: 'test-control',
        },
        format: { indexFormatVersion: 'test', embeddingIdentity: 'test', relationshipVersion: 'test' },
        vector: { collectionName: 'test-collection', indexedFiles: 1, totalChunks: 1 },
        packageOwnership: true,
        navigation: null,
    };
    const metadata = [
        {
            name: 'source.json',
            value: checkpoint,
            stage: (lease: RootMutationLease) => store.stageSourceCheckpoint(repoRoot, PUBLICATION_ID, checkpoint, lease),
        },
        {
            name: 'ownership.json',
            value: ownership,
            stage: (lease: RootMutationLease) => store.stagePackageOwnership(repoRoot, PUBLICATION_ID, ownership, lease),
        },
        {
            name: 'publication.json',
            value: publication,
            stage: (lease: RootMutationLease) => store.activate(publication, lease),
        },
    ];
    return { repoRoot, runtime, options, store, generationRoot, metadata };
}

for (const name of ['source.json', 'ownership.json', 'publication.json']) {
    for (const failurePoint of ['write', 'fsync'] as const) {
        test(`${name} ${failurePoint} failure publishes no metadata and cold startup remains usable`, async (t) => {
            const { repoRoot, runtime, generationRoot, metadata, options } = stagingFixture(t);
            const target = metadata.find((entry) => entry.name === name)!;
            const targetPath = path.join(generationRoot, name);
            await runtime.run(repoRoot, 'create', async () => {
                const lease = getCurrentRootMutationLease(runtime, repoRoot);
                if (name === 'publication.json') {
                    metadata[0]!.stage(lease);
                    metadata[1]!.stage(lease);
                }
                const before = fs.existsSync(generationRoot) ? fs.readdirSync(generationRoot).sort() : [];
                const originalOpen = fs.openSync;
                const originalWrite = fs.writeFileSync;
                const originalFsync = fs.fsyncSync;
                const failure = Object.assign(new Error(`injected metadata ${failurePoint} failure`), { code: 'ENOSPC' });
                let descriptor: number | undefined;
                let visibleBeforePublication = false;
                t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
                    const opened = originalOpen(...args);
                    if (typeof args[0] === 'string'
                        && path.dirname(args[0]) === generationRoot
                        && path.basename(args[0]).startsWith(name)
                        && args[1] === 'wx') {
                        descriptor = opened;
                    }
                    return opened;
                });
                t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
                    if (args[0] === descriptor && failurePoint === 'write') {
                        originalWrite(descriptor!, '{"version":', 'utf8');
                        visibleBeforePublication = fs.existsSync(targetPath);
                        throw failure;
                    }
                    return originalWrite(...args);
                });
                t.mock.method(fs, 'fsyncSync', (opened: number) => {
                    if (opened === descriptor && failurePoint === 'fsync') {
                        visibleBeforePublication = fs.existsSync(targetPath);
                        throw failure;
                    }
                    return originalFsync(opened);
                });
                try {
                    assert.throws(() => target.stage(lease), (error) => error === failure);
                } finally {
                    t.mock.restoreAll();
                }
                assert.notEqual(descriptor, undefined, 'the real staging write reaches fault injection');
                assert.throws(() => fs.fstatSync(descriptor!), { code: 'EBADF' }, 'the staging descriptor closes');
                assert.equal(visibleBeforePublication, false);
                assert.equal(fs.existsSync(targetPath), false);
                assert.deepEqual(fs.readdirSync(generationRoot).sort(), before, 'no temporary sibling remains');
            });
            const restarted = new PublicationStore(options);
            // Constructors cache cleanup per state root. Run the actual cold path
            // after releasing the mutation lease, as a fresh process would.
            assert.doesNotThrow(() => {
                (restarted as unknown as { pruneStartupOrphans(): void }).pruneStartupOrphans();
            });
            assert.deepEqual(restarted.getCurrentState(repoRoot), { kind: 'missing' });
        });
    }

    test(`${name} creation does not overwrite a competing target`, async (t) => {
        const { repoRoot, runtime, generationRoot, metadata } = stagingFixture(t);
        const target = metadata.find((entry) => entry.name === name)!;
        const targetPath = path.join(generationRoot, name);
        await runtime.run(repoRoot, 'create', async () => {
            const lease = getCurrentRootMutationLease(runtime, repoRoot);
            const originalLink = fs.linkSync;
            const competingContents = '{"competing":"metadata"}';
            t.mock.method(fs, 'linkSync', (source: fs.PathLike, destination: fs.PathLike) => {
                if (String(destination) === targetPath) {
                    assert.equal(fs.readFileSync(source, 'utf8'), `${JSON.stringify(target.value, null, 2)}\n`);
                    fs.writeFileSync(destination, competingContents, { flag: 'wx' });
                }
                return originalLink(source, destination);
            });
            try {
                assert.throws(() => target.stage(lease), { code: 'EEXIST' });
            } finally {
                t.mock.restoreAll();
            }
            assert.equal(fs.readFileSync(targetPath, 'utf8'), competingContents);
            assert.deepEqual(fs.readdirSync(generationRoot), [name], 'only the competing inode remains');
        });
    });
}

test('successful metadata staging preserves exact content and current authority at cold startup', async (t) => {
    const { repoRoot, runtime, store, generationRoot, metadata, options } = stagingFixture(t);
    await runtime.run(repoRoot, 'create', async () => {
        const lease = getCurrentRootMutationLease(runtime, repoRoot);
        for (const entry of metadata) {
            entry.stage(lease);
            assert.equal(fs.readFileSync(path.join(generationRoot, entry.name), 'utf8'),
                `${JSON.stringify(entry.value, null, 2)}\n`);
            entry.stage(lease);
        }
    });
    assert.deepEqual(fs.readdirSync(generationRoot).sort(), metadata.map((entry) => entry.name).sort());
    const orphanRoot = resolvePublicationGenerationRoot(repoRoot, 'incomplete-orphan', options.stateRoot);
    fs.mkdirSync(orphanRoot);
    fs.writeFileSync(path.join(orphanRoot, 'source.json'), '{"version":');
    const restarted = new PublicationStore(options);
    (restarted as unknown as { pruneStartupOrphans(): void }).pruneStartupOrphans();
    assert.equal(fs.existsSync(orphanRoot), false, 'valid current metadata supplies authoritative root identity');
    assert.deepEqual(restarted.getCurrent(repoRoot), store.getCurrent(repoRoot));
    assert.equal(restarted.getCurrent(repoRoot)?.id, PUBLICATION_ID);
});
