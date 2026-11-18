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

function makeProbe(eligibleFiles: number, eligibleBytes: number, capped = false): RepositoryScaleProbe {
    return {
        rootPath: "/repo/test",
        isGitRepository: true,
        eligibleFiles,
        eligibleBytes,
        estimatedTokens: Math.ceil(eligibleBytes / 4),
        capped,
    };
}

test("evaluateAutoIndexPolicy gates by eligible bytes + 50k-file fuse so many tiny files (jevshelf-style) auto-index cleanly", () => {
    // 2,500 tiny 2.5 KB skill files = ~6.25 MB (< 8 MB Voyage budget and < 20 MB offline session-open budget!)
    const manyTinyFilesProbe = makeProbe(2_500, Math.round(2_500 * 2.5 * 1024));
    // 400 heavy 90 KB files = ~36 MB (> 20 MB session-open and > 8 MB Voyage, but <= 150 MB offline tool-demand)
    const heavyFixturesProbe = makeProbe(400, 36 * 1024 * 1024);
    // Massive monorepo > 150 MB
    const massiveBytesProbe = makeProbe(12_000, DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES + 1024, true);
    // 50,001 tiny files -> hits CBM-style 50k OOM file fuse
    const inodeFuseProbe = makeProbe(DEFAULT_AUTO_INDEX_MAX_FILES_FUSE + 1, 10 * 1024 * 1024, true);

    // 1. 2,500 tiny 2.5 KB files: allowed on offline session_open AND on connected (Voyage) tool_demand!
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

    // 2. 36 MB repo (only 400 files!): deferred on offline idle open, auto-indexed on offline tool_demand, asks first on paid API!
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

    // 3. > 150 MB or > 50k files: skips silent auto-indexing even on offline tool_demand.
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

test("probeRepositoryScale sums eligible source bytes, skips binaries/lockfiles/.satoriignore, and invalidates witness on git index change", (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-scale-probe-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".satoriignore"), "evals\n");
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 12345;\n"); // 24 bytes
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n".repeat(200)); // lockfile ignored
    fs.writeFileSync(path.join(dir, "logo.png"), Buffer.alloc(4096)); // binary ignored
    fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
    fs.writeFileSync(path.join(dir, "evals", "huge.json"), "{}".repeat(5000)); // .satoriignore ignored
    execFileSync("git", ["add", "."], { cwd: dir });

    const first = probeRepositoryScale(dir);
    assert.equal(first.isGitRepository, true);
    assert.equal(first.eligibleFiles, 2); // .satoriignore + a.ts
    assert.ok(first.eligibleBytes < 100, `Expected only small source bytes, got ${first.eligibleBytes}`);

    // Add another source file -> git index witness must invalidate cache
    fs.writeFileSync(path.join(dir, "b.py"), "def greet():\n    return 'hi'\n");
    execFileSync("git", ["add", "b.py"], { cwd: dir });
    const second = probeRepositoryScale(dir);
    assert.equal(second.eligibleFiles, 3);
    assert.ok(second.eligibleBytes > first.eligibleBytes);
});
