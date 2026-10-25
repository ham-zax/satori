export interface TypeScriptReferenceDeclarationState {
    readonly outputs: readonly string[];
    readonly references: readonly string[];
    readonly unproven: boolean;
    readonly resourceFailure?: string;
}

interface CacheEntry {
    readonly fingerprint: string;
    readonly state: TypeScriptReferenceDeclarationState;
    readonly bytes: number;
}

/** Retains only bounded reference proofs for the analyzer that owns it. */
export class TypeScriptReferenceDeclarationCache {
    private readonly entries = new Map<string, CacheEntry>();
    private retainedBytes = 0;

    constructor(private readonly maxEntries = 128, private readonly maxBytes = 4 * 1024 * 1024) {}

    get size(): number { return this.entries.size; }
    get bytes(): number { return this.retainedBytes; }

    get(configPath: string, fingerprint: string): TypeScriptReferenceDeclarationState | undefined {
        const entry = this.entries.get(configPath);
        if (!entry) return undefined;
        this.remove(configPath);
        if (entry.fingerprint !== fingerprint) return undefined;
        this.entries.set(configPath, entry);
        this.retainedBytes += entry.bytes;
        return entry.state;
    }

    set(configPath: string, fingerprint: string, state: TypeScriptReferenceDeclarationState): void {
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
        if (bytes > this.maxBytes || this.maxEntries < 1) return;
        while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBytes) {
            this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(configPath, { fingerprint, state, bytes });
        this.retainedBytes += bytes;
    }

    clear(): void {
        this.entries.clear();
        this.retainedBytes = 0;
    }

    private remove(configPath: string): void {
        const entry = this.entries.get(configPath);
        if (!entry) return;
        this.entries.delete(configPath);
        this.retainedBytes -= entry.bytes;
    }
}
