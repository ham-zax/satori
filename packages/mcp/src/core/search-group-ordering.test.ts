import test from "node:test";
import assert from "node:assert/strict";
import {
    collapseDuplicateDeclarationGroups,
    scoresNearlyEqual,
    sortGroupedSearchResults,
} from "./search-group-ordering.js";
import type { SearchGroupResult } from "./search-types.js";

type Sortable = SearchGroupResult & { __exactLexicalMatch: boolean };
type GroupInput = Partial<SearchGroupResult> & {
    file: string;
    displayLabel: string;
    score: number;
    span?: { startLine: number; endLine: number };
    symbolId?: string;
};

function group(partial: GroupInput): Sortable {
    const span = partial.span || { startLine: 1, endLine: 10 };
    return {
        target: {
            file: partial.file,
            span,
            ...(partial.symbolId ? { symbolId: partial.symbolId } : {}),
        },
        displayLabel: partial.displayLabel,
        language: partial.language || "typescript",
        symbolKind: partial.symbolKind,
        score: partial.score,
        quality: {
            owner: "medium",
            semantic: "medium",
        },
        preview: partial.preview || partial.displayLabel,
        navigation: { graph: "missing_symbol" },
        __groupId: partial.__groupId || `grp_${partial.file}_${partial.displayLabel}`,
        __candidateIds: partial.__candidateIds || [`candidate_${partial.file}_${span.startLine}_${span.endLine}`],
        ...(partial.__symbolKey ? { __symbolKey: partial.__symbolKey } : {}),
        ...(partial.__symbolInstanceId ? { __symbolInstanceId: partial.__symbolInstanceId } : {}),
        __exactLexicalMatch: partial.__exactLexicalMatch || false,
        ...(partial.debug ? { debug: partial.debug } : {}),
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
            displayLabel: "class ToolHandlers",
            symbolKind: "class",
            score: 0.78,
            span: { startLine: 382, endLine: 2631 },
        }),
        group({
            file: "packages/mcp/src/core/handlers.ts",
            displayLabel: "async method recoverStaleIndexingStateIfNeeded(codebasePath: string)",
            symbolKind: "method",
            score: 0.75,
            span: { startLine: 1071, endLine: 1108 },
        }),
    ];

    sortGroupedSearchResults(results, false);
    assert.equal(results[0].symbolKind, "method");
    assert.match(results[0].displayLabel, /recoverStaleIndexingStateIfNeeded/);
});

test("sortGroupedSearchResults prefers declaration over comment-like group on near-tie", () => {
    const results: Sortable[] = [
        group({
            file: "packages/mcp/src/core/sync.ts",
            displayLabel: "comment block",
            symbolKind: "file",
            score: 1.02,
            preview: "// Context is the single source of truth for effective ignore rules.",
            span: { startLine: 553, endLine: 559 },
        }),
        group({
            file: "packages/cli/src/install.ts",
            displayLabel: "function prepareClaudeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand)",
            symbolKind: "function",
            score: 0.99,
            preview: "function prepareClaudeInstall(...) {",
            span: { startLine: 750, endLine: 792 },
        }),
    ];

    sortGroupedSearchResults(results, false);
    assert.equal(results[0].symbolKind, "function");
    assert.match(results[0].displayLabel, /prepareClaudeInstall/);
});

test("sortGroupedSearchResults keeps clear higher score even for mega-class", () => {
    const results: Sortable[] = [
        group({
            file: "a.ts",
            displayLabel: "class Big",
            symbolKind: "class",
            score: 0.95,
            span: { startLine: 1, endLine: 2000 },
        }),
        group({
            file: "b.ts",
            displayLabel: "function small()",
            symbolKind: "function",
            score: 0.5,
            span: { startLine: 1, endLine: 5 },
        }),
    ];

    sortGroupedSearchResults(results, false);
    assert.equal(results[0].displayLabel, "class Big");
});

test("sortGroupedSearchResults still pins exact lexical match over near-tie preference", () => {
    const results: Sortable[] = [
        group({
            file: "a.ts",
            displayLabel: "function preferred()",
            symbolKind: "function",
            score: 0.8,
            span: { startLine: 1, endLine: 5 },
        }),
        {
            ...group({
                file: "b.ts",
                displayLabel: "class ExactHit",
                symbolKind: "class",
                score: 0.2,
                span: { startLine: 1, endLine: 500 },
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
    assert.equal(results[0].displayLabel, "class ExactHit");
    assert.equal(results[0].debug?.provenance?.exactMatchPinned, true);
});

test("collapseDuplicateDeclarationGroups keeps tighter near-tie winner", () => {
    const groups = [
        group({
            file: "a.ts",
            displayLabel: "function foo()",
            symbolKind: "function",
            __symbolKey: "k1",
            score: 0.8,
            span: { startLine: 1, endLine: 40 },
        }),
        group({
            file: "a.ts",
            displayLabel: "function foo()",
            symbolKind: "function",
            __symbolKey: "k1",
            score: 0.79,
            span: { startLine: 1, endLine: 5 },
        }),
    ];

    const collapsed = collapseDuplicateDeclarationGroups(groups);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].target.span.endLine, 5);
});
