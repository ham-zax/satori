import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { buildSearchProjections } from '../core/search-projections.js';
import { LanceDbVectorDatabase } from './lancedb-vectordb.js';
import type { IndexedVectorDocument } from './types.js';

function indexedDocument(id: string, content: string, vector: [number, number] = [1, 0]): IndexedVectorDocument {
    const relativePath = `src/${id}.ts`;
    const chunk = { content, metadata: { startLine: 1, endLine: 1, language: 'typescript' } };
    return {
        document: { id, vector, content, relativePath, startLine: 1, endLine: 1, fileExtension: '.ts', metadata: {} },
        projections: buildSearchProjections({ chunk: chunk as never, relativePath }),
    };
}

/** Every physical row, all columns, ordered by id: the published row content. */
async function physicalRows(databasePath: string, collectionName: string): Promise<unknown[]> {
    const connection = await connect(databasePath);
    try {
        const table = await connection.openTable(collectionName);
        try {
            const rows = await table.query().toArray();
            return rows
                .map((row) => JSON.parse(JSON.stringify(row, (_key, value) => (
                    ArrayBuffer.isView(value) ? Array.from(value as Float32Array) : value
                ))))
                .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        } finally {
            table.close();
        }
    } finally {
        connection.close();
    }
}

async function withDatabase(prefix: string, body: (database: LanceDbVectorDatabase, databasePath: string) => Promise<void>): Promise<void> {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const database = new LanceDbVectorDatabase({ databasePath, maxWriteBatchSize: 2 });
    try {
        await body(database, databasePath);
    } finally {
        await database.close();
        fs.rmSync(databasePath, { recursive: true, force: true });
    }
}

/** Wraps every opened table so `add` runs `onAdd` around the real append. */
function interceptAdds(database: LanceDbVectorDatabase, onAdd: (add: () => Promise<unknown>) => Promise<unknown>): void {
    const adapter = database as unknown as { getConnection(): Promise<Connection> };
    const getConnection = adapter.getConnection.bind(database);
    adapter.getConnection = async () => {
        const connection = await getConnection();
        return new Proxy(connection, {
            get(target, property, receiver) {
                if (property !== 'openTable') return Reflect.get(target, property, receiver);
                return async (...args: Parameters<Connection['openTable']>) => {
                    const table = await target.openTable(...args);
                    return new Proxy(table, {
                        get(tableTarget, tableProperty) {
                            const value = Reflect.get(tableTarget, tableProperty, tableTarget);
                            if (tableProperty !== 'add') return typeof value === 'function' ? value.bind(tableTarget) : value;
                            return (...addArgs: Parameters<Table['add']>) => onAdd(() => tableTarget.add(...addArgs));
                        },
                    });
                };
            },
        });
    };
}

// Writes in this order: new ids, an unchanged rewrite, a changed rewrite of an
// id written two calls earlier, and a mixed batch. Each rewrite reaches the
// query-and-merge path on a candidate table.
const WRITES: IndexedVectorDocument[][] = [
    [indexedDocument('a', 'const a = 1;'), indexedDocument('b', 'const b = 2;'), indexedDocument('c', 'const c = 3;')],
    [indexedDocument('a', 'const a = 1;')],
    [indexedDocument('b', 'const b = 20;', [0, 1]), indexedDocument('d', 'const d = 4;')],
    [indexedDocument('e', 'const e = 5;'), indexedDocument('a', 'const a = 10;'), indexedDocument('f', 'const f = 6;')],
];

test('LanceDB candidate appends publish the same rows as the query-and-merge path', async () => {
    await withDatabase('satori-lancedb-append-', async (database, databasePath) => {
        await database.createHybridCollection('merged', 2);
        await database.createHybridCollection('candidate', 2, undefined, { deferIndexBuild: true });
        for (const documents of WRITES) {
            await database.writeDocuments('merged', documents);
            await database.writeDocuments('candidate', documents);
        }
        await database.finalizeCollectionForSearch('candidate');

        const candidate = await physicalRows(databasePath, 'candidate');
        assert.deepEqual(candidate, await physicalRows(databasePath, 'merged'));
        assert.deepEqual(candidate.map((row) => (row as { id: string }).id), ['a', 'b', 'c', 'd', 'e', 'f']);
        assert.equal((candidate[0] as { content: string }).content, 'const a = 10;');
        assert.equal((candidate[1] as { content: string }).content, 'const b = 20;');
    });
});

test('LanceDB candidate append that fails after commit ends tracking, so a retry does not duplicate rows', async () => {
    await withDatabase('satori-lancedb-append-fault-', async (database, databasePath) => {
        await database.createHybridCollection('candidate', 2, undefined, { deferIndexBuild: true });
        let failNext = true;
        interceptAdds(database, async (add) => {
            const result = await add();
            if (failNext) {
                failNext = false;
                throw new Error('injected failure after append commit');
            }
            return result;
        });
        const documents = [indexedDocument('a', 'const a = 1;'), indexedDocument('b', 'const b = 2;')];
        await assert.rejects(database.writeDocuments('candidate', documents), /injected failure after append commit/);
        await database.writeDocuments('candidate', documents);

        assert.deepEqual((await physicalRows(databasePath, 'candidate')).map((row) => (row as { id: string }).id), ['a', 'b']);
    });
});

test('LanceDB candidate writes stop appending after finalization, when other writers may add rows', async () => {
    await withDatabase('satori-lancedb-append-final-', async (database, databasePath) => {
        await database.createHybridCollection('candidate', 2, undefined, { deferIndexBuild: true });
        await database.writeDocuments('candidate', [indexedDocument('a', 'const a = 1;')]);
        await database.finalizeCollectionForSearch('candidate');
        const otherWriter = new LanceDbVectorDatabase({ databasePath });
        try {
            await otherWriter.writeDocuments('candidate', [indexedDocument('b', 'const b = 2;')]);
        } finally {
            await otherWriter.close();
        }
        await database.writeDocuments('candidate', [indexedDocument('b', 'const b = 20;')]);

        const rows = await physicalRows(databasePath, 'candidate') as Array<{ id: string; content: string }>;
        assert.deepEqual(rows.map((row) => [row.id, row.content]), [['a', 'const a = 1;'], ['b', 'const b = 20;']]);
    });
});

test('LanceDB candidate collection refuses an overlapping write instead of racing an in-flight append', async () => {
    await withDatabase('satori-lancedb-append-overlap-', async (database, databasePath) => {
        await database.createHybridCollection('candidate', 2, undefined, { deferIndexBuild: true });
        let releaseAppend!: () => void;
        const appendHeld = new Promise<void>((resolve) => { releaseAppend = resolve; });
        let appendStarted!: () => void;
        const started = new Promise<void>((resolve) => { appendStarted = resolve; });
        interceptAdds(database, async (add) => {
            appendStarted();
            await appendHeld;
            return add();
        });
        const first = database.writeDocuments('candidate', [indexedDocument('a', 'const a = 1;')]);
        await started;
        await assert.rejects(
            database.writeDocuments('candidate', [indexedDocument('a', 'const a = 1;')]),
            /received overlapping writes/,
        );
        releaseAppend();
        await first;

        assert.deepEqual((await physicalRows(databasePath, 'candidate')).map((row) => (row as { id: string }).id), ['a']);
    });
});
