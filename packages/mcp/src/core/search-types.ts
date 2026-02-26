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
    | { supported: true; symbolRef: CallGraphSymbolRef }
    | { supported: false; reason: "missing_symbol" | "unsupported_language" };

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
        pathMultiplier: number;
        pathCategory: string;
        changedFilesMultiplier?: number;
        matchesMust?: boolean;
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
    preview: string;
    debug?: {
        representativeChunkCount: number;
        pathCategory: string;
        pathMultiplier: number;
        topChunkScore: number;
        changedFilesMultiplier?: number;
        matchesMust?: boolean;
    };
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

export interface SearchOperatorSummary {
    prefixBlockChars: number;
    lang: string[];
    path: string[];
    excludePath: string[];
    must: string[];
    exclude: string[];
}

export interface SearchDebugHint {
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
        available: boolean;
        changedCount: number;
        multiplier: number;
        boostedCandidates: number;
    };
}

export interface SearchResponseHints extends Record<string, unknown> {
    version?: 1;
    noiseMitigation?: SearchNoiseMitigationHint;
    debugSearch?: SearchDebugHint;
}

interface SearchBaseResponseEnvelope {
    status: "ok" | "requires_reindex" | "not_indexed";
    path: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    limit: number;
    freshnessDecision: FreshnessDecision | { mode: "skipped_requires_reindex" } | null;
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

export type FileOutlineStatus = "ok" | "not_found" | "requires_reindex" | "unsupported" | "ambiguous";

export interface FileOutlineSymbolResult {
    symbolId: string;
    symbolLabel: string;
    span: SearchSpan;
    callGraphHint: { supported: true; symbolRef: CallGraphSymbolRef };
}

export interface FileOutlineResponseEnvelope {
    status: FileOutlineStatus;
    path: string;
    file: string;
    outline: { symbols: FileOutlineSymbolResult[] } | null;
    hasMore: boolean;
    warnings?: string[];
    message?: string;
    hints?: Record<string, unknown>;
}
