import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationRef } from '../generation/contracts';
import type { VectorDatabase } from '../vectordb';
import { SemanticSearchService } from './semantic-search-service';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test('cancelled hybrid search waits for its sibling and leaves a peer running', async () => {
    const started = deferred<void>();
    const sibling = deferred<never[]>();
    const abort = new AbortController();
    let lexicalCalls = 0;
    let denseCalls = 0;
    const database = {
        retrieveDense: async (_name: string, request: { signal?: AbortSignal }) => {
            if (++denseCalls === 1) {
                started.resolve();
                assert.equal(request.signal, abort.signal);
                await new Promise<void>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
            }
            return [];
        },
        retrieveLexical: async (_name: string, request: { signal?: AbortSignal }) => {
            lexicalCalls++;
            return request.signal === abort.signal ? sibling.promise : [];
        },
    } as unknown as VectorDatabase;
    const service = new SemanticSearchService({
        getVectorDatabase: () => database,
        embeddingAccess: { getEmbedding: () => ({ embedQuery: async () => ({ vector: [1], dimension: 1 }) }) as never, assertEmbeddingIdentityCurrent: () => undefined },
        authority: { acquireCurrentRead: () => null, isReadAdmitted: async () => true },
        isHybridEnabled: () => true,
        canonicalizeCodebasePath: (path) => path,
    });
    const publication = { publication: { canonicalRoot: '/repo', vector: { collectionName: 'test' } } } as PublicationRef;
    const request = { codebasePath: '/repo', query: 'query', retrievalMode: 'hybrid' as const };
    let settled = false;
    const cancelled = service.searchInPublication(publication, { ...request, signal: abort.signal }).finally(() => { settled = true; });
    await started.promise;
    abort.abort(new Error('cancelled'));
    const peer = await service.searchInPublication(publication, request);
    assert.deepEqual(peer, []);
    assert.equal(settled, false);
    sibling.resolve([]);
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(lexicalCalls, 2);
});

test('aborting a non-interruptible embedding prevents retrieval in normal and trace searches', async () => {
    for (const trace of [false, true]) {
        const started = deferred<void>();
        const embedding = deferred<{ vector: number[]; dimension: number }>();
        const abort = new AbortController();
        let retrievals = 0;
        const service = new SemanticSearchService({
            getVectorDatabase: () => ({
                retrieveDense: async () => { retrievals++; return []; },
            }) as unknown as VectorDatabase,
            embeddingAccess: {
                getEmbedding: () => ({ embedQuery: async (_query: string, signal?: AbortSignal) => {
                    assert.equal(signal, abort.signal);
                    started.resolve();
                    return embedding.promise;
                } }) as never,
                assertEmbeddingIdentityCurrent: () => undefined,
            },
            authority: { acquireCurrentRead: () => null, isReadAdmitted: async () => true },
            isHybridEnabled: () => false,
            canonicalizeCodebasePath: (path) => path,
        });
        const publication = { publication: { canonicalRoot: '/repo', vector: { collectionName: 'test' } } } as PublicationRef;
        const request = { codebasePath: '/repo', query: 'query', signal: abort.signal };
        const result = trace
            ? service.searchWithCandidateTraceInPublication(publication, request, 10)
            : service.searchInPublication(publication, request);
        await started.promise;
        abort.abort(new Error('embedding cancelled'));
        embedding.resolve({ vector: [1], dimension: 1 });
        await assert.rejects(result, /embedding cancelled/);
        assert.equal(retrievals, 0);
    }
});
