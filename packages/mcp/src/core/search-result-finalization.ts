import type { SymbolRegistry } from "@zokizuan/satori-core";
import {
    SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_RERANK_DOC_MAX_CHARS,
    SEARCH_RERANK_DOC_MAX_LINES,
    SEARCH_RERANK_RRF_K,
    SEARCH_RERANK_TOP_K,
    SEARCH_RERANK_WEIGHT,
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
} from "./search-response-envelopes.js";
import type {
    CallGraphHint,
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchResponseHints,
    SearchResponseEnvelope,
} from "./search-types.js";
import { buildSearchDebugSummary, SEARCH_GROUP_PREVIEW_MAX_BYTES } from "./search-response-helpers.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import type { FreshnessDecision } from "./sync.js";
import type { ExactRegistryLookupDebug } from "./search/exact-registry.js";
import type { SearchExecutionOutcome } from "./search-execution.js";

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
    debugMode: "none" | "summary" | "ranking" | "freshness" | "full";
    rankingMode: "default" | "auto_changed_first";
    freshnessDecision: FreshnessDecision;
    freshnessSummary: SearchFreshnessSummary;
    proofDebugHint?: CompletionProbeDebugHint;
    partialIndexSearchWarnings: string[];
    phaseTimings: NonNullable<SearchDebugHint["phaseTimingsMs"]>;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    maxAttempts: number;
    exactRegistryDebug?: ExactRegistryLookupDebug;
    searchSymbolRegistry?: SymbolRegistry;
    searchSymbolRegistryManifestHash?: string;
    execution: Extract<SearchExecutionOutcome, { kind: "ok" }>;
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
    ) => SearchDebugHint["changedCode"] | undefined;
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

export async function finalizeSearchResults(
    input: FinalizeSearchResultsInput,
    host: SearchResultFinalizationHost,
): Promise<SearchResponseEnvelope> {
    let {
        scored,
        operatorSummary,
        filterSummary,
        trackedLexicalDebug,
        candidateLimit,
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
    } = input.execution;
    let freshnessSummary = input.freshnessSummary;

    let finalizedSearchWarnings = Array.from(new Set([
        ...searchWarnings,
        ...input.partialIndexSearchWarnings,
    ])).sort();

    const rerankDecision = host.searchQuerySupport.resolveRerankDecision(input.scope, input.queryPlan);
    const mustApplied = input.parsedOperators.must.length > 0;
    const mustSatisfied = !mustApplied || scored.length > 0;

    const buildRankingDebug = (diversitySummary?: SearchDebugHint["diversitySummary"]) => ({
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
            rankingProvenance,
            ...(trackedLexicalDebug ? { trackedLexical: trackedLexicalDebug } : {}),
            ...(input.exactRegistryDebug ? { exactRegistry: input.exactRegistryDebug } : {}),
            passesUsed: Array.from(passesUsed).sort(),
            candidateLimit,
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
                topK: SEARCH_RERANK_TOP_K,
                rankK: SEARCH_RERANK_RRF_K,
                weight: SEARCH_RERANK_WEIGHT,
                docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
                docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
                ...(rerankerFailurePhase ? { errorCode: "RERANKER_FAILED" as const, failurePhase: rerankerFailurePhase } : {}),
            },
        });
    const buildDebugProjection = (diversitySummary?: SearchDebugHint["diversitySummary"]): {
        debugSummary?: NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["debugSummary"]>;
        debugSearch?: NonNullable<SearchResponseHints["debugSearch"]>;
    } => {
        if (input.debugMode === "none") return {};
        const rankingDebug = input.debugMode === "ranking" || input.debugMode === "full"
            ? buildRankingDebug(diversitySummary)
            : undefined;
        const changedCode = debugChangedFilesState && (input.debugMode === "freshness" || input.debugMode === "full")
            ? host.buildChangedCodeDebug(input.effectiveRoot, debugChangedFilesState)
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
                topK: SEARCH_RERANK_TOP_K,
                rankK: SEARCH_RERANK_RRF_K,
                weight: SEARCH_RERANK_WEIGHT,
                docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
                docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
            },
            ...(changedCode ? { changedCode } : {}),
        }, freshnessSummary);
        const debugSearch = input.debugMode === "full"
            ? { ...rankingDebug!, phaseTimingsMs: input.phaseTimings, ...(changedCode ? { changedCode } : {}) }
            : input.debugMode === "ranking"
                ? rankingDebug
                : input.debugMode === "freshness"
                    ? { phaseTimingsMs: input.phaseTimings, ...(changedCode ? { changedCode } : {}) }
                    : undefined;
        return {
            ...(debugSummary ? { debugSummary } : {}),
            ...(debugSearch ? { debugSearch } : {}),
        };
    };

    if (input.resultMode === "raw") {
        const rawResults = buildRawSearchResultsHelper({
            scored,
            limit: input.limit,
            debug: input.debugMode === "ranking" || input.debugMode === "full",
            now: host.now,
        });
        const noiseMitigationHint = host.searchQuerySupport.buildNoiseMitigationHint(
            input.effectiveRoot,
            rawResults.map((result) => result.file),
            input.scope,
        );
        const generatedArtifactsHint = host.buildGeneratedArtifactsVerificationHint(
            input.effectiveRoot,
            rawResults.map((result) => ({
                file: result.file,
                span: result.span,
            })),
        );
        return buildRawSearchEnvelopeHelper({
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
        });
    }

    const needsRegistryRepair = input.groupBy === "symbol"
        && scored.some((candidate) => !candidate.result.ownerSymbolKey || !candidate.result.ownerSymbolInstanceId);
    let searchSymbolRegistry = input.searchSymbolRegistry;
    let searchSymbolRegistryManifestHash = input.searchSymbolRegistryManifestHash;
    let searchSymbolRegistryUnavailableReason: CallGraphUnavailableReason | undefined;

    if (input.groupBy === "symbol" && !searchSymbolRegistry) {
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
            return host.buildRequiresReindexPayload(
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
            );
        } else if (registryState.status === "incompatible") {
            searchSymbolRegistryUnavailableReason = "incompatible_symbol_registry";
            searchWarnings.push(`SEARCH_SYMBOL_REGISTRY_UNAVAILABLE:${registryState.status}`);
            finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();
        }
    }

    const callGraphNavigationState = await host.measureSearchPhase(
        "navigationValidation",
        () => host.loadRegistryValidatedCallGraphSidecar({
            codebaseRoot: input.effectiveRoot,
            registryManifestHash: searchSymbolRegistryManifestHash,
            registryUnavailableReason: searchSymbolRegistryUnavailableReason,
        }),
    );
    if (callGraphNavigationState.warning) {
        searchWarnings.push(`SEARCH_${callGraphNavigationState.warning}`);
        finalizedSearchWarnings = Array.from(new Set(searchWarnings)).sort();
    }

    const groupedSearchResults = buildVisibleGroupedSearchResultsHelper({
        scored,
        codebaseRoot: input.effectiveRoot,
        groupBy: input.groupBy,
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
        debug: input.debugMode === "ranking" || input.debugMode === "full",
        debugDetail: input.debugMode === "full" ? "full" : "ranking",
        now: host.now,
        previewMaxBytes: SEARCH_GROUP_PREVIEW_MAX_BYTES,
        navigationHelpers: host.getSearchNavigationHelpers(),
        parseIndexedAtMs: (indexedAt?: string) => host.parseIndexedAtMs(indexedAt),
        resolveOwner: (result) => host.resolveSearchOwnerFromRegistry(result as SearchResultLike, searchSymbolRegistry, input.queryPlan),
    });

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

    const visibleGroupedResults = groupedSearchResults.visibleResults;
    const noiseMitigationHint = host.searchQuerySupport.buildNoiseMitigationHint(
        input.effectiveRoot,
        visibleGroupedResults.map((result) => result.target.file),
        input.scope,
    );
    const generatedArtifactsHint = host.buildGeneratedArtifactsVerificationHint(
        input.effectiveRoot,
        visibleGroupedResults.map((result) => ({
            file: result.target.file,
            span: result.target.span,
        })),
    );
    return buildGroupedSearchEnvelopeHelper({
        codebaseRoot: input.effectiveRoot,
        absolutePath: input.absolutePath,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        limit: input.limit,
        freshnessDecision: input.freshnessDecision,
        freshnessSummary,
        warnings: finalizedSearchWarnings,
        ...buildDebugProjection(groupedSearchResults.diversitySummary),
        proofDebugHint: input.proofDebugHint,
        noiseMitigationHint,
        generatedArtifactsHint,
        results: visibleGroupedResults,
    });
}
