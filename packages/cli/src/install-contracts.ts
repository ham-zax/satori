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
    LateOnModelProgressReporter,
} from "./lateon-model-store.js";

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
    "MILVUS_ADDRESS",
    "MILVUS_TOKEN",
    "READ_FILE_MAX_LINES",
    "MCP_ENABLE_WATCHER",
] as const;

export const RETIRED_SATORI_RUNTIME_ENV_VARS = [
    "SATORI_LATEON_REQUEST_DEADLINE_MS",
    "SATORI_LATEON_MAX_QUEUE_WAIT_MS",
    "SATORI_LATEON_RERANKER_STAGE_DEADLINE_MS",
    "SATORI_LATEON_MAX_ACTIVE_RERANKS",
    "SATORI_LATEON_MAX_QUEUED_RERANKS",
    "SATORI_LATEON_INTRA_OP_THREADS",
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
    fetchImpl?: typeof fetch;
    /** Structural test seam for LateOn acquisition; the production default binds the frozen digest. */
    lateOnAuthorityLoader?: LateOnAuthorityLoader;
    /** Test seam for proving LateOn acquisition deadline handling without waiting ten minutes. */
    lateOnNowImpl?: () => number;
    lateOnProgress?: LateOnModelProgressReporter;
    lateOnRetryCommand?: string;
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
 * skills directory. `legacy-*` companions exist only to remove output written
 * by earlier installers.
 */
export type CompanionTarget =
    | { kind: "skill"; path: string }
    | { kind: "skill-link"; path: string; target: string }
    | { kind: "legacy-skill"; path: string }
    | { kind: "legacy-instructions"; path: string }
    | { kind: "legacy-guidance-hook"; path: string };

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
