import type {
    RepositoryOntologyTag,
    SymbolKind,
    SymbolSpan,
} from "@zokizuan/satori-core";
import type {
    FreshnessDecision,
    PreparedReadObservationUnavailableReason,
    PreparedReadWatcherDiagnostics,
} from "./sync.js";
import { SearchGroupBy, SearchNoiseCategory, SearchRankingMode, SearchResultMode, SearchScope } from "./search-constants.js";
import { FingerprintSource, IndexFingerprint } from "../config.js";
import type { SearchRouteContract } from "./search-lexical-scoring.js";
import type { EntrypointOwnerEvidenceResolution } from "./entrypoint-owner-evidence.js";
import type { InboundCoverageEvidence } from "./relationship-backed-call-graph.js";
import type { RerankBudgetReason } from "./search-rerank-policy.js";
import type { SearchAnswerFocus, SearchCandidateRole } from "./search-rerank-context.js";
import type {
    SearchRerankProjectionFailureReason,
    SearchRerankStructuralContextStatus,
} from "./search-rerank-projection-result.js";
import type { SemanticPassFailureDiagnostic } from "./backend-diagnostics.js";

export type StalenessBucket = "fresh" | "aging" | "stale" | "unknown";

export const SEARCH_RESPONSE_FORMAT_VERSION = 3 as const;

export interface SearchSpan {
    startLine: number;
    endLine: number;
}

export type NavigationToolHints = Record<string, unknown>;

export interface CallGraphSymbolRef {
    file: string;
    symbolId: string;
    symbolLabel?: string;
    span?: SearchSpan;
}

export type NavigationRegistryUnavailableReason =
    | "missing_symbol_registry"
    | "missing_relationship_sidecar"
    | "incompatible_symbol_registry"
    | "incompatible_relationship_sidecar";

export type NavigationExactSymbolUnavailableReason =
    | "missing_symbol"
    | "stale_symbol_ref";

export type NavigationUnsupportedReason = "unsupported_language";

export type NavigationUnavailableReason =
    | NavigationExactSymbolUnavailableReason
    | NavigationUnsupportedReason
    | NavigationRegistryUnavailableReason;

export type SearchNavigationUnavailableReasonV2 =
    | NavigationUnavailableReason
    | "partial_index_navigation_unavailable";

export type CallGraphHint =
    | {
        supported: true;
        symbolRef: CallGraphSymbolRef;
        validated: true;
        validatedAt: string;
        sidecarBuiltAt: string;
    }
    | {
        supported: false;
        reason: NavigationUnavailableReason;
    };

export type SearchActionTool = "read_file" | "file_outline" | "call_graph" | "search_codebase" | "manage_index";

export interface SearchRecommendedNextAction {
    resultIndex?: number;
    tool: SearchActionTool;
    args: Record<string, unknown>;
    reason: string;
}

export type SearchCapabilityConfidence = "high" | "medium" | "low" | "unavailable";

export interface SearchWarningDetail {
    code: string;
    severity: "info" | "caution" | "degraded" | "blocking";
    blocksUse: boolean;
    message: string;
    action?: string;
}

export interface SearchChunkResult {
    kind: "chunk";
    file: string;
    span: SearchSpan;
    language: string;
    content: string;
    /** Retrieval evidence only; final relevance is the response sequence, not this number. */
    score: number;
    indexedAt?: string;
    stalenessBucket: StalenessBucket;
    symbolId?: string;
    symbolLabel?: string;
    symbolKey?: string;
    symbolInstanceId?: string;
    symbolKind?: string;
    debug?: {
        baseScore: number;
        fusionScore: number;
        lexicalScore: number;
        pathMultiplier: number;
        pathCategory: string;
        changedFilesMultiplier?: number;
        agentFitMultiplier?: number;
        agentFitReason?: string;
        entrypointOwnerScoreBoost?: number;
        entrypointOwnerScoreReason?: string;
        matchesMust?: boolean;
        exactLexicalMatch: boolean;
        backendScore?: number;
        backendScoreKind?: "dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown";
        provenance?: {
            retrievalPasses: string[];
            backendScoreKinds: Array<"dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown">;
            semanticCandidate: boolean;
            lexicalCandidate: boolean;
            rerankAdjusted: boolean;
            exactMatchPinned: boolean;
            ownerRepairApplied: boolean;
        };
    };
}

export type SearchGroupedTargetV2 =
    | {
        file: string;
        span: SearchSpan;
        symbolId: string;
    }
    | {
        file: string;
        span: SearchSpan;
        symbolId?: never;
    };

export type SearchGraphNavigationV2 =
    | {
        graph: "ready";
        inbound: "verify";
        callerSearchTerm?: string;
    }
    | {
        graph: SearchNavigationUnavailableReasonV2;
        inbound?: never;
        callerSearchTerm?: never;
    };

export interface SearchGroupedDebugV2 {
    representativeChunkCount: number;
    pathCategory: string;
    pathMultiplier: number;
    topChunkScore: number;
    lexicalScore: number;
    changedFilesMultiplier?: number;
    agentFitMultiplier?: number;
    agentFitReason?: string;
    entrypointOwnerScoreBoost?: number;
    entrypointOwnerScoreReason?: string;
    matchesMust?: boolean;
    exactLexicalMatch: boolean;
    symbolAggregation?: {
        ownerSource: "owner_metadata" | "registry_repair" | "fallback";
        evidenceChunkCount: number;
    };
    freshness?: {
        newestChunkIndexedAt: string | null;
        ageBucket: StalenessBucket;
    };
    graphEvidence?: {
        validatedAt?: string;
        sidecarBuiltAt?: string;
    };
    provenance?: {
        retrievalPasses: string[];
        backendScoreKinds: Array<"dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown">;
        semanticCandidate: boolean;
        lexicalCandidate: boolean;
        rerankAdjusted: boolean;
        exactMatchPinned: boolean;
        ownerRepairApplied: boolean;
    };
}

export interface SearchGroupedResultV2 {
    target: SearchGroupedTargetV2;
    displayLabel: string;
    language: string;
    symbolKind?: string;
    /**
     * Retrieval evidence retained for compatibility and diagnostics. It is
     * not an authoritative relevance score; consumers must preserve the
     * response sequence (or use resultIndex.rank) instead of sorting by it.
     */
    score: number;
    quality: {
        owner: "high" | "medium" | "low";
        semantic: SearchCapabilityConfidence;
    };
    evidenceChunks?: number;
    preview: string;
    evidenceSpan?: SearchSpan;
    navigation: SearchGraphNavigationV2;
    debug?: SearchGroupedDebugV2;
}

/** Internal grouping/ranking state. Envelope serialization removes every __ field. */
export interface SearchGroupResult extends SearchGroupedResultV2 {
    __groupId: string;
    __symbolKey?: string;
    __symbolInstanceId?: string;
    __candidateIds: string[];
    __exactLexicalMatch: boolean;
    /** Internal immutable order position assigned before grouping. */
    __authoritativeRank?: number;
}

/**
 * Survival v4 is an additive bounded-observation schema. Existing stage and
 * removal meanings remain stable; diagnostic metadata/stages may be added
 * without a version bump. Consumers of serialized diagnostics must ignore
 * unknown additive fields and tolerate unknown future diagnostic-only stage
 * values. A breaking or reinterpretive change requires a new schemaVersion.
 */
export type SearchCandidateSurvivalStageName =
    | "raw_dense"
    | "raw_lexical"
    | "raw_lexical_fallback"
    | "diagnostic_dense"
    | "diagnostic_lexical"
    | "core_fusion"
    | "core_result"
    | "mcp_pass"
    | "mcp_fusion"
    | "mcp_replay_signals"
    | "mcp_filtered"
    | "reranker_input"
    | "reranker_output"
    | "mcp_ranked"
    | "grouped"
    | "disclosed";

export interface SearchCandidateSurvivalOccurrence {
    candidateId: string;
    candidateIdKind: "persisted" | "derived" | "registry";
    ownerId: string;
    evidenceOccurrenceId: string;
    relativePath: string;
    startLine: number | null;
    endLine: number | null;
    language: string;
    rank: number;
    score?: number;
    passId?: string;
    rerankInput?: {
        documentUtf8Bytes: number;
        documentSha256: string;
        candidateRole: SearchCandidateRole;
        answerFocus?: SearchAnswerFocus;
        projectionIdentity: string;
        queryProjectionIdentity?: string;
    };
    groupReplay?: {
        displayLabel: string;
        symbolKind: string | null;
        declarationLike: boolean;
        exactLexicalMatch: boolean;
        symbolKey: string | null;
        symbolInstanceId: string | null;
    };
}

export interface SearchCandidateSurvivalStage {
    stage: SearchCandidateSurvivalStageName;
    passId?: string;
    weight?: number;
    totalOccurrences: number;
    uniqueCandidates: number;
    omittedOccurrences: number;
    candidates: SearchCandidateSurvivalOccurrence[];
}

export interface SearchCandidateSurvivalRemoval {
    candidateId: string;
    afterStage: SearchCandidateSurvivalStageName;
    passId?: string;
    reason:
        | "core_fusion_limit"
        | "dirty_source_suppressed"
        | "scope_filter"
        | "requested_subdirectory_filter"
        | "language_filter"
        | "path_include_filter"
        | "path_exclude_filter"
        | "must_filter"
        | "exclude_filter"
        | "reranker_input_byte_budget"
        | "reranker_document_projection_failed"
        | "reranker_input_insufficient"
        | "invalid_group_target"
        | "duplicate_group"
        | "file_diversity_cap"
        | "symbol_diversity_cap"
        | "visible_limit";
}

/**
 * Version 4 adds bounded per-document rerank input provenance
 * (bytes/hash/role/projection identity, never document text) and
 * projection-failure removal reasons. Version 3 removed the v2 replay
 * fields that described local relevance scores no longer ranking
 * authority.
 */
export interface SearchCandidateSurvivalDebug {
    schemaVersion: "search_candidate_survival_v4";
    orderAuthority: "retrieval_then_validated_reranker";
    maxEntriesPerStage: number;
    maxRemovalEntries: number;
    corePasses: Array<{
        passId: string;
        productCandidateLimit: number;
    }>;
    queryEmbeddings: Array<{
        passId: string;
        sha256: string | null;
    }>;
    lexicalRequests: Array<{
        passId: string;
        role: "primary" | "fallback_or";
        querySha256: string;
        matchMode: "all_terms" | "any_terms" | "provider_sparse" | "unspecified";
        terms?: string[];
    }>;
    diagnosticRetrievals?: Array<{
        passId: string;
        arm: "dense" | "precise_lexical" | "fallback_lexical";
        requestedLimit: number;
        status: "available" | "unavailable";
        failureReason?: "backend_request_failed";
    }>;
    stages: SearchCandidateSurvivalStage[];
    removals: SearchCandidateSurvivalRemoval[];
    omittedRemovals: number;
}

export interface FingerprintCompatibilityDiagnostics {
    runtimeFingerprint: IndexFingerprint;
    indexedFingerprint?: IndexFingerprint;
    fingerprintSource?: FingerprintSource;
    reindexReason?: "legacy_unverified_fingerprint" | "fingerprint_mismatch" | "missing_fingerprint" | "navigation_recovery_failed" | "backend_requires_full_rebuild" | "index_policy_changed";
    statusAtCheck?: "indexed" | "indexing" | "indexfailed" | "sync_completed" | "requires_reindex" | "not_found";
}

export interface SearchNoiseMitigationHint {
    reason: "top_results_noise_dominant";
    topK: number;
    ratios: Record<SearchNoiseCategory, number>;
    recommendedScope: "runtime";
    suggestedIgnorePatterns: string[];
    debounceMs: number;
    nextStep: string;
}

export interface SearchFreshnessSummary {
    syncMode: FreshnessDecision["mode"];
    lastSyncAt: string | null;
    changedFileCount: number;
    gitDirtyFilesConsidered: boolean;
    changedFilesBoostApplied: boolean;
    changedFilesBoostSkippedForLargeChangeSet: boolean;
}

export type SearchReadinessInvalidationReason =
    | "none"
    | "cache_miss"
    | "idle_expired"
    | "proof_expired"
    | "observation_unavailable"
    | "observation_changed"
    | "revalidation_failed"
    | "freshness_changed";

export interface SearchReadinessDebugHint {
    proofMode: "cold" | "warm";
    invalidationReason: SearchReadinessInvalidationReason;
    auditClassification?: "proof_expiry_audit";
    observationUnavailableReason?: PreparedReadObservationUnavailableReason;
    watcher?: PreparedReadWatcherDiagnostics;
    requestProof?: {
        freshnessComparisonMode: "full" | "exact_paths" | "stale_while_sync";
        exactPathCount: number;
        checkpointBindings: number;
        preRetrievalFullComparisons: number;
        finalFullComparisons: number;
    };
    operations: {
        preparedCacheLookups: number;
        preparedCacheHits: number;
        coldReadinessChecks: number;
        postFreshnessColdChecks: number;
        warmReceiptRevalidations: number;
        exactPayloadRecounts: number;
        registryLoads: number;
        navigationValidationRuns: number;
    };
}

export interface SearchOperatorSummary {
    prefixBlockChars: number;
    lang: string[];
    path: string[];
    excludePath: string[];
    must: string[];
    exclude: string[];
}

export interface SearchProviderWorkDebugHint {
    semanticSearchAttempts: number;
    embeddingCallsByCurrentContract: number;
    denseQueriesByCurrentContract: number;
    sparseQueriesByCurrentContract: number;
    rerankerCalls: number;
    rerankerCandidates: number;
    rerankerInputBytes: number;
    rerankerFailures: number;
    rerankerRetries: number;
    rerankerTimeouts: number;
    candidatesWithSemanticEvidence: number;
    candidatesWithLexicalEvidence: number;
    candidatesWithCurrentSourceEvidence: number;
}

export interface SearchDebugHint {
    route: SearchRouteContract;
    queryIntent: {
        classification: "identifier" | "semantic" | "mixed" | "uncertain";
        confidence: "high" | "medium" | "low";
        reasons: string[];
        lexicalTerms: string[];
        semanticQuery: string;
        entrypointIntent?: {
            kinds: string[];
            reasons: string[];
        };
    };
    entrypointOwnerEvidence?: EntrypointOwnerEvidenceResolution;
    retrieval: {
        mode: "dense" | "lexical" | "hybrid";
        scorePolicyKind: "dense_similarity_min" | "topk_only";
        backendScoreKinds: Array<"dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown">;
    };
    mcpFusion: {
        rrfK: number;
    };
    providerWork: SearchProviderWorkDebugHint;
    semanticPassFailures?: SemanticPassFailureDiagnostic[];
    candidateSurvival?: SearchCandidateSurvivalDebug;
    semanticExpansion?: {
        attempted: boolean;
        expand: boolean;
        reason:
            | "lexical_route"
            | "exact_registry_fallback"
            | "deterministic_route_primary"
            | "mixed_route"
            | "operator_constraint"
            | "explicit_role_cue"
            | "primary_candidate_pool_sufficient"
            | "primary_candidate_pool_small"
            | "primary_failed_fallback"
            | "primary_terminal_provider_failure";
        primaryScopedCandidateCount: number;
    };
    rankingProvenance: {
        semanticPassesUsed: string[];
        lexicalPassesUsed: string[];
        livePathSupplementUsed: boolean;
        lexicalFileScanUsed: boolean;
        rerankApplied: boolean;
        exactMatchPinningApplied: boolean;
        registryRepairGroupCount: number;
    };
    trackedLexical?: {
        enabled: boolean;
        trackedPathCount: number;
        filesConsidered: number;
        filesScanned: number;
        bytesRead: number;
        cappedByFiles: boolean;
        cappedByBytes: boolean;
        returnedResults: number;
    };
    exactRegistry?: {
        attempted: boolean;
        status: "hit" | "miss" | "ambiguous" | "not_applicable";
        reason: string;
        candidateSet?: "path_exact_file" | "registry_all";
        inspectedSymbolCount: number;
        filteredSymbolCount: number;
        ambiguousCount?: number;
        matchedSymbolInstanceId?: string;
        registryUnavailableReason?: string;
    };
    phaseTimingsMs?: {
        prepareRead: number;
        snapshotReload: number;
        trackedRootResolution: number;
        fingerprintGate: number;
        completionProof: number;
        collectionProbe: number;
        ensureFreshness: number;
        exactRegistry: number;
        semanticSearch: number;
        trackedLexical: number;
        rerank: number;
        registryLoad: number;
        grouping: number;
        navigationValidation: number;
        freshnessCheckpointProof: number;
        freshnessExactPathComparison: number;
        incrementalPublication: number;
        publicationSourceNavigationLoad: number;
        publicationFork: number;
        publicationPayloadDelta: number;
        publicationNavigationCheckpoint: number;
        publicationNavigationDelta: number;
        publicationRelationshipLoad: number;
        publicationRelationshipDelta: number;
        publicationSidecarStage: number;
        publicationCheckpointStage: number;
        publicationPayloadCount: number;
        publicationActivation: number;
        publicationRetentionProof: number;
        finalSourceValidation: number;
    };
    readiness: SearchReadinessDebugHint;
    passesUsed: string[];
    candidateLimit: number;
    diagnosticCandidateLimit?: number;
    mustRetry: {
        attempts: number;
        maxAttempts: number;
        applied: boolean;
        satisfied: boolean;
        finalCount: number;
    };
    operatorSummary: SearchOperatorSummary;
    filterSummary: {
        removedByRequestedSubdirectory: number;
        removedByScope: number;
        removedByLanguage: number;
        removedByPathInclude: number;
        removedByPathExclude: number;
        removedByMust: number;
        removedByExclude: number;
    };
    diversitySummary?: {
        maxPerFile: number;
        maxPerSymbol: number;
        relaxedFileCap: number;
        skippedByFileCap: number;
        skippedBySymbolCap: number;
        usedRelaxedCap: boolean;
    };
    changedFilesBoost: {
        enabled: boolean;
        applied: boolean;
        available: boolean;
        changedCount: number;
        maxChangedFilesForBoost: number;
        skippedForLargeChangeSet: boolean;
        multiplier: number;
        boostedCandidates: number;
    };
    changedCode?: {
        basis: "git_tracked_worktree";
        files: string[];
        symbols: Array<{
            file: string;
            symbolId: string;
            symbolLabel?: string;
            span: SearchSpan;
        }>;
        directCallers: Array<{
            targetSymbolId: string;
            file: string;
            symbolId: string;
            symbolLabel?: string;
            span: SearchSpan;
            site: {
                file: string;
                startLine: number;
                endLine?: number;
            };
            kind: "call" | "import" | "dynamic";
            confidence: number;
        }>;
        totalFiles?: number;
        totalSymbols?: number;
        totalDirectCallers?: number;
        truncated?: boolean;
    };
    rerank?: {
        enabledByPolicy: boolean;
        skippedByScopeDocs: boolean;
        skippedByIdentifierIntent: boolean;
        orderAuthority: "retrieval_order" | "reranker_order";
        /** True when top scored hit is already an exact lexical pin / must-satisfied exact match. */
        skippedByExactPin?: boolean;
        capabilityPresent: boolean;
        rerankerPresent: boolean;
        enabled: boolean;
        attempted: boolean;
        applied: boolean;
        exactMatchPinningEnabled: boolean;
        exactMatchPinningApplied: boolean;
        candidatesIn: number;
        candidatesReranked: number;
        familyCount?: number;
        supplementalCandidates?: number;
        candidatePoolCount?: number;
        candidateBudget?: number;
        budgetReason?: RerankBudgetReason;
        /** Selected document-string bytes only; excludes query and provider request framing. */
        inputByteBudget: number;
        /** Selected document-string bytes only; excludes query and provider request framing. */
        inputBytes: number;
        byteBudgetOmittedCandidates: number;
        errorCode?: "RERANKER_FAILED";
        failurePhase?: "document_projection" | "api_call" | "parse_results";
        operationalReason?: SearchRerankerOperationalReason;
        queueWaitMs?: number;
        effectiveScoreDeadlineMs?: number;
        effectiveStageDeadlineMs?: number;
        observedWallMs?: number;
        deadlineLatenessMs?: number;
        topK: number;
        docMaxLines: number;
        docMaxChars: number;
        requestedResultLimit: number;
        selectionPolicy: {
            minAmbiguousCandidates: number;
            ambiguousCandidatesPerResult: number;
            boundedCandidatesPerResult: number;
            maxSupplementalChunksPerFamily: number;
        };
    };
    rerankerProjection?: SearchRerankProjectionSummary;
}

export type SearchRerankerOperationalReason =
    | "lateon_applied"
    | "lateon_not_ready"
    | "lateon_capacity_fallback"
    | "lateon_queue_timeout"
    | "lateon_execution_timeout"
    | "lateon_cancelled"
    | "lateon_invalid_output"
    | "lateon_worker_failure";

export type SearchRerankProjectionSummary = Readonly<{
    requestedCandidates: number;
    projectedCandidates: number;
    skippedCandidates: number;
    failureCounts: Partial<Record<SearchRerankProjectionFailureReason, number>>;
    firstFailure?: {
        candidateId: string;
        reason: SearchRerankProjectionFailureReason;
    };
    /** v4-only optional structural enrichment state for this search. */
    structuralContextStatus?: SearchRerankStructuralContextStatus;
}>;

export type SearchRankingDebugHint = Pick<SearchDebugHint,
    | "route"
    | "queryIntent"
    | "retrieval"
    | "mcpFusion"
    | "providerWork"
    | "semanticPassFailures"
    | "semanticExpansion"
    | "rankingProvenance"
    | "trackedLexical"
    | "exactRegistry"
    | "passesUsed"
    | "candidateLimit"
    | "mustRetry"
    | "operatorSummary"
    | "filterSummary"
    | "diversitySummary"
    | "changedFilesBoost"
    | "rerank"
    | "rerankerProjection"
>;

export type SearchFreshnessDebugHint = Pick<SearchDebugHint, "phaseTimingsMs" | "readiness" | "changedCode">;
export type SearchPassFailureDebugHint = Pick<SearchDebugHint, "semanticPassFailures">;

export type SearchMustConstraintHint =
    | {
        status: "attempted";
        mustTokens: readonly string[];
        candidateBudget: number;
        candidatesExamined: number;
        budgetExhausted: boolean;
    }
    | {
        status: "unsupported";
        mustTokens: readonly string[];
        candidateBudget: number;
        candidatesExamined: 0;
    }
    | {
        status: "failed";
        mustTokens: readonly string[];
        candidateBudget: number;
        candidatesExamined: number;
    };

export type SearchMustCoverage = Readonly<{
    semantics: "case_sensitive_raw_substring_all";
    /** Bounded retrieval never proves repository-wide `must:` exhaustiveness. */
    exhaustive: false;
    status:
        | "lane_completed_within_backend_results"
        | "partial_candidate_budget"
        | "lane_skipped_primary_limit_filled"
        | "lane_unavailable"
        | "lane_failed";
    laneAttempted: boolean;
    candidatesExamined: number;
    candidateBudget: number;
    moreMayExist: boolean;
}>;

export interface SearchResponseHints extends Record<string, unknown> {
    version?: 1;
    mustConstraint?: SearchMustConstraintHint;
    mustCoverage?: SearchMustCoverage;
    noiseMitigation?: SearchNoiseMitigationHint;
    debugSearch?: SearchDebugHint | SearchRankingDebugHint | SearchFreshnessDebugHint | SearchPassFailureDebugHint;
    debugSummary?: {
        retrieval: string;
        freshness: FreshnessDecision["mode"] | "skipped_requires_reindex" | "skipped_indexing" | "unknown";
        dirtyFiles: number;
        rerank: string;
        changedCodeTruncated?: boolean;
    };
    verification?: {
        generatedArtifacts?: {
            reason: "generated_outputs_present";
            message: string;
            files: string[];
            nextSteps: Array<{
                tool: "read_file";
                args: {
                    path: string;
                    start_line: number;
                    end_line: number;
                };
            }>;
        };
    };
}

export type VectorBackendResponseCode =
    | "ZILLIZ_CLUSTER_STOPPED"
    | "VECTOR_BACKEND_AUTH_FAILED"
    | "VECTOR_BACKEND_UNREACHABLE"
    | "VECTOR_BACKEND_TIMEOUT"
    | "VECTOR_BACKEND_CONNECTION_CLOSED";

export type EmbeddingProviderResponseCode =
    | "EMBEDDING_PROVIDER_AUTH_FAILED"
    | "EMBEDDING_PROVIDER_FORBIDDEN"
    | "EMBEDDING_PROVIDER_RATE_LIMITED"
    | "EMBEDDING_PROVIDER_INVALID_REQUEST"
    | "EMBEDDING_PROVIDER_TIMEOUT"
    | "EMBEDDING_PROVIDER_UNAVAILABLE"
    | "EMBEDDING_PROVIDER_NETWORK_ERROR"
    | "EMBEDDING_PROVIDER_ERROR";

export type NonOkReason =
    | "indexing"
    | "requires_reindex"
    | "partial_index_navigation_unavailable"
    | "index_failed"
    | "not_indexed"
    | NavigationUnavailableReason
    | "missing_provider_config"
    | "search_backend_failed"
    | "source_changed_during_request"
    | "source_state_unverified"
    | "analysis_unavailable"
    | "unsupported_symbol_kind"
    | "embedding_provider_unavailable"
    | "vector_backend_unavailable";

export interface IndexingFailureMetadata {
    errorMessage: string | null;
    lastAttemptedPercentage: number | null;
    lastUpdated: string | null;
}

interface SearchBaseResponseEnvelope {
    formatVersion: typeof SEARCH_RESPONSE_FORMAT_VERSION;
    status: "ok" | "requires_reindex" | "not_indexed" | "not_ready";
    reason?: NonOkReason;
    code?: "MISSING_PROVIDER_CONFIG"
        | "SEARCH_RESULT_SET_PAGE_TOO_LARGE"
        | VectorBackendResponseCode
        | EmbeddingProviderResponseCode;
    path: string;
    codebaseRoot?: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    limit: number;
    freshnessDecision?: FreshnessDecision | { mode: "skipped_requires_reindex" | "skipped_indexing" } | null;
    freshnessSummary?: SearchFreshnessSummary;
    freshness?: {
        state: "sync_in_progress";
        servedCollection?: string;
        servedRunId?: string;
        servedGenerationId?: string;
        servedGeneration?: number;
        pendingOperation?: {
            action: string;
            generation: number;
        };
    };
    warnings?: SearchWarningDetail[];
    recommendedNextAction?: SearchRecommendedNextAction;
    message?: string;
    hints?: SearchResponseHints;
    compatibility?: FingerprintCompatibilityDiagnostics;
    indexingFailure?: IndexingFailureMetadata;
    retryAfterMs?: number;
    indexingOperation?: {
        action: string;
        phase: string;
        generation: number;
    };
}

export interface SearchGroupedResponseEnvelope extends SearchBaseResponseEnvelope {
    resultMode: "grouped";
    rankedSetDigest?: string;
    resultIndex?: SearchCompactResultIndex;
    resultCounts?: SearchGroupedResultCounts;
    /** Groups beyond the caller-bounded frozen set (available - frozen), present only when positive. */
    omittedBeyondLimitGroupCount?: number;
    disclosure?: SearchDisclosureSummary;
    continuation?: {
        handle: string;
        nextOffset: number;
        remainingGroupCount: number;
    };
    /**
     * `continuation: "complete"` means complete for the caller-bounded frozen
     * set (`totalGroupCount`), not for the full available pool; groups excluded
     * by the caller limit are reported via `omittedBeyondLimitGroupCount` and
     * `resultCounts.availableGroupCount`.
     */
    pagination?: SearchPaginationEvidence;
    /** Results are already in authoritative relevance order. */
    results: SearchGroupedResultV2[];
}

export type SearchResultIndexEvidenceLabel =
    | "high_owner_confidence"
    | "medium_owner_confidence"
    | "high_semantic_confidence"
    | "medium_semantic_confidence"
    | "ranked_candidate";

export type SearchResultIndexEntry =
    | {
        rank: number;
        kind: "symbol";
        target: { file: string; symbolId: string };
        displayLabel: string;
        evidenceLabel: SearchResultIndexEvidenceLabel;
    }
    | {
        rank: number;
        kind: "file";
        target: { file: string };
        displayLabel: string;
        evidenceLabel: SearchResultIndexEvidenceLabel;
    };

export interface SearchCompactResultIndex {
    contractVersion: "search_result_index_v1";
    rankedSetDigest: string;
    disclosurePolicyVersion: "search_disclosure_v1";
    availableEntryCount: number;
    returnedEntryCount: number;
    complete: boolean;
    entries: SearchResultIndexEntry[];
}

export interface SearchGroupedResultCounts {
    requestedTotal: number;
    effectiveFrozenTotal: number;
    availableGroupCount: number;
    returnedGroupCount: number;
    remainingGroupCount: number;
}

export interface SearchPaginationEvidence {
    totalGroupCount: number;
    returnedGroupCount: number;
    continuation: "complete" | "attached" | "not_admissible";
}

export type SearchDisclosureReason =
    | "initial_budget"
    | "caller_limit"
    | "utf8_byte_budget"
    | "group_content_truncated";

export interface SearchDisclosureSummary {
    policyVersion: "search_disclosure_v1";
    availableGroupCount: number;
    returnedGroupCount: number;
    omittedGroupCount: number;
    truncated: boolean;
    reasons: SearchDisclosureReason[];
}

export interface SearchRawResponseEnvelope extends SearchBaseResponseEnvelope {
    resultMode: "raw";
    results: SearchChunkResult[];
}

export type SearchResponseEnvelope = SearchGroupedResponseEnvelope | SearchRawResponseEnvelope;

export type SearchDebugMode = "none" | "summary" | "ranking" | "freshness" | "full";

export interface SearchRequestInput {
    path: string;
    query: string;
    scope: SearchScope;
    resultMode: SearchResultMode;
    groupBy: SearchGroupBy;
    rankingMode: SearchRankingMode;
    limit: number;
    disclosureLimit?: number;
    includeResultIndex?: boolean;
    debugMode?: SearchDebugMode;
    debugCandidateLimit?: number;
}

export interface FileOutlineInput {
    path: string;
    file: string;
    start_line?: number;
    end_line?: number;
    limitSymbols?: number;
    resolveMode?: "outline" | "exact";
    symbolIdExact?: string;
    symbolLabelExact?: string;
    detail?: "summary" | "analysis" | "relationships";
}

export type FileOutlineStatus = "ok" | "not_found" | "requires_reindex" | "not_indexed" | "not_ready" | "unsupported" | "ambiguous";

export type SymbolParentResolution = "resolved" | "ambiguous" | "missing" | "not_applicable";

export interface CanonicalSymbolIdentity {
    symbolId: string;
    symbolKey: string;
    name: string;
    qualifiedName: string;
    symbolLabel: string;
    kind: SymbolKind;
    language: string;
    file: string;
    span: SymbolSpan;
    parentQualifiedNamePath: string[];
    parentResolution: SymbolParentResolution;
    parentKey?: string;
    parentSymbolId?: string;
    exported?: boolean;
    ontologyTags?: RepositoryOntologyTag[];
}

export interface FileOutlineSymbolResult extends CanonicalSymbolIdentity {
    callGraphHint: CallGraphHint;
    analysis?: import("@zokizuan/satori-core").PythonStructuralAnalysis;
    relationships?: {
        directCallerCount: number | null;
        directCalleeCount: number | null;
        recursionState: "confirmed" | "not_observed" | "unknown";
        relationshipCoverage: "complete" | "partial" | "unsupported" | "unavailable";
    };
}

export interface FileOutlineResponseEnvelope {
    status: FileOutlineStatus;
    reason?: NonOkReason | "invalid_request";
    path: string;
    file: string;
    outline: { symbols: FileOutlineSymbolResult[] } | null;
    hasMore: boolean;
    warnings?: string[];
    message?: string;
    hints?: Record<string, unknown>;
    indexingFailure?: IndexingFailureMetadata;
}

export type CallGraphDirection = "callers" | "callees" | "both";

export type CallGraphResponseStatus =
    | "ok"
    | "not_found"
    | "requires_reindex"
    | "not_indexed"
    | "not_ready"
    | "unsupported";

export type CallGraphResponseReason =
    | NavigationUnavailableReason
    | "invalid_symbol_ref"
    | "indexing"
    | "index_failed"
    | "not_indexed"
    | "requires_reindex"
    | "partial_index_navigation_unavailable"
    | "source_state_unverified"
    | "missing_provider_config"
    | "vector_backend_unavailable";

export interface CallGraphNodeResult {
    symbolId: string;
    symbolLabel?: string;
    file: string;
    language: string;
    span: SearchSpan;
}

export interface CallGraphEdgeResult {
    srcSymbolId: string;
    dstSymbolId: string;
    kind: "call" | "import" | "dynamic";
    site: {
        file: string;
        startLine: number;
        endLine?: number;
    };
    confidence: number;
}

export interface CallGraphNoteResult {
    type: "unresolved_edge" | "dynamic_edge" | "missing_symbol_metadata" | "suppressed_edge";
    file: string;
    startLine: number;
    symbolId?: string;
    symbolLabel?: string;
    confidence?: number;
    detail: string;
}

export interface CallGraphTestReferenceResult {
    file: string;
    symbolId: string;
    symbolLabel?: string;
    span: SearchSpan;
    site: {
        file: string;
        startLine: number;
        endLine?: number;
    };
    targetSymbolId: string;
    kind: "call" | "import" | "dynamic";
    confidence: number;
}

export interface CallGraphTraversalResponseEnvelope {
    status: CallGraphResponseStatus;
    supported: boolean;
    reason?: CallGraphResponseReason;
    path: string;
    codebaseRoot?: string;
    codebasePath?: string;
    symbolRef: CallGraphSymbolRef;
    direction?: CallGraphDirection;
    depth?: number;
    limit?: number;
    nodes: CallGraphNodeResult[];
    edges: CallGraphEdgeResult[];
    notes: CallGraphNoteResult[];
    warnings?: string[];
    inboundCoverageEvidence?: InboundCoverageEvidence;
    testReferences?: CallGraphTestReferenceResult[];
    notesTruncated?: boolean;
    totalNoteCount?: number;
    returnedNoteCount?: number;
    sidecar?: {
        builtAt: string;
        /** Count of nodes returned in this traversal response, not total nodes stored for the codebase sidecar. */
        nodeCount: number;
        /** Count of edges returned in this traversal response, not total edges stored for the codebase sidecar. */
        edgeCount: number;
    };
    /** The exact serving navigation generation and distinct relationship/publication timestamps. */
    navigationAuthority?: {
        generationId: string;
        navigationSealSha256: string;
        relationshipManifestSha256: string;
        relationshipBuiltAt: string;
        publicationCompletedAt: string;
    };
    freshnessDecision?: FreshnessDecision | { mode: "skipped_requires_reindex" | "skipped_indexing" };
    message?: string;
    hints?: NavigationToolHints;
    compatibility?: FingerprintCompatibilityDiagnostics;
    indexingFailure?: IndexingFailureMetadata;
    indexing?: {
        progressPct: number | null;
        lastUpdated: string | null;
        phase: string | null;
    };
}

export type CallGraphResponseEnvelope = CallGraphTraversalResponseEnvelope;

export interface ReadFileStructuredErrorResponseEnvelope {
    status: Exclude<FileOutlineStatus, "ok">;
    reason?: NonOkReason;
    message: string;
    file?: string;
    matches?: unknown[];
    warnings?: string[];
    hints?: NavigationToolHints;
    indexingFailure?: IndexingFailureMetadata;
}

export type ReadFileAnnotatedOutlineStatus = "ok" | "requires_reindex" | "unsupported" | "ambiguous";

export interface ReadFileAnnotatedResponseEnvelope {
    path: string;
    mode: "annotated";
    content: string;
    outlineStatus: ReadFileAnnotatedOutlineStatus;
    outline: { symbols: unknown[] } | null;
    hasMore: boolean;
    warnings?: string[];
    hints?: NavigationToolHints;
}
