import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Context } from '../core/context';
import { IndexingPipeline, MAX_INDEXED_SOURCE_BYTES_PER_PUBLICATION } from '../core/indexing-pipeline';
import { Embedding, EMBEDDING_NORMALIZATION_POLICY_VERSION } from '../embedding';
import { LanceDbVectorDatabase } from '../vectordb/lancedb-vectordb';
import { DefaultSemanticLanguageRegistry } from '../semantic/descriptor';
import { readSymbolRegistrySidecar } from '../symbols';
import { FileSynchronizer } from '../sync/synchronizer';

class FixtureEmbedding extends Embedding {
    protected maxTokens = 8192;
    getDimension() { return 4; }
    getProvider() { return 'fixture'; }
    getIdentity() {
        return { provider: 'fixture', model: 'fixture', dimension: 4, artifactDigest: null, normalizationPolicy: EMBEDDING_NORMALIZATION_POLICY_VERSION };
    }
    async detectDimension() { return 4; }
    async embedQuery() { return { vector: [1, 0, 0, 0], dimension: 4 }; }
    async embedDocuments(texts: string[]) { return Promise.all(texts.map(() => this.embedQuery())); }
}

async function createFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-aux-publication-'));
    const root = path.join(tempRoot, 'repo');
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib.rs'), 'pub fn run() -> i32 { 1 }\n');
    fs.writeFileSync(path.join(root, 'settings.toml'), 'enabled = true\n');
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(root, 'nested/Cargo.toml'), '[package]\nname = "nested"\nversion = "0.1.0"\n');
    const database = new LanceDbVectorDatabase({ databasePath: path.join(tempRoot, 'vectors') });
    const semanticCalls: string[][] = [];
    const context = new Context({
        embedding: new FixtureEmbedding(),
        vectorDatabase: database,
        supportedExtensions: ['.rs', '.toml'],
        semanticAnalyzer: {
            supportsLanguage: (language) => language === 'rust',
            analyze: async (input) => {
                semanticCalls.push((input.auxiliaryFiles ?? []).map((file) => file.path).sort());
                return { language: input.language, occurrencesByFile: new Map() };
            },
        },
    });
    return {
        root, context, database, semanticCalls,
        async close() {
            await context.dispose();
            await database.close();
            fs.rmSync(tempRoot, { recursive: true, force: true });
        },
    };
}

async function assertSearchablePublication(fixture: Awaited<ReturnType<typeof createFixture>>) {
    const { root, context, database } = fixture;
    const current = context.getCurrentPublication(root);
    assert.ok(current);
    assert.equal(current.publication.status, 'complete');
    assert.equal(current.publication.vector.indexedFiles, 2);
    const checkpoint = context.getPublicationSourceCheckpoint(current);
    assert.ok(checkpoint);
    const expectedSources = ['Cargo.toml', 'lib.rs', 'nested/Cargo.toml', 'settings.toml']
        .filter((file) => fs.existsSync(path.join(root, file)));
    assert.deepEqual(checkpoint.fileHashes.map(([file]) => file).sort(), expectedSources.sort());
    for (const [file, hash] of checkpoint.fileHashes) {
        assert.equal(hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'));
    }
    const navigation = context.getPublicationNavigationAddress(current);
    assert.ok(navigation);
    const registry = await readSymbolRegistrySidecar({ normalizedRootPath: root, ...navigation });
    assert.equal(registry.status, 'ok');
    if (registry.status !== 'ok') throw new Error('Missing navigation');
    assert.deepEqual(registry.registry.manifest.files.map((file) => file.path), ['lib.rs', 'settings.toml']);
    for (const relativePath of ['Cargo.toml', 'nested/Cargo.toml']) {
        assert.equal(await database.countDocuments(current.publication.vector.collectionName, {
            kind: 'comparison', field: 'relativePath', operator: 'eq', value: relativePath,
        }), 0);
    }
    assert.equal(await database.countDocuments(current.publication.vector.collectionName), current.publication.vector.totalChunks);
    return current;
}

test('Cargo.toml modification publishes on a quiet tree with .toml enabled', async () => {
    const fixture = await createFixture();
    try {
        await fixture.context.indexCodebase(fixture.root);
        const previous = fixture.context.getCurrentPublication(fixture.root);
        fs.appendFileSync(path.join(fixture.root, 'Cargo.toml'), 'edition = "2021"\n');
        await fixture.context.reindexByChange(fixture.root);
        const current = await assertSearchablePublication(fixture);
        assert.notEqual(current.id, previous?.id);
        assert.equal(fixture.semanticCalls.length, 2);
        assert.deepEqual(fixture.semanticCalls[1], ['Cargo.toml', 'nested/Cargo.toml']);
    } finally {
        await fixture.close();
    }
});

test('Full indexing excludes Cargo manifests while auxiliary removal and addition rebuild semantics', async () => {
    const fixture = await createFixture();
    try {
        await fixture.context.indexCodebase(fixture.root);
        await assertSearchablePublication(fixture);
        fs.unlinkSync(path.join(fixture.root, 'nested/Cargo.toml'));
        await fixture.context.reindexByChange(fixture.root);
        await assertSearchablePublication(fixture);
        assert.deepEqual(fixture.semanticCalls.at(-1), ['Cargo.toml']);
        fs.writeFileSync(path.join(fixture.root, 'nested/Cargo.toml'), '[package]\nname = "restored"\n');
        await fixture.context.reindexByChange(fixture.root);
        const current = await assertSearchablePublication(fixture);
        assert.deepEqual(fixture.semanticCalls.at(-1), ['Cargo.toml', 'nested/Cargo.toml']);
        await fixture.context.reindexByChange(fixture.root);
        assert.equal(fixture.context.getCurrentPublication(fixture.root)?.id, current.id);
    } finally {
        await fixture.close();
    }
});

for (const changeSource of [false, true]) {
    test(`Incremental sync removes unchanged legacy Cargo documents (source changed: ${changeSource})`, async (t) => {
        const fixture = await createFixture();
        try {
            // Seed a coherent legacy Publication using the former searchable classification.
            const legacyClassification = t.mock.method(DefaultSemanticLanguageRegistry.prototype, 'isAuxiliaryPath', () => false);
            await fixture.context.indexCodebase(fixture.root);
            legacyClassification.mock.restore();
            const previous = fixture.context.getCurrentPublication(fixture.root);
            assert.equal(previous?.publication.vector.indexedFiles, 4);
            if (changeSource) fs.appendFileSync(path.join(fixture.root, 'lib.rs'), 'pub fn extra() {}\n');
            await fixture.context.reindexByChange(fixture.root);
            const current = await assertSearchablePublication(fixture);
            assert.notEqual(current.id, previous?.id);
        } finally {
            await fixture.close();
        }
    });
}

test('Quiet partial Publication retains its checkpoint without attempting atomic sync', async (t) => {
    const fixture = await createFixture();
    try {
        const processFileList = IndexingPipeline.prototype.processFileList;
        // Model the pipeline stopping inside its last file: observed files exceed completed files.
        const partialPipeline = t.mock.method(IndexingPipeline.prototype, 'processFileList', async function (
            this: IndexingPipeline, input: Parameters<typeof processFileList>[0],
        ) {
            const result = await processFileList.call(this, input);
            return { ...result, status: 'limit_reached' as const, processedFiles: result.processedFiles - 1 };
        });
        await fixture.context.indexCodebase(fixture.root);
        partialPipeline.mock.restore();
        const previous = fixture.context.getCurrentPublication(fixture.root);
        assert.equal(previous?.publication.status, 'partial');
        assert.equal(previous.publication.navigation, null);
        const result = await fixture.context.reindexByChange(fixture.root);
        assert.equal(result.indexStatus, 'limit_reached');
        assert.deepEqual(result.changedFiles, []);
        assert.equal(result.indexedFiles, previous.publication.vector.indexedFiles);
        assert.equal(fixture.context.getCurrentPublication(fixture.root)?.id, previous.id);
    } finally {
        await fixture.close();
    }
});

test('Full and incremental semantic inputs use the checkpoint ignore policy', async () => {
    const fixture = await createFixture();
    try {
        fs.writeFileSync(path.join(fixture.root, '.gitignore'), 'vendor/\nnested/Cargo.toml\n');
        fs.writeFileSync(path.join(fixture.root, '.satoriignore'), 'private/\n');
        for (const directory of ['vendor', 'private']) {
            fs.mkdirSync(path.join(fixture.root, directory));
            fs.writeFileSync(path.join(fixture.root, directory, 'Cargo.toml'), '[package]\nname = "ignored"\n');
        }
        await fixture.context.indexCodebase(fixture.root);
        const assertAuxiliaries = () => {
            const current = fixture.context.getCurrentPublication(fixture.root);
            assert.ok(current);
            const checkpoint = fixture.context.getPublicationSourceCheckpoint(current);
            assert.ok(checkpoint);
            const observedAuxiliaries = checkpoint.fileHashes.map(([file]) => file)
                .filter((file) => file.endsWith('Cargo.toml')).sort();
            assert.deepEqual(observedAuxiliaries, ['Cargo.toml']);
            assert.deepEqual(fixture.semanticCalls.at(-1), observedAuxiliaries);
        };
        assertAuxiliaries();
        fs.appendFileSync(path.join(fixture.root, 'lib.rs'), 'pub fn changed() {}\n');
        await fixture.context.reindexByChange(fixture.root);
        assertAuxiliaries();
        assert.equal(fixture.semanticCalls.length, 2);
    } finally {
        await fixture.close();
    }
});

test('Incremental sync refuses a complete candidate over the aggregate searchable source budget', async (t) => {
    const fixture = await createFixture();
    try {
        await fixture.context.indexCodebase(fixture.root);
        const previous = fixture.context.getCurrentPublication(fixture.root);
        assert.ok(previous);
        fs.appendFileSync(path.join(fixture.root, 'lib.rs'), 'pub fn added() {}\n');
        const prepareChanges = FileSynchronizer.prototype.prepareChanges;
        t.mock.method(FileSynchronizer.prototype, 'prepareChanges', async function (
            this: FileSynchronizer, options: Parameters<typeof prepareChanges>[0],
        ) {
            const prepared = await prepareChanges.call(this, options);
            return {
                ...prepared,
                sourceCheckpoint: {
                    ...prepared.sourceCheckpoint,
                    fileStats: prepared.sourceCheckpoint.fileStats.map(([filePath, stat]) => [
                        filePath,
                        { ...stat, size: filePath === 'lib.rs' ? MAX_INDEXED_SOURCE_BYTES_PER_PUBLICATION : stat.size },
                    ]),
                },
            };
        });
        await assert.rejects(fixture.context.reindexByChange(fixture.root), /searchable source byte resource limit/);
        assert.equal(fixture.context.getCurrentPublication(fixture.root)?.id, previous.id);
    } finally {
        await fixture.close();
    }
});
