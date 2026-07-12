import type { SymbolRecord } from "@zokizuan/satori-core";
import {
    repairSourceBackedPythonSpan,
} from "./python-call-fallback.js";
import {
    buildExactRegistryGroupResult,
} from "./search-group-results.js";
import type {
    SearchNavigationHelpers,
    SearchNavigationState,
} from "./search-navigation.js";
import {
    buildGroupedSearchEnvelope,
} from "./search-response-envelopes.js";
import {
    buildSearchSpanWarningCodes,
} from "./search-response-helpers.js";
import type {
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchResponseEnvelope,
    SearchSpan,
} from "./search-types.js";
import type { ExactRegistryLookupDebug } from "./search/exact-registry.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import type { FreshnessDecision } from "./sync.js";
import { WARNING_CODES } from "./warnings.js";

type ExactRegistryHitDebugInput = {
    queryIntent: SearchDebugHint["queryIntent"];
    retrieval: SearchDebugHint["retrieval"];
    rankingProvenance: SearchDebugHint["rankingProvenance"];
    phaseTimingsMs: NonNullable<SearchDebugHint["phaseTimingsMs"]>;
    candidateLimit: number;
    mustRetryApplied: boolean;
    maxAttempts: number;
    operatorSummary: SearchDebugHint["operatorSummary"];
    filterSummary: SearchDebugHint["filterSummary"];
    changedFilesBoost: SearchDebugHint["changedFilesBoost"];
    rerank: NonNullable<SearchDebugHint["rerank"]>;
    changedCode?: SearchDebugHint["changedCode"];
    exactRegistry: ExactRegistryLookupDebug;
};

export type BuildExactRegistryHitEnvelopeInput = {
    codebaseRoot: string;
    absolutePath: string;
    query: string;
    scope: SearchResponseEnvelope["scope"];
    groupBy: SearchResponseEnvelope["groupBy"];
    limit: number;
    freshnessDecision: FreshnessDecision;
    freshnessSummary: SearchFreshnessSummary;
    proofDebugHint?: CompletionProbeDebugHint;
    symbol: SymbolRecord;
    indexedAt: string | null;
    navigationState: SearchNavigationState;
    navigationWarning?: string;
    debug: boolean;
    debugInput: ExactRegistryHitDebugInput;
    now: () => number;
    previewMaxBytes: number;
    navigationHelpers: SearchNavigationHelpers;
    partialIndexSearchWarnings: string[];
    dirtyFilesNotFreshened: boolean;
    changedFilesBoostSkippedForLargeChangeSet: boolean;
    buildNoiseMitigationHint: (files: string[]) => unknown;
    buildGeneratedArtifactsVerificationHint: (
        results: Array<{ file: string; span: SearchSpan }>
    ) => NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["verification"]>["generatedArtifacts"] | undefined;
};

function buildExactRegistryWarnings(input: {
    partialIndexSearchWarnings: string[];
    navigationWarning?: string;
    dirtyFilesNotFreshened: boolean;
    changedFilesBoostSkippedForLargeChangeSet: boolean;
    spanWarningCodes: string[];
}): string[] {
    const warnings = [
        ...input.partialIndexSearchWarnings,
        ...input.spanWarningCodes,
    ];
    if (input.navigationWarning) {
        warnings.push(`SEARCH_${input.navigationWarning}`);
    }
    if (input.dirtyFilesNotFreshened) {
        warnings.push(WARNING_CODES.SEARCH_DIRTY_WORKTREE_NOT_SYNCED);
    }
    if (input.changedFilesBoostSkippedForLargeChangeSet) {
        warnings.push(WARNING_CODES.SEARCH_CHANGED_FILES_BOOST_SKIPPED);
    }
    return Array.from(new Set(warnings)).sort();
}

function buildExactRegistryDebugHint(
    input: ExactRegistryHitDebugInput,
): SearchDebugHint {
    return {
        queryIntent: input.queryIntent,
        retrieval: input.retrieval,
        rankingProvenance: input.rankingProvenance,
        exactRegistry: input.exactRegistry,
        phaseTimingsMs: input.phaseTimingsMs,
        passesUsed: ["exact_registry"],
        candidateLimit: input.candidateLimit,
        mustRetry: {
            attempts: 0,
            maxAttempts: input.maxAttempts,
            applied: input.mustRetryApplied,
            satisfied: true,
            finalCount: 1,
        },
        operatorSummary: input.operatorSummary,
        filterSummary: input.filterSummary,
        changedFilesBoost: input.changedFilesBoost,
        ...(input.changedCode ? { changedCode: input.changedCode } : {}),
        rerank: input.rerank,
    } satisfies SearchDebugHint;
}

export function buildExactRegistryHitEnvelope(
    input: BuildExactRegistryHitEnvelopeInput,
): SearchResponseEnvelope | undefined {
    const exactRegistrySymbolRepair = repairSourceBackedPythonSpan({
        codebaseRoot: input.codebaseRoot,
        symbol: input.symbol,
    });
    const finalizedSearchWarnings = buildExactRegistryWarnings({
        partialIndexSearchWarnings: input.partialIndexSearchWarnings,
        navigationWarning: input.navigationWarning,
        dirtyFilesNotFreshened: input.dirtyFilesNotFreshened,
        changedFilesBoostSkippedForLargeChangeSet: input.changedFilesBoostSkippedForLargeChangeSet,
        spanWarningCodes: buildSearchSpanWarningCodes(exactRegistrySymbolRepair),
    });

    const exactGroup = buildExactRegistryGroupResult({
        symbol: exactRegistrySymbolRepair.symbol,
        spanRepair: exactRegistrySymbolRepair,
        indexedAt: input.indexedAt,
        navigationState: input.navigationState,
        graphUnavailableReasonOverride: input.partialIndexSearchWarnings.includes(
            "SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE",
        )
            ? "partial_index_navigation_unavailable"
            : undefined,
        debug: input.debug,
        now: input.now,
        previewMaxBytes: input.previewMaxBytes,
        navigationHelpers: input.navigationHelpers,
    });
    if (!exactGroup) {
        return undefined;
    }
    const visibleGroupedResults = [exactGroup];
    const noiseMitigationHint = input.buildNoiseMitigationHint(
        visibleGroupedResults.map((result) => result.target.file),
    );
    const generatedArtifactsHint = input.buildGeneratedArtifactsVerificationHint(
        visibleGroupedResults.map((result) => ({
            file: result.target.file,
            span: result.target.span,
        })),
    );
    const debugSearchHint = input.debug
        ? buildExactRegistryDebugHint(input.debugInput)
        : undefined;

    return buildGroupedSearchEnvelope({
        codebaseRoot: input.codebaseRoot,
        absolutePath: input.absolutePath,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        limit: input.limit,
        freshnessDecision: input.freshnessDecision,
        freshnessSummary: input.freshnessSummary,
        warnings: finalizedSearchWarnings,
        debugHint: debugSearchHint,
        proofDebugHint: input.proofDebugHint,
        noiseMitigationHint,
        generatedArtifactsHint,
        results: visibleGroupedResults,
    });
}
