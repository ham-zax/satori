import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSymbolRegistry, JsonNavigationStore, SYMBOL_REGISTRY_SCHEMA_VERSION } from '@zokizuan/satori-core';
import type { PublicationRef } from '@zokizuan/satori-core';
import type { TrackedRootReadinessState } from './tracked-root-readiness.js';
import { PreparedReadCacheOwner } from './prepared-read-cache-owner.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

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

function owner(store: JsonNavigationStore) {
    return new PreparedReadCacheOwner({
        navigationStore: store, clock: { now: () => 0 },
        getCurrentPublication: () => prepared('a').publication,
        getPublicationNavigationAddress: (publication) => ({ publicationId: publication.id, navigationRoot: `/${publication.id}/navigation` }),
    });
}

const missing = { status: 'missing', rootPath: '/repo', reason: 'fixture' } as const;

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

for (const kind of ['manifest', 'symbols', 'compatibility'] as const) {
    test(`concurrent ${kind} reads share one load, and failed results can be retried`, async () => {
        const gate = deferred<void>();
        const store = new JsonNavigationStore();
        let loads = 0;
        const read = async () => { loads += 1; await gate.promise; return missing; };
        store.getManifest = read;
        store.getSymbolsByFile = read;
        store.getCompatibilityState = async () => ({ rootPath: '/repo', registry: await read(), relationships: missing });
        const cache = owner(store);
        const load = () => kind === 'manifest'
            ? cache.loadPreparedNavigationManifest(prepared('a'))
            : kind === 'symbols'
                ? cache.loadPreparedNavigationSymbolsByFile(prepared('a'), 'a.ts')
                : cache.loadPreparedNavigationCompatibility(prepared('a'), 'manifest-a');
        const first = load();
        const second = load();
        assert.equal(loads, 1);
        gate.resolve();
        assert.deepEqual(await first, await second);
        await load();
        assert.equal(loads, 2);
    });
}

test('a rejected navigation read is shared and evicted for retry', async () => {
    const store = new JsonNavigationStore();
    const gate = deferred<Awaited<ReturnType<JsonNavigationStore['getManifest']>>>();
    let loads = 0;
    store.getManifest = () => { loads += 1; return loads === 1 ? gate.promise : Promise.resolve(missing); };
    const cache = owner(store);
    const reads = [cache.loadPreparedNavigationManifest(prepared('a')), cache.loadPreparedNavigationManifest(prepared('a'))];
    const outcomes = Promise.allSettled(reads);
    gate.reject(new Error('read failed'));
    assert.deepEqual((await outcomes).map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(loads, 1);
    await cache.loadPreparedNavigationManifest(prepared('a'));
    assert.equal(loads, 2);
});

test('an older in-flight manifest cannot repopulate the cache after a newer Publication or eviction', async () => {
    const registry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: '/repo', rootFingerprint: 'root',
            indexPolicyHash: 'policy', languageRouterVersion: 'router', extractorVersion: 'extractor',
            relationshipVersion: 'relationships', builtAt: '2026-09-09T00:00:00Z', files: [],
        }, symbols: [],
    });
    const valid = { status: 'ok', rootPath: '/repo', manifestHash: 'hash', registryManifestHash: 'hash', registry, warnings: [] } as const;
    const first = deferred<Awaited<ReturnType<JsonNavigationStore['getManifest']>>>();
    const store = new JsonNavigationStore();
    let loads = 0;
    store.getManifest = () => { loads += 1; return loads === 1 ? first.promise : Promise.resolve({ ...valid, warnings: [] }); };
    const cache = owner(store);
    const old = cache.loadPreparedNavigationManifest(prepared('a'));
    await cache.loadPreparedNavigationManifest(prepared('b'));
    first.resolve({ ...valid, warnings: [] });
    await old;
    await cache.loadPreparedNavigationManifest(prepared('b'));
    assert.equal(loads, 2);
    cache.evictPreparedRead('/repo');
    await cache.loadPreparedNavigationManifest(prepared('b'));
    assert.equal(loads, 3);
});
