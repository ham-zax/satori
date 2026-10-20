import assert from "node:assert/strict";
import test from "node:test";
import { RootMutationCancelledError } from "@satori-code/core/integration";
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
    const writingProgress: number[] = [];
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
            updateCurrentOperation: (_root: string, phase: string, update: { progress?: number }) => {
                phases.push(phase);
                if (phase === 'writing' && update.progress !== undefined) writingProgress.push(update.progress);
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
        for (const percentage of [90, 94, 98]) {
            input.onProgress({
                phase: "Resolving Python calls...",
                current: percentage,
                total: 100,
                percentage,
            });
        }
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
    assert.deepEqual(writingProgress, [90, 94, 98]);
    assert.equal(phases.at(-1), "completed");
    assert.equal(phases.includes("failed"), false);
});

function watcherOrderFixture(events: string[], current: () => unknown) {
    return {
        context: {
            getCurrentPublication: current,
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
            updateCurrentOperation: (_root: string, phase: string) => ({ id: "op-reindex", phase }),
        },
        syncManager: {
            beginFullIndexSourceHandoff: () => undefined,
            touchWatchedCodebase: async (_root: string, options: { policyHash: string }) => {
                events.push(`touch:${options.policyHash}`);
            },
            captureWatcherBootstrap: () => {
                events.push("capture");
                return undefined;
            },
            rejectFullIndexSourceHandoff: () => true,
            restoreActiveWatcherPolicy: async () => {
                events.push("restore");
            },
        },
        setIndexingStats: () => undefined,
        buildCollectionLimitMessage: async () => "limit",
    };
}

const activatedCandidate = {
    indexedFiles: 1,
    totalChunks: 8,
    status: "completed" as const,
    collectionName: "collection-new",
    publication: { id: "op-reindex", status: "activated" as const },
};

test("candidate watcher starts when the source scan completes", async () => {
    const events: string[] = [];
    let current = publication("old", "collection-old", 4);
    const operation = new FullIndexOperation(watcherOrderFixture(events, () => current) as never, async (input) => {
        events.push("scan");
        input.onSourceScanCompleted();
        events.push("write");
        input.onSourceScanCompleted();
        current = publication("op-reindex", "collection-new", 8);
        return activatedCandidate;
    });

    await operation.run({ codebasePath: "/repo", forceReindex: true });

    assert.deepEqual(events.slice(0, 4), ["scan", "touch:policy", "write", "capture"]);
});

test("candidate watcher starts before the capture when the runner never reports its scan", async () => {
    const events: string[] = [];
    let current = publication("old", "collection-old", 4);
    const operation = new FullIndexOperation(watcherOrderFixture(events, () => current) as never, async () => {
        events.push("run");
        current = publication("op-reindex", "collection-new", 8);
        return activatedCandidate;
    });

    await operation.run({ codebasePath: "/repo", forceReindex: true });

    assert.deepEqual(events.slice(0, 3), ["run", "touch:policy", "capture"]);
});

test("candidate failure restores the watcher only after the in-flight registration settles", async () => {
    const events: string[] = [];
    let releaseTouch!: () => void;
    const host = watcherOrderFixture(events, () => publication("old", "collection-old", 4));
    host.syncManager.touchWatchedCodebase = async (_root, options) => {
        events.push(`touch:${options.policyHash}`);
        await new Promise<void>((resolve) => {
            releaseTouch = resolve;
        });
        events.push("touch-settled");
    };
    const operation = new FullIndexOperation(host as never, async (input) => {
        input.onSourceScanCompleted();
        setImmediate(() => releaseTouch());
        throw new Error("candidate failed");
    });

    await operation.run({ codebasePath: "/repo", forceReindex: true });

    assert.deepEqual(events, ["touch:policy", "touch-settled", "restore"]);
});
