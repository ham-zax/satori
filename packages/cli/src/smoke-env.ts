import path from "node:path";

/**
 * pnpm injects a set of npm_config_* variables into script processes that
 * modern npm rejects or fails on (such as EALLOWSCRIPTS); drop them when spawning npm children.
 */
const PNPM_ONLY_NPM_ENV_KEYS = new Set([
    "NPM_CONFIG__JSR_REGISTRY",
    "NPM_CONFIG_ALLOW_SCRIPTS",
    "NPM_CONFIG_AUTO_INSTALL_PEERS",
    "NPM_CONFIG_CACHE_DIR",
    "NPM_CONFIG_CHILD_CONCURRENCY",
    "NPM_CONFIG_DEDUPE_PEER_DEPENDENTS",
    "NPM_CONFIG_DIR",
    "NPM_CONFIG_IGNORE_WORKSPACE_ROOT_CHECK",
    "NPM_CONFIG_NPM_GLOBALCONFIG",
    "NPM_CONFIG_PREFER_FROZEN_LOCKFILE",
    "NPM_CONFIG_SHELL_EMULATOR",
    "NPM_CONFIG_STORE_DIR",
    "NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN",
]);

function isSatoriRuntimeEnvKey(key: string): boolean {
    return /^(?:SATORI_|EMBEDDING_|OPENAI_|VOYAGEAI_|GEMINI_|POTION_|MILVUS_)/.test(key)
        || key === "VECTOR_STORE_PROVIDER"
        || key === "LANCEDB_PATH";
}

/**
 * Build an isolated environment for packed-CLI smoke runs: the operator's
 * Satori runtime variables and pnpm-only npm config never cross into the
 * installed closure.
 */
export function isolatedSmokeEnv(
    smokeHomeDir: string,
    sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(sourceEnv).filter(
        ([key]) => !PNPM_ONLY_NPM_ENV_KEYS.has(key.toUpperCase()) && !isSatoriRuntimeEnvKey(key),
    ));
    return {
        ...env,
        HOME: smokeHomeDir,
        USERPROFILE: smokeHomeDir,
        XDG_CONFIG_HOME: path.join(smokeHomeDir, ".config"),
        npm_config_package_lock: "false",
    };
}
