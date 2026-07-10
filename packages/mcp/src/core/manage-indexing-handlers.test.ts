import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ManageIndexingHandlers } from "./manage-indexing-handlers.js";
import type {
    IndexFingerprint,
    IndexOperationPhase,
    IndexOperationReceipt,
} from "../config.js";
import {
    MutationLeaseCoordinator,
    type RootMutationLease,
} from "./mutation-lease.js";

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: "VoyageAI",
    embeddingModel: "voyage-code-3",
    embeddingDimension: 1024,
    vectorStoreProvider: "Milvus",
    schemaVersion: "hybrid_v3",
};

const REPAIR_PROOF = {
    collection: { status: "matched", basis: "selected_snapshot_collection" },
    snapshot: { status: "matched", basis: "verified_snapshot_fingerprint" },
    marker: { status: "missing", basis: "completion_marker_missing" },
    fingerprint: { status: "matched", basis: "verified_snapshot_fingerprint" },
    payload: { status: "matched", expectedCount: 2, observedCount: 2, missingCount: 0 },
    staleRemoteChunks: { status: "matched", extraCount: 0 },
    navigation: { status: "matched", basis: "navigation_sidecars_rebuilt" },
} as const;

type StartBackgroundIndexing = {
    startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        writeCollectionName?: string,
        mutationLease?: RootMutationLease,
    ): Promise<void>;
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

type RepairResult = {
    status: "ok" | "blocked" | "requires_reindex";
    reason?: "needs_create" | "requires_reindex";
    message: string;
    missingCount?: number;
    warnings?: string[];
    indexedFiles?: number;
    totalChunks?: number;
    trackedRelativePaths?: string[];
    collectionName?: string;
    proof?: Record<string, { status: string; [key: string]: unknown }>;
};

type RepairOptionsLike = {
    onProofUpdate?: (proof: Record<string, { status: string; [key: string]: unknown }>) => void;
};

function createRepairReceiptHarness(
    repoPath: string,
    options: {
        withLease?: boolean;
        failAcceptedSave?: boolean;
        repairIndex?: (repairOptions?: RepairOptionsLike) => Promise<RepairResult>;
        touchWatchedCodebase?: () => Promise<void>;
    } = {},
) {
    const events: string[] = [];
    const persisted: Array<{ phase: IndexOperationPhase; indexed: boolean }> = [];
    let receipt: IndexOperationReceipt | undefined;
    let indexed = false;
    let compatibilitySaveCalls = 0;
    let repairCalls = 0;
    let failedAcceptedSave = false;
    const coordinator = options.withLease === false
        ? undefined
        : new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "repair-receipt-leases"),
            ownerId: "repair-receipt-owner",
        });

    const handler = new ManageIndexingHandlers({
        context: {
            repairIndex: async (_codebasePath: string, repairOptions?: RepairOptionsLike) => {
                repairCalls += 1;
                events.push("repair");
                return options.repairIndex
                    ? options.repairIndex(repairOptions)
                    : {
                        status: "ok" as const,
                        message: "repaired",
                        indexedFiles: 1,
                        totalChunks: 2,
                        warnings: [],
                        trackedRelativePaths: ["src/repaired.ts"],
                        collectionName: "repair-collection",
                        proof: REPAIR_PROOF,
                    };
            },
        },
        snapshotManager: {
            startOperation: (lease: RootMutationLease) => {
                events.push("start:accepted");
                receipt = {
                    id: lease.operationId,
                    action: lease.action,
                    canonicalRoot: lease.canonicalRoot,
                    generation: lease.generation,
                    acceptedAt: lease.acquiredAt,
                    phase: "accepted",
                    lastDurableTransitionAt: lease.acquiredAt,
                    runtimeFingerprint: RUNTIME_FINGERPRINT,
                    writer: {
                        ownerId: lease.ownerId,
                        pid: lease.pid,
                        satoriVersion: "test",
                    },
                };
                return receipt;
            },
            transitionOperation: (_lease: RootMutationLease, phase: IndexOperationPhase) => {
                assert.ok(receipt);
                events.push(`transition:${phase}`);
                receipt = {
                    ...receipt,
                    phase,
                    lastDurableTransitionAt: new Date().toISOString(),
                };
                return receipt;
            },
            saveCodebaseSnapshot: () => {
                assert.ok(receipt);
                events.push(`save:${receipt.phase}`);
                if (options.failAcceptedSave && receipt.phase === "accepted" && !failedAcceptedSave) {
                    failedAcceptedSave = true;
                    return false;
                }
                persisted.push({ phase: receipt.phase, indexed });
                return true;
            },
            setCodebaseIndexed: () => {
                events.push("set:indexed");
                indexed = true;
            },
            setCodebaseIndexManifest: () => events.push("set:manifest"),
        },
        syncManager: {},
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        manageResponse: (action: string, responsePath: string, status: string, message: string, responseOptions?: Record<string, unknown>) => ({
            content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message, ...responseOptions }) }],
        }),
        buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
        getSnapshotIndexingCodebases: () => [],
        getSnapshotCodebaseInfo: () => ({
            status: "indexed",
            collectionName: "repair-collection",
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: "verified",
        }),
        buildManageActionBlockedMessage: () => "blocked",
        buildCreateHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
        buildReindexHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "reindex", path: codebasePath } }),
        buildStatusHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
        getManageRetryAfterMs: () => 2000,
        buildIndexingMetadata: () => undefined,
        buildManageRequiresReindexHints: () => ({}),
        manageVectorBackendResponse: (
            action: string,
            responsePath: string,
            diagnostic: { code: string; message: string },
            _humanText?: string,
            operation?: IndexOperationReceipt,
            repairProof?: Record<string, unknown>,
        ) => ({
            content: [{
                type: "text",
                text: JSON.stringify({
                    action,
                    path: responsePath,
                    status: "error",
                    code: diagnostic.code,
                    message: diagnostic.message,
                    operation,
                    repairProof,
                }),
            }],
        }),
        getContextTrackedRelativePaths: () => [],
        setIndexingStats: () => undefined,
        rebuildCallGraphForIndex: async () => events.push("rebuild:call-graph"),
        touchWatchedCodebase: options.touchWatchedCodebase
            ?? (async () => { events.push("touch:watch"); }),
        saveSnapshotIfSupported: () => {
            compatibilitySaveCalls += 1;
            events.push("save:compatibility");
        },
        mutationLeaseCoordinator: coordinator,
    } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

    return {
        coordinator,
        events,
        get compatibilitySaveCalls() {
            return compatibilitySaveCalls;
        },
        get persisted() {
            return persisted;
        },
        get repairCalls() {
            return repairCalls;
        },
        handler,
    };
}

function createFailedIndexingHarness(
    existingCollections: Set<string>,
    options: {
        mutationLeaseCoordinator?: MutationLeaseCoordinator;
        indexCodebase?: () => Promise<{ indexedFiles: number; totalChunks: number; status: "completed" }>;
        beforeHasCollection?: (collectionName: string) => void;
    } = {},
) {
    const droppedCollections: string[] = [];
    const failedSnapshots: Array<{ path: string; errorMessage: string; progress?: number }> = [];
    let writeCollectionOverride: string | null = null;

    const vectorStore = {
        hasCollection: async (collectionName: string) => {
            options.beforeHasCollection?.(collectionName);
            return existingCollections.has(collectionName);
        },
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
        indexCodebase: options.indexCodebase ?? (async () => {
            throw new Error("boom after staged collection create");
        }),
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
        mutationLeaseCoordinator: options.mutationLeaseCoordinator,
    };

    return {
        droppedCollections,
        failedSnapshots,
        handler: new ManageIndexingHandlers(host as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]) as unknown as StartBackgroundIndexing,
    };
}

test("startBackgroundIndexing holds the lease until terminal completion", async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), "lease-state");
        const currentProcess = { pid: 101, processStartTime: "start-101" };
        const coordinator = new MutationLeaseCoordinator({
            stateDir,
            ownerId: "owner-a",
            currentProcess,
            processInspector: {
                inspect: (pid) => pid === currentProcess.pid ? currentProcess : null,
            },
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let finishIndexing!: (value: { indexedFiles: number; totalChunks: number; status: "completed" }) => void;
        const indexing = new Promise<{ indexedFiles: number; totalChunks: number; status: "completed" }>((resolve) => {
            finishIndexing = resolve;
        });
        const { handler } = createFailedIndexingHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: () => indexing,
        });

        const background = handler.startBackgroundIndexing(repoPath, false, undefined, acquired.lease);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(coordinator.isCurrent(acquired.lease), true);

        finishIndexing({ indexedFiles: 1, totalChunks: 1, status: "completed" });
        await background;
        assert.equal(coordinator.isCurrent(acquired.lease), false);
    });
});

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

test("startBackgroundIndexing does not clean or publish failure after lease loss during cleanup", async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), "lease-state");
        const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: "owner-a" });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        const stagedCollection = `${resolveCollectionName(repoPath)}__gen_run_failed`;
        const existingCollections = new Set<string>([stagedCollection]);
        let released = false;
        const { handler, droppedCollections, failedSnapshots } = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            beforeHasCollection: () => {
                if (!released) {
                    released = true;
                    coordinator.release(acquired.lease);
                }
            },
        });

        await handler.startBackgroundIndexing(repoPath, false, stagedCollection, acquired.lease);

        assert.deepEqual(droppedCollections, []);
        assert.equal(existingCollections.has(stagedCollection), true);
        assert.deepEqual(failedSnapshots, []);
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
                collectionName: "snapshot-selected-collection",
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
        assert.equal(typeof repairOptions?.onProofUpdate, "function");
        const proofOptions = { ...(repairOptions || {}) };
        delete proofOptions.onProofUpdate;
        assert.deepEqual(proofOptions, {
            snapshotEvidence: {
                status: "verified",
                basis: "verified_snapshot_fingerprint",
                fingerprint: RUNTIME_FINGERPRINT,
            },
            preferredCollectionName: "snapshot-selected-collection",
        });
    });
});

test("handleRepairIndex does not publish success after lease loss during call-graph rebuild", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "lease-state"),
            ownerId: "owner-a",
        });
        let indexedCalls = 0;
        let saveCalls = 0;
        const handler = new ManageIndexingHandlers({
            context: {
                repairIndex: async () => ({
                    status: "ok",
                    message: "repaired",
                    indexedFiles: 1,
                    totalChunks: 2,
                    warnings: [],
                    trackedRelativePaths: ["src/repaired.ts"],
                }),
            },
            snapshotManager: {
                setCodebaseIndexed: () => { indexedCalls += 1; },
                setCodebaseIndexManifest: () => undefined,
            },
            syncManager: {},
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            manageResponse: (action: string, responsePath: string, status: string, message: string) => ({
                content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message }) }],
            }),
            buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
            getSnapshotIndexingCodebases: () => [],
            getSnapshotCodebaseInfo: () => ({
                status: "indexed",
                collectionName: "snapshot-selected-collection",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
            }),
            buildStatusHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
            getManageRetryAfterMs: () => 2000,
            buildIndexingMetadata: () => undefined,
            buildReindexInstruction: () => "reindex",
            buildManageRequiresReindexHints: () => ({}),
            buildCreateHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
            getContextTrackedRelativePaths: () => [],
            setIndexingStats: () => undefined,
            rebuildCallGraphForIndex: async (_codebasePath: string, assertMutationCurrent?: () => void) => {
                const lease = coordinator.getActiveLease(repoPath);
                assert.ok(lease);
                coordinator.release(lease);
                assertMutationCurrent?.();
            },
            touchWatchedCodebase: async () => undefined,
            saveSnapshotIfSupported: () => { saveCalls += 1; },
            getSnapshotIndexingProgress: () => undefined,
            clearIndexCompletionMarker: async () => undefined,
            mutationLeaseCoordinator: coordinator,
        } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

        const response = await handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "error");
        assert.match(payload.message, /mutation lease .* is no longer current/i);
        assert.equal(indexedCalls, 0);
        assert.equal(saveCalls, 0);
    });
});

test("handleRepairIndex durably accepts before repair and commits completed receipt with lifecycle", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath);

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "ok");
        assert.equal(payload.operation?.phase, "completed");
        assert.deepEqual(
            harness.persisted.map((entry) => entry.phase),
            ["accepted", "proving", "publishing", "completed"],
        );
        assert.equal(harness.persisted.at(-1)?.indexed, true);
        assert.ok(harness.events.indexOf("save:accepted") < harness.events.indexOf("repair"));
        assert.ok(harness.events.indexOf("save:proving") < harness.events.indexOf("repair"));
        assert.ok(harness.events.indexOf("set:indexed") < harness.events.indexOf("save:completed"));
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex refuses repair side effects when accepted receipt is not durable", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, { failAcceptedSave: true });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "error");
        assert.equal(payload.operation?.phase, "failed");
        assert.equal(harness.repairCalls, 0);
        assert.deepEqual(harness.persisted.map((entry) => entry.phase), ["failed"]);
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex publishes blocked receipt when proof requires reindex", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            repairIndex: async () => ({
                status: "requires_reindex",
                reason: "requires_reindex",
                message: "fingerprint mismatch",
                proof: {
                    ...REPAIR_PROOF,
                    marker: { status: "failed", basis: "completion_marker_fingerprint_mismatch" },
                    fingerprint: { status: "failed", basis: "completion_marker_fingerprint_mismatch" },
                    payload: { status: "not_checked" },
                    staleRemoteChunks: { status: "not_checked" },
                    navigation: { status: "not_checked" },
                },
            }),
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
            repairProof?: typeof REPAIR_PROOF;
            hints?: Record<string, unknown>;
        };

        assert.equal(payload.status, "requires_reindex");
        assert.equal(payload.operation?.phase, "blocked");
        assert.equal(payload.repairProof?.marker.status, "failed");
        assert.deepEqual(payload.hints?.nextAction, {
            tool: "manage_index",
            args: { action: "reindex", path: repoPath },
        });
        assert.equal(harness.persisted.at(-1)?.phase, "blocked");
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex publishes failed receipt when repair throws", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            repairIndex: async () => {
                throw new Error("repair exploded");
            },
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "error");
        assert.equal(payload.operation?.phase, "failed");
        assert.equal(harness.persisted.at(-1)?.phase, "failed");
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex preserves partial proof when the vector backend fails", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            repairIndex: async (repairOptions) => {
                repairOptions?.onProofUpdate?.({
                    ...REPAIR_PROOF,
                    payload: { status: "not_checked" },
                    staleRemoteChunks: { status: "not_checked" },
                    navigation: { status: "not_checked" },
                });
                throw new Error("milvus connection closed during repair proof");
            },
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            code?: string;
            repairProof?: typeof REPAIR_PROOF;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "error");
        assert.equal(payload.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
        assert.equal(payload.operation?.phase, "failed");
        assert.equal(payload.repairProof?.collection.status, "matched");
        assert.equal(payload.repairProof?.navigation.status, "not_checked");
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex preserves matched navigation proof when watcher touch fails afterward", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            touchWatchedCodebase: async () => {
                throw new Error("watcher touch failed");
            },
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            message: string;
            repairProof?: typeof REPAIR_PROOF;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "error");
        assert.match(payload.message, /watcher touch failed/i);
        assert.equal(payload.operation?.phase, "failed");
        assert.equal(payload.repairProof?.navigation.status, "matched");
        assert.equal(payload.repairProof?.navigation.basis, "navigation_and_call_graph_rebuilt");
    });
});

test("handleRepairIndex without lease capability does not fabricate a receipt", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, { withLease: false });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "ok");
        assert.equal(payload.operation, undefined);
        assert.deepEqual(harness.persisted, []);
        assert.equal(harness.compatibilitySaveCalls, 1);
    });
});
