/**
 * Phase 4.5 — Core index generation workflow.
 *
 * Owns repair and full-index domain orchestration: candidate generation,
 * generation proof, publication/rollback/retention calls, and Core domain
 * results. All dependencies are narrow ports provided by Context; it never
 * acquires authority state by reachability through Context.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isStagedGenerationCollectionName } from '../core/collection-naming.js';
import { normalizeSupportedExtensions } from '../config/index-policy';
import { computeMerkleRoot } from '../sync/merkle';
import type { ProvenGenerationReceipt } from './contracts';
import type { IndexPolicyPublicationReceipt } from './contracts';
import type { PreparedIndexCollectionReceipt } from './contracts';
import type { PreparedIndexCollectionBinding } from './contracts';
import type { IndexCodebaseResult } from './contracts';
import type { CurrentNavigationGeneration } from '../symbols/sidecar-reads';
import type { CanonicalPolicyNavigationBinding } from '../core/persisted-index-authority';
import type { StagedNavigationSidecarGeneration } from '../symbols/sidecar-lifecycle';
import type { SymbolRecord, SymbolRegistryManifestFile } from '../symbols/contracts';
import type { SymbolRegistry } from '../symbols/registry';
import type { RelationshipAnalysisEvidence } from '../relationships';
import { buildRelationshipDelta, buildRelationshipsForRegistry } from '../relationships';
import type { SemanticAuxiliaryFile, SemanticProjectAnalyzer, SemanticProjectEvidence, SemanticSourceFile } from '../semantic';
import { defaultSemanticLanguageRegistry, type SemanticLanguageRegistry } from '../semantic/descriptor';
import type { LanguageAnalysisPort } from '../language-analysis';
import type { RelationshipRecord } from '../symbols/contracts';

import type { IndexCompletionMarkerDocument, IndexCompletionFingerprint, VectorFilter, VectorControlRecord, VectorWriteMetricsSnapshot } from '../vectordb';
import type { VectorDatabase } from '../vectordb/types';
import type { IndexProfile } from '../config/defaults';
import type { ResolvedIndexPolicy, IndexPolicyRuntimeService, IndexPolicyRuntimeBinding } from '../policy/index-policy-runtime-service';
import type { Embedding, EmbeddingOperationMetricsSnapshot } from '../embedding';
import { FileSynchronizer, type PreparedFileChangeSet, type SourceFreshnessCheckpointAuthority, type StagedSourceFreshnessCheckpoint } from '../sync/synchronizer';
import { assertAuthenticPreparedFileChangeSet } from '../sync/prepared-change-set-authority';
import type { IndexAuthorityCoordinator } from './index-authority-coordinator';
import type { RepairProof, RepairSnapshotEvidence, RepairIndexResult, RepairActivatedGeneration } from '../core/repair-proof';
import type { ExpectedIndexedChunk, ProcessedFileList } from '../core/indexing-pipeline';
import { inspectCompletionMarker } from '../core/persisted-index-authority.js';
import type { CanonicalPublicationBinding } from '../core/persisted-index-authority';
import type { DurableAuthorityMutationOwner } from './restore-transaction';
import type { SatoriRepoConfig } from '../config/repo-config';
import type { RepositoryRelativePath } from '../paths/repository-path';
import type { CustomIndexPolicyUpdate, ObservedResolvedIndexPolicy } from './contracts';

import {
    IndexFormatRequiresReindexError,
    UnsupportedIndexAuthorityError,
} from '../policy/index-policy-runtime-service';
import {
    RetiredNavigationPointerError,
    UnsupportedNavigationPointerError,
    buildSymbolRegistry,
    computeNavigationGenerationSealHash,
    computeNavigationSourceFilesDigest,
    computeSymbolRegistryManifestHash,
    discardNavigationSidecarGeneration,
    readNavigationGenerationSeal,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveCurrentNavigationGeneration,
    stageNavigationSidecarGeneration,
    SYMBOL_REGISTRY_SCHEMA_VERSION,
} from '../symbols';
import {
    assertDescriptorBoundIndexingSupported,
    isRealPathInsideRoot,
    resolveInsideRoot,
} from '../sync/root-bound-fs';
import {
    INDEX_COMPLETION_MARKER_DOC_ID,
} from '../vectordb';
import {
    classifyRepairIndexCompatibility,
    indexFingerprintsEqual,
} from '../core/persisted-index-authority';
import {
    AtomicIncrementalPublicationUnsupportedError,
    IndexPolicyPublicationError,
} from './errors';

// ---- Moved private types (Phase 4.5) ----
type NavigationDeltaBuildResult = {
    readonly candidate?: StagedNavigationSidecarGeneration;
    readonly state?: CachedNavigationDeltaState;
};
type RepairCompletionMarkerResolution =
    | { status: 'missing' }
    | { status: 'malformed' }
    | { status: 'requires_reindex' }
    | { status: 'fingerprint_mismatch' }
    | { status: 'matched'; marker: IndexCompletionMarkerDocument };
type IndexPolicyBinding = IndexPolicyRuntimeBinding;

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

function assertExactIndexedFileHashesMatchPrepared(
    indexedFileHashes: ReadonlyMap<string, string>,
    preparedFileHashes: ReadonlyMap<string, string>,
    isAuxiliaryPath?: (filePath: string) => boolean,
): void {
    const searchablePreparedFileHashes = isAuxiliaryPath
        ? new Map([...preparedFileHashes.entries()].filter(([f]) => !isAuxiliaryPath(f)))
        : preparedFileHashes;

    if (indexedFileHashes.size !== searchablePreparedFileHashes.size) {
        throw new Error(
            `Completed full index source mismatch: indexed ${indexedFileHashes.size} files but prepared observation contains ${searchablePreparedFileHashes.size} searchable files (${preparedFileHashes.size} total observed).`,
        );
    }
    for (const [filePath, expectedHash] of searchablePreparedFileHashes.entries()) {
        const indexedHash = indexedFileHashes.get(filePath);
        if (indexedHash === undefined) {
            throw new Error(
                `Completed full index source mismatch: file '${filePath}' was prepared but was not indexed.`,
            );
        }
        if (indexedHash !== expectedHash) {
            throw new Error(
                `Completed full index source mismatch: hash for file '${filePath}' changed during indexing (prepared: ${expectedHash}, indexed: ${indexedHash}).`,
            );
        }
    }
}
type CollectionPayloadVerification =
    | { ok: true; indexedFiles: number; totalChunks: number }
    | { ok: false; message: string };

// ---- Narrow dependency ports ----
export interface IndexGenerationWorkflowPorts {
    acceptPreparedSourceGenerationReceipt(
            canonicalRoot: string,
            receipt: ProvenGenerationReceipt,
        ): Promise<ProvenGenerationReceipt | null>;
    assertResolvedIndexPolicyRoot(codebasePath: string, policy: ResolvedIndexPolicy): void;
    buildCollectionFamilies(codebasePath: string): {
            canonicalRoot: string;
            hash: string;
            activeFamilyName: string;
            alternateFamilyName: string;
        };
    buildIndexCompletionFingerprint(): IndexCompletionFingerprint;
    buildRootFingerprint(canonicalRoot: string): string;
    canonicalizeCodebasePath(codebasePath: string): string;
    clearIndexCompletionMarkerFromCollection(
            collectionName: string,
            assertMutationCurrent?: () => void,
        ): Promise<void>;
    clearSymbolRegistryForCodebase(
            codebasePath: string,
            assertMutationCurrent?: () => void,
            publishMutation?: (publish: () => void) => void,
        ): Promise<void>;
    cloneIndexCompletionMarker(marker: IndexCompletionMarkerDocument): IndexCompletionMarkerDocument;
    countIndexedPayloadExactly(
            collectionName: string,
            filter: VectorFilter | undefined,
            expectedMaximum?: number,
        ): Promise<number | null>;
    deleteFileChunks(
            collectionName: string,
            relativePath: string,
            assertMutationCurrent?: () => void,
        ): Promise<void>;
    ensureNavigationArtifactsReadyForMarkerRefresh(
            codebasePath: string,
            assertMutationCurrent?: () => void,
            publishMutation?: (publish: () => void) => void,
        ): Promise<void>;
    getActiveIgnorePatterns(codebasePath?: string): string[];
    getActiveIndexedCollectionName(codebasePath: string): Promise<string | null>;
    getCodeFiles(
            codebasePath: string,
            indexPolicy?: ResolvedIndexPolicy,
        ): Promise<string[]>;
    getExpectedChunksAndSymbols(
            filePaths: string[],
            codebasePath: string,
            indexPolicy?: ResolvedIndexPolicy,
        ): Promise<{
            expectedChunks: ExpectedIndexedChunk[];
            symbolRecords: SymbolRecord[];
            symbolManifestFiles: SymbolRegistryManifestFile[];
            analysisByFile: Map<string, RelationshipAnalysisEvidence>;
        }>;
    getIndexedExtensionsForCodebase(codebasePath: string): string[];
    getIsHybrid(): boolean;
    getLanguageRouterVersion(): string;
    getRelationshipVersion(): string;
    getSymbolExtractorVersion(): string;
    indexCompletionMarkersEqual(
            left: IndexCompletionMarkerDocument,
            right: IndexCompletionMarkerDocument,
        ): boolean;
    listRelatedCollectionNames(codebasePath: string): Promise<string[]>;
    loadIgnorePatterns(codebasePath: string): Promise<void>;
    loadIndexProfileForCodebase(codebasePath: string): SatoriRepoConfig;
    normalizeRelativePathForCodebase(
            codebasePath: string,
            candidatePath: string,
        ): RepositoryRelativePath | null;
    normalizeRelativePathsForCodebase(codebasePath: string, relativePaths: string[]): string[];
    parseCompletionControlRecord(
            codebasePath: string,
            record: VectorControlRecord,
        ): IndexCompletionMarkerDocument | null;
    policyNavigationBindingFromMarker(
        navigation: IndexCompletionMarkerDocument['navigation'],
    ): CanonicalPolicyNavigationBinding;
    policyNavigationBindingsEqual(
        left: CanonicalPolicyNavigationBinding,
        right: CanonicalPolicyNavigationBinding,
    ): boolean;
    prepareCollection(
            codebasePath: string,
            forceReindex?: boolean,
            assertMutationCurrent?: () => void,
            collectionNameOverride?: string,
        ): Promise<void>;
    processFileList(
            filePaths: string[],
            codebasePath: string,
            onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
            collectionName?: string,
            assertMutationCurrent?: () => void,
            indexPolicy?: ResolvedIndexPolicy,
        ): Promise<ProcessedFileList>;
    proveIndexedGeneration(
            codebasePath: string,
            priorReceipt?: ProvenGenerationReceipt,
        ): Promise<ProvenGenerationReceipt | null>;
    publishNavigationCandidate(
        candidate: StagedNavigationSidecarGeneration,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void>;
    publishResolvedIndexPolicy(
            policy: ResolvedIndexPolicy,
            binding: IndexPolicyBinding,
            publishMutation?: (publish: () => void) => void,
        ): IndexPolicyPublicationReceipt;
    rebuildNavigationArtifacts(
            codebasePath: string,
            assertMutationCurrent?: () => void,
            publishMutation?: (publish: () => void) => void,
        ): Promise<void>;
    refreshRuntimePolicyAuthority(canonicalRoot: string): void;
    resolveCollectionName(codebasePath: string): string;
    resolveCompletionMarkerForCollection(
            codebasePath: string,
            collectionName: string
        ): Promise<IndexCompletionMarkerDocument | null>;
    resolveCompletionProofCollection(
            codebasePath: string,
        ): Promise<{ collectionName: string; marker: IndexCompletionMarkerDocument } | null>;
    resolveGenerationProofIdentity(
            canonicalRoot: string,
        ): Promise<string | null>;
    resolveIndexPolicyFromCurrentInputs(
            canonicalRoot: string,
            update: CustomIndexPolicyUpdate,
            inheritActiveCustomPolicy: boolean,
            activateRuntimeProfile: boolean,
        ): Promise<ObservedResolvedIndexPolicy>;
    resolveNavigationObservationToken(
            canonicalRoot: string,
            generationId: string,
            requireCurrentPointer?: boolean,
        ): string | null;
    resolveStagedCollectionName(codebasePath: string, generationId: string): string;
    setIndexProfileForCodebase(codebasePath: string, profile: IndexProfile): void;
    subtractEmbeddingMetrics(
        after: EmbeddingOperationMetricsSnapshot | null,
        before: EmbeddingOperationMetricsSnapshot | null,
    ): EmbeddingOperationMetricsSnapshot | null;
    subtractVectorWriteMetrics(
        after: VectorWriteMetricsSnapshot | null,
        before: VectorWriteMetricsSnapshot | null,
    ): VectorWriteMetricsSnapshot | null;
    summarizeVectorWriteMetrics(
        metrics: VectorWriteMetricsSnapshot | null,
        logicalRows: number,
    ): Record<string, unknown> | null;
    verifyCollectionPayloadMatchesCurrentSource(
            collectionName: string,
            codeFiles: string[],
            expectedChunks: ExpectedIndexedChunk[]
        ): Promise<CollectionPayloadVerification>;
    waitForPublicationRetention(canonicalRoot: string): Promise<void>;
    writeCompletedIndexMarker(
            codebasePath: string,
            indexedFiles: number,
            totalChunks: number,
            collectionName?: string,
            indexStatus?: 'completed' | 'limit_reached',
            assertMutationCurrent?: () => void,
            navigationCandidate?: StagedNavigationSidecarGeneration,
            indexPolicyHash?: string,
            runId?: string,
        ): Promise<IndexCompletionMarkerDocument>;
    buildIndexPolicyHash(codebasePath: string): string;

    readIndexableFileInsideRoot(
            absoluteFile: string,
            canonicalRoot: string,
            indexPolicy?: ResolvedIndexPolicy,
        ): Promise<string | null>;
    languageAnalyzer: LanguageAnalysisPort;
    semanticAnalyzer?: SemanticProjectAnalyzer;
    semanticLanguageRegistry?: SemanticLanguageRegistry;
    embedding: Embedding;
    vectorDatabase: VectorDatabase;
    symbolRegistryStateRoot: string | undefined;
    indexAuthorityCoordinator: IndexAuthorityCoordinator;
    indexPolicyRuntimeService: IndexPolicyRuntimeService;
    getSynchronizer(synchronizerKey: string): FileSynchronizer | undefined;
    registerSynchronizer(synchronizerKey: string, synchronizer: FileSynchronizer): void;
    getSynchronizerMutationTarget(synchronizerKey: string): string | undefined;
    setSynchronizerMutationTarget(synchronizerKey: string, collectionName: string): void;
    clearSynchronizerMutationTarget(synchronizerKey: string): void;
}


export class IndexGenerationWorkflow {
    /**
     * Phase 8.4A - the workflow owns the operation/capability warm state:
     * the prepared-receipt capability set and the per-codebase reindex
     * serialization queues, with their complete lifecycles.
     */
    private readonly preparedIndexCollectionReceipts =
        new WeakSet<PreparedIndexCollectionReceipt>();
    private readonly reindexByChangeQueues = new Map<string, Promise<void>>();
    /**
     * Phase 8.4B - the workflow also owns the navigation warm state:
     * the staged-delta WeakMap and the promoted delta, with the complete
     * stage -> promote -> delete lifecycle.
     */
    private navigationDeltaState?: CachedNavigationDeltaState;
    private readonly preparedNavigationDeltaStates =
        new WeakMap<StagedNavigationSidecarGeneration, CachedNavigationDeltaState>();

    constructor(private readonly ports: IndexGenerationWorkflowPorts) {}

    public stagePreparedNavigationDelta(
        candidate: StagedNavigationSidecarGeneration,
        state: CachedNavigationDeltaState,
    ): void {
        this.preparedNavigationDeltaStates.set(candidate, state);
    }

    public promotePreparedNavigationDelta(
        candidate: StagedNavigationSidecarGeneration,
        resolveNavigationObservationToken: () => string | null,
    ): void {
        const preparedDeltaState = this.preparedNavigationDeltaStates.get(candidate);
        const navigationObservationToken = preparedDeltaState
            ? resolveNavigationObservationToken()
            : null;
        if (preparedDeltaState && navigationObservationToken) {
            this.navigationDeltaState = {
                ...preparedDeltaState,
                navigationObservationToken,
            };
        }
        this.preparedNavigationDeltaStates.delete(candidate);
    }

    public registerPreparedIndexCollectionReceipt(
        receipt: PreparedIndexCollectionReceipt,
    ): void {
        this.preparedIndexCollectionReceipts.add(receipt);
    }

    public discardPreparedIndexCollectionReceipt(
        receipt: PreparedIndexCollectionReceipt,
    ): void {
        this.preparedIndexCollectionReceipts.delete(receipt);
    }

    public async stageSymbolRegistryForCompletedIndex(
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
        if (indexPolicy) {
            this.ports.assertResolvedIndexPolicyRoot(codebasePath, indexPolicy);
        }
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        const manifestFiles = [...symbolManifestFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const registry = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: canonicalRoot,
                rootFingerprint: this.ports.buildRootFingerprint(canonicalRoot),
                indexPolicyHash: indexPolicy?.policyHash ?? this.ports.buildIndexPolicyHash(codebasePath),
                languageRouterVersion: this.ports.getLanguageRouterVersion(),
                extractorVersion: this.ports.getSymbolExtractorVersion(),
                relationshipVersion: this.ports.getRelationshipVersion(),
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
            const content = await this.ports.readIndexableFileInsideRoot(absoluteFile, canonicalRoot, indexPolicy);
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
            const analysis = await this.ports.languageAnalyzer.analyze({
                content,
                language: file.language,
                relativePath: file.path,
            });
            analysisByFile.set(file.path, {
                moduleBindings: analysis.moduleBindings,
                callSites: analysis.callSites,
                receiverTypeBindings: analysis.receiverTypeBindings,
                pythonFlowFacts: analysis.pythonFlowFacts ?? [],
            });
        }


        const semanticEvidenceByLanguage = new Map<string, SemanticProjectEvidence>();
        if (this.ports.semanticAnalyzer && semanticSources && semanticSources.length > 0) {
            const sourcesByLanguage = new Map<string, SemanticSourceFile[]>();
            const registry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;

            for (const src of semanticSources) {
                const fileEntry = manifestFiles.find((f) => f.path === src.path);
                const lang = fileEntry?.language ?? '';
                if (this.ports.semanticAnalyzer.supportsLanguage(lang)) {
                    const list = sourcesByLanguage.get(lang) ?? [];
                    list.push(src);
                    sourcesByLanguage.set(lang, list);
                }
            }
            for (const [language, sourceFiles] of sourcesByLanguage) {
                const auxiliaryFiles = this.collectSemanticAuxiliariesForLanguage(codebasePath, language, registry);
                const evidence = await this.ports.semanticAnalyzer.analyze({
                    language,
                    sourceFiles,
                    auxiliaryFiles,
                });
                semanticEvidenceByLanguage.set(language, evidence);
            }
        }

        const relationshipRecords = buildRelationshipsForRegistry({
            registry,
            analysisByFile,
            semanticRegistry: this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry,
            semanticEvidenceByLanguage,
        });

        assertMutationCurrent?.();
        const result = await stageNavigationSidecarGeneration({
            stateRoot: this.ports.symbolRegistryStateRoot,
            registry,
            records: relationshipRecords,
            analysisByFile,
        });
        this.stagePreparedNavigationDelta(result, {
            canonicalRoot,
            generationId: result.generationId,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipManifestHash: result.relationshipManifestHash,
            navigationSealHash: result.navigationSealHash,
            registry,
            records: relationshipRecords,
            analysisByFile,
        });
        console.log(`[Context] 🧭 Staged navigation generation '${result.generationId}' with ${result.symbolCount} symbols across ${result.fileShardCount} symbol shards and ${result.relationshipCount} relationships across ${result.relationshipFileShardCount} relationship shards`);
        if (!deferPublication) {
            await this.ports.publishNavigationCandidate(
                result,
                assertMutationCurrent,
                publishMutation,
            );
        }
        return result;
    }


    refreshEmbedding(embedding: Embedding): void {
        this.ports.embedding = embedding;
    }

    refreshVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.ports.vectorDatabase = vectorDatabase;
    }


    private async clearCompletionMarkerAfterSyncFailure(
        codebasePath: string,
        collectionName: string,
        targetKnown: boolean,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        if (targetKnown) {
            await this.ports.clearIndexCompletionMarkerFromCollection(collectionName, assertMutationCurrent);
            return;
        }
        await this.clearIndexCompletionMarker(codebasePath, assertMutationCurrent);
    }

    async clearIndexCompletionMarker(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        collectionNameOverride?: string,
    ): Promise<void> {
        const collectionName = collectionNameOverride ?? this.ports.resolveCollectionName(codebasePath);
        const hasCollection = await this.ports.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            const activeCollectionName = await this.ports.getActiveIndexedCollectionName(codebasePath);
            if (!activeCollectionName) {
                return;
            }
            await this.ports.clearIndexCompletionMarkerFromCollection(activeCollectionName, assertMutationCurrent);
            return;
        }

        await this.ports.clearIndexCompletionMarkerFromCollection(collectionName, assertMutationCurrent);
    }

    private async consumePreparedIndexCollection(
        codebasePath: string,
        receipt: PreparedIndexCollectionReceipt,
        expectedBinding: PreparedIndexCollectionBinding,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        // WeakSet membership is the capability boundary. Matching strings are
        // insufficient because a caller could otherwise forge a receipt and
        // skip schema creation for a stale or unrelated collection.
        if (!this.preparedIndexCollectionReceipts.delete(receipt)) {
            throw new Error('Prepared index collection receipt is unknown or already consumed.');
        }

        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        if (
            receipt.canonicalRoot !== canonicalRoot
            || receipt.collectionName !== expectedBinding.collectionName
            || receipt.generation !== expectedBinding.generation
            || receipt.operationId !== expectedBinding.operationId
        ) {
            throw new Error('Prepared index collection receipt does not match the current mutation and staged collection.');
        }

        assertMutationCurrent?.();
        if (!await this.ports.vectorDatabase.hasCollection(receipt.collectionName)) {
            throw new Error(`Prepared staged collection '${receipt.collectionName}' no longer exists.`);
        }
        assertMutationCurrent?.();
    }

    private async finalizePreparedCollection(
        collectionName: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        if (!this.ports.getIsHybrid() || !this.ports.vectorDatabase.finalizeCollectionForSearch) {
            return;
        }
        // Authority publication must remain after this boundary. Before finalization the
        // collection accepts writes but is intentionally neither indexed nor searchable.
        assertMutationCurrent?.();
        await this.ports.vectorDatabase.finalizeCollectionForSearch(collectionName);
    }

    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false,
        options: MutationGuardOptions = {},
    ): Promise<IndexCodebaseResult> {
        const operationStartedAt = Date.now();
        // Batch policy and metrics are optional capabilities: structural embedding
        // adapters may implement indexing without inheriting the base defaults.
        const embeddingMetricsBefore = this.ports.embedding.getOperationMetricsSnapshot?.() ?? null;
        const vectorWriteMetricsBefore = this.ports.vectorDatabase.getWriteMetricsSnapshot?.() ?? null;
        let prepareCollectionMs = 0;
        let scanFilesMs = 0;
        let payloadPipelineMs = 0;
        let finalizeCollectionMs = 0;
        let navigationMs = 0;
        let publicationMs = 0;
        assertDescriptorBoundIndexingSupported();
        if (options.indexPolicy) {
            this.ports.assertResolvedIndexPolicyRoot(codebasePath, options.indexPolicy);
        }
        const isHybrid = this.ports.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);

        if (options.indexPolicy) {
            this.ports.setIndexProfileForCodebase(codebasePath, options.indexPolicy.profile);
        } else {
            this.ports.loadIndexProfileForCodebase(codebasePath);
        }
        const indexPolicy = options.indexPolicy
            ?? await this.resolveIndexPolicyForCodebase(codebasePath);

        let preparedSourceContract: {
            readonly canonicalRoot: string;
            readonly supportedExtensions: readonly string[];
            readonly effectiveIgnorePatterns: readonly string[];
            readonly fullHashRun: boolean;
            readonly partialScan: boolean;
            readonly unscannedDirPrefixes: readonly string[];
            readonly merkleRoot: string;
        } | null = null;
        let localPreparedFileHashes: Map<string, string> | null = null;

        if (options.preparedChanges) {
            assertAuthenticPreparedFileChangeSet(options.preparedChanges);
            if (!options.preparedChanges.sourceContract) {
                throw new Error('[Context] Prepared change set is not authority-bound (missing sourceContract).');
            }
            const contract = options.preparedChanges.sourceContract;
            const canonicalTarget = FileSynchronizer.canonicalizeSnapshotIdentityPath(codebasePath);
            if (contract.canonicalRoot !== canonicalTarget) {
                throw new Error(
                    `[Context] Prepared change set was created for canonical root '${contract.canonicalRoot}', not '${canonicalTarget}'.`,
                );
            }
            const normalizedTargetExtensions = normalizeSupportedExtensions(indexPolicy.supportedExtensions);
            const sourceExts = new Set(contract.supportedExtensions);
            const targetExts = new Set(normalizedTargetExtensions);
            if (
                sourceExts.size !== targetExts.size
                || !Array.from(sourceExts).every((ext) => targetExts.has(ext))
            ) {
                throw new Error(
                    '[Context] Prepared change set supported extensions do not match the active index policy.',
                );
            }
            if (
                contract.effectiveIgnorePatterns.length !== indexPolicy.effectiveIgnorePatterns.length
                || !contract.effectiveIgnorePatterns.every((p, i) => p === indexPolicy.effectiveIgnorePatterns[i])
            ) {
                throw new Error(
                    '[Context] Prepared change set ignore patterns do not match the active index policy.',
                );
            }
            if (!contract.fullHashRun) {
                throw new Error('[Context] Prepared change set must be a full-hash scan.');
            }
            if (contract.partialScan) {
                throw new Error('[Context] Prepared change set must not be a partial scan.');
            }
            if (contract.unscannedDirPrefixes.length > 0) {
                throw new Error('[Context] Prepared change set has unscanned directory prefixes.');
            }

            const snapshottedHashes = new Map(options.preparedChanges.fileHashes);
            const computedRoot = computeMerkleRoot(snapshottedHashes);
            if (computedRoot !== contract.merkleRoot) {
                throw new Error(
                    `[Context] Prepared change set file hashes do not match bound source contract merkle root (expected '${contract.merkleRoot}', got '${computedRoot}').`,
                );
            }
            preparedSourceContract = Object.freeze({
                canonicalRoot: contract.canonicalRoot,
                supportedExtensions: Object.freeze([...contract.supportedExtensions]),
                effectiveIgnorePatterns: Object.freeze([...contract.effectiveIgnorePatterns]),
                fullHashRun: contract.fullHashRun,
                partialScan: contract.partialScan,
                unscannedDirPrefixes: Object.freeze([...contract.unscannedDirPrefixes]),
                merkleRoot: contract.merkleRoot,
            });
            localPreparedFileHashes = snapshottedHashes;
        }

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        // indexCodebase is a full rebuild. Reusing an existing collection would retain
        // remote rows for deleted files or changed chunk boundaries.
        // Forced preparation replaces the collection, so the new schema cannot contain
        // an old completion marker. Do not query it to clear one: hybrid rebuilds keep
        // this collection deliberately indexless until all payload writes are complete.
        // Phase 8.5 - the operation-scoped write target: the consumed receipt
        // names the staged collection; an explicit option covers receipt-less
        // staged rebuilds; otherwise the family name is the target.
        const preparedCollectionBinding = options.preparedCollectionBinding
            ? {
                ...options.preparedCollectionBinding,
                collectionName: options.preparedCollectionBinding.collectionName
                    ?? options.preparedCollectionReceipt?.collectionName
                    ?? this.ports.resolveCollectionName(codebasePath),
            }
            : undefined;
        const writeCollectionName = options.preparedCollectionReceipt?.collectionName
            ?? options.writeCollectionName
            ?? this.ports.resolveCollectionName(codebasePath);
        const prepareStartedAt = Date.now();
        if (options.preparedCollectionReceipt) {
            if (!preparedCollectionBinding) {
                throw new Error('Prepared index collection binding is required with its receipt.');
            }
            await this.consumePreparedIndexCollection(
                codebasePath,
                options.preparedCollectionReceipt,
                preparedCollectionBinding,
                options.assertMutationCurrent,
            );
        } else if (preparedCollectionBinding) {
            throw new Error('Prepared index collection receipt is required with its binding.');
        } else {
            await this.ports.prepareCollection(
                codebasePath,
                true,
                options.assertMutationCurrent,
                writeCollectionName,
            );
        }
        prepareCollectionMs = Date.now() - prepareStartedAt;

        // 3. Prepare exact source observation before indexing
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const scanStartedAt = Date.now();
        await FileSynchronizer.deleteSnapshotForGeneration(codebasePath, writeCollectionName).catch(() => undefined);
        const synchronizer = options.preparedChanges ? null : new FileSynchronizer(
            codebasePath,
            indexPolicy.effectiveIgnorePatterns,
            indexPolicy.supportedExtensions,
        );
        const preparedChanges = options.preparedChanges
            ?? await synchronizer!.prepareChanges({ forceFullHash: true });
        if (!preparedSourceContract) {
            preparedSourceContract = preparedChanges.sourceContract!;
        }
        if (!localPreparedFileHashes) {
            localPreparedFileHashes = new Map(preparedChanges.fileHashes);
        }
        const codeFiles = Array.from(localPreparedFileHashes.keys())
            .sort()
            .map((relativePath) => path.join(codebasePath, relativePath));
        scanFilesMs = Date.now() - scanStartedAt;
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
            let checkpointStaged = false;
            let activated = false;
            try {
                await this.finalizePreparedCollection(writeCollectionName, options.assertMutationCurrent);
                navigationCandidate = await this.stageSymbolRegistryForCompletedIndex(
                    codebasePath,
                    [],
                    [],
                    options.assertMutationCurrent,
                    new Map(),
                    options.publishMutation,
                    true,
                    indexPolicy,
                );

                if (!options.deferFullIndexPublication) {
                    const publicationStartedAt = Date.now();
                    await this.ports.writeCompletedIndexMarker(codebasePath, 0, 0, writeCollectionName, 'completed', options.assertMutationCurrent, navigationCandidate, indexPolicy.policyHash);
                    const marker = await this.ports.resolveCompletionMarkerForCollection(
                        codebasePath,
                        writeCollectionName,
                    );
                    if (!marker) {
                        throw new Error(`Completed index did not produce a completion marker for '${writeCollectionName}'.`);
                    }
                    const isSealed = navigationCandidate !== undefined && marker.navigation.status === 'sealed';
                    let publication: CanonicalPublicationBinding | undefined = undefined;
                    let checkpoint: StagedSourceFreshnessCheckpoint | undefined = undefined;
                    let checkpointAuthority: SourceFreshnessCheckpointAuthority | undefined = undefined;
                    if (isSealed) {
                        checkpointAuthority = {
                            collectionName: writeCollectionName,
                            markerRunId: marker.runId,
                            indexPolicyHash: indexPolicy.policyHash,
                        };
                        checkpoint = await preparedChanges.stageCheckpoint(checkpointAuthority);
                        checkpointStaged = true;
                        if (checkpoint.merkleRoot !== preparedSourceContract.merkleRoot) {
                            throw new Error(
                                `[Context] Staged source checkpoint merkle root '${checkpoint.merkleRoot}' does not match bound source contract '${preparedSourceContract.merkleRoot}'.`,
                            );
                        }
                        await preparedChanges.assertSourceObservationCurrent();
                        options.assertMutationCurrent?.();
                        publication = {
                            activationId: marker.runId,
                            sourceCheckpoint: {
                                collectionName: writeCollectionName,
                                markerRunId: marker.runId,
                                indexPolicyHash: indexPolicy.policyHash,
                                merkleRoot: checkpoint.merkleRoot,
                                documentDigest: checkpoint.documentDigest,
                            },
                            graph: {
                                kind: 'relationship_manifest_v2',
                                manifestHash: marker.navigation.status === 'sealed' ? marker.navigation.relationshipManifestHash : '0'.repeat(64),
                            },
                            receipt: {
                                ownerId: 'core-internal',
                                generation: 1,
                                operationId: marker.runId,
                            },
                        };
                    }
                    await this.publishResolvedPolicyForMarker(indexPolicy, {
                        collectionName: writeCollectionName,
                        navigation: (isSealed && navigationCandidate) ? {
                            status: 'sealed',
                            generationId: navigationCandidate.generationId,
                            sealHash: navigationCandidate.navigationSealHash,
                        } : { status: 'not_bound' },
                        ...(publication ? { publication } : {}),
                    }, marker, options.publishMutation);
                    activated = true;
                    if (isSealed && checkpoint && checkpointAuthority) {
                        preparedChanges.promoteStagedCheckpoint?.(checkpoint, checkpointAuthority);
                    }
                    if (synchronizer) {
                        this.ports.registerSynchronizer(writeCollectionName, synchronizer);
                        this.ports.registerSynchronizer(this.ports.resolveCollectionName(codebasePath), synchronizer);
                    }
                    if (navigationCandidate) {
                        await this.ports.publishNavigationCandidate(navigationCandidate).catch((err) => {
                            console.warn('[Context] Failed to update auxiliary navigation pointer:', err);
                        });
                    }
                    publicationMs = Date.now() - publicationStartedAt;
                }
                progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
                return {
                    indexedFiles: 0,
                    totalChunks: 0,
                    status: 'completed',
                    indexedFileHashes: new Map(),
                    ...(navigationCandidate ? { navigationCandidate } : {}),
                };
            } catch (error) {
                if (
                    error instanceof IndexPolicyPublicationError
                    && error.receipt.operation === 'publish'
                    && error.receipt.collectionName === writeCollectionName
                ) {
                    activated = true;
                }
                if (!activated) {
                    if (navigationCandidate) {
                        await discardNavigationSidecarGeneration(navigationCandidate).catch(() => undefined);
                    }
                    if (checkpointStaged) {
                        await FileSynchronizer.deleteSnapshotForGeneration(codebasePath, writeCollectionName).catch(() => undefined);
                    }
                    if (isStagedGenerationCollectionName(writeCollectionName)) {
                        await this.ports.vectorDatabase.dropCollection(writeCollectionName).catch(() => undefined);
                    }
                }
                throw error;
            }
        }

        // 3. Process each file with streaming chunk processing
        // Reserve 10% for preparation, 90% for actual indexing
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 100;
        const indexingRange = indexingEndPercentage - indexingStartPercentage;

        let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
        let checkpointStaged = false;
        let activated = false;
        let result: ProcessedFileList;
        try {
            const payloadStartedAt = Date.now();
            result = await this.ports.processFileList(
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
                writeCollectionName,
                options.assertMutationCurrent,
                indexPolicy,
            );
            payloadPipelineMs = Date.now() - payloadStartedAt;

            if (result.status === 'completed') {
                const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
                assertExactIndexedFileHashesMatchPrepared(
                    result.indexedFileHashes,
                    localPreparedFileHashes,
                    (f) => semanticRegistry.isAuxiliaryPath(f),
                );
            }

            const finalizeStartedAt = Date.now();
            await this.finalizePreparedCollection(writeCollectionName, options.assertMutationCurrent);
            finalizeCollectionMs = Date.now() - finalizeStartedAt;

            console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

            if (result.status === 'completed') {
                const navigationStartedAt = Date.now();
                navigationCandidate = await this.stageSymbolRegistryForCompletedIndex(
                    codebasePath,
                    result.symbolRecords,
                    result.symbolManifestFiles,
                    options.assertMutationCurrent,
                    result.analysisByFile,
                    options.publishMutation,
                    true,
                    indexPolicy,
                    result.semanticSources,
                );

                navigationMs = Date.now() - navigationStartedAt;
                if (!options.deferFullIndexPublication) {
                    const publicationStartedAt = Date.now();
                    await this.ports.writeCompletedIndexMarker(codebasePath, result.processedFiles, result.totalChunks, writeCollectionName, 'completed', options.assertMutationCurrent, navigationCandidate, indexPolicy.policyHash);
                    const marker = await this.ports.resolveCompletionMarkerForCollection(
                        codebasePath,
                        writeCollectionName,
                    );
                    if (!marker) {
                        throw new Error(`Completed index did not produce a completion marker for '${writeCollectionName}'.`);
                    }
                    const isSealed = navigationCandidate !== undefined && marker.navigation.status === 'sealed';
                    let publication: CanonicalPublicationBinding | undefined = undefined;
                    let checkpoint: StagedSourceFreshnessCheckpoint | undefined = undefined;
                    let checkpointAuthority: SourceFreshnessCheckpointAuthority | undefined = undefined;
                    if (isSealed) {
                        checkpointAuthority = {
                            collectionName: writeCollectionName,
                            markerRunId: marker.runId,
                            indexPolicyHash: indexPolicy.policyHash,
                        };
                        checkpoint = await preparedChanges.stageCheckpoint(checkpointAuthority);
                        checkpointStaged = true;
                        if (checkpoint.merkleRoot !== preparedSourceContract.merkleRoot) {
                            throw new Error(
                                `[Context] Staged source checkpoint merkle root '${checkpoint.merkleRoot}' does not match bound source contract '${preparedSourceContract.merkleRoot}'.`,
                            );
                        }
                        await preparedChanges.assertSourceObservationCurrent();
                        options.assertMutationCurrent?.();
                        publication = {
                            activationId: marker.runId,
                            sourceCheckpoint: {
                                collectionName: writeCollectionName,
                                markerRunId: marker.runId,
                                indexPolicyHash: indexPolicy.policyHash,
                                merkleRoot: checkpoint.merkleRoot,
                                documentDigest: checkpoint.documentDigest,
                            },
                            graph: {
                                kind: 'relationship_manifest_v2',
                                manifestHash: (marker.navigation.status === 'sealed' && marker.navigation.relationshipManifestHash)
                                    ? marker.navigation.relationshipManifestHash
                                    : '0'.repeat(64),
                            },
                            receipt: {
                                ownerId: 'core-internal',
                                generation: 1,
                                operationId: marker.runId,
                            },
                        };
                    }
                    await this.publishResolvedPolicyForMarker(indexPolicy, {
                        collectionName: writeCollectionName,
                        navigation: (isSealed && navigationCandidate) ? {
                            status: 'sealed',
                            generationId: navigationCandidate.generationId,
                            sealHash: navigationCandidate.navigationSealHash,
                        } : { status: 'not_bound' },
                        ...(publication ? { publication } : {}),
                    }, marker, options.publishMutation);
                    activated = true;
                    if (isSealed && checkpoint && checkpointAuthority) {
                        preparedChanges.promoteStagedCheckpoint?.(checkpoint, checkpointAuthority);
                    }
                    if (synchronizer) {
                        this.ports.registerSynchronizer(writeCollectionName, synchronizer);
                        this.ports.registerSynchronizer(this.ports.resolveCollectionName(codebasePath), synchronizer);
                    }
                    if (navigationCandidate) {
                        await this.ports.publishNavigationCandidate(navigationCandidate).catch((err) => {
                            console.warn('[Context] Failed to update auxiliary navigation pointer:', err);
                        });
                    }
                    publicationMs = Date.now() - publicationStartedAt;
                }
            } else {
                // limit_reached: do not publish complete navigation sidecars, but seal partial vector
                // proof so MCP readiness can allow warned partial search (not "missing marker" stale_local).
                // indexStatus must stay on the marker so interrupted-index recovery does not promote as fully completed.
                console.warn('[Context] ⚠️  Skipping symbol registry sidecar write because indexing stopped before processing the full file set.');
                if (!options.deferFullIndexPublication) {
                    const publicationStartedAt = Date.now();
                    await this.ports.writeCompletedIndexMarker(codebasePath, result.processedFiles, result.totalChunks, writeCollectionName, 'limit_reached', options.assertMutationCurrent, undefined, indexPolicy.policyHash);
                    const marker = await this.ports.resolveCompletionMarkerForCollection(
                        codebasePath,
                        writeCollectionName,
                    );
                    if (!marker) {
                        throw new Error(`Partial index did not produce a completion marker for '${writeCollectionName}'.`);
                    }
                    await this.publishResolvedPolicyForMarker(indexPolicy, {
                        collectionName: writeCollectionName,
                        navigation: { status: 'not_bound' },
                    }, marker, options.publishMutation);
                    activated = true;
                    console.warn('[Context] ⚠️  Wrote completion marker for limit_reached partial index (navigation remains unpublished).');
                    publicationMs = Date.now() - publicationStartedAt;
                }
            }
        } catch (error) {
            if (
                error instanceof IndexPolicyPublicationError
                && error.receipt.operation === 'publish'
                && error.receipt.collectionName === writeCollectionName
            ) {
                activated = true;
            }
            if (!activated) {
                if (navigationCandidate) {
                    await discardNavigationSidecarGeneration(navigationCandidate).catch(() => undefined);
                }
                if (checkpointStaged) {
                    await FileSynchronizer.deleteSnapshotForGeneration(codebasePath, writeCollectionName).catch(() => undefined);
                }
                if (isStagedGenerationCollectionName(writeCollectionName)) {
                    await this.ports.vectorDatabase.dropCollection(writeCollectionName).catch(() => undefined);
                }
            }
            throw error;
        }

        progressCallback?.({
            phase: result.status === 'completed' ? 'Indexing complete!' : 'Indexing stopped at chunk limit',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100
        });

        const embeddingMetrics = this.ports.subtractEmbeddingMetrics(
            this.ports.embedding.getOperationMetricsSnapshot?.() ?? null,
            embeddingMetricsBefore,
        );
        const vectorWriteMetrics = this.ports.subtractVectorWriteMetrics(
            this.ports.vectorDatabase.getWriteMetricsSnapshot?.() ?? null,
            vectorWriteMetricsBefore,
        );
        const vectorWriteSummary = this.ports.summarizeVectorWriteMetrics(
            vectorWriteMetrics,
            result.totalChunks,
        );
        const pipelinePerformance = result.performance ?? {
            analysisMs: 0,
            embeddedInputBytes: 0,
            logicalEmbeddingRequests: 0,
            logicalEmbeddingDurationMs: 0,
            logicalVectorWriteRequests: 0,
            logicalVectorWriteDurationMs: 0,
        };
        // This single bounded record intentionally contains counts and timings,
        // never source text, paths, provider credentials, or request payloads.
        console.log(`[Context] 📊 Indexing performance: ${JSON.stringify({
            totalMs: Date.now() - operationStartedAt,
            phaseMs: {
                prepareCollection: prepareCollectionMs,
                scanFiles: scanFilesMs,
                payloadPipeline: payloadPipelineMs,
                analysis: pipelinePerformance.analysisMs,
                finalizeCollection: finalizeCollectionMs,
                navigation: navigationMs,
                publication: publicationMs,
            },
            payload: {
                files: result.processedFiles,
                chunks: result.totalChunks,
                embeddedInputBytes: pipelinePerformance.embeddedInputBytes,
            },
            embedding: {
                logicalRequests: pipelinePerformance.logicalEmbeddingRequests,
                logicalDurationMs: pipelinePerformance.logicalEmbeddingDurationMs,
                provider: embeddingMetrics,
            },
            vectorWrites: {
                logicalRequests: pipelinePerformance.logicalVectorWriteRequests,
                logicalDurationMs: pipelinePerformance.logicalVectorWriteDurationMs,
                provider: vectorWriteSummary,
            },
        })}`);

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status,
            indexedFileHashes: result.indexedFileHashes,
            ...(navigationCandidate ? { navigationCandidate } : {}),
        };
    }

    private async performAtomicDeltaPublication(input: {
        codebasePath: string;
        canonicalRoot: string;
        sourceCollectionName: string;
        previousMarker: IndexCompletionMarkerDocument;
        sealedPolicy: ResolvedIndexPolicy;
        synchronizerKey: string;
        preparedChanges: Awaited<ReturnType<FileSynchronizer['prepareChanges']>>;
        options: ReindexByChangeOptions;
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void;
    }): Promise<ReindexByChangeResult> {
        const measurePublicationPhase = async <T>(
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
            run: () => Promise<T>,
        ): Promise<T> => {
            const startedAt = performance.now();
            try {
                return await run();
            } finally {
                input.options.onPhaseTiming?.(
                    phase,
                    Math.max(0, performance.now() - startedAt),
                );
            }
        };
        const { added, removed, modified } = input.preparedChanges.changes;
        const changedFiles = Array.from(new Set([...added, ...removed, ...modified]));
        const totalChanges = changedFiles.length;
        const sourceNavigation = input.previousMarker.navigation.status === 'sealed'
            ? input.previousMarker.navigation
            : null;
        if (!sourceNavigation) {
            throw new Error('Atomic delta publication requires a sealed source navigation generation; reindex is required.');
        }
        if (!this.ports.vectorDatabase.forkCollection) {
            throw new AtomicIncrementalPublicationUnsupportedError();
        }
        const reusableNavigationState = this.resolveReusableNavigationDeltaState(
            input.canonicalRoot,
            sourceNavigation,
        );
        let existingRegistry: SymbolRegistry;
        if (reusableNavigationState) {
            existingRegistry = reusableNavigationState.registry;
        } else {
            existingRegistry = await measurePublicationPhase(
                'publication_source_navigation_load',
                async () => {
                    const expectedSealHash = sourceNavigation.sealHash;
                    const sealRead = await readNavigationGenerationSeal(
                        this.ports.symbolRegistryStateRoot,
                        input.canonicalRoot,
                        sourceNavigation.generationId,
                    );
                    const registryRead = await readSymbolRegistrySidecar({
                        stateRoot: this.ports.symbolRegistryStateRoot,
                        normalizedRootPath: input.canonicalRoot,
                        generationId: sourceNavigation.generationId,
                    });
                    if (sealRead.status !== 'ok'
                        || sealRead.seal.symbolRegistryManifestHash
                            !== sourceNavigation.symbolRegistryManifestHash
                        || sealRead.seal.relationshipManifestHash
                            !== sourceNavigation.relationshipManifestHash
                        || computeNavigationGenerationSealHash(sealRead.seal) !== expectedSealHash
                        || registryRead.status !== 'ok'
                        || registryRead.manifestHash !== sourceNavigation.symbolRegistryManifestHash) {
                        throw new Error('Atomic delta publication cannot prove its source navigation metadata; reindex is required.');
                    }
                    return registryRead.registry;
                },
            );
        }

        const activationId = crypto.randomUUID();
        const candidateCollectionName = this.ports.resolveStagedCollectionName(input.codebasePath, activationId);
        const markerRunId = crypto.randomUUID();
        let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
        let checkpointStaged = false;
        let activated = false;
        const releaseStagedPublication = await this.ports.indexAuthorityCoordinator.acquireStagedPublicationLease(
            input.canonicalRoot,
            activationId,
        );
        try {
            input.options.assertMutationCurrent?.();
            await measurePublicationPhase(
                'publication_fork',
                () => this.ports.vectorDatabase.forkCollection!(
                    input.sourceCollectionName,
                    candidateCollectionName,
                ),
            );

            const payloadDelta = await measurePublicationPhase(
                'publication_payload_delta',
                async () => {
                    let replacedPayloadCount = 0;
                    for (const relativePath of changedFiles) {
                        const pathCount = await this.ports.countIndexedPayloadExactly(
                            candidateCollectionName,
                            { kind: 'comparison', field: 'relativePath', operator: 'eq', value: relativePath },
                            input.previousMarker.totalChunks,
                        );
                        if (pathCount === null) {
                            throw new Error(`Atomic delta publication could not count existing payload for '${relativePath}'.`);
                        }
                        replacedPayloadCount += pathCount;
                        await this.ports.deleteFileChunks(candidateCollectionName, relativePath, input.options.assertMutationCurrent);
                    }

                    let processedChanges = 0;
                    const filesToIndex = [...added, ...modified].map((file) => path.join(input.codebasePath, file));
                    const indexedDelta = filesToIndex.length > 0
                        ? await this.ports.processFileList(
                            filesToIndex,
                            input.codebasePath,
                            (filePath) => {
                                processedChanges += 1;
                                input.progressCallback?.({
                                    phase: `Indexed ${filePath}`,
                                    current: processedChanges,
                                    total: totalChanges,
                                    percentage: Math.round((processedChanges / totalChanges) * 100),
                                });
                            },
                            candidateCollectionName,
                            input.options.assertMutationCurrent,
                        )
                        : {
                            processedFiles: 0,
                            totalChunks: 0,
                            status: 'completed' as const,
                            symbolRecords: [] as SymbolRecord[],
                            symbolManifestFiles: [] as SymbolRegistryManifestFile[],
                            analysisByFile: new Map<string, RelationshipAnalysisEvidence>(),
                        };
                    return { indexedDelta, replacedPayloadCount };
                },
            );
            const { indexedDelta, replacedPayloadCount } = payloadDelta;
            if (indexedDelta.status !== 'completed') {
                throw new Error('Atomic delta publication stopped before every changed file was indexed.');
            }
            const totalChunks = input.previousMarker.totalChunks - replacedPayloadCount + indexedDelta.totalChunks;
            if (!Number.isSafeInteger(totalChunks) || totalChunks < 0) {
                throw new Error('Atomic delta publication produced an invalid payload count.');
            }

            const checkpointAuthority = {
                collectionName: candidateCollectionName,
                markerRunId,
                indexPolicyHash: input.sealedPolicy.policyHash,
            };
            const navigationPromise = measurePublicationPhase(
                'publication_navigation_delta',
                () => this.rebuildNavigationArtifactsForSyncDelta(
                    input.codebasePath,
                    existingRegistry,
                    changedFiles,
                    indexedDelta.symbolRecords,
                    indexedDelta.symbolManifestFiles,
                    input.options.assertMutationCurrent,
                    indexedDelta.analysisByFile,
                    undefined,
                    sourceNavigation.generationId,
                    true,
                    reusableNavigationState,
                    input.options.onPhaseTiming,
                ),
            ).then((result) => {
                const candidate = result.candidate;
                if (!candidate) {
                    throw new Error('Atomic delta publication cannot publish a repository without navigation state.');
                }
                navigationCandidate = candidate;
                return result;
            });
            const checkpointPromise = measurePublicationPhase(
                'publication_checkpoint_stage',
                () => input.preparedChanges.stageCheckpoint(
                    checkpointAuthority,
                    input.options.assertMutationCurrent,
                ),
            ).then((checkpoint) => {
                checkpointStaged = true;
                return checkpoint;
            });
            const payloadCountPromise = measurePublicationPhase(
                'publication_payload_count',
                () => this.ports.countIndexedPayloadExactly(
                    candidateCollectionName,
                    undefined,
                    totalChunks,
                ),
            );
            let candidateResults: Awaited<ReturnType<typeof Promise.all<[
                typeof navigationPromise,
                typeof checkpointPromise,
                typeof payloadCountPromise,
            ]>>>;
            try {
                candidateResults = await measurePublicationPhase(
                    'publication_navigation_checkpoint',
                    () => Promise.all([
                        navigationPromise,
                        checkpointPromise,
                        payloadCountPromise,
                    ]),
                );
            } catch (error) {
                await Promise.allSettled([navigationPromise, checkpointPromise, payloadCountPromise]);
                throw error;
            }
            const [preparedNavigationResult, checkpoint, observedTotalChunks] = candidateResults;
            const preparedNavigation = preparedNavigationResult.candidate;
            if (!preparedNavigation || !preparedNavigationResult.state) {
                throw new Error('Atomic delta publication did not prepare reusable navigation state.');
            }
            const preparedNavigationState = preparedNavigationResult.state;
            const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
            const searchablePreparedFileHashes = new Map(
                [...input.preparedChanges.fileHashes.entries()].filter(([filePath]) => !semanticRegistry.isAuxiliaryPath(filePath)),
            );
            const activationResult = await measurePublicationPhase(
                'publication_activation',
                async () => {
                    await this.verifyPreparedSyncPublication(
                        input.codebasePath,
                        candidateCollectionName,
                        input.preparedChanges.fileHashes,
                        totalChunks,
                        preparedNavigation,
                        observedTotalChunks,
                    );
                    const publishedMarker = await this.ports.writeCompletedIndexMarker(
                        input.codebasePath,
                        searchablePreparedFileHashes.size,
                        totalChunks,
                        candidateCollectionName,
                        'completed',
                        input.options.assertMutationCurrent,
                        preparedNavigation,
                        input.sealedPolicy.policyHash,
                        markerRunId,
                    );
                    const activeDataObservation = this.ports.vectorDatabase.getCollectionDataObservation
                        ? await this.ports.vectorDatabase.getCollectionDataObservation(candidateCollectionName)
                        : undefined;

                    const authority = input.options.publicationAuthority ?? {
                        ownerId: 'core-internal',
                        generation: 1,
                        operationId: activationId,
                    };
                    const publication: CanonicalPublicationBinding = {
                        activationId,
                        sourceCheckpoint: {
                            ...checkpointAuthority,
                            merkleRoot: checkpoint.merkleRoot,
                            documentDigest: checkpoint.documentDigest,
                        },
                        graph: {
                            kind: 'relationship_manifest_v2',
                            manifestHash: preparedNavigation.relationshipManifestHash,
                        },
                        receipt: {
                            ownerId: authority.ownerId,
                            generation: authority.generation,
                            operationId: authority.operationId,
                        },
                    };
                    await input.preparedChanges.assertSourceObservationCurrent();
                    input.options.assertMutationCurrent?.();
                    let publicationError: unknown = null;
                    try {
                        this.ports.publishResolvedIndexPolicy(
                            input.sealedPolicy,
                            {
                                collectionName: candidateCollectionName,
                                navigation: {
                                    status: 'sealed',
                                    generationId: preparedNavigation.generationId,
                                    sealHash: preparedNavigation.navigationSealHash,
                                },
                                publication,
                            },
                            input.options.publishMutation,
                        );
                        activated = true;
                    } catch (error) {
                        if (
                            error instanceof IndexPolicyPublicationError
                            && error.receipt.operation === 'publish'
                            && error.receipt.collectionName === candidateCollectionName
                            && error.receipt.publication?.activationId === activationId
                        ) {
                            activated = true;
                            this.ports.refreshRuntimePolicyAuthority(input.canonicalRoot);
                            publicationError = error;
                        } else {
                            throw error;
                        }
                    }
                    if (activated) {
                        input.preparedChanges.promoteStagedCheckpoint?.(checkpoint, checkpointAuthority);
                        await this.ports.publishNavigationCandidate(
                            preparedNavigation,
                            input.options.assertMutationCurrent,
                            input.options.publishMutation,
                        ).catch((pointerError) => {
                            console.warn('[Context] Committed delta generation could not update auxiliary navigation pointer:', pointerError);
                        });
                    }
                    if (publicationError) {
                        throw publicationError;
                    }
                    const navigationObservationToken = this.ports.resolveNavigationObservationToken(
                        input.canonicalRoot,
                        preparedNavigation.generationId,
                        false,
                    );
                    this.navigationDeltaState = navigationObservationToken
                        ? {
                            ...preparedNavigationState,
                            navigationObservationToken,
                        }
                        : undefined;

                    const generationReceipt = await this.ports.indexAuthorityCoordinator.recordActivatedGenerationProof({
                        canonicalRoot: input.canonicalRoot,
                        marker: publishedMarker,
                        policy: input.sealedPolicy,
                        exactPayloadCount: totalChunks,
                        navigation: {
                            generationId: preparedNavigation.generationId,
                            generationRoot: preparedNavigation.rootPath,
                            symbolRegistryManifestHash: preparedNavigation.manifestHash,
                            relationshipManifestHash: preparedNavigation.relationshipManifestHash,
                            navigationSealHash: preparedNavigation.navigationSealHash,
                        },
                    });
                    if (!generationReceipt) {
                        throw new Error(
                            `Atomic delta publication for '${input.codebasePath}' could not bind its activated generation proof.`,
                        );
                    }
                    return { activeDataObservation, generationReceipt };
                },
            );

            const generationReceipt = await measurePublicationPhase(
                'publication_retention_proof',
                async () => {
                    const nextSynchronizer = new FileSynchronizer(
                        input.codebasePath,
                        this.ports.getActiveIgnorePatterns(input.codebasePath),
                        this.ports.getIndexedExtensionsForCodebase(input.codebasePath),
                        { checkpointIdentity: candidateCollectionName, checkpointAuthority },
                    );
                    await nextSynchronizer.initialize(undefined, undefined, { requireExistingCheckpoint: true });
                    this.ports.registerSynchronizer(input.synchronizerKey, nextSynchronizer);
                    this.ports.indexAuthorityCoordinator.schedulePublicationRetention({
                        canonicalRoot: input.canonicalRoot,
                        activationId,
                        activeCollectionName: candidateCollectionName,
                        previousCollectionName: input.sourceCollectionName,
                        activeNavigationGenerationId: preparedNavigation.generationId,
                        previousNavigationGenerationId: sourceNavigation.generationId,
                        ...(activationResult.activeDataObservation
                            ? { activeDataObservation: activationResult.activeDataObservation }
                            : {}),
                    });
                    if (
                        this.ports.indexAuthorityCoordinator.hasActivePublicationReaders(input.canonicalRoot)
                    ) {
                        return activationResult.generationReceipt;
                    }
                    await this.ports.waitForPublicationRetention(input.canonicalRoot);
                    const retainedGenerationReceipt = await this.ports.proveIndexedGeneration(
                        input.canonicalRoot,
                    );
                    if (!retainedGenerationReceipt) {
                        throw new Error(
                            `Atomic delta publication for '${input.codebasePath}' is not readable after generation retention.`,
                        );
                    }
                    const retainedGenerationIdentity = await this.ports.resolveGenerationProofIdentity(
                        input.canonicalRoot,
                    );
                    if (!retainedGenerationIdentity) {
                        throw new Error(
                            `Atomic delta publication for '${input.codebasePath}' lost its retained generation identity.`,
                        );
                    }
                    this.ports.indexAuthorityCoordinator.setPreparedGenerationReceipt(
                        retainedGenerationReceipt,
                        retainedGenerationIdentity,
                    );
                    return retainedGenerationReceipt;
                },
            );

            return {
                added: added.length,
                removed: removed.length,
                modified: modified.length,
                changedFiles,
                collectionName: candidateCollectionName,
                indexedFiles: searchablePreparedFileHashes.size,
                totalChunks,
                indexStatus: 'completed',
                generationReceipt,
            };
        } catch (error) {
            if (
                error instanceof IndexPolicyPublicationError
                && error.receipt.operation === 'publish'
                && error.receipt.collectionName === candidateCollectionName
            ) {
                activated = true;
            }
            if (!activated) {
                if (navigationCandidate) {
                    await discardNavigationSidecarGeneration(navigationCandidate).catch(() => undefined);
                }
                if (checkpointStaged) {
                    await FileSynchronizer.deleteSnapshotForGeneration(
                        input.codebasePath,
                        candidateCollectionName,
                    ).catch(() => undefined);
                }
                await this.ports.vectorDatabase.dropCollection(candidateCollectionName).catch(() => undefined);
            }
            throw error;
        } finally {
            releaseStagedPublication();
        }
    }

    private async performReindexByChange(
        codebasePath: string,
        progressCallback: ((progress: { phase: string; current: number; total: number; percentage: number }) => void) | undefined,
        options: ReindexByChangeOptions,
    ): Promise<ReindexByChangeResult> {
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        this.ports.refreshRuntimePolicyAuthority(canonicalRoot);
        if (
            this.ports.indexAuthorityCoordinator.hasPublishedResolvedPolicy(canonicalRoot)
            && this.ports.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true
        ) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': no runtime-compatible sealed index policy is available; reindex is required.`);
        }
        const synchronizerKey = this.ports.resolveCollectionName(codebasePath);
        let synchronizer = this.ports.getSynchronizer(synchronizerKey);
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
        const sourceGenerationReceipt = options.sourceGenerationReceipt
            ? await this.ports.acceptPreparedSourceGenerationReceipt(canonicalRoot, options.sourceGenerationReceipt)
            : null;
        if (options.sourceGenerationReceipt && !sourceGenerationReceipt) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': prepared source generation changed before publication.`);
        }
        let collectionName = typeof options.targetCollectionName === 'string' && options.targetCollectionName.trim().length > 0
            ? options.targetCollectionName.trim()
            : null;
        if (collectionName) {
            if (!(await this.ports.vectorDatabase.hasCollection(collectionName))) {
                throw new Error(`Cannot incremental sync '${codebasePath}': target collection '${collectionName}' does not exist.`);
            }
        } else {
            const activeCollectionName = sourceGenerationReceipt?.collectionName
                ?? await this.ports.getActiveIndexedCollectionName(codebasePath);
            collectionName = activeCollectionName;
            if (!collectionName) {
                const proofCollection = await this.ports.resolveCompletionProofCollection(codebasePath);
                if (
                    proofCollection
                    && indexFingerprintsEqual(
                        proofCollection.marker.fingerprint,
                        this.ports.buildIndexCompletionFingerprint(),
                    )
                ) {
                    collectionName = proofCollection.collectionName;
                }
            }
            if (!collectionName && synchronizerAlreadyExisted) {
                const retryCollectionName = this.ports.getSynchronizerMutationTarget(synchronizerKey);
                if (retryCollectionName && await this.ports.vectorDatabase.hasCollection(retryCollectionName)) {
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
            const changedFiles = this.ports.normalizeRelativePathsForCodebase(codebasePath, await this.ports.getCodeFiles(codebasePath));
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
                collectionName: options.targetCollectionName ?? this.ports.resolveCollectionName(codebasePath),
                indexedFiles: indexResult.indexedFiles,
                totalChunks: indexResult.totalChunks,
                indexStatus: indexResult.status,
            };
        }
        if (!collectionName) {
            throw new Error(`Expected an indexed collection for '${codebasePath}' after sync preflight.`);
        }
        const sealedPolicy = this.ports.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        if (
            !sealedPolicy
            || this.ports.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true
        ) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': no runtime-compatible sealed index policy is available; reindex is required.`);
        }

        const previousMarker = maintainCompletionMarker
            ? sourceGenerationReceipt?.collectionName === collectionName
                ? this.ports.cloneIndexCompletionMarker(sourceGenerationReceipt.marker)
                : await this.ports.resolveCompletionMarkerForCollection(codebasePath, collectionName)
            : null;
        let checkpointAuthority = previousMarker ? {
            collectionName,
            markerRunId: previousMarker.runId,
            indexPolicyHash: previousMarker.indexPolicyHash,
        } : null;

        if (!synchronizer) {
            synchronizer = this.ports.getSynchronizer(synchronizerKey) ?? this.ports.getSynchronizer(collectionName);
        }
        if (!checkpointAuthority) {
            checkpointAuthority = await FileSynchronizer.inspectSnapshotAuthority(canonicalRoot, collectionName);
        }
        if (!synchronizer && checkpointAuthority) {
            const diskSynchronizer = new FileSynchronizer(
                codebasePath,
                sealedPolicy.effectiveIgnorePatterns,
                sealedPolicy.supportedExtensions,
                { checkpointIdentity: collectionName, checkpointAuthority },
            );
            const inspected = await diskSynchronizer.inspectOwnedSnapshot();
            if (inspected.status === 'valid') {
                await diskSynchronizer.initialize(options.assertMutationCurrent, options.publishMutation, {
                    requireExistingCheckpoint: true,
                });
                synchronizer = diskSynchronizer;
            }
        }
        const reusingWithdrawnMutationTarget = previousMarker === null
            && this.ports.getSynchronizerMutationTarget(synchronizerKey) === collectionName
            && synchronizer?.ownsCheckpointIdentity(collectionName) === true;
        const restoringMissingMarkerFromOwnedCheckpoint = previousMarker === null
            && maintainCompletionMarker
            && checkpointAuthority !== null
            && (options.targetCollectionName === undefined || options.targetCollectionName.trim() === collectionName)
            && synchronizer?.ownsCheckpointAuthority(checkpointAuthority) === true;
        if (
            synchronizer
            && !reusingWithdrawnMutationTarget
            && !restoringMissingMarkerFromOwnedCheckpoint
            && (!checkpointAuthority || !synchronizer.ownsCheckpointAuthority(checkpointAuthority))
        ) {
            if (!checkpointAuthority) {
                throw new Error(`Cannot incrementally synchronize '${codebasePath}': no completion marker owns its source checkpoint.`);
            }
            await this.ports.loadIgnorePatterns(codebasePath);
            synchronizer = new FileSynchronizer(
                codebasePath,
                this.ports.getActiveIgnorePatterns(codebasePath),
                this.ports.getIndexedExtensionsForCodebase(codebasePath),
                { checkpointIdentity: collectionName, checkpointAuthority },
            );
            await synchronizer.initialize(options.assertMutationCurrent, options.publishMutation, {
                requireExistingCheckpoint: true,
            });
            this.ports.registerSynchronizer(synchronizerKey, synchronizer);
        }

        if (!synchronizer) {
            if (!checkpointAuthority) {
                throw new Error(`Cannot incrementally synchronize '${codebasePath}': no completion marker owns its source checkpoint.`);
            }
            await this.ports.loadIgnorePatterns(codebasePath);
            const newSynchronizer = new FileSynchronizer(
                codebasePath,
                this.ports.getActiveIgnorePatterns(codebasePath),
                this.ports.getIndexedExtensionsForCodebase(codebasePath),
                { checkpointIdentity: collectionName, checkpointAuthority },
            );
            await newSynchronizer.initialize(options.assertMutationCurrent, options.publishMutation, {
                requireExistingCheckpoint: true,
            });
            this.ports.registerSynchronizer(synchronizerKey, newSynchronizer);
        }

        const currentSynchronizer = (synchronizer ?? this.ports.getSynchronizer(synchronizerKey) ?? this.ports.getSynchronizer(collectionName))!;
        this.ports.registerSynchronizer(synchronizerKey, currentSynchronizer);
        this.ports.registerSynchronizer(collectionName, currentSynchronizer);
        const targetCollectionName = collectionName;
        this.ports.setSynchronizerMutationTarget(synchronizerKey, targetCollectionName);
        const markerWasMissing = maintainCompletionMarker && previousMarker === null;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const preparedChanges = await currentSynchronizer.prepareChanges();
        const { added, removed, modified } = preparedChanges.changes;
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            const replacementRunId = maintainCompletionMarker && markerWasMissing
                ? crypto.randomUUID()
                : undefined;
            options.assertMutationCurrent?.();
            await preparedChanges.commit(
                options.assertMutationCurrent,
                options.publishMutation,
                replacementRunId ? {
                    collectionName: targetCollectionName,
                    markerRunId: replacementRunId,
                    indexPolicyHash: sealedPolicy.policyHash,
                } : undefined,
            );
            if (maintainCompletionMarker && markerWasMissing) {
                await this.refreshCompletionMarkerFromCurrentSource(codebasePath, targetCollectionName, {
                    requirePayloadProof: true,
                    assertMutationCurrent: options.assertMutationCurrent,
                    publishMutation: options.publishMutation,
                    indexPolicyHash: sealedPolicy.policyHash,
                    runId: replacementRunId,
                });
            }
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            const currentMarker = await this.ports.resolveCompletionMarkerForCollection(codebasePath, targetCollectionName);
            if (maintainCompletionMarker && currentMarker) {
                await this.publishSealedPolicyBindingForMarker(
                    codebasePath,
                    targetCollectionName,
                    currentMarker,
                    options.publishMutation,
                );
            }
            this.ports.clearSynchronizerMutationTarget(synchronizerKey);
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

        if (
            maintainCompletionMarker
            && previousMarker
            && this.ports.vectorDatabase.getPublicationCapabilities?.().atomicCandidatePublication === 'unsupported'
        ) {
            throw new AtomicIncrementalPublicationUnsupportedError();
        }
        if (maintainCompletionMarker && previousMarker && this.ports.vectorDatabase.forkCollection) {
            return this.performAtomicDeltaPublication({
                codebasePath,
                canonicalRoot,
                sourceCollectionName: targetCollectionName,
                previousMarker,
                sealedPolicy,
                synchronizerKey,
                preparedChanges,
                options,
                progressCallback,
            });
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);
        const navigationStateBeforeSync = await readSymbolRegistrySidecar({
            stateRoot: this.ports.symbolRegistryStateRoot,
            normalizedRootPath: this.ports.canonicalizeCodebasePath(codebasePath),
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
                const pathCount = await this.ports.countIndexedPayloadExactly(
                    targetCollectionName,
                    { kind: 'comparison', field: 'relativePath', operator: 'eq', value: relativePath },
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
                await this.ports.clearIndexCompletionMarkerFromCollection(targetCollectionName, options.assertMutationCurrent);
            }

            const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
            const isAuxiliary = (f: string) => semanticRegistry.isAuxiliaryPath(f);
            const searchableAdded = added.filter((f) => !isAuxiliary(f));
            const searchableRemoved = removed.filter((f) => !isAuxiliary(f));
            const searchableModified = modified.filter((f) => !isAuxiliary(f));

            // An added source path should not normally have payload, but stale rows
            // can survive an older source generation. Reconcile them before insert
            // so the exact-count proof can converge instead of failing every retry.
            for (const file of searchableAdded) {
                await this.ports.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
            }

            // Handle removed files
            for (const file of searchableRemoved) {
                await this.ports.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
                updateProgress(`Removed ${file}`);
            }

            // Handle modified files
            for (const file of searchableModified) {
                await this.ports.deleteFileChunks(targetCollectionName, file, options.assertMutationCurrent);
            }

            // Handle added and modified files
            const filesToIndex = [...searchableAdded, ...searchableModified].map(f => path.join(codebasePath, f));

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
                indexedDelta = await this.ports.processFileList(
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
                    indexedFiles: [...preparedChanges.fileHashes.entries()].filter(([filePath]) => !semanticRegistry.isAuxiliaryPath(filePath)).length,
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
                    navigationStateBeforeSync.generationId,
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
                    await this.ports.rebuildNavigationArtifacts(
                        codebasePath,
                        options.assertMutationCurrent,
                        options.publishMutation,
                    );
                    navigationRecovery = 'rebuilt';
                    readinessArtifactsComplete = true;
                    console.log('[Context] 🧭 Rebuilt navigation sidecars after incremental sync found no compatible pre-sync registry.');
                } catch (error) {
                    await this.ports.clearSymbolRegistryForCodebase(
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
                await this.ports.clearSymbolRegistryForCodebase(
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
            await this.ports.clearSymbolRegistryForCodebase(
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
                    await this.ports.clearSymbolRegistryForCodebase(
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
            const nextMarkerRunId = maintainCompletionMarker ? crypto.randomUUID() : undefined;
            options.assertMutationCurrent?.();
            await preparedChanges.commit(
                options.assertMutationCurrent,
                options.publishMutation,
                nextMarkerRunId ? {
                    collectionName: targetCollectionName,
                    markerRunId: nextMarkerRunId,
                    indexPolicyHash: sealedPolicy.policyHash,
                } : undefined,
            );
            if (maintainCompletionMarker) {
                if (preparedMarkerStats) {
                    await this.ports.writeCompletedIndexMarker(
                        codebasePath,
                        preparedMarkerStats.indexedFiles,
                        preparedMarkerStats.totalChunks,
                        targetCollectionName,
                        'completed',
                        options.assertMutationCurrent,
                        undefined,
                        sealedPolicy.policyHash,
                        nextMarkerRunId,
                    );
                } else {
                    await this.refreshCompletionMarkerFromCurrentSource(codebasePath, targetCollectionName, {
                        requirePayloadProof: true,
                        assertMutationCurrent: options.assertMutationCurrent,
                        publishMutation: options.publishMutation,
                        indexPolicyHash: sealedPolicy.policyHash,
                        runId: nextMarkerRunId,
                    });
                }
                const publishedMarker = await this.ports.resolveCompletionMarkerForCollection(
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
            this.ports.clearSynchronizerMutationTarget(synchronizerKey);
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        const currentMarker = readinessArtifactsComplete && maintainCompletionMarker
            ? await this.ports.resolveCompletionMarkerForCollection(codebasePath, targetCollectionName)
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

    private async publishSealedPolicyBindingForMarker(
        codebasePath: string,
        collectionName: string,
        marker: IndexCompletionMarkerDocument,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        this.ports.refreshRuntimePolicyAuthority(canonicalRoot);
        const policy = this.ports.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        if (!policy || this.ports.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true) {
            throw new Error(`Cannot publish generation '${collectionName}': no runtime-compatible sealed index policy is available.`);
        }
        if (policy.policyHash !== marker.indexPolicyHash) {
            throw new Error(`Cannot publish generation '${collectionName}': completion marker and sealed policy hashes differ.`);
        }
        const currentBinding = this.ports.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalRoot);
        const navigationBinding = this.ports.policyNavigationBindingFromMarker(marker.navigation);
        if (
            currentBinding?.policyHash === marker.indexPolicyHash
            && currentBinding.collectionName === collectionName
            && this.ports.policyNavigationBindingsEqual(currentBinding.navigation, navigationBinding)
            && (!currentBinding.publication || currentBinding.publication.sourceCheckpoint.markerRunId === marker.runId)
        ) {
            return;
        }
        const expectedAuthority: SourceFreshnessCheckpointAuthority = {
            collectionName,
            markerRunId: marker.runId,
            indexPolicyHash: marker.indexPolicyHash,
        };
        const activeSynchronizer = this.ports.getSynchronizer(collectionName) ?? this.ports.getSynchronizer(this.ports.resolveCollectionName(canonicalRoot));
        const synchronizerToInspect = (activeSynchronizer && activeSynchronizer.ownsCheckpointAuthority(expectedAuthority))
            ? activeSynchronizer
            : new FileSynchronizer(
                canonicalRoot,
                policy.effectiveIgnorePatterns,
                policy.supportedExtensions,
                {
                    checkpointIdentity: collectionName,
                    checkpointAuthority: expectedAuthority,
                },
            );
        const checkpoint = await synchronizerToInspect.inspectOwnedSnapshot();
        const isSealed = navigationBinding.status === 'sealed' && marker.navigation.status === 'sealed';
        let publication: CanonicalPublicationBinding | undefined = undefined;
        if (isSealed) {
            if (checkpoint.status !== 'valid') {
                throw new Error(`Cannot publish sealed policy binding for '${collectionName}': exact valid source checkpoint is required.`);
            }
            publication = {
                activationId: marker.runId,
                sourceCheckpoint: {
                    collectionName,
                    markerRunId: marker.runId,
                    indexPolicyHash: marker.indexPolicyHash,
                    merkleRoot: checkpoint.merkleRoot,
                    documentDigest: checkpoint.documentDigest,
                },
                graph: {
                    kind: 'relationship_manifest_v2',
                    manifestHash: marker.navigation.status === 'sealed' ? marker.navigation.relationshipManifestHash : '0'.repeat(64),
                },
                receipt: {
                    ownerId: 'core-internal',
                    generation: 1,
                    operationId: marker.runId,
                },
            };
        }
        await this.publishResolvedPolicyForMarker(policy, {
            collectionName,
            navigation: navigationBinding,
            ...(publication ? { publication } : {}),
        }, marker, publishMutation);
    }

    private async publishResolvedPolicyForMarker(
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyBinding,
        marker: IndexCompletionMarkerDocument,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        try {
            this.ports.publishResolvedIndexPolicy(policy, binding, publishMutation);
        } catch (error) {
            await this.ports.indexAuthorityCoordinator.reconcileCommittedPolicyPublication(
                policy,
                binding,
                marker,
                error,
            );
        }
    }

    private collectSemanticAuxiliariesForLanguage(
        codebasePath: string,
        language: string,
        registry: SemanticLanguageRegistry,
    ): SemanticAuxiliaryFile[] {
        const desc = registry.getDescriptor(language);
        if (!desc || desc.auxiliaryFiles.length === 0) return [];

        const results: SemanticAuxiliaryFile[] = [];
        const visited = new Set<string>();

        const walk = (currentDir: string, relDir: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                throw new Error(`Failed to read directory during semantic auxiliary discovery: ${currentDir}`);
            }
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (['.git', 'node_modules', 'dist', 'build', '.satori'].includes(entry.name)) {
                        continue;
                    }
                    const subDir = path.join(currentDir, entry.name);
                    let realSubDir: string;
                    try {
                        realSubDir = fs.realpathSync(subDir);
                    } catch {
                        continue;
                    }
                    if (!isRealPathInsideRoot(realSubDir, codebasePath)) {
                        continue;
                    }
                    walk(subDir, relDir ? `${relDir}/${entry.name}` : entry.name);
                } else if (entry.isFile()) {
                    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
                    const matches = registry.matchAuxiliaries(relPath).filter((m) => m.language === language);
                    for (const match of matches) {
                        if (visited.has(relPath)) continue;
                        visited.add(relPath);
                        const fullPath = path.join(currentDir, entry.name);
                        let realPath: string;
                        try {
                            realPath = fs.realpathSync(fullPath);
                        } catch {
                            throw new Error(`Failed to resolve realpath for semantic auxiliary file: ${relPath}`);
                        }
                        if (!isRealPathInsideRoot(realPath, codebasePath)) {
                            throw new Error(`Semantic auxiliary file ${relPath} escapes codebase root`);
                        }
                        let content: string;
                        try {
                            content = fs.readFileSync(realPath, 'utf8');
                        } catch {
                            throw new Error(`Failed to read semantic auxiliary file: ${relPath}`);
                        }
                        const sourceHash = crypto.createHash('sha256').update(content).digest('hex');
                        results.push({
                            path: relPath,
                            role: match.role,
                            source: content,
                            sourceHash,
                        });
                    }
                }
            }
        };

        walk(codebasePath, '');
        return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
        existingGenerationId?: string,
        deferPublication = false,
        existingRelationshipState?: CachedNavigationDeltaState,
        onPhaseTiming?: ReindexByChangeOptions['onPhaseTiming'],
    ): Promise<NavigationDeltaBuildResult> {
        const measurePhase = async <T>(
            phase:
                | 'publication_relationship_load'
                | 'publication_relationship_delta'
                | 'publication_sidecar_stage',
            run: () => Promise<T> | T,
        ): Promise<T> => {
            const startedAt = performance.now();
            try {
                return await run();
            } finally {
                onPhaseTiming?.(phase, Math.max(0, performance.now() - startedAt));
            }
        };
        const replacedPaths = new Set<string>([
            ...changedRelativePaths.map((filePath) => filePath.replace(/\\/g, '/').replace(/^\/+/, '')),
            ...rebuiltManifestFiles.map((file) => file.path),
        ]);
        const retainedAnalysisByFile = new Map<string, RelationshipAnalysisEvidence>();
        const previousAnalysisByFile = new Map<string, RelationshipAnalysisEvidence>();
        const existingRelationships = existingRelationshipState
            ? {
                status: 'ok' as const,
                records: existingRelationshipState.records,
                analysisByFile: existingRelationshipState.analysisByFile,
            }
            : await measurePhase(
                'publication_relationship_load',
                () => readRelationshipSidecar({
                    stateRoot: this.ports.symbolRegistryStateRoot,
                    normalizedRootPath: this.ports.canonicalizeCodebasePath(codebasePath),
                    expectedSymbolRegistryManifestHash: computeSymbolRegistryManifestHash(existingRegistry.manifest),
                    ...(existingGenerationId ? { generationId: existingGenerationId } : {}),
                }),
            );
        if (existingRelationships.status === 'ok') {
            for (const file of existingRegistry.manifest.files) {
                const evidence = existingRelationships.analysisByFile.get(file.path);
                if (evidence) previousAnalysisByFile.set(file.path, evidence);
                if (replacedPaths.has(file.path)) continue;
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
            await this.ports.clearSymbolRegistryForCodebase(
                codebasePath,
                assertMutationCurrent,
                publishMutation,
            );
            return {};
        }

        const mergedSymbolRecords = [
            ...existingRegistry.symbols.filter((symbol) => !replacedPaths.has(symbol.file)),
            ...rebuiltSymbolRecords,
        ];

        if (existingGenerationId && existingRelationships.status === 'ok') {
            const registry = buildSymbolRegistry({
                manifest: {
                    schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                    normalizedRootPath: this.ports.canonicalizeCodebasePath(codebasePath),
                    rootFingerprint: this.ports.buildRootFingerprint(codebasePath),
                    indexPolicyHash: existingRegistry.manifest.indexPolicyHash,
                    languageRouterVersion: this.ports.getLanguageRouterVersion(),
                    extractorVersion: this.ports.getSymbolExtractorVersion(),
                    relationshipVersion: this.ports.getRelationshipVersion(),
                    builtAt: new Date().toISOString(),
                    files: mergedManifestFiles,
                },
                symbols: mergedSymbolRecords,
            });

            const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
            const semanticEvidenceByLanguage = new Map<string, SemanticProjectEvidence>();

            if (this.ports.semanticAnalyzer) {
                const affectedSemanticLanguages = new Set<string>();
                for (const filePath of replacedPaths) {
                    const auxMatches = semanticRegistry.matchAuxiliaries(filePath);
                    for (const match of auxMatches) {
                        if (this.ports.semanticAnalyzer.supportsLanguage(match.language)) {
                            affectedSemanticLanguages.add(match.language);
                        }
                    }
                    const fileEntry = mergedManifestFiles.find((f) => f.path === filePath)
                        ?? existingRegistry.manifest.files.find((f) => f.path === filePath);
                    if (fileEntry && this.ports.semanticAnalyzer.supportsLanguage(fileEntry.language)) {
                        affectedSemanticLanguages.add(fileEntry.language);
                    }
                }

                for (const lang of affectedSemanticLanguages) {
                    const sourceFiles: SemanticSourceFile[] = [];
                    const langFiles = mergedManifestFiles.filter((f) => f.language === lang);
                    for (const f of langFiles) {
                        const fullPath = path.resolve(codebasePath, f.path);
                        const realPath = await resolveInsideRoot(fullPath, codebasePath);
                        if (!realPath) {
                            throw new Error(`Failed to resolve semantic source file inside root: ${f.path}`);
                        }
                        let source: string;
                        try {
                            source = fs.readFileSync(realPath, 'utf8');
                        } catch {
                            throw new Error(`Failed to read semantic source file during delta rebuild: ${f.path}`);
                        }
                        const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
                        if (f.hash && f.hash !== sourceHash) {
                            throw new Error(`Semantic source hash mismatch for ${f.path}: expected ${f.hash}, got ${sourceHash}`);
                        }
                        sourceFiles.push({ path: f.path, source, sourceHash });
                    }
                    const auxiliaryFiles = this.collectSemanticAuxiliariesForLanguage(codebasePath, lang, semanticRegistry);
                    const evidence = await this.ports.semanticAnalyzer.analyze({
                        language: lang,
                        sourceFiles,
                        auxiliaryFiles,
                    });
                    semanticEvidenceByLanguage.set(lang, evidence);
                }
            }

            const relationshipDelta = await measurePhase(
                'publication_relationship_delta',
                () => buildRelationshipDelta({
                    previousRegistry: existingRegistry,
                    registry,
                    existingRecords: existingRelationships.records,
                    analysisByFile: retainedAnalysisByFile,
                    changedFiles: replacedPaths,
                    previousAnalysisByFile,
                    semanticRegistry,
                    semanticEvidenceByLanguage,
                }),
            );
            assertMutationCurrent?.();
            const candidate = await measurePhase(
                'publication_sidecar_stage',
                () => stageNavigationSidecarGeneration({
                    stateRoot: this.ports.symbolRegistryStateRoot,
                    registry,
                    records: relationshipDelta.records,
                    analysisByFile: retainedAnalysisByFile,
                    deltaReuse: {
                        baseGenerationId: existingGenerationId,
                        symbolFilesToRewrite: [...replacedPaths],
                        relationshipFilesToRewrite: relationshipDelta.affectedFiles,
                    },
                }),
            );
            console.log(
                `[Context] 🧭 Staged navigation delta '${candidate.generationId}' affecting `
                + `${relationshipDelta.affectedFiles.length} relationship owner(s); `
                + `shared ${candidate.physical.sharedFiles} file(s) and wrote `
                + `${candidate.physical.physicallyWrittenBytes} physical byte(s).`,
            );
            if (!deferPublication) {
                await this.ports.publishNavigationCandidate(
                    candidate,
                    assertMutationCurrent,
                    publishMutation,
                );
            }
            return {
                candidate,
                state: {
                    canonicalRoot: this.ports.canonicalizeCodebasePath(codebasePath),
                    generationId: candidate.generationId,
                    symbolRegistryManifestHash: candidate.manifestHash,
                    relationshipManifestHash: candidate.relationshipManifestHash,
                    navigationSealHash: candidate.navigationSealHash,
                    registry,
                    records: relationshipDelta.records,
                    analysisByFile: retainedAnalysisByFile,
                },
            };
        }

        return {
            candidate: await this.stageSymbolRegistryForCompletedIndex(
                codebasePath,
                mergedSymbolRecords,
                mergedManifestFiles,
                assertMutationCurrent,
                retainedAnalysisByFile,
                publishMutation,
                deferPublication,
            ),
        };

    }

    private async refreshCompletionMarkerFromCurrentSource(
        codebasePath: string,
        collectionName: string,
        options: {
            requirePayloadProof?: boolean;
            assertMutationCurrent?: () => void;
            publishMutation?: (publish: () => void) => void;
            indexPolicyHash?: string;
            runId?: string;
        } = {}
    ): Promise<void> {
        await this.ports.loadIgnorePatterns(codebasePath);
        const codeFiles = await this.ports.getCodeFiles(codebasePath);
        const { expectedChunks } = await this.ports.getExpectedChunksAndSymbols(codeFiles, codebasePath);
        if (options.requirePayloadProof === true) {
            await this.ports.ensureNavigationArtifactsReadyForMarkerRefresh(
                codebasePath,
                options.assertMutationCurrent,
                options.publishMutation,
            );
            const verification = await this.ports.verifyCollectionPayloadMatchesCurrentSource(collectionName, codeFiles, expectedChunks);
            if (!verification.ok) {
                await this.ports.clearIndexCompletionMarkerFromCollection(collectionName, options.assertMutationCurrent);
                throw new Error(`Cannot refresh completion marker for '${codebasePath}': ${verification.message}`);
            }
        }
        await this.ports.writeCompletedIndexMarker(
            codebasePath,
            codeFiles.length,
            expectedChunks.length,
            collectionName,
            'completed',
            options.assertMutationCurrent,
            undefined,
            options.indexPolicyHash,
            options.runId,
        );
    }

    async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: ReindexByChangeOptions = {}
    ): Promise<ReindexByChangeResult> {
        assertDescriptorBoundIndexingSupported();
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        return this.runSerializedReindexByChange(
            canonicalRoot,
            () => this.performReindexByChange(codebasePath, progressCallback, options),
        );
    }

    public async repairIndex(
        codebasePath: string,
        options: RepairIndexOptions = {}
    ): Promise<RepairIndexResult> {
        assertDescriptorBoundIndexingSupported();
        const canonicalPath = this.ports.canonicalizeCodebasePath(codebasePath);
        const currentFingerprint = this.ports.buildIndexCompletionFingerprint();
        const snapshotEvidence = options.snapshotEvidence ?? {
            status: 'missing' as const,
            basis: 'snapshot_fingerprint_missing',
        };
        const snapshotCompatibility = snapshotEvidence.status === 'verified'
            ? classifyRepairIndexCompatibility(snapshotEvidence.fingerprint, currentFingerprint)
            : null;
        const snapshotFingerprintMatches = snapshotCompatibility?.status === 'compatible';
        const snapshotRelationshipOnlyUpgrade =
            snapshotCompatibility?.status === 'relationship_only_upgrade';
        const proof: RepairProof = {
            collection: { status: 'not_checked' },
            snapshot: snapshotEvidence.status === 'missing'
                ? { status: 'missing', basis: snapshotEvidence.basis }
                : snapshotEvidence.status === 'unproven'
                    ? { status: 'unproven', basis: snapshotEvidence.basis }
                    : snapshotFingerprintMatches
                        ? { status: 'matched', basis: snapshotEvidence.basis }
                        : snapshotRelationshipOnlyUpgrade
                            ? { status: 'matched', basis: 'snapshot_relationship_only_upgrade' }
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

        try {
            await resolveCurrentNavigationGeneration(this.ports.symbolRegistryStateRoot, canonicalPath);
        } catch (error) {
            if (
                error instanceof RetiredNavigationPointerError
                || error instanceof UnsupportedNavigationPointerError
            ) {
                proof.navigation = { status: 'failed', basis: 'unsupported_navigation_authority' };
                return withProof({
                    status: 'requires_reindex',
                    reason: 'requires_reindex',
                    message: error instanceof UnsupportedNavigationPointerError
                        ? 'Repair cannot replace navigation authority written by an unsupported newer format.'
                        : 'Repair cannot promote a retired navigation authority format.',
                });
            }
            // Malformed current-format or missing navigation state remains repairable.
        }

        // 1. Resolve collection
        try {
            this.ports.refreshRuntimePolicyAuthority(canonicalPath);
        } catch {
            // The sealed-policy step below reports unsupported or malformed
            // authority after collection-family evidence has been recorded.
        }
        const familyCollectionNames = await this.ports.listRelatedCollectionNames(canonicalPath);
        const activeCollectionName = this.ports.resolveCollectionName(canonicalPath);
        const sealedCollectionName =
            this.ports.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalPath)?.collectionName;
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
        } else if (
            sealedCollectionName
            && familyCollectionNames.includes(sealedCollectionName)
        ) {
            selectedCollection = sealedCollectionName;
            collectionSelectionBasis = 'selected_sealed_policy_collection';
        } else if (familyCollectionNames.includes(activeCollectionName)) {
            selectedCollection = activeCollectionName;
        } else {
            const { alternateFamilyName } = this.ports.buildCollectionFamilies(canonicalPath);
            if (familyCollectionNames.includes(alternateFamilyName)) {
                selectedCollection = alternateFamilyName;
                collectionSelectionBasis = 'selected_alternate_collection';
            } else {
                const stagedCollections = familyCollectionNames.filter((collectionName) => isStagedGenerationCollectionName(collectionName));
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
        let trustedMarker: IndexCompletionMarkerDocument | null = null;
        let relationshipOnlyUpgrade = false;
        const markerResolution = await this.resolveRepairCompletionMarkerForCollection(canonicalPath, selectedCollection);
        if (markerResolution.status === 'requires_reindex') {
            proof.marker = { status: 'failed', basis: 'completion_marker_requires_reindex' };
            proof.fingerprint = { status: 'failed', basis: 'completion_marker_requires_reindex' };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: 'The existing completion marker format requires reindexing.',
            });
        }
        if (markerResolution.status === 'fingerprint_mismatch') {
            proof.marker = { status: 'failed', basis: 'completion_marker_fingerprint_mismatch' };
            proof.fingerprint = { status: 'failed', basis: 'completion_marker_fingerprint_mismatch' };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: 'The existing index is incompatible with the current runtime fingerprint.',
            });
        }
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
            const compatibility = classifyRepairIndexCompatibility(
                marker.fingerprint,
                currentFingerprint,
            );
            if (
                compatibility.status !== 'compatible'
                && compatibility.status !== 'relationship_only_upgrade'
            ) {
                proof.marker = { status: 'failed', basis: 'completion_marker_fingerprint_mismatch' };
                proof.fingerprint = { status: 'failed', basis: 'completion_marker_fingerprint_mismatch' };
                return withProof({
                    status: 'requires_reindex',
                    reason: 'requires_reindex',
                    message: 'The existing index is incompatible with the current runtime fingerprint.',
                });
            }
            trustedMarker = marker;
            relationshipOnlyUpgrade = compatibility.status === 'relationship_only_upgrade';
            const basis = relationshipOnlyUpgrade
                ? 'completion_marker_relationship_only_upgrade'
                : 'completion_marker_fingerprint';
            proof.marker = { status: 'matched', basis };
            proof.fingerprint = { status: 'matched', basis };
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
        try {
            this.ports.refreshRuntimePolicyAuthority(canonicalPath);
        } catch (error) {
            if (
                error instanceof IndexFormatRequiresReindexError
                || error instanceof UnsupportedIndexAuthorityError
            ) {
                proof.marker = { status: 'failed', basis: 'sealed_policy_unavailable' };
                return withProof({
                    status: 'requires_reindex',
                    reason: 'requires_reindex',
                    message: error instanceof UnsupportedIndexAuthorityError
                        ? 'Repair cannot replace index policy authority written by an unsupported newer format.'
                        : 'Repair cannot promote a retired index policy authority format.',
                });
            }
            throw error;
        }
        const repairPolicy = this.ports.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalPath);
        if (!repairPolicy || this.ports.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalPath) !== true) {
            proof.marker = { status: 'failed', basis: 'sealed_policy_unavailable' };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: `Repair cannot publish collection '${selectedCollection}' because its sealed index policy is missing or runtime-incompatible.`,
            });
        }
        const repairBinding = this.ports.indexAuthorityCoordinator.getPublishedPolicyBinding(canonicalPath);
        let v4RepairSource: {
            marker: IndexCompletionMarkerDocument;
            binding: IndexPolicyBinding & { policyHash: string };
            preparedChanges: Awaited<ReturnType<FileSynchronizer['prepareChanges']>>;
            checkpointDocumentDigest: string;
        } | null = null;
        const publication = repairBinding?.publication;
        if (
            !trustedMarker
            || !repairBinding
            || !publication
            || repairBinding.collectionName !== selectedCollection
            || repairBinding.navigation.status !== 'sealed'
            || trustedMarker.navigation.status !== 'sealed'
            || publication.sourceCheckpoint.collectionName !== selectedCollection
            || publication.sourceCheckpoint.markerRunId !== trustedMarker.runId
            || publication.sourceCheckpoint.indexPolicyHash !== trustedMarker.indexPolicyHash
            || repairPolicy.policyHash !== trustedMarker.indexPolicyHash
        ) {
            proof.navigation = {
                status: 'failed',
                basis: relationshipOnlyUpgrade
                    ? 'relationship_upgrade_v4_authority_missing'
                    : 'v4_repair_authority_missing',
            };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: 'Repair requires one exact marker-owned v4 publication and source checkpoint.',
                trackedRelativePaths: [],
            });
        }
        {
            const synchronizer = new FileSynchronizer(
                canonicalPath,
                repairPolicy.effectiveIgnorePatterns,
                repairPolicy.supportedExtensions,
                {
                    checkpointIdentity: selectedCollection,
                    checkpointAuthority: {
                        collectionName: selectedCollection,
                        markerRunId: trustedMarker.runId,
                        indexPolicyHash: trustedMarker.indexPolicyHash,
                    },
                },
            );
            try {
                await synchronizer.initialize(undefined, undefined, {
                    requireExistingCheckpoint: true,
                });
                const checkpoint = await synchronizer.inspectOwnedSnapshot();
                if (
                    checkpoint.status !== 'valid'
                    || checkpoint.merkleRoot !== publication.sourceCheckpoint.merkleRoot
                    || checkpoint.documentDigest !== publication.sourceCheckpoint.documentDigest
                ) {
                    proof.snapshot = {
                        status: 'failed',
                        basis: 'v4_source_checkpoint_mismatch',
                    };
                    return withProof({
                        status: 'requires_reindex',
                        reason: 'requires_reindex',
                        message: 'Repair cannot prove the marker-owned v4 source checkpoint.',
                    });
                }
                const preparedChanges = await synchronizer.prepareChanges({ forceFullHash: true });
                const {
                    added,
                    removed,
                    modified,
                    partialScan,
                    unscannedDirPrefixes,
                } = preparedChanges.changes;
                if (
                    added.length > 0
                    || removed.length > 0
                    || modified.length > 0
                    || partialScan
                    || unscannedDirPrefixes.length > 0
                ) {
                    proof.snapshot = {
                        status: 'failed',
                        basis: 'source_observation_changed',
                    };
                    return withProof({
                        status: 'requires_reindex',
                        reason: 'requires_reindex',
                        message: 'Repair requires a complete zero-change source observation.',
                    });
                }
                v4RepairSource = {
                    marker: trustedMarker,
                    binding: repairBinding,
                    preparedChanges,
                    checkpointDocumentDigest: checkpoint.documentDigest,
                };
                proof.snapshot = {
                    status: 'matched',
                    basis: 'v4_checkpoint_full_hash_zero_change',
                    expectedCount: preparedChanges.fileHashes.size,
                    observedCount: preparedChanges.fileHashes.size,
                };
            } catch (error) {
                proof.snapshot = {
                    status: 'failed',
                    basis: 'v4_source_checkpoint_unavailable',
                };
                return withProof({
                    status: 'requires_reindex',
                    reason: 'requires_reindex',
                    message: `Repair cannot reopen its marker-owned v4 source checkpoint: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
        const codeFiles = await this.ports.getCodeFiles(canonicalPath, repairPolicy);
        const trackedRelativePaths = this.ports.normalizeRelativePathsForCodebase(canonicalPath, codeFiles);

        if (codeFiles.length === 0 && !v4RepairSource) {
            if (
                typeof this.ports.vectorDatabase.getCollectionDataObservation !== 'function'
            ) {
                proof.payload = {
                    status: 'unproven',
                    basis: 'same_state_payload_authority_unavailable',
                    expectedCount: 0,
                };
                proof.staleRemoteChunks = {
                    status: 'unproven',
                    basis: 'same_state_payload_authority_unavailable',
                };
                return withProof({
                    status: 'blocked',
                    reason: 'repair_proof_limit',
                    message: `Repair cannot prove exact remote payload equality for collection '${selectedCollection}' because this vector backend does not expose same-state payload observation authority.`,
                    missingCount: 0,
                    trackedRelativePaths,
                });
            }
            const payloadObservationBefore = await this.ports.vectorDatabase.getCollectionDataObservation(selectedCollection);
            options.assertMutationCurrent?.();
            const observedPayloadCount = await this.ports.countIndexedPayloadExactly(selectedCollection, undefined, 0);
            options.assertMutationCurrent?.();
            const payloadObservationAfter = await this.ports.vectorDatabase.getCollectionDataObservation(selectedCollection);
            if (
                !payloadObservationBefore
                || !payloadObservationAfter
                || payloadObservationAfter !== payloadObservationBefore
            ) {
                proof.payload = {
                    status: 'unproven',
                    basis: 'remote_payload_changed_during_proof',
                    expectedCount: 0,
                    ...(observedPayloadCount !== null ? { observedCount: observedPayloadCount } : {}),
                };
                proof.staleRemoteChunks = {
                    status: 'unproven',
                    basis: 'remote_payload_changed_during_proof',
                };
                return withProof({
                    status: 'blocked',
                    reason: 'repair_proof_limit',
                    message: `Repair could not prove collection '${selectedCollection}' from one stable remote payload state.`,
                    missingCount: 0,
                    trackedRelativePaths,
                });
            }
            if (observedPayloadCount === null) {
                proof.payload = {
                    status: 'unproven',
                    basis: 'exact_payload_count_unavailable',
                    expectedCount: 0,
                };
                proof.staleRemoteChunks = {
                    status: 'unproven',
                    basis: 'exact_payload_count_unavailable',
                };
                return withProof({
                    status: 'blocked',
                    reason: 'repair_proof_limit',
                    message: `Repair cannot prove the exact remote payload count for collection '${selectedCollection}'.`,
                    missingCount: 0,
                    trackedRelativePaths,
                });
            }
            if (observedPayloadCount !== 0) {
                proof.payload = {
                    status: 'failed',
                    basis: 'remote_payload_without_indexable_source',
                    expectedCount: 0,
                    observedCount: observedPayloadCount,
                };
                proof.staleRemoteChunks = {
                    status: 'failed',
                    basis: 'remote_payload_without_indexable_source',
                    extraCount: observedPayloadCount,
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
            await this.ports.clearSymbolRegistryForCodebase(
                canonicalPath,
                options.assertMutationCurrent,
                options.publishMutation,
            );
            await this.ports.writeCompletedIndexMarker(
                canonicalPath,
                0,
                0,
                selectedCollection,
                'completed',
                options.assertMutationCurrent,
                undefined,
                repairPolicy.policyHash,
            );
            const repairedMarker = await this.ports.resolveCompletionMarkerForCollection(canonicalPath, selectedCollection);
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
        } = await this.ports.getExpectedChunksAndSymbols(codeFiles, canonicalPath, repairPolicy);
        if (
            v4RepairSource
            && (
                v4RepairSource.marker.indexedFiles !== codeFiles.length
                || v4RepairSource.marker.totalChunks !== expectedChunks.length
                || v4RepairSource.preparedChanges.fileHashes.size !== codeFiles.length
            )
        ) {
            proof.payload = {
                status: 'failed',
                basis: 'marker_source_count_mismatch',
                expectedCount: expectedChunks.length,
                observedCount: v4RepairSource.marker.totalChunks,
            };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: 'Relationship-only repair found incompatible marker, source, or payload counts.',
                trackedRelativePaths,
            });
        }

        // 5. Prove expected-ID membership and exact cardinality against one
        // observed remote payload state. A mutation lease excludes Satori writers,
        // but only the adapter can prove that the backend payload stayed unchanged.
        if (
            typeof this.ports.vectorDatabase.getCollectionDataObservation !== 'function'
            || typeof this.ports.vectorDatabase.countDocuments !== 'function'
        ) {
            proof.payload = {
                status: 'unproven',
                basis: 'same_state_payload_authority_unavailable',
                expectedCount: expectedChunks.length,
            };
            proof.staleRemoteChunks = {
                status: 'unproven',
                basis: 'same_state_payload_authority_unavailable',
            };
            return withProof({
                status: 'blocked',
                reason: 'repair_proof_limit',
                message: `Repair cannot prove exact remote payload equality for collection '${selectedCollection}' because this vector backend does not expose same-state payload observation authority.`,
                missingCount: 0,
                trackedRelativePaths,
            });
        }
        const payloadObservationBefore = await this.ports.vectorDatabase.getCollectionDataObservation(selectedCollection);
        if (!payloadObservationBefore) {
            proof.payload = {
                status: 'unproven',
                basis: 'same_state_payload_observation_unavailable',
                expectedCount: expectedChunks.length,
            };
            proof.staleRemoteChunks = {
                status: 'unproven',
                basis: 'same_state_payload_observation_unavailable',
            };
            return withProof({
                status: 'blocked',
                reason: 'repair_proof_limit',
                message: `Repair cannot observe a stable remote payload state for collection '${selectedCollection}'.`,
                missingCount: 0,
                trackedRelativePaths,
            });
        }

        const existingIds = new Set<string>();
        const expectedIds = expectedChunks.map((chunk) => chunk.id);
        const chunkIdBatchSize = 512;
        for (let index = 0; index < expectedIds.length; index += chunkIdBatchSize) {
            const batch = expectedIds.slice(index, index + chunkIdBatchSize);
            const rows = await this.ports.vectorDatabase.queryDocuments(selectedCollection, {
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
            const relPath = this.ports.normalizeRelativePathForCodebase(canonicalPath, file);
            if (!relPath) continue;
            const expectedIdsForFile = fileToChunksMap.get(relPath) || [];
            if (expectedIdsForFile.length > 0) {
                const hasAny = expectedIdsForFile.some(id => existingIds.has(id));
                if (!hasAny) {
                    hasFileCoverageIssue = true;
                }
            }
        }

        options.assertMutationCurrent?.();
        const observedPayloadCount = await this.ports.countIndexedPayloadExactly(
            selectedCollection,
            undefined,
            expectedChunks.length,
        );
        options.assertMutationCurrent?.();
        const payloadObservationAfter = await this.ports.vectorDatabase.getCollectionDataObservation(selectedCollection);
        if (!payloadObservationAfter || payloadObservationAfter !== payloadObservationBefore) {
            proof.payload = {
                status: 'unproven',
                basis: 'remote_payload_changed_during_proof',
                expectedCount: expectedChunks.length,
                ...(observedPayloadCount !== null ? { observedCount: observedPayloadCount } : {}),
                missingCount: missingChunksCount,
            };
            proof.staleRemoteChunks = {
                status: 'unproven',
                basis: 'remote_payload_changed_during_proof',
            };
            return withProof({
                status: 'blocked',
                reason: 'repair_proof_limit',
                message: `Repair could not prove collection '${selectedCollection}' from one stable remote payload state.`,
                missingCount: missingChunksCount,
                trackedRelativePaths,
            });
        }

        if (observedPayloadCount === null) {
            proof.payload = {
                status: 'unproven',
                basis: 'exact_payload_count_unavailable',
                expectedCount: expectedChunks.length,
                observedCount: existingIds.size,
                missingCount: missingChunksCount,
            };
            proof.staleRemoteChunks = {
                status: 'unproven',
                basis: 'exact_payload_count_unavailable',
            };
            return withProof({
                status: 'blocked',
                reason: 'repair_proof_limit',
                message: `Repair cannot prove the exact remote payload count for collection '${selectedCollection}'.`,
                missingCount: missingChunksCount,
                trackedRelativePaths,
            });
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

        if (observedPayloadCount !== expectedChunks.length) {
            const extraCount = Math.max(0, observedPayloadCount - expectedChunks.length);
            proof.payload = {
                status: 'failed',
                basis: 'remote_payload_count_mismatch',
                expectedCount: expectedChunks.length,
                observedCount: observedPayloadCount,
                missingCount: 0,
                extraCount,
            };
            proof.staleRemoteChunks = {
                status: 'failed',
                basis: 'unexpected_remote_chunk_count',
                extraCount,
            };
            return withProof({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: `Coverage verification failed: collection '${selectedCollection}' has ${extraCount || 'unexpected'} stale remote chunk(s) beyond the ${expectedChunks.length} chunks required by current source.`,
                missingCount: 0,
                trackedRelativePaths,
            });
        }
        proof.payload = {
            status: 'matched',
            basis: 'same_state_membership_and_exact_count',
            expectedCount: expectedChunks.length,
            observedCount: observedPayloadCount,
            missingCount: 0,
            extraCount: 0,
        };
        proof.staleRemoteChunks = {
            status: 'matched',
            basis: 'same_state_exact_count_no_extras',
            extraCount: 0,
        };
        proof.navigation = {
            status: 'unproven',
            basis: 'navigation_rebuild_in_progress',
        };
        publishProof();

        if (v4RepairSource) {
            const {
                marker,
                binding,
                preparedChanges,
                checkpointDocumentDigest,
            } = v4RepairSource;
            const toActivatedGeneration = (
                receipt: ProvenGenerationReceipt,
            ): RepairActivatedGeneration => ({
                collectionName: receipt.collectionName,
                markerRunId: receipt.marker.runId,
                sourceCheckpointDocumentDigest: checkpointDocumentDigest,
                relationshipVersion: this.ports.getRelationshipVersion(),
                navigation: {
                    generationId: receipt.navigation.generationId,
                    sealHash: receipt.navigation.navigationSealHash,
                    symbolRegistryManifestHash: receipt.navigation.symbolRegistryManifestHash,
                    relationshipManifestHash: receipt.navigation.relationshipManifestHash,
                },
            });
            const alreadyActivated = await this.ports.proveIndexedGeneration(canonicalPath);
            if (
                alreadyActivated
                && alreadyActivated.collectionName === selectedCollection
                && this.ports.indexCompletionMarkersEqual(alreadyActivated.marker, marker)
                && alreadyActivated.exactPayloadCount === expectedChunks.length
            ) {
                proof.navigation = {
                    status: 'matched',
                    basis: 'v4_navigation_already_activated',
                };
                return withProof({
                    status: 'ok',
                    message: 'The existing v4 publication and navigation are already exactly proven; repair made no changes.',
                    indexedFiles: codeFiles.length,
                    totalChunks: expectedChunks.length,
                    warnings: [],
                    trackedRelativePaths,
                    collectionName: selectedCollection,
                    activatedGeneration: toActivatedGeneration(alreadyActivated),
                });
            }

            const previousNavigationGenerationId = binding.navigation.status === 'sealed'
                ? binding.navigation.generationId
                : null;
            if (!previousNavigationGenerationId) {
                throw new Error('V4 navigation repair lost its sealed source navigation binding.');
            }
            await this.ports.waitForPublicationRetention(canonicalPath);
            options.assertMutationCurrent?.();
            let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
            let activated = false;
            try {
                navigationCandidate = await this.stageSymbolRegistryForCompletedIndex(
                    canonicalPath,
                    symbolRecords,
                    symbolManifestFiles,
                    options.assertMutationCurrent,
                    analysisByFile,
                    undefined,
                    true,
                    repairPolicy,
                );

                if (!navigationCandidate) {
                    throw new Error('V4 navigation repair did not stage a navigation generation.');
                }
                await this.verifyPreparedSyncPublication(
                    canonicalPath,
                    selectedCollection,
                    preparedChanges.fileHashes,
                    expectedChunks.length,
                    navigationCandidate,
                    observedPayloadCount,
                );
                const authority = options.publicationAuthority;
                if (!authority) {
                    throw new Error('V4 navigation repair requires publication authority.');
                }
                const activationId = crypto.randomUUID();
                const publication: CanonicalPublicationBinding = {
                    activationId,
                    sourceCheckpoint: structuredClone(binding.publication!.sourceCheckpoint),
                    graph: {
                        kind: 'relationship_manifest_v2',
                        manifestHash: navigationCandidate.relationshipManifestHash,
                    },
                    receipt: {
                        ownerId: authority.ownerId,
                        generation: authority.generation,
                        operationId: authority.operationId,
                    },
                };
                await preparedChanges.assertSourceObservationCurrent();
                options.assertMutationCurrent?.();
                try {
                    this.ports.publishResolvedIndexPolicy(
                        repairPolicy,
                        {
                            collectionName: selectedCollection,
                            navigation: {
                                status: 'sealed',
                                generationId: navigationCandidate.generationId,
                                sealHash: navigationCandidate.navigationSealHash,
                            },
                            publication,
                        },
                        options.publishMutation,
                    );
                    activated = true;
                } catch (error) {
                    if (
                        error instanceof IndexPolicyPublicationError
                        && error.receipt.operation === 'publish'
                        && error.receipt.collectionName === selectedCollection
                        && error.receipt.publication?.activationId === activationId
                    ) {
                        activated = true;
                        this.ports.refreshRuntimePolicyAuthority(canonicalPath);
                    } else {
                        throw error;
                    }
                }

                const navigation: CurrentNavigationGeneration = {
                    generationId: navigationCandidate.generationId,
                    generationRoot: navigationCandidate.rootPath,
                    symbolRegistryManifestHash: navigationCandidate.manifestHash,
                    relationshipManifestHash: navigationCandidate.relationshipManifestHash,
                    navigationSealHash: navigationCandidate.navigationSealHash,
                };
                await this.ports.indexAuthorityCoordinator.recordActivatedGenerationProof({
                    canonicalRoot: canonicalPath,
                    marker,
                    policy: repairPolicy,
                    exactPayloadCount: expectedChunks.length,
                    navigation,
                });
                const proven = await this.ports.proveIndexedGeneration(canonicalPath);
                if (
                    !proven
                    || proven.collectionName !== selectedCollection
                    || !this.ports.indexCompletionMarkersEqual(proven.marker, marker)
                    || proven.exactPayloadCount !== expectedChunks.length
                    || proven.navigation.generationId !== navigationCandidate.generationId
                    || proven.navigation.navigationSealHash !== navigationCandidate.navigationSealHash
                    || proven.navigation.symbolRegistryManifestHash !== navigationCandidate.manifestHash
                    || proven.navigation.relationshipManifestHash
                        !== navigationCandidate.relationshipManifestHash
                ) {
                    throw new Error('V4 navigation repair activation could not be proven exactly.');
                }
                const activeDataObservation = this.ports.vectorDatabase.getCollectionDataObservation
                    ? await this.ports.vectorDatabase.getCollectionDataObservation(selectedCollection)
                    : undefined;
                this.ports.indexAuthorityCoordinator.schedulePublicationRetention({
                    canonicalRoot: canonicalPath,
                    activationId: publication.activationId,
                    activeCollectionName: selectedCollection,
                    previousCollectionName: selectedCollection,
                    activeNavigationGenerationId: navigationCandidate.generationId,
                    previousNavigationGenerationId,
                    ...(activeDataObservation ? { activeDataObservation } : {}),
                });
                await this.ports.waitForPublicationRetention(canonicalPath);
                proof.navigation = {
                    status: 'matched',
                    basis: 'v4_navigation_activated_and_proven',
                };
                return withProof({
                    status: 'ok',
                    message: 'V4 navigation repair activated a new proven graph without vector, marker, or checkpoint writes.',
                    indexedFiles: codeFiles.length,
                    totalChunks: expectedChunks.length,
                    warnings: [],
                    trackedRelativePaths,
                    collectionName: selectedCollection,
                    activatedGeneration: toActivatedGeneration(proven),
                });
            } catch (error) {
                if (!activated && navigationCandidate) {
                    await discardNavigationSidecarGeneration(navigationCandidate).catch(() => undefined);
                }
                throw error;
            }
        }

        // 6. Rebuild symbol registry/relationship sidecars
        const navigationCandidate = await this.stageSymbolRegistryForCompletedIndex(
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
        await this.ports.writeCompletedIndexMarker(
            canonicalPath,
            codeFiles.length,
            expectedChunks.length,
            selectedCollection,
            'completed',
            options.assertMutationCurrent,
            navigationCandidate,
            repairPolicy.policyHash,
        );
        const repairedMarker = await this.ports.resolveCompletionMarkerForCollection(canonicalPath, selectedCollection);
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

    async resolveIndexPolicyForCodebase(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ObservedResolvedIndexPolicy> {
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        this.ports.indexPolicyRuntimeService.loadCustomIndexPolicy(canonicalRoot);
        return this.ports.resolveIndexPolicyFromCurrentInputs(canonicalRoot, update, true, true);
    }

    private async resolveRepairCompletionMarkerForCollection(
        codebasePath: string,
        collectionName: string,
    ): Promise<RepairCompletionMarkerResolution> {
        const record = await this.ports.vectorDatabase.getControl(collectionName, INDEX_COMPLETION_MARKER_DOC_ID);
        if (!record) {
            return { status: 'missing' };
        }
        if (typeof record.metadata.kind === 'string' && record.kind === record.metadata.kind) {
            const inspected = inspectCompletionMarker(record.metadata);
            if (inspected.status === 'requires_reindex') {
                if (inspected.reason === 'completion marker fingerprint requires reindex') {
                    return { status: 'fingerprint_mismatch' };
                }
                return { status: 'requires_reindex' };
            }
        }
        const marker = this.ports.parseCompletionControlRecord(codebasePath, record);
        if (marker) {
            return { status: 'matched', marker };
        }
        return { status: 'malformed' };
    }

    resolveReusableNavigationDeltaState(
        canonicalRoot: string,
        sourceNavigation: {
            generationId: string;
            symbolRegistryManifestHash: string;
            relationshipManifestHash: string;
            navigationSealHash?: string;
            sealHash?: string;
        },
    ): CachedNavigationDeltaState | undefined {
        const cached = this.navigationDeltaState;
        const expectedSealHash = sourceNavigation.navigationSealHash ?? sourceNavigation.sealHash;
        const currentObservation = cached
            && cached.canonicalRoot === canonicalRoot
            && cached.generationId === sourceNavigation.generationId
            ? this.ports.resolveNavigationObservationToken(
                canonicalRoot,
                sourceNavigation.generationId,
                false,
            )
            : null;
        if (
            cached
            && cached.canonicalRoot === canonicalRoot
            && cached.generationId === sourceNavigation.generationId
            && cached.symbolRegistryManifestHash === sourceNavigation.symbolRegistryManifestHash
            && cached.relationshipManifestHash === sourceNavigation.relationshipManifestHash
            && cached.navigationSealHash === expectedSealHash
            && cached.navigationObservationToken === currentObservation
        ) {
            return cached;
        }
        if (cached?.canonicalRoot === canonicalRoot) {
            this.navigationDeltaState = undefined;
        }
        return undefined;
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

    private async verifyPreparedSyncPublication(
        codebasePath: string,
        collectionName: string,
        preparedFileHashes: ReadonlyMap<string, string>,
        expectedTotalChunks: number,
        navigationCandidate?: StagedNavigationSidecarGeneration,
        preparedObservedTotalChunks?: number | null,
    ): Promise<void> {
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
        const searchablePreparedFileHashes = new Map(
            [...preparedFileHashes.entries()].filter(([filePath]) => !semanticRegistry.isAuxiliaryPath(filePath)),
        );
        if (navigationCandidate) {
            const preparedFiles = [...searchablePreparedFileHashes].map(([filePath, hash]) => ({ path: filePath, hash }));
            if (
                navigationCandidate.normalizedRootPath !== canonicalRoot
                || navigationCandidate.sourceFileCount !== searchablePreparedFileHashes.size
                || navigationCandidate.sourceFilesDigest !== computeNavigationSourceFilesDigest(preparedFiles)
            ) {
                throw new Error(
                    'Cannot publish incremental completion proof: staged navigation does not match the prepared synchronizer checkpoint.',
                );
            }
            const sealState = await readNavigationGenerationSeal(
                this.ports.symbolRegistryStateRoot,
                canonicalRoot,
                navigationCandidate.generationId,
            );
            if (
                sealState.status !== 'ok'
                || sealState.seal.symbolRegistryManifestHash !== navigationCandidate.manifestHash
                || sealState.seal.relationshipManifestHash !== navigationCandidate.relationshipManifestHash
                || computeNavigationGenerationSealHash(sealState.seal) !== navigationCandidate.navigationSealHash
            ) {
                throw new Error('Cannot publish incremental completion proof: staged navigation seal is incompatible.');
            }
        } else {
            const registryState = await readSymbolRegistrySidecar({
                stateRoot: this.ports.symbolRegistryStateRoot,
                normalizedRootPath: canonicalRoot,
            });
            if (registryState.status !== 'ok') {
                throw new Error(`Cannot publish incremental completion proof: navigation registry is ${registryState.status}.`);
            }
            const relationshipState = await readRelationshipSidecar({
                stateRoot: this.ports.symbolRegistryStateRoot,
                normalizedRootPath: canonicalRoot,
                expectedSymbolRegistryManifestHash: registryState.manifestHash,
            });
            if (relationshipState.status !== 'ok') {
                throw new Error(`Cannot publish incremental completion proof: relationship evidence is ${relationshipState.status}.`);
            }

            const manifestHashes = new Map(
                registryState.registry.manifest.files.map((file) => [file.path, file.hash]),
            );
            if (manifestHashes.size !== searchablePreparedFileHashes.size) {
                throw new Error(
                    `Cannot publish incremental completion proof: synchronizer tracks ${searchablePreparedFileHashes.size} searchable files but navigation seals ${manifestHashes.size}.`,
                );
            }
            for (const [relativePath, expectedHash] of searchablePreparedFileHashes) {
                if (manifestHashes.get(relativePath) !== expectedHash) {
                    throw new Error(
                        `Cannot publish incremental completion proof: source hash for '${relativePath}' does not match the prepared synchronizer checkpoint.`,
                    );
                }
            }
        }

        const observedTotalChunks = preparedObservedTotalChunks === undefined
            ? await this.ports.countIndexedPayloadExactly(collectionName, undefined, expectedTotalChunks)
            : preparedObservedTotalChunks;
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

}
