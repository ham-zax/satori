import type { ObservedResolvedIndexPolicy } from "@zokizuan/satori-core";
import { RootMutationRuntime, type MutationOperationPhase } from "@zokizuan/satori-core/integration";
import { CapabilityResolver } from "../core/capabilities.js";
import { createMcpConfig, resolveMcpRuntimeBootstrap } from "../config.js";
import { ProviderRuntime } from "./provider-runtime.js";
import { createMutationWorkerRuntime } from "./mutation-worker-supervisor.js";

const workerRuntime = createMutationWorkerRuntime();

type FullIndexWorkerInput = Readonly<{
    path: string;
    action: "create" | "reindex";
    forceReindex: boolean;
    indexPolicy: ObservedResolvedIndexPolicy;
    deferPartialPublication: boolean;
}>;

type FullIndexWorkerResult = Readonly<{
    indexedFiles: number;
    totalChunks: number;
    status: "completed" | "limit_reached";
    collectionName: string;
    publication: Readonly<{
        id: string;
        status: "staged" | "activated";
    }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Mutation index worker '${key}' must be a non-empty string.`);
    }
    return value;
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
    const value = record[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`Mutation index worker '${key}' must be a string array.`);
    }
    return [...value];
}

function parseIndexPolicy(value: unknown): ObservedResolvedIndexPolicy {
    if (!isRecord(value)) {
        throw new Error("Mutation index worker indexPolicy must be an object.");
    }
    const profile = requireString(value, "profile");
    if (profile !== "default" && profile !== "minimal" && profile !== "all-text") {
        throw new Error(`Mutation index worker indexPolicy profile '${profile}' is unsupported.`);
    }
    return {
        canonicalRoot: requireString(value, "canonicalRoot"),
        profile,
        customExtensions: requireStringArray(value, "customExtensions"),
        customIgnorePatterns: requireStringArray(value, "customIgnorePatterns"),
        fileBasedIgnorePatterns: requireStringArray(value, "fileBasedIgnorePatterns"),
        supportedExtensions: requireStringArray(value, "supportedExtensions"),
        effectiveIgnorePatterns: requireStringArray(value, "effectiveIgnorePatterns"),
        policyHash: requireString(value, "policyHash"),
        controlSignature: requireString(value, "controlSignature"),
    };
}

function parseInput(raw: string | undefined): FullIndexWorkerInput {
    if (!raw) throw new Error("Mutation index worker input is missing.");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
        throw new Error("Mutation index worker input must be an object.");
    }
    const action = parsed.action;
    if (action !== "create" && action !== "reindex") {
        throw new Error("Mutation index worker action must be 'create' or 'reindex'.");
    }
    if (typeof parsed.forceReindex !== "boolean" || typeof parsed.deferPartialPublication !== "boolean") {
        throw new Error("Mutation index worker boolean inputs are invalid.");
    }
    const path = requireString(parsed, "path");
    const indexPolicy = parseIndexPolicy(parsed.indexPolicy);
    if (indexPolicy.canonicalRoot !== path) {
        throw new Error("Mutation index worker policy root does not match the requested canonical root.");
    }
    return {
        path,
        action,
        forceReindex: parsed.forceReindex,
        indexPolicy,
        deferPartialPublication: parsed.deferPartialPublication,
    };
}

function cancellationReason(): string | undefined {
    const reason = workerRuntime.signal.reason;
    if (reason instanceof Error) return reason.message;
    if (typeof reason === "string" && reason.trim()) return reason;
    return undefined;
}

function assertNotCancelled(): void {
    if (!workerRuntime.signal.aborted) return;
    throw workerRuntime.signal.reason ?? new Error("Mutation index worker was cancelled.");
}

function progressPhase(percentage: number): MutationOperationPhase {
    return percentage <= 10 ? "scanning" : "writing";
}

async function main(): Promise<void> {
    const input = parseInput(process.argv[2]);
    await workerRuntime.started;
    assertNotCancelled();

    const mutationRuntime = new RootMutationRuntime();
    const result = await mutationRuntime.runBoundExecutor(
        input.path,
        input.action,
        workerRuntime.operationId,
        async (): Promise<FullIndexWorkerResult> => {
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

                let lastProgress = 0;
                const indexed = await toolContext.context.indexCodebase(
                    input.path,
                    (progress) => {
                        assertNotCancelled();
                        const nextProgress = Math.max(
                            lastProgress,
                            Math.min(98, Math.round(progress.percentage)),
                        );
                        lastProgress = nextProgress;
                        workerRuntime.progress({
                            phase: progressPhase(nextProgress),
                            progress: nextProgress,
                        });
                    },
                    input.forceReindex,
                    {
                        deferPartialPublication: input.deferPartialPublication,
                        indexPolicy: input.indexPolicy,
                    },
                );
                assertNotCancelled();

                return {
                    indexedFiles: indexed.indexedFiles,
                    totalChunks: indexed.totalChunks,
                    status: indexed.status,
                    collectionName: indexed.collectionName,
                    publication: {
                        id: indexed.publication.id,
                        status: indexed.publication.status,
                    },
                };
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
