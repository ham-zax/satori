/**
 * F2: Installer SSOT guard — packages/mcp must not implement install.
 * Hard-deprecation only: clear use-satori-cli errors, no config/filesystem mutation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    MCP_INSTALL_USE_SATORI_CLI_MESSAGE,
    MCP_UNINSTALL_USE_SATORI_CLI_MESSAGE,
    parseCliArgs,
} from "./args.js";
import { runCli } from "./index.js";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

function captureIo() {
    let stdout = "";
    let stderr = "";
    return {
        writeStdout: (text: string) => {
            stdout += text;
        },
        writeStderr: (text: string) => {
            stderr += text;
        },
        read: () => ({ stdout, stderr }),
    };
}

test("parseCliArgs install throws explicit use-satori-cli deprecation (no install command kind)", () => {
    assert.throws(
        () => parseCliArgs(["install", "--client", "codex"]),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /@zokizuan\/satori-cli/);
            assert.equal(error.message, MCP_INSTALL_USE_SATORI_CLI_MESSAGE);
            return true;
        },
    );
});

test("parseCliArgs uninstall throws explicit use-satori-cli deprecation", () => {
    assert.throws(
        () => parseCliArgs(["uninstall", "--client", "claude"]),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, MCP_UNINSTALL_USE_SATORI_CLI_MESSAGE);
            return true;
        },
    );
});

test("runCli install returns usage error and does not mutate filesystem", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-install-ssot-"));
    const io = captureIo();
    const before = listTree(homeDir);

    try {
        const exitCode = await runCli(["install", "--client", "codex"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { ...process.env, HOME: homeDir },
            serverCommand: process.execPath,
            serverArgs: ["/path/that/does/not/exist.mjs"],
            startupTimeoutMs: 100,
            callTimeoutMs: 100,
            connectSession: async () => {
                throw new Error("install deprecation must not start an MCP session");
            },
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 2);
        assert.equal(stdout.trim(), "");
        assert.match(stderr, /@zokizuan\/satori-cli/);
        assert.match(stderr, /install --client/);
        assert.deepEqual(listTree(homeDir), before);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori")), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli uninstall returns usage error and does not mutate filesystem", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-uninstall-ssot-"));
    const io = captureIo();
    const before = listTree(homeDir);

    try {
        const exitCode = await runCli(["uninstall", "--client", "claude", "--dry-run"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { ...process.env, HOME: homeDir },
            connectSession: async () => {
                throw new Error("uninstall deprecation must not start an MCP session");
            },
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 2);
        assert.equal(stdout.trim(), "");
        assert.match(stderr, /@zokizuan\/satori-cli/);
        assert.match(stderr, /uninstall --client/);
        assert.deepEqual(listTree(homeDir), before);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("MCP CLI tree has no installer implementation modules", () => {
    assert.equal(fs.existsSync(path.join(CLI_DIR, "install.ts")), false, "install.ts must not exist");
    assert.equal(
        fs.existsSync(path.join(CLI_DIR, "package-installability.ts")),
        false,
        "package-installability.ts must not exist",
    );

    const sourceFiles = fs.readdirSync(CLI_DIR)
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    for (const name of sourceFiles) {
        const content = fs.readFileSync(path.join(CLI_DIR, name), "utf8");
        assert.equal(
            content.includes("executeInstallCommand"),
            false,
            `${name} must not reference executeInstallCommand`,
        );
        assert.equal(
            content.includes("copySkill"),
            false,
            `${name} must not reference copySkill`,
        );
        assert.equal(
            content.includes("installManagedRuntime"),
            false,
            `${name} must not reference installManagedRuntime`,
        );
    }
});

function listTree(root: string): string[] {
    if (!fs.existsSync(root)) {
        return [];
    }
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            out.push(path.relative(root, full));
            if (entry.isDirectory()) {
                walk(full);
            }
        }
    };
    walk(root);
    return out.sort();
}
