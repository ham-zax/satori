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
import { buildExactRegistryHitEnvelope } from "./search-exact-registry-hit.js";
import type { SearchQueryPlan } from "./search-lexical-scoring.js";
import type { ParsedSearchOperators } from "./search-query-planning.js";
import type { SearchQuerySupport } from "./search-query-support.js";
import {
    readCurrentSourceEvidence,
    sliceHashMatchedCurrentSourceSymbolContent,
    validateCurrentSourceSymbolSpansWithEvidence,
} from "./current-source-symbols.js";
import type {
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchResponseHints,
    SearchResponseEnvelope,
} from "./search-types.js";
import type { FreshnessDecision } from "./sync.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import { buildSearchDebugSummary, buildSearchGroupPreview } from "./search-response-helpers.js";
import { WARNING_CODES } from "./warnings.js";
import {
    findExactRegistryMatch,
    shouldAttemptExactRegistryLookup,
    type ExactRegistryLookupDebug,
} from "./search/exact-registry.js";

type ChangedFilesState = {
    available: boolean;
    files: Set<string>;
};

type CallGraphUnavailableReason = "missing_symbol" | "stale_symbol_ref" | "unsupported_language" | "missing_relationship_sidecar" | "incompatible_relationship_sidecar" | "missing_symbol_registry" | "incompatible_symbol_registry";

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

type SearchExactFastPathInput = {
    absolutePath: string;
    effectiveRoot: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    resultMode: SearchResultMode;
    limit: number;
    debugMode: "none" | "summary" | "ranking" | "freshness" | "full";
    rankingMode: "default" | "auto_changed_first";
    semanticQuery: string;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    freshnessDecision: FreshnessDecision;
    freshnessSummary: SearchFreshnessSummary;
    proofDebugHint?: CompletionProbeDebugHint;
    partialIndexSearchWarnings: string[];
    phaseTimings: NonNullable<SearchDebugHint["phaseTimingsMs"]>;
    candidateLimit: number;
    maxAttempts: number;
    operatorSummary: SearchDebugHint["operatorSummary"];
    filterSummary: SearchDebugHint["filterSummary"];
    changedFilesState: ChangedFilesState;
    observedChangedFilesState: ChangedFilesState;
    debugChangedFilesState?: ChangedFilesState;
    changedFilesCount: number;
    changedFilesBoostSkippedForLargeChangeSet: boolean;
    dirtyFilesNotFreshened: boolean;
    rankingProvenance: SearchDebugHint["rankingProvenance"];
    previewMaxBytes: number;
    navigationAuthority: "valid" | "unavailable";
};

type SearchExactFastPathHandled = {
    kind: "handled";
    exactRegistryDebug: ExactRegistryLookupDebug;
    searchSymbolRegistry: SymbolRegistry;
    searchSymbolRegistryManifestHash: string;
    exactRegistryFallbackForTrackedLexical: boolean;
    envelope: SearchResponseEnvelope;
    resultsBeforeFilter: number;
    resultsAfterFilter: number;
};

type SearchExactFastPathContinue = {
    kind: "continue";
    exactRegistryDebug?: ExactRegistryLookupDebug;
    searchSymbolRegistry?: SymbolRegistry;
    searchSymbolRegistryManifestHash?: string;
    exactRegistryFallbackForTrackedLexical: boolean;
    warning?: string;
};

export type SearchExactFastPathOutcome =
    | SearchExactFastPathHandled
    | SearchExactFastPathContinue;

export type SearchExactFastPathHost = {
    searchQuerySupport: SearchQuerySupport;
    measureSearchPhase: <T>(
        phase: "registryLoad" | "exactRegistry" | "navigationValidation",
        run: () => Promise<T>,
    ) => Promise<T>;
    loadRegistryManifest: (normalizedRootPath: string) => Promise<RegistryManifestState>;
    loadRegistryValidatedCallGraphSidecar: (input: {
        codebaseRoot: string;
        registryManifestHash?: string;
        registryUnavailableReason?: CallGraphUnavailableReason;
    }) => Promise<NavigationState>;
    buildChangedCodeDebug: (
        codebaseRoot: string,
        changedFilesState: ChangedFilesState,
    ) => SearchDebugHint["changedCode"] | undefined;
    buildGeneratedArtifactsVerificationHint: (
        codebaseRoot: string,
        results: Array<{ file: string; span: { startLine: number; endLine: number } }>,
    ) => NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["verification"]>["generatedArtifacts"] | undefined;
    getSearchNavigationHelpers: () => Parameters<typeof buildExactRegistryHitEnvelope>[0]["navigationHelpers"];
    now: () => number;
};

function isExactRegistryEligible(input: SearchExactFastPathInput, host: SearchExactFastPathHost): boolean {
    const hasExactPathFilter = input.parsedOperators.path.some((pattern) => {
        const normalized = host.searchQuerySupport.normalizeRelativePathForIgnoreCheck(pattern);
        return Boolean(normalized && host.searchQuerySupport.isExactSearchPathFilter(normalized));
    });

    return input.resultMode === "grouped"
        && input.groupBy === "symbol"
        && shouldAttemptExactRegistryLookup({
            semanticQuery: input.semanticQuery,
            intent: input.queryPlan.intent,
            lexicalTerms: input.queryPlan.lexicalTerms.map((term) => term.value),
            quotedLiteralPhrases: input.queryPlan.quotedLiteralPhrases,
            hasExactPathFilter,
        });
}

export async function runExactRegistryFastPath(
    input: SearchExactFastPathInput,
    host: SearchExactFastPathHost,
): Promise<SearchExactFastPathOutcome> {
    const eligible = isExactRegistryEligible(input, host);
    if (!eligible) {
        return {
            kind: "continue",
            exactRegistryFallbackForTrackedLexical: false,
        };
    }
    if (input.navigationAuthority !== "valid") {
        return {
            kind: "continue",
            exactRegistryDebug: {
                attempted: false,
                status: "miss",
                reason: "navigation_unavailable",
                inspectedSymbolCount: 0,
                filteredSymbolCount: 0,
            },
            exactRegistryFallbackForTrackedLexical: false,
        };
    }

    const registryState = await host.measureSearchPhase(
        "registryLoad",
        () => host.loadRegistryManifest(input.effectiveRoot),
    );
    if (registryState.status !== "ok") {
        return {
            kind: "continue",
            exactRegistryDebug: host.searchQuerySupport.buildUnavailableExactRegistryDebug(registryState.reason),
            exactRegistryFallbackForTrackedLexical: true,
        };
    }

    const exactRegistryMatch = await host.measureSearchPhase("exactRegistry", async () => findExactRegistryMatch({
        registry: registryState.registry,
        semanticQuery: input.semanticQuery,
        intent: input.queryPlan.intent,
        lexicalTerms: input.queryPlan.lexicalTerms.map((term) => term.value),
        quotedLiteralPhrases: input.queryPlan.quotedLiteralPhrases,
        operators: {
            path: [...input.parsedOperators.path],
        },
        filterSymbol: host.searchQuerySupport.buildExactRegistrySymbolFilter({
            scope: input.scope,
            parsedOperators: input.parsedOperators,
        }),
    }));
    const exactRegistryDebug = exactRegistryMatch.debug;

    if (exactRegistryMatch.status !== "hit") {
        return {
            kind: "continue",
            exactRegistryDebug,
            searchSymbolRegistry: registryState.registry,
            searchSymbolRegistryManifestHash: registryState.manifestHash,
            exactRegistryFallbackForTrackedLexical: true,
        };
    }

    let exactRegistrySymbol = exactRegistryMatch.symbol;
    const normalizedExactPath = exactRegistrySymbol.file.replace(/\\/g, "/").replace(/^\/+/, "");
    let currentSourceEvidence;
    if (
        input.dirtyFilesNotFreshened
        && input.observedChangedFilesState.files.has(normalizedExactPath)
    ) {
        const validationResult = await host.measureSearchPhase(
            "navigationValidation",
            () => validateCurrentSourceSymbolSpansWithEvidence({
                codebaseRoot: input.effectiveRoot,
                symbols: [exactRegistrySymbol],
            }),
        );
        const [validation] = validationResult.validations;
        currentSourceEvidence = validationResult.evidence;
        if (!validation || (validation.match !== "matched" && validation.match !== "not_applicable")) {
            return {
                kind: "continue",
                exactRegistryDebug,
                searchSymbolRegistry: registryState.registry,
                searchSymbolRegistryManifestHash: registryState.manifestHash,
                exactRegistryFallbackForTrackedLexical: true,
            };
        }
        exactRegistrySymbol = validation.symbol;
    }

    const rerankDecision = host.searchQuerySupport.resolveRerankDecision(input.scope, input.queryPlan);
    const callGraphNavigationState = await host.measureSearchPhase(
        "navigationValidation",
        () => host.loadRegistryValidatedCallGraphSidecar({
            codebaseRoot: input.effectiveRoot,
            registryManifestHash: registryState.manifestHash,
        }),
    );

    currentSourceEvidence ??= await readCurrentSourceEvidence(
        input.effectiveRoot,
        exactRegistrySymbol.file,
    );
    const exactSourceContent = currentSourceEvidence
        ? sliceHashMatchedCurrentSourceSymbolContent(
            currentSourceEvidence,
            currentSourceEvidence.canonicalRoot,
            exactRegistrySymbol,
        )
        : undefined;
    const exactPreview = exactSourceContent === undefined
        ? ""
        : buildSearchGroupPreview(
            exactRegistrySymbol.label,
            exactSourceContent,
            input.previewMaxBytes,
        );
    const debugRankingProvenance = input.debugMode !== "none"
        ? {
            ...input.rankingProvenance,
            semanticPassesUsed: [],
            lexicalPassesUsed: [],
            livePathSupplementUsed: false,
            lexicalFileScanUsed: false,
            rerankApplied: false,
            exactMatchPinningApplied: false,
            registryRepairGroupCount: 0,
        }
        : undefined;
    const debugRerank = input.debugMode !== "none"
        ? {
            enabledByPolicy: rerankDecision.enabledByPolicy,
            skippedByScopeDocs: rerankDecision.skippedByScopeDocs,
            skippedByIdentifierIntent: rerankDecision.skippedByIdentifierIntent,
            skippedByExactPin: false,
            capabilityPresent: rerankDecision.capabilityPresent,
            rerankerPresent: rerankDecision.rerankerPresent,
            enabled: false,
            attempted: false,
            applied: false,
            exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
            exactMatchPinningApplied: false,
            candidatesIn: 1,
            candidatesReranked: 0,
            topK: SEARCH_RERANK_TOP_K,
            rankK: SEARCH_RERANK_RRF_K,
            weight: SEARCH_RERANK_WEIGHT,
            docMaxLines: SEARCH_RERANK_DOC_MAX_LINES,
            docMaxChars: SEARCH_RERANK_DOC_MAX_CHARS,
        }
        : undefined;
    const changedCode = input.debugChangedFilesState && (input.debugMode === "freshness" || input.debugMode === "full")
        ? host.buildChangedCodeDebug(input.effectiveRoot, input.debugChangedFilesState)
        : undefined;
    const rankingDebug = input.debugMode === "ranking" || input.debugMode === "full"
        ? {
            queryIntent: {
                classification: input.queryPlan.intent,
                confidence: input.queryPlan.confidence,
                reasons: [...input.queryPlan.reasons],
                lexicalTerms: input.queryPlan.lexicalTerms.map((term) => term.value),
                semanticQuery: input.semanticQuery,
            },
            retrieval: {
                mode: input.queryPlan.retrievalMode,
                scorePolicyKind: input.queryPlan.scorePolicyKind,
                backendScoreKinds: [],
            },
            rankingProvenance: debugRankingProvenance!,
            exactRegistry: exactRegistryDebug,
            passesUsed: ["exact_registry"],
            candidateLimit: input.candidateLimit,
            mustRetry: {
                attempts: 0,
                maxAttempts: input.maxAttempts,
                applied: input.parsedOperators.must.length > 0,
                satisfied: true,
                finalCount: 1,
            },
            operatorSummary: input.operatorSummary,
            filterSummary: input.filterSummary,
            changedFilesBoost: {
                enabled: input.rankingMode === "auto_changed_first",
                applied: false,
                available: input.changedFilesState.available,
                changedCount: input.changedFilesCount,
                maxChangedFilesForBoost: SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES,
                skippedForLargeChangeSet: input.changedFilesBoostSkippedForLargeChangeSet,
                multiplier: SEARCH_CHANGED_FIRST_MULTIPLIER,
                boostedCandidates: 0,
            },
            rerank: debugRerank!,
        }
        : undefined;
    const debugSummary = input.debugMode !== "none"
        ? buildSearchDebugSummary({
            passesUsed: ["exact_registry"],
            rankingProvenance: debugRankingProvenance!,
            retrieval: {
                mode: input.queryPlan.retrievalMode,
                scorePolicyKind: input.queryPlan.scorePolicyKind,
                backendScoreKinds: [],
            },
            rerank: debugRerank,
            ...(changedCode ? { changedCode } : {}),
        }, input.freshnessSummary)
        : undefined;
    const debugSearch: NonNullable<SearchResponseHints["debugSearch"]> | undefined = input.debugMode === "full"
        ? { ...rankingDebug!, phaseTimingsMs: input.phaseTimings, ...(changedCode ? { changedCode } : {}) }
        : input.debugMode === "ranking"
            ? rankingDebug
            : input.debugMode === "freshness"
                ? { phaseTimingsMs: input.phaseTimings, ...(changedCode ? { changedCode } : {}) }
                : undefined;

    const envelope = buildExactRegistryHitEnvelope({
        codebaseRoot: input.effectiveRoot,
        absolutePath: input.absolutePath,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        limit: input.limit,
        freshnessDecision: input.freshnessDecision,
        freshnessSummary: input.freshnessSummary,
        proofDebugHint: input.proofDebugHint,
        symbol: exactRegistrySymbol,
        preview: exactPreview,
        indexedAt: registryState.registry.manifest.builtAt || null,
        navigationState: callGraphNavigationState,
        navigationWarning: callGraphNavigationState.warning,
        debug: input.debugMode === "ranking" || input.debugMode === "full",
        debugDetail: input.debugMode === "full" ? "full" : "ranking",
        ...(debugSummary ? { debugSummary } : {}),
        ...(debugSearch ? { debugSearch } : {}),
        now: host.now,
        previewMaxBytes: input.previewMaxBytes,
        navigationHelpers: host.getSearchNavigationHelpers(),
        partialIndexSearchWarnings: input.partialIndexSearchWarnings,
        dirtyFilesNotFreshened: input.dirtyFilesNotFreshened,
        changedFilesBoostSkippedForLargeChangeSet: input.changedFilesBoostSkippedForLargeChangeSet,
        buildNoiseMitigationHint: (files) => host.searchQuerySupport.buildNoiseMitigationHint(input.effectiveRoot, files, input.scope),
        buildGeneratedArtifactsVerificationHint: (results) => host.buildGeneratedArtifactsVerificationHint(input.effectiveRoot, results),
    });

    if (!envelope) {
        return {
            kind: "continue",
            exactRegistryDebug,
            searchSymbolRegistry: registryState.registry,
            searchSymbolRegistryManifestHash: registryState.manifestHash,
            exactRegistryFallbackForTrackedLexical: true,
            warning: WARNING_CODES.SEARCH_INVALID_GROUP_TARGET_OMITTED,
        };
    }

    return {
        kind: "handled",
        exactRegistryDebug,
        searchSymbolRegistry: registryState.registry,
        searchSymbolRegistryManifestHash: registryState.manifestHash,
        exactRegistryFallbackForTrackedLexical: true,
        envelope,
        resultsBeforeFilter: exactRegistryMatch.debug.inspectedSymbolCount,
        resultsAfterFilter: 1,
    };
}
