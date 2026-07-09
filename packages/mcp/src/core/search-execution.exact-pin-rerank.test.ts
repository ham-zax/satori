import test from "node:test";
import assert from "node:assert/strict";
import { shouldSkipRerankForExactPin } from "./search-execution.js";

test("shouldSkipRerankForExactPin when exactMatchPinning owns top exact hit", () => {
    assert.equal(shouldSkipRerankForExactPin({
        scored: [
            { exactLexicalMatch: true, passesMatchedMust: false },
            { exactLexicalMatch: false, passesMatchedMust: false },
        ],
        exactMatchPinningEnabled: true,
        mustTokenCount: 0,
    }), true);
});

test("shouldSkipRerankForExactPin when must: top is exact and matched", () => {
    assert.equal(shouldSkipRerankForExactPin({
        scored: [
            { exactLexicalMatch: true, passesMatchedMust: true },
            { exactLexicalMatch: false, passesMatchedMust: false },
        ],
        exactMatchPinningEnabled: false,
        mustTokenCount: 1,
    }), true);
});

test("shouldSkipRerankForExactPin for sole exact lexical candidate", () => {
    assert.equal(shouldSkipRerankForExactPin({
        scored: [{ exactLexicalMatch: true, passesMatchedMust: false }],
        exactMatchPinningEnabled: false,
        mustTokenCount: 0,
    }), true);
});

test("shouldSkipRerankForExactPin does not skip mixed non-exact top", () => {
    assert.equal(shouldSkipRerankForExactPin({
        scored: [
            { exactLexicalMatch: false, passesMatchedMust: true },
            { exactLexicalMatch: true, passesMatchedMust: true },
        ],
        exactMatchPinningEnabled: true,
        mustTokenCount: 1,
    }), false);
});

test("shouldSkipRerankForExactPin does not skip empty scored", () => {
    assert.equal(shouldSkipRerankForExactPin({
        scored: [],
        exactMatchPinningEnabled: true,
        mustTokenCount: 0,
    }), false);
});

test("shouldSkipRerankForExactPin documents cost tradeoff: exact top skips whole tail rerank", () => {
    // Product policy: when rank-1 is exact-pinned, we spend zero rerank budget on reordering 2..N.
    assert.equal(shouldSkipRerankForExactPin({
        scored: [
            { exactLexicalMatch: true, passesMatchedMust: true },
            { exactLexicalMatch: false, passesMatchedMust: false },
            { exactLexicalMatch: false, passesMatchedMust: false },
        ],
        exactMatchPinningEnabled: true,
        mustTokenCount: 0,
    }), true);
});
