import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIR, "satori-useful-context.mjs");
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const COMMITTED_TASKS = path.join(REPO_ROOT, "evals/useful-context/tasks.json");

const {
    validateTaskSuite,
    validateObservationSet,
    serializedPayloadBytes,
    nearestRankPercentile,
    gradeObservation,
    summarizeUsefulContext,
    parseArgs,
    main,
} = await import("./satori-useful-context.mjs");

const QUERY_CLASSES = [
    "owner_discovery",
    "exact_identifier",
    "exact_open",
    "caller_recovery",
    "dirty_owner",
    "stale_recovery",
];

function baseTask(overrides = {}) {
    return {
        id: "t-owner",
        queryClass: "owner_discovery",
        language: "typescript",
        expected: {
            ownerFile: "packages/mcp/src/core/handlers.ts",
            ownerSymbol: "handleSearchCode",
        },
        workload: {
            setup: [{
                tool: "manage_index",
                args: { action: "status", path: "$REPO_ROOT" },
            }],
            invocations: [{
                tool: "search_codebase",
                args: { path: "$REPO_ROOT", query: "find the search handler" },
            }],
            phaseProtocol: {
                cold: "restart the MCP runtime, then run the invocation once",
                warm: "repeat the same invocation in the same runtime",
            },
        },
        ...overrides,
    };
}

function baseObservation(overrides = {}) {
    return {
        taskId: "t-owner",
        phase: "cold",
        status: "ok",
        latencyMs: 10,
        contextBytes: 100,
        response: { status: "ok", results: [] },
        results: [
            { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
        ],
        ...overrides,
    };
}

function minimalSuite(tasks) {
    return { version: 1, tasks };
}

function minimalObservations(observations) {
    return { version: 1, observations };
}

function pairedObservations(observations) {
    return minimalObservations(observations.flatMap((observation) => [
        { ...structuredClone(observation), phase: "cold" },
        { ...structuredClone(observation), phase: "warm" },
    ]));
}

// ---------------------------------------------------------------------------
// validateTaskSuite
// ---------------------------------------------------------------------------

test("validateTaskSuite accepts version-1 suite and returns a normalized copy", () => {
    const suite = minimalSuite([
        baseTask({
            id: "a",
            expected: {
                ownerFile: "packages/core/src/config/defaults.ts",
                ownerSymbol: "getSupportedExtensionsForIndexProfile",
                callerSymbols: [
                    { file: "packages/mcp/src/tools/search_codebase.ts", symbol: "execute" },
                    { file: "packages/mcp/src/core/handlers.ts", symbol: "ToolHandlers" },
                ],
                span: { startLine: 61, endLine: 80 },
            },
            baselineLimits: {
                maxLatencyMs: 50,
                maxPayloadBytes: 4096,
                maxContextBytes: 2048,
            },
        }),
    ]);
    const original = structuredClone(suite);
    const normalized = validateTaskSuite(suite);
    assert.equal(normalized.version, 1);
    assert.equal(normalized.tasks.length, 1);
    assert.equal(normalized.tasks[0].expected.span.startLine, 61);
    assert.deepEqual(normalized.tasks[0].expected.callerSymbols, [
        { file: "packages/mcp/src/tools/search_codebase.ts", symbol: "execute" },
        { file: "packages/mcp/src/core/handlers.ts", symbol: "ToolHandlers" },
    ]);
    assert.equal(normalized.tasks[0].workload.invocations[0].tool, "search_codebase");
    assert.deepEqual(normalized.tasks[0].baselineLimits, {
        maxLatencyMs: 50,
        maxPayloadBytes: 4096,
        maxContextBytes: 2048,
    });
    // Must not mutate input.
    assert.deepEqual(suite, original);
});

test("validateTaskSuite rejects wrong version, empty tasks, and duplicate ids", () => {
    assert.throws(() => validateTaskSuite({ version: 2, tasks: [baseTask()] }), /version/i);
    assert.throws(() => validateTaskSuite({ version: 1, tasks: [] }), /non-empty|empty/i);
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({ id: "x" }), baseTask({ id: "x" })])),
        /duplicate/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({ id: "" })])),
        /id/i
    );
});

test("validateTaskSuite rejects invalid queryClass, expected, spans, and baseline limits", () => {
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({ queryClass: "semantic" })])),
        /queryClass/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            expected: { ownerFile: "", ownerSymbol: "x" },
        })])),
        /ownerFile/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            expected: {
                ownerFile: "a.ts",
                ownerSymbol: "f",
                span: { startLine: 0, endLine: 1 },
            },
        })])),
        /span|startLine/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            expected: {
                ownerFile: "a.ts",
                ownerSymbol: "f",
                span: { startLine: 5, endLine: 4 },
            },
        })])),
        /span|endLine/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            expected: {
                ownerFile: "a.ts",
                ownerSymbol: "f",
                callerSymbols: [
                    { file: "a.ts", symbol: "a" },
                    { file: "a.ts", symbol: "a" },
                ],
            },
        })])),
        /callerSymbols|duplicate/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            queryClass: "exact_open",
            expected: { ownerFile: "a.ts", ownerSymbol: "f" },
        })])),
        /exact_open|span/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({ workload: undefined })])),
        /workload/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            workload: {
                setup: [{ tool: "seventh_tool", args: {} }],
                invocations: [{ tool: "search_codebase", args: {} }],
                phaseProtocol: { cold: "cold", warm: "warm" },
            },
        })])),
        /six MCP tools|tool/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            baselineLimits: { maxLatencyMs: 0 },
        })])),
        /maxLatencyMs|baseline/i
    );
    assert.throws(
        () => validateTaskSuite(minimalSuite([baseTask({
            baselineLimits: { maxPayloadBytes: Number.POSITIVE_INFINITY },
        })])),
        /maxPayloadBytes|baseline|finite/i
    );
});

// ---------------------------------------------------------------------------
// validateObservationSet
// ---------------------------------------------------------------------------

test("validateObservationSet requires one cold and one warm observation per task", () => {
    const taskIds = ["a", "b"];
    const ok = minimalObservations([
        baseObservation({ taskId: "a" }),
        baseObservation({ taskId: "a", phase: "warm", latencyMs: 2 }),
        baseObservation({ taskId: "b" }),
        baseObservation({ taskId: "b", phase: "warm", latencyMs: 2 }),
    ]);
    const normalized = validateObservationSet(ok, taskIds);
    assert.equal(normalized.observations.length, 4);

    assert.throws(
        () => validateObservationSet(minimalObservations([baseObservation({ taskId: "a" })]), taskIds),
        /missing/i
    );
    assert.throws(
        () => validateObservationSet(minimalObservations([
            baseObservation({ taskId: "a" }),
            baseObservation({ taskId: "a", phase: "warm" }),
            baseObservation({ taskId: "b" }),
            baseObservation({ taskId: "b", phase: "warm" }),
            baseObservation({ taskId: "c" }),
        ]), taskIds),
        /unknown/i
    );
    assert.throws(
        () => validateObservationSet(minimalObservations([
            baseObservation({ taskId: "a" }),
            baseObservation({ taskId: "a" }),
            baseObservation({ taskId: "b" }),
        ]), taskIds),
        /duplicate/i
    );
});

test("validateObservationSet rejects bad spans, non-finite numbers, and non-JSON response", () => {
    const taskIds = ["t-owner"];
    assert.throws(
        () => validateObservationSet(minimalObservations([baseObservation({
            openedSymbol: {
                file: "a.ts",
                symbol: "f",
                startLine: 3,
                endLine: 1,
            },
        })]), taskIds),
        /span|endLine|openedSymbol/i
    );
    assert.throws(
        () => validateObservationSet(minimalObservations([baseObservation({
            latencyMs: Number.NaN,
        })]), taskIds),
        /latencyMs|finite/i
    );
    assert.throws(
        () => validateObservationSet(minimalObservations([baseObservation({
            contextBytes: -1,
        })]), taskIds),
        /contextBytes/i
    );
    assert.throws(
        () => validateObservationSet(minimalObservations([baseObservation({
            response: { fn: () => 1 },
        })]), taskIds),
        /JSON|serializ/i
    );
    assert.throws(
        () => validateObservationSet(minimalObservations([baseObservation({
            phase: "hot",
        })]), taskIds),
        /phase/i
    );
    assert.throws(
        () => validateObservationSet(minimalObservations([baseObservation({
            status: "timeout",
        })]), taskIds),
        /status/i
    );
});

// ---------------------------------------------------------------------------
// serializedPayloadBytes / nearestRankPercentile
// ---------------------------------------------------------------------------

test("serializedPayloadBytes uses UTF-8 JSON byte length and rejects non-JSON values", () => {
    assert.equal(serializedPayloadBytes({ a: "café" }), Buffer.byteLength(JSON.stringify({ a: "café" }), "utf8"));
    assert.equal(serializedPayloadBytes("x"), Buffer.byteLength(JSON.stringify("x"), "utf8"));
    assert.throws(() => serializedPayloadBytes(undefined), /JSON|serializ/i);
    assert.throws(() => serializedPayloadBytes(() => 1), /JSON|serializ/i);
    const circular = {};
    circular.self = circular;
    assert.throws(() => serializedPayloadBytes(circular), /JSON|serializ/i);
});

test("nearestRankPercentile uses nearest-rank semantics including percentile 0", () => {
    assert.equal(nearestRankPercentile([10, 20, 30, 40], 0), 10);
    assert.equal(nearestRankPercentile([10, 20, 30, 40], 50), 20);
    assert.equal(nearestRankPercentile([10, 20, 30, 40], 100), 40);
    // Nearest-rank: ceil(0.95 * 4) = 4 -> 40
    assert.equal(nearestRankPercentile([10, 20, 30, 40], 95), 40);
    assert.equal(nearestRankPercentile([5], 50), 5);
    assert.throws(() => nearestRankPercentile([], 50), /non-empty|empty/i);
    assert.throws(() => nearestRankPercentile([1, -1], 50), /non-negative|negative/i);
    assert.throws(() => nearestRankPercentile([1], 101), /percentile/i);
    assert.throws(() => nearestRankPercentile([Number.NaN], 50), /finite/i);
});

// ---------------------------------------------------------------------------
// gradeObservation
// ---------------------------------------------------------------------------

test("gradeObservation detects owner in top three and ignores later ranks", () => {
    const task = baseTask();
    const top3 = gradeObservation(task, baseObservation({
        results: [
            { file: "other.ts", symbol: "x" },
            { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
            { file: "z.ts", symbol: "z" },
        ],
    }));
    assert.equal(top3.ownerFoundTop3, true);

    const fourth = gradeObservation(task, baseObservation({
        results: [
            { file: "a.ts", symbol: "a" },
            { file: "b.ts", symbol: "b" },
            { file: "c.ts", symbol: "c" },
            { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
        ],
    }));
    assert.equal(fourth.ownerFoundTop3, false);
});

test("gradeObservation exact_open requires ok status, identity, and exact expected span", () => {
    const task = baseTask({
        id: "open",
        queryClass: "exact_open",
        expected: {
            ownerFile: "packages/mcp/src/core/handlers.ts",
            ownerSymbol: "handleSearchCode",
            span: { startLine: 10, endLine: 20 },
        },
    });
    const ok = gradeObservation(task, baseObservation({
        taskId: "open",
        openedSymbol: {
            file: "packages/mcp/src/core/handlers.ts",
            symbol: "handleSearchCode",
            startLine: 10,
            endLine: 20,
        },
    }));
    assert.equal(ok.exactSymbolOpenSuccess, true);

    const spanMismatch = gradeObservation(task, baseObservation({
        taskId: "open",
        openedSymbol: {
            file: "packages/mcp/src/core/handlers.ts",
            symbol: "handleSearchCode",
            startLine: 10,
            endLine: 99,
        },
    }));
    assert.equal(spanMismatch.exactSymbolOpenSuccess, false);

    const noOpen = gradeObservation(task, baseObservation({ taskId: "open" }));
    assert.equal(noOpen.exactSymbolOpenSuccess, false);

    const errorWithClaimedSpan = gradeObservation(task, baseObservation({
        taskId: "open",
        status: "error",
        openedSymbol: {
            file: "packages/mcp/src/core/handlers.ts",
            symbol: "handleSearchCode",
            startLine: 10,
            endLine: 20,
        },
    }));
    assert.equal(errorWithClaimedSpan.exactSymbolOpenSuccess, false);
});

test("gradeObservation caller_recovery requires every expected caller", () => {
    const task = baseTask({
        id: "callers",
        queryClass: "caller_recovery",
        expected: {
            ownerFile: "packages/mcp/src/core/search-exact-fast-path.ts",
            ownerSymbol: "runExactRegistryFastPath",
            callerSymbols: [{
                file: "packages/mcp/src/core/handlers.ts",
                symbol: "handleSearchCode",
            }],
        },
    });
    const full = gradeObservation(task, baseObservation({
        taskId: "callers",
        response: {
            nodes: [
                {
                    symbolId: "target",
                    symbolLabel: "runExactRegistryFastPath",
                    file: "packages/mcp/src/core/search-exact-fast-path.ts",
                },
                {
                    symbolId: "caller",
                    symbolLabel: "handleSearchCode",
                    file: "packages/mcp/src/core/handlers.ts",
                },
            ],
            edges: [{ sourceSymbolId: "caller", targetSymbolId: "target" }],
        },
    }));
    assert.equal(full.callerRecoverySuccess, true);

    const partial = gradeObservation(task, baseObservation({
        taskId: "callers",
        response: { nodes: [], edges: [] },
    }));
    assert.equal(partial.callerRecoverySuccess, false);
});

test("gradeObservation handles stale/dirty fields, zero/fallback status, and baseline failures", () => {
    const dirtyTask = baseTask({ id: "dirty", queryClass: "dirty_owner" });
    const dirtyGrade = gradeObservation(dirtyTask, baseObservation({
        taskId: "dirty",
        results: [
            { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
        ],
    }));
    assert.equal(dirtyGrade.dirtyOwnerFound, true);
    assert.equal(dirtyGrade.staleIndexDetected, null);
    assert.equal(dirtyGrade.recoverySucceeded, null);

    const staleTask = baseTask({ id: "stale", queryClass: "stale_recovery" });
    const staleGrade = gradeObservation(staleTask, baseObservation({
        taskId: "stale",
        staleIndexDetected: true,
        recoverySucceeded: false,
    }));
    assert.equal(staleGrade.staleIndexDetected, true);
    assert.equal(staleGrade.recoverySucceeded, false);
    assert.equal(staleGrade.dirtyOwnerFound, null);

    const zero = gradeObservation(baseTask(), baseObservation({ status: "zero_result", results: [] }));
    assert.equal(zero.zeroResult, true);
    const fallback = gradeObservation(baseTask(), baseObservation({ status: "fallback" }));
    assert.equal(fallback.fallbackUsed, true);

    const limited = baseTask({
        baselineLimits: {
            maxLatencyMs: 5,
            maxPayloadBytes: 10,
            maxContextBytes: 50,
        },
    });
    const response = { big: "payload-value-that-exceeds-ten-bytes" };
    const graded = gradeObservation(limited, baseObservation({
        latencyMs: 40,
        contextBytes: 200,
        response,
    }));
    assert.ok(graded.payloadBytes > 10);
    assert.deepEqual(graded.baselineFailures, [
        "maxLatencyMs",
        "maxPayloadBytes",
        "maxContextBytes",
    ]);
    // Must not trust a claimed payload size if somehow present.
    assert.equal(graded.payloadBytes, serializedPayloadBytes(response));
});

// ---------------------------------------------------------------------------
// summarizeUsefulContext
// ---------------------------------------------------------------------------

test("summarizeUsefulContext reports null inapplicable metrics and deterministic ordering", () => {
    const suite = minimalSuite([
        baseTask({ id: "owner-1", queryClass: "owner_discovery" }),
        baseTask({
            id: "exact-1",
            queryClass: "exact_identifier",
            expected: {
                ownerFile: "packages/core/src/config/defaults.ts",
                ownerSymbol: "getSupportedExtensionsForIndexProfile",
            },
        }),
        baseTask({
            id: "open-1",
            queryClass: "exact_open",
            expected: {
                ownerFile: "packages/mcp/src/core/handlers.ts",
                ownerSymbol: "handleSearchCode",
                span: { startLine: 1, endLine: 2 },
            },
        }),
    ]);
    const observations = pairedObservations([
        baseObservation({
            taskId: "owner-1",
            phase: "cold",
            latencyMs: 30,
            contextBytes: 100,
            response: { a: 1 },
            results: [
                { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
            ],
        }),
        baseObservation({
            taskId: "exact-1",
            phase: "warm",
            latencyMs: 4,
            contextBytes: 20,
            response: { b: 2 },
            results: [
                {
                    file: "packages/core/src/config/defaults.ts",
                    symbol: "getSupportedExtensionsForIndexProfile",
                },
            ],
        }),
        baseObservation({
            taskId: "open-1",
            phase: "cold",
            latencyMs: 12,
            contextBytes: 40,
            response: { c: 3 },
            results: [],
            openedSymbol: {
                file: "packages/mcp/src/core/handlers.ts",
                symbol: "handleSearchCode",
                startLine: 1,
                endLine: 2,
            },
        }),
    ]);

    const report = summarizeUsefulContext(suite, observations);
    assert.equal(report.version, 1);
    assert.deepEqual(report.grades.map((g) => `${g.taskId}:${g.phase}`), [
        "owner-1:cold",
        "owner-1:warm",
        "exact-1:cold",
        "exact-1:warm",
        "open-1:cold",
        "open-1:warm",
    ]);
    assert.equal(report.taskCount, 3);
    assert.equal(report.observationCount, 6);
    assert.equal(report.metrics.callerRecoverySuccess.rate, null);
    assert.equal(report.metrics.dirtyOwnerFound.rate, null);
    assert.equal(report.metrics.staleIndexDetected.rate, null);
    assert.equal(report.metrics.recoverySucceeded.rate, null);
    assert.equal(report.metrics.exactSymbolOpenSuccess.rate, 1);
    assert.ok(report.metrics.ownerFoundTop3.rate !== null);
    assert.ok(report.metrics.latencyMs.cold);
    assert.ok(report.metrics.latencyMs.warm);
    assert.ok(report.metrics.latencyMs.exact_identifier);
    assert.equal(report.metrics.latencyMs.warm.p50, 12);
    assert.equal(report.metrics.latencyMs.exact_identifier.p50, 4);

    // payloadBytesByQueryClass keys follow fixed queryClass order.
    assert.deepEqual(
        Object.keys(report.metrics.payloadBytesByQueryClass),
        QUERY_CLASSES
    );
    assert.equal(report.metrics.payloadBytesByQueryClass.caller_recovery, null);
    assert.equal(report.metrics.payloadBytesByQueryClass.dirty_owner, null);
    assert.equal(report.metrics.payloadBytesByQueryClass.stale_recovery, null);
    assert.ok(report.metrics.payloadBytesByQueryClass.owner_discovery);
    assert.equal(report.baselineFailures.length, 0);
});

test("summarizeUsefulContext grades only in task-suite order even when observations differ", () => {
    const suite = minimalSuite([
        baseTask({ id: "z-last", queryClass: "owner_discovery" }),
        baseTask({ id: "a-first", queryClass: "exact_identifier" }),
    ]);
    const observations = pairedObservations([
        baseObservation({
            taskId: "a-first",
            phase: "warm",
            latencyMs: 1,
            results: [
                { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
            ],
        }),
        baseObservation({
            taskId: "z-last",
            phase: "cold",
            latencyMs: 9,
            results: [
                { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
            ],
        }),
    ]);
    const report = summarizeUsefulContext(suite, observations);
    assert.deepEqual(report.grades.map((g) => `${g.taskId}:${g.phase}`), [
        "z-last:cold",
        "z-last:warm",
        "a-first:cold",
        "a-first:warm",
    ]);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("parseArgs requires tasks and observations and rejects unknown options", () => {
    assert.throws(() => parseArgs([]), /--tasks|--observations/i);
    assert.throws(() => parseArgs(["--tasks", "t.json"]), /--observations/i);
    assert.throws(
        () => parseArgs(["--tasks", "t.json", "--observations", "o.json", "--verbose"]),
        /Unknown|unknown/i
    );
    const options = parseArgs([
        "--tasks",
        "/tmp/tasks.json",
        "--observations",
        "/tmp/obs.json",
        "--out",
        "/tmp/out.json",
        "--json",
    ]);
    assert.equal(options.tasksFile, path.resolve("/tmp/tasks.json"));
    assert.equal(options.observationsFile, path.resolve("/tmp/obs.json"));
    assert.equal(options.outFile, path.resolve("/tmp/out.json"));
    assert.equal(options.json, true);
});

test("CLI writes pretty JSON report with --out and exits non-zero on bad args", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-"));
    const tasksPath = path.join(tmpDir, "tasks.json");
    const obsPath = path.join(tmpDir, "obs.json");
    const outPath = path.join(tmpDir, "report.json");

    const suite = minimalSuite([
        baseTask({ id: "cli-task", queryClass: "owner_discovery" }),
    ]);
    const observations = pairedObservations([
        baseObservation({
            taskId: "cli-task",
            phase: "cold",
            latencyMs: 7,
            contextBytes: 11,
            response: { ok: true },
            results: [
                { file: "packages/mcp/src/core/handlers.ts", symbol: "handleSearchCode" },
            ],
        }),
    ]);
    fs.writeFileSync(tasksPath, `${JSON.stringify(suite, null, 2)}\n`);
    fs.writeFileSync(obsPath, `${JSON.stringify(observations, null, 2)}\n`);

    const good = spawnSync(process.execPath, [
        SCRIPT_PATH,
        "--tasks",
        tasksPath,
        "--observations",
        obsPath,
        "--out",
        outPath,
        "--json",
    ], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.ok(fs.existsSync(outPath));
    const written = fs.readFileSync(outPath, "utf8");
    assert.ok(written.endsWith("\n"));
    const report = JSON.parse(written);
    assert.equal(report.version, 1);
    assert.equal(report.grades[0].taskId, "cli-task");
    const stdoutReport = JSON.parse(good.stdout);
    assert.equal(stdoutReport.grades[0].taskId, "cli-task");

    const bad = spawnSync(process.execPath, [SCRIPT_PATH, "--tasks", tasksPath], {
        encoding: "utf8",
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--observations|Usage|error/i);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CLI writes the report and exits non-zero when a configured baseline gate fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-gate-"));
    const tasksPath = path.join(tmpDir, "tasks.json");
    const obsPath = path.join(tmpDir, "obs.json");
    const outPath = path.join(tmpDir, "report.json");
    const suite = minimalSuite([baseTask({
        id: "gated-task",
        baselineLimits: { maxLatencyMs: 1 },
    })]);
    const observations = pairedObservations([baseObservation({
        taskId: "gated-task",
        latencyMs: 999,
    })]);
    fs.writeFileSync(tasksPath, `${JSON.stringify(suite, null, 2)}\n`);
    fs.writeFileSync(obsPath, `${JSON.stringify(observations, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
        SCRIPT_PATH,
        "--tasks",
        tasksPath,
        "--observations",
        obsPath,
        "--out",
        outPath,
    ], { encoding: "utf8" });

    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.deepEqual(report.baselineFailures, [
        { taskId: "gated-task", phase: "cold", failures: ["maxLatencyMs"] },
        { taskId: "gated-task", phase: "warm", failures: ["maxLatencyMs"] },
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("committed tasks.json validates as a repeatable multi-class corpus without baseline limits", () => {
    assert.ok(fs.existsSync(COMMITTED_TASKS), "evals/useful-context/tasks.json must exist");
    const suite = JSON.parse(fs.readFileSync(COMMITTED_TASKS, "utf8"));
    const normalized = validateTaskSuite(suite);
    assert.ok(normalized.tasks.length >= 3);
    const classes = new Set(normalized.tasks.map((t) => t.queryClass));
    assert.ok(classes.size >= 3, "corpus should cover multiple query classes");
    for (const task of normalized.tasks) {
        assert.equal(task.baselineLimits, undefined);
        assert.ok(task.workload.setup.length > 0);
        assert.ok(task.workload.invocations.length > 0);
        if (task.queryClass === "exact_open") {
            const invocation = task.workload.invocations.at(-1);
            assert.equal(invocation.tool, "read_file");
            assert.equal(invocation.args.mode, "annotated");
            assert.ok(invocation.args.open_symbol);
        }
    }
});

// Ensure main export exists for programmatic use in tests that import the module.
test("module exports pure functions and main entry", () => {
    assert.equal(typeof validateTaskSuite, "function");
    assert.equal(typeof validateObservationSet, "function");
    assert.equal(typeof serializedPayloadBytes, "function");
    assert.equal(typeof nearestRankPercentile, "function");
    assert.equal(typeof gradeObservation, "function");
    assert.equal(typeof summarizeUsefulContext, "function");
    assert.equal(typeof parseArgs, "function");
    assert.equal(typeof main, "function");
});
