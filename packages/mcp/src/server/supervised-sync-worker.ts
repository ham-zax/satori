import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { perfTrace } from "@satori-code/core";
import type {
    MutationOperationPhase,
    RootMutationActivity,
    RootMutationExecution,
    RootMutationRuntime,
} from "@satori-code/core/integration";
import type { SyncWorkerResult } from "../core/sync.js";
import {
    spawnSupervisedMutationWorker,
    type MutationWorkerProgress,
    type SupervisedMutationWorker,
} from "./mutation-worker-supervisor.js";

// This is a quiet-window deadline, not a total-runtime ceiling; heartbeats do not reset it.
const SYNC_NO_PROGRESS_TIMEOUT_MS = 30 * 60 * 1000;

export const TERMINAL_OPERATION_PHASES: ReadonlySet<MutationOperationPhase> = new Set<MutationOperationPhase>([
    "completed",
    "failed",
    "blocked",
    "cancelled",
]);

export type StartedSyncWorker = Readonly<{
    boundActivity: RootMutationActivity;
    completion: Promise<SyncWorkerResult>;
}>;

function resolveMutationSyncWorkerPath(): string {
    const built = fileURLToPath(new URL("./mutation-sync-worker.js", import.meta.url));
    if (fs.existsSync(built)) return built;
    return fileURLToPath(new URL("./mutation-sync-worker.ts", import.meta.url));
}

function parseStats(value: unknown): SyncWorkerResult["stats"] {
    if (!value || typeof value !== "object") return undefined;
    const { added, removed, modified } = value as Record<string, unknown>;
    if (typeof added !== "number" || typeof removed !== "number" || typeof modified !== "number") return undefined;
    return { added, removed, modified };
}

type SyncWorkerHandlers = Readonly<{
    onHeartbeat(): void;
    onProgress(progress: MutationWorkerProgress): void;
    onNoProgress(): void;
    onCompleted(result?: Readonly<Record<string, unknown>>): void;
}>;

/**
 * One sync worker process. Its callbacks dispatch to handlers attached when
 * an execution takes it, so a worker can be spawned before its execution
 * exists (the standby). Events before attachment are dropped: a standby
 * sends no progress before start.
 */
type SyncWorkerProcess = Readonly<{
    codebasePath: string;
    worker: SupervisedMutationWorker;
    attach(handlers: SyncWorkerHandlers, signal: AbortSignal): void;
    isSettled(): boolean;
}>;

function spawnSyncWorkerProcess(
    codebasePath: string,
    workerId: string,
    workerPath: string = resolveMutationSyncWorkerPath(),
): SyncWorkerProcess {
    let handlers: SyncWorkerHandlers | undefined;
    let settled = false;
    const controller = new AbortController();
    const worker = spawnSupervisedMutationWorker({
        operationId: workerId,
        workerPath,
        workerArgs: [JSON.stringify({ path: codebasePath })],
        signal: controller.signal,
        noProgressTimeoutMs: SYNC_NO_PROGRESS_TIMEOUT_MS,
        onHeartbeat: () => handlers?.onHeartbeat(),
        onProgress: (progress) => handlers?.onProgress(progress),
        onNoProgress: () => handlers?.onNoProgress(),
        onCompleted: (result) => handlers?.onCompleted(result),
    });
    void worker.completion.catch(() => undefined).finally(() => {
        settled = true;
    });
    return Object.freeze({
        codebasePath,
        worker,
        attach: (next: SyncWorkerHandlers, signal: AbortSignal) => {
            handlers = next;
            const abort = () => controller.abort(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
        },
        isSettled: () => settled,
    });
}

/**
 * Owns at most one pre-started sync worker per host, for the root with the
 * latest watch or sync activity. The standby bootstraps and preloads the
 * current Publication's navigation state, then waits for `start`; it still
 * exits after its one sync, so the process-group completion fence that
 * releases the bound executor lease is unchanged.
 */
export class SyncWorkerStandby {
    private standby: SyncWorkerProcess | undefined;
    private readonly retiring = new Map<SyncWorkerProcess, Promise<void>>();
    private pendingRoot: string | undefined;
    private closed = false;

    /** `workerPath` overrides the sync worker entry point (tests only). */
    constructor(private readonly options: Readonly<{ workerPath?: string }> = {}) {}

    /** Ensures a standby exists for `codebasePath`, replacing another root's. */
    prepare(codebasePath: string): void {
        if (this.closed) return;
        const current = this.standby;
        if (current && current.codebasePath === codebasePath && !current.isSettled()) return;
        if (current) this.discard(current, "sync_standby_replaced");
        this.pendingRoot = codebasePath;
        this.startPending();
    }

    private startPending(): void {
        if (this.closed || this.standby || this.retiring.size > 0 || this.pendingRoot === undefined) return;
        const codebasePath = this.pendingRoot;
        this.pendingRoot = undefined;
        try {
            this.standby = spawnSyncWorkerProcess(codebasePath, `standby-${randomUUID()}`, this.options.workerPath);
        } catch (error) {
            this.standby = undefined;
            console.warn(`[SYNC-STANDBY] Could not pre-start a sync worker for '${codebasePath}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Stops the standby when it belongs to `codebasePath`. */
    async release(codebasePath: string): Promise<void> {
        if (this.pendingRoot === codebasePath) this.pendingRoot = undefined;
        const current = this.standby;
        if (current?.codebasePath === codebasePath) this.discard(current, "sync_standby_released");
        await Promise.all([...this.retiring].filter(([process]) => process.codebasePath === codebasePath)
            .map(([, completion]) => completion));
    }

    /** Hands the standby for `codebasePath` to one execution, if it is live. */
    take(codebasePath: string): SyncWorkerProcess | undefined {
        const current = this.standby;
        if (!current || current.codebasePath !== codebasePath) return undefined;
        this.standby = undefined;
        if (current.isSettled()) return undefined;
        return current;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.pendingRoot = undefined;
        const current = this.standby;
        if (current) this.discard(current, "sync_standby_shutdown");
        await Promise.all(this.retiring.values());
    }

    private discard(standby: SyncWorkerProcess, reason: string): void {
        if (this.standby === standby) this.standby = undefined;
        if (this.retiring.has(standby)) return;
        const completion = standby.worker.completion.then(() => undefined, () => undefined);
        this.retiring.set(standby, completion);
        void completion.then(() => {
            this.retiring.delete(standby);
            this.startPending();
        });
        standby.worker.requestCancellation(reason);
    }
}

/**
 * Runs one incremental sync for `execution` in a supervised child process.
 *
 * The child binds to the parent's root mutation lease, so the lease stays with
 * this process while all sync memory lives, and is returned to the OS, in the
 * child. Resolves once the child is bound and started. A live standby for
 * the root is used when present; otherwise a fresh worker is spawned.
 */
export async function startSupervisedSyncWorker(input: Readonly<{
    codebasePath: string;
    execution: RootMutationExecution;
    mutationRuntime: RootMutationRuntime;
    standby?: Pick<SyncWorkerStandby, "take">;
}>): Promise<StartedSyncWorker> {
    const { codebasePath, execution, mutationRuntime } = input;
    const startedAt = performance.now();
    let terminalAt: number | undefined;
    let terminalPhase: SyncWorkerResult["terminalPhase"];
    let terminalProgress: number | undefined;
    let completedResult: Readonly<Record<string, unknown>> | undefined;
    const handlers: SyncWorkerHandlers = {
        onHeartbeat: () => {
            const operation = mutationRuntime.getCurrentOperation(codebasePath);
            if (operation?.id === execution.id && !TERMINAL_OPERATION_PHASES.has(operation.phase)) {
                execution.heartbeat();
            }
        },
        onProgress: (progress) => {
            if (progress.phase && TERMINAL_OPERATION_PHASES.has(progress.phase)) {
                if (progress.phase === "completed" || progress.phase === "blocked") {
                    terminalPhase = progress.phase;
                    terminalProgress = progress.progress;
                }
                return;
            }
            const operation = mutationRuntime.getCurrentOperation(codebasePath);
            if (
                !operation
                || operation.id !== execution.id
                || operation.phase === "cancelling"
                || TERMINAL_OPERATION_PHASES.has(operation.phase)
            ) {
                return;
            }
            execution.update(
                progress.phase ?? operation.phase,
                progress.progress !== undefined ? { progress: progress.progress } : {},
            );
        },
        onNoProgress: () => {
            mutationRuntime.requestCancellation(execution.id, "sync_no_progress_timeout");
        },
        onCompleted: (result) => {
            terminalAt = performance.now();
            completedResult = result;
        },
    };

    const bindAndStart = async (process: SyncWorkerProcess): Promise<RootMutationActivity> => {
        process.attach(handlers, execution.signal);
        const { worker } = process;
        try {
            await worker.ready;
            if (execution.signal.aborted) {
                throw execution.signal.reason ?? new Error("Sync cancelled before executor binding.");
            }
            const boundActivity = execution.bindExecutor(worker.executor);
            perfTrace("sync.parent.worker_ready", performance.now() - startedAt, { operationId: execution.id });
            worker.start(execution.id);
            return boundActivity;
        } catch (error) {
            worker.requestCancellation("sync_startup_failed");
            await worker.completion.catch(() => undefined);
            throw error;
        }
    };

    let syncProcess = input.standby?.take(codebasePath);
    let boundActivity: RootMutationActivity;
    if (syncProcess) {
        try {
            boundActivity = await bindAndStart(syncProcess);
            perfTrace("sync.parent.standby_used", performance.now() - startedAt, { operationId: execution.id });
        } catch (error) {
            // A standby that failed before binding never held the lease: fall
            // back to a fresh worker unless the execution itself was cancelled.
            if (execution.signal.aborted) throw error;
            syncProcess = spawnSyncWorkerProcess(codebasePath, execution.id);
            boundActivity = await bindAndStart(syncProcess);
        }
    } else {
        syncProcess = spawnSyncWorkerProcess(codebasePath, execution.id);
        boundActivity = await bindAndStart(syncProcess);
    }

    return {
        boundActivity,
        completion: syncProcess.worker.completion.then(() => ({
            ...(terminalPhase ? { terminalPhase } : {}),
            ...(terminalProgress !== undefined ? { terminalProgress } : {}),
            ...(typeof completedResult?.mode === "string" ? { mode: completedResult.mode } : {}),
            ...(parseStats(completedResult?.stats) ? { stats: parseStats(completedResult?.stats) } : {}),
        })).finally(() => {
            const completedAt = performance.now();
            perfTrace("sync.parent.worker_round_trip", completedAt - startedAt, { operationId: execution.id });
            if (terminalAt !== undefined) {
                perfTrace("sync.parent.worker_quiescence", completedAt - terminalAt, { operationId: execution.id });
            }
        }),
    };
}
