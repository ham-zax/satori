import { Server, type CallToolResult, type Transport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withSourceMeasurementOperation } from "@satori-code/core";
import {
    createRootMutationLeasePort,
    createStorageMaintenanceReaderGuard,
    resolveRuntimeOwnerStateDir,
} from "@satori-code/core/integration";
import {
    DEFAULT_MAX_STORAGE_GIB,
    DEFAULT_WORKTREE_IDLE_DAYS,
    runPublicationStorageMaintenance,
} from "@satori-code/core/storage-maintenance";
import type { ContextMcpConfig, IndexFingerprint } from "../config.js";
import { CapabilityResolver } from "../core/capabilities.js";
import {
    SearchContinuationCoordinator,
    SearchContinuationCoordinatorPool,
    ToolHandlers,
} from "../core/handlers.js";
import {
    RootMutationRuntime,
    createSharedPublicationRuntime,
    type SharedPublicationRuntime,
} from "@satori-code/core/integration";
import {
    RuntimeOwnerRegistry,
    buildRuntimeOwnerIdentityFromConfig,
} from "../core/runtime-owner.js";
import {
    createSessionWorkspacePolicy,
    type SessionWorkspacePolicy,
} from "../core/session-workspace-policy.js";
import {
    SESSION_WORKSPACE_ROOTS_MAX,
    WorkspaceAuthorizationError,
    hasExplicitSessionWorkspaceRoots,
    resolveAllowBroadRoots,
    resolveSessionWorkspaceRoots,
} from "../core/session-workspace-roots.js";
import { SyncManager } from "../core/sync.js";
import { getMcpToolList, toolRegistry } from "../tools/registry.js";
import type {
    MissingProviderConfigIssue,
    ProviderBackedOperation,
    ToolContext,
} from "../tools/types.js";
import { createLocalOnlyContext, ProviderRuntime } from "./provider-runtime.js";
import { SHARED_RUNTIME_MAX_PENDING_REQUESTS } from "./shared-runtime-identity.js";

export type ServerRunMode = "mcp" | "cli" | "postflight" | "host";

const PUBLISHED_READ_TOOLS = new Set([
    "architecture_overview", "call_graph", "detect_changes", "file_outline",
    "find_references", "read_file", "search_codebase", "trace_path",
]);

export {
    SESSION_WORKSPACE_ROOTS_MAX,
    hasExplicitSessionWorkspaceRoots,
    resolveAllowBroadRoots,
    resolveSessionWorkspaceRoots,
};

export function createSessionWorkspacePolicyFromEnv(env: NodeJS.ProcessEnv): SessionWorkspacePolicy {
    return createSessionWorkspacePolicy({
        roots: resolveSessionWorkspaceRoots(env),
        homeDirectory: os.homedir(),
        stateRoot: env.SATORI_STATE_ROOT ?? path.join(env.HOME ?? os.homedir(), ".satori"),
        allowBroadRoots: resolveAllowBroadRoots(env),
        allowImplicitBroadContainerRoot: !hasExplicitSessionWorkspaceRoots(env),
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isMissingProviderConfigIssue(
    value: ToolContext | MissingProviderConfigIssue,
): value is MissingProviderConfigIssue {
    return "code" in value && value.code === "MISSING_PROVIDER_CONFIG";
}

function workspaceIndexRequests(
    workspacePolicy: SessionWorkspacePolicy,
    providerRuntime: ProviderRuntime,
): Pick<ProviderRuntime, "requestAutomaticCreate" | "requestAutomaticReindex"> {
    const indexRoot = (codebasePath: string): string | undefined => {
        try {
            return workspacePolicy.authorizeRoot(codebasePath).canonicalPath;
        } catch {
            return undefined;
        }
    };
    return {
        requestAutomaticCreate: (codebasePath) => {
            const root = indexRoot(codebasePath);
            return root !== undefined && providerRuntime.requestAutomaticCreate(root);
        },
        requestAutomaticReindex: async (codebasePath, reason) => {
            const root = indexRoot(codebasePath);
            return root === undefined ? { outcome: "unavailable" } : providerRuntime.requestAutomaticReindex(root, reason);
        },
    };
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

class SessionProviderRuntime {
    private readonly contexts = new Map<ToolContext, ToolContext>();
    private readonly handlers = new Set<ToolHandlers>();

    constructor(
        private readonly providerRuntime: ProviderRuntime,
        private readonly continuationCoordinator: SearchContinuationCoordinator,
        private readonly mutationRuntime: RootMutationRuntime,
        private readonly workspacePolicy: SessionWorkspacePolicy,
    ) {}

    async requireToolContext(
        operation: ProviderBackedOperation,
        request: { signal?: AbortSignal } = {},
    ): Promise<ToolContext | MissingProviderConfigIssue> {
        request.signal?.throwIfAborted();
        const shared = await awaitWithAbort(
            this.providerRuntime.requireToolContext(operation),
            request.signal,
        );
        request.signal?.throwIfAborted();
        if (isMissingProviderConfigIssue(shared)) {
            return shared;
        }

        const existing = this.contexts.get(shared);
        if (existing) {
            return request.signal
                ? { ...existing, requestSignal: request.signal }
                : existing;
        }

        const toolHandlers = new ToolHandlers(
            shared.context,
            shared.syncManager,
            shared.runtimeFingerprint,
            shared.capabilities,
            this.mutationRuntime,
            () => Date.now(),
            shared.reranker,
            undefined,
            this.providerRuntime.navigationStore,
            shared.runtimeOwnerGate,
            this.continuationCoordinator,
            {
                readFileMaxBytes: shared.readFileMaxBytes,
                ownDetachedMutationCompletion: (completion) => this.providerRuntime.ownDetachedMutationCompletion(completion),
                isAutomaticIndexing: (codebasePath) => this.providerRuntime.isAutomaticIndexing(codebasePath),
                ...workspaceIndexRequests(this.workspacePolicy, this.providerRuntime),
                reclaimIdleMemoryForMutation: () => this.providerRuntime.reclaimIdleMemoryForMutation(),
            },
        );
        const sessionContext: ToolContext = {
            ...shared,
            toolHandlers,
            providerRuntime: this,
            // The provider-shared raw context carries the deny-all sentinel;
            // the session wrapper binds the immutable per-session policy so
            // every tool context obeys this session's roots and any unbind
            // path fails closed with WORKSPACE_POLICY_NOT_BOUND.
            workspacePolicy: this.workspacePolicy,
        };
        this.contexts.set(shared, sessionContext);
        this.handlers.add(toolHandlers);
        return request.signal
            ? { ...sessionContext, requestSignal: request.signal }
            : sessionContext;
    }

    release(): void {
        for (const handler of this.handlers) {
            handler.releaseSearchContinuationOwnership();
        }
        this.handlers.clear();
        this.contexts.clear();
    }
}

type SessionResources = {
    toolContext: ToolContext;
    localHandlers: ToolHandlers;
    providerRuntime: SessionProviderRuntime;
};

export class SharedRuntimeHost {
    private readonly capabilities: CapabilityResolver;
    private readonly runtimeOwnerRegistry: RuntimeOwnerRegistry;
    private readonly mutationRuntime: RootMutationRuntime;
    private readonly publicationRuntime: SharedPublicationRuntime;
    private readonly localContext: ReturnType<typeof createLocalOnlyContext>;
    private readonly localSyncManager: SyncManager;
    private readonly searchContinuationPool = new SearchContinuationCoordinatorPool();
    private readonly providerRuntime: ProviderRuntime;
    private readonly readFileMaxLines: number;
    private readonly readFileMaxBytes: number;
    private readonly watchSyncEnabled: boolean;
    private readonly runtimeOwnerRegistered: boolean = false;
    private activeSessions = 0;
    private activeOperations = 0;
    private readonly detachedMutationCompletions = new Set<Promise<void>>();
    private shutdownStarted = false;
    private shutdownPromise: Promise<void> | null = null;
    private readonly activityListeners = new Set<() => void>();

    constructor(
        readonly config: ContextMcpConfig,
        readonly runtimeFingerprint: IndexFingerprint,
        readonly runMode: ServerRunMode,
    ) {
        this.capabilities = new CapabilityResolver(config);
        this.readFileMaxLines = Math.max(1, config.readFileMaxLines ?? 1000);
        this.readFileMaxBytes = Math.max(1, config.readFileMaxBytes ?? 8 * 1024 * 1024);
        this.watchSyncEnabled = config.watchSyncEnabled === true;
        console.log(`[FINGERPRINT] Runtime index fingerprint: ${JSON.stringify(runtimeFingerprint)}`);

        this.runtimeOwnerRegistry = new RuntimeOwnerRegistry({
            identity: buildRuntimeOwnerIdentityFromConfig({
                config,
                runtimeFingerprint,
            }),
            stateDir: resolveRuntimeOwnerStateDir({
                stateRoot: config.stateRoot,
                vectorStoreProvider: config.vectorStoreProvider,
                milvusEndpoint: config.milvusEndpoint,
                homeDir: os.homedir(),
            }),
        });
        try {
            this.runtimeOwnerRegistry.registerCurrentOwner();
            this.runtimeOwnerRegistered = true;
        } catch (error: unknown) {
            if (this.runtimeOwnerRegistry.isMaintenanceLocked()) throw error;
            console.warn(
                "[RUNTIME-OWNER] Failed to register current Satori runtime owner; "
                + `index mutations will fail closed until the owner registry is writable: ${errorMessage(error)}`,
            );
        }

        this.mutationRuntime = new RootMutationRuntime({
            stateDir: path.join(config.stateRoot, "runtime", "mutation-leases"),
        });
        this.publicationRuntime = createSharedPublicationRuntime(this.mutationRuntime, {
            stateRoot: config.stateRoot,
        });
        this.providerRuntime = new ProviderRuntime({
            config,
            runtimeFingerprint,
            capabilities: this.capabilities,
            readFileMaxLines: this.readFileMaxLines,
            readFileMaxBytes: this.readFileMaxBytes,
            watchSyncEnabled: this.watchSyncEnabled,
            startSyncLifecycle: runMode === "mcp" || runMode === "host",
            runtimeOwnerGate: this.runtimeOwnerRegistry,
            mutationRuntime: this.mutationRuntime,
            publicationRuntime: this.publicationRuntime,
            searchContinuationCoordinator: new SearchContinuationCoordinator(
                this.searchContinuationPool,
            ),
            onLifecycleActivityChanged: () => this.notifyActivityChanged(),
        });
        this.localContext = createLocalOnlyContext(
            config,
            this.mutationRuntime,
            this.publicationRuntime,
            this.providerRuntime.navigationStore,
        );
        this.localSyncManager = new SyncManager(this.localContext, {
            watchEnabled: this.watchSyncEnabled,
            mutationRuntime: this.mutationRuntime,
            onLifecycleActivityChanged: () => this.notifyActivityChanged(),
            preparedReadObservationSource: (codebasePath) => this.providerRuntime.getPreparedReadObservation(codebasePath),
            externalSyncFlightSource: (codebasePath) => this.providerRuntime.captureExternalSyncFlight(codebasePath),
            syncWorkerStandby: this.providerRuntime.externalSyncWorkerStandby,
        });

        if ((runMode === "mcp" || runMode === "host") && config.vectorStoreProvider === "LanceDB") {
            this.scheduleStartupStorageMaintenance();
        }
    }

    private scheduleStartupStorageMaintenance(): void {
        const task = Promise.resolve().then(() => {
            if (this.shutdownStarted) return;
            const parseNonNegativeNumber = (raw: string | undefined, fallback: number): number => {
                if (raw === undefined || raw.trim() === "") return fallback;
                const parsed = Number(raw);
                return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
            };
            const parseOptionalPositiveNumber = (raw: string | undefined): number | undefined => {
                if (raw === undefined || raw.trim() === "") return undefined;
                const parsed = Number(raw);
                return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            };
            const worktreeIdleDays = parseNonNegativeNumber(
                process.env.SATORI_WORKTREE_IDLE_DAYS,
                DEFAULT_WORKTREE_IDLE_DAYS,
            );
            const idleDays = parseOptionalPositiveNumber(process.env.SATORI_MAX_IDLE_DAYS);
            const maxStorageGib = parseNonNegativeNumber(
                process.env.SATORI_MAX_STORAGE_GIB,
                DEFAULT_MAX_STORAGE_GIB,
            );
            const defaultStateRoot = path.resolve(os.homedir(), ".satori");
            const defaultLanceDbPath = path.resolve(os.homedir(), ".satori", "vector", "lancedb");
            const configuredLanceDbPath = this.config.lanceDbPath ? path.resolve(this.config.lanceDbPath) : undefined;
            const vectorDbPath = configuredLanceDbPath === undefined
                ? null
                : (
                    path.resolve(this.config.stateRoot) !== defaultStateRoot
                    && configuredLanceDbPath === defaultLanceDbPath
                    && process.env.LANCEDB_PATH?.trim() !== configuredLanceDbPath
                )
                    ? null
                    : configuredLanceDbPath;
            const leasePort = createRootMutationLeasePort(this.mutationRuntime);
            const readerGuard = createStorageMaintenanceReaderGuard(this.publicationRuntime, this.mutationRuntime);
            const runMaintenance = () => runPublicationStorageMaintenance({
                stateRoot: this.config.stateRoot,
                soleOwner: true,
                vectorStoreProvider: this.config.vectorStoreProvider,
                vectorDbPath,
                worktreeIdleDays,
                idleDays,
                maxStorageBytes: Math.round(maxStorageGib * (1024 ** 3)),
                isRootMutationActive: (canonicalRoot, rootKey) => (
                    leasePort.isRootMutationActive(canonicalRoot, rootKey)
                    || (canonicalRoot.length > 0 && Boolean(this.mutationRuntime.getActiveMutation(canonicalRoot)))
                ),
                hasAnyActiveOrUnverifiableLease: () => leasePort.hasAnyActiveOrUnverifiableLease(),
                runWithRootMutationLease: (canonicalRoot, rootKey, fn) => (
                    leasePort.runWithRootMutationLease(canonicalRoot, rootKey, fn)
                ),
                withGenerationLeaseGuard: (canonicalRoot, generationId, fn) => (
                    readerGuard.withGenerationLeaseGuard(canonicalRoot, generationId, fn)
                ),
                withRootLeaseGuard: (canonicalRoot, fn) => (
                    readerGuard.withRootLeaseGuard(canonicalRoot, fn)
                ),
            });
            let result: ReturnType<typeof runPublicationStorageMaintenance> | undefined;
            if (this.runtimeOwnerRegistered) {
                this.runtimeOwnerRegistry.withSoleRegisteredOwnerLock(() => {
                    if (!this.shutdownStarted) result = runMaintenance();
                });
            }
            if (!result) return;
            const soleOwner = result.soleOwner;
            if (
                result.reclaimedBytes > 0
                || result.removedRoots.length > 0
                || result.removedRetiredGenerations.length > 0
                || result.removedOrphanCollections.length > 0
            ) {
                const mib = (result.reclaimedBytes / (1024 * 1024)).toFixed(1);
                console.log(
                    `[STORAGE-GC] Reclaimed ${mib} MiB (roots=${result.removedRoots.length}, `
                    + `retiredGenerations=${result.removedRetiredGenerations.length}, `
                    + `orphanCollections=${result.removedOrphanCollections.length}, soleOwner=${soleOwner}).`,
                );
            }
        }).catch((error: unknown) => {
            console.warn(`[STORAGE-GC] Startup storage maintenance failed: ${errorMessage(error)}`);
        });
        this.ownDetachedMutationCompletion(task);
    }

    createSession(
        workspacePolicy: SessionWorkspacePolicy,
        options?: { autoIndexOnStart?: boolean },
    ): McpSession {
        if (this.shutdownStarted) {
            throw new Error("Shared Satori runtime host is shutting down.");
        }
        return new McpSession(this, workspacePolicy, options);
    }

    async indexWorkspaceRoots(policy: SessionWorkspacePolicy): Promise<void> {
        if (!this.config.autoIndexWorkspace || this.config.executionProfile !== "offline") return;
        for (const root of policy.roots) {
            if (this.shutdownStarted) return;
            let authorized;
            try {
                authorized = policy.authorizeRoot(root);
            } catch (error) {
                if (error instanceof WorkspaceAuthorizationError && error.code === "BROAD_ROOT_NOT_ALLOWED") {
                    // Implicit IDE container roots ($HOME or /) are never indexed directly;
                    // descendant Git repositories auto-index on first tool demand.
                    continue;
                }
                throw error;
            }
            let targetPath = authorized.canonicalPath;
            let cursor = authorized.canonicalPath;
            for (;;) {
                if (fs.existsSync(path.join(cursor, ".git"))) {
                    try {
                        targetPath = policy.authorizeRoot(cursor).canonicalPath;
                    } catch {
                        targetPath = authorized.canonicalPath;
                    }
                    break;
                }
                const parent = path.dirname(cursor);
                if (parent === cursor) break;
                cursor = parent;
            }
            try {
                await this.providerRuntime.requestWorkspaceIndexing(targetPath);
            } catch (error) {
                console.warn(`[AUTO-INDEX] '${targetPath}': ${errorMessage(error)}`);
            }
        }
    }

    createSearchContinuationCoordinator(): SearchContinuationCoordinator {
        return new SearchContinuationCoordinator(this.searchContinuationPool);
    }

    createSessionResources(
        continuationCoordinator: SearchContinuationCoordinator,
        workspacePolicy: SessionWorkspacePolicy,
    ): SessionResources {
        const localHandlers = new ToolHandlers(
            this.localContext,
            this.localSyncManager,
            this.runtimeFingerprint,
            this.capabilities,
            this.mutationRuntime,
            () => Date.now(),
            null,
            undefined,
            this.providerRuntime.navigationStore,
            this.runtimeOwnerRegistry,
            continuationCoordinator,
            {
                readFileMaxBytes: this.readFileMaxBytes,
                collectPublicationGarbageAfterSync: async (codebasePath) => {
                    const providerContext = await this.providerRuntime.requireToolContext("vector_only");
                    if (isMissingProviderConfigIssue(providerContext)) {
                        throw new Error(providerContext.message);
                    }
                    return providerContext.context.collectPublicationGarbage(codebasePath);
                },
                ownDetachedMutationCompletion: (completion) => this.ownDetachedMutationCompletion(completion),
                isAutomaticIndexing: (codebasePath) => this.providerRuntime.isAutomaticIndexing(codebasePath),
                ...workspaceIndexRequests(workspacePolicy, this.providerRuntime),
                reclaimIdleMemoryForMutation: () => this.providerRuntime.reclaimIdleMemoryForMutation(),
            },
        );
        const providerRuntime = new SessionProviderRuntime(
            this.providerRuntime,
            continuationCoordinator,
            this.mutationRuntime,
            workspacePolicy,
        );
        return {
            localHandlers,
            providerRuntime,
            toolContext: {
                context: this.localContext,
                mutationRuntime: this.mutationRuntime,
                syncManager: this.localSyncManager,
                capabilities: this.capabilities,
                reranker: null,
                runtimeFingerprint: this.runtimeFingerprint,
                toolHandlers: localHandlers,
                readFileMaxLines: this.readFileMaxLines,
                readFileMaxBytes: this.readFileMaxBytes,
                runtimeOwnerGate: this.runtimeOwnerRegistry,
                providerRuntime,
                workspacePolicy,
            },
        };
    }

    registerSession(): void {
        this.activeSessions += 1;
        this.notifyActivityChanged();
    }

    unregisterSession(): void {
        this.activeSessions = Math.max(0, this.activeSessions - 1);
        this.notifyActivityChanged();
    }

    beginOperation(): void {
        this.activeOperations += 1;
        this.notifyActivityChanged();
    }

    endOperation(): void {
        this.activeOperations = Math.max(0, this.activeOperations - 1);
        this.notifyActivityChanged();
    }

    private ownDetachedMutationCompletion(completion: Promise<void>): void {
        if (this.detachedMutationCompletions.has(completion)) return;
        this.detachedMutationCompletions.add(completion);
        this.notifyActivityChanged();
        void completion.then(
            () => this.releaseDetachedMutationCompletion(completion),
            () => this.releaseDetachedMutationCompletion(completion),
        );
    }

    private releaseDetachedMutationCompletion(completion: Promise<void>): void {
        if (!this.detachedMutationCompletions.delete(completion)) return;
        this.notifyActivityChanged();
    }

    private async drainDetachedMutationCompletions(): Promise<void> {
        while (this.detachedMutationCompletions.size > 0) {
            await Promise.allSettled([...this.detachedMutationCompletions]);
        }
    }

    getActivity(): Readonly<{ sessions: number; operations: number }> {
        return Object.freeze({
            sessions: this.activeSessions,
            operations: this.activeOperations
                + this.detachedMutationCompletions.size
                + this.providerRuntime.getActiveLifecycleOperationCount()
                + this.localSyncManager.getActiveLifecycleOperationCount(),
        });
    }

    getProviderRuntime(): ProviderRuntime {
        return this.providerRuntime;
    }

    subscribeActivity(listener: () => void): () => void {
        this.activityListeners.add(listener);
        return () => this.activityListeners.delete(listener);
    }

    private notifyActivityChanged(): void {
        for (const listener of this.activityListeners) {
            listener();
        }
    }

    async shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shutdownStarted = true;
        this.shutdownPromise = (async () => {
            await this.localSyncManager.stopAndDrainLifecycle();
            await this.drainDetachedMutationCompletions();
            await this.localContext.dispose?.();
            await this.providerRuntime.shutdown();
            this.searchContinuationPool.clear();
            this.runtimeOwnerRegistry.unregisterCurrentOwner();
        })();
        return this.shutdownPromise;
    }
}

const SATORI_MCP_INSTRUCTIONS = "Satori is a repository code-intelligence layer for coding agents. Use search_codebase for unfamiliar behavior, ownership, symbols, configuration, or related implementation; then follow recommendedNextAction into read_file, file_outline, continue_search, or call_graph. For a plain-English search_codebase question, also pass likely code identifiers in alt_terms: grounded guesses raise owner recall, unrelated ones rank worse than none. Use trace_path when both exact published symbol IDs are known and you need one bounded relationship path between them. Use find_references when a canonical symbol is known and exact published-source occurrence coverage is needed without ranking. Prefer the host's native exact-file or literal workflow when the path and location are already known or the edit is small and local. Treat call_graph as conservative navigation evidence, not complete blast-radius proof; observational source references never become CALLS without semantic proof. Use list_codebases or manage_index status detail=full when index readiness or structural coverage is uncertain; that coverage is bounded by the current Publication policy. Use read_file on a specific absolute path for an exact published-path coverage check. Satori gates background auto-indexing by eligible source bytes (with a 50k-file OOM fuse): offline runtimes auto-index <=20 MiB workspaces on session start and <=150 MiB workspaces on first tool call, and connected/Voyage runtimes auto-index <=8 MiB (~2M-token) workspaces on first tool call (reported via status=\"not_ready\" and indexing.mode=\"auto_indexing\"). Never ask the user whether to index or migrate within those automatic budgets—use native read/grep tools or wait briefly and retry. Only ask the user before manage_index action=\"create\" or \"reindex\" when status remains not_indexed/requires_reindex because a repository exceeds the paid API budget (>8 MiB on Voyage) or massive monorepo limits (>150 MiB or >50k files). Never run action=\"clear\" unless the user explicitly asks for a reset.";

export class McpSession {
    private readonly server: Server;
    private readonly continuationCoordinator: SearchContinuationCoordinator;
    private readonly resources: SessionResources;
    private activeToolCalls = 0;
    private connected = false;
    private closed = false;
    private shutdownPromise: Promise<void> | null = null;
    private resourcesReleased = false;
    private resourceReleasePromise: Promise<void> | null = null;
    private resolveResourceRelease: (() => void) | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;

    private readonly autoIndexOnStart: boolean;

    constructor(
        private readonly host: SharedRuntimeHost,
        private readonly workspacePolicy: SessionWorkspacePolicy,
        options?: { autoIndexOnStart?: boolean },
    ) {
        this.autoIndexOnStart = options?.autoIndexOnStart !== false;
        this.continuationCoordinator = host.createSearchContinuationCoordinator();
        this.server = new Server(
            {
                name: host.config.name,
                version: host.config.version,
            },
            {
                capabilities: {
                    tools: {},
                },
                instructions: [SATORI_MCP_INSTRUCTIONS, "Use architecture_overview for repository-wide areas, cross-area boundaries, and hotspots."].join(" "),
            },
        );
        this.resources = host.createSessionResources(
            this.continuationCoordinator,
            workspacePolicy,
        );
        this.setupTools();
        this.server.oninitialized = () => {
            if (
                this.closed
                || !this.autoIndexOnStart
                || !host.config.autoIndexWorkspace
                || host.config.executionProfile !== "offline"
            ) return;
            this.activeToolCalls += 1;
            this.host.beginOperation();
            void this.host.indexWorkspaceRoots(this.workspacePolicy).catch((error) => {
                console.warn(`[AUTO-INDEX] ${errorMessage(error)}`);
            }).finally(() => {
                this.activeToolCalls -= 1;
                this.host.endOperation();
                this.releaseResourcesIfIdle();
            });
        };
    }

    private setupTools(): void {
        this.server.setRequestHandler('tools/list', async () => ({
            tools: getMcpToolList(this.resources.toolContext),
        }));

        this.server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
            const { name, arguments: args } = request.params;
            const tool = toolRegistry[name];
            if (!tool) {
                return {
                    content: [{
                        type: "text",
                        text: `Unknown tool: ${name}. Supported tools: ${Object.keys(toolRegistry).join(", ")}`,
                    }],
                    isError: true,
                };
            }
            if (this.activeToolCalls >= SHARED_RUNTIME_MAX_PENDING_REQUESTS) {
                return {
                    content: [{
                        type: "text",
                        text: `This Satori session already has ${SHARED_RUNTIME_MAX_PENDING_REQUESTS} active tool calls. Wait for one to finish, then retry.`,
                    }],
                    isError: true,
                };
            }

            this.activeToolCalls += 1;
            this.host.beginOperation();
            try {
                // Mixed-action tools retain the launcher policy and opt in
                // after validating their read operation.
                const publishedReadPolicy = PUBLISHED_READ_TOOLS.has(name)
                    ? this.workspacePolicy.createPublishedReadPolicy?.() : undefined;
                const requestToolContext: ToolContext = {
                    ...this.resources.toolContext,
                    workspacePolicy: publishedReadPolicy ?? this.workspacePolicy,
                    requestSignal: ctx.mcpReq.signal,
                };
                return await withSourceMeasurementOperation(
                    { operation: name },
                    () => tool.execute(args || {}, requestToolContext),
                ) as CallToolResult;
            } finally {
                this.activeToolCalls -= 1;
                this.host.endOperation();
                this.releaseResourcesIfIdle();
            }
        });
    }

    async connect(transport: Transport, resumeInput?: Readable): Promise<void> {
        if (this.connected) {
            throw new Error("MCP session is already connected.");
        }
        this.connected = true;
        this.host.registerSession();
        try {
            await this.server.connect(transport);
            resumeInput?.resume();
        } catch (error) {
            this.host.unregisterSession();
            this.connected = false;
            throw error;
        }
    }

    async connectStdio(input?: Readable, output?: Writable): Promise<void> {
        const transportInput = input ?? process.stdin;
        const transportOutput = output ?? process.stdout;
        await this.connect(
            new StdioServerTransport(transportInput, transportOutput),
            transportInput,
        );
        this.keepAliveTimer = setInterval(() => {
            // Keep direct stdio sessions alive when provider lifecycle is lazy.
        }, 60 * 60 * 1000);
    }

    shutdown(): Promise<void> {
        if (!this.shutdownPromise) {
            this.shutdownPromise = this.performShutdown();
        }
        return this.shutdownPromise;
    }

    private async performShutdown(): Promise<void> {
        this.closed = true;
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.connected) {
            this.connected = false;
            this.host.unregisterSession();
        }
        await this.server.close().catch(() => undefined);
        if (this.activeToolCalls > 0) {
            this.resourceReleasePromise = new Promise<void>((resolve) => {
                this.resolveResourceRelease = resolve;
            });
            await this.resourceReleasePromise;
        } else {
            this.releaseResourcesIfIdle();
        }
    }

    private releaseResourcesIfIdle(): void {
        if (!this.closed || this.activeToolCalls > 0 || this.resourcesReleased) return;
        this.resourcesReleased = true;
        this.resources.localHandlers.releaseSearchContinuationOwnership();
        this.resources.providerRuntime.release();
        this.resolveResourceRelease?.();
        this.resolveResourceRelease = null;
    }
}
