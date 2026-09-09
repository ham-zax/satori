import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSearchRerankRequestContract } from "../core/search-rerank-request-contract.js";
import {
    LATEON_ACTIVATION_POLICY_IDS,
    LATEON_RUNTIME_PROFILE_IDS,
} from "./lateon-reranker-protocol.js";

export const SHARED_RUNTIME_PROTOCOL_VERSION = 2;
export const SHARED_RUNTIME_HANDSHAKE_MAX_BYTES = 16 * 1024;
export const SHARED_RUNTIME_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;
export const SHARED_RUNTIME_MAX_PENDING_REQUESTS = 16;
export const SHARED_RUNTIME_ATTACH_TIMEOUT_MS = 10_000;
export const SHARED_RUNTIME_IDLE_MS = 60_000;

export type SharedRuntimeIdentity = Readonly<{
    protocolVersion: number;
    mcpVersion: string;
    installedRuntimeRoot: string;
    stateRoot: string;
    serverName: string;
    serverVersion: string;
    runtimeProfile: string;
    embeddingProvider: string;
    embeddingModel: string;
    embeddingDimension: string;
    hybridMode: string;
    embeddingBatchSize: string;
    potionHelperPath: string;
    potionModelPath: string;
    potionRequestTimeoutMs: string;
    rerankerProvider: string;
    voyageRerankerModel: string;
    lateOnModelPath: string;
    lateOnProfile: string;
    lateOnActivationPolicy: string;
    lateOnRequestContractSha256: string;
    vectorStoreProvider: string;
    lanceDbPath: string;
    watcherEnabled: string;
    autoIndexWorkspace: string;
    readFileMaxLines: string;
    readFileMaxBytes: string;
    customExtensions: string;
    customIgnorePatterns: string;
    allTextMaxBytes: string;
    syncHashConcurrency: string;
    syncFullHashEveryN: string;
    sourceMeasurementLedger: string;
    sourceMeasurementRoot: string;
    hash: string;
}>;

export type SharedRuntimePaths = Readonly<{
    stateRoot: string;
    metadataDirectory: string;
    metadataPath: string;
    errorPath: string;
    lockPath: string;
    socketDirectory: string;
    socketPath: string;
}>;

function stableStringify(value: Record<string, string | number>): string {
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
        .join(",")}}`;
}

function canonicalizePath(candidatePath: string): string {
    const absolutePath = path.resolve(candidatePath);
    let existingPath = absolutePath;
    while (!fs.existsSync(existingPath)) {
        const parent = path.dirname(existingPath);
        if (parent === existingPath) {
            return absolutePath;
        }
        existingPath = parent;
    }
    const canonicalExistingPath = fs.realpathSync(existingPath);
    return path.resolve(
        canonicalExistingPath,
        path.relative(existingPath, absolutePath),
    );
}

function readPackageVersion(runtimeEntry: string): {
    version: string;
    packageRoot: string;
} {
    let current = path.dirname(path.resolve(runtimeEntry));
    for (;;) {
        const packagePath = path.join(current, "package.json");
        if (fs.existsSync(packagePath)) {
            const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
                name?: unknown;
                version?: unknown;
            };
            if (
                parsed.name === "@zokizuan/satori-mcp"
                && typeof parsed.version === "string"
                && parsed.version.length > 0
            ) {
                return {
                    version: parsed.version,
                    packageRoot: fs.realpathSync(current),
                };
            }
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    throw new Error(`Cannot locate @zokizuan/satori-mcp package for '${runtimeEntry}'.`);
}

export function isSharedOfflineRuntimeEligible(
    env: NodeJS.ProcessEnv,
    platform = process.platform,
    architecture = process.arch,
): boolean {
    return env.SATORI_SHARED_RUNTIME_DISABLE !== "1"
        && env.SATORI_RUNTIME_PROFILE === "offline"
        && env.EMBEDDING_PROVIDER === "Potion"
        && env.VECTOR_STORE_PROVIDER === "LanceDB"
        && platform === "linux"
        && architecture === "x64";
}

function resolveLateOnRequestContractDigest(env: NodeJS.ProcessEnv): string {
    if (env.SATORI_RERANKER_PROVIDER !== "lateon") return "";
    // A shared LateOn host is keyed by its complete rerank request contract.
    // Do not let a missing/corrupt contract asset silently collapse identity.
    return loadSearchRerankRequestContract().contractSha256;
}

export function buildSharedRuntimeIdentity(
    runtimeEntry: string,
    env: NodeJS.ProcessEnv,
): SharedRuntimeIdentity {
    const installed = readPackageVersion(runtimeEntry);
    const stateRoot = canonicalizePath(
        env.SATORI_STATE_ROOT
            ?? path.join(env.HOME ?? os.homedir(), ".satori"),
    );
    const payload = {
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        mcpVersion: installed.version,
        installedRuntimeRoot: installed.packageRoot,
        stateRoot,
        serverName: env.MCP_SERVER_NAME ?? "",
        serverVersion: env.MCP_SERVER_VERSION ?? "",
        runtimeProfile: env.SATORI_RUNTIME_PROFILE ?? "",
        embeddingProvider: env.EMBEDDING_PROVIDER ?? "",
        embeddingModel: env.EMBEDDING_MODEL ?? "",
        embeddingDimension: env.EMBEDDING_OUTPUT_DIMENSION ?? "",
        hybridMode: env.HYBRID_MODE ?? "",
        embeddingBatchSize: env.EMBEDDING_BATCH_SIZE ?? "",
        potionHelperPath: env.POTION_HELPER_PATH
            ? canonicalizePath(env.POTION_HELPER_PATH)
            : "",
        potionModelPath: env.POTION_MODEL_PATH
            ? canonicalizePath(env.POTION_MODEL_PATH)
            : "",
        potionRequestTimeoutMs: env.POTION_REQUEST_TIMEOUT_MS ?? "",
        rerankerProvider: env.SATORI_RERANKER_PROVIDER ?? "",
        voyageRerankerModel: env.VOYAGEAI_RERANKER_MODEL ?? "",
        lateOnModelPath: env.SATORI_LATEON_MODEL_PATH
            ? canonicalizePath(env.SATORI_LATEON_MODEL_PATH)
            : "",
        lateOnProfile: env.SATORI_LATEON_PROFILE
            ?? (env.SATORI_RERANKER_PROVIDER === "lateon"
                ? LATEON_RUNTIME_PROFILE_IDS.contextV5D32
                : ""),
        lateOnActivationPolicy: env.SATORI_LATEON_ACTIVATION_POLICY
            ?? (env.SATORI_RERANKER_PROVIDER === "lateon" && env.SATORI_LATEON_PROFILE === undefined
                ? LATEON_ACTIVATION_POLICY_IDS.ownerDefaultContextV5
                : ""),
        lateOnRequestContractSha256: resolveLateOnRequestContractDigest(env),
        vectorStoreProvider: env.VECTOR_STORE_PROVIDER ?? "",
        lanceDbPath: env.LANCEDB_PATH
            ? canonicalizePath(env.LANCEDB_PATH)
            : "",
        autoIndexWorkspace: env.SATORI_AUTO_INDEX_WORKSPACE?.toLowerCase() === "true" ? "true" : "false",
        watcherEnabled: env.MCP_ENABLE_WATCHER ?? "",
        readFileMaxLines: env.READ_FILE_MAX_LINES ?? "",
        readFileMaxBytes: env.READ_FILE_MAX_BYTES ?? "",
        customExtensions: env.CUSTOM_EXTENSIONS ?? "",
        customIgnorePatterns: env.CUSTOM_IGNORE_PATTERNS ?? "",
        allTextMaxBytes: env.SATORI_ALL_TEXT_MAX_BYTES ?? "",
        syncHashConcurrency: env.SATORI_SYNC_HASH_CONCURRENCY ?? "",
        syncFullHashEveryN: env.SATORI_SYNC_FULL_HASH_EVERY_N ?? "",
        sourceMeasurementLedger: env.SATORI_SOURCE_MEASUREMENT_LEDGER ?? "",
        sourceMeasurementRoot: env.SATORI_SOURCE_MEASUREMENT_ROOT ?? "",
    };
    return Object.freeze({
        ...payload,
        hash: crypto.createHash("sha256").update(stableStringify(payload)).digest("hex"),
    });
}

function assertOwnedDirectory(directory: string): void {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Shared runtime directory '${directory}' is not an owned directory.`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error(`Shared runtime directory '${directory}' belongs to another user.`);
    }
    const unsafeMode = stat.mode & 0o077;
    if (unsafeMode !== 0) {
        fs.chmodSync(directory, 0o700);
    }
}

// Trust boundary: the shared runtime is a same-OS-user facility. Socket mode
// 0600 and the owned 0700 directories enforce an OS-user boundary, not a
// process-within-the-same-UID boundary. Any process running as the same OS
// user can read host.json and connect to the socket; that is accepted for the
// current release. The attach challenge is a client-generated freshness/
// correlation value echoed by the host, not an authentication credential
// against a malicious same-UID process, and the metadata ownership token is a
// lifecycle-state marker used only for cleanup bookkeeping.

function ensureOwnedDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertOwnedDirectory(directory);
}

function resolveSocketDirectory(env: NodeJS.ProcessEnv, stateRoot: string): string {
    const configured = env.XDG_RUNTIME_DIR;
    if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) {
        assertOwnedDirectory(configured);
        const directory = path.join(configured, "satori");
        ensureOwnedDirectory(directory);
        return directory;
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
    const base = path.join(os.tmpdir(), `satori-${uid}`);
    ensureOwnedDirectory(base);
    const directory = path.join(base, "runtime");
    ensureOwnedDirectory(directory);
    // The state root is intentionally not used for the socket. A managed home
    // can exceed Linux's small sockaddr_un path limit.
    void stateRoot;
    return directory;
}

export function resolveSharedRuntimePaths(
    identity: SharedRuntimeIdentity,
    env: NodeJS.ProcessEnv,
): SharedRuntimePaths {
    const stateRoot = identity.stateRoot;
    const metadataDirectory = path.join(stateRoot, "runtime-host", identity.hash);
    ensureOwnedDirectory(metadataDirectory);
    const socketDirectory = resolveSocketDirectory(env, stateRoot);
    const socketPath = path.join(socketDirectory, `${identity.hash.slice(0, 24)}.sock`);
    if (Buffer.byteLength(socketPath, "utf8") > 100) {
        throw new Error(`Shared runtime socket path is too long: '${socketPath}'.`);
    }
    return Object.freeze({
        stateRoot,
        metadataDirectory,
        metadataPath: path.join(metadataDirectory, "host.json"),
        errorPath: path.join(metadataDirectory, "startup-error.json"),
        lockPath: path.join(metadataDirectory, "startup.lock"),
        socketDirectory,
        socketPath,
    });
}
