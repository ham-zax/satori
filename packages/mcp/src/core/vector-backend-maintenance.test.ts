import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VectorDatabase } from "@zokizuan/satori-core";
import { MutationLeaseCoordinator, type RootMutationLease } from "./mutation-lease.js";
import { VectorBackendMaintenance } from "./vector-backend-maintenance.js";

const COLLECTION = "hybrid_code_chunks_deadbeef";

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
        query: async () => [{
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
