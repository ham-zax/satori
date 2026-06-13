import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeInstallCommand } from "./install.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = JSON.parse(
    fs.readFileSync(path.resolve(PACKAGE_ROOT, "..", "mcp", "package.json"), "utf8")
) as { name: string; version: string; bin?: Record<string, string> };
const EXPECTED_PACKAGE_SPECIFIER = `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}`;

function fakeRuntimeCommand(homeDir: string) {
    return {
        command: process.execPath,
        args: [
            path.join(
                homeDir,
                ".satori",
                "mcp-runtime",
                "@zokizuan-satori-mcp-4.10.1",
                "node_modules",
                "@zokizuan",
                "satori-mcp",
                "dist",
                "index.js"
            )
        ],
    };
}

function fakeClientCommand(homeDir: string) {
    return {
        command: process.execPath,
        args: [path.join(homeDir, ".satori", "bin", "satori-mcp.js")],
    };
}

function launcherPath(homeDir: string): string {
    return path.join(homeDir, ".satori", "bin", "satori-mcp.js");
}

function installOptions(homeDir: string) {
    return {
        homeDir,
        runtimeCommand: fakeRuntimeCommand(homeDir),
    };
}

function withTempHome(run: (homeDir: string) => void): void {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-install-"));
    try {
        run(homeDir);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
}

function readFile(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
}

function installRuntimePackageStub(relativeEntry: string) {
    return (command: string, args: string[]) => {
        assert.equal(command, "npm");
        const prefixIndex = args.indexOf("--prefix");
        assert.notEqual(prefixIndex, -1);
        const runtimeRoot = args[prefixIndex + 1];
        assert.equal(typeof runtimeRoot, "string");
        const packageRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
        const entryPath = path.join(packageRoot, relativeEntry);
        fs.mkdirSync(path.dirname(entryPath), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            bin: {
                satori: relativeEntry,
            },
        }, null, 2), "utf8");
        fs.writeFileSync(entryPath, "#!/usr/bin/env node\n", "utf8");
        return "";
    };
}

test("install writes managed Codex config block and copies packaged skill", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(codexConfigPath, 'model = "gpt-5"\n', "utf8");

        const result = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, installOptions(homeDir));

        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.client, "codex");
        assert.equal(result.results[0]?.status, "updated");
        const content = readFile(codexConfigPath);
        assert.equal(content.includes("[mcp_servers.satori]"), true);
        assert.equal(content.includes(`command = "${process.execPath.replace(/\\/g, "\\\\")}"`), true);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(content.includes("node_modules"), false);
        assert.equal(content.includes("dist/index.js"), false);
        assert.equal(content.includes('command = "npx"'), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
        assert.equal(content.includes(EXPECTED_PACKAGE_SPECIFIER), false);
        assert.equal(fs.existsSync(launcherPath(homeDir)), true);
        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes('require("node:child_process")'), true);
        assert.equal(launcher.includes("import { spawn }"), false);
        assert.equal(launcher.includes("node_modules"), true);
        assert.equal(launcher.includes("dist/index.js"), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori-search")), false);
    });
});

test("install writes the actual installed runtime bin path into the stable launcher", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });

        executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
            execFileSyncImpl: installRuntimePackageStub("custom/server.mjs") as never,
        });

        const content = readFile(codexConfigPath);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(content.includes("custom/server.mjs"), false);
        assert.equal(content.includes("dist/index.js"), false);
        assert.equal(content.includes('command = "npx"'), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes("custom/server.mjs"), true);
    });
});

test("managed MCP package exposes a single satori bin for npx package execution", () => {
    assert.deepEqual(PACKAGE_JSON.bin, {
        satori: "dist/index.js",
    });
});

test("install is idempotent for managed Codex config", () => {
    withTempHome((homeDir) => {
        executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, installOptions(homeDir));

        const second = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, installOptions(homeDir));

        assert.equal(second.results[0]?.configChanged, false);
        assert.equal(second.results[0]?.skillsChanged, false);
        assert.equal(second.results[0]?.status, "unchanged");
    });
});

test("install replaces an existing managed Codex block", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "# >>> satori-cli managed satori start >>>",
                "[mcp_servers.satori]",
                'command = "old-managed-satori"',
                'args = ["old"]',
                "startup_timeout_ms = 180000",
                "# <<< satori-cli managed satori end <<<",
                "",
            ].join("\n"),
            "utf8"
        );

        executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, installOptions(homeDir));

        const content = readFile(codexConfigPath);
        assert.equal(content.includes(`command = "${process.execPath.replace(/\\/g, "\\\\")}"`), true);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(content.includes("node_modules"), false);
        assert.equal(content.includes("old-managed-satori"), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
    });
});

test("uninstall removes an existing managed Codex block", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "# >>> satori-cli managed satori start >>>",
                "[mcp_servers.satori]",
                `command = "${process.execPath.replace(/\\/g, "\\\\")}"`,
                `args = ["${launcherPath(homeDir).replace(/\\/g, "\\\\")}"]`,
                "# <<< satori-cli managed satori end <<<",
                "",
            ].join("\n"),
            "utf8"
        );

        executeInstallCommand({
            kind: "uninstall",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        const content = readFile(codexConfigPath);
        assert.equal(content.includes("[mcp_servers.satori]"), false);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), false);
    });
});

test("install refuses to overwrite unmanaged Codex Satori sections", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "[mcp_servers.satori]",
                'command = "node"',
                'args = ["/custom/satori.js"]',
                "",
            ].join("\n"),
            "utf8"
        );

        assert.throws(
            () => executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: false,
            }, installOptions(homeDir)),
            /Refusing to overwrite unmanaged Satori config/
        );
    });
});

test("install merges Claude JSON config and uninstall removes only Satori-owned entry and skills", () => {
    withTempHome((homeDir) => {
        const settingsPath = path.join(homeDir, ".claude", "settings.json");
        const skillsDir = path.join(homeDir, ".claude", "skills");
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.mkdirSync(path.join(skillsDir, "custom-skill"), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, "custom-skill", "SKILL.md"), "# custom\n", "utf8");
        fs.writeFileSync(settingsPath, JSON.stringify({
            env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
            mcpServers: {
                existing: {
                    command: "npx",
                    args: ["-y", "@example/other-server@latest"],
                }
            }
        }, null, 2), "utf8");

        executeInstallCommand({
            kind: "install",
            client: "claude",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(settingsPath));
        assert.equal(installed.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
        assert.equal(installed.mcpServers.existing.command, "npx");
        assert.equal(installed.mcpServers.satori.command, process.execPath);
        assert.deepEqual(installed.mcpServers.satori.args, fakeClientCommand(homeDir).args);
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori, "timeout"), false);
        assert.equal(fs.existsSync(path.join(skillsDir, "satori", "SKILL.md")), true);

        const uninstall = executeInstallCommand({
            kind: "uninstall",
            client: "claude",
            dryRun: false,
        }, { homeDir });

        assert.equal(uninstall.results[0]?.status, "updated");
        const removed = JSON.parse(readFile(settingsPath));
        assert.equal(Boolean(removed.mcpServers.satori), false);
        assert.equal(removed.mcpServers.existing.command, "npx");
        assert.equal(fs.existsSync(path.join(skillsDir, "custom-skill", "SKILL.md")), true);
        assert.equal(fs.existsSync(path.join(skillsDir, "satori")), false);
    });
});

test("install refuses to overwrite unmanaged Claude Satori entries", () => {
    withTempHome((homeDir) => {
        const settingsPath = path.join(homeDir, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify({
            mcpServers: {
                satori: {
                    command: "node",
                    args: ["/custom/satori.js"],
                    timeout: 180000,
                }
            }
        }, null, 2), "utf8");

        assert.throws(
            () => executeInstallCommand({
                kind: "install",
                client: "claude",
                dryRun: false,
            }, installOptions(homeDir)),
            /Refusing to overwrite unmanaged Satori config/
        );
    });
});

test("uninstall refuses to remove unmanaged Claude Satori entries", () => {
    withTempHome((homeDir) => {
        const settingsPath = path.join(homeDir, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const original = JSON.stringify({
            mcpServers: {
                satori: {
                    command: "node",
                    args: ["/custom/satori.js"],
                    timeout: 180000,
                }
            }
        }, null, 2);
        fs.writeFileSync(settingsPath, original, "utf8");

        assert.throws(
            () => executeInstallCommand({
                kind: "uninstall",
                client: "claude",
                dryRun: false,
            }, { homeDir }),
            /Refusing to remove unmanaged Satori config/
        );

        assert.equal(readFile(settingsPath).trim(), original.trim());
    });
});

test("install writes OpenCode JSONC config and AGENTS instructions", () => {
    withTempHome((homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, [
            "{",
            "  // keep this comment",
            "  \"mcp\": {",
            "    \"existing\": {",
            "      \"enabled\": true,",
            "      \"type\": \"local\",",
            "      \"command\": [\"other-server\"]",
            "    }",
            "  }",
            "}",
            "",
        ].join("\n"), "utf8");

        const result = executeInstallCommand({
            kind: "install",
            client: "opencode",
            dryRun: false,
        }, installOptions(homeDir));

        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.client, "opencode");
        assert.equal(result.results[0]?.skillsChanged, false);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(result.results[0]?.instructionsPath, path.join(homeDir, ".config", "opencode", "AGENTS.md"));
        const content = readFile(configPath);
        assert.equal(content.includes("// keep this comment"), true);
        assert.equal(content.includes("\"existing\""), true);
        assert.equal(content.includes("\"satori\""), true);
        assert.equal(content.includes(launcherPath(homeDir)), true);
        assert.equal(content.includes("node_modules"), false);

        const instructions = readFile(path.join(homeDir, ".config", "opencode", "AGENTS.md"));
        assert.equal(instructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(instructions.includes("search_codebase"), true);
    });
});

test("uninstall removes managed OpenCode config and instruction block only", () => {
    withTempHome((homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        const instructionsPath = path.join(homeDir, ".config", "opencode", "AGENTS.md");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });

        executeInstallCommand({
            kind: "install",
            client: "opencode",
            dryRun: false,
        }, installOptions(homeDir));
        fs.writeFileSync(instructionsPath, `${readFile(instructionsPath)}\n# User Notes\n`, "utf8");

        executeInstallCommand({
            kind: "uninstall",
            client: "opencode",
            dryRun: false,
        }, { homeDir });

        const removed = JSON.parse(readFile(configPath));
        assert.equal(Boolean(removed.mcp?.satori), false);
        const instructions = readFile(instructionsPath);
        assert.equal(instructions.includes("<!-- satori-mcp:start -->"), false);
        assert.equal(instructions.includes("# User Notes"), true);
    });
});

test("install refuses to overwrite unmanaged OpenCode Satori entries", () => {
    withTempHome((homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcp: {
                satori: {
                    enabled: true,
                    type: "local",
                    command: ["node", "/custom/satori.js"],
                }
            }
        }, null, 2), "utf8");

        assert.throws(
            () => executeInstallCommand({
                kind: "install",
                client: "opencode",
                dryRun: false,
            }, installOptions(homeDir)),
            /Refusing to overwrite unmanaged Satori config/
        );
    });
});

test("install all preflights every target before mutating any config", () => {
    withTempHome((homeDir) => {
        const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
        fs.writeFileSync(claudeSettingsPath, "{ not valid json", "utf8");

        assert.throws(
            () => executeInstallCommand({
                kind: "install",
                client: "all",
                dryRun: false,
            }, { homeDir }),
            /Failed to parse JSON config/
        );

        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), false);
    });
});

test("dry-run reports install actions without writing files", () => {
    withTempHome((homeDir) => {
        const result = executeInstallCommand({
            kind: "install",
            client: "all",
            dryRun: true,
        }, installOptions(homeDir));

        assert.equal(result.results.length, 3);
        assert.equal(result.results.every((entry) => entry.dryRun), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude", "settings.json")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".config", "opencode", "opencode.json")), false);
        assert.equal(fs.existsSync(launcherPath(homeDir)), false);
    });
});
