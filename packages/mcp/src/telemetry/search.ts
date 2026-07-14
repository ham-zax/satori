export interface SearchTelemetryEvent {
    event: 'search_executed';
    tool_name: 'search_codebase';
    profile: string;
    query_length: number;
    limit_requested: number;
    results_before_filter: number;
    results_after_filter: number;
    results_returned: number;
    excluded_by_ignore: number;
    reranker_attempted?: boolean;
    reranker_used: boolean;
    latency_ms: number;
    freshness_mode?: string;
    search_pass_count?: number;
    search_pass_success_count?: number;
    search_pass_failure_count?: number;
    route?: string;
    retrieval_mode?: string;
    semantic_search_attempts?: number;
    embedding_calls_by_current_contract?: number;
    dense_queries_by_current_contract?: number;
    sparse_queries_by_current_contract?: number;
    reranker_calls?: number;
    reranker_candidates?: number;
    reranker_input_bytes?: number;
    candidates_with_semantic_evidence?: number;
    candidates_with_lexical_evidence?: number;
    candidates_with_current_source_evidence?: number;
    semantic_expansion_attempted?: boolean;
    semantic_expansion_reason?: string;
    response_bytes?: number;
    error?: string;
}

export function emitSearchTelemetry(event: SearchTelemetryEvent): void {
    process.stderr.write(`[TELEMETRY] ${JSON.stringify(event)}\n`);
}
