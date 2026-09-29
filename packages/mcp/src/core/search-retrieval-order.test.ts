import assert from "node:assert/strict";
import test from "node:test";
import { sortNativeRetrievalCandidates } from "./search-retrieval-order.js";

function candidate(input: Partial<{
    path: string;
    score: number;
    must: boolean;
    exact: boolean;
    label: string;
    id: string;
}> = {}) {
    return {
        result: {
            relativePath: input.path ?? "src/a.ts",
            startLine: 1,
            symbolLabel: input.label ?? "run",
            symbolId: input.id ?? input.path ?? "a",
        },
        fusionScore: input.score ?? 0.5,
        passesMatchedMust: input.must ?? false,
        exactLexicalMatch: input.exact ?? false,
        exactMatchPinned: false,
    };
}

test("orders by fusion score", () => {
    const candidates = [
        candidate({ path: "tests/search.test.ts", score: 0.4, label: "test" }),
        candidate({ path: "src/search.ts", score: 0.8, label: "implementation" }),
    ];
    sortNativeRetrievalCandidates(candidates, { exactMatchFirst: false, mustMatchesFirst: false });
    assert.deepEqual(candidates.map((item) => item.result.relativePath), ["src/search.ts", "tests/search.test.ts"]);
});

test("applies must and exact controls before fusion order", () => {
    const mustCandidates = [candidate({ path: "src/no.ts", score: 0.9 }), candidate({ path: "src/must.ts", score: 0.1, must: true })];
    sortNativeRetrievalCandidates(mustCandidates, { exactMatchFirst: false, mustMatchesFirst: true });
    assert.equal(mustCandidates[0]!.result.relativePath, "src/must.ts");

    const exactCandidates = [candidate({ path: "src/no.ts", score: 0.9 }), candidate({ path: "src/exact.ts", score: 0.1, exact: true })];
    const result = sortNativeRetrievalCandidates(exactCandidates, { exactMatchFirst: true, mustMatchesFirst: false });
    assert.equal(exactCandidates[0]!.result.relativePath, "src/exact.ts");
    assert.equal(result.exactMatchPinningApplied, true);
});

test("uses ordinal path, line, label, and identifier tie breakers", () => {
    const candidates = [
        candidate({ path: "src/b.ts", label: "z", id: "2" }),
        candidate({ path: "src/a.ts", label: "z", id: "3" }),
        candidate({ path: "src/a.ts", label: "a", id: "1" }),
    ];
    sortNativeRetrievalCandidates(candidates, { exactMatchFirst: false, mustMatchesFirst: false });
    assert.deepEqual(candidates.map((item) => `${item.result.relativePath}:${item.result.symbolLabel}`), [
        "src/a.ts:a",
        "src/a.ts:z",
        "src/b.ts:z",
    ]);
});
