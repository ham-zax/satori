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

test("completion proof accepts the publication versions PublicationStore writes and reads", async () => {
    for (const version of [1, 2]) {
        const result = await validateCompletionProof({
            codebasePath: "/repo",
            getCurrentPublication: async () => ({ status: "valid", publication: publication(version), navigationStatus: "valid" }),
        });
        assert.equal(result.outcome, "valid", `version ${version}`);
    }
    const unknown = await validateCompletionProof({
        codebasePath: "/repo",
        getCurrentPublication: async () => ({ status: "valid", publication: publication(3), navigationStatus: "valid" }),
    });
    assert.deepEqual(unknown, { outcome: "stale_local", reason: "invalid_payload" });
});
