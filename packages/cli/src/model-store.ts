import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Managed model cache: the single owner of acquiring pinned Hugging Face model
 * files into `~/.satori/models/<id>/<name>@<revision>`.
 *
 * Every model Satori needs (Potion embeddings, the LateOn reranker) is
 * described by a {@link ModelSpec} whose artifacts carry an exact size and
 * SHA-256. A directory is only ever published after every artifact verifies,
 * so a directory at the final path is either complete or treated as corrupt
 * and re-acquired. Interrupted downloads resume from a persistent staging
 * directory instead of starting over.
 */

export type ModelArtifact = Readonly<{
    /** Path inside the model directory. */
    path: string;
    /** Path inside the Hugging Face repository; defaults to `path`. */
    sourcePath?: string;
    sizeBytes: number;
    sha256: string;
}>;

export type ModelSpec = Readonly<{
    /** Cache namespace, e.g. "potion" or "lateon". */
    id: string;
    /** Human label used in progress and errors, e.g. "Potion embedding model". */
    label: string;
    repository: string;
    /** Pinned commit; the cache directory is versioned by it. */
    revision: string;
    artifacts: readonly ModelArtifact[];
}>;

export type ModelSource = "cached" | "downloaded";

export type ModelProgressEvent =
    | Readonly<{ phase: "checking"; label: string; modelDirectory: string; totalBytes: number }>
    | Readonly<{
        phase: "downloading";
        label: string;
        modelDirectory: string;
        repository: string;
        totalBytes: number;
        /** Bytes already present from an interrupted earlier attempt. */
        resumedBytes: number;
    }>
    | Readonly<{
        phase: "progress";
        label: string;
        artifact: string;
        artifactBytesDownloaded: number;
        artifactBytesTotal: number;
        totalBytesDownloaded: number;
        totalBytes: number;
    }>
    | Readonly<{ phase: "retrying"; label: string; artifact: string; attempt: number; reason: string }>
    | Readonly<{ phase: "repairing"; label: string; modelDirectory: string; reason: string }>
    | Readonly<{ phase: "verifying"; label: string; modelDirectory: string; totalBytes: number; source: ModelSource }>
    | Readonly<{ phase: "ready"; label: string; modelDirectory: string; totalBytes: number; source: ModelSource }>;

export type ModelProgressReporter = (event: ModelProgressEvent) => void;

export type ModelAcquisitionFailure = "offline" | "http" | "disk" | "integrity" | "stalled";

export class ModelAcquisitionError extends Error {
    readonly reason: ModelAcquisitionFailure;

    constructor(reason: ModelAcquisitionFailure, message: string) {
        super(message);
        this.name = "ModelAcquisitionError";
        this.reason = reason;
    }
}

export type EnsureModelInput = Readonly<{
    homeDir: string;
    spec: ModelSpec;
    /** Reads HF_ENDPOINT for mirrors; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    onProgress?: ModelProgressReporter;
    statfsImpl?: (path: string) => { bavail: number; bsize: number };
    /** Abort a download that receives no bytes for this long. */
    stallTimeoutMs?: number;
    /** Delay before each retry; its length is the retry count. */
    retryDelaysMs?: readonly number[];
    /**
     * Artifacts downloaded at once (default 1). Packs of many small files set
     * this higher: each request pays a redirect and time-to-first-byte that
     * dominates when files are small.
     */
    concurrency?: number;
    /** Test seam for the destination-appears-before-rename race. */
    renameImpl?: (from: string, to: string) => void;
}>;

export type EnsuredModel = Readonly<{ modelDirectory: string; source: ModelSource }>;

const DEFAULT_ENDPOINT = "https://huggingface.co";
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000];
const MAX_REDIRECTS = 5;
const DISK_HEADROOM_FRACTION = 0.1;
const MEBIBYTE = 1024 * 1024;

export function totalModelBytes(spec: ModelSpec): number {
    return spec.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
}

export function resolveModelDirectory(homeDir: string, spec: ModelSpec): string {
    const name = spec.repository.split("/").pop() ?? spec.id;
    return path.join(homeDir, ".satori", "models", spec.id, `${name}@${spec.revision}`);
}

export function resolveModelsRoot(homeDir: string): string {
    return path.join(homeDir, ".satori", "models");
}

function formatMiB(bytes: number): string {
    return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}

function pathExists(candidate: string): boolean {
    try {
        fs.lstatSync(candidate);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function sha256File(filePath: string): string {
    const digest = crypto.createHash("sha256");
    const file = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        while (true) {
            const bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            digest.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(file);
    }
    return digest.digest("hex");
}

/** Rejects artifact paths that could escape the model directory. */
export function assertSafeModelArtifactPath(candidate: unknown, label: string): asserts candidate is string {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0") || candidate.includes("\\")) {
        throw new Error(`${label} contains an empty, null-byte, or backslash artifact path.`);
    }
    if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
        throw new Error(`${label} contains an absolute artifact path '${candidate}'.`);
    }
    if (
        candidate.split("/").some((component) => component.length === 0 || component === "." || component === "..")
        || path.posix.normalize(candidate) !== candidate
    ) {
        throw new Error(`${label} contains an unsafe artifact path '${candidate}'.`);
    }
}

function integrityError(spec: ModelSpec, modelDirectory: string, detail: string): ModelAcquisitionError {
    return new ModelAcquisitionError(
        "integrity",
        `${spec.label} at '${modelDirectory}' failed verification: ${detail}`,
    );
}

function isRealPathWithin(rootPath: string, candidatePath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return relative.length > 0
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

/** Verifies every artifact's type, containment, size, and SHA-256. */
export function verifyModelDirectory(modelDirectory: string, spec: ModelSpec): void {
    if (!path.isAbsolute(modelDirectory)) {
        throw integrityError(spec, modelDirectory, "the model path must be absolute.");
    }
    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(modelDirectory);
    } catch {
        throw integrityError(spec, modelDirectory, "the model directory is missing.");
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw integrityError(spec, modelDirectory, "the model path must be a real directory.");
    }
    const realModelDirectory = fs.realpathSync(modelDirectory);
    for (const artifact of spec.artifacts) {
        const components = artifact.path.split("/");
        try {
            let current = modelDirectory;
            for (const component of components.slice(0, -1)) {
                current = path.join(current, component);
                const componentStat = fs.lstatSync(current);
                if (!componentStat.isDirectory() || componentStat.isSymbolicLink()) {
                    throw new Error(`intermediate component '${component}' is not a real directory`);
                }
            }
            const artifactPath = path.join(modelDirectory, ...components);
            const artifactStat = fs.lstatSync(artifactPath);
            if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
                throw new Error("artifact is not a regular file");
            }
            if (!isRealPathWithin(realModelDirectory, fs.realpathSync(artifactPath))) {
                throw new Error("artifact resolves outside the model directory");
            }
            if (artifactStat.size !== artifact.sizeBytes || sha256File(artifactPath) !== artifact.sha256) {
                throw new Error("artifact size or checksum verification failed");
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw integrityError(spec, modelDirectory, `${artifact.path}: ${detail}.`);
        }
    }
}

function resolveEndpoint(env: NodeJS.ProcessEnv): string {
    const configured = env.HF_ENDPOINT?.trim();
    if (!configured) return DEFAULT_ENDPOINT;
    let url: URL;
    try {
        url = new URL(configured);
    } catch {
        throw new ModelAcquisitionError("http", `HF_ENDPOINT '${configured}' is not a valid URL.`);
    }
    if (url.protocol !== "https:") {
        throw new ModelAcquisitionError("http", `HF_ENDPOINT must use https; received '${configured}'.`);
    }
    return url.href.replace(/\/+$/, "");
}

function artifactUrl(endpoint: string, spec: ModelSpec, artifact: ModelArtifact): string {
    const source = (artifact.sourcePath ?? artifact.path).split("/").map(encodeURIComponent).join("/");
    return `${endpoint}/${spec.repository}/resolve/${spec.revision}/${source}`;
}

function stagedBytes(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

function assertDiskSpace(
    spec: ModelSpec,
    directory: string,
    remainingBytes: number,
    statfsImpl: (path: string) => { bavail: number; bsize: number },
): void {
    if (remainingBytes === 0) return;
    const stats = statfsImpl(directory);
    const available = stats.bavail * stats.bsize;
    const required = remainingBytes + Math.ceil(remainingBytes * DISK_HEADROOM_FRACTION);
    if (!Number.isSafeInteger(available) || available < required) {
        throw new ModelAcquisitionError(
            "disk",
            `Not enough disk space to download the ${spec.label} into '${directory}': `
            + `need ${formatMiB(required)} free, ${Number.isSafeInteger(available) ? formatMiB(available) : "unknown"} available.`,
        );
    }
}

const OFFLINE_ERROR_CODES = new Set([
    "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

/** Classifies a transport failure; `retryable` failures are retried with backoff. */
function classifyFailure(error: unknown): { failure: ModelAcquisitionError; retryable: boolean } {
    if (error instanceof ModelAcquisitionError) {
        return {
            failure: error,
            retryable: error.reason === "offline" || error.reason === "stalled" || error.reason === "integrity"
                || (error.reason === "http" && /HTTP (429|5\d\d)/.test(error.message)),
        };
    }
    const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
    const code = cause?.code ?? (error as NodeJS.ErrnoException | undefined)?.code;
    if (error instanceof TypeError || (code && OFFLINE_ERROR_CODES.has(code))) {
        return {
            failure: new ModelAcquisitionError("offline", `network error${code ? ` (${code})` : ""}`),
            retryable: true,
        };
    }
    return {
        failure: new ModelAcquisitionError("http", error instanceof Error ? error.message : String(error)),
        retryable: false,
    };
}

async function readWithStallTimeout<T>(
    operation: Promise<T>,
    stallTimeoutMs: number,
    abort: AbortController,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    abort.abort();
                    reject(new ModelAcquisitionError(
                        "stalled",
                        `no data received for ${Math.round(stallTimeoutMs / 1000)} seconds`,
                    ));
                }, stallTimeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

const inFlightModelAcquisitions = new Map<string, Promise<EnsuredModel>>();

function assertSafeStagingPath(stagingRoot: string, destination: string): void {
    const stagingStat = fs.lstatSync(stagingRoot);
    if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
        throw new ModelAcquisitionError("integrity", `staging directory '${stagingRoot}' must be a real directory, not a symlink`);
    }
    const realStagingRoot = fs.realpathSync(stagingRoot);
    const relative = path.relative(stagingRoot, destination);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ModelAcquisitionError("integrity", `staging destination '${destination}' escapes '${stagingRoot}'`);
    }
    const components = relative.split(path.sep);
    let current = stagingRoot;
    for (const component of components.slice(0, -1)) {
        current = path.join(current, component);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new ModelAcquisitionError("integrity", `staging path component '${current}' must not be a symlink`);
        }
    }
    const destStat = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (destStat) {
        if (destStat.isSymbolicLink() || !destStat.isFile()) {
            throw new ModelAcquisitionError("integrity", `staging artifact '${destination}' must not be a symbolic link`);
        }
        if (!isRealPathWithin(realStagingRoot, fs.realpathSync(destination))) {
            throw new ModelAcquisitionError("integrity", `staging artifact '${destination}' resolves outside staging directory`);
        }
    }
}

function openStagingFileNoFollow(stagingRoot: string, destination: string, append: boolean): number {
    assertSafeStagingPath(stagingRoot, destination);
    const flags = fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC)
        | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(destination, flags, 0o600);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
            throw new ModelAcquisitionError("integrity", `staging artifact '${destination}' is not a regular file`);
        }
        return fd;
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}

/**
 * Downloads one artifact into `destination`, resuming from any bytes already
 * staged. The caller verifies the completed file.
 */
async function downloadArtifact(
    url: string,
    stagingRoot: string,
    destination: string,
    artifact: ModelArtifact,
    fetchImpl: typeof fetch,
    stallTimeoutMs: number,
    onBytes: (artifactBytes: number) => void,
): Promise<void> {
    assertSafeStagingPath(stagingRoot, destination);
    const offset = stagedBytes(destination);
    const abort = new AbortController();
    let currentUrl = url;
    let response: Response | undefined;
    try {
        for (let redirects = 0; ; redirects += 1) {
            response = await readWithStallTimeout(Promise.resolve(fetchImpl(currentUrl, {
                redirect: "manual",
                signal: abort.signal,
                headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
            })), stallTimeoutMs, abort);
            if (response.status < 300 || response.status >= 400) break;
            if (redirects >= MAX_REDIRECTS) {
                throw new ModelAcquisitionError("http", `too many redirects for '${artifact.path}'`);
            }
            const location = response.headers.get("location");
            if (!location) throw new ModelAcquisitionError("http", "redirect without a Location header");
            const next = new URL(location, currentUrl);
            if (next.protocol !== "https:") {
                throw new ModelAcquisitionError("http", "refused a non-HTTPS redirect");
            }
            await response.body?.cancel().catch(() => undefined);
            currentUrl = next.href;
        }
        if (response.status === 416 && offset === artifact.sizeBytes) return;
        if (!response.ok || !response.body) {
            throw new ModelAcquisitionError("http", `HTTP ${response.status} for '${artifact.path}'`);
        }
        // 206 continues the staged bytes; 200 means the server sent the whole file.
        const append = response.status === 206 && offset > 0;
        const file = openStagingFileNoFollow(stagingRoot, destination, append);
        let written = append ? offset : 0;
        const reader = response.body.getReader();
        try {
            while (true) {
                const result = await readWithStallTimeout(reader.read(), stallTimeoutMs, abort);
                if (result.done) break;
                const chunk = Buffer.from(result.value);
                if (written + chunk.length > artifact.sizeBytes) {
                    throw new ModelAcquisitionError(
                        "integrity",
                        `'${artifact.path}' exceeded its expected size of ${artifact.sizeBytes} bytes`,
                    );
                }
                fs.writeSync(file, chunk);
                written += chunk.length;
                onBytes(written);
            }
            fs.fsyncSync(file);
        } finally {
            fs.closeSync(file);
            reader.releaseLock();
        }
        if (written !== artifact.sizeBytes) {
            throw new ModelAcquisitionError(
                "integrity",
                `'${artifact.path}' ended at ${written} bytes; expected ${artifact.sizeBytes}`,
            );
        }
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new ModelAcquisitionError("stalled", "the download was interrupted");
        }
        throw error;
    } finally {
        await response?.body?.cancel().catch(() => undefined);
    }
}

function acquisitionFailureMessage(spec: ModelSpec, endpoint: string, failure: ModelAcquisitionError): string {
    const host = new URL(endpoint).host;
    const resume = "Downloaded bytes are kept; rerunning resumes where it stopped.";
    switch (failure.reason) {
        case "offline":
            return `Could not reach ${host} to download the ${spec.label} (${failure.message}). `
                + `Check your connection or proxy and rerun. To use a mirror, set HF_ENDPOINT. ${resume}`;
        case "stalled":
            return `Downloading the ${spec.label} from ${host} stalled (${failure.message}). Rerun to resume. ${resume}`;
        case "integrity":
            return `The ${spec.label} downloaded from ${host} did not match its pinned checksum (${failure.message}). `
                + "Rerun to download it again; if this repeats, the mirror or proxy is altering files.";
        default:
            return `Downloading the ${spec.label} from ${host} failed (${failure.message}). ${resume}`;
    }
}

function detachAndRemoveDirectory(directoryPath: string): void {
    const detached = `${directoryPath}.corrupt-${crypto.randomUUID()}`;
    try {
        fs.renameSync(directoryPath, detached);
        fs.rmSync(detached, { recursive: true, force: true });
    } catch {
        fs.rmSync(directoryPath, { recursive: true, force: true });
    }
}

function isProcessLiveForModelLock(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

const ABANDONED_MODEL_LOCK_HELPER_MAX_AGE_MS = 5_000;

function parseModelLockHelperPid(fileName: string, lockBaseName: string): number | null {
    const prefix = `${lockBaseName}.`;
    if (!fileName.startsWith(prefix)) return null;
    if (!fileName.endsWith(".stale-claim") && !fileName.endsWith(".candidate")) return null;
    const rest = fileName.slice(prefix.length);
    const dotIndex = rest.indexOf(".");
    if (dotIndex <= 0) return null;
    const pid = Number(rest.slice(0, dotIndex));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function pruneAbandonedModelLockHelpers(
    lockPath: string,
    target: Readonly<{ dev: number; ino: number }>,
    ownClaimPath: string,
): void {
    const lockDir = path.dirname(lockPath);
    const lockBaseName = path.basename(lockPath);
    const ownClaimBaseName = path.basename(ownClaimPath);
    let entries: string[];
    try {
        entries = fs.readdirSync(lockDir);
    } catch {
        return;
    }
    const now = Date.now();
    for (const entry of entries) {
        if (entry === lockBaseName || entry === ownClaimBaseName) continue;
        const helperPid = parseModelLockHelperPid(entry, lockBaseName);
        if (helperPid === null) continue;
        const helperPath = path.join(lockDir, entry);
        let helperStat: fs.Stats;
        try {
            helperStat = fs.lstatSync(helperPath);
        } catch {
            continue;
        }
        if (helperStat.dev !== target.dev || helperStat.ino !== target.ino) continue;
        const abandoned = !isProcessLiveForModelLock(helperPid)
            || (now - helperStat.mtimeMs) > ABANDONED_MODEL_LOCK_HELPER_MAX_AGE_MS;
        if (!abandoned) continue;
        try {
            fs.unlinkSync(helperPath);
        } catch { /* ignore */ }
    }
}

async function acquireModelStagingLock(lockPath: string, timeoutMs = 30_000): Promise<() => void> {
    const deadline = Date.now() + timeoutMs;
    const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
    for (;;) {
        const candidatePath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.candidate`;
        let fd: number | null = null;
        try {
            fd = fs.openSync(candidatePath, "wx", 0o600);
            fs.writeFileSync(fd, payload, "utf8");
            const stat = fs.fstatSync(fd);
            fs.closeSync(fd);
            fd = null;
            fs.linkSync(candidatePath, lockPath);
            try { fs.unlinkSync(candidatePath); } catch { /* ignore */ }
            return () => {
                try {
                    const current = fs.lstatSync(lockPath);
                    if (current.dev === stat.dev && current.ino === stat.ino) {
                        fs.unlinkSync(lockPath);
                    }
                } catch { /* ignore */ }
            };
        } catch (error) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* ignore */ }
            }
            try { fs.unlinkSync(candidatePath); } catch { /* ignore */ }
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        // Check for dead-process stale lock using a hard-link claim.
        const claimPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.stale-claim`;
        try {
            fs.linkSync(lockPath, claimPath);
            try {
                const claimStat = fs.lstatSync(claimPath);
                let ownerPid: number | undefined;
                try {
                    const parsed = JSON.parse(fs.readFileSync(claimPath, "utf8")) as { pid?: unknown };
                    if (typeof parsed.pid === "number") ownerPid = parsed.pid;
                } catch { /* malformed */ }
                const stale = ownerPid !== undefined
                    ? !isProcessLiveForModelLock(ownerPid)
                    : Date.now() - claimStat.mtimeMs > 30_000;
                if (stale) {
                    let currentLock = fs.lstatSync(lockPath);
                    let currentClaim = fs.lstatSync(claimPath);
                    if (currentLock.dev === currentClaim.dev && currentLock.ino === currentClaim.ino && currentClaim.nlink > 2) {
                        pruneAbandonedModelLockHelpers(lockPath, currentClaim, claimPath);
                        currentLock = fs.lstatSync(lockPath);
                        currentClaim = fs.lstatSync(claimPath);
                    }
                    if (currentLock.dev === currentClaim.dev && currentLock.ino === currentClaim.ino && currentClaim.nlink === 2) {
                        fs.unlinkSync(lockPath);
                        continue;
                    }
                }
            } finally {
                try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
            }
        } catch {
            // Lock vanished or contended; retry below.
        }
        if (Date.now() >= deadline) {
            throw new ModelAcquisitionError("stalled", `timed out waiting for model staging lock '${lockPath}'`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * Returns a verified local copy of `spec`, downloading only what is missing.
 * A corrupt cached copy is discarded and re-acquired. Concurrent callers for
 * the same model directory serialize both in-process and across processes so
 * they never race on the shared `.partial` staging directory.
 */
export async function ensureModel(input: EnsureModelInput): Promise<EnsuredModel> {
    const modelDirectory = resolveModelDirectory(input.homeDir, input.spec);
    while (inFlightModelAcquisitions.has(modelDirectory)) {
        await inFlightModelAcquisitions.get(modelDirectory)!.catch(() => undefined);
    }
    const run = (async () => {
        const parent = path.dirname(modelDirectory);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const lockPath = path.join(parent, `.${path.basename(modelDirectory)}.lock`);
        const releaseLock = await acquireModelStagingLock(lockPath);
        try {
            return await ensureModelSerialized(input, modelDirectory);
        } finally {
            releaseLock();
        }
    })();
    inFlightModelAcquisitions.set(modelDirectory, run);
    try {
        return await run;
    } finally {
        if (inFlightModelAcquisitions.get(modelDirectory) === run) {
            inFlightModelAcquisitions.delete(modelDirectory);
        }
    }
}

async function ensureModelSerialized(input: EnsureModelInput, modelDirectory: string): Promise<EnsuredModel> {
    const { spec } = input;
    const totalBytes = totalModelBytes(spec);
    const report = input.onProgress ?? (() => {});
    report({ phase: "checking", label: spec.label, modelDirectory, totalBytes });

    if (pathExists(modelDirectory)) {
        report({ phase: "verifying", label: spec.label, modelDirectory, totalBytes, source: "cached" });
        try {
            verifyModelDirectory(modelDirectory, spec);
            report({ phase: "ready", label: spec.label, modelDirectory, totalBytes, source: "cached" });
            return Object.freeze({ modelDirectory, source: "cached" as const });
        } catch (error) {
            // The cache directory is Satori-owned, so a failed copy is replaced, not reported as fatal.
            report({
                phase: "repairing",
                label: spec.label,
                modelDirectory,
                reason: error instanceof Error ? error.message : String(error),
            });
            detachAndRemoveDirectory(modelDirectory);
        }
    }

    const endpoint = resolveEndpoint(input.env ?? process.env);
    const parent = path.dirname(modelDirectory);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staging = path.join(parent, `.${path.basename(modelDirectory)}.partial`);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagingStat = fs.lstatSync(staging);
    if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
        throw new ModelAcquisitionError("integrity", `staging directory '${staging}' must not be a symbolic link`);
    }

    const stagedPath = (artifact: ModelArtifact) => path.join(staging, ...artifact.path.split("/"));
    let resumedBytes = 0;
    for (const artifact of spec.artifacts) {
        const dest = stagedPath(artifact);
        assertSafeStagingPath(staging, dest);
        const staged = stagedBytes(dest);
        if (staged > artifact.sizeBytes) fs.rmSync(dest, { force: true });
        else resumedBytes += staged;
    }
    assertDiskSpace(spec, parent, totalBytes - resumedBytes, input.statfsImpl ?? ((dir) => fs.statfsSync(dir)));
    report({ phase: "downloading", label: spec.label, modelDirectory, repository: spec.repository, totalBytes, resumedBytes });

    const fetchImpl = input.fetchImpl ?? fetch;
    const stallTimeoutMs = input.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const retryDelays = input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    let completedBytes = 0;
    const inFlightBytes = new Map<string, number>();
    const inFlightTotal = () => [...inFlightBytes.values()].reduce((total, bytes) => total + bytes, 0);
    const acquireArtifact = async (artifact: ModelArtifact): Promise<void> => {
        const destination = stagedPath(artifact);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        for (let attempt = 0; ; attempt += 1) {
            try {
                assertSafeStagingPath(staging, destination);
                if (stagedBytes(destination) < artifact.sizeBytes) {
                    await downloadArtifact(
                        artifactUrl(endpoint, spec, artifact),
                        staging,
                        destination,
                        artifact,
                        fetchImpl,
                        stallTimeoutMs,
                        (artifactBytes) => {
                            inFlightBytes.set(artifact.path, artifactBytes);
                            report({
                                phase: "progress",
                                label: spec.label,
                                artifact: artifact.path,
                                artifactBytesDownloaded: artifactBytes,
                                artifactBytesTotal: artifact.sizeBytes,
                                totalBytesDownloaded: completedBytes + inFlightTotal(),
                                totalBytes,
                            });
                        },
                    );
                }
                if (sha256File(destination) !== artifact.sha256) {
                    fs.rmSync(destination, { force: true });
                    throw new ModelAcquisitionError("integrity", `'${artifact.path}' failed checksum verification`);
                }
                break;
            } catch (error) {
                inFlightBytes.delete(artifact.path);
                const { failure, retryable } = classifyFailure(error);
                if (failure.reason === "integrity" && !/symlink|symbolic link/i.test(failure.message)) {
                    fs.rmSync(destination, { force: true });
                }
                if (!retryable || attempt >= retryDelays.length) {
                    throw new ModelAcquisitionError(failure.reason, acquisitionFailureMessage(spec, endpoint, failure));
                }
                report({ phase: "retrying", label: spec.label, artifact: artifact.path, attempt: attempt + 1, reason: failure.message });
                await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
            }
        }
        inFlightBytes.delete(artifact.path);
        completedBytes += artifact.sizeBytes;
    };
    // A bounded worker pool; after the first failure no worker starts another
    // artifact, and partial files stay staged for the next attempt to resume.
    const queue = [...spec.artifacts];
    let failed = false;
    const worker = async (): Promise<void> => {
        for (let artifact = queue.shift(); artifact && !failed; artifact = queue.shift()) {
            try {
                await acquireArtifact(artifact);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    const workers = Math.max(1, Math.min(input.concurrency ?? 1, spec.artifacts.length));
    const results = await Promise.allSettled(Array.from({ length: workers }, worker));
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejection) throw rejection.reason;

    report({ phase: "verifying", label: spec.label, modelDirectory, totalBytes, source: "downloaded" });
    verifyModelDirectory(staging, spec);
    try {
        (input.renameImpl ?? fs.renameSync)(staging, modelDirectory);
    } catch (error) {
        // Another installer may have published the same revision first.
        if (!pathExists(modelDirectory)) throw error;
        verifyModelDirectory(modelDirectory, spec);
        fs.rmSync(staging, { recursive: true, force: true });
    }
    report({ phase: "ready", label: spec.label, modelDirectory, totalBytes, source: "downloaded" });
    return Object.freeze({ modelDirectory, source: "downloaded" as const });
}
