import assert from "node:assert/strict";
import test from "node:test";
import {
    appendCoreCandidateTrace,
    appendGroupedCandidateStage,
    appendSearchCandidatePass,
    appendSearchCandidateRemoval,
    appendSearchCandidateStage,
    createSearchCandidateSurvivalTrace,
    searchCandidateIdentity,
} from "./search-candidate-survival.js";
import type { SearchGroupResult } from "./search-types.js";

test("candidate-survival identities distinguish persisted chunks from collision-free derived tuples", () => {
    assert.deepEqual(searchCandidateIdentity({
        candidateId: "stored-1",
        relativePath: "src/a#b.ts",
        startLine: 1,
        endLine: 2,
        language: "typescript",
    }), {
        candidateId: "stored-1",
        candidateIdKind: "persisted",
    });

    const left = searchCandidateIdentity({
        relativePath: "a#b",
        startLine: 1,
        endLine: 2,
        language: "c",
    });
    const right = searchCandidateIdentity({
        relativePath: "a",
        startLine: 1,
        endLine: 2,
        language: "b#c",
    });
    assert.notEqual(left.candidateId, right.candidateId);
    assert.equal(left.candidateIdKind, "derived");
});

test("candidate-survival stages are bounded and never retain source content", () => {
    const trace = createSearchCandidateSurvivalTrace();
    const candidates = Array.from({ length: 170 }, (_, index) => ({
        result: {
            candidateId: `stored-${index}`,
            relativePath: `src/file-${index}.ts`,
            startLine: index + 1,
            endLine: index + 2,
            language: "typescript",
            score: 1 - index / 1000,
            content: `secret-source-${index}`,
        },
        finalScore: 1 - index / 1000,
    }));

    appendSearchCandidateStage(trace, "mcp_ranked", candidates);
    assert.equal(trace.stages[0]?.totalOccurrences, 170);
    assert.equal(trace.stages[0]?.candidates.length, 160);
    assert.equal(trace.stages[0]?.omittedOccurrences, 10);
    assert.equal(JSON.stringify(trace).includes("secret-source"), false);

    for (let index = 0; index < 170; index++) {
        appendSearchCandidateRemoval(trace, {
            candidateId: `stored-${index}`,
            afterStage: "disclosed",
            reason: "visible_limit",
        });
    }
    assert.equal(trace.removals.length, 160);
    assert.equal(trace.omittedRemovals, 10);
});

test("Core trace preservation keeps authoritative unique counts and pass-scoped removals", () => {
    const trace = createSearchCandidateSurvivalTrace();
    appendCoreCandidateTrace(trace, "expanded", {
        schemaVersion: "semantic_search_candidate_trace_v1",
        maxEntriesPerStage: 2,
        productCandidateLimit: 32,
        queryEmbeddingSha256: "b".repeat(64),
        lexicalRequests: [{
            role: "primary",
            querySha256: "c".repeat(64),
            matchMode: "all_terms",
        }],
        stages: [{
            stage: "raw_lexical",
            totalOccurrences: 4,
            uniqueCandidates: 3,
            omittedOccurrences: 2,
            candidates: [{
                candidateId: "stored-1",
                ownerId: '["file","src/a.ts"]',
                evidenceOccurrenceId: '["stored-1","raw_lexical",1]',
                relativePath: "src/a.ts",
                startLine: 1,
                endLine: 2,
                language: "typescript",
                rank: 1,
                score: 0.9,
            }],
        }],
        removals: [{
            candidateId: "stored-2",
            afterStage: "core_fusion",
            reason: "core_fusion_limit",
        }],
        omittedRemovals: 1,
    });

    assert.equal(trace.stages[0]?.uniqueCandidates, 3);
    assert.equal(trace.stages[0]?.passId, "expanded");
    assert.equal(trace.removals[0]?.passId, "expanded");
    assert.deepEqual(trace.queryEmbeddings, [{
        passId: "expanded",
        sha256: "b".repeat(64),
    }]);
    assert.deepEqual(trace.lexicalRequests, [{
        passId: "expanded",
        role: "primary",
        querySha256: "c".repeat(64),
        matchMode: "all_terms",
    }]);
    assert.equal(trace.omittedRemovals, 1);
});

test("grouped and disclosed stages retain underlying candidate identities", () => {
    const trace = createSearchCandidateSurvivalTrace();
    const group = {
        target: { file: "src/owner.ts", span: { startLine: 10, endLine: 20 }, symbolId: "owner-1" },
        displayLabel: "function owner()",
        language: "typescript",
        score: 0.9,
        quality: { owner: "verified", semantic: "high" },
        preview: "function owner()",
        navigation: { graph: "unavailable" },
        __groupId: "owner-1",
        __candidateIds: ["stored-1", 'derived:["src/owner.ts",15,18,"typescript"]'],
        __exactLexicalMatch: false,
    } as SearchGroupResult;

    appendGroupedCandidateStage(trace, "grouped", [group]);
    appendGroupedCandidateStage(trace, "disclosed", [group]);
    assert.deepEqual(
        trace.stages.map((stage) => stage.candidates.map((candidate) => candidate.candidateId)),
        [group.__candidateIds, group.__candidateIds],
    );
});

test("MCP pass membership, weights, and fusion scores remain replayable", () => {
    const trace = createSearchCandidateSurvivalTrace();
    const result = {
        candidateId: "stored-1",
        content: "not retained",
        relativePath: "src/owner.ts",
        startLine: 10,
        endLine: 20,
        language: "typescript",
        score: 0.75,
    };
    appendSearchCandidatePass(trace, [result], "attempt:1/primary", 2);
    appendSearchCandidateStage(trace, "mcp_fusion", [{
        result,
        fusionScore: 0.125,
        finalScore: 0,
    }], "attempt:1");

    assert.equal(trace.stages[0]?.stage, "mcp_pass");
    assert.equal(trace.stages[0]?.weight, 2);
    assert.equal(trace.stages[0]?.candidates[0]?.rank, 1);
    assert.equal(trace.stages[1]?.candidates[0]?.score, 0.125);
    assert.equal(JSON.stringify(trace).includes("not retained"), false);
});
