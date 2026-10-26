import test from "node:test";
import assert from "node:assert/strict";
import { listCodebasesTool } from "./list_codebases.js";
import type { ToolContext } from "./types.js";

function publicationRef(root: string) {
    const id = `pub-${root.replace(/\W/g, "")}`;
    return {
        id,
        publication: {
            id,
            version: 2,
            canonicalRoot: root,
            createdAt: "2026-10-27T00:00:00.000Z",
            status: "complete",
            policy: { policyHash: "p", controlSignature: "c" },
            format: { indexFormatVersion: "f", embeddingIdentity: "e", relationshipVersion: "r" },
            vector: { collectionName: `col-${id}`, indexedFiles: 1, totalChunks: 1 },
            navigation: null,
        },
    };
}

test("list_codebases stops taking roots after a quality read fails and settles in-flight reads", async () => {
    const roots = Array.from({ length: 12 }, (_, index) => `/repo/r${String(index).padStart(2, "0")}`);
    const refs = new Map(roots.map((root) => [root, publicationRef(root)]));
    const acquired: string[] = [];
    let active = 0;
    const ctx = {
        context: {
            listCurrentPublications: () => [...refs.values()],
            getCurrentPublicationForValidation: async (root: string) => ({
                status: "valid",
                publication: refs.get(root),
                navigationStatus: "valid",
            }),
            acquireCurrentPublicationRead: (root: string) => {
                if (root === roots[1]) {
                    throw new Error("lease acquisition failed");
                }
                acquired.push(root);
                active += 1;
                return {
                    id: refs.get(root)!.id,
                    release: () => { active -= 1; },
                };
            },
            getPublicationNavigationAddress: () => null,
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        workspacePolicy: { authorizeRoot: () => undefined },
    } as unknown as ToolContext;

    await assert.rejects(listCodebasesTool.execute({}, ctx), /lease acquisition failed/);
    assert.equal(active, 0, "every acquired lease is released before the request settles");
    // Without the stop flag the surviving workers drain all 11 other roots.
    assert.ok(acquired.length <= 4, `acquired ${acquired.length} roots after the failure`);
});
