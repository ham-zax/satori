import assert from 'node:assert/strict';
import test from 'node:test';
import { runMustConstraintLane, runSemanticSearchPasses } from './search-retrieval-passes.js';

test('semantic passes and must lane forward the request cancellation signal', async () => {
    const abort = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const host = {
        semanticSearch: async (request: { signal?: AbortSignal }) => { signals.push(request.signal); return []; },
        measureSearchPhase: async <T>(_name: string, action: () => Promise<T>) => action(),
        shouldForceSearchPassFailure: () => false,
    };
    const diagnostics = { searchPassCount: 0, semanticSearchAttempts: 0, embeddingCallsByCurrentContract: 0, denseQueriesByCurrentContract: 0, sparseQueriesByCurrentContract: 0 };
    await runSemanticSearchPasses({ host, diagnostics, codebasePath: '/repo', retrievalMode: 'hybrid', scorePolicyKind: 'topk_only', compoundJoin: false, candidateLimit: 5, passDescriptors: [{ id: 'primary', query: 'one' }, { id: 'expanded', query: 'two' }], signal: abort.signal });
    await runMustConstraintLane({ host, effectiveRoot: '/repo', mustTokens: ['term'], candidateBudget: 5, signal: abort.signal });
    assert.deepEqual(signals, [abort.signal, abort.signal, abort.signal]);
});
