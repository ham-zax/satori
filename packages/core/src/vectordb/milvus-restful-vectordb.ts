/**
 * Milvus RESTful Vector Database Implementation
 * 
 * This RESTful implementation of Milvus vector database is specifically designed for 
 * environments with strict dependency constraints, e.g. VSCode Extensions, Chrome Extensions, etc.
 * 
 * The standard Milvus gRPC implementation requires some dependencies and modules
 * that are not available or restricted in these constrained environments. This RESTful
 * implementation uses only HTTP requests, making it compatible with them.
 */

import {
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    VectorDatabase,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    COLLECTION_LIMIT_MESSAGE,
    CollectionDetails,
    VectorStoreBackendInfo,
    VectorDocumentMetadata,
    VectorRecord,
} from './types';
import { ClusterManager } from './zilliz-utils';
import { deleteCollectionWithVerification } from './remote-delete';

type MilvusRestResponse<T = unknown> = {
    code?: number;
    data?: T;
    message?: string;
};

type MilvusRestSearchRow = {
    id?: unknown;
    content?: unknown;
    relativePath?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    fileExtension?: unknown;
    metadata?: unknown;
    score?: unknown;
    distance?: unknown;
};

type MilvusRestSearchRequest = {
    collectionName: string;
    dbName?: string;
    data: number[][];
    annsField: string;
    limit: number;
    outputFields: string[];
    searchParams: {
        metricType: string;
        params: VectorRecord;
    };
    filter?: string;
};

type MilvusRestHybridSearchParam = {
    data: unknown[];
    annsField: string;
    limit: number;
    outputFields: string[];
    searchParams: {
        metricType: string;
        params: VectorRecord;
    };
    filter?: string;
};

type MilvusRestHybridSearchRequest = {
    collectionName: string;
    dbName?: string;
    search: MilvusRestHybridSearchParam[];
    rerank: {
        strategy: string;
        params: VectorRecord;
    };
    limit: number;
    outputFields: string[];
};

type HybridVectorDocument = VectorDocument & {
    sparse_vector: never[];
};

function isRecord(value: unknown): value is VectorRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }

    if (error instanceof Error) {
        return error.message;
    }

    if (isRecord(error) && typeof error.message === 'string') {
        return error.message;
    }

    return String(error);
}

function stringValue(value: unknown, fallback: string = ''): string {
    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return fallback;
}

function isSuccessCode(code: unknown): boolean {
    return code === 0 || code === 200;
}

function numberValue(value: unknown, fallback: number = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return fallback;
}

function parseMetadata(value: unknown, context: string): VectorDocumentMetadata {
    if (isRecord(value)) {
        return value;
    }

    if (typeof value !== 'string' || value.length === 0) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : {};
    } catch (error) {
        console.warn(`[MilvusRestfulDB] Failed to parse metadata for ${context}:`, error);
        return {};
    }
}

function toVectorSearchResult(row: MilvusRestSearchRow, vector: number[]): VectorSearchResult {
    return {
        document: {
            id: stringValue(row.id),
            vector,
            content: stringValue(row.content),
            relativePath: stringValue(row.relativePath),
            startLine: numberValue(row.startLine),
            endLine: numberValue(row.endLine),
            fileExtension: stringValue(row.fileExtension),
            metadata: parseMetadata(row.metadata, stringValue(row.id, 'unknown item')),
        },
        score: numberValue(row.distance, numberValue(row.score)),
    };
}

function toHybridSearchResult(row: MilvusRestSearchRow): HybridSearchResult {
    const document: HybridVectorDocument = {
        id: stringValue(row.id),
        content: stringValue(row.content),
        vector: [],
        sparse_vector: [],
        relativePath: stringValue(row.relativePath),
        startLine: numberValue(row.startLine),
        endLine: numberValue(row.endLine),
        fileExtension: stringValue(row.fileExtension),
        metadata: parseMetadata(row.metadata, stringValue(row.id, 'unknown item')),
    };

    return {
        document,
        score: numberValue(row.score, numberValue(row.distance)),
    };
}

export interface MilvusRestfulConfig {
    address?: string;
    token?: string;
    username?: string;
    password?: string;
    database?: string;
}

function normalizeHost(address: string): string {
    const withProtocol = address.includes('://') ? address : `http://${address}`;
    try {
        return new URL(withProtocol).hostname.toLowerCase();
    } catch {
        return address.toLowerCase();
    }
}

function looksLikeZillizAddress(address: string): boolean {
    const host = normalizeHost(address);
    return host.endsWith('cloud.zilliz.com') || host.endsWith('zillizcloud.com');
}

/**
 * TODO: Change this usage to checkCollectionLimit()
 * Wrapper function to handle collection creation with limit detection
 * This is the single point where collection limit errors are detected and handled
 */
async function createCollectionWithLimitCheck(
    makeRequestFn: (endpoint: string, method: 'GET' | 'POST', data?: unknown) => Promise<MilvusRestResponse>,
    collectionSchema: unknown
): Promise<void> {
    try {
        await makeRequestFn('/collections/create', 'POST', collectionSchema);
    } catch (error: unknown) {
        // Check if the error message contains the collection limit exceeded pattern
        const message = errorMessage(error);
        if (/exceeded the limit number of collections/i.test(message)) {
            // Throw the exact message string, not an Error object
            throw COLLECTION_LIMIT_MESSAGE;
        }
        // Re-throw other errors as-is
        throw error;
    }
}

/**
 * Milvus Vector Database implementation using REST API
 * This implementation is designed for environments where gRPC is not available,
 * such as VSCode extensions or browser environments.
 */
export class MilvusRestfulVectorDatabase implements VectorDatabase {
    protected config: MilvusRestfulConfig;
    private baseUrl: string | null = null;
    protected initializationPromise: Promise<void>;
    private resolvedAddress: string | null = null;
    private resolvedFromToken: boolean = false;

    constructor(config: MilvusRestfulConfig) {
        this.config = config;

        // Start initialization asynchronously without waiting
        this.initializationPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        const resolvedAddress = await this.resolveAddress();
        await this.initializeClient(resolvedAddress);
    }

    private async initializeClient(address: string): Promise<void> {
        // Ensure address has protocol prefix
        let processedAddress = address;
        if (!processedAddress.startsWith('http://') && !processedAddress.startsWith('https://')) {
            processedAddress = `http://${processedAddress}`;
        }

        this.baseUrl = processedAddress.replace(/\/$/, '') + '/v2/vectordb';
        this.resolvedAddress = processedAddress;

        console.log(`🔌 Connecting to Milvus REST API at: ${processedAddress}`);
    }

    /**
     * Resolve address from config or token
     * Common logic for both gRPC and REST implementations
     */
    protected async resolveAddress(): Promise<string> {
        let finalConfig = { ...this.config };
        this.resolvedFromToken = false;

        // If address is not provided, get it using token
        if (!finalConfig.address && finalConfig.token) {
            this.resolvedFromToken = true;
            finalConfig.address = await ClusterManager.getAddressFromToken(finalConfig.token);
        }

        if (!finalConfig.address) {
            throw new Error('Address is required and could not be resolved from token');
        }

        return finalConfig.address;
    }

    /**
     * Ensure initialization is complete before method execution
     */
    protected async ensureInitialized(): Promise<void> {
        await this.initializationPromise;
        if (!this.baseUrl) {
            throw new Error('Base URL not initialized');
        }
    }

    /**
     * Ensure collection is loaded before search/query operations
     */
    protected async ensureLoaded(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Check if collection is loaded
            const response = await this.makeRequest<{ loadState?: unknown }>('/collections/get_load_state', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });

            const loadState = isRecord(response.data) ? response.data.loadState : undefined;
            if (loadState !== 'LoadStateLoaded') {
                console.log(`[MilvusRestfulDB] 🔄 Loading collection '${collectionName}' to memory...`);
                await this.loadCollection(collectionName);
            }
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to ensure collection '${collectionName}' is loaded:`, error);
            throw error;
        }
    }

    /**
     * Make HTTP request to Milvus REST API
     */
    private async makeRequest<T = unknown>(endpoint: string, method: 'GET' | 'POST' = 'POST', data?: unknown): Promise<MilvusRestResponse<T>> {
        const url = `${this.baseUrl}${endpoint}`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        // Handle authentication
        if (this.config.token) {
            headers['Authorization'] = `Bearer ${this.config.token}`;
        } else if (this.config.username && this.config.password) {
            headers['Authorization'] = `Bearer ${this.config.username}:${this.config.password}`;
        }

        const requestOptions: RequestInit = {
            method,
            headers,
        };

        if (data && method === 'POST') {
            requestOptions.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, requestOptions);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result: unknown = await response.json();

            if (!isRecord(result)) {
                throw new Error('Milvus API error: malformed JSON response');
            }

            if (!isSuccessCode(result.code)) {
                const message = typeof result.message === 'string' ? result.message : 'Unknown error';
                throw new Error(`Milvus API error: ${message}`);
            }

            return result as MilvusRestResponse<T>;
        } catch (error) {
            console.error(`[MilvusRestfulDB] Milvus REST API request failed:`, error);
            throw error;
        }
    }

    async createCollection(collectionName: string, dimension: number, _description?: string): Promise<void> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Build collection schema based on the original milvus-vectordb.ts implementation
            // Note: REST API doesn't support description parameter in collection creation
            // Unlike gRPC version, the description parameter is ignored in REST API
            const collectionSchema = {
                collectionName,
                dbName: restfulConfig.database,
                schema: {
                    enableDynamicField: false,
                    fields: [
                        {
                            fieldName: "id",
                            dataType: "VarChar",
                            isPrimary: true,
                            elementTypeParams: {
                                max_length: 512
                            }
                        },
                        {
                            fieldName: "vector",
                            dataType: "FloatVector",
                            elementTypeParams: {
                                dim: dimension
                            }
                        },
                        {
                            fieldName: "content",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535
                            }
                        },
                        {
                            fieldName: "relativePath",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 1024
                            }
                        },
                        {
                            fieldName: "startLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "endLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "fileExtension",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 32
                            }
                        },
                        {
                            fieldName: "metadata",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535
                            }
                        }
                    ]
                }
            };

            // Step 1: Create collection with schema
            await createCollectionWithLimitCheck(this.makeRequest.bind(this), collectionSchema);

            // Step 2: Create index for vector field (separate API call)
            await this.createIndex(collectionName);

            // Step 3: Load collection to memory for searching
            await this.loadCollection(collectionName);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create collection '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Create index for vector field using the Index Create API
     */
    private async createIndex(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const indexParams = {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "vector",
                        indexName: "vector_index",
                        metricType: "COSINE",
                        index_type: "AUTOINDEX"
                    }
                ]
            };

            await this.makeRequest('/indexes/create', 'POST', indexParams);
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create index for collection '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Load collection to memory for searching
     */
    private async loadCollection(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            await this.makeRequest('/collections/load', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to load collection '${collectionName}':`, error);
            throw error;
        }
    }

    async dropCollection(collectionName: string): Promise<void> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            await this.makeRequest('/collections/drop', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to drop collection '${collectionName}':`, error);
            throw error;
        }
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const response = await this.makeRequest<{ has?: unknown }>('/collections/has', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });

            const exists = isRecord(response.data) ? response.data.has === true : false;
            return exists;
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to check collection '${collectionName}' existence:`, error);
            throw error;
        }
    }

    async listCollections(): Promise<string[]> {
        const details = await this.listCollectionDetails();
        return details.map((collection) => collection.name);
    }

    async listCollectionDetails(): Promise<CollectionDetails[]> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const response = await this.makeRequest<unknown[]>('/collections/list', 'POST', {
                dbName: restfulConfig.database
            });

            if (!Array.isArray(response.data)) {
                return [];
            }

            return response.data
                .map((item: unknown) => {
                    if (typeof item === 'string') {
                        return { name: item };
                    }

                    if (!isRecord(item)) {
                        return null;
                    }

                    const name = item.name || item.collectionName;
                    if (typeof name !== 'string' || name.length === 0) {
                        return null;
                    }

                    const rawCreatedAt = item.createdAt || item.createTime;
                    let createdAt: string | undefined;
                    if (typeof rawCreatedAt === 'string') {
                        const parsed = Date.parse(rawCreatedAt);
                        if (Number.isFinite(parsed)) {
                            createdAt = new Date(parsed).toISOString();
                        }
                    }

                    return { name, createdAt };
                })
                .filter((item: CollectionDetails | null): item is CollectionDetails => item !== null);
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to list collections:`, error);
            throw error;
        }
    }

    getBackendInfo(): VectorStoreBackendInfo {
        const address = this.resolvedAddress || this.config.address;
        const isZilliz = Boolean(address && looksLikeZillizAddress(address)) || this.resolvedFromToken;

        return {
            provider: isZilliz ? 'zilliz' : 'milvus',
            transport: 'rest',
            address,
        };
    }

    async insert(collectionName: string, documents: VectorDocument[]): Promise<void> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Transform VectorDocument array to Milvus entity format
            const data = documents.map(doc => ({
                id: doc.id,
                vector: doc.vector,
                content: doc.content,
                relativePath: doc.relativePath,
                startLine: doc.startLine,
                endLine: doc.endLine,
                fileExtension: doc.fileExtension,
                metadata: JSON.stringify(doc.metadata) // Convert metadata object to JSON string
            }));

            const insertRequest = {
                collectionName,
                data,
                dbName: restfulConfig.database
            };

            await this.makeRequest('/entities/insert', 'POST', insertRequest);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to insert documents into collection '${collectionName}':`, error);
            throw error;
        }
    }

    async search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        const topK = options?.topK || 10;

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Build search request according to Milvus REST API specification
            const searchRequest: MilvusRestSearchRequest = {
                collectionName,
                dbName: restfulConfig.database,
                data: [queryVector], // Array of query vectors
                annsField: "vector", // Vector field name
                limit: topK,
                outputFields: [
                    "content",
                    "relativePath",
                    "startLine",
                    "endLine",
                    "fileExtension",
                    "metadata"
                ],
                searchParams: {
                    metricType: "COSINE", // Match the index metric type
                    params: {}
                }
            };

            // Apply boolean expression filter if provided (e.g., fileExtension in ['.ts','.py']) 
            if (options?.filterExpr && options.filterExpr.trim().length > 0) {
                searchRequest.filter = options.filterExpr;
            }

            const response = await this.makeRequest<MilvusRestSearchRow[]>('/entities/search', 'POST', searchRequest);

            // Transform response to VectorSearchResult format
            const results: VectorSearchResult[] = Array.isArray(response.data)
                ? response.data.map((item) => toVectorSearchResult(item, queryVector))
                : [];

            return results.filter((result) => options?.threshold === undefined || result.score >= options.threshold);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to search in collection '${collectionName}':`, error);
            throw error;
        }
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Build filter expression for deleting by IDs
            // Format: id in ["id1", "id2", "id3"]
            const filter = `id in [${ids.map(id => `"${id}"`).join(', ')}]`;

            const deleteRequest = {
                collectionName,
                filter,
                dbName: restfulConfig.database
            };

            await this.makeRequest('/entities/delete', 'POST', deleteRequest);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to delete documents from collection '${collectionName}':`, error);
            throw error;
        }
    }

    async query(collectionName: string, filter: string, outputFields: string[], limit?: number): Promise<VectorRecord[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const queryRequest = {
                collectionName,
                dbName: restfulConfig.database,
                filter,
                outputFields,
                limit: limit || 16384, // Use provided limit or default
                offset: 0
            };

            const response = await this.makeRequest<VectorRecord[]>('/entities/query', 'POST', queryRequest);

            if (!isSuccessCode(response.code)) {
                throw new Error(`Failed to query Milvus: ${response.message || 'Unknown error'}`);
            }

            return Array.isArray(response.data)
                ? response.data.filter(isRecord)
                : [];

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to query collection '${collectionName}':`, error);
            throw error;
        }
    }

    async createHybridCollection(collectionName: string, dimension: number, _description?: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            const collectionSchema = {
                collectionName,
                dbName: restfulConfig.database,
                schema: {
                    enableDynamicField: false,
                    functions: [
                        {
                            name: "content_bm25_emb",
                            description: "content bm25 function",
                            type: "BM25",
                            inputFieldNames: ["content"],
                            outputFieldNames: ["sparse_vector"],
                            params: {},
                        },
                    ],
                    fields: [
                        {
                            fieldName: "id",
                            dataType: "VarChar",
                            isPrimary: true,
                            elementTypeParams: {
                                max_length: 512
                            }
                        },
                        {
                            fieldName: "content",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535,
                                enable_analyzer: true
                            }
                        },
                        {
                            fieldName: "vector",
                            dataType: "FloatVector",
                            elementTypeParams: {
                                dim: dimension
                            }
                        },
                        {
                            fieldName: "sparse_vector",
                            dataType: "SparseFloatVector"
                        },
                        {
                            fieldName: "relativePath",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 1024
                            }
                        },
                        {
                            fieldName: "startLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "endLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "fileExtension",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 32
                            }
                        },
                        {
                            fieldName: "metadata",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535
                            }
                        }
                    ]
                }
            };

            // Step 1: Create collection with schema and functions
            await createCollectionWithLimitCheck(this.makeRequest.bind(this), collectionSchema);

            // Step 2: Create indexes for both vector fields
            await this.createHybridIndexes(collectionName);

            // Step 3: Load collection to memory for searching
            await this.loadCollection(collectionName);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create hybrid collection '${collectionName}':`, error);
            throw error;
        }
    }

    private async createHybridIndexes(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            // Create index for dense vector
            const denseIndexParams = {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "vector",
                        indexName: "vector_index",
                        metricType: "COSINE",
                        index_type: "AUTOINDEX"
                    }
                ]
            };
            await this.makeRequest('/indexes/create', 'POST', denseIndexParams);

            // Create index for sparse vector
            const sparseIndexParams = {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "sparse_vector",
                        indexName: "sparse_vector_index",
                        metricType: "BM25",
                        index_type: "SPARSE_INVERTED_INDEX"
                    }
                ]
            };
            await this.makeRequest('/indexes/create', 'POST', sparseIndexParams);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create hybrid indexes for collection '${collectionName}':`, error);
            throw error;
        }
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            const data = documents.map(doc => ({
                id: doc.id,
                content: doc.content,
                vector: doc.vector,
                relativePath: doc.relativePath,
                startLine: doc.startLine,
                endLine: doc.endLine,
                fileExtension: doc.fileExtension,
                metadata: JSON.stringify(doc.metadata),
            }));

            const insertRequest = {
                collectionName,
                dbName: restfulConfig.database,
                data: data
            };

            const response = await this.makeRequest('/entities/insert', 'POST', insertRequest);

            if (!isSuccessCode(response.code)) {
                throw new Error(`Insert failed: ${response.message || 'Unknown error'}`);
            }

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to insert hybrid documents to collection '${collectionName}':`, error);
            throw error;
        }
    }

    async hybridSearch(collectionName: string, searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            console.log(`[MilvusRestfulDB] 🔍 Preparing hybrid search for collection: ${collectionName}`);

            // Prepare search requests according to Milvus REST API hybrid search specification
            // For dense vector search - data must be array of vectors: [[0.1, 0.2, 0.3, ...]]
            const search_param_1: MilvusRestHybridSearchParam = {
                data: Array.isArray(searchRequests[0].data) ? [searchRequests[0].data] : [[searchRequests[0].data]],
                annsField: searchRequests[0].anns_field, // "vector"
                limit: searchRequests[0].limit,
                outputFields: ["*"],
                searchParams: {
                    metricType: "COSINE",
                    params: searchRequests[0].param || { "nprobe": 10 }
                }
            };

            // For sparse vector search - data must be array of queries: ["query text"]
            const search_param_2: MilvusRestHybridSearchParam = {
                data: Array.isArray(searchRequests[1].data) ? searchRequests[1].data : [searchRequests[1].data],
                annsField: searchRequests[1].anns_field, // "sparse_vector"
                limit: searchRequests[1].limit,
                outputFields: ["*"],
                searchParams: {
                    metricType: "BM25",
                    params: searchRequests[1].param || { "drop_ratio_search": 0.2 }
                }
            };

            // Apply filter to both search parameters if provided
            if (options?.filterExpr && options.filterExpr.trim().length > 0) {
                search_param_1.filter = options.filterExpr;
                search_param_2.filter = options.filterExpr;
            }

            const rerank_strategy = {
                strategy: "rrf",
                params: {
                    k: 100
                }
            };

            console.log(`[MilvusRestfulDB] 🔍 Dense search params:`, JSON.stringify({
                annsField: search_param_1.annsField,
                limit: search_param_1.limit,
                data_length: Array.isArray(search_param_1.data[0]) ? search_param_1.data[0].length : 'N/A',
                searchParams: search_param_1.searchParams
            }, null, 2));
            console.log(`[MilvusRestfulDB] 🔍 Sparse search params:`, JSON.stringify({
                annsField: search_param_2.annsField,
                limit: search_param_2.limit,
                query_text: typeof search_param_2.data[0] === 'string' ? search_param_2.data[0].substring(0, 50) + '...' : 'N/A',
                searchParams: search_param_2.searchParams
            }, null, 2));

            const hybridSearchRequest: MilvusRestHybridSearchRequest = {
                collectionName,
                dbName: restfulConfig.database,
                search: [search_param_1, search_param_2],
                rerank: rerank_strategy,
                limit: options?.limit || searchRequests[0]?.limit || 10,
                outputFields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
            };

            console.log(`[MilvusRestfulDB] 🔍 Executing REST API hybrid search...`);
            const response = await this.makeRequest<MilvusRestSearchRow[]>('/entities/hybrid_search', 'POST', hybridSearchRequest);

            if (!isSuccessCode(response.code)) {
                throw new Error(`Hybrid search failed: ${response.message || 'Unknown error'}`);
            }

            const results = Array.isArray(response.data) ? response.data : [];
            console.log(`[MilvusRestfulDB] ✅ Found ${results.length} results from hybrid search`);

            // Transform response to HybridSearchResult format
            return results
                .map(toHybridSearchResult)
                .filter((result: HybridSearchResult) => options?.threshold === undefined || result.score >= options.threshold);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to perform hybrid search on collection '${collectionName}':`, error);
            throw error;
        }
    }

    async checkCollectionLimit(): Promise<boolean> {
        await this.ensureInitialized();

        const restfulConfig = this.config as MilvusRestfulConfig;
        const collectionName = `dummy_collection_${Date.now()}`;
        const collectionSchema = {
            collectionName,
            dbName: restfulConfig.database,
            schema: {
                enableDynamicField: false,
                fields: [
                    {
                        fieldName: "id",
                        dataType: "VarChar",
                        isPrimary: true,
                        elementTypeParams: {
                            max_length: 512
                        }
                    },
                    {
                        fieldName: "vector",
                        dataType: "FloatVector",
                        elementTypeParams: {
                            dim: 128
                        }
                    }
                ]
            }
        };

        try {
            await createCollectionWithLimitCheck(this.makeRequest.bind(this), collectionSchema);
            await deleteCollectionWithVerification(this, collectionName);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === COLLECTION_LIMIT_MESSAGE) {
                return false;
            }
            throw error;
        }
    }
}
