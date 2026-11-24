import type { SearchActionIntent } from "./search-response-helpers.js";
import type { SymbolRecord } from "@satori-code/core";
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
    projectGroupedResultV2,
} from "./search-response-envelopes.js";
import {
    buildSearchGroupRecommendedAction,
    buildSearchSpanWarningCodes,
} from "./search-response-helpers.js";
import type {
    SearchDebugMode,
    SearchFreshnessSummary,
    SearchGroupResult,
    SearchGroupedResponseEnvelope,
    SearchHydratedExactSource,
    SearchResponseHints,
    SearchResponseEnvelope,
    SearchSpan,
} from "./search-types.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import type { FreshnessDecision } from "./sync.js";
import { WARNING_CODES } from "./warnings.js";
import { appendGroupedCandidateStage } from "./search-candidate-survival.js";
import type { SearchCandidateSurvivalDebug } from "./search-types.js";
import {
    projectGroupedDisclosure,
    resolveSearchGroupedResultCounts,
} from "./search-disclosure.js";
import {
    SEARCH_RESULT_SET_DIGEST_PLACEHOLDER,
    SEARCH_RESULT_SET_HANDLE_PLACEHOLDER,
} from "./search-constants.js";
import type { FinalizedSearchResults } from "./search-result-finalization.js";

export const EXACT_HYDRATION_MAX_SOURCE_BYTES = 12_288;
export const EXACT_HYDRATION_MAX_LINES = 200;

export function attachHydratedExactSource(
    envelope: SearchGroupedResponseEnvelope,
    hydratedExactSource: SearchHydratedExactSource | undefined,
    maxResponseBytes: number,
): SearchGroupedResponseEnvelope {
    if (
        !hydratedExactSource
        || envelope.status !== "ok"
        || envelope.continuation
        || envelope.results.length !== 1
        || envelope.results[0]?.target.symbolId !== hydratedExactSource.symbolId
        || envelope.results[0]?.target.file !== hydratedExactSource.file
    ) return envelope;
    const candidate = { ...envelope, hydratedExactSource };
    return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxResponseBytes ? candidate : envelope;
}

export function buildHydratedExactSource(input: {
    symbol: SymbolRecord;
    sourceContent: string;
    maxSourceBytes?: number;
    maxLines?: number;
}): SearchHydratedExactSource | undefined {
    const symbolId = input.symbol.symbolInstanceId?.trim();
    if (!symbolId || input.symbol.kind === "file") {
        return undefined;
    }
    const { startLine, endLine } = input.symbol.span;
    if (
        !Number.isSafeInteger(startLine)
        || !Number.isSafeInteger(endLine)
        || startLine < 1
        || endLine < startLine
    ) {
        return undefined;
    }
    if (input.sourceContent.length === 0) {
        return undefined;
    }
    const maxSourceBytes = input.maxSourceBytes ?? EXACT_HYDRATION_MAX_SOURCE_BYTES;
    const maxLines = input.maxLines ?? EXACT_HYDRATION_MAX_LINES;
    const lines = input.sourceContent.split(/\r\n?|\n/);
    if (lines.length !== endLine - startLine + 1) {
        return undefined;
    }

    const totalBytes = Buffer.byteLength(input.sourceContent, "utf8");
    if (lines.length <= maxLines && totalBytes <= maxSourceBytes) {
        return {
            file: input.symbol.file,
            symbolId,
            span: { startLine, endLine },
            returnedSpan: { startLine, endLine },
            completeSymbolReturned: true,
            truncated: false,
            content: input.sourceContent,
            sourceAuthority: "publication_hash_matched",
        };
    }

    const candidateMaxLines = Math.min(lines.length, maxLines);
    let includedLines = 0;
    let usedBytes = 0;
    for (let index = 0; index < candidateMaxLines; index += 1) {
        const lineBytes = Buffer.byteLength(lines[index], "utf8") + (index > 0 ? 1 : 0);
        if (usedBytes + lineBytes > maxSourceBytes) {
            break;
        }
        usedBytes += lineBytes;
        includedLines = index + 1;
    }
    if (includedLines === 0) {
        return undefined;
    }

    return {
        file: input.symbol.file,
        symbolId,
        span: { startLine, endLine },
        returnedSpan: {
            startLine,
            endLine: startLine + includedLines - 1,
        },
        completeSymbolReturned: false,
        truncated: true,
        content: lines.slice(0, includedLines).join("\n"),
        sourceAuthority: "publication_hash_matched",
    };
}

export type BuildExactRegistryHitEnvelopeInput = {
    codebaseRoot: string;
    absolutePath: string;
    query: string;
    actionIntent?: SearchActionIntent;
    scope: SearchResponseEnvelope["scope"];
    groupBy: SearchResponseEnvelope["groupBy"];
    limit: number;
    disclosureLimit: number;
    includeResultIndex: boolean;
    maxResponseBytes: number;
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
): FinalizedSearchResults | undefined {
    const repairedMatches = input.matches.map((match) => ({
        ...match,
        repair: repairSourceBackedPythonSpan({
            codebaseRoot: input.codebaseRoot,
            symbol: match.symbol,
            // No authorized source lines are available in search result
            // rendering: the shared repair fails closed without any
            // pathname read (attempted=false, validated=false).
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
    }
    const frozenCounts = resolveSearchGroupedResultCounts({
        requestedTotal: input.limit,
        availableGroupCount: visibleGroupedResults.length,
        returnedGroupCount: 0,
    });
    const eligibleResults = visibleGroupedResults.slice(0, frozenCounts.effectiveFrozenTotal);
    const buildCandidateEnvelope = (
        results: readonly SearchGroupResult[],
        disclosure?: SearchGroupedResponseEnvelope["disclosure"],
    ): SearchGroupedResponseEnvelope => {
        const resultCounts = resolveSearchGroupedResultCounts({
            requestedTotal: input.limit,
            availableGroupCount: visibleGroupedResults.length,
            returnedGroupCount: results.length,
        });
        const projectedDebugSearch = input.debugSearch && input.candidateSurvival
            ? (() => {
                const debugSearch = structuredClone(input.debugSearch);
                const candidateSurvival = structuredClone(input.candidateSurvival);
                candidateSurvival.stages = candidateSurvival.stages.filter(
                    (stage) => stage.stage !== "disclosed",
                );
                appendGroupedCandidateStage(candidateSurvival, "disclosed", results);
                return { ...debugSearch, candidateSurvival };
            })()
            : input.debugSearch;
        const noiseMitigationHint = input.buildNoiseMitigationHint(
            results.map((result) => result.target.file),
        );
        const generatedArtifactsHint = input.buildGeneratedArtifactsVerificationHint(
            results.map((result) => ({
                file: result.target.file,
                span: result.target.span,
            })),
        );
        const envelope = buildGroupedSearchEnvelope({
            actionIntent: input.actionIntent,
            codebaseRoot: input.codebaseRoot,
            absolutePath: input.absolutePath,
            query: input.query,
            scope: input.scope,
            groupBy: input.groupBy,
            limit: input.limit,
            debugMode: input.debugMode,
            freshnessDecision: input.freshnessDecision,
            freshnessSummary: input.freshnessSummary,
            warnings: resultCounts.remainingGroupCount > 0
                ? [
                    ...finalizedSearchWarnings,
                    WARNING_CODES.SEARCH_RESULT_SET_NOT_CACHE_ADMISSIBLE,
                ]
                : finalizedSearchWarnings,
            ...(input.debugSummary ? { debugSummary: input.debugSummary } : {}),
            ...(projectedDebugSearch ? { debugSearch: projectedDebugSearch } : {}),
            proofDebugHint: input.proofDebugHint,
            noiseMitigationHint,
            generatedArtifactsHint,
            resultCounts,
            ...(disclosure ? { disclosure } : {}),
            results: [...results],
        }) as SearchGroupedResponseEnvelope;
        return resultCounts.remainingGroupCount > 0
            ? {
                ...envelope,
                rankedSetDigest: SEARCH_RESULT_SET_DIGEST_PLACEHOLDER,
                continuation: {
                    handle: SEARCH_RESULT_SET_HANDLE_PLACEHOLDER,
                    nextOffset: results.length,
                    remainingGroupCount: resultCounts.remainingGroupCount,
                },
            }
            : envelope;
    };
    const projection = projectGroupedDisclosure({
        orderedResults: visibleGroupedResults,
        callerLimit: frozenCounts.effectiveFrozenTotal,
        disclosureLimit: input.disclosureLimit,
        maxResponseBytes: input.maxResponseBytes,
        includeSummary: input.disclosureLimit < frozenCounts.effectiveFrozenTotal
            || visibleGroupedResults.length > frozenCounts.effectiveFrozenTotal,
        buildEnvelope: (results, disclosure) => buildCandidateEnvelope(results, disclosure),
    });
    if (projection.status === "page_too_large") {
        const authorityEnvelope = { ...projection.envelope };
        delete authorityEnvelope.continuation;
        return {
            kind: "page_too_large",
            envelope: {
                ...authorityEnvelope,
                status: "not_ready",
                code: "SEARCH_RESULT_SET_PAGE_TOO_LARGE",
                message: "The first search result cannot fit within the response byte budget. Run a narrower search.",
                results: [],
            },
        };
    }
    const finalEnvelope = projection.envelope;
    const resultSet = finalEnvelope.continuation || input.includeResultIndex
        ? {
            orderedResults: eligibleResults.map(projectGroupedResultV2),
            recommendedActions: eligibleResults.map((result) => (
                buildSearchGroupRecommendedAction(input.codebaseRoot, result, undefined, input.actionIntent) ?? null
            )),
            initialReturnedCount: projection.results.length,
        }
        : undefined;
    return {
        kind: "ok",
        envelope: finalEnvelope,
        ...(resultSet ? { resultSet } : {}),
    };
}
