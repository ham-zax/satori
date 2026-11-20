/**
 * Dedicated domain owner for Satori on-disk storage inspection and bounded retention.
 *
 * Self-contained pure Node stdlib leaf (zero internal imports) so both Core
 * (`@satori-code/core/storage-maintenance`) and the standalone CLI share one
 * authoritative implementation without duplicating storage policy.
 *
 * Safety invariants:
 * - Never deletes a root with an active or unverifiable mutation lease
 *   (`stateRoot/runtime/mutation-leases`) or in `protectedRoots`.
 * - Enforces mutation fencing at delete time (per-root lock + `'gc'` lease)
 *   and respects active readers via optional lease-guard callbacks.
 * - Never follows symlinks when measuring or deleting state directories.
 * - Fails closed on malformed/unreadable `current.json` pointers, generation
 *   descriptors, candidate receipts, or pending deletes.
 * - Always removes publication descriptors/directories BEFORE dropping vector
 *   collections so a partial failure never leaves a readable descriptor with
 *   a missing collection.
 * - Cross-root retired-generation and unreferenced-collection sweeps require
 *   `soleOwner: true` verified at delete time.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_WORKTREE_IDLE_DAYS = 3;
export const DEFAULT_MAX_STORAGE_GIB = 4;
const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;
const COLLECTION_FAMILY_PREFIXES = ['code_chunks_', 'hybrid_code_chunks_'] as const;
const ROOT_KEY_RE = /^[a-f0-9]{64}$/;

export interface StorageInspectionOptions {
    vectorStoreProvider?: 'LanceDB' | 'Milvus';
    /** Resolved LanceDB directory path; `null` disables LanceDB inspection/sweeping. */
    vectorDbPath?: string | null;
}

export interface StorageBreakdown {
    totalBytes: number;
    publicationsBytes: number;
    vectorBytes: number;
    mcpRuntimeBytes: number;
    modelsBytes: number;
    typescriptResolutionBytes: number;
    diagnosticsBytes: number;
    otherBytes: number;
    publicationRootCount: number;
    vectorCollectionCount: number;
}

export type ReclaimRootReason =
    | 'orphaned_root'
    | 'empty_publication_root'
    | 'idle_worktree'
    | 'idle_repo'
    | 'storage_budget';

export interface ReclaimedRootRecord {
    rootKey: string;
    canonicalRoot: string | null;
    reason: ReclaimRootReason;
    bytesFreed: number;
    collectionsRemoved: string[];
}

export interface ReclaimedGenerationRecord {
    rootKey: string;
    canonicalRoot: string | null;
    generationId: string;
    bytesFreed: number;
}

export interface ReclaimedCollectionRecord {
    collectionName: string;
    bytesFreed: number;
}

export interface StorageMaintenanceOptions {
    stateRoot: string;
    dryRun?: boolean;
    /**
     * Must be true only when no other live Satori runtime process can hold
     * publication read leases on this `stateRoot`.
     */
    soleOwner?: boolean;
    /** Re-verified before destructive sole-owner actions so stale snapshots cannot race. */
    verifySoleOwner?: () => boolean;
    /** Active vector store provider; Milvus never sweeps local LanceDB state. */
    vectorStoreProvider?: 'LanceDB' | 'Milvus';
    /** Resolved LanceDB directory path; `null` disables LanceDB sweeping/budgeting. */
    vectorDbPath?: string | null;
    /** Evict idle Git worktree publications older than this many days (default: 3; 0 disables). */
    worktreeIdleDays?: number;
    /** Optional idle retention in days for regular repository publications. */
    idleDays?: number;
    /** Optional byte budget for managed index data (publications + vector + ts-resolution). Default: 4 GiB. Set 0 to disable. */
    maxStorageBytes?: number;
    /** Canonical repository roots currently open in active sessions; never evicted by idle/budget rules. */
    protectedRoots?: readonly string[];
    nowMs?: number;
    /** Authoritative mutation check injected from `MutationLeaseCoordinator` (fail-closed if omitted and lease artifacts exist). */
    isRootMutationActive?: (canonicalRoot: string, rootKey: string) => boolean;
    /** Authoritative check for any active/unverifiable lease before Phase D sweep. */
    hasAnyActiveOrUnverifiableLease?: () => boolean;
    /** Authoritative synchronous `'gc'` mutation lease fence injected from `MutationLeaseCoordinator`. */
    runWithRootMutationLease?: (canonicalRoot: string, rootKey: string, fn: () => boolean) => boolean;
    canDeleteGeneration?: (canonicalRoot: string, rootKey: string, generationId: string) => boolean;
    canDeleteRoot?: (canonicalRoot: string | null, rootKey: string) => boolean;
    withGenerationLeaseGuard?: (canonicalRoot: string, generationId: string, fn: () => boolean) => boolean;
    withRootLeaseGuard?: (canonicalRoot: string | null, fn: () => boolean) => boolean;
}

export interface StorageMaintenanceResult {
    stateRoot: string;
    dryRun: boolean;
    soleOwner: boolean;
    before: StorageBreakdown;
    after: StorageBreakdown;
    reclaimedBytes: number;
    removedRoots: ReclaimedRootRecord[];
    removedRetiredGenerations: ReclaimedGenerationRecord[];
    removedOrphanCollections: ReclaimedCollectionRecord[];
    removedTypescriptResolutionFiles: number;
    skippedRoots: Array<{ rootKey: string; canonicalRoot: string | null; reason: string }>;
    warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function hasLeaseArtifact(stateRoot: string, rootKey: string): boolean {
    const leaseDir = path.join(stateRoot, 'runtime', 'mutation-leases');
    for (const filePath of [path.join(leaseDir, `${rootKey}.lock`), path.join(leaseDir, `${rootKey}.json`)]) {
        try {
            fs.lstatSync(filePath);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
        }
    }
    return false;
}

function hasAnyLeaseArtifact(stateRoot: string): boolean {
    const leaseDir = path.join(stateRoot, 'runtime', 'mutation-leases');
    try {
        return fs.readdirSync(leaseDir).length > 0;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
}

function readJsonStrict(filePath: string): { status: 'absent' } | { status: 'uncertain'; reason: string } | { status: 'ok'; value: unknown } {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? { status: 'absent' }
            : { status: 'uncertain', reason: `could not stat '${filePath}': ${(error as Error).message}` };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return { status: 'uncertain', reason: `'${filePath}' is not a regular file` };
    }
    try {
        return { status: 'ok', value: JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown };
    } catch (error) {
        return { status: 'uncertain', reason: `invalid JSON at '${filePath}': ${(error as Error).message}` };
    }
}

function isValidPublicationId(id: unknown): id is string {
    return typeof id === 'string'
        && id.length > 0
        && id !== '.'
        && id !== '..'
        && !id.includes('/')
        && !id.includes('\\')
        && !id.includes('\0');
}

function isInsideDirectory(parentDir: string, candidatePath: string): boolean {
    const relative = path.relative(parentDir, candidatePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasSymlinkComponent(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    const root = path.parse(resolved).root;
    let current = root;
    for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ENOENT';
        }
    }
    return false;
}

type VectorDbResolution =
    | { kind: 'disabled' }
    | { kind: 'unowned'; dbPath: string; reason: string }
    | { kind: 'owned'; dbPath: string; allowOrphanSweep: boolean; insideStateRoot: boolean };

function resolveVectorDbState(
    stateRoot: string,
    options: StorageInspectionOptions | undefined,
): VectorDbResolution {
    if (options?.vectorStoreProvider === 'Milvus' || options?.vectorDbPath === null) {
        return { kind: 'disabled' };
    }
    const dbPath = path.resolve(options?.vectorDbPath ?? path.join(stateRoot, 'vector', 'lancedb'));
    const insideStateRoot = isInsideDirectory(stateRoot, dbPath);
    if (hasSymlinkComponent(dbPath)) {
        return { kind: 'unowned', dbPath, reason: `Vector database path '${dbPath}' contains or is a symbolic link.` };
    }
    // Check if an ancestor directory (distinct from stateRoot) has its own publications/ namespace.
    let ancestor = path.dirname(dbPath);
    for (let depth = 0; depth < 3 && ancestor !== path.dirname(ancestor); depth += 1) {
        if (ancestor !== stateRoot && fs.existsSync(path.join(ancestor, 'publications'))) {
            return {
                kind: 'unowned',
                dbPath,
                reason: `Vector database path '${dbPath}' belongs to another Satori state root at '${ancestor}'.`,
            };
        }
        ancestor = path.dirname(ancestor);
    }
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(dbPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { kind: 'owned', dbPath, allowOrphanSweep: true, insideStateRoot };
        }
        return { kind: 'unowned', dbPath, reason: `Could not inspect vector database path '${dbPath}'.` };
    }
    if (!stat.isDirectory()) {
        return { kind: 'unowned', dbPath, reason: `Vector database path '${dbPath}' is not a directory.` };
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dbPath, { withFileTypes: true });
    } catch {
        return { kind: 'unowned', dbPath, reason: `Could not read vector database directory '${dbPath}'.` };
    }
    let hasForeignEntry = false;
    for (const entry of entries) {
        const isSatoriTable = entry.isDirectory()
            && !entry.isSymbolicLink()
            && entry.name.endsWith('.lance')
            && isSatoriCollectionName(entry.name.slice(0, -'.lance'.length));
        if (!isSatoriTable) hasForeignEntry = true;
    }
    if (!insideStateRoot && hasForeignEntry) {
        return {
            kind: 'unowned',
            dbPath,
            reason: `External LanceDB path '${dbPath}' contains non-Satori entries; refusing to sweep or budget it.`,
        };
    }
    // External/shared LanceDB paths lack single-namespace ownership proof for arbitrary unreferenced-table sweeps.
    const allowOrphanSweep = insideStateRoot;
    return { kind: 'owned', dbPath, allowOrphanSweep, insideStateRoot };
}

type StorageCategory = 'publications' | 'vector' | 'ts' | 'other';

function collectRegularFiles(targetPath: string, out: string[] = []): string[] {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(targetPath);
    } catch {
        return out;
    }
    if (stat.isSymbolicLink()) return out;
    if (stat.isFile()) {
        out.push(targetPath);
        return out;
    }
    if (!stat.isDirectory()) return out;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        collectRegularFiles(path.join(targetPath, entry.name), out);
    }
    return out;
}

class StorageInodeTracker {
    private readonly inodes = new Map<string, { bytes: number; links: number }>();
    private readonly files = new Map<string, { key: string; category: StorageCategory }>();
    public totalBytes = 0;
    public publicationsBytes = 0;
    public vectorBytes = 0;
    public typescriptResolutionBytes = 0;

    addPath(targetPath: string, category: StorageCategory): number {
        let added = 0;
        for (const filePath of collectRegularFiles(targetPath)) {
            if (this.files.has(filePath)) continue;
            let stat: fs.Stats;
            try {
                stat = fs.lstatSync(filePath);
            } catch {
                continue;
            }
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            const key = `${stat.dev}:${stat.ino}`;
            const bytes = stat.blocks > 0 ? stat.blocks * 512 : stat.size;
            const existing = this.inodes.get(key);
            if (existing) {
                existing.links += 1;
            } else {
                this.inodes.set(key, { bytes, links: 1 });
                this.totalBytes += bytes;
                if (category === 'publications') this.publicationsBytes += bytes;
                else if (category === 'vector') this.vectorBytes += bytes;
                else if (category === 'ts') this.typescriptResolutionBytes += bytes;
                added += bytes;
            }
            this.files.set(filePath, { key, category });
        }
        return added;
    }

    removePath(targetPath: string): number {
        const prefix = `${targetPath}${path.sep}`;
        let freed = 0;
        for (const [filePath, entry] of [...this.files.entries()]) {
            if (filePath !== targetPath && !filePath.startsWith(prefix)) continue;
            this.files.delete(filePath);
            const inode = this.inodes.get(entry.key);
            if (!inode) continue;
            inode.links -= 1;
            if (inode.links <= 0) {
                this.inodes.delete(entry.key);
                this.totalBytes = Math.max(0, this.totalBytes - inode.bytes);
                if (entry.category === 'publications') {
                    this.publicationsBytes = Math.max(0, this.publicationsBytes - inode.bytes);
                } else if (entry.category === 'vector') {
                    this.vectorBytes = Math.max(0, this.vectorBytes - inode.bytes);
                } else if (entry.category === 'ts') {
                    this.typescriptResolutionBytes = Math.max(0, this.typescriptResolutionBytes - inode.bytes);
                }
                freed += inode.bytes;
            }
        }
        return freed;
    }

    managedBytes(): number {
        return this.publicationsBytes + this.vectorBytes + this.typescriptResolutionBytes;
    }
}

function isSatoriCollectionName(name: string): boolean {
    return COLLECTION_FAMILY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isGitWorktreePath(repoPath: string): boolean {
    const dotGit = path.join(repoPath, '.git');
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(dotGit);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;
    try {
        const content = fs.readFileSync(dotGit, 'utf8');
        return /gitdir:\s*.*[\\/]\.git[\\/]worktrees[\\/]/i.test(content);
    } catch {
        return false;
    }
}

function inspectSatoriStorageWithTracker(
    rawStateRoot: string,
    options?: StorageInspectionOptions,
): { breakdown: StorageBreakdown; tracker: StorageInodeTracker; vectorDb: VectorDbResolution } {
    const stateRoot = path.resolve(rawStateRoot);
    const tracker = new StorageInodeTracker();
    const breakdown: StorageBreakdown = {
        totalBytes: 0,
        publicationsBytes: 0,
        vectorBytes: 0,
        mcpRuntimeBytes: 0,
        modelsBytes: 0,
        typescriptResolutionBytes: 0,
        diagnosticsBytes: 0,
        otherBytes: 0,
        publicationRootCount: 0,
        vectorCollectionCount: 0,
    };

    const vectorDb = resolveVectorDbState(stateRoot, options);
    if (vectorDb.kind === 'owned') {
        try {
            const dbEntries = fs.readdirSync(vectorDb.dbPath, { withFileTypes: true });
            for (const entry of dbEntries) {
                if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith('.lance')) continue;
                const collectionName = entry.name.slice(0, -'.lance'.length);
                if (!isSatoriCollectionName(collectionName)) continue;
                breakdown.vectorCollectionCount += 1;
                breakdown.vectorBytes += tracker.addPath(path.join(vectorDb.dbPath, entry.name), 'vector');
            }
        } catch { /* ENOENT */ }
    }

    let topEntries: fs.Dirent[];
    try {
        topEntries = fs.readdirSync(stateRoot, { withFileTypes: true });
    } catch {
        breakdown.totalBytes = tracker.totalBytes;
        return { breakdown, tracker, vectorDb };
    }
    for (const entry of topEntries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(stateRoot, entry.name);
        switch (entry.name) {
            case 'publications':
                breakdown.publicationsBytes = tracker.addPath(fullPath, 'publications');
                try {
                    breakdown.publicationRootCount = fs.readdirSync(fullPath, { withFileTypes: true })
                        .filter((child) => child.isDirectory() && !child.isSymbolicLink())
                        .length;
                } catch {
                    breakdown.publicationRootCount = 0;
                }
                break;
            case 'mcp-runtime':
                breakdown.mcpRuntimeBytes = tracker.addPath(fullPath, 'other');
                break;
            case 'models':
                breakdown.modelsBytes = tracker.addPath(fullPath, 'other');
                break;
            case 'typescript-resolution':
                breakdown.typescriptResolutionBytes = tracker.addPath(fullPath, 'ts');
                break;
            case 'diagnostics':
                breakdown.diagnosticsBytes = tracker.addPath(fullPath, 'other');
                break;
            default:
                // Any non-managed files in stateRoot/vector (or when Milvus/unowned) go to otherBytes;
                // owned vectorDbPath tables were already registered in tracker above so are not double-counted.
                breakdown.otherBytes += tracker.addPath(fullPath, 'other');
                break;
        }
    }
    breakdown.totalBytes = tracker.totalBytes;
    return { breakdown, tracker, vectorDb };
}

export function inspectSatoriStorage(
    stateRoot: string,
    options?: StorageInspectionOptions,
): StorageBreakdown {
    return inspectSatoriStorageWithTracker(stateRoot, options).breakdown;
}

interface InspectedGeneration {
    id: string;
    dirPath: string;
    collectionName: string | null;
    canonicalRoot: string | null;
    createdAtMs: number;
}

interface InspectedPublicationRoot {
    rootKey: string;
    dirPath: string;
    canonicalRoot: string | null;
    currentId: string | null;
    uncertain: boolean;
    uncertainReason: string | null;
    collectionReferencesIncomplete: boolean;
    generations: InspectedGeneration[];
    candidateCollections: Set<string>;
    pendingDeleteCollections: Set<string>;
    lastUsedMs: number;
    existsOnDisk: boolean;
    existenceUnverifiable: boolean;
    isWorktree: boolean;
    mutationActive: boolean;
    protectedRoot: boolean;
    removed: boolean;
}

function extractRootCandidate(
    rootKey: string,
    candidate: unknown,
): string | null {
    if (typeof candidate !== 'string' || candidate.length === 0) return null;
    return sha256Hex(candidate) === rootKey ? candidate : null;
}

function inspectPublicationRoot(
    rootKey: string,
    dirPath: string,
    protectedSet: ReadonlySet<string>,
    isRootMutationActive: (canonicalRoot: string, rootKey: string) => boolean,
): InspectedPublicationRoot {
    let canonicalRoot: string | null = null;
    let currentId: string | null = null;
    let lastUsedMs = 0;
    let uncertain = false;
    let uncertainReason: string | null = null;
    let collectionReferencesIncomplete = false;

    const markUncertain = (reason: string, incompleteCollections = false) => {
        uncertain = true;
        uncertainReason ??= reason;
        if (incompleteCollections) collectionReferencesIncomplete = true;
    };

    const bumpLastUsed = (ms: number) => {
        if (Number.isFinite(ms) && ms > lastUsedMs) lastUsedMs = ms;
    };

    const pointerPath = path.join(dirPath, 'current.json');
    const pointerRead = readJsonStrict(pointerPath);
    if (pointerRead.status === 'uncertain') {
        markUncertain(`unreadable or malformed current.json (${pointerRead.reason})`);
    } else if (pointerRead.status === 'ok') {
        const ptr = pointerRead.value;
        if (!isRecord(ptr) || ptr.version !== 1 || !isValidPublicationId(ptr.publicationId)) {
            markUncertain(`invalid current.json pointer at '${pointerPath}'`);
        } else {
            currentId = ptr.publicationId;
        }
    }

    const lastUsedPath = path.join(dirPath, 'last-used.json');
    const lastUsedRead = readJsonStrict(lastUsedPath);
    if (lastUsedRead.status === 'ok' && isRecord(lastUsedRead.value)) {
        canonicalRoot ??= extractRootCandidate(rootKey, lastUsedRead.value.canonicalRoot);
        if (typeof lastUsedRead.value.lastUsedAt === 'string') {
            const parsed = Date.parse(lastUsedRead.value.lastUsedAt);
            if (Number.isFinite(parsed)) bumpLastUsed(parsed);
        }
    }

    const generations: InspectedGeneration[] = [];
    const generationsRoot = path.join(dirPath, 'generations');
    let genEntries: fs.Dirent[] = [];
    try {
        genEntries = fs.readdirSync(generationsRoot, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            markUncertain(`could not read generations directory '${generationsRoot}'`, true);
        }
    }
    for (const entry of genEntries) {
        const genDir = path.join(generationsRoot, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink() || !isValidPublicationId(entry.name)) {
            markUncertain(`invalid generation entry '${genDir}'`, true);
            continue;
        }
        let collectionName: string | null = null;
        let genCanonicalRoot: string | null = null;
        let createdAtMs = 0;
        const descriptorPath = path.join(genDir, 'publication.json');
        const descRead = readJsonStrict(descriptorPath);
        if (descRead.status === 'uncertain') {
            markUncertain(`unreadable or malformed publication.json at '${descriptorPath}'`, true);
        } else if (descRead.status === 'ok') {
            if (!isRecord(descRead.value)) {
                markUncertain(`invalid publication.json at '${descriptorPath}'`, true);
            } else {
                const parsedDesc = descRead.value;
                genCanonicalRoot = extractRootCandidate(rootKey, parsedDesc.canonicalRoot);
                if (typeof parsedDesc.id === 'string' && parsedDesc.id !== entry.name) {
                    markUncertain(`publication.json id mismatch at '${descriptorPath}'`, true);
                }
                if (isRecord(parsedDesc.vector) && typeof parsedDesc.vector.collectionName === 'string' && parsedDesc.vector.collectionName.length > 0) {
                    collectionName = parsedDesc.vector.collectionName;
                }
                if (typeof parsedDesc.createdAt === 'string') {
                    const parsedTime = Date.parse(parsedDesc.createdAt);
                    if (Number.isFinite(parsedTime)) createdAtMs = parsedTime;
                }
            }
        }
        if (genCanonicalRoot === null) {
            const sourceRead = readJsonStrict(path.join(genDir, 'source.json'));
            if (sourceRead.status === 'ok' && isRecord(sourceRead.value)) {
                genCanonicalRoot = extractRootCandidate(rootKey, sourceRead.value.canonicalRoot);
            }
        }
        if (createdAtMs === 0) {
            try {
                createdAtMs = fs.statSync(fs.existsSync(descriptorPath) ? descriptorPath : genDir).mtimeMs;
            } catch { /* ignore */ }
        }
        if (genCanonicalRoot !== null && (canonicalRoot === null || entry.name === currentId)) {
            canonicalRoot = genCanonicalRoot;
        }
        if (entry.name === currentId) bumpLastUsed(createdAtMs);
        generations.push({
            id: entry.name,
            dirPath: genDir,
            collectionName,
            canonicalRoot: genCanonicalRoot,
            createdAtMs,
        });
    }

    if (currentId !== null && !generations.some((g) => g.id === currentId)) {
        markUncertain(`current.json points to missing generation '${currentId}'`, true);
    }

    const candidateCollections = new Set<string>();
    const candidatesRoot = path.join(dirPath, 'candidates');
    try {
        for (const entry of fs.readdirSync(candidatesRoot, { withFileTypes: true })) {
            if (!entry.name.endsWith('.json')) continue;
            const receiptPath = path.join(candidatesRoot, entry.name);
            const receiptRead = readJsonStrict(receiptPath);
            if (receiptRead.status !== 'ok' || !isRecord(receiptRead.value)) {
                markUncertain(`unreadable or malformed candidate receipt '${receiptPath}'`, true);
                continue;
            }
            canonicalRoot ??= extractRootCandidate(rootKey, receiptRead.value.canonicalRoot);
            if (typeof receiptRead.value.collectionName === 'string' && receiptRead.value.collectionName.length > 0) {
                candidateCollections.add(receiptRead.value.collectionName);
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            markUncertain(`could not read candidates directory '${candidatesRoot}'`, true);
        }
    }

    const pendingDeleteCollections = new Set<string>();
    const pendingRoot = path.join(dirPath, 'pending-collection-deletes');
    try {
        for (const entry of fs.readdirSync(pendingRoot, { withFileTypes: true })) {
            if (!entry.name.endsWith('.json')) continue;
            const pendingPath = path.join(pendingRoot, entry.name);
            const pendingRead = readJsonStrict(pendingPath);
            if (pendingRead.status !== 'ok' || !isRecord(pendingRead.value)) {
                markUncertain(`unreadable or malformed pending delete '${pendingPath}'`, true);
                continue;
            }
            canonicalRoot ??= extractRootCandidate(rootKey, pendingRead.value.canonicalRoot);
            if (typeof pendingRead.value.collectionName === 'string' && pendingRead.value.collectionName.length > 0) {
                pendingDeleteCollections.add(pendingRead.value.collectionName);
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            markUncertain(`could not read pending-collection-deletes directory '${pendingRoot}'`, true);
        }
    }

    if (lastUsedMs === 0) {
        for (const fallbackPath of [lastUsedPath, pointerPath, dirPath]) {
            try {
                bumpLastUsed(fs.statSync(fallbackPath).mtimeMs);
            } catch { /* ignore */ }
        }
    }

    let existsOnDisk = false;
    let existenceUnverifiable = false;
    if (canonicalRoot !== null) {
        try {
            fs.lstatSync(canonicalRoot);
            existsOnDisk = true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                existsOnDisk = true;
                existenceUnverifiable = true;
                markUncertain(`could not verify root path '${canonicalRoot}' (${code ?? 'error'})`);
            }
        }
    }
    const isWorktree = existsOnDisk && !existenceUnverifiable && canonicalRoot !== null && isGitWorktreePath(canonicalRoot);
    const mutationActive = isRootMutationActive(canonicalRoot ?? '', rootKey);
    const protectedRoot = canonicalRoot !== null && protectedSet.has(canonicalRoot);

    return {
        rootKey,
        dirPath,
        canonicalRoot,
        currentId,
        uncertain,
        uncertainReason,
        collectionReferencesIncomplete,
        generations: generations.sort((a, b) => a.id.localeCompare(b.id)),
        candidateCollections,
        pendingDeleteCollections,
        lastUsedMs,
        existsOnDisk,
        existenceUnverifiable,
        isWorktree,
        mutationActive,
        protectedRoot,
        removed: false,
    };
}

export function runPublicationStorageMaintenance(
    options: StorageMaintenanceOptions,
): StorageMaintenanceResult {
    const stateRoot = path.resolve(options.stateRoot);
    const dryRun = options.dryRun === true;
    const soleOwner = options.soleOwner === true;
    const worktreeIdleDays = options.worktreeIdleDays ?? DEFAULT_WORKTREE_IDLE_DAYS;
    const idleDays = options.idleDays;
    const maxStorageBytes = options.maxStorageBytes === undefined
        ? DEFAULT_MAX_STORAGE_GIB * GIB
        : options.maxStorageBytes;
    const nowMs = options.nowMs ?? Date.now();
    const isRootMutationActive = options.isRootMutationActive
        ?? ((_canonicalRoot: string, rootKey: string) => hasLeaseArtifact(stateRoot, rootKey));
    const hasAnyActiveLease = options.hasAnyActiveOrUnverifiableLease
        ?? (() => hasAnyLeaseArtifact(stateRoot));
    const isSoleOwnerNow = (): boolean => soleOwner && (options.verifySoleOwner ? options.verifySoleOwner() : true);

    const protectedSet = new Set<string>();
    for (const root of options.protectedRoots ?? []) {
        const resolved = path.resolve(root);
        protectedSet.add(resolved);
        try {
            protectedSet.add(fs.realpathSync.native(resolved));
        } catch { /* ignore */ }
    }

    const inspectionOptions: StorageInspectionOptions = {
        vectorStoreProvider: options.vectorStoreProvider,
        vectorDbPath: options.vectorDbPath,
    };
    const { breakdown: before, tracker, vectorDb } = inspectSatoriStorageWithTracker(stateRoot, inspectionOptions);
    const removedRoots: ReclaimedRootRecord[] = [];
    const removedRetiredGenerations: ReclaimedGenerationRecord[] = [];
    const removedOrphanCollections: ReclaimedCollectionRecord[] = [];
    const skippedRoots: Array<{ rootKey: string; canonicalRoot: string | null; reason: string }> = [];
    const warnings: string[] = [];
    let removedTypescriptResolutionFiles = 0;

    if (vectorDb.kind === 'unowned') {
        warnings.push(vectorDb.reason);
    }

    const skipReason = !isSoleOwnerNow()
        ? 'Runtime owner exclusivity is unavailable; skipping storage maintenance.'
        : !dryRun && !options.runWithRootMutationLease
            ? 'Root mutation lease authority is unavailable; skipping destructive storage maintenance.'
            : undefined;
    if (skipReason) {
        warnings.push(skipReason);
        return {
            stateRoot,
            dryRun,
            soleOwner,
            before,
            after: before,
            reclaimedBytes: 0,
            removedRoots,
            removedRetiredGenerations,
            removedOrphanCollections,
            removedTypescriptResolutionFiles,
            skippedRoots,
            warnings,
        };
    }

    const publicationsRoot = path.join(stateRoot, 'publications');
    const inspectedRoots: InspectedPublicationRoot[] = [];
    let rootEntries: fs.Dirent[] = [];
    try {
        rootEntries = fs.readdirSync(publicationsRoot, { withFileTypes: true });
    } catch { /* ENOENT */ }

    for (const entry of rootEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(publicationsRoot, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink() || !ROOT_KEY_RE.test(entry.name)) {
            warnings.push(`Skipped non-standard publication entry '${fullPath}'.`);
            continue;
        }
        const inspected = inspectPublicationRoot(
            entry.name,
            fullPath,
            protectedSet,
            isRootMutationActive,
        );
        if (inspected.uncertain && inspected.uncertainReason) {
            warnings.push(`Skipped uncertain publication root '${entry.name}': ${inspected.uncertainReason}.`);
            skippedRoots.push({ rootKey: inspected.rootKey, canonicalRoot: inspected.canonicalRoot, reason: 'uncertain_state' });
        }
        inspectedRoots.push(inspected);
    }

    const anyCollectionReferencesIncomplete = inspectedRoots.some((r) => r.collectionReferencesIncomplete);
    const removedCollections = new Set<string>();
    const removedTsFiles = new Set<string>();
    let projectedVectorCollectionCount = before.vectorCollectionCount;
    let totalFreedBytes = 0;

    const collectReferencedCollections = (): Set<string> => {
        const referenced = new Set<string>();
        for (const root of inspectedRoots) {
            if (root.removed) continue;
            for (const gen of root.generations) {
                if (gen.collectionName) referenced.add(gen.collectionName);
            }
            for (const col of root.candidateCollections) referenced.add(col);
            for (const col of root.pendingDeleteCollections) referenced.add(col);
        }
        return referenced;
    };

    const removeTarget = (targetPath: string, recursive: boolean): number => {
        const freed = tracker.removePath(targetPath);
        if (!dryRun) {
            fs.rmSync(targetPath, { recursive, force: true });
        }
        totalFreedBytes += freed;
        return freed;
    };

    const removeCollectionDirIfUnreferenced = (collectionName: string, referenced: ReadonlySet<string>): number => {
        if (vectorDb.kind !== 'owned' || anyCollectionReferencesIncomplete) return 0;
        if (!isSatoriCollectionName(collectionName) || referenced.has(collectionName) || removedCollections.has(collectionName)) {
            return 0;
        }
        const lanceDir = path.join(vectorDb.dbPath, `${collectionName}.lance`);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(lanceDir);
        } catch {
            return 0;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) return 0;
        removedCollections.add(collectionName);
        projectedVectorCollectionCount = Math.max(0, projectedVectorCollectionCount - 1);
        return removeTarget(lanceDir, true);
    };

    const removeTsForRoot = (rootKey: string): { count: number; bytes: number } => {
        const tsDir = path.join(stateRoot, 'typescript-resolution');
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(tsDir, { withFileTypes: true });
        } catch {
            return { count: 0, bytes: 0 };
        }
        let count = 0;
        let bytes = 0;
        for (const entry of entries) {
            if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(rootKey)) continue;
            const fullPath = path.join(tsDir, entry.name);
            if (removedTsFiles.has(fullPath)) continue;
            removedTsFiles.add(fullPath);
            bytes += removeTarget(fullPath, false);
            count += 1;
        }
        return { count, bytes };
    };

    const runWithGenerationFence = (root: InspectedPublicationRoot, genId: string, fn: () => boolean): boolean => {
        if (root.canonicalRoot === null) return false;
        if (options.canDeleteGeneration && !options.canDeleteGeneration(root.canonicalRoot, root.rootKey, genId)) {
            return false;
        }
        if (dryRun) return fn();
        if (isRootMutationActive(root.canonicalRoot, root.rootKey)) return false;
        const withReaderGuard = options.withGenerationLeaseGuard
            ? (inner: () => boolean) => options.withGenerationLeaseGuard!(root.canonicalRoot!, genId, inner)
            : (inner: () => boolean) => inner();
        return options.runWithRootMutationLease!(root.canonicalRoot, root.rootKey, () => withReaderGuard(fn));
    };

    const runWithRootFence = (root: InspectedPublicationRoot, fn: () => boolean): boolean => {
        if (root.canonicalRoot === null && !options.runWithRootMutationLease) return false;
        if (options.canDeleteRoot && !options.canDeleteRoot(root.canonicalRoot, root.rootKey)) {
            return false;
        }
        if (dryRun) return fn();
        if (!isSoleOwnerNow()) return false;
        if (isRootMutationActive(root.canonicalRoot ?? '', root.rootKey)) return false;
        const withReaderGuard = options.withRootLeaseGuard
            ? (inner: () => boolean) => options.withRootLeaseGuard!(root.canonicalRoot, inner)
            : (inner: () => boolean) => inner();
        return options.runWithRootMutationLease!(root.canonicalRoot ?? '', root.rootKey, () => withReaderGuard(fn));
    };

    const evictRoot = (root: InspectedPublicationRoot, reason: ReclaimRootReason): void => {
        const evicted = runWithRootFence(root, () => {
            const candidateCols = new Set<string>();
            for (const gen of root.generations) {
                if (gen.collectionName) candidateCols.add(gen.collectionName);
            }
            for (const col of root.candidateCollections) candidateCols.add(col);
            for (const col of root.pendingDeleteCollections) candidateCols.add(col);

            // Always remove publication metadata first, then vector collections.
            let bytesFreed = removeTarget(root.dirPath, true);
            root.removed = true;

            const stillReferenced = collectReferencedCollections();
            const collectionsRemoved: string[] = [];
            for (const col of [...candidateCols].sort()) {
                const colBytes = removeCollectionDirIfUnreferenced(col, stillReferenced);
                if (colBytes > 0) {
                    bytesFreed += colBytes;
                    collectionsRemoved.push(col);
                }
            }

            const tsRemoved = removeTsForRoot(root.rootKey);
            removedTypescriptResolutionFiles += tsRemoved.count;
            bytesFreed += tsRemoved.bytes;

            removedRoots.push({
                rootKey: root.rootKey,
                canonicalRoot: root.canonicalRoot,
                reason,
                bytesFreed,
                collectionsRemoved,
            });
            return true;
        });
        if (!evicted) {
            skippedRoots.push({ rootKey: root.rootKey, canonicalRoot: root.canonicalRoot, reason: 'fence_blocked' });
        }
    };

    // Phase A: Reclaim crash-survived retired & incompatible generations when soleOwner is proven.
    if (isSoleOwnerNow()) {
        for (const root of inspectedRoots) {
            if (root.uncertain) continue;
            if (root.mutationActive) {
                skippedRoots.push({ rootKey: root.rootKey, canonicalRoot: root.canonicalRoot, reason: 'mutation_active' });
                continue;
            }
            const survivingGenerations: InspectedGeneration[] = [];
            for (const gen of root.generations) {
                const isCurrent = root.currentId !== null && gen.id === root.currentId;
                const isActiveCandidate = gen.collectionName !== null && root.candidateCollections.has(gen.collectionName);
                if (isCurrent || isActiveCandidate) {
                    survivingGenerations.push(gen);
                    continue;
                }
                if (!isSoleOwnerNow()) {
                    survivingGenerations.push(gen);
                    continue;
                }
                const removed = runWithGenerationFence(root, gen.id, () => {
                    const bytesFreed = removeTarget(gen.dirPath, true);
                    removedRetiredGenerations.push({
                        rootKey: root.rootKey,
                        canonicalRoot: root.canonicalRoot,
                        generationId: gen.id,
                        bytesFreed,
                    });
                    return true;
                });
                if (!removed) {
                    survivingGenerations.push(gen);
                }
            }
            root.generations = survivingGenerations;
        }
    }

    // Phase B: Evict orphaned roots whose source directory is confirmed absent on disk.
    for (const root of inspectedRoots) {
        if (root.removed || root.uncertain || root.mutationActive || root.protectedRoot) continue;
        if (root.canonicalRoot !== null && !root.existsOnDisk && !root.existenceUnverifiable) {
            evictRoot(root, 'orphaned_root');
            continue;
        }
        if (
            isSoleOwnerNow()
            && root.canonicalRoot === null
            && root.generations.length === 0
            && root.candidateCollections.size === 0
            && root.pendingDeleteCollections.size === 0
        ) {
            evictRoot(root, 'empty_publication_root');
        }
    }

    // Phase C: Idle retention (worktrees first, then optional regular-repo idleDays).
    if (isSoleOwnerNow()) {
        for (const root of inspectedRoots) {
            if (root.removed || root.uncertain || root.mutationActive || root.protectedRoot) continue;
            const ageMs = nowMs - root.lastUsedMs;
            if (root.isWorktree && worktreeIdleDays > 0 && ageMs >= worktreeIdleDays * DAY_MS) {
                evictRoot(root, 'idle_worktree');
                continue;
            }
            if (idleDays !== undefined && idleDays > 0 && ageMs >= idleDays * DAY_MS) {
                evictRoot(root, 'idle_repo');
            }
        }
    }

    // Phase D: Sweep unreferenced LanceDB tables and orphaned typescript-resolution files.
    if (isSoleOwnerNow()) {
        if (hasAnyActiveLease()) {
            warnings.push('Skipped unreferenced collection/cache sweep because an active or unverifiable mutation lease exists.');
        } else {
            if (vectorDb.kind === 'owned' && vectorDb.allowOrphanSweep && !anyCollectionReferencesIncomplete) {
                const referencedCollections = collectReferencedCollections();
                let vectorEntries: fs.Dirent[] = [];
                try {
                    vectorEntries = fs.readdirSync(vectorDb.dbPath, { withFileTypes: true });
                } catch { /* ENOENT */ }
                for (const entry of vectorEntries.sort((a, b) => a.name.localeCompare(b.name))) {
                    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith('.lance')) continue;
                    const collectionName = entry.name.slice(0, -'.lance'.length);
                    if (!isSatoriCollectionName(collectionName)) continue;
                    if (referencedCollections.has(collectionName) || removedCollections.has(collectionName)) continue;
                    if (!isSoleOwnerNow() || hasAnyActiveLease()) break;
                    removedCollections.add(collectionName);
                    projectedVectorCollectionCount = Math.max(0, projectedVectorCollectionCount - 1);
                    const bytesFreed = removeTarget(path.join(vectorDb.dbPath, entry.name), true);
                    removedOrphanCollections.push({ collectionName, bytesFreed });
                }
            }

            const survivingRootKeys = new Set(inspectedRoots.filter((r) => !r.removed).map((r) => r.rootKey));
            const tsDir = path.join(stateRoot, 'typescript-resolution');
            let tsEntries: fs.Dirent[] = [];
            try {
                tsEntries = fs.readdirSync(tsDir, { withFileTypes: true });
            } catch { /* ENOENT */ }
            for (const entry of tsEntries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (!entry.isFile() || entry.isSymbolicLink()) continue;
                const prefix = entry.name.slice(0, 64);
                if (!ROOT_KEY_RE.test(prefix) || survivingRootKeys.has(prefix)) continue;
                const fullPath = path.join(tsDir, entry.name);
                if (removedTsFiles.has(fullPath)) continue;
                if (!isSoleOwnerNow() || hasAnyActiveLease()) break;
                removedTsFiles.add(fullPath);
                removeTarget(fullPath, false);
                removedTypescriptResolutionFiles += 1;
            }
        }
    }

    // Phase E: Enforce LRU storage budget on managed index data when over limit.
    if (isSoleOwnerNow() && maxStorageBytes > 0 && tracker.managedBytes() > maxStorageBytes) {
        const evictable = inspectedRoots
            .filter((r) => !r.removed && !r.uncertain && !r.mutationActive && !r.protectedRoot)
            .sort((left, right) => {
                if (left.isWorktree !== right.isWorktree) return left.isWorktree ? -1 : 1;
                return left.lastUsedMs - right.lastUsedMs || left.rootKey.localeCompare(right.rootKey);
            });
        for (const candidate of evictable) {
            if (tracker.managedBytes() <= maxStorageBytes || !isSoleOwnerNow()) break;
            evictRoot(candidate, 'storage_budget');
        }
    }

    const after: StorageBreakdown = dryRun
        ? {
            ...before,
            totalBytes: tracker.totalBytes,
            publicationsBytes: tracker.publicationsBytes,
            vectorBytes: tracker.vectorBytes,
            typescriptResolutionBytes: tracker.typescriptResolutionBytes,
            publicationRootCount: Math.max(0, before.publicationRootCount - removedRoots.length),
            vectorCollectionCount: projectedVectorCollectionCount,
        }
        : inspectSatoriStorage(stateRoot, inspectionOptions);

    const reclaimedBytes = totalFreedBytes;

    return {
        stateRoot,
        dryRun,
        soleOwner,
        before,
        after,
        reclaimedBytes,
        removedRoots,
        removedRetiredGenerations,
        removedOrphanCollections,
        removedTypescriptResolutionFiles,
        skippedRoots,
        warnings,
    };
}
