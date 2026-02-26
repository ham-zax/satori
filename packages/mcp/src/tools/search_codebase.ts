import { z } from "zod";
import { McpTool, ToolContext, ToolResponse, formatZodError } from "./types.js";
import { emitSearchTelemetry } from "../telemetry/search.js";

interface SearchDiagnostics {
    resultsBeforeFilter: number;
    resultsAfterFilter: number;
    excludedByIgnore: number;
    resultsReturned: number;
    freshnessMode?: string;
    searchPassCount?: number;
    searchPassSuccessCount?: number;
    searchPassFailureCount?: number;
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

    const metaDiagnostics = (response as any)?.meta?.searchDiagnostics;
    if (metaDiagnostics && typeof metaDiagnostics === "object") {
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
        };
    }

    const text = response.content?.[0]?.text;
    if (typeof text !== "string") {
        return fallback;
    }

    try {
        const parsed = JSON.parse(text);
        const results = Array.isArray(parsed?.results) ? parsed.results.length : 0;
        return {
            resultsBeforeFilter: safeNumber(parsed?.resultsBeforeFilter, results),
            resultsAfterFilter: safeNumber(parsed?.resultsAfterFilter, results),
            excludedByIgnore: safeNumber(parsed?.excludedByIgnore, 0),
            resultsReturned: results,
            freshnessMode: typeof parsed?.freshnessDecision?.mode === "string" ? parsed.freshnessDecision.mode : undefined,
            searchPassCount: safeNumber(parsed?.searchPassCount, 0),
            searchPassSuccessCount: safeNumber(parsed?.searchPassSuccessCount, 0),
            searchPassFailureCount: safeNumber(parsed?.searchPassFailureCount, 0),
        };
    } catch {
        return fallback;
    }
}

const buildSearchSchema = (ctx: ToolContext) => z.object({
    path: z.string().min(1).describe("ABSOLUTE path to an indexed codebase or subdirectory."),
    query: z.string().min(1).describe("Natural-language query."),
    scope: z.enum(["runtime", "mixed", "docs"]).default("runtime").optional().describe("Search scope policy. runtime excludes docs/tests, docs returns docs/tests only, mixed includes all."),
    resultMode: z.enum(["grouped", "raw"]).default("grouped").optional().describe("Output mode. grouped returns merged search groups, raw returns chunk hits."),
    groupBy: z.enum(["symbol", "file"]).default("symbol").optional().describe("Grouping strategy in grouped mode."),
    rankingMode: z.enum(["default", "auto_changed_first"]).default("auto_changed_first").optional().describe("Ranking policy. auto_changed_first boosts files changed in the current git working tree when available."),
    limit: z.number().int().positive().max(ctx.capabilities.getMaxSearchLimit()).default(ctx.capabilities.getDefaultSearchLimit()).optional().describe("Maximum groups (grouped mode) or chunks (raw mode)."),
    debug: z.boolean().default(false).optional().describe("Optional debug payload toggle for score and fusion breakdowns."),
});

export const searchCodebaseTool: McpTool = {
    name: "search_codebase",
    description: () =>
        "Unified semantic search with runtime/docs scope control, grouped/raw output modes, deterministic ranking, and structured freshness decisions. Operators are parsed from a query prefix block: lang:, path:, -path:, must:, exclude: (escape with \\\\ to keep literals). For runtime debugging, start with scope=\"runtime\". If you need both runtime and docs context, use scope=\"mixed\". If top results are dominated by tests/fixtures/docs, edit repo-root .satoriignore using your host/editor (examples, not exhaustive: **/*.test.*, **/*.spec.*, **/__tests__/**, **/__fixtures__/**, **/fixtures/**, coverage/**), wait one debounce window (MCP_WATCH_DEBOUNCE_MS, default 5000ms), then rerun search_codebase. For immediate convergence, run manage_index with {\"action\":\"sync\",\"path\":\"<same path used in search_codebase>\"}.",
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

        const input = parsed.data;
        const startedAt = Date.now();
        const limit = Math.max(1, Math.min(ctx.capabilities.getMaxSearchLimit(), input.limit ?? ctx.capabilities.getDefaultSearchLimit()));
        const profile = getProfile(ctx);

        const response = await ctx.toolHandlers.handleSearchCode({
            ...input,
            limit
        });

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
            reranker_used: false,
            latency_ms: Date.now() - startedAt,
            freshness_mode: diagnostics.freshnessMode,
            search_pass_count: diagnostics.searchPassCount,
            search_pass_success_count: diagnostics.searchPassSuccessCount,
            search_pass_failure_count: diagnostics.searchPassFailureCount,
            parallel_fanout: true,
            ...(response.isError ? { error: getErrorMessage(response) } : {})
        });

        return response;
    }
};
