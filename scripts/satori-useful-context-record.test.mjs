import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIR, "satori-useful-context-record.mjs");

function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function initializeRepo(repoRoot) {
    fs.mkdirSync(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "tracked\n");
    spawnSync("git", ["init", "-q"], { cwd: repoRoot });
    spawnSync("git", ["add", "tracked.txt"], { cwd: repoRoot });
    spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: repoRoot });
}

function commitRuntimeFixture(runtimeRoot) {
    fs.mkdirSync(path.join(runtimeRoot, "packages/core/dist"), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, "packages/mcp/dist"), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "packages/core/dist/index.js"), "export {};\n");
    for (const manifest of [
        "package.json",
        "packages/core/package.json",
        "packages/mcp/package.json",
    ]) {
        const file = path.join(runtimeRoot, manifest);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeJson(file, { name: manifest, version: "1.0.0" });
    }
    fs.writeFileSync(path.join(runtimeRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    spawnSync("git", ["init", "-q"], { cwd: runtimeRoot });
    spawnSync("git", ["add", "."], { cwd: runtimeRoot });
    spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "runtime fixture"], { cwd: runtimeRoot });
}

function taskSuite(repoRoot) {
    return {
        version: 1,
        tasks: [
            {
                id: "find-owner",
                queryClass: "owner_discovery",
                language: "typescript",
                expected: { ownerFile: "src/owner.ts", ownerSymbol: "handleOwner" },
                workload: {
                    setup: [{ tool: "manage_index", args: { action: "status", path: "$REPO_ROOT" } }],
                    invocations: [{
                        tool: "search_codebase",
                        args: { path: "$REPO_ROOT", query: "find owner", debugMode: "freshness" },
                    }],
                    phaseProtocol: { cold: "fresh runtime", warm: "same runtime" },
                },
            },
            {
                id: "open-owner",
                queryClass: "exact_open",
                language: "typescript",
                expected: {
                    ownerFile: "src/owner.ts",
                    ownerSymbol: "handleOwner",
                    span: { startLine: 7, endLine: 11 },
                },
                workload: {
                    setup: [{ tool: "manage_index", args: { action: "status", path: "$REPO_ROOT" } }],
                    invocations: [{
                        tool: "read_file",
                        args: {
                            path: "$REPO_ROOT/src/owner.ts",
                            mode: "annotated",
                            open_symbol: {
                                contractVersion: 2,
                                symbolLabel: "handleOwner",
                                context: { preset: "implementation" },
                            },
                        },
                    }],
                    phaseProtocol: { cold: "fresh runtime", warm: "same runtime" },
                },
            },
        ],
        repoRoot,
    };
}

function writeFakeMcp(file, options = {}) {
    const status = options.status || "ok";
    const endLine = options.endLine || 11;
    const dirtyFile = options.dirtyFile || null;
    const searchFreshnessMode = options.searchFreshnessMode || "skipped_recent";
    const driftAfterSearch = options.driftAfterSearch === true;
    fs.writeFileSync(file, `
import fs from "node:fs";
import readline from "node:readline";
const tools = ["manage_index", "search_codebase", "call_graph", "file_outline", "read_file", "list_codebases"];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const dirtyFile = ${JSON.stringify(dirtyFile)};
const searchFreshnessMode = ${JSON.stringify(searchFreshnessMode)};
const driftAfterSearch = ${JSON.stringify(driftAfterSearch)};
let measuredSearchRan = false;
const operation = () => ({
  id: measuredSearchRan && driftAfterSearch ? "op-drifted" : "op-prepared",
  action: "sync",
  canonicalRoot: process.cwd(),
  generation: measuredSearchRan && driftAfterSearch ? 8 : 7,
  acceptedAt: "2026-01-01T00:00:00.000Z",
  phase: "completed",
  lastDurableTransitionAt: measuredSearchRan && driftAfterSearch ? "2026-01-01T00:00:02.000Z" : "2026-01-01T00:00:01.000Z",
  runtimeFingerprint: { embeddingProvider: "VoyageAI", embeddingModel: "voyage-4-lite", embeddingDimension: 1024, vectorStoreProvider: "Milvus", schemaVersion: "hybrid_v3" },
  writer: { ownerId: "fake-owner", pid: process.pid, satoriVersion: "1" }
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) } });
    return;
  }
  if (message.method !== "tools/call") return;
  const name = message.params.name;
  let payload;
  if (name === "manage_index") {
    const action = message.params.arguments.action;
    payload = action === "sync"
      ? { status: ${JSON.stringify(status)}, action, path: message.params.arguments.path, operation: operation(), syncStats: { added: 0, removed: 0, modified: 0 } }
      : { status: ${JSON.stringify(status)}, action: "status", path: message.params.arguments.path, operation: operation(), publication: { collectionName: "generation-7", markerRunId: "marker-run-7", indexPolicyHash: "${"a".repeat(64)}", policyDocumentDigest: "${"b".repeat(64)}" } };
  } else if (name === "search_codebase") {
    if (dirtyFile) fs.appendFileSync(dirtyFile, "changed during recording\\n");
    const proofMode = measuredSearchRan ? "warm" : "cold";
    payload = {
      status: "ok",
      runtimeId: process.pid,
      freshnessDecision: { mode: searchFreshnessMode },
      hints: {
        debugSearch: {
          readiness: {
            proofMode,
            invalidationReason: proofMode === "warm" ? "none" : "cache_miss",
            operations: {
              preparedCacheLookups: 1,
              preparedCacheHits: proofMode === "warm" ? 1 : 0,
              coldReadinessChecks: proofMode === "cold" ? 1 : 0,
              warmReceiptRevalidations: proofMode === "warm" ? 1 : 0,
              exactPayloadRecounts: proofMode === "cold" ? 1 : 0
            }
          }
        }
      },
      results: [
        { file: "src/first.ts", symbolLabel: "function firstCandidate()", preview: "first preview" },
        { file: "src/owner.ts", symbolLabel: "function handleOwner()", content: "return owner;" },
        { file: "src/after.ts", symbolLabel: "function afterCandidate()", content: "must not count" }
      ]
    };
    measuredSearchRan = true;
  } else if (name === "read_file") {
    payload = {
      runtimeId: process.pid,
      formatVersion: 2,
      kind: "symbol_context",
      status: "ok",
      symbol: {
        file: "src/owner.ts",
        name: "handleOwner",
        label: "function handleOwner()",
        span: { startLine: 7, endLine: ${endLine} }
      },
      source: {
        status: "available",
        excerpts: [{ content: "function handleOwner() {\\n  return owner;\\n}" }]
      }
    };
  } else {
    payload = { status: "ok" };
  }
  send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
});
`);
}

test("recorder runs prepared-cold then warm in one runtime per task and emits grader-compatible observations", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-record-"));
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        const outputFile = path.join(temp, "observations.json");
        const runtimeRoot = path.join(temp, "runtime");
        const fakeMcp = path.join(runtimeRoot, "packages/mcp/dist/index.js");
        initializeRepo(repoRoot);
        writeJson(tasksFile, taskSuite(repoRoot));
        fs.mkdirSync(path.dirname(fakeMcp), { recursive: true });
        writeFakeMcp(fakeMcp);
        commitRuntimeFixture(runtimeRoot);

        const run = spawnSync(process.execPath, [
            SCRIPT_PATH,
            "--tasks", tasksFile,
            "--repo", repoRoot,
            "--out", outputFile,
            "--command", process.execPath,
            "--command-arg", fakeMcp,
            "--startup-timeout-ms", "2000",
            "--call-timeout-ms", "2000",
            "--close-timeout-ms", "500",
        ], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);

        const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        assert.equal(output.version, 1);
        assert.equal(output.metadata.repoRoot, fs.realpathSync(repoRoot));
        assert.match(output.metadata.gitRevision, /^[0-9a-f]{40}$/);
        assert.match(output.metadata.taskSuiteSha256, /^[0-9a-f]{64}$/);
        assert.deepEqual(output.metadata.serverInfo, { name: "fake", version: "1" });
        assert.equal(output.metadata.node.version, process.version);
        assert.equal(output.metadata.node.platform, process.platform);
        assert.equal(output.metadata.node.arch, process.arch);
        assert.equal(output.metadata.qualificationRuntime.status, "bound");
        assert.match(output.metadata.qualificationRuntime.sha256, /^[0-9a-f]{64}$/);
        assert.equal(output.metadata.taskRuns.length, 2);
        assert.deepEqual(output.metadata.taskRuns.map((entry) => entry.indexProof.generation), [7, 7]);
        assert.equal(output.metadata.taskRuns[0].indexProof.runtimeFingerprint.schemaVersion, "hybrid_v3");
        assert.equal(output.observations.length, 4);

        const ownerCold = output.observations.find((entry) => entry.taskId === "find-owner" && entry.phase === "cold");
        const ownerWarm = output.observations.find((entry) => entry.taskId === "find-owner" && entry.phase === "warm");
        const openCold = output.observations.find((entry) => entry.taskId === "open-owner" && entry.phase === "cold");
        const openWarm = output.observations.find((entry) => entry.taskId === "open-owner" && entry.phase === "warm");
        assert.equal(ownerCold.response.runtimeId, ownerWarm.response.runtimeId);
        assert.notEqual(ownerCold.response.runtimeId, openCold.response.runtimeId);
        assert.equal(openCold.response.runtimeId, openWarm.response.runtimeId);
        assert.deepEqual(ownerCold.results, [
            { file: "src/first.ts", symbol: "firstCandidate" },
            { file: "src/owner.ts", symbol: "handleOwner" },
            { file: "src/after.ts", symbol: "afterCandidate" },
        ]);
        assert.equal(
            ownerCold.contextBytes,
            Buffer.byteLength("first preview", "utf8") + Buffer.byteLength("return owner;", "utf8"),
        );
        assert.deepEqual(openCold.openedSymbol, {
            file: "src/owner.ts",
            symbol: "handleOwner",
            startLine: 7,
            endLine: 11,
        });
        assert.equal(openCold.status, "ok");
        assert.ok(Number.isInteger(openCold.latencyMs) && openCold.latencyMs >= 0);
        assert.equal(
            openCold.contextBytes,
            Buffer.byteLength(openCold.response.source.excerpts[0].content, "utf8"),
        );
        assert.ok(ownerCold.responseBytes > ownerCold.contextBytes);
        assert.deepEqual(ownerCold.readiness.map((entry) => entry.proofMode), ["cold"]);
        assert.deepEqual(ownerWarm.readiness.map((entry) => entry.proofMode), ["warm"]);
        assert.equal(ownerWarm.readiness[0].operations.exactPayloadRecounts, 0);

        const grade = spawnSync(process.execPath, [
            path.join(SCRIPT_DIR, "satori-useful-context.mjs"),
            "--tasks", tasksFile,
            "--observations", outputFile,
            "--json",
        ], { encoding: "utf8" });
        assert.equal(grade.status, 0, grade.stderr);
        assert.equal(JSON.parse(grade.stdout).metrics.exactSymbolOpenSuccess.rate, 1);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("recorder accepts plain exact reads and rejects unready, missing-mode, and span-drift observations", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-refusal-"));
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        initializeRepo(repoRoot);
        writeJson(tasksFile, taskSuite(repoRoot));

        const unreadyMcp = path.join(temp, "unready.mjs");
        writeFakeMcp(unreadyMcp, { status: "not_indexed" });
        const unready = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", unreadyMcp,
        ], { encoding: "utf8" });
        assert.equal(unready.status, 1);
        assert.match(unready.stderr, /not searchable|not indexed|not_indexed|readiness|freshness preparation/i);

        const plainSuite = taskSuite(repoRoot);
        plainSuite.tasks = [plainSuite.tasks[1]];
        plainSuite.tasks[0].workload.invocations[0].args.mode = "plain";
        writeJson(tasksFile, plainSuite);
        const plainMcp = path.join(temp, "plain.mjs");
        writeFakeMcp(plainMcp);
        const plain = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", plainMcp,
        ], { encoding: "utf8" });
        assert.equal(plain.status, 0, plain.stderr);

        const missingModeSuite = taskSuite(repoRoot);
        missingModeSuite.tasks = [missingModeSuite.tasks[1]];
        delete missingModeSuite.tasks[0].workload.invocations[0].args.mode;
        writeJson(tasksFile, missingModeSuite);
        const missingMode = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", plainMcp,
        ], { encoding: "utf8" });
        assert.equal(missingMode.status, 1);
        assert.match(missingMode.stderr, /requires mode='plain' or mode='annotated'/i);

        writeJson(tasksFile, taskSuite(repoRoot));
        const driftMcp = path.join(temp, "drift.mjs");
        writeFakeMcp(driftMcp, { endLine: 12 });
        const drift = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", driftMcp,
        ], { encoding: "utf8" });
        assert.equal(drift.status, 1);
        assert.match(drift.stderr, /span drift.*7-11.*7-12/i);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("dry-run validates and expands tasks without starting the command", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-dry-run-"));
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        const markerFile = path.join(temp, "started");
        const command = path.join(temp, "must-not-start.mjs");
        fs.mkdirSync(repoRoot);
        writeJson(tasksFile, taskSuite(repoRoot));
        fs.writeFileSync(command, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "started");`);

        const run = spawnSync(process.execPath, [
            SCRIPT_PATH, "--", "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", command, "--dry-run",
        ], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(fs.existsSync(markerFile), false);
        const plan = JSON.parse(run.stdout);
        assert.equal(plan.dryRun, true);
        assert.equal(plan.tasks[0].workload.setup[0].args.path, fs.realpathSync(repoRoot));
        assert.equal(plan.tasks[1].workload.invocations[0].args.path, path.join(fs.realpathSync(repoRoot), "src/owner.ts"));
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("recording rejects cache-warming setup calls", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-setup-"));
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        const fakeMcp = path.join(temp, "must-not-start.mjs");
        const markerFile = path.join(temp, "started");
        initializeRepo(repoRoot);
        const suite = taskSuite(repoRoot);
        suite.tasks = [suite.tasks[0]];
        suite.tasks[0].workload.setup = [{
            tool: "search_codebase",
            args: { path: "$REPO_ROOT", query: "find owner" },
        }];
        writeJson(tasksFile, suite);
        fs.writeFileSync(fakeMcp, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "started");`);

        const run = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", fakeMcp,
        ], { encoding: "utf8" });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /setup may only use manage_index status/i);
        assert.equal(fs.existsSync(markerFile), false);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("recording refuses a dirty worktree before starting MCP", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-dirty-"));
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        const markerFile = path.join(temp, "started");
        const command = path.join(temp, "must-not-start.mjs");
        initializeRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, "tracked.txt"), "dirty\n");
        writeJson(tasksFile, taskSuite(repoRoot));
        fs.writeFileSync(command, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "started");`);

        const run = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", command,
        ], { encoding: "utf8" });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /clean worktree|dirty|uncommitted/i);
        assert.equal(fs.existsSync(markerFile), false);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("recording refuses a worktree dirtied by the MCP runtime", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-dirty-during-"));
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        const outputFile = path.join(temp, "observations.json");
        const fakeMcp = path.join(temp, "dirtying-mcp.mjs");
        initializeRepo(repoRoot);
        const suite = taskSuite(repoRoot);
        suite.tasks = [suite.tasks[0]];
        writeJson(tasksFile, suite);
        writeFakeMcp(fakeMcp, { dirtyFile: path.join(repoRoot, "tracked.txt") });

        const run = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot, "--out", outputFile,
            "--command", process.execPath, "--command-arg", fakeMcp,
        ], { encoding: "utf8" });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /clean worktree|dirty|uncommitted/i);
        assert.equal(fs.existsSync(outputFile), false);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("recording rejects measured sync drift and output paths inside the measured repository", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-authority-"));
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        const fakeMcp = path.join(temp, "fake-mcp.mjs");
        initializeRepo(repoRoot);
        const suite = taskSuite(repoRoot);
        suite.tasks = [suite.tasks[0]];
        writeJson(tasksFile, suite);
        writeFakeMcp(fakeMcp, { searchFreshnessMode: "synced", driftAfterSearch: true });

        const drift = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot,
            "--command", process.execPath, "--command-arg", fakeMcp,
        ], { encoding: "utf8" });
        assert.equal(drift.status, 1);
        assert.match(drift.stderr, /measured.*sync|freshness.*synced|generation.*drift/i);

        const markerFile = path.join(temp, "started");
        fs.writeFileSync(fakeMcp, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "started");`);
        const inRepoOutput = path.join(repoRoot, "observations.json");
        const rejectedOutput = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot, "--out", inRepoOutput,
            "--command", process.execPath, "--command-arg", fakeMcp,
        ], { encoding: "utf8" });
        assert.equal(rejectedOutput.status, 1);
        assert.match(rejectedOutput.stderr, /output.*outside|inside.*repository/i);
        assert.equal(fs.existsSync(inRepoOutput), false);
        assert.equal(fs.existsSync(markerFile), false);

        const symlinkOutput = path.join(temp, "observations-link.json");
        fs.symlinkSync(path.join(repoRoot, "observations-through-link.json"), symlinkOutput);
        const rejectedSymlink = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", tasksFile, "--repo", repoRoot, "--out", symlinkOutput,
            "--command", process.execPath, "--command-arg", fakeMcp,
        ], { encoding: "utf8" });
        assert.equal(rejectedSymlink.status, 1);
        assert.match(rejectedSymlink.stderr, /output.*symlink|output.*outside|inside.*repository/i);
        assert.equal(fs.existsSync(path.join(repoRoot, "observations-through-link.json")), false);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

function isProcessLive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function writeNonCooperativeFakeMcp(file, { sigtermMarker }) {
    // Completes protocol calls, ignores stdin EOF and SIGTERM, stays alive until SIGKILL.
    fs.writeFileSync(file, `
import fs from "node:fs";
import readline from "node:readline";

const tools = ["manage_index", "search_codebase", "call_graph", "file_outline", "read_file", "list_codebases"];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const sigtermMarker = ${JSON.stringify(sigtermMarker)};

process.on("SIGTERM", () => {
  try { fs.writeFileSync(sigtermMarker, "sigterm-ignored\\n"); } catch { /* ignore */ }
});
process.on("SIGINT", () => {});
setInterval(() => {}, 1_000);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let measuredSearchRan = false;
rl.on("close", () => {});
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "fake-noncoop", version: "1" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) },
    });
    return;
  }
  if (message.method !== "tools/call") return;
  const name = message.params.name;
  let payload;
  if (name === "manage_index") {
    const action = message.params.arguments.action;
    const operation = {
      id: "op-prepared", action: "sync", canonicalRoot: message.params.arguments.path, generation: 7,
      acceptedAt: "2026-01-01T00:00:00.000Z", phase: "completed", lastDurableTransitionAt: "2026-01-01T00:00:01.000Z",
      runtimeFingerprint: { embeddingProvider: "VoyageAI", embeddingModel: "voyage-4-lite", embeddingDimension: 1024, vectorStoreProvider: "Milvus", schemaVersion: "hybrid_v3" },
      writer: { ownerId: "fake-owner", pid: process.pid, satoriVersion: "1" }
    };
    payload = {
      status: "ok", action, path: message.params.arguments.path, runtimeId: process.pid, operation,
      ...(action === "status" ? { publication: { collectionName: "generation-7", markerRunId: "marker-run-7", indexPolicyHash: "${"a".repeat(64)}", policyDocumentDigest: "${"b".repeat(64)}" } } : {}),
      ...(action === "sync" ? { syncStats: { added: 0, removed: 0, modified: 0 } } : {})
    };
  } else if (name === "search_codebase") {
    const proofMode = measuredSearchRan ? "warm" : "cold";
    payload = {
      status: "ok",
      runtimeId: process.pid,
      freshnessDecision: { mode: "skipped_recent" },
      hints: { debugSearch: { readiness: {
        proofMode,
        invalidationReason: proofMode === "warm" ? "none" : "cache_miss",
        operations: {
          preparedCacheLookups: 1,
          preparedCacheHits: proofMode === "warm" ? 1 : 0,
          coldReadinessChecks: proofMode === "cold" ? 1 : 0,
          warmReceiptRevalidations: proofMode === "warm" ? 1 : 0,
          exactPayloadRecounts: proofMode === "cold" ? 1 : 0
        }
      } } },
      results: [{ file: "src/owner.ts", symbolLabel: "function handleOwner()", content: "return owner;" }],
    };
    measuredSearchRan = true;
  } else {
    payload = { status: "ok", runtimeId: process.pid };
  }
  send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
});
`);
}

test("recorder escalates to SIGKILL for a non-cooperative MCP child that ignores stdin EOF and SIGTERM", {
    skip: process.platform === "win32" ? "POSIX SIGTERM/SIGKILL escalation is not observable on Windows" : false,
    // Two closeTimeoutMs waits (EOF + SIGTERM) before SIGKILL; keep headroom for protocol work.
    timeout: 15_000,
}, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-noncoop-"));
    const closeTimeoutMs = 100;
    let childPid;
    try {
        const repoRoot = path.join(temp, "repo");
        const tasksFile = path.join(temp, "tasks.json");
        const outputFile = path.join(temp, "observations.json");
        const fakeMcp = path.join(temp, "fake-noncoop-mcp.mjs");
        const sigtermMarker = path.join(temp, "sigterm-ignored");
        initializeRepo(repoRoot);
        // One task => one session => one close path under test.
        const suite = taskSuite(repoRoot);
        suite.tasks = [suite.tasks[0]];
        writeJson(tasksFile, suite);
        writeNonCooperativeFakeMcp(fakeMcp, { sigtermMarker });

        const startedAt = Date.now();
        const run = spawnSync(process.execPath, [
            SCRIPT_PATH,
            "--tasks", tasksFile,
            "--repo", repoRoot,
            "--out", outputFile,
            "--command", process.execPath,
            "--command-arg", fakeMcp,
            "--startup-timeout-ms", "2000",
            "--call-timeout-ms", "2000",
            "--close-timeout-ms", String(closeTimeoutMs),
        ], { encoding: "utf8" });
        const elapsedMs = Date.now() - startedAt;

        assert.equal(run.status, 0, run.stderr);
        const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        assert.equal(output.observations.length, 2);
        childPid = output.observations[0].response.runtimeId;
        assert.equal(Number.isInteger(childPid) && childPid > 0, true, `invalid child pid: ${childPid}`);

        // SIGTERM was delivered and ignored (proves escalation past cooperative terminate).
        assert.equal(fs.existsSync(sigtermMarker), true, "expected SIGTERM to reach the non-cooperative child");
        // close() awaited reap after SIGKILL; a single liveness check is race-free post-exit.
        assert.equal(isProcessLive(childPid), false, `MCP child ${childPid} survived recorder shutdown`);
        // Upper bound: EOF wait + SIGTERM wait + protocol/git work must finish without hanging.
        assert.ok(
            elapsedMs < closeTimeoutMs * 2 + 5_000,
            `recorder hang after non-cooperative close path: elapsed=${elapsedMs}ms`,
        );
        // Lower bound: both grace windows must elapse before SIGKILL.
        assert.ok(
            elapsedMs >= closeTimeoutMs * 2,
            `expected EOF+SIGTERM grace windows before SIGKILL: elapsed=${elapsedMs}ms closeTimeoutMs=${closeTimeoutMs}`,
        );
    } finally {
        if (childPid && isProcessLive(childPid)) {
            try {
                process.kill(childPid, "SIGKILL");
            } catch {
                // Ignore races where the child exits before forced cleanup.
            }
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
