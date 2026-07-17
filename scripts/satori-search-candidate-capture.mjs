#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
    canonicalJson,
    validateObservationSet,
    validateTaskSuite,
} from "./satori-useful-context.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TRACE_SCHEMA = "search_candidate_survival_v1";
const CAPTURE_VERSION = 1;
const REQUIRED_REPLAY_DEPTH = 160;

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

function requireSafeCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer.`);
    }
    return value;
}

function requirePositiveCount(value, label) {
    const count = requireSafeCount(value, label);
    if (count < 1) throw new Error(`${label} must be positive.`);
    return count;
}

function requireFiniteNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number.`);
    }
    return value;
}

function requireBoolean(value, label) {
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
    return value;
}

function requireExactKeys(value, keys, label) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`${label} must contain exactly: ${expected.join(", ")}.`);
    }
}

function requireSha256(value, label) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest.`);
    }
    return value;
}

function sha256Bytes(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value) {
    return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertNoSourcePayload(value, label) {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertNoSourcePayload(entry, `${label}[${index}]`));
        return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
        if (key === "content" || key === "preview" || key === "source") {
            throw new Error(`${label} must not contain source-bearing field '${key}'.`);
        }
        assertNoSourcePayload(entry, `${label}.${key}`);
    }
}

function normalizeCandidateTrace(value, label) {
    const trace = requireRecord(value, label);
    if (trace.schemaVersion !== TRACE_SCHEMA) {
        throw new Error(`${label}.schemaVersion must be ${TRACE_SCHEMA}.`);
    }
    const maxEntriesPerStage = requireSafeCount(
        trace.maxEntriesPerStage,
        `${label}.maxEntriesPerStage`,
    );
    if (maxEntriesPerStage < 1) {
        throw new Error(`${label}.maxEntriesPerStage must be positive.`);
    }
    if (!Array.isArray(trace.queryEmbeddings)) {
        throw new Error(`${label}.queryEmbeddings must be an array.`);
    }
    if (!Array.isArray(trace.corePasses)) {
        throw new Error(`${label}.corePasses must be an array.`);
    }
    const corePasses = trace.corePasses.map((raw, index) => {
        const entry = requireRecord(raw, `${label}.corePasses[${index}]`);
        requireExactKeys(
            entry,
            ["passId", "productCandidateLimit"],
            `${label}.corePasses[${index}]`,
        );
        return {
            passId: requireString(entry.passId, `${label}.corePasses[${index}].passId`),
            productCandidateLimit: requirePositiveCount(
                entry.productCandidateLimit,
                `${label}.corePasses[${index}].productCandidateLimit`,
            ),
        };
    });
    if (new Set(corePasses.map((entry) => entry.passId)).size !== corePasses.length) {
        throw new Error(`${label}.corePasses must contain one product depth per passId.`);
    }
    const queryEmbeddings = trace.queryEmbeddings.map((raw, index) => {
        const entry = requireRecord(raw, `${label}.queryEmbeddings[${index}]`);
        const sha256 = entry.sha256 === null
            ? null
            : requireSha256(entry.sha256, `${label}.queryEmbeddings[${index}].sha256`);
        return {
            passId: requireString(entry.passId, `${label}.queryEmbeddings[${index}].passId`),
            sha256,
        };
    });
    if (!Array.isArray(trace.lexicalRequests)) {
        throw new Error(`${label}.lexicalRequests must be an array.`);
    }
    const lexicalRequests = trace.lexicalRequests.map((raw, index) => {
        const entry = requireRecord(raw, `${label}.lexicalRequests[${index}]`);
        if (!["all_terms", "any_terms", "provider_sparse", "unspecified"].includes(entry.matchMode)) {
            throw new Error(`${label}.lexicalRequests[${index}].matchMode is unsupported.`);
        }
        if (!["primary", "fallback_or"].includes(entry.role)) {
            throw new Error(`${label}.lexicalRequests[${index}].role is unsupported.`);
        }
        if (entry.terms !== undefined && !Array.isArray(entry.terms)) {
            throw new Error(`${label}.lexicalRequests[${index}].terms must be an array.`);
        }
        const terms = entry.terms?.map((term, termIndex) => requireString(
            term,
            `${label}.lexicalRequests[${index}].terms[${termIndex}]`,
        ));
        const querySha256 = requireSha256(
            entry.querySha256,
            `${label}.lexicalRequests[${index}].querySha256`,
        );
        if (terms && sha256Bytes(Buffer.from(terms.join(" "), "utf8")) !== querySha256) {
            throw new Error(`${label}.lexicalRequests[${index}] terms do not match querySha256.`);
        }
        return {
            passId: requireString(entry.passId, `${label}.lexicalRequests[${index}].passId`),
            role: entry.role,
            querySha256,
            matchMode: entry.matchMode,
            ...(terms ? { terms } : {}),
        };
    });
    if (!Array.isArray(trace.stages)) throw new Error(`${label}.stages must be an array.`);
    const stages = trace.stages.map((raw, stageIndex) => {
        const stage = requireRecord(raw, `${label}.stages[${stageIndex}]`);
        if (!Array.isArray(stage.candidates)) {
            throw new Error(`${label}.stages[${stageIndex}].candidates must be an array.`);
        }
        if (stage.candidates.length > maxEntriesPerStage) {
            throw new Error(`${label}.stages[${stageIndex}] exceeds maxEntriesPerStage.`);
        }
        const totalOccurrences = requireSafeCount(
            stage.totalOccurrences,
            `${label}.stages[${stageIndex}].totalOccurrences`,
        );
        const omittedOccurrences = requireSafeCount(
            stage.omittedOccurrences,
            `${label}.stages[${stageIndex}].omittedOccurrences`,
        );
        if (totalOccurrences !== stage.candidates.length + omittedOccurrences) {
            throw new Error(`${label}.stages[${stageIndex}] occurrence accounting is inconsistent.`);
        }
        if (stage.weight !== undefined && (!Number.isFinite(stage.weight) || stage.weight <= 0)) {
            throw new Error(`${label}.stages[${stageIndex}].weight must be a positive finite number.`);
        }
        requireSafeCount(stage.uniqueCandidates, `${label}.stages[${stageIndex}].uniqueCandidates`);
        for (let candidateIndex = 0; candidateIndex < stage.candidates.length; candidateIndex += 1) {
            const candidate = requireRecord(
                stage.candidates[candidateIndex],
                `${label}.stages[${stageIndex}].candidates[${candidateIndex}]`,
            );
            requireString(candidate.candidateId, `${label} candidateId`);
            requireString(candidate.ownerId, `${label} ownerId`);
            requireString(candidate.evidenceOccurrenceId, `${label} evidenceOccurrenceId`);
            requirePositiveCount(candidate.rank, `${label} candidate rank`);
            if (stage.stage === "mcp_replay_signals") {
                const replayLabel = `${label}.stages[${stageIndex}].candidates[${candidateIndex}].replay`;
                const replay = requireRecord(candidate.replay, replayLabel);
                requireExactKeys(replay, [
                    "lexicalScore",
                    "pathMultiplier",
                    "changedFilesMultiplier",
                    "agentFitMultiplier",
                    "exactLexicalMatch",
                    "passesMatchedMust",
                    "rerankFamilyId",
                    "rerankDocumentUtf8Bytes",
                    "symbolLabel",
                    "symbolId",
                ], replayLabel);
                requireFiniteNumber(replay.lexicalScore, `${replayLabel}.lexicalScore`);
                requireFiniteNumber(replay.pathMultiplier, `${replayLabel}.pathMultiplier`);
                requireFiniteNumber(
                    replay.changedFilesMultiplier,
                    `${replayLabel}.changedFilesMultiplier`,
                );
                requireFiniteNumber(replay.agentFitMultiplier, `${replayLabel}.agentFitMultiplier`);
                requireBoolean(replay.exactLexicalMatch, `${replayLabel}.exactLexicalMatch`);
                requireBoolean(replay.passesMatchedMust, `${replayLabel}.passesMatchedMust`);
                requireString(replay.rerankFamilyId, `${replayLabel}.rerankFamilyId`);
                requireSafeCount(
                    replay.rerankDocumentUtf8Bytes,
                    `${replayLabel}.rerankDocumentUtf8Bytes`,
                );
                for (const field of ["symbolLabel", "symbolId"]) {
                    if (replay[field] !== null && typeof replay[field] !== "string") {
                        throw new Error(`${replayLabel}.${field} must be a string or null.`);
                    }
                }
            } else if (candidate.replay !== undefined) {
                throw new Error(`${label}.stages[${stageIndex}] replay data is only valid for mcp_replay_signals.`);
            }
        }
        return jsonClone(stage);
    });
    if (!Array.isArray(trace.removals)) throw new Error(`${label}.removals must be an array.`);
    if (trace.removals.length > maxEntriesPerStage) {
        throw new Error(`${label}.removals exceeds maxEntriesPerStage.`);
    }
    for (let index = 0; index < trace.removals.length; index += 1) {
        const removal = requireRecord(trace.removals[index], `${label}.removals[${index}]`);
        requireString(removal.candidateId, `${label}.removals[${index}].candidateId`);
        requireString(removal.afterStage, `${label}.removals[${index}].afterStage`);
        requireString(removal.reason, `${label}.removals[${index}].reason`);
        if (removal.passId !== undefined) {
            requireString(removal.passId, `${label}.removals[${index}].passId`);
        }
    }
    const omittedRemovals = requireSafeCount(trace.omittedRemovals, `${label}.omittedRemovals`);
    const normalized = {
        schemaVersion: TRACE_SCHEMA,
        maxEntriesPerStage,
        corePasses,
        queryEmbeddings,
        lexicalRequests,
        stages,
        removals: jsonClone(trace.removals),
        omittedRemovals,
    };
    assertNoSourcePayload(normalized, label);
    return normalized;
}

function publicationIdentityFromArmProof(value) {
    const proof = requireRecord(value, "Observation metadata armIndexProof");
    const publication = requireRecord(proof.publication, "Observation metadata publication");
    const publicationKeys = Object.keys(publication).sort();
    const expectedKeys = [
        "collectionName",
        "indexPolicyHash",
        "markerRunId",
        "policyDocumentDigest",
    ].sort();
    if (canonicalJson(publicationKeys) !== canonicalJson(expectedKeys)) {
        throw new Error("Observation metadata publication must contain exactly the v1 identity fields.");
    }
    requireString(proof.canonicalRoot, "Observation metadata canonicalRoot");
    requireSafeCount(proof.generation, "Observation metadata generation");
    requireRecord(proof.runtimeFingerprint, "Observation metadata runtimeFingerprint");
    requireString(publication.collectionName, "Observation metadata publication collectionName");
    requireString(publication.markerRunId, "Observation metadata publication markerRunId");
    requireSha256(publication.indexPolicyHash, "Observation metadata publication indexPolicyHash");
    requireSha256(publication.policyDocumentDigest, "Observation metadata publication policyDocumentDigest");
    return {
        canonicalRoot: proof.canonicalRoot,
        generation: proof.generation,
        runtimeFingerprint: jsonClone(proof.runtimeFingerprint),
        publication: jsonClone(publication),
    };
}

function observationGenerationIdentity(armIdentity) {
    return {
        canonicalRoot: armIdentity.canonicalRoot,
        runtimeFingerprint: armIdentity.runtimeFingerprint,
        publication: armIdentity.publication,
    };
}

function assertMeasurementIsolation(metadata, observationSetValue, taskIds) {
    if (!Array.isArray(metadata.taskRuns)) {
        throw new Error("Observation metadata taskRuns must prove frozen measurement isolation.");
    }
    for (const taskId of taskIds) {
        const taskRuns = metadata.taskRuns.filter((taskRun) => taskRun?.taskId === taskId);
        if (taskRuns.length !== 1) {
            throw new Error(`Task '${taskId}' must have exactly one measurement-isolation receipt.`);
        }
        const taskRun = requireRecord(taskRuns[0], `Task '${taskId}' measurement receipt`);
        const syncStats = requireRecord(taskRun.syncStats, `Task '${taskId}' syncStats`);
        if ([syncStats.added, syncStats.removed, syncStats.modified].some((value) => value !== 0)) {
            throw new Error(`Task '${taskId}' measurement preparation was not a zero-change sync.`);
        }
        const preparedProof = requireRecord(taskRun.indexProof, `Task '${taskId}' prepared index proof`);
        const finalProof = requireRecord(taskRun.finalIndexProof, `Task '${taskId}' final index proof`);
        if (canonicalJson(preparedProof) !== canonicalJson(finalProof)) {
            throw new Error(`Task '${taskId}' index proof changed during measured samples.`);
        }
    }
    for (const observation of observationSetValue.observations) {
        if (!Array.isArray(observation.freshnessModes)
            || observation.freshnessModes.length === 0
            || observation.freshnessModes.some((mode) => mode !== "skipped_recent")) {
            throw new Error(
                `Task '${observation.taskId}' candidate capture requires skipped_recent no-sync evidence for every measured call.`,
            );
        }
    }
}

function buildQueryPlan(invocation, debugSearch, trace) {
    const query = requireString(invocation.args.query, "Search invocation query");
    const retrieval = jsonClone(requireRecord(debugSearch.retrieval, "debugSearch.retrieval"));
    if ((retrieval.mode === "dense" || retrieval.mode === "hybrid")
        && !trace.queryEmbeddings.some((entry) => entry.sha256 !== null)) {
        throw new Error("Dense or hybrid candidate capture requires a query-embedding SHA-256 digest.");
    }
    const queryPlan = {
        invocationArgs: jsonClone(invocation.args),
        queryUtf8Sha256: sha256Bytes(Buffer.from(query, "utf8")),
        queryUtf8Bytes: Buffer.byteLength(query, "utf8"),
        queryEmbeddings: jsonClone(trace.queryEmbeddings),
        lexicalRequests: jsonClone(trace.lexicalRequests),
        route: jsonClone(requireRecord(debugSearch.route, "debugSearch.route")),
        queryIntent: jsonClone(requireRecord(debugSearch.queryIntent, "debugSearch.queryIntent")),
        retrieval,
        operatorSummary: jsonClone(requireRecord(
            debugSearch.operatorSummary,
            "debugSearch.operatorSummary",
        )),
        candidateLimit: requireSafeCount(debugSearch.candidateLimit, "debugSearch.candidateLimit"),
        diagnosticCandidateLimit: debugSearch.diagnosticCandidateLimit === undefined
            ? null
            : requireSafeCount(
                debugSearch.diagnosticCandidateLimit,
                "debugSearch.diagnosticCandidateLimit",
            ),
        mustRetry: jsonClone(requireRecord(debugSearch.mustRetry, "debugSearch.mustRetry")),
    };
    return { queryPlan, queryPlanDigest: sha256Canonical(queryPlan) };
}

function buildPassConfiguration(debugSearch) {
    if (!Array.isArray(debugSearch.passesUsed)) {
        throw new Error("debugSearch.passesUsed must be an array.");
    }
    const passConfiguration = {
        passesUsed: jsonClone(debugSearch.passesUsed),
        semanticExpansion: debugSearch.semanticExpansion === undefined
            ? null
            : jsonClone(debugSearch.semanticExpansion),
        rankingProvenance: jsonClone(requireRecord(
            debugSearch.rankingProvenance,
            "debugSearch.rankingProvenance",
        )),
        mcpFusion: jsonClone(requireRecord(debugSearch.mcpFusion, "debugSearch.mcpFusion")),
        providerWork: jsonClone(requireRecord(debugSearch.providerWork, "debugSearch.providerWork")),
        trackedLexical: debugSearch.trackedLexical === undefined
            ? null
            : jsonClone(debugSearch.trackedLexical),
        exactRegistry: debugSearch.exactRegistry === undefined
            ? null
            : jsonClone(debugSearch.exactRegistry),
        filterSummary: jsonClone(requireRecord(debugSearch.filterSummary, "debugSearch.filterSummary")),
        diversitySummary: debugSearch.diversitySummary === undefined
            ? null
            : jsonClone(debugSearch.diversitySummary),
        changedFilesBoost: jsonClone(requireRecord(
            debugSearch.changedFilesBoost,
            "debugSearch.changedFilesBoost",
        )),
        rerank: debugSearch.rerank === undefined ? null : jsonClone(debugSearch.rerank),
    };
    return {
        passConfiguration,
        passConfigurationDigest: sha256Canonical(passConfiguration),
    };
}

function buildObservationCapture(task, observation) {
    if (task.workload.invocations.length !== 1
        || task.workload.invocations[0].tool !== "search_codebase") {
        throw new Error(
            `Task '${task.id}' candidate capture requires exactly one measured search_codebase invocation.`,
        );
    }
    if (observation.status !== "ok") {
        throw new Error(`Task '${task.id}' candidate capture requires successful observations.`);
    }
    const debugSearch = requireRecord(
        observation.response?.hints?.debugSearch,
        `Task '${task.id}' debugSearch`,
    );
    const trace = normalizeCandidateTrace(
        debugSearch.candidateSurvival,
        `Task '${task.id}' candidateSurvival`,
    );
    const { queryPlan, queryPlanDigest } = buildQueryPlan(
        task.workload.invocations[0],
        debugSearch,
        trace,
    );
    const { passConfiguration, passConfigurationDigest } = buildPassConfiguration(debugSearch);
    const candidateTraceDigest = sha256Canonical(trace);
    return {
        queryPlan,
        queryPlanDigest,
        passConfiguration,
        passConfigurationDigest,
        candidateTrace: trace,
        candidateTraceDigest,
        rankedResultIdentityDigest: sha256Canonical(observation.results),
    };
}

function replayReadiness(capture) {
    const fusionReasons = [];
    if (capture.queryPlan.diagnosticCandidateLimit === null
        || capture.queryPlan.diagnosticCandidateLimit < REQUIRED_REPLAY_DEPTH) {
        fusionReasons.push("diagnostic_candidate_limit_below_160");
    }
    if (capture.candidateTrace.maxEntriesPerStage < REQUIRED_REPLAY_DEPTH) {
        fusionReasons.push("trace_limit_below_160");
    }
    const hasAllTermsRequest = capture.queryPlan.lexicalRequests.some(
        (request) => request.matchMode === "all_terms",
    );
    if (capture.queryPlan.retrieval.mode !== "dense"
        && !capture.queryPlan.lexicalRequests.some((request) => (
            request.matchMode === "all_terms" || request.matchMode === "provider_sparse"
        ))) {
        fusionReasons.push("lexical_operator_not_recorded");
    }
    if (hasAllTermsRequest && !capture.queryPlan.lexicalRequests.some(
        (request) => request.matchMode === "any_terms" && request.role === "fallback_or",
    )) {
        fusionReasons.push("conditional_or_superset_not_recorded");
    }
    if (hasAllTermsRequest && !capture.queryPlan.lexicalRequests.some((request) => (
        request.matchMode === "any_terms"
        && request.role === "fallback_or"
        && Array.isArray(request.terms)
        && request.terms.length > 0
    ))) {
        fusionReasons.push("conditional_or_terms_not_recorded");
    }
    const fusionStageNames = new Set([
        "raw_dense",
        "raw_lexical",
        "raw_lexical_fallback",
        "core_fusion",
        "core_result",
        "mcp_pass",
        "mcp_fusion",
    ]);
    if (capture.candidateTrace.stages.some((stage) => (
        fusionStageNames.has(stage.stage) && stage.omittedOccurrences > 0
    ))) {
        fusionReasons.push("fusion_trace_truncated");
    }
    const outputPassIds = capture.candidateTrace.stages
        .filter((stage) => stage.stage === "core_fusion" || stage.stage === "core_result")
        .map((stage) => stage.passId);
    if (outputPassIds.length === 0 || outputPassIds.some((passId) => (
        typeof passId !== "string"
        || capture.candidateTrace.corePasses.filter((entry) => entry.passId === passId).length !== 1
    ))) {
        fusionReasons.push("core_product_depth_not_recorded");
    }
    const mcpFusionAttempts = capture.candidateTrace.stages
        .filter((stage) => stage.stage === "mcp_fusion")
        .map((stage) => stage.passId);
    if (mcpFusionAttempts.length === 0) fusionReasons.push("mcp_fusion_not_recorded");
    if (!Number.isSafeInteger(capture.passConfiguration.mcpFusion?.rrfK)
        || capture.passConfiguration.mcpFusion.rrfK < 1) {
        fusionReasons.push("mcp_fusion_policy_not_recorded");
    }

    const survivalReasons = [...fusionReasons];
    const hasReplaySignalsForAttempt = (attemptId) => capture.candidateTrace.stages.some((stage) => (
        stage.stage === "mcp_replay_signals"
        && typeof stage.passId === "string"
        && (stage.passId === attemptId || stage.passId.startsWith(`${attemptId}/replay:`))
    ));
    if (mcpFusionAttempts.some((attemptId) => (
        typeof attemptId !== "string" || !hasReplaySignalsForAttempt(attemptId)
    ))) {
        survivalReasons.push("mcp_replay_signals_not_recorded");
    }
    const survivalStageNames = new Set([
        "mcp_replay_signals",
        "mcp_filtered",
        "reranker_input",
    ]);
    if (capture.candidateTrace.omittedRemovals > 0) {
        survivalReasons.push("candidate_removals_truncated");
    }
    if (capture.candidateTrace.stages.some((stage) => (
        survivalStageNames.has(stage.stage) && stage.omittedOccurrences > 0
    ))) {
        survivalReasons.push("survival_trace_truncated");
    }
    const rerank = capture.passConfiguration.rerank;
    if (!isRecord(rerank)
        || !Number.isSafeInteger(rerank.requestedResultLimit)
        || rerank.requestedResultLimit < 1
        || !isRecord(rerank.selectionPolicy)) {
        survivalReasons.push("reranker_admission_policy_not_recorded");
    }
    const uniqueSorted = (values) => [...new Set(values)].sort();
    const normalizedFusionReasons = uniqueSorted(fusionReasons);
    const normalizedSurvivalReasons = uniqueSorted(survivalReasons);
    const agentReasons = uniqueSorted([
        ...normalizedSurvivalReasons,
        "agent_replay_not_implemented",
    ]);
    return {
        fusionReplayReady: normalizedFusionReasons.length === 0,
        survivalTraceComplete: normalizedSurvivalReasons.length === 0,
        agentReplayReady: false,
        requiredDepth: REQUIRED_REPLAY_DEPTH,
        fusionReasons: normalizedFusionReasons,
        survivalReasons: normalizedSurvivalReasons,
        agentReasons,
    };
}

export function buildSearchCandidateCapture(taskSuiteValue, observationSetValue, options = {}) {
    const taskSuite = validateTaskSuite(taskSuiteValue);
    validateObservationSet(observationSetValue, taskSuite.tasks.map((task) => task.id));
    const metadata = requireRecord(observationSetValue.metadata, "Observation metadata");
    assertMeasurementIsolation(
        metadata,
        observationSetValue,
        taskSuite.tasks.map((task) => task.id),
    );
    const taskSuiteSha256 = sha256Canonical(taskSuite);
    if (metadata.taskSuiteSha256 !== taskSuiteSha256) {
        throw new Error("Observation metadata task-suite digest does not match the supplied task suite.");
    }
    const runtime = requireRecord(metadata.qualificationRuntime, "Observation qualificationRuntime");
    requireSha256(runtime.sha256, "Observation qualificationRuntime.sha256");
    const armPublication = publicationIdentityFromArmProof(metadata.armIndexProof);
    const expectedGeneration = observationGenerationIdentity(armPublication);
    const policyId = requireString(options.policyId ?? "baseline", "Candidate capture policyId");
    const captures = taskSuite.tasks.map((task) => {
        const taskObservations = observationSetValue.observations.filter(
            (observation) => observation.taskId === task.id,
        );
        if (taskObservations.length === 0) {
            throw new Error(`Task '${task.id}' has no observations.`);
        }
        const observedCaptures = taskObservations.map((observation) => {
            if (canonicalJson(observation.generationReceipt) !== canonicalJson(expectedGeneration)) {
                throw new Error(`Task '${task.id}' is not bound to the arm publication identity.`);
            }
            return buildObservationCapture(task, observation);
        });
        const baseline = observedCaptures[0];
        for (const contender of observedCaptures.slice(1)) {
            for (const key of [
                "queryPlanDigest",
                "passConfigurationDigest",
                "candidateTraceDigest",
                "rankedResultIdentityDigest",
            ]) {
                if (contender[key] !== baseline[key]) {
                    throw new Error(`Task '${task.id}' changed ${key} across cold/warm samples.`);
                }
            }
        }
        return {
            taskId: task.id,
            queryClass: task.queryClass,
            language: task.language,
            expected: jsonClone(task.expected),
            policyId,
            stableSampleCount: observedCaptures.length,
            ...baseline,
            readiness: replayReadiness(baseline),
        };
    });
    const fusionIncompleteTasks = captures
        .filter((capture) => !capture.readiness.fusionReplayReady)
        .map((capture) => capture.taskId);
    const survivalIncompleteTasks = captures
        .filter((capture) => !capture.readiness.survivalTraceComplete)
        .map((capture) => capture.taskId);
    const agentIncompleteTasks = captures
        .filter((capture) => !capture.readiness.agentReplayReady)
        .map((capture) => capture.taskId);
    if (options.requireReplayReady === true && survivalIncompleteTasks.length > 0) {
        throw new Error(
            `Candidate captures are not replay-ready for complete fusion and survival authority: ${survivalIncompleteTasks.join(", ")}.`,
        );
    }
    const capture = {
        version: CAPTURE_VERSION,
        kind: "satori_search_candidate_capture",
        policyId,
        authority: {
            gitRevision: requireString(metadata.gitRevision, "Observation metadata gitRevision"),
            taskSuiteSha256,
            observationSetSha256: sha256Canonical(observationSetValue),
            runtimeSha256: runtime.sha256,
            armPublication,
        },
        replayReadiness: {
            fusionReady: fusionIncompleteTasks.length === 0,
            survivalReady: survivalIncompleteTasks.length === 0,
            agentReady: agentIncompleteTasks.length === 0,
            fusionIncompleteTasks,
            survivalIncompleteTasks,
            agentIncompleteTasks,
        },
        captures,
    };
    return { ...capture, sha256: sha256Canonical(capture) };
}

function parseArgs(argv) {
    const options = {
        tasksFile: null,
        observationsFile: null,
        outFile: null,
        policyId: "baseline",
        requireReplayReady: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value after ${arg}.`);
            return argv[index];
        };
        if (arg === "--tasks") options.tasksFile = path.resolve(next());
        else if (arg === "--observations") options.observationsFile = path.resolve(next());
        else if (arg === "--out") options.outFile = path.resolve(next());
        else if (arg === "--policy") options.policyId = next();
        else if (arg === "--require-replay-ready") options.requireReplayReady = true;
        else if (arg === "--help") options.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!options.help && (!options.tasksFile || !options.observationsFile)) {
        throw new Error("--tasks and --observations are required.");
    }
    return options;
}

function usage() {
    return [
        "Usage: node scripts/satori-search-candidate-capture.mjs --tasks <tasks.json> --observations <observations.json> [options]",
        "Options:",
        "  --out <capture.json>",
        "  --policy <id>                 Policy selector recorded in the capture (default: baseline)",
        "  --require-replay-ready        Reject traces that lack top-160/lexical-fallback authority",
    ].join("\n");
}

function assertArtifactOutsideRepository(file, repoRoot, label, allowMissing = false) {
    const canonicalRoot = fs.realpathSync(repoRoot);
    let canonicalFile;
    if (fs.existsSync(file)) {
        canonicalFile = fs.realpathSync(file);
    } else if (allowMissing) {
        const canonicalParent = fs.realpathSync(path.dirname(file));
        canonicalFile = path.join(canonicalParent, path.basename(file));
    } else {
        throw new Error(`${label} '${file}' does not exist.`);
    }
    const relative = path.relative(canonicalRoot, canonicalFile);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        throw new Error(`${label} must be outside the indexed repository.`);
    }
}

export function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return null;
    }
    const taskSuite = JSON.parse(fs.readFileSync(options.tasksFile, "utf8"));
    const observations = JSON.parse(fs.readFileSync(options.observationsFile, "utf8"));
    const repositoryRoot = requireString(
        requireRecord(observations.metadata, "Observation metadata").repoRoot,
        "Observation metadata repoRoot",
    );
    assertArtifactOutsideRepository(options.tasksFile, repositoryRoot, "Task suite");
    assertArtifactOutsideRepository(options.observationsFile, repositoryRoot, "Observation set");
    if (options.outFile) {
        assertArtifactOutsideRepository(options.outFile, repositoryRoot, "Candidate capture output", true);
    }
    const capture = buildSearchCandidateCapture(taskSuite, observations, options);
    const serialized = `${JSON.stringify(capture, null, 2)}\n`;
    if (options.outFile) fs.writeFileSync(options.outFile, serialized);
    else process.stdout.write(serialized);
    return capture;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`satori-search-candidate-capture: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        process.exitCode = 1;
    }
}
