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
    rerankerOverride?: InstallOfflineReranker,
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
            ...(rerankerOverride ? { reranker: rerankerOverride } : {}),
        };
        const ollamaModel = resolveOfflineOllamaModel(command, managedEnvironment, env);
        const reranker = resolveOfflineReranker(command, managedEnvironment, env, platform, architecture);
        assertDefaultLateOnProfile(reranker, env, rerankerOverride !== undefined);
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
    if (rerankerOverride) {
        throw new CliError(
            "E_USAGE",
            `Reranker selection applies only to the offline runtime. Rerun \`${satoriCliCommand("install --runtime offline")}\` first.`,
            2,
        );
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

export interface InstalledManagedRuntime {
    launcherPath: string;
    launcherContent: string;
    managedEnv: Readonly<Record<string, string>>;
    runtimeRoot: string;
    mcpVersion: string;
    coreVersion: string;
}

/** Reads and validates the managed launcher and the runtime package closure it targets. */
export function readInstalledManagedRuntime(homeDir: string, missingMessage: string): InstalledManagedRuntime {
    const launcherPath = resolveLauncherPath(homeDir);
    const launcherContent = readTextIfExists(launcherPath);
    if (launcherContent === null) {
        throw new CliError("E_USAGE", missingMessage, 2);
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
    const runtimeRoot = mcpIdentity
        ? resolveContainingManagedRuntimeRoot(homeDir, mcpIdentity.packageRoot)
        : null;
    const coreIdentity = runtimeRoot
        ? readRuntimeDependency(runtimeEntry, CORE_PACKAGE_NAME, runtimeRoot)
        : null;
    if (
        !mcpIdentity
        || !runtimeRoot
        || !isPathWithin(mcpIdentity.packageRoot, runtimeEntry)
        || !coreIdentity
    ) {
        throw new CliError(
            "E_USAGE",
            `Managed Satori runtime package identity is incomplete. Rerun \`${satoriCliCommand("install")}\` to repair it.`,
            2,
        );
    }
    parseStableVersion(mcpIdentity.version, "Installed MCP version");
    parseStableVersion(coreIdentity.version, "Installed Core version");
    return {
        launcherPath,
        launcherContent,
        managedEnv: descriptor.managedEnv,
        runtimeRoot,
        mcpVersion: mcpIdentity.version,
        coreVersion: coreIdentity.version,
    };
}

export type ManagedRuntimeSelection = ReturnType<typeof upgradeRuntimeSelection>;

export function managedRuntimeClosureFor(
    selection: ManagedRuntimeSelection,
    options: InstallCommandOptions,
): ManagedRuntimeClosure {
    return {
        vectorStore: selection.vectorStore,
        lateOn: selection.reranker === "lateon",
        platform: options.platform,
        architecture: options.architecture,
        libc: options.libc,
    };
}

/**
 * Installs (or reuses) the runtime closure for `selection`, verifies its models, preflights and
 * probes it, then retires running servers and rewrites the launcher. A newly installed candidate
 * is removed when any step fails, so the previous launcher stays authoritative.
 */
export async function activateManagedRuntimeSelection(input: {
    homeDir: string;
    options: InstallCommandOptions;
    installed: InstalledManagedRuntime;
    mcpPackageSpecifier: string;
    mcpVersion: string;
    coreVersion: string;
    selection: ManagedRuntimeSelection;
    failureLabel: string;
}): Promise<void> {
    const { homeDir, options, installed, selection } = input;
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
                input.mcpPackageSpecifier,
                options.execFileSyncImpl ?? execFileSync,
                input.coreVersion,
                managedRuntimeClosureFor(selection, options),
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
                expectedVersion: input.mcpVersion,
            });

            assertFileContentUnchanged(installed.launcherPath, installed.launcherContent);
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
            throw new CliError("E_INSTALL_PREFLIGHT", `${input.failureLabel} failed: ${message}`, 1);
        }
    } finally {
        releaseRuntimeMutationLock();
    }
}

export async function executeManagedRuntimeUpgrade(
    target: SatoriUpgradeTarget,
    options: InstallCommandOptions = {},
): Promise<ManagedRuntimeUpgradeResult> {
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    const installed = readInstalledManagedRuntime(
        homeDir,
        `Satori has no managed runtime to upgrade. Run \`${satoriCliCommand("install --client all")}\` first.`,
    );
    const fromMcpVersion = installed.mcpVersion;
    const fromCoreVersion = installed.coreVersion;

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
        installed.managedEnv,
        env,
        options.platform,
        options.architecture,
    );
    const result = {
        action: "upgrade",
        fromMcpVersion,
        toMcpVersion: target.mcpVersion,
        fromCoreVersion,
        toCoreVersion: target.coreVersion,
        packageSpecifier: target.mcpPackageSpecifier,
        configuredClients,
    } as const;
    if (
        mcpComparison === 0
        && fromCoreVersion === target.coreVersion
        && managedRuntimeClosureMatches(installed.runtimeRoot, managedRuntimeClosureFor(selection, options))
    ) {
        const releaseRuntimeMutationLock = acquireManagedRuntimeMutationLock({ homeDir });
        try {
            assertFileContentUnchanged(installed.launcherPath, installed.launcherContent);
            pruneManagedRuntimeAfterActivation(homeDir, installed.runtimeRoot, selection.effectiveEnv);
            return { ...result, status: "up_to_date", restartRequired: false };
        } finally {
            releaseRuntimeMutationLock();
        }
    }

    await activateManagedRuntimeSelection({
        homeDir,
        options,
        installed,
        mcpPackageSpecifier: target.mcpPackageSpecifier,
        mcpVersion: target.mcpVersion,
        coreVersion: target.coreVersion,
        selection,
        failureLabel: "Satori runtime upgrade",
    });
    return { ...result, status: "upgraded", restartRequired: true };
}
