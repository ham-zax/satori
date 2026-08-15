import type {
    Reranker,
    RerankExecutionDiagnostics,
    RerankResult,
    SemanticSearchExecutionResult,
    SemanticSearchResult,
} from "@zokizuan/satori-core";
import {
    LexicalRetrievalModeUnsupportedError,
    RerankerRequestError,
    type RerankerFailureKind,
} from "@zokizuan/satori-core";
import {
    SEARCH_RERANK_DOC_MAX_CHARS,
    SEARCH_RERANK_DOC_MAX_LINES,
    SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
    SEARCH_RRF_K,
    type PathCategory,
    type SearchRankingMode,
    type SearchResultMode,
    type SearchScope,
} from "./search-constants.js";
import type {
    SearchCandidateSurvivalDebug,
    SearchCandidateSurvivalOccurrence,
    SearchDebugMode,
    SearchFreshnessSummary,
    SearchMustCoverage,
    SearchOperatorSummary,
    SearchProviderWorkDebugHint,
    SearchRerankProjectionSummary,
    SearchRerankerOperationalReason,
} from "./search-types.js";
import type { EntrypointOwnerEvidenceResolution } from "./entrypoint-owner-evidence.js";
import type { SearchAnswerFocus } from "./search-rerank-context.js";
import type { SearchRerankQueryProjectionIdentity } from "./search-rerank-query-routing.js";
import {
    appendCoreCandidateTrace,
    appendSearchCandidatePass,
    appendSearchCandidateRemoval,
    appendSearchCandidateStage,
    createSearchCandidateSurvivalTrace,
    SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE,
    searchCandidateIdentity,
} from "./search-candidate-survival.js";
import { WARNING_CODES, type WarningCode } from "./warnings.js";
import {
    candidateWithinRequestedSubdirectory,
    type RequestedSearchSubdirectory,
} from "./search-requested-scope.js";
import {
    buildSearchPassWarning as buildSearchPassWarningHelper,
} from "./search-response-helpers.js";
import {
    classifyPathCategory,
    shouldIncludeCategoryInScope,
} from "./search-ranking-policy.js";
import type { SearchQuerySupport } from "./search-query-support.js";
import type {
    SearchQueryPlan,
    SearchResultLike,
} from "./search-lexical-scoring.js";
import type { ParsedSearchOperators } from "./search-query-planning.js";
import {
    buildSemanticPassFailureDiagnostic,
    type SemanticPassFailureDiagnostic,
    type VectorBackendDiagnostic,
} from "./backend-diagnostics.js";
import type { EmbeddingProviderDiagnostic } from "./embedding-provider-diagnostics.js";
import type { FreshnessDecision } from "./sync.js";
import {
    selectRerankCandidates,
    selectRerankInputWithinUtf8Budget,
    shouldCallRerankerForProjectedCandidateCount,
    type RerankBudgetReason,
} from "./search-rerank-policy.js";
import {
    resolveNextSearchCandidateLimit,
} from './search-policy.js';
import type { ResolvedSearchPolicy } from './search-policy.js';
import {
    applyNativeRerankToSelectedSlots,
    validateNativeRerankResults,
} from "./search-native-rerank.js";
import { resolveRerankBoundary } from "./search-rerank-boundary.js";
import type {
    SearchRerankProjectionFailureReason,
    SearchRerankProjectionResult,
    SearchRerankStructuralContextStatus,
} from "./search-rerank-projection-result.js";
import { sortNativeRetrievalCandidates } from "./search-retrieval-order.js";

type SearchPassId = "primary" | "expanded";
type BackendScoreKind = "dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown";
type ChangedFilesState = { available: boolean; files: Set<string> };
export type SearchOrderAuthority = "retrieval_order" | "reranker_order";
const SEARCH_EXPANSION_MIN_PRIMARY_SCOPED_CANDIDATES = 5;
const LATEON_OPERATIONAL_REASONS = new Set<SearchRerankerOperationalReason>([
    "lateon_not_ready",
    "lateon_capacity_fallback",
    "lateon_queue_timeout",
    "lateon_execution_timeout",
    "lateon_cancelled",
    "lateon_invalid_output",
    "lateon_worker_failure",
]);

function isSearchPassFaultInjectionEnabled(): boolean {
    return process.env.NODE_ENV === 'test';
}

function getForcedFailedSearchPassId(): 'primary' | 'expanded' | 'both' | undefined {
    if (!isSearchPassFaultInjectionEnabled()) {
        return undefined;
    }

    const raw = typeof process.env.SATORI_TEST_FAIL_SEARCH_PASS === 'string'
        ? process.env.SATORI_TEST_FAIL_SEARCH_PASS.trim().toLowerCase()
        : '';
    if (raw === 'primary' || raw === 'expanded' || raw === 'both') {
        return raw;
    }
    return undefined;
}

function shouldForceSearchPassFailure(passId: 'primary' | 'expanded'): boolean {
    const forced = getForcedFailedSearchPassId();
    if (!forced) {
        return false;
    }
    return forced === 'both' || forced === passId;
}

function resolveLateOnOperationalReason(error: unknown): SearchRerankerOperationalReason | undefined {
    if (!error || typeof error !== "object" || !("reason" in error)) return undefined;
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === "string"
        && LATEON_OPERATIONAL_REASONS.has(reason as SearchRerankerOperationalReason)
        ? reason as SearchRerankerOperationalReason
        : undefined;
}

export type SearchExpansionReason =
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

export type SearchExpansionDecision = {
    expand: boolean;
    reason: SearchExpansionReason;
    primaryScopedCandidateCount: number;
};

export type SearchProviderWorkDiagnostics = SearchProviderWorkDebugHint & {
    routeKind?: SearchQueryPlan["route"]["kind"];
    retrievalMode?: SearchQueryPlan["retrievalMode"];
    semanticExpansionAttempted: boolean;
    semanticExpansionReason?: SearchExpansionReason;
};

export type SearchDiagnostics = SearchProviderWorkDiagnostics & {
    queryLength: number;
    limitRequested: number;
    resultsBeforeFilter: number;
    resultsAfterFilter: number;
    excludedByIgnore: number;
    excludedBySubdirectory: number;
    filterPass: "initial" | "expanded";
    freshnessMode: string | undefined;
    searchPassCount: number;
    searchPassSuccessCount: number;
    searchPassFailureCount: number;
    semanticPassFailures?: SemanticPassFailureDiagnostic[];
    rerankerAttempted: boolean;
    rerankerUsed: boolean;
    /** Bounded classification metadata for the last terminal reranker failure. */
    rerankerFailureKind?: RerankerFailureKind;
    /** Qualified deadline diagnostics reported by the last executed rerank attempt. */
    rerankerExecutionDiagnostics?: RerankExecutionDiagnostics;
};

export type SearchCandidate = {
    result: SearchResultLike;
    baseScore: number;
    backendScore: number;
    backendScoreKind: BackendScoreKind;
    backendScoreKindsSeen: BackendScoreKind[];
    fusionScore: number;
    lexicalScore: number;
    finalScore: number;
    pathCategory: PathCategory;
    pathMultiplier: number;
    changedFilesMultiplier: number;
    agentFitMultiplier: number;
    agentFitReason: string;
    entrypointOwnerScoreBoost: number;
    entrypointOwnerScoreReason: string;
    passesMatchedMust: boolean;
    exactLexicalMatch: boolean;
    exactMatchPinned: boolean;
    rerankAdjusted: boolean;
    authoritativeRank: number;
    rerankerRank?: number;
    rerankerScore?: number;
    retrievalPasses: string[];
};

export type SearchFilterSummary = {
    removedByRequestedSubdirectory: number;
    removedByScope: number;
    removedByLanguage: number;
    removedByPathInclude: number;
    removedByPathExclude: number;
    removedByMust: number;
    removedByExclude: number;
};

export type TrackedLexicalSearchDebug = {
    enabled: boolean;
    trackedPathCount: number;
    filesConsidered: number;
    filesScanned: number;
    bytesRead: number;
    cappedByFiles: boolean;
    cappedByBytes: boolean;
    returnedResults: number;
};

export type SearchExecutionRankingProvenance = {
    semanticPassesUsed: string[];
    lexicalPassesUsed: string[];
    livePathSupplementUsed: boolean;
    lexicalFileScanUsed: boolean;
    rerankApplied: boolean;
    exactMatchPinningApplied: boolean;
    registryRepairGroupCount: number;
};

export function resolveSearchExpansionDecision(input: {
    retrievalMode: SearchQueryPlan["retrievalMode"];
    routeKind: SearchQueryPlan["route"]["kind"];
    exactRegistryFallback: boolean;
    operatorConstraintPresent: boolean;
    explicitRoleCuePresent: boolean;
    primaryScopedCandidateCount: number;
    primaryFailed: boolean;
    primaryFailureRetryable?: boolean;
}): SearchExpansionDecision {
    if (input.retrievalMode === "lexical") {
        return {
            expand: false,
            reason: "lexical_route",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (input.primaryFailed) {
        if (input.primaryFailureRetryable === false) {
            return {
                expand: false,
                reason: "primary_terminal_provider_failure",
                primaryScopedCandidateCount: input.primaryScopedCandidateCount,
            };
        }
        return {
            expand: true,
            reason: "primary_failed_fallback",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (input.exactRegistryFallback) {
        return {
            expand: false,
            reason: "exact_registry_fallback",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (
        input.routeKind === "ownership"
        || input.routeKind === "references"
        || input.routeKind === "structural"
    ) {
        return {
            expand: false,
            reason: "deterministic_route_primary",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (input.routeKind === "mixed") {
        return {
            expand: true,
            reason: "mixed_route",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (input.operatorConstraintPresent) {
        return {
            expand: true,
            reason: "operator_constraint",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (input.explicitRoleCuePresent) {
        return {
            expand: false,
            reason: "explicit_role_cue",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (input.primaryScopedCandidateCount >= SEARCH_EXPANSION_MIN_PRIMARY_SCOPED_CANDIDATES) {
        return {
            expand: false,
            reason: "primary_candidate_pool_sufficient",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    return {
        expand: true,
        reason: "primary_candidate_pool_small",
        primaryScopedCandidateCount: input.primaryScopedCandidateCount,
    };
}

export type SearchExecutionOutcome =
    | {
        kind: "ok";
        scored: SearchCandidate[];
        operatorSummary: SearchOperatorSummary;
        filterSummary: SearchFilterSummary;
        freshnessSummary: SearchFreshnessSummary;
        dirtyFilesNotFreshened: boolean;
        trackedLexicalDebug?: TrackedLexicalSearchDebug;
        candidateLimit: number;
        diagnosticCandidateLimit?: number;
        attemptsUsed: number;
        searchWarnings: string[];
        searchWarningsSet: Set<string>;
        passesUsed: Set<string>;
        backendScoreKinds: Set<BackendScoreKind>;
        exactMatchPinningApplied: boolean;
        boostedCandidates: number;
        changedFilesState: ChangedFilesState;
        debugChangedFilesState?: ChangedFilesState;
        changedFilesCount: number;
        changedFilesBoostSkippedForLargeChangeSet: boolean;
        rankingProvenance: SearchExecutionRankingProvenance;
        rerankerAttempted: boolean;
        rerankerApplied: boolean;
        orderAuthority: SearchOrderAuthority;
        skippedByExactPin: boolean;
        rerankerFailurePhase?: "document_projection" | "api_call" | "parse_results";
        rerankerOperationalReason?: SearchRerankerOperationalReason;
        rerankerFailureKind?: RerankerFailureKind;
        rerankerExecutionDiagnostics?: RerankExecutionDiagnostics;
        rerankerCandidatesIn: number;
        rerankerCandidatesReranked: number;
        rerankerFamilyCount: number;
        rerankerSupplementalCandidates: number;
        rerankerCandidatePoolCount: number;
        rerankerCandidateBudget: number;
        rerankerBudgetReason?: RerankBudgetReason;
        rerankerByteBudgetOmittedCandidates: number;
        rerankerProjection?: SearchRerankProjectionSummary;
        semanticExpansion: SearchExpansionDecision & { attempted: boolean };
        providerWork: SearchProviderWorkDiagnostics;
        entrypointOwnerEvidence?: EntrypointOwnerEvidenceResolution;
        candidateSurvival?: SearchCandidateSurvivalDebug;
        semanticPassFailures: SemanticPassFailureDiagnostic[];
        mustConstraintRetrievalOutcome: MustConstraintRetrievalOutcome | null;
        mustConstraintMustTokens: readonly string[];
        mustCoverage: SearchMustCoverage | null;
    }
    | {
        kind: "vector_backend_unavailable";
        diagnostic: VectorBackendDiagnostic;
    }
    | {
        kind: "embedding_provider_unavailable";
        diagnostic: EmbeddingProviderDiagnostic;
    }
    | {
        kind: "all_semantic_passes_failed";
        semanticPassFailures: SemanticPassFailureDiagnostic[];
    };

export type MustConstraintRetrievalOutcome =
    | {
        status: "attempted";
        candidatesExamined: number;
        candidateBudget: number;
        budgetExhausted: boolean;
    }
    | {
        status: "unsupported";
        candidatesExamined: 0;
        candidateBudget: number;
        budgetExhausted: false;
    }
    | {
        status: "failed";
        candidatesExamined: number;
        candidateBudget: number;
        budgetExhausted: true;
    };

function buildSearchMustCoverage(
    outcome: MustConstraintRetrievalOutcome | null,
    laneSkippedByPrimaryLimit: boolean,
    candidateBudget: number,
): SearchMustCoverage | null {
    if (!outcome && !laneSkippedByPrimaryLimit) {
        return null;
    }
    const base = {
        semantics: "case_sensitive_raw_substring_all" as const,
        exhaustive: false as const,
        candidateBudget,
    };
    if (!outcome) {
        return {
            ...base,
            status: "lane_skipped_primary_limit_filled",
            laneAttempted: false,
            candidatesExamined: 0,
            moreMayExist: true,
        };
    }
    if (outcome.status === "unsupported") {
        return {
            ...base,
            status: "lane_unavailable",
            laneAttempted: false,
            candidatesExamined: 0,
            moreMayExist: true,
        };
    }
    if (outcome.status === "failed") {
        return {
            ...base,
            status: "lane_failed",
            laneAttempted: true,
            candidatesExamined: outcome.candidatesExamined,
            moreMayExist: true,
        };
    }
    return outcome.budgetExhausted
        ? {
            ...base,
            status: "partial_candidate_budget",
            laneAttempted: true,
            candidatesExamined: outcome.candidatesExamined,
            moreMayExist: true,
        }
        : {
            ...base,
            status: "lane_completed_within_backend_results",
            laneAttempted: true,
            candidatesExamined: outcome.candidatesExamined,
            moreMayExist: true,
        };
}

export type SearchExecutionHost = {
    searchQuerySupport: SearchQuerySupport;
    semanticSearch: (request: {
        codebasePath: string;
        query: string;
        topK: number;
        retrievalMode: "dense" | "lexical" | "hybrid";
        lexicalMatchMode?: "all_terms" | "any_terms";
        scorePolicy: { kind: "topk_only" } | { kind: "dense_similarity_min"; min: number };
        diagnosticLexicalFallbackTerms?: string[];
    }) => Promise<SemanticSearchResult[] | SemanticSearchExecutionResult>;
    reranker: Reranker | null;
    buildRerankDocument?: (
        rerankQuery: string,
        result: SearchResultLike,
    ) => Promise<SearchRerankProjectionResult>;
    shouldForceSearchPassFailure?: (passId: SearchPassId) => boolean;
    classifyEmbeddingProviderError: (error: unknown) => EmbeddingProviderDiagnostic | null;
    classifyVectorBackendError: (error: unknown) => VectorBackendDiagnostic | null;
    measureSearchPhase: <T>(
        phase: "semanticSearch" | "trackedLexical" | "rerank",
        run: () => Promise<T>,
    ) => Promise<T>;
};

export type SearchExecutionInput = {
    effectiveRoot: string;
    scope: SearchScope;
    rankingMode: SearchRankingMode;
    resultMode: SearchResultMode;
    limit: number;
    debugMode: SearchDebugMode;
    semanticQuery: string;
    answerFocus: SearchAnswerFocus;
    rerankQuery: string;
    rerankQueryProjectionIdentity: SearchRerankQueryProjectionIdentity;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    exactRegistryEligible: boolean;
    exactRegistryFallbackForTrackedLexical: boolean;
    freshnessMode: FreshnessDecision["mode"];
    observedChangedFilesState: ChangedFilesState;
    dirtyFilesNotFreshened: boolean;
    retrievalPolicy: ResolvedSearchPolicy;
    entrypointOwnerEvidence?: EntrypointOwnerEvidenceResolution;
    requestedSubdirectory?: RequestedSearchSubdirectory | null;
};

type RerankPhaseResult = {
    exactMatchPinningApplied: boolean;
    rerankerAttempted: boolean;
    rerankerApplied: boolean;
    orderAuthority: SearchOrderAuthority;
    skippedByExactPin: boolean;
    rerankerFailurePhase?: 'document_projection' | 'api_call' | 'parse_results';
    rerankerOperationalReason?: SearchRerankerOperationalReason;
    rerankerCandidatesIn: number;
    rerankerCandidatesReranked: number;
    rerankerFamilyCount: number;
    rerankerSupplementalCandidates: number;
    rerankerCandidatePoolCount: number;
    rerankerCandidateBudget: number;
    rerankerBudgetReason?: RerankBudgetReason;
    rerankerByteBudgetOmittedCandidates: number;
    warnings: WarningCode[];
    projection?: SearchRerankProjectionSummary;
    rerankerFailureKind?: RerankerFailureKind;
};

function assignAuthoritativeRanks(candidates: SearchCandidate[]): void {
    for (let index = 0; index < candidates.length; index += 1) {
        candidates[index]!.authoritativeRank = index + 1;
    }
}

async function rerankSearchCandidates(
    input: SearchExecutionInput,
    host: SearchExecutionHost,
    searchDiagnostics: SearchDiagnostics,
    scored: SearchCandidate[],
    initialExactMatchPinningApplied: boolean,
    candidateSurvival?: SearchCandidateSurvivalDebug,
): Promise<RerankPhaseResult> {
    const rerankDecision = host.searchQuerySupport.resolveRerankDecision(input.scope, input.queryPlan);
    let exactMatchPinningApplied = initialExactMatchPinningApplied;
    let rerankerApplied = false;
    let rerankerAttempted = false;
    let orderAuthority: SearchOrderAuthority = "retrieval_order";
    let rerankerFailurePhase: 'document_projection' | 'api_call' | 'parse_results' | undefined;
    let rerankerOperationalReason: SearchRerankerOperationalReason | undefined;
    const lateOnProvider = (() => {
        try {
            return host.reranker?.getIdentity().provider === "lateon";
        } catch {
            return false;
        }
    })();
    const rerankerCandidatesIn = scored.length;
    let rerankerCandidatesReranked = 0;
    let rerankerFamilyCount = 0;
    let rerankerSupplementalCandidates = 0;
    let rerankerCandidatePoolCount = 0;
    let rerankerCandidateBudget = 0;
    let rerankerBudgetReason: RerankBudgetReason | undefined;
    let rerankerByteBudgetOmittedCandidates = 0;
    const phaseWarnings: WarningCode[] = [];
    let projectionSummary: SearchRerankProjectionSummary | undefined;
    const rerankBoundary = resolveRerankBoundary({
        candidates: scored,
        exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
        mustTokenCount: input.parsedOperators.must.length,
    });
    const skippedByExactPin = rerankBoundary.kind === "skip";
    const publicationOnlyStaleRead = input.freshnessMode === "served_previous_generation";
    if (rerankDecision.enabled && scored.length > 0 && host.reranker && !skippedByExactPin && !publicationOnlyStaleRead) {
        try {
            const rerankInputCandidates = rerankBoundary.kind === "rerank"
                ? scored.slice(rerankBoundary.startIndex)
                : [];
            const selection = selectRerankCandidates({
                candidates: rerankInputCandidates,
                requestedLimit: input.retrievalPolicy.rerankerResultLimit,
                providerMaximumDocuments: host.reranker.getMaxDocuments?.(),
            });
            rerankerFamilyCount = selection.familyCount;
            rerankerSupplementalCandidates = selection.supplementalCandidateCount;
            rerankerCandidatePoolCount = selection.candidatePoolCount;
            const providerBoundedSelection = selection.selected;
            rerankerCandidateBudget = selection.budget;
            rerankerBudgetReason = selection.budgetReason;
            let rerankSlice: SearchCandidate[];
            let rerankDocuments: string[];
            let byteBudgetOmittedCandidatesList: SearchCandidate[];
            let byteSelectionInputBytes = 0;
            let rerankInputMetadataMap: ReadonlyMap<
                string,
                NonNullable<SearchCandidateSurvivalOccurrence["rerankInput"]>
            > | undefined;
            if (host.buildRerankDocument) {
                const buildProjection = host.buildRerankDocument;
                const projectionRows = await Promise.all(providerBoundedSelection.map(async (candidate) => ({
                    candidate,
                    projection: await buildProjection(input.semanticQuery, candidate.result),
                })));
                const failureCounts: Partial<Record<SearchRerankProjectionFailureReason, number>> = {};
                let firstFailure: SearchRerankProjectionSummary["firstFailure"];
                const structuralContextStatuses = new Set<SearchRerankStructuralContextStatus>();
                const failedCandidateIds: string[] = [];
                const projectableRows: Array<{
                    candidate: SearchCandidate;
                    projection: Extract<SearchRerankProjectionResult, { ok: true }>;
                }> = [];
                for (const row of projectionRows) {
                    if (
                        row.projection.ok
                        && typeof row.projection.document === "string"
                        && row.projection.document.length > 0
                    ) {
                        projectableRows.push({ candidate: row.candidate, projection: row.projection });
                        if (row.projection.structuralContextStatus !== undefined) {
                            structuralContextStatuses.add(row.projection.structuralContextStatus);
                        }
                        continue;
                    }
                    const reason: SearchRerankProjectionFailureReason = row.projection.ok
                        ? "projection_contract_failed"
                        : row.projection.reason;
                    const failedCandidateId = row.projection.ok
                        ? searchCandidateIdentity(row.candidate.result).candidateId
                        : row.projection.candidateId;
                    failureCounts[reason] = (failureCounts[reason] ?? 0) + 1;
                    failedCandidateIds.push(failedCandidateId);
                    if (!firstFailure) {
                        firstFailure = { candidateId: failedCandidateId, reason };
                    }
                }
                if (candidateSurvival) {
                    for (const failedCandidateId of failedCandidateIds) {
                        appendSearchCandidateRemoval(candidateSurvival, {
                            candidateId: failedCandidateId,
                            afterStage: "mcp_ranked",
                            reason: "reranker_document_projection_failed",
                        });
                    }
                }
                const structuralContextStatus: SearchRerankStructuralContextStatus | undefined
                    = structuralContextStatuses.has("incompatible")
                        ? "incompatible"
                        : structuralContextStatuses.has("unavailable")
                            ? "unavailable"
                            : structuralContextStatuses.has("available")
                                ? "available"
                                : undefined;
                projectionSummary = {
                    requestedCandidates: providerBoundedSelection.length,
                    projectedCandidates: projectableRows.length,
                    skippedCandidates: providerBoundedSelection.length - projectableRows.length,
                    failureCounts,
                    ...(firstFailure ? { firstFailure } : {}),
                    ...(structuralContextStatus ? { structuralContextStatus } : {}),
                };
                if (structuralContextStatus === "incompatible") {
                    phaseWarnings.push(WARNING_CODES.RERANKER_CONTEXT_DEGRADED);
                }
                if (!shouldCallRerankerForProjectedCandidateCount(projectableRows.length)) {
                    // Fewer than two safe documents remain: skip the provider
                    // and preserve retrieval order without counting a
                    // provider failure.
                    phaseWarnings.push(WARNING_CODES.RERANKER_SKIPPED_INPUT);
                    if (candidateSurvival) {
                        for (const row of projectableRows) {
                            appendSearchCandidateRemoval(candidateSurvival, {
                                candidateId: searchCandidateIdentity(row.candidate.result).candidateId,
                                afterStage: "mcp_ranked",
                                reason: "reranker_input_insufficient",
                            });
                        }
                    }
                    return {
                        exactMatchPinningApplied,
                        rerankerAttempted,
                        rerankerApplied,
                        orderAuthority,
                        skippedByExactPin,
                        rerankerCandidatesIn,
                        rerankerCandidatesReranked,
                        rerankerFamilyCount,
                        rerankerSupplementalCandidates,
                        rerankerCandidatePoolCount,
                        rerankerCandidateBudget,
                        rerankerBudgetReason,
                        rerankerByteBudgetOmittedCandidates,
                        warnings: phaseWarnings,
                        projection: projectionSummary,
                    };
                }
                if (projectableRows.length < providerBoundedSelection.length) {
                    phaseWarnings.push(WARNING_CODES.RERANKER_INPUT_DEGRADED);
                }
                const projectableCandidates = projectableRows.map((row) => row.candidate);
                const byteSelection = selectRerankInputWithinUtf8Budget({
                    candidates: projectableCandidates,
                    documents: projectableRows.map((row) => row.projection.document),
                    maxInputBytes: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
                });
                rerankSlice = [...byteSelection.candidates];
                rerankDocuments = [...byteSelection.documents];
                byteBudgetOmittedCandidatesList = projectableCandidates.slice(byteSelection.candidates.length);
                byteSelectionInputBytes = byteSelection.inputBytes;
                rerankerByteBudgetOmittedCandidates = byteSelection.omittedCandidateCount;
                rerankInputMetadataMap = new Map(
                    rerankSlice.map((candidate, index) => {
                        const row = projectableRows[index]!;
                        return [
                            searchCandidateIdentity(candidate.result).candidateId,
                            {
                                documentUtf8Bytes: row.projection.utf8Bytes,
                                documentSha256: row.projection.sha256,
                                candidateRole: row.projection.candidateRole,
                                answerFocus: input.answerFocus,
                                projectionIdentity: row.projection.projectionIdentity,
                                queryProjectionIdentity: input.rerankQueryProjectionIdentity,
                            },
                        ] as const;
                    }),
                );
            } else {
                let selectedDocuments: string[];
                try {
                    selectedDocuments = await Promise.all(providerBoundedSelection.map(async (candidate) => {
                        const document = buildNativeProviderRerankDocument(candidate.result);
                        if (typeof document !== "string" || document.length === 0) {
                            throw new Error("reranker_document_projection_unavailable");
                        }
                        return document;
                    }));
                } catch {
                    rerankerFailurePhase = "document_projection";
                    throw new Error("reranker_document_projection_failed");
                }
                const byteSelection = selectRerankInputWithinUtf8Budget({
                    candidates: providerBoundedSelection,
                    documents: selectedDocuments,
                    maxInputBytes: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
                });
                rerankSlice = [...byteSelection.candidates];
                rerankDocuments = [...byteSelection.documents];
                byteBudgetOmittedCandidatesList = providerBoundedSelection.slice(byteSelection.candidates.length);
                byteSelectionInputBytes = byteSelection.inputBytes;
                rerankerByteBudgetOmittedCandidates = byteSelection.omittedCandidateCount;
            }
            const rerankCount = rerankSlice.length;
            rerankerCandidatesReranked = rerankCount;
            if (candidateSurvival) {
                appendSearchCandidateStage(
                    candidateSurvival,
                    "reranker_input",
                    rerankSlice,
                    undefined,
                    rerankInputMetadataMap,
                );
                for (const candidate of byteBudgetOmittedCandidatesList) {
                    appendSearchCandidateRemoval(candidateSurvival, {
                        candidateId: searchCandidateIdentity(candidate.result).candidateId,
                        afterStage: "mcp_ranked",
                        reason: "reranker_input_byte_budget",
                    });
                }
            }
            if (rerankCount === 0) {
                return {
                    exactMatchPinningApplied,
                    rerankerAttempted,
                    rerankerApplied,
                    orderAuthority,
                    skippedByExactPin,
                    rerankerCandidatesIn,
                    rerankerCandidatesReranked,
                    rerankerFamilyCount,
                    rerankerSupplementalCandidates,
                    rerankerCandidatePoolCount,
                    rerankerCandidateBudget,
                    rerankerBudgetReason,
                    rerankerByteBudgetOmittedCandidates,
                    warnings: phaseWarnings,
                    ...(projectionSummary ? { projection: projectionSummary } : {}),
                };
            }
            rerankerAttempted = true;
            searchDiagnostics.rerankerCalls += 1;
            searchDiagnostics.rerankerCandidates += rerankDocuments.length;
            searchDiagnostics.rerankerInputBytes += byteSelectionInputBytes;
            let rerankResults: RerankResult[] = [];
            let rerankerExecutionDiagnosticsObserved = false;
            try {
                rerankResults = await host.measureSearchPhase(
                    'rerank',
                    () => host.reranker!.rerank(input.rerankQuery, rerankDocuments, {
                        topK: rerankCount,
                        truncation: true,
                        returnDocuments: false,
                        identities: rerankSlice.map((candidate) => (
                            searchCandidateIdentity(candidate.result).candidateId
                        )),
                        // Execution telemetry fires on success and terminal
                        // failure alike, so retries hidden by a later success
                        // are still counted. Max-based so repeated reports
                        // never lose a higher count.
                        onExecutionDiagnostics: (diagnostics) => {
                            rerankerExecutionDiagnosticsObserved = true;
                            searchDiagnostics.rerankerExecutionDiagnostics = diagnostics;
                            searchDiagnostics.rerankerRetries = Math.max(
                                searchDiagnostics.rerankerRetries,
                                diagnostics.retries,
                            );
                            searchDiagnostics.rerankerTimeouts = Math.max(
                                searchDiagnostics.rerankerTimeouts,
                                diagnostics.timeouts,
                            );
                        },
                    }),
                );
            } catch (error) {
                rerankerFailurePhase = 'api_call';
                rerankerOperationalReason = resolveLateOnOperationalReason(error);
                if (error instanceof RerankerRequestError) {
                    searchDiagnostics.rerankerFailureKind = error.kind;
                    if (!rerankerExecutionDiagnosticsObserved) {
                        // Fallback for rerankers that throw RerankerRequestError
                        // without reporting execution diagnostics: the terminal
                        // error still carries attempt counts.
                        searchDiagnostics.rerankerRetries = Math.max(
                            searchDiagnostics.rerankerRetries,
                            Math.max(0, error.attempts - 1),
                        );
                        if (error.kind === 'timeout') {
                            searchDiagnostics.rerankerTimeouts = Math.max(
                                searchDiagnostics.rerankerTimeouts,
                                1,
                            );
                        }
                    }
                }
                throw new Error('reranker_api_call_failed');
            }

            try {
                if (!Array.isArray(rerankResults)) {
                    throw new Error("reranker_result_malformed");
                }

                const selectedCandidateIds = rerankSlice.map((candidate) => (
                    searchCandidateIdentity(candidate.result).candidateId
                ));
                const validatedItems = validateNativeRerankResults({
                    candidateIds: selectedCandidateIds,
                    results: rerankResults,
                });
                const reordered = applyNativeRerankToSelectedSlots({
                    allCandidates: scored,
                    selectedCandidateIds,
                    orderedItems: validatedItems,
                    identify: (candidate) => searchCandidateIdentity(candidate.result).candidateId,
                });
                for (const item of validatedItems) {
                    const candidate = rerankSlice[item.originalIndex]!;
                    candidate.rerankerRank = item.providerRank;
                    candidate.rerankerScore = item.relevanceScore;
                    candidate.rerankAdjusted = true;
                }
                scored.splice(0, scored.length, ...reordered);
                orderAuthority = "reranker_order";
                rerankerApplied = validatedItems.length > 0;
                if (candidateSurvival) {
                    appendSearchCandidateStage(
                        candidateSurvival,
                        "reranker_output",
                        validatedItems.map((item) => rerankSlice[item.originalIndex]!),
                    );
                }
            } catch {
                rerankerFailurePhase = 'parse_results';
                throw new Error('reranker_parse_failed');
            }
            if (rerankerApplied && lateOnProvider) {
                rerankerOperationalReason = "lateon_applied";
            }
        } catch {
            rerankerFailurePhase ||= 'parse_results';
            // Every terminal reranker failure -- api_call, document
            // projection, parse/invalid results -- counts exactly once here.
            searchDiagnostics.rerankerFailures += 1;
        }
    }

    assignAuthoritativeRanks(scored);
    return {
        exactMatchPinningApplied,
        rerankerAttempted,
        rerankerApplied,
        orderAuthority,
        skippedByExactPin,
        rerankerFailurePhase,
        rerankerOperationalReason,
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
        rerankerFamilyCount,
        rerankerSupplementalCandidates,
        rerankerCandidatePoolCount,
        rerankerCandidateBudget,
        rerankerBudgetReason,
        rerankerByteBudgetOmittedCandidates,
        rerankerFailureKind: searchDiagnostics.rerankerFailureKind,
        warnings: rerankerFailurePhase
            ? [...phaseWarnings, WARNING_CODES.RERANKER_FAILED]
            : phaseWarnings,
        ...(projectionSummary ? { projection: projectionSummary } : {}),
    };
}

function buildEmptyFilterSummary(): SearchFilterSummary {
    return {
        removedByRequestedSubdirectory: 0,
        removedByScope: 0,
        removedByLanguage: 0,
        removedByPathInclude: 0,
        removedByPathExclude: 0,
        removedByMust: 0,
        removedByExclude: 0,
    };
}

/**
 * Plain rerank document for providers that do not receive the publication-bound
 * canonical projection (native rerankers). This is an unversioned provider
 * document, not a document projection: no projection policy or identity
 * attaches to it.
 */
function buildNativeProviderRerankDocument(result: SearchResultLike): string {
    const relativePath = typeof result?.relativePath === "string"
        ? result.relativePath
        : "";
    const language = typeof result?.language === "string"
        ? result.language
        : "unknown";
    const symbolLabel = typeof result?.symbolLabel === "string"
        ? result.symbolLabel
        : "";
    const content = typeof result?.content === "string" ? result.content : "";
    const contentLines = content.split(/\r?\n/).slice(0, SEARCH_RERANK_DOC_MAX_LINES);
    let normalizedContent = contentLines.join("\n");
    if (normalizedContent.length > SEARCH_RERANK_DOC_MAX_CHARS) {
        normalizedContent = normalizedContent.slice(0, SEARCH_RERANK_DOC_MAX_CHARS);
    }
    return `${relativePath}\n${language}\n${symbolLabel}\n${normalizedContent}`;
}

export async function runSearchExecution(
    input: SearchExecutionInput,
    host: SearchExecutionHost,
    searchDiagnostics: SearchDiagnostics,
): Promise<SearchExecutionOutcome> {
    const expandedQuery = `${input.semanticQuery}\nimplementation runtime source entrypoint`;
    const candidateSurvival = input.debugMode === "full"
        ? createSearchCandidateSurvivalTrace()
        : undefined;
    const retrievalPolicy = input.retrievalPolicy;
    const maxAttempts = retrievalPolicy.maxAttempts;
    let candidateLimit = retrievalPolicy.candidateLimit;
    let trackedLexicalDebug: TrackedLexicalSearchDebug | undefined;
    const operatorSummary = host.searchQuerySupport.buildOperatorSummary(input.parsedOperators);
    let filterSummary = buildEmptyFilterSummary();
    const observedChangedFilesState = input.observedChangedFilesState;
    const changedFilesState = input.rankingMode === "auto_changed_first"
        ? observedChangedFilesState
        : { available: observedChangedFilesState.available, files: new Set<string>() };
    const debugChangedFilesState = input.debugMode === "freshness" || input.debugMode === "full"
        ? observedChangedFilesState
        : undefined;
    const changedFilesCount = changedFilesState.files.size;
    const observedChangedFilesCount = observedChangedFilesState.files.size;
    const normalizedObservedChangedFiles = new Set(
        [...observedChangedFilesState.files].map((relativePath) => relativePath.replace(/\\/g, "/").replace(/^\/+/, "")),
    );
    const changedFilesBoostSkippedForLargeChangeSet = false;
    const freshnessSummary: SearchFreshnessSummary = {
        syncMode: input.freshnessMode,
        lastSyncAt: null,
        changedFileCount: observedChangedFilesCount,
        gitDirtyFilesConsidered: observedChangedFilesState.available,
        changedFilesBoostApplied: false,
        changedFilesBoostSkippedForLargeChangeSet,
    };
    const publicationOnlyStaleRead = input.freshnessMode === "served_previous_generation";
    const allowLiveWorkingTreeEvidence = !publicationOnlyStaleRead;
    const dirtyFilesNotFreshened = allowLiveWorkingTreeEvidence && input.dirtyFilesNotFreshened;
    const canSupplementLivePathEvidence = allowLiveWorkingTreeEvidence
        && input.parsedOperators.path.length > 0;

    let boostedCandidates = 0;
    let attemptsUsed = 0;
    const searchWarningsSet = new Set<string>();
    const semanticPassFailures: SemanticPassFailureDiagnostic[] = [];
    const suppressedDirtyPaths = new Set<string>();
    const representedDirtyPaths = new Set<string>();
    const passesUsed = new Set<string>();
    const backendScoreKinds = new Set<BackendScoreKind>();
    let scored: SearchCandidate[] = [];
    let mustConstraintRetrievalOutcome: MustConstraintRetrievalOutcome | null = null;
    let mustLaneSkippedByPrimaryLimit = false;
    let exactMatchPinningApplied = false;
    const rankingProvenance: SearchExecutionRankingProvenance = {
        semanticPassesUsed: [],
        lexicalPassesUsed: [],
        livePathSupplementUsed: false,
        lexicalFileScanUsed: false,
        rerankApplied: false,
        exactMatchPinningApplied: false,
        registryRepairGroupCount: 0,
    };
    let semanticExpansion: SearchExpansionDecision & { attempted: boolean } = {
        expand: false,
        attempted: false,
        reason: input.queryPlan.retrievalMode === "lexical"
            ? "lexical_route"
            : "primary_candidate_pool_sufficient",
        primaryScopedCandidateCount: 0,
    };
    searchDiagnostics.routeKind = input.queryPlan.route.kind;
    searchDiagnostics.retrievalMode = input.queryPlan.retrievalMode;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attemptsUsed = attempt + 1;
        const runPasses = (passDescriptors: Array<{ id: SearchPassId; query: string }>) => {
            searchDiagnostics.searchPassCount += passDescriptors.length;
            return host.measureSearchPhase(
                "semanticSearch",
                () => Promise.allSettled(passDescriptors.map(async (pass) => {
                if ((host.shouldForceSearchPassFailure ?? shouldForceSearchPassFailure)(pass.id)) {
                    throw new Error(`FORCED_TEST_SEARCH_PASS_FAILURE:${pass.id}`);
                }
                searchDiagnostics.semanticSearchAttempts += 1;
                if (input.queryPlan.retrievalMode !== "lexical") {
                    searchDiagnostics.embeddingCallsByCurrentContract += 1;
                    searchDiagnostics.denseQueriesByCurrentContract += 1;
                }
                if (input.queryPlan.retrievalMode !== "dense") {
                    searchDiagnostics.sparseQueriesByCurrentContract += 1;
                }
                const scorePolicy = input.queryPlan.scorePolicyKind === "topk_only"
                    ? { kind: "topk_only" as const }
                    : { kind: "dense_similarity_min" as const, min: 0.3 };
                const diagnosticLexicalFallbackTerms = retrievalPolicy.diagnosticCandidateLimit !== undefined
                    ? host.searchQuerySupport
                        .buildSearchQueryPlan(pass.query, input.parsedOperators)
                        .lexicalTerms
                        .map((term) => term.value)
                    : [];
                return host.semanticSearch({
                    codebasePath: input.effectiveRoot,
                    query: pass.query,
                    topK: candidateLimit,
                    retrievalMode: input.queryPlan.retrievalMode,
                    scorePolicy,
                    ...(diagnosticLexicalFallbackTerms.length > 0
                        ? { diagnosticLexicalFallbackTerms }
                        : {}),
                });
                })),
            );
        };
        const primaryDescriptor = { id: "primary" as const, query: input.semanticQuery };
        const primarySettled = await runPasses([primaryDescriptor]);
        const primaryResult = primarySettled[0];
        const primaryEmbeddingDiagnostic = primaryResult.status === "rejected"
            ? host.classifyEmbeddingProviderError(primaryResult.reason)
            : null;
        const primaryResults = primaryResult.status === "fulfilled"
            ? Array.isArray(primaryResult.value)
                ? primaryResult.value
                : primaryResult.value.results
            : [];
        const primaryScopedCandidateCount = new Set(primaryResults
            .filter((result) => {
                if (!result || typeof result.relativePath !== "string") return false;
                const normalizedPath = result.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
                if (dirtyFilesNotFreshened && normalizedObservedChangedFiles.has(normalizedPath)) return false;
                return shouldIncludeCategoryInScope(input.scope, classifyPathCategory(normalizedPath));
            })
            .map((result) => `${result.relativePath}:${result.startLine}:${result.endLine}:${result.language || "unknown"}`))
            .size;
        const expansionDecision = resolveSearchExpansionDecision({
            retrievalMode: input.queryPlan.retrievalMode,
            routeKind: input.queryPlan.route.kind,
            exactRegistryFallback: input.exactRegistryEligible,
            operatorConstraintPresent: input.parsedOperators.must.length > 0,
            explicitRoleCuePresent: input.queryPlan.implementationSeeking
                || input.queryPlan.testSeeking
                || input.queryPlan.writerSeeking,
            primaryScopedCandidateCount,
            primaryFailed: primaryResult.status === "rejected",
            primaryFailureRetryable: primaryEmbeddingDiagnostic?.retryable,
        });
        semanticExpansion = {
            ...expansionDecision,
            attempted: expansionDecision.expand,
        };
        searchDiagnostics.semanticExpansionAttempted ||= expansionDecision.expand;
        searchDiagnostics.semanticExpansionReason = expansionDecision.reason;
        const passDescriptors: Array<{ id: SearchPassId; query: string }> = [primaryDescriptor];
        const passSettled = [...primarySettled];
        if (expansionDecision.expand) {
            const expandedDescriptor = { id: "expanded" as const, query: expandedQuery };
            passDescriptors.push(expandedDescriptor);
            passSettled.push(...await runPasses([expandedDescriptor]));
        }

        const successfulPasses: Array<{
            id: string;
            results: SearchResultLike[];
            diagnosticCandidateArms?: SemanticSearchExecutionResult["diagnosticCandidateArms"];
        }> = [];
        let embeddingProviderDiagnostic = primaryEmbeddingDiagnostic;
        let vectorBackendDiagnostic: VectorBackendDiagnostic | null = null;
        for (let idx = 0; idx < passSettled.length; idx++) {
            const passResult = passSettled[idx];
            const passDescriptor = passDescriptors[idx];
            if (passResult.status === "fulfilled") {
                const results = Array.isArray(passResult.value)
                    ? passResult.value
                    : passResult.value.results;
                successfulPasses.push({
                    id: passDescriptor.id,
                    results,
                    ...(!Array.isArray(passResult.value) && passResult.value.diagnosticCandidateArms
                        ? { diagnosticCandidateArms: passResult.value.diagnosticCandidateArms }
                        : {}),
                });
                if (candidateSurvival && !Array.isArray(passResult.value)) {
                    const tracePassId = `attempt:${attempt + 1}/${passDescriptor.id}`;
                    appendCoreCandidateTrace(
                        candidateSurvival,
                        tracePassId,
                        passResult.value.candidateTrace,
                    );
                }
                passesUsed.add(passDescriptor.id);
                continue;
            }

            const passEmbeddingDiagnostic = host.classifyEmbeddingProviderError(passResult.reason);
            const passVectorDiagnostic = passEmbeddingDiagnostic
                ? null
                : host.classifyVectorBackendError(passResult.reason);
            embeddingProviderDiagnostic ??= passEmbeddingDiagnostic;
            vectorBackendDiagnostic ??= passVectorDiagnostic;
            semanticPassFailures.push(buildSemanticPassFailureDiagnostic({
                passId: passDescriptor.id,
                error: passResult.reason,
                embeddingDiagnostic: passEmbeddingDiagnostic,
                vectorDiagnostic: passVectorDiagnostic,
            }));
            searchWarningsSet.add(buildSearchPassWarningHelper(passDescriptor.id));
        }

        searchDiagnostics.searchPassSuccessCount += successfulPasses.length;
        searchDiagnostics.searchPassFailureCount += passDescriptors.length - successfulPasses.length;
        searchDiagnostics.semanticPassFailures = semanticPassFailures.map((failure) => ({ ...failure }));

        if (successfulPasses.length === 0) {
            if (embeddingProviderDiagnostic) {
                return {
                    kind: "embedding_provider_unavailable",
                    diagnostic: embeddingProviderDiagnostic,
                };
            }
            if (vectorBackendDiagnostic) {
                return {
                    kind: "vector_backend_unavailable",
                    diagnostic: vectorBackendDiagnostic,
                };
            }
            return {
                kind: "all_semantic_passes_failed",
                semanticPassFailures,
            };
        }

        const byChunkKey = new Map<string, SearchCandidate>();
        let attemptFilterSummary = buildEmptyFilterSummary();
        const createCandidate = (
            result: SearchResultLike,
            fusionScore: number,
            retrievalPasses: string[],
        ): SearchCandidate => {
            const backendScoreKind = typeof result.backendScoreKind === "string"
                ? result.backendScoreKind as BackendScoreKind
                : "unknown";
            const backendScore = typeof result.backendScore === "number"
                ? result.backendScore
                : (typeof result.score === "number" ? result.score : 0);
            return {
                result,
                baseScore: backendScore,
                backendScore,
                backendScoreKind,
                backendScoreKindsSeen: [backendScoreKind],
                fusionScore,
                lexicalScore: 0,
                finalScore: 0,
                pathCategory: "neutral",
                pathMultiplier: 1.0,
                changedFilesMultiplier: 1.0,
                agentFitMultiplier: 1,
                agentFitReason: "neutral",
                entrypointOwnerScoreBoost: 0,
                entrypointOwnerScoreReason: "not_applicable",
                passesMatchedMust: false,
                exactLexicalMatch: false,
                exactMatchPinned: false,
                rerankAdjusted: false,
                authoritativeRank: 0,
                retrievalPasses,
            };
        };
        const addPass = (results: SearchResultLike[], passId: string, passWeight = 1) => {
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (!result || typeof result.relativePath !== "string") continue;
                const normalizedResultPath = result.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
                if (
                    dirtyFilesNotFreshened
                    && passId !== "dirty_overlay"
                    && normalizedObservedChangedFiles.has(normalizedResultPath)
                ) {
                    suppressedDirtyPaths.add(normalizedResultPath);
                    if (candidateSurvival) {
                        appendSearchCandidateRemoval(candidateSurvival, {
                            candidateId: searchCandidateIdentity(result).candidateId,
                            afterStage: "mcp_filtered",
                            reason: "dirty_source_suppressed",
                            passId: `attempt:${attempt + 1}/${passId}`,
                        });
                    }
                    continue;
                }
                if (passId === "dirty_overlay") {
                    representedDirtyPaths.add(normalizedResultPath);
                }
                const key = `${result.relativePath}:${result.startLine}:${result.endLine}:${result.language || "unknown"}`;
                const rank = i + 1;
                const rrf = passWeight * (1 / (SEARCH_RRF_K + rank));
                const existing = byChunkKey.get(key);
                if (!existing) {
                    const backendScoreKind = typeof result.backendScoreKind === "string"
                        ? result.backendScoreKind as BackendScoreKind
                        : "unknown";
                    backendScoreKinds.add(backendScoreKind);
                    byChunkKey.set(key, createCandidate(result, rrf, [passId]));
                } else {
                    existing.fusionScore += rrf;
                    const nextScore = typeof result.backendScore === "number"
                        ? result.backendScore
                        : (typeof result.score === "number" ? result.score : undefined);
                    if (typeof nextScore === "number") {
                        existing.baseScore = Math.max(existing.baseScore, nextScore);
                        existing.backendScore = Math.max(existing.backendScore, nextScore);
                    }
                    if (typeof result.backendScoreKind === "string") {
                        backendScoreKinds.add(result.backendScoreKind as BackendScoreKind);
                        if (!existing.backendScoreKindsSeen.includes(result.backendScoreKind as BackendScoreKind)) {
                            existing.backendScoreKindsSeen.push(result.backendScoreKind as BackendScoreKind);
                        }
                    }
                    if (!existing.retrievalPasses.includes(passId)) {
                        existing.retrievalPasses.push(passId);
                    }
                }
            }
        };

        for (const pass of successfulPasses) {
            if (candidateSurvival) {
                appendSearchCandidatePass(
                    candidateSurvival,
                    pass.results,
                    `attempt:${attempt + 1}/${pass.id}`,
                    1,
                );
            }
            addPass(pass.results, pass.id, 1);
        }

        if (dirtyFilesNotFreshened) {
            const dirtyOverlayResults = await host.measureSearchPhase(
                "trackedLexical",
                () => host.searchQuerySupport.buildDirtyFileSearchResults({
                    effectiveRoot: input.effectiveRoot,
                    queryPlan: input.queryPlan,
                    changedFiles: observedChangedFilesState.files,
                }),
            );
            if (dirtyOverlayResults.length > 0) {
                // This pass replaces every stale semantic pass for the dirty path,
                // so retain equivalent fusion weight instead of penalizing freshness.
                if (candidateSurvival) {
                    appendSearchCandidatePass(
                        candidateSurvival,
                        dirtyOverlayResults,
                        `attempt:${attempt + 1}/dirty_overlay`,
                        successfulPasses.length,
                    );
                }
                addPass(dirtyOverlayResults, "dirty_overlay", successfulPasses.length);
                passesUsed.add("dirty_overlay");
            }
        }

        const trackedLexical = !publicationOnlyStaleRead
            ? await host.measureSearchPhase(
                "trackedLexical",
                async () => host.searchQuerySupport.buildTrackedLexicalSearchResults({
                    effectiveRoot: input.effectiveRoot,
                    parsedOperators: input.parsedOperators,
                    queryPlan: input.queryPlan,
                    scope: input.scope,
                    limit: candidateLimit,
                    exactRegistryFallback: input.exactRegistryFallbackForTrackedLexical,
                }),
            )
            : { results: [], debug: undefined };
        trackedLexicalDebug = trackedLexical.debug;
        if (trackedLexical.results.length > 0) {
            if (candidateSurvival) {
                appendSearchCandidatePass(
                    candidateSurvival,
                    trackedLexical.results,
                    `attempt:${attempt + 1}/lexical_files`,
                    1,
                );
            }
            addPass(trackedLexical.results, "lexical_files", 1);
            passesUsed.add("lexical_files");
        }

        if (canSupplementLivePathEvidence) {
            const livePathResults = await host.searchQuerySupport.buildLivePathScopedSearchResults({
                effectiveRoot: input.effectiveRoot,
                parsedOperators: input.parsedOperators,
                queryPlan: input.queryPlan,
                changedFiles: observedChangedFilesState.files,
            });
            if (livePathResults.length > 0) {
                if (candidateSurvival) {
                    appendSearchCandidatePass(
                        candidateSurvival,
                        livePathResults,
                        `attempt:${attempt + 1}/live_path`,
                        1,
                    );
                }
                addPass(livePathResults, "live_path", 1);
                passesUsed.add("live_path");
            }
        }

        if (candidateSurvival) {
            const fusedForTrace = [...byChunkKey.values()].sort((left, right) => {
                const scoreOrder = right.fusionScore - left.fusionScore;
                if (scoreOrder !== 0) return scoreOrder;
                const leftId = searchCandidateIdentity(left.result).candidateId;
                const rightId = searchCandidateIdentity(right.result).candidateId;
                return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
            });
            appendSearchCandidateStage(
                candidateSurvival,
                "mcp_fusion",
                fusedForTrace,
                `attempt:${attempt + 1}`,
            );
        }

        let scoredAttempt: SearchCandidate[] = [];
        const evaluateCandidate = (
            candidate: SearchCandidate,
            summary: SearchFilterSummary,
            recordRemoval: (
                candidate: SearchCandidate,
                reason: Parameters<typeof appendSearchCandidateRemoval>[1]["reason"],
            ) => void,
        ): boolean => {
            const category = classifyPathCategory(candidate.result.relativePath);
            if (!shouldIncludeCategoryInScope(input.scope, category)) {
                summary.removedByScope += 1;
                recordRemoval(candidate, "scope_filter");
                return false;
            }

            if (!candidateWithinRequestedSubdirectory(
                String(candidate.result.relativePath || ""),
                input.requestedSubdirectory ?? null,
            )) {
                summary.removedByRequestedSubdirectory += 1;
                recordRemoval(candidate, "requested_subdirectory_filter");
                return false;
            }

            const languageValue = typeof candidate.result.language === "string"
                ? candidate.result.language.toLowerCase()
                : "unknown";
            if (input.parsedOperators.lang.length > 0 && !input.parsedOperators.lang.includes(languageValue)) {
                summary.removedByLanguage += 1;
                recordRemoval(candidate, "language_filter");
                return false;
            }

            const relativePath = String(candidate.result.relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
            if (input.parsedOperators.path.length > 0 && !host.searchQuerySupport.pathMatchesAnyPattern(relativePath, input.parsedOperators.path)) {
                summary.removedByPathInclude += 1;
                recordRemoval(candidate, "path_include_filter");
                return false;
            }

            if (input.parsedOperators.excludePath.length > 0 && host.searchQuerySupport.pathMatchesAnyPattern(relativePath, input.parsedOperators.excludePath)) {
                summary.removedByPathExclude += 1;
                recordRemoval(candidate, "path_exclude_filter");
                return false;
            }

            const symbolLabel = typeof candidate.result.symbolLabel === "string" ? candidate.result.symbolLabel : "";
            const content = typeof candidate.result.content === "string" ? candidate.result.content : "";
            const fields = [symbolLabel, relativePath, content];
            const matchesMust = input.parsedOperators.must.every((token) => host.searchQuerySupport.tokenMatchesAnyField(token, fields));
            if (!matchesMust) {
                summary.removedByMust += 1;
                recordRemoval(candidate, "must_filter");
                return false;
            }

            const matchesExclude = input.parsedOperators.exclude.some((token) => host.searchQuerySupport.tokenMatchesAnyField(token, fields));
            if (matchesExclude) {
                summary.removedByExclude += 1;
                recordRemoval(candidate, "exclude_filter");
                return false;
            }

            candidate.pathCategory = category;
            candidate.pathMultiplier = 1;
            candidate.changedFilesMultiplier = 1;
            candidate.agentFitMultiplier = 1;
            candidate.agentFitReason = "not_used_for_ranking";
            candidate.entrypointOwnerScoreBoost = 0;
            candidate.entrypointOwnerScoreReason = "not_used_for_ranking";
            candidate.passesMatchedMust = matchesMust;
            const lexicalEvidence = host.searchQuerySupport.detectSearchLexicalEvidence(input.queryPlan, candidate.result);
            candidate.lexicalScore = 0;
            candidate.exactLexicalMatch = lexicalEvidence.exactLexicalMatch;
            candidate.finalScore = candidate.fusionScore;
            return true;
        };
        const recordFilterRemoval = (
            candidate: SearchCandidate,
            reason: Parameters<typeof appendSearchCandidateRemoval>[1]["reason"],
        ): void => {
            if (!candidateSurvival) return;
            appendSearchCandidateRemoval(candidateSurvival, {
                candidateId: searchCandidateIdentity(candidate.result).candidateId,
                afterStage: "mcp_filtered",
                reason,
                passId: `attempt:${attempt + 1}`,
            });
        };
        const evaluateAllCandidates = (): void => {
            scoredAttempt = [];
            for (const candidate of byChunkKey.values()) {
                if (evaluateCandidate(candidate, attemptFilterSummary, recordFilterRemoval)) {
                    scoredAttempt.push(candidate);
                }
            }
        };
        evaluateAllCandidates();

        // Bounded must: retrieval lane. The primary semantic/lexical lanes are
        // unchanged; this lane only adds a dedicated lexical-projection query
        // whose terms are the literal must: values, merged by stable candidate
        // identity and re-evaluated through the normal filters (path, language,
        // scope, exclusions, must/exclude matching). It never scans the
        // repository directly and is capped by the operator-constraint
        // candidate maximum.
        const mustTokens = input.parsedOperators.must;
        const primaryChunkLimitFilled = scoredAttempt.length
            >= input.retrievalPolicy.retrievalResultLimit;
        const shouldRunMustLane = mustTokens.length > 0
            && (input.resultMode === "grouped" || !primaryChunkLimitFilled);
        if (
            mustTokens.length > 0
            && !shouldRunMustLane
        ) {
            // Raw mode exposes chunks directly, so a filled chunk limit retains
            // the established skip contract. Grouped mode cannot infer visible
            // capacity here and therefore always reserves the bounded lane.
            mustLaneSkippedByPrimaryLimit = true;
        }
        if (shouldRunMustLane) {
            const mustLaneBudget = retrievalPolicy.maxCandidateLimit;
            let laneResults: SearchResultLike[] = [];
            let laneFailed = false;
            let conjunctiveUnavailable = false;
            try {
                const laneResponse = await host.measureSearchPhase(
                    "semanticSearch",
                    () => host.semanticSearch({
                        codebasePath: input.effectiveRoot,
                        query: mustTokens.join(" "),
                        topK: mustLaneBudget,
                        retrievalMode: "lexical",
                        // Every must: value is mandatory: the backend must honor
                        // all-terms matching or reject the request explicitly.
                        lexicalMatchMode: "all_terms",
                        scorePolicy: { kind: "topk_only" },
                    }),
                );
                laneResults = Array.isArray(laneResponse)
                    ? laneResponse
                    : laneResponse.results;
            } catch (error) {
                if (error instanceof LexicalRetrievalModeUnsupportedError) {
                    // The backend cannot guarantee conjunctive semantics; do not
                    // silently run provider-defined sparse matching and never
                    // claim the must: lane examined the candidate pool.
                    conjunctiveUnavailable = true;
                } else {
                    // A lane failure is bounded: keep the primary results and
                    // report that the budget could not be fully examined.
                    laneFailed = true;
                }
            }
            if (conjunctiveUnavailable) {
                searchWarningsSet.add(WARNING_CODES.MUST_CONJUNCTIVE_RETRIEVAL_UNAVAILABLE);
            } else if (laneResults.length > 0) {
                if (candidateSurvival) {
                    appendSearchCandidatePass(
                        candidateSurvival,
                        laneResults,
                        `attempt:${attempt + 1}/must_lane`,
                        1,
                    );
                }
                addPass(laneResults, "must_lane", 1);
                passesUsed.add("must_lane");
                attemptFilterSummary = buildEmptyFilterSummary();
                evaluateAllCandidates();
            }
            mustConstraintRetrievalOutcome = conjunctiveUnavailable
                ? {
                    // The backend cannot guarantee conjunctive semantics, so
                    // the dedicated lane was never attempted and no budget was
                    // examined. Only the conjunctive-unavailable warning may
                    // accompany this state.
                    status: "unsupported",
                    candidatesExamined: 0,
                    candidateBudget: mustLaneBudget,
                    budgetExhausted: false,
                }
                : laneFailed
                    ? {
                        status: "failed",
                        candidatesExamined: laneResults.length,
                        candidateBudget: mustLaneBudget,
                        budgetExhausted: true,
                    }
                    : {
                        status: "attempted",
                        candidatesExamined: laneResults.length,
                        candidateBudget: mustLaneBudget,
                        budgetExhausted: laneResults.length >= mustLaneBudget,
                    };
        }

        const beforeFilter = byChunkKey.size;
        searchDiagnostics.resultsBeforeFilter = beforeFilter;
        searchDiagnostics.resultsAfterFilter = scoredAttempt.length;
        filterSummary = attemptFilterSummary;
        scored = scoredAttempt;

        const nativeOrder = sortNativeRetrievalCandidates(
            scored,
            {
                exactMatchFirst: input.queryPlan.exactMatchPinningEnabled,
                mustMatchesFirst: input.parsedOperators.must.length > 0,
            },
        );
        exactMatchPinningApplied = nativeOrder.exactMatchPinningApplied || exactMatchPinningApplied;
        rankingProvenance.exactMatchPinningApplied = exactMatchPinningApplied;
        if (candidateSurvival) {
            appendSearchCandidateStage(
                candidateSurvival,
                "mcp_filtered",
                scored,
                `attempt:${attempt + 1}`,
            );

            const diagnosticCandidates = new Map<string, SearchCandidate>();
            for (const candidate of scoredAttempt) {
                const candidateId = searchCandidateIdentity(candidate.result).candidateId;
                diagnosticCandidates.set(candidateId, candidate);
            }
            const diagnosticFilterSummary = buildEmptyFilterSummary();
            const diagnosticPassId = `attempt:${attempt + 1}/diagnostic_replay`;
            const recordDiagnosticRemoval = (
                candidate: SearchCandidate,
                reason: Parameters<typeof appendSearchCandidateRemoval>[1]["reason"],
            ): void => {
                appendSearchCandidateRemoval(candidateSurvival, {
                    candidateId: searchCandidateIdentity(candidate.result).candidateId,
                    afterStage: "mcp_filtered",
                    reason,
                    passId: diagnosticPassId,
                });
            };
            for (const pass of successfulPasses) {
                const arms = pass.diagnosticCandidateArms;
                if (!arms) continue;
                const rawCandidates = [
                    ...(arms.dense ?? []),
                    ...(arms.preciseLexical ?? []),
                    ...(arms.fallbackLexical ?? []),
                ];
                for (const result of rawCandidates) {
                    const candidate = createCandidate(result, 0, []);
                    const candidateId = searchCandidateIdentity(result).candidateId;
                    const existing = diagnosticCandidates.get(candidateId);
                    if (existing) {
                        if (
                            existing.result.relativePath !== result.relativePath
                            || existing.result.startLine !== result.startLine
                            || existing.result.endLine !== result.endLine
                            || existing.result.content !== result.content
                        ) {
                            throw new Error(
                                `Diagnostic candidate '${candidateId}' has conflicting source payloads.`,
                            );
                        }
                        continue;
                    }
                    const normalizedPath = result.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
                    if (dirtyFilesNotFreshened && normalizedObservedChangedFiles.has(normalizedPath)) {
                        recordDiagnosticRemoval(candidate, "dirty_source_suppressed");
                        continue;
                    }
                    if (!evaluateCandidate(
                        candidate,
                        diagnosticFilterSummary,
                        recordDiagnosticRemoval,
                    )) {
                        continue;
                    }
                    diagnosticCandidates.set(candidateId, candidate);
                }
            }
            const replaySignals = [...diagnosticCandidates.values()];
            sortNativeRetrievalCandidates(
                replaySignals,
                {
                    exactMatchFirst: input.queryPlan.exactMatchPinningEnabled,
                    mustMatchesFirst: input.parsedOperators.must.length > 0,
                },
            );
            const replayAttemptId = `attempt:${attempt + 1}`;
            if (replaySignals.length === 0) {
                appendSearchCandidateStage(
                    candidateSurvival,
                    "mcp_replay_signals",
                    replaySignals,
                    `${replayAttemptId}/replay:1`,
                );
            } else {
                for (
                    let offset = 0, chunk = 1;
                    offset < replaySignals.length;
                    offset += SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE, chunk += 1
                ) {
                    appendSearchCandidateStage(
                        candidateSurvival,
                        "mcp_replay_signals",
                        replaySignals.slice(
                            offset,
                            offset + SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE,
                        ),
                        `${replayAttemptId}/replay:${chunk}`,
                    );
                }
            }
        }

        if (
            input.parsedOperators.must.length === 0
            || scored.length >= input.retrievalPolicy.retrievalResultLimit
            || attempt === maxAttempts - 1
            || candidateLimit >= retrievalPolicy.maxCandidateLimit
        ) {
            break;
        }

        candidateLimit = resolveNextSearchCandidateLimit(candidateLimit);
    }

    const searchWarnings = Array.from(searchWarningsSet);
    if (dirtyFilesNotFreshened) {
        searchWarnings.push(WARNING_CODES.SEARCH_DIRTY_WORKTREE_NOT_SYNCED);
    }
    if ([...suppressedDirtyPaths].some((relativePath) => !representedDirtyPaths.has(relativePath))) {
        searchWarnings.push(WARNING_CODES.SEARCH_DIRTY_FILE_EVIDENCE_UNAVAILABLE);
    }
    if (changedFilesBoostSkippedForLargeChangeSet) {
        searchWarnings.push(WARNING_CODES.SEARCH_CHANGED_FILES_BOOST_SKIPPED);
    }
    freshnessSummary.changedFilesBoostApplied = boostedCandidates > 0;

    const rerankPhase = await rerankSearchCandidates(
        input,
        host,
        searchDiagnostics,
        scored,
        exactMatchPinningApplied,
        candidateSurvival,
    );
    exactMatchPinningApplied = rerankPhase.exactMatchPinningApplied;
    searchWarnings.push(...rerankPhase.warnings);
    const {
        rerankerAttempted,
        rerankerApplied,
        orderAuthority,
        skippedByExactPin,
        rerankerFailurePhase,
        rerankerOperationalReason,
        rerankerFailureKind,
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
        rerankerFamilyCount,
        rerankerSupplementalCandidates,
        rerankerCandidatePoolCount,
        rerankerCandidateBudget,
        rerankerBudgetReason,
        rerankerByteBudgetOmittedCandidates,
        projection: rerankerProjection,
    } = rerankPhase;

    searchDiagnostics.excludedByIgnore = Math.max(0, searchDiagnostics.resultsBeforeFilter - searchDiagnostics.resultsAfterFilter);
    searchDiagnostics.rerankerAttempted = rerankerAttempted;
    searchDiagnostics.rerankerUsed = rerankerApplied;
    const remotePassIds = new Set(["primary", "expanded"]);
    searchDiagnostics.candidatesWithSemanticEvidence = input.queryPlan.retrievalMode === "lexical"
        ? 0
        : scored.filter((candidate) => candidate.retrievalPasses.some((pass) => remotePassIds.has(pass))).length;
    searchDiagnostics.candidatesWithLexicalEvidence = scored.filter((candidate) => (
        candidate.retrievalPasses.includes("lexical_files")
        || candidate.retrievalPasses.includes("must_lane")
        || (input.queryPlan.retrievalMode === "lexical"
            && candidate.retrievalPasses.some((pass) => remotePassIds.has(pass)))
    )).length;
    searchDiagnostics.candidatesWithCurrentSourceEvidence = scored.filter((candidate) => (
        candidate.retrievalPasses.includes("dirty_overlay")
        || candidate.retrievalPasses.includes("live_path")
    )).length;
    rankingProvenance.semanticPassesUsed = Array.from(passesUsed).filter((passId) => passId === "primary" || passId === "expanded").sort();
    rankingProvenance.lexicalPassesUsed = Array.from(passesUsed).filter((passId) => passId === "lexical_files" || passId === "live_path" || passId === "dirty_overlay" || passId === "must_lane").sort();
    rankingProvenance.livePathSupplementUsed = passesUsed.has("live_path");
    rankingProvenance.lexicalFileScanUsed = passesUsed.has("lexical_files");
    rankingProvenance.rerankApplied = rerankerApplied;
    rankingProvenance.exactMatchPinningApplied = exactMatchPinningApplied;
    const mustApplied = input.parsedOperators.must.length > 0;
    const mustSatisfied = !mustApplied || scored.length > 0;
    const mustCoverage = buildSearchMustCoverage(
        mustConstraintRetrievalOutcome,
        mustLaneSkippedByPrimaryLimit,
        retrievalPolicy.maxCandidateLimit,
    );
    const attemptedMustLaneFoundNoMatch = mustApplied
        && !mustSatisfied
        && mustConstraintRetrievalOutcome?.status === "attempted";
    if (mustApplied && !mustSatisfied && mustCoverage === null) {
        searchWarnings.push("FILTER_MUST_UNSATISFIED");
    }
    if (mustApplied && mustConstraintRetrievalOutcome?.status === "failed") {
        searchWarnings.push(WARNING_CODES.MUST_CONJUNCTIVE_RETRIEVAL_FAILED);
    }
    if (
        attemptedMustLaneFoundNoMatch
    ) {
        searchWarnings.push(WARNING_CODES.MUST_NOT_SATISFIED_WITHIN_RETRIEVAL_BUDGET);
    }
    if (
        mustApplied
        && mustCoverage?.moreMayExist
        && !attemptedMustLaneFoundNoMatch
    ) {
        searchWarnings.push(WARNING_CODES.MUST_RESULTS_MAY_BE_INCOMPLETE_WITHIN_RETRIEVAL_BUDGET);
    }
    if (candidateSurvival) {
        appendSearchCandidateStage(candidateSurvival, "mcp_ranked", scored);
    }

    return {
        kind: "ok",
        scored,
        operatorSummary,
        filterSummary,
        freshnessSummary,
        dirtyFilesNotFreshened,
        trackedLexicalDebug,
        candidateLimit,
        ...(retrievalPolicy.diagnosticCandidateLimit !== undefined
            ? { diagnosticCandidateLimit: retrievalPolicy.diagnosticCandidateLimit }
            : {}),
        attemptsUsed,
        searchWarnings: Array.from(new Set(searchWarnings)).sort(),
        searchWarningsSet,
        passesUsed,
        backendScoreKinds,
        exactMatchPinningApplied,
        boostedCandidates,
        changedFilesState,
        debugChangedFilesState,
        changedFilesCount,
        changedFilesBoostSkippedForLargeChangeSet,
        rankingProvenance,
        rerankerAttempted,
        rerankerApplied,
        orderAuthority,
        skippedByExactPin,
        rerankerFailurePhase,
        rerankerOperationalReason,
        rerankerFailureKind,
        ...(searchDiagnostics.rerankerExecutionDiagnostics
            ? { rerankerExecutionDiagnostics: searchDiagnostics.rerankerExecutionDiagnostics }
            : {}),
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
        rerankerFamilyCount,
        rerankerSupplementalCandidates,
        rerankerCandidatePoolCount,
        rerankerCandidateBudget,
        rerankerBudgetReason,
        rerankerByteBudgetOmittedCandidates,
        ...(rerankerProjection ? { rerankerProjection } : {}),
        semanticExpansion,
        ...(input.entrypointOwnerEvidence
            ? { entrypointOwnerEvidence: input.entrypointOwnerEvidence }
            : {}),
        providerWork: {
            routeKind: searchDiagnostics.routeKind,
            retrievalMode: searchDiagnostics.retrievalMode,
            semanticSearchAttempts: searchDiagnostics.semanticSearchAttempts,
            embeddingCallsByCurrentContract: searchDiagnostics.embeddingCallsByCurrentContract,
            denseQueriesByCurrentContract: searchDiagnostics.denseQueriesByCurrentContract,
            sparseQueriesByCurrentContract: searchDiagnostics.sparseQueriesByCurrentContract,
            rerankerCalls: searchDiagnostics.rerankerCalls,
            rerankerCandidates: searchDiagnostics.rerankerCandidates,
            rerankerInputBytes: searchDiagnostics.rerankerInputBytes,
            rerankerFailures: searchDiagnostics.rerankerFailures,
            rerankerRetries: searchDiagnostics.rerankerRetries,
            rerankerTimeouts: searchDiagnostics.rerankerTimeouts,
            candidatesWithSemanticEvidence: searchDiagnostics.candidatesWithSemanticEvidence,
            candidatesWithLexicalEvidence: searchDiagnostics.candidatesWithLexicalEvidence,
            candidatesWithCurrentSourceEvidence: searchDiagnostics.candidatesWithCurrentSourceEvidence,
            semanticExpansionAttempted: searchDiagnostics.semanticExpansionAttempted,
            semanticExpansionReason: searchDiagnostics.semanticExpansionReason,
        },
        semanticPassFailures,
        ...(candidateSurvival ? { candidateSurvival } : {}),
        mustConstraintRetrievalOutcome,
        mustConstraintMustTokens: [...input.parsedOperators.must],
        mustCoverage,
    };
}
