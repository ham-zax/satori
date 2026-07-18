import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
    assertNetworkPolicyAllowsEndpoint,
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
    POTION_DIMENSION,
    POTION_INFERENCE_CONTRACT_DIGEST,
    POTION_MODEL_ID,
    resolveOllamaModelIdentity,
    verifyPinnedPotionArtifacts,
    type ResolvedOllamaModelIdentity,
    type VectorDatabase,
} from "@zokizuan/satori-core";
import { connectCliMcpSession } from "./client.js";
import type { InstallRuntime, InstallVectorStore } from "./args.js";

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const DEFAULT_POTION_REQUEST_TIMEOUT_MS = "5000";
const PREFLIGHT_COLLECTION = "satori_install_preflight";

export interface InstallPreflightInput {
    runtime: InstallRuntime;
    homeDir: string;
    env: NodeJS.ProcessEnv;
    vectorStore?: InstallVectorStore;
    ollamaModel?: string;
    potionAssetsRoot?: string;
    platform?: NodeJS.Platform;
    architecture?: string;
}

export interface InstallPreflightResult {
    runtimeEnvironment: Readonly<Record<string, string>>;
    ollamaIdentity?: Readonly<ResolvedOllamaModelIdentity>;
}

export interface InstallPreflightDependencies {
    probeLanceDb?: (databasePath: string) => Promise<void>;
    resolveOllamaIdentity?: typeof resolveOllamaModelIdentity;
    verifyPotionRuntime?: (assetsRoot: string) => Promise<void>;
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

interface PotionArtifactManifest {
    schemaVersion: number;
    platform: string;
    architecture: string;
    model: { identity: string };
    embeddingInferenceContractDigest: string;
    files: Array<{
        path: string;
        bytes: number;
        sha256: string;
        executable?: boolean;
    }>;
}

const REQUIRED_POTION_ARTIFACT_PATHS = new Set([
    "satori-potion",
    "model/config.json",
    "model/model.safetensors",
    "model/tokenizer.json",
    "MODEL_CARD.md",
    "MODEL2VEC_RS_LICENSE",
]);

function potionRuntimePaths(assetsRoot: string): { helperPath: string; modelPath: string } {
    if (!path.isAbsolute(assetsRoot)) {
        throw new Error("Potion asset root must be absolute.");
    }
    return {
        helperPath: path.join(assetsRoot, "satori-potion"),
        modelPath: path.join(assetsRoot, "model"),
    };
}

function sha256File(filePath: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export async function verifyBundledPotionRuntime(assetsRoot: string): Promise<void> {
    const manifestPath = path.join(assetsRoot, "manifest.json");
    let manifest: PotionArtifactManifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PotionArtifactManifest;
    } catch {
        throw new Error(`Bundled Potion manifest is missing or invalid at '${manifestPath}'.`);
    }
    if (
        manifest.schemaVersion !== 1
        || manifest.platform !== "linux"
        || manifest.architecture !== "x64"
        || manifest.model?.identity !== POTION_MODEL_ID
        || manifest.embeddingInferenceContractDigest !== POTION_INFERENCE_CONTRACT_DIGEST
        || !Array.isArray(manifest.files)
    ) {
        throw new Error("Bundled Potion manifest does not match the pinned runtime authority.");
    }
    const manifestedPaths = manifest.files.map((artifact) => artifact.path);
    if (
        manifestedPaths.length !== REQUIRED_POTION_ARTIFACT_PATHS.size
        || new Set(manifestedPaths).size !== REQUIRED_POTION_ARTIFACT_PATHS.size
        || manifestedPaths.some((artifactPath) => !REQUIRED_POTION_ARTIFACT_PATHS.has(artifactPath))
    ) {
        throw new Error("Bundled Potion manifest does not contain the complete pinned artifact closure.");
    }
    for (const artifact of manifest.files) {
        if (
            typeof artifact.path !== "string"
            || path.isAbsolute(artifact.path)
            || artifact.path.split(/[\\/]/).includes("..")
            || !Number.isSafeInteger(artifact.bytes)
            || artifact.bytes < 0
            || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        ) {
            throw new Error("Bundled Potion manifest contains an invalid artifact entry.");
        }
        const artifactPath = path.join(assetsRoot, artifact.path);
        const stat = fs.lstatSync(artifactPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error(`Bundled Potion artifact '${artifact.path}' must be a regular file.`);
        }
        if (stat.size !== artifact.bytes || sha256File(artifactPath) !== artifact.sha256) {
            throw new Error(`Bundled Potion artifact '${artifact.path}' failed checksum verification.`);
        }
        if (artifact.executable) {
            // npm normalizes non-bin package files to 0644. Restore only the
            // owning user's execute bit after the immutable bytes are proven.
            if ((stat.mode & fs.constants.S_IXUSR) === 0) {
                fs.chmodSync(artifactPath, stat.mode | fs.constants.S_IXUSR);
            }
            fs.accessSync(artifactPath, fs.constants.X_OK);
        }
    }
    const { helperPath, modelPath } = potionRuntimePaths(assetsRoot);
    await verifyPinnedPotionArtifacts({ helperPath, modelPath });
}

function assertSupportedPotionPlatform(input: InstallPreflightInput): void {
    const platform = input.platform ?? process.platform;
    const architecture = input.architecture ?? process.arch;
    if (platform !== "linux" || architecture !== "x64") {
        throw new Error(
            `Potion offline installation supports Linux x64; received ${platform} ${architecture}. `
            + "Use an explicit --ollama-model for the existing portable offline path.",
        );
    }
}

const EXPECTED_TOOL_NAMES = [
    "manage_index",
    "search_codebase",
    "continue_search",
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
        assertSupportedPotionPlatform(input);
        if (!input.potionAssetsRoot) {
            throw new Error("Potion offline installation requires the bundled runtime asset root.");
        }
        const { helperPath, modelPath } = potionRuntimePaths(input.potionAssetsRoot);
        return Object.freeze({
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: resolveLanceDbPath(input.homeDir, input.env),
            EMBEDDING_PROVIDER: "Potion",
            EMBEDDING_MODEL: POTION_MODEL_ID,
            EMBEDDING_OUTPUT_DIMENSION: String(POTION_DIMENSION),
            POTION_HELPER_PATH: helperPath,
            POTION_MODEL_PATH: modelPath,
            POTION_REQUEST_TIMEOUT_MS: DEFAULT_POTION_REQUEST_TIMEOUT_MS,
        });
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
        assertSupportedPotionPlatform(input);
        if (!input.potionAssetsRoot) {
            throw new Error("Potion offline install preflight requires the bundled runtime asset root.");
        }
        await (dependencies.verifyPotionRuntime ?? verifyBundledPotionRuntime)(input.potionAssetsRoot);
        return { runtimeEnvironment: proposedEnvironment };
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
