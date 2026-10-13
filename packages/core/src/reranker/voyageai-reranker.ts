/**
 * VoyageAI Reranker
 * 
 * Reranks search results using VoyageAI's neural reranker models.
 * The model name is sent to Voyage as typed; Voyage decides whether it is
 * accepted. getSupportedModels lists the documented models and their limits.
 */

import type {
    Reranker,
    RerankerIdentity,
    RerankOptions,
    RerankResult,
} from "./reranker";

// Any model name is accepted here; Voyage's rejection message is the authority.
export type VoyageRerankerModel = string;

// Used when no model is named. The CLI keeps its own copy (it does not depend on core); keep them equal.
export const DEFAULT_VOYAGE_RERANKER_MODEL = 'rerank-3-lite';

export const RERANK_TIMEOUT_MS = 30_000;
export const RERANK_MAX_ATTEMPTS = 2;
export const RERANK_RETRY_DELAY_MS = 250;

/**
 * Bounded failure classification for VoyageAI rerank requests.
 * `timeout` covers a single attempt exceeding the attempt timeout;
 * `transient_http` covers 408/425/429/5xx; `permanent_http` covers other
 * HTTP statuses; `network` covers transport failures (only
 * ETIMEDOUT/ECONNRESET/EAI_AGAIN are retried); `invalid_response` covers
 * well-formed HTTP with an invalid body. Caller cancellation is never
 * wrapped and never retried.
 */
export type RerankerFailureKind =
    | "timeout"
    | "transient_http"
    | "permanent_http"
    | "network"
    | "invalid_response";

export class RerankerRequestError extends Error {
    readonly kind: RerankerFailureKind;
    readonly status: number | null;
    readonly attempts: number;

    constructor(kind: RerankerFailureKind, status: number | null, attempts: number, message: string) {
        super(message);
        this.name = "RerankerRequestError";
        this.kind = kind;
        this.status = status;
        this.attempts = attempts;
    }
}

const RETRYABLE_NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]);

interface RerankerFailureClassification {
    kind: RerankerFailureKind;
    retryable: boolean;
}

function errorCode(error: unknown): string | undefined {
    const direct = error as { code?: unknown; cause?: unknown } | undefined;
    if (typeof direct?.code === "string") {
        return direct.code;
    }
    const cause = direct?.cause as { code?: unknown } | undefined;
    return typeof cause?.code === "string" ? cause.code : undefined;
}

function isAbortLikeError(error: unknown): boolean {
    const direct = error as { name?: unknown; cause?: unknown } | undefined;
    const name = typeof direct?.name === "string" ? direct.name : undefined;
    if (name === "AbortError" || name === "TimeoutError") {
        return true;
    }
    const cause = direct?.cause as { name?: unknown } | undefined;
    return typeof cause?.name === "string"
        && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

function classifyRerankerFailure(
    error: unknown,
    timedOut: boolean,
    status: number | null,
): RerankerFailureClassification {
    if (timedOut) {
        return { kind: "timeout", retryable: true };
    }
    if (status !== null) {
        if (status === 408 || status === 425 || status === 429 || status >= 500) {
            return { kind: "transient_http", retryable: true };
        }
        return { kind: "permanent_http", retryable: false };
    }
    const code = errorCode(error);
    if (code !== undefined && RETRYABLE_NETWORK_CODES.has(code)) {
        return { kind: "network", retryable: true };
    }
    return { kind: "network", retryable: false };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface VoyageAIRerankerConfig {
    apiKey: string;
    model?: VoyageRerankerModel;
    /** Per-attempt timeout in milliseconds (default RERANK_TIMEOUT_MS). */
    timeoutMs?: number;
    /** Delay between retry attempts (default RERANK_RETRY_DELAY_MS). */
    retryDelayMs?: number;
}

export class VoyageAIReranker implements Reranker {
    private apiKey: string;
    private model: VoyageRerankerModel;
    private baseUrl = 'https://api.voyageai.com/v1';
    private timeoutMs: number;
    private retryDelayMs: number;

    constructor(config: VoyageAIRerankerConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model || DEFAULT_VOYAGE_RERANKER_MODEL;
        this.timeoutMs = Number.isFinite(config.timeoutMs) && (config.timeoutMs as number) > 0
            ? config.timeoutMs as number
            : RERANK_TIMEOUT_MS;
        this.retryDelayMs = Number.isFinite(config.retryDelayMs) && (config.retryDelayMs as number) >= 0
            ? config.retryDelayMs as number
            : RERANK_RETRY_DELAY_MS;
    }

    getIdentity(): Readonly<RerankerIdentity> {
        return Object.freeze({
            provider: 'voyage',
            model: this.model,
            profile: 'voyage_reranker_api_v1',
        });
    }

    /**
     * Rerank documents based on relevance to a query
     * @param query The search query
     * @param documents Array of document texts to rerank
     * @param options Reranking options
     * @returns Array of reranked results sorted by relevance score (descending)
     */
    async rerank(
        query: string,
        documents: string[],
        options: RerankOptions = {}
    ): Promise<RerankResult[]> {
        const { topK, returnDocuments = false, truncation = true, signal } = options;

        if (!documents || documents.length === 0) {
            return [];
        }

        if (!query || query.trim().length === 0) {
            throw new Error('Query cannot be empty');
        }

        console.log(`[VoyageAI Reranker] Reranking ${documents.length} documents with model: ${this.model}`);

        const requestBody: Record<string, unknown> = {
            query,
            documents,
            model: this.model,
            return_documents: returnDocuments,
            truncation,
        };

        if (topK !== undefined && topK > 0) {
            requestBody.top_k = topK;
        }

        let timeoutEvents = 0;
        const reportDiagnostics = (attempts: number): void => {
            try {
                options.onExecutionDiagnostics?.({
                    attempts,
                    retries: Math.max(0, attempts - 1),
                    timeouts: timeoutEvents,
                });
            } catch {
                // Diagnostics are observational only: a throwing telemetry
                // callback must never turn a successful rerank into a failure
                // or replace the real terminal error classification.
            }
        };

        for (let attempt = 1; attempt <= RERANK_MAX_ATTEMPTS; attempt += 1) {
            if (signal?.aborted) {
                throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
            }

            const attemptSignal = signal
                ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
                : AbortSignal.timeout(this.timeoutMs);
            try {
                // The whole attempt -- headers, body consumption and response
                // validation -- sits inside the timeout-aware boundary so a
                // stall after the headers still classifies as a timeout.
                const response = await fetch(`${this.baseUrl}/rerank`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody),
                    signal: attemptSignal,
                });

                if (!response.ok) {
                    const status = response.status;
                    let errorText = '';
                    try {
                        errorText = await response.text();
                    } catch (error) {
                        if (isAbortLikeError(error)) {
                            // A stalled error body is an attempt timeout, not
                            // an HTTP classification: let it flow into the
                            // timeout-aware classification boundary.
                            throw error;
                        }
                        // A non-timeout inability to read an HTTP error body
                        // may use an empty body.
                    }
                    throw Object.assign(
                        new Error(`VoyageAI Rerank API error (${status}): ${errorText}`),
                        { rerankerHttpStatus: status },
                    );
                }

                const result = await response.json() as { data?: unknown };
                if (!result.data || !Array.isArray(result.data)) {
                    throw Object.assign(
                        new Error('VoyageAI Rerank API returned invalid response'),
                        { rerankerValidationFailure: true, rerankerHttpStatus: response.status },
                    );
                }

                const rerankResults: RerankResult[] = result.data.map((item, responseIndex) => {
                    if (!item || typeof item !== 'object') {
                        throw Object.assign(
                            new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`),
                            { rerankerValidationFailure: true },
                        );
                    }
                    const row = item as Record<string, unknown>;
                    if (!Number.isInteger(row.index) || (row.index as number) < 0 || (row.index as number) >= documents.length) {
                        throw Object.assign(
                            new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`),
                            { rerankerValidationFailure: true },
                        );
                    }
                    if (typeof row.relevance_score !== 'number' || !Number.isFinite(row.relevance_score)) {
                        throw Object.assign(
                            new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`),
                            { rerankerValidationFailure: true },
                        );
                    }
                    const mapped: RerankResult = {
                        index: row.index as number,
                        relevanceScore: row.relevance_score,
                    };
                    if (returnDocuments && Object.prototype.hasOwnProperty.call(row, 'document')) {
                        if (typeof row.document !== 'string') {
                            throw Object.assign(
                                new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`),
                                { rerankerValidationFailure: true },
                            );
                        }
                        mapped.document = row.document;
                    }
                    return mapped;
                });

                console.log(`[VoyageAI Reranker] ✅ Reranked ${rerankResults.length} results. Top score: ${rerankResults[0]?.relevanceScore?.toFixed(4) || 'N/A'}`);
                reportDiagnostics(attempt);
                return rerankResults;
            } catch (error) {
                if (signal?.aborted) {
                    // Caller cancellation is independent of the attempt timeout and is never retried.
                    throw signal.reason ?? error;
                }
                const timedOut = isAbortLikeError(error);
                if (timedOut) {
                    timeoutEvents += 1;
                }
                const httpStatus = (error as { rerankerHttpStatus?: number }).rerankerHttpStatus;
                const validationFailure = (error as { rerankerValidationFailure?: boolean }).rerankerValidationFailure;
                let classification: RerankerFailureClassification;
                if (validationFailure) {
                    // A well-formed HTTP response with an invalid body is never retried.
                    classification = { kind: 'invalid_response', retryable: false };
                } else if (httpStatus !== undefined) {
                    classification = classifyRerankerFailure(null, false, httpStatus);
                } else {
                    classification = classifyRerankerFailure(error, timedOut, null);
                }
                if (attempt < RERANK_MAX_ATTEMPTS && classification.retryable) {
                    await this.delayBeforeRetry(signal);
                    continue;
                }
                reportDiagnostics(attempt);
                throw new RerankerRequestError(
                    classification.kind,
                    httpStatus ?? null,
                    attempt,
                    `VoyageAI Rerank ${httpStatus !== undefined ? 'API' : 'request'} failed (${classification.kind}): ${errorMessage(error)}`,
                );
            }
        }

        throw new Error('Unreachable: rerank attempts loop exhausted without returning or throwing.');
    }

    private async delayBeforeRetry(signal?: AbortSignal): Promise<void> {
        if (this.retryDelayMs <= 0) {
            return;
        }
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
        }
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, this.retryDelayMs);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
            }, { once: true });
        });
    }

    /**
     * Get the current model
     */
    getModel(): VoyageRerankerModel {
        return this.model;
    }

    /**
     * Set the model
     */
    setModel(model: VoyageRerankerModel): void {
        this.model = model;
    }

    /**
     * Known limits and descriptions for the documented Voyage models. This is
     * not a list of accepted names: any model name is sent to Voyage.
     */
    static getSupportedModels(): Record<string, { maxQueryTokens: number; maxDocQueryTokens: number; description: string }> {
        return {
            'rerank-3': {
                maxQueryTokens: 8000,
                maxDocQueryTokens: 32000,
                description: 'Best quality reranker'
            },
            'rerank-3-lite': {
                maxQueryTokens: 8000,
                maxDocQueryTokens: 32000,
                description: 'Fast and cost-effective reranker'
            },
            'rerank-2.5': {
                maxQueryTokens: 8000,
                maxDocQueryTokens: 32000,
                description: 'Earlier best quality reranker'
            },
            'rerank-2.5-lite': {
                maxQueryTokens: 8000,
                maxDocQueryTokens: 32000,
                description: 'Fast and cost-effective reranker (recommended)'
            },
            'rerank-2': {
                maxQueryTokens: 4000,
                maxDocQueryTokens: 16000,
                description: 'Previous generation reranker'
            },
            'rerank-2-lite': {
                maxQueryTokens: 2000,
                maxDocQueryTokens: 8000,
                description: 'Previous generation lite reranker'
            }
        };
    }
}
