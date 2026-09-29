import { RootMutationRuntime, type MutationOperationPhase } from "@satori-code/core/integration";
import { perfTrace } from "@satori-code/core";
import { CapabilityResolver } from "../core/capabilities.js";
import { createMcpConfig, resolveMcpRuntimeBootstrap } from "../config.js";
import { ProviderRuntime } from "./provider-runtime.js";
import { createMutationWorkerRuntime } from "./mutation-worker-supervisor.js";

const workerRuntime = createMutationWorkerRuntime();

type SyncWorkerInput = Readonly<{
    path: string;
}>;

function parseInput(raw: string | undefined): SyncWorkerInput {
    if (!raw) throw new Error("Mutation sync worker input is missing.");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Mutation sync worker input must be an object.");
    }
    const path = (parsed as Record<string, unknown>).path;
    if (typeof path !== "string" || path.trim().length === 0) {
        throw new Error("Mutation sync worker path must be a non-empty string.");
    }
    return { path };
}

function cancellationReason(): string | undefined {
    const reason = workerRuntime.signal.reason;
    if (reason instanceof Error) return reason.message;
    if (typeof reason === "string" && reason.trim()) return reason;
    return undefined;
}

function assertNotCancelled(): void {
    if (!workerRuntime.signal.aborted) return;
    throw workerRuntime.signal.reason ?? new Error("Mutation sync worker was cancelled.");
}

function phaseForTiming(phase: string): MutationOperationPhase {
    switch (phase) {
        case "checkpoint_proof":
        case "exact_path_comparison":
            return "preflight";
        case "publication_source_navigation_load":
        case "publication_fork":
        case "publication_payload_delta":
            return "writing";
        case "publication_navigation_checkpoint":
        case "publication_navigation_delta":
        case "publication_relationship_load":
        case "publication_relationship_delta":
        case "publication_sidecar_stage":
        case "publication_checkpoint_stage":
        case "publication_payload_count":
            return "proving";
        case "publication_activation":
        case "incremental_publication":
            return "publishing";
        default:
            return "writing";
    }
}

async function main(): Promise<void> {
    const input = parseInput(process.argv[2]);
    await workerRuntime.started;
    assertNotCancelled();

    const mutationRuntime = new RootMutationRuntime();
    let result: Readonly<Record<string, unknown>> | undefined;
    await mutationRuntime.runBoundExecutor(
        input.path,
        "sync",
        workerRuntime.operationId,
        async () => {
            assertNotCancelled();
            workerRuntime.progress({ phase: "preflight", progress: 0 });
            const parsedConfig = createMcpConfig();
            const { config, runtimeFingerprint } = await resolveMcpRuntimeBootstrap(parsedConfig);
            assertNotCancelled();

            const providerRuntime = new ProviderRuntime({
                config,
                runtimeFingerprint,
                capabilities: new CapabilityResolver(config),
                readFileMaxLines: Math.max(1, config.readFileMaxLines ?? 1000),
                readFileMaxBytes: Math.max(1, config.readFileMaxBytes ?? 8 * 1024 * 1024),
                watchSyncEnabled: false,
                startSyncLifecycle: false,
                mutationRuntime,
            });

            try {
                const toolContext = await providerRuntime.requireToolContext("embedding_vector");
                if ("code" in toolContext) {
                    throw new Error(toolContext.message);
                }
                assertNotCancelled();

                let publicProgress = 0;
                const publishRealProgress = (
                    phase: MutationOperationPhase,
                    requestedProgress?: number,
                ): void => {
                    assertNotCancelled();
                    const next = requestedProgress === undefined
                        ? publicProgress + 1
                        : requestedProgress;
                    publicProgress = Math.max(publicProgress, Math.min(98, next));
                    workerRuntime.progress({ phase, progress: publicProgress });
                };

                const decision = await toolContext.syncManager.ensureFreshness(input.path, 0, {
                    onSyncProgress: (progress) => {
                        publishRealProgress(
                            "writing",
                            5 + Math.round(Math.max(0, Math.min(100, progress.percentage)) * 0.7),
                        );
                    },
                    onPhaseTiming: (phase, durationMs) => {
                        perfTrace(`sync.${phase}`, durationMs);
                        publishRealProgress(phaseForTiming(phase));
                    },
                });
                assertNotCancelled();
                result = {
                    mode: decision.mode,
                    ...(decision.stats ? { stats: decision.stats } : {}),
                };

                switch (decision.mode) {
                    case "ignore_reload_failed":
                        throw new Error(decision.errorMessage || "Ignore-rule reconciliation failed.");
                    case "skipped_mutation_in_progress":
                        throw new Error("Attached sync executor unexpectedly encountered another live mutation.");
                    case "skipped_indexing":
                        throw new Error("Attached sync executor unexpectedly lost its completed Publication baseline.");
                    case "skipped_requires_reindex":
                    case "skipped_source_checkpoint_unavailable":
                        workerRuntime.progress({ phase: "blocked" });
                        return;
                    default:
                        workerRuntime.progress({ phase: "completed", progress: 100 });
                        return;
                }
            } finally {
                await providerRuntime.shutdown();
            }
        },
        { signal: workerRuntime.signal },
    );
    workerRuntime.complete(result);
}

const heartbeat = setInterval(() => workerRuntime.heartbeat(), 15_000);
heartbeat.unref();

void main().catch((error: unknown) => {
    clearInterval(heartbeat);
    if (workerRuntime.signal.aborted) {
        workerRuntime.cancel(cancellationReason());
        return;
    }
    workerRuntime.fail(error);
});
