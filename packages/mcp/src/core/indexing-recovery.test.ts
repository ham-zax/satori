import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexCompletionMarkerDocument } from '@zokizuan/satori-core';
import { IndexFingerprint } from '../config.js';
import { decideInterruptedIndexingRecovery } from './indexing-recovery.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    embeddingArtifactDigest: null,
    embeddingNormalizationPolicy: 'provider_output_v1',
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
    parserVersion: 'parser-v1',
    extractorVersion: 'extractor-v1',
    relationshipVersion: 'relationships-v1',
    embeddingProjectionVersion: 'embedding-projection-v1',
    lexicalProjectionVersion: 'lexical-projection-v1',
};

function buildMarker(overrides: Partial<IndexCompletionMarkerDocument> = {}): IndexCompletionMarkerDocument {
    return {
        kind: 'satori_index_completion_v3',
        codebasePath: '/repo/app',
        fingerprint: RUNTIME_FINGERPRINT,
        indexedFiles: 169,
        totalChunks: 728,
        completedAt: '2026-02-27T23:57:10.000Z',
        runId: 'run_20260227',
        indexPolicyHash: 'a'.repeat(64),
        indexStatus: 'completed',
        navigation: { status: 'not_bound' },
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
    assert.deepEqual(decision.indexFingerprint, RUNTIME_FINGERPRINT);
});

test('decideInterruptedIndexingRecovery marks failed when completion marker is missing', () => {
    const decision = decideInterruptedIndexingRecovery(null, RUNTIME_FINGERPRINT);

    assert.equal(decision.action, 'mark_failed');
    assert.equal(decision.reason, 'missing_marker');
    assert.match(decision.message, /without completion marker/i);
});

test('decideInterruptedIndexingRecovery promotes indexed state when marker fingerprint mismatches runtime', () => {
    const mismatchedFingerprint: IndexFingerprint = {
        ...RUNTIME_FINGERPRINT,
        embeddingDimension: 512
    };
    const decision = decideInterruptedIndexingRecovery(
        buildMarker({
            fingerprint: mismatchedFingerprint
        }),
        RUNTIME_FINGERPRINT
    );

    assert.equal(decision.action, 'promote_indexed');
    assert.equal(decision.reason, 'valid_marker_runtime_mismatch');
    assert.deepEqual(decision.stats, {
        indexedFiles: 169,
        totalChunks: 728,
        status: 'completed'
    });
    assert.deepEqual(decision.indexFingerprint, mismatchedFingerprint);
});

// FLC-08 follow-up: partial marker must not be promoted as fully completed.
test('decideInterruptedIndexingRecovery preserves limit_reached from marker indexStatus', () => {
    const decision = decideInterruptedIndexingRecovery(
        buildMarker({
            indexStatus: 'limit_reached',
            indexedFiles: 12,
            totalChunks: 450000,
        }),
        RUNTIME_FINGERPRINT,
    );

    assert.equal(decision.action, 'promote_indexed');
    assert.equal(decision.reason, 'valid_marker');
    assert.deepEqual(decision.stats, {
        indexedFiles: 12,
        totalChunks: 450000,
        status: 'limit_reached',
    });
});

test('decideInterruptedIndexingRecovery rejects current markers without indexStatus', () => {
    const marker = { ...buildMarker() } as unknown as Record<string, unknown>;
    delete marker.indexStatus;
    const decision = decideInterruptedIndexingRecovery(
        marker as unknown as IndexCompletionMarkerDocument,
        RUNTIME_FINGERPRINT,
    );
    assert.equal(decision.action, 'mark_failed');
    assert.equal(decision.reason, 'invalid_marker_payload');
});

test('decideInterruptedIndexingRecovery preserves the complete marker fingerprint', () => {
    const decision = decideInterruptedIndexingRecovery(buildMarker(), RUNTIME_FINGERPRINT);

    assert.equal(decision.action, 'promote_indexed');
    if (decision.action === 'promote_indexed') {
        assert.deepEqual(decision.indexFingerprint, RUNTIME_FINGERPRINT);
    }
});

test('decideInterruptedIndexingRecovery rejects fractional and unsafe marker counts', () => {
    for (const marker of [
        buildMarker({ indexedFiles: 1.5 }),
        buildMarker({ totalChunks: Number.MAX_SAFE_INTEGER + 1 }),
    ]) {
        const decision = decideInterruptedIndexingRecovery(marker, RUNTIME_FINGERPRINT);
        assert.equal(decision.action, 'mark_failed');
        assert.equal(decision.reason, 'invalid_marker_payload');
    }
});

test('decideInterruptedIndexingRecovery rejects malformed expanded fingerprint fields', () => {
    const marker = buildMarker({
        fingerprint: {
            ...RUNTIME_FINGERPRINT,
            parserVersion: 17,
        } as unknown as IndexFingerprint,
    });

    const decision = decideInterruptedIndexingRecovery(marker, RUNTIME_FINGERPRINT);
    assert.equal(decision.action, 'mark_failed');
    assert.equal(decision.reason, 'invalid_marker_payload');
});
