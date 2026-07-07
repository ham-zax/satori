import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import ignore from "ignore";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    type IndexCompletionMarkerDocument,
    createRuntimeNavigationStore,
    type NavigationStore,
    VoyageAIReranker,
    getSupportedExtensionsForCapability,
    isLanguageCapabilitySupportedForExtension,
    isLanguageCapabilitySupportedForFilename,
    isLanguageCapabilitySupportedForLanguage,
} from "@zokizuan/satori-core";
import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { CapabilityResolver } from "./capabilities.js";
import { AccessGateReason, SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath } from "../utils.js";
import { SyncManager, type FreshnessDecision } from "./sync.js";
import { DEFAULT_MANAGE_RETRY_AFTER_MS, DEFAULT_WATCH_DEBOUNCE_MS, IndexFingerprint, type CodebaseInfo } from "../config.js";
import {
    SEARCH_CHANGED_FILES_CACHE_TTL_MS,
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_MAX_CANDIDATES,
    SEARCH_MUST_RETRY_ROUNDS,
    SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N,
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
    SearchRecommendedNextAction,
    SearchRequestInput,
    SearchResponseEnvelope,
    SearchSpan,
} from "./search-types.js";
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
import { TrackedRootReadiness } from "./tracked-root-readiness.js";
import { NavigationHandlers } from "./navigation-handlers.js";
import { ManageMaintenanceHandlers } from "./manage-maintenance-handlers.js";
import { ManageIndexingHandlers } from "./manage-indexing-handlers.js";
import { VectorBackendMaintenance } from "./vector-backend-maintenance.js";
import { RelationshipBackedCallGraph } from "./relationship-backed-call-graph.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";
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
import { runExactRegistryFastPath } from "./search-exact-fast-path.js";
import { finalizeSearchResults } from "./search-result-finalization.js";
import type {
    SearchQueryPlan,
    SearchResultLike,
} from "./search-lexical-scoring.js";
import type {
    RuntimeOwnerMutationAction,
    RuntimeOwnerMutationGate,
    RuntimeOwnerMutationGateResult,
} from "./runtime-owner.js";

const SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING = 'SEARCH_PARTIAL_INDEX:limit_reached';
const SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING = 'SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE';
const SEARCH_GROUP_PREVIEW_MAX_CHARS = 800;
const SEARCH_DEBUG_CHANGED_CODE_MAX_FILES = 10;
const SEARCH_DEBUG_CHANGED_CODE_MAX_SYMBOLS = 20;
const SEARCH_DEBUG_CHANGED_CODE_MAX_DIRECT_CALLERS = 20;
type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>['reason'];
// Recovery probe threshold for "likely interrupted" indexing states.
// Keep this shorter than snapshot merge stale semantics for better operator UX.
const STALE_INDEXING_RECOVERY_GRACE_MS = 2 * 60_000;

type SearchPhaseTimingKey =
    | 'prepareRead'
    | 'ensureFreshness'
    | 'exactRegistry'
    | 'semanticSearch'
    | 'trackedLexical'
    | 'rerank'
    | 'registryLoad'
    | 'grouping'
    | 'navigationValidation';

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
    message?: unknown;
};
type TrackedRootEntry = {
    path: string;
    info: TrackedCodebaseInfo;
};

type IndexCompletionMarkerContext = {
    getIndexCompletionMarker?: (codebasePath: string) => Promise<IndexCompletionMarkerDocument | null>;
    writeIndexCompletionMarker?: (codebasePath: string, marker: IndexCompletionMarkerDocument) => Promise<void>;
    clearIndexCompletionMarker?: (codebasePath: string) => Promise<void>;
    pruneIndexedCollectionFamily?: (codebasePath: string, keepCollectionName: string) => Promise<string[]>;
    pruneUnprovenStagedCollectionFamily?: (codebasePath: string) => Promise<string[]>;
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
    resolveCollectionName?: (codebasePath: string) => string;
    resolveStagedCollectionName?: (codebasePath: string, generationId: string) => string;
    setWriteCollectionOverride?: (codebasePath: string, collectionName: string | null) => void;
    loadIndexProfileForCodebase?: (codebasePath: string) => IndexProfileView;
    getActiveIgnorePatterns?: (codebasePath?: string) => string[];
    getIndexedExtensionsForCodebase?: (codebasePath: string) => string[];
    getIndexedExtensions?: () => string[];
    getTrackedRelativePaths?: (codebasePath: string) => string[];
};

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
    ensureFingerprintCompatibilityOnAccess?: (codebasePath: string) => SnapshotAccessGateResult;
    markCodebaseCleared?: (codebasePath: string, collectionName?: string) => void;
    saveCodebaseSnapshot?: () => void;
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
        private readonly runtimeOwnerGate: RuntimeOwnerMutationGate | null = null
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
            markCodebaseSearchStateMissing: this.markCodebaseSearchStateMissing.bind(this),
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
            resolveCollectionName: this.resolveCollectionName.bind(this),
            markCodebaseCleared: this.markCodebaseCleared.bind(this),
            saveSnapshotIfSupported: this.saveSnapshotIfSupported.bind(this),
            unwatchCodebase: this.unwatchCodebase.bind(this),
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
            navigationStore: this.navigationStore,
            trackedRootReadiness: this.trackedRootReadiness,
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
            touchWatchedCodebase: this.touchWatchedCodebase.bind(this),
            manageVectorBackendResponse: this.toolResponseBuilders.manageVectorBackendResponse.bind(this.toolResponseBuilders),
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
            writeIndexCompletionMarker: this.writeIndexCompletionMarker.bind(this),
            pruneIndexedCollectionFamily: this.pruneIndexedCollectionFamily.bind(this),
            pruneUnprovenStagedCollectionFamily: this.pruneUnprovenStagedCollectionFamily.bind(this),
            getContextTrackedRelativePaths: this.getContextTrackedRelativePaths.bind(this),
            setIndexingStats: this.setIndexingStats.bind(this),
            rebuildCallGraphForIndex: this.rebuildCallGraphForIndex.bind(this),
            getSnapshotIndexingProgress: this.getSnapshotIndexingProgress.bind(this),
            clearIndexCompletionMarker: this.clearIndexCompletionMarker.bind(this),
            evaluateReindexPreflight: this.evaluateReindexPreflight.bind(this),
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

    private async unwatchCodebase(codebasePath: string): Promise<void> {
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
        const gate = this.snapshotCapabilities().ensureFingerprintCompatibilityOnAccess?.(codebasePath);
        if (!gate || typeof gate.allowed !== 'boolean' || typeof gate.changed !== 'boolean') {
            return { allowed: true, changed: false };
        }
        return gate;
    }

    private saveSnapshotIfSupported(): void {
        this.snapshotCapabilities().saveCodebaseSnapshot?.();
    }

    private canonicalizeCodebasePath(codebasePath: string): string {
        return this.searchQuerySupport.canonicalizeCodebasePath(codebasePath);
    }

    private fallbackCollectionName(codebasePath: string): string {
        const canonicalPath = this.canonicalizeCodebasePath(codebasePath);
        const hash = crypto.createHash('md5').update(canonicalPath).digest('hex').slice(0, 8);
        return `hybrid_code_chunks_${hash}`;
    }

    private resolveCollectionName(codebasePath: string): string {
        return this.contextLifecycle().resolveCollectionName?.(codebasePath)
            || this.fallbackCollectionName(codebasePath);
    }

    private resolveStagedCollectionName(codebasePath: string, generationId: string): string {
        const context = this.contextLifecycle();
        if (typeof context.resolveStagedCollectionName === 'function') {
            return context.resolveStagedCollectionName(codebasePath, generationId);
        }
        const normalizedGenerationId = generationId
            .trim()
            .replace(/[^a-zA-Z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return `${this.resolveCollectionName(codebasePath)}__gen_${normalizedGenerationId || 'run'}`;
    }

    private setWriteCollectionOverride(codebasePath: string, collectionName: string | null): void {
        this.contextLifecycle().setWriteCollectionOverride?.(codebasePath, collectionName);
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

    private async writeIndexCompletionMarker(codebasePath: string, marker: IndexCompletionMarkerDocument): Promise<void> {
        await this.contextLifecycle().writeIndexCompletionMarker?.(codebasePath, marker);
    }

    private async clearIndexCompletionMarker(codebasePath: string): Promise<void> {
        await this.contextLifecycle().clearIndexCompletionMarker?.(codebasePath);
    }

    private async pruneIndexedCollectionFamily(codebasePath: string, keepCollectionName: string): Promise<string[]> {
        const dropped = await this.contextLifecycle().pruneIndexedCollectionFamily?.(codebasePath, keepCollectionName);
        return Array.isArray(dropped) ? dropped.filter((entry): entry is string => typeof entry === 'string') : [];
    }

    private async pruneUnprovenStagedCollectionFamily(codebasePath: string): Promise<string[]> {
        const dropped = await this.contextLifecycle().pruneUnprovenStagedCollectionFamily?.(codebasePath);
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
        const message = result.message
            || "Index mutation is blocked because multiple Satori runtimes with different fingerprints/configs are active.";
        return this.toolResponseBuilders.manageResponse(action, codebasePath, "blocked", message, {
            reason: "runtime_owner_conflict",
            hints: {
                runtimeOwners: result.conflictingOwners || [],
                nextStep: "Restart all Satori MCP clients or run the CLI runtime-owner cleanup command, then retry.",
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

    private async recoverStaleIndexingStateIfNeeded(codebasePath: string): Promise<void> {
        const indexingCodebases = this.getSnapshotIndexingCodebases();
        if (!Array.isArray(indexingCodebases) || !indexingCodebases.includes(codebasePath)) {
            return;
        }
        if (!this.isIndexingStateStale(codebasePath)) {
            return;
        }
        const completionMarkerContext = this.context as unknown as IndexCompletionMarkerContext;
        if (typeof completionMarkerContext.getIndexCompletionMarker !== "function") {
            return;
        }

        let marker: IndexCompletionMarkerDocument | null = null;
        try {
            marker = await completionMarkerContext.getIndexCompletionMarker(codebasePath);
        } catch (error: unknown) {
            console.warn(`[INDEX-RECOVERY] Stale indexing recovery probe failed for '${codebasePath}': ${formatUnknownError(error)}`);
            return;
        }

        const decision = decideInterruptedIndexingRecovery(marker, this.runtimeFingerprint);
        if (decision.action === "promote_indexed") {
            this.snapshotManager.setCodebaseIndexed(codebasePath, decision.stats, decision.indexFingerprint, "verified");
            this.saveSnapshotIfSupported();
            const recoveryMode = decision.reason === "valid_marker_runtime_mismatch"
                ? " using completion marker proof from a different runtime fingerprint"
                : " using completion marker proof";
            console.log(`[INDEX-RECOVERY] Promoted stale indexing state to indexed for '${codebasePath}'${recoveryMode}.`);
            return;
        }

        const lastProgress = this.getSnapshotIndexingProgress(codebasePath);
        this.snapshotManager.setCodebaseIndexFailed(codebasePath, decision.message, lastProgress);
        this.saveSnapshotIfSupported();
        console.log(`[INDEX-RECOVERY] Marked stale indexing state as failed for '${codebasePath}' (${decision.reason}).`);
    }

    private buildManageActionBlockedMessage(codebasePath: string, action: 'create' | 'reindex' | 'sync' | 'clear' | 'repair'): string {
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
        const preferRepair = reason === "missing_marker_doc";
        return {
            completionProof: reason,
            recommendedAction: preferRepair
                ? this.buildRepairHint(codebasePath)
                : this.buildCreateHint(codebasePath),
            ...(preferRepair ? { create: this.buildCreateHint(codebasePath) } : {})
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
            runtimeFingerprint: this.runtimeFingerprint,
            getIndexCompletionMarker: typeof (this.context as unknown as IndexCompletionMarkerContext).getIndexCompletionMarker === 'function'
                ? (markerPath) => (this.context as unknown as IndexCompletionMarkerContext).getIndexCompletionMarker?.(markerPath) ?? Promise.resolve(null)
                : undefined,
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
            status: 'completed';
        };
        indexFingerprint: IndexFingerprint;
    } | null {
        if (completionProof.outcome !== 'valid' && completionProof.outcome !== 'fingerprint_mismatch') {
            return null;
        }

        const marker = completionProof.marker;
        const fingerprint = marker?.fingerprint;
        if (!marker || !fingerprint || typeof fingerprint !== 'object') {
            return null;
        }

        const record = fingerprint as Record<string, unknown>;
        if (
            typeof record.embeddingProvider !== 'string'
            || typeof record.embeddingModel !== 'string'
            || typeof record.vectorStoreProvider !== 'string'
            || typeof record.schemaVersion !== 'string'
        ) {
            return null;
        }

        const embeddingDimension = Number(record.embeddingDimension);
        const indexedFiles = Number(marker.indexedFiles);
        const totalChunks = Number(marker.totalChunks);
        if (
            !Number.isFinite(embeddingDimension)
            || !Number.isFinite(indexedFiles)
            || indexedFiles < 0
            || !Number.isFinite(totalChunks)
            || totalChunks < 0
        ) {
            return null;
        }

        return {
            stats: {
                indexedFiles,
                totalChunks,
                status: 'completed',
            },
            indexFingerprint: {
                embeddingProvider: record.embeddingProvider as IndexFingerprint['embeddingProvider'],
                embeddingModel: record.embeddingModel,
                embeddingDimension,
                vectorStoreProvider: record.vectorStoreProvider as IndexFingerprint['vectorStoreProvider'],
                schemaVersion: record.schemaVersion as IndexFingerprint['schemaVersion'],
            },
        };
    }

    private recoverIndexedSnapshotFromCompletionProof(
        codebasePath: string,
        completionProof: CompletionProofValidationResult
    ): boolean {
        const recovered = this.extractIndexedRecoveryFromCompletionProof(completionProof);
        if (!recovered) {
            return false;
        }

        this.snapshotManager.setCodebaseIndexed(
            codebasePath,
            recovered.stats,
            recovered.indexFingerprint,
            'verified'
        );
        this.saveSnapshotIfSupported();
        return true;
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
            resolveCollectionName?: (codebasePath: string) => string;
        };

        if (typeof context.getVectorStore !== 'function' || typeof context.resolveCollectionName !== 'function') {
            return { state: 'unknown' };
        }

        const vectorStore = context.getVectorStore();
        if (!vectorStore || typeof vectorStore.hasCollection !== 'function') {
            return { state: 'unknown' };
        }

        let collectionName: string;
        try {
            if (typeof context.getActiveIndexedCollectionName === 'function') {
                const activeCollectionName = await context.getActiveIndexedCollectionName(codebasePath);
                if (typeof activeCollectionName === 'string' && activeCollectionName.trim().length > 0) {
                    collectionName = activeCollectionName;
                } else {
                    collectionName = context.resolveCollectionName(codebasePath);
                }
            } else {
                collectionName = context.resolveCollectionName(codebasePath);
            }
        } catch (error) {
            console.warn(`[SEARCH-READINESS] Failed to resolve collection name for '${codebasePath}': ${formatUnknownError(error)}`);
            return { state: 'unknown' };
        }

        if (typeof collectionName !== 'string' || collectionName.trim().length === 0) {
            return { state: 'unknown' };
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

    private async markCodebaseSearchStateMissing(codebasePath: string): Promise<void> {
        const snapshotManager = this.snapshotManager as unknown as {
            removeCodebaseCompletely?: (path: string) => void;
            saveCodebaseSnapshot?: () => void;
        };

        if (typeof snapshotManager.removeCodebaseCompletely === 'function') {
            snapshotManager.removeCodebaseCompletely(codebasePath);
            if (typeof snapshotManager.saveCodebaseSnapshot === 'function') {
                snapshotManager.saveCodebaseSnapshot();
            }
        }

        try {
            await this.unwatchCodebase(codebasePath);
        } catch (error) {
            console.warn(`[SEARCH-READINESS] Failed to unwatch stale codebase '${codebasePath}': ${formatUnknownError(error)}`);
        }
    }

    private summarizeFingerprint(fingerprint: IndexFingerprint): string {
        return `${fingerprint.embeddingProvider}/${fingerprint.embeddingModel}/${fingerprint.embeddingDimension}/${fingerprint.vectorStoreProvider}/${fingerprint.schemaVersion}`;
    }

    private fingerprintsEqual(left: IndexFingerprint, right: IndexFingerprint): boolean {
        return left.embeddingProvider === right.embeddingProvider
            && left.embeddingModel === right.embeddingModel
            && left.embeddingDimension === right.embeddingDimension
            && left.vectorStoreProvider === right.vectorStoreProvider
            && left.schemaVersion === right.schemaVersion;
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

        const compatibility = await this.navigationStore.getCompatibilityState({
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
        if (!normalized || path.isAbsolute(normalized)) {
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
        const currentHash = crypto
            .createHash('sha256')
            .update(fs.readFileSync(input.absoluteFile, 'utf8'), 'utf8')
            .digest('hex');
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

    private async rebuildCallGraphForIndex(codebasePath: string): Promise<void> {
        await this.relationshipBackedCallGraph.rebuildForIndex(codebasePath);
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

    private async dropZillizCollectionForCreate(collectionName: string): Promise<{ droppedCodebasePath?: string }> {
        return this.vectorBackendMaintenance.dropZillizCollectionForCreate(collectionName);
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
        const debug = args?.debug === true;
        const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit);
        const input: SearchRequestInput = {
            path: typeof args.path === 'string' ? args.path : '',
            query: typeof args.query === 'string' ? args.query : '',
            scope,
            resultMode,
            groupBy,
            rankingMode,
            limit: Number.isFinite(rawLimit) ? Math.max(1, rawLimit) : 10,
            debug,
        };

        const isScopeValid = input.scope === 'runtime' || input.scope === 'mixed' || input.scope === 'docs';
        const isResultModeValid = input.resultMode === 'grouped' || input.resultMode === 'raw';
        const isGroupByValid = input.groupBy === 'symbol' || input.groupBy === 'file';
        const isRankingModeValid = input.rankingMode === 'default' || input.rankingMode === 'auto_changed_first';

        if (!isScopeValid || !isResultModeValid || !isGroupByValid || !isRankingModeValid || typeof input.query !== 'string' || input.query.trim().length === 0) {
            const payload = this.buildInvalidSearchRequestPayload({
                path: typeof input.path === 'string' ? input.path : '',
                query: typeof input.query === 'string' ? input.query : '',
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit
            }, 'Invalid search arguments. Required: path, query. Valid scope: runtime|mixed|docs. Valid resultMode: grouped|raw. Valid groupBy: symbol|file. Valid rankingMode: default|auto_changed_first.');
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
        };
        const phaseTimings = this.createSearchPhaseTimings();

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
                    const prepareReadStartedAtMs = this.searchPhaseNowMs();
                    const trackedRootState = await this.trackedRootReadiness.prepareTrackedRootForRead(absolutePath);
                    this.addSearchPhaseTiming(phaseTimings, 'prepareRead', prepareReadStartedAtMs);
                    return trackedRootState;
                },
                preparePostFreshnessTrackedRootRead: (absolutePath) => this.measureSearchPhase(
                    phaseTimings,
                    'prepareRead',
                    () => this.trackedRootReadiness.prepareTrackedRootForRead(absolutePath)
                ),
                ensureSearchFreshness: (effectiveRoot) => this.measureSearchPhase(
                    phaseTimings,
                    'ensureFreshness',
                    () => this.syncManager.ensureFreshness(effectiveRoot, 3 * 60 * 1000)
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
                buildRepairHint: (codebasePath) => this.buildRepairHint(codebasePath),
                buildStaleLocalHint: (codebasePath, reason) => this.buildStaleLocalHint(codebasePath, reason),
                buildStaleLocalMessage: (codebasePath, requestedPath, reason) => this.buildStaleLocalMessage(
                    codebasePath,
                    requestedPath,
                    reason
                ),
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
                partialIndexSearchWarnings,
                freshnessDecision,
            } = frontDoor;

            if (searchableRoot.path !== absolutePath) {
                console.log(`[SEARCH] Auto-resolved subdirectory '${absolutePath}' to indexed root '${searchableRoot.path}'`);
            }
            const encoderEngine = this.context.getEmbeddingEngine();
            const rootTag = `[SEARCH][root=${effectiveRoot}]`;
            console.log(`${rootTag} Searching (requestedPath='${absolutePath}')`);
            console.log(`${rootTag} Query: "${input.query}"`);
            console.log(`${rootTag} Indexing status: Completed`);
            console.log(`${rootTag} 🧠 Using embedding provider: ${encoderEngine.getProvider()} for search`);

            const parsedOperators = this.searchQuerySupport.parseSearchOperators(input.query);
            const semanticQuery = parsedOperators.semanticQuery;
            const queryPlan = this.searchQuerySupport.buildSearchQueryPlan(semanticQuery);
            const maxAttempts = parsedOperators.must.length > 0 ? 1 + SEARCH_MUST_RETRY_ROUNDS : 1;
            let candidateLimit = Math.max(1, Math.min(SEARCH_MAX_CANDIDATES, Math.max(input.limit * 8, 32)));
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
            const initialDebugChangedFilesState = input.debug ? initialObservedChangedFilesState : undefined;
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
            const exactFastPath = await runExactRegistryFastPath({
                absolutePath,
                effectiveRoot,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit,
                debug: Boolean(input.debug),
                rankingMode: input.rankingMode,
                semanticQuery,
                parsedOperators,
                queryPlan,
                freshnessDecision,
                freshnessSummary: initialFreshnessSummary,
                proofDebugHint,
                partialIndexSearchWarnings,
                phaseTimings,
                candidateLimit,
                maxAttempts,
                operatorSummary: initialOperatorSummary,
                filterSummary: initialFilterSummary,
                changedFilesState: initialChangedFilesState,
                debugChangedFilesState: initialDebugChangedFilesState,
                changedFilesCount: initialChangedFilesCount,
                changedFilesBoostSkippedForLargeChangeSet: initialChangedFilesBoostSkippedForLargeChangeSet,
                dirtyFilesNotFreshened: initialDirtyFilesNotFreshened,
                rankingProvenance: initialRankingProvenance,
                previewMaxChars: SEARCH_GROUP_PREVIEW_MAX_CHARS,
            }, {
                searchQuerySupport: this.searchQuerySupport,
                measureSearchPhase: (phase, run) => this.measureSearchPhase(phaseTimings, phase, run),
                loadRegistryManifest: (normalizedRootPath) => this.navigationStore.getManifest({ normalizedRootPath }),
                loadRegistryValidatedCallGraphSidecar: (exactInput) => this.loadRegistryValidatedCallGraphSidecar(exactInput),
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
                await this.touchWatchedCodebase(effectiveRoot);
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

            const execution = await runSearchExecution({
                effectiveRoot,
                scope: input.scope,
                rankingMode: input.rankingMode,
                limit: input.limit,
                debug: Boolean(input.debug),
                semanticQuery,
                parsedOperators,
                queryPlan,
                exactRegistryEligible: exactRegistryFallbackForTrackedLexical,
                exactRegistryFallbackForTrackedLexical,
                freshnessMode: freshnessDecision.mode,
                observedChangedFilesState: initialObservedChangedFilesState,
            }, {
                searchQuerySupport: this.searchQuerySupport,
                semanticSearch: (request) => this.context.semanticSearch(request),
                reranker: this.reranker,
                shouldForceSearchPassFailure: (passId) => this.shouldForceSearchPassFailure(passId),
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

            const envelope = await finalizeSearchResults({
                absolutePath,
                effectiveRoot,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit,
                debug: Boolean(input.debug),
                rankingMode: input.rankingMode,
                freshnessDecision,
                freshnessSummary: {
                    ...execution.freshnessSummary,
                    lastSyncAt: typeof freshnessDecision.lastSyncAt === 'string' ? freshnessDecision.lastSyncAt : null,
                },
                proofDebugHint,
                partialIndexSearchWarnings,
                phaseTimings,
                parsedOperators,
                queryPlan,
                maxAttempts,
                exactRegistryDebug,
                searchSymbolRegistry,
                searchSymbolRegistryManifestHash,
                execution,
            }, {
                searchQuerySupport: this.searchQuerySupport,
                measureSearchPhase: (phase, run) => this.measureSearchPhase(phaseTimings, phase, run),
                loadRegistryManifest: (normalizedRootPath) => this.navigationStore.getManifest({ normalizedRootPath }),
                loadRegistryValidatedCallGraphSidecar: (finalizationInput) => this.loadRegistryValidatedCallGraphSidecar(finalizationInput),
                buildRequiresReindexPayload: (codebasePath, detail, searchContext) => this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope,
                buildChangedCodeDebug: (codebaseRoot, changedFilesState) => this.buildChangedCodeDebug(codebaseRoot, changedFilesState),
                buildGeneratedArtifactsVerificationHint: (codebaseRoot, results) => this.buildGeneratedArtifactsVerificationHint(codebaseRoot, results),
                getSearchNavigationHelpers: () => this.getSearchNavigationHelpers(),
                parseIndexedAtMs: (indexedAt?: string) => this.parseIndexedAtMs(indexedAt),
                resolveSearchOwnerFromRegistry: (result, registry, plan) => this.resolveSearchOwnerFromRegistry(result, registry, plan),
                now: this.now,
            });

            await this.touchWatchedCodebase(effectiveRoot);
            return {
                content: [{ type: "text", text: this.stringifyToolJson(envelope) }],
                meta: { searchDiagnostics }
            };
        } catch (error) {
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                const payload = this.buildVectorBackendSearchPayload(vectorBackendDiagnostic, {
                    path: ensureAbsolutePath(input.path),
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
                    path: typeof input.path === 'string' ? ensureAbsolutePath(input.path) : '',
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
                path: typeof input.path === 'string' ? ensureAbsolutePath(input.path) : '',
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
    public async handleReadCode(args: ToolArgs) {
        const filePath = typeof args.path === 'string' ? args.path : '';

        try {
            const absolutePath = ensureAbsolutePath(filePath);

            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{ type: "text", text: `Error: File '${absolutePath}' not found.` }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isFile()) {
                return {
                    content: [{ type: "text", text: `Error: '${absolutePath}' is not a file.` }],
                    isError: true
                };
            }

            // Read file
            const content = fs.readFileSync(absolutePath, 'utf-8');

            return {
                content: [{
                    type: "text",
                    text: content
                }]
            };
        } catch (error: unknown) {
            return {
                content: [{ type: "text", text: `Error reading file: ${formatUnknownError(error)}` }],
                isError: true
            };
        }
    }
}
