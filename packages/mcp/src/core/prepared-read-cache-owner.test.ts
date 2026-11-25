import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonNavigationStore } from '@satori-code/core';
import type { PublicationRef } from '@satori-code/core';
import type { TrackedRootReadinessState } from './tracked-root-readiness.js';
import { PreparedReadCacheOwner } from './prepared-read-cache-owner.js';

function prepared(id: string, root = '/repo'): Extract<TrackedRootReadinessState, { state: 'ready' }> {
    const publication: PublicationRef = {
        id,
        publication: {
            version: 2, id, canonicalRoot: root, createdAt: '2026-09-09T00:00:00Z', status: 'complete',
            packageOwnership: false,
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
        publication, navigationStatus: 'valid',
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

test('prepared relationship readiness verifies the bound publication without loading graph records', async (t) => {
    const state = prepared('publication');
    const navigationRoot = '/repo/state/publication/navigation';
    const relationshipManifestHash = 'a'.repeat(64);
    state.publication = {
        ...state.publication,
        publication: {
            ...state.publication.publication,
            navigation: { relativeRoot: 'navigation', relationshipManifestHash },
        },
    };
    const navigationStore = new JsonNavigationStore();
    const expected = {
        status: 'missing',
        rootPath: navigationRoot,
        reason: 'relationship manifest is missing',
    } as const;
    const verify = t.mock.method(navigationStore, 'verifyRelationships', async () => expected);
    const loadGraph = t.mock.method(navigationStore, 'getRelationships');
    const cache = new PreparedReadCacheOwner({
        navigationStore,
        clock: { now: () => 0 },
        getCurrentPublication: () => state.publication,
        getPublicationNavigationAddress: () => ({ publicationId: state.publication.id, navigationRoot }),
    });

    assert.equal(await cache.verifyPreparedNavigationRelationships(state, 'registry-hash'), expected);
    assert.deepEqual(verify.mock.calls.map(({ arguments: [input] }) => input), [{
        normalizedRootPath: state.root.path,
        publicationId: state.publication.id,
        navigationRoot,
        expectedSymbolRegistryManifestHash: 'registry-hash',
        expectedRelationshipManifestHash: relationshipManifestHash,
    }]);
    assert.equal(loadGraph.mock.callCount(), 0);
});
