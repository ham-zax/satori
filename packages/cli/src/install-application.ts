import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { CliError } from "./errors.js";
import type {
    ClientName,
    InstallCommandResult,
    ManagedRuntimeCommand,
    PlannedChangeKind,
} from "./install-contracts.js";
import {
    probeLanceDbRuntime,
    verifyBundledPotionRuntime,
    type InstallPreflightDependencies,
    type InstallPreflightResult,
    type LanceDbModule,
    type PotionRuntimeCoreModule,
} from "./install-preflight.js";
import {
    packageNameFromSpecifier,
    resolveLauncherPath,
    resolveRuntimeEntryPath,
    resolveRuntimePackageRootFromRoot,
    resolveRuntimeRoot,
} from "./managed-runtime-paths.js";
import {
    MANAGED_RUNTIME_DIR,
    type ExecFileSyncLike,
} from "./install-contracts.js";
import { buildLauncherScript } from "./managed-launcher-script.mjs";
import {
    assertFileContentUnchanged,
    ensureDir,
    readTextIfExists,
    writeTextFileAtomic,
    type FileMutation,
} from "./client-config-mutations.js";
import type { InstallPlan } from "./install-planning.js";
import {
    acquireManagedRuntimeMutationLock,
    pruneManagedRuntimeStore,
} from "./managed-runtime-store.js";
import {
    managedRuntimeClosureMatches,
    resolveLanceDbNativePackage,
    resolveLateOnNativePackages,
    resolveOxcParserNativePackage,
    type ManagedRuntimeClosure,
    writeManagedRuntimeClosureManifest,
} from "./managed-runtime-closure.js";

export interface ManagedRuntimeCandidate {
    readonly command: ManagedRuntimeCommand;
    readonly identity: {
        readonly name: string;
        readonly version: string;
    };
    readonly runtimeRoot: string;
    readonly packageRoot: string;
    readonly newlyInstalled: boolean;
}

export interface ResolvedRuntimeDependency {
    readonly version: string;
    readonly packageJsonPath: string;
}

export interface ContainingPackageIdentity {
    readonly version: string;
    readonly packageRoot: string;
}
export function prepareLauncherInstall(
    homeDir: string,
    runtimeCommand: ManagedRuntimeCommand,
    managedEnv: Readonly<Record<string, string>> = {},
): FileMutation {
    const launcherPath = resolveLauncherPath(homeDir);
    const current = readTextIfExists(launcherPath);
    const runtimePackageRoot = runtimeCommand.args.length === 1
        ? readContainingPackageIdentity(
            runtimeCommand.args[0],
            "@zokizuan/satori-mcp",
        )?.packageRoot
        : undefined;
    const managedRuntimeRoot = runtimePackageRoot
        ? resolveContainingManagedRuntimeRoot(homeDir, runtimePackageRoot) ?? undefined
        : undefined;
    const next = buildLauncherScript({
        command: runtimeCommand.command,
        args: runtimeCommand.args,
        managedEnv,
        managedLauncherPath: launcherPath,
        ...(managedRuntimeRoot ? { managedRuntimeRoot } : {}),
    });
    return {
        changed: current !== next,
        assertUnchanged: () => assertFileContentUnchanged(launcherPath, current),
        apply: () => {
            if (current === next) {
                return;
            }
            writeTextFileAtomic(launcherPath, next, 0o755);
        },
    };
}

export function npmOutput(error: unknown): string {
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

/**
 * Read-only lookup of the exact-version managed runtime a real install would
 * reuse instead of running npm. Shared by install and its dry-run preview.
 */
export function findReusableManagedRuntime(
    homeDir: string,
    packageSpecifier: string,
    expectedCoreVersion: string | undefined,
    closure: ManagedRuntimeClosure,
): ManagedRuntimeCandidate | null {
    const stableRuntimeRoot = resolveRuntimeRoot(homeDir, packageSpecifier);
    const existing = resolveInstalledRuntimeCommand(
        stableRuntimeRoot,
        packageSpecifier,
        true,
        expectedCoreVersion,
    );
    if (existing && managedRuntimeClosureMatches(stableRuntimeRoot, closure)) {
        return {
            ...existing,
            runtimeRoot: stableRuntimeRoot,
            newlyInstalled: false,
        };
    }
    return null;
}

export function installManagedRuntimeCandidate(
    homeDir: string,
    packageSpecifier: string,
    execImpl: ExecFileSyncLike,
    expectedCoreVersion: string | undefined,
    closure: ManagedRuntimeClosure,
): ManagedRuntimeCandidate {
    const stableRuntimeRoot = resolveRuntimeRoot(homeDir, packageSpecifier);
    const reusable = findReusableManagedRuntime(homeDir, packageSpecifier, expectedCoreVersion, closure);
    if (reusable) return reusable;
    const installTargets = [
        packageSpecifier,
        ...(closure.vectorStore === "LanceDB"
            ? [resolveLanceDbNativePackage(closure)]
            : []),
        resolveOxcParserNativePackage(closure),
        ...resolveLateOnNativePackages(closure),
    ];
    // Never reinstall into a directory that may still be the target of the
    // active launcher. A failed or stale reinstall must leave the old runtime
    // bytes untouched.
    const runtimeRoot = fs.existsSync(stableRuntimeRoot)
        ? fs.mkdtempSync(`${stableRuntimeRoot}.generation-`)
        : stableRuntimeRoot;
    ensureDir(runtimeRoot);
    const npmInstallEnv = { ...process.env };
    for (const key of Object.keys(npmInstallEnv)) {
        if (key.toLowerCase() === "npm_config_allow_scripts") {
            delete npmInstallEnv[key];
        }
    }
    try {
        execImpl("npm", [
            "install",
            "--prefix",
            runtimeRoot,
            "--omit=dev",
            "--omit=optional",
            "--no-package-lock",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--",
            ...installTargets,
        ], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: npmInstallEnv,
        });
    } catch (error) {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        throw new CliError(
            "E_USAGE",
            `Failed to install Satori MCP runtime package ${packageSpecifier} into ${runtimeRoot}. ${npmOutput(error)}`,
            2
        );
    }

    const installed = resolveInstalledRuntimeCommand(
        runtimeRoot,
        packageSpecifier,
        false,
        expectedCoreVersion,
    );
    if (!installed) {
        const packageRoot = resolveRuntimePackageRootFromRoot(runtimeRoot, packageSpecifier);
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        throw new CliError(
            "E_USAGE",
            `Installed Satori MCP runtime is missing a usable entry under ${packageRoot}.`,
            2,
        );
    }
    try {
        writeManagedRuntimeClosureManifest(runtimeRoot, closure);
    } catch (error) {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        throw new CliError(
            "E_USAGE",
            `Installed Satori MCP runtime closure could not be recorded at ${runtimeRoot}: ${error instanceof Error ? error.message : String(error)}`,
            2,
        );
    }
    return {
        ...installed,
        runtimeRoot,
        newlyInstalled: true,
    };
}

export const EXACT_PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const CORE_PACKAGE_NAME = "@zokizuan/satori-core";

export function requestedExactPackageVersion(packageSpecifier: string): string | null {
    const packageName = packageNameFromSpecifier(packageSpecifier);
    const suffix = packageSpecifier.slice(packageName.length);
    if (!suffix.startsWith("@")) {
        return null;
    }
    const version = suffix.slice(1);
    return EXACT_PACKAGE_VERSION_PATTERN.test(version) ? version : null;
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
    try {
        const realRoot = fs.realpathSync(rootPath);
        const realCandidate = fs.realpathSync(candidatePath);
        const relative = path.relative(realRoot, realCandidate);
        return relative.length > 0
            && relative !== ".."
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative);
    } catch {
        return false;
    }
}

export function readRuntimeDependency(
    runtimeEntry: string,
    packageName: string,
    runtimeRoot: string,
): ResolvedRuntimeDependency | null {
    try {
        const requireFromRuntime = createRequire(runtimeEntry);
        const packageJsonPath = requireFromRuntime.resolve(`${packageName}/package.json`);
        if (!isPathWithin(runtimeRoot, packageJsonPath)) {
            return null;
        }
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
            name?: unknown;
            version?: unknown;
        };
        return packageJson.name === packageName
            && typeof packageJson.version === "string"
            && EXACT_PACKAGE_VERSION_PATTERN.test(packageJson.version)
            ? {
                version: packageJson.version,
                packageJsonPath: fs.realpathSync(packageJsonPath),
            }
            : null;
    } catch {
        return null;
    }
}

export function resolveInstalledRuntimeCommand(
    runtimeRoot: string,
    packageSpecifier: string,
    forReuse: boolean,
    expectedCoreVersion?: string,
): Pick<ManagedRuntimeCandidate, "command" | "identity" | "packageRoot"> | null {
    const packageRoot = resolveRuntimePackageRootFromRoot(runtimeRoot, packageSpecifier);
    const packageJsonPath = path.join(packageRoot, "package.json");
    let packageJson: { name?: unknown; version?: unknown; bin?: unknown; main?: unknown };
    try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as typeof packageJson;
    } catch {
        return null;
    }
    const expectedName = packageNameFromSpecifier(packageSpecifier);
    const expectedVersion = requestedExactPackageVersion(packageSpecifier);
    if (
        !isPathWithin(runtimeRoot, packageJsonPath)
        || packageJson.name !== expectedName
        || typeof packageJson.version !== "string"
        || !EXACT_PACKAGE_VERSION_PATTERN.test(packageJson.version)
        || (expectedVersion !== null && packageJson.version !== expectedVersion)
        || (forReuse && expectedVersion === null)
    ) {
        return null;
    }

    const command = {
        command: process.execPath,
        args: [resolveRuntimeEntryPath(packageRoot, packageJson)],
    };
    if (!fs.existsSync(command.args[0]) || !isPathWithin(packageRoot, command.args[0])) {
        return null;
    }
    if (
        expectedCoreVersion !== undefined
        && readRuntimeDependency(command.args[0], CORE_PACKAGE_NAME, runtimeRoot)?.version !== expectedCoreVersion
    ) {
        return null;
    }
    return {
        command,
        packageRoot,
        identity: {
            name: packageJson.name,
            version: packageJson.version,
        },
    };
}

export function exactRuntimeLanceDbProbe(runtimeCommand: ManagedRuntimeCommand): (databasePath: string) => Promise<void> {
    const runtimeEntry = runtimeCommand.args[0];
    return async (databasePath: string): Promise<void> => {
        const requireFromRuntime = createRequire(runtimeEntry);
        const resolved = requireFromRuntime.resolve("@zokizuan/satori-core/lancedb");
        await probeLanceDbRuntime(databasePath, {
            loadLanceDb: () => import(pathToFileURL(resolved).href) as Promise<LanceDbModule>,
        });
    };
}

type ExactRuntimeCoreModule = PotionRuntimeCoreModule & {
    resolveOllamaModelIdentity: NonNullable<InstallPreflightDependencies["resolveOllamaIdentity"]>;
};

async function loadExactRuntimeCore(runtimeCommand: ManagedRuntimeCommand): Promise<ExactRuntimeCoreModule> {
    const runtimeEntry = runtimeCommand.args[0];
    const requireFromRuntime = createRequire(runtimeEntry);
    const resolved = requireFromRuntime.resolve("@zokizuan/satori-core");
    return import(pathToFileURL(resolved).href) as Promise<ExactRuntimeCoreModule>;
}

export function exactRuntimePreflightDependencies(
    runtimeCommand: ManagedRuntimeCommand,
): Pick<InstallPreflightDependencies, "probeLanceDb" | "verifyPotionRuntime" | "resolveOllamaIdentity"> {
    return {
        probeLanceDb: exactRuntimeLanceDbProbe(runtimeCommand),
        verifyPotionRuntime: (assetsRoot, modelPath) => verifyBundledPotionRuntime(
            assetsRoot,
            modelPath,
            () => loadExactRuntimeCore(runtimeCommand),
        ),
        resolveOllamaIdentity: async (input) => (
            await loadExactRuntimeCore(runtimeCommand)
        ).resolveOllamaModelIdentity(input),
    };
}

export function applyInstallPlan(
    plan: InstallPlan,
    preflight?: InstallPreflightResult,
): InstallCommandResult {
    const { command, homeDir, packageSpecifier, profileMutation, prepared, options } = plan;
    if (command.kind === "install" && !command.dryRun && !preflight) {
        throw new CliError(
            "E_INSTALL_PREFLIGHT_REQUIRED",
            "Refusing to apply an installation plan without a completed runtime preflight.",
            1,
        );
    }
    const runtimeEnvironment: Readonly<Record<string, string>> =
        preflight?.runtimeEnvironment ?? Object.freeze({});
    let installedManagedRuntimeCandidate: ManagedRuntimeCandidate | undefined;
    let launcherMutation = command.kind === "install"
        ? prepareLauncherInstall(homeDir, plan.plannedRuntimeCommand, runtimeEnvironment)
        : { changed: false, apply: () => {} };

    const releaseRuntimeMutationLock =
        !command.dryRun && command.kind === "install" && !options.runtimeCommand
            ? acquireManagedRuntimeMutationLock({ homeDir })
            : undefined;
    // The same step list drives a real apply and the dry-run preview, so both name identical paths.
    const plannedSteps: Array<{
        kind: PlannedChangeKind;
        client?: ClientName;
        path: string;
        description: string;
        changed: boolean;
        apply: () => void;
    }> = [];
    try {
        if (command.kind === "install" && !options.runtimeCommand) {
            const runtimeRoot = resolveRuntimeRoot(homeDir, packageSpecifier);
            plannedSteps.push({
                kind: "runtime",
                path: runtimeRoot,
                description: `managed runtime package at ${runtimeRoot}`,
                changed: true,
                apply: () => {
                    const installedRuntime = installManagedRuntimeCandidate(
                        homeDir,
                        packageSpecifier,
                        options.execFileSyncImpl ?? execFileSync,
                        undefined,
                        {
                            vectorStore: runtimeEnvironment.VECTOR_STORE_PROVIDER === "Milvus"
                                ? "Milvus"
                                : "LanceDB",
                            lateOn: runtimeEnvironment.SATORI_RERANKER_PROVIDER === "lateon",
                            platform: options.platform,
                            architecture: options.architecture,
                            libc: options.libc,
                        },
                    );
                    installedManagedRuntimeCandidate = installedRuntime;
                    profileMutation.assertUnchanged?.();
                    for (const mutation of prepared) {
                        mutation.configMutation.assertUnchanged?.();
                        for (const companion of mutation.companionMutations) {
                            companion.assertUnchanged?.();
                        }
                    }
                    launcherMutation.assertUnchanged?.();
                    launcherMutation = prepareLauncherInstall(homeDir, installedRuntime.command, runtimeEnvironment);
                },
            });
        }
        if (command.kind === "install") {
            plannedSteps.push({
                kind: "launcher",
                path: resolveLauncherPath(homeDir),
                description: `managed launcher at ${resolveLauncherPath(homeDir)}`,
                changed: launcherMutation.changed || !options.runtimeCommand,
                apply: () => {
                    launcherMutation.assertUnchanged?.();
                    launcherMutation.apply();
                },
            });
            plannedSteps.push({
                kind: "profile",
                path: profileMutation.filePath ?? "satori.toml",
                description: `repository profile at ${profileMutation.filePath ?? "satori.toml"}`,
                changed: profileMutation.changed,
                apply: () => {
                    profileMutation.assertUnchanged?.();
                    profileMutation.apply();
                },
            });
        }
        const plannedCompanionPaths = new Set<string>();
        for (const mutation of prepared) {
            plannedSteps.push({
                kind: "client-config",
                client: mutation.target.client,
                path: mutation.target.configPath,
                description: `${mutation.target.client} client configuration at ${mutation.target.configPath}`,
                changed: mutation.configMutation.changed,
                apply: () => {
                    mutation.configMutation.assertUnchanged?.();
                    mutation.configMutation.apply();
                },
            });
            for (const companion of mutation.companionMutations) {
                // Clients share the canonical skill; apply each path once.
                const companionKey = `${companion.companion.kind}:${companion.companion.path}`;
                if (plannedCompanionPaths.has(companionKey)) continue;
                plannedCompanionPaths.add(companionKey);
                plannedSteps.push({
                    kind: companion.companion.kind,
                    client: mutation.target.client,
                    path: companion.companion.path,
                    description: `${mutation.target.client} ${companion.companion.kind} at ${companion.companion.path}`,
                    changed: companion.changed,
                    apply: () => {
                        companion.assertUnchanged?.();
                        companion.apply();
                    },
                });
            }
        }

        const mutationSteps = command.dryRun ? [] : plannedSteps.filter((step) => step.changed);
        const applied: string[] = [];
        for (let index = 0; index < mutationSteps.length; index += 1) {
            const step = mutationSteps[index];
            try {
                step.apply();
                applied.push(step.description);
            } catch (error) {
                const cause = error instanceof Error ? error.message : String(error);
                const notYetApplied = mutationSteps.slice(index + 1).map((entry) => entry.description);
                throw new CliError(
                    command.kind === "install" ? "E_INSTALL_PARTIAL" : "E_UNINSTALL_PARTIAL",
                    `${command.kind === "install" ? "Installation" : "Uninstallation"} failed while applying ${step.description}: ${cause} `
                    + `Successfully changed: ${applied.length > 0 ? applied.join(", ") : "none"}. `
                    + `Not yet applied: ${notYetApplied.length > 0 ? notYetApplied.join(", ") : "none"}. `
                    + "The failing step may be partially applied; correct the error and rerun the same command.",
                    1,
                );
            }
        }
        if (installedManagedRuntimeCandidate) {
            pruneManagedRuntimeAfterActivation(
                homeDir,
                installedManagedRuntimeCandidate.runtimeRoot,
            );
        }
    } finally {
        releaseRuntimeMutationLock?.();
    }

    return {
        action: command.kind,
        client: command.client,
        dryRun: command.dryRun,
        packageSpecifier: command.kind === "install" ? packageSpecifier : undefined,
        profile: command.kind === "install" ? command.profile : undefined,
        profileConfigPath: command.kind === "install" ? profileMutation.filePath : undefined,
        profileConfigChanged: command.kind === "install" ? profileMutation.changed : undefined,
        runtime: command.kind === "install" ? command.runtime : undefined,
        runtimeEnvironment: command.kind === "install" && command.runtime
            ? runtimeEnvironment
            : undefined,
        ...(command.dryRun
            ? {
                plannedChanges: plannedSteps
                    .filter((step) => step.changed)
                    .map(({ kind, client, path: changePath }) => ({
                        kind,
                        ...(client ? { client } : {}),
                        path: changePath,
                    })),
            }
            : {}),
        results: prepared.map((mutation) => ({
            client: mutation.target.client,
            configPath: mutation.target.configPath,
            skillPath: mutation.target.companions.find((companion) => companion.kind === "skill-link")?.path
                ?? mutation.target.companions.find((companion) => companion.kind === "skill")?.path,
            configChanged: mutation.configChanged,
            skillChanged: mutation.companionMutations.some((entry) => (
                (entry.companion.kind === "skill" || entry.companion.kind === "skill-link") && entry.changed
            )),
            status: mutation.configChanged || mutation.companionMutations.some((entry) => entry.changed) || launcherMutation.changed || profileMutation.changed ? "updated" : "unchanged",
            dryRun: command.dryRun,
        })),
    };
}

export function readContainingPackageIdentity(
    runtimeEntry: string,
    packageName: string,
): ContainingPackageIdentity | null {
    let current = path.dirname(runtimeEntry);
    while (true) {
        const packageJsonPath = path.join(current, "package.json");
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
                name?: unknown;
                version?: unknown;
            };
            if (
                packageJson.name === packageName
                && typeof packageJson.version === "string"
                && EXACT_PACKAGE_VERSION_PATTERN.test(packageJson.version)
            ) {
                return {
                    version: packageJson.version,
                    packageRoot: current,
                };
            }
        } catch {
            // Continue walking toward the filesystem root.
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

export function resolveContainingManagedRuntimeRoot(homeDir: string, packageRoot: string): string | null {
    const storageRoot = path.join(homeDir, ".satori", MANAGED_RUNTIME_DIR);
    if (!isPathWithin(storageRoot, packageRoot)) {
        return null;
    }
    const relativePackageRoot = path.relative(fs.realpathSync(storageRoot), fs.realpathSync(packageRoot));
    const generationName = relativePackageRoot.split(path.sep)[0];
    if (!generationName) {
        return null;
    }
    const runtimeRoot = path.join(storageRoot, generationName);
    return isPathWithin(runtimeRoot, packageRoot) ? runtimeRoot : null;
}

export function pruneManagedRuntimeAfterActivation(
    homeDir: string,
    currentRuntimeRoot: string,
    env: NodeJS.ProcessEnv = process.env,
): void {
    const result = pruneManagedRuntimeStore({
        homeDir,
        currentRuntimeRoot,
        env,
    });
    for (const warning of result.warnings) {
        console.warn(`[RUNTIME-CLEANUP] ${warning}`);
    }
}
