import { FreshnessDecision } from "./sync.js";
import { SearchGroupBy, SearchNoiseCategory, SearchRankingMode, SearchResultMode, SearchScope } from "./search-constants.js";
import { FingerprintSource, IndexFingerprint } from "../config.js";

export type StalenessBucket = "fresh" | "aging" | "stale" | "unknown";

export interface SearchSpan {
    startLine: number;
    endLine: number;
}

export interface CallGraphSymbolRef {
    file: string;
    symbolId: string;
    symbolLabel?: string;
    span?: SearchSpan;
}

export type CallGraphHint =
    | {
        supported: true;
        symbolRef: CallGraphSymbolRef;
        validated: true;
        validatedAt: string;
        sidecarBuiltAt: string;
    }
    | { supported: false; reason: "missing_symbol" | "unsupported_language" | "missing_sidecar" | "stale_symbol_ref" };

export interface SearchNextActionReadSymbol {
    tool: "read_file";
    args: {
        path: string;
        open_symbol: {
            symbolId: string;
            symbolLabel?: string;
            start_line: number;
            end_line: number;
        };
    };
}

export interface SearchNextActionFileOutlineWindow {
    tool: "file_outline";
    args: {
        path: string;
        file: string;
        start_line: number;
        end_line: number;
        resolveMode: "outline";
    };
}

export interface SearchNextActionCallGraph {
    tool: "call_graph";
    args: {
        path: string;
        symbolRef: CallGraphSymbolRef;
        depth: number;
        limit: number;
    };
    directions: Array<"callers" | "callees">;
}

export interface SearchNextActions {
    openSymbol?: SearchNextActionReadSymbol;
    outlineWindow?: SearchNextActionFileOutlineWindow;
    callGraph?: SearchNextActionCallGraph;
}

export interface SearchChunkResult {
    kind: "chunk";
    file: string;
    span: SearchSpan;
    language: string;
    content: string;
    score: number;
    indexedAt?: string;
    stalenessBucket: StalenessBucket;
    symbolId?: string;
    symbolLabel?: string;
    debug?: {
        baseScore: number;
        fusionScore: number;
        lexicalScore: number;
        pathMultiplier: number;
        pathCategory: string;
        changedFilesMultiplier?: number;
        agentFitMultiplier?: number;
        agentFitReason?: string;
        matchesMust?: boolean;
        exactLexicalMatch: boolean;
        backendScore?: number;
        backendScoreKind?: "dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown";
    };
}

export interface SearchGroupResult {
    kind: "group";
    groupId: string;
    file: string;
    span: SearchSpan;
    language: string;
    symbolId: string | null;
    symbolLabel: string | null;
    score: number;
    indexedAt: string | null;
    stalenessBucket: StalenessBucket;
    collapsedChunkCount: number;
    callGraphHint: CallGraphHint;
    navigationFallback?: SearchNavigationFallback;
    nextActions?: SearchNextActions;
    preview: string;
    debug?: {
        representativeChunkCount: number;
        pathCategory: string;
        pathMultiplier: number;
        topChunkScore: number;
        lexicalScore: number;
        changedFilesMultiplier?: number;
        agentFitMultiplier?: number;
        agentFitReason?: string;
        matchesMust?: boolean;
        exactLexicalMatch: boolean;
    };
}

export interface SearchNavigationFallbackContext {
    codebaseRoot: string;
    relativeFile: string;
    absolutePath?: string;
}

export interface SearchNavigationFallbackReadSpan {
    tool: "read_file";
    args: {
        path: string;
        start_line: number;
        end_line: number;
    };
}

export interface SearchNavigationFallbackFileOutlineWindow {
    tool: "file_outline";
    args: {
        path: string;
        file: string;
        start_line: number;
        end_line: number;
        resolveMode: "outline";
    };
}

export interface SearchNavigationFallback {
    message: string;
    context: SearchNavigationFallbackContext;
    readSpan: SearchNavigationFallbackReadSpan;
    fileOutlineWindow?: SearchNavigationFallbackFileOutlineWindow;
}

export interface FingerprintCompatibilityDiagnostics {
    runtimeFingerprint: IndexFingerprint;
    indexedFingerprint?: IndexFingerprint;
    fingerprintSource?: FingerprintSource;
    reindexReason?: "legacy_unverified_fingerprint" | "fingerprint_mismatch" | "missing_fingerprint";
    statusAtCheck?: "indexed" | "indexing" | "indexfailed" | "sync_completed" | "requires_reindex" | "not_found";
}

export interface SearchNoiseMitigationHint {
    reason: "top_results_noise_dominant";
    topK: number;
    ratios: Record<SearchNoiseCategory, number>;
    recommendedScope: "runtime";
    suggestedIgnorePatterns: string[];
    debounceMs: number;
    nextStep: string;
}

export interface SearchNavigationHint {
    nextStep: string;
}

export interface SearchFreshnessSummary {
    syncMode: FreshnessDecision["mode"] | "skipped_requires_reindex" | "skipped_indexing";
    lastSyncAt: string | null;
    changedFileCount: number;
    gitDirtyFilesConsidered: boolean;
    changedFilesBoostApplied: boolean;
    changedFilesBoostSkippedForLargeChangeSet: boolean;
}

export interface SearchOperatorSummary {
    prefixBlockChars: number;
    lang: string[];
    path: string[];
    excludePath: string[];
    must: string[];
    exclude: string[];
}

export interface SearchDebugHint {
    queryIntent: {
        classification: "identifier" | "semantic" | "mixed" | "uncertain";
        confidence: "high" | "medium" | "low";
        reasons: string[];
        lexicalTerms: string[];
        semanticQuery: string;
    };
    retrieval: {
        mode: "dense" | "lexical" | "hybrid";
        scorePolicyKind: "dense_similarity_min" | "topk_only";
        backendScoreKinds: Array<"dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown">;
    };
    passesUsed: string[];
    candidateLimit: number;
    mustRetry: {
        attempts: number;
        maxAttempts: number;
        applied: boolean;
        satisfied: boolean;
        finalCount: number;
    };
    operatorSummary: SearchOperatorSummary;
    filterSummary: {
        removedByScope: number;
        removedByLanguage: number;
        removedByPathInclude: number;
        removedByPathExclude: number;
        removedByMust: number;
        removedByExclude: number;
    };
    diversitySummary?: {
        maxPerFile: number;
        maxPerSymbol: number;
        relaxedFileCap: number;
        skippedByFileCap: number;
        skippedBySymbolCap: number;
        usedRelaxedCap: boolean;
    };
    changedFilesBoost: {
        enabled: boolean;
        applied: boolean;
        available: boolean;
        changedCount: number;
        maxChangedFilesForBoost: number;
        skippedForLargeChangeSet: boolean;
        multiplier: number;
        boostedCandidates: number;
    };
    changedCode?: {
        files: string[];
        symbols: Array<{
            file: string;
            symbolId: string;
            symbolLabel?: string;
            span: SearchSpan;
        }>;
        directCallers: Array<{
            targetSymbolId: string;
            file: string;
            symbolId: string;
            symbolLabel?: string;
            span: SearchSpan;
            site: {
                file: string;
                startLine: number;
                endLine?: number;
            };
            kind: "call" | "import" | "dynamic";
            confidence: number;
        }>;
    };
    rerank?: {
        enabledByPolicy: boolean;
        skippedByScopeDocs: boolean;
        skippedByIdentifierIntent: boolean;
        capabilityPresent: boolean;
        rerankerPresent: boolean;
        enabled: boolean;
        attempted: boolean;
        applied: boolean;
        exactMatchPinningEnabled: boolean;
        exactMatchPinningApplied: boolean;
        candidatesIn: number;
        candidatesReranked: number;
        errorCode?: "RERANKER_FAILED";
        failurePhase?: "api_call" | "parse_results";
        topK: number;
        rankK: number;
        weight: number;
        docMaxLines: number;
        docMaxChars: number;
    };
}

export interface SearchResponseHints extends Record<string, unknown> {
    version?: 1;
    navigation?: SearchNavigationHint;
    noiseMitigation?: SearchNoiseMitigationHint;
    debugSearch?: SearchDebugHint;
    verification?: {
        generatedArtifacts?: {
            reason: "generated_outputs_present";
            message: string;
            files: string[];
            nextSteps: SearchNavigationFallbackReadSpan[];
        };
    };
}

export type VectorBackendResponseCode =
    | "ZILLIZ_CLUSTER_STOPPED"
    | "VECTOR_BACKEND_AUTH_FAILED"
    | "VECTOR_BACKEND_UNREACHABLE"
    | "VECTOR_BACKEND_TIMEOUT"
    | "VECTOR_BACKEND_CONNECTION_CLOSED";

export type NonOkReason =
    | "indexing"
    | "requires_reindex"
    | "not_indexed"
    | "missing_provider_config"
    | "vector_backend_unavailable";

interface SearchBaseResponseEnvelope {
    status: "ok" | "requires_reindex" | "not_indexed" | "not_ready";
    reason?: NonOkReason;
    code?: "MISSING_PROVIDER_CONFIG" | VectorBackendResponseCode;
    path: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    limit: number;
    freshnessDecision: FreshnessDecision | { mode: "skipped_requires_reindex" | "skipped_indexing" } | null;
    freshnessSummary?: SearchFreshnessSummary;
    warnings?: string[];
    message?: string;
    hints?: SearchResponseHints;
    compatibility?: FingerprintCompatibilityDiagnostics;
}

export interface SearchGroupedResponseEnvelope extends SearchBaseResponseEnvelope {
    resultMode: "grouped";
    results: SearchGroupResult[];
}

export interface SearchRawResponseEnvelope extends SearchBaseResponseEnvelope {
    resultMode: "raw";
    results: SearchChunkResult[];
}

export type SearchResponseEnvelope = SearchGroupedResponseEnvelope | SearchRawResponseEnvelope;

export interface SearchRequestInput {
    path: string;
    query: string;
    scope: SearchScope;
    resultMode: SearchResultMode;
    groupBy: SearchGroupBy;
    rankingMode: SearchRankingMode;
    limit: number;
    debug?: boolean;
}

export interface FileOutlineInput {
    path: string;
    file: string;
    start_line?: number;
    end_line?: number;
    limitSymbols?: number;
    resolveMode?: "outline" | "exact";
    symbolIdExact?: string;
    symbolLabelExact?: string;
}

export type FileOutlineStatus = "ok" | "not_found" | "requires_reindex" | "not_indexed" | "not_ready" | "unsupported" | "ambiguous";

export interface FileOutlineSymbolResult {
    symbolId: string;
    symbolLabel: string;
    span: SearchSpan;
    callGraphHint: Extract<CallGraphHint, { supported: true }>;
}

export interface FileOutlineResponseEnvelope {
    status: FileOutlineStatus;
    reason?: NonOkReason;
    path: string;
    file: string;
    outline: { symbols: FileOutlineSymbolResult[] } | null;
    hasMore: boolean;
    warnings?: string[];
    message?: string;
    hints?: Record<string, unknown>;
}
