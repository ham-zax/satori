import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serverFS, type FileSystemCallbacks, type FileSystemEntries, type FileSystemStat } from './typescript-api';

function canonicalizeExistingOrNearest(inputPath: string): string | null {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        const missing: string[] = [];
        let current = resolved;
        for (;;) {
            // If an existing component is a dangling symlink, reject fail-closed.
            const lstat = fs.lstatSync(current, { throwIfNoEntry: false });
            if (lstat?.isSymbolicLink()) {
                return null;
            }
            if (lstat) {
                try {
                    const real = fs.realpathSync.native(current);
                    return missing.length === 0 ? real : path.join(real, ...missing.reverse());
                } catch {
                    return null;
                }
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return resolved;
            }
            missing.push(path.basename(current));
            current = parent;
        }
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

    /** Returns the canonical path when contained within the boundary, or `null` when outside/dangling. */
    resolveAllowedPath(candidatePath: string): string | null {
        if (!candidatePath || candidatePath.includes('\0')) return null;
        const canonical = canonicalizeExistingOrNearest(candidatePath);
        if (!canonical) return null;
        for (const root of this.allowedRoots) {
            if (isWithinCanonicalRoot(canonical, root)) {
                return canonical;
            }
        }
        return null;
    }

    /** True when the candidate resolves inside the repository root (excludes TS built-in libs). */
    isInsideRepoRoot(candidatePath: string): boolean {
        const canonical = this.resolveAllowedPath(candidatePath);
        return canonical !== null && isWithinCanonicalRoot(canonical, this.canonicalRepoRoot);
    }

    isAllowedPath(candidatePath: string): boolean {
        return this.resolveAllowedPath(candidatePath) !== null;
    }

    directoryExists(directoryName: string): boolean {
        const allowed = this.resolveAllowedPath(directoryName);
        if (!allowed) return false;
        try {
            return fs.statSync(allowed, { throwIfNoEntry: false })?.isDirectory() === true;
        } catch {
            return false;
        }
    }

    fileExists(fileName: string): boolean {
        const allowed = this.resolveAllowedPath(fileName);
        if (!allowed) return false;
        try {
            return fs.statSync(allowed, { throwIfNoEntry: false })?.isFile() === true;
        } catch {
            return false;
        }
    }

    realpath(targetPath: string): string {
        const allowed = this.resolveAllowedPath(targetPath);
        return allowed ?? targetPath;
    }

    stat(targetPath: string): FileSystemStat | undefined {
        const allowed = this.resolveAllowedPath(targetPath);
        if (!allowed) return undefined;
        try {
            const stat = fs.statSync(allowed, { throwIfNoEntry: false });
            if (!stat || (!stat.isFile() && !stat.isDirectory())) return undefined;
            return { mode: stat.mode, size: stat.size, mtime: stat.mtime };
        } catch {
            return undefined;
        }
    }

    getAccessibleEntries(directoryName: string): FileSystemEntries {
        const allowed = this.resolveAllowedPath(directoryName);
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
                const resolvedEntry = this.resolveAllowedPath(entryPath);
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
