import { z } from "zod";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import {
    McpTool,
    MissingProviderConfigIssue,
    ToolContext,
    ToolResponse,
    absoluteFilesystemPathSchema,
    formatZodError,
} from "./types.js";
import { emitSearchTelemetry } from "../telemetry/search.js";
import {
    classifyVectorBackendError,
    formatSearchProviderConfigError,
    formatSearchVectorBackendError,
    isMissingProviderConfigIssue
} from "./setup-errors.js";
import {
    buildSearchQueryPlan,
    parseSearchOperators,
} from "../core/search-query-planning.js";
import {
    SEARCH_ALT_TERMS_MAX,
    SEARCH_ALT_TERMS_STRING_MAX_CHARS,
    SEARCH_ALT_TERMS_TERM_MAX_CHARS,
    SEARCH_MAX_DIAGNOSTIC_CANDIDATES,
} from "../core/search-constants.js";
import {
    WorkspaceAuthorizationError,
    type AuthorizedWorkspacePath,
} from "../core/session-workspace-policy.js";

interface SearchDiagnostics {
    resultsBeforeFilter: number;
    resultsAfterFilter: number;
    excludedByIgnore: number;
    resultsReturned: number;
    freshnessMode?: string;
    searchPassCount?: number;
    searchPassSuccessCount?: number;
    searchPassFailureCount?: number;
    rerankerAttempted?: boolean;
    rerankerUsed?: boolean;
    routeKind?: string;
    retrievalMode?: string;
    semanticSearchAttempts?: number;
    embeddingCallsByCurrentContract?: number;
    denseQueriesByCurrentContract?: number;
    sparseQueriesByCurrentContract?: number;
    rerankerCalls?: number;
    rerankerCandidates?: number;
    rerankerInputBytes?: number;
    candidatesWithSemanticEvidence?: number;
    candidatesWithLexicalEvidence?: number;
    candidatesWithCurrentSourceEvidence?: number;
    semanticExpansionAttempted?: boolean;
    semanticExpansionReason?: string;
}

type PublicSearchDebugMode = "none" | "summary" | "ranking" | "freshness" | "full";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function getProfile(ctx: ToolContext): string {
    const locality = ctx.capabilities.getEmbeddingLocality();
    const profile = ctx.capabilities.getPerformanceProfile();
    return `${locality}_${profile}`;
}

function getErrorMessage(response: ToolResponse): string {
    const text = response.content?.[0]?.text;
    if (typeof text === "string" && text.trim().length > 0) {
        return text;
    }
    return "Unknown error";
}

function getResponseBytes(response: ToolResponse): number {
    const text = response.content
        ?.map((part) => typeof part.text === "string" ? part.text : "")
        .join("") ?? "";
    return Buffer.byteLength(text, "utf8");
}

function safeNumber(value: unknown, fallback = 0): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return value;
}

function getReturnedResultCount(response: ToolResponse): number | null {
    const text = response.content?.[0]?.text;
    if (typeof text !== "string") return null;

    try {
        const parsed = JSON.parse(text);
        if (!isRecord(parsed) || !Array.isArray(parsed.results)) return null;
        return parsed.results.length;
    } catch {
        return null;
    }
}

function extractDiagnostics(response: ToolResponse): SearchDiagnostics {
    const fallback: SearchDiagnostics = {
        resultsBeforeFilter: 0,
        resultsAfterFilter: 0,
        excludedByIgnore: 0,
        resultsReturned: 0,
    };

    const responseMeta = isRecord(response.meta) ? response.meta : null;
    const metaDiagnostics = responseMeta && isRecord(responseMeta.searchDiagnostics)
        ? responseMeta.searchDiagnostics
        : null;
    if (metaDiagnostics) {
        const afterFilter = safeNumber(metaDiagnostics.resultsAfterFilter, 0);
        return {
            resultsBeforeFilter: safeNumber(metaDiagnostics.resultsBeforeFilter, afterFilter),
            resultsAfterFilter: afterFilter,
            excludedByIgnore: safeNumber(metaDiagnostics.excludedByIgnore, 0),
            resultsReturned: getReturnedResultCount(response) ?? afterFilter,
            freshnessMode: typeof metaDiagnostics.freshnessMode === "string" ? metaDiagnostics.freshnessMode : undefined,
            searchPassCount: safeNumber(metaDiagnostics.searchPassCount, 0),
            searchPassSuccessCount: safeNumber(metaDiagnostics.searchPassSuccessCount, 0),
            searchPassFailureCount: safeNumber(metaDiagnostics.searchPassFailureCount, 0),
            rerankerAttempted: metaDiagnostics.rerankerAttempted === true,
            rerankerUsed: metaDiagnostics.rerankerUsed === true,
            routeKind: typeof metaDiagnostics.routeKind === "string" ? metaDiagnostics.routeKind : undefined,
            retrievalMode: typeof metaDiagnostics.retrievalMode === "string" ? metaDiagnostics.retrievalMode : undefined,
            semanticSearchAttempts: safeNumber(metaDiagnostics.semanticSearchAttempts, 0),
            embeddingCallsByCurrentContract: safeNumber(metaDiagnostics.embeddingCallsByCurrentContract, 0),
            denseQueriesByCurrentContract: safeNumber(metaDiagnostics.denseQueriesByCurrentContract, 0),
            sparseQueriesByCurrentContract: safeNumber(metaDiagnostics.sparseQueriesByCurrentContract, 0),
            rerankerCalls: safeNumber(metaDiagnostics.rerankerCalls, 0),
            rerankerCandidates: safeNumber(metaDiagnostics.rerankerCandidates, 0),
            rerankerInputBytes: safeNumber(metaDiagnostics.rerankerInputBytes, 0),
            candidatesWithSemanticEvidence: safeNumber(metaDiagnostics.candidatesWithSemanticEvidence, 0),
            candidatesWithLexicalEvidence: safeNumber(metaDiagnostics.candidatesWithLexicalEvidence, 0),
            candidatesWithCurrentSourceEvidence: safeNumber(metaDiagnostics.candidatesWithCurrentSourceEvidence, 0),
            semanticExpansionAttempted: metaDiagnostics.semanticExpansionAttempted === true,
            semanticExpansionReason: typeof metaDiagnostics.semanticExpansionReason === "string"
                ? metaDiagnostics.semanticExpansionReason
                : undefined,
        };
    }

    const text = response.content?.[0]?.text;
    if (typeof text !== "string") {
        return fallback;
    }

    try {
        const parsed = JSON.parse(text);
        const parsedRecord = isRecord(parsed) ? parsed : null;
        const results = Array.isArray(parsedRecord?.results) ? parsedRecord.results.length : 0;
        const freshnessDecision = isRecord(parsedRecord?.freshnessDecision) ? parsedRecord.freshnessDecision : null;
        const hints = isRecord(parsedRecord?.hints) ? parsedRecord.hints : null;
        const debugSearch = isRecord(hints?.debugSearch) ? hints.debugSearch : null;
        const rerank = isRecord(debugSearch?.rerank) ? debugSearch.rerank : null;
        const route = isRecord(debugSearch?.route) ? debugSearch.route : null;
        const retrieval = isRecord(debugSearch?.retrieval) ? debugSearch.retrieval : null;
        const providerWork = isRecord(debugSearch?.providerWork) ? debugSearch.providerWork : null;
        const semanticExpansion = isRecord(debugSearch?.semanticExpansion) ? debugSearch.semanticExpansion : null;
        return {
            resultsBeforeFilter: safeNumber(parsedRecord?.resultsBeforeFilter, results),
            resultsAfterFilter: safeNumber(parsedRecord?.resultsAfterFilter, results),
            excludedByIgnore: safeNumber(parsedRecord?.excludedByIgnore, 0),
            resultsReturned: results,
            freshnessMode: typeof freshnessDecision?.mode === "string" ? freshnessDecision.mode : undefined,
            searchPassCount: safeNumber(parsedRecord?.searchPassCount, 0),
            searchPassSuccessCount: safeNumber(parsedRecord?.searchPassSuccessCount, 0),
            searchPassFailureCount: safeNumber(parsedRecord?.searchPassFailureCount, 0),
            rerankerAttempted: rerank?.attempted === true,
            rerankerUsed: rerank?.applied === true,
            routeKind: typeof route?.kind === "string" ? route.kind : undefined,
            retrievalMode: typeof retrieval?.mode === "string" ? retrieval.mode : undefined,
            semanticSearchAttempts: safeNumber(providerWork?.semanticSearchAttempts, 0),
            embeddingCallsByCurrentContract: safeNumber(providerWork?.embeddingCallsByCurrentContract, 0),
            denseQueriesByCurrentContract: safeNumber(providerWork?.denseQueriesByCurrentContract, 0),
            sparseQueriesByCurrentContract: safeNumber(providerWork?.sparseQueriesByCurrentContract, 0),
            rerankerCalls: safeNumber(providerWork?.rerankerCalls, 0),
            rerankerCandidates: safeNumber(providerWork?.rerankerCandidates, 0),
            rerankerInputBytes: safeNumber(providerWork?.rerankerInputBytes, 0),
            candidatesWithSemanticEvidence: safeNumber(providerWork?.candidatesWithSemanticEvidence, 0),
            candidatesWithLexicalEvidence: safeNumber(providerWork?.candidatesWithLexicalEvidence, 0),
            candidatesWithCurrentSourceEvidence: safeNumber(providerWork?.candidatesWithCurrentSourceEvidence, 0),
            semanticExpansionAttempted: semanticExpansion?.attempted === true,
            semanticExpansionReason: typeof semanticExpansion?.reason === "string"
                ? semanticExpansion.reason
                : undefined,
        };
    } catch {
        return fallback;
    }
}

function emitSearchBackendErrorTelemetry(args: {
    profile: string;
    queryLength: number;
    limit: number;
    startedAt: number;
    code: string;
    routeKind?: string;
    retrievalMode?: string;
    responseBytes?: number;
}): void {
    emitSearchTelemetry({
        event: "search_executed",
        tool_name: "search_codebase",
        profile: args.profile,
        query_length: args.queryLength,
        limit_requested: args.limit,
        results_before_filter: 0,
        results_after_filter: 0,
        results_returned: 0,
        excluded_by_ignore: 0,
        reranker_used: false,
        reranker_attempted: false,
        latency_ms: Date.now() - args.startedAt,
        route: args.routeKind,
        retrieval_mode: args.retrievalMode,
        ...(args.responseBytes !== undefined ? { response_bytes: args.responseBytes } : {}),
        error: args.code,
    });
}

/**
 * Structured workspace denial per the security hardening contract. The
 * `reason` is the snake_case form of the policy's authorization code, so the
 * common rejection (ROOT_NOT_AUTHORIZED) renders exactly as documented while
 * BROAD_ROOT_NOT_ALLOWED / INVALID_WORKSPACE_ROOT / WORKSPACE_POLICY_NOT_BOUND
 * stay distinguishable to callers. The envelope never carries continuation
 * handles or frozen result sets from an unauthorized request.
 */
function formatWorkspaceAuthorizationError(
    toolName: string,
    path: string,
    error: unknown,
): ToolResponse {
    const code = error instanceof WorkspaceAuthorizationError
        ? error.code
        : "WORKSPACE_POLICY_NOT_BOUND";
    const message = error instanceof Error
        ? error.message
        : `${toolName}: ${String(error)}`;
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: "error",
                reason: code.toLowerCase(),
                code,
                path,
                message,
            }),
        }],
        isError: true,
    };
}

const buildSearchSchema = (ctx: ToolContext) => z.object({
    path: absoluteFilesystemPathSchema("ABSOLUTE filesystem path to an indexed codebase or subdirectory (relative paths are rejected)."),
    query: z.string().min(1).describe("Search query. Supports natural language, identifiers, and prefix operators such as lang:, path:, -path:, must:, and exclude:."),
    scope: z.enum(["runtime", "mixed", "docs"]).optional().meta({ default: "runtime" }).describe("Search scope policy. runtime includes source/runtime code and tests while excluding docs/generated/artifacts/landing/fixtures; docs returns documentation paths only (not tests); mixed includes all. Docs scope skips reranker by policy in the current tool surface."),
    resultMode: z.enum(["grouped", "raw"]).optional().meta({ default: "grouped" }).describe("Output mode. grouped returns merged search groups, raw returns chunk hits."),
    groupBy: z.enum(["symbol", "file"]).optional().meta({ default: "symbol" }).describe("Grouping strategy in grouped mode."),
    rankingMode: z.enum(["default", "auto_changed_first"]).optional().meta({ default: "auto_changed_first" }).describe("Ranking policy. auto_changed_first boosts files changed in the current git working tree when available."),
    limit: z.number().int().positive().max(ctx.capabilities.getMaxSearchResultTotal()).optional().meta({ default: ctx.capabilities.getDefaultSearchLimit() }).describe("Grouped mode: total frozen result-set bound across continuation pages. Raw mode: maximum returned chunk count. It is not the initial grouped page size."),
    disclosureLimit: z.number().int().positive().max(ctx.capabilities.getMaxSearchPageSize()).optional().describe("Initial grouped-result page size only. Grouped searches show at most 10 results initially when omitted. For example, limit=20 and disclosureLimit=6 returns up to 6 initially and freezes up to 20 total for continuation. Retrieval depth and reranker admission are independent."),
    includeResultIndex: z.boolean().optional().describe("Optional grouped-mode compact index over the frozen ranked results. Defaults to false when omitted."),
    debugMode: z.enum(["summary", "ranking", "freshness", "full"]).optional().describe("Bounded diagnostic projection."),
    debugCandidateLimit: z.number().int().positive().max(SEARCH_MAX_DIAGNOSTIC_CANDIDATES).optional().describe("Diagnostic-only retrieval depth. Valid only with full diagnostics; it does not change the visible result limit or reranker ceilings."),
    flags: z.record(z.string(), z.boolean()).optional().describe("Experimental search flags for candidate expansion or retrieval ablation."),
    alt_terms: z.array(z.string().max(SEARCH_ALT_TERMS_TERM_MAX_CHARS)).max(SEARCH_ALT_TERMS_MAX).or(z.string().max(SEARCH_ALT_TERMS_STRING_MAX_CHARS)).optional().describe(`Optional alternative technical terms or likely code identifiers expected in the target implementation (e.g. ['destroy', 'unmount'] for a cleanup query). At most ${SEARCH_ALT_TERMS_MAX} terms. Arrays exceeding the count or ${SEARCH_ALT_TERMS_TERM_MAX_CHARS} characters per term are rejected; string input is split on commas or whitespace, with excess terms dropped and reported as termsDropped. Used in an isolated expanded retrieval pass fused via reciprocal rank fusion, and included with the original question for contextual reranking.`),
    reservation_policy: z.enum(["cap55", "cap64", "off"]).optional().describe("Primary-slot reservation policy for the caller-expansion pass. cap55 reserves up to 55 primary slots (default, current behavior); cap64 reserves up to 64; off disables the reservation so the pool keeps fused-score order."),
}).strict().superRefine((value, refinementContext) => {
    if (value.debugCandidateLimit !== undefined && value.debugMode !== "full") {
        refinementContext.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["debugCandidateLimit"],
            message: "debugCandidateLimit requires debugMode=full.",
        });
    }
    if (value.disclosureLimit !== undefined && value.resultMode === "raw") {
        refinementContext.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["disclosureLimit"],
            message: "disclosureLimit is available only with grouped results.",
        });
    }
    if (value.includeResultIndex !== undefined && value.resultMode === "raw") {
        refinementContext.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["includeResultIndex"],
            message: "includeResultIndex is available only with grouped results.",
        });
    }
    const effectiveRequestedTotal = value.limit ?? ctx.capabilities.getDefaultSearchLimit();
    if (value.disclosureLimit !== undefined
        && value.disclosureLimit > effectiveRequestedTotal) {
        refinementContext.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["disclosureLimit"],
            message: "disclosureLimit cannot exceed limit.",
        });
    }
    if (parseSearchOperators(value.query).semanticQuery.trim().length === 0) {
        refinementContext.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["query"],
            message: "Operator-only search requires semantic text or a positive must:, path:, or lang: value.",
        });
    }
});

export const searchCodebaseTool: McpTool = {
    name: "search_codebase",
    description: () =>
        "Hybrid repository search for unfamiliar behavior, ownership, symbols, configuration, or related implementation. It combines exact/lexical and semantic evidence with a runtime-first scope=\"runtime\" default. Query prefixes support lang:, path:, -path:, must:, and exclude:. Recall is bounded, not exhaustive. Grouped results expose canonical targets, bounded source previews, freshness/readiness, graph navigation state, recommendedNextAction, and recovery hints. Use .satoriignore plus manage_index sync to remove persistent indexed noise. Use debugMode=summary|ranking|freshness|full for bounded diagnostics. Follow recommendedNextAction; use continue_search only when a continuation is returned.",
    inputSchemaZod: (ctx: ToolContext) => buildSearchSchema(ctx),
    execute: async (args: unknown, ctx: ToolContext) => {
        const schema = buildSearchSchema(ctx);
        const parsed = schema.safeParse(args || {});
        if (!parsed.success) {
            return {
                content: [{
                    type: "text",
                    text: formatZodError("search_codebase", parsed.error)
                }],
                isError: true
            };
        }

        const absolutePathResult = requireAbsoluteFilesystemPath(parsed.data.path, "path");
        if (!absolutePathResult.ok) {
            return {
                content: [{
                    type: "text",
                    text: absolutePathResult.message,
                }],
                isError: true,
            };
        }

        // Session workspace gate: the requested path must be authorized before
        // input normalization, query planning, provider resolution, telemetry,
        // or the search pipeline can run. An unbound policy fails closed with
        // WORKSPACE_POLICY_NOT_BOUND. The authorized canonical path is the only
        // path that reaches the downstream request.
        const workspacePolicy = ctx.workspacePolicy;
        if (!workspacePolicy) {
            return formatWorkspaceAuthorizationError(
                "search_codebase",
                absolutePathResult.absolutePath,
                new WorkspaceAuthorizationError(
                    "WORKSPACE_POLICY_NOT_BOUND",
                    "Tool context has not been bound to an MCP session workspace policy.",
                ),
            );
        }
        let authorized: AuthorizedWorkspacePath;
        try {
            authorized = workspacePolicy.authorizePath(absolutePathResult.absolutePath);
        } catch (error) {
            if (error instanceof WorkspaceAuthorizationError) {
                return formatWorkspaceAuthorizationError(
                    "search_codebase",
                    absolutePathResult.absolutePath,
                    error,
                );
            }
            throw error;
        }

        const normalizedInput = parsed.data;
        const normalizedDebugMode: PublicSearchDebugMode = normalizedInput.debugMode ?? "none";
        const input = {
            ...normalizedInput,
            path: authorized.canonicalPath,
            scope: normalizedInput.scope ?? "runtime",
            resultMode: normalizedInput.resultMode ?? "grouped",
            groupBy: normalizedInput.groupBy ?? "symbol",
            rankingMode: normalizedInput.rankingMode ?? "auto_changed_first",
            debugMode: normalizedDebugMode,
        };
        const startedAt = Date.now();
        const limit = input.limit ?? ctx.capabilities.getDefaultSearchLimit();
        const profile = getProfile(ctx);
        const parsedOperators = parseSearchOperators(input.query);
        const queryPlan = buildSearchQueryPlan(
            parsedOperators.semanticQuery,
            ctx.runtimeFingerprint?.schemaVersion.startsWith("hybrid") === true,
            parsedOperators,
        );
        const providerOperation = queryPlan.retrievalMode === "lexical"
            ? "vector_only"
            : "embedding_vector";
        let executionContext: ToolContext | MissingProviderConfigIssue;
        try {
            executionContext = ctx.providerRuntime
                ? await ctx.providerRuntime.requireToolContext(providerOperation, { signal: ctx.requestSignal })
                : ctx;
        } catch (error) {
            const diagnostic = classifyVectorBackendError(error);
            if (!diagnostic) {
                throw error;
            }
            const response = formatSearchVectorBackendError({
                ...input,
                limit,
            }, diagnostic);
            emitSearchBackendErrorTelemetry({
                profile,
                queryLength: input.query.length,
                limit,
                startedAt,
                code: diagnostic.code,
                routeKind: queryPlan.route.kind,
                retrievalMode: queryPlan.retrievalMode,
                responseBytes: getResponseBytes(response),
            });
            return response;
        }
        ctx.requestSignal?.throwIfAborted();
        if (isMissingProviderConfigIssue(executionContext)) {
            const response = formatSearchProviderConfigError({
                ...input,
                limit,
            }, executionContext);
            emitSearchTelemetry({
                event: "search_executed",
                tool_name: "search_codebase",
                profile,
                query_length: input.query.length,
                limit_requested: limit,
                results_before_filter: 0,
                results_after_filter: 0,
                results_returned: 0,
                excluded_by_ignore: 0,
                reranker_used: false,
                reranker_attempted: false,
                latency_ms: Date.now() - startedAt,
                route: queryPlan.route.kind,
                retrieval_mode: queryPlan.retrievalMode,
                semantic_search_attempts: 0,
                embedding_calls_by_current_contract: 0,
                dense_queries_by_current_contract: 0,
                sparse_queries_by_current_contract: 0,
                reranker_calls: 0,
                reranker_candidates: 0,
                reranker_input_bytes: 0,
                response_bytes: getResponseBytes(response),
                error: executionContext.code,
            });
            return response;
        }

        let response: ToolResponse;
        try {
            response = await executionContext.toolHandlers.handleSearchCode({
                ...input,
                limit
            }, ctx.requestSignal);
        } catch (error) {
            const diagnostic = classifyVectorBackendError(error);
            if (!diagnostic) {
                throw error;
            }
            response = formatSearchVectorBackendError({
                ...input,
                limit,
            }, diagnostic);
            emitSearchBackendErrorTelemetry({
                profile,
                queryLength: input.query.length,
                limit,
                startedAt,
                code: diagnostic.code,
                routeKind: queryPlan.route.kind,
                retrievalMode: queryPlan.retrievalMode,
                responseBytes: getResponseBytes(response),
            });
            return response;
        }

        const diagnostics = extractDiagnostics(response);
        emitSearchTelemetry({
            event: "search_executed",
            tool_name: "search_codebase",
            profile,
            query_length: input.query.length,
            limit_requested: limit,
            results_before_filter: diagnostics.resultsBeforeFilter,
            results_after_filter: diagnostics.resultsAfterFilter,
            results_returned: diagnostics.resultsReturned,
            excluded_by_ignore: diagnostics.excludedByIgnore,
            reranker_used: diagnostics.rerankerUsed === true,
            reranker_attempted: diagnostics.rerankerAttempted === true,
            latency_ms: Date.now() - startedAt,
            freshness_mode: diagnostics.freshnessMode,
            search_pass_count: diagnostics.searchPassCount,
            search_pass_success_count: diagnostics.searchPassSuccessCount,
            search_pass_failure_count: diagnostics.searchPassFailureCount,
            route: diagnostics.routeKind,
            retrieval_mode: diagnostics.retrievalMode,
            semantic_search_attempts: diagnostics.semanticSearchAttempts,
            embedding_calls_by_current_contract: diagnostics.embeddingCallsByCurrentContract,
            dense_queries_by_current_contract: diagnostics.denseQueriesByCurrentContract,
            sparse_queries_by_current_contract: diagnostics.sparseQueriesByCurrentContract,
            reranker_calls: diagnostics.rerankerCalls,
            reranker_candidates: diagnostics.rerankerCandidates,
            reranker_input_bytes: diagnostics.rerankerInputBytes,
            candidates_with_semantic_evidence: diagnostics.candidatesWithSemanticEvidence,
            candidates_with_lexical_evidence: diagnostics.candidatesWithLexicalEvidence,
            candidates_with_current_source_evidence: diagnostics.candidatesWithCurrentSourceEvidence,
            semantic_expansion_attempted: diagnostics.semanticExpansionAttempted,
            semantic_expansion_reason: diagnostics.semanticExpansionReason,
            response_bytes: getResponseBytes(response),
            ...(response.isError ? { error: getErrorMessage(response) } : {})
        });

        return response;
    }
};
