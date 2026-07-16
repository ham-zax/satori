import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { connect } from '@lancedb/lancedb';

import { LanceDbVectorDatabase } from './lancedb-vectordb';
import type {
    IndexedVectorDocument,
    VectorControlRecord,
    VectorDocumentMetadata,
} from './types';

const execFileAsync = promisify(execFile);

function indexedDocument(input: {
    id: string;
    vector: number[];
    lexicalText: string;
    content?: string;
    relativePath?: string;
    metadata?: VectorDocumentMetadata;
}): IndexedVectorDocument {
    const content = input.content ?? `source ${input.id}`;
    return {
        document: {
            id: input.id,
            vector: input.vector,
            content,
            relativePath: input.relativePath ?? `src/${input.id}.ts`,
            startLine: 1,
            endLine: 2,
            fileExtension: '.ts',
            metadata: input.metadata ?? { language: 'typescript' },
        },
        projections: {
            embeddingText: `embedding ${input.id}\n${content}`,
            lexicalText: input.lexicalText,
            embeddingVersion: 'embedding_projection_v1',
            lexicalVersion: 'lexical_projection_v1',
        },
    };
}

async function tableVersion(databasePath: string, tableName: string): Promise<number> {
    const connection = await connect(databasePath, { readConsistencyInterval: 0 });
    const table = await connection.openTable(tableName);
    try {
        return await table.version();
    } finally {
        table.close();
        connection.close();
    }
}

function completionRecord(generation: string): VectorControlRecord {
    return {
        id: '__satori_index_completion_marker_v1__',
        kind: 'satori_index_completion_v2',
        metadata: {
            kind: 'satori_index_completion_v2',
            generation,
            fingerprint: { embeddingDimension: 2 },
        },
    };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
    const dot = left.reduce((total, value, index) => total + value * (right[index] ?? 0), 0);
    const leftMagnitude = Math.sqrt(left.reduce((total, value) => total + value * value, 0));
    const rightMagnitude = Math.sqrt(right.reduce((total, value) => total + value * value, 0));
    return dot / (leftMagnitude * rightMagnitude);
}

test('LanceDB adapter preserves exact retrieval, projections, controls, and idempotent writes', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-contract-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath, maxWriteBatchSize: 2 });
    t.after(() => database.close());

    const collectionName = 'hybrid_code_chunks_contract__gen_one';
    await database.createHybridCollection(collectionName, 2, undefined, { deferIndexBuild: true });
    const documents = [
        indexedDocument({ id: 'z', vector: [1, 0], lexicalText: 'shareduniqueterm z' }),
        indexedDocument({ id: 'a', vector: [1, 0], lexicalText: 'shareduniqueterm a' }),
        indexedDocument({ id: 'm', vector: [1, 0], lexicalText: 'shareduniqueterm m' }),
        indexedDocument({ id: 'b', vector: [0.8, 0.2], lexicalText: 'shareduniqueterm b' }),
        indexedDocument({
            id: 'unicode',
            vector: [0, 1],
            lexicalText: 'UnicodeProbe αβγ',
            content: 'const π = "你好";',
            relativePath: "src/O'Brien.ts' OR 1=1 --",
            metadata: {
                symbolLabel: 'π',
                nested: { z: 1, a: '你好' },
            },
        }),
    ];
    await database.writeDocuments(collectionName, documents);
    await database.finalizeCollectionForSearch(collectionName);

    const dense = await database.retrieveDense(collectionName, {
        vector: [1, 0],
        limit: 4,
    });
    const oracle = documents
        .map((indexed) => ({
            id: indexed.document.id,
            score: cosineSimilarity(
                Array.from(new Float32Array(indexed.document.vector)),
                [1, 0],
            ),
        }))
        .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .slice(0, 4);
    assert.deepEqual(dense.map((candidate) => candidate.document.id), oracle.map(({ id }) => id));
    dense.forEach((candidate, index) => {
        assert.ok(Math.abs(candidate.score - (oracle[index]?.score ?? Number.NaN)) < 1e-6);
    });

    const lexical = await database.retrieveLexical(collectionName, {
        query: 'shareduniqueterm',
        limit: 2,
    });
    assert.deepEqual(lexical.map((candidate) => candidate.document.id), ['a', 'b']);

    const injectedPathRows = await database.queryDocuments(collectionName, {
        filter: {
            kind: 'comparison',
            field: 'relativePath',
            operator: 'eq',
            value: "src/O'Brien.ts' OR 1=1 --",
        },
        fields: ['id', 'content', 'relativePath', 'metadata'],
    });
    assert.deepEqual(injectedPathRows, [{
        id: 'unicode',
        content: 'const π = "你好";',
        relativePath: "src/O'Brien.ts' OR 1=1 --",
        metadata: {
            nested: { a: '你好', z: 1 },
            symbolLabel: 'π',
        },
    }]);

    const firstVersion = await tableVersion(databasePath, collectionName);
    const reorderedMetadata = indexedDocument({
        id: 'unicode',
        vector: [0, 1],
        lexicalText: 'UnicodeProbe αβγ',
        content: 'const π = "你好";',
        relativePath: "src/O'Brien.ts' OR 1=1 --",
        metadata: {
            nested: { a: '你好', z: 1 },
            symbolLabel: 'π',
        },
    });
    await database.writeDocuments(collectionName, [...documents.slice(0, 4), reorderedMetadata]);
    assert.equal(await tableVersion(databasePath, collectionName), firstVersion);

    await database.writeDocuments(collectionName, [indexedDocument({
        id: 'b',
        vector: [0.8, 0.2],
        lexicalText: 'replacementuniqueterm b',
        content: 'replacement source b',
    })]);
    assert.deepEqual(
        (await database.retrieveLexical(collectionName, { query: 'shareduniqueterm', limit: 10 }))
            .map((candidate) => candidate.document.id),
        ['a', 'm', 'z'],
    );
    assert.deepEqual(
        (await database.retrieveLexical(collectionName, { query: 'replacementuniqueterm', limit: 10 }))
            .map((candidate) => candidate.document.id),
        ['b'],
    );

    const marker = completionRecord('one');
    await database.insertControl(collectionName, marker);
    assert.deepEqual(await database.getControl(collectionName, marker.id), marker);
    assert.equal(await database.countDocuments(collectionName), 5);
    assert.deepEqual(await database.listCollections(), [collectionName]);
    assert.equal(
        (await database.retrieveDense(collectionName, { vector: [1, 0], limit: 10 }))
            .some((candidate) => candidate.document.id === marker.id),
        false,
    );

    await database.deleteDocuments(collectionName, ['b']);
    assert.equal(await database.countDocuments(collectionName), 4);
    assert.deepEqual(
        await database.retrieveLexical(collectionName, { query: 'replacementuniqueterm', limit: 10 }),
        [],
    );
    await database.deleteControl(collectionName, marker.id);
    assert.equal(await database.getControl(collectionName, marker.id), null);
});

test('LanceDB control tables are family-scoped and generation drops remain fail-closed', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-controls-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());

    const first = 'hybrid_code_chunks_family__gen_first';
    const second = 'hybrid_code_chunks_family__gen_second';
    await database.createHybridCollection(first, 2, undefined, { deferIndexBuild: true });
    await database.createHybridCollection(second, 2, undefined, { deferIndexBuild: true });
    await database.insertControl(first, completionRecord('first'));
    await database.insertControl(second, completionRecord('second'));

    await database.dropCollection(first);
    assert.equal(await database.hasCollection(first), false);
    assert.equal(await database.getControl(first, '__satori_index_completion_marker_v1__'), null);
    assert.equal(
        (await database.getControl(second, '__satori_index_completion_marker_v1__'))?.metadata.generation,
        'second',
    );
    assert.deepEqual(await database.listCollections(), [second]);
});

test('LanceDB acknowledged writes and controls survive forced process termination', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-process-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());
    const collectionName = 'hybrid_code_chunks_process__gen_current';
    await database.createHybridCollection(collectionName, 2, undefined, { deferIndexBuild: true });
    await database.writeDocuments(collectionName, [
        indexedDocument({ id: 'parent', vector: [1, 0], lexicalText: 'parentuniqueterm' }),
    ]);
    await database.finalizeCollectionForSearch(collectionName);

    const adapterUrl = new URL('./lancedb-vectordb.ts', import.meta.url).href;
    const childScript = `
        import fs from 'node:fs';
        import { LanceDbVectorDatabase } from ${JSON.stringify(adapterUrl)};
        const database = new LanceDbVectorDatabase({ databasePath: process.env.SATORI_TEST_LANCEDB_PATH });
        const collectionName = process.env.SATORI_TEST_LANCEDB_COLLECTION;
        await database.writeDocuments(collectionName, [{
            document: {
                id: 'child', vector: [1, 0], content: 'child source',
                relativePath: 'src/child.ts', startLine: 1, endLine: 1,
                fileExtension: '.ts', metadata: { language: 'typescript' },
            },
            projections: {
                embeddingText: 'child embedding', lexicalText: 'childprocessterm',
                embeddingVersion: 'embedding_projection_v1', lexicalVersion: 'lexical_projection_v1',
            },
        }]);
        await database.insertControl(collectionName, {
            id: 'child-control', kind: 'process_ack', metadata: { owner: 'child' },
        });
        fs.writeSync(1, 'ACK');
        process.exit(0);
    `;
    let terminatedChild: unknown;
    try {
        await execFileAsync(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            childScript.replace(
                "process.exit(0);",
                "process.kill(process.pid, 'SIGKILL');",
            ),
        ], {
            cwd: path.resolve(import.meta.dirname, '../..'),
            env: {
                ...process.env,
                SATORI_TEST_LANCEDB_PATH: databasePath,
                SATORI_TEST_LANCEDB_COLLECTION: collectionName,
            },
        });
        assert.fail('Expected the child process to terminate by SIGKILL.');
    } catch (error) {
        terminatedChild = error;
    }
    assert.equal((terminatedChild as { signal?: unknown }).signal, 'SIGKILL');
    assert.equal((terminatedChild as { stdout?: unknown }).stdout, 'ACK');

    assert.deepEqual(
        (await database.retrieveLexical(collectionName, { query: 'childprocessterm', limit: 5 }))
            .map((candidate) => candidate.document.id),
        ['child'],
    );
    assert.deepEqual(await database.getControl(collectionName, 'child-control'), {
        id: 'child-control',
        kind: 'process_ack',
        metadata: { owner: 'child' },
    });

    await database.close();
    const reopened = new LanceDbVectorDatabase({ databasePath });
    t.after(() => reopened.close());
    assert.deepEqual(
        (await reopened.retrieveDense(collectionName, { vector: [1, 0], limit: 3 }))
            .map((candidate) => candidate.document.id),
        ['child', 'parent'],
    );
});

test('LanceDB rejects malformed dimensions, duplicate payloads, and inconsistent controls', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-invalid-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());
    const collectionName = 'hybrid_code_chunks_invalid';
    await database.createHybridCollection(collectionName, 2, undefined, { deferIndexBuild: true });

    await assert.rejects(
        database.writeDocuments(collectionName, [
            indexedDocument({ id: 'same', vector: [1, 0], lexicalText: 'one' }),
            indexedDocument({ id: 'same', vector: [0, 1], lexicalText: 'two' }),
        ]),
        /conflicting rows/,
    );
    await assert.rejects(
        database.writeDocuments(collectionName, [
            indexedDocument({ id: 'wrong-size', vector: [1, 0, 0], lexicalText: 'wrong' }),
        ]),
        /dimension does not match/,
    );
    await assert.rejects(
        database.retrieveDense(collectionName, { vector: [1, 0, 0], limit: 1 }),
        /dimension does not match/,
    );
    await assert.rejects(
        database.insertControl(collectionName, {
            id: 'bad-kind',
            kind: 'outer',
            metadata: { kind: 'inner' },
        }).then(() => database.getControl(collectionName, 'bad-kind')),
        /inconsistent kind fields/,
    );
});
