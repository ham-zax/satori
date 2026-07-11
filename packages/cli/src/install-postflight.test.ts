import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeInstallCommand } from "./install.js";
import { runInstallPostflight, type InstallPostflightSession } from "./install-postflight.js";
import { CliError } from "./errors.js";

const TOOL_NAMES = [
    "manage_index",
    "search_codebase",
    "call_graph",
    "file_outline",
    "read_file",
    "list_codebases",
];

function writeOwnerRegistry(homeDir: string, owners: unknown[]): void {
    const filePath = path.join(homeDir, ".satori", "runtime", "owners.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ formatVersion: "v1", updatedAt: new Date(0).toISOString(), owners }), "utf8");
}

function installFixture(homeDir: string) {
    return executeInstallCommand({ kind: "install", client: "all", dryRun: false }, {
        homeDir,
        packageSpecifier: "@zokizuan/satori-mcp@4.11.17",
        runtimeCommand: { command: process.execPath, args: [path.join(homeDir, "runtime.js")] },
    });
}

function createSession(homeDir: string, names = TOOL_NAMES): InstallPostflightSession {
    writeOwnerRegistry(homeDir, [{
        ownerId: "postflight-owner",
        pid: 202,
        ppid: 101,
        satoriVersion: "4.11.17",
    }]);
    return {
        launcherPid: 101,
        serverVersion: { name: "satori", version: "4.11.17" },
        listTools: async () => ({ tools: names.map((name) => ({ name })) }) as never,
        close: async () => writeOwnerRegistry(homeDir, []),
    };
}

test("install postflight verifies launcher, clients, tools, owner, config, and termination", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-postflight-ok-"));
    try {
        const installResult = installFixture(homeDir);
        const result = await runInstallPostflight({
            installResult,
            homeDir,
            env: { EMBEDDING_PROVIDER: "Ollama", MILVUS_ADDRESS: "localhost:19530" },
            startupTimeoutMs: 1_000,
            callTimeoutMs: 1_000,
            writeStderr: () => {},
            connectSession: async ({ command, args, env }) => {
                assert.equal(command, process.execPath);
                assert.equal(args[0], path.join(homeDir, ".satori", "bin", "satori-mcp.js"));
                assert.equal(env.SATORI_RUN_MODE, "postflight");
                return createSession(homeDir);
            },
            isProcessLive: () => false,
            wait: async () => {},
        });

        assert.equal(result.status, "ok");
        assert.deepEqual(result.checks.map((check) => check.name), [
            "launcher",
            "client_configuration",
            "provider_configuration",
            "mcp_initialize",
            "tool_list",
            "runtime_owner",
            "termination",
        ]);
        assert.equal(result.checks.every((check) => check.status === "ok"), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("install postflight reports exact tool-list drift and still closes the session", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-postflight-tools-"));
    let closed = false;
    try {
        const installResult = installFixture(homeDir);
        const session = createSession(homeDir, TOOL_NAMES.slice(0, -1));
        const result = await runInstallPostflight({
            installResult,
            homeDir,
            env: { EMBEDDING_PROVIDER: "Ollama", MILVUS_ADDRESS: "localhost:19530" },
            startupTimeoutMs: 1_000,
            callTimeoutMs: 1_000,
            writeStderr: () => {},
            connectSession: async () => ({
                ...session,
                close: async () => {
                    closed = true;
                    await session.close();
                },
            }),
            isProcessLive: () => false,
            wait: async () => {},
        });

        assert.equal(result.status, "error");
        assert.equal(result.checks.find((check) => check.name === "tool_list")?.status, "error");
        assert.equal(closed, true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("install postflight preserves tool timeout code and proves owner cleanup", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-postflight-tool-timeout-"));
    try {
        const result = await runInstallPostflight({
            installResult: installFixture(homeDir),
            homeDir,
            env: { EMBEDDING_PROVIDER: "Ollama", MILVUS_ADDRESS: "localhost:19530" },
            startupTimeoutMs: 1_000,
            callTimeoutMs: 1_000,
            writeStderr: () => {},
            connectSession: async () => {
                const session = createSession(homeDir);
                return {
                    ...session,
                    listTools: async () => {
                        throw new CliError("E_CALL_TIMEOUT", "timed out", 3);
                    },
                };
            },
            isProcessLive: () => false,
            wait: async () => {},
        });

        const toolCheck = result.checks.find((check) => check.name === "tool_list");
        assert.equal(toolCheck?.status, "error");
        assert.equal(toolCheck?.code, "E_CALL_TIMEOUT");
        assert.equal(result.checks.find((check) => check.name === "termination")?.status, "ok");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("install postflight preserves startup timeout code and verifies launcher exit", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-postflight-startup-timeout-"));
    try {
        const result = await runInstallPostflight({
            installResult: installFixture(homeDir),
            homeDir,
            env: { EMBEDDING_PROVIDER: "Ollama", MILVUS_ADDRESS: "localhost:19530" },
            startupTimeoutMs: 1_000,
            callTimeoutMs: 1_000,
            writeStderr: () => {},
            connectSession: async (options) => {
                options.onLauncherStarted?.(303);
                throw new CliError("E_STARTUP_TIMEOUT", "timed out", 3);
            },
            isProcessLive: () => false,
            wait: async () => {},
        });

        const initializeCheck = result.checks.find((check) => check.name === "mcp_initialize");
        assert.equal(initializeCheck?.status, "error");
        assert.equal(initializeCheck?.code, "E_STARTUP_TIMEOUT");
        assert.equal(result.checks.find((check) => check.name === "termination")?.status, "ok");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("install postflight reports incomplete static config as a warning without provider calls", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-postflight-config-"));
    try {
        const result = await runInstallPostflight({
            installResult: installFixture(homeDir),
            homeDir,
            env: {},
            startupTimeoutMs: 1_000,
            callTimeoutMs: 1_000,
            writeStderr: () => {},
            connectSession: async () => createSession(homeDir),
            isProcessLive: () => false,
            wait: async () => {},
        });

        assert.equal(result.status, "warning");
        assert.equal(result.checks.find((check) => check.name === "provider_configuration")?.status, "warning");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});
