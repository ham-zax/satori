import fs from "node:fs";
import path from "node:path";
import {
    openRegularFileWithIdentityInsideRoot,
    type RootBoundFileIdentity,
} from "@satori-code/core";
import type { SessionWorkspacePolicy } from "./session-workspace-policy.js";

export type PublishedFileAuthorizationCode =
    | "FILE_NOT_PUBLISHED"
    | "FINAL_SYMLINK_REJECTED"
    | "NOT_A_REGULAR_FILE"
    | "OUTSIDE_CODEBASE_ROOT";

export class PublishedFileAuthorizationError extends Error {
    readonly code: PublishedFileAuthorizationCode;

    constructor(code: PublishedFileAuthorizationCode, message: string) {
        super(message);
        this.name = "PublishedFileAuthorizationError";
        this.code = code;
    }
}

export type AuthorizedPublishedFile = Readonly<{
    handle: import("node:fs/promises").FileHandle;
    codebaseRoot: string;
    absolutePath: string;
    relativePath: string;
    observedStat: import("node:fs").Stats;
    identity: RootBoundFileIdentity;
}>;

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, "/");
}

/**
 * Open a regular file only when every layer agrees it is authorized:
 *
 * 1. The workspace policy authorizes the codebase root itself.
 * 2. The workspace policy authorizes the requested path's directory.
 * 3. The canonical requested path stays inside the canonical codebase root.
 * 4. The codebase-relative path belongs to the published source manifest.
 * 5. The requested path's final component is not a symlink and is a regular
 *    file (rejects final symlinks to inside targets, FIFOs, sockets, devices,
 *    directories, and missing paths).
 * 6. The file opens through the Core descriptor-bound primitive, which adds
 *    O_NOFOLLOW, pre/post inode checks, and descriptor-path root binding.
 *
 * The caller owns closing the returned handle. No file content is read here.
 */
export async function openAuthorizedPublishedFile(input: {
    workspacePolicy: SessionWorkspacePolicy;
    codebaseRoot: string;
    requestedPath: string;
    publishedRelativePaths: ReadonlySet<string>;
}): Promise<AuthorizedPublishedFile> {
    const { workspacePolicy, codebaseRoot, requestedPath, publishedRelativePaths } = input;

    // Preserve the final component from authorization through descriptor open.
    const canonicalRoot = workspacePolicy.authorizeRoot(codebaseRoot).canonicalPath;
    if (canonicalRoot !== path.resolve(codebaseRoot)) {
        throw new PublishedFileAuthorizationError("OUTSIDE_CODEBASE_ROOT", "The published codebase root changed.");
    }
    const logicalPath = path.resolve(requestedPath);
    const parent = workspacePolicy.authorizePath(path.dirname(logicalPath)).canonicalPath;
    const canonicalPath = path.join(parent, path.basename(logicalPath));

    // Separator-boundary containment under the canonical codebase root.
    if (!(canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}${path.sep}`))) {
        throw new PublishedFileAuthorizationError(
            "OUTSIDE_CODEBASE_ROOT",
            `Requested path resolves outside the codebase root: ${requestedPath}`,
        );
    }
    const relativePath = normalizeRelativePath(path.relative(canonicalRoot, canonicalPath));
    if (
        relativePath.length === 0
        || relativePath === ".."
        || relativePath.startsWith("../")
        || path.isAbsolute(relativePath)
    ) {
        throw new PublishedFileAuthorizationError(
            "OUTSIDE_CODEBASE_ROOT",
            `Requested path has no codebase-relative path: ${requestedPath}`,
        );
    }

    // Reject final symlinks (even to inside targets) before publication lookup
    // so an in-root symlink to an unpublished file never discloses its resolved
    // relativePath in a FILE_NOT_PUBLISHED message. Non-symlink missing paths,
    // directories, and FIFOs stay behind the publication check so unpublished
    // paths return uniform FILE_NOT_PUBLISHED with no existence/type oracle.
    let preStat: fs.Stats | undefined;
    try {
        preStat = fs.lstatSync(canonicalPath);
    } catch {
        preStat = undefined;
    }
    if (preStat?.isSymbolicLink()) {
        throw new PublishedFileAuthorizationError(
            "FINAL_SYMLINK_REJECTED",
            `Final path component is a symlink: ${requestedPath}`,
        );
    }

    // Publication membership is decided on the canonical relative path, so a
    // manifest cannot be bypassed by spelling the same file differently.
    if (!publishedRelativePaths.has(relativePath)) {
        throw new PublishedFileAuthorizationError(
            "FILE_NOT_PUBLISHED",
            `File is not in the published source manifest: ${relativePath}`,
        );
    }

    // Reject directories, FIFOs, sockets, devices, and missing paths before
    // opening anything.
    if (!preStat) {
        throw new PublishedFileAuthorizationError(
            "NOT_A_REGULAR_FILE",
            `Requested file does not exist: ${requestedPath}`,
        );
    }
    if (!preStat.isFile()) {
        throw new PublishedFileAuthorizationError(
            "NOT_A_REGULAR_FILE",
            `Requested path is not a regular file: ${requestedPath}`,
        );
    }

    const opened = await openRegularFileWithIdentityInsideRoot(canonicalPath, canonicalRoot, {
        rejectFinalSymlink: true,
    });
    if (opened.identity.canonicalRelativePath !== relativePath) {
        await opened.handle.close();
        throw new PublishedFileAuthorizationError(
            "OUTSIDE_CODEBASE_ROOT",
            `Opened file differs from its authorized path: ${requestedPath}`,
        );
    }
    return Object.freeze({
        handle: opened.handle,
        codebaseRoot: canonicalRoot,
        absolutePath: canonicalPath,
        relativePath,
        observedStat: opened.observedStat,
        identity: opened.identity,
    });
}
