import test from "node:test";
import assert from "node:assert/strict";
import {
    collapseDuplicateDeclarationGroups,
    sortNativeGroupedSearchResults,
} from "./search-group-ordering.js";
import { applyGroupDiversity } from "./search-grouping.js";
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
        quality: { owner: "medium", semantic: "medium" },
        preview: partial.preview || partial.displayLabel,
        navigation: { graph: "missing_symbol" },
        __groupId: partial.__groupId || `grp_${partial.file}_${partial.displayLabel}`,
        __candidateIds: partial.__candidateIds || [`candidate_${partial.file}_${span.startLine}_${span.endLine}`],
        ...(partial.__symbolKey ? { __symbolKey: partial.__symbolKey } : {}),
        ...(partial.__symbolInstanceId ? { __symbolInstanceId: partial.__symbolInstanceId } : {}),
        __exactLexicalMatch: partial.__exactLexicalMatch || false,
        ...(partial.__authoritativeRank !== undefined
            ? { __authoritativeRank: partial.__authoritativeRank }
            : {}),
    };
}

test("native grouped ordering follows authoritative rank instead of score", () => {
    const results: Sortable[] = [
        group({
            file: "score-first.ts",
            displayLabel: "class ScoreFirst",
            symbolKind: "class",
            score: 0.99,
            __authoritativeRank: 4,
        }),
        group({
            file: "provider-first.ts",
            displayLabel: "function ProviderFirst()",
            symbolKind: "function",
            score: 0.10,
            __authoritativeRank: 1,
        }),
    ];

    sortNativeGroupedSearchResults(results, false);
    assert.deepEqual(results.map((result) => result.target.file), [
        "provider-first.ts",
        "score-first.ts",
    ]);
});

test("exact ownership remains a deterministic grouped control", () => {
    const results: Sortable[] = [
        group({
            file: "ordinary.ts",
            displayLabel: "function ordinary()",
            score: 0.99,
            __authoritativeRank: 1,
        }),
        group({
            file: "exact.ts",
            displayLabel: "function Exact()",
            score: 0.01,
            __authoritativeRank: 2,
            __exactLexicalMatch: true,
        }),
    ];

    const applied = sortNativeGroupedSearchResults(results, true);
    assert.equal(applied, true);
    assert.equal(results[0].target.file, "exact.ts");
});

test("native grouped ordering does not repin a lower-ranked exact group", () => {
    const results: Sortable[] = [
        group({
            file: "provider.ts",
            displayLabel: "function Provider()",
            score: 0.01,
            __authoritativeRank: 1,
        }),
        group({
            file: "exact.ts",
            displayLabel: "function Exact()",
            score: 0.99,
            __authoritativeRank: 2,
            __exactLexicalMatch: true,
        }),
    ];

    const applied = sortNativeGroupedSearchResults(results, true, "reranker_order");
    assert.equal(applied, false);
    assert.deepEqual(results.map((result) => result.target.file), [
        "provider.ts",
        "exact.ts",
    ]);
});

test("diversity omissions preserve the authoritative sequence across relaxed passes", () => {
    const results: Sortable[] = [
        group({ file: "file-1.ts", displayLabel: "function A()", score: 1, __groupId: "a" }),
        group({ file: "file-1.ts", displayLabel: "function B()", score: 1, __groupId: "b" }),
        group({ file: "file-1.ts", displayLabel: "function C()", score: 1, __groupId: "c" }),
        group({ file: "file-2.ts", displayLabel: "function D()", score: 1, __groupId: "d" }),
    ];

    const applied = applyGroupDiversity(results, results.length, "file");
    assert.deepEqual(applied.selected.map((result) => result.__groupId), ["a", "b", "c", "d"]);
});

test("symbol diversity admits one complementary executable owner without becoming rank authority", () => {
    const results: Sortable[] = [
        group({ file: "a.ts", displayLabel: "function First()", symbolKind: "function", score: 0.9, __groupId: "a1", __symbolInstanceId: "owner-a1" }),
        group({ file: "a.ts", displayLabel: "function Second()", symbolKind: "function", score: 0.8, __groupId: "a2", __symbolInstanceId: "owner-a2" }),
        group({ file: "a.ts", displayLabel: "function Third()", symbolKind: "function", score: 0.01, __groupId: "a3", __symbolInstanceId: "owner-a3" }),
        group({ file: "a.ts", displayLabel: "function Fourth()", symbolKind: "function", score: 1, __groupId: "a4", __symbolInstanceId: "owner-a4" }),
        group({ file: "b.ts", displayLabel: "function B()", symbolKind: "function", score: 0.7, __groupId: "b", __symbolInstanceId: "owner-b" }),
        group({ file: "c.ts", displayLabel: "function C()", symbolKind: "function", score: 0.6, __groupId: "c", __symbolInstanceId: "owner-c" }),
    ];

    const applied = applyGroupDiversity(results, 5, "symbol");

    assert.deepEqual(applied.selected.map((result) => result.__groupId), ["a1", "a2", "a3", "b", "c"]);
    assert.equal(applied.selected.filter((result) => result.target.file === "a.ts").length, 3);
    assert.equal(applied.summary.usedRelaxedCap, false);
    assert.equal(applied.summary.usedComplementaryOwnerSlot, true);
    assert.equal(
        applied.omitted.find(({ group: omitted }) => omitted.__groupId === "a4")?.reason,
        "file_diversity_cap",
    );
});

test("eligible complementary owner omitted by the visible limit is not mislabeled as file-capped", () => {
    const results: Sortable[] = [
        group({ file: "a.ts", displayLabel: "function First()", symbolKind: "function", score: 1, __groupId: "a1", __symbolInstanceId: "owner-a1" }),
        group({ file: "a.ts", displayLabel: "function Second()", symbolKind: "function", score: 0.9, __groupId: "a2", __symbolInstanceId: "owner-a2" }),
        group({ file: "b.ts", displayLabel: "function B()", symbolKind: "function", score: 0.8, __groupId: "b", __symbolInstanceId: "owner-b" }),
        group({ file: "a.ts", displayLabel: "function Third()", symbolKind: "function", score: 0.7, __groupId: "a3", __symbolInstanceId: "owner-a3" }),
    ];

    const applied = applyGroupDiversity(results, 3, "symbol");

    assert.deepEqual(applied.selected.map((result) => result.__groupId), ["a1", "a2", "b"]);
    assert.equal(applied.summary.usedComplementaryOwnerSlot, false);
    assert.equal(
        applied.omitted.find(({ group: omitted }) => omitted.__groupId === "a3")?.reason,
        "visible_limit",
    );
});

test("complementary owner slot rejects duplicate owners and still prevents file flooding", () => {
    const results: Sortable[] = [
        group({ file: "dup.ts", displayLabel: "function Shared()", symbolKind: "function", score: 1, __groupId: "dup-1", __symbolInstanceId: "shared-owner" }),
        group({ file: "dup.ts", displayLabel: "function SharedAgain()", symbolKind: "function", score: 0.99, __groupId: "dup-2", __symbolInstanceId: "shared-owner" }),
        group({ file: "a.ts", displayLabel: "function First()", symbolKind: "function", score: 0.9, __groupId: "a1", __symbolInstanceId: "owner-a1" }),
        group({ file: "a.ts", displayLabel: "function Second()", symbolKind: "function", score: 0.8, __groupId: "a2", __symbolInstanceId: "owner-a2" }),
        group({ file: "a.ts", displayLabel: "function Third()", symbolKind: "function", score: 0.7, __groupId: "a3", __symbolInstanceId: "owner-a3" }),
        group({ file: "a.ts", displayLabel: "function Fourth()", symbolKind: "function", score: 0.6, __groupId: "a4", __symbolInstanceId: "owner-a4" }),
        group({ file: "b.ts", displayLabel: "function B()", symbolKind: "function", score: 0.5, __groupId: "b", __symbolInstanceId: "owner-b" }),
    ];

    const applied = applyGroupDiversity(results, 5, "symbol");

    assert.deepEqual(applied.selected.map((result) => result.__groupId), ["dup-1", "a1", "a2", "a3", "b"]);
    assert.equal(applied.selected.length, 5);
    assert.equal(applied.selected.filter((result) => result.target.file === "a.ts").length, 3);
    assert.equal(
        applied.omitted.find(({ group: omitted }) => omitted.__groupId === "dup-2")?.reason,
        "symbol_diversity_cap",
    );
    assert.equal(
        applied.omitted.find(({ group: omitted }) => omitted.__groupId === "a4")?.reason,
        "file_diversity_cap",
    );
});

test("non-executable third sibling remains capped when diverse files can fill the limit", () => {
    const results: Sortable[] = [
        group({ file: "a.ts", displayLabel: "property first", symbolKind: "property", score: 1, __groupId: "a1", __symbolInstanceId: "owner-a1" }),
        group({ file: "a.ts", displayLabel: "property second", symbolKind: "property", score: 0.9, __groupId: "a2", __symbolInstanceId: "owner-a2" }),
        group({ file: "a.ts", displayLabel: "property third", symbolKind: "property", score: 0.8, __groupId: "a3", __symbolInstanceId: "owner-a3" }),
        group({ file: "b.ts", displayLabel: "function B()", symbolKind: "function", score: 0.7, __groupId: "b", __symbolInstanceId: "owner-b" }),
        group({ file: "c.ts", displayLabel: "function C()", symbolKind: "function", score: 0.6, __groupId: "c", __symbolInstanceId: "owner-c" }),
        group({ file: "d.ts", displayLabel: "function D()", symbolKind: "function", score: 0.5, __groupId: "d", __symbolInstanceId: "owner-d" }),
    ];

    const applied = applyGroupDiversity(results, 5, "symbol");

    assert.deepEqual(applied.selected.map((result) => result.__groupId), ["a1", "a2", "b", "c", "d"]);
    assert.equal(applied.summary.usedRelaxedCap, false);
    assert.equal(
        applied.omitted.find(({ group: omitted }) => omitted.__groupId === "a3")?.reason,
        "file_diversity_cap",
    );
});

test("native duplicate declaration collapse keeps the earliest authoritative group", () => {
    const groups = [
        group({
            file: "a.ts",
            displayLabel: "function foo()",
            symbolKind: "function",
            __symbolKey: "k1",
            score: 0.99,
            __authoritativeRank: 8,
        }),
        group({
            file: "a.ts",
            displayLabel: "function foo()",
            symbolKind: "function",
            __symbolKey: "k1",
            score: 0.01,
            __authoritativeRank: 2,
        }),
    ];

    const collapsed = collapseDuplicateDeclarationGroups(groups);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].__authoritativeRank, 2);
});
