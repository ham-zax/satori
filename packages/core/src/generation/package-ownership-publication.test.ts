import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Context } from '../core/context';
import { IndexingPipeline } from '../core/indexing-pipeline';
import { Embedding, EMBEDDING_NORMALIZATION_POLICY_VERSION } from '../embedding';
import { resolvePublicationGenerationRoot } from './publication-store';
import { LanceDbVectorDatabase } from '../vectordb/lancedb-vectordb';

class FixtureEmbedding extends Embedding {
    protected maxTokens = 8192;

    getDimension() { return 4; }
    getProvider() { return 'fixture'; }

    getIdentity() {
        return {
            provider: 'fixture',
            model: 'fixture',
            dimension: 4,
            artifactDigest: null,
            normalizationPolicy: EMBEDDING_NORMALIZATION_POLICY_VERSION,
        };
    }

    async detectDimension() { return 4; }
    async embedQuery() { return { vector: [1, 0, 0, 0], dimension: 4 }; }
    async embedDocuments(texts: string[]) {
        return Promise.all(texts.map(() => this.embedQuery()));
    }
}

function writeFile(root: string, relativePath: string, contents: string): void {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
}

function createContext(databasePath: string) {
    const database = new LanceDbVectorDatabase({ databasePath });
    const context = new Context({
        embedding: new FixtureEmbedding(),
        vectorDatabase: database,
        semanticAnalyzer: {
            supportsLanguage: () => false,
            analyze: async (input) => ({
                language: input.language,
                occurrencesByFile: new Map(),
            }),
        },
    });
    return { database, context };
}

function ownerFor(
    ownership: NonNullable<ReturnType<Context['getPublicationPackageOwnership']>>,
    filePath: string,
): string | null | undefined {
    return ownership.files.find((entry) => entry.path === filePath)?.packageRoot;
}

test('package ownership persists with the Publication and reopens without repository rediscovery', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-publication-'));
    const root = path.join(tempRoot, 'repo');
    const databasePath = path.join(tempRoot, 'vectors');

    writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    writeFile(root, 'package.json', JSON.stringify({ name: 'workspace-root', private: true }));
    writeFile(root, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a' }));
    writeFile(root, 'packages/a/src/a.py', 'def a():\n    return 1\n');
    writeFile(root, 'repository.py', 'def repository():\n    return 1\n');

    let first = createContext(databasePath);
    try {
        await first.context.indexCodebase(root);
        const current = first.context.getCurrentPublication(root);
        assert.ok(current);

        const ownership = first.context.getPublicationPackageOwnership(current);
        assert.ok(ownership);
        assert.equal(ownership.workspace?.kind, 'pnpm');
        assert.equal(
            ownership.packages.find((entry) => entry.root === '')?.name,
            'workspace-root',
        );
        assert.equal(
            ownership.packages.find((entry) => entry.root === 'packages/a')?.name,
            '@fixture/a',
        );
        assert.equal(ownerFor(ownership, 'packages/a/src/a.py'), 'packages/a');
        assert.equal(ownerFor(ownership, 'repository.py'), '');
        assert.equal(
            ownership.controlFiles.some(([filePath]) => filePath === 'package.json'),
            true,
        );

        const persistedPath = path.join(
            resolvePublicationGenerationRoot(root, current.id),
            'ownership.json',
        );
        assert.equal(fs.existsSync(persistedPath), true);

        const expected = structuredClone(ownership);
        await first.context.dispose();
        await first.database.close();

        first = createContext(databasePath);
        const reopenedPublication = first.context.getCurrentPublication(root);
        assert.ok(reopenedPublication);
        assert.equal(reopenedPublication.id, current.id);
        assert.deepEqual(
            first.context.getPublicationPackageOwnership(reopenedPublication),
            expected,
        );
        assert.equal(
            (await first.context.getCurrentPublicationForValidation(root)).status,
            'valid',
        );
    } finally {
        await first.context.dispose();
        await first.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('incremental sync reassigns unchanged files when a nested workspace package appears and disappears', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-sync-'));
    const root = path.join(tempRoot, 'repo');
    const databasePath = path.join(tempRoot, 'vectors');

    writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
    writeFile(root, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a' }));
    writeFile(root, 'packages/a/src/a.py', 'def a():\n    return 1\n');
    writeFile(root, 'packages/a/plugins/b/src/b.py', 'def b():\n    return 1\n');

    const fixture = createContext(databasePath);
    try {
        await fixture.context.indexCodebase(root);
        const initial = fixture.context.getCurrentPublication(root);
        assert.ok(initial);
        const initialOwnership = fixture.context.getPublicationPackageOwnership(initial);
        assert.ok(initialOwnership);
        assert.equal(ownerFor(initialOwnership, 'packages/a/plugins/b/src/b.py'), 'packages/a');

        writeFile(
            root,
            'packages/a/plugins/b/package.json',
            JSON.stringify({ name: '@fixture/b' }),
        );
        await fixture.context.reindexByChange(root);

        const nested = fixture.context.getCurrentPublication(root);
        assert.ok(nested);
        assert.notEqual(nested.id, initial.id);
        const nestedOwnership = fixture.context.getPublicationPackageOwnership(nested);
        assert.ok(nestedOwnership);
        assert.equal(
            nestedOwnership.packages.find((entry) => entry.root === 'packages/a/plugins/b')?.name,
            '@fixture/b',
        );
        assert.equal(
            ownerFor(nestedOwnership, 'packages/a/plugins/b/src/b.py'),
            'packages/a/plugins/b',
        );

        fs.unlinkSync(path.join(root, 'packages/a/plugins/b/package.json'));
        await fixture.context.reindexByChange(root);

        const restored = fixture.context.getCurrentPublication(root);
        assert.ok(restored);
        assert.notEqual(restored.id, nested.id);
        const restoredOwnership = fixture.context.getPublicationPackageOwnership(restored);
        assert.ok(restoredOwnership);
        assert.equal(
            restoredOwnership.packages.some((entry) => entry.root === 'packages/a/plugins/b'),
            false,
        );
        assert.equal(ownerFor(restoredOwnership, 'packages/a/plugins/b/src/b.py'), 'packages/a');
    } finally {
        await fixture.context.dispose();
        await fixture.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('root package identity changes refresh ownership without ordinary source changes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-root-refresh-'));
    const root = path.join(tempRoot, 'repo');
    const databasePath = path.join(tempRoot, 'vectors');

    writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    writeFile(root, 'package.json', JSON.stringify({ name: 'root-before', private: true }));
    writeFile(root, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a' }));
    writeFile(root, 'repository.py', 'def repository():\n    return 1\n');

    const fixture = createContext(databasePath);
    try {
        await fixture.context.indexCodebase(root);
        const before = fixture.context.getCurrentPublication(root);
        assert.ok(before);
        const beforeOwnership = fixture.context.getPublicationPackageOwnership(before);
        assert.ok(beforeOwnership);
        const beforeRootControlHash = beforeOwnership.controlFiles
            .find(([filePath]) => filePath === 'package.json')?.[1];
        assert.ok(beforeRootControlHash);
        assert.equal(
            beforeOwnership.packages.find((entry) => entry.root === '')?.name,
            'root-before',
        );

        writeFile(root, 'package.json', JSON.stringify({ name: 'root-after', private: true }));
        await fixture.context.reindexByChange(root);

        const after = fixture.context.getCurrentPublication(root);
        assert.ok(after);
        assert.notEqual(after.id, before.id);
        const afterOwnership = fixture.context.getPublicationPackageOwnership(after);
        assert.ok(afterOwnership);
        assert.equal(
            afterOwnership.packages.find((entry) => entry.root === '')?.name,
            'root-after',
        );
        assert.equal(ownerFor(afterOwnership, 'repository.py'), '');
        assert.notEqual(
            afterOwnership.controlFiles.find(([filePath]) => filePath === 'package.json')?.[1],
            beforeRootControlHash,
        );
    } finally {
        await fixture.context.dispose();
        await fixture.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('workspace membership transitions synchronize in both searchability directions', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-membership-sync-'));
    const root = path.join(tempRoot, 'repo');
    const databasePath = path.join(tempRoot, 'vectors');

    writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
    writeFile(root, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a' }));
    writeFile(root, 'packages/a/src/a.py', 'def a():\n    return 1\n');

    const fixture = createContext(databasePath);
    try {
        await fixture.context.indexCodebase(root);
        const initial = fixture.context.getCurrentPublication(root);
        assert.ok(initial);
        const initialOwnership = fixture.context.getPublicationPackageOwnership(initial);
        assert.ok(initialOwnership);
        assert.equal(ownerFor(initialOwnership, 'packages/a/src/a.py'), 'packages/a');
        assert.equal(
            initialOwnership.files.some((entry) => entry.path === 'packages/a/package.json'),
            false,
        );

        writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'other/**'\n");
        await fixture.context.reindexByChange(root);

        const removed = fixture.context.getCurrentPublication(root);
        assert.ok(removed);
        assert.notEqual(removed.id, initial.id);
        const removedOwnership = fixture.context.getPublicationPackageOwnership(removed);
        assert.ok(removedOwnership);
        assert.equal(
            removedOwnership.packages.some((entry) => entry.root === 'packages/a'),
            false,
        );
        assert.equal(ownerFor(removedOwnership, 'packages/a/src/a.py'), null);
        assert.equal(
            ownerFor(removedOwnership, 'packages/a/package.json'),
            null,
        );

        writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
        await fixture.context.reindexByChange(root);

        const restored = fixture.context.getCurrentPublication(root);
        assert.ok(restored);
        assert.notEqual(restored.id, removed.id);
        const restoredOwnership = fixture.context.getPublicationPackageOwnership(restored);
        assert.ok(restoredOwnership);
        assert.equal(
            restoredOwnership.packages.find((entry) => entry.root === 'packages/a')?.name,
            '@fixture/a',
        );
        assert.equal(ownerFor(restoredOwnership, 'packages/a/src/a.py'), 'packages/a');
        assert.equal(
            restoredOwnership.files.some((entry) => entry.path === 'packages/a/package.json'),
            false,
        );
    } finally {
        await fixture.context.dispose();
        await fixture.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('read admission rejects semantically corrupt or unbound package ownership sidecars', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-corruption-'));
    const root = path.join(tempRoot, 'repo');
    const databasePath = path.join(tempRoot, 'vectors');

    writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
    writeFile(root, 'package.json', JSON.stringify({ name: '@fixture/root' }));
    writeFile(root, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a' }));
    writeFile(root, 'packages/a/plugins/b/package.json', JSON.stringify({ name: '@fixture/b' }));
    writeFile(root, 'root.py', 'def root():\n    return 1\n');
    writeFile(root, 'packages/a/a.py', 'def a():\n    return 1\n');
    writeFile(root, 'packages/a/plugins/b/b.py', 'def b():\n    return 1\n');

    const fixture = createContext(databasePath);
    try {
        await fixture.context.indexCodebase(root);
        const current = fixture.context.getCurrentPublication(root);
        assert.ok(current);
        assert.equal(
            (await fixture.context.getCurrentPublicationForValidation(root)).status,
            'valid',
        );

        const ownershipPath = path.join(
            resolvePublicationGenerationRoot(root, current.id),
            'ownership.json',
        );
        const originalSource = fs.readFileSync(ownershipPath, 'utf8');
        const original = JSON.parse(originalSource) as {
            packages: Array<{
                root: string;
                manifestPath: string;
                name: string | null;
                workspaceMember: boolean;
            }>;
            files: Array<{
                path: string;
                packageRoot: string | null;
            }>;
            controlFiles: Array<[string, string]>;
        };

        const expectRequiresReindex = async (mutate: (value: typeof original) => void) => {
            const corrupted = structuredClone(original);
            mutate(corrupted);
            fs.writeFileSync(ownershipPath, JSON.stringify(corrupted, null, 2) + '\n');
            assert.equal(
                (await fixture.context.getCurrentPublicationForValidation(root)).status,
                'requires_reindex',
            );
            fs.writeFileSync(ownershipPath, originalSource);
        };

        await expectRequiresReindex((corrupted) => {
            const file = corrupted.files.find((entry) => entry.path === 'root.py');
            assert.ok(file);
            file.packageRoot = null;
        });

        await expectRequiresReindex((corrupted) => {
            const file = corrupted.files.find(
                (entry) => entry.path === 'packages/a/plugins/b/b.py',
            );
            assert.ok(file);
            file.packageRoot = 'packages/a';
        });

        await expectRequiresReindex((corrupted) => {
            const pkg = corrupted.packages.find((entry) => entry.root === 'packages/a/plugins/b');
            assert.ok(pkg);
            pkg.manifestPath = 'packages/a/package.json';
        });

        await expectRequiresReindex((corrupted) => {
            corrupted.files = corrupted.files.filter((entry) => entry.path !== 'root.py');
        });

        await expectRequiresReindex((corrupted) => {
            const rootPackage = corrupted.packages.find((entry) => entry.root === '');
            assert.ok(rootPackage);
            rootPackage.name = 'forged-name';
        });

        await expectRequiresReindex((corrupted) => {
            corrupted.packages = corrupted.packages.filter(
                (entry) => entry.root !== 'packages/a/plugins/b',
            );
            corrupted.controlFiles = corrupted.controlFiles.filter(
                ([filePath]) => filePath !== 'packages/a/plugins/b/package.json',
            );
            const file = corrupted.files.find(
                (entry) => entry.path === 'packages/a/plugins/b/b.py',
            );
            assert.ok(file);
            file.packageRoot = 'packages/a';
        });

        fs.unlinkSync(ownershipPath);
        assert.equal(
            (await fixture.context.getCurrentPublicationForValidation(root)).status,
            'requires_reindex',
        );
        fs.writeFileSync(ownershipPath, originalSource);

        fs.writeFileSync(ownershipPath, '{ malformed');
        assert.equal(
            (await fixture.context.getCurrentPublicationForValidation(root)).status,
            'requires_reindex',
        );
        fs.writeFileSync(ownershipPath, originalSource);

        assert.equal(
            (await fixture.context.getCurrentPublicationForValidation(root)).status,
            'valid',
        );
    } finally {
        await fixture.context.dispose();
        await fixture.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('partial Publication ownership is sealed to its exact indexed file identity', async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-partial-integrity-'));
    const root = path.join(tempRoot, 'repo');
    const databasePath = path.join(tempRoot, 'vectors');

    writeFile(root, 'package.json', JSON.stringify({ name: '@fixture/root' }));
    writeFile(root, 'a.py', 'def a():\n    return 1\n');
    writeFile(root, 'b.py', 'def b():\n    return 2\n');

    const fixture = createContext(databasePath);
    try {
        const processFileList = IndexingPipeline.prototype.processFileList;
        const partialPipeline = t.mock.method(
            IndexingPipeline.prototype,
            'processFileList',
            async function (this: IndexingPipeline, input: Parameters<typeof processFileList>[0]) {
                const result = await processFileList.call(this, input);
                return {
                    ...result,
                    status: 'limit_reached' as const,
                    processedFiles: 1,
                };
            },
        );
        await fixture.context.indexCodebase(root);
        partialPipeline.mock.restore();

        const current = fixture.context.getCurrentPublication(root);
        assert.ok(current);
        assert.equal(current.publication.status, 'partial');
        const ownership = fixture.context.getPublicationPackageOwnership(current);
        assert.ok(ownership);
        assert.equal(ownership.files.length, 1);

        const ownershipPath = path.join(
            resolvePublicationGenerationRoot(root, current.id),
            'ownership.json',
        );
        const corrupted = JSON.parse(fs.readFileSync(ownershipPath, 'utf8')) as {
            files: Array<{ path: string; packageRoot: string | null }>;
        };
        const originalPath = corrupted.files[0]?.path;
        assert.ok(originalPath === 'a.py' || originalPath === 'b.py');
        corrupted.files[0].path = originalPath === 'a.py' ? 'b.py' : 'a.py';
        fs.writeFileSync(ownershipPath, JSON.stringify(corrupted, null, 2) + '\n');

        assert.deepEqual(
            await fixture.context.getCurrentPublicationForValidation(root),
            { status: 'requires_reindex' },
        );
    } finally {
        await fixture.context.dispose();
        await fixture.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('a Publication from the previous index format is rejected as requiring reindex', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-compat-'));
    const root = path.join(tempRoot, 'repo');
    const databasePath = path.join(tempRoot, 'vectors');

    writeFile(root, 'package.json', JSON.stringify({ name: '@fixture/root' }));
    writeFile(root, 'src/main.py', 'def main():\n    return 1\n');

    const fixture = createContext(databasePath);
    try {
        await fixture.context.indexCodebase(root);
        const current = fixture.context.getCurrentPublication(root);
        assert.ok(current);

        const descriptorPath = path.join(
            resolvePublicationGenerationRoot(root, current.id),
            'publication.json',
        );
        const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) as {
            format: { indexFormatVersion: string };
        };
        const previousFormat = JSON.parse(descriptor.format.indexFormatVersion) as Record<string, unknown>;
        delete previousFormat.packageOwnershipVersion;
        descriptor.format.indexFormatVersion = JSON.stringify(previousFormat);
        fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n');

        assert.deepEqual(
            await fixture.context.getCurrentPublicationForValidation(root),
            { status: 'requires_reindex' },
        );
    } finally {
        await fixture.context.dispose();
        await fixture.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
