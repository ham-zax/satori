import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIR, "satori-useful-context-fixture-record.mjs");

function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function task(id, queryClass, query, expected, mutations = []) {
    return {
        id,
        queryClass,
        language: "typescript",
        expected,
        workload: {
            setup: [{ tool: "manage_index", args: { action: "status", path: "$REPO_ROOT" } }],
            invocations: queryClass === "caller_recovery"
                ? [{
                    tool: "call_graph",
                    args: {
                        path: "$REPO_ROOT",
                        symbolRef: { file: "src/owner.ts", symbolLabel: "fixtureOwner" },
                        direction: "inbound",
                        depth: 1,
                    },
                }]
                : [{
                    tool: "search_codebase",
                    args: { path: "$REPO_ROOT", query, scope: "runtime" },
                }],
            phaseProtocol: { cold: "first call after fixture setup", warm: "same call in the same runtime" },
        },
        fixture: { mutations },
    };
}

function fixtureSuite() {
    return {
        version: 1,
        name: "fixture suite",
        tasks: [
            task("caller", "caller_recovery", "", {
                ownerFile: "src/owner.ts",
                ownerSymbol: "fixtureOwner",
                callerSymbols: [{ file: "src/caller.ts", symbol: "fixtureCaller" }],
            }),
            task("dirty", "dirty_owner", "overlay dirtyFixtureOwner", {
                ownerFile: "src/owner.ts",
                ownerSymbol: "dirtyFixtureOwner",
            }, [{ type: "replace", file: "src/owner.ts", from: "fixtureOwner", to: "dirtyFixtureOwner" }]),
            task("stale", "stale_recovery", "recover dirtyFixtureOwner", {
                ownerFile: "src/owner.ts",
                ownerSymbol: "dirtyFixtureOwner",
            }, [{ type: "replace", file: "src/owner.ts", from: "fixtureOwner", to: "dirtyFixtureOwner" }]),
        ],
    };
}

function writeFakeMcp(file) {
    fs.writeFileSync(file, `
import fs from "node:fs";
import readline from "node:readline";
const logFile = process.env.SATORI_FIXTURE_TEST_LOG;
const tools = ["manage_index", "search_codebase", "continue_search", "call_graph", "file_outline", "read_file", "list_codebases"];
let lastMutationAction = "create";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
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
  const { name, arguments: args } = message.params;
  log({ name, args });
  let payload;
  if (name === "manage_index") {
    if (args.action !== "status") lastMutationAction = args.action;
    const source = fs.existsSync(args.path + "/src/owner.ts") ? fs.readFileSync(args.path + "/src/owner.ts", "utf8") : "";
    const modified = source.includes("dirtyFixtureOwner") ? 1 : 0;
    payload = {
      status: "ok",
      action: args.action,
      path: args.path,
      operation: {
        id: "op-" + (args.action === "status" ? lastMutationAction : args.action),
        action: args.action === "status" ? lastMutationAction : args.action,
        canonicalRoot: args.path,
        generation: (args.action === "sync" || (args.action === "status" && lastMutationAction === "sync")) ? 2 : 1,
        acceptedAt: "2026-01-01T00:00:00.000Z",
        phase: "completed",
        lastDurableTransitionAt: "2026-01-01T00:00:01.000Z",
        runtimeFingerprint: { embeddingProvider: "VoyageAI", embeddingModel: "voyage-4-lite", embeddingDimension: 1024, vectorStoreProvider: "Milvus", schemaVersion: "hybrid_v3" },
        writer: { ownerId: "fake-owner", pid: process.pid, satoriVersion: "1" }
      },
      ...(args.action === "status" ? { publication: { collectionName: "generation-2", markerRunId: "marker-run-2", indexPolicyHash: "${"a".repeat(64)}", policyDocumentDigest: "${"b".repeat(64)}" } } : {}),
      ...(args.action === "sync" ? { syncStats: { added: 0, removed: 0, modified } } : {})
    };
  } else if (name === "call_graph") {
    payload = {
      status: "ok",
      nodes: [
        { symbolId: "owner", file: "src/owner.ts", symbolLabel: "fixtureOwner" },
        { symbolId: "caller", file: "src/caller.ts", symbolLabel: "fixtureCaller" }
      ],
      edges: [{ sourceSymbolId: "caller", targetSymbolId: "owner" }]
    };
  } else if (name === "search_codebase") {
    const source = fs.readFileSync(args.path + "/src/owner.ts", "utf8");
    const dirty = source.includes("dirtyFixtureOwner");
    payload = {
      status: "ok",
      freshnessDecision: { mode: "skipped_recent" },
      results: [{
        file: "src/owner.ts",
        symbolLabel: dirty ? "dirtyFixtureOwner" : "fixtureOwner",
        content: source
      }]
    };
  } else {
    payload = { status: "ok" };
  }
  send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
});
`);
}

test("fixture recorder isolates mutations, records caller/dirty/stale evidence, clears, and removes roots", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-fixture-recorder-test-"));
    try {
        const template = path.join(temp, "template");
        fs.mkdirSync(path.join(template, "src"), { recursive: true });
        fs.writeFileSync(path.join(template, "src", "owner.ts"), "export function fixtureOwner() { return 1; }\n");
        fs.writeFileSync(path.join(template, "src", "caller.ts"), "import { fixtureOwner } from './owner';\nexport function fixtureCaller() { return fixtureOwner(); }\n");
        const suiteFile = path.join(temp, "suite.json");
        const outputFile = path.join(temp, "observations.json");
        const logFile = path.join(temp, "calls.jsonl");
        const fakeMcp = path.join(temp, "fake-mcp.mjs");
        writeJson(suiteFile, fixtureSuite());
        writeFakeMcp(fakeMcp);

        const run = spawnSync(process.execPath, [
            SCRIPT_PATH,
            "--tasks", suiteFile,
            "--fixture-template", template,
            "--out", outputFile,
            "--command", process.execPath,
            "--command-arg", fakeMcp,
            "--call-timeout-ms", "2000",
            "--close-timeout-ms", "500",
        ], {
            encoding: "utf8",
            env: { ...process.env, SATORI_FIXTURE_TEST_LOG: logFile },
        });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(fs.readFileSync(path.join(template, "src", "owner.ts"), "utf8"), "export function fixtureOwner() { return 1; }\n");

        const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        assert.equal(output.version, 3);
        assert.equal(output.warmSampleCount, 1);
        assert.equal(output.metadata.fixtureIsolated, true);
        assert.match(output.metadata.taskSuiteSha256, /^[0-9a-f]{64}$/);
        assert.deepEqual(output.metadata.serverInfo, { name: "fake", version: "1" });
        assert.equal(output.metadata.node.version, process.version);
        assert.equal(output.metadata.taskRuns.length, 3);
        assert.equal(output.observations.length, 6);
        for (const taskId of ["caller", "dirty", "stale"]) {
            assert.deepEqual(output.observations.filter((entry) => entry.taskId === taskId).map((entry) => entry.phase), ["cold", "warm"]);
            assert.deepEqual(output.observations.filter((entry) => entry.taskId === taskId).map((entry) => entry.sample), [0, 1]);
        }
        const stale = output.observations.find((entry) => entry.taskId === "stale" && entry.phase === "cold");
        assert.equal(stale.staleIndexDetected, true);
        assert.equal(stale.recoverySucceeded, true);
        assert.ok(stale.results.every((result) => result.kind === "symbol"));

        const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
        const creates = calls.filter((entry) => entry.name === "manage_index" && entry.args.action === "create");
        const clears = calls.filter((entry) => entry.name === "manage_index" && entry.args.action === "clear");
        const dirtySearches = calls.filter((entry) => entry.name === "search_codebase" && entry.args.query === "overlay dirtyFixtureOwner");
        assert.equal(creates.length, 3);
        assert.equal(clears.length, 3);
        assert.equal(dirtySearches.length, 2, "the exact dirty workload must not be used as a setup prewarm");
        assert.equal(new Set(creates.map((entry) => entry.args.path)).size, 3);
        for (const entry of creates) {
            assert.equal(fs.existsSync(entry.args.path), false);
            assert.match(entry.args.path, /satori-useful-context-fixture-/);
        }
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("fixture recorder rejects traversal mutations before starting MCP", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-fixture-recorder-traversal-"));
    try {
        const template = path.join(temp, "template");
        fs.mkdirSync(path.join(template, "src"), { recursive: true });
        fs.writeFileSync(path.join(template, "src", "owner.ts"), "export function fixtureOwner() {}\n");
        const suite = fixtureSuite();
        suite.tasks[1].fixture.mutations[0].file = "../outside.ts";
        const suiteFile = path.join(temp, "suite.json");
        writeJson(suiteFile, suite);
        const run = spawnSync(process.execPath, [
            SCRIPT_PATH,
            "--tasks", suiteFile,
            "--fixture-template", template,
            "--command", process.execPath,
            "--command-arg", path.join(temp, "must-not-run.mjs"),
        ], { encoding: "utf8" });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /fixture|relative|outside|traversal/i);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("fixture recorder rejects symlink mutation targets before starting MCP", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-fixture-recorder-symlink-"));
    try {
        const template = path.join(temp, "template");
        const outside = path.join(temp, "outside.ts");
        fs.mkdirSync(path.join(template, "src"), { recursive: true });
        fs.writeFileSync(outside, "export function fixtureOwner() {}\n");
        fs.symlinkSync(outside, path.join(template, "src", "owner.ts"));
        fs.writeFileSync(path.join(template, "src", "caller.ts"), "export function fixtureCaller() {}\n");
        const suiteFile = path.join(temp, "suite.json");
        const logFile = path.join(temp, "calls.jsonl");
        writeJson(suiteFile, fixtureSuite());
        const run = spawnSync(process.execPath, [
            SCRIPT_PATH,
            "--tasks", suiteFile,
            "--fixture-template", template,
            "--command", process.execPath,
            "--command-arg", path.join(temp, "must-not-run.mjs"),
        ], { encoding: "utf8", env: { ...process.env, SATORI_FIXTURE_TEST_LOG: logFile } });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /symbolic link/i);
        assert.equal(fs.readFileSync(outside, "utf8"), "export function fixtureOwner() {}\n");
        assert.equal(fs.existsSync(logFile), false);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("fixture recorder rejects output paths inside the template repository before starting MCP", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "satori-fixture-recorder-output-"));
    try {
        const checkout = path.join(temp, "checkout");
        const template = path.join(checkout, "fixture-repo");
        fs.mkdirSync(path.join(template, "src"), { recursive: true });
        fs.writeFileSync(path.join(template, "src", "owner.ts"), "export function fixtureOwner() {}\n");
        fs.writeFileSync(path.join(template, "src", "caller.ts"), "export function fixtureCaller() {}\n");
        spawnSync("git", ["init", "-q"], { cwd: checkout });
        const suiteFile = path.join(temp, "suite.json");
        const markerFile = path.join(temp, "started");
        const command = path.join(temp, "must-not-start.mjs");
        writeJson(suiteFile, fixtureSuite());
        fs.writeFileSync(command, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "started");`);
        const outputFile = path.join(checkout, "observations.json");
        const run = spawnSync(process.execPath, [
            SCRIPT_PATH, "--tasks", suiteFile, "--fixture-template", template, "--out", outputFile,
            "--command", process.execPath, "--command-arg", command,
        ], { encoding: "utf8" });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /output.*outside|template.*repository/i);
        assert.equal(fs.existsSync(outputFile), false);
        assert.equal(fs.existsSync(markerFile), false);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
