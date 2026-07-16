import assert from 'node:assert/strict';
import test from 'node:test';
import { VoyageAIError } from 'voyageai';
import { VoyageAIEmbedding } from './voyageai-embedding.js';

type EmbedRequest = {
    input: string | string[];
    model: string;
    inputType?: string;
    truncation?: boolean;
};

type EmbedOptions = {
    timeoutInSeconds?: number;
    maxRetries?: number;
};

type EmbedResponse = {
    data: Array<{ embedding: number[] }>;
    usage?: { totalTokens?: number };
};

function stubEmbedClient(
    embedding: VoyageAIEmbedding,
    run: (request: EmbedRequest, options: EmbedOptions) => Promise<EmbedResponse>,
): void {
    const client = embedding.getClient() as unknown as {
        embed: typeof run;
    };
    client.embed = run;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

test('Voyage code indexing declares the live-probed provider batch limits', () => {
    const embedding = new VoyageAIEmbedding({ apiKey: 'test-key', model: 'voyage-code-3' });

    assert.deepEqual(embedding.getBatchPolicy(), {
        preferredMaxItems: 1_000,
        hardMaxItems: 1_000,
        targetEstimatedTokens: 100_000,
        hardTokenLimit: 120_000,
    });
    assert.equal(
        new VoyageAIEmbedding({ apiKey: 'test-key', model: 'voyage-4' }).getBatchPolicy(),
        null,
    );
});

test('Voyage embedding disables truncation and records actual provider usage', async () => {
    const embedding = new VoyageAIEmbedding({ apiKey: 'test-key', model: 'voyage-code-3' });
    const calls: Array<{ request: EmbedRequest; options: EmbedOptions }> = [];
    stubEmbedClient(embedding, async (request, options) => {
        calls.push({ request, options });
        const input = Array.isArray(request.input) ? request.input : [request.input];
        return {
            data: input.map((_, index) => ({ embedding: [index, index + 1] })),
            usage: { totalTokens: 17 },
        };
    });

    const result = await embedding.embedDocuments(['owner', 'support']);

    assert.equal(result.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.request.inputType, 'document');
    assert.equal(calls[0]?.request.truncation, false);
    assert.deepEqual(calls[0]?.options, {
        timeoutInSeconds: 180,
        maxRetries: 0,
    });
    const metrics = embedding.getOperationMetricsSnapshot();
    assert.deepEqual({ ...metrics, durationMs: undefined }, {
        providerRequestCount: 1,
        retryCount: 0,
        submittedItems: 2,
        submittedBytes: Buffer.byteLength('ownersupport', 'utf8'),
        providerTokens: 17,
        durationMs: undefined,
    });
    assert.ok(metrics.durationMs >= 0);
});

test('Voyage embedding exposes retries instead of hiding them inside the SDK', async () => {
    class ImmediateRetryEmbedding extends VoyageAIEmbedding {
        protected async waitBeforeRetry(): Promise<void> {
            return undefined;
        }
    }

    const embedding = new ImmediateRetryEmbedding({ apiKey: 'test-key', model: 'voyage-code-3' });
    let attempts = 0;
    stubEmbedClient(embedding, async () => {
        attempts += 1;
        if (attempts === 1) {
            throw new VoyageAIError({ statusCode: 429, message: 'rate limited' });
        }
        return { data: [{ embedding: [1, 2] }], usage: { totalTokens: 3 } };
    });

    const result = await embedding.embedDocuments(['owner']);

    assert.equal(result.length, 1);
    assert.equal(attempts, 2);
    assert.equal(embedding.getOperationMetricsSnapshot().providerRequestCount, 2);
    assert.equal(embedding.getOperationMetricsSnapshot().retryCount, 1);
});

test('Voyage embedding keeps document and query roles isolated across overlapping retries', async () => {
    class ImmediateRetryEmbedding extends VoyageAIEmbedding {
        protected async waitBeforeRetry(): Promise<void> {
            return undefined;
        }
    }

    const embedding = new ImmediateRetryEmbedding({ apiKey: 'test-key', model: 'voyage-code-3' });
    const queryStarted = deferred();
    const calls: Array<{ input: string; inputType: string | undefined }> = [];
    let firstDocumentAttempt = true;

    stubEmbedClient(embedding, async (request) => {
        const input = Array.isArray(request.input) ? request.input : [request.input];
        const text = input[0] ?? '';
        calls.push({ input: text, inputType: request.inputType });

        if (text === 'document' && firstDocumentAttempt) {
            firstDocumentAttempt = false;
            await queryStarted.promise;
            throw new VoyageAIError({ statusCode: 429, message: 'rate limited' });
        }
        if (text === 'query') {
            queryStarted.resolve();
        }

        return {
            data: input.map((value) => ({ embedding: [value.length] })),
            usage: { totalTokens: input.length },
        };
    });

    const [documents, query] = await Promise.all([
        embedding.embedDocuments(['document']),
        embedding.embedQuery('query'),
    ]);
    await Promise.all([
        embedding.embedQuery('query-2'),
        embedding.embedDocuments(['document-2']),
    ]);

    assert.deepEqual(documents.map((item) => item.vector), [[8]]);
    assert.deepEqual(query.vector, [5]);
    assert.deepEqual(calls, [
        { input: 'document', inputType: 'document' },
        { input: 'query', inputType: 'query' },
        { input: 'document', inputType: 'document' },
        { input: 'query-2', inputType: 'query' },
        { input: 'document-2', inputType: 'document' },
    ]);
});

test('Voyage embedding deterministically splits an explicit provider batch-limit failure', async () => {
    const embedding = new VoyageAIEmbedding({ apiKey: 'test-key', model: 'voyage-code-3' });
    const submitted: string[][] = [];
    stubEmbedClient(embedding, async (request) => {
        const input = Array.isArray(request.input) ? request.input : [request.input];
        submitted.push(input);
        if (input.length > 2) {
            throw new VoyageAIError({ statusCode: 400, message: 'maximum total token limit exceeded' });
        }
        return {
            data: input.map((text) => ({ embedding: [Number(text)] })),
            usage: { totalTokens: input.length },
        };
    });

    const result = await embedding.embedDocuments(['1', '2', '3', '4']);

    assert.deepEqual(submitted, [
        ['1', '2', '3', '4'],
        ['1', '2'],
        ['3', '4'],
    ]);
    assert.deepEqual(result.map((item) => item.vector), [[1], [2], [3], [4]]);
    assert.equal(embedding.getOperationMetricsSnapshot().providerRequestCount, 3);
});
