import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ManageIndexingHandlers } from "./manage-indexing-handlers.js";
import type { IndexFingerprint } from "../config.js";

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: "VoyageAI",
    embeddingModel: "voyage-code-3",
    embeddingDimension: 1024,
    vectorStoreProvider: "Milvus",
    schemaVersion: "hybrid_v3",
};

type StartBackgroundIndexing = {
    startBackgroundIndexing(codebasePath: string, forceReindex: boolean, writeCollectionName?: string): Promise<void>;
};

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-manage-indexing-"));
    const repoPath = path.join(tempDir, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.ts"), "export const value = 1;\n");
    return fn(repoPath).finally(() => {
        const digest = crypto.createHash("md5").update(path.resolve(repoPath)).digest("hex");
        fs.rmSync(path.join(os.homedir(), ".satori", "merkle", `${digest}.json`), { force: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function resolveCollectionName(codebasePath: string): string {
    const digest = crypto.createHash("md5").update(path.resolve(codebasePath)).digest("hex").slice(0, 8);
    return `hybrid_code_chunks_${digest}`;
}

function createFailedIndexingHarness(existingCollections: Set<string>) {
    const droppedCollections: string[] = [];
    const failedSnapshots: Array<{ path: string; errorMessage: string; progress?: number }> = [];
    let writeCollectionOverride: string | null = null;

    const vectorStore = {
        hasCollection: async (collectionName: string) => existingCollections.has(collectionName),
        dropCollection: async (collectionName: string) => {
            droppedCollections.push(collectionName);
            existingCollections.delete(collectionName);
        },
    };

    const context = {
        getVectorStore: () => vectorStore,
        loadResolvedIgnorePatterns: async () => undefined,
        ensureCollectionPrepared: async () => {
            if (writeCollectionOverride) {
                existingCollections.add(writeCollectionOverride);
            }
        },
        registerSynchronizer: () => undefined,
        getEmbeddingEngine: () => ({
            getProvider: () => "VoyageAI",
            getDimension: () => 1024,
        }),
        indexCodebase: async () => {
            throw new Error("boom after staged collection create");
        },
    };

    const host = {
        context,
        snapshotManager: {
            setCodebaseIndexing: () => undefined,
            setCodebaseIndexFailed: (codebasePath: string, errorMessage: string, progress?: number) => {
                failedSnapshots.push({ path: codebasePath, errorMessage, progress });
            },
            setCodebaseIndexed: () => undefined,
            setCodebaseIndexManifest: () => undefined,
        },
        syncManager: {
            recordCurrentIgnoreControlSignature: async () => undefined,
        },
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        resolveCollectionName,
        setWriteCollectionOverride: (_codebasePath: string, collectionName: string | null) => {
            writeCollectionOverride = collectionName;
        },
        loadIndexProfileForCodebase: () => ({ profile: "default" }),
        getContextActiveIgnorePatterns: () => [],
        getContextIndexedExtensions: () => [".ts"],
        canonicalizeCodebasePath: (codebasePath: string) => path.resolve(codebasePath),
        pruneIndexedCollectionFamily: async () => [],
        pruneUnprovenStagedCollectionFamily: async () => [],
        getContextTrackedRelativePaths: () => [],
        setIndexingStats: () => undefined,
        rebuildCallGraphForIndex: async () => undefined,
        touchWatchedCodebase: async () => undefined,
        saveSnapshotIfSupported: () => undefined,
        clearIndexCompletionMarker: async () => undefined,
        getSnapshotIndexingProgress: () => 42,
        buildCollectionLimitMessage: async () => "collection limit",
    };

    return {
        droppedCollections,
        failedSnapshots,
        handler: new ManageIndexingHandlers(host as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]) as unknown as StartBackgroundIndexing,
    };
}

test("startBackgroundIndexing deletes failed staged collection", async () => {
    await withTempRepo(async (repoPath) => {
        const stagedCollection = `${resolveCollectionName(repoPath)}__gen_run_failed`;
        const existingCollections = new Set<string>([stagedCollection]);
        const { handler, droppedCollections, failedSnapshots } = createFailedIndexingHarness(existingCollections);

        await handler.startBackgroundIndexing(repoPath, false, stagedCollection);

        assert.deepEqual(droppedCollections, [stagedCollection]);
        assert.equal(existingCollections.has(stagedCollection), false);
        assert.equal(failedSnapshots.length, 1);
        assert.match(failedSnapshots[0].errorMessage, /boom after staged collection create/);
    });
});

test("startBackgroundIndexing keeps stable collection after non-staged failure", async () => {
    await withTempRepo(async (repoPath) => {
        const stableCollection = resolveCollectionName(repoPath);
        const existingCollections = new Set<string>([stableCollection]);
        const { handler, droppedCollections, failedSnapshots } = createFailedIndexingHarness(existingCollections);

        await handler.startBackgroundIndexing(repoPath, false);

        assert.deepEqual(droppedCollections, []);
        assert.equal(existingCollections.has(stableCollection), true);
        assert.equal(failedSnapshots.length, 1);
    });
});

test("handleRepairIndex saves the manifest paths verified by repair", async () => {
    await withTempRepo(async (repoPath) => {
        let manifestPaths: string[] | null = null;
        let repairOptions: Record<string, unknown> | undefined;
        const handler = new ManageIndexingHandlers({
            context: {
                repairIndex: async (_codebasePath: string, options?: Record<string, unknown>) => {
                    repairOptions = options;
                    return {
                        status: "ok",
                        message: "repaired",
                        indexedFiles: 1,
                        totalChunks: 2,
                        warnings: [],
                        trackedRelativePaths: ["src/repaired.ts"],
                    };
                },
            },
            snapshotManager: {
                setCodebaseIndexed: () => undefined,
                setCodebaseIndexManifest: (_codebasePath: string, paths: string[]) => {
                    manifestPaths = paths;
                },
            },
            syncManager: {},
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            manageResponse: (action: string, responsePath: string, status: string, message: string, options?: Record<string, unknown>) => ({
                content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message, ...options }) }],
            }),
            buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
            recoverStaleIndexingStateIfNeeded: async () => undefined,
            getSnapshotIndexingCodebases: () => [],
            getSnapshotCodebaseInfo: () => ({
                status: "indexed",
                lastUpdated: new Date(0).toISOString(),
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
            }),
            getSnapshotIndexedCodebases: () => [],
            buildManageActionBlockedMessage: () => "blocked",
            buildCreateHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
            buildStatusHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
            getManageRetryAfterMs: () => 2000,
            buildIndexingMetadata: () => undefined,
            buildReindexInstruction: () => "reindex",
            buildManageRequiresReindexHints: () => ({}),
            validateCompletionProof: async () => ({ outcome: "missing_collection" }),
            recoverIndexedSnapshotFromCompletionProof: () => false,
            isZillizBackend: () => false,
            resolveCollectionName,
            dropZillizCollectionForCreate: async () => ({}),
            resolveStagedCollectionName: (codebasePath: string, generationId: string) => `${resolveCollectionName(codebasePath)}__gen_${generationId}`,
            buildCollectionLimitMessage: async () => "collection limit",
            manageVectorBackendResponse: (action: string, responsePath: string) => ({
                content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status: "error" }) }],
            }),
            saveSnapshotIfSupported: () => undefined,
            touchWatchedCodebase: async () => undefined,
            setWriteCollectionOverride: () => undefined,
            loadIndexProfileForCodebase: () => ({ profile: "default" }),
            getContextActiveIgnorePatterns: () => [],
            getContextIndexedExtensions: () => [".ts"],
            canonicalizeCodebasePath: (codebasePath: string) => path.resolve(codebasePath),
            pruneIndexedCollectionFamily: async () => [],
            pruneUnprovenStagedCollectionFamily: async () => [],
            getContextTrackedRelativePaths: () => ["stale/from-context.ts"],
            setIndexingStats: () => undefined,
            rebuildCallGraphForIndex: async () => undefined,
            getSnapshotIndexingProgress: () => undefined,
            clearIndexCompletionMarker: async () => undefined,
            evaluateReindexPreflight: () => ({ allowed: true }),
        } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

        const response = await handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "ok");
        assert.deepEqual(manifestPaths, ["src/repaired.ts"]);
        assert.deepEqual(repairOptions, { trustedFingerprint: RUNTIME_FINGERPRINT });
    });
});
