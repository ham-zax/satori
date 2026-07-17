import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    compareCandidateScores,
    main,
    scoreBaselineCapture,
    scoreContenderReplay,
} from "./satori-search-candidate-score.mjs";

function replaySignal(candidateId, relativePath, symbolLabel) {
    return {
        candidateId,
        replay: {
            symbolLabel,
            symbolId: `${symbolLabel}-id`,
        },
    };
}

function baselineTask(taskId, queryClass, expected, candidates, selectedIds) {
    return {
        taskId,
        queryClass,
        expected,
        passConfiguration: {
            providerWork: {
                rerankerInputBytes: selectedIds.length * 10,
            },
        },
        candidateTrace: {
            stages: [
                {
                    stage: "mcp_replay_signals",
                    candidates: candidates.map((candidate) => replaySignal(
                        candidate.candidateId,
                        candidate.relativePath,
                        candidate.symbolLabel,
                    )),
                },
                {
                    stage: "mcp_filtered",
                    candidates: candidates.map(({ symbolLabel: _ignored, ...candidate }) => candidate),
                },
                {
                    stage: "reranker_input",
                    candidates: selectedIds.map((candidateId) => ({ candidateId })),
                },
            ],
        },
    };
}

function contenderTask(taskId, queryClass, expected, candidates, selectedIds) {
    return {
        taskId,
        queryClass,
        expected,
        mcpAttempts: [{ candidates }],
        rerankerAdmission: {
            enabled: true,
            selectedCandidateIds: selectedIds,
            inputUtf8Bytes: selectedIds.length * 10,
        },
    };
}

const ownerA = { ownerFile: "src/a.ts", ownerSymbol: "ownerA" };
const ownerB = { ownerFile: "src/b.ts", ownerSymbol: "ownerB" };
const alternative = {
    candidateId: "alt",
    relativePath: "src/other.ts",
    symbolLabel: "other",
    rank: 1,
};
const candidateA = {
    candidateId: "owner-a",
    relativePath: ownerA.ownerFile,
    symbolLabel: `method ${ownerA.ownerSymbol}`,
    rank: 1,
};
const candidateB = {
    candidateId: "owner-b",
    relativePath: ownerB.ownerFile,
    symbolLabel: ownerB.ownerSymbol,
    rank: 1,
};

test("candidate scoring uses frozen file and symbol authority", () => {
    const capture = {
        sha256: "a".repeat(64),
        captures: [
            baselineTask("tuning-owner-a", "owner_discovery", ownerA, [alternative], ["alt"]),
            baselineTask("tuning-owner-b", "exact_identifier", ownerB, [candidateB], ["owner-b"]),
        ],
    };
    const replay = {
        sourceCaptureSha256: capture.sha256,
        baselineReproduced: true,
        policy: { policyId: "contender-a" },
        tasks: [
            contenderTask("tuning-owner-a", "owner_discovery", ownerA, [candidateA], ["owner-a"]),
            contenderTask(
                "tuning-owner-b",
                "exact_identifier",
                ownerB,
                [{ ...alternative }, { ...candidateB, rank: 2 }],
                ["alt", "owner-b"],
            ),
        ],
    };

    const baseline = scoreBaselineCapture(capture, "tuning");
    const contender = scoreContenderReplay(replay, "tuning");
    const comparison = compareCandidateScores(baseline, contender);

    assert.equal(baseline.summary.hardMissCount, 1);
    assert.equal(contender.summary.hardMissCount, 0);
    assert.equal(comparison.ownerSurvivalGain, 1);
    assert.equal(comparison.hardMissDelta, -1);
    assert.deepEqual(comparison.newHardMissTaskIds, []);
    assert.deepEqual(comparison.exactIdentifierRegressionTaskIds, ["tuning-owner-b"]);
    assert.match(baseline.sha256, /^[0-9a-f]{64}$/);
    assert.match(comparison.sha256, /^[0-9a-f]{64}$/);
});

test("exact-registry tasks remain in non-regression checks but outside policy denominators", () => {
    const capture = {
        captures: [{
            taskId: "tuning-owner-b",
            queryClass: "exact_identifier",
            expected: ownerB,
            readiness: { route: "exact_registry" },
            rankedResults: [{ kind: "symbol", file: ownerB.ownerFile, symbol: ownerB.ownerSymbol }],
        }],
    };
    const replay = {
        baselineReproduced: true,
        policy: { policyId: "contender-a" },
        tasks: [{
            taskId: "tuning-owner-b",
            queryClass: "exact_identifier",
            expected: ownerB,
            route: { kind: "exact_registry" },
            rankedResults: [{ kind: "symbol", file: ownerB.ownerFile, symbol: ownerB.ownerSymbol }],
        }],
    };

    const baseline = scoreBaselineCapture(capture, "tuning");
    const contender = scoreContenderReplay(replay, "tuning");
    const comparison = compareCandidateScores(baseline, contender);

    assert.equal(baseline.summary.taskCount, 1);
    assert.equal(baseline.summary.policyApplicableTaskCount, 0);
    assert.equal(baseline.summary.ownerSurvivalCount, 1);
    assert.equal(baseline.summary.policyApplicableOwnerSurvivalCount, 0);
    assert.equal(comparison.ownerSurvivalGain, 0);
    assert.deepEqual(comparison.exactIdentifierRegressionTaskIds, []);
});

test("candidate scoring rejects a replay from another capture", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-score-"));
    try {
        const captureFile = path.join(tempDir, "capture.json");
        const replayFile = path.join(tempDir, "replay.json");
        fs.writeFileSync(captureFile, JSON.stringify({ sha256: "a".repeat(64), captures: [] }));
        fs.writeFileSync(replayFile, JSON.stringify({ sourceCaptureSha256: "b".repeat(64) }));
        assert.throws(
            () => main(["--capture", captureFile, "--replay", replayFile]),
            /not bound to the supplied capture/,
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
