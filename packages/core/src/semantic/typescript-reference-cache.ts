import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readTypeScriptFileBytes, TypeScriptReadLimitError } from './typescript-bounded-reader';
import type { TypeScriptSourceBudget } from './typescript-configured-project';
import {
    isTypeScriptFsObservation, verifyTypeScriptFsObservation,
    type TypeScriptFsObservation,
} from './typescript-fs-observation';

export interface TypeScriptReferenceDeclarationState {
    readonly outputs: readonly string[];
    readonly references: readonly string[];
    readonly unproven: boolean;
    readonly resourceFailure?: string;
}

/** Version of the saved reference-metadata document. */
export const REFERENCE_DECLARATION_FORMAT = 2;

/** Default number of retained reference proofs. */
export const DEFAULT_REFERENCE_CACHE_ENTRIES = 128;

/** Default retained bytes of reference proofs. */
export const DEFAULT_REFERENCE_CACHE_BYTES = 4 * 1024 * 1024;

/**
 * Bound applied to the saved document before it is parsed. One record holds the
 * declaration proof of every referenced project of one discovery root.
 */
export const REFERENCE_DECLARATION_METADATA_BYTES = 16 * 1024 * 1024;

/** Identifies the compiler and provider that produced a saved proof. */
export interface TypeScriptReferenceCacheWitness {
    readonly providerVersion: string;
    readonly compilerVersion: string;
}

interface CacheEntry {
    readonly fingerprint: string;
    readonly state: TypeScriptReferenceDeclarationState;
    readonly observation?: TypeScriptFsObservation;
    readonly bytes: number;
}

interface SavedEntry {
    readonly configPath: string;
    readonly fingerprint: string;
    readonly outputs: readonly string[];
    readonly references: readonly string[];
    readonly observation: TypeScriptFsObservation;
}

/**
 * Retains only bounded reference proofs for the analyzer that owns it.
 *
 * A proof is reusable only when its fingerprint matches and every filesystem
 * fact its computation observed still holds, so a hit cannot hide a resource
 * admission failure that a fresh computation would report. Proofs without an
 * observation stay memory-only: nothing can prove them later.
 *
 * With `options.stateDirectory` the cache also saves its proven entries for one
 * discovery root and loads them once per discovery. The saved document is a
 * best-effort cache: any unreadable, oversized, malformed or foreign-version
 * document is treated as empty.
 */
export class TypeScriptReferenceDeclarationCache {
    private readonly entries = new Map<string, CacheEntry>();
    private retainedBytes = 0;
    private savedTarget?: { readonly filePath: string; readonly witness: string };
    private dirty = false;

    constructor(
        private readonly maxEntries = DEFAULT_REFERENCE_CACHE_ENTRIES,
        private readonly maxBytes = DEFAULT_REFERENCE_CACHE_BYTES,
        private readonly options: {
            readonly stateDirectory?: string;
            /** Re-establishes admission when a saved proof is reused. */
            readonly resourceBudget?: TypeScriptSourceBudget;
        } = {},
    ) {}

    get size(): number { return this.entries.size; }
    get bytes(): number { return this.retainedBytes; }

    get(configPath: string, fingerprint: string): TypeScriptReferenceDeclarationState | undefined {
        const entry = this.entries.get(configPath);
        if (!entry) return undefined;
        this.remove(configPath);
        if (entry.fingerprint !== fingerprint) return undefined;
        // Admission and content checks need today's budget. Without one the
        // proof cannot be re-established, so a proven observation is not reused.
        if (!entry.state.unproven && entry.observation && (!this.options.resourceBudget
            || !verifyTypeScriptFsObservation(entry.observation, this.options.resourceBudget))) return undefined;
        this.entries.set(configPath, entry);
        this.retainedBytes += entry.bytes;
        return entry.state;
    }

    set(
        configPath: string,
        fingerprint: string,
        state: TypeScriptReferenceDeclarationState,
        observation?: TypeScriptFsObservation,
    ): void {
        this.store(configPath, fingerprint, state, observation, true);
    }

    /**
     * Loads the saved proofs of one discovery root. Called once per discovery,
     * before any project lookup, so no project pays for the read.
     */
    load(rootPath: string, witness: TypeScriptReferenceCacheWitness): void {
        this.savedTarget = undefined;
        this.dirty = false;
        const stateDirectory = this.options.stateDirectory;
        if (!stateDirectory) return;
        const normalizedRoot = normalizePath(rootPath);
        const witnessHash = savedWitness(witness, normalizedRoot);
        const filePath = referenceMetadataPath(stateDirectory, normalizedRoot);
        this.savedTarget = { filePath, witness: witnessHash };
        let document: Buffer;
        try {
            document = readTypeScriptFileBytes(filePath, REFERENCE_DECLARATION_METADATA_BYTES);
        } catch (error) {
            // An oversized or unreadable document is replaced by the next
            // complete snapshot; anything else leaves it untouched.
            if (error instanceof TypeScriptReadLimitError) this.dirty = true;
            return;
        }
        for (const entry of parseSavedDocument(document, witnessHash)) {
            this.store(entry.configPath, entry.fingerprint, {
                outputs: entry.outputs,
                references: entry.references,
                unproven: false,
            }, entry.observation, false);
        }
    }

    /**
     * Saves one complete snapshot of the proven entries. Concurrent writers may
     * overwrite each other: the last complete snapshot wins and every reader
     * still validates each entry, so a lost update only costs a future miss.
     */
    flush(): void {
        if (!this.savedTarget || !this.dirty) return;
        const payload = this.snapshotDocument();
        if (payload === undefined) return;
        const { filePath } = this.savedTarget;
        const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(temporary, payload, 'utf8');
            fs.renameSync(temporary, filePath);
            this.dirty = false;
        } catch (error) {
            try {
                fs.rmSync(temporary, { force: true });
            } catch {
                // The temporary file is already gone.
            }
            console.warn(`Satori: could not save TypeScript reference metadata (${error instanceof Error ? error.message : String(error)}).`);
        }
    }

    clear(): void {
        this.entries.clear();
        this.retainedBytes = 0;
        this.savedTarget = undefined;
        this.dirty = false;
    }

    private store(
        configPath: string,
        fingerprint: string,
        state: TypeScriptReferenceDeclarationState,
        observation: TypeScriptFsObservation | undefined,
        dirty: boolean,
    ): void {
        this.remove(configPath);
        // Count incrementally so rejecting an oversized proof does not first
        // allocate an unbounded serialized copy of it.
        let bytes = 128 + Buffer.byteLength(configPath, 'utf8') + Buffer.byteLength(fingerprint, 'utf8');
        for (const paths of [state.outputs, state.references]) {
            for (const file of paths) {
                bytes += 32 + Buffer.byteLength(file, 'utf8');
                if (bytes > this.maxBytes) return;
            }
        }
        if (observation) {
            bytes += observationBytes(observation);
            if (bytes > this.maxBytes) return;
        }
        if (bytes > this.maxBytes || this.maxEntries < 1) return;
        while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBytes) {
            this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(configPath, { fingerprint, state, observation, bytes });
        this.retainedBytes += bytes;
        // Only a proven entry with an observation can be saved, so only that
        // kind of write marks the snapshot dirty.
        if (dirty && observation) this.dirty = true;
    }

    private snapshotDocument(): string | undefined {
        const entries: SavedEntry[] = [];
        for (const [configPath, entry] of [...this.entries].sort(([left], [right]) => left.localeCompare(right))) {
            if (!entry.observation || entry.state.unproven || entry.state.resourceFailure) continue;
            entries.push({
                configPath,
                fingerprint: entry.fingerprint,
                outputs: [...entry.state.outputs],
                references: [...entry.state.references],
                observation: entry.observation,
            });
        }
        if (entries.length === 0) return undefined;
        const payload = JSON.stringify({
            format: REFERENCE_DECLARATION_FORMAT,
            witness: this.savedTarget!.witness,
            entries,
        });
        if (Buffer.byteLength(payload, 'utf8') > REFERENCE_DECLARATION_METADATA_BYTES) return undefined;
        return payload;
    }

    private remove(configPath: string): void {
        const entry = this.entries.get(configPath);
        if (!entry) return;
        this.entries.delete(configPath);
        this.retainedBytes -= entry.bytes;
    }
}

function normalizePath(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/');
}

function referenceMetadataPath(stateDirectory: string, normalizedRoot: string): string {
    const name = createHash('sha256').update(normalizedRoot).digest('hex');
    return path.join(stateDirectory, `${name}.reference-declarations.json`);
}

function savedWitness(witness: TypeScriptReferenceCacheWitness, normalizedRoot: string): string {
    return createHash('sha256').update(JSON.stringify({
        format: REFERENCE_DECLARATION_FORMAT,
        providerVersion: witness.providerVersion,
        compilerVersion: witness.compilerVersion,
        rootPath: normalizedRoot,
    })).digest('hex');
}

function observationBytes(observation: TypeScriptFsObservation): number {
    let bytes = 128;
    for (const [fileName] of observation.probes) {
        bytes += 48 + Buffer.byteLength(fileName, 'utf8');
    }
    for (const [fileName, target] of observation.realpaths) {
        bytes += 48 + Buffer.byteLength(fileName, 'utf8') + Buffer.byteLength(target, 'utf8');
    }
    for (const [fileName] of observation.reads) {
        bytes += 40 + Buffer.byteLength(fileName, 'utf8');
    }
    for (const [directoryName, names] of observation.listings) {
        bytes += 48 + Buffer.byteLength(directoryName, 'utf8');
        for (const name of names) bytes += 8 + Buffer.byteLength(name, 'utf8');
    }
    return bytes;
}

function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return undefined;
        items.push(item);
    }
    return items;
}

function savedEntry(value: unknown): SavedEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.configPath !== 'string' || candidate.configPath === '') return undefined;
    if (typeof candidate.fingerprint !== 'string' || candidate.fingerprint === '') return undefined;
    const outputs = stringArray(candidate.outputs);
    const references = stringArray(candidate.references);
    if (!outputs || !references) return undefined;
    if (!isTypeScriptFsObservation(candidate.observation)) return undefined;
    return {
        configPath: candidate.configPath,
        fingerprint: candidate.fingerprint,
        outputs,
        references,
        observation: candidate.observation,
    };
}

function parseSavedDocument(document: Buffer, witness: string): SavedEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(document.toString('utf8'));
    } catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const candidate = parsed as { format?: unknown; witness?: unknown; entries?: unknown };
    if (candidate.format !== REFERENCE_DECLARATION_FORMAT) return [];
    if (candidate.witness !== witness) return [];
    if (!Array.isArray(candidate.entries)) return [];
    const entries: SavedEntry[] = [];
    for (const value of candidate.entries) {
        const entry = savedEntry(value);
        if (entry) entries.push(entry);
    }
    return entries;
}
