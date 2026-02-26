import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import { createReadStream } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import ignore from 'ignore';
import { computeMerkleRoot } from './merkle';

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

export interface FileChangeResult {
    added: string[];
    removed: string[];
    modified: string[];
    hashedCount: number;
    partialScan: boolean;
    unscannedDirPrefixes: string[];
    fullHashRun: boolean;
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

    constructor(rootDir: string, ignorePatterns: string[] = []) {
        this.rootDir = this.canonicalizeCodebasePath(rootDir);
        this.snapshotPath = this.getSnapshotPath(this.rootDir);
        this.fileHashes = new Map();
        this.fileStats = new Map();
        this.merkleRoot = '';
        this.ignorePatterns = ignorePatterns;
        this.ignoreMatcher = ignore();
        this.ignoreMatcher.add(this.ignorePatterns);
        this.partialScan = false;
        this.unscannedDirPrefixes = [];
        this.fullHashCounter = 0;
    }

    private canonicalizeCodebasePath(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        try {
            const realPath = typeof fsSync.realpathSync.native === 'function'
                ? fsSync.realpathSync.native(resolved)
                : fsSync.realpathSync(resolved);
            return this.trimTrailingSeparators(path.normalize(realPath));
        } catch {
            return this.trimTrailingSeparators(path.normalize(resolved));
        }
    }

    private trimTrailingSeparators(inputPath: string): string {
        const parsedRoot = path.parse(inputPath).root;
        if (inputPath === parsedRoot) {
            return inputPath;
        }
        return inputPath.replace(/[\\/]+$/, '');
    }

    private static canonicalizeCodebasePath(codebasePath: string): string {
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
        if (inputPath === parsedRoot) {
            return inputPath;
        }
        return inputPath.replace(/[\\/]+$/, '');
    }

    private getSnapshotPath(codebasePath: string): string {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.satori', 'merkle');
        const canonicalPath = this.canonicalizeCodebasePath(codebasePath);
        const hash = crypto.createHash('md5').update(canonicalPath).digest('hex');
        return path.join(merkleDir, `${hash}.json`);
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

        const pathParts = normalizedPath.split('/');
        if (pathParts.some(part => part.startsWith('.'))) {
            return true;
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

    private async hashFileBytes(filePath: string): Promise<string> {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) {
            throw new Error(`Attempted to hash non-file path: ${filePath}`);
        }

        return new Promise<string>((resolve, reject) => {
            const hasher = crypto.createHash('sha256');
            const stream = createReadStream(filePath);

            stream.on('data', (chunk) => {
                hasher.update(chunk);
            });
            stream.on('error', reject);
            stream.on('end', () => {
                resolve(hasher.digest('hex'));
            });
        });
    }

    private isSignatureEqual(a: FileStatSignature | undefined, b: FileStatSignature): boolean {
        return !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    }

    private async scanDirectory(
        directoryPath: string,
        previousHashes: Map<string, string>,
        previousStats: Map<string, FileStatSignature>,
        forceFullHash: boolean,
        result: ScanResult
    ): Promise<void> {
        let entries: fsSync.Dirent[];
        try {
            entries = await fsp.readdir(directoryPath, { withFileTypes: true });
        } catch (error: any) {
            if (directoryPath === this.rootDir) {
                throw new Error(`[Synchronizer] Cannot read root directory ${directoryPath}: ${error.message}`);
            }

            const relativeDir = this.normalizeRelPath(path.relative(this.rootDir, directoryPath));
            if (relativeDir) {
                result.unscannedDirPrefixes.add(relativeDir);
            }
            console.warn(`[Synchronizer] Cannot read directory ${directoryPath}: ${error.message}`);
            return;
        }

        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const absolutePath = path.join(directoryPath, entry.name);
            const relativePath = this.normalizeRelPath(path.relative(this.rootDir, absolutePath));
            if (!relativePath) {
                continue;
            }

            if (this.shouldIgnore(relativePath, entry.isDirectory())) {
                continue;
            }

            let stat: fsSync.Stats;
            try {
                stat = await fsp.stat(absolutePath);
            } catch (error: any) {
                if (entry.isDirectory()) {
                    result.unscannedDirPrefixes.add(relativePath);
                } else {
                    result.unreadableFiles.add(relativePath);
                }
                console.warn(`[Synchronizer] Cannot stat ${absolutePath}: ${error.message}`);
                continue;
            }

            if (stat.isDirectory()) {
                if (!this.shouldIgnore(relativePath, true)) {
                    await this.scanDirectory(absolutePath, previousHashes, previousStats, forceFullHash, result);
                }
                continue;
            }

            if (!stat.isFile()) {
                continue;
            }

            if (this.shouldIgnore(relativePath, false)) {
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

            result.hashCandidates.push({ relativePath, absolutePath, signature });
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
                    const hash = await this.hashFileBytes(candidate.absolutePath);
                    result.scannedHashes.set(candidate.relativePath, hash);
                    hashedCount += 1;
                } catch (error: any) {
                    result.unreadableFiles.add(candidate.relativePath);
                    result.scannedStats.delete(candidate.relativePath);
                    console.warn(`[Synchronizer] Cannot hash file ${candidate.absolutePath}: ${error.message}`);
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

    private async saveSnapshot(): Promise<void> {
        const merkleDir = path.dirname(this.snapshotPath);
        await fsp.mkdir(merkleDir, { recursive: true });

        const fileHashes = Array.from(this.fileHashes.entries()).sort(([a], [b]) => a.localeCompare(b));
        const fileStats = Array.from(this.fileStats.entries()).sort(([a], [b]) => a.localeCompare(b));

        const payload: SnapshotV2 = {
            snapshotVersion: SNAPSHOT_VERSION,
            fileHashes,
            fileStats,
            merkleRoot: this.merkleRoot,
            partialScan: this.partialScan,
            unscannedDirPrefixes: [...this.unscannedDirPrefixes],
            fullHashCounter: this.fullHashCounter
        };

        await fsp.writeFile(this.snapshotPath, JSON.stringify(payload), 'utf-8');
        console.log(`Saved snapshot to ${this.snapshotPath}`);
    }

    private async loadSnapshot(): Promise<{ migrated: boolean }> {
        try {
            const data = await fsp.readFile(this.snapshotPath, 'utf-8');
            const obj = JSON.parse(data) as Partial<SnapshotV2>;

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
        } catch (error: any) {
            if (error.code === 'ENOENT') {
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

        await this.scanDirectory(this.rootDir, previousHashes, previousStats, forceFullHash, scanResult);
        const hashedCount = await this.hashCandidatesWithConcurrency(scanResult);
        const effective = this.buildEffectiveState(previousHashes, previousStats, scanResult);

        return { effective, hashedCount };
    }

    public async initialize(): Promise<void> {
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
            await this.saveSnapshot();
        } else if (!this.merkleRoot) {
            this.merkleRoot = computeMerkleRoot(this.fileHashes);
        }

        console.log(`[Synchronizer] File synchronizer initialized. Loaded ${this.fileHashes.size} tracked files.`);
    }

    public async checkForChanges(): Promise<FileChangeResult> {
        console.log('[Synchronizer] Checking for file changes...');

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

        this.fileHashes = effective.fileHashes;
        this.fileStats = effective.fileStats;
        this.partialScan = effective.partialScan;
        this.unscannedDirPrefixes = effective.unscannedDirPrefixes;
        this.merkleRoot = nextMerkleRoot;
        this.fullHashCounter = nextCounter;

        const hasDiffs = fileChanges.added.length > 0 || fileChanges.removed.length > 0 || fileChanges.modified.length > 0;
        const metadataChanged = previousPartialScan !== this.partialScan
            || !this.arraysEqual(previousUnscannedDirPrefixes, this.unscannedDirPrefixes);
        const counterAdvanced = previousCounter !== this.fullHashCounter;

        if (hasDiffs || hashedCount > 0 || metadataChanged || counterAdvanced) {
            await this.saveSnapshot();
        }

        if (hasDiffs) {
            console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified.`);
        } else {
            console.log('[Synchronizer] No file content changes detected.');
        }

        return {
            ...fileChanges,
            hashedCount,
            partialScan: this.partialScan,
            unscannedDirPrefixes: [...this.unscannedDirPrefixes],
            fullHashRun
        };
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
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.satori', 'merkle');
        const canonicalPath = FileSynchronizer.canonicalizeCodebasePath(codebasePath);
        const hash = crypto.createHash('md5').update(canonicalPath).digest('hex');
        const snapshotPath = path.join(merkleDir, `${hash}.json`);

        try {
            await fsp.unlink(snapshotPath);
            console.log(`Deleted snapshot file: ${snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found (already deleted): ${snapshotPath}`);
            } else {
                console.error(`[Synchronizer] Failed to delete snapshot file ${snapshotPath}:`, error.message);
                throw error;
            }
        }
    }
}
