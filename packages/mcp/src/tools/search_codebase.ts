import { z } from "zod";
import { McpTool, MissingProviderConfigIssue, ToolContext, ToolResponse, formatZodError } from "./types.js";
import { emitSearchTelemetry } from "../telemetry/search.js";
import {
    classifyVectorBackendError,
    formatSearchProviderConfigError,
    formatSearchVectorBackendError,
    isMissingProviderConfigIssue
} from "./setup-errors.js";

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
}

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
            resultsReturned: afterFilter,
            freshnessMode: typeof metaDiagnostics.freshnessMode === "string" ? metaDiagnostics.freshnessMode : undefined,
            searchPassCount: safeNumber(metaDiagnostics.searchPassCount, 0),
            searchPassSuccessCount: safeNumber(metaDiagnostics.searchPassSuccessCount, 0),
            searchPassFailureCount: safeNumber(metaDiagnostics.searchPassFailureCount, 0),
            rerankerAttempted: metaDiagnostics.rerankerAttempted === true,
            rerankerUsed: metaDiagnostics.rerankerUsed === true,
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
        parallel_fanout: true,
        ...(args.responseBytes !== undefined ? { response_bytes: args.responseBytes } : {}),
        error: args.code,
    });
}

const buildSearchSchema = (ctx: ToolContext) => z.object({
    path: z.string().min(1).describe("ABSOLUTE path to an indexed codebase or subdirectory."),
    query: z.string().min(1).describe("Natural-language query."),
    scope: z.enum(["runtime", "mixed", "docs"]).default("runtime").optional().describe("Search scope policy. runtime includes source/runtime code and tests while excluding docs/generated/artifacts/landing/fixtures; docs returns docs/tests only; mixed includes all. Docs scope skips reranker by policy in the current tool surface."),
    resultMode: z.enum(["grouped", "raw"]).default("grouped").optional().describe("Output mode. grouped returns merged search groups, raw returns chunk hits."),
    groupBy: z.enum(["symbol", "file"]).default("symbol").optional().describe("Grouping strategy in grouped mode."),
    rankingMode: z.enum(["default", "auto_changed_first"]).default("auto_changed_first").optional().describe("Ranking policy. auto_changed_first boosts files changed in the current git working tree when available."),
    limit: z.number().int().positive().max(ctx.capabilities.getMaxSearchLimit()).default(ctx.capabilities.getDefaultSearchLimit()).optional().describe("Maximum groups (grouped mode) or chunks (raw mode)."),
    debug: z.boolean().default(false).optional().describe("Optional debug payload toggle for score and fusion breakdowns."),
});

export const searchCodebaseTool: McpTool = {
    name: "search_codebase",
    description: () =>
        "Unified semantic search with runtime-first defaults (start with scope=\"runtime\"), grouped/raw output modes, and deterministic ranking/freshness behavior. Operators are parsed from a query prefix block: lang:, path:, -path:, must:, exclude: (escape with \\\\ to keep literals). For high-precision queries such as exact identifiers, quoted literal phrases, and strict path filters, search_codebase can use an exact registry fast path or add a bounded tracked-file lexical recovery pass when semantic retrieval under-delivers. Grouped results expose legacy span plus explicit previewSpan/symbolSpan metadata, structured warnings, recommendedNextAction, per-result capabilities/fallbacks, executable nextActions/navigationFallbacks, and remediation hints such as .satoriignore noise handling. Use debug:true for explainability payloads, including debugSummary, exactRegistry, phaseTimingsMs, trackedLexical, and ranking provenance.",
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

        const input = {
            ...parsed.data,
            scope: parsed.data.scope ?? "runtime",
            resultMode: parsed.data.resultMode ?? "grouped",
            groupBy: parsed.data.groupBy ?? "symbol",
            rankingMode: parsed.data.rankingMode ?? "auto_changed_first",
        };
        const startedAt = Date.now();
        const limit = Math.max(1, Math.min(ctx.capabilities.getMaxSearchLimit(), input.limit ?? ctx.capabilities.getDefaultSearchLimit()));
        const profile = getProfile(ctx);
        let executionContext: ToolContext | MissingProviderConfigIssue;
        try {
            executionContext = ctx.providerRuntime
                ? await ctx.providerRuntime.requireToolContext("embedding_vector")
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
                responseBytes: getResponseBytes(response),
            });
            return response;
        }
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
                parallel_fanout: true,
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
            });
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
            parallel_fanout: true,
            response_bytes: getResponseBytes(response),
            ...(response.isError ? { error: getErrorMessage(response) } : {})
        });

        return response;
    }
};
