import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCliArgs } from "./args.js";
import { formatGcText, runGcCommand } from "./gc.js";
import { runCli } from "./index.js";
import { buildLauncherScript } from "./managed-launcher-script.mjs";
import { resolveLauncherPath } from "./managed-runtime-paths.js";

test("parseCliArgs parses satori gc flags", () => {
    const parsed = parseCliArgs(["gc", "--dry-run", "--older-than", "14", "--worktree-days", "2", "--max-size", "3.5", "--format", "json"]);
    assert.deepEqual(parsed.command, {
        kind: "gc",
        dryRun: true,
        olderThanDays: 14,
        worktreeDays: 2,
        maxSizeGib: 3.5,
    });
    assert.equal(parsed.globals.format, "json");
});

test("satori gc inspects without authority, fails closed on apply, and reclaims under the managed runtime admission lock", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-gc-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const stateRoot = path.join(tmp, ".satori");
    const deletedRepo = path.join(tmp, "gone-repo");
    const key = crypto.createHash("sha256").update(deletedRepo).digest("hex");
    const genDir = path.join(stateRoot, "publications", key, "generations", "gen-1");
    fs.mkdirSync(genDir, { recursive: true });
    const collection = `hybrid_code_chunks_${key.slice(0, 8)}__gen_gen_1`;
    fs.writeFileSync(
        path.join(genDir, "publication.json"),
        JSON.stringify({ version: 2, id: "gen-1", canonicalRoot: deletedRepo, vector: { collectionName: collection } }),
    );
    fs.writeFileSync(
        path.join(stateRoot, "publications", key, "current.json"),
        JSON.stringify({ version: 1, publicationId: "gen-1" }),
    );
    const lanceDir = path.join(stateRoot, "vector", "lancedb", `${collection}.lance`);
    fs.mkdirSync(lanceDir, { recursive: true });
    fs.writeFileSync(path.join(lanceDir, "data.lance"), Buffer.alloc(4096, 0x78));

    const env = { ...process.env, HOME: tmp, SATORI_STATE_ROOT: stateRoot };
    const dryResult = await runGcCommand({ homeDir: tmp, env, dryRun: true });
    assert.equal(dryResult.soleOwner, true);
    assert.match(formatGcText(dryResult), /Satori Storage GC \(dry-run\)/);
    assert.equal(fs.existsSync(genDir), true);

    // Without matching Core authority, apply fails closed and leaves state untouched.
    const failClosed = await runGcCommand({ homeDir: tmp, env, dryRun: false });
    assert.equal(failClosed.removedRoots.length, 0);
    assert.equal(fs.existsSync(genDir), true);
    assert.equal(fs.existsSync(lanceDir), true);

    // Install a managed runtime fixture pointing to the worktree's built @satori-code/core.
    const worktreeCoreRoot = path.resolve(import.meta.dirname, "..", "..", "core");
    const runtimeMcpRoot = path.join(stateRoot, "mcp-runtime", "@satori-code-mcp@0.13.1", "node_modules", "@satori-code", "mcp");
    fs.mkdirSync(path.join(runtimeMcpRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(runtimeMcpRoot, "node_modules", "@satori-code", "core")), { recursive: true });
    fs.writeFileSync(path.join(runtimeMcpRoot, "package.json"), JSON.stringify({ name: "@satori-code/mcp", version: "0.13.1" }));
    fs.writeFileSync(path.join(runtimeMcpRoot, "dist", "server.js"), "// stub");
    const runtimeOwnerModule = path.resolve(import.meta.dirname, "..", "..", "mcp", "dist", "core", "runtime-owner.js");
    const runtimeOwnerFixture = path.join(runtimeMcpRoot, "dist", "core", "runtime-owner.js");
    fs.mkdirSync(path.dirname(runtimeOwnerFixture), { recursive: true });
    fs.symlinkSync(runtimeOwnerModule, runtimeOwnerFixture, "file");
    fs.symlinkSync(worktreeCoreRoot, path.join(runtimeMcpRoot, "node_modules", "@satori-code", "core"), "dir");
    const launcherPath = resolveLauncherPath(tmp);
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: [path.join(runtimeMcpRoot, "dist", "server.js")],
    }));

    const ownerLock = path.join(stateRoot, "runtime-owner", "owners.lock");
    const publicationRoot = path.join(stateRoot, "publications", key);
    const originalRm = fs.rmSync;
    let sawAdmissionLock = false;
    const rm = t.mock.method(fs, "rmSync", (file: fs.PathLike, options?: fs.RmOptions) => {
        if (file === publicationRoot) {
            const lock = JSON.parse(fs.readFileSync(ownerLock, "utf8")) as { pid: number; maintenance: boolean };
            assert.deepEqual({ pid: lock.pid, maintenance: lock.maintenance }, { pid: process.pid, maintenance: true });
            sawAdmissionLock = true;
        }
        originalRm(file, options);
    });
    let stdout = "";
    const exitCode = await runCli(["gc", "--format", "json"], {
        env,
        writeStdout: (chunk) => { stdout += chunk; },
        writeStderr: () => undefined,
    });
    rm.mock.restore();
    assert.equal(exitCode, 0);
    assert.equal(sawAdmissionLock, true);
    assert.equal(fs.existsSync(ownerLock), false);
    const payload = JSON.parse(stdout) as { removedRoots: unknown[]; soleOwner: boolean };
    assert.equal(payload.soleOwner, true);
    assert.equal(payload.removedRoots.length, 1);
    assert.equal(fs.existsSync(path.join(stateRoot, "publications", key)), false);
    assert.equal(fs.existsSync(lanceDir), false);
});
