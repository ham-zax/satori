import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import type { MutationOperationPhase, RootMutationExecutor } from "@zokizuan/satori-core/integration";

const MUTATION_OPERATION_ID_ENV = "SATORI_MUTATION_OPERATION_ID";
const MUTATION_PARENT_PID_ENV = "SATORI_MUTATION_PARENT_PID";
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 25;
const PARENT_WATCHDOG_MS = 1_000;
const MAX_COMPLETION_RESULT_BYTES = 64 * 1024;
const MUTATION_OPERATION_PHASES = new Set<MutationOperationPhase>([
    "accepted",
    "preflight",
    "scanning",
    "writing",
    "proving",
    "publishing",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
    "blocked",
]);
const CONTAINMENT_WATCHDOG_SOURCE = String.raw`
const fs = require("node:fs");
const parentPid = Number(process.argv[1]);
const expectedParentStart = process.argv[2];
const processGroupId = Number(process.argv[3]);
function startTime(pid) {
    try {
        const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
        const close = raw.lastIndexOf(")");
        if (close < 0) return undefined;
        const fields = raw.slice(close + 2).trim().split(/\s+/);
        return fields[19];
    } catch {
        return undefined;
    }
}
function groupLive() {
    try {
        process.kill(-processGroupId, 0);
        return true;
    } catch (error) {
        return error && error.code === "EPERM";
    }
}
function killGroup() {
    try {
        process.kill(-processGroupId, "SIGKILL");
    } catch (error) {
        if (!error || error.code !== "ESRCH") process.exit(2);
    }
}
let parentLost = false;
const timer = setInterval(() => {
    if (!groupLive()) process.exit(0);
    if (!parentLost && startTime(parentPid) !== expectedParentStart) parentLost = true;
    if (parentLost) killGroup();
}, 100);
process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
});
`;

type ParentMessage =
    | { type: "mutation_worker_start"; operationId: string }
    | { type: "mutation_worker_cancel"; operationId: string; reason?: string };

type WorkerMessage =
    | { type: "mutation_worker_ready"; operationId: string }
    | { type: "mutation_worker_heartbeat"; operationId: string }
    | {
        type: "mutation_worker_progress";
        operationId: string;
        sequence: number;
        phase?: MutationOperationPhase;
        progress?: number;
    }
    | {
        type: "mutation_worker_completed";
        operationId: string;
        result?: Readonly<Record<string, unknown>>;
    }
    | { type: "mutation_worker_cancelled"; operationId: string; reason?: string }
    | { type: "mutation_worker_failed"; operationId: string; error: string };

type WorkerTerminalMessage = Extract<WorkerMessage, {
    type: "mutation_worker_completed" | "mutation_worker_cancelled" | "mutation_worker_failed";
}>;

export type MutationWorkerProgress = Readonly<{
    sequence: number;
    phase?: MutationOperationPhase;
    progress?: number;
}>;

export type SupervisedMutationWorkerOptions = Readonly<{
    operationId: string;
    workerPath: string;
    workerArgs?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    noProgressTimeoutMs?: number;
    cancelGraceMs?: number;
    onHeartbeat?: () => void;
    onProgress?: (progress: MutationWorkerProgress) => void;
    onNoProgress?: () => void;
    onCompleted?: (result?: Readonly<Record<string, unknown>>) => void;
}>;

export type SupervisedMutationWorker = Readonly<{
    executor: RootMutationExecutor;
    ready: Promise<void>;
    completion: Promise<void>;
    start(): void;
    requestCancellation(reason?: string): boolean;
}>;

export class MutationWorkerCancelledError extends Error {
    constructor(
        readonly operationId: string,
        readonly reason?: string,
    ) {
        super(reason
            ? `Mutation worker '${operationId}' was cancelled: ${reason}`
            : `Mutation worker '${operationId}' was cancelled.`);
        this.name = "MutationWorkerCancelledError";
    }
}

export class MutationWorkerFailureError extends Error {
    constructor(
        readonly operationId: string,
        message: string,
    ) {
        super(message);
        this.name = "MutationWorkerFailureError";
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function linuxProcessStartTime(pid: number): string {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) throw new Error(`Unable to read Linux process start time for pid ${pid}.`);
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime) throw new Error(`Unable to read Linux process start time for pid ${pid}.`);
    return startTime;
}

function isProcessGroupLive(processGroupId: number): boolean {
    try {
        process.kill(-processGroupId, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function killProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-processGroupId, signal);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
}

async function forceAndProveProcessGroupQuiescence(processGroupId: number): Promise<void> {
    while (isProcessGroupLive(processGroupId)) {
        try {
            killProcessGroup(processGroupId, "SIGKILL");
        } catch {
            // Fail closed: keep the supervisor and durable executor fence alive
            // until the process group can actually be proven absent.
        }
        await delay(PROCESS_GROUP_POLL_MS);
    }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string" || typeof record.operationId !== "string") return false;
    switch (record.type) {
        case "mutation_worker_ready":
        case "mutation_worker_heartbeat":
            return true;
        case "mutation_worker_completed": {
            if (record.result === undefined) return true;
            if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) return false;
            try {
                return Buffer.byteLength(JSON.stringify(record.result), "utf8") <= MAX_COMPLETION_RESULT_BYTES;
            } catch {
                return false;
            }
        }
        case "mutation_worker_progress":
            return Number.isSafeInteger(record.sequence)
                && (record.sequence as number) >= 0
                && (record.phase === undefined || (
                    typeof record.phase === "string"
                    && MUTATION_OPERATION_PHASES.has(record.phase as MutationOperationPhase)
                ))
                && (record.progress === undefined || (
                    typeof record.progress === "number"
                    && Number.isFinite(record.progress)
                    && record.progress >= 0
                    && record.progress <= 100
                ));
        case "mutation_worker_cancelled":
            return record.reason === undefined || typeof record.reason === "string";
        case "mutation_worker_failed":
            return typeof record.error === "string";
        default:
            return false;
    }
}

function sourceCancellationReason(signal: AbortSignal | undefined): string | undefined {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason.message;
    if (typeof reason === "string" && reason.trim()) return reason;
    return undefined;
}

/**
 * Spawn one mutation worker in its own Linux process group. The worker cannot
 * begin mutation work until the caller observes `ready`, binds `executor` to
 * the current RootMutationExecution, and calls `start()`.
 *
 * `completion` settles only after the worker process group is proven absent.
 * This is the fence RootMutationRuntime relies on before releasing a bound
 * executor lease.
 */
export function spawnSupervisedMutationWorker(
    options: SupervisedMutationWorkerOptions,
): SupervisedMutationWorker {
    if (process.platform !== "linux") {
        throw new MutationWorkerFailureError(
            options.operationId,
            "Supervised mutation workers require Linux process-group containment.",
        );
    }
    if (!options.operationId.trim()) {
        throw new Error("Mutation worker operationId must be non-empty.");
    }
    if (
        options.noProgressTimeoutMs !== undefined
        && (!Number.isFinite(options.noProgressTimeoutMs) || options.noProgressTimeoutMs <= 0)
    ) {
        throw new Error("Mutation worker noProgressTimeoutMs must be positive when provided.");
    }
    const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    if (!Number.isFinite(cancelGraceMs) || cancelGraceMs < 0) {
        throw new Error("Mutation worker cancelGraceMs must be non-negative.");
    }

    const parentStartTime = linuxProcessStartTime(process.pid);
    const worker = fork(options.workerPath, [...(options.workerArgs ?? [])], {
        cwd: options.cwd,
        env: {
            ...process.env,
            ...options.env,
            [MUTATION_OPERATION_ID_ENV]: options.operationId,
            [MUTATION_PARENT_PID_ENV]: String(process.pid),
        },
        detached: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    });
    if (!worker.pid) {
        throw new MutationWorkerFailureError(options.operationId, "Mutation worker did not expose a process id.");
    }
    const executor = Object.freeze({
        pid: worker.pid,
        processGroupId: worker.pid,
    });
    const containmentWatchdog = spawn(process.execPath, [
        "-e",
        CONTAINMENT_WATCHDOG_SOURCE,
        String(process.pid),
        parentStartTime,
        String(executor.processGroupId),
    ], {
        detached: true,
        stdio: "ignore",
    });
    containmentWatchdog.unref();

    let workerReadySeen = false;
    let watchdogReady = false;
    let readyResolved = false;
    let readyFailed = false;
    let workerExitSeen = false;
    let started = false;
    let cancelRequested = false;
    let cancelReason: string | undefined;
    let forced = false;
    let containmentViolation = false;
    let terminalMessage: WorkerTerminalMessage | undefined;
    let lastProgressSequence = -1;
    let noProgressTimer: NodeJS.Timeout | undefined;
    let cancelTimer: NodeJS.Timeout | undefined;
    let sourceAbortListener: (() => void) | undefined;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    let completionSettled = false;

    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    const resolveReadyIfContained = (): void => {
        if (readyResolved || readyFailed || !workerReadySeen || !watchdogReady) return;
        readyResolved = true;
        resolveReady();
    };
    const failReadiness = (error: unknown): void => {
        if (readyResolved || readyFailed) return;
        readyFailed = true;
        rejectReady(error);
    };
    const clearNoProgressTimer = (): void => {
        if (!noProgressTimer) return;
        clearTimeout(noProgressTimer);
        noProgressTimer = undefined;
    };
    const armNoProgressTimer = (): void => {
        clearNoProgressTimer();
        if (!started || cancelRequested || options.noProgressTimeoutMs === undefined) return;
        noProgressTimer = setTimeout(() => {
            try {
                options.onNoProgress?.();
            } catch {
                // Worker cancellation below remains authoritative even if an
                // observational owner callback can no longer update metadata.
            } finally {
                requestCancellation("no_progress");
            }
        }, options.noProgressTimeoutMs);
        noProgressTimer.unref();
    };
    const safeSend = (message: ParentMessage): void => {
        if (!worker.connected || worker.exitCode !== null || worker.signalCode !== null) return;
        try {
            worker.send(message, (error) => {
                if (error && worker.exitCode === null && worker.signalCode === null) {
                    requestCancellation("worker_ipc_send_failed");
                }
            });
        } catch {
            requestCancellation("worker_ipc_send_failed");
        }
    };
    const requestCancellation = (reason?: string): boolean => {
        if (completionSettled) return false;
        if (cancelRequested) return true;
        cancelRequested = true;
        cancelReason = reason;
        clearNoProgressTimer();
        safeSend({
            type: "mutation_worker_cancel",
            operationId: options.operationId,
            ...(reason ? { reason } : {}),
        });
        cancelTimer = setTimeout(() => {
            forced = true;
            void forceAndProveProcessGroupQuiescence(executor.processGroupId);
        }, cancelGraceMs);
        cancelTimer.unref();
        return true;
    };

    worker.on("message", (message: unknown) => {
        if (!isWorkerMessage(message) || message.operationId !== options.operationId) {
            requestCancellation("worker_protocol_identity_mismatch");
            return;
        }
        switch (message.type) {
            case "mutation_worker_ready":
                workerReadySeen = true;
                resolveReadyIfContained();
                return;
            case "mutation_worker_heartbeat":
                try {
                    options.onHeartbeat?.();
                } catch {
                    requestCancellation("heartbeat_callback_failed");
                }
                return;
            case "mutation_worker_progress":
                if (message.sequence > lastProgressSequence) {
                    lastProgressSequence = message.sequence;
                    armNoProgressTimer();
                    try {
                        options.onProgress?.({
                            sequence: message.sequence,
                            ...(message.phase !== undefined ? { phase: message.phase } : {}),
                            ...(message.progress !== undefined ? { progress: message.progress } : {}),
                        });
                    } catch {
                        requestCancellation("progress_callback_failed");
                    }
                }
                return;
            case "mutation_worker_completed":
            case "mutation_worker_cancelled":
            case "mutation_worker_failed":
                terminalMessage = message;
                return;
        }
    });

    containmentWatchdog.once("spawn", () => {
        watchdogReady = true;
        resolveReadyIfContained();
    });
    containmentWatchdog.once("error", (error) => {
        failReadiness(error);
        requestCancellation("containment_watchdog_failed");
    });
    containmentWatchdog.once("exit", () => {
        if (!workerExitSeen && isProcessGroupLive(executor.processGroupId)) {
            requestCancellation("containment_watchdog_exited");
        }
    });

    worker.once("error", (error) => {
        failReadiness(error);
        requestCancellation("worker_process_error");
    });

    worker.once("exit", (code, signal) => {
        workerExitSeen = true;
        const exitDetail = signal ? `signal ${signal}` : code === null ? 'unknown exit' : `exit code ${code}`;
        clearNoProgressTimer();
        if (cancelTimer) clearTimeout(cancelTimer);
        if (sourceAbortListener && options.signal) {
            options.signal.removeEventListener("abort", sourceAbortListener);
        }
        void (async () => {
            if (isProcessGroupLive(executor.processGroupId)) {
                containmentViolation = !cancelRequested;
                await forceAndProveProcessGroupQuiescence(executor.processGroupId);
            }
            containmentWatchdog.kill("SIGTERM");
            completionSettled = true;
            if (!readyResolved) {
                failReadiness(new MutationWorkerFailureError(
                    options.operationId,
                    `Mutation worker exited before the containment handshake completed (${exitDetail}).`,
                ));
            }
            if (containmentViolation) {
                rejectCompletion(new MutationWorkerFailureError(
                    options.operationId,
                    `Mutation worker exited while descendants were still live (${exitDetail}); the process group was forcibly quiesced.`,
                ));
                return;
            }
            if (terminalMessage?.type === "mutation_worker_completed" && !forced) {
                options.onCompleted?.(terminalMessage.result);
                resolveCompletion();
                return;
            }
            if (terminalMessage?.type === "mutation_worker_failed") {
                rejectCompletion(new MutationWorkerFailureError(options.operationId, terminalMessage.error));
                return;
            }
            const reason = terminalMessage?.type === "mutation_worker_cancelled"
                ? terminalMessage.reason
                : cancelReason;
            if (cancelRequested || forced || terminalMessage?.type === "mutation_worker_cancelled") {
                rejectCompletion(new MutationWorkerCancelledError(options.operationId, reason));
                return;
            }
            rejectCompletion(new MutationWorkerFailureError(
                options.operationId,
                `Mutation worker exited without a terminal operation message (${exitDetail}).`,
            ));
        })().catch((error) => {
            // Process-group proof above is intentionally unbounded while a
            // descendant remains live. This catch is reached only after the
            // group is absent, so rejecting cannot release a live executor.
            completionSettled = true;
            rejectCompletion(error);
        });
    });

    if (options.signal) {
        sourceAbortListener = () => requestCancellation(sourceCancellationReason(options.signal));
        if (options.signal.aborted) sourceAbortListener();
        else options.signal.addEventListener("abort", sourceAbortListener, { once: true });
    }

    return Object.freeze({
        executor,
        ready,
        completion,
        start: () => {
            if (!readyResolved) throw new Error("Mutation worker containment must be ready before start().");
            if (started) throw new Error("Mutation worker has already been started.");
            if (cancelRequested) throw new MutationWorkerCancelledError(options.operationId, cancelReason);
            started = true;
            safeSend({ type: "mutation_worker_start", operationId: options.operationId });
            armNoProgressTimer();
        },
        requestCancellation,
    });
}

export type MutationWorkerRuntime = Readonly<{
    operationId: string;
    signal: AbortSignal;
    started: Promise<void>;
    heartbeat(): void;
    progress(input?: { phase?: MutationOperationPhase; progress?: number }): void;
    complete(result?: Readonly<Record<string, unknown>>): void;
    cancel(reason?: string): void;
    fail(error: unknown): void;
}>;

function workerSend(message: WorkerMessage, onSent?: () => void): void {
    if (!process.send || !process.connected) {
        onSent?.();
        return;
    }
    process.send(message, () => onSent?.());
}

function killOwnProcessGroup(): void {
    try {
        process.kill(-process.pid, "SIGKILL");
    } catch {
        process.exit(1);
    }
}

/**
 * Worker-side containment handshake. Call this before constructing mutation
 * state or touching a Publication, then await `started` before the first write.
 */
export function createMutationWorkerRuntime(): MutationWorkerRuntime {
    if (process.platform !== "linux") {
        throw new Error("Mutation worker runtime requires Linux process-group containment.");
    }
    const operationId = process.env[MUTATION_OPERATION_ID_ENV]?.trim();
    const parentPid = Number(process.env[MUTATION_PARENT_PID_ENV]);
    if (!operationId || !Number.isSafeInteger(parentPid) || parentPid <= 0 || !process.send) {
        throw new Error("Mutation worker containment environment is incomplete.");
    }

    const controller = new AbortController();
    let progressSequence = 0;
    let terminal = false;
    let selfClosing = false;
    let startedSettled = false;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
    });
    void started.catch(() => undefined);

    const parentIsLive = (): boolean => {
        try {
            process.kill(parentPid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
        }
    };
    const parentWatchdog = setInterval(() => {
        if (!parentIsLive()) killOwnProcessGroup();
    }, PARENT_WATCHDOG_MS);
    parentWatchdog.unref();

    const closeAfterTerminal = (): void => {
        clearInterval(parentWatchdog);
        if (!process.connected) return;
        selfClosing = true;
        process.disconnect();
    };
    const finish = (message: WorkerTerminalMessage): void => {
        if (terminal) return;
        terminal = true;
        workerSend(message, closeAfterTerminal);
    };
    const onParentMessage = (message: unknown): void => {
        if (!message || typeof message !== "object") return;
        const record = message as Partial<ParentMessage>;
        if (record.operationId !== operationId) return;
        if (record.type === "mutation_worker_start") {
            if (!startedSettled) {
                startedSettled = true;
                resolveStarted();
            }
            return;
        }
        if (record.type === "mutation_worker_cancel") {
            const reason = typeof record.reason === "string" ? record.reason : undefined;
            if (!controller.signal.aborted) {
                controller.abort(new MutationWorkerCancelledError(operationId, reason));
            }
            if (!startedSettled) {
                startedSettled = true;
                rejectStarted(controller.signal.reason);
            }
        }
    };
    process.on("message", onParentMessage);
    process.once("disconnect", () => {
        if (!selfClosing) killOwnProcessGroup();
    });

    if (!parentIsLive()) killOwnProcessGroup();
    workerSend({ type: "mutation_worker_ready", operationId });

    return Object.freeze({
        operationId,
        signal: controller.signal,
        started,
        heartbeat: () => {
            if (!terminal) workerSend({ type: "mutation_worker_heartbeat", operationId });
        },
        progress: (input: { phase?: MutationOperationPhase; progress?: number } = {}) => {
            if (terminal) return;
            progressSequence += 1;
            workerSend({
                type: "mutation_worker_progress",
                operationId,
                sequence: progressSequence,
                ...(input.phase !== undefined ? { phase: input.phase } : {}),
                ...(input.progress !== undefined ? { progress: input.progress } : {}),
            });
        },
        complete: (result?: Readonly<Record<string, unknown>>) => {
            if (result !== undefined) {
                let serialized: string;
                try {
                    serialized = JSON.stringify(result);
                } catch (error) {
                    finish({
                        type: "mutation_worker_failed",
                        operationId,
                        error: `Mutation worker completion result is not serializable: ${error instanceof Error ? error.message : String(error)}`,
                    });
                    return;
                }
                if (Buffer.byteLength(serialized, "utf8") > MAX_COMPLETION_RESULT_BYTES) {
                    finish({
                        type: "mutation_worker_failed",
                        operationId,
                        error: `Mutation worker completion result exceeds ${MAX_COMPLETION_RESULT_BYTES} bytes.`,
                    });
                    return;
                }
            }
            finish({
                type: "mutation_worker_completed",
                operationId,
                ...(result !== undefined ? { result } : {}),
            });
        },
        cancel: (reason?: string) => finish({
            type: "mutation_worker_cancelled",
            operationId,
            ...(reason ? { reason } : {}),
        }),
        fail: (error: unknown) => finish({
            type: "mutation_worker_failed",
            operationId,
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}
