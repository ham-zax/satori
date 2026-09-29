import path from "node:path";
import { POTION_DIMENSION, POTION_MODEL_ID } from "./local-runtime-contract.js";
import { CliError } from "./errors.js";
import { satoriCliCommand } from "./cli-command.js";
import type {
    InstallOfflineReranker,
    InstallVectorStore,
} from "./args.js";
import { resolveClientTargets } from "./client-targets.js";
import { readPotionModelSpec, selectedConnectedVectorStore } from "./install-preflight.js";
import {
    hasSatoriClientEntry,
    readClientVectorStore,
    readManagedLauncherVectorStore,
} from "./client-config-inspection.js";
import type { InstallCommandInput } from "./install-contracts.js";
import {
    DEFAULT_LATEON_PROFILE_ID,
    ensureDefaultLateOnModel,
    resolveDefaultLateOnModelDirectory,
    verifyLateOnModelDirectory,
    type LateOnAuthorityLoader,
    type VerifiedLateOnModel,
} from "./lateon-model-store.js";
import { ensureModel, type ModelProgressReporter } from "./model-store.js";

/** The managed LateOn profile bound in the launcher when it is not the one current profile. */
function staleManagedLateOnProfile(
    managedEnvironment: Readonly<Record<string, string>>,
): string | null {
    const managed = managedEnvironment.SATORI_RERANKER_PROVIDER;
    const profile = managedEnvironment.SATORI_LATEON_PROFILE?.trim();
    if (managed === "lateon" && profile !== DEFAULT_LATEON_PROFILE_ID) {
        return profile || "(missing)";
    }
    if (!managed && profile && profile !== DEFAULT_LATEON_PROFILE_ID) {
        return profile;
    }
    return null;
}

function staleLateOnProfileError(profile: string): CliError {
    return new CliError(
        "E_USAGE",
        `Existing managed LateOn installation uses unsupported profile ${profile}. Reinstall with \`${satoriCliCommand("install --runtime offline --reranker lateon")}\`, or \`${satoriCliCommand("install --runtime offline --reranker none")}\` to disable LateOn.`,
        2,
    );
}

export function resolveOfflineReranker(
    command: Extract<InstallCommandInput, { kind: "install"; runtime: "offline" }>,
    managedEnvironment: Readonly<Record<string, string>>,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform | undefined,
    architecture: string | undefined,
): InstallOfflineReranker {
    const isQualifiedPlatform = (platform ?? process.platform) === "linux"
        && (architecture ?? process.arch) === "x64";
    const rejectUnsupportedLateOn = (): never => {
        throw new CliError(
            "E_USAGE",
            `LateOn D32 is supported only on Linux x64/WSL2; received ${platform ?? process.platform} ${architecture ?? process.arch}. Use --reranker none or an offline Ollama installation.`,
            2,
        );
    };
    if (command.reranker === "none") return "none";
    if (command.reranker === "lateon") {
        if (!isQualifiedPlatform) rejectUnsupportedLateOn();
        return "lateon";
    }

    const managedOffline = managedEnvironment.SATORI_RUNTIME_PROFILE === "offline";
    const configured = env.SATORI_RERANKER_PROVIDER?.trim();
    if (configured) {
        if (configured !== "lateon" && configured !== "none") {
            throw new CliError(
                "E_USAGE",
                `Offline installation supports SATORI_RERANKER_PROVIDER=lateon or none; received ${configured}.`,
                2,
            );
        }
        const staleProfile = managedOffline
            ? staleManagedLateOnProfile(managedEnvironment)
            : null;
        if (staleProfile) {
            throw staleLateOnProfileError(staleProfile);
        }
        if (configured === "lateon" && !isQualifiedPlatform) rejectUnsupportedLateOn();
        return configured;
    }

    if (managedOffline) {
        const managed = managedEnvironment.SATORI_RERANKER_PROVIDER;
        if (managed === "none") return "none";
        if (managed === "lateon") {
            const profile = managedEnvironment.SATORI_LATEON_PROFILE?.trim();
            if (profile !== DEFAULT_LATEON_PROFILE_ID) {
                throw staleLateOnProfileError(profile || "(missing)");
            }
            if (!isQualifiedPlatform) rejectUnsupportedLateOn();
            return "lateon";
        }
        if (managed) {
            throw new CliError(
                "E_USAGE",
                `Existing offline installation uses unsupported SATORI_RERANKER_PROVIDER=${managed}.`,
                2,
            );
        }
        const staleProfile = staleManagedLateOnProfile(managedEnvironment);
        if (staleProfile) {
            throw staleLateOnProfileError(staleProfile);
        }
        return isQualifiedPlatform ? "lateon" : "none";
    }

    return isQualifiedPlatform ? "lateon" : "none";
}

export function configuredLateOnModelPath(
    reranker: InstallOfflineReranker,
    managedEnvironment: Readonly<Record<string, string>>,
    env: NodeJS.ProcessEnv,
): string | undefined {
    if (reranker === "none") return undefined;
    const configured = env.SATORI_LATEON_MODEL_PATH?.trim()
        || managedEnvironment.SATORI_LATEON_MODEL_PATH?.trim();
    if (!configured) return undefined;
    if (!path.isAbsolute(configured)) {
        throw new CliError("E_USAGE", "SATORI_LATEON_MODEL_PATH must be absolute.", 2);
    }
    return path.resolve(configured);
}

export function assertDefaultLateOnProfile(
    reranker: InstallOfflineReranker,
    env: NodeJS.ProcessEnv,
    explicitSelection = false,
): void {
    if (reranker === "none" || explicitSelection) return;
    const configured = env.SATORI_LATEON_PROFILE?.trim();
    if (configured && configured !== DEFAULT_LATEON_PROFILE_ID) {
        throw new CliError(
            "E_USAGE",
            `Offline installation defaults to SATORI_LATEON_PROFILE=${DEFAULT_LATEON_PROFILE_ID}; received ${configured}.`,
            2,
        );
    }
}

export async function resolveVerifiedLateOnModel(
    homeDir: string,
    runtimePackageRoot: string | undefined,
    requestedModelDirectory: string | undefined,
    fetchImpl: typeof fetch | undefined,
    authorityLoader: LateOnAuthorityLoader | undefined,
    onProgress?: ModelProgressReporter,
    retryCommand?: string,
    retryDelaysMs?: readonly number[],
): Promise<VerifiedLateOnModel> {
    if (!runtimePackageRoot) {
        throw new CliError(
            "E_INSTALL_PREFLIGHT",
            "Managed LateOn D32 activation requires a resolvable @satori-code/mcp package root containing the frozen profile and acquisition manifest; refusing to use a predicted model path.",
            1,
        );
    }
    try {
        const defaultModelDirectory = resolveDefaultLateOnModelDirectory(homeDir);
        if (requestedModelDirectory && path.resolve(requestedModelDirectory) !== defaultModelDirectory) {
            return verifyLateOnModelDirectory({
                modelDirectory: requestedModelDirectory,
                runtimePackageRoot,
                authorityLoader,
            });
        }
        return await ensureDefaultLateOnModel({
            homeDir,
            runtimePackageRoot,
            fetchImpl,
            authorityLoader,
            onProgress,
            retryDelaysMs,
        });
    } catch (error) {
        if (error instanceof CliError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const retry = retryCommand ? `\nRetry: ${retryCommand}` : "";
        throw new CliError("E_INSTALL_PREFLIGHT", `LateOn D32 model preflight failed: ${message}${retry}`, 1);
    }
}

export async function resolveVerifiedPotionModel(
    homeDir: string,
    potionAssetsRoot: string,
    fetchImpl: typeof fetch | undefined,
    onProgress?: ModelProgressReporter,
    retryCommand?: string,
    env?: NodeJS.ProcessEnv,
    retryDelaysMs?: readonly number[],
): Promise<string> {
    try {
        const { modelDirectory } = await ensureModel({
            homeDir,
            spec: readPotionModelSpec(potionAssetsRoot),
            env,
            fetchImpl,
            onProgress,
            retryDelaysMs,
        });
        return modelDirectory;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retry = retryCommand ? `\nRetry: ${retryCommand}` : "";
        throw new CliError("E_INSTALL_PREFLIGHT", `Potion embedding model preflight failed: ${message}${retry}`, 1);
    }
}

export function resolveOfflineOllamaModel(
    command: Extract<InstallCommandInput, { kind: "install"; runtime: "offline" }>,
    managedEnvironment: Readonly<Record<string, string>>,
    env: NodeJS.ProcessEnv,
): string | undefined {
    if (command.ollamaModel) {
        return command.ollamaModel;
    }
    const managedOffline = managedEnvironment.SATORI_RUNTIME_PROFILE === "offline";
    const managedProvider = managedOffline ? managedEnvironment.EMBEDDING_PROVIDER : undefined;
    if (managedProvider && managedProvider !== "Ollama" && managedProvider !== "Potion") {
        throw new CliError(
            "E_USAGE",
            `Existing offline installation uses EMBEDDING_PROVIDER=${managedProvider}; expected Potion or Ollama. Reconcile the managed configuration before reinstalling.`,
            2,
        );
    }
    const preservedOllamaModel = managedProvider === "Ollama"
        ? managedEnvironment.EMBEDDING_MODEL
        : undefined;
    if (managedProvider === "Ollama" && !preservedOllamaModel) {
        throw new CliError(
            "E_USAGE",
            "Existing managed Ollama installation has no EMBEDDING_MODEL. Re-run with an explicit --ollama-model.",
            2,
        );
    }
    const expectedProvider = preservedOllamaModel ? "Ollama" : "Potion";
    const configuredProvider = env.EMBEDDING_PROVIDER?.trim();
    if (configuredProvider && configuredProvider !== expectedProvider) {
        throw new CliError(
            "E_USAGE",
            `EMBEDDING_PROVIDER=${configuredProvider} conflicts with the ${expectedProvider} offline installation selection. Remove the conflicting environment value or select Ollama explicitly with --ollama-model.`,
            2,
        );
    }
    if (!preservedOllamaModel) {
        const configuredModel = env.EMBEDDING_MODEL?.trim();
        if (configuredModel && configuredModel !== POTION_MODEL_ID) {
            throw new CliError(
                "E_USAGE",
                `EMBEDDING_MODEL=${configuredModel} conflicts with the pinned Potion model ${POTION_MODEL_ID}. Remove the conflicting environment value.`,
                2,
            );
        }
        const configuredDimension = env.EMBEDDING_OUTPUT_DIMENSION?.trim();
        if (configuredDimension && configuredDimension !== String(POTION_DIMENSION)) {
            throw new CliError(
                "E_USAGE",
                `EMBEDDING_OUTPUT_DIMENSION=${configuredDimension} conflicts with Potion dimension ${POTION_DIMENSION}. Remove the conflicting environment value.`,
                2,
            );
        }
    }
    return preservedOllamaModel;
}

export function readConfiguredClientVectorStore(
    homeDir: string,
    env: NodeJS.ProcessEnv = process.env,
): InstallVectorStore | undefined {
    const selections = resolveClientTargets(homeDir, env)
        .filter(hasSatoriClientEntry)
        .map(readClientVectorStore)
        .filter((value): value is InstallVectorStore => value !== undefined);
    const distinct = [...new Set(selections)];
    if (distinct.length > 1) {
        throw new CliError(
            "E_USAGE",
            "Configured Satori clients disagree about VECTOR_STORE_PROVIDER. Re-run install with an explicit --vector-store after reconciling literal client settings.",
            2,
        );
    }
    return distinct[0];
}

export function resolveConnectedVectorStoreForInstall(
    command: Extract<InstallCommandInput, { kind: "install" }>,
    homeDir: string,
    env: NodeJS.ProcessEnv,
    managedEnvironment?: Readonly<Record<string, string>>,
): InstallVectorStore {
    if (command.vectorStore) {
        return command.vectorStore;
    }
    const environmentSelection = env.VECTOR_STORE_PROVIDER === undefined
        ? undefined
        : selectedConnectedVectorStore({ runtime: "voyage", homeDir, env });
    const managedSelection = readManagedLauncherVectorStore(homeDir, managedEnvironment);
    const clientSelection = readConfiguredClientVectorStore(homeDir, env);
    const discovered = [environmentSelection, managedSelection, clientSelection]
        .filter((value): value is InstallVectorStore => value !== undefined);
    if (new Set(discovered).size > 1) {
        throw new CliError(
            "E_USAGE",
            "The installer environment, managed launcher, and configured Satori clients disagree about VECTOR_STORE_PROVIDER. Re-run install with an explicit --vector-store after reconciling literal client settings.",
            2,
        );
    }
    return environmentSelection
        ?? managedSelection
        ?? clientSelection
        ?? selectedConnectedVectorStore({ runtime: "voyage", homeDir, env });
}

export function resolveConnectedVectorStoreForInstallOrThrow(
    command: Extract<InstallCommandInput, { kind: "install" }>,
    homeDir: string,
    env: NodeJS.ProcessEnv,
    managedEnvironment?: Readonly<Record<string, string>>,
): InstallVectorStore {
    try {
        return resolveConnectedVectorStoreForInstall(command, homeDir, env, managedEnvironment);
    } catch (error) {
        if (error instanceof CliError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError("E_USAGE", message, 2);
    }
}