import type {
    JsonNavigationStore,
    PublicationRef,
} from "@zokizuan/satori-core";
import type { SearchReadinessDebugHint, SearchReadinessInvalidationReason } from "./search-types.js";
import type { TrackedRootReadinessState } from "./tracked-root-readiness.js";
import { PreparedReadCache } from "./prepared-read-cache.js";

type PreparedReadState = Extract<TrackedRootReadinessState, { state: "ready" }>;

export type CachedPreparedReadResult =
    | { status: "hit"; state: PreparedReadState }
    | { status: "miss"; reason: SearchReadinessInvalidationReason };

type NavigationManifestState = Awaited<ReturnType<JsonNavigationStore["getManifest"]>>;
type NavigationSymbolsByFileState = Awaited<ReturnType<JsonNavigationStore["getSymbolsByFile"]>>;
type NavigationCompatibilityState = Awaited<ReturnType<JsonNavigationStore["getCompatibilityState"]>>;
type NavigationAnalysisEvidenceState = Awaited<ReturnType<JsonNavigationStore["getAnalysisEvidenceForFiles"]>>;
type NavigationResolutionClaimsState = Awaited<ReturnType<JsonNavigationStore["getAllResolutionClaims"]>>;

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

export class PreparedReadCacheOwner {
    private readonly preparedReadCache = new PreparedReadCache<PreparedReadState>();

    public constructor(private readonly dependencies: PreparedReadCacheOwnerDependencies) {}

    public getPreparedAuthorityObservation(codebasePath: string): string | null {
        return this.dependencies.getCurrentPublication(codebasePath)?.id ?? null;
    }

    public evictPreparedRead(codebasePath: string): void {
        // Parsed navigation state is owned by the navigation store, which
        // replaces a superseded Publication and releases idle roots itself.
        this.preparedReadCache.evict(codebasePath);
    }

    private getPreparedNavigationAddress(preparedRead: PreparedReadState): {
        publicationId: string;
        navigationRoot: string;
    } | null {
        return this.dependencies.getPublicationNavigationAddress(preparedRead.publication);
    }

    private getPreparedNavigationInput(preparedRead: PreparedReadState): {
        normalizedRootPath: string;
        publicationId: string;
        navigationRoot: string;
    } | null {
        const navigation = this.getPreparedNavigationAddress(preparedRead);
        return navigation
            ? {
                normalizedRootPath: preparedRead.root.path,
                publicationId: navigation.publicationId,
                navigationRoot: navigation.navigationRoot,
            }
            : null;
    }

    private missingNavigation(root: string) {
        return {
            status: "missing" as const,
            rootPath: root,
            reason: "Publication navigation is unavailable for the prepared read",
        };
    }

    // Parsed navigation state is cached, shared and released by the navigation
    // store; these loaders only bind a prepared read to its Publication.
    public async loadPreparedNavigationManifest(
        preparedRead: PreparedReadState,
        operations?: SearchReadinessDebugHint["operations"],
    ): Promise<NavigationManifestState> {
        const input = this.getPreparedNavigationInput(preparedRead);
        if (!input) return this.missingNavigation(preparedRead.root.path);
        if (operations && !this.dependencies.navigationStore.hasResidentRegistry(input)) {
            operations.registryLoads += 1;
        }
        return this.dependencies.navigationStore.getManifest(input);
    }

    public async loadPreparedNavigationSymbolsByFile(
        preparedRead: PreparedReadState,
        file: string,
    ): Promise<NavigationSymbolsByFileState> {
        const input = this.getPreparedNavigationInput(preparedRead);
        if (!input) return this.missingNavigation(preparedRead.root.path);
        return this.dependencies.navigationStore.getSymbolsByFile({ ...input, file });
    }

    public async loadPreparedNavigationCompatibility(
        preparedRead: PreparedReadState,
        expectedSymbolRegistryManifestHash: string,
        operations?: SearchReadinessDebugHint["operations"],
    ): Promise<NavigationCompatibilityState> {
        const input = this.getPreparedNavigationInput(preparedRead);
        if (!input) {
            const missing = this.missingNavigation(preparedRead.root.path);
            return {
                rootPath: preparedRead.root.path,
                registry: missing,
                relationships: {
                    status: "not_checked" as const,
                    rootPath: preparedRead.root.path,
                    reason: missing.reason,
                },
            };
        }
        if (
            operations
            && !this.dependencies.navigationStore.hasResidentRelationships({
                ...input,
                expectedSymbolRegistryManifestHash,
            })
        ) {
            operations.navigationValidationRuns += 1;
        }
        return this.dependencies.navigationStore.getCompatibilityState({
            ...input,
            expectedSymbolRegistryManifestHash,
        });
    }

    public async loadPreparedNavigationAnalysisEvidence(
        preparedRead: PreparedReadState,
        expectedSymbolRegistryManifestHash: string,
        files: readonly string[],
    ): Promise<NavigationAnalysisEvidenceState> {
        const input = this.getPreparedNavigationInput(preparedRead);
        if (!input) return this.missingNavigation(preparedRead.root.path);
        return this.dependencies.navigationStore.getAnalysisEvidenceForFiles({
            ...input,
            expectedSymbolRegistryManifestHash,
            files,
        });
    }

    public async loadPreparedNavigationResolutionClaims(
        preparedRead: PreparedReadState,
        expectedSymbolRegistryManifestHash: string,
    ): Promise<NavigationResolutionClaimsState> {
        const input = this.getPreparedNavigationInput(preparedRead);
        if (!input) return this.missingNavigation(preparedRead.root.path);
        return this.dependencies.navigationStore.getAllResolutionClaims({
            ...input,
            expectedSymbolRegistryManifestHash,
        });
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
        this.preparedReadCache.seed(
            root,
            state,
            current.id,
            this.dependencies.clock.now(),
            preserveProofAge,
        );
    }
}
