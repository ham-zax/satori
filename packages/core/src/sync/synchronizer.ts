import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import ignore from 'ignore';
import { computeMerkleRoot } from './merkle';
import { registerAuthenticPreparedFileChangeSet } from './prepared-change-set-authority';
import {
    assertValidCurrentSnapshot,
    assertValidGenerationSnapshot,
    buildSnapshotPayload,
    GENERATION_SNAPSHOT_VERSION,
    parseSnapshotDocument,
    serializeSnapshot,
    SNAPSHOT_VERSION,
} from './snapshot-codec';
import type {
    SnapshotFileStatSignature,
    SnapshotV3,
} from './snapshot-codec';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { DEFAULT_SUPPORTED_EXTENSIONS } from '../config/defaults';
import { normalizeSupportedExtensions } from '../config/index-policy';
import {
    errorCode,
    errorMessage,
    normalizeAndCompressPrefixes,
    normalizeSynchronizerRelPath,
    observeSynchronizerPath,
    scanSynchronizerState,
} from './sync-scan';
import type {
    ExactPathObservation,
    SynchronizerScanContext,
} from './sync-scan';

type FileStatSignature = SnapshotFileStatSignature;


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

export class SynchronizerCheckpointStagingCleanupError extends Error {
    readonly cleanupStatus = 'unresolved' as const;

    constructor(
        readonly cleanupPath: string,
        readonly stagingCause: unknown,
        readonly cleanupCause: unknown,
    ) {
        super(
            `[Synchronizer] Checkpoint staging failed and cleanup is unresolved for '${cleanupPath}': ${
                cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
            }`,
        );
        this.name = 'SynchronizerCheckpointStagingCleanupError';
    }
}

class SynchronizerCheckpointCleanupFailure extends Error {
    constructor(
        readonly cleanupPath: string,
        readonly cleanupCause: unknown,
    ) {
        super(
            `[Synchronizer] Checkpoint cleanup failed for '${cleanupPath}': ${
                cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
            }`,
        );
        this.name = 'SynchronizerCheckpointCleanupFailure';
    }
}

interface PreparedSourceContract {
    readonly canonicalRoot: string;
    readonly supportedExtensions: readonly string[];
    readonly effectiveIgnorePatterns: readonly string[];
    readonly fullHashRun: boolean;
    readonly partialScan: boolean;
    readonly unscannedDirPrefixes: readonly string[];
    readonly merkleRoot: string;
}

export interface PreparedFileChangeSet {
    readonly sourceContract?: PreparedSourceContract;
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
    promoteStagedCheckpoint?(
        checkpoint: StagedSourceFreshnessCheckpoint,
        checkpointAuthority: SourceFreshnessCheckpointAuthority,
    ): void;
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
        this.ignorePatterns = [...ignorePatterns];
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
        return normalizeSynchronizerRelPath(this.rootDir, candidatePath);
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

    private async stageCheckpointState(
        checkpoint: SynchronizerCheckpointState,
        checkpointAuthority: SourceFreshnessCheckpointAuthority,
        assertMutationCurrent?: () => void,
    ): Promise<StagedSourceFreshnessCheckpoint> {
        const authority = FileSynchronizer.normalizeCheckpointAuthority(checkpointAuthority);
        const checkpointIdentity = authority.collectionName;
        const snapshotPath = FileSynchronizer.getSnapshotPathForGeneration(this.rootDir, checkpointIdentity);
        const payload = buildSnapshotPayload(checkpoint, this.rootDir, checkpointIdentity, authority) as SnapshotV3;
        const serializedPayload = serializeSnapshot(payload);
        const merkleDir = path.dirname(snapshotPath);
        const tempSnapshotPath = `${snapshotPath}.candidate-${process.pid}-${crypto.randomUUID()}`;
        let targetReplaced = false;
        let targetIdentity: fsSync.Stats | undefined;
        assertMutationCurrent?.();
        await fsp.mkdir(merkleDir, { recursive: true });
        if (fsSync.existsSync(snapshotPath)) {
            throw new Error(`cannot stage checkpoint because ${snapshotPath} already exists`);
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
            targetReplaced = true;
            targetIdentity = await fsp.lstat(snapshotPath);
            const directory = fsSync.openSync(merkleDir, 'r');
            try {
                fsSync.fsyncSync(directory);
            } finally {
                fsSync.closeSync(directory);
            }
        } catch (error) {
            if (targetReplaced) {
                try {
                    await FileSynchronizer.cleanupStagedCheckpoint({
                        snapshotPath,
                        serializedPayload,
                        targetIdentity,
                    });
                } catch (cleanupError) {
                    const unresolvedCleanupPath = cleanupError instanceof SynchronizerCheckpointCleanupFailure
                        ? cleanupError.cleanupPath
                        : snapshotPath;
                    throw new SynchronizerCheckpointStagingCleanupError(
                        unresolvedCleanupPath,
                        error,
                        cleanupError,
                    );
                }
            }
            throw error;
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

    private static async cleanupStagedCheckpoint(input: {
        snapshotPath: string;
        serializedPayload: string;
        targetIdentity?: fsSync.Stats;
    }): Promise<void> {
        if (!input.targetIdentity) {
            throw new Error('staged checkpoint identity was not fully established');
        }

        const cleanupPath = `${input.snapshotPath}.cleanup-${process.pid}-${crypto.randomUUID()}`;
        let detached = false;
        let detachedIdentity: fsSync.Stats | undefined;
        let ownershipValidated = false;
        try {
            try {
                await fsp.rename(input.snapshotPath, cleanupPath);
            } catch (error) {
                if (errorCode(error) === 'ENOENT') {
                    FileSynchronizer.fsyncDirectory(path.dirname(input.snapshotPath));
                    return;
                }
                throw error;
            }
            detached = true;
            detachedIdentity = await fsp.lstat(cleanupPath);
            if (
                !detachedIdentity.isFile()
                || detachedIdentity.isSymbolicLink()
                || detachedIdentity.dev !== input.targetIdentity.dev
                || detachedIdentity.ino !== input.targetIdentity.ino
            ) {
                throw new Error(`staged checkpoint identity changed at ${input.snapshotPath}`);
            }
            if (await fsp.readFile(cleanupPath, 'utf8') !== input.serializedPayload) {
                throw new Error(`staged checkpoint content changed at ${input.snapshotPath}`);
            }
            ownershipValidated = true;

            await fsp.unlink(cleanupPath);
            try {
                await fsp.lstat(cleanupPath);
            } catch (error) {
                if (errorCode(error) === 'ENOENT') {
                    FileSynchronizer.fsyncDirectory(path.dirname(input.snapshotPath));
                    return;
                }
                throw error;
            }
            throw new Error(`staged checkpoint still exists after cleanup: ${cleanupPath}`);
        } catch (error) {
            if (detached && !ownershipValidated && detachedIdentity) {
                try {
                    await FileSynchronizer.restoreDetachedCheckpoint({
                        snapshotPath: input.snapshotPath,
                        cleanupPath,
                        detachedIdentity,
                    });
                } catch (restoreError) {
                    throw new SynchronizerCheckpointCleanupFailure(cleanupPath, restoreError);
                }
                throw error;
            }
            if (detached) {
                throw new SynchronizerCheckpointCleanupFailure(cleanupPath, error);
            }
            throw error;
        }
    }

    private static async restoreDetachedCheckpoint(input: {
        snapshotPath: string;
        cleanupPath: string;
        detachedIdentity: fsSync.Stats;
    }): Promise<void> {
        try {
            await fsp.lstat(input.snapshotPath);
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
            await fsp.rename(input.cleanupPath, input.snapshotPath);
            const restoredIdentity = await fsp.lstat(input.snapshotPath);
            if (
                restoredIdentity.dev !== input.detachedIdentity.dev
                || restoredIdentity.ino !== input.detachedIdentity.ino
            ) {
                throw new Error(`detached checkpoint identity changed while restoring ${input.snapshotPath}`);
            }
            FileSynchronizer.fsyncDirectory(path.dirname(input.snapshotPath));
            return;
        }
        throw new Error(`cannot restore detached checkpoint because ${input.snapshotPath} is occupied`);
    }

    private async saveSnapshot(
        state?: SynchronizerCheckpointState,
        assertMutationCurrent?: () => void,
        publishMutation?: (publish: () => void) => void,
        afterPublish?: () => void,
        checkpointAuthority: SourceFreshnessCheckpointAuthority | null = this.checkpointAuthority,
    ): Promise<void> {
        const targetSnapshotPath = checkpointAuthority
            ? FileSynchronizer.getSnapshotPathForGeneration(this.rootDir, checkpointAuthority.collectionName)
            : this.snapshotPath;
        const merkleDir = path.dirname(targetSnapshotPath);
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
        const checkpointIdentity = checkpointAuthority?.collectionName ?? this.checkpointIdentity;
        const payload = buildSnapshotPayload(
            checkpoint,
            this.rootDir,
            checkpointIdentity,
            checkpointAuthority,
        );

        const serializedPayload = serializeSnapshot(payload);
        const publishedDocumentDigest: string | null = 'documentDigest' in payload
            && typeof payload.documentDigest === 'string'
            ? payload.documentDigest
            : null;
        const tempSnapshotPath = `${targetSnapshotPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let targetReplaced = false;
        let checkpointApplied = false;
        const applyPublishedCheckpoint = () => {
            if (!checkpointApplied) {
                this.checkpointIdentity = checkpointIdentity;
                this.checkpointAuthority = checkpointAuthority;
                this.snapshotPath = targetSnapshotPath;
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
                fsSync.renameSync(tempSnapshotPath, targetSnapshotPath);
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
                && fsSync.existsSync(targetSnapshotPath)
                && fsSync.readFileSync(targetSnapshotPath, 'utf8') === serializedPayload
            ) {
                applyPublishedCheckpoint();
            }
            throw error;
        } finally {
            await fsp.unlink(tempSnapshotPath).catch(() => undefined);
        }
        console.log(`Saved snapshot to ${targetSnapshotPath}`);
    }

    private async loadSnapshot(): Promise<{ migrated: boolean; missing: boolean }> {
        try {
            const data = await fsp.readFile(this.snapshotPath, 'utf-8');
            const obj = parseSnapshotDocument(data);
            if (obj.snapshotVersion === GENERATION_SNAPSHOT_VERSION) {
                assertValidGenerationSnapshot(obj, {
                    canonicalRoot: this.rootDir,
                    checkpointIdentity: this.checkpointIdentity,
                    checkpointAuthority: this.checkpointAuthority,
                });
                this.snapshotDocumentDigest = obj.documentDigest ?? null;
            } else if (obj.snapshotVersion === SNAPSHOT_VERSION) {
                if (this.checkpointIdentity) {
                    throw new Error('[Synchronizer] Authority-scoped checkpoint uses the retired root-global snapshot shape.');
                }
                assertValidCurrentSnapshot(obj, this.rootDir);
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
            this.unscannedDirPrefixes = normalizeAndCompressPrefixes(this.rootDir, new Set(Array.isArray(obj.unscannedDirPrefixes) ? obj.unscannedDirPrefixes : []));
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
            const snapshot = parseSnapshotDocument(data);
            if (snapshot.snapshotVersion !== GENERATION_SNAPSHOT_VERSION) {
                throw new Error('[Synchronizer] Authority-scoped checkpoint schema is unsupported.');
            }
            assertValidGenerationSnapshot(snapshot, {
                canonicalRoot: this.rootDir,
                checkpointIdentity: this.checkpointIdentity,
                checkpointAuthority: this.checkpointAuthority,
            });
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
        const observationContext = this.buildScanContext(false, new Map(), new Map());

        try {
            for (const relativePath of normalizedPaths) {
                firstObservations.set(relativePath, await observeSynchronizerPath(observationContext, relativePath));
            }
            for (const relativePath of normalizedPaths) {
                const first = firstObservations.get(relativePath);
                const second = await observeSynchronizerPath(observationContext, relativePath);
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

    /**
     * Compare the complete current searchable source tree with this
     * synchronizer's owned checkpoint without advancing checkpoint state.
     */
    public async compareAllSourceToOwnedCheckpoint(): Promise<SourceFreshnessPathComparison> {
        const checkpointObservationBefore = this.getOwnedSnapshotObservationToken();
        const checkpointVersionBefore = this.checkpointVersion;
        if (!checkpointObservationBefore) {
            return { status: 'unavailable' };
        }

        try {
            const prepared = await this.prepareChanges({ forceFullHash: true });
            const hasDiffs = prepared.changes.added.length > 0
                || prepared.changes.removed.length > 0
                || prepared.changes.modified.length > 0;
            if (hasDiffs) {
                return { status: 'differs' };
            }
            await prepared.assertSourceObservationCurrent();
        } catch {
            return { status: 'unavailable' };
        }

        if (
            checkpointVersionBefore !== this.checkpointVersion
            || checkpointObservationBefore !== this.getOwnedSnapshotObservationToken()
        ) {
            return { status: 'unavailable' };
        }
        return { status: 'matches' };
    }

    /**
     * Compare the complete source observation without rereading unchanged file
     * bytes. File content is hashed whenever its size, mtime, or ctime differs
     * from the owned checkpoint.
     */
    public async compareSourceObservationToOwnedCheckpoint(): Promise<SourceFreshnessPathComparison> {
        const checkpointObservationBefore = this.getOwnedSnapshotObservationToken();
        const checkpointVersionBefore = this.checkpointVersion;
        if (!checkpointObservationBefore) {
            return { status: 'unavailable' };
        }

        try {
            const prepared = await this.prepareChanges();
            const hasDiffs = prepared.changes.added.length > 0
                || prepared.changes.removed.length > 0
                || prepared.changes.modified.length > 0;
            if (hasDiffs) {
                return { status: 'differs' };
            }
            await prepared.assertSourceObservationCurrent();
        } catch {
            return { status: 'unavailable' };
        }

        if (
            checkpointVersionBefore !== this.checkpointVersion
            || checkpointObservationBefore !== this.getOwnedSnapshotObservationToken()
        ) {
            return { status: 'unavailable' };
        }
        return { status: 'matches' };
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

    public static async inspectSnapshotAuthority(
        rootDir: string,
        collectionName: string,
    ): Promise<SourceFreshnessCheckpointAuthority | null> {
        const snapshotPath = FileSynchronizer.getSnapshotPathForGeneration(rootDir, collectionName);
        try {
            const data = await fsp.readFile(snapshotPath, 'utf8');
            const snapshot = parseSnapshotDocument(data);
            if (
                snapshot.snapshotVersion === GENERATION_SNAPSHOT_VERSION
                && snapshot.checkpointIdentity === collectionName.trim()
                && snapshot.markerRunId
                && snapshot.indexPolicyHash
            ) {
                return {
                    collectionName: snapshot.checkpointIdentity,
                    markerRunId: snapshot.markerRunId,
                    indexPolicyHash: snapshot.indexPolicyHash,
                };
            }
        } catch {
            return null;
        }
        return null;
    }

    private buildScanContext(
        forceFullHash: boolean,
        previousHashes: ReadonlyMap<string, string>,
        previousStats: ReadonlyMap<string, FileStatSignature>,
    ): SynchronizerScanContext {
        return {
            rootDir: this.rootDir,
            ignoreMatcher: this.ignoreMatcher,
            supportedExtensions: [...this.supportedExtensions],
            forceFullHash,
            hashConcurrency: this.getHashConcurrency(),
            previousHashes,
            previousStats,
        };
    }

    private async scanCurrentState(
        previousHashes: Map<string, string>,
        previousStats: Map<string, FileStatSignature>,
        forceFullHash: boolean
    ): Promise<{ effective: EffectiveState; hashedCount: number }> {
        const output = await scanSynchronizerState(
            this.buildScanContext(forceFullHash, previousHashes, previousStats),
        );
        return {
            effective: {
                fileHashes: new Map(output.fileHashes),
                fileStats: new Map(output.fileStats),
                unscannedDirPrefixes: [...output.unscannedDirPrefixes],
                partialScan: output.partialScan,
            },
            hashedCount: output.hashedCount,
        };
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

        if (migrated && !this.checkpointIdentity) {
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
        } else if (missing && this.checkpointIdentity) {
            const previousHashes = new Map(this.fileHashes);
            const previousStats = new Map(this.fileStats);
            const { effective } = await this.scanCurrentState(previousHashes, previousStats, true);
            this.fileHashes = effective.fileHashes;
            this.fileStats = effective.fileStats;
            this.partialScan = effective.partialScan;
            this.unscannedDirPrefixes = effective.unscannedDirPrefixes;
            this.merkleRoot = computeMerkleRoot(this.fileHashes);
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
        let stagedReceipt: StagedSourceFreshnessCheckpoint | null = null;
        let stagedAuthority: SourceFreshnessCheckpointAuthority | null = null;
        let promoted = false;

        const sourceContract: PreparedSourceContract = Object.freeze({
            canonicalRoot: this.rootDir,
            supportedExtensions: Object.freeze(Array.from(this.supportedExtensions).sort()),
            effectiveIgnorePatterns: Object.freeze([...this.ignorePatterns]),
            fullHashRun,
            partialScan: effective.partialScan,
            unscannedDirPrefixes: Object.freeze([...effective.unscannedDirPrefixes]),
            merkleRoot: nextMerkleRoot,
        });

        const prepared: PreparedFileChangeSet = Object.freeze({
            sourceContract,
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
            stageCheckpoint: async (
                checkpointAuthority: SourceFreshnessCheckpointAuthority,
                assertMutationCurrent?: () => void,
            ) => {
                const staged = await this.stageCheckpointState(nextState, checkpointAuthority, assertMutationCurrent);
                stagedReceipt = staged;
                stagedAuthority = FileSynchronizer.normalizeCheckpointAuthority(checkpointAuthority);
                return staged;
            },
            promoteStagedCheckpoint: (
                staged: StagedSourceFreshnessCheckpoint,
                checkpointAuthority: SourceFreshnessCheckpointAuthority,
            ) => {
                if (promoted) {
                    throw new Error('[Synchronizer] Staged checkpoint has already been promoted.');
                }
                if (!stagedReceipt || stagedReceipt !== staged || staged.documentDigest !== stagedReceipt.documentDigest) {
                    throw new Error('[Synchronizer] Cannot promote checkpoint: staged receipt did not originate from this prepared change set.');
                }
                const authority = FileSynchronizer.normalizeCheckpointAuthority(checkpointAuthority);
                if (
                    !stagedAuthority
                    || stagedAuthority.collectionName !== authority.collectionName
                    || stagedAuthority.markerRunId !== authority.markerRunId
                    || stagedAuthority.indexPolicyHash !== authority.indexPolicyHash
                ) {
                    throw new Error('[Synchronizer] Checkpoint authority does not match staged checkpoint authority.');
                }
                promoted = true;
                this.fileHashes = new Map(nextState.fileHashes);
                this.fileStats = new Map(nextState.fileStats);
                this.merkleRoot = nextState.merkleRoot;
                this.partialScan = nextState.partialScan;
                this.unscannedDirPrefixes = [...nextState.unscannedDirPrefixes];
                this.fullHashCounter = nextState.fullHashCounter;
                this.checkpointIdentity = authority.collectionName;
                this.checkpointAuthority = authority;
                this.snapshotPath = staged.snapshotPath;
                this.snapshotDocumentDigest = staged.documentDigest;
                this.checkpointVersion += 1;
            },
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
        });

        registerAuthenticPreparedFileChangeSet(prepared);
        return prepared;
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

    normalizeAndCompressPrefixes(prefixes: Iterable<string>): string[] {
        return normalizeAndCompressPrefixes(this.rootDir, prefixes instanceof Set ? prefixes : new Set(prefixes));
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
