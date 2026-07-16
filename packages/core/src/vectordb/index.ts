// Re-export types and interfaces
export {
    VectorDocument,
    VectorControlRecord,
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
    IndexCompletionFingerprint,
    IndexCompletionMarkerDocument,
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
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
    ClusterManager,
    ZillizConfig,
    Project,
    Cluster,
    CreateFreeClusterRequest,
    CreateFreeClusterResponse,
    CreateFreeClusterWithDetailsResponse,
    DescribeClusterResponse
} from './zilliz-utils'; 
