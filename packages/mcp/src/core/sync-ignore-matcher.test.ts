import assert from "node:assert/strict";
import test from "node:test";

import { SyncManager } from "./sync.js";

function createManager(patterns: string[]): SyncManager {
    const context = { getActiveIgnorePatterns: () => patterns, listCurrentPublications: () => [] };
    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        updateCurrentOperation: () => {
            throw new Error("not used");
        },
    };
    return new SyncManager(context as never, {
        watchEnabled: false,
        mutationRuntime: mutationRuntime as never,
    });
}

test("watcher ignore matchers keep the built-in denylist authoritative over re-include rules", async () => {
    const patterns = ["!package-lock.json", "!vendor/x.min.js"];
    const internal = createManager(patterns) as unknown as {
        buildIgnoreMatcherForCodebase(root: string, patterns?: readonly string[]): Promise<{ ignores(p: string): boolean }>;
        getIgnoreMatcherForCodebase(root: string): { ignores(p: string): boolean };
    };
    const built = await internal.buildIgnoreMatcherForCodebase("/repo");
    assert.equal(built.ignores("package-lock.json"), true);
    assert.equal(built.ignores("vendor/x.min.js"), true);
    assert.equal(built.ignores("src/app.ts"), false);

    const cached = internal.getIgnoreMatcherForCodebase("/repo");
    assert.equal(cached.ignores("package-lock.json"), true);
    assert.equal(cached.ignores("vendor/x.min.js"), true);
});

test("nested .gitignore files are ignore rule control files", () => {
    const internal = createManager([]) as unknown as {
        isIgnoreRuleControlFile(relativePath: string): boolean;
    };
    assert.equal(internal.isIgnoreRuleControlFile(".gitignore"), true);
    assert.equal(internal.isIgnoreRuleControlFile("pkg/sub/.gitignore"), true);
    assert.equal(internal.isIgnoreRuleControlFile("pkg/.gitignore.bak"), false);
    assert.equal(internal.isIgnoreRuleControlFile("pkg/index.ts"), false);
});
