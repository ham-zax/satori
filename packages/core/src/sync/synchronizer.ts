import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import ignore from 'ignore';
import { computeMerkleRoot } from './merkle';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { DEFAULT_SUPPORTED_EXTENSIONS } from '../config/defaults';
import {
    isIndexableFileByPolicy,
    isIndexableFileObservationByPolicy,
    normalizeSupportedExtensions,
} from '../config/index-policy';
import {
    openDirectoryInsideRoot,
    openRegularFileInsideRoot,
    resolveInsideRoot,
} from './root-bound-fs';

interface FileStatSignature {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

interface SnapshotV2 {
    snapshotVersion: number;
    fileHashes: [string, string][];
    fileStats: [string, FileStatSignature][];
    merkleRoot: string;
    partialScan: boolean;
    unscannedDirPrefixes: string[];
    fullHashCounter: number;
}

interface ScanCandidate {
    relativePath: string;
    absolutePath: string;
    signature: FileStatSignature;
}

interface ScanResult {
    scannedHashes: Map<string, string>;
    scannedStats: Map<string, FileStatSignature>;
    hashCandidates: ScanCandidate[];
    unreadableFiles: Set<string>;
    unscannedDirPrefixes: Set<string>;
}

interface EffectiveState {
    fileHashes: Map<string, string>;
    fileStats: Map<string, FileStatSignature>;
    unscannedDirPrefixes: string[];
    partialScan: boolean;
}

interface SynchronizerCheckpointState extends EffectiveState {
    merkleRoot: string;
    fullHashCounter: number;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return undefined;
}

export interface FileChangeResult {
    added: string[];
    removed: string[];
    modified: string[];
    hashedCount: number;
    partialScan: boolean;
    unscannedDirPrefixes: string[];
    fullHashRun: boolean;
}

export interface PreparedFileChangeSet {
    readonly changes: FileChangeResult;
    readonly fileHashes: ReadonlyMap<string, string>;
    commit(
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void>;
}

const SNAPSHOT_VERSION = 2;
const DEFAULT_HASH_CONCURRENCY = 16;

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private fileStats: Map<string, FileStatSignature>;
    private merkleRoot: string;
    private rootDir: string;
    private snapshotPath: string;
    private ignorePatterns: string[];
    private ignoreMatcher: ReturnType<typeof ignore>;
    private partialScan: boolean;
    private unscannedDirPrefixes: string[];
    private fullHashCounter: number;
    private supportedExtensions: Set<string>;
    private checkpointVersion: number;
    private commitQueue: Promise<void>;

    constructor(
        rootDir: string,
        ignorePatterns: string[] = [],
        supportedExtensions: string[] = DEFAULT_SUPPORTED_EXTENSIONS
    ) {
        this.rootDir = FileSynchronizer.canonicalizeSnapshotIdentityPath(rootDir);
        this.snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(this.rootDir);
        this.fileHashes = new Map();
        this.fileStats = new Map();
        this.merkleRoot = '';
        this.ignorePatterns = ignorePatterns;
        this.ignoreMatcher = ignore();
        this.ignoreMatcher.add(this.ignorePatterns);
        this.supportedExtensions = new Set(normalizeSupportedExtensions(
            supportedExtensions.length > 0 ? supportedExtensions : DEFAULT_SUPPORTED_EXTENSIONS
        ));
        this.partialScan = false;
        this.unscannedDirPrefixes = [];
        this.fullHashCounter = 0;
        this.checkpointVersion = 0;
        this.commitQueue = Promise.resolve();
    }

    public static canonicalizeSnapshotIdentityPath(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        try {
            const realPath = typeof fsSync.realpathSync.native === 'function'
                ? fsSync.realpathSync.native(resolved)
                : fsSync.realpathSync(resolved);
            return FileSynchronizer.trimTrailingSeparators(path.normalize(realPath));
        } catch {
            return FileSynchronizer.trimTrailingSeparators(path.normalize(resolved));
        }
    }

    public static snapshotPathFromCanonicalPath(canonicalPath: string): string {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.satori', 'merkle');
        const hash = crypto.createHash('md5').update(canonicalPath).digest('hex');
        return path.join(merkleDir, `${hash}.json`);
    }

    public static getSnapshotPathForCodebase(codebasePath: string): string {
        const canonicalPath = FileSynchronizer.canonicalizeSnapshotIdentityPath(codebasePath);
        return FileSynchronizer.snapshotPathFromCanonicalPath(canonicalPath);
    }

    private static trimTrailingSeparators(inputPath: string): string {
        const parsedRoot = path.parse(inputPath).root;
        if (inputPath === parsedRoot) {
            return inputPath;
        }
        return inputPath.replace(/[\\/]+$/, '');
    }

    private normalizeRelPath(candidatePath: string): string {
        if (typeof candidatePath !== 'string') {
            return '';
        }

        const trimmed = candidatePath.trim();
        if (!trimmed) {
            return '';
        }

        let normalized = trimmed.replace(/\\/g, '/');
        normalized = normalized.replace(/\/+/g, '/');
        normalized = normalized.replace(/^(\.\/)+/, '');
        normalized = normalized.replace(/^\/+/, '');
        normalized = normalized.replace(/\/+$/, '');

        if (!normalized || normalized === '.') {
            return '';
        }

        const parts = normalized.split('/');
        const cleanParts: string[] = [];
        for (const part of parts) {
            if (!part || part === '.') {
                continue;
            }
            if (part === '..') {
                return '';
            }
            cleanParts.push(part);
        }

        if (cleanParts.length === 0) {
            return '';
        }

        return cleanParts.join('/');
    }

    private isPathWithinPrefix(candidatePath: string, prefix: string): boolean {
        return candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
    }

    private normalizeAndCompressPrefixes(prefixes: Set<string>): string[] {
        const normalized = Array.from(prefixes)
            .map((prefix) => this.normalizeRelPath(prefix))
            .filter((prefix) => prefix.length > 0)
            .sort();

        const compressed: string[] = [];
        for (const prefix of normalized) {
            const covered = compressed.some((existingPrefix) => this.isPathWithinPrefix(prefix, existingPrefix));
            if (!covered) {
                compressed.push(prefix);
            }
        }

        return compressed;
    }

    private shouldIgnore(relativePath: string, isDirectory: boolean = false): boolean {
        const normalizedPath = this.normalizeRelPath(relativePath);
        if (!normalizedPath) {
            return false;
        }

        if (this.ignorePatterns.length === 0) {
            return false;
        }

        if (isDirectory) {
            const withSlash = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
            return this.ignoreMatcher.ignores(normalizedPath) || this.ignoreMatcher.ignores(withSlash);
        }

        return this.ignoreMatcher.ignores(normalizedPath);
    }

    private async isSupportedFile(relativePath: string, absolutePath: string, size: number): Promise<boolean> {
        return isIndexableFileByPolicy(
            relativePath,
            absolutePath,
            size,
            [...this.supportedExtensions]
        );
    }

    private parsePositiveInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
        if (!rawValue || rawValue.trim().length === 0) {
            return fallback;
        }

        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
            return fallback;
        }

        if (parsed < min) {
            return min;
        }

        if (parsed > max) {
            return max;
        }

        return parsed;
    }

    private getHashConcurrency(): number {
        return this.parsePositiveInt(process.env.SATORI_SYNC_HASH_CONCURRENCY, DEFAULT_HASH_CONCURRENCY, 1, 64);
    }

    private getFullHashInterval(): number {
        return this.parsePositiveInt(process.env.SATORI_SYNC_FULL_HASH_EVERY_N, 0, 0, 1000000);
    }

    private async hashFileBytes(filePath: string): Promise<{
        hash: string;
        signature: FileStatSignature;
        indexable: boolean;
    }> {
        const handle = await openRegularFileInsideRoot(filePath, this.rootDir);
        try {
            const before = await handle.stat();
            if (!before.isFile()) {
                throw new Error(`Opened descriptor is not a regular file: ${filePath}`);
            }
            const relativePath = this.normalizeRelPath(path.relative(this.rootDir, filePath));
            if (!relativePath) {
                throw new Error(`Opened descriptor path is outside the synchronizer root: ${filePath}`);
            }
            const indexable = await isIndexableFileObservationByPolicy(
                relativePath,
                before.size,
                [...this.supportedExtensions],
                async () => {
                    const buffer = Buffer.alloc(Math.min(before.size, 8192));
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                    return buffer.subarray(0, bytesRead);
                },
            );
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
            return {
                hash: hasher.digest('hex'),
                signature: {
                    size: after.size,
                    mtimeMs: Number(after.mtimeMs),
                    ctimeMs: Number(after.ctimeMs),
                },
                indexable,
            };
        } finally {
            await handle.close().catch(() => undefined);
        }
    }

    private isSignatureEqual(a: FileStatSignature | undefined, b: FileStatSignature): boolean {
        return !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    }

    private markUnscannedDir(relativeDir: string, result: ScanResult): void {
        if (relativeDir) {
            result.unscannedDirPrefixes.add(relativeDir);
        }
    }

    private async scanDirectory(
        directoryPath: string,
        relativeDirectoryPath: string,
        previousHashes: Map<string, string>,
        previousStats: Map<string, FileStatSignature>,
        forceFullHash: boolean,
        result: ScanResult
    ): Promise<void> {
        let openedDirectory;
        try {
            openedDirectory = await openDirectoryInsideRoot(directoryPath, this.rootDir);
        } catch (error: unknown) {
            if (!relativeDirectoryPath) {
                throw new Error(`[Synchronizer] Cannot read root directory ${directoryPath}: ${errorMessage(error)}`);
            }
            this.markUnscannedDir(relativeDirectoryPath, result);
            console.warn(`[Synchronizer] Cannot open directory ${directoryPath}: ${errorMessage(error)}`);
            return;
        }

        try {
            const expectedDirectoryPath = relativeDirectoryPath
                ? path.join(this.rootDir, relativeDirectoryPath)
                : this.rootDir;
            if (openedDirectory.realPath !== expectedDirectoryPath) {
                if (!relativeDirectoryPath) {
                    throw new Error(`[Synchronizer] Root directory moved during scan: ${directoryPath}`);
                }
                this.markUnscannedDir(relativeDirectoryPath, result);
                return;
            }

            let entries: fsSync.Dirent[];
            try {
                entries = await fsp.readdir(openedDirectory.descriptorPath, { withFileTypes: true });
            } catch (error: unknown) {
                if (!relativeDirectoryPath) {
                    throw new Error(`[Synchronizer] Cannot read root directory ${directoryPath}: ${errorMessage(error)}`);
                }
                this.markUnscannedDir(relativeDirectoryPath, result);
                console.warn(`[Synchronizer] Cannot read directory ${directoryPath}: ${errorMessage(error)}`);
                return;
            }

            entries.sort((a, b) => compareContractStrings(a.name, b.name));

            for (const entry of entries) {
                // Dirent symlink bit is best-effort; lstat below is authoritative.
                if (entry.isSymbolicLink()) {
                    continue;
                }

                const absolutePath = path.join(openedDirectory.descriptorPath, entry.name);
                const relativePath = this.normalizeRelPath(
                    relativeDirectoryPath ? `${relativeDirectoryPath}/${entry.name}` : entry.name
                );
                if (!relativePath) {
                    continue;
                }

                if (this.shouldIgnore(relativePath, entry.isDirectory())) {
                    continue;
                }

                let stat: fsSync.Stats;
                try {
                    stat = await fsp.lstat(absolutePath);
                } catch (error: unknown) {
                    if (entry.isDirectory()) {
                        result.unscannedDirPrefixes.add(relativePath);
                    } else {
                        result.unreadableFiles.add(relativePath);
                    }
                    console.warn(`[Synchronizer] Cannot lstat ${relativePath}: ${errorMessage(error)}`);
                    continue;
                }

                if (stat.isSymbolicLink()) {
                    continue;
                }

                if (stat.isDirectory()) {
                    if (!this.shouldIgnore(relativePath, true)) {
                        await this.scanDirectory(
                            absolutePath,
                            relativePath,
                            previousHashes,
                            previousStats,
                            forceFullHash,
                            result
                        );
                    }
                    continue;
                }

                if (!stat.isFile()) {
                    continue;
                }

                if (this.shouldIgnore(relativePath, false)) {
                    continue;
                }

                const fileReal = await resolveInsideRoot(absolutePath, this.rootDir);
                if (!fileReal || fileReal !== path.join(this.rootDir, relativePath)) {
                    result.unreadableFiles.add(relativePath);
                    continue;
                }

                if (!await this.isSupportedFile(relativePath, fileReal, stat.size)) {
                    continue;
                }

                const signature: FileStatSignature = {
                    size: stat.size,
                    mtimeMs: Number(stat.mtimeMs),
                    ctimeMs: Number(stat.ctimeMs)
                };

                result.scannedStats.set(relativePath, signature);

                const previousSignature = previousStats.get(relativePath);
                const previousHash = previousHashes.get(relativePath);
                const canReuseHash = !forceFullHash
                    && this.isSignatureEqual(previousSignature, signature)
                    && typeof previousHash === 'string';

                if (canReuseHash) {
                    result.scannedHashes.set(relativePath, previousHash!);
                    continue;
                }

                result.hashCandidates.push({ relativePath, absolutePath: fileReal, signature });
            }
        } finally {
            await openedDirectory.handle.close().catch(() => undefined);
        }
    }

    private async hashCandidatesWithConcurrency(result: ScanResult): Promise<number> {
        if (result.hashCandidates.length === 0) {
            return 0;
        }

        const concurrency = this.getHashConcurrency();
        let cursor = 0;
        let hashedCount = 0;

        const workers = Array.from({ length: Math.min(concurrency, result.hashCandidates.length) }).map(async () => {
            while (true) {
                const currentIndex = cursor;
                cursor += 1;

                if (currentIndex >= result.hashCandidates.length) {
                    return;
                }

                const candidate = result.hashCandidates[currentIndex];
                try {
                    const observation = await this.hashFileBytes(candidate.absolutePath);
                    if (!observation.indexable) {
                        result.scannedStats.delete(candidate.relativePath);
                        continue;
                    }
                    result.scannedHashes.set(candidate.relativePath, observation.hash);
                    result.scannedStats.set(candidate.relativePath, observation.signature);
                    hashedCount += 1;
                } catch (error: unknown) {
                    result.unreadableFiles.add(candidate.relativePath);
                    result.scannedStats.delete(candidate.relativePath);
                    console.warn(`[Synchronizer] Cannot hash file ${candidate.absolutePath}: ${errorMessage(error)}`);
                }
            }
        });

        await Promise.all(workers);
        return hashedCount;
    }

    private buildEffectiveState(
        previousHashes: Map<string, string>,
        previousStats: Map<string, FileStatSignature>,
        result: ScanResult
    ): EffectiveState {
        const unscannedDirPrefixes = this.normalizeAndCompressPrefixes(result.unscannedDirPrefixes);
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
            return unscannedDirPrefixes.some((prefix) => this.isPathWithinPrefix(relativePath, prefix));
        };

        for (const [relativePath, previousHash] of previousHashes.entries()) {
            if (effectiveHashes.has(relativePath)) {
                continue;
            }

            if (!shouldPreservePrevious(relativePath)) {
                continue;
            }

            if (this.shouldIgnore(relativePath, false)) {
                continue;
            }

            effectiveHashes.set(relativePath, previousHash);
            const previousSignature = previousStats.get(relativePath);
            if (previousSignature) {
                effectiveStats.set(relativePath, previousSignature);
            }
        }

        for (const relativePath of Array.from(effectiveHashes.keys())) {
            if (this.shouldIgnore(relativePath, false)) {
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

    private compareStates(oldHashes: Map<string, string>, newHashes: Map<string, string>): { added: string[]; removed: string[]; modified: string[] } {
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];

        for (const [filePath, hash] of newHashes.entries()) {
            const previousHash = oldHashes.get(filePath);
            if (typeof previousHash === 'undefined') {
                added.push(filePath);
                continue;
            }

            if (previousHash !== hash) {
                modified.push(filePath);
            }
        }

        for (const filePath of oldHashes.keys()) {
            if (!newHashes.has(filePath)) {
                removed.push(filePath);
            }
        }

        added.sort();
        removed.sort();
        modified.sort();

        return { added, removed, modified };
    }

    private arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i += 1) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    private async saveSnapshot(
        state?: SynchronizerCheckpointState,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        afterPublish?: () => void,
    ): Promise<void> {
        const merkleDir = path.dirname(this.snapshotPath);
        assertMutationCurrent?.();
        if (assertMutationCurrent && !publishMutation) {
            throw new Error('[Synchronizer] A mutation-fenced snapshot write requires an atomic publication callback.');
        }
        await fsp.mkdir(merkleDir, { recursive: true });

        const checkpoint = state ?? {
            fileHashes: this.fileHashes,
            fileStats: this.fileStats,
            partialScan: this.partialScan,
            unscannedDirPrefixes: this.unscannedDirPrefixes,
            merkleRoot: this.merkleRoot,
            fullHashCounter: this.fullHashCounter,
        };
        const fileHashes = Array.from(checkpoint.fileHashes.entries()).sort(([a], [b]) => compareContractStrings(a, b));
        const fileStats = Array.from(checkpoint.fileStats.entries()).sort(([a], [b]) => compareContractStrings(a, b));

        const payload: SnapshotV2 = {
            snapshotVersion: SNAPSHOT_VERSION,
            fileHashes,
            fileStats,
            merkleRoot: checkpoint.merkleRoot,
            partialScan: checkpoint.partialScan,
            unscannedDirPrefixes: [...checkpoint.unscannedDirPrefixes],
            fullHashCounter: checkpoint.fullHashCounter
        };

        const tempSnapshotPath = `${this.snapshotPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
            await fsp.writeFile(tempSnapshotPath, JSON.stringify(payload), 'utf-8');
            if (publishMutation) {
                publishMutation(() => {
                    fsSync.renameSync(tempSnapshotPath, this.snapshotPath);
                    afterPublish?.();
                });
            } else {
                await fsp.rename(tempSnapshotPath, this.snapshotPath);
                afterPublish?.();
            }
        } finally {
            await fsp.unlink(tempSnapshotPath).catch(() => undefined);
        }
        console.log(`Saved snapshot to ${this.snapshotPath}`);
    }

    private assertValidCurrentSnapshot(snapshot: Partial<SnapshotV2>): void {
        const invalid = (reason: string): never => {
            throw new Error(`[Synchronizer] Invalid current-format snapshot: ${reason}`);
        };
        const rawFileHashes = snapshot.fileHashes;
        const rawFileStats = snapshot.fileStats;
        if (!Array.isArray(rawFileHashes) || !Array.isArray(rawFileStats)) {
            invalid('fileHashes and fileStats must be arrays.');
        }

        const hashes = new Map<string, string>();
        for (const entry of rawFileHashes ?? []) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
                invalid('fileHashes contains a malformed entry.');
            }
            const normalizedPath = this.normalizeRelPath(entry[0]);
            if (!normalizedPath || normalizedPath !== entry[0] || hashes.has(normalizedPath)) {
                invalid(`fileHashes contains an invalid or duplicate path '${entry[0]}'.`);
            }
            if (!/^[a-f0-9]{64}$/.test(entry[1])) {
                invalid(`fileHashes contains an invalid SHA-256 for '${normalizedPath}'.`);
            }
            hashes.set(normalizedPath, entry[1]);
        }

        const statPaths = new Set<string>();
        for (const entry of rawFileStats ?? []) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
                invalid('fileStats contains a malformed entry.');
            }
            const normalizedPath = this.normalizeRelPath(entry[0]);
            const signature = entry[1] as Partial<FileStatSignature> | undefined;
            if (!normalizedPath || normalizedPath !== entry[0] || statPaths.has(normalizedPath)) {
                invalid(`fileStats contains an invalid or duplicate path '${entry[0]}'.`);
            }
            if (!signature) {
                throw new Error(`[Synchronizer] Invalid current-format snapshot: fileStats is missing a signature for '${normalizedPath}'.`);
            }
            if (!Number.isSafeInteger(signature.size) || Number(signature.size) < 0) {
                invalid(`fileStats contains an invalid size for '${normalizedPath}'.`);
            }
            if (!Number.isFinite(signature.mtimeMs) || Number(signature.mtimeMs) < 0
                || !Number.isFinite(signature.ctimeMs) || Number(signature.ctimeMs) < 0) {
                invalid(`fileStats contains invalid timestamps for '${normalizedPath}'.`);
            }
            statPaths.add(normalizedPath);
        }
        if (hashes.size !== statPaths.size || [...hashes.keys()].some((filePath) => !statPaths.has(filePath))) {
            invalid('fileHashes and fileStats must contain identical path sets.');
        }

        if (typeof snapshot.merkleRoot !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.merkleRoot)) {
            invalid('merkleRoot must be a SHA-256 digest.');
        }
        if (snapshot.merkleRoot !== computeMerkleRoot(hashes)) {
            invalid('merkleRoot does not match fileHashes.');
        }
        const unscannedDirPrefixes = snapshot.unscannedDirPrefixes;
        if (typeof snapshot.partialScan !== 'boolean' || !Array.isArray(unscannedDirPrefixes)) {
            invalid('partial scan metadata is malformed.');
        }
        for (const prefix of unscannedDirPrefixes ?? []) {
            if (typeof prefix !== 'string' || !prefix || this.normalizeRelPath(prefix) !== prefix) {
                invalid('unscannedDirPrefixes contains an invalid path.');
            }
        }
        if (!Number.isSafeInteger(snapshot.fullHashCounter) || Number(snapshot.fullHashCounter) < 0) {
            invalid('fullHashCounter must be a nonnegative safe integer.');
        }
    }

    private async loadSnapshot(): Promise<{ migrated: boolean }> {
        try {
            const data = await fsp.readFile(this.snapshotPath, 'utf-8');
            const obj = JSON.parse(data) as Partial<SnapshotV2>;
            if (obj.snapshotVersion === SNAPSHOT_VERSION) {
                this.assertValidCurrentSnapshot(obj);
            }

            const rawFileHashes = Array.isArray(obj.fileHashes) ? obj.fileHashes : [];
            this.fileHashes = new Map<string, string>();
            for (const entry of rawFileHashes) {
                if (!Array.isArray(entry) || entry.length !== 2) {
                    continue;
                }
                const normalizedPath = this.normalizeRelPath(String(entry[0] ?? ''));
                const hash = String(entry[1] ?? '');
                if (!normalizedPath || !hash) {
                    continue;
                }
                this.fileHashes.set(normalizedPath, hash);
            }

            const rawFileStats = Array.isArray(obj.fileStats) ? obj.fileStats : [];
            this.fileStats = new Map<string, FileStatSignature>();
            for (const entry of rawFileStats) {
                if (!Array.isArray(entry) || entry.length !== 2) {
                    continue;
                }
                const normalizedPath = this.normalizeRelPath(String(entry[0] ?? ''));
                const rawSignature = entry[1] as Partial<FileStatSignature> | undefined;
                if (!normalizedPath || !rawSignature) {
                    continue;
                }
                const size = Number(rawSignature.size);
                const mtimeMs = Number(rawSignature.mtimeMs);
                const ctimeMs = Number(rawSignature.ctimeMs ?? rawSignature.mtimeMs);
                if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || !Number.isFinite(ctimeMs)) {
                    continue;
                }
                this.fileStats.set(normalizedPath, {
                    size,
                    mtimeMs,
                    ctimeMs
                });
            }

            this.merkleRoot = typeof obj.merkleRoot === 'string' ? obj.merkleRoot : '';
            this.partialScan = Boolean(obj.partialScan);
            this.unscannedDirPrefixes = this.normalizeAndCompressPrefixes(new Set(Array.isArray(obj.unscannedDirPrefixes) ? obj.unscannedDirPrefixes : []));
            this.fullHashCounter = Number.isFinite(Number(obj.fullHashCounter)) ? Number(obj.fullHashCounter) : 0;

            const isV2 = obj.snapshotVersion === SNAPSHOT_VERSION;
            const hasCompatibleStats = this.fileStats.size > 0 || this.fileHashes.size === 0;
            const migrated = !isV2 || !hasCompatibleStats;

            if (migrated) {
                console.log(`Loaded legacy snapshot from ${this.snapshotPath}. Migration to v${SNAPSHOT_VERSION} required.`);
            } else {
                console.log(`Loaded snapshot from ${this.snapshotPath}`);
            }

            return { migrated };
        } catch (error: unknown) {
            if (errorCode(error) === 'ENOENT') {
                console.log(`Snapshot file not found at ${this.snapshotPath}. Creating baseline snapshot.`);
                this.fileHashes = new Map();
                this.fileStats = new Map();
                this.merkleRoot = '';
                this.partialScan = false;
                this.unscannedDirPrefixes = [];
                this.fullHashCounter = 0;
                return { migrated: true };
            }
            throw error;
        }
    }

    private async scanCurrentState(
        previousHashes: Map<string, string>,
        previousStats: Map<string, FileStatSignature>,
        forceFullHash: boolean
    ): Promise<{ effective: EffectiveState; hashedCount: number }> {
        const scanResult: ScanResult = {
            scannedHashes: new Map(),
            scannedStats: new Map(),
            hashCandidates: [],
            unreadableFiles: new Set(),
            unscannedDirPrefixes: new Set()
        };

        await this.scanDirectory(this.rootDir, '', previousHashes, previousStats, forceFullHash, scanResult);
        const hashedCount = await this.hashCandidatesWithConcurrency(scanResult);
        const effective = this.buildEffectiveState(previousHashes, previousStats, scanResult);

        return { effective, hashedCount };
    }

    private applyCheckpointState(state: SynchronizerCheckpointState): void {
        this.fileHashes = state.fileHashes;
        this.fileStats = state.fileStats;
        this.partialScan = state.partialScan;
        this.unscannedDirPrefixes = state.unscannedDirPrefixes;
        this.merkleRoot = state.merkleRoot;
        this.fullHashCounter = state.fullHashCounter;
    }

    private commitPreparedState(
        baseVersion: number,
        nextState: SynchronizerCheckpointState,
        shouldPersist: boolean,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const commit = this.commitQueue.then(async () => {
            if (this.checkpointVersion !== baseVersion) {
                throw new Error('[Synchronizer] Cannot commit stale prepared changes. Prepare the filesystem delta again.');
            }
            const applyCheckpoint = () => {
                this.applyCheckpointState(nextState);
                this.checkpointVersion += 1;
            };
            if (shouldPersist) {
                await this.saveSnapshot(
                    nextState,
                    assertMutationCurrent,
                    publishMutation,
                    applyCheckpoint,
                );
                return;
            }
            if (publishMutation) {
                publishMutation(applyCheckpoint);
            } else {
                assertMutationCurrent?.();
                applyCheckpoint();
            }
        });
        this.commitQueue = commit.catch(() => undefined);
        return commit;
    }

    public async initialize(
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        console.log(`Initializing file synchronizer for ${this.rootDir}`);
        const { migrated } = await this.loadSnapshot();

        if (migrated) {
            const previousHashes = new Map(this.fileHashes);
            const previousStats = new Map(this.fileStats);
            const { effective } = await this.scanCurrentState(previousHashes, previousStats, true);
            this.fileHashes = effective.fileHashes;
            this.fileStats = effective.fileStats;
            this.partialScan = effective.partialScan;
            this.unscannedDirPrefixes = effective.unscannedDirPrefixes;
            this.merkleRoot = computeMerkleRoot(this.fileHashes);
            await this.saveSnapshot(undefined, assertMutationCurrent, publishMutation);
        } else if (!this.merkleRoot) {
            this.merkleRoot = computeMerkleRoot(this.fileHashes);
        }

        this.checkpointVersion += 1;

        console.log(`[Synchronizer] File synchronizer initialized. Loaded ${this.fileHashes.size} tracked files.`);
    }

    public async prepareChanges(): Promise<PreparedFileChangeSet> {
        console.log('[Synchronizer] Checking for file changes...');

        const baseVersion = this.checkpointVersion;
        const previousHashes = new Map(this.fileHashes);
        const previousStats = new Map(this.fileStats);
        const previousPartialScan = this.partialScan;
        const previousUnscannedDirPrefixes = [...this.unscannedDirPrefixes];
        const previousCounter = this.fullHashCounter;

        const fullHashInterval = this.getFullHashInterval();
        const nextCounter = fullHashInterval > 0 ? this.fullHashCounter + 1 : this.fullHashCounter;
        const fullHashRun = fullHashInterval > 0 && nextCounter % fullHashInterval === 0;

        const { effective, hashedCount } = await this.scanCurrentState(previousHashes, previousStats, fullHashRun);
        const nextMerkleRoot = computeMerkleRoot(effective.fileHashes);

        const fileChanges = this.compareStates(previousHashes, effective.fileHashes);

        const hasDiffs = fileChanges.added.length > 0 || fileChanges.removed.length > 0 || fileChanges.modified.length > 0;
        const metadataChanged = previousPartialScan !== effective.partialScan
            || !this.arraysEqual(previousUnscannedDirPrefixes, effective.unscannedDirPrefixes);
        const counterAdvanced = previousCounter !== nextCounter;

        if (hasDiffs) {
            console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified.`);
        } else {
            console.log('[Synchronizer] No file content changes detected.');
        }

        const changes: FileChangeResult = {
            ...fileChanges,
            hashedCount,
            partialScan: effective.partialScan,
            unscannedDirPrefixes: [...effective.unscannedDirPrefixes],
            fullHashRun
        };

        const nextState: SynchronizerCheckpointState = {
            ...effective,
            merkleRoot: nextMerkleRoot,
            fullHashCounter: nextCounter,
        };
        const shouldPersist = hasDiffs || hashedCount > 0 || metadataChanged || counterAdvanced;
        let commit: Promise<void> | undefined;

        return {
            changes,
            fileHashes: new Map(nextState.fileHashes),
            commit: (
                assertMutationCurrent?: () => void,
                publishMutation?: (publish: () => void) => void,
            ) => {
                commit ??= this.commitPreparedState(
                    baseVersion,
                    nextState,
                    shouldPersist,
                    assertMutationCurrent,
                    publishMutation,
                );
                return commit;
            },
        };
    }

    public async checkForChanges(): Promise<FileChangeResult> {
        const prepared = await this.prepareChanges();
        await prepared.commit();
        return prepared.changes;
    }

    public getFileHash(filePath: string): string | undefined {
        const normalizedPath = this.normalizeRelPath(filePath);
        if (!normalizedPath) {
            return undefined;
        }
        return this.fileHashes.get(normalizedPath);
    }

    /**
     * Return tracked (currently considered indexable) relative file paths.
     * This reflects the synchronizer snapshot under the active ignore rules.
     */
    public getTrackedRelativePaths(): string[] {
        return Array.from(this.fileHashes.keys()).sort();
    }

    /**
     * Delete snapshot file for a given codebase path.
     */
    static async deleteSnapshot(codebasePath: string): Promise<void> {
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(codebasePath);

        try {
            await fsp.unlink(snapshotPath);
            console.log(`Deleted snapshot file: ${snapshotPath}`);
        } catch (error: unknown) {
            if (errorCode(error) === 'ENOENT') {
                console.log(`Snapshot file not found (already deleted): ${snapshotPath}`);
            } else {
                console.error(`[Synchronizer] Failed to delete snapshot file ${snapshotPath}:`, errorMessage(error));
                throw error;
            }
        }
    }
}
