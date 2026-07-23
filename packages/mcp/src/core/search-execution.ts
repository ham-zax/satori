import type {
    SemanticSearchExecutionResult,
    SemanticSearchResult,
    VoyageAIReranker,
} from "@zokizuan/satori-core";
import {
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
    SEARCH_RERANK_RRF_K,
    SEARCH_RERANK_WEIGHT,
    SEARCH_RRF_K,
    SCOPE_PATH_MULTIPLIERS,
    type PathCategory,
    type SearchRankingMode,
    type SearchScope,
} from "./search-constants.js";
import type {
    SearchCandidateSurvivalDebug,
    SearchDebugMode,
    SearchFreshnessSummary,
    SearchOperatorSummary,
    SearchProviderWorkDebugHint,
} from "./search-types.js";
import {
    appendCoreCandidateTrace,
    appendSearchCandidatePass,
    appendSearchCandidateRemoval,
    appendSearchCandidateStage,
    createSearchCandidateSurvivalTrace,
    SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE,
    searchCandidateIdentity,
} from "./search-candidate-survival.js";
import { WARNING_CODES } from "./warnings.js";
import {
    buildSearchPassWarning as buildSearchPassWarningHelper,
} from "./search-response-helpers.js";
import {
    classifyPathCategory,
    resolveAgentFitMultiplier as resolveSearchAgentFitMultiplier,
    shouldApplyChangedFilesBoost,
    shouldIncludeCategoryInScope,
    sortSearchCandidates as sortSearchCandidatesHelper,
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
    resolveRerankFamilyKey,
    selectRerankCandidates,
    selectRerankInputWithinUtf8Budget,
    type RerankBudgetReason,
} from "./search-rerank-policy.js";
import {
    resolveNextSearchCandidateLimit,
} from './search-policy.js';
import type { ResolvedSearchPolicy } from './search-policy.js';

type SearchPassId = "primary" | "expanded";
type BackendScoreKind = "dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown";
type ChangedFilesState = { available: boolean; files: Set<string> };
const SEARCH_EXPANSION_MIN_PRIMARY_SCOPED_CANDIDATES = 5;

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
    passesMatchedMust: boolean;
    exactLexicalMatch: boolean;
    exactMatchPinned: boolean;
    rerankAdjusted: boolean;
    retrievalPasses: string[];
    rerankFamilyId?: string;
    rerankDocumentUtf8Bytes?: number;
};

export type SearchFilterSummary = {
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

/**
 * Skip expensive Voyage rerank when the top candidate is already a deterministic exact pin.
 * Safe when exact lexical match owns rank-1 under pinning or must: filters.
 */
export function shouldSkipRerankForExactPin(input: {
    scored: ReadonlyArray<Pick<SearchCandidate, "exactLexicalMatch" | "passesMatchedMust">>;
    exactMatchPinningEnabled: boolean;
    mustTokenCount: number;
}): boolean {
    if (input.scored.length === 0) {
        return false;
    }
    const top = input.scored[0];
    if (!top.exactLexicalMatch) {
        return false;
    }
    if (input.exactMatchPinningEnabled) {
        return true;
    }
    if (input.mustTokenCount > 0 && top.passesMatchedMust) {
        return true;
    }
    // Sole exact lexical hit — rerank cannot improve ordering among alternatives.
    if (input.scored.length === 1) {
        return true;
    }
    return false;
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
        skippedByExactPin: boolean;
        rerankerFailurePhase?: "api_call" | "parse_results";
        rerankerCandidatesIn: number;
        rerankerCandidatesReranked: number;
        rerankerFamilyCount: number;
        rerankerSupplementalCandidates: number;
        rerankerCandidatePoolCount: number;
        rerankerCandidateBudget: number;
        rerankerBudgetReason?: RerankBudgetReason;
        rerankerByteBudgetOmittedCandidates: number;
        semanticExpansion: SearchExpansionDecision & { attempted: boolean };
        providerWork: SearchProviderWorkDiagnostics;
        candidateSurvival?: SearchCandidateSurvivalDebug;
        semanticPassFailures: SemanticPassFailureDiagnostic[];
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

export type SearchExecutionHost = {
    searchQuerySupport: SearchQuerySupport;
    semanticSearch: (request: {
        codebasePath: string;
        query: string;
        topK: number;
        retrievalMode: "dense" | "lexical" | "hybrid";
        scorePolicy: { kind: "topk_only" } | { kind: "dense_similarity_min"; min: number };
        diagnosticLexicalFallbackTerms?: string[];
    }) => Promise<SemanticSearchResult[] | SemanticSearchExecutionResult>;
    reranker: VoyageAIReranker | null;
    shouldForceSearchPassFailure: (passId: SearchPassId) => boolean;
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
    limit: number;
    debugMode: SearchDebugMode;
    semanticQuery: string;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    exactRegistryEligible: boolean;
    exactRegistryFallbackForTrackedLexical: boolean;
    freshnessMode: FreshnessDecision["mode"];
    observedChangedFilesState: ChangedFilesState;
    retrievalPolicy: ResolvedSearchPolicy;
};

type RerankPhaseResult = {
    exactMatchPinningApplied: boolean;
    rerankerAttempted: boolean;
    rerankerApplied: boolean;
    skippedByExactPin: boolean;
    rerankerFailurePhase?: 'api_call' | 'parse_results';
    rerankerCandidatesIn: number;
    rerankerCandidatesReranked: number;
    rerankerFamilyCount: number;
    rerankerSupplementalCandidates: number;
    rerankerCandidatePoolCount: number;
    rerankerCandidateBudget: number;
    rerankerBudgetReason?: RerankBudgetReason;
    rerankerByteBudgetOmittedCandidates: number;
    warning?: 'RERANKER_FAILED';
};

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
    let rerankerFailurePhase: 'api_call' | 'parse_results' | undefined;
    const rerankerCandidatesIn = scored.length;
    let rerankerCandidatesReranked = 0;
    let rerankerFamilyCount = 0;
    let rerankerSupplementalCandidates = 0;
    let rerankerCandidatePoolCount = 0;
    let rerankerCandidateBudget = 0;
    let rerankerBudgetReason: RerankBudgetReason | undefined;
    let rerankerByteBudgetOmittedCandidates = 0;
    const skippedByExactPin = Boolean(
        rerankDecision.enabled
        && host.reranker
        && scored.length > 0
        && shouldSkipRerankForExactPin({
            scored,
            exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
            mustTokenCount: input.parsedOperators.must.length,
        }),
    );

    if (rerankDecision.enabled && scored.length > 0 && host.reranker && !skippedByExactPin) {
        try {
            const selection = selectRerankCandidates({
                candidates: scored,
                requestedLimit: input.retrievalPolicy.rerankerResultLimit,
            });
            rerankerFamilyCount = selection.familyCount;
            rerankerSupplementalCandidates = selection.supplementalCandidateCount;
            rerankerCandidatePoolCount = selection.candidatePoolCount;
            rerankerCandidateBudget = selection.budget;
            rerankerBudgetReason = selection.budgetReason;
            const selectedDocuments = selection.selected.map((candidate) => (
                host.searchQuerySupport.buildRerankDocument(candidate.result)
            ));
            const byteSelection = selectRerankInputWithinUtf8Budget({
                candidates: selection.selected,
                documents: selectedDocuments,
                maxInputBytes: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
            });
            const rerankSlice = [...byteSelection.candidates];
            const rerankDocuments = [...byteSelection.documents];
            const rerankCount = rerankSlice.length;
            rerankerCandidatesReranked = rerankCount;
            rerankerByteBudgetOmittedCandidates = byteSelection.omittedCandidateCount;
            if (candidateSurvival) {
                appendSearchCandidateStage(candidateSurvival, "reranker_input", rerankSlice);
                for (const candidate of selection.selected.slice(rerankCount)) {
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
                    skippedByExactPin,
                    rerankerCandidatesIn,
                    rerankerCandidatesReranked,
                    rerankerFamilyCount,
                    rerankerSupplementalCandidates,
                    rerankerCandidatePoolCount,
                    rerankerCandidateBudget,
                    rerankerBudgetReason,
                    rerankerByteBudgetOmittedCandidates,
                };
            }
            rerankerAttempted = true;
            searchDiagnostics.rerankerCalls += 1;
            searchDiagnostics.rerankerCandidates += rerankDocuments.length;
            searchDiagnostics.rerankerInputBytes += byteSelection.inputBytes;
            let rerankResults: Array<{ index: number }> = [];
            try {
                rerankResults = await host.measureSearchPhase(
                    'rerank',
                    () => host.reranker!.rerank(input.semanticQuery, rerankDocuments, {
                        topK: rerankCount,
                        truncation: true,
                        returnDocuments: false,
                    }),
                );
            } catch {
                rerankerFailurePhase = 'api_call';
                throw new Error('reranker_api_call_failed');
            }

            const rerankRanks = new Map<number, number>();
            try {
                for (let idx = 0; idx < rerankResults.length; idx++) {
                    const originalIndex = rerankResults[idx]?.index;
                    if (
                        Number.isInteger(originalIndex)
                        && originalIndex >= 0
                        && originalIndex < rerankCount
                        && !rerankRanks.has(originalIndex)
                    ) {
                        rerankRanks.set(originalIndex, idx + 1);
                    }
                }
            } catch {
                rerankerFailurePhase = 'parse_results';
                throw new Error('reranker_parse_failed');
            }

            let rerankerUpdatedCandidates = 0;
            for (let idx = 0; idx < rerankSlice.length; idx++) {
                const rank = rerankRanks.get(idx);
                if (!rank) continue;
                const rerankRrf = 1 / (SEARCH_RERANK_RRF_K + rank);
                rerankSlice[idx].fusionScore += SEARCH_RERANK_WEIGHT * rerankRrf;
                rerankSlice[idx].finalScore = (rerankSlice[idx].fusionScore + rerankSlice[idx].lexicalScore)
                    * rerankSlice[idx].pathMultiplier
                    * rerankSlice[idx].changedFilesMultiplier
                    * rerankSlice[idx].agentFitMultiplier;
                rerankSlice[idx].rerankAdjusted = true;
                rerankerUpdatedCandidates++;
            }
            if (candidateSurvival) {
                const rerankerOutput = [...rerankRanks.entries()]
                    .sort((left, right) => left[1] - right[1])
                    .map(([originalIndex]) => rerankSlice[originalIndex])
                    .filter((candidate): candidate is SearchCandidate => Boolean(candidate));
                appendSearchCandidateStage(candidateSurvival, "reranker_output", rerankerOutput);
            }

            exactMatchPinningApplied = sortSearchCandidatesHelper(
                scored,
                rerankDecision.exactMatchPinningEnabled,
                input.parsedOperators.must.length > 0,
            ) || exactMatchPinningApplied;
            rerankerApplied = rerankerUpdatedCandidates > 0;
        } catch {
            rerankerFailurePhase ||= 'parse_results';
        }
    }

    return {
        exactMatchPinningApplied,
        rerankerAttempted,
        rerankerApplied,
        skippedByExactPin,
        rerankerFailurePhase,
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
        rerankerFamilyCount,
        rerankerSupplementalCandidates,
        rerankerCandidatePoolCount,
        rerankerCandidateBudget,
        rerankerBudgetReason,
        rerankerByteBudgetOmittedCandidates,
        ...(rerankerFailurePhase ? { warning: 'RERANKER_FAILED' as const } : {}),
    };
}

function buildEmptyFilterSummary(): SearchFilterSummary {
    return {
        removedByScope: 0,
        removedByLanguage: 0,
        removedByPathInclude: 0,
        removedByPathExclude: 0,
        removedByMust: 0,
        removedByExclude: 0,
    };
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
    const changedFilesBoostWithinThreshold = changedFilesCount > 0 && changedFilesCount <= SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES;
    const changedFilesBoostEnabled = input.rankingMode === "auto_changed_first"
        && changedFilesState.available
        && changedFilesBoostWithinThreshold;
    const changedFilesBoostSkippedForLargeChangeSet = input.rankingMode === "auto_changed_first"
        && changedFilesState.available
        && changedFilesCount > SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES;
    const freshnessSummary: SearchFreshnessSummary = {
        syncMode: input.freshnessMode,
        lastSyncAt: null,
        changedFileCount: observedChangedFilesCount,
        gitDirtyFilesConsidered: observedChangedFilesState.available,
        changedFilesBoostApplied: false,
        changedFilesBoostSkippedForLargeChangeSet,
    };
    const dirtyFilesNotFreshened = observedChangedFilesState.available
        && observedChangedFilesCount > 0
        && input.freshnessMode !== "synced"
        && input.freshnessMode !== "skipped_source_unchanged"
        && input.freshnessMode !== "reconciled_ignore_change";
    const canSupplementLivePathEvidence = observedChangedFilesState.available
        && observedChangedFilesCount > 0
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
                if (host.shouldForceSearchPassFailure(pass.id)) {
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
        const attemptFilterSummary = buildEmptyFilterSummary();
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
                passesMatchedMust: false,
                exactLexicalMatch: false,
                exactMatchPinned: false,
                rerankAdjusted: false,
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

        const trackedLexical = await host.measureSearchPhase(
            "trackedLexical",
            async () => host.searchQuerySupport.buildTrackedLexicalSearchResults({
                effectiveRoot: input.effectiveRoot,
                parsedOperators: input.parsedOperators,
                queryPlan: input.queryPlan,
                scope: input.scope,
                limit: candidateLimit,
                exactRegistryFallback: input.exactRegistryFallbackForTrackedLexical,
            }),
        );
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

        const beforeFilter = byChunkKey.size;
        const scoredAttempt: SearchCandidate[] = [];
        const evaluateCandidate = (
            candidate: SearchCandidate,
            summary: SearchFilterSummary,
            recordRemoval: (
                candidate: SearchCandidate,
                reason: Parameters<typeof appendSearchCandidateRemoval>[1]["reason"],
            ) => void,
            trackBoostedCandidate: boolean,
        ): boolean => {
            const category = classifyPathCategory(candidate.result.relativePath);
            if (!shouldIncludeCategoryInScope(input.scope, category)) {
                summary.removedByScope += 1;
                recordRemoval(candidate, "scope_filter");
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

            const pathMultiplier = SCOPE_PATH_MULTIPLIERS[input.scope][category];
            const agentFit = resolveSearchAgentFitMultiplier({
                plan: input.queryPlan,
                result: candidate.result,
                category,
                scope: input.scope,
                hasTokenBoundaryMatch: (field, term) => host.searchQuerySupport.hasTokenBoundaryMatch(field, term),
            });
            let changedFilesMultiplier = 1.0;
            if (changedFilesBoostEnabled
                && changedFilesState.files.has(relativePath)
                && shouldApplyChangedFilesBoost(category, input.queryPlan)) {
                changedFilesMultiplier = SEARCH_CHANGED_FIRST_MULTIPLIER;
                if (trackBoostedCandidate) boostedCandidates += 1;
            }

            candidate.pathCategory = category;
            candidate.pathMultiplier = pathMultiplier;
            candidate.changedFilesMultiplier = changedFilesMultiplier;
            candidate.agentFitMultiplier = agentFit.multiplier;
            candidate.agentFitReason = agentFit.reason;
            candidate.passesMatchedMust = matchesMust;
            const lexicalEvidence = host.searchQuerySupport.scoreCandidateLexicalEvidence(input.queryPlan, candidate.result);
            candidate.lexicalScore = lexicalEvidence.score;
            candidate.exactLexicalMatch = lexicalEvidence.exactLexicalMatch;
            candidate.finalScore = (candidate.fusionScore + candidate.lexicalScore)
                * pathMultiplier
                * changedFilesMultiplier
                * agentFit.multiplier;
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
        for (const candidate of byChunkKey.values()) {
            if (evaluateCandidate(candidate, attemptFilterSummary, recordFilterRemoval, true)) {
                scoredAttempt.push(candidate);
            }
        }

        searchDiagnostics.resultsBeforeFilter = beforeFilter;
        searchDiagnostics.resultsAfterFilter = scoredAttempt.length;
        filterSummary = attemptFilterSummary;
        scored = scoredAttempt;

        exactMatchPinningApplied = sortSearchCandidatesHelper(
            scored,
            input.queryPlan.exactMatchPinningEnabled,
            input.parsedOperators.must.length > 0,
        ) || exactMatchPinningApplied;
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
                candidate.rerankFamilyId = resolveRerankFamilyKey(candidate);
                candidate.rerankDocumentUtf8Bytes = Buffer.byteLength(
                    host.searchQuerySupport.buildRerankDocument(candidate.result),
                    "utf8",
                );
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
                        false,
                    )) {
                        continue;
                    }
                    candidate.rerankFamilyId = resolveRerankFamilyKey(candidate);
                    candidate.rerankDocumentUtf8Bytes = Buffer.byteLength(
                        host.searchQuerySupport.buildRerankDocument(candidate.result),
                        "utf8",
                    );
                    diagnosticCandidates.set(candidateId, candidate);
                }
            }
            const replaySignals = [...diagnosticCandidates.values()];
            sortSearchCandidatesHelper(
                replaySignals,
                input.queryPlan.exactMatchPinningEnabled,
                input.parsedOperators.must.length > 0,
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
    if (rerankPhase.warning) searchWarnings.push(rerankPhase.warning);
    const {
        rerankerAttempted,
        rerankerApplied,
        skippedByExactPin,
        rerankerFailurePhase,
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
        rerankerFamilyCount,
        rerankerSupplementalCandidates,
        rerankerCandidatePoolCount,
        rerankerCandidateBudget,
        rerankerBudgetReason,
        rerankerByteBudgetOmittedCandidates,
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
        || (input.queryPlan.retrievalMode === "lexical"
            && candidate.retrievalPasses.some((pass) => remotePassIds.has(pass)))
    )).length;
    searchDiagnostics.candidatesWithCurrentSourceEvidence = scored.filter((candidate) => (
        candidate.retrievalPasses.includes("dirty_overlay")
        || candidate.retrievalPasses.includes("live_path")
    )).length;
    rankingProvenance.semanticPassesUsed = Array.from(passesUsed).filter((passId) => passId === "primary" || passId === "expanded").sort();
    rankingProvenance.lexicalPassesUsed = Array.from(passesUsed).filter((passId) => passId === "lexical_files" || passId === "live_path" || passId === "dirty_overlay").sort();
    rankingProvenance.livePathSupplementUsed = passesUsed.has("live_path");
    rankingProvenance.lexicalFileScanUsed = passesUsed.has("lexical_files");
    rankingProvenance.rerankApplied = rerankerApplied;
    rankingProvenance.exactMatchPinningApplied = exactMatchPinningApplied;
    const mustApplied = input.parsedOperators.must.length > 0;
    const mustSatisfied = !mustApplied || scored.length > 0;
    if (mustApplied && !mustSatisfied) {
        searchWarnings.push("FILTER_MUST_UNSATISFIED");
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
        skippedByExactPin,
        rerankerFailurePhase,
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
        rerankerFamilyCount,
        rerankerSupplementalCandidates,
        rerankerCandidatePoolCount,
        rerankerCandidateBudget,
        rerankerBudgetReason,
        rerankerByteBudgetOmittedCandidates,
        semanticExpansion,
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
            candidatesWithSemanticEvidence: searchDiagnostics.candidatesWithSemanticEvidence,
            candidatesWithLexicalEvidence: searchDiagnostics.candidatesWithLexicalEvidence,
            candidatesWithCurrentSourceEvidence: searchDiagnostics.candidatesWithCurrentSourceEvidence,
            semanticExpansionAttempted: searchDiagnostics.semanticExpansionAttempted,
            semanticExpansionReason: searchDiagnostics.semanticExpansionReason,
        },
        semanticPassFailures,
        ...(candidateSurvival ? { candidateSurvival } : {}),
    };
}
