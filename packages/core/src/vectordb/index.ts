// Re-export types and interfaces
export {
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    VectorDatabase,
    CollectionDetails,
    VectorStoreBackendInfo,
    VectorWriteMetricsSnapshot,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    SparseSearchOptions,
    RerankStrategy,
    RetrievalMode,
    ScorePolicy,
    BackendScoreKind,
    IndexCompletionFingerprint,
    IndexCompletionMarkerDocument,
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    INDEX_COMPLETION_MARKER_RELATIVE_PATH,
    COLLECTION_LIMIT_MESSAGE
} from './types';

// Implementation class exports
export { MilvusRestfulVectorDatabase, MilvusRestfulConfig } from './milvus-restful-vectordb';
export { MilvusVectorDatabase, MilvusConfig } from './milvus-vectordb';
export {
    RemoteCollectionDeletePendingError,
    deleteCollectionWithVerification,
    VerifiedCollectionDeleteOptions,
    VerifiedCollectionDeleteResult
} from './remote-delete';
export {
    ClusterManager,
    ZillizConfig,
    Project,
    Cluster,
    CreateFreeClusterRequest,
    CreateFreeClusterResponse,
    CreateFreeClusterWithDetailsResponse,
    DescribeClusterResponse
} from './zilliz-utils'; 
