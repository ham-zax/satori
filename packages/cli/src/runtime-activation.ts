import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { resolveLauncherPath } from "./managed-runtime-paths.js";
import {
    MANAGED_LAUNCHER_SCOPE_HEX_LENGTH,
    MANAGED_LAUNCHER_TITLE_TOKEN_HEX_LENGTH,
    parseManagedLauncherCohortToken,
} from "./managed-launcher-script.mjs";
import {
    acquireManagedRuntimeLeaseLock,
    inspectManagedRuntimeLeases,
} from "./managed-runtime-store.js";
import {
    terminateSatoriServers,
    type TerminateOptions,
    type TerminateResult,
} from "./terminate.js";

type TerminateRunner = (options?: TerminateOptions) => Promise<TerminateResult>;

export interface ManagedRuntimeActivationOptions {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    terminateRunner?: TerminateRunner;
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
    wait?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
    listManagedLauncherProcesses?: (
        launcherPath: string,
        activeCohortToken?: string,
    ) => readonly number[];
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 25;
const LAUNCHER_TITLE_PREFIX = "satori-mcp:";

function readLinuxCommandLine(pid: number): string[] {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
        return raw.toString("utf8").split("\0").filter((entry) => entry.length > 0);
    } catch {
        return [];
    }
}

function listManagedLauncherProcessesDefault(
    launcherPath: string,
    activeCohortToken?: string,
): number[] {
    if (process.platform !== "linux") {
        return [];
    }
    const resolvedLauncherPath = path.resolve(launcherPath);
    const activeScopeTitlePrefix = activeCohortToken
        ? `${LAUNCHER_TITLE_PREFIX}${activeCohortToken.slice(0, MANAGED_LAUNCHER_SCOPE_HEX_LENGTH)}`
        : undefined;
    const activeTitle = activeCohortToken
        ? `${LAUNCHER_TITLE_PREFIX}${activeCohortToken.slice(0, MANAGED_LAUNCHER_TITLE_TOKEN_HEX_LENGTH)}`
        : undefined;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync("/proc", { withFileTypes: true });
    } catch {
        return [];
    }

    const pids: number[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
        try {
            if (fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
        } catch {
            continue;
        }
        const argv = readLinuxCommandLine(pid);
        if (argv.length === 0) continue;
        const title = argv[0];
        if (title.startsWith(LAUNCHER_TITLE_PREFIX)) {
            if (
                activeScopeTitlePrefix !== undefined
                && title.startsWith(activeScopeTitlePrefix)
                && title !== activeTitle
            ) {
                pids.push(pid);
            }
            continue;
        }
        // Client configs invoke node with the launcher as its script, never as data.
        if (argv[0] === resolvedLauncherPath || (
            (argv[0] === process.execPath || ["node", "nodejs"].includes(path.basename(argv[0])))
            && argv[1] === resolvedLauncherPath
        )) {
            pids.push(pid);
        }
    }
    return pids.sort((left, right) => left - right);
}

async function terminateVerifiedServers(
    options: ManagedRuntimeActivationOptions,
): Promise<TerminateResult> {
    const result = await (options.terminateRunner ?? terminateSatoriServers)({
        homeDir: options.homeDir,
        env: options.env,
    });
    if (result.status === "partial") {
        throw new CliError(
            "E_TERMINATION_FAILED",
            "Cannot safely activate a Satori runtime while existing server ownership is only partially verified.",
            1,
        );
    }
    return result;
}

async function drainManagedLaunchers(
    options: ManagedRuntimeActivationOptions,
): Promise<void> {
    const homeDir = options.homeDir ?? os.homedir();
    const signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    }));
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

    let snapshot = inspectManagedRuntimeLeases({ homeDir });
    if (snapshot.unsafe) {
        throw new CliError(
            "E_TERMINATION_FAILED",
            `Cannot safely activate a Satori runtime while managed launcher leases are unverified: ${snapshot.warnings.join(" ")}`,
            1,
        );
    }

    for (const lease of snapshot.leases) {
        if (lease.pid === process.pid) {
            throw new CliError(
                "E_TERMINATION_FAILED",
                "Cannot replace the managed Satori runtime from inside its own active launcher process.",
                1,
            );
        }
        try {
            signalProcess(lease.pid, "SIGTERM");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                throw new CliError(
                    "E_TERMINATION_FAILED",
                    `Failed to stop managed Satori launcher pid=${lease.pid}: ${error instanceof Error ? error.message : String(error)}`,
                    1,
                );
            }
        }
    }

    const deadline = now() + timeoutMs;
    while (true) {
        snapshot = inspectManagedRuntimeLeases({ homeDir });
        if (snapshot.unsafe) {
            throw new CliError(
                "E_TERMINATION_FAILED",
                `Cannot safely activate a Satori runtime while managed launcher leases are unverified: ${snapshot.warnings.join(" ")}`,
                1,
            );
        }
        if (snapshot.leases.length === 0) {
            return;
        }
        if (now() >= deadline) {
            throw new CliError(
                "E_TERMINATION_TIMEOUT",
                `Timed out waiting for managed Satori launcher process${snapshot.leases.length === 1 ? "" : "es"} ${snapshot.leases.map((lease) => lease.pid).join(", ")} to stop.`,
                1,
            );
        }
        await wait(Math.min(DRAIN_POLL_MS, Math.max(1, deadline - now())));
    }
}

function readActiveCohortToken(homeDir: string): string {
    const launcherPath = resolveLauncherPath(homeDir);
    let content: string;
    try {
        content = fs.readFileSync(launcherPath, "utf8");
    } catch (error) {
        throw new CliError(
            "E_ACTIVATION_PARTIAL",
            `The Satori launcher was activated but its cohort identity could not be read: ${error instanceof Error ? error.message : String(error)}`,
            1,
        );
    }
    try {
        return parseManagedLauncherCohortToken(content);
    } catch (error) {
        throw new CliError(
            "E_ACTIVATION_PARTIAL",
            `The Satori launcher was activated but its cohort identity is invalid: ${error instanceof Error ? error.message : String(error)}`,
            1,
        );
    }
}

async function drainRetiredLauncherProcesses(
    options: ManagedRuntimeActivationOptions,
    activeCohortToken: string,
): Promise<void> {
    const homeDir = options.homeDir ?? os.homedir();
    const launcherPath = resolveLauncherPath(homeDir);
    const listProcesses = options.listManagedLauncherProcesses ?? listManagedLauncherProcessesDefault;
    const signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    }));
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

    let pending = listProcesses(launcherPath, activeCohortToken)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    for (const pid of pending) {
        try {
            signalProcess(pid, "SIGTERM");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                throw new CliError(
                    "E_ACTIVATION_PARTIAL",
                    `The new Satori launcher is active, but retired launcher pid=${pid} could not be stopped: ${error instanceof Error ? error.message : String(error)}`,
                    1,
                );
            }
        }
    }

    const deadline = now() + timeoutMs;
    while (true) {
        pending = listProcesses(launcherPath, activeCohortToken)
            .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
        if (pending.length === 0) return;
        if (now() >= deadline) {
            throw new CliError(
                "E_ACTIVATION_PARTIAL",
                `The new Satori launcher is active, but retired launcher process${pending.length === 1 ? "" : "es"} ${pending.join(", ")} did not stop before the activation deadline. Rerun the install or upgrade command to complete cohort retirement.`,
                1,
            );
        }
        await wait(Math.min(DRAIN_POLL_MS, Math.max(1, deadline - now())));
    }
}

/**
 * Run one managed-runtime activation while excluding every previous launcher/server cohort.
 *
 * The lease lock is the admission barrier used by generated managed launchers. Holding it
 * from the first retirement sweep through activation prevents a managed launcher from
 * entering while the active launcher is being replaced. Every generated launcher also carries
 * a cohort token and uses the same lock even for direct local runtimes. After activation, any
 * legacy/unmarked or mismatched launcher process is retired before a final server sweep.
 */
export async function activateAfterRetiringManagedRuntime<T>(
    options: ManagedRuntimeActivationOptions,
    activate: () => T | Promise<T>,
): Promise<T> {
    const homeDir = options.homeDir ?? os.homedir();
    const releaseLeaseLock = acquireManagedRuntimeLeaseLock({ homeDir });
    try {
        await terminateVerifiedServers({ ...options, homeDir });
        await drainManagedLaunchers({ ...options, homeDir });
        await terminateVerifiedServers({ ...options, homeDir });
        const result = await activate();
        const activeCohortToken = readActiveCohortToken(homeDir);
        await drainRetiredLauncherProcesses({ ...options, homeDir }, activeCohortToken);
        await terminateVerifiedServers({ ...options, homeDir });
        return result;
    } finally {
        releaseLeaseLock();
    }
}
