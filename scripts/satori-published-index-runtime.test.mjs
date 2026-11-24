import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WRAPPER_PATH = fileURLToPath(new URL("./satori-published-index-runtime.mjs", import.meta.url));

test("published-index runtime replaces freshness work with a no-sync decision", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-published-index-runtime-"));
    try {
        const distDir = path.join(tempDir, "packages", "mcp", "dist");
        fs.mkdirSync(path.join(distDir, "core"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
        fs.writeFileSync(path.join(distDir, "core", "sync.js"), `
export class SyncManager {
  async ensureFreshness() { throw new Error("original freshness must not run"); }
  getWatcherObservation() { throw new Error("original watcher observation must not run"); }
  getPreparedReadObservation() { throw new Error("original prepared observation must not run"); }
  getPreparedReadDiagnostics() { throw new Error("original diagnostics must not run"); }
}
`);
        const entryPath = path.join(distDir, "index.js");
        fs.writeFileSync(entryPath, `
import { SyncManager } from "./core/sync.js";
const manager = new SyncManager();
process.stdout.write(JSON.stringify({
  freshness: await manager.ensureFreshness("/repo", 123),
  watcher: manager.getWatcherObservation("/repo"),
  prepared: manager.getPreparedReadObservation("/repo"),
  diagnostics: manager.getPreparedReadDiagnostics("/repo")
}));
`);

        const run = spawnSync(process.execPath, [WRAPPER_PATH, entryPath], {
            encoding: "utf8",
            env: {
                ...process.env,
                SATORI_EVAL_PUBLISHED_INDEX: "1",
                SATORI_EVAL_SOURCE_REVISION: "1".repeat(40),
            },
        });
        assert.equal(run.status, 0, run.stderr);
        const result = JSON.parse(run.stdout);
        assert.equal(result.freshness.mode, "skipped_recent");
        assert.equal(result.freshness.thresholdMs, 123);
        assert.match(result.freshness.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(result.watcher, {
            observedEventEpoch: 0,
            comparedThroughEventEpoch: 0,
            latestEpochByReason: {
                source_changed: 0,
                ignore_rules_changed: 0,
                directory_changed: 0,
            },
            coverage: "ready",
            pending: false,
        });
        assert.deepEqual(result.prepared, {
            available: true,
            observation: {
                freshnessEpoch: 0,
                watcherState: "ready",
                checkpointObservation: `published-index:${"1".repeat(40)}`,
            },
        });
        assert.equal(result.diagnostics.checkpointStatus, "valid");
        assert.equal(result.diagnostics.evaluationPublishedIndex, true);
        assert.equal(result.diagnostics.sourceRevision, "1".repeat(40));

        const rejected = spawnSync(process.execPath, [WRAPPER_PATH, entryPath], {
            encoding: "utf8",
            env: {
                ...process.env,
                SATORI_EVAL_PUBLISHED_INDEX: "0",
                SATORI_EVAL_SOURCE_REVISION: "1".repeat(40),
            },
        });
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /SATORI_EVAL_PUBLISHED_INDEX=1 is required/);

        const unbound = spawnSync(process.execPath, [WRAPPER_PATH, entryPath], {
            encoding: "utf8",
            env: { ...process.env, SATORI_EVAL_PUBLISHED_INDEX: "1" },
        });
        assert.notEqual(unbound.status, 0);
        assert.match(unbound.stderr, /SATORI_EVAL_SOURCE_REVISION/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
