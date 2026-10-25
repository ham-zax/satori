export interface RerankResult {
    index: number;
    relevanceScore: number;
    document?: string;
}

export interface RerankerIdentity {
    provider: string;
    model: string;
    profile: string;
}

export interface RerankExecutionDiagnostics {
    attempts: number;
    retries: number;
    timeouts: number;
    /** Local-reranker only: milliseconds queued before execution started. */
    queueWaitMs?: number;
    /** Local-reranker only: effective scoring deadline applied to this execution. */
    effectiveScoreDeadlineMs?: number;
    /** Local-reranker only: reranker-stage budget remaining when execution started. */
    effectiveStageDeadlineMs?: number;
    /** Local-reranker only: wall time from execution start to terminal outcome. */
    observedWallMs?: number;
    /** Local-reranker only: max(0, observedWallMs - effective deadline) on execution timeout. */
    deadlineLatenessMs?: number;
    /**
     * Provider only: tokens the provider billed for this rerank() call, summed
     * over attempts. Absent when the provider reports no usage, which includes
     * the local profile and keeps its diagnostics shape unchanged.
     */
    providerTokens?: number;
}

export interface RerankOptions {
    topK?: number;
    returnDocuments?: boolean;
    truncation?: boolean;
    /**
     * Stable candidate identities used only for deterministic score ties.
     * Providers that already return a complete order may ignore this field.
     */
    identities?: readonly string[];
    /** Cancels queued or executing provider work. Providers must not return partial results. */
    signal?: AbortSignal;
    /**
     * Bounded execution telemetry reported once per rerank() call on
     * successful completion or terminal provider failure, so callers can
     * count retries that were hidden by a later successful attempt. Not
     * reported for caller cancellation, and must never throw: a throwing
     * callback is ignored so telemetry cannot alter ranking behavior.
     */
    onExecutionDiagnostics?: (diagnostics: RerankExecutionDiagnostics) => void;
}

export interface Reranker {
    getIdentity(): Readonly<RerankerIdentity>;
    rerank(
        query: string,
        documents: string[],
        options?: RerankOptions,
    ): Promise<RerankResult[]>;
    /**
     * Provider-qualified per-request candidate capacity. Search may routinely
     * admit up to this positive safe-integer number of input documents for
     * semantic evaluation. Undefined means that admission capacity is not
     * advertised. This is an input-admission capacity, not an output top-K.
     */
    getMaxDocuments?(): number | undefined;
    /** Identity-bearing document projection required by this provider profile. */
    getDocumentProjectionVersion?(): string | undefined;
    /** Identity-bearing query projection required by this provider profile. */
    getQueryProjectionVersion?(): string | undefined;
    close?(): Promise<void>;
}
