import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 20 MiB eligible source on idle session open (offline): ~4k–8k normal files in seconds. */
export const DEFAULT_OFFLINE_SESSION_OPEN_MAX_BYTES = 20 * 1024 * 1024;
/** 150 MiB eligible source on active Satori tool demand (offline). */
export const DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES = 150 * 1024 * 1024;
/** 8 MiB eligible source (~2M tokens, <1% of Voyage 200M free tier) on active tool demand for paid/connected APIs. */
export const DEFAULT_CONNECTED_TOOL_DEMAND_MAX_BYTES = 8 * 1024 * 1024;
/** Matches codebase-memory-mcp's CBM_MCP_DEFAULT_AUTO_INDEX_LIMIT = 50_000 OOM safety fuse. */
export const DEFAULT_AUTO_INDEX_MAX_FILES_FUSE = 50_000;
/** Per-file text cap aligned with Satori's default 1 MiB text indexing limit. */
const DEFAULT_SINGLE_FILE_MAX_BYTES = 1024 * 1024;

const PROBE_DEADLINE_MS = 2_500;
const GIT_LS_FILES_TIMEOUT_MS = 1_500;
const GIT_LS_FILES_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const IGNORED_DIRECTORIES = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
    "coverage",
    ".turbo",
    ".cache",
    ".satori",
    ".codebase-memory",
]);

const NON_INDEXABLE_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi",
    ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar",
    ".wasm", ".onnx", ".bin", ".safetensors", ".pt", ".pth", ".gguf", ".npy", ".npz",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".pyc", ".pyo", ".class", ".jar",
    ".db", ".sqlite", ".sqlite3", ".lance", ".parquet", ".arrow",
    ".map", ".lock",
]);

const NON_INDEXABLE_BASENAMES = new Set([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "composer.lock",
    "Gemfile.lock",
    "go.sum",
]);

export type AutoIndexTrigger = "session_open" | "tool_demand" | "compatibility_reindex";

export type AutoIndexSkipReason =
    | "disabled"
    | "not_git_repository"
    | "deferred_until_tool_use"
    | "paid_runtime_budget_exceeded"
    | "repository_too_large";

export interface RepositoryScaleProbe {
    readonly rootPath: string;
    readonly isGitRepository: boolean;
    readonly eligibleFiles: number;
    readonly eligibleBytes: number;
    readonly estimatedTokens: number;
    readonly capped: boolean;
}

export interface AutoIndexBudgets {
    readonly offlineSessionOpenMaxBytes: number;
    readonly offlineToolDemandMaxBytes: number;
    readonly connectedToolDemandMaxBytes: number;
    readonly sessionOpenMaxFiles: number;
    readonly maxFilesFuse: number;
}

export type AutoIndexDecision =
    | {
        readonly allow: true;
        readonly trigger: AutoIndexTrigger;
        readonly scale: RepositoryScaleProbe;
        readonly byteLimit: number;
        readonly fileLimit: number;
    }
    | {
        readonly allow: false;
        readonly trigger: AutoIndexTrigger;
        readonly reason: AutoIndexSkipReason;
        readonly scale: RepositoryScaleProbe;
        readonly byteLimit: number;
        readonly fileLimit: number;
    };

interface CachedScaleEntry {
    readonly witness: string;
    readonly byteCeiling: number;
    readonly fileCeiling: number;
    readonly probe: RepositoryScaleProbe;
}

const scaleCache = new Map<string, CachedScaleEntry>();

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAutoIndexBudgets(env: NodeJS.ProcessEnv = process.env): AutoIndexBudgets {
    const maxFilesFuse = parsePositiveIntEnv(
        env.SATORI_AUTO_INDEX_DEMAND_MAX_FILES ?? env.SATORI_AUTO_INDEX_MAX_FILES,
        DEFAULT_AUTO_INDEX_MAX_FILES_FUSE,
    );
    const sessionOpenMaxFiles = Math.min(
        maxFilesFuse,
        parsePositiveIntEnv(env.SATORI_AUTO_INDEX_SESSION_MAX_FILES, maxFilesFuse),
    );
    const offlineSessionOpenMaxBytes = parsePositiveIntEnv(
        env.SATORI_AUTO_INDEX_SESSION_MAX_BYTES,
        DEFAULT_OFFLINE_SESSION_OPEN_MAX_BYTES,
    );
    const offlineToolDemandMaxBytes = Math.max(
        offlineSessionOpenMaxBytes,
        parsePositiveIntEnv(
            env.SATORI_AUTO_INDEX_DEMAND_MAX_BYTES,
            DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES,
        ),
    );
    const connectedToolDemandMaxBytes = parsePositiveIntEnv(
        env.SATORI_AUTO_INDEX_CONNECTED_MAX_BYTES,
        DEFAULT_CONNECTED_TOOL_DEMAND_MAX_BYTES,
    );
    return Object.freeze({
        offlineSessionOpenMaxBytes,
        offlineToolDemandMaxBytes,
        connectedToolDemandMaxBytes,
        sessionOpenMaxFiles,
        maxFilesFuse,
    });
}

function readSimpleIgnorePrefixes(repoRoot: string): string[] {
    const prefixes: string[] = [];
    try {
        const raw = fs.readFileSync(path.join(repoRoot, ".satoriignore"), "utf8");
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
            if (/[*?[]/.test(trimmed)) continue;
            const normalized = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
            if (normalized.length > 0) prefixes.push(normalized);
        }
    } catch {
        // Optional .satoriignore
    }
    return prefixes;
}

function isEligibleRelativePath(relPath: string, satoriIgnorePrefixes: readonly string[]): boolean {
    const normalized = relPath.replace(/\\/g, "/");
    const base = path.posix.basename(normalized);
    if (NON_INDEXABLE_BASENAMES.has(base)) return false;
    if (base.endsWith(".min.js") || base.endsWith(".min.css") || base.endsWith(".bundle.js")) return false;
    const ext = path.posix.extname(base).toLowerCase();
    if (NON_INDEXABLE_EXTENSIONS.has(ext)) return false;

    const segments = normalized.split("/");
    for (let i = 0; i < segments.length - 1; i += 1) {
        if (IGNORED_DIRECTORIES.has(segments[i]!)) return false;
    }
    for (const prefix of satoriIgnorePrefixes) {
        if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return false;
    }
    return true;
}

function resolveGitScaleWitness(repoRoot: string): string | null {
    try {
        const dotGitPath = path.join(repoRoot, ".git");
        const dotGitStat = fs.statSync(dotGitPath);
        let gitDir = dotGitPath;
        if (dotGitStat.isFile()) {
            const raw = fs.readFileSync(dotGitPath, "utf8").trim();
            const match = /^gitdir:\s*(.+)$/i.exec(raw);
            if (!match) return null;
            gitDir = path.resolve(repoRoot, match[1]);
        }
        const indexStat = fs.statSync(path.join(gitDir, "index"));
        let ignorePart = "none";
        try {
            const ignoreStat = fs.statSync(path.join(repoRoot, ".satoriignore"));
            ignorePart = `${ignoreStat.size}:${ignoreStat.mtimeMs}`;
        } catch {
            // Optional
        }
        return `${indexStat.size}:${indexStat.mtimeMs}:${ignorePart}`;
    } catch {
        return null;
    }
}

function buildProbeResult(
    rootPath: string,
    isGitRepository: boolean,
    eligibleFiles: number,
    eligibleBytes: number,
    capped: boolean,
): RepositoryScaleProbe {
    return Object.freeze({
        rootPath,
        isGitRepository,
        eligibleFiles,
        eligibleBytes,
        estimatedTokens: Math.ceil(eligibleBytes / 4),
        capped,
    });
}

function probeFallbackDirectory(
    rootPath: string,
    isGitRepository: boolean,
    byteCeiling: number,
    fileCeiling: number,
    satoriIgnorePrefixes: readonly string[],
    deadline: number,
): RepositoryScaleProbe {
    let eligibleFiles = 0;
    let eligibleBytes = 0;
    const stack: string[] = [rootPath];
    while (stack.length > 0) {
        if (Date.now() > deadline) {
            return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, true);
        }
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name)) {
                    stack.push(path.join(current, entry.name));
                }
                continue;
            }
            if (!entry.isFile()) continue;
            const fullPath = path.join(current, entry.name);
            const relPath = path.relative(rootPath, fullPath);
            if (!isEligibleRelativePath(relPath, satoriIgnorePrefixes)) continue;
            let size: number;
            try {
                size = fs.statSync(fullPath).size;
            } catch {
                continue;
            }
            if (size <= 0 || size > DEFAULT_SINGLE_FILE_MAX_BYTES) continue;
            eligibleFiles += 1;
            eligibleBytes += size;
            if (eligibleBytes > byteCeiling || eligibleFiles > fileCeiling) {
                return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, true);
            }
        }
    }
    return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, false);
}

/**
 * Measures eligible indexable source bytes + file count (filtering `.gitignore`,
 * `.satoriignore`, lockfiles, binaries, and oversized >1 MiB blobs) with a
 * bounded deadline and `.git/index` stat witness cache.
 */
export function probeRepositoryScale(
    rootPath: string,
    byteCeiling: number = DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES,
    fileCeiling: number = DEFAULT_AUTO_INDEX_MAX_FILES_FUSE,
): RepositoryScaleProbe {
    const isGitRepository = fs.existsSync(path.join(rootPath, ".git"));
    const satoriIgnorePrefixes = readSimpleIgnorePrefixes(rootPath);
    const deadline = Date.now() + PROBE_DEADLINE_MS;

    if (isGitRepository) {
        const witness = resolveGitScaleWitness(rootPath);
        if (witness) {
            const cached = scaleCache.get(rootPath);
            if (
                cached
                && cached.witness === witness
                && (!cached.probe.capped || (cached.byteCeiling <= byteCeiling && cached.probe.eligibleBytes > byteCeiling) || (cached.fileCeiling <= fileCeiling && cached.probe.eligibleFiles > fileCeiling))
            ) {
                return cached.probe;
            }
        }

        const gitResult = spawnSync("git", ["-C", rootPath, "ls-files", "-z"], {
            timeout: GIT_LS_FILES_TIMEOUT_MS,
            maxBuffer: GIT_LS_FILES_MAX_BUFFER_BYTES,
            windowsHide: true,
        });
        if (gitResult.status === 0 && Buffer.isBuffer(gitResult.stdout)) {
            let eligibleFiles = 0;
            let eligibleBytes = 0;
            let capped = false;
            const buf = gitResult.stdout;
            let start = 0;
            for (let i = 0; i < buf.length; i += 1) {
                if (buf[i] !== 0) continue;
                if (Date.now() > deadline) {
                    capped = true;
                    break;
                }
                const relPath = buf.subarray(start, i).toString("utf8");
                start = i + 1;
                if (!relPath || !isEligibleRelativePath(relPath, satoriIgnorePrefixes)) continue;
                let size: number;
                try {
                    size = fs.statSync(path.join(rootPath, relPath)).size;
                } catch {
                    continue;
                }
                if (size <= 0 || size > DEFAULT_SINGLE_FILE_MAX_BYTES) continue;
                eligibleFiles += 1;
                eligibleBytes += size;
                if (eligibleBytes > byteCeiling || eligibleFiles > fileCeiling) {
                    capped = true;
                    break;
                }
            }
            const probe = buildProbeResult(rootPath, true, eligibleFiles, eligibleBytes, capped);
            if (witness) {
                scaleCache.set(rootPath, { witness, byteCeiling, fileCeiling, probe });
            }
            return probe;
        }
        if ((gitResult.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
            return buildProbeResult(rootPath, true, fileCeiling + 1, byteCeiling + 1, true);
        }
    }

    return probeFallbackDirectory(rootPath, isGitRepository, byteCeiling, fileCeiling, satoriIgnorePrefixes, deadline);
}

export function evaluateAutoIndexPolicy(input: {
    readonly rootPath: string;
    readonly executionProfile: "offline" | "connected";
    readonly autoIndexWorkspace: boolean;
    readonly trigger: AutoIndexTrigger;
    readonly requireGitRepository?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly scaleProbe?: RepositoryScaleProbe;
}): AutoIndexDecision {
    const budgets = resolveAutoIndexBudgets(input.env);
    const isOffline = input.executionProfile === "offline";
    const byteLimit = isOffline
        ? (input.trigger === "session_open" ? budgets.offlineSessionOpenMaxBytes : budgets.offlineToolDemandMaxBytes)
        : (input.trigger === "session_open" ? 0 : budgets.connectedToolDemandMaxBytes);
    const fileLimit = input.trigger === "session_open" ? budgets.sessionOpenMaxFiles : budgets.maxFilesFuse;

    if (!input.autoIndexWorkspace) {
        const emptyScale = input.scaleProbe ?? buildProbeResult(input.rootPath, fs.existsSync(path.join(input.rootPath, ".git")), 0, 0, false);
        return Object.freeze({
            allow: false,
            trigger: input.trigger,
            reason: "disabled",
            scale: emptyScale,
            byteLimit,
            fileLimit,
        });
    }

    // Paid/connected APIs never auto-index on idle session open—wait for active Satori tool demand.
    if (!isOffline && input.trigger === "session_open") {
        const emptyScale = input.scaleProbe ?? buildProbeResult(input.rootPath, fs.existsSync(path.join(input.rootPath, ".git")), 0, 0, false);
        return Object.freeze({
            allow: false,
            trigger: input.trigger,
            reason: "deferred_until_tool_use",
            scale: emptyScale,
            byteLimit,
            fileLimit,
        });
    }

    const probeByteCeiling = isOffline ? budgets.offlineToolDemandMaxBytes : budgets.connectedToolDemandMaxBytes;
    const scale = input.scaleProbe ?? probeRepositoryScale(input.rootPath, probeByteCeiling, budgets.maxFilesFuse);

    if (input.requireGitRepository && !scale.isGitRepository) {
        return Object.freeze({
            allow: false,
            trigger: input.trigger,
            reason: "not_git_repository",
            scale,
            byteLimit,
            fileLimit,
        });
    }

    if (scale.eligibleFiles > fileLimit) {
        return Object.freeze({
            allow: false,
            trigger: input.trigger,
            reason: input.trigger === "session_open" ? "deferred_until_tool_use" : "repository_too_large",
            scale,
            byteLimit,
            fileLimit,
        });
    }

    if (scale.eligibleBytes > byteLimit) {
        return Object.freeze({
            allow: false,
            trigger: input.trigger,
            reason: !isOffline
                ? "paid_runtime_budget_exceeded"
                : input.trigger === "session_open"
                    ? "deferred_until_tool_use"
                    : "repository_too_large",
            scale,
            byteLimit,
            fileLimit,
        });
    }

    return Object.freeze({
        allow: true,
        trigger: input.trigger,
        scale,
        byteLimit,
        fileLimit,
    });
}
