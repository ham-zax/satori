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
import { canonicalizeRepositoryRelativePath } from '../paths/repository-path';

interface FileStatSignature {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

interface ExactPathObservation {
    kind: 'absent' | 'not_indexable' | 'indexed';
    dev?: number;
    ino?: number;
    size?: number;
    mtimeMs?: number;
    ctimeMs?: number;
    hash?: string;
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

interface SnapshotV3 extends SnapshotV2 {
    snapshotVersion: 3;
    canonicalRoot: string;
    checkpointIdentity: string;
    collectionName: string;
    markerRunId: string;
    indexPolicyHash: string;
    documentDigest: string;
}

type ParsedSnapshot = Partial<SnapshotV2> & Partial<Pick<
    SnapshotV3,
    'canonicalRoot' | 'checkpointIdentity' | 'collectionName' | 'markerRunId' | 'indexPolicyHash' | 'documentDigest'
>>;

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

export type PreparedFileChangeCommitReceipt = {
    readonly status: 'committed';
    readonly checkpointVersion: number;
    readonly merkleRoot: string;
};

export type StagedSourceFreshnessCheckpoint = Readonly<{
    checkpointIdentity: string;
    snapshotPath: string;
    merkleRoot: string;
    documentDigest: string;
}>;

export class SynchronizerCheckpointPublicationError extends Error {
    readonly committed = true;

    constructor(
        message: string,
        readonly receipt: PreparedFileChangeCommitReceipt,
        readonly publicationCause: unknown,
    ) {
        super(message);
        this.name = 'SynchronizerCheckpointPublicationError';
    }
}

export interface PreparedFileChangeSet {
    readonly changes: FileChangeResult;
    readonly fileHashes: ReadonlyMap<string, string>;
    commit(
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        checkpointAuthority?: SourceFreshnessCheckpointAuthority,
    ): Promise<PreparedFileChangeCommitReceipt>;
    stageCheckpoint(
        checkpointAuthority: SourceFreshnessCheckpointAuthority,
        assertMutationCurrent?: () => void,
    ): Promise<StagedSourceFreshnessCheckpoint>;
    assertSourceObservationCurrent(): Promise<void>;
}

export interface FileSynchronizerInitializeOptions {
    /**
     * Load and scan a missing or legacy checkpoint without publishing it yet.
     * Full indexing uses this so a failed candidate cannot advance freshness
     * beyond the authority that remains readable.
     */
    deferSnapshotPublication?: boolean;
    /**
     * Refuse to manufacture a baseline when reopening an authoritative
     * generation. A missing generation checkpoint means freshness is unknown.
     */
    requireExistingCheckpoint?: boolean;
}

export interface FileSynchronizerOptions {
    /** Durable authority identity whose source checkpoint this instance owns. */
    checkpointIdentity?: string;
    /** Existing v3 marker evidence that owns the checkpoint. */
    checkpointAuthority?: SourceFreshnessCheckpointAuthority;
}

export type SourceFreshnessCheckpointAuthority = {
    readonly collectionName: string;
    readonly markerRunId: string;
    readonly indexPolicyHash: string;
};

export interface PrepareFileChangesOptions {
    /** Hash every selected source file instead of trusting cached metadata. */
    forceFullHash?: boolean;
}

export type SourceFreshnessCheckpointEvidence =
    | {
        readonly status: 'valid';
        readonly observationToken: string;
        readonly merkleRoot: string;
        readonly documentDigest: string;
    }
    | {
        readonly status: 'missing' | 'corrupt';
        readonly message: string;
    };

export type SourceFreshnessPathComparison =
    | { readonly status: 'matches' }
    | { readonly status: 'differs' }
    | { readonly status: 'unavailable' };

const SNAPSHOT_VERSION = 2;
const GENERATION_SNAPSHOT_VERSION = 3;
const DEFAULT_HASH_CONCURRENCY = 16;

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private fileStats: Map<string, FileStatSignature>;
    private merkleRoot: string;
    private rootDir: string;
    private snapshotPath: string;
    private checkpointIdentity: string | null;
    private checkpointAuthority: SourceFreshnessCheckpointAuthority | null;
    private snapshotDocumentDigest: string | null;
    private ignorePatterns: string[];
    private ignoreMatcher: ReturnType<typeof ignore>;
    private partialScan: boolean;
    private unscannedDirPrefixes: string[];
    private fullHashCounter: number;
    private supportedExtensions: Set<string>;
    private checkpointVersion: number;
    private commitQueue: Promise<void>;
    private snapshotRequiresPersistence: boolean;

    constructor(
        rootDir: string,
        ignorePatterns: string[] = [],
        supportedExtensions: string[] = DEFAULT_SUPPORTED_EXTENSIONS,
        options: FileSynchronizerOptions = {},
    ) {
        this.rootDir = FileSynchronizer.canonicalizeSnapshotIdentityPath(rootDir);
        this.checkpointIdentity = options.checkpointIdentity?.trim() || null;
        this.checkpointAuthority = options.checkpointAuthority
            ? FileSynchronizer.normalizeCheckpointAuthority(options.checkpointAuthority)
            : null;
        if (this.checkpointIdentity && !this.checkpointAuthority) {
            throw new Error('[Synchronizer] Authority-scoped checkpoint requires exact marker ownership evidence.');
        }
        if (!this.checkpointIdentity && this.checkpointAuthority) {
            throw new Error('[Synchronizer] Marker ownership evidence requires an authority-scoped checkpoint identity.');
        }
        if (
            this.checkpointIdentity
            && this.checkpointAuthority?.collectionName !== this.checkpointIdentity
        ) {
            throw new Error('[Synchronizer] Checkpoint identity must match its collection authority.');
        }
        this.snapshotPath = this.checkpointIdentity
            ? FileSynchronizer.getSnapshotPathForGeneration(this.rootDir, this.checkpointIdentity)
            : FileSynchronizer.getSnapshotPathForCodebase(this.rootDir);
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
        this.snapshotRequiresPersistence = false;
        this.snapshotDocumentDigest = null;
    }

    private static normalizeCheckpointAuthority(
        authority: SourceFreshnessCheckpointAuthority,
    ): SourceFreshnessCheckpointAuthority {
        const collectionName = authority.collectionName.trim();
        const markerRunId = authority.markerRunId.trim();
        const indexPolicyHash = authority.indexPolicyHash.trim();
        if (!collectionName || !markerRunId || !/^[a-f0-9]{64}$/.test(indexPolicyHash)) {
            throw new Error('[Synchronizer] Checkpoint marker ownership evidence is malformed.');
        }
        return { collectionName, markerRunId, indexPolicyHash };
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

    public static snapshotPathFromCanonicalPath(canonicalPath: string, checkpointIdentity?: string): string {
        const stateRoot = process.env.SATORI_STATE_ROOT || path.join(os.homedir(), '.satori');
        const merkleDir = path.join(stateRoot, 'merkle');
        const hash = crypto.createHash('md5').update(canonicalPath).digest('hex');
        if (!checkpointIdentity) {
            return path.join(merkleDir, `${hash}.json`);
        }
        const identityHash = crypto.createHash('sha256').update(checkpointIdentity).digest('hex');
        return path.join(merkleDir, `${hash}.${identityHash}.json`);
    }

    public static getSnapshotPathForCodebase(codebasePath: string): string {
        const canonicalPath = FileSynchronizer.canonicalizeSnapshotIdentityPath(codebasePath);
        return FileSynchronizer.snapshotPathFromCanonicalPath(canonicalPath);
    }

    public static getSnapshotPathForGeneration(codebasePath: string, checkpointIdentity: string): string {
        const normalizedIdentity = checkpointIdentity.trim();
        if (!normalizedIdentity) {
            throw new Error('[Synchronizer] checkpointIdentity must be nonempty.');
        }
        const canonicalPath = FileSynchronizer.canonicalizeSnapshotIdentityPath(codebasePath);
        return FileSynchronizer.snapshotPathFromCanonicalPath(canonicalPath, normalizedIdentity);
    }

    private static trimTrailingSeparators(inputPath: string): string {
        const parsedRoot = path.parse(inputPath).root;
        if (inputPath === parsedRoot) {
            return inputPath;
        }
        return inputPath.replace(/[\\/]+$/, '');
    }

    private normalizeRelPath(candidatePath: string): string {
        return canonicalizeRepositoryRelativePath(this.rootDir, candidatePath) ?? '';
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
        identity: { dev: number; ino: number };
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
            const currentPathHandle = await openRegularFileInsideRoot(filePath, this.rootDir);
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

    private isSignatureEqual(a: FileStatSignature | undefined, b: FileStatSignature): boolean {
        return !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    }

    private markUnscannedDir(relativeDir: string, result: ScanResult): void {
        if (relativeDir) {
            result.unscannedDirPrefixes.add(relativeDir);
        }
    }

    private async inspectDirectoryEntries(
        entries: fsSync.Dirent[],
        descriptorPath: string,
        relativeDirectoryPath: string,
    ): Promise<DirectoryEntryObservation[]> {
        const observations = new Array<DirectoryEntryObservation>(entries.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(this.getHashConcurrency(), entries.length) }).map(async () => {
            while (true) {
                const currentIndex = cursor;
                cursor += 1;
                if (currentIndex >= entries.length) {
                    return;
                }

                const entry = entries[currentIndex];
                if (entry.isSymbolicLink()) {
                    observations[currentIndex] = { kind: 'skip' };
                    continue;
                }

                const absolutePath = path.join(descriptorPath, entry.name);
                const relativePath = this.normalizeRelPath(
                    relativeDirectoryPath ? `${relativeDirectoryPath}/${entry.name}` : entry.name,
                );
                if (!relativePath || this.shouldIgnore(relativePath, entry.isDirectory())) {
                    observations[currentIndex] = { kind: 'skip' };
                    continue;
                }

                let stat: fsSync.Stats;
                try {
                    stat = await fsp.lstat(absolutePath);
                } catch (error: unknown) {
                    observations[currentIndex] = {
                        kind: 'unreadable',
                        relativePath,
                        directory: entry.isDirectory(),
                        message: errorMessage(error),
                    };
                    continue;
                }

                if (stat.isSymbolicLink()) {
                    observations[currentIndex] = { kind: 'skip' };
                    continue;
                }
                if (stat.isDirectory()) {
                    observations[currentIndex] = this.shouldIgnore(relativePath, true)
                        ? { kind: 'skip' }
                        : { kind: 'directory', relativePath, absolutePath };
                    continue;
                }
                if (!stat.isFile() || this.shouldIgnore(relativePath, false)) {
                    observations[currentIndex] = { kind: 'skip' };
                    continue;
                }

                const fileReal = await resolveInsideRoot(absolutePath, this.rootDir);
                if (!fileReal || fileReal !== path.join(this.rootDir, relativePath)) {
                    observations[currentIndex] = {
                        kind: 'unreadable',
                        relativePath,
                        directory: false,
                        message: 'path no longer resolves to the indexed root entry',
                    };
                    continue;
                }
                if (!await this.isSupportedFile(relativePath, fileReal, stat.size)) {
                    observations[currentIndex] = { kind: 'skip' };
                    continue;
                }

                observations[currentIndex] = {
                    kind: 'file',
                    relativePath,
                    absolutePath: fileReal,
                    signature: {
                        size: stat.size,
                        mtimeMs: Number(stat.mtimeMs),
                        ctimeMs: Number(stat.ctimeMs),
                    },
                };
            }
        });
        await Promise.all(workers);
        return observations;
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

            // Filesystem checks within one directory are independent. Resolve them
            // concurrently, then apply observations in canonical entry order so the
            // resulting maps, diagnostics, and recursive traversal remain stable.
            const observations = await this.inspectDirectoryEntries(
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
                    await this.scanDirectory(
                        observation.absolutePath,
                        observation.relativePath,
                        previousHashes,
                        previousStats,
                        forceFullHash,
                        result,
                    );
                    continue;
                }

                result.scannedStats.set(observation.relativePath, observation.signature);

                const previousSignature = previousStats.get(observation.relativePath);
                const previousHash = previousHashes.get(observation.relativePath);
                const canReuseHash = !forceFullHash
                    && this.isSignatureEqual(previousSignature, observation.signature)
                    && typeof previousHash === 'string';

                if (canReuseHash) {
                    result.scannedHashes.set(observation.relativePath, previousHash!);
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

    private buildSnapshotPayload(
        checkpoint: SynchronizerCheckpointState,
        checkpointIdentity: string | null,
        checkpointAuthority: SourceFreshnessCheckpointAuthority | null,
    ): SnapshotV2 | SnapshotV3 {
        const fileHashes = Array.from(checkpoint.fileHashes.entries()).sort(([a], [b]) => compareContractStrings(a, b));
        const fileStats = Array.from(checkpoint.fileStats.entries()).sort(([a], [b]) => compareContractStrings(a, b));
        const basePayload: SnapshotV2 = {
            snapshotVersion: SNAPSHOT_VERSION,
            fileHashes,
            fileStats,
            merkleRoot: checkpoint.merkleRoot,
            partialScan: checkpoint.partialScan,
            unscannedDirPrefixes: [...checkpoint.unscannedDirPrefixes],
            fullHashCounter: checkpoint.fullHashCounter,
        };
        if (!checkpointIdentity) return basePayload;
        if (!checkpointAuthority) {
            throw new Error('[Synchronizer] Cannot publish an authority-scoped checkpoint without marker ownership evidence.');
        }
        if (checkpointAuthority.collectionName !== checkpointIdentity) {
            throw new Error('[Synchronizer] Candidate checkpoint identity must match its collection authority.');
        }
        const generationPayload: Omit<SnapshotV3, 'documentDigest'> = {
            ...basePayload,
            snapshotVersion: GENERATION_SNAPSHOT_VERSION,
            canonicalRoot: this.rootDir,
            checkpointIdentity,
            collectionName: checkpointAuthority.collectionName,
            markerRunId: checkpointAuthority.markerRunId,
            indexPolicyHash: checkpointAuthority.indexPolicyHash,
        };
        return {
            ...generationPayload,
            documentDigest: crypto.createHash('sha256')
                .update(JSON.stringify(generationPayload))
                .digest('hex'),
        };
    }

    private async stageCheckpointState(
        checkpoint: SynchronizerCheckpointState,
        checkpointAuthority: SourceFreshnessCheckpointAuthority,
        assertMutationCurrent?: () => void,
    ): Promise<StagedSourceFreshnessCheckpoint> {
        const authority = FileSynchronizer.normalizeCheckpointAuthority(checkpointAuthority);
        const checkpointIdentity = authority.collectionName;
        const snapshotPath = FileSynchronizer.getSnapshotPathForGeneration(this.rootDir, checkpointIdentity);
        const payload = this.buildSnapshotPayload(checkpoint, checkpointIdentity, authority) as SnapshotV3;
        const serializedPayload = JSON.stringify(payload);
        const merkleDir = path.dirname(snapshotPath);
        const tempSnapshotPath = `${snapshotPath}.candidate-${process.pid}-${crypto.randomUUID()}`;
        assertMutationCurrent?.();
        await fsp.mkdir(merkleDir, { recursive: true });
        if (fsSync.existsSync(snapshotPath)) {
            throw new Error(`[Synchronizer] Candidate checkpoint already exists at ${snapshotPath}.`);
        }
        try {
            const temporaryFile = await fsp.open(tempSnapshotPath, 'wx', 0o600);
            try {
                await temporaryFile.writeFile(serializedPayload, 'utf-8');
                await temporaryFile.sync();
            } finally {
                await temporaryFile.close();
            }
            assertMutationCurrent?.();
            await fsp.rename(tempSnapshotPath, snapshotPath);
            const directory = fsSync.openSync(merkleDir, 'r');
            try {
                fsSync.fsyncSync(directory);
            } finally {
                fsSync.closeSync(directory);
            }
        } finally {
            await fsp.unlink(tempSnapshotPath).catch(() => undefined);
        }
        return {
            checkpointIdentity,
            snapshotPath,
            merkleRoot: checkpoint.merkleRoot,
            documentDigest: payload.documentDigest,
        };
    }

    private async saveSnapshot(
        state?: SynchronizerCheckpointState,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        afterPublish?: () => void,
        checkpointAuthority: SourceFreshnessCheckpointAuthority | null = this.checkpointAuthority,
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
        const payload = this.buildSnapshotPayload(
            checkpoint,
            this.checkpointIdentity,
            checkpointAuthority,
        );

        const serializedPayload = JSON.stringify(payload);
        const publishedDocumentDigest: string | null = 'documentDigest' in payload
            && typeof payload.documentDigest === 'string'
            ? payload.documentDigest
            : null;
        const tempSnapshotPath = `${this.snapshotPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let targetReplaced = false;
        let checkpointApplied = false;
        const applyPublishedCheckpoint = () => {
            if (!checkpointApplied) {
                this.checkpointAuthority = checkpointAuthority;
                this.snapshotDocumentDigest = publishedDocumentDigest;
                afterPublish?.();
                checkpointApplied = true;
            }
        };
        try {
            const temporaryFile = await fsp.open(tempSnapshotPath, 'wx', 0o600);
            try {
                await temporaryFile.writeFile(serializedPayload, 'utf-8');
                await temporaryFile.sync();
            } finally {
                await temporaryFile.close();
            }
            const publishSnapshot = () => {
                fsSync.renameSync(tempSnapshotPath, this.snapshotPath);
                targetReplaced = true;
                const directory = fsSync.openSync(merkleDir, 'r');
                try {
                    fsSync.fsyncSync(directory);
                } finally {
                    fsSync.closeSync(directory);
                }
                applyPublishedCheckpoint();
            };
            if (publishMutation) {
                let publicationCount = 0;
                publishMutation(() => {
                    publicationCount += 1;
                    if (publicationCount > 1) {
                        throw new Error('[Synchronizer] Snapshot publication callback invoked publish more than once.');
                    }
                    publishSnapshot();
                });
                if (publicationCount !== 1) {
                    throw new Error('[Synchronizer] Snapshot publication callback returned without publishing.');
                }
            } else {
                publishSnapshot();
            }
        } catch (error) {
            if (
                targetReplaced
                && !checkpointApplied
                && fsSync.existsSync(this.snapshotPath)
                && fsSync.readFileSync(this.snapshotPath, 'utf8') === serializedPayload
            ) {
                applyPublishedCheckpoint();
            }
            throw error;
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
        const rawUnscannedDirPrefixes = snapshot.unscannedDirPrefixes;
        if (typeof snapshot.partialScan !== 'boolean' || !Array.isArray(rawUnscannedDirPrefixes)) {
            invalid('partial scan metadata is malformed.');
        }
        const unscannedDirPrefixes = rawUnscannedDirPrefixes as string[];
        for (const prefix of unscannedDirPrefixes ?? []) {
            if (typeof prefix !== 'string' || !prefix || this.normalizeRelPath(prefix) !== prefix) {
                invalid('unscannedDirPrefixes contains an invalid path.');
            }
        }
        const canonicalPrefixes = this.normalizeAndCompressPrefixes(new Set(unscannedDirPrefixes));
        if (!this.arraysEqual(unscannedDirPrefixes, canonicalPrefixes)) {
            invalid('unscannedDirPrefixes must be canonical, unique, compressed, and deterministically ordered.');
        }
        if (unscannedDirPrefixes.length > 0 && snapshot.partialScan !== true) {
            invalid('partialScan must be true when unscannedDirPrefixes is nonempty.');
        }
        if (!Number.isSafeInteger(snapshot.fullHashCounter) || Number(snapshot.fullHashCounter) < 0) {
            invalid('fullHashCounter must be a nonnegative safe integer.');
        }
    }

    private assertValidGenerationSnapshot(snapshot: ParsedSnapshot): void {
        this.assertValidCurrentSnapshot(snapshot);
        if (!this.checkpointIdentity) {
            throw new Error('[Synchronizer] Generation checkpoint cannot be loaded without an authority identity.');
        }
        if (snapshot.canonicalRoot !== this.rootDir) {
            throw new Error('[Synchronizer] Generation checkpoint canonical root does not match its owner.');
        }
        if (snapshot.checkpointIdentity !== this.checkpointIdentity) {
            throw new Error('[Synchronizer] Generation checkpoint authority identity does not match its owner.');
        }
        if (!this.checkpointAuthority) {
            throw new Error('[Synchronizer] Generation checkpoint cannot be validated without exact marker ownership evidence.');
        }
        if (
            snapshot.collectionName !== this.checkpointAuthority.collectionName
            || snapshot.markerRunId !== this.checkpointAuthority.markerRunId
            || snapshot.indexPolicyHash !== this.checkpointAuthority.indexPolicyHash
        ) {
            throw new Error('[Synchronizer] Generation checkpoint does not belong to the active completion marker.');
        }
        if (typeof snapshot.documentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.documentDigest)) {
            throw new Error('[Synchronizer] Generation checkpoint document digest is invalid.');
        }
        const { documentDigest, ...unsignedSnapshot } = snapshot;
        const expectedDigest = crypto.createHash('sha256')
            .update(JSON.stringify(unsignedSnapshot))
            .digest('hex');
        if (documentDigest !== expectedDigest) {
            throw new Error('[Synchronizer] Generation checkpoint document digest does not match its payload.');
        }
    }

    private async loadSnapshot(): Promise<{ migrated: boolean; missing: boolean }> {
        try {
            const data = await fsp.readFile(this.snapshotPath, 'utf-8');
            const obj = JSON.parse(data) as ParsedSnapshot;
            if (obj.snapshotVersion === GENERATION_SNAPSHOT_VERSION) {
                this.assertValidGenerationSnapshot(obj);
                this.snapshotDocumentDigest = obj.documentDigest ?? null;
            } else if (obj.snapshotVersion === SNAPSHOT_VERSION) {
                if (this.checkpointIdentity) {
                    throw new Error('[Synchronizer] Authority-scoped checkpoint uses the retired root-global snapshot shape.');
                }
                this.assertValidCurrentSnapshot(obj);
                this.snapshotDocumentDigest = null;
            } else if (this.checkpointIdentity) {
                throw new Error('[Synchronizer] Authority-scoped checkpoint schema is unsupported.');
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
            const isV3 = obj.snapshotVersion === GENERATION_SNAPSHOT_VERSION;
            const hasCompatibleStats = this.fileStats.size > 0 || this.fileHashes.size === 0;
            const migrated = !(this.checkpointIdentity ? isV3 : isV2) || !hasCompatibleStats;

            if (migrated) {
                console.log(`Loaded legacy snapshot from ${this.snapshotPath}. Migration to v${SNAPSHOT_VERSION} required.`);
            } else {
                console.log(`Loaded snapshot from ${this.snapshotPath}`);
            }

            return { migrated, missing: false };
        } catch (error: unknown) {
            if (errorCode(error) === 'ENOENT') {
                console.log(`Snapshot file not found at ${this.snapshotPath}. Creating baseline snapshot.`);
                this.fileHashes = new Map();
                this.fileStats = new Map();
                this.merkleRoot = '';
                this.partialScan = false;
                this.unscannedDirPrefixes = [];
                this.fullHashCounter = 0;
                this.snapshotDocumentDigest = null;
                return { migrated: true, missing: true };
            }
            throw error;
        }
    }

    private snapshotObservationToken(stat: fsSync.Stats): string | null {
        if (!stat.isFile()) return null;
        return JSON.stringify({
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
        });
    }

    private getSnapshotObservationToken(): string | null {
        try {
            return this.snapshotObservationToken(fsSync.statSync(this.snapshotPath));
        } catch (error: unknown) {
            if (errorCode(error) === 'ENOENT') return null;
            throw error;
        }
    }

    /** Read-only validation for the durable checkpoint owned by this instance. */
    public async inspectOwnedSnapshot(): Promise<SourceFreshnessCheckpointEvidence> {
        if (!this.checkpointIdentity) {
            return {
                status: 'corrupt',
                message: '[Synchronizer] Source freshness inspection requires an authority-scoped checkpoint.',
            };
        }
        try {
            const observationBefore = this.snapshotObservationToken(await fsp.stat(this.snapshotPath));
            const data = await fsp.readFile(this.snapshotPath, 'utf8');
            const observationAfter = this.snapshotObservationToken(await fsp.stat(this.snapshotPath));
            if (!observationBefore || observationAfter !== observationBefore) {
                throw new Error('[Synchronizer] Source freshness checkpoint changed while it was being inspected.');
            }
            const snapshot = JSON.parse(data) as ParsedSnapshot;
            if (snapshot.snapshotVersion !== GENERATION_SNAPSHOT_VERSION) {
                throw new Error('[Synchronizer] Authority-scoped checkpoint schema is unsupported.');
            }
            this.assertValidGenerationSnapshot(snapshot);
            return {
                status: 'valid',
                observationToken: JSON.stringify({
                    stat: observationAfter,
                    documentDigest: snapshot.documentDigest,
                }),
                merkleRoot: snapshot.merkleRoot!,
                documentDigest: snapshot.documentDigest!,
            };
        } catch (error: unknown) {
            if (errorCode(error) === 'ENOENT') {
                return {
                    status: 'missing',
                    message: `[Synchronizer] Authoritative generation checkpoint is missing at ${this.snapshotPath}.`,
                };
            }
            return {
                status: 'corrupt',
                message: errorMessage(error),
            };
        }
    }

    public getOwnedSnapshotObservationToken(): string | null {
        if (!this.checkpointIdentity || !this.snapshotDocumentDigest) return null;
        const stat = this.getSnapshotObservationToken();
        return stat ? JSON.stringify({ stat, documentDigest: this.snapshotDocumentDigest }) : null;
    }

    /**
     * Compare explicit repository-relative paths with the source hashes sealed
     * by this synchronizer's active checkpoint. This is deliberately read-only:
     * callers use it to avoid publishing the same Git-dirty bytes twice.
     */
    public async comparePathsToOwnedCheckpoint(
        candidatePaths: readonly string[],
    ): Promise<SourceFreshnessPathComparison> {
        const checkpointObservationBefore = this.getOwnedSnapshotObservationToken();
        const checkpointVersionBefore = this.checkpointVersion;
        if (!checkpointObservationBefore || candidatePaths.length === 0) {
            return { status: 'unavailable' };
        }

        const normalizedPaths = Array.from(new Set(candidatePaths.map((candidatePath) => {
            const normalized = this.normalizeRelPath(candidatePath);
            return normalized === candidatePath.replace(/\\/g, '/') ? normalized : '';
        }))).filter((candidatePath) => candidatePath.length > 0).sort(compareContractStrings);
        if (normalizedPaths.length !== new Set(candidatePaths.map((value) => value.replace(/\\/g, '/'))).size) {
            return { status: 'unavailable' };
        }

        const expectedHashes = new Map(
            normalizedPaths.map((relativePath) => [relativePath, this.fileHashes.get(relativePath)]),
        );
        const firstObservations = new Map<string, ExactPathObservation>();

        try {
            for (const relativePath of normalizedPaths) {
                firstObservations.set(relativePath, await this.observeExactPath(relativePath));
            }
            for (const relativePath of normalizedPaths) {
                const first = firstObservations.get(relativePath);
                const second = await this.observeExactPath(relativePath);
                if (!first || JSON.stringify(first) !== JSON.stringify(second)) {
                    return { status: 'unavailable' };
                }
            }
        } catch {
            return { status: 'unavailable' };
        }

        if (
            checkpointVersionBefore !== this.checkpointVersion
            || checkpointObservationBefore !== this.getOwnedSnapshotObservationToken()
        ) {
            return { status: 'unavailable' };
        }

        for (const relativePath of normalizedPaths) {
            const expectedHash = expectedHashes.get(relativePath);
            const current = firstObservations.get(relativePath);
            const currentHash = current?.kind === 'indexed' ? current.hash : undefined;
            if (expectedHash !== currentHash) {
                return { status: 'differs' };
            }
        }
        return { status: 'matches' };
    }

    private async observeExactPath(relativePath: string): Promise<ExactPathObservation> {
        const absolutePath = path.join(this.rootDir, relativePath);
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
            || this.shouldIgnore(relativePath, false)
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

        const observation = await this.hashFileBytes(absolutePath);
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

    public ownsCheckpointIdentity(checkpointIdentity: string): boolean {
        return this.checkpointIdentity === checkpointIdentity.trim();
    }

    public ownsCheckpointAuthority(authority: SourceFreshnessCheckpointAuthority): boolean {
        try {
            const normalized = FileSynchronizer.normalizeCheckpointAuthority(authority);
            return this.checkpointAuthority?.collectionName === normalized.collectionName
                && this.checkpointAuthority.markerRunId === normalized.markerRunId
                && this.checkpointAuthority.indexPolicyHash === normalized.indexPolicyHash;
        } catch {
            return false;
        }
    }

    public ownsCheckpointForCollectionPolicy(
        collectionName: string,
        indexPolicyHash: string,
    ): boolean {
        const normalizedCollectionName = collectionName.trim();
        return normalizedCollectionName.length > 0
            && this.checkpointIdentity === normalizedCollectionName
            && this.checkpointAuthority?.collectionName === normalizedCollectionName
            && this.checkpointAuthority.indexPolicyHash === indexPolicyHash;
    }

    public getCheckpointIdentity(): string | null {
        return this.checkpointIdentity;
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
        this.snapshotRequiresPersistence = false;
    }

    private commitPreparedState(
        baseVersion: number,
        nextState: SynchronizerCheckpointState,
        shouldPersist: boolean,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        checkpointAuthority?: SourceFreshnessCheckpointAuthority,
    ): Promise<PreparedFileChangeCommitReceipt> {
        const commit = this.commitQueue.then(async () => {
            if (this.checkpointVersion !== baseVersion) {
                throw new Error('[Synchronizer] Cannot commit stale prepared changes. Prepare the filesystem delta again.');
            }
            let checkpointApplied = false;
            const applyCheckpoint = () => {
                this.applyCheckpointState(nextState);
                this.checkpointVersion += 1;
                checkpointApplied = true;
            };
            try {
                const normalizedAuthority = checkpointAuthority
                    ? FileSynchronizer.normalizeCheckpointAuthority(checkpointAuthority)
                    : this.checkpointAuthority;
                const authorityChanged = normalizedAuthority?.collectionName !== this.checkpointAuthority?.collectionName
                    || normalizedAuthority?.markerRunId !== this.checkpointAuthority?.markerRunId
                    || normalizedAuthority?.indexPolicyHash !== this.checkpointAuthority?.indexPolicyHash;
                if (shouldPersist || authorityChanged) {
                    await this.saveSnapshot(
                        nextState,
                        assertMutationCurrent,
                        publishMutation,
                        applyCheckpoint,
                        normalizedAuthority,
                    );
                } else if (publishMutation) {
                    let publicationCount = 0;
                    publishMutation(() => {
                        publicationCount += 1;
                        if (publicationCount > 1) {
                            throw new Error('[Synchronizer] Checkpoint publication callback invoked publish more than once.');
                        }
                        applyCheckpoint();
                    });
                    if (publicationCount !== 1) {
                        throw new Error('[Synchronizer] Checkpoint publication callback returned without publishing.');
                    }
                } else {
                    assertMutationCurrent?.();
                    applyCheckpoint();
                }
            } catch (error) {
                if (checkpointApplied) {
                    const receipt: PreparedFileChangeCommitReceipt = {
                        status: 'committed',
                        checkpointVersion: this.checkpointVersion,
                        merkleRoot: nextState.merkleRoot,
                    };
                    throw new SynchronizerCheckpointPublicationError(
                        `[Synchronizer] Checkpoint version ${receipt.checkpointVersion} committed before publication acknowledgement failed: ${errorMessage(error)}`,
                        receipt,
                        error,
                    );
                }
                throw error;
            }
            const receipt: PreparedFileChangeCommitReceipt = {
                status: 'committed',
                checkpointVersion: this.checkpointVersion,
                merkleRoot: nextState.merkleRoot,
            };
            return receipt;
        });
        this.commitQueue = commit.then(() => undefined, () => undefined);
        return commit;
    }

    public async initialize(
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        options: FileSynchronizerInitializeOptions = {},
    ): Promise<void> {
        console.log(`Initializing file synchronizer for ${this.rootDir}`);
        const { migrated, missing } = await this.loadSnapshot();

        if (missing && options.requireExistingCheckpoint) {
            throw new Error(`[Synchronizer] Authoritative generation checkpoint is missing at ${this.snapshotPath}.`);
        }

        if (migrated && options.requireExistingCheckpoint) {
            throw new Error(
                `[Synchronizer] Authoritative generation checkpoint at ${this.snapshotPath} is not fully compatible; reindex is required.`,
            );
        }

        if (migrated) {
            const previousHashes = new Map(this.fileHashes);
            const previousStats = new Map(this.fileStats);
            const { effective } = await this.scanCurrentState(previousHashes, previousStats, true);
            this.fileHashes = effective.fileHashes;
            this.fileStats = effective.fileStats;
            this.partialScan = effective.partialScan;
            this.unscannedDirPrefixes = effective.unscannedDirPrefixes;
            this.merkleRoot = computeMerkleRoot(this.fileHashes);
            if (options.deferSnapshotPublication) {
                this.snapshotRequiresPersistence = true;
            } else {
                await this.saveSnapshot(undefined, assertMutationCurrent, publishMutation);
                this.snapshotRequiresPersistence = false;
            }
        } else if (!this.merkleRoot) {
            this.merkleRoot = computeMerkleRoot(this.fileHashes);
        }

        this.checkpointVersion += 1;

        console.log(`[Synchronizer] File synchronizer initialized. Loaded ${this.fileHashes.size} tracked files.`);
    }

    public async prepareChanges(options: PrepareFileChangesOptions = {}): Promise<PreparedFileChangeSet> {
        console.log('[Synchronizer] Checking for file changes...');

        const baseVersion = this.checkpointVersion;
        const previousHashes = new Map(this.fileHashes);
        const previousStats = new Map(this.fileStats);
        const previousPartialScan = this.partialScan;
        const previousUnscannedDirPrefixes = [...this.unscannedDirPrefixes];
        const previousCounter = this.fullHashCounter;

        const fullHashInterval = this.getFullHashInterval();
        const nextCounter = fullHashInterval > 0 ? this.fullHashCounter + 1 : this.fullHashCounter;
        const fullHashRun = options.forceFullHash === true
            || (fullHashInterval > 0 && nextCounter % fullHashInterval === 0);

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
        const shouldPersist = this.snapshotRequiresPersistence
            || hasDiffs
            || hashedCount > 0
            || metadataChanged
            || counterAdvanced;
        let commit: Promise<PreparedFileChangeCommitReceipt> | undefined;

        return {
            changes,
            fileHashes: new Map(nextState.fileHashes),
            assertSourceObservationCurrent: async () => {
                const { effective } = await this.scanCurrentState(
                    new Map(nextState.fileHashes),
                    new Map(nextState.fileStats),
                    false,
                );
                const observedMerkleRoot = computeMerkleRoot(effective.fileHashes);
                if (
                    observedMerkleRoot !== nextState.merkleRoot
                    || effective.partialScan !== nextState.partialScan
                    || !this.arraysEqual(effective.unscannedDirPrefixes, nextState.unscannedDirPrefixes)
                ) {
                    throw new Error('[Synchronizer] Source observation changed while the candidate publication was being prepared.');
                }
            },
            stageCheckpoint: (
                checkpointAuthority: SourceFreshnessCheckpointAuthority,
                assertMutationCurrent?: () => void,
            ) => this.stageCheckpointState(nextState, checkpointAuthority, assertMutationCurrent),
            commit: (
                assertMutationCurrent?: () => void,
                publishMutation?: (publish: () => void) => void,
                checkpointAuthority?: SourceFreshnessCheckpointAuthority,
            ) => {
                commit ??= this.commitPreparedState(
                    baseVersion,
                    nextState,
                    shouldPersist,
                    assertMutationCurrent,
                    publishMutation,
                    checkpointAuthority,
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

    /** Remove only the checkpoint owned by this synchronizer instance. */
    public async deleteOwnedSnapshot(
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        if (assertMutationCurrent && !publishMutation) {
            throw new Error('[Synchronizer] A mutation-fenced checkpoint deletion requires an atomic publication callback.');
        }
        if (publishMutation) {
            let publicationCount = 0;
            publishMutation(() => {
                publicationCount += 1;
                if (publicationCount > 1) {
                    throw new Error('[Synchronizer] Checkpoint deletion callback invoked publish more than once.');
                }
                FileSynchronizer.deleteSnapshotPathSync(this.snapshotPath);
            });
            if (publicationCount !== 1) {
                throw new Error('[Synchronizer] Checkpoint deletion callback returned without publishing.');
            }
            return;
        }
        assertMutationCurrent?.();
        FileSynchronizer.deleteSnapshotPathSync(this.snapshotPath);
    }

    /**
     * Delete snapshot file for a given codebase path.
     */
    static async deleteSnapshot(codebasePath: string): Promise<void> {
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(codebasePath);
        const snapshotDirectory = path.dirname(snapshotPath);
        const rootSnapshotName = path.basename(snapshotPath, '.json');

        try {
            const entries = await fsp.readdir(snapshotDirectory, { withFileTypes: true });
            const ownedSnapshotNames = entries
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name)
                .filter((name) => name === `${rootSnapshotName}.json`
                    || (name.startsWith(`${rootSnapshotName}.`) && name.endsWith('.json')));
            await Promise.all(ownedSnapshotNames.map((name) => fsp.unlink(path.join(snapshotDirectory, name))));
            FileSynchronizer.fsyncDirectory(snapshotDirectory);
            console.log(`Deleted ${ownedSnapshotNames.length} snapshot file(s) for: ${codebasePath}`);
        } catch (error: unknown) {
            if (errorCode(error) === 'ENOENT') {
                console.log(`Snapshot files not found (already deleted): ${snapshotPath}`);
            } else {
                console.error(`[Synchronizer] Failed to delete snapshot file ${snapshotPath}:`, errorMessage(error));
                throw error;
            }
        }
    }

    static async deleteSnapshotForGeneration(
        codebasePath: string,
        checkpointIdentity: string,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void> {
        const snapshotPath = FileSynchronizer.getSnapshotPathForGeneration(codebasePath, checkpointIdentity);
        if (assertMutationCurrent && !publishMutation) {
            throw new Error('[Synchronizer] A mutation-fenced checkpoint deletion requires an atomic publication callback.');
        }
        if (publishMutation) {
            let publicationCount = 0;
            publishMutation(() => {
                publicationCount += 1;
                if (publicationCount > 1) {
                    throw new Error('[Synchronizer] Checkpoint deletion callback invoked publish more than once.');
                }
                FileSynchronizer.deleteSnapshotPathSync(snapshotPath);
            });
            if (publicationCount !== 1) {
                throw new Error('[Synchronizer] Checkpoint deletion callback returned without publishing.');
            }
            return;
        }
        assertMutationCurrent?.();
        FileSynchronizer.deleteSnapshotPathSync(snapshotPath);
    }

    static async pruneSnapshotsForGenerations(
        codebasePath: string,
        keepCheckpointIdentities: ReadonlySet<string>,
    ): Promise<string[]> {
        const canonicalPath = FileSynchronizer.canonicalizeSnapshotIdentityPath(codebasePath);
        const rootSnapshotPath = FileSynchronizer.snapshotPathFromCanonicalPath(canonicalPath);
        const snapshotDirectory = path.dirname(rootSnapshotPath);
        const rootSnapshotName = path.basename(rootSnapshotPath, '.json');
        const keepPaths = new Set(
            [...keepCheckpointIdentities].map((identity) => (
                FileSynchronizer.snapshotPathFromCanonicalPath(canonicalPath, identity)
            )),
        );
        let entries: fsSync.Dirent[];
        try {
            entries = await fsp.readdir(snapshotDirectory, { withFileTypes: true });
        } catch (error) {
            if (errorCode(error) === 'ENOENT') return [];
            throw error;
        }
        const removed: string[] = [];
        for (const entry of entries
            .filter((candidate) => candidate.isFile())
            .filter((candidate) => (
                candidate.name.startsWith(`${rootSnapshotName}.`)
                && candidate.name.endsWith('.json')
            ))
            .sort((left, right) => left.name.localeCompare(right.name))) {
            const snapshotPath = path.join(snapshotDirectory, entry.name);
            if (keepPaths.has(snapshotPath)) continue;
            await fsp.unlink(snapshotPath);
            removed.push(snapshotPath);
        }
        if (removed.length > 0) FileSynchronizer.fsyncDirectory(snapshotDirectory);
        return removed;
    }

    private static deleteSnapshotPathSync(snapshotPath: string): void {
        try {
            fsSync.unlinkSync(snapshotPath);
            FileSynchronizer.fsyncDirectory(path.dirname(snapshotPath));
        } catch (error: unknown) {
            if (errorCode(error) !== 'ENOENT') {
                throw error;
            }
        }
    }

    private static fsyncDirectory(directoryPath: string): void {
        const directory = fsSync.openSync(directoryPath, 'r');
        try {
            fsSync.fsyncSync(directory);
        } finally {
            fsSync.closeSync(directory);
        }
    }
}
