import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DELETED_ID_BATCH_SIZE,
    DELETED_PATH_BATCH_SIZE,
    deleteIndexedChunksForRelativePaths,
} from './path-chunk-delete';
import type { VectorDocumentQuery, VectorFilter } from './types';

function createInMemoryChunkStore(initial: Array<{ id: string; relativePath: string }>) {
    const rows = new Map(initial.map((row) => [row.id, row]));
    const queryCalls: VectorDocumentQuery[] = [];
    const deleteCalls: string[][] = [];

    function matchesFilter(relativePath: string, filter: VectorFilter | undefined): boolean {
        if (!filter) return true;
        if (filter.kind === 'comparison' && filter.field === 'relativePath' && filter.operator === 'eq') {
            return relativePath === filter.value;
        }
        if (filter.kind === 'in' && filter.field === 'relativePath') {
            return filter.values.includes(relativePath);
        }
        throw new Error(`Unexpected filter in test: ${JSON.stringify(filter)}`);
    }

    return {
        rows,
        queryCalls,
        deleteCalls,
        vectorDatabase: {
            async queryDocuments(_collectionName: string, request: VectorDocumentQuery) {
                queryCalls.push(request);
                const matching = Array.from(rows.values()).filter((row) =>
                    matchesFilter(row.relativePath, request.filter),
                );
                const limited = request.limit !== undefined ? matching.slice(0, request.limit) : matching;
                return limited.map((row) => ({ id: row.id }));
            },
            async deleteDocuments(_collectionName: string, ids: string[]) {
                deleteCalls.push([...ids]);
                for (const id of ids) {
                    rows.delete(id);
                }
            },
        },
    };
}

test('deleteIndexedChunksForRelativePaths deletes a single bounded page in one query and delete', async () => {
    const store = createInMemoryChunkStore([
        { id: 'c1', relativePath: 'src/a.ts' },
        { id: 'c2', relativePath: 'src/a.ts' },
        { id: 'c3', relativePath: 'src/b.ts' },
        { id: 'keep', relativePath: 'src/keep.ts' },
    ]);
    const callbacks: Array<{ deleted: number; paths: number }> = [];

    const total = await deleteIndexedChunksForRelativePaths(
        store.vectorDatabase,
        'col',
        ['src/a.ts', 'src/b.ts'],
        { onBatchDeleted: (deleted, paths) => callbacks.push({ deleted, paths }) },
    );

    assert.equal(total, 3);
    assert.equal(store.queryCalls.length, 1);
    assert.equal(store.queryCalls[0]?.limit, DELETED_ID_BATCH_SIZE);
    assert.deepEqual(store.deleteCalls, [['c1', 'c2', 'c3']]);
    assert.deepEqual(Array.from(store.rows.keys()), ['keep']);
    assert.deepEqual(callbacks, [{ deleted: 3, paths: 2 }]);
});

test('deleteIndexedChunksForRelativePaths drains >500 IDs across bounded pages and path batches', async () => {
    const initial: Array<{ id: string; relativePath: string }> = [];
    for (let i = 0; i < 1205; i += 1) {
        initial.push({ id: `chunk-${i}`, relativePath: `src/file-${i % (DELETED_PATH_BATCH_SIZE + 5)}.ts` });
    }
    initial.push({ id: 'keep-me', relativePath: 'src/untouched.ts' });
    const targetPaths = Array.from({ length: DELETED_PATH_BATCH_SIZE + 5 }, (_, i) => `src/file-${i}.ts`);
    const store = createInMemoryChunkStore(initial);

    const total = await deleteIndexedChunksForRelativePaths(
        store.vectorDatabase,
        'col',
        targetPaths,
    );

    assert.equal(total, 1205);
    assert.deepEqual(Array.from(store.rows.keys()), ['keep-me']);
    assert.equal(store.queryCalls.every((q) => q.limit === DELETED_ID_BATCH_SIZE), true);
    assert.equal(store.deleteCalls.every((ids) => ids.length <= DELETED_ID_BATCH_SIZE), true);
    assert.ok(store.deleteCalls.length >= 3);
});

test('deleteIndexedChunksForRelativePaths throws if deleteDocuments makes no progress', async () => {
    const rows = Array.from({ length: DELETED_ID_BATCH_SIZE }, (_, i) => ({ id: `stuck-${i}` }));
    await assert.rejects(
        () => deleteIndexedChunksForRelativePaths(
            {
                async queryDocuments() {
                    return rows;
                },
                async deleteDocuments() {
                    // Intentionally fail to remove anything.
                },
            },
            'col',
            ['src/a.ts'],
        ),
        /made no progress deleting chunks/,
    );
});

test('deleteIndexedChunksForRelativePaths invokes assertMutationCurrent before each deleteDocuments', async () => {
    const store = createInMemoryChunkStore([
        { id: 'c1', relativePath: 'src/a.ts' },
    ]);
    await assert.rejects(
        () => deleteIndexedChunksForRelativePaths(
            store.vectorDatabase,
            'col',
            ['src/a.ts'],
            {
                assertMutationCurrent: () => {
                    throw new Error('lease lost');
                },
            },
        ),
        /lease lost/,
    );
    assert.equal(store.deleteCalls.length, 0);
    assert.equal(store.rows.size, 1);
});
