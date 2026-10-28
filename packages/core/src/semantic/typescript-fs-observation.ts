import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';

import {
    readTypeScriptFileBytes,
    TYPESCRIPT_METADATA_FILE_BYTES, TYPESCRIPT_METADATA_TOTAL_BYTES,
} from './typescript-bounded-reader';
import { TypeScriptSourceBudgetTracker, type TypeScriptSourceBudget } from './typescript-configured-project';

/** What the compiler learned about a path it asked about. */
export type TypeScriptFsObservationKind = 'missing' | 'file' | 'directory' | 'other';

/** Which budget admitted a read: a program source or package metadata. */
export type TypeScriptFsObservationRole = 'source' | 'metadata';

/**
 * Every filesystem answer a declaration computation received, kept in the form
 * the compiler consumed it.
 *
 * `probes`, `realpaths` and `listings` must match exactly: they decide which
 * modules resolve. `reads` keeps every admitted file with the budget that
 * admitted it, and `readDigest` pins the exact contents the computation saw.
 * Contents matter because an edit can add an import or a triple-slash
 * reference, which changes the set of files a fresh computation would read and
 * admit. Without the digest a saved success could outlive a resource failure.
 */
export interface TypeScriptFsObservation {
    readonly probes: readonly (readonly [path: string, kind: TypeScriptFsObservationKind])[];
    readonly realpaths: readonly (readonly [path: string, target: string])[];
    readonly reads: readonly (readonly [path: string, role: TypeScriptFsObservationRole])[];
    readonly readDigest: string;
    readonly listings: readonly (readonly [directory: string, names: readonly string[]])[];
}

/** Largest number of probed, resolved and read paths a witness may keep. */
export const MAX_TYPESCRIPT_FS_OBSERVATION_PATHS = 20_000;

/** Largest number of listed directories a witness may keep. */
export const MAX_TYPESCRIPT_FS_OBSERVATION_LISTINGS = 2_000;

const OBSERVATION_KINDS: readonly string[] = ['missing', 'file', 'directory', 'other'];
const OBSERVATION_ROLES: readonly string[] = ['source', 'metadata'];

function pathKind(fileName: string): TypeScriptFsObservationKind {
    try {
        const stat = fs.statSync(fileName, { throwIfNoEntry: false });
        if (!stat) return 'missing';
        if (stat.isFile()) return 'file';
        return stat.isDirectory() ? 'directory' : 'other';
    } catch {
        return 'missing';
    }
}

function realpathTarget(fileName: string): string {
    try {
        return fs.realpathSync(fileName);
    } catch {
        return '';
    }
}

function directoryNames(directoryName: string): readonly string[] {
    try {
        return fs.readdirSync(directoryName).sort();
    } catch {
        return [];
    }
}

/**
 * Frames one read so the aggregate digest binds its path and its content
 * without ambiguity. The path length is decimal and the content digest is a
 * fixed 64 hex characters, so two different read sets cannot share a stream.
 */
function updateReadDigest(hash: Hash, fileName: string, contentDigest: string): void {
    const pathBytes = Buffer.from(fileName, 'utf8');
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    hash.update(contentDigest);
}

/**
 * Collects filesystem answers when callbacks return them. Capture never
 * replaces those answers with filesystem state from after the computation.
 */
export class TypeScriptFsObservationRecorder {
    private readonly probes = new Map<string, TypeScriptFsObservationKind>();
    private readonly realpaths = new Map<string, string>();
    private readonly readDigests = new Map<string, string>();
    private readonly sourceReads = new Set<string>();
    private readonly listings = new Map<string, readonly string[]>();
    private inconsistent = false;

    /** Returns the same path kind that the callback must use for its answer. */
    recordPath(fileName: string): TypeScriptFsObservationKind {
        const kind = pathKind(fileName);
        const previous = this.probes.get(fileName);
        if (previous !== undefined && previous !== kind) this.invalidate();
        this.probes.set(fileName, kind);
        return kind;
    }

    recordRealpath(fileName: string): string {
        const target = realpathTarget(fileName);
        const previous = this.realpaths.get(fileName);
        if (!target || previous !== undefined && previous !== target) this.invalidate();
        this.realpaths.set(fileName, target);
        return target;
    }

    /** Native answers that cannot be observed must never create a reusable proof. */
    invalidate(): void { this.inconsistent = true; }

    /** Records the exact bytes the compiler consumed for one read. */
    recordRead(fileName: string, content: string | Buffer): void {
        const digest = createHash('sha256').update(content).digest('hex');
        const previous = this.readDigests.get(fileName);
        if (previous !== undefined && previous !== digest) this.invalidate();
        this.readDigests.set(fileName, digest);
    }

    /** Marks a read that the source budget admitted, as opposed to metadata. */
    recordSourceRead(fileName: string): void { this.sourceReads.add(fileName); }

    recordListing(directoryName: string): void {
        const names = directoryNames(directoryName);
        const previous = this.listings.get(directoryName);
        if (previous && (previous.length !== names.length || previous.some((name, index) => name !== names[index]))) this.invalidate();
        this.listings.set(directoryName, names);
    }

    /** Refuses inconsistent computations and observations beyond the witness bounds. */
    capture(): TypeScriptFsObservation | undefined {
        if (this.inconsistent) return undefined;
        if (this.probes.size + this.realpaths.size + this.readDigests.size > MAX_TYPESCRIPT_FS_OBSERVATION_PATHS) return undefined;
        if (this.listings.size > MAX_TYPESCRIPT_FS_OBSERVATION_LISTINGS) return undefined;
        const digest = createHash('sha256');
        const reads = [...this.readDigests.keys()].sort().map((fileName) => {
            updateReadDigest(digest, fileName, this.readDigests.get(fileName)!);
            return [fileName, this.sourceReads.has(fileName) ? 'source' : 'metadata'] as const;
        });
        return {
            probes: [...this.probes].sort(([left], [right]) => left.localeCompare(right)),
            realpaths: [...this.realpaths].sort(([left], [right]) => left.localeCompare(right)),
            reads,
            readDigest: digest.digest('hex'),
            listings: [...this.listings].sort(([left], [right]) => left.localeCompare(right)),
        };
    }
}

/**
 * Reports whether a fresh computation would receive the same answers, admit the
 * same reads under the same budgets, and read the same contents.
 *
 * `budget` is required: only it can re-establish today's admission with current
 * sizes, so an observation without one cannot prove a reusable success. The
 * read digest covers every file the computation consumed, because changed
 * contents can add imports or references and with them new reads and new
 * resource failures.
 */
export function verifyTypeScriptFsObservation(
    observation: TypeScriptFsObservation,
    budget: TypeScriptSourceBudget,
): boolean {
    for (const [fileName, kind] of observation.probes) {
        if (pathKind(fileName) !== kind) return false;
    }
    for (const [fileName, target] of observation.realpaths) {
        if (realpathTarget(fileName) !== target) return false;
    }
    for (const [directoryName, names] of observation.listings) {
        const current = directoryNames(directoryName);
        if (current.length !== names.length) return false;
        for (let index = 0; index < names.length; index += 1) {
            if (current[index] !== names[index]) return false;
        }
    }
    const sources = new TypeScriptSourceBudgetTracker(budget);
    const metadata = new TypeScriptSourceBudgetTracker({
        maxFileBytes: Math.max(budget.maxFileBytes, TYPESCRIPT_METADATA_FILE_BYTES),
        maxProjectBytes: budget.maxProjectBytes + TYPESCRIPT_METADATA_TOTAL_BYTES,
    });
    const digest = createHash('sha256');
    for (const [fileName, role] of observation.reads) {
        let bytes: number;
        try {
            const stat = fs.statSync(fileName, { throwIfNoEntry: false });
            if (!stat?.isFile()) return false;
            bytes = stat.size;
        } catch {
            return false;
        }
        // JSON transport is bounded independently of the source quota, exactly
        // as the native session bounds it. A JSON program input is charged to
        // both: the transport budget admits the read and the source budget
        // admits the file the program contains.
        if (fileName.toLowerCase().endsWith('.json') && !metadata.admit(fileName, bytes)) return false;
        if (role === 'source' && !sources.admit(fileName, bytes)) return false;
        let content: Buffer;
        try {
            // The bound is the size just admitted, so a file that grows between
            // the stat and the read is refused instead of allocated unbounded.
            content = readTypeScriptFileBytes(fileName, bytes);
        } catch {
            return false;
        }
        updateReadDigest(digest, fileName, createHash('sha256').update(content).digest('hex'));
    }
    return digest.digest('hex') === observation.readDigest;
}

function isPathPairs(value: unknown, valid: (item: unknown) => boolean): boolean {
    if (!Array.isArray(value)) return false;
    for (const item of value) {
        if (!Array.isArray(item) || item.length !== 2) return false;
        if (typeof item[0] !== 'string' || !valid(item[1])) return false;
    }
    return true;
}

function isReadPairs(value: unknown): boolean {
    return isPathPairs(value, role => typeof role === 'string' && OBSERVATION_ROLES.includes(role));
}

/** Validates a saved witness before any of its paths is used. */
export function isTypeScriptFsObservation(value: unknown): value is TypeScriptFsObservation {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    if (!isPathPairs(candidate.probes, kind => typeof kind === 'string' && OBSERVATION_KINDS.includes(kind))) return false;
    if (!isPathPairs(candidate.realpaths, target => typeof target === 'string')) return false;
    if (!isReadPairs(candidate.reads)) return false;
    if (typeof candidate.readDigest !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.readDigest)) return false;
    if (!isPathPairs(candidate.listings, names => Array.isArray(names) && names.every(name => typeof name === 'string'))) return false;
    const probes = candidate.probes as unknown[];
    const realpaths = candidate.realpaths as unknown[];
    const reads = candidate.reads as unknown[];
    if (probes.length + realpaths.length + reads.length > MAX_TYPESCRIPT_FS_OBSERVATION_PATHS) return false;
    return (candidate.listings as unknown[]).length <= MAX_TYPESCRIPT_FS_OBSERVATION_LISTINGS;
}
