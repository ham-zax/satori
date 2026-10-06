import assert from "node:assert/strict";
import test from "node:test";
import { resolveRerankBoundary } from "./search-rerank-boundary.js";

const candidate = (exactLexicalMatch: boolean, passesMatchedMust = false) => ({
    exactLexicalMatch,
    passesMatchedMust,
});

test("skips a sole exact result", () => {
    assert.deepEqual(resolveRerankBoundary({
        candidates: [candidate(true)],
        exactMatchPinningEnabled: true,
        mustTokenCount: 0,
    }), { kind: "skip", reason: "sole_exact_result" });
});

test("reranks the suffix behind an exact-owned prefix", () => {
    assert.deepEqual(resolveRerankBoundary({
        candidates: [candidate(true), candidate(false), candidate(false)],
        exactMatchPinningEnabled: true,
        mustTokenCount: 0,
    }), { kind: "rerank", startIndex: 1, reason: "exact_prefix" });
    assert.deepEqual(resolveRerankBoundary({
        candidates: [candidate(true, true), candidate(false)],
        exactMatchPinningEnabled: false,
        mustTokenCount: 1,
    }), { kind: "rerank", startIndex: 1, reason: "exact_prefix" });
});

test("must-only matches and lower exact candidates do not own the prefix", () => {
    assert.deepEqual(resolveRerankBoundary({
        candidates: [candidate(false, true), candidate(true)],
        exactMatchPinningEnabled: false,
        mustTokenCount: 1,
    }), { kind: "rerank", startIndex: 0, reason: "full_set" });
    assert.deepEqual(resolveRerankBoundary({
        candidates: [candidate(false), candidate(true)],
        exactMatchPinningEnabled: true,
        mustTokenCount: 0,
    }), { kind: "rerank", startIndex: 0, reason: "full_set" });
});

test("caller alt_terms naming the top owner pin the prefix", () => {
    assert.deepEqual(resolveRerankBoundary({
        candidates: [candidate(false), candidate(false)],
        exactMatchPinningEnabled: false,
        mustTokenCount: 0,
        altTermsNameTopOwner: true,
    }), { kind: "rerank", startIndex: 1, reason: "exact_prefix" });
    assert.deepEqual(resolveRerankBoundary({
        candidates: [candidate(false), candidate(false)],
        exactMatchPinningEnabled: false,
        mustTokenCount: 0,
        altTermsNameTopOwner: false,
    }), { kind: "rerank", startIndex: 0, reason: "full_set" });
});

test("empty input is a no-request full-set decision", () => {
    assert.deepEqual(resolveRerankBoundary({
        candidates: [],
        exactMatchPinningEnabled: true,
        mustTokenCount: 0,
    }), { kind: "rerank", startIndex: 0, reason: "full_set" });
});
