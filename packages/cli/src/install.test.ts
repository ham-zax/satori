import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
                "@zokizuan-satori-mcp-4.11.2",
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

function withTempRepo(run: (repoDir: string) => void): void {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-profile-repo-"));
    try {
        run(repoDir);
    } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
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

function isProcessLive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readChildPid(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for managed runtime child PID.")), 5_000);
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            const match = stdout.match(/SATORI_TEST_CHILD_PID=(\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(Number(match[1]));
            }
        });
    });
}

async function assertLauncherReapsChild(homeDir: string, signal: "SIGINT" | "SIGTERM"): Promise<void> {
    const runtimeCode = [
        'console.log(`SATORI_TEST_CHILD_PID=${process.pid}`);',
        `process.on(${JSON.stringify(signal)}, () => process.exit(0));`,
        "setInterval(() => {}, 1_000);",
    ].join("");
    executeInstallCommand({
        kind: "install",
        client: "codex",
        dryRun: false,
    }, {
        homeDir,
        runtimeCommand: { command: process.execPath, args: ["-e", runtimeCode] },
    });

    const launcher = spawn(process.execPath, [launcherPath(homeDir)], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    let childPid: number | undefined;
    try {
        childPid = await readChildPid(launcher);
        launcher.kill(signal);
        const [, exitSignal] = await once(launcher, "exit") as [number | null, NodeJS.Signals | null];
        assert.equal(exitSignal, signal);
        assert.equal(isProcessLive(childPid), false, `runtime child ${childPid} survived launcher ${signal}`);
    } finally {
        if (childPid && isProcessLive(childPid)) {
            process.kill(childPid, "SIGKILL");
        }
        if (launcher.exitCode === null && launcher.signalCode === null) {
            launcher.kill("SIGKILL");
        }
    }
}

function extractCodexGuidanceCommand(content: string): string {
    const block = content.match(/# >>> satori-cli managed codex guidance hook start >>>([\s\S]*?)# <<< satori-cli managed codex guidance hook end <<</);
    assert.ok(block, "expected managed Codex guidance hook block");
    const commandLine = block[1].match(/^command = (".*")$/m);
    assert.ok(commandLine, "expected command to be serialized as a TOML basic string");
    return JSON.parse(commandLine[1]) as string;
}

function runGuidanceCommand(command: string, cwd: string, runtimeDir: string): string {
    return execFileSync("sh", ["-c", command], {
        cwd,
        env: {
            ...process.env,
            XDG_RUNTIME_DIR: runtimeDir,
        },
        encoding: "utf8",
    });
}

function installRuntimePackageStub(relativeEntry: string) {
    return (command: string, args: string[]) => {
        assert.equal(command, "npm");
        const prefixIndex = args.indexOf("--prefix");
        assert.notEqual(prefixIndex, -1);
        const runtimeRoot = args[prefixIndex + 1];
        assert.equal(typeof runtimeRoot, "string");
        const packageIndex = args.indexOf(EXPECTED_PACKAGE_SPECIFIER);
        assert.notEqual(packageIndex, -1);
        assert.equal(args[packageIndex - 1], "--");
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
        assert.equal(result.results[0]?.skillsChanged, true);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(result.results[0]?.instructionsPath, path.join(homeDir, ".codex", "AGENTS.md"));
        const content = readFile(codexConfigPath);
        assert.equal(content.includes("[mcp_servers.satori]"), true);
        assert.equal(content.includes(`command = "${process.execPath.replace(/\\/g, "\\\\")}"`), true);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(content.includes("env_vars = ["), true);
        assert.equal(content.includes("\"VOYAGEAI_API_KEY\""), true);
        assert.equal(content.includes("\"EMBEDDING_OUTPUT_DIMENSION\""), true);
        assert.equal(content.includes("\"MILVUS_ADDRESS\""), true);
        assert.equal(content.includes("# [mcp_servers.satori.env]"), true);
        assert.equal(content.includes("# EMBEDDING_MODEL = \"voyage-code-3\""), true);
        assert.equal(content.indexOf("# [mcp_servers.satori.env]") > content.indexOf("# <<< satori-cli managed satori end <<<"), true);
        assert.equal(content.includes("node_modules"), false);
        assert.equal(content.includes("dist/index.js"), false);
        assert.equal(content.includes('command = "npx"'), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
        assert.equal(content.includes(EXPECTED_PACKAGE_SPECIFIER), false);
        assert.equal(content.includes("# >>> satori-cli managed codex guidance hook start >>>"), false);
        assert.equal(fs.existsSync(launcherPath(homeDir)), true);
        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes('require("node:child_process")'), true);
        assert.equal(launcher.includes("import { spawn }"), false);
        assert.equal(launcher.includes("node_modules"), true);
        assert.equal(launcher.includes("dist/index.js"), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), true);
        const codexInstructions = readFile(path.join(homeDir, ".codex", "AGENTS.md"));
        assert.equal(codexInstructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(codexInstructions.includes("Use Satori primarily for semantic code exploration"), true);
        assert.equal(codexInstructions.includes("Start with plain-English behavior or ownership queries"), true);
        assert.equal(codexInstructions.includes("recommendedNextAction"), true);
        assert.equal(codexInstructions.includes("warnings[].action"), true);
        assert.equal(codexInstructions.includes("capabilities"), true);
        assert.equal(codexInstructions.includes("Do not treat call_graph inbound results as sole authority"), true);
        const codexSkill = readFile(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md"));
        assert.equal(codexSkill.includes("plain-English semantic code discovery"), true);
        assert.equal(codexSkill.includes("recommendedNextAction"), true);
        assert.equal(codexSkill.includes("warnings[]"), true);
        assert.equal(codexSkill.includes("Do not treat call_graph inbound results as sole authority"), true);
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

test("managed launcher forwards termination signals and reaps its runtime child", {
    skip: process.platform === "win32" ? "POSIX signal forwarding is not observable on Windows" : false,
}, async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-launcher-signal-"));
        try {
            await assertLauncherReapsChild(homeDir, signal);
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    }
});

// F-OP-02: install result must surface the managed package specifier used.
test("install result includes packageSpecifier used for managed runtime", () => {
    withTempHome((homeDir) => {
        const result = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
        }, {
            homeDir,
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
        });

        assert.equal(result.action, "install");
        assert.equal(result.packageSpecifier, EXPECTED_PACKAGE_SPECIFIER);
        assert.match(String(result.packageSpecifier), /@zokizuan\/satori-mcp@/);
    });
});

test("managed MCP package exposes a single satori bin for npx package execution", () => {
    assert.deepEqual(PACKAGE_JSON.bin, {
        satori: "dist/index.js",
    });
});

test("packaged Satori skill assets stay identical across CLI and MCP packages", () => {
    const cliSkill = readFile(path.join(PACKAGE_ROOT, "assets", "skills", "satori", "SKILL.md"));
    const mcpSkill = readFile(path.join(PACKAGE_ROOT, "..", "mcp", "assets", "skills", "satori", "SKILL.md"));

    assert.equal(cliSkill, mcpSkill);
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
        assert.equal(second.results[0]?.instructionsChanged, false);
        assert.equal(second.results[0]?.status, "unchanged");
    });
});

test("install replaces only the managed Codex AGENTS block and preserves user content", () => {
    withTempHome((homeDir) => {
        const agentsPath = path.join(homeDir, ".codex", "AGENTS.md");
        fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
        fs.writeFileSync(agentsPath, [
            "# User Rules",
            "Keep this introduction.",
            "",
            "<!-- satori-mcp:start -->",
            "# Old Satori Instructions",
            "old exact-only guidance",
            "<!-- satori-mcp:end -->",
            "",
            "## Local Notes",
            "Keep this footer.",
            "",
        ].join("\n"), "utf8");

        const result = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
        }, installOptions(homeDir));

        const content = readFile(agentsPath);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(content.includes("Keep this introduction."), true);
        assert.equal(content.includes("Keep this footer."), true);
        assert.equal(content.includes("old exact-only guidance"), false);
        assert.equal(content.includes("Use Satori primarily for semantic code exploration"), true);
        assert.equal(content.match(/<!-- satori-mcp:start -->/g)?.length, 1);
        assert.equal(content.match(/<!-- satori-mcp:end -->/g)?.length, 1);
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
        assert.equal(content.includes("env_vars = ["), true);
        assert.equal(content.includes("\"VOYAGEAI_API_KEY\""), true);
        assert.equal(content.includes("\"MILVUS_ADDRESS\""), true);
        assert.equal(content.includes("# [mcp_servers.satori.env]"), true);
        assert.equal(content.indexOf("# [mcp_servers.satori.env]") > content.indexOf("# <<< satori-cli managed satori end <<<"), true);
        assert.equal(content.includes("node_modules"), false);
        assert.equal(content.includes("old-managed-satori"), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
    });
});

test("install preserves user-owned Codex env values outside the managed block", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                "# >>> satori-cli managed satori start >>>",
                "[mcp_servers.satori]",
                'command = "old-managed-satori"',
                'args = ["old"]',
                "# <<< satori-cli managed satori end <<<",
                "",
                "[mcp_servers.satori.env]",
                'VOYAGEAI_API_KEY = "direct-key"',
                'MILVUS_TOKEN = "direct-token"',
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
        assert.equal(content.includes('VOYAGEAI_API_KEY = "direct-key"'), true);
        assert.equal(content.includes('MILVUS_TOKEN = "direct-token"'), true);
        assert.equal(content.includes("# >>> satori-cli optional satori env template >>>"), false);
    });
});

test("install adds opt-in managed Codex guidance hook and preserves user hooks", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "[[hooks.SessionStart]]",
                'matcher = "startup"',
                "",
                "[[hooks.SessionStart.hooks]]",
                'type = "command"',
                'command = \'echo "user hook"\'',
                "",
            ].join("\n"),
            "utf8"
        );

        executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            installGuidanceHook: true,
        }, installOptions(homeDir));

        const content = readFile(codexConfigPath);
        assert.equal(content.includes("# >>> satori-cli managed codex guidance hook start >>>"), true);
        assert.equal(content.includes("# <<< satori-cli managed codex guidance hook end <<<"), true);
        assert.equal(content.includes("Satori MCP: use search_codebase for semantic ownership/context discovery"), true);
        assert.equal(content.includes("verify inbound impact with rg/tests"), true);
        assert.equal(content.includes("satori-codex-guidance"), true);
        assert.equal(extractCodexGuidanceCommand(content).startsWith("sh -lc "), true);
        assert.equal(content.includes('command = \'echo "user hook"\''), true);
    });
});

test("managed Codex guidance hook command suppresses duplicate prints per working directory", () => {
    withTempHome((homeDir) => {
        const runtimeDir = path.join(homeDir, "runtime");
        const repoA = path.join(homeDir, "repo-a");
        const repoB = path.join(homeDir, "repo-b");
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.mkdirSync(repoA, { recursive: true });
        fs.mkdirSync(repoB, { recursive: true });

        executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            installGuidanceHook: true,
        }, installOptions(homeDir));

        const command = extractCodexGuidanceCommand(readFile(path.join(homeDir, ".codex", "config.toml")));
        assert.match(runGuidanceCommand(command, repoA, runtimeDir), /Satori MCP: use search_codebase for semantic ownership\/context discovery/);
        assert.equal(runGuidanceCommand(command, repoA, runtimeDir), "");
        assert.match(runGuidanceCommand(command, repoB, runtimeDir), /Satori MCP: use search_codebase for semantic ownership\/context discovery/);

        const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
        const stampDir = path.join(runtimeDir, `satori-codex-guidance.${uid}`);
        assert.equal(fs.statSync(stampDir).isDirectory(), true);
        assert.equal(fs.statSync(stampDir).mode & 0o777, 0o700);
    });
});

test("install replaces existing managed Codex guidance hook", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                "# >>> satori-cli managed codex guidance hook start >>>",
                "[[hooks.SessionStart]]",
                'matcher = "startup"',
                "",
                "[[hooks.SessionStart.hooks]]",
                'type = "command"',
                'command = \'echo "old satori guidance"\'',
                "# <<< satori-cli managed codex guidance hook end <<<",
                "",
            ].join("\n"),
            "utf8"
        );

        executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            installGuidanceHook: true,
        }, installOptions(homeDir));

        const content = readFile(codexConfigPath);
        assert.equal(content.includes("old satori guidance"), false);
        assert.equal(content.includes("Satori MCP: use search_codebase for semantic ownership/context discovery"), true);
        assert.equal(content.includes("satori-codex-guidance"), true);
        assert.equal(content.match(/satori-cli managed codex guidance hook start/g)?.length, 1);
    });
});

test("uninstall removes an existing managed Codex block", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        const agentsPath = path.join(homeDir, ".codex", "AGENTS.md");
        const skillPath = path.join(homeDir, ".codex", "skills", "satori", "SKILL.md");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
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
        fs.writeFileSync(skillPath, "# Managed Satori Skill\n", "utf8");
        fs.writeFileSync(agentsPath, [
            "# User Rules",
            "",
            "<!-- satori-mcp:start -->",
            "# Managed Satori",
            "<!-- satori-mcp:end -->",
            "",
            "Keep this local note.",
            "",
        ].join("\n"), "utf8");

        const result = executeInstallCommand({
            kind: "uninstall",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        const content = readFile(codexConfigPath);
        const instructions = readFile(agentsPath);
        assert.equal(result.results[0]?.skillsChanged, true);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(content.includes("[mcp_servers.satori]"), false);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), false);
        assert.equal(fs.existsSync(path.dirname(skillPath)), false);
        assert.equal(instructions.includes("<!-- satori-mcp:start -->"), false);
        assert.equal(instructions.includes("Keep this local note."), true);
    });
});

test("uninstall removes managed Codex guidance hook and preserves user hooks", () => {
    withTempHome((homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "# >>> satori-cli managed codex guidance hook start >>>",
                "[[hooks.SessionStart]]",
                'matcher = "startup|resume|clear|compact"',
                "",
                "[[hooks.SessionStart.hooks]]",
                'type = "command"',
                'command = \'echo "Satori guidance"\'',
                "# <<< satori-cli managed codex guidance hook end <<<",
                "",
                "[[hooks.SessionStart]]",
                'matcher = "startup"',
                "",
                "[[hooks.SessionStart.hooks]]",
                'type = "command"',
                'command = \'echo "user hook"\'',
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
        assert.equal(content.includes("# >>> satori-cli managed codex guidance hook start >>>"), false);
        assert.equal(content.includes("Satori guidance"), false);
        assert.equal(content.includes('command = \'echo "user hook"\''), true);
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
        const configPath = path.join(homeDir, ".claude.json");
        const skillsDir = path.join(homeDir, ".claude", "skills");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.mkdirSync(path.join(skillsDir, "custom-skill"), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, "custom-skill", "SKILL.md"), "# custom\n", "utf8");
        fs.writeFileSync(configPath, JSON.stringify({
            projects: {
                "/tmp/example": {
                    allowedTools: ["Read"],
                },
            },
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

        const installed = JSON.parse(readFile(configPath));
        assert.deepEqual(installed.projects["/tmp/example"].allowedTools, ["Read"]);
        assert.equal(installed.mcpServers.existing.command, "npx");
        assert.equal(installed.mcpServers.satori.type, "stdio");
        assert.equal(installed.mcpServers.satori.command, process.execPath);
        assert.deepEqual(installed.mcpServers.satori.args, fakeClientCommand(homeDir).args);
        // Omit unset provider keys so empty ${VAR:-} defaults cannot override host env with "".
        assert.equal(installed.mcpServers.satori.env, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori, "timeout"), false);
        assert.equal(fs.existsSync(path.join(skillsDir, "satori", "SKILL.md")), true);

        const uninstall = executeInstallCommand({
            kind: "uninstall",
            client: "claude",
            dryRun: false,
        }, { homeDir });

        assert.equal(uninstall.results[0]?.status, "updated");
        const removed = JSON.parse(readFile(configPath));
        assert.equal(Boolean(removed.mcpServers.satori), false);
        assert.equal(removed.mcpServers.existing.command, "npx");
        assert.equal(fs.existsSync(path.join(skillsDir, "custom-skill", "SKILL.md")), true);
        assert.equal(fs.existsSync(path.join(skillsDir, "satori")), false);
    });
});

test("install preserves direct Claude Satori env values on reinstall", () => {
    withTempHome((homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcpServers: {
                satori: {
                    command: process.execPath,
                    args: [launcherPath(homeDir)],
                    timeout: 120000,
                    env: {
                        VOYAGEAI_API_KEY: "direct-key",
                        MILVUS_TOKEN: "direct-token",
                    },
                },
            },
        }, null, 2), "utf8");

        executeInstallCommand({
            kind: "install",
            client: "claude",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(configPath));
        assert.equal(installed.mcpServers.satori.env.VOYAGEAI_API_KEY, "direct-key");
        assert.equal(installed.mcpServers.satori.env.MILVUS_TOKEN, "direct-token");
        // Unset keys are omitted (not rewritten as empty-defaulting ${VAR:-}).
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori.env, "EMBEDDING_OUTPUT_DIMENSION"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori, "timeout"), false);
    });
});

test("install strips empty-defaulting Claude env expansions on reinstall", () => {
    withTempHome((homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcpServers: {
                satori: {
                    command: process.execPath,
                    args: [launcherPath(homeDir)],
                    env: {
                        VOYAGEAI_API_KEY: "${VOYAGEAI_API_KEY:-}",
                        MILVUS_ADDRESS: "${MILVUS_ADDRESS:-}",
                        EMBEDDING_PROVIDER: "VoyageAI",
                    },
                },
            },
        }, null, 2), "utf8");

        executeInstallCommand({
            kind: "install",
            client: "claude",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(configPath));
        assert.equal(installed.mcpServers.satori.env.EMBEDDING_PROVIDER, "VoyageAI");
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori.env, "VOYAGEAI_API_KEY"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori.env, "MILVUS_ADDRESS"), false);
    });
});

test("install refuses to overwrite unmanaged Claude Satori entries", () => {
    withTempHome((homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
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
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const original = JSON.stringify({
            mcpServers: {
                satori: {
                    command: "node",
                    args: ["/custom/satori.js"],
                    timeout: 180000,
                }
            }
        }, null, 2);
        fs.writeFileSync(configPath, original, "utf8");

        assert.throws(
            () => executeInstallCommand({
                kind: "uninstall",
                client: "claude",
                dryRun: false,
            }, { homeDir }),
            /Refusing to remove unmanaged Satori config/
        );

        assert.equal(readFile(configPath).trim(), original.trim());
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
        assert.equal(content.includes("\"environment\""), true);
        assert.equal(content.includes("\"VOYAGEAI_API_KEY\": \"{env:VOYAGEAI_API_KEY}\""), true);
        assert.equal(content.includes("\"EMBEDDING_OUTPUT_DIMENSION\": \"{env:EMBEDDING_OUTPUT_DIMENSION}\""), true);
        assert.equal(content.includes("\"MILVUS_ADDRESS\": \"{env:MILVUS_ADDRESS}\""), true);
        assert.equal(content.includes("node_modules"), false);

        const instructions = readFile(path.join(homeDir, ".config", "opencode", "AGENTS.md"));
        assert.equal(instructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(instructions.includes("search_codebase"), true);
    });
});

test("install all smoke writes launcher-backed config for every supported client", () => {
    withTempHome((homeDir) => {
        const result = executeInstallCommand({
            kind: "install",
            client: "all",
            dryRun: false,
        }, installOptions(homeDir));

        assert.deepEqual(result.results.map((entry) => entry.client), ["codex", "claude", "opencode"]);
        assert.equal(result.results.every((entry) => entry.status === "updated"), true);

        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes('require("node:child_process")'), true);
        assert.equal(launcher.includes("node_modules"), true);
        assert.equal(launcher.includes("dist/index.js"), true);

        const codexConfig = readFile(path.join(homeDir, ".codex", "config.toml"));
        assert.equal(codexConfig.includes(`command = "${process.execPath.replace(/\\/g, "\\\\")}"`), true);
        assert.equal(codexConfig.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(codexConfig.includes("env_vars = ["), true);
        assert.equal(codexConfig.includes("\"VOYAGEAI_API_KEY\""), true);
        assert.equal(codexConfig.includes("\"EMBEDDING_OUTPUT_DIMENSION\""), true);
        assert.equal(codexConfig.includes("\"MILVUS_ADDRESS\""), true);
        assert.equal(codexConfig.includes("# [mcp_servers.satori.env]"), true);
        assert.equal(codexConfig.includes('command = "npx"'), false);
        assert.equal(codexConfig.includes("startup_timeout_ms"), false);
        assert.equal(codexConfig.includes("node_modules"), false);
        assert.equal(codexConfig.includes("dist/index.js"), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), true);
        const codexInstructions = readFile(path.join(homeDir, ".codex", "AGENTS.md"));
        assert.equal(codexInstructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(codexInstructions.includes("Use Satori primarily for semantic code exploration"), true);
        assert.equal(codexInstructions.includes("recommendedNextAction"), true);
        assert.equal(codexInstructions.includes("warnings[].action"), true);
        assert.equal(codexInstructions.includes("Do not treat call_graph inbound results as sole authority"), true);

        const claudeConfig = JSON.parse(readFile(path.join(homeDir, ".claude.json")));
        assert.equal(claudeConfig.mcpServers.satori.type, "stdio");
        assert.equal(claudeConfig.mcpServers.satori.command, process.execPath);
        assert.deepEqual(claudeConfig.mcpServers.satori.args, fakeClientCommand(homeDir).args);
        assert.equal(claudeConfig.mcpServers.satori.env, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(claudeConfig.mcpServers.satori, "timeout"), false);
        assert.equal(JSON.stringify(claudeConfig.mcpServers.satori).includes("node_modules"), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude", "skills", "satori", "SKILL.md")), true);

        const opencodeConfig = JSON.parse(readFile(path.join(homeDir, ".config", "opencode", "opencode.json")));
        assert.equal(opencodeConfig.mcp.satori.enabled, true);
        assert.equal(opencodeConfig.mcp.satori.type, "local");
        assert.deepEqual(opencodeConfig.mcp.satori.command, [process.execPath, launcherPath(homeDir)]);
        assert.equal(opencodeConfig.mcp.satori.environment.VOYAGEAI_API_KEY, "{env:VOYAGEAI_API_KEY}");
        assert.equal(opencodeConfig.mcp.satori.environment.EMBEDDING_OUTPUT_DIMENSION, "{env:EMBEDDING_OUTPUT_DIMENSION}");
        assert.equal(opencodeConfig.mcp.satori.environment.MILVUS_ADDRESS, "{env:MILVUS_ADDRESS}");
        assert.equal(JSON.stringify(opencodeConfig.mcp.satori).includes("node_modules"), false);
        const opencodeInstructions = readFile(path.join(homeDir, ".config", "opencode", "AGENTS.md"));
        assert.equal(opencodeInstructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(opencodeInstructions.includes("search_codebase"), true);
        assert.equal(opencodeInstructions.includes("recommendedNextAction"), true);
        assert.equal(opencodeInstructions.includes("warnings[].action"), true);
    });
});

test("install --profile writes repo-local Satori config once for all clients", () => {
    withTempHome((homeDir) => {
        withTempRepo((repoDir) => {
            const result = executeInstallCommand({
                kind: "install",
                client: "all",
                dryRun: false,
                profile: "minimal",
            }, {
                ...installOptions(homeDir),
                repoDir,
            });

            const configPath = path.join(repoDir, "satori.toml");
            assert.equal(result.profile, "minimal");
            assert.equal(result.profileConfigPath, configPath);
            assert.equal(result.profileConfigChanged, true);
            assert.equal(fs.existsSync(configPath), true);
            assert.equal(readFile(configPath), [
                "# Satori project config",
                "[index]",
                "profile = \"minimal\"",
                "",
            ].join("\n"));
        });
    });
});

test("install --profile updates existing repo config and preserves unrelated TOML", () => {
    withTempHome((homeDir) => {
        withTempRepo((repoDir) => {
            const configPath = path.join(repoDir, "satori.toml");
            fs.writeFileSync(configPath, [
                "[project]",
                "name = \"demo\"",
                "",
                "[index]",
                "profile = \"all-text\"",
                "",
            ].join("\n"), "utf8");

            const result = executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: false,
                profile: "minimal",
            }, {
                ...installOptions(homeDir),
                repoDir,
            });

            assert.equal(result.profileConfigChanged, true);
            assert.equal(readFile(configPath), [
                "[project]",
                "name = \"demo\"",
                "",
                "[index]",
                "profile = \"minimal\"",
                "",
            ].join("\n"));
        });
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

test("install preserves direct OpenCode Satori environment values on reinstall", () => {
    withTempHome((homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcp: {
                satori: {
                    enabled: true,
                    type: "local",
                    command: [process.execPath, launcherPath(homeDir)],
                    environment: {
                        VOYAGEAI_API_KEY: "direct-key",
                        MILVUS_TOKEN: "direct-token",
                    },
                },
            },
        }, null, 2), "utf8");

        executeInstallCommand({
            kind: "install",
            client: "opencode",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(configPath));
        assert.equal(installed.mcp.satori.environment.VOYAGEAI_API_KEY, "direct-key");
        assert.equal(installed.mcp.satori.environment.MILVUS_TOKEN, "direct-token");
        assert.equal(installed.mcp.satori.environment.EMBEDDING_OUTPUT_DIMENSION, "{env:EMBEDDING_OUTPUT_DIMENSION}");
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
        const claudeConfigPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
        fs.writeFileSync(claudeConfigPath, "{ not valid json", "utf8");

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
        assert.equal(fs.existsSync(path.join(homeDir, ".claude.json")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".config", "opencode", "opencode.json")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "AGENTS.md")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude", "skills", "satori", "SKILL.md")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".config", "opencode", "AGENTS.md")), false);
        assert.equal(fs.existsSync(launcherPath(homeDir)), false);
    });
});
