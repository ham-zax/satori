#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./satori-useful-context.mjs";

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);
    return value;
}

function requireString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value;
}

function requireArray(value, label) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    return value;
}

function requireNonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer.`);
    }
    return value;
}

function sha256Canonical(value) {
    return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function taskIsInSplit(taskId, splitPrefix) {
    return splitPrefix === "all" || taskId.startsWith(`${splitPrefix}-`);
}

function replaySignalsByCandidate(taskCapture) {
    const signals = new Map();
    for (const stage of requireArray(taskCapture.candidateTrace?.stages, "Candidate trace stages")) {
        if (stage.stage !== "mcp_replay_signals") continue;
        for (const candidate of requireArray(stage.candidates, "MCP replay signal candidates")) {
            const candidateId = requireString(candidate.candidateId, "MCP replay signal candidateId");
            const replay = requireRecord(candidate.replay, `MCP replay signal '${candidateId}' replay`);
            const next = {
                symbolLabel: replay.symbolLabel ?? null,
                symbolId: replay.symbolId ?? null,
            };
            const prior = signals.get(candidateId);
            if (prior && canonicalJson(prior) !== canonicalJson(next)) {
                throw new Error(`Candidate '${candidateId}' has conflicting symbol replay authority.`);
            }
            signals.set(candidateId, next);
        }
    }
    return signals;
}

function exactRegistryCandidates(taskId, rankedResults) {
    return requireArray(rankedResults, `Task '${taskId}' exact-registry ranked results`)
        .map((result, index) => {
            const identity = requireRecord(result, `Task '${taskId}' exact-registry result ${index + 1}`);
            return {
                candidateId: JSON.stringify([identity.kind, identity.file, identity.symbol ?? null]),
                relativePath: requireString(identity.file, `Task '${taskId}' exact-registry result file`),
                symbolLabel: identity.symbol ?? null,
                rank: index + 1,
            };
        });
}

function baselineTaskView(taskCapture) {
    if (taskCapture.readiness?.route === "exact_registry") {
        return {
            taskId: taskCapture.taskId,
            queryClass: taskCapture.queryClass,
            expected: taskCapture.expected,
            policyApplicable: false,
            candidates: exactRegistryCandidates(taskCapture.taskId, taskCapture.rankedResults),
            reranker: { enabled: false, selectedCandidateIds: [], inputUtf8Bytes: 0 },
        };
    }
    const stages = requireArray(taskCapture.candidateTrace?.stages, "Candidate trace stages");
    const filtered = stages.filter((stage) => stage.stage === "mcp_filtered").at(-1);
    if (!filtered) throw new Error(`Task '${taskCapture.taskId}' has no final MCP filtered stage.`);
    const signals = replaySignalsByCandidate(taskCapture);
    const candidates = requireArray(filtered.candidates, "Final MCP filtered candidates").map(
        (candidate, index) => ({
            ...candidate,
            ...signals.get(candidate.candidateId),
            rank: index + 1,
        }),
    );
    const rerankerStage = stages.find((stage) => stage.stage === "reranker_input");
    const selectedCandidateIds = rerankerStage
        ? requireArray(rerankerStage.candidates, "Reranker input candidates")
            .map((candidate) => requireString(candidate.candidateId, "Reranker input candidateId"))
        : [];
    const providerWork = requireRecord(
        taskCapture.passConfiguration?.providerWork,
        `Task '${taskCapture.taskId}' provider work`,
    );
    return {
        taskId: taskCapture.taskId,
        queryClass: taskCapture.queryClass,
        expected: taskCapture.expected,
        policyApplicable: true,
        candidates,
        reranker: {
            enabled: Boolean(rerankerStage),
            selectedCandidateIds,
            inputUtf8Bytes: requireNonNegativeInteger(
                providerWork.rerankerInputBytes,
                `Task '${taskCapture.taskId}' rerankerInputBytes`,
            ),
        },
    };
}

function contenderTaskView(task) {
    if (task.route?.kind === "exact_registry") {
        return {
            taskId: task.taskId,
            queryClass: task.queryClass,
            expected: task.expected,
            policyApplicable: false,
            candidates: exactRegistryCandidates(task.taskId, task.rankedResults),
            reranker: { enabled: false, selectedCandidateIds: [], inputUtf8Bytes: 0 },
        };
    }
    const attempts = requireArray(task.mcpAttempts, `Task '${task.taskId}' MCP attempts`);
    const finalAttempt = attempts.at(-1);
    if (!finalAttempt) throw new Error(`Task '${task.taskId}' has no MCP attempt.`);
    const reranker = requireRecord(task.rerankerAdmission, `Task '${task.taskId}' reranker admission`);
    return {
        taskId: task.taskId,
        queryClass: task.queryClass,
        expected: task.expected,
        policyApplicable: true,
        candidates: requireArray(finalAttempt.candidates, `Task '${task.taskId}' candidates`),
        reranker: {
            enabled: reranker.enabled === true,
            selectedCandidateIds: requireArray(
                reranker.selectedCandidateIds,
                `Task '${task.taskId}' selectedCandidateIds`,
            ),
            inputUtf8Bytes: requireNonNegativeInteger(
                reranker.inputUtf8Bytes,
                `Task '${task.taskId}' reranker inputUtf8Bytes`,
            ),
        },
    };
}

function canonicalSymbolName(symbolLabel) {
    if (typeof symbolLabel !== "string") return null;
    return symbolLabel.replace(
        /^(?:class|constant|constructor|enum|function|interface|method|property|type|variable)\s+/,
        "",
    );
}

function candidateMatchesExpectedOwner(candidate, expected) {
    return candidate.relativePath === expected.ownerFile
        && canonicalSymbolName(candidate.symbolLabel) === expected.ownerSymbol;
}

function scoreTask(view) {
    const expected = requireRecord(view.expected, `Task '${view.taskId}' expected owner`);
    const candidates = requireArray(view.candidates, `Task '${view.taskId}' candidates`);
    const ownerCandidates = candidates.filter((candidate) => (
        candidateMatchesExpectedOwner(candidate, expected)
    ));
    const ownerCandidateIds = ownerCandidates.map((candidate) => candidate.candidateId);
    const selected = new Set(view.reranker.selectedCandidateIds);
    const localRank = ownerCandidates.length === 0
        ? null
        : Math.min(...ownerCandidates.map((candidate) => candidate.rank));
    const rerankerAdmitted = ownerCandidateIds.some((candidateId) => selected.has(candidateId));
    const hardMiss = localRank === null;
    return {
        taskId: view.taskId,
        queryClass: view.queryClass,
        expected: {
            ownerFile: requireString(expected.ownerFile, "Expected ownerFile"),
            ownerSymbol: requireString(expected.ownerSymbol, "Expected ownerSymbol"),
        },
        policyApplicable: view.policyApplicable,
        localRank,
        hardMiss,
        rerankerEnabled: view.reranker.enabled,
        rerankerAdmitted,
        ownerSurvives: !hardMiss && (!view.reranker.enabled || rerankerAdmitted),
        localCandidateCount: candidates.length,
        rerankerCandidateCount: view.reranker.selectedCandidateIds.length,
        rerankerInputUtf8Bytes: view.reranker.inputUtf8Bytes,
    };
}

function summarizeTasks(tasks, splitPrefix, policyId) {
    const selected = tasks
        .filter((task) => taskIsInSplit(task.taskId, splitPrefix))
        .map(scoreTask);
    if (selected.length === 0) {
        throw new Error(`No tasks match split prefix '${splitPrefix}'.`);
    }
    const summary = {
        taskCount: selected.length,
        policyApplicableTaskCount: selected.filter((task) => task.policyApplicable).length,
        hardMissCount: selected.filter((task) => task.hardMiss).length,
        ownerSurvivalCount: selected.filter((task) => task.ownerSurvives).length,
        ownerTopThreeCount: selected.filter((task) => task.localRank !== null && task.localRank <= 3).length,
        policyApplicableHardMissCount: selected.filter(
            (task) => task.policyApplicable && task.hardMiss,
        ).length,
        policyApplicableOwnerSurvivalCount: selected.filter(
            (task) => task.policyApplicable && task.ownerSurvives,
        ).length,
        policyApplicableOwnerTopThreeCount: selected.filter(
            (task) => task.policyApplicable && task.localRank !== null && task.localRank <= 3,
        ).length,
        rerankerCandidateCount: selected.reduce(
            (total, task) => total + task.rerankerCandidateCount,
            0,
        ),
        rerankerInputUtf8Bytes: selected.reduce(
            (total, task) => total + task.rerankerInputUtf8Bytes,
            0,
        ),
    };
    const scored = {
        version: 1,
        kind: "satori_search_candidate_score",
        policyId,
        splitPrefix,
        summary,
        tasks: selected,
    };
    return { ...scored, sha256: sha256Canonical(scored) };
}

export function scoreBaselineCapture(captureValue, splitPrefix = "all") {
    const capture = requireRecord(captureValue, "Candidate capture");
    const captures = requireArray(capture.captures, "Candidate capture tasks");
    return summarizeTasks(captures.map(baselineTaskView), splitPrefix, "baseline");
}

export function scoreContenderReplay(replayValue, splitPrefix = "all") {
    const replay = requireRecord(replayValue, "Candidate replay");
    if (replay.baselineReproduced !== true) {
        throw new Error("Contender score requires baselineReproduced=true.");
    }
    return summarizeTasks(
        requireArray(replay.tasks, "Candidate replay tasks").map(contenderTaskView),
        splitPrefix,
        requireString(replay.policy?.policyId, "Candidate replay policyId"),
    );
}

export function compareCandidateScores(baseline, contender) {
    if (baseline.splitPrefix !== contender.splitPrefix) {
        throw new Error("Candidate scores must use the same split prefix.");
    }
    const baselineById = new Map(baseline.tasks.map((task) => [task.taskId, task]));
    const contenderById = new Map(contender.tasks.map((task) => [task.taskId, task]));
    if (canonicalJson([...baselineById.keys()].sort()) !== canonicalJson([...contenderById.keys()].sort())) {
        throw new Error("Candidate scores must contain the same task IDs.");
    }
    const newHardMissTaskIds = [];
    const lostOwnerSurvivalTaskIds = [];
    const exactIdentifierRegressionTaskIds = [];
    for (const [taskId, before] of baselineById) {
        const after = contenderById.get(taskId);
        if (!before.hardMiss && after.hardMiss) newHardMissTaskIds.push(taskId);
        if (before.ownerSurvives && !after.ownerSurvives) lostOwnerSurvivalTaskIds.push(taskId);
        if (before.queryClass === "exact_identifier") {
            const rankRegressed = before.localRank !== null
                && (after.localRank === null || after.localRank > before.localRank);
            const admissionRegressed = before.ownerSurvives && !after.ownerSurvives;
            if (rankRegressed || admissionRegressed) exactIdentifierRegressionTaskIds.push(taskId);
        }
    }
    const comparison = {
        version: 1,
        kind: "satori_search_candidate_score_comparison",
        splitPrefix: baseline.splitPrefix,
        baselinePolicyId: baseline.policyId,
        contenderPolicyId: contender.policyId,
        ownerSurvivalGain: contender.summary.policyApplicableOwnerSurvivalCount
            - baseline.summary.policyApplicableOwnerSurvivalCount,
        hardMissDelta: contender.summary.policyApplicableHardMissCount
            - baseline.summary.policyApplicableHardMissCount,
        ownerTopThreeGain: contender.summary.policyApplicableOwnerTopThreeCount
            - baseline.summary.policyApplicableOwnerTopThreeCount,
        rerankerCandidateDelta: contender.summary.rerankerCandidateCount
            - baseline.summary.rerankerCandidateCount,
        rerankerInputUtf8BytesDelta: contender.summary.rerankerInputUtf8Bytes
            - baseline.summary.rerankerInputUtf8Bytes,
        newHardMissTaskIds: newHardMissTaskIds.sort(),
        lostOwnerSurvivalTaskIds: lostOwnerSurvivalTaskIds.sort(),
        exactIdentifierRegressionTaskIds: exactIdentifierRegressionTaskIds.sort(),
    };
    return { ...comparison, sha256: sha256Canonical(comparison) };
}

function usage() {
    return "Usage: node scripts/satori-search-candidate-score.mjs --capture <capture.json> [--replay <replay.json>] [--split-prefix <tuning|validation|all>] [--out <score.json>]";
}

export function main(argv = process.argv.slice(2)) {
    let captureFile;
    let replayFile;
    let splitPrefix = "all";
    let outFile;
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === "--capture") captureFile = path.resolve(argv[++index]);
        else if (argv[index] === "--replay") replayFile = path.resolve(argv[++index]);
        else if (argv[index] === "--split-prefix") splitPrefix = argv[++index];
        else if (argv[index] === "--out") outFile = path.resolve(argv[++index]);
        else if (argv[index] === "--help") {
            process.stdout.write(`${usage()}\n`);
            return null;
        } else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!captureFile) throw new Error("--capture is required.");
    if (!["tuning", "validation", "all"].includes(splitPrefix)) {
        throw new Error("--split-prefix must be tuning, validation, or all.");
    }
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const replay = replayFile
        ? JSON.parse(fs.readFileSync(replayFile, "utf8"))
        : null;
    if (replay && replay.sourceCaptureSha256 !== capture.sha256) {
        throw new Error("Candidate replay is not bound to the supplied capture.");
    }
    const baseline = scoreBaselineCapture(capture, splitPrefix);
    let output = baseline;
    if (replay) {
        const contender = scoreContenderReplay(replay, splitPrefix);
        output = {
            version: 1,
            kind: "satori_search_candidate_scored_comparison",
            baseline,
            contender,
            comparison: compareCandidateScores(baseline, contender),
        };
        output = { ...output, sha256: sha256Canonical(output) };
    }
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (outFile) fs.writeFileSync(outFile, serialized);
    else process.stdout.write(serialized);
    return output;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`satori-search-candidate-score: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        process.exitCode = 1;
    }
}
