import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexCompletionMarkerDocument } from '@zokizuan/satori-core';
import { IndexFingerprint } from '../config.js';
import { decideInterruptedIndexingRecovery } from './indexing-recovery.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

function buildMarker(overrides: Partial<IndexCompletionMarkerDocument> = {}): IndexCompletionMarkerDocument {
    return {
        kind: 'satori_index_completion_v1',
        codebasePath: '/repo/app',
        fingerprint: RUNTIME_FINGERPRINT,
        indexedFiles: 169,
        totalChunks: 728,
        completedAt: '2026-02-27T23:57:10.000Z',
        runId: 'run_20260227',
        ...overrides,
    };
}

test('decideInterruptedIndexingRecovery promotes to indexed when marker proof is valid', () => {
    const decision = decideInterruptedIndexingRecovery(buildMarker(), RUNTIME_FINGERPRINT);

    assert.equal(decision.action, 'promote_indexed');
    assert.equal(decision.reason, 'valid_marker');
    assert.deepEqual(decision.stats, {
        indexedFiles: 169,
        totalChunks: 728,
        status: 'completed'
    });
});

test('decideInterruptedIndexingRecovery marks failed when completion marker is missing', () => {
    const decision = decideInterruptedIndexingRecovery(null, RUNTIME_FINGERPRINT);

    assert.equal(decision.action, 'mark_failed');
    assert.equal(decision.reason, 'missing_marker');
    assert.match(decision.message, /without completion marker/i);
});

test('decideInterruptedIndexingRecovery marks failed when marker fingerprint mismatches runtime', () => {
    const decision = decideInterruptedIndexingRecovery(
        buildMarker({
            fingerprint: {
                ...RUNTIME_FINGERPRINT,
                embeddingDimension: 512
            }
        }),
        RUNTIME_FINGERPRINT
    );

    assert.equal(decision.action, 'mark_failed');
    assert.equal(decision.reason, 'fingerprint_mismatch');
    assert.match(decision.message, /fingerprint/i);
});
