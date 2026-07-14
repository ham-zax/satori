#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
    JsonRpcStdioSession,
    decodeToolResponse,
} from "../../scripts/satori-useful-context-record.mjs";
import { NATIVE_TOOLS, SATORI_TOOLS } from "./opencode-guard.mjs";

const PROTOCOL_VERSION = "satori-agent-discovery-v2";
const DEFAULT_MODEL = "opencode/deepseek-v4-flash-free";
const DEFAULT_REPETITIONS = 3;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 300_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MODES = new Set(["natural", "coverage"]);
const PREPARE_MODES = new Set(["sync", "status"]);
const ARM_ORDER = Object.freeze([
    Object.freeze(["native", "satori"]),
    Object.freeze(["satori", "native"]),
]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS_FILE = path.join(SCRIPT_DIR, "evaluator-tasks.json");
const INSTRUCTIONS_FILE = path.join(SCRIPT_DIR, "AGENT_INSTRUCTIONS.md");
const GUARD_PLUGIN_FILE = path.join(SCRIPT_DIR, "opencode-plugin.mjs");

function usage() {
    return [
        "Usage: pnpm eval:agent-discovery [options]",
        "",
        "Runs every configured task in isolated native and Satori OpenCode sessions.",
        "No repository path, task, arm, or native tool profile is requested interactively.",
        "",
        "Options:",
        `  --model <provider/model>       Default: ${DEFAULT_MODEL}`,
        "  --task <id>                    Repeat to select tasks; default: all tasks",
        `  --repetitions <count>           Default: ${DEFAULT_REPETITIONS}`,
        "  --mode <natural|coverage>       Default: natural",
        "  --prepare <sync|status>         Default: sync; setup is not measured",
        "  --output-dir <directory>        Default: .satori/benchmarks/agent-discovery",
        "  --variant <name>                Optional provider reasoning variant",
        `  --timeout-ms <milliseconds>     Per-arm timeout; default: ${DEFAULT_TIMEOUT_MS}`,
        "  --opencode <executable>         Default: opencode",
        "  --dry-run                       Validate and print the immutable run plan only",
        "  --help                          Show this help",
    ].join("\n");
}

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

export function parseArgs(argv, environment = process.env) {
    const options = {
        repoRoot: null,
        model: environment.SATORI_AGENT_DISCOVERY_MODEL ?? DEFAULT_MODEL,
        taskIds: [],
        repetitions: DEFAULT_REPETITIONS,
        mode: "natural",
        prepare: "sync",
        outputDir: null,
        variant: null,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        opencodeCommand: "opencode",
        tasksFile: DEFAULT_TASKS_FILE,
        dryRun: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value after ${argument}.`);
            return argv[index];
        };
        if (argument === "--") {
            continue;
        } else if (argument === "--repo") {
            options.repoRoot = path.resolve(next());
        } else if (argument === "--model") {
            options.model = next();
        } else if (argument === "--task") {
            options.taskIds = [...options.taskIds, next()];
        } else if (argument === "--repetitions") {
            options.repetitions = positiveInteger(next(), argument);
        } else if (argument === "--mode") {
            options.mode = next();
        } else if (argument === "--prepare") {
            options.prepare = next();
        } else if (argument === "--output-dir") {
            options.outputDir = path.resolve(next());
        } else if (argument === "--variant") {
            options.variant = next();
        } else if (argument === "--timeout-ms") {
            options.timeoutMs = positiveInteger(next(), argument);
        } else if (argument === "--opencode") {
            options.opencodeCommand = next();
        } else if (argument === "--tasks-file") {
            options.tasksFile = path.resolve(next());
        } else if (argument === "--dry-run") {
            options.dryRun = true;
        } else if (argument === "--help" || argument === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }

    if (!MODES.has(options.mode)) throw new Error(`Unsupported mode '${options.mode}'.`);
    if (!PREPARE_MODES.has(options.prepare)) {
        throw new Error(`Unsupported preparation mode '${options.prepare}'.`);
    }
    if (!options.model.includes("/")) {
        throw new Error("--model must use provider/model syntax.");
    }
    return options;
}

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, stableValue(value[key])]),
        );
    }
    return value;
}

function stableJson(value) {
    return JSON.stringify(stableValue(value));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value;
}

export function loadTaskManifest(file = DEFAULT_TASKS_FILE) {
    const manifest = readJson(file);
    if (!isRecord(manifest) || manifest.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Task manifest must use ${PROTOCOL_VERSION}.`);
    }
    if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
        throw new Error("Task manifest must contain at least one task.");
    }
    const ids = manifest.tasks.map((task) => requireString(task?.id, "task.id"));
    if (new Set(ids).size !== ids.length) throw new Error("Task IDs must be unique.");
    for (const task of manifest.tasks) {
        requireString(task.prompt, `${task.id}.prompt`);
        requireString(task.satoriQuery, `${task.id}.satoriQuery`);
        if (!isRecord(task.taskFactsTemplate) || !isRecord(task.expected)) {
            throw new Error(`${task.id} requires taskFactsTemplate and expected objects.`);
        }
        const templateKeys = Object.keys(task.taskFactsTemplate).sort();
        const expectedKeys = Object.keys(task.expected.taskFacts ?? {}).sort();
        if (stableJson(templateKeys) !== stableJson(expectedKeys)) {
            throw new Error(`${task.id} task fact template does not match the hidden key.`);
        }
    }
    return manifest;
}

function declarationName(node, sourceFile) {
    return node.name?.getText(sourceFile) ?? null;
}

function findNamedDeclaration(sourceFile, symbolName) {
    let match = null;
    const visit = (node) => {
        if (!match && declarationName(node, sourceFile) === symbolName
            && (ts.isFunctionDeclaration(node)
                || ts.isMethodDeclaration(node)
                || ts.isVariableDeclaration(node))) {
            match = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return match;
}

function sourceFileFor(repoRoot, relativeFile) {
    const absoluteFile = path.join(repoRoot, relativeFile);
    const sourceText = fs.readFileSync(absoluteFile, "utf8");
    return ts.createSourceFile(
        absoluteFile,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

export function inspectNamedSymbol(repoRoot, relativeFile, symbolName) {
    const sourceFile = sourceFileFor(repoRoot, relativeFile);
    const declaration = findNamedDeclaration(sourceFile, symbolName);
    if (!declaration) {
        throw new Error(`Expected symbol ${symbolName} was not found in ${relativeFile}.`);
    }
    return {
        sourceFile,
        declaration,
        span: {
            startLine: sourceFile.getLineAndCharacterOfPosition(
                declaration.getStart(sourceFile),
            ).line + 1,
            endLine: sourceFile.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1,
        },
    };
}

function declarationCalls(sourceFile, declaration, targetName) {
    let called = false;
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const expression = node.expression;
            const calledName = ts.isIdentifier(expression)
                ? expression.text
                : ts.isPropertyAccessExpression(expression)
                    ? expression.name.text
                    : null;
            if (calledName === targetName) called = true;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    return called;
}

export function validateTaskKey(repoRoot, task) {
    const expected = task.expected;
    const owner = inspectNamedSymbol(repoRoot, expected.ownerFile, expected.ownerSymbol);
    if (stableJson(owner.span) !== stableJson(expected.ownerSpan)) {
        throw new Error(
            `Stale task key '${task.id}': expected ${expected.ownerSymbol} `
            + `${expected.ownerSpan.startLine}-${expected.ownerSpan.endLine}, `
            + `current source is ${owner.span.startLine}-${owner.span.endLine}.`,
        );
    }
    for (const relation of expected.requiredRelations ?? []) {
        const related = relation.relation === "caller" || relation.span
            ? inspectNamedSymbol(repoRoot, relation.file, relation.symbol)
            : null;
        if (relation.span && related && stableJson(related.span) !== stableJson(relation.span)) {
            throw new Error(
                `Stale task key '${task.id}': expected ${relation.symbol} `
                + `${relation.span.startLine}-${relation.span.endLine}, `
                + `current source is ${related.span.startLine}-${related.span.endLine}.`,
            );
        }
        if (relation.relation === "caller") {
            if (!related) throw new Error(`Missing caller key for ${relation.symbol}.`);
            if (!declarationCalls(related.sourceFile, related.declaration, expected.ownerSymbol)) {
                throw new Error(
                    `Stale task key '${task.id}': ${relation.symbol} no longer calls ${expected.ownerSymbol}.`,
                );
            }
            continue;
        }
        if (!declarationCalls(owner.sourceFile, owner.declaration, relation.symbol)) {
            throw new Error(
                `Stale task key '${task.id}': ${expected.ownerSymbol} no longer calls ${relation.symbol}.`,
            );
        }
    }
    return { taskId: task.id, ownerSpan: owner.span };
}

export function rejectReusedSessions(runs) {
    const sessionOwners = new Map();
    for (const run of runs) {
        const sessionId = run.harness?.sessionId;
        if (!sessionId) continue;
        const priorRun = sessionOwners.get(sessionId);
        if (!priorRun) {
            sessionOwners.set(sessionId, run);
            continue;
        }
        for (const duplicate of [priorRun, run]) {
            duplicate.grade.failureReasons = [
                ...new Set([
                    ...duplicate.grade.failureReasons,
                    `session_reused:${sessionId}`,
                ]),
            ];
            duplicate.grade.passed = false;
        }
    }
}

export function buildRunSchedule(tasks, repetitions = DEFAULT_REPETITIONS) {
    return tasks.flatMap((task) => Array.from({ length: repetitions }, (_, repetitionIndex) => {
        const repetition = repetitionIndex + 1;
        const arms = ARM_ORDER[repetitionIndex % ARM_ORDER.length];
        return arms.map((arm, orderIndex) => ({
            taskId: task.id,
            repetition,
            arm,
            order: orderIndex + 1,
        }));
    }).flat());
}

function commonPromptRules(repoRoot, task, arm, mode) {
    return [
        "You are one measured arm of a deterministic code-discovery evaluation.",
        "All run values are complete. Do not ask the user or harness any questions.",
        `REPO_ROOT=${repoRoot}`,
        `TASK_ID=${task.id}`,
        `ARM=${arm}`,
        `MODE=${mode}`,
        "",
        "TASK (identical in both arms):",
        task.prompt,
        "",
        "Rules:",
        "- Treat the repository as read-only.",
        "- Inspect production TypeScript only under packages/core/src and packages/mcp/src.",
        "- Never inspect *.test.ts, docs, evaluator files, Git history, or prior results.",
        "- Make at most 12 tool calls and exactly one tool call per model turn.",
        "- Follow visible evidence from one result to the next; do not use a remembered path.",
        "- Stop as soon as the owner source, complete span, required relationships, and facts are proven.",
        "- Do not estimate or report timing, tokens, bytes, or tool counts; the harness owns them.",
    ];
}

function nativePromptRules() {
    return [
        "Native-arm tools and constraints:",
        "- Use only grep, glob, and read.",
        "- Every grep/glob path and read file must be inside an allowed production source root.",
        "- Every read call must specify a positive limit no greater than 200 lines.",
        "- Discover a path with grep/glob before reading it.",
        "- Start with a term or identifier from the task, then refine only from visible results.",
    ];
}

function satoriPromptRules(repoRoot, task, mode) {
    const natural = [
        "Satori-arm tools and constraints:",
        "- Use only satori_search_codebase, satori_read_file, satori_file_outline, and satori_call_graph.",
        "- The first call must be satori_search_codebase with exactly these arguments:",
        JSON.stringify({
            path: repoRoot,
            query: task.satoriQuery,
            scope: "runtime",
            resultMode: "grouped",
            groupBy: "symbol",
            rankingMode: "default",
            limit: 5,
        }),
        "- Use target.file and target.symbolId from visible search evidence; do not invent them.",
        "- Use the fewest Satori operations needed to prove the answer.",
    ];
    if (mode === "natural") return natural;
    return [
        ...natural.slice(0, -1),
        "- Tool-coverage mode requires search, exact symbol open, exact outline, then call graph.",
        "- Pass the complete target object from search to call graph unchanged.",
    ];
}

export function buildAgentPrompt({ repoRoot, task, arm, mode }) {
    const answerShape = {
        status: "success|not_found|tool_error|budget_exhausted|protocol_violation",
        answer: {
            ownerFile: "repository-relative path or null",
            ownerSymbol: "symbol or null",
            ownerSpan: { startLine: "integer", endLine: "integer" },
            relatedSymbols: [{
                symbol: "symbol",
                relation: "caller|callee|helper|second_readiness_proof",
                file: "repository-relative path",
            }],
            taskFacts: task.taskFactsTemplate,
            behavioralConclusion: "at most 800 characters",
        },
    };
    const armRules = arm === "native"
        ? nativePromptRules()
        : satoriPromptRules(repoRoot, task, mode);
    return [
        ...commonPromptRules(repoRoot, task, arm, mode),
        "",
        ...armRules,
        "",
        "Return only one compact JSON object with this shape; no Markdown and no step ledger:",
        JSON.stringify(answerShape),
    ].join("\n");
}

export function buildOpenCodeRunArguments({
    model,
    agent,
    title,
    repoRoot,
    serverUrl,
    prompt,
    variant = null,
}) {
    const args = [
        "run",
        "--attach", serverUrl,
        "--format", "json",
        "--model", model,
        "--agent", agent,
        "--title", title,
        "--dir", repoRoot,
        "--auto",
    ];
    if (variant) args.push("--variant", variant);
    return [...args, prompt];
}

function agentConfiguration(arm) {
    const allowedTools = arm === "native" ? NATIVE_TOOLS : SATORI_TOOLS;
    return {
        description: `Read-only ${arm} arm for the Satori agent-discovery evaluation`,
        mode: "primary",
        temperature: 0,
        steps: 12,
        tools: Object.fromEntries([
            ["*", false],
            ...allowedTools.map((tool) => [tool, true]),
        ]),
        permission: Object.fromEntries([
            ["*", "deny"],
            ...allowedTools.map((tool) => [tool, "allow"]),
        ]),
    };
}

export function buildIsolatedOpenCodeConfig(resolvedConfig, model) {
    const satoriMcp = resolvedConfig?.mcp?.satori;
    if (!isRecord(satoriMcp) || satoriMcp.type !== "local"
        || !Array.isArray(satoriMcp.command) || satoriMcp.command.length === 0) {
        throw new Error("The resolved OpenCode config does not contain a local Satori MCP server.");
    }
    const config = {
        model,
        plugin: [pathToFileURL(GUARD_PLUGIN_FILE).href],
        mcp: { satori: satoriMcp },
        agent: {
            "satori-eval-native": agentConfiguration("native"),
            "satori-eval-satori": agentConfiguration("satori"),
        },
    };
    if (isRecord(resolvedConfig.provider)) config.provider = resolvedConfig.provider;
    if (typeof resolvedConfig.small_model === "string") {
        config.small_model = resolvedConfig.small_model;
    }
    return config;
}

function spawnCapture(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const timeout = options.timeoutMs
            ? setTimeout(() => {
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
            }, options.timeoutMs)
            : null;
        timeout?.unref();
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (timeout) clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

async function resolveRepositoryRoot(repoRoot) {
    if (repoRoot) return fs.realpathSync(repoRoot);
    const result = await spawnCapture("git", ["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
    });
    if (result.code !== 0) throw new Error(`Unable to resolve repository root: ${result.stderr}`);
    return fs.realpathSync(result.stdout.trim());
}

async function gitOutput(repoRoot, args) {
    const result = await spawnCapture("git", args, { cwd: repoRoot, timeoutMs: 30_000 });
    if (result.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
}

async function requireCleanWorktree(repoRoot) {
    const status = await gitOutput(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim()) {
        throw new Error(
            "Agent-discovery evaluation requires a clean worktree so both arms use one immutable revision.",
        );
    }
    return true;
}

async function resolveOpenCodeConfig(opencodeCommand, repoRoot) {
    const result = await spawnCapture(opencodeCommand, ["debug", "config"], {
        cwd: repoRoot,
        timeoutMs: 30_000,
    });
    if (result.code !== 0) {
        throw new Error(`opencode debug config failed: ${result.stderr.trim()}`);
    }
    try {
        return JSON.parse(result.stdout);
    } catch (error) {
        throw new Error(`OpenCode returned invalid resolved config JSON: ${error.message}`);
    }
}

async function commandVersion(command) {
    const result = await spawnCapture(command, ["--version"], { timeoutMs: 10_000 });
    if (result.code !== 0) throw new Error(`${command} --version failed: ${result.stderr}`);
    return result.stdout.trim();
}

function isolatedEnvironment({
    config,
    configDir,
    databaseFile,
    repoRoot,
    suiteId,
    toolLedgerFile,
    toolDefinitionsFile,
}) {
    return {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_DB: databaseFile,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_SHARE: "1",
        OPENCODE_ENABLE_QUESTION_TOOL: "false",
        SATORI_AGENT_DISCOVERY_RUN_ID: suiteId,
        SATORI_AGENT_DISCOVERY_REPO_ROOT: repoRoot,
        SATORI_AGENT_DISCOVERY_TOOL_LEDGER: toolLedgerFile,
        SATORI_AGENT_DISCOVERY_TOOL_DEFINITIONS: toolDefinitionsFile,
    };
}

async function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : null;
            server.close((error) => {
                if (error) reject(error);
                else resolve(port);
            });
        });
    });
}

async function waitForServer(url, child, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`OpenCode server exited before becoming ready (code ${child.exitCode}).`);
        }
        try {
            await fetch(url, { signal: AbortSignal.timeout(1_000) });
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`OpenCode server did not become ready within ${timeoutMs}ms.`);
}

async function startOpenCodeServer(command, repoRoot, environment, logFile) {
    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(command, [
        "serve",
        "--hostname", "127.0.0.1",
        "--port", String(port),
        "--log-level", "WARN",
    ], {
        cwd: repoRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
    });
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    await waitForServer(url, child);
    return { child, url, logStream };
}

async function stopOpenCodeServer(server) {
    if (!server) return;
    if (server.child.exitCode === null) server.child.kill("SIGTERM");
    await Promise.race([
        new Promise((resolve) => server.child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
    server.logStream.end();
}

function mcpCommand(resolvedConfig) {
    const satoriMcp = resolvedConfig.mcp.satori;
    return {
        command: satoriMcp.command[0],
        commandArgs: satoriMcp.command.slice(1),
        environment: {
            ...process.env,
            ...(isRecord(satoriMcp.environment) ? satoriMcp.environment : {}),
        },
    };
}

function responseText(result) {
    return Array.isArray(result?.content)
        ? result.content
            .filter((entry) => entry?.type === "text")
            .map((entry) => entry.text)
            .join("")
        : "";
}

async function prepareSatori(resolvedConfig, repoRoot, prepareMode) {
    const command = mcpCommand(resolvedConfig);
    const session = new JsonRpcStdioSession({
        ...command,
        cwd: repoRoot,
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
        env: command.environment,
    });
    try {
        await session.start();
        const initialResult = await session.callTool("manage_index", {
            action: "status",
            path: repoRoot,
            detail: "full",
        });
        const initial = decodeToolResponse(initialResult);
        if (initial?.status !== "ok") {
            throw new Error(
                `Satori is not benchmark-ready (${initial?.status ?? "invalid response"}). `
                + "Build/restart the MCP runtime and explicitly index the pinned revision before rerunning.",
            );
        }
        let sync = null;
        if (prepareMode === "sync") {
            sync = decodeToolResponse(await session.callTool("manage_index", {
                action: "sync",
                path: repoRoot,
            }));
            if (sync?.status !== "ok") {
                throw new Error(`Satori setup sync failed: ${JSON.stringify(sync)}`);
            }
        }
        const finalResult = await session.callTool("manage_index", {
            action: "status",
            path: repoRoot,
            detail: "diagnostics",
        });
        const final = decodeToolResponse(finalResult);
        if (final?.status !== "ok") {
            throw new Error(`Satori status failed after setup: ${JSON.stringify(final)}`);
        }
        return {
            serverInfo: session.serverInfo,
            toolDefinitions: session.tools,
            initial,
            sync,
            final,
            setupResponseBytes: byteLength(
                `${responseText(initialResult)}${responseText(finalResult)}`,
            ),
        };
    } finally {
        await session.close();
    }
}

function byteLength(value) {
    return Buffer.byteLength(value, "utf8");
}

export function recordMcpToolDefinitions(file, runId, tools) {
    for (const tool of tools ?? []) {
        fs.appendFileSync(file, `${JSON.stringify({
            kind: "tool_definition",
            runId,
            tool: `satori_${tool.name}`,
            description: tool.description ?? "",
            parameters: {
                format: "mcp-input-schema",
                value: tool.inputSchema ?? {},
            },
            source: "mcp_tools_list",
        })}\n`, "utf8");
    }
}

function parseJsonLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

async function sessionRows(databaseFile, title) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
        const session = database.prepare(
            "SELECT * FROM session WHERE title = ? ORDER BY time_created DESC LIMIT 1",
        ).get(title);
        if (!session) throw new Error(`OpenCode session '${title}' was not persisted.`);
        const messages = database.prepare(
            "SELECT id, session_id, time_created, time_updated, data "
            + "FROM message WHERE session_id = ? ORDER BY time_created, id",
        ).all(session.id).map((row) => ({ ...row, data: JSON.parse(row.data) }));
        const parts = database.prepare(
            "SELECT id, message_id, session_id, time_created, time_updated, data "
            + "FROM part WHERE session_id = ? ORDER BY time_created, id",
        ).all(session.id).map((row) => ({ ...row, data: JSON.parse(row.data) }));
        return { session, messages, parts };
    } finally {
        database.close();
    }
}

function toolStateOutput(state) {
    if (typeof state?.output === "string") return state.output;
    if (state?.error !== undefined) {
        return typeof state.error === "string" ? state.error : JSON.stringify(state.error);
    }
    return "";
}

function modelTextForMessage(messageId, parts) {
    return parts
        .filter((part) => part.message_id === messageId && part.data.type === "text")
        .map((part) => part.data.text ?? "")
        .join("");
}

function toolMetricFromLedger(ledger, callId, visibleOutput, state) {
    const record = ledger.find(
        (entry) => entry.kind === "tool_end" && entry.callId === callId,
    );
    return {
        rawBytes: Number.isFinite(record?.rawBytes) ? record.rawBytes : null,
        visibleBytes: byteLength(visibleOutput),
        truncated: record?.truncated ?? state?.metadata?.truncated ?? false,
    };
}

function nullableSum(values) {
    const available = values.filter((value) => Number.isFinite(value));
    return available.length === 0
        ? null
        : available.reduce((total, value) => total + value, 0);
}

function containsOwnerTarget(output, expected) {
    return output.includes(expected.ownerFile) && output.includes(expected.ownerSymbol);
}

function isOwnerSource(tool, input, output, expected) {
    const pathValue = input?.filePath ?? input?.path;
    const matchesFile = typeof pathValue === "string" && pathValue.endsWith(expected.ownerFile);
    const isRead = tool === "read" || tool === "satori_read_file";
    return isRead && matchesFile && output.includes(expected.ownerSymbol);
}

function containsRelation(output, input, relation) {
    const inputPath = input?.filePath ?? input?.path ?? input?.file;
    const filePresent = output.includes(relation.file)
        || (typeof inputPath === "string" && inputPath.endsWith(relation.file));
    return filePresent && output.includes(relation.symbol);
}

export function aggregateSessionData({
    persisted,
    expected,
    toolLedger,
    dispatchStartedAtMs,
    responseReceivedAtMs,
}) {
    const assistantMessages = persisted.messages.filter(
        (message) => message.data.role === "assistant",
    );
    const tools = persisted.parts
        .filter((part) => part.data.type === "tool")
        .map((part, index) => {
            const state = part.data.state ?? {};
            const output = toolStateOutput(state);
            const time = state.time ?? {};
            return {
                index: index + 1,
                id: part.id,
                messageId: part.message_id,
                callId: part.data.callID,
                tool: part.data.tool,
                status: state.status ?? null,
                input: state.input ?? null,
                output,
                startedAtMs: time.start ?? part.time_created,
                endedAtMs: time.end ?? part.time_updated,
                ...toolMetricFromLedger(toolLedger, part.data.callID, output, state),
            };
        });
    const lastAssistant = assistantMessages.at(-1) ?? null;
    const finalResponse = lastAssistant
        ? modelTextForMessage(lastAssistant.id, persisted.parts)
        : "";

    const firstTarget = tools.find((tool) => containsOwnerTarget(tool.output, expected));
    const firstOwnerSource = tools.find(
        (tool) => isOwnerSource(tool.tool, tool.input, tool.output, expected),
    );
    const evidenceOrdinals = [firstOwnerSource?.index ?? null];
    for (const relation of expected.requiredRelations ?? []) {
        const evidence = tools.find((tool) => containsRelation(tool.output, tool.input, relation));
        evidenceOrdinals.push(evidence?.index ?? null);
    }
    const completeEvidence = evidenceOrdinals.every(Number.isSafeInteger);
    const modelDurations = assistantMessages.map((message) => {
        const started = message.data.time?.created ?? message.time_created;
        const ended = message.data.time?.completed ?? message.time_updated;
        return Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null;
    });
    const toolDurations = tools.map((tool) => (
        Number.isFinite(tool.startedAtMs) && Number.isFinite(tool.endedAtMs)
            ? tool.endedAtMs - tool.startedAtMs
            : null
    ));
    const inputTokens = assistantMessages.map((message) => message.data.tokens?.input);
    const outputTokens = assistantMessages.map((message) => message.data.tokens?.output);
    const reasoningTokens = assistantMessages.map((message) => message.data.tokens?.reasoning);
    const cachedInputTokens = assistantMessages.map(
        (message) => message.data.tokens?.cache?.read,
    );

    const modelEvents = assistantMessages.map((message) => {
        const startedAtMs = message.data.time?.created ?? message.time_created;
        const endedAtMs = message.data.time?.completed ?? message.time_updated;
        return {
            sortTime: startedAtMs,
            kind: "model",
            startedAt: new Date(startedAtMs).toISOString(),
            durationMs: endedAtMs - startedAtMs,
            operation: "model_response",
            request: {
                messageId: message.id,
                provider: message.data.providerID ?? null,
                model: message.data.modelID ?? null,
                finish: message.data.finish ?? null,
            },
            rawResultBytes: null,
            visibleResultBytes: null,
            truncated: null,
            usage: {
                inputTokens: message.data.tokens?.input ?? null,
                outputTokens: message.data.tokens?.output ?? null,
                reasoningTokens: message.data.tokens?.reasoning ?? null,
                cachedInputTokens: message.data.tokens?.cache?.read ?? null,
            },
            rawUsage: message.data.tokens ?? null,
        };
    });
    const toolEvents = tools.map((tool) => ({
        sortTime: tool.startedAtMs,
        kind: "tool",
        startedAt: new Date(tool.startedAtMs).toISOString(),
        durationMs: tool.endedAtMs - tool.startedAtMs,
        operation: tool.tool,
        request: tool.input,
        rawResultBytes: tool.rawBytes,
        visibleResultBytes: tool.visibleBytes,
        truncated: tool.truncated,
        usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            cachedInputTokens: null,
        },
        rawUsage: null,
    }));
    const events = [...modelEvents, ...toolEvents]
        .sort((left, right) => left.sortTime - right.sortTime)
        .map(({ sortTime: _sortTime, ...event }, index) => ({
            sequence: index + 1,
            ...event,
        }));

    return {
        sessionId: persisted.session.id,
        finalResponse,
        assistantMessages,
        tools,
        events,
        model: {
            provider: lastAssistant?.data.providerID ?? null,
            name: lastAssistant?.data.modelID ?? null,
            version: null,
            temperature: 0,
            reasoningSetting: lastAssistant?.data.variant ?? null,
            contextLimit: null,
        },
        measurements: {
            taskWallTimeMs: responseReceivedAtMs - dispatchStartedAtMs,
            timeToFirstCorrectTargetMs: firstTarget
                ? firstTarget.endedAtMs - dispatchStartedAtMs
                : null,
            timeToFirstOwnerSourceMs: firstOwnerSource
                ? firstOwnerSource.endedAtMs - dispatchStartedAtMs
                : null,
            modelApiLatencyMs: nullableSum(modelDurations),
            toolLatencyMs: nullableSum(toolDurations),
            apiInputTokens: nullableSum(inputTokens),
            apiOutputTokens: nullableSum(outputTokens),
            reasoningTokens: nullableSum(reasoningTokens),
            cachedInputTokens: nullableSum(cachedInputTokens),
            visibleToolResultBytes: tools.reduce(
                (total, tool) => total + tool.visibleBytes,
                0,
            ),
            rawToolResultBytes: tools.every((tool) => Number.isFinite(tool.rawBytes))
                ? tools.reduce((total, tool) => total + tool.rawBytes, 0)
                : null,
            modelTurns: assistantMessages.length,
            toolCalls: tools.length,
            stepsToFirstCorrectTarget: firstTarget?.index ?? null,
            stepsToFirstOwnerSource: firstOwnerSource?.index ?? null,
            stepsToVerifiedAnswer: completeEvidence
                ? Math.max(...evidenceOrdinals)
                : null,
            finalResponseBytes: byteLength(finalResponse),
        },
    };
}

export function extractAgentResult(text) {
    const trimmed = text.trim();
    const withoutFence = trimmed.startsWith("```")
        ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
        : trimmed;
    try {
        return JSON.parse(withoutFence);
    } catch {
        const start = withoutFence.indexOf("{");
        const end = withoutFence.lastIndexOf("}");
        if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1));
        throw new Error("Agent final response did not contain a JSON object.");
    }
}

function deepEqual(left, right) {
    return stableJson(left) === stableJson(right);
}

function validateNativeToolSequence(tools, repoRoot) {
    const failures = [];
    const discoveredFiles = new Set();
    for (const tool of tools) {
        if (!NATIVE_TOOLS.includes(tool.tool)) {
            failures.push(`forbidden_native_tool:${tool.tool}`);
            continue;
        }
        if (tool.tool === "read") {
            const relative = typeof tool.input?.filePath === "string"
                ? path.relative(repoRoot, path.resolve(tool.input.filePath)).replaceAll(path.sep, "/")
                : null;
            if (!Number.isSafeInteger(tool.input?.limit) || tool.input.limit > 200) {
                failures.push("native_read_limit_violation");
            }
            if (relative && !discoveredFiles.has(relative)) {
                failures.push(`native_read_before_discovery:${relative}`);
            }
        } else {
            for (const match of tool.output.matchAll(/packages\/(?:core|mcp)\/src\/[A-Za-z0-9_./-]+\.ts/g)) {
                if (!match[0].endsWith(".test.ts")) discoveredFiles.add(match[0]);
            }
        }
        if (tool.output.includes(".test.ts")) failures.push("native_test_evidence_visible");
    }
    return failures;
}

function validateSatoriToolSequence(tools, repoRoot, task, mode) {
    const failures = [];
    for (const tool of tools) {
        if (!SATORI_TOOLS.includes(tool.tool)) {
            failures.push(`forbidden_satori_tool:${tool.tool}`);
        }
    }
    const expectedFirstInput = {
        path: repoRoot,
        query: task.satoriQuery,
        scope: "runtime",
        resultMode: "grouped",
        groupBy: "symbol",
        rankingMode: "default",
        limit: 5,
    };
    if (tools[0]?.tool !== "satori_search_codebase"
        || !deepEqual(tools[0]?.input, expectedFirstInput)) {
        failures.push("invalid_satori_first_search");
    }
    if (mode === "coverage") {
        const expectedOrder = [
            "satori_search_codebase",
            "satori_read_file",
            "satori_file_outline",
            "satori_call_graph",
        ];
        if (!deepEqual(tools.slice(0, 4).map((tool) => tool.tool), expectedOrder)) {
            failures.push("coverage_tool_order_violation");
        }
    }
    return failures;
}

export function gradeRun({ agentResult, task, arm, mode, repoRoot, tools }) {
    const failures = [];
    if (!isRecord(agentResult)) return { passed: false, failureReasons: ["invalid_result"] };
    if (agentResult.status !== "success") failures.push(`agent_status:${agentResult.status}`);
    const answer = agentResult.answer;
    if (!isRecord(answer)) {
        failures.push("missing_answer");
    } else {
        for (const key of ["ownerFile", "ownerSymbol", "ownerSpan", "taskFacts"]) {
            if (!deepEqual(answer[key], task.expected[key])) failures.push(`incorrect_${key}`);
        }
        for (const relation of task.expected.requiredRelations ?? []) {
            const match = Array.isArray(answer.relatedSymbols)
                && answer.relatedSymbols.some((candidate) => (
                    candidate?.symbol === relation.symbol
                    && candidate?.relation === relation.relation
                    && candidate?.file === relation.file
                ));
            if (!match) failures.push(`missing_relation:${relation.relation}:${relation.symbol}`);
        }
    }
    if (tools.length > 12) failures.push("tool_budget_exceeded");
    const callsPerMessage = new Map();
    for (const tool of tools) {
        callsPerMessage.set(tool.messageId, (callsPerMessage.get(tool.messageId) ?? 0) + 1);
    }
    if ([...callsPerMessage.values()].some((count) => count > 1)) {
        failures.push("multiple_tools_in_one_model_turn");
    }
    if (tools.some((tool) => tool.visibleBytes > 32_768)) {
        failures.push("model_visible_tool_result_exceeded_32768_bytes");
    }
    failures.push(...(arm === "native"
        ? validateNativeToolSequence(tools, repoRoot)
        : validateSatoriToolSequence(tools, repoRoot, task, mode)));
    return { passed: failures.length === 0, failureReasons: [...new Set(failures)] };
}

function definitionProfile(definitionRecords, arm) {
    const allowed = arm === "native" ? NATIVE_TOOLS : SATORI_TOOLS;
    const latest = new Map();
    for (const record of definitionRecords) {
        if (record.kind === "tool_definition" && allowed.includes(record.tool)) {
            latest.set(record.tool, {
                name: record.tool,
                description: record.description,
                parameters: record.parameters,
            });
        }
    }
    const tools = allowed.map((tool) => latest.get(tool)).filter(Boolean);
    const serialized = stableJson(tools);
    return {
        profileId: `opencode-${arm}-restricted-v1`,
        tools,
        definitionsSha256: sha256(serialized),
        definitionsBytes: byteLength(serialized),
        complete: tools.length === allowed.length,
        missingTools: allowed.filter((tool) => !latest.has(tool)),
    };
}

async function waitForPersistedSession(databaseFile, title, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            return await sessionRows(databaseFile, title);
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw lastError ?? new Error(`OpenCode session '${title}' was not persisted.`);
}

function safeFileName(value) {
    return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function runOpenCodeArm({
    options,
    task,
    scheduleEntry,
    pairedRunId,
    suiteId,
    serverUrl,
    environment,
    databaseFile,
    toolLedgerFile,
    toolDefinitionsFile,
    outputDir,
    immutableEnvironment,
    satoriPriorToolCalls,
}) {
    const arm = scheduleEntry.arm;
    const runId = `${suiteId}-${task.id}-r${scheduleEntry.repetition}-${arm}`;
    const title = `satori-agent-discovery:${runId}`;
    const prompt = buildAgentPrompt({
        repoRoot: options.repoRoot,
        task,
        arm,
        mode: options.mode,
    });
    const args = buildOpenCodeRunArguments({
        model: options.model,
        agent: `satori-eval-${arm}`,
        title,
        repoRoot: options.repoRoot,
        serverUrl,
        prompt,
        variant: options.variant,
    });
    const dispatchStartedAtMs = Date.now();
    const processResult = await spawnCapture(options.opencodeCommand, args, {
        cwd: options.repoRoot,
        env: environment,
        timeoutMs: options.timeoutMs,
    });
    const responseReceivedAtMs = Date.now();
    const prefix = `${String(scheduleEntry.repetition).padStart(2, "0")}-${arm}-${safeFileName(task.id)}`;
    fs.writeFileSync(path.join(outputDir, `${prefix}.opencode-events.jsonl`), processResult.stdout);
    fs.writeFileSync(path.join(outputDir, `${prefix}.stderr.log`), processResult.stderr);
    if (processResult.code !== 0) {
        throw new Error(
            `OpenCode ${arm} arm exited with code ${processResult.code}: ${processResult.stderr.trim()}`,
        );
    }

    const persisted = await waitForPersistedSession(databaseFile, title);
    const allToolLedger = parseJsonLines(toolLedgerFile);
    const toolLedger = allToolLedger.filter(
        (record) => record.sessionId === persisted.session.id,
    );
    const aggregated = aggregateSessionData({
        persisted,
        expected: task.expected,
        toolLedger,
        dispatchStartedAtMs,
        responseReceivedAtMs,
    });
    let agentResult;
    let parseFailure = null;
    try {
        agentResult = extractAgentResult(aggregated.finalResponse);
    } catch (error) {
        parseFailure = error.message;
        agentResult = null;
    }
    const grade = gradeRun({
        agentResult,
        task,
        arm,
        mode: options.mode,
        repoRoot: options.repoRoot,
        tools: aggregated.tools,
    });
    if (parseFailure) grade.failureReasons.push(`result_parse_error:${parseFailure}`);
    const toolProfile = definitionProfile(parseJsonLines(toolDefinitionsFile), arm);
    if (!toolProfile.complete) {
        grade.failureReasons.push(`missing_tool_definitions:${toolProfile.missingTools.join(",")}`);
    }
    grade.failureReasons = [...new Set(grade.failureReasons)];
    grade.passed = grade.failureReasons.length === 0;
    const actualModel = `${aggregated.model.provider}/${aggregated.model.name}`;
    if (actualModel !== options.model) {
        grade.failureReasons.push(`model_mismatch:${actualModel}`);
        grade.passed = false;
    }

    const result = {
        protocolVersion: PROTOCOL_VERSION,
        runId,
        pairedRunId,
        repetition: scheduleEntry.repetition,
        taskId: task.id,
        arm,
        mode: options.mode,
        environment: {
            ...immutableEnvironment,
            worktreeCleanAfter: null,
            taskPromptSha256: sha256(task.prompt),
            agentPromptSha256: sha256(prompt),
            agentPromptBytes: byteLength(prompt),
            toolProfile,
            satoriServerPriorToolCalls: arm === "satori" ? satoriPriorToolCalls : null,
        },
        model: aggregated.model,
        agentResult,
        measurements: aggregated.measurements,
        events: aggregated.events,
        grade,
        harness: {
            sessionId: aggregated.sessionId,
            processExitCode: processResult.code,
            processSignal: processResult.signal,
            resultFile: `${prefix}.result.json`,
            toolCalls: aggregated.tools.map((tool) => ({
                operation: tool.tool,
                status: tool.status,
                input: tool.input,
                rawResultBytes: tool.rawBytes,
                visibleResultBytes: tool.visibleBytes,
                truncated: tool.truncated,
            })),
        },
    };
    return result;
}

function finiteValues(runs, field) {
    return runs
        .map((run) => run.measurements?.[field])
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
}

export function observationalStats(runs, field) {
    const values = finiteValues(runs, field);
    if (values.length === 0) return { samples: 0, median: null, min: null, max: null };
    return {
        samples: values.length,
        median: values[Math.floor(values.length / 2)],
        min: values[0],
        max: values.at(-1),
    };
}

const REPORT_METRICS = Object.freeze([
    "taskWallTimeMs",
    "toolLatencyMs",
    "apiInputTokens",
    "apiOutputTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "visibleToolResultBytes",
    "toolCalls",
    "stepsToVerifiedAnswer",
]);

export function summarizeRuns(runs) {
    const taskIds = [...new Set(runs.map((run) => run.taskId))];
    return Object.fromEntries(taskIds.map((taskId) => [
        taskId,
        Object.fromEntries(["native", "satori"].map((arm) => {
            const armRuns = runs.filter((run) => run.taskId === taskId && run.arm === arm);
            const passedRuns = armRuns.filter((run) => run.grade.passed);
            return [arm, {
                passed: passedRuns.length,
                total: armRuns.length,
                metrics: Object.fromEntries(
                    REPORT_METRICS.map((metric) => [metric, observationalStats(passedRuns, metric)]),
                ),
            }];
        })),
    ]));
}

function displayMetric(stats, digits = 0) {
    if (!stats || stats.median === null) return "n/a";
    const render = (value) => Number(value).toFixed(digits);
    return `${render(stats.median)} [${render(stats.min)}-${render(stats.max)}]`;
}

function signedDelta(satori, native) {
    if (satori?.median === null || native?.median === null) return "n/a";
    const delta = satori.median - native.median;
    const percent = native.median === 0 ? null : (delta / native.median) * 100;
    const sign = delta > 0 ? "+" : "";
    return percent === null
        ? `${sign}${delta.toFixed(0)}`
        : `${sign}${delta.toFixed(0)} (${sign}${percent.toFixed(1)}%)`;
}

export function formatMarkdownReport(summary, metadata) {
    const lines = [
        "# OpenCode native vs Satori agent discovery",
        "",
        `- Suite: \`${metadata.suiteId}\``,
        `- Revision: \`${metadata.gitRevision}\``,
        `- OpenCode: \`${metadata.openCodeVersion}\``,
        `- Model: \`${metadata.model}\``,
        `- Mode: \`${metadata.mode}\``,
        `- Repetitions: ${metadata.repetitions} per task and arm`,
        "- Values are median [range]. Timing is milliseconds; bytes are UTF-8 bytes.",
        "",
        "| Task | Arm | Correct | Wall ms | Tool ms | Input tokens | Output tokens | Tool calls | Steps to verified answer | Visible tool bytes |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ];
    for (const [taskId, task] of Object.entries(summary)) {
        for (const arm of ["native", "satori"]) {
            const entry = task[arm];
            lines.push([
                `| ${taskId}`,
                arm,
                `${entry.passed}/${entry.total}`,
                displayMetric(entry.metrics.taskWallTimeMs),
                displayMetric(entry.metrics.toolLatencyMs),
                displayMetric(entry.metrics.apiInputTokens),
                displayMetric(entry.metrics.apiOutputTokens),
                displayMetric(entry.metrics.toolCalls),
                displayMetric(entry.metrics.stepsToVerifiedAnswer),
                `${displayMetric(entry.metrics.visibleToolResultBytes)} |`,
            ].join(" | "));
        }
    }
    lines.push("", "## Satori minus native median", "");
    lines.push("| Task | Wall ms | Input tokens | Tool calls | Visible tool bytes |", "|---|---:|---:|---:|---:|");
    for (const [taskId, task] of Object.entries(summary)) {
        lines.push([
            `| ${taskId}`,
            signedDelta(task.satori.metrics.taskWallTimeMs, task.native.metrics.taskWallTimeMs),
            signedDelta(task.satori.metrics.apiInputTokens, task.native.metrics.apiInputTokens),
            signedDelta(task.satori.metrics.toolCalls, task.native.metrics.toolCalls),
            `${signedDelta(task.satori.metrics.visibleToolResultBytes, task.native.metrics.visibleToolResultBytes)} |`,
        ].join(" | "));
    }
    lines.push(
        "",
        "Only correct runs contribute to latency, token, byte, and step comparisons. Failed runs remain in the raw JSON.",
        "",
    );
    return lines.join("\n");
}

function setupIdentity(setup) {
    const final = setup?.final ?? {};
    const authority = final.authority ?? final.vectorAuthority ?? final.readiness ?? {};
    return {
        satoriOperationId: final.operationId ?? authority.operationId ?? null,
        satoriGeneration: final.generation ?? authority.generation ?? null,
        satoriRuntimeFingerprint: final.runtimeFingerprint
            ?? authority.runtimeFingerprint
            ?? null,
    };
}

function timestampSlug(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, "-");
}

function selectTasks(manifest, taskIds) {
    if (taskIds.length === 0) return manifest.tasks;
    const tasks = taskIds.map((taskId) => {
        const task = manifest.tasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error(`Unknown task ID '${taskId}'.`);
        return task;
    });
    if (new Set(taskIds).size !== taskIds.length) throw new Error("--task values must be unique.");
    return tasks;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return { exitCode: 0 };
    }
    options.repoRoot = await resolveRepositoryRoot(options.repoRoot);
    options.outputDir ??= path.join(
        options.repoRoot,
        ".satori",
        "benchmarks",
        "agent-discovery",
    );
    const manifest = loadTaskManifest(options.tasksFile);
    const tasks = selectTasks(manifest, options.taskIds);
    await requireCleanWorktree(options.repoRoot);
    const taskValidation = tasks.map((task) => validateTaskKey(options.repoRoot, task));
    const schedule = buildRunSchedule(tasks, options.repetitions);
    const gitRevision = (await gitOutput(options.repoRoot, ["rev-parse", "HEAD"])).trim();
    const dryRun = {
        protocolVersion: PROTOCOL_VERSION,
        repoRoot: options.repoRoot,
        gitRevision,
        model: options.model,
        variant: options.variant,
        mode: options.mode,
        prepare: options.prepare,
        outputDir: options.outputDir,
        tasks: taskValidation,
        schedule,
    };
    if (options.dryRun) {
        process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
        return { exitCode: 0, dryRun };
    }

    const openCodeVersion = await commandVersion(options.opencodeCommand);
    const resolvedConfig = await resolveOpenCodeConfig(options.opencodeCommand, options.repoRoot);
    const isolatedConfig = buildIsolatedOpenCodeConfig(resolvedConfig, options.model);
    const suiteId = `opencode-${timestampSlug()}-${crypto.randomBytes(4).toString("hex")}`;
    const outputDir = path.join(options.outputDir, suiteId);
    const configDir = path.join(outputDir, "opencode-config");
    fs.mkdirSync(configDir, { recursive: true });
    const databaseFile = path.join(outputDir, "opencode.db");
    const toolLedgerFile = path.join(outputDir, "tool-ledger.jsonl");
    const toolDefinitionsFile = path.join(outputDir, "tool-definitions.jsonl");
    const environment = isolatedEnvironment({
        config: isolatedConfig,
        configDir,
        databaseFile,
        repoRoot: options.repoRoot,
        suiteId,
        toolLedgerFile,
        toolDefinitionsFile,
    });
    const setup = await prepareSatori(resolvedConfig, options.repoRoot, options.prepare);
    recordMcpToolDefinitions(
        toolDefinitionsFile,
        suiteId,
        setup.toolDefinitions,
    );
    const instructionsText = fs.readFileSync(INSTRUCTIONS_FILE, "utf8");
    const tasksText = fs.readFileSync(options.tasksFile, "utf8");
    const immutableEnvironment = {
        gitRevision,
        worktreeCleanBefore: true,
        instructionsSha256: sha256(instructionsText),
        evaluatorTasksSha256: sha256(tasksText),
        harnessName: "opencode",
        harnessVersion: openCodeVersion,
        platform: os.platform(),
        architecture: os.arch(),
        ...setupIdentity(setup),
    };
    const runManifest = {
        ...dryRun,
        suiteId,
        recordedAt: new Date().toISOString(),
        immutableEnvironment,
        taskManifest: manifest,
        satoriSetup: setup,
    };
    fs.writeFileSync(
        path.join(outputDir, "run-manifest.json"),
        `${JSON.stringify(runManifest, null, 2)}\n`,
    );

    let server = null;
    const runs = [];
    let satoriPriorToolCalls = 0;
    try {
        server = await startOpenCodeServer(
            options.opencodeCommand,
            options.repoRoot,
            environment,
            path.join(outputDir, "opencode-server.log"),
        );
        for (const entry of schedule) {
            const task = tasks.find((candidate) => candidate.id === entry.taskId);
            const pairedRunId = `${suiteId}-${task.id}-r${entry.repetition}`;
            process.stdout.write(
                `Running ${task.id} repetition ${entry.repetition}: ${entry.arm}\n`,
            );
            try {
                const result = await runOpenCodeArm({
                    options,
                    task,
                    scheduleEntry: entry,
                    pairedRunId,
                    suiteId,
                    serverUrl: server.url,
                    environment,
                    databaseFile,
                    toolLedgerFile,
                    toolDefinitionsFile,
                    outputDir,
                    immutableEnvironment,
                    satoriPriorToolCalls,
                });
                runs.push(result);
                if (entry.arm === "satori") {
                    satoriPriorToolCalls += result.measurements.toolCalls ?? 0;
                }
            } catch (error) {
                runs.push({
                    protocolVersion: PROTOCOL_VERSION,
                    runId: `${suiteId}-${task.id}-r${entry.repetition}-${entry.arm}`,
                    pairedRunId,
                    repetition: entry.repetition,
                    taskId: task.id,
                    arm: entry.arm,
                    mode: options.mode,
                    environment: immutableEnvironment,
                    model: null,
                    agentResult: null,
                    measurements: {},
                    events: [],
                    grade: { passed: false, failureReasons: [`harness_error:${error.message}`] },
                });
            }
        }
    } finally {
        await stopOpenCodeServer(server);
    }

    rejectReusedSessions(runs);

    await requireCleanWorktree(options.repoRoot);
    for (const run of runs) {
        run.environment.worktreeCleanAfter = true;
        const resultFile = run.harness?.resultFile
            ?? `${String(run.repetition).padStart(2, "0")}-${run.arm}-${safeFileName(run.taskId)}.result.json`;
        fs.writeFileSync(
            path.join(outputDir, resultFile),
            `${JSON.stringify(run, null, 2)}\n`,
        );
    }
    const summary = summarizeRuns(runs);
    const reportMetadata = {
        suiteId,
        gitRevision,
        openCodeVersion,
        model: options.model,
        mode: options.mode,
        repetitions: options.repetitions,
    };
    const report = formatMarkdownReport(summary, reportMetadata);
    const aggregate = {
        protocolVersion: PROTOCOL_VERSION,
        ...reportMetadata,
        generatedAt: new Date().toISOString(),
        summary,
        runs,
    };
    fs.writeFileSync(
        path.join(outputDir, "summary.json"),
        `${JSON.stringify(aggregate, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(outputDir, "summary.md"), report);
    process.stdout.write(`\n${report}\nArtifacts: ${outputDir}\n`);
    const exitCode = runs.every((run) => run.grade.passed) ? 0 : 1;
    return { exitCode, outputDir, aggregate };
}

const invokedAsScript = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
    main().then(({ exitCode }) => {
        process.exitCode = exitCode;
    }).catch((error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = 1;
    });
}
