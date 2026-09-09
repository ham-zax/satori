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
}>;

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
    private readonly failedEpochs = new Map<string, string>();

    constructor(private readonly options: IndexMaintenanceCoordinatorOptions) {}

    /** One attempt per explicit root and runtime epoch; only one automatic create runs at a time. */
    requestWorkspaceIndexing(codebasePath: string): Promise<void> {
        if (!this.options.enabled || !this.options.startCreate) return Promise.resolve();
        const existing = this.workspaceRequests.get(codebasePath);
        if (existing) return existing;
        const attempt = this.workspaceQueue.then(async () => {
            if (this.options.getActiveMutation(codebasePath)) return;
            const launch = await this.options.startCreate!(codebasePath);
            if (launch.completion) await launch.completion;
        });
        this.workspaceRequests.set(codebasePath, attempt);
        this.workspaceQueue = attempt.catch(() => undefined);
        return attempt;
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
        const failedOperationId = this.failedEpochs.get(epochKey);
        if (failedOperationId) {
            const latest = this.options.getOperation(codebasePath);
            if (
                !latest
                || (latest.id !== failedOperationId
                    && latest.action === "reindex"
                    && latest.phase === "completed")
            ) {
                this.failedEpochs.delete(epochKey);
            } else {
                return Object.freeze({ outcome: "suppressed" });
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

        const admission = this.startAutomaticReindex(codebasePath, epochKey);
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
    ): Promise<AutomaticReindexScheduleResult> {
        const launch = await this.options.startReindex(codebasePath);
        const active = this.options.getActiveMutation(codebasePath);

        if (!launch.accepted) {
            if (launch.operationId) {
                this.failedEpochs.set(epochKey, launch.operationId);
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
                        && (terminal.phase === "failed"
                            || terminal.phase === "blocked"
                            || terminal.phase === "cancelled")
                    ) {
                        this.failedEpochs.set(epochKey, launch.operationId);
                    } else {
                        this.failedEpochs.delete(epochKey);
                    }
                },
                (error) => {
                    this.failedEpochs.set(epochKey, launch.operationId);
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

    private epochKey(codebasePath: string): string {
        return `${this.options.runtimeEpoch}\n${codebasePath}`;
    }
}
