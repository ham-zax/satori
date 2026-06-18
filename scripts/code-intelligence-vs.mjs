#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, "evals/code-intelligence-vs/tasks.json");
const DEFAULT_SATORI_COMMAND = ["node", path.join(REPO_ROOT, "packages/mcp/dist/index.js")];
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const MCP_REQUIRE = createRequire(path.join(REPO_ROOT, "packages/mcp/package.json"));

const PROVIDERS = ["satori", "codebase-memory"];

function usage() {
    return `Usage:
  node scripts/code-intelligence-vs.mjs [options]

Options:
  --tasks <file>              Task suite JSON. Default: evals/code-intelligence-vs/tasks.json
  --repo <path>               Repository root for Satori tasks. Default: task suite repo or cwd
  --cmm-project <name>        codebase-memory-mcp project name. Default: task suite cmmProject
  --satori-command <spec>     Satori MCP command as JSON array or shell-like string.
  --cmm-command <spec>        codebase-memory-mcp command as JSON array or shell-like string.
  --provider <name|all>       Run satori, codebase-memory, or all. Default: all
  --out <file>                Write JSON report to this path.
  --dry-run                   Print task/provider plan without running MCP calls.
  --json                      Print full JSON report to stdout.
  --call-timeout-ms <ms>      Per-tool call timeout. Default: 30000
  --startup-timeout-ms <ms>   MCP startup timeout. Default: 15000
  --help                      Show this help.

Environment:
  SATORI_VS_SATORI_CMD        Default --satori-command.
  SATORI_VS_CMM_CMD           Default --cmm-command.

Command specs may be JSON arrays, e.g. '["node","server.js"]'.`;
}

export function parseCommandSpec(spec, fallback = null) {
    if (!spec || !spec.trim()) {
        return fallback;
    }
    const trimmed = spec.trim();
    if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string")) {
            throw new Error(`Invalid command JSON array: ${spec}`);
        }
        return parsed;
    }
    return trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
        if ((part.startsWith("\"") && part.endsWith("\"")) || (part.startsWith("'") && part.endsWith("'"))) {
            return part.slice(1, -1);
        }
        return part;
    }) || fallback;
}

export function parseArgs(argv, env = process.env) {
    const options = {
        tasksFile: DEFAULT_TASKS_FILE,
        repo: null,
        cmmProject: null,
        satoriCommand: parseCommandSpec(env.SATORI_VS_SATORI_CMD || "", DEFAULT_SATORI_COMMAND),
        cmmCommand: parseCommandSpec(env.SATORI_VS_CMM_CMD || "", null),
        provider: "all",
        outFile: null,
        dryRun: false,
        json: false,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            i += 1;
            if (i >= argv.length) {
                throw new Error(`Missing value after ${arg}`);
            }
            return argv[i];
        };

        if (arg === "--") {
            continue;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--tasks") {
            options.tasksFile = path.resolve(next());
        } else if (arg === "--repo") {
            options.repo = path.resolve(next());
        } else if (arg === "--cmm-project") {
            options.cmmProject = next();
        } else if (arg === "--satori-command") {
            options.satoriCommand = parseCommandSpec(next(), null);
        } else if (arg === "--cmm-command") {
            options.cmmCommand = parseCommandSpec(next(), null);
        } else if (arg === "--provider") {
            options.provider = next();
            if (options.provider !== "all" && !PROVIDERS.includes(options.provider)) {
                throw new Error(`Unsupported provider '${options.provider}'.`);
            }
        } else if (arg === "--out") {
            options.outFile = path.resolve(next());
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--call-timeout-ms") {
            options.callTimeoutMs = Number(next());
        } else if (arg === "--startup-timeout-ms") {
            options.startupTimeoutMs = Number(next());
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!Number.isFinite(options.callTimeoutMs) || options.callTimeoutMs <= 0) {
        throw new Error("--call-timeout-ms must be a positive number.");
    }
    if (!Number.isFinite(options.startupTimeoutMs) || options.startupTimeoutMs <= 0) {
        throw new Error("--startup-timeout-ms must be a positive number.");
    }

    return options;
}

async function loadMcpSdk() {
    const clientPath = MCP_REQUIRE.resolve("@modelcontextprotocol/sdk/client/index.js");
    const transportPath = MCP_REQUIRE.resolve("@modelcontextprotocol/sdk/client/stdio.js");
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import(clientPath),
        import(transportPath),
    ]);
    return { Client, StdioClientTransport };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function timeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref();
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

class McpSession {
    constructor(provider, command, options) {
        this.provider = provider;
        this.command = command;
        this.callTimeoutMs = options.callTimeoutMs;
        this.startupTimeoutMs = options.startupTimeoutMs;
        this.transport = null;
        this.client = null;
        this.stderr = "";
    }

    async connect() {
        const { Client, StdioClientTransport } = await loadMcpSdk();
        const [command, ...args] = this.command;
        this.transport = new StdioClientTransport({
            command,
            args,
            env: process.env,
            cwd: REPO_ROOT,
            stderr: "pipe",
        });
        this.transport.stderr?.on("data", (chunk) => {
            this.stderr += String(chunk);
        });
        this.client = new Client({
            name: `satori-vs-${this.provider}`,
            version: "1.0.0",
        });
        await timeout(this.client.connect(this.transport), this.startupTimeoutMs, `${this.provider} startup`);
    }

    async callTool(name, args) {
        const startedAt = process.hrtime.bigint();
        const response = await timeout(
            this.client.callTool({ name, arguments: args }),
            this.callTimeoutMs,
            `${this.provider}.${name}`
        );
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        return { response, latencyMs: Math.round(elapsedMs) };
    }

    async close() {
        try {
            await this.client?.close();
        } catch {
            // Best-effort close.
        }
        try {
            await this.transport?.close();
        } catch {
            // Best-effort close.
        }
    }
}

export function extractMcpPayload(response) {
    if (!response || typeof response !== "object") {
        return { payload: response, text: String(response ?? "") };
    }
    const content = Array.isArray(response.content) ? response.content : [];
    const text = content
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
    if (!text.trim()) {
        return { payload: response, text: JSON.stringify(response) };
    }
    try {
        return { payload: JSON.parse(text), text };
    } catch {
        return { payload: response, text };
    }
}

function normalizeFile(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.replaceAll("\\", "/");
    if (!/[./][A-Za-z0-9_-]+\b/.test(normalized)) {
        return null;
    }
    if (/^(?:http|https):\/\//.test(normalized)) {
        return null;
    }
    return normalized;
}

function pushUnique(list, value) {
    if (value && !list.includes(value)) {
        list.push(value);
    }
}

function walkPayload(value, acc, key = "") {
    if (value === null || value === undefined) {
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            walkPayload(item, acc, key);
        }
        return;
    }
    if (typeof value !== "object") {
        if (typeof value === "string") {
            if (/file|path/i.test(key)) {
                pushUnique(acc.files, normalizeFile(value));
            }
            if (/symbol|name|qualified|label|function/i.test(key)) {
                pushUnique(acc.symbols, value);
            }
            if (/warning/i.test(key)) {
                pushUnique(acc.warnings, value);
            }
        }
        return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
        walkPayload(childValue, acc, childKey);
    }
}

export function normalizeResult(provider, task, calls, error = null) {
    const acc = {
        provider,
        taskId: task.id,
        kind: task.kind,
        status: error ? "error" : "ok",
        latencyMs: calls.reduce((sum, call) => sum + (call.latencyMs || 0), 0),
        files: [],
        symbols: [],
        warnings: [],
        unsupported: false,
        error: error ? String(error.message || error) : undefined,
        calls: calls.map((call) => ({
            tool: call.tool,
            latencyMs: call.latencyMs,
            status: call.status || "ok",
        })),
        text: "",
    };

    const rawText = [];
    for (const call of calls) {
        const { payload, text } = extractMcpPayload(call.response);
        rawText.push(text);
        walkPayload(payload, acc);
        const status = typeof payload?.status === "string" ? payload.status : null;
        if (status && status !== "ok") {
            pushUnique(acc.warnings, `${call.tool}:${status}`);
            if (["unsupported", "unsupported_language", "not_ready", "requires_reindex", "not_found"].includes(status)) {
                acc.unsupported = true;
            }
        }
    }

    acc.text = rawText.join("\n");
    return acc;
}

function renderTemplate(value, context) {
    if (typeof value === "string") {
        return value
            .replaceAll("${repo}", context.repo)
            .replaceAll("${cmmProject}", context.cmmProject || "");
    }
    if (Array.isArray(value)) {
        return value.map((item) => renderTemplate(item, context));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, renderTemplate(child, context)]));
    }
    return value;
}

function chooseSatoriCallGraphArgs(searchPayload) {
    const results = Array.isArray(searchPayload?.results) ? searchPayload.results : [];
    for (const result of results) {
        if (result?.callGraphHint?.supported && result?.nextActions?.callGraph?.args) {
            return result.nextActions.callGraph.args;
        }
    }
    return null;
}

async function runSatoriTask(session, task, context) {
    const calls = [];
    if (task.kind === "search" || task.kind === "architecture") {
        const args = {
            path: context.repo,
            query: task.query,
            limit: task.limit || 10,
            scope: task.scope || (task.kind === "architecture" ? "mixed" : "runtime"),
            resultMode: "grouped",
            groupBy: "symbol",
        };
        const result = await session.callTool("search_codebase", args);
        calls.push({ tool: "search_codebase", ...result });
        return normalizeResult("satori", task, calls);
    }

    if (task.kind === "outline") {
        const args = {
            path: context.repo,
            file: task.file,
            resolveMode: "outline",
            limitSymbols: task.limitSymbols || 80,
        };
        const result = await session.callTool("file_outline", args);
        calls.push({ tool: "file_outline", ...result });
        return normalizeResult("satori", task, calls);
    }

    if (task.kind === "callgraph") {
        const search = await session.callTool("search_codebase", {
            path: context.repo,
            query: task.query,
            limit: task.limit || 10,
            scope: task.scope || "runtime",
            resultMode: "grouped",
            groupBy: "symbol",
        });
        calls.push({ tool: "search_codebase", ...search });
        const { payload } = extractMcpPayload(search.response);
        const callGraphArgs = chooseSatoriCallGraphArgs(payload);
        if (!callGraphArgs) {
            const normalized = normalizeResult("satori", task, calls);
            normalized.status = "unsupported";
            normalized.unsupported = true;
            normalized.warnings.push("call_graph:no_supported_hint");
            return normalized;
        }
        const graph = await session.callTool("call_graph", {
            ...callGraphArgs,
            direction: task.direction || "both",
            depth: task.depth || 2,
            limit: task.graphLimit || 30,
        });
        calls.push({ tool: "call_graph", ...graph });
        return normalizeResult("satori", task, calls);
    }

    throw new Error(`Unsupported Satori task kind '${task.kind}'.`);
}

async function runCodebaseMemoryTask(session, task, context) {
    const project = task.cmmProject || context.cmmProject;
    if (!project) {
        throw new Error("Missing codebase-memory project name. Pass --cmm-project or set cmmProject in the task suite.");
    }
    const calls = [];

    if (task.kind === "search") {
        const result = await session.callTool("search_graph", {
            project,
            query: task.query,
            limit: task.limit || 10,
            include_connected: true,
        });
        calls.push({ tool: "search_graph", ...result });
        return normalizeResult("codebase-memory", task, calls);
    }

    if (task.kind === "outline") {
        const result = await session.callTool("search_graph", {
            project,
            query: task.query || path.basename(task.file || ""),
            file_pattern: task.file ? `.*${task.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : undefined,
            limit: task.limitSymbols || 80,
        });
        calls.push({ tool: "search_graph", ...result });
        return normalizeResult("codebase-memory", task, calls);
    }

    if (task.kind === "callgraph") {
        const functionName = task.functionName || task.query;
        const graph = await session.callTool("trace_path", {
            project,
            function_name: functionName,
            mode: "calls",
            direction: task.direction || "both",
            depth: task.depth || 2,
            include_tests: Boolean(task.includeTests),
            risk_labels: false,
        });
        calls.push({ tool: "trace_path", ...graph });
        return normalizeResult("codebase-memory", task, calls);
    }

    if (task.kind === "architecture") {
        const result = await session.callTool("get_architecture", {
            project,
            aspects: task.aspects || ["packages", "dependencies", "clusters"],
        });
        calls.push({ tool: "get_architecture", ...result });
        return normalizeResult("codebase-memory", task, calls);
    }

    throw new Error(`Unsupported codebase-memory task kind '${task.kind}'.`);
}

function includesAnchor(values, text, anchor) {
    const loweredAnchor = String(anchor).toLowerCase();
    return values.some((value) => String(value).toLowerCase().includes(loweredAnchor))
        || text.toLowerCase().includes(loweredAnchor);
}

export function scoreResult(task, result) {
    const expected = task.expected || {};
    const weights = {
        file: 3,
        symbol: 3,
        text: 1,
        forbidden: 4,
        ...(task.weights || {}),
    };
    const checks = [];
    let score = 0;
    let maxScore = 0;

    for (const file of expected.files || []) {
        maxScore += weights.file;
        const passed = includesAnchor(result.files, result.text, file);
        if (passed) {
            score += weights.file;
        }
        checks.push({ type: "file", anchor: file, passed, weight: weights.file });
    }

    for (const symbol of expected.symbols || []) {
        maxScore += weights.symbol;
        const passed = includesAnchor(result.symbols, result.text, symbol);
        if (passed) {
            score += weights.symbol;
        }
        checks.push({ type: "symbol", anchor: symbol, passed, weight: weights.symbol });
    }

    for (const text of expected.text || []) {
        maxScore += weights.text;
        const passed = result.text.toLowerCase().includes(String(text).toLowerCase());
        if (passed) {
            score += weights.text;
        }
        checks.push({ type: "text", anchor: text, passed, weight: weights.text });
    }

    for (const forbidden of expected.forbiddenText || []) {
        maxScore += weights.forbidden;
        const passed = !result.text.toLowerCase().includes(String(forbidden).toLowerCase());
        if (passed) {
            score += weights.forbidden;
        }
        checks.push({ type: "forbiddenText", anchor: forbidden, passed, weight: weights.forbidden });
    }

    if (maxScore === 0) {
        maxScore = 1;
    }
    const ratio = score / maxScore;
    const passThreshold = task.passThreshold ?? 0.7;
    return {
        score,
        maxScore,
        ratio: Number(ratio.toFixed(4)),
        passed: ratio >= passThreshold && result.status !== "error" && !result.unsupported,
        checks,
    };
}

function buildProviderPlan(options) {
    const providers = options.provider === "all" ? PROVIDERS : [options.provider];
    return providers.map((provider) => ({
        name: provider,
        command: provider === "satori" ? options.satoriCommand : options.cmmCommand,
    }));
}

export function summarize(report) {
    const lines = [];
    lines.push("Code Intelligence VS Report");
    lines.push("==========================");
    lines.push(`Tasks: ${report.tasks.length}`);
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push("");

    for (const provider of report.providers) {
        const resultSet = report.results.filter((result) => result.provider === provider.name);
        if (resultSet.length === 0) {
            lines.push(`${provider.name}: not run (${provider.configured ? "configured" : "missing command"})`);
            continue;
        }
        const totalScore = resultSet.reduce((sum, result) => sum + result.score.score, 0);
        const totalMax = resultSet.reduce((sum, result) => sum + result.score.maxScore, 0);
        const passed = resultSet.filter((result) => result.score.passed).length;
        const unsupported = resultSet.filter((result) => result.unsupported).length;
        const ratio = totalMax === 0 ? 0 : totalScore / totalMax;
        lines.push(`${provider.name}: ${totalScore}/${totalMax} (${(ratio * 100).toFixed(1)}%), pass ${passed}/${resultSet.length}, unsupported ${unsupported}`);
    }

    lines.push("");
    lines.push("Per-task leader:");
    const providerOrder = new Map(report.providers.map((provider, index) => [provider.name, index]));
    for (const task of report.tasks) {
        const results = report.results.filter((result) => result.taskId === task.id);
        const sorted = [...results].sort((a, b) => {
            if (a.score.passed !== b.score.passed) {
                return a.score.passed ? -1 : 1;
            }
            if (a.unsupported !== b.unsupported) {
                return a.unsupported ? 1 : -1;
            }
            return b.score.ratio - a.score.ratio || a.latencyMs - b.latencyMs;
        });
        const leader = sorted[0];
        if (!leader) {
            lines.push(`- ${task.id}: no result`);
            continue;
        }
        const leaders = sorted.filter((result) =>
            result.score.passed === leader.score.passed
            && result.unsupported === leader.unsupported
            && result.score.ratio === leader.score.ratio
        ).sort((a, b) =>
            (providerOrder.get(a.provider) ?? Number.MAX_SAFE_INTEGER)
            - (providerOrder.get(b.provider) ?? Number.MAX_SAFE_INTEGER)
        );
        const outcome = `${(leader.score.ratio * 100).toFixed(1)}%, ${leader.score.passed ? "pass" : "no-pass"}`;
        if (leaders.length > 1) {
            lines.push(`- ${task.id}: tie ${leaders.map((result) => result.provider).join(", ")} (${outcome})`);
        } else {
            lines.push(`- ${task.id}: ${leader.provider} (${outcome})`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export async function runSuite(options) {
    const suite = readJson(options.tasksFile);
    const context = {
        repo: path.resolve(options.repo || suite.repo || process.cwd()),
        cmmProject: options.cmmProject || suite.cmmProject || null,
    };
    const tasks = suite.tasks.map((task) => renderTemplate(task, context));
    const providerPlan = buildProviderPlan(options);
    const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        suite: path.relative(REPO_ROOT, options.tasksFile),
        repo: context.repo,
        cmmProject: context.cmmProject,
        tasks: tasks.map(({ id, kind, query, file }) => ({ id, kind, query, file })),
        providers: providerPlan.map((provider) => ({
            name: provider.name,
            configured: Array.isArray(provider.command) && provider.command.length > 0,
            command: provider.command,
        })),
        results: [],
    };

    if (options.dryRun) {
        return { report, summary: summarize(report) };
    }

    for (const provider of providerPlan) {
        if (!provider.command || provider.command.length === 0) {
            for (const task of tasks) {
                const result = normalizeResult(provider.name, task, [], new Error("provider command is not configured"));
                result.score = scoreResult(task, result);
                report.results.push(result);
            }
            continue;
        }

        const session = new McpSession(provider.name, provider.command, options);
        await session.connect();
        try {
            for (const task of tasks) {
                let result;
                try {
                    result = provider.name === "satori"
                        ? await runSatoriTask(session, task, context)
                        : await runCodebaseMemoryTask(session, task, context);
                } catch (error) {
                    result = normalizeResult(provider.name, task, [], error);
                }
                result.score = scoreResult(task, result);
                report.results.push(result);
            }
        } finally {
            await session.close();
        }
    }

    return { report, summary: summarize(report) };
}

async function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) {
            process.stdout.write(usage());
            return;
        }
        const { report, summary } = await runSuite(options);
        if (options.outFile) {
            fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
            fs.writeFileSync(options.outFile, `${JSON.stringify(report, null, 2)}\n`);
        }
        process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : summary);
    } catch (error) {
        process.stderr.write(`code-intelligence-vs failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
