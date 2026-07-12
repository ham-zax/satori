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

test('validateCompletionProof rejects unsafe marker counts', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => marker({
            totalChunks: Number.MAX_SAFE_INTEGER + 1,
        }),
    });

    assert.equal(result.outcome, 'stale_local');
    assert.equal(result.reason, 'invalid_payload');
});

test('validateCompletionProof requires reindex when a legacy marker lacks parser identity', async () => {
    const currentFingerprint: IndexFingerprint = {
        ...RUNTIME_FINGERPRINT,
        parserVersion: 'oxc-0.139.0+web-tree-sitter-0.26.10+vscode-grammars-0.3.1+scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
        extractorVersion: 'language-analysis-v4+oxc-0.139.0+web-tree-sitter-0.26.10+vscode-grammars-0.3.1+scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
        relationshipVersion: 'relationship-v3+utf8-normalized-analysis',
    };
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: currentFingerprint,
        getIndexCompletionMarker: async () => marker(),
    });

    assert.equal(result.outcome, 'fingerprint_mismatch');
});

test('validateCompletionProof requires reindex for v3 extractor and relationship-v2 indexes', async () => {
    const parserVersion = 'oxc-0.139.0+web-tree-sitter-0.26.10+vscode-grammars-0.3.1+scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3';
    const runtimeFingerprint: IndexFingerprint = {
        ...RUNTIME_FINGERPRINT,
        parserVersion,
        extractorVersion: `language-analysis-v4+${parserVersion}`,
        relationshipVersion: 'relationship-v3+utf8-normalized-analysis',
    };
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint,
        getIndexCompletionMarker: async () => marker({
            fingerprint: {
                ...RUNTIME_FINGERPRINT,
                parserVersion,
                extractorVersion: `language-analysis-v3+${parserVersion}`,
                relationshipVersion: 'relationship-v2+normalized-language-analysis',
            },
        }),
    });

    assert.equal(result.outcome, 'fingerprint_mismatch');
});

test('validateCompletionProof retains partial status and the complete fingerprint', async () => {
    const fingerprint: IndexFingerprint = {
        ...RUNTIME_FINGERPRINT,
        parserVersion: 'parser-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationships-v1',
    };
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: fingerprint,
        getIndexCompletionMarker: async () => marker({
            fingerprint,
            indexStatus: 'limit_reached',
        }),
    });

    assert.equal(result.outcome, 'valid');
    assert.equal(result.marker?.indexStatus, 'limit_reached');
    assert.deepEqual(result.marker?.fingerprint, fingerprint);
});

test('validateCompletionProof normalizes a legacy marker status to completed', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => marker(),
    });

    assert.equal(result.outcome, 'valid');
    assert.equal(result.marker?.indexStatus, 'completed');
});

test('validateCompletionProof rejects malformed expanded fingerprint fields', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => marker({
            fingerprint: {
                ...RUNTIME_FINGERPRINT,
                relationshipVersion: false,
            },
        }),
    });

    assert.equal(result.outcome, 'stale_local');
    assert.equal(result.reason, 'invalid_payload');
});
