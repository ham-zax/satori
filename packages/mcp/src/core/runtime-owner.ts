import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ContextMcpConfig, IndexFingerprint } from "../config.js";

export type RuntimeOwnerMutationAction = "create" | "reindex" | "sync" | "clear";

export interface RuntimeOwnerConfigSummary {
    embeddingProvider: string;
    embeddingModel: string;
    embeddingDimension: number;
    vectorStoreProvider: string;
    schemaVersion: string;
    milvusEndpoint?: string | null;
    rankerModel?: string | null;
}

export interface RuntimeOwnerIdentity {
    satoriVersion: string;
    runtimeFingerprint: IndexFingerprint;
    configSource: string;
    configSummary: RuntimeOwnerConfigSummary;
    hash: string;
}

export interface ProcessSnapshot {
    pid: number;
    ppid?: number;
    cmd?: string;
    cwd?: string;
    processStartTime?: string;
}

export interface ProcessInspector {
    inspect(pid: number): ProcessSnapshot | null;
}

export interface RuntimeOwnerRecord {
    ownerId: string;
    pid: number;
    ppid?: number;
    cmd?: string;
    cwd?: string;
    startedAt: string;
    lastSeenAt: string;
    satoriVersion: string;
    runtimeFingerprint: IndexFingerprint;
    runtimeOwnerIdentityHash: string;
    configSource: string;
    processStartTime?: string;
}

export interface RuntimeOwnerConflictSummary {
    ownerId: string;
    pid: number;
    ppid?: number;
    cmd?: string;
    cwd?: string;
    startedAt: string;
    lastSeenAt: string;
    satoriVersion: string;
    runtimeOwnerIdentityHash: string;
    configSource: string;
    conflictReasons: Array<"runtimeFingerprint" | "satoriVersion" | "runtimeOwnerIdentityHash">;
}

export interface RuntimeOwnerMutationGateResult {
    blocked: boolean;
    reason?: "runtime_owner_conflict";
    message?: string;
    conflictingOwners?: RuntimeOwnerConflictSummary[];
}

export interface RuntimeOwnerMutationGate {
    checkMutation(
        action: RuntimeOwnerMutationAction,
        codebasePath: string
    ): RuntimeOwnerMutationGateResult | Promise<RuntimeOwnerMutationGateResult>;
}

interface RuntimeOwnerFile {
    formatVersion: "v1";
    updatedAt: string;
    owners: RuntimeOwnerRecord[];
}

interface RuntimeOwnerRegistryOptions {
    stateDir?: string;
    identity: RuntimeOwnerIdentity;
    processInspector?: ProcessInspector;
    currentProcess?: ProcessSnapshot;
    ownerId?: string;
    now?: () => number;
    staleMs?: number;
    lockWaitMs?: number;
    lockRetryMs?: number;
}

const OWNER_FILE_NAME = "owners.json";
const OWNER_LOCK_NAME = "owners.lock";
const OWNER_LOCK_WAIT_MS = 2_000;
const OWNER_LOCK_RETRY_MS = 50;
const OWNER_LOCK_STALE_MS = 30_000;
const OWNER_LOCK_METADATALESS_STALE_MS = 5 * 60_000;
const DEFAULT_OWNER_STALE_MS = 30 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }
    if (isRecord(value)) {
        const entries = Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEndpoint(endpoint: string | undefined): string | null {
    if (!endpoint) {
        return null;
    }
    return endpoint.trim().replace(/\/+$/, "") || null;
}

export function buildRuntimeOwnerIdentity(args: {
    satoriVersion: string;
    runtimeFingerprint: IndexFingerprint;
    configSource: string;
    configSummary: RuntimeOwnerConfigSummary;
}): RuntimeOwnerIdentity {
    const normalizedSummary: RuntimeOwnerConfigSummary = {
        embeddingProvider: args.configSummary.embeddingProvider,
        embeddingModel: args.configSummary.embeddingModel,
        embeddingDimension: args.configSummary.embeddingDimension,
        vectorStoreProvider: args.configSummary.vectorStoreProvider,
        schemaVersion: args.configSummary.schemaVersion,
        milvusEndpoint: normalizeEndpoint(args.configSummary.milvusEndpoint ?? undefined),
        rankerModel: args.configSummary.rankerModel ?? null,
    };
    const identityPayload = {
        satoriVersion: args.satoriVersion,
        runtimeFingerprint: args.runtimeFingerprint,
        configSource: args.configSource,
        configSummary: normalizedSummary,
    };
    return {
        ...identityPayload,
        hash: sha256(stableStringify(identityPayload)),
    };
}

export function buildRuntimeOwnerIdentityFromConfig(args: {
    config: ContextMcpConfig;
    runtimeFingerprint: IndexFingerprint;
    satoriVersion?: string;
    configSource?: string;
}): RuntimeOwnerIdentity {
    return buildRuntimeOwnerIdentity({
        satoriVersion: args.satoriVersion || readMcpPackageVersion(),
        runtimeFingerprint: args.runtimeFingerprint,
        configSource: args.configSource || "env",
        configSummary: {
            embeddingProvider: args.config.encoderProvider,
            embeddingModel: args.config.encoderModel,
            embeddingDimension: args.runtimeFingerprint.embeddingDimension,
            vectorStoreProvider: args.runtimeFingerprint.vectorStoreProvider,
            schemaVersion: args.runtimeFingerprint.schemaVersion,
            milvusEndpoint: args.config.milvusEndpoint,
            rankerModel: args.config.rankerModel || null,
        }
    });
}

export function readMcpPackageVersion(): string {
    try {
        const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        return typeof parsed.version === "string" ? parsed.version : "unknown";
    } catch {
        return "unknown";
    }
}

const CONFLICT_REASON_LABELS: Record<RuntimeOwnerConflictSummary["conflictReasons"][number], string> = {
    runtimeFingerprint: "runtime fingerprint (embedding/vector/schema)",
    satoriVersion: "Satori package version",
    runtimeOwnerIdentityHash: "config identity hash",
};

/**
 * Operator-facing conflict text for manage_index mutation blocks.
 * MCP tools never kill other processes; this message must list concrete PIDs.
 */
export function formatRuntimeOwnerConflictMessage(args: {
    currentVersion?: string;
    currentPid?: number;
    conflictingOwners: RuntimeOwnerConflictSummary[];
    registryError?: string;
}): string {
    if (args.registryError) {
        return [
            "Index mutation is blocked because the Satori runtime owner registry could not be validated.",
            `Registry error: ${args.registryError}`,
            `Inspect ${path.join(defaultRuntimeStateDir(), OWNER_FILE_NAME)} and remove a stale lock at ${path.join(defaultRuntimeStateDir(), OWNER_LOCK_NAME)} if present, then retry.`,
        ].join(" ");
    }

    const me = args.currentPid !== undefined
        ? `this runtime pid=${args.currentPid}${args.currentVersion ? ` satori@${args.currentVersion}` : ""}`
        : (args.currentVersion ? `this runtime satori@${args.currentVersion}` : "this runtime");

    if (args.conflictingOwners.length === 0) {
        return `Index mutation is blocked because multiple Satori runtimes with different fingerprints/configs are active (${me}). Stop other Satori MCP clients, then retry.`;
    }

    const ownerLines = args.conflictingOwners.map((owner) => {
        const reasons = owner.conflictReasons
            .map((reason) => CONFLICT_REASON_LABELS[reason] || reason)
            .join(", ");
        const cmd = owner.cmd ? ` cmd=${JSON.stringify(owner.cmd)}` : "";
        return `pid=${owner.pid} satori@${owner.satoriVersion} differs on ${reasons}${cmd}`;
    });

    const pids = args.conflictingOwners.map((owner) => String(owner.pid)).join(" ");
    return [
        `Index mutation is blocked: ${me} conflicts with ${args.conflictingOwners.length} other live Satori MCP runtime(s).`,
        `Conflicting owners: ${ownerLines.join("; ")}.`,
        "MCP tools do not kill processes.",
        `Stop those clients (or only if they are orphaned Satori MCP servers: kill ${pids}), leave a single Satori version/config running, then retry create/reindex/sync/clear.`,
        `Registry: ${path.join(defaultRuntimeStateDir(), OWNER_FILE_NAME)}.`,
    ].join(" ");
}

export function formatRuntimeOwnerConflictNextStep(conflictingOwners: RuntimeOwnerConflictSummary[]): string {
    if (conflictingOwners.length === 0) {
        return [
            "Stop every other Satori MCP client (IDE/agent sessions) so only one package version and config remain.",
            `Inspect ${path.join(defaultRuntimeStateDir(), OWNER_FILE_NAME)}, restart this MCP client, then retry the same manage_index action.`,
        ].join(" ");
    }
    const pidList = conflictingOwners.map((owner) => owner.pid).join(", ");
    const versions = [...new Set(conflictingOwners.map((owner) => owner.satoriVersion))].join(", ");
    return [
        `Stop conflicting Satori MCP process(es) pid=${pidList} (versions: ${versions}) by quitting their host clients.`,
        "Do not retry create/reindex/sync while those PIDs are live.",
        "After only one runtime identity remains, retry the same manage_index action.",
        `If a PID is an orphaned node server, terminate only that process, then re-check ${path.join(defaultRuntimeStateDir(), OWNER_FILE_NAME)}.`,
    ].join(" ");
}

function defaultRuntimeStateDir(): string {
    return path.join(os.homedir(), ".satori", "runtime");
}

function sleepSync(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) {
        return;
    }
    const waitBuffer = new SharedArrayBuffer(4);
    const waitArray = new Int32Array(waitBuffer);
    Atomics.wait(waitArray, 0, 0, ms);
}

function processExists(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readLinuxProcessSnapshot(pid: number): ProcessSnapshot | null {
    const procDir = `/proc/${pid}`;
    if (!fs.existsSync(procDir)) {
        return null;
    }
    let cmd: string | undefined;
    let cwd: string | undefined;
    let ppid: number | undefined;
    let processStartTime: string | undefined;

    try {
        cmd = fs.readFileSync(path.join(procDir, "cmdline"), "utf8")
            .split("\0")
            .filter(Boolean)
            .join(" ");
    } catch {
        cmd = undefined;
    }

    try {
        cwd = fs.readlinkSync(path.join(procDir, "cwd"));
    } catch {
        cwd = undefined;
    }

    try {
        const stat = fs.readFileSync(path.join(procDir, "stat"), "utf8");
        const closeParen = stat.lastIndexOf(")");
        const fields = closeParen >= 0
            ? stat.slice(closeParen + 2).trim().split(/\s+/)
            : [];
        const parsedPpid = Number(fields[1]);
        if (Number.isFinite(parsedPpid)) {
            ppid = parsedPpid;
        }
        if (fields[19]) {
            processStartTime = fields[19];
        }
    } catch {
        ppid = undefined;
    }

    return { pid, ppid, cmd, cwd, processStartTime };
}

class DefaultProcessInspector implements ProcessInspector {
    inspect(pid: number): ProcessSnapshot | null {
        if (!processExists(pid)) {
            return null;
        }
        if (process.platform === "linux") {
            const snapshot = readLinuxProcessSnapshot(pid);
            if (snapshot) {
                return snapshot;
            }
        }
        if (pid === process.pid) {
            return {
                pid,
                ppid: process.ppid,
                cmd: process.argv.join(" "),
                cwd: process.cwd(),
            };
        }
        return { pid };
    }
}

export class RuntimeOwnerRegistry implements RuntimeOwnerMutationGate {
    private readonly stateDir: string;
    private readonly identity: RuntimeOwnerIdentity;
    private readonly processInspector: ProcessInspector;
    private readonly currentProcess: ProcessSnapshot;
    private readonly ownerId: string;
    private readonly now: () => number;
    private readonly staleMs: number;
    private readonly startedAt: string;
    private readonly lockWaitMs: number;
    private readonly lockRetryMs: number;

    constructor(options: RuntimeOwnerRegistryOptions) {
        this.stateDir = options.stateDir || defaultRuntimeStateDir();
        this.identity = options.identity;
        this.processInspector = options.processInspector || new DefaultProcessInspector();
        this.currentProcess = options.currentProcess
            || this.processInspector.inspect(process.pid)
            || {
                pid: process.pid,
                ppid: process.ppid,
                cmd: process.argv.join(" "),
                cwd: process.cwd(),
            };
        this.ownerId = options.ownerId || crypto.randomUUID();
        this.now = options.now || (() => Date.now());
        this.staleMs = options.staleMs || DEFAULT_OWNER_STALE_MS;
        this.startedAt = new Date(this.now()).toISOString();
        this.lockWaitMs = options.lockWaitMs ?? OWNER_LOCK_WAIT_MS;
        this.lockRetryMs = options.lockRetryMs ?? OWNER_LOCK_RETRY_MS;
    }

    public registerCurrentOwner(): RuntimeOwnerRecord {
        const record = this.buildCurrentOwnerRecord();
        this.withOwnersLock(() => {
            const owners = this.readOwnersFile("quarantine");
            const liveOwners = this.pruneDeadOwners(owners);
            const nextOwners = liveOwners.filter((owner) => owner.ownerId !== this.ownerId);
            nextOwners.push(record);
            this.writeOwnersFile(nextOwners);
        });
        return record;
    }

    public unregisterCurrentOwner(): void {
        try {
            this.withOwnersLock(() => {
                const owners = this.readOwnersFile("quarantine");
                this.writeOwnersFile(owners.filter((owner) => owner.ownerId !== this.ownerId));
            });
        } catch {
            // Shutdown cleanup is best-effort; startup/prune handles missing unregisters.
        }
    }

    public checkMutation(_action: RuntimeOwnerMutationAction, _codebasePath: string): RuntimeOwnerMutationGateResult {
        try {
            const conflictingOwners = this.withOwnersLock(() => {
                const owners = this.readOwnersFile("throw");
                const liveOwners = this.pruneDeadOwners(owners);
                const currentRecord = this.buildCurrentOwnerRecord();
                const nextOwners = liveOwners.filter((owner) => owner.ownerId !== this.ownerId);
                nextOwners.push(currentRecord);
                this.writeOwnersFile(nextOwners);
                return nextOwners
                    .filter((owner) => owner.ownerId !== this.ownerId)
                    .map((owner) => this.toConflictSummary(owner))
                    .filter((owner): owner is RuntimeOwnerConflictSummary => owner !== null);
            });

            if (conflictingOwners.length === 0) {
                return { blocked: false };
            }
            return {
                blocked: true,
                reason: "runtime_owner_conflict",
                message: formatRuntimeOwnerConflictMessage({
                    currentVersion: this.identity.satoriVersion,
                    currentPid: this.currentProcess.pid,
                    conflictingOwners,
                }),
                conflictingOwners,
            };
        } catch (error) {
            return {
                blocked: true,
                reason: "runtime_owner_conflict",
                message: formatRuntimeOwnerConflictMessage({
                    currentVersion: this.identity.satoriVersion,
                    currentPid: this.currentProcess.pid,
                    conflictingOwners: [],
                    registryError: error instanceof Error ? error.message : String(error),
                }),
                conflictingOwners: [],
            };
        }
    }

    public readOwnersForDebug(): RuntimeOwnerRecord[] {
        return this.readOwnersFile("throw");
    }

    private buildCurrentOwnerRecord(): RuntimeOwnerRecord {
        const nowIso = new Date(this.now()).toISOString();
        return {
            ownerId: this.ownerId,
            pid: this.currentProcess.pid,
            ppid: this.currentProcess.ppid,
            cmd: this.currentProcess.cmd,
            cwd: this.currentProcess.cwd,
            startedAt: this.startedAt,
            lastSeenAt: nowIso,
            satoriVersion: this.identity.satoriVersion,
            runtimeFingerprint: this.identity.runtimeFingerprint,
            runtimeOwnerIdentityHash: this.identity.hash,
            configSource: this.identity.configSource,
            processStartTime: this.currentProcess.processStartTime,
        };
    }

    private toConflictSummary(owner: RuntimeOwnerRecord): RuntimeOwnerConflictSummary | null {
        const conflictReasons: RuntimeOwnerConflictSummary["conflictReasons"] = [];
        if (stableStringify(owner.runtimeFingerprint) !== stableStringify(this.identity.runtimeFingerprint)) {
            conflictReasons.push("runtimeFingerprint");
        }
        if (owner.satoriVersion !== this.identity.satoriVersion) {
            conflictReasons.push("satoriVersion");
        }
        if (owner.runtimeOwnerIdentityHash !== this.identity.hash) {
            conflictReasons.push("runtimeOwnerIdentityHash");
        }
        if (conflictReasons.length === 0) {
            return null;
        }
        return {
            ownerId: owner.ownerId,
            pid: owner.pid,
            ppid: owner.ppid,
            cmd: owner.cmd,
            cwd: owner.cwd,
            startedAt: owner.startedAt,
            lastSeenAt: owner.lastSeenAt,
            satoriVersion: owner.satoriVersion,
            runtimeOwnerIdentityHash: owner.runtimeOwnerIdentityHash,
            configSource: owner.configSource,
            conflictReasons,
        };
    }

    private pruneDeadOwners(owners: RuntimeOwnerRecord[]): RuntimeOwnerRecord[] {
        return owners.filter((owner) => this.isOwnerLive(owner));
    }

    private isOwnerLive(owner: RuntimeOwnerRecord): boolean {
        const lastSeenMs = Date.parse(owner.lastSeenAt);
        if (!Number.isFinite(lastSeenMs) || this.now() - lastSeenMs > this.staleMs) {
            return false;
        }
        const current = this.processInspector.inspect(owner.pid);
        if (!current) {
            return false;
        }
        if (owner.processStartTime && current.processStartTime && owner.processStartTime !== current.processStartTime) {
            return false;
        }
        if (owner.processStartTime && current.processStartTime) {
            return true;
        }

        let strongIdentityEvidence = false;
        if (owner.ppid !== undefined && current.ppid !== undefined && owner.ppid !== current.ppid) {
            return false;
        }
        if (owner.cmd && current.cmd) {
            if (owner.cmd !== current.cmd) {
                return false;
            }
            strongIdentityEvidence = true;
        }
        if (owner.cwd && current.cwd) {
            if (owner.cwd !== current.cwd) {
                return false;
            }
            strongIdentityEvidence = true;
        }
        return strongIdentityEvidence;
    }

    private ownersFilePath(): string {
        return path.join(this.stateDir, OWNER_FILE_NAME);
    }

    private ownersLockPath(): string {
        return path.join(this.stateDir, OWNER_LOCK_NAME);
    }

    private readOwnersFile(onCorrupt: "quarantine" | "throw"): RuntimeOwnerRecord[] {
        const filePath = this.ownersFilePath();
        if (!fs.existsSync(filePath)) {
            return [];
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (!isRecord(parsed) || parsed.formatVersion !== "v1" || !Array.isArray(parsed.owners)) {
                throw new Error("invalid owners registry shape");
            }
            return parsed.owners.filter((owner): owner is RuntimeOwnerRecord => this.isRuntimeOwnerRecord(owner));
        } catch (error) {
            if (onCorrupt === "quarantine") {
                this.quarantineOwnersFile(filePath);
                return [];
            }
            throw error;
        }
    }

    private isRuntimeOwnerRecord(value: unknown): value is RuntimeOwnerRecord {
        if (!isRecord(value)) {
            return false;
        }
        return (
            typeof value.ownerId === "string"
            && typeof value.pid === "number"
            && typeof value.startedAt === "string"
            && typeof value.lastSeenAt === "string"
            && typeof value.satoriVersion === "string"
            && isRecord(value.runtimeFingerprint)
            && typeof value.runtimeOwnerIdentityHash === "string"
            && typeof value.configSource === "string"
        );
    }

    private quarantineOwnersFile(filePath: string): void {
        try {
            const quarantinePath = `${filePath}.corrupt-${this.now()}`;
            fs.renameSync(filePath, quarantinePath);
        } catch {
            // If quarantine fails, write path will still fail closed at mutation check time.
        }
    }

    private writeOwnersFile(owners: RuntimeOwnerRecord[]): void {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const payload: RuntimeOwnerFile = {
            formatVersion: "v1",
            updatedAt: new Date(this.now()).toISOString(),
            owners: owners.sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
        };
        const targetPath = this.ownersFilePath();
        const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
        fs.renameSync(tempPath, targetPath);
    }

    private withOwnersLock<T>(fn: () => T): T {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const lockPath = this.ownersLockPath();
        const deadline = Date.now() + this.lockWaitMs;
        let fd: number | null = null;
        while (Date.now() <= deadline) {
            try {
                fd = fs.openSync(lockPath, "wx");
                fs.writeFileSync(fd, JSON.stringify({
                    pid: process.pid,
                    acquiredAt: new Date().toISOString(),
                }));
                break;
            } catch (error: unknown) {
                if (!isRecord(error) || error.code !== "EEXIST") {
                    throw error;
                }
                if (this.shouldBreakLock(lockPath)) {
                    try {
                        fs.unlinkSync(lockPath);
                    } catch {
                        // Lock owner won the race; retry.
                    }
                }
                sleepSync(this.lockRetryMs);
            }
        }
        if (fd === null) {
            throw new Error(`Timed out acquiring runtime owner registry lock at ${lockPath}`);
        }
        try {
            return fn();
        } finally {
            try {
                fs.closeSync(fd);
            } catch {
                // Best-effort close.
            }
            try {
                fs.unlinkSync(lockPath);
            } catch {
                // Best-effort unlock.
            }
        }
    }

    private shouldBreakLock(lockPath: string): boolean {
        let ageMs = 0;
        try {
            ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        } catch {
            return false;
        }
        if (ageMs < OWNER_LOCK_STALE_MS) {
            return false;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            const pid = isRecord(parsed) && typeof parsed.pid === "number" ? parsed.pid : undefined;
            if (pid === undefined) {
                return ageMs >= OWNER_LOCK_METADATALESS_STALE_MS;
            }
            return !processExists(pid);
        } catch {
            return ageMs >= OWNER_LOCK_METADATALESS_STALE_MS;
        }
    }
}
