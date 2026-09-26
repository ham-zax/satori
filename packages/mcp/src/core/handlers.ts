import * as path from "path";
import crypto from "node:crypto";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    type PublicationLease,
    type PublicationRef,
    JsonNavigationStore,
    type Reranker,
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
import type { RelationshipRecord, SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { CapabilityResolver } from "./capabilities.js";
import {
    SyncManager,
    type WatcherObservationSnapshot,
} from "./sync.js";
import {
    DEFAULT_MANAGE_RETRY_AFTER_MS,
    IndexFingerprint,
    summarizeIndexFingerprint,
} from "../config.js";
import {
    SEARCH_CHANGED_FILES_CACHE_TTL_MS,
    SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N,
    PathCategory,
    SearchScope
} from "./search-constants.js";
import {
    CallGraphDirection,
    CallGraphEdgeResult as CallGraphEdge,
    CallGraphHint,
    CallGraphNodeResult as CallGraphNode,
    CallGraphResponseEnvelope,
    CallGraphSymbolRef,
    FingerprintCompatibilityDiagnostics,
    FileOutlineInput,
    FileOutlineResponseEnvelope,
    FileOutlineStatus,
    NonOkReason,
    SearchDebugHint,
    SearchGroupResult,
    SearchReadinessDebugHint,
    SearchRecommendedNextAction,
    SearchResponseEnvelope,
    SearchSpan,
} from "./search-types.js";
import {
    ManageIndexAction,
} from "./manage-types.js";
import {
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import {
    buildRegistrySymbolCallGraphHint as buildSearchRegistrySymbolCallGraphHint,
} from "./search-navigation.js";
import {
    buildChangedCodeDebug as buildSearchChangedCodeDebug,
    buildGeneratedArtifactsVerificationHint as buildSearchGeneratedArtifactsVerificationHint,
} from "./search-debug-helpers.js";
import {
    sortNativeGroupedSearchResults as sortGroupedSearchResultsHelper,
} from "./search-group-ordering.js";
import {
    compareNullableNumbersAsc as compareNullableNumbersAscHelper,
    compareNullableStringsAsc as compareNullableStringsAscHelper,
} from "./search-grouping.js";
import {
    buildOutlineSpanWarningCodes as buildSearchOutlineSpanWarningCodes,
    normalizeSearchSymbolLabel as normalizeSearchSymbolLabelHelper,
} from "./search-response-helpers.js";
import {
    classifyPathCategory,
    hasPathSegment as hasSearchPathSegment,
    isDocPath as isSearchDocPath,
    isFixturePath as isSearchFixturePath,
    isGeneratedPath as isSearchGeneratedPath,
    isTestPath as isSearchTestPath,
    normalizeSearchPath as normalizeSearchPathHelper,
    shouldIncludeCategoryInScope,
} from "./search-ranking-policy.js";
import { SearchQuerySupport } from "./search-query-support.js";
import {
    TrackedRootReadiness,
    type ReadinessPhase,
    type TrackedRootEntry,
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
import type {
    AutomaticReindexReason,
    AutomaticReindexScheduleResult,
} from "./index-maintenance-coordinator.js";
import {
    SearchContinuationCoordinator,
    SearchContinuationCoordinatorPool,
    SearchRequestCoordinator,
    type FrozenSearchResultSet,
} from "./search-request-coordinator.js";
export {
    SearchContinuationCoordinator,
    SearchContinuationCoordinatorPool,
    type FrozenSearchResultSet,
};
import { VectorBackendMaintenance } from "./vector-backend-maintenance.js";
import {
    RelationshipBackedCallGraph,
    type RelationshipBackedCallGraphResult,
} from "./relationship-backed-call-graph.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";
import {
    PreparedReadCacheOwner,
    type CachedPreparedReadResult,
} from "./prepared-read-cache-owner.js";
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
    getPublicationProofReader,
    validateCompletionProof as validateIndexCompletionProof
} from "./completion-proof.js";
import type {
} from "./backend-diagnostics.js";
import { READ_FILE_MAX_BYTES_DEFAULT } from "./published-source-reader.js";
import type { ExactReferenceSearchResult } from "./exact-reference-search.js";
import type {
} from "./search-lexical-scoring.js";
import {
    formatRuntimeOwnerConflictMessage,
    formatRuntimeOwnerConflictNextStep,
    type RuntimeOwnerMutationAction,
    type RuntimeOwnerMutationGate,
    type RuntimeOwnerMutationGateResult,
} from "./runtime-owner.js";
import { RootMutationRuntime } from "@zokizuan/satori-core/integration";
import { PreparedPublicationReadSession } from "./prepared-publication-read-session.js";
import type { SessionWorkspacePolicy } from "./session-workspace-policy.js";

const SEARCH_DEBUG_CHANGED_CODE_MAX_FILES = 10;
const SEARCH_DEBUG_CHANGED_CODE_MAX_SYMBOLS = 20;
const SEARCH_DEBUG_CHANGED_CODE_MAX_DIRECT_CALLERS = 20;
type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>['reason'];

type PublicationAuthorityContext = {
    getCurrentPublicationForValidation?: (codebasePath: string) => Promise<unknown>;
    getCurrentPublication?: (codebasePath: string) => PublicationRef | null;
    acquireCurrentPublicationRead?: (codebasePath: string) => PublicationLease | null;
    acquirePublicationRead?: (codebasePath: string, publicationId: string) => PublicationLease | null;
    isPublicationReadAdmitted?: (publication: PublicationRef) => Promise<boolean>;
    getPublicationNavigationAddress?: (publication: PublicationRef) => { publicationId: string; navigationRoot: string } | null;
    getPublicationNavigationStatus?: (publication: PublicationRef) => Promise<import("@zokizuan/satori-core").PublicationNavigationStatus>;
    getActiveIndexedCollectionName?: (codebasePath: string) => Promise<string | null>;
    getCurrentPublicationCollectionName?: (codebasePath: string) => Promise<string | null>;
};

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type SearchToolTextResponse = ToolTextResponse & {
    meta?: Record<string, unknown>;
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

type ContextLifecycleCapabilities = PublicationAuthorityContext & {
    resolveCollectionName?: (codebasePath: string) => string;
    loadIndexProfileForCodebase?: (codebasePath: string) => IndexProfileView;
    getActiveIgnorePatterns?: (codebasePath?: string) => string[];
    getIndexedExtensionsForCodebase?: (codebasePath: string) => string[];
    getIndexedExtensions?: () => string[];
    getTrackedRelativePaths?: (codebasePath: string) => string[];
    semanticSearchInPublication?: (
        publication: PublicationRef,
        request: import('@zokizuan/satori-core').SemanticSearchRequest,
    ) => Promise<import('@zokizuan/satori-core').SemanticSearchResult[]>;
    semanticSearchWithCandidateTraceInPublication?: (
        publication: PublicationRef,
        request: import('@zokizuan/satori-core').SemanticSearchRequest,
        maxEntriesPerStage: number,
        options?: import('@zokizuan/satori-core').SemanticSearchCandidateTraceOptions,
    ) => Promise<import('@zokizuan/satori-core').SemanticSearchExecutionResult>;
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
    private syncManager: SyncManager;
    private readonly capabilities: CapabilityResolver;
    private runtimeFingerprint: IndexFingerprint;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    private readonly now: () => number;
    private readonly reranker: Reranker | null;
    private readonly navigationStore: JsonNavigationStore;
    private readonly changedFilesCache = new Map<string, ChangedFilesCacheEntry>();
    private readonly preparedReadCacheOwner: PreparedReadCacheOwner;

    private readonly gitignoreForceReloadEveryN: number;
    private readonly searchQuerySupport: SearchQuerySupport;
    private readonly trackedRootReadiness: TrackedRootReadiness;
    private readonly navigationHandlers: NavigationHandlers;
    private readonly manageMaintenanceHandlers: ManageMaintenanceHandlers;
    private readonly manageIndexingHandlers: ManageIndexingHandlers;
    private readonly searchRequestCoordinator: SearchRequestCoordinator;
    private readonly vectorBackendMaintenance: VectorBackendMaintenance;
    private readonly relationshipBackedCallGraph: RelationshipBackedCallGraph;
    private readonly toolResponseBuilders: ToolResponseBuilders;
    private readonly readFileMaxBytes: number;

    constructor(
        context: Context,
        syncManager: SyncManager,
        runtimeFingerprint: IndexFingerprint,
        capabilities: CapabilityResolver,
        private readonly mutationRuntime: RootMutationRuntime,
        now: () => number = () => Date.now(),
        reranker?: Reranker | null,
        gitignoreForceReloadEveryN: number = SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N,
        navigationStore: JsonNavigationStore = new JsonNavigationStore(),
        private readonly runtimeOwnerGate: RuntimeOwnerMutationGate | null = null,
        searchContinuationCoordinator?: SearchContinuationCoordinator,
        options?: {
            readFileMaxBytes?: number;
            collectPublicationGarbageAfterSync?: (codebasePath: string) => Promise<string[]>;
            ownDetachedMutationCompletion?: (completion: Promise<void>) => void;
            requestAutomaticReindex?: (
                codebasePath: string,
                reason: AutomaticReindexReason,
            ) => Promise<AutomaticReindexScheduleResult>;
        },
    ) {
        this.context = context;
        this.syncManager = syncManager;
        this.capabilities = capabilities;
        this.runtimeFingerprint = runtimeFingerprint;
        this.currentWorkspace = process.cwd();
        this.now = now;
        this.reranker = reranker || null;
        this.readFileMaxBytes = Math.max(1, options?.readFileMaxBytes ?? READ_FILE_MAX_BYTES_DEFAULT);
        this.gitignoreForceReloadEveryN = Math.max(1, Math.trunc(gitignoreForceReloadEveryN));
        this.navigationStore = navigationStore;
        this.preparedReadCacheOwner = new PreparedReadCacheOwner({
            getCurrentPublication: (codebasePath) => this.context.getCurrentPublication(codebasePath),
            getPublicationNavigationAddress: (publication) => (
                this.context.getPublicationNavigationAddress(publication)
            ),
            navigationStore: this.navigationStore,
            clock: { now: () => this.now() },
        });
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
            capabilities: this.capabilities,
            runtimeFingerprint: this.runtimeFingerprint,
            reranker: this.reranker,
            gitignoreForceReloadEveryN: this.gitignoreForceReloadEveryN,
        };
        this.searchQuerySupport = new SearchQuerySupport(searchQuerySupportHost);

        const toolResponseBuildersHost: ConstructorParameters<typeof ToolResponseBuilders>[0] = {
            buildManageIndexRecommendedAction: this.buildManageIndexRecommendedAction.bind(this),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildReindexHint: this.buildReindexHint.bind(this),
            buildSyncHint: this.buildSyncHint.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            buildStaleLocalHint: this.buildStaleLocalHint.bind(this),
            buildStaleLocalMessage: this.buildStaleLocalMessage.bind(this),
            buildIndexingMetadata: this.buildIndexingMetadata.bind(this),
            buildCompatibilityDiagnostics: this.buildCompatibilityDiagnostics.bind(this),
        };
        this.toolResponseBuilders = new ToolResponseBuilders(toolResponseBuildersHost);

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
            isPathWithinCodebase: this.isPathWithinCodebase.bind(this),
            listTrackedRoots: this.listTrackedRoots.bind(this),
            getIndexingOperation: (codebasePath: string) => this.getIndexingOperationForReadiness(codebasePath),
            hasSearchableGeneration: (codebasePath: string) => this.hasSearchableGenerationForReadiness(codebasePath),
            validateCompletionProof: (codebasePath: string) => this.validateCompletionProof(codebasePath),
            probeLocalSearchCollectionState: (codebasePath: string) => this.probeLocalSearchCollectionState(codebasePath),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildReindexHint: this.buildReindexHint.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            buildManageIndexRecommendedAction: this.buildManageIndexRecommendedAction.bind(this),
            buildStaleLocalMessage: this.buildStaleLocalMessage.bind(this),
            requestAutomaticReindex: options?.requestAutomaticReindex,
        };
        this.trackedRootReadiness = new TrackedRootReadiness(trackedRootReadinessHost);

        const vectorBackendMaintenanceHost: ConstructorParameters<typeof VectorBackendMaintenance>[0] = {
            context: this.context,
            canonicalizeCodebasePath: this.canonicalizeCodebasePath.bind(this),
            resolveCollectionName: this.resolveCollectionName.bind(this),
            unwatchCodebase: this.unwatchCodebase.bind(this),
            mutationRuntime: this.mutationRuntime,
        };
        this.vectorBackendMaintenance = new VectorBackendMaintenance(vectorBackendMaintenanceHost);

        const relationshipBackedCallGraphHost: ConstructorParameters<typeof RelationshipBackedCallGraph>[0] = {
            navigationStore: this.navigationStore,
        };
        this.relationshipBackedCallGraph = new RelationshipBackedCallGraph(relationshipBackedCallGraphHost);

        const navigationHandlersHost: ConstructorParameters<typeof NavigationHandlers>[0] = {
            trackedRootReadiness: this.trackedRootReadiness,
            prepareNavigationRead: this.prepareNavigationRead.bind(this),
            acquirePublicationLease: this.acquirePublicationLease.bind(this),
            isPublicationAdmitted: (publication) => this.context.isPublicationReadAdmitted(publication),
            getPublicationPackageOwnership: (publication) => this.context.getPublicationPackageOwnership(publication),
            getPublicationNavigationAddress: (publication) => this.context.getPublicationNavigationAddress(publication),
            getPublicationNavigationStatus: (publication) => this.context.getPublicationNavigationStatus(publication),
            loadPreparedNavigationSymbolsByFile: this.loadPreparedNavigationSymbolsByFile.bind(this),
            loadPreparedNavigationManifest: this.loadPreparedNavigationManifest.bind(this),
            loadPreparedNavigationCompatibility: this.loadPreparedNavigationCompatibility.bind(this),
            toolResponseBuilders: this.toolResponseBuilders,
            stringifyToolJson: this.stringifyToolJson.bind(this),
            normalizeRelativeFilePath: this.normalizeRelativeFilePath.bind(this),
            buildRequiresReindexFileOutlinePayload: buildRequiresReindexFileOutlinePayloadForNavigation,
            withProofDebugHint: this.withProofDebugHint.bind(this),
            isPartialIndexNavigationUnavailable: this.isPartialIndexNavigationUnavailable.bind(this),
            getRegistryFileFreshness: this.getRegistryFileFreshness.bind(this),
            // Session tool contexts expose the configured READ_FILE_MAX_BYTES
            // ceiling; when absent (as for a bare core Context), the shared
            // reader enforces its 8 MiB default.
            readFileMaxBytes: options?.readFileMaxBytes,
            buildStaleSymbolRefFileOutlinePayload: buildStaleSymbolRefFileOutlinePayloadForNavigation,
            loadRegistryValidatedRelationshipNavigation: this.loadRegistryValidatedRelationshipNavigation.bind(this),
            buildRegistrySymbolCallGraphHint: this.buildRegistrySymbolCallGraphHint.bind(this),
            buildOutlineSpanWarningCodes: this.buildOutlineSpanWarningCodes.bind(this),
            touchWatchedCodebase: this.touchWatchedCodebase.bind(this),
            buildSyncHint: this.buildSyncHint.bind(this),
            getOutlineStatusForLanguage: this.getOutlineStatusForLanguage.bind(this),
            isCallGraphLanguageSupported: this.isCallGraphLanguageSupported.bind(this),
            isSha256HexHash: this.isSha256HexHash.bind(this),
            buildStaleSymbolRefCallGraphPayload: this.buildStaleSymbolRefCallGraphPayload.bind(this),
            buildRelationshipBackedCallGraph: (input) => this.buildRelationshipBackedCallGraph(input as {
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
                findExactSourceReferences?: (target: SymbolRecord) => Promise<ExactReferenceSearchResult>;
            }),
        };
        this.navigationHandlers = new NavigationHandlers(navigationHandlersHost);

        const manageMaintenanceHandlersHost: ConstructorParameters<typeof ManageMaintenanceHandlers>[0] = {
            context: this.context,
            mutationRuntime: this.mutationRuntime,
            syncManager: this.syncManager,
            trackedRootReadiness: this.trackedRootReadiness,
            prepareStatusTrackedRootRead: this.prepareStatusTrackedRootRead.bind(this),
            acquirePublicationLease: this.acquirePublicationLease.bind(this),
            isPublicationAdmitted: (publication) => this.context.isPublicationReadAdmitted(publication),
            getPublicationNavigationAddress: (publication) => this.context.getPublicationNavigationAddress(publication),
            buildRuntimeOwnerConflictResponseIfBlocked: this.buildRuntimeOwnerConflictResponseIfBlocked.bind(this),
            manageResponse: this.toolResponseBuilders.manageResponse.bind(this.toolResponseBuilders),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildManageActionBlockedMessage: this.buildManageActionBlockedMessage.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            getManageRetryAfterMs: this.getManageRetryAfterMs.bind(this),
            buildIndexingMetadata: this.buildIndexingMetadata.bind(this),
            clearIndexingStats: this.clearIndexingStats.bind(this),
            unwatchCodebase: this.unwatchCodebase.bind(this),
            buildReindexInstruction: this.buildReindexInstruction.bind(this),
            buildCompatibilityStatusLines: this.buildCompatibilityStatusLines.bind(this),
            buildManageRequiresReindexHints: this.buildManageRequiresReindexHints.bind(this),
            buildStaleLocalHint: this.buildStaleLocalHint.bind(this),
            buildStaleLocalMessage: this.buildStaleLocalMessage.bind(this),
            buildReindexHint: this.buildReindexHint.bind(this),
            buildSyncHint: this.buildSyncHint.bind(this),
            collectPublicationGarbageAfterSync: options?.collectPublicationGarbageAfterSync
                ?? ((codebasePath) => this.context.collectPublicationGarbage(codebasePath)),
            ownDetachedMutationCompletion: options?.ownDetachedMutationCompletion ?? (() => undefined),
            manageVectorBackendResponse: this.toolResponseBuilders.manageVectorBackendResponse.bind(this.toolResponseBuilders),
            getLiveOwnersSummary: async () => {
                if (!this.runtimeOwnerGate || typeof this.runtimeOwnerGate.getLiveOwnersSummary !== "function") {
                    return null;
                }
                return this.runtimeOwnerGate.getLiveOwnersSummary();
            },
        };
        this.manageMaintenanceHandlers = new ManageMaintenanceHandlers(manageMaintenanceHandlersHost);

        const manageIndexingHandlersHost: ConstructorParameters<typeof ManageIndexingHandlers>[0] = {
            context: this.context,
            mutationRuntime: this.mutationRuntime,
            syncManager: this.syncManager,
            manageResponse: this.toolResponseBuilders.manageResponse.bind(this.toolResponseBuilders),
            buildRuntimeOwnerConflictResponseIfBlocked: this.buildRuntimeOwnerConflictResponseIfBlocked.bind(this),
            buildManageActionBlockedMessage: this.buildManageActionBlockedMessage.bind(this),
            buildCreateHint: this.buildCreateHint.bind(this),
            buildReindexHint: this.buildReindexHint.bind(this),
            buildStatusHint: this.buildStatusHint.bind(this),
            getManageRetryAfterMs: this.getManageRetryAfterMs.bind(this),
            buildIndexingMetadata: this.buildIndexingMetadata.bind(this),
            buildReindexInstruction: this.buildReindexInstruction.bind(this),
            buildManageRequiresReindexHints: this.buildManageRequiresReindexHints.bind(this),
            validateCompletionProof: (codebasePath: string) => this.validateCompletionProof(codebasePath),
            probeLocalSearchCollectionState: (codebasePath: string) => this.probeLocalSearchCollectionState(codebasePath),
            isZillizBackend: this.isZillizBackend.bind(this),
            dropZillizCollectionForCreate: this.dropZillizCollectionForCreate.bind(this),
            buildCollectionLimitMessage: this.buildCollectionLimitMessage.bind(this),
            recoverStaleIndexCandidates: this.recoverStaleIndexCandidates.bind(this),
            manageVectorBackendResponse: this.toolResponseBuilders.manageVectorBackendResponse.bind(this.toolResponseBuilders),
            touchWatchedCodebase: this.touchWatchedCodebase.bind(this),
            loadIndexProfileForCodebase: this.loadIndexProfileForCodebase.bind(this),
            getContextActiveIgnorePatterns: this.getContextActiveIgnorePatterns.bind(this),
            getContextIndexedExtensions: this.getContextIndexedExtensions.bind(this),
            canonicalizeCodebasePath: this.canonicalizeCodebasePath.bind(this),
            setIndexingStats: this.setIndexingStats.bind(this),
            evaluateReindexPreflight: this.evaluateReindexPreflight.bind(this),
            assertIndexMutationCapabilities: this.assertIndexMutationCapabilities.bind(this),
            ownDetachedMutationCompletion: options?.ownDetachedMutationCompletion ?? (() => undefined),
        };
        this.manageIndexingHandlers = new ManageIndexingHandlers(manageIndexingHandlersHost);
        const searchContext = this.context;
        const getSearchContextLifecycle = (): ContextLifecycleCapabilities => this.contextLifecycle();
        const getSearchSyncManager = (): SyncManager => this.syncManager;
        const searchRequestCoordinatorCollaborators: ConstructorParameters<typeof SearchRequestCoordinator>[0] = {
            readiness: {
                touchWatchedCodebaseBestEffort: (codebasePath) => (
                    this.touchWatchedCodebaseBestEffort(codebasePath)
                ),
                assessReadFreshness: (codebasePath, thresholdMs, options) => (
                    getSearchSyncManager().assessReadFreshness(codebasePath, thresholdMs, options)
                ),
                get getPreparedReadDiagnostics() {
                    const syncManager = getSearchSyncManager();
                    const implementation = syncManager.getPreparedReadDiagnostics;
                    return typeof implementation === 'function'
                        ? (codebasePath: string) => implementation.call(syncManager, codebasePath)
                        : undefined;
                },
                prepareTrackedRootReadWithObservation: (absolutePath, onPhase, accessMode) => (
                    this.prepareTrackedRootReadWithObservation(absolutePath, onPhase, accessMode)
                ),
                loadRegistryValidatedRelationshipNavigation: (input) => (
                    this.loadRegistryValidatedRelationshipNavigation(input)
                ),
                getWatcherObservation: (codebasePath) => this.getWatcherObservation(codebasePath),
                getChangedFilesForCodebase: (codebasePath, options) => (
                    this.getChangedFilesForCodebase(codebasePath, options)
                ),
                getTrackedRootReadiness: () => this.trackedRootReadiness,
                isPartialIndexNavigationUnavailable: (info) => (
                    this.isPartialIndexNavigationUnavailable(info)
                ),
                getIndexingOperationForReadiness: (codebasePath) => (
                    this.getIndexingOperationForReadiness(codebasePath)
                ),
                probeLocalSearchCollectionState: (codebasePath) => (
                    this.probeLocalSearchCollectionState(codebasePath)
                ),
            },
            hints: {
                stringifyToolJson: (payload) => this.stringifyToolJson(payload),
                getToolResponseBuilders: () => this.toolResponseBuilders,
                getSearchNavigationHelpers: () => this.getSearchNavigationHelpers(),
                buildGeneratedArtifactsVerificationHint: (codebaseRoot, results) => (
                    this.buildGeneratedArtifactsVerificationHint(codebaseRoot, results)
                ),
                buildChangedCodeDebug: (preparedRead, changedFilesState) => (
                    this.buildChangedCodeDebug(preparedRead, changedFilesState)
                ),
                withProofDebugHint: (payload, proofDebugHint) => (
                    this.withProofDebugHint(payload, proofDebugHint)
                ),
                buildSyncHint: (codebasePath) => this.buildSyncHint(codebasePath),
                buildStaleLocalMessage: (codebasePath, requestedPath, reason) => (
                    this.buildStaleLocalMessage(codebasePath, requestedPath, reason)
                ),
                buildRelationshipBackedCallGraph: (input) => (
                    this.buildRelationshipBackedCallGraph(input)
                ),
                buildManageIndexRecommendedAction: (action, codebasePath, reason) => (
                    this.buildManageIndexRecommendedAction(action, codebasePath, reason)
                ),
                buildCreateHint: (codebasePath) => this.buildCreateHint(codebasePath),
                sanitizeIndexedRelativeFilePath: (relativeFilePath) => (
                    this.sanitizeIndexedRelativeFilePath(relativeFilePath)
                ),
            },
            preparedRead: {
                loadPreparedNavigationManifest: (preparedRead, operations) => (
                    this.loadPreparedNavigationManifest(preparedRead, operations)
                ),
                getPreparedAuthorityObservation: (codebasePath) => (
                    this.getPreparedAuthorityObservation(codebasePath)
                ),
                getPublicationNavigationAddress: (publication) => (
                    this.context.getPublicationNavigationAddress(publication)
                ),
                seedPreparedRead: (state, preserveProofAge, statusPrepared) => (
                    this.seedPreparedRead(state, preserveProofAge, statusPrepared)
                ),
                evictPreparedRead: (codebasePath) => this.evictPreparedRead(codebasePath),
                loadPreparedNavigationCompatibility: (preparedRead, expectedHash, operations) => (
                    this.loadPreparedNavigationCompatibility(preparedRead, expectedHash, operations)
                ),
                getCachedPreparedRead: (absolutePath, operations, requireNavigation) => (
                    this.getCachedPreparedRead(absolutePath, operations, requireNavigation)
                ),
                acquirePublicationLease: (codebasePath, publicationId) => (
                    this.acquirePublicationLease(codebasePath, publicationId)
                ),
                isPublicationLeaseAdmitted: (lease) => this.isPublicationLeaseAdmitted(lease),
                isPublicationAdmitted: (publication) => this.context.isPublicationReadAdmitted(publication),
                getPublicationNavigationStatus: (publication) => this.context.getPublicationNavigationStatus(publication),
            },
            freshness: {
                inspectSourceFreshnessCheckpoint: (
                    codebasePath: string,
                    publication?: PublicationRef,
                ) => this.context.inspectSourceFreshnessCheckpoint(codebasePath, publication),
                compareAllSourceToFreshnessCheckpoint: (
                    codebasePath: string,
                    publication?: PublicationRef,
                ) => this.context.compareAllSourceToFreshnessCheckpoint(codebasePath, publication),
                compareSourceObservationToFreshnessCheckpoint: (
                    codebasePath: string,
                    publication?: PublicationRef,
                ) => this.context.compareSourceObservationToFreshnessCheckpoint(codebasePath, publication),
                compareSourcePathsToFreshnessCheckpoint: (
                    codebasePath: string,
                    relativePaths: readonly string[],
                    publication?: PublicationRef,
                ) => this.context.compareSourcePathsToFreshnessCheckpoint(codebasePath, relativePaths, publication),
            },
            environment: {
                now: () => this.now(),
                getCapabilities: () => this.capabilities,
                getReadFileMaxBytes: () => this.readFileMaxBytes,
                parseIndexedAtMs: (indexedAt) => this.parseIndexedAtMs(indexedAt),
                getEmbeddingProviderName: () => this.context.getEmbeddingEngine().getProvider(),
                semanticSearch: (request: import("@zokizuan/satori-core").SemanticSearchRequest) => this.context.semanticSearch(request),
                get semanticSearchInPublication() {
                    const implementation = getSearchContextLifecycle().semanticSearchInPublication;
                    return typeof implementation === 'function'
                        ? (publication: PublicationRef, request: import("@zokizuan/satori-core").SemanticSearchRequest) => (
                            implementation.call(searchContext, publication, request)
                        )
                        : undefined;
                },
                get semanticSearchWithCandidateTraceInPublication() {
                    const implementation = getSearchContextLifecycle().semanticSearchWithCandidateTraceInPublication;
                    return typeof implementation === 'function'
                        ? (
                            publication: PublicationRef,
                            request: import("@zokizuan/satori-core").SemanticSearchRequest,
                            maxEntriesPerStage: number,
                            options?: import("@zokizuan/satori-core").SemanticSearchCandidateTraceOptions,
                        ) => implementation.call(searchContext, publication, request, maxEntriesPerStage, options)
                        : undefined;
                },
            }
        };;
        this.searchRequestCoordinator = new SearchRequestCoordinator(
            searchRequestCoordinatorCollaborators,
            this.searchQuerySupport,
            this.reranker,
            searchContinuationCoordinator,
        );
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    private setIndexingStats(stats: { indexedFiles: number; totalChunks: number } | null): void {
        this.indexingStats = stats;
    }

    private clearIndexingStats(): void {
        this.indexingStats = null;
    }

    private buildReindexInstruction(codebasePath: string, detail?: string): string {
        const detailLine = detail ? `${detail}\n\n` : '';
        return `${detailLine}Error: The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt.\nAutomatic maintenance did not recover this state. Recovery override: call manage_index with {\"action\":\"reindex\",\"path\":\"${codebasePath}\"}.`;
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

    private buildManageIndexRecommendedAction(
        action: Extract<ManageIndexAction, "create" | "reindex" | "status" | "sync">,
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
        return {
            reindex: this.buildReindexHint(codebasePath),
            status: this.buildStatusHint(codebasePath),
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

    private getWatcherObservation(codebasePath: string): WatcherObservationSnapshot {
        const syncManager = this.syncManager as unknown as {
            getWatcherObservation?: (path: string) => WatcherObservationSnapshot;
        };
        return syncManager.getWatcherObservation?.(codebasePath) ?? {
            observedEventEpoch: 0,
            comparedThroughEventEpoch: 0,
            latestEpochByReason: {
                source_changed: 0,
                ignore_rules_changed: 0,
                directory_changed: 0,
            },
            coverage: 'ready',
            pending: false,
        };
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
        return this.preparedReadCacheOwner.getPreparedAuthorityObservation(codebasePath);
    }

    private evictPreparedRead(codebasePath: string): void {
        this.preparedReadCacheOwner.evictPreparedRead(codebasePath);
    }

    private async loadPreparedNavigationManifest(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        operations?: SearchReadinessDebugHint['operations'],
    ): Promise<Awaited<ReturnType<JsonNavigationStore['getManifest']>>> {
        return this.preparedReadCacheOwner.loadPreparedNavigationManifest(preparedRead, operations);
    }

    private async loadPreparedNavigationSymbolsByFile(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        file: string,
    ): Promise<Awaited<ReturnType<JsonNavigationStore['getSymbolsByFile']>>> {
        return this.preparedReadCacheOwner.loadPreparedNavigationSymbolsByFile(preparedRead, file);
    }

    private async loadPreparedNavigationCompatibility(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        expectedSymbolRegistryManifestHash: string,
        operations?: SearchReadinessDebugHint['operations'],
    ): Promise<Awaited<ReturnType<JsonNavigationStore['getCompatibilityState']>>> {
        return this.preparedReadCacheOwner.loadPreparedNavigationCompatibility(
            preparedRead,
            expectedSymbolRegistryManifestHash,
            operations,
        );
    }

    private async getCachedPreparedRead(
        absolutePath: string,
        operations: SearchReadinessDebugHint["operations"],
        requireNavigation = false,
    ): Promise<CachedPreparedReadResult> {
        // Cache residency must not choose the root or change cold-read semantics.
        const root = this.trackedRootReadiness.resolveTrackedRoot(absolutePath, ['indexed']);
        if (!root) return { status: 'miss', reason: 'cache_miss' };
        return this.preparedReadCacheOwner.getCachedPreparedRead(
            root.path,
            operations,
            requireNavigation,
        );
    }

    private seedPreparedRead(
        state: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        preserveProofAge: boolean,
        statusPrepared = false,
    ): void {
        this.preparedReadCacheOwner.seedPreparedRead(state, preserveProofAge, statusPrepared);
    }

    private async prepareStatusTrackedRootRead(
        absolutePath: string,
    ): Promise<TrackedRootReadinessState> {
        const state = await this.prepareTrackedRootReadWithObservation(
            absolutePath,
            () => undefined,
        );
        if (state.state === 'ready') {
            this.seedPreparedRead(state, false, true);
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
        );
        if (state.state !== 'ready') {
            return state;
        }

        const activeMutation = this.mutationRuntime.getActiveMutation(state.root.path);
        if (!activeMutation) {
            return state;
        }

        this.evictPreparedRead(state.root.path);
        const operation = this.getIndexingOperationForReadiness(state.root.path);
        const matchingActiveSync = activeMutation.action === 'sync';

        if (process.env.SATORI_TASK7_DEBUG === '1') {
            console.error('[TASK7-DEBUG][readiness-wrapper] ' + JSON.stringify({
                root: state.root.path,
                accessMode,
                publicationId: state.publication.id,
                collectionName: state.publication.publication.vector.collectionName,
                activeMutation: {
                    action: activeMutation.action,
                    generation: activeMutation.generation,
                    operationId: activeMutation.id,
                },
                liveOperation: operation
                    ? {
                        action: operation.action,
                        generation: operation.generation,
                        phase: operation.phase,
                    }
                    : null,
                matchingActiveSync,
                decision: matchingActiveSync
                    ? 'preserve_searchable_read'
                    : 'strip_searchable_read',
            }));
        }

        return {
            state: 'indexing',
            codebasePath: state.root.path,
            ...(operation ? { operation } : {}),
            searchableGenerationAvailable: true,
            ...(matchingActiveSync ? { searchableRead: state } : {}),
        };
    }

    private async prepareNavigationRead(absolutePath: string): Promise<TrackedRootReadinessState> {
        const operations: SearchReadinessDebugHint['operations'] = {
            preparedCacheLookups: 0,
            preparedCacheHits: 0,
            coldReadinessChecks: 0,
            postFreshnessColdChecks: 0,
            warmReceiptRevalidations: 0,
            registryLoads: 0,
            navigationValidationRuns: 0,
        };
        const prepareReadableState = async (
            ready: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        ): Promise<TrackedRootReadinessState> => {
            const activeOperation = this.getIndexingOperationForReadiness(ready.root.path);
            if (activeOperation && activeOperation.action !== 'sync') {
                return {
                    state: 'indexing',
                    codebasePath: ready.root.path,
                    operation: activeOperation,
                    searchableGenerationAvailable: true,
                };
            }
            if (activeOperation?.action === 'sync') {
                return {
                    ...ready,
                    freshnessDecision: {
                        mode: 'served_previous_generation',
                        checkedAt: new Date(this.now()).toISOString(),
                        thresholdMs: 0,
                        servedCollection: ready.publication.publication.vector.collectionName,
                        servedPublicationId: ready.publication.id,
                        pendingOperation: {
                            action: activeOperation.action,
                            generation: activeOperation.generation,
                        },
                    },
                };
            }

            const freshnessDecision = await this.syncManager.assessReadFreshness(
                ready.root.path,
                0,
                { preparedPublication: ready.publication },
            );
            const operationAfterAssessment = this.getIndexingOperationForReadiness(ready.root.path);
            if (operationAfterAssessment && operationAfterAssessment.action !== 'sync') {
                return {
                    state: 'indexing',
                    codebasePath: ready.root.path,
                    operation: operationAfterAssessment,
                    searchableGenerationAvailable: true,
                };
            }
            if (operationAfterAssessment?.action === 'sync') {
                return {
                    ...ready,
                    freshnessDecision: {
                        mode: 'served_previous_generation',
                        checkedAt: new Date(this.now()).toISOString(),
                        thresholdMs: 0,
                        servedCollection: ready.publication.publication.vector.collectionName,
                        servedPublicationId: ready.publication.id,
                        pendingOperation: {
                            action: operationAfterAssessment.action,
                            generation: operationAfterAssessment.generation,
                        },
                    },
                };
            }
            return { ...ready, freshnessDecision };
        };

        const cached = await this.getCachedPreparedRead(absolutePath, operations, true);
        if (cached.status === 'hit') {
            return prepareReadableState(cached.state);
        }

        const state = await this.prepareTrackedRootReadWithObservation(
            absolutePath,
            () => undefined,
            'navigation',
        );
        const readable = state.state === 'indexing'
            && state.operation?.action === 'sync'
            && state.searchableGenerationAvailable
            && state.searchableRead
            ? state.searchableRead
            : state;
        if (readable.state !== 'ready') {
            return readable;
        }

        const prepared = await prepareReadableState(readable);
        if (prepared.state === 'ready') {
            this.seedPreparedRead(prepared, false);
        }
        return prepared;
    }

    private async prepareSymbolContextSnapshot(input: {
        codebaseRoot: string;
        relativeFile: string;
        symbolId?: string;
        symbolLabel?: string;
    }): Promise<PrepareSymbolContextSnapshotResult> {
        const session = new PreparedPublicationReadSession<TrackedRootReadinessState>({
            // Keep the caller's root: resolving the absolute file could select a nested Publication.
            prepareReadiness: () => this.prepareNavigationRead(input.codebaseRoot),
            acquirePublicationLease: (prepared) => (
                prepared.state === 'ready'
                    ? this.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                    : undefined
            ),
            isLeaseAdmitted: (prepared, lease) => (
                prepared.state === 'ready'
                && prepared.publication.id === lease.id
                && this.isPublicationLeaseAdmitted(lease)
            ),
        });
        const executeSymbolContextRead = async (
            preparedRead: TrackedRootReadinessState,
            lease: PublicationLease,
        ): Promise<PrepareSymbolContextSnapshotResult> => {
            if (preparedRead.state !== 'ready' || preparedRead.publication.id !== lease.id
                || preparedRead.root.path !== input.codebaseRoot) {
                return {
                    status: 'unavailable',
                    reason: `prepared_navigation_${preparedRead.state}`,
                };
            }
            const navigation = this.context.getPublicationNavigationAddress(lease);
            if (!navigation || preparedRead.navigationStatus !== 'valid') {
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

            const compatibility = await this.loadPreparedNavigationCompatibility(
                preparedRead,
                registryState.manifestHash,
            );
            const relationshipState = compatibility.relationships;
            const exactTargets = findExactRegistrySymbols({
                symbols: registryState.registry.symbolsByFile.get(input.relativeFile) || [],
                ...(input.symbolId ? { symbolIdExact: input.symbolId } : {}),
                ...(input.symbolLabel ? { symbolLabelExact: input.symbolLabel } : {}),
            });
            const preparedTraversals = relationshipState.status === 'ok'
                && exactTargets.length === 1
                ? await prepareRelationshipTraversals({
                    rootPath: preparedRead.root.path,
                    publicationId: navigation.publicationId,
                    navigationRoot: navigation.navigationRoot,
                    registryManifestIdentity: registryState.manifestHash,
                    relationshipManifestIdentity: relationshipState.manifestHash,
                    registry: registryState.registry,
                    target: exactTargets[0],
                    relationshipManifest: relationshipState.manifest,
                    relationshipRecords: relationshipState.records,
                    relationshipWarnings: relationshipState.warnings || [],
                })
                : undefined;
            const relationships: PreparedRelationshipSnapshot = relationshipState.status === 'ok'
                && preparedTraversals
                ? {
                    status: 'available',
                    authority: 'remote_generation_proven',
                    manifestIdentity: relationshipState.manifestHash,
                    callers: preparedTraversals.callers,
                    callees: preparedTraversals.callees,
                }
                : {
                    status: 'unavailable',
                    authority: 'unavailable',
                    reason: relationshipState.status === 'ok'
                        ? 'relationship_traversal_unavailable'
                        : `relationship_navigation_${relationshipState.status}`,
                };
            return {
                status: 'ready',
                snapshot: {
                    canonicalRoot: preparedRead.root.path,
                    registryManifestIdentity: registryState.manifestHash,
                    registry: registryState.registry,
                    navigationAuthority: 'remote_generation_proven',
                    relationships,
                    validateAuthority: () => this.isPublicationLeaseAdmitted(lease),
                },
            };
        };
        const outcome = await session.read(executeSymbolContextRead);
        return outcome.status === 'stale'
            ? { status: 'unavailable', reason: 'prepared_navigation_changed' }
            : outcome.result;
    }

    private contextLifecycle(): ContextLifecycleCapabilities {
        return this.context as unknown as ContextLifecycleCapabilities;
    }

    private acquirePublicationLease(
        codebasePath: string,
        publicationId?: string,
    ): PublicationLease | undefined {
        const lifecycle = this.contextLifecycle();
        if (publicationId) {
            const acquireExact = lifecycle.acquirePublicationRead;
            return typeof acquireExact === 'function'
                ? acquireExact.call(this.context, codebasePath, publicationId) ?? undefined
                : undefined;
        }
        const acquireCurrent = lifecycle.acquireCurrentPublicationRead;
        return typeof acquireCurrent === 'function'
            ? acquireCurrent.call(this.context, codebasePath) ?? undefined
            : undefined;
    }

    private async isPublicationLeaseAdmitted(lease: PublicationLease): Promise<boolean> {
        const admit = this.contextLifecycle().isPublicationReadAdmitted;
        return typeof admit === 'function'
            && await admit.call(this.context, lease);
    }

    private listTrackedRoots(): TrackedRootEntry[] {
        const roots = new Map<string, TrackedRootEntry>();
        for (const ref of this.context.listCurrentPublications()) {
            const publication = ref.publication;
            roots.set(publication.canonicalRoot, {
                path: publication.canonicalRoot,
                info: {
                    status: 'indexed',
                    lastUpdated: publication.createdAt,
                    indexStatus: publication.status === 'complete' ? 'completed' : 'limit_reached',
                    indexedFiles: publication.vector.indexedFiles,
                    totalChunks: publication.vector.totalChunks,
                    collectionName: publication.vector.collectionName,
                },
            });
        }

        for (const activity of this.mutationRuntime.listActiveMutations()) {
            if (activity.action !== 'create' && activity.action !== 'reindex') continue;
            const operation = this.mutationRuntime.getOperation(activity.canonicalRoot);
            roots.set(activity.canonicalRoot, {
                path: activity.canonicalRoot,
                info: {
                    status: 'indexing',
                    lastUpdated: operation?.updatedAt ?? activity.acceptedAt,
                    ...(operation?.progress !== undefined
                        ? { indexingPercentage: operation.progress }
                        : {}),
                },
            });
        }

        return Array.from(roots.values()).sort((left, right) => left.path.localeCompare(right.path));
    }

    private canonicalizeCodebasePath(codebasePath: string): string {
        return this.searchQuerySupport.canonicalizeCodebasePath(codebasePath);
    }

    private assertIndexMutationCapabilities(): void {
        const context = this.context as unknown as Record<string, unknown>;
        const requiredContextCapabilities = [
            'resolveCollectionName',
            'getActiveIndexedCollectionName',
            'getCurrentPublication',
            'listCurrentPublications',
        ] as const;

        for (const capability of requiredContextCapabilities) {
            if (typeof context[capability] !== 'function') {
                throw new Error(`Missing required mutation capability: Context.${capability}.`);
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
        const paths = {
            registryPath: result.registryPath,
            lockPath: result.lockPath,
        };
        const message = result.message
            || formatRuntimeOwnerConflictMessage({
                conflictingOwners,
                registryPath: paths.registryPath,
                lockPath: paths.lockPath,
            });
        return this.toolResponseBuilders.manageResponse(action, codebasePath, "blocked", message, {
            reason: "runtime_owner_conflict",
            hints: {
                runtimeOwners: conflictingOwners,
                nextStep: formatRuntimeOwnerConflictNextStep(conflictingOwners, paths),
                nextSteps: [
                    formatRuntimeOwnerConflictNextStep(conflictingOwners, paths),
                    "Do not loop create/reindex/sync while runtime_owner_conflict is returned.",
                    "Search may still work with degraded freshness; mutations stay blocked until a single runtime identity remains.",
                ],
            }
        });
    }

    private buildIndexingMetadata(codebasePath: string): { progressPct: number | null; lastUpdated: string | null; phase: string | null } {
        const activity = this.mutationRuntime.getActiveMutation(codebasePath);
        if (!activity) {
            return {
                progressPct: null,
                lastUpdated: null,
                phase: null,
            };
        }
        const operation = this.mutationRuntime.getOperation(codebasePath);
        return {
            progressPct: operation?.progress ?? null,
            lastUpdated: operation?.updatedAt ?? activity.acceptedAt,
            phase: operation?.phase ?? null,
        };
    }

    private getIndexingOperationForReadiness(codebasePath: string):
        | { action: "create" | "reindex" | "sync"; phase: string; generation: number }
        | undefined {
        const activity = this.mutationRuntime.getActiveMutation(codebasePath);
        if (!activity || (activity.action !== "create" && activity.action !== "reindex" && activity.action !== "sync")) {
            return undefined;
        }
        const operation = this.mutationRuntime.getOperation(codebasePath);
        if (!operation) return undefined;
        if (operation.phase === "completed" || operation.phase === "failed" || operation.phase === "blocked") {
            return undefined;
        }
        return { action: activity.action, phase: operation.phase, generation: activity.generation };
    }

    private hasSearchableGenerationForReadiness(codebasePath: string): boolean {
        return this.context.getCurrentPublication(codebasePath) !== null;
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
        return {
            completionProof: reason,
            recommendedAction: this.buildReindexHint(codebasePath),
            reindex: this.buildReindexHint(codebasePath),
        };
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
            getCurrentPublication: getPublicationProofReader(this.context),
            onProbeError: (error) => {
                console.warn(`[INDEX-PROOF] Publication proof probe failed for '${codebasePath}': ${formatUnknownError(error)}`);
            }
        });
    }

    private isPathWithinCodebase(targetPath: string, rootPath: string): boolean {
        return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
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

    private buildCompatibilityDiagnostics(codebasePath: string): FingerprintCompatibilityDiagnostics {
        return {
            runtimeFingerprint: this.runtimeFingerprint,
            statusAtCheck: this.context.getCurrentPublication(codebasePath) ? 'indexed' : 'not_found',
        };
    }

    private buildCompatibilityStatusLines(codebasePath: string): string {
        const publication = this.context.getCurrentPublication(codebasePath);
        let lines = `\n🧬 Runtime fingerprint: ${this.summarizeFingerprint(this.runtimeFingerprint)}`;
        if (publication) {
            lines += `\n📜 Publication policy: ${publication.publication.policy.policyHash}`;
            lines += `\n📜 Control signature: ${publication.publication.policy.controlSignature}`;
            lines += `\n📦 Publication format: ${JSON.stringify(publication.publication.format)}`;
        }
        return lines;
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

    private getChangedFilesForCodebase(
        codebasePath: string,
        options: { forceRefresh?: boolean } = {},
    ): { available: boolean; files: Set<string> } {
        return getChangedFilesForCodebaseHelper({
            codebasePath,
            nowMs: this.now(),
            changedFilesCache: this.changedFilesCache,
            ttlMs: SEARCH_CHANGED_FILES_CACHE_TTL_MS,
            forceRefresh: options.forceRefresh,
        });
    }

    private getWorkingTreeChangedPathsForPreflight(codebasePath: string): { available: boolean; probeFailed: boolean; files: Set<string> } {
        return getWorkingTreeChangedPathsForPreflightHelper(codebasePath);
    }

    private evaluateReindexPreflight(codebasePath: string): ReindexPreflightResult {
        return evaluateReindexPreflightHelper({
            codebasePath,
            hasCurrentPublication: this.context.getCurrentPublication(codebasePath) !== null,
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

    private async loadRegistryValidatedRelationshipNavigation(input: {
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

        if (!input.preparedRead) {
            return {
                relationshipReady: false,
                relationshipUnavailableReason: 'missing_relationship_navigation',
                warning: 'RELATIONSHIP_NAVIGATION_UNAVAILABLE:publication_identity_missing',
            };
        }
        const compatibility = await this.loadPreparedNavigationCompatibility(
            input.preparedRead,
            input.registryManifestHash,
            input.operations,
        );
        if (compatibility.relationships.status !== 'ok') {
            const relationshipUnavailableReason = compatibility.relationships.status === 'missing'
                ? 'missing_relationship_navigation'
                : 'incompatible_relationship_navigation';
            return {
                relationshipReady: false,
                relationshipUnavailableReason,
                warning: `RELATIONSHIP_NAVIGATION_UNAVAILABLE:${compatibility.relationships.status}`,
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

    private getSearchNavigationHelpers() {
        return {
            now: () => this.now(),
            sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => this.sanitizeIndexedRelativeFilePath(relativeFilePath),
            isCallGraphLanguageSupported: (language: string, file: string) => this.isCallGraphLanguageSupported(language, file),
            getOutlineStatusForLanguage: (relativeFilePath: string) => this.getOutlineStatusForLanguage(relativeFilePath),
        };
    }

    private async buildChangedCodeDebug(
        preparedRead: Extract<TrackedRootReadinessState, { state: 'ready' }>,
        changedFilesState: { available: boolean; files: Set<string> }
    ): Promise<SearchDebugHint['changedCode'] | undefined> {
        if (!changedFilesState.available || changedFilesState.files.size === 0) {
            return undefined;
        }
        const manifest = await this.loadPreparedNavigationManifest(preparedRead);
        if (manifest.status !== 'ok') return undefined;
        const compatibility = await this.loadPreparedNavigationCompatibility(
            preparedRead,
            manifest.manifestHash,
        );
        if (compatibility.relationships.status !== 'ok') return undefined;
        const confidenceScore = (confidence: RelationshipRecord['confidence']): number => {
            if (confidence === 'high') return 0.95;
            if (confidence === 'medium') return 0.65;
            return 0.35;
        };
        const nodes: CallGraphNode[] = manifest.registry.symbols.map((symbol) => ({
            symbolId: symbol.symbolInstanceId,
            symbolLabel: symbol.label,
            file: symbol.file,
            language: symbol.language,
            span: {
                startLine: symbol.span.startLine,
                endLine: symbol.span.endLine,
            },
        }));
        const symbolsByInstanceId = manifest.registry.symbolsByInstanceId;
        const edges: CallGraphEdge[] = compatibility.relationships.records.flatMap((record) => {
            if (
                record.type !== 'CALLS'
                || !record.sourceInstanceId
                || !record.targetInstanceId
                || !symbolsByInstanceId.has(record.sourceInstanceId)
                || !symbolsByInstanceId.has(record.targetInstanceId)
            ) return [];
            const source = symbolsByInstanceId.get(record.sourceInstanceId)!;
            const startLine = record.span?.startLine ?? source.span.startLine;
            return [{
                srcSymbolId: record.sourceInstanceId,
                dstSymbolId: record.targetInstanceId,
                kind: 'call' as const,
                site: {
                    file: record.file,
                    startLine,
                    ...(record.span?.endLine !== undefined ? { endLine: record.span.endLine } : {}),
                },
                confidence: confidenceScore(record.confidence),
            }];
        });
        return buildSearchChangedCodeDebug({
            graph: { nodes, edges },
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
        return {
            status: 'requires_reindex',
            reason,
            path: codebasePath,
            file: input.file,
            outline: null,
            hasMore: false,
            message: `${detailLine}Publication relationship navigation is missing or incompatible. Automatic maintenance did not recover this state; use manage_index with {"action":"reindex","path":"${codebasePath}"} as the explicit recovery override.`,
            hints: {
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
        sourceBytes: Buffer;
    }): { status: 'fresh' | 'stale' | 'unknown' | 'inconsistent'; registryHash?: string; currentHash?: string } {
        const hashes = Array.from(new Set(input.symbols.map((symbol) => symbol.fileHash).filter(Boolean)));
        if (hashes.length === 0 || hashes.some((hash) => !this.isSha256HexHash(hash))) {
            return { status: 'unknown' };
        }
        if (hashes.length !== 1) {
            return { status: 'inconsistent' };
        }

        const registryHash = hashes[0];
        // The freshness hash is computed over the same bytes the caller
        // already read through an authorized descriptor; this path never
        // re-reads the file by pathname.
        const sourceBytes = input.sourceBytes;
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
            basis: 'descriptor_read',
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

    private async buildRelationshipBackedCallGraph(input: {
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
        pathScope?: import("./navigation-path-scope.js").PublishedPathScope;
        readAuthorizedSourceLines?: (codebaseRoot: string, relativeFilePath: string) => Promise<string[] | undefined>;
        findExactSourceReferences?: (target: SymbolRecord) => Promise<ExactReferenceSearchResult>;
    }): Promise<RelationshipBackedCallGraphResult | null> {
        return this.relationshipBackedCallGraph.build(input);
    }

    private isZillizBackend(): boolean {
        return this.vectorBackendMaintenance.isZillizBackend();
    }

    private async buildCollectionLimitMessage(targetCodebasePath: string): Promise<string> {
        return this.vectorBackendMaintenance.buildCollectionLimitMessage(targetCodebasePath);
    }

    private async recoverStaleIndexCandidates(codebasePath: string) {
        return this.vectorBackendMaintenance.recoverStaleIndexCandidates(codebasePath);
    }

    private async dropZillizCollectionForCreate(collectionName: string) {
        return this.vectorBackendMaintenance.dropZillizCollectionForCreate(collectionName);
    }

    public async handleIndexCodebase(args: IndexCodebaseArgs) {
        return this.manageIndexingHandlers.handleIndexCodebase(args);
    }

    public async handleReindexCodebase(args: ReindexCodebaseArgs) {
        return this.manageIndexingHandlers.handleReindexCodebase(args);
    }

    public async startAutomaticCreate(codebasePath: string) {
        return this.manageIndexingHandlers.startAutomaticCreate(codebasePath);
    }

    public async startAutomaticReindex(codebasePath: string) {
        return this.manageIndexingHandlers.startAutomaticReindex(codebasePath);
    }

    public async handleSearchCode(args: ToolArgs): Promise<SearchToolTextResponse> {
        return this.searchRequestCoordinator.attempt(args, 0);
    }

    public async handleContinueSearch(args: ToolArgs) {
        return this.searchRequestCoordinator.continueOwned(args);
    }

    public releaseSearchContinuationOwnership(): void {
        this.searchRequestCoordinator.releaseContinuationOwnership();
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

    public async handleArchitectureOverview(args: ToolArgs) {
        return this.navigationHandlers.handleArchitectureOverview(args);
    }

    public async handleFindReferences(args: ToolArgs, workspacePolicy: SessionWorkspacePolicy) {
        return this.navigationHandlers.handleFindReferences(args, workspacePolicy);
    }

    public async handleFileOutline(args: FileOutlineInput, workspacePolicy: SessionWorkspacePolicy) {
        return this.navigationHandlers.handleFileOutline(args, workspacePolicy);
    }

    public async handleCallGraph(args: ToolArgs, workspacePolicy: SessionWorkspacePolicy) {
        return this.navigationHandlers.handleCallGraph(args, workspacePolicy);
    }

    public async handleTracePath(args: ToolArgs) {
        return this.navigationHandlers.handleTracePath(args);
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
    public async handleSyncCodebase(args: ToolArgs, requestSignal?: AbortSignal) {
        return this.manageMaintenanceHandlers.handleSyncCodebase(args, requestSignal);
    }

    public async handleCancelIndexOperation(args: ToolArgs) {
        return this.manageMaintenanceHandlers.handleCancelOperation(args);
    }
}
