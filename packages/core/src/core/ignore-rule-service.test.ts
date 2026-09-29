import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_IGNORE_PATTERNS } from "../config/defaults.js";
import { IgnoreRuleService } from "./ignore-rule-service.js";

function createService(): IgnoreRuleService {
    return new IgnoreRuleService({
        basePatterns: ["node_modules/**", "dist/**"],
        canonicalizeCodebasePath: (codebasePath) => codebasePath,
        resolveCollectionName: (codebasePath) => codebasePath,
        ensureRuntimePolicyLoaded: () => {},
    });
}

test("getMatcher reuses the compiled matcher while patterns are unchanged", () => {
    const service = createService();
    const first = service.getMatcher("/repo");
    const second = service.getMatcher("/repo");
    assert.equal(second, first);
});

test("setFileBasedPatterns invalidates the compiled matcher", () => {
    const service = createService();
    const first = service.getMatcher("/repo");
    service.setFileBasedPatterns("/repo", ["generated/**"]);
    const second = service.getMatcher("/repo");
    assert.notEqual(second, first);
    assert.equal(second.ignores("generated/artifact.ts"), true);
    assert.equal(second.ignores("node_modules/pkg/index.ts"), true);
});

test("getMatcher keeps the built-in denylist authoritative over user re-includes", () => {
    const service = new IgnoreRuleService({
        basePatterns: DEFAULT_IGNORE_PATTERNS,
        canonicalizeCodebasePath: (codebasePath) => codebasePath,
        resolveCollectionName: (codebasePath) => codebasePath,
        ensureRuntimePolicyLoaded: () => {},
    });
    service.setFileBasedPatterns("/repo", ["!package-lock.json", "!vendor/x.min.js"]);
    const matcher = service.getMatcher("/repo");
    assert.equal(matcher.ignores("package-lock.json"), true);
    assert.equal(matcher.ignores("vendor/x.min.js"), true);
});

test("loadIgnorePatterns applies git files then .satoriignore, including nested .gitignore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-ignore-service-"));
    try {
        fs.mkdirSync(path.join(root, "pkg"));
        fs.writeFileSync(path.join(root, ".gitignore"), "*.gen.ts\n");
        fs.writeFileSync(path.join(root, ".satoriignore"), "!keep.gen.ts\n");
        fs.writeFileSync(path.join(root, "pkg/.gitignore"), "/local.ts\n");
        const service = new IgnoreRuleService({
            basePatterns: [],
            canonicalizeCodebasePath: (codebasePath) => codebasePath,
            resolveCollectionName: (codebasePath) => codebasePath,
            ensureRuntimePolicyLoaded: () => {},
        });
        await service.loadIgnorePatterns(root);
        assert.deepEqual(service.getActivePatterns(root), [
            "*.gen.ts",
            "pkg/local.ts",
            "!keep.gen.ts",
        ]);
        const matcher = service.getMatcher(root);
        assert.equal(matcher.ignores("a.gen.ts"), true);
        assert.equal(matcher.ignores("keep.gen.ts"), false);
        assert.equal(matcher.ignores("pkg/local.ts"), true);
        assert.equal(matcher.ignores("other/local.ts"), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
