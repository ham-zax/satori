import {
    VoyageAIClient,
    VoyageAIError,
    VoyageAITimeoutError,
} from 'voyageai';
import {
    Embedding,
    type EmbeddingBatchPolicy,
    type EmbeddingIdentity,
    type EmbeddingOperationMetricsSnapshot,
    type EmbeddingVector,
} from './base-embedding';

const VOYAGE_CODE_3_MAX_BATCH_ITEMS = 1_000;
const VOYAGE_CODE_3_HARD_BATCH_TOKENS = 120_000;
const VOYAGE_CODE_3_TARGET_ESTIMATED_TOKENS = 100_000;
const VOYAGE_INDEXING_REQUEST_TIMEOUT_SECONDS = 180;
const VOYAGE_REQUEST_MAX_ATTEMPTS = 3;
const VOYAGE_RETRY_BASE_DELAY_MS = 1_000;

function isRetryableVoyageError(error: unknown): boolean {
    if (error instanceof VoyageAITimeoutError) return true;
    if (error instanceof VoyageAIError) {
        const statusCode = error.statusCode;
        if (statusCode === 408 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
            return true;
        }
    }
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNRESET|ETIMEDOUT|fetch failed|network|socket|connection/i.test(message);
}

function isExplicitVoyageBatchLimitError(error: unknown): boolean {
    if (error instanceof VoyageAIError) {
        if (![400, 413, 422].includes(error.statusCode ?? 0)) return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /too many|maximum.*(?:input|text|token)|token.*limit|input.*limit|request.*large/i.test(message);
}

export type VoyageOutputDimension = 256 | 512 | 1024 | 2048;
export type VoyageOutputDtype = 'float' | 'int8' | 'uint8' | 'binary' | 'ubinary';
type VoyageInputType = 'document' | 'query';

export interface VoyageAIEmbeddingConfig {
    model: string;
    apiKey: string;
    outputDimension?: VoyageOutputDimension;
    outputDtype?: VoyageOutputDtype;
}

export class VoyageAIEmbedding extends Embedding {
    private client: VoyageAIClient;
    private config: VoyageAIEmbeddingConfig;
    private dimension: number = 1024; // Default dimension for voyage-4 series
    protected maxTokens: number = 32000; // Default max tokens
    private operationMetrics: EmbeddingOperationMetricsSnapshot = {
        providerRequestCount: 0,
        retryCount: 0,
        submittedItems: 0,
        submittedBytes: 0,
        providerTokens: 0,
        durationMs: 0,
    };

    constructor(config: VoyageAIEmbeddingConfig) {
        super();
        this.config = config;
        this.client = new VoyageAIClient({
            apiKey: config.apiKey,
        });

        // Set dimension and context length based on different models
        this.updateModelSettings(config.model || 'voyage-4');

        // Override dimension if outputDimension is specified
        if (config.outputDimension) {
            this.dimension = config.outputDimension;
            console.log(`[VoyageAI] Using custom output dimension: ${config.outputDimension}`);
        }
    }

    private updateModelSettings(model: string): void {
        const supportedModels = VoyageAIEmbedding.getSupportedModels();
        const modelInfo = supportedModels[model];

        if (modelInfo) {
            // If dimension is a string (indicating variable dimension), use default value 1024
            if (typeof modelInfo.dimension === 'string') {
                this.dimension = 1024; // Default dimension
            } else {
                this.dimension = modelInfo.dimension;
            }
            // Set max tokens based on model's context length
            this.maxTokens = modelInfo.contextLength;
        } else {
            // Use default dimension and context length for unknown models
            this.dimension = 1024;
            this.maxTokens = 32000;
        }
    }

    private updateDimensionForModel(model: string): void {
        const supportedModels = VoyageAIEmbedding.getSupportedModels();
        const modelInfo = supportedModels[model];

        if (modelInfo) {
            // If dimension is a string (indicating variable dimension), use default value 1024
            if (typeof modelInfo.dimension === 'string') {
                this.dimension = 1024; // Default dimension
            } else {
                this.dimension = modelInfo.dimension;
            }
        } else {
            // Use default dimension for unknown models
            this.dimension = 1024;
        }
    }

    async detectDimension(): Promise<number> {
        // VoyageAI doesn't need dynamic detection, return configured dimension
        return this.dimension;
    }

    async embedQuery(text: string): Promise<EmbeddingVector> {
        const [embedding] = await this.embedTexts([text], 'query');
        if (!embedding) {
            throw new Error('VoyageAI API returned invalid response');
        }
        return embedding;
    }

    async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
        return this.embedTexts(texts, 'document');
    }

    private async embedTexts(texts: string[], inputType: VoyageInputType): Promise<EmbeddingVector[]> {
        const processedTexts = this.preprocessTexts(texts);
        if (processedTexts.length === 0) return [];

        const policy = this.getBatchPolicy();
        if (policy && processedTexts.length > policy.hardMaxItems) {
            const embeddings: EmbeddingVector[] = [];
            for (let offset = 0; offset < processedTexts.length; offset += policy.hardMaxItems) {
                embeddings.push(...await this.embedProcessedBatch(
                    processedTexts.slice(offset, offset + policy.hardMaxItems),
                    inputType,
                ));
            }
            return embeddings;
        }

        return this.embedProcessedBatch(processedTexts, inputType);
    }

    private async embedProcessedBatch(
        processedTexts: string[],
        inputType: VoyageInputType,
    ): Promise<EmbeddingVector[]> {
        try {
            const response = await this.requestEmbeddingBatch(processedTexts, inputType);

            if (!response.data || response.data.length !== processedTexts.length) {
                throw new Error(
                    `VoyageAI API returned ${response.data?.length ?? 'no'} embeddings for ${processedTexts.length} inputs`,
                );
            }

            return response.data.map((item) => {
                if (!item.embedding) {
                    throw new Error('VoyageAI API returned invalid embedding data');
                }
                return {
                    vector: item.embedding,
                    dimension: this.dimension,
                };
            });
        } catch (error) {
            if (!isExplicitVoyageBatchLimitError(error) || processedTexts.length <= 1) {
                throw error;
            }

            // A provider tokenizer or model limit can drift independently of our
            // estimate. Split in stable input order instead of enabling silent
            // truncation and weakening the resulting index.
            const midpoint = Math.ceil(processedTexts.length / 2);
            const left = await this.embedProcessedBatch(processedTexts.slice(0, midpoint), inputType);
            const right = await this.embedProcessedBatch(processedTexts.slice(midpoint), inputType);
            return [...left, ...right];
        }
    }

    private async requestEmbeddingBatch(processedTexts: string[], inputType: VoyageInputType) {
        const model = this.config.model || 'voyage-4';
        const submittedBytes = processedTexts.reduce(
            (total, text) => total + Buffer.byteLength(text, 'utf8'),
            0,
        );
        let lastError: unknown;

        for (let attempt = 1; attempt <= VOYAGE_REQUEST_MAX_ATTEMPTS; attempt += 1) {
            const startedAt = Date.now();
            this.operationMetrics = {
                ...this.operationMetrics,
                providerRequestCount: this.operationMetrics.providerRequestCount + 1,
                submittedItems: this.operationMetrics.submittedItems + processedTexts.length,
                submittedBytes: this.operationMetrics.submittedBytes + submittedBytes,
            };
            try {
                // Disable SDK retries so every provider attempt is visible in
                // operation metrics. Application retries below preserve the same
                // bounded retry count while making timeout and cost evidence exact.
                const response = await this.client.embed({
                    input: processedTexts,
                    model,
                    inputType,
                    truncation: false,
                    ...(this.config.outputDimension && { outputDimension: this.config.outputDimension }),
                    ...(this.config.outputDtype && { outputDtype: this.config.outputDtype }),
                }, {
                    timeoutInSeconds: VOYAGE_INDEXING_REQUEST_TIMEOUT_SECONDS,
                    maxRetries: 0,
                });
                this.operationMetrics = {
                    ...this.operationMetrics,
                    providerTokens: this.operationMetrics.providerTokens + (response.usage?.totalTokens ?? 0),
                };
                return response;
            } catch (error) {
                lastError = error;
                if (!isRetryableVoyageError(error) || attempt === VOYAGE_REQUEST_MAX_ATTEMPTS) {
                    throw error;
                }
                this.operationMetrics = {
                    ...this.operationMetrics,
                    retryCount: this.operationMetrics.retryCount + 1,
                };
                console.warn(`[VoyageAI] Retrying embedding request (${attempt}/${VOYAGE_REQUEST_MAX_ATTEMPTS - 1}).`);
                await this.waitBeforeRetry(attempt);
            } finally {
                this.operationMetrics = {
                    ...this.operationMetrics,
                    durationMs: this.operationMetrics.durationMs + (Date.now() - startedAt),
                };
            }
        }

        throw lastError;
    }

    protected async waitBeforeRetry(attempt: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, VOYAGE_RETRY_BASE_DELAY_MS * attempt));
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return 'VoyageAI';
    }

    override getIdentity(): Readonly<EmbeddingIdentity> {
        return this.buildIdentity(this.config.model);
    }

    getBatchPolicy(): EmbeddingBatchPolicy | null {
        if ((this.config.model || 'voyage-4') !== 'voyage-code-3') return null;
        return {
            preferredMaxItems: VOYAGE_CODE_3_MAX_BATCH_ITEMS,
            hardMaxItems: VOYAGE_CODE_3_MAX_BATCH_ITEMS,
            targetEstimatedTokens: VOYAGE_CODE_3_TARGET_ESTIMATED_TOKENS,
            hardTokenLimit: VOYAGE_CODE_3_HARD_BATCH_TOKENS,
        };
    }

    getOperationMetricsSnapshot(): EmbeddingOperationMetricsSnapshot {
        return { ...this.operationMetrics };
    }

    /**
     * Set model type
     * @param model Model name
     */
    setModel(model: string): void {
        this.config.model = model;
        this.updateModelSettings(model);
    }

    /**
     * Get client instance (for advanced usage)
     */
    getClient(): VoyageAIClient {
        return this.client;
    }

    /**
     * Get list of supported models
     */
    static getSupportedModels(): Record<string, { dimension: number | string; contextLength: number; description: string; maxBatchTokens?: number }> {
        return {
            // Voyage 4 series - Latest recommended models
            'voyage-4-large': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                maxBatchTokens: 120000,
                description: 'Best quality for general-purpose embedding (recommended)'
            },
            'voyage-4': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                maxBatchTokens: 320000,
                description: 'Balance between quality and cost (recommended)'
            },
            'voyage-4-lite': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                maxBatchTokens: 1000000,
                description: 'Lowest latency and cost (recommended)'
            },
            // Voyage 3 series
            'voyage-3-large': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                maxBatchTokens: 120000,
                description: 'Best general-purpose and multilingual retrieval quality'
            },
            'voyage-3.5': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                maxBatchTokens: 320000,
                description: 'Optimized for general-purpose and multilingual retrieval'
            },
            'voyage-3.5-lite': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                maxBatchTokens: 1000000,
                description: 'Optimized for latency and cost'
            },
            // Code-specific model
            'voyage-code-3': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                maxBatchTokens: 120000,
                description: 'Optimized for code retrieval and programming documentation (recommended for code)'
            },
            // Domain-specific models
            'voyage-finance-2': {
                dimension: 1024,
                contextLength: 32000,
                maxBatchTokens: 120000,
                description: 'Optimized for finance retrieval and RAG'
            },
            'voyage-law-2': {
                dimension: 1024,
                contextLength: 16000,
                maxBatchTokens: 120000,
                description: 'Optimized for legal retrieval and RAG'
            },
            // Contextualized embeddings
            'voyage-context-3': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Contextualized chunk embeddings for improved retrieval'
            },
            // Legacy models
            'voyage-multilingual-2': {
                dimension: 1024,
                contextLength: 32000,
                description: 'Legacy: Use voyage-4 or voyage-3.5 for multilingual tasks'
            },
            'voyage-large-2-instruct': {
                dimension: 1024,
                contextLength: 16000,
                description: 'Legacy: Use voyage-4 instead'
            },
            'voyage-large-2': {
                dimension: 1536,
                contextLength: 16000,
                description: 'Legacy: Use voyage-4 instead'
            },
            'voyage-code-2': {
                dimension: 1536,
                contextLength: 16000,
                description: 'Legacy: Use voyage-code-3 instead'
            },
            'voyage-3': {
                dimension: 1024,
                contextLength: 32000,
                description: 'Legacy: Use voyage-4 instead'
            },
            'voyage-3-lite': {
                dimension: 512,
                contextLength: 32000,
                description: 'Legacy: Use voyage-4-lite instead'
            },
            'voyage-2': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy: Use voyage-4-lite instead'
            },
            // Other legacy models
            'voyage-02': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-01': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-lite-01': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-lite-01-instruct': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-lite-02-instruct': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            }
        };
    }
}
