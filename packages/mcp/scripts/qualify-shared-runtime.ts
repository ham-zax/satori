import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { connectCliMcpSession, type CliMcpSession } from "../../cli/src/client.js";
import { buildLauncherScript } from "../../cli/src/managed-launcher-script.mjs";

type ProcessMemory = Readonly<{
    pid: number;
    role: "host" | "potion" | "launcher" | "host-child";
    rssKiB: number;
    pssKiB: number;
}>;

type Scenario = Readonly<{
    repetition: number;
    clients: 1 | 2 | 4;
    rows: ProcessMemory[];
    aggregatePssKiB: number;
    latenciesMs: number[];
    p95LatencyMs: number;
    systemMemory: SystemMemory;
}>;

type SystemMemory = Readonly<{
    memAvailableKiB: number;
    swapFreeKiB: number;
}>;

const MCP_ROOT = path.resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = path.resolve(MCP_ROOT, "..", "..");
const RUNTIME_ENTRY = path.join(MCP_ROOT, "dist", "index.js");
const POTION_ASSETS = path.join(MCP_ROOT, "assets", "potion", "linux-x64");
const QUALIFICATION_QUERY = "calculate invoice total";
const WARMUP_SEARCHES = 3;
const ONE_CLIENT_SEARCHES = 10;
const TWO_CLIENT_ROUNDS = 5;
const FOUR_CLIENT_ROUNDS = 5;

function readPackageVersion(packageRoot: string): string {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
        version?: unknown;
    };
    if (typeof parsed.version !== "string") {
        throw new Error(`Package at '${packageRoot}' has no version.`);
    }
    return parsed.version;
}

function readRepositoryIdentity(excludedOutputPath?: string): Readonly<{
    headRevision: string;
    dirty: boolean;
    worktreeSha256: string;
}> {
    const excludedRelativePath = excludedOutputPath
        ? path.relative(REPOSITORY_ROOT, excludedOutputPath).replace(/\\/g, "/")
        : null;
    const excludedRepositoryPath = excludedRelativePath
        && excludedRelativePath !== ".."
        && !excludedRelativePath.startsWith("../")
        ? excludedRelativePath
        : null;
    const repositoryPathspec = excludedRepositoryPath
        ? ["--", ".", `:(exclude)${excludedRepositoryPath}`]
        : ["--"];
    const headRevision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", ...repositoryPathspec], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
    });
    const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD", ...repositoryPathspec], {
        cwd: REPOSITORY_ROOT,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
    });
    const untrackedRaw = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z", ...repositoryPathspec],
        {
            cwd: REPOSITORY_ROOT,
            encoding: "buffer",
        },
    );
    const untracked = untrackedRaw
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .sort();
    const digest = crypto.createHash("sha256");
    digest.update(headRevision);
    digest.update("\0");
    digest.update(status);
    digest.update("\0");
    digest.update(trackedDiff);
    for (const relativePath of untracked) {
        digest.update("\0");
        digest.update(relativePath);
        digest.update("\0");
        digest.update(fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath)));
    }
    return Object.freeze({
        headRevision,
        dirty: status.length > 0,
        worktreeSha256: digest.digest("hex"),
    });
}

function sha256File(filePath: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseFirstText(result: Awaited<ReturnType<CliMcpSession["callTool"]>>): Record<string, unknown> {
    const content = result.content as Array<{ type?: string; text?: string }>;
    const text = content.find((part) => part.type === "text")?.text;
    if (!text) throw new Error("Satori tool response did not contain text.");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (result.isError === true) {
        throw new Error(`Satori tool failed: ${text}`);
    }
    return parsed;
}

function operationPhase(payload: Record<string, unknown>): string | null {
    const operation = payload.operation;
    return typeof operation === "object"
        && operation !== null
        && "phase" in operation
        && typeof operation.phase === "string"
        ? operation.phase
        : null;
}

function percentile95(values: number[]): number {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

function readSystemMemory(): SystemMemory {
    const content = fs.readFileSync("/proc/meminfo", "utf8");
    const read = (name: string): number => {
        const value = Number(content.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m"))?.[1]);
        if (!Number.isFinite(value)) {
            throw new Error(`Cannot read ${name} from /proc/meminfo.`);
        }
        return value;
    };
    return Object.freeze({
        memAvailableKiB: read("MemAvailable"),
        swapFreeKiB: read("SwapFree"),
    });
}

function readProcessMemory(pid: number, role: ProcessMemory["role"]): ProcessMemory | null {
    try {
        const content = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
        const rss = Number(content.match(/^Rss:\s+(\d+)\s+kB$/m)?.[1]);
        const pss = Number(content.match(/^Pss:\s+(\d+)\s+kB$/m)?.[1]);
        if (!Number.isFinite(rss) || !Number.isFinite(pss)) return null;
        return Object.freeze({ pid, role, rssKiB: rss, pssKiB: pss });
    } catch {
        return null;
    }
}

function childPids(parentPid: number): number[] {
    const relationships = new Map<number, number[]>();
    for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const raw = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
            const commandEnd = raw.lastIndexOf(")");
            if (commandEnd < 0) continue;
            const fields = raw.slice(commandEnd + 2).trim().split(/\s+/);
            const parent = Number(fields[1]);
            const pid = Number(entry);
            const children = relationships.get(parent) ?? [];
            children.push(pid);
            relationships.set(parent, children);
        } catch {
            // Process exited during the bounded scan.
        }
    }
    const descendants: number[] = [];
    const pending = [...(relationships.get(parentPid) ?? [])];
    while (pending.length > 0) {
        const pid = pending.shift()!;
        descendants.push(pid);
        pending.push(...(relationships.get(pid) ?? []));
    }
    return descendants;
}

function commandLine(pid: number): string {
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
        return "";
    }
}

function collectRows(hostPid: number, launcherPids: number[]): ProcessMemory[] {
    const rows: ProcessMemory[] = [];
    const host = readProcessMemory(hostPid, "host");
    if (host) rows.push(host);
    for (const pid of childPids(hostPid)) {
        const role = commandLine(pid).includes("satori-potion") ? "potion" : "host-child";
        const row = readProcessMemory(pid, role);
        if (row) rows.push(row);
    }
    for (const pid of launcherPids) {
        const row = readProcessMemory(pid, "launcher");
        if (row) rows.push(row);
    }
    return rows.sort((left, right) => left.pid - right.pid);
}

function isProcessLive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessLive(pid)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (isProcessLive(pid)) {
        throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms.`);
    }
}

function writeFixture(root: string): void {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "invoice.ts"), [
        "export interface InvoiceLine { quantity: number; unitPrice: number }",
        "export function calculateInvoiceTotal(lines: InvoiceLine[]): number {",
        "  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);",
        "}",
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(root, "src", "discount.ts"), [
        "export function applyLoyaltyDiscount(total: number, rate: number): number {",
        "  return Math.max(0, total - total * rate);",
        "}",
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(root, "src", "checkout.ts"), [
        "import { calculateInvoiceTotal } from './invoice.js';",
        "import { applyLoyaltyDiscount } from './discount.js';",
        "export function buildCheckoutAmount(lines: Array<{ quantity: number; unitPrice: number }>): number {",
        "  return applyLoyaltyDiscount(calculateInvoiceTotal(lines), 0.1);",
        "}",
        "",
    ].join("\n"));
}

function findHostPid(stateRoot: string): number {
    const root = path.join(stateRoot, "runtime-host");
    const identities = fs.readdirSync(root);
    if (identities.length !== 1) {
        throw new Error(`Expected one shared runtime identity, found ${identities.length}.`);
    }
    const metadata = JSON.parse(fs.readFileSync(
        path.join(root, identities[0]!, "host.json"),
        "utf8",
    )) as { hostPid?: unknown };
    if (typeof metadata.hostPid !== "number") {
        throw new Error("Shared runtime metadata does not contain a host PID.");
    }
    return metadata.hostPid;
}

async function connect(launcherPath: string, env: Record<string, string>): Promise<CliMcpSession> {
    return connectCliMcpSession({
        command: process.execPath,
        args: [launcherPath],
        env,
        startupTimeoutMs: 20_000,
        callTimeoutMs: 60_000,
        writeStderr: () => {},
    });
}

async function measuredSearch(session: CliMcpSession, fixtureRoot: string): Promise<number> {
    const started = performance.now();
    const response = await session.callTool("search_codebase", {
        path: fixtureRoot,
        query: QUALIFICATION_QUERY,
        scope: "runtime",
        limit: 5,
    });
    const payload = parseFirstText(response);
    if (!Array.isArray(payload.results) || payload.results.length === 0) {
        throw new Error("Qualification query returned no results.");
    }
    return performance.now() - started;
}

async function ensureIndex(session: CliMcpSession, fixtureRoot: string): Promise<void> {
    parseFirstText(await session.callTool("manage_index", {
        action: "create",
        path: fixtureRoot,
        force: true,
    }));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const status = parseFirstText(await session.callTool("manage_index", {
            action: "status",
            path: fixtureRoot,
        }));
        const phase = operationPhase(status);
        if (phase === "completed") return;
        if (phase === "failed" || phase === "blocked") {
            throw new Error(`Index qualification failed: ${JSON.stringify(status)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Index qualification did not complete within 90 seconds.");
}

async function syncFixture(
    session: CliMcpSession,
    fixtureRoot: string,
): Promise<Readonly<{
    action: "sync";
    finalPhase: string;
    resultCount: number;
}>> {
    fs.writeFileSync(path.join(fixtureRoot, "src", "fees.ts"), [
        "export function calculateServiceFee(total: number): number {",
        "  return total * 0.025;",
        "}",
        "",
    ].join("\n"));
    parseFirstText(await session.callTool("manage_index", {
        action: "sync",
        path: fixtureRoot,
    }));
    const deadline = Date.now() + 90_000;
    let finalPhase = "unknown";
    while (Date.now() < deadline) {
        const status = parseFirstText(await session.callTool("manage_index", {
            action: "status",
            path: fixtureRoot,
        }));
        finalPhase = operationPhase(status) ?? "unknown";
        if (finalPhase === "completed") break;
        if (finalPhase === "failed" || finalPhase === "blocked") {
            throw new Error(`Sync qualification failed: ${JSON.stringify(status)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (finalPhase !== "completed") {
        throw new Error("Sync qualification did not complete within 90 seconds.");
    }
    const response = parseFirstText(await session.callTool("search_codebase", {
        path: fixtureRoot,
        query: "calculate service fee",
        scope: "runtime",
        limit: 5,
    }));
    const resultCount = Array.isArray(response.results) ? response.results.length : 0;
    if (resultCount === 0) {
        throw new Error("The synchronized fixture was not searchable.");
    }
    return Object.freeze({ action: "sync", finalPhase, resultCount });
}

async function stopHost(stateRoot: string): Promise<void> {
    const hostPid = findHostPid(stateRoot);
    process.kill(hostPid, "SIGTERM");
    await waitForExit(hostPid, 5_000);
}

async function main(): Promise<void> {
    if (process.platform !== "linux" || process.arch !== "x64") {
        throw new Error("Shared runtime qualification requires Linux x64.");
    }
    if (!fs.existsSync(RUNTIME_ENTRY)) {
        throw new Error(`Build the MCP runtime before qualification: missing '${RUNTIME_ENTRY}'.`);
    }
    const helperPath = path.join(POTION_ASSETS, "satori-potion");
    const modelPath = path.join(POTION_ASSETS, "model");
    if (!fs.existsSync(helperPath) || !fs.existsSync(modelPath)) {
        throw new Error("Potion qualification assets are unavailable.");
    }
    const outputPath = process.env.SATORI_SHARED_QUALIFICATION_OUTPUT
        ? path.resolve(process.env.SATORI_SHARED_QUALIFICATION_OUTPUT)
        : path.join(
            os.tmpdir(),
            `satori-shared-runtime-qualification-${process.pid}.json`,
        );

    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-qualification-"));
    const fixtureRoot = path.join(taskRoot, "fixture");
    const stateRoot = path.join(taskRoot, "state");
    const runtimeDirectory = path.join(taskRoot, "runtime");
    const launcherPath = path.join(taskRoot, "satori-mcp.js");
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    writeFixture(fixtureRoot);
    const managedEnv = {
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: path.join(stateRoot, "vector", "lancedb"),
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: helperPath,
        POTION_MODEL_PATH: modelPath,
        POTION_REQUEST_TIMEOUT_MS: "5000",
        MCP_ENABLE_WATCHER: "false",
    };
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: [RUNTIME_ENTRY],
        managedEnv,
    }));
    fs.chmodSync(launcherPath, 0o755);
    const clientEnv = {
        HOME: taskRoot,
        SATORI_STATE_ROOT: stateRoot,
        XDG_RUNTIME_DIR: runtimeDirectory,
    };
    const scenarios: Scenario[] = [];
    let activeSessions: CliMcpSession[] = [];
    let mutationOutcome: Awaited<ReturnType<typeof syncFixture>>;

    try {
        const setup = await connect(launcherPath, clientEnv);
        activeSessions = [setup];
        await ensureIndex(setup, fixtureRoot);
        await measuredSearch(setup, fixtureRoot);
        mutationOutcome = await syncFixture(setup, fixtureRoot);
        await setup.close();
        activeSessions = [];
        await stopHost(stateRoot);

        for (let repetition = 1; repetition <= 3; repetition += 1) {
            const first = await connect(launcherPath, clientEnv);
            activeSessions = [first];
            for (let warmup = 0; warmup < WARMUP_SEARCHES; warmup += 1) {
                await measuredSearch(first, fixtureRoot);
            }
            const oneLatencies: number[] = [];
            for (let request = 0; request < ONE_CLIENT_SEARCHES; request += 1) {
                oneLatencies.push(await measuredSearch(first, fixtureRoot));
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const hostPid = findHostPid(stateRoot);
            const oneRows = collectRows(hostPid, [first.launcherPid!]);
            scenarios.push(Object.freeze({
                repetition,
                clients: 1,
                rows: oneRows,
                aggregatePssKiB: oneRows.reduce((sum, row) => sum + row.pssKiB, 0),
                latenciesMs: oneLatencies,
                p95LatencyMs: percentile95(oneLatencies),
                systemMemory: readSystemMemory(),
            }));

            const second = await connect(launcherPath, clientEnv);
            activeSessions = [first, second];
            await measuredSearch(second, fixtureRoot);
            const twoLatencies: number[] = [];
            for (let round = 0; round < TWO_CLIENT_ROUNDS; round += 1) {
                twoLatencies.push(...await Promise.all(
                    activeSessions.map((session) => measuredSearch(session, fixtureRoot)),
                ));
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const twoRows = collectRows(
                hostPid,
                activeSessions.map((session) => session.launcherPid!),
            );
            scenarios.push(Object.freeze({
                repetition,
                clients: 2,
                rows: twoRows,
                aggregatePssKiB: twoRows.reduce((sum, row) => sum + row.pssKiB, 0),
                latenciesMs: twoLatencies,
                p95LatencyMs: percentile95(twoLatencies),
                systemMemory: readSystemMemory(),
            }));

            const additional = await Promise.all([
                connect(launcherPath, clientEnv),
                connect(launcherPath, clientEnv),
            ]);
            activeSessions = [first, second, ...additional];
            await Promise.all(additional.map((session) => measuredSearch(session, fixtureRoot)));
            const fourLatencies: number[] = [];
            for (let round = 0; round < FOUR_CLIENT_ROUNDS; round += 1) {
                fourLatencies.push(...await Promise.all(
                    activeSessions.map((session) => measuredSearch(session, fixtureRoot)),
                ));
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const fourRows = collectRows(
                hostPid,
                activeSessions.map((session) => session.launcherPid!),
            );
            scenarios.push(Object.freeze({
                repetition,
                clients: 4,
                rows: fourRows,
                aggregatePssKiB: fourRows.reduce((sum, row) => sum + row.pssKiB, 0),
                latenciesMs: fourLatencies,
                p95LatencyMs: percentile95(fourLatencies),
                systemMemory: readSystemMemory(),
            }));

            await Promise.all(activeSessions.map((session) => session.close()));
            activeSessions = [];
            await stopHost(stateRoot);
        }

        const onePss = scenarios.filter((entry) => entry.clients === 1).map((entry) => entry.aggregatePssKiB).sort((a, b) => a - b);
        const twoPss = scenarios.filter((entry) => entry.clients === 2).map((entry) => entry.aggregatePssKiB).sort((a, b) => a - b);
        const fourPss = scenarios.filter((entry) => entry.clients === 4).map((entry) => entry.aggregatePssKiB).sort((a, b) => a - b);
        const oneLatency = scenarios.filter((entry) => entry.clients === 1).map((entry) => entry.p95LatencyMs).sort((a, b) => a - b);
        const twoLatency = scenarios.filter((entry) => entry.clients === 2).map((entry) => entry.p95LatencyMs).sort((a, b) => a - b);
        const fourLatency = scenarios.filter((entry) => entry.clients === 4).map((entry) => entry.p95LatencyMs).sort((a, b) => a - b);
        const repositoryIdentity = readRepositoryIdentity(outputPath);
        const fixtureFiles = fs.readdirSync(path.join(fixtureRoot, "src"))
            .sort()
            .map((file) => path.join(fixtureRoot, "src", file));
        const result = {
            formatVersion: 2,
            recordedAt: new Date().toISOString(),
            repositoryIdentity,
            runtimeEntry: RUNTIME_ENTRY,
            fixture: {
                generatedBy: path.relative(REPOSITORY_ROOT, fileURLToPath(import.meta.url)),
                fileCount: fixtureFiles.length,
                contentSha256: crypto.createHash("sha256")
                    .update(fixtureFiles.flatMap((file) => [
                        path.basename(file),
                        fs.readFileSync(file),
                    ]).join("\0"))
                    .digest("hex"),
            },
            repetitions: 3,
            environment: {
                platform: process.platform,
                architecture: process.arch,
                kernel: os.release(),
                cpu: os.cpus()[0]?.model ?? "unknown",
                cpuCount: os.cpus().length,
                totalMemoryBytes: os.totalmem(),
                nodeVersion: process.version,
                mcpVersion: readPackageVersion(MCP_ROOT),
                coreVersion: readPackageVersion(path.resolve(MCP_ROOT, "..", "core")),
                cliVersion: readPackageVersion(path.resolve(MCP_ROOT, "..", "cli")),
                potionManifestSha256: sha256File(path.join(POTION_ASSETS, "manifest.json")),
            },
            workload: {
                initialFixtureFiles: 3,
                postMutationFixtureFiles: fixtureFiles.length,
                query: QUALIFICATION_QUERY,
                scope: "runtime",
                resultLimit: 5,
                watcherEnabled: false,
                warmupSearches: WARMUP_SEARCHES,
                measuredOneClientSearches: ONE_CLIENT_SEARCHES,
                measuredTwoClientRounds: TWO_CLIENT_ROUNDS,
                measuredFourClientRounds: FOUR_CLIENT_ROUNDS,
                steadyStateDelayMs: 1_000,
            },
            mutationOutcome,
            scenarios,
            summary: {
                medianOneClientPssKiB: onePss[1],
                medianTwoClientPssKiB: twoPss[1],
                medianFourClientPssKiB: fourPss[1],
                fourToOnePssRatio: fourPss[1]! / onePss[1]!,
                incrementalPssPerAdditionalClientKiB: (fourPss[1]! - onePss[1]!) / 3,
                medianOneClientP95Ms: oneLatency[1],
                medianTwoClientP95Ms: twoLatency[1],
                medianFourClientP95Ms: fourLatency[1],
                hostCounts: scenarios.map((scenario) => (
                    scenario.rows.filter((row) => row.role === "host").length
                )),
                potionWorkerCounts: scenarios.map((scenario) => (
                    scenario.rows.filter((row) => row.role === "potion").length
                )),
            },
        };
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${outputPath}\n`);
    } finally {
        await Promise.all(activeSessions.map((session) => session.close().catch(() => undefined)));
        try {
            const hostPid = findHostPid(stateRoot);
            if (isProcessLive(hostPid)) {
                process.kill(hostPid, "SIGKILL");
                await waitForExit(hostPid, 2_000).catch(() => undefined);
            }
        } catch {
            // No live host remains.
        }
        fs.rmSync(taskRoot, { recursive: true, force: true });
    }
}

await main();
