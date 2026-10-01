import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { satoriCliCommand } from "./cli-command.js";
import type { InstallOfflineReranker, RerankerOperation } from "./args.js";
import type { InstallCommandOptions, ManagedRerankerResult } from "./install-contracts.js";
import { resolveDefaultLateOnModelDirectory } from "./lateon-model-store.js";
import { managedRuntimeClosureMatches } from "./managed-runtime-closure.js";
import { acquireManagedRuntimeMutationLock } from "./managed-runtime-store.js";
import {
    activateManagedRuntimeSelection,
    managedRuntimeClosureFor,
    readInstalledManagedRuntime,
    upgradeRuntimeSelection,
    type InstalledManagedRuntime,
} from "./runtime-upgrade.js";

/** Every installer-downloaded LateOn revision lives under this directory; custom model paths never do. */
function managedLateOnModelsRoot(homeDir: string): string {
    return path.dirname(resolveDefaultLateOnModelDirectory(homeDir));
}

function launcherReranker(installed: InstalledManagedRuntime): InstallOfflineReranker | null {
    if (installed.managedEnv.SATORI_RUNTIME_PROFILE !== "offline") return null;
    return installed.managedEnv.SATORI_RERANKER_PROVIDER === "lateon" ? "lateon" : "none";
}

function describe(
    homeDir: string,
    installed: InstalledManagedRuntime,
): Omit<ManagedRerankerResult, "operation" | "status" | "purgedModelPath" | "restartRequired"> {
    const reranker = launcherReranker(installed);
    const modelPath = reranker === "lateon"
        ? installed.managedEnv.SATORI_LATEON_MODEL_PATH ?? null
        : null;
    const managedModelsRoot = managedLateOnModelsRoot(homeDir);
    return {
        action: "reranker",
        runtime: installed.managedEnv.SATORI_RUNTIME_PROFILE === "offline" ? "offline" : "voyage",
        reranker,
        modelPath,
        managedModelsPresent: fs.existsSync(managedModelsRoot),
    };
}

/**
 * Switches the managed offline runtime's reranker by re-activating the installed MCP/Core version
 * with only the reranker selection changed; clients keep pointing at the same launcher.
 */
export async function executeManagedRerankerCommand(
    command: { operation: RerankerOperation; purge: boolean },
    options: InstallCommandOptions = {},
): Promise<ManagedRerankerResult> {
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    const installed = readInstalledManagedRuntime(
        homeDir,
        `Satori has no managed runtime. Run \`${satoriCliCommand("install --client all")}\` first.`,
    );
    if (command.operation === "status") {
        return {
            ...describe(homeDir, installed),
            operation: "status",
            status: "current",
            purgedModelPath: null,
            restartRequired: false,
        };
    }

    const desired: InstallOfflineReranker = command.operation === "enable" ? "lateon" : "none";
    const selection = upgradeRuntimeSelection(
        homeDir,
        installed.managedEnv,
        env,
        options.platform,
        options.architecture,
        desired,
    );
    const unchanged = launcherReranker(installed) === desired
        && managedRuntimeClosureMatches(installed.runtimeRoot, managedRuntimeClosureFor(selection, options));
    if (!unchanged) {
        await activateManagedRuntimeSelection({
            homeDir,
            options,
            installed,
            mcpPackageSpecifier: `@satori-code/mcp@${installed.mcpVersion}`,
            mcpVersion: installed.mcpVersion,
            coreVersion: installed.coreVersion,
            selection,
            failureLabel: `Satori reranker ${command.operation}`,
        });
    }
    const active = unchanged
        ? installed
        : readInstalledManagedRuntime(homeDir, "Satori managed launcher disappeared after activation.");

    let purgedModelPath: string | null = null;
    if (command.purge) {
        const releaseRuntimeMutationLock = acquireManagedRuntimeMutationLock({ homeDir });
        try {
            // The launcher is re-read under the lock so a concurrent enable cannot lose its model.
            const current = readInstalledManagedRuntime(homeDir, "Satori managed launcher disappeared before purge.");
            if (launcherReranker(current) === "lateon") {
                throw new CliError("E_USAGE", "The managed runtime uses LateOn again; refusing to purge its model.", 2);
            }
            const modelsRoot = managedLateOnModelsRoot(homeDir);
            if (fs.existsSync(modelsRoot)) {
                fs.rmSync(modelsRoot, { recursive: true, force: true });
                purgedModelPath = modelsRoot;
            }
        } finally {
            releaseRuntimeMutationLock();
        }
    }

    return {
        ...describe(homeDir, active),
        operation: command.operation,
        status: unchanged ? "unchanged" : "changed",
        purgedModelPath,
        restartRequired: !unchanged,
    };
}

export function formatRerankerText(result: ManagedRerankerResult): string {
    const state = result.reranker === null
        ? "managed by the connected runtime's environment"
        : result.reranker === "lateon" ? "LateOn (enabled)" : "none (disabled)";
    const heading = result.status === "changed"
        ? `Satori reranker ${result.operation === "enable" ? "enabled" : "disabled"}`
        : result.status === "unchanged"
            ? `Satori reranker already ${result.operation === "enable" ? "enabled" : "disabled"}`
            : "Satori reranker";
    const lines = [heading, "", `Reranker: ${state}`];
    if (result.modelPath) lines.push(`Model: ${result.modelPath}`);
    if (result.purgedModelPath) {
        lines.push(`Deleted LateOn models: ${result.purgedModelPath}`);
    } else if (result.reranker === "none" && result.managedModelsPresent) {
        lines.push(`LateOn models are still on disk; run \`${satoriCliCommand("reranker disable --purge")}\` to delete them.`);
    }
    if (result.restartRequired) {
        lines.push("", "Running Satori servers were stopped; restart your coding agent to use the new runtime.");
    }
    return `${lines.join("\n")}\n`;
}
