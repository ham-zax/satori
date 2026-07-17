import assert from 'node:assert/strict';
import test from 'node:test';
import { VoyageAIError } from 'voyageai';
import { EmbeddingProviderError } from './base-embedding.js';
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

test('Voyage embedding classifies and redacts terminal authentication failures without retrying', async () => {
    const embedding = new VoyageAIEmbedding({ apiKey: 'test-key', model: 'voyage-code-3' });
    let attempts = 0;
    stubEmbedClient(embedding, async () => {
        attempts += 1;
        throw new VoyageAIError({
            statusCode: 401,
            message: 'authentication connection failed api_key=secret-provider-value',
        });
    });

    await assert.rejects(
        embedding.embedQuery('owner'),
        (error: unknown) => {
            assert.ok(error instanceof EmbeddingProviderError);
            assert.equal(error.provider, 'VoyageAI');
            assert.equal(error.code, 'EMBEDDING_PROVIDER_AUTH_FAILED');
            assert.equal(error.statusCode, 401);
            assert.equal(error.retryable, false);
            assert.equal(error.message, 'VoyageAI embedding authentication failed (HTTP 401).');
            assert.doesNotMatch(error.message, /secret-provider-value/);
            return true;
        },
    );
    assert.equal(attempts, 1);
    assert.equal(embedding.getOperationMetricsSnapshot().retryCount, 0);
});

test('Voyage embedding preserves retryability when classifying exhausted provider failures', async () => {
    class ImmediateRetryEmbedding extends VoyageAIEmbedding {
        protected async waitBeforeRetry(): Promise<void> {
            return undefined;
        }
    }

    const cases = [
        {
            name: 'invalid request',
            error: new VoyageAIError({ statusCode: 400, message: 'invalid model' }),
            code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
            retryable: false,
            attempts: 1,
        },
        {
            name: 'forbidden',
            error: new VoyageAIError({ statusCode: 403, message: 'source IP forbidden' }),
            code: 'EMBEDDING_PROVIDER_FORBIDDEN',
            retryable: false,
            attempts: 1,
        },
        {
            name: 'rate limited',
            error: new VoyageAIError({ statusCode: 429, message: 'rate limited' }),
            code: 'EMBEDDING_PROVIDER_RATE_LIMITED',
            retryable: true,
            attempts: 3,
        },
        {
            name: 'service unavailable',
            error: new VoyageAIError({ statusCode: 503, message: 'service unavailable' }),
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: true,
            attempts: 3,
        },
        {
            name: 'network failure',
            error: new Error('fetch failed'),
            code: 'EMBEDDING_PROVIDER_NETWORK_ERROR',
            retryable: true,
            attempts: 3,
        },
    ] as const;

    for (const fixture of cases) {
        const embedding = new ImmediateRetryEmbedding({ apiKey: 'test-key', model: 'voyage-code-3' });
        let attempts = 0;
        stubEmbedClient(embedding, async () => {
            attempts += 1;
            throw fixture.error;
        });

        await assert.rejects(
            embedding.embedQuery(fixture.name),
            (error: unknown) => {
                assert.ok(error instanceof EmbeddingProviderError);
                assert.equal(error.code, fixture.code);
                assert.equal(error.retryable, fixture.retryable);
                return true;
            },
        );
        assert.equal(attempts, fixture.attempts);
        assert.equal(
            embedding.getOperationMetricsSnapshot().retryCount,
            fixture.retryable ? fixture.attempts - 1 : 0,
        );
    }
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
