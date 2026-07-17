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
    SearchDebugMode,
    SearchFreshnessSummary,
    SearchResponseHints,
    SearchResponseEnvelope,
    SearchSpan,
} from "./search-types.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import type { FreshnessDecision } from "./sync.js";
import { WARNING_CODES } from "./warnings.js";
import { appendGroupedCandidateStage } from "./search-candidate-survival.js";
import type { SearchCandidateSurvivalDebug } from "./search-types.js";

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
    matches: Array<{
        symbol: SymbolRecord;
        preview?: string;
    }>;
    indexedAt: string | null;
    navigationState: SearchNavigationState;
    navigationWarning?: string;
    debugMode: SearchDebugMode;
    debugSummary?: NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["debugSummary"]>;
    debugSearch?: NonNullable<SearchResponseHints["debugSearch"]>;
    candidateSurvival?: SearchCandidateSurvivalDebug;
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

export function buildExactRegistryHitEnvelope(
    input: BuildExactRegistryHitEnvelopeInput,
): SearchResponseEnvelope | undefined {
    const repairedMatches = input.matches.map((match) => ({
        ...match,
        repair: repairSourceBackedPythonSpan({
            codebaseRoot: input.codebaseRoot,
            symbol: match.symbol,
        }),
    }));
    const finalizedSearchWarnings = buildExactRegistryWarnings({
        partialIndexSearchWarnings: input.partialIndexSearchWarnings,
        navigationWarning: input.navigationWarning,
        dirtyFilesNotFreshened: input.dirtyFilesNotFreshened,
        changedFilesBoostSkippedForLargeChangeSet: input.changedFilesBoostSkippedForLargeChangeSet,
        spanWarningCodes: repairedMatches.flatMap(({ repair }) => buildSearchSpanWarningCodes(repair)),
    });

    const visibleGroupedResults = repairedMatches.flatMap(({ preview, repair }) => {
        const group = buildExactRegistryGroupResult({
            symbol: repair.symbol,
            preview,
            spanRepair: repair,
            indexedAt: input.indexedAt,
            navigationState: input.navigationState,
            graphUnavailableReasonOverride: input.partialIndexSearchWarnings.includes(
                "SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE",
            )
                ? "partial_index_navigation_unavailable"
                : undefined,
            debugMode: input.debugMode,
            now: input.now,
            previewMaxBytes: input.previewMaxBytes,
            navigationHelpers: input.navigationHelpers,
        });
        return group ? [group] : [];
    });
    if (visibleGroupedResults.length === 0) {
        return undefined;
    }
    if (input.candidateSurvival) {
        appendGroupedCandidateStage(input.candidateSurvival, "grouped", visibleGroupedResults);
        appendGroupedCandidateStage(input.candidateSurvival, "disclosed", visibleGroupedResults);
    }
    const noiseMitigationHint = input.buildNoiseMitigationHint(
        visibleGroupedResults.map((result) => result.target.file),
    );
    const generatedArtifactsHint = input.buildGeneratedArtifactsVerificationHint(
        visibleGroupedResults.map((result) => ({
            file: result.target.file,
            span: result.target.span,
        })),
    );
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
        ...(input.debugSummary ? { debugSummary: input.debugSummary } : {}),
        ...(input.debugSearch ? { debugSearch: input.debugSearch } : {}),
        proofDebugHint: input.proofDebugHint,
        noiseMitigationHint,
        generatedArtifactsHint,
        results: visibleGroupedResults,
    });
}
