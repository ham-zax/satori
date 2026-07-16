import { EMBEDDING_NORMALIZATION_POLICY_VERSION } from '../core/persisted-index-authority';

// Interface definitions
export interface EmbeddingVector {
    vector: number[];
    dimension: number;
}

export interface EmbeddingBatchPolicy {
    preferredMaxItems: number;
    hardMaxItems: number;
    targetEstimatedTokens?: number;
    hardTokenLimit?: number;
}

export interface EmbeddingOperationMetricsSnapshot {
    providerRequestCount: number;
    retryCount: number;
    submittedItems: number;
    submittedBytes: number;
    providerTokens: number;
    durationMs: number;
}

export interface EmbeddingIdentity {
    provider: string;
    model: string;
    dimension: number;
    artifactDigest: string | null;
    normalizationPolicy: string;
}

/**
 * Abstract base class for embedding implementations
 */
export abstract class Embedding {
    protected abstract maxTokens: number;

    /**
     * Preprocess text to ensure it's valid for embedding
     * @param text Input text
     * @returns Processed text
     */
    protected preprocessText(text: string): string {
        // Replace empty string with single space
        if (text === '') {
            return ' ';
        }

        // Simple character-based truncation (approximation)
        // Each token is roughly 4 characters on average for English text
        const maxChars = this.maxTokens * 4;
        if (text.length > maxChars) {
            return text.substring(0, maxChars);
        }

        return text;
    }

    /**
     * Detect embedding dimension 
     * @param testText Test text for dimension detection
     * @returns Embedding dimension
     */
    abstract detectDimension(testText?: string): Promise<number>;

    /**
     * Preprocess array of texts
     * @param texts Array of input texts
     * @returns Array of processed texts
     */
    protected preprocessTexts(texts: string[]): string[] {
        return texts.map(text => this.preprocessText(text));
    }

    /**
     * Generate one query embedding.
     * @param text Query text
     * @returns Embedding vector
     */
    abstract embedQuery(text: string): Promise<EmbeddingVector>;

    /**
     * Generate document embeddings in stable input order.
     * @param texts Document texts
     * @returns Embedding vector array
     */
    abstract embedDocuments(texts: string[]): Promise<EmbeddingVector[]>;

    /**
     * Get embedding vector dimension
     * @returns Vector dimension
     */
    abstract getDimension(): number;

    /**
     * Get service provider name
     * @returns Provider name
     */
    abstract getProvider(): string;

    protected buildIdentity(model: string, artifactDigest: string | null = null): Readonly<EmbeddingIdentity> {
        return Object.freeze({
            provider: this.getProvider(),
            model,
            dimension: this.getDimension(),
            artifactDigest,
            normalizationPolicy: EMBEDDING_NORMALIZATION_POLICY_VERSION,
        });
    }

    /** Stable identity used by persisted index authority. */
    abstract getIdentity(): Readonly<EmbeddingIdentity>;

    /**
     * Providers may declare a larger safe indexing batch than the generic
     * default. The caller may reduce these limits, but must never raise them.
     */
    getBatchPolicy(): EmbeddingBatchPolicy | null {
        return null;
    }

    /**
     * Cumulative snapshots avoid destructive resets between operations. Delta
     * attribution is exact only when no other request uses this provider during
     * the measured window.
     */
    getOperationMetricsSnapshot(): EmbeddingOperationMetricsSnapshot | null {
        return null;
    }
}

export function resolveValidatedEmbeddingIdentity(embedding: Embedding): Readonly<EmbeddingIdentity> {
    const getIdentity = (embedding as unknown as { getIdentity?: unknown }).getIdentity;
    if (typeof getIdentity !== 'function') {
        throw new Error('Embedding identity must contain provider, model, dimension, artifactDigest, and normalizationPolicy.');
    }
    const identity = getIdentity.call(embedding) as unknown;
    if (
        !identity
        || typeof identity !== 'object'
        || Array.isArray(identity)
        || typeof (identity as Record<string, unknown>).provider !== 'string'
        || typeof (identity as Record<string, unknown>).model !== 'string'
        || typeof (identity as Record<string, unknown>).dimension !== 'number'
        || (
            (identity as Record<string, unknown>).artifactDigest !== null
            && typeof (identity as Record<string, unknown>).artifactDigest !== 'string'
        )
        || typeof (identity as Record<string, unknown>).normalizationPolicy !== 'string'
    ) {
        throw new Error('Embedding identity must contain provider, model, dimension, artifactDigest, and normalizationPolicy.');
    }
    const validated = identity as EmbeddingIdentity;
    if (validated.provider.trim().length === 0 || validated.provider !== validated.provider.trim()) {
        throw new Error('Embedding identity provider must be a non-empty canonical string.');
    }
    if (validated.model.trim().length === 0 || validated.model !== validated.model.trim()) {
        throw new Error('Embedding identity model must be a non-empty canonical string.');
    }
    if (!Number.isSafeInteger(validated.dimension) || validated.dimension <= 0) {
        throw new Error('Embedding identity dimension must be a positive safe integer.');
    }
    if (validated.dimension !== embedding.getDimension()) {
        throw new Error(
            `Embedding identity dimension ${validated.dimension} does not match provider dimension ${embedding.getDimension()}.`,
        );
    }
    if (validated.provider !== embedding.getProvider()) {
        throw new Error(
            `Embedding identity provider '${validated.provider}' does not match provider '${embedding.getProvider()}'.`,
        );
    }
    if (validated.artifactDigest !== null && !/^[a-f0-9]{64}$/.test(validated.artifactDigest)) {
        throw new Error('Embedding artifact digest must be null or a lowercase SHA-256 digest.');
    }
    if (validated.normalizationPolicy !== EMBEDDING_NORMALIZATION_POLICY_VERSION) {
        throw new Error(
            `Unsupported embedding normalization policy '${validated.normalizationPolicy}'.`,
        );
    }
    return Object.freeze({ ...validated });
}
