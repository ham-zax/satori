import {
    Embedding,
    OpenAIEmbedding,
    resolveValidatedEmbeddingIdentity,
    type EmbeddingIdentity,
    type EmbeddingOperationMetricsSnapshot,
} from '../embedding';
import {
    VectorDatabase,
    VectorFilter,
    deleteCollectionWithVerification,
    type VectorWriteMetricsSnapshot,
    type VectorStoreProviderIdentity,
} from '../vectordb';
import {
    SemanticSearchRequest,
    SemanticSearchResult,
    type SemanticSearchCandidateTraceOptions,
    type SemanticSearchExecutionResult,
} from '../types';
import { envManager } from '../utils/env-manager';
import {
    DEFAULT_IGNORE_PATTERNS,
    IndexProfile,
} from '../config/defaults';
import {
    normalizeSupportedExtensions,
} from '../config/index-policy';
import {
    loadSatoriRepoConfig,
    SatoriRepoConfig,
} from '../config/repo-config';
import {
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
} from '../symbols';

import type {
    SymbolRecord,
    SymbolRegistryManifestFile,
} from '../symbols';
import {
    createLanguageAnalysisService,
    LANGUAGE_PARSER_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
    type LanguageAnalysisPort,
} from '../language-analysis';
import {
    canonicalizeRepositoryRelativePath,
    type RepositoryRelativePath,
} from '../paths/repository-path';
import {
    type RelationshipAnalysisEvidence,
    type ResolutionProjectAnalyzer,
} from '../relationships';
import { LazyTypeScriptSemanticProjectAnalyzer } from '../relationships/lazy-typescript-semantic-analyzer';

import { ThreadedWasmSemanticProjectAnalyzer, type SemanticProjectAnalyzer } from '../semantic';
import {
    computePublicationPackageOwnershipDigest,
    PACKAGE_OWNERSHIP_SCHEMA_VERSION,
    type PublicationPackageOwnership,
} from '../packages/ownership';

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import ignore from 'ignore';
import {
    FileSynchronizer,
    type ProvenSourceFreshnessCheckpointEvidence,
    type SourceFreshnessPathComparison,
} from '../sync/synchronizer';
import type {
    PublicationSourceCheckpoint,
    SnapshotFileStatSignature,
} from '../sync/snapshot-codec';
import { SynchronizerRegistry } from '../sync/synchronizer-registry';
export type { ProvenSourceFreshnessCheckpointEvidence } from '../sync/synchronizer';

import type {
    CustomIndexPolicyUpdate,
    IndexCodebaseResult,
    ObservedResolvedIndexPolicy,
    Publication,
    PublicationLease,
    PublicationNavigationStatus,
    PublicationRef,
} from '../generation/contracts';

export type {
    CustomIndexPolicyUpdate,
    IndexCodebaseResult,
    ObservedResolvedIndexPolicy,
    Publication,
    PublicationLease,
    PublicationNavigationStatus,
    PublicationRef,
} from '../generation/contracts';
export { AtomicIncrementalPublicationUnsupportedError } from '../generation/errors';
import {
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
} from './search-projections';
import { SemanticSearchService } from './semantic-search-service';
import {
    IndexingPipeline,
    type AnalyzedFileSymbolFacts,
    type AnalyzedIndexedFile,
    type ExpectedIndexedChunk,
    type IndexingPipelineMetrics,
    type ProcessedFileList,
    type ProjectedChunkEntry,
} from './indexing-pipeline';
import { IndexAuthorityCoordinator } from '../generation/index-authority-coordinator';
import { IndexGenerationWorkflow } from '../generation/index-generation-workflow';
import { IndexTeardownWorkflow } from '../generation/index-teardown-workflow';
import {
    PublicationStore,
    getSharedPublicationStore,
    type SharedPublicationRuntime,
} from '../generation/publication-store';
import {
    RootMutationRuntime,
    getCurrentRootMutationLease,
    getRootMutationCoordinator,
} from '../generation/root-mutation-runtime';

import {
    IgnoreRuleService,
    getCustomExtensionsFromEnvironment,
    getCustomIgnorePatternsFromEnvironment,
    readIgnorePatternsFile,
} from './ignore-rule-service';
import {
    resolveCollectionFamilyName,
    resolvePublicationCollectionName,
} from './collection-naming';
import {
    computeIndexPolicyControlSignature,
} from './index-policy-input-observer';
import {
    IndexPolicyAuthorityError,
    IndexPolicyRuntimeService,
} from '../policy/index-policy-runtime-service';
import type { ResolvedIndexPolicy } from '../policy/index-policy-runtime-service';
export type { ResolvedIndexPolicy } from '../policy/index-policy-runtime-service';
function subtractEmbeddingMetrics(
    after: EmbeddingOperationMetricsSnapshot | null,
    before: EmbeddingOperationMetricsSnapshot | null,
): EmbeddingOperationMetricsSnapshot | null {
    if (!after || !before) return null;
    return {
        providerRequestCount: after.providerRequestCount - before.providerRequestCount,
        retryCount: after.retryCount - before.retryCount,
        submittedItems: after.submittedItems - before.submittedItems,
        submittedBytes: after.submittedBytes - before.submittedBytes,
        providerTokens: after.providerTokens - before.providerTokens,
        durationMs: after.durationMs - before.durationMs,
    };
}

function subtractVectorWriteMetrics(
    after: VectorWriteMetricsSnapshot | null,
    before: VectorWriteMetricsSnapshot | null,
): VectorWriteMetricsSnapshot | null {
    if (!after || !before) return null;
    const providerRequestCount = after.providerRequestCount - before.providerRequestCount;
    if (providerRequestCount < 0) return null;
    const recentAttempts = Array.isArray(after.recentAttempts)
        ? after.recentAttempts.filter((attempt) => (
            attempt.sequence > before.providerRequestCount
            && attempt.sequence <= after.providerRequestCount
        ))
        : [];
    return {
        providerRequestCount,
        retryCount: after.retryCount - before.retryCount,
        submittedRows: after.submittedRows - before.submittedRows,
        submittedBytes: after.submittedBytes - before.submittedBytes,
        durationMs: after.durationMs - before.durationMs,
        rowLimit: after.rowLimit,
        byteLimit: after.byteLimit,
        recentAttempts,
    };
}

function percentile(values: readonly number[], fraction: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
    return sorted[index] ?? null;
}

function summarizeVectorWriteMetrics(
    metrics: VectorWriteMetricsSnapshot | null,
    logicalRows: number,
): Record<string, unknown> | null {
    if (!metrics) return null;
    const samplesComplete = metrics.recentAttempts.length === metrics.providerRequestCount;
    const rowValues = metrics.recentAttempts.map((attempt) => attempt.rows);
    const byteValues = metrics.recentAttempts.map((attempt) => attempt.bytes);
    const flushReasons = metrics.recentAttempts.reduce((counts, attempt) => ({
        ...counts,
        [attempt.flushReason]: counts[attempt.flushReason] + 1,
    }), {
        row_limit: 0,
        byte_limit: 0,
        logical_write_end: 0,
        retry: 0,
    });
    const initialProviderRequests = metrics.providerRequestCount - metrics.retryCount;
    const theoreticalMinimumRequests = metrics.rowLimit > 0
        ? Math.ceil(logicalRows / metrics.rowLimit)
        : null;

    return {
        providerRequestCount: metrics.providerRequestCount,
        retryCount: metrics.retryCount,
        submittedRows: metrics.submittedRows,
        submittedBytes: metrics.submittedBytes,
        durationMs: metrics.durationMs,
        rowLimit: metrics.rowLimit,
        byteLimit: metrics.byteLimit,
        samples: {
            complete: samplesComplete,
            captured: metrics.recentAttempts.length,
        },
        requestRows: {
            min: percentile(rowValues, 0),
            p50: percentile(rowValues, 0.5),
            p90: percentile(rowValues, 0.9),
            p95: percentile(rowValues, 0.95),
            max: percentile(rowValues, 1),
        },
        requestBytes: {
            min: percentile(byteValues, 0),
            p50: percentile(byteValues, 0.5),
            p90: percentile(byteValues, 0.9),
            p95: percentile(byteValues, 0.95),
            max: percentile(byteValues, 1),
        },
        flushReasons,
        theoreticalMinimumRequests,
        fragmentationOverheadRequests: theoreticalMinimumRequests === null
            ? null
            : initialProviderRequests - theoreticalMinimumRequests,
    };
}


export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    vectorStoreProvider?: VectorStoreProviderIdentity;
    languageAnalyzer?: LanguageAnalysisPort;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    semanticAnalyzer?: SemanticProjectAnalyzer;
    resolutionAnalyzer?: ResolutionProjectAnalyzer;
    rootMutationRuntime?: RootMutationRuntime;
    publicationRuntime?: SharedPublicationRuntime;
}

export type PublicationValidationEvidence =
    | {
        status: 'valid';
        publication: PublicationRef;
        navigationStatus: PublicationNavigationStatus;
    }
    | { status: 'requires_reindex' }
    | { status: 'policy_authority_invalid' }
    | { status: 'runtime_policy_incompatible' }
    | { status: 'missing' };

type ReindexByChangeOptions = {
    targetCollectionName?: string;
    sourcePublication?: PublicationRef;
    onPhaseTiming?: (
        phase:
            | 'publication_source_navigation_load'
            | 'publication_fork'
            | 'publication_payload_delta'
            | 'publication_navigation_checkpoint'
            | 'publication_navigation_delta'
            | 'publication_relationship_load'
            | 'publication_relationship_delta'
            | 'publication_sidecar_stage'
            | 'publication_checkpoint_stage'
            | 'publication_payload_count'
            | 'publication_activation',
        durationMs: number,
    ) => void;
};

type MutationGuardOptions = {
    deferPartialPublication?: boolean;
    indexPolicy?: ObservedResolvedIndexPolicy;
};

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


export class Context {
    private embedding: Embedding;
    private embeddingIdentity: Readonly<EmbeddingIdentity>;
    private vectorDatabase: VectorDatabase;
    private readonly languageAnalyzer: LanguageAnalysisPort;
    private supportedExtensions: string[];
    private readonly indexPolicyRuntimeService: IndexPolicyRuntimeService;
    private readonly rootMutationRuntime: RootMutationRuntime;
    private readonly publicationStore: PublicationStore;
    private readonly synchronizerRegistry = new SynchronizerRegistry({
        canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
        getCurrentPublicationSourceCheckpoint: (codebasePath) => (
            this.publicationStore.getCurrentSourceCheckpoint(codebasePath)
        ),
        getActiveIgnorePatterns: (codebasePath) => this.getActiveIgnorePatterns(codebasePath),
        getIndexedExtensionsForCodebase: (codebasePath) => this.getIndexedExtensionsForCodebase(codebasePath),
        loadIndexProfileForCodebase: (codebasePath) => this.loadIndexProfileForCodebase(codebasePath),
        resolveCollectionName: (codebasePath) => this.resolveCollectionName(codebasePath),
    });

    private readonly indexAuthorityCoordinator: IndexAuthorityCoordinator;
    private indexGenerationWorkflow: IndexGenerationWorkflow;
    private readonly indexTeardownWorkflow: IndexTeardownWorkflow;
    private readonly semanticSearchService: SemanticSearchService;
    private readonly indexingPipeline: IndexingPipeline;
    private readonly ignoreRuleService: IgnoreRuleService;
    private readonly semanticAnalyzer?: SemanticProjectAnalyzer;
    private readonly resolutionAnalyzer?: ResolutionProjectAnalyzer;
    private disposePromise: Promise<void> | null = null;
    private vectorStoreProvider: VectorStoreProviderIdentity;

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
        this.embeddingIdentity = resolveValidatedEmbeddingIdentity(this.embedding);

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;
        const backendInfo = config.vectorDatabase.getBackendInfo?.();
        const inferredVectorStoreProvider = backendInfo?.provider === 'lancedb' ? 'LanceDB' : 'Milvus';
        if (
            config.vectorStoreProvider !== undefined
            && backendInfo !== undefined
            && config.vectorStoreProvider !== inferredVectorStoreProvider
        ) {
            throw new Error(
                `Configured vector-store provider '${config.vectorStoreProvider}' does not match adapter provider '${inferredVectorStoreProvider}'.`,
            );
        }
        this.vectorStoreProvider = config.vectorStoreProvider ?? inferredVectorStoreProvider;
        this.rootMutationRuntime = config.rootMutationRuntime ?? new RootMutationRuntime();
        this.publicationStore = config.publicationRuntime
            ? getSharedPublicationStore(config.publicationRuntime, this.rootMutationRuntime)
            : new PublicationStore({
                mutationCoordinator: getRootMutationCoordinator(this.rootMutationRuntime),
            });

        this.languageAnalyzer = config.languageAnalyzer || createLanguageAnalysisService({
            chunkSize: 2500,
            chunkOverlap: 300,
        });

        // Static runtime overlays remain inputs for newly built Publications.
        const envCustomExtensions = getCustomExtensionsFromEnvironment();
        const envCustomIgnorePatterns = getCustomIgnorePatternsFromEnvironment();
        const allIgnorePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...envCustomIgnorePatterns,
        ];

        this.ignoreRuleService = new IgnoreRuleService({
            basePatterns: allIgnorePatterns,
            canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
            resolveCollectionName: (codebasePath) => this.resolveCollectionName(codebasePath),
            ensureRuntimePolicyLoaded: (canonicalRoot) => (
                this.indexPolicyRuntimeService.loadCurrentPublicationPolicy(canonicalRoot)
            ),
        });

        this.indexPolicyRuntimeService = new IndexPolicyRuntimeService({
            configuredExtensionOverlays: normalizeSupportedExtensions([
                ...(config.supportedExtensions || []),
                ...(config.customExtensions || []),
                ...envCustomExtensions,
            ]),
            getIgnoreRuleService: () => this.ignoreRuleService,
            canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
            getCurrentPublication: (canonicalRoot) => this.publicationStore.getCurrent(canonicalRoot),
            getPublishedResolvedPolicy: (canonicalRoot) => this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot),
            onActivateResolvedIndexPolicy: (policy, binding) => (
                this.indexAuthorityCoordinator.activatePublishedIndexPolicy(policy, binding)
            ),
            onClearPublishedIndexPolicy: (canonicalRoot) => (
                this.indexAuthorityCoordinator.clearPublishedIndexPolicyRuntime(canonicalRoot)
            ),
        });
        this.supportedExtensions = this.indexPolicyRuntimeService.buildSupportedExtensions('default');

        this.indexAuthorityCoordinator = new IndexAuthorityCoordinator();

        this.indexTeardownWorkflow = new IndexTeardownWorkflow({
            canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
            clearCurrentPublication: (canonicalRoot, lease) => (
                this.publicationStore.clearCurrent(canonicalRoot, lease)
            ),
            collectPublicationGarbage: (canonicalRoot, lease) => (
                this.collectPublicationGarbageWithLease(canonicalRoot, lease)
            ),
            clearResolvedIndexPolicyRuntime: (canonicalRoot) => (
                this.indexPolicyRuntimeService.clearResolvedIndexPolicyRuntime(canonicalRoot)
            ),
            resolveCollectionName: (codebasePath) => this.resolveCollectionName(codebasePath),
            clearSynchronizerForCollection: (collectionName) => (
                this.synchronizerRegistry.clearSynchronizerForCollection(collectionName)
            ),
            deleteIgnoreCodebaseState: (codebasePath) => this.ignoreRuleService.deleteCodebaseState(codebasePath),
            deleteIndexProfile: (canonicalRoot) => this.indexPolicyRuntimeService.deleteIndexProfile(canonicalRoot),
        });

        const semanticAnalyzer = config.semanticAnalyzer ?? new ThreadedWasmSemanticProjectAnalyzer();
        const resolutionAnalyzer = config.resolutionAnalyzer ?? new LazyTypeScriptSemanticProjectAnalyzer();
        this.semanticAnalyzer = semanticAnalyzer;
        this.resolutionAnalyzer = resolutionAnalyzer;

        this.indexGenerationWorkflow = new IndexGenerationWorkflow({
            activatePublication: (publication, lease) => this.publicationStore.activate(publication, lease),
            getCurrentPublicationSourceCheckpoint: (canonicalRoot) => (
                this.publicationStore.getCurrentSourceCheckpoint(canonicalRoot)
            ),
            stagePublicationSourceCheckpoint: (canonicalRoot, publicationId, checkpoint, lease) => (
                this.publicationStore.stageSourceCheckpoint(canonicalRoot, publicationId, checkpoint, lease)
            ),
            stagePublicationPackageOwnership: (canonicalRoot, publicationId, ownership, lease) => (
                this.publicationStore.stagePackageOwnership(canonicalRoot, publicationId, ownership, lease)
            ),
            preparePublicationNavigationRoot: (canonicalRoot, publicationId, lease) => (
                this.publicationStore.prepareNavigationRoot(canonicalRoot, publicationId, lease)
            ),
            discardUnpublishedPublication: (canonicalRoot, publicationId, lease) => (
                this.publicationStore.discardUnpublished(canonicalRoot, publicationId, lease)
            ),
            collectPublicationGarbage: (canonicalRoot, lease) => (
                this.collectPublicationGarbageWithLease(canonicalRoot, lease)
            ),
            getPublicationNavigation: (canonicalRoot, publicationId) => (
                this.getPublicationNavigation(canonicalRoot, publicationId)
            ),
            assertResolvedIndexPolicyRoot: (codebasePath, policy) => (
                this.assertResolvedIndexPolicyRoot(codebasePath, policy)
            ),
            buildPublicationFormat: () => this.buildPublicationFormat(),
            buildRootFingerprint: (canonicalRoot) => this.buildRootFingerprint(canonicalRoot),
            canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
            countIndexedPayloadExactly: (collectionName, filter, expectedMaximum) => (
                this.countIndexedPayloadExactly(collectionName, filter, expectedMaximum)
            ),
            deleteFileChunks: (collectionName, relativePath, assertMutationCurrent) => (
                this.deleteFileChunks(collectionName, relativePath, assertMutationCurrent)
            ),
            embedding: this.embedding,
            getActiveIgnorePatterns: (codebasePath) => this.getActiveIgnorePatterns(codebasePath),
            getActiveIndexedCollectionName: (codebasePath) => this.getActiveIndexedCollectionName(codebasePath),
            getCodeFiles: (codebasePath, indexPolicy) => this.getCodeFiles(codebasePath, indexPolicy),
            getIndexedExtensionsForCodebase: (codebasePath) => this.getIndexedExtensionsForCodebase(codebasePath),
            getIsHybrid: () => this.getIsHybrid(),
            getLanguageRouterVersion: () => this.getLanguageRouterVersion(),
            getRelationshipVersion: () => this.getRelationshipVersion(),
            getSymbolExtractorVersion: () => this.getSymbolExtractorVersion(),
            indexAuthorityCoordinator: this.indexAuthorityCoordinator,
            isObservedIndexPolicyControlSignatureCurrent: (policy) => (
                this.isObservedIndexPolicyControlSignatureCurrent(policy)
            ),
            indexPolicyRuntimeService: this.indexPolicyRuntimeService,
            loadIgnorePatterns: (codebasePath) => this.loadIgnorePatterns(codebasePath),
            loadIndexProfileForCodebase: (codebasePath) => this.loadIndexProfileForCodebase(codebasePath),
            normalizeRelativePathForCodebase: (codebasePath, candidatePath) => (
                this.normalizeRelativePathForCodebase(codebasePath, candidatePath)
            ),
            normalizeRelativePathsForCodebase: (codebasePath, relativePaths) => (
                this.normalizeRelativePathsForCodebase(codebasePath, relativePaths)
            ),
            prepareCollection: (codebasePath, forceReindex, assertMutationCurrent, collectionNameOverride) => (
                this.prepareCollection(codebasePath, forceReindex, assertMutationCurrent, collectionNameOverride)
            ),
            processFileList: (filePaths, codebasePath, onFileProcessed, collectionName, assertMutationCurrent, indexPolicy) => (
                this.processFileList(
                    filePaths,
                    codebasePath,
                    onFileProcessed,
                    collectionName,
                    assertMutationCurrent,
                    indexPolicy,
                )
            ),
            refreshRuntimePolicyAuthority: (canonicalRoot) => this.refreshRuntimePolicyAuthority(canonicalRoot),
            resolveCollectionName: (codebasePath) => this.resolveCollectionName(codebasePath),
            resolveIndexPolicyFromCurrentInputs: (canonicalRoot, update, inheritActiveCustomPolicy, activateRuntimeProfile) => (
                this.indexPolicyRuntimeService.resolveIndexPolicyFromCurrentInputs(canonicalRoot, update, inheritActiveCustomPolicy, activateRuntimeProfile)
            ),
            resolveNavigationObservationToken: (canonicalRoot, publicationId) => (
                this.resolveNavigationObservationToken(canonicalRoot, publicationId)
            ),
            resolvePublicationCollectionName: (codebasePath, publicationId) => (
                this.resolvePublicationCollectionName(codebasePath, publicationId)
            ),
            setIndexProfileForCodebase: (codebasePath, profile) => this.setIndexProfileForCodebase(codebasePath, profile),
            subtractEmbeddingMetrics: (after, before) => subtractEmbeddingMetrics(after, before),
            subtractVectorWriteMetrics: (after, before) => subtractVectorWriteMetrics(after, before),
            summarizeVectorWriteMetrics: (metrics, logicalRows) => summarizeVectorWriteMetrics(metrics, logicalRows),
            getSynchronizerForPublication: (synchronizerKey, publicationId) => (
                this.synchronizerRegistry.getSynchronizerForPublication(synchronizerKey, publicationId)
            ),
            registerSynchronizerForPublication: (synchronizerKey, publicationId, synchronizer) => (
                this.synchronizerRegistry.registerSynchronizerForPublication(
                    synchronizerKey,
                    publicationId,
                    synchronizer,
                )
            ),
            getSynchronizerMutationTarget: (synchronizerKey) => (
                this.synchronizerRegistry.getMutationTarget(synchronizerKey)
            ),
            setSynchronizerMutationTarget: (synchronizerKey, collectionName) => (
                this.synchronizerRegistry.setMutationTarget(synchronizerKey, collectionName)
            ),
            clearSynchronizerMutationTarget: (synchronizerKey) => (
                this.synchronizerRegistry.clearMutationTarget(synchronizerKey)
            ),
            vectorDatabase: this.vectorDatabase,
            buildIndexPolicyHash: (codebasePath) => this.buildIndexPolicyHash(codebasePath),
            readIndexableFileObservationInsideRoot: (absoluteFile, canonicalRoot, indexPolicy) => (
                this.readIndexableFileObservationInsideRoot(absoluteFile, canonicalRoot, indexPolicy)
            ),
            languageAnalyzer: this.languageAnalyzer,
            semanticAnalyzer,
            resolutionAnalyzer,
        });

        this.indexingPipeline = new IndexingPipeline({
            getVectorDatabase: () => this.vectorDatabase,
            languageAnalyzer: this.languageAnalyzer,
            semanticAnalyzer,
            getEmbedding: () => this.embedding,
            assertEmbeddingIdentityCurrent: () => this.assertEmbeddingIdentityCurrent(),
            isHybridEnabled: () => this.getIsHybrid(),
            canonicalizeCodebasePath: (codebasePath) => (
                this.canonicalizeCodebasePath(codebasePath)
            ),
            normalizeRelativePathForCodebase: (codebasePath, filePath) => (
                this.normalizeRelativePathForCodebase(codebasePath, filePath)
            ),
            getIndexedExtensionsForCodebase: (codebasePath) => (
                this.getIndexedExtensionsForCodebase(codebasePath)
            ),
            matchesIgnorePattern: (filePath, codebasePath, isDirectory, matcher) => (
                this.matchesIgnorePattern(filePath, codebasePath, isDirectory, matcher)
            ),
            getSymbolExtractorVersion: () => this.getSymbolExtractorVersion(),
        });

        this.semanticSearchService = new SemanticSearchService({
            getVectorDatabase: () => this.vectorDatabase,
            embeddingAccess: {
                getEmbedding: () => this.embedding,
                assertEmbeddingIdentityCurrent: () => this.assertEmbeddingIdentityCurrent(),
            },
            authority: {
                acquireCurrentRead: (codebasePath) => this.acquireCurrentPublicationRead(codebasePath),
                isReadAdmitted: (publication) => this.isPublicationReadAdmitted(publication),
            },
            isHybridEnabled: () => this.getIsHybrid(),
            canonicalizeCodebasePath: (codebasePath) => (
                this.canonicalizeCodebasePath(codebasePath)
            ),
        });
        console.log(`[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.ignoreRuleService.getBasePatterns().length} base ignore patterns`);
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
        this.indexPolicyRuntimeService.loadCurrentPublicationPolicy(canonicalRoot);
        const profile = this.indexPolicyRuntimeService.getIndexProfile(canonicalRoot) || 'default';
        return this.indexPolicyRuntimeService.buildSupportedExtensions(profile, canonicalRoot);
    }

    loadIndexProfileForCodebase(codebasePath: string): SatoriRepoConfig {
        const config = loadSatoriRepoConfig(codebasePath);
        this.setIndexProfileForCodebase(codebasePath, config.profile);
        return config;
    }

    setIndexProfileForCodebase(codebasePath: string, profile: IndexProfile): void {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.indexPolicyRuntimeService.setIndexProfileForCodebase(canonicalRoot, profile);
        this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
    }

    /**
     * Get effective ignore patterns.
     * When codebasePath is provided, returns per-codebase effective rules.
     * Without a codebase path, returns global base+runtime layers only.
     */
    getActiveIgnorePatterns(codebasePath?: string): string[] {
        return this.ignoreRuleService.getActivePatterns(codebasePath);
    }

    /**
     * Get synchronizers map
     */
    getActiveSynchronizers(): Map<string, FileSynchronizer> {
        return this.synchronizerRegistry.getActiveSynchronizers();
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
     * Recreate synchronizer for a codebase using currently active ignore patterns.
     * This is used when ignore rules change and we need deterministic reconciliation.
     */
    async recreateSynchronizerForCodebase(
        codebasePath: string,
        options: { requireAuthorityCheckpoint?: boolean } = {},
    ): Promise<void> {
        return this.rootMutationRuntime.run(codebasePath, 'sync', () => (
            this.synchronizerRegistry.recreateSynchronizerForCodebase(
                codebasePath,
                () => this.rootMutationRuntime.assertCurrent(codebasePath),
                options,
            )
        ));
    }

    /**
     * Return currently tracked (indexable under active ignore rules) relative paths
     * from the active synchronizer snapshot for this codebase.
     */
    getTrackedRelativePaths(codebasePath: string): string[] {
        const collectionName = this.resolveCollectionName(codebasePath);
        const synchronizer = this.synchronizerRegistry.getSynchronizer(collectionName);
        if (!synchronizer) {
            return [];
        }
        return this.normalizeRelativePathsForCodebase(codebasePath, synchronizer.getTrackedRelativePaths());
    }

    hasSynchronizerForCodebase(codebasePath: string): boolean {
        return this.synchronizerRegistry.hasSynchronizerForCodebase(codebasePath);
    }

    async inspectSourceFreshnessCheckpoint(
        codebasePath: string,
        publication?: PublicationRef,
    ): Promise<ProvenSourceFreshnessCheckpointEvidence> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        if (publication && publication.publication.canonicalRoot !== canonicalRoot) {
            return {
                status: 'corrupt',
                message: 'The Publication source checkpoint address does not belong to this root.',
            };
        }
        try {
            const ref = publication ?? this.publicationStore.getCurrent(canonicalRoot);
            if (!ref) {
                return {
                    status: 'missing',
                    message: 'No Publication source checkpoint exists.',
                };
            }
            const checkpoint = this.publicationStore.getSourceCheckpoint(canonicalRoot, ref.id);
            if (!checkpoint) {
                return {
                    status: 'missing',
                    message: `Publication '${ref.id}' is missing source.json.`,
                };
            }
            return {
                status: 'valid',
                publicationId: ref.id,
                observationToken: ref.id,
            };
        } catch (error) {
            return {
                status: 'corrupt',
                message: `Publication source checkpoint is invalid: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    getCurrentPublicationSourceObservation(codebasePath: string): string | null {
        return this.publicationStore.getCurrent(codebasePath)?.id ?? null;
    }

    private getPublicationSourceSynchronizer(
        canonicalRoot: string,
        publication?: PublicationRef,
    ): {
        synchronizer: FileSynchronizer;
        publicationId: string;
    } | null {
        const ref = publication ?? this.publicationStore.getCurrent(canonicalRoot);
        if (!ref || ref.publication.canonicalRoot !== canonicalRoot) return null;
        const checkpoint = this.publicationStore.getSourceCheckpoint(canonicalRoot, ref.id);
        if (!checkpoint) return null;
        return {
            synchronizer: new FileSynchronizer(
                canonicalRoot,
                [...ref.publication.policy.effectiveIgnorePatterns],
                [...ref.publication.policy.supportedExtensions],
                { sourceCheckpoint: checkpoint },
            ),
            publicationId: ref.id,
        };
    }

    /**
     * Compare explicit dirty paths with the source checkpoint owned by the
     * proven active publication. The checkpoint may be loaded into runtime
     * memory, but no source checkpoint or publication state is advanced.
     */
    async compareSourcePathsToFreshnessCheckpoint(
        codebasePath: string,
        relativePaths: readonly string[],
        publication?: PublicationRef,
    ): Promise<SourceFreshnessPathComparison> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const checkpoint = await this.inspectSourceFreshnessCheckpoint(canonicalRoot, publication);
        if (checkpoint.status !== 'valid') {
            return { status: 'unavailable' };
        }
        const source = this.getPublicationSourceSynchronizer(canonicalRoot, publication);
        if (!source || source.publicationId !== checkpoint.publicationId) {
            return { status: 'unavailable' };
        }
        const comparison = await source.synchronizer.comparePathsToOwnedCheckpoint(relativePaths);
        if (comparison.status !== 'matches') {
            return comparison;
        }
        if (!publication && this.publicationStore.getCurrent(canonicalRoot)?.id !== checkpoint.publicationId) {
            return { status: 'unavailable' };
        }
        return comparison;
    }

    /**
     * Compare the complete searchable source tree with the checkpoint owned by
     * the proven active publication. This is a read-only request barrier.
     */
    async compareAllSourceToFreshnessCheckpoint(
        codebasePath: string,
        publication?: PublicationRef,
    ): Promise<SourceFreshnessPathComparison> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const checkpoint = await this.inspectSourceFreshnessCheckpoint(canonicalRoot, publication);
        if (checkpoint.status !== 'valid') {
            return { status: 'unavailable' };
        }
        const source = this.getPublicationSourceSynchronizer(canonicalRoot, publication);
        if (!source || source.publicationId !== checkpoint.publicationId) {
            return { status: 'unavailable' };
        }
        const comparison = await source.synchronizer.compareAllSourceToOwnedCheckpoint();
        if (comparison.status !== 'matches') {
            return comparison;
        }
        if (!publication && this.publicationStore.getCurrent(canonicalRoot)?.id !== checkpoint.publicationId) {
            return { status: 'unavailable' };
        }
        return comparison;
    }

    /**
     * Compare the current searchable source observation with the checkpoint
     * owned by the proven active publication. The synchronizer reuses sealed
     * hashes for paths whose size, mtime, and ctime are unchanged and hashes
     * every path whose observation changed.
     */
    async compareSourceObservationToFreshnessCheckpoint(
        codebasePath: string,
        publication?: PublicationRef,
    ): Promise<SourceFreshnessPathComparison> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const checkpoint = await this.inspectSourceFreshnessCheckpoint(canonicalRoot, publication);
        if (checkpoint.status !== 'valid') {
            return { status: 'unavailable' };
        }
        const source = this.getPublicationSourceSynchronizer(canonicalRoot, publication);
        if (!source || source.publicationId !== checkpoint.publicationId) {
            return { status: 'unavailable' };
        }
        const comparison = await source.synchronizer.compareSourceObservationToOwnedCheckpoint();
        if (comparison.status !== 'matches') {
            return comparison;
        }
        if (!publication && this.publicationStore.getCurrent(canonicalRoot)?.id !== checkpoint.publicationId) {
            return { status: 'unavailable' };
        }
        return comparison;
    }

    /**
     * Delete indexed chunks for a list of relative paths in a codebase.
     * Returns the number of file paths processed for deletion.
     */
    async deleteIndexedPathsByRelativePaths(
        codebasePath: string,
        relativePaths: string[],
    ): Promise<number> {
        return this.rootMutationRuntime.run(codebasePath, 'sync', async () => {
            const collectionName = await this.getActiveIndexedCollectionName(codebasePath);
            if (!collectionName) {
                throw new Error(`Cannot delete indexed paths for '${codebasePath}' without a current Publication.`);
            }
            const uniquePaths = Array.from(new Set(this.normalizeRelativePathsForCodebase(codebasePath, relativePaths)));

            for (const relativePath of uniquePaths) {
                await this.deleteFileChunks(
                    collectionName,
                    relativePath,
                    () => this.rootMutationRuntime.assertCurrent(codebasePath),
                );
            }
            return uniquePaths.length;
        });
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
        const canonicalPath = this.canonicalizeCodebasePath(codebasePath);
        return resolveCollectionFamilyName(this.getIsHybrid(), canonicalPath);
    }

    private async countIndexedPayloadExactly(
        collectionName: string,
        filter: VectorFilter | undefined,
        expectedMaximum?: number,
    ): Promise<number | null> {
        if (typeof this.vectorDatabase.countDocuments === 'function') {
            return this.vectorDatabase.countDocuments(collectionName, filter);
        }

        const maximumExactQueryRows = 16384;
        const limit = expectedMaximum === undefined
            ? maximumExactQueryRows
            : expectedMaximum + 1;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumExactQueryRows) {
            return null;
        }
        const rows = await this.vectorDatabase.queryDocuments(collectionName, {
            filter,
            fields: ['id'],
            limit,
        });
        if (expectedMaximum === undefined && rows.length === maximumExactQueryRows) {
            return null;
        }
        return rows.length;
    }

    private buildPublicationFormat(): Publication['format'] {
        const embeddingIdentity = this.assertEmbeddingIdentityCurrent();
        return Object.freeze({
            indexFormatVersion: JSON.stringify({
                vectorSchemaVersion: this.getIsHybrid() === true ? 'hybrid_v3' : 'dense_v3',
                vectorStoreProvider: this.vectorStoreProvider,
                parserVersion: LANGUAGE_PARSER_VERSION,
                extractorVersion: SYMBOL_EXTRACTOR_VERSION,
                embeddingProjectionVersion: EMBEDDING_PROJECTION_VERSION,
                lexicalProjectionVersion: LEXICAL_PROJECTION_VERSION,
                packageOwnershipVersion: PACKAGE_OWNERSHIP_SCHEMA_VERSION,
            }),
            embeddingIdentity: JSON.stringify({
                provider: embeddingIdentity.provider,
                model: embeddingIdentity.model,
                dimension: embeddingIdentity.dimension,
                artifactDigest: embeddingIdentity.artifactDigest,
                normalizationPolicy: embeddingIdentity.normalizationPolicy,
            }),
            relationshipVersion: this.getRelationshipVersion(),
        });
    }

    private isPublicationFormatCurrent(publication: Publication): boolean {
        const current = this.buildPublicationFormat();
        return publication.format.indexFormatVersion === current.indexFormatVersion
            && publication.format.embeddingIdentity === current.embeddingIdentity
            && publication.format.relationshipVersion === current.relationshipVersion;
    }

    private resolvedPolicyMatchesPublication(
        policy: ResolvedIndexPolicy,
        publicationRef: PublicationRef,
    ): boolean {
        const accepted = publicationRef.publication.policy;
        const same = (left: readonly string[], right: readonly string[]) => (
            left.length === right.length && left.every((value, index) => value === right[index])
        );
        return policy.canonicalRoot === publicationRef.publication.canonicalRoot
            && policy.profile === accepted.profile
            && same(policy.customExtensions, accepted.customExtensions)
            && same(policy.customIgnorePatterns, accepted.customIgnorePatterns)
            && same(policy.fileBasedIgnorePatterns, accepted.fileBasedIgnorePatterns)
            && same(policy.supportedExtensions, accepted.supportedExtensions)
            && same(policy.effectiveIgnorePatterns, accepted.effectiveIgnorePatterns)
            && policy.policyHash === accepted.policyHash
            && policy.controlSignature === accepted.controlSignature;
    }

    private resolvePublicationCollectionName(codebasePath: string, publicationId: string): string {
        return resolvePublicationCollectionName(this.resolveCollectionName(codebasePath), publicationId);
    }

    public async getActiveIndexedCollectionName(codebasePath: string): Promise<string | null> {
        return this.getCurrentPublication(codebasePath)?.publication.vector.collectionName ?? null;
    }

    public getCurrentPublication(codebasePath: string): PublicationRef | null {
        return this.publicationStore.getCurrent(this.canonicalizeCodebasePath(codebasePath));
    }

    public listCurrentPublications(): PublicationRef[] {
        return this.publicationStore.listCurrent();
    }

    public getPublicationSourceCheckpoint(publication: PublicationRef): PublicationSourceCheckpoint | null {
        return this.publicationStore.getSourceCheckpoint(
            publication.publication.canonicalRoot,
            publication.id,
        );
    }

    public getPublicationPackageOwnership(publication: PublicationRef): PublicationPackageOwnership | null {
        return this.publicationStore.getPackageOwnership(
            publication.publication.canonicalRoot,
            publication.id,
        );
    }

    private async hasValidPublicationPackageOwnership(publication: PublicationRef): Promise<boolean> {
        try {
            const ownership = this.getPublicationPackageOwnership(publication);
            const checkpoint = this.getPublicationSourceCheckpoint(publication);
            if (!ownership || !checkpoint || !publication.publication.packageOwnership) return false;
            if (
                computePublicationPackageOwnershipDigest(ownership)
                !== publication.publication.packageOwnership.digest
            ) {
                return false;
            }

            const sourceHashes = new Map(checkpoint.fileHashes);
            const controlPaths = new Set<string>();
            for (const [controlPath, expectedHash] of ownership.controlFiles) {
                if (sourceHashes.get(controlPath) !== expectedHash) return false;
                controlPaths.add(controlPath);
            }

            if (
                ownership.workspace?.kind === 'pnpm'
                && sourceHashes.has('package.json')
                && !ownership.packages.some((pkg) => pkg.root === '')
            ) {
                return false;
            }

            if (ownership.files.length !== publication.publication.vector.indexedFiles) {
                return false;
            }
            const ownershipPaths = new Set(ownership.files.map((file) => file.path));
            for (const filePath of ownershipPaths) {
                if (!sourceHashes.has(filePath) || controlPaths.has(filePath)) {
                    return false;
                }
            }

            if (publication.publication.status === 'complete') {
                const navigation = this.getPublicationNavigationAddress(publication);
                if (!navigation) return false;
                const registry = await readSymbolRegistrySidecar({
                    normalizedRootPath: publication.publication.canonicalRoot,
                    publicationId: navigation.publicationId,
                    navigationRoot: navigation.navigationRoot,
                });
                if (
                    registry.status !== 'ok'
                    || registry.registry.manifest.files.length !== ownershipPaths.size
                    || registry.registry.manifest.files.some((file) => !ownershipPaths.has(file.path))
                ) {
                    return false;
                }
            }

            return true;
        } catch {
            return false;
        }
    }

    public acquireCurrentPublicationRead(codebasePath: string): PublicationLease | null {
        return this.publicationStore.acquireCurrentRead(this.canonicalizeCodebasePath(codebasePath));
    }

    public acquirePublicationRead(codebasePath: string, publicationId: string): PublicationLease | null {
        return this.publicationStore.acquireRead(
            this.canonicalizeCodebasePath(codebasePath),
            publicationId,
        );
    }

    public async isPublicationReadAdmitted(publication: PublicationRef): Promise<boolean> {
        const canonicalRoot = this.canonicalizeCodebasePath(publication.publication.canonicalRoot);
        return canonicalRoot === publication.publication.canonicalRoot
            && publication.id === publication.publication.id
            && this.isPublicationFormatCurrent(publication.publication)
            && await this.hasValidPublicationPackageOwnership(publication)
            && await computeIndexPolicyControlSignature(canonicalRoot)
                === publication.publication.policy.controlSignature;
    }

    public getPublicationNavigationAddress(publication: PublicationRef): {
        publicationId: string;
        navigationRoot: string;
    } | null {
        const canonicalRoot = this.canonicalizeCodebasePath(publication.publication.canonicalRoot);
        const navigation = this.publicationStore.getNavigation(canonicalRoot, publication.id);
        return navigation
            ? { publicationId: navigation.ref.id, navigationRoot: navigation.rootPath }
            : null;
    }

    public async getPublicationNavigationStatus(publication: PublicationRef): Promise<PublicationNavigationStatus> {
        if (!publication.publication.navigation) return 'not_bound';
        const navigation = this.getPublicationNavigationAddress(publication);
        if (!navigation) return 'missing';
        const registry = await readSymbolRegistrySidecar({
            normalizedRootPath: publication.publication.canonicalRoot,
            publicationId: navigation.publicationId,
            navigationRoot: navigation.navigationRoot,
        });
        if (registry.status !== 'ok') return registry.status;
        const relationships = await readRelationshipSidecar({
            normalizedRootPath: publication.publication.canonicalRoot,
            publicationId: navigation.publicationId,
            navigationRoot: navigation.navigationRoot,
            expectedSymbolRegistryManifestHash: registry.manifestHash,
        });
        return relationships.status === 'ok' ? 'valid' : relationships.status;
    }

    public async getCurrentPublicationCollectionName(codebasePath: string): Promise<string | null> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.publicationStore.getCurrent(canonicalRoot)?.publication.vector.collectionName ?? null;
    }

    /** Lightweight current-selection validation. Ordinary reads acquire their own lease separately. */
    async getCurrentPublicationForValidation(codebasePath: string): Promise<PublicationValidationEvidence> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const publication = this.publicationStore.getCurrent(canonicalRoot);
        if (!publication) return { status: 'missing' };
        if (
            !this.isPublicationFormatCurrent(publication.publication)
            || !await this.hasValidPublicationPackageOwnership(publication)
        ) {
            return { status: 'requires_reindex' };
        }

        try {
            this.refreshRuntimePolicyAuthority(canonicalRoot);
        } catch (error) {
            if (error instanceof IndexPolicyAuthorityError) return { status: 'policy_authority_invalid' };
            throw error;
        }
        if (this.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true) {
            return { status: 'runtime_policy_incompatible' };
        }
        if (!await this.isPublicationReadAdmitted(publication)) {
            return { status: 'runtime_policy_incompatible' };
        }
        return {
            status: 'valid',
            publication,
            navigationStatus: await this.getPublicationNavigationStatus(publication),
        };
    }

    async hasIndexedCollection(codebasePath: string): Promise<boolean> {
        const publication = this.getCurrentPublication(codebasePath);
        return publication !== null
            && this.isPublicationFormatCurrent(publication.publication)
            && await this.hasValidPublicationPackageOwnership(publication)
            && await this.vectorDatabase.hasCollection(publication.publication.vector.collectionName);
    }

    public async collectPublicationGarbage(codebasePath: string): Promise<string[]> {
        return this.rootMutationRuntime.run(codebasePath, 'gc', async () => {
            const lease = getCurrentRootMutationLease(this.rootMutationRuntime, codebasePath);
            return this.collectPublicationGarbageWithLease(codebasePath, lease);
        });
    }

    private async collectPublicationGarbageWithLease(
        codebasePath: string,
        lease: import('../generation/root-mutation-coordinator').RootMutationLease,
    ): Promise<string[]> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.publicationStore.collectGarbage(
            canonicalRoot,
            lease,
            (collectionName, assertMutationCurrent) => (
                deleteCollectionWithVerification(this.vectorDatabase, collectionName, {
                    beforeDropAttempt: assertMutationCurrent,
                }).then(() => undefined)
            ),
        );
    }

    /**
     * Build and publish a complete codebase generation for semantic search.
     * Full candidate construction and activation are Core-owned. Callers may
     * only defer publication of a partial candidate when preserving a previous
     * complete generation.
     * @param codebasePath Codebase root path
     * @param progressCallback Optional progress callback function
     * @param forceReindex Whether to recreate the collection even if it exists
     * @returns Indexing statistics
     */

    private async deleteFileChunks(
        collectionName: string,
        relativePath: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const results = await this.vectorDatabase.queryDocuments(collectionName, {
            filter: { kind: 'comparison', field: 'relativePath', operator: 'eq', value: relativePath },
            fields: ['id'],
        });

        if (results.length > 0) {
            const ids = results.map(r => r.id as string).filter(id => id);
            if (ids.length > 0) {
                assertMutationCurrent?.();
                await this.vectorDatabase.deleteDocuments(collectionName, ids);
                console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
            }
        }
    }
    async semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResult[]>;
    async semanticSearch(codebasePath: string, query: string, topK?: number, threshold?: number, filter?: VectorFilter): Promise<SemanticSearchResult[]>;
    async semanticSearch(
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filter?: VectorFilter,
    ): Promise<SemanticSearchResult[]> {
        return this.semanticSearchService.search(
            requestOrCodebasePath,
            query,
            topK,
            threshold,
            filter,
        );
    }

    public async semanticSearchInPublication(
        publication: PublicationRef,
        request: SemanticSearchRequest,
    ): Promise<SemanticSearchResult[]> {
        return this.semanticSearchService.searchInPublication(publication, request);
    }

    public async semanticSearchWithCandidateTraceInPublication(
        publication: PublicationRef,
        request: SemanticSearchRequest,
        maxEntriesPerStage: number,
        options: SemanticSearchCandidateTraceOptions = {},
    ): Promise<SemanticSearchExecutionResult> {
        return this.semanticSearchService.searchWithCandidateTraceInPublication(
            publication,
            request,
            maxEntriesPerStage,
            options,
        );
    }

    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
    ): Promise<void> {
        return this.rootMutationRuntime.run(codebasePath, 'clear', async () => {
            const lease = getCurrentRootMutationLease(this.rootMutationRuntime, codebasePath);
            return this.indexTeardownWorkflow.clearIndex(codebasePath, progressCallback, {
                rootMutationLease: lease,
                assertMutationCurrent: () => this.rootMutationRuntime.assertCurrent(codebasePath),
            });
        });
    }

    /**
     * Update base ignore patterns (replace semantics, then rebuild effective set).
     * @param ignorePatterns Array of base ignore patterns
     */
    updateIgnorePatterns(ignorePatterns: string[]): void {
        this.ignoreRuleService.setBasePatterns([
            ...DEFAULT_IGNORE_PATTERNS,
            ...ignorePatterns,
        ]);
        this.recomputeAllPublishedPolicyRuntimeCompatibility();
        console.log(`[Context] 🚫 Updated base ignore patterns. Base total: ${this.ignoreRuleService.getBasePatterns().length}`);
    }

    async resolveIndexPolicyForReindex(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ObservedResolvedIndexPolicy> {
        return this.indexPolicyRuntimeService.resolveIndexPolicyForReindex(codebasePath, update);
    }

    async observeIndexPolicyForIncrementalReconciliation(
        codebasePath: string,
    ): Promise<ObservedResolvedIndexPolicy> {
        return this.indexPolicyRuntimeService.observeIndexPolicyForIncrementalReconciliation(codebasePath);
    }

    async isObservedIndexPolicyControlSignatureCurrent(
        policy: ObservedResolvedIndexPolicy,
    ): Promise<boolean> {
        return this.indexPolicyRuntimeService.isObservedIndexPolicyControlSignatureCurrent(policy);
    }

    activateObservedIndexPolicyForIncrementalReconciliation(
        policy: ObservedResolvedIndexPolicy,
    ): boolean {
        return this.indexPolicyRuntimeService.activateObservedIndexPolicyForIncrementalReconciliation(policy);
    }

    /**
     * Read-only runtime compatibility view (integration oracle; state owned by
     * IndexPolicyRuntimeService).
     */
    get policyRuntimeCompatibilityByCodebase(): ReadonlyMap<string, boolean> {
        return this.indexPolicyRuntimeService.getPolicyRuntimeCompatibilityByCodebase();
    }

    private recomputePublishedPolicyRuntimeCompatibility(canonicalRoot: string): void {
        this.indexPolicyRuntimeService.recomputePolicyRuntimeCompatibility(
            canonicalRoot,
            this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot),
        );
    }

    private refreshRuntimePolicyAuthority(canonicalRoot: string): void {
        this.indexPolicyRuntimeService.loadCurrentPublicationPolicy(canonicalRoot);
        this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
    }

    private recomputeAllPublishedPolicyRuntimeCompatibility(): void {
        for (const canonicalRoot of this.indexAuthorityCoordinator.publishedResolvedPolicyRoots()) {
            this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
        }
    }

    /**
     * Reset ignore patterns to defaults only
     */
    resetIgnorePatternsToDefaults(): void {
        this.ignoreRuleService.setBasePatterns(DEFAULT_IGNORE_PATTERNS);
        this.recomputeAllPublishedPolicyRuntimeCompatibility();
        console.log(`[Context] 🔄 Reset ignore patterns to defaults: ${this.ignoreRuleService.getBasePatterns().length} patterns`);
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

    private normalizeRelativePathForCodebase(
        codebasePath: string,
        candidatePath: string,
    ): RepositoryRelativePath | null {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const canonicalRelativePath = canonicalizeRepositoryRelativePath(canonicalRoot, candidatePath);
        if (canonicalRelativePath) return canonicalRelativePath;

        // A scanned path may use the caller's symlinked root while canonicalRoot
        // names its real target. Retry against that resolved spelling only.
        const resolvedRoot = this.trimTrailingSeparators(path.normalize(path.resolve(codebasePath)));
        return resolvedRoot === canonicalRoot
            ? null
            : canonicalizeRepositoryRelativePath(resolvedRoot, candidatePath);
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
        const identity = resolveValidatedEmbeddingIdentity(embedding);
        this.embedding = embedding;
        this.indexGenerationWorkflow.refreshEmbedding(embedding);
        this.embeddingIdentity = identity;
        console.log(`[Context] 🔄 Updated embedding provider: ${embedding.getProvider()}`);
    }

    private assertEmbeddingIdentityCurrent(): Readonly<EmbeddingIdentity> {
        const current = resolveValidatedEmbeddingIdentity(this.embedding);
        const expected = this.embeddingIdentity;
        if (
            current.provider !== expected.provider
            || current.model !== expected.model
            || current.dimension !== expected.dimension
            || current.artifactDigest !== expected.artifactDigest
            || current.normalizationPolicy !== expected.normalizationPolicy
        ) {
            throw new Error('Embedding identity changed after it was installed into Context. Install a new embedding explicitly before continuing.');
        }
        return expected;
    }

    /**
     * Update vector database instance
     * @param vectorDatabase New vector database instance
     */
    updateVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.vectorDatabase = vectorDatabase;
        this.indexGenerationWorkflow.refreshVectorDatabase(vectorDatabase);
        this.vectorStoreProvider = vectorDatabase.getBackendInfo?.().provider === 'lancedb'
            ? 'LanceDB'
            : 'Milvus';
        console.log(`[Context] 🔄 Updated vector database`);
    }

    /**
     * Prepare vector collection
     */
    private async prepareCollection(
        codebasePath: string,
        forceReindex: boolean,
        assertMutationCurrent: (() => void) | undefined,
        collectionName: string,
    ): Promise<void> {
        // Identity drift must fail before a valid published collection is
        // dropped or an exact Publication candidate is otherwise mutated.
        const embeddingIdentity = this.assertEmbeddingIdentityCurrent();
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);

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
        this.assertEmbeddingIdentityCurrent();
        if (dimension !== embeddingIdentity.dimension) {
            throw new Error(`Detected embedding dimension ${dimension} does not match installed identity dimension ${embeddingIdentity.dimension}.`);
        }
        console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);
        const dirName = path.basename(codebasePath);

        if (isHybrid === true) {
            assertMutationCurrent?.();
            await this.vectorDatabase.createHybridCollection(
                collectionName,
                dimension,
                `Hybrid Index for ${dirName}`,
                { deferIndexBuild: this.vectorDatabase.finalizeCollectionForSearch !== undefined },
            );
        } else {
            assertMutationCurrent?.();
            await this.vectorDatabase.createCollection(collectionName, dimension, `Index for ${dirName}`);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);
    }
    private async getCodeFiles(
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<string[]> {
        return this.indexingPipeline.getCodeFiles(codebasePath, indexPolicy);
    }

    private async readIndexableFileObservationInsideRoot(
        filePath: string,
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<{ content: string; sourceHash: string; sourceStat: SnapshotFileStatSignature } | null> {
        return this.indexingPipeline.readIndexableFileObservationInsideRoot(
            filePath,
            codebasePath,
            indexPolicy,
        );
    }

    private async readIndexableFileInsideRoot(
        filePath: string,
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<string | null> {
        return this.indexingPipeline.readIndexableFileInsideRoot(
            filePath,
            codebasePath,
            indexPolicy,
        );
    }

    private async analyzeIndexedFile(
        filePath: string,
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<AnalyzedIndexedFile | null> {
        return this.indexingPipeline.analyzeIndexedFile(
            filePath,
            codebasePath,
            indexPolicy,
        );
    }

    private buildAnalyzedFileSymbolFacts(
        analyzed: AnalyzedIndexedFile,
    ): AnalyzedFileSymbolFacts {
        return this.indexingPipeline.buildAnalyzedFileSymbolFacts(analyzed);
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
        onFileProcessed: ((filePath: string, fileIndex: number, totalFiles: number) => void) | undefined,
        collectionName: string,
        assertMutationCurrent?: () => void,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<ProcessedFileList> {
        return this.indexingPipeline.processFileList({
            filePaths,
            codebasePath,
            collectionName,
            ...(onFileProcessed ? { onFileProcessed } : {}),
            ...(assertMutationCurrent ? { assertMutationCurrent } : {}),
            ...(indexPolicy ? { indexPolicy } : {}),
        });
    }

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
        return this.indexingPipeline.getExpectedChunksAndSymbols(
            filePaths,
            codebasePath,
            indexPolicy,
        );
    }

    private getSymbolExtractorVersion(): string {
        return SYMBOL_EXTRACTOR_VERSION;
    }

    private getLanguageRouterVersion(): string {
        return 'language-router-v2';
    }


    private getRelationshipVersion(): string {
        return RELATIONSHIP_BUILDER_VERSION;
    }

    private buildIndexPolicyHash(codebasePath: string): string {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.indexPolicyRuntimeService.loadCurrentPublicationPolicy(canonicalRoot);
        const publishedPolicy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        if (publishedPolicy) {
            return publishedPolicy.policyHash;
        }
        const profile = this.indexPolicyRuntimeService.getIndexProfile(canonicalRoot) || 'default';
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

    async resolveIndexPolicyForCodebase(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ObservedResolvedIndexPolicy> {
        return this.indexGenerationWorkflow.resolveIndexPolicyForCodebase(codebasePath, update);
    }

    public async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false,
        options: MutationGuardOptions = {},
    ): Promise<IndexCodebaseResult> {
        return this.rootMutationRuntime.run(
            codebasePath,
            forceReindex ? 'reindex' : 'create',
            async () => {
                const lease = getCurrentRootMutationLease(this.rootMutationRuntime, codebasePath);
                return this.indexGenerationWorkflow.indexCodebase(
                    codebasePath,
                    progressCallback,
                    {
                        ...options,
                        rootMutationLease: lease,
                        assertMutationCurrent: () => this.rootMutationRuntime.assertCurrent(codebasePath),
                    },
                );
            },
        );
    }

    public async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: ReindexByChangeOptions = {}
    ): Promise<ReindexByChangeResult> {
        return this.rootMutationRuntime.run(codebasePath, 'sync', async () => {
            const lease = getCurrentRootMutationLease(this.rootMutationRuntime, codebasePath);
            return this.indexGenerationWorkflow.reindexByChange(codebasePath, progressCallback, {
                ...options,
                rootMutationLease: lease,
                assertMutationCurrent: () => this.rootMutationRuntime.assertCurrent(codebasePath),
            });
        });
    }

    private async processChunkBatch(
        chunkEntries: ProjectedChunkEntry[],
        codebasePath: string,
        collectionName: string,
        assertMutationCurrent?: () => void,
        performance?: IndexingPipelineMetrics,
    ): Promise<void> {
        return this.indexingPipeline.processChunkBatch(
            chunkEntries,
            codebasePath,
            collectionName,
            assertMutationCurrent,
            performance,
        );
    }

    static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
        return readIgnorePatternsFile(filePath);
    }

    private async loadIgnorePatterns(codebasePath: string): Promise<void> {
        return this.ignoreRuleService.loadIgnorePatterns(codebasePath);
    }

    private matchesIgnorePattern(
        filePath: string,
        codebasePath: string,
        isDirectory: boolean = false,
        matcherOverride?: ReturnType<typeof ignore>,
    ): boolean {
        return this.ignoreRuleService.matchesIgnorePattern(
            filePath,
            codebasePath,
            isDirectory,
            matcherOverride,
        );
    }

    public getPublicationNavigation(
        codebasePath: string,
        publicationId: string,
    ): { publicationId: string; navigationRoot: string } | null {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const resource = this.publicationStore.getNavigation(canonicalRoot, publicationId);
        return resource
            ? { publicationId: resource.ref.id, navigationRoot: resource.rootPath }
            : null;
    }

    private resolveNavigationObservationToken(
        canonicalRoot: string,
        publicationId: string,
    ): string | null {
        const observation = this.resolveNavigationObservation(canonicalRoot, publicationId);
        return observation.status === 'valid' ? observation.token : null;
    }

    private resolveNavigationObservation(
        canonicalRoot: string,
        publicationId: string,
    ): { status: 'valid'; token: string } | { status: 'missing' | 'incompatible' | 'corrupt' } {
        const resource = this.getPublicationNavigation(canonicalRoot, publicationId);
        if (!resource) return { status: 'missing' };
        const navigationRoot = resource.navigationRoot;
        const navigationRootToken = this.resolveFilesystemObservationToken(navigationRoot);
        const symbolRegistryManifestToken = this.resolveFilesystemObservationToken(
            path.join(navigationRoot, 'manifest.json'),
        );
        const symbolIndexToken = this.resolveFilesystemObservationToken(
            path.join(navigationRoot, 'symbols', 'index.json'),
        );
        const relationshipManifestToken = this.resolveFilesystemObservationToken(
            path.join(navigationRoot, 'relationships', 'manifest.json'),
        );
        const symbolsDirectoryToken = this.resolveFilesystemObservationToken(path.join(navigationRoot, 'symbols'));
        const relationshipsDirectoryToken = this.resolveFilesystemObservationToken(path.join(navigationRoot, 'relationships'));
        const symbolShardDirectoryToken = this.resolveFilesystemObservationToken(path.join(navigationRoot, 'symbols', 'by-file'));
        const relationshipShardDirectoryToken = this.resolveFilesystemObservationToken(path.join(navigationRoot, 'relationships', 'by-file'));
        if (
            !navigationRootToken
            || !symbolRegistryManifestToken
            || !symbolIndexToken
            || !relationshipManifestToken
            || !symbolsDirectoryToken
            || !relationshipsDirectoryToken
            || !symbolShardDirectoryToken
            || !relationshipShardDirectoryToken
        ) return { status: 'missing' };
        return { status: 'valid', token: JSON.stringify({
            publicationId,
            navigationRootToken,
            symbolRegistryManifestToken,
            symbolIndexToken,
            relationshipManifestToken,
            symbolsDirectoryToken,
            relationshipsDirectoryToken,
            symbolShardDirectoryToken,
            relationshipShardDirectoryToken,
        }) };
    }

    private resolveFilesystemObservationToken(targetPath: string): string | null {
        try {
            const stat = fs.statSync(targetPath, { bigint: true });
            return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
                .map((value) => value.toString())
                .join(':');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    private clearResolvedIndexPolicyRuntime(canonicalRoot: string): void {
        this.indexPolicyRuntimeService.clearResolvedIndexPolicyRuntime(canonicalRoot);
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

    /**
     * Dispose managed background runtime workers and resources.
     */
    public dispose(): Promise<void> {
        if (!this.disposePromise) {
            this.disposePromise = Promise.all([
                Promise.resolve(this.semanticAnalyzer?.dispose?.()),
                Promise.resolve(this.resolutionAnalyzer?.dispose?.()),
            ]).then(() => undefined);
        }
        return this.disposePromise;
    }
}
