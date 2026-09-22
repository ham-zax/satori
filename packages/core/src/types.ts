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
    /**
     * Standardized lexical matching mode for the primary lexical retrieval.
     * Backends must reject unsupported requested modes with
     * `LexicalRetrievalModeUnsupportedError` rather than silently using
     * provider-defined sparse semantics.
     */
    lexicalMatchMode?: "all_terms" | "any_terms";
    /**
     * Canonical high-signal terms for a bounded any-terms fallback. The fallback
     * is eligible only when the primary standardized all-terms lexical arm is empty.
     * Hybrid retrieval uses it to enrich dense-discovered files; it broadens file
     * discovery only when the dense arm itself is empty.
     */
    lexicalFallbackTerms?: string[];
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
    /** Query-focused evidence from another chunk owned by the same symbol. */
    evidenceContent?: string;
    evidenceStartLine?: number;
    evidenceEndLine?: number;
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
    | 'diagnostic_dense'
    | 'diagnostic_lexical'
    | 'diagnostic_fallback_lexical'
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
    afterStage: 'raw_lexical_fallback' | 'core_fusion';
    reason: 'core_fusion_limit' | 'dense_path_filter';
}

export type SemanticSearchDiagnosticRetrievalArm =
    | 'dense'
    | 'precise_lexical'
    | 'fallback_lexical';

export interface SemanticSearchDiagnosticRetrieval {
    arm: SemanticSearchDiagnosticRetrievalArm;
    requestedLimit: number;
    status: 'available' | 'unavailable';
    failureReason?: 'backend_request_failed';
}

/**
 * Candidate-trace v1 is an additive diagnostic envelope. Existing product
 * stages and removal meanings remain stable; bounded diagnostic fields/stages
 * may be added without a version bump. Consumers of serialized diagnostics
 * must ignore unknown additive fields and tolerate unknown future
 * diagnostic-only stage values. A breaking or reinterpretive change requires
 * a new schemaVersion.
 */
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
    /** Bounded status for additional trace-only backend requests; absence means not requested. */
    diagnosticRetrievals?: SemanticSearchDiagnosticRetrieval[];
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
