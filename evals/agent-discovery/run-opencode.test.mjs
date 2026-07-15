import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    aggregateSessionData,
    buildAgentPrompt,
    buildOpenCodeRunArguments,
    buildRunSchedule,
    extractAgentResult,
    formatMarkdownReport,
    getRepositoryIdentity,
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
    taskFactsTemplate: { exactMatchResolver: null },
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
});

test("versioned task keys match the current production source", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const manifest = loadTaskManifest();

    for (const task of manifest.tasks) {
        assert.doesNotThrow(() => validateTaskKey(repoRoot, task));
    }
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
    assert.equal(aggregated.events.length, 3);
});

test("grading checks hidden facts, relationships, and the real tool sequence", () => {
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
        messageId: "m2",
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

test("reporting uses medians and ranges from correct runs only", () => {
    const run = (arm, passed, wall) => ({
        taskId: "task",
        arm,
        grade: { passed },
        measurements: {
            taskWallTimeMs: wall,
            toolLatencyMs: wall / 2,
            apiInputTokens: wall,
            apiOutputTokens: 10,
            reasoningTokens: 1,
            cachedInputTokens: 2,
            visibleToolResultBytes: 100,
            toolCalls: arm === "native" ? 4 : 3,
            stepsToVerifiedAnswer: arm === "native" ? 4 : 3,
        },
    });
    const runs = [
        run("native", true, 100),
        run("native", false, 1),
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
    assert.match(report, /Only correct runs contribute/);
    assert.match(report, /300 \[100-300\]/);
});

test("agent result parser accepts compact JSON without a model-authored ledger", () => {
    assert.deepEqual(extractAgentResult("```json\n{\"status\":\"success\",\"answer\":{}}\n```"), {
        status: "success",
        answer: {},
    });
});
