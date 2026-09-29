import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
    detectClientTargets,
    resolveClientTargets,
} from "./client-targets.js";
import {
    resolveLauncherPath,
    resolveManagedClientCommand,
    resolveRuntimeEntryPath,
    resolveRuntimePackageRoot,
} from "./managed-runtime-paths.js";
import {
    detectClientTargets as facadeDetectClientTargets,
    resolveLauncherPath as facadeResolveLauncherPath,
    resolveManagedClientCommand as facadeResolveManagedClientCommand,
} from "./install.js";

test("neutral install boundaries preserve configured targets and runtime paths", () => {
    const homeDir = "/tmp/satori-boundary-home";
    const targets = resolveClientTargets(homeDir, {
        PATH: "",
        CODEX_HOME: "~/codex-home",
        CLAUDE_CONFIG_DIR: "~/claude-config",
        OPENCODE_CONFIG: "~/opencode/config.json",
    });

    assert.deepEqual(
        targets.map((target) => [target.client, target.configPath]),
        [
            ["codex", path.join(homeDir, "codex-home", "config.toml")],
            ["claude", path.join(homeDir, "claude-config", ".claude.json")],
            ["opencode", path.join(homeDir, "opencode", "config.json")],
            ["agy", path.join(homeDir, ".gemini", "config", "mcp_config.json")],
        ],
    );
    assert.deepEqual(detectClientTargets(homeDir, { PATH: "" }), []);
    assert.strictEqual(facadeDetectClientTargets, detectClientTargets);
    assert.strictEqual(facadeResolveLauncherPath, resolveLauncherPath);
    assert.strictEqual(facadeResolveManagedClientCommand, resolveManagedClientCommand);

    const runtimePackageRoot = resolveRuntimePackageRoot(homeDir, "@zokizuan/satori-mcp@1.2.3");
    assert.equal(
        runtimePackageRoot,
        path.join(
            homeDir,
            ".satori",
            "mcp-runtime",
            "@zokizuan-satori-mcp@1.2.3",
            "node_modules",
            "@zokizuan",
            "satori-mcp",
        ),
    );
    assert.equal(
        resolveRuntimeEntryPath(runtimePackageRoot, { bin: { satori: "dist/server.js" } }),
        path.join(runtimePackageRoot, "dist", "server.js"),
    );
    assert.deepEqual(resolveManagedClientCommand(homeDir), {
        command: process.execPath,
        args: [resolveLauncherPath(homeDir)],
    });
});
