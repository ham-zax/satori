import { FreshnessDecision } from "./sync.js";
import { SearchGroupBy, SearchResultMode, SearchScope } from "./search-constants.js";

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
    };
}

interface SearchBaseResponseEnvelope {
    status: "ok" | "requires_reindex" | "not_indexed";
    path: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    limit: number;
    freshnessDecision: FreshnessDecision | { mode: "skipped_requires_reindex" } | null;
    message?: string;
    hints?: Record<string, unknown>;
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
    limit: number;
    debug?: boolean;
}
