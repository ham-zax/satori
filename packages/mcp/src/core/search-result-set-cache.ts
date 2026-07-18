import crypto from "node:crypto";

export type SearchResultSetLookup<T> =
    | {
        status: "hit";
        entry: Readonly<T>;
        nextOffset: number;
        expiresAtMs: number;
        lastPage: Readonly<SearchResultSetReplay> | null;
    }
    | { status: "expired" }
    | { status: "not_found" };

export type SearchResultSetReplay = {
    expectedOffset: number;
    pageSize: number;
    responseText: string;
};

type OwnedSearchResultSet<T> = {
    ownerId: string;
    value: T;
};

export type SearchResultSetCoordinatorLookup<T, TOwner extends object> =
    | {
        status: "hit";
        owner: TOwner;
        entry: Readonly<T>;
        nextOffset: number;
        expiresAtMs: number;
        lastPage: Readonly<SearchResultSetReplay> | null;
    }
    | { status: "expired" }
    | { status: "not_found" }
    | { status: "owner_unavailable" };

type CacheEntry<T> = {
    value: T;
    nextOffset: number;
    expiresAtMs: number;
    valueBytes: number;
    replayBytes: number;
    lastPage: SearchResultSetReplay | null;
};

export class SearchResultSetCache<T> {
    private readonly entries = new Map<string, CacheEntry<T>>();
    private totalBytes = 0;

    constructor(
        private readonly maxEntries = 32,
        private readonly maxBytes = 16 * 1024 * 1024,
        private readonly ttlMs = 15 * 60_000,
    ) {
        if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
            throw new Error("Search result-set cache entry limit must be a positive safe integer.");
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
            throw new Error("Search result-set cache byte limit must be a positive safe integer.");
        }
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
            throw new Error("Search result-set cache TTL must be a positive safe integer.");
        }
    }

    public store(input: {
        value: T;
        nextOffset: number;
        nowMs: number;
    }): { handle: string; expiresAtMs: number } {
        const bytes = Buffer.byteLength(JSON.stringify(input.value), "utf8");
        if (bytes > this.maxBytes) {
            throw new Error("Search result set exceeds the cache byte budget.");
        }
        const handle = crypto.randomBytes(24).toString("hex");
        const expiresAtMs = input.nowMs + this.ttlMs;
        this.entries.set(handle, {
            value: structuredClone(input.value),
            nextOffset: Math.max(0, Math.floor(input.nextOffset)),
            expiresAtMs,
            valueBytes: bytes,
            replayBytes: 0,
            lastPage: null,
        });
        this.totalBytes += bytes;
        this.prune(input.nowMs);
        return { handle, expiresAtMs };
    }

    public lookup(handle: string, nowMs: number): SearchResultSetLookup<T> {
        const entry = this.entries.get(handle);
        if (!entry) return { status: "not_found" };
        if (nowMs >= entry.expiresAtMs) {
            this.delete(handle, entry);
            return { status: "expired" };
        }
        this.entries.delete(handle);
        this.entries.set(handle, entry);
        return {
            status: "hit",
            entry: structuredClone(entry.value),
            nextOffset: entry.nextOffset,
            expiresAtMs: entry.expiresAtMs,
            lastPage: entry.lastPage ? structuredClone(entry.lastPage) : null,
        };
    }

    public advance(input: {
        handle: string;
        expectedOffset: number;
        nextOffset: number;
        nowMs: number;
        replay: SearchResultSetReplay;
    }): "advanced" | "conflict" | "expired" | "not_found" | "too_large" {
        const entry = this.entries.get(input.handle);
        if (!entry) return "not_found";
        if (input.nowMs >= entry.expiresAtMs) {
            this.delete(input.handle, entry);
            return "expired";
        }
        if (entry.nextOffset !== input.expectedOffset) return "conflict";
        const replayBytes = Buffer.byteLength(input.replay.responseText, "utf8");
        if (entry.valueBytes + replayBytes > this.maxBytes) return "too_large";
        this.totalBytes += replayBytes - entry.replayBytes;
        entry.replayBytes = replayBytes;
        entry.lastPage = structuredClone(input.replay);
        entry.nextOffset = Math.max(entry.nextOffset, Math.floor(input.nextOffset));
        this.entries.delete(input.handle);
        this.entries.set(input.handle, entry);
        this.prune(input.nowMs);
        return "advanced";
    }

    public remove(handle: string): void {
        const entry = this.entries.get(handle);
        if (entry) this.delete(handle, entry);
    }

    private prune(nowMs: number): void {
        for (const [handle, entry] of this.entries) {
            if (nowMs >= entry.expiresAtMs) this.delete(handle, entry);
        }
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const oldest = this.entries.entries().next().value as [string, CacheEntry<T>] | undefined;
            if (!oldest) break;
            this.delete(oldest[0], oldest[1]);
        }
    }

    private delete(handle: string, entry: CacheEntry<T>): void {
        if (!this.entries.delete(handle)) return;
        this.totalBytes -= entry.valueBytes + entry.replayBytes;
    }
}

/**
 * Server-scoped ownership for continuation result sets. The cache entry owns
 * the routing identity, so eviction and expiry cannot leave a per-handle route
 * behind. Owner identities are generated internally and never derived from an
 * opaque client handle.
 */
export class SearchResultSetCoordinator<T, TOwner extends object> {
    private readonly cache: SearchResultSetCache<OwnedSearchResultSet<T>>;
    private readonly owners = new Map<string, TOwner>();
    private readonly ownerIds = new WeakMap<TOwner, string>();

    constructor(
        maxEntries = 32,
        maxBytes = 16 * 1024 * 1024,
        ttlMs = 15 * 60_000,
    ) {
        this.cache = new SearchResultSetCache(maxEntries, maxBytes, ttlMs);
    }

    public registerOwner(owner: TOwner): void {
        if (this.ownerIds.has(owner)) return;
        const ownerId = crypto.randomBytes(24).toString("hex");
        this.ownerIds.set(owner, ownerId);
        this.owners.set(ownerId, owner);
    }

    public unregisterOwner(owner: TOwner): void {
        const ownerId = this.ownerIds.get(owner);
        if (!ownerId) return;
        this.ownerIds.delete(owner);
        this.owners.delete(ownerId);
    }

    public store(owner: TOwner, input: {
        value: T;
        nextOffset: number;
        nowMs: number;
    }): { handle: string; expiresAtMs: number } {
        const ownerId = this.ownerIds.get(owner);
        if (!ownerId || this.owners.get(ownerId) !== owner) {
            throw new Error("Search continuation owner is not registered.");
        }
        return this.cache.store({
            value: { ownerId, value: input.value },
            nextOffset: input.nextOffset,
            nowMs: input.nowMs,
        });
    }

    public lookup(handle: string, nowMs: number): SearchResultSetCoordinatorLookup<T, TOwner> {
        const lookup = this.cache.lookup(handle, nowMs);
        if (lookup.status !== "hit") return lookup;
        const owner = this.owners.get(lookup.entry.ownerId);
        if (!owner) {
            this.cache.remove(handle);
            return { status: "owner_unavailable" };
        }
        return {
            status: "hit",
            owner,
            entry: lookup.entry.value,
            nextOffset: lookup.nextOffset,
            expiresAtMs: lookup.expiresAtMs,
            lastPage: lookup.lastPage,
        };
    }

    public advance(input: {
        handle: string;
        expectedOffset: number;
        nextOffset: number;
        nowMs: number;
        replay: SearchResultSetReplay;
    }): "advanced" | "conflict" | "expired" | "not_found" | "too_large" {
        return this.cache.advance(input);
    }

    public remove(handle: string): void {
        this.cache.remove(handle);
    }
}
