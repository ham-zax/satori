import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    INDEX_COMPLETION_MARKER_DOC_ID,
    type VectorDatabase,
} from "@zokizuan/satori-core";
import { MutationLeaseCoordinator, type RootMutationLease } from "./mutation-lease.js";
import { VectorBackendMaintenance } from "./vector-backend-maintenance.js";

const COLLECTION = "hybrid_code_chunks_deadbeef";

function currentCompletionMarker(codebasePath: string) {
    return {
        kind: "satori_index_completion_v3" as const,
        codebasePath,
        fingerprint: {
            embeddingProvider: "test",
            embeddingModel: "test",
            embeddingDimension: 4,
            vectorStoreProvider: "Milvus",
            schemaVersion: "hybrid_v3",
            parserVersion: "parser-v1",
            extractorVersion: "extractor-v1",
            relationshipVersion: "relationships-v1",
            embeddingProjectionVersion: "embedding_projection_v1",
            lexicalProjectionVersion: "lexical_projection_v1",
        },
        indexedFiles: 0,
        totalChunks: 0,
        completedAt: "2026-07-16T00:00:00.000Z",
        runId: "maintenance-test",
        indexPolicyHash: "0".repeat(64),
        indexStatus: "completed" as const,
        navigation: { status: "not_bound" as const },
    };
}

function retiredCompletionMarker(
    kind: "satori_index_completion_v1" | "satori_index_completion_v2",
    codebasePath: string,
) {
    const current = currentCompletionMarker(codebasePath);
    return {
        kind,
        codebasePath,
        fingerprint: current.fingerprint,
        indexedFiles: current.indexedFiles,
        totalChunks: current.totalChunks,
        completedAt: current.completedAt,
        runId: current.runId,
        ...(kind === "satori_index_completion_v2"
            ? { indexPolicyHash: current.indexPolicyHash }
            : {}),
    };
}

function withTempRoots<T>(fn: (roots: {
    targetRoot: string;
    mappedRoot: string;
    stateDir: string;
}) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-vector-maintenance-"));
    const targetRoot = path.join(tempDir, "target");
    const mappedRoot = path.join(tempDir, "mapped");
    const stateDir = path.join(tempDir, "leases");
    fs.mkdirSync(targetRoot);
    fs.mkdirSync(mappedRoot);
    return fn({ targetRoot, mappedRoot, stateDir }).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function createReceiptHarness(options: {
    mappedRoot: string;
    coordinator: MutationLeaseCoordinator;
    onSave?: (phase: string | undefined, lease: RootMutationLease | undefined) => boolean | void;
}) {
    const events: string[] = [];
    const phases: string[] = [];
    let collectionExists = true;
    let currentPhase: string | undefined;
    let operationLease: RootMutationLease | undefined;

    const vectorDb = {
        getBackendInfo: () => ({ provider: "zilliz", transport: "grpc" }),
        hasCollection: async () => collectionExists,
        queryDocuments: async () => [{
            metadata: JSON.stringify({ codebasePath: options.mappedRoot }),
        }],
        dropCollection: async () => {
            events.push(`drop:${currentPhase || "none"}`);
            collectionExists = false;
        },
    } as unknown as VectorDatabase;

    const snapshotManager = {
        startOperation: (lease: RootMutationLease) => {
            operationLease = lease;
            currentPhase = "accepted";
            phases.push(currentPhase);
            events.push(`phase:${currentPhase}`);
            return {};
        },
        transitionOperation: (_lease: RootMutationLease, phase: string) => {
            currentPhase = phase;
            phases.push(phase);
            events.push(`phase:${phase}`);
            return {};
        },
        saveCodebaseSnapshot: () => {
            events.push(`save:${currentPhase || "none"}`);
            return options.onSave?.(currentPhase, operationLease) ?? true;
        },
    };

    const maintenance = new VectorBackendMaintenance({
        context: { getVectorStore: () => vectorDb },
        snapshotManager,
        getSnapshotAllCodebases: () => [{ path: options.mappedRoot, info: {} }],
        canonicalizeCodebasePath: (codebasePath: string) => fs.realpathSync.native(path.resolve(codebasePath)),
        resolveCollectionName: () => COLLECTION,
        markCodebaseCleared: () => {
            events.push(`clear:${currentPhase || "none"}`);
        },
        saveSnapshotIfSupported: () => {
            events.push("legacy-save");
        },
        unwatchCodebase: async () => {
            events.push(`unwatch:${currentPhase || "none"}`);
        },
        mutationLeaseCoordinator: options.coordinator,
    } as unknown as ConstructorParameters<typeof VectorBackendMaintenance>[0]);

    return {
        events,
        phases,
        maintenance,
        getOperationLease: () => operationLease,
        collectionExists: () => collectionExists,
    };
}

function acquireCreateLease(
    coordinator: MutationLeaseCoordinator,
    root: string,
): RootMutationLease {
    const result = coordinator.acquire(root, "create");
    assert.equal(result.acquired, true);
    if (!result.acquired) {
        throw new Error("Expected create lease acquisition to succeed.");
    }
    return result.lease;
}

test("cross-root Zilliz eviction persists accepted through completed clear phases", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot, stateDir }) => {
        const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: "receipt-owner" });
        const createLease = acquireCreateLease(coordinator, targetRoot);
        const harness = createReceiptHarness({ mappedRoot, coordinator });

        try {
            const result = await harness.maintenance.dropZillizCollectionForCreate(COLLECTION, createLease);

            assert.deepEqual(result, { status: "dropped", droppedCodebasePath: mappedRoot });
            assert.deepEqual(harness.phases, ["accepted", "writing", "publishing", "completed"]);
            assert.ok(harness.events.indexOf("save:accepted") < harness.events.indexOf("drop:writing"));
            assert.ok(harness.events.indexOf("drop:writing") < harness.events.indexOf("clear:completed"));
            assert.ok(harness.events.indexOf("clear:completed") < harness.events.indexOf("save:completed"));
            assert.equal(harness.collectionExists(), false);

            const clearLease = harness.getOperationLease();
            assert.ok(clearLease);
            assert.equal(clearLease.action, "clear");
            assert.equal(clearLease.canonicalRoot, mappedRoot);
            assert.notEqual(clearLease.operationId, createLease.operationId);
            assert.equal(coordinator.getActiveLease(mappedRoot), undefined);
            assert.equal(coordinator.isCurrent(createLease), true);
        } finally {
            coordinator.release(createLease);
        }
    });
});

test("cross-root Zilliz eviction terminalizes an owned receipt when persistence fails", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot, stateDir }) => {
        const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: "failure-owner" });
        const createLease = acquireCreateLease(coordinator, targetRoot);
        let rejectedWritingSave = false;
        const harness = createReceiptHarness({
            mappedRoot,
            coordinator,
            onSave: (phase) => {
                if (phase === "writing" && !rejectedWritingSave) {
                    rejectedWritingSave = true;
                    return false;
                }
                return true;
            },
        });

        try {
            await assert.rejects(
                harness.maintenance.dropZillizCollectionForCreate(COLLECTION, createLease),
                /Failed to persist clear phase 'writing'/,
            );

            assert.deepEqual(harness.phases, ["accepted", "writing", "failed"]);
            assert.equal(harness.events.includes("save:failed"), true);
            assert.equal(harness.events.some((event) => event.startsWith("drop:")), false);
            assert.equal(harness.collectionExists(), true);
            assert.equal(coordinator.getActiveLease(mappedRoot), undefined);
            assert.equal(coordinator.isCurrent(createLease), true);
        } finally {
            coordinator.release(createLease);
        }
    });
});

test("cross-root Zilliz eviction does not publish failed after losing its clear generation", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot, stateDir }) => {
        const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: "stale-owner" });
        const replacementCoordinator = new MutationLeaseCoordinator({ stateDir, ownerId: "replacement-owner" });
        const createLease = acquireCreateLease(coordinator, targetRoot);
        let replacementLease: RootMutationLease | undefined;
        let replaced = false;
        const harness = createReceiptHarness({
            mappedRoot,
            coordinator,
            onSave: (phase, lease) => {
                if (phase === "writing" && lease && !replaced) {
                    replaced = true;
                    assert.equal(coordinator.release(lease), true);
                    const replacement = replacementCoordinator.acquire(mappedRoot, "sync");
                    assert.equal(replacement.acquired, true);
                    if (replacement.acquired) {
                        replacementLease = replacement.lease;
                    }
                    return false;
                }
                return true;
            },
        });

        try {
            await assert.rejects(
                harness.maintenance.dropZillizCollectionForCreate(COLLECTION, createLease),
                /Failed to persist clear phase 'writing'/,
            );

            assert.deepEqual(harness.phases, ["accepted", "writing"]);
            assert.equal(harness.events.includes("save:failed"), false);
            assert.equal(replacementLease?.generation, 2);
            assert.equal(replacementCoordinator.isCurrent(replacementLease!), true);
        } finally {
            if (replacementLease) {
                replacementCoordinator.release(replacementLease);
            }
            coordinator.release(createLease);
        }
    });
});

test("same-root Zilliz eviction reuses the caller create lease without a nested clear receipt", async () => {
    await withTempRoots(async ({ targetRoot, stateDir }) => {
        const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: "same-root-owner" });
        const createLease = acquireCreateLease(coordinator, targetRoot);
        const harness = createReceiptHarness({ mappedRoot: targetRoot, coordinator });

        try {
            const result = await harness.maintenance.dropZillizCollectionForCreate(COLLECTION, createLease);

            assert.deepEqual(result, { status: "dropped", droppedCodebasePath: targetRoot });
            assert.deepEqual(harness.phases, []);
            assert.equal(harness.getOperationLease(), undefined);
            assert.equal(harness.events.includes("drop:none"), true);
            assert.equal(harness.events.includes("legacy-save"), true);
            assert.equal(coordinator.getActiveLease(targetRoot)?.operationId, createLease.operationId);
            assert.equal(coordinator.isCurrent(createLease), true);
        } finally {
            coordinator.release(createLease);
        }
    });
});

test("Zilliz guidance resolves an untracked marker-only collection from its control record", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot }) => {
        let payloadQueries = 0;
        const vectorDb = {
            getBackendInfo: () => ({ provider: "zilliz", transport: "grpc" }),
            listCollectionDetails: async () => [{ name: COLLECTION }],
            getControl: async (_collectionName: string, id: string) => {
                assert.equal(id, INDEX_COMPLETION_MARKER_DOC_ID);
                return {
                    id,
                    kind: "satori_index_completion_v3",
                    metadata: currentCompletionMarker(mappedRoot),
                };
            },
            queryDocuments: async () => {
                payloadQueries++;
                return [];
            },
        } as unknown as VectorDatabase;
        const maintenance = new VectorBackendMaintenance({
            context: { getVectorStore: () => vectorDb },
            snapshotManager: {},
            getSnapshotAllCodebases: () => [],
            canonicalizeCodebasePath: (codebasePath: string) => fs.realpathSync.native(path.resolve(codebasePath)),
            resolveCollectionName: () => COLLECTION,
            markCodebaseCleared: () => undefined,
            saveSnapshotIfSupported: () => undefined,
            unwatchCodebase: async () => undefined,
            mutationLeaseCoordinator: null,
        } as unknown as ConstructorParameters<typeof VectorBackendMaintenance>[0]);

        const guidance = await maintenance.buildCollectionLimitMessage(targetRoot);

        assert.equal(guidance.includes(mappedRoot), true);
        assert.equal(payloadQueries, 0);
    });
});

test("Zilliz guidance resolves marker-only collections from recognized retired controls", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot }) => {
        for (const kind of [
            "satori_index_completion_v1",
            "satori_index_completion_v2",
        ] as const) {
            let payloadQueries = 0;
            const vectorDb = {
                getBackendInfo: () => ({ provider: "zilliz", transport: "grpc" }),
                listCollectionDetails: async () => [{ name: COLLECTION }],
                getControl: async () => ({
                    id: INDEX_COMPLETION_MARKER_DOC_ID,
                    kind,
                    metadata: retiredCompletionMarker(kind, mappedRoot),
                }),
                queryDocuments: async () => {
                    payloadQueries++;
                    return [];
                },
            } as unknown as VectorDatabase;
            const maintenance = new VectorBackendMaintenance({
                context: { getVectorStore: () => vectorDb },
                snapshotManager: {},
                getSnapshotAllCodebases: () => [],
                canonicalizeCodebasePath: (codebasePath: string) => fs.realpathSync.native(path.resolve(codebasePath)),
                resolveCollectionName: () => COLLECTION,
                markCodebaseCleared: () => undefined,
                saveSnapshotIfSupported: () => undefined,
                unwatchCodebase: async () => undefined,
                mutationLeaseCoordinator: null,
            } as unknown as ConstructorParameters<typeof VectorBackendMaintenance>[0]);

            const guidance = await maintenance.buildCollectionLimitMessage(targetRoot);
            assert.equal(guidance.includes(mappedRoot), true);
            assert.equal(payloadQueries, 0);
        }
    });
});

test("Zilliz guidance rejects malformed or routing-mismatched completion controls", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot }) => {
        const validMarker = currentCompletionMarker(mappedRoot);
        const invalidRecords = [
            {
                id: INDEX_COMPLETION_MARKER_DOC_ID,
                kind: "unexpected_control",
                metadata: validMarker,
            },
            {
                id: INDEX_COMPLETION_MARKER_DOC_ID,
                kind: "satori_index_completion_v3",
                metadata: { ...validMarker, kind: "satori_index_completion_v2" },
            },
            {
                id: INDEX_COMPLETION_MARKER_DOC_ID,
                kind: "satori_index_completion_v3",
                metadata: { kind: "satori_index_completion_v3", codebasePath: mappedRoot },
            },
        ];

        for (const record of invalidRecords) {
            let payloadQueries = 0;
            const vectorDb = {
                getBackendInfo: () => ({ provider: "zilliz", transport: "grpc" }),
                listCollectionDetails: async () => [{ name: COLLECTION }],
                getControl: async () => record,
                queryDocuments: async () => {
                    payloadQueries++;
                    return [];
                },
            } as unknown as VectorDatabase;
            const maintenance = new VectorBackendMaintenance({
                context: { getVectorStore: () => vectorDb },
                snapshotManager: {},
                getSnapshotAllCodebases: () => [],
                canonicalizeCodebasePath: (codebasePath: string) => fs.realpathSync.native(path.resolve(codebasePath)),
                resolveCollectionName: () => COLLECTION,
                markCodebaseCleared: () => undefined,
                saveSnapshotIfSupported: () => undefined,
                unwatchCodebase: async () => undefined,
                mutationLeaseCoordinator: null,
            } as unknown as ConstructorParameters<typeof VectorBackendMaintenance>[0]);

            const guidance = await maintenance.buildCollectionLimitMessage(targetRoot);
            assert.equal(guidance.includes(mappedRoot), false);
            assert.equal(payloadQueries, 0);
        }
    });
});

test("Zilliz guidance retains trusted snapshot ownership when a control is malformed", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot }) => {
        let payloadQueries = 0;
        const vectorDb = {
            getBackendInfo: () => ({ provider: "zilliz", transport: "grpc" }),
            listCollectionDetails: async () => [{ name: COLLECTION }],
            getControl: async () => ({
                id: INDEX_COMPLETION_MARKER_DOC_ID,
                kind: "satori_index_completion_v3",
                metadata: { kind: "satori_index_completion_v3", codebasePath: targetRoot },
            }),
            queryDocuments: async () => {
                payloadQueries++;
                return [];
            },
        } as unknown as VectorDatabase;
        const maintenance = new VectorBackendMaintenance({
            context: { getVectorStore: () => vectorDb },
            snapshotManager: {},
            getSnapshotAllCodebases: () => [{ path: mappedRoot, info: {} }],
            canonicalizeCodebasePath: (codebasePath: string) => fs.realpathSync.native(path.resolve(codebasePath)),
            resolveCollectionName: () => COLLECTION,
            markCodebaseCleared: () => undefined,
            saveSnapshotIfSupported: () => undefined,
            unwatchCodebase: async () => undefined,
            mutationLeaseCoordinator: null,
        } as unknown as ConstructorParameters<typeof VectorBackendMaintenance>[0]);

        const guidance = await maintenance.buildCollectionLimitMessage(targetRoot);
        assert.equal(guidance.includes(mappedRoot), true);
        assert.equal(payloadQueries, 0);
    });
});

test("Zilliz guidance preserves whitespace-bearing repository identity from a valid marker", async () => {
    await withTempRoots(async ({ targetRoot, mappedRoot }) => {
        const whitespaceRoot = `${mappedRoot} `;
        fs.mkdirSync(whitespaceRoot);
        const vectorDb = {
            getBackendInfo: () => ({ provider: "zilliz", transport: "grpc" }),
            listCollectionDetails: async () => [{ name: COLLECTION }],
            getControl: async () => ({
                id: INDEX_COMPLETION_MARKER_DOC_ID,
                kind: "satori_index_completion_v3",
                metadata: currentCompletionMarker(whitespaceRoot),
            }),
        } as unknown as VectorDatabase;
        const maintenance = new VectorBackendMaintenance({
            context: { getVectorStore: () => vectorDb },
            snapshotManager: {},
            getSnapshotAllCodebases: () => [],
            canonicalizeCodebasePath: (codebasePath: string) => fs.realpathSync.native(path.resolve(codebasePath)),
            resolveCollectionName: () => COLLECTION,
            markCodebaseCleared: () => undefined,
            saveSnapshotIfSupported: () => undefined,
            unwatchCodebase: async () => undefined,
            mutationLeaseCoordinator: null,
        } as unknown as ConstructorParameters<typeof VectorBackendMaintenance>[0]);

        const guidance = await maintenance.buildCollectionLimitMessage(targetRoot);
        assert.equal(guidance.includes(whitespaceRoot), true);
    });
});
