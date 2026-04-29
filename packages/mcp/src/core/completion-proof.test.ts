import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompletionProof } from './completion-proof.js';
import type { IndexFingerprint } from '../config.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

function marker(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'satori_index_completion_v1',
        codebasePath: '/repo/a',
        fingerprint: { ...RUNTIME_FINGERPRINT },
        indexedFiles: 10,
        totalChunks: 25,
        completedAt: '2026-02-28T08:00:00.000Z',
        runId: 'run_123',
        ...overrides
    };
}

test('validateCompletionProof rejects coerced marker count values', async () => {
    const invalidValues = ['', null, true, 1.5, -1];

    for (const invalidValue of invalidValues) {
        const indexedFilesResult = await validateCompletionProof({
            codebasePath: '/repo/a',
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            getIndexCompletionMarker: async () => marker({ indexedFiles: invalidValue })
        });
        assert.equal(indexedFilesResult.outcome, 'stale_local');
        assert.equal(indexedFilesResult.reason, 'invalid_payload');

        const totalChunksResult = await validateCompletionProof({
            codebasePath: '/repo/a',
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            getIndexCompletionMarker: async () => marker({ totalChunks: invalidValue })
        });
        assert.equal(totalChunksResult.outcome, 'stale_local');
        assert.equal(totalChunksResult.reason, 'invalid_payload');
    }
});

test('validateCompletionProof accepts non-negative integer marker counts', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => marker({ indexedFiles: 0, totalChunks: 0 })
    });

    assert.equal(result.outcome, 'valid');
});
