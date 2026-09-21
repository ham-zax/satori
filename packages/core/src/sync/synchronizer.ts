import * as fsSync from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { computeMerkleRoot } from './merkle';
import {
    buildPublicationSourceCheckpoint,
    publicationSourceCheckpointState,
    type PublicationSourceCheckpoint,
    type SnapshotFileStatSignature,
} from './snapshot-codec';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { DEFAULT_SUPPORTED_EXTENSIONS } from '../config/defaults';
import {
    isSemanticAuxiliaryFilename,
    normalizeSupportedExtensions,
} from '../config/index-policy';
import {
    normalizeSynchronizerRelPath,
    observeSynchronizerPath,
    scanSynchronizerState,
} from './sync-scan';
import type {
    ExactPathObservation,
    SynchronizerScanContext,
} from './sync-scan';
import type { PublicationId } from '../generation/contracts';

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
    unprocessedPaths: string[];
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
};

export interface PreparedFileChangeSet {
    readonly changes: FileChangeResult;
    readonly fileHashes: ReadonlyMap<string, string>;
    readonly sourceCheckpoint: PublicationSourceCheckpoint;
    commit(assertMutationCurrent?: () => void): Promise<PreparedFileChangeCommitReceipt>;
    assertSourceObservationCurrent(): Promise<void>;
}

export interface FileSynchronizerOptions {
    sourceCheckpoint?: PublicationSourceCheckpoint;
    additionalObservablePaths?: readonly string[];
}

export interface PrepareFileChangesOptions {
    /** Hash every selected source file instead of trusting captured metadata. */
    forceFullHash?: boolean;
    /** Reuse exact path/hash/stat observations already captured by the full indexing pipeline. */
    capturedFullIndexSource?: Readonly<{
        fileHashes: ReadonlyMap<string, string>;
        fileStats: ReadonlyMap<string, SnapshotFileStatSignature>;
        unprocessedPaths?: readonly string[];
    }>;
}

export type SourceFreshnessPathComparison =
    | { readonly status: 'matches' }
    | { readonly status: 'differs' }
    | { readonly status: 'unavailable' };

export type ProvenSourceFreshnessCheckpointEvidence =
    | {
        readonly status: 'valid';
        readonly publicationId: PublicationId;
        readonly observationToken: string;
    }
    | {
        readonly status: 'missing' | 'corrupt';
        readonly message: string;
    };

const DEFAULT_HASH_CONCURRENCY = 16;

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private fileStats: Map<string, FileStatSignature>;
    private merkleRoot: string;
    private readonly rootDir: string;
    private ignorePatterns: string[];
    private ignoreMatcher: ReturnType<typeof ignore>;
    private partialScan: boolean;
    private unscannedDirPrefixes: string[];
    private unprocessedPaths: string[];
    private fullHashCounter: number;
    private supportedExtensions: Set<string>;
    private additionalObservablePaths: Set<string>;
    private checkpointVersion: number;
    private commitQueue: Promise<void>;

    constructor(
        rootDir: string,
        ignorePatterns: string[] = [],
        supportedExtensions: string[] = DEFAULT_SUPPORTED_EXTENSIONS,
        options: FileSynchronizerOptions = {},
    ) {
        this.rootDir = FileSynchronizer.canonicalizeRoot(rootDir);
        this.ignorePatterns = [...ignorePatterns];
        this.ignoreMatcher = ignore();
        this.ignoreMatcher.add(this.ignorePatterns);
        this.supportedExtensions = new Set(normalizeSupportedExtensions(
            supportedExtensions.length > 0 ? supportedExtensions : DEFAULT_SUPPORTED_EXTENSIONS,
        ));
        this.additionalObservablePaths = this.normalizeAdditionalObservablePaths(
            options.additionalObservablePaths ?? [],
        );
        const checkpoint = options.sourceCheckpoint;
        if (checkpoint) {
            if (checkpoint.canonicalRoot !== this.rootDir) {
                throw new Error('[Synchronizer] Publication source checkpoint root does not match the synchronizer root.');
            }
            const state = publicationSourceCheckpointState(checkpoint);
            this.fileHashes = new Map(state.fileHashes);
            this.fileStats = new Map(state.fileStats);
            this.unprocessedPaths = [...state.unprocessedPaths];
            this.fullHashCounter = 0;
            this.checkpointVersion = 1;
        } else {
            this.fileHashes = new Map();
            this.fileStats = new Map();
            this.unprocessedPaths = [];
            this.fullHashCounter = 0;
            this.checkpointVersion = 0;
        }
        this.merkleRoot = computeMerkleRoot(this.fileHashes);
        this.partialScan = false;
        this.unscannedDirPrefixes = [];
        this.commitQueue = Promise.resolve();
    }

    private static canonicalizeRoot(codebasePath: string): string {
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

    private static trimTrailingSeparators(inputPath: string): string {
        const parsedRoot = path.parse(inputPath).root;
        if (inputPath === parsedRoot) return inputPath;
        return inputPath.replace(/[\\/]+$/, '');
    }

    private normalizeRelPath(candidatePath: string): string {
        return normalizeSynchronizerRelPath(this.rootDir, candidatePath);
    }

    private normalizeAdditionalObservablePaths(paths: readonly string[]): Set<string> {
        const normalized = new Set<string>();
        for (const candidatePath of paths) {
            const relativePath = this.normalizeRelPath(candidatePath);
            if (!relativePath || relativePath !== candidatePath.replace(/\\/g, '/')) {
                throw new Error(`[Synchronizer] Invalid additional observable path '${candidatePath}'.`);
            }
            normalized.add(relativePath);
        }
        return normalized;
    }

    public setAdditionalObservablePaths(paths: readonly string[]): void {
        this.additionalObservablePaths = this.normalizeAdditionalObservablePaths(paths);
    }

    private parsePositiveInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
        if (!rawValue || rawValue.trim().length === 0) return fallback;
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
        if (parsed < min) return min;
        if (parsed > max) return max;
        return parsed;
    }

    private getHashConcurrency(): number {
        return this.parsePositiveInt(process.env.SATORI_SYNC_HASH_CONCURRENCY, DEFAULT_HASH_CONCURRENCY, 1, 64);
    }

    private getFullHashInterval(): number {
        return this.parsePositiveInt(process.env.SATORI_SYNC_FULL_HASH_EVERY_N, 0, 0, 1_000_000);
    }

    private compareStates(
        oldHashes: ReadonlyMap<string, string>,
        newHashes: ReadonlyMap<string, string>,
    ): { added: string[]; removed: string[]; modified: string[] } {
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];
        for (const [filePath, hash] of newHashes.entries()) {
            const previousHash = oldHashes.get(filePath);
            if (previousHash === undefined) added.push(filePath);
            else if (previousHash !== hash) modified.push(filePath);
        }
        for (const filePath of oldHashes.keys()) {
            if (!newHashes.has(filePath)) removed.push(filePath);
        }
        added.sort(compareContractStrings);
        removed.sort(compareContractStrings);
        modified.sort(compareContractStrings);
        return { added, removed, modified };
    }

    private arraysEqual(left: readonly string[], right: readonly string[]): boolean {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    private buildScanContext(
        forceFullHash: boolean,
        previousHashes: ReadonlyMap<string, string>,
        previousStats: ReadonlyMap<string, FileStatSignature>,
        excludedPaths: ReadonlySet<string> = new Set(),
    ): SynchronizerScanContext {
        return {
            rootDir: this.rootDir,
            ignoreMatcher: this.ignoreMatcher,
            supportedExtensions: [...this.supportedExtensions],
            additionalObservablePaths: this.additionalObservablePaths,
            excludedPaths,
            forceFullHash,
            hashConcurrency: this.getHashConcurrency(),
            previousHashes,
            previousStats,
        };
    }

    private async scanCurrentState(
        previousHashes: ReadonlyMap<string, string>,
        previousStats: ReadonlyMap<string, FileStatSignature>,
        forceFullHash: boolean,
        excludedPaths: ReadonlySet<string> = new Set(),
    ): Promise<{ effective: EffectiveState; hashedCount: number }> {
        const output = await scanSynchronizerState(
            this.buildScanContext(forceFullHash, previousHashes, previousStats, excludedPaths),
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
        this.fileHashes = new Map(state.fileHashes);
        this.fileStats = new Map(state.fileStats);
        this.partialScan = state.partialScan;
        this.unscannedDirPrefixes = [...state.unscannedDirPrefixes];
        this.merkleRoot = state.merkleRoot;
        this.fullHashCounter = state.fullHashCounter;
        this.unprocessedPaths = [...state.unprocessedPaths];
    }

    public async prepareChanges(options: PrepareFileChangesOptions = {}): Promise<PreparedFileChangeSet> {
        const baseVersion = this.checkpointVersion;
        const previousHashes = new Map(this.fileHashes);
        const previousStats = new Map(this.fileStats);
        const fullHashInterval = this.getFullHashInterval();
        const nextCounter = fullHashInterval > 0 ? this.fullHashCounter + 1 : this.fullHashCounter;
        const capturedFullIndexSource = options.capturedFullIndexSource;
        const nextUnprocessedPaths = Array.from(new Set(
            (capturedFullIndexSource?.unprocessedPaths ?? this.unprocessedPaths).map((candidatePath) => {
                const normalizedPath = this.normalizeRelPath(candidatePath);
                if (!normalizedPath || normalizedPath !== candidatePath) {
                    throw new Error(`[Synchronizer] Invalid unprocessed source path '${candidatePath}'.`);
                }
                return normalizedPath;
            }),
        )).sort(compareContractStrings);
        const excludedPaths = new Set(nextUnprocessedPaths);
        const fullHashRun = capturedFullIndexSource !== undefined
            || options.forceFullHash === true
            || (fullHashInterval > 0 && nextCounter % fullHashInterval === 0);

        let effective: EffectiveState;
        let hashedCount: number;
        if (capturedFullIndexSource) {
            if (capturedFullIndexSource.fileHashes.size !== capturedFullIndexSource.fileStats.size) {
                throw new Error('[Synchronizer] Captured full-index source hashes/stats do not cover the same file set.');
            }
            for (const relativePath of capturedFullIndexSource.fileHashes.keys()) {
                if (!capturedFullIndexSource.fileStats.has(relativePath)) {
                    throw new Error(`[Synchronizer] Captured full-index source is missing stat evidence for '${relativePath}'.`);
                }
            }
            const scanned = await this.scanCurrentState(
                capturedFullIndexSource.fileHashes,
                capturedFullIndexSource.fileStats,
                false,
                excludedPaths,
            );
            for (const [relativePath, capturedHash] of capturedFullIndexSource.fileHashes) {
                if (scanned.effective.fileHashes.get(relativePath) !== capturedHash) {
                    throw new Error('[Synchronizer] Source observation changed while the candidate Publication was being prepared.');
                }
            }
            for (const relativePath of scanned.effective.fileHashes.keys()) {
                if (
                    !capturedFullIndexSource.fileHashes.has(relativePath)
                    && !isSemanticAuxiliaryFilename(relativePath)
                    && !this.additionalObservablePaths.has(relativePath)
                ) {
                    throw new Error('[Synchronizer] Source observation changed while the candidate Publication was being prepared.');
                }
            }
            effective = scanned.effective;
            hashedCount = effective.fileHashes.size;
        } else {
            const scanned = await this.scanCurrentState(
                previousHashes,
                previousStats,
                fullHashRun,
                excludedPaths,
            );
            effective = scanned.effective;
            hashedCount = scanned.hashedCount;
        }
        if (effective.partialScan || effective.unscannedDirPrefixes.length > 0) {
            throw new Error('[Synchronizer] Source observation is incomplete; refusing to build a Publication source checkpoint.');
        }

        const nextMerkleRoot = computeMerkleRoot(effective.fileHashes);
        const fileChanges = this.compareStates(previousHashes, effective.fileHashes);
        const changes: FileChangeResult = {
            ...fileChanges,
            hashedCount,
            partialScan: false,
            unscannedDirPrefixes: [],
            fullHashRun,
        };
        const nextState: SynchronizerCheckpointState = {
            ...effective,
            merkleRoot: nextMerkleRoot,
            fullHashCounter: nextCounter,
            unprocessedPaths: nextUnprocessedPaths,
        };
        const sourceCheckpoint = buildPublicationSourceCheckpoint(this.rootDir, {
            fileHashes: nextState.fileHashes,
            fileStats: nextState.fileStats,
            unprocessedPaths: nextState.unprocessedPaths,
        });
        let commit: Promise<PreparedFileChangeCommitReceipt> | undefined;
        const prepared: PreparedFileChangeSet = Object.freeze({
            changes,
            fileHashes: new Map(nextState.fileHashes),
            sourceCheckpoint,
            assertSourceObservationCurrent: async () => {
                const observed = await this.scanCurrentState(
                    new Map(nextState.fileHashes),
                    new Map(nextState.fileStats),
                    false,
                    new Set(nextState.unprocessedPaths),
                );
                if (
                    observed.effective.partialScan
                    || observed.effective.unscannedDirPrefixes.length > 0
                    || computeMerkleRoot(observed.effective.fileHashes) !== nextState.merkleRoot
                ) {
                    throw new Error('[Synchronizer] Source observation changed while the candidate Publication was being prepared.');
                }
            },
            commit: (assertMutationCurrent?: () => void) => {
                commit ??= this.commitQueue.then(() => {
                    if (this.checkpointVersion !== baseVersion) {
                        throw new Error('[Synchronizer] Cannot commit stale prepared changes. Prepare the source delta again.');
                    }
                    assertMutationCurrent?.();
                    this.applyCheckpointState(nextState);
                    this.checkpointVersion += 1;
                    return {
                        status: 'committed' as const,
                        checkpointVersion: this.checkpointVersion,
                    };
                });
                this.commitQueue = commit.then(() => undefined, () => undefined);
                return commit;
            },
        });
        return prepared;
    }

    public async comparePathsToOwnedCheckpoint(
        candidatePaths: readonly string[],
    ): Promise<SourceFreshnessPathComparison> {
        const checkpointVersionBefore = this.checkpointVersion;
        if (checkpointVersionBefore < 1 || candidatePaths.length === 0) {
            return { status: 'unavailable' };
        }
        const requestedPaths = candidatePaths.map((value) => value.replace(/\\/g, '/'));
        const normalizedPaths = Array.from(new Set(requestedPaths.map((candidatePath) => {
            const normalized = this.normalizeRelPath(candidatePath);
            return normalized === candidatePath ? normalized : '';
        }))).filter((candidatePath) => candidatePath.length > 0).sort(compareContractStrings);
        if (normalizedPaths.length !== new Set(requestedPaths).size) {
            return { status: 'unavailable' };
        }
        const unprocessedPaths = new Set(this.unprocessedPaths);
        const observedPaths = normalizedPaths.filter((relativePath) => !unprocessedPaths.has(relativePath));
        if (observedPaths.length === 0) {
            return { status: 'matches' };
        }
        const expectedHashes = new Map(
            observedPaths.map((relativePath) => [relativePath, this.fileHashes.get(relativePath)]),
        );
        const firstObservations = new Map<string, ExactPathObservation>();
        const observationContext = this.buildScanContext(false, new Map(), new Map());
        try {
            for (const relativePath of observedPaths) {
                firstObservations.set(relativePath, await observeSynchronizerPath(observationContext, relativePath));
            }
            for (const relativePath of observedPaths) {
                const first = firstObservations.get(relativePath);
                const second = await observeSynchronizerPath(observationContext, relativePath);
                if (!first || JSON.stringify(first) !== JSON.stringify(second)) {
                    return { status: 'unavailable' };
                }
            }
        } catch {
            return { status: 'unavailable' };
        }
        if (checkpointVersionBefore !== this.checkpointVersion) {
            return { status: 'unavailable' };
        }
        for (const relativePath of observedPaths) {
            const current = firstObservations.get(relativePath);
            const currentHash = current?.kind === 'indexed' ? current.hash : undefined;
            if (expectedHashes.get(relativePath) !== currentHash) {
                return { status: 'differs' };
            }
        }
        return { status: 'matches' };
    }

    public async compareAllSourceToOwnedCheckpoint(): Promise<SourceFreshnessPathComparison> {
        return this.compareSourceToOwnedCheckpoint(true);
    }

    public async compareSourceObservationToOwnedCheckpoint(): Promise<SourceFreshnessPathComparison> {
        return this.compareSourceToOwnedCheckpoint(false);
    }

    private async compareSourceToOwnedCheckpoint(forceFullHash: boolean): Promise<SourceFreshnessPathComparison> {
        const checkpointVersionBefore = this.checkpointVersion;
        if (checkpointVersionBefore < 1) return { status: 'unavailable' };
        try {
            const prepared = await this.prepareChanges({ forceFullHash });
            const hasDiffs = prepared.changes.added.length > 0
                || prepared.changes.removed.length > 0
                || prepared.changes.modified.length > 0;
            if (hasDiffs) return { status: 'differs' };
            await prepared.assertSourceObservationCurrent();
        } catch {
            return { status: 'unavailable' };
        }
        return checkpointVersionBefore === this.checkpointVersion
            ? { status: 'matches' }
            : { status: 'unavailable' };
    }

    public getSourceCheckpoint(): PublicationSourceCheckpoint {
        return buildPublicationSourceCheckpoint(this.rootDir, {
            fileHashes: this.fileHashes,
            fileStats: this.fileStats,
            unprocessedPaths: this.unprocessedPaths,
        });
    }

    public getTrackedRelativePaths(): string[] {
        return Array.from(this.fileHashes.keys()).sort(compareContractStrings);
    }

    public getFileHash(filePath: string): string | undefined {
        const normalizedPath = this.normalizeRelPath(filePath);
        return normalizedPath ? this.fileHashes.get(normalizedPath) : undefined;
    }
}
