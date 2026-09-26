import type {
    RootMutationActivity,
    RootMutationOperation,
} from "@zokizuan/satori-core/integration";

export type AutomaticReindexReason =
    | "requires_reindex"
    | "runtime_policy_incompatible"
    | "navigation_reindex_required"
    | "missing_collection";

export type AutomaticReindexScheduleResult = Readonly<{
    outcome: "started" | "coalesced" | "unavailable" | "suppressed";
}>;

export type AutomaticMaintenanceFailureClass =
    | "deterministic"
    | "resource_blocked"
    | "retryable_external"
    | "cancelled";

type AutomaticMaintenanceFailureState = Readonly<{
    operationId: string;
    classification: AutomaticMaintenanceFailureClass;
    attempts: number;
    retryAfterMs?: number;
}>;

type AutomaticReindexLaunch = Readonly<{
    accepted: boolean;
    operationId: string;
    completion: Promise<void> | null;
}>;

type IndexMaintenanceCoordinatorOptions = Readonly<{
    enabled: boolean;
    runtimeEpoch: string;
    getActiveMutation(codebasePath: string): RootMutationActivity | undefined;
    getOperation(codebasePath: string): RootMutationOperation | undefined;
    startReindex(codebasePath: string): Promise<AutomaticReindexLaunch>;
    startCreate?(codebasePath: string): Promise<AutomaticReindexLaunch>;
    now?: () => number;
    retryBackoffMs?: number;
    maxRetryBackoffMs?: number;
}>;

const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 15 * 60_000;

function errorText(operation: RootMutationOperation | undefined, error?: unknown): string {
    const fragments = [
        operation?.error,
        operation?.cancelReason,
        error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    return fragments.join(" ").toLowerCase();
}

function classifyFailure(
    operation: RootMutationOperation | undefined,
    error?: unknown,
): AutomaticMaintenanceFailureClass {
    if (operation?.phase === "cancelled") return "cancelled";
    const text = errorText(operation, error);
    if (/\bcancel(?:led|lation)?\b/.test(text)) return "cancelled";
    if (/(resource limit|chunk limit|collection limit|out of memory|heap|memory limit|quota|enospc|disk full)/.test(text)) {
        return "resource_blocked";
    }
    if (/(incompatible|unsupported|invalid|missing .*config|configuration|permission|eacces|eperm|policy_changed|source changed|does not exist|not a directory|required capability)/.test(text)) {
        return "deterministic";
    }
    if (operation?.phase === "blocked") return "deterministic";
    return "retryable_external";
}

/**
 * Process-local admission owner for transparent offline reindex maintenance.
 * Durable index truth remains Publication-owned; this coordinator only
 * coalesces current-process requests and prevents a failed automatic rebuild
 * from spinning on every subsequent read in the same runtime epoch.
 */
export class IndexMaintenanceCoordinator {
    private readonly admission = new Map<string, Promise<AutomaticReindexScheduleResult>>();
    private readonly automaticCompletions = new Map<string, Promise<void>>();
    private readonly workspaceRequests = new Map<string, Promise<void>>();
    private workspaceQueue: Promise<void> = Promise.resolve();
    private readonly failures = new Map<string, AutomaticMaintenanceFailureState>();
    private readonly workspaceFailures = new Map<string, AutomaticMaintenanceFailureState>();
    private readonly now: () => number;
    private readonly retryBackoffMs: number;
    private readonly maxRetryBackoffMs: number;

    constructor(private readonly options: IndexMaintenanceCoordinatorOptions) {
        this.now = options.now ?? (() => Date.now());
        this.retryBackoffMs = Math.max(1, options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
        this.maxRetryBackoffMs = Math.max(
            this.retryBackoffMs,
            options.maxRetryBackoffMs ?? DEFAULT_MAX_RETRY_BACKOFF_MS,
        );
    }

    /** One automatic create at a time; transient failures may retry after bounded backoff. */
    requestWorkspaceIndexing(codebasePath: string): Promise<void> {
        if (!this.options.enabled || !this.options.startCreate) return Promise.resolve();
        const epochKey = this.epochKey(codebasePath);
        const previousFailure = this.workspaceFailures.get(epochKey);
        if (previousFailure) {
            const latest = this.options.getOperation(codebasePath);
            if (this.completedReplacement(latest, previousFailure)) {
                this.workspaceFailures.delete(epochKey);
                this.workspaceRequests.delete(codebasePath);
            } else if (!this.retryDue(previousFailure)) {
                return Promise.resolve();
            } else {
                this.workspaceRequests.delete(codebasePath);
            }
        }

        const existing = this.workspaceRequests.get(codebasePath);
        if (existing) return existing;

        let tracked!: Promise<void>;
        const attempt = this.workspaceQueue.then(async () => {
            if (this.options.getActiveMutation(codebasePath)) return;
            let launch: AutomaticReindexLaunch;
            try {
                launch = await this.options.startCreate!(codebasePath);
            } catch (error) {
                this.recordFailure(
                    this.workspaceFailures,
                    epochKey,
                    "",
                    this.options.getOperation(codebasePath),
                    error,
                );
                throw error;
            }

            if (!launch.accepted) {
                if (launch.operationId) {
                    const terminal = this.options.getOperation(codebasePath);
                    this.recordFailure(
                        this.workspaceFailures,
                        epochKey,
                        launch.operationId,
                        terminal?.id === launch.operationId ? terminal : undefined,
                    );
                }
                return;
            }

            if (!launch.completion) return;
            try {
                await launch.completion;
            } catch (error) {
                const terminal = this.options.getOperation(codebasePath);
                this.recordFailure(
                    this.workspaceFailures,
                    epochKey,
                    launch.operationId,
                    terminal?.id === launch.operationId ? terminal : undefined,
                    error,
                );
                throw error;
            }

            const terminal = this.options.getOperation(codebasePath);
            if (
                terminal?.id === launch.operationId
                && this.isTerminalFailure(terminal)
            ) {
                this.recordFailure(
                    this.workspaceFailures,
                    epochKey,
                    launch.operationId,
                    terminal,
                );
            } else {
                this.workspaceFailures.delete(epochKey);
            }
        });
        tracked = attempt.finally(() => {
            const failure = this.workspaceFailures.get(epochKey);
            if (
                failure?.classification === "retryable_external"
                && this.workspaceRequests.get(codebasePath) === tracked
            ) {
                this.workspaceRequests.delete(codebasePath);
            }
        });
        this.workspaceRequests.set(codebasePath, tracked);
        this.workspaceQueue = tracked.catch(() => undefined);
        return tracked;
    }

    async requestAutomaticReindex(
        codebasePath: string,
        _reason: AutomaticReindexReason,
    ): Promise<AutomaticReindexScheduleResult> {
        if (!this.options.enabled) {
            return Object.freeze({ outcome: "unavailable" });
        }

        const active = this.options.getActiveMutation(codebasePath);
        if (active?.action === "create" || active?.action === "reindex") {
            return Object.freeze({ outcome: "coalesced" });
        }

        const epochKey = this.epochKey(codebasePath);
        const previousFailure = this.failures.get(epochKey);
        let previousAttempts = 0;
        if (previousFailure) {
            const latest = this.options.getOperation(codebasePath);
            if (this.completedReplacement(latest, previousFailure)) {
                this.failures.delete(epochKey);
            } else if (!this.retryDue(previousFailure)) {
                return Object.freeze({ outcome: "suppressed" });
            } else {
                previousAttempts = previousFailure.attempts;
            }
        }

        if (this.automaticCompletions.has(codebasePath)) {
            return Object.freeze({ outcome: "coalesced" });
        }

        const pending = this.admission.get(codebasePath);
        if (pending) {
            const result = await pending;
            return result.outcome === "started"
                ? Object.freeze({ outcome: "coalesced" })
                : result;
        }

        const admission = this.startAutomaticReindex(
            codebasePath,
            epochKey,
            previousAttempts,
        );
        this.admission.set(codebasePath, admission);
        try {
            return await admission;
        } finally {
            if (this.admission.get(codebasePath) === admission) {
                this.admission.delete(codebasePath);
            }
        }
    }

    private async startAutomaticReindex(
        codebasePath: string,
        epochKey: string,
        previousAttempts: number,
    ): Promise<AutomaticReindexScheduleResult> {
        const launch = await this.options.startReindex(codebasePath);
        const active = this.options.getActiveMutation(codebasePath);

        if (!launch.accepted) {
            if (launch.operationId) {
                const terminal = this.options.getOperation(codebasePath);
                this.recordFailure(
                    this.failures,
                    epochKey,
                    launch.operationId,
                    terminal?.id === launch.operationId ? terminal : undefined,
                    undefined,
                    previousAttempts,
                );
                return Object.freeze({ outcome: "suppressed" });
            }
            if (active?.action === "create" || active?.action === "reindex") {
                return Object.freeze({ outcome: "coalesced" });
            }
            return Object.freeze({ outcome: "unavailable" });
        }

        if (launch.operationId && launch.completion) {
            const completion = launch.completion.then(
                () => {
                    const terminal = this.options.getOperation(codebasePath);
                    if (
                        terminal?.id === launch.operationId
                        && this.isTerminalFailure(terminal)
                    ) {
                        this.recordFailure(
                            this.failures,
                            epochKey,
                            launch.operationId,
                            terminal,
                            undefined,
                            previousAttempts,
                        );
                    } else {
                        this.failures.delete(epochKey);
                    }
                },
                (error) => {
                    const terminal = this.options.getOperation(codebasePath);
                    this.recordFailure(
                        this.failures,
                        epochKey,
                        launch.operationId,
                        terminal?.id === launch.operationId ? terminal : undefined,
                        error,
                        previousAttempts,
                    );
                    throw error;
                },
            ).finally(() => {
                if (this.automaticCompletions.get(codebasePath) === completion) {
                    this.automaticCompletions.delete(codebasePath);
                }
            });
            this.automaticCompletions.set(codebasePath, completion);
            void completion.catch(() => undefined);
            return Object.freeze({ outcome: "started" });
        }

        if (active?.action === "create" || active?.action === "reindex") {
            return Object.freeze({ outcome: "coalesced" });
        }

        return Object.freeze({ outcome: "unavailable" });
    }

    private isTerminalFailure(operation: RootMutationOperation): boolean {
        return operation.phase === "failed"
            || operation.phase === "blocked"
            || operation.phase === "cancelled";
    }

    private completedReplacement(
        latest: RootMutationOperation | undefined,
        failure: AutomaticMaintenanceFailureState,
    ): boolean {
        return Boolean(
            latest
            && latest.id !== failure.operationId
            && (latest.action === "create" || latest.action === "reindex")
            && latest.phase === "completed"
        );
    }

    private retryDue(failure: AutomaticMaintenanceFailureState): boolean {
        return failure.classification === "retryable_external"
            && failure.retryAfterMs !== undefined
            && this.now() >= failure.retryAfterMs;
    }

    private recordFailure(
        target: Map<string, AutomaticMaintenanceFailureState>,
        key: string,
        operationId: string,
        operation?: RootMutationOperation,
        error?: unknown,
        previousAttempts = 0,
    ): AutomaticMaintenanceFailureState {
        const classification = classifyFailure(operation, error);
        const attempts = classification === "retryable_external"
            ? Math.max(previousAttempts, target.get(key)?.attempts ?? 0) + 1
            : 1;
        const retryAfterMs = classification === "retryable_external"
            ? this.now() + Math.min(
                this.maxRetryBackoffMs,
                this.retryBackoffMs * Math.pow(2, Math.max(0, attempts - 1)),
            )
            : undefined;
        const failure = Object.freeze({
            operationId,
            classification,
            attempts,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
        target.set(key, failure);
        return failure;
    }

    private epochKey(codebasePath: string): string {
        return `${this.options.runtimeEpoch}\n${codebasePath}`;
    }
}
