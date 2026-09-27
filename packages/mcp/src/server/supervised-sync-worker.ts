import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type {
    MutationOperationPhase,
    RootMutationActivity,
    RootMutationExecution,
    RootMutationRuntime,
} from "@zokizuan/satori-core/integration";
import type { SyncWorkerResult } from "../core/sync.js";
import { spawnSupervisedMutationWorker } from "./mutation-worker-supervisor.js";

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

/**
 * Runs one incremental sync for `execution` in a supervised child process.
 *
 * The child binds to the parent's root mutation lease, so the lease stays with
 * this process while all sync memory lives, and is returned to the OS, in the
 * child. Resolves once the child is bound and started.
 */
export async function startSupervisedSyncWorker(input: Readonly<{
    codebasePath: string;
    execution: RootMutationExecution;
    mutationRuntime: RootMutationRuntime;
}>): Promise<StartedSyncWorker> {
    const { codebasePath, execution, mutationRuntime } = input;
    let terminalPhase: SyncWorkerResult["terminalPhase"];
    let terminalProgress: number | undefined;
    let completedResult: Readonly<Record<string, unknown>> | undefined;
    const worker = spawnSupervisedMutationWorker({
        operationId: execution.id,
        workerPath: resolveMutationSyncWorkerPath(),
        workerArgs: [JSON.stringify({ path: codebasePath })],
        signal: execution.signal,
        noProgressTimeoutMs: SYNC_NO_PROGRESS_TIMEOUT_MS,
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
            completedResult = result;
        },
    });

    let boundActivity: RootMutationActivity;
    try {
        await worker.ready;
        if (execution.signal.aborted) {
            throw execution.signal.reason ?? new Error("Sync cancelled before executor binding.");
        }
        boundActivity = execution.bindExecutor(worker.executor);
        worker.start();
    } catch (error) {
        worker.requestCancellation("sync_startup_failed");
        await worker.completion.catch(() => undefined);
        throw error;
    }

    return {
        boundActivity,
        completion: worker.completion.then(() => ({
            ...(terminalPhase ? { terminalPhase } : {}),
            ...(terminalProgress !== undefined ? { terminalProgress } : {}),
            ...(typeof completedResult?.mode === "string" ? { mode: completedResult.mode } : {}),
            ...(parseStats(completedResult?.stats) ? { stats: parseStats(completedResult?.stats) } : {}),
        })),
    };
}
