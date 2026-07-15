import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    aggregateSessionData,
    buildAgentPrompt,
    buildIsolatedOpenCodeConfig,
    buildOpenCodeRunArguments,
    buildRunSchedule,
    extractAgentResult,
    formatArmCompletion,
    formatMarkdownReport,
    getRepositoryIdentity,
    getSatoriRuntimeIdentity,
    gradeRun,
    inspectNamedSymbol,
    loadTaskManifest,
    observationalStats,
    parseArgs,
    recordMcpToolDefinitions,
    rejectReusedSessions,
    summarizeRuns,
    validateTaskKey,
} from "./run-opencode.mjs";
import {
    createAgentDiscoveryGuard,
    normalizeToolOutput,
    validateToolCall,
} from "./opencode-guard.mjs";

const knownTask = {
    id: "known-exact-target",
    prompt: "Locate the production definition of targetOwner.",
    satoriQuery: "targetOwner",
    taskFactsTemplate: { exactMatchResolver: "exact bare symbol identifier" },
    expected: {
        ownerFile: "packages/mcp/src/owner.ts",
        ownerSymbol: "targetOwner",
        ownerSpan: { startLine: 1, endLine: 3 },
        requiredRelations: [{
            relation: "caller",
            symbol: "caller",
            file: "packages/mcp/src/caller.ts",
        }, {
            relation: "callee",
            symbol: "resolver",
            file: "packages/mcp/src/resolver.ts",
        }],
        taskFacts: { exactMatchResolver: "resolver" },
    },
};

test("OpenCode runner defaults to automatic all-task paired execution", () => {
    const options = parseArgs([]);

    assert.equal(options.model, "opencode/deepseek-v4-flash-free");
    assert.deepEqual(options.taskIds, []);
    assert.equal(options.repetitions, 3);
    assert.equal(options.mode, "natural");
    assert.equal(options.prepare, "sync");
});

test("argument parsing accepts pnpm's option separator", () => {
    const options = parseArgs(["--", "--mode", "coverage", "--repetitions", "1"]);

    assert.equal(options.mode, "coverage");
    assert.equal(options.repetitions, 1);
});

test("run schedule alternates arm order in fresh paired repetitions", () => {
    const schedule = buildRunSchedule([{ id: "task" }], 3);

    assert.deepEqual(schedule.map(({ repetition, arm }) => ({ repetition, arm })), [
        { repetition: 1, arm: "native" },
        { repetition: 1, arm: "satori" },
        { repetition: 2, arm: "satori" },
        { repetition: 2, arm: "native" },
        { repetition: 3, arm: "native" },
        { repetition: 3, arm: "satori" },
    ]);
});

test("arm completion output reports outcome and bounded wall time", () => {
    assert.equal(formatArmCompletion({
        taskId: "task",
        repetition: 2,
        arm: "satori",
        passed: false,
        wallTimeMs: 12_345,
    }), "Completed task repetition 2: satori FAIL in 12.3s");
});

test("generated prompts embed all run values and never request harness setup", () => {
    const prompt = buildAgentPrompt({
        repoRoot: "/repo",
        task: knownTask,
        arm: "satori",
        mode: "natural",
    });

    assert.match(prompt, /REPO_ROOT=\/repo/);
    assert.match(prompt, /TASK_ID=known-exact-target/);
    assert.match(prompt, /ARM=satori/);
    assert.match(prompt, /Do not ask the user or harness any questions/);
    assert.match(prompt, /targetOwner/);
    assert.match(prompt, /exact bare symbol identifier/);
    assert.match(prompt, /exact bare identifiers/);
    assert.match(prompt, /exact bare identifier or null; no dots, spaces, or prefixes/);
    assert.doesNotMatch(prompt, /NATIVE_TOOL_PROFILE=/);
});

test("OpenCode command creates a new session instead of continuing another arm", () => {
    const args = buildOpenCodeRunArguments({
        model: "opencode/model",
        agent: "satori-eval-native",
        title: "unique-title",
        repoRoot: "/repo",
        serverUrl: "http://127.0.0.1:1234",
        prompt: "task",
    });

    assert.deepEqual(args.slice(0, 3), ["run", "--attach", "http://127.0.0.1:1234"]);
    assert.ok(args.includes("--format"));
    assert.ok(args.includes("--agent"));
    assert.ok(args.includes("--title"));
    assert.ok(!args.includes("--session"));
    assert.ok(!args.includes("--continue"));
    assert.ok(!args.includes("--fork"));
});

test("isolated OpenCode config binds Satori to the measured worktree runtime", () => {
    const config = buildIsolatedOpenCodeConfig({
        mcp: {
            satori: {
                type: "local",
                command: ["node", "/other/checkout/packages/mcp/dist/index.js"],
                environment: { SATORI_STATE_ROOT: "/state" },
            },
        },
    }, "opencode/model", "/measured/repo");

    assert.deepEqual(config.mcp.satori.command, [
        process.execPath,
        "/measured/repo/packages/mcp/dist/index.js",
    ]);
    assert.deepEqual(config.mcp.satori.environment, { SATORI_STATE_ROOT: "/state" });
    assert.equal(config.agent["satori-eval-native"].steps, 26);
    assert.equal(config.agent["satori-eval-satori"].steps, 26);
});

test("Satori runtime identity covers deterministic Core and MCP build outputs", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-agent-runtime-"));
    const coreDist = path.join(repoRoot, "packages/core/dist");
    const mcpDist = path.join(repoRoot, "packages/mcp/dist");
    fs.mkdirSync(path.join(coreDist, "nested"), { recursive: true });
    fs.mkdirSync(mcpDist, { recursive: true });
    fs.writeFileSync(path.join(coreDist, "index.js"), "export * from './nested/helper.js';\n");
    fs.writeFileSync(path.join(coreDist, "nested/helper.js"), "export const value = 1;\n");
    fs.writeFileSync(path.join(mcpDist, "index.js"), "import '@zokizuan/satori-core';\n");

    try {
        const initial = getSatoriRuntimeIdentity(repoRoot);
        const repeated = getSatoriRuntimeIdentity(repoRoot);
        assert.deepEqual(repeated, initial);
        assert.equal(initial.nodeVersion, process.version);
        assert.deepEqual(initial.roots.map(({ relativeRoot, fileCount }) => ({
            relativeRoot,
            fileCount,
        })), [
            { relativeRoot: "packages/core/dist", fileCount: 2 },
            { relativeRoot: "packages/mcp/dist", fileCount: 1 },
        ]);

        fs.writeFileSync(path.join(coreDist, "nested/helper.js"), "export const value = 2;\n");
        assert.notEqual(getSatoriRuntimeIdentity(repoRoot).sha256, initial.sha256);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test("task-key validation aborts when a versioned source span is stale", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-agent-task-"));
    fs.mkdirSync(path.join(repoRoot, "packages/mcp/src"), { recursive: true });
    fs.writeFileSync(
        path.join(repoRoot, "packages/mcp/src/owner.ts"),
        "export function targetOwner() {\n  return resolver();\n}\n",
    );
    fs.writeFileSync(
        path.join(repoRoot, "packages/mcp/src/caller.ts"),
        "export function caller() { return targetOwner(); }\n",
    );
    fs.writeFileSync(
        path.join(repoRoot, "packages/mcp/src/resolver.ts"),
        "export function resolver() { return true; }\n",
    );

    const inspected = inspectNamedSymbol(
        repoRoot,
        "packages/mcp/src/owner.ts",
        "targetOwner",
    );
    assert.deepEqual(inspected.span, { startLine: 1, endLine: 3 });
    assert.doesNotThrow(() => validateTaskKey(repoRoot, knownTask));
    assert.throws(
        () => validateTaskKey(repoRoot, {
            ...knownTask,
            expected: {
                ...knownTask.expected,
                ownerSpan: { startLine: 1, endLine: 2 },
            },
        }),
        /Stale task key/,
    );
    assert.throws(
        () => validateTaskKey(repoRoot, {
            ...knownTask,
            expected: {
                ...knownTask.expected,
                requiredRelations: knownTask.expected.requiredRelations.map((relation) => (
                    relation.symbol === "resolver"
                        ? { ...relation, file: "packages/mcp/src/caller.ts" }
                        : relation
                )),
            },
        }),
        /Expected symbol resolver was not found in packages\/mcp\/src\/caller\.ts/,
    );
});

test("versioned task keys match the current production source", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const manifest = loadTaskManifest();

    for (const task of manifest.tasks) {
        assert.doesNotThrow(() => validateTaskKey(repoRoot, task));
    }
});

test("unknown-target prompt explicitly requests every graded relationship", () => {
    const manifest = loadTaskManifest();
    const task = manifest.tasks.find((candidate) => candidate.id === "unknown-freshness-reuse");

    assert.match(task.prompt, /production caller/i);
    assert.match(task.prompt, /authority-preservation helper/i);
    assert.match(task.prompt, /second-readiness-proof/i);
});

test("repository identity binds revision, tree, staged diff, and unstaged diff", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-agent-identity-"));
    const git = (...args) => execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Satori Test",
            GIT_AUTHOR_EMAIL: "satori@example.invalid",
            GIT_COMMITTER_NAME: "Satori Test",
            GIT_COMMITTER_EMAIL: "satori@example.invalid",
        },
    });
    git("init", "--quiet");
    fs.writeFileSync(path.join(repoRoot, "source.ts"), "export const value = 1;\n");
    git("add", "source.ts");
    git("commit", "--quiet", "-m", "fixture");

    const clean = await getRepositoryIdentity(repoRoot);
    assert.match(clean.gitRevision, /^[a-f0-9]{40}$/);
    assert.match(clean.gitTree, /^[a-f0-9]{40}$/);
    assert.equal(clean.gitDiffSha256, clean.gitCachedDiffSha256);

    fs.writeFileSync(path.join(repoRoot, "source.ts"), "export const value = 2;\n");
    const unstaged = await getRepositoryIdentity(repoRoot);
    assert.notEqual(unstaged.gitDiffSha256, clean.gitDiffSha256);
    assert.equal(unstaged.gitCachedDiffSha256, clean.gitCachedDiffSha256);

    git("add", "source.ts");
    const staged = await getRepositoryIdentity(repoRoot);
    assert.equal(staged.gitDiffSha256, clean.gitDiffSha256);
    assert.notEqual(staged.gitCachedDiffSha256, clean.gitCachedDiffSha256);
});

test("duplicate OpenCode sessions invalidate both measured arms", () => {
    const run = (runId) => ({
        runId,
        harness: { sessionId: "reused-session" },
        grade: { passed: true, failureReasons: [] },
    });
    const runs = [run("native"), run("satori")];

    rejectReusedSessions(runs);

    for (const measuredRun of runs) {
        assert.equal(measuredRun.grade.passed, false);
        assert.deepEqual(measuredRun.grade.failureReasons, [
            "session_reused:reused-session",
        ]);
    }
});

test("guard rejects forbidden tools and native reads without an explicit bound", () => {
    const repoRoot = "/repo";
    assert.throws(
        () => validateToolCall("bash", { command: "rg target" }, repoRoot),
        /forbidden_tool/,
    );
    assert.throws(
        () => validateToolCall("read", {
            filePath: "/repo/packages/mcp/src/owner.ts",
        }, repoRoot),
        /read_limit_required/,
    );
    assert.doesNotThrow(() => validateToolCall("read", {
        filePath: "/repo/packages/mcp/src/owner.ts",
        offset: 1,
        limit: 200,
    }, repoRoot));
});

test("guard uses a 24-call runaway ceiling while OpenCode has 26 model steps", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-agent-budget-"));
    const hooks = createAgentDiscoveryGuard({
        SATORI_AGENT_DISCOVERY_RUN_ID: "suite",
        SATORI_AGENT_DISCOVERY_REPO_ROOT: "/repo",
        SATORI_AGENT_DISCOVERY_TOOL_LEDGER: path.join(directory, "ledger.jsonl"),
        SATORI_AGENT_DISCOVERY_TOOL_DEFINITIONS: path.join(directory, "definitions.jsonl"),
    });
    const output = {
        args: {
            path: "/repo/packages/mcp/src",
            pattern: "target",
        },
    };

    for (let index = 1; index <= 24; index += 1) {
        await assert.doesNotReject(() => hooks["tool.execute.before"]({
            tool: "grep",
            sessionID: "session",
            callID: `call-${index}`,
        }, output));
    }
    await assert.rejects(() => hooks["tool.execute.before"]({
        tool: "grep",
        sessionID: "session",
        callID: "call-25",
    }, output), /agent_discovery_tool_budget_exhausted/);
});

test("guard strips test evidence and caps model-visible tool output at 32768 bytes", () => {
    const normalized = normalizeToolOutput(
        `packages/mcp/src/owner.test.ts:1 ignored\n${"x".repeat(40_000)}`,
        "grep",
    );

    assert.equal(normalized.truncated, true);
    assert.ok(Buffer.byteLength(normalized.output, "utf8") <= 32_768);
    assert.doesNotMatch(normalized.output, /owner\.test\.ts/);
    assert.match(normalized.output, /TRUNCATED AT 32768 UTF-8 BYTES/);
});

test("guard records actual tool definitions and raw versus visible bytes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-agent-guard-"));
    const ledger = path.join(directory, "ledger.jsonl");
    const definitions = path.join(directory, "definitions.jsonl");
    const hooks = createAgentDiscoveryGuard({
        SATORI_AGENT_DISCOVERY_RUN_ID: "suite",
        SATORI_AGENT_DISCOVERY_REPO_ROOT: "/repo",
        SATORI_AGENT_DISCOVERY_TOOL_LEDGER: ledger,
        SATORI_AGENT_DISCOVERY_TOOL_DEFINITIONS: definitions,
    });
    await hooks["tool.definition"](
        { toolID: "read" },
        { description: "Read a file", parameters: { type: "object" } },
    );
    const input = {
        filePath: "/repo/packages/mcp/src/owner.ts",
        offset: 1,
        limit: 20,
    };
    await hooks["tool.execute.before"](
        { tool: "read", sessionID: "session", callID: "call" },
        { args: input },
    );
    const output = { output: "owner source", metadata: {} };
    await hooks["tool.execute.after"](
        { tool: "read", sessionID: "session", callID: "call", args: input },
        output,
    );

    const definitionRecord = JSON.parse(fs.readFileSync(definitions, "utf8").trim());
    const ledgerRecords = fs.readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(definitionRecord.tool, "read");
    assert.equal(ledgerRecords.at(-1).rawBytes, 12);
    assert.equal(ledgerRecords.at(-1).visibleBytes, 12);
});

test("runner records authoritative Satori schemas from MCP tools/list", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-agent-mcp-schema-"));
    const definitions = path.join(directory, "definitions.jsonl");
    recordMcpToolDefinitions(definitions, "suite", [{
        name: "search_codebase",
        description: "Search source",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
        },
    }]);

    const record = JSON.parse(fs.readFileSync(definitions, "utf8").trim());
    assert.equal(record.tool, "satori_search_codebase");
    assert.equal(record.parameters.format, "mcp-input-schema");
    assert.deepEqual(record.parameters.value.required, ["query"]);
});

test("guard leaves MCP output untouched when OpenCode does not expose its body", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-agent-mcp-guard-"));
    const ledger = path.join(directory, "ledger.jsonl");
    const hooks = createAgentDiscoveryGuard({
        SATORI_AGENT_DISCOVERY_RUN_ID: "suite",
        SATORI_AGENT_DISCOVERY_REPO_ROOT: "/repo",
        SATORI_AGENT_DISCOVERY_TOOL_LEDGER: ledger,
        SATORI_AGENT_DISCOVERY_TOOL_DEFINITIONS: path.join(directory, "definitions.jsonl"),
    });
    const input = {
        path: "/repo",
        query: "target",
        scope: "runtime",
        resultMode: "grouped",
        groupBy: "symbol",
        rankingMode: "default",
        limit: 5,
    };
    await hooks["tool.execute.before"](
        { tool: "satori_search_codebase", sessionID: "session", callID: "call" },
        { args: input },
    );
    const output = { output: undefined, metadata: {} };
    await hooks["tool.execute.after"](
        { tool: "satori_search_codebase", sessionID: "session", callID: "call", args: input },
        output,
    );

    const record = fs.readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse).at(-1);
    assert.equal(output.output, undefined);
    assert.equal(record.outputUnavailableInHook, true);
    assert.equal(record.rawBytes, null);
});

function syntheticPersistedSession() {
    return {
        session: { id: "session" },
        messages: [{
            id: "assistant-1",
            time_created: 1_000,
            time_updated: 1_100,
            data: {
                role: "assistant",
                providerID: "opencode",
                modelID: "model",
                variant: "max",
                finish: "tool-calls",
                time: { created: 1_000, completed: 1_100 },
                tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 20 } },
            },
        }, {
            id: "assistant-2",
            time_created: 1_200,
            time_updated: 1_300,
            data: {
                role: "assistant",
                providerID: "opencode",
                modelID: "model",
                variant: "max",
                finish: "stop",
                time: { created: 1_200, completed: 1_300 },
                tokens: { input: 150, output: 20, reasoning: 6, cache: { read: 30 } },
            },
        }],
        parts: [{
            id: "tool-1",
            message_id: "assistant-1",
            time_created: 1_090,
            time_updated: 1_150,
            data: {
                type: "tool",
                tool: "read",
                callID: "call-1",
                state: {
                    status: "completed",
                    input: { filePath: "/repo/packages/mcp/src/owner.ts", offset: 1, limit: 20 },
                    output: "packages/mcp/src/owner.ts targetOwner resolver",
                    time: { start: 1_090, end: 1_150 },
                },
            },
        }, {
            id: "final-text",
            message_id: "assistant-2",
            time_created: 1_250,
            time_updated: 1_290,
            data: { type: "text", text: "{\"status\":\"success\"}" },
        }],
    };
}

test("session aggregation uses provider and tool events for authoritative measurements", () => {
    const aggregated = aggregateSessionData({
        persisted: syntheticPersistedSession(),
        expected: {
            ownerFile: "packages/mcp/src/owner.ts",
            ownerSymbol: "targetOwner",
            requiredRelations: [{
                relation: "callee",
                symbol: "resolver",
                file: "packages/mcp/src/owner.ts",
            }],
        },
        toolLedger: [],
        dispatchStartedAtMs: 900,
        responseReceivedAtMs: 1_400,
    });

    assert.equal(aggregated.measurements.taskWallTimeMs, 500);
    assert.equal(aggregated.measurements.modelApiLatencyMs, 200);
    assert.equal(aggregated.measurements.toolLatencyMs, 60);
    assert.equal(aggregated.measurements.apiInputTokens, 250);
    assert.equal(aggregated.measurements.apiOutputTokens, 30);
    assert.equal(aggregated.measurements.reasoningTokens, 11);
    assert.equal(aggregated.measurements.cachedInputTokens, 50);
    assert.equal(aggregated.measurements.toolCalls, 1);
    assert.equal(aggregated.measurements.stepsToVerifiedAnswer, 1);
    assert.equal(aggregated.measurements.investigationTailToolCalls, 0);
    assert.equal(aggregated.events.length, 3);
});

test("session aggregation separates retrieval, evidence completion, and investigation tail", () => {
    const persisted = syntheticPersistedSession();
    persisted.parts = [
        {
            id: "tool-target",
            message_id: "assistant-1",
            time_created: 1_010,
            time_updated: 1_020,
            data: {
                type: "tool",
                tool: "grep",
                callID: "call-target",
                state: {
                    status: "completed",
                    input: { path: "/repo/packages/mcp/src", pattern: "targetOwner" },
                    output: "packages/mcp/src/owner.ts targetOwner",
                    time: { start: 1_010, end: 1_020 },
                },
            },
        },
        {
            id: "tool-source",
            message_id: "assistant-1",
            time_created: 1_030,
            time_updated: 1_040,
            data: {
                type: "tool",
                tool: "read",
                callID: "call-source",
                state: {
                    status: "completed",
                    input: { filePath: "/repo/packages/mcp/src/owner.ts" },
                    output: "targetOwner implementation",
                    time: { start: 1_030, end: 1_040 },
                },
            },
        },
        {
            id: "tool-relation",
            message_id: "assistant-1",
            time_created: 1_050,
            time_updated: 1_060,
            data: {
                type: "tool",
                tool: "grep",
                callID: "call-relation",
                state: {
                    status: "completed",
                    input: { path: "/repo/packages/mcp/src", pattern: "resolver" },
                    output: "packages/mcp/src/resolver.ts resolver",
                    time: { start: 1_050, end: 1_060 },
                },
            },
        },
        {
            id: "tool-tail",
            message_id: "assistant-1",
            time_created: 1_070,
            time_updated: 1_080,
            data: {
                type: "tool",
                tool: "grep",
                callID: "call-tail",
                state: {
                    status: "completed",
                    input: { path: "/repo/packages/mcp/src", pattern: "unneeded" },
                    output: "unneeded follow-up",
                    time: { start: 1_070, end: 1_080 },
                },
            },
        },
        persisted.parts.at(-1),
    ];

    const expected = {
        ownerFile: "packages/mcp/src/owner.ts",
        ownerSymbol: "targetOwner",
        requiredRelations: [{
            relation: "callee",
            symbol: "resolver",
            file: "packages/mcp/src/resolver.ts",
        }],
    };
    const aggregated = aggregateSessionData({
        persisted,
        expected,
        toolLedger: [],
        dispatchStartedAtMs: 1_000,
        responseReceivedAtMs: 1_300,
    });

    assert.equal(aggregated.measurements.stepsToFirstCorrectTarget, 1);
    assert.equal(aggregated.measurements.stepsToFirstOwnerSource, 2);
    assert.equal(aggregated.measurements.stepsToVerifiedAnswer, 3);
    assert.equal(aggregated.measurements.investigationTailToolCalls, 1);

    const incomplete = aggregateSessionData({
        persisted,
        expected: {
            ...expected,
            requiredRelations: [{
                relation: "caller",
                symbol: "missingCaller",
                file: "packages/mcp/src/missing.ts",
            }],
        },
        toolLedger: [],
        dispatchStartedAtMs: 1_000,
        responseReceivedAtMs: 1_300,
    });
    assert.equal(incomplete.measurements.stepsToVerifiedAnswer, null);
    assert.equal(incomplete.measurements.investigationTailToolCalls, null);
});

test("grading checks hidden facts and relationships while allowing parallel tool calls", () => {
    const agentResult = {
        status: "success",
        answer: {
            ownerFile: knownTask.expected.ownerFile,
            ownerSymbol: knownTask.expected.ownerSymbol,
            ownerSpan: knownTask.expected.ownerSpan,
            relatedSymbols: knownTask.expected.requiredRelations,
            taskFacts: knownTask.expected.taskFacts,
            behavioralConclusion: "Owner behavior.",
        },
    };
    const tools = [{
        tool: "grep",
        messageId: "m1",
        input: { path: "/repo/packages/mcp/src", pattern: "targetOwner" },
        output: "packages/mcp/src/owner.ts:1 targetOwner\npackages/mcp/src/caller.ts:1 caller",
    }, {
        tool: "read",
        messageId: "m1",
        input: { filePath: "/repo/packages/mcp/src/owner.ts", offset: 1, limit: 20 },
        output: "targetOwner resolver",
    }];

    const grade = gradeRun({
        agentResult,
        task: knownTask,
        arm: "native",
        mode: "natural",
        repoRoot: "/repo",
        tools,
    });
    assert.equal(grade.passed, true);
    assert.deepEqual(grade.failureReasons, []);
});

test("grading accepts qualified identifiers but rejects prose symbol labels", () => {
    const resultWithCaller = (symbol) => ({
        status: "success",
        answer: {
            ownerFile: knownTask.expected.ownerFile,
            ownerSymbol: "SearchOwner.targetOwner",
            ownerSpan: knownTask.expected.ownerSpan,
            relatedSymbols: knownTask.expected.requiredRelations.map((relation) => (
                relation.relation === "caller" ? { ...relation, symbol } : relation
            )),
            taskFacts: knownTask.expected.taskFacts,
            behavioralConclusion: "Owner behavior.",
        },
    });
    const tools = [{
        tool: "grep",
        messageId: "m1",
        input: { path: "/repo/packages/mcp/src", pattern: "targetOwner" },
        output: "packages/mcp/src/owner.ts targetOwner packages/mcp/src/caller.ts caller",
    }];

    assert.equal(gradeRun({
        agentResult: resultWithCaller("ToolHandlers.caller"),
        task: knownTask,
        arm: "native",
        mode: "natural",
        repoRoot: "/repo",
        tools,
    }).passed, true);
    assert.match(gradeRun({
        agentResult: resultWithCaller("method caller"),
        task: knownTask,
        arm: "native",
        mode: "natural",
        repoRoot: "/repo",
        tools,
    }).failureReasons.join(","), /missing_relation:caller:caller/);
});

test("reporting separates retrieval, evidence route, and final agent cost", () => {
    const run = (arm, passed, wall, milestones = {}) => ({
        taskId: "task",
        arm,
        grade: { passed },
        measurements: {
            taskWallTimeMs: wall,
            timeToFirstCorrectTargetMs: milestones.targetMs === undefined
                ? wall / 2
                : milestones.targetMs,
            timeToFirstOwnerSourceMs: milestones.sourceMs === undefined
                ? wall / 2 + 10
                : milestones.sourceMs,
            toolLatencyMs: wall / 2,
            apiInputTokens: wall,
            apiOutputTokens: 10,
            reasoningTokens: 1,
            cachedInputTokens: 2,
            visibleToolResultBytes: 100,
            toolCalls: arm === "native" ? 4 : 3,
            modelTurns: arm === "native" ? 5 : 4,
            stepsToFirstCorrectTarget: milestones.targetStep === undefined
                ? 1
                : milestones.targetStep,
            stepsToFirstOwnerSource: milestones.sourceStep === undefined
                ? 2
                : milestones.sourceStep,
            stepsToVerifiedAnswer: milestones.verifiedStep === undefined
                ? (arm === "native" ? 4 : 3)
                : milestones.verifiedStep,
            investigationTailToolCalls: milestones.tail === undefined
                ? 0
                : milestones.tail,
        },
    });
    const runs = [
        run("native", true, 100),
        run("native", false, 1, {
            targetMs: 1,
            sourceMs: 2,
            targetStep: 1,
            sourceStep: 2,
            verifiedStep: null,
            tail: null,
        }),
        run("native", true, 300),
        run("satori", true, 80),
        run("satori", true, 120),
    ];
    const summary = summarizeRuns(runs);
    const report = formatMarkdownReport(summary, {
        suiteId: "suite",
        gitRevision: "abc",
        openCodeVersion: "1.17.20",
        model: "opencode/model",
        mode: "natural",
        repetitions: 2,
    });

    assert.deepEqual(observationalStats(runs.filter((run) => run.grade.passed), "taskWallTimeMs"), {
        samples: 4,
        median: 120,
        min: 80,
        max: 300,
    });
    assert.equal(summary.task.native.metrics.taskWallTimeMs.median, 300);
    assert.equal(summary.task.native.allMetrics.taskWallTimeMs.median, 100);
    assert.equal(summary.task.native.allMetrics.stepsToFirstCorrectTarget.samples, 3);
    assert.equal(summary.task.native.allMetrics.stepsToVerifiedAnswer.samples, 2);
    assert.match(report, /## 1\. Retrieval quality - all attempts/);
    assert.match(report, /## 2\. Evidence route - all attempts/);
    assert.match(report, /## 3\. Full autonomous-agent cost - correct runs only/);
    assert.match(report, /Final session totals include any investigation tail/);
    assert.match(report, /3\/3/);
    assert.match(report, /2\/3/);
    assert.match(report, /300 \[100-300\]/);
    assert.match(report, /Raw cost of all attempts/);
    assert.match(report, /100 \[1-300\]/);
    assert.match(report, /Raw Satori minus native median/);
});

test("agent result parser accepts compact JSON without a model-authored ledger", () => {
    assert.deepEqual(extractAgentResult("```json\n{\"status\":\"success\",\"answer\":{}}\n```"), {
        status: "success",
        answer: {},
    });
});

test("agent result parser prefers fenced result JSON over earlier brace fragments", () => {
    const response = [
        'Observed ownerSpan: {"startLine":176,"endLine":542}',
        "```json",
        '{"status":"success","answer":{"ownerSymbol":"targetOwner"}}',
        "```",
    ].join("\n");

    assert.deepEqual(extractAgentResult(response), {
        status: "success",
        answer: { ownerSymbol: "targetOwner" },
    });
});

test("agent result parser finds a result object after an unmatched prose brace", () => {
    const response = [
        "Unfinished note: { owner span follows",
        '{"status":"success","answer":{}}',
    ].join("\n");

    assert.deepEqual(extractAgentResult(response), {
        status: "success",
        answer: {},
    });
});
