import test from "node:test";
import assert from "node:assert/strict";
import { TrackedRootReadiness, type TrackedRootReadinessHost } from "./tracked-root-readiness.js";

function createHost(options: { fingerprintMismatch?: boolean } = {}): TrackedRootReadinessHost {
    const root = "/repo";
    const info = { status: "indexed" as const };
    return {
        refreshSnapshotStateFromDisk: () => undefined,
        isPathWithinCodebase: (targetPath, rootPath) => targetPath === rootPath || targetPath.startsWith(`${rootPath}/`),
        getTrackedRootEntryForPath: () => ({ path: root, info }),
        getMatchingBlockedRoot: () => null,
        getSnapshotAllCodebases: () => [{ path: root, info }],
        getSnapshotIndexedCodebases: () => [root],
        getSnapshotIndexingCodebases: () => [],
        getSnapshotCodebaseInfo: () => info,
        getSnapshotCodebaseStatus: () => "indexed",
        enforceFingerprintGate: () => options.fingerprintMismatch
            ? { blockedResponse: {}, message: "fingerprint mismatch", reason: "fingerprint_mismatch" }
            : {},
        validateCompletionProof: async () => ({
            outcome: "policy_incompatible",
            reason: "runtime_policy_incompatible",
        }),
        probeLocalSearchCollectionState: async () => ({ state: "ready", collectionName: "collection" }),
        buildCreateHint: (codebasePath) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
        buildStatusHint: (codebasePath) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
        buildManageIndexRecommendedAction: (action, codebasePath, rationale) => ({
            tool: "manage_index",
            args: { action, path: codebasePath },
            rationale,
        }),
        buildStaleLocalMessage: () => "stale",
    };
}

test("tracked root readiness fails closed on runtime policy incompatibility for semantic reads", async () => {
    const readiness = new TrackedRootReadiness(createHost());

    const result = await readiness.prepareTrackedRootForRead("/repo/src/index.ts", "semantic");

    assert.equal(result.state, "requires_reindex");
    assert.equal(result.state === "requires_reindex" ? result.codebasePath : undefined, "/repo");
    assert.match(result.state === "requires_reindex" ? result.message ?? "" : "", /runtime policy inputs/i);
});

test("runtime policy incompatibility blocks navigation despite its fingerprint mismatch exception", async () => {
    const readiness = new TrackedRootReadiness(createHost({ fingerprintMismatch: true }));

    const result = await readiness.prepareTrackedRootForRead("/repo/src/index.ts", "navigation");

    assert.equal(result.state, "requires_reindex");
    assert.match(result.state === "requires_reindex" ? result.message ?? "" : "", /runtime policy inputs/i);
});
