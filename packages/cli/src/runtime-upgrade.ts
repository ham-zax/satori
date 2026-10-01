import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { satoriCliCommand } from "./cli-command.js";
import type {
    InstallOfflineReranker,
    InstallRuntime,
    InstallVectorStore,
} from "./args.js";
import type {
    InstallCommandInput,
    InstallCommandOptions,
    ManagedRuntimeUpgradeResult,
} from "./install-contracts.js";
import { execFileSync } from "node:child_process";
import {
    compareStableVersions,
    parseStableVersion,
    type SatoriUpgradeTarget,
} from "./upgrade-target.js";
import { resolvePotionAssetsRoot } from "./managed-runtime-paths.js";
import {
    assertDefaultLateOnProfile,
    configuredLateOnModelPath,
    resolveConnectedVectorStoreForInstallOrThrow,
    resolveOfflineOllamaModel,
    resolveOfflineReranker,
    resolveVerifiedLateOnModel,
    resolveVerifiedPotionModel,
} from "./runtime-selection.js";
import { resolveCbmExtendedPath } from "./cbm-extractor-store.js";
import {
    inspectManagedClientConfigurations,
    runtimeEnvironmentWithManagedFallbacks,
} from "./client-config-inspection.js";
import {
    acquireManagedRuntimeMutationLock,
} from "./managed-runtime-store.js";
import {
    CORE_PACKAGE_NAME,
    exactRuntimePreflightDependencies,
    installManagedRuntimeCandidate,
    isPathWithin,
    prepareLauncherInstall,
    pruneManagedRuntimeAfterActivation,
    readContainingPackageIdentity,
    readRuntimeDependency,
    resolveContainingManagedRuntimeRoot,
    type ManagedRuntimeCandidate,
} from "./install-application.js";
import {
    assertSupportedPotionPlatform,
    probeManagedRuntimeCandidate,
    runInstallPreflight,
    type InstallPreflightDependencies,
} from "./install-preflight.js";
import { assertFileContentUnchanged, readTextIfExists } from "./client-config-mutations.js";
import { DEFAULT_LATEON_ACTIVATION_POLICY } from "./lateon-model-store.js";
import {
    managedRuntimeClosureMatches,
    type ManagedRuntimeClosure,
} from "./managed-runtime-closure.js";
import { resolveLauncherPath } from "./managed-runtime-paths.js";
import { parseManagedLauncherDescriptor } from "./managed-launcher-script.mjs";
import { activateAfterRetiringManagedRuntime } from "./runtime-activation.js";

export function upgradeRuntimeSelection(
    homeDir: string,
    managedEnvironment: Readonly<Record<string, string>>,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform | undefined,
    architecture: string | undefined,
): {
    runtime: InstallRuntime;
    vectorStore: InstallVectorStore;
    ollamaModel?: string;
    reranker?: InstallOfflineReranker;
    lateOnModelPath?: string;
    effectiveEnv: NodeJS.ProcessEnv;
} {
    const effectiveEnv = runtimeEnvironmentWithManagedFallbacks(managedEnvironment, env);
    const profile = managedEnvironment.SATORI_RUNTIME_PROFILE;
    if (profile === "offline") {
        const command: Extract<InstallCommandInput, { kind: "install"; runtime: "offline" }> = {
            kind: "install",
            client: "all",
            dryRun: false,
            runtime: "offline",
        };
        const ollamaModel = resolveOfflineOllamaModel(command, managedEnvironment, env);
        const reranker = resolveOfflineReranker(command, managedEnvironment, env, platform, architecture);
        assertDefaultLateOnProfile(reranker, env);
        const lateOnModelPath = configuredLateOnModelPath(reranker, managedEnvironment, env);
        return {
            runtime: "offline",
            vectorStore: "LanceDB",
            ...(ollamaModel ? { ollamaModel } : {}),
            reranker,
            ...(lateOnModelPath ? { lateOnModelPath } : {}),
            effectiveEnv,
        };
    }
    if (profile !== undefined && profile !== "connected") {
        throw new CliError(
            "E_USAGE",
            `Managed launcher has unsupported SATORI_RUNTIME_PROFILE=${profile}. Rerun \`${satoriCliCommand("install")}\` with an explicit runtime.`,
            2,
        );
    }
    const command: Extract<InstallCommandInput, { kind: "install"; runtime: "voyage" }> = {
        kind: "install",
        client: "all",
        dryRun: false,
        runtime: "voyage",
    };
    return {
        runtime: "voyage",
        vectorStore: resolveConnectedVectorStoreForInstallOrThrow(
            command,
            homeDir,
            env,
            managedEnvironment,
        ),
        effectiveEnv,
    };
}

export async function executeManagedRuntimeUpgrade(
    target: SatoriUpgradeTarget,
    options: InstallCommandOptions = {},
): Promise<ManagedRuntimeUpgradeResult> {
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    const launcherPath = resolveLauncherPath(homeDir);
    const launcherContent = readTextIfExists(launcherPath);
    if (launcherContent === null) {
        throw new CliError(
            "E_USAGE",
            `Satori has no managed runtime to upgrade. Run \`${satoriCliCommand("install --client all")}\` first.`,
            2,
        );
    }

    let descriptor: {
        command: string;
        args: readonly string[];
        managedEnv: Readonly<Record<string, string>>;
    };
    try {
        descriptor = parseManagedLauncherDescriptor(launcherContent);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(
            "E_USAGE",
            `Managed Satori launcher is invalid: ${message} Rerun \`${satoriCliCommand("install")}\` to repair it.`,
            2,
        );
    }
    const expectedNodeBasename = path.basename(process.execPath).toLowerCase();
    if (
        !path.isAbsolute(descriptor.command)
        || !fs.existsSync(descriptor.command)
        || path.basename(descriptor.command).toLowerCase() !== expectedNodeBasename
        || descriptor.args.length !== 1
    ) {
        throw new CliError(
            "E_USAGE",
            `Managed Satori launcher has an unsupported command shape. Rerun \`${satoriCliCommand("install")}\` to repair it.`,
            2,
        );
    }
    const runtimeEntry = descriptor.args[0];
    if (!runtimeEntry || !path.isAbsolute(runtimeEntry) || !fs.existsSync(runtimeEntry)) {
        throw new CliError(
            "E_USAGE",
            `Managed Satori launcher does not target an existing runtime. Rerun \`${satoriCliCommand("install")}\` to repair it.`,
            2,
        );
    }

    const mcpIdentity = readContainingPackageIdentity(runtimeEntry, "@satori-code/mcp");
    const currentRuntimeRoot = mcpIdentity
        ? resolveContainingManagedRuntimeRoot(homeDir, mcpIdentity.packageRoot)
        : null;
    const coreIdentity = currentRuntimeRoot
        ? readRuntimeDependency(runtimeEntry, CORE_PACKAGE_NAME, currentRuntimeRoot)
        : null;
    if (
        !mcpIdentity
        || !currentRuntimeRoot
        || !isPathWithin(mcpIdentity.packageRoot, runtimeEntry)
        || !coreIdentity
    ) {
        throw new CliError(
            "E_USAGE",
            `Managed Satori runtime package identity is incomplete. Rerun \`${satoriCliCommand("install")}\` to repair it.`,
            2,
        );
    }
    const fromMcpVersion = mcpIdentity.version;
    const fromCoreVersion = coreIdentity.version;
    parseStableVersion(fromMcpVersion, "Installed MCP version");
    parseStableVersion(fromCoreVersion, "Installed Core version");

    const configuredClients = inspectManagedClientConfigurations(homeDir, env)
        .filter((proof) => proof.usesManagedLauncher)
        .map((proof) => proof.client);
    const mcpComparison = compareStableVersions(fromMcpVersion, target.mcpVersion);
    if (mcpComparison > 0) {
        throw new CliError(
            "E_USAGE",
            `Installed MCP ${fromMcpVersion} is newer than npm latest ${target.mcpVersion}; refusing to downgrade it.`,
            2,
        );
    }
    const coreComparison = compareStableVersions(fromCoreVersion, target.coreVersion);
    if (coreComparison > 0) {
        throw new CliError(
            "E_USAGE",
            `Installed Core ${fromCoreVersion} is newer than npm latest ${target.coreVersion}; refusing to downgrade it.`,
            2,
        );
    }
    const selection = upgradeRuntimeSelection(
        homeDir,
        descriptor.managedEnv,
        env,
        options.platform,
        options.architecture,
    );
    const runtimeClosure: ManagedRuntimeClosure = {
        vectorStore: selection.vectorStore,
        lateOn: selection.reranker === "lateon",
        platform: options.platform,
        architecture: options.architecture,
        libc: options.libc,
    };
    if (
        mcpComparison === 0
        && fromCoreVersion === target.coreVersion
        && managedRuntimeClosureMatches(currentRuntimeRoot, runtimeClosure)
    ) {
        const releaseRuntimeMutationLock = acquireManagedRuntimeMutationLock({ homeDir });
        try {
            assertFileContentUnchanged(launcherPath, launcherContent);
            pruneManagedRuntimeAfterActivation(homeDir, currentRuntimeRoot, selection.effectiveEnv);
            return {
                action: "upgrade",
                status: "up_to_date",
                fromMcpVersion,
                toMcpVersion: target.mcpVersion,
                fromCoreVersion,
                toCoreVersion: target.coreVersion,
                packageSpecifier: target.mcpPackageSpecifier,
                configuredClients,
                restartRequired: false,
            };
        } finally {
            releaseRuntimeMutationLock();
        }
    }

    if (selection.runtime === "offline" && !selection.ollamaModel) {
        assertSupportedPotionPlatform({
            platform: options.platform,
            architecture: options.architecture,
        });
    }

    const releaseRuntimeMutationLock = acquireManagedRuntimeMutationLock({ homeDir });
    try {
        let candidate: ManagedRuntimeCandidate | undefined;
        try {
        options.onUpgradeProgress?.("installing");
        const installedCandidate = installManagedRuntimeCandidate(
            homeDir,
            target.mcpPackageSpecifier,
            options.execFileSyncImpl ?? execFileSync,
            target.coreVersion,
            runtimeClosure,
        );
        candidate = installedCandidate;
        options.onUpgradeProgress?.("verifying");
        const potionAssetsRoot = options.potionAssetsRoot
            ?? resolvePotionAssetsRoot(installedCandidate.packageRoot);
        const potionModelPath = selection.runtime === "offline" && !selection.ollamaModel
            ? options.potionModelPath ?? await resolveVerifiedPotionModel(
                homeDir,
                potionAssetsRoot,
                options.fetchImpl,
                options.modelProgress,
                options.installRetryCommand,
                selection.effectiveEnv,
                options.modelRetryDelaysMs,
            )
            : undefined;
        const lateOnModel = selection.runtime === "offline" && selection.reranker === "lateon"
            ? await resolveVerifiedLateOnModel(
                homeDir,
                installedCandidate.packageRoot,
                options.lateOnModelPath ?? selection.lateOnModelPath,
                options.fetchImpl,
                options.lateOnAuthorityLoader,
                options.modelProgress,
                options.installRetryCommand,
                options.modelRetryDelaysMs,
            )
            : undefined;
        const cbmExtendedPath = await resolveCbmExtendedPath({
            homeDir,
            runtimePackageRoot: installedCandidate.packageRoot,
            env: selection.effectiveEnv,
            options,
        });
        const preflightDependencies: InstallPreflightDependencies = {
            ...exactRuntimePreflightDependencies(installedCandidate.command),
            ...options.preflightDependencies,
        };
        const preflight = await (options.preflightRunner ?? runInstallPreflight)({
            runtime: selection.runtime,
            homeDir,
            env: selection.effectiveEnv,
            vectorStore: selection.vectorStore,
            ollamaModel: selection.ollamaModel,
            reranker: selection.reranker,
            ...(lateOnModel
                ? {
                    lateOnModelPath: lateOnModel.modelDirectory,
                    lateOnProfileId: lateOnModel.profileId,
                    lateOnActivationPolicy: DEFAULT_LATEON_ACTIVATION_POLICY,
                }
                : {}),
            potionAssetsRoot,
            potionModelPath,
            cbmExtendedPath,
            platform: options.platform,
            architecture: options.architecture,
        }, preflightDependencies);
        await (preflightDependencies.probeCandidateRuntime ?? probeManagedRuntimeCandidate)({
            runtimeCommand: installedCandidate.command,
            runtimeEnvironment: preflight.runtimeEnvironment,
            inheritedEnvironment: selection.effectiveEnv,
            homeDir,
            expectedVersion: target.mcpVersion,
        });

        assertFileContentUnchanged(launcherPath, launcherContent);
        options.onUpgradeProgress?.("activating");
        await activateAfterRetiringManagedRuntime({
            homeDir,
            env: selection.effectiveEnv,
            terminateRunner: options.terminateRunner,
        }, () => {
            const launcherMutation = prepareLauncherInstall(
                homeDir,
                installedCandidate.command,
                preflight.runtimeEnvironment,
            );
            launcherMutation.assertUnchanged?.();
            launcherMutation.apply();
        });
        pruneManagedRuntimeAfterActivation(
                homeDir,
                installedCandidate.runtimeRoot,
                { ...selection.effectiveEnv, ...preflight.runtimeEnvironment },
            );
        } catch (error) {
            if (candidate?.newlyInstalled) {
                fs.rmSync(candidate.runtimeRoot, { recursive: true, force: true });
            }
            if (error instanceof CliError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new CliError("E_INSTALL_PREFLIGHT", `Satori runtime upgrade failed: ${message}`, 1);
        }
        return {
            action: "upgrade",
            status: "upgraded",
            fromMcpVersion,
            toMcpVersion: target.mcpVersion,
            fromCoreVersion,
            toCoreVersion: target.coreVersion,
            packageSpecifier: target.mcpPackageSpecifier,
            configuredClients,
            restartRequired: true,
        };
    } finally {
        releaseRuntimeMutationLock();
    }
}
