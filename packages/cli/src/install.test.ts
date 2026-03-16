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
) as { name: string; version: string };
const EXPECTED_PACKAGE_SPECIFIER = `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}`;

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

test("install writes managed Codex config block and copies packaged skills", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(codexConfigPath, 'model = "gpt-5"\n', "utf8");

        const result = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.client, "codex");
        assert.equal(result.results[0]?.status, "updated");
        const content = readFile(codexConfigPath);
        assert.equal(content.includes("[mcp_servers.satori]"), true);
        assert.equal(content.includes(EXPECTED_PACKAGE_SPECIFIER), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori-search", "SKILL.md")), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori-navigation", "SKILL.md")), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori-indexing", "SKILL.md")), true);
    });
});

test("install is idempotent for managed Codex config", () => {
    withTempHome((homeDir) => {
        executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        const second = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        assert.equal(second.results[0]?.configChanged, false);
        assert.equal(second.results[0]?.skillsChanged, false);
        assert.equal(second.results[0]?.status, "unchanged");
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
            }, { homeDir }),
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
        }, { homeDir });

        const installed = JSON.parse(readFile(settingsPath));
        assert.equal(installed.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
        assert.equal(installed.mcpServers.existing.command, "npx");
        assert.equal(installed.mcpServers.satori.command, "npx");
        assert.deepEqual(installed.mcpServers.satori.args, ["-y", EXPECTED_PACKAGE_SPECIFIER]);
        assert.equal(fs.existsSync(path.join(skillsDir, "satori-search", "SKILL.md")), true);

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
        assert.equal(fs.existsSync(path.join(skillsDir, "satori-search")), false);
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
            }, { homeDir }),
            /Refusing to overwrite unmanaged Satori config/
        );
    });
});

test("install upgrades legacy managed Claude entries to the bare MCP package launch form", () => {
    withTempHome((homeDir) => {
        const settingsPath = path.join(homeDir, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify({
            mcpServers: {
                satori: {
                    command: "npx",
                    args: ["-y", "--package", "@zokizuan/satori-mcp@4.4.1", "satori"],
                    timeout: 180000,
                }
            }
        }, null, 2), "utf8");

        executeInstallCommand({
            kind: "install",
            client: "claude",
            dryRun: false,
        }, { homeDir });

        const installed = JSON.parse(readFile(settingsPath));
        assert.deepEqual(installed.mcpServers.satori.args, ["-y", EXPECTED_PACKAGE_SPECIFIER]);
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
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori-search", "SKILL.md")), false);
    });
});

test("dry-run reports install actions without writing files", () => {
    withTempHome((homeDir) => {
        const result = executeInstallCommand({
            kind: "install",
            client: "all",
            dryRun: true,
        }, { homeDir });

        assert.equal(result.results.length, 2);
        assert.equal(result.results.every((entry) => entry.dryRun), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude", "settings.json")), false);
    });
});
