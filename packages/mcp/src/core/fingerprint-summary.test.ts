import assert from 'node:assert/strict';
import test from 'node:test';

import { type IndexFingerprint, summarizeIndexFingerprint } from '../config.js';

const baseFingerprint: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-code-3',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
};

test('fingerprint summaries expose parser-only mismatches deterministically', () => {
    const indexed = summarizeIndexFingerprint({
        ...baseFingerprint,
        parserVersion: 'parser-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
    });
    const runtime = summarizeIndexFingerprint({
        ...baseFingerprint,
        parserVersion: 'parser-v2',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
    });

    assert.notEqual(indexed, runtime);
    assert.match(indexed, /\/parser=[0-9a-f]{12}\/extractor=[0-9a-f]{12}\/relationship=[0-9a-f]{12}$/);
    assert.equal(indexed, summarizeIndexFingerprint({
        ...baseFingerprint,
        parserVersion: 'parser-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
    }));
});

test('fingerprint summaries identify legacy analysis identities', () => {
    assert.equal(
        summarizeIndexFingerprint(baseFingerprint),
        'VoyageAI/voyage-code-3/1024/Milvus/hybrid_v3/parser=legacy/extractor=legacy/relationship=legacy',
    );
});
