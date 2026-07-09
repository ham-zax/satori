import test from "node:test";
import assert from "node:assert/strict";
import {
    collapseDuplicateDeclarationGroups,
    scoresNearlyEqual,
    sortGroupedSearchResults,
} from "./search-group-ordering.js";
import type { SearchGroupResult } from "./search-types.js";

type Sortable = SearchGroupResult & { __exactLexicalMatch: boolean };

function group(partial: Partial<SearchGroupResult> & Pick<SearchGroupResult, "file" | "symbolLabel" | "score">): Sortable {
    return {
        kind: "group",
        groupId: partial.groupId || `grp_${partial.file}_${partial.symbolLabel}`,
        file: partial.file,
        span: partial.span || { startLine: 1, endLine: 10 },
        symbolSpan: partial.symbolSpan,
        language: partial.language || "typescript",
        symbolId: partial.symbolId,
        symbolLabel: partial.symbolLabel,
        symbolKind: partial.symbolKind,
        score: partial.score,
        indexedAt: null,
        stalenessBucket: "fresh",
        collapsedChunkCount: 1,
        callGraphHint: { supported: false, reason: "missing_symbol" },
        capabilities: {
            openSymbol: "medium",
            callGraphCallers: "low",
            callGraphCallees: "low",
            semanticMatch: "medium",
        },
        preview: partial.preview || partial.symbolLabel,
        __exactLexicalMatch: false,
    };
}

test("scoresNearlyEqual treats 5% relative gap as near-tie", () => {
    assert.equal(scoresNearlyEqual(1.0, 0.96), true);
    assert.equal(scoresNearlyEqual(1.0, 0.94), false);
});

test("sortGroupedSearchResults prefers method over mega-class on near-tied scores", () => {
    const results: Sortable[] = [
        group({
            file: "packages/mcp/src/core/handlers.ts",
            symbolLabel: "class ToolHandlers",
            symbolKind: "class",
            score: 0.78,
            symbolSpan: { startLine: 382, endLine: 2631 },
            span: { startLine: 382, endLine: 2631 },
        }),
        group({
            file: "packages/mcp/src/core/handlers.ts",
            symbolLabel: "async method recoverStaleIndexingStateIfNeeded(codebasePath: string)",
            symbolKind: "method",
            score: 0.75,
            symbolSpan: { startLine: 1071, endLine: 1108 },
            span: { startLine: 1071, endLine: 1108 },
        }),
    ];

    sortGroupedSearchResults(results, false);
    assert.equal(results[0].symbolKind, "method");
    assert.match(results[0].symbolLabel, /recoverStaleIndexingStateIfNeeded/);
});

test("sortGroupedSearchResults prefers declaration over comment-like group on near-tie", () => {
    const results: Sortable[] = [
        group({
            file: "packages/mcp/src/core/sync.ts",
            symbolLabel: "comment block",
            symbolKind: "file",
            score: 1.02,
            preview: "// Context is the single source of truth for effective ignore rules.",
            span: { startLine: 553, endLine: 559 },
        }),
        group({
            file: "packages/cli/src/install.ts",
            symbolLabel: "function prepareClaudeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand)",
            symbolKind: "function",
            score: 0.99,
            preview: "function prepareClaudeInstall(...) {",
            span: { startLine: 750, endLine: 792 },
            symbolSpan: { startLine: 750, endLine: 792 },
        }),
    ];

    sortGroupedSearchResults(results, false);
    assert.equal(results[0].symbolKind, "function");
    assert.match(results[0].symbolLabel, /prepareClaudeInstall/);
});

test("sortGroupedSearchResults keeps clear higher score even for mega-class", () => {
    const results: Sortable[] = [
        group({
            file: "a.ts",
            symbolLabel: "class Big",
            symbolKind: "class",
            score: 0.95,
            symbolSpan: { startLine: 1, endLine: 2000 },
        }),
        group({
            file: "b.ts",
            symbolLabel: "function small()",
            symbolKind: "function",
            score: 0.5,
            symbolSpan: { startLine: 1, endLine: 5 },
        }),
    ];

    sortGroupedSearchResults(results, false);
    assert.equal(results[0].symbolLabel, "class Big");
});

test("sortGroupedSearchResults still pins exact lexical match over near-tie preference", () => {
    const results: Sortable[] = [
        group({
            file: "a.ts",
            symbolLabel: "function preferred()",
            symbolKind: "function",
            score: 0.8,
            symbolSpan: { startLine: 1, endLine: 5 },
        }),
        {
            ...group({
                file: "b.ts",
                symbolLabel: "class ExactHit",
                symbolKind: "class",
                score: 0.2,
                symbolSpan: { startLine: 1, endLine: 500 },
            }),
            __exactLexicalMatch: true,
            debug: {
                representativeChunkCount: 1,
                pathCategory: "core",
                pathMultiplier: 1,
                topChunkScore: 0.2,
                lexicalScore: 1,
                exactLexicalMatch: true,
                provenance: {
                    retrievalPasses: ["primary"],
                    backendScoreKinds: ["unknown"],
                    semanticCandidate: false,
                    lexicalCandidate: true,
                    rerankAdjusted: false,
                    exactMatchPinned: false,
                    ownerRepairApplied: false,
                },
            },
        },
    ];

    const applied = sortGroupedSearchResults(results, true);
    assert.equal(applied, true);
    assert.equal(results[0].symbolLabel, "class ExactHit");
    assert.equal(results[0].debug?.provenance?.exactMatchPinned, true);
});

test("collapseDuplicateDeclarationGroups keeps tighter near-tie winner", () => {
    const groups = [
        group({
            file: "a.ts",
            symbolLabel: "function foo()",
            symbolKind: "function",
            symbolKey: "k1",
            score: 0.8,
            symbolSpan: { startLine: 1, endLine: 40 },
        }),
        group({
            file: "a.ts",
            symbolLabel: "function foo()",
            symbolKind: "function",
            symbolKey: "k1",
            score: 0.79,
            symbolSpan: { startLine: 1, endLine: 5 },
        }),
    ];

    const collapsed = collapseDuplicateDeclarationGroups(groups);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].symbolSpan?.endLine, 5);
});
