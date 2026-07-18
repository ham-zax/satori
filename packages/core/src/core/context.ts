import {
    Embedding,
    EmbeddingVector,
    OpenAIEmbedding,
    resolveValidatedEmbeddingIdentity,
    type EmbeddingIdentity,
    type EmbeddingOperationMetricsSnapshot,
} from '../embedding';
import {
    VectorDatabase,
    VectorControlRecord,
    IndexedVectorDocument,
    SearchProjections,
    VectorCandidate,
    VectorFilter,
    RetrievalMode,
    ScorePolicy,
    IndexCompletionFingerprint,
    IndexCompletionMarkerDocument,
    INDEX_COMPLETION_MARKER_DOC_ID,
    deleteCollectionWithVerification,
    type VectorWriteMetricsSnapshot,
    type VectorStoreProviderIdentity,
} from '../vectordb';
import { validateVectorFilter } from '../vectordb/filters';
import {
    SemanticSearchRequest,
    SemanticSearchResult,
    type SemanticSearchCandidateTrace,
    type SemanticSearchCandidateTraceOccurrence,
    type SemanticSearchCandidateTraceStage,
    type SemanticSearchCandidateTraceStageName,
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
    isIndexableFileByPolicy,
    isIndexableFileObservationByPolicy,
    normalizeSupportedExtensions,
} from '../config/index-policy';
import {
    loadSatoriRepoConfig,
    SATORI_REPO_CONFIG_FILENAME,
    SatoriRepoConfigAuthorityError,
    SatoriRepoConfig,
} from '../config/repo-config';
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
    computeNavigationGenerationSealHash,
    parseNavigationGenerationSeal,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    RetiredNavigationPointerError,
    UnsupportedNavigationPointerError,
    resolveCurrentNavigationGeneration,
    resolveNavigationGeneration,
    resolveNavigationSidecarRoot,
    resolveOwnerSymbolForChunk,
    discardNavigationSidecarGeneration,
    publishNavigationSidecarGeneration,
    pruneNavigationSidecarGenerations,
    stageNavigationSidecarGeneration,
    verifyNavigationGenerationSealArtifacts,
} from '../symbols';
import type {
    CurrentNavigationGeneration,
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
    type LanguageAnalysisResult,
    type LanguageAnalysisPort,
} from '../language-analysis';
import {
    canonicalizeRepositoryRelativePath,
    type RepositoryRelativePath,
} from '../paths/repository-path';
import {
    buildRelationshipDelta,
    buildRelationshipsForRegistry,
    type RelationshipAnalysisEvidence,
} from '../relationships';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import ignore from 'ignore';
import {
    FileSynchronizer,
    type SourceFreshnessCheckpointEvidence,
} from '../sync/synchronizer';
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
import {
    buildCanonicalIndexPolicyDocument,
    indexFingerprintsEqual,
    inspectCompletionMarker,
    inspectIndexPolicyDocument,
    type CanonicalPolicyNavigationBinding,
    type CanonicalPublicationBinding,
} from './persisted-index-authority';
import {
    buildSearchProjections,
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
} from './search-projections';
import { compareContractStrings } from '../utils/compare-contract-strings';
import {
    fuseVectorCandidatesWithRrf,
    orderVectorCandidateArm,
    VECTOR_CANDIDATE_RRF_K_V1,
} from './vector-candidate-fusion';

interface ProjectedChunkEntry {
    readonly chunk: CodeChunk;
    readonly relativePath: RepositoryRelativePath;
    readonly fileChunkIndex: number;
    readonly projections: SearchProjections;
}

interface PendingIndexedChunk extends ProjectedChunkEntry {
    readonly codebasePath: string;
}

interface AnalyzedIndexedFile {
    readonly relativePath: RepositoryRelativePath;
    readonly source: string;
    /** Exact source-byte identity used to prove full-index coverage. */
    readonly sourceHash: string;
    /** Decoded UTF-8 identity retained by navigation manifest compatibility. */
    readonly contentHash: string;
    readonly language: string;
    readonly chunks: CodeChunk[];
    readonly extractedSymbols: LanguageAnalysisResult['symbols'];
    readonly moduleBindings: LanguageAnalysisResult['moduleBindings'];
    readonly callSites: LanguageAnalysisResult['callSites'];
}

interface AnalyzedFileSymbolFacts {
    readonly symbolRecords: SymbolRecord[];
    readonly manifestFile: SymbolRegistryManifestFile;
    readonly relationshipEvidence: RelationshipAnalysisEvidence;
}

const DEFAULT_EMBEDDING_BATCH_SIZE = 100;
const MAX_EMBEDDING_BATCH_SIZE = 1000;
const INDEX_POLICY_MALFORMED_LOCK_STALE_MS = 30_000;
const MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE = 160;

function semanticSearchTraceOwnerId(candidate: VectorCandidate): string {
    const ownerSymbolInstanceId = candidate.document.metadata.ownerSymbolInstanceId;
    return typeof ownerSymbolInstanceId === 'string' && ownerSymbolInstanceId.length > 0
        ? JSON.stringify(['symbol', candidate.document.relativePath, ownerSymbolInstanceId])
        : JSON.stringify(['file', candidate.document.relativePath]);
}

function buildSemanticSearchTraceStage(
    stage: SemanticSearchCandidateTraceStageName,
    candidates: readonly VectorCandidate[],
    maxEntries: number,
): SemanticSearchCandidateTraceStage {
    const ordered = stage === 'raw_dense'
        || stage === 'raw_lexical'
        || stage === 'raw_lexical_fallback'
        ? orderVectorCandidateArm(candidates)
        : [...candidates];
    const occurrences: SemanticSearchCandidateTraceOccurrence[] = ordered
        .slice(0, maxEntries)
        .map((candidate, index) => ({
            candidateId: candidate.document.id,
            ownerId: semanticSearchTraceOwnerId(candidate),
            evidenceOccurrenceId: JSON.stringify([candidate.document.id, stage, index + 1]),
            relativePath: candidate.document.relativePath,
            startLine: candidate.document.startLine,
            endLine: candidate.document.endLine,
            language: typeof candidate.document.metadata.language === 'string'
                ? candidate.document.metadata.language
                : 'unknown',
            rank: index + 1,
            score: candidate.score,
        }));
    return {
        stage,
        totalOccurrences: ordered.length,
        uniqueCandidates: new Set(ordered.map((candidate) => candidate.document.id)).size,
        omittedOccurrences: Math.max(0, ordered.length - occurrences.length),
        candidates: occurrences,
    };
}

function buildSemanticSearchCandidateTrace(input: {
    dense?: readonly VectorCandidate[];
    lexical?: readonly VectorCandidate[];
    lexicalFallback?: readonly VectorCandidate[];
    result: readonly VectorCandidate[];
    hybrid: boolean;
    maxEntries: number;
    productCandidateLimit: number;
    queryEmbeddingSha256: string | null;
    lexicalRequests: SemanticSearchCandidateTrace['lexicalRequests'];
}): SemanticSearchCandidateTrace {
    const stages: SemanticSearchCandidateTraceStage[] = [];
    if (input.dense) {
        stages.push(buildSemanticSearchTraceStage('raw_dense', input.dense, input.maxEntries));
    }
    if (input.lexical) {
        stages.push(buildSemanticSearchTraceStage('raw_lexical', input.lexical, input.maxEntries));
    }
    if (input.lexicalFallback) {
        stages.push(buildSemanticSearchTraceStage(
            'raw_lexical_fallback',
            input.lexicalFallback,
            input.maxEntries,
        ));
    }
    stages.push(buildSemanticSearchTraceStage(
        input.hybrid ? 'core_fusion' : 'core_result',
        input.result,
        input.maxEntries,
    ));

    const resultIds = new Set(input.result.map((candidate) => candidate.document.id));
    const removedIds = [...new Set([
        ...(input.dense ?? []).map((candidate) => candidate.document.id),
        ...(input.lexical ?? []).map((candidate) => candidate.document.id),
    ])]
        .filter((candidateId) => !resultIds.has(candidateId))
        .sort(compareContractStrings);
    const removals = removedIds.slice(0, input.maxEntries).map((candidateId) => ({
        candidateId,
        afterStage: 'core_fusion' as const,
        reason: 'core_fusion_limit' as const,
    }));
    return {
        schemaVersion: 'semantic_search_candidate_trace_v1',
        maxEntriesPerStage: input.maxEntries,
        productCandidateLimit: input.productCandidateLimit,
        queryEmbeddingSha256: input.queryEmbeddingSha256,
        lexicalRequests: input.lexicalRequests,
        stages,
        removals,
        omittedRemovals: Math.max(0, removedIds.length - removals.length),
    };
}

function hashSemanticSearchQueryEmbedding(vector: readonly number[]): string {
    if (!vector.every(Number.isFinite)) {
        throw new Error('Query embedding contains a non-finite value.');
    }
    return crypto.createHash('sha256').update(JSON.stringify(vector), 'utf8').digest('hex');
}

function hashSemanticSearchLexicalQuery(query: string): string {
    return crypto.createHash('sha256').update(query, 'utf8').digest('hex');
}

function semanticSearchLexicalMatchMode(
    vectorDatabase: VectorDatabase,
): SemanticSearchCandidateTrace['lexicalRequests'][number]['matchMode'] {
    const backend = vectorDatabase.getBackendInfo?.();
    if (!backend) return 'unspecified';
    return backend.provider === 'lancedb' ? 'all_terms' : 'provider_sparse';
}

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

function resolveEmbeddingBatchSize(
    rawValue: string | undefined,
    preferredSize: number = DEFAULT_EMBEDDING_BATCH_SIZE,
    hardMaxSize: number = MAX_EMBEDDING_BATCH_SIZE,
): number {
    const boundedPreferredSize = Math.min(preferredSize, hardMaxSize, MAX_EMBEDDING_BATCH_SIZE);
    if (!rawValue) return boundedPreferredSize;
    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return boundedPreferredSize;
    return Math.min(parsed, hardMaxSize, MAX_EMBEDDING_BATCH_SIZE);
}

function estimateEmbeddingTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

type IndexingPipelineMetrics = {
    analysisMs: number;
    embeddedInputBytes: number;
    logicalEmbeddingRequests: number;
    logicalEmbeddingDurationMs: number;
    logicalVectorWriteRequests: number;
    logicalVectorWriteDurationMs: number;
};

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

export type DurableAuthorityMutationOwner = {
    ownerId: string;
    generation: number;
    operationId: string;
};

export type DurableAuthorityRecoveryPublisher = (
    canonicalRoot: string,
    mutationOwner: DurableAuthorityMutationOwner | undefined,
    publish: () => void,
) => boolean;

export type MutationGenerationObservation = Readonly<{
    generation: number;
    mutationActive: boolean;
}>;

export type MutationGenerationObserver = (
    canonicalRoot: string,
) => MutationGenerationObservation;

declare const generationProofCoordinatorBrand: unique symbol;
export type GenerationProofCoordinator = {
    readonly [generationProofCoordinatorBrand]: true;
};

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

type IndexPolicyBinding = {
    collectionName: string;
    navigation: CanonicalPolicyNavigationBinding;
    publication?: CanonicalPublicationBinding;
};

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

export interface ProvenVectorGenerationReceipt {
    readonly collectionName: string;
    readonly marker: IndexCompletionMarkerDocument;
    readonly policy: ResolvedIndexPolicy;
    readonly policyDocumentDigest: string;
    readonly exactPayloadCount: number;
    readonly observations: {
        readonly profileFileToken: string | null;
        readonly policyFileToken: string;
    };
}

export interface ProvenGenerationReceipt extends Omit<ProvenVectorGenerationReceipt, 'observations'> {
    readonly navigation: CurrentNavigationGeneration;
    readonly observations: ProvenVectorGenerationReceipt['observations'] & {
        readonly navigationToken: string;
    };
}

export type ProvenSourceFreshnessCheckpointEvidence =
    | (Extract<SourceFreshnessCheckpointEvidence, { status: 'valid' }> & {
        readonly generationReceipt?: ProvenGenerationReceipt;
    })
    | Exclude<SourceFreshnessCheckpointEvidence, { status: 'valid' }>;

export type NavigationGenerationProof =
    | { status: 'valid'; generation: CurrentNavigationGeneration; observationToken: string }
    | { status: 'not_bound' | 'missing' | 'incompatible' | 'corrupt' | 'requires_reindex' | 'unsupported' };

export type IndexPolicyPublicationReceipt =
    | {
        status: 'committed';
        operation: 'publish';
        canonicalRoot: string;
        documentDigest: string;
        policyHash: string;
        collectionName: string;
        navigation: CanonicalPolicyNavigationBinding;
        publication?: CanonicalPublicationBinding;
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

export class AtomicIncrementalPublicationUnsupportedError extends Error {
    constructor() {
        super('The active vector backend cannot stage an atomic incremental publication; a full rebuild is required.');
        this.name = 'AtomicIncrementalPublicationUnsupportedError';
    }
}

class IndexPolicyAuthorityError extends Error {
    constructor(message: string, readonly authorityCause: unknown) {
        super(message);
        this.name = 'IndexPolicyAuthorityError';
    }
}

class IndexFormatRequiresReindexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IndexFormatRequiresReindexError';
    }
}

class UnsupportedIndexAuthorityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedIndexAuthorityError';
    }
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

export type DurableIndexAuthorityArtifact = {
    content: string;
    digest: string;
};

export type DurableIndexAuthoritySnapshot = {
    canonicalRoot: string;
    policyDocument: DurableIndexAuthorityArtifact | null;
    navigationPointer: DurableIndexAuthorityArtifact | null;
};

type DurableIndexAuthorityRestoreResult =
    | { status: 'restored_current' }
    | { status: 'restored_requires_reindex' }
    | { status: 'restored_unsupported_authority' };

type DurableAuthorityRestoreEntry = {
    targetPath: string;
    temporaryPath: string;
    displacedPath: string;
    content: string | null;
    digest: string | null;
    expectedDigest: string | null;
};

type DurableAuthorityRestoreTransaction = {
    schemaVersion: 1;
    id: string;
    canonicalRoot: string;
    phase: 'prepared' | 'swapping' | 'committed';
    nextEntry: number;
    mutationOwner?: { ownerId: string; generation: number; operationId: string };
    entries: DurableAuthorityRestoreEntry[];
};

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
    publicationAuthority?: DurableAuthorityMutationOwner;
    sourceGenerationReceipt?: ProvenGenerationReceipt;
};

type MutationGuardOptions = {
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
    deferFullIndexPublication?: boolean;
    indexPolicy?: ResolvedIndexPolicy;
    preparedCollectionReceipt?: PreparedIndexCollectionReceipt;
    preparedCollectionBinding?: PreparedIndexCollectionBinding;
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

export type PreparedIndexCollectionBinding = Readonly<{
    generation: number;
    operationId: string;
}>;

export type PreparedIndexCollectionReceipt = Readonly<PreparedIndexCollectionBinding & {
    canonicalRoot: string;
    collectionName: string;
}>;

export type IndexCodebaseResult = {
    indexedFiles: number;
    totalChunks: number;
    status: 'completed' | 'limit_reached';
    /** Exact SHA-256 identities of source bytes consumed by this full index. */
    indexedFileHashes: ReadonlyMap<string, string>;
    navigationCandidate?: StagedNavigationSidecarGeneration;
};

function chunksWithTrustedRelativePath(
    chunks: readonly CodeChunk[],
    relativePath: RepositoryRelativePath,
): CodeChunk[] {
    return chunks.map((chunk) => ({
        ...chunk,
        metadata: { ...chunk.metadata, filePath: relativePath },
    }));
}

function chunksWithResolvedOwners(
    chunks: readonly CodeChunk[],
    symbols: SymbolRecord[],
): CodeChunk[] {
    return chunks.map((chunk) => {
        const owner = resolveOwnerSymbolForChunk({ chunk, symbols });
        return {
            ...chunk,
            metadata: {
                ...chunk.metadata,
                ownerSymbolKey: owner.symbolKey,
                ownerSymbolInstanceId: owner.symbolInstanceId,
                symbolKind: owner.kind,
            },
        };
    });
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

type PublicationReadGate = {
    activeReaders: number;
    retentionPending: boolean;
    readersDrained?: Promise<void>;
    resolveReadersDrained?: () => void;
    retentionFinished?: Promise<void>;
    resolveRetentionFinished?: () => void;
};

type CachedGenerationProof = {
    identity: string;
    vectorReceipt: ProvenVectorGenerationReceipt;
    generationReceipt?: ProvenGenerationReceipt;
    navigationArtifactsValidated: boolean;
    source: 'activation' | 'exact';
};

type VectorGenerationProofResult = {
    receipt: ProvenVectorGenerationReceipt | null;
    exactPayloadRecounts: 0 | 1;
    source: 'activation' | 'exact' | 'joined' | 'reused';
};

type GenerationProofCoordinatorState = {
    readonly proofs: Map<string, CachedGenerationProof>;
    readonly proofFlights: Map<string, Promise<CachedGenerationProof | null>>;
    readonly navigationFlights: Map<string, Promise<NavigationGenerationProof>>;
    readonly preparedReceipts: WeakMap<ProvenGenerationReceipt, string>;
};

const generationProofCoordinatorStates = new WeakMap<
    GenerationProofCoordinator,
    GenerationProofCoordinatorState
>();

export function createGenerationProofCoordinator(): GenerationProofCoordinator {
    const coordinator = Object.freeze({}) as GenerationProofCoordinator;
    generationProofCoordinatorStates.set(coordinator, {
        proofs: new Map(),
        proofFlights: new Map(),
        navigationFlights: new Map(),
        preparedReceipts: new WeakMap(),
    });
    return coordinator;
}

export class Context {
    private embedding: Embedding;
    private embeddingIdentity: Readonly<EmbeddingIdentity>;
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
    private policyDocumentDigestsByCodebase: Map<string, string>;
    private policyRuntimeCompatibilityByCodebase: Map<string, boolean>;
    private publishedPolicyBindingsByCodebase: Map<string, IndexPolicyBinding & { policyHash: string }>;
    private publishedResolvedPoliciesByCodebase: Map<string, ResolvedIndexPolicy>;
    private readonly indexPolicyStateRoot: string;
    private ignoreStateByCollection: Map<string, CodebaseIgnoreState>;
    private synchronizers = new Map<string, FileSynchronizer>();
    private synchronizerMutationTargets = new Map<string, string>();
    private reindexByChangeQueues = new Map<string, Promise<void>>();
    private publicationRetentionQueues = new Map<string, Promise<void>>();
    private publicationReadGates = new Map<string, PublicationReadGate>();
    private readonly generationProofs: Map<string, CachedGenerationProof>;
    private readonly generationProofFlights: Map<string, Promise<CachedGenerationProof | null>>;
    private readonly navigationProofFlights: Map<string, Promise<NavigationGenerationProof>>;
    private readonly preparedGenerationReceipts: WeakMap<ProvenGenerationReceipt, string>;
    private writeCollectionOverrides = new Map<string, string>();
    private preparedIndexCollectionReceipts = new WeakSet<PreparedIndexCollectionReceipt>();
    private symbolRegistryStateRoot?: string;
    private readonly mutationGenerationObserver?: MutationGenerationObserver;
    private vectorStoreProvider: VectorStoreProviderIdentity;

    constructor(config: ContextConfig = {}) {
        const proofCoordinator = config.generationProofCoordinator ?? createGenerationProofCoordinator();
        const proofCoordinatorState = generationProofCoordinatorStates.get(proofCoordinator);
        if (!proofCoordinatorState) {
            throw new Error('Generation proof coordinator must be created by createGenerationProofCoordinator().');
        }
        this.generationProofs = proofCoordinatorState.proofs;
        this.generationProofFlights = proofCoordinatorState.proofFlights;
        this.navigationProofFlights = proofCoordinatorState.navigationFlights;
        this.preparedGenerationReceipts = proofCoordinatorState.preparedReceipts;
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
        this.mutationGenerationObserver = config.mutationGenerationObserver;

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
        this.policyDocumentDigestsByCodebase = new Map();
        this.policyRuntimeCompatibilityByCodebase = new Map();
        this.publishedPolicyBindingsByCodebase = new Map();
        this.publishedResolvedPoliciesByCodebase = new Map();
        this.indexPolicyStateRoot = config.indexPolicyStateRoot
            ?? path.join(os.homedir(), '.satori', 'index-policy');
        this.ignoreStateByCollection = new Map();
        this.symbolRegistryStateRoot = config.symbolRegistryStateRoot;
        this.recoverDurableIndexAuthorityTransactions(config.durableAuthorityRecoveryPublisher);

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
     * Recreate synchronizer for a codebase using currently active ignore patterns.
     * This is used when ignore rules change and we need deterministic reconciliation.
     */
    async recreateSynchronizerForCodebase(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        options: { requireAuthorityCheckpoint?: boolean } = {},
    ): Promise<void> {
        this.loadIndexProfileForCodebase(codebasePath);
        const collectionName = this.resolveCollectionName(codebasePath);
        const authorityBefore = options.requireAuthorityCheckpoint
            ? await this.proveIndexedGeneration(codebasePath)
            : null;
        if (options.requireAuthorityCheckpoint && !authorityBefore) {
            throw new Error(`Cannot recreate source freshness state for '${codebasePath}': no authoritative indexed generation is available.`);
        }
        const synchronizer = new FileSynchronizer(
            codebasePath,
            this.getActiveIgnorePatterns(codebasePath),
            this.getIndexedExtensionsForCodebase(codebasePath),
            authorityBefore ? {
                checkpointIdentity: authorityBefore.collectionName,
                checkpointAuthority: {
                    collectionName: authorityBefore.collectionName,
                    markerRunId: authorityBefore.marker.runId,
                    indexPolicyHash: authorityBefore.marker.indexPolicyHash,
                },
            } : {},
        );
        await synchronizer.initialize(assertMutationCurrent, publishMutation, {
            requireExistingCheckpoint: authorityBefore !== null,
        });
        if (authorityBefore) {
            assertMutationCurrent?.();
            const authorityAfter = await this.proveIndexedGeneration(codebasePath);
            if (
                !authorityAfter
                || authorityAfter.collectionName !== authorityBefore.collectionName
                || authorityAfter.policyDocumentDigest !== authorityBefore.policyDocumentDigest
                || !this.indexCompletionMarkersEqual(authorityAfter.marker, authorityBefore.marker)
            ) {
                throw new Error(`Cannot register source freshness state for '${codebasePath}': indexed authority changed while its checkpoint was loading.`);
            }
        }
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

    async inspectSourceFreshnessCheckpoint(
        codebasePath: string,
        checkpointIdentity?: string,
        requestBoundReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<ProvenSourceFreshnessCheckpointEvidence> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const receipt = requestBoundReceipt
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
        const generationReceipt = await this.resolveGenerationReceipt(
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
        const preparedReceipt = this.cloneProvenGenerationReceipt(generationReceipt);
        const preparedIdentity = await this.resolveGenerationProofIdentity(canonicalRoot);
        if (!preparedIdentity) {
            // Backends without a cheap immutable publication observation retain
            // the exact validation above, but cannot safely propagate its proof.
            return checkpoint;
        }
        this.preparedGenerationReceipts.set(preparedReceipt, preparedIdentity);
        return { ...checkpoint, generationReceipt: preparedReceipt };
    }

    public isPreparedVectorReceiptBoundToCurrentAuthority(
        canonicalRoot: string,
        receipt: ProvenVectorGenerationReceipt,
    ): boolean {
        const policy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const binding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        const policyDocumentDigest = this.policyDocumentDigestsByCodebase.get(canonicalRoot);
        if (!policy || !binding || !policyDocumentDigest) return false;

        return receipt.policy.canonicalRoot === canonicalRoot
            && receipt.marker.codebasePath === canonicalRoot
            && receipt.collectionName === binding.collectionName
            && receipt.policy.policyHash === policy.policyHash
            && receipt.policyDocumentDigest === policyDocumentDigest
            && receipt.marker.indexPolicyHash === policy.policyHash
            && receipt.exactPayloadCount === receipt.marker.totalChunks
            && receipt.observations.profileFileToken
                === this.resolveRepoConfigObservationToken(canonicalRoot)
            && receipt.observations.policyFileToken
                === this.resolveCustomIndexPolicyFileToken(canonicalRoot)
            && this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) === true
            && this.markerMatchesSealedAuthority(receipt.marker, policy, binding);
    }

    private async acceptPreparedSourceGenerationReceipt(
        canonicalRoot: string,
        receipt: ProvenGenerationReceipt,
    ): Promise<ProvenGenerationReceipt | null> {
        const preparedIdentity = this.preparedGenerationReceipts.get(receipt);
        if (!preparedIdentity) return null;
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        if (!this.isPreparedVectorReceiptBoundToCurrentAuthority(canonicalRoot, receipt)) return null;
        if (
            receipt.marker.navigation.status !== 'sealed'
            || receipt.navigation.generationId !== receipt.marker.navigation.generationId
            || receipt.navigation.navigationSealHash !== receipt.marker.navigation.sealHash
        ) return null;
        const currentIdentity = await this.resolveGenerationProofIdentity(canonicalRoot);
        if (currentIdentity !== preparedIdentity) return null;
        return this.cloneProvenGenerationReceipt(receipt);
    }

    getRegisteredSourceFreshnessCheckpointObservation(codebasePath: string): string | null {
        const synchronizer = this.synchronizers.get(this.resolveCollectionName(codebasePath));
        return synchronizer?.getOwnedSnapshotObservationToken() ?? null;
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

    private async resolveRepairCompletionMarkerForCollection(
        codebasePath: string,
        collectionName: string,
    ): Promise<RepairCompletionMarkerResolution> {
        const record = await this.vectorDatabase.getControl(collectionName, INDEX_COMPLETION_MARKER_DOC_ID);
        if (!record) {
            return { status: 'missing' };
        }
        const marker = this.parseCompletionControlRecord(codebasePath, record);
        if (marker) {
            return { status: 'matched', marker };
        }
        return { status: 'malformed' };
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
            relationshipVersion: RELATIONSHIP_BUILDER_VERSION,
            embeddingProjectionVersion: EMBEDDING_PROJECTION_VERSION,
            lexicalProjectionVersion: LEXICAL_PROJECTION_VERSION,
        };
    }

    public indexCompletionMarkersEqual(
        left: IndexCompletionMarkerDocument,
        right: IndexCompletionMarkerDocument,
    ): boolean {
        const navigationEqual = left.navigation.status === right.navigation.status
            && (left.navigation.status === 'not_bound'
                || (right.navigation.status === 'sealed'
                    && left.navigation.generationId === right.navigation.generationId
                    && left.navigation.symbolRegistryManifestHash === right.navigation.symbolRegistryManifestHash
                    && left.navigation.relationshipManifestHash === right.navigation.relationshipManifestHash
                    && left.navigation.sealHash === right.navigation.sealHash));
        return left.codebasePath === right.codebasePath
            && left.runId === right.runId
            && left.indexedFiles === right.indexedFiles
            && left.totalChunks === right.totalChunks
            && left.completedAt === right.completedAt
            && left.indexPolicyHash === right.indexPolicyHash
            && left.indexStatus === right.indexStatus
            && navigationEqual
            && indexFingerprintsEqual(left.fingerprint, right.fingerprint)
            && indexFingerprintsEqual(right.fingerprint, left.fingerprint);
    }

    private markerMatchesSealedAuthority(
        marker: IndexCompletionMarkerDocument,
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyBinding & { policyHash: string },
    ): boolean {
        const publicationMatches = !binding.publication || (
            binding.publication.sourceCheckpoint.collectionName === binding.collectionName
            && binding.publication.sourceCheckpoint.markerRunId === marker.runId
            && binding.publication.sourceCheckpoint.indexPolicyHash === marker.indexPolicyHash
            && marker.navigation.status === 'sealed'
            && binding.publication.graph.manifestHash === marker.navigation.relationshipManifestHash
        );
        return publicationMatches
            && indexFingerprintsEqual(marker.fingerprint, this.buildIndexCompletionFingerprint())
            && marker.indexPolicyHash === policy.policyHash
            && binding.policyHash === marker.indexPolicyHash
            && policyNavigationBindingsEqual(
                binding.navigation,
                policyNavigationBindingFromMarker(marker.navigation),
            );
    }

    private cloneIndexCompletionMarker(marker: IndexCompletionMarkerDocument): IndexCompletionMarkerDocument {
        return {
            ...marker,
            fingerprint: { ...marker.fingerprint },
            navigation: { ...marker.navigation },
        };
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
        return this.cloneIndexCompletionMarker(marker);
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
            if (!indexFingerprintsEqual(marker.fingerprint, runtimeFingerprint)) {
                continue;
            }
            if (marker.indexPolicyHash !== activePolicyHash) {
                continue;
            }
            const markerNavigation = marker.navigation.status === 'sealed'
                ? marker.navigation
                : null;
            if (
                policyBinding.policyHash !== marker.indexPolicyHash
                || policyBinding.collectionName !== collectionName
                || !policyNavigationBindingsEqual(
                    policyBinding.navigation,
                    policyNavigationBindingFromMarker(marker.navigation),
                )
            ) {
                continue;
            }
            if (!(await this.collectionHasIndexedPayload(collectionName, marker))) {
                continue;
            }
            if (markerNavigation) {
                const currentNavigation = await (policyBinding.publication
                    ? resolveNavigationGeneration(
                        this.symbolRegistryStateRoot,
                        this.canonicalizeCodebasePath(codebasePath),
                        markerNavigation.generationId,
                    )
                    : resolveCurrentNavigationGeneration(
                        this.symbolRegistryStateRoot,
                        this.canonicalizeCodebasePath(codebasePath),
                    )).catch(() => null);
                if (
                    !currentNavigation
                    || currentNavigation.generationId !== markerNavigation.generationId
                    || currentNavigation.symbolRegistryManifestHash !== markerNavigation.symbolRegistryManifestHash
                    || currentNavigation.relationshipManifestHash !== markerNavigation.relationshipManifestHash
                    || currentNavigation.navigationSealHash !== markerNavigation.sealHash
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
        const collectionName = this.getWriteCollectionName(canonicalRoot);
        const stagedPrefix = `${this.resolveCollectionName(canonicalRoot)}__gen_`;
        if (!collectionName.startsWith(stagedPrefix)) {
            throw new Error(`Prepared index collection '${collectionName}' is not a staged generation for '${canonicalRoot}'.`);
        }

        assertMutationCurrent?.();
        await this.prepareCollection(canonicalRoot, true, assertMutationCurrent);
        assertMutationCurrent?.();

        const receipt = Object.freeze({
            canonicalRoot,
            collectionName,
            generation: binding.generation,
            operationId: binding.operationId.trim(),
        });
        this.preparedIndexCollectionReceipts.add(receipt);
        return receipt;
    }

    public discardPreparedIndexCollection(receipt: PreparedIndexCollectionReceipt): void {
        this.preparedIndexCollectionReceipts.delete(receipt);
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
        const profileFileToken = this.resolveRepoConfigObservationToken(canonicalRoot);
        const policyFileToken = this.resolveCustomIndexPolicyFileToken(canonicalRoot);
        const cachedPolicyFileToken = this.policyFileTokensByCodebase.get(canonicalRoot);
        const policyDocumentDigest = this.policyDocumentDigestsByCodebase.get(canonicalRoot);
        const policy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const binding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        if (
            !policyFileToken
            || cachedPolicyFileToken !== policyFileToken
            || !policyDocumentDigest
            || !policy
            || !binding
            || policy.canonicalRoot !== canonicalRoot
            || policy.policyHash !== binding.policyHash
        ) {
            return null;
        }
        const navigationObservation = binding.navigation.status === 'sealed'
            ? this.resolveNavigationObservation(
                canonicalRoot,
                binding.navigation.generationId,
                binding.publication === undefined,
            )
            : { status: 'not_bound' as const };
        return {
            vector: JSON.stringify({
            canonicalRoot,
            profileFileToken,
            policyFileToken,
            policyDocumentDigest,
            policyHash: policy.policyHash,
            collectionName: binding.collectionName,
            }),
            navigation: JSON.stringify({
                binding: binding.navigation,
                observation: navigationObservation,
            }),
        };
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
        const initialPolicyToken = this.resolveCustomIndexPolicyFileToken(canonicalRoot);
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

        if (priorReceipt && this.indexProfilesByCodebase.has(canonicalRoot)) {
            this.loadCustomIndexPolicy(canonicalRoot);
            this.recomputePublishedPolicyRuntimeCompatibility(canonicalRoot);
        } else {
            this.refreshRuntimePolicyAuthority(canonicalRoot);
        }
        const publishedPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const policyBinding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        const policyDocumentDigest = this.policyDocumentDigestsByCodebase.get(canonicalRoot);
        if (
            !publishedPolicy
            || !policyBinding
            || !policyDocumentDigest
            || this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
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
        if (!initialMarker || !this.markerMatchesSealedAuthority(
            initialMarker,
            publishedPolicy,
            policyBinding,
        )) {
            return null;
        }
        if (policyBinding.publication) {
            const checkpoint = await new FileSynchronizer(
                canonicalRoot,
                [],
                [],
                {
                    checkpointIdentity: policyBinding.collectionName,
                    checkpointAuthority: {
                        collectionName: policyBinding.collectionName,
                        markerRunId: initialMarker.runId,
                        indexPolicyHash: initialMarker.indexPolicyHash,
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
        const initialNavigation = initialMarker.navigation.status === 'sealed'
            ? initialMarker.navigation
            : null;
        if (requireNavigation && !initialNavigation) return null;

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

        const navigation = requireNavigation && initialNavigation
            ? await (policyBinding.publication
                ? resolveNavigationGeneration(
                    this.symbolRegistryStateRoot,
                    canonicalRoot,
                    initialNavigation.generationId,
                )
                : resolveCurrentNavigationGeneration(
                    this.symbolRegistryStateRoot,
                    canonicalRoot,
                )).catch(() => null)
            : null;
        if (
            requireNavigation
            && initialNavigation
            && (
                !navigation
                || navigation.generationId !== initialNavigation.generationId
                || navigation.symbolRegistryManifestHash !== initialNavigation.symbolRegistryManifestHash
                || navigation.relationshipManifestHash !== initialNavigation.relationshipManifestHash
                || navigation.navigationSealHash !== initialNavigation.sealHash
            )
        ) {
            return null;
        }
        if (requireNavigation && navigation) {
            const registryRead = await readSymbolRegistrySidecar({
                normalizedRootPath: canonicalRoot,
                stateRoot: this.symbolRegistryStateRoot,
                ...(policyBinding.publication ? { generationId: initialNavigation!.generationId } : {}),
            });
            if (
                registryRead.status !== 'ok'
                || registryRead.manifestHash !== navigation.symbolRegistryManifestHash
            ) return null;
            const relationshipRead = await readRelationshipSidecar({
                normalizedRootPath: canonicalRoot,
                expectedSymbolRegistryManifestHash: navigation.symbolRegistryManifestHash,
                stateRoot: this.symbolRegistryStateRoot,
                ...(policyBinding.publication ? { generationId: initialNavigation!.generationId } : {}),
            });
            if (relationshipRead.status !== 'ok') return null;
            const sealProof = await verifyNavigationGenerationSealArtifacts({
                stateRoot: this.symbolRegistryStateRoot,
                normalizedRootPath: canonicalRoot,
                ...(policyBinding.publication ? { generationId: initialNavigation!.generationId } : {}),
                registry: registryRead.registry,
                relationshipManifest: relationshipRead.manifest,
            });
            if (sealProof.status !== 'ok') return null;
        }
        const navigationToken = navigation
            ? this.resolveNavigationObservationToken(
                canonicalRoot,
                navigation.generationId,
                policyBinding.publication === undefined,
            )
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
        const finalPolicyToken = this.resolveCustomIndexPolicyFileToken(canonicalRoot);
        const finalNavigationToken = requireNavigation && navigation
            ? this.resolveNavigationObservationToken(
                canonicalRoot,
                navigation.generationId,
                policyBinding.publication === undefined,
            )
            : null;
        const finalPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const finalBinding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
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
            || !policyNavigationBindingsEqual(
                finalBinding.navigation,
                policyNavigationBindingFromMarker(initialMarker.navigation),
            )
            || !publicationBindingsEqual(finalBinding.publication, policyBinding.publication)
            || (requireNavigation && (
                finalMarker.navigation.status !== 'sealed'
                || navigation?.navigationSealHash !== finalMarker.navigation.sealHash
            ))
            || this.policyDocumentDigestsByCodebase.get(canonicalRoot) !== policyDocumentDigest
        ) {
            return null;
        }
        const vectorReceipt: ProvenVectorGenerationReceipt = {
            collectionName: policyBinding.collectionName,
            marker: this.cloneIndexCompletionMarker(initialMarker),
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
                observations: {
                    ...vectorReceipt.observations,
                    navigationToken: finalNavigationToken!,
                },
            }
            : vectorReceipt;
    }

    private cloneProvenVectorGenerationReceipt(
        receipt: ProvenVectorGenerationReceipt,
    ): ProvenVectorGenerationReceipt {
        return {
            collectionName: receipt.collectionName,
            marker: this.cloneIndexCompletionMarker(receipt.marker),
            policy: {
                ...receipt.policy,
                customExtensions: [...receipt.policy.customExtensions],
                customIgnorePatterns: [...receipt.policy.customIgnorePatterns],
                fileBasedIgnorePatterns: [...receipt.policy.fileBasedIgnorePatterns],
                supportedExtensions: [...receipt.policy.supportedExtensions],
                effectiveIgnorePatterns: [...receipt.policy.effectiveIgnorePatterns],
            },
            policyDocumentDigest: receipt.policyDocumentDigest,
            exactPayloadCount: receipt.exactPayloadCount,
            observations: { ...receipt.observations },
        };
    }

    private cloneProvenGenerationReceipt(
        receipt: ProvenGenerationReceipt,
    ): ProvenGenerationReceipt {
        return {
            ...this.cloneProvenVectorGenerationReceipt(receipt),
            navigation: { ...receipt.navigation },
            observations: { ...receipt.observations },
        };
    }

    private async resolveGenerationProofIdentity(
        canonicalRoot: string,
    ): Promise<string | null> {
        const observations = this.getIndexAuthorityObservations(canonicalRoot);
        if (!observations) return null;
        const collectionName = this.publishedPolicyBindingsByCodebase.get(canonicalRoot)?.collectionName;
        const observePublication = this.vectorDatabase.getPublicationObservation;
        if (!collectionName || typeof observePublication !== 'function') return null;
        const publicationObservation = await observePublication.call(this.vectorDatabase, collectionName);
        if (!publicationObservation) return null;
        return JSON.stringify({
            vector: observations.vector,
            navigation: observations.navigation,
            publicationObservation,
        });
    }

    private async recordActivatedGenerationProof(input: {
        canonicalRoot: string;
        marker: IndexCompletionMarkerDocument;
        policy: ResolvedIndexPolicy;
        navigation: CurrentNavigationGeneration;
        exactPayloadCount: number;
    }): Promise<ProvenGenerationReceipt | null> {
        const policyDocumentDigest = this.policyDocumentDigestsByCodebase.get(input.canonicalRoot);
        const navigationToken = this.resolveNavigationObservationToken(
            input.canonicalRoot,
            input.navigation.generationId,
            false,
        );
        const identity = await this.resolveGenerationProofIdentity(input.canonicalRoot);
        if (!policyDocumentDigest || !navigationToken || !identity) return null;
        const receipt: ProvenGenerationReceipt = {
            collectionName: this.publishedPolicyBindingsByCodebase.get(input.canonicalRoot)?.collectionName ?? '',
            marker: this.cloneIndexCompletionMarker(input.marker),
            policy: {
                ...input.policy,
                customExtensions: [...input.policy.customExtensions],
                customIgnorePatterns: [...input.policy.customIgnorePatterns],
                fileBasedIgnorePatterns: [...input.policy.fileBasedIgnorePatterns],
                supportedExtensions: [...input.policy.supportedExtensions],
                effectiveIgnorePatterns: [...input.policy.effectiveIgnorePatterns],
            },
            policyDocumentDigest,
            exactPayloadCount: input.exactPayloadCount,
            navigation: { ...input.navigation },
            observations: {
                profileFileToken: this.resolveRepoConfigObservationToken(input.canonicalRoot),
                policyFileToken: this.resolveCustomIndexPolicyFileToken(input.canonicalRoot)!,
                navigationToken,
            },
        };
        if (
            receipt.collectionName.length === 0
            || !receipt.observations.policyFileToken
            || !this.isPreparedVectorReceiptBoundToCurrentAuthority(input.canonicalRoot, receipt)
        ) return null;
        this.generationProofs.set(input.canonicalRoot, {
            identity,
            vectorReceipt: this.cloneProvenVectorGenerationReceipt(receipt),
            generationReceipt: this.cloneProvenGenerationReceipt(receipt),
            navigationArtifactsValidated: true,
            source: 'activation',
        });
        return this.cloneProvenGenerationReceipt(receipt);
    }

    private invalidateGenerationProofForCollection(collectionName: string): void {
        for (const [canonicalRoot, proof] of this.generationProofs) {
            if (proof.vectorReceipt.collectionName === collectionName) {
                this.generationProofs.delete(canonicalRoot);
            }
        }
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
        const initialPolicyToken = this.resolveCustomIndexPolicyFileToken(canonicalRoot);
        if (
            receipt.policy.canonicalRoot !== canonicalRoot
            || receipt.observations.profileFileToken !== initialProfileToken
            || receipt.observations.policyFileToken !== initialPolicyToken
        ) return null;

        this.refreshRuntimePolicyAuthority(canonicalRoot);
        const policy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        const binding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        if (
            !policy
            || !binding
            || this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
            || binding.collectionName !== receipt.collectionName
            || !this.markerMatchesSealedAuthority(receipt.marker, policy, binding)
            || this.policyDocumentDigestsByCodebase.get(canonicalRoot) !== receipt.policyDocumentDigest
            || !(await this.vectorDatabase.hasCollection(receipt.collectionName))
        ) return null;

        const marker = await this.resolveCompletionMarkerForCollection(canonicalRoot, receipt.collectionName);
        if (!marker || !this.indexCompletionMarkersEqual(marker, receipt.marker)) return null;
        if (
            this.resolveRepoConfigObservationToken(canonicalRoot) !== initialProfileToken
            || this.resolveCustomIndexPolicyFileToken(canonicalRoot) !== initialPolicyToken
        ) return null;
        return {
            collectionName: binding.collectionName,
            marker: this.cloneIndexCompletionMarker(marker),
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
        const identity = await this.resolveGenerationProofIdentity(canonicalRoot);
        if (identity) {
            const cached = this.generationProofs.get(canonicalRoot);
            if (
                cached
                && this.cachedGenerationProofMatches(canonicalRoot, cached, identity, priorReceipt)
            ) {
                if (await this.resolveGenerationProofIdentity(canonicalRoot) !== identity) {
                    return { receipt: null, exactPayloadRecounts: 0, source: 'reused' };
                }
                return {
                    receipt: this.cloneProvenVectorGenerationReceipt(cached.vectorReceipt),
                    exactPayloadRecounts: 0,
                    source: 'reused',
                };
            }

            const flightKey = JSON.stringify([canonicalRoot, identity]);
            const joinedFlight = this.generationProofFlights.get(flightKey);
            if (joinedFlight) {
                const joined = await joinedFlight;
                if (
                    !joined
                    || !this.cachedGenerationProofMatches(canonicalRoot, joined, identity, priorReceipt)
                    || await this.resolveGenerationProofIdentity(canonicalRoot) !== identity
                ) {
                    return { receipt: null, exactPayloadRecounts: 0, source: 'joined' };
                }
                return {
                    receipt: this.cloneProvenVectorGenerationReceipt(joined.vectorReceipt),
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
                const identityAfter = await this.resolveGenerationProofIdentity(canonicalRoot);
                if (identityAfter !== identity) return null;
                const proven: CachedGenerationProof = {
                    identity,
                    vectorReceipt: this.cloneProvenVectorGenerationReceipt(exact),
                    navigationArtifactsValidated: false,
                    source: 'exact',
                };
                this.generationProofs.set(canonicalRoot, proven);
                return proven;
            })();
            this.generationProofFlights.set(flightKey, flight);
            try {
                const proven = await flight;
                return {
                    receipt: proven ? this.cloneProvenVectorGenerationReceipt(proven.vectorReceipt) : null,
                    exactPayloadRecounts: proven ? 1 : 0,
                    source: 'exact',
                };
            } finally {
                if (this.generationProofFlights.get(flightKey) === flight) {
                    this.generationProofFlights.delete(flightKey);
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
        const identity = await this.resolveGenerationProofIdentity(canonicalRoot);
        const cached = identity ? this.generationProofs.get(canonicalRoot) : undefined;
        if (
            cached
            && this.cachedGenerationProofMatches(canonicalRoot, cached, identity!, receipt)
            && cached.generationReceipt
            && (!validateArtifacts || cached.navigationArtifactsValidated)
        ) {
            if (await this.resolveGenerationProofIdentity(canonicalRoot) !== identity) {
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
        const joinedFlight = flightKey ? this.navigationProofFlights.get(flightKey) : undefined;
        if (joinedFlight) {
            const joinedProof = await joinedFlight;
            return await this.resolveGenerationProofIdentity(canonicalRoot) === identity
                ? joinedProof
                : { status: 'incompatible' };
        }
        const flight = this.proveNavigationGeneration(canonicalRoot, receipt.marker, validateArtifacts);
        if (flightKey) this.navigationProofFlights.set(flightKey, flight);
        let proof: NavigationGenerationProof;
        try {
            proof = await flight;
        } finally {
            if (flightKey && this.navigationProofFlights.get(flightKey) === flight) {
                this.navigationProofFlights.delete(flightKey);
            }
        }
        const identityAfter = await this.resolveGenerationProofIdentity(canonicalRoot);
        if (identityAfter !== identity) return { status: 'incompatible' };
        if (proof.status === 'valid' && identity) {
            const generationReceipt: ProvenGenerationReceipt = {
                ...this.cloneProvenVectorGenerationReceipt(receipt),
                navigation: { ...proof.generation },
                observations: {
                    ...receipt.observations,
                    navigationToken: proof.observationToken,
                },
            };
            this.generationProofs.set(canonicalRoot, {
                identity,
                vectorReceipt: this.cloneProvenVectorGenerationReceipt(receipt),
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
            ...this.cloneProvenVectorGenerationReceipt(vectorReceipt),
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
        if (marker.navigation.status === 'not_bound') {
            return { status: 'not_bound' };
        }
        const markerNavigation = marker.navigation;
        this.refreshRuntimePolicyAuthority(canonicalRoot);
        const policyBinding = this.publishedPolicyBindingsByCodebase.get(canonicalRoot);
        const useBoundGeneration = policyBinding?.publication !== undefined
            && policyBinding.collectionName.length > 0
            && policyBinding.navigation.status === 'sealed'
            && policyBinding.navigation.generationId === markerNavigation.generationId;
        let generation: CurrentNavigationGeneration | null;
        try {
            generation = await (useBoundGeneration
                ? resolveNavigationGeneration(
                    this.symbolRegistryStateRoot,
                    canonicalRoot,
                    markerNavigation.generationId,
                )
                : resolveCurrentNavigationGeneration(this.symbolRegistryStateRoot, canonicalRoot));
        } catch (error) {
            return {
                status: error instanceof RetiredNavigationPointerError
                    ? 'requires_reindex'
                    : error instanceof UnsupportedNavigationPointerError
                        ? 'unsupported'
                        : 'corrupt',
            };
        }
        if (!generation) return { status: 'missing' };
        if (
            generation.generationId !== markerNavigation.generationId
            || generation.symbolRegistryManifestHash !== markerNavigation.symbolRegistryManifestHash
            || generation.relationshipManifestHash !== markerNavigation.relationshipManifestHash
            || generation.navigationSealHash !== markerNavigation.sealHash
        ) {
            return { status: 'incompatible' };
        }
        if (validateArtifacts) {
            const registryRead = await readSymbolRegistrySidecar({
                normalizedRootPath: canonicalRoot,
                stateRoot: this.symbolRegistryStateRoot,
                ...(useBoundGeneration ? { generationId: markerNavigation.generationId } : {}),
            });
            if (registryRead.status !== 'ok') {
                return { status: registryRead.status };
            }
            const relationshipRead = await readRelationshipSidecar({
                normalizedRootPath: canonicalRoot,
                expectedSymbolRegistryManifestHash: generation.symbolRegistryManifestHash,
                stateRoot: this.symbolRegistryStateRoot,
                ...(useBoundGeneration ? { generationId: markerNavigation.generationId } : {}),
            });
            if (relationshipRead.status !== 'ok') {
                return { status: relationshipRead.status };
            }
            const sealProof = await verifyNavigationGenerationSealArtifacts({
                stateRoot: this.symbolRegistryStateRoot,
                normalizedRootPath: canonicalRoot,
                ...(useBoundGeneration ? { generationId: markerNavigation.generationId } : {}),
                registry: registryRead.registry,
                relationshipManifest: relationshipRead.manifest,
            });
            if (sealProof.status !== 'ok') return { status: sealProof.status };
        }
        try {
            const observation = this.resolveNavigationObservation(
                canonicalRoot,
                generation.generationId,
                !useBoundGeneration,
            );
            return observation.status === 'valid'
                ? { status: 'valid', generation: { ...generation }, observationToken: observation.token }
                : { status: observation.status };
        } catch {
            return { status: 'corrupt' };
        }
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

    private async publishResolvedIndexPolicyForMarker(
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyBinding,
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
                || !policyNavigationBindingsEqual(receipt.navigation, binding.navigation)
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
                || JSON.stringify(proven.marker.navigation) !== JSON.stringify(marker.navigation)
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
        const navigationBinding = policyNavigationBindingFromMarker(marker.navigation);
        if (
            currentBinding?.policyHash === marker.indexPolicyHash
            && currentBinding.collectionName === collectionName
            && policyNavigationBindingsEqual(currentBinding.navigation, navigationBinding)
        ) {
            return;
        }
        await this.publishResolvedIndexPolicyForMarker(policy, {
            collectionName,
            navigation: navigationBinding,
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
        options: StagedCollectionPruneOptions = {},
    ): Promise<string[]> {
        if (options.discardUnprovenPayload && !options.assertMutationCurrent) {
            throw new Error('Discarding unproven staged payload requires a current mutation lease.');
        }
        const familyCollectionNames = await this.listRelatedCollectionNames(codebasePath);
        const droppedCollections: string[] = [];

        for (const collectionName of familyCollectionNames) {
            if (!collectionName.includes('__gen_')) {
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
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false,
        options: MutationGuardOptions = {},
    ): Promise<IndexCodebaseResult> {
        const operationStartedAt = Date.now();
        // Batch policy and metrics are optional capabilities: structural embedding
        // adapters may implement indexing without inheriting the base defaults.
        const embeddingMetricsBefore = this.embedding.getOperationMetricsSnapshot?.() ?? null;
        const vectorWriteMetricsBefore = this.vectorDatabase.getWriteMetricsSnapshot?.() ?? null;
        let prepareCollectionMs = 0;
        let scanFilesMs = 0;
        let payloadPipelineMs = 0;
        let finalizeCollectionMs = 0;
        let navigationMs = 0;
        let publicationMs = 0;
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
        // Forced preparation replaces the collection, so the new schema cannot contain
        // an old completion marker. Do not query it to clear one: hybrid rebuilds keep
        // this collection deliberately indexless until all payload writes are complete.
        const prepareStartedAt = Date.now();
        if (options.preparedCollectionReceipt) {
            if (!options.preparedCollectionBinding) {
                throw new Error('Prepared index collection binding is required with its receipt.');
            }
            await this.consumePreparedIndexCollection(
                codebasePath,
                options.preparedCollectionReceipt,
                options.preparedCollectionBinding,
                options.assertMutationCurrent,
            );
        } else if (options.preparedCollectionBinding) {
            throw new Error('Prepared index collection receipt is required with its binding.');
        } else {
            await this.prepareCollection(codebasePath, true, options.assertMutationCurrent);
        }
        prepareCollectionMs = Date.now() - prepareStartedAt;

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const scanStartedAt = Date.now();
        const codeFiles = await this.getCodeFiles(codebasePath, indexPolicy);
        scanFilesMs = Date.now() - scanStartedAt;
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            await this.finalizePreparedCollection(codebasePath, options.assertMutationCurrent);
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
                    navigation: navigationCandidate ? {
                        status: 'sealed',
                        generationId: navigationCandidate.generationId,
                        sealHash: navigationCandidate.navigationSealHash,
                    } : { status: 'not_bound' },
                }, marker, options.publishMutation);
            }
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return {
                indexedFiles: 0,
                totalChunks: 0,
                status: 'completed',
                indexedFileHashes: new Map(),
                ...(navigationCandidate ? { navigationCandidate } : {}),
            };
        }

        // 3. Process each file with streaming chunk processing
        // Reserve 10% for preparation, 90% for actual indexing
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 100;
        const indexingRange = indexingEndPercentage - indexingStartPercentage;

        const payloadStartedAt = Date.now();
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
        payloadPipelineMs = Date.now() - payloadStartedAt;

        const finalizeStartedAt = Date.now();
        await this.finalizePreparedCollection(codebasePath, options.assertMutationCurrent);
        finalizeCollectionMs = Date.now() - finalizeStartedAt;

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

        let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
        if (result.status === 'completed') {
            const navigationStartedAt = Date.now();
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
            navigationMs = Date.now() - navigationStartedAt;
            if (!options.deferFullIndexPublication) {
                const publicationStartedAt = Date.now();
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
                    navigation: navigationCandidate ? {
                        status: 'sealed',
                        generationId: navigationCandidate.generationId,
                        sealHash: navigationCandidate.navigationSealHash,
                    } : { status: 'not_bound' },
                }, marker, options.publishMutation);
                publicationMs = Date.now() - publicationStartedAt;
            }
        } else {
            // limit_reached: do not publish complete navigation sidecars, but seal partial vector
            // proof so MCP readiness can allow warned partial search (not "missing marker" stale_local).
            // indexStatus must stay on the marker so interrupted-index recovery does not promote as fully completed.
            console.warn('[Context] ⚠️  Skipping symbol registry sidecar write because indexing stopped before processing the full file set.');
            if (!options.deferFullIndexPublication) {
                const publicationStartedAt = Date.now();
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
                    navigation: { status: 'not_bound' },
                }, marker, options.publishMutation);
                console.warn('[Context] ⚠️  Wrote completion marker for limit_reached partial index (navigation remains unpublished).');
                publicationMs = Date.now() - publicationStartedAt;
            }
        }

        progressCallback?.({
            phase: result.status === 'completed' ? 'Indexing complete!' : 'Indexing stopped at chunk limit',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100
        });

        const embeddingMetrics = subtractEmbeddingMetrics(
            this.embedding.getOperationMetricsSnapshot?.() ?? null,
            embeddingMetricsBefore,
        );
        const vectorWriteMetrics = subtractVectorWriteMetrics(
            this.vectorDatabase.getWriteMetricsSnapshot?.() ?? null,
            vectorWriteMetricsBefore,
        );
        const vectorWriteSummary = summarizeVectorWriteMetrics(
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

    private async waitForPublicationRetention(canonicalRoot: string): Promise<void> {
        await this.publicationRetentionQueues.get(canonicalRoot);
    }

    /**
     * Retention is the only owner allowed to remove inactive physical generations.
     * A publication-bound reader holds this lease for its complete operation so a
     * second activation cannot prune the collection or navigation generation it uses.
     */
    public async acquirePublicationReadLease(codebasePath: string): Promise<() => void> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        let gate = this.publicationReadGates.get(canonicalRoot);
        if (!gate) {
            gate = { activeReaders: 0, retentionPending: false };
            this.publicationReadGates.set(canonicalRoot, gate);
        }
        while (gate.retentionPending) {
            await gate.retentionFinished;
        }
        gate.activeReaders += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            gate!.activeReaders -= 1;
            if (gate!.activeReaders === 0) {
                gate!.resolveReadersDrained?.();
                gate!.readersDrained = undefined;
                gate!.resolveReadersDrained = undefined;
            }
        };
    }

    private async acquirePublicationRetentionLease(canonicalRoot: string): Promise<() => void> {
        let gate = this.publicationReadGates.get(canonicalRoot);
        if (!gate) {
            gate = { activeReaders: 0, retentionPending: false };
            this.publicationReadGates.set(canonicalRoot, gate);
        }
        if (gate.retentionPending) {
            throw new Error(`Publication retention is already active for '${canonicalRoot}'.`);
        }
        gate.retentionPending = true;
        gate.retentionFinished = new Promise<void>((resolve) => {
            gate!.resolveRetentionFinished = resolve;
        });
        if (gate.activeReaders > 0) {
            gate.readersDrained = new Promise<void>((resolve) => {
                gate!.resolveReadersDrained = resolve;
            });
            await gate.readersDrained;
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            gate!.retentionPending = false;
            gate!.resolveRetentionFinished?.();
            gate!.retentionFinished = undefined;
            gate!.resolveRetentionFinished = undefined;
        };
    }

    private schedulePublicationRetention(input: {
        canonicalRoot: string;
        activationId: string;
        activeCollectionName: string;
        previousCollectionName: string;
        activeNavigationGenerationId: string;
        previousNavigationGenerationId: string;
    }): void {
        const previous = this.publicationRetentionQueues.get(input.canonicalRoot) ?? Promise.resolve();
        const retention = previous
            .catch(() => undefined)
            .then(async () => {
                const releaseRetention = await this.acquirePublicationRetentionLease(input.canonicalRoot);
                try {
                    this.refreshRuntimePolicyAuthority(input.canonicalRoot);
                    const activeBinding = this.publishedPolicyBindingsByCodebase.get(input.canonicalRoot);
                    if (
                        activeBinding?.collectionName !== input.activeCollectionName
                        || activeBinding.publication?.activationId !== input.activationId
                    ) return;

                    const retainedCollections = new Set([
                        input.activeCollectionName,
                        input.previousCollectionName,
                    ]);
                    for (const collectionName of await this.listRelatedCollectionNames(input.canonicalRoot)) {
                        if (retainedCollections.has(collectionName)) continue;
                        this.refreshRuntimePolicyAuthority(input.canonicalRoot);
                        const currentBinding = this.publishedPolicyBindingsByCodebase.get(input.canonicalRoot);
                        if (
                            currentBinding?.collectionName !== input.activeCollectionName
                            || currentBinding.publication?.activationId !== input.activationId
                        ) return;
                        await deleteCollectionWithVerification(this.vectorDatabase, collectionName);
                    }

                    await pruneNavigationSidecarGenerations({
                        stateRoot: this.symbolRegistryStateRoot,
                        normalizedRootPath: input.canonicalRoot,
                        keepGenerationIds: new Set([
                            input.activeNavigationGenerationId,
                            input.previousNavigationGenerationId,
                        ]),
                    });
                    await FileSynchronizer.pruneSnapshotsForGenerations(
                        input.canonicalRoot,
                        retainedCollections,
                    );
                } finally {
                    releaseRetention();
                }
            })
            .catch((error) => {
                console.warn(
                    `[Context] ⚠️  Deferred publication generation cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        this.publicationRetentionQueues.set(input.canonicalRoot, retention);
        void retention.finally(() => {
            if (this.publicationRetentionQueues.get(input.canonicalRoot) === retention) {
                this.publicationRetentionQueues.delete(input.canonicalRoot);
            }
        });
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
        const { added, removed, modified } = input.preparedChanges.changes;
        const changedFiles = Array.from(new Set([...added, ...removed, ...modified]));
        const totalChanges = changedFiles.length;
        const sourceNavigation = input.previousMarker.navigation.status === 'sealed'
            ? input.previousMarker.navigation
            : null;
        if (!sourceNavigation) {
            throw new Error('Atomic delta publication requires a sealed source navigation generation; reindex is required.');
        }
        if (!this.vectorDatabase.forkCollection) {
            throw new AtomicIncrementalPublicationUnsupportedError();
        }
        const existingRegistry = await readSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: input.canonicalRoot,
            generationId: sourceNavigation.generationId,
        });
        if (existingRegistry.status !== 'ok'
            || existingRegistry.manifestHash !== sourceNavigation.symbolRegistryManifestHash) {
            throw new Error('Atomic delta publication cannot prove its source navigation metadata; reindex is required.');
        }

        const activationId = crypto.randomUUID();
        const candidateCollectionName = this.resolveStagedCollectionName(input.codebasePath, activationId);
        const markerRunId = crypto.randomUUID();
        let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
        let checkpointStaged = false;
        let activated = false;
        try {
            await this.waitForPublicationRetention(input.canonicalRoot);
            input.options.assertMutationCurrent?.();
            await this.vectorDatabase.forkCollection(input.sourceCollectionName, candidateCollectionName);

            let replacedPayloadCount = 0;
            for (const relativePath of changedFiles) {
                const pathCount = await this.countIndexedPayloadExactly(
                    candidateCollectionName,
                    { kind: 'comparison', field: 'relativePath', operator: 'eq', value: relativePath },
                    input.previousMarker.totalChunks,
                );
                if (pathCount === null) {
                    throw new Error(`Atomic delta publication could not count existing payload for '${relativePath}'.`);
                }
                replacedPayloadCount += pathCount;
                await this.deleteFileChunks(candidateCollectionName, relativePath, input.options.assertMutationCurrent);
            }

            let processedChanges = 0;
            const filesToIndex = [...added, ...modified].map((file) => path.join(input.codebasePath, file));
            const indexedDelta = filesToIndex.length > 0
                ? await this.processFileList(
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
            if (indexedDelta.status !== 'completed') {
                throw new Error('Atomic delta publication stopped before every changed file was indexed.');
            }
            const totalChunks = input.previousMarker.totalChunks - replacedPayloadCount + indexedDelta.totalChunks;
            if (!Number.isSafeInteger(totalChunks) || totalChunks < 0) {
                throw new Error('Atomic delta publication produced an invalid payload count.');
            }

            navigationCandidate = await this.rebuildNavigationArtifactsForSyncDelta(
                input.codebasePath,
                existingRegistry.registry,
                changedFiles,
                indexedDelta.symbolRecords,
                indexedDelta.symbolManifestFiles,
                input.options.assertMutationCurrent,
                indexedDelta.analysisByFile,
                undefined,
                sourceNavigation.generationId,
                true,
            );
            if (!navigationCandidate) {
                throw new Error('Atomic delta publication cannot publish a repository without navigation state.');
            }

            await this.verifyPreparedSyncPublication(
                input.codebasePath,
                candidateCollectionName,
                input.preparedChanges.fileHashes,
                totalChunks,
                navigationCandidate.generationId,
            );
            const checkpointAuthority = {
                collectionName: candidateCollectionName,
                markerRunId,
                indexPolicyHash: input.sealedPolicy.policyHash,
            };
            const checkpoint = await input.preparedChanges.stageCheckpoint(
                checkpointAuthority,
                input.options.assertMutationCurrent,
            );
            checkpointStaged = true;
            const publishedMarker = await this.writeCompletedIndexMarker(
                input.codebasePath,
                input.preparedChanges.fileHashes.size,
                totalChunks,
                candidateCollectionName,
                'completed',
                input.options.assertMutationCurrent,
                navigationCandidate,
                input.sealedPolicy.policyHash,
                markerRunId,
            );

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
                    manifestHash: navigationCandidate.relationshipManifestHash,
                },
                receipt: {
                    ownerId: authority.ownerId,
                    generation: authority.generation,
                    operationId: authority.operationId,
                },
            };
            await input.preparedChanges.assertSourceObservationCurrent();
            input.options.assertMutationCurrent?.();
            this.publishResolvedIndexPolicy(
                input.sealedPolicy,
                {
                    collectionName: candidateCollectionName,
                    navigation: {
                        status: 'sealed',
                        generationId: navigationCandidate.generationId,
                        sealHash: navigationCandidate.navigationSealHash,
                    },
                    publication,
                },
                input.options.publishMutation,
            );
            activated = true;

            const activatedGenerationReceipt = await this.recordActivatedGenerationProof({
                canonicalRoot: input.canonicalRoot,
                marker: publishedMarker,
                policy: input.sealedPolicy,
                exactPayloadCount: totalChunks,
                navigation: {
                    generationId: navigationCandidate.generationId,
                    generationRoot: navigationCandidate.rootPath,
                    symbolRegistryManifestHash: navigationCandidate.manifestHash,
                    relationshipManifestHash: navigationCandidate.relationshipManifestHash,
                    navigationSealHash: navigationCandidate.navigationSealHash,
                },
            });

            const nextSynchronizer = new FileSynchronizer(
                input.codebasePath,
                this.getActiveIgnorePatterns(input.codebasePath),
                this.getIndexedExtensionsForCodebase(input.codebasePath),
                { checkpointIdentity: candidateCollectionName, checkpointAuthority },
            );
            await nextSynchronizer.initialize(undefined, undefined, { requireExistingCheckpoint: true });
            this.synchronizers.set(input.synchronizerKey, nextSynchronizer);
            this.synchronizerMutationTargets.delete(input.synchronizerKey);
            this.schedulePublicationRetention({
                canonicalRoot: input.canonicalRoot,
                activationId,
                activeCollectionName: candidateCollectionName,
                previousCollectionName: input.sourceCollectionName,
                activeNavigationGenerationId: navigationCandidate.generationId,
                previousNavigationGenerationId: sourceNavigation.generationId,
            });

            return {
                added: added.length,
                removed: removed.length,
                modified: modified.length,
                changedFiles,
                collectionName: candidateCollectionName,
                indexedFiles: input.preparedChanges.fileHashes.size,
                totalChunks,
                indexStatus: 'completed',
                ...(activatedGenerationReceipt
                    ? { generationReceipt: activatedGenerationReceipt }
                    : {}),
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
                await this.vectorDatabase.dropCollection(candidateCollectionName).catch(() => undefined);
            }
            throw error;
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
        let synchronizer = this.synchronizers.get(synchronizerKey);
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
            ? await this.acceptPreparedSourceGenerationReceipt(canonicalRoot, options.sourceGenerationReceipt)
            : null;
        if (options.sourceGenerationReceipt && !sourceGenerationReceipt) {
            throw new Error(`Cannot incrementally synchronize '${codebasePath}': prepared source generation changed before publication.`);
        }
        let collectionName = typeof options.targetCollectionName === 'string' && options.targetCollectionName.trim().length > 0
            ? options.targetCollectionName.trim()
            : null;
        if (collectionName) {
            if (!(await this.vectorDatabase.hasCollection(collectionName))) {
                throw new Error(`Cannot incremental sync '${codebasePath}': target collection '${collectionName}' does not exist.`);
            }
        } else {
            const activeCollectionName = sourceGenerationReceipt?.collectionName
                ?? await this.getActiveIndexedCollectionName(codebasePath);
            collectionName = activeCollectionName;
            if (!collectionName) {
                const proofCollection = await this.resolveCompletionProofCollection(codebasePath);
                if (
                    proofCollection
                    && indexFingerprintsEqual(
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

        const previousMarker = maintainCompletionMarker
            ? sourceGenerationReceipt?.collectionName === collectionName
                ? this.cloneIndexCompletionMarker(sourceGenerationReceipt.marker)
                : await this.resolveCompletionMarkerForCollection(codebasePath, collectionName)
            : null;
        const checkpointAuthority = previousMarker ? {
            collectionName,
            markerRunId: previousMarker.runId,
            indexPolicyHash: previousMarker.indexPolicyHash,
        } : null;
        const reusingWithdrawnMutationTarget = previousMarker === null
            && this.synchronizerMutationTargets.get(synchronizerKey) === collectionName
            && synchronizer?.ownsCheckpointIdentity(collectionName) === true;
        const restoringMissingMarkerFromOwnedCheckpoint = previousMarker === null
            && maintainCompletionMarker
            && options.targetCollectionName?.trim() === collectionName
            && synchronizer?.ownsCheckpointForCollectionPolicy(
                collectionName,
                sealedPolicy.policyHash,
            ) === true;

        if (
            synchronizer
            && !reusingWithdrawnMutationTarget
            && !restoringMissingMarkerFromOwnedCheckpoint
            && (!checkpointAuthority || !synchronizer.ownsCheckpointAuthority(checkpointAuthority))
        ) {
            if (!checkpointAuthority) {
                throw new Error(`Cannot incrementally synchronize '${codebasePath}': no completion marker owns its source checkpoint.`);
            }
            await this.loadIgnorePatterns(codebasePath);
            synchronizer = new FileSynchronizer(
                codebasePath,
                this.getActiveIgnorePatterns(codebasePath),
                this.getIndexedExtensionsForCodebase(codebasePath),
                { checkpointIdentity: collectionName, checkpointAuthority },
            );
            await synchronizer.initialize(options.assertMutationCurrent, options.publishMutation, {
                requireExistingCheckpoint: true,
            });
            this.synchronizers.set(synchronizerKey, synchronizer);
            this.synchronizerMutationTargets.delete(synchronizerKey);
        }

        if (!synchronizer) {
            if (!checkpointAuthority) {
                throw new Error(`Cannot incrementally synchronize '${codebasePath}': no completion marker owns its source checkpoint.`);
            }
            await this.loadIgnorePatterns(codebasePath);
            const newSynchronizer = new FileSynchronizer(
                codebasePath,
                this.getActiveIgnorePatterns(codebasePath),
                this.getIndexedExtensionsForCodebase(codebasePath),
                { checkpointIdentity: collectionName, checkpointAuthority },
            );
            await newSynchronizer.initialize(options.assertMutationCurrent, options.publishMutation, {
                requireExistingCheckpoint: true,
            });
            this.synchronizers.set(synchronizerKey, newSynchronizer);
            this.synchronizerMutationTargets.delete(synchronizerKey);
        }

        const currentSynchronizer = this.synchronizers.get(synchronizerKey)!;
        const targetCollectionName = collectionName;
        this.synchronizerMutationTargets.set(synchronizerKey, targetCollectionName);
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

        if (
            maintainCompletionMarker
            && previousMarker
            && this.vectorDatabase.getPublicationCapabilities?.().atomicCandidatePublication === 'unsupported'
        ) {
            throw new AtomicIncrementalPublicationUnsupportedError();
        }
        if (maintainCompletionMarker && previousMarker && this.vectorDatabase.forkCollection) {
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
                const pathCount = await this.countIndexedPayloadExactly(
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
                    await this.writeCompletedIndexMarker(
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

    /**
     * Semantic search with unified implementation
     * @param codebasePath Codebase path to search in
     * @param query Search query
     * @param topK Number of results to return
     * @param threshold Similarity threshold
     */
    async semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResult[]>;
    async semanticSearch(codebasePath: string, query: string, topK?: number, threshold?: number, filter?: VectorFilter): Promise<SemanticSearchResult[]>;
    async semanticSearch(
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filter?: VectorFilter
    ): Promise<SemanticSearchResult[]> {
        return this.semanticSearchWithReceipt(
            undefined,
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
        return this.semanticSearchWithReceipt(receipt, request, undefined, 5, 0.5, undefined, true);
    }

    public async semanticSearchWithCandidateTraceInProvenGeneration(
        receipt: ProvenVectorGenerationReceipt,
        request: SemanticSearchRequest,
        maxEntriesPerStage: number,
        options: SemanticSearchCandidateTraceOptions = {},
    ): Promise<SemanticSearchExecutionResult> {
        if (
            !Number.isSafeInteger(maxEntriesPerStage)
            || maxEntriesPerStage < 1
            || maxEntriesPerStage > MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE
        ) {
            throw new Error(
                `Candidate trace maxEntriesPerStage must be an integer from 1 through ${MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE}.`,
            );
        }
        if (
            options.diagnosticCandidateLimit !== undefined
            && (
                !Number.isSafeInteger(options.diagnosticCandidateLimit)
                || options.diagnosticCandidateLimit < 1
                || options.diagnosticCandidateLimit > maxEntriesPerStage
            )
        ) {
            throw new Error(
                `Diagnostic candidate limit must be an integer from 1 through maxEntriesPerStage (${maxEntriesPerStage}).`,
            );
        }
        if (options.lexicalFallbackTerms !== undefined) {
            if (
                options.captureLexicalFallback !== true
                || options.lexicalFallbackTerms.length < 1
                || options.lexicalFallbackTerms.length > 8
                || options.lexicalFallbackTerms.some((term) => (
                    typeof term !== 'string'
                    || term.length === 0
                    || term !== term.trim()
                ))
            ) {
                throw new Error(
                    'Lexical fallback terms require fallback capture and 1 through 8 non-empty canonical terms.',
                );
            }
        }
        let candidateTrace: SemanticSearchCandidateTrace | undefined;
        let diagnosticCandidateArms: SemanticSearchExecutionResult['diagnosticCandidateArms'];
        const results = await this.semanticSearchWithReceipt(
            receipt,
            request,
            undefined,
            5,
            0.5,
            undefined,
            true,
            (trace) => {
                candidateTrace = trace;
            },
            maxEntriesPerStage,
            options,
            (arms) => {
                diagnosticCandidateArms = arms;
            },
        );
        if (!candidateTrace) {
            throw new Error('Candidate trace was not produced for the semantic search.');
        }
        return {
            results,
            candidateTrace,
            ...(diagnosticCandidateArms ? { diagnosticCandidateArms } : {}),
        };
    }

    private async semanticSearchWithReceipt(
        receipt: ProvenVectorGenerationReceipt | undefined,
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filter?: VectorFilter,
        requestBoundReceipt = false,
        candidateTraceConsumer?: (trace: SemanticSearchCandidateTrace) => void,
        candidateTraceMaxEntries = MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE,
        candidateTraceOptions: SemanticSearchCandidateTraceOptions = {},
        diagnosticCandidateArmsConsumer?: (
            arms: NonNullable<SemanticSearchExecutionResult['diagnosticCandidateArms']>,
        ) => void,
    ): Promise<SemanticSearchResult[]> {
        const request = this.normalizeSemanticSearchRequest(requestOrCodebasePath, query, topK, threshold, filter);
        const resolvedRequest = this.resolveSemanticSearchRequest(request);
        const codebasePath = resolvedRequest.codebasePath;
        const candidateRetrievalLimit = candidateTraceConsumer
            ? Math.max(
                resolvedRequest.topK,
                candidateTraceOptions.diagnosticCandidateLimit ?? resolvedRequest.topK,
            )
            : resolvedRequest.topK;
        const hybridCollection = this.getIsHybrid() === true;
        const isSparseOnly = resolvedRequest.retrievalMode === 'lexical' && hybridCollection;
        const isHybrid = resolvedRequest.retrievalMode === 'hybrid' && hybridCollection;
        const lexicalMatchMode = semanticSearchLexicalMatchMode(this.vectorDatabase);
        const captureLexicalFallback = candidateTraceOptions.captureLexicalFallback === true
            && lexicalMatchMode === 'all_terms'
            && (isSparseOnly || isHybrid);
        const lexicalFallbackTerms = candidateTraceOptions.lexicalFallbackTerms;
        const lexicalFallbackQuery = lexicalFallbackTerms?.join(' ') ?? resolvedRequest.query;
        const initialMutationObservation = isHybrid || captureLexicalFallback
            ? this.observeMutationGeneration(codebasePath)
            : null;
        if (initialMutationObservation?.mutationActive) {
            throw new Error('Index generation changed during hybrid retrieval.');
        }
        const searchType = isSparseOnly ? 'sparse search' : isHybrid ? 'hybrid search' : 'semantic search';
        const requestId = crypto.randomUUID();
        console.log(`[Context] 🔍 Executing ${searchType}: query_length=${resolvedRequest.query.length}, request_id=${requestId}, root=${codebasePath}`);

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
        const toSemanticSearchResult = (
            result: VectorCandidate,
            backendScoreKind: 'dense_similarity' | 'lexical_rank' | 'rrf_fusion',
        ): SemanticSearchResult => ({
            candidateId: result.document.id,
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
            backendScoreKind,
        });

        const revalidatedReceipt = receipt
            ? requestBoundReceipt
                ? this.isPreparedVectorReceiptBoundToCurrentAuthority(codebasePath, receipt)
                    ? receipt
                    : null
                : await this.revalidateProvenVectorGeneration(codebasePath, receipt)
            : await this.proveVectorGeneration(codebasePath);
        console.log(`[Context] 🔍 Using collection: ${revalidatedReceipt?.collectionName ?? null}`);

        // Check if collection exists and has data
        if (!revalidatedReceipt) {
            console.log(`[Context] ⚠️  No proven collection exists for '${codebasePath}'. Please index the codebase first.`);
            candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
                ...(isSparseOnly ? { lexical: [] } : { dense: [] }),
                ...(isHybrid ? { lexical: [] } : {}),
                result: [],
                hybrid: isHybrid,
                maxEntries: candidateTraceMaxEntries,
                productCandidateLimit: resolvedRequest.topK,
                queryEmbeddingSha256: null,
                lexicalRequests: [],
            }));
            return [];
        }
        const collectionName = revalidatedReceipt.collectionName;
        const assertCandidateReadAuthorityUnchanged = async (errorMessage: string): Promise<void> => {
            const finalMutationObservation = initialMutationObservation
                ? this.observeMutationGeneration(codebasePath)
                : null;
            // A request-bound receipt was proven by the MCP readiness boundary. When
            // a durable monotonic mutation observation is available, the unchanged
            // local authority plus an unchanged generation is the reader side of that
            // proof. Avoid rereading the remote marker for every split retrieval arm.
            // Runtimes without a mutation observer retain the remote marker proof.
            const sameGenerationReceipt = requestBoundReceipt && initialMutationObservation
                ? this.isPreparedVectorReceiptBoundToCurrentAuthority(
                    codebasePath,
                    revalidatedReceipt,
                )
                    ? revalidatedReceipt
                    : null
                : await this.revalidateProvenVectorGeneration(
                    codebasePath,
                    revalidatedReceipt,
                );
            if (
                !sameGenerationReceipt
                || (initialMutationObservation && (
                    !finalMutationObservation
                    || finalMutationObservation.mutationActive
                    || finalMutationObservation.generation !== initialMutationObservation.generation
                ))
            ) {
                throw new Error(errorMessage);
            }
        };

        if (isSparseOnly) {
            const [searchResults, lexicalFallback] = await Promise.all([
                this.vectorDatabase.retrieveLexical(collectionName, {
                    query: resolvedRequest.query,
                    limit: candidateRetrievalLimit,
                    filter: resolvedRequest.filter,
                }),
                captureLexicalFallback
                    ? this.vectorDatabase.retrieveLexical(collectionName, {
                        query: lexicalFallbackQuery,
                        limit: candidateRetrievalLimit,
                        filter: resolvedRequest.filter,
                        matchMode: 'any_terms',
                    })
                    : Promise.resolve(undefined),
            ]);
            if (captureLexicalFallback) {
                await assertCandidateReadAuthorityUnchanged(
                    'Index generation changed during diagnostic lexical retrieval.',
                );
            }
            const productResults = searchResults.slice(0, resolvedRequest.topK);
            diagnosticCandidateArmsConsumer?.({
                preciseLexical: searchResults.map((result) => toSemanticSearchResult(result, 'lexical_rank')),
                ...(lexicalFallback
                    ? {
                        fallbackLexical: lexicalFallback.map((result) => (
                            toSemanticSearchResult(result, 'lexical_rank')
                        )),
                    }
                    : {}),
            });
            candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
                lexical: searchResults,
                ...(lexicalFallback ? { lexicalFallback } : {}),
                result: productResults,
                hybrid: false,
                maxEntries: candidateTraceMaxEntries,
                productCandidateLimit: resolvedRequest.topK,
                queryEmbeddingSha256: null,
                lexicalRequests: [{
                    role: 'primary',
                    querySha256: hashSemanticSearchLexicalQuery(resolvedRequest.query),
                    matchMode: lexicalMatchMode,
                }, ...(lexicalFallback ? [{
                    role: 'fallback_or' as const,
                    querySha256: hashSemanticSearchLexicalQuery(lexicalFallbackQuery),
                    matchMode: 'any_terms' as const,
                    ...(lexicalFallbackTerms ? { terms: [...lexicalFallbackTerms] } : {}),
                }] : [])],
            }));
            return productResults.map((result) => toSemanticSearchResult(result, 'lexical_rank'));
        }

        if (isHybrid) {
            // 1. Generate query vector
            console.log(`[Context] 🔍 Generating query embedding: query_length=${resolvedRequest.query.length}, request_id=${requestId}`);
            this.assertEmbeddingIdentityCurrent();
            const queryEmbedding: EmbeddingVector = await this.embedding.embedQuery(resolvedRequest.query);
            this.assertEmbeddingIdentityCurrent();
            console.log(`[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);

            // 2. Prepare hybrid search requests
            console.log(`[Context] 🔍 Dense candidate request: vector_dim=${queryEmbedding.vector.length}, limit=${resolvedRequest.topK}`);
            console.log(`[Context] 🔍 Lexical candidate request: query_length=${resolvedRequest.query.length}, request_id=${requestId}, limit=${resolvedRequest.topK}`);

            // 3. Retrieve each backend-neutral arm and fuse under one Core-owned policy.
            console.log(`[Context] 🔍 Executing hybrid search with RRF reranking...`);
            const [denseCandidates, lexicalCandidates, lexicalFallback] = await Promise.all([
                this.vectorDatabase.retrieveDense(collectionName, {
                    vector: queryEmbedding.vector,
                    limit: candidateRetrievalLimit,
                    filter: resolvedRequest.filter,
                }),
                this.vectorDatabase.retrieveLexical(collectionName, {
                    query: resolvedRequest.query,
                    limit: candidateRetrievalLimit,
                    filter: resolvedRequest.filter,
                }),
                captureLexicalFallback
                    ? this.vectorDatabase.retrieveLexical(collectionName, {
                        query: lexicalFallbackQuery,
                        limit: candidateRetrievalLimit,
                        filter: resolvedRequest.filter,
                        matchMode: 'any_terms',
                    })
                    : Promise.resolve(undefined),
            ]);
            await assertCandidateReadAuthorityUnchanged('Index generation changed during hybrid retrieval.');
            const searchResults = fuseVectorCandidatesWithRrf({
                dense: denseCandidates.slice(0, resolvedRequest.topK),
                lexical: lexicalCandidates.slice(0, resolvedRequest.topK),
                k: VECTOR_CANDIDATE_RRF_K_V1,
                limit: resolvedRequest.topK,
            });
            diagnosticCandidateArmsConsumer?.({
                dense: denseCandidates.map((result) => toSemanticSearchResult(result, 'dense_similarity')),
                preciseLexical: lexicalCandidates.map((result) => toSemanticSearchResult(result, 'lexical_rank')),
                ...(lexicalFallback
                    ? {
                        fallbackLexical: lexicalFallback.map((result) => (
                            toSemanticSearchResult(result, 'lexical_rank')
                        )),
                    }
                    : {}),
            });
            candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
                dense: denseCandidates,
                lexical: lexicalCandidates,
                ...(lexicalFallback ? { lexicalFallback } : {}),
                result: searchResults,
                hybrid: true,
                maxEntries: candidateTraceMaxEntries,
                productCandidateLimit: resolvedRequest.topK,
                queryEmbeddingSha256: hashSemanticSearchQueryEmbedding(queryEmbedding.vector),
                lexicalRequests: [{
                    role: 'primary',
                    querySha256: hashSemanticSearchLexicalQuery(resolvedRequest.query),
                    matchMode: lexicalMatchMode,
                }, ...(lexicalFallback ? [{
                    role: 'fallback_or' as const,
                    querySha256: hashSemanticSearchLexicalQuery(lexicalFallbackQuery),
                    matchMode: 'any_terms' as const,
                    ...(lexicalFallbackTerms ? { terms: [...lexicalFallbackTerms] } : {}),
                }] : [])],
            }));

            console.log(`[Context] 🔍 Raw search results count: ${searchResults.length}`);

            // 4. Convert to semantic search result format
            const results = searchResults.map((result) => toSemanticSearchResult(result, 'rrf_fusion'));

            console.log(`[Context] ✅ Found ${results.length} relevant hybrid results`);
            if (results.length > 0) {
                console.log(`[Context] 🔍 Top result score: ${results[0].score}, path: ${results[0].relativePath}`);
            }

            return results;
        } else {
            // Regular semantic search
            // 1. Generate query vector
            this.assertEmbeddingIdentityCurrent();
            const queryEmbedding: EmbeddingVector = await this.embedding.embedQuery(resolvedRequest.query);
            this.assertEmbeddingIdentityCurrent();
            const denseThreshold = resolvedRequest.scorePolicy.kind === 'dense_similarity_min'
                ? resolvedRequest.scorePolicy.min
                : undefined;

            // 2. Search in vector database
            const searchResults = await this.vectorDatabase.retrieveDense(collectionName, {
                vector: queryEmbedding.vector,
                limit: candidateRetrievalLimit,
                minimumScore: denseThreshold,
                filter: resolvedRequest.filter,
            });
            const productResults = searchResults.slice(0, resolvedRequest.topK);
            diagnosticCandidateArmsConsumer?.({
                dense: searchResults.map((result) => toSemanticSearchResult(result, 'dense_similarity')),
            });
            candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
                dense: searchResults,
                result: productResults,
                hybrid: false,
                maxEntries: candidateTraceMaxEntries,
                productCandidateLimit: resolvedRequest.topK,
                queryEmbeddingSha256: hashSemanticSearchQueryEmbedding(queryEmbedding.vector),
                lexicalRequests: [],
            }));

            // 3. Convert to semantic search result format
            const results = productResults.map((result) => toSemanticSearchResult(result, 'dense_similarity'));

            console.log(`[Context] ✅ Found ${results.length} relevant results`);
            return results;
        }
    }

    private observeMutationGeneration(codebasePath: string): MutationGenerationObservation | null {
        if (!this.mutationGenerationObserver) return null;
        const observation = this.mutationGenerationObserver(this.canonicalizeCodebasePath(codebasePath));
        if (
            !Number.isSafeInteger(observation.generation)
            || observation.generation < 0
            || typeof observation.mutationActive !== 'boolean'
        ) {
            throw new Error('Mutation generation observer returned an invalid observation.');
        }
        return {
            generation: observation.generation,
            mutationActive: observation.mutationActive,
        };
    }

    private normalizeSemanticSearchRequest(
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filter?: VectorFilter
    ): SemanticSearchRequest {
        if (typeof requestOrCodebasePath === 'string') {
            return {
                codebasePath: requestOrCodebasePath,
                query: query ?? '',
                topK,
                filter,
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

    private resolveSemanticSearchRequest(request: SemanticSearchRequest): Omit<
        Required<SemanticSearchRequest>,
        'filter'
    > & { filter?: VectorFilter; retrievalMode: RetrievalMode; scorePolicy: ScorePolicy } {
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
            filter: request.filter === undefined
                ? undefined
                : validateVectorFilter(request.filter),
            scorePolicy
        };
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
        const boundCollection = this.publishedPolicyBindingsByCodebase.get(canonicalRoot)?.collectionName;
        const publishedPolicy = this.publishedResolvedPoliciesByCodebase.get(canonicalRoot);
        if (
            boundCollection
            && publishedPolicy
            && this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot) !== true
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
        return this.resolveIndexPolicyFromCurrentInputs(canonicalRoot, update, true);
    }

    async resolveIndexPolicyForReindex(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ResolvedIndexPolicy> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return this.resolveIndexPolicyFromCurrentInputs(canonicalRoot, update, false);
    }

    private async resolveIndexPolicyFromCurrentInputs(
        canonicalRoot: string,
        update: CustomIndexPolicyUpdate,
        inheritActiveCustomPolicy: boolean,
    ): Promise<ResolvedIndexPolicy> {
        const profile = this.loadIndexProfileForCodebase(canonicalRoot).profile;
        const customExtensions = update.customExtensions === undefined
            ? inheritActiveCustomPolicy
                ? [...(this.runtimeCustomExtensionsByCodebase.get(canonicalRoot) ?? [])]
                : []
            : normalizeSupportedExtensions(update.customExtensions);
        const customIgnorePatterns = update.customIgnorePatterns === undefined
            ? inheritActiveCustomPolicy
                ? [...(this.runtimeCustomIgnorePatternsByCodebase.get(canonicalRoot) ?? [])]
                : []
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
        binding: IndexPolicyBinding,
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

    public captureDurableIndexAuthority(codebasePath: string): DurableIndexAuthoritySnapshot {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const navigationRoot = resolveNavigationSidecarRoot(this.symbolRegistryStateRoot, canonicalRoot);
        const capture = (artifactPath: string): DurableIndexAuthorityArtifact | null => {
            try {
                const content = fs.readFileSync(artifactPath, 'utf8');
                return {
                    content,
                    digest: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        };
        return {
            canonicalRoot,
            policyDocument: capture(this.resolveCustomIndexPolicyPath(canonicalRoot)),
            navigationPointer: capture(path.join(navigationRoot, 'current.json')),
        };
    }

    private durableAuthorityRestoreRoot(): string {
        return path.join(this.indexPolicyStateRoot, 'restore-transactions');
    }

    private fsyncPath(targetPath: string): void {
        const fd = fs.openSync(targetPath, 'r');
        try {
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

    private writeDurableAuthorityRestoreTransaction(
        journalPath: string,
        transaction: DurableAuthorityRestoreTransaction,
    ): void {
        const temporaryJournalPath = `${journalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
        fs.writeFileSync(temporaryJournalPath, JSON.stringify(transaction), 'utf8');
        this.fsyncPath(temporaryJournalPath);
        fs.renameSync(temporaryJournalPath, journalPath);
        this.fsyncPath(path.dirname(journalPath));
    }

    private artifactMatchesPath(
        artifactPath: string,
        artifact: DurableIndexAuthorityArtifact | null,
    ): boolean {
        try {
            const content = fs.readFileSync(artifactPath, 'utf8');
            return Boolean(
                artifact
                && crypto.createHash('sha256').update(content, 'utf8').digest('hex') === artifact.digest
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return artifact === null;
            throw error;
        }
    }

    private completeDurableAuthorityRestoreTransaction(
        journalPath: string,
        transaction: DurableAuthorityRestoreTransaction,
    ): void {
        transaction.phase = 'swapping';
        this.writeDurableAuthorityRestoreTransaction(journalPath, transaction);
        for (let index = transaction.nextEntry; index < transaction.entries.length; index += 1) {
            const entry = transaction.entries[index];
            if (!entry) throw new Error('Durable authority restoration entry is missing.');
            const desired = entry.content === null
                ? null
                : { content: entry.content, digest: entry.digest! };
            if (!this.artifactMatchesPath(entry.targetPath, desired)) {
                if (!fs.existsSync(entry.displacedPath) && fs.existsSync(entry.targetPath)) {
                    fs.renameSync(entry.targetPath, entry.displacedPath);
                    this.fsyncPath(path.dirname(entry.targetPath));
                }
                if (entry.content === null) {
                    fs.rmSync(entry.targetPath, { force: true });
                } else if (fs.existsSync(entry.temporaryPath)) {
                    fs.renameSync(entry.temporaryPath, entry.targetPath);
                } else {
                    fs.writeFileSync(entry.targetPath, entry.content, 'utf8');
                }
                if (entry.content !== null) this.fsyncPath(entry.targetPath);
                this.fsyncPath(path.dirname(entry.targetPath));
            }
            if (!this.artifactMatchesPath(entry.targetPath, desired)) {
                throw new Error(`Durable authority restoration digest verification failed for '${entry.targetPath}'.`);
            }
            transaction.nextEntry = index + 1;
            this.writeDurableAuthorityRestoreTransaction(journalPath, transaction);
        }
        transaction.phase = 'committed';
        this.writeDurableAuthorityRestoreTransaction(journalPath, transaction);
        for (const entry of transaction.entries) {
            fs.rmSync(entry.temporaryPath, { force: true });
            fs.rmSync(entry.displacedPath, { force: true });
            this.fsyncPath(path.dirname(entry.targetPath));
        }
        fs.rmSync(journalPath, { force: true });
        this.fsyncPath(path.dirname(journalPath));
    }

    private parseDurableAuthorityRestoreTransaction(
        journalPath: string,
    ): DurableAuthorityRestoreTransaction {
        const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as DurableAuthorityRestoreTransaction;
        if (
            parsed?.schemaVersion !== 1
            || typeof parsed.id !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
            || typeof parsed.canonicalRoot !== 'string'
            || !['prepared', 'swapping', 'committed'].includes(parsed.phase)
            || !Number.isSafeInteger(parsed.nextEntry)
            || parsed.nextEntry < 0
            || !Array.isArray(parsed.entries)
            || parsed.entries.length !== 2
            || parsed.nextEntry > parsed.entries.length
        ) throw new Error(`Durable authority restoration journal '${journalPath}' is invalid.`);
        const canonicalRoot = this.canonicalizeCodebasePath(parsed.canonicalRoot);
        const expectedJournalPath = path.join(this.durableAuthorityRestoreRoot(), `${parsed.id}.json`);
        if (
            canonicalRoot !== parsed.canonicalRoot
            || path.resolve(journalPath) !== path.resolve(expectedJournalPath)
        ) throw new Error(`Durable authority restoration journal '${journalPath}' is invalid.`);
        const expectedTargets = [
            this.resolveCustomIndexPolicyPath(canonicalRoot),
            path.join(resolveNavigationSidecarRoot(this.symbolRegistryStateRoot, canonicalRoot), 'current.json'),
        ];
        for (const [index, entry] of parsed.entries.entries()) {
            const expectedTarget = expectedTargets[index];
            if (
                !entry
                || !expectedTarget
                || entry.targetPath !== expectedTarget
                || entry.temporaryPath !== `${expectedTarget}.restore-${parsed.id}`
                || entry.displacedPath !== `${expectedTarget}.rollback-${parsed.id}`
                || (entry.content !== null && typeof entry.content !== 'string')
                || (entry.digest !== null && !/^[a-f0-9]{64}$/.test(entry.digest))
                || (entry.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(entry.expectedDigest))
                || ((entry.content === null) !== (entry.digest === null))
                || (entry.content !== null
                    && crypto.createHash('sha256').update(entry.content, 'utf8').digest('hex') !== entry.digest)
            ) throw new Error(`Durable authority restoration journal '${journalPath}' has an invalid entry.`);
        }
        return parsed;
    }

    private recoverDurableIndexAuthorityTransactions(
        recoveryPublisher: DurableAuthorityRecoveryPublisher | undefined,
    ): void {
        const journalRoot = this.durableAuthorityRestoreRoot();
        if (!fs.existsSync(journalRoot)) return;
        const journalNames = fs.readdirSync(journalRoot)
            .filter((entry) => entry.endsWith('.json'))
            .sort();
        if (journalNames.length === 0) return;
        if (!recoveryPublisher) {
            throw new Error(
                `Durable authority recovery is required for ${journalNames.length} pending transaction(s), but no fenced recovery publisher is configured.`,
            );
        }
        for (const name of journalNames) {
            const journalPath = path.join(journalRoot, name);
            const transaction = this.parseDurableAuthorityRestoreTransaction(journalPath);
            let publicationCount = 0;
            const recovered = recoveryPublisher(
                transaction.canonicalRoot,
                transaction.mutationOwner,
                () => {
                    publicationCount += 1;
                    if (publicationCount > 1) {
                        throw new Error(`Durable authority recovery '${transaction.id}' published more than once.`);
                    }
                    this.withIndexPolicyMutationLock(transaction.canonicalRoot, () => {
                        if (transaction.phase === 'prepared') {
                            for (const entry of transaction.entries) {
                                const expected = entry.expectedDigest === null
                                    ? null
                                    : { content: '', digest: entry.expectedDigest };
                                if (!this.artifactMatchesPath(entry.targetPath, expected)) {
                                    throw new Error(
                                        `Prepared durable authority restoration '${transaction.id}' no longer owns current authority.`,
                                    );
                                }
                            }
                        }
                        this.completeDurableAuthorityRestoreTransaction(journalPath, transaction);
                    });
                },
            );
            if ((recovered && publicationCount !== 1) || (!recovered && publicationCount !== 0)) {
                throw new Error(`Durable authority recovery publisher violated the publication contract for '${transaction.id}'.`);
            }
            if (!recovered) {
                throw new Error(
                    `Durable authority recovery '${transaction.id}' could not acquire the mutation fence.`,
                );
            }
        }
    }

    public async restoreDurableIndexAuthority(
        snapshot: DurableIndexAuthoritySnapshot,
        publishMutation: (publish: () => void) => void,
        expectedCurrent: DurableIndexAuthoritySnapshot,
        mutationOwner?: DurableAuthorityMutationOwner,
    ): Promise<DurableIndexAuthorityRestoreResult> {
        const canonicalRoot = this.canonicalizeCodebasePath(snapshot.canonicalRoot);
        if (canonicalRoot !== snapshot.canonicalRoot) {
            throw new Error('Durable index authority snapshot root is not canonical.');
        }
        const validateArtifact = (
            name: string,
            artifact: DurableIndexAuthorityArtifact | null,
        ): void => {
            if (!artifact) return;
            if (!/^[a-f0-9]{64}$/.test(artifact.digest)) {
                throw new Error(`Captured ${name} digest is invalid.`);
            }
            const digest = crypto.createHash('sha256').update(artifact.content, 'utf8').digest('hex');
            if (digest !== artifact.digest) {
                throw new Error(`Captured ${name} bytes do not match their digest.`);
            }
        };
        validateArtifact('index policy', snapshot.policyDocument);
        validateArtifact('navigation pointer', snapshot.navigationPointer);
        if (expectedCurrent.canonicalRoot !== canonicalRoot) {
            throw new Error('Expected durable index authority root does not match the restoration root.');
        }
        validateArtifact('expected index policy', expectedCurrent.policyDocument);
        validateArtifact('expected navigation pointer', expectedCurrent.navigationPointer);

        const policyPath = this.resolveCustomIndexPolicyPath(canonicalRoot);
        const navigationRoot = resolveNavigationSidecarRoot(this.symbolRegistryStateRoot, canonicalRoot);
        const pointerPath = path.join(navigationRoot, 'current.json');
        fs.mkdirSync(path.dirname(policyPath), { recursive: true });
        fs.mkdirSync(navigationRoot, { recursive: true });
        const id = crypto.randomUUID();
        const entries: DurableAuthorityRestoreEntry[] = [
            { targetPath: policyPath, artifact: snapshot.policyDocument, expected: expectedCurrent.policyDocument },
            { targetPath: pointerPath, artifact: snapshot.navigationPointer, expected: expectedCurrent.navigationPointer },
        ].map((entry) => ({
            targetPath: entry.targetPath,
            temporaryPath: `${entry.targetPath}.restore-${id}`,
            displacedPath: `${entry.targetPath}.rollback-${id}`,
            content: entry.artifact?.content ?? null,
            digest: entry.artifact?.digest ?? null,
            expectedDigest: entry.expected?.digest ?? null,
        }));
        for (const entry of entries) {
            if (entry.content !== null) {
                fs.writeFileSync(entry.temporaryPath, entry.content, 'utf8');
                this.fsyncPath(entry.temporaryPath);
            }
        }
        const journalRoot = this.durableAuthorityRestoreRoot();
        fs.mkdirSync(journalRoot, { recursive: true });
        const journalPath = path.join(journalRoot, `${id}.json`);
        const transaction: DurableAuthorityRestoreTransaction = {
            schemaVersion: 1,
            id,
            canonicalRoot,
            phase: 'prepared',
            nextEntry: 0,
            ...(mutationOwner ? { mutationOwner: { ...mutationOwner } } : {}),
            entries,
        };
        this.writeDurableAuthorityRestoreTransaction(journalPath, transaction);

        let publicationCount = 0;
        let committed = false;
        try {
            publishMutation(() => {
                publicationCount += 1;
                if (publicationCount > 1) {
                    throw new Error('Durable index authority restoration invoked publish more than once.');
                }
                this.withIndexPolicyMutationLock(canonicalRoot, () => {
                    const current = this.captureDurableIndexAuthority(canonicalRoot);
                    if (
                        !this.artifactMatchesPath(policyPath, expectedCurrent.policyDocument)
                        || !this.artifactMatchesPath(pointerPath, expectedCurrent.navigationPointer)
                        || current.canonicalRoot !== expectedCurrent.canonicalRoot
                    ) {
                        throw new Error('Durable index authority changed after rollback capture; refusing stale restoration.');
                    }
                    this.completeDurableAuthorityRestoreTransaction(journalPath, transaction);
                    committed = true;
                });
            });
            if (publicationCount !== 1 || !committed) {
                throw new Error('Durable index authority restoration returned without publishing.');
            }
        } catch (error) {
            if (transaction.phase === 'prepared') {
                for (const entry of entries) fs.rmSync(entry.temporaryPath, { force: true });
                fs.rmSync(journalPath, { force: true });
                this.fsyncPath(journalRoot);
            }
            throw error;
        }

        this.clearResolvedIndexPolicyRuntime(canonicalRoot);
        this.policyFileTokensByCodebase.delete(canonicalRoot);
        const sqlitePath = resolveNavigationSqlitePath(this.symbolRegistryStateRoot, canonicalRoot);
        try {
            this.refreshRuntimePolicyAuthority(canonicalRoot);
        } catch (error) {
            if (
                error instanceof IndexFormatRequiresReindexError
                || error instanceof UnsupportedIndexAuthorityError
            ) {
                this.clearResolvedIndexPolicyRuntime(canonicalRoot);
                this.policyFileTokensByCodebase.delete(canonicalRoot);
                fs.rmSync(sqlitePath, { force: true });
                return error instanceof UnsupportedIndexAuthorityError
                    ? { status: 'restored_unsupported_authority' }
                    : { status: 'restored_requires_reindex' };
            }
            throw error;
        }
        fs.rmSync(sqlitePath, { force: true });
        try {
            await resolveCurrentNavigationGeneration(this.symbolRegistryStateRoot, canonicalRoot);
        } catch (error) {
            if (
                error instanceof RetiredNavigationPointerError
                || error instanceof UnsupportedNavigationPointerError
            ) {
                this.clearResolvedIndexPolicyRuntime(canonicalRoot);
                this.policyFileTokensByCodebase.delete(canonicalRoot);
                return error instanceof UnsupportedNavigationPointerError
                    ? { status: 'restored_unsupported_authority' }
                    : { status: 'restored_requires_reindex' };
            }
            throw error;
        }
        try {
            await importNavigationToSqlite({
                stateRoot: this.symbolRegistryStateRoot,
                normalizedRootPath: canonicalRoot,
            });
        } catch (error) {
            fs.rmSync(sqlitePath, { force: true });
            console.warn(
                `[Context] ⚠️  Durable authority was restored for '${canonicalRoot}', but its derived navigation sqlite cache could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return { status: 'restored_current' };
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
        binding: IndexPolicyBinding,
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
            navigation: { ...binding.navigation },
            ...(binding.publication ? { publication: structuredClone(binding.publication) } : {}),
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
    ): Promise<void> {
        // Identity drift must fail before a valid published collection is
        // dropped or a staged generation is otherwise mutated.
        const embeddingIdentity = this.assertEmbeddingIdentityCurrent();
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

        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const expectedCollectionName = this.getWriteCollectionName(canonicalRoot);
        if (
            receipt.canonicalRoot !== canonicalRoot
            || receipt.collectionName !== expectedCollectionName
            || receipt.generation !== expectedBinding.generation
            || receipt.operationId !== expectedBinding.operationId
        ) {
            throw new Error('Prepared index collection receipt does not match the current mutation and staged collection.');
        }

        assertMutationCurrent?.();
        if (!await this.vectorDatabase.hasCollection(receipt.collectionName)) {
            throw new Error(`Prepared staged collection '${receipt.collectionName}' no longer exists.`);
        }
        assertMutationCurrent?.();
    }

    private async finalizePreparedCollection(
        codebasePath: string,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        if (!this.getIsHybrid() || !this.vectorDatabase.finalizeCollectionForSearch) {
            return;
        }
        // Authority publication must remain after this boundary. Before finalization the
        // collection accepts writes but is intentionally neither indexed nor searchable.
        assertMutationCurrent?.();
        await this.vectorDatabase.finalizeCollectionForSearch(this.getWriteCollectionName(codebasePath));
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

    private async readIndexableFileObservationInsideRoot(
        filePath: string,
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<{ content: string; sourceHash: string } | null> {
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

            const sourceBytes = await readFileHandleExactly(handle, before.size);
            const content = sourceBytes.toString('utf8');
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
            return {
                content,
                sourceHash: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
            };
        } finally {
            await handle.close().catch(() => undefined);
        }
    }

    private async readIndexableFileInsideRoot(
        filePath: string,
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<string | null> {
        const observation = await this.readIndexableFileObservationInsideRoot(
            filePath,
            codebasePath,
            indexPolicy,
        );
        return observation?.content ?? null;
    }

    private async analyzeIndexedFile(
        filePath: string,
        codebasePath: string,
        indexPolicy?: ResolvedIndexPolicy,
    ): Promise<AnalyzedIndexedFile | null> {
        const sourceObservation = await this.readIndexableFileObservationInsideRoot(
            filePath,
            codebasePath,
            indexPolicy,
        );
        if (sourceObservation === null) return null;

        const relativePath = this.normalizeRelativePathForCodebase(codebasePath, filePath);
        if (!relativePath) {
            throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
        }
        const source = sourceObservation.content;
        const language = this.getLanguageFromFilePath(filePath);
        const analysis = await this.languageAnalyzer.analyze({ content: source, language, relativePath });

        return {
            relativePath,
            source,
            sourceHash: sourceObservation.sourceHash,
            contentHash: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
            language,
            chunks: chunksWithTrustedRelativePath(analysis.chunks, relativePath),
            extractedSymbols: analysis.symbols,
            moduleBindings: analysis.moduleBindings,
            callSites: analysis.callSites,
        };
    }

    private buildAnalyzedFileSymbolFacts(analyzed: AnalyzedIndexedFile): AnalyzedFileSymbolFacts {
        const symbolRecords = buildSymbolRecordsForFile({
            relativePath: analyzed.relativePath,
            language: analyzed.language,
            content: analyzed.source,
            fileHash: analyzed.contentHash,
            extractorVersion: this.getSymbolExtractorVersion(),
            extractedSymbols: analyzed.extractedSymbols,
            chunks: analyzed.chunks,
        });
        return {
            symbolRecords,
            manifestFile: {
                path: analyzed.relativePath,
                hash: analyzed.contentHash,
                language: analyzed.language,
                symbolCount: symbolRecords.length,
            },
            relationshipEvidence: {
                moduleBindings: analyzed.moduleBindings,
                callSites: analyzed.callSites,
            },
        };
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
        indexedFileHashes: ReadonlyMap<string, string>;
        performance: IndexingPipelineMetrics;
    }> {
        const isHybrid = this.getIsHybrid();
        const batchPolicy = this.embedding.getBatchPolicy?.() ?? null;
        const EMBEDDING_BATCH_SIZE = resolveEmbeddingBatchSize(
            envManager.get('EMBEDDING_BATCH_SIZE'),
            batchPolicy?.preferredMaxItems ?? DEFAULT_EMBEDDING_BATCH_SIZE,
            batchPolicy?.hardMaxItems ?? MAX_EMBEDDING_BATCH_SIZE,
        );
        const targetEstimatedTokens = batchPolicy?.targetEstimatedTokens;
        const hardTokenLimit = batchPolicy?.hardTokenLimit;
        const CHUNK_LIMIT = 450000;
        console.log(
            `[Context] 🔧 Embedding batch policy: max_items=${EMBEDDING_BATCH_SIZE}`
            + `${targetEstimatedTokens ? `, target_estimated_tokens=${targetEstimatedTokens}` : ''}`,
        );

        let chunkBuffer: PendingIndexedChunk[] = [];
        let chunkBufferEstimatedTokens = 0;
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];
        const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();
        const indexedFileHashes = new Map<string, string>();
        const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);
        const performance: IndexingPipelineMetrics = {
            analysisMs: 0,
            embeddedInputBytes: 0,
            logicalEmbeddingRequests: 0,
            logicalEmbeddingDurationMs: 0,
            logicalVectorWriteRequests: 0,
            logicalVectorWriteDurationMs: 0,
        };
        const flushChunkBuffer = async (failureContext: string): Promise<void> => {
            if (chunkBuffer.length === 0) return;
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            try {
                await this.processChunkBuffer(
                    chunkBuffer,
                    collectionName,
                    assertMutationCurrent,
                    performance,
                );
            } catch (error) {
                console.error(`[Context] ❌ Failed to process ${failureContext} for ${searchType}:`, error);
                if (error instanceof Error) {
                    console.error('[Context] Stack trace:', error.stack);
                }
                throw new Error(`Failed to persist ${failureContext} for ${searchType}: ${describeError(error)}`);
            } finally {
                chunkBuffer = [];
                chunkBufferEstimatedTokens = 0;
            }
        };

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];

            try {
                const analysisStartedAt = Date.now();
                const analyzed = await this.analyzeIndexedFile(filePath, codebasePath, indexPolicy);
                if (analyzed === null) continue;
                const symbolFacts = this.buildAnalyzedFileSymbolFacts(analyzed);
                const chunks = chunksWithResolvedOwners(analyzed.chunks, symbolFacts.symbolRecords);
                const { relativePath } = analyzed;
                analysisByFile.set(relativePath, symbolFacts.relationshipEvidence);
                indexedFileHashes.set(relativePath, analyzed.sourceHash);
                symbolRecords.push(...symbolFacts.symbolRecords);
                symbolManifestFiles.push(symbolFacts.manifestFile);
                performance.analysisMs += Date.now() - analysisStartedAt;

                // Log files with many chunks or large content
                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(analyzed.source.length / 1024)}KB)`);
                } else if (analyzed.source.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(analyzed.source.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                let fileFullyIncluded = true;
                // Add chunks to buffer
                for (let fileChunkIndex = 0; fileChunkIndex < chunks.length; fileChunkIndex++) {
                    const chunk = chunks[fileChunkIndex];
                    const projections = buildSearchProjections({ chunk, relativePath });
                    const chunkEstimatedTokens = estimateEmbeddingTokens(projections.embeddingText);
                    if (hardTokenLimit !== undefined && chunkEstimatedTokens > hardTokenLimit) {
                        throw new Error(
                            `Embedding projection for '${relativePath}' chunk ${fileChunkIndex} is estimated at ${chunkEstimatedTokens} tokens, exceeding the provider hard limit of ${hardTokenLimit}.`,
                        );
                    }
                    if (
                        chunkBuffer.length > 0
                        && targetEstimatedTokens !== undefined
                        && chunkBufferEstimatedTokens + chunkEstimatedTokens > targetEstimatedTokens
                    ) {
                        await flushChunkBuffer(`chunk batch while indexing ${filePath}`);
                    }
                    chunkBuffer.push({ chunk, codebasePath, relativePath, fileChunkIndex, projections });
                    chunkBufferEstimatedTokens += chunkEstimatedTokens;
                    totalChunks++;

                    // Process batch when buffer reaches EMBEDDING_BATCH_SIZE
                    if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE) {
                        await flushChunkBuffer(`chunk batch while indexing ${filePath}`);
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
            await flushChunkBuffer('final chunk batch');
        }

        if (!limitReached && indexedFileHashes.size !== processedFiles) {
            throw new Error(
                `Completed full index source coverage is inconsistent: ${processedFiles} processed files but ${indexedFileHashes.size} source identities.`,
            );
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed',
            symbolRecords,
            symbolManifestFiles,
            analysisByFile,
            indexedFileHashes,
            performance,
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
            const analyzed = await this.analyzeIndexedFile(filePath, codebasePath, indexPolicy);
            if (analyzed === null) {
                throw new Error(`Indexed source no longer satisfies the active policy: ${filePath}`);
            }
            const symbolFacts = this.buildAnalyzedFileSymbolFacts(analyzed);
            const chunks = chunksWithResolvedOwners(analyzed.chunks, symbolFacts.symbolRecords);
            const { relativePath } = analyzed;
            analysisByFile.set(relativePath, symbolFacts.relationshipEvidence);
            for (let index = 0; index < chunks.length; index++) {
                const chunk = chunks[index];
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
            symbolRecords.push(...symbolFacts.symbolRecords);
            symbolManifestFiles.push(symbolFacts.manifestFile);
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
            indexPolicyHash?: string;
            runId?: string;
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
            undefined,
            options.indexPolicyHash,
            options.runId,
        );
    }

    private async verifyPreparedSyncPublication(
        codebasePath: string,
        collectionName: string,
        preparedFileHashes: ReadonlyMap<string, string>,
        expectedTotalChunks: number,
        navigationGenerationId?: string,
    ): Promise<void> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const registryState = await readSymbolRegistrySidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: canonicalRoot,
            ...(navigationGenerationId ? { generationId: navigationGenerationId } : {}),
        });
        if (registryState.status !== 'ok') {
            throw new Error(`Cannot publish incremental completion proof: navigation registry is ${registryState.status}.`);
        }
        const relationshipState = await readRelationshipSidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: canonicalRoot,
            expectedSymbolRegistryManifestHash: registryState.manifestHash,
            ...(navigationGenerationId ? { generationId: navigationGenerationId } : {}),
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
            undefined,
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
            && indexFingerprintsEqual(snapshotEvidence.fingerprint, currentFingerprint);
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

        try {
            await resolveCurrentNavigationGeneration(this.symbolRegistryStateRoot, canonicalPath);
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
            if (!indexFingerprintsEqual(marker.fingerprint, currentFingerprint)) {
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
        try {
            this.refreshRuntimePolicyAuthority(canonicalPath);
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
            const rows = await this.vectorDatabase.queryDocuments(selectedCollection, {
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
        const remotePayloadRows = await this.vectorDatabase.queryDocuments(selectedCollection, {
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
    ): Promise<StagedNavigationSidecarGeneration | undefined> {
        const replacedPaths = new Set<string>([
            ...changedRelativePaths.map((filePath) => filePath.replace(/\\/g, '/').replace(/^\/+/, '')),
            ...rebuiltManifestFiles.map((file) => file.path),
        ]);
        const retainedAnalysisByFile = new Map<string, RelationshipAnalysisEvidence>();
        const existingRelationships = await readRelationshipSidecar({
            stateRoot: this.symbolRegistryStateRoot,
            normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
            expectedSymbolRegistryManifestHash: computeSymbolRegistryManifestHash(existingRegistry.manifest),
            ...(existingGenerationId ? { generationId: existingGenerationId } : {}),
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
            return undefined;
        }

        const mergedSymbolRecords = [
            ...existingRegistry.symbols.filter((symbol) => !replacedPaths.has(symbol.file)),
            ...rebuiltSymbolRecords,
        ];

        if (deferPublication && existingGenerationId) {
            if (existingRelationships.status !== 'ok') {
                throw new Error('Atomic navigation delta requires compatible per-file relationship contributions.');
            }
            const registry = buildSymbolRegistry({
                manifest: {
                    schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                    normalizedRootPath: this.canonicalizeCodebasePath(codebasePath),
                    rootFingerprint: this.buildRootFingerprint(codebasePath),
                    indexPolicyHash: existingRegistry.manifest.indexPolicyHash,
                    languageRouterVersion: this.getLanguageRouterVersion(),
                    extractorVersion: this.getSymbolExtractorVersion(),
                    relationshipVersion: this.getRelationshipVersion(),
                    builtAt: new Date().toISOString(),
                    files: mergedManifestFiles,
                },
                symbols: mergedSymbolRecords,
            });
            const relationshipDelta = buildRelationshipDelta({
                previousRegistry: existingRegistry,
                registry,
                existingRecords: existingRelationships.records,
                analysisByFile: retainedAnalysisByFile,
                changedFiles: replacedPaths,
            });
            assertMutationCurrent?.();
            const candidate = await stageNavigationSidecarGeneration({
                stateRoot: this.symbolRegistryStateRoot,
                registry,
                records: relationshipDelta.records,
                analysisByFile: retainedAnalysisByFile,
                deltaReuse: {
                    baseGenerationId: existingGenerationId,
                    symbolFilesToRewrite: [...replacedPaths],
                    relationshipFilesToRewrite: relationshipDelta.affectedFiles,
                },
            });
            console.log(
                `[Context] 🧭 Staged navigation delta '${candidate.generationId}' affecting `
                + `${relationshipDelta.affectedFiles.length} relationship owner(s); `
                + `shared ${candidate.physical.sharedFiles} file(s) and wrote `
                + `${candidate.physical.physicallyWrittenBytes} physical byte(s).`,
            );
            return candidate;
        }

        return this.writeSymbolRegistryForCompletedIndex(
            codebasePath,
            mergedSymbolRecords,
            mergedManifestFiles,
            assertMutationCurrent,
            retainedAnalysisByFile,
            publishMutation,
            deferPublication,
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

    /**
 * Process accumulated chunk buffer
 */
    private async processChunkBuffer(
        chunkBuffer: PendingIndexedChunk[],
        collectionName: string,
        assertMutationCurrent?: () => void,
        performance?: IndexingPipelineMetrics,
    ): Promise<void> {
        if (chunkBuffer.length === 0) return;

        // Extract chunks and ensure they all have the same codebasePath
        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunkBuffer.reduce(
            (sum, { projections }) => sum + estimateEmbeddingTokens(projections.embeddingText),
            0,
        );

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        await this.processChunkBatch(
            chunkBuffer,
            codebasePath,
            collectionName,
            assertMutationCurrent,
            performance,
        );
    }

    /**
     * Process a batch of chunks
     */
    private async processChunkBatch(
        chunkEntries: ProjectedChunkEntry[],
        codebasePath: string,
        collectionName: string,
        assertMutationCurrent?: () => void,
        performance?: IndexingPipelineMetrics,
    ): Promise<void> {
        const indexedAt = new Date().toISOString();
        const chunks = chunkEntries.map(({ chunk }) => chunk);
        const projections = chunkEntries.map(({ projections: entryProjections }) => entryProjections);

        // Generate embedding vectors
        const embeddingTexts = projections.map(({ embeddingText }) => embeddingText);
        const embeddingIdentity = this.assertEmbeddingIdentityCurrent();
        const batchPolicy = this.embedding.getBatchPolicy?.() ?? null;
        if (batchPolicy && chunkEntries.length > batchPolicy.hardMaxItems) {
            throw new Error(
                `Embedding batch contains ${chunkEntries.length} items, exceeding the provider hard limit of ${batchPolicy.hardMaxItems}.`,
            );
        }
        const hardTokenLimit = batchPolicy?.hardTokenLimit;
        if (hardTokenLimit !== undefined) {
            const tokenEstimates = embeddingTexts.map(estimateEmbeddingTokens);
            const oversizedIndex = tokenEstimates.findIndex((estimatedTokens) => (
                estimatedTokens > hardTokenLimit
            ));
            if (oversizedIndex >= 0) {
                const entry = chunkEntries[oversizedIndex];
                throw new Error(
                    `Embedding projection for '${entry.relativePath}' chunk ${entry.fileChunkIndex} is estimated at ${tokenEstimates[oversizedIndex]} tokens, exceeding the provider hard limit of ${hardTokenLimit}.`,
                );
            }
            const batchEstimatedTokens = tokenEstimates.reduce((total, estimate) => total + estimate, 0);
            if (batchEstimatedTokens > hardTokenLimit) {
                throw new Error(
                    `Embedding batch is estimated at ${batchEstimatedTokens} tokens, exceeding the provider hard limit of ${hardTokenLimit}.`,
                );
            }
        }
        if (performance) {
            performance.embeddedInputBytes += embeddingTexts.reduce(
                (total, content) => total + Buffer.byteLength(content, 'utf8'),
                0,
            );
            performance.logicalEmbeddingRequests += 1;
        }
        const embeddingStartedAt = Date.now();
        let embeddings: EmbeddingVector[];
        try {
            embeddings = await this.embedding.embedDocuments(embeddingTexts);
        } finally {
            if (performance) {
                performance.logicalEmbeddingDurationMs += Date.now() - embeddingStartedAt;
            }
        }
        this.assertEmbeddingIdentityCurrent();
        const expectedDimension = embeddingIdentity.dimension;
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
        const persistDocuments = async (documents: IndexedVectorDocument[]): Promise<void> => {
            assertMutationCurrent?.();
            if (performance) performance.logicalVectorWriteRequests += 1;
            const writeStartedAt = Date.now();
            try {
                await this.vectorDatabase.writeDocuments(collectionName, documents);
            } finally {
                if (performance) {
                    performance.logicalVectorWriteDurationMs += Date.now() - writeStartedAt;
                }
            }
        };

        const documents: IndexedVectorDocument[] = chunks.map((chunk, index) => {
            const relativePath = chunkEntries[index].relativePath;
            const fileExtension = path.extname(relativePath);
            const { filePath: omittedFilePath, startLine: omittedStartLine, endLine: omittedEndLine, ...restMetadata } = chunk.metadata;
            void omittedFilePath;
            void omittedStartLine;
            void omittedEndLine;

            return {
                document: {
                    id: documentIds[index],
                    content: chunk.content,
                    vector: embeddings[index].vector,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: chunkEntries[index].fileChunkIndex,
                        indexedAt,
                    },
                },
                projections: projections[index],
            };
        });

        await persistDocuments(documents);
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
        return this.resolveFilesystemObservationToken(this.resolveCustomIndexPolicyPath(canonicalRoot));
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
        const pointerToken = requireCurrentPointer
            ? this.resolveFilesystemObservationToken(pointerPath)
            : null;
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
            ...(pointerToken ? { pointerToken } : {}),
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

    private resolveVerifiedIndexPolicyDocumentDigest(policyPath: string): string {
        const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as unknown;
        const canonicalRoot = this.canonicalizeCodebasePath(
            typeof (parsed as { canonicalRoot?: unknown })?.canonicalRoot === 'string'
                ? (parsed as { canonicalRoot: string }).canonicalRoot
                : '',
        );
        const inspected = inspectIndexPolicyDocument(parsed, canonicalRoot);
        if (inspected.status === 'requires_reindex') {
            throw new IndexFormatRequiresReindexError(inspected.reason);
        }
        if (inspected.status === 'unsupported') {
            throw new UnsupportedIndexAuthorityError(inspected.reason);
        }
        if (inspected.status !== 'current') {
            throw new Error('Index policy document digest is invalid.');
        }
        return inspected.value.documentDigest;
    }

    private clearResolvedIndexPolicyRuntime(canonicalRoot: string): void {
        this.runtimeCustomExtensionsByCodebase.delete(canonicalRoot);
        this.runtimeCustomIgnorePatternsByCodebase.delete(canonicalRoot);
        this.publishedPolicyBindingsByCodebase.delete(canonicalRoot);
        this.publishedResolvedPoliciesByCodebase.delete(canonicalRoot);
        this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
        this.policyDocumentDigestsByCodebase.delete(canonicalRoot);
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
        const document = fs.readFileSync(this.resolveCustomIndexPolicyPath(canonicalRoot), 'utf8');
        try {
            const parsed = JSON.parse(document) as unknown;
            const inspected = inspectIndexPolicyDocument(parsed, canonicalRoot);
            if (inspected.status === 'requires_reindex') {
                throw new IndexFormatRequiresReindexError(inspected.reason);
            }
            if (inspected.status === 'unsupported') {
                throw new UnsupportedIndexAuthorityError(inspected.reason);
            }
            if (inspected.status !== 'current') {
                throw new Error(inspected.reason);
            }
            const payload = inspected.value;
            const expectedPolicyHash = crypto.createHash('sha256').update(JSON.stringify({
                profile: payload.profile,
                extensions: payload.supportedExtensions,
                ignorePatterns: payload.effectiveIgnorePatterns,
            }), 'utf8').digest('hex');
            if (payload.policyHash !== expectedPolicyHash) {
                throw new Error('Custom index policy hash does not match its effective inputs.');
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
                navigation: { ...payload.navigation },
                ...(payload.schemaVersion === 'satori_index_policy_v4'
                    ? { publication: structuredClone(payload.publication) }
                    : {}),
            });
            this.loadedCustomPolicyRoots.add(canonicalRoot);
            this.policyFileTokensByCodebase.set(canonicalRoot, currentToken);
            this.policyDocumentDigestsByCodebase.set(canonicalRoot, payload.documentDigest);
        } catch (error) {
            this.loadedCustomPolicyRoots.delete(canonicalRoot);
            this.policyFileTokensByCodebase.delete(canonicalRoot);
            this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
            this.policyDocumentDigestsByCodebase.delete(canonicalRoot);
            if (
                error instanceof IndexFormatRequiresReindexError
                || error instanceof UnsupportedIndexAuthorityError
            ) throw error;
            throw new IndexPolicyAuthorityError(
                `Malformed custom index policy for '${canonicalRoot}': ${error instanceof Error ? error.message : String(error)}`,
                error,
            );
        }
    }

    private persistCustomIndexPolicy(
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyBinding,
        publishMutation?: (publish: () => void) => void,
        activate?: () => void,
    ): IndexPolicyPublicationReceipt {
        const canonicalRoot = policy.canonicalRoot;
        if (!binding.collectionName.trim()) {
            throw new Error('Index policy collection binding must be nonempty.');
        }
        if (binding.navigation.status === 'sealed') {
            if (!/^[a-zA-Z0-9_-]+$/.test(binding.navigation.generationId)) {
                throw new Error('Index policy navigation generation binding is invalid.');
            }
            if (!/^[a-f0-9]{64}$/.test(binding.navigation.sealHash)) {
                throw new Error('Index policy navigation seal binding is invalid.');
            }
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
            documentDigest: this.policyDocumentDigestsByCodebase.get(canonicalRoot),
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
                this.publishedPolicyBindingsByCodebase.set(canonicalRoot, {
                    ...previousRuntimeState.binding,
                    navigation: { ...previousRuntimeState.binding.navigation },
                    ...(previousRuntimeState.binding.publication
                        ? { publication: structuredClone(previousRuntimeState.binding.publication) }
                        : {}),
                });
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
            if (previousRuntimeState.documentDigest) {
                this.policyDocumentDigestsByCodebase.set(canonicalRoot, previousRuntimeState.documentDigest);
            } else {
                this.policyDocumentDigestsByCodebase.delete(canonicalRoot);
            }
        };
        const policyBase = {
            canonicalRoot,
            customExtensions: policy.customExtensions,
            customIgnorePatterns: policy.customIgnorePatterns,
            fileBasedIgnorePatterns: policy.fileBasedIgnorePatterns,
            profile: policy.profile,
            supportedExtensions: policy.supportedExtensions,
            effectiveIgnorePatterns: policy.effectiveIgnorePatterns,
            policyHash: policy.policyHash,
            collectionName: binding.collectionName,
            navigation: binding.navigation,
        };
        const policyDocument = binding.publication
            ? buildCanonicalIndexPolicyDocument({
                ...policyBase,
                schemaVersion: 'satori_index_policy_v4',
                publication: binding.publication,
            })
            : buildCanonicalIndexPolicyDocument({
                ...policyBase,
                schemaVersion: 'satori_index_policy_v3',
            });
        const documentDigest = policyDocument.documentDigest;
        const receipt: IndexPolicyPublicationReceipt = {
            status: 'committed',
            operation: 'publish',
            canonicalRoot,
            documentDigest,
            policyHash: policy.policyHash,
            collectionName: binding.collectionName,
            navigation: { ...binding.navigation },
            ...(binding.publication ? { publication: structuredClone(binding.publication) } : {}),
        };
        fs.writeFileSync(temporaryPath, JSON.stringify(policyDocument, null, 2));
        this.fsyncPath(temporaryPath);
        let publicationCount = 0;
        let activationVisible = false;
        try {
            const publish = () => {
                publicationCount += 1;
                if (publicationCount > 1) {
                    throw new Error('Index policy publication invoked more than once.');
                }
                try {
                    this.withIndexPolicyMutationLock(canonicalRoot, () => {
                        this.recoverIndexPolicyTombstonesWhileLocked(targetPath);
                        fs.renameSync(temporaryPath, targetPath);
                        activationVisible = true;
                        activate?.();
                        this.fsyncPath(path.dirname(targetPath));
                        this.policyFileTokensByCodebase.set(
                            canonicalRoot,
                            this.resolveCustomIndexPolicyFileToken(canonicalRoot),
                        );
                        this.policyDocumentDigestsByCodebase.set(canonicalRoot, documentDigest);
                    });
                } catch (error) {
                    if (!activationVisible) restoreRuntimeState();
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
            if (publicationCount > 0 && !activationVisible) {
                restoreRuntimeState();
            }
            if (activationVisible) {
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
