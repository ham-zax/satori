import {
    MilvusClient,
    DataType,
    MetricType,
    FunctionType,
    LoadState,
    hybridtsToUnixtime,
    type HybridSearchReq,
    type QueryReq,
    type RowData,
    type SearchSimpleReq,
} from '@zilliz/milvus2-sdk-node';
import {
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    VectorDatabase,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    SparseSearchOptions,
    CollectionDetails,
    VectorStoreBackendInfo,
    VectorDocumentMetadata,
    VectorRecord,
    CollectionCreateOptions,
    VectorWriteFlushReason,
    VectorWriteMetricsSnapshot,
} from './types';
import { ClusterManager } from './zilliz-utils';
import { deleteCollectionWithVerification } from './remote-delete';
import { buildMilvusIdInFilter } from './filters';
import { envManager } from '../utils/env-manager';

type MilvusResultRow = {
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

type MilvusCollectionListPayload = {
    data?: Array<{ name?: unknown; timestamp?: unknown }>;
    collection_names?: unknown;
    collections?: unknown;
};

// Zilliz serverless collection removal can legitimately take substantially
// longer than the SDK's 15-second default. Keep the wider deadline scoped to
// this idempotent remote mutation; verification remains owned by
// deleteCollectionWithVerification.
const REMOTE_COLLECTION_DELETE_TIMEOUT_MS = 120_000;
// Bound the database mutation independently from embedding batches so a large
// provider-efficient embedding request does not become one oversized gRPC
// write. This ceiling is intentionally measured and tuned at the write owner.
// Same-corpus live runs completed without retries at 117 and 126 rows, while
// 135 rows exhausted fresh-client recovery. The 126-row run saved no wall time,
// so retain the wider reliability margin instead of defaulting near the cliff.
// Higher environment overrides are for controlled experiments, not a claim of
// provider-safe operation.
const DEFAULT_MILVUS_WRITE_MAX_ROWS = 117;
const HARD_MILVUS_WRITE_MAX_ROWS = 1_000;
const MIN_MILVUS_WRITE_MAX_BYTES = 64 * 1024;
const DEFAULT_MILVUS_WRITE_MAX_BYTES = 4 * 1024 * 1024;
const HARD_MILVUS_WRITE_MAX_BYTES = 32 * 1024 * 1024;
const MILVUS_WRITE_MAX_ATTEMPTS = 3;
const MILVUS_WRITE_RETRY_DELAY_MS = 250;
// Retain enough scalar-only attempt samples to derive exact request-size
// quantiles for normal rebuilds without allowing a long-lived runtime to grow
// an unbounded telemetry buffer. A summary reports when this window is too
// small for an operation, so truncated evidence cannot be mistaken for exact.
const MILVUS_WRITE_ATTEMPT_SAMPLE_LIMIT = 4_096;

type MilvusWriteBatch = {
    data: RowData[];
    serializedBytes: number;
    flushReason: Exclude<VectorWriteFlushReason, 'retry'>;
};

function resolveBoundedInteger(
    name: string,
    rawValue: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    if (!rawValue) return fallback;
    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        console.warn(`[MilvusDB] Ignoring invalid ${name}; expected an integer from ${minimum} to ${maximum}.`);
        return fallback;
    }
    return parsed;
}

function resolveWriteBatchPolicy(): { maxRows: number; maxBytes: number | null } {
    const maxRows = resolveBoundedInteger(
        'MILVUS_WRITE_MAX_ROWS',
        envManager.get('MILVUS_WRITE_MAX_ROWS'),
        DEFAULT_MILVUS_WRITE_MAX_ROWS,
        1,
        HARD_MILVUS_WRITE_MAX_ROWS,
    );
    const rawMaxBytes = envManager.get('MILVUS_WRITE_MAX_BYTES');
    let maxBytes: number | null = DEFAULT_MILVUS_WRITE_MAX_BYTES;
    if (rawMaxBytes) {
        const parsed = Number(rawMaxBytes);
        if (
            Number.isSafeInteger(parsed)
            && parsed >= MIN_MILVUS_WRITE_MAX_BYTES
            && parsed <= HARD_MILVUS_WRITE_MAX_BYTES
        ) {
            maxBytes = parsed;
        } else {
            console.warn(
                `[MilvusDB] Ignoring invalid MILVUS_WRITE_MAX_BYTES; expected an integer from ${MIN_MILVUS_WRITE_MAX_BYTES} to ${HARD_MILVUS_WRITE_MAX_BYTES}.`,
            );
        }
    }
    return { maxRows, maxBytes };
}

function splitMilvusWriteBatches(
    data: RowData[],
    maxRows: number,
    maxBytes: number | null,
): MilvusWriteBatch[] {
    const batches: MilvusWriteBatch[] = [];
    let batch: RowData[] = [];
    let batchBytes = 2; // JSON array brackets.

    const flush = (flushReason: MilvusWriteBatch['flushReason']): void => {
        if (batch.length === 0) return;
        const serializedBytes = Buffer.byteLength(JSON.stringify(batch), 'utf8');
        batches.push({ data: batch, serializedBytes, flushReason });
        batch = [];
        batchBytes = 2;
    };

    for (const row of data) {
        const serializedRow = JSON.stringify(row);
        if (serializedRow === undefined) {
            throw new Error('Milvus write row is not JSON serializable.');
        }
        const rowBytes = Buffer.byteLength(serializedRow, 'utf8');
        if (maxBytes !== null && rowBytes + 2 > maxBytes) {
            throw new Error(`Milvus write row requires ${rowBytes + 2} serialized bytes, exceeding the ${maxBytes}-byte request ceiling.`);
        }
        const separatorBytes = batch.length > 0 ? 1 : 0;
        const exceedsRows = batch.length >= maxRows;
        const exceedsBytes = maxBytes !== null
            && batch.length > 0
            && batchBytes + separatorBytes + rowBytes > maxBytes;
        if (exceedsRows || exceedsBytes) {
            flush(exceedsRows ? 'row_limit' : 'byte_limit');
        }
        batch.push(row);
        batchBytes += (batch.length > 1 ? 1 : 0) + rowBytes;
    }

    flush('logical_write_end');
    return batches;
}

type MilvusHybridSearchSingleRequest = {
    data: number[] | string;
    anns_field: string;
    params: VectorRecord;
    limit: number;
    expr?: string;
};

type MilvusHybridSearchParams = {
    collection_name: string;
    data: MilvusHybridSearchSingleRequest[];
    limit: number;
    rerank: {
        strategy: string;
        params: VectorRecord;
    };
    output_fields: string[];
    expr?: string;
};

type HybridVectorDocument = VectorDocument & {
    sparse_vector: never[];
};

const COLLECTION_LIMIT_PATTERNS = [
    /exceeded the limit number of collections/i,
    /collection limit/i,
    /too many collections/i,
    /quota.*collection/i,
];

function isRecord(value: unknown): value is VectorRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableMilvusWriteError(error: unknown): boolean {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 14 || code === '14') {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return (
        /\bUNAVAILABLE\b/i.test(message)
        || /connection dropped|connection reset|ECONNRESET|EPIPE|broken pipe/i.test(message)
        || /RST_STREAM|GOAWAY/i.test(message)
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function parseMetadata(value: unknown): VectorDocumentMetadata {
    if (isRecord(value)) {
        return value;
    }

    if (typeof value !== 'string' || value.length === 0) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function toVectorSearchResult(row: MilvusResultRow, vector: number[]): VectorSearchResult {
    return {
        document: {
            id: stringValue(row.id),
            vector,
            content: stringValue(row.content),
            relativePath: stringValue(row.relativePath),
            startLine: numberValue(row.startLine),
            endLine: numberValue(row.endLine),
            fileExtension: stringValue(row.fileExtension),
            metadata: parseMetadata(row.metadata),
        },
        score: numberValue(row.score),
    };
}

function toHybridSearchResult(row: MilvusResultRow): HybridSearchResult {
    const document: HybridVectorDocument = {
        id: stringValue(row.id),
        content: stringValue(row.content),
        vector: [],
        sparse_vector: [],
        relativePath: stringValue(row.relativePath),
        startLine: numberValue(row.startLine),
        endLine: numberValue(row.endLine),
        fileExtension: stringValue(row.fileExtension),
        metadata: parseMetadata(row.metadata),
    };

    return {
        document,
        score: numberValue(row.score),
    };
}

function collectErrorText(
    value: unknown,
    output: string[],
    visited: Set<unknown>,
    depth: number = 0
): void {
    if (value === null || value === undefined || depth > 4 || output.length >= 8) {
        return;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            output.push(trimmed);
        }
        return;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        output.push(String(value));
        return;
    }

    if (value instanceof Error) {
        collectErrorText(value.message, output, visited, depth + 1);
        collectErrorText((value as Error & { cause?: unknown }).cause, output, visited, depth + 1);
        return;
    }

    if (typeof value !== 'object') {
        return;
    }

    if (visited.has(value)) {
        return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectErrorText(item, output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
        return;
    }

    const record = value as Record<string, unknown>;
    const priorityKeys = ['message', 'reason', 'detail', 'details', 'error', 'msg', 'code', 'error_code'];
    for (const key of priorityKeys) {
        if (key in record) {
            collectErrorText(record[key], output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
    }

    for (const nestedValue of Object.values(record)) {
        collectErrorText(nestedValue, output, visited, depth + 1);
        if (output.length >= 8) {
            return;
        }
    }
}

function stringifyMilvusError(error: unknown): string {
    const messages: string[] = [];
    collectErrorText(error, messages, new Set());

    const deduped = Array.from(new Set(messages.map((message) => message.trim()).filter(Boolean)));
    if (deduped.length > 0) {
        return deduped.slice(0, 3).join(' | ');
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function isCollectionLimitErrorMessage(message: string): boolean {
    return COLLECTION_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
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

export interface MilvusConfig {
    address?: string;
    token?: string;
    username?: string;
    password?: string;
    ssl?: boolean;
}



export class MilvusVectorDatabase implements VectorDatabase {
    protected config: MilvusConfig;
    private client: MilvusClient | null = null;
    private writeClient: MilvusClient | null = null;
    protected initializationPromise: Promise<void>;
    private resolvedAddress: string | null = null;
    private resolvedFromToken: boolean = false;
    private readonly writeBatchMaxRows: number;
    private readonly writeBatchMaxBytes: number | null;
    private writeMetrics: VectorWriteMetricsSnapshot;

    constructor(config: MilvusConfig) {
        this.config = config;
        const writeBatchPolicy = resolveWriteBatchPolicy();
        this.writeBatchMaxRows = writeBatchPolicy.maxRows;
        this.writeBatchMaxBytes = writeBatchPolicy.maxBytes;
        this.writeMetrics = {
            providerRequestCount: 0,
            retryCount: 0,
            submittedRows: 0,
            submittedBytes: 0,
            durationMs: 0,
            rowLimit: this.writeBatchMaxRows,
            byteLimit: this.writeBatchMaxBytes,
            recentAttempts: [],
        };

        // Start initialization asynchronously without waiting
        this.initializationPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        const resolvedAddress = await this.resolveAddress();
        await this.initializeClient(resolvedAddress);
    }

    private async initializeClient(address: string): Promise<void> {
        const milvusConfig = this.config as MilvusConfig;
        console.log('🔌 Connecting to vector database at: ', address);
        this.client = new MilvusClient({
            address: address,
            username: milvusConfig.username,
            password: milvusConfig.password,
            token: milvusConfig.token,
            ssl: milvusConfig.ssl || false,
        });
    }

    private createWriteClient(): MilvusClient {
        if (!this.resolvedAddress) {
            throw new Error('Cannot initialize Milvus write client before resolving the database address.');
        }
        const milvusConfig = this.config as MilvusConfig;
        return new MilvusClient({
            address: this.resolvedAddress,
            username: milvusConfig.username,
            password: milvusConfig.password,
            token: milvusConfig.token,
            ssl: milvusConfig.ssl || false,
            // The SDK retries a failed write on the same gRPC call/channel. A
            // fresh client is required after proxy resets and is safe because
            // Satori chunk identities are deterministic and writes use upsert.
            maxRetries: 0,
            pool: { min: 1, max: 1 },
        });
    }

    private async discardWriteClient(client: MilvusClient): Promise<void> {
        if (this.writeClient !== client) {
            return;
        }
        this.writeClient = null;
        try {
            await client.closeConnection();
        } catch (error) {
            console.warn('[MilvusDB] Failed to close a stale write connection:', error);
        }
    }

    private async upsertDocuments(
        collectionName: string,
        data: RowData[],
    ): Promise<void> {
        await this.ensureInitialized();
        const maxRows = this.writeBatchMaxRows ?? DEFAULT_MILVUS_WRITE_MAX_ROWS;
        const maxBytes = this.writeBatchMaxBytes ?? null;
        const writeBatches = splitMilvusWriteBatches(data, maxRows, maxBytes);

        for (const writeBatch of writeBatches) {
            const batch = writeBatch.data;
            const submittedBytes = writeBatch.serializedBytes;

            for (let attempt = 1; attempt <= MILVUS_WRITE_MAX_ATTEMPTS; attempt += 1) {
                const client = this.writeClient ?? this.createWriteClient();
                this.writeClient = client;
                const startedAt = Date.now();
                const previousMetrics = this.writeMetrics ?? {
                    providerRequestCount: 0,
                    retryCount: 0,
                    submittedRows: 0,
                    submittedBytes: 0,
                    durationMs: 0,
                    rowLimit: maxRows,
                    byteLimit: maxBytes,
                    recentAttempts: [],
                };
                const sequence = previousMetrics.providerRequestCount + 1;
                const flushReason: VectorWriteFlushReason = attempt > 1
                    ? 'retry'
                    : writeBatch.flushReason;
                this.writeMetrics = {
                    ...previousMetrics,
                    providerRequestCount: sequence,
                    retryCount: previousMetrics.retryCount + (attempt > 1 ? 1 : 0),
                    submittedRows: previousMetrics.submittedRows + batch.length,
                    submittedBytes: previousMetrics.submittedBytes + submittedBytes,
                    recentAttempts: [
                        ...previousMetrics.recentAttempts,
                        { sequence, rows: batch.length, bytes: submittedBytes, flushReason },
                    ].slice(-MILVUS_WRITE_ATTEMPT_SAMPLE_LIMIT),
                };
                try {
                    await client.upsert({
                        collection_name: collectionName,
                        data: batch,
                    });
                    break;
                } catch (error) {
                    const retryable = isRetryableMilvusWriteError(error);
                    if (retryable) {
                        // Never retain a channel after a transport failure, including
                        // the last attempt; a later index operation shares this instance.
                        await this.discardWriteClient(client);
                    }
                    if (!retryable || attempt === MILVUS_WRITE_MAX_ATTEMPTS) {
                        console.error(
                            `[MilvusDB] Write failed: rows=${batch.length}, bytes=${submittedBytes}, attempt=${attempt}/${MILVUS_WRITE_MAX_ATTEMPTS}.`,
                        );
                        throw error;
                    }
                    console.warn(
                        `[MilvusDB] Retrying idempotent write on a fresh connection (${attempt}/${MILVUS_WRITE_MAX_ATTEMPTS - 1}); rows=${batch.length}, bytes=${submittedBytes}.`,
                    );
                    await delay(MILVUS_WRITE_RETRY_DELAY_MS * attempt);
                } finally {
                    this.writeMetrics = {
                        ...this.writeMetrics,
                        durationMs: this.writeMetrics.durationMs + (Date.now() - startedAt),
                    };
                }
            }
        }
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

        this.resolvedAddress = finalConfig.address;
        return finalConfig.address;
    }

    /**
     * Ensure initialization is complete before method execution
     */
    protected async ensureInitialized(): Promise<void> {
        await this.initializationPromise;
        if (!this.client) {
            throw new Error('Client not initialized');
        }
    }

    /**
     * Ensure collection is loaded before search/query operations
     */
    protected async ensureLoaded(collectionName: string): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        try {
            // Check if collection is loaded
            const result = await this.client.getLoadState({
                collection_name: collectionName
            });

            if (result.state !== LoadState.LoadStateLoaded) {
                console.log(`[MilvusDB] 🔄 Loading collection '${collectionName}' to memory...`);
                await this.client.loadCollection({
                    collection_name: collectionName,
                });
            }
        } catch (error) {
            console.error(`[MilvusDB] ❌ Failed to ensure collection '${collectionName}' is loaded:`, error);
            throw error;
        }
    }

    /**
     * Wait for an index to be ready before proceeding
     * Polls index build progress with exponential backoff up to 60 seconds
     */
    protected async waitForIndexReady(
        collectionName: string,
        fieldName: string,
        maxWaitTime: number = 60000, // 60 seconds
        initialInterval: number = 500, // 500ms
        maxInterval: number = 5000, // 5 seconds
        backoffMultiplier: number = 1.5
    ): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        let interval = initialInterval;
        const startTime = Date.now();

        console.log(`[MilvusDB] ⏳ Waiting for index on field '${fieldName}' in collection '${collectionName}' to be ready...`);

        while (Date.now() - startTime < maxWaitTime) {
            try {
                const indexBuildProgress = await this.client.getIndexBuildProgress({
                    collection_name: collectionName,
                    field_name: fieldName
                });

                // Debug logging to understand the progress
                console.log(`[MilvusDB] 📊 Index build progress for '${fieldName}': indexed_rows=${indexBuildProgress.indexed_rows}, total_rows=${indexBuildProgress.total_rows}`);
                console.log(`[MilvusDB] 📊 Full response:`, JSON.stringify(indexBuildProgress));

                // Check if index building is complete
                if (indexBuildProgress.indexed_rows === indexBuildProgress.total_rows) {
                    console.log(`[MilvusDB] ✅ Index on field '${fieldName}' is ready! (${indexBuildProgress.indexed_rows}/${indexBuildProgress.total_rows} rows indexed)`);
                    return;
                }

                // Check for error status
                if (indexBuildProgress.status && indexBuildProgress.status.error_code !== 'Success') {
                    // Handle known issue with older Milvus versions where sparse vector index progress returns incorrect error
                    if (indexBuildProgress.status.reason && indexBuildProgress.status.reason.includes('index duplicates[indexName=]')) {
                        console.log(`[MilvusDB] ⚠️  Index progress check returned known older Milvus issue: ${indexBuildProgress.status.reason}`);
                        console.log(`[MilvusDB] ⚠️  This is a known issue with older Milvus versions - treating as index ready`);
                        return; // Treat as ready since this is a false error
                    }
                    throw new Error(`Index creation failed for field '${fieldName}' in collection '${collectionName}': ${indexBuildProgress.status.reason}`);
                }

                console.log(`[MilvusDB] 📊 Index building in progress: ${indexBuildProgress.indexed_rows}/${indexBuildProgress.total_rows} rows indexed`);

                // Wait with exponential backoff
                await new Promise(resolve => setTimeout(resolve, interval));
                interval = Math.min(interval * backoffMultiplier, maxInterval);

            } catch (error) {
                console.error(`[MilvusDB] ❌ Error checking index build progress for field '${fieldName}':`, error);
                throw error;
            }
        }

        throw new Error(`Timeout waiting for index on field '${fieldName}' in collection '${collectionName}' to be ready after ${maxWaitTime}ms`);
    }

    /**
     * Load collection with retry logic and exponential backoff
     * Retries up to 5 times with exponential backoff
     */
    protected async loadCollectionWithRetry(
        collectionName: string,
        maxRetries: number = 5,
        initialInterval: number = 1000, // 1 second
        backoffMultiplier: number = 2
    ): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        let attempt = 1;
        let interval = initialInterval;

        while (attempt <= maxRetries) {
            try {
                console.log(`[MilvusDB] 🔄 Loading collection '${collectionName}' to memory (attempt ${attempt}/${maxRetries})...`);

                await this.client.loadCollection({
                    collection_name: collectionName,
                });

                console.log(`[MilvusDB] ✅ Collection '${collectionName}' loaded successfully!`);
                return;

            } catch (error) {
                console.error(`[MilvusDB] ❌ Failed to load collection '${collectionName}' on attempt ${attempt}:`, error);

                if (attempt === maxRetries) {
                    throw new Error(`Failed to load collection '${collectionName}' after ${maxRetries} attempts: ${error}`);
                }

                // Wait with exponential backoff before retry
                console.log(`[MilvusDB] ⏳ Retrying collection load in ${interval}ms...`);
                await new Promise(resolve => setTimeout(resolve, interval));
                interval *= backoffMultiplier;
                attempt++;
            }
        }
    }

    async createCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        await this.ensureInitialized();

        console.log('Beginning collection creation:', collectionName);
        console.log('Collection dimension:', dimension);
        const schema = [
            {
                name: 'id',
                description: 'Document ID',
                data_type: DataType.VarChar,
                max_length: 512,
                is_primary_key: true,
            },
            {
                name: 'vector',
                description: 'Embedding vector',
                data_type: DataType.FloatVector,
                dim: dimension,
            },
            {
                name: 'content',
                description: 'Document content',
                data_type: DataType.VarChar,
                max_length: 65535,
            },
            {
                name: 'relativePath',
                description: 'Relative path to the codebase',
                data_type: DataType.VarChar,
                max_length: 1024,
            },
            {
                name: 'startLine',
                description: 'Start line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'endLine',
                description: 'End line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'fileExtension',
                description: 'File extension',
                data_type: DataType.VarChar,
                max_length: 32,
            },
            {
                name: 'metadata',
                description: 'Additional document metadata as JSON string',
                data_type: DataType.VarChar,
                max_length: 65535,
            },
        ];

        const createCollectionParams = {
            collection_name: collectionName,
            description: description || `Satori collection: ${collectionName}`,
            fields: schema,
        };

        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        await this.client.createCollection(createCollectionParams);

        // Create index
        const indexParams = {
            collection_name: collectionName,
            field_name: 'vector',
            index_name: 'vector_index',
            index_type: 'AUTOINDEX',
            metric_type: MetricType.COSINE,
        };

        console.log(`[MilvusDB] 🔧 Creating index for field 'vector' in collection '${collectionName}'...`);
        await this.client.createIndex(indexParams);

        // Wait for index to be ready before loading collection
        await this.waitForIndexReady(collectionName, 'vector');

        // Load collection to memory with retry logic
        await this.loadCollectionWithRetry(collectionName);

        // Verify collection is created correctly
        await this.client.describeCollection({
            collection_name: collectionName,
        });
    }

    async dropCollection(collectionName: string): Promise<void> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        await this.client.dropCollection({
            collection_name: collectionName,
            timeout: REMOTE_COLLECTION_DELETE_TIMEOUT_MS,
        });
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const result = await this.client.hasCollection({
            collection_name: collectionName,
        });

        return Boolean(result.value);
    }

    async listCollections(): Promise<string[]> {
        const details = await this.listCollectionDetails();
        return details.map((collection) => collection.name);
    }

    async listCollectionDetails(): Promise<CollectionDetails[]> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const result = await this.client.showCollections();
        const payload = result as unknown as MilvusCollectionListPayload;

        if (Array.isArray(payload?.data)) {
            return payload.data
                .map((entry) => {
                    const name = stringValue(entry.name);
                    const rawTimestamp = entry.timestamp;
                    let createdAt: string | undefined;

                    if (rawTimestamp !== null && rawTimestamp !== undefined && rawTimestamp !== '') {
                        try {
                            const unixSeconds = Number(hybridtsToUnixtime(String(rawTimestamp)));
                            if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
                                createdAt = new Date(unixSeconds * 1000).toISOString();
                            }
                        } catch {
                            // Best-effort only; keep createdAt undefined when timestamp parsing fails.
                        }
                    }

                    return { name, createdAt };
                })
                .filter((entry: CollectionDetails) => entry.name.length > 0);
        }

        // Legacy response fallback
        const collections = payload?.collection_names || payload?.collections || [];
        if (!Array.isArray(collections)) {
            return [];
        }

        return collections
            .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
            .map((name) => ({ name }));
    }

    getBackendInfo(): VectorStoreBackendInfo {
        const address = this.resolvedAddress || this.config.address;
        const isZilliz = Boolean(address && looksLikeZillizAddress(address)) || this.resolvedFromToken;

        return {
            provider: isZilliz ? 'zilliz' : 'milvus',
            transport: 'grpc',
            address,
        };
    }

    getWriteMetricsSnapshot(): VectorWriteMetricsSnapshot {
        return {
            ...this.writeMetrics,
            recentAttempts: this.writeMetrics.recentAttempts.map((attempt) => ({ ...attempt })),
        };
    }

    async insert(collectionName: string, documents: VectorDocument[]): Promise<void> {
        console.log('Inserting documents into collection:', collectionName);
        const data = documents.map(doc => ({
            id: doc.id,
            vector: doc.vector,
            content: doc.content,
            relativePath: doc.relativePath,
            startLine: doc.startLine,
            endLine: doc.endLine,
            fileExtension: doc.fileExtension,
            metadata: JSON.stringify(doc.metadata),
        }));

        await this.upsertDocuments(collectionName, data);
    }

    async search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const searchParams: SearchSimpleReq = {
            collection_name: collectionName,
            data: [queryVector],
            limit: options?.topK || 10,
            output_fields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
        };

        // Apply boolean expression filter if provided (e.g., fileExtension in [".ts",".py"]) 
        if (options?.filterExpr && options.filterExpr.trim().length > 0) {
            searchParams.expr = options.filterExpr;
        }

        const searchResult = await this.client.search(searchParams);

        if (!searchResult.results || searchResult.results.length === 0) {
            return [];
        }

        const resultRows = searchResult.results as unknown as MilvusResultRow[];
        return resultRows
            .map((result) => toVectorSearchResult(result, queryVector))
            .filter((result: VectorSearchResult) => options?.threshold === undefined || result.score >= options.threshold);
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        await this.client.delete({
            collection_name: collectionName,
            filter: buildMilvusIdInFilter(ids),
        });
    }

    async query(collectionName: string, filter: string, outputFields: string[], limit?: number): Promise<VectorRecord[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        try {
            const queryParams: QueryReq = {
                collection_name: collectionName,
                filter: filter,
                output_fields: outputFields,
            };

            // Add limit if provided, or default for empty filter expressions
            if (limit !== undefined) {
                queryParams.limit = limit;
            } else if (filter === '' || filter.trim() === '') {
                // Milvus requires limit when using empty expressions
                queryParams.limit = 16384; // Default limit for empty filters
            }

            const result = await this.client.query(queryParams);

            if (result.status.error_code !== 'Success') {
                throw new Error(`Failed to query Milvus: ${result.status.reason}`);
            }

            return Array.isArray(result.data)
                ? result.data.filter(isRecord)
                : [];
        } catch (error) {
            console.error(`[MilvusDB] ❌ Failed to query collection '${collectionName}':`, error);
            throw error;
        }
    }

    async count(collectionName: string, filter: string): Promise<number> {
        const rows = await this.query(collectionName, filter, ['count(*)']);
        const rawCount = rows[0]?.['count(*)'] ?? rows[0]?.count;
        const count = Number(rawCount);
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error(`Milvus returned an invalid row count for collection '${collectionName}'.`);
        }
        return count;
    }

    async createHybridCollection(
        collectionName: string,
        dimension: number,
        description?: string,
        options?: CollectionCreateOptions,
    ): Promise<void> {
        await this.ensureInitialized();

        console.log('Beginning hybrid collection creation:', collectionName);
        console.log('Collection dimension:', dimension);

        const schema = [
            {
                name: 'id',
                description: 'Document ID',
                data_type: DataType.VarChar,
                max_length: 512,
                is_primary_key: true,
            },
            {
                name: 'content',
                description: 'Full text content for BM25 and storage',
                data_type: DataType.VarChar,
                max_length: 65535,
                enable_analyzer: true,
            },
            {
                name: 'vector',
                description: 'Dense vector embedding',
                data_type: DataType.FloatVector,
                dim: dimension,
            },
            {
                name: 'sparse_vector',
                description: 'Sparse vector embedding from BM25',
                data_type: DataType.SparseFloatVector,
            },
            {
                name: 'relativePath',
                description: 'Relative path to the codebase',
                data_type: DataType.VarChar,
                max_length: 1024,
            },
            {
                name: 'startLine',
                description: 'Start line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'endLine',
                description: 'End line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'fileExtension',
                description: 'File extension',
                data_type: DataType.VarChar,
                max_length: 32,
            },
            {
                name: 'metadata',
                description: 'Additional document metadata as JSON string',
                data_type: DataType.VarChar,
                max_length: 65535,
            },
        ];

        // Add BM25 function
        const functions = [
            {
                name: "content_bm25_emb",
                description: "content bm25 function",
                type: FunctionType.BM25,
                input_field_names: ["content"],
                output_field_names: ["sparse_vector"],
                params: {},
            },
        ];

        const createCollectionParams = {
            collection_name: collectionName,
            description: description || `Hybrid code context collection: ${collectionName}`,
            fields: schema,
            functions: functions,
        };

        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        await this.client.createCollection(createCollectionParams);

        if (options?.deferIndexBuild) {
            // Zilliz supports schema-only, unloaded collections. Full rebuilds use that
            // state only for ingestion; search and marker reads must wait for finalization.
            return;
        }

        await this.finalizeCollectionForSearch(collectionName);
    }

    async finalizeCollectionForSearch(collectionName: string): Promise<void> {
        await this.ensureInitialized();
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        // Create indexes for both vector fields
        // Index for dense vector
        const denseIndexParams = {
            collection_name: collectionName,
            field_name: 'vector',
            index_name: 'vector_index',
            index_type: 'AUTOINDEX',
            metric_type: MetricType.COSINE,
        };
        console.log(`[MilvusDB] 🔧 Creating dense vector index for field 'vector' in collection '${collectionName}'...`);
        await this.client.createIndex(denseIndexParams);

        // Wait for dense vector index to be ready
        await this.waitForIndexReady(collectionName, 'vector');

        // Index for sparse vector
        const sparseIndexParams = {
            collection_name: collectionName,
            field_name: 'sparse_vector',
            index_name: 'sparse_vector_index',
            index_type: 'SPARSE_INVERTED_INDEX',
            metric_type: MetricType.BM25,
        };
        console.log(`[MilvusDB] 🔧 Creating sparse vector index for field 'sparse_vector' in collection '${collectionName}'...`);

        await this.client.createIndex(sparseIndexParams);

        // Wait for sparse vector index to be ready
        await this.waitForIndexReady(collectionName, 'sparse_vector');

        // Load collection to memory with retry logic
        await this.loadCollectionWithRetry(collectionName);

        // Verify collection is created correctly
        await this.client.describeCollection({
            collection_name: collectionName,
        });
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void> {
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

        await this.upsertDocuments(collectionName, data);
    }

    async hybridSearch(collectionName: string, searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        try {
            // Generate OpenAI embedding for the first search request (dense)
            console.log(`[MilvusDB] 🔍 Preparing hybrid search for collection: ${collectionName}`);

            // Prepare search requests in the correct Milvus format
            const search_param_1: MilvusHybridSearchSingleRequest = {
                data: searchRequests[0].data,
                anns_field: searchRequests[0].anns_field, // "vector"
                params: searchRequests[0].param, // {"nprobe": 10}
                limit: searchRequests[0].limit
            };

            const search_param_2: MilvusHybridSearchSingleRequest = {
                data: searchRequests[1].data, // query text for sparse search
                anns_field: searchRequests[1].anns_field, // "sparse_vector"
                params: searchRequests[1].param, // {"drop_ratio_search": 0.2}
                limit: searchRequests[1].limit
            };

            // Set rerank strategy to RRF (100) by default
            const rerank_strategy = {
                strategy: "rrf",
                params: {
                    k: 100
                }
            };

            console.log(`[MilvusDB] 🔍 Dense search params:`, JSON.stringify({
                anns_field: search_param_1.anns_field,
                params: search_param_1.params,
                limit: search_param_1.limit,
                data_length: Array.isArray(search_param_1.data) ? search_param_1.data.length : 'N/A'
            }, null, 2));
            console.log(`[MilvusDB] 🔍 Sparse search params:`, JSON.stringify({
                anns_field: search_param_2.anns_field,
                params: search_param_2.params,
                limit: search_param_2.limit,
                query_text: typeof search_param_2.data === 'string' ? search_param_2.data.substring(0, 50) + '...' : 'N/A'
            }, null, 2));
            console.log(`[MilvusDB] 🔍 Rerank strategy:`, JSON.stringify(rerank_strategy, null, 2));

            // Execute hybrid search using the correct client.search format
            const searchParams: MilvusHybridSearchParams = {
                collection_name: collectionName,
                data: [search_param_1, search_param_2],
                limit: options?.limit || searchRequests[0]?.limit || 10,
                rerank: rerank_strategy,
                output_fields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
            };

            if (options?.filterExpr && options.filterExpr.trim().length > 0) {
                searchParams.expr = options.filterExpr;
            }

            console.log(`[MilvusDB] 🔍 Complete search request:`, JSON.stringify({
                collection_name: searchParams.collection_name,
                data_count: searchParams.data.length,
                limit: searchParams.limit,
                rerank: searchParams.rerank,
                output_fields: searchParams.output_fields,
                expr: searchParams.expr
            }, null, 2));

            const searchResult = await this.client.search(searchParams as unknown as HybridSearchReq);

            console.log(`[MilvusDB] 🔍 Search executed, processing results...`);

            if (!searchResult.results || searchResult.results.length === 0) {
                console.log(`[MilvusDB] ⚠️  No results returned from Milvus search`);
                return [];
            }

            console.log(`[MilvusDB] ✅ Found ${searchResult.results.length} results from hybrid search`);

            // Transform results to HybridSearchResult format
            const resultRows = searchResult.results as unknown as MilvusResultRow[];
            return resultRows
                .map(toHybridSearchResult)
                .filter((result: HybridSearchResult) => options?.threshold === undefined || result.score >= options.threshold);

        } catch (error) {
            console.error(`[MilvusDB] ❌ Failed to perform hybrid search on collection '${collectionName}':`, error);
            throw error;
        }
    }

    async sparseSearch(
        collectionName: string,
        queryText: string,
        options?: SparseSearchOptions,
    ): Promise<HybridSearchResult[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const searchParams: SearchSimpleReq = {
            collection_name: collectionName,
            data: [queryText],
            anns_field: 'sparse_vector',
            limit: options?.topK ?? 10,
            metric_type: 'BM25',
            params: {
                drop_ratio_search: options?.dropRatioSearch ?? 0.2,
            },
            output_fields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
        };
        if (options?.filterExpr && options.filterExpr.trim().length > 0) {
            searchParams.expr = options.filterExpr;
        }

        const searchResult = await this.client.search(searchParams);
        if (!searchResult.results || searchResult.results.length === 0) {
            return [];
        }
        return (searchResult.results as unknown as MilvusResultRow[]).map(toHybridSearchResult);
    }

    /**
     * Wrapper method to handle collection creation with limit detection for gRPC client
     * Returns true if collection can be created, false if limit exceeded
     */
    async checkCollectionLimit(): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        const collectionName = `dummy_collection_${Date.now()}`;
        const createCollectionParams = {
            collection_name: collectionName,
            description: 'Test collection for limit check',
            fields: [
                {
                    name: 'id',
                    data_type: DataType.VarChar,
                    max_length: 512,
                    is_primary_key: true,
                },
                {
                    name: 'vector',
                    data_type: DataType.FloatVector,
                    dim: 128,
                }
            ]
        };

        try {
            await this.client.createCollection(createCollectionParams);
            await deleteCollectionWithVerification(this, collectionName);
            return true;
        } catch (error: unknown) {
            const errorMessage = stringifyMilvusError(error);
            if (isCollectionLimitErrorMessage(errorMessage)) {
                // Return false for collection limit exceeded
                return false;
            }
            // Re-throw with useful details instead of generic [object Object]
            throw new Error(errorMessage);
        }
    }
}
