import {
    ContextMcpConfig,
    resolveRerankerProvider,
} from "../config.js";
import {
    SEARCH_MAX_FROZEN_RESULTS,
    SEARCH_MAX_LOGICAL_RESULTS,
    SEARCH_MAX_PAGE_SIZE,
} from "./search-constants.js";

export type EmbeddingLocality = 'local' | 'cloud';
export type PerformanceProfile = 'fast' | 'standard' | 'slow';

export interface CapabilityMatrix {
    hasVectorStore: boolean;
    hasReranker: boolean;
    embeddingLocality: EmbeddingLocality;
    performanceProfile: PerformanceProfile;
    defaultSearchLimit: number;
    maxSearchLimit: number;
    maxSearchResultTotal: number;
    maxFrozenSearchResults: number;
    maxSearchPageSize: number;
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
        const embeddingLocality: EmbeddingLocality = (
            this.config.encoderProvider === 'Ollama'
            || this.config.encoderProvider === 'Potion'
        ) ? 'local' : 'cloud';

        let performanceProfile: PerformanceProfile;
        if (embeddingLocality === 'local') {
            performanceProfile = 'slow';
        } else if (this.config.encoderProvider === 'VoyageAI' || this.config.encoderProvider === 'OpenAI') {
            performanceProfile = 'fast';
        } else {
            performanceProfile = 'standard';
        }

        const hasVectorStore = this.config.vectorStoreProvider === 'LanceDB'
            ? Boolean(this.config.lanceDbPath)
            : Boolean(this.config.milvusEndpoint);
        const rerankerProvider = resolveRerankerProvider(this.config);
        // Under local-only, config resolves Voyage only after explicit selection.
        const hasReranker = rerankerProvider === 'lateon'
            ? Boolean(this.config.lateOnModelPath)
            : rerankerProvider === 'voyage'
                && Boolean(this.config.voyageKey);

        const defaultSearchLimit = performanceProfile === 'slow' ? 10 : 20;

        const defaultRerankEnabled = hasReranker
            && (rerankerProvider === 'lateon' || performanceProfile !== 'slow');

        return {
            hasVectorStore,
            hasReranker,
            embeddingLocality,
            performanceProfile,
            defaultSearchLimit,
            maxSearchLimit: SEARCH_MAX_LOGICAL_RESULTS,
            maxSearchResultTotal: SEARCH_MAX_LOGICAL_RESULTS,
            maxFrozenSearchResults: SEARCH_MAX_FROZEN_RESULTS,
            maxSearchPageSize: SEARCH_MAX_PAGE_SIZE,
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
        return this.getMaxSearchResultTotal();
    }

    public getMaxSearchResultTotal(): number {
        return this.matrix.maxSearchResultTotal;
    }

    public getMaxFrozenSearchResults(): number {
        return this.matrix.maxFrozenSearchResults;
    }

    public getMaxSearchPageSize(): number {
        return this.matrix.maxSearchPageSize;
    }

    public getDefaultRerankEnabled(): boolean {
        return this.matrix.defaultRerankEnabled;
    }
}
