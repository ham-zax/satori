import test from "node:test";
import assert from "node:assert/strict";
import {
    OVERSIZED_SYMBOL_LINE_THRESHOLD,
    buildInboundNotesOnlySearchQuery,
    buildSearchGroupRecommendedAction,
    buildSearchWarningDetails,
} from "./search-response-helpers.js";
import type { SearchGroupResult } from "./search-types.js";

test("buildSearchWarningDetails sorts warning codes with contract order (localeCompare-independent)", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = function patchedLocaleCompare(this: string): number {
        return -original.call(this, arguments[0] as string);
    };
    try {
        const details = buildSearchWarningDetails([
            "SEARCH_TRUNCATED_SYMBOL_SPAN",
            "SEARCH_SPAN_START_BEFORE_DEF",
            "SEARCH_SYMBOL_SPAN_UNVERIFIED",
        ]);
        const codes = details.map((detail) => detail.code);
        assert.deepEqual(codes, [
            "SEARCH_SPAN_START_BEFORE_DEF",
            "SEARCH_SYMBOL_SPAN_UNVERIFIED",
            "SEARCH_TRUNCATED_SYMBOL_SPAN",
        ]);
        // Second call with reverse input must match.
        const again = buildSearchWarningDetails([
            "SEARCH_SYMBOL_SPAN_UNVERIFIED",
            "SEARCH_TRUNCATED_SYMBOL_SPAN",
            "SEARCH_SPAN_START_BEFORE_DEF",
        ]).map((detail) => detail.code);
        assert.deepEqual(again, codes);
    } finally {
        String.prototype.localeCompare = original;
    }
});

function baseGroup(partial: Partial<SearchGroupResult>): SearchGroupResult {
    return {
        kind: "group",
        groupId: "g1",
        file: "src/tool-handlers.ts",
        span: { startLine: 1, endLine: 2000 },
        previewSpan: { startLine: 100, endLine: 140 },
        symbolSpan: { startLine: 1, endLine: 2000 },
        language: "typescript",
        symbolLabel: "class ToolHandlers",
        confidence: "medium",
        score: 0.9,
        stalenessBucket: "fresh",
        collapsedChunkCount: 1,
        callGraphHint: {
            supported: true,
            symbolRef: {
                file: "src/tool-handlers.ts",
                symbolId: "sym_tool_handlers",
                span: { startLine: 1, endLine: 2000 },
            },
            validated: true,
            validatedAt: "2026-01-01T00:00:00.000Z",
            sidecarBuiltAt: "2026-01-01T00:00:00.000Z",
        },
        nextActions: {
            openSymbol: {
                tool: "read_file",
                args: {
                    path: "/repo/src/tool-handlers.ts",
                    open_symbol: { symbolId: "sym_tool_handlers" },
                },
            },
        },
        capabilities: {
            openSymbol: "medium",
            callGraphCallers: "low",
            callGraphCallees: "medium",
            semanticMatch: "medium",
        },
        preview: "class ToolHandlers",
        ...partial,
    };
}

test("oversized symbol recommends plain read_file preview before exact open", () => {
    assert.ok(OVERSIZED_SYMBOL_LINE_THRESHOLD >= 200);
    const result = baseGroup({});
    const action = buildSearchGroupRecommendedAction(result, 0);
    assert.ok(action);
    assert.equal(action.tool, "read_file");
    assert.equal(action.args.path, "/repo/src/tool-handlers.ts");
    assert.equal(action.args.start_line, 100);
    assert.equal(action.args.end_line, 140);
    assert.equal(action.args.open_symbol, undefined);
    // Exact open and full graph span remain available on the result.
    assert.equal(result.nextActions?.openSymbol?.args.open_symbol.symbolId, "sym_tool_handlers");
    assert.deepEqual(result.callGraphHint.supported ? result.callGraphHint.symbolRef.span : null, {
        startLine: 1,
        endLine: 2000,
    });
    assert.deepEqual(result.symbolSpan, { startLine: 1, endLine: 2000 });
});

test("non-oversized symbol still recommends exact open_symbol", () => {
    const result = baseGroup({
        symbolSpan: { startLine: 10, endLine: 40 },
        span: { startLine: 10, endLine: 40 },
        previewSpan: { startLine: 12, endLine: 20 },
    });
    const action = buildSearchGroupRecommendedAction(result);
    assert.ok(action);
    assert.deepEqual(action.args.open_symbol, { symbolId: "sym_tool_handlers" });
});

test("buildInboundNotesOnlySearchQuery extracts identifier from multi-token labels", () => {
    const built = buildInboundNotesOnlySearchQuery({
        symbolLabel: "method buildOperatorSummary(operators: ParsedSearchOperators)",
        file: "src/search-query-planning.ts",
    });
    assert.equal(built.query, "must:buildOperatorSummary buildOperatorSummary path:src/search-query-planning.ts");
    assert.equal(built.pathFilterIncluded, true);
});

test("buildInboundNotesOnlySearchQuery omits unsafe path and empty identifier", () => {
    assert.deepEqual(
        buildInboundNotesOnlySearchQuery({
            symbolLabel: "function login()",
            file: "/absolute/root",
        }),
        { query: "must:login login", pathFilterIncluded: false },
    );
    assert.deepEqual(
        buildInboundNotesOnlySearchQuery({ symbolLabel: "???", file: "src/a.ts" }),
        { query: "", pathFilterIncluded: false },
    );
});
