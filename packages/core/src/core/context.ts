import {
    Embedding,
    OpenAIEmbedding,
    resolveValidatedEmbeddingIdentity,
    type EmbeddingIdentity,
    type EmbeddingOperationMetricsSnapshot,
} from '../embedding';
import {
    VectorDatabase,
    VectorControlRecord,
    VectorFilter,
    IndexCompletionFingerprint,
    IndexCompletionMarkerDocument,
    INDEX_COMPLETION_MARKER_DOC_ID,
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
    getSupportedExtensionsForIndexProfile,
} from '../config/defaults';
import {
    normalizeSupportedExtensions,
} from '../config/index-policy';
import {
    loadSatoriRepoConfig,
    SATORI_REPO_CONFIG_FILENAME,
    SatoriRepoConfigAuthorityError,
    SatoriRepoConfig,
} from '../config/repo-config';
import {
    importNavigationToSqlite,
    resolveNavigationSqlitePath,
} from '../navigation';
import {
    RetiredNavigationPointerError,
    UnsupportedNavigationPointerError,
    clearSymbolRegistrySidecar,
    computeNavigationGenerationSealHash,
    parseNavigationGenerationSeal,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveCurrentNavigationGeneration,
    resolveNavigationSidecarRoot,
    discardNavigationSidecarGeneration,
    publishNavigationSidecarGeneration,
} from '../symbols';

import type {
    RelationshipRecord,
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
    type LanguageAnalysisPort,
} from '../language-analysis';
import {
    canonicalizeRepositoryRelativePath,
    type RepositoryRelativePath,
} from '../paths/repository-path';
import {
    type RelationshipAnalysisEvidence,
} from '../relationships';

import { ThreadedWasmSemanticProjectAnalyzer, type SemanticProjectAnalyzer, type SemanticSourceFile } from '../semantic';

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import ignore from 'ignore';
import {
    FileSynchronizer,
    type PreparedFileChangeSet,
    type SourceFreshnessPathComparison,
} from '../sync/synchronizer';
import { SynchronizerRegistry } from '../sync/synchronizer-registry';
import {
    createSourceFreshnessPort,
    type ProvenSourceFreshnessCheckpointEvidence,
    type SourceFreshnessPort,
} from '../sync/source-freshness-port';
export type { ProvenSourceFreshnessCheckpointEvidence } from '../sync/source-freshness-port';

import type {
    CustomIndexPolicyUpdate,
    DurableIndexAuthoritySnapshot,
    IndexCodebaseResult,
    IndexPolicyPublicationReceipt,
    NavigationGenerationProof,
    ObservedResolvedIndexPolicy,
    PreparedIndexCollectionBinding,
    PreparedIndexCollectionReceipt,
    ProvenGenerationReceipt,
    ProvenVectorGenerationReceipt,
} from '../generation/contracts';

export type {
    CustomIndexPolicyUpdate,
    DurableIndexAuthoritySnapshot,
    IndexCodebaseResult,
    IndexPolicyPublicationReceipt,
    NavigationGenerationProof,
    ObservedResolvedIndexPolicy,
    PreparedIndexCollectionBinding,
    PreparedIndexCollectionReceipt,
    ProvenGenerationReceipt,
    ProvenVectorGenerationReceipt,
} from '../generation/contracts';
export {
    AtomicIncrementalPublicationUnsupportedError,
    IndexPolicyPublicationError,
} from '../generation/errors';
import { createIndexMutationPort, type IndexMutationPort } from './index-mutation-port';
import type {
    RepairIndexResult,
    RepairProof,
    RepairSnapshotEvidence,
} from './repair-proof';
import {
    inspectCompletionMarker,
    type CanonicalPolicyNavigationBinding,
    type CanonicalPublicationBinding,
} from './persisted-index-authority';
import {
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
} from './search-projections';
import {
    SemanticSearchService,
    type MutationGenerationObserver,
} from './semantic-search-service';
import {
    IndexingPipeline,
    type AnalyzedFileSymbolFacts,
    type AnalyzedIndexedFile,
    type ExpectedIndexedChunk,
    type IndexingPipelineMetrics,
    type ProcessedFileList,
    type ProjectedChunkEntry,
} from './indexing-pipeline';
import { IndexPolicyMutationCoordinator } from './index-policy-mutation-coordinator';
import {
    DurableAuthorityRestoreTransactionMechanics,
    type DurableAuthorityMutationOwner,
    type DurableAuthorityRecoveryPublisher,
} from '../generation/restore-transaction';
import {
    IndexAuthorityCoordinator,
    createGenerationProofCoordinator,
    type CachedGenerationProof,
    type GenerationProofCoordinator,
    type PublicationRetentionQueue,
} from '../generation/index-authority-coordinator';
import { IndexGenerationWorkflow } from '../generation/index-generation-workflow';
import { IndexTeardownWorkflow } from '../generation/index-teardown-workflow';

export {
    createGenerationProofCoordinator,
    type GenerationProofCoordinator,
} from '../generation/index-authority-coordinator';

import { IndexPolicyDocumentStore } from '../policy/index-policy-document-store';
import {
    IgnoreRuleService,
    getCustomExtensionsFromEnvironment,
    getCustomIgnorePatternsFromEnvironment,
    readIgnorePatternsFile,
} from './ignore-rule-service';
import {
    GENERATION_COLLECTION_SEPARATOR,
    belongsToCollectionFamily,
    isStagedGenerationCollectionName,
    resolveActiveCollectionFamilyName,
    resolveAlternateCollectionFamilyName,
    resolveStagedCollectionName,
} from './collection-naming';
import { listRelatedCollectionNames } from './collection-family-listing';
import {
    computeIndexPolicyControlSignature,
    observeIndexPolicyInputs,
} from './index-policy-input-observer';
import {
    IndexPolicyAuthorityError,
    IndexFormatRequiresReindexError,
    IndexPolicyRuntimeService,
    UnsupportedIndexAuthorityError,
    computeIndexPolicyHash,
    type IndexPolicyRuntimeBinding,
} from '../policy/index-policy-runtime-service';
import type { ResolvedIndexPolicy } from '../policy/index-policy-runtime-service';
export type { ResolvedIndexPolicy } from '../policy/index-policy-runtime-service';
export type {
    DurableAuthorityMutationOwner,
    DurableAuthorityRecoveryPublisher,
    DurableIndexAuthorityArtifact,
} from '../generation/restore-transaction';

export type {
    MutationGenerationObservation,
    MutationGenerationObserver,
} from './semantic-search-service';

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
    symbolRegistryStateRoot?: string;
    indexPolicyStateRoot?: string;
    durableAuthorityRecoveryPublisher?: DurableAuthorityRecoveryPublisher;
    /** Required when hybrid reads can overlap externally coordinated mutations. */
    mutationGenerationObserver?: MutationGenerationObserver;
    generationProofCoordinator?: GenerationProofCoordinator;
    semanticAnalyzer?: SemanticProjectAnalyzer;
}

type IndexPolicyBinding = IndexPolicyRuntimeBinding;

function policyNavigationBindingFromMarker(
    navigation: IndexCompletionMarkerDocument['navigation'],
): CanonicalPolicyNavigationBinding {
    return navigation.status === 'sealed'
        ? {
            status: 'sealed',
            generationId: navigation.generationId,
            sealHash: navigation.sealHash,
        }
        : { status: 'not_bound' };
}

function policyNavigationBindingsEqual(
    left: CanonicalPolicyNavigationBinding,
    right: CanonicalPolicyNavigationBinding,
): boolean {
    return left.status === right.status
        && (left.status === 'not_bound'
            || (
                right.status === 'sealed'
                && left.generationId === right.generationId
                && left.sealHash === right.sealHash
            ));
}

function publicationBindingsEqual(
    left: CanonicalPublicationBinding | undefined,
    right: CanonicalPublicationBinding | undefined,
): boolean {
    return left === undefined
        ? right === undefined
        : right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export type CompletionMarkerValidationEvidence =
    | {
        status: 'valid_v3';
        collectionName: string;
        marker: IndexCompletionMarkerDocument;
        vectorReceipt: ProvenVectorGenerationReceipt;
        navigationProof: NavigationGenerationProof;
        generationReceipt?: ProvenGenerationReceipt;
        exactPayloadRecounts: 0 | 1;
        proofSource: 'activation' | 'exact' | 'joined' | 'reused';
    }
    | { status: 'invalid_v3' }
    | { status: 'requires_reindex' }
    | { status: 'unsupported_authority' }
    | { status: 'policy_authority_invalid' }
    | { status: 'runtime_policy_incompatible' }
    | { status: 'missing' };

export type PreparedGenerationRevalidation = {
    vectorReceipt: ProvenVectorGenerationReceipt;
    navigationProof: NavigationGenerationProof;
    generationReceipt?: ProvenGenerationReceipt;
};

export type IndexAuthorityObservations = {
    vector: string;
    navigation: string;
};

type DurableIndexAuthorityRestoreResult =
    | { status: 'restored_current' }
    | { status: 'restored_requires_reindex' }
    | { status: 'restored_unsupported_authority' };

type RepairIndexOptions = {
    snapshotEvidence?: RepairSnapshotEvidence;
    preferredCollectionName?: string;
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
    onProofUpdate?: (proof: RepairProof) => void;
    publicationAuthority?: DurableAuthorityMutationOwner;
};


type ReindexByChangeOptions = {
    targetCollectionName?: string;
    maintainCompletionMarker?: boolean;
    externallyManagedPublication?: boolean;
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
    publicationAuthority?: DurableAuthorityMutationOwner;
    sourceGenerationReceipt?: ProvenGenerationReceipt;
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
            | 'publication_activation'
            | 'publication_retention_proof',
        durationMs: number,
    ) => void;
};

type MutationGuardOptions = {
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
    deferFullIndexPublication?: boolean;
    indexPolicy?: ResolvedIndexPolicy;
    preparedCollectionReceipt?: PreparedIndexCollectionReceipt;
    preparedCollectionBinding?: PreparedIndexCollectionBinding;
    writeCollectionName?: string;
    preparedChanges?: PreparedFileChangeSet;
};

type StagedCollectionPruneOptions = {
    assertMutationCurrent?: () => void;
    discardUnprovenPayload?: boolean;
};

/**
 * Staged hybrid collections are schema-only until finalize. Probing them for
 * markers or payload can fail with backend index-missing errors instead of an
 * empty result set. Those failures are generation state, not prune transport
 * failures.
 *
 * Keep this matcher narrow: only known Milvus/Zilliz index-absence codes/phrases.
 * Do not treat generic "not found" or collection-missing errors as unsearchable.
 */
function isUnsearchableStagedCollectionError(error: unknown): boolean {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    const collect = (value: unknown): void => {
        if (value === null || value === undefined || seen.has(value)) {
            return;
        }
        seen.add(value);
        if (typeof value === 'string') {
            messages.push(value);
            return;
        }
        if (value instanceof Error) {
            messages.push(value.name, value.message);
            collect((value as Error & { cause?: unknown }).cause);
            return;
        }
        if (typeof value === 'object') {
            const record = value as Record<string, unknown>;
            for (const key of ['message', 'reason', 'error_code', 'code', 'errorCode']) {
                collect(record[key]);
            }
        }
    };
    collect(error);
    const joined = messages.join(' ');
    return /IndexNotExist/i.test(joined)
        || /index not found\[collection=/i.test(joined)
        || /index does not exist/i.test(joined);
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
    generationReceipt?: ProvenGenerationReceipt;
};

type CollectionPayloadVerification =
    | { ok: true; indexedFiles: number; totalChunks: number }
    | { ok: false; message: string };



type VectorGenerationProofResult = {
    receipt: ProvenVectorGenerationReceipt | null;
    exactPayloadRecounts: 0 | 1;
    source: 'activation' | 'exact' | 'joined' | 'reused';
};


type CachedNavigationDeltaState = {
    readonly canonicalRoot: string;
    readonly generationId: string;
    readonly symbolRegistryManifestHash: string;
    readonly relationshipManifestHash: string;
    readonly navigationSealHash: string;
    readonly navigationObservationToken?: string;
    readonly registry: SymbolRegistry;
    readonly records: readonly RelationshipRecord[];
    readonly analysisByFile: Map<string, RelationshipAnalysisEvidence>;
};



export class Context {
    private embedding: Embedding;
    private embeddingIdentity: Readonly<EmbeddingIdentity>;
    private vectorDatabase: VectorDatabase;
    private readonly languageAnalyzer: LanguageAnalysisPort;
    private supportedExtensions: string[];
    private readonly indexPolicyRuntimeService: IndexPolicyRuntimeService;
    private readonly indexPolicyStateRoot: string;
    private readonly indexPolicyMutationCoordinator: IndexPolicyMutationCoordinator;
    private readonly indexPolicyDocumentStore: IndexPolicyDocumentStore;
    private readonly restoreTransactionMechanics: DurableAuthorityRestoreTransactionMechanics;
    private readonly synchronizerRegistry = new SynchronizerRegistry({
        canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
        getActiveIgnorePatterns: (codebasePath) => this.getActiveIgnorePatterns(codebasePath),
        getIndexedExtensionsForCodebase: (codebasePath) => this.getIndexedExtensionsForCodebase(codebasePath),
        getIsHybrid: () => this.getIsHybrid(),
        indexCompletionMarkersEqual: (left, right) => this.indexCompletionMarkersEqual(left, right),
        loadIndexProfileForCodebase: (codebasePath) => this.loadIndexProfileForCodebase(codebasePath),
        proveIndexedGeneration: (codebasePath) => this.proveIndexedGeneration(codebasePath),
        resolveCollectionName: (codebasePath) => this.resolveCollectionName(codebasePath),
    });

    private sourceFreshnessPort: SourceFreshnessPort | null = null;
    private indexMutationPort: IndexMutationPort | null = null;
    private get publicationRetentionQueues(): PublicationRetentionQueue {
        return this.indexAuthorityCoordinator.publicationRetentionQueues;
    }

    private readonly indexAuthorityCoordinator: IndexAuthorityCoordinator;
    private indexGenerationWorkflow: IndexGenerationWorkflow;
    private readonly indexTeardownWorkflow: IndexTeardownWorkflow;
    // Derived warm-path state only. The durable generation remains authoritative,
    // and a restart or generation mismatch returns to exact sidecar validation.
    // Compatibility-only state for the frozen setter. New mutation callers pass
    // the target through their operation options instead of consulting this map.
    private readonly legacyWriteCollectionOverrides = new Map<string, string>();
    private symbolRegistryStateRoot?: string;
    private readonly semanticSearchService: SemanticSearchService<ProvenVectorGenerationReceipt>;
    private readonly indexingPipeline: IndexingPipeline;
    private readonly ignoreRuleService: IgnoreRuleService;
    private readonly semanticAnalyzer?: SemanticProjectAnalyzer;
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

        this.languageAnalyzer = config.languageAnalyzer || createLanguageAnalysisService({
            chunkSize: 2500,
            chunkOverlap: 300,
        });

        // Load custom extensions from environment variables
        const envCustomExtensions = getCustomExtensionsFromEnvironment();

        this.indexPolicyRuntimeService = new IndexPolicyRuntimeService({
            configuredExtensionOverlays: normalizeSupportedExtensions([
                ...(config.supportedExtensions || []),
                ...(config.customExtensions || []),
                ...envCustomExtensions
            ]),
            getIgnoreRuleService: () => this.ignoreRuleService,
            canonicalizeCodebasePath: (codebasePath) => (
                this.canonicalizeCodebasePath(codebasePath)
            ),
            resolvePolicyPath: (canonicalRoot) => (
                this.indexPolicyMutationCoordinator.resolvePolicyPath(canonicalRoot)
            ),
            resolveFilesystemObservationToken: (targetPath) => (
                this.resolveFilesystemObservationToken(targetPath)
            ),
            onActivateResolvedIndexPolicy: (policy, binding) => (
                this.indexAuthorityCoordinator.activatePublishedIndexPolicy(policy, binding)
            ),
            onClearPublishedIndexPolicy: (canonicalRoot) => (
                this.indexAuthorityCoordinator.clearPublishedIndexPolicyRuntime(canonicalRoot)
            ),
        });
        this.supportedExtensions = this.indexPolicyRuntimeService.buildSupportedExtensions('default');



        // Load custom ignore patterns from environment variables
        const envCustomIgnorePatterns = getCustomIgnorePatternsFromEnvironment();

        // Base ignore patterns (defaults + static config + env)
        const allIgnorePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...envCustomIgnorePatterns
        ];
        this.indexPolicyStateRoot = config.indexPolicyStateRoot
            ?? path.join(
                process.env.SATORI_STATE_ROOT || path.join(os.homedir(), '.satori'),
                'index-policy',
            );
        this.indexPolicyMutationCoordinator = new IndexPolicyMutationCoordinator({
            stateRoot: this.indexPolicyStateRoot,
            verifyPolicyDocumentDigest: (policyPath) => (
                this.indexPolicyRuntimeService.resolveVerifiedIndexPolicyDocumentDigest(policyPath)
            ),
        });
        this.indexPolicyDocumentStore = new IndexPolicyDocumentStore({
            mutationCoordinator: this.indexPolicyMutationCoordinator,
            verifyPolicyDocumentDigest: (policyPath) => (
                this.indexPolicyRuntimeService.resolveVerifiedIndexPolicyDocumentDigest(policyPath)
            ),
            fsyncPath: (targetPath) => this.fsyncPath(targetPath),
        });
        this.symbolRegistryStateRoot = config.symbolRegistryStateRoot;
        this.restoreTransactionMechanics = new DurableAuthorityRestoreTransactionMechanics({
            indexPolicyStateRoot: this.indexPolicyStateRoot,
            canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
            resolvePolicyPath: (canonicalRoot) => (
                this.indexPolicyDocumentStore.resolvePolicyPath(canonicalRoot)
            ),
            resolveNavigationPointerPath: (canonicalRoot) => (
                path.join(resolveNavigationSidecarRoot(this.symbolRegistryStateRoot, canonicalRoot), 'current.json')
            ),
            withMutationLock: (canonicalRoot, operation) => (
                this.indexPolicyMutationCoordinator.withLock(canonicalRoot, operation)
            ),
        });
        this.ignoreRuleService = new IgnoreRuleService({

            basePatterns: allIgnorePatterns,
            canonicalizeCodebasePath: (codebasePath) => (
                this.canonicalizeCodebasePath(codebasePath)
            ),
            resolveCollectionName: (codebasePath) => (
                this.resolveCollectionName(codebasePath)
            ),
            ensureRuntimePolicyLoaded: (canonicalRoot) => (
                this.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot)
            ),
        });
        this.indexAuthorityCoordinator = new IndexAuthorityCoordinator(
            config.generationProofCoordinator ?? createGenerationProofCoordinator(),
            {
                canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
                clearResolvedIndexPolicyRuntime: (canonicalRoot) => this.clearResolvedIndexPolicyRuntime(canonicalRoot),
                fsyncPath: (targetPath) => this.fsyncPath(targetPath),
                indexPolicyDocumentStore: {
                    captureDocument: (canonicalRoot) => this.indexPolicyDocumentStore.captureDocument(canonicalRoot),
                    resolvePolicyPath: (canonicalRoot) => this.indexPolicyDocumentStore.resolvePolicyPath(canonicalRoot),
                    persistDocument: (canonicalRoot, document, onCommitted) => (
                        this.indexPolicyDocumentStore.persistDocument(canonicalRoot, document, onCommitted)
                    ),
                    removeDocument: (canonicalRoot, expectedDocumentDigest, onCommitted) => (
                        this.indexPolicyDocumentStore.removeDocument(
                            canonicalRoot,
                            expectedDocumentDigest,
                            onCommitted,
                        )
                    ),
                },
                indexPolicyMutationCoordinator: {
                    withLock: (canonicalRoot, operation) => this.indexPolicyMutationCoordinator.withLock(canonicalRoot, operation),
                },
                indexPolicyRuntimeService: {
                    deletePolicyFileToken: (canonicalRoot) => this.indexPolicyRuntimeService.deletePolicyFileToken(canonicalRoot),
                    getPolicyFileToken: (canonicalRoot) => this.indexPolicyRuntimeService.getPolicyFileToken(canonicalRoot),
                    getPolicyDocumentDigest: (canonicalRoot) => this.indexPolicyRuntimeService.getPolicyDocumentDigest(canonicalRoot),
                    getPolicyRuntimeCompatibility: (canonicalRoot) => this.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot),
                    resolveCustomIndexPolicyFileToken: (canonicalRoot) => this.indexPolicyRuntimeService.resolveCustomIndexPolicyFileToken(canonicalRoot),
                    captureRuntimePolicyState: (canonicalRoot) => this.indexPolicyRuntimeService.captureRuntimePolicyState(canonicalRoot),
                    restoreRuntimePolicyState: (canonicalRoot, previousRuntimeState) => (
                        this.indexPolicyRuntimeService.restoreRuntimePolicyState(canonicalRoot, previousRuntimeState)
                    ),
                    activateResolvedIndexPolicy: (policy, binding) => (
                        this.indexPolicyRuntimeService.activateResolvedIndexPolicy(policy, binding)
                    ),
                    clearResolvedIndexPolicyRuntime: (canonicalRoot) => (
                        this.indexPolicyRuntimeService.clearResolvedIndexPolicyRuntime(canonicalRoot)
                    ),
                    setPolicyFileToken: (canonicalRoot, token) => this.indexPolicyRuntimeService.setPolicyFileToken(canonicalRoot, token),
                    setPolicyDocumentDigest: (canonicalRoot, digest) => (
                        this.indexPolicyRuntimeService.setPolicyDocumentDigest(canonicalRoot, digest)
                    ),
                },
                refreshRuntimePolicyAuthority: (canonicalRoot) => this.refreshRuntimePolicyAuthority(canonicalRoot),
                restoreTransactionMechanics: this.restoreTransactionMechanics,
                symbolRegistryStateRoot: this.symbolRegistryStateRoot,
                getRelationshipVersion: () => this.getRelationshipVersion(),
                buildIndexCompletionFingerprint: () => this.buildIndexCompletionFingerprint(),
                listRelatedCollectionNames: (canonicalRoot) => this.listRelatedCollectionNames(canonicalRoot),
                vectorDatabase: {
                    getCollectionDataObservation: this.vectorDatabase.getCollectionDataObservation
                        ? (collectionName) => this.vectorDatabase.getCollectionDataObservation!(collectionName)
                        : undefined,
                    getPublicationObservation: this.vectorDatabase.getPublicationObservation
                        ? (collectionName) => this.vectorDatabase.getPublicationObservation!(collectionName)
                        : undefined,
                    dropCollection: (collectionName) => this.vectorDatabase.dropCollection(collectionName),
                    hasCollection: (collectionName) => this.vectorDatabase.hasCollection(collectionName),
                },
                resolveCompletionMarkerForCollection: (canonicalRoot, collectionName) => (
                    this.resolveCompletionMarkerForCollection(canonicalRoot, collectionName)
                ),
                resolveNavigationObservation: (canonicalRoot, generationId, requireCurrentPointer) => (
                    this.resolveNavigationObservation(canonicalRoot, generationId, requireCurrentPointer)
                ),
                resolveNavigationObservationToken: (canonicalRoot, generationId, strict) => (
                    this.resolveNavigationObservationToken(canonicalRoot, generationId, strict)
                ),
                resolveRepoConfigObservationToken: (canonicalRoot) => this.resolveRepoConfigObservationToken(canonicalRoot),
                resolveProvenGeneration: (canonicalRoot) => this.resolveProvenGeneration(canonicalRoot),
            },
        );
        this.indexTeardownWorkflow = new IndexTeardownWorkflow({
            canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
            indexPolicyMutationCoordinator: {
                withLockAsync: (canonicalRoot, operation) => (
                    this.indexPolicyMutationCoordinator.withLockAsync(canonicalRoot, operation)
                ),
            },
            indexPolicyDocumentStore: {
                recoverTombstonesWhileLocked: (canonicalRoot) => (
                    this.indexPolicyDocumentStore.recoverTombstonesWhileLocked(canonicalRoot)
                ),
                deleteDocumentWhileLocked: (canonicalRoot) => (
                    this.indexPolicyDocumentStore.deleteDocumentWhileLocked(canonicalRoot)
                ),
            },
            listRelatedCollectionNames: (codebasePath) => this.listRelatedCollectionNames(codebasePath),
            deleteCollectionWithVerification: (collectionName, options) => (
                deleteCollectionWithVerification(this.vectorDatabase, collectionName, options).then(() => undefined)
            ),
            clearResolvedIndexPolicyRuntime: (canonicalRoot) => (
                this.indexPolicyRuntimeService.clearResolvedIndexPolicyRuntime(canonicalRoot)
            ),
            setPolicyFileToken: (canonicalRoot, token) => this.indexPolicyRuntimeService.setPolicyFileToken(canonicalRoot, token),
            clearSymbolRegistryForCodebase: (codebasePath, assertMutationCurrent, publishMutation) => (
                this.clearSymbolRegistryForCodebase(codebasePath, assertMutationCurrent, publishMutation)
            ),
            deleteSnapshot: (codebasePath) => FileSynchronizer.deleteSnapshot(codebasePath),
            resolveCollectionName: (codebasePath) => this.resolveCollectionName(codebasePath),
            clearSynchronizerForCollection: (collectionName) => (
                this.synchronizerRegistry.clearSynchronizerForCollection(collectionName)
            ),
            deleteIgnoreCodebaseState: (codebasePath) => this.ignoreRuleService.deleteCodebaseState(codebasePath),
            deleteIndexProfile: (canonicalRoot) => this.indexPolicyRuntimeService.deleteIndexProfile(canonicalRoot),
            clearLegacyWriteCollectionOverride: (canonicalRoot) => {
                this.legacyWriteCollectionOverrides.delete(canonicalRoot);
            },
        });

        const semanticAnalyzer = config.semanticAnalyzer ?? new ThreadedWasmSemanticProjectAnalyzer();
        this.semanticAnalyzer = semanticAnalyzer;

        this.indexGenerationWorkflow = new IndexGenerationWorkflow({
            acceptPreparedSourceGenerationReceipt: (canonicalRoot, receipt) => (

                this.acceptPreparedSourceGenerationReceipt(canonicalRoot, receipt)
            ),
            assertResolvedIndexPolicyRoot: (codebasePath, policy) => (
                this.assertResolvedIndexPolicyRoot(codebasePath, policy)
            ),
            buildCollectionFamilies: (codebasePath) => this.buildCollectionFamilies(codebasePath),
            buildIndexCompletionFingerprint: () => this.buildIndexCompletionFingerprint(),
            buildRootFingerprint: (canonicalRoot) => this.buildRootFingerprint(canonicalRoot),
            canonicalizeCodebasePath: (codebasePath) => this.canonicalizeCodebasePath(codebasePath),
            clearIndexCompletionMarkerFromCollection: (collectionName, assertMutationCurrent) => (
                this.clearIndexCompletionMarkerFromCollection(collectionName, assertMutationCurrent)
            ),
            clearSymbolRegistryForCodebase: (codebasePath, assertMutationCurrent, publishMutation) => (
                this.clearSymbolRegistryForCodebase(codebasePath, assertMutationCurrent, publishMutation)
            ),
            cloneIndexCompletionMarker: (marker) => this.indexAuthorityCoordinator.cloneIndexCompletionMarker(marker),
            countIndexedPayloadExactly: (collectionName, filter, expectedMaximum) => (
                this.countIndexedPayloadExactly(collectionName, filter, expectedMaximum)
            ),
            deleteFileChunks: (collectionName, relativePath, assertMutationCurrent) => (
                this.deleteFileChunks(collectionName, relativePath, assertMutationCurrent)
            ),
            embedding: this.embedding,
            ensureNavigationArtifactsReadyForMarkerRefresh: (codebasePath, assertMutationCurrent, publishMutation) => (
                this.ensureNavigationArtifactsReadyForMarkerRefresh(codebasePath, assertMutationCurrent, publishMutation)
            ),
            getActiveIgnorePatterns: (codebasePath) => this.getActiveIgnorePatterns(codebasePath),
            getActiveIndexedCollectionName: (codebasePath) => this.getActiveIndexedCollectionName(codebasePath),
            getCodeFiles: (codebasePath, indexPolicy) => this.getCodeFiles(codebasePath, indexPolicy),
            getExpectedChunksAndSymbols: (filePaths, codebasePath, indexPolicy) => (
                this.getExpectedChunksAndSymbols(filePaths, codebasePath, indexPolicy)
            ),
            getIndexedExtensionsForCodebase: (codebasePath) => this.getIndexedExtensionsForCodebase(codebasePath),
            getIsHybrid: () => this.getIsHybrid(),
            getLanguageRouterVersion: () => this.getLanguageRouterVersion(),
            getRelationshipVersion: () => this.getRelationshipVersion(),
            getSymbolExtractorVersion: () => this.getSymbolExtractorVersion(),
            indexAuthorityCoordinator: this.indexAuthorityCoordinator,
            indexCompletionMarkersEqual: (left, right) => this.indexCompletionMarkersEqual(left, right),
            indexPolicyRuntimeService: this.indexPolicyRuntimeService,
            listRelatedCollectionNames: (codebasePath) => this.listRelatedCollectionNames(codebasePath),
            loadIgnorePatterns: (codebasePath) => this.loadIgnorePatterns(codebasePath),
            loadIndexProfileForCodebase: (codebasePath) => this.loadIndexProfileForCodebase(codebasePath),
            normalizeRelativePathForCodebase: (codebasePath, candidatePath) => (
                this.normalizeRelativePathForCodebase(codebasePath, candidatePath)
            ),
            normalizeRelativePathsForCodebase: (codebasePath, relativePaths) => (
                this.normalizeRelativePathsForCodebase(codebasePath, relativePaths)
            ),
            parseCompletionControlRecord: (codebasePath, record) => (
                this.parseCompletionControlRecord(codebasePath, record)
            ),
            policyNavigationBindingFromMarker: (navigation) => policyNavigationBindingFromMarker(navigation),
            policyNavigationBindingsEqual: (left, right) => policyNavigationBindingsEqual(left, right),
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
            proveIndexedGeneration: (codebasePath, priorReceipt) => (
                this.proveIndexedGeneration(codebasePath, priorReceipt)
            ),
            publishNavigationCandidate: (candidate, assertMutationCurrent, publishMutation) => (
                this.publishNavigationCandidate(candidate, assertMutationCurrent, publishMutation)
            ),
            publishResolvedIndexPolicy: (codebasePath, policy, publishMutation) => (
                this.publishResolvedIndexPolicy(codebasePath, policy, publishMutation)
            ),
            rebuildNavigationArtifacts: (codebasePath, assertMutationCurrent, publishMutation) => (
                this.rebuildNavigationArtifacts(codebasePath, assertMutationCurrent, publishMutation)
            ),
            refreshRuntimePolicyAuthority: (canonicalRoot) => this.refreshRuntimePolicyAuthority(canonicalRoot),
            resolveCollectionName: (codebasePath) => this.resolveCollectionName(codebasePath),
            resolveCompletionMarkerForCollection: (codebasePath, collectionName) => (
                this.resolveCompletionMarkerForCollection(codebasePath, collectionName)
            ),
            resolveCompletionProofCollection: (codebasePath) => this.resolveCompletionProofCollection(codebasePath),
            resolveGenerationProofIdentity: (canonicalRoot) => this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot),
            resolveIndexPolicyFromCurrentInputs: (canonicalRoot, update, inheritActiveCustomPolicy, activateRuntimeProfile) => (
                this.resolveIndexPolicyFromCurrentInputs(canonicalRoot, update, inheritActiveCustomPolicy, activateRuntimeProfile)
            ),
            resolveNavigationObservationToken: (canonicalRoot, generationId, requireCurrentPointer) => (
                this.resolveNavigationObservationToken(canonicalRoot, generationId, requireCurrentPointer)
            ),
            resolveStagedCollectionName: (codebasePath, generationId) => (
                this.resolveStagedCollectionName(codebasePath, generationId)
            ),
            setIndexProfileForCodebase: (codebasePath, profile) => this.setIndexProfileForCodebase(codebasePath, profile),
            subtractEmbeddingMetrics: (after, before) => subtractEmbeddingMetrics(after, before),
            subtractVectorWriteMetrics: (after, before) => subtractVectorWriteMetrics(after, before),
            summarizeVectorWriteMetrics: (metrics, logicalRows) => summarizeVectorWriteMetrics(metrics, logicalRows),
            symbolRegistryStateRoot: this.symbolRegistryStateRoot,
            getSynchronizer: (synchronizerKey) => this.synchronizerRegistry.getSynchronizer(synchronizerKey),
            registerSynchronizer: (synchronizerKey, synchronizer) => (
                this.synchronizerRegistry.registerSynchronizer(synchronizerKey, synchronizer)
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
            verifyCollectionPayloadMatchesCurrentSource: (collectionName, codeFiles, expectedChunks) => (
                this.verifyCollectionPayloadMatchesCurrentSource(collectionName, codeFiles, expectedChunks)
            ),
            buildIndexPolicyHash: (codebasePath) => this.buildIndexPolicyHash(codebasePath),
            readIndexableFileInsideRoot: (absoluteFile, canonicalRoot, indexPolicy) => (
                this.readIndexableFileInsideRoot(absoluteFile, canonicalRoot, indexPolicy)
            ),
            languageAnalyzer: this.languageAnalyzer,
            semanticAnalyzer,
            waitForPublicationRetention: (canonicalRoot) => this.waitForPublicationRetention(canonicalRoot),
            writeCompletedIndexMarker: (codebasePath, indexedFiles, totalChunks, collectionName, indexStatus, assertMutationCurrent, navigationCandidate, indexPolicyHash, runId) => (
                this.writeCompletedIndexMarker(codebasePath, indexedFiles, totalChunks, collectionName, indexStatus, assertMutationCurrent, navigationCandidate, indexPolicyHash, runId)
            ),
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
                proveVectorGeneration: (codebasePath) => (
                    this.proveVectorGeneration(codebasePath)
                ),
                revalidateProvenVectorGeneration: (codebasePath, receipt) => (
                    this.revalidateProvenVectorGeneration(codebasePath, receipt)
                ),
                isPreparedReceiptBoundToCurrentAuthority: (codebasePath, receipt) => (
                    this.isPreparedVectorReceiptBoundToCurrentAuthority(codebasePath, receipt)
                ),
            },
            isHybridEnabled: () => this.getIsHybrid(),
            canonicalizeCodebasePath: (codebasePath) => (
                this.canonicalizeCodebasePath(codebasePath)
            ),
            mutationGenerationObserver: config.mutationGenerationObserver,
        });
        this.restoreTransactionMechanics.recoverDurableIndexAuthorityTransactions(config.durableAuthorityRecoveryPublisher);

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
        this.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot);
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
     * Set synchronizer for a collection
     */
    registerSynchronizer(collectionName: string, synchronizer: FileSynchronizer): void {
        this.synchronizerRegistry.registerSynchronizer(collectionName, synchronizer);
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
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        options: { requireAuthorityCheckpoint?: boolean } = {},
    ): Promise<void> {
        return this.synchronizerRegistry.recreateSynchronizerForCodebase(
            codebasePath,
            assertMutationCurrent,
            publishMutation,
            options,
        );
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
        checkpointIdentity?: string,
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<ProvenSourceFreshnessCheckpointEvidence> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const activationReceipt = requestBoundReceipt && 'navigation' in requestBoundReceipt
            ? this.consumeActivationSourceGenerationReceipt(
                canonicalRoot,
                requestBoundReceipt as ProvenGenerationReceipt,
            )
            : null;
        const retainedActiveReceipt = activationReceipt
            ? null
            : this.resolveActiveGenerationDuringRetention(canonicalRoot);
        // Retention can advance a shared backend observation while deleting only
        // inactive generations. Reuse the already-proven active tuple while that
        // owned mutation is live; otherwise join it before deciding whether the
        // backend observation still matches. The exact receipt returned by this
        // runtime's activation is likewise consumed once by the immediate
        // post-sync checkpoint inspection.
        if (!activationReceipt && !retainedActiveReceipt) {
            await this.waitForPublicationRetention(canonicalRoot);
        }
        const trustedGenerationReceipt = activationReceipt ?? retainedActiveReceipt;
        const receipt = trustedGenerationReceipt
            ? this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(trustedGenerationReceipt)
            : requestBoundReceipt
            && this.isPreparedVectorReceiptBoundToCurrentAuthority(canonicalRoot, requestBoundReceipt)
            ? requestBoundReceipt
            : await this.proveVectorGeneration(canonicalRoot);
        const requestedIdentity = checkpointIdentity?.trim();
        if (!receipt || (requestedIdentity && requestedIdentity !== receipt.collectionName)) {
            return {
                status: 'corrupt',
                message: 'Source freshness checkpoint cannot be inspected because no matching authoritative completed generation is available.',
            };
        }
        const generationReceipt = trustedGenerationReceipt ?? await this.resolveGenerationReceipt(
            canonicalRoot,
            receipt,
            undefined,
            true,
        );
        if (!generationReceipt) {
            return {
                status: 'corrupt',
                message: 'Source freshness checkpoint cannot be inspected because its navigation generation is not authoritative.',
            };
        }
        const inspector = new FileSynchronizer(
            codebasePath,
            [],
            [],
            {
                checkpointIdentity: receipt.collectionName,
                checkpointAuthority: {
                    collectionName: receipt.collectionName,
                    markerRunId: receipt.marker.runId,
                    indexPolicyHash: receipt.marker.indexPolicyHash,
                },
            },
        );
        const checkpoint = await inspector.inspectOwnedSnapshot();
        if (checkpoint.status !== 'valid') return checkpoint;
        const preparedReceipt = this.indexAuthorityCoordinator.cloneProvenGenerationReceipt(generationReceipt);
        const preparedIdentity = await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot);
        if (!preparedIdentity) {
            // Backends without a cheap immutable publication observation retain
            // the exact validation above, but cannot safely propagate its proof.
            return checkpoint;
        }
        this.indexAuthorityCoordinator.setPreparedGenerationReceipt(preparedReceipt, preparedIdentity);
        return { ...checkpoint, generationReceipt: preparedReceipt };
    }

    private consumeActivationSourceGenerationReceipt(
        canonicalRoot: string,
        receipt: ProvenGenerationReceipt,
    ): ProvenGenerationReceipt | null {
        const preparedIdentity = this.indexAuthorityCoordinator.getPreparedGenerationReceipt(receipt);
        const cached = this.indexAuthorityCoordinator.getGenerationProof(canonicalRoot);
        if (
            !preparedIdentity
            || !cached
            || cached.source !== 'activation'
            || cached.identity !== preparedIdentity
            || !cached.generationReceipt
            || !cached.navigationArtifactsValidated
            || !this.cachedGenerationProofMatches(canonicalRoot, cached, cached.identity, receipt)
            || receipt.observations.navigationToken
                !== cached.generationReceipt.observations.navigationToken
            || receipt.navigation.generationId
                !== cached.generationReceipt.navigation.generationId
            || receipt.navigation.navigationSealHash
                !== cached.generationReceipt.navigation.navigationSealHash
        ) {
            return null;
        }
        this.indexAuthorityCoordinator.deletePreparedGenerationReceipt(receipt);
        return this.indexAuthorityCoordinator.cloneProvenGenerationReceipt(cached.generationReceipt);
    }

    private resolveActiveGenerationDuringRetention(
        canonicalRoot: string,
    ): ProvenGenerationReceipt | null {
        if (!this.publicationRetentionQueues.has(canonicalRoot)) return null;
        const cached = this.indexAuthorityCoordinator.getGenerationProof(canonicalRoot);
        if (
            !cached
            || cached.source !== 'activation'
            || !cached.generationReceipt
            || !cached.navigationArtifactsValidated
            || !this.isPreparedVectorReceiptBoundToCurrentAuthority(
                canonicalRoot,
                cached.vectorReceipt,
            )
        ) return null;
        return this.indexAuthorityCoordinator.cloneProvenGenerationReceipt(cached.generationReceipt);
    }

    public isPreparedVectorReceiptBoundToCurrentAuthority(
        canonicalRoot: string,
        receipt: ProvenVectorGenerationReceipt,
    ): boolean {
        return this.indexAuthorityCoordinator.isPreparedVectorReceiptBoundToCurrentAuthority(
            canonicalRoot,
            receipt,
        );
    }

    private async acceptPreparedSourceGenerationReceipt(
        canonicalRoot: string,
        receipt: ProvenGenerationReceipt,
    ): Promise<ProvenGenerationReceipt | null> {
        const preparedIdentity = this.indexAuthorityCoordinator.getPreparedGenerationReceipt(receipt);
        if (!preparedIdentity) return null;
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        if (!this.isPreparedVectorReceiptBoundToCurrentAuthority(canonicalRoot, receipt)) return null;
        const policy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        const binding = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        const authority = policy && binding
            ? this.indexAuthorityCoordinator.resolveEffectiveNavigationAuthority(receipt.marker, policy, binding)
            : null;
        if (
            !authority
            || authority.status !== 'sealed'
            || receipt.navigation.generationId !== authority.generationId
            || receipt.navigation.navigationSealHash !== authority.sealHash
        ) return null;
        const currentIdentity = await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot);
        if (currentIdentity !== preparedIdentity) return null;
        return this.indexAuthorityCoordinator.cloneProvenGenerationReceipt(receipt);
    }

    getRegisteredSourceFreshnessCheckpointObservation(codebasePath: string): string | null {
        return this.synchronizerRegistry.getRegisteredSourceFreshnessCheckpointObservation(codebasePath);
    }

    /**
     * Phase 5.1 — narrow read-facing source freshness port (preparation and
     * revalidation), built on the checkpoint-evidence methods.
     */
    getSourceFreshnessPort(): SourceFreshnessPort {
        if (!this.sourceFreshnessPort) {
            this.sourceFreshnessPort = createSourceFreshnessPort({
                inspectSourceFreshnessCheckpoint: (
                    codebasePath,
                    checkpointIdentity,
                    requestBoundReceipt,
                ) => this.inspectSourceFreshnessCheckpoint(
                    codebasePath,
                    checkpointIdentity,
                    requestBoundReceipt,
                ),
                compareSourceObservationToFreshnessCheckpoint: (
                    codebasePath,
                    requestBoundReceipt,
                ) => this.compareSourceObservationToFreshnessCheckpoint(
                    codebasePath,
                    requestBoundReceipt,
                ),
                compareAllSourceToFreshnessCheckpoint: (
                    codebasePath,
                    requestBoundReceipt,
                ) => this.compareAllSourceToFreshnessCheckpoint(
                    codebasePath,
                    requestBoundReceipt,
                ),
                getRegisteredSourceFreshnessCheckpointObservation: (codebasePath) => (
                    this.getRegisteredSourceFreshnessCheckpointObservation(codebasePath)
                ),
            });
        }
        return this.sourceFreshnessPort;
    }

    /**
     * Phase 5.3 — narrow operation-level index mutation/publication port for
     * the MCP indexing coordinator. Wires existing Context operations without
     * exposing raw vector, embedding, or publication capabilities.
     */
    getIndexMutationPort(): IndexMutationPort {
        if (!this.indexMutationPort) {
            this.indexMutationPort = createIndexMutationPort({
                clearIndex: (codebasePath, progressCallback, options) => (
                    this.indexTeardownWorkflow.clearIndex(codebasePath, progressCallback, options)
                ),
                checkCollectionLimit: () => this.getVectorStore().checkCollectionLimit(),
                deleteCollectionWithVerification: (collectionName, options) => (
                    deleteCollectionWithVerification(this.getVectorStore(), collectionName, options)
                ),
                prepareIndexCollection: (codebasePath, binding, assertMutationCurrent) => (
                    this.prepareIndexCollection(codebasePath, binding, assertMutationCurrent)
                ),
                discardPreparedIndexCollection: (receipt) => (
                    this.discardPreparedIndexCollection(receipt)
                ),
                proveVectorGeneration: (codebasePath) => this.proveVectorGeneration(codebasePath),
                proveIndexedGeneration: (codebasePath) => this.proveIndexedGeneration(codebasePath),
                repairIndex: (codebasePath, options) => this.repairIndex(codebasePath, options),
                captureDurableIndexAuthority: (codebasePath) => (
                    this.captureDurableIndexAuthority(codebasePath)
                ),
                restoreDurableIndexAuthority: (snapshot, publishMutation, expectedCurrent, mutationOwner) => (
                    this.restoreDurableIndexAuthority(
                        snapshot,
                        publishMutation,
                        expectedCurrent,
                        mutationOwner,
                    )
                ),
                publishCompletedIndexMarker: (
                    codebasePath,
                    indexedFiles,
                    totalChunks,
                    collectionName,
                    indexStatus,
                    assertMutationCurrent,
                    navigationCandidate,
                    indexPolicyHash,
                    runId,
                ) => this.publishCompletedIndexMarker(
                    codebasePath,
                    indexedFiles,
                    totalChunks,
                    collectionName,
                    indexStatus,
                    assertMutationCurrent,
                    navigationCandidate,
                    indexPolicyHash,
                    runId,
                ),
                publishNavigationCandidate: (candidate, assertMutationCurrent, publishMutation) => (
                    this.publishNavigationCandidate(candidate, assertMutationCurrent, publishMutation)
                ),
                discardNavigationCandidate: (candidate, assertMutationCurrent) => (
                    this.discardNavigationCandidate(candidate, assertMutationCurrent)
                ),
                resolveIndexPolicyForReindex: (codebasePath, update) => (
                    this.resolveIndexPolicyForReindex(codebasePath, update)
                ),
                resolveIndexPolicyForCodebase: (codebasePath, update) => (
                    this.resolveIndexPolicyForCodebase(codebasePath, update)
                ),
                describeEmbeddingProvider: () => ({
                    provider: this.getEmbeddingEngine().getProvider(),
                    dimension: this.getEmbeddingEngine().getDimension(),
                }),
                indexCodebase: (codebasePath, progressCallback, forceReindex, options) => (
                    this.indexCodebase(codebasePath, progressCallback, forceReindex, options)
                ),
                isObservedIndexPolicyControlSignatureCurrent: (policy) => (
                    this.isObservedIndexPolicyControlSignatureCurrent(policy)
                ),
                publishResolvedIndexPolicy: (policy, binding, publishMutation) => (
                    this.publishResolvedIndexPolicy(policy, binding, publishMutation)
                ),
                registerSynchronizer: (collectionName, synchronizer) => (
                    this.registerSynchronizer(collectionName, synchronizer)
                ),
                indexCompletionMarkersEqual: (left, right) => (
                    this.indexCompletionMarkersEqual(left, right)
                ),
            });
        }
        return this.indexMutationPort;
    }

    private async resolveCheckpointComparisonSynchronizer(
        canonicalRoot: string,
        receipt: ProvenGenerationReceipt,
        observationToken: string,
    ): Promise<FileSynchronizer | null> {
        return this.synchronizerRegistry.resolveCheckpointComparisonSynchronizer(
            canonicalRoot,
            receipt,
            observationToken,
        );
    }

    /**
     * Compare explicit dirty paths with the source checkpoint owned by the
     * proven active publication. The checkpoint may be loaded into runtime
     * memory, but no source checkpoint or publication state is advanced.
     */
    async compareSourcePathsToFreshnessCheckpoint(
        codebasePath: string,
        relativePaths: readonly string[],
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SourceFreshnessPathComparison> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const checkpoint = await this.inspectSourceFreshnessCheckpoint(
            canonicalRoot,
            undefined,
            requestBoundReceipt,
        );
        if (checkpoint.status !== 'valid' || !checkpoint.generationReceipt) {
            return { status: 'unavailable' };
        }

        const receipt = checkpoint.generationReceipt;
        const synchronizer = await this.resolveCheckpointComparisonSynchronizer(
            canonicalRoot,
            receipt,
            checkpoint.observationToken,
        );
        if (!synchronizer) {
            return { status: 'unavailable' };
        }

        const comparison = await synchronizer.comparePathsToOwnedCheckpoint(relativePaths);
        if (comparison.status !== 'matches') {
            return comparison;
        }

        const stillCurrent = await this.acceptPreparedSourceGenerationReceipt(
            canonicalRoot,
            receipt,
        );
        if (
            !stillCurrent
            || synchronizer.getOwnedSnapshotObservationToken() !== checkpoint.observationToken
        ) {
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
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SourceFreshnessPathComparison> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const checkpoint = await this.inspectSourceFreshnessCheckpoint(
            canonicalRoot,
            undefined,
            requestBoundReceipt,
        );
        if (checkpoint.status !== 'valid' || !checkpoint.generationReceipt) {
            return { status: 'unavailable' };
        }

        const receipt = checkpoint.generationReceipt;
        const synchronizer = await this.resolveCheckpointComparisonSynchronizer(
            canonicalRoot,
            receipt,
            checkpoint.observationToken,
        );
        if (!synchronizer) {
            return { status: 'unavailable' };
        }

        const comparison = await synchronizer.compareAllSourceToOwnedCheckpoint();
        if (comparison.status !== 'matches') {
            return comparison;
        }

        const stillCurrent = await this.acceptPreparedSourceGenerationReceipt(
            canonicalRoot,
            receipt,
        );
        if (
            !stillCurrent
            || synchronizer.getOwnedSnapshotObservationToken() !== checkpoint.observationToken
        ) {
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
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SourceFreshnessPathComparison> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const checkpoint = await this.inspectSourceFreshnessCheckpoint(
            canonicalRoot,
            undefined,
            requestBoundReceipt,
        );
        if (checkpoint.status !== 'valid' || !checkpoint.generationReceipt) {
            return { status: 'unavailable' };
        }

        const receipt = checkpoint.generationReceipt;
        const synchronizer = await this.resolveCheckpointComparisonSynchronizer(
            canonicalRoot,
            receipt,
            checkpoint.observationToken,
        );
        if (!synchronizer) {
            return { status: 'unavailable' };
        }

        const comparison = await synchronizer.compareSourceObservationToOwnedCheckpoint();
        if (comparison.status !== 'matches') {
            return comparison;
        }

        const stillCurrent = await this.acceptPreparedSourceGenerationReceipt(
            canonicalRoot,
            receipt,
        );
        if (
            !stillCurrent
            || synchronizer.getOwnedSnapshotObservationToken() !== checkpoint.observationToken
        ) {
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
        assertMutationCurrent?: () => void,
    ): Promise<number> {
        const collectionName = await this.getActiveIndexedCollectionName(codebasePath)
            || this.getLegacyWriteCollectionName(codebasePath)
            || this.resolveCollectionName(codebasePath);
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
        const canonicalPath = this.canonicalizeCodebasePath(codebasePath);
        return resolveActiveCollectionFamilyName(this.getIsHybrid(), canonicalPath);
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
        const alternateFamilyName = resolveAlternateCollectionFamilyName(activeFamilyName);
        return {
            canonicalRoot,
            hash,
            activeFamilyName,
            alternateFamilyName,
        };
    }

    private async listRelatedCollectionNames(codebasePath: string): Promise<string[]> {
        const { activeFamilyName, alternateFamilyName } = this.buildCollectionFamilies(codebasePath);
        return listRelatedCollectionNames(
            {
                listCollections: () => this.vectorDatabase.listCollections(),
                hasCollection: (collectionName) => this.vectorDatabase.hasCollection(collectionName),
            },
            activeFamilyName,
            alternateFamilyName,
        );
    }

    private parseCompletionMarker(
        codebasePath: string,
        rawMetadata: unknown
    ): IndexCompletionMarkerDocument | null {
        const decoded = (() => {
            if (typeof rawMetadata === 'string') {
                try {
                    return JSON.parse(rawMetadata) as unknown;
                } catch {
                    return null;
                }
            }
            if (rawMetadata && typeof rawMetadata === 'object') {
                return rawMetadata;
            }
            return null;
        })();
        if (!decoded) return null;
        const inspected = inspectCompletionMarker(decoded);
        if (inspected.status !== 'current') return null;
        const parsed = inspected.value;
        const parsedCodebasePath = this.canonicalizeCodebasePath(parsed.codebasePath);
        const expectedCodebasePath = this.canonicalizeCodebasePath(codebasePath);
        if (parsedCodebasePath !== expectedCodebasePath) return null;
        return { ...parsed, codebasePath: parsedCodebasePath };
    }

    private parseCompletionControlRecord(
        codebasePath: string,
        record: VectorControlRecord,
    ): IndexCompletionMarkerDocument | null {
        if (!this.completionControlRecordKindMatches(record)) {
            return null;
        }
        return this.parseCompletionMarker(codebasePath, record.metadata);
    }

    private completionControlRecordKindMatches(record: VectorControlRecord): boolean {
        return typeof record.metadata.kind === 'string' && record.kind === record.metadata.kind;
    }

    private async resolveCompletionMarkerForCollection(
        codebasePath: string,
        collectionName: string
    ): Promise<IndexCompletionMarkerDocument | null> {
        const record = await this.vectorDatabase.getControl(collectionName, INDEX_COMPLETION_MARKER_DOC_ID);
        return record ? this.parseCompletionControlRecord(codebasePath, record) : null;
    }

    private async collectionHasIndexedPayload(
        collectionName: string,
        marker: IndexCompletionMarkerDocument
    ): Promise<boolean> {
        const count = await this.countIndexedPayloadExactly(collectionName, undefined, marker.totalChunks);
        return count === marker.totalChunks;
    }

    private async countIndexedPayloadExactly(
        collectionName: string,
        filter: VectorFilter | undefined,
        expectedMaximum?: number,
    ): Promise<number | null> {
        if (typeof this.vectorDatabase.countDocuments === 'function') {
            return this.vectorDatabase.countDocuments(collectionName, filter);
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

    private async collectionHasAnyIndexedPayload(collectionName: string): Promise<boolean> {
        const rows = await this.vectorDatabase.queryDocuments(collectionName, { fields: ['id'], limit: 1 });
        return rows.some((row) => typeof row?.id === 'string' && row.id !== INDEX_COMPLETION_MARKER_DOC_ID);
    }

    private buildIndexCompletionFingerprint(): IndexCompletionFingerprint {
        const embeddingIdentity = this.assertEmbeddingIdentityCurrent();
        return {
            embeddingProvider: embeddingIdentity.provider,
            embeddingModel: embeddingIdentity.model,
            embeddingDimension: embeddingIdentity.dimension,
            embeddingArtifactDigest: embeddingIdentity.artifactDigest,
            embeddingNormalizationPolicy: embeddingIdentity.normalizationPolicy,
            vectorStoreProvider: this.vectorStoreProvider,
            schemaVersion: this.getIsHybrid() === true ? 'hybrid_v3' : 'dense_v3',
            parserVersion: LANGUAGE_PARSER_VERSION,
            extractorVersion: SYMBOL_EXTRACTOR_VERSION,
            relationshipVersion: this.getRelationshipVersion(),
            embeddingProjectionVersion: EMBEDDING_PROJECTION_VERSION,
            lexicalProjectionVersion: LEXICAL_PROJECTION_VERSION,
        };
    }

    public indexCompletionMarkersEqual(
        left: IndexCompletionMarkerDocument,
        right: IndexCompletionMarkerDocument,
    ): boolean {
        return this.indexAuthorityCoordinator.indexCompletionMarkersEqual(left, right);
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
        runId: string = crypto.randomUUID(),
    ): Promise<IndexCompletionMarkerDocument> {
        const currentNavigation = indexStatus === 'completed' && !navigationCandidate
            ? await resolveCurrentNavigationGeneration(
                this.symbolRegistryStateRoot,
                this.canonicalizeCodebasePath(codebasePath),
            ).catch(() => null)
            : null;
        const marker: IndexCompletionMarkerDocument = {
            kind: 'satori_index_completion_v3',
            codebasePath: this.canonicalizeCodebasePath(codebasePath),
            fingerprint: this.buildIndexCompletionFingerprint(),
            indexedFiles,
            totalChunks,
            completedAt: new Date().toISOString(),
            runId,
            indexPolicyHash,
            indexStatus,
            navigation: navigationCandidate ? {
                status: 'sealed',
                generationId: navigationCandidate.generationId,
                symbolRegistryManifestHash: navigationCandidate.manifestHash,
                relationshipManifestHash: navigationCandidate.relationshipManifestHash,
                sealHash: navigationCandidate.navigationSealHash,
            } : currentNavigation ? {
                status: 'sealed',
                generationId: currentNavigation.generationId,
                symbolRegistryManifestHash: currentNavigation.symbolRegistryManifestHash,
                relationshipManifestHash: currentNavigation.relationshipManifestHash,
                sealHash: currentNavigation.navigationSealHash,
            } : { status: 'not_bound' },
        };
        await this.writeIndexCompletionMarker(codebasePath, marker, collectionName, assertMutationCurrent);
        return this.indexAuthorityCoordinator.cloneIndexCompletionMarker(marker);
    }

    private async resolveActiveIndexedCollection(
        codebasePath: string
    ): Promise<{ collectionName: string; marker: IndexCompletionMarkerDocument } | null> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        const publishedPolicy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        const policyBinding = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        if (
            !publishedPolicy
            || !policyBinding
            || publishedPolicy.canonicalRoot !== canonicalRoot
            || policyBinding.policyHash !== publishedPolicy.policyHash
            || this.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true
        ) {
            return null;
        }
        const {
            activeFamilyName,
            alternateFamilyName,
        } = this.buildCollectionFamilies(codebasePath);
        const familyCollectionNames = await this.listRelatedCollectionNames(codebasePath);
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
            if (marker.indexPolicyHash !== activePolicyHash) {
                continue;
            }
            if (
                policyBinding.policyHash !== marker.indexPolicyHash
                || policyBinding.collectionName !== collectionName
            ) {
                continue;
            }
            const navigationAuthority = this.indexAuthorityCoordinator.resolveEffectiveNavigationAuthority(
                marker,
                publishedPolicy,
                policyBinding,
            );
            if (!navigationAuthority) continue;
            if (!(await this.collectionHasIndexedPayload(collectionName, marker))) {
                continue;
            }
            if (
                navigationAuthority.status === 'sealed'
                && (await this.indexAuthorityCoordinator.proveEffectiveNavigationAuthority(
                    canonicalRoot,
                    navigationAuthority,
                    navigationAuthority.relationshipOnlyUpgrade,
                )).status !== 'valid'
            ) {
                continue;
            }

            const familyPriority = belongsToCollectionFamily(collectionName, activeFamilyName)
                ? 0
                : belongsToCollectionFamily(collectionName, alternateFamilyName)
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
        return resolveStagedCollectionName(this.resolveCollectionName(codebasePath), generationId);
    }

    private getLegacyWriteCollectionName(codebasePath: string): string | undefined {
        return this.legacyWriteCollectionOverrides.get(this.canonicalizeCodebasePath(codebasePath));
    }

    /**
     * @deprecated Use operation-scoped write targets on index mutation options.
     * This state is retained only for callers of the frozen compatibility API.
     */
    public setWriteCollectionOverride(codebasePath: string, collectionName: string | null): void {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        if (!collectionName || collectionName.trim().length === 0) {
            this.legacyWriteCollectionOverrides.delete(canonicalRoot);
            return;
        }
        this.legacyWriteCollectionOverrides.set(canonicalRoot, collectionName.trim());
    }

    /**
     * Prepare the real staged collection before a background full rebuild is
     * reported as started. The returned object is process-local, one-shot, and
     * bound to the mutation generation so a stale or forged receipt cannot
     * suppress mandatory collection preparation in indexCodebase().
     */
    public async prepareIndexCollection(
        codebasePath: string,
        binding: PreparedIndexCollectionBinding,
        assertMutationCurrent?: () => void,
    ): Promise<PreparedIndexCollectionReceipt> {
        if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
            throw new Error('Prepared index collection generation must be a positive safe integer.');
        }
        if (typeof binding.operationId !== 'string' || binding.operationId.trim().length === 0) {
            throw new Error('Prepared index collection operationId must be a non-empty string.');
        }

        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const collectionName = binding.collectionName?.trim()
            ?? this.getLegacyWriteCollectionName(canonicalRoot)
            ?? this.resolveCollectionName(canonicalRoot);
        const stagedPrefix = `${this.resolveCollectionName(canonicalRoot)}${GENERATION_COLLECTION_SEPARATOR}`;
        if (!collectionName.startsWith(stagedPrefix)) {
            throw new Error(`Prepared index collection '${collectionName}' is not a staged generation for '${canonicalRoot}'.`);
        }

        assertMutationCurrent?.();
        await this.prepareCollection(canonicalRoot, true, assertMutationCurrent, collectionName);
        assertMutationCurrent?.();

        const receipt = Object.freeze({
            canonicalRoot,
            collectionName,
            generation: binding.generation,
            operationId: binding.operationId.trim(),
        });
        this.indexGenerationWorkflow.registerPreparedIndexCollectionReceipt(receipt);
        return receipt;
    }

    public discardPreparedIndexCollection(receipt: PreparedIndexCollectionReceipt): void {
        this.indexGenerationWorkflow.discardPreparedIndexCollectionReceipt(receipt);
    }

    public async getActiveIndexedCollectionName(codebasePath: string): Promise<string | null> {
        const proven = await this.proveIndexedGeneration(codebasePath);
        return proven?.collectionName ?? null;
    }

    public getIndexAuthorityObservation(codebasePath: string): string | null {
        const observations = this.getIndexAuthorityObservations(codebasePath);
        return observations ? JSON.stringify(observations) : null;
    }

    public getIndexAuthorityObservations(codebasePath: string): IndexAuthorityObservations | null {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.indexAuthorityCoordinator.getIndexAuthorityObservations(canonicalRoot);
    }

    private async proveGenerationAuthorityExactly(
        codebasePath: string,
        priorReceipt?: ProvenVectorGenerationReceipt,
        requireNavigation = true,
        throwOnUnprovablePayload = false,
    ): Promise<ProvenVectorGenerationReceipt | ProvenGenerationReceipt | null> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        if (priorReceipt && priorReceipt.policy.canonicalRoot !== canonicalRoot) return null;

        const initialProfileToken = this.resolveRepoConfigObservationToken(canonicalRoot);
        const initialPolicyToken = this.indexPolicyRuntimeService.resolveCustomIndexPolicyFileToken(canonicalRoot);
        if (initialPolicyToken === null) return null;
        if (
            priorReceipt
            && (
                priorReceipt.observations.profileFileToken !== initialProfileToken
                || priorReceipt.observations.policyFileToken !== initialPolicyToken
            )
        ) {
            return null;
        }

        if (priorReceipt && this.indexPolicyRuntimeService.hasIndexProfile(canonicalRoot)) {
            this.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot);
            this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
        } else {
            this.refreshRuntimePolicyAuthority(canonicalRoot);
        }
        const publishedPolicy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        const policyBinding = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        const policyDocumentDigest = this.indexPolicyRuntimeService.getPolicyDocumentDigest(canonicalRoot);
        if (
            !publishedPolicy
            || !policyBinding
            || !policyDocumentDigest
            || this.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true
            || publishedPolicy.canonicalRoot !== canonicalRoot
            || policyBinding.policyHash !== publishedPolicy.policyHash
            || (priorReceipt && (
                priorReceipt.collectionName !== policyBinding.collectionName
                || priorReceipt.policyDocumentDigest !== policyDocumentDigest
            ))
        ) {
            return null;
        }
        if (!(await this.vectorDatabase.hasCollection(policyBinding.collectionName))) return null;

        const initialMarker = await this.resolveCompletionMarkerForCollection(
            canonicalRoot,
            policyBinding.collectionName,
        );
        if (
            !initialMarker
            || this.indexAuthorityCoordinator.resolveEffectiveNavigationAuthority(
                initialMarker,
                publishedPolicy,
                policyBinding,
            ) === null
        ) {
            return null;
        }
        const initialNavigationAuthority = this.indexAuthorityCoordinator.resolveEffectiveNavigationAuthority(
            initialMarker,
            publishedPolicy,
            policyBinding,
        );
        if (!initialNavigationAuthority) return null;
        if (policyBinding.publication) {
            const checkpoint = await new FileSynchronizer(
                canonicalRoot,
                publishedPolicy.effectiveIgnorePatterns,
                publishedPolicy.supportedExtensions,
                {
                    checkpointIdentity: policyBinding.collectionName,
                    checkpointAuthority: {
                        collectionName: policyBinding.collectionName,
                        markerRunId: policyBinding.publication.sourceCheckpoint.markerRunId,
                        indexPolicyHash: policyBinding.publication.sourceCheckpoint.indexPolicyHash,
                    },
                },
            ).inspectOwnedSnapshot();
            if (
                checkpoint.status !== 'valid'
                || checkpoint.merkleRoot !== policyBinding.publication.sourceCheckpoint.merkleRoot
                || checkpoint.documentDigest !== policyBinding.publication.sourceCheckpoint.documentDigest
            ) return null;
        }
        if (priorReceipt && !this.indexCompletionMarkersEqual(initialMarker, priorReceipt.marker)) {
            return null;
        }
        if (requireNavigation && initialNavigationAuthority.status !== 'sealed') return null;

        const exactPayloadCount = await this.countIndexedPayloadExactly(
            policyBinding.collectionName,
            undefined,
            initialMarker.totalChunks,
        );
        if (exactPayloadCount === null) {
            if (throwOnUnprovablePayload) {
                throw new Error(`Exact indexed payload count is unavailable for '${policyBinding.collectionName}'.`);
            }
            return null;
        }
        if (exactPayloadCount !== initialMarker.totalChunks) return null;

        const validateNavigation = requireNavigation
            || initialNavigationAuthority.relationshipOnlyUpgrade;
        const navigationProof = validateNavigation
            ? await this.indexAuthorityCoordinator.proveEffectiveNavigationAuthority(
                canonicalRoot,
                initialNavigationAuthority,
                requireNavigation,
            )
            : { status: 'not_bound' as const };
        if (validateNavigation && navigationProof.status !== 'valid') return null;
        const navigation = navigationProof.status === 'valid'
            ? navigationProof.generation
            : null;
        const navigationToken = navigationProof.status === 'valid'
            ? navigationProof.observationToken
            : null;
        if (navigation && !navigationToken) return null;
        if (
            requireNavigation
            && priorReceipt
            && 'navigationToken' in priorReceipt.observations
            && priorReceipt.observations.navigationToken !== navigationToken
        ) return null;

        const finalMarker = await this.resolveCompletionMarkerForCollection(
            canonicalRoot,
            policyBinding.collectionName,
        );
        const finalProfileToken = this.resolveRepoConfigObservationToken(canonicalRoot);
        const finalPolicyToken = this.indexPolicyRuntimeService.resolveCustomIndexPolicyFileToken(canonicalRoot);
        const finalNavigationToken = requireNavigation && navigation
            ? this.resolveNavigationObservationToken(
                canonicalRoot,
                navigation.generationId,
                !initialNavigationAuthority.useBoundGeneration,
            )
            : navigationToken;
        const finalPolicy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        const finalBinding = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        const finalNavigationAuthority = finalMarker && finalPolicy && finalBinding
            ? this.indexAuthorityCoordinator.resolveEffectiveNavigationAuthority(
                finalMarker,
                finalPolicy,
                finalBinding,
            )
            : null;
        if (
            !finalMarker
            || !this.indexCompletionMarkersEqual(finalMarker, initialMarker)
            || finalProfileToken !== initialProfileToken
            || finalPolicyToken !== initialPolicyToken
            || (requireNavigation && finalNavigationToken !== navigationToken)
            || !finalPolicy
            || !finalBinding
            || finalPolicy.policyHash !== initialMarker.indexPolicyHash
            || finalBinding.policyHash !== initialMarker.indexPolicyHash
            || finalBinding.collectionName !== policyBinding.collectionName
            || !finalNavigationAuthority
            || !this.indexAuthorityCoordinator.effectiveNavigationAuthoritiesEqual(
                finalNavigationAuthority,
                initialNavigationAuthority,
            )
            || !publicationBindingsEqual(finalBinding.publication, policyBinding.publication)
            || (requireNavigation && (
                finalNavigationAuthority.status !== 'sealed'
                || navigation?.navigationSealHash !== finalNavigationAuthority.sealHash
            ))
            || this.indexPolicyRuntimeService.getPolicyDocumentDigest(canonicalRoot) !== policyDocumentDigest
        ) {
            return null;
        }
        const vectorReceipt: ProvenVectorGenerationReceipt = {
            collectionName: policyBinding.collectionName,
            marker: this.indexAuthorityCoordinator.cloneIndexCompletionMarker(initialMarker),
            policy: {
                ...finalPolicy,
                customExtensions: [...finalPolicy.customExtensions],
                customIgnorePatterns: [...finalPolicy.customIgnorePatterns],
                fileBasedIgnorePatterns: [...finalPolicy.fileBasedIgnorePatterns],
                supportedExtensions: [...finalPolicy.supportedExtensions],
                effectiveIgnorePatterns: [...finalPolicy.effectiveIgnorePatterns],
            },
            policyDocumentDigest,
            exactPayloadCount,
            observations: {
                profileFileToken: finalProfileToken,
                policyFileToken: finalPolicyToken,
            },
        };
        return requireNavigation
            ? {
                ...vectorReceipt,
                navigation: { ...navigation! },
                publication: finalBinding.publication ? structuredClone(finalBinding.publication) : undefined,
                observations: {
                    ...vectorReceipt.observations,
                    navigationToken: finalNavigationToken!,
                },
            }
            : {
                ...vectorReceipt,
                publication: finalBinding.publication ? structuredClone(finalBinding.publication) : undefined,
            };
    }

    private invalidateGenerationProofForCollection(collectionName: string): void {
        this.indexAuthorityCoordinator.forEachGenerationProof((canonicalRoot, proof) => {
            if (proof.vectorReceipt.collectionName === collectionName) {
                this.indexAuthorityCoordinator.deleteGenerationProof(canonicalRoot);
            }
        });
    }

    private cachedGenerationProofMatches(
        canonicalRoot: string,
        cached: CachedGenerationProof,
        identity: string,
        priorReceipt?: ProvenVectorGenerationReceipt,
    ): boolean {
        return cached.identity === identity
            && this.isPreparedVectorReceiptBoundToCurrentAuthority(canonicalRoot, cached.vectorReceipt)
            && (!priorReceipt || (
                priorReceipt.collectionName === cached.vectorReceipt.collectionName
                && priorReceipt.policyDocumentDigest === cached.vectorReceipt.policyDocumentDigest
                && priorReceipt.exactPayloadCount === cached.vectorReceipt.exactPayloadCount
                && priorReceipt.policy.canonicalRoot === canonicalRoot
                && priorReceipt.policy.policyHash === cached.vectorReceipt.policy.policyHash
                && priorReceipt.observations.profileFileToken
                    === cached.vectorReceipt.observations.profileFileToken
                && priorReceipt.observations.policyFileToken
                    === cached.vectorReceipt.observations.policyFileToken
                && this.indexCompletionMarkersEqual(priorReceipt.marker, cached.vectorReceipt.marker)
            ));
    }

    private async revalidateReceiptWithoutPublicationObservation(
        canonicalRoot: string,
        receipt: ProvenVectorGenerationReceipt,
    ): Promise<ProvenVectorGenerationReceipt | null> {
        const initialProfileToken = this.resolveRepoConfigObservationToken(canonicalRoot);
        const initialPolicyToken = this.indexPolicyRuntimeService.resolveCustomIndexPolicyFileToken(canonicalRoot);
        if (
            receipt.policy.canonicalRoot !== canonicalRoot
            || receipt.observations.profileFileToken !== initialProfileToken
            || receipt.observations.policyFileToken !== initialPolicyToken
        ) return null;

        this.refreshRuntimePolicyAuthority(canonicalRoot);
        const policy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        const binding = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        if (
            !policy
            || !binding
            || this.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true
            || binding.collectionName !== receipt.collectionName
            || this.indexAuthorityCoordinator.resolveEffectiveNavigationAuthority(
                receipt.marker,
                policy,
                binding,
            ) === null
            || this.indexPolicyRuntimeService.getPolicyDocumentDigest(canonicalRoot) !== receipt.policyDocumentDigest
            || !(await this.vectorDatabase.hasCollection(receipt.collectionName))
        ) return null;

        const marker = await this.resolveCompletionMarkerForCollection(canonicalRoot, receipt.collectionName);
        if (!marker || !this.indexCompletionMarkersEqual(marker, receipt.marker)) return null;
        if (
            this.resolveRepoConfigObservationToken(canonicalRoot) !== initialProfileToken
            || this.indexPolicyRuntimeService.resolveCustomIndexPolicyFileToken(canonicalRoot) !== initialPolicyToken
        ) return null;
        return {
            collectionName: binding.collectionName,
            marker: this.indexAuthorityCoordinator.cloneIndexCompletionMarker(marker),
            policy: {
                ...policy,
                customExtensions: [...policy.customExtensions],
                customIgnorePatterns: [...policy.customIgnorePatterns],
                fileBasedIgnorePatterns: [...policy.fileBasedIgnorePatterns],
                supportedExtensions: [...policy.supportedExtensions],
                effectiveIgnorePatterns: [...policy.effectiveIgnorePatterns],
            },
            policyDocumentDigest: receipt.policyDocumentDigest,
            exactPayloadCount: marker.totalChunks,
            observations: {
                profileFileToken: initialProfileToken,
                policyFileToken: initialPolicyToken,
            },
        };
    }

    private async proveVectorGenerationWithEvidence(
        codebasePath: string,
        priorReceipt?: ProvenVectorGenerationReceipt,
        throwOnUnprovablePayload = false,
    ): Promise<VectorGenerationProofResult> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        if (priorReceipt && typeof this.vectorDatabase.getPublicationObservation !== 'function') {
            const revalidated = await this.revalidateReceiptWithoutPublicationObservation(
                canonicalRoot,
                priorReceipt,
            );
            return {
                receipt: revalidated,
                exactPayloadRecounts: 0,
                source: 'reused',
            };
        }
        const identity = await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot);
        if (identity) {
            const cached = this.indexAuthorityCoordinator.getGenerationProof(canonicalRoot);
            if (
                cached
                && this.cachedGenerationProofMatches(canonicalRoot, cached, identity, priorReceipt)
            ) {
                if (await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot) !== identity) {
                    return { receipt: null, exactPayloadRecounts: 0, source: 'reused' };
                }
                return {
                    receipt: this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(cached.vectorReceipt),
                    exactPayloadRecounts: 0,
                    source: 'reused',
                };
            }

            const flightKey = JSON.stringify([canonicalRoot, identity]);
            const joinedFlight = this.indexAuthorityCoordinator.getGenerationProofFlight(flightKey);
            if (joinedFlight) {
                const joined = await joinedFlight;
                if (
                    !joined
                    || !this.cachedGenerationProofMatches(canonicalRoot, joined, identity, priorReceipt)
                    || await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot) !== identity
                ) {
                    return { receipt: null, exactPayloadRecounts: 0, source: 'joined' };
                }
                return {
                    receipt: this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(joined.vectorReceipt),
                    exactPayloadRecounts: 0,
                    source: 'joined',
                };
            }

            const flight = (async (): Promise<CachedGenerationProof | null> => {
                const exact = await this.proveGenerationAuthorityExactly(
                    canonicalRoot,
                    priorReceipt,
                    false,
                    throwOnUnprovablePayload,
                ) as ProvenVectorGenerationReceipt | null;
                if (!exact) return null;
                const identityAfter = await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot);
                if (identityAfter !== identity) return null;
                const proven: CachedGenerationProof = {
                    identity,
                    vectorReceipt: this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(exact),
                    navigationArtifactsValidated: false,
                    source: 'exact',
                };
                this.indexAuthorityCoordinator.setGenerationProof(canonicalRoot, proven);
                return proven;
            })();
            this.indexAuthorityCoordinator.setGenerationProofFlight(flightKey, flight);
            try {
                const proven = await flight;
                return {
                    receipt: proven
                        ? this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(proven.vectorReceipt)
                        : null,
                    exactPayloadRecounts: proven ? 1 : 0,
                    source: 'exact',
                };
            } finally {
                if (this.indexAuthorityCoordinator.getGenerationProofFlight(flightKey) === flight) {
                    this.indexAuthorityCoordinator.deleteGenerationProofFlight(flightKey, flight);
                }
            }
        }

        const exact = await this.proveGenerationAuthorityExactly(
            canonicalRoot,
            priorReceipt,
            false,
            throwOnUnprovablePayload,
        ) as ProvenVectorGenerationReceipt | null;
        return {
            receipt: exact,
            exactPayloadRecounts: exact ? 1 : 0,
            source: 'exact',
        };
    }

    private async proveNavigationForVectorReceipt(
        codebasePath: string,
        receipt: ProvenVectorGenerationReceipt,
        validateArtifacts: boolean,
    ): Promise<NavigationGenerationProof> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const identity = await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot);
        const cached = identity ? this.indexAuthorityCoordinator.getGenerationProof(canonicalRoot) : undefined;
        if (
            cached
            && this.cachedGenerationProofMatches(canonicalRoot, cached, identity!, receipt)
            && cached.generationReceipt
            && (!validateArtifacts || cached.navigationArtifactsValidated)
        ) {
            const currentNavToken = this.resolveNavigationObservationToken(
                canonicalRoot,
                cached.generationReceipt.navigation.generationId,
                cached.generationReceipt.observations.navigationToken.includes('pointerToken'),
            );
            if (!currentNavToken || currentNavToken !== cached.generationReceipt.observations.navigationToken) {
                return { status: 'incompatible' };
            }
            if (await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot) !== identity) {
                return { status: 'incompatible' };
            }
            return {
                status: 'valid',
                generation: { ...cached.generationReceipt.navigation },
                observationToken: cached.generationReceipt.observations.navigationToken,
            };
        }

        const flightKey = identity
            ? JSON.stringify([canonicalRoot, identity, validateArtifacts])
            : null;
        const joinedFlight = flightKey ? this.indexAuthorityCoordinator.getNavigationProofFlight(flightKey) : undefined;
        if (joinedFlight) {
            const joinedProof = await joinedFlight;
            return await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot) === identity
                ? joinedProof
                : { status: 'incompatible' };
        }
        const flight = this.proveNavigationGeneration(canonicalRoot, receipt.marker, validateArtifacts);
        if (flightKey) this.indexAuthorityCoordinator.setNavigationProofFlight(flightKey, flight);
        let proof: NavigationGenerationProof;
        try {
            proof = await flight;
        } finally {
            if (flightKey && this.indexAuthorityCoordinator.getNavigationProofFlight(flightKey) === flight) {
                this.indexAuthorityCoordinator.deleteNavigationProofFlight(flightKey, flight);
            }
        }
        const identityAfter = await this.indexAuthorityCoordinator.resolveGenerationProofIdentity(canonicalRoot);
        if (identityAfter !== identity) return { status: 'incompatible' };
        if (proof.status === 'valid' && identity) {
            const generationReceipt: ProvenGenerationReceipt = {
                ...this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(receipt),
                navigation: { ...proof.generation },
                observations: {
                    ...receipt.observations,
                    navigationToken: proof.observationToken,
                },
            };
            this.indexAuthorityCoordinator.setGenerationProof(canonicalRoot, {
                identity,
                vectorReceipt: this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(receipt),
                generationReceipt,
                navigationArtifactsValidated: validateArtifacts,
                source: cached?.source ?? 'exact',
            });
        }
        return proof;
    }

    private async resolveGenerationReceipt(
        codebasePath: string,
        vectorReceipt: ProvenVectorGenerationReceipt,
        priorReceipt?: ProvenGenerationReceipt,
        validateArtifacts = false,
    ): Promise<ProvenGenerationReceipt | null> {
        const navigation = await this.proveNavigationForVectorReceipt(
            codebasePath,
            vectorReceipt,
            validateArtifacts,
        );
        if (navigation.status !== 'valid') return null;
        if (
            priorReceipt
            && (
                priorReceipt.observations.navigationToken !== navigation.observationToken
                || priorReceipt.navigation.navigationSealHash !== navigation.generation.navigationSealHash
            )
        ) return null;
        return {
            ...this.indexAuthorityCoordinator.cloneProvenVectorGenerationReceipt(vectorReceipt),
            navigation: { ...navigation.generation },
            observations: {
                ...vectorReceipt.observations,
                navigationToken: navigation.observationToken,
            },
        };
    }

    public async proveVectorGeneration(
        codebasePath: string,
        priorReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<ProvenVectorGenerationReceipt | null> {
        return (await this.proveVectorGenerationWithEvidence(codebasePath, priorReceipt)).receipt;
    }

    public async proveIndexedGeneration(
        codebasePath: string,
        priorReceipt?: ProvenGenerationReceipt,
    ): Promise<ProvenGenerationReceipt | null> {
        const vectorProof = await this.proveVectorGenerationWithEvidence(codebasePath, priorReceipt);
        if (!vectorProof.receipt) return null;
        return this.resolveGenerationReceipt(
            codebasePath,
            vectorProof.receipt,
            priorReceipt,
            true,
        );
    }

    private async proveNavigationGeneration(
        canonicalRoot: string,
        marker: IndexCompletionMarkerDocument,
        validateArtifacts = false,
    ): Promise<NavigationGenerationProof> {
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        const policy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        const policyBinding = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        if (!policy || !policyBinding) return { status: 'incompatible' };
        const authority = this.indexAuthorityCoordinator.resolveEffectiveNavigationAuthority(
            marker,
            policy,
            policyBinding,
        );
        if (!authority) return { status: 'incompatible' };
        return this.indexAuthorityCoordinator.proveEffectiveNavigationAuthority(
            canonicalRoot,
            authority,
            validateArtifacts,
        );
    }

    public async revalidateProvenVectorGeneration(
        codebasePath: string,
        receipt: ProvenVectorGenerationReceipt,
    ): Promise<ProvenVectorGenerationReceipt | null> {
        if (
            receipt.exactPayloadCount !== receipt.marker.totalChunks
            || receipt.policy.policyHash !== receipt.marker.indexPolicyHash
            || receipt.collectionName.length === 0
        ) return null;
        return (await this.proveVectorGenerationWithEvidence(codebasePath, receipt)).receipt;
    }

    public async revalidateProvenGeneration(
        codebasePath: string,
        receipt: ProvenGenerationReceipt,
    ): Promise<ProvenGenerationReceipt | null> {
        const vectorReceipt = await this.revalidateProvenVectorGeneration(codebasePath, receipt);
        if (!vectorReceipt) return null;
        return this.resolveGenerationReceipt(codebasePath, vectorReceipt, receipt);
    }

    public async revalidatePreparedGeneration(
        codebasePath: string,
        receipt: ProvenVectorGenerationReceipt,
        options?: {
            priorGenerationReceipt?: ProvenGenerationReceipt;
            navigationObservationChanged?: boolean;
        },
    ): Promise<PreparedGenerationRevalidation | null> {
        const vectorReceipt = await this.revalidateProvenVectorGeneration(codebasePath, receipt);
        if (!vectorReceipt) return null;
        const navigationProof = await this.proveNavigationForVectorReceipt(
            codebasePath,
            vectorReceipt,
            options?.navigationObservationChanged === true,
        );
        if (
            navigationProof.status === 'valid'
            && options?.priorGenerationReceipt
            && options.navigationObservationChanged !== true
            && (
                !options.priorGenerationReceipt.navigation
                || !options.priorGenerationReceipt.observations.navigationToken
                ||
                navigationProof.generation.navigationSealHash
                    !== options.priorGenerationReceipt.navigation.navigationSealHash
                || navigationProof.observationToken
                    !== options.priorGenerationReceipt.observations.navigationToken
            )
        ) return null;
        const generationReceipt = navigationProof.status === 'valid'
            ? {
                ...vectorReceipt,
                navigation: navigationProof.generation,
                observations: {
                    ...vectorReceipt.observations,
                    navigationToken: navigationProof.observationToken,
                },
            }
            : undefined;
        return {
            vectorReceipt,
            navigationProof,
            ...(generationReceipt ? { generationReceipt } : {}),
        };
    }

    public resolveProvenGeneration(codebasePath: string): Promise<ProvenGenerationReceipt | null> {
        return this.proveIndexedGeneration(codebasePath);
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
        options: StagedCollectionPruneOptions = {},
    ): Promise<string[]> {
        if (options.discardUnprovenPayload && !options.assertMutationCurrent) {
            throw new Error('Discarding unproven staged payload requires a current mutation lease.');
        }
        const familyCollectionNames = await this.listRelatedCollectionNames(codebasePath);
        const droppedCollections: string[] = [];

        for (const collectionName of familyCollectionNames) {
            if (!isStagedGenerationCollectionName(collectionName)) {
                continue;
            }
            // Hybrid rebuilds intentionally leave staged collections indexless until
            // finalization. Marker/payload probes load the collection, so an
            // IndexNotExist-class failure means the generation is unsearchable and
            // unproven rather than a hard prune abort. Preserve that uncertain state
            // unless this mutation owns exclusive discard authority.
            let marker: IndexCompletionMarkerDocument | null;
            let hasUnprovenPayload = false;
            try {
                marker = await this.resolveCompletionMarkerForCollection(codebasePath, collectionName);
                if (marker && await this.collectionHasIndexedPayload(collectionName, marker)) {
                    continue;
                }
                hasUnprovenPayload = !marker
                    && await this.collectionHasAnyIndexedPayload(collectionName);
            } catch (error) {
                if (!isUnsearchableStagedCollectionError(error)) {
                    throw error;
                }
                if (!options.discardUnprovenPayload) {
                    continue;
                }
                marker = null;
                hasUnprovenPayload = false;
            }
            if (!marker && !options.discardUnprovenPayload && hasUnprovenPayload) {
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

    private async waitForPublicationRetention(canonicalRoot: string): Promise<void> {
        await this.indexAuthorityCoordinator.waitForPublicationRetention(canonicalRoot);
    }

    /**
     * Retention is the only owner allowed to remove inactive physical generations.
     * A publication-bound reader holds this lease for its complete operation so a
     * second activation cannot prune the collection or navigation generation it uses.
     */
    public async acquirePublicationReadLease(codebasePath: string): Promise<() => void> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.indexAuthorityCoordinator.acquirePublicationReadLease(canonicalRoot);
    }





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

    public async semanticSearchInProvenGeneration(
        receipt: ProvenVectorGenerationReceipt,
        request: SemanticSearchRequest,
    ): Promise<SemanticSearchResult[]> {
        return this.semanticSearchService.searchInProvenGeneration(receipt, request);
    }

    public async semanticSearchWithCandidateTraceInProvenGeneration(
        receipt: ProvenVectorGenerationReceipt,
        request: SemanticSearchRequest,
        maxEntriesPerStage: number,
        options: SemanticSearchCandidateTraceOptions = {},
    ): Promise<SemanticSearchExecutionResult> {
        return this.semanticSearchService.searchWithCandidateTraceInProvenGeneration(
            receipt,
            request,
            maxEntriesPerStage,
            options,
        );
    }

    private async clearIndexCompletionMarkerFromCollection(
        collectionName: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const record = await this.vectorDatabase.getControl(collectionName, INDEX_COMPLETION_MARKER_DOC_ID);
        if (!record) {
            return;
        }
        assertMutationCurrent?.();
        await this.vectorDatabase.deleteControl(collectionName, INDEX_COMPLETION_MARKER_DOC_ID);
        this.invalidateGenerationProofForCollection(collectionName);
    }

    async writeIndexCompletionMarker(
        codebasePath: string,
        marker: IndexCompletionMarkerDocument,
        collectionNameOverride?: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        const collectionName = collectionNameOverride
            || this.getLegacyWriteCollectionName(codebasePath)
            || this.resolveCollectionName(codebasePath);
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            throw new Error(`Cannot write completion marker: collection '${collectionName}' does not exist.`);
        }

        await this.clearIndexCompletionMarkerFromCollection(collectionName, assertMutationCurrent);

        const markerRecord: VectorControlRecord = {
            id: INDEX_COMPLETION_MARKER_DOC_ID,
            kind: marker.kind,
            metadata: marker,
        };

        assertMutationCurrent?.();
        await this.vectorDatabase.insertControl(collectionName, markerRecord);
        this.invalidateGenerationProofForCollection(collectionName);
    }

    async getIndexCompletionMarker(codebasePath: string): Promise<IndexCompletionMarkerDocument | null> {
        return (await this.resolveCompletionProofCollection(codebasePath))?.marker ?? null;
    }

    /** Read canonical completion-marker evidence for lifecycle validation. */
    async getIndexCompletionMarkerForValidation(codebasePath: string): Promise<CompletionMarkerValidationEvidence> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        let policyAuthorityInvalid = false;
        try {
            this.refreshRuntimePolicyAuthority(canonicalRoot);
        } catch (error) {
            if (error instanceof IndexFormatRequiresReindexError) {
                return { status: 'requires_reindex' };
            }
            if (error instanceof UnsupportedIndexAuthorityError) {
                return { status: 'unsupported_authority' };
            }
            // Marker evidence remains readable even when policy proof is malformed.
            if (error instanceof IndexPolicyAuthorityError) policyAuthorityInvalid = true;
        }
        if (policyAuthorityInvalid) return { status: 'policy_authority_invalid' };
        try {
            await resolveCurrentNavigationGeneration(this.symbolRegistryStateRoot, canonicalRoot);
        } catch (error) {
            if (error instanceof RetiredNavigationPointerError) {
                return { status: 'requires_reindex' };
            }
            if (error instanceof UnsupportedNavigationPointerError) {
                return { status: 'unsupported_authority' };
            }
        }
        const boundCollection = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot)?.collectionName;
        const publishedPolicy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        if (
            boundCollection
            && publishedPolicy
            && this.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true
        ) {
            return { status: 'runtime_policy_incompatible' };
        }
        let vectorProof: VectorGenerationProofResult;
        try {
            vectorProof = await this.proveVectorGenerationWithEvidence(
                codebasePath,
                undefined,
                true,
            );
        } catch (error) {
            if (error instanceof IndexFormatRequiresReindexError) {
                return { status: 'requires_reindex' };
            }
            if (error instanceof UnsupportedIndexAuthorityError) {
                return { status: 'unsupported_authority' };
            }
            if (error instanceof IndexPolicyAuthorityError) {
                return { status: 'policy_authority_invalid' };
            }
            throw error;
        }
        const vectorGeneration = vectorProof.receipt;
        if (vectorGeneration) {
            const navigationProof = await this.proveNavigationForVectorReceipt(
                canonicalRoot,
                vectorGeneration,
                true,
            );
            if (navigationProof.status === 'requires_reindex') {
                return { status: 'requires_reindex' };
            }
            if (navigationProof.status === 'unsupported') {
                return { status: 'unsupported_authority' };
            }
            const generationReceipt = navigationProof.status === 'valid'
                ? {
                    ...vectorGeneration,
                    navigation: navigationProof.generation,
                    observations: {
                        ...vectorGeneration.observations,
                        navigationToken: navigationProof.observationToken,
                    },
                }
                : undefined;
            return {
                status: 'valid_v3',
                collectionName: vectorGeneration.collectionName,
                marker: vectorGeneration.marker,
                vectorReceipt: vectorGeneration,
                navigationProof,
                ...(generationReceipt ? { generationReceipt } : {}),
                exactPayloadRecounts: vectorProof.exactPayloadRecounts,
                proofSource: vectorProof.source,
            };
        }
        const relatedCollections = await this.listRelatedCollectionNames(codebasePath);
        const { activeFamilyName, alternateFamilyName } = this.buildCollectionFamilies(codebasePath);
        const readCollectionEvidence = async (
            collectionName: string,
        ): Promise<CompletionMarkerValidationEvidence> => {
            const record = await this.vectorDatabase.getControl(
                collectionName,
                INDEX_COMPLETION_MARKER_DOC_ID,
            );
            if (!record) return { status: 'missing' };
            if (!this.completionControlRecordKindMatches(record)) {
                return { status: 'invalid_v3' };
            }
            const inspected = inspectCompletionMarker(record.metadata);
            if (inspected.status === 'requires_reindex') {
                return { status: 'requires_reindex' };
            }
            if (inspected.status === 'unsupported') {
                return { status: 'unsupported_authority' };
            }
            return inspected.status === 'current' ? { status: 'invalid_v3' } : { status: 'missing' };
        };
        if (boundCollection) {
            if (!relatedCollections.includes(boundCollection)) {
                return { status: 'invalid_v3' };
            }
            const evidence = await readCollectionEvidence(boundCollection);
            return evidence.status === 'requires_reindex'
                || evidence.status === 'unsupported_authority'
                ? evidence
                : { status: 'invalid_v3' };
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
        return this.indexTeardownWorkflow.clearIndex(codebasePath, progressCallback, options);
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
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.resolveIndexPolicyFromCurrentInputs(canonicalRoot, update, false, true);
    }

    private async resolveIndexPolicyFromCurrentInputs(
        canonicalRoot: string,
        update: CustomIndexPolicyUpdate,
        inheritActiveCustomPolicy: boolean,
        activateRuntimeProfile: boolean,
    ): Promise<ObservedResolvedIndexPolicy> {
        const observedInputs = await observeIndexPolicyInputs(canonicalRoot);
        const profile = observedInputs.profileConfig.profile;
        if (activateRuntimeProfile) {
            this.setIndexProfileForCodebase(canonicalRoot, profile);
        }
        const customExtensions = update.customExtensions === undefined
            ? inheritActiveCustomPolicy
                ? this.indexPolicyRuntimeService.getRuntimeCustomExtensions(canonicalRoot)
                : []
            : normalizeSupportedExtensions(update.customExtensions);
        const customIgnorePatterns = update.customIgnorePatterns === undefined
            ? inheritActiveCustomPolicy
                ? this.ignoreRuleService.getRuntimeCustomPatterns(canonicalRoot)
                : []
            : update.customIgnorePatterns.map((pattern) => pattern.trim()).filter(Boolean);
        const fileBasedPatterns = [...observedInputs.fileBasedIgnorePatterns];
        const supportedExtensions = normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(profile),
            ...this.indexPolicyRuntimeService.getConfiguredExtensionOverlays(),
            ...customExtensions,
        ]);
        const effectiveIgnorePatterns = [
            ...this.ignoreRuleService.getBasePatterns(),
            ...customIgnorePatterns,
            ...fileBasedPatterns,
        ];
        const policyHash = computeIndexPolicyHash(profile, supportedExtensions, effectiveIgnorePatterns);
        return {
            canonicalRoot,
            profile,
            customExtensions,
            customIgnorePatterns,
            fileBasedIgnorePatterns: fileBasedPatterns,
            supportedExtensions,
            effectiveIgnorePatterns,
            policyHash,
            controlSignature: observedInputs.controlSignature,
        };
    }

    async observeIndexPolicyForIncrementalReconciliation(
        codebasePath: string,
    ): Promise<ObservedResolvedIndexPolicy> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot);
        return this.resolveIndexPolicyFromCurrentInputs(canonicalRoot, {}, true, false);
    }

    async isObservedIndexPolicyControlSignatureCurrent(
        policy: ObservedResolvedIndexPolicy,
    ): Promise<boolean> {
        const canonicalRoot = this.canonicalizeCodebasePath(policy.canonicalRoot);
        return canonicalRoot === policy.canonicalRoot
            && await computeIndexPolicyControlSignature(canonicalRoot) === policy.controlSignature;
    }

    activateObservedIndexPolicyForIncrementalReconciliation(
        policy: ObservedResolvedIndexPolicy,
    ): boolean {
        const canonicalRoot = this.canonicalizeCodebasePath(policy.canonicalRoot);
        this.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot);
        const publishedPolicy = this.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        if (!publishedPolicy || publishedPolicy.policyHash !== policy.policyHash) {
            return false;
        }
        const binding = this.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        if (publishedPolicy.controlSignature !== policy.controlSignature) {
            if (!binding?.publication) {
                return false;
            }
            this.publishResolvedIndexPolicy(policy, binding);
        }
        this.setIndexProfileForCodebase(canonicalRoot, policy.profile);
        this.ignoreRuleService.setFileBasedPatterns(canonicalRoot, policy.fileBasedIgnorePatterns);
        this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
        return true;
    }

    publishResolvedIndexPolicy(
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyBinding,
        publishMutation?: (publish: () => void) => void,
    ): IndexPolicyPublicationReceipt {
        return this.indexAuthorityCoordinator.publishResolvedIndexPolicy(
            policy,
            binding,
            publishMutation,
        );
    }



    public captureDurableIndexAuthority(codebasePath: string): DurableIndexAuthoritySnapshot {
        return this.indexAuthorityCoordinator.captureDurableIndexAuthority(codebasePath);
    }

    public async restoreDurableIndexAuthority(
        snapshot: DurableIndexAuthoritySnapshot,
        publishMutation: (publish: () => void) => void,
        expectedCurrent: DurableIndexAuthoritySnapshot,
        mutationOwner?: DurableAuthorityMutationOwner,
    ): Promise<DurableIndexAuthorityRestoreResult> {
        return this.indexAuthorityCoordinator.restoreDurableIndexAuthority(
            snapshot,
            publishMutation,
            expectedCurrent,
            mutationOwner,
        );
    }

    private fsyncPath(targetPath: string): void {
        const fd = fs.openSync(targetPath, 'r');
        try {
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }



    clearPublishedIndexPolicy(
        codebasePath: string,
        publishMutation: (publish: () => void) => void,
        expectedDocumentDigest: string,
    ): IndexPolicyPublicationReceipt {
        return this.indexAuthorityCoordinator.clearPublishedIndexPolicy(
            codebasePath,
            publishMutation,
            expectedDocumentDigest,
        );
    }

    forceClearPublishedIndexPolicy(
        codebasePath: string,
        publishMutation: (publish: () => void) => void,
    ): IndexPolicyPublicationReceipt {
        return this.indexAuthorityCoordinator.forceClearPublishedIndexPolicy(
            codebasePath,
            publishMutation,
        );
    }
    /**
     * Published-state activation hook invoked by the runtime policy service
     * after a resolved policy is activated. Context owns published bindings
     * and the published resolved policy; the runtime service owns the rest.
     */


    /**
     * Published-state clear hook invoked by the runtime policy service when
     * the runtime view of a codebase policy is cleared.
     */


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
        try {
            this.loadIndexProfileForCodebase(canonicalRoot);
        } catch (error) {
            if (error instanceof SatoriRepoConfigAuthorityError) {
                throw new IndexPolicyAuthorityError(
                    `Malformed repository profile authority for '${canonicalRoot}': ${error.message}`,
                    error,
                );
            }
            throw error;
        }
        this.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot);
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
        forceReindex: boolean = false,
        assertMutationCurrent?: () => void,
        collectionNameOverride?: string,
    ): Promise<void> {
        // Identity drift must fail before a valid published collection is
        // dropped or a staged generation is otherwise mutated.
        const embeddingIdentity = this.assertEmbeddingIdentityCurrent();
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = collectionNameOverride ?? this.resolveCollectionName(codebasePath);

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
    ): Promise<{ content: string; sourceHash: string } | null> {
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
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
        collectionName: string = this.resolveCollectionName(codebasePath),
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
            const rows = await this.vectorDatabase.queryDocuments(collectionName, {
                filter: { kind: 'in', field: 'id', values: batch },
                fields: ['id'],
                limit: batch.length,
            });
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
        const remotePayloadRows = await this.vectorDatabase.queryDocuments(collectionName, {
            fields: ['id'],
            limit: remotePayloadLimit,
        });
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
        this.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot);
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
            const analyzed = await this.analyzeIndexedFile(filePath, codebasePath);
            if (analyzed === null) {
                throw new Error(`Indexed source no longer satisfies the active policy: ${filePath}`);
            }
            const symbolFacts = this.buildAnalyzedFileSymbolFacts(analyzed);
            analysisByFile.set(analyzed.relativePath, symbolFacts.relationshipEvidence);
            symbolRecords.push(...symbolFacts.symbolRecords);
            symbolManifestFiles.push(symbolFacts.manifestFile);
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

    private async writeSymbolRegistryForCompletedIndex(
        codebasePath: string,
        symbolRecords: SymbolRecord[],
        symbolManifestFiles: SymbolRegistryManifestFile[],
        assertMutationCurrent?: () => void,
        suppliedAnalysisByFile?: Map<string, RelationshipAnalysisEvidence>,
        publishMutation?: (publish: () => void) => void,
        deferPublication: boolean = false,
        indexPolicy?: ResolvedIndexPolicy,
        semanticSources?: readonly SemanticSourceFile[],
    ): Promise<StagedNavigationSidecarGeneration | undefined> {
        return this.indexGenerationWorkflow.stageSymbolRegistryForCompletedIndex(
            codebasePath,
            symbolRecords,
            symbolManifestFiles,
            assertMutationCurrent,
            suppliedAnalysisByFile,
            publishMutation,
            deferPublication,
            indexPolicy,
            semanticSources,
        );
    }


    async clearIndexCompletionMarker(codebasePath: string, assertMutationCurrent?: () => void): Promise<void> {
        return this.indexGenerationWorkflow.clearIndexCompletionMarker(
            codebasePath,
            assertMutationCurrent,
            this.getLegacyWriteCollectionName(codebasePath),
        );
    }

    async resolveIndexPolicyForCodebase(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ObservedResolvedIndexPolicy> {
        return this.indexGenerationWorkflow.resolveIndexPolicyForCodebase(codebasePath, update);
    }

    private resolveReusableNavigationDeltaState(
        canonicalRoot: string,
        sourceNavigation: {
            generationId: string;
            symbolRegistryManifestHash: string;
            relationshipManifestHash: string;
            navigationSealHash?: string;
            sealHash?: string;
        },
    ): CachedNavigationDeltaState | undefined {
        return this.indexGenerationWorkflow.resolveReusableNavigationDeltaState(canonicalRoot, sourceNavigation);
    }

    public async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false,
        options: MutationGuardOptions = {},
    ): Promise<IndexCodebaseResult> {
        const legacyWriteCollectionName = this.getLegacyWriteCollectionName(codebasePath);
        const normalizedBinding = options.preparedCollectionBinding
            ? {
                ...options.preparedCollectionBinding,
                collectionName: options.preparedCollectionBinding.collectionName
                    ?? legacyWriteCollectionName
                    ?? options.preparedCollectionReceipt?.collectionName
                    ?? this.resolveCollectionName(codebasePath),
            }
            : undefined;
        const normalizedOptions: MutationGuardOptions = {
            ...options,
            ...(normalizedBinding ? { preparedCollectionBinding: normalizedBinding } : {}),
            ...(!options.preparedCollectionReceipt
                && options.writeCollectionName === undefined
                && legacyWriteCollectionName !== undefined
                ? { writeCollectionName: legacyWriteCollectionName }
                : {}),
        };
        return this.indexGenerationWorkflow.indexCodebase(
            codebasePath,
            progressCallback,
            forceReindex,
            normalizedOptions,
        );
    }

    public async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: ReindexByChangeOptions = {}
    ): Promise<ReindexByChangeResult> {
        const legacyWriteCollectionName = this.getLegacyWriteCollectionName(codebasePath);
        const normalizedOptions: ReindexByChangeOptions = options.targetCollectionName === undefined
            && legacyWriteCollectionName !== undefined
            ? { ...options, targetCollectionName: legacyWriteCollectionName }
            : options;
        return this.indexGenerationWorkflow.reindexByChange(codebasePath, progressCallback, normalizedOptions);
    }

    public async repairIndex(
        codebasePath: string,
        options: RepairIndexOptions = {}
    ): Promise<RepairIndexResult> {
        return this.indexGenerationWorkflow.repairIndex(codebasePath, options);
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
        this.indexGenerationWorkflow.promotePreparedNavigationDelta(
            candidate,
            () => this.resolveNavigationObservationToken(
                canonicalRoot,
                candidate.generationId,
                false,
            ),
        );
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
        if (!generation.navigationSealHash) {
            throw new Error('Cannot restore a navigation generation that predates seal binding.');
        }
        const rootPath = path.dirname(path.dirname(generation.generationRoot));
        await publishNavigationSidecarGeneration({
            rootPath,
            normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
            generationId: generation.generationId,
            manifestHash: generation.symbolRegistryManifestHash,
            relationshipManifestHash: generation.relationshipManifestHash,
            navigationSealHash: generation.navigationSealHash,
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
        runId?: string,
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
            runId,
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

    private resolveRepoConfigObservationToken(canonicalRoot: string): string | null {
        return this.resolveFilesystemObservationToken(
            path.join(canonicalRoot, SATORI_REPO_CONFIG_FILENAME),
        );
    }

    private resolveNavigationObservationToken(
        canonicalRoot: string,
        generationId: string,
        requireCurrentPointer = true,
    ): string | null {
        const observation = this.resolveNavigationObservation(canonicalRoot, generationId, requireCurrentPointer);
        return observation.status === 'valid' ? observation.token : null;
    }

    private resolveNavigationObservation(
        canonicalRoot: string,
        generationId: string,
        requireCurrentPointer = true,
    ): { status: 'valid'; token: string } | { status: 'missing' | 'incompatible' | 'corrupt' } {
        const navigationRoot = resolveNavigationSidecarRoot(this.symbolRegistryStateRoot, canonicalRoot);
        const pointerPath = path.join(navigationRoot, 'current.json');
        const generationRoot = path.join(navigationRoot, 'generations', generationId);
        const sealPath = path.join(generationRoot, 'seal.json');
        const pointerToken = this.resolveFilesystemObservationToken(pointerPath);
        const sealToken = this.resolveFilesystemObservationToken(sealPath);
        if ((requireCurrentPointer && !pointerToken) || !sealToken) return { status: 'missing' };

        let pointer: Record<string, unknown>;
        let rawSeal: unknown;
        try {
            pointer = requireCurrentPointer
                ? JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Record<string, unknown>
                : {};
            rawSeal = JSON.parse(fs.readFileSync(sealPath, 'utf8')) as unknown;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
            if (error instanceof SyntaxError) return { status: 'corrupt' };
            throw error;
        }
        const seal = parseNavigationGenerationSeal(rawSeal);
        if (!seal || (requireCurrentPointer && pointer.generationId !== generationId) || seal.generationId !== generationId) {
            return { status: 'corrupt' };
        }
        const navigationSealHash = computeNavigationGenerationSealHash(seal);
        if (
            requireCurrentPointer && (
                pointer.symbolRegistryManifestHash !== seal.symbolRegistryManifestHash
                || pointer.relationshipManifestHash !== seal.relationshipManifestHash
                || typeof pointer.navigationSealHash !== 'string'
                || pointer.navigationSealHash !== navigationSealHash
            )
        ) return { status: 'incompatible' };
        const symbolRegistryManifestToken = this.resolveFilesystemObservationToken(
            path.join(generationRoot, 'manifest.json'),
        );
        const symbolIndexToken = this.resolveFilesystemObservationToken(
            path.join(generationRoot, 'symbols', 'index.json'),
        );
        const relationshipManifestToken = this.resolveFilesystemObservationToken(
            path.join(generationRoot, 'relationships', 'manifest.json'),
        );
        const symbolsDirectoryToken = this.resolveFilesystemObservationToken(path.join(generationRoot, 'symbols'));
        const relationshipsDirectoryToken = this.resolveFilesystemObservationToken(path.join(generationRoot, 'relationships'));
        const symbolShardDirectoryToken = this.resolveFilesystemObservationToken(path.join(generationRoot, 'symbols', 'by-file'));
        const relationshipShardDirectoryToken = this.resolveFilesystemObservationToken(path.join(generationRoot, 'relationships', 'by-file'));
        if (
            !symbolRegistryManifestToken
            || !symbolIndexToken
            || !relationshipManifestToken
            || !symbolsDirectoryToken
            || !relationshipsDirectoryToken
            || !symbolShardDirectoryToken
            || !relationshipShardDirectoryToken
        ) return { status: 'missing' };
        return { status: 'valid', token: JSON.stringify({
            ...(requireCurrentPointer && pointerToken ? { pointerToken } : {}),
            sealToken,
            symbolRegistryManifestToken,
            symbolIndexToken,
            relationshipManifestToken,
            symbolsDirectoryToken,
            relationshipsDirectoryToken,
            symbolShardDirectoryToken,
            relationshipShardDirectoryToken,
            symbolRegistryManifestHash: seal.symbolRegistryManifestHash,
            relationshipManifestHash: seal.relationshipManifestHash,
            artifactSetHash: seal.artifactSetHash,
            navigationSealHash,
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
            this.disposePromise = Promise.resolve(this.semanticAnalyzer?.dispose?.());
        }
        return this.disposePromise;
    }
}
