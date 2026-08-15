import test from 'node:test';
import assert from 'node:assert/strict';
import type {
    ProvenVectorGenerationReceipt,
} from './contracts';
import {
    createGenerationProofCoordinator,
    IndexAuthorityCoordinator,
    type IndexAuthorityDecisionPorts,
} from './index-authority-coordinator';
import { IndexPolicyPublicationError } from './errors';
import {
    computeIndexPolicyHash,
    type IndexPolicyRuntimeBinding,
    type ResolvedIndexPolicy,
} from '../policy/index-policy-runtime-service';
import type {
    IndexCompletionFingerprint,
    IndexCompletionMarkerDocument,
} from '../vectordb/types';

const canonicalRoot = '/repo';
const policyHash = 'p'.repeat(64);
const policyDocumentDigest = 'd'.repeat(64);

function currentFingerprint(
    overrides: Partial<IndexCompletionFingerprint> = {},
): IndexCompletionFingerprint {
    return {
        embeddingProvider: 'test',
        embeddingModel: 'test-model',
        embeddingDimension: 4,
        embeddingArtifactDigest: null,
        embeddingNormalizationPolicy: 'provider_output_v1',
        vectorStoreProvider: 'LanceDB',
        schemaVersion: 'hybrid_v3',
        parserVersion: 'parser-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
        embeddingProjectionVersion: 'embedding-projection-v1',
        lexicalProjectionVersion: 'lexical-projection-v1',
        ...overrides,
    };
}

function policy(): ResolvedIndexPolicy {
    return {
        canonicalRoot,
        profile: 'default',
        customExtensions: [],
        customIgnorePatterns: [],
        fileBasedIgnorePatterns: [],
        supportedExtensions: ['.ts'],
        effectiveIgnorePatterns: [],
        policyHash,
        controlSignature: 'v1:control-signature',
    };
}

function marker(
    fingerprint: IndexCompletionFingerprint,
    navigation: IndexCompletionMarkerDocument['navigation'],
    runId = 'run-a',
): IndexCompletionMarkerDocument {
    return {
        kind: 'satori_index_completion_v3',
        codebasePath: canonicalRoot,
        fingerprint,
        indexedFiles: 1,
        totalChunks: 2,
        completedAt: '2026-08-13T00:00:00.000Z',
        runId,
        indexPolicyHash: policyHash,
        indexStatus: 'completed',
        navigation,
    };
}

function publication(markerRunId: string, manifestHash: string) {
    return {
        activationId: 'activation-a',
        sourceCheckpoint: {
            collectionName: 'chunks',
            markerRunId,
            indexPolicyHash: policyHash,
            merkleRoot: 'm'.repeat(64),
            documentDigest: 'c'.repeat(64),
        },
        graph: {
            kind: 'relationship_manifest_v2' as const,
            manifestHash,
        },
        receipt: {
            ownerId: 'owner-a',
            generation: 1,
            operationId: 'operation-a',
        },
    };
}

function buildPorts(
    fingerprint: IndexCompletionFingerprint,
    navigationObservation: { status: 'valid'; token: string },
): IndexAuthorityDecisionPorts {
    return {
        buildIndexCompletionFingerprint: () => fingerprint,
        indexPolicyRuntimeService: {
            getPolicyFileToken: () => 'policy-file-token',
            getPolicyDocumentDigest: () => policyDocumentDigest,
            getPolicyRuntimeCompatibility: () => true,
            resolveCustomIndexPolicyFileToken: () => 'policy-file-token',
        },
        resolveRepoConfigObservationToken: () => null,
        resolveNavigationObservation: () => navigationObservation,
        vectorDatabase: {
            getPublicationObservation: () => 'publication-observation',
        },
    } as unknown as IndexAuthorityDecisionPorts;
}

test('authority decisions run on IndexAuthorityCoordinator without constructing Context', async () => {
    const fingerprint = currentFingerprint();
    const coordinator = new IndexAuthorityCoordinator(
        createGenerationProofCoordinator(),
        buildPorts(fingerprint, { status: 'valid', token: 'navigation-token' }),
    );
    const activePolicy = policy();
    const activeMarker = marker(fingerprint, {
        status: 'sealed',
        generationId: 'generation-a',
        symbolRegistryManifestHash: 'symbol-manifest-a',
        relationshipManifestHash: 'relationship-manifest-a',
        sealHash: 'seal-a',
    });
    const activeBinding = {
        collectionName: 'chunks',
        policyHash,
        navigation: {
            status: 'sealed' as const,
            generationId: 'generation-a',
            sealHash: 'seal-a',
        },
        publication: publication(activeMarker.runId, 'relationship-manifest-a'),
    };
    coordinator.activatePublishedIndexPolicy(activePolicy, activeBinding);

    const authority = coordinator.resolveEffectiveNavigationAuthority(
        activeMarker,
        activePolicy,
        activeBinding,
    );
    assert.deepEqual(authority, {
        status: 'sealed',
        generationId: 'generation-a',
        sealHash: 'seal-a',
        expectedSymbolRegistryManifestHash: 'symbol-manifest-a',
        expectedRelationshipManifestHash: 'relationship-manifest-a',
        relationshipOnlyUpgrade: false,
        useBoundGeneration: true,
    });

    const observations = coordinator.getIndexAuthorityObservations(canonicalRoot);
    assert.ok(observations);
    assert.match(observations.navigation, /navigation-token/);
    assert.match(
        await coordinator.resolveGenerationProofIdentity(canonicalRoot) ?? '',
        /publication-observation/,
    );

    const receipt: ProvenVectorGenerationReceipt = {
        collectionName: 'chunks',
        marker: activeMarker,
        policy: activePolicy,
        policyDocumentDigest,
        exactPayloadCount: activeMarker.totalChunks,
        observations: {
            profileFileToken: null,
            policyFileToken: 'policy-file-token',
        },
    };
    assert.equal(
        coordinator.isPreparedVectorReceiptBoundToCurrentAuthority(canonicalRoot, receipt),
        true,
    );
});

test('authority owner preserves marker ABA and publication decision boundaries', () => {
    const fingerprint = currentFingerprint();
    const coordinator = new IndexAuthorityCoordinator(
        createGenerationProofCoordinator(),
        buildPorts(fingerprint, { status: 'valid', token: 'navigation-token' }),
    );
    const activePolicy = policy();
    const activeMarker = marker(fingerprint, {
        status: 'sealed',
        generationId: 'generation-a',
        symbolRegistryManifestHash: 'symbol-manifest-a',
        relationshipManifestHash: 'relationship-manifest-a',
        sealHash: 'seal-a',
    });
    const activeBinding = {
        collectionName: 'chunks',
        policyHash,
        navigation: {
            status: 'sealed' as const,
            generationId: 'generation-a',
            sealHash: 'seal-a',
        },
        publication: publication(activeMarker.runId, 'different-relationship-manifest'),
    };

    assert.equal(
        coordinator.indexCompletionMarkersEqual(
            activeMarker,
            coordinator.cloneIndexCompletionMarker(activeMarker),
        ),
        true,
    );
    assert.equal(
        coordinator.indexCompletionMarkersEqual(
            activeMarker,
            marker(activeMarker.fingerprint, activeMarker.navigation, 'run-b'),
        ),
        false,
    );

    const publicationAuthority = coordinator.resolveEffectiveNavigationAuthority(
        activeMarker,
        activePolicy,
        activeBinding,
    );
    assert.deepEqual(publicationAuthority, {
        status: 'sealed',
        generationId: 'generation-a',
        sealHash: 'seal-a',
        expectedRelationshipManifestHash: 'different-relationship-manifest',
        relationshipOnlyUpgrade: false,
        useBoundGeneration: true,
    });
});

test('authority owner coordinates policy publication without constructing Context', () => {
    const fingerprint = currentFingerprint();
    const publishedPolicy: ResolvedIndexPolicy = {
        canonicalRoot,
        profile: 'default',
        customExtensions: [],
        customIgnorePatterns: [],
        fileBasedIgnorePatterns: [],
        supportedExtensions: ['.ts'],
        effectiveIgnorePatterns: [],
        policyHash: computeIndexPolicyHash('default', ['.ts'], []),
        controlSignature: 'v1:default',
    };
    const events: string[] = [];
    let persistedDocument: { documentDigest: string } | undefined;
    let authority!: IndexAuthorityCoordinator;
    const runtimeState = {
        customExtensions: null,
        customIgnorePatterns: null,
        profile: undefined,
        ignoreState: null,
        wasLoaded: false,
        fileToken: undefined,
        hadFileToken: false,
        runtimeCompatible: undefined,
        documentDigest: undefined,
    };
    const ports = {
        canonicalizeCodebasePath: (value: string) => value,
        buildIndexCompletionFingerprint: () => fingerprint,
        indexPolicyDocumentStore: {
            captureDocument: () => null,
            resolvePolicyPath: () => '/policy.json',
            persistDocument: (_root: string, document: { documentDigest: string }, onCommitted?: () => void) => {
                events.push('persist-document');
                persistedDocument = document;
                onCommitted?.();
            },
            removeDocument: () => {
                throw new Error('Unexpected policy removal.');
            },
        },
        indexPolicyRuntimeService: {
            getPolicyFileToken: () => 'policy-file-token',
            getPolicyDocumentDigest: () => persistedDocument?.documentDigest,
            getPolicyRuntimeCompatibility: () => true,
            resolveCustomIndexPolicyFileToken: () => 'policy-file-token',
            captureRuntimePolicyState: () => runtimeState,
            restoreRuntimePolicyState: () => {
                events.push('restore-runtime');
            },
            activateResolvedIndexPolicy: (nextPolicy: ResolvedIndexPolicy, binding: IndexPolicyRuntimeBinding) => {
                events.push('activate-runtime');
                authority.activatePublishedIndexPolicy(nextPolicy, binding);
            },
            clearResolvedIndexPolicyRuntime: () => {
                authority.clearPublishedIndexPolicyRuntime(canonicalRoot);
            },
            setPolicyFileToken: (_root: string, token: string | null) => {
                events.push(`policy-token:${token}`);
            },
            setPolicyDocumentDigest: (_root: string, digest: string) => {
                events.push(`policy-digest:${digest}`);
            },
        },
        resolveRepoConfigObservationToken: () => null,
        resolveNavigationObservation: () => ({ status: 'not_bound' as const }),
        resolveNavigationObservationToken: () => null,
        resolveProvenGeneration: async () => null,
        vectorDatabase: {
            getPublicationObservation: () => 'publication-observation',
        },
    } as unknown as IndexAuthorityDecisionPorts;
    authority = new IndexAuthorityCoordinator(
        createGenerationProofCoordinator(),
        ports,
    );

    assert.throws(
        () => authority.publishResolvedIndexPolicy(
            publishedPolicy,
            {
                collectionName: 'chunks',
                navigation: {
                    status: 'sealed',
                    generationId: 'gen-1',
                    sealHash: 'a'.repeat(64),
                },
                publication: {
                    activationId: 'act-1',
                    sourceCheckpoint: {
                        collectionName: 'chunks',
                        markerRunId: 'marker-1',
                        indexPolicyHash: publishedPolicy.policyHash,
                        merkleRoot: 'b'.repeat(64),
                        documentDigest: 'c'.repeat(64),
                    },
                    graph: { kind: 'relationship_manifest_v2', manifestHash: 'd'.repeat(64) },
                    receipt: { ownerId: 'test', generation: 1, operationId: 'op-1' },
                },
            },
            (publish) => {
                publish();
                throw new Error('receipt acknowledgement failed');
            },
        ),
        (error: unknown) => {
            assert.ok(error instanceof IndexPolicyPublicationError);
            assert.equal(error.committed, true);
            assert.equal(error.receipt.operation, 'publish');
            assert.equal(error.receipt.documentDigest, persistedDocument?.documentDigest);
            return true;
        },
    );
    assert.deepEqual(events.slice(0, 2), ['persist-document', 'activate-runtime']);
    assert.equal(authority.getPublishedResolvedPolicy(canonicalRoot)?.policyHash, publishedPolicy.policyHash);
});

test('active publication read lease blocks the publication retention gate until released', async () => {
    const proofCoordinator = createGenerationProofCoordinator();
    const authority = new IndexAuthorityCoordinator(proofCoordinator);
    const root = '/repo/mvcc-test';

    // 1. Initial state has no active readers
    assert.equal(authority.hasActivePublicationReaders(root), false);

    // 2. Acquire actual read lease A
    const releaseReadLeaseA = await authority.acquirePublicationReadLease(root);
    assert.equal(authority.hasActivePublicationReaders(root), true);

    // 3. Start acquirePublicationRetentionLease in background
    let retentionCompleted = false;
    let releaseRetention: (() => void) | null = null;
    const retentionPromise = authority.acquirePublicationRetentionLease(root, 'activation-n1').then((rel) => {
        retentionCompleted = true;
        releaseRetention = rel;
    });

    // 4. Yield event loop ticks and prove retention has NOT completed while Reader A holds lease
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(retentionCompleted, false, 'Retention must NOT proceed while reader A holds read lease');
    assert.equal(authority.hasActivePublicationReaders(root), true);

    // 5. Release Reader A lease
    releaseReadLeaseA();

    // 6. Retention proceeds to completion
    await retentionPromise;
    assert.equal(retentionCompleted, true, 'Retention must proceed once reader A releases lease');
    assert.equal(authority.hasActivePublicationReaders(root), false);

    // 7. Clean up retention lease
    if (typeof releaseRetention === 'function') {
        (releaseRetention as () => void)();
    }
});
