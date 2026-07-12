import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import {
    repairSourceBackedPythonSpan,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import {
    SEARCH_PROXIMITY_WINDOW,
    type PathCategory,
    type SearchGroupBy,
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
    OVERSIZED_SYMBOL_LINE_THRESHOLD,
    boundSearchEvidenceSpan,
    buildDisplaySymbolLabel,
    buildSearchGraphNavigation,
    buildSearchGroupPreview,
    buildSearchSpanWarningCodes,
    isValidSearchSpan,
    searchSpanContains,
    searchSpansEqual,
} from "./search-response-helpers.js";
import type {
    CallGraphHint,
    SearchCapabilityConfidence,
    SearchChunkResult,
    SearchGroupResult,
    SearchNavigationUnavailableReasonV2,
    SearchSpan,
} from "./search-types.js";
import {
    buildSearchGroupCallGraphHint,
    type SearchNavigationHelpers,
    type SearchNavigationState,
} from "./search-navigation.js";
import { WARNING_CODES } from "./warnings.js";

type SearchCandidateLike = {
    result: {
        relativePath: string;
        language?: string | null;
        symbolLabel?: string | null;
        symbolKind?: string | null;
        content?: string | null;
        startLine?: number;
        endLine?: number;
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
    ownerProof?: {
        symbolInstanceId: string;
        basis: "bytes" | "lines";
    };
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
    validatedOwnerChunkCount: number;
};

type RawSearchCandidateLike = SearchCandidateLike & {
    result: SearchResultLike;
    baseScore: number;
    backendScore: number;
    backendScoreKind: "dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown";
    fusionScore: number;
};

type CompactTargetResolution = {
    target: SearchGroupResult["target"];
    registrySymbol?: SymbolRecord;
};

function resolveCompactTarget(input: {
    fallbackFile: string;
    fallbackSpan: SearchSpan;
    registrySymbol?: SymbolRecord;
    ownershipRegistrySymbol?: SymbolRecord;
    ownershipValidated?: boolean;
    navigationHelpers: SearchNavigationHelpers;
}): CompactTargetResolution | undefined {
    const fallbackFile = input.navigationHelpers.sanitizeIndexedRelativeFilePath(input.fallbackFile);
    if (!fallbackFile || !isValidSearchSpan(input.fallbackSpan)) {
        return undefined;
    }

    const fallbackTarget: SearchGroupResult["target"] = {
        file: fallbackFile,
        span: {
            startLine: input.fallbackSpan.startLine,
            endLine: input.fallbackSpan.endLine,
        },
    };
    if (!input.registrySymbol) {
        return { target: fallbackTarget };
    }

    const ownershipSymbol = input.ownershipRegistrySymbol ?? input.registrySymbol;
    const ownershipFile = ownershipSymbol
        ? input.navigationHelpers.sanitizeIndexedRelativeFilePath(ownershipSymbol.file)
        : undefined;
    const ownershipSpan: SearchSpan | undefined = ownershipSymbol
        ? {
            startLine: ownershipSymbol.span.startLine,
            endLine: ownershipSymbol.span.endLine,
        }
        : undefined;
    if (
        !ownershipSymbol
        || ownershipFile !== fallbackFile
        || (!input.ownershipValidated && !searchSpanContains(ownershipSpan!, input.fallbackSpan))
    ) {
        return { target: fallbackTarget };
    }

    const registryFile = input.navigationHelpers.sanitizeIndexedRelativeFilePath(input.registrySymbol.file);
    const registrySpan: SearchSpan = {
        startLine: input.registrySymbol.span.startLine,
        endLine: input.registrySymbol.span.endLine,
    };
    if (
        registryFile !== fallbackFile
        || !isValidSearchSpan(registrySpan)
        || input.registrySymbol.symbolInstanceId !== ownershipSymbol.symbolInstanceId
    ) {
        return { target: fallbackTarget };
    }

    if (input.registrySymbol.kind !== "file") {
        const symbolId = input.registrySymbol.symbolInstanceId.trim();
        if (!symbolId) {
            return { target: fallbackTarget };
        }
        return {
            target: {
                file: registryFile,
                span: registrySpan,
                symbolId,
            },
            registrySymbol: input.registrySymbol,
        };
    }
    return {
        target: {
            file: registryFile,
            span: registrySpan,
        },
        registrySymbol: input.registrySymbol,
    };
}

function buildOwnerQuality(input: {
    registrySymbol?: SymbolRecord;
    ownerSource: SearchOwnerSource;
    spanValidation: SearchSpanValidation;
}): "high" | "medium" | "low" {
    if (input.registrySymbol?.kind === "file") {
        return "low";
    }
    if (input.registrySymbol) {
        return input.spanValidation === "unverified" ? "medium" : "high";
    }
    return input.ownerSource === "owner_metadata" || input.ownerSource === "registry_repair"
        ? "medium"
        : "low";
}

function buildGraphEvidence(callGraphHint: CallGraphHint): NonNullable<SearchGroupResult["debug"]>["graphEvidence"] | undefined {
    if (!callGraphHint.supported) {
        return undefined;
    }
    return {
        validatedAt: callGraphHint.validatedAt,
        sidecarBuiltAt: callGraphHint.sidecarBuiltAt,
    };
}

export function buildExactRegistryGroupResult(input: {
    symbol: SymbolRecord;
    spanRepair?: PythonSourceBackedSpanRepair;
    indexedAt: string | null;
    navigationState: SearchNavigationState;
    graphUnavailableReasonOverride?: SearchNavigationUnavailableReasonV2;
    debug: boolean;
    now: () => number;
    previewMaxBytes: number;
    navigationHelpers: SearchNavigationHelpers;
}): SearchGroupResult | undefined {
    const span: SearchSpan = {
        startLine: input.symbol.span.startLine,
        endLine: input.symbol.span.endLine,
    };
    const targetResolution = resolveCompactTarget({
        fallbackFile: input.symbol.file,
        fallbackSpan: span,
        registrySymbol: input.symbol,
        navigationHelpers: input.navigationHelpers,
    });
    if (!targetResolution?.registrySymbol) {
        return undefined;
    }
    const { target, registrySymbol } = targetResolution;
    const displaySymbolLabel = buildDisplaySymbolLabel({
        symbolLabel: input.symbol.label,
        symbolKind: input.symbol.kind,
        relativePath: target.file,
        span: target.span,
    });
    const callGraphHint = buildSearchGroupCallGraphHint({
        file: target.file,
        language: registrySymbol.language,
        span: target.span,
        symbolLabel: displaySymbolLabel,
        ownerSymbolInstanceId: registrySymbol.symbolInstanceId,
        registrySymbol,
        registryLoaded: true,
        navigationState: input.navigationState,
    }, input.navigationHelpers);
    const spanValidation: SearchSpanValidation = input.spanRepair
        ? (input.spanRepair.validated ? "verified" : input.spanRepair.attempted ? "unverified" : "not_applicable")
        : "not_applicable";
    const graphEvidence = input.graphUnavailableReasonOverride
        ? undefined
        : buildGraphEvidence(callGraphHint);
    const exactEvidenceSpan = target.span.endLine - target.span.startLine + 1 >= OVERSIZED_SYMBOL_LINE_THRESHOLD
        ? boundSearchEvidenceSpan(target.span)
        : undefined;

    return {
        target,
        displayLabel: displaySymbolLabel,
        language: registrySymbol.language,
        symbolKind: registrySymbol.kind,
        score: 1,
        quality: {
            owner: buildOwnerQuality({
                registrySymbol,
                ownerSource: "owner_metadata",
                spanValidation,
            }),
            semantic: "medium",
        },
        preview: "",
        ...(exactEvidenceSpan ? { evidenceSpan: exactEvidenceSpan } : {}),
        navigation: buildSearchGraphNavigation(
            callGraphHint,
            input.symbol.name,
            input.graphUnavailableReasonOverride,
        ),
        __groupId: registrySymbol.symbolInstanceId,
        __symbolKey: registrySymbol.symbolKey,
        __symbolInstanceId: registrySymbol.symbolInstanceId,
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
                freshness: {
                    newestChunkIndexedAt: input.indexedAt,
                    ageBucket: getStalenessBucket(input.indexedAt || undefined, input.now()),
                },
                ...(graphEvidence ? { graphEvidence } : {}),
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
}

export function buildGroupedSymbolSearchResult(input: {
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
    graphUnavailableReasonOverride?: SearchNavigationUnavailableReasonV2;
    debug: boolean;
    now: () => number;
    previewMaxBytes: number;
    navigationHelpers: SearchNavigationHelpers;
    chunkCount: number;
    semanticMatch: SearchCapabilityConfidence;
    spanValidation: SearchSpanValidation;
    ownershipValidated?: boolean;
}): SearchGroupResult | undefined {
    const supportBoost = Math.min(Math.log1p(input.chunkCount) * 0.01, 0.03);
    const symbolScore = input.representative.finalScore + supportBoost;
    if (!Number.isFinite(symbolScore)) {
        return undefined;
    }
    const repairedRegistrySymbol = input.registrySymbolRepair?.validated
        && input.registrySymbolRepair.symbol?.symbolInstanceId === input.registrySymbol?.symbolInstanceId
        ? input.registrySymbolRepair.symbol
        : undefined;
    const candidateRegistrySymbol = repairedRegistrySymbol || input.registrySymbol;
    const targetResolution = resolveCompactTarget({
        fallbackFile: input.representative.result.relativePath,
        fallbackSpan: input.previewSpan,
        registrySymbol: candidateRegistrySymbol,
        ownershipRegistrySymbol: input.registrySymbol,
        ownershipValidated: input.ownershipValidated,
        navigationHelpers: input.navigationHelpers,
    });
    if (!targetResolution) {
        return undefined;
    }
    const { target, registrySymbol } = targetResolution;
    const representativeSpan: SearchSpan = {
        startLine: input.representative.result.startLine ?? input.previewSpan.startLine,
        endLine: input.representative.result.endLine ?? input.previewSpan.endLine,
    };
    const rawEvidenceSpan = isValidSearchSpan(representativeSpan) ? representativeSpan : input.previewSpan;
    const ownedEvidenceSpan = registrySymbol
        ? {
            startLine: Math.max(rawEvidenceSpan.startLine, target.span.startLine),
            endLine: Math.min(rawEvidenceSpan.endLine, target.span.endLine),
        }
        : rawEvidenceSpan;
    const evidenceSpan = boundSearchEvidenceSpan(
        isValidSearchSpan(ownedEvidenceSpan) ? ownedEvidenceSpan : input.previewSpan,
    );
    const effectiveOwnerSource: SearchOwnerSource = registrySymbol
        ? input.ownerSource
        : candidateRegistrySymbol
            ? "fallback"
            : input.ownerSource;
    const representativeSymbolKind = typeof input.representative.result.symbolKind === "string"
        ? input.representative.result.symbolKind
        : undefined;
    const symbolKind = registrySymbol?.kind
        || representativeSymbolKind
        || (!candidateRegistrySymbol ? input.ownerSymbolKind : undefined);
    const groupId = registrySymbol?.symbolInstanceId
        || registrySymbol?.symbolKey
        || buildFallbackGroupId(target.file, input.previewSpan);
    const repSymbolLabel = buildDisplaySymbolLabel({
        symbolLabel: typeof input.representative.result.symbolLabel === "string" ? input.representative.result.symbolLabel : undefined,
        symbolKind,
        relativePath: target.file,
        span: target.span,
        content: String(input.representative.result.content || ""),
    });
    const callGraphHint = buildSearchGroupCallGraphHint({
        file: target.file,
        language: input.representative.result.language || "unknown",
        span: target.span,
        symbolLabel: repSymbolLabel,
        ownerSymbolInstanceId: input.ownerSymbolInstanceId,
        registrySymbol,
        registryLoaded: input.registryLoaded,
        registryUnavailableReason: input.registryUnavailableReason,
        navigationState: input.navigationState,
    }, input.navigationHelpers);

    const graphEvidence = input.graphUnavailableReasonOverride
        ? undefined
        : buildGraphEvidence(callGraphHint);
    return {
        target,
        displayLabel: repSymbolLabel,
        language: input.representative.result.language || "unknown",
        ...(symbolKind ? { symbolKind } : {}),
        score: symbolScore,
        quality: {
            owner: buildOwnerQuality({
                registrySymbol,
                ownerSource: effectiveOwnerSource,
                spanValidation: input.spanValidation,
            }),
            semantic: input.semanticMatch,
        },
        ...(input.chunkCount >= 2 ? { evidenceChunks: input.chunkCount } : {}),
        preview: buildSearchGroupPreview(repSymbolLabel, String(input.representative.result.content || ""), input.previewMaxBytes),
        ...(!searchSpansEqual(target.span, evidenceSpan) ? { evidenceSpan } : {}),
        navigation: buildSearchGraphNavigation(
            callGraphHint,
            registrySymbol?.name,
            input.graphUnavailableReasonOverride,
        ),
        __groupId: groupId,
        ...(registrySymbol?.symbolKey ? { __symbolKey: registrySymbol.symbolKey } : {}),
        ...(registrySymbol?.symbolInstanceId ? { __symbolInstanceId: registrySymbol.symbolInstanceId } : {}),
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
                    ownerSource: effectiveOwnerSource,
                    evidenceChunkCount: input.chunkCount,
                    supportBoost,
                },
                freshness: {
                    newestChunkIndexedAt: input.indexedAt,
                    ageBucket: getStalenessBucket(input.indexedAt || undefined, input.now()),
                },
                ...(graphEvidence ? { graphEvidence } : {}),
                provenance: buildSearchCandidateProvenance(input.representative, effectiveOwnerSource),
            },
        } : {}),
    };
}

export function buildVisibleGroupedSearchResults(input: {
    scored: SearchCandidateLike[];
    codebaseRoot: string;
    groupBy: SearchGroupBy;
    limit: number;
    queryPlan: SearchQueryPlanLike;
    mustMatchesFirst: boolean;
    registry?: SymbolRegistry;
    registryUnavailableReason?: CallGraphUnavailableReason;
    navigationState: SearchNavigationState;
    graphUnavailableReasonOverride?: SearchNavigationUnavailableReasonV2;
    debug: boolean;
    now: () => number;
    previewMaxBytes: number;
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
    let invalidGroupCandidateOmitted = false;
    for (const candidate of input.scored) {
        const result = candidate.result as SearchResultLike;
        const normalizedFile = input.navigationHelpers.sanitizeIndexedRelativeFilePath(result.relativePath);
        const candidateSpan: SearchSpan = {
            startLine: result.startLine ?? Number.NaN,
            endLine: result.endLine ?? Number.NaN,
        };
        if (!normalizedFile || !isValidSearchSpan(candidateSpan) || !Number.isFinite(candidate.finalScore)) {
            invalidGroupCandidateOmitted = true;
            continue;
        }
        const safeCandidate: SearchCandidateLike = normalizedFile === result.relativePath
            ? candidate
            : {
                ...candidate,
                result: {
                    ...result,
                    relativePath: normalizedFile,
                },
            };
        const safeResult = safeCandidate.result as SearchResultLike;
        let groupKey = "";
        const ownerResolution = input.groupBy === "symbol"
            ? input.resolveOwner(safeResult)
            : {};
        const ownerSymbolKey = ownerResolution.ownerSymbolKey;
        const ownerSymbolInstanceId = ownerResolution.ownerSymbolInstanceId;
        const ownerSymbolKind = ownerResolution.symbolKind;
        let ownerSource: SearchOwnerSource = "fallback";

        if (input.groupBy === "file") {
            groupKey = `file:${safeResult.relativePath}`;
        } else if (ownerSymbolKey) {
            groupKey = ownerSymbolInstanceId
                ? `owner:${safeResult.relativePath}:${ownerSymbolKey}:${ownerSymbolInstanceId}`
                : `owner:${safeResult.relativePath}:${ownerSymbolKey}`;
            ownerSource = ownerResolution.ownerSource || "owner_metadata";
        } else {
            const proximityBucket = Math.floor((candidateSpan.startLine - 1) / SEARCH_PROXIMITY_WINDOW);
            groupKey = `fallback:${safeResult.relativePath}:${proximityBucket}`;
        }

        const existing = groups.get(groupKey);
        if (!existing) {
            groups.set(groupKey, {
                chunks: [safeCandidate],
                ownerSymbolKey,
                ownerSymbolInstanceId,
                ownerSymbolKind,
                ownerSource,
                validatedOwnerChunkCount: ownerResolution.ownerProof?.symbolInstanceId === ownerSymbolInstanceId ? 1 : 0,
            });
            continue;
        }

        existing.chunks.push(safeCandidate);
        if (ownerResolution.ownerProof?.symbolInstanceId === existing.ownerSymbolInstanceId) {
            existing.validatedOwnerChunkCount += 1;
        }
    }

    const groupedResults: Array<SearchGroupResult & { __exactLexicalMatch: boolean }> = [];
    const spanWarningCodes = new Set<string>();
    if (invalidGroupCandidateOmitted) {
        spanWarningCodes.add(WARNING_CODES.SEARCH_INVALID_GROUP_TARGET_OMITTED);
    }
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

        const groupedResult = buildGroupedSymbolSearchResult({
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
            graphUnavailableReasonOverride: input.graphUnavailableReasonOverride,
            debug: input.debug,
            now: input.now,
            previewMaxBytes: input.previewMaxBytes,
            navigationHelpers: input.navigationHelpers,
            chunkCount: group.chunks.length,
            semanticMatch,
            spanValidation: registrySymbolRepair
                ? (registrySymbolRepair.validated ? "verified" : registrySymbolRepair.attempted ? "unverified" : "not_applicable")
                : "not_applicable",
            ownershipValidated: group.validatedOwnerChunkCount === group.chunks.length,
        });
        if (groupedResult) {
            groupedResults.push(groupedResult);
        } else {
            spanWarningCodes.add(WARNING_CODES.SEARCH_INVALID_GROUP_TARGET_OMITTED);
        }
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
