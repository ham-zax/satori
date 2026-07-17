#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { canonicalJson, validateObservationSet, validateTaskSuite } from "./satori-useful-context.mjs";
import { getSatoriRuntimeIdentity } from "./satori-runtime-identity.mjs";

const EXPECTED_TOOLS = [
    "manage_index",
    "search_codebase",
    "call_graph",
    "file_outline",
    "read_file",
    "list_codebases",
];
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resultIdentityKey(file, symbol) {
    if (typeof file !== "string" || typeof symbol !== "string") {
        throw new Error("Result identity requires string file and symbol values.");
    }
    return JSON.stringify([file, symbol]);
}

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

export function replaceRepoRoot(value, repoRoot) {
    if (typeof value === "string") {
        return value.replaceAll("$REPO_ROOT", repoRoot);
    }
    if (Array.isArray(value)) {
        return value.map((item) => replaceRepoRoot(item, repoRoot));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value)
            .map(([key, item]) => [key, replaceRepoRoot(item, repoRoot)]));
    }
    return value;
}

function usage() {
    return [
        "Usage: node scripts/satori-useful-context-record.mjs --tasks <tasks.json> --repo <root> [options]",
        "Options:",
        "  --out <observations.json>",
        "  --command <executable>          MCP command (default: managed launcher)",
        "  --command-arg <arg>             Repeat for each MCP command argument",
        "  --startup-timeout-ms <ms>",
        "  --call-timeout-ms <ms>",
        "  --close-timeout-ms <ms>",
        "  --warm-samples <count>         Repeated warm samples in one MCP process (v2 output)",
        "  --dry-run                       Validate and print the expanded task plan",
    ].join("\n");
}

export function parseArgs(argv) {
    const options = {
        tasksFile: null,
        repoRoot: null,
        outFile: null,
        command: process.env.SATORI_MCP_COMMAND || path.join(os.homedir(), ".satori", "bin", "satori-mcp.js"),
        commandArgs: [],
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
        warmSampleCount: 1,
        dryRun: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) {
                throw new Error(`Missing value after ${arg}.`);
            }
            return argv[index];
        };
        if (arg === "--") {
            continue;
        } else if (arg === "--tasks") {
            options.tasksFile = path.resolve(next());
        } else if (arg === "--repo") {
            options.repoRoot = path.resolve(next());
        } else if (arg === "--out") {
            options.outFile = path.resolve(next());
        } else if (arg === "--command") {
            options.command = next();
        } else if (arg === "--command-arg") {
            options.commandArgs.push(next());
        } else if (arg === "--startup-timeout-ms") {
            options.startupTimeoutMs = positiveInteger(next(), arg);
        } else if (arg === "--call-timeout-ms") {
            options.callTimeoutMs = positiveInteger(next(), arg);
        } else if (arg === "--close-timeout-ms") {
            options.closeTimeoutMs = positiveInteger(next(), arg);
        } else if (arg === "--warm-samples") {
            options.warmSampleCount = positiveInteger(next(), arg);
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (!options.help && (!options.tasksFile || !options.repoRoot)) {
        throw new Error("Both --tasks and --repo are required.");
    }
    return options;
}

function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
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

export class JsonRpcStdioSession {
    constructor(options) {
        this.options = options;
        this.nextId = 1;
        this.pending = new Map();
        this.stdoutBuffer = "";
        this.stderr = "";
        this.closed = false;
    }

    async start() {
        const child = spawn(this.options.command, this.options.commandArgs, {
            cwd: this.options.cwd,
            env: this.options.env ?? process.env,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
        });
        this.child = child;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.onStdout(chunk));
        child.on("close", (code, signal) => {
            this.closed = true;
            const detail = this.stderr.trim() ? ` stderr: ${this.stderr.trim()}` : "";
            const error = new Error(`MCP command exited (code=${code}, signal=${signal}).${detail}`);
            for (const pending of this.pending.values()) {
                pending.reject(error);
            }
            this.pending.clear();
        });

        await withTimeout(new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        }), this.options.startupTimeoutMs, "MCP startup");

        const initialized = await this.request("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "satori-useful-context-recorder", version: "1" },
        }, this.options.startupTimeoutMs);
        if (!isRecord(initialized) || !isRecord(initialized.serverInfo)) {
            throw new Error("MCP initialize returned an invalid server response.");
        }
        const serverName = initialized.serverInfo.name;
        const serverVersion = initialized.serverInfo.version;
        if (typeof serverName !== "string" || serverName.length === 0
            || typeof serverVersion !== "string" || serverVersion.length === 0) {
            throw new Error("MCP initialize returned incomplete serverInfo provenance.");
        }
        this.serverInfo = { name: serverName, version: serverVersion };
        this.notify("notifications/initialized", {});
        const list = await this.request("tools/list", {}, this.options.callTimeoutMs);
        const names = Array.isArray(list?.tools) ? list.tools.map((tool) => tool?.name) : [];
        if (names.length !== EXPECTED_TOOLS.length || EXPECTED_TOOLS.some((name, index) => names[index] !== name)) {
            throw new Error(`MCP tool contract mismatch; expected this exact order: ${EXPECTED_TOOLS.join(", ")}.`);
        }
        this.tools = structuredClone(list.tools);
    }

    onStdout(chunk) {
        this.stdoutBuffer += chunk;
        while (true) {
            const newline = this.stdoutBuffer.indexOf("\n");
            if (newline < 0) return;
            const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (!line.trim()) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch (error) {
                this.failAll(new Error(`MCP stdout contained invalid JSON: ${error.message}`));
                continue;
            }
            if (message.id === undefined) continue;
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(`MCP ${pending.method} failed: ${JSON.stringify(message.error)}`));
            } else {
                pending.resolve(message.result);
            }
        }
    }

    failAll(error) {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    send(message) {
        if (!this.child?.stdin || this.closed) {
            throw new Error("MCP session is not connected.");
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    notify(method, params) {
        this.send({ jsonrpc: "2.0", method, params });
    }

    request(method, params, timeoutMs) {
        const id = this.nextId++;
        const request = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            try {
                this.send({ jsonrpc: "2.0", id, method, params });
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
        return withTimeout(request, timeoutMs, method).finally(() => this.pending.delete(id));
    }

    callTool(tool, args) {
        return this.request("tools/call", { name: tool, arguments: args }, this.options.callTimeoutMs);
    }

    async close() {
        const child = this.child;
        if (!child || this.closed) return;
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.stdin.end();
        try {
            await withTimeout(closed, this.options.closeTimeoutMs, "MCP close");
            return;
        } catch {
            child.kill("SIGTERM");
        }
        try {
            await withTimeout(closed, this.options.closeTimeoutMs, "MCP terminate");
        } catch {
            child.kill("SIGKILL");
            await withTimeout(closed, this.options.closeTimeoutMs, "MCP kill");
        }
    }
}

export function decodeToolResponse(result) {
    if (!isRecord(result)) {
        throw new Error("MCP tools/call returned a non-object result.");
    }
    if (isRecord(result.structuredContent)) {
        return structuredClone(result.structuredContent);
    }
    const text = Array.isArray(result.content)
        ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text
        : undefined;
    if (text === undefined) {
        throw new Error("MCP tools/call returned no JSON text content.");
    }
    try {
        return JSON.parse(text);
    } catch {
        return { text };
    }
}

export function hashTaskSuite(taskSuite) {
    const canonicalize = (value) => {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (isRecord(value)) {
            return Object.fromEntries(Object.keys(value).sort()
                .map((key) => [key, canonicalize(value[key])]));
        }
        return value;
    };
    return crypto.createHash("sha256").update(JSON.stringify(canonicalize(taskSuite)), "utf8").digest("hex");
}

export function recorderNodeMetadata() {
    return { version: process.version, platform: process.platform, arch: process.arch };
}

function sha256File(file) {
    const bytes = fs.readFileSync(file);
    return { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function existingCommandFiles(options) {
    return [options.command, ...(options.commandArgs || [])].flatMap((candidate, index) => {
        if (typeof candidate !== "string") return [];
        const resolved = path.resolve(candidate);
        const stat = fs.statSync(resolved, { throwIfNoEntry: false });
        if (!stat?.isFile()) return [];
        const realPath = fs.realpathSync(resolved);
        return [{ index, basename: path.basename(realPath), realPath, ...sha256File(realPath) }];
    });
}

function inferSatoriRuntimeRoot(commandFiles) {
    for (const file of commandFiles) {
        const normalized = file.realPath.replaceAll("\\", "/");
        if (normalized.endsWith("/packages/mcp/dist/index.js")) {
            return path.resolve(path.dirname(file.realPath), "../../..");
        }
    }
    return null;
}

function cleanRuntimeSourceIdentity(repoRoot) {
    const git = (...args) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
    const revision = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    const status = git("status", "--porcelain=v1", "--untracked-files=all");
    if (revision.status !== 0 || tree.status !== 0 || status.status !== 0) {
        throw new Error(`Cannot bind Satori runtime source identity for '${repoRoot}'.`);
    }
    if (status.stdout.length > 0) {
        throw new Error("Release qualification requires a clean Satori runtime worktree.");
    }
    return {
        gitRevision: revision.stdout.trim().toLowerCase(),
        gitTree: tree.stdout.trim().toLowerCase(),
    };
}

export function qualificationRuntimeIdentity(options) {
    const commandFiles = existingCommandFiles(options);
    const runtimeRoot = inferSatoriRuntimeRoot(commandFiles);
    const recorder = sha256File(fileURLToPath(import.meta.url));
    const commandArtifacts = commandFiles.map(({ realPath: _realPath, ...identity }) => identity);
    if (!runtimeRoot) {
        const identity = {
            schemaVersion: 1,
            status: "unbound_runtime",
            recorder,
            commandArtifacts,
        };
        return { ...identity, sha256: hashTaskSuite(identity) };
    }
    const manifestFiles = [
        "package.json",
        "pnpm-lock.yaml",
        "packages/core/package.json",
        "packages/mcp/package.json",
    ].map((relativePath) => ({ relativePath, ...sha256File(path.join(runtimeRoot, relativePath)) }));
    const identity = {
        schemaVersion: 1,
        status: "bound",
        source: cleanRuntimeSourceIdentity(runtimeRoot),
        recorder,
        commandArtifacts,
        manifests: manifestFiles,
        runtime: getSatoriRuntimeIdentity(runtimeRoot),
    };
    return { ...identity, sha256: hashTaskSuite(identity) };
}

function pathIsInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function requireOutputOutsideRoot(outFile, root, label) {
    if (!outFile) return;
    let outputStat;
    try {
        outputStat = fs.lstatSync(outFile);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    if (outputStat?.isSymbolicLink()) {
        throw new Error(`${label} output must not be a symlink.`);
    }
    const canonicalRoot = fs.realpathSync(root);
    const canonicalParent = fs.realpathSync(path.dirname(outFile));
    const canonicalOutput = path.join(canonicalParent, path.basename(outFile));
    if (pathIsInside(canonicalRoot, canonicalOutput)) {
        throw new Error(`${label} output must be outside '${canonicalRoot}'.`);
    }
}

export function extractCompletedOperationProof(payload, expectedRoot, expectedAction) {
    const operation = payload?.operation;
    if (!isRecord(operation)
        || operation.action !== expectedAction
        || operation.phase !== "completed"
        || operation.canonicalRoot !== expectedRoot
        || typeof operation.id !== "string"
        || !Number.isSafeInteger(operation.generation)
        || typeof operation.lastDurableTransitionAt !== "string"
        || !isRecord(operation.runtimeFingerprint)) {
        throw new Error(`Missing completed ${expectedAction} operation proof for '${expectedRoot}'.`);
    }
    return {
        id: operation.id,
        action: operation.action,
        canonicalRoot: operation.canonicalRoot,
        generation: operation.generation,
        phase: operation.phase,
        lastDurableTransitionAt: operation.lastDurableTransitionAt,
        runtimeFingerprint: structuredClone(operation.runtimeFingerprint),
    };
}

function extractPublicationProof(payload, expectedRoot) {
    const publication = payload?.publication;
    if (!isRecord(publication)
        || typeof publication.collectionName !== "string"
        || publication.collectionName.trim().length === 0
        || typeof publication.markerRunId !== "string"
        || publication.markerRunId.trim().length === 0
        || typeof publication.indexPolicyHash !== "string"
        || !/^[a-f0-9]{64}$/.test(publication.indexPolicyHash)
        || typeof publication.policyDocumentDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(publication.policyDocumentDigest)) {
        throw new Error(`Missing stable publication proof for '${expectedRoot}'.`);
    }
    return {
        collectionName: publication.collectionName,
        markerRunId: publication.markerRunId,
        indexPolicyHash: publication.indexPolicyHash,
        policyDocumentDigest: publication.policyDocumentDigest,
    };
}

function assertSameIndexProof(expected, actual, taskId) {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`Task '${taskId}' index generation or operation proof drifted during measured calls.`);
    }
}

/**
 * Published search identity for an arm. Mutation-lease generation advances on
 * every lease acquire, including zero-change syncs, so it is not part of the
 * frozen publication identity. Operation ids/timestamps may also differ.
 * Collection + completion marker + policy digests + runtime fingerprint bind
 * the searchable generation.
 */
function publicationIdentity(proof) {
    return {
        canonicalRoot: proof.canonicalRoot,
        runtimeFingerprint: structuredClone(proof.runtimeFingerprint),
        publication: structuredClone(proof.publication),
    };
}

function assertSamePublishedGeneration(expected, actual, taskId) {
    if (canonicalJson(publicationIdentity(actual)) !== canonicalJson(publicationIdentity(expected))) {
        throw new Error(`Task '${taskId}' index publication changed between task runs.`);
    }
}

function normalizeRelativeFile(value, repoRoot) {
    if (typeof value !== "string" || value.length === 0) return null;
    const relative = path.isAbsolute(value) ? path.relative(repoRoot, value) : value;
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSymbol(value, expectedSymbol) {
    if (!isRecord(value)) return null;
    for (const key of ["symbol", "symbolName", "name"]) {
        if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
    const label = typeof value.symbolLabel === "string" ? value.symbolLabel.trim() : "";
    if (!label) return null;
    if (expectedSymbol && new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(expectedSymbol)}([^A-Za-z0-9_$]|$)`).test(label)) {
        return expectedSymbol;
    }
    const beforeParen = label.slice(0, label.indexOf("(") >= 0 ? label.indexOf("(") : label.length);
    const identifiers = beforeParen.match(/[A-Za-z_$][\w$]*/g) || [];
    return identifiers.at(-1) || null;
}

function normalizeResultIdentities(payload, task, repoRoot) {
    const candidates = [];
    if (Array.isArray(payload?.results)) candidates.push(...payload.results);
    if (Array.isArray(payload?.nodes)) candidates.push(...payload.nodes);
    if (Array.isArray(payload?.outline?.symbols)) candidates.push(...payload.outline.symbols);
    const results = [];
    const seen = new Set();
    for (const candidate of candidates) {
        // formatVersion 2 grouped search nests path/span under target and uses
        // displayLabel / navigation.callerSearchTerm instead of flat file+symbol.
        const target = isRecord(candidate?.target) ? candidate.target : null;
        const file = normalizeRelativeFile(
            candidate?.file
            || candidate?.relativePath
            || target?.file,
            repoRoot,
        );
        const symbol = normalizeSymbol({
            ...candidate,
            symbol: candidate?.symbol
                || target?.symbol
                || candidate?.navigation?.callerSearchTerm,
            symbolName: candidate?.symbolName,
            name: candidate?.name || candidate?.navigation?.callerSearchTerm,
            symbolLabel: candidate?.symbolLabel || candidate?.displayLabel,
        }, task.expected.ownerSymbol);
        if (!file || !symbol) continue;
        const key = resultIdentityKey(file, symbol);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ file, symbol });
    }
    return results;
}

function contextBytes(payload) {
    let total = 0;
    const visit = (value, key) => {
        if (typeof value === "string") {
            if (key === "content" || key === "preview") total += Buffer.byteLength(value, "utf8");
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item) => visit(item, key));
        } else if (isRecord(value)) {
            for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
        }
    };
    visit(payload, "");
    return total;
}

function isExpectedOwner(candidate, task, repoRoot) {
    const [identity] = normalizeResultIdentities({ results: [candidate] }, task, repoRoot);
    return identity?.file === task.expected.ownerFile && identity.symbol === task.expected.ownerSymbol;
}

function contextBytesThroughOwner(payload, task, repoRoot) {
    if (task.queryClass === "exact_open") {
        const opened = extractOpenedSymbol(payload, task, repoRoot);
        return {
            bytes: contextBytes(payload),
            ownerReached: opened?.file === task.expected.ownerFile && opened.symbol === task.expected.ownerSymbol,
        };
    }

    const candidates = Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.nodes)
            ? payload.nodes
            : null;
    if (!candidates) {
        return { bytes: contextBytes(payload), ownerReached: false };
    }

    let bytes = 0;
    for (const candidate of candidates) {
        bytes += contextBytes(candidate);
        if (isExpectedOwner(candidate, task, repoRoot)) {
            return { bytes, ownerReached: true };
        }
    }
    return { bytes, ownerReached: false };
}

function observationStatus(payload, result, results, task) {
    if (result.isError === true || payload?.status === "error") return "error";
    if (payload?.fallbackUsed === true || payload?.fallback === true) return "fallback";
    if (task.queryClass !== "exact_open" && Array.isArray(payload?.results) && results.length === 0) {
        return "zero_result";
    }
    if (task.queryClass === "exact_open") {
        return payload?.formatVersion === 2
            && payload?.kind === "symbol_context"
            && payload?.status === "ok"
            ? "ok"
            : "error";
    }
    return payload?.status === "zero_result" ? "zero_result" : "ok";
}

function extractOpenedSymbol(payload, task, repoRoot) {
    const symbol = payload?.symbol;
    if (!isRecord(symbol) || !isRecord(symbol.span)) return undefined;
    const file = normalizeRelativeFile(symbol.file, repoRoot);
    const name = normalizeSymbol(symbol, task.expected.ownerSymbol);
    if (!file || !name || !Number.isInteger(symbol.span.startLine) || !Number.isInteger(symbol.span.endLine)) {
        return undefined;
    }
    return { file, symbol: name, startLine: symbol.span.startLine, endLine: symbol.span.endLine };
}

function assertExactOpen(task, observation) {
    if (task.queryClass !== "exact_open") return;
    const opened = observation.openedSymbol;
    if (!opened) throw new Error(`Task '${task.id}' did not return an exact opened symbol.`);
    const expected = task.expected;
    if (opened.file !== expected.ownerFile || opened.symbol !== expected.ownerSymbol) {
        throw new Error(`Task '${task.id}' opened '${opened.file}#${opened.symbol}', expected '${expected.ownerFile}#${expected.ownerSymbol}'.`);
    }
    if (opened.startLine !== expected.span.startLine || opened.endLine !== expected.span.endLine) {
        throw new Error(
            `Task '${task.id}' exact-open span drift: expected ${expected.span.startLine}-${expected.span.endLine}, recorded ${opened.startLine}-${opened.endLine}.`
        );
    }
}

export async function callAndDecode(session, invocation) {
    const result = await session.callTool(invocation.tool, invocation.args);
    return { result, payload: decodeToolResponse(result) };
}

function responseUtf8Bytes(result) {
    if (!Array.isArray(result?.content)) return 0;
    return result.content.reduce((total, item) => total + (
        typeof item?.text === "string" ? Buffer.byteLength(item.text, "utf8") : 0
    ), 0);
}

export function extractReadinessDiagnostics(payload) {
    const readiness = payload?.hints?.debugSearch?.readiness;
    const operations = readiness?.operations;
    if (!isRecord(readiness)
        || !["cold", "warm"].includes(readiness.proofMode)
        || typeof readiness.invalidationReason !== "string"
        || !isRecord(operations)
        || ![
            operations.preparedCacheLookups,
            operations.preparedCacheHits,
            operations.coldReadinessChecks,
            operations.warmReceiptRevalidations,
            operations.exactPayloadRecounts,
        ].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        return null;
    }
    return structuredClone(readiness);
}

/**
 * Fail readiness proofs with every failed predicate and the full readiness blob.
 * Do not weaken cold/warm acceptance rules: the product path must prove them.
 */
export function assertMeasuredReadiness(task, phase, invocation, readiness, context = {}) {
    if (invocation.tool !== "search_codebase"
        || !["freshness", "full"].includes(invocation.args.debugMode)) {
        return;
    }
    const invocations = Array.isArray(task?.workload?.invocations) ? task.workload.invocations : [];
    const invocationIndex = Number.isSafeInteger(context.invocationIndex)
        ? context.invocationIndex
        : Math.max(0, invocations.indexOf(invocation));
    const previousTool = invocationIndex > 0 ? invocations[invocationIndex - 1]?.tool : null;
    const nextTool = invocationIndex + 1 < invocations.length
        ? invocations[invocationIndex + 1]?.tool
        : null;
    const envelope = {
        taskId: task.id,
        phase,
        sample: context.sample ?? null,
        invocationIndex,
        invocationCount: invocations.length,
        tool: invocation.tool,
        debugMode: invocation.args?.debugMode ?? null,
        previousTool,
        nextTool,
        readiness: readiness ?? null,
    };

    if (!readiness) {
        const message = `Task '${task.id}' ${phase} search returned no structured readiness diagnostics.`;
        console.error(JSON.stringify({
            event: "readiness_proof_failed",
            message,
            failedPredicates: ["readiness_present"],
            ...envelope,
        }));
        throw new Error(`${message} diagnostics=${JSON.stringify(envelope)}`);
    }

    const failedPredicates = [];
    if (phase === "cold") {
        if (readiness.proofMode !== "cold") {
            failedPredicates.push(`proofMode===cold (actual=${readiness.proofMode})`);
        }
        if (readiness.operations.coldReadinessChecks < 1) {
            failedPredicates.push(
                `coldReadinessChecks>=1 (actual=${readiness.operations.coldReadinessChecks})`,
            );
        }
        if (readiness.operations.exactPayloadRecounts < 1) {
            failedPredicates.push(
                `exactPayloadRecounts>=1 (actual=${readiness.operations.exactPayloadRecounts})`,
            );
        }
        if (failedPredicates.length > 0) {
            const message = `Task '${task.id}' cold search did not prove a cold authority check with an exact payload recount.`;
            console.error(JSON.stringify({
                event: "readiness_proof_failed",
                message,
                failedPredicates,
                ...envelope,
            }));
            throw new Error(`${message} failedPredicates=${JSON.stringify(failedPredicates)} diagnostics=${JSON.stringify(envelope)}`);
        }
        return;
    }

    if (phase === "warm") {
        if (readiness.proofMode !== "warm") {
            failedPredicates.push(`proofMode===warm (actual=${readiness.proofMode})`);
        }
        if (readiness.operations.preparedCacheHits < 1) {
            failedPredicates.push(
                `preparedCacheHits>=1 (actual=${readiness.operations.preparedCacheHits})`,
            );
        }
        if (readiness.operations.warmReceiptRevalidations < 1) {
            failedPredicates.push(
                `warmReceiptRevalidations>=1 (actual=${readiness.operations.warmReceiptRevalidations})`,
            );
        }
        if (readiness.operations.exactPayloadRecounts !== 0) {
            failedPredicates.push(
                `exactPayloadRecounts===0 (actual=${readiness.operations.exactPayloadRecounts})`,
            );
        }
        if (failedPredicates.length > 0) {
            const message = `Task '${task.id}' warm search did not prove receipt revalidation without a payload recount.`;
            console.error(JSON.stringify({
                event: "readiness_proof_failed",
                message,
                failedPredicates,
                ...envelope,
            }));
            throw new Error(`${message} failedPredicates=${JSON.stringify(failedPredicates)} diagnostics=${JSON.stringify(envelope)}`);
        }
    }
}

function validateSetupProtocol(task) {
    for (const invocation of task.workload.setup) {
        if (invocation.tool !== "manage_index" || invocation.args.action !== "status") {
            throw new Error(`Task '${task.id}' setup may only use manage_index status.`);
        }
    }
}

async function proveReady(session, task) {
    let readinessPayload;
    for (const invocation of task.workload.setup) {
        const called = await callAndDecode(session, invocation);
        readinessPayload = called.payload;
    }
    if (!readinessPayload || readinessPayload.status !== "ok") {
        throw new Error(`Task '${task.id}' readiness status is not searchable/indexed (status: ${readinessPayload?.status || "missing"}).`);
    }
    return readinessPayload;
}

async function prepareMeasurementState(session, task, repoRoot) {
    const prepared = (await callAndDecode(session, {
        tool: "manage_index",
        args: { action: "sync", path: repoRoot },
    })).payload;
    if (prepared.status !== "ok") {
        throw new Error(`Task '${task.id}' freshness preparation failed (status: ${prepared.status || "missing"}).`);
    }
    const syncStats = prepared.syncStats;
    if (!isRecord(syncStats) || ![syncStats.added, syncStats.removed, syncStats.modified]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error(`Task '${task.id}' freshness preparation returned no structured syncStats proof.`);
    }
    if ([syncStats.added, syncStats.removed, syncStats.modified].some((value) => value !== 0)) {
        throw new Error(
            `Task '${task.id}' freshness preparation changed the index; publish a stable no-change generation before recording.`,
        );
    }
    const preparedProof = extractCompletedOperationProof(prepared, repoRoot, "sync");
    const readiness = await proveReady(session, task);
    const readinessProof = extractCompletedOperationProof(readiness, repoRoot, "sync");
    assertSameIndexProof(preparedProof, readinessProof, task.id);
    return {
        syncStats: structuredClone(syncStats),
        indexProof: {
            ...preparedProof,
            publication: extractPublicationProof(readiness, repoRoot),
        },
    };
}

export async function recordPhase(session, task, phase, repoRoot, sample) {
    const startedAt = performance.now();
    let finalResult;
    let finalPayload;
    let bytes = 0;
    let responseBytes = 0;
    const readiness = [];
    const identities = [];
    const seen = new Set();
    let ownerReached = false;
    let toolCalls = 0;
    let callsToSource = null;
    let sourceMode = null;
    for (const invocation of task.workload.invocations) {
        toolCalls += 1;
        if (invocation.tool === "manage_index") {
            throw new Error(`Task '${task.id}' measurement invocations may not mutate lifecycle state.`);
        }
        if (task.queryClass === "exact_open"
            && invocation.tool === "read_file"
            && invocation.args.open_symbol
            && invocation.args.mode !== "plain"
            && invocation.args.mode !== "annotated") {
            throw new Error(`Task '${task.id}' exact read_file invocation requires mode='plain' or mode='annotated'.`);
        }
        const called = await callAndDecode(session, invocation);
        responseBytes += responseUtf8Bytes(called.result);
        const readinessDiagnostics = extractReadinessDiagnostics(called.payload);
        assertMeasuredReadiness(task, phase, invocation, readinessDiagnostics, {
            sample,
            invocationIndex: toolCalls - 1,
        });
        if (readinessDiagnostics) readiness.push(readinessDiagnostics);
        const freshnessMode = called.payload?.freshnessDecision?.mode;
        if (["synced", "reconciled_ignore_change", "coalesced"].includes(freshnessMode)) {
            throw new Error(`Task '${task.id}' measured call caused or joined sync freshness mode '${freshnessMode}'.`);
        }
        finalResult = called.result;
        finalPayload = called.payload;
        if (callsToSource === null && invocation.tool === "read_file") {
            callsToSource = toolCalls;
            sourceMode = "read_file";
        }
        if (!ownerReached) {
            const measured = contextBytesThroughOwner(called.payload, task, repoRoot);
            bytes += measured.bytes;
            ownerReached = measured.ownerReached;
            if (
                callsToSource === null
                && invocation.tool === "search_codebase"
                && measured.ownerReached
                && measured.bytes > 0
            ) {
                callsToSource = toolCalls;
                sourceMode = "search_preview";
            }
        }
        for (const identity of normalizeResultIdentities(called.payload, task, repoRoot)) {
            const key = resultIdentityKey(identity.file, identity.symbol);
            if (!seen.has(key)) {
                seen.add(key);
                identities.push(identity);
            }
        }
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const observation = {
        taskId: task.id,
        phase,
        status: observationStatus(finalPayload, finalResult, identities, task),
        latencyMs,
        contextBytes: bytes,
        responseBytes,
        response: finalPayload,
        results: identities,
        toolCalls,
        sourceReached: callsToSource !== null,
        callsToSource,
        sourceMode,
        ...(readiness.length > 0 ? { readiness } : {}),
        ...(sample !== undefined ? { sample } : {}),
    };
    const openedSymbol = extractOpenedSymbol(finalPayload, task, repoRoot);
    if (openedSymbol) observation.openedSymbol = openedSymbol;
    assertExactOpen(task, observation);
    return observation;
}

function cleanGitRevision(repoRoot) {
    const revision = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (revision.status !== 0 || !/^[0-9a-f]{40}$/i.test(revision.stdout.trim())) {
        throw new Error(`Cannot bind observations to a git revision for '${repoRoot}'.`);
    }
    const status = spawnSync(
        "git",
        ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" },
    );
    if (status.status !== 0) {
        throw new Error(`Cannot verify clean worktree state for '${repoRoot}'.`);
    }
    if (status.stdout.length > 0) {
        throw new Error("Useful-context baselines require a clean worktree; commit or stash uncommitted changes before recording.");
    }
    return revision.stdout.trim().toLowerCase();
}

export async function recordSuite(taskSuite, options) {
    const validated = validateTaskSuite(taskSuite);
    const repoRoot = fs.realpathSync(options.repoRoot);
    const expanded = replaceRepoRoot(validated, repoRoot);
    for (const task of expanded.tasks) validateSetupProtocol(task);
    const warmSampleCount = options.warmSampleCount ?? 1;
    const outputVersion = warmSampleCount > 1 ? 2 : 1;
    if (options.dryRun) {
        return { version: outputVersion, dryRun: true, repoRoot, warmSampleCount, tasks: expanded.tasks };
    }
    const revision = cleanGitRevision(repoRoot);
    const runtimeIdentity = qualificationRuntimeIdentity(options);
    const observations = [];
    const taskRuns = [];
    let armIndexProof;
    let serverInfo;
    for (const task of expanded.tasks) {
        const session = new JsonRpcStdioSession({ ...options, cwd: repoRoot });
        try {
            await session.start();
            if (serverInfo && JSON.stringify(serverInfo) !== JSON.stringify(session.serverInfo)) {
                throw new Error(`MCP serverInfo changed during recording for task '${task.id}'.`);
            }
            serverInfo = structuredClone(session.serverInfo);
            const prepared = await prepareMeasurementState(session, task, repoRoot);
            if (armIndexProof) {
                assertSamePublishedGeneration(armIndexProof, prepared.indexProof, task.id);
            } else {
                armIndexProof = structuredClone(prepared.indexProof);
            }
            const generationReceipt = publicationIdentity(prepared.indexProof);
            observations.push({ ...(await recordPhase(
                session,
                task,
                "cold",
                repoRoot,
                outputVersion === 2 ? 0 : undefined,
            )), generationReceipt });
            for (let sample = 1; sample <= warmSampleCount; sample += 1) {
                observations.push({ ...(await recordPhase(
                    session,
                    task,
                    "warm",
                    repoRoot,
                    outputVersion === 2 ? sample : undefined,
                )), generationReceipt });
            }
            const finalStatus = (await callAndDecode(session, {
                tool: "manage_index",
                args: { action: "status", path: repoRoot },
            })).payload;
            if (finalStatus.status !== "ok") {
                throw new Error(`Task '${task.id}' index status changed during measured calls.`);
            }
            const finalProof = {
                ...extractCompletedOperationProof(finalStatus, repoRoot, "sync"),
                publication: extractPublicationProof(finalStatus, repoRoot),
            };
            assertSameIndexProof(prepared.indexProof, finalProof, task.id);
            taskRuns.push({ taskId: task.id, ...prepared });
        } finally {
            await session.close();
        }
    }
    const finalRevision = cleanGitRevision(repoRoot);
    if (finalRevision !== revision) {
        throw new Error(`Repository revision changed during recording (${revision} -> ${finalRevision}); discard this run.`);
    }
    const finalRuntimeIdentity = qualificationRuntimeIdentity(options);
    if (canonicalJson(finalRuntimeIdentity) !== canonicalJson(runtimeIdentity)) {
        throw new Error("Satori runtime or recorder artifacts changed during recording; discard this run.");
    }
    if (!armIndexProof) {
        throw new Error("No arm-level index generation proof was recorded.");
    }
    const recorded = {
        version: outputVersion,
        ...(outputVersion === 2 ? { warmSampleCount } : {}),
        metadata: {
            repoRoot,
            gitRevision: revision,
            taskSuiteSha256: hashTaskSuite(validated),
            serverInfo,
            node: recorderNodeMetadata(),
            qualificationRuntime: runtimeIdentity,
            armIndexProof,
            taskRuns,
            warmSampleCount,
        },
        observations,
    };
    validateObservationSet(recorded, expanded.tasks.map((task) => task.id));
    return recorded;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return null;
    }
    if (!fs.existsSync(options.repoRoot) || !fs.statSync(options.repoRoot).isDirectory()) {
        throw new Error(`Repository root '${options.repoRoot}' is not a directory.`);
    }
    requireOutputOutsideRoot(options.outFile, options.repoRoot, "Useful-context recorder");
    const taskSuite = JSON.parse(fs.readFileSync(options.tasksFile, "utf8"));
    const output = await recordSuite(taskSuite, options);
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (!options.dryRun && options.outFile) fs.writeFileSync(options.outFile, text);
    if (options.dryRun || !options.outFile) process.stdout.write(text);
    return output;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`satori-useful-context-record: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        process.exitCode = 1;
    }
}
