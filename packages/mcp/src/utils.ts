import * as path from "path";

/**
 * Truncate content to specified length
 */
export function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content;
    }
    return content.substring(0, maxLength) + '...';
}

export type AbsolutePathOk = {
    ok: true;
    absolutePath: string;
};

export type AbsolutePathErr = {
    ok: false;
    path: string;
    message: string;
};

export type AbsolutePathResult = AbsolutePathOk | AbsolutePathErr;

export type RepoRelativeFileOk = {
    ok: true;
    relativePath: string;
};

export type RepoRelativeFileErr = {
    ok: false;
    path: string;
    message: string;
};

export type RepoRelativeFileResult = RepoRelativeFileOk | RepoRelativeFileErr;

const RELATIVE_ABSOLUTE_FIELD_MESSAGE =
    "must be an absolute filesystem path. Relative paths are rejected and are not resolved against the MCP process CWD.";

/**
 * Validate a public MCP tool field that is documented as an ABSOLUTE filesystem path.
 * Does not call path.resolve on relative inputs (no CWD dependence).
 * Absolute inputs are normalized with path.resolve to collapse . / .. segments only.
 */
export function requireAbsoluteFilesystemPath(
    inputPath: string,
    fieldName = "path",
): AbsolutePathResult {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
        return {
            ok: false,
            path: typeof inputPath === "string" ? inputPath : String(inputPath),
            message: `Error: '${fieldName}' ${RELATIVE_ABSOLUTE_FIELD_MESSAGE}`,
        };
    }

    const trimmed = inputPath.trim();
    if (!path.isAbsolute(trimmed)) {
        return {
            ok: false,
            path: trimmed,
            message: `Error: '${fieldName}' ${RELATIVE_ABSOLUTE_FIELD_MESSAGE}`,
        };
    }

    // Absolute-only normalize: collapses . / .. without using process CWD as the base.
    return {
        ok: true,
        absolutePath: path.resolve(trimmed),
    };
}

/**
 * Normalize and validate a repo-relative file path (not absolute, no CWD resolve).
 * Escape attempts (`..` segments, absolute forms) are rejected at this layer when possible;
 * callers must still join against a validated root and re-check containment.
 */
export function requireRepoRelativeFilePath(
    inputPath: string,
    fieldName = "file",
): RepoRelativeFileResult {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
        return {
            ok: false,
            path: typeof inputPath === "string" ? inputPath : String(inputPath),
            message: `Error: '${fieldName}' must be a non-empty repo-relative path inside the codebase root.`,
        };
    }

    const normalized = inputPath.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
    if (normalized.length === 0) {
        return {
            ok: false,
            path: inputPath,
            message: `Error: '${fieldName}' must be a non-empty repo-relative path inside the codebase root.`,
        };
    }

    // Reject POSIX/Windows absolute forms and Windows drive-relative forms (C:foo), which are CWD-dependent.
    if (
        path.isAbsolute(normalized)
        || path.win32.isAbsolute(normalized)
        || /^[A-Za-z]:/.test(normalized)
    ) {
        return {
            ok: false,
            path: normalized,
            message: `Error: '${fieldName}' must be a repo-relative path inside the codebase root, not an absolute or drive-relative path.`,
        };
    }

    if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../") || normalized.endsWith("/..")) {
        return {
            ok: false,
            path: normalized,
            message: `Error: '${fieldName}' must stay inside the codebase root (path escape segments are not allowed).`,
        };
    }

    return {
        ok: true,
        relativePath: normalized,
    };
}

/**
 * Prefer requireAbsoluteFilesystemPath for public tool inputs.
 * Throws if the input is not absolute (no silent CWD resolve).
 */
export function ensureAbsolutePath(inputPath: string): string {
    const result = requireAbsoluteFilesystemPath(inputPath, "path");
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result.absolutePath;
}

/** Absolute path if valid; otherwise original input (for error envelopes without throwing). */
export function absolutePathOrRaw(inputPath: string): string {
    const result = requireAbsoluteFilesystemPath(inputPath, "path");
    return result.ok ? result.absolutePath : inputPath;
}

export function trackCodebasePath(codebasePath: string): void {
    const absolutePath = ensureAbsolutePath(codebasePath);
    console.log(`[TRACKING] Registered codebase path for indexing/sync lifecycle: ${absolutePath}`);
}
