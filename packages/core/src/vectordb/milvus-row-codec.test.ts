import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertMilvusSearchableDocumentIds,
    decodeMilvusCandidate,
    encodeMilvusSearchableDocument,
} from './milvus-row-codec';

function document(overrides: Partial<Parameters<typeof encodeMilvusSearchableDocument>[0]> = {}) {
    return {
        id: 'chunk-1',
        vector: [0.1, 0.2],
        content: 'source',
        relativePath: 'src/source.ts',
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        metadata: {},
        ...overrides,
    };
}

test('Milvus row decoding preserves transport-specific score semantics', () => {
    const row = { score: 0.4, distance: 0.8 };

    assert.equal(decodeMilvusCandidate(row, { scoreSource: 'score' }).score, 0.4);
    assert.equal(
        decodeMilvusCandidate(row, { scoreSource: 'score-then-distance' }).score,
        0.4,
    );
    assert.equal(
        decodeMilvusCandidate(row, { scoreSource: 'distance-then-score' }).score,
        0.8,
    );
    assert.equal(
        decodeMilvusCandidate({ distance: 0.8 }, { scoreSource: 'score' }).score,
        0,
    );
});

test('Milvus COSINE response values preserve the higher-is-better candidate contract', () => {
    const lessSimilar = decodeMilvusCandidate(
        { id: 'less-similar', distance: 0.1 },
        { scoreSource: 'distance-then-score' },
    );
    const moreSimilar = decodeMilvusCandidate(
        { id: 'more-similar', distance: 0.9 },
        { scoreSource: 'distance-then-score' },
    );

    assert.ok(moreSimilar.score > lessSimilar.score);
});

test('Milvus searchable mutations reject the physical control discriminator', () => {
    assert.throws(() => encodeMilvusSearchableDocument(document({
        fileExtension: '.satori_meta',
    })), /reserved control extension/);
    assert.throws(() => encodeMilvusSearchableDocument(document({
        id: '__satori_index_completion_marker_v1__',
    })), /reserved for a control record/);
    assert.throws(() => assertMilvusSearchableDocumentIds([
        '__satori_index_completion_marker_v1__',
    ]), /cannot target reserved control ID/);
});
