import { execFileSync, spawnSync } from "node:child_process";
import { CliError } from "./errors.js";
import type { ClientName, ManagedRuntimeUpgradeResult } from "./install.js";
import type { SatoriUpgradeTarget } from "./upgrade-target.js";

type ExecFileSyncLike = typeof execFileSync;
type SpawnSyncLike = typeof spawnSync;

const CLIENT_LABELS: Record<ClientName, string> = {
    codex: "Codex",
    claude: "Claude Code",
    opencode: "OpenCode",
};

export interface SatoriUpgradeResult extends ManagedRuntimeUpgradeResult {
    fromCliVersion: string;
    toCliVersion: string;
}

export interface GlobalCliUpgradeInput {
    target: SatoriUpgradeTarget;
    currentCliVersion: string;
    invokedScriptPath: string;
    delegatedArgs: readonly string[];
    env: NodeJS.ProcessEnv;
}

export interface GlobalCliUpgradeDependencies {
    execFileSyncImpl?: ExecFileSyncLike;
    spawnSyncImpl?: SpawnSyncLike;
}

function commandOutput(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const stdout = "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    const stderr = "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    return `${stdout}\n${stderr}\n${error.message}`.trim();
}

export function installGlobalCliAndDelegate(
    input: GlobalCliUpgradeInput,
    dependencies: GlobalCliUpgradeDependencies = {},
): number {
    const execImpl = dependencies.execFileSyncImpl ?? execFileSync;
    try {
        execImpl("npm", [
            "install",
            "--global",
            input.target.cliPackageSpecifier,
            "--no-audit",
            "--no-fund",
        ], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        throw new CliError(
            "E_UPGRADE",
            `Failed to update the global Satori CLI to ${input.target.cliVersion}. ${commandOutput(error)}`,
            1,
        );
    }

    const spawnImpl = dependencies.spawnSyncImpl ?? spawnSync;
    const delegated = spawnImpl(
        process.execPath,
        [input.invokedScriptPath, ...input.delegatedArgs],
        {
            stdio: "inherit",
            env: {
                ...input.env,
                SATORI_UPGRADE_DELEGATED_TARGET: input.target.cliVersion,
                SATORI_UPGRADE_FROM_CLI_VERSION:
                    input.env.SATORI_UPGRADE_FROM_CLI_VERSION ?? input.currentCliVersion,
            },
        },
    );
    if (delegated.error) {
        throw new CliError(
            "E_UPGRADE",
            `Global CLI updated to ${input.target.cliVersion}, but the upgraded command could not start: ${delegated.error.message}`,
            1,
        );
    }
    if (delegated.signal) {
        throw new CliError(
            "E_UPGRADE",
            `Global CLI updated to ${input.target.cliVersion}, but runtime upgrade exited from signal ${delegated.signal}.`,
            1,
        );
    }
    return delegated.status ?? 1;
}

export function combineUpgradeResult(
    runtime: ManagedRuntimeUpgradeResult,
    fromCliVersion: string,
    toCliVersion: string,
): SatoriUpgradeResult {
    const cliChanged = fromCliVersion !== toCliVersion;
    return {
        ...runtime,
        status: cliChanged || runtime.status === "upgraded" ? "upgraded" : "up_to_date",
        fromCliVersion,
        toCliVersion,
    };
}

function versionLine(label: string, fromVersion: string, toVersion: string): string {
    return fromVersion === toVersion
        ? `${label}: ${toVersion}`
        : `${label}: ${fromVersion} → ${toVersion}`;
}

function restartLine(clients: readonly ClientName[]): string {
    const labels = clients.map((client) => CLIENT_LABELS[client]);
    if (labels.length === 0) {
        return "Restart any running MCP client to use the new runtime.";
    }
    if (labels.length === 1) {
        return `Restart ${labels[0]} to use the new runtime.`;
    }
    if (labels.length === 2) {
        return `Restart ${labels[0]} and ${labels[1]} to use the new runtime.`;
    }
    return `Restart ${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)} to use the new runtime.`;
}

export function formatUpgradeText(result: SatoriUpgradeResult): string {
    const lines = [
        result.status === "upgraded" ? "Satori upgraded" : "Satori is up to date",
        "",
        versionLine("CLI", result.fromCliVersion, result.toCliVersion),
        versionLine("MCP runtime", result.fromMcpVersion, result.toMcpVersion),
        versionLine("Core", result.fromCoreVersion, result.toCoreVersion),
        "",
        "Verification: passed",
    ];
    if (result.restartRequired) {
        lines.push("", restartLine(result.configuredClients));
    }
    return `${lines.join("\n")}\n`;
}
