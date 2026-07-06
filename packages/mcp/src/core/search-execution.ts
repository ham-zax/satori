import type { SemanticSearchResult, VoyageAIReranker } from "@zokizuan/satori-core";
import {
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_MAX_CANDIDATES,
    SEARCH_MUST_RETRY_MULTIPLIER,
    SEARCH_MUST_RETRY_ROUNDS,
    SEARCH_RERANK_RRF_K,
    SEARCH_RERANK_TOP_K,
    SEARCH_RERANK_WEIGHT,
    SEARCH_RRF_K,
    SCOPE_PATH_MULTIPLIERS,
    type PathCategory,
    type SearchRankingMode,
    type SearchScope,
} from "./search-constants.js";
import type {
    SearchFreshnessSummary,
    SearchOperatorSummary,
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

type SearchPassId = "primary" | "expanded";
type BackendScoreKind = "dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown";
type ChangedFilesState = { available: boolean; files: Set<string> };

export type SearchDiagnostics = {
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
        rerankerFailurePhase?: "api_call" | "parse_results";
        rerankerCandidatesIn: number;
        rerankerCandidatesReranked: number;
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
    debug: boolean;
    semanticQuery: string;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    exactRegistryEligible: boolean;
    exactRegistryFallbackForTrackedLexical: boolean;
    freshnessMode: FreshnessDecision["mode"];
    observedChangedFilesState: ChangedFilesState;
};

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
    const maxAttempts = input.parsedOperators.must.length > 0 ? 1 + SEARCH_MUST_RETRY_ROUNDS : 1;
    let candidateLimit = Math.max(1, Math.min(SEARCH_MAX_CANDIDATES, Math.max(input.limit * 8, 32)));
    let trackedLexicalDebug: TrackedLexicalSearchDebug | undefined;
    const operatorSummary = host.searchQuerySupport.buildOperatorSummary(input.parsedOperators);
    let filterSummary = buildEmptyFilterSummary();
    const observedChangedFilesState = input.observedChangedFilesState;
    const changedFilesState = input.rankingMode === "auto_changed_first"
        ? observedChangedFilesState
        : { available: observedChangedFilesState.available, files: new Set<string>() };
    const debugChangedFilesState = input.debug ? observedChangedFilesState : undefined;
    const changedFilesCount = changedFilesState.files.size;
    const observedChangedFilesCount = observedChangedFilesState.files.size;
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

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attemptsUsed = attempt + 1;
        const passDescriptors: Array<{ id: SearchPassId; query: string }> = [
            { id: "primary", query: input.semanticQuery },
        ];
        if (!input.exactRegistryEligible) {
            passDescriptors.push({ id: "expanded", query: expandedQuery });
        }
        searchDiagnostics.searchPassCount += passDescriptors.length;

        const passSettled = await host.measureSearchPhase(
            "semanticSearch",
            () => Promise.allSettled(passDescriptors.map(async (pass) => {
                if (host.shouldForceSearchPassFailure(pass.id)) {
                    throw new Error(`FORCED_TEST_SEARCH_PASS_FAILURE:${pass.id}`);
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
            const livePathResults = host.searchQuerySupport.buildLivePathScopedSearchResults({
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
            || candidateLimit >= SEARCH_MAX_CANDIDATES
        ) {
            break;
        }

        candidateLimit = Math.min(
            SEARCH_MAX_CANDIDATES,
            Math.max(candidateLimit + 1, candidateLimit * SEARCH_MUST_RETRY_MULTIPLIER),
        );
    }

    const searchWarnings = Array.from(searchWarningsSet);
    if (dirtyFilesNotFreshened) {
        searchWarnings.push(WARNING_CODES.SEARCH_DIRTY_WORKTREE_NOT_SYNCED);
    }
    if (changedFilesBoostSkippedForLargeChangeSet) {
        searchWarnings.push(WARNING_CODES.SEARCH_CHANGED_FILES_BOOST_SKIPPED);
    }
    freshnessSummary.changedFilesBoostApplied = boostedCandidates > 0;

    const rerankDecision = host.searchQuerySupport.resolveRerankDecision(input.scope, input.queryPlan);
    let rerankerApplied = false;
    let rerankerAttempted = false;
    let rerankerFailurePhase: "api_call" | "parse_results" | undefined;
    let rerankerCandidatesIn = scored.length;
    let rerankerCandidatesReranked = 0;

    if (rerankDecision.enabled && scored.length > 0 && host.reranker) {
        rerankerAttempted = true;
        try {
            const rerankCount = Math.min(SEARCH_RERANK_TOP_K, scored.length);
            rerankerCandidatesReranked = rerankCount;
            const rerankSlice = scored.slice(0, rerankCount);
            const rerankDocuments = rerankSlice.map((candidate) => host.searchQuerySupport.buildRerankDocument(candidate.result));
            let rerankResults: Array<{ index: number }> = [];
            try {
                rerankResults = await host.measureSearchPhase(
                    "rerank",
                    () => host.reranker!.rerank(input.semanticQuery, rerankDocuments, {
                        topK: rerankCount,
                        truncation: true,
                        returnDocuments: false,
                    }),
                );
            } catch {
                rerankerFailurePhase = "api_call";
                throw new Error("reranker_api_call_failed");
            }

            const rerankRanks = new Map<number, number>();
            try {
                for (let idx = 0; idx < rerankResults.length; idx++) {
                    const originalIndex = rerankResults[idx]?.index;
                    if (Number.isInteger(originalIndex) && originalIndex >= 0 && originalIndex < rerankCount && !rerankRanks.has(originalIndex)) {
                        rerankRanks.set(originalIndex, idx + 1);
                    }
                }
            } catch {
                rerankerFailurePhase = "parse_results";
                throw new Error("reranker_parse_failed");
            }

            let rerankerUpdatedCandidates = 0;
            for (let idx = 0; idx < rerankSlice.length; idx++) {
                const rank = rerankRanks.get(idx);
                if (!rank) {
                    continue;
                }
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
            if (!rerankerFailurePhase) {
                rerankerFailurePhase = "parse_results";
            }
            searchWarnings.push("RERANKER_FAILED");
        }
    }

    searchDiagnostics.excludedByIgnore = Math.max(0, searchDiagnostics.resultsBeforeFilter - searchDiagnostics.resultsAfterFilter);
    searchDiagnostics.rerankerAttempted = rerankerAttempted;
    searchDiagnostics.rerankerUsed = rerankerApplied;
    rankingProvenance.semanticPassesUsed = Array.from(passesUsed).filter((passId) => passId === "primary" || passId === "expanded").sort();
    rankingProvenance.lexicalPassesUsed = Array.from(passesUsed).filter((passId) => passId === "lexical_files" || passId === "live_path").sort();
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
        rerankerFailurePhase,
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
    };
}
