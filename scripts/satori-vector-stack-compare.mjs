#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { hashTaskSuite } from "./satori-useful-context-record.mjs";
import {
    canonicalJson,
    summarizeUsefulContext,
    validateObservationSet,
    validateTaskSuite,
} from "./satori-useful-context.mjs";

const PROVIDER_WORK_KEYS = [
    "semanticSearchAttempts",
    "embeddingCallsByCurrentContract",
    "denseQueriesByCurrentContract",
    "sparseQueriesByCurrentContract",
    "rerankerCalls",
    "rerankerCandidates",
    "rerankerInputBytes",
    "candidatesWithSemanticEvidence",
    "candidatesWithLexicalEvidence",
    "candidatesWithCurrentSourceEvidence",
];

const CURRENT_FINGERPRINT_FIELDS = [
    "embeddingProvider",
    "embeddingModel",
    "embeddingDimension",
    "embeddingArtifactDigest",
    "embeddingNormalizationPolicy",
    "vectorStoreProvider",
    "schemaVersion",
    "parserVersion",
    "extractorVersion",
    "relationshipVersion",
    "embeddingProjectionVersion",
    "lexicalProjectionVersion",
];

const EMBEDDING_CHANGE_FIELDS = new Set([
    "embeddingProvider",
    "embeddingModel",
    "embeddingDimension",
    "embeddingArtifactDigest",
]);
const STORAGE_CHANGE_FIELDS = new Set(["vectorStoreProvider"]);

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);
    return value;
}

function requireString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value;
}

function parsePublicationReceipt(value, label) {
    const receipt = requireRecord(value, label);
    const expectedKeys = [
        "collectionName",
        "indexPolicyHash",
        "markerRunId",
        "policyDocumentDigest",
    ];
    if (canonicalJson(Object.keys(receipt).sort()) !== canonicalJson(expectedKeys)) {
        throw new Error(`${label} must contain exactly ${expectedKeys.join(", ")}.`);
    }
    const indexPolicyHash = requireString(receipt.indexPolicyHash, `${label}.indexPolicyHash`);
    const policyDocumentDigest = requireString(receipt.policyDocumentDigest, `${label}.policyDocumentDigest`);
    if (!/^[a-f0-9]{64}$/.test(indexPolicyHash) || !/^[a-f0-9]{64}$/.test(policyDocumentDigest)) {
        throw new Error(`${label} hashes must be lowercase SHA-256 values.`);
    }
    return {
        collectionName: requireString(receipt.collectionName, `${label}.collectionName`),
        markerRunId: requireString(receipt.markerRunId, `${label}.markerRunId`),
        indexPolicyHash,
        policyDocumentDigest,
    };
}

function observationKey(observation) {
    return observation.sample === undefined
        ? `${observation.taskId}:${observation.phase}`
        : `${observation.taskId}:${observation.phase}:${observation.sample}`;
}

function resultIdentities(observation) {
    return observation.results.map((result) => JSON.stringify([result.file, result.symbol]));
}

function roundMetric(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}

function agreementForPairs(pairs) {
    let jaccardTotal = 0;
    let exactOrderMatches = 0;
    let topResultMatches = 0;
    for (const [left, right] of pairs) {
        const leftResults = resultIdentities(left);
        const rightResults = resultIdentities(right);
        const leftSet = new Set(leftResults);
        const rightSet = new Set(rightResults);
        const union = new Set([...leftSet, ...rightSet]);
        const intersectionSize = [...leftSet].filter((identity) => rightSet.has(identity)).length;
        jaccardTotal += union.size === 0 ? 1 : intersectionSize / union.size;
        if (canonicalJson(leftResults) === canonicalJson(rightResults)) exactOrderMatches += 1;
        if ((leftResults[0] ?? null) === (rightResults[0] ?? null)) topResultMatches += 1;
    }
    return {
        observationCount: pairs.length,
        meanJaccard: roundMetric(jaccardTotal / pairs.length),
        exactOrderMatches,
        topResultMatches,
    };
}

function providerWorkSummary(observations) {
    const totals = Object.fromEntries(PROVIDER_WORK_KEYS.map((key) => [key, 0]));
    let observationsWithDiagnostics = 0;
    const retrievalModes = new Map();
    const routeKinds = new Map();
    for (const observation of observations) {
        if (observation.status !== "ok") {
            throw new Error(`Observation '${observationKey(observation)}' is not successful.`);
        }
        const debugSearch = requireRecord(
            observation.response?.hints?.debugSearch,
            `Observation '${observationKey(observation)}' debugSearch`,
        );
        const providerWork = requireRecord(
            debugSearch.providerWork,
            `Observation '${observationKey(observation)}' providerWork`,
        );
        observationsWithDiagnostics += 1;
        for (const key of PROVIDER_WORK_KEYS) {
            const value = providerWork[key];
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new Error(`Observation '${observationKey(observation)}' has invalid providerWork.${key}.`);
            }
            totals[key] += value;
        }
        const retrieval = requireRecord(
            debugSearch.retrieval,
            `Observation '${observationKey(observation)}' retrieval diagnostics`,
        );
        const retrievalMode = requireString(
            retrieval.mode,
            `Observation '${observationKey(observation)}' retrieval mode`,
        );
        if (!["dense", "lexical", "hybrid"].includes(retrievalMode)) {
            throw new Error(`Observation '${observationKey(observation)}' has unsupported retrieval mode '${retrievalMode}'.`);
        }
        retrievalModes.set(retrievalMode, (retrievalModes.get(retrievalMode) ?? 0) + 1);
        const route = requireRecord(
            debugSearch.route,
            `Observation '${observationKey(observation)}' route diagnostics`,
        );
        const routeKind = requireString(
            route.kind,
            `Observation '${observationKey(observation)}' route kind`,
        );
        routeKinds.set(routeKind, (routeKinds.get(routeKind) ?? 0) + 1);
    }
    const sortedCounts = (counts) => Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
    return {
        observationsWithDiagnostics,
        totals,
        retrievalModes: sortedCounts(retrievalModes),
        routeKinds: sortedCounts(routeKinds),
    };
}

function parseCurrentFingerprint(value, label) {
    const fingerprint = requireRecord(value, label);
    const keys = Object.keys(fingerprint).sort();
    const expectedKeys = [...CURRENT_FINGERPRINT_FIELDS].sort();
    if (canonicalJson(keys) !== canonicalJson(expectedKeys)) {
        throw new Error(`${label} must contain exactly the current fingerprint fields.`);
    }
    if (!["OpenAI", "VoyageAI", "Gemini", "Ollama"].includes(fingerprint.embeddingProvider)) {
        throw new Error(`${label} has an unsupported embedding provider.`);
    }
    requireString(fingerprint.embeddingModel, `${label} embedding model`);
    if (!Number.isSafeInteger(fingerprint.embeddingDimension) || fingerprint.embeddingDimension <= 0) {
        throw new Error(`${label} embedding dimension must be a positive integer.`);
    }
    if (fingerprint.embeddingArtifactDigest !== null
        && (typeof fingerprint.embeddingArtifactDigest !== "string"
            || !/^[a-f0-9]{64}$/.test(fingerprint.embeddingArtifactDigest))) {
        throw new Error(`${label} artifact digest must be null or a lowercase SHA-256 digest.`);
    }
    if (!["Milvus", "LanceDB"].includes(fingerprint.vectorStoreProvider)) {
        throw new Error(`${label} has an unsupported vector store provider.`);
    }
    if (!["dense_v3", "hybrid_v3"].includes(fingerprint.schemaVersion)) {
        throw new Error(`${label} has an unsupported schema version.`);
    }
    for (const key of [
        "embeddingNormalizationPolicy",
        "parserVersion",
        "extractorVersion",
        "relationshipVersion",
        "embeddingProjectionVersion",
        "lexicalProjectionVersion",
    ]) {
        requireString(fingerprint[key], `${label} ${key}`);
    }
    return structuredClone(fingerprint);
}

function extractFingerprint(metadata, taskIds, armId, repoRoot) {
    if (!Array.isArray(metadata.taskRuns)) {
        throw new Error(`Arm '${armId}' metadata.taskRuns must be an array.`);
    }
    const armIndexProof = requireRecord(metadata.armIndexProof, `Arm '${armId}' arm-level index proof`);
    requireString(armIndexProof.id, `Arm '${armId}' arm-level operation id`);
    if (armIndexProof.action !== "sync"
        || armIndexProof.phase !== "completed"
        || armIndexProof.canonicalRoot !== repoRoot
        || !Number.isSafeInteger(armIndexProof.generation)
        || armIndexProof.generation < 0) {
        throw new Error(`Arm '${armId}' has no completed arm-level generation proof.`);
    }
    requireString(
        armIndexProof.lastDurableTransitionAt,
        `Arm '${armId}' arm-level durable transition time`,
    );
    const armFingerprint = parseCurrentFingerprint(
        armIndexProof.runtimeFingerprint,
        `Arm '${armId}' arm-level runtime fingerprint`,
    );
    const armPublication = parsePublicationReceipt(
        armIndexProof.publication,
        `Arm '${armId}' arm-level publication proof`,
    );
    const expectedPublication = canonicalJson({
        canonicalRoot: repoRoot,
        generation: armIndexProof.generation,
        runtimeFingerprint: armFingerprint,
        publication: armPublication,
    });
    const byTask = new Map();
    for (const run of metadata.taskRuns) {
        const record = requireRecord(run, `Arm '${armId}' task run`);
        const taskId = requireString(record.taskId, `Arm '${armId}' task run id`);
        if (byTask.has(taskId)) throw new Error(`Arm '${armId}' has duplicate task run '${taskId}'.`);
        const syncStats = requireRecord(record.syncStats, `Arm '${armId}' task '${taskId}' sync stats`);
        for (const key of ["added", "removed", "modified"]) {
            if (syncStats[key] !== 0) {
                throw new Error(`Arm '${armId}' task '${taskId}' did not prove a no-change syncStats.${key}=0.`);
            }
        }
        const proof = requireRecord(record.indexProof, `Arm '${armId}' task '${taskId}' index proof`);
        if (proof.action !== "sync"
            || proof.phase !== "completed"
            || proof.canonicalRoot !== repoRoot
            || !Number.isSafeInteger(proof.generation)
            || proof.generation < 0) {
            throw new Error(`Arm '${armId}' task '${taskId}' has no completed-generation sync proof.`);
        }
        requireString(proof.id, `Arm '${armId}' task '${taskId}' operation id`);
        requireString(
            proof.lastDurableTransitionAt,
            `Arm '${armId}' task '${taskId}' durable transition time`,
        );
        const fingerprint = parseCurrentFingerprint(
            proof.runtimeFingerprint,
            `Arm '${armId}' task '${taskId}' runtime fingerprint`,
        );
        const publication = parsePublicationReceipt(
            proof.publication,
            `Arm '${armId}' task '${taskId}' publication proof`,
        );
        if (canonicalJson({
            canonicalRoot: proof.canonicalRoot,
            generation: proof.generation,
            runtimeFingerprint: fingerprint,
            publication,
        }) !== expectedPublication) {
            throw new Error(`Arm '${armId}' task '${taskId}' is not bound to the arm-level generation proof.`);
        }
        byTask.set(taskId, fingerprint);
    }
    const missing = taskIds.filter((taskId) => !byTask.has(taskId));
    if (missing.length > 0 || byTask.size !== taskIds.length) {
        throw new Error(`Arm '${armId}' task-run identities do not match the task suite.`);
    }
    const fingerprints = taskIds.map((taskId) => byTask.get(taskId));
    const expected = canonicalJson(fingerprints[0]);
    if (fingerprints.some((fingerprint) => canonicalJson(fingerprint) !== expected)) {
        throw new Error(`Arm '${armId}' changed runtime fingerprint between task runs.`);
    }
    return {
        fingerprint: structuredClone(fingerprints[0]),
        generationReceipt: Object.freeze({
            canonicalRoot: repoRoot,
            generation: armIndexProof.generation,
            runtimeFingerprint: structuredClone(armFingerprint),
            publication: structuredClone(armPublication),
        }),
    };
}

function validateObservationGenerationReceipts(observations, expected, armId) {
    const expectedReceipt = canonicalJson(expected);
    for (const observation of observations) {
        const receipt = requireRecord(
            observation.generationReceipt,
            `Arm '${armId}' observation '${observationKey(observation)}' generation receipt`,
        );
        if (canonicalJson(receipt) !== expectedReceipt) {
            throw new Error(
                `Arm '${armId}' observation '${observationKey(observation)}' is not bound to the arm-level generation.`,
            );
        }
    }
}

function stackIdentity(fingerprint) {
    return Object.fromEntries(CURRENT_FINGERPRINT_FIELDS.map((key) => [key, fingerprint[key]]));
}

function normalizeArm(input, suite) {
    const raw = requireRecord(input.observations, `Arm '${input.id}' observation set`);
    const metadata = requireRecord(raw.metadata, `Arm '${input.id}' metadata`);
    const observations = validateObservationSet(raw, suite.tasks.map((task) => task.id));
    const expectedTaskHash = hashTaskSuite(suite);
    if (metadata.taskSuiteSha256 !== expectedTaskHash) {
        throw new Error(`Arm '${input.id}' task-suite hash does not match the supplied task suite.`);
    }
    const gitRevision = requireString(metadata.gitRevision, `Arm '${input.id}' git revision`).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(gitRevision)) {
        throw new Error(`Arm '${input.id}' git revision must be a full commit hash.`);
    }
    const node = requireRecord(metadata.node, `Arm '${input.id}' Node identity`);
    for (const key of ["version", "platform", "arch"]) {
        requireString(node[key], `Arm '${input.id}' Node identity ${key}`);
    }
    const serverInfo = requireRecord(metadata.serverInfo, `Arm '${input.id}' serverInfo`);
    const repoRoot = requireString(metadata.repoRoot, `Arm '${input.id}' repository root`);
    const authority = extractFingerprint(
        metadata,
        suite.tasks.map((task) => task.id),
        input.id,
        repoRoot,
    );
    const fingerprint = authority.fingerprint;
    if (!Array.isArray(raw.observations)) {
        throw new Error(`Arm '${input.id}' observations must be an array.`);
    }
    validateObservationGenerationReceipts(raw.observations, authority.generationReceipt, input.id);
    return {
        id: input.id,
        sourceFile: input.sourceFile,
        identity: stackIdentity(fingerprint),
        runtimeFingerprint: fingerprint,
        report: summarizeUsefulContext(suite, raw),
        logicalProviderWork: providerWorkSummary(observations.observations),
        observations: observations.observations,
        corpus: {
            repoRoot,
            gitRevision,
            taskSuiteSha256: metadata.taskSuiteSha256,
            node: structuredClone(node),
            serverInfo: structuredClone(serverInfo),
            observationVersion: observations.version,
            warmSampleCount: observations.warmSampleCount ?? 1,
            generationReceipt: structuredClone(authority.generationReceipt),
        },
    };
}

function changeKind(left, right) {
    const changedFields = CURRENT_FINGERPRINT_FIELDS.filter(
        (key) => left.identity[key] !== right.identity[key],
    );
    if (changedFields.length === 0) return "same_stack";
    if (changedFields.every((field) => EMBEDDING_CHANGE_FIELDS.has(field))) return "embedding_only";
    if (changedFields.every((field) => STORAGE_CHANGE_FIELDS.has(field))) return "storage_only";
    return "full_stack";
}

function phaseLatency(report, phase) {
    return report.version === 2
        ? report.metrics[phase]?.latencyMs ?? null
        : report.metrics.latencyMs?.[phase] ?? null;
}

function latencyDelta(left, right, phase) {
    const leftLatency = phaseLatency(left.report, phase);
    const rightLatency = phaseLatency(right.report, phase);
    if (!leftLatency || !rightLatency) return null;
    return {
        p50Ms: rightLatency.p50 - leftLatency.p50,
        p95Ms: rightLatency.p95 - leftLatency.p95,
    };
}

function compareArms(left, right, taskById) {
    const rightByKey = new Map(right.observations.map((observation) => [observationKey(observation), observation]));
    const pairs = left.observations.map((observation) => {
        const paired = rightByKey.get(observationKey(observation));
        if (!paired) throw new Error(`Arm '${right.id}' is missing observation '${observationKey(observation)}'.`);
        return [observation, paired];
    });
    if (rightByKey.size !== pairs.length) {
        throw new Error(`Arms '${left.id}' and '${right.id}' have different observation keys.`);
    }
    const classes = [...new Set(pairs.map(([observation]) => (
        taskById.get(observation.taskId).comparisonClass
        ?? taskById.get(observation.taskId).queryClass
    )))].sort();
    return {
        left: left.id,
        right: right.id,
        changeKind: changeKind(left, right),
        resultAgreement: agreementForPairs(pairs),
        resultAgreementByClass: Object.fromEntries(classes.map((comparisonClass) => [
            comparisonClass,
            agreementForPairs(pairs.filter(([observation]) => {
                const task = taskById.get(observation.taskId);
                return (task.comparisonClass ?? task.queryClass) === comparisonClass;
            })),
        ])),
        latencyDeltaMs: {
            cold: latencyDelta(left, right, "cold"),
            warm: latencyDelta(left, right, "warm"),
        },
    };
}

export function compareVectorStacks(taskSuite, armInputs) {
    const suite = validateTaskSuite(taskSuite);
    if (!Array.isArray(armInputs) || armInputs.length < 2) {
        throw new Error("At least two vector-stack arms are required.");
    }
    const ids = new Set();
    const arms = armInputs.map((input) => {
        const id = requireString(input.id, "Arm id");
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
            throw new Error(`Arm id '${id}' must use lowercase letters, digits, hyphens, or underscores.`);
        }
        if (ids.has(id)) throw new Error(`Duplicate arm id '${id}'.`);
        ids.add(id);
        return normalizeArm({ ...input, id }, suite);
    });
    const baseline = arms[0].corpus;
    for (const arm of arms.slice(1)) {
        for (const key of ["gitRevision", "taskSuiteSha256", "observationVersion", "warmSampleCount"]) {
            if (arm.corpus[key] !== baseline[key]) {
                throw new Error(`Arm '${arm.id}' has a different ${key}; paired comparison is invalid.`);
            }
        }
        for (const key of ["node", "serverInfo"]) {
            if (canonicalJson(arm.corpus[key]) !== canonicalJson(baseline[key])) {
                throw new Error(`Arm '${arm.id}' has a different ${key} identity; paired comparison is invalid.`);
            }
        }
    }
    const comparisons = [];
    const taskById = new Map(suite.tasks.map((task) => [task.id, task]));
    for (let leftIndex = 0; leftIndex < arms.length - 1; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < arms.length; rightIndex += 1) {
            comparisons.push(compareArms(arms[leftIndex], arms[rightIndex], taskById));
        }
    }
    return {
        schemaVersion: "satori_vector_stack_comparison_v1",
        corpus: {
            gitRevision: baseline.gitRevision,
            taskSuiteSha256: baseline.taskSuiteSha256,
            taskCount: suite.tasks.length,
            observationVersion: baseline.observationVersion,
            warmSampleCount: baseline.warmSampleCount,
            node: baseline.node,
            serverInfo: baseline.serverInfo,
        },
        arms: arms.map((arm) => ({
            id: arm.id,
            sourceFile: arm.sourceFile,
            identity: arm.identity,
            runtimeFingerprint: arm.runtimeFingerprint,
            metrics: arm.report.metrics,
            baselineFailures: arm.report.baselineFailures,
            logicalProviderWork: arm.logicalProviderWork,
        })),
        comparisons,
        interpretation: {
            storageOnly: "Only vectorStoreProvider changed; every other current fingerprint field is identical.",
            embeddingOnly: "Only embedding provider/model/dimension/artifact fields changed; every other current fingerprint field is identical.",
            fullStack: "Storage and embedding changed, or another compatibility field changed; do not attribute the delta to one component.",
            providerCounts: "logicalProviderWork counts Satori contract operations, not provider retries or transport requests.",
        },
    };
}

function usage() {
    return [
        "Usage: node scripts/satori-vector-stack-compare.mjs --tasks <tasks.json> --arm <id>=<observations.json> --arm <id>=<observations.json> [options]",
        "Options:",
        "  --out <comparison.json>",
        "  --json                         Print the comparison even when --out is used",
    ].join("\n");
}

export function parseArgs(argv) {
    const options = { tasksFile: null, arms: [], outFile: null, json: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value after ${arg}.`);
            return argv[index];
        };
        if (arg === "--tasks") {
            options.tasksFile = path.resolve(next());
        } else if (arg === "--arm") {
            const value = next();
            const separator = value.indexOf("=");
            if (separator <= 0 || separator === value.length - 1) {
                throw new Error("--arm must use <id>=<observations.json>.");
            }
            options.arms.push({ id: value.slice(0, separator), sourceFile: path.resolve(value.slice(separator + 1)) });
        } else if (arg === "--out") {
            options.outFile = path.resolve(next());
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (!options.help && (!options.tasksFile || options.arms.length < 2)) {
        throw new Error("--tasks and at least two --arm values are required.");
    }
    return options;
}

export function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return null;
    }
    const taskSuite = JSON.parse(fs.readFileSync(options.tasksFile, "utf8"));
    const arms = options.arms.map((arm) => ({
        ...arm,
        observations: JSON.parse(fs.readFileSync(arm.sourceFile, "utf8")),
    }));
    const comparison = compareVectorStacks(taskSuite, arms);
    const output = `${JSON.stringify(comparison, null, 2)}\n`;
    if (options.outFile) fs.writeFileSync(options.outFile, output);
    if (options.json || !options.outFile) process.stdout.write(output);
    return comparison;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`satori-vector-stack-compare: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        process.exitCode = 1;
    }
}
