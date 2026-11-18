// Re-export types and interfaces
export {
    VectorDocument,
    IndexedVectorDocument,
    SearchProjections,
    DenseCandidateRequest,
    LexicalCandidateRequest,
    VectorCandidate,
    VectorFilter,
    VectorFilterField,
    VectorFilterValue,
    VectorDocumentField,
    VectorDocumentQuery,
    VectorSearchResult,
    VectorDatabase,
    CollectionDetails,
    VectorStoreBackendInfo,
    VectorWriteAttemptSample,
    VectorWriteFlushReason,
    VectorWriteMetricsSnapshot,
    HybridSearchResult,
    RetrievalMode,
    ScorePolicy,
    BackendScoreKind,
    VectorStoreProviderIdentity,
    COLLECTION_LIMIT_MESSAGE
} from './types';

// Implementation class exports
export { MilvusRestfulVectorDatabase, MilvusRestfulConfig } from './milvus-restful-vectordb';
export { MilvusVectorDatabase, MilvusConfig } from './milvus-vectordb';
export { VectorDatabaseTestAdapter } from './test-adapter';
export {
    RemoteCollectionDeletePendingError,
    deleteCollectionWithVerification,
    VerifiedCollectionDeleteOptions,
    VerifiedCollectionDeleteResult
} from './remote-delete';
export {
    DELETED_ID_BATCH_SIZE,
    DELETED_PATH_BATCH_SIZE,
    deleteIndexedChunksForRelativePaths,
    type DeleteIndexedChunksOptions,
} from './path-chunk-delete';
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
