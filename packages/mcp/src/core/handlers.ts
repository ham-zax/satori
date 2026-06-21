import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_MAX_CANDIDATES,
    SEARCH_MUST_RETRY_ROUNDS,
    SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N,
    SEARCH_RERANK_DOC_MAX_CHARS,
    SEARCH_RERANK_DOC_MAX_LINES,
    SEARCH_RERANK_RRF_K,
    SEARCH_RERANK_TOP_K,
    SEARCH_RERANK_WEIGHT,
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
    ManageIndexReason,
    ManageIndexResponseEnvelope,
    ManageIndexStatus,
    ManageReindexPreflightOutcome,
} from "./manage-types.js";
import { WARNING_CODES, WarningCode } from "./warnings.js";
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
    buildNavigationFallback as buildSearchNavigationFallback,
    buildRegistrySymbolCallGraphHint as buildSearchRegistrySymbolCallGraphHint,
    buildRelationshipCallGraphHint as buildSearchRelationshipCallGraphHint,
    buildSearchGroupCallGraphHint as buildSearchGroupNavigationCallGraphHint,
    buildSearchNextActions as buildSearchNavigationNextActions,
    shouldAllowPreviewReadFallback as shouldAllowSearchPreviewReadFallback,
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
import {
    buildRawSearchResults as buildRawSearchResultsHelper,
    buildVisibleGroupedSearchResults as buildVisibleGroupedSearchResultsHelper,
} from "./search-group-results.js";
import {
    buildGroupedSearchEnvelope as buildGroupedSearchEnvelopeHelper,
    buildRawSearchEnvelope as buildRawSearchEnvelopeHelper,
} from "./search-response-envelopes.js";
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
    findExactRegistryMatch,
    shouldAttemptExactRegistryLookup,
    type ExactRegistryLookupDebug,
} from "./search/exact-registry.js";
import { buildExactRegistryHitEnvelope } from "./search-exact-registry-hit.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchFilterSummary,
} from "./search-execution.js";
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

type ReindexPreflightResult = {
    outcome: ManageReindexPreflightOutcome;
    warnings: WarningCode[];
    confidence: "high" | "low";
    probeFailed?: boolean;
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
    private readonly changedFilesCache = new Map<string, {
        expiresAtMs: number;
        available: boolean;
        files: Set<string>;
    }>();
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
        this.searchQuerySupport = new SearchQuerySupport(this as unknown as ConstructorParameters<typeof SearchQuerySupport>[0]);
        this.trackedRootReadiness = new TrackedRootReadiness(this as unknown as ConstructorParameters<typeof TrackedRootReadiness>[0]);
        this.navigationHandlers = new NavigationHandlers(this as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);
        this.manageMaintenanceHandlers = new ManageMaintenanceHandlers(this as unknown as ConstructorParameters<typeof ManageMaintenanceHandlers>[0]);
        this.manageIndexingHandlers = new ManageIndexingHandlers(this as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);
        this.vectorBackendMaintenance = new VectorBackendMaintenance(this as unknown as ConstructorParameters<typeof VectorBackendMaintenance>[0]);
        this.relationshipBackedCallGraph = new RelationshipBackedCallGraph(this as unknown as ConstructorParameters<typeof RelationshipBackedCallGraph>[0]);
        this.toolResponseBuilders = new ToolResponseBuilders(this as unknown as ConstructorParameters<typeof ToolResponseBuilders>[0]);
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
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
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

    private markCodebaseCleared(codebasePath: string, collectionName?: string): void {
        this.snapshotCapabilities().markCodebaseCleared?.(codebasePath, collectionName);
    }

    private buildManageResponseEnvelope(
        action: ManageIndexAction,
        codebasePath: string,
        status: ManageIndexStatus,
        humanText: string,
        options: {
            reason?: ManageIndexReason;
            code?: ManageIndexResponseEnvelope["code"];
            warnings?: WarningCode[];
            hints?: Record<string, unknown>;
            preflight?: ReindexPreflightResult;
            message?: string;
        } = {}
    ): ManageIndexResponseEnvelope {
        const envelope: ManageIndexResponseEnvelope = {
            tool: "manage_index",
            version: 1,
            action,
            path: codebasePath,
            status,
            message: options.message || this.buildCompactManageMessage(humanText),
            humanText,
        };
        if (options.reason) {
            envelope.reason = options.reason;
        }
        if (options.code) {
            envelope.code = options.code;
        }
        if (Array.isArray(options.warnings) && options.warnings.length > 0) {
            envelope.warnings = [...new Set(options.warnings)];
        }
        if (options.hints && Object.keys(options.hints).length > 0) {
            envelope.hints = options.hints;
        }
        if (options.preflight) {
            envelope.preflight = {
                outcome: options.preflight.outcome,
                confidence: options.preflight.confidence,
                probeFailed: options.preflight.probeFailed === true,
            };
        }
        return envelope;
    }

    private buildCompactManageMessage(humanText: string): string {
        const firstLine = humanText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0);
        if (!firstLine) {
            return "";
        }
        return firstLine.length > 240
            ? `${firstLine.slice(0, 237)}...`
            : firstLine;
    }

    private stringifyToolJson(payload: unknown): string {
        return JSON.stringify(payload);
    }

    private manageResponseFromEnvelope(envelope: ManageIndexResponseEnvelope): { content: Array<{ type: "text"; text: string }> } {
        return {
            content: [{
                type: "text",
                text: this.stringifyToolJson(envelope)
            }]
        };
    }

    private manageResponse(
        action: ManageIndexAction,
        codebasePath: string,
        status: ManageIndexStatus,
        humanText: string,
        options: {
            reason?: ManageIndexReason;
            code?: ManageIndexResponseEnvelope["code"];
            warnings?: WarningCode[];
            hints?: Record<string, unknown>;
            preflight?: ReindexPreflightResult;
            message?: string;
        } = {}
    ): { content: Array<{ type: "text"; text: string }> } {
        return this.manageResponseFromEnvelope(
            this.buildManageResponseEnvelope(action, codebasePath, status, humanText, options)
        );
    }

    private manageVectorBackendResponse(
        action: ManageIndexAction,
        codebasePath: string,
        diagnostic: VectorBackendDiagnostic,
        humanText = diagnostic.message
    ): { content: Array<{ type: "text"; text: string }> } {
        return this.manageResponse(action, codebasePath, "error", humanText, {
            reason: "vector_backend_unavailable",
            code: diagnostic.code,
            message: diagnostic.message,
            hints: diagnostic.hints
        });
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
        return this.manageResponse(action, codebasePath, "blocked", message, {
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

    private buildManageActionBlockedMessage(codebasePath: string, action: 'create' | 'reindex' | 'sync' | 'clear'): string {
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
            recommendedAction: this.buildCreateHint(codebasePath)
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

    private buildMissingLocalCollectionMessage(codebasePath: string, requestedPath: string, collectionName?: string): string {
        return this.trackedRootReadiness.buildMissingLocalCollectionMessage(codebasePath, requestedPath, collectionName);
    }

    private buildMissingLocalCollectionSearchPayload(
        codebasePath: string,
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        },
        collectionName?: string
    ): SearchResponseEnvelope {
        return this.trackedRootReadiness.buildMissingLocalCollectionSearchPayload(codebasePath, searchContext, collectionName);
    }

    private buildIndexFailedSearchPayload(
        codebasePath: string,
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        },
        info: TrackedCodebaseInfo
    ): SearchResponseEnvelope {
        return this.trackedRootReadiness.buildIndexFailedSearchPayload(codebasePath, searchContext, info);
    }

    private buildIndexFailedFileOutlinePayload(
        codebasePath: string,
        requestedPath: string,
        file: string,
        info: TrackedCodebaseInfo
    ): FileOutlineResponseEnvelope {
        return this.trackedRootReadiness.buildIndexFailedFileOutlinePayload(codebasePath, requestedPath, file, info);
    }

    private buildIndexFailedCallGraphPayload(
        codebasePath: string,
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        },
        info: TrackedCodebaseInfo
    ): CallGraphResponseEnvelope {
        return this.trackedRootReadiness.buildIndexFailedCallGraphPayload(codebasePath, context, info);
    }

    private buildMissingLocalCollectionFileOutlinePayload(
        codebasePath: string,
        requestedPath: string,
        file: string,
        collectionName?: string
    ): FileOutlineResponseEnvelope {
        return this.trackedRootReadiness.buildMissingLocalCollectionFileOutlinePayload(codebasePath, requestedPath, file, collectionName);
    }

    private buildMissingLocalCollectionCallGraphPayload(
        codebasePath: string,
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        },
        collectionName?: string
    ): CallGraphResponseEnvelope {
        return this.trackedRootReadiness.buildMissingLocalCollectionCallGraphPayload(codebasePath, context, collectionName);
    }

    private async prepareTrackedRootForRead(
        absolutePath: string,
        accessMode: 'semantic' | 'navigation' = 'semantic'
    ) {
        return this.trackedRootReadiness.prepareTrackedRootForRead(absolutePath, accessMode);
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

    private buildSearchExcludeMatcher(
        excludePatterns: unknown,
        effectiveRoot: string,
        absoluteSearchPath: string
    ): { matcher?: ReturnType<typeof ignore>; warning?: string } {
        if (!Array.isArray(excludePatterns) || excludePatterns.length === 0) {
            return {};
        }

        const rawPatterns = excludePatterns
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((v: string) => v.length > 0);
        if (rawPatterns.length === 0) {
            return {};
        }

        const unique: string[] = [];
        const seen = new Set<string>();
        for (const p of rawPatterns) {
            if (!seen.has(p)) {
                seen.add(p);
                unique.push(p);
            }
        }

        const searchRel = path
            .relative(effectiveRoot, absoluteSearchPath)
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
        const needsSubdirPrefix = searchRel.length > 0 && effectiveRoot !== absoluteSearchPath;
        const normalizedPatterns: string[] = [];
        const invalidPatterns: string[] = [];
        for (const rawPattern of unique) {
            let pattern = rawPattern.replace(/\\/g, '/').trim();
            if (!pattern) {
                continue;
            }

            const isNegation = pattern.startsWith('!');
            if (isNegation) {
                pattern = pattern.slice(1);
            }

            const anchored = pattern.startsWith('/');
            pattern = pattern.replace(/^\.\/+/, '').replace(/^\/+/, '');
            if (!pattern) {
                invalidPatterns.push(rawPattern);
                continue;
            }

            if (needsSubdirPrefix && !anchored) {
                pattern = `${searchRel}/${pattern}`.replace(/\/+/g, '/');
            }

            normalizedPatterns.push(isNegation ? `!${pattern}` : pattern);
        }

        if (normalizedPatterns.length === 0) {
            return {
                warning: invalidPatterns.length > 0
                    ? `Note: excludePatterns ignored (invalid patterns): ${JSON.stringify(invalidPatterns)}.`
                    : undefined
            };
        }

        try {
            const matcher = ignore();
            matcher.add(normalizedPatterns);
            return {
                matcher,
                warning: invalidPatterns.length > 0
                    ? `Note: excludePatterns partially applied. Ignored (invalid patterns): ${JSON.stringify(invalidPatterns)}.`
                    : undefined
            };
        } catch (error: unknown) {
            const parseError = formatUnknownError(error);
            const invalidNote = invalidPatterns.length > 0
                ? ` Ignored patterns: ${JSON.stringify(invalidPatterns)}.`
                : '';
            return {
                warning: `Note: excludePatterns ignored due to invalid pattern syntax: ${parseError}.${invalidNote}`
            };
        }
    }

    private applySearchExcludeMatcher(
        searchResults: SearchResultLike[],
        matcher: ReturnType<typeof ignore> | undefined
    ): SearchResultLike[] {
        if (!matcher || searchResults.length === 0) {
            return searchResults;
        }

        return searchResults.filter((result) => {
            if (!result || typeof result.relativePath !== 'string') {
                return true;
            }

            const normalizedPath = result.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!normalizedPath || normalizedPath.startsWith('..')) {
                return true;
            }

            return !matcher.ignores(normalizedPath);
        });
    }

    private normalizeBreadcrumbs(breadcrumbs: unknown): string[] {
        if (!Array.isArray(breadcrumbs)) {
            return [];
        }
        return breadcrumbs
            .filter((crumb): crumb is string => typeof crumb === 'string')
            .map((crumb) => crumb.trim())
            .filter((crumb) => crumb.length > 0)
            .slice(-2);
    }

    private getBreadcrumbMergeKey(breadcrumbs: unknown): string {
        return this.normalizeBreadcrumbs(breadcrumbs).join(' > ');
    }

    private formatScopeLine(breadcrumbs: unknown): string {
        const normalized = this.normalizeBreadcrumbs(breadcrumbs);

        if (normalized.length === 0) {
            return '';
        }

        const joined = normalized.join(' > ');
        const capped = joined.length > 220 ? `${joined.slice(0, 217)}...` : joined;
        return `   🧬 Scope: ${capped}\n`;
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
        const includeUntracked = options.includeUntracked === true;
        const files = new Set<string>();
        const lines = stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
        for (const line of lines) {
            if (line.length < 4) {
                continue;
            }
            const status = line.slice(0, 2);
            if (status === '!!') {
                continue;
            }
            if (status === '??' && !includeUntracked) {
                continue;
            }

            let rawPath = line.slice(3).trim();
            if (rawPath.length === 0) {
                continue;
            }

            if (rawPath.includes(" -> ")) {
                const parts = rawPath.split(" -> ");
                rawPath = parts[parts.length - 1].trim();
            }

            if (rawPath.startsWith("\"") && rawPath.endsWith("\"") && rawPath.length >= 2) {
                rawPath = rawPath.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
            }

            const normalizedPath = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
            if (normalizedPath.length === 0 || normalizedPath.startsWith("..")) {
                continue;
            }

            files.add(normalizedPath);
        }
        return files;
    }

    private getChangedFilesForCodebase(codebasePath: string): { available: boolean; files: Set<string> } {
        const cacheKey = path.resolve(codebasePath);
        const nowMs = this.now();
        const cached = this.changedFilesCache.get(cacheKey);
        if (cached && cached.expiresAtMs > nowMs) {
            return { available: cached.available, files: new Set(cached.files) };
        }

        try {
            const stdout = execFileSync(
                "git",
                ["-C", cacheKey, "status", "--porcelain", "--untracked-files=no"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
            );

            const files = this.parseGitStatusChangedPaths(stdout, { includeUntracked: false });

            this.changedFilesCache.set(cacheKey, {
                expiresAtMs: nowMs + SEARCH_CHANGED_FILES_CACHE_TTL_MS,
                available: true,
                files,
            });
            return { available: true, files };
        } catch {
            if (cached) {
                this.changedFilesCache.set(cacheKey, {
                    expiresAtMs: nowMs + SEARCH_CHANGED_FILES_CACHE_TTL_MS,
                    available: cached.available,
                    files: new Set(cached.files),
                });
                return { available: cached.available, files: new Set(cached.files) };
            }
            this.changedFilesCache.set(cacheKey, {
                expiresAtMs: nowMs + SEARCH_CHANGED_FILES_CACHE_TTL_MS,
                available: false,
                files: new Set<string>(),
            });
            return { available: false, files: new Set<string>() };
        }
    }

    private getWorkingTreeChangedPathsForPreflight(codebasePath: string): { available: boolean; probeFailed: boolean; files: Set<string> } {
        try {
            const stdout = execFileSync(
                "git",
                ["-C", codebasePath, "status", "--porcelain"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
            );
            const files = this.parseGitStatusChangedPaths(stdout, { includeUntracked: true });
            return { available: true, probeFailed: false, files };
        } catch {
            return { available: false, probeFailed: true, files: new Set<string>() };
        }
    }

    private evaluateReindexPreflight(codebasePath: string): ReindexPreflightResult {
        const currentStatus = this.getSnapshotCodebaseStatus(codebasePath);
        const isIndexedLikeStatus = currentStatus === 'indexed' || currentStatus === 'sync_completed';
        if (currentStatus === 'requires_reindex') {
            return {
                outcome: 'reindex_required',
                warnings: [],
                confidence: 'high',
            };
        }

        const gate = this.ensureSnapshotFingerprintCompatibility(codebasePath);
        if (!gate.allowed || gate.changed || !!gate.reason) {
            return {
                outcome: 'reindex_required',
                warnings: [],
                confidence: 'high',
            };
        }

        const workingTree = this.getWorkingTreeChangedPathsForPreflight(codebasePath);
        if (!workingTree.available || workingTree.probeFailed) {
            return {
                outcome: 'probe_failed',
                warnings: [WARNING_CODES.IGNORE_POLICY_PROBE_FAILED],
                confidence: 'low',
                probeFailed: true,
            };
        }

        const changedFiles = [...workingTree.files];
        if (changedFiles.length === 0) {
            return {
                outcome: 'unknown',
                warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
                confidence: 'low',
            };
        }

        const ignoreOnlySet = new Set(['.gitignore', '.satoriignore', 'satori.toml']);
        if (changedFiles.every((changedFile) => ignoreOnlySet.has(changedFile))) {
            if (!isIndexedLikeStatus) {
                return {
                    outcome: 'unknown',
                    warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
                    confidence: 'low',
                };
            }
            return {
                outcome: 'reindex_unnecessary_ignore_only',
                warnings: [WARNING_CODES.REINDEX_UNNECESSARY_IGNORE_ONLY],
                confidence: 'high',
            };
        }

        return {
            outcome: 'unknown',
            warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
            confidence: 'low',
        };
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

    private buildRelationshipCallGraphHint(input: {
        file: string;
        language: string;
        symbolId: string;
        symbolLabel?: string;
        span: { startLine: number; endLine: number };
        sidecarBuiltAt?: string;
    }): CallGraphHint {
        return buildSearchRelationshipCallGraphHint(input, this.getSearchNavigationHelpers());
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

    private shouldAllowPreviewReadFallback(
        callGraphHint: CallGraphHint,
        hasOpenSymbol: boolean
    ): boolean {
        return shouldAllowSearchPreviewReadFallback(callGraphHint, hasOpenSymbol);
    }

    private buildNavigationFallback(
        codebaseRoot: string,
        relativeFilePath: string,
        previewSpan: SearchSpan,
        callGraphHint: CallGraphHint,
        sidecarReadyForOutline: boolean,
        allowPreviewReadFallback: boolean
    ): SearchGroupResult['navigationFallback'] | undefined {
        return buildSearchNavigationFallback(
            codebaseRoot,
            relativeFilePath,
            previewSpan,
            callGraphHint,
            sidecarReadyForOutline,
            allowPreviewReadFallback,
            this.getSearchNavigationHelpers(),
        );
    }

    private buildSearchNextActions(
        codebaseRoot: string,
        relativeFilePath: string,
        span: SearchSpan,
        callGraphHint: CallGraphHint,
        sidecarReadyForOutline: boolean,
        registrySymbol?: SymbolRecord
    ): SearchGroupResult['nextActions'] | undefined {
        return buildSearchNavigationNextActions(
            codebaseRoot,
            relativeFilePath,
            span,
            callGraphHint,
            sidecarReadyForOutline,
            registrySymbol,
            this.getSearchNavigationHelpers(),
        );
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
        return {
            status: 'requires_reindex',
            reason,
            path: codebasePath,
            file: input.file,
            outline: null,
            hasMore: false,
            message: `${detailLine}Relationship-backed navigation sidecars are missing or incompatible. Please run manage_index with {"action":"reindex","path":"${codebasePath}"}.`,
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

    private buildSearchGroupCallGraphHint(input: {
        file: string;
        language: string;
        span: SearchSpan;
        symbolLabel?: string;
        ownerSymbolInstanceId?: string;
        registrySymbol?: SymbolRecord;
        registryLoaded?: boolean;
        registryUnavailableReason?: CallGraphUnavailableReason;
        navigationState: {
            relationshipReady: boolean;
            relationshipBuiltAt?: string;
            relationshipUnavailableReason?: CallGraphUnavailableReason;
        };
    }): CallGraphHint {
        return buildSearchGroupNavigationCallGraphHint(input, this.getSearchNavigationHelpers());
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
                prepareInitialTrackedRootRead: async (absolutePath) => {
                    const prepareReadStartedAtMs = this.searchPhaseNowMs();
                    const trackedRootState = await this.prepareTrackedRootForRead(absolutePath);
                    this.addSearchPhaseTiming(phaseTimings, 'prepareRead', prepareReadStartedAtMs);
                    return trackedRootState;
                },
                preparePostFreshnessTrackedRootRead: (absolutePath) => this.measureSearchPhase(
                    phaseTimings,
                    'prepareRead',
                    () => this.prepareTrackedRootForRead(absolutePath)
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
                buildIndexFailedSearchPayload: (codebasePath, searchContext, info) => this.buildIndexFailedSearchPayload(
                    codebasePath,
                    searchContext,
                    info
                ),
                buildMissingLocalCollectionSearchPayload: (codebasePath, searchContext, collectionName) => this.buildMissingLocalCollectionSearchPayload(
                    codebasePath,
                    searchContext,
                    collectionName
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
            let exactRegistryDebug: ExactRegistryLookupDebug | undefined;
            let searchSymbolRegistry: SymbolRegistry | undefined;
            let searchSymbolRegistryManifestHash: string | undefined;
            let searchSymbolRegistryUnavailableReason: CallGraphUnavailableReason | undefined;
            let exactRegistryFallbackForTrackedLexical = false;

            const hasExactPathFilter = parsedOperators.path.some((pattern) => {
                const normalized = this.searchQuerySupport.normalizeRelativePathForIgnoreCheck(pattern);
                return Boolean(normalized && this.searchQuerySupport.isExactSearchPathFilter(normalized));
            });
            const exactRegistryEligible = input.resultMode === 'grouped'
                && input.groupBy === 'symbol'
                && shouldAttemptExactRegistryLookup({
                    semanticQuery,
                    intent: queryPlan.intent,
                    lexicalTerms: queryPlan.lexicalTerms.map((term) => term.value),
                    quotedLiteralPhrases: queryPlan.quotedLiteralPhrases,
                    hasExactPathFilter,
                });

            if (exactRegistryEligible) {
                exactRegistryFallbackForTrackedLexical = true;
                const registryState = await this.measureSearchPhase(
                    phaseTimings,
                    'registryLoad',
                    () => this.navigationStore.getManifest({ normalizedRootPath: effectiveRoot })
                );
                if (registryState.status === 'ok') {
                    searchSymbolRegistry = registryState.registry;
                    searchSymbolRegistryManifestHash = registryState.manifestHash;
                    const exactRegistryMatch = await this.measureSearchPhase(phaseTimings, 'exactRegistry', async () => findExactRegistryMatch({
                        registry: registryState.registry,
                        semanticQuery,
                        intent: queryPlan.intent,
                        lexicalTerms: queryPlan.lexicalTerms.map((term) => term.value),
                        quotedLiteralPhrases: queryPlan.quotedLiteralPhrases,
                        operators: {
                            path: [...parsedOperators.path],
                        },
                        filterSymbol: this.searchQuerySupport.buildExactRegistrySymbolFilter({
                            scope: input.scope,
                            parsedOperators,
                        }),
                    }));
                    exactRegistryDebug = exactRegistryMatch.debug;

                    if (exactRegistryMatch.status === 'hit') {
                        const exactRegistryRerankDecision = this.searchQuerySupport.resolveRerankDecision(input.scope, queryPlan);
                        const callGraphNavigationState = await this.measureSearchPhase(
                            phaseTimings,
                            'navigationValidation',
                            () => this.loadRegistryValidatedCallGraphSidecar({
                                codebaseRoot: effectiveRoot,
                                registryManifestHash: registryState.manifestHash,
                            })
                        );
                        const exactGroupingStartedAtMs = this.searchPhaseNowMs();
                        const envelope = buildExactRegistryHitEnvelope({
                            codebaseRoot: effectiveRoot,
                            absolutePath,
                            query: input.query,
                            scope: input.scope,
                            groupBy: input.groupBy,
                            limit: input.limit,
                            freshnessDecision,
                            freshnessSummary: initialFreshnessSummary,
                            proofDebugHint,
                            symbol: exactRegistryMatch.symbol,
                            indexedAt: registryState.registry.manifest.builtAt || null,
                            navigationState: callGraphNavigationState,
                            navigationWarning: callGraphNavigationState.warning,
                            sidecarReadyForOutline: true,
                            debug: Boolean(input.debug),
                            debugInput: {
                                queryIntent: {
                                    classification: queryPlan.intent,
                                    confidence: queryPlan.confidence,
                                    reasons: [...queryPlan.reasons],
                                    lexicalTerms: queryPlan.lexicalTerms.map((term) => term.value),
                                    semanticQuery,
                                },
                                retrieval: {
                                    mode: queryPlan.retrievalMode,
                                    scorePolicyKind: queryPlan.scorePolicyKind,
                                    backendScoreKinds: [],
                                },
                                rankingProvenance: {
                                    ...initialRankingProvenance,
                                    semanticPassesUsed: [],
                                    lexicalPassesUsed: [],
                                    livePathSupplementUsed: false,
                                    lexicalFileScanUsed: false,
                                    rerankApplied: false,
                                    exactMatchPinningApplied: false,
                                    registryRepairGroupCount: 0,
                                },
                                phaseTimingsMs: phaseTimings,
                                candidateLimit,
                                mustRetryApplied: parsedOperators.must.length > 0,
                                maxAttempts,
                                operatorSummary: initialOperatorSummary,
                                filterSummary: initialFilterSummary,
                                changedFilesBoost: {
                                    enabled: input.rankingMode === 'auto_changed_first',
                                    applied: false,
                                    available: initialChangedFilesState.available,
                                    changedCount: initialChangedFilesCount,
                                    maxChangedFilesForBoost: SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
                                    skippedForLargeChangeSet: initialChangedFilesBoostSkippedForLargeChangeSet,
                                    multiplier: SEARCH_CHANGED_FIRST_MULTIPLIER,
                                    boostedCandidates: 0,
                                },
                                ...(initialDebugChangedFilesState ? {
                                    changedCode: this.buildChangedCodeDebug(effectiveRoot, initialDebugChangedFilesState),
                                } : {}),
                                rerank: {
                                    enabledByPolicy: exactRegistryRerankDecision.enabledByPolicy,
                                    skippedByScopeDocs: exactRegistryRerankDecision.skippedByScopeDocs,
                                    skippedByIdentifierIntent: exactRegistryRerankDecision.skippedByIdentifierIntent,
                                    capabilityPresent: exactRegistryRerankDecision.capabilityPresent,
                                    rerankerPresent: exactRegistryRerankDecision.rerankerPresent,
                                    enabled: false,
                                    attempted: false,
                                    applied: false,
                                    exactMatchPinningEnabled: exactRegistryRerankDecision.exactMatchPinningEnabled,
                                    exactMatchPinningApplied: false,
                                    candidatesIn: 1,
                                    candidatesReranked: 0,
                                    topK: SEARCH_RERANK_TOP_K,
                                    rankK: SEARCH_RERANK_RRF_K,
                                    weight: SEARCH_RERANK_WEIGHT,
                                    docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
                                    docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
                                },
                                exactRegistry: exactRegistryDebug,
                            },
                            now: this.now,
                            previewMaxChars: SEARCH_GROUP_PREVIEW_MAX_CHARS,
                            navigationHelpers: this.getSearchNavigationHelpers(),
                            partialIndexSearchWarnings,
                            dirtyFilesNotFreshened: initialDirtyFilesNotFreshened,
                            changedFilesBoostSkippedForLargeChangeSet: initialChangedFilesBoostSkippedForLargeChangeSet,
                            buildNoiseMitigationHint: (files) => this.searchQuerySupport.buildNoiseMitigationHint(effectiveRoot, files, input.scope),
                            buildGeneratedArtifactsVerificationHint: (results) => this.buildGeneratedArtifactsVerificationHint(effectiveRoot, results),
                        });
                        this.addSearchPhaseTiming(phaseTimings, 'grouping', exactGroupingStartedAtMs);

                        await this.touchWatchedCodebase(effectiveRoot);
                        return {
                            content: [{ type: "text", text: this.stringifyToolJson(envelope) }],
                            meta: {
                                searchDiagnostics: {
                                    ...searchDiagnostics,
                                    resultsBeforeFilter: exactRegistryMatch.debug.inspectedSymbolCount,
                                    resultsAfterFilter: 1,
                                    searchPassCount: 0,
                                    searchPassSuccessCount: 0,
                                    searchPassFailureCount: 0,
                                }
                            }
                        };
                    }
                } else {
                    exactRegistryDebug = this.searchQuerySupport.buildUnavailableExactRegistryDebug(registryState.reason);
                }
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
                exactRegistryEligible,
                exactRegistryFallbackForTrackedLexical,
                freshnessMode: freshnessDecision.mode,
            }, {
                searchQuerySupport: this.searchQuerySupport,
                semanticSearch: (request) => this.context.semanticSearch(request),
                reranker: this.reranker,
                shouldForceSearchPassFailure: (passId) => this.shouldForceSearchPassFailure(passId),
                classifyVectorBackendError,
                getChangedFilesForCodebase: (codebasePath) => this.getChangedFilesForCodebase(codebasePath),
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
                return {
                    content: [{
                        type: "text",
                        text: "Error searching code: all semantic search passes failed. Please retry and verify embedding/vector backends are reachable."
                    }],
                    isError: true,
                    meta: { searchDiagnostics }
                };
            }

            let {
                scored,
                operatorSummary,
                filterSummary,
                freshnessSummary,
                trackedLexicalDebug,
                candidateLimit: executedCandidateLimit,
                attemptsUsed,
                searchWarnings,
                passesUsed,
                backendScoreKinds,
                exactMatchPinningApplied,
                boostedCandidates,
                changedFilesState,
                debugChangedFilesState,
                changedFilesCount,
                changedFilesBoostSkippedForLargeChangeSet,
                rankingProvenance,
                rerankerAttempted,
                rerankerApplied,
                rerankerFailurePhase,
                rerankerCandidatesIn,
                rerankerCandidatesReranked,
            } = execution;
            freshnessSummary = {
                ...freshnessSummary,
                lastSyncAt: typeof freshnessDecision.lastSyncAt === 'string' ? freshnessDecision.lastSyncAt : null,
            };
            candidateLimit = executedCandidateLimit;
            const rerankDecision = this.searchQuerySupport.resolveRerankDecision(input.scope, queryPlan);
            const mustApplied = parsedOperators.must.length > 0;
            const mustSatisfied = !mustApplied || scored.length > 0;
            let finalizedSearchWarnings = Array.from(new Set([
                ...searchWarnings,
                ...partialIndexSearchWarnings,
            ])).sort();

            const debugHintBase: SearchDebugHint | undefined = input.debug
                ? {
                    queryIntent: {
                        classification: queryPlan.intent,
                        confidence: queryPlan.confidence,
                        reasons: [...queryPlan.reasons],
                        lexicalTerms: queryPlan.lexicalTerms.map((term) => term.value),
                        semanticQuery,
                    },
                    retrieval: {
                        mode: queryPlan.retrievalMode,
                        scorePolicyKind: queryPlan.scorePolicyKind,
                        backendScoreKinds: Array.from(backendScoreKinds).sort(),
                    },
                    rankingProvenance,
                    ...(trackedLexicalDebug ? { trackedLexical: trackedLexicalDebug } : {}),
                    ...(exactRegistryDebug ? { exactRegistry: exactRegistryDebug } : {}),
                    phaseTimingsMs: phaseTimings,
                    passesUsed: Array.from(passesUsed).sort(),
                    candidateLimit,
                    mustRetry: {
                        attempts: attemptsUsed,
                        maxAttempts,
                        applied: mustApplied,
                        satisfied: mustSatisfied,
                        finalCount: scored.length,
                    },
                    operatorSummary,
                    filterSummary,
                    changedFilesBoost: {
                        enabled: input.rankingMode === 'auto_changed_first',
                        applied: boostedCandidates > 0,
                        available: changedFilesState.available,
                        changedCount: changedFilesCount,
                        maxChangedFilesForBoost: SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
                        skippedForLargeChangeSet: changedFilesBoostSkippedForLargeChangeSet,
                        multiplier: SEARCH_CHANGED_FIRST_MULTIPLIER,
                        boostedCandidates,
                    },
                    ...(debugChangedFilesState ? {
                        changedCode: this.buildChangedCodeDebug(effectiveRoot, debugChangedFilesState),
                    } : {}),
                    rerank: {
                        enabledByPolicy: rerankDecision.enabledByPolicy,
                        skippedByScopeDocs: rerankDecision.skippedByScopeDocs,
                        skippedByIdentifierIntent: rerankDecision.skippedByIdentifierIntent,
                        capabilityPresent: rerankDecision.capabilityPresent,
                        rerankerPresent: rerankDecision.rerankerPresent,
                        enabled: rerankDecision.enabled,
                        attempted: rerankerAttempted,
                        applied: rerankerApplied,
                        exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
                        exactMatchPinningApplied,
                        candidatesIn: rerankerCandidatesIn,
                        candidatesReranked: rerankerCandidatesReranked,
                        topK: SEARCH_RERANK_TOP_K,
                        rankK: SEARCH_RERANK_RRF_K,
                        weight: SEARCH_RERANK_WEIGHT,
                        docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
                        docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
                        ...(rerankerFailurePhase ? { errorCode: 'RERANKER_FAILED', failurePhase: rerankerFailurePhase } : {}),
                    },
                }
                : undefined;

            if (input.resultMode === 'raw') {
                const rawResults = buildRawSearchResultsHelper({
                    scored,
                    limit: input.limit,
                    debug: Boolean(input.debug),
                    now: this.now,
                });
                const noiseMitigationHint = this.searchQuerySupport.buildNoiseMitigationHint(effectiveRoot, rawResults.map((result) => result.file), input.scope);
                const generatedArtifactsHint = this.buildGeneratedArtifactsVerificationHint(effectiveRoot, rawResults.map((result) => ({
                    file: result.file,
                    span: result.span,
                })));
                const envelope = buildRawSearchEnvelopeHelper({
                    codebaseRoot: effectiveRoot,
                    absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    limit: input.limit,
                    freshnessDecision,
                    freshnessSummary,
                    warnings: finalizedSearchWarnings,
                    debugHint: debugHintBase,
                    proofDebugHint,
                    noiseMitigationHint,
                    generatedArtifactsHint,
                    results: rawResults,
                });

                await this.touchWatchedCodebase(effectiveRoot);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(envelope) }],
                    meta: { searchDiagnostics }
                };
            }

            const needsRegistryRepair = input.groupBy === 'symbol'
                && scored.some((candidate) => !candidate.result.ownerSymbolKey || !candidate.result.ownerSymbolInstanceId);
            if (input.groupBy === 'symbol' && !searchSymbolRegistry) {
                const registryState = await this.measureSearchPhase(
                    phaseTimings,
                    'registryLoad',
                    () => this.navigationStore.getManifest({ normalizedRootPath: effectiveRoot })
                );
                if (registryState.status === 'ok') {
                    searchSymbolRegistry = registryState.registry;
                    searchSymbolRegistryManifestHash = registryState.manifestHash;
                } else if (registryState.status === 'missing') {
                    searchSymbolRegistryUnavailableReason = 'missing_symbol_registry';
                } else if (registryState.status === 'incompatible' && needsRegistryRepair) {
                    const payload = this.buildRequiresReindexPayload(
                        effectiveRoot,
                        `Symbol registry is incompatible: ${registryState.reason}`,
                        {
                            path: absolutePath,
                            query: input.query,
                            scope: input.scope,
                            groupBy: input.groupBy,
                            resultMode: input.resultMode,
                            limit: input.limit
                        }
                    ) as unknown as SearchResponseEnvelope;
                    return {
                        content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                        meta: { searchDiagnostics }
                    };
                } else if (registryState.status === 'incompatible') {
                    searchSymbolRegistryUnavailableReason = 'incompatible_symbol_registry';
                    searchWarnings.push(`SEARCH_SYMBOL_REGISTRY_UNAVAILABLE:${registryState.status}`);
                    finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();
                }
            }

            const callGraphNavigationState = await this.measureSearchPhase(
                phaseTimings,
                'navigationValidation',
                () => this.loadRegistryValidatedCallGraphSidecar({
                    codebaseRoot: effectiveRoot,
                    registryManifestHash: searchSymbolRegistryManifestHash,
                    registryUnavailableReason: searchSymbolRegistryUnavailableReason,
                })
            );
            if (callGraphNavigationState.warning) {
                searchWarnings.push(`SEARCH_${callGraphNavigationState.warning}`);
                finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();
            }
            const groupingStartedAtMs = this.searchPhaseNowMs();
            const groupedSearchResults = buildVisibleGroupedSearchResultsHelper({
                scored,
                codebaseRoot: effectiveRoot,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                limit: input.limit,
                queryPlan,
                mustMatchesFirst: parsedOperators.must.length > 0,
                registry: searchSymbolRegistry,
                registryUnavailableReason: searchSymbolRegistryUnavailableReason,
                navigationState: callGraphNavigationState,
                sidecarReadyForOutline: Boolean(searchSymbolRegistryManifestHash),
                debug: Boolean(input.debug),
                now: this.now,
                previewMaxChars: SEARCH_GROUP_PREVIEW_MAX_CHARS,
                navigationHelpers: this.getSearchNavigationHelpers(),
                parseIndexedAtMs: (indexedAt?: string) => this.parseIndexedAtMs(indexedAt),
                resolveOwner: (result) => this.resolveSearchOwnerFromRegistry(result as SearchResultLike, searchSymbolRegistry, queryPlan),
            });
            this.addSearchPhaseTiming(phaseTimings, 'grouping', groupingStartedAtMs);
            if (groupedSearchResults.warnings.length > 0) {
                finalizedSearchWarnings = Array.from(new Set([
                    ...finalizedSearchWarnings,
                    ...groupedSearchResults.warnings,
                ])).sort();
            }
            if (groupedSearchResults.exactMatchPinningApplied) {
                exactMatchPinningApplied = true;
                rankingProvenance.exactMatchPinningApplied = true;
            }
            rankingProvenance.registryRepairGroupCount += groupedSearchResults.registryRepairGroupCount;

            const visibleGroupedResults = groupedSearchResults.visibleResults;
            const noiseMitigationHint = this.searchQuerySupport.buildNoiseMitigationHint(effectiveRoot, visibleGroupedResults.map((result) => result.file), input.scope);
            const generatedArtifactsHint = this.buildGeneratedArtifactsVerificationHint(effectiveRoot, visibleGroupedResults.map((result) => ({
                file: result.file,
                span: result.span,
            })));
            const groupedDebugHint = debugHintBase
                ? {
                    ...debugHintBase,
                    diversitySummary: groupedSearchResults.diversitySummary,
                } satisfies SearchDebugHint
                : undefined;

            const envelope = buildGroupedSearchEnvelopeHelper({
                codebaseRoot: effectiveRoot,
                absolutePath,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                limit: input.limit,
                freshnessDecision,
                freshnessSummary,
                warnings: finalizedSearchWarnings,
                debugHint: groupedDebugHint,
                proofDebugHint,
                noiseMitigationHint,
                generatedArtifactsHint,
                results: visibleGroupedResults,
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
                return {
                    content: [{ type: "text", text: COLLECTION_LIMIT_MESSAGE }]
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
