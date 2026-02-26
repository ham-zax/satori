import { ContextMcpConfig } from "../config.js";

export type EmbeddingLocality = 'local' | 'cloud';
export type PerformanceProfile = 'fast' | 'standard' | 'slow';

export interface CapabilityMatrix {
    hasVectorStore: boolean;
    hasReranker: boolean;
    embeddingLocality: EmbeddingLocality;
    performanceProfile: PerformanceProfile;
    defaultSearchLimit: number;
    maxSearchLimit: number;
    defaultRerankEnabled: boolean;
}

export class CapabilityResolver {
    private readonly config: ContextMcpConfig;
    private readonly matrix: CapabilityMatrix;

    constructor(config: ContextMcpConfig) {
        this.config = config;
        this.matrix = this.buildMatrix();
    }

    private buildMatrix(): CapabilityMatrix {
        const embeddingLocality: EmbeddingLocality = this.config.encoderProvider === 'Ollama' ? 'local' : 'cloud';

        let performanceProfile: PerformanceProfile;
        if (embeddingLocality === 'local') {
            performanceProfile = 'slow';
        } else if (this.config.encoderProvider === 'VoyageAI' || this.config.encoderProvider === 'OpenAI') {
            performanceProfile = 'fast';
        } else {
            performanceProfile = 'standard';
        }

        const hasVectorStore = Boolean(this.config.milvusEndpoint || this.config.milvusApiToken);
        const hasReranker = Boolean(this.config.voyageKey);

        const defaultSearchLimit =
            performanceProfile === 'fast' ? 50 :
                performanceProfile === 'standard' ? 25 :
                    10;

        const maxSearchLimit =
            performanceProfile === 'fast' ? 50 :
                performanceProfile === 'standard' ? 30 :
                    15;

        const defaultRerankEnabled = hasReranker && performanceProfile !== 'slow';

        return {
            hasVectorStore,
            hasReranker,
            embeddingLocality,
            performanceProfile,
            defaultSearchLimit,
            maxSearchLimit,
            defaultRerankEnabled
        };
    }

    public getMatrix(): CapabilityMatrix {
        return { ...this.matrix };
    }

    public hasVectorStore(): boolean {
        return this.matrix.hasVectorStore;
    }

    public hasReranker(): boolean {
        return this.matrix.hasReranker;
    }

    public getEmbeddingLocality(): EmbeddingLocality {
        return this.matrix.embeddingLocality;
    }

    public getPerformanceProfile(): PerformanceProfile {
        return this.matrix.performanceProfile;
    }

    public getDefaultSearchLimit(): number {
        return this.matrix.defaultSearchLimit;
    }

    public getMaxSearchLimit(): number {
        return this.matrix.maxSearchLimit;
    }

    public getDefaultRerankEnabled(): boolean {
        return this.matrix.defaultRerankEnabled;
    }
}
