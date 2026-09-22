import assert from 'node:assert/strict';
import test from 'node:test';

import type { PublicationRef } from '@zokizuan/satori-core';
import {
    TrackedRootReadiness,
    type TrackedRootReadinessHost,
} from './tracked-root-readiness.js';

function publication(root: string): PublicationRef {
    return {
        id: 'publication-1',
        publication: {
            version: 1,
            id: 'publication-1',
            canonicalRoot: root,
            createdAt: '2026-09-22T00:00:00.000Z',
            status: 'complete',
            policy: {
                profile: 'default',
                customExtensions: [],
                customIgnorePatterns: [],
                fileBasedIgnorePatterns: [],
                supportedExtensions: ['.ts'],
                effectiveIgnorePatterns: [],
                policyHash: 'policy',
                controlSignature: 'control',
            },
            format: {
                indexFormatVersion: 'hybrid_v3',
                embeddingIdentity: 'fixture',
                relationshipVersion: 'relationship_v3',
            },
            vector: {
                collectionName: 'collection-1',
                indexedFiles: 1,
                totalChunks: 1,
            },
            navigation: { relativeRoot: 'navigation' },
        },
    };
}

test('parallel cold readiness checks share one root evaluation flight', async () => {
    const root = '/repo';
    let completionProofCalls = 0;
    let collectionProbeCalls = 0;
    let releaseProof!: () => void;
    const proofBlocked = new Promise<void>((resolve) => {
        releaseProof = resolve;
    });

    const host = {
        isPathWithinCodebase: (targetPath: string, rootPath: string) => targetPath === rootPath,
        listTrackedRoots: () => [{
            path: root,
            info: { status: 'indexed' as const },
        }],
        validateCompletionProof: async () => {
            completionProofCalls += 1;
            await proofBlocked;
            return {
                outcome: 'valid' as const,
                publication: publication(root),
                navigationStatus: 'valid' as const,
            };
        },
        probeLocalSearchCollectionState: async () => {
            collectionProbeCalls += 1;
            return { state: 'ready' as const, collectionName: 'collection-1' };
        },
    } as unknown as TrackedRootReadinessHost;

    const readiness = new TrackedRootReadiness(host);
    const reads = Array.from({ length: 5 }, () => (
        readiness.prepareTrackedRootForRead(root, 'semantic')
    ));

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completionProofCalls, 1);

    releaseProof();
    const results = await Promise.all(reads);
    assert.equal(results.every((result) => result.state === 'ready'), true);
    assert.equal(completionProofCalls, 1);
    assert.equal(collectionProbeCalls, 1);

    const next = await readiness.prepareTrackedRootForRead(root, 'semantic');
    assert.equal(next.state, 'ready');
    assert.equal(completionProofCalls, 2);
    assert.equal(collectionProbeCalls, 2);
});
