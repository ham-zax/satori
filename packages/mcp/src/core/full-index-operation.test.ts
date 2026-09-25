import assert from "node:assert/strict";
import test from "node:test";
import { RootMutationCancelledError } from "@zokizuan/satori-core/integration";
import { FullIndexOperation } from "./full-index-operation.js";

const policy = {
    canonicalRoot: "/repo",
    profile: "default" as const,
    customExtensions: [],
    customIgnorePatterns: [],
    fileBasedIgnorePatterns: [],
    supportedExtensions: [".ts"],
    effectiveIgnorePatterns: [],
    policyHash: "policy",
    controlSignature: "controls",
};

function publication(id: string, collectionName: string, totalChunks: number) {
    return {
        id,
        publication: {
            id,
            canonicalRoot: "/repo",
            status: "complete",
            vector: {
                collectionName,
                indexedFiles: 1,
                totalChunks,
            },
            policy,
        },
    };
}

test("supervised candidate cancellation preserves the previous publication lifecycle", async () => {
    const phases: string[] = [];
    let restoredWatcher = false;
    const previous = publication("old", "collection-old", 4);
    const operation = new FullIndexOperation({
        context: {
            getCurrentPublication: () => previous,
            resolveIndexPolicyForReindex: async () => policy,
            getEmbeddingEngine: () => ({
                getProvider: () => "fixture",
                getDimension: () => 3,
            }),
        },
        mutationRuntime: {
            assertCurrent: () => undefined,
            isCurrent: () => true,
            getCurrentOperation: () => ({ id: "op-reindex" }),
            updateCurrentOperation: (_root: string, phase: string) => {
                phases.push(phase);
                return { id: "op-reindex", phase };
            },
        },
        syncManager: {
            beginFullIndexSourceHandoff: () => undefined,
            touchWatchedCodebase: async () => undefined,
            rejectFullIndexSourceHandoff: () => true,
            restoreActiveWatcherPolicy: async () => {
                restoredWatcher = true;
            },
        },
        setIndexingStats: () => undefined,
        buildCollectionLimitMessage: async () => "limit",
    } as never, async () => {
        throw new RootMutationCancelledError("op-reindex", "requested_by_manage_index");
    });

    await assert.rejects(
        operation.run({ codebasePath: "/repo", forceReindex: true }),
        RootMutationCancelledError,
    );

    assert.equal(restoredWatcher, true);
    assert.equal(phases.includes("failed"), false);
});

test("parent lifecycle accepts a bounded supervised candidate result", async () => {
    const phases: string[] = [];
    let current = publication("old", "collection-old", 4);
    let stats: { indexedFiles: number; totalChunks: number } | null = null;
    const next = publication("op-reindex", "collection-new", 8);
    const operation = new FullIndexOperation({
        context: {
            getCurrentPublication: () => current,
            resolveIndexPolicyForReindex: async () => policy,
            getEmbeddingEngine: () => ({
                getProvider: () => "fixture",
                getDimension: () => 3,
            }),
        },
        mutationRuntime: {
            assertCurrent: () => undefined,
            isCurrent: () => true,
            getCurrentOperation: () => ({ id: "op-reindex" }),
            updateCurrentOperation: (_root: string, phase: string) => {
                phases.push(phase);
                return { id: "op-reindex", phase };
            },
        },
        syncManager: {
            beginFullIndexSourceHandoff: () => undefined,
            touchWatchedCodebase: async () => undefined,
            captureWatcherBootstrap: () => undefined,
        },
        setIndexingStats: (value: { indexedFiles: number; totalChunks: number } | null) => {
            stats = value;
        },
        buildCollectionLimitMessage: async () => "limit",
    } as never, async (input) => {
        input.onProgress({
            phase: "writing",
            current: 50,
            total: 100,
            percentage: 50,
        });
        current = next;
        return {
            indexedFiles: 1,
            totalChunks: 8,
            status: "completed",
            collectionName: "collection-new",
            publication: { id: "op-reindex", status: "activated" },
        };
    });

    await operation.run({ codebasePath: "/repo", forceReindex: true });

    assert.deepEqual(stats, { indexedFiles: 1, totalChunks: 8 });
    assert.equal(phases.at(-1), "completed");
    assert.equal(phases.includes("failed"), false);
});
