import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPublicationPackageOwnership, parsePublicationPackageOwnership } from '../packages/ownership';
import { buildPublicationSourceCheckpoint, parsePublicationSourceCheckpoint } from '../sync/snapshot-codec';
import { PublicationStore, resolvePublicationGenerationRoot } from './publication-store';
import { RootMutationRuntime, getRootMutationCoordinator } from './root-mutation-runtime';

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
