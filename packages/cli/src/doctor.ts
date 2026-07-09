import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readManagedPackageJson, resolveManagedPackageSpecifier } from "./managed-package.js";

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
}

const PACKAGE_VERSION_NOTE =
    "Satori ships independent package versions (cli, mcp, core). Doctor reports the installed set for support and debugging; versions need not match each other.";

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
            return "voyage-4-large";
        case "Gemini":
            return "gemini-embedding-001";
        case "Ollama":
            return "nomic-embed-text";
        default:
            return "voyage-4-large";
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
    addCheck(checks, "embedding_provider", "ok", `Embedding provider: ${provider}.`);
    addCheck(checks, "embedding_model", "ok", `Embedding model: ${selectedModel(env, provider)}.`);
    addCheck(checks, "embedding_dimension", "ok", `Embedding output dimension: ${selectedDimension(env, provider)}.`);

    const requiredKey = requiredEmbeddingEnv(provider);
    if (requiredKey && !env[requiredKey]) {
        addCheck(checks, "embedding_provider_env", "error", `${provider} requires ${requiredKey}.`);
        if (provider === "VoyageAI") {
            nextSteps.push("Set VOYAGEAI_API_KEY from the Voyage AI dashboard API keys page.");
        } else {
            nextSteps.push(`Set ${requiredKey}.`);
        }
    } else {
        addCheck(checks, "embedding_provider_env", "ok", requiredKey ? `${requiredKey} is present.` : `${provider} does not require an API key.`);
    }

    if (!env.MILVUS_ADDRESS) {
        addCheck(checks, "milvus_address", "error", "MILVUS_ADDRESS is required for index/search/clear operations.");
        nextSteps.push("Set MILVUS_ADDRESS to a Zilliz Cloud public endpoint or local Milvus address such as localhost:19530.");
    } else {
        addCheck(checks, "milvus_address", "ok", "MILVUS_ADDRESS is present.");
    }

    if (env.MILVUS_TOKEN) {
        addCheck(checks, "milvus_token", "ok", "MILVUS_TOKEN is present.");
    } else {
        addCheck(checks, "milvus_token", "ok", "MILVUS_TOKEN is not set; local/unauthenticated Milvus endpoints are supported.");
    }

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
