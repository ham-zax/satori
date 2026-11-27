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

test("list_codebases releases the lease and stops taking roots when a request aborts", async () => {
    const roots = ["/repo/first", "/repo/second"];
    const refs = new Map(roots.map((root) => [root, publicationRef(root)]));
    const controller = new AbortController();
    const reason = new Error("request disconnected");
    const acquired: string[] = [];
    const released: string[] = [];
    let openedNavigation = false;
    const ctx = {
        requestSignal: controller.signal,
        context: {
            listCurrentPublications: () => [...refs.values()],
            getCurrentPublicationForValidation: async (root: string) => ({
                status: "valid", publication: refs.get(root), navigationStatus: "valid",
            }),
            acquireCurrentPublicationRead: (root: string) => {
                acquired.push(root);
                controller.abort(reason);
                return { id: refs.get(root)!.id, release: () => { released.push(root); } };
            },
            getPublicationNavigationAddress: () => { openedNavigation = true; return null; },
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        workspacePolicy: { authorizeRoot: () => undefined },
    } as unknown as ToolContext;

    await assert.rejects(listCodebasesTool.execute({}, ctx), (error) => error === reason);
    assert.deepEqual(acquired, [roots[0]]);
    assert.deepEqual(released, acquired);
    assert.equal(openedNavigation, false);
});

test("list_codebases aborts completion-proof probing without swallowing abort as probe_failed", async () => {
    const roots = Array.from({ length: 10 }, (_, index) => `/repo/p${String(index).padStart(2, "0")}`);
    const refs = new Map(roots.map((root) => [root, publicationRef(root)]));
    const controller = new AbortController();
    const probed: string[] = [];
    const ctx = {
        requestSignal: controller.signal,
        context: {
            listCurrentPublications: () => [...refs.values()],
            getCurrentPublicationForValidation: async (root: string) => {
                probed.push(root);
                if (probed.length === 1) {
                    controller.abort(new Error("list_aborted"));
                }
                return {
                    status: "valid",
                    publication: refs.get(root),
                    navigationStatus: "valid",
                };
            },
            acquireCurrentPublicationRead: () => {
                throw new Error("must not start quality reads after proof abort");
            },
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        workspacePolicy: { authorizeRoot: () => undefined },
    } as unknown as ToolContext;

    await assert.rejects(listCodebasesTool.execute({}, ctx), /list_aborted/);
    assert.ok(probed.length <= 4, `probed ${probed.length} roots after abort`);
});
