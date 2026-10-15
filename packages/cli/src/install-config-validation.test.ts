import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeInstallCommand } from "./install.js";
import { parseCodexConfig } from "./codex-config.js";

test("invalid and custom Codex configs fail before runtime or model acquisition", async () => {
    for (const original of ['[mcp_servers.satori]\ncommand="node"\nargs=["/custom.js"]\n', '[mcp_servers.satori]\nargs=[']) {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-early-config-validation-"));
        const configPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, original);
        let acquisitionCalls = 0;
        try {
            await assert.rejects(executeInstallCommand({
                kind: "install", client: "codex", runtime: "offline", dryRun: false,
            }, {
                homeDir, env: {},
                execFileSyncImpl: (() => { acquisitionCalls++; throw new Error("unexpected runtime acquisition"); }) as never,
                fetchImpl: async () => { acquisitionCalls++; throw new Error("unexpected asset acquisition"); },
                onInstallProgress: () => { acquisitionCalls++; },
                preflightRunner: async () => { acquisitionCalls++; throw new Error("unexpected preflight"); },
            }), /unmanaged Satori config|Invalid TOML/);
            assert.equal(acquisitionCalls, 0);
            assert.equal(fs.readFileSync(configPath, "utf8"), original);
            assert.equal(fs.existsSync(path.join(homeDir, ".satori")), false);
        } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
    }
});

test("a custom command introduced during preflight is reread and protected", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-config-preflight-edit-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model="example"\n');
    const custom = '[mcp_servers.satori]\ncommand="node"\nargs=["/custom.js"]\n';
    try {
        await assert.rejects(executeInstallCommand({
            kind: "install", client: "codex", runtime: "voyage", dryRun: false,
        }, {
            homeDir, env: {}, runtimeCommand: { command: process.execPath, args: ["/fixture/runtime.js"] },
            preflightRunner: async () => {
                fs.writeFileSync(configPath, custom);
                return { runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }) };
            },
        }), /unmanaged Satori config/);
        assert.equal(fs.readFileSync(configPath, "utf8"), custom);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js")), false);
    } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test("install recovers a Codex-rewritten entry, preserves other servers, and is idempotent", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-config-recovery-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const launcher = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const unrelated = '\n[mcp_servers.other]\ncommand="keep"\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `[mcp_servers.satori]\ncommand="node"\nargs=[${JSON.stringify(launcher)}]\nstartup_timeout_sec=90\n${unrelated}# <<< satori-cli managed satori end <<<\n`);
    const command = { kind: "install" as const, client: "codex" as const, runtime: "voyage" as const, dryRun: false };
    const options = {
        homeDir, env: {}, runtimeCommand: { command: process.execPath, args: ["/fixture/runtime.js"] },
        preflightRunner: async () => ({ runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }) }),
    };
    try {
        const first = await executeInstallCommand(command, options);
        assert.equal(first.results[0]?.configChanged, true);
        const installed = fs.readFileSync(configPath, "utf8");
        assert.ok(installed.includes(unrelated));
        assert.equal(parseCodexConfig(installed).entry?.startup_timeout_sec, 90);
        assert.deepEqual(parseCodexConfig(installed).entry?.args, [launcher]);
        const second = await executeInstallCommand(command, options);
        assert.equal(second.results[0]?.configChanged, false);
        assert.equal(fs.readFileSync(configPath, "utf8"), installed);
    } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});
