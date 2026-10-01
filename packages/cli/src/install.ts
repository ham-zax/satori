import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CliError } from "./errors.js";
import type {
} from "./args.js";
import {
    assertSupportedPotionPlatform,
    planInstallRuntimeEnvironment,
    plannedPotionModelDirectory,
    probeManagedRuntimeCandidate,
    runInstallPreflight,
    type InstallPreflightDependencies,
    type InstallPreflightResult,
} from "./install-preflight.js";
import {
    assertAutoClientTargets,
} from "./client-targets.js";
import {
    resolvePotionAssetsRoot,
    resolveRuntimePackageRoot,
} from "./managed-runtime-paths.js";
import type {
    InstallCommandInput,
    InstallCommandOptions,
    InstallCommandResult,
} from "./install-contracts.js";
export type {
    ClientName,
    ClientInstallResult,
    InstallCommandInput,
    InstallCommandOptions,
    InstallCommandResult,
    ManagedClientConfigProof,
    ManagedRuntimeCommand,
    ManagedRuntimeUpgradePhase,
    ManagedRuntimeUpgradeResult,
    PlannedChange,
} from "./install-contracts.js";
export { assertAutoClientTargets, detectClientTargets } from "./client-targets.js";
export { resolveLauncherPath, resolveManagedClientCommand } from "./managed-runtime-paths.js";
import {
    readManagedRuntimeEnvironment,
    runtimeEnvironmentWithManagedFallbacks,
} from "./client-config-inspection.js";
import {
    assertDefaultLateOnProfile,
    configuredLateOnModelPath,
    resolveConnectedVectorStoreForInstallOrThrow,
    resolveOfflineOllamaModel,
    resolveOfflineReranker,
    resolveVerifiedLateOnModel,
    resolveVerifiedPotionModel,
} from "./runtime-selection.js";
import { plannedCbmExtendedDirectory, resolveCbmExtendedPath } from "./cbm-extractor-store.js";
import {
    createInstallPlan,
    resolveDefaultPackageSpecifier,
    type InstallPlan,
} from "./install-planning.js";
import {
    applyInstallPlan,
    exactRuntimePreflightDependencies,
    findReusableManagedRuntime,
    installManagedRuntimeCandidate,
    pruneManagedRuntimeAfterActivation,
    readContainingPackageIdentity,
    type ManagedRuntimeCandidate,
} from "./install-application.js";
export { executeManagedRuntimeUpgrade } from "./runtime-upgrade.js";
export { applyInstallPlan } from "./install-application.js";
export { createInstallPlan } from "./install-planning.js";
export type { InstallPlan } from "./install-planning.js";
export {
    inspectManagedClientConfigurations,
    verifyManagedClientConfigurations,
} from "./client-config-inspection.js";
import {
    acquireManagedRuntimeMutationLock,
} from "./managed-runtime-store.js";
import { activateAfterRetiringManagedRuntime } from "./runtime-activation.js";
import { terminateSatoriServers } from "./terminate.js";
import { resolveSatoriStateRoot } from "./local-runtime-contract.js";
import {
    DEFAULT_LATEON_PROFILE_ID,
    DEFAULT_LATEON_ACTIVATION_POLICY,
    resolveDefaultLateOnModelDirectory,
    type VerifiedLateOnModel,
} from "./lateon-model-store.js";

function managedRuntimePreflightDependencies(
    homeDir: string,
    runtimeCommand: NonNullable<InstallCommandOptions["runtimeCommand"]>,
): Pick<InstallPreflightDependencies, "probeLanceDb" | "verifyPotionRuntime" | "resolveOllamaIdentity"> {
    if (runtimeCommand.args.length !== 1 || !path.isAbsolute(runtimeCommand.args[0] ?? "")) {
        return {};
    }
    const managedRuntimeRoot = path.join(homeDir, ".satori", "mcp-runtime");
    const relative = path.relative(managedRuntimeRoot, runtimeCommand.args[0]!);
    if (
        relative === ""
        || relative === ".."
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        return {};
    }
    return exactRuntimePreflightDependencies(runtimeCommand);
}

export async function executeInstallCommand(
    command: InstallCommandInput,
    options: InstallCommandOptions = {}
): Promise<InstallCommandResult> {
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    if (command.kind === "install" && !command.dryRun) {
        assertAutoClientTargets(command.client, homeDir, env);
    }
    let preflight: InstallPreflightResult | undefined;
    let installedRuntimeCommand = options.runtimeCommand;
    let managedRuntimeCandidate: ManagedRuntimeCandidate | undefined;
    let releaseRuntimeMutationLock: (() => void) | undefined;
    let plan: InstallPlan;
    try {
        if (command.kind === "install") {
            if (command.runtime === "offline" && command.vectorStore !== undefined && command.vectorStore !== "LanceDB") {
                throw new CliError("E_USAGE", "Offline install requires --vector-store lancedb.", 2);
            }
            if (!command.dryRun) {
                releaseRuntimeMutationLock = acquireManagedRuntimeMutationLock({ homeDir });
            }
            const managedRuntimeEnvironment = readManagedRuntimeEnvironment(homeDir);
            const vectorStore = command.runtime === "voyage"
                ? resolveConnectedVectorStoreForInstallOrThrow(command, homeDir, env, managedRuntimeEnvironment)
                : "LanceDB";
            const effectiveEnv = runtimeEnvironmentWithManagedFallbacks(managedRuntimeEnvironment, env);
            const preservedOllamaModel = command.runtime === "offline"
                ? resolveOfflineOllamaModel(command, managedRuntimeEnvironment, env)
                : undefined;
            const reranker = command.runtime === "offline"
                ? resolveOfflineReranker(
                    command,
                    managedRuntimeEnvironment,
                    env,
                    options.platform,
                    options.architecture,
                )
                : undefined;
            const explicitRerankerSelection = command.runtime === "offline" && command.reranker !== undefined;
            if (reranker) assertDefaultLateOnProfile(reranker, env, explicitRerankerSelection);
            const requestedLateOnModelPath = command.runtime === "offline" && reranker
                ? options.lateOnModelPath
                    ?? configuredLateOnModelPath(reranker, managedRuntimeEnvironment, env)
                : undefined;
            if (requestedLateOnModelPath && !path.isAbsolute(requestedLateOnModelPath)) {
                throw new CliError("E_USAGE", "LateOn model path must be absolute.", 2);
            }
            if (command.runtime === "offline" && !preservedOllamaModel) {
                assertSupportedPotionPlatform({
                    platform: options.platform,
                    architecture: options.architecture,
                });
            }
            const packageSpecifier = options.packageSpecifier ?? resolveDefaultPackageSpecifier();
            let potionAssetsRoot = options.potionAssetsRoot
                ?? resolvePotionAssetsRoot(resolveRuntimePackageRoot(homeDir, packageSpecifier));
            let lateOnModel: VerifiedLateOnModel | undefined;
            let lateOnModelPath = requestedLateOnModelPath;
            if (command.dryRun) {
                // Read-only: plan from the runtime a real install would reuse, so the preview lists only real changes.
                installedRuntimeCommand ??= findReusableManagedRuntime(
                    homeDir,
                    packageSpecifier,
                    undefined,
                    {
                        vectorStore,
                        lateOn: reranker === "lateon",
                        platform: options.platform,
                        architecture: options.architecture,
                        libc: options.libc,
                    },
                )?.command;
                if (reranker === "lateon" && !lateOnModelPath) {
                    lateOnModelPath = resolveDefaultLateOnModelDirectory(homeDir);
                }
                preflight = { runtimeEnvironment: planInstallRuntimeEnvironment({
                    runtime: command.runtime,
                    homeDir,
                    env: effectiveEnv,
                    vectorStore,
                    ollamaModel: preservedOllamaModel,
                    reranker,
                    lateOnModelPath,
                    ...(reranker === "lateon"
                        ? {
                            lateOnProfileId: DEFAULT_LATEON_PROFILE_ID,
                            lateOnActivationPolicy: DEFAULT_LATEON_ACTIVATION_POLICY,
                        }
                        : {}),
                    potionAssetsRoot,
                    potionModelPath: plannedPotionModelDirectory(homeDir),
                    cbmExtendedPath: plannedCbmExtendedDirectory(homeDir),
                    platform: options.platform,
                    architecture: options.architecture,
                }) };
            } else {
                if (!installedRuntimeCommand) {
                    options.onInstallProgress?.("runtime");
                    managedRuntimeCandidate = installManagedRuntimeCandidate(
                        homeDir,
                        packageSpecifier,
                        options.execFileSyncImpl ?? execFileSync,
                        undefined,
                        {
                            vectorStore,
                            lateOn: reranker === "lateon",
                            platform: options.platform,
                            architecture: options.architecture,
                            libc: options.libc,
                        },
                    );
                    installedRuntimeCommand = managedRuntimeCandidate.command;
                    potionAssetsRoot = resolvePotionAssetsRoot(managedRuntimeCandidate.packageRoot);
                }
                const potionModelPath = command.runtime === "offline" && !preservedOllamaModel
                    ? options.potionModelPath ?? await resolveVerifiedPotionModel(
                        homeDir,
                        potionAssetsRoot,
                        options.fetchImpl,
                        options.modelProgress,
                        options.installRetryCommand,
                        env,
                        options.modelRetryDelaysMs,
                    )
                    : undefined;
                if (reranker === "lateon") {
                    const runtimePackageRoot = managedRuntimeCandidate?.packageRoot
                        ?? (installedRuntimeCommand.args.length === 1
                            ? readContainingPackageIdentity(
                                installedRuntimeCommand.args[0],
                                "@satori-code/mcp",
                            )?.packageRoot
                            : undefined);
                    lateOnModel = await resolveVerifiedLateOnModel(
                        homeDir,
                        runtimePackageRoot,
                        requestedLateOnModelPath,
                        options.fetchImpl,
                        options.lateOnAuthorityLoader,
                        options.modelProgress,
                        options.installRetryCommand,
                        options.modelRetryDelaysMs,
                    );
                }
                const cbmExtendedPath = await resolveCbmExtendedPath({
                    homeDir,
                    runtimePackageRoot: managedRuntimeCandidate?.packageRoot
                        ?? (installedRuntimeCommand.args.length === 1
                            ? readContainingPackageIdentity(installedRuntimeCommand.args[0], "@satori-code/mcp")?.packageRoot
                            : undefined),
                    env,
                    options,
                });
                const preflightDependencies: InstallPreflightDependencies = {
                    ...managedRuntimePreflightDependencies(homeDir, installedRuntimeCommand),
                    ...options.preflightDependencies,
                };
                try {
                    preflight = await (options.preflightRunner ?? runInstallPreflight)(
                        {
                            runtime: command.runtime,
                            homeDir,
                            env: effectiveEnv,
                            vectorStore,
                            ollamaModel: preservedOllamaModel,
                            reranker,
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
                        },
                        preflightDependencies,
                    );
                    if (managedRuntimeCandidate) {
                        try {
                            await (preflightDependencies.probeCandidateRuntime ?? probeManagedRuntimeCandidate)({
                                runtimeCommand: managedRuntimeCandidate.command,
                                runtimeEnvironment: preflight.runtimeEnvironment,
                                inheritedEnvironment: effectiveEnv,
                                homeDir,
                                expectedVersion: managedRuntimeCandidate.identity.version,
                            });
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            throw new CliError(
                                "E_INSTALL_PREFLIGHT",
                                `Candidate runtime preflight failed: ${message}`,
                                1,
                            );
                        }
                    }
                } catch (error) {
                    if (error instanceof CliError) throw error;
                    const message = error instanceof Error ? error.message : String(error);
                    throw new CliError("E_INSTALL_PREFLIGHT", `Runtime preflight failed: ${message}`, 1);
                }
            }
            if (
                command.runtime === "voyage"
                && resolveConnectedVectorStoreForInstallOrThrow(command, homeDir, env) !== vectorStore
            ) {
                throw new CliError(
                    "E_INSTALL_PLAN_STALE",
                    "Connected vector-store selection changed while runtime preflight was running. Rerun install against the current configuration.",
                    1,
                );
            }
            const currentManagedRuntimeEnvironment = readManagedRuntimeEnvironment(homeDir);
            for (const key of [
                "LANCEDB_PATH",
                "OLLAMA_HOST",
                "EMBEDDING_PROVIDER",
                "EMBEDDING_MODEL",
                "SATORI_RERANKER_PROVIDER",
                "SATORI_LATEON_MODEL_PATH",
                "SATORI_LATEON_PROFILE",
                "SATORI_LATEON_ACTIVATION_POLICY",
            ] as const) {
                if (currentManagedRuntimeEnvironment[key] !== managedRuntimeEnvironment[key]) {
                    throw new CliError(
                        "E_INSTALL_PLAN_STALE",
                        `Managed ${key} changed while runtime preflight was running. Rerun install against the current launcher.`,
                        1,
                    );
                }
            }
            if (!command.dryRun) {
                assertAutoClientTargets(command.client, homeDir, env);
            }
        }
        // Read mutable client/profile files only after awaited preflight completes.
        plan = createInstallPlan(command, {
            ...options,
            homeDir,
            ...(installedRuntimeCommand ? { runtimeCommand: installedRuntimeCommand } : {}),
        });
    } catch (error) {
        if (managedRuntimeCandidate?.newlyInstalled) {
            fs.rmSync(managedRuntimeCandidate.runtimeRoot, { recursive: true, force: true });
        }
        releaseRuntimeMutationLock?.();
        releaseRuntimeMutationLock = undefined;
        throw error;
    }
    try {
        if (command.kind === "install" && !command.dryRun) options.onInstallProgress?.("configure");
        const result = command.kind === "install" && !command.dryRun
            ? await activateAfterRetiringManagedRuntime({
                homeDir,
                env,
                terminateRunner: options.terminateRunner,
            }, () => applyInstallPlan(plan, preflight))
            : applyInstallPlan(plan, preflight);
        if (managedRuntimeCandidate) {
            pruneManagedRuntimeAfterActivation(
                homeDir,
                managedRuntimeCandidate.runtimeRoot,
                { ...env, ...preflight?.runtimeEnvironment },
            );
        }
        if (command.kind === "uninstall" && command.purge) {
            return { ...result, purgedPaths: await purgeSatoriData(homeDir, env, command.dryRun, options.terminateRunner) };
        }
        return result;
    } finally {
        releaseRuntimeMutationLock?.();
    }
}

/**
 * Removes every Satori-owned local directory: the managed runtime, launcher,
 * model cache, indexes, and state. Running servers are stopped first so no
 * process keeps writing into a deleted tree.
 */
async function purgeSatoriData(
    homeDir: string,
    env: NodeJS.ProcessEnv,
    dryRun: boolean,
    terminateRunner: InstallCommandOptions["terminateRunner"],
): Promise<string[]> {
    const targets = [...new Set([
        path.join(homeDir, ".satori"),
        resolveSatoriStateRoot({ configured: env.SATORI_STATE_ROOT, homeDir }),
    ])].filter((target) => fs.existsSync(target));
    if (dryRun || targets.length === 0) return targets;
    const termination = await (terminateRunner ?? terminateSatoriServers)({ homeDir, env });
    if (termination.status === "partial") {
        throw new CliError(
            "E_TERMINATION_FAILED",
            "Could not stop every running Satori server; nothing was purged. Close your coding agents and rerun.",
            1,
        );
    }
    for (const target of targets) {
        fs.rmSync(target, { recursive: true, force: true });
    }
    return targets;
}
