import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { Context, MilvusVectorDatabase, VoyageAIReranker } from "@zokizuan/satori-core";
import {
    buildRuntimeIndexFingerprint,
    ContextMcpConfig,
    createMcpConfig,
    IndexFingerprint,
    logConfigurationSummary,
    showHelpMessage,
} from "../config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "../embedding.js";
import { CapabilityResolver } from "../core/capabilities.js";
import { SnapshotManager } from "../core/snapshot.js";
import { SyncManager } from "../core/sync.js";
import { ToolHandlers } from "../core/handlers.js";
import { CallGraphSidecarManager } from "../core/call-graph.js";
import { decideInterruptedIndexingRecovery } from "../core/indexing-recovery.js";
import { ToolContext } from "../tools/types.js";
import { getMcpToolList, toolRegistry } from "../tools/registry.js";

export type ServerRunMode = "mcp" | "cli";

export interface StartMcpServerOptions {
    runMode?: ServerRunMode;
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

export async function runPostConnectStartupLifecycle(
    runMode: ServerRunMode,
    dependencies: StartupLifecycleDependencies
): Promise<void> {
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
    } catch (copyError: any) {
        console.error(`[MIGRATION] Failed to migrate '${legacyDir}' -> '${newDir}':`, copyError?.message || copyError);
    }
}

class ContextMcpServer {
    private server: Server;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;
    private reranker: VoyageAIReranker | null = null;
    private capabilities: CapabilityResolver;
    private runtimeFingerprint: IndexFingerprint;
    private readFileMaxLines: number;
    private watchSyncEnabled: boolean;
    private watchDebounceMs: number;
    private callGraphManager: CallGraphSidecarManager;
    private runMode: ServerRunMode;
    private protocolStdout?: Writable;

    constructor(config: ContextMcpConfig, runMode: ServerRunMode, protocolStdout?: Writable) {
        this.runMode = runMode;
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

        console.log(`[EMBEDDING] Initializing embedding provider: ${config.encoderProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.encoderModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        this.capabilities = new CapabilityResolver(config);
        this.runtimeFingerprint = buildRuntimeIndexFingerprint(config, embedding.getDimension());
        this.readFileMaxLines = Math.max(1, config.readFileMaxLines ?? 1000);
        this.watchSyncEnabled = config.watchSyncEnabled === true;
        this.watchDebounceMs = Math.max(1, config.watchDebounceMs ?? 5000);
        console.log(`[FINGERPRINT] Runtime index fingerprint: ${JSON.stringify(this.runtimeFingerprint)}`);

        const vectorDatabase = new MilvusVectorDatabase({
            address: config.milvusEndpoint,
            ...(config.milvusApiToken && { token: config.milvusApiToken }),
        });

        this.context = new Context({
            embedding,
            vectorDatabase,
        });

        this.snapshotManager = new SnapshotManager(this.runtimeFingerprint);
        this.callGraphManager = new CallGraphSidecarManager(this.runtimeFingerprint);
        this.syncManager = new SyncManager(this.context, this.snapshotManager, {
            watchEnabled: this.watchSyncEnabled,
            watchDebounceMs: this.watchDebounceMs,
            onSyncCompleted: async (codebasePath, stats) => {
                try {
                    const sidecar = await this.callGraphManager.rebuildIfSupportedDelta(
                        codebasePath,
                        stats.changedFiles,
                        this.context.getActiveIgnorePatterns(codebasePath)
                    );
                    if (sidecar) {
                        this.snapshotManager.setCodebaseCallGraphSidecar(codebasePath, sidecar);
                        this.snapshotManager.saveCodebaseSnapshot();
                        console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' from sync lifecycle callback.`);
                    }
                } catch (error: any) {
                    console.warn(`[CALL-GRAPH] Sync lifecycle rebuild failed for '${codebasePath}': ${error?.message || error}`);
                }
            }
        });

        if (this.capabilities.hasReranker()) {
            this.reranker = new VoyageAIReranker({
                apiKey: config.voyageKey as string,
                model: config.rankerModel || "rerank-2.5",
            });
            console.log(`[RERANKER] VoyageAI Reranker initialized with model: ${config.rankerModel || "rerank-2.5"}`);
        }
        this.toolHandlers = new ToolHandlers(
            this.context,
            this.snapshotManager,
            this.syncManager,
            this.runtimeFingerprint,
            this.capabilities,
            () => Date.now(),
            this.callGraphManager,
            this.reranker
        );

        this.snapshotManager.loadCodebaseSnapshot();
        this.setupTools();
    }

    private getCliTransportStdout(): Writable {
        if (this.runMode !== "cli") {
            return process.stdout;
        }
        if (!this.protocolStdout) {
            throw new Error("E_PROTOCOL_FAILURE Missing protocolStdout for cli mode");
        }
        return this.protocolStdout;
    }

    private getToolContext(): ToolContext {
        return {
            context: this.context,
            snapshotManager: this.snapshotManager,
            syncManager: this.syncManager,
            capabilities: this.capabilities,
            reranker: this.reranker,
            runtimeFingerprint: this.runtimeFingerprint,
            toolHandlers: this.toolHandlers,
            readFileMaxLines: this.readFileMaxLines,
        };
    }

    /**
     * Verify cloud state and fix interrupted indexing snapshots.
     */
    private async verifyCloudState(): Promise<void> {
        console.log("[STARTUP] Verifying interrupted indexing state against completion markers...");
        const indexingCodebases = this.snapshotManager.getIndexingCodebases();
        let promotedCount = 0;
        let failedCount = 0;

        for (const codebasePath of indexingCodebases) {
            const marker = typeof (this.context as any).getIndexCompletionMarker === "function"
                ? await (this.context as any).getIndexCompletionMarker(codebasePath)
                : null;
            const decision = decideInterruptedIndexingRecovery(marker, this.runtimeFingerprint);
            if (decision.action === "promote_indexed") {
                this.snapshotManager.setCodebaseIndexed(codebasePath, decision.stats, this.runtimeFingerprint, "verified");
                promotedCount++;
                console.log(`[STARTUP] Recovered interrupted indexing from marker: ${codebasePath} -> indexed`);
                continue;
            }
            this.snapshotManager.setCodebaseIndexFailed(codebasePath, decision.message);
            failedCount++;
            console.log(`[STARTUP] Marked interrupted indexing as failed: ${codebasePath} (${decision.reason})`);
        }

        if (promotedCount > 0 || failedCount > 0) {
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[STARTUP] Recovery summary: promoted=${promotedCount}, failed=${failedCount}`);
        } else {
            console.log("[STARTUP] No interrupted indexing states required recovery");
        }
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

        const transport = this.runMode === "cli"
            ? new StdioServerTransport(process.stdin, this.getCliTransportStdout())
            : new StdioServerTransport();
        await this.server.connect(transport);

        console.log("MCP server started and listening on stdio.");
        await runPostConnectStartupLifecycle(this.runMode, {
            watchSyncEnabled: this.watchSyncEnabled,
            verifyCloudState: () => this.verifyCloudState(),
            onVerifyCloudStateError: (error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.error("[STARTUP] Error verifying cloud state:", message);
            },
            syncManager: this.syncManager,
        });
    }

    async shutdown(): Promise<void> {
        console.log("Shutting down Satori MCP server...");
        this.syncManager.stopBackgroundSync();
        await this.syncManager.stopWatcherMode();
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

    const server = new ContextMcpServer(config, runMode, options.protocolStdout);
    await server.start();
    return server;
}
