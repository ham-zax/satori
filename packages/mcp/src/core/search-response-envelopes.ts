import type { SearchGroupBy, SearchScope } from "./search-constants.js";
import type { FreshnessDecision } from "./sync.js";
import type {
    SearchChunkResult,
    SearchDebugHint,
    SearchFreshnessDebugHint,
    SearchFreshnessSummary,
    SearchGroupResult,
    SearchDisclosureSummary,
    SearchDebugMode,
    SearchRankingDebugHint,
    SearchPassFailureDebugHint,
    SearchGroupedDebugV2,
    SearchGroupedResultV2,
    SearchGroupedResponseEnvelope,
    SearchResponseEnvelope,
} from "./search-types.js";
import { SEARCH_RESPONSE_FORMAT_VERSION } from "./search-types.js";
import type { SearchMustConstraintHint, SearchMustCoverage } from "./search-types.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import { resolveOmittedBeyondLimitGroupCount } from "./search-disclosure.js";
import {
    buildSearchWarningDetails,
    buildTopRecommendedRawSearchAction,
    buildTopRecommendedSearchAction,
    roundSearchScore,
} from "./search-response-helpers.js";

export type SearchResponseCommonInput = {
    codebaseRoot: string;
    absolutePath: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    limit: number;
    debugMode: SearchDebugMode;
    freshnessDecision: FreshnessDecision;
    freshnessSummary: SearchFreshnessSummary;
    warnings: string[];
    debugSummary?: NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["debugSummary"]>;
    debugSearch?: SearchDebugHint | SearchRankingDebugHint | SearchFreshnessDebugHint | SearchPassFailureDebugHint;
    proofDebugHint?: CompletionProbeDebugHint;
    noiseMitigationHint?: unknown;
    generatedArtifactsHint?: unknown;
    mustConstraintHint?: SearchMustConstraintHint;
    mustCoverageHint?: SearchMustCoverage;
};

function buildSearchResponseHints(input: SearchResponseCommonInput): { hints?: Record<string, unknown> } {
    const responseHints: Record<string, unknown> = {};

    if (input.noiseMitigationHint) {
        responseHints.noiseMitigation = input.noiseMitigationHint;
    }
    if (input.generatedArtifactsHint) {
        responseHints.verification = {
            generatedArtifacts: input.generatedArtifactsHint,
        };
    }
    if (input.mustConstraintHint) {
        responseHints.mustConstraint = input.mustConstraintHint;
    }
    if (input.mustCoverageHint) {
        responseHints.mustCoverage = input.mustCoverageHint;
    }
    if (input.debugSummary) {
        responseHints.debugSummary = input.debugSummary;
    }
    if (input.debugSearch) {
        responseHints.debugSearch = input.debugSearch;
    }
    if (input.proofDebugHint) {
        responseHints.debugProofCheck = input.proofDebugHint;
    }

    return Object.keys(responseHints).length > 0
        ? { hints: { version: 1 as const, ...responseHints } }
        : {};
}

function buildWarnings(warnings: string[]): { warnings?: SearchResponseEnvelope["warnings"] } {
    if (warnings.length === 0) {
        return {};
    }
    return { warnings: buildSearchWarningDetails(warnings) };
}

function projectGroupedDebugV2(debug: SearchGroupedDebugV2): SearchGroupedDebugV2 {
    return {
        representativeChunkCount: debug.representativeChunkCount,
        pathCategory: debug.pathCategory,
        pathMultiplier: debug.pathMultiplier,
        topChunkScore: debug.topChunkScore,
        lexicalScore: debug.lexicalScore,
        ...(debug.changedFilesMultiplier !== undefined
            ? { changedFilesMultiplier: debug.changedFilesMultiplier }
            : {}),
        ...(debug.agentFitMultiplier !== undefined
            ? { agentFitMultiplier: debug.agentFitMultiplier }
            : {}),
        ...(debug.agentFitReason !== undefined
            ? { agentFitReason: debug.agentFitReason }
            : {}),
        ...(debug.entrypointOwnerScoreBoost !== undefined
            ? { entrypointOwnerScoreBoost: debug.entrypointOwnerScoreBoost }
            : {}),
        ...(debug.entrypointOwnerScoreReason !== undefined
            ? { entrypointOwnerScoreReason: debug.entrypointOwnerScoreReason }
            : {}),
        ...(debug.matchesMust !== undefined
            ? { matchesMust: debug.matchesMust }
            : {}),
        exactLexicalMatch: debug.exactLexicalMatch,
        ...(debug.symbolAggregation ? {
            symbolAggregation: {
                ownerSource: debug.symbolAggregation.ownerSource,
                evidenceChunkCount: debug.symbolAggregation.evidenceChunkCount,
            },
        } : {}),
        ...(debug.freshness ? {
            freshness: {
                newestChunkIndexedAt: debug.freshness.newestChunkIndexedAt,
                ageBucket: debug.freshness.ageBucket,
            },
        } : {}),
        ...(debug.graphEvidence ? {
            graphEvidence: {
                ...(debug.graphEvidence.validatedAt !== undefined
                    ? { validatedAt: debug.graphEvidence.validatedAt }
                    : {}),
                ...(debug.graphEvidence.sidecarBuiltAt !== undefined
                    ? { sidecarBuiltAt: debug.graphEvidence.sidecarBuiltAt }
                    : {}),
            },
        } : {}),
        ...(debug.provenance ? {
            provenance: {
                retrievalPasses: [...debug.provenance.retrievalPasses],
                backendScoreKinds: [...debug.provenance.backendScoreKinds],
                semanticCandidate: debug.provenance.semanticCandidate,
                lexicalCandidate: debug.provenance.lexicalCandidate,
                rerankAdjusted: debug.provenance.rerankAdjusted,
                exactMatchPinned: debug.provenance.exactMatchPinned,
                ownerRepairApplied: debug.provenance.ownerRepairApplied,
            },
        } : {}),
    };
}

export function projectGroupedResultV2(result: SearchGroupResult): SearchGroupedResultV2 {
    const navigation: SearchGroupedResultV2["navigation"] = result.navigation.graph === "ready"
        ? {
            graph: "ready",
            inbound: "verify",
            ...(result.navigation.callerSearchTerm
                ? { callerSearchTerm: result.navigation.callerSearchTerm }
                : {}),
        }
        : { graph: result.navigation.graph };

    return {
        target: {
            file: result.target.file,
            span: {
                startLine: result.target.span.startLine,
                endLine: result.target.span.endLine,
            },
            ...(result.target.symbolId
                ? { symbolId: result.target.symbolId }
                : {}),
        },
        displayLabel: result.displayLabel,
        language: result.language,
        ...(result.symbolKind !== undefined
            ? { symbolKind: result.symbolKind }
            : {}),
        score: roundSearchScore(result.score),
        quality: {
            owner: result.quality.owner,
            semantic: result.quality.semantic,
        },
        ...(result.evidenceChunks !== undefined
            ? { evidenceChunks: result.evidenceChunks }
            : {}),
        preview: result.preview,
        ...(result.evidenceSpan ? {
            evidenceSpan: {
                startLine: result.evidenceSpan.startLine,
                endLine: result.evidenceSpan.endLine,
            },
        } : {}),
        navigation,
        ...(result.debug ? { debug: projectGroupedDebugV2(result.debug) } : {}),
    };
}

export function buildGroupedSearchEnvelope(input: SearchResponseCommonInput & {
    results: SearchGroupResult[];
    resultCounts?: SearchGroupedResponseEnvelope["resultCounts"];
    disclosure?: SearchDisclosureSummary;
}): SearchResponseEnvelope {
    const recommendedNextAction = buildTopRecommendedSearchAction(input.codebaseRoot, input.results);
    const results = input.results.map(projectGroupedResultV2);
    const exposeFreshnessEvidence = input.debugMode === "freshness"
        || input.debugMode === "full";
    const omittedBeyondLimitGroupCount = input.resultCounts
        ? resolveOmittedBeyondLimitGroupCount(input.resultCounts)
        : 0;
    return {
        formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
        status: "ok",
        path: input.absolutePath,
        codebaseRoot: input.codebaseRoot,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        limit: input.limit,
        resultMode: "grouped",
        ...(input.freshnessDecision?.mode === "served_previous_generation" ? {
            freshness: {
                state: "sync_in_progress" as const,
                ...(input.freshnessDecision.servedCollection ? { servedCollection: input.freshnessDecision.servedCollection } : {}),
                ...(input.freshnessDecision.servedRunId ? { servedRunId: input.freshnessDecision.servedRunId } : {}),
                ...(input.freshnessDecision.servedGenerationId ? { servedGenerationId: input.freshnessDecision.servedGenerationId } : {}),
                ...(input.freshnessDecision.servedGeneration ? { servedGeneration: input.freshnessDecision.servedGeneration } : {}),
                ...(input.freshnessDecision.pendingOperation ? { pendingOperation: input.freshnessDecision.pendingOperation } : {}),
            },
        } : {}),
        ...(exposeFreshnessEvidence ? {
            freshnessDecision: input.freshnessDecision,
            freshnessSummary: input.freshnessSummary,
        } : {}),
        ...(input.resultCounts ? { resultCounts: input.resultCounts } : {}),
        ...(omittedBeyondLimitGroupCount > 0 ? { omittedBeyondLimitGroupCount } : {}),
        ...(input.disclosure ? { disclosure: input.disclosure } : {}),
        ...buildWarnings(input.warnings),
        ...(recommendedNextAction ? { recommendedNextAction } : {}),
        ...buildSearchResponseHints(input),
        results,
    };
}

export function buildRawSearchEnvelope(input: SearchResponseCommonInput & {
    results: SearchChunkResult[];
}): SearchResponseEnvelope {
    const exposeFreshnessEvidence = input.debugMode === "freshness"
        || input.debugMode === "full";
    return {
        formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
        status: "ok",
        path: input.absolutePath,
        codebaseRoot: input.codebaseRoot,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        limit: input.limit,
        resultMode: "raw",
        ...(input.freshnessDecision?.mode === "served_previous_generation" ? {
            freshness: {
                state: "sync_in_progress" as const,
                ...(input.freshnessDecision.servedCollection ? { servedCollection: input.freshnessDecision.servedCollection } : {}),
                ...(input.freshnessDecision.servedRunId ? { servedRunId: input.freshnessDecision.servedRunId } : {}),
                ...(input.freshnessDecision.servedGenerationId ? { servedGenerationId: input.freshnessDecision.servedGenerationId } : {}),
                ...(input.freshnessDecision.servedGeneration ? { servedGeneration: input.freshnessDecision.servedGeneration } : {}),
                ...(input.freshnessDecision.pendingOperation ? { pendingOperation: input.freshnessDecision.pendingOperation } : {}),
            },
        } : {}),
        ...(exposeFreshnessEvidence ? {
            freshnessDecision: input.freshnessDecision,
            freshnessSummary: input.freshnessSummary,
        } : {}),
        ...buildWarnings(input.warnings),
        recommendedNextAction: buildTopRecommendedRawSearchAction(input.codebaseRoot, input.results),
        ...buildSearchResponseHints(input),
        results: input.results,
    };
}
