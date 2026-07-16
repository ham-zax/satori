import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    buildCanonicalIndexPolicyDocument,
    compareIndexCompatibility,
    EMBEDDING_NORMALIZATION_POLICY_VERSION,
    inspectCompletionMarker,
    inspectIndexPolicyDocument,
    parseIndexFingerprint,
    type CanonicalCompletionMarker,
    type CanonicalIndexPolicyPayload,
} from './persisted-index-authority';
import {
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
} from './search-projections';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SYMBOL_MANIFEST = `symmanifest_${'d'.repeat(32)}`;

function fingerprint() {
    return {
        embeddingProvider: 'test',
        embeddingModel: 'test-model',
        embeddingDimension: 4,
        embeddingArtifactDigest: null,
        embeddingNormalizationPolicy: EMBEDDING_NORMALIZATION_POLICY_VERSION,
        vectorStoreProvider: 'memory',
        schemaVersion: 'schema-v1',
        parserVersion: 'parser-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
        embeddingProjectionVersion: EMBEDDING_PROJECTION_VERSION,
        lexicalProjectionVersion: LEXICAL_PROJECTION_VERSION,
    };
}

function canonicalMarker(
    navigation: CanonicalCompletionMarker['navigation'] = { status: 'not_bound' },
): CanonicalCompletionMarker {
    return {
        kind: 'satori_index_completion_v3',
        codebasePath: '/repo',
        fingerprint: fingerprint(),
        indexedFiles: 1,
        totalChunks: 2,
        completedAt: '2026-07-13T00:00:00.000Z',
        runId: 'run-1',
        indexPolicyHash: SHA_A,
        indexStatus: 'completed',
        navigation,
    };
}

test('completion marker inspector admits only complete canonical v3 shapes', () => {
    const notBound = inspectCompletionMarker(canonicalMarker());
    assert.equal(notBound.status, 'current');

    const legacyProjectionFingerprint = structuredClone(canonicalMarker());
    delete legacyProjectionFingerprint.fingerprint.embeddingArtifactDigest;
    delete legacyProjectionFingerprint.fingerprint.embeddingNormalizationPolicy;
    delete legacyProjectionFingerprint.fingerprint.embeddingProjectionVersion;
    delete legacyProjectionFingerprint.fingerprint.lexicalProjectionVersion;
    assert.equal(inspectCompletionMarker(legacyProjectionFingerprint).status, 'current');

    const partialProjectionFingerprint = structuredClone(canonicalMarker());
    delete partialProjectionFingerprint.fingerprint.lexicalProjectionVersion;
    assert.equal(inspectCompletionMarker(partialProjectionFingerprint).status, 'corrupt');

    const sealed = inspectCompletionMarker(canonicalMarker({
        status: 'sealed',
        generationId: 'generation-1',
        symbolRegistryManifestHash: SYMBOL_MANIFEST,
        relationshipManifestHash: SHA_B,
        sealHash: SHA_C,
    }));
    assert.equal(sealed.status, 'current');

    const partial = structuredClone(canonicalMarker()) as Record<string, unknown>;
    partial.navigation = { status: 'sealed', generationId: 'generation-1' };
    assert.deepEqual(inspectCompletionMarker(partial), {
        status: 'corrupt',
        reason: 'canonical completion marker navigation binding is invalid',
    });

    const mixed = { ...canonicalMarker(), navigationGenerationId: 'generation-1' };
    assert.deepEqual(inspectCompletionMarker(mixed), {
        status: 'corrupt',
        reason: 'canonical completion marker envelope is invalid',
    });
});

test('fingerprint parsing and compatibility use one deterministic field contract', () => {
    const current = fingerprint();
    assert.deepEqual(parseIndexFingerprint(current), current);

    const legacy = { ...current } as Partial<typeof current>;
    delete legacy.embeddingArtifactDigest;
    delete legacy.embeddingNormalizationPolicy;
    delete legacy.embeddingProjectionVersion;
    delete legacy.lexicalProjectionVersion;
    assert.deepEqual(compareIndexCompatibility(legacy, current), {
        status: 'requires_reindex',
        differingFields: [
            'embeddingArtifactDigest',
            'embeddingNormalizationPolicy',
            'embeddingProjectionVersion',
            'lexicalProjectionVersion',
        ],
    });

    const oldestSupported = {
        embeddingProvider: current.embeddingProvider,
        embeddingModel: current.embeddingModel,
        embeddingDimension: current.embeddingDimension,
        vectorStoreProvider: current.vectorStoreProvider,
        schemaVersion: current.schemaVersion,
    };
    assert.deepEqual(compareIndexCompatibility(oldestSupported, current), {
        status: 'requires_reindex',
        differingFields: [
            'embeddingArtifactDigest',
            'embeddingNormalizationPolicy',
            'parserVersion',
            'extractorVersion',
            'relationshipVersion',
            'embeddingProjectionVersion',
            'lexicalProjectionVersion',
        ],
    });

    assert.deepEqual(compareIndexCompatibility({ ...current, parserVersion: 'parser-v2' }, current), {
        status: 'requires_reindex',
        differingFields: ['parserVersion'],
    });
    assert.equal(parseIndexFingerprint({ ...legacy, embeddingProjectionVersion: 'partial' }), null);
    assert.deepEqual(compareIndexCompatibility({ ...current, embeddingDimension: 0 }, current), {
        status: 'malformed',
        reason: 'persisted index fingerprint is malformed',
    });

    const incompleteRuntime = { ...current } as Partial<typeof current>;
    delete incompleteRuntime.relationshipVersion;
    assert.deepEqual(compareIndexCompatibility(
        current,
        incompleteRuntime as ReturnType<typeof fingerprint>,
    ), {
        status: 'malformed',
        reason: 'runtime index fingerprint is malformed',
    });

    const legacyRuntime = { ...current } as Partial<typeof current>;
    delete legacyRuntime.embeddingArtifactDigest;
    delete legacyRuntime.embeddingNormalizationPolicy;
    delete legacyRuntime.parserVersion;
    delete legacyRuntime.extractorVersion;
    delete legacyRuntime.relationshipVersion;
    delete legacyRuntime.embeddingProjectionVersion;
    delete legacyRuntime.lexicalProjectionVersion;
    assert.deepEqual(compareIndexCompatibility(
        legacyRuntime,
        legacyRuntime as ReturnType<typeof fingerprint>,
    ), {
        status: 'malformed',
        reason: 'runtime index fingerprint is malformed',
    });

    const future = { ...current, localModelDigest: 'sha256:future' };
    assert.equal(parseIndexFingerprint(future), null);
    assert.deepEqual(compareIndexCompatibility(future, current), {
        status: 'malformed',
        reason: 'persisted index fingerprint is malformed',
    });
});

test('completion marker inspector requires reindex for every retired marker schema', () => {
    const legacyV2 = {
        ...canonicalMarker(),
        kind: 'satori_index_completion_v2',
        navigationGenerationId: 'generation-1',
        symbolRegistryManifestHash: SYMBOL_MANIFEST,
        relationshipManifestHash: SHA_B,
        navigationSealHash: SHA_C,
    };
    delete (legacyV2 as { navigation?: unknown }).navigation;
    assert.deepEqual(inspectCompletionMarker(legacyV2), {
        status: 'requires_reindex',
        reason: 'completion marker v2 requires reindex',
        ownership: {
            kind: 'satori_index_completion_v2',
            codebasePath: '/repo',
        },
    });

    const preSeal = { ...legacyV2 } as Record<string, unknown>;
    delete preSeal.navigationSealHash;
    assert.deepEqual(inspectCompletionMarker(preSeal), {
        status: 'requires_reindex',
        reason: 'completion marker v2 requires reindex',
        ownership: {
            kind: 'satori_index_completion_v2',
            codebasePath: '/repo',
        },
    });

    const missingAnalyzerIdentity = structuredClone(legacyV2) as Record<string, unknown>;
    delete (missingAnalyzerIdentity.fingerprint as Record<string, unknown>).relationshipVersion;
    assert.deepEqual(inspectCompletionMarker(missingAnalyzerIdentity), {
        status: 'requires_reindex',
        reason: 'completion marker v2 requires reindex',
    });

    assert.deepEqual(inspectCompletionMarker({ kind: 'satori_index_completion_v1' }), {
        status: 'requires_reindex',
        reason: 'completion marker v1 requires reindex',
    });

    const legacyV1 = {
        kind: 'satori_index_completion_v1',
        codebasePath: '/repo',
        fingerprint: fingerprint(),
        indexedFiles: 1,
        totalChunks: 2,
        completedAt: '2026-07-10T00:00:00.000Z',
        runId: 'legacy-v1',
    };
    assert.deepEqual(inspectCompletionMarker(legacyV1), {
        status: 'requires_reindex',
        reason: 'completion marker v1 requires reindex',
        ownership: {
            kind: 'satori_index_completion_v1',
            codebasePath: '/repo',
        },
    });
});

function policyPayload(
    navigation: CanonicalIndexPolicyPayload['navigation'] = { status: 'not_bound' },
): CanonicalIndexPolicyPayload {
    return {
        schemaVersion: 'satori_index_policy_v3',
        canonicalRoot: '/repo',
        customExtensions: [],
        customIgnorePatterns: [],
        fileBasedIgnorePatterns: [],
        profile: 'default',
        supportedExtensions: ['.ts'],
        effectiveIgnorePatterns: [],
        policyHash: SHA_A,
        collectionName: 'collection-1',
        navigation,
    };
}

test('policy inspector uses one fixed canonical v3 digest payload', () => {
    const document = buildCanonicalIndexPolicyDocument(policyPayload({
        status: 'sealed',
        generationId: 'generation-1',
        sealHash: SHA_C,
    }));
    const inspected = inspectIndexPolicyDocument(document, '/repo');
    assert.equal(inspected.status, 'current');

    const tampered = { ...document, collectionName: 'collection-2' };
    assert.deepEqual(inspectIndexPolicyDocument(tampered, '/repo'), {
        status: 'corrupt',
        reason: 'canonical index policy document digest is invalid',
    });

    const mixed = { ...document, navigationGenerationId: 'generation-1' };
    assert.deepEqual(inspectIndexPolicyDocument(mixed, '/repo'), {
        status: 'corrupt',
        reason: 'canonical index policy payload is invalid',
    });
});

test('policy inspector requires reindex for every retired policy schema', () => {
    const payloadBase = {
        schemaVersion: 'satori_index_policy_v2',
        canonicalRoot: '/repo',
        customExtensions: [],
        customIgnorePatterns: [],
        fileBasedIgnorePatterns: [],
        profile: 'default',
        supportedExtensions: ['.ts'],
        effectiveIgnorePatterns: [],
        policyHash: SHA_A,
        collectionName: 'collection-1',
        navigationGenerationId: 'generation-1',
    };
    const legacyPreSeal = {
        ...payloadBase,
        documentDigest: crypto.createHash('sha256').update(JSON.stringify(payloadBase)).digest('hex'),
    };
    assert.deepEqual(inspectIndexPolicyDocument(legacyPreSeal, '/repo'), {
        status: 'requires_reindex',
        reason: 'index policy v2 requires reindex',
    });

    const sealedPayload = { ...payloadBase, navigationSealHash: SHA_C };
    const legacySealed = {
        ...sealedPayload,
        documentDigest: crypto.createHash('sha256').update(JSON.stringify(sealedPayload)).digest('hex'),
    };
    assert.deepEqual(inspectIndexPolicyDocument(legacySealed, '/repo'), {
        status: 'requires_reindex',
        reason: 'index policy v2 requires reindex',
    });
});

test('authority inspectors reserve unsupported for recognizable numeric future schemas', () => {
    for (const kind of ['satori_index_completion_v4', 'satori_index_completion_v99']) {
        assert.deepEqual(inspectCompletionMarker({ kind }), {
            status: 'unsupported',
            reason: 'completion marker schema is unsupported',
        });
    }
    for (const schemaVersion of ['satori_index_policy_v4', 'satori_index_policy_v99']) {
        assert.deepEqual(inspectIndexPolicyDocument({ schemaVersion }, '/repo'), {
            status: 'unsupported',
            reason: 'index policy schema is unsupported',
        });
    }
});

test('authority inspectors classify arbitrary and nonexistent older schemas as corrupt', () => {
    for (const value of [
        {},
        { kind: 'garbage' },
        { kind: 'satori_index_completion_beta' },
    ]) {
        assert.deepEqual(inspectCompletionMarker(value), {
            status: 'corrupt',
            reason: 'completion marker schema is invalid',
        });
    }
    for (const value of [
        {},
        { schemaVersion: 'garbage' },
        { schemaVersion: 'satori_index_policy_beta' },
        { schemaVersion: 'satori_index_policy_v1' },
    ]) {
        assert.deepEqual(inspectIndexPolicyDocument(value, '/repo'), {
            status: 'corrupt',
            reason: 'index policy schema is invalid',
        });
    }
});
