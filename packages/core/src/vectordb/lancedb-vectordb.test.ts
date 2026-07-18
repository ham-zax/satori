import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
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

type PhysicalFileSnapshot = Readonly<{
    hash: string;
    inode: bigint;
}>;

async function snapshotPhysicalFiles(rootPath: string): Promise<Map<string, PhysicalFileSnapshot>> {
    const snapshot = new Map<string, PhysicalFileSnapshot>();
    const visit = async (directory: string, relativeRoot = ''): Promise<void> => {
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const entryPath = path.join(directory, entry.name);
            const relativePath = path.join(relativeRoot, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath, relativePath);
            } else if (entry.isFile()) {
                const [bytes, stat] = await Promise.all([
                    fs.promises.readFile(entryPath),
                    fs.promises.stat(entryPath, { bigint: true }),
                ]);
                snapshot.set(relativePath, {
                    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
                    inode: stat.ino,
                });
            }
        }
    };
    await visit(rootPath);
    return snapshot;
}

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

    const preciseLexical = await database.retrieveLexical(collectionName, {
        query: 'shareduniqueterm UnicodeProbe',
        limit: 2,
        matchMode: 'all_terms',
    });
    const fallbackLexical = await database.retrieveLexical(collectionName, {
        query: 'shareduniqueterm UnicodeProbe',
        limit: 2,
        matchMode: 'any_terms',
    });
    assert.deepEqual(preciseLexical, []);
    assert.equal(fallbackLexical.length, 2);
    assert.ok(fallbackLexical.some((candidate) => candidate.document.id === 'unicode'));

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

test('LanceDB publication observation changes for payload marker and collection mutations', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-observation-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());
    const collectionName = 'publication_observation';

    await database.createHybridCollection(collectionName, 2, undefined, { deferIndexBuild: true });
    await database.writeDocuments(collectionName, [
        indexedDocument({ id: 'first', vector: [1, 0], lexicalText: 'first' }),
    ]);
    const initialData = await database.getCollectionDataObservation(collectionName);
    assert.match(initialData ?? '', /^[a-f0-9]{64}$/);
    assert.equal(await database.getPublicationObservation(collectionName), null);

    const marker = completionRecord('observation');
    await database.insertControl(collectionName, marker);
    const initial = await database.getPublicationObservation(collectionName);
    assert.equal(await database.getCollectionDataObservation(collectionName), initialData);
    const controlName = `__satori_control_${crypto.createHash('sha256').update(collectionName).digest('hex')}`;
    const initialVersions = await Promise.all([
        tableVersion(databasePath, collectionName),
        tableVersion(databasePath, controlName),
    ]);
    assert.match(initial ?? '', /^[a-f0-9]{64}$/);
    assert.equal(await database.getPublicationObservation(collectionName), initial);

    await database.writeDocuments(collectionName, [
        indexedDocument({ id: 'second', vector: [0, 1], lexicalText: 'second' }),
    ]);
    const afterPayload = await database.getPublicationObservation(collectionName);
    const afterPayloadData = await database.getCollectionDataObservation(collectionName);
    assert.notEqual(afterPayload, initial);
    assert.notEqual(afterPayloadData, initialData);

    await database.deleteControl(collectionName, marker.id);
    const afterMarker = await database.getPublicationObservation(collectionName);
    assert.notEqual(afterMarker, afterPayload);
    assert.equal(await database.getCollectionDataObservation(collectionName), afterPayloadData);

    await database.insertControl(collectionName, marker);
    const afterMarkerAba = await database.getPublicationObservation(collectionName);
    assert.notEqual(afterMarkerAba, afterMarker);
    assert.notEqual(afterMarkerAba, afterPayload);

    await database.dropCollection(collectionName);
    assert.equal(await database.getPublicationObservation(collectionName), null);

    await database.createHybridCollection(collectionName, 2, undefined, { deferIndexBuild: true });
    await database.writeDocuments(collectionName, [
        indexedDocument({ id: 'replacement', vector: [0.5, 0.5], lexicalText: 'replacement' }),
    ]);
    await database.insertControl(collectionName, marker);
    const afterRecreate = await database.getPublicationObservation(collectionName);
    assert.deepEqual(await Promise.all([
        tableVersion(databasePath, collectionName),
        tableVersion(databasePath, controlName),
    ]), initialVersions);
    assert.match(afterRecreate ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(afterRecreate, initial);
});

test('LanceDB forks an independently retained searchable generation', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-fork-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());

    await database.createHybridCollection('source__gen_one', 2, undefined, { deferIndexBuild: true });
    await database.writeDocuments('source__gen_one', [
        indexedDocument({ id: 'old', vector: [1, 0], lexicalText: 'oldterm' }),
    ]);
    await database.writeDocuments('source__gen_one', [
        indexedDocument({ id: 'history', vector: [0.5, 0.5], lexicalText: 'historyterm' }),
    ]);
    await database.deleteDocuments('source__gen_one', ['history']);
    await database.finalizeCollectionForSearch('source__gen_one');

    const receipt = await database.forkCollection('source__gen_one', 'source__gen_two');
    assert.equal(receipt.sourceCollectionName, 'source__gen_one');
    assert.equal(receipt.targetCollectionName, 'source__gen_two');
    assert.equal(receipt.strategy, 'filesystem_hardlink_cow');
    assert.equal(receipt.copiedDocuments, 1);
    assert.ok((receipt.sharedFiles ?? 0) > 0);
    assert.equal(receipt.copiedFiles, 1);
    assert.ok((receipt.physicallyCopiedBytes ?? Number.POSITIVE_INFINITY) < (receipt.logicalBytes ?? 0));

    const sourcePath = path.join(databasePath, 'source__gen_one.lance');
    const candidatePath = path.join(databasePath, 'source__gen_two.lance');
    const sourceManifestCount = fs.readdirSync(path.join(sourcePath, '_versions'))
        .filter((name) => name.endsWith('.manifest')).length;
    const candidateManifestCount = fs.readdirSync(path.join(candidatePath, '_versions'))
        .filter((name) => name.endsWith('.manifest')).length;
    assert.ok(sourceManifestCount > 1);
    assert.equal(candidateManifestCount, 1);
    assert.ok(fs.readdirSync(path.join(sourcePath, '_transactions')).length > 0);
    assert.equal(fs.readdirSync(path.join(candidatePath, '_transactions')).length, 0);
    const sourceBeforeMutation = await snapshotPhysicalFiles(sourcePath);
    const candidateBeforeMutation = await snapshotPhysicalFiles(candidatePath);
    const sharedPaths = [...sourceBeforeMutation].filter(([relativePath, sourceFile]) => (
        candidateBeforeMutation.get(relativePath)?.inode === sourceFile.inode
    ));
    assert.ok(sharedPaths.length > 0);
    const sourceHint = sourceBeforeMutation.get(path.join('_versions', 'latest_version_hint.json'));
    const candidateHint = candidateBeforeMutation.get(path.join('_versions', 'latest_version_hint.json'));
    assert.ok(sourceHint);
    assert.ok(candidateHint);
    assert.notEqual(candidateHint.inode, sourceHint.inode);

    await database.writeDocuments('source__gen_two', [
        indexedDocument({ id: 'new', vector: [0, 1], lexicalText: 'newterm' }),
    ]);
    const candidateLexical = await database.retrieveLexical('source__gen_two', {
        query: 'newterm',
        limit: 2,
    });
    const sourceRows = await database.queryDocuments('source__gen_one', { fields: ['id'] });
    const candidateRows = await database.queryDocuments('source__gen_two', { fields: ['id'] });

    assert.deepEqual(sourceRows.map((row) => row.id), ['old']);
    assert.deepEqual(candidateRows.map((row) => row.id), ['new', 'old']);
    assert.deepEqual(candidateLexical.map((row) => row.document.id), ['new']);
    assert.deepEqual(
        [...await snapshotPhysicalFiles(sourcePath)].map(([relativePath, file]) => [relativePath, file.hash]),
        [...sourceBeforeMutation].map(([relativePath, file]) => [relativePath, file.hash]),
    );

    await database.dropCollection('source__gen_one');
    assert.deepEqual(
        (await database.queryDocuments('source__gen_two', { fields: ['id'] })).map((row) => row.id),
        ['new', 'old'],
    );
    assert.deepEqual(
        (await database.retrieveLexical('source__gen_two', { query: 'oldterm', limit: 2 }))
            .map((row) => row.document.id),
        ['old'],
    );

    await database.close();
    const reopened = new LanceDbVectorDatabase({ databasePath });
    t.after(() => reopened.close());
    assert.deepEqual(
        (await reopened.queryDocuments('source__gen_two', { fields: ['id'] })).map((row) => row.id),
        ['new', 'old'],
    );
});

test('LanceDB candidate publication fails closed without hard-link support', async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-no-hardlinks-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());

    await database.createHybridCollection('source__gen_one', 2, undefined, { deferIndexBuild: true });
    await database.writeDocuments('source__gen_one', [
        indexedDocument({ id: 'old', vector: [1, 0], lexicalText: 'oldterm' }),
    ]);
    await database.finalizeCollectionForSearch('source__gen_one');

    t.mock.method(fs.promises, 'link', async () => {
        const error = new Error('cross-device link') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
    });
    await assert.rejects(
        database.forkCollection('source__gen_one', 'source__gen_two'),
        /requires same-filesystem hard-link support.*EXDEV.*Run a safe full rebuild instead/,
    );
    assert.equal(fs.existsSync(path.join(databasePath, 'source__gen_two.lance')), false);
    assert.deepEqual(
        (await database.queryDocuments('source__gen_one', { fields: ['id'] })).map((row) => row.id),
        ['old'],
    );
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

test('LanceDB publication finalization creates FTS and does not call optimize', async (t) => {
    // Freeze the publication contract: search readiness is FTS only. Compaction
    // must not run on this path (epoch optimize corrupted real multi-file payloads).
    const sourcePath = path.resolve(import.meta.dirname, 'lancedb-vectordb.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const finalizeMatch = source.match(
        /async finalizeCollectionForSearch\([\s\S]*?\n {4}\}\n\n {4}async dropCollection/,
    );
    assert.ok(finalizeMatch, 'expected to locate finalizeCollectionForSearch in source');
    const finalizeBody = finalizeMatch[0];
    assert.match(finalizeBody, /createIndex\(\s*['"]lexicalText['"]/);
    // Comments may mention optimize; only reject an actual call site.
    assert.equal(
        /\.optimize\s*\(/.test(finalizeBody),
        false,
        'finalizeCollectionForSearch must not call table.optimize()',
    );

    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-finalize-contract-'));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const database = new LanceDbVectorDatabase({ databasePath });
    t.after(() => database.close());
    const collectionName = 'hybrid_code_chunks_finalize_contract__gen_one';
    await database.createHybridCollection(collectionName, 2, undefined, { deferIndexBuild: true });
    await database.writeDocuments(collectionName, [
        indexedDocument({ id: 'ready', vector: [1, 0], lexicalText: 'finalizecontractterm ready' }),
    ]);
    await database.finalizeCollectionForSearch(collectionName);

    const lexical = await database.retrieveLexical(collectionName, {
        query: 'finalizecontractterm',
        limit: 5,
    });
    assert.deepEqual(lexical.map((candidate) => candidate.document.id), ['ready']);
});

function voyageLikeVector(seed: number, dimension: number): number[] {
    const vector = new Array<number>(dimension);
    let state = (seed * 1_103_515_245 + 12_345) >>> 0;
    for (let index = 0; index < dimension; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        vector[index] = ((state / 0xffff_ffff) * 2 - 1) * 0.15;
    }
    return vector;
}

function buildVariedCorpusChunks(root: string, targetCount: number): Array<{
    id: string;
    content: string;
    lexicalText: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    fileExtension: string;
}> {
    const fixtures: Array<{ relativePath: string; content: string }> = [
        {
            relativePath: 'src/parser.ts',
            content: [
                "import { readFile } from 'node:fs/promises';",
                'export function parseHTTPResponse(raw: string): { status: number; body: string } {',
                "  const match = /^HTTP\\/1\\.1 (\\d{3})/.exec(raw);",
                '  if (!match) throw new Error(`invalid status in ${raw.slice(0, 40)}`);',
                '  return { status: Number(match[1]), body: raw.split("\\r\\n\\r\\n")[1] ?? "" };',
                '}',
                '// punctuation-heavy: {}[]()<>?!@#$%^&*-+=|\\/~`',
            ].join('\n'),
        },
        {
            relativePath: 'docs/unicode.md',
            content: [
                '# 検索と索引',
                '',
                'LanceDB must retain UTF-8: 你好世界 αβγ π — café.',
                '',
                '```ts',
                'const label = "シンボル";',
                '```',
                '',
                'Multiline notes:\n- first\n- second\n- third',
            ].join('\n'),
        },
        {
            relativePath: 'config/sample.json',
            content: `${JSON.stringify({
                name: 'satori-fixture',
                nested: { path: "O'Brien/src", flags: ['a', 'b', 'c'] },
                regex: '^[A-Za-z0-9_]+$',
                note: 'JSON-like text with "quotes" and commas,',
            }, null, 2)}\n`,
        },
        {
            relativePath: 'src/short.ts',
            content: 'export const ok = true;\n',
        },
        {
            relativePath: 'src/long-module.ts',
            content: Array.from({ length: 80 }, (_, index) => (
                `export function helper_${index}(value: number): number { return value + ${index}; } // end`
            )).join('\n'),
        },
    ];

    for (const fixture of fixtures) {
        const absolute = path.join(root, fixture.relativePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, fixture.content, 'utf8');
    }

    const chunks: Array<{
        id: string;
        content: string;
        lexicalText: string;
        relativePath: string;
        startLine: number;
        endLine: number;
        fileExtension: string;
    }> = [];
    let sequence = 0;
    while (chunks.length < targetCount) {
        for (const fixture of fixtures) {
            if (chunks.length >= targetCount) break;
            const pieceSize = 400 + ((sequence * 97) % 1400);
            const content = fixture.content.length <= pieceSize
                ? fixture.content
                : fixture.content.repeat(Math.ceil(pieceSize / fixture.content.length)).slice(0, pieceSize);
            const uniqueToken = `corpustoken${sequence}`;
            const startLine = 1 + (sequence % 40);
            const endLine = startLine + content.split('\n').length - 1;
            const relativePath = fixture.relativePath;
            chunks.push({
                id: `chunk_${sequence}`,
                content: `${content}\n// ${uniqueToken}\n`,
                lexicalText: `${uniqueToken} ${path.basename(relativePath, path.extname(relativePath))} ${content.slice(0, 200)}`,
                relativePath,
                startLine,
                endLine,
                fileExtension: path.extname(relativePath) || '.txt',
            });
            sequence += 1;
        }
    }
    return chunks;
}

function toIndexedDocuments(
    chunks: ReturnType<typeof buildVariedCorpusChunks>,
    dimension: number,
): IndexedVectorDocument[] {
    return chunks.map((chunk, index) => ({
        document: {
            id: chunk.id,
            vector: voyageLikeVector(index + 1, dimension),
            content: chunk.content,
            relativePath: chunk.relativePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            fileExtension: chunk.fileExtension,
            metadata: { language: chunk.fileExtension === '.md' ? 'markdown' : 'typescript' },
        },
        projections: {
            embeddingText: chunk.lexicalText,
            lexicalText: chunk.lexicalText,
            embeddingVersion: 'embedding_projection_v1',
            lexicalVersion: 'lexical_projection_v1',
        },
    }));
}

async function writeInBatches(
    database: LanceDbVectorDatabase,
    collectionName: string,
    documents: IndexedVectorDocument[],
    batchSizes: number[],
): Promise<number[]> {
    let offset = 0;
    const writtenBatchSizes: number[] = [];
    for (const batchSize of batchSizes) {
        if (offset >= documents.length) break;
        const batch = documents.slice(offset, offset + batchSize);
        await database.writeDocuments(collectionName, batch);
        writtenBatchSizes.push(batch.length);
        offset += batch.length;
    }
    if (offset < documents.length) {
        const batch = documents.slice(offset);
        await database.writeDocuments(collectionName, batch);
        writtenBatchSizes.push(batch.length);
    }
    return writtenBatchSizes;
}

test('LanceDB finalizes real multi-file UTF-8 corpora without optimize and remains searchable', async (t) => {
    const dimension = 1024;
    const corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-corpus-'));
    t.after(() => fs.rmSync(corpusRoot, { recursive: true, force: true }));

    const cases: Array<{
        label: string;
        rowCount: number;
        batchSizes: number[];
        probeTokenPrefix: string;
    }> = [
        {
            label: '2500',
            rowCount: 2500,
            batchSizes: [400, 400, 400, 400, 400, 400, 100],
            probeTokenPrefix: 'corpustoken',
        },
        {
            // Production-shaped total with a trailing 208-row batch after multi-batch merges.
            label: '4904_final_208',
            rowCount: 4904,
            batchSizes: [
                400, 400, 400, 400, 400, 400, 400, 400, 400, 400,
                400, 296, 208,
            ],
            probeTokenPrefix: 'corpustoken',
        },
    ];

    for (const testCase of cases) {
        await t.test(testCase.label, async (subtest) => {
            const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), `satori-lancedb-real-${testCase.label}-`));
            subtest.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));

            const chunks = buildVariedCorpusChunks(corpusRoot, testCase.rowCount);
            assert.equal(chunks.length, testCase.rowCount);
            const documents = toIndexedDocuments(chunks, dimension);
            const collectionName = `hybrid_code_chunks_real_${testCase.label}__gen_one`;
            const expectedProbeId = 'chunk_0';
            const probeToken = `${testCase.probeTokenPrefix}0`;

            const writer = new LanceDbVectorDatabase({ databasePath, maxWriteBatchSize: 512 });
            try {
                await writer.createHybridCollection(collectionName, dimension, undefined, {
                    deferIndexBuild: true,
                });
                const writtenBatchSizes = await writeInBatches(
                    writer,
                    collectionName,
                    documents,
                    testCase.batchSizes,
                );
                assert.deepEqual(writtenBatchSizes, testCase.batchSizes);
                await writer.finalizeCollectionForSearch(collectionName);
            } finally {
                await writer.close();
            }

            const reader = new LanceDbVectorDatabase({ databasePath, maxWriteBatchSize: 512 });
            subtest.after(() => reader.close());
            assert.equal(await reader.countDocuments(collectionName), testCase.rowCount);

            const dense = await reader.retrieveDense(collectionName, {
                vector: voyageLikeVector(1, dimension),
                limit: 5,
            });
            assert.equal(dense[0]?.document.id, expectedProbeId);
            assert.ok(dense.length >= 1);

            const lexical = await reader.retrieveLexical(collectionName, {
                query: probeToken,
                limit: 5,
            });
            assert.ok(
                lexical.some((candidate) => candidate.document.id === expectedProbeId),
                `expected lexical hit for ${expectedProbeId} via ${probeToken}`,
            );
        });
    }
});
