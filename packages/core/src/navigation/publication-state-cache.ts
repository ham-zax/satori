export interface PublicationStateCacheOptions {
    /** Maximum number of codebase roots whose state stays resident. */
    maxRoots: number;
    /** Resident state is released after this long without an access. 0 disables idle release. */
    idleMs: number;
    /** Optional reduced root cap applied when available host memory falls below `lowMemoryThresholdBytes`. */
    maxRootsUnderPressure?: number;
    /** Available memory threshold below which `maxRootsUnderPressure` applies. 0 disables pressure trimming. */
    lowMemoryThresholdBytes?: number;
    /** Memory availability probe (defaults to `process.availableMemory()`). */
    availableMemoryBytes?: () => number;
}

type Entry<T> = {
    identity: string;
    value: Promise<T>;
    timer?: ReturnType<typeof setTimeout>;
    retained?: { value: T; release?: () => void };
};

/**
 * Holds at most one immutable Publication state per codebase root.
 *
 * - A newer identity for a root replaces the older one, so superseded
 *   Publications are released instead of accumulating.
 * - Concurrent readers share one in-flight load; failed loads are dropped so
 *   they can be retried, and a stale load can never replace a newer entry.
 * - Roots are evicted least-recently-used beyond `maxRoots`, and every entry is
 *   released after `idleMs` without access.
 */
export class PublicationStateCache<T> {
    private readonly entries = new Map<string, Entry<T>>();

    public constructor(private readonly options: PublicationStateCacheOptions) {}

    public get(
        root: string,
        identity: string,
        load: (previous: T | undefined) => Promise<T>,
        isRetainable: (value: T) => boolean,
        onRetain?: (value: T) => (() => void) | undefined,
    ): Promise<T> {
        const existing = this.entries.get(root);
        if (existing?.identity === identity) {
            this.touch(root, existing);
            return existing.value;
        }
        // A replacement can synchronously borrow reusable data before the old
        // entry's release callback drops its references.
        const value = load(existing?.retained?.value);
        if (existing) this.release(root, existing);

        const entry: Entry<T> = { identity, value };
        this.touch(root, entry);
        const evict = () => {
            if (this.entries.get(root) === entry) this.release(root, entry);
        };
        entry.value.then((value) => {
            if (this.entries.get(root) !== entry) return;
            if (!isRetainable(value)) {
                evict();
                return;
            }
            entry.retained = { value, release: onRetain?.(value) };
        }, evict);
        while (this.entries.size > this.effectiveMaxRoots()) {
            const oldestRoot = this.entries.keys().next().value as string;
            this.release(oldestRoot, this.entries.get(oldestRoot)!);
        }
        return entry.value;
    }

    private effectiveMaxRoots(): number {
        const baseCap = Math.max(1, this.options.maxRoots);
        const threshold = this.options.lowMemoryThresholdBytes ?? 0;
        const pressureCap = this.options.maxRootsUnderPressure;
        if (threshold <= 0 || pressureCap === undefined || pressureCap >= baseCap) {
            return baseCap;
        }
        const probe = this.options.availableMemoryBytes
            ?? (() => (typeof process.availableMemory === 'function' ? process.availableMemory() : Number.POSITIVE_INFINITY));
        const available = probe();
        return Number.isFinite(available) && available < threshold
            ? Math.max(1, pressureCap)
            : baseCap;
    }

    public has(root: string, identity: string): boolean {
        return this.entries.get(root)?.identity === identity;
    }

    public get size(): number {
        return this.entries.size;
    }

    private touch(root: string, entry: Entry<T>): void {
        this.entries.delete(root);
        this.entries.set(root, entry);
        if (this.options.idleMs <= 0) return;
        if (entry.timer) {
            entry.timer.refresh();
            return;
        }
        entry.timer = setTimeout(() => {
            if (this.entries.get(root) === entry) this.release(root, entry);
        }, this.options.idleMs);
        entry.timer.unref?.();
    }

    private release(root: string, entry: Entry<T>): void {
        if (entry.timer) clearTimeout(entry.timer);
        if (this.entries.get(root) === entry) this.entries.delete(root);
        entry.retained?.release?.();
        entry.retained = undefined;
    }
}
