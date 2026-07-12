type PreparedReadCacheEntry<T> = {
    state: T;
    observation: string;
    lastUsedAtMs: number;
};

export class PreparedReadCache<T> {
    private readonly entries = new Map<string, PreparedReadCacheEntry<T>>();

    constructor(
        private readonly maxRoots = 32,
        private readonly idleMs = 15 * 60_000,
    ) {}

    public get(
        absolutePath: string,
        nowMs: number,
        isWithinRoot: (targetPath: string, root: string) => boolean,
        observe: (root: string) => string | null,
    ): T | null {
        for (const [root, entry] of this.entries) {
            if (nowMs - entry.lastUsedAtMs > this.idleMs) {
                this.entries.delete(root);
            }
        }

        const match = [...this.entries.entries()]
            .filter(([root]) => isWithinRoot(absolutePath, root))
            .sort(([leftRoot], [rightRoot]) => rightRoot.length - leftRoot.length)[0];
        if (!match) return null;

        const [root, entry] = match;
        const current = observe(root);
        if (!current || current !== entry.observation) {
            this.entries.delete(root);
            return null;
        }
        entry.lastUsedAtMs = nowMs;
        this.entries.delete(root);
        this.entries.set(root, entry);
        return structuredClone(entry.state);
    }

    public seed(root: string, state: T, observation: string | null, nowMs: number): void {
        if (!observation) return;
        this.entries.delete(root);
        this.entries.set(root, { state: structuredClone(state), observation, lastUsedAtMs: nowMs });
        while (this.entries.size > this.maxRoots) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (!oldest) break;
            this.entries.delete(oldest);
        }
    }

    public evict(root: string): void {
        this.entries.delete(root);
    }

    public get size(): number {
        return this.entries.size;
    }
}
