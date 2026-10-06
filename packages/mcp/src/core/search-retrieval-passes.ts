import type {
    SemanticSearchExecutionResult,
    SemanticSearchRequest,
    SemanticSearchResult,
} from "@satori-code/core";
import { LexicalRetrievalModeUnsupportedError } from "@satori-code/core";
import type { SearchScope } from "./search-constants.js";
import type {
    SearchQueryPlan,
    SearchResultLike,
} from "./search-lexical-scoring.js";
import {
    buildSearchLexicalFallbackTerms,
    type ParsedSearchOperators,
} from "./search-query-planning.js";
import type { SearchExecutionHost } from "./search-execution.js";
import type { DirtyFileSearchResults, SearchQuerySupport } from "./search-query-support.js";

// Pass execution reads only host retrieval ports; fusion state (candidate
// map, survival trace, passesUsed, warning set) stays in search-execution.ts.
type RetrievalPassHost = Pick<SearchExecutionHost,
    | "searchQuerySupport"
    | "semanticSearch"
    | "shouldForceSearchPassFailure"
    | "symbolMetadataSearch"
    | "measureSearchPhase">;

type SemanticPassDiagnostics = {
    searchPassCount: number;
    semanticSearchAttempts: number;
    embeddingCallsByCurrentContract: number;
    denseQueriesByCurrentContract: number;
    sparseQueriesByCurrentContract: number;
};

function isSearchPassFaultInjectionEnabled(): boolean {
    return process.env.NODE_ENV === "test";
}

function getForcedFailedSearchPassId(): "primary" | "expanded" | "both" | undefined {
    if (!isSearchPassFaultInjectionEnabled()) {
        return undefined;
    }

    const raw = typeof process.env.SATORI_TEST_FAIL_SEARCH_PASS === "string"
        ? process.env.SATORI_TEST_FAIL_SEARCH_PASS.trim().toLowerCase()
        : "";
    if (raw === "primary" || raw === "expanded" || raw === "both") {
        return raw;
    }
    return undefined;
}

function shouldForceSearchPassFailure(passId: "primary" | "expanded"): boolean {
    const forced = getForcedFailedSearchPassId();
    if (!forced) {
        return false;
    }
    return forced === "both" || forced === passId;
}

export type SemanticSearchPassDescriptor = {
    id: "primary" | "expanded";
    query: string;
};

export type SemanticSearchPassResults = PromiseSettledResult<
    SemanticSearchResult[] | SemanticSearchExecutionResult
>[];

// Semantic passes: one measured batch per descriptor list. Counter updates
// stay here so the caller's observed diagnostics order is unchanged.
export function runSemanticSearchPasses(input: {
    host: Pick<RetrievalPassHost, "semanticSearch" | "measureSearchPhase" | "shouldForceSearchPassFailure">;
    diagnostics: SemanticPassDiagnostics;
    codebasePath: string;
    retrievalMode: SearchQueryPlan["retrievalMode"];
    scorePolicyKind: SearchQueryPlan["scorePolicyKind"];
    compoundJoin: boolean;
    retrievalFilter?: SemanticSearchRequest["filter"];
    candidateLimit: number;
    passDescriptors: SemanticSearchPassDescriptor[];
}): Promise<SemanticSearchPassResults> {
    const host = input.host;
    const diagnostics = input.diagnostics;
    diagnostics.searchPassCount += input.passDescriptors.length;
    return host.measureSearchPhase(
        "semanticSearch",
        () => Promise.allSettled(input.passDescriptors.map(async (pass) => {
            if ((host.shouldForceSearchPassFailure ?? shouldForceSearchPassFailure)(pass.id)) {
                throw new Error(`FORCED_TEST_SEARCH_PASS_FAILURE:${pass.id}`);
            }
            diagnostics.semanticSearchAttempts += 1;
            if (input.retrievalMode !== "lexical") {
                diagnostics.embeddingCallsByCurrentContract += 1;
                diagnostics.denseQueriesByCurrentContract += 1;
            }
            if (input.retrievalMode !== "dense") {
                diagnostics.sparseQueriesByCurrentContract += 1;
            }
            const scorePolicy = input.scorePolicyKind === "topk_only"
                ? { kind: "topk_only" as const }
                : { kind: "dense_similarity_min" as const, min: 0.3 };
            const lexicalFallbackTerms = input.retrievalMode === "dense"
                ? []
                : buildSearchLexicalFallbackTerms(pass.query, { compoundJoin: input.compoundJoin });
            return host.semanticSearch({
                codebasePath: input.codebasePath,
                query: pass.query,
                topK: input.candidateLimit,
                retrievalMode: input.retrievalMode,
                scorePolicy,
                ...(input.retrievalFilter ? { filter: input.retrievalFilter } : {}),
                ...(lexicalFallbackTerms.length > 0
                    ? { lexicalFallbackTerms }
                    : {}),
            });
        })),
    );
}

// Dirty overlay over uncommitted files.
export function runDirtyOverlayPass(input: {
    host: Pick<RetrievalPassHost, "measureSearchPhase" | "searchQuerySupport">;
    effectiveRoot: string;
    queryPlan: SearchQueryPlan;
    changedFiles: Set<string>;
}): Promise<DirtyFileSearchResults> {
    const host = input.host;
    return host.measureSearchPhase(
        "trackedLexical",
        () => host.searchQuerySupport.buildDirtyFileSearchResults({
            effectiveRoot: input.effectiveRoot,
            queryPlan: input.queryPlan,
            changedFiles: input.changedFiles,
        }),
    );
}

// Tracked lexical scan over indexed files.
export function runTrackedLexicalPass(input: {
    host: Pick<RetrievalPassHost, "measureSearchPhase" | "searchQuerySupport">;
    effectiveRoot: string;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    scope: SearchScope;
    limit: number;
    exactRegistryFallback: boolean;
}): Promise<Awaited<ReturnType<SearchQuerySupport["buildTrackedLexicalSearchResults"]>>> {
    const host = input.host;
    return host.measureSearchPhase(
        "trackedLexical",
        async () => host.searchQuerySupport.buildTrackedLexicalSearchResults({
            effectiveRoot: input.effectiveRoot,
            parsedOperators: input.parsedOperators,
            queryPlan: input.queryPlan,
            scope: input.scope,
            limit: input.limit,
            exactRegistryFallback: input.exactRegistryFallback,
        }),
    );
}

// Live path supplement. Deliberately not wrapped in measureSearchPhase,
// matching the caller it was extracted from.
export function runLivePathPass(input: {
    host: Pick<RetrievalPassHost, "searchQuerySupport">;
    effectiveRoot: string;
    parsedOperators: ParsedSearchOperators;
    queryPlan: SearchQueryPlan;
    changedFiles: Set<string>;
}): Promise<SearchResultLike[]> {
    const host = input.host;
    return host.searchQuerySupport.buildLivePathScopedSearchResults({
        effectiveRoot: input.effectiveRoot,
        parsedOperators: input.parsedOperators,
        queryPlan: input.queryPlan,
        changedFiles: input.changedFiles,
    });
}

export type MustConstraintLaneOutcome =
    | {
        status: "attempted";
        candidatesExamined: number;
        candidateBudget: number;
        budgetExhausted: boolean;
    }
    | {
        status: "unsupported";
        candidatesExamined: 0;
        candidateBudget: number;
        budgetExhausted: false;
    }
    | {
        status: "failed";
        candidatesExamined: number;
        candidateBudget: number;
        budgetExhausted: true;
    };

export type MustConstraintLaneResult = {
    laneResults: SearchResultLike[];
    outcome: MustConstraintLaneOutcome;
};

// Must lane: conjunctive lexical probe over the literal must: values.
// Returns the raw results plus the outcome; the caller fuses, warns, and
// records exactly as before.
export async function runMustConstraintLane(input: {
    host: Pick<RetrievalPassHost, "semanticSearch" | "measureSearchPhase">;
    effectiveRoot: string;
    mustTokens: readonly string[];
    candidateBudget: number;
    retrievalFilter?: SemanticSearchRequest["filter"];
}): Promise<MustConstraintLaneResult> {
    const host = input.host;
    let laneResults: SearchResultLike[] = [];
    let laneFailed = false;
    let conjunctiveUnavailable = false;
    try {
        const laneResponse = await host.measureSearchPhase(
            "semanticSearch",
            () => host.semanticSearch({
                codebasePath: input.effectiveRoot,
                query: input.mustTokens.join(" "),
                topK: input.candidateBudget,
                retrievalMode: "lexical",
                // Every must: value is mandatory: the backend must honor
                // all-terms matching or reject the request explicitly.
                lexicalMatchMode: "all_terms",
                scorePolicy: { kind: "topk_only" },
                ...(input.retrievalFilter ? { filter: input.retrievalFilter } : {}),
            }),
        );
        laneResults = Array.isArray(laneResponse)
            ? laneResponse
            : laneResponse.results;
    } catch (error) {
        if (error instanceof LexicalRetrievalModeUnsupportedError) {
            // The backend cannot guarantee conjunctive semantics; do not
            // silently run provider-defined sparse matching and never
            // claim the must: lane examined the candidate pool.
            conjunctiveUnavailable = true;
        } else {
            // A lane failure is bounded: keep the primary results and
            // report that the budget could not be fully examined.
            laneFailed = true;
        }
    }
    const outcome: MustConstraintLaneOutcome = conjunctiveUnavailable
        ? {
            // The backend cannot guarantee conjunctive semantics, so
            // the dedicated lane was never attempted and no budget was
            // examined. Only the conjunctive-unavailable warning may
            // accompany this state.
            status: "unsupported",
            candidatesExamined: 0,
            candidateBudget: input.candidateBudget,
            budgetExhausted: false,
        }
        : laneFailed
            ? {
                status: "failed",
                candidatesExamined: laneResults.length,
                candidateBudget: input.candidateBudget,
                budgetExhausted: true,
            }
            : {
                status: "attempted",
                candidatesExamined: laneResults.length,
                candidateBudget: input.candidateBudget,
                budgetExhausted: laneResults.length >= input.candidateBudget,
            };
    return { laneResults, outcome };
}

export type SymbolMetadataPassResult = {
    metadataResults: SearchResultLike[];
    altMetadataResults?: SearchResultLike[];
};

// Symbol metadata windows: primary plus the caller-terms window. Abort
// checks stay with execution, in the same positions as before.
export async function runSymbolMetadataPasses(input: {
    host: Pick<RetrievalPassHost, "measureSearchPhase" | "symbolMetadataSearch">;
    signal?: AbortSignal;
    altQuery?: string;
}): Promise<SymbolMetadataPassResult> {
    const host = input.host;
    input.signal?.throwIfAborted();
    const metadataResults = await host.measureSearchPhase("trackedLexical", () => (
        host.symbolMetadataSearch!()
    ));
    input.signal?.throwIfAborted();
    if (input.altQuery === undefined) {
        return { metadataResults };
    }
    const altQuery = input.altQuery;
    const altMetadataResults = await host.measureSearchPhase("trackedLexical", () => (
        host.symbolMetadataSearch!(altQuery)
    ));
    input.signal?.throwIfAborted();
    return { metadataResults, altMetadataResults };
}
