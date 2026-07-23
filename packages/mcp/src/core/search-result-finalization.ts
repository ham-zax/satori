import type { SymbolRegistry } from "@zokizuan/satori-core";
import {
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES,
    SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES,
    SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT,
    SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT,
    SEARCH_RERANK_DOC_MAX_CHARS,
    SEARCH_RERANK_DOC_MAX_LINES,
    SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
    SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY,
    SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES,
    SEARCH_RERANK_RRF_K,
    SEARCH_RERANK_TOP_K,
    SEARCH_RERANK_WEIGHT,
    SEARCH_RESULT_SET_HANDLE_PLACEHOLDER,
    SEARCH_RRF_K,
    type SearchGroupBy,
    type SearchResultMode,
    type SearchScope,
} from "./search-constants.js";
import {
    buildRawSearchResults as buildRawSearchResultsHelper,
    buildVisibleGroupedSearchResults as buildVisibleGroupedSearchResultsHelper,
} from "./search-group-results.js";
import type { SearchQueryPlan, SearchResultLike } from "./search-lexical-scoring.js";
import type { ParsedSearchOperators } from "./search-query-planning.js";
import type { SearchQuerySupport } from "./search-query-support.js";
import {
    buildGroupedSearchEnvelope as buildGroupedSearchEnvelopeHelper,
    buildRawSearchEnvelope as buildRawSearchEnvelopeHelper,
    projectGroupedResultV2,
} from "./search-response-envelopes.js";
import type {
    CallGraphHint,
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchGroupResult,
    SearchGroupedResultV2,
    SearchRecommendedNextAction,
    SearchReadinessDebugHint,
    SearchRankingDebugHint,
    SearchGroupedResponseEnvelope,
    SearchResponseHints,
    SearchResponseEnvelope,
} from "./search-types.js";
import {
    buildSearchDebugSummary,
    buildSearchGroupRecommendedAction,
    SEARCH_GROUP_PREVIEW_MAX_BYTES,
} from "./search-response-helpers.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import type { FreshnessDecision } from "./sync.js";
import type { ExactRegistryLookupDebug } from "./search/exact-registry.js";
import type { SearchExecutionOutcome } from "./search-execution.js";
import {
    appendGroupedCandidateStage,
    appendSearchCandidateRemoval,
    appendSearchCandidateStage,
} from "./search-candidate-survival.js";
import { projectGroupedDisclosure } from "./search-disclosure.js";

type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>["reason"];
type ChangedFilesState = { available: boolean; files: Set<string> };

type RegistryManifestState =
    | {
        status: "ok";
        registry: SymbolRegistry;
        manifestHash: string;
    }
    | {
        status: "missing" | "incompatible";
        reason: string;
    };

type NavigationState = {
    relationshipReady: boolean;
    relationshipBuiltAt?: string;
    relationshipUnavailableReason?: CallGraphUnavailableReason;
    warning?: string;
};

type SearchOwnerResolution = {
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    symbolKind?: string;
    ownerSource?: "owner_metadata" | "registry_repair";
};

type FinalizeSearchResultsInput = {
    absolutePath: string;
    effectiveRoot: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    resultMode: SearchResultMode;
    limit: number;
    disclosureLimit: number;
    rerankerResultLimit: number;
    debugMode: "none" | "summary" | "ranking" | "freshness" | "full";
    rankingMode: "default" | "auto_changed_first";
    freshnessDecision: FreshnessDecision;
    freshnessSummary: SearchFreshnessSummary;
    proofDebugHint?: CompletionProbeDebugHint;
    partialIndexSearchWarnings: string[];
    phaseTimings: NonNullable<SearchDebugHint["phaseTimingsMs"]>;
    readiness: SearchReadinessDebugHint;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    maxAttempts: number;
    exactRegistryDebug?: ExactRegistryLookupDebug;
    searchSymbolRegistry?: SymbolRegistry;
    searchSymbolRegistryManifestHash?: string;
    execution: Extract<SearchExecutionOutcome, { kind: "ok" }>;
    navigationAuthority: "valid" | "unavailable";
    navigationStatus?: "valid" | "not_bound" | "missing" | "incompatible" | "corrupt" | "unverified";
};

export type SearchResultFinalizationHost = {
    searchQuerySupport: SearchQuerySupport;
    measureSearchPhase: <T>(
        phase: "registryLoad" | "navigationValidation",
        run: () => Promise<T>,
    ) => Promise<T>;
    loadRegistryManifest: (normalizedRootPath: string) => Promise<RegistryManifestState>;
    loadRegistryValidatedCallGraphSidecar: (input: {
        codebaseRoot: string;
        registryManifestHash?: string;
        registryUnavailableReason?: CallGraphUnavailableReason;
    }) => Promise<NavigationState>;
    buildRequiresReindexPayload: (
        codebasePath: string,
        detail: string | undefined,
        searchContext: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        },
    ) => SearchResponseEnvelope;
    buildChangedCodeDebug: (
        codebaseRoot: string,
        changedFilesState: ChangedFilesState,
    ) => Promise<SearchDebugHint["changedCode"] | undefined>;
    buildGeneratedArtifactsVerificationHint: (
        codebaseRoot: string,
        results: Array<{ file: string; span: { startLine: number; endLine: number } }>,
    ) => NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["verification"]>["generatedArtifacts"] | undefined;
    getSearchNavigationHelpers: () => Parameters<typeof buildVisibleGroupedSearchResultsHelper>[0]["navigationHelpers"];
    parseIndexedAtMs: (indexedAt?: string) => number | undefined;
    resolveSearchOwnerFromRegistry: (
        result: SearchResultLike,
        registry?: SymbolRegistry,
        plan?: SearchQueryPlan,
    ) => SearchOwnerResolution;
    now: () => number;
};

export type FinalizedSearchResultSet = Readonly<{
    orderedResults: readonly SearchGroupedResultV2[];
    recommendedActions: readonly (SearchRecommendedNextAction | null)[];
    initialReturnedCount: number;
}>;

export type FinalizedSearchResults = Readonly<{
    envelope: SearchResponseEnvelope;
    resultSet?: FinalizedSearchResultSet;
}>;

export async function finalizeSearchResults(
    input: FinalizeSearchResultsInput,
    host: SearchResultFinalizationHost,
): Promise<FinalizedSearchResults> {
    let {
        scored,
        operatorSummary,
        filterSummary,
        trackedLexicalDebug,
        candidateLimit,
        diagnosticCandidateLimit,
        attemptsUsed,
        searchWarnings,
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
        providerWork,
        candidateSurvival,
        semanticPassFailures,
    } = input.execution;
    let freshnessSummary = input.freshnessSummary;

    let finalizedSearchWarnings = Array.from(new Set([
        ...searchWarnings,
        ...input.partialIndexSearchWarnings,
    ])).sort();

    const rerankDecision = host.searchQuerySupport.resolveRerankDecision(input.scope, input.queryPlan);
    const mustApplied = input.parsedOperators.must.length > 0;
    const mustSatisfied = !mustApplied || scored.length > 0;

    const buildRankingDebug = (
        diversitySummary?: SearchDebugHint["diversitySummary"],
    ): SearchRankingDebugHint => ({
            route: {
                ...input.queryPlan.route,
                allowedSources: [...input.queryPlan.route.allowedSources],
                currentProviderBudget: { ...input.queryPlan.route.currentProviderBudget },
            },
            queryIntent: {
                classification: input.queryPlan.intent,
                confidence: input.queryPlan.confidence,
                reasons: [...input.queryPlan.reasons],
                lexicalTerms: input.queryPlan.lexicalTerms.map((term) => term.value),
                semanticQuery: input.queryPlan.semanticQuery,
            },
            retrieval: {
                mode: input.queryPlan.retrievalMode,
                scorePolicyKind: input.queryPlan.scorePolicyKind,
                backendScoreKinds: Array.from(backendScoreKinds).sort(),
            },
            mcpFusion: {
                rrfK: SEARCH_RRF_K,
            },
            providerWork: {
                semanticSearchAttempts: providerWork.semanticSearchAttempts,
                embeddingCallsByCurrentContract: providerWork.embeddingCallsByCurrentContract,
                denseQueriesByCurrentContract: providerWork.denseQueriesByCurrentContract,
                sparseQueriesByCurrentContract: providerWork.sparseQueriesByCurrentContract,
                rerankerCalls: providerWork.rerankerCalls,
                rerankerCandidates: providerWork.rerankerCandidates,
                rerankerInputBytes: providerWork.rerankerInputBytes,
                candidatesWithSemanticEvidence: providerWork.candidatesWithSemanticEvidence,
                candidatesWithLexicalEvidence: providerWork.candidatesWithLexicalEvidence,
                candidatesWithCurrentSourceEvidence: providerWork.candidatesWithCurrentSourceEvidence,
            },
            ...(semanticPassFailures.length > 0 ? {
                semanticPassFailures: semanticPassFailures.map((failure) => ({ ...failure })),
            } : {}),
            semanticExpansion,
            rankingProvenance,
            ...(trackedLexicalDebug ? { trackedLexical: trackedLexicalDebug } : {}),
            ...(input.exactRegistryDebug ? { exactRegistry: input.exactRegistryDebug } : {}),
            passesUsed: Array.from(passesUsed).sort(),
            candidateLimit,
            ...(diagnosticCandidateLimit !== undefined ? { diagnosticCandidateLimit } : {}),
            mustRetry: {
                attempts: attemptsUsed,
                maxAttempts: input.maxAttempts,
                applied: mustApplied,
                satisfied: mustSatisfied,
                finalCount: scored.length,
            },
            operatorSummary,
            filterSummary,
            changedFilesBoost: {
                enabled: input.rankingMode === "auto_changed_first",
                applied: boostedCandidates > 0,
                available: changedFilesState.available,
                changedCount: changedFilesCount,
                maxChangedFilesForBoost: SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
                skippedForLargeChangeSet: changedFilesBoostSkippedForLargeChangeSet,
                multiplier: SEARCH_CHANGED_FIRST_MULTIPLIER,
                boostedCandidates,
            },
            ...(diversitySummary ? { diversitySummary } : {}),
            rerank: {
                enabledByPolicy: rerankDecision.enabledByPolicy,
                skippedByScopeDocs: rerankDecision.skippedByScopeDocs,
                skippedByIdentifierIntent: rerankDecision.skippedByIdentifierIntent,
                skippedByExactPin,
                capabilityPresent: rerankDecision.capabilityPresent,
                rerankerPresent: rerankDecision.rerankerPresent,
                enabled: rerankDecision.enabled && !skippedByExactPin,
                attempted: rerankerAttempted,
                applied: rerankerApplied,
                exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
                exactMatchPinningApplied: exactMatchPinningApplied,
                candidatesIn: rerankerCandidatesIn,
                candidatesReranked: rerankerCandidatesReranked,
                familyCount: rerankerFamilyCount,
                supplementalCandidates: rerankerSupplementalCandidates,
                candidatePoolCount: rerankerCandidatePoolCount,
                candidateBudget: rerankerCandidateBudget,
                ...(rerankerBudgetReason ? { budgetReason: rerankerBudgetReason } : {}),
                inputByteBudget: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
                inputBytes: providerWork.rerankerInputBytes,
                byteBudgetOmittedCandidates: rerankerByteBudgetOmittedCandidates,
                topK: SEARCH_RERANK_TOP_K,
                rankK: SEARCH_RERANK_RRF_K,
                weight: SEARCH_RERANK_WEIGHT,
                docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
                docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
                requestedResultLimit: input.rerankerResultLimit,
                selectionPolicy: {
                    minAmbiguousCandidates: SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES,
                    ambiguousCandidatesPerResult: SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT,
                    boundedCandidatesPerResult: SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT,
                    maxSupplementalChunksPerFamily: SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY,
                },
                ...(rerankerFailurePhase ? { errorCode: "RERANKER_FAILED" as const, failurePhase: rerankerFailurePhase } : {}),
            },
        });
    const changedCode = debugChangedFilesState && (input.debugMode === "freshness" || input.debugMode === "full")
        ? await host.buildChangedCodeDebug(input.effectiveRoot, debugChangedFilesState)
        : undefined;
    const buildDebugProjection = (
        diversitySummary?: SearchDebugHint["diversitySummary"],
        disclosedResults?: readonly SearchGroupResult[],
    ): {
        debugSummary?: NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["debugSummary"]>;
        debugSearch?: NonNullable<SearchResponseHints["debugSearch"]>;
    } => {
        if (input.debugMode === "none") return {};
        const projectedCandidateSurvival = candidateSurvival && disclosedResults
            ? structuredClone(candidateSurvival)
            : candidateSurvival;
        if (projectedCandidateSurvival && disclosedResults) {
            projectedCandidateSurvival.stages = projectedCandidateSurvival.stages.filter(
                (stage) => stage.stage !== "disclosed",
            );
            appendGroupedCandidateStage(projectedCandidateSurvival, "disclosed", disclosedResults);
        }
        const rankingDebug = input.debugMode === "ranking" || input.debugMode === "full"
            ? buildRankingDebug(diversitySummary)
            : undefined;
        const debugSummary = buildSearchDebugSummary({
            passesUsed: Array.from(passesUsed).sort(),
            rankingProvenance,
            retrieval: {
                mode: input.queryPlan.retrievalMode,
                scorePolicyKind: input.queryPlan.scorePolicyKind,
                backendScoreKinds: Array.from(backendScoreKinds).sort(),
            },
            rerank: rankingDebug?.rerank ?? {
                enabledByPolicy: rerankDecision.enabledByPolicy,
                skippedByScopeDocs: rerankDecision.skippedByScopeDocs,
                skippedByIdentifierIntent: rerankDecision.skippedByIdentifierIntent,
                skippedByExactPin,
                capabilityPresent: rerankDecision.capabilityPresent,
                rerankerPresent: rerankDecision.rerankerPresent,
                enabled: rerankDecision.enabled && !skippedByExactPin,
                attempted: rerankerAttempted,
                applied: rerankerApplied,
                exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
                exactMatchPinningApplied,
                candidatesIn: rerankerCandidatesIn,
                candidatesReranked: rerankerCandidatesReranked,
                familyCount: rerankerFamilyCount,
                supplementalCandidates: rerankerSupplementalCandidates,
                candidatePoolCount: rerankerCandidatePoolCount,
                candidateBudget: rerankerCandidateBudget,
                ...(rerankerBudgetReason ? { budgetReason: rerankerBudgetReason } : {}),
                inputByteBudget: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
                inputBytes: providerWork.rerankerInputBytes,
                byteBudgetOmittedCandidates: rerankerByteBudgetOmittedCandidates,
                topK: SEARCH_RERANK_TOP_K,
                rankK: SEARCH_RERANK_RRF_K,
                weight: SEARCH_RERANK_WEIGHT,
                docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
                docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
                requestedResultLimit: input.rerankerResultLimit,
                selectionPolicy: {
                    minAmbiguousCandidates: SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES,
                    ambiguousCandidatesPerResult: SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT,
                    boundedCandidatesPerResult: SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT,
                    maxSupplementalChunksPerFamily: SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY,
                },
            },
            ...(changedCode ? { changedCode } : {}),
        }, freshnessSummary);
        const debugSearch: SearchResponseHints["debugSearch"] = input.debugMode === "full"
            ? {
                ...rankingDebug!,
                phaseTimingsMs: input.phaseTimings,
                readiness: input.readiness,
                ...(changedCode ? { changedCode } : {}),
                ...(projectedCandidateSurvival ? { candidateSurvival: projectedCandidateSurvival } : {}),
            }
            : input.debugMode === "ranking"
                ? rankingDebug
                : input.debugMode === "freshness"
                    ? { phaseTimingsMs: input.phaseTimings, readiness: input.readiness, ...(changedCode ? { changedCode } : {}) }
                    : undefined;
        return {
            ...(debugSummary ? { debugSummary } : {}),
            ...(debugSearch ? { debugSearch } : {}),
        };
    };

    if (input.resultMode === "raw") {
        if (candidateSurvival) {
            appendSearchCandidateStage(
                candidateSurvival,
                "disclosed",
                scored.slice(0, input.limit),
            );
        }
        const rawResults = buildRawSearchResultsHelper({
            scored,
            limit: input.limit,
            debugMode: input.debugMode,
            now: host.now,
        });
        const noiseMitigationHint = host.searchQuerySupport.buildNoiseMitigationHint(
            input.effectiveRoot,
            rawResults.map((result) => result.file),
            input.scope,
            input.parsedOperators,
        );
        const generatedArtifactsHint = host.buildGeneratedArtifactsVerificationHint(
            input.effectiveRoot,
            rawResults.map((result) => ({
                file: result.file,
                span: result.span,
            })),
        );
        return {
            envelope: buildRawSearchEnvelopeHelper({
                codebaseRoot: input.effectiveRoot,
                absolutePath: input.absolutePath,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                limit: input.limit,
                freshnessDecision: input.freshnessDecision,
                freshnessSummary,
                warnings: finalizedSearchWarnings,
                ...buildDebugProjection(),
                proofDebugHint: input.proofDebugHint,
                noiseMitigationHint,
                generatedArtifactsHint,
                results: rawResults,
            }),
        };
    }

    const needsRegistryRepair = input.groupBy === "symbol"
        && scored.some((candidate) => !candidate.result.ownerSymbolKey || !candidate.result.ownerSymbolInstanceId);
    let searchSymbolRegistry = input.navigationAuthority === "valid" ? input.searchSymbolRegistry : undefined;
    let searchSymbolRegistryManifestHash = input.navigationAuthority === "valid"
        ? input.searchSymbolRegistryManifestHash
        : undefined;
    let searchSymbolRegistryUnavailableReason: CallGraphUnavailableReason | undefined =
        input.navigationAuthority === "valid"
            ? undefined
            : input.navigationStatus === "missing"
                ? "missing_symbol_registry"
                : "incompatible_symbol_registry";

    if (input.navigationAuthority === "valid" && input.groupBy === "symbol" && !searchSymbolRegistry) {
        const registryState = await host.measureSearchPhase(
            "registryLoad",
            () => host.loadRegistryManifest(input.effectiveRoot),
        );
        if (registryState.status === "ok") {
            searchSymbolRegistry = registryState.registry;
            searchSymbolRegistryManifestHash = registryState.manifestHash;
        } else if (registryState.status === "missing") {
            searchSymbolRegistryUnavailableReason = "missing_symbol_registry";
        } else if (registryState.status === "incompatible" && needsRegistryRepair) {
            return {
                envelope: host.buildRequiresReindexPayload(
                    input.effectiveRoot,
                    `Symbol registry is incompatible: ${registryState.reason}`,
                    {
                        path: input.absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        resultMode: input.resultMode,
                        limit: input.limit,
                    },
                ),
            };
        } else if (registryState.status === "incompatible") {
            searchSymbolRegistryUnavailableReason = "incompatible_symbol_registry";
            searchWarnings.push(`SEARCH_SYMBOL_REGISTRY_UNAVAILABLE:${registryState.status}`);
            finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();
        }
    }

    const callGraphNavigationState = input.navigationAuthority === "valid"
        ? await host.measureSearchPhase(
            "navigationValidation",
            () => host.loadRegistryValidatedCallGraphSidecar({
                codebaseRoot: input.effectiveRoot,
                registryManifestHash: searchSymbolRegistryManifestHash,
                registryUnavailableReason: searchSymbolRegistryUnavailableReason,
            }),
        )
        : {
            relationshipReady: false,
            relationshipUnavailableReason: searchSymbolRegistryUnavailableReason
                ?? "incompatible_symbol_registry",
        };
    if (callGraphNavigationState.warning) {
        searchWarnings.push(`SEARCH_${callGraphNavigationState.warning}`);
        finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();
    }

    const groupedSearchResults = buildVisibleGroupedSearchResultsHelper({
        scored,
        codebaseRoot: input.effectiveRoot,
        groupBy: input.groupBy,
        // Freeze the complete caller-bounded diversity order before applying the
        // smaller presentation budget. Otherwise disclosureLimit would also
        // change which candidates can be reached by continuation.
        limit: input.limit,
        queryPlan: input.queryPlan,
        mustMatchesFirst: input.parsedOperators.must.length > 0,
        registry: searchSymbolRegistry,
        registryUnavailableReason: searchSymbolRegistryUnavailableReason,
        navigationState: callGraphNavigationState,
        graphUnavailableReasonOverride: input.partialIndexSearchWarnings.includes(
            "SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE",
        )
            ? "partial_index_navigation_unavailable"
            : undefined,
        debugMode: input.debugMode,
        now: host.now,
        previewMaxBytes: SEARCH_GROUP_PREVIEW_MAX_BYTES,
        navigationHelpers: host.getSearchNavigationHelpers(),
        parseIndexedAtMs: (indexedAt?: string) => host.parseIndexedAtMs(indexedAt),
        resolveOwner: (result) => input.navigationAuthority === "valid"
            ? host.resolveSearchOwnerFromRegistry(result as SearchResultLike, searchSymbolRegistry, input.queryPlan)
            : {},
    });

    if (candidateSurvival) {
        appendGroupedCandidateStage(candidateSurvival, "grouped", groupedSearchResults.rankedResults);
        for (const candidateId of groupedSearchResults.invalidCandidateIds) {
            appendSearchCandidateRemoval(candidateSurvival, {
                candidateId,
                afterStage: "grouped",
                reason: "invalid_group_target",
            });
        }
        for (const omission of groupedSearchResults.diversityOmissions) {
            for (const candidateId of omission.group.__candidateIds) {
                appendSearchCandidateRemoval(candidateSurvival, {
                    candidateId,
                    afterStage: "disclosed",
                    reason: omission.reason,
                });
            }
        }
    }

    if (groupedSearchResults.warnings.length > 0) {
        finalizedSearchWarnings = Array.from(new Set([
            ...finalizedSearchWarnings,
            ...groupedSearchResults.warnings,
        ])).sort();
    }
    if (groupedSearchResults.exactMatchPinningApplied) {
        exactMatchPinningApplied = true;
        rankingProvenance.exactMatchPinningApplied = true;
    }
    rankingProvenance.registryRepairGroupCount += groupedSearchResults.registryRepairGroupCount;

    const completeDisclosureOrder = groupedSearchResults.disclosureOrder;
    const eligibleResults = completeDisclosureOrder.slice(0, input.limit);
    const disclosureProjection = projectGroupedDisclosure({
        // The projector needs the complete order to report caller_limit
        // truthfully, while the continuation cache below remains bounded by the
        // caller's explicit limit.
        orderedResults: completeDisclosureOrder,
        callerLimit: input.limit,
        disclosureLimit: input.disclosureLimit,
        maxResponseBytes: input.debugMode === "full"
            ? SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES
            : SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES,
        includeSummary: input.disclosureLimit < input.limit
            || completeDisclosureOrder.length > input.limit,
        buildEnvelope: (results, disclosure) => {
            const noiseMitigationHint = host.searchQuerySupport.buildNoiseMitigationHint(
                input.effectiveRoot,
                results.map((result) => result.target.file),
                input.scope,
                input.parsedOperators,
            );
            const generatedArtifactsHint = host.buildGeneratedArtifactsVerificationHint(
                input.effectiveRoot,
                results.map((result) => ({
                    file: result.target.file,
                    span: result.target.span,
                })),
            );
            const envelope = buildGroupedSearchEnvelopeHelper({
                codebaseRoot: input.effectiveRoot,
                absolutePath: input.absolutePath,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                limit: input.limit,
                freshnessDecision: input.freshnessDecision,
                freshnessSummary,
                warnings: finalizedSearchWarnings,
                ...buildDebugProjection(groupedSearchResults.diversitySummary, results),
                proofDebugHint: input.proofDebugHint,
                noiseMitigationHint,
                generatedArtifactsHint,
                ...(disclosure ? { disclosure } : {}),
                results: [...results],
            }) as SearchGroupedResponseEnvelope;
            return results.length < eligibleResults.length
                ? {
                    ...envelope,
                    continuation: {
                        handle: SEARCH_RESULT_SET_HANDLE_PLACEHOLDER,
                        nextOffset: results.length,
                        remainingGroupCount: eligibleResults.length - results.length,
                    },
                }
                : envelope;
        },
    });
    const resultSet = disclosureProjection.envelope.continuation
        ? {
            orderedResults: eligibleResults.map(projectGroupedResultV2),
            recommendedActions: eligibleResults.map((result) => (
                buildSearchGroupRecommendedAction(input.effectiveRoot, result) ?? null
            )),
            initialReturnedCount: disclosureProjection.results.length,
        }
        : undefined;
    return {
        envelope: disclosureProjection.envelope,
        ...(resultSet ? { resultSet } : {}),
    };
}
