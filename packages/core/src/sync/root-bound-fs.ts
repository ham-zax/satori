import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import {
    finishSourceMeasurementObservation,
    recordSourceIo,
    type SourceMeasurementObservation,
} from '../measurement/source-ledger';

export type RootBoundFileIdentityStrength = 'strong' | 'target_only' | 'unsupported';

export interface RootBoundFileIdentity {
    platform: string;
    stableIdentity: string;
    canonicalRelativePath: string;
    traversalIdentity?: string;
    strength: RootBoundFileIdentityStrength;
}

export type RootBoundFileErrorCode =
    | 'root_binding_invalid'
    | 'path_identity_unavailable'
    | 'source_changed_during_inspection'
    | 'path_identity_changed_during_inspection';

export class RootBoundFileError extends Error {
    constructor(
        readonly code: RootBoundFileErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'RootBoundFileError';
    }
}

const UNSUPPORTED_LINUX_FILE_SYSTEM_TYPES = new Set<bigint>([
    0x6969n, // NFS
    0xff534d42n, // CIFS
    0xfe534d42n, // SMB2
    0x65735546n, // FUSE
    0x01021997n, // 9P
    0x00c36400n, // Ceph
]);

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
        throw new RootBoundFileError(
            'path_identity_unavailable',
            `Descriptor-bound root validation is unavailable: ${name} is unsupported on ${process.platform}`,
        );
    }
    return flag;
}

/**
 * Fail before indexing mutates durable state when the runtime cannot provide
 * the descriptor guarantees required by root-bound source and policy reads.
 */
export function assertDescriptorBoundIndexingSupported(): void {
    requiredOpenFlag('O_NOFOLLOW');
    requiredOpenFlag('O_DIRECTORY');
    if (!fsSync.existsSync('/proc/self/fd')) {
        throw new Error(`Descriptor-bound root validation is unavailable: /proc/self/fd is unsupported on ${process.platform}`);
    }
}

function descriptorLink(handle: fsp.FileHandle): string {
    if (process.platform !== 'linux') {
        throw new RootBoundFileError(
            'path_identity_unavailable',
            `Descriptor-bound root validation is unavailable on ${process.platform}`,
        );
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
        throw new RootBoundFileError(
            'root_binding_invalid',
            'Opened descriptor escapes indexed root.',
        );
    }
    return normalized;
}

interface OpenedInsideRoot {
    handle: fsp.FileHandle;
    realPath: string;
}

function sameFileIdentity(
    left: Pick<fsSync.Stats, 'dev' | 'ino'>,
    right: Pick<fsSync.Stats, 'dev' | 'ino'>,
): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

async function openInsideRoot(
    candidatePath: string,
    rootDir: string,
    kind: 'file' | 'directory',
): Promise<OpenedInsideRoot> {
    let realPath: string;
    try {
        realPath = trimTrailingSeparators(path.normalize(await fsp.realpath(candidatePath)));
    } catch {
        throw new Error(`Path is unreadable: ${candidatePath}`);
    }
    if (!isRealPathInsideRoot(realPath, rootDir)) {
        throw new RootBoundFileError(
            'root_binding_invalid',
            'Resolved path escapes indexed root.',
        );
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

function canonicalRelativePath(realPath: string, rootDir: string): string {
    const relativePath = path.relative(rootDir, realPath);
    if (
        relativePath.length === 0
        || relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)
    ) {
        throw new RootBoundFileError(
            'root_binding_invalid',
            'Opened file does not have a root-confined relative path.',
        );
    }
    return relativePath.replace(/\\/g, '/');
}

function stableFileIdentityDigest(platform: string, device: bigint, inode: bigint): string {
    return crypto.createHash('sha256')
        .update(`${platform}\0${device.toString(10)}\0${inode.toString(10)}`)
        .digest('hex');
}

/**
 * Project one opened descriptor through the platform identity capability. The
 * The canonical adapter deliberately claims only final-target identity: it does
 * not imply that the directory or symlink traversal chain stayed unchanged.
 */
export async function observeRootBoundFileIdentity(
    handle: fsp.FileHandle,
    rootDir: string,
    openedRealPath?: string,
): Promise<RootBoundFileIdentity> {
    const realPath = openedRealPath ?? await descriptorPathInsideRoot(handle, rootDir);
    const relativePath = canonicalRelativePath(realPath, rootDir);
    if (process.platform !== 'linux') {
        return {
            platform: process.platform,
            stableIdentity: 'unsupported',
            canonicalRelativePath: relativePath,
            strength: 'unsupported',
        };
    }

    let fileSystemType: bigint;
    try {
        fileSystemType = (await fsp.statfs(descriptorLink(handle), { bigint: true })).type;
    } catch {
        return {
            platform: process.platform,
            stableIdentity: 'unsupported',
            canonicalRelativePath: relativePath,
            strength: 'unsupported',
        };
    }
    const stat = await handle.stat({ bigint: true });
    if (
        stat.dev < 0n
        || stat.ino <= 0n
        || UNSUPPORTED_LINUX_FILE_SYSTEM_TYPES.has(fileSystemType)
    ) {
        return {
            platform: process.platform,
            stableIdentity: 'unsupported',
            canonicalRelativePath: relativePath,
            strength: 'unsupported',
        };
    }

    return {
        platform: process.platform,
        stableIdentity: stableFileIdentityDigest(process.platform, stat.dev, stat.ino),
        canonicalRelativePath: relativePath,
        strength: 'target_only',
    };
}

export function canPublishRootBoundFileIdentity(identity: RootBoundFileIdentity): boolean {
    return identity.strength === 'strong' || identity.strength === 'target_only';
}

export function sameRootBoundFileIdentity(
    left: RootBoundFileIdentity,
    right: RootBoundFileIdentity,
): boolean {
    return canPublishRootBoundFileIdentity(left)
        && canPublishRootBoundFileIdentity(right)
        && left.platform === right.platform
        && left.stableIdentity === right.stableIdentity
        && left.canonicalRelativePath === right.canonicalRelativePath;
}

export interface OpenedRootBoundRegularFile {
    handle: fsp.FileHandle;
    identity: RootBoundFileIdentity;
    observedStat: fsSync.Stats;
}

export async function openRegularFileWithIdentityInsideRoot(
    filePath: string,
    rootDir: string,
): Promise<OpenedRootBoundRegularFile> {
    const opened = await openInsideRoot(filePath, rootDir, 'file');
    try {
        const identity = await observeRootBoundFileIdentity(
            opened.handle,
            rootDir,
            opened.realPath,
        );
        // Keep this as the final descriptor observation returned to callers;
        // they compare it synchronously at the path-rebinding boundary.
        const observedStat = await opened.handle.stat();
        return {
            handle: opened.handle,
            identity,
            observedStat,
        };
    } catch (error) {
        await opened.handle.close().catch(() => undefined);
        throw error;
    }
}

/**
 * Open a regular file only after binding it to the verified indexed root:
 * 1) realpath must stay under root (rejects intermediate symlink escape),
 * 2) open that verified path with required Linux O_NOFOLLOW semantics,
 * 3) require the opened descriptor's dev/ino to match the pre-open lstat,
 * 4) re-check the opened descriptor's real path stays under root.
 */
export async function openRegularFileInsideRoot(
    filePath: string,
    rootDir: string,
): Promise<fsp.FileHandle> {
    return (await openInsideRoot(filePath, rootDir, 'file')).handle;
}

/**
 * Open a regular file while rejecting a symbolic link in the final pathname
 * component. This is used for policy control files whose contract forbids
 * symlinks even when the target remains inside the repository.
 */
export async function openRegularFileInsideRootNoFollow(
    filePath: string,
    rootDir: string,
): Promise<fsp.FileHandle> {
    const normalizedRoot = trimTrailingSeparators(path.normalize(rootDir));
    const normalizedPath = path.normalize(path.resolve(filePath));
    if (!isRealPathInsideRoot(normalizedPath, normalizedRoot)) {
        throw new Error(`Path escapes indexed root or is unreadable: ${filePath}`);
    }

    const preStat = await fsp.lstat(normalizedPath);
    if (preStat.isSymbolicLink() || !preStat.isFile()) {
        throw new Error(`Attempted to open symbolic-link or non-file path: ${filePath}`);
    }

    const handle = await fsp.open(
        normalizedPath,
        fsSync.constants.O_RDONLY | requiredOpenFlag('O_NOFOLLOW'),
    );
    try {
        const postStat = await handle.stat();
        if (!postStat.isFile() || !sameFileIdentity(preStat, postStat)) {
            throw new Error(`Opened descriptor drifted from verified path: ${filePath}`);
        }
        await descriptorPathInsideRoot(handle, normalizedRoot);
        return handle;
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

/**
 * Verify only the retained descriptor. Callers that need a source-validation
 * linearization point must perform their authority checks next and the fresh
 * path-to-identity rebinding last.
 */
export async function verifyStableFileDescriptorObservation(
    handle: fsp.FileHandle,
    filePath: string,
    before: fsSync.Stats,
): Promise<fsSync.Stats> {
    const after = await handle.stat();
    if (
        !sameFileIdentity(before, after)
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
    ) {
        throw new RootBoundFileError(
            'source_changed_during_inspection',
            `File changed while being read: ${filePath}`,
        );
    }
    return after;
}

/**
 * Verify that an observed descriptor stayed unchanged and that the pathname
 * still names the same file after the read completed.
 */
export async function verifyStableFileObservation(
    handle: fsp.FileHandle,
    filePath: string,
    rootDir: string,
    before: fsSync.Stats,
    options: { rejectFinalSymlink?: boolean } = {},
): Promise<void> {
    const after = await verifyStableFileDescriptorObservation(handle, filePath, before);

    const currentPathHandle = options.rejectFinalSymlink
        ? await openRegularFileInsideRootNoFollow(filePath, rootDir)
        : await openRegularFileInsideRoot(filePath, rootDir);
    try {
        const currentPathStat = await currentPathHandle.stat();
        if (!sameFileIdentity(after, currentPathStat)) {
            throw new RootBoundFileError(
                'path_identity_changed_during_inspection',
                `File path was replaced while being read: ${filePath}`,
            );
        }
    } finally {
        await currentPathHandle.close().catch(() => undefined);
    }
}

/**
 * Read exactly the byte length already observed from an open descriptor.
 * The stream is capped at one byte beyond that length so concurrent growth is
 * detected without allowing an unbounded read-to-EOF allocation.
 */
export async function readFileHandleExactly(
    handle: fsp.FileHandle,
    expectedSize: number,
    measurementObservation?: SourceMeasurementObservation,
    options: { deferSuccessfulObservationOutcome?: boolean } = {},
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
            throw new Error(`Observed file size is invalid: ${expectedSize}`);
        }
        const stream = handle.createReadStream({
            autoClose: false,
            start: 0,
            end: expectedSize,
        });
        for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const startByte = totalBytes;
            totalBytes += buffer.length;
            recordSourceIo({
                observation: measurementObservation,
                startByte,
                endByte: totalBytes,
                basis: 'stream_chunk',
            });
            if (totalBytes > expectedSize) {
                throw new RootBoundFileError(
                    'source_changed_during_inspection',
                    'File grew beyond the observed size while being read.',
                );
            }
            chunks.push(buffer);
        }
        if (totalBytes !== expectedSize) {
            throw new RootBoundFileError(
                'source_changed_during_inspection',
                `File byte length ${totalBytes} does not match the observed size ${expectedSize}.`,
            );
        }
        if (!options.deferSuccessfulObservationOutcome) {
            finishSourceMeasurementObservation({
                observation: measurementObservation,
                status: 'completed',
            });
        }
        return Buffer.concat(chunks, totalBytes);
    } catch (error) {
        finishSourceMeasurementObservation({
            observation: measurementObservation,
            status: totalBytes > 0 ? 'partial' : 'failed',
        });
        throw error;
    }
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
