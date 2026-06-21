import type { SearchGroupBy, SearchScope } from "./search-constants.js";
import type { FreshnessDecision } from "./sync.js";
import type {
    SearchChunkResult,
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchGroupResult,
    SearchResponseEnvelope,
} from "./search-types.js";
import type { CompletionProbeDebugHint } from "./tracked-root-readiness.js";
import {
    buildSearchDebugSummary,
    buildSearchWarningDetails,
    buildTopRecommendedRawSearchAction,
    buildTopRecommendedSearchAction,
} from "./search-response-helpers.js";

const SEARCH_NAVIGATION_NEXT_STEP = "Use recommendedNextAction when present. Call call_graph only when nextActions.callGraph is present and callGraphHint.supported=true.";

type SearchResponseCommonInput = {
    codebaseRoot: string;
    absolutePath: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    limit: number;
    freshnessDecision: FreshnessDecision;
    freshnessSummary: SearchFreshnessSummary;
    warnings: string[];
    debugHint?: SearchDebugHint;
    proofDebugHint?: CompletionProbeDebugHint;
    noiseMitigationHint?: unknown;
    generatedArtifactsHint?: unknown;
};

function buildSearchResponseHints(input: SearchResponseCommonInput): Record<string, unknown> {
    const responseHints: Record<string, unknown> = {
        version: 1 as const,
        navigation: { nextStep: SEARCH_NAVIGATION_NEXT_STEP },
    };

    if (input.noiseMitigationHint) {
        responseHints.noiseMitigation = input.noiseMitigationHint;
    }
    if (input.generatedArtifactsHint) {
        responseHints.verification = {
            generatedArtifacts: input.generatedArtifactsHint,
        };
    }
    if (input.debugHint) {
        responseHints.debugSearch = input.debugHint;
        responseHints.debugSummary = buildSearchDebugSummary(input.debugHint, input.freshnessSummary);
    }
    if (input.proofDebugHint) {
        responseHints.debugProofCheck = input.proofDebugHint;
    }

    return responseHints;
}

function buildWarnings(warnings: string[]): { warnings?: SearchResponseEnvelope["warnings"] } {
    if (warnings.length === 0) {
        return {};
    }
    return { warnings: buildSearchWarningDetails(warnings) };
}

export function buildGroupedSearchEnvelope(input: SearchResponseCommonInput & {
    results: Array<SearchGroupResult & { __exactLexicalMatch?: boolean }>;
}): SearchResponseEnvelope {
    return {
        status: "ok",
        path: input.absolutePath,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        limit: input.limit,
        resultMode: "grouped",
        freshnessDecision: input.freshnessDecision,
        freshnessSummary: input.freshnessSummary,
        ...buildWarnings(input.warnings),
        recommendedNextAction: buildTopRecommendedSearchAction(input.results),
        hints: buildSearchResponseHints(input),
        results: input.results.map(({ __exactLexicalMatch: _exactLexicalMatch, ...result }) => result),
    };
}

export function buildRawSearchEnvelope(input: SearchResponseCommonInput & {
    results: SearchChunkResult[];
}): SearchResponseEnvelope {
    return {
        status: "ok",
        path: input.absolutePath,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        limit: input.limit,
        resultMode: "raw",
        freshnessDecision: input.freshnessDecision,
        freshnessSummary: input.freshnessSummary,
        ...buildWarnings(input.warnings),
        recommendedNextAction: buildTopRecommendedRawSearchAction(input.codebaseRoot, input.results),
        hints: buildSearchResponseHints(input),
        results: input.results,
    };
}
