import { canonicalizeRepositoryRelativePath } from '../paths/repository-path';
import { compareContractStrings } from '../utils/compare-contract-strings';

export interface SnapshotFileStatSignature {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

export interface PublicationSourceCheckpoint {
    version: 1;
    canonicalRoot: string;
    fileHashes: [string, string][];
    fileStats: [string, SnapshotFileStatSignature][];
    unprocessedPaths: string[];
}

export interface PublicationSourceCheckpointState {
    fileHashes: ReadonlyMap<string, string>;
    fileStats: ReadonlyMap<string, SnapshotFileStatSignature>;
    unprocessedPaths: readonly string[];
}

export const SOURCE_CHECKPOINT_VERSION = 1;

function normalizeRelPath(canonicalRoot: string, candidatePath: string): string {
    return canonicalizeRepositoryRelativePath(canonicalRoot, candidatePath) ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort(compareContractStrings);
    const expected = [...keys].sort(compareContractStrings);
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function parseFileHashes(value: unknown, canonicalRoot: string): Map<string, string> {
    if (!Array.isArray(value)) {
        throw new Error('[Synchronizer] Invalid publication source checkpoint: fileHashes must be an array.');
    }
    const hashes = new Map<string, string>();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
            throw new Error('[Synchronizer] Invalid publication source checkpoint: fileHashes contains a malformed entry.');
        }
        const normalizedPath = normalizeRelPath(canonicalRoot, entry[0]);
        if (!normalizedPath || normalizedPath !== entry[0] || hashes.has(normalizedPath)) {
            throw new Error(`[Synchronizer] Invalid publication source checkpoint path '${entry[0]}'.`);
        }
        if (!/^[a-f0-9]{64}$/.test(entry[1])) {
            throw new Error(`[Synchronizer] Invalid publication source hash for '${normalizedPath}'.`);
        }
        hashes.set(normalizedPath, entry[1]);
    }
    return hashes;
}

function parseFileStats(value: unknown, canonicalRoot: string): Map<string, SnapshotFileStatSignature> {
    if (!Array.isArray(value)) {
        throw new Error('[Synchronizer] Invalid publication source checkpoint: fileStats must be an array.');
    }
    const stats = new Map<string, SnapshotFileStatSignature>();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !isRecord(entry[1])) {
            throw new Error('[Synchronizer] Invalid publication source checkpoint: fileStats contains a malformed entry.');
        }
        const normalizedPath = normalizeRelPath(canonicalRoot, entry[0]);
        if (!normalizedPath || normalizedPath !== entry[0] || stats.has(normalizedPath)) {
            throw new Error(`[Synchronizer] Invalid publication source checkpoint stat path '${entry[0]}'.`);
        }
        const signature = entry[1];
        if (
            !Number.isSafeInteger(signature.size)
            || Number(signature.size) < 0
            || !Number.isFinite(signature.mtimeMs)
            || !Number.isFinite(signature.ctimeMs)
        ) {
            throw new Error(`[Synchronizer] Invalid publication source stat for '${normalizedPath}'.`);
        }
        stats.set(normalizedPath, {
            size: Number(signature.size),
            mtimeMs: Number(signature.mtimeMs),
            ctimeMs: Number(signature.ctimeMs),
        });
    }
    return stats;
}

export function buildPublicationSourceCheckpoint(
    canonicalRoot: string,
    state: PublicationSourceCheckpointState,
): PublicationSourceCheckpoint {
    const fileHashes = Array.from(state.fileHashes.entries())
        .sort(([left], [right]) => compareContractStrings(left, right));
    const fileStats = Array.from(state.fileStats.entries())
        .sort(([left], [right]) => compareContractStrings(left, right));
    if (
        fileHashes.length !== fileStats.length
        || fileHashes.some(([filePath], index) => fileStats[index]?.[0] !== filePath)
    ) {
        throw new Error('[Synchronizer] Publication source hashes/stats must cover the same file set.');
    }
    const unprocessedPaths = Array.from(new Set(state.unprocessedPaths.map((candidatePath) => {
        const normalizedPath = normalizeRelPath(canonicalRoot, candidatePath);
        if (!normalizedPath || normalizedPath !== candidatePath) {
            throw new Error(`[Synchronizer] Invalid unprocessed publication source path '${candidatePath}'.`);
        }
        return normalizedPath;
    }))).sort(compareContractStrings);
    if (unprocessedPaths.some((filePath) => state.fileHashes.has(filePath))) {
        throw new Error('[Synchronizer] Publication source paths cannot be both processed and unprocessed.');
    }
    const checkpoint: PublicationSourceCheckpoint = {
        version: SOURCE_CHECKPOINT_VERSION,
        canonicalRoot,
        fileHashes,
        fileStats,
        unprocessedPaths,
    };
    return parsePublicationSourceCheckpoint(JSON.stringify(checkpoint), canonicalRoot);
}

export function parsePublicationSourceCheckpoint(
    data: string,
    expectedCanonicalRoot: string,
): PublicationSourceCheckpoint {
    const parsed: unknown = JSON.parse(data);
    if (
        !isRecord(parsed)
        || !hasExactKeys(parsed, ['version', 'canonicalRoot', 'fileHashes', 'fileStats', 'unprocessedPaths'])
        || parsed.version !== SOURCE_CHECKPOINT_VERSION
        || parsed.canonicalRoot !== expectedCanonicalRoot
        || !Array.isArray(parsed.unprocessedPaths)
    ) {
        throw new Error('[Synchronizer] Invalid or unsupported publication source checkpoint.');
    }
    const hashes = parseFileHashes(parsed.fileHashes, expectedCanonicalRoot);
    const stats = parseFileStats(parsed.fileStats, expectedCanonicalRoot);
    if (hashes.size !== stats.size || [...hashes.keys()].some((filePath) => !stats.has(filePath))) {
        throw new Error('[Synchronizer] Publication source hashes/stats must contain identical path sets.');
    }
    const unprocessedPaths = Array.from(new Set(parsed.unprocessedPaths.map((candidatePath) => {
        if (typeof candidatePath !== 'string') {
            throw new Error('[Synchronizer] Publication source unprocessedPaths contains a malformed entry.');
        }
        const normalizedPath = normalizeRelPath(expectedCanonicalRoot, candidatePath);
        if (!normalizedPath || normalizedPath !== candidatePath) {
            throw new Error(`[Synchronizer] Invalid unprocessed publication source path '${candidatePath}'.`);
        }
        return normalizedPath;
    }))).sort(compareContractStrings);
    if (unprocessedPaths.length !== parsed.unprocessedPaths.length) {
        throw new Error('[Synchronizer] Publication source unprocessedPaths contains duplicates.');
    }
    if (unprocessedPaths.some((filePath) => hashes.has(filePath))) {
        throw new Error('[Synchronizer] Publication source paths cannot be both processed and unprocessed.');
    }
    return {
        version: SOURCE_CHECKPOINT_VERSION,
        canonicalRoot: expectedCanonicalRoot,
        fileHashes: Array.from(hashes.entries()).sort(([left], [right]) => compareContractStrings(left, right)),
        fileStats: Array.from(stats.entries()).sort(([left], [right]) => compareContractStrings(left, right)),
        unprocessedPaths,
    };
}

export function publicationSourceCheckpointState(
    checkpoint: PublicationSourceCheckpoint,
): PublicationSourceCheckpointState {
    const validated = parsePublicationSourceCheckpoint(JSON.stringify(checkpoint), checkpoint.canonicalRoot);
    return {
        fileHashes: new Map(validated.fileHashes),
        fileStats: new Map(validated.fileStats),
        unprocessedPaths: [...validated.unprocessedPaths],
    };
}
