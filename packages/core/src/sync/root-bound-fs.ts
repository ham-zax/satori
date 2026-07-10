import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

/**
 * True when `realPath` (already realpath-resolved) is `rootDir` or a descendant.
 * Uses a separator boundary so `/tmp/foo` does not match `/tmp/foobar`.
 */
export function isRealPathInsideRoot(realPath: string, rootDir: string): boolean {
    const root = trimTrailingSeparators(path.normalize(rootDir));
    const candidate = trimTrailingSeparators(path.normalize(realPath));
    if (process.platform === 'win32') {
        const rootKey = root.toLowerCase();
        const candidateKey = candidate.toLowerCase();
        return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`);
    }
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function trimTrailingSeparators(inputPath: string): string {
    const parsedRoot = path.parse(inputPath).root;
    if (inputPath === parsedRoot) {
        return inputPath;
    }
    return inputPath.replace(/[\\/]+$/, '');
}

/**
 * Resolve `candidatePath` to a real path that stays under `rootDir`.
 * Returns null when missing, unreadable, or escaped (including intermediate symlinks).
 */
export async function resolveInsideRoot(candidatePath: string, rootDir: string): Promise<string | null> {
    let realPath: string;
    try {
        realPath = await fsp.realpath(candidatePath);
    } catch {
        return null;
    }
    realPath = trimTrailingSeparators(path.normalize(realPath));
    if (!isRealPathInsideRoot(realPath, rootDir)) {
        return null;
    }
    return realPath;
}

function requiredOpenFlag(name: 'O_NOFOLLOW' | 'O_DIRECTORY'): number {
    const constants = fsSync.constants;
    const flag = constants[name];
    if (process.platform !== 'linux' || typeof flag !== 'number' || flag === 0) {
        throw new Error(`Descriptor-bound root validation is unavailable: ${name} is unsupported on ${process.platform}`);
    }
    return flag;
}

function descriptorLink(handle: fsp.FileHandle): string {
    if (process.platform !== 'linux') {
        throw new Error(`Descriptor-bound root validation is unavailable on ${process.platform}`);
    }
    return `/proc/self/fd/${handle.fd}`;
}

export async function descriptorPathInsideRoot(handle: fsp.FileHandle, rootDir: string): Promise<string> {
    const link = descriptorLink(handle);
    let openedPath: string;
    try {
        openedPath = await fsp.readlink(link);
    } catch (error: unknown) {
        throw new Error(`Cannot verify opened descriptor against indexed root: ${String(error)}`);
    }

    if (!path.isAbsolute(openedPath) || openedPath.endsWith(' (deleted)')) {
        throw new Error(`Opened descriptor has no stable absolute path: ${openedPath}`);
    }

    const normalized = trimTrailingSeparators(path.normalize(openedPath));
    if (!isRealPathInsideRoot(normalized, rootDir)) {
        throw new Error(`Opened descriptor escapes indexed root: ${openedPath}`);
    }
    return normalized;
}

interface OpenedInsideRoot {
    handle: fsp.FileHandle;
    realPath: string;
}

async function openInsideRoot(
    candidatePath: string,
    rootDir: string,
    kind: 'file' | 'directory',
): Promise<OpenedInsideRoot> {
    const realPath = await resolveInsideRoot(candidatePath, rootDir);
    if (!realPath) {
        throw new Error(`Path escapes indexed root or is unreadable: ${candidatePath}`);
    }

    const preStat = await fsp.lstat(realPath);
    const expectedKind = kind === 'file' ? preStat.isFile() : preStat.isDirectory();
    if (preStat.isSymbolicLink() || !expectedKind) {
        throw new Error(`Attempted to open non-${kind} path: ${candidatePath}`);
    }

    let flags = fsSync.constants.O_RDONLY | requiredOpenFlag('O_NOFOLLOW');
    if (kind === 'directory') {
        flags |= requiredOpenFlag('O_DIRECTORY');
    }

    const handle = await fsp.open(realPath, flags);
    try {
        const postStat = await handle.stat();
        const openedKind = kind === 'file' ? postStat.isFile() : postStat.isDirectory();
        if (!openedKind || postStat.dev !== preStat.dev || postStat.ino !== preStat.ino) {
            throw new Error(`Opened descriptor drifted from verified path: ${candidatePath}`);
        }

        const openedRealPath = await descriptorPathInsideRoot(handle, rootDir);
        return { handle, realPath: openedRealPath };
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

/**
 * Open a regular file only after binding it to the verified indexed root:
 * 1) realpath must stay under root (rejects intermediate symlink escape),
 * 2) open that verified path (O_NOFOLLOW when available),
 * 3) require the opened descriptor's dev/ino to match the pre-open lstat,
 * 4) re-check the opened descriptor's real path stays under root.
 */
export async function openRegularFileInsideRoot(
    filePath: string,
    rootDir: string,
): Promise<fsp.FileHandle> {
    return (await openInsideRoot(filePath, rootDir, 'file')).handle;
}

export interface OpenedDirectoryInsideRoot {
    handle: fsp.FileHandle;
    descriptorPath: string;
    realPath: string;
}

export async function openDirectoryInsideRoot(
    directoryPath: string,
    rootDir: string,
): Promise<OpenedDirectoryInsideRoot> {
    const opened = await openInsideRoot(directoryPath, rootDir, 'directory');
    return {
        ...opened,
        descriptorPath: descriptorLink(opened.handle),
    };
}
