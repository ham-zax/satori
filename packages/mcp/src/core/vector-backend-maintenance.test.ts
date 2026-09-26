import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RootMutationRuntime } from "@zokizuan/satori-core/integration";
import { VectorBackendMaintenance } from "./vector-backend-maintenance.js";

function candidateReceipt(root: string) {
    return {
        version: 1 as const,
        canonicalRoot: root,
        operationId: "old-op",
        action: "reindex" as const,
        generation: 1,
        collectionName: "code_chunks_deadbeef__gen_old_op",
        ownerId: "old-owner",
        pid: 99999,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        phase: "collection_created" as const,
    };
}

test("stale candidate recovery deletes an unreferenced orphan and clears its receipt", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-recovery-"));
    const root = path.join(stateDir, "repo");
    fs.mkdirSync(root);
    const runtime = new RootMutationRuntime({ stateDir: path.join(stateDir, "mutations") });
    const receipt = candidateReceipt(root);
    let collectionExists = true;
    const dropped: string[] = [];
    const cleared: string[] = [];

    const maintenance = new VectorBackendMaintenance({
        context: {
            getVectorStore: () => ({
                hasCollection: async (name: string) => name === receipt.collectionName && collectionExists,
                dropCollection: async (name: string) => {
                    dropped.push(name);
                    if (name === receipt.collectionName) collectionExists = false;
                },
            }),
            listIndexCandidateReceipts: () => [receipt],
            isPublicationCollectionReferenced: () => false,
            clearIndexCandidateReceiptForCollection: (_root: string, collectionName: string) => {
                cleared.push(collectionName);
                return true;
            },
        },
        canonicalizeCodebasePath: (value: string) => path.resolve(value),
        resolveCollectionName: () => "unused",
        unwatchCodebase: async () => undefined,
        mutationRuntime: runtime,
    } as never);

    try {
        await runtime.run(root, "create", async () => undefined);
        const result = await runtime.run(root, "reindex", async () => (
            maintenance.recoverStaleIndexCandidates(root)
        ));

        assert.deepEqual(result.recoveredCollections, [receipt.collectionName]);
        assert.deepEqual(result.clearedReceipts, [receipt.collectionName]);
        assert.deepEqual(dropped, [receipt.collectionName]);
        assert.deepEqual(cleared, [receipt.collectionName]);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test("stale candidate recovery preserves collections referenced by any Publication generation", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-preserve-"));
    const root = path.join(stateDir, "repo");
    fs.mkdirSync(root);
    const runtime = new RootMutationRuntime({ stateDir: path.join(stateDir, "mutations") });
    const receipt = candidateReceipt(root);
    let backendTouched = false;
    const cleared: string[] = [];

    const maintenance = new VectorBackendMaintenance({
        context: {
            getVectorStore: () => ({
                hasCollection: async () => {
                    backendTouched = true;
                    return true;
                },
                dropCollection: async () => {
                    backendTouched = true;
                },
            }),
            listIndexCandidateReceipts: () => [receipt],
            isPublicationCollectionReferenced: () => true,
            clearIndexCandidateReceiptForCollection: (_root: string, collectionName: string) => {
                cleared.push(collectionName);
                return true;
            },
        },
        canonicalizeCodebasePath: (value: string) => path.resolve(value),
        resolveCollectionName: () => "unused",
        unwatchCodebase: async () => undefined,
        mutationRuntime: runtime,
    } as never);

    try {
        await runtime.run(root, "create", async () => undefined);
        const result = await runtime.run(root, "reindex", async () => (
            maintenance.recoverStaleIndexCandidates(root)
        ));

        assert.deepEqual(result.recoveredCollections, []);
        assert.deepEqual(result.clearedReceipts, [receipt.collectionName]);
        assert.equal(backendTouched, false);
        assert.deepEqual(cleared, [receipt.collectionName]);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});
