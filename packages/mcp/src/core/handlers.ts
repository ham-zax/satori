import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import ignore from "ignore";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    type IndexCompletionMarkerDocument,
    type ProvenGenerationReceipt,
    type ProvenVectorGenerationReceipt,
    type PreparedGenerationRevalidation,
    createRuntimeNavigationStore,
    type NavigationStore,
    VoyageAIReranker,
    getSupportedExtensionsForCapability,
    isLanguageCapabilitySupportedForExtension,
    isLanguageCapabilitySupportedForFilename,
    isLanguageCapabilitySupportedForLanguage,
    beginSourceMeasurementObservation,
    finishSourceMeasurementObservation,
    recordSourceIo,
    recordSourceProcessing,
    sourceIoOwnerForCurrentOperation,
} from "@zokizuan/satori-core";
import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { CapabilityResolver } from "./capabilities.js";
import { AccessGateReason, SnapshotManager } from "./snapshot.js";
import { absolutePathOrRaw } from "../utils.js";
import {
    SyncManager,
    type FreshnessDecision,
    type PreparedReadObservationUnavailableReason,
} from "./sync.js";
import {
    DEFAULT_MANAGE_RETRY_AFTER_MS,
    DEFAULT_WATCH_DEBOUNCE_MS,
    IndexFingerprint,
    indexFingerprintsEqual,
    SEARCH_FRESHNESS_THRESHOLD_MS,
    summarizeIndexFingerprint,
    type CodebaseInfo,
} from "../config.js";
import {
    SEARCH_CHANGED_FILES_CACHE_TTL_MS,
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N,
    SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES,
    SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES,
    PathCategory,
    SearchGroupBy,
    SearchRankingMode,
    SearchResultMode,
    SearchScope
} from "./search-constants.js";
import {
    CallGraphHint,
    CallGraphResponseEnvelope,
    CallGraphResponseReason,
    CallGraphResponseStatus,
    FingerprintCompatibilityDiagnostics,
    FileOutlineInput,
    FileOutlineResponseEnvelope,
    FileOutlineStatus,
    NonOkReason,
    SearchDebugHint,
    SearchGroupResult,
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
    CallGraphSidecarManager,
    CallGraphSymbolRef,
    CallGraphTestReference,
} from "./call-graph.js";
import { decideInterruptedIndexingRecovery } from "./indexing-recovery.js";
import {
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import {
    resolveSearchOwnerFromRegistry as resolveSearchOwnerFromRegistryWithRepair,
} from "./search-owner-resolution.js";
import {
    buildRegistrySymbolCallGraphHint as buildSearchRegistrySymbolCallGraphHint,
} from "./search-navigation.js";
import {
    buildChangedCodeDebug as buildSearchChangedCodeDebug,
    buildGeneratedArtifactsVerificationHint as buildSearchGeneratedArtifactsVerificationHint,
} from "./search-debug-helpers.js";
import {
    sortGroupedSearchResults as sortGroupedSearchResultsHelper,
} from "./search-group-ordering.js";
import {
    compareNullableNumbersAsc as compareNullableNumbersAscHelper,
    compareNullableStringsAsc as compareNullableStringsAscHelper,
} from "./search-grouping.js";
import {
    buildOutlineSpanWarningCodes as buildSearchOutlineSpanWarningCodes,
    normalizeSearchSymbolLabel as normalizeSearchSymbolLabelHelper,
    SEARCH_GROUP_PREVIEW_MAX_BYTES,
} from "./search-response-helpers.js";
import { runSearchFrontDoor } from "./search-frontdoor.js";
import {
    classifyPathCategory,
    hasPathSegment as hasSearchPathSegment,
    isDocPath as isSearchDocPath,
    isFixturePath as isSearchFixturePath,
    isGeneratedPath as isSearchGeneratedPath,
    isTestPath as isSearchTestPath,
    isWriterActionTerm as isWriterActionTermHelper,
    normalizeSearchPath as normalizeSearchPathHelper,
    shouldIncludeCategoryInScope,
} from "./search-ranking-policy.js";
import { SearchQuerySupport } from "./search-query-support.js";
import {
    TrackedRootReadiness,
    type ReadinessPhase,
    type TrackedRootReadinessState,
} from "./tracked-root-readiness.js";
import { NavigationHandlers } from "./navigation-handlers.js";
import {
    composeSymbolContext as composePreparedSymbolContext,
    type ComposeSymbolContextInput,
    type ComposeSymbolContextResult,
    type PreparedRelationshipSnapshot,
    type PrepareSymbolContextSnapshotResult,
} from "./symbol-context-composer.js";
import { prepareRelationshipTraversals } from "./prepared-relationship-traversal.js";
import { findExactRegistrySymbols } from "./registry-file-outline.js";
import { ManageMaintenanceHandlers } from "./manage-maintenance-handlers.js";
import { ManageIndexingHandlers } from "./manage-indexing-handlers.js";
import { VectorBackendMaintenance } from "./vector-backend-maintenance.js";
import { RelationshipBackedCallGraph } from "./relationship-backed-call-graph.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";
import { PreparedReadCache } from "./prepared-read-cache.js";
import { WARNING_CODES } from "./warnings.js";
import {
    evaluateReindexPreflight as evaluateReindexPreflightHelper,
    getChangedFilesForCodebase as getChangedFilesForCodebaseHelper,
    getWorkingTreeChangedPathsForPreflight as getWorkingTreeChangedPathsForPreflightHelper,
    parseGitStatusChangedPaths as parseGitStatusChangedPathsHelper,
    type ChangedFilesCacheEntry,
    type ReindexPreflightResult,
} from "./working-tree-state.js";
import type {
    CompletionProofReason,
    CompletionProofValidationResult
} from "./completion-proof.js";
import {
    getCompletionMarkerReader,
    validateCompletionProof as validateIndexCompletionProof
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
import { runExactRegistryFastPath } from "./search-exact-fast-path.js";
import { finalizeSearchResults } from "./search-result-finalization.js";
import {
    SearchResultSetCoordinator,
    type SearchResultSetCoordinatorLookup,
} from "./search-result-set-cache.js";
import { projectGroupedDisclosure } from "./search-disclosure.js";
import type {
    SearchQueryPlan,
    SearchResultLike,
} from "./search-lexical-scoring.js";
import {
    formatRuntimeOwnerConflictMessage,
    formatRuntimeOwnerConflictNextStep,
    type RuntimeOwnerMutationAction,
    type RuntimeOwnerMutationGate,
    type RuntimeOwnerMutationGateResult,
} from "./runtime-owner.js";
import { MutationLeaseCoordinator, type RootMutationLease } from "./mutation-lease.js";

const SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING = 'SEARCH_PARTIAL_INDEX:limit_reached';
const SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING = 'SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE';
const SEARCH_DEBUG_CHANGED_CODE_MAX_FILES = 10;
const SEARCH_DEBUG_CHANGED_CODE_MAX_SYMBOLS = 20;
const SEARCH_DEBUG_CHANGED_CODE_MAX_DIRECT_CALLERS = 20;
const PREPARED_NAVIGATION_CACHE_MAX_ROOTS = 32;
const PREPARED_NAVIGATION_CACHE_MAX_FILES_PER_ROOT = 64;
const PREPARED_NAVIGATION_CACHE_MAX_COMPATIBILITY_RESULTS_PER_ROOT = 8;
type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>['reason'];
// Recovery probe threshold for "likely interrupted" indexing states.
// Keep this shorter than snapshot merge stale semantics for better operator UX.
const STALE_INDEXING_RECOVERY_GRACE_MS = 2 * 60_000;

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
    | 'navigationValidation';

export type FrozenSearchResultSet = {
    canonicalRoot: string;
    vectorReceipt: ProvenVectorGenerationReceipt;
    generationReceipt?: ProvenGenerationReceipt;
    preparedObservation: string;
    sourceObservation: string | null;
    queryPolicyDigest: string;
    responseByteLimit: number;
    pageSize: number;
    baseEnvelope: Omit<
        SearchGroupedResponseEnvelope,
        "results" | "disclosure" | "continuation" | "recommendedNextAction"
    >;
    orderedResults: SearchGroupedResultV2[];
    recommendedActions: Array<SearchRecommendedNextAction | null>;
};

export class SearchContinuationCoordinator extends SearchResultSetCoordinator<
    FrozenSearchResultSet,
    ToolHandlers
> {}

type SearchContinuationLookup = SearchResultSetCoordinatorLookup<
    FrozenSearchResultSet,
    ToolHandlers
>;

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

type SearchPhaseTimings = Record<SearchPhaseTimingKey, number>;

type SearchOwnerSource = 'owner_metadata' | 'registry_repair' | 'fallback';

type SearchOwnerResolution = {
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    symbolKind?: string;
    ownerSource?: Extract<SearchOwnerSource, 'owner_metadata' | 'registry_repair'>;
};

type CodebaseStatus = CodebaseInfo['status'];
type TrackedCodebaseInfo = Record<string, unknown> & {
    status: CodebaseStatus;
    lastUpdated?: string;
    indexStatus?: unknown;
    indexedFiles?: unknown;
    totalChunks?: unknown;
    added?: unknown;
    removed?: unknown;
    modified?: unknown;
    errorMessage?: unknown;
    lastAttemptedPercentage?: unknown;
    indexFingerprint?: IndexFingerprint;
    fingerprintSource?: CodebaseInfo['fingerprintSource'];
    reindexReason?: CodebaseInfo['reindexReason'];
    collectionName?: unknown;
    message?: unknown;
};
type TrackedRootEntry = {
    path: string;
    info: TrackedCodebaseInfo;
};

type IndexCompletionMarkerContext = {
    getIndexCompletionMarker?: (codebasePath: string) => Promise<IndexCompletionMarkerDocument | null>;
    getIndexCompletionMarkerForValidation?: (codebasePath: string) => Promise<unknown>;
    getActiveIndexedCollectionName?: (codebasePath: string) => Promise<string | null>;
    getCompletionProofCollectionName?: (codebasePath: string) => Promise<string | null>;
    clearIndexCompletionMarker?: (codebasePath: string, assertMutationCurrent?: () => void) => Promise<void>;
    pruneIndexedCollectionFamily?: (codebasePath: string, keepCollectionName: string, options?: { assertMutationCurrent?: () => void }) => Promise<string[]>;
    pruneUnprovenStagedCollectionFamily?: (codebasePath: string, options?: {
        assertMutationCurrent?: () => void;
        discardUnprovenPayload?: boolean;
    }) => Promise<string[]>;
};

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type IndexCodebaseArgs = {
    path: string;
    force?: boolean;
    customExtensions?: unknown;
    ignorePatterns?: unknown;
    zillizDropCollection?: unknown;
    __reindexPreflight?: ReindexPreflightResult;
};

type ReindexCodebaseArgs = {
    path: string;
    customExtensions?: unknown;
    ignorePatterns?: unknown;
    zillizDropCollection?: unknown;
    allowUnnecessaryReindex?: boolean;
};

type ToolArgs = Record<string, unknown>;

type IndexProfileView = {
    profile: string;
    configPath?: string;
};

type ContextLifecycleCapabilities = IndexCompletionMarkerContext & {
    getIndexAuthorityObservations?: (codebasePath: string) => {
        vector: string;
        navigation: string;
    } | null;
    resolveCollectionName?: (codebasePath: string) => string;
    resolveStagedCollectionName?: (codebasePath: string, generationId: string) => string;
    setWriteCollectionOverride?: (codebasePath: string, collectionName: string | null) => void;
    loadIndexProfileForCodebase?: (codebasePath: string) => IndexProfileView;
    getActiveIgnorePatterns?: (codebasePath?: string) => string[];
    getIndexedExtensionsForCodebase?: (codebasePath: string) => string[];
    getIndexedExtensions?: () => string[];
    getTrackedRelativePaths?: (codebasePath: string) => string[];
    isPreparedVectorReceiptBoundToCurrentAuthority?: (
        codebasePath: string,
        receipt: ProvenVectorGenerationReceipt,
    ) => boolean;
    revalidatePreparedGeneration?: (
        codebasePath: string,
        receipt: ProvenVectorGenerationReceipt,
        options?: {
            priorGenerationReceipt?: import('@zokizuan/satori-core').ProvenGenerationReceipt;
            navigationObservationChanged?: boolean;
        },
    ) => Promise<PreparedGenerationRevalidation | null>;
    semanticSearchInProvenGeneration?: (
        receipt: ProvenVectorGenerationReceipt,
        request: import('@zokizuan/satori-core').SemanticSearchRequest,
    ) => Promise<import('@zokizuan/satori-core').SemanticSearchResult[]>;
    semanticSearchWithCandidateTraceInProvenGeneration?: (
        receipt: ProvenVectorGenerationReceipt,
        request: import('@zokizuan/satori-core').SemanticSearchRequest,
        maxEntriesPerStage: number,
        options?: import('@zokizuan/satori-core').SemanticSearchCandidateTraceOptions,
    ) => Promise<import('@zokizuan/satori-core').SemanticSearchExecutionResult>;
};

type PreparedReadObservationSnapshot = {
    vectorAuthority: string;
    navigationAuthority: string;
    mutationGeneration: number;
};

type PreparedReadCacheObservationResult = {
    observation: string | null;
    sourceObservation: string | null;
    unavailableReason?: PreparedReadObservationUnavailableReason;
};

type StatusPreparedReadObservation = {
    observation: string;
    sourceObservation: string | null;
    unavailableReason: PreparedReadObservationUnavailableReason | null;
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
type NavigationManifestOk = Extract<NavigationManifestState, { status: 'ok' }>;
type NavigationSymbolsByFileState = Awaited<ReturnType<NavigationStore['getSymbolsByFile']>>;
type NavigationSymbolsByFileOk = Extract<NavigationSymbolsByFileState, { status: 'ok' }>;
type NavigationCompatibilityState = Awaited<ReturnType<NavigationStore['getCompatibilityState']>>;

type PreparedNavigationCacheEntry = {
    identity: string;
    manifest?: NavigationManifestOk;
    symbolsByFile: Map<string, NavigationSymbolsByFileOk>;
    compatibilityByManifestHash: Map<string, NavigationCompatibilityState>;
};

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

function parsePreparedReadObservation(value: string): PreparedReadObservationSnapshot | null {
    try {
        const parsed = JSON.parse(value) as Partial<PreparedReadObservationSnapshot>;
        return typeof parsed.vectorAuthority === 'string'
            && typeof parsed.navigationAuthority === 'string'
            && typeof parsed.mutationGeneration === 'number'
            ? parsed as PreparedReadObservationSnapshot
            : null;
    } catch {
        return null;
    }
}

type SnapshotAccessGateResult = {
    allowed: boolean;
    changed: boolean;
    reason?: AccessGateReason;
    message?: string;
};

type SnapshotManagerCapabilities = {
    getCodebaseInfo?: (codebasePath: string) => CodebaseInfo | undefined;
    getCodebaseStatus?: (codebasePath: string) => CodebaseStatus | 'not_found';
    getAllCodebases?: () => Array<{ path: string; info: CodebaseInfo }>;
    getIndexedCodebases?: () => string[];
    getIndexingCodebases?: () => string[];
    getIndexingProgress?: (codebasePath: string) => number | undefined;
    ensureFingerprintCompatibilityOnAccess?: (
        codebasePath: string,
        options?: { mutate?: boolean },
    ) => SnapshotAccessGateResult;
    getCodebaseCollectionName?: (codebasePath: string) => string | undefined;
    markCodebaseCleared?: (codebasePath: string, collectionName?: string) => void;
    saveCodebaseSnapshot?: () => boolean | void;
};

type GitignoreMatcherCacheState = "ready" | "absent" | "error";

type GitignoreMatcherCacheEntry = {
    state: GitignoreMatcherCacheState;
    mtimeMs: number | null;
    size: number | null;
    matcher: ReturnType<typeof ignore> | null;
    checksSinceReload: number;
};

type CompletionProbeDebugHint = {
    ok: false;
    reason: "probe_failed";
    message: string;
    action: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectErrorFragments(
    value: unknown,
    output: string[],
    visited: Set<unknown>,
    depth: number = 0
): void {
    if (value === null || value === undefined || depth > 4 || output.length >= 8) {
        return;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            output.push(trimmed);
        }
        return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        output.push(String(value));
        return;
    }

    if (value instanceof Error) {
        collectErrorFragments(value.message, output, visited, depth + 1);
        collectErrorFragments((value as Error & { cause?: unknown }).cause, output, visited, depth + 1);
        return;
    }

    if (typeof value !== "object") {
        return;
    }

    if (visited.has(value)) {
        return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectErrorFragments(item, output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
        return;
    }

    const record = value as Record<string, unknown>;
    const priorityKeys = ["message", "reason", "detail", "details", "error", "msg", "code", "error_code"];
    for (const key of priorityKeys) {
        if (key in record) {
            collectErrorFragments(record[key], output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
    }

    for (const nestedValue of Object.values(record)) {
        collectErrorFragments(nestedValue, output, visited, depth + 1);
        if (output.length >= 8) {
            return;
        }
    }
}

function formatUnknownError(error: unknown): string {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return COLLECTION_LIMIT_MESSAGE;
    }

    const fragments: string[] = [];
    collectErrorFragments(error, fragments, new Set());
    const deduped = Array.from(new Set(fragments.map((fragment) => fragment.trim()).filter(Boolean)));
    if (deduped.length > 0) {
        return deduped.slice(0, 3).join(" | ");
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private readonly capabilities: CapabilityResolver;
    private runtimeFingerprint: IndexFingerprint;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    private readonly now: () => number;
    private readonly callGraphManager: CallGraphSidecarManager;
    private readonly reranker: VoyageAIReranker | null;
    private readonly navigationStore: NavigationStore;
    private readonly changedFilesCache = new Map<string, ChangedFilesCacheEntry>();
    private readonly rootGitignoreMatcherCache = new Map<string, GitignoreMatcherCacheEntry>();
    private readonly preparedReadCache = new PreparedReadCache<Extract<TrackedRootReadinessState, { state: 'ready' }>>();
    private readonly statusPreparedReadObservations = new Map<string, StatusPreparedReadObservation>();
    private readonly preparedNavigationCache = new Map<string, PreparedNavigationCacheEntry>();
    private readonly searchContinuationCoordinator: SearchContinuationCoordinator;
    private readonly gitignoreForceReloadEveryN: number;
    private readonly searchQuerySupport: SearchQuerySupport;
    private readonly trackedRootReadiness: TrackedRootReadiness;
    private readonly navigationHandlers: NavigationHandlers;
    private readonly manageMaintenanceHandlers: ManageMaintenanceHandlers;
    private readonly manageIndexingHandlers: ManageIndexingHandlers;
    private readonly vectorBackendMaintenance: VectorBackendMaintenance;
    private readonly relationshipBackedCallGraph: RelationshipBackedCallGraph;
    private readonly toolResponseBuilders: ToolResponseBuilders;

    constructor(
        context: Context,
        snapshotManager: SnapshotManager,
        syncManager: SyncManager,
        runtimeFingerprint: IndexFingerprint,
        capabilities: CapabilityResolver,
        now: () => number = () => Date.now(),
        callGraphManager?: CallGraphSidecarManager,
        reranker?: VoyageAIReranker | null,
        gitignoreForceReloadEveryN: number = SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N,
        navigationStore: NavigationStore = createRuntimeNavigationStore(),
        private readonly runtimeOwnerGate: RuntimeOwnerMutationGate | null = null,
        private readonly mutationLeaseCoordinator: MutationLeaseCoordinator | null = null,
        searchContinuationCoordinator?: SearchContinuationCoordinator,
    ) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.syncManager = syncManager;
        this.capabilities = capabilities;
        this.runtimeFingerprint = runtimeFingerprint;
        this.currentWorkspace = process.cwd();
        this.now = now;
        this.callGraphManager = callGraphManager || new CallGraphSidecarManager(runtimeFingerprint, { now });
        this.reranker = reranker || null;
        this.searchContinuationCoordinator = searchContinuationCoordinator
            ?? new SearchContinuationCoordinator();
        this.searchContinuationCoordinator.registerOwner(this);
        this.gitignoreForceReloadEveryN = Math.max(1, Math.trunc(gitignoreForceReloadEveryN));
        this.navigationStore = navigationStore;
        const searchQuerySupportHost: ConstructorParameters<typeof SearchQuerySupport>[0] = {
            normalizeSearchPath: this.normalizeSearchPath.bind(this),
            hasPathSegment: this.hasPathSegment.bind(this),
            isGeneratedPath: this.isGeneratedPath.bind(this),
            isTestPath: this.isTestPath.bind(this),
            isFixturePath: this.isFixturePath.bind(this),
            isDocPath: this.isDocPath.bind(this),
            getContextActiveIgnorePatterns: this.getContextActiveIgnorePatterns.bind(this),
            getContextTrackedRelativePaths: this.getContextTrackedRelativePaths.bind(this),
            classifyPathCategory: this.classifyPathCategory.bind(this),
            shouldIncludeCategoryInScope: this.shouldIncludeCategoryInScope.bind(this),
            getSyncWatchDebounceMs: this.getSyncWatchDebounceMs.bind(this),
            capabilities: this.capabilities,
            runtimeFingerprint: this.runtimeFingerprint,
            reranker: this.reranker,
            rootGitignoreMatcherCache: this.rootGitignoreMatcherCache,
            gitignoreForceReloadEveryN: this.gitignoreForceReloadEveryN,
        };
        this.searchQuerySupport = new SearchQuerySupport(searchQuerySupportHost);

        const toolResponseBuildersHost: ConstructorParameters<typeof ToolResponseBuilders>[0] = {
            buildManageIndexRecommendedAction: this.buildManageIndexRecommendedAction.bind(this),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildReindexHint: this.buildReindexHint.bind(this),
            buildRepairHint: this.buildRepairHint.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            buildStaleLocalHint: this.buildStaleLocalHint.bind(this),
            buildStaleLocalMessage: this.buildStaleLocalMessage.bind(this),
            buildIndexingMetadata: this.buildIndexingMetadata.bind(this),
            buildCompatibilityDiagnostics: this.buildCompatibilityDiagnostics.bind(this),
            buildRuntimeMismatchHint: this.buildRuntimeMismatchHint.bind(this),
            isRuntimeFingerprintMismatch: this.isRuntimeFingerprintMismatch.bind(this),
            summarizeFingerprint: this.summarizeFingerprint.bind(this),
        };
        this.toolResponseBuilders = new ToolResponseBuilders(toolResponseBuildersHost);

        const getSnapshotAllCodebaseInfoEntries = (): Array<{ path: string; info: CodebaseInfo }> => this.getSnapshotAllCodebases()
            .map((entry) => ({ path: entry.path, info: entry.info as unknown as CodebaseInfo }));
        const getSnapshotAllCodebasePaths = (): string[] => this.getSnapshotAllCodebases()
            .map((entry) => entry.path);
        const buildRequiresReindexFileOutlinePayloadForNavigation = (
            codebasePath: string,
            args: Record<string, unknown>,
            detail?: string,
            reason?: string,
        ): object => this.buildRequiresReindexFileOutlinePayload(
            codebasePath,
            args as unknown as FileOutlineInput,
            detail,
            reason as NonOkReason | undefined,
        );
        const buildStaleSymbolRefFileOutlinePayloadForNavigation = (
            codebasePath: string,
            args: Record<string, unknown>,
            detail?: string,
        ): FileOutlineResponseEnvelope => this.buildStaleSymbolRefFileOutlinePayload(
            codebasePath,
            args as unknown as FileOutlineInput,
            detail,
        );

        const trackedRootReadinessHost: ConstructorParameters<typeof TrackedRootReadiness>[0] = {
            refreshSnapshotStateFromDisk: this.refreshSnapshotStateFromDisk.bind(this),
            isPathWithinCodebase: this.isPathWithinCodebase.bind(this),
            getTrackedRootEntryForPath: this.getTrackedRootEntryForPath.bind(this),
            getMatchingBlockedRoot: this.getMatchingBlockedRoot.bind(this),
            getSnapshotAllCodebases: getSnapshotAllCodebaseInfoEntries,
            getSnapshotIndexedCodebases: this.getSnapshotIndexedCodebases.bind(this),
            getSnapshotIndexingCodebases: this.getSnapshotIndexingCodebases.bind(this),
            getSnapshotCodebaseInfo: this.getSnapshotCodebaseInfo.bind(this),
            getSnapshotCodebaseStatus: this.getSnapshotCodebaseStatus.bind(this),
            enforceFingerprintGate: this.enforceFingerprintGate.bind(this),
            validateCompletionProof: (codebasePath: string) => this.validateCompletionProof(codebasePath),
            probeLocalSearchCollectionState: (codebasePath: string) => this.probeLocalSearchCollectionState(codebasePath),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            buildManageIndexRecommendedAction: this.buildManageIndexRecommendedAction.bind(this),
            buildStaleLocalMessage: this.buildStaleLocalMessage.bind(this),
        };
        this.trackedRootReadiness = new TrackedRootReadiness(trackedRootReadinessHost);

        const vectorBackendMaintenanceHost: ConstructorParameters<typeof VectorBackendMaintenance>[0] = {
            context: this.context,
            snapshotManager: this.snapshotManager,
            getSnapshotAllCodebases: this.getSnapshotAllCodebases.bind(this),
            canonicalizeCodebasePath: this.canonicalizeCodebasePath.bind(this),
            resolveCollectionName: this.resolveCollectionName.bind(this),
            markCodebaseCleared: this.markCodebaseCleared.bind(this),
            saveSnapshotIfSupported: this.saveSnapshotIfSupported.bind(this),
            unwatchCodebase: this.unwatchCodebase.bind(this),
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
        };
        this.vectorBackendMaintenance = new VectorBackendMaintenance(vectorBackendMaintenanceHost);

        const relationshipBackedCallGraphHost: ConstructorParameters<typeof RelationshipBackedCallGraph>[0] = {
            navigationStore: this.navigationStore,
            callGraphManager: this.callGraphManager,
            snapshotManager: this.snapshotManager,
            saveSnapshotIfSupported: this.saveSnapshotIfSupported.bind(this),
            getContextActiveIgnorePatterns: this.getContextActiveIgnorePatterns.bind(this),
        };
        this.relationshipBackedCallGraph = new RelationshipBackedCallGraph(relationshipBackedCallGraphHost);

        const navigationHandlersHost: ConstructorParameters<typeof NavigationHandlers>[0] = {
            trackedRootReadiness: this.trackedRootReadiness,
            prepareNavigationRead: this.prepareNavigationRead.bind(this),
            loadPreparedNavigationSymbolsByFile: this.loadPreparedNavigationSymbolsByFile.bind(this),
            loadPreparedNavigationCompatibility: this.loadPreparedNavigationCompatibility.bind(this),
            stringifyToolJson: this.stringifyToolJson.bind(this),
            normalizeRelativeFilePath: this.normalizeRelativeFilePath.bind(this),
            buildInvalidFileOutlineRequestPayload: this.buildInvalidFileOutlineRequestPayload.bind(this),
            buildRequiresReindexFileOutlinePayload: buildRequiresReindexFileOutlinePayloadForNavigation,
            buildNotIndexedFileOutlinePayload: this.buildNotIndexedFileOutlinePayload.bind(this),
            buildNotReadyFileOutlinePayload: this.buildNotReadyFileOutlinePayload.bind(this),
            withProofDebugHint: this.withProofDebugHint.bind(this),
            isPartialIndexNavigationUnavailable: this.isPartialIndexNavigationUnavailable.bind(this),
            getRegistryFileFreshness: this.getRegistryFileFreshness.bind(this),
            buildStaleSymbolRefFileOutlinePayload: buildStaleSymbolRefFileOutlinePayloadForNavigation,
            loadRegistryValidatedCallGraphSidecar: this.loadRegistryValidatedCallGraphSidecar.bind(this),
            buildRegistrySymbolCallGraphHint: this.buildRegistrySymbolCallGraphHint.bind(this),
            buildOutlineSpanWarningCodes: this.buildOutlineSpanWarningCodes.bind(this),
            touchWatchedCodebase: this.touchWatchedCodebase.bind(this),
            getOutlineStatusForLanguage: this.getOutlineStatusForLanguage.bind(this),
            buildInvalidCallGraphRequestPayload: this.buildInvalidCallGraphRequestPayload.bind(this),
            buildRequiresReindexCallGraphPayload: this.buildRequiresReindexCallGraphPayload.bind(this),
            buildNotReadyCallGraphPayload: this.buildNotReadyCallGraphPayload.bind(this),
            buildNotIndexedCallGraphPayload: this.buildNotIndexedCallGraphPayload.bind(this),
            isCallGraphLanguageSupported: this.isCallGraphLanguageSupported.bind(this),
            isSha256HexHash: this.isSha256HexHash.bind(this),
            buildStaleSymbolRefCallGraphPayload: this.buildStaleSymbolRefCallGraphPayload.bind(this),
            buildRelationshipBackedCallGraph: (input) => this.buildRelationshipBackedCallGraph(input as {
                codebaseRoot: string;
                registry: SymbolRegistry;
                registryManifestHash: string;
                resolvedSymbol: SymbolRecord;
                sourceSpanRepair?: PythonSourceBackedSpanRepair;
                direction: CallGraphDirection;
                depth: number;
                limit: number;
            }),
        };
        this.navigationHandlers = new NavigationHandlers(navigationHandlersHost);

        const manageMaintenanceHandlersHost: ConstructorParameters<typeof ManageMaintenanceHandlers>[0] = {
            context: this.context,
            snapshotManager: this.snapshotManager,
            syncManager: this.syncManager,
            trackedRootReadiness: this.trackedRootReadiness,
            prepareStatusTrackedRootRead: this.prepareStatusTrackedRootRead.bind(this),
            getSnapshotAllCodebases: getSnapshotAllCodebasePaths,
            getSnapshotIndexedCodebases: this.getSnapshotIndexedCodebases.bind(this),
            getSnapshotIndexingCodebases: this.getSnapshotIndexingCodebases.bind(this),
            getSnapshotCodebaseStatus: this.getSnapshotCodebaseStatus.bind(this),
            getSnapshotCodebaseInfo: this.getSnapshotCodebaseInfo.bind(this),
            getSnapshotCorruptionWarning: typeof this.snapshotManager.getSnapshotCorruptionWarning === "function"
                ? this.snapshotManager.getSnapshotCorruptionWarning.bind(this.snapshotManager)
                : () => undefined,
            buildRuntimeOwnerConflictResponseIfBlocked: this.buildRuntimeOwnerConflictResponseIfBlocked.bind(this),
            recoverStaleIndexingStateIfNeeded: this.recoverStaleIndexingStateIfNeeded.bind(this),
            manageResponse: this.toolResponseBuilders.manageResponse.bind(this.toolResponseBuilders),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildRepairHint: this.buildRepairHint.bind(this),
            buildManageActionBlockedMessage: this.buildManageActionBlockedMessage.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            getManageRetryAfterMs: this.getManageRetryAfterMs.bind(this),
            buildIndexingMetadata: this.buildIndexingMetadata.bind(this),
            markCodebaseCleared: this.markCodebaseCleared.bind(this),
            resolveCollectionName: this.resolveCollectionName.bind(this),
            clearIndexingStats: this.clearIndexingStats.bind(this),
            saveSnapshotIfSupported: this.saveSnapshotIfSupported.bind(this),
            unwatchCodebase: this.unwatchCodebase.bind(this),
            refreshSnapshotStateFromDisk: this.refreshSnapshotStateFromDisk.bind(this),
            buildReindexInstruction: this.buildReindexInstruction.bind(this),
            buildCompatibilityStatusLines: this.buildCompatibilityStatusLines.bind(this),
            buildManageRequiresReindexHints: this.buildManageRequiresReindexHints.bind(this),
            buildStaleLocalHint: this.buildStaleLocalHint.bind(this),
            buildStaleLocalMessage: this.buildStaleLocalMessage.bind(this),
            enforceFingerprintGate: this.enforceFingerprintGate.bind(this),
            buildReindexHint: this.buildReindexHint.bind(this),
            buildSyncHint: this.buildSyncHint.bind(this),
            touchWatchedCodebase: this.touchWatchedCodebase.bind(this),
            manageVectorBackendResponse: this.toolResponseBuilders.manageVectorBackendResponse.bind(this.toolResponseBuilders),
            canSyncStaleLocal: this.canSyncStaleLocal.bind(this),
            getLiveOwnersSummary: async () => {
                if (!this.runtimeOwnerGate || typeof this.runtimeOwnerGate.getLiveOwnersSummary !== "function") {
                    return null;
                }
                return this.runtimeOwnerGate.getLiveOwnersSummary();
            },
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
        };
        this.manageMaintenanceHandlers = new ManageMaintenanceHandlers(manageMaintenanceHandlersHost);

        const getManageIndexingContext = () => this.context;
        const getManageIndexingSnapshotManager = () => this.snapshotManager;
        const getManageIndexingSyncManager = () => this.syncManager;
        const getManageIndexingRuntimeFingerprint = () => this.runtimeFingerprint;
        const getManageIndexingStartBackgroundIndexing = () => (this as unknown as {
            startBackgroundIndexing?: (
                codebasePath: string,
                forceReindex: boolean,
                writeCollectionName?: string,
                mutationLease?: import("./mutation-lease.js").RootMutationLease,
            ) => Promise<void> | void;
        }).startBackgroundIndexing;
        const manageIndexingHandlersHost: ConstructorParameters<typeof ManageIndexingHandlers>[0] = {
            get context() {
                return getManageIndexingContext();
            },
            get snapshotManager() {
                return getManageIndexingSnapshotManager();
            },
            get syncManager() {
                return getManageIndexingSyncManager();
            },
            get runtimeFingerprint() {
                return getManageIndexingRuntimeFingerprint();
            },
            get startBackgroundIndexing() {
                return getManageIndexingStartBackgroundIndexing();
            },
            manageResponse: this.toolResponseBuilders.manageResponse.bind(this.toolResponseBuilders),
            buildRuntimeOwnerConflictResponseIfBlocked: this.buildRuntimeOwnerConflictResponseIfBlocked.bind(this),
            recoverStaleIndexingStateIfNeeded: this.recoverStaleIndexingStateIfNeeded.bind(this),
            getSnapshotIndexingCodebases: this.getSnapshotIndexingCodebases.bind(this),
            getSnapshotCodebaseInfo: this.getSnapshotCodebaseInfo.bind(this),
            getSnapshotIndexedCodebases: this.getSnapshotIndexedCodebases.bind(this),
            buildManageActionBlockedMessage: this.buildManageActionBlockedMessage.bind(this),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildReindexHint: this.buildReindexHint.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            getManageRetryAfterMs: this.getManageRetryAfterMs.bind(this),
            buildIndexingMetadata: this.buildIndexingMetadata.bind(this),
            buildReindexInstruction: this.buildReindexInstruction.bind(this),
            buildManageRequiresReindexHints: this.buildManageRequiresReindexHints.bind(this),
            validateCompletionProof: (codebasePath: string) => this.validateCompletionProof(codebasePath),
            recoverIndexedSnapshotFromCompletionProof: this.recoverIndexedSnapshotFromCompletionProof.bind(this),
            isZillizBackend: this.isZillizBackend.bind(this),
            resolveCollectionName: this.resolveCollectionName.bind(this),
            dropZillizCollectionForCreate: this.dropZillizCollectionForCreate.bind(this),
            resolveStagedCollectionName: this.resolveStagedCollectionName.bind(this),
            buildCollectionLimitMessage: this.buildCollectionLimitMessage.bind(this),
            manageVectorBackendResponse: this.toolResponseBuilders.manageVectorBackendResponse.bind(this.toolResponseBuilders),
            saveSnapshotIfSupported: this.saveSnapshotIfSupported.bind(this),
            touchWatchedCodebase: this.touchWatchedCodebase.bind(this),
            setWriteCollectionOverride: this.setWriteCollectionOverride.bind(this),
            loadIndexProfileForCodebase: this.loadIndexProfileForCodebase.bind(this),
            getContextActiveIgnorePatterns: this.getContextActiveIgnorePatterns.bind(this),
            getContextIndexedExtensions: this.getContextIndexedExtensions.bind(this),
            canonicalizeCodebasePath: this.canonicalizeCodebasePath.bind(this),
            pruneIndexedCollectionFamily: this.pruneIndexedCollectionFamily.bind(this),
            pruneUnprovenStagedCollectionFamily: this.pruneUnprovenStagedCollectionFamily.bind(this),
            getContextTrackedRelativePaths: this.getContextTrackedRelativePaths.bind(this),
            setIndexingStats: this.setIndexingStats.bind(this),
            rebuildCallGraphForIndex: this.rebuildCallGraphForIndex.bind(this),
            getSnapshotIndexingProgress: this.getSnapshotIndexingProgress.bind(this),
            clearIndexCompletionMarker: this.clearIndexCompletionMarker.bind(this),
            evaluateReindexPreflight: this.evaluateReindexPreflight.bind(this),
            assertIndexMutationCapabilities: this.assertIndexMutationCapabilities.bind(this),
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
        };
        this.manageIndexingHandlers = new ManageIndexingHandlers(manageIndexingHandlersHost);
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    private setIndexingStats(stats: { indexedFiles: number; totalChunks: number } | null): void {
        this.indexingStats = stats;
    }

    private clearIndexingStats(): void {
        this.indexingStats = null;
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

    private buildReindexInstruction(codebasePath: string, detail?: string): string {
        const detailLine = detail ? `${detail}\n\n` : '';
        const compatibility = this.buildCompatibilityDiagnostics(codebasePath);
        if (this.isRuntimeFingerprintMismatch(compatibility)) {
            const indexedFingerprint = compatibility.indexedFingerprint
                ? this.summarizeFingerprint(compatibility.indexedFingerprint)
                : 'the indexed runtime fingerprint';
            const runtimeFingerprint = this.summarizeFingerprint(compatibility.runtimeFingerprint);
            return `${detailLine}Error: The current Satori runtime does not match the existing index at '${codebasePath}'. Recovery: restart Satori with ${indexedFingerprint} to reuse the current index. Reindex only if you intentionally want to migrate this repo to ${runtimeFingerprint}.`;
        }
        return `${detailLine}Error: The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt.\nNext step: call manage_index with {\"action\":\"reindex\",\"path\":\"${codebasePath}\"}.`;
    }

    private buildReindexHint(codebasePath: string): { tool: string; args: { action: string; path: string } } {
        return {
            tool: "manage_index",
            args: {
                action: "reindex",
                path: codebasePath
            }
        };
    }

    private buildCreateHint(codebasePath: string): { tool: string; args: { action: string; path: string } } {
        return {
            tool: "manage_index",
            args: {
                action: "create",
                path: codebasePath
            }
        };
    }

    private buildSyncHint(codebasePath: string): { tool: string; args: { action: string; path: string } } {
        return {
            tool: "manage_index",
            args: {
                action: "sync",
                path: codebasePath
            }
        };
    }

    private buildRepairHint(codebasePath: string): { tool: string; args: { action: string; path: string } } {
        return {
            tool: "manage_index",
            args: {
                action: "repair",
                path: codebasePath
            }
        };
    }

    private buildManageIndexRecommendedAction(
        action: Extract<ManageIndexAction, "create" | "reindex" | "status" | "sync" | "repair">,
        codebasePath: string,
        reason: string
    ): SearchRecommendedNextAction {
        return {
            tool: "manage_index",
            args: { action, path: codebasePath },
            reason,
        };
    }

    private buildStatusHint(codebasePath: string): { tool: string; args: { action: string; path: string } } {
        return {
            tool: "manage_index",
            args: {
                action: "status",
                path: codebasePath
            }
        };
    }

    private buildManageRequiresReindexHints(codebasePath: string): Record<string, unknown> {
        const compatibility = this.buildCompatibilityDiagnostics(codebasePath);
        return {
            reindex: this.buildReindexHint(codebasePath),
            status: this.buildStatusHint(codebasePath),
            ...(this.isRuntimeFingerprintMismatch(compatibility)
                ? { runtimeMismatch: this.buildRuntimeMismatchHint(codebasePath, compatibility) }
                : {}),
        };
    }

    private async touchWatchedCodebase(codebasePath: string): Promise<void> {
        const syncManager = this.syncManager as unknown as {
            touchWatchedCodebase?: (path: string) => Promise<void> | void;
            registerCodebaseWatcher?: (path: string) => Promise<void> | void;
        };
        if (typeof syncManager.touchWatchedCodebase === 'function') {
            await syncManager.touchWatchedCodebase(codebasePath);
            return;
        }
        if (typeof syncManager.registerCodebaseWatcher === 'function') {
            await syncManager.registerCodebaseWatcher(codebasePath);
        }
    }

    private async touchWatchedCodebaseBestEffort(codebasePath: string): Promise<void> {
        try {
            await this.touchWatchedCodebase(codebasePath);
        } catch (error) {
            console.warn(`[SEARCH] Failed to refresh watcher for '${codebasePath}' after successful search: ${formatUnknownError(error)}`);
        }
    }

    private async unwatchCodebase(codebasePath: string): Promise<void> {
        this.evictPreparedRead(codebasePath);
        const syncManager = this.syncManager as unknown as {
            unwatchCodebase?: (path: string) => Promise<void> | void;
            unregisterCodebaseWatcher?: (path: string) => Promise<void> | void;
        };
        if (typeof syncManager.unwatchCodebase === 'function') {
            await syncManager.unwatchCodebase(codebasePath);
            return;
        }
        if (typeof syncManager.unregisterCodebaseWatcher === 'function') {
            await syncManager.unregisterCodebaseWatcher(codebasePath);
        }
    }

    private getPreparedAuthorityObservation(codebasePath: string): string | null {
        try {
            const mutationObservation = this.mutationLeaseCoordinator?.observe(codebasePath);
            const authorityObservation = this.contextLifecycle().getIndexAuthorityObservations?.(codebasePath);
            if (!mutationObservation || mutationObservation.mutationActive || !authorityObservation) {
                return null;
            }
            return JSON.stringify({
                vectorAuthority: authorityObservation.vector,
                navigationAuthority: authorityObservation.navigation,
                mutationGeneration: mutationObservation.generation,
            });
        } catch {
            return null;
        }
    }

    private getPreparedReadCacheObservation(codebasePath: string): PreparedReadCacheObservationResult {
        const authorityObservation = this.getPreparedAuthorityObservation(codebasePath);
        if (!authorityObservation) return { observation: null, sourceObservation: null };

        try {
            const sourceObservation = this.syncManager.getPreparedReadObservation(codebasePath);
            if (!sourceObservation.available) {
                return {
                    observation: authorityObservation,
                    sourceObservation: null,
                    unavailableReason: sourceObservation.reason,
                };
            }
            return {
                observation: authorityObservation,
                sourceObservation: JSON.stringify(sourceObservation.observation),
            };
        } catch {
            return {
                observation: authorityObservation,
                sourceObservation: null,
                unavailableReason: 'source_observation_failed',
            };
        }
    }

    private evictPreparedRead(codebasePath: string): void {
        this.preparedReadCache.evict(codebasePath);
        this.statusPreparedReadObservations.delete(codebasePath);
        this.preparedNavigationCache.delete(codebasePath);
    }

    private getPreparedNavigationIdentity(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
    ): string | null {
        try {
            const receipt = preparedRead.generationReceipt;
            const preparedObservation = preparedRead.preparedObservation;
            const root = preparedRead.root.path;
            if (
                preparedRead.navigationStatus !== 'valid'
                || !receipt
                || !preparedObservation
                || receipt.policy.canonicalRoot !== root
                || this.getPreparedAuthorityObservation(root) !== preparedObservation
            ) {
                return null;
            }
            const identityParts = [
                receipt.collectionName,
                receipt.marker.runId,
                receipt.policyDocumentDigest,
                receipt.policy.policyHash,
                receipt.navigation.generationId,
                receipt.navigation.symbolRegistryManifestHash,
                receipt.navigation.relationshipManifestHash,
                receipt.navigation.navigationSealHash,
                receipt.observations.navigationToken,
            ];
            if (identityParts.some((value) => typeof value !== 'string' || value.length === 0)) {
                return null;
            }
            const observation = parsePreparedReadObservation(preparedObservation);
            if (!observation) return null;

            return JSON.stringify({
                canonicalRoot: root,
                collectionName: receipt.collectionName,
                markerRunId: receipt.marker.runId,
                policyDocumentDigest: receipt.policyDocumentDigest,
                policyHash: receipt.policy.policyHash,
                navigationGenerationId: receipt.navigation.generationId,
                symbolRegistryManifestHash: receipt.navigation.symbolRegistryManifestHash,
                relationshipManifestHash: receipt.navigation.relationshipManifestHash,
                navigationSealHash: receipt.navigation.navigationSealHash,
                navigationObservationToken: receipt.observations.navigationToken,
                mutationGeneration: observation.mutationGeneration,
            });
        } catch {
            return null;
        }
    }

    private getPreparedNavigationCacheEntry(
        root: string,
        identity: string,
    ): PreparedNavigationCacheEntry | undefined {
        const entry = this.preparedNavigationCache.get(root);
        if (!entry || entry.identity !== identity) return undefined;
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
        identity: string,
        update: (entry: PreparedNavigationCacheEntry) => void,
    ): void {
        const existing = this.preparedNavigationCache.get(root);
        const entry = existing?.identity === identity
            ? existing
            : {
                identity,
                symbolsByFile: new Map<string, NavigationSymbolsByFileOk>(),
                compatibilityByManifestHash: new Map<string, NavigationCompatibilityState>(),
            };
        update(entry);
        setBoundedCacheEntry(
            this.preparedNavigationCache,
            root,
            entry,
            PREPARED_NAVIGATION_CACHE_MAX_ROOTS,
        );
    }

    private async loadPreparedNavigationManifest(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        operations?: SearchReadinessDebugHint['operations'],
    ): Promise<NavigationManifestState> {
        const root = preparedRead.root.path;
        const identityBefore = this.getPreparedNavigationIdentity(preparedRead);
        const cached = identityBefore
            ? this.getPreparedNavigationCacheEntry(root, identityBefore)?.manifest
            : undefined;
        if (
            cached
            && this.getPreparedNavigationIdentity(preparedRead) === identityBefore
        ) return cached;

        if (operations) operations.registryLoads += 1;
        const result = await this.navigationStore.getManifest({ normalizedRootPath: root });
        if (
            result.status === 'ok'
            && identityBefore
            && this.getPreparedNavigationIdentity(preparedRead) === identityBefore
        ) {
            this.storePreparedNavigationCacheEntry(root, identityBefore, (entry) => {
                entry.manifest = result;
            });
        }
        return result;
    }

    private async loadPreparedNavigationSymbolsByFile(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        file: string,
    ): Promise<NavigationSymbolsByFileState> {
        const root = preparedRead.root.path;
        const identityBefore = this.getPreparedNavigationIdentity(preparedRead);
        const cached = identityBefore
            ? this.getPreparedNavigationCacheEntry(root, identityBefore)?.symbolsByFile.get(file)
            : undefined;
        if (
            cached
            && this.getPreparedNavigationIdentity(preparedRead) === identityBefore
        ) return cached;

        const result = await this.navigationStore.getSymbolsByFile({
            normalizedRootPath: root,
            file,
        });
        if (
            result.status === 'ok'
            && identityBefore
            && this.getPreparedNavigationIdentity(preparedRead) === identityBefore
        ) {
            this.storePreparedNavigationCacheEntry(root, identityBefore, (entry) => {
                setBoundedCacheEntry(
                    entry.symbolsByFile,
                    file,
                    result,
                    PREPARED_NAVIGATION_CACHE_MAX_FILES_PER_ROOT,
                );
            });
        }
        return result;
    }

    private async loadPreparedNavigationCompatibility(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        expectedSymbolRegistryManifestHash: string,
        operations?: SearchReadinessDebugHint['operations'],
    ): Promise<NavigationCompatibilityState> {
        const root = preparedRead.root.path;
        const identityBefore = this.getPreparedNavigationIdentity(preparedRead);
        const cached = identityBefore
            ? this.getPreparedNavigationCacheEntry(root, identityBefore)
                ?.compatibilityByManifestHash.get(expectedSymbolRegistryManifestHash)
            : undefined;
        if (
            cached
            && this.getPreparedNavigationIdentity(preparedRead) === identityBefore
        ) return cached;

        if (operations) operations.navigationValidationRuns += 1;
        const result = await this.navigationStore.getCompatibilityState({
            normalizedRootPath: root,
            expectedSymbolRegistryManifestHash,
        });
        if (
            result.registry?.status === 'ok'
            && result.relationships.status === 'ok'
            && identityBefore
            && this.getPreparedNavigationIdentity(preparedRead) === identityBefore
        ) {
            this.storePreparedNavigationCacheEntry(root, identityBefore, (entry) => {
                setBoundedCacheEntry(
                    entry.compatibilityByManifestHash,
                    expectedSymbolRegistryManifestHash,
                    result,
                    PREPARED_NAVIGATION_CACHE_MAX_COMPATIBILITY_RESULTS_PER_ROOT,
                );
            });
        }
        return result;
    }

    private async getCachedPreparedRead(
        absolutePath: string,
        operations: SearchReadinessDebugHint["operations"],
        requireNavigation = false,
    ): Promise<CachedPreparedReadResult> {
        operations.preparedCacheLookups += 1;
        const lookup = this.preparedReadCache.lookupCandidate(
            absolutePath,
            this.now(),
            (targetPath, root) => this.isPathWithinCodebase(targetPath, root),
        );
        if (lookup.status === "miss") {
            return { status: "miss", reason: lookup.reason };
        }
        const cached = lookup.state;
        if (!cached.vectorReceipt) {
            this.evictPreparedRead(lookup.root);
            return { status: "miss", reason: "cache_miss" };
        }
        const root = cached.root.path;
        const observationBeforeResult = this.getPreparedReadCacheObservation(root);
        const observationBefore = observationBeforeResult.observation;
        const statusPreparedObservation = this.statusPreparedReadObservations.get(root);
        if (statusPreparedObservation) {
            this.statusPreparedReadObservations.delete(root);
            const receiptIsCurrent = this.contextLifecycle()
                .isPreparedVectorReceiptBoundToCurrentAuthority?.(root, cached.vectorReceipt) === true;
            if (
                !observationBefore
                || observationBefore !== lookup.observation
                || observationBefore !== statusPreparedObservation.observation
                || observationBeforeResult.sourceObservation !== statusPreparedObservation.sourceObservation
                || (observationBeforeResult.unavailableReason ?? null)
                    !== statusPreparedObservation.unavailableReason
                || !receiptIsCurrent
            ) {
                this.evictPreparedRead(root);
                return {
                    status: "miss",
                    reason: observationBefore ? "observation_changed" : "observation_unavailable",
                    ...(observationBeforeResult.unavailableReason
                        ? { observationUnavailableReason: observationBeforeResult.unavailableReason }
                        : {}),
                };
            }
            operations.preparedCacheHits += 1;
            return {
                status: "hit",
                state: {
                    ...cached,
                    preparedObservation: observationBefore,
                    statusPrepared: true,
                },
            };
        }
        const revalidate = this.contextLifecycle().revalidatePreparedGeneration;
        if (!observationBefore || typeof revalidate !== 'function') {
            this.evictPreparedRead(root);
            return {
                status: "miss",
                reason: "observation_unavailable",
                ...(observationBeforeResult.unavailableReason
                    ? { observationUnavailableReason: observationBeforeResult.unavailableReason }
                    : {}),
            };
        }
        const cachedObservation = parsePreparedReadObservation(lookup.observation);
        const currentObservation = observationBefore ? parsePreparedReadObservation(observationBefore) : null;
        if (
            !cachedObservation
            || !currentObservation
            || cachedObservation.vectorAuthority !== currentObservation.vectorAuthority
            || cachedObservation.mutationGeneration !== currentObservation.mutationGeneration
        ) {
            this.evictPreparedRead(root);
            return { status: "miss", reason: "observation_changed" };
        }
        const navigationObservationChanged =
            cachedObservation.navigationAuthority !== currentObservation.navigationAuthority;
        operations.warmReceiptRevalidations += 1;
        const proof = await revalidate.call(this.context, root, cached.vectorReceipt, {
            ...(cached.generationReceipt ? { priorGenerationReceipt: cached.generationReceipt } : {}),
            navigationObservationChanged,
        }).catch(() => null);
        const observationAfter = this.getPreparedReadCacheObservation(root).observation;
        if (
            !proof
            || proof.navigationProof.status === 'requires_reindex'
            || proof.navigationProof.status === 'unsupported'
            || (requireNavigation && proof.navigationProof.status !== 'valid')
            || observationAfter !== observationBefore
        ) {
            this.evictPreparedRead(root);
            return {
                status: "miss",
                reason: observationAfter !== observationBefore
                    ? "observation_changed"
                    : "revalidation_failed",
            };
        }
        operations.preparedCacheHits += 1;
        return {
            status: "hit",
            state: {
                ...cached,
                vectorReceipt: proof.vectorReceipt,
                generationReceipt: proof.generationReceipt,
                navigationStatus: proof.navigationProof.status,
                preparedObservation: observationBefore,
            },
        };
    }

    private seedPreparedRead(
        state: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        preserveProofAge: boolean,
        statusPrepared = false,
    ): void {
        const root = state.root.path;
        if (!state.vectorReceipt || !state.preparedObservation) {
            // A warm hit already proved the prior entry. Do not discard it when the
            // end-of-search snapshot is incomplete; the next search revalidates live.
            if (!preserveProofAge) {
                this.evictPreparedRead(root);
            }
            return;
        }
        const observationResult = this.getPreparedReadCacheObservation(root);
        const observation = observationResult.observation;
        if (!observation || observation !== state.preparedObservation) {
            // Mid-search authority/registry/navigation work can transiently change the
            // prepared-read observation string after a successful warm revalidation.
            // Evicting here turns the next identical search into a full cold recount
            // (proofMode=cold, invalidationReason=cache_miss) and breaks warm recording.
            // Cold seeds (preserveProofAge=false) still fail closed by eviction.
            if (!preserveProofAge) {
                this.evictPreparedRead(root);
            }
            return;
        }
        if (statusPrepared) {
            setBoundedCacheEntry(
                this.statusPreparedReadObservations,
                root,
                {
                    observation,
                    sourceObservation: observationResult.sourceObservation,
                    unavailableReason: observationResult.unavailableReason ?? null,
                },
                PREPARED_NAVIGATION_CACHE_MAX_ROOTS,
            );
        } else {
            this.statusPreparedReadObservations.delete(root);
        }
        const navigationIdentity = this.getPreparedNavigationIdentity(state);
        if (this.preparedNavigationCache.get(root)?.identity !== navigationIdentity) {
            this.preparedNavigationCache.delete(root);
        }
        const cacheableState = { ...state };
        delete cacheableState.statusPrepared;
        this.preparedReadCache.seed(
            root,
            cacheableState,
            observation,
            this.now(),
            preserveProofAge,
        );
    }

    private async prepareStatusTrackedRootRead(
        absolutePath: string,
    ): Promise<TrackedRootReadinessState> {
        const state = await this.prepareTrackedRootReadWithObservation(
            absolutePath,
            () => undefined,
        );
        if (state.state === 'ready') {
            // A process-cold status proof may initialize Core's published policy
            // binding, so no observation existed before the proof. Bind the proven
            // receipt to the first stable post-proof observation; seedPreparedRead
            // immediately rechecks it and refuses any intervening authority change.
            const preparedObservation = state.preparedObservation
                ?? this.getPreparedAuthorityObservation(state.root.path)
                ?? undefined;
            this.seedPreparedRead(
                { ...state, ...(preparedObservation ? { preparedObservation } : {}) },
                false,
                true,
            );
        }
        return state;
    }

    private async prepareTrackedRootReadWithObservation(
        absolutePath: string,
        onPhase: (phase: ReadinessPhase, durationMs: number) => void,
        accessMode: 'semantic' | 'navigation' = 'semantic',
    ): Promise<TrackedRootReadinessState> {
        const state = await this.trackedRootReadiness.prepareTrackedRootForRead(
            absolutePath,
            accessMode,
            onPhase,
            { observePreparedRead: (root) => this.getPreparedAuthorityObservation(root) },
        );
        if (
            state.state === 'ready'
            && this.mutationLeaseCoordinator?.getActiveLease(state.root.path)
        ) {
            this.evictPreparedRead(state.root.path);
            return { state: 'indexing', codebasePath: state.root.path };
        }
        return state;
    }

    private async prepareNavigationRead(absolutePath: string): Promise<TrackedRootReadinessState> {
        const operations: SearchReadinessDebugHint['operations'] = {
            preparedCacheLookups: 0,
            preparedCacheHits: 0,
            coldReadinessChecks: 0,
            postFreshnessColdChecks: 0,
            warmReceiptRevalidations: 0,
            exactPayloadRecounts: 0,
            registryLoads: 0,
            navigationValidationRuns: 0,
        };
        const cached = await this.getCachedPreparedRead(absolutePath, operations, true);
        if (cached.status === 'hit') return cached.state;

        const state = await this.prepareTrackedRootReadWithObservation(
            absolutePath,
            () => undefined,
            'navigation',
        );
        if (state.state === 'ready') {
            this.seedPreparedRead(state, false);
        }
        return state;
    }

    private async prepareSymbolContextSnapshot(input: {
        codebaseRoot: string;
        relativeFile: string;
        symbolId?: string;
        symbolLabel?: string;
    }): Promise<PrepareSymbolContextSnapshotResult> {
        const preparedRead = await this.prepareNavigationRead(
            path.resolve(input.codebaseRoot, input.relativeFile),
        );
        if (preparedRead.state !== 'ready') {
            return {
                status: 'unavailable',
                reason: `prepared_navigation_${preparedRead.state}`,
            };
        }

        const initialNavigationIdentity = this.getPreparedNavigationIdentity(preparedRead);
        if (!initialNavigationIdentity) {
            return { status: 'unavailable', reason: 'prepared_navigation_identity_unavailable' };
        }
        const registryState = await this.loadPreparedNavigationSymbolsByFile(
            preparedRead,
            input.relativeFile,
        );
        if (registryState.status !== 'ok') {
            return {
                status: 'unavailable',
                reason: `symbol_registry_${registryState.status}`,
            };
        }
        const navigationBinding = preparedRead.generationReceipt?.navigation;
        if (
            !navigationBinding
            || registryState.manifestHash !== navigationBinding.symbolRegistryManifestHash
        ) {
            return {
                status: 'unavailable',
                reason: 'prepared_navigation_registry_manifest_changed',
            };
        }

        const compatibility = await this.loadPreparedNavigationCompatibility(
            preparedRead,
            registryState.manifestHash,
        );
        const relationshipState = compatibility.relationships;
        const relationshipManifestMatchesBinding = relationshipState.status === 'ok'
            && relationshipState.manifestHash === navigationBinding.relationshipManifestHash;
        const exactTargets = findExactRegistrySymbols({
            symbols: registryState.registry.symbolsByFile.get(input.relativeFile) || [],
            ...(input.symbolId ? { symbolIdExact: input.symbolId } : {}),
            ...(input.symbolLabel ? { symbolLabelExact: input.symbolLabel } : {}),
        });
        const preparedTraversals = relationshipState.status === 'ok'
            && relationshipManifestMatchesBinding
            && exactTargets.length === 1
            ? await prepareRelationshipTraversals({
                rootPath: preparedRead.root.path,
                registryManifestIdentity: registryState.manifestHash,
                relationshipManifestIdentity: relationshipState.manifestHash,
                registry: registryState.registry,
                target: exactTargets[0],
                relationshipManifest: relationshipState.manifest,
                relationshipRecords: relationshipState.records,
                relationshipWarnings: relationshipState.warnings || [],
            })
            : undefined;
        const relationships: PreparedRelationshipSnapshot = relationshipManifestMatchesBinding
            && preparedTraversals
            ? {
                status: 'available',
                // getPreparedNavigationIdentity gates this adapter on navigationStatus=valid
                // plus a proven generation receipt; local-only readiness cannot reach here.
                authority: 'remote_generation_proven',
                manifestIdentity: navigationBinding.relationshipManifestHash,
                callers: preparedTraversals.callers,
                callees: preparedTraversals.callees,
            }
            : {
                status: 'unavailable',
                authority: 'unavailable',
                reason: relationshipState.status === 'ok'
                    ? relationshipManifestMatchesBinding
                        ? 'relationship_traversal_unavailable'
                        : 'relationship_manifest_identity_changed'
                    : `relationship_sidecar_${relationshipState.status}`,
            };
        if (this.getPreparedNavigationIdentity(preparedRead) !== initialNavigationIdentity) {
            return { status: 'unavailable', reason: 'prepared_navigation_changed' };
        }

        return {
            status: 'ready',
            snapshot: {
                canonicalRoot: preparedRead.root.path,
                registryManifestIdentity: navigationBinding.symbolRegistryManifestHash,
                registry: registryState.registry,
                // The same proven-generation gate above owns this classification.
                navigationAuthority: 'remote_generation_proven',
                relationships,
                validateAuthority: async () => (
                    this.getPreparedNavigationIdentity(preparedRead) === initialNavigationIdentity
                ),
            },
        };
    }

    private getSyncWatchDebounceMs(): number {
        const syncManager = this.syncManager as unknown as {
            getWatchDebounceMs?: () => number;
        };
        const value = syncManager.getWatchDebounceMs?.();
        return typeof value === 'number' && Number.isFinite(value) && value > 0
            ? value
            : DEFAULT_WATCH_DEBOUNCE_MS;
    }

    private contextLifecycle(): ContextLifecycleCapabilities {
        return this.context as unknown as ContextLifecycleCapabilities;
    }

    private snapshotCapabilities(): SnapshotManagerCapabilities {
        return this.snapshotManager as unknown as SnapshotManagerCapabilities;
    }

    private getSnapshotIndexedCodebases(): string[] {
        const value = this.snapshotCapabilities().getIndexedCodebases?.();
        return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
    }

    private getSnapshotIndexingCodebases(): string[] {
        const value = this.snapshotCapabilities().getIndexingCodebases?.();
        return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
    }

    private getSnapshotAllCodebases(): TrackedRootEntry[] {
        const value = this.snapshotCapabilities().getAllCodebases?.();
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .filter((entry): entry is { path: string; info: CodebaseInfo } =>
                Boolean(entry)
                && typeof entry.path === 'string'
                && Boolean(entry.info)
                && typeof entry.info.status === 'string'
            )
            .map((entry) => ({ path: entry.path, info: entry.info as unknown as TrackedCodebaseInfo }));
    }

    private getSnapshotCodebaseStatus(codebasePath: string): CodebaseStatus | 'not_found' {
        const capabilities = this.snapshotCapabilities();
        const info = capabilities.getCodebaseInfo?.(codebasePath);
        if (info?.status) {
            return info.status;
        }
        const status = capabilities.getCodebaseStatus?.(codebasePath);
        if (status) {
            return status;
        }
        if (this.getSnapshotIndexedCodebases().includes(codebasePath)) {
            return 'indexed';
        }
        if (this.getSnapshotIndexingCodebases().includes(codebasePath)) {
            return 'indexing';
        }
        return 'not_found';
    }

    private getSnapshotCodebaseInfo(codebasePath: string): TrackedCodebaseInfo | undefined {
        const info = this.snapshotCapabilities().getCodebaseInfo?.(codebasePath);
        if (info?.status) {
            return info as unknown as TrackedCodebaseInfo;
        }
        const status = this.getSnapshotCodebaseStatus(codebasePath);
        if (status === 'not_found') {
            return undefined;
        }
        return { status, lastUpdated: new Date(0).toISOString() };
    }

    private getSnapshotIndexingProgress(codebasePath: string): number | undefined {
        const progress = this.snapshotCapabilities().getIndexingProgress?.(codebasePath);
        return typeof progress === 'number' && Number.isFinite(progress) ? progress : undefined;
    }

    private ensureSnapshotFingerprintCompatibility(codebasePath: string): SnapshotAccessGateResult {
        const gate = this.snapshotCapabilities().ensureFingerprintCompatibilityOnAccess?.(
            codebasePath,
            { mutate: false },
        );
        if (!gate || typeof gate.allowed !== 'boolean' || typeof gate.changed !== 'boolean') {
            return { allowed: true, changed: false };
        }
        return gate;
    }

    private saveSnapshotIfSupported(): void {
        const saveCodebaseSnapshot = this.snapshotCapabilities().saveCodebaseSnapshot;
        if (typeof saveCodebaseSnapshot !== 'function') {
            throw new Error('Missing required mutation capability: SnapshotManager.saveCodebaseSnapshot.');
        }
        const saved = saveCodebaseSnapshot.call(this.snapshotManager);
        if (saved === false) {
            throw new Error('Failed to persist snapshot state.');
        }
    }

    private canonicalizeCodebasePath(codebasePath: string): string {
        return this.searchQuerySupport.canonicalizeCodebasePath(codebasePath);
    }

    private assertIndexMutationCapabilities(): void {
        const context = this.context as unknown as Record<string, unknown>;
        const snapshot = this.snapshotManager as unknown as Record<string, unknown>;
        const requiredContextCapabilities = [
            'resolveCollectionName',
            'resolveStagedCollectionName',
            'setWriteCollectionOverride',
            'prepareIndexCollection',
            'discardPreparedIndexCollection',
            'getActiveIndexedCollectionName',
            'clearIndexCompletionMarker',
            'pruneIndexedCollectionFamily',
            'pruneUnprovenStagedCollectionFamily',
        ] as const;
        const requiredSnapshotCapabilities = [
            'saveCodebaseSnapshot',
            'setCodebaseIndexing',
            'setCodebaseIndexFailed',
            'setCodebaseIndexed',
            'setCodebaseIndexManifest',
            'commitCodebaseLifecycleMutation',
        ] as const;

        for (const capability of requiredContextCapabilities) {
            if (typeof context[capability] !== 'function') {
                throw new Error(`Missing required mutation capability: Context.${capability}.`);
            }
        }
        for (const capability of requiredSnapshotCapabilities) {
            if (typeof snapshot[capability] !== 'function') {
                throw new Error(`Missing required mutation capability: SnapshotManager.${capability}.`);
            }
        }
    }

    private resolveCollectionName(codebasePath: string): string {
        const resolve = this.contextLifecycle().resolveCollectionName;
        if (typeof resolve !== 'function') {
            throw new Error('Context lifecycle capability resolveCollectionName is required.');
        }
        return resolve.call(this.context, codebasePath);
    }

    private resolveStagedCollectionName(codebasePath: string, generationId: string): string {
        const resolve = this.contextLifecycle().resolveStagedCollectionName;
        if (typeof resolve !== 'function') {
            throw new Error('Context lifecycle capability resolveStagedCollectionName is required.');
        }
        return resolve.call(this.context, codebasePath, generationId);
    }

    private setWriteCollectionOverride(codebasePath: string, collectionName: string | null): void {
        const setOverride = this.contextLifecycle().setWriteCollectionOverride;
        if (typeof setOverride !== 'function') {
            throw new Error('Context lifecycle capability setWriteCollectionOverride is required.');
        }
        setOverride.call(this.context, codebasePath, collectionName);
    }

    private loadIndexProfileForCodebase(codebasePath: string): IndexProfileView {
        return this.contextLifecycle().loadIndexProfileForCodebase?.(codebasePath) || { profile: 'default' };
    }

    private getContextActiveIgnorePatterns(codebasePath: string): string[] {
        const patterns = this.contextLifecycle().getActiveIgnorePatterns?.(codebasePath);
        return Array.isArray(patterns) ? patterns.filter((pattern): pattern is string => typeof pattern === 'string') : [];
    }

    private getContextIndexedExtensions(codebasePath: string): string[] {
        const context = this.contextLifecycle();
        const codebaseExtensions = context.getIndexedExtensionsForCodebase?.(codebasePath);
        if (Array.isArray(codebaseExtensions) && codebaseExtensions.length > 0) {
            return codebaseExtensions.filter((extension): extension is string => typeof extension === 'string');
        }
        const defaultExtensions = context.getIndexedExtensions?.();
        if (Array.isArray(defaultExtensions) && defaultExtensions.length > 0) {
            return defaultExtensions.filter((extension): extension is string => typeof extension === 'string');
        }
        return getSupportedExtensionsForCapability('search');
    }

    private getContextTrackedRelativePaths(codebasePath: string): string[] {
        const paths = this.contextLifecycle().getTrackedRelativePaths?.(codebasePath);
        return Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === 'string') : [];
    }

    private async clearIndexCompletionMarker(codebasePath: string, assertMutationCurrent?: () => void): Promise<void> {
        const clear = this.contextLifecycle().clearIndexCompletionMarker;
        if (typeof clear !== 'function') {
            throw new Error('Context lifecycle capability clearIndexCompletionMarker is required.');
        }
        await clear.call(this.context, codebasePath, assertMutationCurrent);
    }

    private async pruneIndexedCollectionFamily(codebasePath: string, keepCollectionName: string, assertMutationCurrent?: () => void): Promise<string[]> {
        const prune = this.contextLifecycle().pruneIndexedCollectionFamily;
        if (typeof prune !== 'function') {
            throw new Error('Context lifecycle capability pruneIndexedCollectionFamily is required.');
        }
        const dropped = await prune.call(this.context, codebasePath, keepCollectionName, { assertMutationCurrent });
        return Array.isArray(dropped) ? dropped.filter((entry): entry is string => typeof entry === 'string') : [];
    }

    private async pruneUnprovenStagedCollectionFamily(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        discardUnprovenPayload: boolean = false,
    ): Promise<string[]> {
        const prune = this.contextLifecycle().pruneUnprovenStagedCollectionFamily;
        if (typeof prune !== 'function') {
            throw new Error('Context lifecycle capability pruneUnprovenStagedCollectionFamily is required.');
        }
        const dropped = await prune.call(this.context, codebasePath, {
            assertMutationCurrent,
            discardUnprovenPayload,
        });
        return Array.isArray(dropped) ? dropped.filter((entry): entry is string => typeof entry === 'string') : [];
    }

    private markCodebaseCleared(codebasePath: string, collectionName?: string): void {
        this.snapshotCapabilities().markCodebaseCleared?.(codebasePath, collectionName);
    }

    private stringifyToolJson(payload: unknown): string {
        return JSON.stringify(payload);
    }

    private async buildRuntimeOwnerConflictResponseIfBlocked(
        action: RuntimeOwnerMutationAction,
        codebasePath: string
    ): Promise<{ content: Array<{ type: "text"; text: string }> } | null> {
        if (!this.runtimeOwnerGate) {
            return null;
        }
        const result = await this.runtimeOwnerGate.checkMutation(action, codebasePath);
        if (!result.blocked) {
            return null;
        }
        return this.buildRuntimeOwnerConflictResponse(action, codebasePath, result);
    }

    private buildRuntimeOwnerConflictResponse(
        action: RuntimeOwnerMutationAction,
        codebasePath: string,
        result: RuntimeOwnerMutationGateResult
    ): { content: Array<{ type: "text"; text: string }> } {
        const conflictingOwners = result.conflictingOwners || [];
        const message = result.message
            || formatRuntimeOwnerConflictMessage({
                conflictingOwners,
            });
        return this.toolResponseBuilders.manageResponse(action, codebasePath, "blocked", message, {
            reason: "runtime_owner_conflict",
            hints: {
                runtimeOwners: conflictingOwners,
                nextStep: formatRuntimeOwnerConflictNextStep(conflictingOwners),
                nextSteps: [
                    formatRuntimeOwnerConflictNextStep(conflictingOwners),
                    "Do not loop create/reindex/sync while runtime_owner_conflict is returned.",
                    "Search may still work with degraded freshness; mutations stay blocked until a single runtime identity remains.",
                ],
            }
        });
    }

    private buildIndexingMetadata(codebasePath: string): { progressPct: number | null; lastUpdated: string | null; phase: string | null } {
        const info = this.getSnapshotCodebaseInfo(codebasePath);
        if (!info || info.status !== 'indexing') {
            return {
                progressPct: null,
                lastUpdated: null,
                phase: null
            };
        }

        return {
            progressPct: Number.isFinite(info.indexingPercentage) ? Number(info.indexingPercentage) : null,
            lastUpdated: typeof info.lastUpdated === 'string' ? info.lastUpdated : null,
            phase: null
        };
    }

    private isIndexingStateStale(codebasePath: string, graceMs: number = STALE_INDEXING_RECOVERY_GRACE_MS): boolean {
        const info = this.getSnapshotCodebaseInfo(codebasePath);
        if (!info || info.status !== "indexing") {
            return false;
        }

        const lastUpdatedMs = typeof info.lastUpdated === 'string'
            ? Date.parse(info.lastUpdated)
            : Number.NaN;
        if (!Number.isFinite(lastUpdatedMs)) {
            return true;
        }

        return (this.now() - lastUpdatedMs) > graceMs;
    }

    /**
     * Recover abandoned `indexing` lifecycle rows.
     *
     * Wall-clock grace applies only before exclusive ownership is proven. When
     * `existingLease` is held (or startup forces exclusive acquisition), recovery
     * runs immediately because a live compliant writer cannot share the root.
     */
    private async recoverStaleIndexingStateIfNeeded(
        codebasePath: string,
        existingLease?: RootMutationLease,
        options?: { skipGrace?: boolean },
    ): Promise<RootMutationLease | undefined> {
        const indexingCodebases = this.getSnapshotIndexingCodebases();
        if (!Array.isArray(indexingCodebases) || !indexingCodebases.includes(codebasePath)) {
            return;
        }
        if (!this.mutationLeaseCoordinator) {
            return;
        }
        const skipGrace = Boolean(existingLease) || options?.skipGrace === true;
        if (!skipGrace && !this.isIndexingStateStale(codebasePath)) {
            return;
        }
        const completionMarkerContext = this.context as unknown as IndexCompletionMarkerContext;
        if (typeof completionMarkerContext.getIndexCompletionMarker !== "function") {
            return;
        }

        let recoveryLease = existingLease;
        let releaseRecoveryLease = false;
        let operationTerminal = false;
        const persistRecoverySnapshot = (mutateSnapshot: () => void): void => {
            if (!recoveryLease) {
                throw new Error(`Interrupted-index recovery for '${codebasePath}' requires a mutation lease.`);
            }
            this.mutationLeaseCoordinator!.assertCurrent(recoveryLease);
            if (typeof this.snapshotManager.commitCodebaseLifecycleMutation !== 'function') {
                throw new Error('Missing required mutation capability: SnapshotManager.commitCodebaseLifecycleMutation.');
            }
            const assertCurrent = () => this.mutationLeaseCoordinator!.assertCurrent(recoveryLease!);
            const committed = this.snapshotManager.commitCodebaseLifecycleMutation(
                mutateSnapshot,
                assertCurrent,
            );
            if (!committed) {
                throw new Error(`Failed to persist interrupted-index recovery for '${codebasePath}'.`);
            }
        };
        const persistRecoveryPhase = (
            phase: import("../config.js").IndexOperationPhase,
            mutateSnapshot?: () => void,
        ): void => {
            if (!releaseRecoveryLease || !recoveryLease || typeof this.snapshotManager.transitionOperation !== "function") {
                if (mutateSnapshot) {
                    persistRecoverySnapshot(mutateSnapshot);
                }
                return;
            }
            this.mutationLeaseCoordinator?.assertCurrent(recoveryLease);
            if (typeof this.snapshotManager.commitOperationPhase === "function") {
                this.snapshotManager.commitOperationPhase(
                    recoveryLease,
                    phase,
                    mutateSnapshot,
                    () => this.mutationLeaseCoordinator?.assertCurrent(recoveryLease!),
                );
            } else {
                this.snapshotManager.transitionOperation(recoveryLease, phase);
                mutateSnapshot?.();
                if (this.snapshotManager.saveCodebaseSnapshot(
                    false,
                    () => this.mutationLeaseCoordinator?.assertCurrent(recoveryLease!),
                ) === false) {
                    throw new Error(`Failed to persist stale-index recovery phase '${phase}' for '${codebasePath}'.`);
                }
            }
            operationTerminal = phase === "completed" || phase === "failed" || phase === "blocked";
        };
        if (this.mutationLeaseCoordinator) {
            if (recoveryLease) {
                this.mutationLeaseCoordinator.assertCurrent(recoveryLease);
            } else {
                const leaseResult = this.mutationLeaseCoordinator.acquire(codebasePath, "repair");
                if (!leaseResult.acquired) {
                    return leaseResult.activeLease;
                }
                recoveryLease = leaseResult.lease;
                releaseRecoveryLease = true;
            }
        }

        try {
            if (releaseRecoveryLease && recoveryLease && typeof this.snapshotManager.startOperation === "function") {
                if (typeof this.snapshotManager.commitOperationPhase === "function") {
                    this.snapshotManager.commitOperationPhase(
                        recoveryLease,
                        "accepted",
                        undefined,
                        () => this.mutationLeaseCoordinator?.assertCurrent(recoveryLease!),
                    );
                } else {
                    this.snapshotManager.startOperation(recoveryLease);
                }
                if (
                    typeof this.snapshotManager.commitOperationPhase !== "function"
                    && this.snapshotManager.saveCodebaseSnapshot(
                        false,
                        () => this.mutationLeaseCoordinator?.assertCurrent(recoveryLease!),
                    ) === false
                ) {
                    throw new Error(`Failed to persist accepted stale-index recovery receipt for '${codebasePath}'.`);
                }
            }
            this.refreshSnapshotStateFromDisk();
            // Exclusive ownership (caller lease or self-acquired) supersedes wall-clock grace.
            if (!this.getSnapshotIndexingCodebases().includes(codebasePath)) {
                persistRecoveryPhase("completed");
                return;
            }
            const holdsExclusiveOwnership = Boolean(recoveryLease);
            if (!holdsExclusiveOwnership && !this.isIndexingStateStale(codebasePath)) {
                return;
            }

            let marker: IndexCompletionMarkerDocument | null = null;
            try {
                persistRecoveryPhase("proving");
                marker = await completionMarkerContext.getIndexCompletionMarker(codebasePath);
            } catch (error: unknown) {
                console.warn(`[INDEX-RECOVERY] Stale indexing recovery probe failed for '${codebasePath}': ${formatUnknownError(error)}`);
                persistRecoveryPhase("failed");
                return;
            }

            if (recoveryLease) {
                this.mutationLeaseCoordinator?.assertCurrent(recoveryLease);
            }
            const decision = decideInterruptedIndexingRecovery(marker, this.runtimeFingerprint);
            if (decision.action === "promote_indexed") {
                const collectionName = await this.getActiveIndexedCollectionNameForSnapshotRecovery(codebasePath);
                if (recoveryLease) {
                    this.mutationLeaseCoordinator?.assertCurrent(recoveryLease);
                }
                if (releaseRecoveryLease) {
                    persistRecoveryPhase("publishing");
                }
                if (releaseRecoveryLease) {
                    persistRecoveryPhase("completed", () => {
                        this.snapshotManager.setCodebaseIndexed(codebasePath, decision.stats, decision.indexFingerprint, "verified", collectionName);
                    });
                } else {
                    persistRecoverySnapshot(() => {
                        this.snapshotManager.setCodebaseIndexed(codebasePath, decision.stats, decision.indexFingerprint, "verified", collectionName);
                    });
                }
                const recoveryMode = decision.reason === "valid_marker_runtime_mismatch"
                    ? " using completion marker proof from a different runtime fingerprint"
                    : " using completion marker proof";
                console.log(`[INDEX-RECOVERY] Promoted stale indexing state to indexed for '${codebasePath}'${recoveryMode}.`);
                return;
            }

            const lastProgress = this.getSnapshotIndexingProgress(codebasePath);
            if (releaseRecoveryLease) {
                persistRecoveryPhase("failed", () => {
                    this.snapshotManager.setCodebaseIndexFailed(codebasePath, decision.message, lastProgress);
                });
            } else {
                persistRecoverySnapshot(() => {
                    this.snapshotManager.setCodebaseIndexFailed(codebasePath, decision.message, lastProgress);
                });
            }
            console.log(`[INDEX-RECOVERY] Marked stale indexing state as failed for '${codebasePath}' (${decision.reason}).`);
        } catch (error) {
            if (
                releaseRecoveryLease
                && recoveryLease
                && !operationTerminal
                && this.mutationLeaseCoordinator?.isCurrent(recoveryLease)
            ) {
                try {
                    persistRecoveryPhase("failed");
                } catch {
                    // Preserve the last durable receipt owned by this recovery operation.
                }
            }
            throw error;
        } finally {
            if (releaseRecoveryLease && recoveryLease) {
                this.mutationLeaseCoordinator?.release(recoveryLease);
            }
        }
    }

    /**
     * Startup entry for interrupted-index recovery. Acquires a mutation lease per
     * root, skips live writers, and reuses the fenced recovery path (no unfenced
     * snapshot lifecycle publication).
     */
    public async recoverInterruptedIndexingAtStartup(): Promise<void> {
        const indexingCodebases = this.getSnapshotIndexingCodebases();
        if (indexingCodebases.length === 0) {
            console.log("[STARTUP] No interrupted indexing states required recovery");
            return;
        }

        let attempted = 0;
        let skippedLive = 0;
        for (const codebasePath of indexingCodebases) {
            const activeLease = await this.recoverStaleIndexingStateIfNeeded(
                codebasePath,
                undefined,
                { skipGrace: true },
            );
            if (activeLease) {
                skippedLive += 1;
                console.log(
                    `[STARTUP] Skipping interrupted indexing recovery for '${codebasePath}': `
                    + `live mutation lease held (action=${activeLease.action}, `
                    + `pid=${activeLease.pid}, generation=${activeLease.generation})`,
                );
                continue;
            }
            attempted += 1;
        }
        console.log(`[STARTUP] Recovery summary: attempted=${attempted}, skippedLiveWriter=${skippedLive}`);
    }

    private buildManageActionBlockedMessage(codebasePath: string, action: RuntimeOwnerMutationAction): string {
        const indexing = this.buildIndexingMetadata(codebasePath);
        const retryAfterMs = this.getManageRetryAfterMs();

        const lines = [
            `Codebase '${codebasePath}' is currently indexing. manage_index action='${action}' is blocked until indexing completes.`,
            'reason=indexing',
            `hints.status=${JSON.stringify(this.buildStatusHint(codebasePath))}`,
            `retryAfterMs=${retryAfterMs}`
        ];

        if (indexing.progressPct !== null) {
            lines.push(`progressPct=${indexing.progressPct}`);
        }
        if (indexing.phase) {
            lines.push(`phase=${indexing.phase}`);
        }
        if (indexing.lastUpdated) {
            lines.push(`lastUpdated=${indexing.lastUpdated}`);
        }

        return lines.join('\n');
    }

    private getManageRetryAfterMs(): number {
        return DEFAULT_MANAGE_RETRY_AFTER_MS;
    }

    private buildStaleLocalHint(codebasePath: string, reason: CompletionProofReason): Record<string, unknown> {
        const preferSync = this.canSyncStaleLocal(codebasePath, reason);
        const preferRepair = !preferSync && reason === "missing_marker_doc";
        return {
            completionProof: reason,
            recommendedAction: preferSync
                ? this.buildSyncHint(codebasePath)
                : preferRepair
                ? this.buildRepairHint(codebasePath)
                : this.buildCreateHint(codebasePath),
            ...(preferSync ? { sync: this.buildSyncHint(codebasePath) } : {}),
            ...(preferRepair ? { create: this.buildCreateHint(codebasePath) } : {})
        };
    }

    private getSnapshotCollectionName(codebasePath: string): string | undefined {
        const fromSnapshot = this.snapshotCapabilities().getCodebaseCollectionName?.(codebasePath);
        if (typeof fromSnapshot === 'string' && fromSnapshot.trim().length > 0) {
            return fromSnapshot.trim();
        }
        const fromInfo = this.getSnapshotCodebaseInfo(codebasePath)?.collectionName;
        return typeof fromInfo === 'string' && fromInfo.trim().length > 0
            ? fromInfo.trim()
            : undefined;
    }

    private canSyncStaleLocal(codebasePath: string, reason: CompletionProofReason): boolean {
        if (reason !== "missing_marker_doc") {
            return false;
        }
        const info = this.getSnapshotCodebaseInfo(codebasePath);
        if (!info || (info.status !== 'indexed' && info.status !== 'sync_completed')) {
            return false;
        }
        if (info.fingerprintSource !== 'verified' || !info.indexFingerprint) {
            return false;
        }
        if (!this.getSnapshotCollectionName(codebasePath)) {
            return false;
        }
        if (!this.fingerprintsEqual(info.indexFingerprint, this.runtimeFingerprint)) {
            return false;
        }
        return true;
    }

    private buildStaleLocalMessage(codebasePath: string, requestedPath: string, reason: CompletionProofReason): string {
        const requestedPathDetail = requestedPath !== codebasePath
            ? ` Requested path: '${requestedPath}'.`
            : '';
        return `Codebase '${codebasePath}' has stale local index metadata; completion proof is missing or invalid (reason: ${reason}).${requestedPathDetail}`;
    }

    private withProofDebugHint<T extends object>(payload: T, proofDebugHint?: CompletionProbeDebugHint): T {
        if (!proofDebugHint) {
            return payload;
        }
        const payloadRecord = payload as Record<string, unknown>;
        const existingHints = payloadRecord.hints && typeof payloadRecord.hints === 'object'
            ? payloadRecord.hints as Record<string, unknown>
            : {};
        return {
            ...payloadRecord,
            hints: {
                ...existingHints,
                debugProofCheck: proofDebugHint
            }
        } as T;
    }

    private async validateCompletionProof(codebasePath: string): Promise<CompletionProofValidationResult> {
        return validateIndexCompletionProof({
            codebasePath,
            runtimeFingerprint: this.runtimeFingerprint,
            getIndexCompletionMarker: getCompletionMarkerReader(this.context),
            onProbeError: (error) => {
                console.warn(`[INDEX-PROOF] Completion marker probe failed for '${codebasePath}': ${formatUnknownError(error)}`);
            }
        });
    }

    private extractIndexedRecoveryFromCompletionProof(
        completionProof: CompletionProofValidationResult
    ): {
        stats: {
            indexedFiles: number;
            totalChunks: number;
            status: 'completed' | 'limit_reached';
        };
        indexFingerprint: IndexFingerprint;
    } | null {
        if (completionProof.outcome !== 'valid' && completionProof.outcome !== 'fingerprint_mismatch') {
            return null;
        }

        const marker = completionProof.marker;
        if (!marker) {
            return null;
        }

        const decision = decideInterruptedIndexingRecovery(
            marker as IndexCompletionMarkerDocument,
            this.runtimeFingerprint,
        );
        if (decision.action !== 'promote_indexed') {
            return null;
        }

        return {
            stats: decision.stats,
            indexFingerprint: decision.indexFingerprint,
        };
    }

    private async recoverIndexedSnapshotFromCompletionProof(
        codebasePath: string,
        completionProof: CompletionProofValidationResult,
        lease: import('./mutation-lease.js').RootMutationLease,
    ): Promise<boolean> {
        const coordinator = this.mutationLeaseCoordinator;
        if (!coordinator) {
            return false;
        }
        if (!coordinator.isLeaseForRoot(lease, codebasePath)) {
            throw new Error(`Completion-proof recovery lease does not own '${codebasePath}'.`);
        }
        const assertCurrent = () => coordinator.assertCurrent(lease);
        assertCurrent();
        const recovered = this.extractIndexedRecoveryFromCompletionProof(completionProof);
        if (!recovered) {
            return false;
        }

        assertCurrent();
        const collectionName = await this.getActiveIndexedCollectionNameForSnapshotRecovery(codebasePath);
        assertCurrent();
        if (!collectionName) {
            return false;
        }
        if (typeof this.snapshotManager.commitCodebaseLifecycleMutation !== 'function') {
            throw new Error('Missing required mutation capability: SnapshotManager.commitCodebaseLifecycleMutation.');
        }
        const committed = this.snapshotManager.commitCodebaseLifecycleMutation(
            () => this.snapshotManager.setCodebaseIndexed(
                codebasePath,
                recovered.stats,
                recovered.indexFingerprint,
                'verified',
                collectionName,
            ),
            assertCurrent,
        );
        if (!committed) {
            throw new Error(`Failed to persist completion-proof recovery for '${codebasePath}'.`);
        }
        return true;
    }

    private async getActiveIndexedCollectionNameForSnapshotRecovery(codebasePath: string): Promise<string | undefined> {
        const context = this.context as unknown as IndexCompletionMarkerContext;
        const resolver = context.getCompletionProofCollectionName ?? context.getActiveIndexedCollectionName;
        if (typeof resolver !== 'function') {
            return undefined;
        }
        const collectionName = await resolver.call(context, codebasePath);
        return typeof collectionName === 'string' && collectionName.trim().length > 0
            ? collectionName.trim()
            : undefined;
    }

    private refreshSnapshotStateFromDisk(): void {
        const snapshotManager = this.snapshotManager as unknown as {
            refreshFromDiskIfChanged?: () => boolean;
        };
        if (typeof snapshotManager.refreshFromDiskIfChanged !== 'function') {
            return;
        }
        snapshotManager.refreshFromDiskIfChanged();
    }

    private isPathWithinCodebase(targetPath: string, rootPath: string): boolean {
        return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
    }

    private getTrackedRootEntryForPath(codebasePath: string): TrackedRootEntry | null {
        const info = this.getSnapshotCodebaseInfo(codebasePath);
        const status = info?.status
            || this.getSnapshotCodebaseStatus(codebasePath);
        if ((!info || typeof info !== 'object') && (!status || status === 'not_found')) {
            return null;
        }
        if (status === 'not_found') {
            return null;
        }
        return {
            path: codebasePath,
            info: info
                ? info as unknown as TrackedCodebaseInfo
                : { status, lastUpdated: new Date(0).toISOString() }
        };
    }

    private async probeLocalSearchCollectionState(codebasePath: string): Promise<{
        state: 'ready' | 'missing' | 'unknown';
        collectionName?: string;
    }> {
        const context = this.context as unknown as {
            getVectorStore?: () => { hasCollection?: (collectionName: string) => Promise<boolean> | boolean };
            getActiveIndexedCollectionName?: (codebasePath: string) => Promise<string | null>;
        };

        if (
            typeof context.getVectorStore !== 'function'
            || typeof context.getActiveIndexedCollectionName !== 'function'
        ) {
            return { state: 'unknown' };
        }

        const vectorStore = context.getVectorStore();
        if (!vectorStore || typeof vectorStore.hasCollection !== 'function') {
            return { state: 'unknown' };
        }

        let collectionName: string | null;
        try {
            const activeCollectionName = await context.getActiveIndexedCollectionName(codebasePath);
            collectionName = typeof activeCollectionName === 'string' && activeCollectionName.trim().length > 0
                ? activeCollectionName.trim()
                : null;
        } catch (error) {
            console.warn(`[SEARCH-READINESS] Failed to resolve collection name for '${codebasePath}': ${formatUnknownError(error)}`);
            return { state: 'unknown' };
        }

        if (!collectionName) {
            return { state: 'missing' };
        }

        try {
            const exists = await vectorStore.hasCollection(collectionName);
            return {
                state: exists ? 'ready' : 'missing',
                collectionName
            };
        } catch (error) {
            console.warn(`[SEARCH-READINESS] Failed to probe collection '${collectionName}' for '${codebasePath}': ${formatUnknownError(error)}`);
            return { state: 'unknown' };
        }
    }

    private summarizeFingerprint(fingerprint: IndexFingerprint): string {
        return summarizeIndexFingerprint(fingerprint);
    }

    private fingerprintsEqual(left: IndexFingerprint, right: IndexFingerprint): boolean {
        return indexFingerprintsEqual(left, right);
    }

    private isRuntimeFingerprintMismatch(diagnostics: FingerprintCompatibilityDiagnostics): boolean {
        return Boolean(
            diagnostics.indexedFingerprint
            && !this.fingerprintsEqual(diagnostics.indexedFingerprint, diagnostics.runtimeFingerprint)
        );
    }

    private buildRuntimeMismatchHint(codebasePath: string, diagnostics: FingerprintCompatibilityDiagnostics): Record<string, unknown> {
        return {
            reason: 'runtime_fingerprint_mismatch',
            indexedFingerprint: diagnostics.indexedFingerprint ? this.summarizeFingerprint(diagnostics.indexedFingerprint) : null,
            runtimeFingerprint: this.summarizeFingerprint(diagnostics.runtimeFingerprint),
            nextStep: `Restart Satori with the indexed fingerprint for '${codebasePath}' to reuse the current index. Reindex only if you intentionally want to migrate the repo to the current runtime.`,
        };
    }

    private buildCompatibilityDiagnostics(codebasePath: string): FingerprintCompatibilityDiagnostics {
        const info = this.getSnapshotCodebaseInfo(codebasePath);
        const statusAtCheck = info?.status
            || this.getSnapshotCodebaseStatus(codebasePath);
        const diagnostics: FingerprintCompatibilityDiagnostics = {
            runtimeFingerprint: this.runtimeFingerprint,
            statusAtCheck
        };

        if (info?.indexFingerprint) {
            diagnostics.indexedFingerprint = info.indexFingerprint;
        }

        if (info?.fingerprintSource) {
            diagnostics.fingerprintSource = info.fingerprintSource;
        }

        if (info?.reindexReason) {
            diagnostics.reindexReason = info.reindexReason;
        }

        if (!diagnostics.reindexReason && this.isRuntimeFingerprintMismatch(diagnostics)) {
            diagnostics.reindexReason = 'fingerprint_mismatch';
        }

        return diagnostics;
    }

    private buildCompatibilityStatusLines(codebasePath: string): string {
        const diagnostics = this.buildCompatibilityDiagnostics(codebasePath);
        let lines = `\n🧬 Runtime fingerprint: ${this.summarizeFingerprint(diagnostics.runtimeFingerprint)}`;
        lines += diagnostics.indexedFingerprint
            ? `\n🧬 Indexed fingerprint: ${this.summarizeFingerprint(diagnostics.indexedFingerprint)}`
            : `\n🧬 Indexed fingerprint: unavailable`;

        if (diagnostics.fingerprintSource) {
            lines += `\n🧬 Fingerprint source: ${diagnostics.fingerprintSource}`;
        }

        if (diagnostics.reindexReason) {
            lines += `\n🧬 Reindex reason: ${diagnostics.reindexReason}`;
        }

        return lines;
    }

    private buildRequiresReindexPayload(
        codebasePath: string,
        detail?: string,
        searchContext?: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        }
    ): Record<string, unknown> {
        return this.toolResponseBuilders.buildRequiresReindexPayload(codebasePath, detail, searchContext);
    }

    private buildRequiresReindexCallGraphPayload(
        codebasePath: string,
        detail: string | undefined,
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        },
        reason: Extract<
            NonOkReason,
            | "requires_reindex"
            | "partial_index_navigation_unavailable"
            | "missing_symbol_registry"
            | "missing_relationship_sidecar"
            | "incompatible_symbol_registry"
            | "incompatible_relationship_sidecar"
        > = "requires_reindex"
    ): CallGraphResponseEnvelope {
        return this.toolResponseBuilders.buildRequiresReindexCallGraphPayload(codebasePath, detail, context, reason);
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
        return this.toolResponseBuilders.buildNotReadySearchPayload(codebasePath, searchContext);
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
        return this.toolResponseBuilders.buildFreshnessBlockedSearchPayload(codebasePath, freshnessDecision, searchContext);
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
        return this.toolResponseBuilders.buildVectorBackendSearchPayload(diagnostic, searchContext);
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
        return this.toolResponseBuilders.buildEmbeddingProviderSearchPayload(diagnostic, searchContext);
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
        return this.toolResponseBuilders.buildInvalidSearchRequestPayload(searchContext, message, status, reason);
    }

    private buildNotReadyFileOutlinePayload(codebasePath: string, file: string, requestedPath: string): FileOutlineResponseEnvelope & Record<string, unknown> {
        return this.toolResponseBuilders.buildNotReadyFileOutlinePayload(codebasePath, file, requestedPath);
    }

    private buildNotIndexedFileOutlinePayload(
        file: string,
        requestedPath: string,
        staleLocal?: { codebaseRoot: string; reason: CompletionProofReason }
    ): FileOutlineResponseEnvelope & Record<string, unknown> {
        return this.toolResponseBuilders.buildNotIndexedFileOutlinePayload(file, requestedPath, staleLocal);
    }

    private buildInvalidFileOutlineRequestPayload(
        requestedPath: string,
        file: string,
        message: string,
        status: FileOutlineStatus = "not_ready",
        reason?: NonOkReason
    ): FileOutlineResponseEnvelope {
        return this.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(requestedPath, file, message, status, reason);
    }

    private buildNotIndexedCallGraphPayload(
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        },
        staleLocal?: { codebaseRoot: string; reason: CompletionProofReason }
    ): CallGraphResponseEnvelope {
        return this.toolResponseBuilders.buildNotIndexedCallGraphPayload(context, staleLocal);
    }

    private buildNotReadyCallGraphPayload(
        codebasePath: string,
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        }
    ): CallGraphResponseEnvelope {
        return this.toolResponseBuilders.buildNotReadyCallGraphPayload(codebasePath, context);
    }

    private buildInvalidCallGraphRequestPayload(
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        },
        message: string,
        status: CallGraphResponseStatus = "not_ready",
        reason?: CallGraphResponseReason
    ): CallGraphResponseEnvelope {
        return this.toolResponseBuilders.buildInvalidCallGraphRequestPayload(context, message, status, reason);
    }

    private getMatchingBlockedRoot(absolutePath: string): { path: string; message?: string } | null {
        const blocked = this.getSnapshotAllCodebases()
            .filter((entry) => entry.info.status === 'requires_reindex');
        if (blocked.length === 0) {
            const directEntry = this.getTrackedRootEntryForPath(absolutePath);
            if (!directEntry || directEntry.info?.status !== 'requires_reindex') {
                return null;
            }
            const gate = this.ensureSnapshotFingerprintCompatibility(absolutePath);
            if (gate.changed) {
                this.saveSnapshotIfSupported();
            }
            if (gate.allowed === true && gate.changed === true) {
                return null;
            }
            return {
                path: absolutePath,
                message: typeof directEntry.info.message === 'string' ? directEntry.info.message : undefined
            };
        }

        blocked.sort((a, b) => b.path.length - a.path.length);
        const match = blocked.find((entry) => {
            if (!(absolutePath === entry.path || absolutePath.startsWith(`${entry.path}${path.sep}`))) {
                return false;
            }
            const gate = this.ensureSnapshotFingerprintCompatibility(entry.path);
            if (gate.changed) {
                this.saveSnapshotIfSupported();
            }
            // A requires_reindex snapshot state is blocked by default. The only legal
            // escape hatch is when the access gate actively recovers a resolved
            // fingerprint mismatch and reports allowed=true together with changed=true.
            return !(gate.allowed === true && gate.changed === true);
        });
        if (!match) {
            return null;
        }

        const message = 'message' in match.info && typeof match.info.message === 'string'
            ? match.info.message
            : undefined;
        return {
            path: match.path,
            message
        };
    }

    private enforceFingerprintGate(codebasePath: string): { blockedResponse?: ToolTextResponse; message?: string; reason?: AccessGateReason } {
        const gate = this.ensureSnapshotFingerprintCompatibility(codebasePath);
        if (!gate.allowed) {
            if (gate.changed) {
                this.saveSnapshotIfSupported();
            }
            return {
                reason: gate.reason,
                message: gate.message,
                blockedResponse: {
                    content: [{
                        type: "text",
                        text: this.buildReindexInstruction(codebasePath, gate.message)
                    }],
                    isError: true
                }
            };
        }

        if (gate.changed) {
            this.saveSnapshotIfSupported();
        }

        return {};
    }

    private normalizeSearchPath(relativePath: string): string {
        return normalizeSearchPathHelper(relativePath);
    }

    private hasPathSegment(normalizedPath: string, segment: string): boolean {
        return hasSearchPathSegment(normalizedPath, segment);
    }

    private isTestPath(normalizedPath: string): boolean {
        return isSearchTestPath(normalizedPath);
    }

    private isDocPath(normalizedPath: string): boolean {
        return isSearchDocPath(normalizedPath);
    }

    private isGeneratedPath(normalizedPath: string): boolean {
        return isSearchGeneratedPath(normalizedPath);
    }

    private isFixturePath(normalizedPath: string): boolean {
        return isSearchFixturePath(normalizedPath);
    }

    private classifyPathCategory(relativePath: string): PathCategory {
        return classifyPathCategory(relativePath);
    }

    private parseGitStatusChangedPaths(
        stdout: string,
        options: { includeUntracked?: boolean } = {}
    ): Set<string> {
        return parseGitStatusChangedPathsHelper(stdout, options);
    }

    private getChangedFilesForCodebase(codebasePath: string): { available: boolean; files: Set<string> } {
        return getChangedFilesForCodebaseHelper({
            codebasePath,
            nowMs: this.now(),
            changedFilesCache: this.changedFilesCache,
            ttlMs: SEARCH_CHANGED_FILES_CACHE_TTL_MS,
        });
    }

    private getWorkingTreeChangedPathsForPreflight(codebasePath: string): { available: boolean; probeFailed: boolean; files: Set<string> } {
        return getWorkingTreeChangedPathsForPreflightHelper(codebasePath);
    }

    private evaluateReindexPreflight(codebasePath: string): ReindexPreflightResult {
        return evaluateReindexPreflightHelper({
            codebasePath,
            currentStatus: this.getSnapshotCodebaseStatus(codebasePath),
            ensureFingerprintCompatibility: (value) => this.ensureSnapshotFingerprintCompatibility(value),
            getWorkingTreeChangedPathsForPreflight: (value) => this.getWorkingTreeChangedPathsForPreflight(value),
        });
    }

    private parseIndexedAtMs(indexedAt?: string): number | undefined {
        if (!indexedAt) return undefined;
        const parsed = Date.parse(indexedAt);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private shouldIncludeCategoryInScope(scope: SearchScope, category: PathCategory): boolean {
        return shouldIncludeCategoryInScope(scope, category);
    }

    private sortGroupedSearchResults<T extends SearchGroupResult & { __exactLexicalMatch: boolean }>(
        results: T[],
        exactMatchPinningEnabled: boolean,
    ): boolean {
        return sortGroupedSearchResultsHelper(results, exactMatchPinningEnabled);
    }

    private isCallGraphLanguageSupported(language: string, file?: string): boolean {
        if (isLanguageCapabilitySupportedForLanguage(language, 'callGraphQuery')) {
            return true;
        }

        if (typeof file === 'string') {
            const ext = path.extname(file).toLowerCase();
            return isLanguageCapabilitySupportedForExtension(ext, 'callGraphQuery');
        }

        return false;
    }

    private isFileOutlineLanguageSupported(file: string): boolean {
        return isLanguageCapabilitySupportedForFilename(file, 'fileOutline');
    }

    private isPartialIndexNavigationUnavailable(info: unknown): boolean {
        return isRecord(info) && info.indexStatus === 'limit_reached';
    }

    private async loadRegistryValidatedCallGraphSidecar(input: {
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
    }> {
        if (!input.registryManifestHash) {
            return {
                relationshipReady: false,
                relationshipUnavailableReason: input.registryUnavailableReason || 'missing_symbol_registry',
            };
        }

        const compatibility = input.preparedRead
            ? await this.loadPreparedNavigationCompatibility(
                input.preparedRead,
                input.registryManifestHash,
                input.operations,
            )
            : await this.navigationStore.getCompatibilityState({
                normalizedRootPath: input.codebaseRoot,
                expectedSymbolRegistryManifestHash: input.registryManifestHash,
            });
        if (compatibility.relationships.status !== 'ok') {
            const relationshipUnavailableReason = compatibility.relationships.status === 'missing'
                ? 'missing_relationship_sidecar'
                : 'incompatible_relationship_sidecar';
            return {
                relationshipReady: false,
                relationshipUnavailableReason,
                warning: `RELATIONSHIP_SIDECAR_UNAVAILABLE:${compatibility.relationships.status}`,
            };
        }

        return {
            relationshipReady: true,
            relationshipBuiltAt: compatibility.relationships.manifest.builtAt,
        };
    }

    private sanitizeIndexedRelativeFilePath(relativeFilePath: string): string | undefined {
        const normalized = this.normalizeRelativeFilePath(relativeFilePath);
        if (
            !normalized
            || normalized.includes("\0")
            || path.isAbsolute(normalized)
            || path.win32.isAbsolute(normalized)
            || /^[A-Za-z]:/.test(normalized)
        ) {
            return undefined;
        }
        const compact = path.posix.normalize(normalized).replace(/^\.\/+/, '').trim();
        if (!compact || compact === '..' || compact.startsWith('../')) {
            return undefined;
        }
        return compact;
    }

    private resolveSearchOwnerFromRegistry(result: SearchResultLike, registry?: SymbolRegistry, plan?: SearchQueryPlan): SearchOwnerResolution {
        return resolveSearchOwnerFromRegistryWithRepair({
            result,
            registry,
            lexicalTerms: plan?.lexicalTerms,
            sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => this.sanitizeIndexedRelativeFilePath(relativeFilePath),
            hasTokenBoundaryMatch: (haystack: string, needle: string) => this.searchQuerySupport.hasTokenBoundaryMatch(haystack, needle),
            isWriterActionTerm: (value: string) => isWriterActionTermHelper(value),
        });
    }

    private getSearchNavigationHelpers() {
        return {
            now: () => this.now(),
            sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => this.sanitizeIndexedRelativeFilePath(relativeFilePath),
            isCallGraphLanguageSupported: (language: string, file: string) => this.isCallGraphLanguageSupported(language, file),
            getOutlineStatusForLanguage: (relativeFilePath: string) => this.getOutlineStatusForLanguage(relativeFilePath),
        };
    }

    private buildChangedCodeDebug(
        codebaseRoot: string,
        changedFilesState: { available: boolean; files: Set<string> }
    ): SearchDebugHint['changedCode'] | undefined {
        return buildSearchChangedCodeDebug({
            sidecar: this.callGraphManager.loadSidecar(codebaseRoot),
            changedFilesState,
            normalizeRelativeFilePath: (relativeFilePath: string) => this.normalizeRelativeFilePath(relativeFilePath),
            normalizeSearchSymbolLabel: (label) => normalizeSearchSymbolLabelHelper(label),
            compareNullableStringsAsc: compareNullableStringsAscHelper,
            compareNullableNumbersAsc: compareNullableNumbersAscHelper,
            maxFiles: SEARCH_DEBUG_CHANGED_CODE_MAX_FILES,
            maxSymbols: SEARCH_DEBUG_CHANGED_CODE_MAX_SYMBOLS,
            maxDirectCallers: SEARCH_DEBUG_CHANGED_CODE_MAX_DIRECT_CALLERS,
        });
    }

    private buildGeneratedArtifactsVerificationHint(
        codebaseRoot: string,
        results: Array<{ file: string; span: SearchSpan }>
    ): NonNullable<NonNullable<SearchResponseEnvelope['hints']>['verification']>['generatedArtifacts'] | undefined {
        return buildSearchGeneratedArtifactsVerificationHint({
            codebaseRoot,
            results,
            sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => this.sanitizeIndexedRelativeFilePath(relativeFilePath),
            isGeneratedFile: (relativeFilePath: string) => this.searchQuerySupport.classifyNoiseCategory(relativeFilePath) === 'generated',
        });
    }

    private normalizeRelativeFilePath(relativeFilePath: string): string {
        return relativeFilePath.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
    }

    private buildRequiresReindexFileOutlinePayload(
        codebasePath: string,
        input: FileOutlineInput,
        detail?: string,
        reason: NonOkReason = 'requires_reindex'
    ): FileOutlineResponseEnvelope {
        const detailLine = detail ? `${detail}\n\n` : '';
        const preferRepair = reason === 'missing_symbol_registry' || reason === 'missing_relationship_sidecar';
        return {
            status: 'requires_reindex',
            reason,
            path: codebasePath,
            file: input.file,
            outline: null,
            hasMore: false,
            message: preferRepair
                ? `${detailLine}Relationship-backed navigation sidecars are missing. Please run manage_index with {"action":"repair","path":"${codebasePath}"}.`
                : `${detailLine}Relationship-backed navigation sidecars are missing or incompatible. Please run manage_index with {"action":"reindex","path":"${codebasePath}"}.`,
            hints: {
                ...(preferRepair ? { repair: this.buildRepairHint(codebasePath) } : {}),
                reindex: this.buildReindexHint(codebasePath)
            }
        };
    }

    private buildStaleSymbolRefFileOutlinePayload(
        codebasePath: string,
        input: FileOutlineInput,
        detail?: string
    ): FileOutlineResponseEnvelope {
        const detailLine = detail ? `${detail}\n\n` : '';
        return {
            status: 'requires_reindex',
            reason: 'stale_symbol_ref',
            path: codebasePath,
            file: input.file,
            outline: null,
            hasMore: false,
            message: `${detailLine}Symbol navigation for '${input.file}' is stale relative to the current file contents. Refresh the index before using exact symbol navigation.`,
            hints: {
                reindex: this.buildReindexHint(codebasePath)
            }
        };
    }

    private isSha256HexHash(value: unknown): value is string {
        return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
    }

    private getRegistryFileFreshness(input: {
        symbols: SymbolRecord[];
        absoluteFile: string;
    }): { status: 'fresh' | 'stale' | 'unknown' | 'inconsistent'; registryHash?: string; currentHash?: string } {
        const hashes = Array.from(new Set(input.symbols.map((symbol) => symbol.fileHash).filter(Boolean)));
        if (hashes.length === 0 || hashes.some((hash) => !this.isSha256HexHash(hash))) {
            return { status: 'unknown' };
        }
        if (hashes.length !== 1) {
            return { status: 'inconsistent' };
        }

        const registryHash = hashes[0];
        const sourceBytes = fs.readFileSync(input.absoluteFile);
        const sourceObservation = beginSourceMeasurementObservation({
            owner: sourceIoOwnerForCurrentOperation('outline'),
            filePath: input.absoluteFile,
            logicalBytesRequested: sourceBytes.length,
            scanKind: 'complete',
        });
        recordSourceIo({
            observation: sourceObservation,
            startByte: 0,
            endByte: sourceBytes.length,
            basis: 'path_read',
        });
        finishSourceMeasurementObservation({
            observation: sourceObservation,
            status: 'completed',
        });
        const hashingStartedAt = performance.now();
        let hashingOutcome: 'success' | 'failed' = 'failed';
        let currentHash: string;
        try {
            currentHash = crypto
                .createHash('sha256')
                .update(sourceBytes.toString('utf8'), 'utf8')
                .digest('hex');
            hashingOutcome = 'success';
        } finally {
            recordSourceProcessing({
                observation: sourceObservation,
                owner: 'hashing',
                inputBytesProcessed: sourceBytes.length,
                basis: 'shared_buffer',
                outcome: hashingOutcome,
                durationMs: performance.now() - hashingStartedAt,
            });
        }
        return currentHash === registryHash
            ? { status: 'fresh', registryHash, currentHash }
            : { status: 'stale', registryHash, currentHash };
    }

    private buildStaleSymbolRefCallGraphPayload(input: {
        codebaseRoot: string;
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        };
        message: string;
    }): CallGraphResponseEnvelope {
        return {
            status: 'not_found',
            path: input.codebaseRoot,
            symbolRef: input.context.symbolRef,
            direction: input.context.direction,
            depth: input.context.depth,
            limit: input.context.limit,
            supported: false,
            reason: 'stale_symbol_ref',
            message: input.message,
            nodes: [],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
        };
    }

    private getOutlineStatusForLanguage(relativeFilePath: string): FileOutlineStatus {
        if (this.isFileOutlineLanguageSupported(relativeFilePath)) {
            return 'ok';
        }
        return 'unsupported';
    }

    private buildRegistrySymbolCallGraphHint(
        symbol: SymbolRecord,
        file: string,
        navigationState: {
            relationshipReady: boolean;
            relationshipBuiltAt?: string;
            relationshipUnavailableReason?: CallGraphUnavailableReason;
        }
    ): CallGraphHint {
        return buildSearchRegistrySymbolCallGraphHint(symbol, file, navigationState, this.getSearchNavigationHelpers());
    }

    private buildOutlineSpanWarningCodes(repair: PythonSourceBackedSpanRepair | undefined): string[] {
        return buildSearchOutlineSpanWarningCodes(repair);
    }

    private isSearchPassFaultInjectionEnabled(): boolean {
        return process.env.NODE_ENV === 'test';
    }

    private getForcedFailedSearchPassId(): 'primary' | 'expanded' | 'both' | undefined {
        if (!this.isSearchPassFaultInjectionEnabled()) {
            return undefined;
        }

        const raw = typeof process.env.SATORI_TEST_FAIL_SEARCH_PASS === 'string'
            ? process.env.SATORI_TEST_FAIL_SEARCH_PASS.trim().toLowerCase()
            : '';
        if (raw === 'primary' || raw === 'expanded' || raw === 'both') {
            return raw;
        }
        return undefined;
    }

    private shouldForceSearchPassFailure(passId: 'primary' | 'expanded'): boolean {
        const forced = this.getForcedFailedSearchPassId();
        if (!forced) {
            return false;
        }
        return forced === 'both' || forced === passId;
    }

    private async buildRelationshipBackedCallGraph(input: {
        codebaseRoot: string;
        registry: SymbolRegistry;
        registryManifestHash: string;
        resolvedSymbol: SymbolRecord;
        sourceSpanRepair?: PythonSourceBackedSpanRepair;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
    }): Promise<{
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
    } | null> {
        return this.relationshipBackedCallGraph.build(input);
    }

    private async rebuildCallGraphForIndex(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        effectiveIgnorePatterns?: string[],
    ): Promise<void> {
        await this.relationshipBackedCallGraph.rebuildForIndex(
            codebasePath,
            assertMutationCurrent,
            effectiveIgnorePatterns,
        );
    }

    private async rebuildCallGraphForSyncDelta(codebasePath: string, changedFiles: string[]): Promise<boolean> {
        return this.relationshipBackedCallGraph.rebuildForSyncDelta(codebasePath, changedFiles);
    }

    private isZillizBackend(): boolean {
        return this.vectorBackendMaintenance.isZillizBackend();
    }

    private async buildCollectionLimitMessage(targetCodebasePath: string): Promise<string> {
        return this.vectorBackendMaintenance.buildCollectionLimitMessage(targetCodebasePath);
    }

    private async dropZillizCollectionForCreate(
        collectionName: string,
        createLease?: import("./mutation-lease.js").RootMutationLease,
    ) {
        return this.vectorBackendMaintenance.dropZillizCollectionForCreate(collectionName, createLease);
    }

    public async handleIndexCodebase(args: IndexCodebaseArgs) {
        return this.manageIndexingHandlers.handleIndexCodebase(args);
    }

    public async handleReindexCodebase(args: ReindexCodebaseArgs) {
        return this.manageIndexingHandlers.handleReindexCodebase(args);
    }

    public async handleRepairIndex(args: ToolArgs) {
        return this.manageIndexingHandlers.handleRepairIndex(args);
    }

    public async handleSearchCode(args: ToolArgs) {
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
            limit: Number.isFinite(rawLimit) ? Math.max(1, rawLimit) : 10,
            ...(Number.isFinite(rawDisclosureLimit)
                ? { disclosureLimit: rawDisclosureLimit }
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

        const isDebugCandidateLimitValid = input.debugCandidateLimit === undefined
            || (debugMode === 'full'
                && Number.isInteger(input.debugCandidateLimit)
                && input.debugCandidateLimit <= SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE);
        const isDisclosureLimitValid = input.disclosureLimit === undefined
            || (input.resultMode === 'grouped'
                && Number.isInteger(input.disclosureLimit)
                && input.disclosureLimit > 0
                && input.disclosureLimit <= input.limit);

        if (!isScopeValid || !isResultModeValid || !isGroupByValid || !isRankingModeValid || !isDebugCandidateLimitValid || !isDisclosureLimitValid || typeof input.query !== 'string' || input.query.trim().length === 0) {
            const payload = this.buildInvalidSearchRequestPayload({
                path: typeof input.path === 'string' ? input.path : '',
                query: typeof input.query === 'string' ? input.query : '',
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit
            }, 'Invalid search arguments. Required: path, query. Valid scope: runtime|mixed|docs. Valid resultMode: grouped|raw. Valid groupBy: symbol|file. Valid rankingMode: default|auto_changed_first. disclosureLimit is a grouped-result integer no greater than limit. debugCandidateLimit is an integer from 1 to 160 and requires debugMode=full.');
            return {
                content: [{ type: "text", text: this.stringifyToolJson(payload) }],
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
                trackedRootReadiness: this.trackedRootReadiness,
                prepareInitialTrackedRootRead: async (absolutePath) => {
                    const cached = await this.getCachedPreparedRead(absolutePath, readinessDebug.operations);
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
                    const trackedRootState = await this.prepareTrackedRootReadWithObservation(
                        absolutePath,
                        (phase, durationMs) => {
                            phaseTimings[readinessPhaseToSearchPhase[phase]] += durationMs;
                        },
                    );
                    if (trackedRootState.state === "ready") {
                        readinessDebug.operations.exactPayloadRecounts += trackedRootState.exactPayloadRecounts ?? 0;
                        if (debugMode === 'full') {
                            const sourceObservation = this.getPreparedReadCacheObservation(trackedRootState.root.path);
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
                            const trackedRootState = await this.prepareTrackedRootReadWithObservation(
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
                getPreparedReadObservation: (canonicalRoot) => this.getPreparedAuthorityObservation(canonicalRoot),
                ensureSearchFreshness: (effectiveRoot, preparedRead) => this.measureSearchPhase(
                    phaseTimings,
                    'ensureFreshness',
                    // Status-prepared proof reuse is one-shot and already compared the
                    // complete local authority/source observation. It does not claim a
                    // new filesystem comparison; the existing source warning remains.
                    () => preparedRead?.statusPrepared === true
                        ? Promise.resolve({
                            mode: 'skipped_recent' as const,
                            checkedAt: new Date(this.now()).toISOString(),
                            thresholdMs: SEARCH_FRESHNESS_THRESHOLD_MS,
                        })
                        : this.syncManager.ensureFreshness(
                            effectiveRoot,
                            SEARCH_FRESHNESS_THRESHOLD_MS,
                            preparedRead?.vectorReceipt
                                ? { preparedVectorReceipt: preparedRead.vectorReceipt }
                                : {},
                        ),
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
                buildRequiresReindexPayload: (codebasePath, detail, searchContext) => this.buildRequiresReindexPayload(
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
                buildManageIndexRecommendedAction: (action, codebasePath, rationale) => this.buildManageIndexRecommendedAction(
                    action,
                    codebasePath,
                    rationale
                ),
                buildCreateHint: (codebasePath) => this.buildCreateHint(codebasePath),
                buildSyncHint: (codebasePath) => this.buildSyncHint(codebasePath),
                buildRepairHint: (codebasePath) => this.buildRepairHint(codebasePath),
                buildStaleLocalHint: (codebasePath, reason) => this.buildStaleLocalHint(codebasePath, reason),
                buildStaleLocalMessage: (codebasePath, requestedPath, reason) => this.buildStaleLocalMessage(
                    codebasePath,
                    requestedPath,
                    reason
                ),
                canSyncStaleLocal: (codebasePath, reason) => this.canSyncStaleLocal(codebasePath, reason),
                withProofDebugHint: (payload, proofDebugHint) => this.withProofDebugHint(payload, proofDebugHint),
                isPartialIndexNavigationUnavailable: (info) => this.isPartialIndexNavigationUnavailable(info),
                partialIndexWarnings: [
                    SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING,
                    SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING,
                ],
            });

            if (frontDoor.kind === 'blocked') {
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(frontDoor.payload) }],
                    ...(frontDoor.isError ? { isError: true } : {}),
                    meta: { searchDiagnostics }
                };
            }

            const {
                absolutePath,
                searchableRoot,
                effectiveRoot,
                proofDebugHint,
                partialIndexSearchWarnings: frontDoorWarnings,
                freshnessDecision,
                vectorReceipt,
                generationReceipt,
                navigationStatus,
                preparedObservation,
            } = frontDoor;
            const finalSourceObservation = this.getPreparedReadCacheObservation(effectiveRoot);
            if (debugMode === 'full' && finalSourceObservation.unavailableReason) {
                readinessDebug.observationUnavailableReason = finalSourceObservation.unavailableReason;
            }
            if (debugMode === 'full') {
                const getPreparedReadDiagnostics = (
                    this.syncManager as SyncManager & {
                        getPreparedReadDiagnostics?: SyncManager['getPreparedReadDiagnostics'];
                    }
                ).getPreparedReadDiagnostics;
                if (typeof getPreparedReadDiagnostics === 'function') {
                    readinessDebug.watcher = getPreparedReadDiagnostics.call(
                        this.syncManager,
                        effectiveRoot,
                    );
                }
            }
            const sourceFreshnessWasEstablished = freshnessDecision.mode === 'synced'
                || freshnessDecision.mode === 'reconciled_ignore_change';
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
            const encoderEngine = this.context.getEmbeddingEngine();
            const rootTag = `[SEARCH][root=${effectiveRoot}]`;
            const requestId = crypto.randomUUID();
            console.log(`${rootTag} Searching (requestedPath='${absolutePath}')`);
            console.log(`${rootTag} Query metadata: length=${input.query.length}, requestId=${requestId}`);
            console.log(`${rootTag} Indexing status: Completed`);
            console.log(`${rootTag} 🧠 Using embedding provider: ${encoderEngine.getProvider()} for search`);

            const parsedOperators = this.searchQuerySupport.parseSearchOperators(input.query);
            const semanticQuery = parsedOperators.semanticQuery;
            const queryPlan = this.searchQuerySupport.buildSearchQueryPlan(semanticQuery, parsedOperators);
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
                removedByScope: 0,
                removedByLanguage: 0,
                removedByPathInclude: 0,
                removedByPathExclude: 0,
                removedByMust: 0,
                removedByExclude: 0,
            };
            const initialOperatorSummary = this.searchQuerySupport.buildOperatorSummary(parsedOperators);
            const initialObservedChangedFilesState = this.getChangedFilesForCodebase(effectiveRoot);
            const initialChangedFilesState = input.rankingMode === 'auto_changed_first'
                ? initialObservedChangedFilesState
                : { available: initialObservedChangedFilesState.available, files: new Set<string>() };
            const initialDebugChangedFilesState = debugMode === 'freshness' || debugMode === 'full'
                ? initialObservedChangedFilesState
                : undefined;
            const initialChangedFilesCount = initialChangedFilesState.files.size;
            const initialObservedChangedFilesCount = initialObservedChangedFilesState.files.size;
            const initialChangedFilesBoostSkippedForLargeChangeSet = input.rankingMode === 'auto_changed_first'
                && initialChangedFilesState.available
                && initialChangedFilesCount > SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES;
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
                proofDebugHint,
                vectorReceipt,
                generationReceipt,
                navigationStatus,
                preparedObservation,
            };
            if (
                preparedObservation
                && this.getPreparedAuthorityObservation(effectiveRoot) !== preparedObservation
            ) {
                this.evictPreparedRead(effectiveRoot);
                const payload = this.buildNotReadySearchPayload(effectiveRoot, {
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit,
                });
                return {
                    content: [{ type: 'text', text: this.stringifyToolJson(payload) }],
                    meta: { searchDiagnostics },
                };
            }
            const exactFastPath = await runExactRegistryFastPath({
                absolutePath,
                effectiveRoot,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit,
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
                loadRegistryManifest: () => this.loadPreparedNavigationManifest(
                    preparedReadState,
                    readinessDebug.operations,
                ),
                loadRegistryValidatedCallGraphSidecar: (exactInput) => this.loadRegistryValidatedCallGraphSidecar({
                    ...exactInput,
                    preparedRead: preparedReadState,
                    operations: readinessDebug.operations,
                }),
                buildRelationshipBackedCallGraph: (exactInput) => this.buildRelationshipBackedCallGraph(exactInput),
                buildChangedCodeDebug: (codebaseRoot, changedFilesState) => this.buildChangedCodeDebug(codebaseRoot, changedFilesState),
                buildGeneratedArtifactsVerificationHint: (codebaseRoot, results) => this.buildGeneratedArtifactsVerificationHint(codebaseRoot, results),
                getSearchNavigationHelpers: () => this.getSearchNavigationHelpers(),
                now: this.now,
            });
            let exactRegistryDebug: ExactRegistryLookupDebug | undefined = exactFastPath.exactRegistryDebug;
            let searchSymbolRegistry: SymbolRegistry | undefined = exactFastPath.searchSymbolRegistry;
            let searchSymbolRegistryManifestHash: string | undefined = exactFastPath.searchSymbolRegistryManifestHash;
            let exactRegistryFallbackForTrackedLexical = exactFastPath.exactRegistryFallbackForTrackedLexical;

            if (exactFastPath.kind === 'handled') {
                await this.touchWatchedCodebaseBestEffort(effectiveRoot);
                this.seedPreparedRead(preparedReadState, preservePreparedProofAge);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(exactFastPath.envelope) }],
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
                preparedObservation
                && this.getPreparedAuthorityObservation(effectiveRoot) !== preparedObservation
            ) {
                this.evictPreparedRead(effectiveRoot);
                const payload = this.buildNotReadySearchPayload(effectiveRoot, {
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit,
                });
                return {
                    content: [{ type: 'text', text: this.stringifyToolJson(payload) }],
                    meta: { searchDiagnostics },
                };
            }

            const execution = await runSearchExecution({
                effectiveRoot,
                scope: input.scope,
                rankingMode: input.rankingMode,
                limit: input.limit,
                debugMode,
                semanticQuery,
                parsedOperators,
                queryPlan,
                exactRegistryEligible: exactRegistryFallbackForTrackedLexical,
                exactRegistryFallbackForTrackedLexical,
                freshnessMode: freshnessDecision.mode,
                observedChangedFilesState: initialObservedChangedFilesState,
                retrievalPolicy,
            }, {
                searchQuerySupport: this.searchQuerySupport,
                semanticSearch: (request) => {
                    const lifecycle = this.contextLifecycle();
                    if (
                        vectorReceipt
                        && debugMode === 'full'
                        && lifecycle.semanticSearchWithCandidateTraceInProvenGeneration
                    ) {
                        return lifecycle.semanticSearchWithCandidateTraceInProvenGeneration(
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
                    return vectorReceipt
                        ? lifecycle.semanticSearchInProvenGeneration!(vectorReceipt, request)
                        : this.context.semanticSearch(request);
                },
                reranker: this.reranker,
                shouldForceSearchPassFailure: (passId) => this.shouldForceSearchPassFailure(passId),
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
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
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
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
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
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
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
                loadRegistryManifest: () => this.loadPreparedNavigationManifest(
                    preparedReadState,
                    readinessDebug.operations,
                ),
                loadRegistryValidatedCallGraphSidecar: (finalizationInput) => this.loadRegistryValidatedCallGraphSidecar({
                    ...finalizationInput,
                    preparedRead: preparedReadState,
                    operations: readinessDebug.operations,
                }),
                buildRequiresReindexPayload: (codebasePath, detail, searchContext) => this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope,
                buildChangedCodeDebug: (codebaseRoot, changedFilesState) => this.buildChangedCodeDebug(codebaseRoot, changedFilesState),
                buildGeneratedArtifactsVerificationHint: (codebaseRoot, results) => this.buildGeneratedArtifactsVerificationHint(codebaseRoot, results),
                getSearchNavigationHelpers: () => this.getSearchNavigationHelpers(),
                parseIndexedAtMs: (indexedAt?: string) => this.parseIndexedAtMs(indexedAt),
                resolveSearchOwnerFromRegistry: (result, registry, plan) => this.resolveSearchOwnerFromRegistry(result, registry, plan),
                now: this.now,
            });
            let envelope = finalized.envelope;
            if (
                finalized.resultSet
                && envelope.resultMode === "grouped"
                && envelope.continuation
            ) {
                if (!vectorReceipt || !preparedObservation) {
                    throw new Error("Search continuation requires a proven publication and source observation.");
                }
                const baseEnvelopeDraft: Partial<SearchGroupedResponseEnvelope> = structuredClone(envelope);
                const resultSpecificHints = baseEnvelopeDraft.hints;
                delete baseEnvelopeDraft.results;
                delete baseEnvelopeDraft.disclosure;
                delete baseEnvelopeDraft.continuation;
                delete baseEnvelopeDraft.recommendedNextAction;
                delete baseEnvelopeDraft.hints;
                const frozenHints = freezeContinuationHints(resultSpecificHints);
                const baseEnvelope = {
                    ...baseEnvelopeDraft,
                    ...(frozenHints ? { hints: frozenHints } : {}),
                } as FrozenSearchResultSet["baseEnvelope"];
                const queryPolicyDigest = crypto.createHash("sha256").update(JSON.stringify([
                    input.query,
                    input.scope,
                    input.groupBy,
                    input.rankingMode,
                    retrievalPolicy,
                    queryPlan,
                ]), "utf8").digest("hex");
                const stored = this.searchContinuationCoordinator.store(this, {
                    value: {
                        canonicalRoot: effectiveRoot,
                        vectorReceipt,
                        ...(generationReceipt ? { generationReceipt } : {}),
                        preparedObservation,
                        sourceObservation: finalSourceObservation.sourceObservation,
                        queryPolicyDigest,
                        responseByteLimit: debugMode === "full"
                            ? SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES
                            : SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES,
                        pageSize: retrievalPolicy.disclosureResultLimit,
                        baseEnvelope,
                        orderedResults: [...finalized.resultSet.orderedResults],
                        recommendedActions: [...finalized.resultSet.recommendedActions],
                    },
                    nextOffset: finalized.resultSet.initialReturnedCount,
                    nowMs: this.now(),
                });
                envelope = {
                    ...envelope,
                    continuation: {
                        ...envelope.continuation,
                        handle: stored.handle,
                    },
                };
            }

            await this.touchWatchedCodebaseBestEffort(effectiveRoot);
            this.seedPreparedRead(preparedReadState, preservePreparedProofAge);
            return {
                content: [{ type: "text", text: this.stringifyToolJson(envelope) }],
                meta: { searchDiagnostics }
            };
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
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
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
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
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
                content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                isError: true
            };
        }
    }

    public async handleContinueSearch(args: ToolArgs) {
        return this.handleContinueSearchOwned(args);
    }

    private async handleContinueSearchOwned(
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
                text: this.stringifyToolJson({ status: "not_ready", code, message }),
            }],
            isError: true,
        });
        if (!/^[a-f0-9]{48}$/.test(handle)) {
            return fail("SEARCH_RESULT_SET_HANDLE_INVALID", "Search continuation handle is invalid.");
        }
        if (
            !Number.isSafeInteger(expectedOffset)
            || expectedOffset < 0
            || expectedOffset > this.capabilities.getMaxSearchLimit()
        ) {
            return fail(
                "SEARCH_RESULT_SET_OFFSET_INVALID",
                `Search continuation expectedOffset must be an integer from 0 to ${this.capabilities.getMaxSearchLimit()}.`,
            );
        }
        if (
            args.limit !== undefined
            && (!Number.isSafeInteger(requestedLimit)
                || requestedLimit <= 0
                || requestedLimit > this.capabilities.getMaxSearchLimit())
        ) {
            return fail(
                "SEARCH_RESULT_SET_LIMIT_INVALID",
                `Search continuation limit must be an integer from 1 to ${this.capabilities.getMaxSearchLimit()}.`,
            );
        }

        const nowMs = this.now();
        const lookup = routedLookup ?? this.searchContinuationCoordinator.lookup(handle, nowMs);
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
            return lookup.owner.handleContinueSearchOwned(args, lookup);
        }

        const entry = lookup.entry;
        const observationBefore = this.getPreparedReadCacheObservation(entry.canonicalRoot);
        const revalidate = this.contextLifecycle().revalidatePreparedGeneration;
        if (
            !observationBefore.observation
            || observationBefore.observation !== entry.preparedObservation
            || observationBefore.sourceObservation !== entry.sourceObservation
            || typeof revalidate !== "function"
        ) {
            this.searchContinuationCoordinator.remove(handle);
            return fail("SEARCH_RESULT_SET_STALE", "Search publication or source observation changed. Run search_codebase again.");
        }
        const proof = await revalidate.call(this.context, entry.canonicalRoot, entry.vectorReceipt, {
            ...(entry.generationReceipt ? { priorGenerationReceipt: entry.generationReceipt } : {}),
        }).catch(() => null);
        const observationAfter = this.getPreparedReadCacheObservation(entry.canonicalRoot);
        if (
            !proof
            || proof.navigationProof.status === "requires_reindex"
            || proof.navigationProof.status === "unsupported"
            || observationAfter.observation !== observationBefore.observation
            || observationAfter.sourceObservation !== observationBefore.sourceObservation
        ) {
            this.searchContinuationCoordinator.remove(handle);
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
                const recommendedNextAction = entry.recommendedActions[lookup.nextOffset] ?? null;
                const noiseMitigationHint = this.searchQuerySupport.buildNoiseMitigationHint(
                    entry.canonicalRoot,
                    results.map((result) => result.target.file),
                    entry.baseEnvelope.scope,
                );
                const generatedArtifactsHint = this.buildGeneratedArtifactsVerificationHint(
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
                    ...(Object.keys(pageHints).length > 0 ? { hints: pageHints } : {}),
                    ...(recommendedNextAction ? { recommendedNextAction } : {}),
                    ...(disclosure ? { disclosure } : {}),
                    results: [...results],
                };
                return results.length < remainingResults.length
                    ? {
                        ...envelope,
                        continuation: {
                            handle,
                            nextOffset: lookup.nextOffset + results.length,
                            remainingGroupCount: remainingResults.length - results.length,
                        },
                    }
                    : envelope;
            },
        });
        if (projection.results.length === 0) {
            return fail("SEARCH_RESULT_SET_PAGE_TOO_LARGE", "The next search result cannot fit within the response byte budget. Use read_file on an earlier target or run a narrower search.");
        }
        const proofAfterProjection = await revalidate.call(
            this.context,
            entry.canonicalRoot,
            entry.vectorReceipt,
            {
                ...(entry.generationReceipt
                    ? { priorGenerationReceipt: entry.generationReceipt }
                    : {}),
            },
        ).catch(() => null);
        const observationAfterProjection = this.getPreparedReadCacheObservation(entry.canonicalRoot);
        if (
            !proofAfterProjection
            || proofAfterProjection.navigationProof.status === "requires_reindex"
            || proofAfterProjection.navigationProof.status === "unsupported"
            || observationAfterProjection.observation !== observationAfter.observation
            || observationAfterProjection.sourceObservation !== observationAfter.sourceObservation
        ) {
            this.searchContinuationCoordinator.remove(handle);
            return fail(
                "SEARCH_RESULT_SET_STALE",
                "Search publication or source observation changed while the continuation page was being projected. Run search_codebase again.",
            );
        }
        const nextOffset = lookup.nextOffset + projection.results.length;
        const responseText = this.stringifyToolJson(projection.envelope);
        const advanced = this.searchContinuationCoordinator.advance({
            handle,
            expectedOffset: lookup.nextOffset,
            nextOffset,
            nowMs: this.now(),
            replay: {
                expectedOffset,
                pageSize,
                responseText,
            },
        });
        if (advanced !== "advanced") {
            if (advanced === "conflict") {
                const concurrent = this.searchContinuationCoordinator.lookup(handle, this.now());
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

    public releaseSearchContinuationOwnership(): void {
        this.searchContinuationCoordinator.unregisterOwner(this);
    }

    /** Internal Phase 4 entry point. MCP schema/transport wiring belongs to Phase 5. */
    public async composeSymbolContext(
        input: ComposeSymbolContextInput,
    ): Promise<ComposeSymbolContextResult> {
        const normalizedInput: ComposeSymbolContextInput = {
            ...input,
            relativeFile: this.normalizeRelativeFilePath(input.relativeFile),
        };
        return composePreparedSymbolContext(normalizedInput, {
            prepareSnapshot: (request) => this.prepareSymbolContextSnapshot(request),
        });
    }

    public async handleFileOutline(args: FileOutlineInput) {
        return this.navigationHandlers.handleFileOutline(args);
    }

    public async handleCallGraph(args: ToolArgs) {
        return this.navigationHandlers.handleCallGraph(args);
    }

    public async handleClearIndex(args: ToolArgs) {
        return this.manageMaintenanceHandlers.handleClearIndex(args);
    }

    public async handleGetIndexingStatus(args: ToolArgs) {
        return this.manageMaintenanceHandlers.handleGetIndexingStatus(args);
    }

    /**
     * Handle sync request - manually trigger incremental sync for a codebase
     */
    public async handleSyncCodebase(args: ToolArgs) {
        return this.manageMaintenanceHandlers.handleSyncCodebase(args);
    }
}
