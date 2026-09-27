import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonNavigationStore } from '@zokizuan/satori-core';
import type { PublicationRef } from '@zokizuan/satori-core';
import type { TrackedRootReadinessState } from './tracked-root-readiness.js';
import { PreparedReadCacheOwner } from './prepared-read-cache-owner.js';

function prepared(id: string, root = '/repo'): Extract<TrackedRootReadinessState, { state: 'ready' }> {
    const publication: PublicationRef = {
        id,
        publication: {
            version: 1, id, canonicalRoot: root, createdAt: '2026-09-09T00:00:00Z', status: 'complete',
            policy: {
                profile: 'default', customExtensions: [], customIgnorePatterns: [], fileBasedIgnorePatterns: [],
                supportedExtensions: ['.ts'], effectiveIgnorePatterns: [], policyHash: 'policy', controlSignature: 'control',
            },
            format: { indexFormatVersion: 'hybrid_v3', embeddingIdentity: 'fixture', relationshipVersion: 'fixture' },
            vector: { collectionName: id, indexedFiles: 0, totalChunks: 0 },
            navigation: { relativeRoot: 'navigation' },
        },
    };
    return {
        state: 'ready', root: { path: root, info: { status: 'indexed' } },
        publication, navigationStatus: 'valid', navigationAuthorityMode: 'canonical_v4',
    };
}

test('readiness cache never substitutes an overlapping root in either warm-up order', async () => {
    const parent = prepared('parent');
    const child = prepared('child', '/repo/child');
    const states = [parent, child];
    for (const order of [states, [...states].reverse()]) {
        const cache = new PreparedReadCacheOwner({
            navigationStore: new JsonNavigationStore(), clock: { now: () => 0 },
            getCurrentPublication: (root) => states.find((state) => state.root.path === root)?.publication ?? null,
            getPublicationNavigationAddress: () => null,
        });
        const operations = { preparedCacheLookups: 0, preparedCacheHits: 0, coldReadinessChecks: 0,
            postFreshnessColdChecks: 0, warmReceiptRevalidations: 0, registryLoads: 0, navigationValidationRuns: 0 };
        cache.seedPreparedRead(order[0], false);
        assert.equal((await cache.getCachedPreparedRead(order[1].root.path, operations)).status, 'miss');
        cache.seedPreparedRead(order[1], false);
        for (const state of states) {
            const result = await cache.getCachedPreparedRead(state.root.path, operations);
            assert.equal(result.status, 'hit');
            if (result.status === 'hit') assert.equal(result.state.publication.id, state.publication.id);
        }
    }
});
