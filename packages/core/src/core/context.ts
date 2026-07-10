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
    HybridSearchResult,
    RetrievalMode,
    ScorePolicy,
    IndexCompletionFingerprint,
    IndexCompletionMarkerDocument,
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    INDEX_COMPLETION_MARKER_RELATIVE_PATH,
    deleteCollectionWithVerification
} from '../vectordb';
import { buildMilvusIdInFilter, escapeMilvusStringLiteral } from '../vectordb/filters';
import { SemanticSearchRequest, SemanticSearchResult } from '../types';
import { envManager } from '../utils/env-manager';
import {
    DEFAULT_IGNORE_PATTERNS,
    IndexProfile,
    getSupportedExtensionsForIndexProfile,
} from '../config/defaults';
import {
    isIndexableFileByPolicy,
    normalizeSupportedExtensions,
} from '../config/index-policy';
import { loadSatoriRepoConfig, SatoriRepoConfig } from '../config/repo-config';
import { getLanguageIdFromFilename } from '../language';
import {
    importNavigationToSqlite,
    resolveNavigationSqlitePath,
} from '../navigation';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
    clearSymbolRegistrySidecar,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveOwnerSymbolForChunk,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from '../symbols';
import type {
    SymbolRecord,
    SymbolRegistry,
    SymbolRegistryManifestFile,
} from '../symbols';
import { getSymbolExtractorForLanguage } from '../languages/extractors';
import type { ExtractedSymbol } from '../languages';
import { buildRelationshipsForRegistry } from '../relationships';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import ignore from 'ignore';
import { FileSynchronizer } from '../sync/synchronizer';
import type {
    RepairIndexResult,
    RepairProof,
    RepairSnapshotEvidence,
} from './repair-proof';

export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    symbolRegistryStateRoot?: string;
}

interface CodebaseIgnoreState {
    fileBasedPatterns: string[];
    effectivePatterns: string[];
    matcher: ReturnType<typeof ignore> | null;
}

type RepairIndexOptions = {
    snapshotEvidence?: RepairSnapshotEvidence;
    preferredCollectionName?: string;
    assertMutationCurrent?: () => void;
    onProofUpdate?: (proof: RepairProof) => void;
};

type RepairCompletionMarkerResolution =
    | { status: 'missing' }
    | { status: 'malformed' }
    | { status: 'matched'; marker: IndexCompletionMarkerDocument };

type ReindexByChangeOptions = {
    targetCollectionName?: string;
    maintainCompletionMarker?: boolean;
    assertMutationCurrent?: () => void;
};

type MutationGuardOptions = {
    assertMutationCurrent?: () => void;
};

type ReindexByChangeResult = {
    added: number;
    removed: number;
    modified: number;
    changedFiles: string[];
    navigationRecovery?: 'rebuilt' | 'failed';
    collectionName?: string;
};

type ExpectedIndexedChunk = {
    id: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    content: string;
    language: string;
    chunkIndex: number;
};

type CollectionPayloadVerification =
    | { ok: true; indexedFiles: number; totalChunks: number }
    | { ok: false; message: string };

export class Context {
    private embedding: Embedding;
    private vectorDatabase: VectorDatabase;
    private codeSplitter: Splitter;
    private supportedExtensions: string[];
    private configuredExtensionOverlays: string[];
    private runtimeCustomExtensions: string[];
    private indexProfilesByCodebase: Map<string, IndexProfile>;
    private baseIgnorePatterns: string[];
    private runtimeCustomIgnorePatterns: string[];
    private ignoreStateByCollection: Map<string, CodebaseIgnoreState>;
    private synchronizers = new Map<string, FileSynchronizer>();
    private reindexByChangeQueues = new Map<string, Promise<void>>();
    private writeCollectionOverrides = new Map<string, string>();
    private symbolRegistryStateRoot?: string;

    constructor(config: ContextConfig = {}) {
        // Initialize services
        if (config.embedding) {
            this.embedding = config.embedding;
        } else {
            const openAiApiKey = envManager.get('OPENAI_API_KEY');
            if (!openAiApiKey) {
                throw new Error('OPENAI_API_KEY is required when no embedding implementation is provided.');
            }
            this.embedding = new OpenAIEmbedding({
                apiKey: openAiApiKey,
                model: 'text-embedding-3-small',
                ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
            });
        }

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;

        this.codeSplitter = config.codeSplitter || new AstCodeSplitter(2500, 300);

        // Load custom extensions from environment variables
        const envCustomExtensions = this.getCustomExtensionsFromEnv();

        this.configuredExtensionOverlays = normalizeSupportedExtensions([
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...envCustomExtensions
        ]);
        this.runtimeCustomExtensions = [];
        this.indexProfilesByCodebase = new Map();
        this.supportedExtensions = this.buildSupportedExtensions('default');

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
        this.symbolRegistryStateRoot = config.symbolRegistryStateRoot;

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

    getIndexedExtensionsForCodebase(codebasePath: string): string[] {
        const profile = this.indexProfilesByCodebase.get(this.canonicalizeCodebasePath(codebasePath)) || 'default';
        return this.buildSupportedExtensions(profile);
    }

    loadIndexProfileForCodebase(codebasePath: string): SatoriRepoConfig {
        const config = loadSatoriRepoConfig(codebasePath);
        this.setIndexProfileForCodebase(codebasePath, config.profile);
        return config;
    }

    setIndexProfileForCodebase(codebasePath: string, profile: IndexProfile): void {
        this.indexProfilesByCodebase.set(this.canonicalizeCodebasePath(codebasePath), profile);
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
    async ensureCollectionPrepared(codebasePath: string, assertMutationCurrent?: () => void): Promise<void> {
        return this.prepareCollection(codebasePath, false, assertMutationCurrent);
    }

    /**
     * Recreate synchronizer for a codebase using currently active ignore patterns.
     * This is used when ignore rules change and we need deterministic reconciliation.
     */
    async recreateSynchronizerForCodebase(codebasePath: string, assertMutationCurrent?: () => void): Promise<void> {
        this.loadIndexProfileForCodebase(codebasePath);
        const collectionName = this.resolveCollectionName(codebasePath);
        const synchronizer = new FileSynchronizer(
            codebasePath,
            this.getActiveIgnorePatterns(codebasePath),
            this.getIndexedExtensionsForCodebase(codebasePath)
        );
        await synchronizer.initialize(assertMutationCurrent);
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
    async deleteIndexedPathsByRelativePaths(
        codebasePath: string,
        relativePaths: string[],
        assertMutationCurrent?: () => void,
    ): Promise<number> {
        const collectionName = await this.getActiveIndexedCollectionName(codebasePath) || this.getWriteCollectionName(codebasePath);
        const uniquePaths = Array.from(new Set(this.normalizeRelativePathsForCodebase(codebasePath, relativePaths)));

        for (const relativePath of uniquePaths) {
            await this.deleteFileChunks(collectionName, relativePath, assertMutationCurrent);
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

    private buildCollectionFamilies(codebasePath: string): {
        canonicalRoot: string;
        hash: string;
        activeFamilyName: string;
        alternateFamilyName: string;
    } {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const hash = crypto.createHash('md5').update(canonicalRoot).digest('hex').substring(0, 8);
        const activeFamilyName = this.resolveCollectionName(codebasePath);
        const alternateFamilyName = activeFamilyName.startsWith('hybrid_code_chunks_')
            ? `code_chunks_${hash}`
            : `hybrid_code_chunks_${hash}`;
        return {
            canonicalRoot,
            hash,
            activeFamilyName,
            alternateFamilyName,
        };
    }

    private isRelatedCollectionName(collectionName: string, familyName: string): boolean {
        return collectionName === familyName || collectionName.startsWith(`${familyName}__gen_`);
    }

    private getWriteCollectionName(codebasePath: string): string {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.writeCollectionOverrides.get(canonicalRoot) || this.resolveCollectionName(codebasePath);
    }

    private async listRelatedCollectionNames(codebasePath: string): Promise<string[]> {
        const { activeFamilyName, alternateFamilyName } = this.buildCollectionFamilies(codebasePath);

        try {
            const collectionNames = await this.vectorDatabase.listCollections();
            return collectionNames
                .filter((collectionName) =>
                    this.isRelatedCollectionName(collectionName, activeFamilyName)
                    || this.isRelatedCollectionName(collectionName, alternateFamilyName)
                )
                .sort((left, right) => left.localeCompare(right));
        } catch {
            const fallbackNames = [activeFamilyName, alternateFamilyName];
            const existingNames: string[] = [];
            for (const familyName of fallbackNames) {
                try {
                    if (await this.vectorDatabase.hasCollection(familyName)) {
                        existingNames.push(familyName);
                    }
                } catch {
                    continue;
                }
            }
            return existingNames.sort((left, right) => left.localeCompare(right));
        }
    }

    private parseCompletionMarker(
        codebasePath: string,
        rawMetadata: unknown
    ): IndexCompletionMarkerDocument | null {
        const parsed = (() => {
            if (typeof rawMetadata === 'string') {
                try {
                    return JSON.parse(rawMetadata) as Partial<IndexCompletionMarkerDocument>;
                } catch {
                    return null;
                }
            }
            if (rawMetadata && typeof rawMetadata === 'object') {
                return rawMetadata as Partial<IndexCompletionMarkerDocument>;
            }
            return null;
        })();

        if (!parsed || parsed.kind !== 'satori_index_completion_v1') {
            return null;
        }
        if (typeof parsed.codebasePath !== 'string' || typeof parsed.runId !== 'string') {
            return null;
        }
        if (!parsed.fingerprint || typeof parsed.fingerprint !== 'object') {
            return null;
        }

        const indexedFiles = Number(parsed.indexedFiles);
        const totalChunks = Number(parsed.totalChunks);
        if (!Number.isFinite(indexedFiles) || !Number.isFinite(totalChunks)) {
            return null;
        }
        if (typeof parsed.completedAt !== 'string' || Number.isNaN(Date.parse(parsed.completedAt))) {
            return null;
        }

        const parsedCodebasePath = this.canonicalizeCodebasePath(parsed.codebasePath);
        const expectedCodebasePath = this.canonicalizeCodebasePath(codebasePath);
        if (parsedCodebasePath !== expectedCodebasePath) {
            return null;
        }

        const indexStatus = parsed.indexStatus === 'limit_reached' || parsed.indexStatus === 'completed'
            ? parsed.indexStatus
            : undefined;

        return {
            kind: 'satori_index_completion_v1',
            codebasePath: parsedCodebasePath,
            fingerprint: parsed.fingerprint as IndexCompletionFingerprint,
            indexedFiles,
            totalChunks,
            completedAt: parsed.completedAt,
            runId: parsed.runId,
            ...(indexStatus ? { indexStatus } : {}),
        };
    }

    private async resolveCompletionMarkerForCollection(
        codebasePath: string,
        collectionName: string
    ): Promise<IndexCompletionMarkerDocument | null> {
        const rows = await this.queryCompletionMarkerRows(collectionName);
        for (const row of rows) {
            const marker = this.parseCompletionMarker(codebasePath, row?.metadata);
            if (marker) {
                return marker;
            }
        }
        return null;
    }

    private async resolveRepairCompletionMarkerForCollection(
        codebasePath: string,
        collectionName: string,
    ): Promise<RepairCompletionMarkerResolution> {
        const rows = await this.queryCompletionMarkerRows(collectionName);
        if (rows.length === 0) {
            return { status: 'missing' };
        }
        for (const row of rows) {
            const marker = this.parseCompletionMarker(codebasePath, row?.metadata);
            if (marker) {
                return { status: 'matched', marker };
            }
        }
        return { status: 'malformed' };
    }

    private async collectionHasIndexedPayload(
        collectionName: string,
        marker: IndexCompletionMarkerDocument
    ): Promise<boolean> {
        if (marker.totalChunks <= 0) {
            return true;
        }

        const rows = await this.vectorDatabase.query(collectionName, '', ['id'], 8);
        return rows.some((row) => {
            const id = typeof row?.id === 'string' ? row.id : '';
            return id !== INDEX_COMPLETION_MARKER_DOC_ID;
        });
    }

    private async collectionHasAnyIndexedPayload(collectionName: string): Promise<boolean> {
        const rows = await this.vectorDatabase.query(collectionName, 'fileExtension != ".satori_meta"', ['id'], 1);
        return rows.some((row) => typeof row?.id === 'string' && row.id !== INDEX_COMPLETION_MARKER_DOC_ID);
    }

    private getEmbeddingModelForFingerprint(): string {
        const embeddingWithConfig = this.embedding as unknown as {
            config?: {
                model?: unknown;
            };
        };
        const model = embeddingWithConfig.config?.model;
        return typeof model === 'string' && model.trim().length > 0
            ? model.trim()
            : this.embedding.getProvider();
    }

    private buildIndexCompletionFingerprint(): IndexCompletionFingerprint {
        return {
            embeddingProvider: this.embedding.getProvider(),
            embeddingModel: this.getEmbeddingModelForFingerprint(),
            embeddingDimension: this.embedding.getDimension(),
            vectorStoreProvider: 'Milvus',
            schemaVersion: this.getIsHybrid() === true ? 'hybrid_v3' : 'dense_v3',
        };
    }

    private indexCompletionFingerprintsMatch(left: unknown, right: IndexCompletionFingerprint): boolean {
        if (!left || typeof left !== 'object') {
            return false;
        }
        const record = left as Record<string, unknown>;
        return record.embeddingProvider === right.embeddingProvider
            && record.embeddingModel === right.embeddingModel
            && Number(record.embeddingDimension) === Number(right.embeddingDimension)
            && record.vectorStoreProvider === right.vectorStoreProvider
            && record.schemaVersion === right.schemaVersion;
    }

    private async writeCompletedIndexMarker(
        codebasePath: string,
        indexedFiles: number,
        totalChunks: number,
        collectionName?: string,
        indexStatus: 'completed' | 'limit_reached' = 'completed',
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        await this.writeIndexCompletionMarker(codebasePath, {
            kind: 'satori_index_completion_v1',
            codebasePath: this.canonicalizeCodebasePath(codebasePath),
            fingerprint: this.buildIndexCompletionFingerprint(),
            indexedFiles,
            totalChunks,
            completedAt: new Date().toISOString(),
            runId: crypto.randomUUID(),
            indexStatus,
        }, collectionName, assertMutationCurrent);
    }

    private async resolveActiveIndexedCollection(
        codebasePath: string
    ): Promise<{ collectionName: string; marker: IndexCompletionMarkerDocument } | null> {
        const {
            activeFamilyName,
            alternateFamilyName,
        } = this.buildCollectionFamilies(codebasePath);
        const familyCollectionNames = await this.listRelatedCollectionNames(codebasePath);

        const candidates: Array<{
            collectionName: string;
            marker: IndexCompletionMarkerDocument;
            familyPriority: number;
        }> = [];

        for (const collectionName of familyCollectionNames) {
            const marker = await this.resolveCompletionMarkerForCollection(codebasePath, collectionName);
            if (!marker) {
                continue;
            }
            if (!(await this.collectionHasIndexedPayload(collectionName, marker))) {
                continue;
            }

            const familyPriority = this.isRelatedCollectionName(collectionName, activeFamilyName)
                ? 0
                : this.isRelatedCollectionName(collectionName, alternateFamilyName)
                    ? 1
                    : 2;
            candidates.push({ collectionName, marker, familyPriority });
        }

        if (candidates.length === 0) {
            return null;
        }

        candidates.sort((left, right) => {
            if (left.familyPriority !== right.familyPriority) {
                return left.familyPriority - right.familyPriority;
            }

            const leftCompletedAt = Date.parse(left.marker.completedAt);
            const rightCompletedAt = Date.parse(right.marker.completedAt);
            if (leftCompletedAt !== rightCompletedAt) {
                return rightCompletedAt - leftCompletedAt;
            }

            return left.collectionName.localeCompare(right.collectionName);
        });

        const [selected] = candidates;
        return selected
            ? { collectionName: selected.collectionName, marker: selected.marker }
            : null;
    }

    public resolveStagedCollectionName(codebasePath: string, generationId: string): string {
        const normalizedGenerationId = generationId
            .trim()
            .replace(/[^a-zA-Z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (normalizedGenerationId.length === 0) {
            throw new Error('generationId must contain at least one alphanumeric character.');
        }
        return `${this.resolveCollectionName(codebasePath)}__gen_${normalizedGenerationId}`;
    }

    public setWriteCollectionOverride(codebasePath: string, collectionName: string | null): void {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        if (!collectionName || collectionName.trim().length === 0) {
            this.writeCollectionOverrides.delete(canonicalRoot);
            return;
        }
        this.writeCollectionOverrides.set(canonicalRoot, collectionName.trim());
    }

    public async getActiveIndexedCollectionName(codebasePath: string): Promise<string | null> {
        const active = await this.resolveActiveIndexedCollection(codebasePath);
        return active?.collectionName || null;
    }

    public async pruneIndexedCollectionFamily(
        codebasePath: string,
        keepCollectionName: string,
        options: MutationGuardOptions = {},
    ): Promise<string[]> {
        const familyCollectionNames = await this.listRelatedCollectionNames(codebasePath);
        const droppedCollections: string[] = [];

        for (const collectionName of familyCollectionNames) {
            if (collectionName === keepCollectionName) {
                continue;
            }
            await deleteCollectionWithVerification(this.vectorDatabase, collectionName, {
                beforeDropAttempt: options.assertMutationCurrent,
            });
            droppedCollections.push(collectionName);
        }

        return droppedCollections.sort((left, right) => left.localeCompare(right));
    }

    public async pruneUnprovenStagedCollectionFamily(
        codebasePath: string,
        options: MutationGuardOptions = {},
    ): Promise<string[]> {
        const familyCollectionNames = await this.listRelatedCollectionNames(codebasePath);
        const droppedCollections: string[] = [];

        for (const collectionName of familyCollectionNames) {
            if (!collectionName.includes('__gen_')) {
                continue;
            }
            const marker = await this.resolveCompletionMarkerForCollection(codebasePath, collectionName);
            if (marker && await this.collectionHasIndexedPayload(collectionName, marker)) {
                continue;
            }
            if (!marker && await this.collectionHasAnyIndexedPayload(collectionName)) {
                continue;
            }
            await deleteCollectionWithVerification(this.vectorDatabase, collectionName, {
                beforeDropAttempt: options.assertMutationCurrent,
            });
            droppedCollections.push(collectionName);
        }

        return droppedCollections.sort((left, right) => left.localeCompare(right));
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
        forceReindex: boolean = false,
        options: MutationGuardOptions = {},
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);

        this.loadIndexProfileForCodebase(codebasePath);

        // 1. Load ignore patterns from various ignore files
        await this.loadIgnorePatterns(codebasePath);

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        await this.prepareCollection(codebasePath, forceReindex, options.assertMutationCurrent);
        await this.clearIndexCompletionMarker(codebasePath, options.assertMutationCurrent);

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const codeFiles = await this.getCodeFiles(codebasePath);
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            await this.clearSymbolRegistryForCodebase(codebasePath, options.assertMutationCurrent);
            await this.writeCompletedIndexMarker(codebasePath, 0, 0, undefined, 'completed', options.assertMutationCurrent);
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        await this.clearSymbolRegistryForCodebase(codebasePath, options.assertMutationCurrent);

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
            },
            undefined,
            options.assertMutationCurrent,
        );

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

        if (result.status === 'completed') {
            await this.writeSymbolRegistryForCompletedIndex(codebasePath, result.symbolRecords, result.symbolManifestFiles, options.assertMutationCurrent);
            await this.writeCompletedIndexMarker(codebasePath, result.processedFiles, result.totalChunks, undefined, 'completed', options.assertMutationCurrent);
        } else {
            // limit_reached: do not publish complete navigation sidecars, but seal partial vector
            // proof so MCP readiness can allow warned partial search (not "missing marker" stale_local).
            // indexStatus must stay on the marker so interrupted-index recovery does not promote as fully completed.
            console.warn('[Context] ⚠️  Skipping symbol registry sidecar write because indexing stopped before processing the full file set.');
            await this.writeCompletedIndexMarker(codebasePath, result.processedFiles, result.totalChunks, undefined, 'limit_reached', options.assertMutationCurrent);
            console.warn('[Context] ⚠️  Wrote completion marker for limit_reached partial index (navigation remains unpublished).');
        }

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
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: ReindexByChangeOptions = {}
    ): Promise<ReindexByChangeResult> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.runSerializedReindexByChange(
            canonicalRoot,
            () => this.performReindexByChange(codebasePath, progressCallback, options),
        );
    }

    private async runSerializedReindexByChange<T>(
        canonicalRoot: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const previous = this.reindexByChangeQueues.get(canonicalRoot) || Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.reindexByChangeQueues.set(canonicalRoot, current);

        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.reindexByChangeQueues.get(canonicalRoot) === current) {
                this.reindexByChangeQueues.delete(canonicalRoot);
            }
        }
    }

    private async performReindexByChange(
        codebasePath: string,
        progressCallback: ((progress: { phase: string; current: number; total: number; percentage: number }) => void) | undefined,
        options: ReindexByChangeOptions,
    ): Promise<ReindexByChangeResult> {
        this.loadIndexProfileForCodebase(codebasePath);
        const synchronizerKey = this.resolveCollectionName(codebasePath);
        const synchronizer = this.synchronizers.get(synchronizerKey);

        if (!synchronizer) {
            // Load project-specific ignore patterns before creating FileSynchronizer
            await this.loadIgnorePatterns(codebasePath);

            // To be safe, let's initialize if it's not there.
            const newSynchronizer = new FileSynchronizer(
                codebasePath,
                this.getActiveIgnorePatterns(codebasePath),
                this.getIndexedExtensionsForCodebase(codebasePath)
            );
            await newSynchronizer.initialize(options.assertMutationCurrent);
            this.synchronizers.set(synchronizerKey, newSynchronizer);
        }

        const currentSynchronizer = this.synchronizers.get(synchronizerKey)!;
        const maintainCompletionMarker = options.maintainCompletionMarker === true;
        let collectionName = typeof options.targetCollectionName === 'string' && options.targetCollectionName.trim().length > 0
            ? options.targetCollectionName.trim()
            : null;
        if (collectionName) {
            if (!(await this.vectorDatabase.hasCollection(collectionName))) {
                throw new Error(`Cannot incremental sync '${codebasePath}': target collection '${collectionName}' does not exist.`);
            }
        } else {
            const activeCollectionName = await this.getActiveIndexedCollectionName(codebasePath);
            collectionName = activeCollectionName;
        }
        if (!collectionName) {
            const fallbackCollectionName = this.resolveCollectionName(codebasePath);
            if (await this.vectorDatabase.hasCollection(fallbackCollectionName)) {
                collectionName = fallbackCollectionName;
            }
        }
        const collectionExists = collectionName !== null;

        if (!collectionExists) {
            if (maintainCompletionMarker) {
                throw new Error(`Cannot incremental sync '${codebasePath}': no existing collection could be resolved for completion marker maintenance.`);
            }
            console.warn(`[Context] ⚠️  No proven collection exists for '${codebasePath}'. Rebuilding full index before incremental sync resumes.`);
            const changedFiles = this.normalizeRelativePathsForCodebase(codebasePath, await this.getCodeFiles(codebasePath));
            if (changedFiles.length === 0) {
                progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
                return { added: 0, removed: 0, modified: 0, changedFiles: [] };
            }

            await this.indexCodebase(codebasePath, progressCallback, false, options);
            return {
                added: changedFiles.length,
                removed: 0,
                modified: 0,
                changedFiles,
                collectionName: this.getWriteCollectionName(codebasePath),
            };
        }
        if (!collectionName) {
            throw new Error(`Expected an indexed collection for '${codebasePath}' after sync preflight.`);
        }
        const targetCollectionName = collectionName;
        const markerWasMissing = maintainCompletionMarker
            ? (await this.queryCompletionMarkerRows(targetCollectionName)).length === 0
            : false;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const preparedChanges = await currentSynchronizer.prepareChanges();
        const { added, removed, modified } = preparedChanges.changes;
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            if (maintainCompletionMarker && markerWasMissing) {
                await this.refreshCompletionMarkerFromCurrentSource(codebasePath, targetCollectionName, {
                    requirePayloadProof: true,
                    assertMutationCurrent: options.assertMutationCurrent,
                });
            }
            options.assertMutationCurrent?.();
            await preparedChanges.commit(options.assertMutationCurrent);
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            return { added: 0, removed: 0, modified: 0, changedFiles: [], collectionName: targetCollectionName };
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);
        const navigationStateBeforeSync = await readSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
        });
        const canRebuildNavigationArtifacts = navigationStateBeforeSync.status === 'ok';

        let processedChanges = 0;
        const updateProgress = (phase: string) => {
            processedChanges++;
            const percentage = Math.round((processedChanges / (removed.length + modified.length + added.length)) * 100);
            progressCallback?.({ phase, current: processedChanges, total: totalChanges, percentage });
        };

        let navigationRecovery: 'rebuilt' | 'failed' | undefined;
        let readinessArtifactsComplete = false;

        try {
            if (maintainCompletionMarker) {
                await this.clearIndexCompletionMarkerFromCollection(targetCollectionName, options.assertMutationCurrent);
            }

            // Handle removed files
            for (const file of removed) {
                await this.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
                updateProgress(`Removed ${file}`);
            }

            // Handle modified files
            for (const file of modified) {
                await this.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
                updateProgress(`Deleted old chunks for ${file}`);
            }

            // Handle added and modified files
            const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));

            let indexedDelta: {
                processedFiles: number;
                totalChunks: number;
                status: 'completed' | 'limit_reached';
                symbolRecords: SymbolRecord[];
                symbolManifestFiles: SymbolRegistryManifestFile[];
            } = {
                processedFiles: 0,
                totalChunks: 0,
                status: 'completed',
                symbolRecords: [],
                symbolManifestFiles: [],
            };

            if (filesToIndex.length > 0) {
                indexedDelta = await this.processFileList(
                    filesToIndex,
                    codebasePath,
                    (filePath, fileIndex, totalFiles) => {
                        updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`);
                    },
                    targetCollectionName,
                    options.assertMutationCurrent,
                );
            }

            const canPublishNavigationDelta = canRebuildNavigationArtifacts && indexedDelta.status === 'completed';
            if (canPublishNavigationDelta) {
                progressCallback?.({
                    phase: 'Rebuilding navigation metadata...',
                    current: totalChanges,
                    total: totalChanges,
                    percentage: 100,
                });
                await this.rebuildNavigationArtifactsForSyncDelta(
                    codebasePath,
                    navigationStateBeforeSync.registry,
                    Array.from(new Set([...added, ...modified, ...removed])),
                    indexedDelta.symbolRecords,
                    indexedDelta.symbolManifestFiles,
                    options.assertMutationCurrent,
                );
                readinessArtifactsComplete = true;
            } else if (!canRebuildNavigationArtifacts && indexedDelta.status === 'completed') {
                progressCallback?.({
                    phase: 'Recovering navigation metadata...',
                    current: totalChanges,
                    total: totalChanges,
                    percentage: 100,
                });
                try {
                    await this.rebuildNavigationArtifacts(codebasePath, options.assertMutationCurrent);
                    navigationRecovery = 'rebuilt';
                    readinessArtifactsComplete = true;
                    console.log('[Context] 🧭 Rebuilt navigation sidecars after incremental sync found no compatible pre-sync registry.');
                } catch (error) {
                    await this.clearSymbolRegistryForCodebase(codebasePath, options.assertMutationCurrent);
                    await this.clearCompletionMarkerAfterSyncFailure(codebasePath, targetCollectionName, maintainCompletionMarker, options.assertMutationCurrent);
                    navigationRecovery = 'failed';
                    console.warn(
                        `[Context] ⚠️  Failed to recover navigation sidecars after incremental sync; reindex is required: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            } else {
                await this.clearSymbolRegistryForCodebase(codebasePath, options.assertMutationCurrent);
                await this.clearCompletionMarkerAfterSyncFailure(codebasePath, targetCollectionName, maintainCompletionMarker, options.assertMutationCurrent);
                navigationRecovery = 'failed';
                if (!canRebuildNavigationArtifacts) {
                    console.log('[Context] ⏭️ Skipping navigation rebuild because no compatible symbol registry existed before incremental sync.');
                } else {
                    console.warn('[Context] ⚠️  Clearing navigation sidecars because incremental sync stopped before all changed files finished indexing.');
                }
            }
        } catch (error) {
            await this.clearSymbolRegistryForCodebase(codebasePath, options.assertMutationCurrent);
            await this.clearCompletionMarkerAfterSyncFailure(codebasePath, targetCollectionName, maintainCompletionMarker, options.assertMutationCurrent);
            throw error;
        }

        if (maintainCompletionMarker && readinessArtifactsComplete) {
            await this.refreshCompletionMarkerFromCurrentSource(codebasePath, targetCollectionName, {
                requirePayloadProof: markerWasMissing,
                assertMutationCurrent: options.assertMutationCurrent,
            });
        }
        if (readinessArtifactsComplete) {
            options.assertMutationCurrent?.();
            await preparedChanges.commit(options.assertMutationCurrent);
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        return {
            added: added.length,
            removed: removed.length,
            modified: modified.length,
            changedFiles: Array.from(new Set([...added, ...removed, ...modified])),
            collectionName: targetCollectionName,
            ...(navigationRecovery ? { navigationRecovery } : {}),
        };
    }

    private async deleteFileChunks(
        collectionName: string,
        relativePath: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const escapedPath = escapeMilvusStringLiteral(relativePath);
        const results = await this.vectorDatabase.query(
            collectionName,
            `relativePath == "${escapedPath}"`,
            ['id']
        );

        if (results.length > 0) {
            const ids = results.map(r => r.id as string).filter(id => id);
            if (ids.length > 0) {
                assertMutationCurrent?.();
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
    async semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResult[]>;
    async semanticSearch(codebasePath: string, query: string, topK?: number, threshold?: number, filterExpr?: string): Promise<SemanticSearchResult[]>;
    async semanticSearch(
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filterExpr?: string
    ): Promise<SemanticSearchResult[]> {
        const request = this.normalizeSemanticSearchRequest(requestOrCodebasePath, query, topK, threshold, filterExpr);
        const resolvedRequest = this.resolveSemanticSearchRequest(request);
        const codebasePath = resolvedRequest.codebasePath;
        const isHybrid = resolvedRequest.retrievalMode !== 'dense' && this.getIsHybrid() === true;
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${resolvedRequest.query}" in ${codebasePath}`);
        const effectiveFilterExpr = this.buildSemanticSearchFilterExpr(resolvedRequest.filterExpr);

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

        const activeCollectionName = await this.getActiveIndexedCollectionName(codebasePath);
        let collectionName = activeCollectionName;
        if (!collectionName) {
            const fallbackCollectionName = this.resolveCollectionName(codebasePath);
            if (await this.vectorDatabase.hasCollection(fallbackCollectionName)) {
                collectionName = fallbackCollectionName;
            }
        }
        console.log(`[Context] 🔍 Using collection: ${collectionName}`);

        // Check if collection exists and has data
        if (!collectionName) {
            console.log(`[Context] ⚠️  No proven collection exists for '${codebasePath}'. Please index the codebase first.`);
            return [];
        }

        if (isHybrid === true) {
            try {
                // Check collection stats to see if it has data
                await this.vectorDatabase.query(collectionName, '', ['id'], 1);
                console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
            } catch (error) {
                console.log(`[Context] ⚠️  Collection '${collectionName}' exists but may be empty or not properly indexed:`, error);
            }

            // 1. Generate query vector
            console.log(`[Context] 🔍 Generating embeddings for query: "${resolvedRequest.query}"`);
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(resolvedRequest.query);
            console.log(`[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);
            console.log(`[Context] 🔍 First 5 embedding values: [${queryEmbedding.vector.slice(0, 5).join(', ')}]`);

            // 2. Prepare hybrid search requests
            const searchRequests: HybridSearchRequest[] = [
                {
                    data: queryEmbedding.vector,
                    anns_field: "vector",
                    param: { "nprobe": 10 },
                    limit: resolvedRequest.topK
                },
                {
                    data: resolvedRequest.query,
                    anns_field: "sparse_vector",
                    param: { "drop_ratio_search": 0.2 },
                    limit: resolvedRequest.topK
                }
            ];

            console.log(`[Context] 🔍 Search request 1 (dense): anns_field="${searchRequests[0].anns_field}", vector_dim=${queryEmbedding.vector.length}, limit=${searchRequests[0].limit}`);
            console.log(`[Context] 🔍 Search request 2 (sparse): anns_field="${searchRequests[1].anns_field}", query_text="${resolvedRequest.query}", limit=${searchRequests[1].limit}`);

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
                    limit: resolvedRequest.topK,
                    // Hybrid RRF scores are backend/rerank relative, so dense similarity
                    // thresholds can erase valid sparse lexical matches before MCP ranking.
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
                symbolLabel: typeof result.document.metadata.symbolLabel === 'string' ? result.document.metadata.symbolLabel : undefined,
                symbolKind: typeof result.document.metadata.symbolKind === 'string' ? result.document.metadata.symbolKind : undefined,
                ownerSymbolKey: typeof result.document.metadata.ownerSymbolKey === 'string' ? result.document.metadata.ownerSymbolKey : undefined,
                ownerSymbolInstanceId: typeof result.document.metadata.ownerSymbolInstanceId === 'string' ? result.document.metadata.ownerSymbolInstanceId : undefined,
                backendScore: result.score,
                backendScoreKind: 'rrf_fusion'
            }));

            console.log(`[Context] ✅ Found ${results.length} relevant hybrid results`);
            if (results.length > 0) {
                console.log(`[Context] 🔍 Top result score: ${results[0].score}, path: ${results[0].relativePath}`);
            }

            return results;
        } else {
            // Regular semantic search
            // 1. Generate query vector
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(resolvedRequest.query);
            const denseThreshold = resolvedRequest.scorePolicy.kind === 'dense_similarity_min'
                ? resolvedRequest.scorePolicy.min
                : undefined;

            // 2. Search in vector database
            const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
                collectionName,
                queryEmbedding.vector,
                { topK: resolvedRequest.topK, threshold: denseThreshold, filterExpr: effectiveFilterExpr }
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
                symbolLabel: typeof result.document.metadata.symbolLabel === 'string' ? result.document.metadata.symbolLabel : undefined,
                symbolKind: typeof result.document.metadata.symbolKind === 'string' ? result.document.metadata.symbolKind : undefined,
                ownerSymbolKey: typeof result.document.metadata.ownerSymbolKey === 'string' ? result.document.metadata.ownerSymbolKey : undefined,
                ownerSymbolInstanceId: typeof result.document.metadata.ownerSymbolInstanceId === 'string' ? result.document.metadata.ownerSymbolInstanceId : undefined,
                backendScore: result.score,
                backendScoreKind: 'dense_similarity'
            }));

            console.log(`[Context] ✅ Found ${results.length} relevant results`);
            return results;
        }
    }

    private normalizeSemanticSearchRequest(
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filterExpr?: string
    ): SemanticSearchRequest {
        if (typeof requestOrCodebasePath === 'string') {
            return {
                codebasePath: requestOrCodebasePath,
                query: query ?? '',
                topK,
                filterExpr,
                ...(threshold > 0
                    ? {
                        retrievalMode: 'dense',
                        scorePolicy: { kind: 'dense_similarity_min', min: threshold } as const
                    }
                    : {
                        scorePolicy: { kind: 'topk_only' } as const
                    })
            };
        }

        return requestOrCodebasePath;
    }

    private resolveSemanticSearchRequest(request: SemanticSearchRequest): Required<SemanticSearchRequest> & { retrievalMode: RetrievalMode; scorePolicy: ScorePolicy } {
        const hybridEnabled = this.getIsHybrid() === true;
        const retrievalMode = request.retrievalMode ?? (hybridEnabled ? 'hybrid' : 'dense');
        const scorePolicy = request.scorePolicy ?? (retrievalMode === 'dense'
            ? { kind: 'dense_similarity_min', min: 0.5 }
            : { kind: 'topk_only' });

        if (request.retrievalMode !== undefined && retrievalMode !== 'dense' && hybridEnabled !== true) {
            throw new Error(`${retrievalMode} retrieval requires hybrid search support, but HYBRID_MODE is disabled.`);
        }

        if (retrievalMode !== 'dense' && scorePolicy.kind === 'dense_similarity_min') {
            throw new Error(`Dense similarity threshold score policy is invalid for ${retrievalMode} retrieval.`);
        }

        return {
            codebasePath: request.codebasePath,
            query: request.query,
            topK: request.topK ?? 5,
            retrievalMode,
            filterExpr: request.filterExpr ?? '',
            scorePolicy
        };
    }

    private buildSemanticSearchFilterExpr(filterExpr?: string): string {
        const markerExclusion = `fileExtension != "${INDEX_COMPLETION_MARKER_FILE_EXTENSION}"`;
        if (!filterExpr || filterExpr.trim().length === 0) {
            return markerExclusion;
        }
        return `(${filterExpr}) and (${markerExclusion})`;
    }

    private async queryCompletionMarkerRows(collectionName: string): Promise<Array<Record<string, unknown>>> {
        return this.vectorDatabase.query(
            collectionName,
            `id == "${INDEX_COMPLETION_MARKER_DOC_ID}"`,
            ['id', 'metadata'],
            8
        );
    }

    private async clearIndexCompletionMarkerFromCollection(
        collectionName: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const rows = await this.queryCompletionMarkerRows(collectionName);
        const markerIds = rows
            .map((row) => (typeof row.id === 'string' ? row.id : ''))
            .filter((id) => id.length > 0);
        if (markerIds.length === 0) {
            return;
        }
        assertMutationCurrent?.();
        await this.vectorDatabase.delete(collectionName, Array.from(new Set(markerIds)));
    }

    async clearIndexCompletionMarker(codebasePath: string, assertMutationCurrent?: () => void): Promise<void> {
        const collectionName = this.getWriteCollectionName(codebasePath);
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            const activeCollectionName = await this.getActiveIndexedCollectionName(codebasePath);
            if (!activeCollectionName) {
                return;
            }
            await this.clearIndexCompletionMarkerFromCollection(activeCollectionName, assertMutationCurrent);
            return;
        }

        await this.clearIndexCompletionMarkerFromCollection(collectionName, assertMutationCurrent);
    }

    async writeIndexCompletionMarker(
        codebasePath: string,
        marker: IndexCompletionMarkerDocument,
        collectionNameOverride?: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const collectionName = collectionNameOverride || this.getWriteCollectionName(codebasePath);
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            throw new Error(`Cannot write completion marker: collection '${collectionName}' does not exist.`);
        }

        await this.clearIndexCompletionMarkerFromCollection(collectionName, assertMutationCurrent);

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
            assertMutationCurrent?.();
            await this.vectorDatabase.insertHybrid(collectionName, [markerDoc]);
        } else {
            assertMutationCurrent?.();
            await this.vectorDatabase.insert(collectionName, [markerDoc]);
        }
    }

    async getIndexCompletionMarker(codebasePath: string): Promise<IndexCompletionMarkerDocument | null> {
        const active = await this.resolveActiveIndexedCollection(codebasePath);
        return active?.marker || null;
    }

    /**
     * Check if index exists for codebase
     * @param codebasePath Codebase path to check
     * @returns Whether index exists
     */
    async hasIndexedCollection(codebasePath: string): Promise<boolean> {
        return (await this.resolveActiveIndexedCollection(codebasePath)) !== null;
    }

    /**
     * Clear index
     * @param codebasePath Codebase path to clear index for
     * @param progressCallback Optional progress callback function
     */
    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: MutationGuardOptions = {},
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        for (const collectionName of await this.listRelatedCollectionNames(codebasePath)) {
            await deleteCollectionWithVerification(this.vectorDatabase, collectionName, {
                beforeDropAttempt: options.assertMutationCurrent,
            });
        }

        await this.clearSymbolRegistryForCodebase(codebasePath, options.assertMutationCurrent);

        // Delete snapshot file
        options.assertMutationCurrent?.();
        await FileSynchronizer.deleteSnapshot(codebasePath);
        const familyCollectionName = this.resolveCollectionName(codebasePath);
        this.synchronizers.delete(familyCollectionName);
        this.ignoreStateByCollection.delete(familyCollectionName);
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.writeCollectionOverrides.delete(canonicalRoot);
        this.indexProfilesByCodebase.delete(canonicalRoot);

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
    private async prepareCollection(
        codebasePath: string,
        forceReindex: boolean = false,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = this.getWriteCollectionName(codebasePath);

        // Check if collection already exists
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        if (collectionExists && !forceReindex) {
            console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
            return;
        }

        if (collectionExists && forceReindex) {
            console.log(`[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`);
            assertMutationCurrent?.();
            await this.vectorDatabase.dropCollection(collectionName);
            console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
        }

        console.log(`[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`);
        const dimension = await this.embedding.detectDimension();
        console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);
        const dirName = path.basename(codebasePath);

        if (isHybrid === true) {
            assertMutationCurrent?.();
            await this.vectorDatabase.createHybridCollection(collectionName, dimension, `Hybrid Index for ${dirName}`);
        } else {
            assertMutationCurrent?.();
            await this.vectorDatabase.createCollection(collectionName, dimension, `Index for ${dirName}`);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);
    }

    /**
     * Recursively get all code files in the codebase
     */
    private async getCodeFiles(codebasePath: string): Promise<string[]> {
        const files: string[] = [];
        const supportedExtensions = this.getIndexedExtensionsForCodebase(codebasePath);

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
                    const stat = await fs.promises.stat(fullPath);
                    const relativePath = path.relative(codebasePath, fullPath).replace(/\\/g, '/');
                    if (await isIndexableFileByPolicy(relativePath, fullPath, stat.size, supportedExtensions)) {
                        files.push(fullPath);
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        return files;
    }

    private buildSupportedExtensions(profile: IndexProfile): string[] {
        return normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(profile),
            ...this.configuredExtensionOverlays,
            ...this.runtimeCustomExtensions
        ]);
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
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
        collectionName: string = this.getWriteCollectionName(codebasePath),
        assertMutationCurrent?: () => void,
    ): Promise<{
        processedFiles: number;
        totalChunks: number;
        status: 'completed' | 'limit_reached';
        symbolRecords: SymbolRecord[];
        symbolManifestFiles: SymbolRegistryManifestFile[];
    }> {
        const isHybrid = this.getIsHybrid();
        const EMBEDDING_BATCH_SIZE = Math.max(1, parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '100', 10));
        const CHUNK_LIMIT = 450000;
        console.log(`[Context] 🔧 Using EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);

        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];
        const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];

            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromFilePath(filePath);
                const chunks = await this.codeSplitter.split(content, language, filePath);
                const relativePath = this.normalizeRelativePathForCodebase(codebasePath, filePath);
                if (!relativePath) {
                    throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
                }
                const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
                const extractedSymbols = this.extractSymbolsForFile(language, content, relativePath);
                const fileSymbols = buildSymbolRecordsForFile({
                    relativePath,
                    language,
                    content,
                    fileHash,
                    extractorVersion: this.getSymbolExtractorVersion(),
                    ...(extractedSymbols !== undefined ? { extractedSymbols } : {}),
                    chunks,
                });
                for (const chunk of chunks) {
                    const owner = resolveOwnerSymbolForChunk({ chunk, symbols: fileSymbols });
                    chunk.metadata.ownerSymbolKey = owner.symbolKey;
                    chunk.metadata.ownerSymbolInstanceId = owner.symbolInstanceId;
                    chunk.metadata.symbolKind = owner.kind;
                }
                symbolRecords.push(...fileSymbols);
                symbolManifestFiles.push({
                    path: relativePath,
                    hash: fileHash,
                    language,
                    symbolCount: fileSymbols.length,
                });

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
                            await this.processChunkBuffer(chunkBuffer, collectionName, assertMutationCurrent);
                        } catch (error) {
                            const searchType = isHybrid === true ? 'hybrid' : 'regular';
                            console.error(`[Context] ❌ Failed to process chunk batch for ${searchType}:`, error);
                            if (error instanceof Error) {
                                console.error('[Context] Stack trace:', error.stack);
                            }
                            throw new Error(`Failed to persist ${searchType} chunks while indexing ${filePath}: ${describeError(error)}`);
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
                console.error(`[Context] ❌ Failed to index file ${filePath}: ${describeError(error)}`);
                throw error;
            }
        }

        // Process any remaining chunks in the buffer
        if (chunkBuffer.length > 0) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
            try {
                await this.processChunkBuffer(chunkBuffer, collectionName, assertMutationCurrent);
            } catch (error) {
                console.error(`[Context] ❌ Failed to process final chunk batch for ${searchType}:`, error);
                if (error instanceof Error) {
                    console.error('[Context] Stack trace:', error.stack);
                }
                throw new Error(`Failed to persist final ${searchType} chunk batch: ${describeError(error)}`);
            }
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed',
            symbolRecords,
            symbolManifestFiles
        };
    }

    /**
     * Rebuild expected chunks and symbol registry records from source files without embedding.
     */
    public async getExpectedChunksAndSymbols(
        filePaths: string[],
        codebasePath: string
    ): Promise<{
        expectedChunks: ExpectedIndexedChunk[];
        symbolRecords: SymbolRecord[];
        symbolManifestFiles: SymbolRegistryManifestFile[];
    }> {
        const expectedChunks: ExpectedIndexedChunk[] = [];
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];

        for (const filePath of filePaths) {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const language = this.getLanguageFromFilePath(filePath);
            const chunks = await this.codeSplitter.split(content, language, filePath);
            const relativePath = this.normalizeRelativePathForCodebase(codebasePath, filePath);
            if (!relativePath) {
                throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
            }
            const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
            const extractedSymbols = this.extractSymbolsForFile(language, content, relativePath);
            const fileSymbols = buildSymbolRecordsForFile({
                relativePath,
                language,
                content,
                fileHash,
                extractorVersion: this.getSymbolExtractorVersion(),
                ...(extractedSymbols !== undefined ? { extractedSymbols } : {}),
                chunks,
            });
            for (let index = 0; index < chunks.length; index++) {
                const chunk = chunks[index];
                const owner = resolveOwnerSymbolForChunk({ chunk, symbols: fileSymbols });
                chunk.metadata.ownerSymbolKey = owner.symbolKey;
                chunk.metadata.ownerSymbolInstanceId = owner.symbolInstanceId;
                chunk.metadata.symbolKind = owner.kind;

                const startLine = chunk.metadata.startLine || 0;
                const endLine = chunk.metadata.endLine || 0;
                const id = this.generateId(relativePath, startLine, endLine, chunk.content);

                expectedChunks.push({
                    id,
                    relativePath,
                    startLine,
                    endLine,
                    content: chunk.content,
                    language: chunk.metadata.language || 'unknown',
                    chunkIndex: index,
                });
            }
            symbolRecords.push(...fileSymbols);
            symbolManifestFiles.push({
                path: relativePath,
                hash: fileHash,
                language,
                symbolCount: fileSymbols.length,
            });
        }

        return {
            expectedChunks,
            symbolRecords,
            symbolManifestFiles,
        };
    }

    private async refreshCompletionMarkerFromCurrentSource(
        codebasePath: string,
        collectionName: string,
        options: { requirePayloadProof?: boolean; assertMutationCurrent?: () => void } = {}
    ): Promise<void> {
        await this.loadIgnorePatterns(codebasePath);
        const codeFiles = await this.getCodeFiles(codebasePath);
        const { expectedChunks } = await this.getExpectedChunksAndSymbols(codeFiles, codebasePath);
        if (options.requirePayloadProof === true) {
            await this.ensureNavigationArtifactsReadyForMarkerRefresh(codebasePath, options.assertMutationCurrent);
            const verification = await this.verifyCollectionPayloadMatchesCurrentSource(collectionName, codeFiles, expectedChunks);
            if (!verification.ok) {
                await this.clearIndexCompletionMarkerFromCollection(collectionName, options.assertMutationCurrent);
                throw new Error(`Cannot refresh completion marker for '${codebasePath}': ${verification.message}`);
            }
        }
        await this.writeCompletedIndexMarker(
            codebasePath,
            codeFiles.length,
            expectedChunks.length,
            collectionName,
            'completed',
            options.assertMutationCurrent,
        );
    }

    private async ensureNavigationArtifactsReadyForMarkerRefresh(
        codebasePath: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const canonicalPath = this.canonicalizeCodebasePath(codebasePath);
        const registry = await readSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: canonicalPath,
        });
        if (registry.status === 'ok') {
            const relationships = await readRelationshipSidecar({
                stateRoot: this.symbolRegistryStateRoot,
                normalizedRootPath: canonicalPath,
                expectedSymbolRegistryManifestHash: registry.manifestHash,
            });
            if (relationships.status === 'ok') {
                return;
            }
        }
        await this.rebuildNavigationArtifacts(codebasePath, assertMutationCurrent);
    }

    private async clearCompletionMarkerAfterSyncFailure(
        codebasePath: string,
        collectionName: string,
        targetKnown: boolean,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        if (targetKnown) {
            await this.clearIndexCompletionMarkerFromCollection(collectionName, assertMutationCurrent);
            return;
        }
        await this.clearIndexCompletionMarker(codebasePath, assertMutationCurrent);
    }

    private async verifyCollectionPayloadMatchesCurrentSource(
        collectionName: string,
        codeFiles: string[],
        expectedChunks: ExpectedIndexedChunk[]
    ): Promise<CollectionPayloadVerification> {
        if (codeFiles.length === 0) {
            if (await this.collectionHasAnyIndexedPayload(collectionName)) {
                return {
                    ok: false,
                    message: `collection '${collectionName}' contains remote chunks but the current index policy finds no indexable files.`,
                };
            }
            return { ok: true, indexedFiles: 0, totalChunks: 0 };
        }

        const existingIds = new Set<string>();
        const expectedIds = expectedChunks.map((chunk) => chunk.id);
        const chunkIdBatchSize = 512;
        for (let index = 0; index < expectedIds.length; index += chunkIdBatchSize) {
            const batch = expectedIds.slice(index, index + chunkIdBatchSize);
            const rows = await this.vectorDatabase.query(
                collectionName,
                buildMilvusIdInFilter(batch),
                ['id'],
                batch.length
            );
            for (const row of rows) {
                const id = typeof row?.id === 'string' ? row.id : '';
                if (id && id !== INDEX_COMPLETION_MARKER_DOC_ID) {
                    existingIds.add(id);
                }
            }
        }

        let missingChunksCount = 0;
        for (const chunk of expectedChunks) {
            if (!existingIds.has(chunk.id)) {
                missingChunksCount++;
            }
        }
        if (missingChunksCount > 0) {
            return {
                ok: false,
                message: `${missingChunksCount} expected chunk(s) are missing from collection '${collectionName}'.`,
            };
        }

        const maxExactPayloadProbeRows = 16384;
        const remotePayloadLimit = expectedChunks.length + 1;
        if (remotePayloadLimit > maxExactPayloadProbeRows) {
            return {
                ok: false,
                message: `cannot prove exact remote payload equality for ${expectedChunks.length} expected chunks with the current vector query limit.`,
            };
        }

        const expectedIdsSet = new Set(expectedIds);
        // Repair/sync marker restoration relies on vector backends returning up to limit rows
        // for this un-ordered payload query; limit=N+1 lets us detect stale extra chunks.
        const remotePayloadRows = await this.vectorDatabase.query(
            collectionName,
            'fileExtension != ".satori_meta"',
            ['id'],
            remotePayloadLimit
        );
        const extraRemoteIds = new Set<string>();
        for (const row of remotePayloadRows) {
            const id = typeof row?.id === 'string' ? row.id : '';
            if (id && !expectedIdsSet.has(id)) {
                extraRemoteIds.add(id);
            }
        }

        if (remotePayloadRows.length !== expectedChunks.length || extraRemoteIds.size > 0) {
            const extraCount = Math.max(0, remotePayloadRows.length - expectedChunks.length, extraRemoteIds.size);
            return {
                ok: false,
                message: `collection '${collectionName}' contains ${extraCount || 'unexpected'} stale remote chunk(s) outside the current indexable source set.`,
            };
        }

        return { ok: true, indexedFiles: codeFiles.length, totalChunks: expectedChunks.length };
    }

    /**
     * Repair index for codebase path by rebuilding metadata without vector writes.
     */
    public async repairIndex(
        codebasePath: string,
        options: RepairIndexOptions = {}
    ): Promise<RepairIndexResult> {
        const canonicalPath = this.canonicalizeCodebasePath(codebasePath);
        const currentFingerprint = this.buildIndexCompletionFingerprint();
        const snapshotEvidence = options.snapshotEvidence ?? {
            status: 'missing' as const,
            basis: 'snapshot_fingerprint_missing',
        };
        const snapshotFingerprintMatches = snapshotEvidence.status === 'verified'
            && this.indexCompletionFingerprintsMatch(snapshotEvidence.fingerprint, currentFingerprint);
        const proof: RepairProof = {
            collection: { status: 'not_checked' },
            snapshot: snapshotEvidence.status === 'missing'
                ? { status: 'missing', basis: snapshotEvidence.basis }
                : snapshotEvidence.status === 'unproven'
                    ? { status: 'unproven', basis: snapshotEvidence.basis }
                    : snapshotFingerprintMatches
                        ? { status: 'matched', basis: snapshotEvidence.basis }
                        : { status: 'failed', basis: 'snapshot_fingerprint_mismatch' },
            marker: { status: 'not_checked' },
            fingerprint: { status: 'not_checked' },
            payload: { status: 'not_checked' },
            staleRemoteChunks: { status: 'not_checked' },
            navigation: { status: 'not_checked' },
        };
        const publishProof = (): void => {
            options.onProofUpdate?.({
                collection: { ...proof.collection },
                snapshot: { ...proof.snapshot },
                marker: { ...proof.marker },
                fingerprint: { ...proof.fingerprint },
                payload: { ...proof.payload },
                staleRemoteChunks: { ...proof.staleRemoteChunks },
                navigation: { ...proof.navigation },
            });
        };
        const withProof = (result: Omit<RepairIndexResult, 'proof'>): RepairIndexResult => {
            publishProof();
            return {
                ...result,
                proof,
            };
        };
        publishProof();

        // 1. Resolve collection
        const familyCollectionNames = await this.listRelatedCollectionNames(canonicalPath);
        const activeCollectionName = this.getWriteCollectionName(canonicalPath);
        const preferredCollectionName = options.preferredCollectionName?.trim();
        let selectedCollection: string | null = null;
        let collectionSelectionBasis = 'selected_active_collection';
        if (preferredCollectionName) {
            if (!familyCollectionNames.includes(preferredCollectionName)) {
                const hasRelatedCollection = familyCollectionNames.length > 0;
                proof.collection = hasRelatedCollection
                    ? {
                        status: 'failed',
                        basis: 'snapshot_collection_missing_from_family',
                        observedCount: familyCollectionNames.length,
                    }
                    : { status: 'missing', basis: 'no_related_collection', observedCount: 0 };
                return withProof({
                    status: hasRelatedCollection ? 'requires_reindex' : 'blocked',
                    reason: hasRelatedCollection ? 'requires_reindex' : 'needs_create',
                    message: `Repair snapshot collection '${preferredCollectionName}' does not exist in the codebase collection family.`,
                    missingCount: 0,
                });
            }
            selectedCollection = preferredCollectionName;
            collectionSelectionBasis = 'selected_snapshot_collection';
        } else if (familyCollectionNames.includes(activeCollectionName)) {
            selectedCollection = activeCollectionName;
        } else {
            const { alternateFamilyName } = this.buildCollectionFamilies(canonicalPath);
            if (familyCollectionNames.includes(alternateFamilyName)) {
                selectedCollection = alternateFamilyName;
                collectionSelectionBasis = 'selected_alternate_collection';
            } else {
                const stagedCollections = familyCollectionNames.filter((collectionName) => collectionName.includes('__gen_'));
                if (stagedCollections.length === 1) {
                    selectedCollection = stagedCollections[0];
                    collectionSelectionBasis = 'selected_single_staged_collection';
                } else if (stagedCollections.length > 1) {
                    proof.collection = {
                        status: 'failed',
                        basis: 'multiple_staged_collections',
                        observedCount: stagedCollections.length,
                    };
                    return withProof({
                        status: 'requires_reindex',
                        reason: 'requires_reindex',
                        message: `Repair found multiple staged collections for '${canonicalPath}' and cannot choose one deterministically.`,
                        missingCount: 0,
                    });
                }
            }
        }

        if (!selectedCollection) {
            proof.collection = { status: 'missing', basis: 'no_related_collection', observedCount: 0 };
            return withProof({
                status: 'blocked',
                reason: 'needs_create',
                message: 'No existing collection found for this codebase family.',
                missingCount: 0
            });
        }
        proof.collection = {
            status: 'matched',
            basis: collectionSelectionBasis,
            observedCount: familyCollectionNames.length,
        };
        publishProof();

        // 2. Check completion marker if present in the selected collection
        const markerResolution = await this.resolveRepairCompletionMarkerForCollection(canonicalPath, selectedCollection);
        if (markerResolution.status === 'malformed') {
            proof.marker = { status: 'failed', basis: 'malformed_completion_marker' };
            proof.fingerprint = snapshotFingerprintMatches
                ? { status: 'matched', basis: snapshotEvidence.basis }
                : { status: 'unproven', basis: 'malformed_completion_marker' };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: `Repair found a malformed completion marker in collection '${selectedCollection}' and cannot trust that generation.`,
            });
        }
        if (markerResolution.status === 'matched') {
            const marker = markerResolution.marker;
            if (!this.indexCompletionFingerprintsMatch(marker.fingerprint, currentFingerprint)) {
                proof.marker = { status: 'failed', basis: 'completion_marker_fingerprint_mismatch' };
                proof.fingerprint = { status: 'failed', basis: 'completion_marker_fingerprint_mismatch' };
                return withProof({
                    status: 'requires_reindex',
                    reason: 'requires_reindex',
                    message: 'The existing index is incompatible with the current runtime fingerprint.',
                });
            }
            proof.marker = { status: 'matched', basis: 'completion_marker_fingerprint' };
            proof.fingerprint = { status: 'matched', basis: 'completion_marker_fingerprint' };
        } else {
            proof.marker = { status: 'missing', basis: 'completion_marker_missing' };
            if (snapshotFingerprintMatches) {
                proof.fingerprint = { status: 'matched', basis: snapshotEvidence.basis };
            } else {
                proof.fingerprint = proof.snapshot.status === 'failed'
                    ? { status: 'failed', basis: proof.snapshot.basis }
                    : { status: 'unproven', basis: 'no_trusted_fingerprint_evidence' };
                return withProof({
                    status: 'requires_reindex',
                    reason: 'requires_reindex',
                    message: `Repair cannot prove vector provenance for collection '${selectedCollection}' because the completion marker is missing and no trusted matching fingerprint was supplied.`,
                });
            }
        }
        publishProof();

        // 3. Load ignore/index policy and indexable files
        await this.loadIgnorePatterns(canonicalPath);
        const codeFiles = await this.getCodeFiles(canonicalPath);
        const trackedRelativePaths = this.normalizeRelativePathsForCodebase(canonicalPath, codeFiles);

        if (codeFiles.length === 0) {
            if (await this.collectionHasAnyIndexedPayload(selectedCollection)) {
                proof.payload = {
                    status: 'failed',
                    basis: 'remote_payload_without_indexable_source',
                    expectedCount: 0,
                };
                proof.staleRemoteChunks = {
                    status: 'failed',
                    basis: 'remote_payload_without_indexable_source',
                };
                return withProof({
                    status: 'requires_reindex',
                    reason: 'requires_reindex',
                    message: `Coverage verification failed: collection '${selectedCollection}' contains remote chunks but the current index policy finds no indexable files.`,
                    missingCount: 0,
                    trackedRelativePaths,
                });
            }
            proof.payload = {
                status: 'matched',
                basis: 'empty_source_and_payload',
                expectedCount: 0,
                observedCount: 0,
                missingCount: 0,
            };
            proof.staleRemoteChunks = {
                status: 'matched',
                basis: 'empty_source_and_payload',
                extraCount: 0,
            };
            await this.clearSymbolRegistryForCodebase(canonicalPath, options.assertMutationCurrent);
            await this.writeCompletedIndexMarker(
                canonicalPath,
                0,
                0,
                selectedCollection,
                'completed',
                options.assertMutationCurrent,
            );
            proof.navigation = { status: 'matched', basis: 'navigation_sidecars_rebuilt' };
            return withProof({
                status: 'ok',
                message: 'No files to index. Local readiness repaired (navigation sidecars rebuilt, fresh completion marker written) without vector writes.',
                indexedFiles: 0,
                totalChunks: 0,
                warnings: [],
                trackedRelativePaths,
                collectionName: selectedCollection,
            });
        }

        // 4. Split source files and compute expected chunk IDs
        const { expectedChunks, symbolRecords, symbolManifestFiles } = await this.getExpectedChunksAndSymbols(codeFiles, canonicalPath);

        // 5. Query vector backend for expected chunk IDs.
        const existingIds = new Set<string>();
        const expectedIds = expectedChunks.map((chunk) => chunk.id);
        const chunkIdBatchSize = 512;
        for (let index = 0; index < expectedIds.length; index += chunkIdBatchSize) {
            const batch = expectedIds.slice(index, index + chunkIdBatchSize);
            const rows = await this.vectorDatabase.query(
                selectedCollection,
                buildMilvusIdInFilter(batch),
                ['id'],
                batch.length
            );
            for (const row of rows) {
                const id = typeof row?.id === 'string' ? row.id : '';
                if (id && id !== INDEX_COMPLETION_MARKER_DOC_ID) {
                    existingIds.add(id);
                }
            }
        }

        // Check chunk coverage
        let missingChunksCount = 0;
        for (const chunk of expectedChunks) {
            if (!existingIds.has(chunk.id)) {
                missingChunksCount++;
            }
        }

        // Check file coverage (every expected indexed file must have at least one chunk in existingIds, unless it legitimately produces 0 chunks)
        const fileToChunksMap = new Map<string, string[]>();
        for (const chunk of expectedChunks) {
            if (!fileToChunksMap.has(chunk.relativePath)) {
                fileToChunksMap.set(chunk.relativePath, []);
            }
            fileToChunksMap.get(chunk.relativePath)!.push(chunk.id);
        }

        let hasFileCoverageIssue = false;
        for (const file of codeFiles) {
            const relPath = this.normalizeRelativePathForCodebase(canonicalPath, file);
            if (!relPath) continue;
            const expectedIdsForFile = fileToChunksMap.get(relPath) || [];
            if (expectedIdsForFile.length > 0) {
                const hasAny = expectedIdsForFile.some(id => existingIds.has(id));
                if (!hasAny) {
                    hasFileCoverageIssue = true;
                }
            }
        }

        if (missingChunksCount > 0 || hasFileCoverageIssue) {
            const effectiveMissingCount = missingChunksCount || 1;
            proof.payload = {
                status: 'failed',
                basis: 'expected_chunks_missing',
                expectedCount: expectedChunks.length,
                observedCount: existingIds.size,
                missingCount: effectiveMissingCount,
            };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: `Coverage verification failed: ${missingChunksCount || (hasFileCoverageIssue ? 1 : 0)} expected chunk(s) are missing from collection '${selectedCollection}'.`,
                missingCount: effectiveMissingCount,
            });
        }

        proof.payload = {
            status: 'unproven',
            basis: 'expected_chunk_coverage_only',
            expectedCount: expectedChunks.length,
            observedCount: existingIds.size,
            missingCount: 0,
        };
        publishProof();

        const expectedIdsSet = new Set(expectedChunks.map(c => c.id));
        const maxExactPayloadProbeRows = 16384;
        const remotePayloadLimit = expectedChunks.length + 1;
        if (remotePayloadLimit > maxExactPayloadProbeRows) {
            proof.payload = {
                status: 'unproven',
                basis: 'exact_payload_query_limit_exceeded',
                expectedCount: expectedChunks.length,
                observedCount: existingIds.size,
                missingCount: 0,
            };
            proof.staleRemoteChunks = {
                status: 'unproven',
                basis: 'exact_payload_query_limit_exceeded',
            };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: `Coverage verification failed: repair cannot prove exact remote payload equality for ${expectedChunks.length} expected chunks with the current vector query limit.`,
                missingCount: 0,
                trackedRelativePaths,
            });
        }
        // Repair relies on query(filter, limit=N+1) returning N+1 rows when more than N payload rows exist.
        const remotePayloadRows = await this.vectorDatabase.query(
            selectedCollection,
            'fileExtension != ".satori_meta"',
            ['id'],
            remotePayloadLimit
        );
        const extraRemoteIds = new Set<string>();
        for (const row of remotePayloadRows) {
            const id = typeof row?.id === 'string' ? row.id : '';
            if (id && !expectedIdsSet.has(id)) {
                extraRemoteIds.add(id);
            }
        }

        if (remotePayloadRows.length !== expectedChunks.length || extraRemoteIds.size > 0) {
            const extraCount = Math.max(0, remotePayloadRows.length - expectedChunks.length, extraRemoteIds.size);
            proof.payload = {
                status: 'failed',
                basis: 'remote_payload_not_exact',
                expectedCount: expectedChunks.length,
                observedCount: remotePayloadRows.length,
                missingCount: 0,
                extraCount,
            };
            proof.staleRemoteChunks = {
                status: 'failed',
                basis: 'unexpected_remote_chunks',
                extraCount,
            };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: `Coverage verification failed: collection '${selectedCollection}' contains ${extraCount || 'unexpected'} stale remote chunk(s) outside the current indexable source set.`,
                missingCount: 0,
                trackedRelativePaths,
            });
        }
        proof.payload = {
            status: 'matched',
            basis: 'exact_remote_payload_equality',
            expectedCount: expectedChunks.length,
            observedCount: remotePayloadRows.length,
            missingCount: 0,
            extraCount: 0,
        };
        proof.staleRemoteChunks = {
            status: 'matched',
            basis: 'no_unexpected_remote_chunks',
            extraCount: 0,
        };
        proof.navigation = {
            status: 'unproven',
            basis: 'navigation_rebuild_in_progress',
        };
        publishProof();

        // 6. Rebuild symbol registry/relationship sidecars
        await this.writeSymbolRegistryForCompletedIndex(
            canonicalPath,
            symbolRecords,
            symbolManifestFiles,
            options.assertMutationCurrent,
        );

        // 7. Write new completion marker
        await this.writeCompletedIndexMarker(
            canonicalPath,
            codeFiles.length,
            expectedChunks.length,
            selectedCollection,
            'completed',
            options.assertMutationCurrent,
        );

        proof.navigation = { status: 'matched', basis: 'navigation_sidecars_rebuilt' };
        return withProof({
            status: 'ok',
            message: 'Local readiness repaired (navigation sidecars rebuilt, fresh completion marker written) without vector writes.',
            indexedFiles: codeFiles.length,
            totalChunks: expectedChunks.length,
            warnings: [],
            trackedRelativePaths,
            collectionName: selectedCollection,
        });
    }

    private getSymbolExtractorVersion(): string {
        return 'splitter-symbol-builder-v1+language-extractors-v1';
    }

    private extractSymbolsForFile(language: string, content: string, relativePath: string): readonly ExtractedSymbol[] | undefined {
        const extractor = getSymbolExtractorForLanguage(language);
        if (!extractor) {
            return undefined;
        }
        try {
            return extractor.extract({ content, relativePath });
        } catch (error) {
            console.warn(`[Context] ⚠️  Symbol extractor failed for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    private getLanguageRouterVersion(): string {
        return 'language-router-v1';
    }

    private getRelationshipVersion(): string {
        return 'relationship-v1';
    }

    private buildIndexPolicyHash(codebasePath: string): string {
        const payload = JSON.stringify({
            profile: this.indexProfilesByCodebase.get(this.canonicalizeCodebasePath(codebasePath)) || 'default',
            extensions: this.getIndexedExtensionsForCodebase(codebasePath),
            ignorePatterns: this.getActiveIgnorePatterns(codebasePath),
        });
        return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    }

    private buildRootFingerprint(canonicalRoot: string): string {
        return crypto.createHash('md5').update(canonicalRoot, 'utf8').digest('hex');
    }

    private async buildNavigationArtifactsForFiles(
        filePaths: string[],
        codebasePath: string
    ): Promise<{
        symbolRecords: SymbolRecord[];
        symbolManifestFiles: SymbolRegistryManifestFile[];
    }> {
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];

        for (const filePath of [...filePaths].sort((a, b) => a.localeCompare(b))) {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const language = this.getLanguageFromFilePath(filePath);
            const relativePath = this.normalizeRelativePathForCodebase(codebasePath, filePath);
            if (!relativePath) {
                throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
            }

            const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
            const chunks = await this.codeSplitter.split(content, language, filePath);
            const extractedSymbols = this.extractSymbolsForFile(language, content, relativePath);
            const fileSymbols = buildSymbolRecordsForFile({
                relativePath,
                language,
                content,
                fileHash,
                extractorVersion: this.getSymbolExtractorVersion(),
                ...(extractedSymbols !== undefined ? { extractedSymbols } : {}),
                chunks,
            });

            symbolRecords.push(...fileSymbols);
            symbolManifestFiles.push({
                path: relativePath,
                hash: fileHash,
                language,
                symbolCount: fileSymbols.length,
            });
        }

        return {
            symbolRecords,
            symbolManifestFiles,
        };
    }

    private async rebuildNavigationArtifacts(
        codebasePath: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const codeFiles = await this.getCodeFiles(codebasePath);
        if (codeFiles.length === 0) {
            await this.clearSymbolRegistryForCodebase(codebasePath, assertMutationCurrent);
            return;
        }

        const navigationArtifacts = await this.buildNavigationArtifactsForFiles(codeFiles, codebasePath);
        await this.writeSymbolRegistryForCompletedIndex(
            codebasePath,
            navigationArtifacts.symbolRecords,
            navigationArtifacts.symbolManifestFiles,
            assertMutationCurrent,
        );
    }

    private async rebuildNavigationArtifactsForSyncDelta(
        codebasePath: string,
        existingRegistry: SymbolRegistry,
        changedRelativePaths: string[],
        rebuiltSymbolRecords: SymbolRecord[],
        rebuiltManifestFiles: SymbolRegistryManifestFile[],
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const replacedPaths = new Set<string>([
            ...changedRelativePaths.map((filePath) => filePath.replace(/\\/g, '/').replace(/^\/+/, '')),
            ...rebuiltManifestFiles.map((file) => file.path),
        ]);

        const mergedManifestFiles = [
            ...existingRegistry.manifest.files.filter((file) => !replacedPaths.has(file.path)),
            ...rebuiltManifestFiles,
        ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

        if (mergedManifestFiles.length === 0) {
            await this.clearSymbolRegistryForCodebase(codebasePath, assertMutationCurrent);
            return;
        }

        const mergedSymbolRecords = [
            ...existingRegistry.symbols.filter((symbol) => !replacedPaths.has(symbol.file)),
            ...rebuiltSymbolRecords,
        ];

        await this.writeSymbolRegistryForCompletedIndex(
            codebasePath,
            mergedSymbolRecords,
            mergedManifestFiles,
            assertMutationCurrent,
        );
    }

    private async writeSymbolRegistryForCompletedIndex(
        codebasePath: string,
        symbolRecords: SymbolRecord[],
        symbolManifestFiles: SymbolRegistryManifestFile[],
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const manifestFiles = [...symbolManifestFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const registry = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: canonicalRoot,
                rootFingerprint: this.buildRootFingerprint(canonicalRoot),
                indexPolicyHash: this.buildIndexPolicyHash(codebasePath),
                languageRouterVersion: this.getLanguageRouterVersion(),
                extractorVersion: this.getSymbolExtractorVersion(),
                relationshipVersion: this.getRelationshipVersion(),
                builtAt: new Date().toISOString(),
                files: manifestFiles,
            },
            symbols: symbolRecords,
        });

        assertMutationCurrent?.();
        const result = await writeSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            registry,
            beforePublish: assertMutationCurrent,
        });
        const contentByFile = new Map<string, string>();
        for (const file of manifestFiles) {
            try {
                contentByFile.set(file.path, await fs.promises.readFile(path.join(canonicalRoot, file.path), 'utf8'));
            } catch (error) {
                console.warn(`[Context] ⚠️  Skipping relationship extraction for ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const relationshipRecords = buildRelationshipsForRegistry({ registry, contentByFile });
        assertMutationCurrent?.();
        const relationshipResult = await writeRelationshipSidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: canonicalRoot,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipVersion: registry.manifest.relationshipVersion,
            builtAt: registry.manifest.builtAt,
            files: manifestFiles,
            records: relationshipRecords,
            beforePublish: assertMutationCurrent,
        });
        console.log(`[Context] 🧭 Wrote symbol registry sidecar with ${result.symbolCount} symbols across ${result.fileShardCount} file shards`);
        console.log(`[Context] 🧭 Wrote relationship sidecar with ${relationshipResult.relationshipCount} relationships across ${relationshipResult.fileShardCount} file shards`);
        assertMutationCurrent?.();
        try {
            const sqliteResult = await importNavigationToSqlite({
                stateRoot: this.symbolRegistryStateRoot,
                normalizedRootPath: canonicalRoot,
                beforePublish: assertMutationCurrent,
            });
            console.log(`[Context] 🧭 Imported navigation sqlite cache at ${resolveNavigationSqlitePath(this.symbolRegistryStateRoot, canonicalRoot)} with ${sqliteResult.symbolCount} symbols and ${sqliteResult.relationshipCount} relationships`);
        } catch (error) {
            assertMutationCurrent?.();
            const sqlitePath = resolveNavigationSqlitePath(this.symbolRegistryStateRoot, canonicalRoot);
            try {
                await fs.promises.rm(sqlitePath, { recursive: true, force: true });
            } catch (removeError) {
                console.warn(`[Context] ⚠️  Failed to remove stale navigation sqlite cache at ${sqlitePath}: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
            }
            console.warn(`[Context] ⚠️  Failed to import navigation sqlite cache for ${canonicalRoot}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async clearSymbolRegistryForCodebase(
        codebasePath: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        assertMutationCurrent?.();
        await clearSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
        });
    }

    /**
 * Process accumulated chunk buffer
 */
    private async processChunkBuffer(
        chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>,
        collectionName: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        if (chunkBuffer.length === 0) return;

        // Extract chunks and ensure they all have the same codebasePath
        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        await this.processChunkBatch(chunks, codebasePath, collectionName, assertMutationCurrent);
    }

    /**
     * Process a batch of chunks
     */
    private async processChunkBatch(
        chunks: CodeChunk[],
        codebasePath: string,
        collectionName: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
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
                const { filePath: omittedFilePath, startLine: omittedStartLine, endLine: omittedEndLine, ...restMetadata } = chunk.metadata;
                void omittedFilePath;
                void omittedStartLine;
                void omittedEndLine;

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
            assertMutationCurrent?.();
            await this.vectorDatabase.insertHybrid(collectionName, documents);
        } else {
            // Create regular vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath: omittedFilePath, startLine: omittedStartLine, endLine: omittedEndLine, ...restMetadata } = chunk.metadata;
                void omittedFilePath;
                void omittedStartLine;
                void omittedEndLine;

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
            assertMutationCurrent?.();
            await this.vectorDatabase.insert(collectionName, documents);
        }
    }

    /**
     * Get programming language based on file extension
     */
    private getLanguageFromFilePath(filePath: string): string {
        return getLanguageIdFromFilename(filePath, 'text');
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
                .map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
                .filter(line => line.length > 0 && !line.startsWith('#'));
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
        } catch {
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

        this.runtimeCustomExtensions = normalizeSupportedExtensions([
            ...this.runtimeCustomExtensions,
            ...customExtensions
        ]);
        this.supportedExtensions = this.buildSupportedExtensions('default');
        console.log(`[Context] 📎 Added ${customExtensions.length} custom extensions. Runtime total: ${this.runtimeCustomExtensions.length} extensions`);
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

        // The legacy fallback splitter is language-agnostic.
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
                    : 'Language not supported by AST, will use recursive fallback splitter'
            };
        } else {
            return {
                strategy: 'langchain',
                reason: 'Using recursive fallback splitter directly'
            };
        }
    }
}
