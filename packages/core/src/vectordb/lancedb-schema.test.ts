import assert from 'node:assert/strict';
import test from 'node:test';
import type { Table } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Type } from 'apache-arrow';
import { LanceDbVectorDatabase } from './lancedb-vectordb.js';

function tableWithVectorType(type: unknown): Table {
    return {
        name: 'probe',
        schema: async () => ({ fields: [{ name: 'vector', type }] }),
    } as unknown as Table;
}

test('LanceDB recognizes fixed-size vectors across Arrow package instances', async () => {
    const database = new LanceDbVectorDatabase({ databasePath: '/unused-schema-probe' });
    const localType = new FixedSizeList(2, new Field('item', new Float32(), true));
    // npm can install Arrow 18 for LanceDB alongside Core's Arrow 21. The
    // schema retains its Arrow type id but has a different constructor.
    const foreignType = Object.assign(Object.create(null), localType, { typeId: Type.FixedSizeList });
    assert.equal(foreignType instanceof FixedSizeList, false);
    assert.equal(await database['vectorDimension'](tableWithVectorType(localType)), 2);
    assert.equal(await database['vectorDimension'](tableWithVectorType(foreignType)), 2);
});

test('LanceDB rejects variable-size and missing vector columns', async () => {
    const database = new LanceDbVectorDatabase({ databasePath: '/unused-schema-probe' });
    for (const type of [{ typeId: Type.List }, undefined]) {
        await assert.rejects(database['vectorDimension'](tableWithVectorType(type)), /no fixed-size vector column/);
    }
});
