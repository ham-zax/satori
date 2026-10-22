import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION,
    isRelationshipManifest,
    isSymbolRegistryManifest,
} from './contracts';
import { buildSymbolRegistry, computeSymbolRegistryManifestHash } from './registry';
import type {
    RelationshipManifest,
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistryManifest,
} from './contracts';
import type { SymbolRegistry } from './registry';
import type { RelationshipAnalysisEvidence } from '../relationships';
import {
    SYMBOL_INDEX_SCHEMA_VERSION,
    isRecord,
    isRelationshipAnalysisEvidence,
    isRelationshipRecord,
    isSymbolIndexFile,
    isSymbolRecord,
} from './sidecar-validators';
import type { SymbolIndexFile } from './sidecar-validators';

// Sidecar layout constants shared by reads and the write lifecycle
export const NAVIGATION_DIR_NAME = 'navigation';
export const SYMBOLS_DIR_NAME = 'symbols';
export const RELATIONSHIPS_DIR_NAME = 'relationships';
export const SYMBOL_FILE_CONTRIBUTION_SCHEMA_VERSION = 'symbol_file_contribution_v1';

// Shard reads are batched by bytes as well as count so one oversized shard
// batch cannot multiply the transient string + parse peak.
const SHARD_READ_MAX_FILES_PER_BATCH = 64;
const SHARD_READ_MAX_BYTES_PER_BATCH = 16 * 1024 * 1024;

// Read boundary input/result contracts
export interface PublicationNavigation {
    publicationId: string;
    navigationRoot: string;
    symbolRegistryManifestHash: string;
    relationshipManifestHash: string;
}

export interface ReadSymbolRegistrySidecarInput {
    normalizedRootPath: string;
    publicationId: string;
    navigationRoot: string;
}

export type ReadSymbolRegistrySidecarResult =
    | {
        status: 'ok';
        publicationId: string;
        rootPath: string;
        manifestHash: string;
        registry: SymbolRegistry;
        warnings: string[];
    }
    | {
        status: 'missing' | 'incompatible' | 'corrupt';
        rootPath: string;
        reason: string;
        registry?: undefined;
        warnings?: undefined;
        manifestHash?: undefined;
    };

export interface ReadRelationshipSidecarInput {
    normalizedRootPath: string;
    /** When omitted, the current Publication symbol manifest is read and hashed directly. */
    expectedSymbolRegistryManifestHash?: string;
    publicationId: string;
    navigationRoot: string;
    /**
     * When supplied, validated analysis evidence is streamed to this visitor
     * instead of being retained in `analysisByFile` (which is then empty).
     * Query-side readers use it to keep only compact projections resident.
     */
    visitAnalysisEvidence?: (filePath: string, evidence: RelationshipAnalysisEvidence) => void;
    /** Reuses shards that an earlier read already validated. See `RelationshipShardReuse`. */
    shardReuse?: RelationshipShardReuse;
}

/**
 * Per-shard reuse across Publications. Publications hardlink unchanged shards,
 * so an unchanged shard keeps its reuse key. The key covers every parse input:
 * the manifest contribution schema, the manifest file entry, and the shard
 * file's stat witness (device, inode, size, mtime). ctime is excluded because
 * each new hardlink changes it.
 */
export interface RelationshipShardReuse {
    /**
     * Returns the records validated under `key`, or undefined to read and
     * parse the shard. Must have no side effects: it runs before earlier shards
     * are visited.
     */
    lookup(key: string): readonly RelationshipRecord[] | undefined;
    /**
     * Called for every shard in manifest order, after `visitAnalysisEvidence`
     * for that file. A reused shard was not read, so `visitAnalysisEvidence`
     * did not run for it.
     */
    visitShard(filePath: string, key: string, records: readonly RelationshipRecord[], reused: boolean): void;
}

export interface ReadRelationshipAnalysisEvidenceInput {
    normalizedRootPath: string;
    publicationId: string;
    navigationRoot: string;
    /** The already validated manifest of this immutable Publication. */
    manifest: RelationshipManifest;
    files: readonly string[];
}

export type ReadRelationshipAnalysisEvidenceResult =
    | {
        status: 'ok';
        rootPath: string;
        analysisByFile: Map<string, RelationshipAnalysisEvidence>;
    }
    | {
        status: 'missing' | 'incompatible' | 'corrupt';
        rootPath: string;
        reason: string;
    };

export type ReadRelationshipSidecarResult =
    | {
        status: 'ok';
        rootPath: string;
        manifestHash: string;
        manifest: RelationshipManifest;
        records: RelationshipRecord[];
        analysisByFile: Map<string, RelationshipAnalysisEvidence>;
        warnings: string[];
        reason?: undefined;
    }
    | {
        status: 'missing' | 'incompatible' | 'corrupt';
        rootPath: string;
        reason: string;
        manifestHash?: undefined;
        manifest?: undefined;
        records?: undefined;
        analysisByFile?: undefined;
        warnings?: undefined;
    };

// Shared path and file helpers
export function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRootPath(rootPath: string): string {
    const normalized = path.resolve(rootPath).replace(/\\/g, '/');
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function fileShardName(filePath: string, fileHash: string): string {
    const digest = crypto.createHash('sha256')
        .update(`${filePath}\0${fileHash}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `${digest}.json`;
}

// Shared serialization helpers. Small manifests stay readable; bulky per-file
// shards are written compact.
export function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializeShardJson(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

// The relationship manifest hash identifies a Publication's relationship graph.
export function hashSerializedString(serialized: string): string {
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

// Deterministic relationship record ordering
export function compareRelationshipRecords(a: RelationshipRecord, b: RelationshipRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    if (a.type !== b.type) return compareStrings(a.type, b.type);
    if (a.sourceKey !== b.sourceKey) return compareStrings(a.sourceKey, b.sourceKey);
    const aTarget = a.targetKey || a.targetInstanceId || a.targetPath || '';
    const bTarget = b.targetKey || b.targetInstanceId || b.targetPath || '';
    if (aTarget !== bTarget) return compareStrings(aTarget, bTarget);
    const aLine = a.span?.startLine ?? 0;
    const bLine = b.span?.startLine ?? 0;
    if (aLine !== bLine) return aLine - bLine;
    return compareStrings(a.sourceInstanceId || '', b.sourceInstanceId || '');
}

// Symbol registry reads
export function buildSymbolIndex(
    manifest: SymbolRegistryManifest,
    manifestHash: string,
): SymbolIndexFile {
    return {
        schemaVersion: SYMBOL_INDEX_SCHEMA_VERSION,
        manifestHash,
        files: [...manifest.files]
            .map((file) => ({
                path: file.path,
                hash: file.hash,
                language: file.language,
                symbolCount: file.symbolCount,
                definitionStatus: file.definitionStatus,
                shardPath: path.posix.join(SYMBOLS_DIR_NAME, 'by-file', fileShardName(file.path, file.hash)),
            }))
            .sort((a, b) => compareStrings(a.path, b.path)),
    };
}

function symbolIndexMatchesManifest(
    indexFile: SymbolIndexFile,
    manifest: SymbolRegistryManifest,
    manifestHash: string,
): boolean {
    const expected = buildSymbolIndex(manifest, manifestHash);
    if (
        indexFile.manifestHash !== expected.manifestHash
        || indexFile.files.length !== expected.files.length
    ) {
        return false;
    }
    return expected.files.every((file, index) => {
        const actual = indexFile.files[index];
        return actual?.path === file.path
            && actual.hash === file.hash
            && actual.language === file.language
            && actual.symbolCount === file.symbolCount
            && actual.definitionStatus === file.definitionStatus
            && actual.shardPath === file.shardPath;
    });
}

export async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

type ShardBatchVisitor<T> = (item: T, serialized: string, stats: fs.BigIntStats) => ReadShardVisitResult;
type ReadShardVisitResult = { status: 'ok' } | { status: 'incompatible'; reason: string };
type ShardReadSkip<T, R> = {
    /** Pure lookup; a defined result skips the read of that shard. */
    lookup: (item: T, stats: fs.BigIntStats) => R | undefined;
    visit: (item: T, reused: R, stats: fs.BigIntStats) => ReadShardVisitResult;
};

/**
 * Reads shards in order, in batches bounded by file count and total bytes, and
 * hands each serialized shard to `visit` before the next batch is read. Stops at
 * the first rejected shard. Shards that `skip.lookup` resolves are not read and
 * go to `skip.visit` at their position in the order.
 */
async function visitShardsInByteBudget<T, R = never>(
    readableRoot: string,
    items: readonly T[],
    shardPathOf: (item: T) => string,
    visit: ShardBatchVisitor<T>,
    skip?: ShardReadSkip<T, R>,
): Promise<ReadShardVisitResult> {
    let offset = 0;
    while (offset < items.length) {
        const batch: { item: T; filePath: string; stats: fs.BigIntStats; reused: R | undefined }[] = [];
        let batchBytes = 0;
        while (offset < items.length && batch.length < SHARD_READ_MAX_FILES_PER_BATCH) {
            const item = items[offset]!;
            const filePath = path.join(readableRoot, shardPathOf(item));
            const stats = await fs.promises.stat(filePath, { bigint: true });
            const reused = skip?.lookup(item, stats);
            const size = reused === undefined ? Number(stats.size) : 0;
            if (batch.length > 0 && batchBytes + size > SHARD_READ_MAX_BYTES_PER_BATCH) break;
            batch.push({ item, filePath, stats, reused });
            batchBytes += size;
            offset += 1;
        }
        const serializedShards = await Promise.all(batch.map((entry) => (
            entry.reused === undefined ? fs.promises.readFile(entry.filePath, 'utf8') : undefined
        )));
        for (let index = 0; index < batch.length; index += 1) {
            const entry = batch[index]!;
            const result = entry.reused === undefined
                ? visit(entry.item, serializedShards[index]!, entry.stats)
                : skip!.visit(entry.item, entry.reused, entry.stats);
            if (result.status !== 'ok') return result;
        }
    }
    return { status: 'ok' };
}

function publicationNavigationPathMatchesIdentity(navigationRoot: string, publicationId: string): boolean {
    return path.basename(navigationRoot) === NAVIGATION_DIR_NAME
        && path.basename(path.dirname(navigationRoot)) === publicationId;
}

export async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput): Promise<ReadSymbolRegistrySidecarResult> {
    const rootPath = path.resolve(input.navigationRoot);
    if (!publicationNavigationPathMatchesIdentity(rootPath, input.publicationId)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'Publication navigation path does not match the requested Publication ID',
        };
    }
    const readableRoot = rootPath;
    const manifestPath = path.join(readableRoot, 'manifest.json');
    const indexPath = path.join(readableRoot, SYMBOLS_DIR_NAME, 'index.json');

    try {
        await fs.promises.access(manifestPath, fs.constants.R_OK);
    } catch {
        return {
            status: 'missing',
            rootPath,
            reason: 'symbol registry manifest is missing',
        };
    }

    let manifest: SymbolRegistryManifest;
    let indexFile: SymbolIndexFile;
    try {
        const rawManifest = await readJson(manifestPath);
        if (!isSymbolRegistryManifest(rawManifest)) {
            return {
                status: isRecord(rawManifest) && typeof rawManifest.schemaVersion === 'string'
                    ? 'incompatible'
                    : 'corrupt',
                rootPath,
                reason: 'symbol registry manifest is invalid or incompatible',
            };
        }
        manifest = rawManifest;

        const rawIndex = await readJson(indexPath);
        if (!isSymbolIndexFile(rawIndex)) {
            return {
                status: 'corrupt',
                rootPath,
                reason: 'symbol registry index is invalid or incompatible',
            };
        }
        indexFile = rawIndex;
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    const manifestHash = computeSymbolRegistryManifestHash(manifest);
    if (normalizeRootPath(manifest.normalizedRootPath) !== normalizeRootPath(input.normalizedRootPath)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'symbol registry manifest root does not match requested codebase root',
        };
    }
    if (!symbolIndexMatchesManifest(indexFile, manifest, manifestHash)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'symbol registry index does not exactly match the manifest and deterministic shard layout',
        };
    }

    try {
        const expectedShardNames = indexFile.files
            .map((file) => path.basename(file.shardPath))
            .sort(compareStrings);
        const actualShardNames = (await fs.promises.readdir(path.join(readableRoot, SYMBOLS_DIR_NAME, 'by-file'), { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .sort(compareStrings);
        if (
            actualShardNames.length !== expectedShardNames.length
            || actualShardNames.some((name, index) => name !== expectedShardNames[index])
        ) {
            return {
                status: 'incompatible',
                rootPath,
                reason: 'symbol registry shard set does not exactly match the manifest index',
            };
        }
        const symbols: SymbolRecord[] = [];
        const shardResult = await visitShardsInByteBudget(
            readableRoot,
            indexFile.files,
            (file) => file.shardPath,
            (file, serializedShard): ReadShardVisitResult => {
                const shard = JSON.parse(serializedShard) as {
                    schemaVersion?: unknown;
                    manifestHash?: unknown;
                    path?: unknown;
                    hash?: unknown;
                    language?: unknown;
                    symbols?: unknown;
                };
                const shardSymbols = shard.symbols;
                const contributionIdentityValid = shard.schemaVersion === SYMBOL_FILE_CONTRIBUTION_SCHEMA_VERSION;
                if (
                    !contributionIdentityValid
                    || shard.path !== file.path
                    || shard.hash !== file.hash
                    || shard.language !== file.language
                    || !Array.isArray(shardSymbols)
                ) {
                    return { status: 'incompatible', reason: `symbol registry shard is invalid for ${file.path}` };
                }
                if (shardSymbols.length !== file.symbolCount) {
                    return {
                        status: 'incompatible',
                        reason: `symbol registry shard symbol count does not match manifest for ${file.path}`,
                    };
                }
                if (!shardSymbols.every((symbol) =>
                    isSymbolRecord(symbol)
                    && symbol.file === file.path
                    && symbol.fileHash === file.hash
                    && symbol.language === file.language
                )) {
                    return { status: 'incompatible', reason: `symbol registry shard record is invalid for ${file.path}` };
                }
                for (const symbol of shardSymbols as SymbolRecord[]) symbols.push(symbol);
                return { status: 'ok' };
            },
        );
        if (shardResult.status !== 'ok') {
            return { status: 'incompatible', rootPath, reason: shardResult.reason };
        }
        const registry = buildSymbolRegistry({ manifest, symbols });
        return {
            status: 'ok',
            publicationId: input.publicationId,
            rootPath,
            manifestHash,
            registry,
            warnings: registry.warnings,
        };
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

// Relationship reads
export async function readRelationshipSidecar(input: ReadRelationshipSidecarInput): Promise<ReadRelationshipSidecarResult> {
    const rootPath = path.resolve(input.navigationRoot);
    if (!publicationNavigationPathMatchesIdentity(rootPath, input.publicationId)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'Publication navigation path does not match the requested Publication ID',
        };
    }
    const readableRoot = rootPath;
    const relationshipsRoot = path.join(readableRoot, RELATIONSHIPS_DIR_NAME);
    const manifestPath = path.join(relationshipsRoot, 'manifest.json');
    const byFileDir = path.join(relationshipsRoot, 'by-file');

    try {
        await fs.promises.access(manifestPath, fs.constants.R_OK);
    } catch {
        return {
            status: 'missing',
            rootPath,
            reason: 'relationship manifest is missing',
        };
    }

    let manifest: RelationshipManifest;
    let manifestHash: string;
    try {
        const serializedManifest = await fs.promises.readFile(manifestPath, 'utf8');
        const rawManifest = JSON.parse(serializedManifest) as unknown;
        manifestHash = crypto.createHash('sha256').update(serializedManifest, 'utf8').digest('hex');
        if (!isRelationshipManifest(rawManifest)) {
            return {
                status: isRecord(rawManifest) && typeof rawManifest.schemaVersion === 'string'
                    ? 'incompatible'
                    : 'corrupt',
                rootPath,
                reason: 'relationship manifest is invalid or incompatible',
            };
        }
        manifest = rawManifest;
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    let expectedSymbolRegistryManifestHash = input.expectedSymbolRegistryManifestHash;
    if (!expectedSymbolRegistryManifestHash) {
        try {
            const rawSymbolManifest = await readJson(path.join(readableRoot, 'manifest.json'));
            if (!isSymbolRegistryManifest(rawSymbolManifest)) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: 'symbol registry manifest is invalid or incompatible',
                };
            }
            expectedSymbolRegistryManifestHash = computeSymbolRegistryManifestHash(rawSymbolManifest);
        } catch (error) {
            return {
                status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
                rootPath,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }
    if (manifest.symbolRegistryManifestHash !== expectedSymbolRegistryManifestHash) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'relationship manifest hash does not match symbol registry manifest hash',
        };
    }

    const records: RelationshipRecord[] = [];
    const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();
    const warnings: string[] = [];
    try {
        const expectedShardNames = manifest.files.map((file) => path.basename(file.shardPath)).sort(compareStrings);
        const actualShardNames = (await fs.promises.readdir(byFileDir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .sort(compareStrings);
        if (
            actualShardNames.length !== expectedShardNames.length
            || actualShardNames.some((name, index) => name !== expectedShardNames[index])
        ) {
            return {
                status: 'incompatible',
                rootPath,
                reason: 'relationship shard set does not exactly match the relationship manifest',
            };
        }
        const shardReuse = input.shardReuse;
        const shardResult = await visitShardsInByteBudget(
            readableRoot,
            manifest.files,
            (file) => file.shardPath,
            (file, serializedShard, stats) => {
                const parsed = parseRelationshipShard(
                    manifest,
                    file,
                    serializedShard,
                );
                if (parsed.status !== 'ok') return parsed;
                for (const record of parsed.records) records.push(record);
                if (parsed.analysisEvidence !== undefined) {
                    if (input.visitAnalysisEvidence) {
                        input.visitAnalysisEvidence(file.path, parsed.analysisEvidence);
                    } else {
                        analysisByFile.set(file.path, parsed.analysisEvidence);
                    }
                }
                shardReuse?.visitShard(file.path, relationshipShardReuseKey(manifest, file, stats), parsed.records, false);
                return { status: 'ok' };
            },
            shardReuse
                ? {
                    lookup: (file, stats) => shardReuse.lookup(relationshipShardReuseKey(manifest, file, stats)),
                    visit: (file, reusedRecords, stats) => {
                        for (const record of reusedRecords) records.push(record);
                        shardReuse.visitShard(file.path, relationshipShardReuseKey(manifest, file, stats), reusedRecords, true);
                        return { status: 'ok' };
                    },
                }
                : undefined,
        );
        if (shardResult.status !== 'ok') {
            return { status: 'incompatible', rootPath, reason: shardResult.reason };
        }
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    return {
        status: 'ok',
        rootPath,
        manifestHash,
        manifest,
        records: records.sort(compareRelationshipRecords),
        analysisByFile,
        warnings: [...new Set(warnings)].sort(compareStrings),
    };
}

function relationshipShardReuseKey(
    manifest: RelationshipManifest,
    file: RelationshipManifest['files'][number],
    stats: fs.BigIntStats,
): string {
    return JSON.stringify([
        manifest.fileContributionSchemaVersion ?? null,
        file.path,
        file.hash,
        file.shardPath,
        file.relationshipCount,
        file.analysisEvidencePresent,
        String(stats.dev),
        String(stats.ino),
        String(stats.size),
        String(stats.mtimeNs),
    ]);
}

type ParsedRelationshipShard =
    | {
        status: 'ok';
        records: RelationshipRecord[];
        analysisEvidence?: RelationshipAnalysisEvidence;
    }
    | { status: 'incompatible'; reason: string };

function parseRelationshipShard(
    manifest: RelationshipManifest,
    file: RelationshipManifest['files'][number],
    serializedShard: string,
): ParsedRelationshipShard {
    const expectedShardPath = path.posix.join(
        RELATIONSHIPS_DIR_NAME,
        'by-file',
        fileShardName(file.path, file.hash),
    );
    if (file.shardPath !== expectedShardPath) {
        return {
            status: 'incompatible',
            reason: `relationship manifest has a non-deterministic shard path for ${file.path}`,
        };
    }
    const rawShard = JSON.parse(serializedShard) as unknown;
    if (typeof rawShard !== 'object' || rawShard === null || Array.isArray(rawShard)) {
        return { status: 'incompatible', reason: `relationship shard is invalid for ${file.path}` };
    }
    const shard = rawShard as {
        schemaVersion?: unknown;
        path?: unknown;
        hash?: unknown;
        relationships?: unknown;
        records?: unknown;
        analysisEvidence?: unknown;
    };
    if (
        manifest.fileContributionSchemaVersion === RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION
        && shard.schemaVersion !== RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION
    ) {
        return {
            status: 'incompatible',
            reason: `relationship shard contribution identity does not match manifest for ${file.path}`,
        };
    }
    if (shard.path !== file.path || shard.hash !== file.hash) {
        return { status: 'incompatible', reason: `relationship shard metadata is invalid for ${file.path}` };
    }
    const shardRecords = Array.isArray(shard.relationships) ? shard.relationships : shard.records;
    if (!Array.isArray(shardRecords) || shardRecords.length !== file.relationshipCount) {
        return { status: 'incompatible', reason: `relationship shard record count is invalid for ${file.path}` };
    }
    for (const record of shardRecords) {
        if (!isRelationshipRecord(record) || record.file !== shard.path) {
            return { status: 'incompatible', reason: `relationship shard record is invalid for ${file.path}` };
        }
    }
    if ((shard.analysisEvidence !== undefined) !== file.analysisEvidencePresent) {
        return {
            status: 'incompatible',
            reason: `relationship analysis evidence presence does not match manifest for ${file.path}`,
        };
    }
    if (shard.analysisEvidence === undefined) {
        return { status: 'ok', records: shardRecords as RelationshipRecord[] };
    }
    if (!isRelationshipAnalysisEvidence(shard.analysisEvidence)) {
        return { status: 'incompatible', reason: `relationship analysis evidence is invalid for ${file.path}` };
    }
    if ((shard.analysisEvidence.resolutionClaims ?? []).some((claim) => claim.sourceFile !== shard.path)) {
        return { status: 'incompatible', reason: `relationship resolution claim source does not match ${file.path}` };
    }
    return {
        status: 'ok',
        records: shardRecords as RelationshipRecord[],
        analysisEvidence: shard.analysisEvidence,
    };
}

/**
 * Reads analysis evidence for selected files of an already validated,
 * immutable relationship manifest. Files without evidence are omitted.
 */
export async function readRelationshipAnalysisEvidence(
    input: ReadRelationshipAnalysisEvidenceInput,
): Promise<ReadRelationshipAnalysisEvidenceResult> {
    const rootPath = path.resolve(input.navigationRoot);
    if (!publicationNavigationPathMatchesIdentity(rootPath, input.publicationId)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'Publication navigation path does not match the requested Publication ID',
        };
    }
    const requested = new Set(input.files);
    const files = input.manifest.files.filter((file) => requested.has(file.path) && file.analysisEvidencePresent);
    const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();
    try {
        const shardResult = await visitShardsInByteBudget(
            rootPath,
            files,
            (file) => file.shardPath,
            (file, serializedShard) => {
                const parsed = parseRelationshipShard(
                    input.manifest,
                    file,
                    serializedShard,
                );
                if (parsed.status !== 'ok') return parsed;
                if (parsed.analysisEvidence !== undefined) analysisByFile.set(file.path, parsed.analysisEvidence);
                return { status: 'ok' };
            },
        );
        if (shardResult.status !== 'ok') {
            return { status: 'incompatible', rootPath, reason: shardResult.reason };
        }
    } catch (error) {
        return {
            status: error instanceof SyntaxError
                ? 'corrupt'
                : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
    return { status: 'ok', rootPath, analysisByFile };
}
