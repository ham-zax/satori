import type {
    CanonicalCompletionFingerprint,
    CanonicalCompletionMarker,
} from '../core/persisted-index-authority';

export type VectorRecord = Record<string, unknown>;

export interface VectorDocumentMetadata extends VectorRecord {
    language?: string;
    filePath?: string;
    breadcrumbs?: string[];
    indexedAt?: string;
    symbolId?: string;
    symbolLabel?: string;
    symbolKind?: string;
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    startByte?: number;
    endByte?: number;
}

// Interface definitions
export interface VectorDocument {
    id: string;
    vector: number[];
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    fileExtension: string;
    metadata: VectorDocumentMetadata;
}

export type RetrievalMode = 'dense' | 'lexical' | 'hybrid';

export type ScorePolicy =
    | { kind: 'dense_similarity_min'; min: number }
    | { kind: 'topk_only' };

export type BackendScoreKind = 'dense_similarity' | 'lexical_rank' | 'rrf_fusion';

export interface SearchOptions {
    topK?: number;
    filter?: VectorRecord;
    threshold?: number;
    filterExpr?: string;
}

// New interfaces for hybrid search
export interface HybridSearchRequest {
    data: number[] | string; // Query vector or text
    anns_field: string; // Vector field name (vector or sparse_vector)
    param: VectorRecord; // Search parameters
    limit: number;
}

export interface HybridSearchOptions {
    rerank?: RerankStrategy;
    limit?: number;
    threshold?: number;
    filterExpr?: string;
}

export interface SparseSearchOptions {
    topK?: number;
    filterExpr?: string;
    dropRatioSearch?: number;
}

export interface RerankStrategy {
    strategy: 'rrf' | 'weighted';
    params?: VectorRecord;
}

export interface VectorSearchResult {
    document: VectorDocument;
    score: number;
}

export interface HybridSearchResult {
    document: VectorDocument;
    score: number;
}

export interface CollectionDetails {
    name: string;
    createdAt?: string;
}

export interface VectorStoreBackendInfo {
    provider: 'milvus' | 'zilliz';
    transport: 'grpc' | 'rest';
    address?: string;
}

export type IndexCompletionFingerprint = CanonicalCompletionFingerprint;

export type IndexCompletionMarkerDocument = CanonicalCompletionMarker & VectorDocumentMetadata;

export const INDEX_COMPLETION_MARKER_DOC_ID = '__satori_index_completion_marker_v1__';
export const INDEX_COMPLETION_MARKER_FILE_EXTENSION = '.satori_meta';
export const INDEX_COMPLETION_MARKER_RELATIVE_PATH = '.__satori__/index_completion_marker.json';

export type CollectionCreateOptions = {
    deferIndexBuild?: boolean;
};

export type VectorWriteFlushReason = 'row_limit' | 'logical_write_end' | 'retry';

export type VectorWriteAttemptSample = {
    sequence: number;
    rows: number;
    bytes: number;
    flushReason: VectorWriteFlushReason;
};

export type VectorWriteMetricsSnapshot = {
    providerRequestCount: number;
    retryCount: number;
    submittedRows: number;
    submittedBytes: number;
    durationMs: number;
    rowLimit: number;
    recentAttempts: readonly VectorWriteAttemptSample[];
};

export interface VectorDatabase {
    /**
     * Create collection
     * @param collectionName Collection name
     * @param dimension Vector dimension
     * @param description Collection description
     */
    createCollection(collectionName: string, dimension: number, description?: string): Promise<void>;

    /**
     * Create collection with hybrid search support
     * @param collectionName Collection name
     * @param dimension Dense vector dimension
     * @param description Collection description
     */
    createHybridCollection(
        collectionName: string,
        dimension: number,
        description?: string,
        options?: CollectionCreateOptions,
    ): Promise<void>;

    /**
     * Build deferred indexes and make a newly populated collection searchable.
     * Full indexing calls this before publishing its authoritative marker.
     */
    finalizeCollectionForSearch?(collectionName: string): Promise<void>;

    /**
     * Drop collection
     * @param collectionName Collection name
     */
    dropCollection(collectionName: string): Promise<void>;

    /**
     * Check if collection exists
     * @param collectionName Collection name
     */
    hasCollection(collectionName: string): Promise<boolean>;

    /**
     * List all collections
     */
    listCollections(): Promise<string[]>;

    /**
     * List all collections with optional metadata such as creation timestamp
     */
    listCollectionDetails?(): Promise<CollectionDetails[]>;

    /**
     * Backend metadata for provider-specific behaviors (e.g. Zilliz guidance)
     */
    getBackendInfo?(): VectorStoreBackendInfo;

    /**
     * Cumulative adapter-boundary write metrics. Implementations that expose
     * this contract must count real provider attempts, including retries.
     */
    getWriteMetricsSnapshot?(): VectorWriteMetricsSnapshot;

    /**
     * Insert vector documents
     * @param collectionName Collection name
     * @param documents Document array
     */
    insert(collectionName: string, documents: VectorDocument[]): Promise<void>;

    /**
     * Insert hybrid vector documents
     * @param collectionName Collection name
     * @param documents Document array
     */
    insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void>;

    /**
     * Search similar vectors
     * @param collectionName Collection name
     * @param queryVector Query vector
     * @param options Search options
     */
    search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]>;

    /**
     * Hybrid search with multiple vector fields
     * @param collectionName Collection name
     * @param searchRequests Array of search requests for different fields
     * @param options Hybrid search options including reranking
     */
    hybridSearch(collectionName: string, searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]>;

    /**
     * Search the server-generated BM25 sparse field without a dense query vector.
     * Implementations for hybrid collections should expose this capability.
     */
    sparseSearch?(
        collectionName: string,
        queryText: string,
        options?: SparseSearchOptions,
    ): Promise<HybridSearchResult[]>;

    /**
     * Delete documents
     * @param collectionName Collection name
     * @param ids Document ID array
     */
    delete(collectionName: string, ids: string[]): Promise<void>;

    /**
     * Query documents with filter conditions
     * @param collectionName Collection name
     * @param filter Filter expression
     * @param outputFields Fields to return
     * @param limit Maximum number of results
     */
    query(collectionName: string, filter: string, outputFields: string[], limit?: number): Promise<VectorRecord[]>;

    /** Return the exact number of rows matching a backend filter. */
    count?(collectionName: string, filter: string): Promise<number>;

    /**
     * Check collection limit
     * Returns true if collection can be created, false if limit exceeded
     */
    checkCollectionLimit(): Promise<boolean>;
}

/**
 * Special error message for collection limit exceeded
 * This allows us to distinguish it from other errors across all Milvus implementations
 */
export const COLLECTION_LIMIT_MESSAGE = "[Error]: Your Zilliz Cloud account has hit its collection limit. To continue creating collections, you'll need to expand your capacity. We recommend visiting https://zilliz.com/pricing to explore options for dedicated or serverless clusters."; 
