import fs from "node:fs";
import path from "node:path";
import {
    assertNetworkPolicyAllowsEndpoint,
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
    resolveOllamaModelIdentity,
    type ResolvedOllamaModelIdentity,
    type VectorDatabase,
} from "@zokizuan/satori-core";
import { connectCliMcpSession } from "./client.js";
import type { InstallRuntime, InstallVectorStore } from "./args.js";

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const PREFLIGHT_COLLECTION = "satori_install_preflight";

export interface InstallPreflightInput {
    runtime: InstallRuntime;
    homeDir: string;
    env: NodeJS.ProcessEnv;
    vectorStore?: InstallVectorStore;
    ollamaModel?: string;
}

export interface InstallPreflightResult {
    runtimeEnvironment: Readonly<Record<string, string>>;
    ollamaIdentity?: Readonly<ResolvedOllamaModelIdentity>;
}

export interface InstallPreflightDependencies {
    probeLanceDb?: (databasePath: string) => Promise<void>;
    resolveOllamaIdentity?: typeof resolveOllamaModelIdentity;
    probeCandidateRuntime?: (input: ManagedRuntimeCandidateProbeInput) => Promise<void>;
}

export interface ManagedRuntimeCandidateProbeInput {
    runtimeCommand: { command: string; args: readonly string[] };
    runtimeEnvironment: Readonly<Record<string, string>>;
    inheritedEnvironment: NodeJS.ProcessEnv;
    homeDir: string;
    expectedVersion: string;
}

type ProbeVectorDatabase = VectorDatabase & { close(): Promise<void> };
export type LanceDbModule = {
    LanceDbVectorDatabase: new (config: { databasePath: string }) => ProbeVectorDatabase;
};

export interface LanceDbProbeDependencies {
    loadLanceDb?: () => Promise<LanceDbModule>;
}

const EXPECTED_TOOL_NAMES = [
    "manage_index",
    "search_codebase",
    "call_graph",
    "file_outline",
    "read_file",
    "list_codebases",
] as const;

export async function probeManagedRuntimeCandidate(
    input: ManagedRuntimeCandidateProbeInput,
): Promise<void> {
    const session = await connectCliMcpSession({
        command: input.runtimeCommand.command,
        args: [...input.runtimeCommand.args],
        env: {
            ...input.inheritedEnvironment,
            ...input.runtimeEnvironment,
            HOME: input.homeDir,
            SATORI_RUN_MODE: "postflight",
        },
        startupTimeoutMs: 10_000,
        callTimeoutMs: 45_000,
        writeStderr: () => {},
    });
    try {
        const actualVersion = session.serverVersion?.version;
        if (actualVersion !== input.expectedVersion) {
            throw new Error(
                `Candidate runtime initialized satori@${actualVersion || "unknown"}; expected satori@${input.expectedVersion}.`,
            );
        }
        const actualTools = (await session.listTools()).tools.map((tool) => tool.name);
        if (
            actualTools.length !== EXPECTED_TOOL_NAMES.length
            || !actualTools.every((name, index) => name === EXPECTED_TOOL_NAMES[index])
        ) {
            throw new Error(
                `Candidate runtime tool surface mismatch: expected ${JSON.stringify(EXPECTED_TOOL_NAMES)}, received ${JSON.stringify(actualTools)}.`,
            );
        }
    } finally {
        await session.close();
    }
}

export function resolveLanceDbPath(homeDir: string, env: NodeJS.ProcessEnv): string {
    const configured = env.LANCEDB_PATH?.trim();
    const databasePath = configured || path.join(homeDir, ".satori", "vector", "lancedb");
    if (!path.isAbsolute(databasePath)) {
        throw new Error("LANCEDB_PATH must be absolute.");
    }
    return path.resolve(databasePath);
}

function nearestExistingDirectory(candidatePath: string): string {
    let current = candidatePath;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`No existing parent directory is available for LANCEDB_PATH '${candidatePath}'.`);
        }
        current = parent;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Existing LANCEDB_PATH ancestor '${current}' must be a real directory.`);
    }
    return current;
}

function assertNoSymlinkComponents(candidatePath: string): void {
    const root = path.parse(candidatePath).root;
    let current = root;
    for (const segment of candidatePath.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (!fs.existsSync(current)) return;
        if (fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`LANCEDB_PATH component '${current}' must not be a symbolic link.`);
        }
    }
}

function validateLanceDbTargetPath(databasePath: string): {
    existing: boolean;
    probeParent: string;
    filesystemReference: string;
} {
    assertNoSymlinkComponents(databasePath);
    if (fs.existsSync(databasePath)) {
        const stat = fs.lstatSync(databasePath);
        if (!stat.isDirectory()) {
            throw new Error(`LANCEDB_PATH '${databasePath}' must be a directory.`);
        }
        fs.accessSync(databasePath, fs.constants.R_OK | fs.constants.W_OK);
        const probeParent = path.dirname(databasePath);
        fs.accessSync(probeParent, fs.constants.W_OK);
        return { existing: true, probeParent, filesystemReference: databasePath };
    }

    const probeParent = nearestExistingDirectory(path.dirname(databasePath));
    fs.accessSync(probeParent, fs.constants.W_OK);
    return { existing: false, probeParent, filesystemReference: probeParent };
}

export async function probeLanceDbRuntime(
    databasePath: string,
    dependencies: LanceDbProbeDependencies = {},
): Promise<void> {
    const target = validateLanceDbTargetPath(databasePath);
    const loadLanceDb = dependencies.loadLanceDb ?? (async () => {
        const moduleSpecifier = "@zokizuan/satori-core/lancedb";
        return import(moduleSpecifier) as Promise<LanceDbModule>;
    });
    const { LanceDbVectorDatabase } = await loadLanceDb();
    // Locking, mmap, transactions, and FTS must be proven on the target
    // filesystem. A global temp directory can live on a materially different
    // filesystem and would make the preflight claim false.
    // Never place a synthetic database inside an existing live database root.
    // A sibling/ancestor probe is acceptable only when it resolves to the same
    // filesystem device as the configured target.
    const probeDirectory = fs.mkdtempSync(path.join(target.probeParent, ".satori-install-preflight-"));
    let database: ProbeVectorDatabase | null = null;
    try {
        if (fs.statSync(probeDirectory).dev !== fs.statSync(target.filesystemReference).dev) {
            throw new Error(`LanceDB preflight cannot prove target filesystem identity for '${databasePath}'.`);
        }
        database = new LanceDbVectorDatabase({ databasePath: probeDirectory });
        await database.createHybridCollection(PREFLIGHT_COLLECTION, 2, undefined, {
            deferIndexBuild: true,
        });
        await database.writeDocuments(PREFLIGHT_COLLECTION, [{
            document: {
                id: "preflight_document",
                vector: [1, 0],
                content: "satoripreflighttoken",
                relativePath: "preflight/probe.ts",
                startLine: 1,
                endLine: 1,
                fileExtension: ".ts",
                metadata: { language: "typescript" },
            },
            projections: {
                embeddingText: "satoripreflighttoken",
                lexicalText: "satoripreflighttoken",
                embeddingVersion: EMBEDDING_PROJECTION_VERSION,
                lexicalVersion: LEXICAL_PROJECTION_VERSION,
            },
        }]);
        await database.finalizeCollectionForSearch?.(PREFLIGHT_COLLECTION);
        const dense = await database.retrieveDense(PREFLIGHT_COLLECTION, {
            vector: [1, 0],
            limit: 1,
        });
        const lexical = await database.retrieveLexical(PREFLIGHT_COLLECTION, {
            query: "satoripreflighttoken",
            limit: 1,
        });
        if (dense[0]?.document.id !== "preflight_document" || lexical[0]?.document.id !== "preflight_document") {
            throw new Error("LanceDB preflight could not read the acknowledged probe row.");
        }

        await database.close();
        database = new LanceDbVectorDatabase({ databasePath: probeDirectory });
        const reopenedDense = await database.retrieveDense(PREFLIGHT_COLLECTION, {
            vector: [1, 0],
            limit: 1,
        });
        const reopenedLexical = await database.retrieveLexical(PREFLIGHT_COLLECTION, {
            query: "satoripreflighttoken",
            limit: 1,
        });
        if (
            reopenedDense[0]?.document.id !== "preflight_document"
            || reopenedLexical[0]?.document.id !== "preflight_document"
        ) {
            throw new Error("LanceDB preflight probe did not survive close and reopen.");
        }
        await database.dropCollection(PREFLIGHT_COLLECTION);

        if (target.existing) {
            await database.close();
            database = new LanceDbVectorDatabase({ databasePath });
            await database.listCollections();
        } else {
            const accessProbe = fs.mkdtempSync(path.join(target.probeParent, ".satori-path-preflight-"));
            fs.rmSync(accessProbe, { recursive: true, force: true });
        }
    } finally {
        if (database?.close) {
            await Promise.resolve(database.close()).catch(() => undefined);
        }
        fs.rmSync(probeDirectory, { recursive: true, force: true });
    }
}

export function selectedConnectedVectorStore(input: InstallPreflightInput): InstallVectorStore {
    if (input.vectorStore) {
        return input.vectorStore;
    }
    const configured = input.env.VECTOR_STORE_PROVIDER?.trim();
    if (configured !== undefined && configured !== "Milvus" && configured !== "LanceDB") {
        throw new Error("VECTOR_STORE_PROVIDER must be Milvus or LanceDB.");
    }
    return configured || (input.env.MILVUS_ADDRESS?.trim() ? "Milvus" : "LanceDB");
}

export function planInstallRuntimeEnvironment(
    input: InstallPreflightInput,
): Readonly<Record<string, string>> {
    if (input.runtime === "voyage") {
        const vectorStore = selectedConnectedVectorStore(input);
        return Object.freeze({
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: vectorStore,
            ...(vectorStore === "LanceDB"
                ? { LANCEDB_PATH: resolveLanceDbPath(input.homeDir, input.env) }
                : {}),
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "voyage-code-3",
            EMBEDDING_OUTPUT_DIMENSION: "1024",
        });
    }

    const model = input.ollamaModel?.trim();
    if (!model) {
        throw new Error("Offline install requires an Ollama model.");
    }
    const host = input.env.OLLAMA_HOST?.trim() || DEFAULT_OLLAMA_HOST;
    assertNetworkPolicyAllowsEndpoint({ kind: "local-only" }, host, "OLLAMA_HOST");
    return Object.freeze({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: resolveLanceDbPath(input.homeDir, input.env),
        EMBEDDING_PROVIDER: "Ollama",
        OLLAMA_MODEL: model,
        OLLAMA_HOST: host,
    });
}

export async function runInstallPreflight(
    input: InstallPreflightInput,
    dependencies: InstallPreflightDependencies = {},
): Promise<InstallPreflightResult> {
    const proposedEnvironment = planInstallRuntimeEnvironment(input);

    if (input.runtime === "voyage") {
        if (selectedConnectedVectorStore(input) === "LanceDB") {
            const databasePath = resolveLanceDbPath(input.homeDir, input.env);
            await (dependencies.probeLanceDb ?? probeLanceDbRuntime)(databasePath);
        }
        return {
            runtimeEnvironment: proposedEnvironment,
        };
    }

    const databasePath = resolveLanceDbPath(input.homeDir, input.env);
    await (dependencies.probeLanceDb ?? probeLanceDbRuntime)(databasePath);
    const model = input.ollamaModel?.trim();
    if (!model) {
        throw new Error("Offline install preflight requires an Ollama model.");
    }
    const host = input.env.OLLAMA_HOST?.trim() || DEFAULT_OLLAMA_HOST;
    assertNetworkPolicyAllowsEndpoint({ kind: "local-only" }, host, "OLLAMA_HOST");
    const identity = await (dependencies.resolveOllamaIdentity ?? resolveOllamaModelIdentity)({
        model,
        host,
    });
    return {
        runtimeEnvironment: Object.freeze({
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: databasePath,
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: identity.resolvedModel,
            OLLAMA_MODEL_DIGEST: identity.artifactDigest,
            EMBEDDING_OUTPUT_DIMENSION: String(identity.dimension),
            OLLAMA_HOST: host,
        }),
        ollamaIdentity: identity,
    };
}
