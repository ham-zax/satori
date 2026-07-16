import assert from 'node:assert/strict';
import test from 'node:test';
import { VectorDatabaseTestAdapter } from './test-adapter';

class FocusedVectorDatabase extends VectorDatabaseTestAdapter {
    async hasCollection(name: string): Promise<boolean> {
        return name === 'present';
    }
}

test('VectorDatabaseTestAdapter fails unexpected operations and permits focused overrides', async () => {
    const database = new FocusedVectorDatabase();

    assert.equal(await database.hasCollection('present'), true);
    await assert.rejects(
        () => database.listCollections(),
        /listCollections not implemented by FocusedVectorDatabase/,
    );
});
