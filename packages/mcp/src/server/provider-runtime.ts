import {
    Context,
    Embedding,
    EmbeddingVector,
    type EmbeddingIdentity,
    MilvusVectorDatabase,
    VectorDatabase,
    VoyageAIReranker,
} from "@zokizuan/satori-core";
import { CapabilityResolver } from "../core/capabilities.js";
import { CallGraphSidecarManager } from "../core/call-graph.js";
import { ToolHandlers } from "../core/handlers.js";
import type { RuntimeOwnerMutationGate } from "../core/runtime-owner.js";
import { MutationLeaseCoordinator } from "../core/mutation-lease.js";
import { SnapshotManager } from "../core/snapshot.js";
import { SyncManager } from "../core/sync.js";
import {
    ContextMcpConfig,
    IndexFingerprint,
    resolveConfiguredEmbeddingDimension,
} from "../config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "../embedding.js";
import { MissingProviderConfigIssue, ProviderBackedOperation, ToolContext } from "../tools/types.js";

type VectorSearchResults = Awaited<ReturnType<VectorDatabase["retrieveDense"]>>;
type VectorQueryRows = Awaited<ReturnType<VectorDatabase["queryDocuments"]>>;
type ProviderSyncLifecycle = Pick<
    SyncManager,
    "startBackgroundSync" | "stopBackgroundSync" | "startWatcherMode" | "stopWatcherMode"
>;
type SyncCompletionHook = NonNullable<
    NonNullable<ConstructorParameters<typeof SyncManager>[2]>['onSyncCompleted']
>;

type ResolvedProviderRuntimeBootstrap = Readonly<{
    embedding: Readonly<
        | { kind: 'configured' }
        | {
            kind: 'metadata-only';
            provider: string;
            model: string;
            dimension: number;
        }
    >;
    vectorBackend: Readonly<
        | {
            kind: 'milvus';
            address: string;
            token?: string;
        }
        | {
            kind: 'lancedb';
            databasePath: string;
        }
    >;
    reranker: Readonly<{
        kind: 'voyage';
        apiKey: string;
        model: NonNullable<ConstructorParameters<typeof VoyageAIReranker>[0]['model']>;
    }> | null;
    embeddingCapable: boolean;
}>;

export async function startProviderSyncLifecycle(
    syncManager: ProviderSyncLifecycle,
    options: {
        enabled: boolean;
        embeddingCapable: boolean;
        watcherEnabled: boolean;
    },
): Promise<void> {
    // Incremental synchronization may embed changed files, so the
    // metadata-only vector runtime must never own periodic or watcher work.
    if (!options.enabled || !options.embeddingCapable) return;

    syncManager.startBackgroundSync();
    try {
        if (options.watcherEnabled) {
            await syncManager.startWatcherMode();
        }
    } catch (error) {
        syncManager.stopBackgroundSync();
        await syncManager.stopWatcherMode().catch(() => undefined);
        throw error;
    }
}

class MetadataOnlyEmbedding extends Embedding {
    protected maxTokens = 1;
    private readonly provider: string;
    private readonly dimension: number;
    readonly config: { model: string };

    constructor(provider: string, model: string, dimension: number) {
        super();
        this.provider = provider;
        this.dimension = dimension;
        this.config = { model };
    }

    async detectDimension(): Promise<number> {
        return this.dimension;
    }

    async embedQuery(_text: string): Promise<EmbeddingVector> {
        throw new Error("MISSING_PROVIDER_CONFIG embedding provider is not configured");
    }

    async embedDocuments(_texts: string[]): Promise<EmbeddingVector[]> {
        throw new Error("MISSING_PROVIDER_CONFIG embedding provider is not configured");
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return this.provider;
    }

    override getIdentity(): Readonly<EmbeddingIdentity> {
        return this.buildIdentity(this.config.model);
    }
}

class UnconfiguredVectorDatabase implements VectorDatabase {
    private throwMissing(): never {
        throw new Error("MISSING_PROVIDER_CONFIG MILVUS_ADDRESS is not configured");
    }

    async createCollection(): Promise<void> { this.throwMissing(); }
    async createHybridCollection(): Promise<void> { this.throwMissing(); }
    async dropCollection(): Promise<void> { this.throwMissing(); }
    async hasCollection(): Promise<boolean> { this.throwMissing(); }
    async listCollections(): Promise<string[]> { this.throwMissing(); }
    async writeDocuments(): Promise<void> { this.throwMissing(); }
    async insertControl(): Promise<void> { this.throwMissing(); }
    async getControl(): Promise<null> { this.throwMissing(); }
    async deleteControl(): Promise<void> { this.throwMissing(); }
    async retrieveDense(): Promise<VectorSearchResults> { this.throwMissing(); }
    async retrieveLexical(): Promise<VectorSearchResults> { this.throwMissing(); }
    async deleteDocuments(): Promise<void> { this.throwMissing(); }
    async queryDocuments(): Promise<VectorQueryRows> { this.throwMissing(); }
    async checkCollectionLimit(): Promise<boolean> { this.throwMissing(); }
}

// Local-only startup scaffolding: these satisfy Context/ToolHandlers constructor
// contracts for provider-free tools. They must not perform provider I/O.
// Provider-backed tools must use ProviderRuntime.requireToolContext instead.
export { resolveConfiguredEmbeddingDimension } from "../config.js";

function createDurableAuthorityRecoveryPublisher(
    coordinator: MutationLeaseCoordinator,
): NonNullable<ConstructorParameters<typeof Context>[0]>['durableAuthorityRecoveryPublisher'] {
    return (canonicalRoot, _mutationOwner, publish) => {
        const acquired = coordinator.acquire(canonicalRoot, "repair");
        if (!acquired.acquired) return false;
        try {
            coordinator.publishWhileCurrent(acquired.lease, publish);
            return true;
        } finally {
            coordinator.release(acquired.lease);
        }
    };
}

export function createLocalOnlyContext(
    config: ContextMcpConfig,
    mutationLeaseCoordinator?: MutationLeaseCoordinator,
): Context {
    return new Context({
        embedding: new MetadataOnlyEmbedding(
            config.encoderProvider,
            config.encoderModel,
            resolveConfiguredEmbeddingDimension(config),
        ),
        vectorDatabase: new UnconfiguredVectorDatabase(),
        vectorStoreProvider: config.vectorStoreProvider,
        ...(mutationLeaseCoordinator ? {
            durableAuthorityRecoveryPublisher: createDurableAuthorityRecoveryPublisher(mutationLeaseCoordinator),
        } : {}),
    });
}

function createMissingConfigIssue(missingEnv: string[]): MissingProviderConfigIssue {
    const uniqueMissing = [...new Set(missingEnv)];
    const message = `Satori provider setup is incomplete. Missing required environment variable(s): ${uniqueMissing.join(", ")}. MCP startup does not require provider credentials, but this tool call does.`;
    return {
        ok: false,
        code: "MISSING_PROVIDER_CONFIG",
        missingEnv: uniqueMissing,
        message,
        hints: {
            setup: {
                code: "MISSING_PROVIDER_CONFIG",
                missingEnv: uniqueMissing,
                nextSteps: uniqueMissing.map((name) => `Set ${name}, restart the MCP server, then retry the tool call.`),
            }
        }
    };
}

export class ProviderRuntime {
    private readonly config: ContextMcpConfig;
    private readonly snapshotManager: SnapshotManager;
    private readonly runtimeFingerprint: IndexFingerprint;
    private readonly capabilities: CapabilityResolver;
    private readonly readFileMaxLines: number;
    private readonly watchSyncEnabled: boolean;
    private readonly watchDebounceMs: number;
    private readonly startSyncLifecycle: boolean;
    private readonly callGraphManager: CallGraphSidecarManager;
    private readonly runtimeOwnerGate: RuntimeOwnerMutationGate | null;
    private readonly mutationLeaseCoordinator: MutationLeaseCoordinator;
    private readonly now: () => number;
    private embeddingRuntimePromise: Promise<ToolContext> | null = null;
    private vectorRuntimePromise: Promise<ToolContext> | null = null;
    private activeContexts: ToolContext[] = [];

    constructor(args: {
        config: ContextMcpConfig;
        snapshotManager: SnapshotManager;
        runtimeFingerprint: IndexFingerprint;
        capabilities: CapabilityResolver;
        readFileMaxLines: number;
        watchSyncEnabled: boolean;
        watchDebounceMs: number;
        startSyncLifecycle?: boolean;
        callGraphManager: CallGraphSidecarManager;
        runtimeOwnerGate?: RuntimeOwnerMutationGate | null;
        mutationLeaseCoordinator?: MutationLeaseCoordinator;
        now?: () => number;
    }) {
        this.config = args.config;
        this.snapshotManager = args.snapshotManager;
        this.runtimeFingerprint = args.runtimeFingerprint;
        this.capabilities = args.capabilities;
        this.readFileMaxLines = args.readFileMaxLines;
        this.watchSyncEnabled = args.watchSyncEnabled;
        this.watchDebounceMs = args.watchDebounceMs;
        this.startSyncLifecycle = args.startSyncLifecycle === true;
        this.callGraphManager = args.callGraphManager;
        this.runtimeOwnerGate = args.runtimeOwnerGate || null;
        this.mutationLeaseCoordinator = args.mutationLeaseCoordinator || new MutationLeaseCoordinator();
        this.now = args.now || (() => Date.now());
    }

    public validate(operation: ProviderBackedOperation): MissingProviderConfigIssue | null {
        const missing: string[] = [];
        if (operation === "embedding_vector") {
            switch (this.config.encoderProvider) {
                case "OpenAI":
                    if (!this.config.openaiKey) missing.push("OPENAI_API_KEY");
                    break;
                case "VoyageAI":
                    if (!this.config.voyageKey) missing.push("VOYAGEAI_API_KEY");
                    break;
                case "Gemini":
                    if (!this.config.geminiKey) missing.push("GEMINI_API_KEY");
                    break;
                case "Ollama":
                    break;
            }
        }

        if (this.config.vectorStoreProvider === 'Milvus' && !this.config.milvusEndpoint) {
            missing.push("MILVUS_ADDRESS");
        }
        if (this.config.vectorStoreProvider === 'LanceDB' && !this.config.lanceDbPath) {
            missing.push("LANCEDB_PATH");
        }

        return missing.length > 0 ? createMissingConfigIssue(missing) : null;
    }

    public async requireToolContext(operation: ProviderBackedOperation): Promise<ToolContext | MissingProviderConfigIssue> {
        const validation = this.validate(operation);
        if (validation) {
            return validation;
        }

        if (operation === "vector_only") {
            // Search prepares navigation authority in the embedding-capable context.
            // Reuse that capability superset so follow-up reads observe the same cache.
            if (this.embeddingRuntimePromise) {
                return this.embeddingRuntimePromise;
            }
            if (!this.vectorRuntimePromise) {
                this.vectorRuntimePromise = this.createRuntime(false).catch((error) => {
                    this.vectorRuntimePromise = null;
                    throw error;
                });
            }
            return this.vectorRuntimePromise;
        }

        if (!this.embeddingRuntimePromise) {
            this.embeddingRuntimePromise = this.createRuntime(true).catch((error) => {
                this.embeddingRuntimePromise = null;
                throw error;
            });
        }
        return this.embeddingRuntimePromise;
    }

    private async createRuntime(requireEmbedding: boolean): Promise<ToolContext> {
        const bootstrap = await this.resolveRuntimeBootstrap(requireEmbedding);
        const embedding = this.createEmbeddingProvider(bootstrap);
        const vectorDatabase = await this.createVectorBackend(bootstrap, embedding.getDimension());
        const context = new Context({
            embedding,
            vectorDatabase,
            vectorStoreProvider: this.config.vectorStoreProvider,
            mutationGenerationObserver: (canonicalRoot) => (
                this.mutationLeaseCoordinator.observe(canonicalRoot)
            ),
            durableAuthorityRecoveryPublisher: createDurableAuthorityRecoveryPublisher(
                this.mutationLeaseCoordinator,
            ),
        });
        const syncManager = new SyncManager(context, this.snapshotManager, {
            watchEnabled: this.watchSyncEnabled,
            watchDebounceMs: this.watchDebounceMs,
            onSyncCompleted: this.createSyncCompletionHook(context),
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
        });
        const reranker = this.createReranker(bootstrap);
        if (reranker) {
            console.log(`[RERANKER] VoyageAI Reranker initialized with model: ${this.config.rankerModel || "rerank-2.5"}`);
        }
        const toolHandlers = new ToolHandlers(
            context,
            this.snapshotManager,
            syncManager,
            this.runtimeFingerprint,
            this.capabilities,
            this.now,
            this.callGraphManager,
            reranker,
            undefined,
            undefined,
            this.runtimeOwnerGate,
            this.mutationLeaseCoordinator,
        );

        await startProviderSyncLifecycle(syncManager, {
            enabled: this.startSyncLifecycle,
            embeddingCapable: bootstrap.embeddingCapable,
            watcherEnabled: this.watchSyncEnabled,
        });

        const toolContext = {
            context,
            snapshotManager: this.snapshotManager,
            syncManager,
            capabilities: this.capabilities,
            reranker,
            runtimeFingerprint: this.runtimeFingerprint,
            toolHandlers,
            readFileMaxLines: this.readFileMaxLines,
            runtimeOwnerGate: this.runtimeOwnerGate,
            providerRuntime: this,
        };
        this.activeContexts.push(toolContext);
        return toolContext;
    }

    private async resolveRuntimeBootstrap(
        requireEmbedding: boolean,
    ): Promise<ResolvedProviderRuntimeBootstrap> {
        const vectorBackend = this.config.vectorStoreProvider === 'LanceDB'
            ? this.config.lanceDbPath
                ? Object.freeze({
                    kind: 'lancedb' as const,
                    databasePath: this.config.lanceDbPath,
                })
                : null
            : this.config.milvusEndpoint
                ? Object.freeze({
                    kind: 'milvus' as const,
                    address: this.config.milvusEndpoint,
                    ...(this.config.milvusApiToken ? { token: this.config.milvusApiToken } : {}),
                })
                : null;
        if (!vectorBackend) {
            const missing = this.config.vectorStoreProvider === 'LanceDB' ? 'LANCEDB_PATH' : 'MILVUS_ADDRESS';
            throw new Error(`MISSING_PROVIDER_CONFIG ${missing} is not configured`);
        }
        const reranker = requireEmbedding && this.capabilities.hasReranker()
            ? {
                kind: 'voyage' as const,
                apiKey: this.config.voyageKey as string,
                model: this.config.rankerModel || 'rerank-2.5',
            }
            : null;
        const embedding = requireEmbedding
            ? Object.freeze({ kind: 'configured' as const })
            : Object.freeze({
                kind: 'metadata-only' as const,
                provider: this.config.encoderProvider,
                model: this.config.encoderModel,
                dimension: resolveConfiguredEmbeddingDimension(this.config),
            });
        return Object.freeze({
            embedding,
            vectorBackend,
            reranker: reranker ? Object.freeze(reranker) : null,
            embeddingCapable: requireEmbedding,
        });
    }

    private createEmbeddingProvider(bootstrap: ResolvedProviderRuntimeBootstrap): Embedding {
        if (bootstrap.embedding.kind === 'metadata-only') {
            return new MetadataOnlyEmbedding(
                bootstrap.embedding.provider,
                bootstrap.embedding.model,
                bootstrap.embedding.dimension,
            );
        }
        const embedding = createEmbeddingInstance(this.config);
        logEmbeddingProviderInfo(this.config, embedding);
        return embedding;
    }

    private async createVectorBackend(
        bootstrap: ResolvedProviderRuntimeBootstrap,
        vectorDimension: number,
    ): Promise<VectorDatabase> {
        switch (bootstrap.vectorBackend.kind) {
            case 'lancedb': {
                const moduleSpecifier = '@zokizuan/satori-core/lancedb';
                const { LanceDbVectorDatabase } = await import(moduleSpecifier) as {
                    LanceDbVectorDatabase: new (config: { databasePath: string }) => VectorDatabase;
                };
                return new LanceDbVectorDatabase({
                    databasePath: bootstrap.vectorBackend.databasePath,
                });
            }
            case 'milvus':
                return new MilvusVectorDatabase({
                    address: bootstrap.vectorBackend.address,
                    ...(bootstrap.vectorBackend.token ? { token: bootstrap.vectorBackend.token } : {}),
                    vectorDimension,
                });
        }
    }

    private createReranker(
        bootstrap: ResolvedProviderRuntimeBootstrap,
    ): VoyageAIReranker | null {
        if (!bootstrap.reranker) return null;
        return new VoyageAIReranker({
            apiKey: bootstrap.reranker.apiKey,
            model: bootstrap.reranker.model,
        });
    }

    private createSyncCompletionHook(context: Context): SyncCompletionHook {
        return async (codebasePath, stats, assertMutationCurrent) => {
            try {
                assertMutationCurrent();
                const sidecar = await this.callGraphManager.rebuildIfSupportedDelta(
                    codebasePath,
                    stats.changedFiles,
                    context.getActiveIgnorePatterns(codebasePath),
                    assertMutationCurrent,
                );
                if (sidecar) {
                    assertMutationCurrent();
                    const committed = this.snapshotManager.commitCodebaseCallGraphSidecar(
                        codebasePath,
                        sidecar,
                        assertMutationCurrent,
                    );
                    if (!committed) {
                        console.warn(
                            `[CALL-GRAPH] Sync lifecycle rebuild discarded for '${codebasePath}': `
                            + 'fenced snapshot commit failed; in-memory sidecar rolled back.',
                        );
                        return;
                    }
                    console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' from sync lifecycle callback.`);
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[CALL-GRAPH] Sync lifecycle rebuild failed for '${codebasePath}': ${message}`);
            }
        };
    }

    public async shutdown(): Promise<void> {
        await Promise.all(this.activeContexts.map(async (toolContext) => {
            toolContext.syncManager.stopBackgroundSync();
            await toolContext.syncManager.stopWatcherMode();
            await toolContext.context.getVectorStore().close?.();
        }));
    }
}
