import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
    evaluateReindexPreflight,
    getChangedFilesForCodebase,
    parseGitStatusChangedPathsZ,
    type ChangedFilesCacheEntry,
} from "./working-tree-state.js";

test("reindex preflight explains uncertainty without changing its admission outcomes", () => {
    const cases = [
        { files: [], available: true, probeFailed: false, hasCurrentPublication: true,
            outcome: "unknown", explanation: /no working-tree changes/, warning: "REINDEX_PREFLIGHT_UNKNOWN" },
        { files: ["src/main.ts"], available: true, probeFailed: false, hasCurrentPublication: true,
            outcome: "unknown", explanation: /beyond ignore-policy files/, warning: "REINDEX_PREFLIGHT_UNKNOWN" },
        { files: [".satoriignore"], available: true, probeFailed: false, hasCurrentPublication: false,
            outcome: "unknown", explanation: /no current index/, warning: "REINDEX_PREFLIGHT_UNKNOWN" },
        { files: [], available: false, probeFailed: true, hasCurrentPublication: true,
            outcome: "probe_failed", explanation: /probe failed/, warning: "IGNORE_POLICY_PROBE_FAILED" },
    ];
    for (const { files, available, probeFailed, hasCurrentPublication, outcome, explanation, warning } of cases) {
        const result = evaluateReindexPreflight({
            codebasePath: "/repo", hasCurrentPublication,
            getWorkingTreeChangedPathsForPreflight: () => ({ files: new Set(files), available, probeFailed }),
        });
        assert.equal(result.outcome, outcome);
        assert.equal(result.confidence, "low");
        assert.deepEqual(result.warnings, [warning]);
        assert.match(result.explanation ?? "", explanation);
        assert.equal(result.probeFailed === true, probeFailed);
    }
    const ignoreOnly = evaluateReindexPreflight({
        codebasePath: "/repo", hasCurrentPublication: true,
        getWorkingTreeChangedPathsForPreflight: () => ({
            files: new Set([".gitignore", ".satoriignore", "satori.toml"]), available: true, probeFailed: false,
        }),
    });
    assert.equal(ignoreOnly.outcome, "reindex_unnecessary_ignore_only");
    assert.equal(ignoreOnly.confidence, "high");
    assert.deepEqual(ignoreOnly.warnings, ["REINDEX_UNNECESSARY_IGNORE_ONLY"]);
});

function runGit(repoPath: string, args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

function initRepo(repoPath: string): void {
    fs.mkdirSync(repoPath, { recursive: true });
    runGit(repoPath, ["init", "-q"]);
    runGit(repoPath, ["config", "user.email", "satori@example.invalid"]);
    runGit(repoPath, ["config", "user.name", "Satori Test"]);
}

function commitFile(repoPath: string, relativePath: string, content: string): void {
    const absolutePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
    runGit(repoPath, ["add", relativePath]);
    runGit(repoPath, ["commit", "-m", `fixture ${relativePath}`]);
}

function changedFiles(repoPath: string, forceRefresh = false): Set<string> {
    const state = getChangedFilesForCodebase({
        codebasePath: repoPath,
        nowMs: Date.now(),
        changedFilesCache: new Map(),
        ttlMs: 60_000,
        forceRefresh,
    });
    return state.files;
}

for (const access of ["fresh hit", "Git probe"] as const) {
    test(`changed-files retention prunes expired abandoned roots on ${access}`, (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-retention-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        initRepo(root);
        const abandoned = path.join(root, "abandoned");
        const cache = new Map<string, ChangedFilesCacheEntry>([
            [abandoned, { available: true, files: new Set(["old.ts"]), expiresAtMs: 100 }],
        ]);
        if (access === "fresh hit") cache.set(root, { available: true, files: new Set(), expiresAtMs: 200 });

        const result = getChangedFilesForCodebase({ codebasePath: root, nowMs: 100, ttlMs: 100, changedFilesCache: cache });
        assert.equal(result.available, true);
        assert.deepEqual([...cache.keys()], [root]);
        assert.equal(cache.get(root)?.expiresAtMs, 200);
    });
}

test("changed-files retention caps fresh roots at 32 with identical timestamps", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-cap-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initRepo(root);
    const keys = Array.from({ length: 32 }, (_, i) => path.join(root, `cached-${i}`));
    const cache = new Map<string, ChangedFilesCacheEntry>(keys.map(key => [key, {
        available: true, files: new Set(), expiresAtMs: 200,
    }]));

    getChangedFilesForCodebase({ codebasePath: root, nowMs: 100, ttlMs: 100, changedFilesCache: cache });
    assert.equal(cache.size, 32);
    assert.deepEqual([...cache.keys()], [...keys.slice(1), root]);
});

test("changed-files retention promotes a fresh hit without extending its TTL", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-lru-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initRepo(root);
    const keys = Array.from({ length: 32 }, (_, i) => path.join(root, `cached-${i}`));
    const cache = new Map<string, ChangedFilesCacheEntry>(keys.map(key => [key, {
        available: true, files: new Set(["cached.ts"]), expiresAtMs: 200,
    }]));

    const hit = getChangedFilesForCodebase({
        codebasePath: path.join(keys[0], "."), nowMs: 100, ttlMs: 1000, changedFilesCache: cache,
    });
    assert.deepEqual([...hit.files], ["cached.ts"]);
    assert.equal(cache.get(keys[0])?.expiresAtMs, 200);
    assert.deepEqual([...cache.keys()], [...keys.slice(1), keys[0]]);
    getChangedFilesForCodebase({ codebasePath: root, nowMs: 100, ttlMs: 100, changedFilesCache: cache });
    assert.deepEqual([...cache.keys()], [...keys.slice(2), keys[0], root]);
});

test("changed-files retention preserves the requested expired root on Git failure", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-stale-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const missing = path.join(root, "missing");
    const other = path.join(root, "other");
    const cache = new Map<string, ChangedFilesCacheEntry>([
        [missing, { available: true, files: new Set(["stale.ts"]), expiresAtMs: 99 }],
        [other, { available: true, files: new Set(["abandoned.ts"]), expiresAtMs: 99 }],
    ]);
    const result = getChangedFilesForCodebase({
        codebasePath: missing, nowMs: 100, ttlMs: 50, changedFilesCache: cache,
    });
    assert.equal(result.available, true);
    assert.deepEqual([...result.files], ["stale.ts"]);
    assert.deepEqual([...cache.keys()], [missing]);
    assert.equal(cache.get(missing)?.expiresAtMs, 150);
    result.files.clear();
    assert.deepEqual([...cache.get(missing)!.files], ["stale.ts"]);
});

test("changed-files retention bounds unavailable Git probe entries", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-unavailable-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cache = new Map<string, ChangedFilesCacheEntry>();
    const keys = Array.from({ length: 35 }, (_, i) => path.join(root, `missing-${i}`));
    for (const key of keys) {
        const result = getChangedFilesForCodebase({ codebasePath: key, nowMs: 100, ttlMs: 100, changedFilesCache: cache });
        assert.equal(result.available, false);
        assert.deepEqual([...result.files], []);
        assert.ok(cache.size <= 32);
    }
    assert.deepEqual([...cache.keys()], keys.slice(-32));
});

test("changed-files retention isolates returned sets on probe, hit and forced refresh", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-isolation-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initRepo(root);
    fs.writeFileSync(path.join(root, "new.ts"), "export const fresh = true;\n");
    const cache = new Map<string, ChangedFilesCacheEntry>();
    const input = { codebasePath: root, nowMs: 100, ttlMs: 100, changedFilesCache: cache };
    for (const forceRefresh of [false, false, true]) {
        const result = getChangedFilesForCodebase({ ...input, forceRefresh });
        assert.deepEqual([...result.files], ["new.ts"]);
        result.files.clear();
        result.files.add("injected.ts");
        assert.deepEqual([...cache.get(root)!.files], ["new.ts"]);
    }
    fs.writeFileSync(path.join(root, "other.ts"), "export const other = true;\n");
    assert.deepEqual([...getChangedFilesForCodebase(input).files], ["new.ts"]);
    assert.deepEqual([...getChangedFilesForCodebase({ ...input, forceRefresh: true }).files].sort(), ["new.ts", "other.ts"]);
});

test("parseGitStatusChangedPathsZ parses tracked modifications, additions and deletions", () => {
    const parsed = parseGitStatusChangedPathsZ(
        " M src/changed.ts\0A  src/added.ts\0D  src/removed.ts\0",
    );
    assert.deepEqual([...parsed].sort(), [
        "src/added.ts",
        "src/changed.ts",
        "src/removed.ts",
    ]);
});

test("parseGitStatusChangedPathsZ keeps untracked paths when includeUntracked is set", () => {
    const parsed = parseGitStatusChangedPathsZ(
        "?? src/new.ts\0?? src/other.py\0",
        { includeUntracked: true },
    );
    assert.deepEqual([...parsed].sort(), ["src/new.ts", "src/other.py"]);
});

test("parseGitStatusChangedPathsZ excludes untracked paths by default", () => {
    const parsed = parseGitStatusChangedPathsZ(" M src/changed.ts\0?? src/new.ts\0");
    assert.deepEqual([...parsed], ["src/changed.ts"]);
});

test("parseGitStatusChangedPathsZ preserves untracked paths containing spaces", () => {
    const parsed = parseGitStatusChangedPathsZ(
        "?? untracked with spaces.ts\0?? plain.ts\0",
        { includeUntracked: true },
    );
    assert.deepEqual([...parsed].sort(), ["plain.ts", "untracked with spaces.ts"]);
});

test("parseGitStatusChangedPathsZ retains legitimate dot-dot-prefixed filenames and rejects escapes", () => {
    const parsed = parseGitStatusChangedPathsZ(
        "?? ..config.ts\0?? nested/..config.ts\0?? ../outside.ts\0?? ..\0",
        { includeUntracked: true },
    );
    assert.deepEqual(
        [...parsed].sort(),
        ["..config.ts", "nested/..config.ts"],
    );
});

test("parseGitStatusChangedPathsZ keeps the destination of rename entries and skips the origin record", () => {
    const parsed = parseGitStatusChangedPathsZ(
        "RM renamed.txt\0orig.txt\0?? new.ts\0",
        { includeUntracked: true },
    );
    assert.deepEqual([...parsed].sort(), ["new.ts", "renamed.txt"]);
});

test("parseGitStatusChangedPathsZ ignores ignored entries and empty input", () => {
    assert.deepEqual([...parseGitStatusChangedPathsZ("!! .satori/ignored.json\0")], []);
    assert.deepEqual([...parseGitStatusChangedPathsZ("")], []);
});

test("getChangedFilesForCodebase includes a brand-new untracked source file", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-untracked-"));
    try {
        initRepo(repoPath);
        commitFile(repoPath, "src/tracked.ts", "export const tracked = 1;\n");
        fs.writeFileSync(
            path.join(repoPath, "src", "brand-new.ts"),
            "export const fresh = true;\n",
            "utf8",
        );
        assert.deepEqual([...changedFiles(repoPath, true)].sort(), ["src/brand-new.ts"]);
    } finally {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("getChangedFilesForCodebase lists untracked files alongside tracked modifications", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-mixed-"));
    try {
        initRepo(repoPath);
        commitFile(repoPath, "src/tracked.ts", "export const tracked = 1;\n");
        fs.writeFileSync(
            path.join(repoPath, "src", "tracked.ts"),
            "export const tracked = 2;\n",
            "utf8",
        );
        fs.writeFileSync(path.join(repoPath, "src", "new.ts"), "export const n = 1;\n", "utf8");
        assert.deepEqual([...changedFiles(repoPath, true)].sort(), [
            "src/new.ts",
            "src/tracked.ts",
        ]);
    } finally {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("getChangedFilesForCodebase excludes untracked files ignored by git", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-gitignored-"));
    try {
        initRepo(repoPath);
        commitFile(repoPath, ".gitignore", "ignored.ts\n");
        commitFile(repoPath, "src/tracked.ts", "export const tracked = 1;\n");
        fs.writeFileSync(path.join(repoPath, "ignored.ts"), "export const hidden = 1;\n", "utf8");
        fs.writeFileSync(path.join(repoPath, "visible.ts"), "export const shown = 1;\n", "utf8");
        assert.deepEqual([...changedFiles(repoPath, true)].sort(), ["visible.ts"]);
    } finally {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("getChangedFilesForCodebase parses untracked paths containing spaces", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-spaces-"));
    try {
        initRepo(repoPath);
        commitFile(repoPath, "src/tracked.ts", "export const tracked = 1;\n");
        fs.writeFileSync(
            path.join(repoPath, "new file with spaces.ts"),
            "export const spaced = 1;\n",
            "utf8",
        );
        assert.deepEqual([...changedFiles(repoPath, true)], ["new file with spaces.ts"]);
    } finally {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("getChangedFilesForCodebase keeps a clean repository on the same path as before", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-clean-"));
    try {
        initRepo(repoPath);
        commitFile(repoPath, "src/tracked.ts", "export const tracked = 1;\n");
        assert.deepEqual([...changedFiles(repoPath, true)], []);
    } finally {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("getChangedFilesForCodebase returns no changes after the untracked file is committed", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-wts-commit-"));
    try {
        initRepo(repoPath);
        commitFile(repoPath, "src/tracked.ts", "export const tracked = 1;\n");
        const untrackedPath = path.join(repoPath, "src", "later.ts");
        fs.writeFileSync(untrackedPath, "export const later = 1;\n", "utf8");
        assert.deepEqual([...changedFiles(repoPath, true)].sort(), ["src/later.ts"]);
        runGit(repoPath, ["add", "src/later.ts"]);
        runGit(repoPath, ["commit", "-m", "fixture later"]);
        assert.deepEqual([...changedFiles(repoPath, true)], []);
    } finally {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});
