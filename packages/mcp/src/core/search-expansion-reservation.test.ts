import assert from "node:assert/strict";
import test from "node:test";
import {
    isPrimarySearchCandidate,
    reservePrimaryCandidateSlots,
    SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP,
} from "./search-expansion-reservation.js";
import type { SearchCandidate } from "./search-execution.js";

function makeCandidate(
    relativePath: string,
    retrievalPasses: string[],
    fusionScore: number,
): SearchCandidate {
    return {
        result: {
            relativePath,
            startLine: 1,
            endLine: 10,
            language: "typescript",
            content: "export function f() {}",
            score: fusionScore,
            symbolLabel: "function f()",
        },
        baseScore: fusionScore,
        backendScore: fusionScore,
        backendScoreKind: "semantic",
        backendScoreKindsSeen: ["semantic"],
        fusionScore,
        lexicalScore: 0,
        finalScore: 0,
        pathCategory: "neutral",
        pathMultiplier: 1.0,
        changedFilesMultiplier: 1.0,
        agentFitMultiplier: 1,
        agentFitReason: "neutral",
        entrypointOwnerScoreBoost: 0,
        retrievalPasses,
        passesMatchedMust: false,
        exactLexicalMatch: false,
        exactMatchPinned: false,
        rerankerApplied: false,
        lexicalArm: null,
        denseArm: null,
    } as unknown as SearchCandidate;
}

function pool(
    primaryCount: number,
    expansionCount: number,
    candidateLimit: number,
    options: { dualPass?: boolean } = {},
): SearchCandidate[] {
    const primaries: SearchCandidate[] = Array.from({ length: primaryCount }, (_, i) =>
        makeCandidate(
            `src/primary_${i}.ts`,
            options.dualPass ? ["primary", "expanded"] : ["primary"],
            1 / (primaryCount + i + 1),
        ),
    );
    // Expansion candidates are given strictly higher fusion scores so that a
    // pure score-ordered truncation would drop every primary candidate.
    const expansions: SearchCandidate[] = Array.from({ length: expansionCount }, (_, i) =>
        makeCandidate(`src/expansion_${i}.ts`, ["expanded"], 2 / (expansionCount + i + 1)),
    );
    return [...primaries, ...expansions];
}

test("the reservation cap is the exported constant", () => {
    assert.equal(SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP, 55);
});

test("a primary candidate found by both passes counts as primary", () => {
    assert.equal(
        isPrimarySearchCandidate(makeCandidate("src/a.ts", ["primary", "expanded"], 0.5)),
        true,
    );
    assert.equal(isPrimarySearchCandidate(makeCandidate("src/a.ts", ["expanded"], 0.5)), false);
    assert.equal(isPrimarySearchCandidate(makeCandidate("src/a.ts", ["file_symbols"], 0.5)), true);
});

test("pure expansion candidates cannot crowd out primary candidates", () => {
    const candidateLimit = 80;
    const reserved = reservePrimaryCandidateSlots(pool(60, 80, candidateLimit), candidateLimit);

    // The output never exceeds the limit.
    assert.equal(reserved.length, candidateLimit);
    // The reservation is a prefix of the output, and every reserved primary
    // survives despite scoring below every expansion candidate.
    const reservedCount = Math.min(SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP, 60);
    assert.deepEqual(
        reserved.slice(0, reservedCount).map((c) => c.result.relativePath),
        Array.from({ length: reservedCount }, (_, i) => `src/primary_${i}.ts`),
    );
    // The remainder is the leftover budget, filled in input order: the 5
    // unreserved primaries first, then expansion candidates.
    const remainder = reserved.slice(reservedCount);
    assert.equal(remainder.length, candidateLimit - reservedCount);
    assert.deepEqual(
        remainder.slice(0, 5).map((c) => c.result.relativePath),
        Array.from({ length: 5 }, (_, i) => `src/primary_${i + reservedCount}.ts`),
    );
    assert.equal(
        remainder.filter((c) => isPrimarySearchCandidate(c)).length,
        5,
        "only the unreserved primaries may reappear in the remainder",
    );
    assert.equal(
        remainder.filter((c) => !isPrimarySearchCandidate(c)).length,
        candidateLimit - reservedCount - 5,
    );
});

test("the cap, not a literal, decides how many primary candidates are reserved", () => {
    const candidateLimit = 80;
    const reserved = reservePrimaryCandidateSlots(pool(60, 80, candidateLimit), candidateLimit);
    // Read the expected value from the exported constant, so changing the
    // constant fails this assertion rather than being absorbed by a repeated
    // literal in the test body.
    const expectedReserved = Math.min(SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP, 60);
    const firstExpansionIndex = reserved.findIndex((c) => !isPrimarySearchCandidate(c));
    // Everything before the first expansion candidate is the reserved prefix
    // (plus any unreserved primaries that refilled the head of the remainder).
    assert.equal(reserved.slice(0, expectedReserved).every(isPrimarySearchCandidate), true);
    // The reservation is only load-bearing while the primary pool exceeds the
    // cap: with 60 primaries and a cap of 55, five primaries are pushed out of
    // the reserved prefix. If the cap were raised to 60 the whole primary pool
    // would be reserved and the expansion candidates would be fully displaced.
    assert.equal(firstExpansionIndex, expectedReserved + 5);
});

test("small budgets preserve capacity for high-ranking expansion-only candidates", () => {
    for (const [budget, primaryCount] of [[32, 22], [48, 33], [64, 44], [80, 55]]) {
        const candidates = pool(80, 80, budget).sort((a, b) => b.fusionScore - a.fusionScore);
        const reserved = reservePrimaryCandidateSlots(candidates, budget);
        assert.equal(reserved.length, budget);
        assert.equal(reserved.filter(isPrimarySearchCandidate).length, primaryCount);
        assert.equal(reserved.filter((c) => !isPrimarySearchCandidate(c)).length, budget - primaryCount);
    }
});

test("a pool with no pure expansion candidates is returned unchanged", () => {
    const candidates = pool(20, 0, 80);
    const reserved = reservePrimaryCandidateSlots(candidates, 80);
    assert.deepEqual(
        reserved.map((c) => c.result.relativePath),
        candidates.map((c) => c.result.relativePath),
    );
});

test("a pool with no primary candidates is returned unchanged", () => {
    const candidates = pool(0, 20, 80);
    const reserved = reservePrimaryCandidateSlots(candidates, 80);
    assert.deepEqual(
        reserved.map((c) => c.result.relativePath),
        candidates.map((c) => c.result.relativePath),
    );
});

test("a candidate found by both passes is primary and is never duplicated", () => {
    const candidateLimit = 80;
    // 60 candidates each found by BOTH passes, plus 40 pure-expansion ones.
    // A dual-pass candidate must be treated as primary, not counted once as
    // primary and again as expansion.
    const reserved = reservePrimaryCandidateSlots(
        pool(60, 40, candidateLimit, { dualPass: true }),
        candidateLimit,
    );
    const paths = reserved.map((c) => c.result.relativePath);
    assert.equal(new Set(paths).size, paths.length, "no candidate may appear twice");
    assert.equal(reserved.length, candidateLimit);
    const reservedCount = Math.min(SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP, 60);
    assert.equal(
        reserved.filter((c) => isPrimarySearchCandidate(c)).length,
        60,
        "all 60 dual-pass candidates are primary and all fit in the output",
    );
    assert.deepEqual(
        reserved.slice(0, reservedCount).map((c) => c.result.relativePath),
        Array.from({ length: reservedCount }, (_, i) => `src/primary_${i}.ts`),
    );
});

test("single-pass pools obey the same candidate budget", () => {
    const candidates = [
        ...Array.from({ length: 60 }, (_, i) => makeCandidate(`src/a_${i}.ts`, ["primary", "expanded"], 0.5)),
        ...Array.from({ length: 40 }, (_, i) => makeCandidate(`src/b_${i}.ts`, ["file_symbols"], 0.4)),
    ];
    const reserved = reservePrimaryCandidateSlots(candidates, 10);
    assert.deepEqual(reserved, candidates.slice(0, 10));
    const expansions = pool(0, 60, 32);
    assert.deepEqual(reservePrimaryCandidateSlots(expansions, 32), expansions.slice(0, 32));
});

test("the function is pure", () => {
    const candidateLimit = 80;
    const candidates = pool(60, 80, candidateLimit);
    const snapshot = candidates.map((c) => c.result.relativePath);
    const first = reservePrimaryCandidateSlots(candidates, candidateLimit);
    const second = reservePrimaryCandidateSlots(candidates, candidateLimit);
    assert.deepEqual(
        first.map((c) => c.result.relativePath),
        second.map((c) => c.result.relativePath),
    );
    assert.deepEqual(candidates.map((c) => c.result.relativePath), snapshot, "input must not be mutated");
    assert.notEqual(first, candidates, "must return a new array");
});
