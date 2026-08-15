import crypto from "node:crypto";
import {
    COLLECTION_LIMIT_MESSAGE,
    type ProvenGenerationReceipt,
    type ProvenVectorGenerationReceipt,
    type PreparedGenerationRevalidation,
    type SourceFreshnessPort,
    type NavigationStore,
    type Reranker,
} from "@zokizuan/satori-core";
import type { ProvenSourceFreshnessCheckpointEvidence, SemanticSearchCandidateTraceOptions, SemanticSearchExecutionResult, SemanticSearchRequest, SemanticSearchResult, SourceFreshnessPathComparison } from "@zokizuan/satori-core";
import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { CapabilityResolver } from "./capabilities.js";
import { absolutePathOrRaw } from "../utils.js";
import {
    SyncManager,
    type FreshnessDecision,
    type PreparedReadObservationUnavailableReason,
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
    CallGraphDirection,
    CallGraphEdge,
    CallGraphNode,
    CallGraphNote,
    CallGraphTestReference,
} from "./call-graph.js";
import {
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
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
// Recovery probe threshold for "likely interrupted" indexing states.
// Keep this shorter than snapshot merge stale semantics for better operator UX.

type SearchPhaseTimingKey =
    | 'prepareRead'
    | 'snapshotReload'
    | 'trackedRootResolution'
    | 'fingerprintGate'
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
    | 'publicationRetentionProof'
    | 'finalSourceValidation';

export type FrozenSearchResultSet = {
    canonicalRoot: string;
    vectorReceipt: ProvenVectorGenerationReceipt;
    generationReceipt?: ProvenGenerationReceipt;
    preparedObservation: string;
    sourceObservation: string | null;
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
    vectorReceipt: ProvenVectorGenerationReceipt;
    generationReceipt?: ProvenGenerationReceipt;
    preparedObservation: string;
    sourceObservation: string | null;
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
            collectionName: input.vectorReceipt.collectionName,
            marker: input.vectorReceipt.marker,
            policyDocumentDigest: input.vectorReceipt.policyDocumentDigest,
            navigation: input.generationReceipt
                ? { status: "sealed", receipt: input.generationReceipt.navigation }
                : { status: "not_bound" },
        },
        preparedObservation: input.preparedObservation,
        sourceObservation: input.sourceObservation,
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

type RequestSourceBarrier =
    | Readonly<{
        mode: 'watcher';
        observation: string;
        sourceObservation: string;
    }>
    | Readonly<{
        mode: 'full_comparison';
        authorityObservation: string;
    }>
    | Readonly<{
        mode: 'publication_consistent_stale_read';
        collectionName: string;
    }>;

type CompletedFreshnessRequestProof = Readonly<{
    checkpointObservation: string;
    collectionName: string;
    markerRunId: string;
    indexPolicyHash: string;
    comparisonMode: 'full' | 'exact_paths';
    exactPathCount: number;
    preRetrievalFullComparisons: number;
}>;

const WATCHER_UNAVAILABLE_SOURCE_REASONS = new Set([
    'watcher_disabled',
    'watcher_manager_not_started',
    'root_not_registered',
    'watcher_failed',
    'watcher_starting',
    'root_watcher_not_active',
    'watcher_observation_gap',
]);

type PreparedReadCacheObservationResult = {
    observation: string | null;
    sourceObservation: string | null;
    unavailableReason?: PreparedReadObservationUnavailableReason;
};

type CachedPreparedReadResult =
    | {
        status: "hit";
        state: Extract<TrackedRootReadinessState, { state: "ready" }>;
    }
    | {
        status: "miss";
        reason: SearchReadinessInvalidationReason;
        observationUnavailableReason?: PreparedReadObservationUnavailableReason;
    };

type NavigationManifestState = Awaited<ReturnType<NavigationStore['getManifest']>>;
type NavigationCompatibilityState = Awaited<ReturnType<NavigationStore['getCompatibilityState']>>;

type CompletionProbeDebugHint = {
    ok: false;
    reason: "probe_failed";
    message: string;
    action: string;
};

export type RelationshipBackedCallGraphResult = {
    supported: true;
    direction: CallGraphDirection;
    depth: number;
    limit: number;
    nodes: CallGraphNode[];
    edges: CallGraphEdge[];
    notes: CallGraphNote[];
    warnings?: string[];
    testReferences?: CallGraphTestReference[];
    notesTruncated: boolean;
    totalNoteCount: number;
    returnedNoteCount: number;
    sidecar: {
        builtAt: string;
        nodeCount: number;
        edgeCount: number;
    };
} | null;

/**
 * Phase 8 gate correction B - grouped narrow collaborator seams for the
 * search request coordinator. Each collaborator owns one dependency cluster;
 * the coordinator receives the composed set, never ToolHandlers itself.
 */

export interface SearchReadinessCollaborator {
    touchWatchedCodebaseBestEffort(codebasePath: string): Promise<void>;

    ensureFreshness(
        ...args: Parameters<SyncManager['ensureFreshness']>
    ): Promise<FreshnessDecision>;
    getPreparedReadDiagnostics?(codebasePath: string): PreparedReadWatcherDiagnostics;

    prepareTrackedRootReadWithObservation(
        absolutePath: string,
        onPhase: (phase: ReadinessPhase, durationMs: number) => void,
        accessMode?: 'semantic' | 'navigation',
    ): Promise<TrackedRootReadinessState>;

    loadRegistryValidatedCallGraphSidecar(input: {
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

    waitForSearchableSync(codebasePath: string, timeoutMs: number): Promise<boolean>;

    getTrackedRootReadiness(): TrackedRootReadiness;

    isPartialIndexNavigationUnavailable(info: unknown): boolean;

    getIndexingOperationForReadiness(codebasePath: string):
        | { action: "create" | "reindex" | "sync" | "repair"; phase: string; generation: number }
        | undefined;


    canSyncStaleLocal(codebasePath: string, reason: CompletionProofReason): boolean;

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

    buildStaleLocalHint(codebasePath: string, reason: CompletionProofReason): Record<string, unknown>;

    buildRepairHint(codebasePath: string): { tool: string; args: { action: string; path: string } };

    buildRelationshipBackedCallGraph(input: {
        codebaseRoot: string;
        generationId?: string;
        registry: SymbolRegistry;
        registryManifestHash: string;
        resolvedSymbol: SymbolRecord;
        sourceSpanRepair?: PythonSourceBackedSpanRepair;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
        readAuthorizedSourceLines?: (codebaseRoot: string, relativeFilePath: string) => Promise<string[] | undefined>;
    }): Promise<RelationshipBackedCallGraphResult>;

    buildManageIndexRecommendedAction(
        action: Extract<ManageIndexAction, "create" | "reindex" | "status" | "sync" | "repair">,
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

    getPreparedReadCacheObservation(codebasePath: string): PreparedReadCacheObservationResult;

    getPreparedAuthorityObservation(codebasePath: string): string | null;

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

    acquirePublicationReadLease(codebasePath: string): Promise<(() => void) | undefined>;
}

export interface SearchFreshnessCollaborator {
    getSourceFreshnessPort(): SourceFreshnessPort | undefined;

    inspectSourceFreshnessCheckpoint(
        codebasePath: string,
        checkpointIdentity?: string,
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<ProvenSourceFreshnessCheckpointEvidence>;

    compareAllSourceToFreshnessCheckpoint(
        codebasePath: string,
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SourceFreshnessPathComparison>;

    compareSourceObservationToFreshnessCheckpoint(
        codebasePath: string,
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SourceFreshnessPathComparison>;

    compareSourcePathsToFreshnessCheckpoint(
        codebasePath: string,
        relativePaths: readonly string[],
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SourceFreshnessPathComparison>;

    getPreparedGenerationRevalidator():
        | ((codebasePath: string, receipt: ProvenVectorGenerationReceipt, options?: {
            priorGenerationReceipt?: ProvenGenerationReceipt;
            navigationObservationChanged?: boolean;
        }) => Promise<PreparedGenerationRevalidation | null>)
        | undefined;
}

export interface SearchEnvironmentCollaborator {
    now(): number;

    getCapabilities(): CapabilityResolver;

    getReadFileMaxBytes(): number;

    parseIndexedAtMs(indexedAt?: string): number | undefined;

    getEmbeddingProviderName(): string;

    semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResult[]>;
    semanticSearchInProvenGeneration?: (
        receipt: ProvenVectorGenerationReceipt,
        request: SemanticSearchRequest,
    ) => Promise<SemanticSearchResult[]>;
    semanticSearchWithCandidateTraceInProvenGeneration?: (
        receipt: ProvenVectorGenerationReceipt,
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
            snapshotReload: 0,
            trackedRootResolution: 0,
            fingerprintGate: 0,
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
            publicationRetentionProof: 0,
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
        const input: SearchRequestInput = {
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
                exactPayloadRecounts: 0,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        };
        let preservePreparedProofAge = false;
        let preparedEntrypointOwnerEvidence: PreparedEntrypointOwnerEvidence | undefined;
        let observedChangedFilesForSearch: { available: boolean; files: Set<string> } | undefined;
        let completedFreshnessRequestProof: CompletedFreshnessRequestProof | undefined;

        const readinessPhaseToSearchPhase = {
            snapshot_reload: 'snapshotReload',
            tracked_root_resolution: 'trackedRootResolution',
            fingerprint_gate: 'fingerprintGate',
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
                    if (debugMode === 'full' && cached.observationUnavailableReason) {
                        readinessDebug.observationUnavailableReason = cached.observationUnavailableReason;
                    }
                    readinessDebug.operations.coldReadinessChecks += 1;
                    const prepareReadStartedAtMs = this.searchPhaseNowMs();
                    const trackedRootState = await this.readiness.prepareTrackedRootReadWithObservation(
                        absolutePath,
                        (phase, durationMs) => {
                            phaseTimings[readinessPhaseToSearchPhase[phase]] += durationMs;
                        },
                    );
                    if (trackedRootState.state === "ready") {
                        readinessDebug.operations.exactPayloadRecounts += trackedRootState.exactPayloadRecounts ?? 0;
                        if (debugMode === 'full') {
                            const sourceObservation = this.preparedRead.getPreparedReadCacheObservation(trackedRootState.root.path);
                            if (sourceObservation.unavailableReason) {
                                readinessDebug.observationUnavailableReason = sourceObservation.unavailableReason;
                            }
                        }
                    }
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
                            if (trackedRootState.state === "ready") {
                                readinessDebug.operations.exactPayloadRecounts += trackedRootState.exactPayloadRecounts ?? 0;
                            }
                            return trackedRootState;
                        },
                    );
                },
                getPreparedReadObservation: (canonicalRoot) => this.preparedRead.getPreparedAuthorityObservation(canonicalRoot),
                getIndexingOperation: (codebasePath) => this.readiness.getIndexingOperationForReadiness(codebasePath),
                ensureSearchFreshness: (effectiveRoot, preparedRead) => this.measureSearchPhase(
                    phaseTimings,
                    'ensureFreshness',
                    async () => {
                        const watcherObservation = this.readiness.getWatcherObservation(effectiveRoot);
                        if (watcherObservation.coverage !== 'ready') {
                            await this.readiness.touchWatchedCodebaseBestEffort(effectiveRoot);
                        }
                        const effectiveWatcherObservation = this.readiness.getWatcherObservation(effectiveRoot);
                        const fullSourceComparisonRequired = effectiveWatcherObservation.coverage !== 'ready'
                            || effectiveWatcherObservation.coverageGapSinceEpoch !== undefined;
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
                        const statusPreparedSourceObservation = preparedRead?.statusPrepared === true
                            ? this.preparedRead.getPreparedReadCacheObservation(effectiveRoot)
                            : null;

                        // A recent sync timestamp does not prove that Git-dirty files still
                        // match the published generation. Compare them exactly so search does
                        // not suppress synchronized persisted evidence behind a bounded overlay.
                        // Status proves the publication, not current source. Preserve the
                        // one-use shortcut only with a valid source observation or the
                        // established watcher-disabled fallback.
                        const statusPreparedSourceIsBound =
                            typeof statusPreparedSourceObservation?.sourceObservation === 'string'
                            || statusPreparedSourceObservation?.unavailableReason === 'watcher_disabled';
                        if (
                            preparedRead?.statusPrepared === true
                            && !exactSourceComparisonRequired
                            && statusPreparedSourceIsBound
                        ) {
                            return Promise.resolve({
                                mode: 'skipped_recent' as const,
                                checkedAt: new Date(this.environment.now()).toISOString(),
                                thresholdMs: SEARCH_FRESHNESS_THRESHOLD_MS,
                            });
                        }

                        const decision = await this.readiness.ensureFreshness(
                            effectiveRoot,
                            exactSourceComparisonRequired || fullSourceComparisonRequired
                                ? 0
                                : SEARCH_FRESHNESS_THRESHOLD_MS,
                            {
                                ...(preparedRead?.vectorReceipt
                                    ? { preparedVectorReceipt: preparedRead.vectorReceipt }
                                    : {}),
                                ...(exactSourceComparisonPaths
                                    ? { exactSourceComparisonPaths }
                                    : {}),
                                ...(fullSourceComparisonRequired && !exactSourceComparisonRequired
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
                                                | 'publication_activation'
                                                | 'publication_retention_proof',
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
                                                publication_retention_proof:
                                                    'publicationRetentionProof',
                                            }[phase] as SearchPhaseTimingKey;
                                            phaseTimings[timingKey] += durationMs;
                                        },
                                    }
                                    : {}),
                            },
                        );
                        if (
                            fullSourceComparisonRequired
                            && !decision.errorMessage
                            && (
                                decision.mode === 'synced'
                                || decision.mode === 'skipped_source_unchanged'
                                || decision.mode === 'reconciled_ignore_change'
                            )
                        ) {
                            const sourceFreshnessPort = this.freshness.getSourceFreshnessPort();
                            const checkpoint = sourceFreshnessPort
                                ? (await sourceFreshnessPort.prepareCurrentSourceObservation(effectiveRoot)).evidence
                                : await this.freshness.inspectSourceFreshnessCheckpoint(
                                    effectiveRoot,
                                );
                            if (checkpoint.status === 'valid' && checkpoint.generationReceipt) {
                                completedFreshnessRequestProof = {
                                    checkpointObservation: checkpoint.observationToken,
                                    collectionName: checkpoint.generationReceipt.collectionName,
                                    markerRunId: checkpoint.generationReceipt.marker.runId,
                                    indexPolicyHash:
                                        checkpoint.generationReceipt.marker.indexPolicyHash,
                                    comparisonMode: exactSourceComparisonPaths
                                        ? 'exact_paths'
                                        : 'full',
                                    exactPathCount: exactSourceComparisonPaths?.length ?? 0,
                                    preRetrievalFullComparisons:
                                        decision.mode === 'skipped_source_unchanged'
                                        && fullSourceComparisonRequired
                                        && !exactSourceComparisonRequired
                                            ? 1
                                            : 0,
                                };
                            }
                        }
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
                waitForSearchableSync: (codebasePath, timeoutMs) => this.readiness.waitForSearchableSync(
                    codebasePath,
                    timeoutMs
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
                buildSyncHint: (codebasePath) => this.hints.buildSyncHint(codebasePath),
                buildRepairHint: (codebasePath) => this.hints.buildRepairHint(codebasePath),
                buildStaleLocalHint: (codebasePath, reason) => this.hints.buildStaleLocalHint(codebasePath, reason),
                buildStaleLocalMessage: (codebasePath, requestedPath, reason) => this.hints.buildStaleLocalMessage(
                    codebasePath,
                    requestedPath,
                    reason
                ),
                canSyncStaleLocal: (codebasePath, reason) => this.readiness.canSyncStaleLocal(codebasePath, reason),
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
            let sourceBarrierChanged: () => Promise<boolean> = async () => false;
            let finalBarrierChanged = false;
            // The outer flow returns the blocked payload before the session
            // runs, so the session operates on the ready front-door outcome.
            const session = new PreparedPublicationReadSession<SearchFrontDoorReady>({
                prepareReadiness: async () => frontDoor as SearchFrontDoorReady,
                // The publication read lease is acquired only after readiness
                // (the front door) resolves.
                acquirePublicationReadLease: (prepared) => (
                    this.preparedRead.acquirePublicationReadLease(prepared.effectiveRoot)
                ),
                // Final authority revalidation: the prepared source barrier must
                // still match. Handled mid-execute drift paths release the lease
                // early, which skips this check in favour of the fresh attempt.
                // The execute performs the final barrier comparison; the session
                // revalidates against that captured result so drift paths and
                // stable paths both prove one final revalidation.
                //
                // Phase 5.2 R3 decision: finalBarrierChanged is retained as the
                // revalidation callable (compatibility rule: do not replace
                // finalBarrierChanged logic). Its source-freshness components are
                // port-backed after the 5.1 repair: the full-comparison branch
                // calls SourceFreshnessPort.compareCurrentSourceToCheckpoint /
                // compareAllCurrentSourceToCheckpoint, and the prepared-read cache
                // flows through SyncManager -> SourceObservationState ->
                // port.currentObservationToken. The port's registered-token
                // revalidateCurrentSourceObservation cannot substitute for these
                // richer barrier semantics (deep comparison + authority
                // observation + watcher cache) without weakening revalidation.
                revalidateAuthority: async () => !finalBarrierChanged,
            });
            const outcome = await session.read(async (prepared, releaseLease): Promise<SearchToolTextResponse> => {

                    const {
                        absolutePath: absolutePathFromFrontDoor,
                        searchableRoot,
                        effectiveRoot: effectiveRootFromFrontDoor,
                        proofDebugHint,
                        partialIndexSearchWarnings: frontDoorWarnings,
                        freshnessDecision: freshnessDecisionFromFrontDoor,
                        vectorReceipt,
                        generationReceipt,
                        navigationStatus,
                        preparedObservation,
                    } = prepared;
                    absolutePath = absolutePathFromFrontDoor;
                    effectiveRoot = effectiveRootFromFrontDoor;
                    freshnessDecision = freshnessDecisionFromFrontDoor;
                const finalSourceObservation = this.preparedRead.getPreparedReadCacheObservation(effectiveRoot);
                let requestSourceBarrier: RequestSourceBarrier | undefined;
                if (freshnessDecision.mode === 'served_previous_generation') {
                    requestSourceBarrier = {
                        mode: 'publication_consistent_stale_read',
                        collectionName: vectorReceipt?.collectionName ?? '',
                    };
                    readinessDebug.requestProof = {
                        freshnessComparisonMode: 'stale_while_sync',
                        exactPathCount: 0,
                        checkpointBindings: 1,
                        preRetrievalFullComparisons: 0,
                        finalFullComparisons: 0,
                    };
                } else if (
                    finalSourceObservation.observation !== null
                    && finalSourceObservation.sourceObservation !== null
                    && finalSourceObservation.unavailableReason === undefined
                ) {
                    requestSourceBarrier = {
                        mode: 'watcher',
                        observation: finalSourceObservation.observation,
                        sourceObservation: finalSourceObservation.sourceObservation,
                    };
                } else if (
                    finalSourceObservation.observation !== null
                    && finalSourceObservation.unavailableReason !== undefined
                    && WATCHER_UNAVAILABLE_SOURCE_REASONS.has(finalSourceObservation.unavailableReason)
                ) {
                    let freshnessProofBound = false;
                    if (completedFreshnessRequestProof) {
                        const freshnessPort = this.freshness.getSourceFreshnessPort();
                        const checkpoint = await this.measureSearchPhase(
                            phaseTimings,
                            'freshnessCheckpointProof',
                            freshnessPort
                                ? () => freshnessPort.prepareCurrentSourceObservation(
                                    effectiveRoot,
                                    { requestBoundReceipt: vectorReceipt },
                                ).then((prepared) => prepared.evidence)
                                : () => this.freshness.inspectSourceFreshnessCheckpoint(
                                    effectiveRoot,
                                    undefined,
                                    vectorReceipt,
                                ),
                        );
                        freshnessProofBound = checkpoint.status === 'valid'
                            && checkpoint.observationToken
                                === completedFreshnessRequestProof.checkpointObservation
                            && checkpoint.generationReceipt?.collectionName
                                === completedFreshnessRequestProof.collectionName
                            && checkpoint.generationReceipt.marker.runId
                                === completedFreshnessRequestProof.markerRunId
                            && checkpoint.generationReceipt.marker.indexPolicyHash
                                === completedFreshnessRequestProof.indexPolicyHash;
                    }
                    if (freshnessProofBound) {
                        requestSourceBarrier = {
                            mode: 'full_comparison',
                            authorityObservation: finalSourceObservation.observation,
                        };
                        readinessDebug.requestProof = {
                            freshnessComparisonMode:
                                completedFreshnessRequestProof!.comparisonMode,
                            exactPathCount: completedFreshnessRequestProof!.exactPathCount,
                            checkpointBindings: 1,
                            preRetrievalFullComparisons:
                                completedFreshnessRequestProof!.preRetrievalFullComparisons,
                            finalFullComparisons: 0,
                        };
                    } else {
                        const comparisonPort = this.freshness.getSourceFreshnessPort();
                        const comparison = comparisonPort
                            ? await comparisonPort.compareAllCurrentSourceToCheckpoint(
                                effectiveRoot,
                                vectorReceipt,
                            )
                            : await this.freshness.compareAllSourceToFreshnessCheckpoint(
                                effectiveRoot,
                                vectorReceipt,
                            );
                        if (comparison.status === 'matches') {
                            requestSourceBarrier = {
                                mode: 'full_comparison',
                                authorityObservation: finalSourceObservation.observation,
                            };
                            readinessDebug.requestProof = {
                                freshnessComparisonMode: 'full',
                                exactPathCount: 0,
                                checkpointBindings: 0,
                                preRetrievalFullComparisons: 0,
                                finalFullComparisons: 0,
                            };
                        }
                    }
                }
                if (!requestSourceBarrier) {
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
                        "Satori could not verify the active publication against the current source.",
                        "source_state_unverified",
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
                sourceBarrierChanged = async (): Promise<boolean> => {
                    if (requestSourceBarrier.mode === 'publication_consistent_stale_read') {
                        return false;
                    }
                    if (requestSourceBarrier.mode === 'watcher') {
                        const currentBarrier = this.preparedRead.getPreparedReadCacheObservation(effectiveRoot);
                        return currentBarrier.observation !== requestSourceBarrier.observation
                            || currentBarrier.sourceObservation !== requestSourceBarrier.sourceObservation
                            || currentBarrier.unavailableReason !== undefined;
                    }
                    if (
                        this.preparedRead.getPreparedAuthorityObservation(effectiveRoot)
                        !== requestSourceBarrier.authorityObservation
                    ) {
                        return true;
                    }
                    const validationPort = this.freshness.getSourceFreshnessPort();
                    const comparison = await this.measureSearchPhase(
                        phaseTimings,
                        'finalSourceValidation',
                        validationPort
                            ? () => validationPort.compareCurrentSourceToCheckpoint(
                                effectiveRoot,
                                vectorReceipt,
                            )
                            : () => this.freshness.compareSourceObservationToFreshnessCheckpoint(
                                effectiveRoot,
                                vectorReceipt,
                            ),
                    );
                    if (readinessDebug.requestProof) {
                        readinessDebug.requestProof.finalFullComparisons += 1;
                    }
                    return comparison.status !== 'matches';
                };
                if (debugMode === 'full' && finalSourceObservation.unavailableReason) {
                    readinessDebug.observationUnavailableReason = finalSourceObservation.unavailableReason;
                }
                if (debugMode === 'full') {
                    const getPreparedReadDiagnostics = this.readiness.getPreparedReadDiagnostics;
                    if (typeof getPreparedReadDiagnostics === 'function') {
                        readinessDebug.watcher = getPreparedReadDiagnostics.call(
                            this.readiness,
                            effectiveRoot,
                        );
                    }
                }
                const sourceFreshnessWasEstablished = freshnessDecision.mode === 'synced'
                    || freshnessDecision.mode === 'reconciled_ignore_change'
                    || freshnessDecision.mode === 'skipped_source_unchanged'
                    || freshnessDecision.mode === 'served_previous_generation';
                const checkpointWarningAlreadyPresent = frontDoorWarnings.includes(
                    WARNING_CODES.SOURCE_FRESHNESS_CHECKPOINT_UNAVAILABLE,
                );
                const partialIndexSearchWarnings = !sourceFreshnessWasEstablished
                    && !checkpointWarningAlreadyPresent
                    && finalSourceObservation.unavailableReason
                    ? [...frontDoorWarnings, WARNING_CODES.SOURCE_FRESHNESS_UNVERIFIED]
                    : frontDoorWarnings;

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
                const initialObservedChangedFilesState = observedChangedFilesForSearch
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
                const navigationAuthority = navigationStatus === 'valid'
                    && generationReceipt?.navigation
                    && generationReceipt.navigation.navigationSealHash
                    ? 'valid' as const
                    : 'unavailable' as const;
                const preparedReadState: Extract<TrackedRootReadinessState, { state: 'ready' }> = {
                    state: 'ready',
                    root: searchableRoot,
                    navigationAuthorityMode: 'canonical_v4',
                    proofDebugHint,
                    vectorReceipt,
                    generationReceipt,
                    navigationStatus,
                    preparedObservation,
                };
                const attachSearchResultSet = (
                    envelope: SearchGroupedResponseEnvelope,
                    resultSet: FinalizedSearchResultSet | undefined,
                    rerankerApplied: boolean,
                    orderAuthority: SearchOrderAuthority,
                ): SearchGroupedResponseEnvelope => {
                    if (!resultSet) return envelope;
                    if (!vectorReceipt) {
                        throw new Error("Search result-set binding requires a proven vector publication.");
                    }
                    if (!preparedObservation) {
                        throw new Error("Search result-set binding requires a prepared publication and source observation.");
                    }
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
                        vectorReceipt,
                        ...(generationReceipt ? { generationReceipt } : {}),
                        preparedObservation,
                        sourceObservation: finalSourceObservation.sourceObservation,
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
                                vectorReceipt,
                                ...(generationReceipt ? { generationReceipt } : {}),
                                preparedObservation,
                                sourceObservation: finalSourceObservation.sourceObservation,
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
                if (
                    freshnessDecision.mode !== "served_previous_generation"
                    && preparedObservation
                    && this.preparedRead.getPreparedAuthorityObservation(effectiveRoot) !== preparedObservation
                ) {
                    this.preparedRead.evictPreparedRead(effectiveRoot);
                    const payload = this.buildNotReadySearchPayload(effectiveRoot, {
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit,
                    });
                    return {
                        content: [{ type: 'text', text: this.hints.stringifyToolJson(payload) }],
                        meta: { searchDiagnostics },
                    };
                }
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
                    loadRegistryValidatedCallGraphSidecar: (exactInput) => this.readiness.loadRegistryValidatedCallGraphSidecar({
                        ...exactInput,
                        preparedRead: preparedReadState,
                        operations: readinessDebug.operations,
                    }),
                    buildRelationshipBackedCallGraph: (exactInput) => this.hints.buildRelationshipBackedCallGraph({
                        ...exactInput,
                        ...(generationReceipt
                            ? { generationId: generationReceipt.navigation.generationId }
                            : {}),
                    }),
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
                    const barrierChanged = await sourceBarrierChanged();
                    if (barrierChanged) {
                        releaseLease();
                        if (sourceDriftRetryCount === 0) {
                            return this.attempt(args, 1);
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
                        if (vectorReceipt && preparedObservation) {
                            exactEnvelope = attachSearchResultSet(
                                exactEnvelope,
                                exactFastPath.finalized.resultSet,
                                false,
                                "retrieval_order",
                            );
                        } else if (exactFastPath.finalized.resultSet) {
                            const unboundEnvelope = { ...exactEnvelope };
                            delete unboundEnvelope.continuation;
                            delete unboundEnvelope.rankedSetDigest;
                            delete unboundEnvelope.resultIndex;
                            exactEnvelope = {
                                ...unboundEnvelope,
                                warnings: buildSearchWarningDetails([
                                    ...(exactEnvelope.warnings?.map((warning) => warning.code) ?? []),
                                    ...(exactEnvelope.continuation
                                        ? [WARNING_CODES.SEARCH_RESULT_SET_NOT_CACHE_ADMISSIBLE]
                                        : []),
                                    ...(input.includeResultIndex === true
                                        ? [WARNING_CODES.SEARCH_RESULT_INDEX_NOT_ADMISSIBLE]
                                        : []),
                                ]),
                            };
                        }
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

                if (
                    freshnessDecision.mode !== "served_previous_generation"
                    && preparedObservation
                    && this.preparedRead.getPreparedAuthorityObservation(effectiveRoot) !== preparedObservation
                ) {
                    this.preparedRead.evictPreparedRead(effectiveRoot);
                    const payload = this.buildNotReadySearchPayload(effectiveRoot, {
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit,
                    });
                    return {
                        content: [{ type: 'text', text: this.hints.stringifyToolJson(payload) }],
                        meta: { searchDiagnostics },
                    };
                }

                let entrypointOwnerEvidence: EntrypointOwnerEvidenceResolution | undefined;
                const completeEntrypointPublicationBinding = Boolean(
                    generationReceipt
                    && typeof generationReceipt.collectionName === "string"
                    && typeof generationReceipt.marker?.runId === "string"
                    && typeof generationReceipt.policyDocumentDigest === "string"
                    && typeof generationReceipt.policy?.policyHash === "string"
                    && typeof generationReceipt.navigation?.generationId === "string"
                    && typeof generationReceipt.navigation?.symbolRegistryManifestHash === "string",
                );
                if (
                    entrypointOwnerSeeking
                    && completeEntrypointPublicationBinding
                    && generationReceipt
                    && navigationStatus === "valid"
                ) {
                    if (
                        !searchSymbolRegistry
                        || searchSymbolRegistryManifestHash
                            !== generationReceipt.navigation.symbolRegistryManifestHash
                    ) {
                        const registryState = await this.preparedRead.loadPreparedNavigationManifest(
                            preparedReadState,
                            readinessDebug.operations,
                        );
                        if (
                            registryState.status === "ok"
                            && registryState.manifestHash
                                === generationReceipt.navigation.symbolRegistryManifestHash
                        ) {
                            searchSymbolRegistry = registryState.registry;
                            searchSymbolRegistryManifestHash = registryState.manifestHash;
                        }
                    }
                    if (
                        searchSymbolRegistry
                        && searchSymbolRegistryManifestHash
                            === generationReceipt.navigation.symbolRegistryManifestHash
                    ) {
                        const preparedEvidence = await prepareEntrypointOwnerEvidence({
                            codebaseRoot: effectiveRoot,
                            registry: searchSymbolRegistry,
                            publication: {
                                collectionName: generationReceipt.collectionName,
                                markerRunId: generationReceipt.marker.runId,
                                policyDocumentDigest: generationReceipt.policyDocumentDigest,
                                policyHash: generationReceipt.policy.policyHash,
                                navigationGenerationId: generationReceipt.navigation.generationId,
                                symbolRegistryManifestHash:
                                    generationReceipt.navigation.symbolRegistryManifestHash,
                            },
                        });
                        if ("resolution" in preparedEvidence) {
                            preparedEntrypointOwnerEvidence = preparedEvidence;
                            const manifestComparison = await this.freshness.compareSourcePathsToFreshnessCheckpoint(
                                    effectiveRoot,
                                    ["pyproject.toml"],
                                    generationReceipt,
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
                            vectorReceipt
                            && debugMode === 'full'
                            && this.environment.semanticSearchWithCandidateTraceInProvenGeneration
                        ) {
                            return this.environment.semanticSearchWithCandidateTraceInProvenGeneration(
                                vectorReceipt,
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
                        if (freshnessDecision.mode === "served_previous_generation") {
                            if (!vectorReceipt) {
                                throw new Error("Stale-while-sync requires a proven vector generation receipt.");
                            }
                            return this.environment.semanticSearchInProvenGeneration!(vectorReceipt, request);
                        }
                        return vectorReceipt
                            ? this.environment.semanticSearchInProvenGeneration!(vectorReceipt, request)
                            : this.environment.semanticSearch(request);
                    },
                    reranker: this.reranker,
                    ...(rerankerDocumentProjectionIdentity === SEARCH_RERANK_DOCUMENT_POLICY.id
                        ? {
                            buildRerankDocument: async (
                                rerankQuery: string,
                                result: SearchResultLike,
                            ): Promise<SearchRerankProjectionResult> => {
                                const candidateId = searchRerankCandidateId(result);
                                if (!generationReceipt) {
                                    return {
                                        ok: false,
                                        candidateId,
                                        reason: "generation_receipt_missing",
                                    };
                                }
                                if (navigationStatus !== "valid") {
                                    return {
                                        ok: false,
                                        candidateId,
                                        reason: "navigation_status_invalid",
                                    };
                                }
                                if (
                                    !searchSymbolRegistry
                                    || searchSymbolRegistryManifestHash
                                        !== generationReceipt.navigation.symbolRegistryManifestHash
                                ) {
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
                                    if (
                                        registryState.manifestHash
                                            !== generationReceipt.navigation.symbolRegistryManifestHash
                                    ) {
                                        return {
                                            ok: false,
                                            candidateId,
                                            reason: "registry_manifest_mismatch",
                                        };
                                    }
                                    searchSymbolRegistry = registryState.registry;
                                    searchSymbolRegistryManifestHash = registryState.manifestHash;
                                }
                                const structuralContext = wantsStructuralContext
                                    ? await (structuralContextLoad ??= (async () => {
                                        const compatibility = await this.preparedRead.loadPreparedNavigationCompatibility(
                                            preparedReadState,
                                            searchSymbolRegistryManifestHash
                                                ?? generationReceipt.navigation.symbolRegistryManifestHash,
                                            readinessDebug.operations,
                                        );
                                        const status = resolveSearchRerankStructuralContextStatus({
                                            relationshipStatus: compatibility.relationships.status,
                                            ...(compatibility.relationships.status === "ok"
                                                ? { relationshipManifestHash: compatibility.relationships.manifestHash }
                                                : {}),
                                            expectedRelationshipManifestHash:
                                                generationReceipt.navigation.relationshipManifestHash,
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
                    loadRegistryValidatedCallGraphSidecar: (finalizationInput) => this.readiness.loadRegistryValidatedCallGraphSidecar({
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
                            barrierChanged = await sourceBarrierChanged();
                            if (!barrierChanged) {
                                const manifestComparison = await this.freshness.compareSourcePathsToFreshnessCheckpoint(
                                        effectiveRoot,
                                        ["pyproject.toml"],
                                        generationReceipt,
                                    );
                                barrierChanged = manifestComparison.status !== "matches";
                            }
                        },
                    });
                    if (finalizedEntrypointEvidence.status !== "available") {
                        barrierChanged = true;
                    }
                } else {
                    barrierChanged = await sourceBarrierChanged();
                }
                finalBarrierChanged = barrierChanged;
                if (barrierChanged) {
                    await preparedEntrypointOwnerEvidence?.release();
                    preparedEntrypointOwnerEvidence = undefined;
                    releaseLease();
                    if (sourceDriftRetryCount === 0) {
                        return this.attempt(args, 1);
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
            if (outcome.status === 'stale') {
                if (sourceDriftRetryCount === 0) {
                    return this.attempt(args, 1);
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
                        vectorReceipt: entry.vectorReceipt,
                        ...(entry.generationReceipt
                            ? { generationReceipt: entry.generationReceipt }
                            : {}),
                        preparedObservation: entry.preparedObservation,
                        sourceObservation: entry.sourceObservation,
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
        const observationBefore = this.preparedRead.getPreparedReadCacheObservation(entry.canonicalRoot);
        const revalidate = this.freshness.getPreparedGenerationRevalidator();
        if (
            !observationBefore.observation
            || observationBefore.observation !== entry.preparedObservation
            || observationBefore.sourceObservation !== entry.sourceObservation
            || typeof revalidate !== "function"
        ) {
            this.continuationCoordinator.remove(handle);
            return fail("SEARCH_RESULT_SET_STALE", "Search publication or source observation changed. Run search_codebase again.");
        }
        const proof = await revalidate(entry.canonicalRoot, entry.vectorReceipt, {
            ...(entry.generationReceipt ? { priorGenerationReceipt: entry.generationReceipt } : {}),
        }).catch(() => null);
        const observationAfter = this.preparedRead.getPreparedReadCacheObservation(entry.canonicalRoot);
        if (
            !proof
            || proof.navigationProof.status === "requires_reindex"
            || proof.navigationProof.status === "unsupported"
            || observationAfter.observation !== observationBefore.observation
            || observationAfter.sourceObservation !== observationBefore.sourceObservation
        ) {
            this.continuationCoordinator.remove(handle);
            return fail("SEARCH_RESULT_SET_STALE", "Search publication changed while continuation was being prepared. Run search_codebase again.");
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
        const proofAfterProjection = await revalidate(
            entry.canonicalRoot,
            entry.vectorReceipt,
            {
                ...(entry.generationReceipt
                    ? { priorGenerationReceipt: entry.generationReceipt }
                    : {}),
            },
        ).catch(() => null);
        const observationAfterProjection = this.preparedRead.getPreparedReadCacheObservation(entry.canonicalRoot);
        if (
            !proofAfterProjection
            || proofAfterProjection.navigationProof.status === "requires_reindex"
            || proofAfterProjection.navigationProof.status === "unsupported"
            || observationAfterProjection.observation !== observationAfter.observation
            || observationAfterProjection.sourceObservation !== observationAfter.sourceObservation
        ) {
            this.continuationCoordinator.remove(handle);
            return fail(
                "SEARCH_RESULT_SET_STALE",
                "Search publication or source observation changed while the continuation page was being projected. Run search_codebase again.",
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
