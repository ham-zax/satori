import test from "node:test";
import assert from "node:assert/strict";
import {
    CliUpgradeDelegationStartError,
    combineUpgradeResult,
    formatUpgradeText,
    installGlobalCliAndDelegate,
} from "./upgrade.js";

const TARGET = {
    cliPackageSpecifier: "@zokizuan/satori-cli@1.4.0",
    cliVersion: "1.4.0",
    mcpPackageSpecifier: "@zokizuan/satori-mcp@6.3.0",
    mcpVersion: "6.3.0",
    coreVersion: "3.2.0",
};

test("installGlobalCliAndDelegate updates the exact CLI before invoking its upgrade command", () => {
    const execCalls: Array<{ command: string; args: string[] }> = [];
    const spawnCalls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const exitCode = installGlobalCliAndDelegate({
        target: TARGET,
        currentCliVersion: "1.3.0",
        invokedScriptPath: "/global/bin/satori",
        delegatedArgs: ["--format", "json", "upgrade"],
        env: {
            HOME: "/home/test",
            SATORI_UPGRADE_FROM_CLI_VERSION: "1.2.0",
        },
    }, {
        execFileSyncImpl: ((command: string, args: string[]) => {
            execCalls.push({ command, args });
            return "";
        }) as never,
        spawnSyncImpl: ((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
            spawnCalls.push({ command, args, env: options.env });
            return { status: 0, signal: null };
        }) as never,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(execCalls, [{
        command: "npm",
        args: [
            "install",
            "--global",
            "@zokizuan/satori-cli@1.4.0",
            "--no-audit",
            "--no-fund",
        ],
    }]);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, process.execPath);
    assert.deepEqual(spawnCalls[0].args, [
        "/global/bin/satori",
        "--format",
        "json",
        "upgrade",
    ]);
    assert.equal(spawnCalls[0].env.SATORI_UPGRADE_DELEGATED_TARGET, "1.4.0");
    assert.equal(spawnCalls[0].env.SATORI_UPGRADE_FROM_CLI_VERSION, "1.2.0");
});

test("installGlobalCliAndDelegate never starts the delegated runtime upgrade after npm failure", () => {
    let delegated = false;
    assert.throws(
        () => installGlobalCliAndDelegate({
            target: TARGET,
            currentCliVersion: "1.3.0",
            invokedScriptPath: "/global/bin/satori",
            delegatedArgs: ["upgrade"],
            env: {},
        }, {
            execFileSyncImpl: (() => {
                throw Object.assign(new Error("permission denied"), { stderr: "EACCES" });
            }) as never,
            spawnSyncImpl: (() => {
                delegated = true;
                return { status: 0 };
            }) as never,
        }),
        (error: unknown) => {
            assert.match(String(error), /Failed to update the global Satori CLI.*EACCES/s);
            assert.equal((error as { token?: string }).token, "E_UPGRADE");
            assert.equal((error as { exitCode?: number }).exitCode, 1);
            return true;
        },
    );
    assert.equal(delegated, false);
});

test("installGlobalCliAndDelegate preserves completed CLI identity when delegation cannot start", () => {
    assert.throws(
        () => installGlobalCliAndDelegate({
            target: TARGET,
            currentCliVersion: "1.3.0",
            invokedScriptPath: "/global/bin/satori",
            delegatedArgs: ["--format", "json", "upgrade"],
            env: {
                SATORI_UPGRADE_FROM_CLI_VERSION: "1.2.0",
            },
        }, {
            execFileSyncImpl: (() => "") as never,
            spawnSyncImpl: (() => ({
                status: null,
                signal: null,
                error: new Error("EAGAIN"),
            })) as never,
        }),
        (error: unknown) => {
            assert.ok(error instanceof CliUpgradeDelegationStartError);
            assert.equal(error.fromCliVersion, "1.2.0");
            assert.equal(error.toCliVersion, "1.4.0");
            assert.match(error.message, /CLI updated to 1\.4\.0.*could not start.*EAGAIN/s);
            return true;
        },
    );
});

test("formatUpgradeText reports the CLI, MCP, and Core closure concisely", () => {
    const result = combineUpgradeResult({
        action: "upgrade",
        status: "upgraded",
        fromMcpVersion: "6.2.0",
        toMcpVersion: "6.3.0",
        fromCoreVersion: "3.1.0",
        toCoreVersion: "3.2.0",
        packageSpecifier: "@zokizuan/satori-mcp@6.3.0",
        configuredClients: ["codex", "opencode"],
        restartRequired: true,
    }, "1.3.0", "1.4.0");

    assert.deepEqual(result.fromCliVersion, "1.3.0");
    assert.equal(result.status, "upgraded");
    assert.equal(formatUpgradeText(result), [
        "Satori upgraded",
        "",
        "CLI: 1.3.0 → 1.4.0",
        "MCP runtime: 6.2.0 → 6.3.0",
        "Core: 3.1.0 → 3.2.0",
        "",
        "Verification: passed",
        "",
        "Restart Codex and OpenCode to use the new runtime.",
        "",
    ].join("\n"));
});

test("combineUpgradeResult reports no-op closure without restart guidance", () => {
    const result = combineUpgradeResult({
        action: "upgrade",
        status: "up_to_date",
        fromMcpVersion: "6.3.0",
        toMcpVersion: "6.3.0",
        fromCoreVersion: "3.2.0",
        toCoreVersion: "3.2.0",
        packageSpecifier: "@zokizuan/satori-mcp@6.3.0",
        configuredClients: [],
        restartRequired: false,
    }, "1.4.0", "1.4.0");

    assert.equal(result.status, "up_to_date");
    assert.doesNotMatch(formatUpgradeText(result), /Restart/);
});
