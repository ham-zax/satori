import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";

type ProcessObservation = Readonly<{
    pid: number;
    bootId?: string;
    processStartTime?: string;
}>;

type TerminationCandidate = Readonly<{
    pid: number;
    bootId?: string;
    processStartTime?: string;
    sources: readonly ("runtime-owner" | "shared-runtime-host")[];
}>;

export type TerminatedServer = Readonly<{
    pid: number;
    sources: readonly ("runtime-owner" | "shared-runtime-host")[];
}>;

export type TerminateResult = Readonly<{
    action: "terminate";
    status: "terminated" | "not_running" | "partial";
    stateRoot: string;
    terminated: readonly TerminatedServer[];
    staleRecordCount: number;
    unverifiedRecordCount: number;
}>;

export interface TerminateOptions {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    pollIntervalMs?: number;
    inspectProcess?: (pid: number) => ProcessObservation | null;
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
    wait?: (milliseconds: number) => Promise<void>;
    now?: () => number;
}

type CandidateAccumulator = {
    pid: number;
    bootId?: string;
    processStartTime?: string;
    sources: Set<"runtime-owner" | "shared-runtime-host">;
    conflicted: boolean;
};

const DEFAULT_TERMINATION_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBootId(): string | undefined {
    try {
        return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
        return undefined;
    }
}

function inspectProcessDefault(pid: number): ProcessObservation | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return null;
    }
    try {
        process.kill(pid, 0);
    } catch {
        return null;
    }
    if (process.platform !== "linux") {
        return { pid };
    }
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const commandEnd = raw.lastIndexOf(")");
        if (commandEnd < 0) return null;
        const fieldsAfterCommand = raw.slice(commandEnd + 2).trim().split(/\s+/);
        const processStartTime = fieldsAfterCommand[19];
        if (!processStartTime) return null;
        return {
            pid,
            bootId: readBootId(),
            processStartTime,
        };
    } catch {
        return null;
    }
}

function sameProcess(
    candidate: Pick<TerminationCandidate, "pid" | "bootId" | "processStartTime">,
    observation: ProcessObservation | null,
): boolean {
    if (!observation || observation.pid !== candidate.pid) {
        return false;
    }
    if (!candidate.processStartTime || !observation.processStartTime) {
        return false;
    }
    if (candidate.processStartTime !== observation.processStartTime) {
        return false;
    }
    return !candidate.bootId
        || (typeof observation.bootId === "string" && candidate.bootId === observation.bootId);
}

function mergeCandidate(
    candidates: Map<number, CandidateAccumulator>,
    candidate: Omit<TerminationCandidate, "sources"> & {
        source: "runtime-owner" | "shared-runtime-host";
    },
): void {
    const existing = candidates.get(candidate.pid);
    if (!existing) {
        candidates.set(candidate.pid, {
            pid: candidate.pid,
            ...(candidate.bootId ? { bootId: candidate.bootId } : {}),
            ...(candidate.processStartTime ? { processStartTime: candidate.processStartTime } : {}),
            sources: new Set([candidate.source]),
            conflicted: false,
        });
        return;
    }
    existing.sources.add(candidate.source);
    if (
        existing.processStartTime
        && candidate.processStartTime
        && existing.processStartTime !== candidate.processStartTime
    ) {
        existing.conflicted = true;
    }
    if (existing.bootId && candidate.bootId && existing.bootId !== candidate.bootId) {
        existing.conflicted = true;
    }
    existing.processStartTime ??= candidate.processStartTime;
    existing.bootId ??= candidate.bootId;
}

function collectRuntimeOwners(
    stateRoot: string,
    candidates: Map<number, CandidateAccumulator>,
): number {
    const registryPath = path.join(stateRoot, "runtime", "owners.json");
    if (!fs.existsSync(registryPath)) {
        return 0;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    } catch {
        return 1;
    }
    if (
        !isRecord(parsed)
        || parsed.formatVersion !== "v1"
        || !Array.isArray(parsed.owners)
    ) {
        return 1;
    }
    let unverified = 0;
    for (const value of parsed.owners) {
        if (
            !isRecord(value)
            || !Number.isSafeInteger(value.pid)
            || Number(value.pid) <= 0
            || typeof value.processStartTime !== "string"
            || value.processStartTime.length === 0
        ) {
            unverified += 1;
            continue;
        }
        mergeCandidate(candidates, {
            pid: Number(value.pid),
            processStartTime: value.processStartTime,
            source: "runtime-owner",
        });
    }
    return unverified;
}

function collectSharedRuntimeHosts(
    stateRoot: string,
    candidates: Map<number, CandidateAccumulator>,
): number {
    const hostsRoot = path.join(stateRoot, "runtime-host");
    if (!fs.existsSync(hostsRoot)) {
        return 0;
    }
    let directories: fs.Dirent[];
    try {
        directories = fs.readdirSync(hostsRoot, { withFileTypes: true });
    } catch {
        return 1;
    }
    let unverified = 0;
    for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        const metadataPath = path.join(hostsRoot, directory.name, "host.json");
        if (!fs.existsSync(metadataPath)) continue;
        let value: unknown;
        try {
            value = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        } catch {
            unverified += 1;
            continue;
        }
        if (
            !isRecord(value)
            || value.formatVersion !== 1
            || (value.protocolVersion !== 1 && value.protocolVersion !== 2)
            || !Number.isSafeInteger(value.hostPid)
            || Number(value.hostPid) <= 0
            || typeof value.bootId !== "string"
            || value.bootId.length === 0
            || typeof value.processStartTime !== "string"
            || value.processStartTime.length === 0
        ) {
            unverified += 1;
            continue;
        }
        mergeCandidate(candidates, {
            pid: Number(value.hostPid),
            bootId: value.bootId,
            processStartTime: value.processStartTime,
            source: "shared-runtime-host",
        });
    }
    return unverified;
}

function normalizedCandidates(
    accumulated: Map<number, CandidateAccumulator>,
): { candidates: TerminationCandidate[]; conflictedCount: number } {
    const candidates: TerminationCandidate[] = [];
    let conflictedCount = 0;
    for (const value of accumulated.values()) {
        if (value.conflicted || !value.processStartTime) {
            conflictedCount += 1;
            continue;
        }
        candidates.push({
            pid: value.pid,
            ...(value.bootId ? { bootId: value.bootId } : {}),
            processStartTime: value.processStartTime,
            sources: [...value.sources].sort(),
        });
    }
    candidates.sort((left, right) => left.pid - right.pid);
    return { candidates, conflictedCount };
}

export async function terminateSatoriServers(
    options: TerminateOptions = {},
): Promise<TerminateResult> {
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? env.HOME ?? os.homedir();
    const stateRoot = path.resolve(env.SATORI_STATE_ROOT ?? path.join(homeDir, ".satori"));
    const inspectProcess = options.inspectProcess ?? inspectProcessDefault;
    const signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    }));
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const accumulated = new Map<number, CandidateAccumulator>();
    let unverifiedRecordCount = collectRuntimeOwners(stateRoot, accumulated);
    unverifiedRecordCount += collectSharedRuntimeHosts(stateRoot, accumulated);
    const normalized = normalizedCandidates(accumulated);
    unverifiedRecordCount += normalized.conflictedCount;

    const live = normalized.candidates.filter((candidate) => (
        candidate.pid !== process.pid
        && sameProcess(candidate, inspectProcess(candidate.pid))
    ));
    const staleRecordCount = normalized.candidates.length - live.length;
    const terminated: TerminatedServer[] = [];

    for (const candidate of live) {
        try {
            signalProcess(candidate.pid, "SIGTERM");
            terminated.push({ pid: candidate.pid, sources: candidate.sources });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                throw new CliError(
                    "E_TERMINATION_FAILED",
                    `Failed to terminate Satori server pid=${candidate.pid}: ${(error as Error).message}`,
                    1,
                );
            }
        }
    }

    const deadline = now() + timeoutMs;
    let pending = live.filter((candidate) => sameProcess(candidate, inspectProcess(candidate.pid)));
    while (pending.length > 0 && now() < deadline) {
        await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
        pending = pending.filter((candidate) => sameProcess(candidate, inspectProcess(candidate.pid)));
    }
    if (pending.length > 0) {
        throw new CliError(
            "E_TERMINATION_TIMEOUT",
            `Timed out waiting for Satori server process${pending.length === 1 ? "" : "es"} ${pending.map((entry) => entry.pid).join(", ")} to stop.`,
            1,
        );
    }

    const status = unverifiedRecordCount > 0
        ? "partial"
        : terminated.length > 0
            ? "terminated"
            : "not_running";
    return {
        action: "terminate",
        status,
        stateRoot,
        terminated,
        staleRecordCount,
        unverifiedRecordCount,
    };
}

export function formatTerminateText(result: TerminateResult): string {
    if (result.status === "not_running") {
        return "No Satori servers are running.\n";
    }
    const lines = [
        result.status === "terminated"
            ? "Satori servers terminated"
            : "Satori server termination completed with unverified state",
        "",
        `Stopped: ${result.terminated.length}`,
    ];
    if (result.staleRecordCount > 0) {
        lines.push(`Stale records ignored: ${result.staleRecordCount}`);
    }
    if (result.unverifiedRecordCount > 0) {
        lines.push(`Unverified records: ${result.unverifiedRecordCount}`);
    }
    lines.push("");
    return lines.join("\n");
}
