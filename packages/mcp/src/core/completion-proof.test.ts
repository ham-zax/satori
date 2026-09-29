import test from "node:test";
import assert from "node:assert/strict";
import { validateCompletionProof } from "./completion-proof.js";

function publication(version: number) {
    return {
        id: "gen-1",
        publication: {
            id: "gen-1",
            version,
            canonicalRoot: "/repo",
            createdAt: "2026-09-28T00:00:00.000Z",
            status: "complete",
            policy: { policyHash: "policy", controlSignature: "control" },
            format: { indexFormatVersion: "format", embeddingIdentity: "embedding", relationshipVersion: "relationships" },
            vector: { collectionName: "collection", indexedFiles: 1, totalChunks: 1 },
            navigation: { relativeRoot: "navigation" },
        },
    };
}

test("completion proof accepts only the current publication version", async () => {
    const current = await validateCompletionProof({
        codebasePath: "/repo",
        getCurrentPublication: async () => ({ status: "valid", publication: publication(2), navigationStatus: "valid" }),
    });
    assert.equal(current.outcome, "valid");
    for (const version of [1, 3]) {
        const rejected = await validateCompletionProof({
            codebasePath: "/repo",
            getCurrentPublication: async () => ({ status: "valid", publication: publication(version), navigationStatus: "valid" }),
        });
        assert.deepEqual(rejected, { outcome: "stale_local", reason: "invalid_payload" }, `version ${version}`);
    }
});

test("completion proof maps a core requires_reindex status to stale_local", async () => {
    const result = await validateCompletionProof({
        codebasePath: "/repo",
        getCurrentPublication: async () => ({ status: "requires_reindex" }),
    });
    assert.deepEqual(result, { outcome: "stale_local", reason: "requires_reindex" });
});
