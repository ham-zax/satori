import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serverFS, type FileSystemCallbacks, type FileSystemEntries, type FileSystemStat } from './typescript-api';

function canonicalizeExistingDirectory(
    dirPath: string,
    canonicalDirCache?: Map<string, string | null>,
): string | null {
    if (canonicalDirCache) {
        const cached = canonicalDirCache.get(dirPath);
        if (cached !== undefined) return cached;
    }
    let real: string | null;
    try {
        real = fs.realpathSync.native(dirPath);
    } catch {
        real = null;
    }
    canonicalDirCache?.set(dirPath, real);
    return real;
}

function canonicalizeExistingOrNearest(
    inputPath: string,
    canonicalDirCache?: Map<string, string | null>,
): string | null {
    const resolved = path.resolve(inputPath);
    // Avoid throwing ENOENT on thousands of absent module-resolution probes.
    const direct = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (direct) {
        if (canonicalDirCache && !direct.isSymbolicLink() && direct.isDirectory()) {
            return canonicalizeExistingDirectory(resolved, canonicalDirCache);
        }
        try {
            return fs.realpathSync.native(resolved);
        } catch {
            return null;
        }
    }
    const missing: string[] = [path.basename(resolved)];
    let current = path.dirname(resolved);
    for (;;) {
        // If an existing component is a dangling symlink, reject fail-closed.
        const lstat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (lstat?.isSymbolicLink()) {
            return null;
        }
        if (lstat) {
            const real = lstat.isDirectory()
                ? canonicalizeExistingDirectory(current, canonicalDirCache)
                : canonicalizeExistingDirectory(current);
            if (!real) return null;
            return missing.length === 0 ? real : path.join(real, ...missing.reverse());
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return resolved;
        }
        missing.push(path.basename(current));
        current = parent;
    }
}

function isWithinCanonicalRoot(candidate: string, canonicalRoot: string): boolean {
    if (canonicalRoot === path.sep) {
        return candidate.startsWith(path.sep);
    }
    return candidate === canonicalRoot || candidate.startsWith(`${canonicalRoot}${path.sep}`);
}

let cachedTypeScriptLibDirectories: readonly string[] | undefined;

/**
 * Resolves the canonical built-in TypeScript library directories (both the
 * `typescript` package's `lib/` and the native platform package's `lib/` where
 * TypeScript 7 loads `lib.es*.d.ts`).
 */
export function resolveTypeScriptLibDirectories(): readonly string[] {
    if (cachedTypeScriptLibDirectories) return cachedTypeScriptLibDirectories;
    const dirs = new Set<string>();
    const addIfDir = (candidate: string): void => {
        try {
            const real = fs.realpathSync.native(candidate);
            if (fs.statSync(real).isDirectory()) {
                dirs.add(real);
            }
        } catch {
            // Optional platform package layout may differ; ignore absent paths.
        }
    };
    let tsPkgPath: string | null = null;
    try {
        tsPkgPath = require.resolve('typescript/package.json');
        addIfDir(path.join(path.dirname(tsPkgPath), 'lib'));
    } catch {
        // Fallback when bundled without standard resolution.
    }
    const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
    // Under strict package-manager isolation (e.g. pnpm), the native platform
    // package is an optionalDependency of `typescript`, not of `@satori-code/core`,
    // so resolve it relative to the installed `typescript` package first.
    if (tsPkgPath) {
        try {
            const requireFromTs = createRequire(tsPkgPath);
            const platformPkgPath = requireFromTs.resolve(platformPkg);
            addIfDir(path.join(path.dirname(platformPkgPath), 'lib'));
        } catch {
            // Fall back to direct resolution below.
        }
    }
    try {
        const platformPkgPath = require.resolve(platformPkg);
        addIfDir(path.join(path.dirname(platformPkgPath), 'lib'));
    } catch {
        // Platform binary package may live under another layout.
    }
    cachedTypeScriptLibDirectories = Object.freeze([...dirs]);
    return cachedTypeScriptLibDirectories;
}

/**
 * Read-only filesystem containment boundary for TypeScript 7.1 `ts.API`
 * callbacks and bounded file reads.
 *
 * Allows only paths whose canonical real path stays within the repository root
 * or the installed TypeScript built-in library directory. Symlinks targeting
 * files inside the repository root remain allowed; symlinks or `..` paths
 * escaping outside those roots are denied fail-closed.
 */
export class TypeScriptFsBoundary {
    readonly canonicalRepoRoot: string;
    private readonly allowedRoots: readonly string[];

    constructor(repoRoot: string, extraAllowedRoots: readonly string[] = resolveTypeScriptLibDirectories()) {
        this.canonicalRepoRoot = canonicalizeExistingOrNearest(repoRoot) ?? path.resolve(repoRoot);
        const roots = new Set<string>([this.canonicalRepoRoot]);
        for (const extra of extraAllowedRoots) {
            const canonical = canonicalizeExistingOrNearest(extra);
            if (canonical) roots.add(canonical);
        }
        this.allowedRoots = Object.freeze([...roots]);
    }

    /** Returns true when an already-canonical path resolves within an allowed root. */
    isAllowedCanonicalPath(canonicalPath: string): boolean {
        if (!canonicalPath || canonicalPath.includes('\0')) return false;
        for (const root of this.allowedRoots) {
            if (isWithinCanonicalRoot(canonicalPath, root)) {
                return true;
            }
        }
        return false;
    }

    /** Returns the canonical path when contained within the boundary, or `null` when outside/dangling. */
    resolveAllowedPath(candidatePath: string, canonicalDirCache?: Map<string, string | null>): string | null {
        if (!candidatePath || candidatePath.includes('\0')) return null;
        const canonical = canonicalizeExistingOrNearest(candidatePath, canonicalDirCache);
        if (!canonical) return null;
        return this.isAllowedCanonicalPath(canonical) ? canonical : null;
    }

    /** Creates a per-operation resolver that reuses directory realpaths within one synchronous pass. */
    createScopedPathResolver(): {
        isAllowedPath: (candidatePath: string) => boolean;
        resolveAllowedPath: (candidatePath: string) => string | null;
        resolveMissingAllowedPath: (candidatePath: string) => string | null;
        resolveAllowedReadFile: (candidatePath: string) => { targetPath: string; size: number } | null;
        isAllowedCanonicalPath: (canonicalPath: string) => boolean;
        directoryExists: (directoryName: string) => boolean;
        fileExists: (fileName: string) => boolean;
        realpath: (targetPath: string) => string;
        stat: (targetPath: string) => FileSystemStat | undefined;
        getAccessibleEntries: (directoryName: string) => FileSystemEntries;
    } {
        const canonicalDirCache = new Map<string, string | null>();
        const missingDirCache = new Map<string, string | null>();
        const existingDirCache = new Map<string, string | null>();

        const resolveMissingParent = (dirPath: string): string | null => {
            const cached = missingDirCache.get(dirPath);
            if (cached !== undefined) return cached;
            const lstat = fs.lstatSync(dirPath, { throwIfNoEntry: false });
            if (lstat?.isSymbolicLink()) {
                missingDirCache.set(dirPath, null);
                return null;
            }
            if (lstat) {
                const real = lstat.isDirectory()
                    ? canonicalizeExistingDirectory(dirPath, canonicalDirCache)
                    : canonicalizeExistingDirectory(dirPath);
                const allowed = real && this.isAllowedCanonicalPath(real) ? real : null;
                missingDirCache.set(dirPath, allowed);
                return allowed;
            }
            const parent = path.dirname(dirPath);
            if (parent === dirPath) {
                const allowed = this.isAllowedCanonicalPath(dirPath) ? dirPath : null;
                missingDirCache.set(dirPath, allowed);
                return allowed;
            }
            const parentReal = resolveMissingParent(parent);
            if (!parentReal) {
                missingDirCache.set(dirPath, null);
                return null;
            }
            const joined = path.join(parentReal, path.basename(dirPath));
            const allowed = this.isAllowedCanonicalPath(joined) ? joined : null;
            missingDirCache.set(dirPath, allowed);
            return allowed;
        };

        const resolveExistingDir = (dirPath: string): string | null => {
            const cached = existingDirCache.get(dirPath);
            if (cached !== undefined) return cached;
            const real = canonicalizeExistingDirectory(dirPath, canonicalDirCache);
            const allowed = real && this.isAllowedCanonicalPath(real) ? real : null;
            existingDirCache.set(dirPath, allowed);
            return allowed;
        };

        const resolveAllowedNonSymlinkLeaf = (resolved: string): string | null => {
            const parent = path.dirname(resolved);
            if (parent === resolved) return this.isAllowedCanonicalPath(resolved) ? resolved : null;
            const parentReal = resolveExistingDir(parent);
            if (!parentReal) return null;
            const targetPath = path.join(parentReal, path.basename(resolved));
            return this.isAllowedCanonicalPath(targetPath) ? targetPath : null;
        };

        const resolveAllowed = (candidatePath: string): string | null => this.resolveAllowedPath(candidatePath, canonicalDirCache);

        return {
            isAllowedPath: (candidatePath) => resolveAllowed(candidatePath) !== null,
            resolveAllowedPath: resolveAllowed,
            resolveMissingAllowedPath: (candidatePath) => {
                if (!candidatePath || candidatePath.includes('\0')) return null;
                const resolved = path.resolve(candidatePath);
                if (fs.lstatSync(resolved, { throwIfNoEntry: false })) return null;
                const parent = path.dirname(resolved);
                if (parent === resolved) return null;
                const parentReal = resolveMissingParent(parent);
                if (!parentReal) return null;
                const joined = path.join(parentReal, path.basename(resolved));
                return this.isAllowedCanonicalPath(joined) ? joined : null;
            },
            resolveAllowedReadFile: (candidatePath) => {
                if (!candidatePath || candidatePath.includes('\0')) return null;
                if (process.platform === 'linux') {
                    const resolved = path.resolve(candidatePath);
                    const lstat = fs.lstatSync(resolved, { throwIfNoEntry: false });
                    if (!lstat) return null;
                    if (!lstat.isSymbolicLink()) {
                        if (!lstat.isFile()) return null;
                        const targetPath = resolveAllowedNonSymlinkLeaf(resolved);
                        return targetPath ? { targetPath, size: lstat.size } : null;
                    }
                }
                const targetPath = resolveAllowed(candidatePath);
                if (!targetPath) return null;
                const stat = fs.statSync(targetPath, { throwIfNoEntry: false });
                return stat?.isFile() ? { targetPath, size: stat.size } : null;
            },
            isAllowedCanonicalPath: (canonicalPath) => this.isAllowedCanonicalPath(canonicalPath),
            directoryExists: (directoryName) => {
                if (!directoryName || directoryName.includes('\0')) return false;
                const resolved = path.resolve(directoryName);
                const lstat = fs.lstatSync(resolved, { throwIfNoEntry: false });
                if (!lstat) return false;
                if (!lstat.isSymbolicLink()) {
                    if (!lstat.isDirectory()) return false;
                    return resolveExistingDir(resolved) !== null;
                }
                return this.directoryExists(directoryName, canonicalDirCache);
            },
            fileExists: (fileName) => {
                if (!fileName || fileName.includes('\0')) return false;
                if (process.platform === 'linux') {
                    const resolved = path.resolve(fileName);
                    const lstat = fs.lstatSync(resolved, { throwIfNoEntry: false });
                    if (!lstat) return false;
                    if (!lstat.isSymbolicLink()) {
                        if (!lstat.isFile()) return false;
                        return resolveAllowedNonSymlinkLeaf(resolved) !== null;
                    }
                }
                return this.fileExists(fileName, canonicalDirCache);
            },
            realpath: (targetPath) => {
                if (!targetPath || targetPath.includes('\0')) return targetPath;
                if (process.platform === 'linux') {
                    const resolved = path.resolve(targetPath);
                    const lstat = fs.lstatSync(resolved, { throwIfNoEntry: false });
                    if (lstat && !lstat.isSymbolicLink() && (lstat.isFile() || lstat.isDirectory())) {
                        const allowed = lstat.isDirectory()
                            ? resolveExistingDir(resolved)
                            : resolveAllowedNonSymlinkLeaf(resolved);
                        if (allowed) return allowed;
                    }
                }
                return this.realpath(targetPath, canonicalDirCache);
            },
            stat: (targetPath) => this.stat(targetPath, canonicalDirCache),
            getAccessibleEntries: (directoryName) => this.getAccessibleEntries(directoryName, canonicalDirCache),
        };
    }

    /** True when the candidate resolves inside the repository root (excludes TS built-in libs). */
    isInsideRepoRoot(candidatePath: string): boolean {
        const canonical = this.resolveAllowedPath(candidatePath);
        return canonical !== null && isWithinCanonicalRoot(canonical, this.canonicalRepoRoot);
    }

    isAllowedPath(candidatePath: string): boolean {
        return this.resolveAllowedPath(candidatePath) !== null;
    }

    directoryExists(directoryName: string, canonicalDirCache?: Map<string, string | null>): boolean {
        const allowed = this.resolveAllowedPath(directoryName, canonicalDirCache);
        if (!allowed) return false;
        try {
            return fs.statSync(allowed, { throwIfNoEntry: false })?.isDirectory() === true;
        } catch {
            return false;
        }
    }

    fileExists(fileName: string, canonicalDirCache?: Map<string, string | null>): boolean {
        const allowed = this.resolveAllowedPath(fileName, canonicalDirCache);
        if (!allowed) return false;
        try {
            return fs.statSync(allowed, { throwIfNoEntry: false })?.isFile() === true;
        } catch {
            return false;
        }
    }

    realpath(targetPath: string, canonicalDirCache?: Map<string, string | null>): string {
        const allowed = this.resolveAllowedPath(targetPath, canonicalDirCache);
        return allowed ?? targetPath;
    }

    stat(targetPath: string, canonicalDirCache?: Map<string, string | null>): FileSystemStat | undefined {
        const allowed = this.resolveAllowedPath(targetPath, canonicalDirCache);
        if (!allowed) return undefined;
        try {
            const stat = fs.statSync(allowed, { throwIfNoEntry: false });
            if (!stat || (!stat.isFile() && !stat.isDirectory())) return undefined;
            return { mode: stat.mode, size: stat.size, mtime: stat.mtime };
        } catch {
            return undefined;
        }
    }

    getAccessibleEntries(directoryName: string, canonicalDirCache?: Map<string, string | null>): FileSystemEntries {
        const allowed = this.resolveAllowedPath(directoryName, canonicalDirCache);
        if (!allowed) {
            return { files: [], directories: [], symlinks: undefined };
        }
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(allowed, { withFileTypes: true });
        } catch {
            return { files: [], directories: [], symlinks: undefined };
        }
        const files: string[] = [];
        const directories: string[] = [];
        const symlinks: string[] = [];
        for (const dirent of dirents) {
            const entryPath = path.join(allowed, dirent.name);
            if (dirent.isSymbolicLink()) {
                const resolvedEntry = this.resolveAllowedPath(entryPath, canonicalDirCache);
                if (!resolvedEntry) continue;
                try {
                    const targetStat = fs.statSync(resolvedEntry, { throwIfNoEntry: false });
                    if (!targetStat) continue;
                    if (targetStat.isFile()) {
                        files.push(dirent.name);
                        symlinks.push(dirent.name);
                    } else if (targetStat.isDirectory()) {
                        directories.push(dirent.name);
                        symlinks.push(dirent.name);
                    }
                } catch {
                    // Ignore unreadable symlink targets.
                }
            } else if (dirent.isFile()) {
                files.push(dirent.name);
            } else if (dirent.isDirectory()) {
                directories.push(dirent.name);
            }
        }
        return {
            files,
            directories,
            symlinks: symlinks.length > 0 ? symlinks : undefined,
        };
    }

    createConfigFileSystemCallbacks(
        readFile: (fileName: string) => string | undefined,
    ): FileSystemCallbacks {
        return {
            directoryExists: (directoryName) => this.directoryExists(directoryName),
            fileExists: (fileName) => this.fileExists(fileName),
            getAccessibleEntries: (directoryName) => this.getAccessibleEntries(directoryName),
            realpath: (targetPath) => this.realpath(targetPath),
            stat: (targetPath) => this.stat(targetPath),
            writeFile: serverFS.noop,
            removeFile: serverFS.noop,
            readFile: (fileName) => {
                if (!this.isAllowedPath(fileName)) return undefined;
                return readFile(fileName);
            },
        };
    }
}
