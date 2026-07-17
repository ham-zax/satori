#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const QUERY_CLASSES = [
    "owner_discovery",
    "exact_identifier",
    "exact_open",
    "caller_recovery",
    "dirty_owner",
    "stale_recovery",
];
const COMPARISON_CLASSES = new Set([
    "exact",
    "lexical",
    "dense",
    "hybrid",
    "structural",
    "configuration",
]);
const PHASES = new Set(["cold", "warm"]);
const PHASE_ORDER = ["cold", "warm"];
const STATUSES = new Set(["ok", "zero_result", "fallback", "error"]);
const BASELINE_KEYS = ["maxLatencyMs", "maxPayloadBytes", "maxContextBytes"];
const READINESS_PROOF_MODES = new Set(["cold", "warm"]);
const READINESS_INVALIDATION_REASONS = new Set([
    "none",
    "cache_miss",
    "idle_expired",
    "proof_expired",
    "observation_unavailable",
    "observation_changed",
    "revalidation_failed",
    "freshness_changed",
]);
const READINESS_OPERATION_KEYS = [
    "preparedCacheLookups",
    "preparedCacheHits",
    "coldReadinessChecks",
    "warmReceiptRevalidations",
    "exactPayloadRecounts",
];
const MCP_TOOLS = new Set([
    "list_codebases",
    "manage_index",
    "search_codebase",
    "file_outline",
    "call_graph",
    "read_file",
]);

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isRecord(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function requireRecord(value, label) {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value;
}

function requireNonEmptyString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value;
}

function requireNonNegativeFinite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a non-negative finite number.`);
    }
    return value;
}

function requirePositiveFinite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive finite number.`);
    }
    return value;
}

function normalizeReadiness(value, label, phase) {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }
    return value.map((rawEntry, index) => {
        const entryLabel = `${label}[${index}]`;
        const entry = requireRecord(rawEntry, entryLabel);
        if (!READINESS_PROOF_MODES.has(entry.proofMode)) {
            throw new Error(`${entryLabel}.proofMode must be cold or warm.`);
        }
        if (entry.proofMode !== phase) {
            throw new Error(`${entryLabel}.proofMode must match observation phase '${phase}'.`);
        }
        if (!READINESS_INVALIDATION_REASONS.has(entry.invalidationReason)) {
            throw new Error(`${entryLabel}.invalidationReason is unsupported.`);
        }
        if (
            (entry.proofMode === "warm" && entry.invalidationReason !== "none")
            || (entry.proofMode === "cold" && entry.invalidationReason === "none")
        ) {
            throw new Error(`${entryLabel} contains contradictory proof mode and invalidation reason.`);
        }
        const rawOperations = requireRecord(entry.operations, `${entryLabel}.operations`);
        const operations = Object.fromEntries(READINESS_OPERATION_KEYS.map((key) => {
            const operation = rawOperations[key];
            if (!Number.isSafeInteger(operation) || operation < 0) {
                throw new Error(`${entryLabel}.operations.${key} must be a non-negative safe integer.`);
            }
            return [key, operation];
        }));
        if (
            operations.preparedCacheLookups < 1
            || operations.preparedCacheHits > operations.preparedCacheLookups
            || operations.preparedCacheHits > operations.warmReceiptRevalidations
        ) {
            throw new Error(`${entryLabel}.operations contains contradictory cache counters.`);
        }
        if (entry.proofMode === "warm" && (
            operations.preparedCacheHits < 1
            || operations.coldReadinessChecks !== 0
            || operations.warmReceiptRevalidations < 1
            || operations.exactPayloadRecounts !== 0
        )) {
            throw new Error(`${entryLabel}.operations does not prove warm receipt reuse.`);
        }
        if (entry.proofMode === "cold" && (
            operations.coldReadinessChecks < 1
            || operations.exactPayloadRecounts < 1
        )) {
            throw new Error(`${entryLabel}.operations does not prove a cold authority check.`);
        }
        return {
            proofMode: entry.proofMode,
            invalidationReason: entry.invalidationReason,
            operations,
        };
    });
}

function requireSpan(value, label) {
    const span = requireRecord(value, label);
    if (!Number.isInteger(span.startLine) || span.startLine <= 0) {
        throw new Error(`${label}.startLine must be a positive integer.`);
    }
    if (!Number.isInteger(span.endLine) || span.endLine < span.startLine) {
        throw new Error(`${label}.endLine must be an integer at or after startLine.`);
    }
    return { startLine: span.startLine, endLine: span.endLine };
}

function requireSymbolRef(value, label) {
    const symbol = requireRecord(value, label);
    return {
        file: requireNonEmptyString(symbol.file, `${label}.file`),
        symbol: requireNonEmptyString(symbol.symbol, `${label}.symbol`),
    };
}

function requireUniqueSymbolRefs(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} must be a non-empty array.`);
    }
    const seen = new Set();
    return value.map((item, index) => {
        const symbol = requireSymbolRef(item, `${label}[${index}]`);
        const identity = `${symbol.file}#${symbol.symbol}`;
        if (seen.has(identity)) {
            throw new Error(`${label} contains duplicate '${identity}'.`);
        }
        seen.add(identity);
        return symbol;
    });
}

function assertJsonValue(value, label, ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`${label} must contain only finite JSON numbers.`);
        }
        return;
    }
    if (typeof value !== "object") {
        throw new Error(`${label} must be JSON-serializable.`);
    }
    if (ancestors.has(value)) {
        throw new Error(`${label} must be JSON-serializable without cycles.`);
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, ancestors));
    } else {
        for (const [key, item] of Object.entries(value)) {
            assertJsonValue(item, `${label}.${key}`, ancestors);
        }
    }
    ancestors.delete(value);
}

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function requireInvocation(value, label) {
    const invocation = requireRecord(value, label);
    const tool = requireNonEmptyString(invocation.tool, `${label}.tool`);
    if (!MCP_TOOLS.has(tool)) {
        throw new Error(`${label}.tool is not one of Satori's six MCP tools.`);
    }
    const args = requireRecord(invocation.args, `${label}.args`);
    assertJsonValue(args, `${label}.args`);
    return { tool, args: jsonClone(args) };
}

function requireWorkload(value, label) {
    const workload = requireRecord(value, label);
    if (!Array.isArray(workload.setup) || workload.setup.length === 0) {
        throw new Error(`${label}.setup must be a non-empty array of exact MCP invocations.`);
    }
    if (!Array.isArray(workload.invocations) || workload.invocations.length === 0) {
        throw new Error(`${label}.invocations must be a non-empty array of exact MCP invocations.`);
    }
    const phaseProtocol = requireRecord(workload.phaseProtocol, `${label}.phaseProtocol`);
    return {
        setup: workload.setup.map((item, index) => requireInvocation(item, `${label}.setup[${index}]`)),
        invocations: workload.invocations.map((item, index) => requireInvocation(item, `${label}.invocations[${index}]`)),
        phaseProtocol: {
            cold: requireNonEmptyString(phaseProtocol.cold, `${label}.phaseProtocol.cold`),
            warm: requireNonEmptyString(phaseProtocol.warm, `${label}.phaseProtocol.warm`),
        },
    };
}

export function validateTaskSuite(value) {
    const suite = requireRecord(value, "Task suite");
    if (suite.version !== 1) {
        throw new Error("Task suite version must be 1.");
    }
    if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) {
        throw new Error("Task suite tasks must be a non-empty array.");
    }

    const ids = new Set();
    const tasks = suite.tasks.map((rawTask, index) => {
        const task = requireRecord(rawTask, `tasks[${index}]`);
        const id = requireNonEmptyString(task.id, `tasks[${index}].id`);
        if (ids.has(id)) {
            throw new Error(`Task suite contains duplicate id '${id}'.`);
        }
        ids.add(id);
        if (!QUERY_CLASSES.includes(task.queryClass)) {
            throw new Error(`tasks[${index}].queryClass is unsupported.`);
        }

        const rawExpected = requireRecord(task.expected, `tasks[${index}].expected`);
        const expected = {
            ownerFile: requireNonEmptyString(rawExpected.ownerFile, `tasks[${index}].expected.ownerFile`),
            ownerSymbol: requireNonEmptyString(rawExpected.ownerSymbol, `tasks[${index}].expected.ownerSymbol`),
        };
        if (rawExpected.callerSymbols !== undefined) {
            expected.callerSymbols = requireUniqueSymbolRefs(
                rawExpected.callerSymbols,
                `tasks[${index}].expected.callerSymbols`
            );
        }
        if (rawExpected.span !== undefined) {
            expected.span = requireSpan(rawExpected.span, `tasks[${index}].expected.span`);
        }
        if (task.queryClass === "exact_open" && expected.span === undefined) {
            throw new Error(`tasks[${index}].expected.span is required for exact_open.`);
        }
        if (task.queryClass === "caller_recovery" && expected.callerSymbols === undefined) {
            throw new Error(`tasks[${index}].expected.callerSymbols is required for caller_recovery.`);
        }
        let comparisonClass;
        if (task.comparisonClass !== undefined) {
            comparisonClass = requireNonEmptyString(
                task.comparisonClass,
                `tasks[${index}].comparisonClass`,
            );
            if (!COMPARISON_CLASSES.has(comparisonClass)) {
                throw new Error(`tasks[${index}].comparisonClass is unsupported.`);
            }
        }

        const normalized = {
            id,
            queryClass: task.queryClass,
            ...(comparisonClass !== undefined ? { comparisonClass } : {}),
            language: requireNonEmptyString(task.language, `tasks[${index}].language`),
            expected,
            workload: requireWorkload(task.workload, `tasks[${index}].workload`),
        };
        if (task.baselineLimits !== undefined) {
            const rawLimits = requireRecord(task.baselineLimits, `tasks[${index}].baselineLimits`);
            const baselineLimits = {};
            for (const key of BASELINE_KEYS) {
                if (rawLimits[key] !== undefined) {
                    baselineLimits[key] = requirePositiveFinite(
                        rawLimits[key],
                        `tasks[${index}].baselineLimits.${key}`
                    );
                }
            }
            for (const key of Object.keys(rawLimits)) {
                if (!BASELINE_KEYS.includes(key)) {
                    throw new Error(`tasks[${index}].baselineLimits.${key} is unsupported.`);
                }
            }
            normalized.baselineLimits = baselineLimits;
        }
        return normalized;
    });

    const normalized = { version: 1, tasks };
    if (suite.name !== undefined) {
        normalized.name = requireNonEmptyString(suite.name, "Task suite name");
    }
    return jsonClone(normalized);
}

export function validateObservationSet(value, taskIds) {
    const set = requireRecord(value, "Observation set");
    if (set.version !== 1 && set.version !== 2 && set.version !== 3) {
        throw new Error("Observation set version must be 1, 2, or 3.");
    }
    const version = set.version;
    const hasSampleOrdinals = version >= 2;
    const warmSampleCount = hasSampleOrdinals
        ? positiveIntegerForObservation(set.warmSampleCount, "Observation set warmSampleCount")
        : 1;
    if (!Array.isArray(set.observations)) {
        throw new Error("Observation set observations must be an array.");
    }
    const expectedIds = new Set(taskIds);
    const observedKeys = new Set();
    const observations = set.observations.map((rawObservation, index) => {
        const observation = requireRecord(rawObservation, `observations[${index}]`);
        const taskId = requireNonEmptyString(observation.taskId, `observations[${index}].taskId`);
        if (!expectedIds.has(taskId)) {
            throw new Error(`Observation references unknown task '${taskId}'.`);
        }
        if (!PHASES.has(observation.phase)) {
            throw new Error(`observations[${index}].phase must be cold or warm.`);
        }
        let sample;
        if (hasSampleOrdinals) {
            if (!Number.isSafeInteger(observation.sample) || observation.sample < 0) {
                throw new Error(`observations[${index}].sample must be a non-negative safe integer.`);
            }
            sample = observation.sample;
            if (observation.phase === "cold" && sample !== 0) {
                throw new Error(`observations[${index}] cold sample must be 0.`);
            }
            if (observation.phase === "warm" && (sample < 1 || sample > warmSampleCount)) {
                throw new Error(`observations[${index}] warm sample must be from 1 through ${warmSampleCount}.`);
            }
        }
        const observationKey = hasSampleOrdinals
            ? `${taskId}:${observation.phase}:${sample}`
            : `${taskId}:${observation.phase}`;
        if (observedKeys.has(observationKey)) {
            throw new Error(`Observation set contains duplicate task phase '${observationKey}'.`);
        }
        observedKeys.add(observationKey);
        if (!STATUSES.has(observation.status)) {
            throw new Error(`observations[${index}].status is unsupported.`);
        }
        const latencyMs = requireNonNegativeFinite(observation.latencyMs, `observations[${index}].latencyMs`);
        const contextBytes = requireNonNegativeFinite(observation.contextBytes, `observations[${index}].contextBytes`);
        let responseBytes;
        if (observation.responseBytes !== undefined) {
            if (!Number.isSafeInteger(observation.responseBytes) || observation.responseBytes < 0) {
                throw new Error(`observations[${index}].responseBytes must be a non-negative safe integer.`);
            }
            responseBytes = observation.responseBytes;
        }
        assertJsonValue(observation.response, `observations[${index}].response`);
        if (responseBytes !== undefined && responseBytes < serializedPayloadBytes(observation.response)) {
            throw new Error(`observations[${index}].responseBytes cannot be smaller than the final response payload.`);
        }
        const readiness = observation.readiness === undefined
            ? undefined
            : normalizeReadiness(observation.readiness, `observations[${index}].readiness`, observation.phase);
        if (!Array.isArray(observation.results)) {
            throw new Error(`observations[${index}].results must be an array.`);
        }
        const results = observation.results.map((rawResult, resultIndex) => {
            const result = requireRecord(rawResult, `observations[${index}].results[${resultIndex}]`);
            const file = requireNonEmptyString(
                result.file,
                `observations[${index}].results[${resultIndex}].file`,
            );
            if (version === 3) {
                if (result.kind === "file") {
                    if (result.symbol !== undefined) {
                        throw new Error(`observations[${index}].results[${resultIndex}] file identity must not contain symbol.`);
                    }
                    return { kind: "file", file };
                }
                if (result.kind === "symbol") {
                    return {
                        kind: "symbol",
                        file,
                        symbol: requireNonEmptyString(
                            result.symbol,
                            `observations[${index}].results[${resultIndex}].symbol`,
                        ),
                    };
                }
                throw new Error(`observations[${index}].results[${resultIndex}].kind must be file or symbol.`);
            }
            return {
                file,
                symbol: requireNonEmptyString(result.symbol, `observations[${index}].results[${resultIndex}].symbol`),
            };
        });

        const normalized = {
            taskId,
            phase: observation.phase,
            status: observation.status,
            latencyMs,
            contextBytes,
            ...(responseBytes !== undefined ? { responseBytes } : {}),
            response: jsonClone(observation.response),
            results,
            ...(readiness !== undefined ? { readiness } : {}),
            ...(hasSampleOrdinals ? { sample } : {}),
        };
        if (observation.freshnessModes !== undefined) {
            if (!Array.isArray(observation.freshnessModes)) {
                throw new Error(`observations[${index}].freshnessModes must be an array.`);
            }
            normalized.freshnessModes = observation.freshnessModes.map((mode, modeIndex) => (
                requireNonEmptyString(
                    mode,
                    `observations[${index}].freshnessModes[${modeIndex}]`,
                )
            ));
        }
        for (const key of ["toolCalls", "callsToSource"]) {
            if (observation[key] !== undefined) {
                if (observation[key] !== null
                    && (!Number.isSafeInteger(observation[key]) || observation[key] < 0)) {
                    throw new Error(`observations[${index}].${key} must be null or a non-negative safe integer.`);
                }
                normalized[key] = observation[key];
            }
        }
        const callsToSource = observation.callsToSource ?? null;
        const toolCalls = observation.toolCalls ?? null;
        if (callsToSource !== null && (
            callsToSource < 1
            || toolCalls === null
            || callsToSource > toolCalls
        )) {
            throw new Error(`observations[${index}].callsToSource must be null or from 1 through toolCalls.`);
        }
        const hasExplicitSourceEvidence = observation.sourceReached !== undefined
            || observation.sourceMode !== undefined;
        if (hasSampleOrdinals || hasExplicitSourceEvidence) {
            if (typeof observation.sourceReached !== "boolean") {
                throw new Error(`observations[${index}].sourceReached must be a boolean.`);
            }
            if (observation.sourceMode !== null
                && observation.sourceMode !== "search_preview"
                && observation.sourceMode !== "read_file") {
                throw new Error(`observations[${index}].sourceMode must be search_preview, read_file, or null.`);
            }
            const sourceMode = observation.sourceMode ?? null;
            if (observation.sourceReached !== (callsToSource !== null && sourceMode !== null)) {
                throw new Error(`observations[${index}] source evidence fields are inconsistent.`);
            }
            normalized.sourceReached = observation.sourceReached;
            normalized.sourceMode = sourceMode;
        }
        if (observation.openedSymbol !== undefined) {
            const opened = requireRecord(observation.openedSymbol, `observations[${index}].openedSymbol`);
            normalized.openedSymbol = {
                file: requireNonEmptyString(opened.file, `observations[${index}].openedSymbol.file`),
                symbol: requireNonEmptyString(opened.symbol, `observations[${index}].openedSymbol.symbol`),
                ...requireSpan(opened, `observations[${index}].openedSymbol`),
            };
        }
        for (const key of ["staleIndexDetected", "recoverySucceeded"]) {
            if (observation[key] !== undefined) {
                if (typeof observation[key] !== "boolean") {
                    throw new Error(`observations[${index}].${key} must be a boolean.`);
                }
                normalized[key] = observation[key];
            }
        }
        return normalized;
    });

    const expectedKeys = hasSampleOrdinals
        ? [...expectedIds].flatMap((id) => [
            `${id}:cold:0`,
            ...Array.from({ length: warmSampleCount }, (_, index) => `${id}:warm:${index + 1}`),
        ])
        : [...expectedIds].flatMap((id) => PHASE_ORDER.map((phase) => `${id}:${phase}`));
    const missing = expectedKeys.filter((key) => !observedKeys.has(key));
    if (missing.length > 0) {
        throw new Error(`Observation set is missing tasks: ${missing.join(", ")}.`);
    }
    return {
        version,
        ...(hasSampleOrdinals ? { warmSampleCount } : {}),
        observations,
    };
}

function positiveIntegerForObservation(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive safe integer.`);
    }
    return value;
}

export function serializedPayloadBytes(response) {
    assertJsonValue(response, "Response");
    const serialized = JSON.stringify(response);
    if (serialized === undefined) {
        throw new Error("Response must be JSON-serializable.");
    }
    return Buffer.byteLength(serialized, "utf8");
}

export function nearestRankPercentile(values, percentile) {
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error("Percentile values must be a non-empty array.");
    }
    if (typeof percentile !== "number" || !Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
        throw new Error("Percentile must be a finite number from 0 through 100.");
    }
    const sorted = values.map((value, index) => requireNonNegativeFinite(value, `values[${index}]`))
        .sort((left, right) => left - right);
    const rank = percentile === 0 ? 0 : Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[rank];
}

function sameOwner(expected, actual) {
    return actual?.kind !== "file"
        && actual?.file === expected.ownerFile
        && actual?.symbol === expected.ownerSymbol;
}

function extractRecoveredCallers(task, response) {
    if (!isRecord(response) || !Array.isArray(response.nodes) || !Array.isArray(response.edges)) {
        return [];
    }
    const nodes = response.nodes.filter(isRecord);
    const targetIds = new Set(nodes
        .filter((node) => node.file === task.expected.ownerFile && node.symbolLabel === task.expected.ownerSymbol)
        .map((node) => node.symbolId)
        .filter((symbolId) => typeof symbolId === "string"));
    const callerIds = new Set(response.edges
        .filter(isRecord)
        .filter((edge) => targetIds.has(edge.targetSymbolId))
        .map((edge) => edge.sourceSymbolId)
        .filter((symbolId) => typeof symbolId === "string"));
    return nodes
        .filter((node) => callerIds.has(node.symbolId))
        .filter((node) => typeof node.file === "string" && typeof node.symbolLabel === "string")
        .map((node) => ({ file: node.file, symbol: node.symbolLabel }));
}

export function gradeObservation(task, observation) {
    const ownerFoundTop3 = observation.results.slice(0, 3)
        .some((result) => sameOwner(task.expected, result));
    let exactSymbolOpenSuccess = null;
    if (task.queryClass === "exact_open") {
        exactSymbolOpenSuccess = observation.status === "ok"
            && sameOwner(task.expected, observation.openedSymbol);
        if (exactSymbolOpenSuccess) {
            exactSymbolOpenSuccess = observation.openedSymbol.startLine === task.expected.span.startLine
                && observation.openedSymbol.endLine === task.expected.span.endLine;
        }
    }

    let callerRecoverySuccess = null;
    if (task.queryClass === "caller_recovery") {
        const recovered = new Set(extractRecoveredCallers(task, observation.response)
            .map((caller) => `${caller.file}#${caller.symbol}`));
        callerRecoverySuccess = observation.status === "ok"
            && task.expected.callerSymbols.every((caller) => recovered.has(`${caller.file}#${caller.symbol}`));
    }

    const payloadBytes = observation.responseBytes ?? serializedPayloadBytes(observation.response);
    const baselineFailures = [];
    if (task.baselineLimits?.maxLatencyMs !== undefined
        && observation.latencyMs > task.baselineLimits.maxLatencyMs) {
        baselineFailures.push("maxLatencyMs");
    }
    if (task.baselineLimits?.maxPayloadBytes !== undefined
        && payloadBytes > task.baselineLimits.maxPayloadBytes) {
        baselineFailures.push("maxPayloadBytes");
    }
    if (task.baselineLimits?.maxContextBytes !== undefined
        && observation.contextBytes > task.baselineLimits.maxContextBytes) {
        baselineFailures.push("maxContextBytes");
    }

    return {
        taskId: task.id,
        queryClass: task.queryClass,
        ...(task.comparisonClass !== undefined ? { comparisonClass: task.comparisonClass } : {}),
        phase: observation.phase,
        ...(observation.sample !== undefined ? { sample: observation.sample } : {}),
        status: observation.status,
        ownerFoundTop3,
        exactSymbolOpenSuccess,
        callerRecoverySuccess,
        dirtyOwnerFound: task.queryClass === "dirty_owner" ? ownerFoundTop3 : null,
        staleIndexDetected: task.queryClass === "stale_recovery"
            ? (observation.staleIndexDetected ?? false)
            : null,
        recoverySucceeded: task.queryClass === "stale_recovery"
            ? (observation.recoverySucceeded ?? false)
            : null,
        zeroResult: observation.status === "zero_result",
        fallbackUsed: observation.status === "fallback",
        latencyMs: observation.latencyMs,
        payloadBytes,
        ...(observation.readiness !== undefined ? { readiness: observation.readiness } : {}),
        contextBytes: observation.contextBytes,
        toolCalls: observation.toolCalls ?? null,
        callsToSource: observation.callsToSource ?? null,
        sourceReached: observation.sourceReached ?? (observation.callsToSource != null ? true : null),
        sourceMode: observation.sourceMode ?? null,
        baselineFailures,
    };
}

function rateMetric(grades, key) {
    const applicable = grades.filter((grade) => typeof grade[key] === "boolean");
    const passed = applicable.filter((grade) => grade[key]).length;
    return {
        passed,
        applicable: applicable.length,
        rate: applicable.length === 0 ? null : passed / applicable.length,
    };
}

function percentileSummary(values) {
    if (values.length === 0) {
        return null;
    }
    return {
        count: values.length,
        p50: nearestRankPercentile(values, 50),
        p95: nearestRankPercentile(values, 95),
    };
}

export function summarizeUsefulContext(taskSuite, observationSet) {
    const suite = validateTaskSuite(taskSuite);
    const observations = validateObservationSet(
        observationSet,
        suite.tasks.map((task) => task.id)
    );
    const grades = observations.version >= 2
        ? observations.observations.map((observation) => {
            const task = suite.tasks.find((candidate) => candidate.id === observation.taskId);
            return gradeObservation(task, observation);
        })
        : (() => {
            const byTaskPhase = new Map(observations.observations
                .map((observation) => [`${observation.taskId}:${observation.phase}`, observation]));
            return suite.tasks.flatMap((task) => PHASE_ORDER.map((phase) =>
                gradeObservation(task, byTaskPhase.get(`${task.id}:${phase}`))));
        })();

    const summarizeGrades = (selectedGrades) => {
        const payloadBytesByQueryClass = {};
        const latencyByQueryClass = {};
        for (const queryClass of QUERY_CLASSES) {
            const matching = selectedGrades.filter((grade) => grade.queryClass === queryClass);
            payloadBytesByQueryClass[queryClass] = percentileSummary(matching.map((grade) => grade.payloadBytes));
            latencyByQueryClass[queryClass] = percentileSummary(matching.map((grade) => grade.latencyMs));
        }
        return {
            ownerFoundTop3: rateMetric(selectedGrades, "ownerFoundTop3"),
            exactSymbolOpenSuccess: rateMetric(selectedGrades, "exactSymbolOpenSuccess"),
            callerRecoverySuccess: rateMetric(selectedGrades, "callerRecoverySuccess"),
            dirtyOwnerFound: rateMetric(selectedGrades, "dirtyOwnerFound"),
            staleIndexDetected: rateMetric(selectedGrades, "staleIndexDetected"),
            recoverySucceeded: rateMetric(selectedGrades, "recoverySucceeded"),
            zeroResult: rateMetric(selectedGrades, "zeroResult"),
            fallbackUsed: rateMetric(selectedGrades, "fallbackUsed"),
            latencyMs: percentileSummary(selectedGrades.map((grade) => grade.latencyMs)),
            latencyByQueryClass,
            payloadBytesByQueryClass,
            contextBytes: percentileSummary(selectedGrades.map((grade) => grade.contextBytes)),
            toolCalls: percentileSummary(selectedGrades.flatMap((grade) => grade.toolCalls === null ? [] : [grade.toolCalls])),
            callsToSource: percentileSummary(selectedGrades.flatMap((grade) => grade.callsToSource === null ? [] : [grade.callsToSource])),
        };
    };
    const coldGrades = grades.filter((grade) => grade.phase === "cold");
    const warmGrades = grades.filter((grade) => grade.phase === "warm");
    const legacyMetrics = summarizeGrades(grades);

    return {
        version: observations.version,
        taskCount: suite.tasks.length,
        observationCount: grades.length,
        metrics: observations.version >= 2
            ? { cold: summarizeGrades(coldGrades), warm: summarizeGrades(warmGrades) }
            : {
                ...legacyMetrics,
                latencyMs: {
                    cold: percentileSummary(coldGrades.map((grade) => grade.latencyMs)),
                    warm: percentileSummary(warmGrades.map((grade) => grade.latencyMs)),
                    exact_identifier: legacyMetrics.latencyByQueryClass.exact_identifier,
                },
            },
        baselineFailures: grades
            .filter((grade) => grade.baselineFailures.length > 0)
            .map((grade) => ({
                taskId: grade.taskId,
                phase: grade.phase,
                ...(grade.sample !== undefined ? { sample: grade.sample } : {}),
                failures: grade.baselineFailures,
            })),
        grades,
    };
}

function usage() {
    return "Usage: node scripts/satori-useful-context.mjs --tasks <tasks.json> --observations <observations.json> [--out <report.json>] [--json]";
}

export function parseArgs(argv) {
    const options = { tasksFile: null, observationsFile: null, outFile: null, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) {
                throw new Error(`Missing value after ${arg}.`);
            }
            return path.resolve(argv[index]);
        };
        if (arg === "--tasks") {
            options.tasksFile = next();
        } else if (arg === "--observations") {
            options.observationsFile = next();
        } else if (arg === "--out") {
            options.outFile = next();
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (!options.help && (!options.tasksFile || !options.observationsFile)) {
        throw new Error("Both --tasks and --observations are required.");
    }
    return options;
}

export function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return null;
    }
    const tasks = JSON.parse(fs.readFileSync(options.tasksFile, "utf8"));
    const observations = JSON.parse(fs.readFileSync(options.observationsFile, "utf8"));
    const report = summarizeUsefulContext(tasks, observations);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outFile) {
        fs.writeFileSync(options.outFile, output);
    }
    if (options.json || !options.outFile) {
        process.stdout.write(output);
    }
    return report;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const report = main();
        if (report?.baselineFailures?.length > 0) {
            process.exitCode = 2;
        }
    } catch (error) {
        process.stderr.write(`satori-useful-context: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        process.exitCode = 1;
    }
}
