import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIEmbedding } from './openai-embedding';

test('OpenAI embedding response indexes preserve input order and reject invalid mappings', async () => {
    const embedding = new OpenAIEmbedding({ apiKey: 'test-key', model: 'text-embedding-3-small' });
    const client = embedding.getClient().embeddings as unknown as {
        create: () => Promise<{ data: Array<{ index?: number; embedding: number[] }> }>;
    };
    client.create = async () => ({
        data: [{ index: 1, embedding: [20] }, { index: 0, embedding: [10] }],
    });
    assert.deepEqual((await embedding.embedDocuments(['first', 'second'])).map(row => row.vector), [[10], [20]]);

    for (const data of [
        [{ embedding: [10] }, { index: 1, embedding: [20] }],
        [{ index: 0, embedding: [10] }, { index: 0, embedding: [20] }],
        [{ index: -1, embedding: [10] }, { index: 1, embedding: [20] }],
        [{ index: 0, embedding: [10] }, { index: 2, embedding: [20] }],
        [{ index: 0, embedding: [10] }, { index: 0.5, embedding: [20] }],
        [{ index: 0, embedding: [10] }],
        [],
    ]) {
        client.create = async () => ({ data });
        await assert.rejects(embedding.embedDocuments(['first', 'second']), /index|embeddings for/);
    }
});
