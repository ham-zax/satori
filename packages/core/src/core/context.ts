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
    isIndexableFileObservationByPolicy,
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
    computeSymbolRegistryManifestHash,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveCurrentNavigationGeneration,
    resolveOwnerSymbolForChunk,
    discardNavigationSidecarGeneration,
    publishNavigationSidecarGeneration,
    stageNavigationSidecarGeneration,
} from '../symbols';
import type {
    StagedNavigationSidecarGeneration,
    SymbolRecord,
    SymbolRegistry,
    SymbolRegistryManifestFile,
} from '../symbols';
import {
    createLanguageAnalysisService,
    LANGUAGE_PARSER_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
    type CodeChunk,
    type LanguageAnalysisPort,
} from '../language-analysis';
import {
    buildRelationshipsForRegistry,
    type RelationshipAnalysisEvidence,
} from '../relationships';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import ignore from 'ignore';
import { FileSynchronizer } from '../sync/synchronizer';
import {
    assertDescriptorBoundIndexingSupported,
    openRegularFileInsideRoot,
    openRegularFileInsideRootNoFollow,
    readFileHandleExactly,
    verifyStableFileObservation,
} from '../sync/root-bound-fs';
import type {
    RepairIndexResult,
    RepairProof,
    RepairSnapshotEvidence,
} from './repair-proof';
import { compareContractStrings } from '../utils/compare-contract-strings';

const DEFAULT_EMBEDDING_BATCH_SIZE = 100;
const MAX_EMBEDDING_BATCH_SIZE = 1000;
const INDEX_POLICY_MALFORMED_LOCK_STALE_MS = 30_000;

type IndexPolicyMutationLockMetadata = {
    pid: number;
    processStartTime?: string;
    ownerToken: string;
    acquiredAt: string;
};

type IndexPolicyMutationLockHandle = {
    descriptor: number;
    lockPath: string;
    ownerToken: string;
};

function resolveLinuxProcessStartTime(pid: number): string | undefined {
    if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = raw.lastIndexOf(')');
        if (commandEnd < 0) return undefined;
        const fieldsAfterCommand = raw.slice(commandEnd + 2).trim().split(/\s+/);
        return fieldsAfterCommand[19] || undefined;
    } catch {
        return undefined;
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function parseIndexPolicyMutationLockMetadata(raw: string): IndexPolicyMutationLockMetadata | null {
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (
            !parsed
            || typeof parsed !== 'object'
            || !Number.isSafeInteger(parsed.pid)
            || Number(parsed.pid) <= 0
            || typeof parsed.ownerToken !== 'string'
            || parsed.ownerToken.length === 0
            || typeof parsed.acquiredAt !== 'string'
            || (parsed.processStartTime !== undefined && typeof parsed.processStartTime !== 'string')
        ) {
            return null;
        }
        return {
            pid: Number(parsed.pid),
            ownerToken: parsed.ownerToken,
            acquiredAt: parsed.acquiredAt,
            ...(typeof parsed.processStartTime === 'string'
                ? { processStartTime: parsed.processStartTime }
                : {}),
        };
    } catch {
        return null;
    }
}

function resolveEmbeddingBatchSize(rawValue: string | undefined): number {
    if (!rawValue) return DEFAULT_EMBEDDING_BATCH_SIZE;
    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_EMBEDDING_BATCH_SIZE;
    return Math.min(parsed, MAX_EMBEDDING_BATCH_SIZE);
}

export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    languageAnalyzer?: LanguageAnalysisPort;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    symbolRegistryStateRoot?: string;
    indexPolicyStateRoot?: string;
}

export interface CustomIndexPolicyUpdate {
    customExtensions?: string[];
    customIgnorePatterns?: string[];
}

export interface ResolvedIndexPolicy {
    canonicalRoot: string;
    profile: IndexProfile;
    customExtensions: string[];
    customIgnorePatterns: string[];
    fileBasedIgnorePatterns: string[];
    supportedExtensions: string[];
    effectiveIgnorePatterns: string[];
    policyHash: string;
}

export type IndexPolicyPublicationReceipt =
    | {
        status: 'committed';
        operation: 'publish';
        canonicalRoot: string;
        documentDigest: string;
        policyHash: string;
        collectionName: string;
        navigationGenerationId?: string;
    }
    | {
        status: 'committed';
        operation: 'clear';
        canonicalRoot: string;
        previousDocumentDigest: string | null;
    };

export class IndexPolicyPublicationError extends Error {
    readonly committed = true;

    constructor(
        message: string,
        readonly receipt: IndexPolicyPublicationReceipt,
        readonly publicationCause: unknown,
    ) {
        super(message);
        this.name = 'IndexPolicyPublicationError';
    }
}

export type CompletionMarkerValidationEvidence =
    | { status: 'valid_v2'; marker: IndexCompletionMarkerDocument }
    | { status: 'invalid_v2' }
    | { status: 'runtime_policy_incompatible' }
    | { status: 'legacy_v1'; marker: unknown }
    | { status: 'missing' };

interface CodebaseIgnoreState {
    canonicalRoot: string;
    fileBasedPatterns: string[];
    effectivePatterns: string[];
    matcher: ReturnType<typeof ignore> | null;
}

type RepairIndexOptions = {
    snapshotEvidence?: RepairSnapshotEvidence;
    preferredCollectionName?: string;
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
    onProofUpdate?: (proof: RepairProof) => void;
};

type RepairCompletionMarkerResolution =
    | { status: 'missing' }
    | { status: 'malformed' }
    | { status: 'matched'; marker: IndexCompletionMarkerDocument };

type ReindexByChangeOptions = {
    targetCollectionName?: string;
    maintainCompletionMarker?: boolean;
    externallyManagedPublication?: boolean;
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
};

type MutationGuardOptions = {
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
    deferFullIndexPublication?: boolean;
    indexPolicy?: ResolvedIndexPolicy;
};

export type IndexCodebaseResult = {
    indexedFiles: number;
    totalChunks: number;
    status: 'completed' | 'limit_reached';
    navigationCandidate?: StagedNavigationSidecarGeneration;
};

function chunksWithTrustedRelativePath(
    chunks: readonly CodeChunk[],
    relativePath: string,
): CodeChunk[] {
    return chunks.map((chunk) => ({
        ...chunk,
        metadata: { ...chunk.metadata, filePath: relativePath },
    }));
}

type ReindexByChangeResult = {
    added: number;
    removed: number;
    modified: number;
    changedFiles: string[];
    navigationRecovery?: 'rebuilt' | 'failed';
    collectionName?: string;
    indexedFiles?: number;
    totalChunks?: number;
    indexStatus?: 'completed' | 'limit_reached';
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
    private readonly languageAnalyzer: LanguageAnalysisPort;
    private supportedExtensions: string[];
    private configuredExtensionOverlays: string[];
    private runtimeCustomExtensionsByCodebase: Map<string, string[]>;
    private indexProfilesByCodebase: Map<string, IndexProfile>;
    private baseIgnorePatterns: string[];
    private runtimeCustomIgnorePatternsByCodebase: Map<string, string[]>;
    private loadedCustomPolicyRoots: Set<string>;
    private policyFileTokensByCodebase: Map<string, string | null>;
    private policyRuntimeCompatibilityByCodebase: Map<string, boolean>;
    private publishedPolicyBindingsByCodebase: Map<string, {
        policyHash: string;
        collectionName: string;
        navigationGenerationId?: string;
    }>;
    private publishedResolvedPoliciesByCodebase: Map<string, ResolvedIndexPolicy>;
    private readonly indexPolicyStateRoot: string;
    private ignoreStateByCollection: Map<string, CodebaseIgnoreState>;
    private synchronizers = new Map<string, FileSynchronizer>();
    private synchronizerMutationTargets = new Map<string, string>();
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

        this.languageAnalyzer = config.languageAnalyzer || createLanguageAnalysisService({
            chunkSize: 2500,
            chunkOverlap: 300,
        });

        // Load custom extensions from environment variables
        const envCustomExtensions = this.getCustomExtensionsFromEnv();

        this.configuredExtensionOverlays = normalizeSupportedExtensions([
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...envCustomExtensions
        ]);
        this.runtimeCustomExtensionsByCodebase = new Map();
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
        this.baseIgnorePatterns = allIgnorePatterns;
        this.runtimeCustomIgnorePatternsByCodebase = new Map();
        this.loadedCustomPolicyRoots = new Set();
        this.policyFileTokensByCodebase = new Map();
        this.policyRuntimeCompatibilityByCodebase = new Map();
        this.publishedPolicyBindingsByCodebase = new Map();
        this.publishedResolvedPoliciesByCodebase = new Map();
        this.indexPolicyStateRoot = config.indexPolicyStateRoot
            ?? path.join(os.homedir(), '.satori', 'index-policy');
        this.ignoreStateByCollection = new Map();
        this.symbolRegistryStateRoot = config.symbolRegistryStateRoot;

        console.log(`[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.baseIgnorePatterns.length} base ignore patterns`);
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
     * Get the normalized language-analysis boundary.
     */
    getLanguageAnalyzer(): LanguageAnalysisPort {
        return this.languageAnalyzer;
    }

    /**
     * Get supported extensions
     */
    getIndexedExtensions(): string[] {
        return [...this.supportedExtensions];
    }

    getIndexedExtensionsForCodebase(codebasePath: string): string[] {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.loadCustomIndexPolicy(canonicalRoot);
        const profile = this.indexProfilesByCodebase.get(canonicalRoot) || 'default';
        return this.buildSupportedExtensions(profile, canonicalRoot);
    }

    loadIndexProfileForCodebase(codebasePath: string): SatoriRepoConfig {
        const config = loadSatoriRepoConfig(codebasePath);
        this.setIndexProfileForCodebase(codebasePath, config.profile);
        return config;
    }

    setIndexProfileForCodebase(codebasePath: string, profile: IndexProfile): void {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.indexProfilesByCodebase.set(canonicalRoot, profile);
        this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
    }

    /**
     * Get effective ignore patterns.
     * When codebasePath is provided, returns per-codebase effective rules.
     * Without a codebase path, returns global base+runtime layers only.
     */
    getActiveIgnorePatterns(codebasePath?: string): string[] {
        if (!codebasePath) {
            return [...this.baseIgnorePatterns];
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
        this.synchronizerMutationTargets.delete(collectionName);
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
        assertDescriptorBoundIndexingSupported();
        return this.prepareCollection(codebasePath, false, assertMutationCurrent);
    }

    /**
     * Recreate synchronizer for a codebase using currently active ignore patterns.
     * This is used when ignore rules change and we need deterministic reconciliation.
     */
    async recreateSynchronizerForCodebase(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        this.loadIndexProfileForCodebase(codebasePath);
        const collectionName = this.resolveCollectionName(codebasePath);
        const synchronizer = new FileSynchronizer(
            codebasePath,
            this.getActiveIgnorePatterns(codebasePath),
            this.getIndexedExtensionsForCodebase(codebasePath)
        );
        await synchronizer.initialize(assertMutationCurrent, publishMutation);
        this.synchronizers.set(collectionName, synchronizer);
        this.synchronizerMutationTargets.delete(collectionName);
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

        if (!parsed || parsed.kind !== 'satori_index_completion_v2') {
            return null;
        }
        if (typeof parsed.codebasePath !== 'string' || typeof parsed.runId !== 'string' || parsed.runId.trim().length === 0) {
            return null;
        }
        if (!parsed.fingerprint || typeof parsed.fingerprint !== 'object') {
            return null;
        }

        const indexedFiles = parsed.indexedFiles;
        const totalChunks = parsed.totalChunks;
        if (!Number.isSafeInteger(indexedFiles) || Number(indexedFiles) < 0
            || !Number.isSafeInteger(totalChunks) || Number(totalChunks) < 0) {
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

        if (typeof parsed.indexPolicyHash !== 'string' || parsed.indexPolicyHash.length === 0) {
            return null;
        }
        const indexStatus = parsed.indexStatus === 'limit_reached' || parsed.indexStatus === 'completed'
            ? parsed.indexStatus
            : undefined;
        const navigationFields = [
            parsed.navigationGenerationId,
            parsed.symbolRegistryManifestHash,
            parsed.relationshipManifestHash,
        ];
        if (
            navigationFields.some((value) => value !== undefined)
            && !navigationFields.every((value) => typeof value === 'string' && value.length > 0)
        ) {
            return null;
        }

        return {
            kind: 'satori_index_completion_v2',
            codebasePath: parsedCodebasePath,
            fingerprint: parsed.fingerprint as IndexCompletionFingerprint,
            indexedFiles: Number(indexedFiles),
            totalChunks: Number(totalChunks),
            completedAt: parsed.completedAt,
            runId: parsed.runId,
            indexPolicyHash: parsed.indexPolicyHash,
            ...(indexStatus ? { indexStatus } : {}),
            ...(typeof parsed.navigationGenerationId === 'string' ? {
                navigationGenerationId: parsed.navigationGenerationId,
                symbolRegistryManifestHash: parsed.symbolRegistryManifestHash as string,
                relationshipManifestHash: parsed.relationshipManifestHash as string,
            } : {}),
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
        const payloadFilter = 'fileExtension != ".satori_meta"';
        const count = await this.countIndexedPayloadExactly(collectionName, payloadFilter, marker.totalChunks);
        return count === marker.totalChunks;
    }

    private async countIndexedPayloadExactly(
        collectionName: string,
        filter: string,
        expectedMaximum?: number,
    ): Promise<number | null> {
        if (typeof this.vectorDatabase.count === 'function') {
            return this.vectorDatabase.count(collectionName, filter);
        }

        // Query-only adapters can prove bounded result sets by requesting one row
        // beyond the expected maximum. A full-size response is ambiguous because
        // the backend may have truncated it, so fail closed.
        const maximumExactQueryRows = 16384;
        const limit = expectedMaximum === undefined
            ? maximumExactQueryRows
            : expectedMaximum + 1;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumExactQueryRows) {
            return null;
        }
        const rows = await this.vectorDatabase.query(collectionName, filter, ['id'], limit);
        if (expectedMaximum === undefined && rows.length === maximumExactQueryRows) {
            return null;
        }
        return rows.length;
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
            parserVersion: LANGUAGE_PARSER_VERSION,
            extractorVersion: SYMBOL_EXTRACTOR_VERSION,
            relationshipVersion: RELATIONSHIP_BUILDER_VERSION,
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
            && record.schemaVersion === right.schemaVersion
            && record.parserVersion === right.parserVersion
            && record.extractorVersion === right.extractorVersion
            && record.relationshipVersion === right.relationshipVersion;
    }

    private async writeCompletedIndexMarker(
        codebasePath: string,
        indexedFiles: number,
        totalChunks: number,
        collectionName?: string,
        indexStatus: 'completed' | 'limit_reached' = 'completed',
        assertMutationCurrent?: () => void,
        navigationCandidate?: StagedNavigationSidecarGeneration,
        indexPolicyHash: string = this.buildIndexPolicyHash(codebasePath),
    ): Promise<void> {
        const currentNavigation = indexStatus === 'completed' && !navigationCandidate
            ? await resolveCurrentNavigationGeneration(
                this.symbolRegistryStateRoot,
                this.canonicalizeCodebasePath(codebasePath),
            ).catch(() => null)
            : null;
        await this.writeIndexCompletionMarker(codebasePath, {
            kind: 'satori_index_completion_v2',
            codebasePath: this.canonicalizeCodebasePath(codebasePath),
            fingerprint: this.buildIndexCompletionFingerprint(),
            indexedFiles,
            totalChunks,
            completedAt: new Date().toISOString(),
            runId: crypto.randomUUID(),
            indexPolicyHash,
            indexStatus,
            ...(navigationCandidate ? {
                navigationGenerationId: navigationCandidate.generationId,
                symbolRegistryManifestHash: navigationCandidate.manifestHash,
                relationshipManifestHash: navigationCandidate.relationshipManifestHash,
            } : currentNavigation ? {
                navigationGenerationId: currentNavigation.generationId,
                symbolRegistryManifestHash: currentNavigation.symbolRegistryManifestHash,
                relationshipManifestHash: currentNavigation.relationshipManifestHash,
            } : {}),
        }, collectionName, assertMutationCurrent);
    }

    private async resolveActiveIndexedCollection(
        codebasePath: string
    ): Promise<{ collectionName: string; marker: IndexCompletionMarkerDocument } | null> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        const publishedPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const policyBinding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        if (
            !publishedPolicy
            || !policyBinding
            || publishedPolicy.canonicalRoot !== canonicalRoot
            || policyBinding.policyHash !== publishedPolicy.policyHash
            || this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
        ) {
            return null;
        }
        const {
            activeFamilyName,
            alternateFamilyName,
        } = this.buildCollectionFamilies(codebasePath);
        const familyCollectionNames = await this.listRelatedCollectionNames(codebasePath);
        const runtimeFingerprint = this.buildIndexCompletionFingerprint();
        const activePolicyHash = publishedPolicy.policyHash;

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
            if (!this.indexCompletionFingerprintsMatch(marker.fingerprint, runtimeFingerprint)) {
                continue;
            }
            if (marker.indexPolicyHash !== activePolicyHash) {
                continue;
            }
            if (
                policyBinding.policyHash !== marker.indexPolicyHash
                || policyBinding.collectionName !== collectionName
                || (policyBinding.navigationGenerationId ?? undefined) !== (marker.navigationGenerationId ?? undefined)
            ) {
                continue;
            }
            if (!(await this.collectionHasIndexedPayload(collectionName, marker))) {
                continue;
            }
            if (marker.navigationGenerationId) {
                const currentNavigation = await resolveCurrentNavigationGeneration(
                    this.symbolRegistryStateRoot,
                    this.canonicalizeCodebasePath(codebasePath),
                ).catch(() => null);
                if (
                    !currentNavigation
                    || currentNavigation.generationId !== marker.navigationGenerationId
                    || currentNavigation.symbolRegistryManifestHash !== marker.symbolRegistryManifestHash
                    || currentNavigation.relationshipManifestHash !== marker.relationshipManifestHash
                ) {
                    continue;
                }
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

    public async resolveProvenGeneration(codebasePath: string): Promise<{
        collectionName: string;
        marker: IndexCompletionMarkerDocument;
        navigation: import('../symbols/sidecar').CurrentNavigationGeneration | null;
        policy: ResolvedIndexPolicy;
    } | null> {
        const active = await this.resolveActiveIndexedCollection(codebasePath);
        if (!active) return null;
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.loadCustomIndexPolicy(canonicalRoot);
        const publishedPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const policyBinding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        if (
            !publishedPolicy
            || !policyBinding
            || this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
            || publishedPolicy.canonicalRoot !== canonicalRoot
            || publishedPolicy.policyHash !== active.marker.indexPolicyHash
            || policyBinding.policyHash !== active.marker.indexPolicyHash
            || policyBinding.collectionName !== active.collectionName
            || (policyBinding.navigationGenerationId ?? undefined) !== (active.marker.navigationGenerationId ?? undefined)
        ) {
            return null;
        }
        const navigation = active.marker.navigationGenerationId
            ? await resolveCurrentNavigationGeneration(
                this.symbolRegistryStateRoot,
                canonicalRoot,
            ).catch(() => null)
            : null;
        if (
            active.marker.navigationGenerationId
            && (
                !navigation
                || navigation.generationId !== active.marker.navigationGenerationId
                || navigation.symbolRegistryManifestHash !== active.marker.symbolRegistryManifestHash
                || navigation.relationshipManifestHash !== active.marker.relationshipManifestHash
            )
        ) {
            return null;
        }
        const finalActive = await this.resolveActiveIndexedCollection(codebasePath);
        const finalPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const finalBinding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        if (
            !finalActive
            || finalActive.collectionName !== active.collectionName
            || finalActive.marker.runId !== active.marker.runId
            || finalActive.marker.indexPolicyHash !== active.marker.indexPolicyHash
            || finalActive.marker.navigationGenerationId !== active.marker.navigationGenerationId
            || finalActive.marker.symbolRegistryManifestHash !== active.marker.symbolRegistryManifestHash
            || finalActive.marker.relationshipManifestHash !== active.marker.relationshipManifestHash
            || !finalPolicy
            || !finalBinding
            || finalPolicy.policyHash !== active.marker.indexPolicyHash
            || finalBinding.policyHash !== active.marker.indexPolicyHash
            || finalBinding.collectionName !== active.collectionName
            || (finalBinding.navigationGenerationId ?? undefined) !== (active.marker.navigationGenerationId ?? undefined)
        ) {
            return null;
        }
        return {
            collectionName: active.collectionName,
            marker: active.marker,
            navigation,
            policy: {
                ...finalPolicy,
                customExtensions: [...finalPolicy.customExtensions],
                customIgnorePatterns: [...finalPolicy.customIgnorePatterns],
                fileBasedIgnorePatterns: [...finalPolicy.fileBasedIgnorePatterns],
                supportedExtensions: [...finalPolicy.supportedExtensions],
                effectiveIgnorePatterns: [...finalPolicy.effectiveIgnorePatterns],
            },
        };
    }

    private async publishResolvedIndexPolicyForMarker(
        policy: ResolvedIndexPolicy,
        binding: { collectionName: string; navigationGenerationId?: string },
        marker: IndexCompletionMarkerDocument,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        try {
            this.publishResolvedIndexPolicy(policy, binding, publishMutation);
            return;
        } catch (error) {
            const receipt = error instanceof IndexPolicyPublicationError
                ? error.receipt
                : null;
            if (
                !receipt
                || receipt.operation !== 'publish'
                || receipt.canonicalRoot !== policy.canonicalRoot
                || receipt.policyHash !== policy.policyHash
                || receipt.collectionName !== binding.collectionName
                || (receipt.navigationGenerationId ?? undefined) !== (binding.navigationGenerationId ?? undefined)
            ) {
                throw error;
            }
            let proven: Awaited<ReturnType<Context['resolveProvenGeneration']>>;
            try {
                proven = await this.resolveProvenGeneration(policy.canonicalRoot);
            } catch {
                throw error;
            }
            if (
                !proven
                || proven.collectionName !== binding.collectionName
                || proven.marker.runId !== marker.runId
                || proven.marker.indexPolicyHash !== marker.indexPolicyHash
                || (proven.marker.navigationGenerationId ?? undefined) !== (marker.navigationGenerationId ?? undefined)
                || proven.marker.symbolRegistryManifestHash !== marker.symbolRegistryManifestHash
                || proven.marker.relationshipManifestHash !== marker.relationshipManifestHash
            ) {
                throw error;
            }
        }
    }

    private async publishSealedPolicyBindingForMarker(
        codebasePath: string,
        collectionName: string,
        marker: IndexCompletionMarkerDocument,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        const policy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        if (!policy || this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true) {
            throw new Error(`Cannot publish generation '${collectionName}': no runtime-compatible sealed index policy is available.`);
        }
        if (policy.policyHash !== marker.indexPolicyHash) {
            throw new Error(`Cannot publish generation '${collectionName}': completion marker and sealed policy hashes differ.`);
        }
        const currentBinding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        if (
            currentBinding?.policyHash === marker.indexPolicyHash
            && currentBinding.collectionName === collectionName
            && (currentBinding.navigationGenerationId ?? undefined) === (marker.navigationGenerationId ?? undefined)
        ) {
            return;
        }
        await this.publishResolvedIndexPolicyForMarker(policy, {
            collectionName,
            ...(marker.navigationGenerationId
                ? { navigationGenerationId: marker.navigationGenerationId }
                : {}),
        }, marker, publishMutation);
    }

    private async resolveCompletionProofCollection(
        codebasePath: string,
    ): Promise<{ collectionName: string; marker: IndexCompletionMarkerDocument } | null> {
        const candidates: Array<{ collectionName: string; marker: IndexCompletionMarkerDocument }> = [];
        for (const collectionName of await this.listRelatedCollectionNames(codebasePath)) {
            const marker = await this.resolveCompletionMarkerForCollection(codebasePath, collectionName);
            if (!marker || !(await this.collectionHasIndexedPayload(collectionName, marker))) {
                continue;
            }
            candidates.push({ collectionName, marker });
        }
        candidates.sort((left, right) => (
            Date.parse(right.marker.completedAt) - Date.parse(left.marker.completedAt)
            || left.collectionName.localeCompare(right.collectionName)
        ));
        return candidates[0] ?? null;
    }

    public async getCompletionProofCollectionName(codebasePath: string): Promise<string | null> {
        return (await this.resolveCompletionProofCollection(codebasePath))?.collectionName ?? null;
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
     * Build and publish a complete codebase generation for semantic search.
     * When `deferFullIndexPublication` is true, vector, marker, policy, and
     * navigation publication remain the caller's staged-generation responsibility.
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
    ): Promise<IndexCodebaseResult> {
        assertDescriptorBoundIndexingSupported();
        if (options.indexPolicy) {
            this.assertResolvedIndexPolicyRoot(codebasePath, options.indexPolicy);
        }
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);

        this.loadIndexProfileForCodebase(codebasePath);
        const indexPolicy = options.indexPolicy
            ?? await this.resolveIndexPolicyForCodebase(codebasePath);

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        // indexCodebase is a full rebuild. Reusing an existing collection would retain
        // remote rows for deleted files or changed chunk boundaries.
        await this.prepareCollection(codebasePath, true, options.assertMutationCurrent);
        await this.clearIndexCompletionMarker(codebasePath, options.assertMutationCurrent);

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const codeFiles = await this.getCodeFiles(codebasePath, indexPolicy);
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            const navigationCandidate = await this.writeSymbolRegistryForCompletedIndex(
                codebasePath,
                [],
                [],
                options.assertMutationCurrent,
                new Map(),
                options.publishMutation,
                options.deferFullIndexPublication === true,
                indexPolicy,
            );
            if (!options.deferFullIndexPublication) {
                await this.writeCompletedIndexMarker(codebasePath, 0, 0, undefined, 'completed', options.assertMutationCurrent, navigationCandidate, indexPolicy.policyHash);
                const marker = await this.resolveCompletionMarkerForCollection(
                    codebasePath,
                    this.getWriteCollectionName(codebasePath),
                );
                if (!marker) {
                    throw new Error(`Completed index did not produce a completion marker for '${this.getWriteCollectionName(codebasePath)}'.`);
                }
                await this.publishResolvedIndexPolicyForMarker(indexPolicy, {
                    collectionName: this.getWriteCollectionName(codebasePath),
                    ...(navigationCandidate ? { navigationGenerationId: navigationCandidate.generationId } : {}),
                }, marker, options.publishMutation);
            }
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed', ...(navigationCandidate ? { navigationCandidate } : {}) };
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
            },
            undefined,
            options.assertMutationCurrent,
            indexPolicy,
        );

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

        let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
        if (result.status === 'completed') {
            navigationCandidate = await this.writeSymbolRegistryForCompletedIndex(
                codebasePath,
                result.symbolRecords,
                result.symbolManifestFiles,
                options.assertMutationCurrent,
                result.analysisByFile,
                options.publishMutation,
                options.deferFullIndexPublication === true,
                indexPolicy,
            );
            if (!options.deferFullIndexPublication) {
                await this.writeCompletedIndexMarker(codebasePath, result.processedFiles, result.totalChunks, undefined, 'completed', options.assertMutationCurrent, navigationCandidate, indexPolicy.policyHash);
                const marker = await this.resolveCompletionMarkerForCollection(
                    codebasePath,
                    this.getWriteCollectionName(codebasePath),
                );
                if (!marker) {
                    throw new Error(`Completed index did not produce a completion marker for '${this.getWriteCollectionName(codebasePath)}'.`);
                }
                await this.publishResolvedIndexPolicyForMarker(indexPolicy, {
                    collectionName: this.getWriteCollectionName(codebasePath),
                    ...(navigationCandidate ? { navigationGenerationId: navigationCandidate.generationId } : {}),
                }, marker, options.publishMutation);
            }
        } else {
            // limit_reached: do not publish complete navigation sidecars, but seal partial vector
            // proof so MCP readiness can allow warned partial search (not "missing marker" stale_local).
            // indexStatus must stay on the marker so interrupted-index recovery does not promote as fully completed.
            console.warn('[Context] ⚠️  Skipping symbol registry sidecar write because indexing stopped before processing the full file set.');
            if (!options.deferFullIndexPublication) {
                await this.writeCompletedIndexMarker(codebasePath, result.processedFiles, result.totalChunks, undefined, 'limit_reached', options.assertMutationCurrent, undefined, indexPolicy.policyHash);
                const marker = await this.resolveCompletionMarkerForCollection(
                    codebasePath,
                    this.getWriteCollectionName(codebasePath),
                );
                if (!marker) {
                    throw new Error(`Partial index did not produce a completion marker for '${this.getWriteCollectionName(codebasePath)}'.`);
                }
                await this.publishResolvedIndexPolicyForMarker(indexPolicy, {
                    collectionName: this.getWriteCollectionName(codebasePath),
                }, marker, options.publishMutation);
                console.warn('[Context] ⚠️  Wrote completion marker for limit_reached partial index (navigation remains unpublished).');
            }
        }

        progressCallback?.({
            phase: result.status === 'completed' ? 'Indexing complete!' : 'Indexing stopped at chunk limit',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100
        });

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status,
            ...(navigationCandidate ? { navigationCandidate } : {}),
        };
    }

    async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: ReindexByChangeOptions = {}
    ): Promise<ReindexByChangeResult> {
        assertDescriptorBoundIndexingSupported();
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
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        if (
            this.publishedResolvedPoliciesByCodebase.has(canonicalRoot)
            && this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
        ) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': no runtime-compatible sealed index policy is available; reindex is required.`);
        }
        const synchronizerKey = this.resolveCollectionName(codebasePath);
        const synchronizer = this.synchronizers.get(synchronizerKey);
        const synchronizerAlreadyExisted = synchronizer !== undefined;
        const externallyManagedPublication = options.externallyManagedPublication === true;
        if (externallyManagedPublication && options.maintainCompletionMarker === true) {
            throw new Error('externallyManagedPublication cannot be combined with maintainCompletionMarker=true.');
        }
        if (options.maintainCompletionMarker === false && !externallyManagedPublication) {
            throw new Error('Disabling completion-marker maintenance requires externallyManagedPublication=true.');
        }
        if (externallyManagedPublication && !options.targetCollectionName?.trim()) {
            throw new Error('externallyManagedPublication requires an explicit targetCollectionName.');
        }
        const maintainCompletionMarker = !externallyManagedPublication;
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
            if (!collectionName) {
                const proofCollection = await this.resolveCompletionProofCollection(codebasePath);
                if (
                    proofCollection
                    && this.indexCompletionFingerprintsMatch(
                        proofCollection.marker.fingerprint,
                        this.buildIndexCompletionFingerprint(),
                    )
                ) {
                    collectionName = proofCollection.collectionName;
                }
            }
            if (!collectionName && synchronizerAlreadyExisted) {
                const retryCollectionName = this.synchronizerMutationTargets.get(synchronizerKey);
                if (retryCollectionName && await this.vectorDatabase.hasCollection(retryCollectionName)) {
                    // A failed incremental mutation deliberately withdraws its marker while
                    // retaining the prepared filesystem delta for retry. Reuse that known
                    // mutation target only inside the same synchronizer lifetime; it remains
                    // unavailable to search until exact payload proof republishes the marker.
                    collectionName = retryCollectionName;
                }
            }
        }
        const collectionExists = collectionName !== null;

        if (!collectionExists) {
            if (maintainCompletionMarker && synchronizerAlreadyExisted) {
                throw new Error(`Cannot incremental sync '${codebasePath}': no existing collection could be resolved for completion marker maintenance.`);
            }
            console.warn(`[Context] ⚠️  No proven collection exists for '${codebasePath}'. Rebuilding full index before incremental sync resumes.`);
            const changedFiles = this.normalizeRelativePathsForCodebase(codebasePath, await this.getCodeFiles(codebasePath));
            if (changedFiles.length === 0) {
                progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
                return { added: 0, removed: 0, modified: 0, changedFiles: [] };
            }

            const indexResult = await this.indexCodebase(codebasePath, progressCallback, false, options);
            return {
                added: changedFiles.length,
                removed: 0,
                modified: 0,
                changedFiles,
                collectionName: this.getWriteCollectionName(codebasePath),
                indexedFiles: indexResult.indexedFiles,
                totalChunks: indexResult.totalChunks,
                indexStatus: indexResult.status,
            };
        }
        if (!collectionName) {
            throw new Error(`Expected an indexed collection for '${codebasePath}' after sync preflight.`);
        }
        const sealedPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        if (
            !sealedPolicy
            || this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
        ) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': no runtime-compatible sealed index policy is available; reindex is required.`);
        }

        if (!synchronizer) {
            await this.loadIgnorePatterns(codebasePath);
            const newSynchronizer = new FileSynchronizer(
                codebasePath,
                this.getActiveIgnorePatterns(codebasePath),
                this.getIndexedExtensionsForCodebase(codebasePath)
            );
            await newSynchronizer.initialize(options.assertMutationCurrent, options.publishMutation);
            this.synchronizers.set(synchronizerKey, newSynchronizer);
            this.synchronizerMutationTargets.delete(synchronizerKey);
        }

        const currentSynchronizer = this.synchronizers.get(synchronizerKey)!;
        const targetCollectionName = collectionName;
        this.synchronizerMutationTargets.set(synchronizerKey, targetCollectionName);
        const previousMarker = maintainCompletionMarker
            ? await this.resolveCompletionMarkerForCollection(codebasePath, targetCollectionName)
            : null;
        const markerWasMissing = maintainCompletionMarker && previousMarker === null;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const preparedChanges = await currentSynchronizer.prepareChanges();
        const { added, removed, modified } = preparedChanges.changes;
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            options.assertMutationCurrent?.();
            await preparedChanges.commit(options.assertMutationCurrent, options.publishMutation);
            if (maintainCompletionMarker && markerWasMissing) {
                await this.refreshCompletionMarkerFromCurrentSource(codebasePath, targetCollectionName, {
                    requirePayloadProof: true,
                    assertMutationCurrent: options.assertMutationCurrent,
                    publishMutation: options.publishMutation,
                });
            }
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            const currentMarker = await this.resolveCompletionMarkerForCollection(codebasePath, targetCollectionName);
            if (maintainCompletionMarker && currentMarker) {
                await this.publishSealedPolicyBindingForMarker(
                    codebasePath,
                    targetCollectionName,
                    currentMarker,
                    options.publishMutation,
                );
            }
            this.synchronizerMutationTargets.delete(synchronizerKey);
            return {
                added: 0,
                removed: 0,
                modified: 0,
                changedFiles: [],
                collectionName: targetCollectionName,
                ...(currentMarker ? {
                    indexedFiles: currentMarker.indexedFiles,
                    totalChunks: currentMarker.totalChunks,
                    indexStatus: currentMarker.indexStatus,
                } : {}),
            };
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
        let replacedPayloadCount: number | null = null;
        if (previousMarker?.indexStatus !== 'limit_reached') {
            replacedPayloadCount = 0;
            for (const relativePath of new Set([...added, ...removed, ...modified])) {
                const escapedPath = escapeMilvusStringLiteral(relativePath);
                const pathCount = await this.countIndexedPayloadExactly(
                    targetCollectionName,
                    `relativePath == "${escapedPath}"`,
                    previousMarker?.totalChunks,
                );
                if (pathCount === null) {
                    replacedPayloadCount = null;
                    break;
                }
                replacedPayloadCount += pathCount;
            }
        }
        let preparedMarkerStats: { indexedFiles: number; totalChunks: number } | null = null;

        try {
            if (maintainCompletionMarker) {
                await this.clearIndexCompletionMarkerFromCollection(targetCollectionName, options.assertMutationCurrent);
            }

            // An added source path should not normally have payload, but stale rows
            // can survive an older source generation. Reconcile them before insert
            // so the exact-count proof can converge instead of failing every retry.
            for (const file of added) {
                await this.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
            }

            // Handle removed files
            for (const file of removed) {
                await this.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
                updateProgress(`Removed ${file}`);
            }

            // Handle modified files
            for (const file of modified) {
                await this.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
            }

            // Handle added and modified files
            const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));

            let indexedDelta: {
                processedFiles: number;
                totalChunks: number;
                status: 'completed' | 'limit_reached';
                symbolRecords: SymbolRecord[];
                symbolManifestFiles: SymbolRegistryManifestFile[];
                analysisByFile: Map<string, RelationshipAnalysisEvidence>;
            } = {
                processedFiles: 0,
                totalChunks: 0,
                status: 'completed',
                symbolRecords: [],
                symbolManifestFiles: [],
                analysisByFile: new Map(),
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

            if (
                readinessArtifactsComplete === false
                && previousMarker
                && previousMarker.indexStatus !== 'limit_reached'
                && replacedPayloadCount !== null
                && indexedDelta.status === 'completed'
            ) {
                const expectedTotalChunks = previousMarker.totalChunks
                    - replacedPayloadCount
                    + indexedDelta.totalChunks;
                if (!Number.isSafeInteger(expectedTotalChunks) || expectedTotalChunks < 0) {
                    throw new Error(`Incremental payload accounting produced an invalid chunk count for '${codebasePath}'.`);
                }
                preparedMarkerStats = {
                    indexedFiles: preparedChanges.fileHashes.size,
                    totalChunks: expectedTotalChunks,
                };
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
                    indexedDelta.analysisByFile,
                    options.publishMutation,
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
                    await this.rebuildNavigationArtifacts(
                        codebasePath,
                        options.assertMutationCurrent,
                        options.publishMutation,
                    );
                    navigationRecovery = 'rebuilt';
                    readinessArtifactsComplete = true;
                    console.log('[Context] 🧭 Rebuilt navigation sidecars after incremental sync found no compatible pre-sync registry.');
                } catch (error) {
                    await this.clearSymbolRegistryForCodebase(
                        codebasePath,
                        options.assertMutationCurrent,
                        options.publishMutation,
                    );
                    await this.clearCompletionMarkerAfterSyncFailure(codebasePath, targetCollectionName, maintainCompletionMarker, options.assertMutationCurrent);
                    navigationRecovery = 'failed';
                    console.warn(
                        `[Context] ⚠️  Failed to recover navigation sidecars after incremental sync; reindex is required: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            } else {
                await this.clearSymbolRegistryForCodebase(
                    codebasePath,
                    options.assertMutationCurrent,
                    options.publishMutation,
                );
                await this.clearCompletionMarkerAfterSyncFailure(codebasePath, targetCollectionName, maintainCompletionMarker, options.assertMutationCurrent);
                navigationRecovery = 'failed';
                if (!canRebuildNavigationArtifacts) {
                    console.log('[Context] ⏭️ Skipping navigation rebuild because no compatible symbol registry existed before incremental sync.');
                } else {
                    console.warn('[Context] ⚠️  Clearing navigation sidecars because incremental sync stopped before all changed files finished indexing.');
                }
            }
        } catch (error) {
            await this.clearSymbolRegistryForCodebase(
                codebasePath,
                options.assertMutationCurrent,
                options.publishMutation,
            );
            await this.clearCompletionMarkerAfterSyncFailure(codebasePath, targetCollectionName, maintainCompletionMarker, options.assertMutationCurrent);
            throw error;
        }

        if (readinessArtifactsComplete) {
            if (preparedMarkerStats) {
                try {
                    await this.verifyPreparedSyncPublication(
                        codebasePath,
                        targetCollectionName,
                        preparedChanges.fileHashes,
                        preparedMarkerStats.totalChunks,
                    );
                } catch (error) {
                    await this.clearSymbolRegistryForCodebase(
                        codebasePath,
                        options.assertMutationCurrent,
                        options.publishMutation,
                    );
                    await this.clearCompletionMarkerAfterSyncFailure(
                        codebasePath,
                        targetCollectionName,
                        maintainCompletionMarker,
                        options.assertMutationCurrent,
                    );
                    throw error;
                }
            }
            options.assertMutationCurrent?.();
            await preparedChanges.commit(options.assertMutationCurrent, options.publishMutation);
            if (maintainCompletionMarker) {
                if (preparedMarkerStats) {
                    await this.writeCompletedIndexMarker(
                        codebasePath,
                        preparedMarkerStats.indexedFiles,
                        preparedMarkerStats.totalChunks,
                        targetCollectionName,
                        'completed',
                        options.assertMutationCurrent,
                    );
                } else {
                    await this.refreshCompletionMarkerFromCurrentSource(codebasePath, targetCollectionName, {
                        requirePayloadProof: true,
                        assertMutationCurrent: options.assertMutationCurrent,
                        publishMutation: options.publishMutation,
                    });
                }
                const publishedMarker = await this.resolveCompletionMarkerForCollection(
                    codebasePath,
                    targetCollectionName,
                );
                if (!publishedMarker) {
                    throw new Error(`Incremental publication did not produce a completion marker for '${targetCollectionName}'.`);
                }
                await this.publishSealedPolicyBindingForMarker(
                    codebasePath,
                    targetCollectionName,
                    publishedMarker,
                    options.publishMutation,
                );
            }
            this.synchronizerMutationTargets.delete(synchronizerKey);
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        const currentMarker = readinessArtifactsComplete && maintainCompletionMarker
            ? await this.resolveCompletionMarkerForCollection(codebasePath, targetCollectionName)
            : null;
        return {
            added: added.length,
            removed: removed.length,
            modified: modified.length,
            changedFiles: Array.from(new Set([...added, ...removed, ...modified])),
            collectionName: targetCollectionName,
            ...(navigationRecovery ? { navigationRecovery } : {}),
            ...(currentMarker ? {
                indexedFiles: currentMarker.indexedFiles,
                totalChunks: currentMarker.totalChunks,
                indexStatus: currentMarker.indexStatus,
            } : {}),
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
        const requestId = crypto.randomUUID();
        console.log(`[Context] 🔍 Executing ${searchType}: query_length=${resolvedRequest.query.length}, request_id=${requestId}, root=${codebasePath}`);
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

        const collectionName = await this.getActiveIndexedCollectionName(codebasePath);
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
            console.log(`[Context] 🔍 Generating query embedding: query_length=${resolvedRequest.query.length}, request_id=${requestId}`);
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(resolvedRequest.query);
            console.log(`[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);

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
            console.log(`[Context] 🔍 Search request 2 (sparse): anns_field="${searchRequests[1].anns_field}", query_length=${resolvedRequest.query.length}, request_id=${requestId}, limit=${searchRequests[1].limit}`);

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
                startByte: typeof result.document.metadata.startByte === 'number'
                    ? result.document.metadata.startByte
                    : undefined,
                endByte: typeof result.document.metadata.endByte === 'number'
                    ? result.document.metadata.endByte
                    : undefined,
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
                startByte: typeof result.document.metadata.startByte === 'number'
                    ? result.document.metadata.startByte
                    : undefined,
                endByte: typeof result.document.metadata.endByte === 'number'
                    ? result.document.metadata.endByte
                    : undefined,
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
            .map((row) => row.id)
            .filter((id): id is string => id === INDEX_COMPLETION_MARKER_DOC_ID);
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
        return (await this.resolveCompletionProofCollection(codebasePath))?.marker ?? null;
    }

    /**
     * Read completion-marker evidence for lifecycle validation. Current v2
     * markers retain the exact payload proof required by normal resolution.
     * A raw v1 marker is exposed only when no proven v2 marker exists so MCP
     * can classify the legacy policy-unsealed schema as requiring reindex.
     */
    async getIndexCompletionMarkerForValidation(codebasePath: string): Promise<CompletionMarkerValidationEvidence> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        try {
            this.refreshRuntimePolicyAuthority(canonicalRoot);
        } catch {
            // Marker evidence remains readable even when policy proof is malformed.
        }
        const relatedCollections = await this.listRelatedCollectionNames(codebasePath);
        const { activeFamilyName, alternateFamilyName } = this.buildCollectionFamilies(codebasePath);
        const boundCollection = this.publishedPolicyBindingsByCodebase.get(canonicalRoot)?.collectionName;
        const publishedPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        if (
            boundCollection
            && publishedPolicy
            && this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
        ) {
            return { status: 'runtime_policy_incompatible' };
        }
        const active = await this.resolveActiveIndexedCollection(codebasePath).catch(() => null);
        if (active) {
            return { status: 'valid_v2', marker: active.marker };
        }
        const readCollectionEvidence = async (
            collectionName: string,
        ): Promise<CompletionMarkerValidationEvidence> => {
            let hasV2 = false;
            let legacyV1: CompletionMarkerValidationEvidence | null = null;
            for (const row of await this.queryCompletionMarkerRows(collectionName)) {
                const rawMetadata = row?.metadata;
                const parsed = (() => {
                    if (typeof rawMetadata === 'string') {
                        try {
                            return JSON.parse(rawMetadata) as unknown;
                        } catch {
                            return null;
                        }
                    }
                    return rawMetadata;
                })();
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    continue;
                }
                const kind = (parsed as { kind?: unknown }).kind;
                if (kind === 'satori_index_completion_v2') {
                    hasV2 = true;
                } else if (kind === 'satori_index_completion_v1' && !legacyV1) {
                    legacyV1 = { status: 'legacy_v1', marker: parsed };
                }
            }
            if (hasV2) return { status: 'invalid_v2' };
            return legacyV1 ?? { status: 'missing' };
        };
        if (boundCollection) {
            if (!relatedCollections.includes(boundCollection)) {
                return { status: 'invalid_v2' };
            }
            const evidence = await readCollectionEvidence(boundCollection);
            return evidence.status === 'valid_v2'
                ? evidence
                : { status: 'invalid_v2' };
        }
        const collectionPriority = [
            activeFamilyName,
            alternateFamilyName,
        ].filter((name, index, names) => relatedCollections.includes(name) && names.indexOf(name) === index);
        for (const collectionName of collectionPriority) {
            const evidence = await readCollectionEvidence(collectionName);
            if (evidence.status !== 'missing') return evidence;
        }
        return { status: 'missing' };
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
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });
        await this.withIndexPolicyMutationLockAsync(canonicalRoot, async () => {
            const policyPath = this.resolveCustomIndexPolicyPath(canonicalRoot);
            this.recoverIndexPolicyTombstonesWhileLocked(policyPath);

            for (const collectionName of await this.listRelatedCollectionNames(codebasePath)) {
                await deleteCollectionWithVerification(this.vectorDatabase, collectionName, {
                    beforeDropAttempt: options.assertMutationCurrent,
                });
            }

            // Preserve the accepted policy while remote deletion is unproven. Once
            // every related collection is confirmed absent, remove durable authority
            // before reconciling the process-local policy state.
            options.assertMutationCurrent?.();
            fs.rmSync(policyPath, { force: true });
            this.clearResolvedIndexPolicyRuntime(canonicalRoot);
            this.policyFileTokensByCodebase.set(canonicalRoot, null);

            await this.clearSymbolRegistryForCodebase(
                codebasePath,
                options.assertMutationCurrent,
                options.publishMutation,
            );

            options.assertMutationCurrent?.();
            await FileSynchronizer.deleteSnapshot(codebasePath);
            const familyCollectionName = this.resolveCollectionName(codebasePath);
            this.synchronizers.delete(familyCollectionName);
            this.synchronizerMutationTargets.delete(familyCollectionName);
            this.ignoreStateByCollection.delete(familyCollectionName);
            this.writeCollectionOverrides.delete(canonicalRoot);
            this.indexProfilesByCodebase.delete(canonicalRoot);
        });

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        console.log('[Context] ✅ Index data cleaned');
    }

    /**
     * Update base ignore patterns (replace semantics, then rebuild effective set).
     * @param ignorePatterns Array of base ignore patterns
     */
    updateIgnorePatterns(ignorePatterns: string[]): void {
        this.baseIgnorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns];
        this.rebuildAllIgnoreStates();
        this.recomputeAllPublishedPolicyRuntimeCompatibility();
        console.log(`[Context] 🚫 Updated base ignore patterns. Base total: ${this.baseIgnorePatterns.length}`);
    }

    async resolveIndexPolicyForCodebase(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ResolvedIndexPolicy> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.loadCustomIndexPolicy(canonicalRoot);
        const profile = this.loadIndexProfileForCodebase(canonicalRoot).profile;
        const customExtensions = update.customExtensions === undefined
            ? [...(this.runtimeCustomExtensionsByCodebase.get(canonicalRoot) ?? [])]
            : normalizeSupportedExtensions(update.customExtensions);
        const customIgnorePatterns = update.customIgnorePatterns === undefined
            ? [...(this.runtimeCustomIgnorePatternsByCodebase.get(canonicalRoot) ?? [])]
            : update.customIgnorePatterns.map((pattern) => pattern.trim()).filter(Boolean);
        const fileBasedPatterns: string[] = [];
        for (const ignoreFile of await this.findIgnoreFiles(canonicalRoot)) {
            fileBasedPatterns.push(...await this.loadIgnoreFile(ignoreFile, path.basename(ignoreFile), canonicalRoot));
        }
        const supportedExtensions = normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(profile),
            ...this.configuredExtensionOverlays,
            ...customExtensions,
        ]);
        const effectiveIgnorePatterns = [
            ...this.baseIgnorePatterns,
            ...customIgnorePatterns,
            ...fileBasedPatterns,
        ];
        const policyHash = crypto.createHash('sha256').update(JSON.stringify({
            profile,
            extensions: supportedExtensions,
            ignorePatterns: effectiveIgnorePatterns,
        }), 'utf8').digest('hex');
        return {
            canonicalRoot,
            profile,
            customExtensions,
            customIgnorePatterns,
            fileBasedIgnorePatterns: fileBasedPatterns,
            supportedExtensions,
            effectiveIgnorePatterns,
            policyHash,
        };
    }

    publishResolvedIndexPolicy(
        policy: ResolvedIndexPolicy,
        binding: { collectionName: string; navigationGenerationId?: string },
        publishMutation?: (publish: () => void) => void,
    ): IndexPolicyPublicationReceipt {
        const canonicalRoot = this.canonicalizeCodebasePath(policy.canonicalRoot);
        if (canonicalRoot !== policy.canonicalRoot) {
            throw new Error('Resolved index policy root is not canonical.');
        }
        return this.persistCustomIndexPolicy(
            policy,
            binding,
            publishMutation,
            () => this.activateResolvedIndexPolicy(policy, binding),
        );
    }

    clearPublishedIndexPolicy(
        codebasePath: string,
        publishMutation: (publish: () => void) => void,
        expectedDocumentDigest: string,
    ): IndexPolicyPublicationReceipt {
        if (!/^[a-f0-9]{64}$/.test(expectedDocumentDigest)) {
            throw new Error('Expected index policy document digest must be a SHA-256 hex digest.');
        }
        return this.removePublishedIndexPolicy(codebasePath, publishMutation, expectedDocumentDigest);
    }

    forceClearPublishedIndexPolicy(
        codebasePath: string,
        publishMutation: (publish: () => void) => void,
    ): IndexPolicyPublicationReceipt {
        return this.removePublishedIndexPolicy(codebasePath, publishMutation);
    }

    private removePublishedIndexPolicy(
        codebasePath: string,
        publishMutation: (publish: () => void) => void,
        expectedDocumentDigest?: string,
    ): IndexPolicyPublicationReceipt {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const targetPath = this.resolveCustomIndexPolicyPath(canonicalRoot);
        const receipt: IndexPolicyPublicationReceipt = {
            status: 'committed',
            operation: 'clear',
            canonicalRoot,
            previousDocumentDigest: null,
        };
        let publicationCount = 0;
        let committed = false;
        const publish = () => {
            publicationCount += 1;
            if (publicationCount > 1) {
                throw new Error('Index policy removal invoked more than once.');
            }
            this.withIndexPolicyMutationLock(canonicalRoot, () => {
                let tombstonePath = `${targetPath}.removed-${process.pid}-${crypto.randomUUID()}`;
                let movedPolicy = false;
                let cleanupCommittedTombstone = false;
                try {
                    this.recoverIndexPolicyTombstonesWhileLocked(targetPath);
                    try {
                        fs.renameSync(targetPath, tombstonePath);
                        movedPolicy = true;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                    if (!movedPolicy && expectedDocumentDigest !== undefined) {
                        throw new Error(
                            `Index policy changed before removal; expected document '${expectedDocumentDigest}' but no document was present.`,
                        );
                    }

                    let removedDocumentDigest: string | null = null;
                    let digestError: unknown;
                    if (movedPolicy) {
                        try {
                            removedDocumentDigest = this.resolveVerifiedIndexPolicyDocumentDigest(tombstonePath);
                        } catch (error) {
                            digestError = error;
                        }
                    }
                    if (
                        expectedDocumentDigest !== undefined
                        && (digestError || removedDocumentDigest !== expectedDocumentDigest)
                    ) {
                        const observed = digestError
                            ? (digestError instanceof Error ? digestError.message : String(digestError))
                            : `'${removedDocumentDigest}'`;
                        if (!fs.existsSync(targetPath)) {
                            try {
                                fs.renameSync(tombstonePath, targetPath);
                                movedPolicy = false;
                            } catch (restoreError) {
                                throw new Error(
                                    `Index policy changed before removal and restoration failed; preserved tombstone '${tombstonePath}': ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
                                );
                            }
                        } else {
                            throw new Error(
                                `Index policy changed before removal; preserved conflicting tombstone '${tombstonePath}' because '${targetPath}' is occupied.`,
                            );
                        }
                        throw new Error(
                            `Index policy changed before removal; expected document '${expectedDocumentDigest}' but tombstoned ${observed}.`,
                        );
                    }

                    if (movedPolicy) {
                        const committedTombstonePath = `${targetPath}.removed-committed-${process.pid}-${crypto.randomUUID()}`;
                        fs.renameSync(tombstonePath, committedTombstonePath);
                        tombstonePath = committedTombstonePath;
                        cleanupCommittedTombstone = true;
                    }
                    committed = true;
                    receipt.previousDocumentDigest = removedDocumentDigest;
                    let reconciliationError: unknown;
                    try {
                        this.clearResolvedIndexPolicyRuntime(canonicalRoot);
                    } catch (error) {
                        reconciliationError = error;
                    }
                    this.policyFileTokensByCodebase.set(canonicalRoot, null);
                    if (digestError) throw digestError;
                    if (reconciliationError) throw reconciliationError;
                } finally {
                    if (cleanupCommittedTombstone) fs.rmSync(tombstonePath, { force: true });
                }
            });
        };
        try {
            publishMutation(publish);
            if (publicationCount !== 1) {
                throw new Error('Index policy removal returned without publishing.');
            }
        } catch (error) {
            if (committed) {
                throw new IndexPolicyPublicationError(
                    `Index policy removal committed before its publication receipt failed: ${error instanceof Error ? error.message : String(error)}`,
                    receipt,
                    error,
                );
            }
            throw error;
        }
        return receipt;
    }

    private activateResolvedIndexPolicy(
        policy: ResolvedIndexPolicy,
        binding: { collectionName: string; navigationGenerationId?: string },
    ): void {
        const canonicalRoot = policy.canonicalRoot;
        this.runtimeCustomExtensionsByCodebase.set(canonicalRoot, [...policy.customExtensions]);
        this.runtimeCustomIgnorePatternsByCodebase.set(canonicalRoot, [...policy.customIgnorePatterns]);
        if (!this.indexProfilesByCodebase.has(canonicalRoot)) {
            this.indexProfilesByCodebase.set(canonicalRoot, policy.profile);
        }
        this.loadedCustomPolicyRoots.add(canonicalRoot);
        this.publishedPolicyBindingsByCodebase.set(canonicalRoot, {
            policyHash: policy.policyHash,
            collectionName: binding.collectionName,
            ...(binding.navigationGenerationId ? { navigationGenerationId: binding.navigationGenerationId } : {}),
        });
        this.publishedResolvedPoliciesByCodebase.set(canonicalRoot, {
            ...policy,
            customExtensions: [...policy.customExtensions],
            customIgnorePatterns: [...policy.customIgnorePatterns],
            fileBasedIgnorePatterns: [...policy.fileBasedIgnorePatterns],
            supportedExtensions: [...policy.supportedExtensions],
            effectiveIgnorePatterns: [...policy.effectiveIgnorePatterns],
        });
        this.policyRuntimeCompatibilityByCodebase.set(
            canonicalRoot,
            this.isPolicyRuntimeCompatible(policy),
        );
        this.setFileBasedPatternsForCodebase(canonicalRoot, policy.fileBasedIgnorePatterns);
    }

    private isPolicyRuntimeCompatible(policy: ResolvedIndexPolicy): boolean {
        const runtimeProfile = this.indexProfilesByCodebase.get(policy.canonicalRoot) ?? policy.profile;
        const expectedExtensions = normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(runtimeProfile),
            ...this.configuredExtensionOverlays,
            ...policy.customExtensions,
        ]);
        const expectedIgnorePatterns = [
            ...this.baseIgnorePatterns,
            ...policy.customIgnorePatterns,
            ...policy.fileBasedIgnorePatterns,
        ];
        return policy.profile === runtimeProfile
            && JSON.stringify(policy.supportedExtensions) === JSON.stringify(expectedExtensions)
            && JSON.stringify(policy.effectiveIgnorePatterns) === JSON.stringify(expectedIgnorePatterns);
    }

    private recomputePublishedPolicyRuntimeCompatibility(canonicalRoot: string): void {
        const policy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        if (!policy) {
            this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
            return;
        }
        this.policyRuntimeCompatibilityByCodebase.set(
            canonicalRoot,
            this.isPolicyRuntimeCompatible(policy),
        );
    }

    private refreshRuntimePolicyAuthority(canonicalRoot: string): void {
        this.loadIndexProfileForCodebase(canonicalRoot);
        this.loadCustomIndexPolicy(canonicalRoot);
        this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
    }

    private recomputeAllPublishedPolicyRuntimeCompatibility(): void {
        for (const canonicalRoot of this.publishedResolvedPoliciesByCodebase.keys()) {
            this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
        }
    }

    /**
     * Reset ignore patterns to defaults only
     */
    resetIgnorePatternsToDefaults(): void {
        this.baseIgnorePatterns = [...DEFAULT_IGNORE_PATTERNS];
        this.rebuildAllIgnoreStates();
        this.recomputeAllPublishedPolicyRuntimeCompatibility();
        console.log(`[Context] 🔄 Reset ignore patterns to defaults: ${this.baseIgnorePatterns.length} patterns`);
    }

    private buildEffectiveIgnorePatterns(codebasePath: string, fileBasedPatterns: string[]): string[] {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return [
            ...this.baseIgnorePatterns,
            ...(this.runtimeCustomIgnorePatternsByCodebase.get(canonicalRoot) ?? []),
            ...fileBasedPatterns,
        ];
    }

    private rebuildAllIgnoreStates(): void {
        for (const [collectionName, state] of this.ignoreStateByCollection.entries()) {
            this.ignoreStateByCollection.set(collectionName, {
                ...state,
                effectivePatterns: this.buildEffectiveIgnorePatterns(state.canonicalRoot, state.fileBasedPatterns),
                matcher: null,
            });
        }
    }

    private rebuildIgnoreStateForCodebase(codebasePath: string): void {
        const collectionName = this.resolveCollectionName(codebasePath);
        const state = this.ignoreStateByCollection.get(collectionName);
        if (!state) return;
        this.ignoreStateByCollection.set(collectionName, {
            ...state,
            effectivePatterns: this.buildEffectiveIgnorePatterns(codebasePath, state.fileBasedPatterns),
            matcher: null,
        });
    }

    private getOrCreateIgnoreState(codebasePath: string): CodebaseIgnoreState {
        const collectionName = this.resolveCollectionName(codebasePath);
        this.loadCustomIndexPolicy(this.canonicalizeCodebasePath(codebasePath));
        const existing = this.ignoreStateByCollection.get(collectionName);
        if (existing) {
            return existing;
        }

        const initial: CodebaseIgnoreState = {
            canonicalRoot: this.canonicalizeCodebasePath(codebasePath),
            fileBasedPatterns: [],
            effectivePatterns: this.buildEffectiveIgnorePatterns(codebasePath, []),
            matcher: null,
        };
        this.ignoreStateByCollection.set(collectionName, initial);
        return initial;
    }

    private setFileBasedPatternsForCodebase(codebasePath: string, fileBasedPatterns: string[]): void {
        const collectionName = this.resolveCollectionName(codebasePath);
        const normalizedFileBased = fileBasedPatterns
            .filter((pattern): pattern is string => typeof pattern === 'string')
            .filter((pattern) => pattern.length > 0);

        const nextState: CodebaseIgnoreState = {
            canonicalRoot: this.canonicalizeCodebasePath(codebasePath),
            fileBasedPatterns: normalizedFileBased,
            effectivePatterns: this.buildEffectiveIgnorePatterns(codebasePath, normalizedFileBased),
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

    private assertResolvedIndexPolicyRoot(codebasePath: string, policy: ResolvedIndexPolicy): void {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        if (policy.canonicalRoot !== canonicalRoot) {
            throw new Error(
                `Resolved index policy belongs to '${policy.canonicalRoot}', not '${canonicalRoot}'.`,
            );
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
    private async getCodeFiles(codebasePath: string, indexPolicy?: ResolvedIndexPolicy): Promise<string[]> {
        const files: string[] = [];
        const supportedExtensions = indexPolicy?.supportedExtensions ?? this.getIndexedExtensionsForCodebase(codebasePath);
        const policyMatcher = indexPolicy ? ignore().add(indexPolicy.effectiveIgnorePatterns) : null;

        const traverseDirectory = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
            entries.sort((left, right) => compareContractStrings(left.name, right.name));

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                // Check if path matches ignore patterns
                if (this.matchesIgnorePattern(fullPath, codebasePath, entry.isDirectory(), policyMatcher ?? undefined)) {
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
        return files.sort((left, right) => compareContractStrings(
            path.relative(codebasePath, left).replace(/\\/g, '/'),
            path.relative(codebasePath, right).replace(/\\/g, '/'),
        ));
    }

    private async readIndexableFileInsideRoot(
        filePath: string,
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<string | null> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const handle = await openRegularFileInsideRoot(filePath, canonicalRoot);
        try {
            const before = await handle.stat();
            const relativePath = this.normalizeRelativePathForCodebase(canonicalRoot, filePath);
            if (!relativePath || !before.isFile()) {
                throw new Error(`Indexed source is not a regular file inside the codebase root: ${filePath}`);
            }
            const indexable = await isIndexableFileObservationByPolicy(
                relativePath,
                before.size,
                indexPolicy?.supportedExtensions ?? this.getIndexedExtensionsForCodebase(canonicalRoot),
                async () => {
                    const buffer = Buffer.alloc(Math.min(before.size, 8192));
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                    return buffer.subarray(0, bytesRead);
                },
            );
            if (!indexable) return null;

            const content = (await readFileHandleExactly(handle, before.size)).toString('utf8');
            const after = await handle.stat();
            if (
                after.dev !== before.dev
                || after.ino !== before.ino
                || after.size !== before.size
                || after.mtimeMs !== before.mtimeMs
                || after.ctimeMs !== before.ctimeMs
            ) {
                throw new Error(`Indexed source changed while being read: ${filePath}`);
            }
            const currentPathHandle = await openRegularFileInsideRoot(filePath, canonicalRoot);
            try {
                const currentPathStat = await currentPathHandle.stat();
                if (currentPathStat.dev !== after.dev || currentPathStat.ino !== after.ino) {
                    throw new Error(`Indexed source path was replaced while being read: ${filePath}`);
                }
            } finally {
                await currentPathHandle.close().catch(() => undefined);
            }
            return content;
        } finally {
            await handle.close().catch(() => undefined);
        }
    }

    private buildSupportedExtensions(profile: IndexProfile, canonicalRoot?: string): string[] {
        return normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(profile),
            ...this.configuredExtensionOverlays,
            ...(canonicalRoot ? this.runtimeCustomExtensionsByCodebase.get(canonicalRoot) ?? [] : []),
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
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<{
        processedFiles: number;
        totalChunks: number;
        status: 'completed' | 'limit_reached';
        symbolRecords: SymbolRecord[];
        symbolManifestFiles: SymbolRegistryManifestFile[];
        analysisByFile: Map<string, RelationshipAnalysisEvidence>;
    }> {
        const isHybrid = this.getIsHybrid();
        const EMBEDDING_BATCH_SIZE = resolveEmbeddingBatchSize(envManager.get('EMBEDDING_BATCH_SIZE'));
        const CHUNK_LIMIT = 450000;
        console.log(`[Context] 🔧 Using EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);

        let chunkBuffer: Array<{
            chunk: CodeChunk;
            codebasePath: string;
            relativePath: string;
            fileChunkIndex: number;
        }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];
        const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();
        const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];

            try {
                const content = await this.readIndexableFileInsideRoot(filePath, codebasePath, indexPolicy);
                if (content === null) continue;
                const language = this.getLanguageFromFilePath(filePath);
                const relativePath = this.normalizeRelativePathForCodebase(codebasePath, filePath);
                if (!relativePath) {
                    throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
                }
                const analysis = await this.languageAnalyzer.analyze({ content, language, relativePath });
                const chunks = chunksWithTrustedRelativePath(analysis.chunks, relativePath);
                analysisByFile.set(relativePath, {
                    moduleBindings: analysis.moduleBindings,
                    callSites: analysis.callSites,
                });
                const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
                const fileSymbols = buildSymbolRecordsForFile({
                    relativePath,
                    language,
                    content,
                    fileHash,
                    extractorVersion: this.getSymbolExtractorVersion(),
                    extractedSymbols: analysis.symbols,
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

                let fileFullyIncluded = true;
                // Add chunks to buffer
                for (let fileChunkIndex = 0; fileChunkIndex < chunks.length; fileChunkIndex++) {
                    const chunk = chunks[fileChunkIndex];
                    chunkBuffer.push({ chunk, codebasePath, relativePath, fileChunkIndex });
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
                        fileFullyIncluded = fileChunkIndex === chunks.length - 1;
                        break; // Exit the inner loop (over chunks)
                    }
                }

                if (fileFullyIncluded) {
                    processedFiles++;
                    onFileProcessed?.(filePath, processedFiles, filePaths.length);
                }

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
            symbolManifestFiles,
            analysisByFile,
        };
    }

    /**
     * Rebuild expected chunks and symbol registry records from source files without embedding.
     */
    public async getExpectedChunksAndSymbols(
        filePaths: string[],
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<{
        expectedChunks: ExpectedIndexedChunk[];
        symbolRecords: SymbolRecord[];
        symbolManifestFiles: SymbolRegistryManifestFile[];
        analysisByFile: Map<string, RelationshipAnalysisEvidence>;
    }> {
        if (indexPolicy) {
            this.assertResolvedIndexPolicyRoot(codebasePath, indexPolicy);
        }
        const expectedChunks: ExpectedIndexedChunk[] = [];
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];
        const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();

        for (const filePath of filePaths) {
            const content = await this.readIndexableFileInsideRoot(filePath, codebasePath, indexPolicy);
            if (content === null) {
                throw new Error(`Indexed source no longer satisfies the active policy: ${filePath}`);
            }
            const language = this.getLanguageFromFilePath(filePath);
            const relativePath = this.normalizeRelativePathForCodebase(codebasePath, filePath);
            if (!relativePath) {
                throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
            }
            const analysis = await this.languageAnalyzer.analyze({ content, language, relativePath });
            const chunks = chunksWithTrustedRelativePath(analysis.chunks, relativePath);
            analysisByFile.set(relativePath, {
                moduleBindings: analysis.moduleBindings,
                callSites: analysis.callSites,
            });
            const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
            const fileSymbols = buildSymbolRecordsForFile({
                relativePath,
                language,
                content,
                fileHash,
                extractorVersion: this.getSymbolExtractorVersion(),
                extractedSymbols: analysis.symbols,
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
                const id = this.generateId(relativePath, chunk, index);

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
            analysisByFile,
        };
    }

    private async refreshCompletionMarkerFromCurrentSource(
        codebasePath: string,
        collectionName: string,
        options: {
            requirePayloadProof?: boolean;
            assertMutationCurrent?: () => void;
            publishMutation?: (publish: () => void) => void;
        } = {}
    ): Promise<void> {
        await this.loadIgnorePatterns(codebasePath);
        const codeFiles = await this.getCodeFiles(codebasePath);
        const { expectedChunks } = await this.getExpectedChunksAndSymbols(codeFiles, codebasePath);
        if (options.requirePayloadProof === true) {
            await this.ensureNavigationArtifactsReadyForMarkerRefresh(
                codebasePath,
                options.assertMutationCurrent,
                options.publishMutation,
            );
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

    private async verifyPreparedSyncPublication(
        codebasePath: string,
        collectionName: string,
        preparedFileHashes: ReadonlyMap<string, string>,
        expectedTotalChunks: number,
    ): Promise<void> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const registryState = await readSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: canonicalRoot,
        });
        if (registryState.status !== 'ok') {
            throw new Error(`Cannot publish incremental completion proof: navigation registry is ${registryState.status}.`);
        }
        const relationshipState = await readRelationshipSidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: canonicalRoot,
            expectedSymbolRegistryManifestHash: registryState.manifestHash,
        });
        if (relationshipState.status !== 'ok') {
            throw new Error(`Cannot publish incremental completion proof: relationship evidence is ${relationshipState.status}.`);
        }

        const manifestHashes = new Map(
            registryState.registry.manifest.files.map((file) => [file.path, file.hash]),
        );
        if (manifestHashes.size !== preparedFileHashes.size) {
            throw new Error(
                `Cannot publish incremental completion proof: synchronizer tracks ${preparedFileHashes.size} files but navigation seals ${manifestHashes.size}.`,
            );
        }
        for (const [relativePath, expectedHash] of preparedFileHashes) {
            if (manifestHashes.get(relativePath) !== expectedHash) {
                throw new Error(
                    `Cannot publish incremental completion proof: source hash for '${relativePath}' does not match the prepared synchronizer checkpoint.`,
                );
            }
        }

        const observedTotalChunks = await this.countIndexedPayloadExactly(
            collectionName,
            'fileExtension != ".satori_meta"',
            expectedTotalChunks,
        );
        if (observedTotalChunks === null) {
            throw new Error(
                `Cannot publish incremental completion proof: backend cannot prove the exact payload count for '${collectionName}'.`,
            );
        }
        if (observedTotalChunks !== expectedTotalChunks) {
            throw new Error(
                `Cannot publish incremental completion proof: expected ${expectedTotalChunks} chunks but observed ${observedTotalChunks}.`,
            );
        }
    }

    private async ensureNavigationArtifactsReadyForMarkerRefresh(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
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
        await this.rebuildNavigationArtifacts(codebasePath, assertMutationCurrent, publishMutation);
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
        assertDescriptorBoundIndexingSupported();
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

        // 3. Use the exact durable policy sealed to the generation family. Repair
        // must not reconstruct policy authority from mutable repository controls.
        this.refreshRuntimePolicyAuthority(canonicalPath);
        const repairPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalPath);
        if (!repairPolicy || this.policyRuntimeCompatibilityByCodebase.get(canonicalPath) !== true) {
            proof.marker = { status: 'failed', basis: 'sealed_policy_unavailable' };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: `Repair cannot publish collection '${selectedCollection}' because its sealed index policy is missing or runtime-incompatible.`,
            });
        }
        const codeFiles = await this.getCodeFiles(canonicalPath, repairPolicy);
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
            await this.clearSymbolRegistryForCodebase(
                canonicalPath,
                options.assertMutationCurrent,
                options.publishMutation,
            );
            await this.writeCompletedIndexMarker(
                canonicalPath,
                0,
                0,
                selectedCollection,
                'completed',
                options.assertMutationCurrent,
                undefined,
                repairPolicy.policyHash,
            );
            const repairedMarker = await this.resolveCompletionMarkerForCollection(canonicalPath, selectedCollection);
            if (!repairedMarker) {
                throw new Error(`Repair did not produce a completion marker for '${selectedCollection}'.`);
            }
            await this.publishSealedPolicyBindingForMarker(
                canonicalPath,
                selectedCollection,
                repairedMarker,
                options.publishMutation,
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
        const {
            expectedChunks,
            symbolRecords,
            symbolManifestFiles,
            analysisByFile,
        } = await this.getExpectedChunksAndSymbols(codeFiles, canonicalPath, repairPolicy);

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
        const navigationCandidate = await this.writeSymbolRegistryForCompletedIndex(
            canonicalPath,
            symbolRecords,
            symbolManifestFiles,
            options.assertMutationCurrent,
            analysisByFile,
            options.publishMutation,
            false,
            repairPolicy,
        );

        // 7. Write new completion marker
        await this.writeCompletedIndexMarker(
            canonicalPath,
            codeFiles.length,
            expectedChunks.length,
            selectedCollection,
            'completed',
            options.assertMutationCurrent,
            navigationCandidate,
            repairPolicy.policyHash,
        );
        const repairedMarker = await this.resolveCompletionMarkerForCollection(canonicalPath, selectedCollection);
        if (!repairedMarker) {
            throw new Error(`Repair did not produce a completion marker for '${selectedCollection}'.`);
        }
        await this.publishSealedPolicyBindingForMarker(
            canonicalPath,
            selectedCollection,
            repairedMarker,
            options.publishMutation,
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
        return SYMBOL_EXTRACTOR_VERSION;
    }

    private getLanguageRouterVersion(): string {
        return 'language-router-v1';
    }

    private getRelationshipVersion(): string {
        return RELATIONSHIP_BUILDER_VERSION;
    }

    private buildIndexPolicyHash(codebasePath: string): string {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.loadCustomIndexPolicy(canonicalRoot);
        const publishedPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        if (publishedPolicy) {
            return publishedPolicy.policyHash;
        }
        const profile = this.indexProfilesByCodebase.get(canonicalRoot) || 'default';
        const payload = JSON.stringify({
            profile,
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
        analysisByFile: Map<string, RelationshipAnalysisEvidence>;
    }> {
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];
        const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();

        for (const filePath of [...filePaths].sort((a, b) => a.localeCompare(b))) {
            const content = await this.readIndexableFileInsideRoot(filePath, codebasePath);
            if (content === null) {
                throw new Error(`Indexed source no longer satisfies the active policy: ${filePath}`);
            }
            const language = this.getLanguageFromFilePath(filePath);
            const relativePath = this.normalizeRelativePathForCodebase(codebasePath, filePath);
            if (!relativePath) {
                throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
            }

            const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
            const analysis = await this.languageAnalyzer.analyze({ content, language, relativePath });
            const chunks = chunksWithTrustedRelativePath(analysis.chunks, relativePath);
            analysisByFile.set(relativePath, {
                moduleBindings: analysis.moduleBindings,
                callSites: analysis.callSites,
            });
            const fileSymbols = buildSymbolRecordsForFile({
                relativePath,
                language,
                content,
                fileHash,
                extractorVersion: this.getSymbolExtractorVersion(),
                extractedSymbols: analysis.symbols,
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
            analysisByFile,
        };
    }

    private async rebuildNavigationArtifacts(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const codeFiles = await this.getCodeFiles(codebasePath);
        if (codeFiles.length === 0) {
            await this.clearSymbolRegistryForCodebase(
                codebasePath,
                assertMutationCurrent,
                publishMutation,
            );
            return;
        }

        const navigationArtifacts = await this.buildNavigationArtifactsForFiles(codeFiles, codebasePath);
        await this.writeSymbolRegistryForCompletedIndex(
            codebasePath,
            navigationArtifacts.symbolRecords,
            navigationArtifacts.symbolManifestFiles,
            assertMutationCurrent,
            navigationArtifacts.analysisByFile,
            publishMutation,
        );
    }

    private async rebuildNavigationArtifactsForSyncDelta(
        codebasePath: string,
        existingRegistry: SymbolRegistry,
        changedRelativePaths: string[],
        rebuiltSymbolRecords: SymbolRecord[],
        rebuiltManifestFiles: SymbolRegistryManifestFile[],
        assertMutationCurrent?: () => void,
        analysisByFile?: Map<string, RelationshipAnalysisEvidence>,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const replacedPaths = new Set<string>([
            ...changedRelativePaths.map((filePath) => filePath.replace(/\\/g, '/').replace(/^\/+/, '')),
            ...rebuiltManifestFiles.map((file) => file.path),
        ]);
        const retainedAnalysisByFile = new Map<string, RelationshipAnalysisEvidence>();
        const existingRelationships = await readRelationshipSidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
            expectedSymbolRegistryManifestHash: computeSymbolRegistryManifestHash(existingRegistry.manifest),
        });
        if (existingRelationships.status === 'ok') {
            for (const file of existingRegistry.manifest.files) {
                if (replacedPaths.has(file.path)) continue;
                const evidence = existingRelationships.analysisByFile.get(file.path);
                if (evidence) retainedAnalysisByFile.set(file.path, evidence);
            }
        }
        for (const [filePath, evidence] of analysisByFile ?? []) {
            retainedAnalysisByFile.set(filePath, evidence);
        }

        const mergedManifestFiles = [
            ...existingRegistry.manifest.files.filter((file) => !replacedPaths.has(file.path)),
            ...rebuiltManifestFiles,
        ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

        if (mergedManifestFiles.length === 0) {
            await this.clearSymbolRegistryForCodebase(
                codebasePath,
                assertMutationCurrent,
                publishMutation,
            );
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
            retainedAnalysisByFile,
            publishMutation,
        );
    }

    private async writeSymbolRegistryForCompletedIndex(
        codebasePath: string,
        symbolRecords: SymbolRecord[],
        symbolManifestFiles: SymbolRegistryManifestFile[],
        assertMutationCurrent?: () => void,
        suppliedAnalysisByFile?: Map<string, RelationshipAnalysisEvidence>,
        publishMutation?: (publish: () => void) => void,
        deferPublication: boolean = false,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<StagedNavigationSidecarGeneration | undefined> {
        if (indexPolicy) {
            this.assertResolvedIndexPolicyRoot(codebasePath, indexPolicy);
        }
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const manifestFiles = [...symbolManifestFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const registry = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: canonicalRoot,
                rootFingerprint: this.buildRootFingerprint(canonicalRoot),
                indexPolicyHash: indexPolicy?.policyHash ?? this.buildIndexPolicyHash(codebasePath),
                languageRouterVersion: this.getLanguageRouterVersion(),
                extractorVersion: this.getSymbolExtractorVersion(),
                relationshipVersion: this.getRelationshipVersion(),
                builtAt: new Date().toISOString(),
                files: manifestFiles,
            },
            symbols: symbolRecords,
        });

        const analysisByFile = new Map(suppliedAnalysisByFile ?? []);
        for (const file of manifestFiles) {
            const absoluteFile = path.resolve(canonicalRoot, file.path);
            const relativeFromRoot = path.relative(canonicalRoot, absoluteFile);
            if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
                throw new Error(`Navigation manifest path '${file.path}' escapes the codebase root.`);
            }
            const content = await this.readIndexableFileInsideRoot(absoluteFile, canonicalRoot, indexPolicy);
            if (content === null) {
                throw new Error(`Navigation source no longer satisfies the active policy for '${file.path}'.`);
            }
            const observedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
            if (observedHash !== file.hash) {
                throw new Error(`Source changed before navigation publication for '${file.path}'.`);
            }
            if (analysisByFile.has(file.path)) {
                continue;
            }
            const analysis = await this.languageAnalyzer.analyze({
                content,
                language: file.language,
                relativePath: file.path,
            });
            analysisByFile.set(file.path, {
                moduleBindings: analysis.moduleBindings,
                callSites: analysis.callSites,
            });
        }
        const relationshipRecords = buildRelationshipsForRegistry({ registry, analysisByFile });
        assertMutationCurrent?.();
        const result = await stageNavigationSidecarGeneration({
            stateRoot: this.symbolRegistryStateRoot,
            registry,
            records: relationshipRecords,
            analysisByFile,
        });
        console.log(`[Context] 🧭 Staged navigation generation '${result.generationId}' with ${result.symbolCount} symbols across ${result.fileShardCount} symbol shards and ${result.relationshipCount} relationships across ${result.relationshipFileShardCount} relationship shards`);
        if (!deferPublication) {
            await this.publishNavigationCandidate(result, assertMutationCurrent, publishMutation);
        }
        return result;
    }

    public async publishNavigationCandidate(
        candidate: StagedNavigationSidecarGeneration,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const canonicalRoot = candidate.normalizedRootPath;
        const previousGeneration = await resolveCurrentNavigationGeneration(
            this.symbolRegistryStateRoot,
            canonicalRoot,
        ).catch(() => null);
        assertMutationCurrent?.();
        await publishNavigationSidecarGeneration(candidate, {
            beforePublish: assertMutationCurrent,
            publishMutation,
        });
        console.log(`[Context] 🧭 Published navigation generation '${candidate.generationId}'.`);
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
        try {
            const retainedGenerationIds = new Set([
                candidate.generationId,
                ...(previousGeneration ? [previousGeneration.generationId] : []),
            ]);
            const generationsRoot = path.join(candidate.rootPath, 'generations');
            const generations = await fs.promises.readdir(generationsRoot, { withFileTypes: true });
            for (const obsolete of generations
                .filter((entry) => entry.isDirectory() && !retainedGenerationIds.has(entry.name))
                .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
                assertMutationCurrent?.();
                await fs.promises.rm(path.join(generationsRoot, obsolete.name), { recursive: true, force: true });
            }
        } catch (error) {
            assertMutationCurrent?.();
            console.warn(`[Context] ⚠️  Failed to collect obsolete navigation generations for ${canonicalRoot}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public async getCurrentNavigationGeneration(
        codebasePath: string,
    ): Promise<import('../symbols/sidecar').CurrentNavigationGeneration | null> {
        return resolveCurrentNavigationGeneration(
            this.symbolRegistryStateRoot,
            this.canonicalizeCodebasePath(codebasePath),
        );
    }

    public async restoreNavigationGeneration(
        codebasePath: string,
        generation: import('../symbols/sidecar').CurrentNavigationGeneration,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const rootPath = path.dirname(path.dirname(generation.generationRoot));
        await publishNavigationSidecarGeneration({
            rootPath,
            normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
            generationId: generation.generationId,
            manifestHash: generation.symbolRegistryManifestHash,
            relationshipManifestHash: generation.relationshipManifestHash,
        }, {
            beforePublish: assertMutationCurrent,
            publishMutation,
        });
    }

    public async discardNavigationCandidate(
        candidate: StagedNavigationSidecarGeneration,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        await discardNavigationSidecarGeneration(candidate, assertMutationCurrent);
    }

    public async publishCompletedIndexMarker(
        codebasePath: string,
        indexedFiles: number,
        totalChunks: number,
        collectionName: string,
        indexStatus: 'completed' | 'limit_reached',
        assertMutationCurrent?: () => void,
        navigationCandidate?: StagedNavigationSidecarGeneration,
        indexPolicyHash?: string,
    ): Promise<void> {
        await this.writeCompletedIndexMarker(
            codebasePath,
            indexedFiles,
            totalChunks,
            collectionName,
            indexStatus,
            assertMutationCurrent,
            navigationCandidate,
            indexPolicyHash,
        );
    }

    private async clearSymbolRegistryForCodebase(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        assertMutationCurrent?.();
        await clearSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
            beforeDelete: assertMutationCurrent,
            publishMutation,
        });
    }

    /**
 * Process accumulated chunk buffer
 */
    private async processChunkBuffer(
        chunkBuffer: Array<{
            chunk: CodeChunk;
            codebasePath: string;
            relativePath: string;
            fileChunkIndex: number;
        }>,
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
        await this.processChunkBatch(chunkBuffer, codebasePath, collectionName, assertMutationCurrent);
    }

    /**
     * Process a batch of chunks
     */
    private async processChunkBatch(
        chunkEntries: Array<{ chunk: CodeChunk; relativePath: string; fileChunkIndex: number }>,
        codebasePath: string,
        collectionName: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const indexedAt = new Date().toISOString();
        const chunks = chunkEntries.map(({ chunk }) => chunk);

        // Generate embedding vectors
        const chunkContents = chunks.map(chunk => chunk.content);
        const embeddings = await this.embedding.embedBatch(chunkContents);
        const expectedDimension = this.embedding.getDimension();
        if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
            throw new Error(`Embedding batch returned ${Array.isArray(embeddings) ? embeddings.length : 'a non-array result'} for ${chunks.length} chunks.`);
        }
        for (let index = 0; index < embeddings.length; index += 1) {
            const embedding = embeddings[index] as unknown;
            if (!embedding || typeof embedding !== 'object' || Array.isArray(embedding)) {
                throw new Error(`Embedding batch result ${index} is not a valid embedding object.`);
            }
            const record = embedding as { vector?: unknown; dimension?: unknown };
            if (!Array.isArray(record.vector)) {
                throw new Error(`Embedding batch result ${index} has no vector array.`);
            }
            if (record.vector.length !== expectedDimension || record.dimension !== expectedDimension) {
                throw new Error(`Embedding batch result ${index} has dimension ${record.vector.length}; expected ${expectedDimension}.`);
            }
            if (!record.vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
                throw new Error(`Embedding batch result ${index} contains a non-finite vector value.`);
            }
        }
        const documentIds = chunkEntries.map(({ chunk, relativePath, fileChunkIndex }) =>
            this.generateId(relativePath, chunk, fileChunkIndex)
        );
        if (new Set(documentIds).size !== documentIds.length) {
            throw new Error(`Duplicate chunk identities generated for collection '${collectionName}'.`);
        }

        if (isHybrid === true) {
            // Create hybrid vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                const relativePath = chunkEntries[index].relativePath;
                const fileExtension = path.extname(relativePath);
                const { filePath: omittedFilePath, startLine: omittedStartLine, endLine: omittedEndLine, ...restMetadata } = chunk.metadata;
                void omittedFilePath;
                void omittedStartLine;
                void omittedEndLine;

                return {
                    id: documentIds[index],
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
                        chunkIndex: chunkEntries[index].fileChunkIndex,
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
                const relativePath = chunkEntries[index].relativePath;
                const fileExtension = path.extname(relativePath);
                const { filePath: omittedFilePath, startLine: omittedStartLine, endLine: omittedEndLine, ...restMetadata } = chunk.metadata;
                void omittedFilePath;
                void omittedStartLine;
                void omittedEndLine;

                return {
                    id: documentIds[index],
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
                        chunkIndex: chunkEntries[index].fileChunkIndex,
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
    private generateId(relativePath: string, chunk: CodeChunk, fileChunkIndex: number): string {
        const combinedString = JSON.stringify([
            relativePath,
            fileChunkIndex,
            chunk.metadata.startByte ?? null,
            chunk.metadata.endByte ?? null,
            chunk.metadata.startLine,
            chunk.metadata.endLine,
            chunk.content,
        ]);
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
            return Context.parseIgnorePatterns(content);
        } catch (error) {
            console.warn(`[Context] ⚠️  Could not read ignore file ${filePath}: ${error}`);
            return [];
        }
    }

    private static parseIgnorePatterns(content: string): string[] {
        return content
            .split('\n')
            .map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
            .filter(line => line.length > 0 && !line.startsWith('#'));
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
                const patterns = await this.loadIgnoreFile(ignoreFile, path.basename(ignoreFile), codebasePath);
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
        const ignoreFiles: string[] = [];
        const supportedIgnoreFiles = ['.satoriignore', '.gitignore'];

        for (const fileName of supportedIgnoreFiles) {
            const absolutePath = path.join(codebasePath, fileName);
            try {
                const stat = await fs.promises.lstat(absolutePath);
                if (stat.isSymbolicLink()) {
                    throw new Error(`Ignore file '${fileName}' must not be a symbolic link.`);
                }
                if (!stat.isFile()) {
                    throw new Error(`Ignore file '${fileName}' is not a regular file.`);
                }
                ignoreFiles.push(absolutePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
        }

        if (ignoreFiles.length > 0) {
            console.log(`📄 Found ${ignoreFiles.length} supported root ignore file(s).`);
        }

        return ignoreFiles;
    }

    /**
     * Load ignore patterns from a specific ignore file
     * @param filePath Path to the ignore file
     * @param fileName Display name for logging
     * @returns Array of ignore patterns
     */
    private async loadIgnoreFile(filePath: string, fileName: string, codebasePath: string): Promise<string[]> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const handle = await openRegularFileInsideRootNoFollow(filePath, canonicalRoot);
        let content: string;
        try {
            const stat = await handle.stat();
            const maximumIgnoreFileBytes = 1_048_576;
            if (stat.size > maximumIgnoreFileBytes) {
                throw new Error(`${fileName} exceeds the ${maximumIgnoreFileBytes}-byte policy limit.`);
            }
            content = (await readFileHandleExactly(handle, stat.size)).toString('utf8');
            await verifyStableFileObservation(handle, filePath, canonicalRoot, stat, {
                rejectFinalSymlink: true,
            });
        } finally {
            await handle.close().catch(() => undefined);
        }
        const ignorePatterns = Context.parseIgnorePatterns(content);

        if (ignorePatterns.length > 0) {
            console.log(`[Context] 🚫 Loaded ${ignorePatterns.length} ignore patterns from ${fileName}`);
            return ignorePatterns;
        }
        console.log(`📄 ${fileName} file found but no valid patterns detected`);
        return [];
    }

    /**
     * Check if a path matches any ignore pattern
     * @param filePath Path to check
     * @param codebasePath Codebase root path used for relative pattern matching
     * @param isDirectory Whether the path is a directory
     * @returns True if path should be ignored
     */
    private matchesIgnorePattern(
        filePath: string,
        codebasePath: string,
        isDirectory: boolean = false,
        matcherOverride?: ReturnType<typeof ignore>,
    ): boolean {
        if (!matcherOverride && this.getActiveIgnorePatterns(codebasePath).length === 0) {
            return false;
        }

        const relativePath = path.relative(codebasePath, filePath).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relativePath || relativePath.startsWith('..')) {
            return false;
        }

        const matcher = matcherOverride ?? this.getIgnoreMatcherForCodebase(codebasePath);

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

    private resolveCustomIndexPolicyPath(canonicalRoot: string): string {
        const digest = crypto.createHash('sha256').update(canonicalRoot).digest('hex');
        return path.join(this.indexPolicyStateRoot, `${digest}.json`);
    }

    private recoverIndexPolicyTombstonesWhileLocked(targetPath: string): void {
        const directory = path.dirname(targetPath);
        const prefix = `${path.basename(targetPath)}.removed-`;
        let entries: string[];
        try {
            entries = fs.readdirSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        const tombstones = entries
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => path.join(directory, entry));
        const committed = tombstones.filter((entry) => path.basename(entry).startsWith(`${prefix}committed-`));
        for (const committedPath of committed) fs.rmSync(committedPath, { force: true });
        const pending = tombstones.filter((entry) => !committed.includes(entry));
        if (pending.length === 0) return;
        if (!fs.existsSync(targetPath)) {
            if (pending.length !== 1) {
                throw new Error(`Cannot recover index policy removal: ${pending.length} pending tombstones exist while '${targetPath}' is absent.`);
            }
            this.resolveVerifiedIndexPolicyDocumentDigest(pending[0]);
            fs.renameSync(pending[0], targetPath);
            return;
        }
        const targetDigest = this.resolveVerifiedIndexPolicyDocumentDigest(targetPath);
        for (const pendingPath of pending) {
            const pendingDigest = this.resolveVerifiedIndexPolicyDocumentDigest(pendingPath);
            if (pendingDigest !== targetDigest) {
                throw new Error(`Conflicting index policy removal tombstone '${pendingPath}' was preserved beside '${targetPath}'.`);
            }
            fs.rmSync(pendingPath, { force: true });
        }
    }

    private tryRecoverAbandonedIndexPolicyMutationLock(lockPath: string): boolean {
        let raw: string;
        let observation: fs.Stats;
        try {
            observation = fs.statSync(lockPath);
            raw = fs.readFileSync(lockPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            throw error;
        }
        const metadata = parseIndexPolicyMutationLockMetadata(raw);
        if (!metadata) {
            if (Date.now() - observation.mtimeMs < INDEX_POLICY_MALFORMED_LOCK_STALE_MS) return false;
        } else if (isProcessAlive(metadata.pid)) {
            const observedStartTime = resolveLinuxProcessStartTime(metadata.pid);
            if (!metadata.processStartTime || !observedStartTime || metadata.processStartTime === observedStartTime) {
                return false;
            }
        }
        const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
        try {
            fs.renameSync(lockPath, quarantinePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            throw error;
        }
        try {
            const quarantined = fs.statSync(quarantinePath);
            const quarantinedRaw = fs.readFileSync(quarantinePath, 'utf8');
            const quarantinedMetadata = parseIndexPolicyMutationLockMetadata(quarantinedRaw);
            const sameIdentity = observation.dev === quarantined.dev && observation.ino === quarantined.ino;
            const sameOwner = metadata === null
                ? quarantinedMetadata === null && quarantinedRaw === raw
                : quarantinedMetadata?.ownerToken === metadata.ownerToken
                    && quarantinedMetadata.pid === metadata.pid
                    && quarantinedMetadata.processStartTime === metadata.processStartTime;
            if (!sameIdentity || !sameOwner) {
                if (!fs.existsSync(lockPath)) fs.renameSync(quarantinePath, lockPath);
                throw new Error(`Index policy mutation lock changed during abandoned-owner recovery at '${lockPath}'.`);
            }
            fs.rmSync(quarantinePath, { force: true });
            return true;
        } catch (error) {
            if (fs.existsSync(quarantinePath) && !fs.existsSync(lockPath)) {
                try {
                    fs.renameSync(quarantinePath, lockPath);
                } catch {
                    // Preserve the quarantine path when recovery ownership is ambiguous.
                }
            }
            throw error;
        }
    }

    private acquireIndexPolicyMutationLock(canonicalRoot: string): IndexPolicyMutationLockHandle {
        fs.mkdirSync(this.indexPolicyStateRoot, { recursive: true });
        const lockPath = `${this.resolveCustomIndexPolicyPath(canonicalRoot)}.mutation.lock`;
        const ownerToken = crypto.randomUUID();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const descriptor = fs.openSync(lockPath, 'wx');
                try {
                    const processStartTime = resolveLinuxProcessStartTime(process.pid);
                    fs.writeFileSync(descriptor, JSON.stringify({
                        pid: process.pid,
                        ...(processStartTime ? { processStartTime } : {}),
                        ownerToken,
                        acquiredAt: new Date().toISOString(),
                    }));
                } catch (error) {
                    fs.closeSync(descriptor);
                    fs.rmSync(lockPath, { force: true });
                    throw error;
                }
                return { descriptor, lockPath, ownerToken };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (this.tryRecoverAbandonedIndexPolicyMutationLock(lockPath)) continue;
                let metadata: IndexPolicyMutationLockMetadata | null = null;
                try {
                    metadata = parseIndexPolicyMutationLockMetadata(fs.readFileSync(lockPath, 'utf8'));
                } catch {
                    // An unreadable live lock remains authoritative.
                }
                if (metadata?.pid === process.pid) {
                    throw new Error(`Index policy mutation lock is already held in this process for '${canonicalRoot}'.`);
                }
                throw new Error(`Index policy mutation lock is held by another live or unverified owner for '${canonicalRoot}' at '${lockPath}'.`);
            }
        }
        throw new Error(`Index policy mutation lock recovery did not converge for '${canonicalRoot}' at '${lockPath}'.`);
    }

    private releaseIndexPolicyMutationLock(handle: IndexPolicyMutationLockHandle): void {
        try {
            fs.closeSync(handle.descriptor);
        } catch {
            // Best-effort close; ownership is verified before unlinking.
        }
        try {
            const metadata = parseIndexPolicyMutationLockMetadata(fs.readFileSync(handle.lockPath, 'utf8'));
            if (metadata?.ownerToken === handle.ownerToken) fs.rmSync(handle.lockPath, { force: true });
        } catch {
            // A missing or replaced lock must not be removed by the former owner.
        }
    }

    private withIndexPolicyMutationLock<T>(canonicalRoot: string, operation: () => T): T {
        const handle = this.acquireIndexPolicyMutationLock(canonicalRoot);
        try {
            return operation();
        } finally {
            this.releaseIndexPolicyMutationLock(handle);
        }
    }

    private async withIndexPolicyMutationLockAsync<T>(canonicalRoot: string, operation: () => Promise<T>): Promise<T> {
        const handle = this.acquireIndexPolicyMutationLock(canonicalRoot);
        try {
            return await operation();
        } finally {
            this.releaseIndexPolicyMutationLock(handle);
        }
    }

    private resolveCustomIndexPolicyFileToken(canonicalRoot: string): string | null {
        try {
            const stat = fs.statSync(this.resolveCustomIndexPolicyPath(canonicalRoot), { bigint: true });
            return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
                .map((value) => value.toString())
                .join(':');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    private resolveVerifiedIndexPolicyDocumentDigest(policyPath: string): string {
        const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
        const payload = {
            schemaVersion: parsed.schemaVersion,
            canonicalRoot: parsed.canonicalRoot,
            customExtensions: parsed.customExtensions,
            customIgnorePatterns: parsed.customIgnorePatterns,
            fileBasedIgnorePatterns: parsed.fileBasedIgnorePatterns,
            profile: parsed.profile,
            supportedExtensions: parsed.supportedExtensions,
            effectiveIgnorePatterns: parsed.effectiveIgnorePatterns,
            policyHash: parsed.policyHash,
            collectionName: parsed.collectionName,
            navigationGenerationId: parsed.navigationGenerationId,
        };
        const expectedDigest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
        if (parsed.documentDigest !== expectedDigest) {
            throw new Error('Removed index policy document digest is invalid.');
        }
        return expectedDigest;
    }

    private clearResolvedIndexPolicyRuntime(canonicalRoot: string): void {
        this.runtimeCustomExtensionsByCodebase.delete(canonicalRoot);
        this.runtimeCustomIgnorePatternsByCodebase.delete(canonicalRoot);
        this.publishedPolicyBindingsByCodebase.delete(canonicalRoot);
        this.publishedResolvedPoliciesByCodebase.delete(canonicalRoot);
        this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
        this.loadedCustomPolicyRoots.delete(canonicalRoot);
        this.setFileBasedPatternsForCodebase(canonicalRoot, []);
    }

    private loadCustomIndexPolicy(canonicalRoot: string): void {
        const currentToken = this.resolveCustomIndexPolicyFileToken(canonicalRoot);
        if (
            this.policyFileTokensByCodebase.has(canonicalRoot)
            && this.policyFileTokensByCodebase.get(canonicalRoot) === currentToken
        ) {
            return;
        }
        if (currentToken === null) {
            this.clearResolvedIndexPolicyRuntime(canonicalRoot);
            this.policyFileTokensByCodebase.set(canonicalRoot, null);
            return;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.resolveCustomIndexPolicyPath(canonicalRoot), 'utf8')) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Custom index policy document is not an object.');
            }
            const record = parsed as Record<string, unknown>;
            if (record.schemaVersion !== 'satori_index_policy_v2' || record.canonicalRoot !== canonicalRoot) {
                throw new Error('Custom index policy identity is invalid.');
            }
            const extensions = Array.isArray(record.customExtensions)
                ? record.customExtensions.filter((value): value is string => typeof value === 'string')
                : null;
            const ignorePatterns = Array.isArray(record.customIgnorePatterns)
                ? record.customIgnorePatterns.filter((value): value is string => typeof value === 'string')
                : null;
            const fileBasedIgnorePatterns = Array.isArray(record.fileBasedIgnorePatterns)
                ? record.fileBasedIgnorePatterns.filter((value): value is string => typeof value === 'string')
                : null;
            const supportedExtensions = Array.isArray(record.supportedExtensions)
                ? record.supportedExtensions.filter((value): value is string => typeof value === 'string')
                : null;
            const effectiveIgnorePatterns = Array.isArray(record.effectiveIgnorePatterns)
                ? record.effectiveIgnorePatterns.filter((value): value is string => typeof value === 'string')
                : null;
            if (!extensions || !ignorePatterns || !fileBasedIgnorePatterns || !supportedExtensions || !effectiveIgnorePatterns
                || extensions.length !== (record.customExtensions as unknown[]).length
                || ignorePatterns.length !== (record.customIgnorePatterns as unknown[]).length
                || fileBasedIgnorePatterns.length !== (record.fileBasedIgnorePatterns as unknown[]).length
                || supportedExtensions.length !== (record.supportedExtensions as unknown[]).length
                || effectiveIgnorePatterns.length !== (record.effectiveIgnorePatterns as unknown[]).length) {
                throw new Error('Custom index policy arrays are malformed.');
            }
            const profile: IndexProfile | null = record.profile === 'default' || record.profile === 'minimal' || record.profile === 'all-text'
                ? record.profile
                : null;
            if (!profile) {
                throw new Error('Custom index policy profile is malformed.');
            }
            const payload = {
                schemaVersion: 'satori_index_policy_v2',
                canonicalRoot,
                customExtensions: normalizeSupportedExtensions(extensions),
                customIgnorePatterns: [...ignorePatterns],
                fileBasedIgnorePatterns: [...fileBasedIgnorePatterns],
                profile,
                supportedExtensions: normalizeSupportedExtensions(supportedExtensions),
                effectiveIgnorePatterns: [...effectiveIgnorePatterns],
                policyHash: typeof record.policyHash === 'string' ? record.policyHash : '',
                collectionName: typeof record.collectionName === 'string' ? record.collectionName : '',
                navigationGenerationId: typeof record.navigationGenerationId === 'string' ? record.navigationGenerationId : '',
            };
            const expectedDigest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
            if (record.documentDigest !== expectedDigest) {
                throw new Error('Custom index policy document digest is invalid.');
            }
            const expectedPolicyHash = crypto.createHash('sha256').update(JSON.stringify({
                profile: payload.profile,
                extensions: payload.supportedExtensions,
                ignorePatterns: payload.effectiveIgnorePatterns,
            }), 'utf8').digest('hex');
            if (!/^[a-f0-9]{64}$/.test(payload.policyHash) || payload.policyHash !== expectedPolicyHash
                || !payload.collectionName.trim()
                || (payload.navigationGenerationId && !/^[a-zA-Z0-9_-]+$/.test(payload.navigationGenerationId))) {
                throw new Error('Custom index policy generation binding is invalid.');
            }
            this.activateResolvedIndexPolicy({
                canonicalRoot,
                profile: payload.profile,
                customExtensions: payload.customExtensions,
                customIgnorePatterns: payload.customIgnorePatterns,
                fileBasedIgnorePatterns: payload.fileBasedIgnorePatterns,
                supportedExtensions: payload.supportedExtensions,
                effectiveIgnorePatterns: payload.effectiveIgnorePatterns,
                policyHash: payload.policyHash,
            }, {
                collectionName: payload.collectionName,
                ...(payload.navigationGenerationId ? { navigationGenerationId: payload.navigationGenerationId } : {}),
            });
            this.loadedCustomPolicyRoots.add(canonicalRoot);
            this.policyFileTokensByCodebase.set(canonicalRoot, currentToken);
        } catch (error) {
            this.loadedCustomPolicyRoots.delete(canonicalRoot);
            this.policyFileTokensByCodebase.delete(canonicalRoot);
            this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
            throw new Error(`Malformed custom index policy for '${canonicalRoot}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private persistCustomIndexPolicy(
        policy: ResolvedIndexPolicy,
        binding: { collectionName: string; navigationGenerationId?: string },
        publishMutation?: (publish: () => void) => void,
        activate?: () => void,
    ): IndexPolicyPublicationReceipt {
        const canonicalRoot = policy.canonicalRoot;
        if (!binding.collectionName.trim()) {
            throw new Error('Index policy collection binding must be nonempty.');
        }
        if (binding.navigationGenerationId && !/^[a-zA-Z0-9_-]+$/.test(binding.navigationGenerationId)) {
            throw new Error('Index policy navigation generation binding is invalid.');
        }
        const expectedPolicyHash = crypto.createHash('sha256').update(JSON.stringify({
            profile: policy.profile,
            extensions: policy.supportedExtensions,
            ignorePatterns: policy.effectiveIgnorePatterns,
        }), 'utf8').digest('hex');
        if (policy.policyHash !== expectedPolicyHash) {
            throw new Error('Resolved index policy hash does not match its effective inputs.');
        }
        ignore().add(policy.effectiveIgnorePatterns);
        fs.mkdirSync(this.indexPolicyStateRoot, { recursive: true });
        const targetPath = this.resolveCustomIndexPolicyPath(canonicalRoot);
        const temporaryPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
        const collectionName = this.resolveCollectionName(canonicalRoot);
        const previousRuntimeState = {
            customExtensions: this.runtimeCustomExtensionsByCodebase.has(canonicalRoot)
                ? [...(this.runtimeCustomExtensionsByCodebase.get(canonicalRoot) ?? [])]
                : null,
            customIgnorePatterns: this.runtimeCustomIgnorePatternsByCodebase.has(canonicalRoot)
                ? [...(this.runtimeCustomIgnorePatternsByCodebase.get(canonicalRoot) ?? [])]
                : null,
            profile: this.indexProfilesByCodebase.get(canonicalRoot),
            binding: this.publishedPolicyBindingsByCodebase.get(canonicalRoot),
            resolvedPolicy: this.publishedResolvedPoliciesByCodebase.get(canonicalRoot),
            ignoreState: this.ignoreStateByCollection.get(collectionName),
            wasLoaded: this.loadedCustomPolicyRoots.has(canonicalRoot),
            fileToken: this.policyFileTokensByCodebase.get(canonicalRoot),
            hadFileToken: this.policyFileTokensByCodebase.has(canonicalRoot),
            runtimeCompatible: this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot),
        };
        const restoreRuntimeState = () => {
            if (previousRuntimeState.customExtensions) {
                this.runtimeCustomExtensionsByCodebase.set(canonicalRoot, [...previousRuntimeState.customExtensions]);
            } else {
                this.runtimeCustomExtensionsByCodebase.delete(canonicalRoot);
            }
            if (previousRuntimeState.customIgnorePatterns) {
                this.runtimeCustomIgnorePatternsByCodebase.set(canonicalRoot, [...previousRuntimeState.customIgnorePatterns]);
            } else {
                this.runtimeCustomIgnorePatternsByCodebase.delete(canonicalRoot);
            }
            if (previousRuntimeState.profile) {
                this.indexProfilesByCodebase.set(canonicalRoot, previousRuntimeState.profile);
            } else {
                this.indexProfilesByCodebase.delete(canonicalRoot);
            }
            if (previousRuntimeState.binding) {
                this.publishedPolicyBindingsByCodebase.set(canonicalRoot, { ...previousRuntimeState.binding });
            } else {
                this.publishedPolicyBindingsByCodebase.delete(canonicalRoot);
            }
            if (previousRuntimeState.resolvedPolicy) {
                this.publishedResolvedPoliciesByCodebase.set(canonicalRoot, {
                    ...previousRuntimeState.resolvedPolicy,
                    customExtensions: [...previousRuntimeState.resolvedPolicy.customExtensions],
                    customIgnorePatterns: [...previousRuntimeState.resolvedPolicy.customIgnorePatterns],
                    fileBasedIgnorePatterns: [...previousRuntimeState.resolvedPolicy.fileBasedIgnorePatterns],
                    supportedExtensions: [...previousRuntimeState.resolvedPolicy.supportedExtensions],
                    effectiveIgnorePatterns: [...previousRuntimeState.resolvedPolicy.effectiveIgnorePatterns],
                });
            } else {
                this.publishedResolvedPoliciesByCodebase.delete(canonicalRoot);
            }
            if (previousRuntimeState.ignoreState) {
                this.ignoreStateByCollection.set(collectionName, {
                    ...previousRuntimeState.ignoreState,
                    fileBasedPatterns: [...previousRuntimeState.ignoreState.fileBasedPatterns],
                    effectivePatterns: [...previousRuntimeState.ignoreState.effectivePatterns],
                });
            } else {
                this.ignoreStateByCollection.delete(collectionName);
            }
            if (previousRuntimeState.wasLoaded) {
                this.loadedCustomPolicyRoots.add(canonicalRoot);
            } else {
                this.loadedCustomPolicyRoots.delete(canonicalRoot);
            }
            if (previousRuntimeState.hadFileToken) {
                this.policyFileTokensByCodebase.set(canonicalRoot, previousRuntimeState.fileToken ?? null);
            } else {
                this.policyFileTokensByCodebase.delete(canonicalRoot);
            }
            if (previousRuntimeState.runtimeCompatible !== undefined) {
                this.policyRuntimeCompatibilityByCodebase.set(canonicalRoot, previousRuntimeState.runtimeCompatible);
            } else {
                this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
            }
        };
        const payload = {
            schemaVersion: 'satori_index_policy_v2',
            canonicalRoot,
            customExtensions: policy.customExtensions,
            customIgnorePatterns: policy.customIgnorePatterns,
            fileBasedIgnorePatterns: policy.fileBasedIgnorePatterns,
            profile: policy.profile,
            supportedExtensions: policy.supportedExtensions,
            effectiveIgnorePatterns: policy.effectiveIgnorePatterns,
            policyHash: policy.policyHash,
            collectionName: binding.collectionName,
            navigationGenerationId: binding.navigationGenerationId ?? '',
        };
        const documentDigest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
        const receipt: IndexPolicyPublicationReceipt = {
            status: 'committed',
            operation: 'publish',
            canonicalRoot,
            documentDigest,
            policyHash: policy.policyHash,
            collectionName: binding.collectionName,
            ...(binding.navigationGenerationId ? { navigationGenerationId: binding.navigationGenerationId } : {}),
        };
        fs.writeFileSync(temporaryPath, JSON.stringify({ ...payload, documentDigest }, null, 2));
        let publicationCount = 0;
        let durablePublicationCompleted = false;
        try {
            const publish = () => {
                publicationCount += 1;
                if (publicationCount > 1) {
                    throw new Error('Index policy publication invoked more than once.');
                }
                try {
                    this.withIndexPolicyMutationLock(canonicalRoot, () => {
                        this.recoverIndexPolicyTombstonesWhileLocked(targetPath);
                        activate?.();
                        fs.renameSync(temporaryPath, targetPath);
                        durablePublicationCompleted = true;
                        this.policyFileTokensByCodebase.set(
                            canonicalRoot,
                            this.resolveCustomIndexPolicyFileToken(canonicalRoot),
                        );
                    });
                } catch (error) {
                    if (!durablePublicationCompleted) restoreRuntimeState();
                    throw error;
                }
            };
            if (publishMutation) {
                publishMutation(publish);
                if (publicationCount !== 1) throw new Error('Index policy publication returned without publishing.');
            } else {
                publish();
            }
        } catch (error) {
            if (publicationCount > 0 && !durablePublicationCompleted) {
                restoreRuntimeState();
            }
            if (durablePublicationCompleted) {
                throw new IndexPolicyPublicationError(
                    `Index policy publication committed before its receipt failed: ${error instanceof Error ? error.message : String(error)}`,
                    receipt,
                    error,
                );
            }
            throw error;
        } finally {
            fs.rmSync(temporaryPath, { force: true });
        }
        return receipt;
    }

    /**
     * Get current language-analysis information.
     */
    getLanguageAnalyzerInfo(): { description: string; hasTextFallback: boolean } {
        return {
            description: this.languageAnalyzer.getDescription(),
            hasTextFallback: true,
        };
    }

    /**
     * Check whether the current analyzer has structural support for a language.
     */
    isLanguageSupported(language: string): boolean {
        return this.languageAnalyzer.getStrategyForLanguage(language).structural;
    }

    /**
     * Get which strategy would be used for a specific language
     * @param language Programming language
     */
    getLanguageAnalysisStrategy(language: string): ReturnType<LanguageAnalysisPort['getStrategyForLanguage']> {
        return this.languageAnalyzer.getStrategyForLanguage(language);
    }
}
