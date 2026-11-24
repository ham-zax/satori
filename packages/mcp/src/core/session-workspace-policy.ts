import fs from "node:fs";
import path from "node:path";

/**
 * Canonical workspace authorization for one MCP session.
 *
 * The policy is immutable: roots are fixed at construction from launcher
 * configuration and cannot be expanded by tool arguments or by mutating the
 * exposed `roots` array. Authorization is canonical separator-boundary
 * containment of real paths, never string-prefix containment.
 */

export type WorkspaceAuthorizationCode =
    | "ROOT_NOT_AUTHORIZED"
    | "BROAD_ROOT_NOT_ALLOWED"
    | "INVALID_WORKSPACE_ROOT"
    | "WORKSPACE_POLICY_NOT_BOUND";

export class WorkspaceAuthorizationError extends Error {
    readonly code: WorkspaceAuthorizationCode;

    constructor(code: WorkspaceAuthorizationCode, message: string) {
        super(message);
        this.name = "WorkspaceAuthorizationError";
        this.code = code;
    }
}

export type AuthorizedWorkspacePath = Readonly<{
    workspaceRoot: string;
    canonicalPath: string;
    relativePath: string;
}>;

export interface SessionWorkspacePolicy {
    readonly roots: readonly string[];
    authorizeRoot(candidateRoot: string): AuthorizedWorkspacePath;
    authorizePath(candidatePath: string): AuthorizedWorkspacePath;
}

/**
 * Resolve to an absolute path and, when the target exists, its real path
 * (follows symlinks). For non-existent paths, resolve the deepest existing
 * ancestor and re-append the missing suffix, so a symlinked prefix cannot
 * smuggle a not-yet-existing path outside the root. Non-existent paths with
 * no resolvable ancestor keep path.resolve output so `..` segments are still
 * collapsed.
 *
 * A path that passes through a dangling symlink (a symlink whose target
 * cannot be resolved) never falls back to its lexical form: the real target
 * cannot be established, so the path is denied with
 * `INVALID_WORKSPACE_ROOT` rather than authorized lexically.
 */
function canonicalizePath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        if (containsDanglingSymlink(resolved)) {
            throw new WorkspaceAuthorizationError(
                "INVALID_WORKSPACE_ROOT",
                `Path resolves through a dangling symlink and cannot be authorized: ${resolved}`,
            );
        }
        const missingParts: string[] = [];
        let current = resolved;
        for (;;) {
            try {
                const real = fs.realpathSync.native(current);
                if (missingParts.length === 0) {
                    return real;
                }
                return path.join(real, ...missingParts.reverse());
            } catch {
                const parent = path.dirname(current);
                if (parent === current) {
                    return resolved;
                }
                missingParts.push(path.basename(current));
                current = parent;
            }
        }
    }
}

/**
 * True when any component of the resolved absolute path is a symlink whose
 * target cannot be resolved (a dangling symlink). Walks components with
 * `lstat` so intermediate symlinks are inspected without following them;
 * a component that does not exist ends the walk (nothing beyond it can be
 * a symlink).
 */
function containsDanglingSymlink(resolvedPath: string): boolean {
    const root = path.parse(resolvedPath).root;
    let current = root;
    const components = resolvedPath.slice(root.length).split(path.sep);
    for (const component of components) {
        if (component.length === 0) {
            continue;
        }
        current = path.join(current, component);
        let stats: fs.Stats;
        try {
            stats = fs.lstatSync(current);
        } catch {
            // Component does not exist; nothing beyond it can be a symlink.
            return false;
        }
        if (stats.isSymbolicLink()) {
            try {
                fs.realpathSync.native(current);
            } catch {
                // Symlink whose target cannot be resolved: dangling.
                return true;
            }
        }
    }
    return false;
}

/**
 * Separator-boundary containment of a canonical path inside a canonical root.
 * Never a string-prefix match: `/repo` does not contain `/repo-other`.
 */
function isPathInsideRoot(canonicalPath: string, canonicalRoot: string): boolean {
    if (canonicalRoot === path.sep) {
        return canonicalPath.startsWith(path.sep);
    }
    return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}${path.sep}`);
}

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, "/");
}

function isGitProjectDirectory(candidateDir: string): boolean {
    const dirStat = fs.lstatSync(candidateDir, { throwIfNoEntry: false });
    if (!dirStat || !dirStat.isDirectory()) return false;
    const dotGitStat = fs.lstatSync(path.join(candidateDir, ".git"), { throwIfNoEntry: false });
    return dotGitStat !== undefined && (dotGitStat.isDirectory() || dotGitStat.isFile());
}

export function createSessionWorkspacePolicy(input: {
    roots: readonly string[];
    homeDirectory: string;
    stateRoot: string;
    allowBroadRoots?: boolean;
    /**
     * Set only when `roots` fell back to `[process.cwd()]` because no explicit
     * `SATORI_SESSION_ROOTS_JSON` was supplied (e.g. global IDE hosts such as
     * Cursor, VS Code, Windsurf, or Antigravity spawning MCP servers in `$HOME`
     * or `/`). Allows `$HOME` or `/` to act as a container only for descendant
     * Git project paths while rejecting `$HOME`, `/`, `stateRoot`, and any path
     * outside a Git repository.
     */
    allowImplicitBroadContainerRoot?: boolean;
}): SessionWorkspacePolicy {
    const allowBroadRoots = input.allowBroadRoots === true;
    const allowImplicitBroadContainerRoot = input.allowImplicitBroadContainerRoot === true;

    const canonicalRoots: string[] = [];
    for (const root of input.roots) {
        if (typeof root !== "string" || !path.isAbsolute(root)) {
            throw new WorkspaceAuthorizationError(
                "INVALID_WORKSPACE_ROOT",
                `Workspace roots must be absolute paths; rejected root: ${String(root)}`,
            );
        }
        canonicalRoots.push(canonicalizePath(root));
    }

    const canonicalHome = canonicalizePath(input.homeDirectory);
    const canonicalStateRoot = canonicalizePath(input.stateRoot);

    const isBroadPath = (canonicalPath: string): boolean =>
        canonicalPath === path.sep
        || canonicalPath === canonicalHome
        || canonicalPath === canonicalStateRoot;

    const isAllowedImplicitContainer = (canonicalPath: string): boolean =>
        allowImplicitBroadContainerRoot
        && !isPathInsideRoot(canonicalPath, canonicalStateRoot)
        && (canonicalPath === canonicalHome || canonicalPath === path.sep);

    if (!allowBroadRoots) {
        for (const root of canonicalRoots) {
            if (isBroadPath(root) && !isAllowedImplicitContainer(root)) {
                throw new WorkspaceAuthorizationError(
                    "BROAD_ROOT_NOT_ALLOWED",
                    `Broad workspace root is not allowed without allowBroadRoots: ${root}`,
                );
            }
        }
    }

    // Reduce duplicate and nested roots to the narrowest set that expresses
    // the same authority: a root contained in another root adds nothing.
    const reducedRoots: string[] = [];
    const sorted = [...canonicalRoots].sort((a, b) => a.length - b.length);
    for (const root of sorted) {
        if (reducedRoots.some((kept) => isPathInsideRoot(root, kept))) {
            continue;
        }
        reducedRoots.push(root);
    }
    const roots = Object.freeze(reducedRoots);
    const hasExplicitChildUnderStateRoot = roots.some(
        (root) => root !== canonicalStateRoot && isPathInsideRoot(root, canonicalStateRoot),
    );
    const implicitContainerRoots = new Set(
        !allowBroadRoots
            ? roots.filter((root) => isAllowedImplicitContainer(root))
            : [],
    );

    const resolveImplicitGitProjectRoot = (canonicalPath: string, containerRoot: string): string | null => {
        let cursor = canonicalPath;
        for (;;) {
            if (
                cursor === containerRoot
                || cursor === path.sep
                || cursor === canonicalHome
                || isPathInsideRoot(cursor, canonicalStateRoot)
                || !isPathInsideRoot(cursor, containerRoot)
            ) {
                return null;
            }
            if (isGitProjectDirectory(cursor)) {
                return cursor;
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) return null;
            cursor = parent;
        }
    };

    const authorize = (candidate: string): AuthorizedWorkspacePath => {
        if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
            throw new WorkspaceAuthorizationError(
                "INVALID_WORKSPACE_ROOT",
                `Authorization candidates must be absolute paths; rejected candidate: ${String(candidate)}`,
            );
        }
        const canonicalPath = canonicalizePath(candidate);
        const isBlockedStateSubpath = !hasExplicitChildUnderStateRoot
            && isPathInsideRoot(canonicalPath, canonicalStateRoot);
        if (!allowBroadRoots && (isBroadPath(canonicalPath) || isBlockedStateSubpath)) {
            throw new WorkspaceAuthorizationError(
                "BROAD_ROOT_NOT_ALLOWED",
                "Broad path is not authorized.",
            );
        }
        for (const root of roots) {
            if (implicitContainerRoots.has(root)) continue;
            if (isPathInsideRoot(canonicalPath, root)) {
                return Object.freeze({
                    workspaceRoot: root,
                    canonicalPath,
                    relativePath: normalizeRelativePath(path.relative(root, canonicalPath)),
                });
            }
        }
        for (const containerRoot of implicitContainerRoots) {
            if (!isPathInsideRoot(canonicalPath, containerRoot)) continue;
            const projectRoot = resolveImplicitGitProjectRoot(canonicalPath, containerRoot);
            if (projectRoot) {
                return Object.freeze({
                    workspaceRoot: projectRoot,
                    canonicalPath,
                    relativePath: normalizeRelativePath(path.relative(projectRoot, canonicalPath)),
                });
            }
        }
        throw new WorkspaceAuthorizationError(
            "ROOT_NOT_AUTHORIZED",
            "Path is not inside any authorized workspace root.",
        );
    };

    return Object.freeze({
        roots,
        authorizeRoot: (candidateRoot: string): AuthorizedWorkspacePath => authorize(candidateRoot),
        authorizePath: (candidatePath: string): AuthorizedWorkspacePath => authorize(candidatePath),
    });
}
