import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_EXPANSION_RESERVATION_POLICY,
    isPrimarySearchCandidate,
    reservationCapForPolicy,
    resolveExpansionReservationPolicy,
    reservePrimaryCandidateSlots,
    SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP,
    SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP_WIDE,
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

function pool(primaryCount: number, expansionCount: number): SearchCandidate[] {
    const primaries: SearchCandidate[] = Array.from({ length: primaryCount }, (_, i) =>
        makeCandidate(`src/primary_${i}.ts`, ["primary"], 1 / (primaryCount + i + 1)),
    );
    // Expansion candidates strictly outscore every primary, so a pure
    // score-ordered truncation would drop every primary candidate.
    const expansions: SearchCandidate[] = Array.from({ length: expansionCount }, (_, i) =>
        makeCandidate(`src/expansion_${i}.ts`, ["expanded"], 2 / (expansionCount + i + 1)),
    );
    return [...primaries, ...expansions];
}

test("unknown or absent policy input stays on the default", () => {
    assert.equal(resolveExpansionReservationPolicy(undefined), "cap55");
    assert.equal(resolveExpansionReservationPolicy(null), "cap55");
    assert.equal(resolveExpansionReservationPolicy("bogus"), "cap55");
    assert.equal(resolveExpansionReservationPolicy(""), "cap55");
    assert.equal(DEFAULT_EXPANSION_RESERVATION_POLICY, "cap55");
});

test("each named policy resolves to itself", () => {
    assert.equal(resolveExpansionReservationPolicy("cap55"), "cap55");
    assert.equal(resolveExpansionReservationPolicy("cap64"), "cap64");
    assert.equal(resolveExpansionReservationPolicy("off"), "off");
});

test("each policy maps to its literal cap", () => {
    assert.equal(reservationCapForPolicy("cap55"), SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP);
    assert.equal(reservationCapForPolicy("cap64"), SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP_WIDE);
    assert.equal(reservationCapForPolicy("off"), 0);
    assert.equal(SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP_WIDE, 64);
});

test("the default call is byte-identical to an explicit cap55 call", () => {
    const candidates = pool(60, 80);
    const candidateLimit = 80;
    // A synthetic set where the reservation is load-bearing: without it every
    // primary would be crowded out, so any behavioral drift shows up here.
    assert.deepEqual(
        reservePrimaryCandidateSlots(candidates, candidateLimit).map((c) => c.result.relativePath),
        reservePrimaryCandidateSlots(candidates, candidateLimit, "cap55").map((c) => c.result.relativePath),
    );
});

test("cap55 and cap64 scale their primary share within a small budget", () => {
    const candidates = pool(100, 80).sort((a, b) => b.fusionScore - a.fusionScore);
    for (const [policy, expectedPrimary] of [["cap55", 22], ["cap64", 25]] as const) {
        const reserved = reservePrimaryCandidateSlots(candidates, 32, policy);
        assert.equal(reserved.length, 32);
        assert.equal(reserved.filter(isPrimarySearchCandidate).length, expectedPrimary);
        assert.equal(reserved.filter((c) => !isPrimarySearchCandidate(c)).length, 32 - expectedPrimary);
    }
});

test("off keeps the fused prefix within the same candidate budget", () => {
    const candidates = pool(60, 80).sort((a, b) => b.fusionScore - a.fusionScore);
    for (const budget of [32, 48, 64, 80]) {
        assert.deepEqual(reservePrimaryCandidateSlots(candidates, budget, "off"), candidates.slice(0, budget));
    }
});
