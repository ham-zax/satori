import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import ignore from "ignore";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    createRuntimeNavigationStore,
    type NavigationStore,
    VoyageAIReranker,
    RemoteCollectionDeletePendingError,
    deleteCollectionWithVerification,
    getGraphNeighbors,
    getLanguageIdFromFilename,
    getSupportedExtensionsForCapability,
    isLanguageCapabilitySupportedForExtension,
    isLanguageCapabilitySupportedForFilename,
    isLanguageCapabilitySupportedForLanguage,
    resolveOwnerSymbolForChunk,
} from "@zokizuan/satori-core";
import type { CodeChunk, SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { CapabilityResolver } from "./capabilities.js";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "../utils.js";
import { SyncManager, type FreshnessDecision } from "./sync.js";
import { DEFAULT_MANAGE_RETRY_AFTER_MS, DEFAULT_WATCH_DEBOUNCE_MS, IndexFingerprint } from "../config.js";
import {
    SEARCH_CHANGED_FILES_CACHE_TTL_MS,
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_DIVERSITY_MAX_PER_FILE,
    SEARCH_DIVERSITY_MAX_PER_SYMBOL,
    SEARCH_DIVERSITY_RELAXED_FILE_CAP,
    SEARCH_MAX_CANDIDATES,
    SEARCH_MUST_RETRY_MULTIPLIER,
    SEARCH_MUST_RETRY_ROUNDS,
    SEARCH_NOISE_HINT_PATTERNS,
    SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N,
    SEARCH_NOISE_HINT_THRESHOLD,
    SEARCH_NOISE_HINT_TOP_K,
    SEARCH_OPERATOR_PREFIX_MAX_CHARS,
    SEARCH_PROXIMITY_WINDOW,
    SEARCH_RERANK_DOC_MAX_CHARS,
    SEARCH_RERANK_DOC_MAX_LINES,
    SEARCH_RERANK_RRF_K,
    SEARCH_RERANK_TOP_K,
    SEARCH_RERANK_WEIGHT,
    SEARCH_RRF_K,
    SCOPE_PATH_MULTIPLIERS,
    STALENESS_THRESHOLDS_MS,
    PathCategory,
    SearchGroupBy,
    SearchNoiseCategory,
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
    FileOutlineSymbolResult,
    NonOkReason,
    SearchChunkResult,
    SearchDebugHint,
    SearchGroupResult,
    SearchFreshnessSummary,
    SearchNoiseMitigationHint,
    SearchOperatorSummary,
    SearchRequestInput,
    SearchResponseEnvelope,
    SearchSpan,
    StalenessBucket
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
import type {
    RuntimeOwnerMutationAction,
    RuntimeOwnerMutationGate,
    RuntimeOwnerMutationGateResult,
} from "./runtime-owner.js";

const COLLECTION_LIMIT_PATTERNS = [
    /exceeded the limit number of collections/i,
    /collection limit/i,
    /too many collections/i,
    /quota.*collection/i,
];

const SATORI_COLLECTION_PREFIXES = ['code_chunks_', 'hybrid_code_chunks_'];
const ZILLIZ_FREE_TIER_COLLECTION_LIMIT = 5;
const OUTLINE_SUPPORTED_EXTENSIONS = getSupportedExtensionsForCapability('fileOutline');
const MIN_RELIABLE_COLLECTION_CREATED_AT_MS = Date.UTC(2000, 0, 1);
const SEARCH_OPERATOR_KEYS = new Set(['lang', 'path', '-path', 'must', 'exclude']);
const SEARCH_QUERY_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'find', 'for', 'from', 'how',
    'in', 'is', 'it', 'logic', 'of', 'or', 'the', 'to', 'used', 'uses', 'using',
    'what', 'where', 'which', 'who', 'why'
]);
const NAVIGATION_FALLBACK_MESSAGE = 'Call graph not available for this result; use readSpan or fileOutlineWindow to navigate.';
const PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_DETAIL = 'Partial index/search data may exist, but navigation sidecars were not published because indexing stopped before completion.';
const SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING = 'SEARCH_PARTIAL_INDEX:limit_reached';
const SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING = 'SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE';
const SEARCH_NAVIGATION_NEXT_STEP = 'Open the selected result, then call call_graph with nextActions.callGraph args and a listed direction when callGraphHint.supported=true; otherwise use navigationFallback.readSpan.';
const SEARCH_GROUP_PREVIEW_MAX_CHARS = 800;
const SEARCH_LIVE_PATH_SUPPLEMENT_MAX_BYTES = 256 * 1024;
const SEARCH_LIVE_PATH_SUPPLEMENT_MAX_FILES = 8;
const SEARCH_LIVE_PATH_SUPPLEMENT_MAX_RESULTS = 8;
const SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES = 2;
const SEARCH_TRACKED_LEXICAL_MAX_BYTES = 192 * 1024;
const SEARCH_TRACKED_LEXICAL_MAX_FILES = 128;
const SEARCH_TRACKED_LEXICAL_MAX_RESULTS = 16;
const SEARCH_TRACKED_LEXICAL_CONTEXT_LINES = 2;
const SEARCH_TRACKED_LEXICAL_TOTAL_BYTES = 2 * 1024 * 1024;
const SEARCH_AGENT_FIT_NEUTRAL = 1.0;
const SEARCH_AGENT_FIT_TEST_INTENT_MULTIPLIER = 1.25;
const SEARCH_AGENT_FIT_TEST_DEMOTION_RUNTIME = 0.45;
const SEARCH_AGENT_FIT_TEST_DEMOTION_MIXED = 0.65;
const SEARCH_AGENT_FIT_IMPLEMENTATION_TEST_DEMOTION = 0.25;
const SEARCH_AGENT_FIT_IMPLEMENTATION_SYMBOL_MULTIPLIER = 1.25;
const SEARCH_AGENT_FIT_IMPLEMENTATION_CHUNK_MULTIPLIER = 1.15;
const SEARCH_AGENT_FIT_SCRIPT_IMPLEMENTATION_MULTIPLIER = 1.30;
const SEARCH_AGENT_FIT_WRITER_OWNER_MULTIPLIER = 2.25;
const SEARCH_AGENT_FIT_WRITER_NON_OWNER_DEMOTION = 0.55;
const SEARCH_AGENT_FIT_TYPE_DEMOTION = 0.72;
const SEARCH_AGENT_FIT_SCHEMA_DEMOTION = 0.80;
const SEARCH_AGENT_FIT_ANONYMOUS_DEMOTION = 0.70;
type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>['reason'];
// Recovery probe threshold for "likely interrupted" indexing states.
// Keep this shorter than snapshot merge stale semantics for better operator UX.
const STALE_INDEXING_RECOVERY_GRACE_MS = 2 * 60_000;

type ParsedSearchOperators = {
    semanticQuery: string;
    prefixBlockChars: number;
    lang: string[];
    path: string[];
    excludePath: string[];
    must: string[];
    exclude: string[];
};

type SearchCandidate = {
    result: any;
    baseScore: number;
    backendScore: number;
    backendScoreKind: 'dense_similarity' | 'lexical_rank' | 'rrf_fusion' | 'unknown';
    backendScoreKindsSeen: Array<'dense_similarity' | 'lexical_rank' | 'rrf_fusion' | 'unknown'>;
    fusionScore: number;
    lexicalScore: number;
    finalScore: number;
    pathCategory: PathCategory;
    pathMultiplier: number;
    changedFilesMultiplier: number;
    agentFitMultiplier: number;
    agentFitReason: string;
    passesMatchedMust: boolean;
    exactLexicalMatch: boolean;
    exactMatchPinned: boolean;
    rerankAdjusted: boolean;
    retrievalPasses: string[];
};

type SearchOwnerSource = 'owner_metadata' | 'registry_repair' | 'fallback';

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

type TrackedLexicalSearchDebug = {
    enabled: boolean;
    trackedPathCount: number;
    filesConsidered: number;
    filesScanned: number;
    bytesRead: number;
    cappedByFiles: boolean;
    cappedByBytes: boolean;
    returnedResults: number;
};

type SearchOwnerResolution = {
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    symbolKind?: string;
    ownerSource?: Extract<SearchOwnerSource, 'owner_metadata' | 'registry_repair'>;
};

type SearchQueryIntent = 'identifier' | 'semantic' | 'mixed' | 'uncertain';
type SearchIntentConfidence = 'high' | 'medium' | 'low';
type SearchLexicalTermKind = 'whole' | 'fragment';

type SearchLexicalTerm = {
    value: string;
    kind: SearchLexicalTermKind;
};

type SearchQueryPlan = {
    semanticQuery: string;
    intent: SearchQueryIntent;
    confidence: SearchIntentConfidence;
    reasons: string[];
    quotedLiteralPhrases: string[];
    referenceSeeking: boolean;
    testSeeking: boolean;
    implementationSeeking: boolean;
    writerSeeking: boolean;
    lexicalTerms: SearchLexicalTerm[];
    retrievalMode: 'dense' | 'lexical' | 'hybrid';
    scorePolicyKind: 'dense_similarity_min' | 'topk_only';
    lexicalWeight: number;
    exactMatchPinningEnabled: boolean;
    rerankAllowed: boolean;
};

type SearchLexicalEvidence = {
    score: number;
    exactLexicalMatch: boolean;
};

type SearchFilterSummary = {
    removedByScope: number;
    removedByLanguage: number;
    removedByPathInclude: number;
    removedByPathExclude: number;
    removedByMust: number;
    removedByExclude: number;
};

type SearchDiversitySummary = {
    maxPerFile: number;
    maxPerSymbol: number;
    relaxedFileCap: number;
    skippedByFileCap: number;
    skippedBySymbolCap: number;
    usedRelaxedCap: boolean;
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

type CompletionProbeDebugHint = { ok: false; reason: "probe_failed" };

interface CandidateCollection {
    name: string;
    createdAt?: string;
    codebasePath?: string;
    isTargetCollection: boolean;
    sortTimestampMs?: number;
}

interface CollectionDetailsView {
    name: string;
    createdAt?: string;
}

interface VectorStoreBackendInfoView {
    provider: 'milvus' | 'zilliz';
    transport: 'grpc' | 'rest';
    address?: string;
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
        collectErrorFragments((value as any).cause, output, visited, depth + 1);
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

function isCollectionLimitError(error: unknown): boolean {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    const message = formatUnknownError(error);
    if (message === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    return COLLECTION_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

function isBackendTimeoutError(error: unknown): boolean {
    const message = formatUnknownError(error);
    return /DEADLINE_EXCEEDED|deadline exceeded|timeout|timed out/i.test(message);
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
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
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

    private buildStatusHint(codebasePath: string): { tool: string; args: { action: string; path: string } } {
        return {
            tool: "manage_index",
            args: {
                action: "status",
                path: codebasePath
            }
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
        const info = this.snapshotManager.getCodebaseInfo(codebasePath);
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
        const info = this.snapshotManager.getCodebaseInfo(codebasePath);
        if (!info || info.status !== "indexing") {
            return false;
        }

        const lastUpdatedMs = Date.parse(info.lastUpdated);
        if (!Number.isFinite(lastUpdatedMs)) {
            return true;
        }

        return (this.now() - lastUpdatedMs) > graceMs;
    }

    private async recoverStaleIndexingStateIfNeeded(codebasePath: string): Promise<void> {
        const indexingCodebases = this.snapshotManager.getIndexingCodebases?.();
        if (!Array.isArray(indexingCodebases) || !indexingCodebases.includes(codebasePath)) {
            return;
        }
        if (!this.isIndexingStateStale(codebasePath)) {
            return;
        }
        if (typeof (this.context as any).getIndexCompletionMarker !== "function") {
            return;
        }

        let marker: any = null;
        try {
            marker = await (this.context as any).getIndexCompletionMarker(codebasePath);
        } catch (error: any) {
            console.warn(`[INDEX-RECOVERY] Stale indexing recovery probe failed for '${codebasePath}': ${formatUnknownError(error)}`);
            return;
        }

        const decision = decideInterruptedIndexingRecovery(marker, this.runtimeFingerprint);
        if (decision.action === "promote_indexed") {
            this.snapshotManager.setCodebaseIndexed(codebasePath, decision.stats, this.runtimeFingerprint, "verified");
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[INDEX-RECOVERY] Promoted stale indexing state to indexed for '${codebasePath}' using completion marker proof.`);
            return;
        }

        const lastProgress = this.snapshotManager.getIndexingProgress(codebasePath);
        this.snapshotManager.setCodebaseIndexFailed(codebasePath, decision.message, lastProgress);
        this.snapshotManager.saveCodebaseSnapshot();
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
            getIndexCompletionMarker: typeof (this.context as any).getIndexCompletionMarker === 'function'
                ? (markerPath) => (this.context as any).getIndexCompletionMarker(markerPath)
                : undefined,
            onProbeError: (error) => {
                console.warn(`[INDEX-PROOF] Completion marker probe failed for '${codebasePath}': ${formatUnknownError(error)}`);
            }
        });
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

    private resolveTrackedRoot(
        absolutePath: string,
        statuses: Array<'indexed' | 'sync_completed' | 'indexing' | 'requires_reindex'>
    ): { path: string; info: any } | null {
        const statusSet = new Set(statuses);
        const allEntries = typeof this.snapshotManager.getAllCodebases === 'function'
            ? this.snapshotManager.getAllCodebases()
            : [];

        const mergedByPath = new Map<string, { path: string; info: any }>();
        for (const entry of allEntries) {
            if (!entry || typeof entry.path !== 'string' || !entry.info) {
                continue;
            }
            mergedByPath.set(entry.path, { path: entry.path, info: entry.info });
        }

        if (typeof this.snapshotManager.getIndexedCodebases === 'function') {
            for (const codebasePath of this.snapshotManager.getIndexedCodebases()) {
                if (!mergedByPath.has(codebasePath)) {
                    mergedByPath.set(codebasePath, { path: codebasePath, info: { status: 'indexed' } });
                }
            }
        }

        if (typeof this.snapshotManager.getIndexingCodebases === 'function') {
            for (const codebasePath of this.snapshotManager.getIndexingCodebases()) {
                if (!mergedByPath.has(codebasePath)) {
                    mergedByPath.set(codebasePath, { path: codebasePath, info: { status: 'indexing' } });
                }
            }
        }

        const matches = Array.from(mergedByPath.values())
            .filter((entry) => statusSet.has(entry.info.status as any) && this.isPathWithinCodebase(absolutePath, entry.path))
            .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
        if (matches.length === 0) {
            return null;
        }
        return matches[0];
    }

    private async probeLocalSearchCollectionState(codebasePath: string): Promise<{
        state: 'ready' | 'missing' | 'unknown';
        collectionName?: string;
    }> {
        const context = this.context as unknown as {
            getVectorStore?: () => { hasCollection?: (collectionName: string) => Promise<boolean> | boolean };
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
            collectionName = context.resolveCollectionName(codebasePath);
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
        const requestedPathDetail = requestedPath !== codebasePath
            ? ` Requested path: '${requestedPath}'.`
            : '';
        const collectionDetail = collectionName
            ? ` Vector collection is missing from the configured vector backend ('${collectionName}').`
            : ' Vector collection is missing from the configured vector backend.';
        return `Codebase '${codebasePath}' has stale local index metadata.${collectionDetail}${requestedPathDetail} Read paths fail closed and will not rebuild implicitly. Run manage_index with {"action":"create","path":"${codebasePath}"} to restore local readiness.`;
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
        return {
            status: "not_indexed",
            reason: "not_indexed",
            codebasePath,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            freshnessDecision: null,
            message: this.buildMissingLocalCollectionMessage(codebasePath, searchContext.path, collectionName),
            hints: {
                create: this.buildCreateHint(codebasePath)
            },
            results: []
        } as SearchResponseEnvelope;
    }

    private buildMissingLocalCollectionFileOutlinePayload(
        codebasePath: string,
        requestedPath: string,
        file: string,
        collectionName?: string
    ): FileOutlineResponseEnvelope {
        return {
            status: 'not_indexed',
            reason: 'not_indexed',
            path: requestedPath,
            file,
            outline: null,
            hasMore: false,
            message: this.buildMissingLocalCollectionMessage(codebasePath, requestedPath, collectionName),
            hints: {
                create: this.buildCreateHint(codebasePath)
            }
        };
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
        return {
            status: 'not_indexed',
            supported: false,
            reason: 'not_indexed',
            path: context.path,
            codebaseRoot: codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            message: this.buildMissingLocalCollectionMessage(codebasePath, context.path, collectionName),
            hints: {
                create: this.buildCreateHint(codebasePath)
            }
        };
    }

    private async prepareTrackedRootForRead(absolutePath: string): Promise<
        | { state: 'ready'; root: { path: string; info: any }; proofDebugHint?: CompletionProbeDebugHint }
        | { state: 'requires_reindex'; codebasePath: string; message?: string }
        | { state: 'indexing'; codebasePath: string }
        | { state: 'not_indexed' }
        | { state: 'stale_local'; codebasePath: string; reason: CompletionProofReason }
        | { state: 'missing_collection'; codebasePath: string; collectionName?: string; proofDebugHint?: CompletionProbeDebugHint }
    > {
        this.refreshSnapshotStateFromDisk();

        const blockedRoot = this.getMatchingBlockedRoot(absolutePath);
        if (blockedRoot) {
            return {
                state: 'requires_reindex',
                codebasePath: blockedRoot.path,
                message: blockedRoot.message
            };
        }

        const searchableRoot = this.resolveTrackedRoot(absolutePath, ['indexed', 'sync_completed']);
        const indexingRoot = this.resolveTrackedRoot(absolutePath, ['indexing']);

        if (!searchableRoot && indexingRoot) {
            return {
                state: 'indexing',
                codebasePath: indexingRoot.path
            };
        }

        if (!searchableRoot) {
            return {
                state: 'not_indexed'
            };
        }

        const effectiveRoot = searchableRoot.path;
        const gateResult = this.enforceFingerprintGate(effectiveRoot);
        if (gateResult.blockedResponse) {
            return {
                state: 'requires_reindex',
                codebasePath: effectiveRoot,
                message: gateResult.message
            };
        }

        const completionProof = await this.validateCompletionProof(effectiveRoot);
        if (completionProof.outcome === 'fingerprint_mismatch') {
            return {
                state: 'requires_reindex',
                codebasePath: effectiveRoot,
                message: 'Completion proof fingerprint does not match the current runtime fingerprint.'
            };
        }

        if (completionProof.outcome === 'stale_local') {
            return {
                state: 'stale_local',
                codebasePath: effectiveRoot,
                reason: completionProof.reason || 'missing_marker_doc'
            };
        }

        const proofDebugHint: CompletionProbeDebugHint | undefined = completionProof.outcome === 'probe_failed'
            ? { ok: false, reason: 'probe_failed' }
            : undefined;

        const collectionState = await this.probeLocalSearchCollectionState(effectiveRoot);
        if (collectionState.state === 'missing') {
            await this.markCodebaseSearchStateMissing(effectiveRoot);
            return {
                state: 'missing_collection',
                codebasePath: effectiveRoot,
                collectionName: collectionState.collectionName,
                proofDebugHint
            };
        }

        return {
            state: 'ready',
            root: searchableRoot,
            proofDebugHint
        };
    }

    private summarizeFingerprint(fingerprint: IndexFingerprint): string {
        return `${fingerprint.embeddingProvider}/${fingerprint.embeddingModel}/${fingerprint.embeddingDimension}/${fingerprint.vectorStoreProvider}/${fingerprint.schemaVersion}`;
    }

    private buildCompatibilityDiagnostics(codebasePath: string): FingerprintCompatibilityDiagnostics {
        const info = typeof (this.snapshotManager as any).getCodebaseInfo === 'function'
            ? this.snapshotManager.getCodebaseInfo(codebasePath)
            : undefined;
        const statusAtCheck = info?.status
            || (typeof (this.snapshotManager as any).getCodebaseStatus === 'function'
                ? this.snapshotManager.getCodebaseStatus(codebasePath)
                : 'not_found');
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
        const detailLine = detail ? `${detail}\n\n` : '';
        const base = searchContext ? {
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
        } : {};
        return {
            ...base,
            status: "requires_reindex",
            reason: "requires_reindex" as NonOkReason,
            codebasePath,
            results: [],
            freshnessDecision: {
                mode: "skipped_requires_reindex"
            },
            message: `${detailLine}The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {\"action\":\"reindex\",\"path\":\"${codebasePath}\"}.`,
            hints: {
                reindex: this.buildReindexHint(codebasePath)
            },
            compatibility: this.buildCompatibilityDiagnostics(codebasePath)
        };
    }

    private buildRequiresReindexSearchResponse(
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
    ): { content: Array<{ type: string; text: string }> } {
        return {
            content: [{
                type: "text",
                text: this.stringifyToolJson(this.buildRequiresReindexPayload(codebasePath, detail, searchContext))
            }]
        };
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
        const detailLine = detail ? `${detail}\n\n` : '';
        return {
            status: "requires_reindex",
            supported: false,
            reason,
            path: context.path,
            codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            freshnessDecision: {
                mode: "skipped_requires_reindex"
            },
            message: `${detailLine}The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {"action":"reindex","path":"${codebasePath}"}.`,
            hints: {
                reindex: this.buildReindexHint(codebasePath)
            },
            compatibility: this.buildCompatibilityDiagnostics(codebasePath)
        };
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
        return {
            status: "not_ready",
            reason: "indexing",
            codebasePath,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            freshnessDecision: {
                mode: "skipped_indexing"
            },
            message: `Codebase '${codebasePath}' is currently indexing. Wait for indexing to complete, then retry.`,
            hints: {
                status: this.buildStatusHint(codebasePath),
                debugIndexing: {
                    completionProof: "marker_doc"
                }
            },
            indexing: this.buildIndexingMetadata(codebasePath),
            results: []
        } as SearchResponseEnvelope;
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
        switch (freshnessDecision.mode) {
            case 'skipped_indexing':
                return this.buildNotReadySearchPayload(codebasePath, searchContext);

            case 'skipped_requires_reindex': {
                const detail = freshnessDecision.errorMessage
                    ? `Search blocked because this codebase requires reindex (${freshnessDecision.errorMessage}).`
                    : 'Search blocked because this codebase requires reindex.';
                const payload = this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope;
                return {
                    ...payload,
                    freshnessDecision
                };
            }

            case 'skipped_missing_path':
                return {
                    status: "not_indexed",
                    reason: "not_indexed",
                    codebasePath,
                    path: searchContext.path,
                    query: searchContext.query,
                    scope: searchContext.scope,
                    groupBy: searchContext.groupBy,
                    resultMode: searchContext.resultMode,
                    limit: searchContext.limit,
                    freshnessDecision,
                    message: `Indexed codebase path '${codebasePath}' no longer exists. Search cannot serve stale vector results for this path.`,
                    hints: {
                        create: this.buildCreateHint(searchContext.path)
                    },
                    results: []
                } as SearchResponseEnvelope;

            case 'ignore_reload_failed': {
                const fallbackLine = freshnessDecision.fallbackSyncExecuted
                    ? ' Fallback incremental sync was executed, but ignore-rule reconciliation did not complete deterministically.'
                    : '';
                const detail = `Search blocked because ignore-rule reconciliation failed (${freshnessDecision.errorMessage || 'unknown_ignore_reload_error'}).${fallbackLine}`;
                const payload = this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope;
                return {
                    ...payload,
                    freshnessDecision
                };
            }

            case 'coalesced':
                if (typeof freshnessDecision.errorMessage === 'string'
                    && freshnessDecision.errorMessage.trim().length > 0) {
                    const fallbackLine = freshnessDecision.fallbackSyncExecuted
                        ? ' Fallback incremental sync was executed, but freshness still could not be proven.'
                        : '';
                    const detail = `Search blocked because coalesced in-flight sync failed (${freshnessDecision.errorMessage}).${fallbackLine}`;
                    const payload = this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope;
                    return {
                        ...payload,
                        freshnessDecision
                    };
                }
                return null;

            case 'synced':
            case 'skipped_recent':
            case 'reconciled_ignore_change':
                return null;

            default: {
                const exhaustive: never = freshnessDecision.mode;
                return exhaustive;
            }
        }
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
        return {
            status: "not_ready",
            reason: "vector_backend_unavailable",
            code: diagnostic.code,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            freshnessDecision: null,
            message: diagnostic.message,
            hints: diagnostic.hints,
            results: []
        } as SearchResponseEnvelope;
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
        return {
            status,
            ...(reason ? { reason } : {}),
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            freshnessDecision: null,
            message,
            results: []
        } as SearchResponseEnvelope;
    }

    private buildNotReadyFileOutlinePayload(codebasePath: string, file: string, requestedPath: string): FileOutlineResponseEnvelope & Record<string, unknown> {
        return {
            status: 'not_ready',
            reason: 'indexing',
            path: requestedPath,
            codebaseRoot: codebasePath,
            file,
            outline: null,
            hasMore: false,
            message: `Codebase '${codebasePath}' is currently indexing. Wait for indexing to complete, then retry file outline.`,
            hints: {
                status: this.buildStatusHint(codebasePath),
                debugIndexing: {
                    completionProof: "marker_doc"
                }
            },
            indexing: this.buildIndexingMetadata(codebasePath)
        };
    }

    private buildNotIndexedFileOutlinePayload(
        file: string,
        requestedPath: string,
        staleLocal?: { codebaseRoot: string; reason: CompletionProofReason }
    ): FileOutlineResponseEnvelope & Record<string, unknown> {
        if (staleLocal) {
            return {
                status: 'not_indexed',
                reason: 'not_indexed',
                path: requestedPath,
                file,
                outline: null,
                hasMore: false,
                message: this.buildStaleLocalMessage(staleLocal.codebaseRoot, requestedPath, staleLocal.reason),
                hints: {
                    create: this.buildCreateHint(staleLocal.codebaseRoot),
                    staleLocal: this.buildStaleLocalHint(staleLocal.codebaseRoot, staleLocal.reason)
                }
            };
        }
        return {
            status: 'not_indexed',
            reason: 'not_indexed',
            path: requestedPath,
            file,
            outline: null,
            hasMore: false,
            message: `Codebase '${requestedPath}' (or any parent) is not indexed.`,
            hints: {
                create: this.buildCreateHint(requestedPath)
            }
        };
    }

    private buildInvalidFileOutlineRequestPayload(
        requestedPath: string,
        file: string,
        message: string,
        status: FileOutlineStatus = "not_ready",
        reason?: NonOkReason
    ): FileOutlineResponseEnvelope {
        return {
            status,
            ...(reason ? { reason } : {}),
            path: requestedPath,
            file,
            outline: null,
            hasMore: false,
            message
        };
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
        const baseHints: Record<string, unknown> = staleLocal
            ? {
                create: this.buildCreateHint(staleLocal.codebaseRoot),
                staleLocal: this.buildStaleLocalHint(staleLocal.codebaseRoot, staleLocal.reason)
            }
            : {
                create: this.buildCreateHint(context.path)
            };
        return {
            status: 'not_indexed',
            supported: false,
            reason: 'not_indexed',
            path: context.path,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            message: staleLocal
                ? this.buildStaleLocalMessage(staleLocal.codebaseRoot, context.path, staleLocal.reason)
                : `Codebase '${context.path}' (or any parent) is not indexed.`,
            hints: baseHints
        };
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
        return {
            status: "not_ready",
            supported: false,
            reason: "indexing",
            path: context.path,
            codebaseRoot: codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            freshnessDecision: {
                mode: "skipped_indexing"
            },
            message: `Codebase '${codebasePath}' is currently indexing. Wait for indexing to complete, then retry.`,
            hints: {
                status: this.buildStatusHint(codebasePath),
                debugIndexing: {
                    completionProof: "marker_doc"
                }
            },
            indexing: this.buildIndexingMetadata(codebasePath)
        };
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
        return {
            status,
            supported: false,
            ...(reason ? { reason } : {}),
            path: context.path,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
            message
        };
    }

    private getMatchingBlockedRoot(absolutePath: string): { path: string; message?: string } | null {
        const blocked = this.snapshotManager
            .getAllCodebases()
            .filter((entry) => entry.info.status === 'requires_reindex');
        if (blocked.length === 0) {
            return null;
        }

        blocked.sort((a, b) => b.path.length - a.path.length);
        const match = blocked.find((entry) => absolutePath === entry.path || absolutePath.startsWith(`${entry.path}${path.sep}`));
        if (!match) {
            return null;
        }

        const message = 'message' in match.info ? match.info.message : undefined;
        return {
            path: match.path,
            message
        };
    }

    private enforceFingerprintGate(codebasePath: string): { blockedResponse?: any; message?: string } {
        const gate = this.snapshotManager.ensureFingerprintCompatibilityOnAccess(codebasePath);
        if (!gate.allowed) {
            if (gate.changed) {
                this.snapshotManager.saveCodebaseSnapshot();
            }
            return {
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
            this.snapshotManager.saveCodebaseSnapshot();
        }

        return {};
    }

    private buildSearchExcludeMatcher(
        excludePatterns: any,
        effectiveRoot: string,
        absoluteSearchPath: string
    ): { matcher?: ReturnType<typeof ignore>; warning?: string } {
        if (!Array.isArray(excludePatterns) || excludePatterns.length === 0) {
            return {};
        }

        const rawPatterns = excludePatterns
            .filter((v: any) => typeof v === 'string')
            .map((v: string) => v.trim())
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
        } catch (error: any) {
            const parseError = error?.message || String(error);
            const invalidNote = invalidPatterns.length > 0
                ? ` Ignored patterns: ${JSON.stringify(invalidPatterns)}.`
                : '';
            return {
                warning: `Note: excludePatterns ignored due to invalid pattern syntax: ${parseError}.${invalidNote}`
            };
        }
    }

    private applySearchExcludeMatcher(
        searchResults: any[],
        matcher: ReturnType<typeof ignore> | undefined
    ): any[] {
        if (!matcher || searchResults.length === 0) {
            return searchResults;
        }

        return searchResults.filter((result: any) => {
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
        return relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    }

    private hasPathSegment(normalizedPath: string, segment: string): boolean {
        return normalizedPath === segment
            || normalizedPath.startsWith(`${segment}/`)
            || normalizedPath.includes(`/${segment}/`);
    }

    private hasLeadingPathSegment(normalizedPath: string, segment: string): boolean {
        return normalizedPath === segment || normalizedPath.startsWith(`${segment}/`);
    }

    private isTestPath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'test')
            || this.hasPathSegment(normalizedPath, 'tests')
            || this.hasPathSegment(normalizedPath, '__tests__')
            || /\.test\.[^/]+$/.test(normalizedPath)
            || /\.spec\.[^/]+$/.test(normalizedPath);
    }

    private isDocPath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'docs')
            || this.hasPathSegment(normalizedPath, 'doc')
            || this.hasPathSegment(normalizedPath, 'documentation')
            || this.hasPathSegment(normalizedPath, 'guide')
            || this.hasPathSegment(normalizedPath, 'guides')
            || normalizedPath.endsWith('.md')
            || normalizedPath.endsWith('.mdx')
            || normalizedPath.endsWith('.rst')
            || normalizedPath.endsWith('.adoc')
            || normalizedPath.endsWith('.txt');
    }

    private isGeneratedPath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'dist')
            || this.hasPathSegment(normalizedPath, 'build')
            || this.hasPathSegment(normalizedPath, 'coverage')
            || this.hasPathSegment(normalizedPath, '.next')
            || this.hasPathSegment(normalizedPath, '.output')
            || this.hasPathSegment(normalizedPath, 'generated')
            || normalizedPath.endsWith('.min.js')
            || normalizedPath.endsWith('.min.css');
    }

    private isFixturePath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'fixtures')
            || this.hasPathSegment(normalizedPath, '__fixtures__');
    }

    private isArtifactPath(normalizedPath: string): boolean {
        return this.hasLeadingPathSegment(normalizedPath, 'reports')
            || this.hasLeadingPathSegment(normalizedPath, 'report')
            || this.hasLeadingPathSegment(normalizedPath, 'investigations')
            || this.hasLeadingPathSegment(normalizedPath, 'investigation')
            || this.hasPathSegment(normalizedPath, '.codebase-memory')
            || this.hasPathSegment(normalizedPath, '.satori');
    }

    private isLandingPath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'satori-landing')
            || this.hasPathSegment(normalizedPath, 'landing')
            || this.hasPathSegment(normalizedPath, 'landing-page');
    }

    private isExamplePath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'examples')
            || this.hasPathSegment(normalizedPath, 'example')
            || this.hasPathSegment(normalizedPath, 'demo')
            || this.hasPathSegment(normalizedPath, 'samples')
            || this.hasPathSegment(normalizedPath, 'sample');
    }

    private isAdapterPath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'adapters')
            || this.hasPathSegment(normalizedPath, 'adapter')
            || this.hasPathSegment(normalizedPath, 'tools')
            || this.hasPathSegment(normalizedPath, 'cli');
    }

    private isEntrypointPath(normalizedPath: string): boolean {
        const entryNames = ['main.', 'index.', 'app.', 'server.', 'cli.', 'entry.'];
        const baseName = normalizedPath.split('/').pop() || '';
        return entryNames.some((prefix) => baseName.startsWith(prefix));
    }

    private isScriptRuntimePath(normalizedPath: string): boolean {
        return normalizedPath === 'scripts' || normalizedPath.startsWith('scripts/');
    }

    private classifyPathCategory(relativePath: string): PathCategory {
        const normalized = this.normalizeSearchPath(relativePath);
        if (this.isGeneratedPath(normalized)) return 'generated';
        if (this.isFixturePath(normalized)) return 'fixture';
        if (this.isLandingPath(normalized)) return 'landing';
        if (this.isArtifactPath(normalized)) return 'artifact';
        if (this.isTestPath(normalized)) return 'tests';
        if (this.isDocPath(normalized)) return 'docs';
        if (this.isExamplePath(normalized)) return 'example';
        if (this.isScriptRuntimePath(normalized)) return 'scriptRuntime';
        if (this.isAdapterPath(normalized)) return 'adapter';
        if (this.isEntrypointPath(normalized)) return 'entrypoint';
        if (normalized.includes('/src/core/') || normalized.includes('/core/')) return 'core';
        if (normalized.includes('/src/')) return 'srcRuntime';
        return 'neutral';
    }

    private classifyNoiseCategory(relativePath: string): SearchNoiseCategory {
        const normalized = this.normalizeSearchPath(relativePath);

        // Deterministic precedence: generated > tests > fixtures > docs > runtime.
        if (this.isGeneratedPath(normalized)
            || this.hasPathSegment(normalized, 'coverage')
            || this.hasPathSegment(normalized, 'dist')
            || this.hasPathSegment(normalized, 'build')
            || this.hasPathSegment(normalized, '.output')) return 'generated';
        if (this.isTestPath(normalized)) return 'tests';
        if (this.isFixturePath(normalized)) return 'fixtures';
        if (this.isDocPath(normalized)) return 'docs';
        return 'runtime';
    }

    private roundRatio(value: number): number {
        return Math.round(value * 100) / 100;
    }

    private normalizeRelativePathForIgnoreCheck(relativePath: string): string | null {
        if (typeof relativePath !== 'string') {
            return null;
        }
        const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
        if (normalized.length === 0 || normalized === '.') {
            return null;
        }
        if (
            normalized.startsWith('..')
            || normalized.includes('/../')
            || path.posix.isAbsolute(normalized)
            || path.win32.isAbsolute(normalized)
        ) {
            return null;
        }
        return normalized;
    }

    private isExactSearchPathFilter(pattern: string): boolean {
        return !/[!*?[\]{}]/.test(pattern) && !pattern.endsWith('/');
    }

    private activeIgnorePatternsExcludePath(codebaseRoot: string, relativePath: string): boolean {
        const getActiveIgnorePatterns = (this.context as any).getActiveIgnorePatterns;
        if (typeof getActiveIgnorePatterns !== 'function') {
            return false;
        }

        const patterns = getActiveIgnorePatterns.call(this.context, codebaseRoot);
        if (!Array.isArray(patterns) || patterns.length === 0) {
            return false;
        }

        const normalized = this.normalizeRelativePathForIgnoreCheck(relativePath);
        if (!normalized) {
            return true;
        }

        try {
            const matcher = ignore();
            matcher.add(patterns.filter((pattern: unknown) => typeof pattern === 'string'));
            if (matcher.ignores(normalized)) {
                return true;
            }
            const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;
            return matcher.ignores(withSlash);
        } catch {
            return true;
        }
    }

    private buildLivePathScopedSearchResults(input: {
        effectiveRoot: string;
        parsedOperators: ParsedSearchOperators;
        queryPlan: SearchQueryPlan;
        changedFiles: Set<string>;
    }): any[] {
        if (input.parsedOperators.path.length === 0 || input.changedFiles.size === 0) {
            return [];
        }

        const results: any[] = [];
        const seenPaths = new Set<string>();
        const lexicalTerms = input.queryPlan.lexicalTerms
            .map((term) => term.value.toLowerCase())
            .filter((term) => term.length > 0);

        for (const pattern of input.parsedOperators.path) {
            if (results.length >= SEARCH_LIVE_PATH_SUPPLEMENT_MAX_RESULTS || seenPaths.size >= SEARCH_LIVE_PATH_SUPPLEMENT_MAX_FILES) {
                break;
            }

            const normalized = this.normalizeRelativePathForIgnoreCheck(pattern);
            if (!normalized || !this.isExactSearchPathFilter(normalized) || seenPaths.has(normalized)) {
                continue;
            }
            seenPaths.add(normalized);

            if (!input.changedFiles.has(normalized)) {
                continue;
            }
            if (!isLanguageCapabilitySupportedForFilename(normalized, 'search')) {
                continue;
            }
            if (this.activeIgnorePatternsExcludePath(input.effectiveRoot, normalized)) {
                continue;
            }

            const absolutePath = path.resolve(input.effectiveRoot, normalized);
            const rootPrefix = `${path.resolve(input.effectiveRoot)}${path.sep}`;
            if (!absolutePath.startsWith(rootPrefix)) {
                continue;
            }

            let stat: fs.Stats;
            try {
                stat = fs.statSync(absolutePath);
            } catch {
                continue;
            }
            if (!stat.isFile() || stat.size > SEARCH_LIVE_PATH_SUPPLEMENT_MAX_BYTES) {
                continue;
            }

            let content: string;
            try {
                content = fs.readFileSync(absolutePath, 'utf8');
            } catch {
                continue;
            }

            const lowerContent = content.toLowerCase();
            if (lexicalTerms.length > 0 && !lexicalTerms.some((term) => lowerContent.includes(term))) {
                continue;
            }

            const lines = content.split(/\r?\n/);
            const matchingLineIndex = lexicalTerms.length > 0
                ? this.findBestLivePathLexicalLineIndex(lines, input.queryPlan.lexicalTerms)
                : 0;
            const anchorLineIndex = matchingLineIndex >= 0 ? matchingLineIndex : 0;
            const startLine = Math.max(1, anchorLineIndex + 1 - SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES);
            const endLine = Math.min(lines.length, anchorLineIndex + 1 + SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES);
            const windowContent = lines.slice(startLine - 1, endLine).join('\n');

            results.push({
                content: windowContent,
                relativePath: normalized,
                startLine,
                endLine,
                language: getLanguageIdFromFilename(normalized, 'text'),
                score: 1,
                backendScore: 1,
                backendScoreKind: 'lexical_rank',
            });
        }

        return results;
    }

    private shouldRunTrackedLexicalSearch(input: {
        parsedOperators: ParsedSearchOperators;
        queryPlan: SearchQueryPlan;
        exactRegistryFallback: boolean;
    }): boolean {
        if (input.queryPlan.lexicalTerms.length === 0 && input.queryPlan.quotedLiteralPhrases.length === 0) {
            return false;
        }
        if (input.exactRegistryFallback) {
            return true;
        }
        if (input.parsedOperators.path.some((pattern) => {
            const normalized = this.normalizeRelativePathForIgnoreCheck(pattern);
            return Boolean(normalized && this.isExactSearchPathFilter(normalized));
        })) {
            return true;
        }
        if (input.queryPlan.quotedLiteralPhrases.length > 0) {
            return true;
        }
        const semanticQuery = input.queryPlan.semanticQuery.trim();
        if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/.test(semanticQuery)) {
            return true;
        }
        return /\b[A-Z][A-Z0-9_]*(?:WARNING|ERROR|CODE|STATUS|REASON)[A-Z0-9_]*\b/.test(semanticQuery);
    }

    private buildTrackedLexicalSearchResults(input: {
        effectiveRoot: string;
        parsedOperators: ParsedSearchOperators;
        queryPlan: SearchQueryPlan;
        scope: SearchScope;
        limit: number;
        exactRegistryFallback: boolean;
    }): { results: any[]; debug: TrackedLexicalSearchDebug } {
        const disabledDebug = (): TrackedLexicalSearchDebug => ({
            enabled: false,
            trackedPathCount: 0,
            filesConsidered: 0,
            filesScanned: 0,
            bytesRead: 0,
            cappedByFiles: false,
            cappedByBytes: false,
            returnedResults: 0,
        });
        if (!this.shouldRunTrackedLexicalSearch(input)) {
            return { results: [], debug: disabledDebug() };
        }

        const getTrackedRelativePaths = (this.context as any).getTrackedRelativePaths;
        if (typeof getTrackedRelativePaths !== 'function') {
            return { results: [], debug: disabledDebug() };
        }

        const trackedRelativePaths = getTrackedRelativePaths.call(this.context, input.effectiveRoot);
        if (!Array.isArray(trackedRelativePaths) || trackedRelativePaths.length === 0) {
            return { results: [], debug: disabledDebug() };
        }
        const debug: TrackedLexicalSearchDebug = {
            enabled: true,
            trackedPathCount: trackedRelativePaths.length,
            filesConsidered: 0,
            filesScanned: 0,
            bytesRead: 0,
            cappedByFiles: false,
            cappedByBytes: false,
            returnedResults: 0,
        };

        const normalizedExactPathFilters = new Set(
            input.parsedOperators.path
                .map((pattern) => this.normalizeRelativePathForIgnoreCheck(pattern))
                .filter((pattern): pattern is string => Boolean(pattern && this.isExactSearchPathFilter(pattern)))
        );
        const lexicalTerms = input.queryPlan.lexicalTerms
            .map((term) => term.value.toLowerCase())
            .filter((term) => term.length > 0);
        const normalizedPaths = trackedRelativePaths
            .map((relativePath) => this.normalizeRelativePathForIgnoreCheck(relativePath))
            .filter((relativePath): relativePath is string => Boolean(relativePath));
        const uniquePaths = Array.from(new Set(normalizedPaths));
        uniquePaths.sort((a, b) => {
            const aExact = normalizedExactPathFilters.has(a) ? 1 : 0;
            const bExact = normalizedExactPathFilters.has(b) ? 1 : 0;
            if (aExact !== bExact) {
                return bExact - aExact;
            }
            const aPathMatch = lexicalTerms.some((term) => a.toLowerCase().includes(term)) ? 1 : 0;
            const bPathMatch = lexicalTerms.some((term) => b.toLowerCase().includes(term)) ? 1 : 0;
            if (aPathMatch !== bPathMatch) {
                return bPathMatch - aPathMatch;
            }
            return a.localeCompare(b);
        });

        const candidates: Array<{
            relativePath: string;
            score: number;
            exactLexicalMatch: boolean;
            startLine: number;
            endLine: number;
            content: string;
            language: string;
        }> = [];
        let bytesRead = 0;
        let filesScanned = 0;

        for (const relativePath of uniquePaths) {
            if (filesScanned >= SEARCH_TRACKED_LEXICAL_MAX_FILES) {
                debug.cappedByFiles = true;
                break;
            }
            if (bytesRead >= SEARCH_TRACKED_LEXICAL_TOTAL_BYTES) {
                debug.cappedByBytes = true;
                break;
            }
            debug.filesConsidered += 1;
            if (!isLanguageCapabilitySupportedForFilename(relativePath, 'search')) {
                continue;
            }
            if (!this.shouldIncludeCategoryInScope(input.scope, this.classifyPathCategory(relativePath))) {
                continue;
            }
            if (input.parsedOperators.lang.length > 0) {
                const languageValue = getLanguageIdFromFilename(relativePath, 'text').toLowerCase();
                if (!input.parsedOperators.lang.includes(languageValue)) {
                    continue;
                }
            }
            if (input.parsedOperators.path.length > 0 && !this.pathMatchesAnyPattern(relativePath, input.parsedOperators.path)) {
                continue;
            }
            if (input.parsedOperators.excludePath.length > 0 && this.pathMatchesAnyPattern(relativePath, input.parsedOperators.excludePath)) {
                continue;
            }
            if (this.activeIgnorePatternsExcludePath(input.effectiveRoot, relativePath)) {
                continue;
            }

            const absolutePath = path.resolve(input.effectiveRoot, relativePath);
            const rootPrefix = `${path.resolve(input.effectiveRoot)}${path.sep}`;
            if (!absolutePath.startsWith(rootPrefix)) {
                continue;
            }

            let stat: fs.Stats;
            try {
                stat = fs.statSync(absolutePath);
            } catch {
                continue;
            }
            if (!stat.isFile() || stat.size > SEARCH_TRACKED_LEXICAL_MAX_BYTES || bytesRead + stat.size > SEARCH_TRACKED_LEXICAL_TOTAL_BYTES) {
                if (bytesRead + stat.size > SEARCH_TRACKED_LEXICAL_TOTAL_BYTES) {
                    debug.cappedByBytes = true;
                }
                continue;
            }

            let content: string;
            try {
                content = fs.readFileSync(absolutePath, 'utf8');
            } catch {
                continue;
            }
            filesScanned += 1;
            bytesRead += stat.size;
            debug.filesScanned = filesScanned;
            debug.bytesRead = bytesRead;

            const lowerContent = content.toLowerCase();
            const quickMatch = lexicalTerms.length === 0
                || lexicalTerms.some((term) => lowerContent.includes(term) || relativePath.toLowerCase().includes(term));
            if (!quickMatch) {
                continue;
            }

            const lines = content.split(/\r?\n/);
            let bestLineIndex = -1;
            let bestScore = 0;
            let bestExactLexicalMatch = false;
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                const evidence = this.scoreCandidateLexicalEvidence(input.queryPlan, {
                    relativePath,
                    content: lines[lineIndex],
                    symbolLabel: '',
                });
                if (
                    evidence.score > bestScore
                    || (evidence.score === bestScore && evidence.exactLexicalMatch && !bestExactLexicalMatch)
                ) {
                    bestScore = evidence.score;
                    bestExactLexicalMatch = evidence.exactLexicalMatch;
                    bestLineIndex = lineIndex;
                }
            }

            if (bestScore <= 0) {
                continue;
            }

            const anchorLineIndex = bestLineIndex >= 0 ? bestLineIndex : 0;
            const startLine = Math.max(1, anchorLineIndex + 1 - SEARCH_TRACKED_LEXICAL_CONTEXT_LINES);
            const endLine = Math.min(lines.length, anchorLineIndex + 1 + SEARCH_TRACKED_LEXICAL_CONTEXT_LINES);
            const windowContent = lines.slice(startLine - 1, endLine).join('\n');
            const windowEvidence = this.scoreCandidateLexicalEvidence(input.queryPlan, {
                relativePath,
                content: windowContent,
                symbolLabel: '',
            });

            candidates.push({
                relativePath,
                score: windowEvidence.score > 0 ? windowEvidence.score : bestScore,
                exactLexicalMatch: windowEvidence.exactLexicalMatch || bestExactLexicalMatch,
                startLine,
                endLine,
                content: windowContent,
                language: getLanguageIdFromFilename(relativePath, 'text'),
            });
        }

        candidates.sort((a, b) => {
            if (a.exactLexicalMatch !== b.exactLexicalMatch) {
                return a.exactLexicalMatch ? -1 : 1;
            }
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            const fileCmp = a.relativePath.localeCompare(b.relativePath);
            if (fileCmp !== 0) {
                return fileCmp;
            }
            return a.startLine - b.startLine;
        });

        const results = candidates.slice(0, Math.min(input.limit, SEARCH_TRACKED_LEXICAL_MAX_RESULTS)).map((candidate) => ({
            content: candidate.content,
            relativePath: candidate.relativePath,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            language: candidate.language,
            score: candidate.score,
            backendScore: candidate.score,
            backendScoreKind: 'lexical_rank',
        }));
        debug.returnedResults = results.length;
        return { results, debug };
    }

    private findBestLivePathLexicalLineIndex(lines: string[], lexicalTerms: SearchLexicalTerm[]): number {
        const orderedTerms = [
            ...lexicalTerms.filter((term) => term.kind === 'whole'),
            ...lexicalTerms.filter((term) => term.kind !== 'whole'),
        ].map((term) => term.value.toLowerCase()).filter((term) => term.length > 0);

        for (const term of orderedTerms) {
            const lineIndex = lines.findIndex((line) => line.toLowerCase().includes(term));
            if (lineIndex >= 0) {
                return lineIndex;
            }
        }

        return -1;
    }

    private trimTrailingSeparators(inputPath: string): string {
        const parsedRoot = path.parse(inputPath).root;
        if (inputPath === parsedRoot) {
            return inputPath;
        }
        return inputPath.replace(/[\\/]+$/, '');
    }

    private canonicalizeCodebasePath(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        try {
            const realPath = typeof fs.realpathSync.native === 'function'
                ? fs.realpathSync.native(resolved)
                : fs.realpathSync(resolved);
            return this.trimTrailingSeparators(path.normalize(realPath));
        } catch {
            return this.trimTrailingSeparators(path.normalize(resolved));
        }
    }

    private loadRootGitignoreMatcher(codebaseRoot: string): GitignoreMatcherCacheEntry {
        const cacheKey = this.canonicalizeCodebasePath(codebaseRoot);
        const gitignorePath = path.join(cacheKey, '.gitignore');
        const existingFromCache = this.rootGitignoreMatcherCache.get(cacheKey);
        const existing = existingFromCache || {
            state: "absent" as GitignoreMatcherCacheState,
            mtimeMs: null,
            size: null,
            matcher: null,
            checksSinceReload: 0,
        };
        const hasExistingEntry = !!existingFromCache;

        const nextChecks = existing.checksSinceReload + 1;
        const forceReload = nextChecks >= this.gitignoreForceReloadEveryN;

        if (!forceReload && existing.state === 'ready') {
            try {
                const stat = fs.statSync(gitignorePath);
                const mtimeMs = Math.trunc(stat.mtimeMs);
                const size = stat.size;
                if (stat.isFile() && existing.mtimeMs === mtimeMs && existing.size === size && existing.matcher) {
                    const retained = { ...existing, checksSinceReload: nextChecks };
                    this.rootGitignoreMatcherCache.set(cacheKey, retained);
                    return retained;
                }
            } catch {
                // Fall through to reload path.
            }
        }

        if (hasExistingEntry && !forceReload && (existing.state === 'absent' || existing.state === 'error')) {
            const retained = { ...existing, checksSinceReload: nextChecks };
            this.rootGitignoreMatcherCache.set(cacheKey, retained);
            return retained;
        }

        try {
            const stat = fs.statSync(gitignorePath);
            if (!stat.isFile()) {
                const absent = {
                    state: "absent" as GitignoreMatcherCacheState,
                    mtimeMs: null,
                    size: null,
                    matcher: null,
                    checksSinceReload: 0,
                };
                this.rootGitignoreMatcherCache.set(cacheKey, absent);
                return absent;
            }

            const mtimeMs = Math.trunc(stat.mtimeMs);
            const size = stat.size;
            const contents = fs.readFileSync(gitignorePath, 'utf8');
            const matcher = ignore();
            matcher.add(contents);

            const ready = {
                state: "ready" as GitignoreMatcherCacheState,
                mtimeMs,
                size,
                matcher,
                checksSinceReload: 0,
            };
            this.rootGitignoreMatcherCache.set(cacheKey, ready);
            return ready;
        } catch (error: any) {
            const code = typeof error?.code === 'string' ? error.code : '';
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                const absent = {
                    state: "absent" as GitignoreMatcherCacheState,
                    mtimeMs: null,
                    size: null,
                    matcher: null,
                    checksSinceReload: 0,
                };
                this.rootGitignoreMatcherCache.set(cacheKey, absent);
                return absent;
            }
            const failed = {
                state: "error" as GitignoreMatcherCacheState,
                mtimeMs: null,
                size: null,
                matcher: null,
                checksSinceReload: 0,
            };
            this.rootGitignoreMatcherCache.set(cacheKey, failed);
            return failed;
        }
    }

    private patternMatchesAnyPath(pattern: string, paths: string[]): boolean {
        if (!Array.isArray(paths) || paths.length === 0) {
            return false;
        }
        try {
            const matcher = ignore();
            matcher.add(pattern);
            return paths.some((filePath) => matcher.ignores(filePath));
        } catch {
            return false;
        }
    }

    private filterNoiseHintPatternsByRootGitignore(
        codebaseRoot: string,
        observedNoisyFiles: string[]
    ): {
        matcherState: GitignoreMatcherCacheState;
        suggestedIgnorePatterns: string[];
        coveredByRootGitignore: boolean;
    } {
        const normalizedObserved = Array.from(
            new Set(
                observedNoisyFiles
                    .map((filePath) => this.normalizeRelativePathForIgnoreCheck(filePath))
                    .filter((filePath): filePath is string => typeof filePath === 'string')
            )
        );

        const baseline = [...SEARCH_NOISE_HINT_PATTERNS];
        const cacheEntry = this.loadRootGitignoreMatcher(codebaseRoot);
        if (cacheEntry.state !== 'ready' || !cacheEntry.matcher) {
            return {
                matcherState: cacheEntry.state,
                suggestedIgnorePatterns: baseline,
                coveredByRootGitignore: false,
            };
        }

        const coveredByRootGitignore = normalizedObserved.some((filePath) => cacheEntry.matcher!.ignores(filePath));
        const noisyFilesNotIgnored = normalizedObserved.filter((filePath) => !cacheEntry.matcher!.ignores(filePath));
        const suggestedIgnorePatterns = SEARCH_NOISE_HINT_PATTERNS.filter((pattern) =>
            this.patternMatchesAnyPath(pattern, noisyFilesNotIgnored)
        );

        return {
            matcherState: cacheEntry.state,
            suggestedIgnorePatterns,
            coveredByRootGitignore,
        };
    }

    private buildNoiseMitigationHint(
        codebaseRoot: string,
        filesInOrder: string[],
        scope: SearchScope
    ): SearchNoiseMitigationHint | undefined {
        if (scope === 'docs') {
            return undefined;
        }
        if (!Array.isArray(filesInOrder) || filesInOrder.length === 0) {
            return undefined;
        }

        const topK = Math.min(SEARCH_NOISE_HINT_TOP_K, filesInOrder.length);
        if (topK <= 0) {
            return undefined;
        }

        const counts: Record<SearchNoiseCategory, number> = {
            tests: 0,
            fixtures: 0,
            docs: 0,
            generated: 0,
            runtime: 0,
        };
        const observedNoisyFiles: string[] = [];

        for (let i = 0; i < topK; i++) {
            const filePath = filesInOrder[i];
            const category = this.classifyNoiseCategory(filePath);
            counts[category] += 1;
            if (category !== 'runtime') {
                const normalized = this.normalizeRelativePathForIgnoreCheck(filePath);
                if (normalized) {
                    observedNoisyFiles.push(normalized);
                }
            }
        }

        const noisyRatio = (counts.tests + counts.fixtures + counts.docs + counts.generated) / topK;
        if (noisyRatio < SEARCH_NOISE_HINT_THRESHOLD) {
            return undefined;
        }

        const ratios: Record<SearchNoiseCategory, number> = {
            tests: this.roundRatio(counts.tests / topK),
            fixtures: this.roundRatio(counts.fixtures / topK),
            docs: this.roundRatio(counts.docs / topK),
            generated: this.roundRatio(counts.generated / topK),
            runtime: this.roundRatio(counts.runtime / topK),
        };
        const debounceMs = typeof (this.syncManager as any)?.getWatchDebounceMs === 'function'
            ? this.syncManager.getWatchDebounceMs()
            : DEFAULT_WATCH_DEBOUNCE_MS;
        const filtered = this.filterNoiseHintPatternsByRootGitignore(codebaseRoot, observedNoisyFiles);
        const isRootCoveredMessageEligible = filtered.matcherState === 'ready' && filtered.coveredByRootGitignore && filtered.suggestedIgnorePatterns.length === 0;
        const nextStepMiddle = filtered.suggestedIgnorePatterns.length > 0
            ? 'If you edit ignores, add only patterns not already ignored by root .gitignore (root-only check), then run manage_index with {"action":"sync","path":"<same path used in search_codebase>"} for immediate convergence.'
            : (isRootCoveredMessageEligible
                ? 'Top noisy files appear already covered by root .gitignore (root-only check); .satoriignore changes may be unnecessary. If you changed ignores, run manage_index with {"action":"sync","path":"<same path used in search_codebase>"} for immediate convergence.'
                : 'If you edit ignores, run manage_index with {"action":"sync","path":"<same path used in search_codebase>"} for immediate convergence.');
        const nextStep = `Use scope="runtime" to reduce noise. ${nextStepMiddle} Reindex is only required when you see requires_reindex (fingerprint mismatch).`;

        return {
            reason: 'top_results_noise_dominant',
            topK,
            ratios,
            recommendedScope: 'runtime',
            suggestedIgnorePatterns: [...filtered.suggestedIgnorePatterns],
            debounceMs,
            nextStep,
        };
    }

    private tokenizeQueryPrefix(prefix: string): string[] {
        const tokens: string[] = [];
        let current = "";
        let inQuotes = false;
        let escaped = false;

        for (let i = 0; i < prefix.length; i++) {
            const ch = prefix[i];
            if (escaped) {
                current += ch;
                escaped = false;
                continue;
            }

            if (ch === "\\") {
                current += ch;
                escaped = true;
                continue;
            }

            if (ch === "\"") {
                inQuotes = !inQuotes;
                current += ch;
                continue;
            }

            if (!inQuotes && /\s/.test(ch)) {
                if (current.length > 0) {
                    tokens.push(current);
                    current = "";
                }
                continue;
            }

            current += ch;
        }

        if (current.length > 0) {
            tokens.push(current);
        }

        return tokens;
    }

    private unquoteOperatorValue(value: string): string {
        const trimmed = value.trim();
        if (trimmed.length < 2) {
            return trimmed;
        }

        if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            const inner = trimmed.slice(1, -1);
            return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
        }

        return trimmed;
    }

    private deriveOperatorOnlySemanticQuery(operators: ParsedSearchOperators): string | null {
        if (operators.must.length !== 1) {
            return null;
        }

        const mustValue = operators.must[0].trim();
        if (/\s/.test(mustValue)) {
            return null;
        }

        const symbolInstanceIdLike = /^syminst_[a-f0-9]{32}$/i.test(mustValue);
        const identifierLike = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:[.#:/-]|::)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(mustValue);
        const strongIdentifierSignal = /[A-Z_]/.test(mustValue) || /(?:\.|::|#|\/)/.test(mustValue);
        if (symbolInstanceIdLike || (identifierLike && strongIdentifierSignal)) {
            return mustValue;
        }

        return null;
    }

    private parseSearchOperators(query: string): ParsedSearchOperators {
        const trimmedQuery = query.trim();
        if (trimmedQuery.length === 0) {
            return {
                semanticQuery: "",
                prefixBlockChars: 0,
                lang: [],
                path: [],
                excludePath: [],
                must: [],
                exclude: [],
            };
        }

        const maxPrefixChars = Math.min(SEARCH_OPERATOR_PREFIX_MAX_CHARS, query.length);
        const prefixWindow = query.slice(0, maxPrefixChars);
        const blankLineOffset = prefixWindow.indexOf("\n\n");
        const prefixChars = blankLineOffset >= 0 ? blankLineOffset : maxPrefixChars;
        const prefixBlock = query.slice(0, prefixChars);
        const suffixText = blankLineOffset >= 0
            ? query.slice(blankLineOffset + 2)
            : query.slice(prefixChars);

        const operators: ParsedSearchOperators = {
            semanticQuery: "",
            prefixBlockChars: prefixChars,
            lang: [],
            path: [],
            excludePath: [],
            must: [],
            exclude: [],
        };

        const semanticTokens: string[] = [];
        const tokens = this.tokenizeQueryPrefix(prefixBlock);
        for (const token of tokens) {
            if (token.startsWith("\\") && token.length > 1) {
                semanticTokens.push(token.slice(1));
                continue;
            }

            const separator = token.indexOf(":");
            if (separator <= 0) {
                semanticTokens.push(token);
                continue;
            }

            const key = token.slice(0, separator);
            if (!SEARCH_OPERATOR_KEYS.has(key)) {
                semanticTokens.push(token);
                continue;
            }

            const rawValue = token.slice(separator + 1);
            const value = this.unquoteOperatorValue(rawValue);
            if (value.length === 0) {
                continue;
            }

            if (key === "lang") {
                operators.lang.push(value.toLowerCase());
                continue;
            }
            if (key === "path") {
                operators.path.push(value.replace(/\\/g, "/"));
                continue;
            }
            if (key === "-path") {
                operators.excludePath.push(value.replace(/\\/g, "/"));
                continue;
            }
            if (key === "must") {
                operators.must.push(value);
                continue;
            }
            if (key === "exclude") {
                operators.exclude.push(value);
                continue;
            }

            semanticTokens.push(token);
        }

        const semanticFromPrefix = semanticTokens.join(" ").trim();
        const semanticSuffix = suffixText.trim();
        const semanticParts = [semanticFromPrefix, semanticSuffix].filter((part) => part.length > 0);
        operators.semanticQuery = semanticParts.length > 0
            ? semanticParts.join("\n")
            : (this.deriveOperatorOnlySemanticQuery(operators) || trimmedQuery);
        return operators;
    }

    private tokenizeLexicalTerms(tokens: string[]): SearchLexicalTerm[] {
        const terms = new Map<string, SearchLexicalTerm>();
        const addTerm = (value: string, kind: SearchLexicalTermKind): void => {
            const normalized = value
                .replace(/^['"`]+|['"`]+$/g, '')
                .replace(/[(){}\[\],;]+/g, ' ')
                .trim()
                .toLowerCase();
            if (normalized.length === 0) {
                return;
            }

            const existing = terms.get(normalized);
            if (!existing || (existing.kind === 'fragment' && kind === 'whole')) {
                terms.set(normalized, { value: normalized, kind });
            }
        };

        for (const token of tokens) {
            const trimmed = token.trim();
            if (trimmed.length === 0) {
                continue;
            }

            addTerm(trimmed, 'whole');

            const expanded = trimmed
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .replace(/[/\\._:-]+/g, ' ')
                .replace(/[(){}\[\],;]+/g, ' ')
                .toLowerCase();
            for (const part of expanded.split(/\s+/)) {
                const normalizedPart = part.trim();
                if (normalizedPart.length >= 2) {
                    addTerm(normalizedPart, 'fragment');
                }
            }
        }

        return Array.from(terms.values());
    }

    private isIdentifierLikeToken(token: string): boolean {
        const trimmed = token.trim();
        if (trimmed.length === 0) {
            return false;
        }

        return /[A-Z]/.test(trimmed)
            || /[_/\\.\-:]/.test(trimmed)
            || /\d/.test(trimmed);
    }

    private extractQuotedLiteralPhrases(query: string): string[] {
        const phrases = new Set<string>();
        const pattern = /(["'`])([^"'`]+?)\1/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(query)) !== null) {
            const normalized = match[2]
                .trim()
                .replace(/\s+/g, ' ')
                .toLowerCase();
            if (normalized.length >= 3) {
                phrases.add(normalized);
            }
        }
        return Array.from(phrases.values()).slice(0, 4);
    }

    private buildSearchQueryPlan(semanticQuery: string): SearchQueryPlan {
        const hybridEnabled = this.runtimeFingerprint.schemaVersion.startsWith('hybrid');
        const tokens = semanticQuery
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
        const normalizedQuery = semanticQuery.toLowerCase();
        const normalizedTokens = tokens.map((token) => token.toLowerCase());
        const identifierTokens = tokens.filter((token) => this.isIdentifierLikeToken(token));
        const naturalLanguageTokens = tokens
            .filter((token) => (
                !this.isIdentifierLikeToken(token)
                && (SEARCH_QUERY_STOPWORDS.has(token.toLowerCase()) || token.length >= 4)
            ))
            .map((token) => token.toLowerCase());
        const singleBareLookup = tokens.length === 1
            && /^[a-z][a-z0-9]{2,63}$/.test(tokens[0])
            && !SEARCH_QUERY_STOPWORDS.has(normalizedTokens[0] || '');
        const exactPinEligible = identifierTokens.some((token) => /[A-Z_]/.test(token));
        const quotedLiteralPhrases = this.extractQuotedLiteralPhrases(semanticQuery);
        const quotedLiteralSeeking = quotedLiteralPhrases.length > 0;
        const lexicalSourceTokens = identifierTokens.length > 0 && naturalLanguageTokens.length > 0
            ? tokens
            : (identifierTokens.length > 0 ? identifierTokens : tokens);
        const lexicalTerms = this
            .tokenizeLexicalTerms(lexicalSourceTokens)
            .filter((term) => !SEARCH_QUERY_STOPWORDS.has(term.value))
            .slice(0, 8);
        const explicitReferenceSeeking = /\b(used|uses|usage|reference|references|referenced|callers?|called|imports?|imported|instantiat(?:e|ed|ion))\b/.test(normalizedQuery)
            || /\bwho\s+uses\b/.test(normalizedQuery);
        const referenceSeeking = explicitReferenceSeeking
            || /\bwhere\s+is\b/.test(normalizedQuery)
            || /\bwho\s+uses\b/.test(normalizedQuery);
        const testSeeking = /\b(test|tests|tested|testing|spec|specs|coverage|assert|asserts|assertion|assertions|fixture|fixtures|mock|mocks|mocked|stub|stubs)\b/.test(normalizedQuery)
            || /\.test\b/.test(normalizedQuery)
            || /\.spec\b/.test(normalizedQuery);
        const writerSeeking = /\b(writes?|writing|written|updates?|updated|updating|creates?|created|creating|generates?|generated|generating|emits?|emitted|emitting|persists?|persisted|persisting|configures?|configured|configuring|installs?|installed|installing)\b/.test(normalizedQuery);
        const implementationCue = /\b(implement|implements|implemented|implementation|owner|owning|built|build|builds|builder|construct|constructed|create|creates|created|install|installs|installed|emit|emits|emitted|producer|produces|normalize|normalizes|normalized|cap|caps|capped|script|scripts|check|checks|checked|wire|wired|assemble|assembles|assembled|decide|decides|decided|deciding|freshness|reconcile|reconciles|reconciled|reconciliation|control)\b/.test(normalizedQuery);
        const ownerWhereSeeking = !explicitReferenceSeeking && /\bwhere\s+(?:does|is|are)\b/.test(normalizedQuery);
        const implementationSeeking = !testSeeking && (implementationCue || ownerWhereSeeking || writerSeeking);

        let intent: SearchQueryIntent = 'uncertain';
        let confidence: SearchIntentConfidence = 'low';
        const reasons: string[] = [];

        if (identifierTokens.length > 0 && naturalLanguageTokens.length > 0) {
            intent = 'mixed';
            confidence = identifierTokens.length >= 2 ? 'high' : 'medium';
            reasons.push('identifier_terms_present', 'natural_language_terms_present');
        } else if (identifierTokens.length > 0) {
            intent = 'identifier';
            confidence = tokens.length === identifierTokens.length ? 'high' : 'medium';
            reasons.push(tokens.length === 1 ? 'single_identifier_token' : 'identifier_tokens_present');
        } else if (singleBareLookup) {
            intent = 'uncertain';
            confidence = 'medium';
            reasons.push('single_term_lookup');
        } else if (naturalLanguageTokens.length >= 2 || tokens.length >= 4) {
            intent = 'semantic';
            confidence = 'high';
            reasons.push('natural_language_query');
        } else {
            reasons.push('ambiguous_short_query');
        }
        if (referenceSeeking) {
            reasons.push('reference_seeking_query');
        }
        if (quotedLiteralSeeking) {
            reasons.push('quoted_literal_query');
        }
        if (testSeeking) {
            reasons.push('test_seeking_query');
        }
        if (implementationSeeking) {
            reasons.push('implementation_seeking_query');
        }
        if (writerSeeking) {
            reasons.push('writer_seeking_query');
        }

        return {
            semanticQuery,
            intent,
            confidence,
            reasons,
            quotedLiteralPhrases,
            referenceSeeking,
            testSeeking,
            implementationSeeking,
            writerSeeking,
            lexicalTerms,
            retrievalMode: hybridEnabled
                ? (intent === 'identifier' ? 'lexical' : 'hybrid')
                : 'dense',
            scorePolicyKind: 'topk_only',
            lexicalWeight: quotedLiteralSeeking
                ? 1.35
                : intent === 'identifier'
                ? 1.35
                : intent === 'mixed'
                    ? (referenceSeeking || implementationSeeking || writerSeeking ? 0.30 : 0.10)
                    : intent === 'uncertain'
                        ? 0.60
                        : (referenceSeeking || implementationSeeking || writerSeeking ? 0.18 : 0.00),
            exactMatchPinningEnabled: intent === 'identifier'
                || quotedLiteralSeeking
                || (writerSeeking && exactPinEligible),
            rerankAllowed: intent !== 'identifier' && !quotedLiteralSeeking,
        };
    }

    private escapeLexicalRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private hasTokenBoundaryMatch(field: string, term: string): boolean {
        if (!field || !term) {
            return false;
        }

        const pattern = new RegExp(`(^|[^a-z0-9])${this.escapeLexicalRegex(term)}([^a-z0-9]|$)`, 'i');
        return pattern.test(field);
    }

    private getReferenceUsageKind(content: string, term: string): 'executable' | 'import' | null {
        if (!content || !term) {
            return null;
        }

        const escaped = this.escapeLexicalRegex(term);
        const executablePatterns = [
            new RegExp(`\\bnew\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\b${escaped}\\s*\\(`, 'i'),
            new RegExp(`\\b${escaped}\\b\\s*=`, 'i'),
        ];
        if (executablePatterns.some((pattern) => pattern.test(content))) {
            return 'executable';
        }

        const importPatterns = [
            new RegExp(`\\bimport\\s+.*\\b${escaped}\\b`, 'i'),
            new RegExp(`\\bfrom\\s+.+\\s+import\\s+.*\\b${escaped}\\b`, 'i'),
        ];
        return importPatterns.some((pattern) => pattern.test(content)) ? 'import' : null;
    }

    private hasDeclarationMatch(content: string, term: string): boolean {
        if (!content || !term) {
            return false;
        }

        const escaped = this.escapeLexicalRegex(term);
        const declarationPatterns = [
            new RegExp(`\\bclass\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\bdef\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\bfunction\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\btype\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\binterface\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\benum\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\bstruct\\s+${escaped}\\b`, 'i'),
            new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b\\s*=\\s*(?:async\\s+)?function\\b`, 'i'),
            new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-z_$][\\w$]*)\\s*=>`, 'i'),
        ];

        return declarationPatterns.some((pattern) => pattern.test(content));
    }

    private getLexicalTermFactor(plan: SearchQueryPlan, term: SearchLexicalTerm): number {
        if (term.kind === 'whole') {
            return 1;
        }
        if (plan.referenceSeeking) {
            return 0.18;
        }
        if (plan.intent === 'identifier') {
            return 0.18;
        }
        return 0.35;
    }

    private scoreCandidateLexicalEvidence(plan: SearchQueryPlan, result: any): SearchLexicalEvidence {
        if (plan.lexicalTerms.length === 0 && plan.quotedLiteralPhrases.length === 0) {
            return { score: 0, exactLexicalMatch: false };
        }

        const relativePath = typeof result?.relativePath === 'string' ? result.relativePath.toLowerCase() : '';
        const symbolLabel = typeof result?.symbolLabel === 'string' ? result.symbolLabel.toLowerCase() : '';
        const content = typeof result?.content === 'string' ? result.content.toLowerCase() : '';
        const pathSegments = relativePath.split('/').filter((segment: string) => segment.length > 0);

        let score = 0;
        let exactLexicalMatch = false;
        const matchedWholeTerms = new Set<string>();

        for (const phrase of plan.quotedLiteralPhrases) {
            if (symbolLabel.includes(phrase)) {
                score = Math.max(score, 1.75);
                exactLexicalMatch = true;
                continue;
            }
            if (pathSegments.some((segment: string) => segment.includes(phrase))) {
                score = Math.max(score, 1.60);
                exactLexicalMatch = true;
                continue;
            }
            if (content.includes(phrase)) {
                score = Math.max(score, 1.70);
                exactLexicalMatch = true;
            }
        }

        for (const term of plan.lexicalTerms) {
            const usageKind = plan.referenceSeeking ? this.getReferenceUsageKind(content, term.value) : null;
            const declarationMatch = plan.referenceSeeking && this.hasDeclarationMatch(content, term.value);
            const termFactor = this.getLexicalTermFactor(plan, term);

            if (usageKind === 'executable' && !declarationMatch) {
                score = Math.max(score, 1.60 * termFactor);
                continue;
            }

            if (usageKind === 'import' && !declarationMatch) {
                score = Math.max(score, 0.75 * termFactor);
                continue;
            }

            if (this.hasTokenBoundaryMatch(symbolLabel, term.value)) {
                score = Math.max(score, (plan.referenceSeeking ? 0.02 : 1.30) * termFactor);
                if (term.kind === 'whole') {
                    matchedWholeTerms.add(term.value);
                }
                if ((!plan.referenceSeeking || plan.writerSeeking) && term.kind === 'whole') {
                    exactLexicalMatch = true;
                }
                continue;
            }

            if (pathSegments.some((segment: string) => this.hasTokenBoundaryMatch(segment, term.value))) {
                score = Math.max(score, (plan.referenceSeeking ? 0.02 : 1.20) * termFactor);
                if (term.kind === 'whole') {
                    matchedWholeTerms.add(term.value);
                }
                if ((!plan.referenceSeeking || plan.writerSeeking) && term.kind === 'whole') {
                    exactLexicalMatch = true;
                }
                continue;
            }

            if (this.hasTokenBoundaryMatch(content, term.value)) {
                score = Math.max(score, (plan.referenceSeeking ? (declarationMatch ? 0.10 : 1.25) : 0.90) * termFactor);
                if (term.kind === 'whole') {
                    matchedWholeTerms.add(term.value);
                }
                if ((!plan.referenceSeeking || plan.writerSeeking) && term.kind === 'whole') {
                    exactLexicalMatch = true;
                }
                continue;
            }

            if (symbolLabel.includes(term.value)) {
                score = Math.max(score, (plan.referenceSeeking ? 0.04 : 0.55) * termFactor);
                if (term.kind === 'whole') {
                    matchedWholeTerms.add(term.value);
                }
                continue;
            }

            if (relativePath.includes(term.value)) {
                score = Math.max(score, (plan.referenceSeeking ? 0.04 : 0.45) * termFactor);
                if (term.kind === 'whole') {
                    matchedWholeTerms.add(term.value);
                }
                continue;
            }

            if (content.includes(term.value)) {
                score = Math.max(score, (plan.referenceSeeking ? (declarationMatch ? 0.08 : 0.30) : 0.25) * termFactor);
                if (term.kind === 'whole') {
                    matchedWholeTerms.add(term.value);
                }
            }
        }

        const coverageBoost = Math.min(
            matchedWholeTerms.size * (plan.implementationSeeking || plan.writerSeeking ? 0.18 : 0.08),
            plan.implementationSeeking || plan.writerSeeking ? 0.54 : 0.24
        );

        return {
            score: (score + coverageBoost) * plan.lexicalWeight,
            exactLexicalMatch,
        };
    }

    private pathMatchesAnyPattern(relativePath: string, patterns: string[]): boolean {
        if (patterns.length === 0) return false;
        const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
        for (const pattern of patterns) {
            try {
                const matcher = ignore();
                matcher.add(pattern);
                if (matcher.ignores(normalizedPath)) {
                    return true;
                }
            } catch {
                continue;
            }
        }
        return false;
    }

    private buildSearchPathMatcher(patterns: string[]): (relativePath: string) => boolean {
        if (patterns.length === 0) {
            return () => false;
        }
        const matchers: Array<ReturnType<typeof ignore>> = [];
        for (const pattern of patterns) {
            try {
                const matcher = ignore();
                matcher.add(pattern);
                matchers.push(matcher);
            } catch {
                continue;
            }
        }
        if (matchers.length === 0) {
            return () => false;
        }
        return (relativePath: string): boolean => {
            const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
            return matchers.some((matcher) => matcher.ignores(normalizedPath));
        };
    }

    private tokenMatchesAnyField(token: string, fields: string[]): boolean {
        for (const field of fields) {
            if (field.includes(token)) {
                return true;
            }
        }
        return false;
    }

    private resolveRerankDecision(scope: SearchScope, plan: SearchQueryPlan): {
        enabledByPolicy: boolean;
        skippedByScopeDocs: boolean;
        skippedByIdentifierIntent: boolean;
        capabilityPresent: boolean;
        rerankerPresent: boolean;
        enabled: boolean;
        exactMatchPinningEnabled: boolean;
    } {
        const capabilityPresent = this.capabilities.hasReranker();
        const enabledByPolicy = capabilityPresent && this.capabilities.getDefaultRerankEnabled();
        const rerankerPresent = this.reranker !== null;
        const skippedByScopeDocs = scope === 'docs';
        const skippedByIdentifierIntent = !plan.rerankAllowed;
        return {
            enabledByPolicy,
            skippedByScopeDocs,
            skippedByIdentifierIntent,
            capabilityPresent,
            rerankerPresent,
            enabled: enabledByPolicy && rerankerPresent && !skippedByScopeDocs && !skippedByIdentifierIntent,
            exactMatchPinningEnabled: plan.exactMatchPinningEnabled,
        };
    }

    private buildExactRegistrySymbolFilter(input: {
        scope: SearchScope;
        parsedOperators: ParsedSearchOperators;
    }): (symbol: SymbolRecord) => boolean {
        const includePathMatcher = this.buildSearchPathMatcher(input.parsedOperators.path);
        const excludePathMatcher = this.buildSearchPathMatcher(input.parsedOperators.excludePath);
        return (symbol: SymbolRecord): boolean => {
            const relativePath = this.normalizeRelativePathForIgnoreCheck(symbol.file);
            if (!relativePath) {
                return false;
            }
            const category = this.classifyPathCategory(relativePath);
            if (!this.shouldIncludeCategoryInScope(input.scope, category)) {
                return false;
            }
            const languageValue = symbol.language.toLowerCase();
            if (input.parsedOperators.lang.length > 0 && !input.parsedOperators.lang.includes(languageValue)) {
                return false;
            }
            if (input.parsedOperators.path.length > 0 && !includePathMatcher(relativePath)) {
                return false;
            }
            if (input.parsedOperators.excludePath.length > 0 && excludePathMatcher(relativePath)) {
                return false;
            }
            const fields = [
                symbol.label,
                relativePath,
                symbol.name,
                symbol.qualifiedName,
                ...symbol.parentQualifiedNamePath,
            ];
            if (!input.parsedOperators.must.every((token) => this.tokenMatchesAnyField(token, fields))) {
                return false;
            }
            return !input.parsedOperators.exclude.some((token) => this.tokenMatchesAnyField(token, fields));
        };
    }

    private buildUnavailableExactRegistryDebug(reason: string): ExactRegistryLookupDebug {
        return {
            attempted: true,
            status: 'miss',
            reason: 'registry_unavailable',
            inspectedSymbolCount: 0,
            filteredSymbolCount: 0,
            registryUnavailableReason: reason,
        };
    }

    private buildRerankDocument(result: any): string {
        const relativePath = typeof result?.relativePath === 'string' ? result.relativePath : '';
        const language = typeof result?.language === 'string' ? result.language : 'unknown';
        const symbolLabel = typeof result?.symbolLabel === 'string' ? result.symbolLabel : '';
        const content = typeof result?.content === 'string' ? result.content : '';
        const contentLines = content.split(/\r?\n/).slice(0, SEARCH_RERANK_DOC_MAX_LINES);
        let normalizedContent = contentLines.join('\n');
        if (normalizedContent.length > SEARCH_RERANK_DOC_MAX_CHARS) {
            normalizedContent = normalizedContent.slice(0, SEARCH_RERANK_DOC_MAX_CHARS);
        }
        return `${relativePath}\n${language}\n${symbolLabel}\n${normalizedContent}`;
    }

    private buildOperatorSummary(operators: ParsedSearchOperators): SearchOperatorSummary {
        return {
            prefixBlockChars: operators.prefixBlockChars,
            lang: [...operators.lang],
            path: [...operators.path],
            excludePath: [...operators.excludePath],
            must: [...operators.must],
            exclude: [...operators.exclude],
        };
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
        const currentStatus = this.snapshotManager.getCodebaseStatus(codebasePath);
        const isIndexedLikeStatus = currentStatus === 'indexed' || currentStatus === 'sync_completed';
        if (currentStatus === 'requires_reindex') {
            return {
                outcome: 'reindex_required',
                warnings: [],
                confidence: 'high',
            };
        }

        const gate = this.snapshotManager.ensureFingerprintCompatibilityOnAccess(codebasePath);
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

    private applyGroupDiversity<T extends SearchGroupResult>(
        grouped: T[],
        limit: number,
        groupBy: SearchGroupBy
    ): { selected: T[]; summary: SearchDiversitySummary } {
        const summary: SearchDiversitySummary = {
            maxPerFile: SEARCH_DIVERSITY_MAX_PER_FILE,
            maxPerSymbol: SEARCH_DIVERSITY_MAX_PER_SYMBOL,
            relaxedFileCap: SEARCH_DIVERSITY_RELAXED_FILE_CAP,
            skippedByFileCap: 0,
            skippedBySymbolCap: 0,
            usedRelaxedCap: false,
        };

        const selected: T[] = [];
        const selectedIds = new Set<string>();
        const fileCounts = new Map<string, number>();
        const symbolCounts = new Map<string, number>();

        const applyPass = (fileCap: number): void => {
            for (const group of grouped) {
                if (selected.length >= limit) {
                    return;
                }
                if (selectedIds.has(group.groupId)) {
                    continue;
                }

                const fileCount = fileCounts.get(group.file) || 0;
                if (fileCount >= fileCap) {
                    summary.skippedByFileCap += 1;
                    continue;
                }

                const symbolDiversityKey = group.symbolInstanceId || group.symbolKey || group.symbolId;
                if (groupBy === "symbol" && typeof symbolDiversityKey === "string") {
                    const symbolCount = symbolCounts.get(symbolDiversityKey) || 0;
                    if (symbolCount >= SEARCH_DIVERSITY_MAX_PER_SYMBOL) {
                        summary.skippedBySymbolCap += 1;
                        continue;
                    }
                    symbolCounts.set(symbolDiversityKey, symbolCount + 1);
                }

                selected.push(group);
                selectedIds.add(group.groupId);
                fileCounts.set(group.file, fileCount + 1);
            }
        };

        applyPass(SEARCH_DIVERSITY_MAX_PER_FILE);
        if (selected.length < Math.min(limit, grouped.length)) {
            summary.usedRelaxedCap = true;
            applyPass(SEARCH_DIVERSITY_RELAXED_FILE_CAP);
        }

        return { selected: selected.slice(0, limit), summary };
    }

    private shouldIncludeCategoryInScope(scope: SearchScope, category: PathCategory): boolean {
        if (scope === 'runtime') {
            return category !== 'docs'
                && category !== 'generated'
                && category !== 'artifact'
                && category !== 'landing'
                && category !== 'fixture';
        }
        if (scope === 'docs') {
            return category === 'docs' || category === 'tests';
        }
        return true;
    }

    private isImplementationPathCategory(category: PathCategory): boolean {
        return category === 'entrypoint'
            || category === 'core'
            || category === 'srcRuntime'
            || category === 'scriptRuntime'
            || category === 'adapter'
            || category === 'neutral';
    }

    private shouldApplyChangedFilesBoost(category: PathCategory, plan: SearchQueryPlan): boolean {
        if (category === 'tests') {
            return plan.testSeeking;
        }
        return this.isImplementationPathCategory(category);
    }

    private classifyAgentFitSymbolRole(result: any): 'implementation' | 'type' | 'schema' | 'anonymous' | 'unknown' {
        const label = typeof result?.symbolLabel === 'string'
            ? result.symbolLabel.trim().toLowerCase()
            : '';
        const content = typeof result?.content === 'string'
            ? result.content.slice(0, 400).toLowerCase()
            : '';
        const evidence = `${label}\n${content}`;

        if (/<anonymous>/.test(evidence)) {
            return 'anonymous';
        }
        if (/\b(?:schema|inputschema|outputschema|responseenvelope|requestinput)\b/.test(evidence)) {
            return 'schema';
        }
        if (/^(?:interface|type|enum)\b/.test(label)) {
            return 'type';
        }
        if (/^(?:async\s+)?(?:function|method|class|def)\b/.test(label)) {
            return 'implementation';
        }
        if (/^(?:const|let|var)\s+[a-z0-9_$]+\s*=/.test(label)
            && /\b(?:async\s+)?function\b|=>/.test(content)) {
            return 'implementation';
        }

        return 'unknown';
    }

    private isWriterOwnerResult(result: any): boolean {
        const label = typeof result?.symbolLabel === 'string'
            ? result.symbolLabel.trim().toLowerCase()
            : '';
        const content = typeof result?.content === 'string'
            ? result.content.slice(0, 800).toLowerCase()
            : '';
        const evidence = `${label}\n${content}`;

        if (/^(?:async\s+)?(?:(?:function|method|const|let|var)\s+)?(?:[a-z0-9_$]+\.)*(?:write|update|build|prepare|generate|emit|install|configure|persist|create|ensure|set|save|add|remove|delete)[a-z0-9_$]*(?:\b|\()/.test(label)) {
            return true;
        }
        return /\b(?:writefilesync|writefile|appendfile|mkdir|rename|unlink|rm|copyfile|lines\.splice)\b/.test(evidence);
    }

    private isStrongWriterOwnerResult(result: any): boolean {
        const label = typeof result?.symbolLabel === 'string'
            ? result.symbolLabel.trim().toLowerCase()
            : '';
        const content = typeof result?.content === 'string'
            ? result.content.slice(0, 800).toLowerCase()
            : '';
        const evidence = `${label}\n${content}`;

        if (/^(?:async\s+)?(?:(?:function|method|const|let|var)\s+)?(?:[a-z0-9_$]+\.)*(?:write|update|generate|emit|install|configure|persist|create|set|save|add|remove|delete)[a-z0-9_$]*(?:\b|\()/.test(label)) {
            return true;
        }
        return /\b(?:writefilesync|writefile|appendfile|mkdir|rename|unlink|rm|copyfile|lines\.splice)\b/.test(evidence);
    }

    private isWriterActionTerm(term: string): boolean {
        return /^(?:write|writes|writing|written|update|updates|updated|updating|create|creates|created|creating|generate|generates|generated|generating|emit|emits|emitted|emitting|persist|persists|persisted|persisting|configure|configures|configured|configuring|install|installs|installed|installing|build|builds|built|builder)$/.test(term);
    }

    private countCandidateDomainTermMatches(plan: SearchQueryPlan, result: any): number {
        const content = typeof result?.content === 'string' ? result.content : '';
        const label = typeof result?.symbolLabel === 'string' ? result.symbolLabel : '';
        const relativePath = typeof result?.relativePath === 'string' ? result.relativePath : '';
        const evidence = `${label}\n${relativePath}\n${content}`
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[/\\._:-]+/g, ' ')
            .toLowerCase();
        const matched = new Set<string>();

        for (const term of plan.lexicalTerms) {
            if (term.kind !== 'whole' || this.isWriterActionTerm(term.value)) {
                continue;
            }
            if (this.hasTokenBoundaryMatch(evidence, term.value)) {
                matched.add(term.value);
            }
        }

        return matched.size;
    }

    private resolveAgentFitMultiplier(
        plan: SearchQueryPlan,
        result: any,
        category: PathCategory,
        scope: SearchScope
    ): { multiplier: number; reason: string } {
        if (scope === 'docs') {
            return { multiplier: SEARCH_AGENT_FIT_NEUTRAL, reason: 'docs_scope_neutral' };
        }

        if (category === 'tests') {
            if (plan.testSeeking) {
                return { multiplier: SEARCH_AGENT_FIT_TEST_INTENT_MULTIPLIER, reason: 'test_intent' };
            }
            if (plan.implementationSeeking) {
                return {
                    multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_TEST_DEMOTION,
                    reason: 'implementation_query_test_demotion',
                };
            }
            return {
                multiplier: scope === 'mixed'
                    ? SEARCH_AGENT_FIT_TEST_DEMOTION_MIXED
                    : SEARCH_AGENT_FIT_TEST_DEMOTION_RUNTIME,
                reason: 'test_without_test_intent',
            };
        }

        const role = this.classifyAgentFitSymbolRole(result);
        const domainTermMatches = plan.writerSeeking
            ? this.countCandidateDomainTermMatches(plan, result)
            : 0;
        if (plan.writerSeeking) {
            if (this.isWriterOwnerResult(result)
                && this.isImplementationPathCategory(category)
                && (domainTermMatches >= 2 || this.isStrongWriterOwnerResult(result))) {
                return { multiplier: SEARCH_AGENT_FIT_WRITER_OWNER_MULTIPLIER, reason: 'writer_owner' };
            }
            if (role === 'implementation'
                && this.isImplementationPathCategory(category)
                && domainTermMatches >= 2) {
                return { multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_SYMBOL_MULTIPLIER, reason: 'implementation_symbol' };
            }
            if (role === 'schema') {
                return { multiplier: SEARCH_AGENT_FIT_SCHEMA_DEMOTION, reason: 'schema_not_owner' };
            }
            if (role === 'type') {
                return { multiplier: SEARCH_AGENT_FIT_TYPE_DEMOTION, reason: 'type_not_owner' };
            }
            if (role === 'anonymous') {
                return { multiplier: SEARCH_AGENT_FIT_ANONYMOUS_DEMOTION, reason: 'anonymous_not_owner' };
            }
            return { multiplier: SEARCH_AGENT_FIT_WRITER_NON_OWNER_DEMOTION, reason: 'writer_query_non_writer' };
        }
        if (plan.implementationSeeking && category === 'scriptRuntime') {
            return { multiplier: SEARCH_AGENT_FIT_SCRIPT_IMPLEMENTATION_MULTIPLIER, reason: 'script_implementation' };
        }
        if (plan.implementationSeeking && role === 'schema') {
            return { multiplier: SEARCH_AGENT_FIT_SCHEMA_DEMOTION, reason: 'schema_not_owner' };
        }
        if (plan.implementationSeeking && role === 'type') {
            return { multiplier: SEARCH_AGENT_FIT_TYPE_DEMOTION, reason: 'type_not_owner' };
        }
        if (plan.implementationSeeking && role === 'anonymous') {
            return { multiplier: SEARCH_AGENT_FIT_ANONYMOUS_DEMOTION, reason: 'anonymous_not_owner' };
        }
        if (plan.implementationSeeking && role === 'implementation') {
            return { multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_SYMBOL_MULTIPLIER, reason: 'implementation_symbol' };
        }
        if (plan.implementationSeeking
            && !result?.symbolLabel
            && this.isImplementationPathCategory(category)) {
            return { multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_CHUNK_MULTIPLIER, reason: 'implementation_chunk' };
        }

        return { multiplier: SEARCH_AGENT_FIT_NEUTRAL, reason: 'neutral' };
    }

    private parseIndexedAtMs(indexedAt?: string): number | undefined {
        if (!indexedAt) return undefined;
        const parsed = Date.parse(indexedAt);
        if (!Number.isFinite(parsed)) return undefined;
        return parsed;
    }

    private getStalenessBucket(indexedAt?: string): StalenessBucket {
        const indexedAtMs = this.parseIndexedAtMs(indexedAt);
        if (indexedAtMs === undefined) {
            return 'unknown';
        }
        const ageMs = Math.max(0, this.now() - indexedAtMs);
        if (ageMs <= STALENESS_THRESHOLDS_MS.fresh) return 'fresh';
        if (ageMs <= STALENESS_THRESHOLDS_MS.aging) return 'aging';
        return 'stale';
    }

    private compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
        const av = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
        const bv = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
        return av - bv;
    }

    private compareNullableStringsAsc(a?: string | null, b?: string | null): number {
        if (!a && !b) return 0;
        if (!a) return 1;
        if (!b) return -1;
        return a.localeCompare(b);
    }

    private compareSearchCandidates(a: SearchCandidate, b: SearchCandidate, options?: { exactMatchFirst?: boolean; mustMatchesFirst?: boolean }): number {
        if (options?.mustMatchesFirst === true && a.passesMatchedMust !== b.passesMatchedMust) {
            return a.passesMatchedMust ? -1 : 1;
        }
        if (options?.exactMatchFirst === true && a.exactLexicalMatch !== b.exactLexicalMatch) {
            return a.exactLexicalMatch ? -1 : 1;
        }
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        const fileCmp = this.compareNullableStringsAsc(a.result.relativePath, b.result.relativePath);
        if (fileCmp !== 0) return fileCmp;
        const startCmp = this.compareNullableNumbersAsc(a.result.startLine, b.result.startLine);
        if (startCmp !== 0) return startCmp;
        const labelCmp = this.compareNullableStringsAsc(a.result.symbolLabel, b.result.symbolLabel);
        if (labelCmp !== 0) return labelCmp;
        return this.compareNullableStringsAsc(a.result.symbolId, b.result.symbolId);
    }

    private sortSearchCandidates(candidates: SearchCandidate[], exactMatchFirst: boolean, mustMatchesFirst = false): boolean {
        const topWithoutPinning = candidates.length > 0
            ? [...candidates].sort((a, b) => this.compareSearchCandidates(a, b, { mustMatchesFirst }))[0]
            : undefined;
        candidates.sort((a, b) => this.compareSearchCandidates(a, b, { exactMatchFirst, mustMatchesFirst }));
        if (!exactMatchFirst || !topWithoutPinning || candidates.length === 0) {
            return false;
        }
        const applied = topWithoutPinning.exactLexicalMatch !== candidates[0].exactLexicalMatch;
        if (applied) {
            candidates[0].exactMatchPinned = true;
        }
        return applied;
    }

    private compareGroupedSearchResults(
        a: SearchGroupResult & { __exactLexicalMatch: boolean },
        b: SearchGroupResult & { __exactLexicalMatch: boolean },
    ): number {
        if (b.score !== a.score) return b.score - a.score;
        const fileCmp = a.file.localeCompare(b.file);
        if (fileCmp !== 0) return fileCmp;
        const spanCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
        if (spanCmp !== 0) return spanCmp;
        const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
        if (labelCmp !== 0) return labelCmp;
        return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
    }

    private sortGroupedSearchResults<T extends SearchGroupResult & { __exactLexicalMatch: boolean }>(
        results: T[],
        exactMatchPinningEnabled: boolean,
    ): boolean {
        const topWithoutPinning = results.length > 0
            ? [...results].sort((a, b) => this.compareGroupedSearchResults(a, b))[0]
            : undefined;
        results.sort((a, b) => {
            if (exactMatchPinningEnabled && a.__exactLexicalMatch !== b.__exactLexicalMatch) {
                return a.__exactLexicalMatch ? -1 : 1;
            }
            return this.compareGroupedSearchResults(a, b);
        });
        const applied = Boolean(
            exactMatchPinningEnabled
            && topWithoutPinning
            && results.length > 0
            && topWithoutPinning.__exactLexicalMatch !== results[0].__exactLexicalMatch
        );
        if (applied && results[0].debug?.provenance) {
            results[0].debug.provenance.exactMatchPinned = true;
        }
        return applied;
    }

    private buildSearchCandidateProvenance(candidate: SearchCandidate, ownerSource: SearchOwnerSource = 'fallback') {
        const retrievalPasses = [...candidate.retrievalPasses].sort();
        const backendScoreKinds = [...candidate.backendScoreKindsSeen].sort();
        return {
            retrievalPasses,
            backendScoreKinds,
            semanticCandidate: retrievalPasses.some((passId) => passId === 'primary' || passId === 'expanded'),
            lexicalCandidate: retrievalPasses.some((passId) => passId === 'lexical_files' || passId === 'live_path')
                || backendScoreKinds.includes('lexical_rank'),
            rerankAdjusted: candidate.rerankAdjusted,
            exactMatchPinned: candidate.exactMatchPinned,
            ownerRepairApplied: ownerSource === 'registry_repair',
        };
    }

    private buildExactRegistryGroupResult(input: {
        codebaseRoot: string;
        symbol: SymbolRecord;
        indexedAt: string | null;
        callGraphNavigationState: {
            relationshipReady: boolean;
            relationshipBuiltAt?: string;
            relationshipUnavailableReason?: CallGraphUnavailableReason;
        };
        sidecarReadyForOutline: boolean;
        debug: boolean;
    }): SearchGroupResult & { __exactLexicalMatch: boolean } {
        const span: SearchSpan = {
            startLine: input.symbol.span.startLine,
            endLine: input.symbol.span.endLine,
        };
        const callGraphHint = this.buildSearchGroupCallGraphHint({
            file: input.symbol.file,
            language: input.symbol.language,
            span,
            symbolLabel: input.symbol.label,
            ownerSymbolInstanceId: input.symbol.symbolInstanceId,
            registrySymbol: input.symbol,
            registryLoaded: true,
            navigationState: input.callGraphNavigationState,
        });
        const navigationFallback = this.buildNavigationFallback(
            input.codebaseRoot,
            input.symbol.file,
            span,
            callGraphHint,
            input.sidecarReadyForOutline
        );
        const nextActions = this.buildSearchNextActions(
            input.codebaseRoot,
            input.symbol.file,
            span,
            callGraphHint,
            input.sidecarReadyForOutline
        );
        const preview = [
            input.symbol.label,
            input.symbol.qualifiedName !== input.symbol.label ? input.symbol.qualifiedName : '',
        ].filter(Boolean).join('\n');

        return {
            kind: "group",
            groupId: input.symbol.symbolInstanceId,
            file: input.symbol.file,
            span,
            language: input.symbol.language,
            symbolId: input.symbol.symbolInstanceId,
            symbolLabel: input.symbol.label,
            symbolKey: input.symbol.symbolKey,
            symbolInstanceId: input.symbol.symbolInstanceId,
            symbolKind: input.symbol.kind,
            confidence: 'high',
            score: 1,
            indexedAt: input.indexedAt,
            stalenessBucket: this.getStalenessBucket(input.indexedAt || undefined),
            collapsedChunkCount: 1,
            callGraphHint,
            ...(navigationFallback ? { navigationFallback } : {}),
            ...(nextActions ? { nextActions } : {}),
            preview: truncateContent(preview, SEARCH_GROUP_PREVIEW_MAX_CHARS),
            __exactLexicalMatch: true,
            ...(input.debug ? {
                debug: {
                    representativeChunkCount: 1,
                    pathCategory: this.classifyPathCategory(input.symbol.file),
                    pathMultiplier: 1,
                    topChunkScore: 1,
                    lexicalScore: 1,
                    changedFilesMultiplier: 1,
                    agentFitMultiplier: 1,
                    agentFitReason: 'exact_registry',
                    matchesMust: true,
                    exactLexicalMatch: true,
                    provenance: {
                        retrievalPasses: ['exact_registry'],
                        backendScoreKinds: [],
                        semanticCandidate: false,
                        lexicalCandidate: false,
                        rerankAdjusted: false,
                        exactMatchPinned: false,
                        ownerRepairApplied: false,
                    },
                }
            } : {})
        };
    }

    private isDeclarationSearchGroup(group: SearchGroupResult): boolean {
        const label = (group.symbolLabel || '').trim().toLowerCase();
        if (/^(class|type|interface|enum|struct|function|def)\b/.test(label)) {
            return true;
        }
        if (/^(const|let|var)\s+[a-z0-9_$]+\s*=/.test(label)) {
            return true;
        }

        const previewStart = (group.preview || '').slice(0, 240).toLowerCase();
        return /\b(class|type|interface|enum|struct|function|def)\s+[a-z0-9_]/i.test(previewStart)
            || /\b(?:const|let|var)\s+[a-z0-9_$]+\s*=\s*(?:async\s+)?function\b/i.test(previewStart)
            || /\b(?:const|let|var)\s+[a-z0-9_$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>/i.test(previewStart);
    }

    private normalizeDeclarationGroupKey(group: SearchGroupResult): string | null {
        if (!group.file || !group.symbolLabel) {
            return null;
        }
        if (!this.isDeclarationSearchGroup(group)) {
            return null;
        }

        const normalizedLabel = group.symbolLabel
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        const ownerIdentity = group.symbolKey || group.symbolInstanceId;
        return ownerIdentity
            ? `${group.file}::${normalizedLabel}::${ownerIdentity}`
            : `${group.file}::${normalizedLabel}`;
    }

    private collapseDuplicateDeclarationGroups<T extends SearchGroupResult>(groups: T[]): T[] {
        const deduped = new Map<string, T>();
        for (const group of groups) {
            const key = this.normalizeDeclarationGroupKey(group);
            if (!key) {
                deduped.set(`unique:${deduped.size}`, group);
                continue;
            }

            const existing = deduped.get(key);
            if (!existing) {
                deduped.set(key, group);
                continue;
            }

            const existingComparable: SearchCandidate = {
                result: {
                    relativePath: existing.file,
                    startLine: existing.span.startLine,
                    endLine: existing.span.endLine,
                    symbolId: existing.symbolId || undefined,
                    symbolLabel: existing.symbolLabel || undefined,
                },
                baseScore: 0,
                backendScore: 0,
                backendScoreKind: 'unknown',
                backendScoreKindsSeen: ['unknown'],
                fusionScore: 0,
                lexicalScore: existing.debug?.lexicalScore || 0,
                finalScore: existing.score,
                pathCategory: (existing.debug?.pathCategory as PathCategory | undefined) || 'neutral',
                pathMultiplier: existing.debug?.pathMultiplier || 1,
                changedFilesMultiplier: existing.debug?.changedFilesMultiplier || 1,
                agentFitMultiplier: existing.debug?.agentFitMultiplier || SEARCH_AGENT_FIT_NEUTRAL,
                agentFitReason: existing.debug?.agentFitReason || 'neutral',
                passesMatchedMust: existing.debug?.matchesMust === true,
                exactLexicalMatch: (existing as T & { __exactLexicalMatch?: boolean }).__exactLexicalMatch === true,
                exactMatchPinned: existing.debug?.provenance?.exactMatchPinned === true,
                rerankAdjusted: existing.debug?.provenance?.rerankAdjusted === true,
                retrievalPasses: existing.debug?.provenance?.retrievalPasses || [],
            };
            const nextComparable: SearchCandidate = {
                result: {
                    relativePath: group.file,
                    startLine: group.span.startLine,
                    endLine: group.span.endLine,
                    symbolId: group.symbolId || undefined,
                    symbolLabel: group.symbolLabel || undefined,
                },
                baseScore: 0,
                backendScore: 0,
                backendScoreKind: 'unknown',
                backendScoreKindsSeen: ['unknown'],
                fusionScore: 0,
                lexicalScore: group.debug?.lexicalScore || 0,
                finalScore: group.score,
                pathCategory: (group.debug?.pathCategory as PathCategory | undefined) || 'neutral',
                pathMultiplier: group.debug?.pathMultiplier || 1,
                changedFilesMultiplier: group.debug?.changedFilesMultiplier || 1,
                agentFitMultiplier: group.debug?.agentFitMultiplier || SEARCH_AGENT_FIT_NEUTRAL,
                agentFitReason: group.debug?.agentFitReason || 'neutral',
                passesMatchedMust: group.debug?.matchesMust === true,
                exactLexicalMatch: (group as T & { __exactLexicalMatch?: boolean }).__exactLexicalMatch === true,
                exactMatchPinned: group.debug?.provenance?.exactMatchPinned === true,
                rerankAdjusted: group.debug?.provenance?.rerankAdjusted === true,
                retrievalPasses: group.debug?.provenance?.retrievalPasses || [],
            };

            if (this.compareSearchCandidates(nextComparable, existingComparable) < 0) {
                deduped.set(key, group);
                continue;
            }
        }

        return Array.from(deduped.values());
    }

    private buildFallbackGroupId(relativePath: string, span: SearchSpan): string {
        const payload = `${relativePath}:${span.startLine}-${span.endLine}`;
        const digest = crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 16);
        return `grp_${digest}`;
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

    private isPartialIndexNavigationUnavailable(info: { indexStatus?: unknown } | undefined): boolean {
        return info?.indexStatus === 'limit_reached';
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
        if (!this.isCallGraphLanguageSupported(input.language, input.file)) {
            return { supported: false, reason: 'unsupported_language' };
        }

        const normalizedFile = this.sanitizeIndexedRelativeFilePath(input.file);
        if (!normalizedFile) {
            return { supported: false, reason: 'stale_symbol_ref' };
        }

        const validatedAt = new Date(this.now()).toISOString();
        const safeStartLine = Math.max(1, Number(input.span.startLine));
        const safeEndLine = Math.max(safeStartLine, Number(input.span.endLine));

        return {
            supported: true,
            validated: true,
            validatedAt,
            sidecarBuiltAt: input.sidecarBuiltAt || validatedAt,
            symbolRef: {
                file: normalizedFile,
                symbolId: input.symbolId,
                ...(input.symbolLabel ? { symbolLabel: input.symbolLabel } : {}),
                span: {
                    startLine: safeStartLine,
                    endLine: safeEndLine,
                },
            },
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

    private buildSearchOwnerChunk(result: any): CodeChunk | null {
        const startLine = Number(result?.startLine);
        const endLine = Number(result?.endLine);
        if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
            return null;
        }

        const metadata: CodeChunk['metadata'] = {
            startLine: Math.max(1, startLine),
            endLine: Math.max(Math.max(1, startLine), endLine),
            language: typeof result?.language === 'string' ? result.language : undefined,
            filePath: typeof result?.relativePath === 'string' ? result.relativePath : undefined,
            symbolId: typeof result?.symbolId === 'string' ? result.symbolId : undefined,
            symbolLabel: typeof result?.symbolLabel === 'string' ? result.symbolLabel : undefined,
            symbolKind: typeof result?.symbolKind === 'string' ? result.symbolKind : undefined,
        };
        if (Number.isFinite(result?.startByte)) {
            metadata.startByte = Number(result.startByte);
        }
        if (Number.isFinite(result?.endByte)) {
            metadata.endByte = Number(result.endByte);
        }

        return {
            content: String(result?.content || ''),
            metadata,
        };
    }

    private resolveBestOverlappingSearchSymbol(
        fileSymbols: SymbolRecord[],
        ownerChunk: CodeChunk,
        plan: SearchQueryPlan
    ): SymbolRecord | undefined {
        const chunkStart = Math.max(1, Number(ownerChunk.metadata.startLine || 1));
        const chunkEnd = Math.max(chunkStart, Number(ownerChunk.metadata.endLine || chunkStart));
        const chunkLines = ownerChunk.content.split(/\r?\n/);
        const normalizeSymbolEvidence = (value: string): string => value
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[/\\._:-]+/g, ' ')
            .toLowerCase();
        const scored = fileSymbols
            .filter((symbol) => symbol.kind !== 'file')
            .filter((symbol) => symbol.span.startLine <= chunkEnd && chunkStart <= symbol.span.endLine)
            .map((symbol) => {
                const symbolName = normalizeSymbolEvidence(symbol.name);
                const symbolIdentityEvidence = normalizeSymbolEvidence([
                    symbol.name,
                    symbol.qualifiedName,
                    symbol.label,
                ].join('\n'));
                const symbolParentEvidence = normalizeSymbolEvidence(symbol.parentQualifiedNamePath.join('\n'));
                const symbolRelativeStart = Math.max(0, symbol.span.startLine - chunkStart);
                const symbolRelativeEnd = Math.max(symbolRelativeStart, symbol.span.endLine - chunkStart);
                const symbolContent = chunkLines
                    .slice(symbolRelativeStart, symbolRelativeEnd + 1)
                    .join('\n')
                    .toLowerCase();
                const matchedDomainTerms = new Set<string>();
                let symbolNameMatches = 0;
                let identityMatches = 0;
                let contentMatches = 0;
                let strongIdentifierMatches = 0;
                for (const term of plan.lexicalTerms) {
                    if (term.kind !== 'whole' || this.isWriterActionTerm(term.value)) {
                        continue;
                    }
                    const nameMatch = this.hasTokenBoundaryMatch(symbolName, term.value);
                    const identityMatch = this.hasTokenBoundaryMatch(symbolIdentityEvidence, term.value);
                    const parentMatch = this.hasTokenBoundaryMatch(symbolParentEvidence, term.value);
                    const contentMatch = this.hasTokenBoundaryMatch(symbolContent, term.value);
                    if (nameMatch) {
                        symbolNameMatches += 1;
                    }
                    if (identityMatch || parentMatch) {
                        identityMatches += 1;
                    }
                    if (contentMatch) {
                        contentMatches += 1;
                    }
                    if (identityMatch || parentMatch || contentMatch) {
                        matchedDomainTerms.add(term.value);
                    }
                    if (identityMatch && /[_/\\.:]/.test(term.value)) {
                        strongIdentifierMatches += 1;
                    }
                }
                return {
                    symbol,
                    lexicalMatches: matchedDomainTerms.size,
                    symbolNameMatches,
                    identityMatches,
                    contentMatches,
                    strongIdentifierMatches,
                };
            })
            .filter((entry) => (
                entry.lexicalMatches >= 2
                || entry.symbolNameMatches > 0
                || entry.strongIdentifierMatches > 0
            ))
            .sort((a, b) => {
                if (b.lexicalMatches !== a.lexicalMatches) return b.lexicalMatches - a.lexicalMatches;
                if (b.symbolNameMatches !== a.symbolNameMatches) return b.symbolNameMatches - a.symbolNameMatches;
                if (b.identityMatches !== a.identityMatches) return b.identityMatches - a.identityMatches;
                if (b.strongIdentifierMatches !== a.strongIdentifierMatches) return b.strongIdentifierMatches - a.strongIdentifierMatches;
                if (b.contentMatches !== a.contentMatches) return b.contentMatches - a.contentMatches;
                const aLines = a.symbol.span.endLine - a.symbol.span.startLine;
                const bLines = b.symbol.span.endLine - b.symbol.span.startLine;
                if (aLines !== bLines) return aLines - bLines;
                const aDepth = a.symbol.parentQualifiedNamePath.length;
                const bDepth = b.symbol.parentQualifiedNamePath.length;
                if (aDepth !== bDepth) return bDepth - aDepth;
                const startCmp = this.compareNullableNumbersAsc(a.symbol.span.startLine, b.symbol.span.startLine);
                if (startCmp !== 0) return startCmp;
                return this.compareNullableStringsAsc(a.symbol.symbolInstanceId, b.symbol.symbolInstanceId);
            });

        const [best, second] = scored;
        if (best && second
            && best.lexicalMatches === second.lexicalMatches
            && best.symbolNameMatches === second.symbolNameMatches
            && best.identityMatches === second.identityMatches
            && best.strongIdentifierMatches === second.strongIdentifierMatches
            && best.contentMatches === second.contentMatches) {
            return undefined;
        }
        return scored[0]?.symbol;
    }

    private resolveSearchOwnerFromRegistry(result: any, registry?: SymbolRegistry, plan?: SearchQueryPlan): SearchOwnerResolution {
        const metadataOwnerKey = typeof result?.ownerSymbolKey === 'string' && result.ownerSymbolKey.length > 0
            ? result.ownerSymbolKey
            : undefined;
        const metadataOwnerInstanceId = typeof result?.ownerSymbolInstanceId === 'string' && result.ownerSymbolInstanceId.length > 0
            ? result.ownerSymbolInstanceId
            : undefined;
        const metadataSymbolKind = typeof result?.symbolKind === 'string' && result.symbolKind.length > 0
            ? result.symbolKind
            : undefined;

        if (!registry) {
            return metadataOwnerKey
                ? {
                    ownerSymbolKey: metadataOwnerKey,
                    ownerSymbolInstanceId: metadataOwnerInstanceId,
                    symbolKind: metadataSymbolKind,
                    ownerSource: 'owner_metadata',
                }
                : {};
        }

        const normalizedFile = typeof result?.relativePath === 'string'
            ? this.sanitizeIndexedRelativeFilePath(result.relativePath)
            : undefined;
        const fileSymbols = normalizedFile ? registry.symbolsByFile.get(normalizedFile) : undefined;
        const ownerChunk = this.buildSearchOwnerChunk(result);

        if (
            metadataOwnerKey
            && metadataOwnerInstanceId
            && registry.symbolsByInstanceId.has(metadataOwnerInstanceId)
        ) {
            const owner = registry.symbolsByInstanceId.get(metadataOwnerInstanceId);
            if (owner?.kind === 'file' && fileSymbols && ownerChunk && plan) {
                const tighterOwner = this.resolveBestOverlappingSearchSymbol(fileSymbols, ownerChunk, plan);
                if (tighterOwner && tighterOwner.symbolInstanceId !== metadataOwnerInstanceId) {
                    return {
                        ownerSymbolKey: tighterOwner.symbolKey,
                        ownerSymbolInstanceId: tighterOwner.symbolInstanceId,
                        symbolKind: tighterOwner.kind,
                        ownerSource: 'registry_repair',
                    };
                }
            }
            return {
                ownerSymbolKey: metadataOwnerKey,
                ownerSymbolInstanceId: metadataOwnerInstanceId,
                symbolKind: owner?.kind || metadataSymbolKind,
                ownerSource: 'owner_metadata',
            };
        }

        if (fileSymbols && ownerChunk) {
            try {
                if (plan) {
                    const overlappingOwner = this.resolveBestOverlappingSearchSymbol(fileSymbols, ownerChunk, plan);
                    if (overlappingOwner) {
                        return {
                            ownerSymbolKey: overlappingOwner.symbolKey,
                            ownerSymbolInstanceId: overlappingOwner.symbolInstanceId,
                            symbolKind: overlappingOwner.kind,
                            ownerSource: 'registry_repair',
                        };
                    }
                }
                if (metadataOwnerKey) {
                    const keyCandidates = fileSymbols.filter((symbol) => symbol.symbolKey === metadataOwnerKey);
                    if (keyCandidates.length > 0) {
                        const owner = resolveOwnerSymbolForChunk({
                            chunk: ownerChunk,
                            symbols: keyCandidates.some((symbol) => symbol.kind === 'file') ? keyCandidates : [
                                ...fileSymbols.filter((symbol) => symbol.kind === 'file'),
                                ...keyCandidates,
                            ],
                        });
                        if (owner.symbolKey === metadataOwnerKey) {
                            return {
                                ownerSymbolKey: owner.symbolKey,
                                ownerSymbolInstanceId: owner.symbolInstanceId,
                                symbolKind: owner.kind,
                                ownerSource: 'registry_repair',
                            };
                        }
                    }
                }

                const owner = resolveOwnerSymbolForChunk({ chunk: ownerChunk, symbols: fileSymbols });
                return {
                    ownerSymbolKey: owner.symbolKey,
                    ownerSymbolInstanceId: owner.symbolInstanceId,
                    symbolKind: owner.kind,
                    ownerSource: 'registry_repair',
                };
            } catch {
                // Registry repair is a compatibility aid; fallback paths below preserve search usability.
            }
        }

        return metadataOwnerKey
            ? {
                ownerSymbolKey: metadataOwnerKey,
                ownerSymbolInstanceId: metadataOwnerInstanceId,
                symbolKind: metadataSymbolKind,
                ownerSource: 'owner_metadata',
            }
            : {};
    }

    private buildNavigationFallback(
        codebaseRoot: string,
        relativeFilePath: string,
        span: SearchSpan,
        callGraphHint: CallGraphHint,
        sidecarReadyForOutline: boolean
    ): SearchGroupResult['navigationFallback'] | undefined {
        if (callGraphHint.supported) {
            return undefined;
        }

        const normalizedFile = this.sanitizeIndexedRelativeFilePath(relativeFilePath);
        if (!normalizedFile) {
            return undefined;
        }

        const safeStartLine = Number.isFinite(span.startLine) ? Math.max(1, Number(span.startLine)) : 1;
        const safeEndLine = Number.isFinite(span.endLine) ? Math.max(safeStartLine, Number(span.endLine)) : safeStartLine;
        const absolutePath = path.resolve(codebaseRoot, normalizedFile);

        const fallback: SearchGroupResult['navigationFallback'] = {
            message: NAVIGATION_FALLBACK_MESSAGE,
            context: {
                codebaseRoot,
                relativeFile: normalizedFile,
            },
            readSpan: {
                tool: 'read_file',
                args: {
                    path: absolutePath,
                    start_line: safeStartLine,
                    end_line: safeEndLine,
                }
            }
        };

        if (sidecarReadyForOutline && this.getOutlineStatusForLanguage(normalizedFile) === 'ok') {
            fallback.fileOutlineWindow = {
                tool: 'file_outline',
                args: {
                    path: codebaseRoot,
                    file: normalizedFile,
                    start_line: safeStartLine,
                    end_line: safeEndLine,
                    resolveMode: 'outline',
                }
            };
        }

        return fallback;
    }

    private buildSearchNextActions(
        codebaseRoot: string,
        relativeFilePath: string,
        span: SearchSpan,
        callGraphHint: CallGraphHint,
        sidecarReadyForOutline: boolean
    ): SearchGroupResult['nextActions'] | undefined {
        if (!callGraphHint.supported) {
            return undefined;
        }

        const normalizedFile = this.sanitizeIndexedRelativeFilePath(callGraphHint.symbolRef.file || relativeFilePath);
        if (!normalizedFile) {
            return undefined;
        }

        const actionSpan = callGraphHint.symbolRef.span || span;
        const safeStartLine = Number.isFinite(actionSpan.startLine) ? Math.max(1, Number(actionSpan.startLine)) : 1;
        const safeEndLine = Number.isFinite(actionSpan.endLine) ? Math.max(safeStartLine, Number(actionSpan.endLine)) : safeStartLine;
        const absolutePath = path.resolve(codebaseRoot, normalizedFile);
        const symbolRef = {
            ...callGraphHint.symbolRef,
            file: normalizedFile,
            span: {
                startLine: safeStartLine,
                endLine: safeEndLine,
            }
        };

        const nextActions: NonNullable<SearchGroupResult['nextActions']> = {
            openSymbol: {
                tool: 'read_file',
                args: {
                    path: absolutePath,
                    open_symbol: {
                        symbolId: symbolRef.symbolId,
                        ...(symbolRef.symbolLabel ? { symbolLabel: symbolRef.symbolLabel } : {}),
                    }
                }
            },
            callGraph: {
                tool: 'call_graph',
                args: {
                    path: codebaseRoot,
                    symbolRef,
                    depth: 1,
                    limit: 20,
                },
                directions: ['callers', 'callees'],
            }
        };

        if (sidecarReadyForOutline && this.getOutlineStatusForLanguage(normalizedFile) === 'ok') {
            nextActions.outlineWindow = {
                tool: 'file_outline',
                args: {
                    path: codebaseRoot,
                    file: normalizedFile,
                    start_line: safeStartLine,
                    end_line: safeEndLine,
                    resolveMode: 'outline',
                }
            };
        }

        return nextActions;
    }

    private buildChangedCodeDebug(
        codebaseRoot: string,
        changedFilesState: { available: boolean; files: Set<string> }
    ): SearchDebugHint['changedCode'] | undefined {
        if (!changedFilesState.available || changedFilesState.files.size === 0) {
            return undefined;
        }

        const loadSidecar = (this.callGraphManager as any)?.loadSidecar;
        if (typeof loadSidecar !== 'function') {
            return undefined;
        }

        const sidecar = loadSidecar.call(this.callGraphManager, codebaseRoot);
        if (!sidecar || !Array.isArray(sidecar.nodes) || !Array.isArray(sidecar.edges)) {
            return undefined;
        }

        const changedFiles = Array.from(changedFilesState.files)
            .map((file) => this.normalizeRelativeFilePath(file))
            .filter((file) => file.length > 0 && !file.startsWith('..') && !path.posix.isAbsolute(file))
            .sort((a, b) => a.localeCompare(b));
        const changedFileSet = new Set(changedFiles);
        const nodeById = new Map<string, any>();
        for (const node of sidecar.nodes) {
            if (node && typeof node.symbolId === 'string') {
                nodeById.set(node.symbolId, node);
            }
        }

        const changedSymbols = sidecar.nodes
            .filter((node: any) => node && typeof node.file === 'string' && changedFileSet.has(this.normalizeRelativeFilePath(node.file)))
            .map((node: any) => ({
                file: this.normalizeRelativeFilePath(node.file),
                symbolId: String(node.symbolId),
                ...(typeof node.symbolLabel === 'string' ? { symbolLabel: node.symbolLabel } : {}),
                span: {
                    startLine: Number.isFinite(node.span?.startLine) ? Number(node.span.startLine) : 1,
                    endLine: Number.isFinite(node.span?.endLine) ? Number(node.span.endLine) : (Number.isFinite(node.span?.startLine) ? Number(node.span.startLine) : 1),
                }
            }))
            .sort((a: any, b: any) => {
                const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
                if (fileCmp !== 0) return fileCmp;
                const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
                if (startCmp !== 0) return startCmp;
                const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
                if (labelCmp !== 0) return labelCmp;
                return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
            });

        const changedSymbolIds = new Set(changedSymbols.map((symbol: any) => symbol.symbolId));
        const directCallers = sidecar.edges
            .filter((edge: any) => edge && changedSymbolIds.has(edge.dstSymbolId))
            .map((edge: any) => {
                const caller = nodeById.get(edge.srcSymbolId);
                if (!caller) {
                    return null;
                }
                const startLine = Number.isFinite(caller.span?.startLine) ? Number(caller.span.startLine) : 1;
                const endLine = Number.isFinite(caller.span?.endLine) ? Number(caller.span.endLine) : startLine;
                return {
                    targetSymbolId: String(edge.dstSymbolId),
                    file: this.normalizeRelativeFilePath(caller.file),
                    symbolId: String(caller.symbolId),
                    ...(typeof caller.symbolLabel === 'string' ? { symbolLabel: caller.symbolLabel } : {}),
                    span: {
                        startLine,
                        endLine,
                    },
                    site: {
                        file: this.normalizeRelativeFilePath(edge.site?.file || caller.file),
                        startLine: Number.isFinite(edge.site?.startLine) ? Number(edge.site.startLine) : startLine,
                        ...(Number.isFinite(edge.site?.endLine) ? { endLine: Number(edge.site.endLine) } : {}),
                    },
                    kind: edge.kind === 'import' || edge.kind === 'dynamic' ? edge.kind : 'call',
                    confidence: Number.isFinite(edge.confidence) ? Number(edge.confidence) : 0,
                };
            })
            .filter((caller: any): caller is NonNullable<typeof caller> => Boolean(caller))
            .sort((a: any, b: any) => {
                const targetCmp = this.compareNullableStringsAsc(a.targetSymbolId, b.targetSymbolId);
                if (targetCmp !== 0) return targetCmp;
                const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
                if (fileCmp !== 0) return fileCmp;
                const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
                if (startCmp !== 0) return startCmp;
                const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
                if (labelCmp !== 0) return labelCmp;
                const symbolCmp = this.compareNullableStringsAsc(a.symbolId, b.symbolId);
                if (symbolCmp !== 0) return symbolCmp;
                return this.compareNullableNumbersAsc(a.site?.startLine, b.site?.startLine);
            });

        return {
            files: changedFiles,
            symbols: changedSymbols.slice(0, 50),
            directCallers: directCallers.slice(0, 50),
        };
    }

    private buildGeneratedArtifactsVerificationHint(
        codebaseRoot: string,
        results: Array<{ file: string; span: SearchSpan }>
    ): NonNullable<NonNullable<SearchResponseEnvelope['hints']>['verification']>['generatedArtifacts'] | undefined {
        const byFile = new Map<string, SearchSpan>();

        for (const result of results) {
            const normalizedFile = this.sanitizeIndexedRelativeFilePath(result.file);
            if (!normalizedFile) {
                continue;
            }
            if (this.classifyNoiseCategory(normalizedFile) !== 'generated') {
                continue;
            }
            const safeStartLine = Number.isFinite(result.span.startLine) ? Math.max(1, Number(result.span.startLine)) : 1;
            const safeEndLine = Number.isFinite(result.span.endLine) ? Math.max(safeStartLine, Number(result.span.endLine)) : safeStartLine;
            const existing = byFile.get(normalizedFile);
            byFile.set(normalizedFile, existing
                ? {
                    startLine: Math.min(existing.startLine, safeStartLine),
                    endLine: Math.max(existing.endLine, safeEndLine),
                }
                : { startLine: safeStartLine, endLine: safeEndLine });
        }

        const files = Array.from(byFile.keys()).sort((a, b) => a.localeCompare(b)).slice(0, 5);
        if (files.length === 0) {
            return undefined;
        }

        return {
            reason: 'generated_outputs_present',
            message: 'Generated or build output appeared in search context. Source matches do not prove generated output is current; verify the artifact directly when behavior depends on it.',
            files,
            nextSteps: files.map((file) => {
                const span = byFile.get(file)!;
                return {
                    tool: 'read_file',
                    args: {
                        path: path.resolve(codebaseRoot, file),
                        start_line: span.startLine,
                        end_line: span.endLine,
                    }
                };
            }),
        };
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

    private sortFileOutlineSymbols(symbols: FileOutlineSymbolResult[]): FileOutlineSymbolResult[] {
        return [...symbols].sort((a, b) => {
            const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const endCmp = this.compareNullableNumbersAsc(a.span?.endLine, b.span?.endLine);
            if (endCmp !== 0) return endCmp;
            const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
        });
    }

    private sortRegistrySymbols(symbols: SymbolRecord[]): SymbolRecord[] {
        return [...symbols].sort((a, b) => {
            const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const endCmp = this.compareNullableNumbersAsc(a.span?.endLine, b.span?.endLine);
            if (endCmp !== 0) return endCmp;
            const labelCmp = this.compareNullableStringsAsc(a.label, b.label);
            if (labelCmp !== 0) return labelCmp;
            return this.compareNullableStringsAsc(a.symbolInstanceId, b.symbolInstanceId);
        });
    }

    private buildVisibleRegistrySymbolState(input: {
        symbols: SymbolRecord[];
        windowStart?: number;
        windowEnd?: number;
    }): {
        hasExtractedSymbols: boolean;
        visibleSymbols: SymbolRecord[];
    } {
        const hasExtractedSymbols = input.symbols.some((symbol) => symbol.kind !== 'file');
        const visibleSymbols = input.symbols.filter((symbol) => {
            if (hasExtractedSymbols && symbol.kind === 'file') {
                return false;
            }
            if (!input.windowStart && !input.windowEnd) {
                return true;
            }
            const startsBeforeWindowEnd = input.windowEnd === undefined || symbol.span.startLine <= input.windowEnd;
            const endsAfterWindowStart = input.windowStart === undefined || symbol.span.endLine >= input.windowStart;
            return startsBeforeWindowEnd && endsAfterWindowStart;
        });

        return {
            hasExtractedSymbols,
            visibleSymbols,
        };
    }

    private findExactRegistrySymbols(input: {
        symbols: SymbolRecord[];
        symbolIdExact?: string;
        symbolLabelExact?: string;
        windowStart?: number;
        windowEnd?: number;
    }): SymbolRecord[] {
        const visibleState = this.buildVisibleRegistrySymbolState(input);
        const exactMatches = visibleState.visibleSymbols.filter((symbol) => {
            if (input.symbolIdExact) {
                const matchesExactSymbolId = symbol.symbolInstanceId === input.symbolIdExact;
                if (!matchesExactSymbolId) {
                    return false;
                }
            }
            if (input.symbolLabelExact && symbol.label !== input.symbolLabelExact) {
                return false;
            }
            return true;
        });
        return this.sortRegistrySymbols(exactMatches);
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
        if (symbol.kind === 'file') {
            return { supported: false, reason: 'missing_symbol' };
        }

        if (!this.isCallGraphLanguageSupported(symbol.language, file)) {
            return { supported: false, reason: 'unsupported_language' };
        }

        if (navigationState.relationshipReady) {
            return this.buildRelationshipCallGraphHint({
                file,
                language: symbol.language,
                symbolId: symbol.symbolInstanceId,
                symbolLabel: symbol.label,
                span: {
                    startLine: symbol.span.startLine,
                    endLine: symbol.span.endLine,
                },
                sidecarBuiltAt: navigationState.relationshipBuiltAt,
            });
        }

        return {
            supported: false,
            reason: navigationState.relationshipUnavailableReason || 'missing_relationship_sidecar',
        };
    }

    private buildRegistryFileOutlinePayload(input: {
        codebaseRoot: string;
        file: string;
        symbols: SymbolRecord[];
        limitSymbols: number;
        resolveMode: 'outline' | 'exact';
        symbolIdExact?: string;
        symbolLabelExact?: string;
        windowStart?: number;
        windowEnd?: number;
        callGraphNavigationState: {
            relationshipReady: boolean;
            relationshipBuiltAt?: string;
        };
        warnings?: string[];
    }): FileOutlineResponseEnvelope {
        const visibleState = this.buildVisibleRegistrySymbolState({
            symbols: input.symbols,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
        });
        const visibleSymbols = visibleState.visibleSymbols;

        const mappedSymbols = this.sortFileOutlineSymbols(visibleSymbols.map((symbol) => ({
            symbolId: symbol.symbolInstanceId,
            symbolLabel: symbol.label,
            span: {
                startLine: symbol.span.startLine,
                endLine: symbol.span.endLine,
            },
            callGraphHint: this.buildRegistrySymbolCallGraphHint(symbol, input.file, input.callGraphNavigationState),
        } as FileOutlineSymbolResult)));

        const warningSet = new Set(input.warnings || []);
        if (mappedSymbols.some((symbol) => !symbol.callGraphHint.supported)) {
            const firstUnsupported = mappedSymbols.find((symbol) => !symbol.callGraphHint.supported)?.callGraphHint;
            if (firstUnsupported && !firstUnsupported.supported) {
                warningSet.add(`OUTLINE_CALL_GRAPH_UNAVAILABLE:${firstUnsupported.reason}`);
            }
        }
        if (!visibleState.hasExtractedSymbols && mappedSymbols.length > 0) {
            warningSet.add('OUTLINE_SYNTHESIZED_FILE_SYMBOL');
        }

        const warnings = [...warningSet].sort((a, b) => a.localeCompare(b));

        if (input.resolveMode === 'exact') {
            const exactMatchIds = new Set(this.findExactRegistrySymbols({
                symbols: input.symbols,
                symbolIdExact: input.symbolIdExact,
                symbolLabelExact: input.symbolLabelExact,
                windowStart: input.windowStart,
                windowEnd: input.windowEnd,
            }).map((symbol) => symbol.symbolInstanceId));
            const exactMatches = this.sortFileOutlineSymbols(
                mappedSymbols.filter((symbol) => exactMatchIds.has(symbol.symbolId))
            );

            if (exactMatches.length === 0) {
                return {
                    status: 'not_found',
                    reason: 'missing_symbol',
                    path: input.codebaseRoot,
                    file: input.file,
                    outline: null,
                    hasMore: false,
                    message: 'No exact symbol match found in file outline.',
                    ...(warnings.length > 0 ? { warnings } : {})
                };
            }

            const hasMoreExact = exactMatches.length > input.limitSymbols;
            return {
                status: exactMatches.length > 1 ? 'ambiguous' : 'ok',
                path: input.codebaseRoot,
                file: input.file,
                outline: {
                    symbols: exactMatches.slice(0, input.limitSymbols)
                },
                hasMore: hasMoreExact,
                ...(exactMatches.length > 1 ? {
                    message: `Multiple exact symbol matches found (${exactMatches.length}). Narrow with symbolIdExact for deterministic selection.`
                } : {}),
                ...(warnings.length > 0 ? { warnings } : {})
            };
        }

        const hasMore = mappedSymbols.length > input.limitSymbols;
        return {
            status: 'ok',
            path: input.codebaseRoot,
            file: input.file,
            outline: {
                symbols: mappedSymbols.slice(0, input.limitSymbols)
            },
            hasMore,
            ...(warnings.length > 0 ? { warnings } : {})
        };
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
        if (input.registrySymbol) {
            return this.buildRegistrySymbolCallGraphHint(
                input.registrySymbol,
                input.registrySymbol.file,
                input.navigationState
            );
        }

        if (!input.ownerSymbolInstanceId) {
            return { supported: false, reason: 'missing_symbol' };
        }

        if (input.registryUnavailableReason) {
            return { supported: false, reason: input.registryUnavailableReason };
        }

        if (input.registryLoaded) {
            return { supported: false, reason: 'stale_symbol_ref' };
        }

        if (input.navigationState.relationshipReady) {
            return this.buildRelationshipCallGraphHint({
                file: input.file,
                language: input.language,
                symbolId: input.ownerSymbolInstanceId,
                symbolLabel: input.symbolLabel,
                span: input.span,
                sidecarBuiltAt: input.navigationState.relationshipBuiltAt,
            });
        }

        return {
            supported: false,
            reason: input.navigationState.relationshipUnavailableReason || 'missing_relationship_sidecar',
        };
    }

    private buildSearchPassWarning(passId: string): string {
        return `SEARCH_PASS_FAILED:${passId} - ${passId} semantic search pass failed; results may be degraded.`;
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

    private sortRelationshipBackedCallGraphNodes(nodes: CallGraphNode[]): CallGraphNode[] {
        return [...nodes].sort((a, b) => {
            const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
        });
    }

    private sortRelationshipBackedCallGraphEdges(edges: CallGraphEdge[]): CallGraphEdge[] {
        return [...edges].sort((a, b) => {
            const srcCmp = this.compareNullableStringsAsc(a.srcSymbolId, b.srcSymbolId);
            if (srcCmp !== 0) return srcCmp;
            const dstCmp = this.compareNullableStringsAsc(a.dstSymbolId, b.dstSymbolId);
            if (dstCmp !== 0) return dstCmp;
            const kindCmp = this.compareNullableStringsAsc(a.kind, b.kind);
            if (kindCmp !== 0) return kindCmp;
            return this.compareNullableNumbersAsc(a.site?.startLine, b.site?.startLine);
        });
    }

    private mapRelationshipConfidenceToCallGraphConfidence(confidence: 'high' | 'medium' | 'low'): number {
        switch (confidence) {
            case 'high':
                return 0.95;
            case 'medium':
                return 0.65;
            case 'low':
            default:
                return 0.35;
        }
    }

    private createCallGraphNodeFromRegistrySymbol(symbol: SymbolRecord): CallGraphNode {
        return {
            symbolId: symbol.symbolInstanceId,
            symbolLabel: symbol.label,
            file: symbol.file,
            language: symbol.language,
            span: {
                startLine: symbol.span.startLine,
                endLine: symbol.span.endLine,
            },
        };
    }

    private async buildRelationshipBackedCallGraph(input: {
        codebaseRoot: string;
        registry: SymbolRegistry;
        registryManifestHash: string;
        resolvedSymbol: SymbolRecord;
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
        const neighbors = await getGraphNeighbors({
            normalizedRootPath: input.codebaseRoot,
            expectedSymbolRegistryManifestHash: input.registryManifestHash,
            navigationStore: this.navigationStore,
            symbolInstanceId: input.resolvedSymbol.symbolInstanceId,
            depth: input.depth,
            direction: input.direction,
            allowedTypes: ['CALLS'],
            limit: input.limit,
        });
        if (neighbors.status !== 'ok') {
            return null;
        }

        const nodes = this.sortRelationshipBackedCallGraphNodes(
            neighbors.visitedSymbolInstanceIds
                .map((symbolInstanceId) => input.registry.symbolsByInstanceId.get(symbolInstanceId))
                .filter((symbol): symbol is SymbolRecord => Boolean(symbol))
                .map((symbol) => this.createCallGraphNodeFromRegistrySymbol(symbol))
        );
        const edges = this.sortRelationshipBackedCallGraphEdges(
            neighbors.records.flatMap((record) => {
                if (!record.sourceInstanceId || !record.targetInstanceId) {
                    return [];
                }
                const source = input.registry.symbolsByInstanceId.get(record.sourceInstanceId);
                const target = input.registry.symbolsByInstanceId.get(record.targetInstanceId);
                if (!source || !target) {
                    return [];
                }
                return [{
                    srcSymbolId: source.symbolInstanceId,
                    dstSymbolId: target.symbolInstanceId,
                    kind: 'call' as const,
                    site: {
                        file: record.file,
                        startLine: record.span?.startLine || source.span.startLine,
                        ...(record.span?.endLine ? { endLine: record.span.endLine } : {}),
                    },
                    confidence: this.mapRelationshipConfidenceToCallGraphConfidence(record.confidence),
                }];
            })
        );
        const warnings = [...new Set([...input.registry.warnings, ...neighbors.warnings])].sort((a, b) => a.localeCompare(b));

        return {
            supported: true,
            direction: input.direction,
            depth: Math.max(1, Math.min(3, input.depth)),
            limit: Math.max(1, input.limit),
            nodes,
            edges,
            notes: [],
            ...(warnings.length > 0 ? { warnings } : {}),
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
            sidecar: {
                builtAt: neighbors.manifest.builtAt,
                nodeCount: nodes.length,
                edgeCount: edges.length,
            },
        };
    }

    private getContextIgnorePatterns(codebasePath: string): string[] {
        if (typeof (this.context as any).getActiveIgnorePatterns === 'function') {
            const patterns = (this.context as any).getActiveIgnorePatterns(codebasePath);
            if (Array.isArray(patterns)) {
                return patterns.filter((pattern) => typeof pattern === 'string');
            }
        }
        return [];
    }

    private async rebuildCallGraphForIndex(codebasePath: string): Promise<void> {
        try {
            const sidecar = await this.callGraphManager.rebuildForCodebase(codebasePath, this.getContextIgnorePatterns(codebasePath));
            this.snapshotManager.setCodebaseCallGraphSidecar(codebasePath, sidecar);
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' (${sidecar.nodeCount} nodes, ${sidecar.edgeCount} edges).`);
        } catch (error) {
            console.warn(`[CALL-GRAPH] Failed to rebuild sidecar after indexing '${codebasePath}': ${formatUnknownError(error)}`);
        }
    }

    private async rebuildCallGraphForSyncDelta(codebasePath: string, changedFiles: string[]): Promise<boolean> {
        try {
            const sidecar = await this.callGraphManager.rebuildIfSupportedDelta(
                codebasePath,
                changedFiles,
                this.getContextIgnorePatterns(codebasePath)
            );
            if (!sidecar) {
                return false;
            }
            this.snapshotManager.setCodebaseCallGraphSidecar(codebasePath, sidecar);
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' from sync delta (${sidecar.nodeCount} nodes, ${sidecar.edgeCount} edges).`);
            return true;
        } catch (error) {
            console.warn(`[CALL-GRAPH] Failed to rebuild sidecar after sync '${codebasePath}': ${formatUnknownError(error)}`);
            return false;
        }
    }

    private getVectorStore(): any {
        return this.context.getVectorStore() as any;
    }

    private isSatoriCodeCollection(collectionName: string): boolean {
        return SATORI_COLLECTION_PREFIXES.some((prefix) => collectionName.startsWith(prefix));
    }

    private getVectorBackendInfo(): VectorStoreBackendInfoView | null {
        const vectorDb = this.getVectorStore();
        if (typeof vectorDb.getBackendInfo !== 'function') {
            return null;
        }

        try {
            const info = vectorDb.getBackendInfo();
            if (!info || typeof info !== 'object') {
                return null;
            }

            if (info.provider !== 'milvus' && info.provider !== 'zilliz') {
                return null;
            }

            if (info.transport !== 'grpc' && info.transport !== 'rest') {
                return null;
            }

            return {
                provider: info.provider,
                transport: info.transport,
                address: typeof info.address === 'string' ? info.address : undefined,
            };
        } catch {
            return null;
        }
    }

    private isZillizBackend(): boolean {
        const backendInfo = this.getVectorBackendInfo();
        return backendInfo?.provider === 'zilliz';
    }

    private async listCollectionDetailsWithFallback(vectorDb: any): Promise<CollectionDetailsView[]> {
        if (typeof vectorDb.listCollectionDetails === 'function') {
            const details = await vectorDb.listCollectionDetails();
            if (Array.isArray(details)) {
                return details
                    .filter((detail): detail is CollectionDetailsView => Boolean(detail && typeof detail.name === 'string' && detail.name.length > 0))
                    .map((detail) => ({
                        name: detail.name,
                        createdAt: detail.createdAt,
                    }));
            }
        }

        const names = await vectorDb.listCollections();
        if (!Array.isArray(names)) {
            return [];
        }

        return names
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
            .map((name) => ({ name }));
    }

    private parseCodebaseFromMetadata(metadataValue: unknown): string | undefined {
        if (typeof metadataValue !== 'string' || metadataValue.trim().length === 0) {
            return undefined;
        }

        try {
            const metadata = JSON.parse(metadataValue);
            const codebasePath = metadata?.codebasePath;
            return typeof codebasePath === 'string' && codebasePath.trim().length > 0
                ? codebasePath
                : undefined;
        } catch {
            return undefined;
        }
    }

    private async resolveCollectionCodebasePath(
        vectorDb: any,
        collectionName: string,
        byCollectionName: Map<string, string>
    ): Promise<string | undefined> {
        const knownPath = byCollectionName.get(collectionName);
        if (knownPath) {
            return knownPath;
        }

        try {
            const results = await vectorDb.query(collectionName, '', ['metadata'], 1);
            if (!Array.isArray(results) || results.length === 0) {
                return undefined;
            }

            return this.parseCodebaseFromMetadata(results[0]?.metadata);
        } catch {
            return undefined;
        }
    }

    private formatCollectionTimestamp(createdAt?: string): string {
        if (!createdAt) {
            return '[unknown]';
        }

        const timestamp = Date.parse(createdAt);
        if (!Number.isFinite(timestamp)) {
            return createdAt;
        }

        return new Date(timestamp).toISOString();
    }

    private parseTimestampMs(timestamp?: string): number | undefined {
        if (!timestamp) {
            return undefined;
        }

        const parsed = Date.parse(timestamp);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private resolveCollectionSortTimestampMs(
        createdAt: string | undefined,
        codebasePath: string | undefined,
        snapshotLastUpdatedByPath: Map<string, number>
    ): number | undefined {
        const createdAtMs = this.parseTimestampMs(createdAt);
        const snapshotMs = codebasePath ? snapshotLastUpdatedByPath.get(codebasePath) : undefined;

        // Prefer collection metadata when it looks reliable.
        if (createdAtMs !== undefined && createdAtMs >= MIN_RELIABLE_COLLECTION_CREATED_AT_MS) {
            return createdAtMs;
        }

        // Fallback to snapshot timestamps when collection metadata is missing or suspicious.
        if (snapshotMs !== undefined) {
            return snapshotMs;
        }

        // Last resort for deterministic ordering when nothing else is available.
        return createdAtMs;
    }

    private async buildZillizCollectionLimitGuidance(targetCodebasePath: string): Promise<string> {
        const targetCollectionName = this.context.resolveCollectionName(targetCodebasePath);
        const vectorDb = this.getVectorStore();
        const collectionDetails = await this.listCollectionDetailsWithFallback(vectorDb);
        const codeCollections = collectionDetails.filter((detail) => this.isSatoriCodeCollection(detail.name));

        const trackedCodebases = this.snapshotManager.getAllCodebases().map((entry) => entry.path);
        const byCollectionName = new Map<string, string>();
        for (const codebasePath of trackedCodebases) {
            byCollectionName.set(this.context.resolveCollectionName(codebasePath), codebasePath);
        }
        const snapshotLastUpdatedByPath = new Map<string, number>();
        for (const entry of this.snapshotManager.getAllCodebases()) {
            const lastUpdatedMs = this.parseTimestampMs(entry.info.lastUpdated);
            if (lastUpdatedMs !== undefined) {
                snapshotLastUpdatedByPath.set(entry.path, lastUpdatedMs);
            }
        }

        const candidates: CandidateCollection[] = [];
        for (const detail of codeCollections) {
            const codebasePath = await this.resolveCollectionCodebasePath(vectorDb, detail.name, byCollectionName);
            candidates.push({
                name: detail.name,
                createdAt: detail.createdAt,
                codebasePath,
                isTargetCollection: detail.name === targetCollectionName,
                sortTimestampMs: this.resolveCollectionSortTimestampMs(
                    detail.createdAt,
                    codebasePath,
                    snapshotLastUpdatedByPath
                ),
            });
        }

        candidates.sort((a, b) => {
            const aValid = Number.isFinite(a.sortTimestampMs);
            const bValid = Number.isFinite(b.sortTimestampMs);
            if (aValid && bValid) {
                return (a.sortTimestampMs as number) - (b.sortTimestampMs as number);
            }
            if (aValid) return -1;
            if (bValid) return 1;
            return a.name.localeCompare(b.name);
        });

        const oldestName = candidates.length > 0 ? candidates[0].name : undefined;
        const newestName = candidates.length > 1 ? candidates[candidates.length - 1].name : oldestName;
        const lines = candidates.map((candidate, index) => {
            const codebaseInfo = candidate.codebasePath ? candidate.codebasePath : '[unknown]';
            const labels: string[] = [];
            if (candidate.name === oldestName) labels.push('oldest');
            if (candidate.name === newestName) labels.push('newest');
            if (candidate.isTargetCollection) labels.push('target');
            const labelText = labels.length > 0 ? ` [${labels.join(', ')}]` : '';
            return `${index + 1}. ${candidate.name}${labelText} | codebase: ${codebaseInfo} | created: ${this.formatCollectionTimestamp(candidate.createdAt)}`;
        });

        const suggestions = lines.length > 0
            ? lines.join('\n')
            : 'No Satori-managed collections were discovered.';

        return `${COLLECTION_LIMIT_MESSAGE}

Reason: Zilliz free-tier clusters are capped at ${ZILLIZ_FREE_TIER_COLLECTION_LIMIT} collections, and this cluster has no remaining collection slots.
Target codebase: '${targetCodebasePath}'
Target collection: '${targetCollectionName}'

Current Satori-managed collections (oldest -> newest):
${suggestions}

To continue, choose one collection from the list and retry:
manage_index {"action":"create","path":"${targetCodebasePath}","zillizDropCollection":"<collection_name>"}

Agent instructions:
1. Show this list to the user and ask which collection to delete.
2. Do not auto-delete without explicit user confirmation.
3. Retry create with zillizDropCollection set to the exact chosen collection name.`;
    }

    private async buildCollectionLimitMessage(targetCodebasePath: string): Promise<string> {
        if (!this.isZillizBackend()) {
            return COLLECTION_LIMIT_MESSAGE;
        }

        try {
            return await this.buildZillizCollectionLimitGuidance(targetCodebasePath);
        } catch (error) {
            console.warn(`[INDEX-VALIDATION] Failed to build Zilliz collection guidance: ${formatUnknownError(error)}`);
            return COLLECTION_LIMIT_MESSAGE;
        }
    }

    private async clearAllCollectionsForForceReindex(codebasePath: string): Promise<string[]> {
        const vectorDb = this.getVectorStore();
        const resolvedCollectionName = this.context.resolveCollectionName(codebasePath);
        const hash = resolvedCollectionName.split('_').pop();

        const candidateNames = new Set<string>();
        if (hash) {
            candidateNames.add(`code_chunks_${hash}`);
            candidateNames.add(`hybrid_code_chunks_${hash}`);
        }
        candidateNames.add(resolvedCollectionName);

        try {
            const cloudCollections = await this.listCollectionDetailsWithFallback(vectorDb);
            for (const collection of cloudCollections) {
                if (!this.isSatoriCodeCollection(collection.name)) {
                    continue;
                }
                if (hash && collection.name.endsWith(`_${hash}`)) {
                    candidateNames.add(collection.name);
                }
            }
        } catch (error) {
            console.warn(`[FORCE-REINDEX] Failed to list cloud collections while preparing cleanup: ${formatUnknownError(error)}`);
        }

        const droppedCollections: string[] = [];
        const dropErrors: string[] = [];
        for (const candidateName of candidateNames) {
            try {
                const result = await deleteCollectionWithVerification(vectorDb, candidateName);
                if (result.attempts > 0) {
                    droppedCollections.push(candidateName);
                }
            } catch (error) {
                const message = formatUnknownError(error);
                dropErrors.push(`${candidateName}: ${message}`);
                console.warn(`[FORCE-REINDEX] Failed to drop collection '${candidateName}': ${message}`);
            }
        }

        if (dropErrors.length > 0) {
            throw new Error(`Force reindex cleanup failed before local state changes: ${dropErrors.join('; ')}`);
        }

        // Ensure local Merkle/snapshot state is cleared for this codebase.
        try {
            await this.context.clearIndex(codebasePath);
        } catch (error) {
            console.warn(`[FORCE-REINDEX] Failed to clear local sync snapshot for '${codebasePath}': ${formatUnknownError(error)}`);
        }

        return droppedCollections;
    }

    private async dropZillizCollectionForCreate(collectionName: string): Promise<{ droppedCodebasePath?: string }> {
        const trimmedName = collectionName.trim();
        if (trimmedName.length === 0) {
            throw new Error('zillizDropCollection must be a non-empty string.');
        }

        if (!this.isSatoriCodeCollection(trimmedName)) {
            throw new Error(`zillizDropCollection '${trimmedName}' is not a Satori-managed collection (expected prefix ${SATORI_COLLECTION_PREFIXES.join(' or ')}).`);
        }

        const vectorDb = this.getVectorStore();
        if (!await vectorDb.hasCollection(trimmedName)) {
            throw new Error(`Collection '${trimmedName}' does not exist in the connected Zilliz cluster.`);
        }

        const droppedCodebasePath = await this.resolveCollectionCodebasePath(vectorDb, trimmedName, new Map());
        await deleteCollectionWithVerification(vectorDb, trimmedName);

        if (droppedCodebasePath) {
            this.snapshotManager.removeCodebaseCompletely(droppedCodebasePath);
            if (typeof (this.snapshotManager as any).markCodebaseCleared === 'function') {
                this.snapshotManager.markCodebaseCleared(droppedCodebasePath, trimmedName);
            }
            this.snapshotManager.saveCodebaseSnapshot();
            try {
                await this.unwatchCodebase(droppedCodebasePath);
            } catch {
                // Best-effort watcher cleanup; dropping cloud collection remains successful.
            }
        }

        return { droppedCodebasePath };
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, customExtensions, ignorePatterns, zillizDropCollection } = args;
        const forceReindex = force || false;
        const manageAction: ManageIndexAction = forceReindex ? 'reindex' : 'create';
        const internalPreflight: ReindexPreflightResult | undefined = forceReindex
            ? (args?.__reindexPreflight as ReindexPreflightResult | undefined)
            : undefined;
        const preflightOptions = internalPreflight
            ? {
                warnings: internalPreflight.warnings,
                preflight: internalPreflight
            }
            : {};
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];
        const requestedDropCollection = typeof zillizDropCollection === 'string' ? zillizDropCollection.trim() : undefined;
        let dropSummaryLine = '';

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return this.manageResponse(
                    manageAction,
                    absolutePath,
                    "error",
                    `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`,
                    preflightOptions
                );
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.manageResponse(
                    manageAction,
                    absolutePath,
                    "error",
                    `Error: Path '${absolutePath}' is not a directory`,
                    preflightOptions
                );
            }

            const runtimeOwnerConflict = await this.buildRuntimeOwnerConflictResponseIfBlocked(manageAction, absolutePath);
            if (runtimeOwnerConflict) {
                return runtimeOwnerConflict;
            }

            await this.recoverStaleIndexingStateIfNeeded(absolutePath);

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                const blockedAction: 'create' | 'reindex' = forceReindex ? 'reindex' : 'create';
                return this.manageResponse(
                    manageAction,
                    absolutePath,
                    "not_ready",
                    this.buildManageActionBlockedMessage(absolutePath, blockedAction),
                    {
                        ...preflightOptions,
                        reason: "indexing",
                        hints: {
                            status: this.buildStatusHint(absolutePath),
                            retryAfterMs: this.getManageRetryAfterMs(),
                            indexing: this.buildIndexingMetadata(absolutePath),
                        }
                    }
                );
            }

            const existingInfo = this.snapshotManager.getCodebaseInfo(absolutePath);
            if (!forceReindex && existingInfo?.status === 'requires_reindex') {
                return this.manageResponse(
                    manageAction,
                    absolutePath,
                    "requires_reindex",
                    this.buildReindexInstruction(absolutePath, existingInfo.message),
                    {
                        ...preflightOptions,
                        reason: "requires_reindex",
                        hints: {
                            reindex: this.buildReindexHint(absolutePath),
                            status: this.buildStatusHint(absolutePath),
                        }
                    }
                );
            }

            // Check if already indexed (unless force is true)
            const isIndexedInSnapshot = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            if (!forceReindex && isIndexedInSnapshot) {
                const proof = await this.validateCompletionProof(absolutePath);
                if (proof.outcome === 'valid') {
                    return this.manageResponse(
                        manageAction,
                        absolutePath,
                        "blocked",
                        `Codebase '${absolutePath}' is already indexed.

To update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.
To force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`
                    );
                }
                console.warn(`[INDEX-VALIDATION] Snapshot reports indexed for '${absolutePath}', but completion proof is '${proof.reason || proof.outcome}'. Treating as not_indexed and continuing create flow.`);
            }

            // If force reindex, always clear every previous collection for this codebase hash.
            if (forceReindex) {
                console.log(`[FORCE-REINDEX] 🔄 Preparing force cleanup for '${absolutePath}'`);
                const droppedCollections = await this.clearAllCollectionsForForceReindex(absolutePath);
                this.snapshotManager.removeCodebaseCompletely(absolutePath);
                this.snapshotManager.saveCodebaseSnapshot();
                try {
                    await this.unwatchCodebase(absolutePath);
                } catch {
                    // Best-effort watcher cleanup after successful force cleanup.
                }

                if (droppedCollections.length > 0) {
                    const sortedDroppedCollections = [...droppedCollections].sort();
                    dropSummaryLine += `\nForce reindex cleanup dropped ${sortedDroppedCollections.length} prior collection(s) for this codebase hash: ${sortedDroppedCollections.join(', ')}.`;
                } else {
                    dropSummaryLine += `\nForce reindex cleanup found no prior collections for this codebase hash.`;
                }
            }

            if (requestedDropCollection) {
                if (!this.isZillizBackend()) {
                    return this.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        "Error: zillizDropCollection is only supported when connected to a Zilliz Cloud backend.",
                        preflightOptions
                    );
                }

                const targetCollectionName = this.context.resolveCollectionName(absolutePath);
                if (requestedDropCollection === targetCollectionName) {
                    return this.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Error: zillizDropCollection cannot target '${targetCollectionName}' for this same codebase create flow. Use {"action":"create","path":"${absolutePath}","force":true} for reindexing this codebase.`,
                        preflightOptions
                    );
                }

                let dropResult: { droppedCodebasePath?: string };
                try {
                    dropResult = await this.dropZillizCollectionForCreate(requestedDropCollection);
                } catch (error) {
                    if (error instanceof RemoteCollectionDeletePendingError) {
                        return this.manageResponse(
                            manageAction,
                            absolutePath,
                            "error",
                            `Zilliz collection '${requestedDropCollection}' remote deletion is still pending. Local index state was not changed. Retry after the backend has converged. Details: ${formatUnknownError(error)}`,
                            {
                                ...preflightOptions,
                                reason: "remote_delete_pending",
                                hints: {
                                    retry: {
                                        tool: "manage_index",
                                        args: { action: manageAction, path: absolutePath, zillizDropCollection: requestedDropCollection }
                                    }
                                }
                            }
                        );
                    }
                    throw error;
                }
                dropSummaryLine += dropResult.droppedCodebasePath
                    ? `\nDropped Zilliz collection '${requestedDropCollection}' (mapped codebase: '${dropResult.droppedCodebasePath}').`
                    : `\nDropped Zilliz collection '${requestedDropCollection}'.`;
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorStore().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);
                    const guidanceMessage = await this.buildCollectionLimitMessage(absolutePath);
                    return this.manageResponse(manageAction, absolutePath, "error", guidanceMessage, preflightOptions);
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                if (isCollectionLimitError(validationError)) {
                    const guidanceMessage = await this.buildCollectionLimitMessage(absolutePath);
                    return this.manageResponse(manageAction, absolutePath, "error", guidanceMessage, preflightOptions);
                }

                if (validationError instanceof RemoteCollectionDeletePendingError) {
                    return this.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Zilliz/Milvus validation collection deletion is still pending. Local index state was not changed. Retry after the backend has converged. Details: ${formatUnknownError(validationError)}`,
                        {
                            ...preflightOptions,
                            reason: "remote_delete_pending",
                            hints: {
                                retry: {
                                    tool: "manage_index",
                                    args: { action: manageAction, path: absolutePath }
                                }
                            }
                        }
                    );
                }

                const vectorBackendDiagnostic = classifyVectorBackendError(validationError);
                if (vectorBackendDiagnostic) {
                    return this.manageVectorBackendResponse(manageAction, absolutePath, vectorBackendDiagnostic);
                }

                const validationMessage = formatUnknownError(validationError);
                const backendTimeout = isBackendTimeoutError(validationError);
                const timeoutOptions = backendTimeout
                    ? {
                        ...preflightOptions,
                        reason: "backend_timeout" as const,
                        hints: {
                            retry: {
                                tool: "manage_index",
                                args: { action: manageAction, path: absolutePath }
                            }
                        }
                    }
                    : preflightOptions;
                const validationText = backendTimeout
                    ? `Backend timeout while validating Zilliz/Milvus collection creation for '${absolutePath}'. The repo path is valid and local index state was not changed. This is retryable/operator-actionable: check backend availability or network latency, then retry manage_index action='${manageAction}'. Details: ${validationMessage}`
                    : `Error validating collection creation: ${validationMessage}`;
                return this.manageResponse(
                    manageAction,
                    absolutePath,
                    "error",
                    validationText,
                    timeoutOptions
                );
            }

            // Add custom extensions if provided
            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`);
                this.context.addCustomExtensions(customFileExtensions);
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Invariant: completion marker must be absent during indexing.
            if (typeof (this.context as any).clearIndexCompletionMarker === 'function') {
                await (this.context as any).clearIndexCompletionMarker(absolutePath);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);
            await this.touchWatchedCodebase(absolutePath);

            // Start background indexing - now safe to proceed
            this.startBackgroundIndexing(absolutePath, forceReindex);

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return this.manageResponse(
                manageAction,
                absolutePath,
                "ok",
                `Started background indexing for codebase '${absolutePath}'.${pathInfo}${dropSummaryLine}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`,
                preflightOptions
            );

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                const errorMessage = formatUnknownError(error);
                const preservesLocalState = errorMessage.includes('Force reindex cleanup failed before local state changes');
                const humanText = preservesLocalState
                    ? `${vectorBackendDiagnostic.message} ${errorMessage}`
                    : vectorBackendDiagnostic.message;
                return this.manageVectorBackendResponse(manageAction, ensureAbsolutePath(codebasePath), vectorBackendDiagnostic, humanText);
            }
            const errorMessage = formatUnknownError(error);

            // Ensure we always return a proper MCP response, never throw
            return this.manageResponse(
                manageAction,
                ensureAbsolutePath(codebasePath),
                "error",
                `Error starting indexing: ${errorMessage}`,
                preflightOptions
            );
        }
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean) {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            const contextForThisTask = this.context;

            if (typeof (this.context as any).loadIndexProfileForCodebase === 'function') {
                const profileConfig = (this.context as any).loadIndexProfileForCodebase(absolutePath);
                console.log(`[BACKGROUND-INDEX] Using index profile '${profileConfig.profile}'${profileConfig.configPath ? ` from ${profileConfig.configPath}` : ' (default)'}`);
            }

            // Load supported root ignore files before synchronizer and index setup.
            await this.context.loadResolvedIgnorePatterns(absolutePath);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            const { FileSynchronizer } = await import("@zokizuan/satori-core");
            const ignorePatterns = this.context.getActiveIgnorePatterns(absolutePath) || [];
            const supportedExtensions = typeof (this.context as any).getIndexedExtensionsForCodebase === 'function'
                ? (this.context as any).getIndexedExtensionsForCodebase(absolutePath)
                : this.context.getIndexedExtensions();
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns, supportedExtensions);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.ensureCollectionPrepared(absolutePath);
            const collectionName = this.context.resolveCollectionName(absolutePath);
            this.context.registerSynchronizer(collectionName, synchronizer);

            console.log(`[BACKGROUND-INDEX] Starting indexing for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const encoderEngine = this.context.getEmbeddingEngine();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${encoderEngine.getProvider()} with dimension: ${encoderEngine.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            });
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            if (typeof (contextForThisTask as any).writeIndexCompletionMarker === 'function') {
                const runId = `run_${crypto.randomUUID()}`;
                const canonicalMarkerPath = this.canonicalizeCodebasePath(absolutePath);
                await (contextForThisTask as any).writeIndexCompletionMarker(absolutePath, {
                    kind: 'satori_index_completion_v1',
                    codebasePath: canonicalMarkerPath,
                    fingerprint: this.runtimeFingerprint,
                    indexedFiles: stats.indexedFiles,
                    totalChunks: stats.totalChunks,
                    completedAt: new Date().toISOString(),
                    runId,
                });
            }

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, this.runtimeFingerprint, 'verified');
            if (typeof this.context.getTrackedRelativePaths === 'function') {
                const trackedPaths = this.context.getTrackedRelativePaths(absolutePath);
                if (typeof this.snapshotManager.setCodebaseIndexManifest === 'function') {
                    this.snapshotManager.setCodebaseIndexManifest(absolutePath, trackedPaths);
                }
            }
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };
            await this.syncManager.recordCurrentIgnoreControlSignature(absolutePath);

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();
            await this.rebuildCallGraphForIndex(absolutePath);
            await this.touchWatchedCodebase(absolutePath);

            let message = `Background indexing completed for '${absolutePath}'.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            let errorMessage = formatUnknownError(error);
            if (isCollectionLimitError(error)) {
                errorMessage = await this.buildCollectionLimitMessage(absolutePath);
            }

            if (typeof (this.context as any).clearIndexCompletionMarker === 'function') {
                try {
                    await (this.context as any).clearIndexCompletionMarker(absolutePath);
                } catch (clearError) {
                    console.warn(`[BACKGROUND-INDEX] Failed to clear completion marker after indexing error for '${absolutePath}': ${formatUnknownError(clearError)}`);
                }
            }

            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleReindexCodebase(args: any) {
        const {
            path: codebasePath,
            customExtensions,
            ignorePatterns,
            zillizDropCollection,
            allowUnnecessaryReindex
        } = args;
        const absolutePath = ensureAbsolutePath(codebasePath);
        const runtimeOwnerConflict = await this.buildRuntimeOwnerConflictResponseIfBlocked("reindex", absolutePath);
        if (runtimeOwnerConflict) {
            return runtimeOwnerConflict;
        }
        const preflight = this.evaluateReindexPreflight(absolutePath);

        if (preflight.outcome === 'reindex_unnecessary_ignore_only' && allowUnnecessaryReindex !== true) {
            return this.manageResponse(
                "reindex",
                absolutePath,
                "blocked",
                `Reindex preflight blocked for '${absolutePath}': only ignore/index-policy control changes were detected. Use manage_index with {"action":"sync","path":"${absolutePath}"} for immediate convergence.`,
                {
                    reason: "unnecessary_reindex_ignore_only",
                    warnings: preflight.warnings,
                    preflight,
                    hints: {
                        sync: {
                            tool: "manage_index",
                            args: { action: "sync", path: absolutePath }
                        },
                        overrideReindex: {
                            tool: "manage_index",
                            args: { action: "reindex", path: absolutePath, allowUnnecessaryReindex: true }
                        }
                    }
                }
            );
        }

        const forwardedPreflight = preflight.outcome === 'unknown' || preflight.outcome === 'probe_failed'
            ? preflight
            : undefined;
        return this.handleIndexCodebase({
            path: codebasePath,
            force: true,
            customExtensions,
            ignorePatterns,
            zillizDropCollection,
            __reindexPreflight: forwardedPreflight,
        });
    }

    public async handleSearchCode(args: any) {
        const scope = (args?.scope || 'runtime') as SearchScope;
        const resultMode = (args?.resultMode || 'grouped') as SearchResultMode;
        const groupBy = (args?.groupBy || 'symbol') as SearchGroupBy;
        const rankingMode = (args?.rankingMode || 'auto_changed_first') as SearchRankingMode;
        const debug = args?.debug === true;
        const input: SearchRequestInput = {
            path: args?.path,
            query: args?.query,
            scope,
            resultMode,
            groupBy,
            rankingMode,
            limit: Number.isFinite(args?.limit) ? Math.max(1, Number(args.limit)) : 10,
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

        const searchDiagnostics = {
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
        let proofDebugHint: CompletionProbeDebugHint | undefined;

        try {
            const prepareReadStartedAtMs = this.searchPhaseNowMs();
            const absolutePath = ensureAbsolutePath(input.path);
            if (!fs.existsSync(absolutePath)) {
                const payload = this.buildInvalidSearchRequestPayload({
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                }, `Path '${absolutePath}' does not exist. search_codebase requires an existing directory root or subdirectory.`, 'not_indexed', 'not_indexed');
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                const payload = this.buildInvalidSearchRequestPayload({
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                }, `Path '${absolutePath}' is not a directory. search_codebase requires a directory root or subdirectory.`, 'not_indexed', 'not_indexed');
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            const trackedRootState = await this.prepareTrackedRootForRead(absolutePath);
            this.addSearchPhaseTiming(phaseTimings, 'prepareRead', prepareReadStartedAtMs);
            if (trackedRootState.state === 'requires_reindex') {
                const payload = this.buildRequiresReindexPayload(trackedRootState.codebasePath, trackedRootState.message, {
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                }) as unknown as SearchResponseEnvelope;
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    meta: { searchDiagnostics }
                };
            }

            if (trackedRootState.state === 'indexing') {
                const payload = this.buildNotReadySearchPayload(trackedRootState.codebasePath, {
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                });
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    meta: { searchDiagnostics }
                };
            }

            if (trackedRootState.state === 'not_indexed') {
                const envelope: SearchResponseEnvelope = {
                    status: "not_indexed",
                    reason: "not_indexed",
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    limit: input.limit,
                    resultMode: input.resultMode,
                    freshnessDecision: null,
                    message: `Codebase '${absolutePath}' (or any parent) is not indexed.`,
                    hints: {
                        create: {
                            tool: "manage_index",
                            args: { action: "create", path: absolutePath }
                        }
                    },
                    results: []
                };
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(envelope) }],
                    meta: { searchDiagnostics }
                };
            }

            if (trackedRootState.state === 'stale_local') {
                const envelope: SearchResponseEnvelope = {
                    status: "not_indexed",
                    reason: "not_indexed",
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    limit: input.limit,
                    resultMode: input.resultMode,
                    freshnessDecision: null,
                    message: this.buildStaleLocalMessage(trackedRootState.codebasePath, absolutePath, trackedRootState.reason),
                    hints: {
                        create: this.buildCreateHint(trackedRootState.codebasePath),
                        staleLocal: this.buildStaleLocalHint(trackedRootState.codebasePath, trackedRootState.reason)
                    },
                    results: []
                };
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(envelope) }],
                    meta: { searchDiagnostics }
                };
            }

            if (trackedRootState.state === 'missing_collection') {
                const payload = this.withProofDebugHint(this.buildMissingLocalCollectionSearchPayload(
                    trackedRootState.codebasePath,
                    {
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit
                    },
                    trackedRootState.collectionName
                ), trackedRootState.proofDebugHint);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    meta: { searchDiagnostics }
                };
            }

            const searchableRoot = trackedRootState.root;
            let effectiveRoot = searchableRoot.path || absolutePath;
            proofDebugHint = trackedRootState.proofDebugHint;
            const partialIndexSearchWarnings = this.isPartialIndexNavigationUnavailable(searchableRoot.info)
                ? [
                    SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING,
                    SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING,
                ]
                : [];

            if (searchableRoot.path !== absolutePath) {
                console.log(`[SEARCH] Auto-resolved subdirectory '${absolutePath}' to indexed root '${searchableRoot.path}'`);
            }

            const freshnessDecision = await this.measureSearchPhase(
                phaseTimings,
                'ensureFreshness',
                () => this.syncManager.ensureFreshness(effectiveRoot, 3 * 60 * 1000)
            );
            searchDiagnostics.freshnessMode = freshnessDecision.mode;
            const freshnessBlockedPayload = this.buildFreshnessBlockedSearchPayload(effectiveRoot, freshnessDecision, {
                path: absolutePath,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit
            });
            if (freshnessBlockedPayload) {
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(freshnessBlockedPayload) }],
                    meta: { searchDiagnostics }
                };
            }
            const encoderEngine = this.context.getEmbeddingEngine();
            const rootTag = `[SEARCH][root=${effectiveRoot}]`;
            console.log(`${rootTag} Searching (requestedPath='${absolutePath}')`);
            console.log(`${rootTag} Query: "${input.query}"`);
            console.log(`${rootTag} Indexing status: Completed`);
            console.log(`${rootTag} 🧠 Using embedding provider: ${encoderEngine.getProvider()} for search`);

            const parsedOperators = this.parseSearchOperators(input.query);
            const semanticQuery = parsedOperators.semanticQuery;
            const queryPlan = this.buildSearchQueryPlan(semanticQuery);
            const expandedQuery = `${semanticQuery}\nimplementation runtime source entrypoint`;
            const maxAttempts = parsedOperators.must.length > 0 ? 1 + SEARCH_MUST_RETRY_ROUNDS : 1;
            let candidateLimit = Math.max(1, Math.min(SEARCH_MAX_CANDIDATES, Math.max(input.limit * 8, 32)));
            let trackedLexicalDebug: TrackedLexicalSearchDebug | undefined;
            const operatorSummary = this.buildOperatorSummary(parsedOperators);
            let filterSummary: SearchFilterSummary = {
                removedByScope: 0,
                removedByLanguage: 0,
                removedByPathInclude: 0,
                removedByPathExclude: 0,
                removedByMust: 0,
                removedByExclude: 0,
            };
            const observedChangedFilesState = this.getChangedFilesForCodebase(effectiveRoot);
            const changedFilesState = input.rankingMode === 'auto_changed_first'
                ? observedChangedFilesState
                : { available: observedChangedFilesState.available, files: new Set<string>() };
            const debugChangedFilesState = input.debug ? observedChangedFilesState : undefined;
            const changedFilesCount = changedFilesState.files.size;
            const observedChangedFilesCount = observedChangedFilesState.files.size;
            const changedFilesBoostWithinThreshold = changedFilesCount > 0 && changedFilesCount <= SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES;
            const changedFilesBoostEnabled = input.rankingMode === 'auto_changed_first' && changedFilesState.available && changedFilesBoostWithinThreshold;
            const changedFilesBoostSkippedForLargeChangeSet = input.rankingMode === 'auto_changed_first'
                && changedFilesState.available
                && changedFilesCount > SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES;
            const freshnessSummary: SearchFreshnessSummary = {
                syncMode: freshnessDecision.mode,
                lastSyncAt: typeof freshnessDecision.lastSyncAt === 'string' ? freshnessDecision.lastSyncAt : null,
                changedFileCount: observedChangedFilesCount,
                gitDirtyFilesConsidered: observedChangedFilesState.available,
                changedFilesBoostApplied: false,
                changedFilesBoostSkippedForLargeChangeSet,
            };
            const dirtyFilesNotFreshened = observedChangedFilesState.available
                && observedChangedFilesCount > 0
                && freshnessDecision.mode !== 'synced'
                && freshnessDecision.mode !== 'reconciled_ignore_change';
            const canSupplementLivePathEvidence = observedChangedFilesState.available
                && observedChangedFilesCount > 0
                && parsedOperators.path.length > 0;
            let boostedCandidates = 0;
            let attemptsUsed = 0;
            const searchWarningsSet = new Set<string>();
            const passesUsed = new Set<string>();
            const backendScoreKinds = new Set<'dense_similarity' | 'lexical_rank' | 'rrf_fusion' | 'unknown'>();
            let scored: SearchCandidate[] = [];
            let exactMatchPinningApplied = false;
            const rankingProvenance = {
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
                const normalized = this.normalizeRelativePathForIgnoreCheck(pattern);
                return Boolean(normalized && this.isExactSearchPathFilter(normalized));
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
                        filterSymbol: this.buildExactRegistrySymbolFilter({
                            scope: input.scope,
                            parsedOperators,
                        }),
                    }));
                    exactRegistryDebug = exactRegistryMatch.debug;

                    if (exactRegistryMatch.status === 'hit') {
                        passesUsed.add('exact_registry');
                        const callGraphNavigationState = await this.measureSearchPhase(
                            phaseTimings,
                            'navigationValidation',
                            () => this.loadRegistryValidatedCallGraphSidecar({
                                codebaseRoot: effectiveRoot,
                                registryManifestHash: registryState.manifestHash,
                            })
                        );
                        const searchWarnings = [
                            ...partialIndexSearchWarnings,
                        ];
                        if (callGraphNavigationState.warning) {
                            searchWarnings.push(`SEARCH_${callGraphNavigationState.warning}`);
                        }
                        if (dirtyFilesNotFreshened) {
                            searchWarnings.push(WARNING_CODES.SEARCH_DIRTY_WORKTREE_NOT_SYNCED);
                        }
                        if (changedFilesBoostSkippedForLargeChangeSet) {
                            searchWarnings.push(WARNING_CODES.SEARCH_CHANGED_FILES_BOOST_SKIPPED);
                        }
                        const finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();
                        const exactGroupingStartedAtMs = this.searchPhaseNowMs();
                        const exactGroup = this.buildExactRegistryGroupResult({
                            codebaseRoot: effectiveRoot,
                            symbol: exactRegistryMatch.symbol,
                            indexedAt: registryState.registry.manifest.builtAt || null,
                            callGraphNavigationState,
                            sidecarReadyForOutline: true,
                            debug: Boolean(input.debug),
                        });
                        this.addSearchPhaseTiming(phaseTimings, 'grouping', exactGroupingStartedAtMs);
                        const visibleGroupedResults = [exactGroup];
                        const noiseMitigationHint = this.buildNoiseMitigationHint(effectiveRoot, visibleGroupedResults.map((result) => result.file), input.scope);
                        const generatedArtifactsHint = this.buildGeneratedArtifactsVerificationHint(effectiveRoot, visibleGroupedResults.map((result) => ({
                            file: result.file,
                            span: result.span,
                        })));
                        const responseHints: Record<string, unknown> = {
                            version: 1 as const,
                            navigation: { nextStep: SEARCH_NAVIGATION_NEXT_STEP },
                        };
                        if (noiseMitigationHint) {
                            responseHints.noiseMitigation = noiseMitigationHint;
                        }
                        if (generatedArtifactsHint) {
                            responseHints.verification = {
                                generatedArtifacts: generatedArtifactsHint,
                            };
                        }
                        if (input.debug) {
                            const rerankDecision = this.resolveRerankDecision(input.scope, queryPlan);
                            responseHints.debugSearch = {
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
                                    ...rankingProvenance,
                                    semanticPassesUsed: [],
                                    lexicalPassesUsed: [],
                                    livePathSupplementUsed: false,
                                    lexicalFileScanUsed: false,
                                    rerankApplied: false,
                                    exactMatchPinningApplied: false,
                                    registryRepairGroupCount: 0,
                                },
                                exactRegistry: exactRegistryDebug,
                                phaseTimingsMs: phaseTimings,
                                passesUsed: Array.from(passesUsed).sort(),
                                candidateLimit,
                                mustRetry: {
                                    attempts: 0,
                                    maxAttempts,
                                    applied: parsedOperators.must.length > 0,
                                    satisfied: true,
                                    finalCount: 1,
                                },
                                operatorSummary,
                                filterSummary,
                                changedFilesBoost: {
                                    enabled: input.rankingMode === 'auto_changed_first',
                                    applied: false,
                                    available: changedFilesState.available,
                                    changedCount: changedFilesCount,
                                    maxChangedFilesForBoost: SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
                                    skippedForLargeChangeSet: changedFilesBoostSkippedForLargeChangeSet,
                                    multiplier: SEARCH_CHANGED_FIRST_MULTIPLIER,
                                    boostedCandidates: 0,
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
                                    enabled: false,
                                    attempted: false,
                                    applied: false,
                                    exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
                                    exactMatchPinningApplied: false,
                                    candidatesIn: 1,
                                    candidatesReranked: 0,
                                    topK: SEARCH_RERANK_TOP_K,
                                    rankK: SEARCH_RERANK_RRF_K,
                                    weight: SEARCH_RERANK_WEIGHT,
                                    docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
                                    docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
                                },
                            } satisfies SearchDebugHint;
                        }
                        if (proofDebugHint) {
                            responseHints.debugProofCheck = proofDebugHint;
                        }

                        const envelope: SearchResponseEnvelope = {
                            status: "ok",
                            path: absolutePath,
                            query: input.query,
                            scope: input.scope,
                            groupBy: input.groupBy,
                            limit: input.limit,
                            resultMode: "grouped",
                            freshnessDecision,
                            freshnessSummary,
                            ...(finalizedSearchWarnings.length > 0 ? { warnings: finalizedSearchWarnings } : {}),
                            hints: responseHints,
                            results: visibleGroupedResults.map(({ __exactLexicalMatch: _exactLexicalMatch, ...result }) => result)
                        };

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
                    exactRegistryDebug = this.buildUnavailableExactRegistryDebug(registryState.reason);
                }
            }

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                attemptsUsed = attempt + 1;
                const passDescriptors: Array<{ id: 'primary' | 'expanded'; query: string }> = [
                    { id: 'primary', query: semanticQuery },
                ];
                if (!exactRegistryEligible) {
                    passDescriptors.push({ id: 'expanded', query: expandedQuery });
                }
                searchDiagnostics.searchPassCount += passDescriptors.length;

                const passSettled = await this.measureSearchPhase(phaseTimings, 'semanticSearch', () => Promise.allSettled(passDescriptors.map(async (pass) => {
                    const passId = pass.id as 'primary' | 'expanded';
                    if (this.shouldForceSearchPassFailure(passId)) {
                        throw new Error(`FORCED_TEST_SEARCH_PASS_FAILURE:${passId}`);
                    }
                    const scorePolicy = queryPlan.scorePolicyKind === 'topk_only'
                        ? { kind: 'topk_only' as const }
                        : { kind: 'dense_similarity_min' as const, min: 0.3 };
                    return this.context.semanticSearch({
                        codebasePath: effectiveRoot,
                        query: pass.query,
                        topK: candidateLimit,
                        retrievalMode: queryPlan.retrievalMode,
                        scorePolicy
                    });
                })));

                const successfulPasses: Array<{ id: string; results: any[] }> = [];
                let vectorBackendDiagnostic: VectorBackendDiagnostic | null = null;
                for (let idx = 0; idx < passSettled.length; idx++) {
                    const passResult = passSettled[idx];
                    const passDescriptor = passDescriptors[idx];
                    if (passResult.status === 'fulfilled' && Array.isArray(passResult.value)) {
                        successfulPasses.push({
                            id: passDescriptor.id,
                            results: passResult.value
                        });
                        passesUsed.add(passDescriptor.id);
                        continue;
                    }

                    if (passResult.status === 'rejected' && vectorBackendDiagnostic === null) {
                        vectorBackendDiagnostic = classifyVectorBackendError(passResult.reason);
                    }
                    searchWarningsSet.add(this.buildSearchPassWarning(passDescriptor.id));
                }

                searchDiagnostics.searchPassSuccessCount += successfulPasses.length;
                searchDiagnostics.searchPassFailureCount += passDescriptors.length - successfulPasses.length;

                if (successfulPasses.length === 0) {
                    if (vectorBackendDiagnostic) {
                        const payload = this.buildVectorBackendSearchPayload(vectorBackendDiagnostic, {
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
                                    error: vectorBackendDiagnostic.code
                                }
                            }
                        };
                    }
                    return {
                        content: [{
                            type: "text",
                            text: "Error searching code: all semantic search passes failed. Please retry and verify embedding/vector backends are reachable."
                        }],
                        isError: true,
                        meta: { searchDiagnostics }
                    };
                }

                const byChunkKey = new Map<string, SearchCandidate>();
                const attemptFilterSummary: SearchFilterSummary = {
                    removedByScope: 0,
                    removedByLanguage: 0,
                    removedByPathInclude: 0,
                    removedByPathExclude: 0,
                    removedByMust: 0,
                    removedByExclude: 0,
                };
                const addPass = (results: any[], passId: string, passWeight = 1) => {
                    for (let i = 0; i < results.length; i++) {
                        const result = results[i];
                        if (!result || typeof result.relativePath !== 'string') continue;
                        const key = `${result.relativePath}:${result.startLine}:${result.endLine}:${result.language || 'unknown'}`;
                        const rank = i + 1;
                        const rrf = passWeight * (1 / (SEARCH_RRF_K + rank));
                        const existing = byChunkKey.get(key);
                        if (!existing) {
                            const backendScoreKind = typeof result.backendScoreKind === 'string'
                                ? result.backendScoreKind as 'dense_similarity' | 'lexical_rank' | 'rrf_fusion'
                                : 'unknown';
                            backendScoreKinds.add(backendScoreKind);
                            byChunkKey.set(key, {
                                result,
                                baseScore: typeof result.backendScore === 'number'
                                    ? result.backendScore
                                    : (typeof result.score === 'number' ? result.score : 0),
                                backendScore: typeof result.backendScore === 'number'
                                    ? result.backendScore
                                    : (typeof result.score === 'number' ? result.score : 0),
                                backendScoreKind,
                                backendScoreKindsSeen: [backendScoreKind],
                                fusionScore: rrf,
                                lexicalScore: 0,
                                finalScore: 0,
                                pathCategory: 'neutral',
                                pathMultiplier: 1.0,
                                changedFilesMultiplier: 1.0,
                                agentFitMultiplier: SEARCH_AGENT_FIT_NEUTRAL,
                                agentFitReason: 'neutral',
                                passesMatchedMust: false,
                                exactLexicalMatch: false,
                                exactMatchPinned: false,
                                rerankAdjusted: false,
                                retrievalPasses: [passId],
                            });
                        } else {
                            existing.fusionScore += rrf;
                            const nextScore = typeof result.backendScore === 'number'
                                ? result.backendScore
                                : (typeof result.score === 'number' ? result.score : undefined);
                            if (typeof nextScore === 'number') {
                                existing.baseScore = Math.max(existing.baseScore, nextScore);
                                existing.backendScore = Math.max(existing.backendScore, nextScore);
                            }
                            if (typeof result.backendScoreKind === 'string') {
                                backendScoreKinds.add(result.backendScoreKind as 'dense_similarity' | 'lexical_rank' | 'rrf_fusion');
                                if (!existing.backendScoreKindsSeen.includes(result.backendScoreKind as 'dense_similarity' | 'lexical_rank' | 'rrf_fusion' | 'unknown')) {
                                    existing.backendScoreKindsSeen.push(result.backendScoreKind as 'dense_similarity' | 'lexical_rank' | 'rrf_fusion' | 'unknown');
                                }
                            }
                            if (!existing.retrievalPasses.includes(passId)) {
                                existing.retrievalPasses.push(passId);
                            }
                        }
                    }
                };

                for (const pass of successfulPasses) {
                    addPass(pass.results, pass.id, 1);
                }
                const trackedLexical = await this.measureSearchPhase(phaseTimings, 'trackedLexical', async () => this.buildTrackedLexicalSearchResults({
                    effectiveRoot,
                    parsedOperators,
                    queryPlan,
                    scope: input.scope,
                    limit: candidateLimit,
                    exactRegistryFallback: exactRegistryFallbackForTrackedLexical,
                }));
                trackedLexicalDebug = trackedLexical.debug;
                if (trackedLexical.results.length > 0) {
                    addPass(trackedLexical.results, 'lexical_files', 1);
                    passesUsed.add('lexical_files');
                }
                if (canSupplementLivePathEvidence) {
                    const livePathResults = this.buildLivePathScopedSearchResults({
                        effectiveRoot,
                        parsedOperators,
                        queryPlan,
                        changedFiles: observedChangedFilesState.files,
                    });
                    if (livePathResults.length > 0) {
                        addPass(livePathResults, 'live_path', 1);
                        passesUsed.add('live_path');
                    }
                }

                const beforeFilter = byChunkKey.size;
                const scoredAttempt: SearchCandidate[] = [];
                for (const candidate of byChunkKey.values()) {
                    const category = this.classifyPathCategory(candidate.result.relativePath);
                    if (!this.shouldIncludeCategoryInScope(input.scope, category)) {
                        attemptFilterSummary.removedByScope += 1;
                        continue;
                    }

                    const languageValue = typeof candidate.result.language === 'string'
                        ? candidate.result.language.toLowerCase()
                        : 'unknown';
                    if (parsedOperators.lang.length > 0 && !parsedOperators.lang.includes(languageValue)) {
                        attemptFilterSummary.removedByLanguage += 1;
                        continue;
                    }

                    const relativePath = String(candidate.result.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
                    if (parsedOperators.path.length > 0 && !this.pathMatchesAnyPattern(relativePath, parsedOperators.path)) {
                        attemptFilterSummary.removedByPathInclude += 1;
                        continue;
                    }

                    if (parsedOperators.excludePath.length > 0 && this.pathMatchesAnyPattern(relativePath, parsedOperators.excludePath)) {
                        attemptFilterSummary.removedByPathExclude += 1;
                        continue;
                    }

                    const symbolLabel = typeof candidate.result.symbolLabel === 'string' ? candidate.result.symbolLabel : '';
                    const content = typeof candidate.result.content === 'string' ? candidate.result.content : '';
                    const fields = [symbolLabel, relativePath, content];
                    const matchesMust = parsedOperators.must.every((token) => this.tokenMatchesAnyField(token, fields));
                    if (!matchesMust) {
                        attemptFilterSummary.removedByMust += 1;
                        continue;
                    }

                    const matchesExclude = parsedOperators.exclude.some((token) => this.tokenMatchesAnyField(token, fields));
                    if (matchesExclude) {
                        attemptFilterSummary.removedByExclude += 1;
                        continue;
                    }

                    const pathMultiplier = SCOPE_PATH_MULTIPLIERS[input.scope][category];
                    const agentFit = this.resolveAgentFitMultiplier(queryPlan, candidate.result, category, input.scope);
                    let changedFilesMultiplier = 1.0;
                    if (changedFilesBoostEnabled
                        && changedFilesState.files.has(relativePath)
                        && this.shouldApplyChangedFilesBoost(category, queryPlan)) {
                        changedFilesMultiplier = SEARCH_CHANGED_FIRST_MULTIPLIER;
                        boostedCandidates += 1;
                    }

                    candidate.pathCategory = category;
                    candidate.pathMultiplier = pathMultiplier;
                    candidate.changedFilesMultiplier = changedFilesMultiplier;
                    candidate.agentFitMultiplier = agentFit.multiplier;
                    candidate.agentFitReason = agentFit.reason;
                    candidate.passesMatchedMust = matchesMust;
                    const lexicalEvidence = this.scoreCandidateLexicalEvidence(queryPlan, candidate.result);
                    candidate.lexicalScore = lexicalEvidence.score;
                    candidate.exactLexicalMatch = lexicalEvidence.exactLexicalMatch;
                    candidate.finalScore = (candidate.fusionScore + candidate.lexicalScore)
                        * pathMultiplier
                        * changedFilesMultiplier
                        * agentFit.multiplier;
                    scoredAttempt.push(candidate);
                }

                searchDiagnostics.resultsBeforeFilter = beforeFilter;
                searchDiagnostics.resultsAfterFilter = scoredAttempt.length;
                filterSummary = attemptFilterSummary;
                scored = scoredAttempt;

                exactMatchPinningApplied = this.sortSearchCandidates(scored, queryPlan.exactMatchPinningEnabled, parsedOperators.must.length > 0) || exactMatchPinningApplied;
                rankingProvenance.exactMatchPinningApplied = exactMatchPinningApplied;

                if (parsedOperators.must.length === 0 || scored.length >= input.limit || attempt === maxAttempts - 1 || candidateLimit >= SEARCH_MAX_CANDIDATES) {
                    break;
                }

                candidateLimit = Math.min(
                    SEARCH_MAX_CANDIDATES,
                    Math.max(candidateLimit + 1, candidateLimit * SEARCH_MUST_RETRY_MULTIPLIER)
                );
            }

            const searchWarnings = [
                ...Array.from(searchWarningsSet),
                ...partialIndexSearchWarnings,
            ];
            if (dirtyFilesNotFreshened) {
                searchWarnings.push(WARNING_CODES.SEARCH_DIRTY_WORKTREE_NOT_SYNCED);
            }
            if (changedFilesBoostSkippedForLargeChangeSet) {
                searchWarnings.push(WARNING_CODES.SEARCH_CHANGED_FILES_BOOST_SKIPPED);
            }
            freshnessSummary.changedFilesBoostApplied = boostedCandidates > 0;
            const rerankDecision = this.resolveRerankDecision(input.scope, queryPlan);
            let rerankerApplied = false;
            let rerankerAttempted = false;
            let rerankerFailurePhase: 'api_call' | 'parse_results' | undefined;
            let rerankerCandidatesIn = scored.length;
            let rerankerCandidatesReranked = 0;

            if (rerankDecision.enabled && scored.length > 0 && this.reranker) {
                rerankerAttempted = true;
                try {
                    const rerankCount = Math.min(SEARCH_RERANK_TOP_K, scored.length);
                    rerankerCandidatesReranked = rerankCount;
                    const rerankSlice = scored.slice(0, rerankCount);
                    const rerankDocuments = rerankSlice.map((candidate) => this.buildRerankDocument(candidate.result));
                    let rerankResults: Array<{ index: number }> = [];
                    try {
                        rerankResults = await this.measureSearchPhase(phaseTimings, 'rerank', () => this.reranker!.rerank(semanticQuery, rerankDocuments, {
                            topK: rerankCount,
                            truncation: true,
                            returnDocuments: false
                        }));
                    } catch {
                        rerankerFailurePhase = 'api_call';
                        throw new Error('reranker_api_call_failed');
                    }

                    const rerankRanks = new Map<number, number>();
                    try {
                        for (let idx = 0; idx < rerankResults.length; idx++) {
                            const originalIndex = (rerankResults as any)[idx]?.index;
                            if (Number.isInteger(originalIndex) && originalIndex >= 0 && originalIndex < rerankCount && !rerankRanks.has(originalIndex)) {
                                rerankRanks.set(originalIndex, idx + 1);
                            }
                        }
                    } catch {
                        rerankerFailurePhase = 'parse_results';
                        throw new Error('reranker_parse_failed');
                    }

                    let rerankerUpdatedCandidates = 0;
                    for (let idx = 0; idx < rerankSlice.length; idx++) {
                        const rank = rerankRanks.get(idx);
                        if (!rank) {
                            continue;
                        }
                        const rerankRrf = 1 / (SEARCH_RERANK_RRF_K + rank);
                        rerankSlice[idx].fusionScore += SEARCH_RERANK_WEIGHT * rerankRrf;
                        rerankSlice[idx].finalScore = (rerankSlice[idx].fusionScore + rerankSlice[idx].lexicalScore)
                            * rerankSlice[idx].pathMultiplier
                            * rerankSlice[idx].changedFilesMultiplier
                            * rerankSlice[idx].agentFitMultiplier;
                        rerankSlice[idx].rerankAdjusted = true;
                        rerankerUpdatedCandidates++;
                    }

                    exactMatchPinningApplied = this.sortSearchCandidates(scored, rerankDecision.exactMatchPinningEnabled, parsedOperators.must.length > 0) || exactMatchPinningApplied;
                    rerankerApplied = rerankerUpdatedCandidates > 0;
                } catch {
                    if (!rerankerFailurePhase) {
                        rerankerFailurePhase = 'parse_results';
                    }
                    searchWarnings.push('RERANKER_FAILED');
                }
            }

            searchDiagnostics.excludedByIgnore = Math.max(0, searchDiagnostics.resultsBeforeFilter - searchDiagnostics.resultsAfterFilter);
            searchDiagnostics.rerankerAttempted = rerankerAttempted;
            searchDiagnostics.rerankerUsed = rerankerApplied;
            rankingProvenance.semanticPassesUsed = Array.from(passesUsed).filter((passId) => passId === 'primary' || passId === 'expanded').sort();
            rankingProvenance.lexicalPassesUsed = Array.from(passesUsed).filter((passId) => passId === 'lexical_files' || passId === 'live_path').sort();
            rankingProvenance.livePathSupplementUsed = passesUsed.has('live_path');
            rankingProvenance.lexicalFileScanUsed = passesUsed.has('lexical_files');
            rankingProvenance.rerankApplied = rerankerApplied;
            rankingProvenance.exactMatchPinningApplied = exactMatchPinningApplied;
            const mustApplied = parsedOperators.must.length > 0;
            const mustSatisfied = !mustApplied || scored.length > 0;
            if (mustApplied && !mustSatisfied) {
                searchWarnings.push('FILTER_MUST_UNSATISFIED');
            }
            let finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();

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
                const rawResults: SearchChunkResult[] = scored.slice(0, input.limit).map((candidate) => ({
                    kind: "chunk",
                    file: candidate.result.relativePath,
                    span: {
                        startLine: candidate.result.startLine || 0,
                        endLine: candidate.result.endLine || 0,
                    },
                    language: candidate.result.language || "unknown",
                    content: String(candidate.result.content || ""),
                    score: candidate.finalScore,
                    indexedAt: typeof candidate.result.indexedAt === 'string' ? candidate.result.indexedAt : undefined,
                    stalenessBucket: this.getStalenessBucket(candidate.result.indexedAt),
                    symbolId: typeof candidate.result.symbolId === 'string' ? candidate.result.symbolId : undefined,
                    symbolLabel: typeof candidate.result.symbolLabel === 'string' ? candidate.result.symbolLabel : undefined,
                    symbolKey: typeof candidate.result.ownerSymbolKey === 'string' ? candidate.result.ownerSymbolKey : undefined,
                    symbolInstanceId: typeof candidate.result.ownerSymbolInstanceId === 'string' ? candidate.result.ownerSymbolInstanceId : undefined,
                    symbolKind: typeof candidate.result.symbolKind === 'string' ? candidate.result.symbolKind : undefined,
                    ...(input.debug ? {
                        debug: {
                            baseScore: candidate.baseScore,
                            fusionScore: candidate.fusionScore,
                            lexicalScore: candidate.lexicalScore,
                            pathMultiplier: candidate.pathMultiplier,
                            pathCategory: candidate.pathCategory,
                            changedFilesMultiplier: candidate.changedFilesMultiplier,
                            agentFitMultiplier: candidate.agentFitMultiplier,
                            agentFitReason: candidate.agentFitReason,
                            matchesMust: candidate.passesMatchedMust,
                            exactLexicalMatch: candidate.exactLexicalMatch,
                            backendScore: candidate.backendScore,
                            backendScoreKind: candidate.backendScoreKind,
                            provenance: this.buildSearchCandidateProvenance(candidate),
                        }
                    } : {})
                }));
                const noiseMitigationHint = this.buildNoiseMitigationHint(effectiveRoot, rawResults.map((result) => result.file), input.scope);
                const generatedArtifactsHint = this.buildGeneratedArtifactsVerificationHint(effectiveRoot, rawResults.map((result) => ({
                    file: result.file,
                    span: result.span,
                })));
                const responseHints: Record<string, unknown> = {
                    version: 1 as const,
                    navigation: { nextStep: SEARCH_NAVIGATION_NEXT_STEP },
                };
                if (noiseMitigationHint) {
                    responseHints.noiseMitigation = noiseMitigationHint;
                }
                if (generatedArtifactsHint) {
                    responseHints.verification = {
                        generatedArtifacts: generatedArtifactsHint,
                    };
                }
                if (debugHintBase) {
                    responseHints.debugSearch = debugHintBase;
                }
                if (proofDebugHint) {
                    responseHints.debugProofCheck = proofDebugHint;
                }

                const envelope: SearchResponseEnvelope = {
                    status: "ok",
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    limit: input.limit,
                    resultMode: "raw",
                    freshnessDecision,
                    freshnessSummary,
                    ...(finalizedSearchWarnings.length > 0 ? { warnings: finalizedSearchWarnings } : {}),
                    hints: responseHints,
                    results: rawResults
                };

                await this.touchWatchedCodebase(effectiveRoot);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(envelope) }],
                    meta: { searchDiagnostics }
                };
            }

            type GroupAccumulator = {
                chunks: SearchCandidate[];
                ownerSymbolKey?: string;
                ownerSymbolInstanceId?: string;
                ownerSymbolKind?: string;
                ownerSource: SearchOwnerSource;
            };

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

            const groupingStartedAtMs = this.searchPhaseNowMs();
            const groups = new Map<string, GroupAccumulator>();
            for (const candidate of scored) {
                const result = candidate.result;
                let groupKey = '';
                const ownerResolution = input.groupBy === 'symbol'
                    ? this.resolveSearchOwnerFromRegistry(result, searchSymbolRegistry, queryPlan)
                    : {};
                const ownerSymbolKey = ownerResolution.ownerSymbolKey;
                const ownerSymbolInstanceId = ownerResolution.ownerSymbolInstanceId;
                const ownerSymbolKind = ownerResolution.symbolKind;
                let ownerSource: SearchOwnerSource = 'fallback';
                if (input.groupBy === 'file') {
                    groupKey = `file:${result.relativePath}`;
                    ownerSource = 'fallback';
                } else if (ownerSymbolKey) {
                    groupKey = ownerSymbolInstanceId
                        ? `owner:${ownerSymbolKey}:${ownerSymbolInstanceId}`
                        : `owner:${ownerSymbolKey}`;
                    ownerSource = ownerResolution.ownerSource || 'owner_metadata';
                } else {
                    const proximityBucket = Math.floor((Math.max(1, result.startLine || 1) - 1) / SEARCH_PROXIMITY_WINDOW);
                    groupKey = `fallback:${result.relativePath}:${proximityBucket}`;
                    ownerSource = 'fallback';
                }

                const existing = groups.get(groupKey);
                if (!existing) {
                    groups.set(groupKey, {
                        chunks: [candidate],
                        ownerSymbolKey,
                        ownerSymbolInstanceId,
                        ownerSymbolKind,
                        ownerSource,
                    });
                } else {
                    existing.chunks.push(candidate);
                }
            }
            this.addSearchPhaseTiming(phaseTimings, 'grouping', groupingStartedAtMs);

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
            const sidecarReadyForOutline = Boolean(searchSymbolRegistryManifestHash);
            const groupingResultsStartedAtMs = this.searchPhaseNowMs();
            const groupedResults: Array<SearchGroupResult & { __exactLexicalMatch: boolean }> = [];
            for (const group of groups.values()) {
                exactMatchPinningApplied = this.sortSearchCandidates(group.chunks, queryPlan.exactMatchPinningEnabled, parsedOperators.must.length > 0) || exactMatchPinningApplied;
                rankingProvenance.exactMatchPinningApplied = exactMatchPinningApplied;
                const representative = group.chunks[0];
                const spanStart = Math.min(...group.chunks.map((c) => c.result.startLine || 0));
                const spanEnd = Math.max(...group.chunks.map((c) => c.result.endLine || 0));
                const span: SearchSpan = { startLine: spanStart, endLine: spanEnd };

                let indexedAtMax: string | undefined;
                let indexedAtMaxMs = Number.NEGATIVE_INFINITY;
                for (const chunk of group.chunks) {
                    const indexedAt = typeof chunk.result.indexedAt === 'string' ? chunk.result.indexedAt : undefined;
                    const indexedAtMs = this.parseIndexedAtMs(indexedAt);
                    if (indexedAtMs !== undefined && indexedAtMs > indexedAtMaxMs) {
                        indexedAtMaxMs = indexedAtMs;
                        indexedAtMax = indexedAt;
                    }
                }

                const repSymbolLabel = typeof representative.result.symbolLabel === 'string' ? representative.result.symbolLabel : null;
                const ownerSymbolKey = group.ownerSymbolKey;
                const ownerSymbolInstanceId = group.ownerSymbolInstanceId;
                const symbolKind = group.ownerSymbolKind || (typeof representative.result.symbolKind === 'string' ? representative.result.symbolKind : undefined);
                const supportBoost = Math.min(Math.log1p(group.chunks.length) * 0.01, 0.03);
                const symbolScore = representative.finalScore + supportBoost;
                const confidence = group.ownerSource === 'owner_metadata' || group.ownerSource === 'registry_repair'
                    ? (symbolKind === 'file' ? 'low' : 'medium')
                    : 'low';
                if (group.ownerSource === 'registry_repair') {
                    rankingProvenance.registryRepairGroupCount += 1;
                }
                const groupId = ownerSymbolInstanceId
                    || ownerSymbolKey
                    || this.buildFallbackGroupId(representative.result.relativePath, span);
                const registrySymbol = ownerSymbolInstanceId
                    ? searchSymbolRegistry?.symbolsByInstanceId.get(ownerSymbolInstanceId)
                    : undefined;
                const callGraphHint = this.buildSearchGroupCallGraphHint({
                    file: representative.result.relativePath,
                    language: representative.result.language || 'unknown',
                    span,
                    symbolLabel: repSymbolLabel || undefined,
                    ownerSymbolInstanceId,
                    registrySymbol,
                    registryLoaded: Boolean(searchSymbolRegistry),
                    registryUnavailableReason: searchSymbolRegistryUnavailableReason,
                    navigationState: callGraphNavigationState,
                });
                const navigationFallback = this.buildNavigationFallback(
                    effectiveRoot,
                    representative.result.relativePath,
                    span,
                    callGraphHint,
                    sidecarReadyForOutline
                );
                const nextActions = this.buildSearchNextActions(
                    effectiveRoot,
                    representative.result.relativePath,
                    span,
                    callGraphHint,
                    sidecarReadyForOutline
                );

                groupedResults.push({
                    kind: "group",
                    groupId,
                    file: representative.result.relativePath,
                    span,
                    language: representative.result.language || 'unknown',
                    ...(ownerSymbolInstanceId ? { symbolId: ownerSymbolInstanceId } : {}),
                    symbolLabel: repSymbolLabel,
                    ...(ownerSymbolKey ? { symbolKey: ownerSymbolKey } : {}),
                    ...(ownerSymbolInstanceId ? { symbolInstanceId: ownerSymbolInstanceId } : {}),
                    ...(symbolKind ? { symbolKind } : {}),
                    confidence,
                    score: symbolScore,
                    indexedAt: indexedAtMax || null,
                    stalenessBucket: this.getStalenessBucket(indexedAtMax),
                    collapsedChunkCount: group.chunks.length,
                    callGraphHint,
                    ...(navigationFallback ? { navigationFallback } : {}),
                    ...(nextActions ? { nextActions } : {}),
                    preview: truncateContent(String(representative.result.content || ''), SEARCH_GROUP_PREVIEW_MAX_CHARS),
                    __exactLexicalMatch: representative.exactLexicalMatch,
                    ...(input.debug ? {
                        debug: {
                            representativeChunkCount: group.chunks.length,
                            pathCategory: representative.pathCategory,
                            pathMultiplier: representative.pathMultiplier,
                            topChunkScore: representative.finalScore,
                            lexicalScore: representative.lexicalScore,
                            changedFilesMultiplier: representative.changedFilesMultiplier,
                            agentFitMultiplier: representative.agentFitMultiplier,
                            agentFitReason: representative.agentFitReason,
                            matchesMust: representative.passesMatchedMust,
                            exactLexicalMatch: representative.exactLexicalMatch,
                            symbolAggregation: {
                                ownerSource: group.ownerSource,
                                evidenceChunkCount: group.chunks.length,
                                supportBoost,
                            },
                            provenance: this.buildSearchCandidateProvenance(representative, group.ownerSource),
                        }
                    } : {})
                });
            }
            this.addSearchPhaseTiming(phaseTimings, 'grouping', groupingResultsStartedAtMs);

            const rankedGroupedResults = (queryPlan.referenceSeeking || queryPlan.intent === 'identifier')
                ? this.collapseDuplicateDeclarationGroups(groupedResults)
                : groupedResults;

            if (this.sortGroupedSearchResults(rankedGroupedResults, queryPlan.exactMatchPinningEnabled)) {
                exactMatchPinningApplied = true;
                rankingProvenance.exactMatchPinningApplied = true;
            }

            const diversityApplied = this.applyGroupDiversity(rankedGroupedResults, input.limit, input.groupBy);
            const visibleGroupedResults = diversityApplied.selected;
            const noiseMitigationHint = this.buildNoiseMitigationHint(effectiveRoot, visibleGroupedResults.map((result) => result.file), input.scope);
            const generatedArtifactsHint = this.buildGeneratedArtifactsVerificationHint(effectiveRoot, visibleGroupedResults.map((result) => ({
                file: result.file,
                span: result.span,
            })));
            const responseHints: Record<string, unknown> = {
                version: 1 as const,
                navigation: { nextStep: SEARCH_NAVIGATION_NEXT_STEP },
            };
            if (noiseMitigationHint) {
                responseHints.noiseMitigation = noiseMitigationHint;
            }
            if (generatedArtifactsHint) {
                responseHints.verification = {
                    generatedArtifacts: generatedArtifactsHint,
                };
            }
            if (debugHintBase) {
                responseHints.debugSearch = {
                    ...debugHintBase,
                    diversitySummary: diversityApplied.summary
                };
            }
            if (proofDebugHint) {
                responseHints.debugProofCheck = proofDebugHint;
            }

            const envelope: SearchResponseEnvelope = {
                status: "ok",
                path: absolutePath,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                limit: input.limit,
                resultMode: "grouped",
                freshnessDecision,
                freshnessSummary,
                ...(finalizedSearchWarnings.length > 0 ? { warnings: finalizedSearchWarnings } : {}),
                hints: responseHints,
                results: visibleGroupedResults.map(({ __exactLexicalMatch: _exactLexicalMatch, ...result }) => result)
            };

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
        const limitSymbols = Number.isFinite(args?.limitSymbols)
            ? Math.max(1, Number(args.limitSymbols))
            : 500;
        const requestedStartLine = Number.isFinite(args?.start_line) ? Math.max(1, Number(args.start_line)) : undefined;
        const requestedEndLine = Number.isFinite(args?.end_line) ? Math.max(1, Number(args.end_line)) : undefined;
        const resolveMode = args?.resolveMode === 'exact' ? 'exact' : 'outline';
        const symbolIdExact = typeof args?.symbolIdExact === 'string' ? args.symbolIdExact.trim() : undefined;
        const symbolLabelExact = typeof args?.symbolLabelExact === 'string' ? args.symbolLabelExact.trim() : undefined;

        try {
            const absoluteRoot = ensureAbsolutePath(args.path);
            const normalizedFile = this.normalizeRelativeFilePath(args.file);

            if (!fs.existsSync(absoluteRoot)) {
                const payload = this.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    normalizedFile,
                    `Path '${absoluteRoot}' does not exist. file_outline requires an indexed codebase directory root.`,
                    'not_indexed',
                    'not_indexed'
                );
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    isError: true
                };
            }

            const rootStat = fs.statSync(absoluteRoot);
            if (!rootStat.isDirectory()) {
                const payload = this.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    normalizedFile,
                    `Path '${absoluteRoot}' is not a directory. file_outline requires an indexed codebase directory root.`,
                    'not_indexed',
                    'not_indexed'
                );
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    isError: true
                };
            }

            trackCodebasePath(absoluteRoot);

            const trackedRootState = await this.prepareTrackedRootForRead(absoluteRoot);
            if (trackedRootState.state === 'requires_reindex') {
                const payload = this.buildRequiresReindexFileOutlinePayload(trackedRootState.codebasePath, {
                    ...args,
                    file: normalizedFile
                }, trackedRootState.message);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            if (trackedRootState.state === 'not_indexed') {
                const payload = this.buildNotIndexedFileOutlinePayload(normalizedFile, absoluteRoot);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            if (trackedRootState.state === 'indexing') {
                const payload = this.buildNotReadyFileOutlinePayload(trackedRootState.codebasePath, normalizedFile, absoluteRoot);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            if (trackedRootState.state === 'stale_local') {
                const payload = this.buildNotIndexedFileOutlinePayload(normalizedFile, absoluteRoot, {
                    codebaseRoot: trackedRootState.codebasePath,
                    reason: trackedRootState.reason
                });
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            if (trackedRootState.state === 'missing_collection') {
                const payload = this.withProofDebugHint(this.buildMissingLocalCollectionFileOutlinePayload(
                    trackedRootState.codebasePath,
                    absoluteRoot,
                    normalizedFile,
                    trackedRootState.collectionName
                ), trackedRootState.proofDebugHint);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            const matchedRoot = trackedRootState.root;
            const effectiveRoot = matchedRoot.path;
            const absoluteFile = path.resolve(effectiveRoot, normalizedFile);
            const relativeToRoot = path.relative(effectiveRoot, absoluteFile);
            if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
                const payload = this.buildInvalidFileOutlineRequestPayload(
                    effectiveRoot,
                    normalizedFile,
                    `File '${normalizedFile}' must be inside codebase root '${effectiveRoot}'.`,
                    'not_found'
                );
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    isError: true
                };
            }
            const proofDebugHint = trackedRootState.proofDebugHint;

            if (this.isPartialIndexNavigationUnavailable(matchedRoot.info)) {
                const payload = this.withProofDebugHint(this.buildRequiresReindexFileOutlinePayload(
                    effectiveRoot,
                    {
                        ...args,
                        file: normalizedFile
                    },
                    PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_DETAIL,
                    'partial_index_navigation_unavailable'
                ), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            if (!fs.existsSync(absoluteFile)) {
                const payload: FileOutlineResponseEnvelope = {
                    status: 'not_found',
                    path: effectiveRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `File '${normalizedFile}' does not exist under codebase root '${effectiveRoot}'.`
                };
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(this.withProofDebugHint(payload, proofDebugHint)) }]
                };
            }

            const fileStat = fs.statSync(absoluteFile);
            if (!fileStat.isFile()) {
                const payload: FileOutlineResponseEnvelope = {
                    status: 'not_found',
                    path: effectiveRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `'${normalizedFile}' is not a file.`
                };
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(this.withProofDebugHint(payload, proofDebugHint)) }]
                };
            }

            const windowStart = requestedStartLine;
            const windowEnd = requestedEndLine && requestedStartLine
                ? Math.max(requestedEndLine, requestedStartLine)
                : requestedEndLine;

            const registryState = await this.navigationStore.getSymbolsByFile({
                normalizedRootPath: effectiveRoot,
                file: normalizedFile,
            });
            if (registryState.status === 'ok') {
                const registrySymbols = registryState.symbols;
                if (registrySymbols.length > 0) {
                    const fileFreshness = this.getRegistryFileFreshness({
                        symbols: registrySymbols,
                        absoluteFile,
                    });
                    if (fileFreshness.status === 'inconsistent') {
                        const payload = this.withProofDebugHint(this.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                            ...args,
                            file: normalizedFile
                        }, `Symbol registry contains inconsistent file hashes for '${normalizedFile}'.`, 'incompatible_symbol_registry'), proofDebugHint);
                        return {
                            content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                        };
                    }
                    if (fileFreshness.status === 'stale') {
                        const payload = this.withProofDebugHint(this.buildStaleSymbolRefFileOutlinePayload(effectiveRoot, {
                            ...args,
                            file: normalizedFile
                        }, `File '${normalizedFile}' has changed since the symbol registry snapshot was published.`), proofDebugHint);
                        return {
                            content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                        };
                    }

                    const relationshipGraph = await this.loadRegistryValidatedCallGraphSidecar({
                        codebaseRoot: effectiveRoot,
                        registryManifestHash: registryState.manifestHash,
                    });
                    const outlineWarnings = registryState.warnings.length > 0
                        ? [`OUTLINE_SYMBOL_REGISTRY_WARNINGS:${registryState.warnings.length}`]
                        : [];
                    if (relationshipGraph.warning) {
                        outlineWarnings.push(`OUTLINE_${relationshipGraph.warning}`);
                    }
                    const payload = this.buildRegistryFileOutlinePayload({
                        codebaseRoot: effectiveRoot,
                        file: normalizedFile,
                        symbols: registrySymbols,
                        limitSymbols,
                        resolveMode,
                        symbolIdExact,
                        symbolLabelExact,
                        windowStart,
                        windowEnd,
                        callGraphNavigationState: relationshipGraph,
                        warnings: outlineWarnings.length > 0 ? outlineWarnings : undefined,
                    });
                    await this.touchWatchedCodebase(effectiveRoot);
                    return {
                        content: [{ type: "text", text: this.stringifyToolJson(this.withProofDebugHint(payload, proofDebugHint)) }]
                    };
                }
                const languageStatus = this.getOutlineStatusForLanguage(normalizedFile);
                if (languageStatus !== 'ok') {
                    const payload: FileOutlineResponseEnvelope = {
                        status: 'unsupported',
                        reason: 'unsupported_language',
                        path: effectiveRoot,
                        file: normalizedFile,
                        outline: null,
                        hasMore: false,
                        message: `File '${normalizedFile}' is not supported for sidecar outline. Supported extensions: ${OUTLINE_SUPPORTED_EXTENSIONS.join(', ')}.`
                    };
                    return {
                        content: [{ type: "text", text: this.stringifyToolJson(this.withProofDebugHint(payload, proofDebugHint)) }]
                    };
                }

                const payload = this.withProofDebugHint(this.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                    ...args,
                    file: normalizedFile
                }, `File '${normalizedFile}' is missing from the symbol registry for this snapshot.`, 'missing_symbol_registry'), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            if (registryState.status === 'incompatible') {
                const payload = this.withProofDebugHint(this.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                    ...args,
                    file: normalizedFile
                }, `Symbol registry is incompatible: ${registryState.reason}`, 'incompatible_symbol_registry'), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }]
                };
            }

            if (this.getOutlineStatusForLanguage(normalizedFile) !== 'ok') {
                const payload: FileOutlineResponseEnvelope = {
                    status: 'unsupported',
                    reason: 'unsupported_language',
                    path: effectiveRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `File '${normalizedFile}' is not supported for sidecar outline. Supported extensions: ${OUTLINE_SUPPORTED_EXTENSIONS.join(', ')}.`
                };
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(this.withProofDebugHint(payload, proofDebugHint)) }]
                };
            }

            const payload = this.withProofDebugHint(this.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                ...args,
                file: normalizedFile
            }, registryState.reason, 'missing_symbol_registry'), proofDebugHint);
            return {
                content: [{ type: "text", text: this.stringifyToolJson(payload) }]
            };
        } catch (error: any) {
            const payload = this.buildInvalidFileOutlineRequestPayload(
                typeof args?.path === 'string' ? ensureAbsolutePath(args.path) : '',
                typeof args?.file === 'string' ? this.normalizeRelativeFilePath(args.file) : '',
                `Unexpected file_outline failure: ${error?.message || error}`,
                'not_ready'
            );
            return {
                content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                isError: true
            };
        }
    }

    public async handleCallGraph(args: any) {
        const rawDirection = args?.direction;
        const direction: CallGraphDirection = rawDirection === 'callers' || rawDirection === 'callees' || rawDirection === 'both'
            ? rawDirection
            : 'both';
        const depth = Number.isFinite(args?.depth) ? Math.max(1, Math.min(3, Number(args.depth))) : 1;
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Number(args.limit)) : 20;
        const symbolRef = args?.symbolRef as CallGraphSymbolRef | undefined;
        const normalizedSymbolRef: CallGraphSymbolRef = {
            file: typeof symbolRef?.file === 'string' ? this.normalizeRelativeFilePath(symbolRef.file) : '',
            symbolId: typeof symbolRef?.symbolId === 'string' ? symbolRef.symbolId : '',
            ...(typeof symbolRef?.symbolLabel === 'string' ? { symbolLabel: symbolRef.symbolLabel } : {}),
            ...(symbolRef?.span ? { span: symbolRef.span } : {}),
        };
        const invalidSymbolRefContext = {
            path: typeof args?.path === 'string' ? ensureAbsolutePath(args.path) : '',
            symbolRef: normalizedSymbolRef,
            direction,
            depth,
            limit,
        };

        if (!symbolRef || typeof symbolRef.file !== 'string' || typeof symbolRef.symbolId !== 'string') {
            const payload = this.buildInvalidCallGraphRequestPayload(
                invalidSymbolRefContext,
                'symbolRef with { file, symbolId } is required.',
                'not_found',
                'invalid_symbol_ref'
            );
            return {
                content: [{
                    type: "text",
                    text: this.stringifyToolJson(payload)
                }],
                isError: true
            };
        }

        try {
            const absolutePath = ensureAbsolutePath(args?.path);
            if (!fs.existsSync(absolutePath)) {
                const payload = this.buildInvalidCallGraphRequestPayload(
                    {
                        path: absolutePath,
                        symbolRef: normalizedSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    `Path '${absolutePath}' does not exist. call_graph requires an indexed codebase directory root.`,
                    'not_indexed',
                    'not_indexed'
                );
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                const payload = this.buildInvalidCallGraphRequestPayload(
                    {
                        path: absolutePath,
                        symbolRef: normalizedSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    `Path '${absolutePath}' is not a directory. call_graph requires an indexed codebase directory root.`,
                    'not_indexed',
                    'not_indexed'
                );
                return {
                    content: [{ type: "text", text: this.stringifyToolJson(payload) }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            const trackedRootState = await this.prepareTrackedRootForRead(absolutePath);
            if (trackedRootState.state === 'requires_reindex') {
                const payload = this.buildRequiresReindexCallGraphPayload(
                    trackedRootState.codebasePath,
                    trackedRootState.message,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit
                    }
                );
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            if (trackedRootState.state === 'indexing') {
                const payload = this.buildNotReadyCallGraphPayload(trackedRootState.codebasePath, {
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit
                });
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            if (trackedRootState.state === 'not_indexed') {
                const payload = this.buildNotIndexedCallGraphPayload({
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit
                });
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            if (trackedRootState.state === 'stale_local') {
                const payload = this.buildNotIndexedCallGraphPayload(
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit
                    },
                    {
                        codebaseRoot: trackedRootState.codebasePath,
                        reason: trackedRootState.reason
                    }
                );
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            if (trackedRootState.state === 'missing_collection') {
                const payload = this.withProofDebugHint(this.buildMissingLocalCollectionCallGraphPayload(
                    trackedRootState.codebasePath,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    trackedRootState.collectionName
                ), trackedRootState.proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            const searchableRoot = trackedRootState.root;
            const effectiveRoot = searchableRoot.path;
            const proofDebugHint = trackedRootState.proofDebugHint;

            if (this.isPartialIndexNavigationUnavailable(searchableRoot.info)) {
                const payload = this.withProofDebugHint(this.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_DETAIL,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit
                    },
                    'partial_index_navigation_unavailable'
                ), proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            const normalizedSymbolFile = this.normalizeRelativeFilePath(symbolRef.file);
            const registryState = await this.navigationStore.getSymbolsByFile({
                normalizedRootPath: effectiveRoot,
                file: normalizedSymbolFile,
            });
            if (registryState.status !== 'ok') {
                const reason = registryState.status === 'missing'
                    ? 'missing_symbol_registry'
                    : 'incompatible_symbol_registry';
                const payload = this.withProofDebugHint(this.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    `Symbol registry is ${registryState.status}: ${registryState.reason}`,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit
                    },
                    reason
                ), proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            const exactRegistrySymbols = this.findExactRegistrySymbols({
                symbols: registryState.symbols,
                symbolIdExact: symbolRef.symbolId,
                symbolLabelExact: symbolRef.symbolLabel,
            });
            if (exactRegistrySymbols.length === 0) {
                const payload = this.withProofDebugHint({
                    status: 'not_found' as const,
                    path: effectiveRoot,
                    symbolRef,
                    supported: false,
                    reason: 'missing_symbol',
                    message: 'No exact symbol match found in relationship-backed navigation state.',
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            if (exactRegistrySymbols.length > 1) {
                const payload = this.withProofDebugHint({
                    status: 'not_found' as const,
                    path: effectiveRoot,
                    symbolRef,
                    supported: false,
                    reason: 'missing_symbol',
                    message: 'Ambiguous exact symbol reference. Use symbolInstanceId for deterministic traversal.',
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            const resolvedSymbol = exactRegistrySymbols[0];
            const absoluteSymbolFile = path.resolve(effectiveRoot, normalizedSymbolFile);
            const relativeSymbolFile = path.relative(effectiveRoot, absoluteSymbolFile);
            const symbolFileInsideRoot = !relativeSymbolFile.startsWith('..') && !path.isAbsolute(relativeSymbolFile);
            if (!symbolFileInsideRoot || !fs.existsSync(absoluteSymbolFile) || !fs.statSync(absoluteSymbolFile).isFile()) {
                if (exactRegistrySymbols.some((symbol) => this.isSha256HexHash(symbol.fileHash))) {
                    const payload = this.withProofDebugHint(this.buildStaleSymbolRefCallGraphPayload({
                        codebaseRoot: effectiveRoot,
                        context: {
                            path: absolutePath,
                            symbolRef,
                            direction,
                            depth,
                            limit,
                        },
                        message: `Symbol reference points at '${normalizedSymbolFile}', but the current file is unavailable. Refresh the index before using exact call graph navigation.`,
                    }), proofDebugHint);
                    return {
                        content: [{
                            type: "text",
                            text: this.stringifyToolJson(payload)
                        }]
                    };
                }
            } else {
                const fileFreshness = this.getRegistryFileFreshness({
                    symbols: exactRegistrySymbols,
                    absoluteFile: absoluteSymbolFile,
                });
                if (fileFreshness.status === 'inconsistent') {
                    const payload = this.withProofDebugHint(this.buildRequiresReindexCallGraphPayload(
                        effectiveRoot,
                        `Symbol registry contains inconsistent file hashes for '${normalizedSymbolFile}'.`,
                        {
                            path: absolutePath,
                            symbolRef,
                            direction,
                            depth,
                            limit
                        },
                        'incompatible_symbol_registry'
                    ), proofDebugHint);
                    return {
                        content: [{
                            type: "text",
                            text: this.stringifyToolJson(payload)
                        }]
                    };
                }
                if (fileFreshness.status === 'stale') {
                    const payload = this.withProofDebugHint(this.buildStaleSymbolRefCallGraphPayload({
                        codebaseRoot: effectiveRoot,
                        context: {
                            path: absolutePath,
                            symbolRef,
                            direction,
                            depth,
                            limit,
                        },
                        message: `Symbol reference for '${normalizedSymbolFile}' is stale relative to the current file contents. Refresh the index before using exact call graph navigation.`,
                    }), proofDebugHint);
                    return {
                        content: [{
                            type: "text",
                            text: this.stringifyToolJson(payload)
                        }]
                    };
                }
            }

            if (!this.isCallGraphLanguageSupported(resolvedSymbol.language, resolvedSymbol.file)) {
                const payload = this.withProofDebugHint({
                    status: 'unsupported' as const,
                    path: effectiveRoot,
                    symbolRef,
                    supported: false,
                    reason: 'unsupported_language',
                    message: `Language '${resolvedSymbol.language}' does not support relationship-backed call graph traversal.`,
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            const compatibility = await this.navigationStore.getCompatibilityState({
                normalizedRootPath: effectiveRoot,
                expectedSymbolRegistryManifestHash: registryState.manifestHash,
            });
            if (compatibility.relationships.status !== 'ok') {
                const reason = compatibility.relationships.status === 'missing'
                    ? 'missing_relationship_sidecar'
                    : 'incompatible_relationship_sidecar';
                const payload = this.withProofDebugHint(this.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    `Relationship sidecar is ${compatibility.relationships.status}: ${compatibility.relationships.reason}`,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit
                    },
                    reason
                ), proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            const relationshipBackedGraph = await this.buildRelationshipBackedCallGraph({
                codebaseRoot: effectiveRoot,
                registry: registryState.registry,
                registryManifestHash: registryState.manifestHash,
                resolvedSymbol,
                direction,
                depth,
                limit,
            });
            if (!relationshipBackedGraph) {
                const payload = this.withProofDebugHint(this.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    'Relationship-backed call graph traversal could not load a compatible navigation snapshot.',
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit
                    }
                ), proofDebugHint);
                return {
                    content: [{
                        type: "text",
                        text: this.stringifyToolJson(payload)
                    }]
                };
            }

            await this.touchWatchedCodebase(effectiveRoot);
            const payload = this.withProofDebugHint({
                status: 'ok' as const,
                path: effectiveRoot,
                symbolRef,
                ...relationshipBackedGraph,
            } satisfies CallGraphResponseEnvelope, proofDebugHint);

            return {
                content: [{
                    type: "text",
                    text: this.stringifyToolJson(payload)
                }]
            };
        } catch (error: any) {
            const payload = this.buildInvalidCallGraphRequestPayload(
                {
                    path: typeof args?.path === 'string' ? ensureAbsolutePath(args.path) : '',
                    symbolRef: normalizedSymbolRef,
                    direction,
                    depth,
                    limit,
                },
                `Unexpected call_graph failure: ${error?.message || error}`,
                'not_ready'
            );
            return {
                content: [{
                    type: "text",
                    text: this.stringifyToolJson(payload)
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;
        const requestedPath = ensureAbsolutePath(codebasePath);

        if (this.snapshotManager.getAllCodebases().length === 0) {
            return this.manageResponse(
                "clear",
                requestedPath,
                "not_indexed",
                "No codebases are currently tracked.",
                { reason: "not_indexed" }
            );
        }

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = requestedPath;
            const pathExists = fs.existsSync(absolutePath);

            if (pathExists) {
                // Check if it's a directory
                const stat = fs.statSync(absolutePath);
                if (!stat.isDirectory()) {
                    return this.manageResponse("clear", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
                }
            }

            const runtimeOwnerConflict = await this.buildRuntimeOwnerConflictResponseIfBlocked("clear", absolutePath);
            if (runtimeOwnerConflict) {
                return runtimeOwnerConflict;
            }

            if (pathExists) {
                await this.recoverStaleIndexingStateIfNeeded(absolutePath);
            }

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);
            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const isRequiresReindex = status === 'requires_reindex';

            if (!isIndexed && !isIndexing && !isRequiresReindex) {
                if (!pathExists) {
                    return this.manageResponse("clear", absolutePath, "error", `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`);
                }
                return this.manageResponse(
                    "clear",
                    absolutePath,
                    "not_indexed",
                    `Error: Codebase '${absolutePath}' is not indexed or being indexed.`,
                    {
                        reason: "not_indexed",
                        hints: {
                            create: this.buildCreateHint(absolutePath)
                        }
                    }
                );
            }

            if (isIndexing) {
                return this.manageResponse(
                    "clear",
                    absolutePath,
                    "not_ready",
                    this.buildManageActionBlockedMessage(absolutePath, 'clear'),
                    {
                        reason: "indexing",
                        hints: {
                            status: this.buildStatusHint(absolutePath),
                            retryAfterMs: this.getManageRetryAfterMs(),
                            indexing: this.buildIndexingMetadata(absolutePath),
                        }
                    }
                );
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                if (error instanceof RemoteCollectionDeletePendingError) {
                    const errorMsg = `Remote deletion is still pending for ${absolutePath}. Local index state was not changed. Details: ${formatUnknownError(error)}`;
                    console.error(`[CLEAR] ${errorMsg}`);
                    return this.manageResponse("clear", absolutePath, "error", errorMsg, {
                        reason: "remote_delete_pending",
                        hints: {
                            retry: this.buildStatusHint(absolutePath),
                            clear: { tool: "manage_index", args: { action: "clear", path: absolutePath } }
                        }
                    });
                }
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return this.manageResponse("clear", absolutePath, "error", errorMsg);
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);
            if (typeof (this.snapshotManager as any).markCodebaseCleared === 'function') {
                this.snapshotManager.markCodebaseCleared(absolutePath, this.context.resolveCollectionName(absolutePath));
            }

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();
            await this.unwatchCodebase(absolutePath);

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return this.manageResponse("clear", absolutePath, "ok", resultText);
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return this.manageResponse("clear", requestedPath, "error", COLLECTION_LIMIT_MESSAGE);
            }

            return this.manageResponse("clear", requestedPath, "error", `Error clearing index: ${errorMessage}`);
        }
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;
        const requestedPath = ensureAbsolutePath(codebasePath);

        try {
            // Force absolute path resolution
            const absolutePath = requestedPath;

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return this.manageResponse("status", absolutePath, "error", `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`);
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.manageResponse("status", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
            }

            this.refreshSnapshotStateFromDisk();
            await this.recoverStaleIndexingStateIfNeeded(absolutePath);

            // Check indexing status using new status system
            const statusGate = this.enforceFingerprintGate(absolutePath);
            if (statusGate.blockedResponse) {
                const statusMessage = this.buildReindexInstruction(absolutePath, statusGate.message);
                const compatibilityStatus = this.buildCompatibilityStatusLines(absolutePath);
                const pathInfo = codebasePath !== absolutePath
                    ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                    : '';

                return this.manageResponse(
                    "status",
                    absolutePath,
                    "requires_reindex",
                    statusMessage + compatibilityStatus + pathInfo,
                    {
                        reason: "requires_reindex",
                        hints: {
                            reindex: this.buildReindexHint(absolutePath),
                            status: this.buildStatusHint(absolutePath),
                        }
                    }
                );
            }

            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const info = this.snapshotManager.getCodebaseInfo(absolutePath);

            let statusMessage = '';
            let envelopeStatus: ManageIndexStatus = "ok";
            let envelopeReason: ManageIndexReason | undefined = undefined;
            let envelopeHints: Record<string, unknown> | undefined = undefined;
            let completionProof: CompletionProofValidationResult | null = null;
            if (status === 'indexed' || status === 'sync_completed') {
                completionProof = await this.validateCompletionProof(absolutePath);
            }

            if (completionProof?.outcome === 'fingerprint_mismatch') {
                envelopeStatus = "requires_reindex";
                envelopeReason = "requires_reindex";
                envelopeHints = {
                    reindex: this.buildReindexHint(absolutePath),
                    status: this.buildStatusHint(absolutePath),
                };
                statusMessage = this.buildReindexInstruction(
                    absolutePath,
                    'Completion proof fingerprint does not match the current runtime fingerprint.'
                );
            } else if (completionProof?.outcome === 'stale_local') {
                const staleReason = completionProof.reason || 'missing_marker_doc';
                envelopeStatus = "not_indexed";
                envelopeReason = "not_indexed";
                envelopeHints = {
                    create: this.buildCreateHint(absolutePath),
                    staleLocal: this.buildStaleLocalHint(absolutePath, staleReason),
                };
                statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Local snapshot claims it is ready, but completion proof is missing or invalid (reason: ${staleReason}). Call manage_index with {"action":"create","path":"${absolutePath}"} to repair it.`;
            } else {
                switch (status) {
                    case 'indexed':
                        if (info && 'indexedFiles' in info) {
                            const indexedInfo = info as any;
                            statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                            statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                            statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                            statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                        } else {
                            statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        }
                        break;

                    case 'indexing':
                        envelopeStatus = "not_ready";
                        envelopeReason = "indexing";
                        envelopeHints = {
                            status: this.buildStatusHint(absolutePath),
                            retryAfterMs: this.getManageRetryAfterMs(),
                            indexing: this.buildIndexingMetadata(absolutePath),
                        };
                        if (info && 'indexingPercentage' in info) {
                            const indexingInfo = info as any;
                            const progressPercentage = indexingInfo.indexingPercentage || 0;
                            statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                            // Add more detailed status based on progress
                            if (progressPercentage < 10) {
                                statusMessage += ' (Preparing and scanning files...)';
                            } else if (progressPercentage < 100) {
                                statusMessage += ' (Processing files and generating embeddings...)';
                            }
                            statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                        } else {
                            statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed.`;
                        }
                        break;

                    case 'indexfailed':
                        envelopeStatus = "error";
                        if (info && 'errorMessage' in info) {
                            const failedInfo = info as any;
                            statusMessage = `❌ Codebase '${absolutePath}' indexing failed.`;
                            statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                            if (failedInfo.lastAttemptedPercentage !== undefined) {
                                statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                            }
                            statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                            statusMessage += `\n💡 Retry with manage_index action='create'.`;
                        } else {
                            statusMessage = `❌ Codebase '${absolutePath}' indexing failed. You can retry indexing.`;
                        }
                        break;

                    case 'sync_completed':
                        if (info && 'added' in info) {
                            const syncInfo = info as any;
                            statusMessage = `🔄 Codebase '${absolutePath}' sync completed.`;
                            statusMessage += `\n📊 Changes: +${syncInfo.added} added, -${syncInfo.removed} removed, ~${syncInfo.modified} modified`;
                            statusMessage += `\n🕐 Last synced: ${new Date(syncInfo.lastUpdated).toLocaleString()}`;
                        } else {
                            statusMessage = `🔄 Codebase '${absolutePath}' sync completed.`;
                        }
                        break;

                    case 'requires_reindex':
                        envelopeStatus = "requires_reindex";
                        envelopeReason = "requires_reindex";
                        envelopeHints = {
                            reindex: this.buildReindexHint(absolutePath),
                            status: this.buildStatusHint(absolutePath),
                        };
                        statusMessage = this.buildReindexInstruction(absolutePath, info && 'message' in info ? info.message : undefined);
                        break;

                    case 'not_found':
                    default:
                        envelopeStatus = "not_indexed";
                        envelopeReason = "not_indexed";
                        envelopeHints = {
                            create: this.buildCreateHint(absolutePath)
                        };
                        statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Call manage_index with {\"action\":\"create\",\"path\":\"${absolutePath}\"} to index it first.`;
                        break;
                }
            }

            const warnings: WarningCode[] = [];
            if (completionProof?.outcome === 'probe_failed') {
                statusMessage += `\n⚠️ Completion proof check is temporarily unavailable (probe_failed); keeping local status.`;
                warnings.push(WARNING_CODES.IGNORE_POLICY_PROBE_FAILED);
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';
            const compatibilityStatus = this.buildCompatibilityStatusLines(absolutePath);

            return this.manageResponse(
                "status",
                absolutePath,
                envelopeStatus,
                statusMessage + compatibilityStatus + pathInfo,
                {
                    reason: envelopeReason,
                    hints: envelopeHints,
                    warnings
                }
            );

        } catch (error: any) {
            return this.manageResponse("status", requestedPath, "error", `Error getting indexing status: ${error.message || error}`);
        }
    }

    /**
     * Handle sync request - manually trigger incremental sync for a codebase
     */
    public async handleSyncCodebase(args: any) {
        const { path: codebasePath } = args;
        const requestedPath = ensureAbsolutePath(codebasePath);

        try {
            // Force absolute path resolution
            const absolutePath = requestedPath;

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return this.manageResponse("sync", absolutePath, "error", `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`);
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.manageResponse("sync", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
            }

            const runtimeOwnerConflict = await this.buildRuntimeOwnerConflictResponseIfBlocked("sync", absolutePath);
            if (runtimeOwnerConflict) {
                return runtimeOwnerConflict;
            }

            await this.recoverStaleIndexingStateIfNeeded(absolutePath);

            // Check if this codebase is indexed
            const syncGate = this.enforceFingerprintGate(absolutePath);
            if (syncGate.blockedResponse) {
                return this.manageResponse(
                    "sync",
                    absolutePath,
                    "requires_reindex",
                    this.buildReindexInstruction(absolutePath, syncGate.message),
                    {
                        reason: "requires_reindex",
                        hints: {
                            reindex: this.buildReindexHint(absolutePath),
                            status: this.buildStatusHint(absolutePath),
                        }
                    }
                );
            }

            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                return this.manageResponse(
                    "sync",
                    absolutePath,
                    "not_ready",
                    this.buildManageActionBlockedMessage(absolutePath, 'sync'),
                    {
                        reason: "indexing",
                        hints: {
                            status: this.buildStatusHint(absolutePath),
                            retryAfterMs: this.getManageRetryAfterMs(),
                            indexing: this.buildIndexingMetadata(absolutePath),
                        }
                    }
                );
            }

            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            if (!isIndexed) {
                return this.manageResponse(
                    "sync",
                    absolutePath,
                    "not_indexed",
                    `Error: Codebase '${absolutePath}' is not indexed. Call manage_index with {\"action\":\"create\",\"path\":\"${absolutePath}\"} first.`,
                    {
                        reason: "not_indexed",
                        hints: {
                            create: this.buildCreateHint(absolutePath)
                        }
                    }
                );
            }

            console.log(`[SYNC] Manually triggering incremental sync for: ${absolutePath}`);
            // Route manual sync through freshness gate so ignore-rule reconciliation is honored.
            const decision = await this.syncManager.ensureFreshness(absolutePath, 0);

            if (decision.mode === 'ignore_reload_failed') {
                const fallbackLine = decision.fallbackSyncExecuted
                    ? '\nFallback incremental sync was executed, but ignore-rule reconciliation did not complete deterministically.'
                    : '';
                return this.manageResponse(
                    "sync",
                    absolutePath,
                    "error",
                    `Error syncing codebase: ignore-rule reconciliation failed (${decision.errorMessage || 'unknown_ignore_reload_error'}).${fallbackLine}`
                );
            }

            if (decision.mode === 'skipped_indexing') {
                return this.manageResponse(
                    "sync",
                    absolutePath,
                    "not_ready",
                    this.buildManageActionBlockedMessage(absolutePath, 'sync'),
                    {
                        reason: "indexing",
                        hints: {
                            status: this.buildStatusHint(absolutePath),
                            retryAfterMs: this.getManageRetryAfterMs(),
                            indexing: this.buildIndexingMetadata(absolutePath),
                        }
                    }
                );
            }

            if (decision.mode === 'skipped_requires_reindex') {
                return this.manageResponse(
                    "sync",
                    absolutePath,
                    "requires_reindex",
                    this.buildReindexInstruction(absolutePath, 'Sync blocked because this codebase requires reindex.'),
                    {
                        reason: "requires_reindex",
                        hints: {
                            reindex: this.buildReindexHint(absolutePath),
                            status: this.buildStatusHint(absolutePath),
                        }
                    }
                );
            }

            if (decision.mode === 'skipped_missing_path') {
                return this.manageResponse("sync", absolutePath, "error", `Error: Codebase path '${absolutePath}' no longer exists.`);
            }

            const added = decision.stats?.added ?? 0;
            const removed = decision.stats?.removed ?? 0;
            const modified = decision.stats?.modified ?? 0;
            const ignoredDeletes = decision.deletedFiles ?? 0;
            const totalChanges = added + removed + modified;

            if (decision.mode === 'coalesced') {
                if (typeof decision.errorMessage === 'string' && decision.errorMessage.trim().length > 0) {
                    const fallbackLine = decision.fallbackSyncExecuted
                        ? '\nFallback incremental sync was executed, but ignore-rule reconciliation did not complete deterministically.'
                        : '';
                    return this.manageResponse(
                        "sync",
                        absolutePath,
                        "error",
                        `Error syncing codebase: coalesced in-flight reconcile failed (${decision.errorMessage}).${fallbackLine}`
                    );
                }
                await this.touchWatchedCodebase(absolutePath);
                return this.manageResponse("sync", absolutePath, "ok", `🔄 Sync request coalesced for '${absolutePath}'. Reused in-flight sync result.`);
            }

            if (decision.mode === 'reconciled_ignore_change') {
                if (totalChanges === 0 && ignoredDeletes === 0) {
                    await this.touchWatchedCodebase(absolutePath);
                    return this.manageResponse("sync", absolutePath, "ok", `✅ Ignore-rule reconciliation completed for '${absolutePath}'. No additional index changes were required.`);
                }

                const resultMessage =
                    `🔄 Incremental sync + ignore-rule reconciliation completed for '${absolutePath}'.\n\n` +
                    `📊 Sync changes:\n+ ${added} file(s) added\n- ${removed} file(s) removed\n~ ${modified} file(s) modified\n` +
                    `🧹 Ignored paths removed from index: ${ignoredDeletes}\n` +
                    `\nTotal changes: ${totalChanges + ignoredDeletes}`;
                console.log(`[SYNC] ✅ Sync+ignore reconcile completed: +${added}, -${removed}, ~${modified}, ignoredDeleted=${ignoredDeletes}`);
                await this.touchWatchedCodebase(absolutePath);
                return this.manageResponse("sync", absolutePath, "ok", resultMessage);
            }

            if (totalChanges === 0) {
                await this.touchWatchedCodebase(absolutePath);
                return this.manageResponse("sync", absolutePath, "ok", `✅ No changes detected for codebase '${absolutePath}'. Index is up to date.`);
            }

            const resultMessage = `🔄 Incremental sync completed for '${absolutePath}'.\n\n📊 Changes:\n+ ${added} file(s) added\n- ${removed} file(s) removed\n~ ${modified} file(s) modified\n\nTotal changes: ${totalChanges}`;
            console.log(`[SYNC] ✅ Sync completed: +${added}, -${removed}, ~${modified}`);
            await this.touchWatchedCodebase(absolutePath);
            return this.manageResponse("sync", absolutePath, "ok", resultMessage);

        } catch (error: any) {
            console.error(`[SYNC] Error during sync:`, error);
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                return this.manageVectorBackendResponse("sync", requestedPath, vectorBackendDiagnostic);
            }
            return this.manageResponse("sync", requestedPath, "error", `Error syncing codebase: ${error.message || error}`);
        }
    }
    public async handleReadCode(args: any) {
        const { path: filePath } = args;

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
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error reading file: ${error.message}` }],
                isError: true
            };
        }
    }
}
