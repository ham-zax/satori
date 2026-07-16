import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaEmbedding } from './ollama-embedding';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

class TestOllamaEmbedding extends OllamaEmbedding {
    public detectCalls = 0;
    private queuedDimensions: number[];
    private pendingDimension: Promise<number> | null = null;

    constructor(dimensions: number[]) {
        super({ model: 'nomic-embed-text' });
        this.queuedDimensions = dimensions.slice();
    }

    setPendingDimension(promise: Promise<number>): void {
        this.pendingDimension = promise;
    }

    setEmbedDimension(dimension: number): void {
        (this as unknown as { client: { embed(request: { input: string | string[] }): Promise<{ embeddings: number[][] }> } }).client = {
            async embed(request: { input: string | string[] }) {
                const values = Array.from({ length: dimension }, (_, index) => index);
                return {
                    embeddings: Array.isArray(request.input)
                        ? request.input.map(() => values)
                        : [values],
                };
            },
        };
    }

    async detectDimension(): Promise<number> {
        this.detectCalls += 1;
        if (this.pendingDimension) {
            return this.pendingDimension;
        }
        const dimension = this.queuedDimensions.shift();
        if (dimension === undefined) {
            throw new Error('No dimension queued');
        }
        return dimension;
    }
}

test('OllamaEmbedding shares in-flight dimension detection across concurrent embeds', async () => {
    const detected = deferred<number>();
    const embedding = new TestOllamaEmbedding([]);
    embedding.setEmbedDimension(3);
    embedding.setPendingDimension(detected.promise);

    const single = embedding.embedQuery('one');
    const batch = embedding.embedDocuments(['two']);
    await Promise.resolve();

    assert.equal(embedding.detectCalls, 1);

    detected.resolve(3);
    const [singleResult, batchResult] = await Promise.all([single, batch]);

    assert.equal(singleResult.dimension, 3);
    assert.equal(batchResult[0]?.dimension, 3);
    assert.equal(embedding.detectCalls, 1);
});

test('OllamaEmbedding invalidates detected dimension when host changes', async () => {
    const embedding = new TestOllamaEmbedding([3, 5]);
    embedding.setEmbedDimension(3);

    const first = await embedding.embedQuery('one');
    assert.equal(first.dimension, 3);
    assert.equal(embedding.detectCalls, 1);

    embedding.setHost('http://127.0.0.1:11435');
    embedding.setEmbedDimension(5);

    const second = await embedding.embedQuery('two');
    assert.equal(second.dimension, 5);
    assert.equal(embedding.detectCalls, 2);
});
