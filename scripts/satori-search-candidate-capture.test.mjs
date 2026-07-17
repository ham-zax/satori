import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSearchCandidateCapture } from "./satori-search-candidate-capture.mjs";
import {
    replayBaselineCandidateCapture,
    replayCandidateCapture,
} from "./satori-search-candidate-replay.mjs";
import { canonicalJson } from "./satori-useful-context.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const SCRIPT_PATH = fileURLToPath(new URL("./satori-search-candidate-capture.mjs", import.meta.url));
const REPLAY_SCRIPT_PATH = fileURLToPath(new URL("./satori-search-candidate-replay.mjs", import.meta.url));

function sha256Canonical(value) {
    return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function taskSuite() {
    return {
        version: 1,
        tasks: [{
            id: "ignore-owner",
            queryClass: "owner_discovery",
            language: "typescript",
            expected: { ownerFile: "src/sync.ts", ownerSymbol: "reconcileIgnoreRules" },
            workload: {
                setup: [{ tool: "manage_index", args: { action: "status", path: "/repo" } }],
                invocations: [{
                    tool: "search_codebase",
                    args: {
                        path: "/repo",
                        query: "where are ignore rules reconciled",
                        scope: "runtime",
                        resultMode: "grouped",
                        groupBy: "symbol",
                        rankingMode: "default",
                        debugMode: "full",
                    },
                }],
                phaseProtocol: { cold: "cold", warm: "warm" },
            },
        }],
    };
}

function occurrence(stage, rank, score = 1 / rank) {
    return {
        candidateId: `candidate-${rank}`,
        candidateIdKind: "persisted",
        ownerId: '["symbol","src/sync.ts","reconcileIgnoreRules"]',
        evidenceOccurrenceId: JSON.stringify([`candidate-${rank}`, stage, rank]),
        relativePath: "src/sync.ts",
        startLine: 10,
        endLine: 20,
        language: "typescript",
        rank,
        score,
        passId: "attempt:1/primary",
    };
}

function candidateTrace() {
    return {
        schemaVersion: "search_candidate_survival_v1",
        maxEntriesPerStage: 160,
        corePasses: [{
            passId: "attempt:1/primary",
            productCandidateLimit: 80,
        }],
        queryEmbeddings: [{ passId: "attempt:1/primary", sha256: DIGEST_C }],
        lexicalRequests: [{
            passId: "attempt:1/primary",
            role: "primary",
            querySha256: DIGEST_B,
            matchMode: "all_terms",
        }],
        stages: [
            {
                stage: "raw_dense",
                passId: "attempt:1/primary",
                totalOccurrences: 1,
                uniqueCandidates: 1,
                omittedOccurrences: 0,
                candidates: [occurrence("raw_dense", 1)],
            },
            {
                stage: "raw_lexical",
                passId: "attempt:1/primary",
                totalOccurrences: 1,
                uniqueCandidates: 1,
                omittedOccurrences: 0,
                candidates: [occurrence("raw_lexical", 1)],
            },
            {
                stage: "core_fusion",
                passId: "attempt:1/primary",
                totalOccurrences: 1,
                uniqueCandidates: 1,
                omittedOccurrences: 0,
                candidates: [occurrence("core_fusion", 1, 2 / 101)],
            },
            {
                stage: "mcp_pass",
                passId: "attempt:1/primary",
                weight: 1,
                totalOccurrences: 1,
                uniqueCandidates: 1,
                omittedOccurrences: 0,
                candidates: [occurrence("mcp_pass", 1, 2 / 101)],
            },
            {
                stage: "mcp_fusion",
                passId: "attempt:1",
                totalOccurrences: 1,
                uniqueCandidates: 1,
                omittedOccurrences: 0,
                candidates: [occurrence("mcp_fusion", 1, 1 / 61)],
            },
            {
                stage: "disclosed",
                totalOccurrences: 1,
                uniqueCandidates: 1,
                omittedOccurrences: 0,
                candidates: [occurrence("disclosed", 1)],
            },
        ],
        removals: [],
        omittedRemovals: 0,
    };
}

function replayReadyCandidateTrace() {
    const trace = candidateTrace();
    const fallbackTerms = ["ignore", "rules", "reconciled"];
    const lexical = structuredClone(trace.stages.find((stage) => stage.stage === "raw_lexical"));
    lexical.stage = "raw_lexical_fallback";
    lexical.candidates = lexical.candidates.map((candidate) => ({
        ...candidate,
        candidateId: "fallback-candidate",
        ownerId: '["symbol","src/fallback.ts","fallbackOwner"]',
        evidenceOccurrenceId: JSON.stringify(["fallback-candidate", "raw_lexical_fallback", 1]),
        relativePath: "src/fallback.ts",
        rank: 1,
    }));
    trace.lexicalRequests.push({
        passId: "attempt:1/primary",
        role: "fallback_or",
        querySha256: crypto.createHash("sha256").update(fallbackTerms.join(" "), "utf8").digest("hex"),
        matchMode: "any_terms",
        terms: fallbackTerms,
    });
    trace.stages.splice(2, 0, lexical);
    const replaySignal = (candidate, replay, score) => ({
        ...candidate,
        evidenceOccurrenceId: JSON.stringify([
            candidate.candidateId,
            "mcp_replay_signals",
            "attempt:1/replay:1",
            candidate.rank,
        ]),
        passId: "attempt:1/replay:1",
        score,
        replay,
    });
    const primary = trace.stages.find((stage) => stage.stage === "mcp_fusion").candidates[0];
    const fallback = lexical.candidates[0];
    const primaryReplay = {
        lexicalScore: 0.1,
        pathMultiplier: 1,
        changedFilesMultiplier: 1,
        agentFitMultiplier: 1,
        exactLexicalMatch: false,
        passesMatchedMust: true,
        rerankFamilyId: "owner:primary",
        rerankDocumentUtf8Bytes: 120,
        symbolLabel: "reconcileIgnoreRules",
        symbolId: "primary-symbol",
    };
    const fallbackReplay = {
        lexicalScore: 0.2,
        pathMultiplier: 1,
        changedFilesMultiplier: 1,
        agentFitMultiplier: 1,
        exactLexicalMatch: false,
        passesMatchedMust: true,
        rerankFamilyId: "owner:fallback",
        rerankDocumentUtf8Bytes: 80,
        symbolLabel: "fallbackOwner",
        symbolId: "fallback-symbol",
    };
    const primaryFinalScore = (1 / 61) + primaryReplay.lexicalScore;
    trace.stages.push({
        stage: "mcp_replay_signals",
        passId: "attempt:1/replay:1",
        totalOccurrences: 2,
        uniqueCandidates: 2,
        omittedOccurrences: 0,
        candidates: [
            replaySignal(primary, primaryReplay, primaryFinalScore),
            replaySignal(fallback, fallbackReplay, fallbackReplay.lexicalScore),
        ],
    });
    trace.stages.push({
        stage: "mcp_filtered",
        passId: "attempt:1",
        totalOccurrences: 1,
        uniqueCandidates: 1,
        omittedOccurrences: 0,
        candidates: [occurrence("mcp_filtered", 1, primaryFinalScore)],
    });
    trace.stages.push({
        stage: "reranker_input",
        totalOccurrences: 1,
        uniqueCandidates: 1,
        omittedOccurrences: 0,
        candidates: [occurrence("reranker_input", 1, primaryFinalScore)],
    });
    return trace;
}

function contenderPolicy() {
    return {
        version: 1,
        kind: "satori_search_candidate_policy",
        policyId: "conditional-or-v1",
        core: {
            candidateDepth: 80,
            rrfK: 100,
            weights: {
                dense: 1,
                preciseLexical: 1,
                fallbackLexical: 1,
            },
            minimums: {
                dense: 0,
                preciseLexical: 0,
                fallbackLexical: 1,
            },
            fallback: {
                enabled: true,
                preciseUniqueCountBelow: 2,
            },
        },
        mcp: { rrfK: 100 },
    };
}

function debugSearch(trace = candidateTrace()) {
    return {
        route: { kind: "semantic" },
        queryIntent: {
            classification: "semantic",
            confidence: "high",
            reasons: ["natural_language"],
            lexicalTerms: ["ignore", "rules", "reconciled"],
            semanticQuery: "where are ignore rules reconciled",
        },
        retrieval: {
            mode: "hybrid",
            scorePolicyKind: "topk_only",
            backendScoreKinds: ["rrf_fusion"],
        },
        mcpFusion: { rrfK: 60 },
        providerWork: {
            semanticSearchAttempts: 1,
            embeddingCallsByCurrentContract: 1,
            denseQueriesByCurrentContract: 1,
            sparseQueriesByCurrentContract: 1,
            rerankerCalls: 1,
            rerankerCandidates: 1,
            rerankerInputBytes: 120,
            candidatesWithSemanticEvidence: 1,
            candidatesWithLexicalEvidence: 1,
            candidatesWithCurrentSourceEvidence: 0,
        },
        candidateSurvival: trace,
        passesUsed: ["primary"],
        candidateLimit: 80,
        mustRetry: { attempts: 1, maxAttempts: 2, applied: false, satisfied: true, finalCount: 1 },
        operatorSummary: { language: [], path: [], excludePath: [], must: [], exclude: [] },
        semanticExpansion: {
            attempted: false,
            expand: false,
            reason: "primary_candidate_pool_sufficient",
            primaryScopedCandidateCount: 1,
        },
        rankingProvenance: {
            semanticPassesUsed: ["primary"],
            lexicalPassesUsed: [],
            livePathSupplementUsed: false,
            lexicalFileScanUsed: false,
            rerankApplied: true,
            exactMatchPinningApplied: false,
            registryRepairGroupCount: 0,
        },
        filterSummary: {
            removedByScope: 0,
            removedByLanguage: 0,
            removedByPathInclude: 0,
            removedByPathExclude: 0,
            removedByMust: 0,
            removedByExclude: 0,
        },
        diversitySummary: {
            maxPerFile: 2,
            maxPerSymbol: 1,
            relaxedFileCap: 3,
            skippedByFileCap: 0,
            skippedBySymbolCap: 0,
            usedRelaxedCap: false,
        },
        changedFilesBoost: {
            enabled: false,
            applied: false,
            available: false,
            changedCount: 0,
            maxChangedFilesForBoost: 50,
            skippedForLargeChangeSet: false,
            multiplier: 1,
            boostedCandidates: 0,
        },
        rerank: {
            enabledByPolicy: true,
            skippedByScopeDocs: false,
            skippedByIdentifierIntent: false,
            skippedByExactPin: false,
            capabilityPresent: true,
            rerankerPresent: true,
            enabled: true,
            attempted: true,
            applied: true,
            exactMatchPinningEnabled: false,
            exactMatchPinningApplied: false,
            candidatesIn: 1,
            candidatesReranked: 1,
            familyCount: 1,
            supplementalCandidates: 0,
            candidatePoolCount: 1,
            candidateBudget: 1,
            budgetReason: "complete_family_pool",
            topK: 50,
            rankK: 10,
            weight: 1,
            docMaxLines: 200,
            docMaxChars: 4000,
            requestedResultLimit: 5,
            selectionPolicy: {
                minAmbiguousCandidates: 12,
                ambiguousCandidatesPerResult: 4,
                boundedCandidatesPerResult: 2,
                maxSupplementalChunksPerFamily: 2,
            },
        },
    };
}

function observationSet(suite = taskSuite()) {
    const runtimeFingerprint = { vectorStoreProvider: "LanceDB", embeddingProvider: "VoyageAI" };
    const publication = {
        collectionName: "generation-7",
        markerRunId: "marker-run-7",
        indexPolicyHash: DIGEST_A,
        policyDocumentDigest: DIGEST_B,
    };
    const generationReceipt = { canonicalRoot: "/repo", runtimeFingerprint, publication };
    const makeObservation = (phase, sample) => {
        const response = {
            status: "ok",
            hints: { debugSearch: debugSearch() },
            results: [{ target: { file: "src/sync.ts" }, displayLabel: "reconcileIgnoreRules" }],
        };
        return {
            taskId: "ignore-owner",
            phase,
            sample,
            generationReceipt: structuredClone(generationReceipt),
            status: "ok",
            latencyMs: phase === "cold" ? 10 : 5,
            contextBytes: 100,
            responseBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
            response,
            results: [{ kind: "symbol", file: "src/sync.ts", symbol: "reconcileIgnoreRules" }],
            toolCalls: 1,
            callsToSource: null,
            sourceReached: false,
            sourceMode: null,
            freshnessModes: ["skipped_recent"],
        };
    };
    const indexProof = {
        id: "sync-7",
        action: "sync",
        canonicalRoot: "/repo",
        generation: 7,
        phase: "completed",
        lastDurableTransitionAt: "2026-07-18T00:00:00.000Z",
        runtimeFingerprint,
        publication: structuredClone(publication),
    };
    return {
        version: 3,
        warmSampleCount: 1,
        metadata: {
            repoRoot: "/repo",
            gitRevision: "d".repeat(40),
            taskSuiteSha256: sha256Canonical(suite),
            qualificationRuntime: { sha256: DIGEST_C },
            armIndexProof: {
                canonicalRoot: "/repo",
                generation: 7,
                runtimeFingerprint,
                publication: structuredClone(publication),
            },
            taskRuns: [{
                taskId: "ignore-owner",
                syncStats: { added: 0, removed: 0, modified: 0 },
                indexProof: structuredClone(indexProof),
                finalIndexProof: structuredClone(indexProof),
            }],
        },
        observations: [makeObservation("cold", 0), makeObservation("warm", 1)],
    };
}

function replayReadyObservationSet(suite) {
    const observations = observationSet(suite);
    for (const observation of observations.observations) {
        observation.response.hints.debugSearch = {
            ...debugSearch(replayReadyCandidateTrace()),
            diagnosticCandidateLimit: 160,
        };
        observation.responseBytes = Buffer.byteLength(JSON.stringify(observation.response), "utf8");
    }
    return observations;
}

test("candidate capture binds stable query, runtime, publication, and trace authority", () => {
    const suite = taskSuite();
    const capture = buildSearchCandidateCapture(suite, observationSet(suite));

    assert.equal(capture.version, 1);
    assert.equal(capture.policyId, "baseline");
    assert.equal(capture.captures[0].stableSampleCount, 2);
    assert.deepEqual(capture.captures[0].expected, {
        ownerFile: "src/sync.ts",
        ownerSymbol: "reconcileIgnoreRules",
    });
    assert.equal(
        capture.captures[0].queryPlan.queryUtf8Sha256,
        crypto.createHash("sha256").update("where are ignore rules reconciled", "utf8").digest("hex"),
    );
    assert.deepEqual(capture.captures[0].queryPlan.queryEmbeddings, [{
        passId: "attempt:1/primary",
        sha256: DIGEST_C,
    }]);
    assert.match(capture.captures[0].queryPlanDigest, /^[0-9a-f]{64}$/);
    assert.match(capture.captures[0].passConfigurationDigest, /^[0-9a-f]{64}$/);
    assert.equal(capture.replayReadiness.fusionReady, false);
    assert.equal(capture.replayReadiness.survivalReady, false);
    assert.equal(capture.replayReadiness.agentReady, false);
    assert.deepEqual(capture.captures[0].readiness.fusionReasons, [
        "conditional_or_superset_not_recorded",
        "conditional_or_terms_not_recorded",
        "diagnostic_candidate_limit_below_160",
    ]);
    assert.deepEqual(capture.captures[0].readiness.survivalReasons, [
        "conditional_or_superset_not_recorded",
        "conditional_or_terms_not_recorded",
        "diagnostic_candidate_limit_below_160",
        "mcp_replay_signals_not_recorded",
    ]);
    assert.match(capture.sha256, /^[0-9a-f]{64}$/);
});

test("candidate capture admits a complete depth-160 AND and OR superset", () => {
    const suite = taskSuite();
    suite.tasks[0].workload.invocations[0].args.debugCandidateLimit = 160;
    const capture = buildSearchCandidateCapture(
        suite,
        replayReadyObservationSet(suite),
        { requireReplayReady: true },
    );

    assert.equal(capture.replayReadiness.fusionReady, true);
    assert.equal(capture.replayReadiness.survivalReady, true);
    assert.equal(capture.replayReadiness.agentReady, false);
    assert.deepEqual(capture.captures[0].readiness.fusionReasons, []);
    assert.deepEqual(capture.captures[0].readiness.survivalReasons, []);
    assert.deepEqual(capture.captures[0].readiness.agentReasons, [
        "agent_replay_not_implemented",
    ]);
    assert.equal(capture.captures[0].queryPlan.candidateLimit, 80);
    assert.equal(capture.captures[0].queryPlan.diagnosticCandidateLimit, 160);
    assert.deepEqual(
        capture.captures[0].queryPlan.lexicalRequests.map(({ role, matchMode }) => ({ role, matchMode })),
        [
            { role: "primary", matchMode: "all_terms" },
            { role: "fallback_or", matchMode: "any_terms" },
        ],
    );
});

test("baseline replay recomputes both Core and MCP fusion from one capture", () => {
    const suite = taskSuite();
    const capture = buildSearchCandidateCapture(suite, observationSet(suite));
    const replay = replayBaselineCandidateCapture(capture);

    assert.equal(replay.policyId, "baseline");
    assert.deepEqual(replay.tasks, [{
        taskId: "ignore-owner",
        corePasses: [{
            passId: "attempt:1/primary",
            mode: "hybrid",
            candidateCount: 1,
        }],
        mcpAttempts: [{
            attemptId: "attempt:1",
            passCount: 1,
            candidateCount: 1,
        }],
    }]);
    assert.equal(replay.replayRuntime.measuredRuntimeSha256, DIGEST_C);
    assert.deepEqual(
        replay.replayRuntime.artifacts.map((artifact) => artifact.role),
        ["replay_executable", "canonical_json_helper"],
    );
    assert.ok(replay.replayRuntime.artifacts.every((artifact) => (
        Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && /^[0-9a-f]{64}$/.test(artifact.sha256)
    )));
    assert.equal(replay.replayRuntime.policySource.kind, "canonical_inline");
    assert.match(replay.replayRuntime.sha256, /^[0-9a-f]{64}$/);
    assert.match(replay.sha256, /^[0-9a-f]{64}$/);
});

test("baseline replay uses the captured product depth for each Core pass", () => {
    const suite = taskSuite();
    const observations = observationSet(suite);
    for (const observation of observations.observations) {
        const trace = observation.response.hints.debugSearch.candidateSurvival;
        trace.corePasses[0].productCandidateLimit = 1;
        for (const stageName of ["raw_dense", "raw_lexical"]) {
            const stage = trace.stages.find((candidate) => candidate.stage === stageName);
            stage.candidates.push({
                ...stage.candidates[0],
                candidateId: "candidate-2",
                ownerId: '["file","src/secondary.ts"]',
                evidenceOccurrenceId: JSON.stringify(["candidate-2", stageName, 2]),
                relativePath: "src/secondary.ts",
                rank: 2,
                score: 0.5,
            });
            stage.totalOccurrences = 2;
            stage.uniqueCandidates = 2;
        }
        observation.responseBytes = Buffer.byteLength(JSON.stringify(observation.response), "utf8");
    }
    const capture = buildSearchCandidateCapture(suite, observations);

    const replay = replayBaselineCandidateCapture(capture);

    assert.equal(capture.captures[0].queryPlan.candidateLimit, 80);
    assert.equal(capture.captures[0].candidateTrace.corePasses[0].productCandidateLimit, 1);
    assert.equal(replay.tasks[0].corePasses[0].candidateCount, 1);
});

test("contender replay proves baseline first and carries a conditional OR candidate through both RRF stages", () => {
    const suite = taskSuite();
    suite.tasks[0].workload.invocations[0].args.debugCandidateLimit = 160;
    const capture = buildSearchCandidateCapture(
        suite,
        replayReadyObservationSet(suite),
        { requireReplayReady: true },
    );
    const replay = replayCandidateCapture(capture, contenderPolicy());

    assert.equal(replay.baselineReproduced, true);
    assert.equal(replay.providerValidationRequired, true);
    assert.deepEqual(replay.replayCoverage, {
        coreFusion: true,
        mcpFusion: true,
        postFusionLocalScoring: true,
        rerankerAdmission: true,
        rerankerProviderOutput: false,
        groupingAndDisclosure: false,
    });
    assert.equal(replay.tasks[0].corePasses[0].fallbackActivated, true);
    assert.deepEqual(
        replay.tasks[0].corePasses[0].candidates.map((candidate) => candidate.candidateId),
        ["candidate-1", "fallback-candidate"],
    );
    assert.deepEqual(
        replay.tasks[0].mcpAttempts[0].candidates.map((candidate) => candidate.candidateId),
        ["fallback-candidate", "candidate-1"],
    );
    assert.deepEqual(
        replay.tasks[0].rerankerAdmission.selectedCandidateIds,
        ["fallback-candidate", "candidate-1"],
    );
    assert.equal(replay.tasks[0].rerankerAdmission.inputUtf8Bytes, 200);
    assert.equal(replay.replayRuntime.policySource.kind, "canonical_inline");
    assert.match(replay.replayRuntime.policySource.sha256, /^[0-9a-f]{64}$/);

    const malformed = contenderPolicy();
    malformed.core.unrecognized = true;
    assert.throws(
        () => replayCandidateCapture(capture, malformed),
        /must contain exactly/,
    );
});

test("contender replay excludes a fallback candidate with a recorded diagnostic removal", () => {
    const suite = taskSuite();
    suite.tasks[0].workload.invocations[0].args.debugCandidateLimit = 160;
    const observations = replayReadyObservationSet(suite);
    for (const observation of observations.observations) {
        const trace = observation.response.hints.debugSearch.candidateSurvival;
        const signals = trace.stages.find((stage) => stage.stage === "mcp_replay_signals");
        signals.candidates = signals.candidates.filter(
            (candidate) => candidate.candidateId !== "fallback-candidate",
        );
        signals.totalOccurrences = signals.candidates.length;
        signals.uniqueCandidates = signals.candidates.length;
        trace.removals.push({
            candidateId: "fallback-candidate",
            afterStage: "mcp_filtered",
            reason: "scope_filter",
            passId: "attempt:1/diagnostic_replay",
        });
        observation.responseBytes = Buffer.byteLength(JSON.stringify(observation.response), "utf8");
    }
    const capture = buildSearchCandidateCapture(suite, observations, { requireReplayReady: true });

    const replay = replayCandidateCapture(capture, contenderPolicy());

    assert.deepEqual(replay.tasks[0].mcpAttempts[0].removed, [{
        candidateId: "fallback-candidate",
        reason: "scope_filter",
    }]);
    assert.deepEqual(replay.tasks[0].rerankerAdmission.selectedCandidateIds, ["candidate-1"]);
});

test("replay CLI binds the exact policy-file bytes and executable manifest", () => {
    const suite = taskSuite();
    suite.tasks[0].workload.invocations[0].args.debugCandidateLimit = 160;
    const capture = buildSearchCandidateCapture(
        suite,
        replayReadyObservationSet(suite),
        { requireReplayReady: true },
    );
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-replay-identity-"));
    try {
        const captureFile = path.join(temp, "capture.json");
        const policyFile = path.join(temp, "contender.json");
        const outputFile = path.join(temp, "replay.json");
        const policyBytes = Buffer.from(`${JSON.stringify(contenderPolicy(), null, 2)}\n`, "utf8");
        fs.writeFileSync(captureFile, JSON.stringify(capture));
        fs.writeFileSync(policyFile, policyBytes);

        const run = spawnSync(process.execPath, [
            REPLAY_SCRIPT_PATH,
            "--capture", captureFile,
            "--policy-file", policyFile,
            "--out", outputFile,
        ], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        const replay = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        assert.equal(replay.replayRuntime.policySource.kind, "file_bytes");
        assert.equal(replay.replayRuntime.policySource.fileName, "contender.json");
        assert.equal(replay.replayRuntime.policySource.bytes, policyBytes.length);
        assert.equal(
            replay.replayRuntime.policySource.sha256,
            crypto.createHash("sha256").update(policyBytes).digest("hex"),
        );
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("baseline replay rejects fusion score drift and tampered capture bytes", () => {
    const suite = taskSuite();
    const capture = buildSearchCandidateCapture(suite, observationSet(suite));
    const tampered = structuredClone(capture);
    tampered.captures[0].candidateTrace.stages.find(
        (stage) => stage.stage === "core_fusion",
    ).candidates[0].score = 0.5;
    assert.throws(
        () => replayBaselineCandidateCapture(tampered),
        /digest does not match/,
    );

    const internallyConsistent = structuredClone(tampered);
    internallyConsistent.captures[0].candidateTraceDigest = sha256Canonical(
        internallyConsistent.captures[0].candidateTrace,
    );
    const { sha256: _ignored, ...unsigned } = internallyConsistent;
    internallyConsistent.sha256 = sha256Canonical(unsigned);
    assert.throws(
        () => replayBaselineCandidateCapture(internallyConsistent),
        /Core pass.*score mismatch/,
    );
});

test("candidate capture rejects drift between cold and warm traces", () => {
    const suite = taskSuite();
    const observations = observationSet(suite);
    observations.observations[1].response.hints.debugSearch.candidateSurvival.stages[0]
        .candidates[0].candidateId = "different-candidate";
    observations.observations[1].responseBytes = Buffer.byteLength(
        JSON.stringify(observations.observations[1].response),
        "utf8",
    );

    assert.throws(
        () => buildSearchCandidateCapture(suite, observations),
        /changed candidateTraceDigest across cold\/warm samples/,
    );
});

test("candidate capture rejects missing no-sync evidence or a changed final index proof", () => {
    const suite = taskSuite();
    const mutatingObservation = observationSet(suite);
    mutatingObservation.observations[0].freshnessModes = ["synced"];
    assert.throws(
        () => buildSearchCandidateCapture(suite, mutatingObservation),
        /requires skipped_recent no-sync evidence/,
    );

    const driftedProof = observationSet(suite);
    driftedProof.metadata.taskRuns[0].finalIndexProof.generation = 8;
    assert.throws(
        () => buildSearchCandidateCapture(suite, driftedProof),
        /index proof changed during measured samples/,
    );
});

test("candidate capture fails closed when replay readiness is required", () => {
    const suite = taskSuite();
    assert.throws(
        () => buildSearchCandidateCapture(suite, observationSet(suite), { requireReplayReady: true }),
        /not replay-ready/,
    );
});

test("candidate capture rejects a dense plan without a query-vector digest", () => {
    const suite = taskSuite();
    const observations = observationSet(suite);
    for (const observation of observations.observations) {
        observation.response.hints.debugSearch.candidateSurvival.queryEmbeddings[0].sha256 = null;
        observation.responseBytes = Buffer.byteLength(JSON.stringify(observation.response), "utf8");
    }
    assert.throws(
        () => buildSearchCandidateCapture(suite, observations),
        /requires a query-embedding SHA-256 digest/,
    );
});

test("candidate capture rejects source-bearing or publication-unbound traces", () => {
    const suite = taskSuite();
    const sourceBearing = observationSet(suite);
    sourceBearing.observations[0].response.hints.debugSearch.candidateSurvival.stages[0]
        .candidates[0].content = "source must not enter the capture";
    sourceBearing.observations[0].responseBytes = Buffer.byteLength(
        JSON.stringify(sourceBearing.observations[0].response),
        "utf8",
    );
    assert.throws(
        () => buildSearchCandidateCapture(suite, sourceBearing),
        /must not contain source-bearing field 'content'/,
    );

    const republished = observationSet(suite);
    republished.observations[1].generationReceipt.publication.markerRunId = "replacement";
    assert.throws(
        () => buildSearchCandidateCapture(suite, republished),
        /not bound to the arm publication identity/,
    );
});

test("candidate capture rejects lexical fallback terms that do not match the recorded query digest", () => {
    const suite = taskSuite();
    const observations = replayReadyObservationSet(suite);
    observations.observations[0].response.hints.debugSearch.candidateSurvival.lexicalRequests[1]
        .terms.push("different");
    observations.observations[0].responseBytes = Buffer.byteLength(
        JSON.stringify(observations.observations[0].response),
        "utf8",
    );
    assert.throws(
        () => buildSearchCandidateCapture(suite, observations),
        /terms do not match querySha256/,
    );
});

test("candidate capture CLI rejects evaluation artifacts inside the indexed repository", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-capture-"));
    try {
        const repoRoot = path.join(temporary, "repo");
        const outside = path.join(temporary, "outside");
        fs.mkdirSync(repoRoot);
        fs.mkdirSync(outside);
        const suite = taskSuite();
        const observations = observationSet(suite);
        observations.metadata.repoRoot = repoRoot;
        const tasksFile = path.join(repoRoot, "tasks.json");
        const observationsFile = path.join(outside, "observations.json");
        fs.writeFileSync(tasksFile, JSON.stringify(suite));
        fs.writeFileSync(observationsFile, JSON.stringify(observations));

        const result = spawnSync(process.execPath, [
            SCRIPT_PATH,
            "--tasks", tasksFile,
            "--observations", observationsFile,
        ], { encoding: "utf8" });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Task suite must be outside the indexed repository/);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});
