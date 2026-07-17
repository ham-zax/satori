import type { BackendScoreKind, RetrievalMode, ScorePolicy, VectorFilter } from './vectordb/types';

export interface SearchQuery {
    term: string;
    includeContent?: boolean;
    limit?: number;
}

export interface SemanticSearchRequest {
    codebasePath: string;
    query: string;
    topK?: number;
    retrievalMode?: RetrievalMode;
    filter?: VectorFilter;
    scorePolicy?: ScorePolicy;
}

export interface SemanticSearchResult {
    /** Persisted vector-document identity when the result came from storage. */
    candidateId?: string;
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    startByte?: number;
    endByte?: number;
    language: string;
    score: number;
    breadcrumbs?: string[];
    indexedAt?: string;
    symbolId?: string;
    symbolLabel?: string;
    symbolKind?: string;
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    backendScore?: number;
    backendScoreKind?: BackendScoreKind;
}

export type SemanticSearchCandidateTraceStageName =
    | 'raw_dense'
    | 'raw_lexical'
    | 'raw_lexical_fallback'
    | 'core_fusion'
    | 'core_result';

export interface SemanticSearchCandidateTraceOccurrence {
    candidateId: string;
    ownerId: string;
    evidenceOccurrenceId: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    rank: number;
    score: number;
}

export interface SemanticSearchCandidateTraceStage {
    stage: SemanticSearchCandidateTraceStageName;
    totalOccurrences: number;
    uniqueCandidates: number;
    omittedOccurrences: number;
    candidates: SemanticSearchCandidateTraceOccurrence[];
}

export interface SemanticSearchCandidateTraceRemoval {
    candidateId: string;
    afterStage: 'core_fusion';
    reason: 'core_fusion_limit';
}

export interface SemanticSearchCandidateTrace {
    schemaVersion: 'semantic_search_candidate_trace_v1';
    maxEntriesPerStage: number;
    /** Product candidate depth used by this exact Core retrieval pass. */
    productCandidateLimit: number;
    queryEmbeddingSha256: string | null;
    lexicalRequests: Array<{
        role: 'primary' | 'fallback_or';
        querySha256: string;
        matchMode: 'all_terms' | 'any_terms' | 'provider_sparse' | 'unspecified';
        terms?: string[];
    }>;
    stages: SemanticSearchCandidateTraceStage[];
    removals: SemanticSearchCandidateTraceRemoval[];
    omittedRemovals: number;
}

export interface SemanticSearchCandidateTraceOptions {
    /** Capture a backend-supported OR lexical arm without admitting it to results. */
    captureLexicalFallback?: boolean;
    /** Retrieve a larger trace-only arm while preserving the request's product topK. */
    diagnosticCandidateLimit?: number;
    /** Frozen high-signal terms for the trace-only OR query. */
    lexicalFallbackTerms?: string[];
}

export interface SemanticSearchExecutionResult {
    results: SemanticSearchResult[];
    candidateTrace: SemanticSearchCandidateTrace;
    /** Source-bearing raw arms for in-process diagnostic scoring; never serialize this field. */
    diagnosticCandidateArms?: {
        dense?: SemanticSearchResult[];
        preciseLexical?: SemanticSearchResult[];
        fallbackLexical?: SemanticSearchResult[];
    };
}
