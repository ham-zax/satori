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

export interface SearchProjections {
    readonly embeddingText: string;
    readonly lexicalText: string;
    readonly embeddingVersion: string;
    readonly lexicalVersion: string;
}

export interface IndexedVectorDocument {
    readonly document: VectorDocument;
    readonly projections: SearchProjections;
}

export interface VectorControlRecord {
    readonly id: string;
    /** Adapter routing identity; completion readers require it to match metadata.kind. */
    readonly kind: string;
    /** Logical payload. Adapters must round-trip it without transport-only fields. */
    readonly metadata: VectorDocumentMetadata;
}

export type RetrievalMode = 'dense' | 'lexical' | 'hybrid';
export type VectorStoreProviderIdentity = 'Milvus' | 'LanceDB';

export type ScorePolicy =
    | { kind: 'dense_similarity_min'; min: number }
    | { kind: 'topk_only' };

export type BackendScoreKind = 'dense_similarity' | 'lexical_rank' | 'rrf_fusion';

export type VectorFilterField = 'id' | 'relativePath' | 'fileExtension';
export type VectorFilterValue = string;

export type VectorFilter =
    | {
        readonly kind: 'comparison';
        readonly field: VectorFilterField;
        readonly operator: 'eq' | 'ne';
        readonly value: VectorFilterValue;
    }
    | {
        readonly kind: 'in';
        readonly field: VectorFilterField;
        readonly values: readonly VectorFilterValue[];
    }
    | {
        readonly kind: 'and';
        readonly operands: readonly VectorFilter[];
    };

export interface DenseCandidateRequest {
    readonly vector: readonly number[];
    readonly limit: number;
    readonly minimumScore?: number;
    readonly filter?: VectorFilter;
}

export interface LexicalCandidateRequest {
    readonly query: string;
    readonly limit: number;
    readonly filter?: VectorFilter;
    /** Backend-neutral term matching requested by diagnostic or retrieval policy. */
    readonly matchMode?: 'all_terms' | 'any_terms';
}

export interface VectorCandidate {
    document: VectorDocument;
    /**
     * Adapter-normalized backend rank score. The value must be finite and a
     * larger value must always represent a better match. Numeric ranges may
     * differ by retrieval arm; Core uses only the induced ordering for RRF.
     */
    score: number;
}

export type VectorSearchResult = VectorCandidate;
export type HybridSearchResult = VectorCandidate;

export type VectorDocumentField =
    | 'id'
    | 'content'
    | 'relativePath'
    | 'startLine'
    | 'endLine'
    | 'fileExtension'
    | 'metadata';

export interface VectorDocumentQuery {
    readonly filter?: VectorFilter;
    readonly fields: readonly VectorDocumentField[];
    readonly limit?: number;
}

export interface CollectionDetails {
    name: string;
    createdAt?: string;
}

export type VectorStoreBackendInfo =
    | {
        provider: 'milvus' | 'zilliz';
        transport: 'grpc' | 'rest';
        address?: string;
    }
    | {
        provider: 'lancedb';
        transport: 'embedded';
        address: string;
    };

export type IndexCompletionFingerprint = CanonicalCompletionFingerprint;

export type IndexCompletionMarkerDocument = CanonicalCompletionMarker & VectorDocumentMetadata;

export const INDEX_COMPLETION_MARKER_DOC_ID = '__satori_index_completion_marker_v1__';
export const INDEX_COMPLETION_MARKER_FILE_EXTENSION = '.satori_meta';

export type CollectionCreateOptions = {
    deferIndexBuild?: boolean;
};

export type VectorWriteFlushReason = 'row_limit' | 'byte_limit' | 'logical_write_end' | 'retry';

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
    byteLimit: number | null;
    recentAttempts: readonly VectorWriteAttemptSample[];
};

export interface VectorDatabase {
    /** Release adapter-owned resources when the runtime shuts down. */
    close?(): Promise<void> | void;

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

    /** Persist searchable documents. Collection schema determines lexical support. */
    writeDocuments(collectionName: string, documents: IndexedVectorDocument[]): Promise<void>;

    /** Persist one non-searchable backend control record. */
    insertControl(collectionName: string, record: VectorControlRecord): Promise<void>;

    /** Read one non-searchable backend control record by exact ID. */
    getControl(collectionName: string, id: string): Promise<VectorControlRecord | null>;

    /** Delete one non-searchable backend control record by exact ID. */
    deleteControl(collectionName: string, id: string): Promise<void>;

    retrieveDense(collectionName: string, request: DenseCandidateRequest): Promise<VectorCandidate[]>;

    retrieveLexical(collectionName: string, request: LexicalCandidateRequest): Promise<VectorCandidate[]>;

    /**
     * Delete documents
     * @param collectionName Collection name
     * @param ids Document ID array
     */
    deleteDocuments(collectionName: string, ids: string[]): Promise<void>;

    /**
     * Query documents with filter conditions
     * @param collectionName Collection name
     * @param filter Filter expression
     * @param outputFields Fields to return
     * @param limit Maximum number of results
     */
    queryDocuments(collectionName: string, request: VectorDocumentQuery): Promise<VectorRecord[]>;

    /** Return the exact number of searchable rows matching a backend-neutral filter. */
    countDocuments?(collectionName: string, filter?: VectorFilter): Promise<number>;

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
