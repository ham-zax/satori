import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    DEFAULT_AUTO_INDEX_MAX_FILES_FUSE,
    DEFAULT_CONNECTED_TOOL_DEMAND_MAX_BYTES,
    DEFAULT_OFFLINE_SESSION_OPEN_MAX_BYTES,
    DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES,
    evaluateAutoIndexPolicy,
    probeRepositoryScale,
    type RepositoryScaleProbe,
} from "./auto-index-policy.js";

function makeProbe(
    eligibleFiles: number,
    eligibleBytes: number,
    capped = false,
    status: RepositoryScaleProbe["status"] = capped ? "budget_exceeded" : "complete",
): RepositoryScaleProbe {
    return {
        rootPath: "/repo/test",
        isGitRepository: true,
        eligibleFiles,
        eligibleBytes,
        estimatedTokens: Math.ceil(eligibleBytes / 4),
        capped,
        status,
    };
}

test("evaluateAutoIndexPolicy gates by eligible bytes + 50k-file fuse so many tiny files (jevshelf-style) auto-index cleanly", () => {
    const manyTinyFilesProbe = makeProbe(2_500, Math.round(2_500 * 2.5 * 1024));
    const heavyFixturesProbe = makeProbe(400, 36 * 1024 * 1024);
    const massiveBytesProbe = makeProbe(12_000, DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES + 1024, true, "budget_exceeded");
    const inodeFuseProbe = makeProbe(DEFAULT_AUTO_INDEX_MAX_FILES_FUSE + 1, 10 * 1024 * 1024, true, "budget_exceeded");

    assert.equal(
        evaluateAutoIndexPolicy({
            rootPath: manyTinyFilesProbe.rootPath,
            executionProfile: "offline",
            autoIndexWorkspace: true,
            trigger: "session_open",
            scaleProbe: manyTinyFilesProbe,
        }).allow,
        true,
    );
    assert.equal(
        evaluateAutoIndexPolicy({
            rootPath: manyTinyFilesProbe.rootPath,
            executionProfile: "connected",
            autoIndexWorkspace: true,
            trigger: "session_open",
            scaleProbe: manyTinyFilesProbe,
        }).allow,
        false,
        "Connected/paid APIs never auto-index on idle session open",
    );
    assert.equal(
        evaluateAutoIndexPolicy({
            rootPath: manyTinyFilesProbe.rootPath,
            executionProfile: "connected",
            autoIndexWorkspace: true,
            trigger: "tool_demand",
            scaleProbe: manyTinyFilesProbe,
        }).allow,
        true,
        "Small-byte repo (~6.25 MB <= 8 MB) auto-indexes seamlessly on first Voyage tool call",
    );

    const heavyOpen = evaluateAutoIndexPolicy({
        rootPath: heavyFixturesProbe.rootPath,
        executionProfile: "offline",
        autoIndexWorkspace: true,
        trigger: "session_open",
        scaleProbe: heavyFixturesProbe,
    });
    assert.equal(heavyOpen.allow, false);
    if (!heavyOpen.allow) assert.equal(heavyOpen.reason, "deferred_until_tool_use");

    assert.equal(
        evaluateAutoIndexPolicy({
            rootPath: heavyFixturesProbe.rootPath,
            executionProfile: "offline",
            autoIndexWorkspace: true,
            trigger: "tool_demand",
            scaleProbe: heavyFixturesProbe,
        }).allow,
        true,
    );

    const heavyConnected = evaluateAutoIndexPolicy({
        rootPath: heavyFixturesProbe.rootPath,
        executionProfile: "connected",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
        scaleProbe: heavyFixturesProbe,
    });
    assert.equal(heavyConnected.allow, false);
    if (!heavyConnected.allow) {
        assert.equal(heavyConnected.reason, "paid_runtime_budget_exceeded");
        assert.ok(heavyConnected.byteLimit === DEFAULT_CONNECTED_TOOL_DEMAND_MAX_BYTES);
    }

    const massiveDecision = evaluateAutoIndexPolicy({
        rootPath: massiveBytesProbe.rootPath,
        executionProfile: "offline",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
        scaleProbe: massiveBytesProbe,
    });
    assert.equal(massiveDecision.allow, false);
    if (!massiveDecision.allow) assert.equal(massiveDecision.reason, "repository_too_large");

    const fuseDecision = evaluateAutoIndexPolicy({
        rootPath: inodeFuseProbe.rootPath,
        executionProfile: "offline",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
        scaleProbe: inodeFuseProbe,
    });
    assert.equal(fuseDecision.allow, false);
    if (!fuseDecision.allow) assert.equal(fuseDecision.reason, "repository_too_large");
    assert.ok(DEFAULT_OFFLINE_SESSION_OPEN_MAX_BYTES < DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES);
});

test("probeRepositoryScale measures untracked and modified working-tree files and honors .gitignore, .satoriignore, and satori.toml", (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-scale-probe-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".satoriignore"), "evals\n");
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n".repeat(200));
    fs.writeFileSync(path.join(dir, "logo.png"), Buffer.alloc(4096));
    fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
    fs.writeFileSync(path.join(dir, "evals", "huge.json"), "{}".repeat(5000));
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", ".gitignore"), "ignored.ts\n");
    fs.writeFileSync(path.join(dir, "nested", "ignored.ts"), "x".repeat(5000));
    execFileSync("git", ["add", "a.ts", ".satoriignore"], { cwd: dir });

    const initial = probeRepositoryScale(dir);
    assert.equal(initial.status, "complete");
    assert.equal(initial.capped, false);
    assert.equal(initial.isGitRepository, true);
    assert.equal(initial.eligibleFiles, 1); // a.ts only (.satoriignore is not a supported source/config extension)
    assert.equal(initial.eligibleBytes, Buffer.byteLength("export const a = 1;\n"));

    // Add 10 untracked 1 MiB .ts files -> connected 8 MiB budget must immediately reject without git add.
    const oneMiBChunk = "export const payload = '" + "a".repeat(1024 * 1024 - 32) + "';\n";
    for (let i = 0; i < 10; i += 1) {
        fs.writeFileSync(path.join(dir, `untracked-${i}.ts`), oneMiBChunk);
    }
    const withUntracked = evaluateAutoIndexPolicy({
        rootPath: dir,
        executionProfile: "connected",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
    });
    assert.equal(withUntracked.allow, false);
    if (!withUntracked.allow) {
        assert.equal(withUntracked.reason, "paid_runtime_budget_exceeded");
        assert.equal(withUntracked.scale.status, "budget_exceeded");
        assert.ok(withUntracked.scale.eligibleBytes > DEFAULT_CONNECTED_TOOL_DEMAND_MAX_BYTES);
    }

    // Remove untracked files, then expand the already-tracked file in place to > 8 MiB.
    for (let i = 0; i < 10; i += 1) {
        fs.rmSync(path.join(dir, `untracked-${i}.ts`));
    }
    // Wait: a single >8 MiB file hits MAX_INDEXED_SOURCE_FILE_BYTES (8 MiB), so use 2 tracked/modified files of ~4.5 MiB each.
    const fourPointFiveMiB = "export const big = '" + "b".repeat(Math.floor(4.5 * 1024 * 1024)) + "';\n";
    fs.writeFileSync(path.join(dir, "a.ts"), fourPointFiveMiB);
    fs.writeFileSync(path.join(dir, "b.py"), "# " + "c".repeat(Math.floor(4.5 * 1024 * 1024)) + "\n");
    const withExpandedTracked = evaluateAutoIndexPolicy({
        rootPath: dir,
        executionProfile: "connected",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
    });
    assert.equal(withExpandedTracked.allow, false);
    if (!withExpandedTracked.allow) {
        assert.equal(withExpandedTracked.reason, "paid_runtime_budget_exceeded");
    }

    // satori.toml minimal profile excludes .json while keeping .ts/.py/.toml.
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(dir, "b.py"), "x = 1\n");
    fs.writeFileSync(path.join(dir, "data.json"), "{\"k\":1}\n");
    fs.writeFileSync(path.join(dir, "satori.toml"), "[index]\nprofile = \"default\"\n");
    const defaultProfileProbe = probeRepositoryScale(dir);
    assert.equal(defaultProfileProbe.eligibleFiles, 4);
    fs.writeFileSync(path.join(dir, "satori.toml"), "[index]\nprofile = \"minimal\"\n");
    const minimalProfileProbe = probeRepositoryScale(dir);
    assert.equal(minimalProfileProbe.eligibleFiles, 3);
});

test("evaluateAutoIndexPolicy never fails open when measurement is incomplete or deadline expires", (t) => {
    const simulatedIncomplete = {
        rootPath: "/repo/test",
        isGitRepository: true,
        eligibleFiles: 1,
        eligibleBytes: 10,
        estimatedTokens: 3,
        capped: true,
        status: "incomplete" as const,
    };
    const simulatedDecision = evaluateAutoIndexPolicy({
        rootPath: "/repo/test",
        executionProfile: "connected",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
        scaleProbe: simulatedIncomplete,
    });
    assert.equal(simulatedDecision.allow, false);
    if (!simulatedDecision.allow) assert.equal(simulatedDecision.reason, "probe_incomplete");

    // Even a mocked legacy capped probe without an explicit status field must fail closed.
    const legacyCappedProbe: RepositoryScaleProbe = {
        rootPath: "/repo/test",
        isGitRepository: true,
        eligibleFiles: 1,
        eligibleBytes: 10,
        estimatedTokens: 3,
        capped: true,
    };
    const legacyDecision = evaluateAutoIndexPolicy({
        rootPath: "/repo/test",
        executionProfile: "offline",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
        scaleProbe: legacyCappedProbe,
    });
    assert.equal(legacyDecision.allow, false);
    if (!legacyDecision.allow) assert.equal(legacyDecision.reason, "probe_incomplete");

    // Real deadline expiry on probeRepositoryScale returns status: "incomplete".
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-scale-deadline-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");

    let ticks = 0;
    const timedOut = probeRepositoryScale(dir, DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES, DEFAULT_AUTO_INDEX_MAX_FILES_FUSE, {
        deadlineMs: 10,
        nowMs: () => {
            ticks += 1;
            return ticks === 1 ? 100 : 200;
        },
    });
    assert.equal(timedOut.status, "incomplete");
    assert.equal(timedOut.capped, true);

    const timedOutDecision = evaluateAutoIndexPolicy({
        rootPath: dir,
        executionProfile: "offline",
        autoIndexWorkspace: true,
        trigger: "tool_demand",
        scaleProbe: timedOut,
    });
    assert.equal(timedOutDecision.allow, false);
    if (!timedOutDecision.allow) assert.equal(timedOutDecision.reason, "probe_incomplete");

    // Corrupt satori.toml or symlinked .gitignore cannot fail open as empty/complete.
    fs.writeFileSync(path.join(dir, "satori.toml"), "[index]\nprofile = \"invalid-profile\"\n");
    const brokenPolicyProbe = probeRepositoryScale(dir);
    assert.equal(brokenPolicyProbe.status, "incomplete");
    assert.equal(brokenPolicyProbe.capped, true);
});
