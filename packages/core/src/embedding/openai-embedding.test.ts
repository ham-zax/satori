import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIEmbedding } from './openai-embedding';
import { GeminiEmbedding, VoyageAIEmbedding } from '../index';

const CLOUD_SDK_MODULE_MARKERS = [
    '/node_modules/openai/',
    '/node_modules/@google/genai/',
    '/node_modules/voyageai/',
] as const;

function loadedCloudSdkModules(): string[] {
    // `require.cache` keys use the platform separator, so normalize before
    // matching the POSIX-style markers above.
    return Object.keys(require.cache)
        .map((modulePath) => modulePath.replace(/\\/g, '/'))
        .filter((modulePath) => CLOUD_SDK_MODULE_MARKERS.some((marker) => modulePath.includes(marker)));
}

// Captured while this module is evaluated, so it reflects the package entry
// point alone and not any provider a test body constructed afterwards.
const cloudSdksLoadedByEntryPointImport = loadedCloudSdkModules();

test('importing the package entry point does not load cloud SDKs before provider instantiation', () => {
    assert.deepEqual(cloudSdksLoadedByEntryPointImport, []);

    // The probe is not vacuous: constructing a provider does load its SDK.
    new OpenAIEmbedding({ apiKey: 'test-key', model: 'text-embedding-3-small' });
    new GeminiEmbedding({ apiKey: 'test-key', model: 'gemini-embedding-001' });
    new VoyageAIEmbedding({ apiKey: 'test-key', model: 'voyage-4' });
    const loaded = loadedCloudSdkModules();
    for (const marker of CLOUD_SDK_MODULE_MARKERS) {
        assert.ok(
            loaded.some((modulePath) => modulePath.includes(marker)),
            `constructing a provider must load ${marker}`,
        );
    }
});

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
