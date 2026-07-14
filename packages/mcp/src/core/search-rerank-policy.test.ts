import assert from "node:assert/strict";
import test from "node:test";
import type { PathCategory } from "./search-constants.js";
import {
    selectRerankCandidates,
    type RerankCandidateLike,
} from "./search-rerank-policy.js";

type TestCandidate = RerankCandidateLike & {
    id: string;
    score: number;
};

function candidate(input: {
    id: string;
    score?: number;
    ownerInstanceId?: string;
    ownerKey?: string;
    exact?: boolean;
    pathCategory?: PathCategory;
    retrievalPasses?: string[];
    startLine?: number;
    relativePath?: string;
    content?: string;
}): TestCandidate {
    const startLine = input.startLine ?? 1;
    return {
        id: input.id,
        score: input.score ?? 1,
        result: {
            relativePath: input.relativePath ?? `src/${input.id}.ts`,
            startLine,
            endLine: startLine + 2,
            language: "typescript",
            content: input.content ?? `export function ${input.id}() {}`,
            symbolLabel: input.id,
            symbolKind: "function",
            breadcrumbs: [`function ${input.id}()`],
            ...(input.ownerInstanceId ? { ownerSymbolInstanceId: input.ownerInstanceId } : {}),
            ...(input.ownerKey ? { ownerSymbolKey: input.ownerKey } : {}),
        },
        pathCategory: input.pathCategory ?? "srcRuntime",
        exactLexicalMatch: input.exact ?? false,
        retrievalPasses: input.retrievalPasses ?? ["primary"],
    };
}

function rank(candidates: TestCandidate[]): TestCandidate[] {
    return [...candidates].sort((left, right) => (
        right.score - left.score
        || left.result.relativePath.localeCompare(right.result.relativePath)
        || (left.result.startLine ?? 0) - (right.result.startLine ?? 0)
    ));
}

test("rerank selection gives distinct owners priority and retains bounded supplemental chunks", () => {
    const selected = selectRerankCandidates({
        requestedLimit: 2,
        candidates: [
            candidate({ id: "owner-a-primary", ownerInstanceId: "owner-a", score: 10 }),
            candidate({ id: "owner-a-duplicate", ownerInstanceId: "owner-a", score: 9 }),
            candidate({ id: "owner-b-primary", ownerInstanceId: "owner-b", score: 8 }),
            candidate({ id: "owner-a-exact", ownerInstanceId: "owner-a", exact: true, score: 7 }),
            candidate({ id: "owner-b-duplicate", ownerInstanceId: "owner-b", score: 6 }),
        ],
    });

    assert.deepEqual(selected.selected.map(({ id }) => id), [
        "owner-a-primary",
        "owner-b-primary",
        "owner-a-duplicate",
        "owner-b-duplicate",
    ]);
    assert.equal(selected.familyCount, 2);
    assert.equal(selected.supplementalCandidateCount, 3);
    assert.equal(selected.candidatePoolCount, 5);
    assert.equal(selected.budgetReason, "family_ambiguity");
});

test("rerank selection preserves a later query-relevant chunk from a split owner", () => {
    const selected = selectRerankCandidates({
        requestedLimit: 2,
        candidates: [
            candidate({
                id: "long-owner-declaration",
                ownerInstanceId: "long-owner",
                relativePath: "src/long-owner.ts",
                startLine: 1,
                score: 10,
                content: "export function executeSearch() {",
            }),
            candidate({
                id: "competing-owner",
                ownerInstanceId: "competing-owner",
                score: 9,
                content: "export function retrySearch() { return genericRetry(); }",
            }),
            candidate({
                id: "long-owner-relevant-body",
                ownerInstanceId: "long-owner",
                relativePath: "src/long-owner.ts",
                startLine: 31,
                score: 8,
                content: "if (partialRetrievalFailure) retryWithExpandedEvidence();",
            }),
            candidate({
                id: "long-owner-tail",
                ownerInstanceId: "long-owner",
                relativePath: "src/long-owner.ts",
                startLine: 61,
                score: 7,
                content: "return finalizeSearchResults();",
            }),
        ],
    });

    assert.equal(
        selected.selected.some(({ result }) => result.content?.includes("retryWithExpandedEvidence")),
        true,
        "the reranker must receive the only chunk containing the query-relevant behavior",
    );
});

test("rerank selection preserves a relevant third chunk from the same owner", () => {
    const selected = selectRerankCandidates({
        requestedLimit: 2,
        candidates: [
            candidate({
                id: "long-owner-declaration",
                ownerInstanceId: "long-owner",
                relativePath: "src/long-owner.ts",
                startLine: 1,
                score: 10,
                content: "export function executeSearch() {",
            }),
            candidate({
                id: "long-owner-generic-body",
                ownerInstanceId: "long-owner",
                relativePath: "src/long-owner.ts",
                startLine: 31,
                score: 9,
                content: "const candidates = await loadCandidates();",
            }),
            candidate({
                id: "competing-owner",
                ownerInstanceId: "competing-owner",
                score: 8,
                content: "export function retrySearch() { return genericRetry(); }",
            }),
            candidate({
                id: "long-owner-relevant-body",
                ownerInstanceId: "long-owner",
                relativePath: "src/long-owner.ts",
                startLine: 61,
                score: 7,
                content: "if (partialRetrievalFailure) retryWithExpandedEvidence();",
            }),
        ],
    });

    assert.equal(
        selected.selected.some(({ result }) => result.content?.includes("retryWithExpandedEvidence")),
        true,
        "the reranker must receive relevant evidence beyond the first supplemental owner chunk",
    );
});

test("rerank selection never guesses a family when owner metadata is missing", () => {
    const selected = selectRerankCandidates({
        requestedLimit: 1,
        candidates: [
            candidate({ id: "unknown-a", startLine: 1 }),
            candidate({ id: "unknown-b", startLine: 1 }),
            candidate({ id: "unknown-c", startLine: 1 }),
        ],
    });

    assert.deepEqual(selected.selected.map(({ id }) => id), ["unknown-a", "unknown-b", "unknown-c"]);
    assert.equal(selected.familyCount, 3);
    assert.equal(selected.supplementalCandidateCount, 0);
});

test("rerank selection applies an adaptive family budget", () => {
    const candidates = Array.from({ length: 30 }, (_, index) => candidate({
        id: `candidate-${String(index).padStart(2, "0")}`,
        ownerInstanceId: `owner-${index}`,
        score: 30 - index,
    }));

    const narrow = selectRerankCandidates({ candidates, requestedLimit: 2 });
    assert.equal(narrow.selected.length, 12);
    assert.equal(narrow.budget, 12);
    assert.equal(narrow.budgetReason, "family_ambiguity");

    const broad = selectRerankCandidates({ candidates, requestedLimit: 10 });
    assert.equal(broad.selected.length, 30);
    assert.equal(broad.budgetReason, "complete_family_pool");
});

test("rerank selection remains stable after shuffled provider rows are deterministically scored", () => {
    const candidates = [
        candidate({ id: "alpha", ownerInstanceId: "owner-a", score: 4 }),
        candidate({ id: "alpha-support", ownerInstanceId: "owner-a", exact: true, score: 1 }),
        candidate({ id: "beta", ownerInstanceId: "owner-b", score: 3 }),
        candidate({ id: "gamma", ownerInstanceId: "owner-c", score: 2 }),
    ];
    const forward = selectRerankCandidates({ candidates: rank(candidates), requestedLimit: 2 });
    const shuffled = selectRerankCandidates({
        candidates: rank([candidates[2], candidates[0], candidates[3], candidates[1]]),
        requestedLimit: 2,
    });

    assert.deepEqual(shuffled.selected.map(({ id }) => id), forward.selected.map(({ id }) => id));
});
