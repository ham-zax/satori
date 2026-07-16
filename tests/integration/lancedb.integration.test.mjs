import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const {
    Context,
    EMBEDDING_NORMALIZATION_POLICY_VERSION,
} = require('../../packages/core/dist/index.js');
const { LanceDbVectorDatabase } = require('../../packages/core/dist/lancedb.js');
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const builtCorePath = path.join(repositoryRoot, 'packages/core/dist/index.js');

class IntegrationEmbedding {
    config = { model: 'integration-embedding-v1' };

    async detectDimension() {
        return 2;
    }

    embedText(text) {
        const lower = text.toLowerCase();
        return {
            vector: [lower.includes('auth') ? 1 : 0.25, Math.min(1, lower.length / 1000)],
            dimension: 2,
        };
    }

    async embedQuery(text) {
        return this.embedText(text);
    }

    async embedDocuments(texts) {
        return texts.map((text) => this.embedText(text));
    }

    getDimension() {
        return 2;
    }

    getProvider() {
        return 'IntegrationEmbedding';
    }

    getIdentity() {
        return Object.freeze({
            provider: this.getProvider(),
            model: this.config.model,
            dimension: this.getDimension(),
            artifactDigest: null,
            normalizationPolicy: EMBEDDING_NORMALIZATION_POLICY_VERSION,
        });
    }
}

test('built Core LanceDB adapter is visible from a fresh Node process', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-built-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const collectionName = 'hybrid_code_chunks_built__gen_current';
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());

    await database.createHybridCollection(collectionName, 2, undefined, { deferIndexBuild: true });
    await database.writeDocuments(collectionName, [{
        document: {
            id: 'built-document',
            vector: [1, 0],
            content: 'export const built = true;',
            relativePath: 'src/built.ts',
            startLine: 1,
            endLine: 1,
            fileExtension: '.ts',
            metadata: { language: 'typescript' },
        },
        projections: {
            embeddingText: 'built document embedding',
            lexicalText: 'builtprocessprobe',
            embeddingVersion: 'embedding_projection_v1',
            lexicalVersion: 'lexical_projection_v1',
        },
    }]);
    await database.finalizeCollectionForSearch(collectionName);
    await database.insertControl(collectionName, {
        id: 'built-control',
        kind: 'publication_probe',
        metadata: { owner: 'integration' },
    });

    const childScript = `
        const { LanceDbVectorDatabase } = require(${JSON.stringify(path.join(path.dirname(builtCorePath), "lancedb.js"))});
        (async () => {
            const database = new LanceDbVectorDatabase({ databasePath: process.env.SATORI_TEST_LANCEDB_PATH });
            const collection = process.env.SATORI_TEST_LANCEDB_COLLECTION;
            const lexical = await database.retrieveLexical(collection, { query: 'builtprocessprobe', limit: 5 });
            const control = await database.getControl(collection, 'built-control');
            await database.close();
            process.stdout.write(JSON.stringify({ ids: lexical.map((entry) => entry.document.id), control }));
        })().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    const child = await execFileAsync(process.execPath, ['--eval', childScript], {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            SATORI_TEST_LANCEDB_PATH: databasePath,
            SATORI_TEST_LANCEDB_COLLECTION: collectionName,
        },
    });

    assert.deepEqual(JSON.parse(child.stdout), {
        ids: ['built-document'],
        control: {
            id: 'built-control',
            kind: 'publication_probe',
            metadata: { owner: 'integration' },
        },
    });
});

test('Core publishes and reopens a LanceDB-backed hybrid generation', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-context-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repositoryPath = path.join(root, 'repo');
    const databasePath = path.join(root, 'database');
    fs.mkdirSync(repositoryPath, { recursive: true });
    fs.writeFileSync(
        path.join(repositoryPath, 'auth.ts'),
        'export function authenticate(token: string): boolean { return token.length > 0; }',
        'utf8',
    );
    const previousHybridMode = process.env.HYBRID_MODE;
    process.env.HYBRID_MODE = 'true';
    t.after(() => {
        if (previousHybridMode === undefined) delete process.env.HYBRID_MODE;
        else process.env.HYBRID_MODE = previousHybridMode;
    });

    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());
    const context = new Context({
        embedding: new IntegrationEmbedding(),
        vectorDatabase: database,
        vectorStoreProvider: 'LanceDB',
        symbolRegistryStateRoot: path.join(root, 'navigation'),
        indexPolicyStateRoot: path.join(root, 'policy'),
    });

    const stats = await context.indexCodebase(repositoryPath, undefined, true);
    assert.ok(stats.totalChunks > 0);
    const collectionName = await context.getActiveIndexedCollectionName(repositoryPath);
    assert.ok(collectionName);
    const marker = await context.getIndexCompletionMarker(repositoryPath);
    assert.equal(marker?.fingerprint.vectorStoreProvider, 'LanceDB');

    const results = await context.semanticSearch({
        codebasePath: repositoryPath,
        query: 'authenticate auth token',
        topK: 5,
        retrievalMode: 'hybrid',
        scorePolicy: { kind: 'topk_only' },
    });
    assert.ok(results.some((result) => result.relativePath === 'auth.ts'));

    await database.close();
    const reopenedDatabase = new LanceDbVectorDatabase({ databasePath });
    t.after(() => reopenedDatabase.close());
    const reopenedContext = new Context({
        embedding: new IntegrationEmbedding(),
        vectorDatabase: reopenedDatabase,
        vectorStoreProvider: 'LanceDB',
        symbolRegistryStateRoot: path.join(root, 'navigation'),
        indexPolicyStateRoot: path.join(root, 'policy'),
    });
    assert.equal(
        await reopenedContext.getActiveIndexedCollectionName(repositoryPath),
        collectionName,
    );
});
