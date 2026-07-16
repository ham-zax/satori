import type { SemanticSearchResult, VoyageAIReranker } from "@zokizuan/satori-core";
import {
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_RERANK_RRF_K,
    SEARCH_RERANK_WEIGHT,
    SEARCH_RRF_K,
    SCOPE_PATH_MULTIPLIERS,
    type PathCategory,
    type SearchRankingMode,
    type SearchScope,
} from "./search-constants.js";
import type {
    SearchDebugMode,
    SearchFreshnessSummary,
    SearchOperatorSummary,
    SearchProviderWorkDebugHint,
} from "./search-types.js";
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
import type { VectorBackendDiagnostic } from "./backend-diagnostics.js";
import type { FreshnessDecision } from "./sync.js";
import {
    selectRerankCandidates,
    type RerankBudgetReason,
} from "./search-rerank-policy.js";
import {
    resolveNextSearchCandidateLimit,
    resolveSearchPolicy,
} from './search-policy.js';

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
    | "primary_failed_fallback";

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
}): SearchExpansionDecision {
    if (input.retrievalMode === "lexical") {
        return {
            expand: false,
            reason: "lexical_route",
            primaryScopedCandidateCount: input.primaryScopedCandidateCount,
        };
    }
    if (input.primaryFailed) {
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
        semanticExpansion: SearchExpansionDecision & { attempted: boolean };
        providerWork: SearchProviderWorkDiagnostics;
    }
    | {
        kind: "vector_backend_unavailable";
        diagnostic: VectorBackendDiagnostic;
    }
    | {
        kind: "all_semantic_passes_failed";
    };

export type SearchExecutionHost = {
    searchQuerySupport: SearchQuerySupport;
    semanticSearch: (request: {
        codebasePath: string;
        query: string;
        topK: number;
        retrievalMode: "dense" | "lexical" | "hybrid";
        scorePolicy: { kind: "topk_only" } | { kind: "dense_similarity_min"; min: number };
    }) => Promise<SemanticSearchResult[]>;
    reranker: VoyageAIReranker | null;
    shouldForceSearchPassFailure: (passId: SearchPassId) => boolean;
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
    warning?: 'RERANKER_FAILED';
};

async function rerankSearchCandidates(
    input: SearchExecutionInput,
    host: SearchExecutionHost,
    searchDiagnostics: SearchDiagnostics,
    scored: SearchCandidate[],
    initialExactMatchPinningApplied: boolean,
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
        rerankerAttempted = true;
        try {
            const selection = selectRerankCandidates({
                candidates: scored,
                requestedLimit: input.limit,
            });
            const rerankCount = selection.selected.length;
            rerankerCandidatesReranked = rerankCount;
            rerankerFamilyCount = selection.familyCount;
            rerankerSupplementalCandidates = selection.supplementalCandidateCount;
            rerankerCandidatePoolCount = selection.candidatePoolCount;
            rerankerCandidateBudget = selection.budget;
            rerankerBudgetReason = selection.budgetReason;
            const rerankSlice = selection.selected;
            const rerankDocuments = rerankSlice.map((candidate) => (
                host.searchQuerySupport.buildRerankDocument(candidate.result)
            ));
            searchDiagnostics.rerankerCalls += 1;
            searchDiagnostics.rerankerCandidates += rerankDocuments.length;
            searchDiagnostics.rerankerInputBytes += rerankDocuments.reduce(
                (total, document) => total + Buffer.byteLength(document, 'utf8'),
                0,
            );
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
    const retrievalPolicy = resolveSearchPolicy({
        resultLimit: input.limit,
        hasMustOperators: input.parsedOperators.must.length > 0,
    });
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
        && input.freshnessMode !== "reconciled_ignore_change";
    const canSupplementLivePathEvidence = observedChangedFilesState.available
        && observedChangedFilesCount > 0
        && input.parsedOperators.path.length > 0;

    let boostedCandidates = 0;
    let attemptsUsed = 0;
    const searchWarningsSet = new Set<string>();
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
                return host.semanticSearch({
                    codebasePath: input.effectiveRoot,
                    query: pass.query,
                    topK: candidateLimit,
                    retrievalMode: input.queryPlan.retrievalMode,
                    scorePolicy,
                });
                })),
            );
        };
        const primaryDescriptor = { id: "primary" as const, query: input.semanticQuery };
        const primarySettled = await runPasses([primaryDescriptor]);
        const primaryResult = primarySettled[0];
        const primaryResults = primaryResult.status === "fulfilled" && Array.isArray(primaryResult.value)
            ? primaryResult.value
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

        const successfulPasses: Array<{ id: string; results: SearchResultLike[] }> = [];
        let vectorBackendDiagnostic: VectorBackendDiagnostic | null = null;
        for (let idx = 0; idx < passSettled.length; idx++) {
            const passResult = passSettled[idx];
            const passDescriptor = passDescriptors[idx];
            if (passResult.status === "fulfilled" && Array.isArray(passResult.value)) {
                successfulPasses.push({
                    id: passDescriptor.id,
                    results: passResult.value,
                });
                passesUsed.add(passDescriptor.id);
                continue;
            }

            if (passResult.status === "rejected" && vectorBackendDiagnostic === null) {
                vectorBackendDiagnostic = host.classifyVectorBackendError(passResult.reason);
            }
            searchWarningsSet.add(buildSearchPassWarningHelper(passDescriptor.id));
        }

        searchDiagnostics.searchPassSuccessCount += successfulPasses.length;
        searchDiagnostics.searchPassFailureCount += passDescriptors.length - successfulPasses.length;

        if (successfulPasses.length === 0) {
            if (vectorBackendDiagnostic) {
                return {
                    kind: "vector_backend_unavailable",
                    diagnostic: vectorBackendDiagnostic,
                };
            }
            return { kind: "all_semantic_passes_failed" };
        }

        const byChunkKey = new Map<string, SearchCandidate>();
        const attemptFilterSummary = buildEmptyFilterSummary();
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
                    byChunkKey.set(key, {
                        result,
                        baseScore: typeof result.backendScore === "number"
                            ? result.backendScore
                            : (typeof result.score === "number" ? result.score : 0),
                        backendScore: typeof result.backendScore === "number"
                            ? result.backendScore
                            : (typeof result.score === "number" ? result.score : 0),
                        backendScoreKind,
                        backendScoreKindsSeen: [backendScoreKind],
                        fusionScore: rrf,
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
                        retrievalPasses: [passId],
                    });
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
                addPass(livePathResults, "live_path", 1);
                passesUsed.add("live_path");
            }
        }

        const beforeFilter = byChunkKey.size;
        const scoredAttempt: SearchCandidate[] = [];
        for (const candidate of byChunkKey.values()) {
            const category = classifyPathCategory(candidate.result.relativePath);
            if (!shouldIncludeCategoryInScope(input.scope, category)) {
                attemptFilterSummary.removedByScope += 1;
                continue;
            }

            const languageValue = typeof candidate.result.language === "string"
                ? candidate.result.language.toLowerCase()
                : "unknown";
            if (input.parsedOperators.lang.length > 0 && !input.parsedOperators.lang.includes(languageValue)) {
                attemptFilterSummary.removedByLanguage += 1;
                continue;
            }

            const relativePath = String(candidate.result.relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
            if (input.parsedOperators.path.length > 0 && !host.searchQuerySupport.pathMatchesAnyPattern(relativePath, input.parsedOperators.path)) {
                attemptFilterSummary.removedByPathInclude += 1;
                continue;
            }

            if (input.parsedOperators.excludePath.length > 0 && host.searchQuerySupport.pathMatchesAnyPattern(relativePath, input.parsedOperators.excludePath)) {
                attemptFilterSummary.removedByPathExclude += 1;
                continue;
            }

            const symbolLabel = typeof candidate.result.symbolLabel === "string" ? candidate.result.symbolLabel : "";
            const content = typeof candidate.result.content === "string" ? candidate.result.content : "";
            const fields = [symbolLabel, relativePath, content];
            const matchesMust = input.parsedOperators.must.every((token) => host.searchQuerySupport.tokenMatchesAnyField(token, fields));
            if (!matchesMust) {
                attemptFilterSummary.removedByMust += 1;
                continue;
            }

            const matchesExclude = input.parsedOperators.exclude.some((token) => host.searchQuerySupport.tokenMatchesAnyField(token, fields));
            if (matchesExclude) {
                attemptFilterSummary.removedByExclude += 1;
                continue;
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
                boostedCandidates += 1;
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
            scoredAttempt.push(candidate);
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

        if (
            input.parsedOperators.must.length === 0
            || scored.length >= input.limit
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

    return {
        kind: "ok",
        scored,
        operatorSummary,
        filterSummary,
        freshnessSummary,
        dirtyFilesNotFreshened,
        trackedLexicalDebug,
        candidateLimit,
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
    };
}
