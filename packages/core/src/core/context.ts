import {
    Splitter,
    CodeChunk,
    AstCodeSplitter
} from '../splitter';
import {
    Embedding,
    EmbeddingVector,
    OpenAIEmbedding
} from '../embedding';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    IndexCompletionFingerprint,
    IndexCompletionMarkerDocument,
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    INDEX_COMPLETION_MARKER_RELATIVE_PATH
} from '../vectordb';
import { SemanticSearchResult } from '../types';
import { envManager } from '../utils/env-manager';
import { DEFAULT_IGNORE_PATTERNS, DEFAULT_SUPPORTED_EXTENSIONS } from '../config/defaults';
import { getLanguageIdFromExtension } from '../language';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import ignore from 'ignore';
import { FileSynchronizer } from '../sync/synchronizer';

export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
}

interface CodebaseIgnoreState {
    fileBasedPatterns: string[];
    effectivePatterns: string[];
    matcher: ReturnType<typeof ignore> | null;
}

export class Context {
    private embedding: Embedding;
    private vectorDatabase: VectorDatabase;
    private codeSplitter: Splitter;
    private supportedExtensions: string[];
    private baseIgnorePatterns: string[];
    private runtimeCustomIgnorePatterns: string[];
    private ignoreStateByCollection: Map<string, CodebaseIgnoreState>;
    private synchronizers = new Map<string, FileSynchronizer>();

    constructor(config: ContextConfig = {}) {
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: envManager.get('OPENAI_API_KEY') || 'your-openai-api-key',
            model: 'text-embedding-3-small',
            ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
        });

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;

        this.codeSplitter = config.codeSplitter || new AstCodeSplitter(2500, 300);

        // Load custom extensions from environment variables
        const envCustomExtensions = this.getCustomExtensionsFromEnv();

        // Combine default extensions with config extensions and env extensions
        const allSupportedExtensions = [
            ...DEFAULT_SUPPORTED_EXTENSIONS,
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...envCustomExtensions
        ];
        // Remove duplicates
        this.supportedExtensions = [...new Set(allSupportedExtensions)];

        // Load custom ignore patterns from environment variables
        const envCustomIgnorePatterns = this.getCustomIgnorePatternsFromEnv();

        // Base ignore patterns (defaults + static config + env)
        const allIgnorePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...envCustomIgnorePatterns
        ];
        // Runtime custom ignore patterns added via MCP/manage_index
        this.baseIgnorePatterns = [...new Set(allIgnorePatterns)];
        this.runtimeCustomIgnorePatterns = [];
        this.ignoreStateByCollection = new Map();

        console.log(`[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.baseIgnorePatterns.length + this.runtimeCustomIgnorePatterns.length} base/runtime ignore patterns`);
        if (envCustomExtensions.length > 0) {
            console.log(`[Context] 📎 Loaded ${envCustomExtensions.length} custom extensions from environment: ${envCustomExtensions.join(', ')}`);
        }
        if (envCustomIgnorePatterns.length > 0) {
            console.log(`[Context] 🚫 Loaded ${envCustomIgnorePatterns.length} custom ignore patterns from environment: ${envCustomIgnorePatterns.join(', ')}`);
        }
    }

    /**
     * Get embedding instance
     */
    getEmbeddingEngine(): Embedding {
        return this.embedding;
    }

    /**
     * Get vector database instance
     */
    getVectorStore(): VectorDatabase {
        return this.vectorDatabase;
    }

    /**
     * Get code splitter instance
     */
    getChunkSplitter(): Splitter {
        return this.codeSplitter;
    }

    /**
     * Get supported extensions
     */
    getIndexedExtensions(): string[] {
        return [...this.supportedExtensions];
    }

    /**
     * Get effective ignore patterns.
     * When codebasePath is provided, returns per-codebase effective rules.
     * Without a codebase path, returns global base+runtime layers only.
     */
    getActiveIgnorePatterns(codebasePath?: string): string[] {
        if (!codebasePath) {
            return [...new Set([...this.baseIgnorePatterns, ...this.runtimeCustomIgnorePatterns])];
        }
        return [...this.getOrCreateIgnoreState(codebasePath).effectivePatterns];
    }

    /**
     * Get synchronizers map
     */
    getActiveSynchronizers(): Map<string, FileSynchronizer> {
        return new Map(this.synchronizers);
    }

    /**
     * Set synchronizer for a collection
     */
    registerSynchronizer(collectionName: string, synchronizer: FileSynchronizer): void {
        this.synchronizers.set(collectionName, synchronizer);
    }

    /**
     * Public wrapper for loadIgnorePatterns private method
     */
    async loadResolvedIgnorePatterns(codebasePath: string): Promise<void> {
        return this.loadIgnorePatterns(codebasePath);
    }

    /**
     * Reload ignore rules for a codebase and return the effective pattern list.
     * This is deterministic (replace semantics), not append-only.
     */
    async reloadIgnoreRulesForCodebase(codebasePath: string): Promise<string[]> {
        await this.loadIgnorePatterns(codebasePath);
        return this.getActiveIgnorePatterns(codebasePath);
    }

    /**
     * Public wrapper for prepareCollection private method
     */
    async ensureCollectionPrepared(codebasePath: string): Promise<void> {
        return this.prepareCollection(codebasePath);
    }

    /**
     * Recreate synchronizer for a codebase using currently active ignore patterns.
     * This is used when ignore rules change and we need deterministic reconciliation.
     */
    async recreateSynchronizerForCodebase(codebasePath: string): Promise<void> {
        const collectionName = this.resolveCollectionName(codebasePath);
        const synchronizer = new FileSynchronizer(codebasePath, this.getActiveIgnorePatterns(codebasePath));
        await synchronizer.initialize();
        this.synchronizers.set(collectionName, synchronizer);
    }

    /**
     * Return currently tracked (indexable under active ignore rules) relative paths
     * from the active synchronizer snapshot for this codebase.
     */
    getTrackedRelativePaths(codebasePath: string): string[] {
        const collectionName = this.resolveCollectionName(codebasePath);
        const synchronizer = this.synchronizers.get(collectionName);
        if (!synchronizer) {
            return [];
        }
        return this.normalizeRelativePathsForCodebase(codebasePath, synchronizer.getTrackedRelativePaths());
    }

    hasSynchronizerForCodebase(codebasePath: string): boolean {
        return this.synchronizers.has(this.resolveCollectionName(codebasePath));
    }

    /**
     * Delete indexed chunks for a list of relative paths in a codebase.
     * Returns the number of file paths processed for deletion.
     */
    async deleteIndexedPathsByRelativePaths(codebasePath: string, relativePaths: string[]): Promise<number> {
        const collectionName = this.resolveCollectionName(codebasePath);
        const uniquePaths = Array.from(new Set(this.normalizeRelativePathsForCodebase(codebasePath, relativePaths)));

        for (const relativePath of uniquePaths) {
            await this.deleteFileChunks(collectionName, relativePath);
        }
        return uniquePaths.length;
    }

    /**
     * Get isHybrid setting from environment variable with default true
     */
    private getIsHybrid(): boolean {
        const isHybridEnv = envManager.get('HYBRID_MODE');
        if (isHybridEnv === undefined || isHybridEnv === null) {
            return true; // Default to true
        }
        return isHybridEnv.toLowerCase() === 'true';
    }

    /**
     * Generate collection name based on codebase path and hybrid mode
     */
    public resolveCollectionName(codebasePath: string): string {
        const isHybrid = this.getIsHybrid();
        const canonicalPath = this.canonicalizeCodebasePath(codebasePath);
        const hash = crypto.createHash('md5').update(canonicalPath).digest('hex');
        const prefix = isHybrid === true ? 'hybrid_code_chunks' : 'code_chunks';
        return `${prefix}_${hash.substring(0, 8)}`;
    }

    /**
     * Index a codebase for semantic search
     * @param codebasePath Codebase root path
     * @param progressCallback Optional progress callback function
     * @param forceReindex Whether to recreate the collection even if it exists
     * @returns Indexing statistics
     */
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);

        // 1. Load ignore patterns from various ignore files
        await this.loadIgnorePatterns(codebasePath);

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        await this.prepareCollection(codebasePath, forceReindex);

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const codeFiles = await this.getCodeFiles(codebasePath);
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        // 3. Process each file with streaming chunk processing
        // Reserve 10% for preparation, 90% for actual indexing
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 100;
        const indexingRange = indexingEndPercentage - indexingStartPercentage;

        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            (filePath, fileIndex, totalFiles) => {
                // Calculate progress percentage
                const progressPercentage = indexingStartPercentage + (fileIndex / totalFiles) * indexingRange;

                console.log(`[Context] 📊 Processed ${fileIndex}/${totalFiles} files`);
                progressCallback?.({
                    phase: `Processing files (${fileIndex}/${totalFiles})...`,
                    current: fileIndex,
                    total: totalFiles,
                    percentage: Math.round(progressPercentage)
                });
            }
        );

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

        progressCallback?.({
            phase: 'Indexing complete!',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100
        });

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status
        };
    }

    async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<{ added: number; removed: number; modified: number; changedFiles: string[] }> {
        const collectionName = this.resolveCollectionName(codebasePath);
        const synchronizer = this.synchronizers.get(collectionName);

        if (!synchronizer) {
            // Load project-specific ignore patterns before creating FileSynchronizer
            await this.loadIgnorePatterns(codebasePath);

            // To be safe, let's initialize if it's not there.
            const newSynchronizer = new FileSynchronizer(codebasePath, this.getActiveIgnorePatterns(codebasePath));
            await newSynchronizer.initialize();
            this.synchronizers.set(collectionName, newSynchronizer);
        }

        const currentSynchronizer = this.synchronizers.get(collectionName)!;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const { added, removed, modified } = await currentSynchronizer.checkForChanges();
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);

        let processedChanges = 0;
        const updateProgress = (phase: string) => {
            processedChanges++;
            const percentage = Math.round((processedChanges / (removed.length + modified.length + added.length)) * 100);
            progressCallback?.({ phase, current: processedChanges, total: totalChanges, percentage });
        };

        // Handle removed files
        for (const file of removed) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Removed ${file}`);
        }

        // Handle modified files
        for (const file of modified) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Deleted old chunks for ${file}`);
        }

        // Handle added and modified files
        const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));

        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => {
                    updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`);
                }
            );
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        return {
            added: added.length,
            removed: removed.length,
            modified: modified.length,
            changedFiles: Array.from(new Set([...added, ...removed, ...modified]))
        };
    }

    private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
        // Escape backslashes for Milvus query expression (Windows path compatibility)
        const escapedPath = relativePath.replace(/\\/g, '\\\\');
        const results = await this.vectorDatabase.query(
            collectionName,
            `relativePath == "${escapedPath}"`,
            ['id']
        );

        if (results.length > 0) {
            const ids = results.map(r => r.id as string).filter(id => id);
            if (ids.length > 0) {
                await this.vectorDatabase.delete(collectionName, ids);
                console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
            }
        }
    }

    /**
     * Semantic search with unified implementation
     * @param codebasePath Codebase path to search in
     * @param query Search query
     * @param topK Number of results to return
     * @param threshold Similarity threshold
     */
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);
        const effectiveFilterExpr = this.buildSemanticSearchFilterExpr(filterExpr);

        const normalizeBreadcrumbs = (value: unknown): string[] | undefined => {
            if (!Array.isArray(value)) {
                return undefined;
            }
            const normalized = value
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
                .slice(0, 2);
            return normalized.length > 0 ? normalized : undefined;
        };

        const collectionName = this.resolveCollectionName(codebasePath);
        console.log(`[Context] 🔍 Using collection: ${collectionName}`);

        // Check if collection exists and has data
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            console.log(`[Context] ⚠️  Collection '${collectionName}' does not exist. Please index the codebase first.`);
            return [];
        }

        if (isHybrid === true) {
            try {
                // Check collection stats to see if it has data
                const stats = await this.vectorDatabase.query(collectionName, '', ['id'], 1);
                console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
            } catch (error) {
                console.log(`[Context] ⚠️  Collection '${collectionName}' exists but may be empty or not properly indexed:`, error);
            }

            // 1. Generate query vector
            console.log(`[Context] 🔍 Generating embeddings for query: "${query}"`);
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
            console.log(`[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);
            console.log(`[Context] 🔍 First 5 embedding values: [${queryEmbedding.vector.slice(0, 5).join(', ')}]`);

            // 2. Prepare hybrid search requests
            const searchRequests: HybridSearchRequest[] = [
                {
                    data: queryEmbedding.vector,
                    anns_field: "vector",
                    param: { "nprobe": 10 },
                    limit: topK
                },
                {
                    data: query,
                    anns_field: "sparse_vector",
                    param: { "drop_ratio_search": 0.2 },
                    limit: topK
                }
            ];

            console.log(`[Context] 🔍 Search request 1 (dense): anns_field="${searchRequests[0].anns_field}", vector_dim=${queryEmbedding.vector.length}, limit=${searchRequests[0].limit}`);
            console.log(`[Context] 🔍 Search request 2 (sparse): anns_field="${searchRequests[1].anns_field}", query_text="${query}", limit=${searchRequests[1].limit}`);

            // 3. Execute hybrid search
            console.log(`[Context] 🔍 Executing hybrid search with RRF reranking...`);
            const searchResults: HybridSearchResult[] = await this.vectorDatabase.hybridSearch(
                collectionName,
                searchRequests,
                {
                    rerank: {
                        strategy: 'rrf',
                        params: { k: 100 }
                    },
                    limit: topK,
                    filterExpr: effectiveFilterExpr
                }
            );

            console.log(`[Context] 🔍 Raw search results count: ${searchResults.length}`);

            // 4. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => ({
                content: result.document.content,
                relativePath: result.document.relativePath,
                startLine: result.document.startLine,
                endLine: result.document.endLine,
                language: result.document.metadata.language || 'unknown',
                score: result.score,
                breadcrumbs: normalizeBreadcrumbs(result.document.metadata.breadcrumbs),
                indexedAt: typeof result.document.metadata.indexedAt === 'string' ? result.document.metadata.indexedAt : undefined,
                symbolId: typeof result.document.metadata.symbolId === 'string' ? result.document.metadata.symbolId : undefined,
                symbolLabel: typeof result.document.metadata.symbolLabel === 'string' ? result.document.metadata.symbolLabel : undefined
            }));

            console.log(`[Context] ✅ Found ${results.length} relevant hybrid results`);
            if (results.length > 0) {
                console.log(`[Context] 🔍 Top result score: ${results[0].score}, path: ${results[0].relativePath}`);
            }

            return results;
        } else {
            // Regular semantic search
            // 1. Generate query vector
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);

            // 2. Search in vector database
            const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
                collectionName,
                queryEmbedding.vector,
                { topK, threshold, filterExpr: effectiveFilterExpr }
            );

            // 3. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => ({
                content: result.document.content,
                relativePath: result.document.relativePath,
                startLine: result.document.startLine,
                endLine: result.document.endLine,
                language: result.document.metadata.language || 'unknown',
                score: result.score,
                breadcrumbs: normalizeBreadcrumbs(result.document.metadata.breadcrumbs),
                indexedAt: typeof result.document.metadata.indexedAt === 'string' ? result.document.metadata.indexedAt : undefined,
                symbolId: typeof result.document.metadata.symbolId === 'string' ? result.document.metadata.symbolId : undefined,
                symbolLabel: typeof result.document.metadata.symbolLabel === 'string' ? result.document.metadata.symbolLabel : undefined
            }));

            console.log(`[Context] ✅ Found ${results.length} relevant results`);
            return results;
        }
    }

    private buildSemanticSearchFilterExpr(filterExpr?: string): string {
        const markerExclusion = `fileExtension != "${INDEX_COMPLETION_MARKER_FILE_EXTENSION}"`;
        if (!filterExpr || filterExpr.trim().length === 0) {
            return markerExclusion;
        }
        return `(${filterExpr}) and (${markerExclusion})`;
    }

    private async queryCompletionMarkerRows(collectionName: string): Promise<Record<string, any>[]> {
        return this.vectorDatabase.query(
            collectionName,
            `id == "${INDEX_COMPLETION_MARKER_DOC_ID}"`,
            ['id', 'metadata'],
            8
        );
    }

    async clearIndexCompletionMarker(codebasePath: string): Promise<void> {
        const collectionName = this.resolveCollectionName(codebasePath);
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            return;
        }

        const rows = await this.queryCompletionMarkerRows(collectionName);
        const markerIds = rows
            .map((row) => (typeof row.id === 'string' ? row.id : ''))
            .filter((id) => id.length > 0);
        if (markerIds.length === 0) {
            return;
        }
        await this.vectorDatabase.delete(collectionName, Array.from(new Set(markerIds)));
    }

    async writeIndexCompletionMarker(codebasePath: string, marker: IndexCompletionMarkerDocument): Promise<void> {
        const collectionName = this.resolveCollectionName(codebasePath);
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            throw new Error(`Cannot write completion marker: collection '${collectionName}' does not exist.`);
        }

        await this.clearIndexCompletionMarker(codebasePath);

        const vector = new Array<number>(this.embedding.getDimension()).fill(0);
        const markerDoc: VectorDocument = {
            id: INDEX_COMPLETION_MARKER_DOC_ID,
            vector,
            content: 'satori index completion marker',
            relativePath: INDEX_COMPLETION_MARKER_RELATIVE_PATH,
            startLine: 0,
            endLine: 0,
            fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
            metadata: marker,
        };

        if (this.getIsHybrid() === true) {
            await this.vectorDatabase.insertHybrid(collectionName, [markerDoc]);
        } else {
            await this.vectorDatabase.insert(collectionName, [markerDoc]);
        }
    }

    async getIndexCompletionMarker(codebasePath: string): Promise<IndexCompletionMarkerDocument | null> {
        const collectionName = this.resolveCollectionName(codebasePath);
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            return null;
        }

        const rows = await this.queryCompletionMarkerRows(collectionName);
        for (const row of rows) {
            const rawMetadata = row?.metadata;
            if (typeof rawMetadata !== 'string') {
                continue;
            }
            try {
                const parsed = JSON.parse(rawMetadata) as Partial<IndexCompletionMarkerDocument>;
                if (parsed?.kind !== 'satori_index_completion_v1') {
                    continue;
                }
                if (typeof parsed.codebasePath !== 'string' || typeof parsed.runId !== 'string') {
                    continue;
                }
                if (!parsed.fingerprint || typeof parsed.fingerprint !== 'object') {
                    continue;
                }
                const indexedFiles = Number(parsed.indexedFiles);
                const totalChunks = Number(parsed.totalChunks);
                if (!Number.isFinite(indexedFiles) || !Number.isFinite(totalChunks)) {
                    continue;
                }
                if (typeof parsed.completedAt !== 'string' || Number.isNaN(Date.parse(parsed.completedAt))) {
                    continue;
                }
                return {
                    kind: 'satori_index_completion_v1',
                    codebasePath: parsed.codebasePath,
                    fingerprint: parsed.fingerprint as IndexCompletionFingerprint,
                    indexedFiles,
                    totalChunks,
                    completedAt: parsed.completedAt,
                    runId: parsed.runId,
                };
            } catch {
                continue;
            }
        }

        return null;
    }

    /**
     * Check if index exists for codebase
     * @param codebasePath Codebase path to check
     * @returns Whether index exists
     */
    async hasIndexedCollection(codebasePath: string): Promise<boolean> {
        const collectionName = this.resolveCollectionName(codebasePath);
        return await this.vectorDatabase.hasCollection(collectionName);
    }

    /**
     * Clear index
     * @param codebasePath Codebase path to clear index for
     * @param progressCallback Optional progress callback function
     */
    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        const collectionName = this.resolveCollectionName(codebasePath);
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        if (collectionExists) {
            await this.vectorDatabase.dropCollection(collectionName);
        }

        // Delete snapshot file
        await FileSynchronizer.deleteSnapshot(codebasePath);

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        console.log('[Context] ✅ Index data cleaned');
    }

    /**
     * Update base ignore patterns (replace semantics, then rebuild effective set).
     * @param ignorePatterns Array of base ignore patterns
     */
    updateIgnorePatterns(ignorePatterns: string[]): void {
        this.baseIgnorePatterns = [...new Set([...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns])];
        this.rebuildAllIgnoreStates();
        console.log(`[Context] 🚫 Updated base ignore patterns. Base total: ${this.baseIgnorePatterns.length}`);
    }

    /**
     * Add custom ignore patterns (from MCP or other sources) without replacing existing ones
     * @param customPatterns Array of custom ignore patterns to add
     */
    addCustomIgnorePatterns(customPatterns: string[]): void {
        if (customPatterns.length === 0) return;

        this.runtimeCustomIgnorePatterns = [
            ...new Set([...this.runtimeCustomIgnorePatterns, ...customPatterns])
        ];
        this.rebuildAllIgnoreStates();
        console.log(`[Context] 🚫 Added ${customPatterns.length} custom ignore patterns. Runtime total: ${this.runtimeCustomIgnorePatterns.length}`);
    }

    /**
     * Reset ignore patterns to defaults only
     */
    resetIgnorePatternsToDefaults(): void {
        this.baseIgnorePatterns = [...DEFAULT_IGNORE_PATTERNS];
        this.runtimeCustomIgnorePatterns = [];
        this.rebuildAllIgnoreStates();
        console.log(`[Context] 🔄 Reset ignore patterns to defaults: ${this.baseIgnorePatterns.length} patterns`);
    }

    private buildEffectiveIgnorePatterns(fileBasedPatterns: string[]): string[] {
        return [
            ...new Set([
                ...this.baseIgnorePatterns,
                ...this.runtimeCustomIgnorePatterns,
                ...fileBasedPatterns
            ])
        ];
    }

    private rebuildAllIgnoreStates(): void {
        for (const [collectionName, state] of this.ignoreStateByCollection.entries()) {
            this.ignoreStateByCollection.set(collectionName, {
                ...state,
                effectivePatterns: this.buildEffectiveIgnorePatterns(state.fileBasedPatterns),
                matcher: null,
            });
        }
    }

    private getOrCreateIgnoreState(codebasePath: string): CodebaseIgnoreState {
        const collectionName = this.resolveCollectionName(codebasePath);
        const existing = this.ignoreStateByCollection.get(collectionName);
        if (existing) {
            return existing;
        }

        const initial: CodebaseIgnoreState = {
            fileBasedPatterns: [],
            effectivePatterns: this.buildEffectiveIgnorePatterns([]),
            matcher: null,
        };
        this.ignoreStateByCollection.set(collectionName, initial);
        return initial;
    }

    private setFileBasedPatternsForCodebase(codebasePath: string, fileBasedPatterns: string[]): void {
        const collectionName = this.resolveCollectionName(codebasePath);
        const normalizedFileBased = [
            ...new Set(
                fileBasedPatterns
                    .filter((pattern): pattern is string => typeof pattern === 'string')
                    .map((pattern) => pattern.trim())
                    .filter((pattern) => pattern.length > 0)
            )
        ];

        const nextState: CodebaseIgnoreState = {
            fileBasedPatterns: normalizedFileBased,
            effectivePatterns: this.buildEffectiveIgnorePatterns(normalizedFileBased),
            matcher: null,
        };
        this.ignoreStateByCollection.set(collectionName, nextState);
    }

    private getIgnoreMatcherForCodebase(codebasePath: string): ReturnType<typeof ignore> {
        const collectionName = this.resolveCollectionName(codebasePath);
        const state = this.getOrCreateIgnoreState(codebasePath);
        if (!state.matcher) {
            const matcher = ignore();
            matcher.add(state.effectivePatterns);
            state.matcher = matcher;
            this.ignoreStateByCollection.set(collectionName, state);
        }
        return state.matcher;
    }

    private canonicalizeCodebasePath(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        try {
            const realPath = typeof fs.realpathSync.native === 'function'
                ? fs.realpathSync.native(resolved)
                : fs.realpathSync(resolved);
            return this.trimTrailingSeparators(path.normalize(realPath));
        } catch {
            return this.trimTrailingSeparators(path.normalize(resolved));
        }
    }

    private trimTrailingSeparators(inputPath: string): string {
        const parsedRoot = path.parse(inputPath).root;
        if (inputPath === parsedRoot) {
            return inputPath;
        }
        return inputPath.replace(/[\\/]+$/, '');
    }

    private normalizeRelativePathForCodebase(codebasePath: string, candidatePath: string): string | null {
        if (typeof candidatePath !== 'string') {
            return null;
        }

        const trimmed = candidatePath.trim();
        if (trimmed.length === 0) {
            return null;
        }

        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const normalizedCandidate = trimmed.replace(/\\/g, '/');
        let relativePath = normalizedCandidate;

        if (path.isAbsolute(trimmed)) {
            const resolvedCandidate = path.resolve(trimmed);
            relativePath = path.relative(canonicalRoot, resolvedCandidate).replace(/\\/g, '/');
            // Symlink-safe fallback: if canonical-root relative path is invalid,
            // retry against resolved (non-realpathed) root before dropping.
            if (!relativePath || relativePath.startsWith('..')) {
                const resolvedRoot = this.trimTrailingSeparators(path.normalize(path.resolve(codebasePath)));
                relativePath = path.relative(resolvedRoot, resolvedCandidate).replace(/\\/g, '/');
            }
        }

        relativePath = relativePath.replace(/^\/+/, '');
        if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) {
            return null;
        }

        return relativePath;
    }

    private normalizeRelativePathsForCodebase(codebasePath: string, relativePaths: string[]): string[] {
        const normalized: string[] = [];
        for (const candidatePath of relativePaths) {
            const normalizedPath = this.normalizeRelativePathForCodebase(codebasePath, candidatePath);
            if (!normalizedPath) {
                continue;
            }
            normalized.push(normalizedPath);
        }
        return Array.from(new Set(normalized)).sort();
    }

    /**
     * Update embedding instance
     * @param embedding New embedding instance
     */
    updateEmbedding(embedding: Embedding): void {
        this.embedding = embedding;
        console.log(`[Context] 🔄 Updated embedding provider: ${embedding.getProvider()}`);
    }

    /**
     * Update vector database instance
     * @param vectorDatabase New vector database instance
     */
    updateVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.vectorDatabase = vectorDatabase;
        console.log(`[Context] 🔄 Updated vector database`);
    }

    /**
     * Update splitter instance
     * @param splitter New splitter instance
     */
    updateSplitter(splitter: Splitter): void {
        this.codeSplitter = splitter;
        console.log(`[Context] 🔄 Updated splitter instance`);
    }

    /**
     * Prepare vector collection
     */
    private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = this.resolveCollectionName(codebasePath);

        // Check if collection already exists
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        if (collectionExists && !forceReindex) {
            console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
            return;
        }

        if (collectionExists && forceReindex) {
            console.log(`[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`);
            await this.vectorDatabase.dropCollection(collectionName);
            console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
        }

        console.log(`[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`);
        const dimension = await this.embedding.detectDimension();
        console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);
        const dirName = path.basename(codebasePath);

        if (isHybrid === true) {
            await this.vectorDatabase.createHybridCollection(collectionName, dimension, `Hybrid Index for ${dirName}`);
        } else {
            await this.vectorDatabase.createCollection(collectionName, dimension, `Index for ${dirName}`);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);
    }

    /**
     * Recursively get all code files in the codebase
     */
    private async getCodeFiles(codebasePath: string): Promise<string[]> {
        const files: string[] = [];

        const traverseDirectory = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                // Check if path matches ignore patterns
                if (this.matchesIgnorePattern(fullPath, codebasePath, entry.isDirectory())) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverseDirectory(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.includes(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        return files;
    }

    /**
 * Process a list of files with streaming chunk processing
 * @param filePaths Array of file paths to process
 * @param codebasePath Base path for the codebase
 * @param onFileProcessed Callback called when each file is processed
 * @returns Object with processed file count and total chunk count
 */
    private async processFileList(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const EMBEDDING_BATCH_SIZE = Math.max(1, parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '100', 10));
        const CHUNK_LIMIT = 450000;
        console.log(`[Context] 🔧 Using EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);

        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];

            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await this.codeSplitter.split(content, language, filePath);

                // Log files with many chunks or large content
                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                // Add chunks to buffer
                for (const chunk of chunks) {
                    chunkBuffer.push({ chunk, codebasePath });
                    totalChunks++;

                    // Process batch when buffer reaches EMBEDDING_BATCH_SIZE
                    if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE) {
                        try {
                            await this.processChunkBuffer(chunkBuffer);
                        } catch (error) {
                            const searchType = isHybrid === true ? 'hybrid' : 'regular';
                            console.error(`[Context] ❌ Failed to process chunk batch for ${searchType}:`, error);
                            if (error instanceof Error) {
                                console.error('[Context] Stack trace:', error.stack);
                            }
                        } finally {
                            chunkBuffer = []; // Always clear buffer, even on failure
                        }
                    }

                    // Check if chunk limit is reached
                    if (totalChunks >= CHUNK_LIMIT) {
                        console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                        limitReached = true;
                        break; // Exit the inner loop (over chunks)
                    }
                }

                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length);

                if (limitReached) {
                    break; // Exit the outer loop (over files)
                }

            } catch (error) {
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
            }
        }

        // Process any remaining chunks in the buffer
        if (chunkBuffer.length > 0) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
            try {
                await this.processChunkBuffer(chunkBuffer);
            } catch (error) {
                console.error(`[Context] ❌ Failed to process final chunk batch for ${searchType}:`, error);
                if (error instanceof Error) {
                    console.error('[Context] Stack trace:', error.stack);
                }
            }
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
    }

    /**
 * Process accumulated chunk buffer
 */
    private async processChunkBuffer(chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>): Promise<void> {
        if (chunkBuffer.length === 0) return;

        // Extract chunks and ensure they all have the same codebasePath
        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        await this.processChunkBatch(chunks, codebasePath);
    }

    /**
     * Process a batch of chunks
     */
    private async processChunkBatch(chunks: CodeChunk[], codebasePath: string): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const indexedAt = new Date().toISOString();

        // Generate embedding vectors
        const chunkContents = chunks.map(chunk => chunk.content);
        const embeddings = await this.embedding.embedBatch(chunkContents);

        if (isHybrid === true) {
            // Create hybrid vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    content: chunk.content, // Full text content for BM25 and storage
                    vector: embeddings[index].vector, // Dense vector
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index,
                        indexedAt
                    }
                };
            });

            // Store to vector database
            await this.vectorDatabase.insertHybrid(this.resolveCollectionName(codebasePath), documents);
        } else {
            // Create regular vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    vector: embeddings[index].vector,
                    content: chunk.content,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index,
                        indexedAt
                    }
                };
            });

            // Store to vector database
            await this.vectorDatabase.insert(this.resolveCollectionName(codebasePath), documents);
        }
    }

    /**
     * Get programming language based on file extension
     */
    private getLanguageFromExtension(ext: string): string {
        return getLanguageIdFromExtension(ext, 'text');
    }

    /**
     * Generate unique ID based on chunk content and location
     * @param relativePath Relative path to the file
     * @param startLine Start line number
     * @param endLine End line number
     * @param content Chunk content
     * @returns Hash-based unique ID
     */
    private generateId(relativePath: string, startLine: number, endLine: number, content: string): string {
        const combinedString = `${relativePath}:${startLine}:${endLine}:${content}`;
        const hash = crypto.createHash('sha256').update(combinedString, 'utf-8').digest('hex');
        return `chunk_${hash.substring(0, 16)}`;
    }

    /**
     * Read ignore patterns from file (e.g., .gitignore)
     * @param filePath Path to the ignore file
     * @returns Array of ignore patterns
     */
    static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#')); // Filter out empty lines and comments
        } catch (error) {
            console.warn(`[Context] ⚠️  Could not read ignore file ${filePath}: ${error}`);
            return [];
        }
    }

    /**
     * Load ignore patterns from various ignore files in the codebase.
     * This uses replace semantics for file-based patterns to avoid stale rules.
     */
    private async loadIgnorePatterns(codebasePath: string): Promise<void> {
        try {
            let fileBasedPatterns: string[] = [];

            // v1 policy: only repo-root .satoriignore and .gitignore are supported.
            const ignoreFiles = await this.findIgnoreFiles(codebasePath);
            for (const ignoreFile of ignoreFiles) {
                const patterns = await this.loadIgnoreFile(ignoreFile, path.basename(ignoreFile));
                fileBasedPatterns.push(...patterns);
            }

            this.setFileBasedPatternsForCodebase(codebasePath, fileBasedPatterns);
            if (fileBasedPatterns.length > 0) {
                console.log(`[Context] 🚫 Loaded total ${fileBasedPatterns.length} ignore patterns from supported root ignore files`);
            } else {
                console.log('📄 No ignore files found; effective rules reset to base + runtime custom');
            }
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to load ignore patterns: ${error}`);
            // Keep existing patterns on failure to avoid destructive behavior.
        }
    }

    /**
     * Find supported root ignore files in the codebase directory.
     * v1 policy: only repo-root .satoriignore and .gitignore are loaded.
     * @param codebasePath Path to the codebase
     * @returns Array of ignore file paths
     */
    private async findIgnoreFiles(codebasePath: string): Promise<string[]> {
        try {
            const ignoreFiles: string[] = [];
            const supportedIgnoreFiles = ['.satoriignore', '.gitignore'];

            for (const fileName of supportedIgnoreFiles) {
                const absolutePath = path.join(codebasePath, fileName);
                try {
                    const stat = await fs.promises.stat(absolutePath);
                    if (stat.isFile()) {
                        ignoreFiles.push(absolutePath);
                    }
                } catch {
                    // Missing ignore file is expected.
                }
            }

            if (ignoreFiles.length > 0) {
                console.log(`📄 Found ignore files: ${ignoreFiles.map(f => path.basename(f)).join(', ')}`);
            }

            return ignoreFiles;
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to scan for ignore files: ${error}`);
            return [];
        }
    }

    /**
     * Load ignore patterns from a specific ignore file
     * @param filePath Path to the ignore file
     * @param fileName Display name for logging
     * @returns Array of ignore patterns
     */
    private async loadIgnoreFile(filePath: string, fileName: string): Promise<string[]> {
        try {
            await fs.promises.access(filePath);
            console.log(`📄 Found ${fileName} file at: ${filePath}`);

            const ignorePatterns = await Context.getIgnorePatternsFromFile(filePath);

            if (ignorePatterns.length > 0) {
                console.log(`[Context] 🚫 Loaded ${ignorePatterns.length} ignore patterns from ${fileName}`);
                return ignorePatterns;
            } else {
                console.log(`📄 ${fileName} file found but no valid patterns detected`);
                return [];
            }
        } catch (error) {
            if (fileName.includes('global')) {
                console.log(`📄 No ${fileName} file found`);
            }
            return [];
        }
    }

    /**
     * Check if a path matches any ignore pattern
     * @param filePath Path to check
     * @param codebasePath Codebase root path used for relative pattern matching
     * @param isDirectory Whether the path is a directory
     * @returns True if path should be ignored
     */
    private matchesIgnorePattern(filePath: string, codebasePath: string, isDirectory: boolean = false): boolean {
        const effectivePatterns = this.getActiveIgnorePatterns(codebasePath);
        if (effectivePatterns.length === 0) {
            return false;
        }

        const relativePath = path.relative(codebasePath, filePath).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relativePath || relativePath.startsWith('..')) {
            return false;
        }

        const matcher = this.getIgnoreMatcherForCodebase(codebasePath);

        if (isDirectory) {
            const withSlash = relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
            return matcher.ignores(relativePath) || matcher.ignores(withSlash);
        }

        return matcher.ignores(relativePath);
    }

    /**
     * Get custom extensions from environment variables
     * Supports CUSTOM_EXTENSIONS as comma-separated list
     * @returns Array of custom extensions
     */
    private getCustomExtensionsFromEnv(): string[] {
        const envExtensions = envManager.get('CUSTOM_EXTENSIONS');
        if (!envExtensions) {
            return [];
        }

        try {
            const extensions = envExtensions
                .split(',')
                .map(ext => ext.trim())
                .filter(ext => ext.length > 0)
                .map(ext => ext.startsWith('.') ? ext : `.${ext}`); // Ensure extensions start with dot

            return extensions;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_EXTENSIONS: ${error}`);
            return [];
        }
    }

    /**
     * Get custom ignore patterns from environment variables
     * Supports CUSTOM_IGNORE_PATTERNS as comma-separated list
     * @returns Array of custom ignore patterns
     */
    private getCustomIgnorePatternsFromEnv(): string[] {
        const envIgnorePatterns = envManager.get('CUSTOM_IGNORE_PATTERNS');
        if (!envIgnorePatterns) {
            return [];
        }

        try {
            const patterns = envIgnorePatterns
                .split(',')
                .map(pattern => pattern.trim())
                .filter(pattern => pattern.length > 0);

            return patterns;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_IGNORE_PATTERNS: ${error}`);
            return [];
        }
    }

    /**
     * Add custom extensions (from MCP or other sources) without replacing existing ones
     * @param customExtensions Array of custom extensions to add
     */
    addCustomExtensions(customExtensions: string[]): void {
        if (customExtensions.length === 0) return;

        // Ensure extensions start with dot
        const normalizedExtensions = customExtensions.map(ext =>
            ext.startsWith('.') ? ext : `.${ext}`
        );

        // Merge current extensions with new custom extensions, avoiding duplicates
        const mergedExtensions = [...this.supportedExtensions, ...normalizedExtensions];
        const uniqueExtensions: string[] = [...new Set(mergedExtensions)];
        this.supportedExtensions = uniqueExtensions;
        console.log(`[Context] 📎 Added ${customExtensions.length} custom extensions. Total: ${this.supportedExtensions.length} extensions`);
    }

    /**
     * Get current splitter information
     */
    getSplitterInfo(): { type: string; hasBuiltinFallback: boolean; supportedLanguages?: string[] } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            return {
                type: 'ast',
                hasBuiltinFallback: true,
                supportedLanguages: AstCodeSplitter.getSupportedLanguages()
            };
        } else {
            return {
                type: 'langchain',
                hasBuiltinFallback: false
            };
        }
    }

    /**
     * Check if current splitter supports a specific language
     * @param language Programming language
     */
    isLanguageSupported(language: string): boolean {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            return AstCodeSplitter.isLanguageSupported(language);
        }

        // LangChain splitter supports most languages
        return true;
    }

    /**
     * Get which strategy would be used for a specific language
     * @param language Programming language
     */
    getSplitterStrategyForLanguage(language: string): { strategy: 'ast' | 'langchain'; reason: string } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const isSupported = AstCodeSplitter.isLanguageSupported(language);

            return {
                strategy: isSupported ? 'ast' : 'langchain',
                reason: isSupported
                    ? 'Language supported by AST parser'
                    : 'Language not supported by AST, will fallback to LangChain'
            };
        } else {
            return {
                strategy: 'langchain',
                reason: 'Using LangChain splitter directly'
            };
        }
    }
}
