import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompletionProof } from './completion-proof.js';
import type { IndexFingerprint } from '../config.js';

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
    relationshipVersion: 'relationship-v1',
    embeddingProjectionVersion: 'embedding_projection_v1',
    lexicalProjectionVersion: 'lexical_projection_v1',
};

const POLICY_HASH = 'a'.repeat(64);
const SYMBOL_MANIFEST_HASH = `symmanifest_${'b'.repeat(32)}`;
const RELATIONSHIP_MANIFEST_HASH = 'c'.repeat(64);
const NAVIGATION_SEAL_HASH = 'd'.repeat(64);

function marker(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'satori_index_completion_v3',
        codebasePath: '/repo/a',
        fingerprint: { ...RUNTIME_FINGERPRINT },
        indexedFiles: 10,
        totalChunks: 25,
        completedAt: '2026-02-28T08:00:00.000Z',
        runId: 'run_123',
        indexPolicyHash: POLICY_HASH,
        indexStatus: 'completed',
        navigation: { status: 'not_bound' },
        ...overrides
    };
}

function sealedMarker() {
    return marker({
        navigation: {
            status: 'sealed',
            generationId: 'generation-a',
            symbolRegistryManifestHash: SYMBOL_MANIFEST_HASH,
            relationshipManifestHash: RELATIONSHIP_MANIFEST_HASH,
            sealHash: NAVIGATION_SEAL_HASH,
        },
    });
}

function generationReceipt(overrides: Record<string, unknown> = {}) {
    return {
        collectionName: 'generation-b',
        marker: sealedMarker(),
        policy: {
            canonicalRoot: '/repo/a',
            profile: 'default',
            customExtensions: [],
            customIgnorePatterns: [],
            fileBasedIgnorePatterns: [],
            supportedExtensions: ['.ts'],
            effectiveIgnorePatterns: [],
            policyHash: POLICY_HASH,
        },
        policyDocumentDigest: 'a'.repeat(64),
        exactPayloadCount: 25,
        navigation: {
            generationId: 'generation-a',
            generationRoot: '/state/generation-a',
            symbolRegistryManifestHash: SYMBOL_MANIFEST_HASH,
            relationshipManifestHash: RELATIONSHIP_MANIFEST_HASH,
            navigationSealHash: NAVIGATION_SEAL_HASH,
        },
        observations: {
            profileFileToken: null,
            policyFileToken: 'policy-token',
            navigationToken: 'navigation-token',
        },
        ...overrides,
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

test('validateCompletionProof preserves deterministic policy-authority corruption', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => ({ status: 'policy_authority_invalid' }),
    });

    assert.equal(result.outcome, 'policy_incompatible');
    assert.equal(result.reason, 'invalid_policy_authority');
});

test('validateCompletionProof preserves an explicitly unbound navigation generation', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => ({
            status: 'valid_v3',
            collectionName: 'generation-b',
            marker: marker(),
            navigationProof: {
                status: 'not_bound',
            },
        }),
    });

    assert.equal(result.outcome, 'valid');
    assert.equal(result.navigationStatus, 'not_bound');
    assert.equal(result.generationReceipt, undefined);
});

test('validateCompletionProof rejects navigation evidence that contradicts the marker binding', async () => {
    const contradictoryEvidence = [
        {
            marker: sealedMarker(),
            navigationProof: { status: 'not_bound' },
        },
        {
            marker: marker(),
            navigationProof: { status: 'valid' },
            generationReceipt: generationReceipt(),
        },
        {
            marker: marker(),
            navigationProof: { status: 'not_bound' },
            generationReceipt: generationReceipt(),
        },
    ];

    for (const evidence of contradictoryEvidence) {
        const result = await validateCompletionProof({
            codebasePath: '/repo/a',
            getIndexCompletionMarker: async () => ({
                status: 'valid_v3',
                collectionName: 'generation-b',
                ...evidence,
            }),
        });

        assert.equal(result.outcome, 'stale_local');
        assert.equal(result.reason, 'invalid_payload');
    }
});

test('validateCompletionProof requires a marker-bound generation receipt for valid navigation evidence', async () => {
    const invalidReceipts = [
        undefined,
        { malformed: true },
        generationReceipt({
            navigation: {
                ...generationReceipt().navigation,
                navigationSealHash: 'e'.repeat(64),
            },
        }),
    ];

    for (const suppliedReceipt of invalidReceipts) {
        const result = await validateCompletionProof({
            codebasePath: '/repo/a',
            getIndexCompletionMarker: async () => ({
                status: 'valid_v3',
                collectionName: 'generation-b',
                marker: sealedMarker(),
                navigationProof: { status: 'valid' },
                ...(suppliedReceipt === undefined
                    ? {}
                    : { generationReceipt: suppliedReceipt }),
            }),
        });

        assert.equal(result.outcome, 'stale_local');
        assert.equal(result.reason, 'invalid_payload');
    }
});

test('validateCompletionProof derives fail-closed navigation status when additive evidence is absent', async () => {
    const unbound = await validateCompletionProof({
        codebasePath: '/repo/a',
        getIndexCompletionMarker: async () => ({
            status: 'valid_v3',
            collectionName: 'generation-b',
            marker: marker(),
        }),
    });
    assert.equal(unbound.outcome, 'valid');
    assert.equal(unbound.navigationStatus, 'not_bound');

    const sealed = await validateCompletionProof({
        codebasePath: '/repo/a',
        getIndexCompletionMarker: async () => ({
            status: 'valid_v3',
            collectionName: 'generation-b',
            marker: sealedMarker(),
        }),
    });
    assert.equal(sealed.outcome, 'valid');
    assert.equal(sealed.navigationStatus, 'unverified');
});

test('validateCompletionProof preserves the proven bound collection identity', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        getIndexCompletionMarker: async () => ({
            status: 'valid_v3',
            collectionName: 'generation-b',
            marker: marker(),
        }),
    });

    assert.equal(result.outcome, 'valid');
    assert.equal(result.collectionName, 'generation-b');
});

test('validateCompletionProof accepts only a fully bound cloned generation receipt', async () => {
    const supplied = generationReceipt();
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        getIndexCompletionMarker: async () => ({
            status: 'valid_v3',
            collectionName: 'generation-b',
            marker: sealedMarker(),
            generationReceipt: supplied,
            exactPayloadRecounts: 0,
            proofSource: 'activation',
        }),
    });
    assert.equal(result.outcome, 'valid');
    assert.ok(result.generationReceipt);
    assert.equal(result.navigationStatus, 'valid');
    assert.equal(result.exactPayloadRecounts, 0);
    assert.equal(result.proofSource, 'activation');
    assert.notEqual(result.generationReceipt, supplied);
    (supplied.policy.customExtensions as string[]).push('.forged');
    assert.deepEqual(result.generationReceipt?.policy.customExtensions, []);

    for (const malformed of [
        generationReceipt({ collectionName: 'generation-c' }),
        generationReceipt({ exactPayloadCount: 24 }),
        generationReceipt({ policy: { ...generationReceipt().policy, canonicalRoot: '/repo/other' } }),
        generationReceipt({ marker: {} }),
    ]) {
        const rejected = await validateCompletionProof({
            codebasePath: '/repo/a',
            getIndexCompletionMarker: async () => ({
                status: 'valid_v3',
                collectionName: 'generation-b',
                marker: sealedMarker(),
                generationReceipt: malformed,
            }),
        });
        assert.equal(rejected.outcome, 'valid');
        assert.equal(rejected.generationReceipt, undefined);
        assert.equal(rejected.navigationStatus, 'unverified');
    }
});

test('validateCompletionProof falls back to a valid generation receipt when additive vector evidence is malformed', async () => {
    const supplied = generationReceipt();
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        getIndexCompletionMarker: async () => ({
            status: 'valid_v3',
            collectionName: 'generation-b',
            marker: sealedMarker(),
            generationReceipt: supplied,
            vectorReceipt: { malformed: true },
        }),
    });

    assert.equal(result.outcome, 'valid');
    assert.ok(result.generationReceipt);
    assert.equal(result.vectorReceipt?.collectionName, 'generation-b');
});

test('validateCompletionProof requires reindex for old flat navigation markers', async () => {
    for (const invalidMarker of [marker({
        kind: 'satori_index_completion_v2',
        navigation: undefined,
        navigationSealHash: NAVIGATION_SEAL_HASH,
    })]) {
        const result = await validateCompletionProof({
            codebasePath: '/repo/a',
            getIndexCompletionMarker: async () => invalidMarker,
        });
        assert.equal(result.outcome, 'stale_local');
        assert.equal(result.reason, 'requires_reindex');
    }
});

test('validateCompletionProof rejects a receipt whose navigation seal is not marker-bound', async () => {
    const sealedMarker = marker({
        navigation: {
            status: 'sealed',
            generationId: 'generation-a',
            symbolRegistryManifestHash: SYMBOL_MANIFEST_HASH,
            relationshipManifestHash: RELATIONSHIP_MANIFEST_HASH,
            sealHash: NAVIGATION_SEAL_HASH,
        },
    });
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        getIndexCompletionMarker: async () => ({
            status: 'valid_v3',
            collectionName: 'generation-b',
            marker: sealedMarker,
            generationReceipt: generationReceipt({
                marker: sealedMarker,
                navigation: {
                    generationId: 'generation-a',
                    generationRoot: '/state/generation-a',
                    symbolRegistryManifestHash: SYMBOL_MANIFEST_HASH,
                    relationshipManifestHash: RELATIONSHIP_MANIFEST_HASH,
                    navigationSealHash: 'e'.repeat(64),
                },
                observations: {
                    profileFileToken: null,
                    policyFileToken: 'policy-token',
                    navigationToken: 'navigation-token',
                },
            }),
        }),
    });
    assert.equal(result.outcome, 'valid');
    assert.equal(result.generationReceipt, undefined);
});

test('validateCompletionProof requires reindex for raw v1 markers', async () => {
    const legacy = marker();
    delete (legacy as Record<string, unknown>).indexPolicyHash;
    (legacy as Record<string, unknown>).kind = 'satori_index_completion_v1';
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => legacy,
    });
    assert.equal(result.outcome, 'stale_local');
    assert.equal(result.reason, 'requires_reindex');
});

test('validateCompletionProof requires reindex for structured legacy evidence', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => ({
            status: 'requires_reindex',
        }),
    });
    assert.equal(result.outcome, 'stale_local');
    assert.equal(result.reason, 'requires_reindex');
});

test('validateCompletionProof fails closed distinctly for unsupported future marker authority', async () => {
    const futureMarker = marker({ kind: 'satori_index_completion_v4' });
    const rawResult = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => futureMarker,
    });
    assert.deepEqual(rawResult, {
        outcome: 'stale_local',
        reason: 'unsupported_authority',
    });

    const structuredResult = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => ({ status: 'unsupported_authority' }),
    });
    assert.deepEqual(structuredResult, {
        outcome: 'stale_local',
        reason: 'unsupported_authority',
    });
});

test('validateCompletionProof does not misclassify malformed marker kinds as future authority', async () => {
    for (const kind of ['garbage', 'satori_index_completion_beta']) {
        const result = await validateCompletionProof({
            codebasePath: '/repo/a',
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            getIndexCompletionMarker: async () => marker({ kind }),
        });
        assert.deepEqual(result, {
            outcome: 'stale_local',
            reason: 'invalid_marker_kind',
        });
    }
});

test('validateCompletionProof distinguishes runtime policy incompatibility from marker corruption', async () => {
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => ({ status: 'runtime_policy_incompatible' }),
    });

    assert.deepEqual(result, {
        outcome: 'policy_incompatible',
        reason: 'runtime_policy_incompatible',
    });
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

test('validateCompletionProof requires reindex for every v2 marker', async () => {
    const currentFingerprint: IndexFingerprint = {
        ...RUNTIME_FINGERPRINT,
        parserVersion: 'oxc-0.139.0+web-tree-sitter-0.26.10+vscode-grammars-0.3.1+scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
        extractorVersion: 'language-analysis-v4+oxc-0.139.0+web-tree-sitter-0.26.10+vscode-grammars-0.3.1+scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
        relationshipVersion: 'relationship-v3+utf8-normalized-analysis',
    };
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: currentFingerprint,
        getIndexCompletionMarker: async () => marker({
            kind: 'satori_index_completion_v2',
            navigation: undefined,
        }),
    });

    assert.equal(result.outcome, 'stale_local');
    assert.equal(result.reason, 'requires_reindex');
});

test('validateCompletionProof detects fingerprint mismatch for canonical v3 markers', async () => {
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

test('validateCompletionProof requires an explicit canonical marker status', async () => {
    const withoutStatus = marker();
    delete withoutStatus.indexStatus;
    const result = await validateCompletionProof({
        codebasePath: '/repo/a',
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        getIndexCompletionMarker: async () => withoutStatus,
    });

    assert.equal(result.outcome, 'stale_local');
    assert.equal(result.reason, 'invalid_payload');
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
