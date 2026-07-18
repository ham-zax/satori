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
    VectorControlRecord,
    IndexedVectorDocument,
    DenseCandidateRequest,
    VectorCandidate,
    VectorDatabase,
    LexicalCandidateRequest,
    COLLECTION_LIMIT_MESSAGE,
    CollectionDetails,
    VectorStoreBackendInfo,
    VectorRecord,
    VectorDocumentQuery,
    VectorFilter,
    VectorPublicationCapabilities,
} from './types';
import {
    fromLegacyMilvusControlRow,
    toLegacyMilvusControlDocument,
    withMilvusControlExclusion,
} from './milvus-control-record';
import {
    assertMilvusSearchableDocumentIds,
    decodeMilvusCandidate,
    encodeMilvusDocument,
    encodeMilvusSearchableDocument,
    type MilvusPhysicalRow,
} from './milvus-row-codec';
import { ClusterManager } from './zilliz-utils';
import { deleteCollectionWithVerification } from './remote-delete';
import { buildMilvusIdInFilter } from './filters';

type MilvusRestResponse<T = unknown> = {
    code?: number;
    data?: T;
    message?: string;
};

type MilvusRestSearchRequest = {
    collectionName: string;
    dbName?: string;
    data: number[][] | string[];
    annsField: string;
    limit: number;
    outputFields: string[];
    searchParams: {
        metricType: string;
        params: VectorRecord;
    };
    filter?: string;
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

function isSuccessCode(code: unknown): boolean {
    return code === 0 || code === 200;
}

export interface MilvusRestfulConfig {
    address?: string;
    token?: string;
    username?: string;
    password?: string;
    database?: string;
    /** Dimension used only for placeholder vectors required by the legacy Milvus control-row schema. */
    vectorDimension: number;
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

    getPublicationCapabilities(): VectorPublicationCapabilities {
        return { atomicCandidatePublication: 'unsupported' };
    }

    async writeDocuments(collectionName: string, documents: IndexedVectorDocument[]): Promise<void> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Preserve the legacy Milvus source-content schema; the dense vector
            // was produced from the supplied Core projection before this call.
            const data = documents.map(({ document }) => encodeMilvusSearchableDocument(document));

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

    async insertControl(collectionName: string, record: VectorControlRecord): Promise<void> {
        await this.ensureInitialized();
        const restfulConfig = this.config as MilvusRestfulConfig;
        const response = await this.makeRequest('/entities/insert', 'POST', {
            collectionName,
            data: [encodeMilvusDocument(toLegacyMilvusControlDocument(record, this.config.vectorDimension))],
            dbName: restfulConfig.database,
        });
        if (!isSuccessCode(response.code)) {
            throw new Error(`Control-record insert failed: ${response.message || 'Unknown error'}`);
        }
    }

    async getControl(collectionName: string, id: string): Promise<VectorControlRecord | null> {
        const rows = await this.queryRows(collectionName, buildMilvusIdInFilter([id]), ['id', 'metadata'], 2);
        for (const row of rows) {
            const record = fromLegacyMilvusControlRow(row, id);
            if (record) return record;
        }
        return null;
    }

    async deleteControl(collectionName: string, id: string): Promise<void> {
        await this.deleteRows(collectionName, [id]);
    }

    async retrieveDense(collectionName: string, request: DenseCandidateRequest): Promise<VectorCandidate[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Build search request according to Milvus REST API specification
            const searchRequest: MilvusRestSearchRequest = {
                collectionName,
                dbName: restfulConfig.database,
                data: [[...request.vector]], // Array of query vectors
                annsField: "vector", // Vector field name
                limit: request.limit,
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
                },
                filter: withMilvusControlExclusion(request.filter),
            };

            const response = await this.makeRequest<MilvusPhysicalRow[]>('/entities/search', 'POST', searchRequest);

            // Transform response to VectorSearchResult format
            const results: VectorCandidate[] = Array.isArray(response.data)
                ? response.data.map((item) => decodeMilvusCandidate(item, {
                    vector: request.vector,
                    // Milvus names this response field `distance`, but COSINE
                    // values are similarity scores: larger is the better match.
                    scoreSource: 'distance-then-score',
                }))
                : [];

            return results.filter((result) => request.minimumScore === undefined || result.score >= request.minimumScore);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to search in collection '${collectionName}':`, error);
            throw error;
        }
    }

    async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
        assertMilvusSearchableDocumentIds(ids);
        await this.deleteRows(collectionName, ids);
    }

    private async deleteRows(collectionName: string, ids: string[]): Promise<void> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Build filter expression for deleting by IDs
            // Format: id in ["id1", "id2", "id3"]
            const filter = buildMilvusIdInFilter(ids);

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

    async queryDocuments(collectionName: string, request: VectorDocumentQuery): Promise<VectorRecord[]> {
        return this.queryRows(
            collectionName,
            withMilvusControlExclusion(request.filter),
            [...request.fields],
            request.limit,
        );
    }

    private async queryRows(
        collectionName: string,
        filter: string,
        outputFields: string[],
        limit?: number,
    ): Promise<VectorRecord[]> {
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

    async countDocuments(collectionName: string, filter?: VectorFilter): Promise<number> {
        const rows = await this.queryRows(
            collectionName,
            withMilvusControlExclusion(filter),
            ['count(*)'],
            1,
        );
        const rawCount = rows[0]?.['count(*)'] ?? rows[0]?.count;
        const count = Number(rawCount);
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error(`Milvus REST returned an invalid row count for collection '${collectionName}'.`);
        }
        return count;
    }

    async createHybridCollection(
        collectionName: string,
        dimension: number,
        _description?: string,
        options?: { deferIndexBuild?: boolean },
    ): Promise<void> {
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

            if (!options?.deferIndexBuild) {
                await this.finalizeCollectionForSearch(collectionName);
            }

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create hybrid collection '${collectionName}':`, error);
            throw error;
        }
    }

    async finalizeCollectionForSearch(collectionName: string): Promise<void> {
        await this.createHybridIndexes(collectionName);
        await this.loadCollection(collectionName);
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

    async retrieveLexical(
        collectionName: string,
        request: LexicalCandidateRequest,
    ): Promise<VectorCandidate[]> {
        if (request.matchMode !== undefined) {
            throw new Error('Milvus sparse retrieval does not support explicit lexical term operators.');
        }
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        const restfulConfig = this.config as MilvusRestfulConfig;
        const searchRequest: MilvusRestSearchRequest = {
            collectionName,
            dbName: restfulConfig.database,
            data: [request.query],
            annsField: 'sparse_vector',
            limit: request.limit,
            outputFields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
            searchParams: {
                metricType: 'BM25',
                params: {
                    drop_ratio_search: 0.2,
                },
            },
            filter: withMilvusControlExclusion(request.filter),
        };

        const response = await this.makeRequest<MilvusPhysicalRow[]>('/entities/search', 'POST', searchRequest);
        if (!isSuccessCode(response.code)) {
            throw new Error(`Sparse search failed: ${response.message || 'Unknown error'}`);
        }
        return (Array.isArray(response.data) ? response.data : [])
            .map((row) => decodeMilvusCandidate(row, {
                scoreSource: 'score-then-distance',
            }));
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
