/**
 * Phase 4.5 — Core index generation workflow.
 *
 * Owns full-index domain orchestration: candidate generation,
 * generation proof, publication/retention calls, and Core domain
 * results. All dependencies are narrow ports provided by Context; it never
 * acquires authority state by reachability through Context.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
    IndexCodebaseResult,
    ObservedResolvedIndexPolicy,
    Publication,
    PublicationRef,
} from './contracts';
import type { StagedPublicationNavigation } from '../symbols/sidecar-lifecycle';
import type { SymbolRecord, SymbolRegistryManifestFile } from '../symbols/contracts';
import type { SymbolRegistry } from '../symbols/registry';
import type {
    RelationshipAnalysisEvidence,
    ResolutionProjectAnalyzer,
    ResolutionProjectEvidence,
} from '../relationships';
import { buildRelationshipDelta, buildRelationshipsForRegistry } from '../relationships';
import type {
    SemanticAuxiliaryFile,
    SemanticProjectAnalyzer,
    SemanticProjectEvidence,
    SemanticProviderCoverage,
    SemanticSourceFile,
} from '../semantic';
import { defaultSemanticLanguageRegistry, type SemanticLanguageRegistry } from '../semantic/descriptor';
import type { LanguageAnalysisPort } from '../language-analysis';
import type { RelationshipRecord } from '../symbols/contracts';

import type { VectorFilter, VectorWriteMetricsSnapshot } from '../vectordb';
import type { VectorDatabase } from '../vectordb/types';
import type { IndexProfile } from '../config/defaults';
import type { ResolvedIndexPolicy, IndexPolicyRuntimeService } from '../policy/index-policy-runtime-service';
import type { Embedding, EmbeddingOperationMetricsSnapshot } from '../embedding';
import { FileSynchronizer } from '../sync/synchronizer';
import type { PublicationSourceCheckpoint } from '../sync/snapshot-codec';
import type { IndexAuthorityCoordinator } from './index-authority-coordinator';
import type {
    IndexedSourceFileObservation,
    ProcessedFileList,
} from '../core/indexing-pipeline';
import type { RootMutationLease } from './root-mutation-coordinator';
import { PublicationActivationError } from './publication-store';
import { stagePublicationNavigation } from '../symbols/sidecar-lifecycle';
import type { SatoriRepoConfig } from '../config/repo-config';
import { validateRepositoryRelativePath, type RepositoryRelativePath } from '../paths/repository-path';
import type { CustomIndexPolicyUpdate } from './contracts';
import {
    buildPublicationPackageOwnership,
    computePublicationPackageOwnershipDigest,
    discoverPackageOwnership,
    type PublicationPackageOwnership,
} from '../packages/ownership';

import {
    buildSymbolRegistry,
    computeNavigationSourceFilesDigest,
    computeSymbolRegistryManifestHash,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    SYMBOL_REGISTRY_SCHEMA_VERSION,
} from '../symbols';
import {
    assertDescriptorBoundIndexingSupported,
    resolveInsideRoot,
} from '../sync/root-bound-fs';
import { AtomicIncrementalPublicationUnsupportedError } from './errors';

// ---- Moved private types (Phase 4.5) ----
type NavigationDeltaBuildResult = {
    readonly candidate?: StagedPublicationNavigation;
    readonly state?: CachedNavigationDeltaState;
};
type ReindexByChangeOptions = {
    targetCollectionName?: string;
    assertMutationCurrent?: () => void;
    rootMutationLease?: RootMutationLease;
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
    assertMutationCurrent?: () => void;
    rootMutationLease?: RootMutationLease;
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
const TYPESCRIPT_RESOLUTION_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

function isTypeScriptResolutionSource(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return TYPESCRIPT_RESOLUTION_SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function boundedProviderFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.trim() || 'provider failure';
    return normalized.length <= 1024 ? normalized : `${normalized.slice(0, 1021)}...`;
}

function providerCoverageKey(coverage: Pick<SemanticProviderCoverage, 'language' | 'providerId'>): string {
    return `${coverage.language}\0${coverage.providerId}`;
}

function unavailableProviderCoverage(input: {
    language: string;
    providerId: string;
    providerVersion: string;
    environmentConfigId?: string;
    sourceFileCount: number;
    error: unknown;
}): SemanticProviderCoverage {
    return {
        language: input.language,
        providerId: input.providerId,
        providerVersion: input.providerVersion,
        ...(input.environmentConfigId ? { environmentConfigId: input.environmentConfigId } : {}),
        status: 'unavailable',
        sourceFileCount: input.sourceFileCount,
        analyzedSourceFileCount: 0,
        failureReason: 'provider_failure',
        failureMessage: boundedProviderFailureMessage(input.error),
    };
}

type CachedNavigationDeltaState = {
    readonly canonicalRoot: string;
    readonly publicationId: string;
    readonly navigationRoot: string;
    readonly symbolRegistryManifestHash: string;
    readonly relationshipManifestHash: string;
    readonly navigationObservationToken?: string;
    readonly registry: SymbolRegistry;
    readonly records: readonly RelationshipRecord[];
    readonly analysisByFile: Map<string, RelationshipAnalysisEvidence>;
    readonly providerCoverage: readonly SemanticProviderCoverage[];
};

// ---- Narrow dependency ports ----
export interface IndexGenerationWorkflowPorts {
    activatePublication(publication: Publication, lease: RootMutationLease): PublicationRef;
    getCurrentPublicationSourceCheckpoint(canonicalRoot: string): {
        ref: PublicationRef;
        checkpoint: PublicationSourceCheckpoint;
        observationToken: string;
    } | null;
    stagePublicationSourceCheckpoint(
        canonicalRoot: string,
        publicationId: string,
        checkpoint: PublicationSourceCheckpoint,
        lease: RootMutationLease,
    ): void;
    stagePublicationPackageOwnership(
        canonicalRoot: string,
        publicationId: string,
        ownership: PublicationPackageOwnership,
        lease: RootMutationLease,
    ): void;
    preparePublicationNavigationRoot(
        canonicalRoot: string,
        publicationId: string,
        lease: RootMutationLease,
    ): string;
    discardUnpublishedPublication(
        canonicalRoot: string,
        publicationId: string,
        lease: RootMutationLease,
    ): void;
    collectPublicationGarbage(
        canonicalRoot: string,
        lease: RootMutationLease,
    ): Promise<string[]>;
    getPublicationNavigation(
        canonicalRoot: string,
        publicationId: string,
    ): { publicationId: string; navigationRoot: string } | null;
    assertResolvedIndexPolicyRoot(codebasePath: string, policy: ResolvedIndexPolicy): void;
    buildPublicationFormat(): Publication['format'];
    buildRootFingerprint(canonicalRoot: string): string;
    canonicalizeCodebasePath(codebasePath: string): string;
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
    getActiveIgnorePatterns(codebasePath?: string): string[];
    getActiveIndexedCollectionName(codebasePath: string): Promise<string | null>;
    getCodeFiles(
            codebasePath: string,
            indexPolicy?: ResolvedIndexPolicy,
        ): Promise<string[]>;
    getIndexedExtensionsForCodebase(codebasePath: string): string[];
    getIsHybrid(): boolean;
    getLanguageRouterVersion(): string;
    getRelationshipVersion(): string;
    getSymbolExtractorVersion(): string;
    isObservedIndexPolicyControlSignatureCurrent(policy: ObservedResolvedIndexPolicy): Promise<boolean>;
    loadIgnorePatterns(codebasePath: string): Promise<void>;
    loadIndexProfileForCodebase(codebasePath: string): SatoriRepoConfig;
    normalizeRelativePathForCodebase(
            codebasePath: string,
            candidatePath: string,
        ): RepositoryRelativePath | null;
    normalizeRelativePathsForCodebase(codebasePath: string, relativePaths: string[]): string[];
    prepareCollection(
            codebasePath: string,
            forceReindex: boolean,
            assertMutationCurrent: (() => void) | undefined,
            collectionName: string,
        ): Promise<void>;
    processFileList(
            filePaths: string[],
            codebasePath: string,
            onFileProcessed: ((filePath: string, fileIndex: number, totalFiles: number) => void) | undefined,
            collectionName: string,
            assertMutationCurrent?: () => void,
            indexPolicy?: ResolvedIndexPolicy,
        ): Promise<ProcessedFileList>;
    refreshRuntimePolicyAuthority(canonicalRoot: string): void;
    resolveCollectionName(codebasePath: string): string;
    resolveIndexPolicyFromCurrentInputs(
            canonicalRoot: string,
            update: CustomIndexPolicyUpdate,
            inheritActiveCustomPolicy: boolean,
            activateRuntimeProfile: boolean,
        ): Promise<ObservedResolvedIndexPolicy>;
    resolveNavigationObservationToken(
            canonicalRoot: string,
            publicationId: string,
        ): string | null;
    resolvePublicationCollectionName(codebasePath: string, publicationId: string): string;
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
    buildIndexPolicyHash(codebasePath: string): string;

    readIndexableFileObservationInsideRoot(
            absoluteFile: string,
            canonicalRoot: string,
            indexPolicy?: ResolvedIndexPolicy,
        ): Promise<{ content: string; sourceHash: string } | null>;
    languageAnalyzer: LanguageAnalysisPort;
    semanticAnalyzer?: SemanticProjectAnalyzer;
    semanticLanguageRegistry?: SemanticLanguageRegistry;
    resolutionAnalyzer?: ResolutionProjectAnalyzer;
    embedding: Embedding;
    vectorDatabase: VectorDatabase;
    indexAuthorityCoordinator: IndexAuthorityCoordinator;
    indexPolicyRuntimeService: IndexPolicyRuntimeService;
    getSynchronizerForPublication(
        synchronizerKey: string,
        publicationId: string,
    ): FileSynchronizer | undefined;
    registerSynchronizerForPublication(
        synchronizerKey: string,
        publicationId: string,
        synchronizer: FileSynchronizer,
    ): void;
    getSynchronizerMutationTarget(synchronizerKey: string): string | undefined;
    setSynchronizerMutationTarget(synchronizerKey: string, collectionName: string): void;
    clearSynchronizerMutationTarget(synchronizerKey: string): void;
}

export class IndexGenerationWorkflow {
    private readonly reindexByChangeQueues = new Map<string, Promise<void>>();
    /**
     * Phase 8.4B - the workflow also owns the navigation warm state:
     * the staged-delta WeakMap and the promoted delta, with the complete
     * stage -> promote -> delete lifecycle.
     */
    private navigationDeltaState?: CachedNavigationDeltaState;
    private readonly preparedNavigationDeltaStates =
        new WeakMap<StagedPublicationNavigation, CachedNavigationDeltaState>();

    constructor(private readonly ports: IndexGenerationWorkflowPorts) {}

    public stagePreparedNavigationDelta(
        candidate: StagedPublicationNavigation,
        state: CachedNavigationDeltaState,
    ): void {
        this.preparedNavigationDeltaStates.set(candidate, state);
    }

    public promotePreparedNavigationDelta(
        candidate: StagedPublicationNavigation,
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

    public async stageSymbolRegistryForCompletedIndex(
        codebasePath: string,
        publicationId: string,
        navigationRoot: string,
        symbolRecords: SymbolRecord[],
        symbolManifestFiles: SymbolRegistryManifestFile[],
        observedFileHashes: ReadonlyMap<string, string>,
        assertMutationCurrent?: () => void,
        suppliedAnalysisByFile?: Map<string, RelationshipAnalysisEvidence>,
        indexPolicy?: ResolvedIndexPolicy,
        capturedSources?: readonly IndexedSourceFileObservation[],
    ): Promise<StagedPublicationNavigation | undefined> {
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
        const capturedSourcesByPath = new Map(
            (capturedSources ?? []).map((source) => [source.path, source]),
        );
        for (const file of manifestFiles) {
            const absoluteFile = path.resolve(canonicalRoot, file.path);
            const relativeFromRoot = path.relative(canonicalRoot, absoluteFile);
            if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
                throw new Error(`Navigation manifest path '${file.path}' escapes the codebase root.`);
            }
            const capturedSource = capturedSourcesByPath.get(validateRepositoryRelativePath(file.path));
            if (capturedSource && capturedSource.sourceHash !== file.hash) {
                throw new Error(`Source changed before navigation publication for '${file.path}'.`);
            }
            if (analysisByFile.has(file.path)) {
                continue;
            }
            const sourceObservation = await this.ports.readIndexableFileObservationInsideRoot(
                absoluteFile,
                canonicalRoot,
                indexPolicy,
            );
            if (sourceObservation === null) {
                throw new Error(`Navigation source no longer satisfies the active policy for '${file.path}'.`);
            }
            if (sourceObservation.sourceHash !== file.hash) {
                throw new Error(`Source changed before navigation publication for '${file.path}'.`);
            }
            const analysis = await this.ports.languageAnalyzer.analyze({
                content: sourceObservation.content,
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


        const providerCoverageByKey = new Map<string, SemanticProviderCoverage>();
        const semanticEvidenceByLanguage = new Map<string, SemanticProjectEvidence>();
        if (this.ports.semanticAnalyzer) {
            const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
            const semanticManifestByLanguage = new Map<string, SymbolRegistryManifestFile[]>();
            for (const file of manifestFiles) {
                if (!this.ports.semanticAnalyzer.supportsLanguage(file.language)) {
                    continue;
                }
                const list = semanticManifestByLanguage.get(file.language) ?? [];
                list.push(file);
                semanticManifestByLanguage.set(file.language, list);
            }

            for (const [language, semanticFiles] of semanticManifestByLanguage) {
                const sourceFiles: SemanticSourceFile[] = [];
                for (const file of semanticFiles) {
                    const absoluteFile = path.resolve(canonicalRoot, file.path);
                    const sourceObservation = await this.ports.readIndexableFileObservationInsideRoot(
                        absoluteFile,
                        canonicalRoot,
                        indexPolicy,
                    );
                    if (sourceObservation === null) {
                        throw new Error(`Semantic source no longer satisfies the active policy for '${file.path}'.`);
                    }
                    if (sourceObservation.sourceHash !== file.hash) {
                        throw new Error(`Source changed before semantic navigation publication for '${file.path}'.`);
                    }
                    sourceFiles.push({
                        path: file.path,
                        source: sourceObservation.content,
                        sourceHash: sourceObservation.sourceHash,
                    });
                }

                const auxiliaryFiles = await this.collectSemanticAuxiliariesForLanguage(
                    codebasePath,
                    language,
                    semanticRegistry,
                    observedFileHashes,
                );
                const descriptor = semanticRegistry.getDescriptor(language);
                if (!descriptor) {
                    throw new Error(`Semantic provider metadata is unavailable for '${language}'.`);
                }
                try {
                    const evidence = await this.ports.semanticAnalyzer.analyze({
                        language,
                        sourceFiles,
                        auxiliaryFiles,
                    });
                    semanticEvidenceByLanguage.set(language, evidence);
                    const coverage = evidence.coverage ?? {
                        language,
                        providerId: descriptor.providerId,
                        providerVersion: descriptor.providerVersion,
                        environmentConfigId: descriptor.environmentConfigId,
                        status: 'complete' as const,
                        sourceFileCount: sourceFiles.length,
                        analyzedSourceFileCount: sourceFiles.length,
                    };
                    providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                } catch (error) {
                    const coverage = unavailableProviderCoverage({
                        language,
                        providerId: descriptor.providerId,
                        providerVersion: descriptor.providerVersion,
                        environmentConfigId: descriptor.environmentConfigId,
                        sourceFileCount: sourceFiles.length,
                        error,
                    });
                    providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                    semanticEvidenceByLanguage.set(language, {
                        language,
                        occurrencesByFile: new Map(),
                        coverage,
                    });
                    console.warn(
                        `[Context] Optional semantic provider '${coverage.providerId}' failed for '${language}'; `
                        + `continuing with degraded relationship coverage: ${coverage.failureMessage}`,
                    );
                }
            }
        }

        const resolutionEvidenceByLanguage = new Map<string, ResolutionProjectEvidence>();
        if (this.ports.resolutionAnalyzer) {
            for (const language of new Set(manifestFiles.map((file) => file.language))) {
                if (!this.ports.resolutionAnalyzer.supportsLanguage(language)) continue;
                const sourceFileCount = manifestFiles.filter((file) => file.language === language).length;
                try {
                    const evidence = await this.ports.resolutionAnalyzer.analyze({
                        rootPath: canonicalRoot,
                        language,
                        registry,
                    });
                    resolutionEvidenceByLanguage.set(language, evidence);
                    const coverage = evidence.coverage ?? {
                        language,
                        providerId: evidence.providerId,
                        providerVersion: evidence.providerVersion,
                        environmentConfigId: evidence.environmentConfigId,
                        status: 'complete' as const,
                        sourceFileCount,
                        analyzedSourceFileCount: sourceFileCount,
                    };
                    providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                } catch (error) {
                    let metadata: Awaited<ReturnType<NonNullable<ResolutionProjectAnalyzer['getProviderMetadata']>>>;
                    try {
                        metadata = await this.ports.resolutionAnalyzer.getProviderMetadata?.(language);
                    } catch {
                        metadata = undefined;
                    }
                    if (!metadata) throw error;
                    const coverage = unavailableProviderCoverage({
                        language,
                        providerId: metadata.providerId,
                        providerVersion: metadata.providerVersion,
                        ...(metadata.environmentConfigId
                            ? { environmentConfigId: metadata.environmentConfigId }
                            : {}),
                        sourceFileCount,
                        error,
                    });
                    providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                    resolutionEvidenceByLanguage.set(language, {
                        language,
                        providerId: coverage.providerId,
                        providerVersion: coverage.providerVersion,
                        environmentConfigId: coverage.environmentConfigId ?? `unavailable:${coverage.providerId}`,
                        claimsByFile: new Map(),
                        affectedSourceFiles: new Set(
                            manifestFiles
                                .filter((file) => file.language === language)
                                .map((file) => file.path),
                        ),
                        coverage,
                    });
                    console.warn(
                        `[Context] Optional resolution provider '${coverage.providerId}' failed for '${language}'; `
                        + `continuing with degraded relationship coverage: ${coverage.failureMessage}`,
                    );
                }
            }
        }

        const relationshipRecords = buildRelationshipsForRegistry({
            registry,
            analysisByFile,
            semanticRegistry: this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry,
            semanticEvidenceByLanguage,
            resolutionEvidenceByLanguage,
        });

        assertMutationCurrent?.();
        const result = await stagePublicationNavigation({
            publicationId,
            navigationRoot,
            registry,
            records: relationshipRecords,
            analysisByFile,
            providerCoverage: [...providerCoverageByKey.values()],
        });
        this.stagePreparedNavigationDelta(result, {
            canonicalRoot,
            publicationId,
            navigationRoot,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipManifestHash: result.relationshipManifestHash,
            registry,
            records: relationshipRecords,
            analysisByFile,
            providerCoverage: [...providerCoverageByKey.values()],
        });
        console.log(`[Context] 🧭 Staged Publication '${publicationId}' navigation with ${result.symbolCount} symbols across ${result.fileShardCount} symbol shards and ${result.relationshipCount} relationships across ${result.relationshipFileShardCount} relationship shards`);
        return result;
    }


    refreshEmbedding(embedding: Embedding): void {
        this.ports.embedding = embedding;
    }

    refreshVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.ports.vectorDatabase = vectorDatabase;
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

    private buildTask2Publication(input: {
        publicationId: string;
        canonicalRoot: string;
        indexPolicy: ObservedResolvedIndexPolicy;
        collectionName: string;
        indexedFiles: number;
        totalChunks: number;
        status: Publication['status'];
        packageOwnershipDigest: string;
    }): Publication {
        const format = this.ports.buildPublicationFormat();
        return Object.freeze({
            version: 1 as const,
            id: input.publicationId,
            canonicalRoot: input.canonicalRoot,
            createdAt: new Date().toISOString(),
            status: input.status,
            policy: Object.freeze({
                profile: input.indexPolicy.profile,
                customExtensions: Object.freeze([...input.indexPolicy.customExtensions]),
                customIgnorePatterns: Object.freeze([...input.indexPolicy.customIgnorePatterns]),
                fileBasedIgnorePatterns: Object.freeze([...input.indexPolicy.fileBasedIgnorePatterns]),
                supportedExtensions: Object.freeze([...input.indexPolicy.supportedExtensions]),
                effectiveIgnorePatterns: Object.freeze([...input.indexPolicy.effectiveIgnorePatterns]),
                policyHash: input.indexPolicy.policyHash,
                controlSignature: input.indexPolicy.controlSignature,
            }),
            format: Object.freeze({ ...format }),
            vector: Object.freeze({
                collectionName: input.collectionName,
                indexedFiles: input.indexedFiles,
                totalChunks: input.totalChunks,
            }),
            packageOwnership: Object.freeze({ digest: input.packageOwnershipDigest }),
            navigation: input.status === 'complete'
                ? Object.freeze({ relativeRoot: 'navigation' as const })
                : null,
        });
    }

    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: MutationGuardOptions = {},
    ): Promise<IndexCodebaseResult> {
        const operationStartedAt = Date.now();
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
        const mutationLease = options.rootMutationLease;
        if (!mutationLease) {
            throw new Error('Full candidate construction requires the Core-owned root mutation lease.');
        }
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        if (mutationLease.canonicalRoot !== canonicalRoot) {
            throw new Error(`Full candidate mutation lease does not own '${canonicalRoot}'.`);
        }
        const publicationId = mutationLease.operationId;
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

        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        const writeCollectionName = this.ports.resolvePublicationCollectionName(codebasePath, publicationId);
        const prepareStartedAt = Date.now();
        await this.ports.prepareCollection(
            codebasePath,
            true,
            options.assertMutationCurrent,
            writeCollectionName,
        );
        prepareCollectionMs = Date.now() - prepareStartedAt;

        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const scanStartedAt = Date.now();
        const scannedCodeFiles = await this.ports.getCodeFiles(codebasePath, indexPolicy);
        const scannedRelativePaths = scannedCodeFiles.map((filePath) => {
            const relativePath = this.ports.normalizeRelativePathForCodebase(codebasePath, filePath);
            if (!relativePath) {
                throw new Error(`Full index selected source path '${filePath}' is outside '${canonicalRoot}'.`);
            }
            return relativePath;
        });
        const resolutionSourceControls = await this.collectResolutionSourceControls(
            canonicalRoot,
            scannedRelativePaths,
        );
        const packageOwnershipSourceControls = this.collectPackageOwnershipSourceControls(canonicalRoot);
        const publicationSourceControls = this.mergePublicationSourceControls(
            resolutionSourceControls,
            packageOwnershipSourceControls,
        );
        const publicationControlSet = new Set(publicationSourceControls);
        const codeFiles = scannedCodeFiles.filter((filePath, index) => !publicationControlSet.has(scannedRelativePaths[index]));
        scanFilesMs = Date.now() - scanStartedAt;
        console.log(`[Context] 📁 Found ${codeFiles.length} searchable code files`);
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 100;
        const indexingRange = indexingEndPercentage - indexingStartPercentage;

        let navigationCandidate: StagedPublicationNavigation | undefined;
        let publicationStatus: 'staged' | 'activated' = 'staged';
        let result!: ProcessedFileList;
        let synchronizer: FileSynchronizer | undefined;
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

            const finalizeStartedAt = Date.now();
            await this.finalizePreparedCollection(writeCollectionName, options.assertMutationCurrent);
            finalizeCollectionMs = Date.now() - finalizeStartedAt;

            console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

            const selectedSourcePaths = codeFiles.map((filePath) => {
                const relativePath = this.ports.normalizeRelativePathForCodebase(codebasePath, filePath);
                if (!relativePath) {
                    throw new Error(`Full index selected source path '${filePath}' is outside '${canonicalRoot}'.`);
                }
                return relativePath;
            });
            const consumedSourcePaths = new Set(result.sourceFiles.map((source) => source.path));
            if ([...consumedSourcePaths].some((filePath) => !selectedSourcePaths.includes(filePath))) {
                throw new Error('Full index captured source evidence for a path outside the selected source set.');
            }
            const capturedFullIndexSource = {
                fileHashes: new Map(result.sourceFiles.map((source) => [source.path, source.sourceHash])),
                fileStats: new Map(result.sourceFiles.map((source) => [source.path, source.sourceStat])),
                unprocessedPaths: selectedSourcePaths.filter((filePath) => !consumedSourcePaths.has(filePath)),
            };

            if (result.status === 'completed') {
                if (result.sourceFiles.length !== result.processedFiles) {
                    throw new Error(
                        `Completed full index source coverage is inconsistent: ${result.processedFiles} processed files but ${result.sourceFiles.length} captured source observations.`,
                    );
                }
                if (capturedFullIndexSource.unprocessedPaths.length > 0) {
                    throw new Error('Completed full index source coverage is missing selected source paths.');
                }
                synchronizer = new FileSynchronizer(
                    codebasePath,
                    indexPolicy.effectiveIgnorePatterns,
                    indexPolicy.supportedExtensions,
                    { additionalObservablePaths: publicationSourceControls },
                );
                const preparedChanges = await synchronizer.prepareChanges({
                    capturedFullIndexSource,
                });
                const navigationStartedAt = Date.now();
                const navigationRoot = this.ports.preparePublicationNavigationRoot(
                    canonicalRoot,
                    publicationId,
                    mutationLease,
                );
                navigationCandidate = await this.stageSymbolRegistryForCompletedIndex(
                    codebasePath,
                    publicationId,
                    navigationRoot,
                    result.symbolRecords,
                    result.symbolManifestFiles,
                    preparedChanges.fileHashes,
                    options.assertMutationCurrent,
                    result.analysisByFile,
                    indexPolicy,
                    result.sourceFiles,
                );
                navigationMs = Date.now() - navigationStartedAt;
                const packageOwnership = buildPublicationPackageOwnership(
                    canonicalRoot,
                    result.sourceFiles.map((source) => source.path),
                    preparedChanges.fileHashes,
                );
                this.ports.stagePublicationPackageOwnership(
                    canonicalRoot,
                    publicationId,
                    packageOwnership,
                    mutationLease,
                );
                this.ports.stagePublicationSourceCheckpoint(
                    canonicalRoot,
                    publicationId,
                    preparedChanges.sourceCheckpoint,
                    mutationLease,
                );
                await preparedChanges.assertSourceObservationCurrent();
                if (!await this.ports.isObservedIndexPolicyControlSignatureCurrent(indexPolicy)) {
                    throw new Error(`index_policy_changed: Repository index-policy controls changed while indexing '${canonicalRoot}'.`);
                }
                options.assertMutationCurrent?.();
                const publicationStartedAt = Date.now();
                if (!navigationCandidate) {
                    throw new Error(`Completed index candidate for '${canonicalRoot}' did not produce sealed navigation.`);
                }
                const publication = this.buildTask2Publication({
                    publicationId,
                    canonicalRoot,
                    indexPolicy,
                    collectionName: writeCollectionName,
                    indexedFiles: result.processedFiles,
                    totalChunks: result.totalChunks,
                    status: 'complete',
                    packageOwnershipDigest: computePublicationPackageOwnershipDigest(packageOwnership),
                });
                try {
                    this.ports.activatePublication(publication, mutationLease);
                } catch (error) {
                    if (
                        !(error instanceof PublicationActivationError)
                        || error.ref.id !== publicationId
                        || error.durability !== 'durable'
                    ) {
                        throw error;
                    }
                    console.warn(`[Context] Publication '${publicationId}' became crash-durable before activation acknowledgement failed: ${error.activationCause instanceof Error ? error.activationCause.message : String(error.activationCause)}`);
                }
                publicationStatus = 'activated';
                this.promotePreparedNavigationDelta(
                    navigationCandidate,
                    () => this.ports.resolveNavigationObservationToken(canonicalRoot, publicationId),
                );
                await preparedChanges.commit(options.assertMutationCurrent);
                this.ports.registerSynchronizerForPublication(
                    writeCollectionName,
                    publicationId,
                    synchronizer,
                );
                this.ports.registerSynchronizerForPublication(
                    this.ports.resolveCollectionName(codebasePath),
                    publicationId,
                    synchronizer,
                );
                publicationMs = Date.now() - publicationStartedAt;
            } else {
                console.warn('[Context] ⚠️  Skipping symbol registry sidecar write because indexing stopped before processing the full file set.');
                if (!options.deferPartialPublication) {
                    synchronizer = new FileSynchronizer(
                        codebasePath,
                        indexPolicy.effectiveIgnorePatterns,
                        indexPolicy.supportedExtensions,
                        { additionalObservablePaths: publicationSourceControls },
                    );
                    const preparedChanges = await synchronizer.prepareChanges({
                        capturedFullIndexSource,
                    });
                    const packageOwnership = buildPublicationPackageOwnership(
                        canonicalRoot,
                        result.sourceFiles.slice(0, result.processedFiles).map((source) => source.path),
                        preparedChanges.fileHashes,
                    );
                    this.ports.stagePublicationPackageOwnership(
                        canonicalRoot,
                        publicationId,
                        packageOwnership,
                        mutationLease,
                    );
                    this.ports.stagePublicationSourceCheckpoint(
                        canonicalRoot,
                        publicationId,
                        preparedChanges.sourceCheckpoint,
                        mutationLease,
                    );
                    await preparedChanges.assertSourceObservationCurrent();
                    if (!await this.ports.isObservedIndexPolicyControlSignatureCurrent(indexPolicy)) {
                        throw new Error(`index_policy_changed: Repository index-policy controls changed while indexing '${canonicalRoot}'.`);
                    }
                    const publicationStartedAt = Date.now();
                    const publication = this.buildTask2Publication({
                        publicationId,
                        canonicalRoot,
                        indexPolicy,
                        collectionName: writeCollectionName,
                        indexedFiles: result.processedFiles,
                        totalChunks: result.totalChunks,
                        status: 'partial',
                        packageOwnershipDigest: computePublicationPackageOwnershipDigest(packageOwnership),
                    });
                    try {
                        this.ports.activatePublication(publication, mutationLease);
                    } catch (error) {
                        if (
                            !(error instanceof PublicationActivationError)
                            || error.ref.id !== publicationId
                            || error.durability !== 'durable'
                        ) {
                            throw error;
                        }
                        console.warn(`[Context] Publication '${publicationId}' became crash-durable before activation acknowledgement failed: ${error.activationCause instanceof Error ? error.activationCause.message : String(error.activationCause)}`);
                    }
                    publicationStatus = 'activated';
                    await preparedChanges.commit(options.assertMutationCurrent);
                    this.ports.registerSynchronizerForPublication(
                        writeCollectionName,
                        publicationId,
                        synchronizer,
                    );
                    this.ports.registerSynchronizerForPublication(
                        this.ports.resolveCollectionName(codebasePath),
                        publicationId,
                        synchronizer,
                    );
                    console.warn('[Context] ⚠️  Activated limit_reached partial Publication (navigation remains null).');
                    publicationMs = Date.now() - publicationStartedAt;
                }
            }

            if (publicationStatus === 'activated') {
                try {
                    await this.ports.collectPublicationGarbage(canonicalRoot, mutationLease);
                } catch (gcError) {
                    console.warn(
                        `[Context] Publication GC after full-index activation retained retryable historical state for '${canonicalRoot}': ${gcError instanceof Error ? gcError.message : String(gcError)}`,
                    );
                }
            }
        } catch (error) {
            if (
                error instanceof PublicationActivationError
                && error.ref.id === publicationId
                && error.durability === 'visible_unconfirmed'
            ) {
                console.error(
                    `[Context] Publication '${publicationId}' current pointer is visible but crash durability is unconfirmed; retaining the new generation and selectors while surfacing activation failure.`,
                );
                throw error;
            }
            if (publicationStatus === 'activated') {
                console.warn(
                    `[Context] Publication '${publicationId}' is already current; retaining the committed generation after post-activation acknowledgement failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            } else {
                try {
                    this.ports.discardUnpublishedPublication(canonicalRoot, publicationId, mutationLease);
                } catch (cleanupError) {
                    console.warn(
                        `[Context] Failed to discard unpublished Publication '${publicationId}': ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                    );
                }
                await this.ports.vectorDatabase.dropCollection(writeCollectionName).catch(() => undefined);
                throw error;
            }
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
            collectionName: writeCollectionName,
            indexedPaths: result.sourceFiles
                .slice(0, result.processedFiles)
                .map((source) => source.path),
            publication: {
                id: publicationId,
                status: publicationStatus,
            },
        };
    }

    private async performAtomicDeltaPublication(input: {
        codebasePath: string;
        canonicalRoot: string;
        sourcePublication: PublicationRef;
        sourceCollectionName: string;
        sealedPolicy: ResolvedIndexPolicy;
        synchronizerKey: string;
        synchronizer: FileSynchronizer;
        preparedChanges: Awaited<ReturnType<FileSynchronizer['prepareChanges']>>;
        resolutionSourceControls: ReadonlySet<string>;
        packageOwnershipSourceControls: ReadonlySet<string>;
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
                | 'publication_activation',
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
        const sourcePublicationId = input.sourcePublication.id;
        if (!input.sourcePublication.publication.navigation) {
            throw new Error('Atomic delta publication requires navigation owned by the active source Publication; reindex is required.');
        }
        if (!this.ports.vectorDatabase.forkCollection) {
            throw new AtomicIncrementalPublicationUnsupportedError();
        }
        const mutationLease = input.options.rootMutationLease;
        if (!mutationLease || mutationLease.canonicalRoot !== input.canonicalRoot) {
            throw new Error('Atomic delta publication requires the Core-owned root mutation lease.');
        }
        const currentSource = this.ports.getCurrentPublicationSourceCheckpoint(input.canonicalRoot);
        if (!currentSource || currentSource.ref.id !== sourcePublicationId) {
            throw new Error(`Cannot incrementally synchronize '${input.codebasePath}': current Publication changed before candidate construction.`);
        }
        const sourceNavigationResource = this.ports.getPublicationNavigation(
            input.canonicalRoot,
            sourcePublicationId,
        );
        if (!sourceNavigationResource) {
            throw new Error('Atomic delta publication cannot resolve its source Publication navigation; reindex is required.');
        }
        const reusableNavigationState = this.resolveReusableNavigationDeltaState(
            input.canonicalRoot,
            sourcePublicationId,
            sourceNavigationResource.navigationRoot,
        );
        let existingRegistry: SymbolRegistry;
        if (reusableNavigationState) {
            existingRegistry = reusableNavigationState.registry;
        } else {
            existingRegistry = await measurePublicationPhase(
                'publication_source_navigation_load',
                async () => {
                    const registryRead = await readSymbolRegistrySidecar({
                        normalizedRootPath: input.canonicalRoot,
                        publicationId: sourcePublicationId,
                        navigationRoot: sourceNavigationResource.navigationRoot,
                    });
                    if (registryRead.status !== 'ok') {
                        throw new Error('Atomic delta publication cannot read its source Publication navigation; reindex is required.');
                    }
                    return registryRead.registry;
                },
            );
        }

        const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
        const publicationSourceControls = new Set([
            ...input.resolutionSourceControls,
            ...input.packageOwnershipSourceControls,
        ]);
        const isSearchable = (filePath: string) => (
            !semanticRegistry.isAuxiliaryPath(filePath)
            && !publicationSourceControls.has(filePath)
        );
        // Older Publications indexed auxiliaries with supported extensions (e.g. Cargo.toml).
        // Remove those documents even when the source file itself has not changed.
        const existingSearchablePaths = new Set(
            existingRegistry.manifest.files.map((file) => file.path),
        );
        const newlySearchablePaths = [...input.preparedChanges.fileHashes.keys()]
            .filter((filePath) => isSearchable(filePath) && !existingSearchablePaths.has(filePath));
        const legacyAuxiliaryPaths = existingRegistry.manifest.files
            .filter((file) => !isSearchable(file.path))
            .map((file) => file.path);
        const searchableChangedFiles = Array.from(new Set([
            ...changedFiles.filter(isSearchable),
            ...newlySearchablePaths,
            ...legacyAuxiliaryPaths,
        ]));
        const navigationChangedFiles = Array.from(new Set([
            ...changedFiles,
            ...newlySearchablePaths,
            ...legacyAuxiliaryPaths,
        ]));
        const publicationId = mutationLease.operationId;
        const candidateCollectionName = this.ports.resolvePublicationCollectionName(input.codebasePath, publicationId);
        const publicationState = { activated: false };
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
                    for (const relativePath of searchableChangedFiles) {
                        const pathCount = await this.ports.countIndexedPayloadExactly(
                            candidateCollectionName,
                            { kind: 'comparison', field: 'relativePath', operator: 'eq', value: relativePath },
                            input.sourcePublication.publication.vector.totalChunks,
                        );
                        if (pathCount === null) {
                            throw new Error(`Atomic delta publication could not count existing payload for '${relativePath}'.`);
                        }
                        replacedPayloadCount += pathCount;
                        await this.ports.deleteFileChunks(candidateCollectionName, relativePath, input.options.assertMutationCurrent);
                    }

                    let processedChanges = 0;
                    const filesToIndex = Array.from(new Set([
                        ...added,
                        ...modified,
                        ...newlySearchablePaths,
                    ]))
                        .filter(isSearchable)
                        .map((file) => path.join(input.codebasePath, file));
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
            const totalChunks = input.sourcePublication.publication.vector.totalChunks - replacedPayloadCount + indexedDelta.totalChunks;
            if (!Number.isSafeInteger(totalChunks) || totalChunks < 0) {
                throw new Error('Atomic delta publication produced an invalid payload count.');
            }

            const candidateNavigationRoot = this.ports.preparePublicationNavigationRoot(
                input.canonicalRoot,
                publicationId,
                mutationLease,
            );
            const navigationPromise = measurePublicationPhase(
                'publication_navigation_delta',
                () => this.rebuildNavigationArtifactsForSyncDelta(
                    input.codebasePath,
                    existingRegistry,
                    navigationChangedFiles,
                    indexedDelta.symbolRecords,
                    indexedDelta.symbolManifestFiles,
                    sourcePublicationId,
                    sourceNavigationResource.navigationRoot,
                    publicationId,
                    candidateNavigationRoot,
                    input.preparedChanges.fileHashes,
                    input.options.assertMutationCurrent,
                    indexedDelta.analysisByFile,
                    reusableNavigationState,
                    input.options.onPhaseTiming,
                ),
            ).then((result) => {
                if (!result.candidate) {
                    throw new Error('Atomic delta publication cannot publish a repository without navigation state.');
                }
                return result;
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
                typeof payloadCountPromise,
            ]>>>;
            try {
                candidateResults = await measurePublicationPhase(
                    'publication_navigation_checkpoint',
                    () => Promise.all([
                        navigationPromise,
                        payloadCountPromise,
                    ]),
                );
            } catch (error) {
                await Promise.allSettled([navigationPromise, payloadCountPromise]);
                throw error;
            }
            const [preparedNavigationResult, observedTotalChunks] = candidateResults;
            const preparedNavigation = preparedNavigationResult.candidate;
            if (!preparedNavigation || !preparedNavigationResult.state) {
                throw new Error('Atomic delta publication did not prepare reusable navigation state.');
            }
            const preparedNavigationState = preparedNavigationResult.state;
            const searchablePreparedFileHashes = new Map(
                [...input.preparedChanges.fileHashes.entries()].filter(([filePath]) => isSearchable(filePath)),
            );
            let packageOwnershipDigest: string | null = null;
            await measurePublicationPhase(
                'publication_checkpoint_stage',
                async () => {
                    const packageOwnership = buildPublicationPackageOwnership(
                        input.canonicalRoot,
                        [...searchablePreparedFileHashes.keys()],
                        input.preparedChanges.fileHashes,
                    );
                    packageOwnershipDigest = computePublicationPackageOwnershipDigest(packageOwnership);
                    this.ports.stagePublicationPackageOwnership(
                        input.canonicalRoot,
                        publicationId,
                        packageOwnership,
                        mutationLease,
                    );
                    this.ports.stagePublicationSourceCheckpoint(
                        input.canonicalRoot,
                        publicationId,
                        input.preparedChanges.sourceCheckpoint,
                        mutationLease,
                    );
                },
            );
            await measurePublicationPhase(
                'publication_activation',
                async () => {
                    await this.verifyPreparedSyncPublication(
                        input.codebasePath,
                        candidateCollectionName,
                        input.preparedChanges.fileHashes,
                        publicationSourceControls,
                        totalChunks,
                        preparedNavigation,
                        observedTotalChunks,
                    );
                    await input.preparedChanges.assertSourceObservationCurrent();
                    if (!await this.ports.isObservedIndexPolicyControlSignatureCurrent(
                        input.sealedPolicy as ObservedResolvedIndexPolicy,
                    )) {
                        throw new Error(
                            `index_policy_changed: Repository index-policy controls changed while synchronizing '${input.canonicalRoot}'.`,
                        );
                    }
                    input.options.assertMutationCurrent?.();
                    if (!packageOwnershipDigest) {
                        throw new Error('Atomic delta Publication is missing package ownership digest.');
                    }
                    const publication = this.buildTask2Publication({
                        publicationId,
                        canonicalRoot: input.canonicalRoot,
                        indexPolicy: input.sealedPolicy as ObservedResolvedIndexPolicy,
                        collectionName: candidateCollectionName,
                        indexedFiles: searchablePreparedFileHashes.size,
                        totalChunks,
                        status: 'complete',
                        packageOwnershipDigest,
                    });
                    try {
                        this.ports.activatePublication(publication, mutationLease);
                    } catch (error) {
                        if (
                            !(error instanceof PublicationActivationError)
                            || error.ref.id !== publicationId
                            || error.durability !== 'durable'
                        ) {
                            throw error;
                        }
                        console.warn(`[Context] Publication '${publicationId}' became crash-durable before sync activation acknowledgement failed: ${error.activationCause instanceof Error ? error.activationCause.message : String(error.activationCause)}`);
                    }
                    publicationState.activated = true;
                    await input.preparedChanges.commit(input.options.assertMutationCurrent);
                    const navigationObservationToken = this.ports.resolveNavigationObservationToken(
                        input.canonicalRoot,
                        publicationId,
                    );
                    this.navigationDeltaState = navigationObservationToken
                        ? {
                            ...preparedNavigationState,
                            navigationObservationToken,
                        }
                        : undefined;

                },
            );

            this.ports.registerSynchronizerForPublication(
                input.synchronizerKey,
                publicationId,
                input.synchronizer,
            );
            this.ports.registerSynchronizerForPublication(
                candidateCollectionName,
                publicationId,
                input.synchronizer,
            );
            try {
                await this.ports.collectPublicationGarbage(input.canonicalRoot, mutationLease);
            } catch (gcError) {
                console.warn(
                    `[Context] Publication GC after sync activation retained retryable historical state for '${input.canonicalRoot}': ${gcError instanceof Error ? gcError.message : String(gcError)}`,
                );
            }

            return {
                added: added.length,
                removed: removed.length,
                modified: modified.length,
                changedFiles,
                collectionName: candidateCollectionName,
                indexedFiles: searchablePreparedFileHashes.size,
                totalChunks,
                indexStatus: 'completed',
            };
        } catch (error) {
            if (
                error instanceof PublicationActivationError
                && error.ref.id === publicationId
                && error.durability === 'visible_unconfirmed'
            ) {
                console.error(
                    `[Context] Publication '${publicationId}' current pointer is visible but crash durability is unconfirmed; retaining the sync generation and selectors while surfacing activation failure.`,
                );
                throw error;
            }
            if (!publicationState.activated) {
                try {
                    this.ports.discardUnpublishedPublication(
                        input.canonicalRoot,
                        publicationId,
                        mutationLease,
                    );
                } catch (cleanupError) {
                    console.warn(
                        `[Context] Failed to discard unpublished Publication '${publicationId}': ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                    );
                }
                await this.ports.vectorDatabase.dropCollection(candidateCollectionName).catch(() => undefined);
            }
            throw error;
        }
    }

    private async performReindexByChange(
        codebasePath: string,
        progressCallback: ((progress: { phase: string; current: number; total: number; percentage: number }) => void) | undefined,
        options: ReindexByChangeOptions,
    ): Promise<ReindexByChangeResult> {
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        this.ports.refreshRuntimePolicyAuthority(canonicalRoot);
        const currentPublicationSource = this.ports.getCurrentPublicationSourceCheckpoint(canonicalRoot);

        if (!currentPublicationSource) {
            console.warn(`[Context] ⚠️  No current Publication exists for '${codebasePath}'. Rebuilding full index before incremental sync resumes.`);
            const changedFiles = this.ports.normalizeRelativePathsForCodebase(
                codebasePath,
                await this.ports.getCodeFiles(codebasePath),
            );
            if (changedFiles.length === 0) {
                progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
                return { added: 0, removed: 0, modified: 0, changedFiles: [] };
            }
            const indexResult = await this.indexCodebase(codebasePath, progressCallback, options);
            return {
                added: changedFiles.length,
                removed: 0,
                modified: 0,
                changedFiles,
                collectionName: indexResult.collectionName,
                indexedFiles: indexResult.indexedFiles,
                totalChunks: indexResult.totalChunks,
                indexStatus: indexResult.status,
            };
        }

        if (
            options.sourcePublication
            && options.sourcePublication.id !== currentPublicationSource.ref.id
        ) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': prepared source Publication changed before candidate construction.`);
        }

        const collectionName = currentPublicationSource.ref.publication.vector.collectionName;
        if (options.targetCollectionName && options.targetCollectionName.trim() !== collectionName) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': target collection must be the current Publication vector collection.`);
        }
        if (!(await this.ports.vectorDatabase.hasCollection(collectionName))) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': current Publication vector collection '${collectionName}' is missing; reindex is required.`);
        }

        const sealedPolicy = this.ports.indexAuthorityCoordinator.getPublishedResolvedPolicy(canonicalRoot);
        if (
            !sealedPolicy
            || this.ports.indexPolicyRuntimeService.getPolicyRuntimeCompatibility(canonicalRoot) !== true
            || sealedPolicy.policyHash !== currentPublicationSource.ref.publication.policy.policyHash
            || sealedPolicy.controlSignature !== currentPublicationSource.ref.publication.policy.controlSignature
        ) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': current Publication policy is not runtime-compatible; reindex is required.`);
        }

        await this.ports.loadIgnorePatterns(codebasePath);
        const synchronizerKey = this.ports.resolveCollectionName(codebasePath);
        const currentPublicationId = currentPublicationSource.ref.id;
        const currentSynchronizer = this.ports.getSynchronizerForPublication(
            synchronizerKey,
            currentPublicationId,
        ) ?? this.ports.getSynchronizerForPublication(
            collectionName,
            currentPublicationId,
        ) ?? new FileSynchronizer(
            codebasePath,
            this.ports.getActiveIgnorePatterns(codebasePath),
            this.ports.getIndexedExtensionsForCodebase(codebasePath),
            { sourceCheckpoint: currentPublicationSource.checkpoint },
        );
        let resolutionSourceControls = await this.collectResolutionSourceControls(
            canonicalRoot,
            currentSynchronizer.getTrackedRelativePaths(),
        );
        let packageOwnershipSourceControls = this.collectPackageOwnershipSourceControls(canonicalRoot);
        let publicationSourceControls = this.mergePublicationSourceControls(
            resolutionSourceControls,
            packageOwnershipSourceControls,
        );
        currentSynchronizer.setAdditionalObservablePaths(publicationSourceControls);

        this.ports.registerSynchronizerForPublication(
            synchronizerKey,
            currentPublicationId,
            currentSynchronizer,
        );
        this.ports.registerSynchronizerForPublication(
            collectionName,
            currentPublicationId,
            currentSynchronizer,
        );

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        let preparedChanges = await currentSynchronizer.prepareChanges();
        const nextResolutionSourcePaths = new Set(currentSynchronizer.getTrackedRelativePaths());
        for (const filePath of preparedChanges.changes.removed) nextResolutionSourcePaths.delete(filePath);
        for (const filePath of preparedChanges.changes.added) nextResolutionSourcePaths.add(filePath);
        const nextResolutionSourceControls = await this.collectResolutionSourceControls(
            canonicalRoot,
            [...nextResolutionSourcePaths],
        );
        const nextPackageOwnershipSourceControls = this.collectPackageOwnershipSourceControls(canonicalRoot);
        const nextPublicationSourceControls = this.mergePublicationSourceControls(
            nextResolutionSourceControls,
            nextPackageOwnershipSourceControls,
        );
        if (JSON.stringify(nextPublicationSourceControls) !== JSON.stringify(publicationSourceControls)) {
            resolutionSourceControls = nextResolutionSourceControls;
            packageOwnershipSourceControls = nextPackageOwnershipSourceControls;
            publicationSourceControls = nextPublicationSourceControls;
            currentSynchronizer.setAdditionalObservablePaths(publicationSourceControls);
            preparedChanges = await currentSynchronizer.prepareChanges();
        }
        const { added, removed, modified } = preparedChanges.changes;
        const totalChanges = added.length + removed.length + modified.length;
        const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
        const resolutionControlSet = new Set(resolutionSourceControls);
        const packageOwnershipControlSet = new Set(packageOwnershipSourceControls);
        const publicationControlSet = new Set(publicationSourceControls);
        const searchableFileCount = [...preparedChanges.fileHashes.keys()]
            .filter((filePath) => !semanticRegistry.isAuxiliaryPath(filePath) && !publicationControlSet.has(filePath)).length;

        // A quiet tree can still need to shed legacy searchable auxiliary documents.
        if (totalChanges === 0 && (
            currentPublicationSource.ref.publication.status !== 'complete'
            || currentPublicationSource.ref.publication.vector.indexedFiles === searchableFileCount
        )) {
            options.assertMutationCurrent?.();
            await preparedChanges.commit(options.assertMutationCurrent);
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            this.ports.clearSynchronizerMutationTarget(synchronizerKey);
            return {
                added: 0,
                removed: 0,
                modified: 0,
                changedFiles: [],
                collectionName,
                indexedFiles: currentPublicationSource.ref.publication.vector.indexedFiles,
                totalChunks: currentPublicationSource.ref.publication.vector.totalChunks,
                indexStatus: currentPublicationSource.ref.publication.status === 'complete' ? 'completed' : 'limit_reached',
            };
        }

        if (
            !currentPublicationSource.ref.publication.navigation
            || this.ports.vectorDatabase.getPublicationCapabilities?.().atomicCandidatePublication === 'unsupported'
            || !this.ports.vectorDatabase.forkCollection
        ) {
            throw new AtomicIncrementalPublicationUnsupportedError();
        }

        return this.performAtomicDeltaPublication({
            codebasePath,
            canonicalRoot,
            sourcePublication: currentPublicationSource.ref,
            sourceCollectionName: collectionName,
            sealedPolicy,
            synchronizerKey,
            synchronizer: currentSynchronizer,
            preparedChanges,
            resolutionSourceControls: resolutionControlSet,
            packageOwnershipSourceControls: packageOwnershipControlSet,
            options,
            progressCallback,
        });
    }

    private async collectResolutionSourceControls(
        codebasePath: string,
        sourcePaths: readonly string[],
    ): Promise<string[]> {
        const analyzer = this.ports.resolutionAnalyzer;
        if (!analyzer?.getSourceControlFiles || !analyzer.supportsLanguage('typescript')) return [];
        const typeScriptFiles = sourcePaths
            .map((filePath) => filePath.replace(/\\/g, '/').replace(/^\/+/, ''))
            .filter(isTypeScriptResolutionSource);
        if (typeScriptFiles.length === 0) return [];
        return [...new Set(await analyzer.getSourceControlFiles({
            rootPath: codebasePath,
            language: 'typescript',
            sourceFiles: typeScriptFiles,
        }))].sort();
    }

    private collectPackageOwnershipSourceControls(codebasePath: string): string[] {
        return discoverPackageOwnership(codebasePath).controlFiles.map(([filePath]) => filePath);
    }

    private mergePublicationSourceControls(
        ...controlSets: readonly (readonly string[])[]
    ): string[] {
        return [...new Set(controlSets.flatMap((controls) => [...controls]))].sort();
    }

    private async collectSemanticAuxiliariesForLanguage(
        codebasePath: string,
        language: string,
        registry: SemanticLanguageRegistry,
        observedFileHashes: ReadonlyMap<string, string>,
    ): Promise<SemanticAuxiliaryFile[]> {
        const desc = registry.getDescriptor(language);
        if (!desc || desc.auxiliaryFiles.length === 0) return [];

        const results: SemanticAuxiliaryFile[] = [];
        // The prepared checkpoint owns file selection, including ignore and observation policy.
        for (const [relativePath, expectedHash] of observedFileHashes) {
            const match = registry.matchAuxiliaries(relativePath).find((entry) => entry.language === language);
            if (!match) continue;
            const realPath = await resolveInsideRoot(path.resolve(codebasePath, relativePath), codebasePath);
            if (!realPath) {
                throw new Error(`Failed to resolve semantic auxiliary file inside root: ${relativePath}`);
            }
            const content = fs.readFileSync(realPath, 'utf8');
            const sourceHash = crypto.createHash('sha256').update(content).digest('hex');
            if (sourceHash !== expectedHash) {
                throw new Error(`Semantic auxiliary source hash mismatch for ${relativePath}: expected ${expectedHash}, got ${sourceHash}`);
            }
            results.push({ path: relativePath, role: match.role, source: content, sourceHash });
        }
        return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }

    private async rebuildNavigationArtifactsForSyncDelta(
        codebasePath: string,
        existingRegistry: SymbolRegistry,
        changedRelativePaths: string[],
        rebuiltSymbolRecords: SymbolRecord[],
        rebuiltManifestFiles: SymbolRegistryManifestFile[],
        sourcePublicationId: string,
        sourceNavigationRoot: string,
        publicationId: string,
        navigationRoot: string,
        observedFileHashes: ReadonlyMap<string, string>,
        assertMutationCurrent?: () => void,
        analysisByFile?: Map<string, RelationshipAnalysisEvidence>,
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
                providerCoverage: existingRelationshipState.providerCoverage,
            }
            : await measurePhase(
                'publication_relationship_load',
                () => readRelationshipSidecar({
                    normalizedRootPath: this.ports.canonicalizeCodebasePath(codebasePath),
                    publicationId: sourcePublicationId,
                    navigationRoot: sourceNavigationRoot,
                    expectedSymbolRegistryManifestHash: computeSymbolRegistryManifestHash(existingRegistry.manifest),
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

        if (existingRelationships.status !== 'ok') {
            throw new Error('Atomic navigation delta cannot read the source Publication relationships; reindex is required.');
        }

        const mergedSymbolRecords = [
            ...existingRegistry.symbols.filter((symbol) => !replacedPaths.has(symbol.file)),
            ...rebuiltSymbolRecords,
        ];

        {
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
            const inheritedProviderCoverage: readonly SemanticProviderCoverage[] = existingRelationshipState
                ? existingRelationshipState.providerCoverage
                : ('manifest' in existingRelationships
                    ? existingRelationships.manifest.providerCoverage
                    : []);
            const providerCoverageByKey = new Map<string, SemanticProviderCoverage>(
                inheritedProviderCoverage.map((coverage) => [providerCoverageKey(coverage), coverage]),
            );
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
                    const auxiliaryFiles = await this.collectSemanticAuxiliariesForLanguage(
                        codebasePath,
                        lang,
                        semanticRegistry,
                        observedFileHashes,
                    );
                    const descriptor = semanticRegistry.getDescriptor(lang);
                    if (!descriptor) {
                        throw new Error(`Semantic provider metadata is unavailable for '${lang}'.`);
                    }
                    try {
                        const evidence = await this.ports.semanticAnalyzer.analyze({
                            language: lang,
                            sourceFiles,
                            auxiliaryFiles,
                        });
                        semanticEvidenceByLanguage.set(lang, evidence);
                        const coverage = evidence.coverage ?? {
                            language: lang,
                            providerId: descriptor.providerId,
                            providerVersion: descriptor.providerVersion,
                            environmentConfigId: descriptor.environmentConfigId,
                            status: 'complete' as const,
                            sourceFileCount: sourceFiles.length,
                            analyzedSourceFileCount: sourceFiles.length,
                        };
                        providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                    } catch (error) {
                        const coverage = unavailableProviderCoverage({
                            language: lang,
                            providerId: descriptor.providerId,
                            providerVersion: descriptor.providerVersion,
                            environmentConfigId: descriptor.environmentConfigId,
                            sourceFileCount: sourceFiles.length,
                            error,
                        });
                        providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                        semanticEvidenceByLanguage.set(lang, {
                            language: lang,
                            occurrencesByFile: new Map(),
                            coverage,
                        });
                        console.warn(
                            `[Context] Optional semantic provider '${coverage.providerId}' failed for '${lang}' during delta rebuild; `
                            + `continuing with degraded relationship coverage: ${coverage.failureMessage}`,
                        );
                    }
                }
            }

            const resolutionEvidenceByLanguage = new Map<string, ResolutionProjectEvidence>();
            if (this.ports.resolutionAnalyzer) {
                for (const language of new Set(mergedManifestFiles.map((file) => file.language))) {
                    if (!this.ports.resolutionAnalyzer.supportsLanguage(language)) continue;
                    const languageFiles = mergedManifestFiles
                        .filter((file) => file.language === language)
                        .map((file) => file.path);
                    try {
                        const evidence = await this.ports.resolutionAnalyzer.analyze({
                            rootPath: this.ports.canonicalizeCodebasePath(codebasePath),
                            language,
                            registry,
                            previousRegistry: existingRegistry,
                            changedFiles: replacedPaths,
                        });
                        resolutionEvidenceByLanguage.set(language, evidence);
                        const coverage = evidence.coverage ?? {
                            language,
                            providerId: evidence.providerId,
                            providerVersion: evidence.providerVersion,
                            environmentConfigId: evidence.environmentConfigId,
                            status: 'complete' as const,
                            sourceFileCount: languageFiles.length,
                            analyzedSourceFileCount: languageFiles.length,
                        };
                        providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                    } catch (error) {
                        let metadata: Awaited<ReturnType<NonNullable<ResolutionProjectAnalyzer['getProviderMetadata']>>>;
                        try {
                            metadata = await this.ports.resolutionAnalyzer.getProviderMetadata?.(language);
                        } catch {
                            metadata = undefined;
                        }
                        if (!metadata) throw error;
                        const coverage = unavailableProviderCoverage({
                            language,
                            providerId: metadata.providerId,
                            providerVersion: metadata.providerVersion,
                            ...(metadata.environmentConfigId
                                ? { environmentConfigId: metadata.environmentConfigId }
                                : {}),
                            sourceFileCount: languageFiles.length,
                            error,
                        });
                        providerCoverageByKey.set(providerCoverageKey(coverage), coverage);
                        resolutionEvidenceByLanguage.set(language, {
                            language,
                            providerId: coverage.providerId,
                            providerVersion: coverage.providerVersion,
                            environmentConfigId: coverage.environmentConfigId ?? `unavailable:${coverage.providerId}`,
                            claimsByFile: new Map(),
                            affectedSourceFiles: new Set(languageFiles),
                            coverage,
                        });
                        console.warn(
                            `[Context] Optional resolution provider '${coverage.providerId}' failed for '${language}' during delta rebuild; `
                            + `continuing with degraded relationship coverage: ${coverage.failureMessage}`,
                        );
                    }
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
                    resolutionEvidenceByLanguage,
                }),
            );
            assertMutationCurrent?.();
            const candidate = await measurePhase(
                'publication_sidecar_stage',
                () => stagePublicationNavigation({
                    publicationId,
                    navigationRoot,
                    registry,
                    records: relationshipDelta.records,
                    analysisByFile: retainedAnalysisByFile,
                    providerCoverage: [...providerCoverageByKey.values()],
                    deltaReuse: {
                        basePublicationId: sourcePublicationId,
                        baseNavigationRoot: sourceNavigationRoot,
                        symbolFilesToRewrite: [...replacedPaths],
                        relationshipFilesToRewrite: relationshipDelta.affectedFiles,
                    },
                }),
            );
            console.log(
                `[Context] 🧭 Staged Publication '${publicationId}' navigation delta affecting `
                + `${relationshipDelta.affectedFiles.length} relationship owner(s); `
                + `shared ${candidate.physical.sharedFiles} file(s) and wrote `
                + `${candidate.physical.physicallyWrittenBytes} physical byte(s).`,
            );
            return {
                candidate,
                state: {
                    canonicalRoot: this.ports.canonicalizeCodebasePath(codebasePath),
                    publicationId,
                    navigationRoot,
                    symbolRegistryManifestHash: candidate.manifestHash,
                    relationshipManifestHash: candidate.relationshipManifestHash,
                    registry,
                    records: relationshipDelta.records,
                    analysisByFile: retainedAnalysisByFile,
                    providerCoverage: [...providerCoverageByKey.values()],
                },
            };
        }

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

    async resolveIndexPolicyForCodebase(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ObservedResolvedIndexPolicy> {
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        this.ports.indexPolicyRuntimeService.loadCurrentPublicationPolicy(canonicalRoot);
        return this.ports.resolveIndexPolicyFromCurrentInputs(canonicalRoot, update, true, true);
    }

    resolveReusableNavigationDeltaState(
        canonicalRoot: string,
        sourcePublicationId: string,
        navigationRoot: string,
    ): CachedNavigationDeltaState | undefined {
        const cached = this.navigationDeltaState;
        const currentObservation = cached
            && cached.canonicalRoot === canonicalRoot
            && cached.publicationId === sourcePublicationId
            && cached.navigationRoot === navigationRoot
            ? this.ports.resolveNavigationObservationToken(
                canonicalRoot,
                sourcePublicationId,
            )
            : null;
        if (
            cached
            && cached.canonicalRoot === canonicalRoot
            && cached.publicationId === sourcePublicationId
            && cached.navigationRoot === navigationRoot
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
        publicationSourceControls: ReadonlySet<string>,
        expectedTotalChunks: number,
        navigationCandidate: StagedPublicationNavigation,
        preparedObservedTotalChunks?: number | null,
    ): Promise<void> {
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        const semanticRegistry = this.ports.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
        const searchablePreparedFileHashes = new Map(
            [...preparedFileHashes.entries()].filter(([filePath]) => (
                !semanticRegistry.isAuxiliaryPath(filePath)
                && !publicationSourceControls.has(filePath)
            )),
        );
        const preparedFiles = [...searchablePreparedFileHashes].map(([filePath, hash]) => ({ path: filePath, hash }));
        if (
            navigationCandidate.normalizedRootPath !== canonicalRoot
            || navigationCandidate.sourceFileCount !== searchablePreparedFileHashes.size
            || navigationCandidate.sourceFilesDigest !== computeNavigationSourceFilesDigest(preparedFiles)
        ) {
            throw new Error(
                'Cannot publish incremental completion proof: staged Publication navigation does not match the prepared synchronizer checkpoint.',
            );
        }
        const registryState = await readSymbolRegistrySidecar({
            normalizedRootPath: canonicalRoot,
            publicationId: navigationCandidate.publicationId,
            navigationRoot: navigationCandidate.navigationRoot,
        });
        if (
            registryState.status !== 'ok'
            || registryState.manifestHash !== navigationCandidate.manifestHash
        ) {
            throw new Error('Cannot publish incremental completion proof: staged Publication symbol JSON is incompatible.');
        }
        const relationshipState = await readRelationshipSidecar({
            normalizedRootPath: canonicalRoot,
            publicationId: navigationCandidate.publicationId,
            navigationRoot: navigationCandidate.navigationRoot,
            expectedSymbolRegistryManifestHash: registryState.manifestHash,
        });
        if (
            relationshipState.status !== 'ok'
            || relationshipState.manifestHash !== navigationCandidate.relationshipManifestHash
        ) {
            throw new Error('Cannot publish incremental completion proof: staged Publication relationship JSON is incompatible.');
        }

        const manifestHashes = new Map(
            registryState.registry.manifest.files.map((file) => [file.path, file.hash]),
        );
        if (manifestHashes.size !== searchablePreparedFileHashes.size) {
            throw new Error(
                `Cannot publish incremental completion proof: synchronizer tracks ${searchablePreparedFileHashes.size} searchable files but navigation describes ${manifestHashes.size}.`,
            );
        }
        for (const [relativePath, expectedHash] of searchablePreparedFileHashes) {
            if (manifestHashes.get(relativePath) !== expectedHash) {
                throw new Error(
                    `Cannot publish incremental completion proof: source hash for '${relativePath}' does not match the prepared synchronizer checkpoint.`,
                );
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
