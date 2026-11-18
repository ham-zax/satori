import fs from "node:fs";
import path from "node:path";
import {
    DEFAULT_IGNORE_PATTERNS,
    classifyFilePathByPolicy,
    compareContractStrings,
    createIndexIgnoreMatcher,
    getCustomExtensionsFromEnvironment,
    getCustomIgnorePatternsFromEnvironment,
    getSupportedExtensionsForIndexProfile,
    isIndexableFileByPolicySync,
    isRepositoryRelativePath,
    loadSatoriRepoConfig,
    normalizeSupportedExtensions,
    parseIgnorePatterns,
    translateNestedGitignorePatterns,
    type IndexIgnoreMatcher,
} from "@satori-code/core";

/** 20 MiB eligible source on idle session open (offline): ~4k–8k normal files in seconds. */
export const DEFAULT_OFFLINE_SESSION_OPEN_MAX_BYTES = 20 * 1024 * 1024;
/** 150 MiB eligible source on active Satori tool demand (offline). */
export const DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES = 150 * 1024 * 1024;
/** 8 MiB eligible source (~2M tokens, <1% of Voyage 200M free tier) on active tool demand for paid/connected APIs. */
export const DEFAULT_CONNECTED_TOOL_DEMAND_MAX_BYTES = 8 * 1024 * 1024;
/** Matches codebase-memory-mcp's CBM_MCP_DEFAULT_AUTO_INDEX_LIMIT = 50_000 OOM safety fuse. */
export const DEFAULT_AUTO_INDEX_MAX_FILES_FUSE = 50_000;

const DEFAULT_PROBE_DEADLINE_MS = 2_500;
const MAXIMUM_CONTROL_FILE_BYTES = 1_048_576;

export type AutoIndexTrigger = "session_open" | "tool_demand" | "compatibility_reindex";

export type AutoIndexSkipReason =
    | "disabled"
    | "not_git_repository"
    | "deferred_until_tool_use"
    | "paid_runtime_budget_exceeded"
    | "repository_too_large"
    | "probe_incomplete";

export type RepositoryScaleProbeStatus = "complete" | "budget_exceeded" | "incomplete";

export interface RepositoryScaleProbe {
    readonly rootPath: string;
    readonly isGitRepository: boolean;
    readonly eligibleFiles: number;
    readonly eligibleBytes: number;
    readonly estimatedTokens: number;
    readonly capped: boolean;
    readonly status?: RepositoryScaleProbeStatus;
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

export interface ProbeRepositoryScaleOptions {
    readonly deadlineMs?: number;
    readonly nowMs?: () => number;
}

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

function isPathInsideCanonicalRoot(candidatePath: string, canonicalRoot: string): boolean {
    if (canonicalRoot === path.sep) return candidatePath.startsWith(path.sep);
    return candidatePath === canonicalRoot || candidatePath.startsWith(`${canonicalRoot}${path.sep}`);
}

function readPolicyControlFileSync(
    filePath: string,
    canonicalRoot: string,
    label: string,
): string | null {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
        throw new Error(`Ignore file '${label}' must not be a symbolic link.`);
    }
    if (!stat.isFile()) {
        throw new Error(`Ignore file '${label}' is not a regular file.`);
    }
    if (stat.size > MAXIMUM_CONTROL_FILE_BYTES) {
        throw new Error(`${label} exceeds the ${MAXIMUM_CONTROL_FILE_BYTES}-byte policy limit.`);
    }
    const resolved = fs.realpathSync(filePath);
    if (!isPathInsideCanonicalRoot(resolved, canonicalRoot)) {
        throw new Error(`${label} resolves outside the codebase root.`);
    }
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        return fs.readFileSync(fd, "utf8");
    } finally {
        fs.closeSync(fd);
    }
}

function readGitInfoExcludeSync(canonicalRoot: string): string[] {
    const dotGit = fs.lstatSync(path.join(canonicalRoot, ".git"), { throwIfNoEntry: false });
    if (!dotGit || !dotGit.isDirectory()) return [];
    const infoDir = fs.lstatSync(path.join(canonicalRoot, ".git", "info"), { throwIfNoEntry: false });
    if (!infoDir || !infoDir.isDirectory()) return [];
    const content = readPolicyControlFileSync(
        path.join(canonicalRoot, ".git", "info", "exclude"),
        canonicalRoot,
        ".git/info/exclude",
    );
    return content === null ? [] : parseIgnorePatterns(content);
}

function buildProbeResult(
    rootPath: string,
    isGitRepository: boolean,
    eligibleFiles: number,
    eligibleBytes: number,
    status: RepositoryScaleProbeStatus,
): RepositoryScaleProbe {
    return Object.freeze({
        rootPath,
        isGitRepository,
        eligibleFiles,
        eligibleBytes,
        estimatedTokens: Math.ceil(eligibleBytes / 4),
        capped: status !== "complete",
        status,
    });
}

/**
 * Measures the same eligible source file population as `IndexingPipeline.getCodeFiles`
 * (tracked and untracked working-tree files, `.gitignore`/nested `.gitignore`/
 * `.git/info/exclude`/`.satoriignore`/`DEFAULT_IGNORE_PATTERNS`, and `satori.toml`
 * extension policy) without relying on `.git/index`-only shortcuts.
 */
export function probeRepositoryScale(
    rootPath: string,
    byteCeiling: number = DEFAULT_OFFLINE_TOOL_DEMAND_MAX_BYTES,
    fileCeiling: number = DEFAULT_AUTO_INDEX_MAX_FILES_FUSE,
    options?: ProbeRepositoryScaleOptions,
): RepositoryScaleProbe {
    const nowMs = options?.nowMs ?? (() => Date.now());
    const deadlineMs = options?.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
    const deadline = nowMs() + deadlineMs;
    const isGitRepository = fs.existsSync(path.join(rootPath, ".git"));

    let canonicalRoot: string;
    let supportedExtensions: ReadonlySet<string>;
    let basePatterns: readonly string[];
    let lowPatterns: readonly string[];
    let satoriignorePatterns: readonly string[];
    try {
        canonicalRoot = fs.realpathSync(rootPath);
        const repoConfig = loadSatoriRepoConfig(canonicalRoot);
        supportedExtensions = new Set(normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(repoConfig.profile),
            ...getCustomExtensionsFromEnvironment(),
        ]));
        basePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...getCustomIgnorePatternsFromEnvironment(),
        ];
        const infoExcludePatterns = readGitInfoExcludeSync(canonicalRoot);
        const rootGitignore = readPolicyControlFileSync(
            path.join(canonicalRoot, ".gitignore"),
            canonicalRoot,
            ".gitignore",
        );
        const rootSatoriignore = readPolicyControlFileSync(
            path.join(canonicalRoot, ".satoriignore"),
            canonicalRoot,
            ".satoriignore",
        );
        lowPatterns = [
            ...infoExcludePatterns,
            ...(rootGitignore === null ? [] : parseIgnorePatterns(rootGitignore)),
        ];
        satoriignorePatterns = rootSatoriignore === null ? [] : parseIgnorePatterns(rootSatoriignore);
    } catch {
        return buildProbeResult(rootPath, isGitRepository, 0, 0, "incomplete");
    }

    type WalkFrame = {
        readonly fullPath: string;
        readonly relativeDir: string;
        readonly ancestorNested: readonly string[];
        readonly inheritedMatcher: IndexIgnoreMatcher;
    };

    const initialMatcher = createIndexIgnoreMatcher([
        ...basePatterns,
        ...lowPatterns,
        ...satoriignorePatterns,
    ]);
    const stack: WalkFrame[] = [{
        fullPath: canonicalRoot,
        relativeDir: "",
        ancestorNested: [],
        inheritedMatcher: initialMatcher,
    }];

    let eligibleFiles = 0;
    let eligibleBytes = 0;

    while (stack.length > 0) {
        if (nowMs() > deadline) {
            return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "incomplete");
        }
        const frame = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(frame.fullPath, { withFileTypes: true });
        } catch {
            return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "incomplete");
        }
        entries.sort((left, right) => compareContractStrings(left.name, right.name));

        let nested = frame.ancestorNested;
        let matcher = frame.inheritedMatcher;
        if (frame.relativeDir !== "") {
            const ownGitignore = entries.find((entry) => entry.name === ".gitignore");
            if (ownGitignore) {
                const ignoreRelPath = `${frame.relativeDir}/.gitignore`;
                if (ownGitignore.isSymbolicLink() || !ownGitignore.isFile()) {
                    return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "incomplete");
                }
                try {
                    const content = readPolicyControlFileSync(
                        path.join(frame.fullPath, ".gitignore"),
                        canonicalRoot,
                        ignoreRelPath,
                    );
                    if (content !== null) {
                        nested = [
                            ...frame.ancestorNested,
                            ...translateNestedGitignorePatterns(frame.relativeDir, parseIgnorePatterns(content)),
                        ];
                        matcher = createIndexIgnoreMatcher([
                            ...basePatterns,
                            ...lowPatterns,
                            ...nested,
                            ...satoriignorePatterns,
                        ]);
                    }
                } catch {
                    return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "incomplete");
                }
            }
        }

        const childDirs: WalkFrame[] = [];
        for (const entry of entries) {
            if (nowMs() > deadline) {
                return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "incomplete");
            }
            if (!isRepositoryRelativePath(entry.name)) continue;
            const entryFullPath = path.join(frame.fullPath, entry.name);
            const entryRelativePath = frame.relativeDir === ""
                ? entry.name
                : `${frame.relativeDir}/${entry.name}`;

            if (entry.isDirectory()) {
                if (matcher.ignores(entryRelativePath) || matcher.ignores(`${entryRelativePath}/`)) {
                    continue;
                }
                childDirs.push({
                    fullPath: entryFullPath,
                    relativeDir: entryRelativePath,
                    ancestorNested: nested,
                    inheritedMatcher: matcher,
                });
                continue;
            }
            if (!entry.isFile()) continue;
            if (matcher.ignores(entryRelativePath)) continue;
            if (classifyFilePathByPolicy(entryRelativePath, supportedExtensions) === "reject") continue;

            let size: number;
            try {
                size = fs.statSync(entryFullPath).size;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT") continue;
                return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "incomplete");
            }

            let indexable: boolean;
            try {
                indexable = isIndexableFileByPolicySync(
                    entryRelativePath,
                    entryFullPath,
                    size,
                    supportedExtensions,
                );
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT") continue;
                return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "incomplete");
            }
            if (!indexable) continue;

            eligibleFiles += 1;
            eligibleBytes += size;
            if (eligibleBytes > byteCeiling || eligibleFiles > fileCeiling) {
                return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "budget_exceeded");
            }
        }

        for (let index = childDirs.length - 1; index >= 0; index -= 1) {
            stack.push(childDirs[index]!);
        }
    }

    return buildProbeResult(rootPath, isGitRepository, eligibleFiles, eligibleBytes, "complete");
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
        const emptyScale = input.scaleProbe ?? buildProbeResult(
            input.rootPath,
            fs.existsSync(path.join(input.rootPath, ".git")),
            0,
            0,
            "complete",
        );
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
        const emptyScale = input.scaleProbe ?? buildProbeResult(
            input.rootPath,
            fs.existsSync(path.join(input.rootPath, ".git")),
            0,
            0,
            "complete",
        );
        return Object.freeze({
            allow: false,
            trigger: input.trigger,
            reason: "deferred_until_tool_use",
            scale: emptyScale,
            byteLimit,
            fileLimit,
        });
    }

    const scale = input.scaleProbe ?? probeRepositoryScale(input.rootPath, byteLimit, fileLimit);

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

    // Never fail open when measurement did not finish (e.g., deadline expiry,
    // read error, or capped probe with counts still below this trigger's limit).
    if (scale.status === "incomplete" || scale.status === "budget_exceeded" || scale.capped) {
        return Object.freeze({
            allow: false,
            trigger: input.trigger,
            reason: "probe_incomplete",
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
