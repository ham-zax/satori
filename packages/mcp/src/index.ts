#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, MilvusVectorDatabase, VoyageAIReranker } from "@zokizuan/satori-core";

import {
    buildRuntimeIndexFingerprint,
    ContextMcpConfig,
    createMcpConfig,
    IndexFingerprint,
    logConfigurationSummary,
    showHelpMessage,
} from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { CapabilityResolver } from "./core/capabilities.js";
import { SnapshotManager } from "./core/snapshot.js";
import { SyncManager } from "./core/sync.js";
import { ToolHandlers } from "./core/handlers.js";
import { CallGraphSidecarManager } from "./core/call-graph.js";
import { ToolContext } from "./tools/types.js";
import { getMcpToolList, toolRegistry } from "./tools/registry.js";

function migrateLegacyStateDir(): void {
    const homeDir = os.homedir();
    const legacyDir = path.join(homeDir, '.context');
    const newDir = path.join(homeDir, '.satori');

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

    constructor(config: ContextMcpConfig) {
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
                        this.context.getActiveIgnorePatterns()
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
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager, this.syncManager, this.runtimeFingerprint, () => Date.now(), this.callGraphManager);

        if (this.capabilities.hasReranker()) {
            this.reranker = new VoyageAIReranker({
                apiKey: config.voyageKey as string,
                model: config.rankerModel || 'rerank-2.5',
            });
            console.log(`[RERANKER] VoyageAI Reranker initialized with model: ${config.rankerModel || 'rerank-2.5'}`);
        }

        this.snapshotManager.loadCodebaseSnapshot();

        this.verifyCloudState().catch((err) => {
            console.error('[STARTUP] Error verifying cloud state:', err.message);
        });

        this.setupTools();
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
        console.log('[STARTUP] Verifying cloud state against local snapshot...');

        const vectorDb = this.context.getVectorStore();
        const collections = await vectorDb.listCollections();
        const cloudCodebases = new Set<string>();

        for (const collectionName of collections) {
            if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                continue;
            }

            try {
                const results = await vectorDb.query(collectionName, '', ['metadata'], 1);
                if (results && results.length > 0 && results[0].metadata) {
                    const metadata = JSON.parse(results[0].metadata);
                    if (metadata.codebasePath) {
                        cloudCodebases.add(metadata.codebasePath);
                    }
                }
            } catch {
                // Best-effort startup reconciliation.
            }
        }

        const indexingCodebases = this.snapshotManager.getIndexingCodebases();
        let fixedCount = 0;

        for (const codebasePath of indexingCodebases) {
            if (cloudCodebases.has(codebasePath) || await this.context.hasIndexedCollection(codebasePath)) {
                console.log(`[STARTUP] Fixing interrupted indexing: ${codebasePath} -> marked as indexed`);
                const info = this.snapshotManager.getCodebaseInfo(codebasePath) as any;
                this.snapshotManager.setCodebaseIndexed(
                    codebasePath,
                    {
                        indexedFiles: info?.indexedFiles || 0,
                        totalChunks: info?.totalChunks || 0,
                        status: 'completed',
                    },
                    this.runtimeFingerprint,
                    'verified'
                );
                fixedCount++;
            }
        }

        if (fixedCount > 0) {
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[STARTUP] Fixed ${fixedCount} interrupted indexing state(s)`);
        } else {
            console.log('[STARTUP] Cloud state matches local snapshot');
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
                        type: 'text',
                        text: `Unknown tool: ${name}. Supported tools: ${Object.keys(toolRegistry).join(', ')}`,
                    }],
                    isError: true,
                };
            }

            return tool.execute(args || {}, this.getToolContext());
        });
    }

    async start(): Promise<void> {
        console.log('Starting Satori MCP server...');

        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        console.log('MCP server started and listening on stdio.');
        this.syncManager.startBackgroundSync();
        if (this.watchSyncEnabled) {
            await this.syncManager.startWatcherMode();
        }
    }

    async shutdown(): Promise<void> {
        console.log('Shutting down Satori MCP server...');
        this.syncManager.stopBackgroundSync();
        await this.syncManager.stopWatcherMode();
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    migrateLegacyStateDir();

    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    activeServer = server;
    await server.start();
}

let activeServer: ContextMcpServer | null = null;
let shuttingDown = false;

async function handleShutdownSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    console.error(`Received ${signal}, shutting down gracefully...`);
    try {
        if (activeServer) {
            await activeServer.shutdown();
        }
    } catch (error) {
        console.error('Error during graceful shutdown:', error);
    } finally {
        process.exit(0);
    }
}

process.on('SIGINT', () => {
    void handleShutdownSignal('SIGINT');
});

process.on('SIGTERM', () => {
    void handleShutdownSignal('SIGTERM');
});

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
