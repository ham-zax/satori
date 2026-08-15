import {
    Context,
    createGenerationProofCoordinator,
    Embedding,
    EmbeddingVector,
    type EmbeddingIdentity,
    MilvusVectorDatabase,
    type Reranker,
    VectorDatabase,
    VoyageAIReranker,
} from "@zokizuan/satori-core";
import fs from "node:fs";
import { createRequire } from "node:module";
import { CapabilityResolver } from "../core/capabilities.js";
import { CallGraphSidecarManager } from "../core/call-graph.js";
import {
    SearchContinuationCoordinator,
    ToolHandlers,
} from "../core/handlers.js";
import type { RuntimeOwnerMutationGate } from "../core/runtime-owner.js";
import { MutationLeaseCoordinator } from "../core/mutation-lease.js";
import { SnapshotManager } from "../core/snapshot.js";
import { SyncManager } from "../core/sync.js";
import {
    ContextMcpConfig,
    IndexFingerprint,
    resolveConfiguredEmbeddingDimension,
    resolveRerankerProvider,
} from "../config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "../embedding.js";
import {
    WorkspaceAuthorizationError,
    type SessionWorkspacePolicy,
} from "../core/session-workspace-policy.js";
import { MissingProviderConfigIssue, ProviderBackedOperation, ToolContext } from "../tools/types.js";
import { LateOnReranker } from "./lateon-reranker.js";
import type { LateOnRuntimeProfileId } from "./lateon-reranker-protocol.js";

/**
 * Deny-all workspace policy for raw host-wide provider contexts that have
 * not been bound to an MCP session. Any tool path that accidentally uses the
 * raw context fails closed with WORKSPACE_POLICY_NOT_BOUND instead of
 * inheriting process.cwd() authority or a session-specific root set.
 */
export const UNBOUND_WORKSPACE_POLICY: SessionWorkspacePolicy = {
    roots: [],
    authorizeRoot() {
        throw new WorkspaceAuthorizationError(
            "WORKSPACE_POLICY_NOT_BOUND",
            "Tool context has not been bound to an MCP session.",
        );
    },
    authorizePath() {
        throw new WorkspaceAuthorizationError(
            "WORKSPACE_POLICY_NOT_BOUND",
            "Tool context has not been bound to an MCP session.",
        );
    },
};

type VectorSearchResults = Awaited<ReturnType<VectorDatabase["retrieveDense"]>>;
type VectorQueryRows = Awaited<ReturnType<VectorDatabase["queryDocuments"]>>;
type ProviderSyncLifecycle = Pick<
    SyncManager,
    "startBackgroundSync" | "stopBackgroundSync" | "startWatcherMode" | "stopWatcherMode"
>;
type SyncCompletionHook = NonNullable<
    NonNullable<ConstructorParameters<typeof SyncManager>[2]>['onSyncCompleted']
>;

const requireFromProviderRuntime = createRequire(import.meta.url);

type ResolvedProviderRuntimeBootstrap = Readonly<{
    embedding: Readonly<
        | { kind: 'configured' }
        | {
            kind: 'metadata-only';
            provider: string;
            model: string;
            dimension: number;
            artifactDigest: string | null;
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
    reranker: Readonly<
        | {
            kind: 'voyage';
            apiKey: string;
            model: NonNullable<ConstructorParameters<typeof VoyageAIReranker>[0]['model']>;
        }
        | {
            kind: 'lateon';
            modelDirectory: string;
            profileId?: LateOnRuntimeProfileId;
            requestDeadlineMilliseconds?: number;
            maximumQueueWaitMilliseconds?: number;
            rerankerStageDeadlineMilliseconds?: number;
            maximumActiveReranks?: 0 | 1;
            maximumQueuedReranks?: 0 | 1;
            intraOpThreads?: number;
        }
    > | null;
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
    private readonly artifactDigest: string | null;
    readonly config: { model: string };

    constructor(provider: string, model: string, dimension: number, artifactDigest: string | null) {
        super();
        this.provider = provider;
        this.dimension = dimension;
        this.artifactDigest = artifactDigest;
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
        return this.buildIdentity(this.config.model, this.artifactDigest);
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
            config.embeddingArtifactDigest ?? null,
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
    private readonly readFileMaxBytes: number;
    private readonly watchSyncEnabled: boolean;
    private readonly watchDebounceMs: number;
    private readonly startSyncLifecycle: boolean;
    private readonly callGraphManager: CallGraphSidecarManager;
    private readonly runtimeOwnerGate: RuntimeOwnerMutationGate | null;
    private readonly mutationLeaseCoordinator: MutationLeaseCoordinator;
    private readonly now: () => number;
    private readonly searchContinuationCoordinator: SearchContinuationCoordinator;
    private readonly onLifecycleActivityChanged?: () => void;
    private readonly generationProofCoordinator = createGenerationProofCoordinator();
    private embeddingRuntimePromise: Promise<ToolContext> | null = null;
    private vectorRuntimePromise: Promise<ToolContext> | null = null;
    private activeContexts: ToolContext[] = [];
    private readonly activeEmbeddings = new Set<Embedding>();
    private readonly activeRerankers = new Set<Reranker>();

    constructor(args: {
        config: ContextMcpConfig;
        snapshotManager: SnapshotManager;
        runtimeFingerprint: IndexFingerprint;
        capabilities: CapabilityResolver;
        readFileMaxLines: number;
        readFileMaxBytes?: number;
        watchSyncEnabled: boolean;
        watchDebounceMs: number;
        startSyncLifecycle?: boolean;
        callGraphManager: CallGraphSidecarManager;
        runtimeOwnerGate?: RuntimeOwnerMutationGate | null;
        mutationLeaseCoordinator?: MutationLeaseCoordinator;
        searchContinuationCoordinator?: SearchContinuationCoordinator;
        onLifecycleActivityChanged?: () => void;
        now?: () => number;
    }) {
        this.config = args.config;
        this.snapshotManager = args.snapshotManager;
        this.runtimeFingerprint = args.runtimeFingerprint;
        this.capabilities = args.capabilities;
        this.readFileMaxLines = args.readFileMaxLines;
        this.readFileMaxBytes = args.readFileMaxBytes ?? 8 * 1024 * 1024;
        this.watchSyncEnabled = args.watchSyncEnabled;
        this.watchDebounceMs = args.watchDebounceMs;
        this.startSyncLifecycle = args.startSyncLifecycle === true;
        this.callGraphManager = args.callGraphManager;
        this.runtimeOwnerGate = args.runtimeOwnerGate || null;
        this.mutationLeaseCoordinator = args.mutationLeaseCoordinator || new MutationLeaseCoordinator();
        this.searchContinuationCoordinator = args.searchContinuationCoordinator
            ?? new SearchContinuationCoordinator();
        this.onLifecycleActivityChanged = args.onLifecycleActivityChanged;
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
                case "Potion":
                    if (!this.config.potionHelperPath) missing.push("POTION_HELPER_PATH");
                    if (!this.config.potionModelPath) missing.push("POTION_MODEL_PATH");
                    break;
            }
            if (
                resolveRerankerProvider(this.config) === "lateon"
                && !this.config.lateOnModelPath
            ) {
                missing.push("SATORI_LATEON_MODEL_PATH");
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
        const embedding = await this.createEmbeddingProvider(bootstrap);
        let reranker: Reranker | null = null;
        try {
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
                generationProofCoordinator: this.generationProofCoordinator,
            });
            const syncManager = new SyncManager(context, this.snapshotManager, {
                watchEnabled: this.watchSyncEnabled,
                watchDebounceMs: this.watchDebounceMs,
                onSyncCompleted: this.createSyncCompletionHook(context),
                sourceFreshnessPort: context.getSourceFreshnessPort(),
            mutationLeaseCoordinator: this.mutationLeaseCoordinator,
                onLifecycleActivityChanged: this.onLifecycleActivityChanged,
            });
            reranker = this.createReranker(bootstrap);
            if (reranker) {
                console.log(
                    `[RERANKER] ${bootstrap.reranker?.kind ?? "unknown"} reranker initialized.`,
                );
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
                this.searchContinuationCoordinator,
                { readFileMaxBytes: this.readFileMaxBytes },
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
                readFileMaxBytes: this.readFileMaxBytes,
                runtimeOwnerGate: this.runtimeOwnerGate,
                providerRuntime: this,
                // Raw host-wide provider contexts are never bound to an MCP
                // session: deny-all until a session wrapper supplies the
                // immutable per-session workspace policy.
                workspacePolicy: UNBOUND_WORKSPACE_POLICY,
            };
            this.activeEmbeddings.add(embedding);
            if (reranker) this.activeRerankers.add(reranker);
            this.activeContexts.push(toolContext);
            return toolContext;
        } catch (error) {
            await reranker?.close?.().catch(() => undefined);
            await embedding.close();
            throw error;
        }
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
        const rerankerProvider = resolveRerankerProvider(this.config);
        const reranker = !requireEmbedding || !this.capabilities.hasReranker()
            ? null
            : rerankerProvider === 'lateon'
                ? {
                    kind: 'lateon' as const,
                    modelDirectory: this.config.lateOnModelPath as string,
                    ...(this.config.lateOnProfileId !== undefined
                        ? { profileId: this.config.lateOnProfileId }
                        : {}),
                    ...(this.config.lateOnRequestDeadlineMs !== undefined
                        ? { requestDeadlineMilliseconds: this.config.lateOnRequestDeadlineMs }
                        : {}),
                    ...(this.config.lateOnMaximumQueueWaitMs !== undefined
                        ? { maximumQueueWaitMilliseconds: this.config.lateOnMaximumQueueWaitMs }
                        : {}),
                    ...(this.config.lateOnRerankerStageDeadlineMs !== undefined
                        ? { rerankerStageDeadlineMilliseconds: this.config.lateOnRerankerStageDeadlineMs }
                        : {}),
                    ...(this.config.lateOnMaximumActiveReranks !== undefined
                        ? { maximumActiveReranks: this.config.lateOnMaximumActiveReranks }
                        : {}),
                    ...(this.config.lateOnMaximumQueuedReranks !== undefined
                        ? { maximumQueuedReranks: this.config.lateOnMaximumQueuedReranks }
                        : {}),
                    ...(this.config.lateOnIntraOpThreads !== undefined
                        ? { intraOpThreads: this.config.lateOnIntraOpThreads }
                        : {}),
                }
                : rerankerProvider === 'voyage'
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
                artifactDigest: this.config.embeddingArtifactDigest ?? null,
            });
        return Object.freeze({
            embedding,
            vectorBackend,
            reranker: reranker ? Object.freeze(reranker) : null,
            embeddingCapable: requireEmbedding,
        });
    }

    private async createEmbeddingProvider(
        bootstrap: ResolvedProviderRuntimeBootstrap,
    ): Promise<Embedding> {
        if (bootstrap.embedding.kind === 'metadata-only') {
            return new MetadataOnlyEmbedding(
                bootstrap.embedding.provider,
                bootstrap.embedding.model,
                bootstrap.embedding.dimension,
                bootstrap.embedding.artifactDigest,
            );
        }
        const embedding = await createEmbeddingInstance(this.config);
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
                // Core deliberately publishes this native boundary as CommonJS.
                // Requiring it lazily avoids Node's synthetic ESM named-export
                // snapshot, which can observe getter-backed exports as undefined
                // in a detached compiled host.
                let LanceDbVectorDatabase: new (
                    config: { databasePath: string },
                ) => VectorDatabase;
                try {
                    const resolvedModule = fs.realpathSync(
                        requireFromProviderRuntime.resolve(moduleSpecifier),
                    );
                    const requireFromResolvedModule = createRequire(resolvedModule);
                    ({ LanceDbVectorDatabase } = requireFromResolvedModule(resolvedModule) as {
                        LanceDbVectorDatabase: new (
                            config: { databasePath: string },
                        ) => VectorDatabase;
                    });
                } catch (error) {
                    throw new Error(
                        `${error instanceof Error ? error.message : String(error)} `
                        + `(resolved through ${moduleSpecifier})`,
                    );
                }
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
    ): Reranker | null {
        if (!bootstrap.reranker) return null;
        switch (bootstrap.reranker.kind) {
            case 'voyage':
                return new VoyageAIReranker({
                    apiKey: bootstrap.reranker.apiKey,
                    model: bootstrap.reranker.model,
                });
            case 'lateon':
                return new LateOnReranker({
                    modelDirectory: bootstrap.reranker.modelDirectory,
                    profileId: bootstrap.reranker.profileId,
                    requestDeadlineMilliseconds:
                        bootstrap.reranker.requestDeadlineMilliseconds,
                    maximumQueueWaitMilliseconds:
                        bootstrap.reranker.maximumQueueWaitMilliseconds,
                    rerankerStageDeadlineMilliseconds:
                        bootstrap.reranker.rerankerStageDeadlineMilliseconds,
                    maximumActiveReranks: bootstrap.reranker.maximumActiveReranks,
                    maximumQueuedReranks: bootstrap.reranker.maximumQueuedReranks,
                    intraOpThreads: bootstrap.reranker.intraOpThreads,
                });
        }
    }

    private createSyncCompletionHook(context: Context): SyncCompletionHook {
        return async (codebasePath, _stats, assertMutationCurrent) => {
            assertMutationCurrent();
            const publication = await context.proveIndexedGeneration(codebasePath);
            assertMutationCurrent();
            if (!publication) {
                throw new Error(`Incremental publication for '${codebasePath}' is not readable as one complete generation.`);
            }
        };
    }

    public getActiveLifecycleOperationCount(): number {
        return this.activeContexts.reduce(
            (count, toolContext) => count + toolContext.syncManager.getActiveLifecycleOperationCount(),
            0,
        );
    }

    public async shutdown(): Promise<void> {
        await Promise.all([
            Promise.all(this.activeContexts.map(async (toolContext) => {
                toolContext.toolHandlers.releaseSearchContinuationOwnership();
                await toolContext.syncManager.stopAndDrainLifecycle();
                await toolContext.context.getVectorStore().close?.();
                await toolContext.context.dispose?.();
            })),
            Promise.all([...this.activeEmbeddings].map((embedding) => embedding.close())),
            Promise.all([...this.activeRerankers].map((reranker) => reranker.close?.())),
        ]);
        this.activeContexts = [];
        this.activeEmbeddings.clear();
        this.activeRerankers.clear();
    }
}
