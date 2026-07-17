#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./satori-useful-context.mjs";

const CORE_RRF_K = 100;
const SCORE_TOLERANCE = 1e-12;
const REPLAY_SCRIPT_PATH = fileURLToPath(import.meta.url);
const CANONICAL_JSON_HELPER_PATH = fileURLToPath(
    new URL("./satori-useful-context.mjs", import.meta.url),
);

function sha256FileArtifact(file, role) {
    const bytes = fs.readFileSync(file);
    return {
        role,
        fileName: path.basename(file),
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
}

const REPLAY_EXECUTABLE_ARTIFACTS = Object.freeze([
    Object.freeze(sha256FileArtifact(REPLAY_SCRIPT_PATH, "replay_executable")),
    Object.freeze(sha256FileArtifact(CANONICAL_JSON_HELPER_PATH, "canonical_json_helper")),
]);

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);
    return value;
}

function requireArray(value, label) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    return value;
}

function requireString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value;
}

function requireSha256(value, label) {
    const normalized = requireString(value, label).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error(`${label} must be a SHA-256 hex digest.`);
    }
    return normalized;
}

function requireExactKeys(value, keys, label) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`${label} must contain exactly: ${expected.join(", ")}.`);
    }
}

function requirePositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer.`);
    }
    return value;
}

function requireNonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer.`);
    }
    return value;
}

function requirePositiveFinite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive finite number.`);
    }
    return value;
}

function requireNonNegativeFinite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a non-negative finite number.`);
    }
    return value;
}

function sha256Canonical(value) {
    return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function buildReplayRuntimeManifest(capture, policyValue, options = {}) {
    const policySourceBytes = options.policySourceBytes === undefined
        ? Buffer.from(policyValue === "baseline" ? "baseline" : canonicalJson(policyValue), "utf8")
        : Buffer.from(options.policySourceBytes);
    if (policyValue !== "baseline" && options.policySourceBytes !== undefined) {
        let parsedPolicySource;
        try {
            parsedPolicySource = JSON.parse(policySourceBytes.toString("utf8"));
        } catch {
            throw new Error("Replay policy source bytes must contain valid JSON.");
        }
        if (canonicalJson(parsedPolicySource) !== canonicalJson(policyValue)) {
            throw new Error("Replay policy source bytes do not match the replay policy.");
        }
    }
    const policySource = {
        kind: options.policySourceBytes === undefined ? "canonical_inline" : "file_bytes",
        ...(options.policySourceFileName
            ? { fileName: path.basename(options.policySourceFileName) }
            : {}),
        bytes: policySourceBytes.length,
        sha256: crypto.createHash("sha256").update(policySourceBytes).digest("hex"),
    };
    const manifest = {
        schemaVersion: 1,
        measuredRuntimeSha256: requireSha256(
            capture.authority?.runtimeSha256,
            "Candidate capture runtimeSha256",
        ),
        node: {
            version: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        artifacts: REPLAY_EXECUTABLE_ARTIFACTS.map((artifact) => ({ ...artifact })),
        policySource,
    };
    return { ...manifest, sha256: sha256Canonical(manifest) };
}

function requireCompleteStage(stage, label) {
    const record = requireRecord(stage, label);
    if (!Array.isArray(record.candidates)) throw new Error(`${label}.candidates must be an array.`);
    if (record.omittedOccurrences !== 0 || record.totalOccurrences !== record.candidates.length) {
        throw new Error(`${label} is truncated and cannot be replayed.`);
    }
    return record;
}

function compareCandidateIdentity(left, right) {
    return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0;
}

function assertSameCandidatePayload(left, right, label) {
    const identity = (candidate) => ({
        candidateId: candidate.candidateId,
        ownerId: candidate.ownerId,
        relativePath: candidate.relativePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        language: candidate.language,
    });
    if (canonicalJson(identity(left)) !== canonicalJson(identity(right))) {
        throw new Error(`${label} contains conflicting payloads for candidate '${left.candidateId}'.`);
    }
}

function compactRankedArm(stage, label) {
    const seen = new Map();
    const ranked = [];
    for (const rawCandidate of requireCompleteStage(stage, label).candidates) {
        const candidate = requireRecord(rawCandidate, `${label} candidate`);
        requireString(candidate.candidateId, `${label} candidateId`);
        const prior = seen.get(candidate.candidateId);
        if (prior) {
            assertSameCandidatePayload(prior, candidate, label);
            continue;
        }
        seen.set(candidate.candidateId, candidate);
        ranked.push(candidate);
    }
    return ranked;
}

export function orderCapturedCoreArm(stage, depth, label = "Captured Core arm") {
    const candidates = requireCompleteStage(stage, label).candidates
        .slice(0, requirePositiveInteger(depth, `${label} depth`))
        .map((rawCandidate) => {
            const candidate = requireRecord(rawCandidate, `${label} candidate`);
            requireString(candidate.candidateId, `${label} candidateId`);
            if (typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) {
                throw new Error(`${label} candidate '${candidate.candidateId}' has no finite score.`);
            }
            return candidate;
        })
        .sort((left, right) => (
            right.score - left.score || compareCandidateIdentity(left, right)
        ));
    const seen = new Map();
    const ranked = [];
    for (const candidate of candidates) {
        const prior = seen.get(candidate.candidateId);
        if (prior) {
            assertSameCandidatePayload(prior, candidate, label);
            continue;
        }
        seen.set(candidate.candidateId, candidate);
        ranked.push(candidate);
    }
    return ranked;
}

function replayCoreFusion(denseStage, lexicalStage, limit, label) {
    const byId = new Map();
    const addArm = (stage, armLabel) => {
        if (!stage) return;
        const candidates = orderCapturedCoreArm(stage, limit, `${label} ${armLabel}`);
        candidates.forEach((candidate, index) => {
            const score = 1 / (CORE_RRF_K + index + 1);
            const existing = byId.get(candidate.candidateId);
            if (existing) {
                assertSameCandidatePayload(existing.candidate, candidate, label);
                existing.score += score;
            } else {
                byId.set(candidate.candidateId, { candidate, score });
            }
        });
    };
    addArm(denseStage, "dense");
    addArm(lexicalStage, "lexical");
    return [...byId.values()]
        .sort((left, right) => right.score - left.score || compareCandidateIdentity(
            left.candidate,
            right.candidate,
        ))
        .slice(0, limit);
}

function normalizeReplayPolicy(value) {
    const policy = requireRecord(value, "Replay policy");
    requireExactKeys(policy, ["version", "kind", "policyId", "core", "mcp"], "Replay policy");
    if (policy.version !== 1 || policy.kind !== "satori_search_candidate_policy") {
        throw new Error("Replay policy version or kind is unsupported.");
    }
    const policyId = requireString(policy.policyId, "Replay policy policyId");
    if (policyId === "baseline") {
        throw new Error("A contender policy must not use the reserved policyId 'baseline'.");
    }
    const core = requireRecord(policy.core, "Replay policy core");
    requireExactKeys(
        core,
        ["candidateDepth", "rrfK", "weights", "minimums", "fallback"],
        "Replay policy core",
    );
    const candidateDepth = requirePositiveInteger(core.candidateDepth, "Replay policy candidateDepth");
    if (![80, 120, 160].includes(candidateDepth)) {
        throw new Error("Replay policy candidateDepth must be one of 80, 120, or 160.");
    }
    const weights = requireRecord(core.weights, "Replay policy core.weights");
    const minimums = requireRecord(core.minimums, "Replay policy core.minimums");
    const sourceNames = ["dense", "preciseLexical", "fallbackLexical"];
    requireExactKeys(weights, sourceNames, "Replay policy core.weights");
    requireExactKeys(minimums, sourceNames, "Replay policy core.minimums");
    const normalizedWeights = Object.fromEntries(sourceNames.map((name) => [
        name,
        requirePositiveFinite(weights[name], `Replay policy core.weights.${name}`),
    ]));
    const normalizedMinimums = Object.fromEntries(sourceNames.map((name) => [
        name,
        requireNonNegativeInteger(minimums[name], `Replay policy core.minimums.${name}`),
    ]));
    if (Object.values(normalizedMinimums).reduce((total, count) => total + count, 0) > candidateDepth) {
        throw new Error("Replay policy source minimums must not exceed candidateDepth in total.");
    }
    const fallback = requireRecord(core.fallback, "Replay policy core.fallback");
    requireExactKeys(
        fallback,
        ["enabled", "preciseUniqueCountBelow"],
        "Replay policy core.fallback",
    );
    if (typeof fallback.enabled !== "boolean") {
        throw new Error("Replay policy core.fallback.enabled must be boolean.");
    }
    if (!fallback.enabled && normalizedMinimums.fallbackLexical !== 0) {
        throw new Error("Disabled fallback requires a zero fallbackLexical minimum.");
    }
    const mcp = requireRecord(policy.mcp, "Replay policy mcp");
    requireExactKeys(mcp, ["rrfK"], "Replay policy mcp");
    return {
        version: 1,
        kind: "satori_search_candidate_policy",
        policyId,
        core: {
            candidateDepth,
            rrfK: requirePositiveInteger(core.rrfK, "Replay policy core.rrfK"),
            weights: normalizedWeights,
            minimums: normalizedMinimums,
            fallback: {
                enabled: fallback.enabled,
                preciseUniqueCountBelow: requireNonNegativeInteger(
                    fallback.preciseUniqueCountBelow,
                    "Replay policy core.fallback.preciseUniqueCountBelow",
                ),
            },
        },
        mcp: {
            rrfK: requirePositiveInteger(mcp.rrfK, "Replay policy mcp.rrfK"),
        },
    };
}

function replayPolicyCorePass(capture, outputStage, policy) {
    const stages = capture.candidateTrace.stages;
    const passId = requireString(outputStage.passId, "Core output passId");
    const denseStage = stageByNameAndPass(stages, "raw_dense", passId);
    const preciseStage = stageByNameAndPass(stages, "raw_lexical", passId);
    const fallbackStage = stageByNameAndPass(stages, "raw_lexical_fallback", passId);
    const arms = {
        dense: denseStage
            ? orderCapturedCoreArm(
                denseStage,
                policy.core.candidateDepth,
                `Task '${capture.taskId}' dense '${passId}'`,
            )
            : [],
        preciseLexical: preciseStage
            ? orderCapturedCoreArm(
                preciseStage,
                policy.core.candidateDepth,
                `Task '${capture.taskId}' precise lexical '${passId}'`,
            )
            : [],
        fallbackLexical: fallbackStage
            ? orderCapturedCoreArm(
                fallbackStage,
                policy.core.candidateDepth,
                `Task '${capture.taskId}' fallback lexical '${passId}'`,
            )
            : [],
    };
    const fallbackActivated = policy.core.fallback.enabled
        && arms.preciseLexical.length < policy.core.fallback.preciseUniqueCountBelow;
    if (fallbackActivated && !fallbackStage) {
        throw new Error(`Task '${capture.taskId}' pass '${passId}' has no captured fallback arm.`);
    }
    const activeSources = [
        ["dense", arms.dense],
        ["preciseLexical", arms.preciseLexical],
        ...(fallbackActivated ? [["fallbackLexical", arms.fallbackLexical]] : []),
    ];
    const byId = new Map();
    for (const [source, candidates] of activeSources) {
        candidates.forEach((candidate, index) => {
            const contribution = policy.core.weights[source] / (policy.core.rrfK + index + 1);
            const existing = byId.get(candidate.candidateId);
            if (existing) {
                assertSameCandidatePayload(existing.candidate, candidate, `Task '${capture.taskId}' pass '${passId}'`);
                existing.score += contribution;
                existing.sources.add(source);
            } else {
                byId.set(candidate.candidateId, {
                    candidate,
                    score: contribution,
                    sources: new Set([source]),
                });
            }
        });
    }
    const fused = [...byId.values()].sort((left, right) => (
        right.score - left.score || compareCandidateIdentity(left.candidate, right.candidate)
    ));
    const admittedIds = new Set();
    for (const [source, candidates] of activeSources) {
        const minimum = policy.core.minimums[source];
        for (const candidate of candidates) {
            if (admittedIds.size >= policy.core.candidateDepth || minimum === 0) break;
            const admittedFromSource = [...admittedIds].filter((candidateId) => (
                byId.get(candidateId)?.sources.has(source)
            )).length;
            if (admittedFromSource >= minimum) break;
            admittedIds.add(candidate.candidateId);
        }
    }
    for (const candidate of fused) {
        if (admittedIds.size >= policy.core.candidateDepth) break;
        admittedIds.add(candidate.candidate.candidateId);
    }
    const ranked = fused.filter(({ candidate }) => admittedIds.has(candidate.candidateId));
    return {
        passId,
        mode: denseStage && preciseStage ? "hybrid" : denseStage ? "dense" : "lexical",
        fallbackActivated,
        sourceCounts: Object.fromEntries(Object.entries(arms).map(([source, candidates]) => [
            source,
            candidates.length,
        ])),
        candidates: ranked.map((entry, index) => ({
            candidate: entry.candidate,
            score: entry.score,
            sources: [...entry.sources].sort(),
            rank: index + 1,
        })),
    };
}

function assertRankedStageMatches(actual, expectedStage, label) {
    const expected = requireCompleteStage(expectedStage, label).candidates;
    if (actual.length !== expected.length) {
        throw new Error(`${label} replay count mismatch (${actual.length} != ${expected.length}).`);
    }
    for (let index = 0; index < actual.length; index += 1) {
        const replayed = actual[index];
        const recorded = requireRecord(expected[index], `${label} candidate ${index + 1}`);
        if (replayed.candidate.candidateId !== recorded.candidateId) {
            throw new Error(
                `${label} replay order mismatch at rank ${index + 1} `
                + `(${replayed.candidate.candidateId} score=${replayed.finalScore} `
                + `path=${replayed.relativePath}:${replayed.startLine} != `
                + `${recorded.candidateId} score=${recorded.score} `
                + `path=${recorded.relativePath}:${recorded.startLine}).`,
            );
        }
        if (typeof replayed.score !== "number"
            || !Number.isFinite(replayed.score)
            || typeof recorded.score !== "number"
            || !Number.isFinite(recorded.score)
            || Math.abs(replayed.score - recorded.score) > SCORE_TOLERANCE) {
            throw new Error(`${label} replay score mismatch for '${recorded.candidateId}'.`);
        }
    }
}

function assertLocalScoringMatches(actual, expectedStage, label) {
    const expected = requireCompleteStage(expectedStage, label).candidates;
    if (actual.length !== expected.length) {
        throw new Error(`${label} replay count mismatch (${actual.length} != ${expected.length}).`);
    }
    for (let index = 0; index < actual.length; index += 1) {
        const replayed = actual[index];
        const recorded = requireRecord(expected[index], `${label} candidate ${index + 1}`);
        if (replayed.candidate.candidateId !== recorded.candidateId) {
            throw new Error(
                `${label} replay order mismatch at rank ${index + 1} `
                + `(${replayed.candidate.candidateId} score=${replayed.finalScore} `
                + `path=${replayed.relativePath}:${replayed.startLine} != `
                + `${recorded.candidateId} score=${recorded.score} `
                + `path=${recorded.relativePath}:${recorded.startLine}).`,
            );
        }
        if (typeof recorded.score !== "number"
            || !Number.isFinite(recorded.score)
            || Math.abs(replayed.finalScore - recorded.score) > SCORE_TOLERANCE) {
            throw new Error(`${label} replay score mismatch for '${recorded.candidateId}'.`);
        }
    }
}

function assertCandidateIdsMatchStage(candidates, expectedStage, label) {
    const expected = requireCompleteStage(expectedStage, label).candidates;
    const actualIds = candidates.map((candidate) => candidate.candidate.candidateId);
    const expectedIds = expected.map((candidate) => candidate.candidateId);
    if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
        throw new Error(`${label} replay candidate order does not match the recorded stage.`);
    }
}

function stageByNameAndPass(stages, stageName, passId) {
    return stages.find((stage) => stage.stage === stageName && stage.passId === passId);
}

function replaySignalStagesForAttempt(stages, attemptId) {
    const chunkPrefix = `${attemptId}/replay:`;
    return stages.filter((stage) => (
        stage.stage === "mcp_replay_signals"
        && (stage.passId === attemptId || stage.passId?.startsWith(chunkPrefix))
    ));
}

function productCandidateLimitForPass(capture, passId) {
    const matches = capture.candidateTrace.corePasses.filter((entry) => entry.passId === passId);
    if (matches.length !== 1) {
        throw new Error(`Task '${capture.taskId}' Core pass '${passId}' has no unique product candidate limit.`);
    }
    return requirePositiveInteger(
        matches[0].productCandidateLimit,
        `Task '${capture.taskId}' Core pass '${passId}' productCandidateLimit`,
    );
}

function replayCorePasses(capture) {
    const stages = capture.candidateTrace.stages;
    const outputStages = stages.filter((stage) => (
        stage.stage === "core_fusion" || stage.stage === "core_result"
    ));
    return outputStages.map((outputStage) => {
        const passId = requireString(outputStage.passId, "Core output passId");
        const dense = stageByNameAndPass(stages, "raw_dense", passId);
        const lexical = stageByNameAndPass(stages, "raw_lexical", passId);
        if (outputStage.stage === "core_fusion") {
            if (!dense || !lexical) {
                throw new Error(`Core hybrid pass '${passId}' is missing a raw retrieval arm.`);
            }
            const replayed = replayCoreFusion(
                dense,
                lexical,
                productCandidateLimitForPass(capture, passId),
                `Task '${capture.taskId}' Core pass '${passId}'`,
            );
            assertRankedStageMatches(
                replayed,
                outputStage,
                `Task '${capture.taskId}' Core pass '${passId}'`,
            );
            return { passId, mode: "hybrid", candidateCount: replayed.length };
        }
        const rawStage = dense ?? lexical;
        if (!rawStage) throw new Error(`Core pass '${passId}' is missing its raw retrieval stage.`);
        const replayed = compactRankedArm(
            rawStage,
            `Task '${capture.taskId}' Core pass '${passId}'`,
        )
            .slice(0, productCandidateLimitForPass(capture, passId))
            .map((candidate) => ({ candidate, score: candidate.score }));
        assertRankedStageMatches(
            replayed,
            outputStage,
            `Task '${capture.taskId}' Core pass '${passId}'`,
        );
        return { passId, mode: dense ? "dense" : "lexical", candidateCount: replayed.length };
    });
}

function mcpCandidateKey(candidate) {
    return JSON.stringify([
        candidate.relativePath,
        candidate.startLine,
        candidate.endLine,
        candidate.language || "unknown",
    ]);
}

function capturedMcpRrfK(capture) {
    return requirePositiveInteger(
        requireRecord(
            capture.passConfiguration?.mcpFusion,
            `Task '${capture.taskId}' MCP fusion policy`,
        ).rrfK,
        `Task '${capture.taskId}' MCP fusion rrfK`,
    );
}

function compareNullableStrings(left, right) {
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableNumbers(left, right) {
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return left - right;
}

function compareLocallyScoredCandidates(left, right, options) {
    if (options.mustMatchesFirst && left.passesMatchedMust !== right.passesMatchedMust) {
        return left.passesMatchedMust ? -1 : 1;
    }
    if (options.exactMatchFirst && left.exactLexicalMatch !== right.exactLexicalMatch) {
        return left.exactLexicalMatch ? -1 : 1;
    }
    if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
    const leftCandidate = left.candidate ?? left;
    const rightCandidate = right.candidate ?? right;
    const fileOrder = compareNullableStrings(leftCandidate.relativePath, rightCandidate.relativePath);
    if (fileOrder !== 0) return fileOrder;
    const lineOrder = compareNullableNumbers(leftCandidate.startLine, rightCandidate.startLine);
    if (lineOrder !== 0) return lineOrder;
    const labelOrder = compareNullableStrings(left.symbolLabel, right.symbolLabel);
    if (labelOrder !== 0) return labelOrder;
    return compareNullableStrings(left.symbolId, right.symbolId);
}

function replaySignalByCandidate(capture, attemptId) {
    const signalStages = replaySignalStagesForAttempt(
        capture.candidateTrace.stages,
        attemptId,
    );
    if (signalStages.length === 0) {
        throw new Error(`Task '${capture.taskId}' MCP attempt '${attemptId}' has no replay signals.`);
    }
    const signals = new Map();
    for (let stageIndex = 0; stageIndex < signalStages.length; stageIndex += 1) {
        const signalStage = requireCompleteStage(
            signalStages[stageIndex],
            `Task '${capture.taskId}' MCP replay signals '${attemptId}' chunk ${stageIndex + 1}`,
        );
        for (const rawCandidate of signalStage.candidates) {
            const candidate = requireRecord(rawCandidate, `Task '${capture.taskId}' MCP replay signal`);
            const candidateId = requireString(candidate.candidateId, "MCP replay signal candidateId");
            if (signals.has(candidateId)) {
                throw new Error(`Task '${capture.taskId}' has duplicate replay signals for '${candidateId}'.`);
            }
            const replay = requireRecord(candidate.replay, `MCP replay signal '${candidateId}'`);
            signals.set(candidateId, { candidate, replay });
        }
    }
    return signals;
}

function diagnosticRemovalByCandidate(capture, attemptId) {
    const passId = `${attemptId}/diagnostic_replay`;
    const removals = new Map();
    for (const rawRemoval of capture.candidateTrace.removals) {
        if (rawRemoval.passId !== passId) continue;
        const removal = requireRecord(rawRemoval, `Task '${capture.taskId}' diagnostic removal`);
        const candidateId = requireString(removal.candidateId, "Diagnostic removal candidateId");
        if (removals.has(candidateId) && removals.get(candidateId) !== removal.reason) {
            throw new Error(`Task '${capture.taskId}' has conflicting removals for '${candidateId}'.`);
        }
        removals.set(candidateId, requireString(removal.reason, "Diagnostic removal reason"));
    }
    return removals;
}

function replayPostFusionLocalScoring(capture, attempt) {
    const signals = replaySignalByCandidate(capture, attempt.attemptId);
    const removals = diagnosticRemovalByCandidate(capture, attempt.attemptId);
    const scored = [];
    const removed = [];
    for (const entry of attempt.candidates) {
        const candidateId = entry.candidate.candidateId;
        const signal = signals.get(candidateId);
        if (!signal) {
            removed.push({
                candidateId,
                reason: removals.get(candidateId) ?? "filtered_before_local_scoring_reason_unrecorded",
            });
            continue;
        }
        assertSameCandidatePayload(
            entry.candidate,
            signal.candidate,
            `Task '${capture.taskId}' MCP local scoring '${attempt.attemptId}'`,
        );
        const replay = signal.replay;
        const lexicalScore = requireNonNegativeFinite(
            replay.lexicalScore,
            `Task '${capture.taskId}' candidate '${candidateId}' lexicalScore`,
        );
        const pathMultiplier = requirePositiveFinite(
            replay.pathMultiplier,
            `Task '${capture.taskId}' candidate '${candidateId}' pathMultiplier`,
        );
        const changedFilesMultiplier = requirePositiveFinite(
            replay.changedFilesMultiplier,
            `Task '${capture.taskId}' candidate '${candidateId}' changedFilesMultiplier`,
        );
        const agentFitMultiplier = requirePositiveFinite(
            replay.agentFitMultiplier,
            `Task '${capture.taskId}' candidate '${candidateId}' agentFitMultiplier`,
        );
        if (typeof replay.exactLexicalMatch !== "boolean"
            || typeof replay.passesMatchedMust !== "boolean") {
            throw new Error(`Task '${capture.taskId}' candidate '${candidateId}' has invalid replay flags.`);
        }
        const fusionScore = requireNonNegativeFinite(
            entry.score,
            `Task '${capture.taskId}' candidate '${candidateId}' fusionScore`,
        );
        scored.push({
            ...entry,
            fusionScore,
            lexicalScore,
            pathMultiplier,
            changedFilesMultiplier,
            agentFitMultiplier,
            exactLexicalMatch: replay.exactLexicalMatch,
            passesMatchedMust: replay.passesMatchedMust,
            rerankFamilyId: requireString(
                replay.rerankFamilyId,
                `Task '${capture.taskId}' candidate '${candidateId}' rerankFamilyId`,
            ),
            rerankDocumentUtf8Bytes: requireNonNegativeInteger(
                replay.rerankDocumentUtf8Bytes,
                `Task '${capture.taskId}' candidate '${candidateId}' rerankDocumentUtf8Bytes`,
            ),
            symbolLabel: replay.symbolLabel ?? null,
            symbolId: replay.symbolId ?? null,
            finalScore: (fusionScore + lexicalScore)
                * pathMultiplier
                * changedFilesMultiplier
                * agentFitMultiplier,
        });
    }
    const rerank = requireRecord(
        capture.passConfiguration.rerank,
        `Task '${capture.taskId}' rerank policy`,
    );
    const mustMatchesFirst = Array.isArray(capture.queryPlan.operatorSummary?.must)
        && capture.queryPlan.operatorSummary.must.length > 0;
    scored.sort((left, right) => compareLocallyScoredCandidates(left, right, {
        exactMatchFirst: rerank.exactMatchPinningEnabled === true,
        mustMatchesFirst,
    }));
    return { candidates: scored, removed, mustMatchesFirst };
}

function shouldSkipRerankForExactPin(candidates, rerank, mustMatchesFirst) {
    if (candidates.length === 0 || candidates[0].exactLexicalMatch !== true) return false;
    if (rerank.exactMatchPinningEnabled === true) return true;
    if (mustMatchesFirst && candidates[0].passesMatchedMust === true) return true;
    return candidates.length === 1;
}

function replayRerankerAdmission(capture, localScoring) {
    const rerank = requireRecord(
        capture.passConfiguration.rerank,
        `Task '${capture.taskId}' rerank policy`,
    );
    const selectionPolicy = requireRecord(
        rerank.selectionPolicy,
        `Task '${capture.taskId}' rerank selectionPolicy`,
    );
    const enabledBeforeExactPin = rerank.enabledByPolicy === true
        && rerank.skippedByScopeDocs !== true
        && rerank.skippedByIdentifierIntent !== true
        && rerank.capabilityPresent === true
        && rerank.rerankerPresent === true;
    const skippedByExactPin = enabledBeforeExactPin && shouldSkipRerankForExactPin(
        localScoring.candidates,
        rerank,
        localScoring.mustMatchesFirst,
    );
    if (!enabledBeforeExactPin || skippedByExactPin || localScoring.candidates.length === 0) {
        return {
            enabled: enabledBeforeExactPin && !skippedByExactPin,
            skippedByExactPin,
            selected: [],
            familyCount: 0,
            supplementalCandidateCount: 0,
            candidatePoolCount: 0,
            budget: 0,
            budgetReason: null,
            inputUtf8Bytes: 0,
        };
    }

    const representatives = [];
    const representedFamilies = new Set();
    const supplementalByFamily = new Map();
    const maxSupplemental = requireNonNegativeInteger(
        selectionPolicy.maxSupplementalChunksPerFamily,
        `Task '${capture.taskId}' rerank maxSupplementalChunksPerFamily`,
    );
    for (const candidate of localScoring.candidates) {
        if (!representedFamilies.has(candidate.rerankFamilyId)) {
            representatives.push(candidate);
            representedFamilies.add(candidate.rerankFamilyId);
            continue;
        }
        const supplemental = supplementalByFamily.get(candidate.rerankFamilyId) ?? [];
        if (supplemental.length < maxSupplemental) {
            supplementalByFamily.set(candidate.rerankFamilyId, [...supplemental, candidate]);
        }
    }
    const supplementalCandidates = [];
    for (let index = 0; index < maxSupplemental; index += 1) {
        for (const candidates of supplementalByFamily.values()) {
            if (candidates[index]) supplementalCandidates.push(candidates[index]);
        }
    }
    const candidatePool = [...representatives, ...supplementalCandidates];
    const requestedLimit = requirePositiveInteger(
        rerank.requestedResultLimit,
        `Task '${capture.taskId}' rerank requestedResultLimit`,
    );
    const ambiguous = representatives.length > requestedLimit;
    const adaptiveBudget = ambiguous
        ? Math.max(
            requirePositiveInteger(
                selectionPolicy.minAmbiguousCandidates,
                `Task '${capture.taskId}' rerank minAmbiguousCandidates`,
            ),
            requestedLimit * requirePositiveInteger(
                selectionPolicy.ambiguousCandidatesPerResult,
                `Task '${capture.taskId}' rerank ambiguousCandidatesPerResult`,
            ),
        )
        : requestedLimit * requirePositiveInteger(
            selectionPolicy.boundedCandidatesPerResult,
            `Task '${capture.taskId}' rerank boundedCandidatesPerResult`,
        );
    const budget = Math.min(
        requirePositiveInteger(rerank.topK, `Task '${capture.taskId}' rerank topK`),
        candidatePool.length,
        adaptiveBudget,
    );
    const selected = candidatePool.slice(0, budget);
    return {
        enabled: true,
        skippedByExactPin: false,
        selected,
        familyCount: representatives.length,
        supplementalCandidateCount: supplementalCandidates.length,
        candidatePoolCount: candidatePool.length,
        budget,
        budgetReason: candidatePool.length <= adaptiveBudget
            ? "complete_family_pool"
            : "family_ambiguity",
        inputUtf8Bytes: selected.reduce(
            (total, candidate) => total + candidate.rerankDocumentUtf8Bytes,
            0,
        ),
    };
}

function replayMcpAttempt(capture, attemptStage) {
    const attemptId = requireString(attemptStage.passId, "MCP fusion attempt passId");
    const passPrefix = `${attemptId}/`;
    const passStages = capture.candidateTrace.stages.filter((stage) => (
        stage.stage === "mcp_pass" && stage.passId?.startsWith(passPrefix)
    ));
    if (passStages.length === 0) {
        throw new Error(`Task '${capture.taskId}' MCP attempt '${attemptId}' has no raw pass stages.`);
    }
    const rrfK = capturedMcpRrfK(capture);
    const byChunkKey = new Map();
    for (const rawStage of passStages) {
        const stage = requireCompleteStage(
            rawStage,
            `Task '${capture.taskId}' MCP pass '${rawStage.passId}'`,
        );
        if (typeof stage.weight !== "number" || !Number.isFinite(stage.weight) || stage.weight <= 0) {
            throw new Error(`Task '${capture.taskId}' MCP pass '${stage.passId}' has no valid weight.`);
        }
        stage.candidates.forEach((candidate, index) => {
            const key = mcpCandidateKey(candidate);
            const contribution = stage.weight / (rrfK + index + 1);
            const existing = byChunkKey.get(key);
            if (existing) existing.score += contribution;
            else byChunkKey.set(key, { candidate, score: contribution });
        });
    }
    const replayed = [...byChunkKey.values()].sort((left, right) => (
        right.score - left.score || compareCandidateIdentity(left.candidate, right.candidate)
    ));
    assertRankedStageMatches(
        replayed,
        attemptStage,
        `Task '${capture.taskId}' MCP attempt '${attemptId}'`,
    );
    return {
        attemptId,
        passCount: passStages.length,
        candidateCount: replayed.length,
        candidates: replayed.map((entry, index) => ({
            candidate: entry.candidate,
            score: entry.score,
            rank: index + 1,
        })),
    };
}

function replayPolicyMcpAttempt(capture, attemptStage, corePasses, policy) {
    const attemptId = requireString(attemptStage.passId, "MCP fusion attempt passId");
    const passPrefix = `${attemptId}/`;
    const recordedPasses = capture.candidateTrace.stages.filter((stage) => (
        stage.stage === "mcp_pass" && stage.passId?.startsWith(passPrefix)
    ));
    if (recordedPasses.length === 0) {
        throw new Error(`Task '${capture.taskId}' MCP attempt '${attemptId}' has no raw pass stages.`);
    }
    const coreByPassId = new Map(corePasses.map((pass) => [pass.passId, pass]));
    const byChunkKey = new Map();
    for (const rawStage of recordedPasses) {
        const stage = requireCompleteStage(
            rawStage,
            `Task '${capture.taskId}' MCP pass '${rawStage.passId}'`,
        );
        if (typeof stage.weight !== "number" || !Number.isFinite(stage.weight) || stage.weight <= 0) {
            throw new Error(`Task '${capture.taskId}' MCP pass '${stage.passId}' has no valid weight.`);
        }
        const policyCorePass = coreByPassId.get(stage.passId);
        const candidates = policyCorePass
            ? policyCorePass.candidates.map((candidate) => candidate.candidate)
            : compactRankedArm(stage, `Task '${capture.taskId}' MCP pass '${stage.passId}'`);
        candidates.forEach((candidate, index) => {
            const key = mcpCandidateKey(candidate);
            const contribution = stage.weight / (policy.mcp.rrfK + index + 1);
            const existing = byChunkKey.get(key);
            if (existing) {
                assertSameCandidatePayload(
                    existing.candidate,
                    candidate,
                    `Task '${capture.taskId}' MCP attempt '${attemptId}'`,
                );
                existing.score += contribution;
                existing.passes.add(stage.passId);
            } else {
                byChunkKey.set(key, {
                    candidate,
                    score: contribution,
                    passes: new Set([stage.passId]),
                });
            }
        });
    }
    const ranked = [...byChunkKey.values()].sort((left, right) => (
        right.score - left.score || compareCandidateIdentity(left.candidate, right.candidate)
    ));
    return {
        attemptId,
        passCount: recordedPasses.length,
        candidates: ranked.map((entry, index) => ({
            candidate: entry.candidate,
            candidateId: entry.candidate.candidateId,
            ownerId: entry.candidate.ownerId,
            relativePath: entry.candidate.relativePath,
            startLine: entry.candidate.startLine,
            endLine: entry.candidate.endLine,
            language: entry.candidate.language,
            rank: index + 1,
            score: entry.score,
            passes: [...entry.passes].sort(),
        })),
    };
}

function replayTaskCapture(capture) {
    const record = requireRecord(capture, "Task capture");
    const trace = requireRecord(record.candidateTrace, `Task '${record.taskId}' candidateTrace`);
    for (const [field, value] of [
        ["queryPlanDigest", record.queryPlan],
        ["passConfigurationDigest", record.passConfiguration],
        ["candidateTraceDigest", trace],
        ["rankedResultIdentityDigest", record.rankedResults],
    ]) {
        if (sha256Canonical(value) !== record[field]) {
            throw new Error(`Task '${record.taskId}' ${field} does not match its contents.`);
        }
    }
    if (!Array.isArray(trace.stages)) throw new Error(`Task '${record.taskId}' trace stages must be an array.`);
    if (record.readiness?.route === "exact_registry") {
        if (record.readiness.policyInvariant !== true
            || record.readiness.fusionReplayStatus !== "not_applicable"
            || record.readiness.fusionNotApplicableReason !== "exact_registry_hit") {
            throw new Error(`Task '${record.taskId}' has incomplete exact-registry route authority.`);
        }
        const expected = requireRecord(record.expected, `Task '${record.taskId}' expected owner`);
        const rankedResults = requireArray(
            record.rankedResults,
            `Task '${record.taskId}' exact-registry ranked results`,
        );
        const first = requireRecord(rankedResults[0], `Task '${record.taskId}' exact-registry first result`);
        if (first.file !== expected.ownerFile || first.symbol !== expected.ownerSymbol) {
            throw new Error(`Task '${record.taskId}' exact-registry target does not match frozen owner authority.`);
        }
        return {
            taskId: record.taskId,
            route: {
                kind: "exact_registry",
                fusionReplay: "not_applicable",
                reason: "exact_registry_hit",
                matchedSymbolInstanceId: record.passConfiguration.exactRegistry.matchedSymbolInstanceId,
            },
            policyAffected: false,
            rankedResults,
            corePasses: [],
            mcpAttempts: [],
            providerWork: {
                semanticSearchAttempts: 0,
                embeddingCallsByCurrentContract: 0,
                rerankerCalls: 0,
                rerankerCandidates: 0,
                rerankerInputBytes: 0,
            },
        };
    }
    const corePasses = replayCorePasses(record);
    const internalMcpAttempts = trace.stages
        .filter((stage) => stage.stage === "mcp_fusion")
        .map((stage) => replayMcpAttempt(record, stage));
    if (corePasses.length === 0 || internalMcpAttempts.length === 0) {
        throw new Error(`Task '${record.taskId}' does not contain complete Core and MCP fusion stages.`);
    }
    const signalsComplete = internalMcpAttempts.every((attempt) => (
        replaySignalStagesForAttempt(trace.stages, attempt.attemptId).length > 0
    ));
    let localScoring;
    let rerankerAdmission;
    if (signalsComplete) {
        const localAttempts = internalMcpAttempts.map((attempt) => {
            const local = replayPostFusionLocalScoring(record, attempt);
            const recordedStage = stageByNameAndPass(
                trace.stages,
                "mcp_filtered",
                attempt.attemptId,
            );
            if (!recordedStage) {
                throw new Error(`Task '${record.taskId}' MCP attempt '${attempt.attemptId}' has no filtered stage.`);
            }
            assertLocalScoringMatches(
                local.candidates,
                recordedStage,
                `Task '${record.taskId}' MCP local scoring '${attempt.attemptId}'`,
            );
            return { attemptId: attempt.attemptId, ...local };
        });
        const finalLocal = localAttempts.at(-1);
        rerankerAdmission = replayRerankerAdmission(record, finalLocal);
        const recordedRerankerInput = trace.stages.find((stage) => stage.stage === "reranker_input");
        if (rerankerAdmission.selected.length > 0) {
            if (!recordedRerankerInput) {
                throw new Error(`Task '${record.taskId}' has no recorded reranker input stage.`);
            }
            assertCandidateIdsMatchStage(
                rerankerAdmission.selected,
                recordedRerankerInput,
                `Task '${record.taskId}' reranker admission`,
            );
        } else if (recordedRerankerInput) {
            throw new Error(`Task '${record.taskId}' recorded reranker input but replay selected none.`);
        }
        const providerWork = requireRecord(
            record.passConfiguration.providerWork,
            `Task '${record.taskId}' provider work`,
        );
        if (rerankerAdmission.selected.length !== requireNonNegativeInteger(
            providerWork.rerankerCandidates,
            `Task '${record.taskId}' provider rerankerCandidates`,
        )) {
            throw new Error(`Task '${record.taskId}' reranker candidate count does not match provider work.`);
        }
        if (rerankerAdmission.inputUtf8Bytes !== requireNonNegativeInteger(
            providerWork.rerankerInputBytes,
            `Task '${record.taskId}' provider rerankerInputBytes`,
        )) {
            throw new Error(`Task '${record.taskId}' reranker input bytes do not match provider work.`);
        }
        localScoring = localAttempts.map((attempt) => ({
            attemptId: attempt.attemptId,
            candidateCount: attempt.candidates.length,
            removedCount: attempt.removed.length,
        }));
    }
    const mcpAttempts = internalMcpAttempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        passCount: attempt.passCount,
        candidateCount: attempt.candidateCount,
    }));
    return {
        taskId: record.taskId,
        route: { kind: "fusion", fusionReplay: "exact" },
        policyAffected: true,
        corePasses,
        mcpAttempts,
        ...(localScoring ? { localScoring } : {}),
        ...(rerankerAdmission ? {
            rerankerAdmission: {
                selectedCandidateIds: rerankerAdmission.selected.map(
                    (candidate) => candidate.candidate.candidateId,
                ),
                familyCount: rerankerAdmission.familyCount,
                supplementalCandidateCount: rerankerAdmission.supplementalCandidateCount,
                candidatePoolCount: rerankerAdmission.candidatePoolCount,
                budget: rerankerAdmission.budget,
                budgetReason: rerankerAdmission.budgetReason,
                inputUtf8Bytes: rerankerAdmission.inputUtf8Bytes,
            },
        } : {}),
    };
}

export function replayBaselineCandidateCapture(value, options = {}) {
    const capture = requireRecord(value, "Candidate capture");
    if (capture.version !== 1 || capture.kind !== "satori_search_candidate_capture") {
        throw new Error("Candidate capture version or kind is unsupported.");
    }
    const suppliedDigest = requireString(capture.sha256, "Candidate capture sha256");
    const { sha256: _ignored, ...unsignedCapture } = capture;
    const computedDigest = sha256Canonical(unsignedCapture);
    if (computedDigest !== suppliedDigest) {
        throw new Error("Candidate capture digest does not match its contents.");
    }
    if (capture.policyId !== "baseline") {
        throw new Error("Baseline replay requires policyId=baseline.");
    }
    if (!Array.isArray(capture.captures)) throw new Error("Candidate capture tasks must be an array.");
    const tasks = capture.captures.map(replayTaskCapture);
    const replayRuntime = buildReplayRuntimeManifest(capture, "baseline", options);
    const replay = {
        version: 1,
        kind: "satori_search_candidate_baseline_replay",
        sourceCaptureSha256: suppliedDigest,
        policyId: "baseline",
        replayRuntime,
        routeCoverage: {
            fusionTaskCount: tasks.filter((task) => task.route.kind === "fusion").length,
            exactRegistryTaskCount: tasks.filter((task) => task.route.kind === "exact_registry").length,
        },
        tasks,
    };
    return { ...replay, sha256: sha256Canonical(replay) };
}

export function replayCandidateCapture(value, policyValue = "baseline", options = {}) {
    const baseline = replayBaselineCandidateCapture(value);
    if (policyValue === "baseline") return baseline;
    const capture = requireRecord(value, "Candidate capture");
    if (capture.replayReadiness?.survivalReady !== true) {
        throw new Error(
            "Contender replay requires complete depth-160 fusion and candidate-survival authority.",
        );
    }
    const policy = normalizeReplayPolicy(policyValue);
    const taskPrefix = options.taskPrefix ?? "all";
    if (!["tuning", "validation", "all"].includes(taskPrefix)) {
        throw new Error("Replay taskPrefix must be tuning, validation, or all.");
    }
    const replayRuntime = buildReplayRuntimeManifest(capture, policy, options);
    const baselineByTaskId = new Map(baseline.tasks.map((task) => [task.taskId, task]));
    const selectedCaptures = capture.captures.filter((taskCapture) => (
        taskPrefix === "all" || taskCapture.taskId.startsWith(`${taskPrefix}-`)
    ));
    if (selectedCaptures.length === 0) {
        throw new Error(`Candidate capture has no tasks for prefix '${taskPrefix}'.`);
    }
    const tasks = selectedCaptures.map((taskCapture) => {
        if (taskCapture.readiness?.route === "exact_registry") {
            const baselineTask = baselineByTaskId.get(taskCapture.taskId);
            if (!baselineTask || baselineTask.route?.kind !== "exact_registry") {
                throw new Error(`Task '${taskCapture.taskId}' has no reproduced exact-registry baseline.`);
            }
            return {
                taskId: taskCapture.taskId,
                queryClass: taskCapture.queryClass,
                language: taskCapture.language,
                expected: taskCapture.expected,
                route: baselineTask.route,
                policyAffected: false,
                rankedResults: baselineTask.rankedResults,
                corePasses: [],
                mcpAttempts: [],
                rerankerAdmission: {
                    enabled: false,
                    skippedByExactPin: false,
                    selectedCandidateIds: [],
                    familyCount: 0,
                    supplementalCandidateCount: 0,
                    candidatePoolCount: 0,
                    budget: 0,
                    budgetReason: "exact_registry_not_applicable",
                    inputUtf8Bytes: 0,
                },
            };
        }
        const diagnosticLimit = taskCapture.queryPlan?.diagnosticCandidateLimit;
        if (!Number.isSafeInteger(diagnosticLimit) || diagnosticLimit < policy.core.candidateDepth) {
            throw new Error(
                `Task '${taskCapture.taskId}' diagnostic capture does not cover depth ${policy.core.candidateDepth}.`,
            );
        }
        const outputStages = taskCapture.candidateTrace.stages.filter((stage) => (
            stage.stage === "core_fusion" || stage.stage === "core_result"
        ));
        const corePasses = outputStages.map((stage) => replayPolicyCorePass(
            taskCapture,
            stage,
            policy,
        ));
        const internalMcpAttempts = taskCapture.candidateTrace.stages
            .filter((stage) => stage.stage === "mcp_fusion")
            .map((stage) => replayPolicyMcpAttempt(taskCapture, stage, corePasses, policy));
        const localAttempts = internalMcpAttempts.map((attempt) => ({
            attemptId: attempt.attemptId,
            ...replayPostFusionLocalScoring(taskCapture, attempt),
        }));
        const rerankerAdmission = replayRerankerAdmission(taskCapture, localAttempts.at(-1));
        return {
            taskId: taskCapture.taskId,
            queryClass: taskCapture.queryClass,
            language: taskCapture.language,
            expected: taskCapture.expected,
            route: { kind: "fusion", fusionReplay: "contender" },
            policyAffected: true,
            corePasses: corePasses.map((pass) => ({
                passId: pass.passId,
                mode: pass.mode,
                fallbackActivated: pass.fallbackActivated,
                sourceCounts: pass.sourceCounts,
                candidates: pass.candidates.map((entry) => ({
                    candidateId: entry.candidate.candidateId,
                    ownerId: entry.candidate.ownerId,
                    relativePath: entry.candidate.relativePath,
                    rank: entry.rank,
                    score: entry.score,
                    sources: entry.sources,
                })),
            })),
            mcpAttempts: internalMcpAttempts.map((attempt, index) => ({
                attemptId: attempt.attemptId,
                passCount: attempt.passCount,
                candidates: localAttempts[index].candidates.map((candidate, rankIndex) => ({
                    candidateId: candidate.candidate.candidateId,
                    ownerId: candidate.candidate.ownerId,
                    relativePath: candidate.candidate.relativePath,
                    symbolLabel: candidate.symbolLabel,
                    symbolId: candidate.symbolId,
                    rank: rankIndex + 1,
                    fusionScore: candidate.fusionScore,
                    lexicalScore: candidate.lexicalScore,
                    finalScore: candidate.finalScore,
                    passes: candidate.passes,
                })),
                removed: localAttempts[index].removed,
            })),
            rerankerAdmission: {
                enabled: rerankerAdmission.enabled,
                skippedByExactPin: rerankerAdmission.skippedByExactPin,
                selectedCandidateIds: rerankerAdmission.selected.map(
                    (candidate) => candidate.candidate.candidateId,
                ),
                familyCount: rerankerAdmission.familyCount,
                supplementalCandidateCount: rerankerAdmission.supplementalCandidateCount,
                candidatePoolCount: rerankerAdmission.candidatePoolCount,
                budget: rerankerAdmission.budget,
                budgetReason: rerankerAdmission.budgetReason,
                inputUtf8Bytes: rerankerAdmission.inputUtf8Bytes,
            },
        };
    });
    const replay = {
        version: 1,
        kind: "satori_search_candidate_policy_replay",
        sourceCaptureSha256: capture.sha256,
        baselineReplaySha256: baseline.sha256,
        baselineReproduced: true,
        policy,
        policySha256: sha256Canonical(policy),
        taskPrefix,
        replayRuntime,
        providerValidationRequired: true,
        replayCoverage: {
            coreFusion: true,
            mcpFusion: true,
            postFusionLocalScoring: true,
            rerankerAdmission: true,
            rerankerProviderOutput: false,
            groupingAndDisclosure: false,
            fusionTaskCount: tasks.filter((task) => task.policyAffected).length,
            exactRegistryPolicyInvariantTaskCount: tasks.filter((task) => !task.policyAffected).length,
        },
        liveValidationReasons: [
            "new_candidates_have_no_frozen_reranker_scores",
        ],
        tasks,
    };
    return { ...replay, sha256: sha256Canonical(replay) };
}

function usage() {
    return "Usage: node scripts/satori-search-candidate-replay.mjs --capture <capture.json> [--policy-file <policy.json>] [--task-prefix <tuning|validation|all>] [--out <replay.json>]";
}

export function main(argv = process.argv.slice(2)) {
    let captureFile;
    let policyFile;
    let taskPrefix = "all";
    let outFile;
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === "--capture") captureFile = path.resolve(argv[++index]);
        else if (argv[index] === "--policy-file") policyFile = path.resolve(argv[++index]);
        else if (argv[index] === "--task-prefix") taskPrefix = argv[++index];
        else if (argv[index] === "--out") outFile = path.resolve(argv[++index]);
        else if (argv[index] === "--help") {
            process.stdout.write(`${usage()}\n`);
            return null;
        } else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!captureFile) throw new Error("--capture is required.");
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const policySourceBytes = policyFile ? fs.readFileSync(policyFile) : undefined;
    const policy = policySourceBytes
        ? JSON.parse(policySourceBytes.toString("utf8"))
        : "baseline";
    const replay = replayCandidateCapture(capture, policy, {
        taskPrefix,
        ...(policySourceBytes ? { policySourceBytes } : {}),
        ...(policyFile ? { policySourceFileName: policyFile } : {}),
    });
    const serialized = `${JSON.stringify(replay, null, 2)}\n`;
    if (outFile) fs.writeFileSync(outFile, serialized);
    else process.stdout.write(serialized);
    return replay;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === REPLAY_SCRIPT_PATH) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`satori-search-candidate-replay: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        process.exitCode = 1;
    }
}
