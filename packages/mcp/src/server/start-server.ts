import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
    buildRuntimeIndexFingerprint,
    ContextMcpConfig,
    createMcpConfig,
    IndexFingerprint,
    logConfigurationSummary,
    showHelpMessage,
} from "../config.js";
import { CapabilityResolver } from "../core/capabilities.js";
import { SnapshotManager } from "../core/snapshot.js";
import { SyncManager } from "../core/sync.js";
import { ToolHandlers } from "../core/handlers.js";
import { CallGraphSidecarManager } from "../core/call-graph.js";
import {
    RuntimeOwnerRegistry,
    buildRuntimeOwnerIdentityFromConfig,
} from "../core/runtime-owner.js";
import { MutationLeaseCoordinator } from "../core/mutation-lease.js";
import { ToolContext } from "../tools/types.js";
import { getMcpToolList, toolRegistry } from "../tools/registry.js";
import { createLocalOnlyContext, ProviderRuntime, resolveConfiguredEmbeddingDimension } from "./provider-runtime.js";

export type ServerRunMode = "mcp" | "cli" | "postflight";

export interface StartMcpServerOptions {
    runMode?: ServerRunMode;
    protocolStdin?: Readable;
    protocolStdout?: Writable;
    args?: string[];
}

interface StartupLifecycleSyncManager {
    startBackgroundSync(): void;
    startWatcherMode(): Promise<void>;
}

interface StartupLifecycleDependencies {
    watchSyncEnabled: boolean;
    verifyCloudState: () => Promise<void>;
    onVerifyCloudStateError: (error: unknown) => void;
    syncManager: StartupLifecycleSyncManager;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function runPostConnectStartupLifecycle(
    runMode: ServerRunMode,
    dependencies: StartupLifecycleDependencies
): Promise<void> {
    if (runMode === "postflight") {
        return;
    }
    if (runMode === "cli") {
        try {
            await dependencies.verifyCloudState();
        } catch (error) {
            dependencies.onVerifyCloudStateError(error);
        }
        return;
    }

    void dependencies.verifyCloudState().catch((error) => {
        dependencies.onVerifyCloudStateError(error);
    });
    dependencies.syncManager.startBackgroundSync();
    if (dependencies.watchSyncEnabled) {
        await dependencies.syncManager.startWatcherMode();
    }
}

function migrateLegacyStateDir(): void {
    const homeDir = os.homedir();
    const legacyDir = path.join(homeDir, ".context");
    const newDir = path.join(homeDir, ".satori");

    if (fs.existsSync(newDir) || !fs.existsSync(legacyDir)) {
        return;
    }

    try {
        fs.renameSync(legacyDir, newDir);
        console.log(`[MIGRATION] Moved legacy state directory '${legacyDir}' -> '${newDir}'`);
        return;
    } catch {
        // Fallback for cross-device moves: copy then remove.
    }

    try {
        fs.cpSync(legacyDir, newDir, { recursive: true, force: false, errorOnExist: true });
        fs.rmSync(legacyDir, { recursive: true, force: true });
        console.log(`[MIGRATION] Copied legacy state directory '${legacyDir}' -> '${newDir}' and removed source`);
    } catch (copyError) {
        console.error(`[MIGRATION] Failed to migrate '${legacyDir}' -> '${newDir}':`, errorMessage(copyError));
    }
}

class ContextMcpServer {
    private server: Server;
    private toolContext: ToolContext;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;
    private capabilities: CapabilityResolver;
    private runtimeFingerprint: IndexFingerprint;
    private readFileMaxLines: number;
    private watchSyncEnabled: boolean;
    private watchDebounceMs: number;
    private callGraphManager: CallGraphSidecarManager;
    private providerRuntime: ProviderRuntime;
    private runtimeOwnerRegistry: RuntimeOwnerRegistry;
    private mutationLeaseCoordinator: MutationLeaseCoordinator;
    private runMode: ServerRunMode;
    private protocolStdin?: Readable;
    private protocolStdout?: Writable;
    private keepAliveTimer: NodeJS.Timeout | null = null;

    constructor(config: ContextMcpConfig, runMode: ServerRunMode, protocolStdout?: Writable, protocolStdin?: Readable) {
        this.runMode = runMode;
        this.protocolStdin = protocolStdin;
        this.protocolStdout = protocolStdout;

        this.server = new Server(
            {
                name: config.name,
                version: config.version,
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.capabilities = new CapabilityResolver(config);
        this.runtimeFingerprint = buildRuntimeIndexFingerprint(config, resolveConfiguredEmbeddingDimension(config));
        this.readFileMaxLines = Math.max(1, config.readFileMaxLines ?? 1000);
        this.watchSyncEnabled = config.watchSyncEnabled === true;
        this.watchDebounceMs = Math.max(1, config.watchDebounceMs ?? 5000);
        console.log(`[FINGERPRINT] Runtime index fingerprint: ${JSON.stringify(this.runtimeFingerprint)}`);
        this.runtimeOwnerRegistry = new RuntimeOwnerRegistry({
            identity: buildRuntimeOwnerIdentityFromConfig({
                config,
                runtimeFingerprint: this.runtimeFingerprint,
            }),
        });
        try {
            this.runtimeOwnerRegistry.registerCurrentOwner();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[RUNTIME-OWNER] Failed to register current Satori runtime owner; index mutations will fail closed until the owner registry is writable: ${message}`);
        }
        this.mutationLeaseCoordinator = new MutationLeaseCoordinator();

        this.snapshotManager = new SnapshotManager(this.runtimeFingerprint);
        this.callGraphManager = new CallGraphSidecarManager(this.runtimeFingerprint);
        const localContext = createLocalOnlyContext(config, this.mutationLeaseCoordinator);
        this.syncManager = new SyncManager(localContext, this.snapshotManager, {
            watchEnabled: this.watchSyncEnabled,
            watchDebounceMs: this.watchDebounceMs,
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
        });
        this.toolHandlers = new ToolHandlers(
            localContext,
            this.snapshotManager,
            this.syncManager,
            this.runtimeFingerprint,
            this.capabilities,
            () => Date.now(),
            this.callGraphManager,
            null,
            undefined,
            undefined,
            this.runtimeOwnerRegistry,
            this.mutationLeaseCoordinator,
        );
        this.providerRuntime = new ProviderRuntime({
            config,
            snapshotManager: this.snapshotManager,
            runtimeFingerprint: this.runtimeFingerprint,
            capabilities: this.capabilities,
            readFileMaxLines: this.readFileMaxLines,
            watchSyncEnabled: this.watchSyncEnabled,
            watchDebounceMs: this.watchDebounceMs,
            callGraphManager: this.callGraphManager,
            runtimeOwnerGate: this.runtimeOwnerRegistry,
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
        });
        this.toolContext = {
            context: localContext,
            snapshotManager: this.snapshotManager,
            syncManager: this.syncManager,
            capabilities: this.capabilities,
            reranker: null,
            runtimeFingerprint: this.runtimeFingerprint,
            toolHandlers: this.toolHandlers,
            readFileMaxLines: this.readFileMaxLines,
            runtimeOwnerGate: this.runtimeOwnerRegistry,
            providerRuntime: this.providerRuntime,
        };

        this.snapshotManager.loadCodebaseSnapshot();
        this.setupTools();
    }

    private getCliTransportStdout(): Writable {
        if (this.protocolStdout) {
            return this.protocolStdout;
        }
        if (this.runMode !== "cli") {
            return process.stdout;
        }
        throw new Error("E_PROTOCOL_FAILURE Missing protocolStdout for cli mode");
    }

    private getToolContext(): ToolContext {
        return this.toolContext;
    }

    /**
     * Verify interrupted indexing snapshots via the fenced recovery path.
     * Must not publish lifecycle transitions without a mutation lease.
     */
    private async verifyCloudState(_toolContext: ToolContext): Promise<void> {
        console.log("[STARTUP] Verifying interrupted indexing state against completion markers...");
        await this.toolHandlers.recoverInterruptedIndexingAtStartup();
    }

    private setupTools(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: getMcpToolList(this.getToolContext()),
            };
        });

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

            return tool.execute(args || {}, this.getToolContext());
        });
    }

    async start(): Promise<void> {
        console.log("Starting Satori MCP server...");

        const transportStdin = this.protocolStdin ?? process.stdin;
        const transport = this.runMode === "cli" || this.protocolStdin || this.protocolStdout
            ? new StdioServerTransport(transportStdin, this.getCliTransportStdout())
            : new StdioServerTransport();
        await this.server.connect(transport);
        transportStdin.resume();
        this.keepAliveTimer = setInterval(() => {
            // Keep stdio MCP process alive when startup has no background provider lifecycle.
        }, 60 * 60 * 1000);

        console.log("MCP server started and listening on stdio.");
        await runPostConnectStartupLifecycle(this.runMode, {
            watchSyncEnabled: this.watchSyncEnabled,
            verifyCloudState: () => this.verifyCloudState(this.getToolContext()),
            onVerifyCloudStateError: (error) => {
                console.error("[STARTUP] Error verifying cloud state:", errorMessage(error));
            },
            syncManager: this.syncManager,
        });
    }

    async shutdown(): Promise<void> {
        console.log("Shutting down Satori MCP server...");
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        this.syncManager.stopBackgroundSync();
        await this.syncManager.stopWatcherMode();
        await this.providerRuntime.shutdown();
        this.runtimeOwnerRegistry.unregisterCurrentOwner();
    }
}

function isHelpRequested(args: string[]): boolean {
    return args.includes("--help") || args.includes("-h");
}

export async function startMcpServerFromEnv(options: StartMcpServerOptions = {}): Promise<ContextMcpServer | null> {
    const args = options.args ?? process.argv.slice(2);
    const runMode = options.runMode ?? "mcp";

    if (isHelpRequested(args)) {
        showHelpMessage();
        return null;
    }

    migrateLegacyStateDir();

    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config, runMode, options.protocolStdout, options.protocolStdin);
    await server.start();
    return server;
}
