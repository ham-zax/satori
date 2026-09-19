import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type MutationLeaseAction = 'create' | 'reindex' | 'sync' | 'clear' | 'gc';
export type MutationOperationPhase = 'accepted' | 'preflight' | 'scanning' | 'writing' | 'proving' | 'publishing' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'blocked';

export function isTerminalMutationOperationPhase(phase: MutationOperationPhase): boolean {
    return phase === 'completed' || phase === 'failed' || phase === 'blocked' || phase === 'cancelled';
}

export interface RootMutationOperation {
    id: string;
    action: MutationLeaseAction;
    canonicalRoot: string;
    generation: number;
    acceptedAt: string;
    phase: MutationOperationPhase;
    updatedAt: string;
    heartbeatAt?: string;
    progressAt?: string;
    progress?: number;
    error?: string;
    cancelRequestedAt?: string;
    cancelReason?: string;
}

export interface MutationLeaseProcessSnapshot {
    pid: number;
    processStartTime?: string;
}

export interface MutationLeaseProcessInspector {
    inspect(pid: number): MutationLeaseProcessSnapshot | null;
}

export interface RootMutationLease {
    canonicalRoot: string;
    generation: number;
    operationId: string;
    action: MutationLeaseAction;
    ownerId: string;
    pid: number;
    processStartTime?: string;
    acquiredAt: string;
    executorPid?: number;
    executorProcessStartTime?: string;
    executorProcessGroupId?: number;
}

export type MutationLeaseAcquireResult =
    | { acquired: true; lease: RootMutationLease }
    | { acquired: false; reason: 'mutation_in_progress'; activeLease: RootMutationLease };

interface MutationLeaseState {
    formatVersion: 'v1';
    canonicalRoot: string;
    generation: number;
    lease?: RootMutationLease;
}

export interface MutationLeaseCoordinatorOptions {
    stateDir?: string;
    processInspector?: MutationLeaseProcessInspector;
    currentProcess?: MutationLeaseProcessSnapshot;
    ownerId?: string;
    now?: () => number;
    lockWaitMs?: number;
    lockRetryMs?: number;
}

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleepSync(ms: number): void {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function processExists(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function processGroupExists(processGroupId: number): boolean {
    if (process.platform !== 'linux' || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
        return false;
    }
    try {
        process.kill(-processGroupId, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function resolveLinuxProcessStartTime(pid: number): string | undefined {
    if (process.platform !== 'linux') return undefined;
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = raw.lastIndexOf(')');
        if (commandEnd < 0) return undefined;
        const fieldsAfterCommand = raw.slice(commandEnd + 2).trim().split(/\s+/);
        return fieldsAfterCommand[19] || undefined;
    } catch {
        return undefined;
    }
}

class DefaultMutationLeaseProcessInspector implements MutationLeaseProcessInspector {
    inspect(pid: number): MutationLeaseProcessSnapshot | null {
        if (!processExists(pid)) return null;
        const processStartTime = resolveLinuxProcessStartTime(pid);
        return {
            pid,
            ...(processStartTime ? { processStartTime } : {}),
        };
    }
}

function canonicalizeRoot(root: string): string {
    const absolute = path.resolve(root);
    try {
        return fs.realpathSync.native(absolute);
    } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') {
            return absolute;
        }
        throw error;
    }
}

function rootKey(canonicalRoot: string): string {
    return crypto.createHash('sha256').update(canonicalRoot).digest('hex');
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
        this.name = 'MutationLeaseLostError';
    }
}

export class MutationExecutorStillActiveError extends Error {
    constructor(lease: RootMutationLease) {
        super(`Mutation executor is still live for operation '${lease.operationId}' on '${lease.canonicalRoot}'.`);
        this.name = 'MutationExecutorStillActiveError';
    }
}

export function formatMutationLeaseBlockedMessage(activeLease: RootMutationLease): string {
    return `Mutation '${activeLease.action}' is already in progress for '${activeLease.canonicalRoot}' `
        + `(operation=${activeLease.operationId}, generation=${activeLease.generation}, pid=${activeLease.pid}).`;
}

export class MutationLeaseCoordinator {
    private readonly stateDir: string;
    private readonly processInspector: MutationLeaseProcessInspector;
    private readonly currentProcess: MutationLeaseProcessSnapshot;
    private readonly ownerId: string;
    private readonly now: () => number;
    private readonly lockWaitMs: number;
    private readonly lockRetryMs: number;
    private readonly operationsByRoot = new Map<string, RootMutationOperation>();

    constructor(options: MutationLeaseCoordinatorOptions = {}) {
        this.stateDir = options.stateDir || path.join(os.homedir(), '.satori', 'runtime', 'mutation-leases');
        this.processInspector = options.processInspector || new DefaultMutationLeaseProcessInspector();
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
                    reason: 'mutation_in_progress',
                    activeLease: state.lease,
                };
            }

            const lease: RootMutationLease = {
                canonicalRoot,
                generation: state.generation + 1,
                operationId: crypto.randomUUID(),
                action,
                ownerId: this.ownerId,
                pid: this.currentProcess.pid,
                processStartTime: this.currentProcess.processStartTime,
                acquiredAt: new Date(this.now()).toISOString(),
            };
            this.writeState({
                formatVersion: 'v1',
                canonicalRoot,
                generation: lease.generation,
                lease,
            });
            this.operationsByRoot.set(canonicalRoot, {
                id: lease.operationId,
                action: lease.action,
                canonicalRoot,
                generation: lease.generation,
                acceptedAt: lease.acquiredAt,
                phase: 'accepted',
                updatedAt: lease.acquiredAt,
                heartbeatAt: lease.acquiredAt,
                progressAt: lease.acquiredAt,
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

    public listActiveLeases(): RootMutationLease[] {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(this.stateDir, { withFileTypes: true });
        } catch (error) {
            if (isRecord(error) && error.code === 'ENOENT') return [];
            throw error;
        }

        const leases: RootMutationLease[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
            const statePath = path.join(this.stateDir, entry.name);
            const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (!isRecord(parsed) || typeof parsed.canonicalRoot !== 'string') {
                throw new Error(`Invalid mutation lease state at ${statePath}`);
            }
            const canonicalRoot = canonicalizeRoot(parsed.canonicalRoot);
            if (canonicalRoot !== parsed.canonicalRoot || `${rootKey(canonicalRoot)}.json` !== entry.name) {
                throw new Error(`Mutation lease state '${statePath}' has inconsistent root ownership.`);
            }
            const lease = this.readState(canonicalRoot).lease;
            if (lease && this.isOwnerLive(lease)) leases.push(lease);
        }
        return leases.sort((left, right) => left.canonicalRoot.localeCompare(right.canonicalRoot));
    }

    public getOperation(root: string): RootMutationOperation | undefined {
        const canonicalRoot = canonicalizeRoot(root);
        return this.withRootLock(canonicalRoot, () => {
            const operation = this.operationsByRoot.get(canonicalRoot);
            if (!operation) return undefined;
            if (this.readState(canonicalRoot).generation !== operation.generation) {
                this.operationsByRoot.delete(canonicalRoot);
                return undefined;
            }
            return { ...operation };
        });
    }

    public getOperationForLease(lease: RootMutationLease): RootMutationOperation | undefined {
        const operation = this.operationsByRoot.get(lease.canonicalRoot);
        return operation
            && operation.id === lease.operationId
            && operation.generation === lease.generation
            ? { ...operation }
            : undefined;
    }

    public updateOperation(
        lease: RootMutationLease,
        phase: MutationOperationPhase,
        update: { progress?: number; error?: string } = {},
    ): RootMutationOperation {
        return this.withRootLock(lease.canonicalRoot, () => {
            const state = this.readState(lease.canonicalRoot);
            if (!sameLease(state.lease, lease)) {
                throw new MutationLeaseLostError(lease);
            }
            const current = this.requireOperationForLease(lease);
            const progress = update.progress;
            if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 100)) {
                throw new Error(`Invalid mutation operation progress '${progress}'.`);
            }
            const now = new Date(this.now()).toISOString();
            const phaseAdvanced = phase !== current.phase
                && phase !== 'cancelling'
                && phase !== 'cancelled'
                && phase !== 'failed'
                && phase !== 'blocked';
            const madeProgress = phaseAdvanced
                || (progress !== undefined && progress !== current.progress);
            const next: RootMutationOperation = {
                ...current,
                phase,
                updatedAt: now,
                heartbeatAt: now,
                progressAt: madeProgress ? now : (current.progressAt ?? current.updatedAt),
                ...(progress !== undefined ? { progress } : {}),
                ...(update.error !== undefined ? { error: update.error } : {}),
            };
            this.operationsByRoot.set(lease.canonicalRoot, next);
            return { ...next };
        });
    }

    public heartbeatOperation(lease: RootMutationLease): RootMutationOperation {
        return this.withRootLock(lease.canonicalRoot, () => {
            const state = this.readState(lease.canonicalRoot);
            if (!sameLease(state.lease, lease)) {
                throw new MutationLeaseLostError(lease);
            }
            const current = this.requireOperationForLease(lease);
            const now = new Date(this.now()).toISOString();
            const next = {
                ...current,
                updatedAt: now,
                heartbeatAt: now,
            };
            this.operationsByRoot.set(lease.canonicalRoot, next);
            return { ...next };
        });
    }

    public requestOperationCancellation(lease: RootMutationLease, reason?: string): RootMutationOperation {
        return this.withRootLock(lease.canonicalRoot, () => {
            const state = this.readState(lease.canonicalRoot);
            if (!sameLease(state.lease, lease)) {
                throw new MutationLeaseLostError(lease);
            }
            const current = this.requireOperationForLease(lease);
            if (isTerminalMutationOperationPhase(current.phase)) {
                return { ...current };
            }
            const now = new Date(this.now()).toISOString();
            const next: RootMutationOperation = {
                ...current,
                phase: 'cancelling',
                updatedAt: now,
                heartbeatAt: now,
                progressAt: current.progressAt ?? current.updatedAt,
                cancelRequestedAt: current.cancelRequestedAt ?? now,
                ...(reason !== undefined ? { cancelReason: reason } : {}),
            };
            this.operationsByRoot.set(lease.canonicalRoot, next);
            return { ...next };
        });
    }

    public attachBoundExecutor(
        root: string,
        operationId: string,
        action: MutationLeaseAction,
    ): RootMutationLease {
        const canonicalRoot = canonicalizeRoot(root);
        return this.withRootLock(canonicalRoot, () => {
            const state = this.readState(canonicalRoot);
            const lease = state.lease;
            const currentProcessStartTime = this.currentProcess.processStartTime;
            if (
                !lease
                || lease.operationId !== operationId
                || lease.action !== action
                || lease.executorPid !== this.currentProcess.pid
                || lease.executorProcessGroupId !== this.currentProcess.pid
                || !lease.executorProcessStartTime
                || !currentProcessStartTime
                || lease.executorProcessStartTime !== currentProcessStartTime
                || !this.isExecutorLive(lease)
            ) {
                throw new Error(
                    `Mutation executor ${this.currentProcess.pid} is not the bound live owner of operation '${operationId}' for '${canonicalRoot}'.`,
                );
            }

            const now = new Date(this.now()).toISOString();
            this.operationsByRoot.set(canonicalRoot, {
                id: lease.operationId,
                action: lease.action,
                canonicalRoot,
                generation: lease.generation,
                acceptedAt: lease.acquiredAt,
                phase: 'accepted',
                updatedAt: now,
                heartbeatAt: now,
                progressAt: now,
            });
            return { ...lease };
        });
    }

    public bindExecutor(
        lease: RootMutationLease,
        executor: { pid: number; processGroupId?: number },
    ): RootMutationLease {
        if (!Number.isSafeInteger(executor.pid) || executor.pid <= 0) {
            throw new Error(`Invalid mutation executor pid '${executor.pid}'.`);
        }
        if (
            executor.processGroupId !== undefined
            && (!Number.isSafeInteger(executor.processGroupId) || executor.processGroupId <= 0)
        ) {
            throw new Error(`Invalid mutation executor process group '${executor.processGroupId}'.`);
        }
        const snapshot = this.processInspector.inspect(executor.pid);
        if (!snapshot) {
            throw new Error(`Mutation executor pid ${executor.pid} is not live.`);
        }
        return this.withRootLock(lease.canonicalRoot, () => {
            const state = this.readState(lease.canonicalRoot);
            if (!sameLease(state.lease, lease) || !state.lease) {
                throw new MutationLeaseLostError(lease);
            }
            if (
                state.lease.executorPid !== undefined
                && state.lease.executorPid !== executor.pid
                && this.isExecutorLive(state.lease)
            ) {
                throw new MutationExecutorStillActiveError(state.lease);
            }
            const nextLease: RootMutationLease = {
                ...state.lease,
                executorPid: executor.pid,
                ...(snapshot.processStartTime ? { executorProcessStartTime: snapshot.processStartTime } : {}),
                ...(executor.processGroupId !== undefined ? { executorProcessGroupId: executor.processGroupId } : {}),
            };
            this.writeState({
                formatVersion: 'v1',
                canonicalRoot: state.canonicalRoot,
                generation: state.generation,
                lease: nextLease,
            });
            return { ...nextLease };
        });
    }

    /** State is atomically replaced, so this lock-free observation sees one complete generation. */
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
            if (state.lease && this.isExecutorLive(state.lease)) {
                throw new MutationExecutorStillActiveError(state.lease);
            }
            this.writeState({
                formatVersion: 'v1',
                canonicalRoot: state.canonicalRoot,
                generation: state.generation,
            });
            const operation = this.operationsByRoot.get(lease.canonicalRoot);
            if (
                operation
                && operation.id === lease.operationId
                && operation.generation === lease.generation
                && operation.phase !== 'completed'
                && operation.phase !== 'failed'
                && operation.phase !== 'blocked'
                && operation.phase !== 'cancelled'
            ) {
                this.operationsByRoot.delete(lease.canonicalRoot);
            }
            return true;
        });
    }

    private isOwnerLive(lease: RootMutationLease): boolean {
        const current = this.processInspector.inspect(lease.pid);
        if (current && (
            !lease.processStartTime
            || !current.processStartTime
            || lease.processStartTime === current.processStartTime
        )) {
            return true;
        }
        return this.isExecutorLive(lease);
    }

    private isExecutorLive(lease: RootMutationLease): boolean {
        if (lease.executorPid !== undefined) {
            const current = this.processInspector.inspect(lease.executorPid);
            if (current) {
                if (
                    lease.executorProcessStartTime
                    && current.processStartTime
                    && lease.executorProcessStartTime !== current.processStartTime
                ) {
                    return false;
                }
                return true;
            }
        }
        return lease.executorProcessGroupId !== undefined
            && processGroupExists(lease.executorProcessGroupId);
    }

    private requireOperationForLease(lease: RootMutationLease): RootMutationOperation {
        const operation = this.operationsByRoot.get(lease.canonicalRoot);
        if (!operation || operation.id !== lease.operationId || operation.generation !== lease.generation) {
            throw new Error(`Live operation state is unavailable for mutation '${lease.operationId}'.`);
        }
        return operation;
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
            return { formatVersion: 'v1', canonicalRoot, generation: 0 };
        }
        const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (
            !isRecord(parsed)
            || parsed.formatVersion !== 'v1'
            || parsed.canonicalRoot !== canonicalRoot
            || typeof parsed.generation !== 'number'
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
            formatVersion: 'v1',
            canonicalRoot,
            generation: parsed.generation,
            lease,
        };
    }

    private isLeaseRecord(value: unknown, canonicalRoot: string): value is RootMutationLease {
        return isRecord(value)
            && value.canonicalRoot === canonicalRoot
            && typeof value.generation === 'number'
            && Number.isSafeInteger(value.generation)
            && value.generation > 0
            && typeof value.operationId === 'string'
            && ['create', 'reindex', 'sync', 'clear', 'gc'].includes(String(value.action))
            && typeof value.ownerId === 'string'
            && typeof value.pid === 'number'
            && Number.isSafeInteger(value.pid)
            && value.pid > 0
            && (value.processStartTime === undefined || typeof value.processStartTime === 'string')
            && typeof value.acquiredAt === 'string'
            && (value.executorPid === undefined || (
                typeof value.executorPid === 'number'
                && Number.isSafeInteger(value.executorPid)
                && value.executorPid > 0
            ))
            && (value.executorProcessStartTime === undefined || typeof value.executorProcessStartTime === 'string')
            && (value.executorProcessGroupId === undefined || (
                typeof value.executorProcessGroupId === 'number'
                && Number.isSafeInteger(value.executorProcessGroupId)
                && value.executorProcessGroupId > 0
            ));
    }

    private fsyncDirectory(directoryPath: string): void {
        const descriptor = fs.openSync(directoryPath, 'r');
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }

    private writeState(state: MutationLeaseState): void {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const target = this.statePath(state.canonicalRoot);
        const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        let descriptor: number | null = null;
        try {
            descriptor = fs.openSync(temp, 'wx');
            fs.writeFileSync(descriptor, JSON.stringify(state, null, 2));
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = null;
            fs.renameSync(temp, target);
            this.fsyncDirectory(this.stateDir);
        } finally {
            if (descriptor !== null) {
                try { fs.closeSync(descriptor); } catch { /* Best-effort close. */ }
            }
            try { fs.rmSync(temp, { force: true }); } catch { /* Best-effort cleanup. */ }
        }
    }

    private withRootLock<T>(canonicalRoot: string, fn: () => T): T {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const lockPath = this.lockPath(canonicalRoot);
        const deadline = Date.now() + this.lockWaitMs;
        let descriptor: number | null = null;
        while (Date.now() <= deadline) {
            try {
                descriptor = fs.openSync(lockPath, 'wx');
                fs.writeFileSync(descriptor, JSON.stringify({
                    pid: this.currentProcess.pid,
                    processStartTime: this.currentProcess.processStartTime,
                    acquiredAt: new Date().toISOString(),
                }));
                break;
            } catch (error) {
                if (!isRecord(error) || error.code !== 'EEXIST') throw error;
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
        if (descriptor === null) {
            throw new Error(`Timed out acquiring mutation lease state lock at ${lockPath}`);
        }
        try {
            return fn();
        } finally {
            try {
                fs.closeSync(descriptor);
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
            const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (!isRecord(parsed) || typeof parsed.pid !== 'number') return false;
            const current = this.processInspector.inspect(parsed.pid);
            if (!current) return true;
            return typeof parsed.processStartTime === 'string'
                && typeof current.processStartTime === 'string'
                && parsed.processStartTime !== current.processStartTime;
        } catch {
            return false;
        }
    }
}
