import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeInstallCommand as executeInstallCommandProduction, type InstallCommandInput } from "./install.js";
import {
    formatCandidatePreflightFailure,
    probeLanceDbRuntime,
    probeManagedRuntimeCandidate,
    planInstallRuntimeEnvironment,
    runInstallPreflight,
    verifyBundledPotionRuntime,
    type PotionRuntimeCoreModule,
} from "./install-preflight.js";
import { CliError } from "./errors.js";
import { buildLauncherScript, parseManagedLauncherEnvironment } from "./managed-launcher-script.mjs";
import {
    CANDIDATE_STDERR_LIMIT_BYTES,
    createCandidateStderrCollector,
    normalizeCandidateStderr,
} from "./candidate-stderr.js";
import {
    LATEON_ACTIVATION_POLICY,
    LATEON_PROFILE_ID,
    fixtureLateOnRuntime,
    writeLateOnAcquisitionFixture,
    writeLateOnModelDirectory,
} from "./test-fixtures/lateon-fixture.js";
import { loadAcquisitionAuthority } from "./lateon-model-store.js";

const DIGEST = "b".repeat(64);
const POTION_ASSETS_ROOT = fileURLToPath(new URL("../../mcp/assets/potion/linux-x64/", import.meta.url));
const loadWorkspaceCore = async (): Promise<PotionRuntimeCoreModule> => (
    import("@zokizuan/satori-core") as Promise<PotionRuntimeCoreModule>
);

function installRuntimeWithProbeMarker(markerPath: string) {
    return ((_command: string, args: string[]) => {
        const prefixIndex = args.indexOf("--prefix");
        assert.notEqual(prefixIndex, -1);
        const runtimeRoot = args[prefixIndex + 1];
        assert.ok(runtimeRoot);
        const mcpRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
        const coreRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-core");
        fs.mkdirSync(path.join(mcpRoot, "dist"), { recursive: true });
        fs.mkdirSync(coreRoot, { recursive: true });
        fs.writeFileSync(path.join(mcpRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "0.0.0-exact-runtime-test",
            bin: { satori: "dist/index.js" },
        }), "utf8");
        fs.writeFileSync(path.join(mcpRoot, "dist", "index.js"), "", "utf8");
        fs.writeFileSync(path.join(coreRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            type: "module",
            exports: { "./lancedb": "./lancedb.mjs" },
        }), "utf8");
        fs.writeFileSync(path.join(coreRoot, "lancedb.mjs"), `
import fs from "node:fs";
export class LanceDbVectorDatabase {
  constructor(config) { fs.appendFileSync(${JSON.stringify(markerPath)}, config.databasePath + "\\n"); }
  async createHybridCollection() {}
  async writeDocuments() {}
  async finalizeCollectionForSearch() {}
  async retrieveDense() { return [{ document: { id: "preflight_document" } }]; }
  async retrieveLexical() { return [{ document: { id: "preflight_document" } }]; }
  async dropCollection() {}
  async listCollections() { return []; }
  async close() {}
}
`, "utf8");
        return "";
    }) as never;
}

function executeInstallCommand(
    command: InstallCommandInput,
    options: Parameters<typeof executeInstallCommandProduction>[1] = {},
) {
    return executeInstallCommandProduction(command, {
        ...options,
        lateOnAuthorityLoader: options.lateOnAuthorityLoader ?? loadAcquisitionAuthority,
    });
}

test("install preflight loads LanceDB from the installed MCP runtime", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-exact-runtime-preflight-"));
    const markerPath = path.join(homeDir, "managed-core-probe.log");
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-exact-runtime-test",
            execFileSyncImpl: installRuntimeWithProbeMarker(markerPath),
            preflightDependencies: {
                probeCandidateRuntime: async () => {},
            },
        });

        const constructedPaths = fs.readFileSync(markerPath, "utf8").trim().split("\n");
        assert.equal(constructedPaths.length >= 2, true);
        assert.equal(constructedPaths.every((candidate) => candidate.startsWith(homeDir)), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("candidate preflight proves initialization, version, and the canonical tool surface", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-runtime-preflight-"));
    const runtimeEntry = path.join(homeDir, "candidate.mjs");
    try {
        fs.writeFileSync(runtimeEntry, `
import readline from "node:readline";
const tools = ${JSON.stringify([
            "manage_index",
            "search_codebase",
            "architecture_overview",
            "continue_search",
            "call_graph",
            "trace_path",
            "find_references",
            "detect_changes",
            "file_outline",
            "read_file",
            "list_codebases",
        ])};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "satori", version: "9.8.7-test" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, {
      tools: tools.map((name) => ({
        name,
        description: "candidate fixture",
        inputSchema: { type: "object", properties: {} },
      })),
    });
  }
});
`, "utf8");

        await probeManagedRuntimeCandidate({
            runtimeCommand: { command: process.execPath, args: [runtimeEntry] },
            runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
            inheritedEnvironment: {},
            homeDir,
            expectedVersion: "9.8.7-test",
        });
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

function writeCandidateEntry(entryPath: string, source: string): void {
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, source, "utf8");
}

function failingProbeInput(homeDir: string, entryPath: string, expectedVersion = "6.8.1") {
    return {
        runtimeCommand: { command: process.execPath, args: [entryPath] },
        runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
        inheritedEnvironment: {},
        homeDir,
        expectedVersion,
    };
}

test("candidate exception written before exit is included in the preflight failure", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-stderr-"));
    try {
        const entryPath = path.join(homeDir, "exploding-candidate.mjs");
        writeCandidateEntry(entryPath, `
process.stderr.write("FATAL: unexpected startup exception\\n");
process.exit(1);
`);
        await assert.rejects(
            probeManagedRuntimeCandidate(failingProbeInput(homeDir, entryPath)),
            (error) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Candidate runtime failed before completing MCP preflight\./);
                assert.match(error.message, /Candidate command:/);
                assert.match(error.message, /Candidate stderr:/);
                assert.match(error.message, /FATAL: unexpected startup exception/);
                return true;
            },
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connection closed failures are accompanied by candidate stderr", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-closed-"));
    try {
        const entryPath = path.join(homeDir, "silent-exit-candidate.mjs");
        writeCandidateEntry(entryPath, `
process.stderr.write("ERR load: cannot open shared library 'libonnxruntime.so'\\n");
process.exit(0);
`);
        await assert.rejects(
            probeManagedRuntimeCandidate(failingProbeInput(homeDir, entryPath)),
            /ERR load: cannot open shared library 'libonnxruntime\.so'/,
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("empty candidate stderr is reported explicitly", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-no-stderr-"));
    try {
        const entryPath = path.join(homeDir, "quiet-exit-candidate.mjs");
        writeCandidateEntry(entryPath, "process.exit(1);\n");
        await assert.rejects(
            probeManagedRuntimeCandidate(failingProbeInput(homeDir, entryPath)),
            /Candidate runtime produced no stderr\./,
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("preflight diagnostics include only safe candidate identities", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-identity-"));
    try {
        const runtimeRoot = path.join(homeDir, "mcp-runtime", "@zokizuan-satori-mcp@6.8.1");
        const mcpPackageRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
        const entryPath = path.join(mcpPackageRoot, "dist", "index.js");
        writeCandidateEntry(entryPath, 'process.stderr.write("boom\\n"); process.exit(1);\n');
        await assert.rejects(
            probeManagedRuntimeCandidate(failingProbeInput(homeDir, entryPath)),
            (error) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Expected MCP version: 6\.8\.1/);
                assert.match(error.message, new RegExp(`Candidate MCP package root: ${mcpPackageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
                assert.match(error.message, new RegExp(`Candidate runtime root: ${runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
                assert.match(error.message, /Node: v\d+\.\d+\.\d+/);
                assert.match(error.message, /Platform: linux x64/);
                assert.doesNotMatch(error.message, /SATORI_|NODE_AUTH_TOKEN|npm_token/i);
                return true;
            },
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("successful preflight ignores benign candidate stderr chatter", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-chatter-"));
    try {
        const entryPath = path.join(homeDir, "chatty-candidate.mjs");
        writeCandidateEntry(entryPath, `
import readline from "node:readline";
process.stderr.write("notice: embedding cache warming\\n");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "satori", version: "9.8.7-test" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, {
      tools: ["manage_index", "search_codebase", "architecture_overview", "continue_search", "call_graph", "trace_path", "find_references", "detect_changes", "file_outline", "read_file", "list_codebases"]
        .map((name) => ({ name, description: "candidate fixture", inputSchema: { type: "object", properties: {} } })),
    });
  }
});
`);
        await probeManagedRuntimeCandidate({
            ...failingProbeInput(homeDir, entryPath, "9.8.7-test"),
            runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
        });
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("candidate stderr collector caps retained output at 16 KiB and keeps the newest tail", () => {
    const collector = createCandidateStderrCollector();
    collector.write(Array.from({ length: 4000 }, (_, index) => `line-${index}\n`).join(""));
    const text = collector.text();
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
    assert.equal(text.includes("line-0\n"), false);
    assert.equal(text.includes("line-3999\n"), true);
});

test("candidate stderr normalization strips ANSI sequences", () => {
    const collector = createCandidateStderrCollector();
    collector.write("\u001b[31mred\u001b[0m\u001b]0;window-title\u0007plain\n");
    assert.equal(collector.text(), "redplain\n");
});

test("candidate stderr normalization converts CRLF and lone CR to LF", () => {
    const collector = createCandidateStderrCollector();
    collector.write("first\r\nsecond\rthird\nfourth");
    assert.equal(collector.text(), "first\nsecond\nthird\nfourth");
});

test("candidate stderr normalization redacts authentication URLs and token assignments", () => {
    const collector = createCandidateStderrCollector();
    collector.write(
        "npm error code E401\n"
        + "npm error Unauthorized - GET //registry.npmjs.org/:_authToken=abc123def456\n"
        + "_authToken=topsecret\nNPM_TOKEN=anothersecret\n"
        + "AUTH_TOKEN=thirdsecret\n",
    );
    const text = collector.text();
    assert.equal(text.includes("abc123def456"), false);
    assert.equal(text.includes("topsecret"), false);
    assert.equal(text.includes("anothersecret"), false);
    assert.equal(text.includes("thirdsecret"), false);
    assert.match(text, /:_authToken=<redacted>/);
    assert.match(text, /_authToken=<redacted>/);
    assert.match(text, /NPM_TOKEN=<redacted>/);
    assert.match(text, /AUTH_TOKEN=<redacted>/);
});

test("candidate stderr normalization handles secrets and ANSI sequences split across chunks", () => {
    const collector = createCandidateStderrCollector();
    collector.write("NPM_");
    collector.write("TOKEN=");
    collector.write("split-secret\n");
    collector.write("{\"OPENAI_API_");
    collector.write("KEY\":\"json-secret\"}\n");
    collector.write("Authorization: Bear");
    collector.write("er bearer-secret\n");
    collector.write("https://www.npmjs.com/auth/cli/");
    collector.write("split-auth-id\n");
    collector.write("\u001b[");
    collector.write("31mred\u001b[");
    collector.write("0mplain\n");

    const text = collector.text();
    assert.equal(text.includes("split-secret"), false);
    assert.equal(text.includes("json-secret"), false);
    assert.equal(text.includes("bearer-secret"), false);
    assert.equal(text.includes("split-auth-id"), false);
    assert.equal(text.includes("\u001b"), false);
    assert.match(text, /redplain/);
});

test("candidate stderr retention does not leak a secret key crossing the byte cutoff", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`${"safe\n".repeat(Math.ceil(CANDIDATE_STDERR_LIMIT_BYTES / 5) + 1)}OPENAI_API_KEY=`);
    collector.write("crossing-secret\n");
    const text = collector.text();
    assert.equal(text.includes("crossing-secret"), false);
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate stderr retention does not leak a bearer token crossing the byte cutoff", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`${"safe\n".repeat(Math.ceil(CANDIDATE_STDERR_LIMIT_BYTES / 5) + 1)}Authorization: Bear`);
    collector.write("er crossing-bearer-secret\n");
    const text = collector.text();
    assert.equal(text.includes("crossing-bearer-secret"), false);
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate stderr retention does not leak an npm auth id crossing the byte cutoff", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`${"safe\n".repeat(Math.ceil(CANDIDATE_STDERR_LIMIT_BYTES / 5) + 1)}https://registry.npmjs.org/-/v1/done?authId=`);
    collector.write("crossing-auth-id&ok=true\n");
    const text = collector.text();
    assert.equal(text.includes("crossing-auth-id"), false);
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate stderr retention removes an ANSI sequence crossing the byte cutoff", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`${"safe\n".repeat(Math.ceil(CANDIDATE_STDERR_LIMIT_BYTES / 5) + 1)}\u001b[`);
    collector.write("31mred\u001b[0m\n");
    const text = collector.text();
    assert.equal(text.includes("\u001b"), false);
    assert.match(text, /red/);
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate stderr retention keeps UTF-8 characters intact at the cutoff", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`${"safe\n".repeat(Math.ceil(CANDIDATE_STDERR_LIMIT_BYTES / 5) + 1)}é\n`);
    const text = collector.text();
    assert.equal(text.includes("é"), true);
    assert.equal(text.includes("�"), false);
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate stderr replaces one oversized secret-bearing line with a marker", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`OPENAI_API_KEY=${"oversized-secret".repeat(2000)}\n`);
    const text = collector.text();
    assert.equal(text.includes("oversized-secret"), false);
    assert.ok(/truncated/i.test(text));
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate stderr recovers valid lines after an oversized line within one chunk", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`OPENAI_API_KEY=${"x".repeat(CANDIDATE_STDERR_LIMIT_BYTES + 1024)}\nvalid-tail-line\n`);
    const text = collector.text();
    assert.equal(text.includes("valid-tail-line"), true);
    assert.equal(text.includes("OPENAI_API_KEY"), false);
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate stderr recovers valid lines after an oversized line split across chunks", () => {
    const collector = createCandidateStderrCollector();
    collector.write(`OPENAI_API_KEY=${"x".repeat(CANDIDATE_STDERR_LIMIT_BYTES + 1024)}`);
    collector.write("more-of-the-oversized-line\nvalid-after-split\n");
    const text = collector.text();
    assert.equal(text.includes("valid-after-split"), true);
    assert.equal(text.includes("OPENAI_API_KEY"), false);
    assert.equal(text.includes("more-of-the-oversized-line"), false);
    assert.ok(Buffer.byteLength(text, "utf8") <= CANDIDATE_STDERR_LIMIT_BYTES);
});

test("candidate preflight decodes a UTF-8 character split across buffer writes", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-utf8-split-"));
    try {
        const entryPath = path.join(homeDir, "utf8-split-candidate.mjs");
        writeCandidateEntry(entryPath, `
process.stderr.write(Buffer.from([0xE2]));
process.stderr.write(Buffer.from([0x82, 0xAC]));
process.stderr.write("\\n");
process.exit(1);
`);
        await assert.rejects(
            probeManagedRuntimeCandidate(failingProbeInput(homeDir, entryPath)),
            (error) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message.includes("�"), false);
                assert.equal(error.message.includes("€"), true);
                return true;
            },
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("candidate stderr normalization redacts supported secret key families and npm auth URLs", () => {
    const collector = createCandidateStderrCollector();
    collector.write([
        "SERVICE_TOKEN=token-secret",
        "SERVICE_AUTH_TOKEN=auth-token-secret",
        "SERVICE_API_KEY=api-key-secret",
        "SERVICE_SECRET=secret-value",
        "SERVICE_PASSWORD=password-value",
        "SERVICE_CREDENTIAL=credential-value",
        "Authorization: Basic basic-secret",
        "https://registry.npmjs.org/-/v1/done?authId=web-auth-id&ok=true",
        "https://www.npmjs.com/auth/cli/web-cli-id",
        "",
    ].join("\n"));

    const text = collector.text();
    for (const secret of [
        "token-secret",
        "auth-token-secret",
        "api-key-secret",
        "secret-value",
        "password-value",
        "credential-value",
        "basic-secret",
        "web-auth-id",
        "web-cli-id",
    ]) {
        assert.equal(text.includes(secret), false, `secret leaked: ${secret}`);
    }
    assert.match(text, /SERVICE_TOKEN=<redacted>/);
    assert.match(text, /Authorization: Basic <redacted>/);
    assert.match(text, /authId=<redacted>&ok=true/);
    assert.match(text, /https:\/\/www\.npmjs\.com\/auth\/cli\/<redacted>/);
});

test("candidate diagnostics preserve failure tokens without exposing raw commands", () => {
    const message = formatCandidatePreflightFailure({
        runtimeCommand: {
            command: process.execPath,
            args: ["/tmp/candidate.mjs", "OPENAI_API_KEY=command-secret"],
        },
        stderrText: "safe startup note",
        expectedVersion: "6.8.1",
        failure: new CliError("E_PROTOCOL_FAILURE", "Connection closed", 3),
    });

    assert.match(message, /Candidate runtime failed before completing MCP preflight\./);
    assert.match(message, /Executable:/);
    assert.match(message, /Entry: \/tmp\/candidate\.mjs/);
    assert.match(message, /Failure: E_PROTOCOL_FAILURE: Connection closed/);
    assert.equal(message.includes("command-secret"), false);
    assert.equal(message.includes("OPENAI_API_KEY=command-secret"), false);
    assert.equal(message.includes("candidateCommand.join"), false);
});

test("candidate diagnostics preserve startup timeout identity", () => {
    const message = formatCandidatePreflightFailure({
        runtimeCommand: { command: process.execPath, args: ["/tmp/candidate.mjs"] },
        stderrText: "",
        expectedVersion: "6.8.1",
        failure: new CliError("E_STARTUP_TIMEOUT", "Timed out after 10000ms while starting MCP server.", 3),
    });

    assert.match(message, /Candidate runtime failed before completing MCP preflight\./);
    assert.match(message, /Failure: E_STARTUP_TIMEOUT: Timed out after 10000ms while starting MCP server\./);
    assert.doesNotMatch(message, /Candidate runtime exited before/);
    assert.match(message, /Candidate runtime produced no stderr\./);
});

test("normalizeCandidateStderr never retains NUL bytes or terminal controls", () => {
    const text = normalizeCandidateStderr("a\u0000b\u0007\u001b[2Kc\u001b]0;t\u0007d");
    assert.equal(text.includes("\u0000"), false);
    assert.equal(text.includes("\u0007"), false);
    assert.equal(text.includes("\u001b"), false);
    assert.equal(text, "abcd");
});

test("candidate probe failure leaves the existing managed launcher unchanged", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-probe-failure-launcher-"));
    const markerPath = path.join(homeDir, "managed-core-probe.log");
    const runtimeRoot = path.join(homeDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@0.0.0-exact-runtime-test");
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: false,
                runtime: "offline",
            }, {
                homeDir,
                env: { SATORI_RERANKER_PROVIDER: "none" },
                packageSpecifier: "@zokizuan/satori-mcp@0.0.0-exact-runtime-test",
                platform: "linux",
                architecture: "x64",
                execFileSyncImpl: installRuntimeWithProbeMarker(markerPath),
                preflightDependencies: {
                    verifyPotionRuntime: async () => {},
                },
            }),
            /Candidate runtime preflight failed: Candidate runtime failed before completing MCP preflight\./,
        );
        assert.deepEqual(fs.readFileSync(snapshot.launcherPath), snapshot.launcherBytes);
        assert.deepEqual(fs.readFileSync(snapshot.configPath), snapshot.configBytes);
        assert.deepEqual(fs.readFileSync(snapshot.oldRuntimePath), snapshot.oldRuntimeBytes);
        assert.equal(fs.existsSync(runtimeRoot), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("Voyage install preflight proves and pins the default LanceDB and Voyage identity", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-voyage-preflight-"));
    const probedPaths: string[] = [];
    try {
        const result = await runInstallPreflight({
            runtime: "voyage",
            homeDir,
            env: {},
        }, {
            probeLanceDb: async (databasePath) => {
                probedPaths.push(databasePath);
            },
        });

        assert.deepEqual(probedPaths, [path.join(homeDir, ".satori", "vector", "lancedb")]);
        assert.deepEqual(result.runtimeEnvironment, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, ".satori", "vector", "lancedb"),
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "voyage-code-3",
            EMBEDDING_OUTPUT_DIMENSION: "1024",
        });
        assert.equal(Object.isFrozen(result.runtimeEnvironment), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected Milvus selection skips LanceDB and ignores irrelevant LanceDB path state", async () => {
    let lanceDbProbeCalls = 0;
    const result = await runInstallPreflight({
        runtime: "voyage",
        homeDir: "/tmp/satori-connected-milvus",
        env: {
            VECTOR_STORE_PROVIDER: "Milvus",
            MILVUS_ADDRESS: "https://milvus.example.test",
            LANCEDB_PATH: "relative/stale/value",
            EMBEDDING_PROVIDER: "OpenAI",
        },
    }, {
        probeLanceDb: async () => {
            lanceDbProbeCalls += 1;
        },
    });

    assert.equal(lanceDbProbeCalls, 0);
    assert.deepEqual(result.runtimeEnvironment, {
        SATORI_RUNTIME_PROFILE: "connected",
        VECTOR_STORE_PROVIDER: "Milvus",
        EMBEDDING_PROVIDER: "VoyageAI",
        EMBEDDING_MODEL: "voyage-code-3",
        EMBEDDING_OUTPUT_DIMENSION: "1024",
    });
});

test("managed connected launcher pins the Milvus backend that passed preflight", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-milvus-install-"));
    const externalEnvironment = {
        VECTOR_STORE_PROVIDER: "Milvus",
        MILVUS_ADDRESS: "https://milvus.example.test",
        EMBEDDING_PROVIDER: "OpenAI",
    };
    let lanceDbProbeCalls = 0;
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: externalEnvironment,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async () => {
                    lanceDbProbeCalls += 1;
                },
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        );
        assert.equal(lanceDbProbeCalls, 0);
        assert.deepEqual(launcherEnvironment, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "Milvus",
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "voyage-code-3",
            EMBEDDING_OUTPUT_DIMENSION: "1024",
        });
        assert.equal({ ...externalEnvironment, ...launcherEnvironment }.VECTOR_STORE_PROVIDER, "Milvus");
        assert.equal({ ...externalEnvironment, ...launcherEnvironment }.EMBEDDING_PROVIDER, "VoyageAI");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("offline install preflight records resolved local model identity", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-preflight-"));
    try {
        const result = await runInstallPreflight({
            runtime: "offline",
            homeDir,
            env: { OLLAMA_HOST: "http://localhost:11434" },
            ollamaModel: "nomic-embed-text",
        }, {
            probeLanceDb: async () => undefined,
            resolveOllamaIdentity: async ({ model, host }) => {
                assert.equal(model, "nomic-embed-text");
                assert.equal(host, "http://localhost:11434");
                return Object.freeze({
                    configuredModel: model,
                    resolvedModel: "nomic-embed-text:latest",
                    artifactDigest: DIGEST,
                    artifactSize: 42,
                    dimension: 768,
                });
            },
        });

        assert.equal(result.runtimeEnvironment.SATORI_RUNTIME_PROFILE, "offline");
        assert.equal(result.runtimeEnvironment.EMBEDDING_PROVIDER, "Ollama");
        assert.equal(result.runtimeEnvironment.OLLAMA_MODEL, "nomic-embed-text:latest");
        assert.equal(result.runtimeEnvironment.OLLAMA_MODEL_DIGEST, DIGEST);
        assert.equal(result.runtimeEnvironment.EMBEDDING_OUTPUT_DIMENSION, "768");
        assert.equal(result.ollamaIdentity?.dimension, 768);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("offline install defaults to the integrity- and capability-verified bundled Potion runtime", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-potion-preflight-"));
    try {
        const result = await runInstallPreflight({
            runtime: "offline",
            homeDir,
            env: {},
            potionAssetsRoot: POTION_ASSETS_ROOT,
            platform: "linux",
            architecture: "x64",
        }, {
            probeLanceDb: async () => undefined,
            verifyPotionRuntime: (assetsRoot) => verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
        });

        assert.deepEqual(result.runtimeEnvironment, {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, ".satori", "vector", "lancedb"),
            EMBEDDING_PROVIDER: "Potion",
            EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
            EMBEDDING_OUTPUT_DIMENSION: "256",
            POTION_HELPER_PATH: path.join(POTION_ASSETS_ROOT, "satori-potion"),
            POTION_MODEL_PATH: path.join(POTION_ASSETS_ROOT, "model"),
            POTION_REQUEST_TIMEOUT_MS: "5000",
        });
        await verifyBundledPotionRuntime(POTION_ASSETS_ROOT, loadWorkspaceCore);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("offline install plan composes Potion embeddings with LateOn D32 reranking", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-preflight-"));
    const lateOnModelPath = path.join(homeDir, ".satori", "models", "lateon", "model");
    try {
        const result = await runInstallPreflight({
            runtime: "offline",
            homeDir,
            env: {},
            reranker: "lateon",
            lateOnModelPath,
            lateOnProfileId: LATEON_PROFILE_ID,
            lateOnActivationPolicy: LATEON_ACTIVATION_POLICY,
            potionAssetsRoot: POTION_ASSETS_ROOT,
            platform: "linux",
            architecture: "x64",
        }, {
            probeLanceDb: async () => undefined,
            verifyPotionRuntime: (assetsRoot) => verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
        });

        assert.equal(result.runtimeEnvironment.EMBEDDING_PROVIDER, "Potion");
        assert.equal(result.runtimeEnvironment.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(result.runtimeEnvironment.SATORI_LATEON_MODEL_PATH, lateOnModelPath);
        assert.equal(
            result.runtimeEnvironment.SATORI_LATEON_PROFILE,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
        assert.equal(
            result.runtimeEnvironment.SATORI_LATEON_ACTIVATION_POLICY,
            "lateon_context_v5_d32_owner_default_v1",
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("bundled Potion verification rejects a modified provenance manifest", async () => {
    const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-potion-manifest-"));
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(POTION_ASSETS_ROOT, "manifest.json"), "utf8"));
        manifest.helper.rustToolchain = "untrusted-toolchain";
        fs.writeFileSync(path.join(assetsRoot, "manifest.json"), JSON.stringify(manifest), "utf8");
        await assert.rejects(
            verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
            /missing, invalid, or untrusted/,
        );
    } finally {
        fs.rmSync(assetsRoot, { recursive: true, force: true });
    }
});

test("bundled Potion verification rejects missing artifact when manifest is valid", async () => {
    const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-potion-valid-manifest-"));
    try {
        // Copy the exact valid manifest file
        fs.copyFileSync(
            path.join(POTION_ASSETS_ROOT, "manifest.json"),
            path.join(assetsRoot, "manifest.json"),
        );
        // Do not create the files or create a truncated artifact
        await assert.rejects(
            verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
            /missing|regular file|failed checksum/i,
        );
    } finally {
        fs.rmSync(assetsRoot, { recursive: true, force: true });
    }
});

test("new offline install persists Potion embeddings and LateOn D32 in the managed launcher", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-potion-install-"));
    const fixture = fixtureLateOnRuntime(homeDir);
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            potionAssetsRoot: POTION_ASSETS_ROOT,
            runtimeCommand: fixture.runtimeCommand,
            fetchImpl: fixture.fetchImpl,
            preflightDependencies: {
                probeLanceDb: async () => undefined,
                verifyPotionRuntime: (assetsRoot) => verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        );
        assert.equal(launcherEnvironment.EMBEDDING_PROVIDER, "Potion");
        assert.equal(launcherEnvironment.EMBEDDING_OUTPUT_DIMENSION, "256");
        assert.equal(launcherEnvironment.POTION_HELPER_PATH, path.join(POTION_ASSETS_ROOT, "satori-potion"));
        assert.equal(launcherEnvironment.POTION_MODEL_PATH, path.join(POTION_ASSETS_ROOT, "model"));
        assert.equal(launcherEnvironment.OLLAMA_MODEL, undefined);
        assert.equal(launcherEnvironment.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(
            launcherEnvironment.SATORI_LATEON_PROFILE,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
        assert.equal(
            launcherEnvironment.SATORI_LATEON_ACTIVATION_POLICY,
            "lateon_context_v5_d32_owner_default_v1",
        );
        const expectedModelDirectory = path.join(
            homeDir,
            ".satori",
            "models",
            "lateon",
            "LateOn-Code-edge@07ef20f406c86badca122464808f4cac2f6e4b25",
        );
        assert.equal(launcherEnvironment.SATORI_LATEON_MODEL_PATH, expectedModelDirectory);
        assert.equal(
            fs.readFileSync(path.join(expectedModelDirectory, "model.onnx"), "utf8"),
            "model",
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("offline install persists an explicit reranker opt-out", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-no-reranker-install-"));
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            reranker: "none",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            potionAssetsRoot: POTION_ASSETS_ROOT,
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async () => undefined,
                verifyPotionRuntime: (assetsRoot) => verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        );
        assert.equal(launcherEnvironment.SATORI_RERANKER_PROVIDER, "none");
        assert.equal(launcherEnvironment.SATORI_LATEON_MODEL_PATH, undefined);
        assert.equal(launcherEnvironment.SATORI_LATEON_PROFILE, undefined);
        assert.equal(launcherEnvironment.SATORI_LATEON_ACTIVATION_POLICY, undefined);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("managed offline install acquires the pinned LateOn closure before activation", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-install-"));
    const artifacts = {
        "model.onnx": "model",
        "tokenizer.json": "tokenizer",
    };
    const execFileSyncImpl = ((_command: string, args: string[]) => {
        const runtimeRoot = args[args.indexOf("--prefix") + 1];
        const mcpRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
        const coreRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-core");
        fs.mkdirSync(path.join(mcpRoot, "dist"), { recursive: true });
        fs.mkdirSync(coreRoot, { recursive: true });
        fs.writeFileSync(path.join(mcpRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "0.0.0-lateon-test",
            bin: { satori: "dist/index.js" },
        }), "utf8");
        fs.writeFileSync(path.join(mcpRoot, "dist", "index.js"), "", "utf8");
        fs.writeFileSync(path.join(coreRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            version: "0.0.0-core-test",
        }), "utf8");
        writeLateOnAcquisitionFixture(mcpRoot, artifacts);
        return "";
    }) as never;

    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-lateon-test",
            platform: "linux",
            architecture: "x64",
            execFileSyncImpl,
            fetchImpl: (async (input: string | URL | Request) => {
                const name = String(input).slice(String(input).lastIndexOf("/") + 1) as keyof typeof artifacts;
                return new Response(artifacts[name], { status: 200 });
            }) as typeof fetch,
            preflightRunner: async (input) => {
                assert.equal(input.reranker, "lateon");
                assert.equal(fs.readFileSync(path.join(input.lateOnModelPath!, "model.onnx"), "utf8"), "model");
                return { runtimeEnvironment: planInstallRuntimeEnvironment(input) };
            },
            preflightDependencies: {
                probeCandidateRuntime: async () => undefined,
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        );
        assert.equal(launcherEnvironment.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(
            launcherEnvironment.SATORI_LATEON_ACTIVATION_POLICY,
            "lateon_context_v5_d32_owner_default_v1",
        );
        assert.equal(fs.existsSync(launcherEnvironment.SATORI_LATEON_MODEL_PATH), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("Potion default fails before artifact verification on unsupported platforms", async () => {
    let verificationCalls = 0;
    await assert.rejects(
        runInstallPreflight({
            runtime: "offline",
            homeDir: "/tmp/satori-potion-unsupported",
            env: {},
            potionAssetsRoot: "/tmp/potion-assets",
            platform: "darwin",
            architecture: "arm64",
        }, {
            probeLanceDb: async () => undefined,
            verifyPotionRuntime: async () => { verificationCalls += 1; },
        }),
        /supports Linux x64/,
    );
    assert.equal(verificationCalls, 0);
});

test("unsupported Potion platform fails before managed package installation", async () => {
    let installCalls = 0;
    await assert.rejects(executeInstallCommand({
        kind: "install",
        client: "codex",
        dryRun: false,
        runtime: "offline",
    }, {
        homeDir: "/tmp/satori-potion-unsupported-install",
        env: {},
        packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
        platform: "darwin",
        architecture: "arm64",
        execFileSyncImpl: (() => {
            installCalls += 1;
            return "";
        }) as never,
    }), /supports Linux x64/);
    assert.equal(installCalls, 0);
});

test("the real LanceDB preflight proves FTS and dense reads after reopen", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-preflight-"));
    try {
        await probeLanceDbRuntime(path.join(homeDir, ".satori", "vector", "lancedb"), {
            loadLanceDb: async () => {
                const { LanceDbVectorDatabase } = await import("../../core/src/vectordb/lancedb-vectordb.js");
                return { LanceDbVectorDatabase };
            },
        });
        assert.equal(fs.existsSync(path.join(homeDir, ".satori")), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("LanceDB preflight rejects unsafe exact target paths without loading native code", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-path-shape-"));
    const filePath = path.join(homeDir, "lancedb");
    const symlinkPath = path.join(homeDir, "lancedb-link");
    fs.writeFileSync(filePath, "not a database", "utf8");
    fs.symlinkSync(homeDir, symlinkPath);
    let nativeLoads = 0;
    const dependencies = {
        loadLanceDb: async () => {
            nativeLoads += 1;
            throw new Error("native loader must not run");
        },
    };
    try {
        await assert.rejects(probeLanceDbRuntime(filePath, dependencies), /must be a directory/);
        await assert.rejects(probeLanceDbRuntime(symlinkPath, dependencies), /must not be a symbolic link/);
        assert.equal(nativeLoads, 0);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("LanceDB capability operations run on the configured target filesystem", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-target-filesystem-"));
    const databasePath = path.join(homeDir, ".satori", "vector", "lancedb");
    const constructedPaths: string[] = [];
    class FakeLanceDb {
        constructor(config: { databasePath: string }) {
            constructedPaths.push(config.databasePath);
        }
        async createHybridCollection() {}
        async writeDocuments() {}
        async finalizeCollectionForSearch() {}
        async retrieveDense() { return [{ document: { id: "preflight_document" } }]; }
        async retrieveLexical() { return [{ document: { id: "preflight_document" } }]; }
        async dropCollection() {}
        async listCollections() { return []; }
        async close() {}
    }
    try {
        await probeLanceDbRuntime(databasePath, {
            loadLanceDb: async () => ({ LanceDbVectorDatabase: FakeLanceDb }) as never,
        });
        assert.equal(constructedPaths.length, 2);
        assert.equal(constructedPaths.every((candidate) => candidate.startsWith(`${homeDir}${path.sep}`)), true);
        assert.equal(constructedPaths.every((candidate) => path.basename(candidate).startsWith(".satori-install-preflight-")), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("an existing LanceDB target is inspected but never contains the synthetic probe database", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-existing-target-"));
    const databasePath = path.join(homeDir, "lancedb");
    fs.mkdirSync(databasePath);
    const constructedPaths: string[] = [];
    class FakeLanceDb {
        constructor(config: { databasePath: string }) {
            constructedPaths.push(config.databasePath);
        }
        async createHybridCollection() {}
        async writeDocuments() {}
        async finalizeCollectionForSearch() {}
        async retrieveDense() { return [{ document: { id: "preflight_document" } }]; }
        async retrieveLexical() { return [{ document: { id: "preflight_document" } }]; }
        async dropCollection() {}
        async listCollections() { return []; }
        async close() {}
    }
    try {
        await probeLanceDbRuntime(databasePath, {
            loadLanceDb: async () => ({ LanceDbVectorDatabase: FakeLanceDb }) as never,
        });
        assert.equal(constructedPaths.length, 3);
        assert.equal(constructedPaths[2], databasePath);
        assert.equal(constructedPaths.slice(0, 2).every((candidate) => (
            path.dirname(candidate) === homeDir
            && !candidate.startsWith(`${databasePath}${path.sep}`)
        )), true);
        assert.deepEqual(fs.readdirSync(databasePath), []);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

for (const currentPath of [undefined, ""] as const) {
test(`connected reinstall preserves a managed custom LanceDB path when the shell supplies ${currentPath === undefined ? "no value" : "an empty value"}`, async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-path-reinstall-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const databasePath = path.join(homeDir, "custom", "lancedb");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: databasePath,
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "voyage-code-3",
            EMBEDDING_OUTPUT_DIMENSION: "1024",
        },
    }), "utf8");
    const probedPaths: string[] = [];
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: currentPath === undefined ? {} : { LANCEDB_PATH: currentPath },
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/new-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async (candidate) => { probedPaths.push(candidate); },
            },
        });

        assert.deepEqual(probedPaths, [databasePath]);
        assert.equal(result.runtimeEnvironment?.LANCEDB_PATH, databasePath);
        assert.equal(parseManagedLauncherEnvironment(
            fs.readFileSync(launcherPath, "utf8"),
        ).LANCEDB_PATH, databasePath);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});
}

for (const currentValues of [
    {},
    { LANCEDB_PATH: "", OLLAMA_HOST: "   " },
] as const) {
test(`offline reinstall preserves managed LanceDB and Ollama endpoints with ${"LANCEDB_PATH" in currentValues ? "blank" : "absent"} shell values`, async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-path-reinstall-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const databasePath = path.join(homeDir, "custom", "offline-lancedb");
    const ollamaHost = "http://localhost:11435";
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: databasePath,
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: "nomic-embed-text:latest",
            OLLAMA_MODEL_DIGEST: DIGEST,
            EMBEDDING_OUTPUT_DIMENSION: "768",
            OLLAMA_HOST: ollamaHost,
        },
    }), "utf8");
    const probedPaths: string[] = [];
    const fixture = fixtureLateOnRuntime(homeDir);
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            ollamaModel: "nomic-embed-text",
        }, {
            homeDir,
            env: currentValues,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: fixture.runtimeCommand,
            fetchImpl: fixture.fetchImpl,
            preflightDependencies: {
                probeLanceDb: async (candidate) => { probedPaths.push(candidate); },
                resolveOllamaIdentity: async ({ host }) => {
                    assert.equal(host, ollamaHost);
                    return Object.freeze({
                        configuredModel: "nomic-embed-text",
                        resolvedModel: "nomic-embed-text:latest",
                        artifactDigest: DIGEST,
                        artifactSize: 42,
                        dimension: 768,
                    });
                },
            },
        });

        assert.deepEqual(probedPaths, [databasePath]);
        assert.equal(result.runtimeEnvironment?.LANCEDB_PATH, databasePath);
        assert.equal(result.runtimeEnvironment?.OLLAMA_HOST, ollamaHost);
        const launcherEnvironment = parseManagedLauncherEnvironment(fs.readFileSync(launcherPath, "utf8"));
        assert.equal(launcherEnvironment.LANCEDB_PATH, databasePath);
        assert.equal(launcherEnvironment.OLLAMA_HOST, ollamaHost);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});
}

test("offline reinstall without a model preserves an existing managed Ollama selection", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-ollama-preserve-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, "lancedb"),
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: "nomic-embed-text:latest",
            OLLAMA_MODEL_DIGEST: DIGEST,
            EMBEDDING_OUTPUT_DIMENSION: "768",
            OLLAMA_HOST: "http://localhost:11434",
        },
    }), "utf8");
    let selectedModel: string | undefined;
    const fixture = fixtureLateOnRuntime(homeDir);
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
        }, {
            homeDir,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: fixture.runtimeCommand,
            fetchImpl: fixture.fetchImpl,
            preflightRunner: async (input) => {
                selectedModel = input.ollamaModel;
                return {
                    runtimeEnvironment: Object.freeze({
                        SATORI_RUNTIME_PROFILE: "offline",
                        VECTOR_STORE_PROVIDER: "LanceDB",
                        EMBEDDING_PROVIDER: "Ollama",
                        OLLAMA_MODEL: input.ollamaModel || "",
                        OLLAMA_MODEL_DIGEST: DIGEST,
                    }),
                };
            },
        });

        assert.equal(selectedModel, "nomic-embed-text:latest");
        assert.equal(result.runtimeEnvironment?.EMBEDDING_PROVIDER, "Ollama");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("new Potion offline install rejects a conflicting ambient provider", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-potion-conflict-"));
    try {
        await assert.rejects(executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: { EMBEDDING_PROVIDER: "VoyageAI" },
        }), /conflicts with the Potion offline installation selection/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

function writeHistoricalD16Launcher(homeDir: string): string {
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, "lancedb"),
            EMBEDDING_PROVIDER: "Potion",
            SATORI_RERANKER_PROVIDER: "lateon",
            SATORI_LATEON_PROFILE: "lateon_projection_v2_d16_v1",
            SATORI_LATEON_MODEL_PATH: path.join(homeDir, "lateon-d16-model"),
        },
    }), "utf8");
    return launcherPath;
}

test("managed D16 + env provider lateon without a CLI flag rejects with migration guidance", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-d16-env-migration-"));
    try {
        writeHistoricalD16Launcher(homeDir);
        await assert.rejects(executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: { SATORI_RERANKER_PROVIDER: "lateon" },
            platform: "linux",
            architecture: "x64",
        }), /Existing managed LateOn installation uses profile lateon_projection_v2_d16_v1, which is treated as historical D16\. Run `npx -y @zokizuan\/satori-cli@latest install --runtime offline --reranker lateon` to migrate to D32, or `npx -y @zokizuan\/satori-cli@latest install --runtime offline --reranker none` to disable LateOn\./);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("managed D16 + env provider none without a CLI flag rejects with migration guidance", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-d16-env-disable-"));
    try {
        writeHistoricalD16Launcher(homeDir);
        await assert.rejects(executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: { SATORI_RERANKER_PROVIDER: "none" },
            platform: "linux",
            architecture: "x64",
        }), /Existing managed LateOn installation uses profile lateon_projection_v2_d16_v1, which is treated as historical D16\. Run `npx -y @zokizuan\/satori-cli@latest install --runtime offline --reranker lateon` to migrate to D32, or `npx -y @zokizuan\/satori-cli@latest install --runtime offline --reranker none` to disable LateOn\./);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("managed D16 + CLI --reranker lateon migrates to D32", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-d16-cli-migrate-"));
    const launcherPath = writeHistoricalD16Launcher(homeDir);
    writeLateOnModelDirectory(path.join(homeDir, "lateon-d16-model"));
    const fixture = fixtureLateOnRuntime(homeDir);
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            reranker: "lateon",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            potionAssetsRoot: POTION_ASSETS_ROOT,
            runtimeCommand: fixture.runtimeCommand,
            fetchImpl: fixture.fetchImpl,
            preflightDependencies: {
                probeLanceDb: async () => undefined,
                verifyPotionRuntime: (assetsRoot) => verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(launcherPath, "utf8"),
        );
        assert.equal(launcherEnvironment.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(
            launcherEnvironment.SATORI_LATEON_PROFILE,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
        assert.equal(
            launcherEnvironment.SATORI_LATEON_ACTIVATION_POLICY,
            "lateon_context_v5_d32_owner_default_v1",
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("managed D16 + CLI --reranker none disables LateOn", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-d16-cli-disable-"));
    const launcherPath = writeHistoricalD16Launcher(homeDir);
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            reranker: "none",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            potionAssetsRoot: POTION_ASSETS_ROOT,
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async () => undefined,
                verifyPotionRuntime: (assetsRoot) => verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(launcherPath, "utf8"),
        );
        assert.equal(launcherEnvironment.SATORI_RERANKER_PROVIDER, "none");
        assert.equal(launcherEnvironment.SATORI_LATEON_PROFILE, undefined);
        assert.equal(launcherEnvironment.SATORI_LATEON_MODEL_PATH, undefined);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("managed D16 without CLI or environment rejects with migration guidance", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-d16-noflag-"));
    try {
        writeHistoricalD16Launcher(homeDir);
        await assert.rejects(executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            platform: "linux",
            architecture: "x64",
        }), /Existing managed LateOn installation uses profile lateon_projection_v2_d16_v1, which is treated as historical D16\./);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("Linux x64 with implicit Potion defaults to LateOn D32", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-matrix-potion-d32-"));
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            platform: "linux",
            architecture: "x64",
        });
        assert.equal(result.runtimeEnvironment?.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(
            result.runtimeEnvironment?.SATORI_LATEON_PROFILE,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("Linux x64 with implicit Ollama defaults to LateOn D32", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-matrix-ollama-d32-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: "nomic-embed-text:latest",
            OLLAMA_MODEL_DIGEST: DIGEST,
            EMBEDDING_OUTPUT_DIMENSION: "768",
            OLLAMA_HOST: "http://localhost:11434",
        },
    }), "utf8");
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            platform: "linux",
            architecture: "x64",
        });
        assert.equal(result.runtimeEnvironment?.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(
            result.runtimeEnvironment?.SATORI_LATEON_PROFILE,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
        assert.equal(result.runtimeEnvironment?.OLLAMA_MODEL, "nomic-embed-text:latest");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("non-Linux-x64 with implicit Ollama defaults to no reranker", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-matrix-ollama-none-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: "nomic-embed-text:latest",
            OLLAMA_MODEL_DIGEST: DIGEST,
            EMBEDDING_OUTPUT_DIMENSION: "768",
            OLLAMA_HOST: "http://localhost:11434",
        },
    }), "utf8");
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            platform: "darwin",
            architecture: "arm64",
        });
        assert.equal(result.runtimeEnvironment?.SATORI_RERANKER_PROVIDER, "none");
        assert.equal(result.runtimeEnvironment?.SATORI_LATEON_PROFILE, undefined);
        assert.equal(result.runtimeEnvironment?.OLLAMA_MODEL, "nomic-embed-text:latest");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("non-Linux-x64 with explicit lateon rejects", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-matrix-lateon-platform-"));
    try {
        await assert.rejects(executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
            reranker: "lateon",
        }, {
            homeDir,
            env: {},
            platform: "darwin",
            architecture: "arm64",
        }), /LateOn D32 is supported only on Linux x64\/WSL2; received darwin arm64/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("existing managed none stays none", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-matrix-none-stays-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            EMBEDDING_PROVIDER: "Potion",
            SATORI_RERANKER_PROVIDER: "none",
        },
    }), "utf8");
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            platform: "linux",
            architecture: "x64",
        });
        assert.equal(result.runtimeEnvironment?.SATORI_RERANKER_PROVIDER, "none");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("existing managed D32 stays D32", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-matrix-d32-stays-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            EMBEDDING_PROVIDER: "Potion",
            SATORI_RERANKER_PROVIDER: "lateon",
            SATORI_LATEON_PROFILE: "lateon_offline_quality_projection_v3_d32_v1",
        },
    }), "utf8");
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            platform: "linux",
            architecture: "x64",
        });
        assert.equal(result.runtimeEnvironment?.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(
            result.runtimeEnvironment?.SATORI_LATEON_PROFILE,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
        assert.equal(
            result.runtimeEnvironment?.SATORI_LATEON_ACTIVATION_POLICY,
            "lateon_context_v5_d32_owner_default_v1",
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("--reranker none performs zero LateOn fetch calls", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-zero-fetch-"));
    let fetchCalls = 0;
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            reranker: "none",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            potionAssetsRoot: POTION_ASSETS_ROOT,
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            fetchImpl: (async () => {
                fetchCalls += 1;
                throw new Error("fetch must not be invoked");
            }) as typeof fetch,
            preflightDependencies: {
                probeLanceDb: async () => undefined,
                verifyPotionRuntime: (assetsRoot) => verifyBundledPotionRuntime(assetsRoot, loadWorkspaceCore),
            },
        });
        assert.equal(fetchCalls, 0);
        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        );
        assert.equal(launcherEnvironment.SATORI_RERANKER_PROVIDER, "none");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected reinstall reads a literal Milvus selection from Codex config", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-client-selection-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
        "[mcp_servers.satori.env]",
        'VECTOR_STORE_PROVIDER = "Milvus"',
        'MILVUS_ADDRESS = "https://milvus.example.test"',
        "",
    ].join("\n"), "utf8");
    let lanceDbProbeCalls = 0;
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async () => {
                    lanceDbProbeCalls += 1;
                },
            },
        });

        assert.equal(lanceDbProbeCalls, 0);
        assert.equal(result.runtimeEnvironment?.VECTOR_STORE_PROVIDER, "Milvus");
        assert.equal(parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        ).VECTOR_STORE_PROVIDER, "Milvus");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected reinstall rejects launcher and client backend disagreement", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-selection-conflict-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(configPath, [
        "[mcp_servers.satori.env]",
        'VECTOR_STORE_PROVIDER = "Milvus"',
        "",
    ].join("\n"), "utf8");
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/satori-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
        },
    }), "utf8");
    try {
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: true,
                runtime: "voyage",
            }, { homeDir, env: {} }),
            /installer environment, managed launcher, and configured Satori clients disagree/,
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected backend discovery includes configured clients outside --client", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-global-client-selection-"));
    const claudePath = path.join(homeDir, ".claude.json");
    fs.writeFileSync(claudePath, JSON.stringify({
        mcpServers: {
            satori: {
                command: "node",
                args: ["/tmp/satori.js"],
                env: { VECTOR_STORE_PROVIDER: "Milvus" },
            },
        },
    }), "utf8");
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "voyage",
        }, { homeDir, env: {} });
        assert.equal(result.runtimeEnvironment?.VECTOR_STORE_PROVIDER, "Milvus");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("ambient backend values cannot suppress launcher and client disagreement", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-ambient-conflict-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(configPath, [
        "[mcp_servers.satori.env]",
        'VECTOR_STORE_PROVIDER = "Milvus"',
        "",
    ].join("\n"), "utf8");
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/satori-runtime.js"],
        managedEnv: { VECTOR_STORE_PROVIDER: "LanceDB" },
    }), "utf8");
    try {
        for (const value of ["LanceDB", "Milvus"] as const) {
            await assert.rejects(executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: true,
                runtime: "voyage",
            }, {
                homeDir,
                env: { VECTOR_STORE_PROVIDER: value },
            }), /installer environment, managed launcher, and configured Satori clients disagree/);
        }
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("programmatic offline installs reject a contradictory Milvus backend", async () => {
    const command = {
        kind: "install",
        client: "codex",
        dryRun: true,
        runtime: "offline",
        vectorStore: "Milvus",
        ollamaModel: "nomic-embed-text",
    } as unknown as InstallCommandInput;
    await assert.rejects(
        executeInstallCommand(command, { homeDir: "/tmp/satori-offline-invalid", env: {} }),
        /Offline install requires --vector-store lancedb/,
    );
});

test("install reads mutable client configuration after awaited preflight", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-install-preflight-race-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model = "before"\n', "utf8");
    let releasePreflight!: () => void;
    const preflightPending = new Promise<void>((resolve) => {
        releasePreflight = resolve;
    });
    try {
        const installation = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightRunner: async () => {
                await preflightPending;
                return {
                    runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
                };
            },
        });
        fs.writeFileSync(configPath, 'model = "changed-during-preflight"\n', "utf8");
        releasePreflight();
        await installation;

        assert.match(fs.readFileSync(configPath, "utf8"), /changed-during-preflight/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("rejected runtime preflight leaves managed client files byte-for-byte unchanged", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-rejected-preflight-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const original = 'model = "gpt-5"\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original, "utf8");
    try {
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: false,
                runtime: "voyage",
            }, {
                homeDir,
                packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
                runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
                preflightRunner: async () => {
                    throw new Error("native load rejected");
                },
            }),
            /native load rejected/,
        );
        assert.equal(fs.readFileSync(configPath, "utf8"), original);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori")), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("successful offline install persists its non-secret identity in the shared launcher", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-install-"));
    const fixture = fixtureLateOnRuntime(homeDir);
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            ollamaModel: "nomic-embed-text",
        }, {
            homeDir,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: fixture.runtimeCommand,
            fetchImpl: fixture.fetchImpl,
            preflightRunner: async () => ({
                runtimeEnvironment: Object.freeze({
                    SATORI_RUNTIME_PROFILE: "offline",
                    VECTOR_STORE_PROVIDER: "LanceDB",
                    EMBEDDING_PROVIDER: "Ollama",
                    OLLAMA_MODEL: "nomic-embed-text:latest",
                    OLLAMA_MODEL_DIGEST: DIGEST,
                }),
            }),
        });

        const launcher = fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8");
        assert.match(launcher, /"SATORI_RUNTIME_PROFILE":"offline"/);
        assert.match(launcher, new RegExp(`"OLLAMA_MODEL_DIGEST":"${DIGEST}"`));
        assert.match(launcher, /const effectiveEnv = \{ \.\.\.process\.env, \.\.\.managedEnv \}/);
        assert.match(launcher, /env: effectiveEnv/);
        assert.equal(result.runtime, "offline");
        assert.equal(result.runtimeEnvironment?.OLLAMA_MODEL_DIGEST, DIGEST);
        assert.doesNotMatch(launcher, /VOYAGEAI_API_KEY/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

type ManagedLateOnSnapshot = {
    launcherPath: string;
    launcherBytes: Buffer;
    configPath: string;
    configBytes: Buffer;
    oldRuntimePath: string;
    oldRuntimeBytes: Buffer;
    modelsLateonDir: string;
};

function seedManagedLateOnInstallation(homeDir: string): ManagedLateOnSnapshot {
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const oldRuntimePath = path.join(homeDir, "old-runtime.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");
    fs.writeFileSync(oldRuntimePath, "// old managed runtime\n", "utf8");
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: [oldRuntimePath],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, "lancedb"),
            EMBEDDING_PROVIDER: "Potion",
            SATORI_RERANKER_PROVIDER: "lateon",
            SATORI_LATEON_PROFILE: "lateon_offline_quality_projection_v3_d32_v1",
        },
    }), "utf8");
    return {
        launcherPath,
        launcherBytes: fs.readFileSync(launcherPath),
        configPath,
        configBytes: fs.readFileSync(configPath),
        oldRuntimePath,
        oldRuntimeBytes: fs.readFileSync(oldRuntimePath),
        modelsLateonDir: path.join(homeDir, ".satori", "models", "lateon"),
    };
}

function assertManagedLateOnSnapshotUnchanged(snapshot: ManagedLateOnSnapshot): void {
    assert.deepEqual(fs.readFileSync(snapshot.launcherPath), snapshot.launcherBytes);
    assert.deepEqual(fs.readFileSync(snapshot.configPath), snapshot.configBytes);
    assert.deepEqual(fs.readFileSync(snapshot.oldRuntimePath), snapshot.oldRuntimeBytes);
    if (fs.existsSync(snapshot.modelsLateonDir)) {
        assert.deepEqual(
            fs.readdirSync(snapshot.modelsLateonDir)
                .filter((name) => name.startsWith(".lateon-install-")),
            [],
        );
    }
}

function failingOfflineLateOnReinstall(
    homeDir: string,
    failure: {
        fetchImpl?: typeof fetch;
        lateOnNowImpl?: () => number;
        removeAssets?: "all" | "acquisition";
    },
): Promise<unknown> {
    const fixture = fixtureLateOnRuntime(homeDir);
    if (failure.removeAssets === "all") {
        fs.rmSync(path.join(fixture.mcpRoot, "assets"), { recursive: true, force: true });
    } else if (failure.removeAssets === "acquisition") {
        fs.rmSync(
            path.join(
                fixture.mcpRoot,
                "assets",
                "lateon",
                "runtime-profile-v5-d32.acquisition.json",
            ),
            { force: true },
        );
    }
    return executeInstallCommand({
        kind: "install",
        client: "codex",
        dryRun: false,
        runtime: "offline",
    }, {
        homeDir,
        env: {},
        packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
        platform: "linux",
        architecture: "x64",
        runtimeCommand: fixture.runtimeCommand,
        ...(failure.fetchImpl ? { fetchImpl: failure.fetchImpl } : {}),
        ...(failure.lateOnNowImpl ? { lateOnNowImpl: failure.lateOnNowImpl } : {}),
    });
}

test("acquisition network failure leaves the managed installation byte-identical", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-network-"));
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        await assert.rejects(
            failingOfflineLateOnReinstall(homeDir, {
                fetchImpl: (async () => {
                    throw new Error("network down");
                }) as typeof fetch,
            }),
            /LateOn D32 model preflight failed: network down/,
        );
        assertManagedLateOnSnapshotUnchanged(snapshot);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("LateOn model acquisition runs while the managed-runtime mutation lock is held", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-lock-held-"));
    const mutationLockPath = path.join(homeDir, ".satori", "mcp-runtime", ".mutation.lock");
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        let acquisitionStarted!: () => void;
        let releaseAcquisition!: () => void;
        const started = new Promise<void>((resolve) => {
            acquisitionStarted = resolve;
        });
        const release = new Promise<void>((resolve) => {
            releaseAcquisition = resolve;
        });
        const reinstall = failingOfflineLateOnReinstall(homeDir, {
            fetchImpl: (async () => {
                acquisitionStarted();
                await release;
                throw new Error("network down");
            }) as typeof fetch,
        });

        await started;
        assert.equal(fs.existsSync(mutationLockPath), true);
        releaseAcquisition();
        await assert.rejects(reinstall, /LateOn D32 model preflight failed: network down/);
        assert.equal(fs.existsSync(mutationLockPath), false);
        assertManagedLateOnSnapshotUnchanged(snapshot);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("acquisition checksum failure leaves the managed installation byte-identical", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-checksum-"));
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        await assert.rejects(
            failingOfflineLateOnReinstall(homeDir, {
                fetchImpl: (async () => new Response("m0del", { status: 200 })) as typeof fetch,
            }),
            /failed checksum verification/,
        );
        assertManagedLateOnSnapshotUnchanged(snapshot);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("acquisition deadline failure leaves the managed installation byte-identical", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-deadline-"));
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        let nowCalls = 0;
        await assert.rejects(
            failingOfflineLateOnReinstall(homeDir, {
                lateOnNowImpl: () => {
                    nowCalls += 1;
                    return nowCalls === 1 ? 0 : 10 * 60 * 1000 + 1;
                },
                fetchImpl: (async () => new Promise<Response>(() => {})) as typeof fetch,
            }),
            /10-minute deadline/,
        );
        assertManagedLateOnSnapshotUnchanged(snapshot);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("acquisition size overflow leaves the managed installation byte-identical", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-size-"));
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        await assert.rejects(
            failingOfflineLateOnReinstall(homeDir, {
                fetchImpl: (async () => new Response("x".repeat(100), { status: 200 })) as typeof fetch,
            }),
            /exceeded its manifest size of 5 bytes/,
        );
        assertManagedLateOnSnapshotUnchanged(snapshot);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("missing runtime profile leaves the managed installation byte-identical", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-profile-"));
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        await assert.rejects(
            failingOfflineLateOnReinstall(homeDir, { removeAssets: "all" }),
            /must contain the frozen LateOn D32 profile and acquisition manifest/,
        );
        assertManagedLateOnSnapshotUnchanged(snapshot);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("missing acquisition manifest leaves the managed installation byte-identical", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-manifest-"));
    try {
        const snapshot = seedManagedLateOnInstallation(homeDir);
        await assert.rejects(
            failingOfflineLateOnReinstall(homeDir, { removeAssets: "acquisition" }),
            /must contain the frozen LateOn D32 profile and acquisition manifest/,
        );
        assertManagedLateOnSnapshotUnchanged(snapshot);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});
