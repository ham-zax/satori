import { execFileSync } from "node:child_process";
import { readManagedPackageJson, resolveManagedPackageSpecifier } from "./managed-package.js";

type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
    name: string;
    status: CheckStatus;
    message: string;
}

export interface DoctorResult {
    status: CheckStatus;
    checks: DoctorCheck[];
    nextSteps: string[];
}

export interface DoctorOptions {
    env?: NodeJS.ProcessEnv;
    nodeVersion?: string;
    execFileSyncImpl?: typeof execFileSync;
}

function parseNodeMajor(version: string): number {
    const match = version.match(/^v?(\d+)/);
    return match ? Number(match[1]) : 0;
}

function selectedProvider(env: NodeJS.ProcessEnv): string {
    return env.EMBEDDING_PROVIDER || "VoyageAI";
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

export function runDoctor(options: DoctorOptions = {}): DoctorResult {
    const env = options.env || process.env;
    const nodeVersion = options.nodeVersion || process.version;
    const execImpl = options.execFileSyncImpl || execFileSync;
    const checks: DoctorCheck[] = [];
    const nextSteps: string[] = [];

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
    const requiredKey = requiredEmbeddingEnv(provider);
    if (requiredKey && !env[requiredKey]) {
        addCheck(checks, "embedding_provider_env", "error", `${provider} requires ${requiredKey}.`);
        nextSteps.push(`Set ${requiredKey}.`);
    } else {
        addCheck(checks, "embedding_provider_env", "ok", requiredKey ? `${requiredKey} is present.` : `${provider} does not require an API key.`);
    }

    if (!env.MILVUS_ADDRESS) {
        addCheck(checks, "milvus_address", "error", "MILVUS_ADDRESS is required for index/search/clear operations.");
        nextSteps.push("Set MILVUS_ADDRESS.");
    } else {
        addCheck(checks, "milvus_address", "ok", "MILVUS_ADDRESS is present.");
    }

    if (env.MILVUS_TOKEN) {
        addCheck(checks, "milvus_token", "ok", "MILVUS_TOKEN is present.");
    } else {
        addCheck(checks, "milvus_token", "ok", "MILVUS_TOKEN is not set; local/unauthenticated Milvus endpoints are supported.");
    }

    return {
        status: overallStatus(checks),
        checks,
        nextSteps: [...new Set(nextSteps)],
    };
}
