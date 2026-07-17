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
}
`);
        const entryPath = path.join(distDir, "index.js");
        fs.writeFileSync(entryPath, `
import { SyncManager } from "./core/sync.js";
const result = await new SyncManager().ensureFreshness("/repo", 123);
process.stdout.write(JSON.stringify(result));
`);

        const run = spawnSync(process.execPath, [WRAPPER_PATH, entryPath], {
            encoding: "utf8",
            env: { ...process.env, SATORI_EVAL_PUBLISHED_INDEX: "1" },
        });
        assert.equal(run.status, 0, run.stderr);
        const result = JSON.parse(run.stdout);
        assert.equal(result.mode, "skipped_recent");
        assert.equal(result.thresholdMs, 123);
        assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);

        const rejected = spawnSync(process.execPath, [WRAPPER_PATH, entryPath], {
            encoding: "utf8",
            env: { ...process.env, SATORI_EVAL_PUBLISHED_INDEX: "0" },
        });
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /SATORI_EVAL_PUBLISHED_INDEX=1 is required/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
