import crypto from "node:crypto";
import {
    COLLECTION_LIMIT_MESSAGE,
    type PublicationLease,
    type PublicationRef,
    JsonNavigationStore,
    type Reranker,
} from "@zokizuan/satori-core";
import type { SemanticSearchCandidateTraceOptions, SemanticSearchExecutionResult, SemanticSearchRequest, SemanticSearchResult } from "@zokizuan/satori-core";
import type { ProvenSourceFreshnessCheckpointEvidence, SourceFreshnessPathComparison } from "@zokizuan/satori-core/integration";
import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { CapabilityResolver } from "./capabilities.js";
import { absolutePathOrRaw } from "../utils.js";
import {
    SyncManager,
    type FreshnessDecision,
    type PreparedReadWatcherDiagnostics,
    type WatcherObservationSnapshot,
} from "./sync.js";
import {
    SEARCH_FRESHNESS_THRESHOLD_MS,
} from "../config.js";
import {
    SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES,
    SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES,
    SearchGroupBy,
    SearchRankingMode,
    SearchResultMode,
    SearchScope
} from "./search-constants.js";
import {
    CallGraphHint,
    FileOutlineStatus,
    CallGraphDirection,
    NonOkReason,
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchGroupedResponseEnvelope,
    SearchGroupedResultV2,
    SearchReadinessDebugHint,
    SearchReadinessInvalidationReason,
    SearchRecommendedNextAction,
    SearchRequestInput,
    SearchResponseEnvelope,
    SearchResponseHints,
    SearchSpan,
} from "./search-types.js";
import {
    classifyEmbeddingProviderError,
    type EmbeddingProviderDiagnostic,
} from './embedding-provider-diagnostics.js';
import {
    ManageIndexAction,
} from "./manage-types.js";
import {
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import type { RelationshipBackedCallGraphResult } from "./relationship-backed-call-graph.js";
import {
    resolveSearchOwnerFromRegistry as resolveSearchOwnerFromRegistryWithRepair,
} from "./search-owner-resolution.js";
import {
    buildSearchWarningDetails,
    SEARCH_GROUP_PREVIEW_MAX_BYTES,
} from "./search-response-helpers.js";
import { runSearchFrontDoor, type SearchFrontDoorReady } from "./search-frontdoor.js";
import { resolveRequestedSearchSubdirectory } from "./search-requested-scope.js";
import {
    isWriterActionTerm as isWriterActionTermHelper,
} from "./search-ranking-policy.js";
import {
    resolveSearchRankingPolicyIdentity,
    type SearchOrderAuthority,
} from "./search-order-policy.js";
import { SearchQuerySupport } from "./search-query-support.js";
import {
    TrackedRootReadiness,
    type ReadinessPhase,
    type TrackedRootReadinessState,
} from "./tracked-root-readiness.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";
import { WARNING_CODES } from "./warnings.js";
import type {
    CompletionProofReason,
} from "./completion-proof.js";
import {
    classifyVectorBackendError,
} from "./backend-diagnostics.js";
import type {
    VectorBackendDiagnostic
} from "./backend-diagnostics.js";
import {
    type ExactRegistryLookupDebug,
} from "./search/exact-registry.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchFilterSummary,
} from "./search-execution.js";
import { resolveSearchPolicy } from './search-policy.js';
import { SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE } from './search-candidate-survival.js';
import {
    prepareEntrypointOwnerEvidence,
    type EntrypointOwnerEvidenceResolution,
    type PreparedEntrypointOwnerEvidence,
} from "./entrypoint-owner-evidence.js";
import { runExactRegistryFastPath } from "./search-exact-fast-path.js";
import {
    finalizeSearchResults,
    type FinalizedSearchResultSet,
} from "./search-result-finalization.js";
import { attachCompactSearchResultIndex } from "./search-result-index.js";
import {
    SearchResultSetCoordinator,
    SearchResultSetCoordinatorPool,
    type SearchResultSetCoordinatorLookup,
} from "./search-result-set-cache.js";
import {
    SEARCH_DISCLOSURE_POLICY_VERSION,
    projectGroupedDisclosure,
} from "./search-disclosure.js";
import {
    buildSearchRankedSetBinding,
    verifySearchRankedSetBinding,
    type SearchRankedSetBinding,
    type SearchRankedSetBindingInput,
    type SearchRerankerBindingIdentity,
} from "./search-result-set-identity.js";
import {
    SEARCH_RERANK_DOCUMENT_POLICY,
} from "./search-rerank-document.js";
import {
    resolveSearchRerankDocumentProjectionIdentity,
} from "./search-rerank-document-routing.js";
import {
    projectPublicationBoundSearchRerankDocument,
    searchRerankCandidateId,
} from "./search-rerank-projection.js";
import type { SearchRerankProjectionResult } from "./search-rerank-projection-result.js";
import {
    prepareSearchRerankStructuralRelationships,
    type PreparedSearchRerankStructuralRelationships,
} from "./search-rerank-structural-context.js";
import { resolveSearchRerankStructuralContextStatus } from "./search-rerank-structural-status.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { buildSearchRerankQuery } from "./search-rerank-query.js";
import { resolveSearchRerankQuery } from "./search-rerank-query-routing.js";
import {
    resolveSearchRerankRequestIdentity,
    type SearchRerankRequestIdentityV1,
} from "./search-rerank-request-contract.js";
import { serializeCanonicalJson } from "./canonical-json.js";
import type {
    SearchQueryPlan,
    SearchResultLike,
} from "./search-lexical-scoring.js";
import { PreparedPublicationReadSession } from "./prepared-publication-read-session.js";

const SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING = 'SEARCH_PARTIAL_INDEX:limit_reached';
const SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING = 'SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE';
type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>['reason'];
type SearchPhaseTimingKey =
    | 'prepareRead'
    | 'trackedRootResolution'
    | 'completionProof'
    | 'collectionProbe'
    | 'ensureFreshness'
    | 'exactRegistry'
    | 'semanticSearch'
    | 'trackedLexical'
    | 'rerank'
    | 'registryLoad'
    | 'grouping'
    | 'navigationValidation'
    | 'freshnessCheckpointProof'
    | 'freshnessExactPathComparison'
    | 'incrementalPublication'
    | 'publicationSourceNavigationLoad'
    | 'publicationFork'
    | 'publicationPayloadDelta'
    | 'publicationNavigationCheckpoint'
    | 'publicationNavigationDelta'
    | 'publicationRelationshipLoad'
    | 'publicationRelationshipDelta'
    | 'publicationSidecarStage'
    | 'publicationCheckpointStage'
    | 'publicationPayloadCount'
    | 'publicationActivation'
    | 'finalSourceValidation';

export type FrozenSearchResultSet = {
    canonicalRoot: string;
    publication: PublicationRef;
    queryPolicyDigest: string;
    rankedSetBinding: SearchRankedSetBinding;
    responseByteLimit: number;
    pageSize: number;
    baseEnvelope: Omit<
        SearchGroupedResponseEnvelope,
        "results" | "disclosure" | "continuation" | "recommendedNextAction" | "resultIndex"
    >;
    orderedResults: SearchGroupedResultV2[];
    recommendedActions: Array<SearchRecommendedNextAction | null>;
};

/**
 * Phase 8 gate correction C - the search request coordinator owns the
 * continuation store. The coordinator registers itself as the owner token;
 * ToolHandlers only injects the shared pool/coordinator instance.
 */
export class SearchContinuationCoordinatorPool extends SearchResultSetCoordinatorPool<
    FrozenSearchResultSet
> {}

export class SearchContinuationCoordinator extends SearchResultSetCoordinator<
    FrozenSearchResultSet,
    SearchRequestCoordinator
> {
    constructor(pool: SearchContinuationCoordinatorPool = new SearchContinuationCoordinatorPool()) {
        super(pool);
    }
}

function freezeContinuationHints(
    hints: SearchResponseHints | undefined,
): SearchResponseHints | undefined {
    if (!hints) return undefined;
    const frozen = structuredClone(hints);
    delete frozen.noiseMitigation;
    if (frozen.verification) {
        const verification = { ...frozen.verification };
        delete verification.generatedArtifacts;
        if (Object.keys(verification).length > 0) {
            frozen.verification = verification;
        } else {
            delete frozen.verification;
        }
    }
    if (frozen.debugSearch && "candidateSurvival" in frozen.debugSearch) {
        const debugSearch = structuredClone(frozen.debugSearch);
        if (debugSearch.candidateSurvival) {
            debugSearch.candidateSurvival.stages = debugSearch.candidateSurvival.stages.filter(
                (stage) => stage.stage !== "disclosed",
            );
            debugSearch.candidateSurvival.removals = debugSearch.candidateSurvival.removals.filter(
                (removal) => removal.afterStage !== "disclosed",
            );
        }
        frozen.debugSearch = debugSearch;
    }
    return Object.keys(frozen).length > 0 ? frozen : undefined;
}

function removeCacheAdmissionWarning(
    envelope: SearchGroupedResponseEnvelope,
): SearchGroupedResponseEnvelope {
    const warnings = envelope.warnings?.filter(
        (warning) => warning.code !== WARNING_CODES.SEARCH_RESULT_SET_NOT_CACHE_ADMISSIBLE,
    );
    const withoutWarnings = { ...envelope };
    delete withoutWarnings.warnings;
    return {
        ...withoutWarnings,
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
    };
}

function resolveSearchRerankerBindingIdentity(
    reranker: Reranker | null,
    rerankerApplied: boolean,
): SearchRerankerBindingIdentity {
    if (!rerankerApplied) {
        return { kind: "deterministic_baseline", policy: "B" };
    }
    if (!reranker) {
        throw new Error("Applied search reranking requires a stable provider identity.");
    }
    const identity = reranker.getIdentity();
    return {
        kind: "provider",
        provider: identity.provider,
        model: identity.model,
        profile: identity.profile,
    };
}

function resolveSearchRerankerProjectionIdentity(
    reranker: Reranker | null,
    rerankerApplied: boolean,
): string {
    if (!rerankerApplied) return "not_applicable";
    return resolveSearchRerankDocumentProjectionIdentity(
        reranker?.getDocumentProjectionVersion?.(),
    );
}

function resolveSearchRerankRequestIdOrNone(
    reranker: Reranker | null,
    rerankerApplied: boolean,
): SearchRerankRequestIdentityV1 | null {
    if (!rerankerApplied) return null;
    if (!reranker) {
        throw new Error("Applied search reranking requires a complete rerank request identity.");
    }
    return resolveSearchRerankRequestIdentity(reranker);
}

function buildFrozenSearchRankedSetBindingInput(input: {
    publication: PublicationRef;
    queryPolicyDigest: string;
    rerankerIdentity: SearchRerankerBindingIdentity;
    rerankerProjectionIdentity: string;
    rerankerRequestIdentity: SearchRerankRequestIdentityV1 | null;
    rankingPolicyIdentity: string;
    orderedResults: readonly SearchGroupedResultV2[];
    recommendedActions: readonly (SearchRecommendedNextAction | null)[];
}): SearchRankedSetBindingInput {
    return {
        queryPolicyDigest: input.queryPolicyDigest,
        rankingPolicyIdentity: input.rankingPolicyIdentity,
        disclosurePolicyVersion: SEARCH_DISCLOSURE_POLICY_VERSION,
        publicationIdentity: {
            publicationId: input.publication.id,
            collectionName: input.publication.publication.vector.collectionName,
            policyHash: input.publication.publication.policy.policyHash,
            navigation: input.publication.publication.navigation
                ? { status: "bound" }
                : { status: "not_bound" },
        },
        rerankerIdentity: input.rerankerIdentity,
        rerankerProjectionIdentity: input.rerankerProjectionIdentity,
        rerankerRequestIdentity: input.rerankerRequestIdentity,
        orderedResults: input.orderedResults,
        recommendedActions: input.recommendedActions,
    };
}

type SearchPhaseTimings = Record<SearchPhaseTimingKey, number>;

type SearchOwnerSource = 'owner_metadata' | 'registry_repair' | 'fallback';

type SearchOwnerResolution = {
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    symbolKind?: string;
    ownerSource?: Extract<SearchOwnerSource, 'owner_metadata' | 'registry_repair'>;
};

type ToolArgs = Record<string, unknown>;

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type SearchToolTextResponse = ToolTextResponse & {
    meta?: Record<string, unknown>;
};

type ValidatedSearchRequest = {
    input: SearchRequestInput & { debugMode: NonNullable<SearchRequestInput['debugMode']> };
    parsedOperators: ReturnType<SearchQuerySupport['parseSearchOperators']>;
};

type CachedPreparedReadResult =
    | {
        status: "hit";
        state: Extract<TrackedRootReadinessState, { state: "ready" }>;
    }
    | {
        status: "miss";
        reason: SearchReadinessInvalidationReason;
    };

type NavigationManifestState = Awaited<ReturnType<JsonNavigationStore['getManifest']>>;
type NavigationCompatibilityState = Awaited<ReturnType<JsonNavigationStore['getCompatibilityState']>>;

type CompletionProbeDebugHint = {
    ok: false;
    reason: "probe_failed";
    message: string;
    action: string;
};

/**
 * Phase 8 gate correction B - grouped narrow collaborator seams for the
 * search request coordinator. Each collaborator owns one dependency cluster;
 * the coordinator receives the composed set, never ToolHandlers itself.
 */

export interface SearchReadinessCollaborator {
    touchWatchedCodebaseBestEffort(codebasePath: string): Promise<void>;

    assessReadFreshness(
        ...args: Parameters<SyncManager['assessReadFreshness']>
    ): Promise<FreshnessDecision>;
    getPreparedReadDiagnostics?(codebasePath: string): PreparedReadWatcherDiagnostics;

    prepareTrackedRootReadWithObservation(
        absolutePath: string,
        onPhase: (phase: ReadinessPhase, durationMs: number) => void,
        accessMode?: 'semantic' | 'navigation',
    ): Promise<TrackedRootReadinessState>;

    loadRegistryValidatedRelationshipNavigation(input: {
        codebaseRoot: string;
        registryManifestHash?: string;
        registryUnavailableReason?: CallGraphUnavailableReason;
        preparedRead?: Extract<TrackedRootReadinessState, { state: 'ready' }>;
        operations?: SearchReadinessDebugHint['operations'];
    }): Promise<{
        relationshipReady: boolean;
        relationshipBuiltAt?: string;
        relationshipUnavailableReason?: CallGraphUnavailableReason;
        warning?: string;
    }>;

    getWatcherObservation(codebasePath: string): WatcherObservationSnapshot;

    getChangedFilesForCodebase(
        codebasePath: string,
        options?: { forceRefresh?: boolean },
    ): { available: boolean; files: Set<string> };

    getTrackedRootReadiness(): TrackedRootReadiness;

    isPartialIndexNavigationUnavailable(info: unknown): boolean;

    getIndexingOperationForReadiness(codebasePath: string):
        | { action: "create" | "reindex" | "sync"; phase: string; generation: number }
        | undefined;

    probeLocalSearchCollectionState(codebasePath: string): Promise<{
        state: 'ready' | 'missing' | 'unknown';
        collectionName?: string;
    }>;
}

export interface SearchHintPayloadCollaborator {
    stringifyToolJson(payload: unknown): string;

    getToolResponseBuilders(): ToolResponseBuilders;

    getSearchNavigationHelpers(): {
        now: () => number;
        sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => string | undefined;
        isCallGraphLanguageSupported: (language: string, file: string) => boolean;
        getOutlineStatusForLanguage: (relativeFilePath: string) => FileOutlineStatus;
    };


    buildGeneratedArtifactsVerificationHint(
        codebaseRoot: string,
        results: Array<{ file: string; span: SearchSpan }>,
    ): NonNullable<NonNullable<SearchResponseEnvelope['hints']>['verification']>['generatedArtifacts'] | undefined;

    buildChangedCodeDebug(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        changedFilesState: { available: boolean; files: Set<string> },
    ): Promise<SearchDebugHint['changedCode'] | undefined>;

    withProofDebugHint<T extends object>(payload: T, proofDebugHint?: CompletionProbeDebugHint): T;

    buildSyncHint(codebasePath: string): { tool: string; args: { action: string; path: string } };

    buildStaleLocalMessage(codebasePath: string, requestedPath: string, reason: CompletionProofReason): string;

    buildRelationshipBackedCallGraph(input: {
        codebaseRoot: string;
        publicationId: string;
        navigationRoot: string;
        registry: SymbolRegistry;
        registryManifestHash: string;
        resolvedSymbol: SymbolRecord;
        sourceSpanRepair?: PythonSourceBackedSpanRepair;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
        readAuthorizedSourceLines?: (codebaseRoot: string, relativeFilePath: string) => Promise<string[] | undefined>;
    }): Promise<RelationshipBackedCallGraphResult | null>;

    buildManageIndexRecommendedAction(
        action: Extract<ManageIndexAction, "create" | "reindex" | "status" | "sync">,
        codebasePath: string,
        reason: string,
    ): SearchRecommendedNextAction;

    buildCreateHint(codebasePath: string): { tool: string; args: { action: string; path: string } };

    sanitizeIndexedRelativeFilePath(relativeFilePath: string): string | undefined;
}

export interface SearchPreparedReadCollaborator {
    loadPreparedNavigationManifest(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        operations?: SearchReadinessDebugHint['operations'],
    ): Promise<NavigationManifestState>;

    getPreparedAuthorityObservation(codebasePath: string): string | null;

    getPublicationNavigationAddress(publication: PublicationRef): {
        publicationId: string;
        navigationRoot: string;
    } | null;

    seedPreparedRead(
        state: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        preserveProofAge: boolean,
        statusPrepared?: boolean,
    ): void;

    evictPreparedRead(codebasePath: string): void;

    loadPreparedNavigationCompatibility(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        expectedSymbolRegistryManifestHash: string,
        operations?: SearchReadinessDebugHint['operations'],
    ): Promise<NavigationCompatibilityState>;

    getCachedPreparedRead(
        absolutePath: string,
        operations: SearchReadinessDebugHint['operations'],
        requireNavigation?: boolean,
    ): Promise<CachedPreparedReadResult>;

    acquirePublicationLease(codebasePath: string, publicationId?: string): PublicationLease | undefined;
    isPublicationLeaseAdmitted(lease: PublicationLease): Promise<boolean>;
    isPublicationAdmitted(publication: PublicationRef): Promise<boolean>;
    getPublicationNavigationStatus(publication: PublicationRef): Promise<import("@zokizuan/satori-core").PublicationNavigationStatus>;
}

export interface SearchFreshnessCollaborator {
    inspectSourceFreshnessCheckpoint(
        codebasePath: string,
        publication?: PublicationRef,
    ): Promise<ProvenSourceFreshnessCheckpointEvidence>;

    compareAllSourceToFreshnessCheckpoint(
        codebasePath: string,
        publication?: PublicationRef,
    ): Promise<SourceFreshnessPathComparison>;

    compareSourceObservationToFreshnessCheckpoint(
        codebasePath: string,
        publication?: PublicationRef,
    ): Promise<SourceFreshnessPathComparison>;

    compareSourcePathsToFreshnessCheckpoint(
        codebasePath: string,
        relativePaths: readonly string[],
        publication?: PublicationRef,
    ): Promise<SourceFreshnessPathComparison>;
}

export interface SearchEnvironmentCollaborator {
    now(): number;

    getCapabilities(): CapabilityResolver;

    getReadFileMaxBytes(): number;

    parseIndexedAtMs(indexedAt?: string): number | undefined;

    getEmbeddingProviderName(): string;

    semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResult[]>;
    semanticSearchInPublication?: (
        publication: PublicationRef,
        request: SemanticSearchRequest,
    ) => Promise<SemanticSearchResult[]>;
    semanticSearchWithCandidateTraceInPublication?: (
        publication: PublicationRef,
        request: SemanticSearchRequest,
        maxEntriesPerStage: number,
        options?: SemanticSearchCandidateTraceOptions,
    ) => Promise<SemanticSearchExecutionResult>;
}

export interface SearchRequestCoordinatorCollaborators {
    readonly readiness: SearchReadinessCollaborator;
    readonly hints: SearchHintPayloadCollaborator;
    readonly preparedRead: SearchPreparedReadCollaborator;
    readonly freshness: SearchFreshnessCollaborator;
    readonly environment: SearchEnvironmentCollaborator;
}

type SearchContinuationLookup = SearchResultSetCoordinatorLookup<
    FrozenSearchResultSet,
    SearchRequestCoordinator
>;

/**
 * Phase 6.1 — owns the dominant search attempt: argument validation,
 * front-door readiness, prepared-read execution, retrieval, grouping,
 * diagnostics, and response projection. Depends on the bounded host
 * interface and leaf collaborators only.
 */
export class SearchRequestCoordinator {
    private readonly readiness: SearchReadinessCollaborator;
    private readonly hints: SearchHintPayloadCollaborator;
    private readonly preparedRead: SearchPreparedReadCollaborator;
    private readonly freshness: SearchFreshnessCollaborator;
    private readonly environment: SearchEnvironmentCollaborator;

    constructor(
        collaborators: SearchRequestCoordinatorCollaborators,
        private readonly searchQuerySupport: SearchQuerySupport,
        private readonly reranker: Reranker | null,
        private readonly continuationCoordinator: SearchResultSetCoordinator<
            FrozenSearchResultSet,
            SearchRequestCoordinator
        > = new SearchContinuationCoordinator(),
    ) {
        this.readiness = collaborators.readiness;
        this.hints = collaborators.hints;
        this.preparedRead = collaborators.preparedRead;
        this.freshness = collaborators.freshness;
        this.environment = collaborators.environment;
        this.continuationCoordinator.registerOwner(this);
    }

    public releaseContinuationOwnership(): void {
        this.continuationCoordinator.unregisterOwner(this);
    }
    private createSearchPhaseTimings(): SearchPhaseTimings {
        return {
            prepareRead: 0,
            trackedRootResolution: 0,
            completionProof: 0,
            collectionProbe: 0,
            ensureFreshness: 0,
            exactRegistry: 0,
            semanticSearch: 0,
            trackedLexical: 0,
            rerank: 0,
            registryLoad: 0,
            grouping: 0,
            navigationValidation: 0,
            freshnessCheckpointProof: 0,
            freshnessExactPathComparison: 0,
            incrementalPublication: 0,
            publicationSourceNavigationLoad: 0,
            publicationFork: 0,
            publicationPayloadDelta: 0,
            publicationNavigationCheckpoint: 0,
            publicationNavigationDelta: 0,
            publicationRelationshipLoad: 0,
            publicationRelationshipDelta: 0,
            publicationSidecarStage: 0,
            publicationCheckpointStage: 0,
            publicationPayloadCount: 0,
            publicationActivation: 0,
            finalSourceValidation: 0,
        };
    }

    private searchPhaseNowMs(): number {
        return Date.now();
    }

    private addSearchPhaseTiming(timings: SearchPhaseTimings, phase: SearchPhaseTimingKey, startedAtMs: number): void {
        const elapsed = Math.max(0, this.searchPhaseNowMs() - startedAtMs);
        timings[phase] += elapsed;
    }

    private async measureSearchPhase<T>(
        timings: SearchPhaseTimings,
        phase: SearchPhaseTimingKey,
        fn: () => Promise<T>
    ): Promise<T> {
        const startedAtMs = this.searchPhaseNowMs();
        try {
            return await fn();
        } finally {
            this.addSearchPhaseTiming(timings, phase, startedAtMs);
        }
    }

    private buildNotReadySearchPayload(
        codebasePath: string,
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        }
    ): SearchResponseEnvelope {
        return this.hints.getToolResponseBuilders().buildNotReadySearchPayload(codebasePath, searchContext);
    }

    private buildFreshnessBlockedSearchPayload(
        codebasePath: string,
        freshnessDecision: FreshnessDecision,
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        }
    ): SearchResponseEnvelope | null {
        return this.hints.getToolResponseBuilders().buildFreshnessBlockedSearchPayload(codebasePath, freshnessDecision, searchContext);
    }

    private buildVectorBackendSearchPayload(
        diagnostic: VectorBackendDiagnostic,
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        }
    ): SearchResponseEnvelope {
        return this.hints.getToolResponseBuilders().buildVectorBackendSearchPayload(diagnostic, searchContext);
    }

    private buildEmbeddingProviderSearchPayload(
        diagnostic: EmbeddingProviderDiagnostic,
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        },
    ): SearchResponseEnvelope {
        return this.hints.getToolResponseBuilders().buildEmbeddingProviderSearchPayload(diagnostic, searchContext);
    }

    private buildInvalidSearchRequestPayload(
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        },
        message: string,
        status: SearchResponseEnvelope["status"] = "not_ready",
        reason?: NonOkReason
    ): SearchResponseEnvelope {
        return this.hints.getToolResponseBuilders().buildInvalidSearchRequestPayload(searchContext, message, status, reason);
    }

    private resolveSearchOwnerFromRegistry(result: SearchResultLike, registry?: SymbolRegistry, plan?: SearchQueryPlan): SearchOwnerResolution {
        return resolveSearchOwnerFromRegistryWithRepair({
            result,
            registry,
            lexicalTerms: plan?.lexicalTerms,
            sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => this.hints.sanitizeIndexedRelativeFilePath(relativeFilePath),
            hasTokenBoundaryMatch: (haystack: string, needle: string) => this.searchQuerySupport.hasTokenBoundaryMatch(haystack, needle),
            isWriterActionTerm: (value: string) => isWriterActionTermHelper(value),
        });
    }

    public async attempt(
        args: ToolArgs,
        sourceDriftRetryCount: 0 | 1 = 0,
    ): Promise<SearchToolTextResponse> {
        const request = this.validateSearchRequest(args);
        if ('content' in request) return request;
        for (const retryCount of [0, 1] as const) {
            if (retryCount < sourceDriftRetryCount) continue;
            const response = await this.executeSearchAttempt(request, retryCount);
            if (response) return response;
        }
        throw new Error('Search exhausted its source-drift retry without a response.');
    }

    private validateSearchRequest(args: ToolArgs): SearchToolTextResponse | ValidatedSearchRequest {
        const scope = (typeof args.scope === 'string' ? args.scope : 'runtime') as SearchScope;
        const resultMode = (typeof args.resultMode === 'string' ? args.resultMode : 'grouped') as SearchResultMode;
        const groupBy = (typeof args.groupBy === 'string' ? args.groupBy : 'symbol') as SearchGroupBy;
        const rankingMode = (typeof args.rankingMode === 'string' ? args.rankingMode : 'auto_changed_first') as SearchRankingMode;
        const debugMode = args.debugMode === 'summary'
            || args.debugMode === 'ranking'
            || args.debugMode === 'freshness'
            || args.debugMode === 'full'
            ? args.debugMode
            : 'none';
        const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit);
        const rawDisclosureLimit = typeof args.disclosureLimit === 'number'
            ? args.disclosureLimit
            : Number(args.disclosureLimit);
        const rawDebugCandidateLimit = typeof args.debugCandidateLimit === 'number'
            ? args.debugCandidateLimit
            : Number(args.debugCandidateLimit);
        const input: ValidatedSearchRequest['input'] = {
            path: typeof args.path === 'string' ? args.path : '',
            query: typeof args.query === 'string' ? args.query : '',
            scope,
            resultMode,
            groupBy,
            rankingMode,
            limit: args.limit === undefined ? 10 : rawLimit,
            ...(args.disclosureLimit !== undefined
                ? { disclosureLimit: rawDisclosureLimit }
                : {}),
            ...(args.includeResultIndex !== undefined
                ? { includeResultIndex: args.includeResultIndex === true }
                : {}),
            debugMode,
            ...(Number.isFinite(rawDebugCandidateLimit)
                ? { debugCandidateLimit: Math.max(1, rawDebugCandidateLimit) }
                : {}),
        };

        const isScopeValid = input.scope === 'runtime' || input.scope === 'mixed' || input.scope === 'docs';
        const isResultModeValid = input.resultMode === 'grouped' || input.resultMode === 'raw';
        const isGroupByValid = input.groupBy === 'symbol' || input.groupBy === 'file';
        const isRankingModeValid = input.rankingMode === 'default' || input.rankingMode === 'auto_changed_first';
        const isLimitValid = Number.isSafeInteger(input.limit)
            && input.limit > 0
            && input.limit <= this.environment.getCapabilities().getMaxSearchResultTotal();

        const isDebugCandidateLimitValid = input.debugCandidateLimit === undefined
            || (debugMode === 'full'
                && Number.isInteger(input.debugCandidateLimit)
                && input.debugCandidateLimit <= SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE);
        const isDisclosureLimitValid = input.disclosureLimit === undefined
            || (input.resultMode === 'grouped'
                && Number.isInteger(input.disclosureLimit)
                && input.disclosureLimit > 0
                && input.disclosureLimit <= this.environment.getCapabilities().getMaxSearchPageSize()
                && input.disclosureLimit <= input.limit);
        const isResultIndexValid = args.includeResultIndex === undefined
            || (typeof args.includeResultIndex === "boolean"
                && input.resultMode === "grouped");

        if (!isScopeValid || !isResultModeValid || !isGroupByValid || !isRankingModeValid || !isLimitValid || !isDebugCandidateLimitValid || !isDisclosureLimitValid || !isResultIndexValid || typeof input.query !== 'string' || input.query.trim().length === 0) {
            const payload = this.buildInvalidSearchRequestPayload({
                path: typeof input.path === 'string' ? input.path : '',
                query: typeof input.query === 'string' ? input.query : '',
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit
            }, 'Invalid search arguments. Required: path, query. Valid scope: runtime|mixed|docs. Valid resultMode: grouped|raw. Valid groupBy: symbol|file. Valid rankingMode: default|auto_changed_first. disclosureLimit is a grouped-result integer no greater than limit. includeResultIndex is a grouped-result boolean. debugCandidateLimit is an integer from 1 to 160 and requires debugMode=full.');
            return {
                content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                isError: true,
            };
        }

        const parsedOperators = this.searchQuerySupport.parseSearchOperators(input.query);
        if (parsedOperators.semanticQuery.trim().length === 0) {
            const payload = this.buildInvalidSearchRequestPayload({
                path: input.path,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit,
            }, 'Operator-only search requires semantic text or a positive must:, path:, or lang: value.');
            return {
                content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                isError: true,
            };
        }

        return { input, parsedOperators };
    }

    /** A retry is returned only after the read session and source evidence have released ownership. */
    private async executeSearchAttempt(
        request: ValidatedSearchRequest,
        sourceDriftRetryCount: 0 | 1,
    ): Promise<SearchToolTextResponse | undefined> {
        const { input, parsedOperators } = request;
        const { debugMode } = input;
        const searchDiagnostics: SearchDiagnostics = {
            queryLength: input.query.length,
            limitRequested: input.limit,
            resultsBeforeFilter: 0,
            resultsAfterFilter: 0,
            excludedByIgnore: 0,
            excludedBySubdirectory: 0,
            filterPass: 'expanded' as 'initial' | 'expanded',
            freshnessMode: undefined as string | undefined,
            searchPassCount: 0,
            searchPassSuccessCount: 0,
            searchPassFailureCount: 0,
            rerankerAttempted: false,
            rerankerUsed: false,
            semanticSearchAttempts: 0,
            embeddingCallsByCurrentContract: 0,
            denseQueriesByCurrentContract: 0,
            sparseQueriesByCurrentContract: 0,
            rerankerCalls: 0,
            rerankerCandidates: 0,
            rerankerInputBytes: 0,
            rerankerFailures: 0,
            rerankerRetries: 0,
            rerankerTimeouts: 0,
            candidatesWithSemanticEvidence: 0,
            candidatesWithLexicalEvidence: 0,
            candidatesWithCurrentSourceEvidence: 0,
            semanticExpansionAttempted: false,
        };
        const phaseTimings = this.createSearchPhaseTimings();
        const readinessDebug: SearchReadinessDebugHint = {
            proofMode: "cold",
            invalidationReason: "cache_miss",
            operations: {
                preparedCacheLookups: 0,
                preparedCacheHits: 0,
                coldReadinessChecks: 0,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 0,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        };
        let preservePreparedProofAge = false;
        let preparedEntrypointOwnerEvidence: PreparedEntrypointOwnerEvidence | undefined;
        let observedChangedFilesForSearch: { available: boolean; files: Set<string> } | undefined;

        const readinessPhaseToSearchPhase = {
            tracked_root_resolution: 'trackedRootResolution',
            completion_proof: 'completionProof',
            collection_probe: 'collectionProbe',
        } as const;

        try {
            const frontDoor = await runSearchFrontDoor({
                path: input.path,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit,
            }, {
                trackedRootReadiness: this.readiness.getTrackedRootReadiness(),
                prepareInitialTrackedRootRead: async (absolutePath) => {
                    const cached = await this.preparedRead.getCachedPreparedRead(absolutePath, readinessDebug.operations);
                    if (cached.status === "hit") {
                        preservePreparedProofAge = true;
                        readinessDebug.proofMode = "warm";
                        readinessDebug.invalidationReason = "none";
                        return cached.state;
                    }
                    preservePreparedProofAge = false;
                    readinessDebug.proofMode = "cold";
                    readinessDebug.invalidationReason = cached.reason;
                    if (cached.reason === "proof_expired") {
                        readinessDebug.auditClassification = "proof_expiry_audit";
                    }
                    readinessDebug.operations.coldReadinessChecks += 1;
                    const prepareReadStartedAtMs = this.searchPhaseNowMs();
                    const trackedRootState = await this.readiness.prepareTrackedRootReadWithObservation(
                        absolutePath,
                        (phase, durationMs) => {
                            phaseTimings[readinessPhaseToSearchPhase[phase]] += durationMs;
                        },
                    );
                    this.addSearchPhaseTiming(phaseTimings, 'prepareRead', prepareReadStartedAtMs);
                    return trackedRootState;
                },
                preparePostFreshnessTrackedRootRead: (absolutePath, invalidationReason) => {
                    preservePreparedProofAge = false;
                    readinessDebug.proofMode = "cold";
                    readinessDebug.invalidationReason = invalidationReason;
                    readinessDebug.operations.coldReadinessChecks += 1;
                    readinessDebug.operations.postFreshnessColdChecks += 1;
                    return this.measureSearchPhase(
                        phaseTimings,
                        'prepareRead',
                        async () => {
                            const trackedRootState = await this.readiness.prepareTrackedRootReadWithObservation(
                                absolutePath,
                                (phase, durationMs) => {
                                    phaseTimings[readinessPhaseToSearchPhase[phase]] += durationMs;
                                },
                            );
                            return trackedRootState;
                        },
                    );
                },
                getIndexingOperation: (codebasePath) => this.readiness.getIndexingOperationForReadiness(codebasePath),
                assessSearchFreshness: (effectiveRoot, preparedRead) => this.measureSearchPhase(
                    phaseTimings,
                    'ensureFreshness',
                    async () => {
                        const watcherObservation = this.readiness.getWatcherObservation(effectiveRoot);
                        if (watcherObservation.coverage !== 'ready') {
                            await this.readiness.touchWatchedCodebaseBestEffort(effectiveRoot);
                        }
                        const effectiveWatcherObservation = this.readiness.getWatcherObservation(effectiveRoot);
                        const fullSourceComparisonRequired = effectiveWatcherObservation.coverage !== 'ready'
                            || effectiveWatcherObservation.pending;
                        const changedFilesState = this.readiness.getChangedFilesForCodebase(
                            effectiveRoot,
                            { forceRefresh: fullSourceComparisonRequired },
                        );
                        observedChangedFilesForSearch = changedFilesState;
                        const exactSourceComparisonRequired = changedFilesState.available
                            && changedFilesState.files.size > 0;
                        const exactSourceComparisonPaths = sourceDriftRetryCount === 0
                            && exactSourceComparisonRequired
                            ? Array.from(changedFilesState.files).sort()
                            : undefined;
                        const decision = await this.readiness.assessReadFreshness(
                            effectiveRoot,
                            exactSourceComparisonRequired || fullSourceComparisonRequired
                                ? 0
                                : SEARCH_FRESHNESS_THRESHOLD_MS,
                            {
                                ...(preparedRead?.publication
                                    ? { preparedPublication: preparedRead.publication }
                                    : {}),
                                ...(exactSourceComparisonPaths
                                    ? { exactSourceComparisonPaths }
                                    : {}),
                                ...(fullSourceComparisonRequired
                                    ? { fullSourceComparison: true }
                                    : {}),
                                ...(debugMode === 'freshness' || debugMode === 'full'
                                    ? {
                                        onPhaseTiming: (
                                            phase:
                                                | 'checkpoint_proof'
                                                | 'exact_path_comparison'
                                                | 'incremental_publication'
                                                | 'publication_source_navigation_load'
                                                | 'publication_fork'
                                                | 'publication_payload_delta'
                                                | 'publication_navigation_checkpoint'
                                                | 'publication_navigation_delta'
                                                | 'publication_relationship_load'
                                                | 'publication_relationship_delta'
                                                | 'publication_sidecar_stage'
                                                | 'publication_checkpoint_stage'
                                                | 'publication_payload_count'
                                                | 'publication_activation',
                                            durationMs: number,
                                        ) => {
                                            const timingKey = {
                                                checkpoint_proof: 'freshnessCheckpointProof',
                                                exact_path_comparison: 'freshnessExactPathComparison',
                                                incremental_publication: 'incrementalPublication',
                                                publication_source_navigation_load:
                                                    'publicationSourceNavigationLoad',
                                                publication_fork: 'publicationFork',
                                                publication_payload_delta: 'publicationPayloadDelta',
                                                publication_navigation_checkpoint:
                                                    'publicationNavigationCheckpoint',
                                                publication_navigation_delta:
                                                    'publicationNavigationDelta',
                                                publication_relationship_load:
                                                    'publicationRelationshipLoad',
                                                publication_relationship_delta:
                                                    'publicationRelationshipDelta',
                                                publication_sidecar_stage:
                                                    'publicationSidecarStage',
                                                publication_checkpoint_stage:
                                                    'publicationCheckpointStage',
                                                publication_payload_count:
                                                    'publicationPayloadCount',
                                                publication_activation: 'publicationActivation',
                                            }[phase] as SearchPhaseTimingKey;
                                            phaseTimings[timingKey] += durationMs;
                                        },
                                    }
                                    : {}),
                            },
                        );
                        return decision;
                    },
                ),
                noteFreshnessMode: (mode) => {
                    searchDiagnostics.freshnessMode = mode;
                },
                buildInvalidSearchRequestPayload: (searchContext, message, status, reason) => this.buildInvalidSearchRequestPayload(
                    searchContext,
                    message,
                    status,
                    reason
                ),
                buildRequiresReindexPayload: (codebasePath, detail, searchContext) => this.hints.getToolResponseBuilders().buildRequiresReindexPayload(
                    codebasePath,
                    detail,
                    searchContext
                ) as unknown as SearchResponseEnvelope,
                buildNotReadySearchPayload: (codebasePath, searchContext) => this.buildNotReadySearchPayload(
                    codebasePath,
                    searchContext
                ),
                buildFreshnessBlockedSearchPayload: (codebasePath, freshnessDecision, searchContext) => this.buildFreshnessBlockedSearchPayload(
                    codebasePath,
                    freshnessDecision,
                    searchContext
                ),
                buildManageIndexRecommendedAction: (action, codebasePath, rationale) => this.hints.buildManageIndexRecommendedAction(
                    action,
                    codebasePath,
                    rationale
                ),
                buildCreateHint: (codebasePath) => this.hints.buildCreateHint(codebasePath),
                buildStaleLocalMessage: (codebasePath, requestedPath, reason) => this.hints.buildStaleLocalMessage(
                    codebasePath,
                    requestedPath,
                    reason
                ),
                withProofDebugHint: (payload, proofDebugHint) => this.hints.withProofDebugHint(payload, proofDebugHint),
                isPartialIndexNavigationUnavailable: (info) => this.readiness.isPartialIndexNavigationUnavailable(info),
                partialIndexWarnings: [
                    SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING,
                    SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING,
                ],
            });

            if (frontDoor.kind === 'blocked') {
                return {
                    content: [{ type: "text", text: this.hints.stringifyToolJson(frontDoor.payload) }],
                    ...(frontDoor.isError ? { isError: true } : {}),
                    meta: { searchDiagnostics }
                };
            }

            let absolutePath: string = "";
            let effectiveRoot: string = "";
            let freshnessDecision!: SearchFrontDoorReady["freshnessDecision"];
            const session = new PreparedPublicationReadSession<SearchFrontDoorReady>({
                prepareReadiness: async () => frontDoor as SearchFrontDoorReady,
                acquirePublicationLease: (prepared) => this.preparedRead.acquirePublicationLease(
                    prepared.effectiveRoot,
                    prepared.freshnessDecision.mode === "served_previous_generation"
                        ? prepared.publication.id
                        : undefined,
                ),
                isLeaseAdmitted: (_prepared, lease) => (
                    this.preparedRead.isPublicationLeaseAdmitted(lease)
                ),
            });
            const outcome = await session.read(async (prepared, lease): Promise<SearchToolTextResponse | undefined> => {
                const {
                    absolutePath: absolutePathFromFrontDoor,
                    searchableRoot,
                    effectiveRoot: effectiveRootFromFrontDoor,
                    proofDebugHint,
                    partialIndexSearchWarnings: frontDoorWarnings,
                    freshnessDecision: freshnessDecisionFromFrontDoor,
                } = prepared;
                absolutePath = absolutePathFromFrontDoor;
                effectiveRoot = effectiveRootFromFrontDoor;
                freshnessDecision = freshnessDecisionFromFrontDoor;
                const navigationStatus = await this.preparedRead.getPublicationNavigationStatus(lease);
                const partialIndexSearchWarnings = [
                    ...frontDoorWarnings.filter((warning) => warning !== "NAVIGATION_REINDEX_REQUIRED"),
                    ...(navigationStatus !== "valid" && navigationStatus !== "not_bound"
                        ? ["NAVIGATION_REINDEX_REQUIRED"]
                        : []),
                ];
                if (debugMode === 'full') {
                    const getPreparedReadDiagnostics = this.readiness.getPreparedReadDiagnostics;
                    if (typeof getPreparedReadDiagnostics === 'function') {
                        readinessDebug.watcher = getPreparedReadDiagnostics.call(
                            this.readiness,
                            effectiveRoot,
                        );
                    }
                }

                if (searchableRoot.path !== absolutePath) {
                    console.log(`[SEARCH] Auto-resolved subdirectory '${absolutePath}' to indexed root '${searchableRoot.path}'`);
                }
                const requestedSubdirectory = resolveRequestedSearchSubdirectory({
                    indexedRoot: effectiveRoot,
                    requestedPath: absolutePath,
                });
            const encoderProviderName = this.environment.getEmbeddingProviderName();
                const rootTag = `[SEARCH][root=${effectiveRoot}]`;
                const requestId = crypto.randomUUID();
                console.log(`${rootTag} Searching (requestedPath='${absolutePath}')`);
                console.log(`${rootTag} Query metadata: length=${input.query.length}, requestId=${requestId}`);
                console.log(`${rootTag} Indexing status: Completed`);
                console.log(`${rootTag} 🧠 Using embedding provider: ${encoderProviderName} for search`);

                const semanticQuery = parsedOperators.semanticQuery;
                const queryPlan = this.searchQuerySupport.buildSearchQueryPlan(semanticQuery, parsedOperators);
                const entrypointOwnerSeeking = queryPlan.entrypointIntent.kinds.some((kind) => (
                    kind === "installed_command_ownership"
                    || kind === "application_startup_ownership"
                ));
                searchDiagnostics.routeKind = queryPlan.route.kind;
                searchDiagnostics.retrievalMode = queryPlan.retrievalMode;
                const retrievalPolicy = resolveSearchPolicy({
                    resultLimit: input.limit,
                    ...(input.disclosureLimit !== undefined
                        ? { disclosureResultLimit: input.disclosureLimit }
                        : {}),
                    hasMustOperators: parsedOperators.must.length > 0,
                    ...(input.debugCandidateLimit !== undefined
                        ? { diagnosticCandidateLimit: input.debugCandidateLimit }
                        : {}),
                });
                const maxAttempts = retrievalPolicy.maxAttempts;
                const candidateLimit = retrievalPolicy.candidateLimit;
                const initialFilterSummary: SearchFilterSummary = {
                    removedByRequestedSubdirectory: 0,
                    removedByScope: 0,
                    removedByLanguage: 0,
                    removedByPathInclude: 0,
                    removedByPathExclude: 0,
                    removedByMust: 0,
                    removedByExclude: 0,
                };
                const initialOperatorSummary = this.searchQuerySupport.buildOperatorSummary(parsedOperators);
                const staleWhileSync = freshnessDecision.mode === "served_previous_generation";
                const initialObservedChangedFilesState = staleWhileSync
                    ? { available: false, files: new Set<string>() }
                    : observedChangedFilesForSearch
                        ?? this.readiness.getChangedFilesForCodebase(effectiveRoot);
                const initialChangedFilesState = initialObservedChangedFilesState;
                const initialDebugChangedFilesState = debugMode === 'freshness' || debugMode === 'full'
                    ? initialObservedChangedFilesState
                    : undefined;
                const initialObservedChangedFilesCount = initialObservedChangedFilesState.files.size;
                const initialChangedFilesCount = initialObservedChangedFilesCount;
                const initialChangedFilesBoostSkippedForLargeChangeSet = false;
                const initialFreshnessSummary: SearchFreshnessSummary = {
                    syncMode: freshnessDecision.mode,
                    lastSyncAt: typeof freshnessDecision.lastSyncAt === 'string' ? freshnessDecision.lastSyncAt : null,
                    changedFileCount: initialObservedChangedFilesCount,
                    gitDirtyFilesConsidered: initialObservedChangedFilesState.available,
                    changedFilesBoostApplied: false,
                    changedFilesBoostSkippedForLargeChangeSet: initialChangedFilesBoostSkippedForLargeChangeSet,
                };
                const initialDirtyFilesNotFreshened = initialObservedChangedFilesState.available
                    && initialObservedChangedFilesCount > 0
                    && freshnessDecision.mode !== 'synced'
                    && freshnessDecision.mode !== 'skipped_source_unchanged'
                    && freshnessDecision.mode !== 'reconciled_ignore_change';
                const initialRankingProvenance = {
                    semanticPassesUsed: [] as string[],
                    lexicalPassesUsed: [] as string[],
                    livePathSupplementUsed: false,
                    lexicalFileScanUsed: false,
                    rerankApplied: false,
                    exactMatchPinningApplied: false,
                    registryRepairGroupCount: 0,
                };
                const navigationAddress = this.preparedRead.getPublicationNavigationAddress(lease);
                const navigationAuthority = navigationStatus === 'valid'
                    && navigationAddress
                    ? 'valid' as const
                    : 'unavailable' as const;
                const preparedReadState: Extract<TrackedRootReadinessState, { state: 'ready' }> = {
                    state: 'ready',
                    root: searchableRoot,
                    navigationAuthorityMode: 'canonical_v4',
                    proofDebugHint,
                    publication: {
                        id: lease.id,
                        publication: lease.publication,
                    },
                    navigationStatus,
                };
                const attachSearchResultSet = (
                    envelope: SearchGroupedResponseEnvelope,
                    resultSet: FinalizedSearchResultSet | undefined,
                    rerankerApplied: boolean,
                    orderAuthority: SearchOrderAuthority,
                ): SearchGroupedResponseEnvelope => {
                    if (!resultSet) return envelope;
                    const responseByteLimit = debugMode === "full"
                        ? SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES
                        : SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES;
                    const successfulEnvelope = removeCacheAdmissionWarning(envelope);
                    const baseEnvelopeDraft: Partial<SearchGroupedResponseEnvelope> = structuredClone(
                        successfulEnvelope,
                    );
                    const resultSpecificHints = baseEnvelopeDraft.hints;
                    delete baseEnvelopeDraft.results;
                    delete baseEnvelopeDraft.disclosure;
                    delete baseEnvelopeDraft.continuation;
                    delete baseEnvelopeDraft.recommendedNextAction;
                    delete baseEnvelopeDraft.rankedSetDigest;
                    delete baseEnvelopeDraft.resultIndex;
                    delete baseEnvelopeDraft.hints;
                    const frozenHints = freezeContinuationHints(resultSpecificHints);
                    const queryPolicyDigest = crypto.createHash("sha256").update(serializeCanonicalJson([
                        input.query,
                        input.scope,
                        input.groupBy,
                        input.rankingMode,
                        retrievalPolicy,
                        queryPlan,
                    ]), "utf8").digest("hex");
                    const rerankerIdentity = resolveSearchRerankerBindingIdentity(
                        this.reranker,
                        rerankerApplied,
                    );
                    const rerankerProjectionIdentity = resolveSearchRerankerProjectionIdentity(
                        this.reranker,
                        rerankerApplied,
                    );
                    const rerankerRequestIdentity = resolveSearchRerankRequestIdOrNone(
                        this.reranker,
                        rerankerApplied,
                    );
                    const bindingInput = buildFrozenSearchRankedSetBindingInput({
                        publication: lease,
                        queryPolicyDigest,
                        rerankerIdentity,
                        rerankerProjectionIdentity,
                        rerankerRequestIdentity,
                        rankingPolicyIdentity: resolveSearchRankingPolicyIdentity({
                            orderAuthority,
                        }),
                        orderedResults: resultSet.orderedResults,
                        recommendedActions: resultSet.recommendedActions,
                    });
                    const rankedSetBinding = buildSearchRankedSetBinding(bindingInput);
                    const baseEnvelope = {
                        ...baseEnvelopeDraft,
                        rankedSetDigest: rankedSetBinding.rankedSetDigest,
                        ...(frozenHints ? { hints: frozenHints } : {}),
                    } as FrozenSearchResultSet["baseEnvelope"];
                    let boundEnvelope: SearchGroupedResponseEnvelope;
                    if (envelope.continuation) {
                        const stored = this.continuationCoordinator.store(this, {
                            value: {
                                canonicalRoot: effectiveRoot,
                                publication: structuredClone({
                                    id: lease.id,
                                    publication: lease.publication,
                                }),
                                queryPolicyDigest,
                                rankedSetBinding,
                                responseByteLimit,
                                pageSize: retrievalPolicy.disclosureResultLimit,
                                baseEnvelope,
                                orderedResults: [...resultSet.orderedResults],
                                recommendedActions: [...resultSet.recommendedActions],
                            },
                            nextOffset: resultSet.initialReturnedCount,
                            reservedReplayBytes: responseByteLimit,
                            nowMs: this.environment.now(),
                        });
                        if (stored.status === "not_admissible") {
                            const initialEnvelope = { ...envelope };
                            delete initialEnvelope.continuation;
                            delete initialEnvelope.rankedSetDigest;
                            delete initialEnvelope.resultIndex;
                            return {
                                ...initialEnvelope,
                                pagination: {
                                    totalGroupCount: resultSet.orderedResults.length,
                                    returnedGroupCount: resultSet.initialReturnedCount,
                                    continuation: "not_admissible" as const,
                                },
                                warnings: buildSearchWarningDetails([
                                    ...(envelope.warnings?.map((warning) => warning.code) ?? []),
                                    WARNING_CODES.SEARCH_RESULT_SET_NOT_CACHE_ADMISSIBLE,
                                ]),
                            };
                        }
                        boundEnvelope = {
                            ...successfulEnvelope,
                            rankedSetDigest: rankedSetBinding.rankedSetDigest,
                            pagination: {
                                totalGroupCount: resultSet.orderedResults.length,
                                returnedGroupCount: resultSet.initialReturnedCount,
                                continuation: "attached" as const,
                            },
                            continuation: {
                                ...envelope.continuation,
                                handle: stored.handle,
                            },
                        };
                    } else {
                        boundEnvelope = {
                            ...successfulEnvelope,
                            rankedSetDigest: rankedSetBinding.rankedSetDigest,
                        };
                    }
                    if (input.includeResultIndex !== true) return boundEnvelope;
                    const indexed = attachCompactSearchResultIndex({
                        envelope: boundEnvelope,
                        orderedResults: resultSet.orderedResults,
                        rankedSetDigest: rankedSetBinding.rankedSetDigest,
                        maxResponseBytes: responseByteLimit,
                    });
                    if (indexed.status === "attached") return indexed.envelope;
                    const warnedEnvelope: SearchGroupedResponseEnvelope = {
                        ...successfulEnvelope,
                        rankedSetDigest: rankedSetBinding.rankedSetDigest,
                        ...(boundEnvelope.continuation
                            ? { continuation: boundEnvelope.continuation }
                            : {}),
                        warnings: buildSearchWarningDetails([
                            ...(boundEnvelope.warnings?.map((warning) => warning.code) ?? []),
                            WARNING_CODES.SEARCH_RESULT_INDEX_NOT_ADMISSIBLE,
                        ]),
                    };
                    return Buffer.byteLength(JSON.stringify(warnedEnvelope), "utf8")
                        <= responseByteLimit
                        ? warnedEnvelope
                        : boundEnvelope;
                };
                const exactFastPath = await runExactRegistryFastPath({
                    absolutePath,
                    effectiveRoot,
                    requestedSubdirectory,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit,
                    disclosureLimit: retrievalPolicy.disclosureResultLimit,
                    includeResultIndex: input.includeResultIndex === true,
                    debugMode,
                    rankingMode: input.rankingMode,
                    semanticQuery,
                    parsedOperators,
                    queryPlan,
                    freshnessDecision,
                    freshnessSummary: initialFreshnessSummary,
                    proofDebugHint,
                    partialIndexSearchWarnings,
                    phaseTimings,
                    readiness: readinessDebug,
                    candidateLimit,
                    maxAttempts,
                    operatorSummary: initialOperatorSummary,
                    filterSummary: initialFilterSummary,
                    changedFilesState: initialChangedFilesState,
                    observedChangedFilesState: initialObservedChangedFilesState,
                    debugChangedFilesState: initialDebugChangedFilesState,
                    changedFilesCount: initialChangedFilesCount,
                    changedFilesBoostSkippedForLargeChangeSet: initialChangedFilesBoostSkippedForLargeChangeSet,
                    dirtyFilesNotFreshened: initialDirtyFilesNotFreshened,
                    rankingProvenance: initialRankingProvenance,
                    previewMaxBytes: SEARCH_GROUP_PREVIEW_MAX_BYTES,
                    navigationAuthority,
                }, {
                    searchQuerySupport: this.searchQuerySupport,
                    measureSearchPhase: (phase, run) => this.measureSearchPhase(phaseTimings, phase, run),
                    loadRegistryManifest: () => this.preparedRead.loadPreparedNavigationManifest(
                        preparedReadState,
                        readinessDebug.operations,
                    ),
                    loadRegistryValidatedRelationshipNavigation: (exactInput) => this.readiness.loadRegistryValidatedRelationshipNavigation({
                        ...exactInput,
                        preparedRead: preparedReadState,
                        operations: readinessDebug.operations,
                    }),
                    buildRelationshipBackedCallGraph: (exactInput) => navigationAddress
                        ? this.hints.buildRelationshipBackedCallGraph({
                            ...exactInput,
                            publicationId: navigationAddress.publicationId,
                            navigationRoot: navigationAddress.navigationRoot,
                        })
                        : Promise.resolve(null),
                    buildChangedCodeDebug: (_codebaseRoot, changedFilesState) => this.hints.buildChangedCodeDebug(preparedReadState, changedFilesState),
                    buildGeneratedArtifactsVerificationHint: (codebaseRoot, results) => this.hints.buildGeneratedArtifactsVerificationHint(codebaseRoot, results),
                    getSearchNavigationHelpers: () => this.hints.getSearchNavigationHelpers(),
                    now: this.environment.now,
                });
                let exactRegistryDebug: ExactRegistryLookupDebug | undefined = exactFastPath.exactRegistryDebug;
                let searchSymbolRegistry: SymbolRegistry | undefined = exactFastPath.searchSymbolRegistry;
                let searchSymbolRegistryManifestHash: string | undefined = exactFastPath.searchSymbolRegistryManifestHash;
                let preparedSearchRerankStructuralRelationships: PreparedSearchRerankStructuralRelationships | undefined;
                let structuralContextLoad: Promise<Readonly<{
                    status: "available" | "unavailable" | "incompatible";
                    preparedRelationships?: PreparedSearchRerankStructuralRelationships;
                }>> | undefined;
                let exactRegistryFallbackForTrackedLexical = exactFastPath.exactRegistryFallbackForTrackedLexical;

                if (exactFastPath.kind === 'handled') {
                    let exactEnvelope = exactFastPath.finalized.envelope;
                    if (
                        (debugMode === 'freshness' || debugMode === 'full')
                        && exactEnvelope.hints?.debugSearch
                    ) {
                        exactEnvelope = {
                            ...exactEnvelope,
                            hints: {
                                ...exactEnvelope.hints,
                                debugSearch: {
                                    ...exactEnvelope.hints.debugSearch,
                                    readiness: structuredClone(readinessDebug),
                                },
                            },
                        };
                    }
                    if (
                        exactFastPath.finalized.kind === "ok"
                        && exactEnvelope.resultMode === "grouped"
                    ) {
                        exactEnvelope = attachSearchResultSet(
                            exactEnvelope,
                            exactFastPath.finalized.resultSet,
                            false,
                            "retrieval_order",
                        );
                    }
                    await this.readiness.touchWatchedCodebaseBestEffort(effectiveRoot);
                    this.preparedRead.seedPreparedRead(preparedReadState, preservePreparedProofAge);
                    return {
                        content: [{ type: "text", text: this.hints.stringifyToolJson(exactEnvelope) }],
                        ...(exactFastPath.finalized.kind === "page_too_large" ? { isError: true } : {}),
                        meta: {
                            searchDiagnostics: {
                                ...searchDiagnostics,
                                resultsBeforeFilter: exactFastPath.resultsBeforeFilter,
                                resultsAfterFilter: exactFastPath.resultsAfterFilter,
                                searchPassCount: 0,
                                searchPassSuccessCount: 0,
                                searchPassFailureCount: 0,
                            }
                        }
                    };
                }

                let entrypointOwnerEvidence: EntrypointOwnerEvidenceResolution | undefined;
                if (
                    !staleWhileSync
                    && entrypointOwnerSeeking
                    && navigationStatus === "valid"
                    && navigationAddress
                ) {
                    if (!searchSymbolRegistry) {
                        const registryState = await this.preparedRead.loadPreparedNavigationManifest(
                            preparedReadState,
                            readinessDebug.operations,
                        );
                        if (registryState.status === "ok") {
                            searchSymbolRegistry = registryState.registry;
                            searchSymbolRegistryManifestHash = registryState.manifestHash;
                        }
                    }
                    if (searchSymbolRegistry && searchSymbolRegistryManifestHash) {
                        const preparedEvidence = await prepareEntrypointOwnerEvidence({
                            codebaseRoot: effectiveRoot,
                            registry: searchSymbolRegistry,
                            publication: {
                                publicationId: lease.id,
                                collectionName: lease.publication.vector.collectionName,
                                policyHash: lease.publication.policy.policyHash,
                                navigationPublicationId: navigationAddress.publicationId,
                                symbolRegistryManifestHash: searchSymbolRegistryManifestHash,
                            },
                        });
                        if ("resolution" in preparedEvidence) {
                            preparedEntrypointOwnerEvidence = preparedEvidence;
                            const manifestComparison = await this.freshness.compareSourcePathsToFreshnessCheckpoint(
                                effectiveRoot,
                                ["pyproject.toml"],
                                lease,
                            );
                            if (manifestComparison.status === "matches") {
                                entrypointOwnerEvidence = preparedEvidence.resolution;
                            } else {
                                entrypointOwnerEvidence = {
                                    ...preparedEvidence.resolution,
                                    status: "publication_incompatible",
                                    owners: [],
                                    resolvedOwnerCount: 0,
                                    resolutionComplete: false,
                                };
                                await preparedEvidence.release();
                                preparedEntrypointOwnerEvidence = undefined;
                            }
                        } else {
                            entrypointOwnerEvidence = preparedEvidence;
                        }
                    }
                }

                const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
                const resolvedRerankQuery = resolveSearchRerankQuery({
                    semanticQuery: parsedOperators.semanticQuery,
                    focusedQueryV2: buildSearchRerankQuery({
                        semanticQuery: parsedOperators.semanticQuery,
                        answerFocus,
                    }),
                    projectionIdentity: this.reranker?.getQueryProjectionVersion?.(),
                });
                const rerankerDocumentProjectionIdentity = resolveSearchRerankDocumentProjectionIdentity(
                    this.reranker?.getDocumentProjectionVersion?.(),
                );
                const wantsStructuralContext = rerankerDocumentProjectionIdentity
                    === SEARCH_RERANK_DOCUMENT_POLICY.id;
                const execution = await runSearchExecution({
                    effectiveRoot,
                    scope: input.scope,
                    rankingMode: input.rankingMode,
                    resultMode: input.resultMode,
                    limit: input.limit,
                    debugMode,
                    semanticQuery,
                    answerFocus,
                    rerankQuery: resolvedRerankQuery.query,
                    rerankQueryProjectionIdentity: resolvedRerankQuery.queryProjectionIdentity,
                    parsedOperators,
                    queryPlan,
                    exactRegistryEligible: exactRegistryFallbackForTrackedLexical,
                    exactRegistryFallbackForTrackedLexical,
                    freshnessMode: freshnessDecision.mode,
                    observedChangedFilesState: initialObservedChangedFilesState,
                    retrievalPolicy,
                    entrypointOwnerEvidence,
                    requestedSubdirectory,
                    dirtyFilesNotFreshened: initialDirtyFilesNotFreshened,
                }, {
                    searchQuerySupport: this.searchQuerySupport,
                    semanticSearch: (request) => {
                        if (
                            debugMode === 'full'
                            && this.environment.semanticSearchWithCandidateTraceInPublication
                        ) {
                            return this.environment.semanticSearchWithCandidateTraceInPublication(
                                lease,
                                request,
                                SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE,
                                retrievalPolicy.diagnosticCandidateLimit !== undefined
                                    ? {
                                        captureLexicalFallback: true,
                                        diagnosticCandidateLimit: retrievalPolicy.diagnosticCandidateLimit,
                                        ...(request.diagnosticLexicalFallbackTerms
                                            ? { lexicalFallbackTerms: request.diagnosticLexicalFallbackTerms }
                                            : {}),
                                    }
                                    : {},
                            );
                        }
                        if (!this.environment.semanticSearchInPublication) {
                            throw new Error("Publication-bound semantic search is unavailable.");
                        }
                        return this.environment.semanticSearchInPublication(lease, request);
                    },
                    reranker: staleWhileSync ? null : this.reranker,
                    ...(!staleWhileSync && rerankerDocumentProjectionIdentity === SEARCH_RERANK_DOCUMENT_POLICY.id
                        ? {
                            buildRerankDocument: async (
                                rerankQuery: string,
                                result: SearchResultLike,
                            ): Promise<SearchRerankProjectionResult> => {
                                const candidateId = searchRerankCandidateId(result);
                                if (navigationStatus !== "valid" || !navigationAddress) {
                                    return {
                                        ok: false,
                                        candidateId,
                                        reason: "navigation_status_invalid",
                                    };
                                }
                                if (!searchSymbolRegistry || !searchSymbolRegistryManifestHash) {
                                    const registryState = await this.preparedRead.loadPreparedNavigationManifest(
                                        preparedReadState,
                                        readinessDebug.operations,
                                    );
                                    if (registryState.status !== "ok") {
                                        return {
                                            ok: false,
                                            candidateId,
                                            reason: "registry_load_failed",
                                        };
                                    }
                                    searchSymbolRegistry = registryState.registry;
                                    searchSymbolRegistryManifestHash = registryState.manifestHash;
                                }
                                const structuralContext = wantsStructuralContext
                                    ? await (structuralContextLoad ??= (async () => {
                                        const compatibility = await this.preparedRead.loadPreparedNavigationCompatibility(
                                            preparedReadState,
                                            searchSymbolRegistryManifestHash!,
                                            readinessDebug.operations,
                                        );
                                        const status = resolveSearchRerankStructuralContextStatus({
                                            relationshipStatus: compatibility.relationships.status,
                                        });
                                        if (status !== "available" || compatibility.relationships.status !== "ok") {
                                            return { status };
                                        }
                                        preparedSearchRerankStructuralRelationships
                                            = prepareSearchRerankStructuralRelationships(
                                                compatibility.relationships.records,
                                            );
                                        return {
                                            status,
                                            preparedRelationships: preparedSearchRerankStructuralRelationships,
                                        };
                                    })())
                                    : undefined;
                                return projectPublicationBoundSearchRerankDocument({
                                    candidateId,
                                    codebaseRoot: effectiveRoot,
                                    semanticQuery: rerankQuery,
                                    maxSourceBytes: this.environment.getReadFileMaxBytes(),
                                    result,
                                    registry: searchSymbolRegistry,
                                    ...(structuralContext?.preparedRelationships
                                        ? { preparedStructuralRelationships: structuralContext.preparedRelationships }
                                        : {}),
                                    ...(structuralContext
                                        ? { structuralContextStatus: structuralContext.status }
                                        : {}),
                                });
                            },
                        }
                        : {}),
                    classifyEmbeddingProviderError,
                    classifyVectorBackendError,
                    measureSearchPhase: (phase, run) => this.measureSearchPhase(phaseTimings, phase, run),
                }, searchDiagnostics);

                if (execution.kind === 'vector_backend_unavailable') {
                    const payload = this.buildVectorBackendSearchPayload(execution.diagnostic, {
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit
                    });
                    return {
                        content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                        meta: {
                            searchDiagnostics: {
                                ...searchDiagnostics,
                                error: execution.diagnostic.code
                            }
                        }
                    };
                }

                if (execution.kind === 'embedding_provider_unavailable') {
                    const payload = this.buildEmbeddingProviderSearchPayload(execution.diagnostic, {
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit,
                    });
                    return {
                        content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                        isError: !execution.diagnostic.retryable,
                        meta: {
                            searchDiagnostics: {
                                ...searchDiagnostics,
                                error: execution.diagnostic.code,
                            },
                        },
                    };
                }

                if (execution.kind === 'all_semantic_passes_failed') {
                    const payload = this.buildInvalidSearchRequestPayload({
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit
                    }, "Search backend failed: all semantic search passes failed. Retry and verify embedding/vector backends are reachable.", "not_ready", "search_backend_failed");
                    if (debugMode === 'full') {
                        payload.hints = {
                            ...(payload.hints || {}),
                            debugSearch: {
                                semanticPassFailures: execution.semanticPassFailures.map((failure) => ({ ...failure })),
                            },
                        };
                    }
                    return {
                        content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                        isError: true,
                        meta: { searchDiagnostics }
                    };
                }

                if (exactFastPath.warning) {
                    execution.searchWarnings.push(exactFastPath.warning);
                }

                const finalized = await finalizeSearchResults({
                    absolutePath,
                    effectiveRoot,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit,
                    disclosureLimit: retrievalPolicy.disclosureResultLimit,
                    includeResultIndex: input.includeResultIndex === true,
                    rerankerResultLimit: retrievalPolicy.rerankerResultLimit,
                    debugMode,
                    rankingMode: input.rankingMode,
                    freshnessDecision,
                    freshnessSummary: {
                        ...execution.freshnessSummary,
                        lastSyncAt: typeof freshnessDecision.lastSyncAt === 'string' ? freshnessDecision.lastSyncAt : null,
                    },
                    proofDebugHint,
                    partialIndexSearchWarnings,
                    phaseTimings,
                    readiness: readinessDebug,
                    parsedOperators,
                    queryPlan,
                    maxAttempts,
                    exactRegistryDebug,
                    searchSymbolRegistry,
                    searchSymbolRegistryManifestHash,
                    execution,
                    navigationAuthority,
                    navigationStatus,
                }, {
                    searchQuerySupport: this.searchQuerySupport,
                    measureSearchPhase: (phase, run) => this.measureSearchPhase(phaseTimings, phase, run),
                    loadRegistryManifest: () => this.preparedRead.loadPreparedNavigationManifest(
                        preparedReadState,
                        readinessDebug.operations,
                    ),
                    loadRegistryValidatedRelationshipNavigation: (finalizationInput) => this.readiness.loadRegistryValidatedRelationshipNavigation({
                        ...finalizationInput,
                        preparedRead: preparedReadState,
                        operations: readinessDebug.operations,
                    }),
                    buildRequiresReindexPayload: (codebasePath, detail, searchContext) => this.hints.getToolResponseBuilders().buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope,
                    buildChangedCodeDebug: (_codebaseRoot, changedFilesState) => this.hints.buildChangedCodeDebug(preparedReadState, changedFilesState),
                    buildGeneratedArtifactsVerificationHint: (codebaseRoot, results) => this.hints.buildGeneratedArtifactsVerificationHint(codebaseRoot, results),
                    getSearchNavigationHelpers: () => this.hints.getSearchNavigationHelpers(),
                    parseIndexedAtMs: (indexedAt?: string) => this.environment.parseIndexedAtMs(indexedAt),
                    resolveSearchOwnerFromRegistry: (result, registry, plan) => this.resolveSearchOwnerFromRegistry(result, registry, plan),
                    now: this.environment.now,
                });
                let envelope = finalized.envelope;
                const initialPageTooLarge = finalized.kind === "page_too_large";
                let barrierChanged = false;
                if (preparedEntrypointOwnerEvidence) {
                    const finalizedEntrypointEvidence = await preparedEntrypointOwnerEvidence.finalize({
                        validatePreparedAuthority: async () => {
                            if (!await this.preparedRead.isPublicationLeaseAdmitted(lease)) {
                                barrierChanged = true;
                                return;
                            }
                            const manifestComparison = await this.freshness.compareSourcePathsToFreshnessCheckpoint(
                                effectiveRoot,
                                ["pyproject.toml"],
                                lease,
                            );
                            barrierChanged = manifestComparison.status !== "matches";
                        },
                    });
                    if (finalizedEntrypointEvidence.status !== "available") {
                        barrierChanged = true;
                    }
                }
                if (barrierChanged) {
                    return undefined;
                }
                if (finalized.kind === "ok" && envelope.resultMode === "grouped") {
                    envelope = attachSearchResultSet(
                        envelope,
                        finalized.resultSet,
                        searchDiagnostics.rerankerUsed,
                        execution.orderAuthority,
                    );
                }

                await this.readiness.touchWatchedCodebaseBestEffort(effectiveRoot);
                this.preparedRead.seedPreparedRead(preparedReadState, preservePreparedProofAge);
                return {
                    content: [{ type: "text", text: this.hints.stringifyToolJson(envelope) }],
                    ...(initialPageTooLarge ? { isError: true } : {}),
                    meta: { searchDiagnostics }
                };
            });
            if (outcome.status === 'stale' || outcome.result === undefined) {
                if (sourceDriftRetryCount === 0) {
                    return undefined;
                }
                const payload = this.hints.getToolResponseBuilders().buildSourceStateUnverifiedSearchPayload(
                    effectiveRoot,
                    {
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit,
                    },
                    "Source changed again while Satori was preparing this response.",
                    "source_changed_during_request",
                    {
                        debugMode,
                        freshnessDecision,
                        readiness: readinessDebug,
                    },
                );
                return {
                    content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                    meta: { searchDiagnostics },
                };
            }
            return outcome.result;
        } catch (error) {
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                const payload = this.buildVectorBackendSearchPayload(vectorBackendDiagnostic, {
                    path: absolutePathOrRaw(input.path),
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                });
                return {
                    content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                    meta: {
                        searchDiagnostics: {
                            tool: 'search_codebase',
                            error: vectorBackendDiagnostic.code
                        }
                    }
                };
            }
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                const payload = this.buildInvalidSearchRequestPayload({
                    path: typeof input.path === 'string' ? absolutePathOrRaw(input.path) : '',
                    query: typeof input.query === 'string' ? input.query : '',
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                }, COLLECTION_LIMIT_MESSAGE, 'not_ready', 'vector_backend_unavailable');
                payload.hints = {
                    ...(payload.hints || {}),
                    backend: {
                        provider: 'zilliz',
                        retryable: false,
                        nextSteps: [
                            'List current Satori-managed collections with manage_index status or retry create to get full collection-limit guidance.',
                            'Ask the user which collection to delete.',
                            'Retry manage_index create with zillizDropCollection set to the exact chosen collection name.',
                        ],
                    },
                };
                return {
                    content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                    isError: true
                };
            }

            const payload = this.buildInvalidSearchRequestPayload({
                path: typeof input.path === 'string' ? absolutePathOrRaw(input.path) : '',
                query: typeof input.query === 'string' ? input.query : '',
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit
            }, `Unexpected search_codebase failure: ${errorMessage}`, 'not_ready');
            return {
                content: [{ type: "text", text: this.hints.stringifyToolJson(payload) }],
                isError: true
            };
        } finally {
            await preparedEntrypointOwnerEvidence?.release();
        }
    }

    public async continueOwned(
        args: ToolArgs,
        routedLookup?: SearchContinuationLookup,
    ): Promise<{
        content: Array<{ type: "text"; text: string }>;
        isError?: boolean;
    }> {
        const handle = typeof args.handle === "string" ? args.handle.trim() : "";
        const expectedOffset = typeof args.expectedOffset === "number"
            ? args.expectedOffset
            : Number(args.expectedOffset);
        const requestedLimit = typeof args.limit === "number" ? args.limit : Number(args.limit);
        const fail = (code: string, message: string) => ({
            content: [{
                type: "text" as const,
                text: this.hints.stringifyToolJson({ status: "not_ready", code, message }),
            }],
            isError: true,
        });
        if (!/^[a-f0-9]{48}$/.test(handle)) {
            return fail("SEARCH_RESULT_SET_HANDLE_INVALID", "Search continuation handle is invalid.");
        }
        if (
            !Number.isSafeInteger(expectedOffset)
            || expectedOffset < 0
            || expectedOffset > this.environment.getCapabilities().getMaxFrozenSearchResults()
        ) {
            return fail(
                "SEARCH_RESULT_SET_OFFSET_INVALID",
                `Search continuation expectedOffset must be an integer from 0 to ${this.environment.getCapabilities().getMaxFrozenSearchResults()}.`,
            );
        }
        if (
            args.limit !== undefined
            && (!Number.isSafeInteger(requestedLimit)
                || requestedLimit <= 0
                || requestedLimit > this.environment.getCapabilities().getMaxSearchPageSize())
        ) {
            return fail(
                "SEARCH_RESULT_SET_LIMIT_INVALID",
                `Search continuation limit must be an integer from 1 to ${this.environment.getCapabilities().getMaxSearchPageSize()}.`,
            );
        }

        const nowMs = this.environment.now();
        const lookup = routedLookup ?? this.continuationCoordinator.lookup(handle, nowMs);
        if (lookup.status === "expired") {
            return fail("SEARCH_RESULT_SET_EXPIRED", "Search continuation handle has expired. Run search_codebase again.");
        }
        if (lookup.status === "not_found") {
            return fail("SEARCH_RESULT_SET_NOT_FOUND", "Search continuation handle is unavailable in this process. Run search_codebase again.");
        }
        if (lookup.status === "owner_unavailable") {
            return fail("SEARCH_RESULT_SET_STALE", "Search continuation runtime is no longer available. Run search_codebase again.");
        }
        if (lookup.owner !== this) {
            return lookup.owner.continueOwned(args, lookup);
        }

        const entry = lookup.entry;
        let bindingValid = false;
        try {
            const rerankerIdentity = resolveSearchRerankerBindingIdentity(
                this.reranker,
                entry.rankedSetBinding.rerankerIdentity.kind === "provider",
            );
            const rerankerProjectionIdentity = resolveSearchRerankerProjectionIdentity(
                this.reranker,
                entry.rankedSetBinding.rerankerIdentity.kind === "provider",
            );
            const rerankerRequestIdentity = resolveSearchRerankRequestIdOrNone(
                this.reranker,
                entry.rankedSetBinding.rerankerIdentity.kind === "provider",
            );
            bindingValid = entry.baseEnvelope.rankedSetDigest
                === entry.rankedSetBinding.rankedSetDigest
                && verifySearchRankedSetBinding(
                    entry.rankedSetBinding,
                    buildFrozenSearchRankedSetBindingInput({
                        publication: entry.publication,
                        queryPolicyDigest: entry.queryPolicyDigest,
                        rerankerIdentity,
                        rerankerProjectionIdentity,
                        rerankerRequestIdentity,
                        rankingPolicyIdentity: resolveSearchRankingPolicyIdentity({
                            orderAuthority: entry.rankedSetBinding.rerankerIdentity.kind === "provider"
                                ? "reranker_order"
                                : "retrieval_order",
                        }),
                        orderedResults: entry.orderedResults,
                        recommendedActions: entry.recommendedActions,
                    }),
                );
        } catch {
            bindingValid = false;
        }
        if (!bindingValid) {
            this.continuationCoordinator.remove(handle);
            return fail(
                "SEARCH_RESULT_SET_STALE",
                "Search result-set identity changed. Run search_codebase again.",
            );
        }
        if (!await this.preparedRead.isPublicationAdmitted(entry.publication)) {
            this.continuationCoordinator.remove(handle);
            return fail("SEARCH_RESULT_SET_STALE", "Search Publication is no longer admitted by current selection controls. Run search_codebase again.");
        }

        const pageSize = Number.isFinite(requestedLimit)
            ? requestedLimit
            : entry.pageSize;
        if (lookup.nextOffset !== expectedOffset) {
            if (
                lookup.lastPage?.expectedOffset === expectedOffset
                && lookup.lastPage.pageSize === pageSize
            ) {
                return { content: [{ type: "text", text: lookup.lastPage.responseText }] };
            }
            return fail(
                "SEARCH_RESULT_SET_CONFLICT",
                "Search continuation offset or page size does not match the current cursor. Retry the exact prior request or use the latest continuation response.",
            );
        }
        const remainingResults = entry.orderedResults.slice(lookup.nextOffset);
        if (remainingResults.length === 0) {
            return fail(
                "SEARCH_RESULT_SET_CONSUMED",
                "Search continuation is complete. Reuse the prior expectedOffset only to retry its page, or run search_codebase again.",
            );
        }

        const projection = projectGroupedDisclosure({
            orderedResults: remainingResults,
            callerLimit: remainingResults.length,
            disclosureLimit: pageSize,
            maxResponseBytes: entry.responseByteLimit,
            includeSummary: true,
            buildEnvelope: (results, disclosure) => {
                const resultCounts = entry.baseEnvelope.resultCounts
                    ? {
                        ...entry.baseEnvelope.resultCounts,
                        returnedGroupCount: results.length,
                        remainingGroupCount: Math.max(
                            0,
                            entry.baseEnvelope.resultCounts.effectiveFrozenTotal
                                - lookup.nextOffset
                                - results.length,
                        ),
                    }
                    : undefined;
                const recommendedNextAction = entry.recommendedActions[lookup.nextOffset] ?? null;
                const noiseMitigationHint = this.searchQuerySupport.buildNoiseMitigationHint(
                    entry.canonicalRoot,
                    results.map((result) => result.target.file),
                    entry.baseEnvelope.scope,
                    this.searchQuerySupport.parseSearchOperators(entry.baseEnvelope.query),
                );
                const generatedArtifactsHint = this.hints.buildGeneratedArtifactsVerificationHint(
                    entry.canonicalRoot,
                    results.map((result) => ({
                        file: result.target.file,
                        span: result.target.span,
                    })),
                );
                const pageHints: SearchResponseHints = {
                    ...(entry.baseEnvelope.hints ?? {}),
                    ...(noiseMitigationHint ? { noiseMitigation: noiseMitigationHint } : {}),
                    ...(generatedArtifactsHint
                        ? {
                            verification: {
                                ...(entry.baseEnvelope.hints?.verification ?? {}),
                                generatedArtifacts: generatedArtifactsHint,
                            },
                        }
                        : {}),
                };
                const envelope: SearchGroupedResponseEnvelope = {
                    ...entry.baseEnvelope,
                    ...(resultCounts ? { resultCounts } : {}),
                    ...(Object.keys(pageHints).length > 0 ? { hints: pageHints } : {}),
                    ...(recommendedNextAction ? { recommendedNextAction } : {}),
                    ...(disclosure ? { disclosure } : {}),
                    results: [...results],
                };
                return (resultCounts?.remainingGroupCount ?? (remainingResults.length - results.length)) > 0
                    ? {
                        ...envelope,
                        continuation: {
                            handle,
                            nextOffset: lookup.nextOffset + results.length,
                            remainingGroupCount: resultCounts?.remainingGroupCount
                                ?? (remainingResults.length - results.length),
                        },
                    }
                    : envelope;
            },
        });
        if (projection.status === "page_too_large") {
            return fail("SEARCH_RESULT_SET_PAGE_TOO_LARGE", "The next search result cannot fit within the response byte budget. Use read_file on an earlier target or run a narrower search.");
        }
        if (!await this.preparedRead.isPublicationAdmitted(entry.publication)) {
            this.continuationCoordinator.remove(handle);
            return fail(
                "SEARCH_RESULT_SET_STALE",
                "Search Publication selection controls changed while the continuation page was being projected. Run search_codebase again.",
            );
        }
        const nextOffset = lookup.nextOffset + projection.results.length;
        const responseText = this.hints.stringifyToolJson(projection.envelope);
        const advanced = this.continuationCoordinator.advance({
            handle,
            expectedOffset: lookup.nextOffset,
            nextOffset,
            nowMs: this.environment.now(),
            replay: {
                expectedOffset,
                pageSize,
                responseText,
            },
        });
        if (advanced !== "advanced") {
            if (advanced === "conflict") {
                const concurrent = this.continuationCoordinator.lookup(handle, this.environment.now());
                if (
                    concurrent.status === "hit"
                    && concurrent.lastPage?.expectedOffset === expectedOffset
                    && concurrent.lastPage.pageSize === pageSize
                ) {
                    return {
                        content: [{ type: "text", text: concurrent.lastPage.responseText }],
                    };
                }
            }
            return fail(
                advanced === "conflict"
                    ? "SEARCH_RESULT_SET_CONFLICT"
                    : advanced === "too_large"
                        ? "SEARCH_RESULT_SET_PAGE_TOO_LARGE"
                        : "SEARCH_RESULT_SET_STALE",
                advanced === "too_large"
                    ? "The continuation page plus its retry receipt exceeds the result-set cache byte budget. Run a narrower search."
                    : "Search continuation was consumed or expired concurrently. Retry the exact prior request, use the latest continuation response, or run search_codebase again.",
            );
        }
        return {
            content: [{ type: "text", text: responseText }],
        };
    }
}
