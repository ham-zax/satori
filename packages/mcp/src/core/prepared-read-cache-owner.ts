import type {
    JsonNavigationStore,
    PublicationRef,
} from "@zokizuan/satori-core";
import type { SearchReadinessDebugHint, SearchReadinessInvalidationReason } from "./search-types.js";
import type { TrackedRootReadinessState } from "./tracked-root-readiness.js";
import { PreparedReadCache } from "./prepared-read-cache.js";

const PREPARED_NAVIGATION_CACHE_MAX_ROOTS = 32;
const PREPARED_NAVIGATION_CACHE_MAX_FILES_PER_ROOT = 64;
const PREPARED_NAVIGATION_CACHE_MAX_COMPATIBILITY_RESULTS_PER_ROOT = 8;

type PreparedReadState = Extract<TrackedRootReadinessState, { state: "ready" }>;

export type CachedPreparedReadResult =
    | { status: "hit"; state: PreparedReadState }
    | { status: "miss"; reason: SearchReadinessInvalidationReason };

type NavigationManifestState = Awaited<ReturnType<JsonNavigationStore["getManifest"]>>;
type NavigationSymbolsByFileState = Awaited<ReturnType<JsonNavigationStore["getSymbolsByFile"]>>;
type NavigationCompatibilityState = Awaited<ReturnType<JsonNavigationStore["getCompatibilityState"]>>;

// Share cold I/O as well as completed reads. Failed reads are evicted; completion
// only touches its captured entry, so an old Publication cannot replace a newer one.
type PreparedNavigationCacheEntry = {
    publicationId: string;
    manifest?: Promise<NavigationManifestState>;
    symbolsByFile: Map<string, Promise<NavigationSymbolsByFileState>>;
    compatibilityByManifestHash: Map<string, Promise<NavigationCompatibilityState>>;
};

export interface Clock {
    now(): number;
}

export interface PreparedReadCacheOwnerDependencies {
    getCurrentPublication(codebasePath: string): PublicationRef | null;
    getPublicationNavigationAddress(publication: PublicationRef): {
        publicationId: string;
        navigationRoot: string;
    } | null;
    navigationStore: JsonNavigationStore;
    clock: Clock;
}

function setBoundedCacheEntry<K, V>(
    cache: Map<K, V>,
    key: K,
    value: V,
    maxEntries: number,
): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxEntries) {
        const oldestKey = cache.keys().next().value as K | undefined;
        if (oldestKey === undefined) return;
        cache.delete(oldestKey);
    }
}

export class PreparedReadCacheOwner {
    private readonly preparedReadCache = new PreparedReadCache<PreparedReadState>();
    private readonly preparedNavigationCache = new Map<string, PreparedNavigationCacheEntry>();

    public constructor(private readonly dependencies: PreparedReadCacheOwnerDependencies) {}

    public getPreparedAuthorityObservation(codebasePath: string): string | null {
        return this.dependencies.getCurrentPublication(codebasePath)?.id ?? null;
    }

    public evictPreparedRead(codebasePath: string): void {
        this.preparedReadCache.evict(codebasePath);
        this.preparedNavigationCache.delete(codebasePath);
    }

    public getPreparedNavigationIdentity(preparedRead: PreparedReadState): string | null {
        return preparedRead.navigationStatus === "valid"
            && preparedRead.publication.publication.navigation !== null
            ? preparedRead.publication.id
            : null;
    }

    private getPreparedNavigationAddress(preparedRead: PreparedReadState): {
        publicationId: string;
        navigationRoot: string;
    } | null {
        return this.dependencies.getPublicationNavigationAddress(preparedRead.publication);
    }

    private getPreparedNavigationCacheEntry(
        root: string,
        publicationId: string,
    ): PreparedNavigationCacheEntry | undefined {
        const entry = this.preparedNavigationCache.get(root);
        if (!entry || entry.publicationId !== publicationId) return undefined;
        setBoundedCacheEntry(
            this.preparedNavigationCache,
            root,
            entry,
            PREPARED_NAVIGATION_CACHE_MAX_ROOTS,
        );
        return entry;
    }

    private storePreparedNavigationCacheEntry(
        root: string,
        publicationId: string,
        update: (entry: PreparedNavigationCacheEntry) => void,
    ): void {
        const existing = this.preparedNavigationCache.get(root);
        const entry = existing?.publicationId === publicationId
            ? existing
            : {
                publicationId,
                symbolsByFile: new Map<string, Promise<NavigationSymbolsByFileState>>(),
                compatibilityByManifestHash: new Map<string, Promise<NavigationCompatibilityState>>(),
            };
        update(entry);
        setBoundedCacheEntry(
            this.preparedNavigationCache,
            root,
            entry,
            PREPARED_NAVIGATION_CACHE_MAX_ROOTS,
        );
    }

    public async loadPreparedNavigationManifest(
        preparedRead: PreparedReadState,
        operations?: SearchReadinessDebugHint["operations"],
    ): Promise<NavigationManifestState> {
        const root = preparedRead.root.path;
        const publicationId = this.getPreparedNavigationIdentity(preparedRead);
        const cached = publicationId
            ? this.getPreparedNavigationCacheEntry(root, publicationId)?.manifest
            : undefined;
        if (cached) return cached;

        if (operations) operations.registryLoads += 1;
        const navigation = this.getPreparedNavigationAddress(preparedRead);
        if (!navigation) {
            return {
                status: "missing",
                rootPath: root,
                reason: "Publication navigation is unavailable for the prepared read",
            };
        }
        const result = this.dependencies.navigationStore.getManifest({
            normalizedRootPath: root,
            publicationId: navigation.publicationId,
            navigationRoot: navigation.navigationRoot,
        });
        if (publicationId) {
            this.storePreparedNavigationCacheEntry(root, publicationId, (entry) => {
                entry.manifest = result;
                const evict = () => { if (entry.manifest === result) delete entry.manifest; };
                void result.then((value) => { if (value.status !== "ok") evict(); }, evict);
            });
        }
        return result;
    }

    public async loadPreparedNavigationSymbolsByFile(
        preparedRead: PreparedReadState,
        file: string,
    ): Promise<NavigationSymbolsByFileState> {
        const root = preparedRead.root.path;
        const publicationId = this.getPreparedNavigationIdentity(preparedRead);
        const cached = publicationId
            ? this.getPreparedNavigationCacheEntry(root, publicationId)?.symbolsByFile.get(file)
            : undefined;
        if (cached) return cached;

        const navigation = this.getPreparedNavigationAddress(preparedRead);
        if (!navigation) {
            return {
                status: "missing",
                rootPath: root,
                reason: "Publication navigation is unavailable for the prepared read",
            };
        }
        const result = this.dependencies.navigationStore.getSymbolsByFile({
            normalizedRootPath: root,
            publicationId: navigation.publicationId,
            navigationRoot: navigation.navigationRoot,
            file,
        });
        if (publicationId) {
            this.storePreparedNavigationCacheEntry(root, publicationId, (entry) => {
                setBoundedCacheEntry(
                    entry.symbolsByFile,
                    file,
                    result,
                    PREPARED_NAVIGATION_CACHE_MAX_FILES_PER_ROOT,
                );
                const evict = () => {
                    if (entry.symbolsByFile.get(file) === result) entry.symbolsByFile.delete(file);
                };
                void result.then((value) => { if (value.status !== "ok") evict(); }, evict);
            });
        }
        return result;
    }

    public async loadPreparedNavigationCompatibility(
        preparedRead: PreparedReadState,
        expectedSymbolRegistryManifestHash: string,
        operations?: SearchReadinessDebugHint["operations"],
    ): Promise<NavigationCompatibilityState> {
        const root = preparedRead.root.path;
        const publicationId = this.getPreparedNavigationIdentity(preparedRead);
        const cached = publicationId
            ? this.getPreparedNavigationCacheEntry(root, publicationId)
                ?.compatibilityByManifestHash.get(expectedSymbolRegistryManifestHash)
            : undefined;
        if (cached) return cached;

        if (operations) operations.navigationValidationRuns += 1;
        const navigation = this.getPreparedNavigationAddress(preparedRead);
        if (!navigation) {
            const missing = {
                status: "missing" as const,
                rootPath: root,
                reason: "Publication navigation is unavailable for the prepared read",
            };
            return {
                rootPath: root,
                registry: missing,
                relationships: {
                    status: "not_checked" as const,
                    rootPath: root,
                    reason: missing.reason,
                },
            };
        }
        const result = this.dependencies.navigationStore.getCompatibilityState({
            normalizedRootPath: root,
            publicationId: navigation.publicationId,
            navigationRoot: navigation.navigationRoot,
            expectedSymbolRegistryManifestHash,
        });
        if (publicationId) {
            this.storePreparedNavigationCacheEntry(root, publicationId, (entry) => {
                setBoundedCacheEntry(
                    entry.compatibilityByManifestHash,
                    expectedSymbolRegistryManifestHash,
                    result,
                    PREPARED_NAVIGATION_CACHE_MAX_COMPATIBILITY_RESULTS_PER_ROOT,
                );
                const evict = () => {
                    if (entry.compatibilityByManifestHash.get(expectedSymbolRegistryManifestHash) === result) {
                        entry.compatibilityByManifestHash.delete(expectedSymbolRegistryManifestHash);
                    }
                };
                void result.then((value) => {
                    if (value.registry.status !== "ok" || value.relationships.status !== "ok") evict();
                }, evict);
            });
        }
        return result;
    }

    public async getCachedPreparedRead(
        codebaseRoot: string,
        operations: SearchReadinessDebugHint["operations"],
        requireNavigation = false,
    ): Promise<CachedPreparedReadResult> {
        operations.preparedCacheLookups += 1;
        const lookup = this.preparedReadCache.lookupCandidate(
            codebaseRoot,
            this.dependencies.clock.now(),
            (requestedRoot, cachedRoot) => requestedRoot === cachedRoot,
        );
        if (lookup.status === "miss") return { status: "miss", reason: lookup.reason };

        const cached = lookup.state;
        const current = this.dependencies.getCurrentPublication(cached.root.path);
        if (
            !current
            || current.id !== cached.publication.id
            || (requireNavigation && cached.navigationStatus !== "valid")
        ) {
            this.evictPreparedRead(lookup.root);
            return { status: "miss", reason: "observation_changed" };
        }
        operations.preparedCacheHits += 1;
        return { status: "hit", state: cached };
    }

    public seedPreparedRead(
        state: PreparedReadState,
        preserveProofAge: boolean,
        _statusPrepared = false,
    ): void {
        const root = state.root.path;
        const current = this.dependencies.getCurrentPublication(root);
        if (!current || current.id !== state.publication.id) {
            if (!preserveProofAge) this.evictPreparedRead(root);
            return;
        }
        const publicationId = this.getPreparedNavigationIdentity(state);
        if (this.preparedNavigationCache.get(root)?.publicationId !== publicationId) {
            this.preparedNavigationCache.delete(root);
        }
        this.preparedReadCache.seed(
            root,
            state,
            current.id,
            this.dependencies.clock.now(),
            preserveProofAge,
        );
    }
}
