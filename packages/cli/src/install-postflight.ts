import fs from "node:fs";
import path from "node:path";
import type { ListToolsResult } from "./client.js";
import { connectCliMcpSession } from "./client.js";
import { CliError } from "./errors.js";
import type { InstallCommandResult } from "./install.js";
import {
    resolveLauncherPath,
    resolveManagedClientCommand,
    verifyManagedClientConfigurations,
} from "./install.js";
import { evaluateStaticRuntimeConfig } from "./runtime-config.js";

const EXPECTED_TOOL_NAMES = [
    "manage_index",
    "search_codebase",
    "continue_search",
    "call_graph",
    "file_outline",
    "read_file",
    "list_codebases",
] as const;

export interface InstallPostflightCheck {
    name: "launcher" | "client_configuration" | "mcp_initialize" | "tool_list" | "runtime_owner" | "provider_configuration" | "termination";
    status: "ok" | "warning" | "error";
    message: string;
    code?: string;
}

export interface InstallPostflightResult {
    status: "ok" | "warning" | "error";
    checks: InstallPostflightCheck[];
}

export interface InstallPostflightSession {
    listTools(): Promise<ListToolsResult>;
    close(): Promise<void>;
    readonly launcherPid?: number | null;
    readonly serverVersion?: { name?: string; version?: string };
}

interface RuntimeOwnerRecord {
    ownerId: string;
    pid: number;
    ppid?: number;
    satoriVersion?: string;
}

export interface InstallPostflightOptions {
    installResult: InstallCommandResult;
    homeDir: string;
    env: NodeJS.ProcessEnv;
    startupTimeoutMs: number;
    callTimeoutMs: number;
    writeStderr: (text: string) => void;
    connectSession?: (options: {
        command: string;
        args: string[];
        env: Record<string, string | undefined>;
        startupTimeoutMs: number;
        callTimeoutMs: number;
        writeStderr: (text: string) => void;
        onLauncherStarted?: (pid: number) => void;
    }) => Promise<InstallPostflightSession>;
    isProcessLive?: (pid: number) => boolean;
    wait?: (milliseconds: number) => Promise<void>;
    terminationTimeoutMs?: number;
}

function errorCode(error: unknown): string {
    return error instanceof CliError ? error.token : "E_PROTOCOL_FAILURE";
}

async function closeWithin(
    session: InstallPostflightSession,
    timeoutMs: number,
    wait: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
    let settled = false;
    const closePromise = session.close().then(() => {
        settled = true;
    }).catch(() => {
        settled = true;
    });
    await Promise.race([closePromise, wait(timeoutMs)]);
    return settled;
}

function overallStatus(checks: InstallPostflightCheck[]): InstallPostflightResult["status"] {
    if (checks.some((check) => check.status === "error")) {
        return "error";
    }
    if (checks.some((check) => check.status === "warning")) {
        return "warning";
    }
    return "ok";
}

function ownerRegistryPath(homeDir: string): string {
    return path.join(homeDir, ".satori", "runtime", "owners.json");
}

function readOwners(filePath: string): RuntimeOwnerRecord[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { owners?: unknown };
    if (!Array.isArray(parsed.owners)) {
        throw new Error(`Runtime owner registry shape is invalid at ${filePath}.`);
    }
    return parsed.owners.filter((owner): owner is RuntimeOwnerRecord => {
        if (!owner || typeof owner !== "object") {
            return false;
        }
        const record = owner as Record<string, unknown>;
        return typeof record.ownerId === "string" && typeof record.pid === "number";
    });
}

function expectedPackageVersion(packageSpecifier: string | undefined): string | null {
    if (!packageSpecifier) {
        return null;
    }
    const separator = packageSpecifier.lastIndexOf("@");
    return separator > 0 ? packageSpecifier.slice(separator + 1) || null : null;
}

function toolNames(result: ListToolsResult): string[] {
    return Array.isArray(result.tools)
        ? result.tools.map((tool) => tool.name)
        : [];
}

function isProcessLiveDefault(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForOwnerExit(
    owner: RuntimeOwnerRecord,
    registryPath: string,
    isProcessLive: (pid: number) => boolean,
    wait: (milliseconds: number) => Promise<void>,
    timeoutMs: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        let registered = true;
        try {
            registered = readOwners(registryPath).some((entry) => entry.ownerId === owner.ownerId);
        } catch {
            registered = true;
        }
        if (!isProcessLive(owner.pid) && !registered) {
            return true;
        }
        await wait(25);
    }
    return false;
}

async function waitForProcessExit(
    pid: number,
    isProcessLive: (pid: number) => boolean,
    wait: (milliseconds: number) => Promise<void>,
    timeoutMs: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (!isProcessLive(pid)) {
            return true;
        }
        await wait(25);
    }
    return !isProcessLive(pid);
}

export async function runInstallPostflight(options: InstallPostflightOptions): Promise<InstallPostflightResult> {
    const checks: InstallPostflightCheck[] = [];
    const launcher = resolveManagedClientCommand(options.homeDir);
    const launcherPath = resolveLauncherPath(options.homeDir);
    if (!fs.existsSync(launcherPath)) {
        checks.push({ name: "launcher", status: "error", message: `Managed launcher is missing at ${launcherPath}.` });
        return { status: "error", checks };
    }
    checks.push({ name: "launcher", status: "ok", message: `Managed launcher exists at ${launcherPath}.` });

    const configProof = verifyManagedClientConfigurations(options.installResult, options.homeDir);
    const configFailures = configProof.filter((proof) => proof.status === "error");
    checks.push({
        name: "client_configuration",
        status: configFailures.length === 0 ? "ok" : "error",
        message: configFailures.length === 0
            ? `${configProof.length} managed client configuration${configProof.length === 1 ? "" : "s"} point to the installed launcher.`
            : configFailures.map((proof) => proof.message).join(" "),
    });

    const configChecks = evaluateStaticRuntimeConfig({
        ...options.env,
        ...options.installResult.runtimeEnvironment,
    });
    const configErrors = configChecks.filter((check) => check.status === "error");
    checks.push({
        name: "provider_configuration",
        status: configErrors.length === 0 ? "ok" : "warning",
        message: configErrors.length === 0
            ? "Installed runtime environment has complete static embedding and vector configuration."
            : `Installed runtime environment is incomplete: ${configErrors.map((check) => check.message).join(" ")}`,
    });

    if (configFailures.length > 0) {
        return { status: overallStatus(checks), checks };
    }

    const registryPath = ownerRegistryPath(options.homeDir);
    let baselineOwnerIds: Set<string>;
    try {
        baselineOwnerIds = new Set(readOwners(registryPath).map((owner) => owner.ownerId));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        checks.push({ name: "runtime_owner", status: "error", message });
        return { status: overallStatus(checks), checks };
    }

    let session: InstallPostflightSession | null = null;
    let postflightOwner: RuntimeOwnerRecord | null = null;
    let launcherPid: number | null = null;
    let closeCompleted = true;
    const wait = options.wait || ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const terminationTimeoutMs = options.terminationTimeoutMs ?? 2_000;
    try {
        session = await (options.connectSession || connectCliMcpSession)({
            command: launcher.command,
            args: launcher.args,
            env: {
                ...options.env,
                HOME: options.homeDir,
                SATORI_RUN_MODE: "postflight",
            },
            startupTimeoutMs: options.startupTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            writeStderr: options.writeStderr,
            onLauncherStarted: (pid) => {
                launcherPid = pid;
            },
        });
        launcherPid = session.launcherPid ?? launcherPid;

        const expectedVersion = expectedPackageVersion(options.installResult.packageSpecifier);
        const serverVersion = session.serverVersion?.version;
        const versionMatches = !expectedVersion || serverVersion === expectedVersion;
        checks.push({
            name: "mcp_initialize",
            status: versionMatches ? "ok" : "error",
            message: versionMatches
                ? `MCP initialization succeeded${serverVersion ? ` with satori@${serverVersion}` : ""}.`
                : `Installed package is satori@${expectedVersion}, but the launcher initialized satori@${serverVersion || "unknown"}.`,
        });

        const initializedOwners = readOwners(registryPath);
        postflightOwner = initializedOwners.find((owner) => (
            !baselineOwnerIds.has(owner.ownerId)
            && (launcherPid == null || owner.ppid === launcherPid)
        )) || null;

        const listedNames = toolNames(await session.listTools());
        const toolsMatch = listedNames.length === EXPECTED_TOOL_NAMES.length
            && listedNames.every((name, index) => name === EXPECTED_TOOL_NAMES[index]);
        checks.push({
            name: "tool_list",
            status: toolsMatch ? "ok" : "error",
            message: toolsMatch
                ? "Launcher exposes the fixed seven-tool Satori surface in canonical order."
                : `Expected tools ${JSON.stringify(EXPECTED_TOOL_NAMES)}, received ${JSON.stringify(listedNames)}.`,
        });

        const ownerEvidence = postflightOwner;
        const ownerVersionMatches = ownerEvidence !== null
            && (!expectedVersion || ownerEvidence.satoriVersion === expectedVersion);
        checks.push({
            name: "runtime_owner",
            status: ownerVersionMatches ? "ok" : "error",
            message: ownerVersionMatches && ownerEvidence
                ? `Postflight runtime owner registered with pid=${ownerEvidence.pid} satori@${ownerEvidence.satoriVersion || "unknown"}.`
                : "The initialized launcher did not register a new runtime owner with the installed package version.",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!checks.some((check) => check.name === "mcp_initialize")) {
            checks.push({ name: "mcp_initialize", status: "error", code: errorCode(error), message: `MCP initialization failed: ${message}` });
        } else if (!checks.some((check) => check.name === "tool_list")) {
            checks.push({ name: "tool_list", status: "error", code: errorCode(error), message: `tools/list failed: ${message}` });
        } else if (!checks.some((check) => check.name === "runtime_owner")) {
            checks.push({ name: "runtime_owner", status: "error", code: errorCode(error), message: `Runtime owner verification failed: ${message}` });
        }
    } finally {
        if (session) {
            closeCompleted = await closeWithin(session, terminationTimeoutMs, wait);
        }
    }

    if (!postflightOwner) {
        try {
            const remainingOwners = readOwners(registryPath);
            postflightOwner = remainingOwners.find((owner) => (
                !baselineOwnerIds.has(owner.ownerId)
                && (launcherPid == null || owner.ppid === launcherPid)
            )) || null;
        } catch {
            // Runtime-owner registry errors are reported by the check above.
        }
    }

    if (postflightOwner) {
        const terminated = await waitForOwnerExit(
            postflightOwner,
            registryPath,
            options.isProcessLive || isProcessLiveDefault,
            wait,
            terminationTimeoutMs,
        );
        const fullyTerminated = terminated && closeCompleted;
        checks.push({
            name: "termination",
            status: fullyTerminated ? "ok" : "error",
            code: fullyTerminated ? undefined : "E_TERMINATION_TIMEOUT",
            message: fullyTerminated
                ? "Postflight runtime terminated and removed its owner registration."
                : `Postflight runtime pid=${postflightOwner.pid} remained live or registered, or session close exceeded ${terminationTimeoutMs}ms.`,
        });
    } else if (session) {
        checks.push({
            name: "termination",
            status: closeCompleted ? "warning" : "error",
            code: closeCompleted ? undefined : "E_TERMINATION_TIMEOUT",
            message: closeCompleted
                ? "The postflight session closed, but runtime-owner evidence was unavailable for child termination proof."
                : `Postflight session close exceeded ${terminationTimeoutMs}ms and runtime-owner evidence was unavailable.`,
        });
    } else if (launcherPid !== null) {
        const launcherTerminated = await waitForProcessExit(
            launcherPid,
            options.isProcessLive || isProcessLiveDefault,
            wait,
            terminationTimeoutMs,
        );
        checks.push({
            name: "termination",
            status: launcherTerminated ? "ok" : "error",
            code: launcherTerminated ? undefined : "E_TERMINATION_TIMEOUT",
            message: launcherTerminated
                ? "Failed startup left no live launcher or runtime-owner registration."
                : `Failed startup launcher pid=${launcherPid} remained live after ${terminationTimeoutMs}ms.`,
        });
    }

    return { status: overallStatus(checks), checks };
}
