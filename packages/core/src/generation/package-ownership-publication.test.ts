import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Context } from '../core/context';
import { IndexingPipeline } from '../core/indexing-pipeline';
import { JsonNavigationStore } from '../navigation/store';
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

function createContext(databasePath: string, navigationStore?: JsonNavigationStore) {
    const database = new LanceDbVectorDatabase({ databasePath });
    const context = new Context({
        embedding: new FixtureEmbedding(),
        vectorDatabase: database,
        ...(navigationStore ? { navigationStore } : {}),
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

test('warm publication admission reuses parsed navigation across validation reads', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-admission-'));
    const root = path.join(tempRoot, 'repo');
    writeFile(root, 'main.py', 'def main():\n    return 1\n');
    const navigationStore = new JsonNavigationStore();
    const fixture = createContext(path.join(tempRoot, 'vectors'), navigationStore);
    try {
        await fixture.context.indexCodebase(root);
        const publication = fixture.context.getCurrentPublication(root);
        assert.ok(publication);
        assert.equal(await fixture.context.getPublicationNavigationStatus(publication), 'valid');
        const navigationRoot = fixture.context.getPublicationNavigationAddress(publication)?.navigationRoot;
        assert.ok(navigationRoot);

        const originalReadFile = fs.promises.readFile;
        const navigationReads: string[] = [];
        Object.defineProperty(fs.promises, 'readFile', {
            configurable: true,
            value: (...args: unknown[]) => {
                if (String(args[0]).startsWith(navigationRoot)) navigationReads.push(String(args[0]));
                return Reflect.apply(originalReadFile, fs.promises, args);
            },
        });
        try {
            assert.equal(await fixture.context.isPublicationReadAdmitted(publication), true);
            assert.equal(await fixture.context.getPublicationNavigationStatus(publication), 'valid');
            assert.equal(await fixture.context.isPublicationReadAdmitted(publication), true);
            assert.equal(navigationReads.length, 0);
        } finally {
            Object.defineProperty(fs.promises, 'readFile', { configurable: true, value: originalReadFile });
        }

        const relationshipManifestPath = path.join(navigationRoot, 'relationships', 'manifest.json');
        const originalManifest = fs.readFileSync(relationshipManifestPath, 'utf8');
        fs.writeFileSync(relationshipManifestPath, '{ malformed');
        const coldFixture = createContext(path.join(tempRoot, 'vectors'), new JsonNavigationStore());
        try {
            const coldPublication = coldFixture.context.getCurrentPublication(root);
            assert.ok(coldPublication);
            assert.equal(await coldFixture.context.getPublicationNavigationStatus(coldPublication), 'corrupt');
        } finally {
            await coldFixture.context.dispose();
            await coldFixture.database.close();
            fs.writeFileSync(relationshipManifestPath, originalManifest);
        }
    } finally {
        await fixture.context.dispose();
        await fixture.database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

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

test('read admission requires reindex when the package ownership sidecar is missing or malformed', async () => {
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

        // Descriptors written before format v2 recorded ownership as a digest object.
        const descriptorPath = path.join(resolvePublicationGenerationRoot(root, current.id), 'publication.json');
        const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
        fs.writeFileSync(descriptorPath, JSON.stringify({
            ...descriptor,
            version: 1,
            packageOwnership: { digest: 'legacy-digest' },
        }));
        assert.equal(fixture.context.getCurrentPublication(root)?.publication.packageOwnership, true);
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

class FailingEmbedding extends FixtureEmbedding {
    private calls = 0;
    override async embedDocuments(texts: string[]) {
        this.calls += 1;
        if (this.calls === 2) {
            // Fail while the caller has moved on to navigation work.
            await new Promise((resolve) => setTimeout(resolve, 50));
            throw new Error('fixture embedding failure');
        }
        return super.embedDocuments(texts);
    }
}

test('an embedding failure while navigation runs fails the index without publishing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-payload-failure-'));
    const root = path.join(tempRoot, 'repo');
    for (let index = 0; index < 40; index++) {
        writeFile(root, `src/file${index}.py`, `def f${index}():\n    return ${index}\n`);
    }
    const database = new LanceDbVectorDatabase({ databasePath: path.join(tempRoot, 'vectors') });
    const context = new Context({
        embedding: new FailingEmbedding(),
        vectorDatabase: database,
        semanticAnalyzer: {
            supportsLanguage: () => false,
            analyze: async (input) => ({ language: input.language, occurrencesByFile: new Map() }),
        },
    });
    const previousBatchSize = process.env.EMBEDDING_BATCH_SIZE;
    process.env.EMBEDDING_BATCH_SIZE = '4';
    try {
        await assert.rejects(context.indexCodebase(root), /fixture embedding failure/);
        assert.equal(context.getCurrentPublication(root) ?? null, null);
    } finally {
        if (previousBatchSize === undefined) delete process.env.EMBEDDING_BATCH_SIZE;
        else process.env.EMBEDDING_BATCH_SIZE = previousBatchSize;
        await context.dispose();
        await database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

class GatedEmbedding extends FixtureEmbedding {
    inFlight = 0;
    private gate: Promise<void> | undefined;
    private releaseGate: () => void = () => undefined;

    block() { this.gate = new Promise((resolve) => { this.releaseGate = resolve; }); }
    release() { this.releaseGate(); }

    override getBatchPolicy() {
        return { preferredMaxItems: 4, hardMaxItems: 4, hardTokenLimit: 200 };
    }

    override async embedDocuments(texts: string[]) {
        this.inFlight += 1;
        try {
            await this.gate;
            return await super.embedDocuments(texts);
        } finally {
            this.inFlight -= 1;
        }
    }
}

/**
 * Blocks embeddings until the file loop has failed, and records how many were
 * in flight when processFileList settled. The gate opens on the next
 * macrotask, after every microtask of the failing call has run, so a pipeline
 * that rejects without draining is observed with work in flight.
 */
function observeFailedFileLoop(embedding: GatedEmbedding) {
    embedding.block();
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
        if (String(args[0]).includes('Failed to index file')) setImmediate(() => embedding.release());
        originalConsoleError(...args);
    };
    const originalProcessFileList = IndexingPipeline.prototype.processFileList;
    const observed: { inFlightWhenSettled?: number } = {};
    IndexingPipeline.prototype.processFileList = function (...args) {
        return originalProcessFileList.apply(this, args).finally(() => {
            observed.inFlightWhenSettled = embedding.inFlight;
        });
    };
    return {
        observed,
        restore() {
            IndexingPipeline.prototype.processFileList = originalProcessFileList;
            console.error = originalConsoleError;
            embedding.release();
        },
    };
}

function writeSmallPythonFiles(root: string, prefix: string, count: number): void {
    for (let index = 0; index < count; index++) {
        writeFile(root, `src/${prefix}${index}.py`, `def ${prefix}${index}():\n    return ${index}\n`);
    }
}

// Sorted last; its single chunk exceeds the provider hard token limit.
function writeOversizedPythonFile(root: string): void {
    writeFile(root, 'src/zz_large.py', `def big():\n    return "${'x'.repeat(1500)}"\n`);
}

function createGatedContext(tempRoot: string) {
    const embedding = new GatedEmbedding();
    const database = new LanceDbVectorDatabase({ databasePath: path.join(tempRoot, 'vectors') });
    const context = new Context({
        embedding,
        vectorDatabase: database,
        semanticAnalyzer: {
            supportsLanguage: () => false,
            analyze: async (input) => ({ language: input.language, occurrencesByFile: new Map() }),
        },
    });
    return { embedding, database, context };
}

test('a file failure while embedding is in flight fails the index only after the payload stops', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-loop-failure-'));
    const root = path.join(tempRoot, 'repo');
    writeSmallPythonFiles(root, 'file', 8);
    writeOversizedPythonFile(root);
    const { embedding, database, context } = createGatedContext(tempRoot);
    const failure = observeFailedFileLoop(embedding);
    try {
        await assert.rejects(context.indexCodebase(root), /exceeding the provider hard limit/);
        assert.equal(failure.observed.inFlightWhenSettled, 0);
        assert.equal(context.getCurrentPublication(root) ?? null, null);
    } finally {
        failure.restore();
        await context.dispose();
        await database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('a file failure while delta embedding is in flight fails the sync only after the payload stops', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-delta-failure-'));
    const root = path.join(tempRoot, 'repo');
    writeSmallPythonFiles(root, 'file', 8);
    const { embedding, database, context } = createGatedContext(tempRoot);
    let failure: ReturnType<typeof observeFailedFileLoop> | undefined;
    try {
        await context.indexCodebase(root);
        const published = context.getCurrentPublication(root);
        assert.ok(published);

        writeSmallPythonFiles(root, 'added', 8);
        writeOversizedPythonFile(root);
        let forks = 0;
        const forkCollection = database.forkCollection.bind(database);
        database.forkCollection = async (...args) => {
            forks += 1;
            return forkCollection(...args);
        };
        failure = observeFailedFileLoop(embedding);
        await assert.rejects(context.reindexByChange(root), /exceeding the provider hard limit/);
        assert.equal(forks, 1, 'expected the atomic delta path');
        assert.equal(failure.observed.inFlightWhenSettled, 0);
        assert.deepEqual(context.getCurrentPublication(root), published);
    } finally {
        failure?.restore();
        await context.dispose();
        await database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
