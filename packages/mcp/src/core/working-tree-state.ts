import * as path from "path";
import { execFileSync } from "node:child_process";
import type { ManageReindexPreflightOutcome } from "./manage-types.js";
import { WARNING_CODES, type WarningCode } from "./warnings.js";

export type ChangedFilesState = {
    available: boolean;
    files: Set<string>;
};

export type ChangedFilesCacheEntry = ChangedFilesState & {
    expiresAtMs: number;
};

export type WorkingTreeChangedPathsState = ChangedFilesState & {
    probeFailed: boolean;
};

export type ReindexPreflightResult = {
    outcome: ManageReindexPreflightOutcome;
    warnings: WarningCode[];
    confidence: "high" | "low";
    probeFailed?: boolean;
    explanation?: string;
};

type GetChangedFilesForCodebaseInput = {
    codebasePath: string;
    nowMs: number;
    changedFilesCache: Map<string, ChangedFilesCacheEntry>;
    ttlMs: number;
    forceRefresh?: boolean;
};

type EvaluateReindexPreflightInput = {
    codebasePath: string;
    hasCurrentPublication: boolean;
    getWorkingTreeChangedPathsForPreflight: (codebasePath: string) => WorkingTreeChangedPathsState;
};

const MAX_CHANGED_FILES_CACHE_ROOTS = 32;

export function parseGitStatusChangedPaths(
    stdout: string,
    options: { includeUntracked?: boolean } = {},
): Set<string> {
    const includeUntracked = options.includeUntracked === true;
    const files = new Set<string>();
    const lines = stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
    for (const line of lines) {
        if (line.length < 4) {
            continue;
        }
        const status = line.slice(0, 2);
        if (status === "!!") {
            continue;
        }
        if (status === "??" && !includeUntracked) {
            continue;
        }

        let rawPath = line.slice(3).trim();
        if (rawPath.length === 0) {
            continue;
        }

        if (rawPath.includes(" -> ")) {
            const parts = rawPath.split(" -> ");
            rawPath = parts[parts.length - 1].trim();
        }

        if (rawPath.startsWith("\"") && rawPath.endsWith("\"") && rawPath.length >= 2) {
            rawPath = rawPath.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
        }

        const normalizedPath = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
        if (normalizedPath.length === 0 || normalizedPath === ".." || normalizedPath.startsWith("../")) {
            continue;
        }

        files.add(normalizedPath);
    }
    return files;
}

export function parseGitStatusChangedPathsZ(
    stdout: string,
    options: { includeUntracked?: boolean } = {},
): Set<string> {
    const includeUntracked = options.includeUntracked === true;
    const files = new Set<string>();
    const records = stdout.split("\0");
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.length < 4) {
            continue;
        }
        const status = record.slice(0, 2);
        if (status === "!!") {
            continue;
        }
        if (status === "??" && !includeUntracked) {
            continue;
        }
        if ((status[0] === "R" || status[0] === "C") && index + 1 < records.length) {
            // With -z, rename/copy entries carry the origin path as the next record.
            index += 1;
        }
        const rawPath = record.slice(3);
        if (rawPath.length === 0) {
            continue;
        }
        const normalizedPath = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
        if (normalizedPath.length === 0 || normalizedPath === ".." || normalizedPath.startsWith("../")) {
            continue;
        }
        files.add(normalizedPath);
    }
    return files;
}

export function getChangedFilesForCodebase(input: GetChangedFilesForCodebaseInput): ChangedFilesState {
    const cacheKey = path.resolve(input.codebasePath);
    // Preserve this root's stale fallback before pruning abandoned entries.
    const cached = input.changedFilesCache.get(cacheKey);
    for (const [key, entry] of input.changedFilesCache) {
        if (entry.expiresAtMs <= input.nowMs) input.changedFilesCache.delete(key);
    }
    let state: ChangedFilesState;
    let expiresAtMs = input.nowMs + input.ttlMs;
    if (!input.forceRefresh && cached && cached.expiresAtMs > input.nowMs) {
        state = cached;
        expiresAtMs = cached.expiresAtMs;
    } else {
        try {
            const stdout = execFileSync(
                "git",
                ["-C", cacheKey, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
            );
            state = { available: true, files: parseGitStatusChangedPathsZ(stdout, { includeUntracked: true }) };
        } catch {
            state = cached ?? { available: false, files: new Set<string>() };
        }
    }

    // Map insertion order is recency order for hits and every probe outcome.
    input.changedFilesCache.delete(cacheKey);
    input.changedFilesCache.set(cacheKey, { expiresAtMs, available: state.available, files: state.files });
    while (input.changedFilesCache.size > MAX_CHANGED_FILES_CACHE_ROOTS) {
        input.changedFilesCache.delete(input.changedFilesCache.keys().next().value!);
    }
    return { available: state.available, files: new Set(state.files) };
}

export function getWorkingTreeChangedPathsForPreflight(
    codebasePath: string,
): WorkingTreeChangedPathsState {
    try {
        const stdout = execFileSync(
            "git",
            ["-C", codebasePath, "status", "--porcelain"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        const files = parseGitStatusChangedPaths(stdout, { includeUntracked: true });
        return { available: true, probeFailed: false, files };
    } catch {
        return { available: false, probeFailed: true, files: new Set<string>() };
    }
}

export function evaluateReindexPreflight(input: EvaluateReindexPreflightInput): ReindexPreflightResult {
    const workingTree = input.getWorkingTreeChangedPathsForPreflight(input.codebasePath);
    if (!workingTree.available || workingTree.probeFailed) {
        return {
            outcome: "probe_failed",
            warnings: [WARNING_CODES.IGNORE_POLICY_PROBE_FAILED],
            confidence: "low",
            probeFailed: true,
            explanation: "The working-tree probe failed. Preflight cannot determine whether reindexing is needed.",
        };
    }

    const changedFiles = [...workingTree.files];
    if (changedFiles.length === 0) {
        return {
            outcome: "unknown",
            warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
            confidence: "low",
            explanation: "Git reports no working-tree changes. Preflight does not compare the working tree with the indexed source.",
        };
    }

    const ignoreOnlySet = new Set([".gitignore", ".satoriignore", "satori.toml"]);
    if (changedFiles.every((changedFile) => ignoreOnlySet.has(changedFile))) {
        if (!input.hasCurrentPublication) {
            return {
                outcome: "unknown",
                warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
                confidence: "low",
                explanation: "Only ignore-policy files changed, but no current index is available for comparison.",
            };
        }
        return {
            outcome: "reindex_unnecessary_ignore_only",
            warnings: [WARNING_CODES.REINDEX_UNNECESSARY_IGNORE_ONLY],
            confidence: "high",
        };
    }

    return {
        outcome: "unknown",
        warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
        confidence: "low",
        explanation: "The working tree contains changes beyond ignore-policy files. Preflight cannot determine whether reindexing is needed.",
    };
}
