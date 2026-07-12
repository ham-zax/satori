import test from "node:test";
import assert from "node:assert/strict";
import {
    OVERSIZED_SYMBOL_LINE_THRESHOLD,
    SEARCH_CALLER_TERM_MAX_BYTES,
    buildCallerSearchTerm,
    buildInboundNotesOnlySearchQuery,
    buildSearchGraphNavigation,
    buildSearchGroupPreview,
    buildSearchGroupRecommendedAction,
    buildSearchWarningDetails,
    buildTopRecommendedSearchAction,
    roundSearchScore,
    truncateSearchUtf8,
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

function baseGroup(partial: Partial<SearchGroupResult> = {}): SearchGroupResult {
    return {
        target: {
            file: "src/tool-handlers.ts",
            span: { startLine: 1, endLine: 2000 },
            symbolId: "sym_tool_handlers",
        },
        displayLabel: "class ToolHandlers",
        language: "typescript",
        symbolKind: "class",
        score: 0.9,
        quality: { owner: "high", semantic: "medium" },
        evidenceSpan: { startLine: 100, endLine: 140 },
        preview: "class ToolHandlers",
        navigation: { graph: "ready", inbound: "verify", callerSearchTerm: "ToolHandlers" },
        __groupId: "g1",
        __symbolInstanceId: "sym_tool_handlers",
        __exactLexicalMatch: false,
        ...partial,
    };
}

test("oversized symbol recommends the matched evidence span before exact open", () => {
    assert.ok(OVERSIZED_SYMBOL_LINE_THRESHOLD >= 200);
    const result = baseGroup();
    const action = buildSearchGroupRecommendedAction("/repo", result, 0);
    assert.ok(action);
    assert.equal(action.tool, "read_file");
    assert.equal(action.resultIndex, 0);
    assert.deepEqual(action.args, {
        path: "/repo/src/tool-handlers.ts",
        start_line: 100,
        end_line: 140,
    });
    assert.equal(result.target.symbolId, "sym_tool_handlers");
    assert.deepEqual(result.target.span, { startLine: 1, endLine: 2000 });
});

test("non-oversized concrete symbol recommends exact open_symbol", () => {
    const result = baseGroup({
        target: {
            file: "src/tool-handlers.ts",
            span: { startLine: 10, endLine: 40 },
            symbolId: "sym_tool_handlers",
        },
        evidenceSpan: { startLine: 12, endLine: 20 },
    });
    const action = buildSearchGroupRecommendedAction("/repo", result);
    assert.ok(action);
    assert.deepEqual(action.args, {
        path: "/repo/src/tool-handlers.ts",
        open_symbol: { symbolId: "sym_tool_handlers" },
    });
});

test("recommended actions reject executable targets outside the codebase root", () => {
    for (const file of ["../outside.ts", "/etc/passwd", "C:\\Windows\\system.ini", "src/bad\0.ts"]) {
        const action = buildSearchGroupRecommendedAction("/repo", baseGroup({
            target: {
                file,
                span: { startLine: 1, endLine: 2 },
                symbolId: "sym_target",
            },
        }));
        assert.equal(action, undefined, file);
    }

    assert.equal(buildSearchGroupRecommendedAction("/repo", baseGroup({
        target: {
            file: "src/valid.ts",
            span: { startLine: 1, endLine: 2 },
            symbolId: "   ",
        },
    })), undefined);
});

test("top recommendation preserves ranked order instead of skipping a span-only first result", () => {
    const first = baseGroup({
        target: { file: "src/first.ts", span: { startLine: 8, endLine: 12 } },
        navigation: { graph: "missing_symbol" },
    });
    const second = baseGroup({
        target: {
            file: "src/second.ts",
            span: { startLine: 2, endLine: 6 },
            symbolId: "sym_second",
        },
    });
    const action = buildTopRecommendedSearchAction("/repo", [first, second]);
    assert.equal(action?.resultIndex, 0);
    assert.deepEqual(action?.args, {
        path: "/repo/src/first.ts",
        start_line: 8,
        end_line: 12,
    });
});

test("caller term is a complete bounded ASCII identifier and only accompanies graph-ready state", () => {
    assert.equal(buildCallerSearchTerm("checkMutation"), "checkMutation");
    assert.equal(buildCallerSearchTerm("member.call"), undefined);
    assert.equal(buildCallerSearchTerm("x".repeat(SEARCH_CALLER_TERM_MAX_BYTES + 1)), undefined);
    assert.deepEqual(
        buildSearchGraphNavigation({
            supported: true,
            symbolRef: { file: "src/gate.ts", symbolId: "sym_gate" },
            validated: true,
            validatedAt: "2026-01-01T00:00:00.000Z",
            sidecarBuiltAt: "2026-01-01T00:00:00.000Z",
        }, "checkMutation"),
        { graph: "ready", inbound: "verify", callerSearchTerm: "checkMutation" },
    );
    assert.deepEqual(
        buildSearchGraphNavigation({ supported: false, reason: "missing_symbol" }, "checkMutation"),
        { graph: "missing_symbol" },
    );
});

test("group previews contain source evidence without repeating the display label", () => {
    assert.equal(
        buildSearchGroupPreview(
            "function validateSession(token: string)",
            "function validateSession(token: string) {\n  return token.length > 0;\n}",
            768,
        ),
        "return token.length > 0;",
    );
});

test("UTF-8 truncation and score serialization are deterministic", () => {
    const truncated = truncateSearchUtf8("alpha-你好-omega", 13);
    assert.ok(Buffer.byteLength(truncated, "utf8") <= 13);
    assert.equal(truncated.endsWith("..."), true);
    assert.equal(truncated.includes("�"), false);
    assert.equal(roundSearchScore(0.123456789), 0.123457);
});

test("buildInboundNotesOnlySearchQuery extracts identifier and rejects unsafe paths", () => {
    assert.deepEqual(
        buildInboundNotesOnlySearchQuery({
            symbolLabel: "method buildOperatorSummary(operators: ParsedSearchOperators)",
            file: "src/search-query-planning.ts",
        }),
        {
            query: "must:buildOperatorSummary buildOperatorSummary path:src/search-query-planning.ts",
            pathFilterIncluded: true,
        },
    );
    assert.deepEqual(
        buildInboundNotesOnlySearchQuery({ symbolLabel: "function login()", file: "/absolute/root" }),
        { query: "must:login login", pathFilterIncluded: false },
    );
    assert.deepEqual(
        buildInboundNotesOnlySearchQuery({ symbolLabel: "???", file: "src/a.ts" }),
        { query: "", pathFilterIncluded: false },
    );
});
