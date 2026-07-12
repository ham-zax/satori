import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    DefaultProcessInspector,
    type ProcessInspector,
    type ProcessSnapshot,
} from "./runtime-owner.js";

export type MutationLeaseAction = "create" | "reindex" | "sync" | "repair" | "clear";
export type MutationLeaseProcessInspector = ProcessInspector;
export type MutationLeaseProcessSnapshot = ProcessSnapshot;

export interface RootMutationLease {
    canonicalRoot: string;
    generation: number;
    operationId: string;
    action: MutationLeaseAction;
    ownerId: string;
    pid: number;
    processStartTime?: string;
    acquiredAt: string;
}

export type MutationLeaseAcquireResult =
    | { acquired: true; lease: RootMutationLease }
    | { acquired: false; reason: "mutation_in_progress"; activeLease: RootMutationLease };

interface MutationLeaseState {
    formatVersion: "v1";
    canonicalRoot: string;
    generation: number;
    lease?: RootMutationLease;
}

interface MutationLeaseCoordinatorOptions {
    stateDir?: string;
    processInspector?: ProcessInspector;
    currentProcess?: ProcessSnapshot;
    ownerId?: string;
    now?: () => number;
    lockWaitMs?: number;
    lockRetryMs?: number;
}

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleepSync(ms: number): void {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function canonicalizeRoot(root: string): string {
    const absolute = path.resolve(root);
    try {
        return fs.realpathSync.native(absolute);
    } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
            return absolute;
        }
        throw error;
    }
}

function rootKey(canonicalRoot: string): string {
    return crypto.createHash("sha256").update(canonicalRoot).digest("hex");
}

function sameLease(left: RootMutationLease | undefined, right: RootMutationLease): boolean {
    return Boolean(
        left
        && left.canonicalRoot === right.canonicalRoot
        && left.generation === right.generation
        && left.operationId === right.operationId
        && left.ownerId === right.ownerId
        && left.pid === right.pid
        && left.processStartTime === right.processStartTime
    );
}

export class MutationLeaseLostError extends Error {
    constructor(lease: RootMutationLease) {
        super(`Mutation lease generation ${lease.generation} is no longer current for '${lease.canonicalRoot}'.`);
        this.name = "MutationLeaseLostError";
    }
}

export function formatMutationLeaseBlockedMessage(activeLease: RootMutationLease): string {
    return `Mutation '${activeLease.action}' is already in progress for '${activeLease.canonicalRoot}' `
        + `(operation=${activeLease.operationId}, generation=${activeLease.generation}, pid=${activeLease.pid}). `
        + "Use manage_index status to observe the current lifecycle state.";
}

export class MutationLeaseCoordinator {
    private readonly stateDir: string;
    private readonly processInspector: ProcessInspector;
    private readonly currentProcess: ProcessSnapshot;
    private readonly ownerId: string;
    private readonly now: () => number;
    private readonly lockWaitMs: number;
    private readonly lockRetryMs: number;

    constructor(options: MutationLeaseCoordinatorOptions = {}) {
        this.stateDir = options.stateDir || path.join(os.homedir(), ".satori", "runtime", "mutation-leases");
        this.processInspector = options.processInspector || new DefaultProcessInspector();
        this.currentProcess = options.currentProcess
            || this.processInspector.inspect(process.pid)
            || { pid: process.pid };
        this.ownerId = options.ownerId || crypto.randomUUID();
        this.now = options.now || (() => Date.now());
        this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
        this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
    }

    public acquire(root: string, action: MutationLeaseAction): MutationLeaseAcquireResult {
        const canonicalRoot = canonicalizeRoot(root);
        return this.withRootLock(canonicalRoot, () => {
            const state = this.readState(canonicalRoot);
            if (state.lease && this.isOwnerLive(state.lease)) {
                return {
                    acquired: false,
                    reason: "mutation_in_progress",
                    activeLease: state.lease,
                };
            }

            const now = new Date(this.now()).toISOString();
            const lease: RootMutationLease = {
                canonicalRoot,
                generation: state.generation + 1,
                operationId: crypto.randomUUID(),
                action,
                ownerId: this.ownerId,
                pid: this.currentProcess.pid,
                processStartTime: this.currentProcess.processStartTime,
                acquiredAt: now,
            };
            this.writeState({
                formatVersion: "v1",
                canonicalRoot,
                generation: lease.generation,
                lease,
            });
            return { acquired: true, lease };
        });
    }

    public isCurrent(lease: RootMutationLease): boolean {
        return this.withRootLock(lease.canonicalRoot, () => {
            const state = this.readState(lease.canonicalRoot);
            return sameLease(state.lease, lease);
        });
    }

    public getActiveLease(root: string): RootMutationLease | undefined {
        const canonicalRoot = canonicalizeRoot(root);
        return this.withRootLock(canonicalRoot, () => {
            const lease = this.readState(canonicalRoot).lease;
            return lease && this.isOwnerLive(lease) ? lease : undefined;
        });
    }

    /**
     * Lock-free read observation for readiness-cache invalidation. State files are
     * published by atomic rename, so readers see either the prior or next complete
     * generation. Malformed state throws and callers must fail closed.
     */
    public observe(root: string): { generation: number; mutationActive: boolean } {
        const canonicalRoot = canonicalizeRoot(root);
        const state = this.readState(canonicalRoot);
        return {
            generation: state.generation,
            mutationActive: Boolean(state.lease && this.isOwnerLive(state.lease)),
        };
    }

    public assertCurrent(lease: RootMutationLease): void {
        if (!this.isCurrent(lease)) {
            throw new MutationLeaseLostError(lease);
        }
    }

    public publishWhileCurrent(lease: RootMutationLease, publish: () => void): void {
        this.withRootLock(lease.canonicalRoot, () => {
            const state = this.readState(lease.canonicalRoot);
            if (!sameLease(state.lease, lease)) {
                throw new MutationLeaseLostError(lease);
            }
            publish();
        });
    }

    public isLeaseForRoot(lease: RootMutationLease, root: string): boolean {
        return lease.canonicalRoot === canonicalizeRoot(root);
    }

    public release(lease: RootMutationLease): boolean {
        return this.withRootLock(lease.canonicalRoot, () => {
            const state = this.readState(lease.canonicalRoot);
            if (!sameLease(state.lease, lease)) {
                return false;
            }
            this.writeState({
                formatVersion: "v1",
                canonicalRoot: state.canonicalRoot,
                generation: state.generation,
            });
            return true;
        });
    }

    /**
     * Liveness is process identity, not lease age.
     * - Dead PID => not live.
     * - When both sides have processStartTime and they differ => PID reuse, not live.
     * - When start-time evidence is missing, a live PID is treated as the owner
     *   (fail-closed for writer safety). On non-Linux systems start-time is often
     *   unavailable; operators may need to stop the listed PID or clear an abandoned
     *   lease file after confirming no Satori writer holds the root.
     * - acquiredAt is diagnostic only; wall-clock age never evicts a live owner.
     */
    private isOwnerLive(lease: RootMutationLease): boolean {
        const current = this.processInspector.inspect(lease.pid);
        if (!current) {
            return false;
        }
        if (
            lease.processStartTime
            && current.processStartTime
            && lease.processStartTime !== current.processStartTime
        ) {
            return false;
        }
        return true;
    }

    private statePath(canonicalRoot: string): string {
        return path.join(this.stateDir, `${rootKey(canonicalRoot)}.json`);
    }

    private lockPath(canonicalRoot: string): string {
        return path.join(this.stateDir, `${rootKey(canonicalRoot)}.lock`);
    }

    private readState(canonicalRoot: string): MutationLeaseState {
        const statePath = this.statePath(canonicalRoot);
        if (!fs.existsSync(statePath)) {
            return { formatVersion: "v1", canonicalRoot, generation: 0 };
        }
        const parsed: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
        if (
            !isRecord(parsed)
            || parsed.formatVersion !== "v1"
            || parsed.canonicalRoot !== canonicalRoot
            || typeof parsed.generation !== "number"
            || !Number.isSafeInteger(parsed.generation)
            || parsed.generation < 0
        ) {
            throw new Error(`Invalid mutation lease state at ${statePath}`);
        }
        const lease = parsed.lease;
        if (lease !== undefined && !this.isLeaseRecord(lease, canonicalRoot)) {
            throw new Error(`Invalid mutation lease record at ${statePath}`);
        }
        return {
            formatVersion: "v1",
            canonicalRoot,
            generation: parsed.generation,
            lease,
        };
    }

    private isLeaseRecord(value: unknown, canonicalRoot: string): value is RootMutationLease {
        return isRecord(value)
            && value.canonicalRoot === canonicalRoot
            && typeof value.generation === "number"
            && Number.isSafeInteger(value.generation)
            && typeof value.operationId === "string"
            && ["create", "reindex", "sync", "repair", "clear"].includes(String(value.action))
            && typeof value.ownerId === "string"
            && typeof value.pid === "number"
            && (value.processStartTime === undefined || typeof value.processStartTime === "string")
            && typeof value.acquiredAt === "string";
    }

    private writeState(state: MutationLeaseState): void {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const target = this.statePath(state.canonicalRoot);
        const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(state, null, 2));
        fs.renameSync(temp, target);
    }

    private withRootLock<T>(canonicalRoot: string, fn: () => T): T {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const lockPath = this.lockPath(canonicalRoot);
        const deadline = Date.now() + this.lockWaitMs;
        let fd: number | null = null;
        while (Date.now() <= deadline) {
            try {
                fd = fs.openSync(lockPath, "wx");
                fs.writeFileSync(fd, JSON.stringify({
                    pid: this.currentProcess.pid,
                    processStartTime: this.currentProcess.processStartTime,
                    acquiredAt: new Date().toISOString(),
                }));
                break;
            } catch (error) {
                if (!isRecord(error) || error.code !== "EEXIST") {
                    throw error;
                }
                if (this.shouldBreakLock(lockPath)) {
                    try {
                        fs.unlinkSync(lockPath);
                    } catch {
                        // Another contender resolved the stale mutex first.
                    }
                }
                sleepSync(this.lockRetryMs);
            }
        }
        if (fd === null) {
            throw new Error(`Timed out acquiring mutation lease state lock at ${lockPath}`);
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
        try {
            if (Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_STALE_MS) {
                return false;
            }
            const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (!isRecord(parsed) || typeof parsed.pid !== "number") {
                return false;
            }
            const current = this.processInspector.inspect(parsed.pid);
            if (!current) {
                return true;
            }
            return typeof parsed.processStartTime === "string"
                && typeof current.processStartTime === "string"
                && parsed.processStartTime !== current.processStartTime;
        } catch {
            return false;
        }
    }
}
