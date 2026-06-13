import test from 'node:test';
import assert from 'node:assert/strict';
import { VoyageAIReranker } from './voyageai-reranker';

type MockFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}>;

async function withMockedFetch<T>(mockFetch: MockFetch, fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;
    try {
        return await fn();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function withMutedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
        return await fn();
    } finally {
        console.error = originalConsoleError;
    }
}

test('VoyageAIReranker.rerank sends the Voyage request and preserves returned documents', async () => {
    const calls: Array<{ url: string; init: NonNullable<Parameters<typeof fetch>[1]> }> = [];
    await withMockedFetch(async (url, init) => {
        assert.ok(init);
        calls.push({ url: String(url), init });
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: [
                    { index: 1, relevance_score: 0.75, document: '' },
                    { index: 0, relevance_score: 0.25, document: 'alpha document' },
                ],
            }),
            text: async () => '',
        };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', model: 'rerank-2.5' });

        const results = await reranker.rerank('find auth', ['alpha document', ''], {
            topK: 2,
            returnDocuments: true,
            truncation: false,
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.voyageai.com/v1/rerank');
        assert.equal(calls[0].init.method, 'POST');
        const headers = calls[0].init.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer voyage-test-key');
        assert.equal(headers['Content-Type'], 'application/json');
        const body = calls[0].init.body;
        assert.equal(typeof body, 'string');
        if (typeof body !== 'string') {
            throw new Error('Expected string request body');
        }
        assert.deepEqual(JSON.parse(body), {
            query: 'find auth',
            documents: ['alpha document', ''],
            model: 'rerank-2.5',
            return_documents: true,
            truncation: false,
            top_k: 2,
        });
        assert.deepEqual(results, [
            { index: 1, relevanceScore: 0.75, document: '' },
            { index: 0, relevanceScore: 0.25, document: 'alpha document' },
        ]);
    });
});

test('VoyageAIReranker.rerank rejects malformed response rows', async () => {
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                data: [
                    { index: '0', relevance_score: 0.75 },
                ],
            }),
            text: async () => '',
        }), async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key' });

            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                /invalid response row/
            );
        });
    });
});
