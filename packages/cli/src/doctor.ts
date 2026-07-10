import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
    readManagedPackageJson,
    resolveManagedPackageJsonPath,
    resolveManagedPackageSpecifier,
} from "./managed-package.js";

type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
    name: string;
    status: CheckStatus;
    message: string;
}

export interface DoctorPackageVersion {
    name: string;
    version: string | null;
    /** Where the version was resolved from, for support/debugging. */
    source: string;
}

export interface DoctorResult {
    status: CheckStatus;
    /** Installed Satori package set (independent versions are expected). */
    packageVersions: DoctorPackageVersion[];
    /** Operator note about multi-package versioning. */
    packageVersionNote: string;
    checks: DoctorCheck[];
    nextSteps: string[];
}

export interface DoctorOptions {
    env?: NodeJS.ProcessEnv;
    nodeVersion?: string;
    execFileSyncImpl?: typeof execFileSync;
    /** Optional override for tests; defaults to resolveInstalledPackageVersions(). */
    resolvePackageVersions?: () => DoctorPackageVersion[];
    /** Override runtime owner registry path (default: ~/.satori/runtime/owners.json). */
    runtimeOwnersPath?: string;
    /** Override process liveness check (default: process.kill(pid, 0)). */
    isProcessLive?: (pid: number) => boolean;
}

const PACKAGE_VERSION_NOTE =
    "Satori ships independent package versions (cli, mcp, core). Doctor reports the installed set for support and debugging; versions need not match each other.";
const SUPPORTED_EMBEDDING_PROVIDERS = new Set(["OpenAI", "VoyageAI", "Gemini", "Ollama"]);

const requireFromHere = createRequire(import.meta.url);

function parseNodeMajor(version: string): number {
    const match = version.match(/^v?(\d+)/);
    return match ? Number(match[1]) : 0;
}

function selectedProvider(env: NodeJS.ProcessEnv): string {
    return env.EMBEDDING_PROVIDER || "VoyageAI";
}

function defaultModelForProvider(provider: string): string {
    switch (provider) {
        case "OpenAI":
            return "text-embedding-3-small";
        case "VoyageAI":
            return "voyage-code-3";
        case "Gemini":
            return "gemini-embedding-001";
        case "Ollama":
            return "nomic-embed-text";
        default:
            return "voyage-code-3";
    }
}

function selectedModel(env: NodeJS.ProcessEnv, provider: string): string {
    if (provider === "Ollama") {
        return env.OLLAMA_MODEL || env.EMBEDDING_MODEL || defaultModelForProvider(provider);
    }
    return env.EMBEDDING_MODEL || defaultModelForProvider(provider);
}

function selectedDimension(env: NodeJS.ProcessEnv, provider: string): string {
    if (env.EMBEDDING_OUTPUT_DIMENSION) {
        return env.EMBEDDING_OUTPUT_DIMENSION;
    }
    return provider === "VoyageAI" ? "1024" : "provider default";
}

function requiredEmbeddingEnv(provider: string): string | null {
    switch (provider) {
        case "OpenAI":
            return "OPENAI_API_KEY";
        case "VoyageAI":
            return "VOYAGEAI_API_KEY";
        case "Gemini":
            return "GEMINI_API_KEY";
        case "Ollama":
            return null;
        default:
            return "VOYAGEAI_API_KEY";
    }
}

function addCheck(checks: DoctorCheck[], name: string, status: CheckStatus, message: string): void {
    checks.push({ name, status, message });
}

function overallStatus(checks: DoctorCheck[]): CheckStatus {
    if (checks.some((check) => check.status === "error")) {
        return "error";
    }
    if (checks.some((check) => check.status === "warning")) {
        return "warning";
    }
    return "ok";
}

function readJsonVersion(packageJsonPath: string): { name: string; version: string } | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
        if (typeof parsed.name === "string" && typeof parsed.version === "string") {
            return { name: parsed.name, version: parsed.version };
        }
    } catch {
        // unresolved
    }
    return null;
}

function resolvePackageJsonPath(packageName: string, monorepoSegment: string): { path: string; source: string } | null {
    try {
        const resolved = requireFromHere.resolve(`${packageName}/package.json`);
        return { path: resolved, source: resolved };
    } catch {
        // fall through to monorepo sibling layout (dev / workspace)
    }

    const currentFile = fileURLToPath(import.meta.url);
    // packages/cli/src|dist → packages/<segment>/package.json
    const monorepoPath = path.resolve(path.dirname(currentFile), "..", "..", monorepoSegment, "package.json");
    if (fs.existsSync(monorepoPath)) {
        return { path: monorepoPath, source: monorepoPath };
    }
    return null;
}

/**
 * Resolve @zokizuan/satori-core via the installed MCP package.
 * Production installs often nest core under mcp/node_modules; CLI cannot see it via its own require.
 */
export function resolveCorePackageVersionViaMcp(options?: {
    /** Test override: absolute path to MCP package.json used as createRequire root. */
    mcpPackageJsonPath?: string;
}): DoctorPackageVersion | null {
    try {
        const mcpPackageJsonPath = options?.mcpPackageJsonPath ?? resolveManagedPackageJsonPath();
        const requireFromMcp = createRequire(mcpPackageJsonPath);
        const corePackageJsonPath = requireFromMcp.resolve("@zokizuan/satori-core/package.json");
        const info = readJsonVersion(corePackageJsonPath);
        if (!info) {
            return null;
        }
        return { name: info.name, version: info.version, source: corePackageJsonPath };
    } catch {
        return null;
    }
}

/**
 * Resolve the installed Satori package version set for operator support.
 * Independent package versions are expected; this is not a lockstep matrix.
 */
export function resolveInstalledPackageVersions(): DoctorPackageVersion[] {
    const entries: Array<{ packageName: string; monorepoSegment: string; preferredRead?: () => DoctorPackageVersion | null }> = [
        {
            packageName: "@zokizuan/satori-cli",
            monorepoSegment: "cli",
            preferredRead: () => {
                const currentFile = fileURLToPath(import.meta.url);
                const cliPackageJson = path.resolve(path.dirname(currentFile), "..", "package.json");
                const info = readJsonVersion(cliPackageJson);
                if (!info) {
                    return null;
                }
                return { name: info.name, version: info.version, source: cliPackageJson };
            },
        },
        {
            packageName: "@zokizuan/satori-mcp",
            monorepoSegment: "mcp",
            preferredRead: () => {
                try {
                    const pkg = readManagedPackageJson();
                    const name = typeof pkg.name === "string" ? pkg.name : null;
                    const version = typeof pkg.version === "string" ? pkg.version : null;
                    if (!name || !version) {
                        return null;
                    }
                    const source = resolvePackageJsonPath(name, "mcp")?.source
                        || "managed-package";
                    return { name, version, source };
                } catch {
                    return null;
                }
            },
        },
        {
            packageName: "@zokizuan/satori-core",
            monorepoSegment: "core",
            // Prefer MCP-rooted resolution so nested production installs do not false-warn.
            preferredRead: () => resolveCorePackageVersionViaMcp(),
        },
    ];

    return entries.map(({ packageName, monorepoSegment, preferredRead }) => {
        if (preferredRead) {
            const preferred = preferredRead();
            if (preferred) {
                return preferred;
            }
        }
        const resolved = resolvePackageJsonPath(packageName, monorepoSegment);
        if (!resolved) {
            return { name: packageName, version: null, source: "unresolved" };
        }
        const info = readJsonVersion(resolved.path);
        if (!info) {
            return { name: packageName, version: null, source: resolved.source };
        }
        return { name: info.name, version: info.version, source: resolved.source };
    });
}

export function runDoctor(options: DoctorOptions = {}): DoctorResult {
    const env = options.env || process.env;
    const nodeVersion = options.nodeVersion || process.version;
    const execImpl = options.execFileSyncImpl || execFileSync;
    const checks: DoctorCheck[] = [];
    const nextSteps: string[] = [];
    const packageVersions = options.resolvePackageVersions
        ? options.resolvePackageVersions()
        : resolveInstalledPackageVersions();

    for (const pkg of packageVersions) {
        const shortName = pkg.name.includes("/")
            ? pkg.name.slice(pkg.name.lastIndexOf("/") + 1).replace(/^satori-/, "")
            : pkg.name;
        // shortName → cli | mcp | core for stable check ids
        const checkName = `package_version_${shortName}`;
        if (pkg.version) {
            addCheck(checks, checkName, "ok", `${pkg.name}@${pkg.version}`);
        } else {
            addCheck(
                checks,
                checkName,
                "warning",
                `${pkg.name} version could not be resolved (${pkg.source}).`,
            );
        }
    }
    addCheck(checks, "package_version_policy", "ok", PACKAGE_VERSION_NOTE);

    const nodeMajor = parseNodeMajor(nodeVersion);
    if (nodeMajor >= 20) {
        addCheck(checks, "node_version", "ok", `Node ${nodeVersion} satisfies >=20.`);
    } else {
        addCheck(checks, "node_version", "error", `Node ${nodeVersion} is unsupported. Install Node.js 20 or newer.`);
        nextSteps.push("Install Node.js 20 or newer.");
    }

    try {
        const specifier = resolveManagedPackageSpecifier();
        const pkg = readManagedPackageJson();
        execImpl("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        addCheck(checks, "npm_package_access", "ok", `${specifier} is visible to npm.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addCheck(checks, "npm_package_access", "warning", `Could not verify npm package access: ${message}`);
        nextSteps.push("Verify npm can access @zokizuan/satori-mcp from this machine.");
    }

    const provider = selectedProvider(env);
    if (SUPPORTED_EMBEDDING_PROVIDERS.has(provider)) {
        addCheck(checks, "embedding_provider", "ok", `Embedding provider: ${provider}.`);
    } else {
        addCheck(
            checks,
            "embedding_provider",
            "error",
            `Unsupported embedding provider: ${provider}. Use OpenAI, VoyageAI, Gemini, or Ollama.`,
        );
        nextSteps.push("Set EMBEDDING_PROVIDER to OpenAI, VoyageAI, Gemini, or Ollama.");
    }
    addCheck(checks, "embedding_model", "ok", `Embedding model: ${selectedModel(env, provider)}.`);
    addCheck(checks, "embedding_dimension", "ok", `Embedding output dimension: ${selectedDimension(env, provider)}.`);

    const requiredKey = requiredEmbeddingEnv(provider);
    const requiredKeyValue = requiredKey ? env[requiredKey]?.trim() : undefined;
    if (requiredKey && !requiredKeyValue) {
        const blankButPresent = requiredKey in env;
        addCheck(
            checks,
            "embedding_provider_env",
            "error",
            blankButPresent
                ? `${provider} requires a non-empty ${requiredKey} (empty string is incomplete).`
                : `${provider} requires ${requiredKey}.`,
        );
        if (provider === "VoyageAI") {
            nextSteps.push("Set VOYAGEAI_API_KEY from the Voyage AI dashboard API keys page.");
        } else {
            nextSteps.push(`Set ${requiredKey}.`);
        }
    } else {
        addCheck(checks, "embedding_provider_env", "ok", requiredKey ? `${requiredKey} is present.` : `${provider} does not require an API key.`);
    }

    const milvusAddress = env.MILVUS_ADDRESS?.trim();
    if (!milvusAddress) {
        const blankButPresent = "MILVUS_ADDRESS" in env;
        addCheck(
            checks,
            "milvus_address",
            "error",
            blankButPresent
                ? "MILVUS_ADDRESS is required and must be non-empty (empty string is incomplete)."
                : "MILVUS_ADDRESS is required for index/search/clear operations.",
        );
        nextSteps.push("Set MILVUS_ADDRESS to a Zilliz Cloud public endpoint or local Milvus address such as localhost:19530.");
    } else {
        addCheck(checks, "milvus_address", "ok", "MILVUS_ADDRESS is present.");
    }

    if (env.MILVUS_TOKEN) {
        addCheck(checks, "milvus_token", "ok", "MILVUS_TOKEN is present.");
    } else {
        addCheck(checks, "milvus_token", "ok", "MILVUS_TOKEN is not set; local/unauthenticated Milvus endpoints are supported.");
    }

    const runtimeOwnersPath = options.runtimeOwnersPath
        || path.join(os.homedir(), ".satori", "runtime", "owners.json");
    const isProcessLive = options.isProcessLive || ((pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    });
    appendRuntimeOwnerChecks(checks, nextSteps, runtimeOwnersPath, isProcessLive);

    if (nextSteps.length > 0) {
        nextSteps.push("Restart your MCP client after changing Satori environment variables.");
    }

    return {
        status: overallStatus(checks),
        packageVersions,
        packageVersionNote: PACKAGE_VERSION_NOTE,
        checks,
        nextSteps: [...new Set(nextSteps)],
    };
}

function appendRuntimeOwnerChecks(
    checks: DoctorCheck[],
    nextSteps: string[],
    runtimeOwnersPath: string,
    isProcessLive: (pid: number) => boolean,
): void {
    if (!fs.existsSync(runtimeOwnersPath)) {
        addCheck(checks, "runtime_owners", "ok", "No runtime owner registry yet (no concurrent MCP owners recorded).");
        return;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(runtimeOwnersPath, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addCheck(checks, "runtime_owners", "warning", `Could not parse runtime owner registry at ${runtimeOwnersPath}: ${message}`);
        nextSteps.push(`Inspect or remove the corrupt runtime owner file at ${runtimeOwnersPath}, then restart Satori MCP clients.`);
        return;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { owners?: unknown }).owners)) {
        addCheck(checks, "runtime_owners", "warning", `Runtime owner registry shape is invalid at ${runtimeOwnersPath}.`);
        nextSteps.push(`Fix or remove ${runtimeOwnersPath}, then restart Satori MCP clients.`);
        return;
    }

    const owners = (parsed as { owners: Array<Record<string, unknown>> }).owners;
    const live = owners.filter((owner) => typeof owner.pid === "number" && isProcessLive(owner.pid));
    const dead = owners.length - live.length;
    if (live.length === 0) {
        addCheck(
            checks,
            "runtime_owners",
            dead > 0 ? "warning" : "ok",
            dead > 0
                ? `Runtime owner registry has ${dead} stale (dead) entr${dead === 1 ? "y" : "ies"} and no live MCP owners at ${runtimeOwnersPath}.`
                : `Runtime owner registry is empty at ${runtimeOwnersPath}.`,
        );
        if (dead > 0) {
            nextSteps.push("Start any Satori MCP client once so dead runtime owners prune, or remove stale entries from ~/.satori/runtime/owners.json after all MCP processes exit.");
        }
        return;
    }

    const versions = [...new Set(live.map((owner) => String(owner.satoriVersion || "unknown")))];
    const pids = live.map((owner) => String(owner.pid)).join(", ");
    if (versions.length > 1) {
        addCheck(
            checks,
            "runtime_owners",
            "error",
            `Multiple live Satori MCP versions are registered (pids ${pids}; versions ${versions.join(", ")}). manage_index create/reindex/sync/clear will return runtime_owner_conflict.`,
        );
        nextSteps.push(
            `Stop extra Satori MCP clients so only one version remains (live pids: ${pids}). Do not leave mixed package versions (e.g. 4.11.13 and 4.11.14) attached to the same ~/.satori state.`,
        );
        return;
    }

    if (live.length > 1) {
        addCheck(
            checks,
            "runtime_owners",
            "ok",
            `${live.length} live Satori MCP processes share version ${versions[0]} (pids ${pids}). Same identity is allowed; stop extras only if you want a single client.`,
        );
        return;
    }

    addCheck(
        checks,
        "runtime_owners",
        "ok",
        `One live Satori MCP owner: pid=${pids} satori@${versions[0]}.`,
    );
}
