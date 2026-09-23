import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { withSourceMeasurementOperation } from "@zokizuan/satori-core";
import { resolveRuntimeOwnerStateDir } from "@zokizuan/satori-core/integration";
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
} from "@zokizuan/satori-core/integration";
import {
    RuntimeOwnerRegistry,
    buildRuntimeOwnerIdentityFromConfig,
} from "../core/runtime-owner.js";
import {
    WorkspaceAuthorizationError,
    createSessionWorkspacePolicy,
    type SessionWorkspacePolicy,
} from "../core/session-workspace-policy.js";
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
 *
 * Broad roots (filesystem root, home directory, state root) are rejected
 * unless SATORI_ALLOW_BROAD_ROOTS=true explicitly opts in.
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

export function resolveAllowBroadRoots(env: NodeJS.ProcessEnv): boolean {
    return env.SATORI_ALLOW_BROAD_ROOTS?.toLowerCase() === "true";
}

export function createSessionWorkspacePolicyFromEnv(env: NodeJS.ProcessEnv): SessionWorkspacePolicy {
    return createSessionWorkspacePolicy({
        roots: resolveSessionWorkspaceRoots(env),
        homeDirectory: os.homedir(),
        stateRoot: env.SATORI_STATE_ROOT ?? path.join(env.HOME ?? os.homedir(), ".satori"),
        allowBroadRoots: resolveAllowBroadRoots(env),
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
        private readonly mutationRuntime: RootMutationRuntime,
        private readonly workspacePolicy: SessionWorkspacePolicy,
    ) {}

    async requireToolContext(
        operation: ProviderBackedOperation,
        request: { signal?: AbortSignal } = {},
    ): Promise<ToolContext | MissingProviderConfigIssue> {
        const shared = await this.providerRuntime.requireToolContext(operation);
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
            undefined,
            shared.runtimeOwnerGate,
            this.continuationCoordinator,
            {
                readFileMaxBytes: shared.readFileMaxBytes,
                ownDetachedMutationCompletion: (completion) => this.providerRuntime.ownDetachedMutationCompletion(completion),
                requestAutomaticReindex: (codebasePath, reason) => (
                    this.providerRuntime.requestAutomaticReindex(codebasePath, reason)
                ),
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
        } catch (error: unknown) {
            console.warn(
                "[RUNTIME-OWNER] Failed to register current Satori runtime owner; "
                + `index mutations will fail closed until the owner registry is writable: ${errorMessage(error)}`,
            );
        }

        this.mutationRuntime = new RootMutationRuntime();
        this.publicationRuntime = createSharedPublicationRuntime(this.mutationRuntime, {
            stateRoot: config.stateRoot,
        });
        this.localContext = createLocalOnlyContext(
            config,
            this.mutationRuntime,
            this.publicationRuntime,
        );
        this.localSyncManager = new SyncManager(this.localContext, {
            watchEnabled: this.watchSyncEnabled,
            mutationRuntime: this.mutationRuntime,
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

    }

    createSession(workspacePolicy: SessionWorkspacePolicy): McpSession {
        if (this.shutdownStarted) {
            throw new Error("Shared Satori runtime host is shutting down.");
        }
        return new McpSession(this, workspacePolicy);
    }

    async indexWorkspaceRoots(policy: SessionWorkspacePolicy): Promise<void> {
        if (!this.config.autoIndexWorkspace || this.config.executionProfile !== "offline") return;
        for (const root of policy.roots) {
            if (this.shutdownStarted) return;
            const authorized = policy.authorizeRoot(root);
            try {
                await this.providerRuntime.requestWorkspaceIndexing(authorized.canonicalPath);
            } catch (error) {
                console.warn(`[AUTO-INDEX] '${authorized.canonicalPath}': ${errorMessage(error)}`);
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
            undefined,
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
                requestAutomaticReindex: (codebasePath, reason) => (
                    this.providerRuntime.requestAutomaticReindex(codebasePath, reason)
                ),
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

const SATORI_MCP_INSTRUCTIONS = "Satori is a repository code-intelligence layer for coding agents. Use search_codebase for unfamiliar behavior, ownership, symbols, configuration, or related implementation; then follow recommendedNextAction into read_file, file_outline, continue_search, or call_graph. Use trace_path when both exact published symbol IDs are known and you need one bounded relationship path between them. Use find_references when a canonical symbol is known and exact published-source occurrence coverage is needed without ranking. Prefer the host's native exact-file or literal workflow when the path and location are already known or the edit is small and local. Treat call_graph as conservative navigation evidence, not complete blast-radius proof; observational source references never become CALLS without semantic proof. Use list_codebases or manage_index status detail=full when index readiness or structural coverage is uncertain; that coverage is bounded by the current Publication policy. Use read_file on a specific absolute path for an exact published-path coverage check. Managed offline runtimes automatically rebuild a tracked incompatible Publication in the background; retry after the returned not_ready/indexing hint.";

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
                instructions: [SATORI_MCP_INSTRUCTIONS, "Use architecture_overview for repository-wide areas, cross-area boundaries, and hotspots."].join(" "),
            },
        );
        this.resources = host.createSessionResources(
            this.continuationCoordinator,
            workspacePolicy,
        );
        this.setupTools();
        this.server.oninitialized = () => {
            if (this.closed || !host.config.autoIndexWorkspace || host.config.executionProfile !== "offline") return;
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
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: getMcpToolList(this.resources.toolContext),
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
                const requestToolContext: ToolContext = {
                    ...this.resources.toolContext,
                    requestSignal: extra.signal,
                };
                return await withSourceMeasurementOperation(
                    { operation: name },
                    () => tool.execute(args || {}, requestToolContext),
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
