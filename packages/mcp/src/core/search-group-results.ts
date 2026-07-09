import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { truncateContent } from "../utils.js";
import {
    repairSourceBackedPythonSpan,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import {
    SEARCH_PROXIMITY_WINDOW,
    type PathCategory,
    type SearchGroupBy,
    type SearchScope,
} from "./search-constants.js";
import {
    applyGroupDiversity,
    buildFallbackGroupId,
    type SearchDiversitySummary,
} from "./search-grouping.js";
import {
    collapseDuplicateDeclarationGroups,
    sortGroupedSearchResults,
} from "./search-group-ordering.js";
import {
    buildSearchCandidateProvenance,
    classifyPathCategory,
    getStalenessBucket,
    sortSearchCandidates,
} from "./search-ranking-policy.js";
import {
    buildDisplaySymbolLabel,
    buildInboundRecoveryAction,
    buildSearchGroupFallbacks,
    buildSearchGroupPreview,
    buildSearchGroupRecommendedAction,
    buildSearchResultCapabilities,
    buildSearchSpanWarningCodes,
    normalizeSearchSymbolLabel,
} from "./search-response-helpers.js";
import type {
    CallGraphHint,
    SearchCapabilityConfidence,
    SearchChunkResult,
    SearchGroupResult,
    SearchSpan,
} from "./search-types.js";
import {
    buildNavigationFallback,
    buildSearchGroupCallGraphHint,
    buildSearchNextActions,
    shouldAllowPreviewReadFallback,
    type SearchNavigationHelpers,
    type SearchNavigationState,
} from "./search-navigation.js";

type SearchCandidateLike = {
    result: {
        relativePath: string;
        language?: string | null;
        symbolLabel?: string | null;
        symbolKind?: string | null;
        content?: string | null;
    };
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
    backendScoreKindsSeen: Array<"dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown">;
    lexicalScore: number;
};

type SearchOwnerSource = "owner_metadata" | "registry_repair" | "fallback";
type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>["reason"];
type SearchSpanValidation = "verified" | "unverified" | "not_applicable";
type SearchQueryIntent = "identifier" | "semantic" | "mixed" | "uncertain";

type SearchQueryPlanLike = {
    intent: SearchQueryIntent;
    referenceSeeking: boolean;
    exactMatchPinningEnabled: boolean;
};

type SearchOwnerResolution = {
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    symbolKind?: string;
    ownerSource?: Extract<SearchOwnerSource, "owner_metadata" | "registry_repair">;
};

type SearchResultLike = SearchCandidateLike["result"] & {
    startLine?: number;
    endLine?: number;
    indexedAt?: string | null;
    symbolId?: string | null;
    ownerSymbolKey?: string | null;
    ownerSymbolInstanceId?: string | null;
};

type GroupAccumulator = {
    chunks: SearchCandidateLike[];
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    ownerSymbolKind?: string;
    ownerSource: SearchOwnerSource;
};

type RawSearchCandidateLike = SearchCandidateLike & {
    result: SearchResultLike;
    baseScore: number;
    backendScore: number;
    backendScoreKind: "dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown";
    fusionScore: number;
};

export function buildExactRegistryGroupResult(input: {
    codebaseRoot: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    symbol: SymbolRecord;
    spanRepair?: PythonSourceBackedSpanRepair;
    indexedAt: string | null;
    navigationState: SearchNavigationState;
    sidecarReadyForOutline: boolean;
    debug: boolean;
    now: () => number;
    previewMaxChars: number;
    navigationHelpers: SearchNavigationHelpers;
}): SearchGroupResult & { __exactLexicalMatch: boolean } {
    const span: SearchSpan = {
        startLine: input.symbol.span.startLine,
        endLine: input.symbol.span.endLine,
    };
    const previewSpan: SearchSpan = {
        startLine: span.startLine,
        endLine: span.endLine,
    };
    const symbolSpan: SearchSpan = {
        startLine: span.startLine,
        endLine: span.endLine,
    };
    const displaySymbolLabel = normalizeSearchSymbolLabel(input.symbol.label) || input.symbol.label;
    const callGraphHint = buildSearchGroupCallGraphHint({
        file: input.symbol.file,
        language: input.symbol.language,
        span,
        symbolLabel: displaySymbolLabel,
        ownerSymbolInstanceId: input.symbol.symbolInstanceId,
        registrySymbol: input.symbol,
        registryLoaded: true,
        navigationState: input.navigationState,
    }, input.navigationHelpers);
    const nextActions = buildSearchNextActions(
        input.codebaseRoot,
        input.symbol.file,
        span,
        callGraphHint,
        input.sidecarReadyForOutline,
        input.symbol,
        input.navigationHelpers,
    );
    const navigationFallback = buildNavigationFallback(
        input.codebaseRoot,
        input.symbol.file,
        previewSpan,
        callGraphHint,
        input.sidecarReadyForOutline,
        shouldAllowPreviewReadFallback(callGraphHint, Boolean(nextActions?.openSymbol)),
        input.navigationHelpers,
    );
    const capabilities = buildSearchResultCapabilities({
        callGraphHint,
        confidence: "high",
        hasOpenSymbol: Boolean(nextActions?.openSymbol),
        hasReadFallback: Boolean(navigationFallback?.readSpan),
        semanticMatch: "medium",
        spanValidation: input.spanRepair
            ? (input.spanRepair.validated ? "verified" : input.spanRepair.attempted ? "unverified" : "not_applicable")
            : "not_applicable",
    });
    const preview = [
        displaySymbolLabel,
        input.symbol.qualifiedName !== displaySymbolLabel ? input.symbol.qualifiedName : "",
    ].filter(Boolean).join("\n");

    const result: SearchGroupResult & { __exactLexicalMatch: boolean } = {
        kind: "group",
        groupId: input.symbol.symbolInstanceId,
        file: input.symbol.file,
        span,
        previewSpan,
        symbolSpan,
        language: input.symbol.language,
        symbolId: input.symbol.symbolInstanceId,
        symbolLabel: displaySymbolLabel,
        symbolKey: input.symbol.symbolKey,
        symbolInstanceId: input.symbol.symbolInstanceId,
        symbolKind: input.symbol.kind,
        confidence: "high",
        score: 1,
        indexedAt: input.indexedAt,
        stalenessBucket: getStalenessBucket(input.indexedAt || undefined, input.now()),
        collapsedChunkCount: 1,
        callGraphHint,
        ...(navigationFallback ? { navigationFallback } : {}),
        ...(nextActions ? { nextActions } : {}),
        capabilities,
        preview: truncateContent(preview, input.previewMaxChars),
        __exactLexicalMatch: true,
        ...(input.debug ? {
            debug: {
                representativeChunkCount: 1,
                pathCategory: classifyPathCategory(input.symbol.file),
                pathMultiplier: 1,
                topChunkScore: 1,
                lexicalScore: 1,
                changedFilesMultiplier: 1,
                agentFitMultiplier: 1,
                agentFitReason: "exact_registry",
                matchesMust: true,
                exactLexicalMatch: true,
                provenance: {
                    retrievalPasses: ["exact_registry"],
                    backendScoreKinds: [],
                    semanticCandidate: false,
                    lexicalCandidate: false,
                    rerankAdjusted: false,
                    exactMatchPinned: false,
                    ownerRepairApplied: Boolean(input.spanRepair?.repaired),
                },
            },
        } : {}),
    };

    result.recommendedNextAction = buildSearchGroupRecommendedAction(result);
    if (
        result.callGraphHint.supported
        && result.capabilities.callGraphCallers === "low"
    ) {
        const inboundRecovery = buildInboundRecoveryAction({
            codebaseRoot: input.codebaseRoot,
            symbolLabel: result.symbolLabel,
            groupId: result.groupId,
            scope: input.scope,
            groupBy: input.groupBy,
        });
        if (inboundRecovery) {
            result.inboundRecovery = inboundRecovery;
        }
    }
    const fallbacks = buildSearchGroupFallbacks({
        codebaseRoot: input.codebaseRoot,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        result,
    });
    if (fallbacks) {
        result.fallbacks = fallbacks;
    }

    return result;
}

export function buildGroupedSymbolSearchResult(input: {
    codebaseRoot: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    representative: SearchCandidateLike;
    previewSpan: SearchSpan;
    indexedAt: string | null;
    ownerSource: SearchOwnerSource;
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    ownerSymbolKind?: string;
    registrySymbol?: SymbolRecord;
    registryLoaded: boolean;
    registryUnavailableReason?: CallGraphUnavailableReason;
    registrySymbolRepair?: PythonSourceBackedSpanRepair;
    navigationState: SearchNavigationState;
    sidecarReadyForOutline: boolean;
    debug: boolean;
    now: () => number;
    previewMaxChars: number;
    navigationHelpers: SearchNavigationHelpers;
    chunkCount: number;
    semanticMatch: SearchCapabilityConfidence;
    spanValidation: SearchSpanValidation;
}): SearchGroupResult & { __exactLexicalMatch: boolean } {
    const symbolKind = input.ownerSymbolKind
        || (typeof input.representative.result.symbolKind === "string" ? input.representative.result.symbolKind : undefined);
    const supportBoost = Math.min(Math.log1p(input.chunkCount) * 0.01, 0.03);
    const symbolScore = input.representative.finalScore + supportBoost;
    const confidence = input.ownerSource === "owner_metadata" || input.ownerSource === "registry_repair"
        ? (symbolKind === "file" ? "low" : "medium")
        : "low";
    const registrySymbol = input.registrySymbolRepair?.symbol || input.registrySymbol;
    const symbolSpan: SearchSpan | undefined = registrySymbol
        ? {
            startLine: registrySymbol.span.startLine,
            endLine: registrySymbol.span.endLine,
        }
        : undefined;
    const span: SearchSpan = symbolSpan
        ? {
            startLine: symbolSpan.startLine,
            endLine: symbolSpan.endLine,
        }
        : {
            startLine: input.previewSpan.startLine,
            endLine: input.previewSpan.endLine,
        };
    const groupId = input.ownerSymbolInstanceId
        || input.ownerSymbolKey
        || buildFallbackGroupId(input.representative.result.relativePath, input.previewSpan);
    const repSymbolLabel = buildDisplaySymbolLabel({
        symbolLabel: typeof input.representative.result.symbolLabel === "string" ? input.representative.result.symbolLabel : undefined,
        symbolKind,
        relativePath: input.representative.result.relativePath,
        span,
        content: String(input.representative.result.content || ""),
    });
    const callGraphHint = buildSearchGroupCallGraphHint({
        file: input.representative.result.relativePath,
        language: input.representative.result.language || "unknown",
        span,
        symbolLabel: repSymbolLabel,
        ownerSymbolInstanceId: input.ownerSymbolInstanceId,
        registrySymbol,
        registryLoaded: input.registryLoaded,
        registryUnavailableReason: input.registryUnavailableReason,
        navigationState: input.navigationState,
    }, input.navigationHelpers);
    const nextActions = buildSearchNextActions(
        input.codebaseRoot,
        input.representative.result.relativePath,
        span,
        callGraphHint,
        input.sidecarReadyForOutline,
        registrySymbol,
        input.navigationHelpers,
    );
    const navigationFallback = buildNavigationFallback(
        input.codebaseRoot,
        input.representative.result.relativePath,
        input.previewSpan,
        callGraphHint,
        input.sidecarReadyForOutline,
        shouldAllowPreviewReadFallback(callGraphHint, Boolean(nextActions?.openSymbol)),
        input.navigationHelpers,
    );

    const result: SearchGroupResult & { __exactLexicalMatch: boolean } = {
        kind: "group",
        groupId,
        file: input.representative.result.relativePath,
        span,
        previewSpan: input.previewSpan,
        ...(symbolSpan ? { symbolSpan } : {}),
        language: input.representative.result.language || "unknown",
        ...(input.ownerSymbolInstanceId ? { symbolId: input.ownerSymbolInstanceId } : {}),
        symbolLabel: repSymbolLabel,
        ...(input.ownerSymbolKey ? { symbolKey: input.ownerSymbolKey } : {}),
        ...(input.ownerSymbolInstanceId ? { symbolInstanceId: input.ownerSymbolInstanceId } : {}),
        ...(symbolKind ? { symbolKind } : {}),
        confidence,
        score: symbolScore,
        indexedAt: input.indexedAt,
        stalenessBucket: getStalenessBucket(input.indexedAt || undefined, input.now()),
        collapsedChunkCount: input.chunkCount,
        callGraphHint,
        ...(navigationFallback ? { navigationFallback } : {}),
        ...(nextActions ? { nextActions } : {}),
        capabilities: buildSearchResultCapabilities({
            callGraphHint,
            confidence,
            hasOpenSymbol: Boolean(nextActions?.openSymbol),
            hasReadFallback: Boolean(navigationFallback?.readSpan),
            semanticMatch: input.semanticMatch,
            spanValidation: input.spanValidation,
        }),
        preview: buildSearchGroupPreview(repSymbolLabel, String(input.representative.result.content || ""), input.previewMaxChars),
        __exactLexicalMatch: input.representative.exactLexicalMatch,
        ...(input.debug ? {
            debug: {
                representativeChunkCount: input.chunkCount,
                pathCategory: input.representative.pathCategory,
                pathMultiplier: input.representative.pathMultiplier,
                topChunkScore: input.representative.finalScore,
                lexicalScore: input.representative.lexicalScore,
                changedFilesMultiplier: input.representative.changedFilesMultiplier,
                agentFitMultiplier: input.representative.agentFitMultiplier,
                agentFitReason: input.representative.agentFitReason,
                matchesMust: input.representative.passesMatchedMust,
                exactLexicalMatch: input.representative.exactLexicalMatch,
                symbolAggregation: {
                    ownerSource: input.ownerSource,
                    evidenceChunkCount: input.chunkCount,
                    supportBoost,
                },
                provenance: buildSearchCandidateProvenance(input.representative, input.ownerSource),
            },
        } : {}),
    };

    result.recommendedNextAction = buildSearchGroupRecommendedAction(result);
    if (
        result.callGraphHint.supported
        && result.capabilities.callGraphCallers === "low"
    ) {
        const inboundRecovery = buildInboundRecoveryAction({
            codebaseRoot: input.codebaseRoot,
            symbolLabel: result.symbolLabel,
            groupId: result.groupId,
            scope: input.scope,
            groupBy: input.groupBy,
        });
        if (inboundRecovery) {
            result.inboundRecovery = inboundRecovery;
        }
    }
    const fallbacks = buildSearchGroupFallbacks({
        codebaseRoot: input.codebaseRoot,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        result,
    });
    if (fallbacks) {
        result.fallbacks = fallbacks;
    }

    return result;
}

export function buildVisibleGroupedSearchResults(input: {
    scored: SearchCandidateLike[];
    codebaseRoot: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    limit: number;
    queryPlan: SearchQueryPlanLike;
    mustMatchesFirst: boolean;
    registry?: SymbolRegistry;
    registryUnavailableReason?: CallGraphUnavailableReason;
    navigationState: SearchNavigationState;
    sidecarReadyForOutline: boolean;
    debug: boolean;
    now: () => number;
    previewMaxChars: number;
    navigationHelpers: SearchNavigationHelpers;
    parseIndexedAtMs: (indexedAt?: string) => number | undefined;
    resolveOwner: (result: SearchResultLike) => SearchOwnerResolution;
}): {
    visibleResults: Array<SearchGroupResult & { __exactLexicalMatch: boolean }>;
    warnings: string[];
    diversitySummary: SearchDiversitySummary;
    exactMatchPinningApplied: boolean;
    registryRepairGroupCount: number;
} {
    const groups = new Map<string, GroupAccumulator>();
    for (const candidate of input.scored) {
        const result = candidate.result as SearchResultLike;
        let groupKey = "";
        const ownerResolution = input.groupBy === "symbol"
            ? input.resolveOwner(result)
            : {};
        const ownerSymbolKey = ownerResolution.ownerSymbolKey;
        const ownerSymbolInstanceId = ownerResolution.ownerSymbolInstanceId;
        const ownerSymbolKind = ownerResolution.symbolKind;
        let ownerSource: SearchOwnerSource = "fallback";

        if (input.groupBy === "file") {
            groupKey = `file:${result.relativePath}`;
        } else if (ownerSymbolKey) {
            groupKey = ownerSymbolInstanceId
                ? `owner:${ownerSymbolKey}:${ownerSymbolInstanceId}`
                : `owner:${ownerSymbolKey}`;
            ownerSource = ownerResolution.ownerSource || "owner_metadata";
        } else {
            const proximityBucket = Math.floor((Math.max(1, result.startLine || 1) - 1) / SEARCH_PROXIMITY_WINDOW);
            groupKey = `fallback:${result.relativePath}:${proximityBucket}`;
        }

        const existing = groups.get(groupKey);
        if (!existing) {
            groups.set(groupKey, {
                chunks: [candidate],
                ownerSymbolKey,
                ownerSymbolInstanceId,
                ownerSymbolKind,
                ownerSource,
            });
            continue;
        }

        existing.chunks.push(candidate);
    }

    const groupedResults: Array<SearchGroupResult & { __exactLexicalMatch: boolean }> = [];
    const spanWarningCodes = new Set<string>();
    let exactMatchPinningApplied = false;
    let registryRepairGroupCount = 0;

    for (const group of groups.values()) {
        exactMatchPinningApplied = sortSearchCandidates(
            group.chunks,
            input.queryPlan.exactMatchPinningEnabled,
            input.mustMatchesFirst,
        ) || exactMatchPinningApplied;

        const representative = group.chunks[0];
        const chunkSpanStart = Math.min(...group.chunks.map((chunk) => (chunk.result as SearchResultLike).startLine || 0));
        const chunkSpanEnd = Math.max(...group.chunks.map((chunk) => (chunk.result as SearchResultLike).endLine || 0));
        const previewSpan: SearchSpan = { startLine: chunkSpanStart, endLine: chunkSpanEnd };

        let indexedAtMax: string | undefined;
        let indexedAtMaxMs = Number.NEGATIVE_INFINITY;
        for (const chunk of group.chunks) {
            const indexedAt = typeof (chunk.result as SearchResultLike).indexedAt === "string"
                ? (chunk.result as SearchResultLike).indexedAt || undefined
                : undefined;
            const indexedAtMs = input.parseIndexedAtMs(indexedAt);
            if (indexedAtMs !== undefined && indexedAtMs > indexedAtMaxMs) {
                indexedAtMaxMs = indexedAtMs;
                indexedAtMax = indexedAt;
            }
        }

        if (group.ownerSource === "registry_repair") {
            registryRepairGroupCount += 1;
        }

        const rawRegistrySymbol = group.ownerSymbolInstanceId
            ? input.registry?.symbolsByInstanceId.get(group.ownerSymbolInstanceId)
            : undefined;
        const registrySymbolRepair = rawRegistrySymbol
            ? repairSourceBackedPythonSpan({
                codebaseRoot: input.codebaseRoot,
                symbol: rawRegistrySymbol,
            })
            : undefined;
        for (const warning of buildSearchSpanWarningCodes(registrySymbolRepair)) {
            spanWarningCodes.add(warning);
        }

        const semanticMatch: SearchCapabilityConfidence = representative.backendScoreKindsSeen.includes("dense_similarity")
            ? (input.queryPlan.intent === "semantic" || input.queryPlan.intent === "mixed" ? "high" : "medium")
            : representative.exactLexicalMatch
                ? "low"
                : "medium";

        groupedResults.push(buildGroupedSymbolSearchResult({
            codebaseRoot: input.codebaseRoot,
            query: input.query,
            scope: input.scope,
            groupBy: input.groupBy,
            representative,
            previewSpan,
            indexedAt: indexedAtMax || null,
            ownerSource: group.ownerSource,
            ownerSymbolKey: group.ownerSymbolKey,
            ownerSymbolInstanceId: group.ownerSymbolInstanceId,
            ownerSymbolKind: group.ownerSymbolKind,
            registrySymbol: rawRegistrySymbol,
            registryLoaded: Boolean(input.registry),
            registryUnavailableReason: input.registryUnavailableReason,
            registrySymbolRepair,
            navigationState: input.navigationState,
            sidecarReadyForOutline: input.sidecarReadyForOutline,
            debug: input.debug,
            now: input.now,
            previewMaxChars: input.previewMaxChars,
            navigationHelpers: input.navigationHelpers,
            chunkCount: group.chunks.length,
            semanticMatch,
            spanValidation: registrySymbolRepair
                ? (registrySymbolRepair.validated ? "verified" : registrySymbolRepair.attempted ? "unverified" : "not_applicable")
                : "not_applicable",
        }));
    }

    const rankedGroupedResults = (input.queryPlan.referenceSeeking || input.queryPlan.intent === "identifier")
        ? collapseDuplicateDeclarationGroups(groupedResults)
        : groupedResults;

    if (sortGroupedSearchResults(rankedGroupedResults, input.queryPlan.exactMatchPinningEnabled)) {
        exactMatchPinningApplied = true;
    }

    const diversityApplied = applyGroupDiversity(rankedGroupedResults, input.limit, input.groupBy);
    return {
        visibleResults: diversityApplied.selected,
        warnings: Array.from(spanWarningCodes).sort(),
        diversitySummary: diversityApplied.summary,
        exactMatchPinningApplied,
        registryRepairGroupCount,
    };
}

export function buildRawSearchResults(input: {
    scored: RawSearchCandidateLike[];
    limit: number;
    debug: boolean;
    now: () => number;
}): SearchChunkResult[] {
    return input.scored.slice(0, input.limit).map((candidate) => ({
        kind: "chunk",
        file: candidate.result.relativePath,
        span: {
            startLine: candidate.result.startLine || 0,
            endLine: candidate.result.endLine || 0,
        },
        language: candidate.result.language || "unknown",
        content: String(candidate.result.content || ""),
        score: candidate.finalScore,
        indexedAt: typeof candidate.result.indexedAt === "string" ? candidate.result.indexedAt : undefined,
        stalenessBucket: getStalenessBucket(candidate.result.indexedAt || undefined, input.now()),
        symbolId: typeof candidate.result.symbolId === "string" ? candidate.result.symbolId : undefined,
        symbolLabel: typeof candidate.result.symbolLabel === "string" ? candidate.result.symbolLabel : undefined,
        symbolKey: typeof candidate.result.ownerSymbolKey === "string" ? candidate.result.ownerSymbolKey : undefined,
        symbolInstanceId: typeof candidate.result.ownerSymbolInstanceId === "string" ? candidate.result.ownerSymbolInstanceId : undefined,
        symbolKind: typeof candidate.result.symbolKind === "string" ? candidate.result.symbolKind : undefined,
        ...(input.debug ? {
            debug: {
                baseScore: candidate.baseScore,
                fusionScore: candidate.fusionScore,
                lexicalScore: candidate.lexicalScore,
                pathMultiplier: candidate.pathMultiplier,
                pathCategory: candidate.pathCategory,
                changedFilesMultiplier: candidate.changedFilesMultiplier,
                agentFitMultiplier: candidate.agentFitMultiplier,
                agentFitReason: candidate.agentFitReason,
                matchesMust: candidate.passesMatchedMust,
                exactLexicalMatch: candidate.exactLexicalMatch,
                backendScore: candidate.backendScore,
                backendScoreKind: candidate.backendScoreKind,
                provenance: buildSearchCandidateProvenance(candidate),
            },
        } : {}),
    }));
}
