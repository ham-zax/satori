/**
 * VoyageAI Reranker
 * 
 * Reranks search results using VoyageAI's neural reranker models.
 * Supports rerank-2.5 (best quality) and rerank-2.5-lite (faster).
 */

export type VoyageRerankerModel = 'rerank-2.5' | 'rerank-2.5-lite' | 'rerank-2' | 'rerank-2-lite';

export interface VoyageAIRerankerConfig {
    apiKey: string;
    model?: VoyageRerankerModel;
}

export interface RerankResult {
    index: number;
    relevanceScore: number;
    document?: string;
}

export interface RerankOptions {
    topK?: number;
    returnDocuments?: boolean;
    truncation?: boolean;
}

export class VoyageAIReranker {
    private apiKey: string;
    private model: VoyageRerankerModel;
    private baseUrl = 'https://api.voyageai.com/v1';

    constructor(config: VoyageAIRerankerConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'rerank-2.5-lite';
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
        const { topK, returnDocuments = false, truncation = true } = options;

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

        try {
            const response = await fetch(`${this.baseUrl}/rerank`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VoyageAI Rerank API error (${response.status}): ${errorText}`);
            }

            const result = await response.json() as { data?: unknown };

            if (!result.data || !Array.isArray(result.data)) {
                throw new Error('VoyageAI Rerank API returned invalid response');
            }

            const rerankResults: RerankResult[] = result.data.map((item, responseIndex) => {
                if (!item || typeof item !== 'object') {
                    throw new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`);
                }

                const row = item as Record<string, unknown>;
                if (!Number.isInteger(row.index) || (row.index as number) < 0 || (row.index as number) >= documents.length) {
                    throw new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`);
                }
                if (typeof row.relevance_score !== 'number' || !Number.isFinite(row.relevance_score)) {
                    throw new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`);
                }

                const mapped: RerankResult = {
                    index: row.index as number,
                    relevanceScore: row.relevance_score,
                };
                if (returnDocuments && Object.prototype.hasOwnProperty.call(row, 'document')) {
                    if (typeof row.document !== 'string') {
                        throw new Error(`VoyageAI Rerank API returned invalid response row at index ${responseIndex}`);
                    }
                    mapped.document = row.document;
                }
                return mapped;
            });

            console.log(`[VoyageAI Reranker] ✅ Reranked ${rerankResults.length} results. Top score: ${rerankResults[0]?.relevanceScore?.toFixed(4) || 'N/A'}`);

            return rerankResults;
        } catch (error) {
            console.error('[VoyageAI Reranker] ❌ Error:', error);
            throw error;
        }
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
     * Get supported models with their specifications
     */
    static getSupportedModels(): Record<VoyageRerankerModel, { maxQueryTokens: number; maxDocQueryTokens: number; description: string }> {
        return {
            'rerank-2.5': {
                maxQueryTokens: 8000,
                maxDocQueryTokens: 32000,
                description: 'Best quality reranker'
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
