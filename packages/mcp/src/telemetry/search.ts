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
    reranker_used: boolean;
    latency_ms: number;
    freshness_mode?: string;
    error?: string;
}

export function emitSearchTelemetry(event: SearchTelemetryEvent): void {
    process.stderr.write(`[TELEMETRY] ${JSON.stringify(event)}\n`);
}
