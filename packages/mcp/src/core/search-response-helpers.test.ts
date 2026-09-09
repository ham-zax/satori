import test from "node:test";
import assert from "node:assert/strict";
import { exactSymbolOpenRequestSchema } from './symbol-context-public-contract.js';
import {
    OVERSIZED_SYMBOL_LINE_THRESHOLD,
    SEARCH_CALLER_TERM_MAX_BYTES,
    buildCallerSearchTerm,
    buildInboundVerificationSearchQuery,
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
        assert.match(details[0]?.action ?? "", /canonical read_file request from recommendedNextAction/i);
        assert.doesNotMatch(details[0]?.action ?? "", /read_file\(open_symbol\)/i);
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

test("incompatible reranker context warning preserves source-backed results and recommends reindex", () => {
    const [warning] = buildSearchWarningDetails(["RERANKER_CONTEXT_DEGRADED"]);
    assert.equal(warning?.blocksUse, false);
    assert.equal(warning?.severity, "degraded");
    assert.match(warning?.message ?? "", /relationship.*does not match.*generation/i);
    assert.match(warning?.action ?? "", /manage_index reindex/i);
});

test("navigation reindex warning preserves vector usability and recommends reindex", () => {
    const [warning] = buildSearchWarningDetails(["NAVIGATION_REINDEX_REQUIRED"]);
    assert.equal(warning?.blocksUse, false);
    assert.equal(warning?.severity, "degraded");
    assert.match(warning?.action ?? "", /^Run manage_index reindex/i);
});

test("source checkpoint warning preserves vector usability but requires reindex", () => {
    const [warning] = buildSearchWarningDetails(["SOURCE_FRESHNESS_CHECKPOINT_UNAVAILABLE"]);
    assert.equal(warning?.blocksUse, false);
    assert.equal(warning?.severity, "degraded");
    assert.match(warning?.message ?? "", /current-source freshness is unverified/i);
    assert.match(warning?.action ?? "", /^Run manage_index reindex/i);
    assert.match(warning?.action ?? "", /incremental sync remains disabled/i);
});

test("unverified source freshness warning preserves proven vector usability", () => {
    const [warning] = buildSearchWarningDetails(["SOURCE_FRESHNESS_UNVERIFIED"]);
    assert.equal(warning?.blocksUse, false);
    assert.equal(warning?.severity, "degraded");
    assert.match(warning?.message ?? "", /current-source freshness is unverified/i);
    assert.match(warning?.action ?? "", /manage_index sync/i);
});

test("compact result-index admission warning preserves the full search result", () => {
    const [warning] = buildSearchWarningDetails(["SEARCH_RESULT_INDEX_NOT_ADMISSIBLE"]);
    assert.equal(warning?.blocksUse, false);
    assert.equal(warning?.severity, "caution");
    assert.match(warning?.message ?? "", /full search results are valid/i);
    assert.match(warning?.action ?? "", /no result order or group was removed/i);
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
        __candidateIds: [],
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

test("non-oversized concrete result recommends role-neutral exact symbol context", () => {
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
        mode: "plain",
        open_symbol: {
            contractVersion: 2,
            symbolId: "sym_tool_handlers",
            context: { preset: "definition" },
        },
    });
    assert.equal(action.reason, "Open bounded symbol context for the highest-ranked concrete result.");
});

test('search intent selects an actionable context preset without changing the result target', () => {
    const result = baseGroup({
        target: { file: 'src/owner.ts', span: { startLine: 1, endLine: 30 }, symbolId: 'owner' },
    });
    for (const referenceSeeking of [false, true]) {
        const action = buildSearchGroupRecommendedAction('/repo', result, 0, {
            semanticQuery: 'where is the request handled', referenceSeeking, implementationSeeking: true,
        });
        assert.ok(action);
        assert.equal(action.tool, 'read_file');
        assert.equal(action.args.path, '/repo/src/owner.ts');
        const open = exactSymbolOpenRequestSchema.parse(action.args.open_symbol);
        assert.equal(open.symbolId, 'owner');
        assert.equal(open.context?.preset, referenceSeeking ? 'call_context' : 'implementation');
        assert.equal(open.context?.query, 'where is the request handled');
    }
});

test('long search text cannot create an invalid symbol-context recommendation', () => {
    const result = baseGroup({
        target: { file: 'src/owner.ts', span: { startLine: 1, endLine: 30 }, symbolId: 'owner' },
    });
    const action = buildSearchGroupRecommendedAction('/repo', result, 0, {
        semanticQuery: 'x'.repeat(513), referenceSeeking: false, implementationSeeking: true,
    });
    assert.ok(action);
    const open = exactSymbolOpenRequestSchema.parse(action.args.open_symbol);
    assert.equal(open.context?.preset, 'implementation');
    assert.equal(open.context?.query, undefined);
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
            relationshipBuiltAt: "2026-01-01T00:00:00.000Z",
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

test("buildInboundVerificationSearchQuery uses exact symbol names and rejects unsafe paths", () => {
    assert.deepEqual(
        buildInboundVerificationSearchQuery({
            symbolName: "café",
            symbolLabel: "function café()",
        }),
        { query: "must:café café", pathFilterIncluded: false },
    );
    assert.deepEqual(
        buildInboundVerificationSearchQuery({
            symbolName: "Status",
            symbolLabel: "enum Status",
            file: "src/search-query-planning.ts",
        }),
        {
            query: "must:Status Status path:src/search-query-planning.ts",
            pathFilterIncluded: true,
        },
    );
    assert.deepEqual(
        buildInboundVerificationSearchQuery({
            symbolLabel: "method buildOperatorSummary(operators: ParsedSearchOperators)",
            file: "src/search-query-planning.ts",
        }),
        {
            query: "must:buildOperatorSummary buildOperatorSummary path:src/search-query-planning.ts",
            pathFilterIncluded: true,
        },
    );
    assert.deepEqual(
        buildInboundVerificationSearchQuery({ symbolLabel: "function login()", file: "/absolute/root" }),
        { query: "must:login login", pathFilterIncluded: false },
    );
    assert.deepEqual(
        buildInboundVerificationSearchQuery({ symbolLabel: "???", file: "src/a.ts" }),
        { query: "", pathFilterIncluded: false },
    );
});

test("buildSearchWarningDetails renders the must: retrieval-budget notes with bounded guidance", () => {
    const details = buildSearchWarningDetails([
        "MUST_NOT_SATISFIED_WITHIN_RETRIEVAL_BUDGET",
        "MUST_RESULTS_MAY_BE_INCOMPLETE_WITHIN_RETRIEVAL_BUDGET",
    ]);
    const byCode = new Map(details.map((detail) => [detail.code, detail]));
    const unsatisfied = byCode.get("MUST_NOT_SATISFIED_WITHIN_RETRIEVAL_BUDGET");
    assert.equal(unsatisfied?.severity, "degraded");
    assert.equal(unsatisfied?.blocksUse, false);
    assert.match(unsatisfied?.message ?? "", /no candidate satisfied every must: value within the bounded retrieval budget/);
    assert.match(unsatisfied?.action ?? "", /other matching files may exist beyond the retrieval budget/);
    const incomplete = byCode.get("MUST_RESULTS_MAY_BE_INCOMPLETE_WITHIN_RETRIEVAL_BUDGET");
    assert.equal(incomplete?.severity, "caution");
    assert.equal(incomplete?.blocksUse, false);
    assert.match(incomplete?.message ?? "", /exhausted its candidate budget/);
    assert.doesNotMatch(incomplete?.message ?? "", /no other matching files exist/);
});
