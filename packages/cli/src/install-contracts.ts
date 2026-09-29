import type { execFileSync } from "node:child_process";
import type {
    InstallClient,
    InstallOfflineReranker,
    InstallProfile,
    InstallRuntime,
    InstallVectorStore,
} from "./args.js";
import type {
    InstallPreflightDependencies,
    InstallPreflightInput,
    InstallPreflightResult,
} from "./install-preflight.js";
import type { TerminateOptions, TerminateResult } from "./terminate.js";
import type {
    LateOnAuthorityLoader,
} from "./lateon-model-store.js";
import type { ModelProgressReporter } from "./model-store.js";

export const SATORI_SKILL_NAME = "satori";
export const MANAGED_RUNTIME_DIR = "mcp-runtime";
export const MANAGED_BIN_DIR = "bin";
export const MANAGED_LAUNCHER_FILE = "satori-mcp.js";

export const SATORI_RUNTIME_ENV_VARS = [
    "SATORI_RUNTIME_PROFILE",
    "VECTOR_STORE_PROVIDER",
    "LANCEDB_PATH",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_OUTPUT_DIMENSION",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "VOYAGEAI_API_KEY",
    "VOYAGEAI_RERANKER_MODEL",
    "SATORI_RERANKER_PROVIDER",
    "SATORI_LATEON_MODEL_PATH",
    "SATORI_LATEON_PROFILE",
    "SATORI_LATEON_ACTIVATION_POLICY",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "OLLAMA_HOST",
    "OLLAMA_MODEL",
    "OLLAMA_MODEL_DIGEST",
    "POTION_HELPER_PATH",
    "POTION_MODEL_PATH",
    "POTION_REQUEST_TIMEOUT_MS",
    "SATORI_CBM_EXTENDED_DIR",
    "MILVUS_ADDRESS",
    "MILVUS_TOKEN",
    "READ_FILE_MAX_LINES",
    "MCP_ENABLE_WATCHER",
] as const;

export const LAUNCHER_OWNED_RUNTIME_ENV_VARS = [
    "SATORI_RUNTIME_PROFILE",
    "VECTOR_STORE_PROVIDER",
    "LANCEDB_PATH",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_OUTPUT_DIMENSION",
    "SATORI_RERANKER_PROVIDER",
    "SATORI_LATEON_MODEL_PATH",
    "SATORI_LATEON_PROFILE",
    "SATORI_LATEON_ACTIVATION_POLICY",
    "OLLAMA_HOST",
    "OLLAMA_MODEL",
    "POTION_HELPER_PATH",
    "POTION_MODEL_PATH",
    "POTION_REQUEST_TIMEOUT_MS",
    "SATORI_CBM_EXTENDED_DIR",
] as const;

export type ExecFileSyncLike = typeof execFileSync;

export type ClientName = Exclude<InstallClient, "auto" | "all">;

export interface ManagedRuntimeCommand {
    command: string;
    args: string[];
}

export type ManagedRuntimeUpgradePhase = "installing" | "verifying" | "activating";

type InstallCommandBase = {
    kind: "install";
    client: InstallClient;
    dryRun: boolean;
    profile?: InstallProfile;
};

export type InstallCommandInput =
    | (InstallCommandBase & {
        runtime: "voyage";
        vectorStore?: InstallVectorStore;
        ollamaModel?: never;
    })
    | (InstallCommandBase & {
        runtime: "offline";
        vectorStore?: "LanceDB";
        ollamaModel?: string;
        reranker?: InstallOfflineReranker;
    })
    | {
        kind: "uninstall";
        client: InstallClient;
        dryRun: boolean;
        /** Also stop Satori servers and delete all Satori-owned local data. */
        purge?: boolean;
    };

export interface InstallCommandOptions {
    homeDir?: string;
    repoDir?: string;
    packageSpecifier?: string;
    runtimeCommand?: ManagedRuntimeCommand;
    execFileSyncImpl?: ExecFileSyncLike;
    env?: NodeJS.ProcessEnv;
    preflightDependencies?: InstallPreflightDependencies;
    potionAssetsRoot?: string;
    lateOnModelPath?: string;
    /** Pre-verified Potion model directory; skips acquisition (tests and explicit paths). */
    potionModelPath?: string;
    /** Pre-verified extended CBM extractor pack; skips acquisition (tests and explicit paths). */
    cbmExtendedPath?: string;
    /** Non-fatal install problems, e.g. an unavailable extended language pack. */
    onInstallWarning?: (message: string) => void;
    fetchImpl?: typeof fetch;
    /** Structural test seam for LateOn acquisition; the production default binds the frozen digest. */
    lateOnAuthorityLoader?: LateOnAuthorityLoader;
    modelProgress?: ModelProgressReporter;
    /** Announces the slow install phases that have no byte-level progress. */
    onInstallProgress?: (phase: "runtime" | "configure") => void;
    /** Test seam: backoff before each model download retry. */
    modelRetryDelaysMs?: readonly number[];
    installRetryCommand?: string;
    platform?: NodeJS.Platform;
    architecture?: string;
    libc?: "gnu" | "musl";
    onUpgradeProgress?: (phase: ManagedRuntimeUpgradePhase) => void;
    preflightRunner?: (
        input: InstallPreflightInput,
        dependencies?: InstallPreflightDependencies,
    ) => Promise<InstallPreflightResult>;
    terminateRunner?: (options?: TerminateOptions) => Promise<TerminateResult>;
}

export interface ClientInstallResult {
    client: ClientName;
    configPath: string;
    skillPath?: string;
    configChanged: boolean;
    skillChanged: boolean;
    status: "updated" | "unchanged";
    dryRun: boolean;
}

export type PlannedChangeKind =
    | "runtime"
    | "launcher"
    | "profile"
    | "client-config"
    | CompanionTarget["kind"];

/** A file or directory an install or uninstall would create, modify, or remove. */
export interface PlannedChange {
    kind: PlannedChangeKind;
    client?: ClientName;
    path: string;
}

export interface InstallCommandResult {
    action: "install" | "uninstall";
    client: InstallClient;
    dryRun: boolean;
    /** Managed MCP package specifier used for runtime install (install only). */
    packageSpecifier?: string;
    profile?: InstallProfile;
    profileConfigPath?: string;
    profileConfigChanged?: boolean;
    runtime?: InstallRuntime;
    /** Non-secret runtime values persisted in the managed launcher. */
    runtimeEnvironment?: Readonly<Record<string, string>>;
    results: ClientInstallResult[];
    /** Dry runs only: every path the same command would change, in application order. */
    plannedChanges?: PlannedChange[];
    /** Directories removed (or, for a dry run, that would be removed) by uninstall --purge. */
    purgedPaths?: string[];
}

export interface ManagedRuntimeUpgradeResult {
    action: "upgrade";
    status: "upgraded" | "up_to_date";
    fromMcpVersion: string;
    toMcpVersion: string;
    fromCoreVersion: string;
    toCoreVersion: string;
    packageSpecifier: string;
    configuredClients: ClientName[];
    restartRequired: boolean;
}

export interface ClientTarget {
    client: ClientName;
    configPath: string;
    companions: CompanionTarget[];
}

/**
 * Satori guidance reaches agents through the MCP server's session-start
 * `instructions` and one canonical skill. `skill` is the shared copy that
 * agents load natively; `skill-link` adapts an agent that only reads its own
 * skills directory.
 */
export type CompanionTarget =
    | { kind: "skill"; path: string }
    | { kind: "skill-link"; path: string; target: string };

export interface ManagedClientConfigProof {
    client: ClientName;
    configPath: string;
    status: "ok" | "error";
    message: string;
    /** Client-owned runtime values resolved without exposing them in doctor output. */
    runtimeEnvironment?: Readonly<Record<string, string>>;
    /** Whether this client actually launches through ~/.satori/bin/satori-mcp.js. */
    usesManagedLauncher?: boolean;
}
