type PreparedReadCacheEntry<T> = {
    state: T;
    observation: string;
    seededAtMs: number;
    lastUsedAtMs: number;
};

export type PreparedReadCacheMissReason = "cache_miss" | "idle_expired" | "proof_expired";

export type PreparedReadCacheLookup<T> =
    | {
        status: "hit";
        root: string;
        state: T;
        observation: string;
    }
    | {
        status: "miss";
        reason: PreparedReadCacheMissReason;
    };

const DEFAULT_PREPARED_READ_IDLE_MS = 15 * 60_000;
const DEFAULT_PREPARED_PROOF_MAX_AGE_MS = 30 * 60_000;

export class PreparedReadCache<T> {
    private readonly entries = new Map<string, PreparedReadCacheEntry<T>>();

    constructor(
        private readonly maxRoots = 32,
        private readonly idleMs = DEFAULT_PREPARED_READ_IDLE_MS,
        // Warm revalidation deliberately skips an exact payload recount. Bound that
        // optimization independently of access frequency so active roots periodically
        // return to the full authority proof.
        private readonly maxProofAgeMs = DEFAULT_PREPARED_PROOF_MAX_AGE_MS,
    ) {}

    public get(
        absolutePath: string,
        nowMs: number,
        isWithinRoot: (targetPath: string, root: string) => boolean,
        observe: (root: string) => string | null,
    ): T | null {
        const candidate = this.getCandidate(absolutePath, nowMs, isWithinRoot);
        if (!candidate) return null;
        const current = observe(candidate.root);
        if (!current || current !== candidate.observation) {
            this.entries.delete(candidate.root);
            return null;
        }
        return candidate.state;
    }

    public getCandidate(
        absolutePath: string,
        nowMs: number,
        isWithinRoot: (targetPath: string, root: string) => boolean,
    ): { root: string; state: T; observation: string } | null {
        const lookup = this.lookupCandidate(absolutePath, nowMs, isWithinRoot);
        return lookup.status === "hit"
            ? {
                root: lookup.root,
                state: lookup.state,
                observation: lookup.observation,
            }
            : null;
    }

    public lookupCandidate(
        absolutePath: string,
        nowMs: number,
        isWithinRoot: (targetPath: string, root: string) => boolean,
    ): PreparedReadCacheLookup<T> {
        const matches = [...this.entries.entries()]
            .filter(([root]) => isWithinRoot(absolutePath, root))
            .sort(([leftRoot], [rightRoot]) => rightRoot.length - leftRoot.length);
        const match = matches[0];

        for (const [root, entry] of this.entries) {
            if (
                root !== match?.[0]
                && (
                    nowMs - entry.seededAtMs >= this.maxProofAgeMs
                    || nowMs - entry.lastUsedAtMs > this.idleMs
                )
            ) {
                this.entries.delete(root);
            }
        }

        if (!match) return { status: "miss", reason: "cache_miss" };

        const [root, entry] = match;
        if (nowMs - entry.seededAtMs >= this.maxProofAgeMs) {
            this.entries.delete(root);
            return { status: "miss", reason: "proof_expired" };
        }
        if (nowMs - entry.lastUsedAtMs > this.idleMs) {
            this.entries.delete(root);
            return { status: "miss", reason: "idle_expired" };
        }
        entry.lastUsedAtMs = nowMs;
        this.entries.delete(root);
        this.entries.set(root, entry);
        return {
            status: "hit",
            root,
            state: structuredClone(entry.state),
            observation: entry.observation,
        };
    }

    public seed(
        root: string,
        state: T,
        observation: string | null,
        nowMs: number,
        preserveProofAge = false,
    ): void {
        if (!observation) return;
        const existing = this.entries.get(root);
        const seededAtMs = existing && preserveProofAge
            ? existing.seededAtMs
            : nowMs;
        this.entries.delete(root);
        this.entries.set(root, {
            state: structuredClone(state),
            observation,
            seededAtMs,
            lastUsedAtMs: nowMs,
        });
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
