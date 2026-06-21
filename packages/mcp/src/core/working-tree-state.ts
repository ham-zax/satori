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
};

type SnapshotFingerprintGate = {
    allowed: boolean;
    changed: boolean;
    reason?: unknown;
};

type GetChangedFilesForCodebaseInput = {
    codebasePath: string;
    nowMs: number;
    changedFilesCache: Map<string, ChangedFilesCacheEntry>;
    ttlMs: number;
};

type EvaluateReindexPreflightInput = {
    codebasePath: string;
    currentStatus: string;
    ensureFingerprintCompatibility: (codebasePath: string) => SnapshotFingerprintGate;
    getWorkingTreeChangedPathsForPreflight: (codebasePath: string) => WorkingTreeChangedPathsState;
};

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
        if (normalizedPath.length === 0 || normalizedPath.startsWith("..")) {
            continue;
        }

        files.add(normalizedPath);
    }
    return files;
}

export function getChangedFilesForCodebase(input: GetChangedFilesForCodebaseInput): ChangedFilesState {
    const cacheKey = path.resolve(input.codebasePath);
    const cached = input.changedFilesCache.get(cacheKey);
    if (cached && cached.expiresAtMs > input.nowMs) {
        return { available: cached.available, files: new Set(cached.files) };
    }

    try {
        const stdout = execFileSync(
            "git",
            ["-C", cacheKey, "status", "--porcelain", "--untracked-files=no"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        const files = parseGitStatusChangedPaths(stdout, { includeUntracked: false });
        input.changedFilesCache.set(cacheKey, {
            expiresAtMs: input.nowMs + input.ttlMs,
            available: true,
            files,
        });
        return { available: true, files };
    } catch {
        if (cached) {
            input.changedFilesCache.set(cacheKey, {
                expiresAtMs: input.nowMs + input.ttlMs,
                available: cached.available,
                files: new Set(cached.files),
            });
            return { available: cached.available, files: new Set(cached.files) };
        }
        input.changedFilesCache.set(cacheKey, {
            expiresAtMs: input.nowMs + input.ttlMs,
            available: false,
            files: new Set<string>(),
        });
        return { available: false, files: new Set<string>() };
    }
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
    const isIndexedLikeStatus = input.currentStatus === "indexed" || input.currentStatus === "sync_completed";
    if (input.currentStatus === "requires_reindex") {
        return {
            outcome: "reindex_required",
            warnings: [],
            confidence: "high",
        };
    }

    const gate = input.ensureFingerprintCompatibility(input.codebasePath);
    if (!gate.allowed || gate.changed || gate.reason) {
        return {
            outcome: "reindex_required",
            warnings: [],
            confidence: "high",
        };
    }

    const workingTree = input.getWorkingTreeChangedPathsForPreflight(input.codebasePath);
    if (!workingTree.available || workingTree.probeFailed) {
        return {
            outcome: "probe_failed",
            warnings: [WARNING_CODES.IGNORE_POLICY_PROBE_FAILED],
            confidence: "low",
            probeFailed: true,
        };
    }

    const changedFiles = [...workingTree.files];
    if (changedFiles.length === 0) {
        return {
            outcome: "unknown",
            warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
            confidence: "low",
        };
    }

    const ignoreOnlySet = new Set([".gitignore", ".satoriignore", "satori.toml"]);
    if (changedFiles.every((changedFile) => ignoreOnlySet.has(changedFile))) {
        if (!isIndexedLikeStatus) {
            return {
                outcome: "unknown",
                warnings: [WARNING_CODES.REINDEX_PREFLIGHT_UNKNOWN],
                confidence: "low",
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
    };
}
