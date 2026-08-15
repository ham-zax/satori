import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { withSourceMeasurementOperation } from "@zokizuan/satori-core";
import type { ContextMcpConfig, IndexFingerprint } from "../config.js";
import { CapabilityResolver } from "../core/capabilities.js";
import { resolveRuntimeOwnerStateDir } from "../core/runtime-state-root.js";
import { CallGraphSidecarManager } from "../core/call-graph.js";
import {
    SearchContinuationCoordinator,
    SearchContinuationCoordinatorPool,
    ToolHandlers,
} from "../core/handlers.js";
import { MutationLeaseCoordinator } from "../core/mutation-lease.js";
import {
    RuntimeOwnerRegistry,
    buildRuntimeOwnerIdentityFromConfig,
} from "../core/runtime-owner.js";
import {
    WorkspaceAuthorizationError,
    createSessionWorkspacePolicy,
    type SessionWorkspacePolicy,
} from "../core/session-workspace-policy.js";
import { SnapshotManager } from "../core/snapshot.js";
import { SyncManager } from "../core/sync.js";
import { getMcpToolList, toolRegistry } from "../tools/registry.js";
import type {
    MissingProviderConfigIssue,
    ProviderBackedOperation,
    ToolContext,
    ToolResponse,
} from "../tools/types.js";
import { createLocalOnlyContext, ProviderRuntime } from "./provider-runtime.js";
import { SHARED_RUNTIME_MAX_PENDING_REQUESTS } from "./shared-runtime-identity.js";

export type ServerRunMode = "mcp" | "cli" | "postflight" | "host";

/**
 * Session workspace root rule: SATORI_SESSION_ROOTS_JSON when present,
 * otherwise [process.cwd()]. Returns the same roots for direct stdio sessions
 * and for the shared-runtime launcher, so both paths construct identical
 * session workspace policies.
 */
export const SESSION_WORKSPACE_ROOTS_MAX = 16;

export function resolveSessionWorkspaceRoots(env: NodeJS.ProcessEnv): readonly string[] {
    const raw = env.SATORI_SESSION_ROOTS_JSON;
    if (raw === undefined || raw === "") {
        return [process.cwd()];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new WorkspaceAuthorizationError(
            "INVALID_WORKSPACE_ROOT",
            "SATORI_SESSION_ROOTS_JSON must be a JSON array of 1-16 absolute path strings.",
        );
    }
    if (
        !Array.isArray(parsed)
        || parsed.length < 1
        || parsed.length > SESSION_WORKSPACE_ROOTS_MAX
    ) {
        throw new WorkspaceAuthorizationError(
            "INVALID_WORKSPACE_ROOT",
            `SATORI_SESSION_ROOTS_JSON must be a JSON array of 1-${SESSION_WORKSPACE_ROOTS_MAX} absolute path strings.`,
        );
    }
    for (const entry of parsed) {
        if (typeof entry !== "string" || !path.isAbsolute(entry)) {
            throw new WorkspaceAuthorizationError(
                "INVALID_WORKSPACE_ROOT",
                "SATORI_SESSION_ROOTS_JSON entries must be absolute path strings.",
            );
        }
    }
    return parsed;
}

export function createSessionWorkspacePolicyFromEnv(env: NodeJS.ProcessEnv): SessionWorkspacePolicy {
    return createSessionWorkspacePolicy({
        roots: resolveSessionWorkspaceRoots(env),
        homeDirectory: os.homedir(),
        stateRoot: env.SATORI_STATE_ROOT ?? path.join(env.HOME ?? os.homedir(), ".satori"),
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

class SessionProviderRuntime {
    private readonly contexts = new Map<ToolContext, ToolContext>();
    private readonly handlers = new Set<ToolHandlers>();

    constructor(
        private readonly providerRuntime: ProviderRuntime,
        private readonly continuationCoordinator: SearchContinuationCoordinator,
        private readonly mutationLeaseCoordinator: MutationLeaseCoordinator,
        private readonly callGraphManager: CallGraphSidecarManager,
        private readonly workspacePolicy: SessionWorkspacePolicy,
    ) {}

    async requireToolContext(
        operation: ProviderBackedOperation,
    ): Promise<ToolContext | MissingProviderConfigIssue> {
        const shared = await this.providerRuntime.requireToolContext(operation);
        if (isMissingProviderConfigIssue(shared)) {
            return shared;
        }

        const existing = this.contexts.get(shared);
        if (existing) {
            return existing;
        }

        const toolHandlers = new ToolHandlers(
            shared.context,
            shared.snapshotManager,
            shared.syncManager,
            shared.runtimeFingerprint,
            shared.capabilities,
            () => Date.now(),
            this.callGraphManager,
            shared.reranker,
            undefined,
            undefined,
            shared.runtimeOwnerGate,
            this.mutationLeaseCoordinator,
            this.continuationCoordinator,
            { readFileMaxBytes: shared.readFileMaxBytes },
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
        return sessionContext;
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
    private readonly snapshotManager: SnapshotManager;
    private readonly callGraphManager: CallGraphSidecarManager;
    private readonly runtimeOwnerRegistry: RuntimeOwnerRegistry;
    private readonly mutationLeaseCoordinator: MutationLeaseCoordinator;
    private readonly localContext: ReturnType<typeof createLocalOnlyContext>;
    private readonly localSyncManager: SyncManager;
    private readonly searchContinuationPool = new SearchContinuationCoordinatorPool();
    private readonly providerRuntime: ProviderRuntime;
    private readonly readFileMaxLines: number;
    private readonly readFileMaxBytes: number;
    private readonly watchSyncEnabled: boolean;
    private readonly watchDebounceMs: number;
    private activeSessions = 0;
    private activeOperations = 0;
    private shutdownStarted = false;
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
        this.watchDebounceMs = Math.max(1, config.watchDebounceMs ?? 5000);
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
        } catch (error: unknown) {
            console.warn(
                "[RUNTIME-OWNER] Failed to register current Satori runtime owner; "
                + `index mutations will fail closed until the owner registry is writable: ${errorMessage(error)}`,
            );
        }

        this.mutationLeaseCoordinator = new MutationLeaseCoordinator();
        this.snapshotManager = new SnapshotManager(runtimeFingerprint);
        this.callGraphManager = new CallGraphSidecarManager(runtimeFingerprint);
        this.localContext = createLocalOnlyContext(config, this.mutationLeaseCoordinator);
        this.localSyncManager = new SyncManager(this.localContext, this.snapshotManager, {
            watchEnabled: this.watchSyncEnabled,
            watchDebounceMs: this.watchDebounceMs,
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
            sourceFreshnessPort: this.localContext.getSourceFreshnessPort(),
        });
        this.providerRuntime = new ProviderRuntime({
            config,
            snapshotManager: this.snapshotManager,
            runtimeFingerprint,
            capabilities: this.capabilities,
            readFileMaxLines: this.readFileMaxLines,
            readFileMaxBytes: this.readFileMaxBytes,
            watchSyncEnabled: this.watchSyncEnabled,
            watchDebounceMs: this.watchDebounceMs,
            startSyncLifecycle: runMode === "mcp" || runMode === "host",
            callGraphManager: this.callGraphManager,
            runtimeOwnerGate: this.runtimeOwnerRegistry,
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
            searchContinuationCoordinator: new SearchContinuationCoordinator(
                this.searchContinuationPool,
            ),
            onLifecycleActivityChanged: () => this.notifyActivityChanged(),
        });

        this.snapshotManager.loadCodebaseSnapshot();
    }

    createSession(workspacePolicy: SessionWorkspacePolicy): McpSession {
        if (this.shutdownStarted) {
            throw new Error("Shared Satori runtime host is shutting down.");
        }
        return new McpSession(this, workspacePolicy);
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
            this.snapshotManager,
            this.localSyncManager,
            this.runtimeFingerprint,
            this.capabilities,
            () => Date.now(),
            this.callGraphManager,
            null,
            undefined,
            undefined,
            this.runtimeOwnerRegistry,
            this.mutationLeaseCoordinator,
            continuationCoordinator,
            { readFileMaxBytes: this.readFileMaxBytes },
        );
        const providerRuntime = new SessionProviderRuntime(
            this.providerRuntime,
            continuationCoordinator,
            this.mutationLeaseCoordinator,
            this.callGraphManager,
            workspacePolicy,
        );
        return {
            localHandlers,
            providerRuntime,
            toolContext: {
                context: this.localContext,
                snapshotManager: this.snapshotManager,
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

    getActivity(): Readonly<{ sessions: number; operations: number }> {
        return Object.freeze({
            sessions: this.activeSessions,
            operations: this.activeOperations
                + this.providerRuntime.getActiveLifecycleOperationCount(),
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

    async recoverInterruptedIndexingAtStartup(): Promise<void> {
        if (this.snapshotManager.getIndexingCodebases().length === 0) {
            console.log("[STARTUP] No interrupted indexing states required recovery");
            return;
        }
        const providerContext = await this.providerRuntime.requireToolContext("vector_only");
        if (isMissingProviderConfigIssue(providerContext)) {
            console.warn(
                `[STARTUP] Deferred interrupted-index recovery: ${providerContext.message}`,
            );
            return;
        }
        await providerContext.toolHandlers.recoverInterruptedIndexingAtStartup();
    }

    async shutdown(): Promise<void> {
        if (this.shutdownStarted) return;
        this.shutdownStarted = true;
        await this.localSyncManager.stopAndDrainLifecycle();
        await this.localContext.dispose?.();
        await this.providerRuntime.shutdown();
        this.searchContinuationPool.clear();
        this.runtimeOwnerRegistry.unregisterCurrentOwner();
    }
}

export class McpSession {
    private readonly server: Server;
    private readonly continuationCoordinator: SearchContinuationCoordinator;
    private readonly resources: SessionResources;
    private activeToolCalls = 0;
    private connected = false;
    private closed = false;
    private resourcesReleased = false;
    private resourceReleasePromise: Promise<void> | null = null;
    private resolveResourceRelease: (() => void) | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly host: SharedRuntimeHost,
        private readonly workspacePolicy: SessionWorkspacePolicy,
    ) {
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
            },
        );
        this.resources = host.createSessionResources(
            this.continuationCoordinator,
            workspacePolicy,
        );
        this.setupTools();
    }

    private setupTools(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: getMcpToolList(this.resources.toolContext),
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
                return await withSourceMeasurementOperation(
                    { operation: name },
                    () => tool.execute(args || {}, this.resources.toolContext),
                ) as ToolResponse;
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

    async shutdown(): Promise<void> {
        if (this.closed) return;
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
