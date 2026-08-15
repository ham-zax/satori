import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import ignore from 'ignore';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { canonicalizeRepositoryRelativePath } from '../paths/repository-path';
import {
    isObservableFileByPolicy,
    isObservableFileObservationByPolicy,
} from '../config/index-policy';
import {
    openDirectoryInsideRoot,
    openRegularFileInsideRoot,
    resolveInsideRoot,
} from './root-bound-fs';
import type { SnapshotFileStatSignature } from './snapshot-codec';

export type FileStatSignature = SnapshotFileStatSignature;

/**
 * Everything the synchronizer scan needs from its caller. The caller retains
 * checkpoint and freshness state; this context carries only the scan inputs:
 * the canonical root identity, the compiled ignore matcher, the supported
 * extensions, the hash policy, the bounded hash concurrency, and the prior
 * stat/hash evidence the scan may reuse.
 */
export interface SynchronizerScanContext {
    rootDir: string;
    ignoreMatcher: ReturnType<typeof ignore>;
    supportedExtensions: readonly string[];
    forceFullHash: boolean;
    hashConcurrency: number;
    previousHashes: ReadonlyMap<string, string>;
    previousStats: ReadonlyMap<string, FileStatSignature>;
}

/** Immutable scan results. The caller may copy them into its own state. */
export interface SynchronizerScanOutput {
    fileHashes: ReadonlyMap<string, string>;
    fileStats: ReadonlyMap<string, FileStatSignature>;
    unscannedDirPrefixes: readonly string[];
    partialScan: boolean;
    unreadableFiles: ReadonlySet<string>;
    hashedCount: number;
}

export interface ExactPathObservation {
    kind: 'absent' | 'not_indexable' | 'indexed';
    dev?: number;
    ino?: number;
    size?: number;
    mtimeMs?: number;
    ctimeMs?: number;
    hash?: string;
}

interface ScanCandidate {
    relativePath: string;
    absolutePath: string;
    signature: FileStatSignature;
}

type DirectoryEntryObservation =
    | { kind: 'skip' }
    | { kind: 'unreadable'; relativePath: string; directory: boolean; message: string }
    | { kind: 'directory'; relativePath: string; absolutePath: string }
    | { kind: 'file'; relativePath: string; absolutePath: string; signature: FileStatSignature };

interface ScanResult {
    scannedHashes: Map<string, string>;
    scannedStats: Map<string, FileStatSignature>;
    hashCandidates: ScanCandidate[];
    unreadableFiles: Set<string>;
    unscannedDirPrefixes: Set<string>;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return undefined;
}

export function normalizeSynchronizerRelPath(rootDir: string, candidatePath: string): string {
    return canonicalizeRepositoryRelativePath(rootDir, candidatePath) ?? '';
}

function isPathWithinPrefix(candidatePath: string, prefix: string): boolean {
    return candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
}

export function normalizeAndCompressPrefixes(
    rootDir: string,
    prefixes: Set<string>,
): string[] {
    const normalized = Array.from(prefixes)
        .map((prefix) => normalizeSynchronizerRelPath(rootDir, prefix))
        .filter((prefix) => prefix.length > 0)
        .sort();

    const compressed: string[] = [];
    for (const prefix of normalized) {
        const covered = compressed.some((existingPrefix) => isPathWithinPrefix(prefix, existingPrefix));
        if (!covered) {
            compressed.push(prefix);
        }
    }

    return compressed;
}

function shouldIgnore(
    context: SynchronizerScanContext,
    relativePath: string,
    isDirectory: boolean = false,
): boolean {
    const normalizedPath = normalizeSynchronizerRelPath(context.rootDir, relativePath);
    if (!normalizedPath) {
        return false;
    }

    if (isDirectory) {
        const withSlash = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
        return context.ignoreMatcher.ignores(normalizedPath) || context.ignoreMatcher.ignores(withSlash);
    }

    return context.ignoreMatcher.ignores(normalizedPath);
}

async function isSupportedFile(
    context: SynchronizerScanContext,
    relativePath: string,
    absolutePath: string,
    size: number,
): Promise<boolean> {
    return isObservableFileByPolicy(
        relativePath,
        absolutePath,
        size,
        [...context.supportedExtensions]
    );
}

async function hashFileBytes(
    context: SynchronizerScanContext,
    filePath: string,
): Promise<{
    hash: string;
    signature: FileStatSignature;
    indexable: boolean;
    identity: { dev: number; ino: number };
}> {
    const handle = await openRegularFileInsideRoot(filePath, context.rootDir);
    try {
        const before = await handle.stat();
        if (!before.isFile()) {
            throw new Error(`Opened descriptor is not a regular file: ${filePath}`);
        }
        const relativePath = normalizeSynchronizerRelPath(
            context.rootDir,
            path.relative(context.rootDir, filePath),
        );
        if (!relativePath) {
            throw new Error(`Opened descriptor path is outside the synchronizer root: ${filePath}`);
        }
        const indexable = await isObservableFileObservationByPolicy(
            relativePath,
            before.size,
            [...context.supportedExtensions],
            async () => {
                const buffer = Buffer.alloc(Math.min(before.size, 8192));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                return buffer.subarray(0, bytesRead);
            },
        );
        if (!indexable) {
            return {
                hash: '',
                signature: {
                    size: before.size,
                    mtimeMs: Number(before.mtimeMs),
                    ctimeMs: Number(before.ctimeMs),
                },
                indexable: false,
                identity: {
                    dev: Number(before.dev),
                    ino: Number(before.ino),
                },
            };
        }
        const hasher = crypto.createHash('sha256');
        const stream = handle.createReadStream({ autoClose: false });
        for await (const chunk of stream) {
            hasher.update(chunk as Buffer);
        }
        const after = await handle.stat();
        if (
            after.dev !== before.dev
            || after.ino !== before.ino
            || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs
            || after.ctimeMs !== before.ctimeMs
        ) {
            throw new Error(`File changed while being hashed: ${filePath}`);
        }
        const currentPathHandle = await openRegularFileInsideRoot(filePath, context.rootDir);
        try {
            const currentPathStat = await currentPathHandle.stat();
            if (currentPathStat.dev !== after.dev || currentPathStat.ino !== after.ino) {
                throw new Error(`File path was replaced while being hashed: ${filePath}`);
            }
        } finally {
            await currentPathHandle.close().catch(() => undefined);
        }
        return {
            hash: hasher.digest('hex'),
            signature: {
                size: after.size,
                mtimeMs: Number(after.mtimeMs),
                ctimeMs: Number(after.ctimeMs),
            },
            indexable,
            identity: {
                dev: Number(after.dev),
                ino: Number(after.ino),
            },
        };
    } finally {
        await handle.close().catch(() => undefined);
    }
}

/**
 * Run `worker(index)` for every index in `[0, workCount)` with at most
 * `concurrency` workers in flight. Results are returned in index order.
 * This is the bounded worker primitive the scan uses for directory entry
 * inspection and candidate hashing.
 */
export async function runBoundedWorkers<T>(
    concurrency: number,
    workCount: number,
    worker: (index: number) => Promise<T>,
): Promise<T[]> {
    const results = new Array<T | undefined>(workCount);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, workCount) }).map(async () => {
        while (true) {
            const currentIndex = cursor;
            cursor += 1;
            if (currentIndex >= workCount) {
                return;
            }
            results[currentIndex] = await worker(currentIndex);
        }
    });
    await Promise.all(workers);
    return results as T[];
}

function isSignatureEqual(a: FileStatSignature | undefined, b: FileStatSignature): boolean {
    return !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function markUnscannedDir(relativeDir: string, result: ScanResult): void {
    if (relativeDir) {
        result.unscannedDirPrefixes.add(relativeDir);
    }
}

async function inspectDirectoryEntries(
    context: SynchronizerScanContext,
    entries: fsSync.Dirent[],
    descriptorPath: string,
    relativeDirectoryPath: string,
): Promise<DirectoryEntryObservation[]> {
    return runBoundedWorkers(
        context.hashConcurrency,
        entries.length,
        async (currentIndex) => {
            const entry = entries[currentIndex];
            if (entry.isSymbolicLink()) {
                return { kind: 'skip' };
            }

            const absolutePath = path.join(descriptorPath, entry.name);
            const relativePath = normalizeSynchronizerRelPath(
                context.rootDir,
                relativeDirectoryPath ? `${relativeDirectoryPath}/${entry.name}` : entry.name,
            );
            if (!relativePath || shouldIgnore(context, relativePath, entry.isDirectory())) {
                return { kind: 'skip' };
            }

            let stat: fsSync.Stats;
            try {
                stat = await fsp.lstat(absolutePath);
            } catch (error: unknown) {
                return {
                    kind: 'unreadable',
                    relativePath,
                    directory: entry.isDirectory(),
                    message: errorMessage(error),
                };
            }

            if (stat.isSymbolicLink()) {
                return { kind: 'skip' };
            }
            if (stat.isDirectory()) {
                return shouldIgnore(context, relativePath, true)
                    ? { kind: 'skip' }
                    : { kind: 'directory', relativePath, absolutePath };
            }
            if (!stat.isFile() || shouldIgnore(context, relativePath, false)) {
                return { kind: 'skip' };
            }

            const fileReal = await resolveInsideRoot(absolutePath, context.rootDir);
            if (!fileReal || fileReal !== path.join(context.rootDir, relativePath)) {
                return {
                    kind: 'unreadable',
                    relativePath,
                    directory: false,
                    message: 'path no longer resolves to the indexed root entry',
                };
            }
            if (!await isSupportedFile(context, relativePath, fileReal, stat.size)) {
                return { kind: 'skip' };
            }

            return {
                kind: 'file',
                relativePath,
                absolutePath: fileReal,
                signature: {
                    size: stat.size,
                    mtimeMs: Number(stat.mtimeMs),
                    ctimeMs: Number(stat.ctimeMs),
                },
            };
        },
    );
}

async function scanDirectory(
    context: SynchronizerScanContext,
    directoryPath: string,
    relativeDirectoryPath: string,
    result: ScanResult,
): Promise<void> {
    let openedDirectory;
    try {
        openedDirectory = await openDirectoryInsideRoot(directoryPath, context.rootDir);
    } catch (error: unknown) {
        if (!relativeDirectoryPath) {
            throw new Error(`[Synchronizer] Cannot read root directory ${directoryPath}: ${errorMessage(error)}`);
        }
        markUnscannedDir(relativeDirectoryPath, result);
        console.warn(`[Synchronizer] Cannot open directory ${directoryPath}: ${errorMessage(error)}`);
        return;
    }

    try {
        const expectedDirectoryPath = relativeDirectoryPath
            ? path.join(context.rootDir, relativeDirectoryPath)
            : context.rootDir;
        if (openedDirectory.realPath !== expectedDirectoryPath) {
            if (!relativeDirectoryPath) {
                throw new Error(`[Synchronizer] Root directory moved during scan: ${directoryPath}`);
            }
            markUnscannedDir(relativeDirectoryPath, result);
            return;
        }

        let entries: fsSync.Dirent[];
        try {
            entries = await fsp.readdir(openedDirectory.descriptorPath, { withFileTypes: true });
        } catch (error: unknown) {
            if (!relativeDirectoryPath) {
                throw new Error(`[Synchronizer] Cannot read root directory ${directoryPath}: ${errorMessage(error)}`);
            }
            markUnscannedDir(relativeDirectoryPath, result);
            console.warn(`[Synchronizer] Cannot read directory ${directoryPath}: ${errorMessage(error)}`);
            return;
        }

        entries.sort((a, b) => compareContractStrings(a.name, b.name));

        // Filesystem checks within one directory are independent. Resolve them
        // concurrently, then apply observations in canonical entry order so the
        // resulting maps, diagnostics, and recursive traversal remain stable.
        const observations = await inspectDirectoryEntries(
            context,
            entries,
            openedDirectory.descriptorPath,
            relativeDirectoryPath,
        );
        for (const observation of observations) {
            if (observation.kind === 'skip') {
                continue;
            }
            if (observation.kind === 'unreadable') {
                if (observation.directory) {
                    result.unscannedDirPrefixes.add(observation.relativePath);
                } else {
                    result.unreadableFiles.add(observation.relativePath);
                }
                console.warn(`[Synchronizer] Cannot inspect ${observation.relativePath}: ${observation.message}`);
                continue;
            }
            if (observation.kind === 'directory') {
                await scanDirectory(
                    context,
                    observation.absolutePath,
                    observation.relativePath,
                    result,
                );
                continue;
            }

            result.scannedStats.set(observation.relativePath, observation.signature);

            const previousSignature = context.previousStats.get(observation.relativePath);
            const previousHash = context.previousHashes.get(observation.relativePath);
            const canReuseHash = !context.forceFullHash
                && isSignatureEqual(previousSignature, observation.signature)
                && typeof previousHash === 'string';

            if (canReuseHash) {
                result.scannedHashes.set(observation.relativePath, previousHash);
                continue;
            }

            result.hashCandidates.push({
                relativePath: observation.relativePath,
                absolutePath: observation.absolutePath,
                signature: observation.signature,
            });
        }
    } finally {
        await openedDirectory.handle.close().catch(() => undefined);
    }
}

async function hashCandidatesWithConcurrency(
    context: SynchronizerScanContext,
    result: ScanResult,
): Promise<number> {
    if (result.hashCandidates.length === 0) {
        return 0;
    }

    const workerCounts = await runBoundedWorkers<number>(
        context.hashConcurrency,
        result.hashCandidates.length,
        async (currentIndex) => {
            const candidate = result.hashCandidates[currentIndex];
            try {
                const observation = await hashFileBytes(context, candidate.absolutePath);
                if (!observation.indexable) {
                    result.scannedStats.delete(candidate.relativePath);
                    return 0;
                }
                result.scannedHashes.set(candidate.relativePath, observation.hash);
                result.scannedStats.set(candidate.relativePath, observation.signature);
                return 1;
            } catch (error: unknown) {
                result.unreadableFiles.add(candidate.relativePath);
                result.scannedStats.delete(candidate.relativePath);
                console.warn(`[Synchronizer] Cannot hash file ${candidate.absolutePath}: ${errorMessage(error)}`);
                return 0;
            }
        },
    );

    return workerCounts.reduce((total, count) => total + count, 0);
}

function buildEffectiveState(
    context: SynchronizerScanContext,
    result: ScanResult,
): { fileHashes: Map<string, string>; fileStats: Map<string, FileStatSignature>; unscannedDirPrefixes: string[]; partialScan: boolean } {
    const unscannedDirPrefixes = normalizeAndCompressPrefixes(context.rootDir, result.unscannedDirPrefixes);
    const partialScan = unscannedDirPrefixes.length > 0 || result.unreadableFiles.size > 0;

    const effectiveHashes = new Map<string, string>();
    const effectiveStats = new Map<string, FileStatSignature>();

    for (const [relativePath, hash] of result.scannedHashes.entries()) {
        effectiveHashes.set(relativePath, hash);
    }

    for (const [relativePath, signature] of result.scannedStats.entries()) {
        effectiveStats.set(relativePath, signature);
    }

    const shouldPreservePrevious = (relativePath: string): boolean => {
        if (result.unreadableFiles.has(relativePath)) {
            return true;
        }
        return unscannedDirPrefixes.some((prefix) => isPathWithinPrefix(relativePath, prefix));
    };

    for (const [relativePath, previousHash] of context.previousHashes.entries()) {
        if (effectiveHashes.has(relativePath)) {
            continue;
        }

        if (!shouldPreservePrevious(relativePath)) {
            continue;
        }

        if (shouldIgnore(context, relativePath, false)) {
            continue;
        }

        effectiveHashes.set(relativePath, previousHash);
        const previousSignature = context.previousStats.get(relativePath);
        if (previousSignature) {
            effectiveStats.set(relativePath, previousSignature);
        }
    }

    for (const relativePath of Array.from(effectiveHashes.keys())) {
        if (shouldIgnore(context, relativePath, false)) {
            effectiveHashes.delete(relativePath);
            effectiveStats.delete(relativePath);
        }
    }

    return {
        fileHashes: effectiveHashes,
        fileStats: effectiveStats,
        unscannedDirPrefixes,
        partialScan
    };
}

/** Scan the canonical root with the given context and return immutable results. */
export async function scanSynchronizerState(
    context: SynchronizerScanContext,
): Promise<SynchronizerScanOutput> {
    const scanResult: ScanResult = {
        scannedHashes: new Map(),
        scannedStats: new Map(),
        hashCandidates: [],
        unreadableFiles: new Set(),
        unscannedDirPrefixes: new Set()
    };

    await scanDirectory(context, context.rootDir, '', scanResult);
    const hashedCount = await hashCandidatesWithConcurrency(context, scanResult);
    const effective = buildEffectiveState(context, scanResult);

    return {
        fileHashes: effective.fileHashes,
        fileStats: effective.fileStats,
        unscannedDirPrefixes: effective.unscannedDirPrefixes,
        partialScan: effective.partialScan,
        unreadableFiles: scanResult.unreadableFiles,
        hashedCount,
    };
}

/** Observe one explicit repository-relative path without advancing any state. */
export async function observeSynchronizerPath(
    context: SynchronizerScanContext,
    relativePath: string,
): Promise<ExactPathObservation> {
    const absolutePath = path.join(context.rootDir, relativePath);
    let pathStat: fsSync.Stats;
    try {
        pathStat = await fsp.lstat(absolutePath);
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') {
            return { kind: 'absent' };
        }
        throw error;
    }

    if (
        pathStat.isSymbolicLink()
        || !pathStat.isFile()
        || shouldIgnore(context, relativePath, false)
    ) {
        return {
            kind: 'not_indexable',
            dev: Number(pathStat.dev),
            ino: Number(pathStat.ino),
            size: Number(pathStat.size),
            mtimeMs: Number(pathStat.mtimeMs),
            ctimeMs: Number(pathStat.ctimeMs),
        };
    }

    const observation = await hashFileBytes(context, absolutePath);
    return {
        kind: observation.indexable ? 'indexed' : 'not_indexable',
        dev: observation.identity.dev,
        ino: observation.identity.ino,
        size: observation.signature.size,
        mtimeMs: observation.signature.mtimeMs,
        ctimeMs: observation.signature.ctimeMs,
        ...(observation.indexable ? { hash: observation.hash } : {}),
    };
}
