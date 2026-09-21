import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
    findReferencesInputSchema,
    findReferencesTool,
} from "./find_references.js";
import type { ToolContext } from "./types.js";

test("find_references schema requires canonical symbol target and safe repo-relative scope", () => {
    assert.equal(findReferencesInputSchema.safeParse({
        path: path.resolve("/tmp/repo"),
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "src",
        includePaths: ["src/app"],
        excludePaths: ["src/generated"],
    }).success, true);

    assert.equal(findReferencesInputSchema.safeParse({
        path: path.resolve("/tmp/repo"),
        symbolRef: { file: "/etc/passwd", symbolId: "target" },
    }).success, false);

    assert.equal(findReferencesInputSchema.safeParse({
        path: path.resolve("/tmp/repo"),
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "../escape",
    }).success, false);
});

test("find_references dispatches through the authorized root without provider retrieval", async () => {
    const root = path.resolve("/tmp/repo");
    let dispatched: unknown;
    const ctx = {
        workspacePolicy: {
            authorizeRoot(requested: string) {
                assert.equal(requested, root);
                return { canonicalPath: root };
            },
        },
        toolHandlers: {
            async handleFindReferences(args: unknown) {
                dispatched = args;
                return {
                    content: [{ type: "text", text: JSON.stringify({ status: "ok", rankingIndependent: true }) }],
                };
            },
        },
    } as unknown as ToolContext;

    const response = await findReferencesTool.execute({
        path: root,
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "src",
        excludePaths: ["src/generated"],
        limit: 25,
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.deepEqual(dispatched, {
        path: root,
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "src",
        excludePaths: ["src/generated"],
        limit: 25,
    });
});
