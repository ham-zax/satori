import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { satoriCliCommand } from "./cli-command.js";
import type { RerankerOperation } from "./args.js";
import { RERANKER_PROVIDERS, type InstallReranker } from "./reranker-providers.js";
import type { InstallCommandOptions, ManagedRerankerResult } from "./install-contracts.js";
import { resolveDefaultLateOnModelDirectory } from "./lateon-model-store.js";
import { managedRuntimeClosureMatches } from "./managed-runtime-closure.js";
import { acquireManagedRuntimeMutationLock } from "./managed-runtime-store.js";
import { resolveVoyageApiKey, type VoyageKeyInteraction } from "./voyage-api-key.js";
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

function launcherReranker(installed: InstalledManagedRuntime): InstallReranker | null {
    const configured = installed.managedEnv.SATORI_RERANKER_PROVIDER;
    if (configured && Object.prototype.hasOwnProperty.call(RERANKER_PROVIDERS, configured)) {
        return configured as InstallReranker;
    }
    if (installed.managedEnv.SATORI_RUNTIME_PROFILE !== "offline") return null;
    return installed.managedEnv.SATORI_RERANKER_PROVIDER === "lateon" ? "lateon" : "none";
}

function launcherModel(installed: InstalledManagedRuntime): string | null {
    if (launcherReranker(installed) !== "voyage") return null;
    return installed.managedEnv.VOYAGEAI_RERANKER_MODEL?.trim()
        || RERANKER_PROVIDERS.voyage.defaultModel;
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
    const runtime = installed.managedEnv.SATORI_RUNTIME_PROFILE === "offline" ? "offline" : "voyage";
    return {
        action: "reranker",
        runtime,
        reranker,
        model: reranker === "voyage" ? launcherModel(installed) : null,
        network: reranker ? RERANKER_PROVIDERS[reranker].network : runtime === "voyage" ? "remote" : "local",
        modelPath,
        managedModelsPresent: fs.existsSync(managedModelsRoot),
    };
}

/**
 * Switches the managed runtime's reranker by re-activating the installed MCP/Core version
 * with only the reranker selection changed; clients keep pointing at the same launcher.
 */
export async function executeManagedRerankerCommand(
    command: { operation: RerankerOperation; provider?: InstallReranker; model?: string; noVerify?: boolean; purge: boolean },
    options: InstallCommandOptions & VoyageKeyInteraction = {},
): Promise<ManagedRerankerResult> {
    const homeDir = options.homeDir ?? os.homedir();
    let env = options.env ?? process.env;
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

    const desired: InstallReranker = command.operation === "enable"
        ? "lateon"
        : command.operation === "disable"
            ? "none"
            : command.provider ?? (() => {
                throw new CliError("E_USAGE", "reranker use requires a provider.", 2);
            })();
    const desiredModel = desired === "voyage"
        ? command.model?.trim() || RERANKER_PROVIDERS.voyage.defaultModel
        : undefined;
    if (desired === "voyage") {
        const writeMessage = options.writeMessage ?? ((message: string) => { process.stderr.write(message); });
        writeMessage("Voyage is a paid API and sends code excerpts to a third party. In Satori's tests it ranked the owning code first for 22 of 28 questions; LateOn did so for 13.\n");
        const apiKey = await resolveVoyageApiKey(homeDir, env, options);
        if (apiKey === null) {
            return {
                ...describe(homeDir, installed),
                operation: command.operation,
                status: "cancelled",
                purgedModelPath: null,
                restartRequired: false,
            };
        }
        env = { ...env, [RERANKER_PROVIDERS.voyage.keyEnv]: apiKey };
    }
    const selection = upgradeRuntimeSelection(
        homeDir,
        installed.managedEnv,
        env,
        options.platform,
        options.architecture,
        desired,
        desiredModel,
    );
    const currentModel = launcherModel(installed);
    const selectedModel = desired === "voyage" ? selection.rerankerModel ?? RERANKER_PROVIDERS.voyage.defaultModel : null;
    const unchanged = launcherReranker(installed) === desired
        && currentModel === selectedModel
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
            noVerify: command.noVerify,
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

export function formatRerankerText(result: ManagedRerankerResult, showSwitchCommands = false): string {
    const state = result.reranker === null
        ? "managed by the connected runtime's environment"
        : result.reranker === "lateon"
            ? "LateOn (enabled)"
            : result.reranker === "voyage"
                ? "Voyage"
                : "none (disabled)";
    const heading = result.status === "changed"
        ? result.operation === "use"
            ? "Satori reranker selected"
            : `Satori reranker ${result.operation === "enable" ? "enabled" : "disabled"}`
        : result.status === "unchanged"
            ? result.operation === "use"
                ? "Satori reranker unchanged"
                : `Satori reranker already ${result.operation === "enable" ? "enabled" : "disabled"}`
            : result.status === "cancelled"
                ? "Satori reranker switch cancelled"
                : "Satori reranker";
    const lines = [heading, "", `Reranker: ${state}`];
    if (result.model) lines.push(`Model: ${result.model}`);
    else if (result.modelPath) lines.push(`Model: ${result.modelPath}`);
    if (result.reranker === "voyage" && result.network === "remote") {
        lines.push("Online: search queries and code excerpts are sent to Voyage.");
    }
    if (result.purgedModelPath) {
        lines.push(`Deleted LateOn models: ${result.purgedModelPath}`);
    } else if (result.reranker === "none" && result.managedModelsPresent) {
        lines.push(`LateOn models are still on disk; run \`${satoriCliCommand("reranker disable --purge")}\` to delete them.`);
    }
    if (result.restartRequired) {
        lines.push("", "Running Satori servers were stopped; restart your coding agent to use the new runtime.");
    }
    if (result.operation === "status" && showSwitchCommands) {
        lines.push(
            "",
            "Switch reranker:",
            `  ${satoriCliCommand("reranker use voyage")}  Voyage (paid API; prompts for a missing key)`,
            `  ${satoriCliCommand("reranker use lateon")}  LateOn (local)`,
            `  ${satoriCliCommand("reranker disable")}  Disable reranking`,
        );
    }
    return `${lines.join("\n")}\n`;
}
