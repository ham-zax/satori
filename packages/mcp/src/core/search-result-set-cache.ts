import crypto from "node:crypto";
import { serializeCanonicalJson } from "./canonical-json.js";

export const MAX_RESULT_SET_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_RESULT_SET_CACHE_BYTES = 16 * 1024 * 1024;
export const MIN_RESIDENT_RESULT_SETS = 2;
export const MAX_RESULT_SET_CACHE_ENTRIES = 32;
export const RESULT_SET_TTL_MS = 15 * 60_000;

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

export type SearchResultSetStoreResult =
    | {
        status: "stored";
        handle: string;
        expiresAtMs: number;
        reservationBytes: number;
    }
    | {
        status: "not_admissible";
        reason: "entry_too_large";
        valueBytes: number;
        reservedReplayBytes: number;
        reservationBytes: number;
        maxEntryBytes: number;
    };

export type SearchResultSetCacheOptions = Readonly<{
    maxEntries: number;
    maxEntryBytes: number;
    maxCacheBytes: number;
    ttlMs: number;
}>;

type ScopedOwnedSearchResultSet<T> = {
    scopeId: string;
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
    inspectionWitness: T | typeof UNINSPECTED_VALUE | typeof UNSUPPORTED_VALUE;
    nextOffset: number;
    expiresAtMs: number;
    reservationBytes: number;
    reservedReplayBytes: number;
    lastPage: SearchResultSetReplay | null;
};

const DEFAULT_OPTIONS: SearchResultSetCacheOptions = Object.freeze({
    maxEntries: MAX_RESULT_SET_CACHE_ENTRIES,
    maxEntryBytes: MAX_RESULT_SET_ENTRY_BYTES,
    maxCacheBytes: MAX_RESULT_SET_CACHE_BYTES,
    ttlMs: RESULT_SET_TTL_MS,
});

const UNINSPECTED_VALUE = Symbol("uninspected search result-set value");
const UNSUPPORTED_VALUE = Symbol("unsupported search result-set value");

function isDeeplyFreezable(value: unknown): boolean {
    const pending: unknown[] = [value];
    const seen = new WeakSet<object>();
    try {
        while (pending.length > 0) {
            const current = pending.pop();
            if (current === null || (typeof current !== "object" && typeof current !== "function")) continue;
            if (typeof current === "function") return false;
            if (seen.has(current)) continue;
            seen.add(current);

            if (Array.isArray(current)) {
                if (Object.getPrototypeOf(current) !== Array.prototype) return false;
            } else {
                const prototype = Object.getPrototypeOf(current);
                if (prototype !== Object.prototype && prototype !== null) return false;
            }

            for (const key of Reflect.ownKeys(current)) {
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                if (!descriptor || !("value" in descriptor)) return false;
                pending.push(descriptor.value);
            }
        }
    } catch {
        return false;
    }
    return true;
}

function freezeDeep(value: unknown, seen = new WeakSet<object>()): void {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor) freezeDeep(descriptor.value, seen);
    }
    Object.freeze(value);
}

function resolveOptions(
    options: Partial<SearchResultSetCacheOptions> = {},
): SearchResultSetCacheOptions {
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    for (const [label, value] of Object.entries(resolved)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`Search result-set cache ${label} must be a positive safe integer.`);
        }
    }
    if (resolved.maxEntryBytes > resolved.maxCacheBytes) {
        throw new Error("Search result-set entry byte limit cannot exceed aggregate capacity.");
    }
    return Object.freeze(resolved);
}

function canonicalByteLength(value: unknown): number {
    const jsonWithRaw = JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean };
    let containsRawJSON = false;
    const replacer = typeof jsonWithRaw.isRawJSON === "function"
        ? (_key: string, current: unknown) => {
            if (jsonWithRaw.isRawJSON!(current)) containsRawJSON = true;
            return current;
        }
        : undefined;
    const json = JSON.stringify(value, replacer);
    if (json === undefined) {
        throw new TypeError("Search result-set cache values must be JSON-serializable.");
    }
    return containsRawJSON
        ? Buffer.byteLength(serializeCanonicalJson(JSON.parse(json)), "utf8")
        : Buffer.byteLength(json, "utf8");
}

export class SearchResultSetCache<T> {
    private readonly entries = new Map<string, CacheEntry<T>>();
    private readonly options: SearchResultSetCacheOptions;
    private totalReservationBytes = 0;

    constructor(options: Partial<SearchResultSetCacheOptions> = {}) {
        this.options = resolveOptions(options);
    }

    public store(input: {
        value: T;
        nextOffset: number;
        reservedReplayBytes: number;
        nowMs: number;
    }): SearchResultSetStoreResult {
        if (
            !Number.isSafeInteger(input.reservedReplayBytes)
            || input.reservedReplayBytes < 0
        ) {
            throw new Error("Search result-set replay reservation must be a non-negative safe integer.");
        }
        const valueBytes = canonicalByteLength(input.value);
        const reservationBytes = valueBytes + input.reservedReplayBytes;
        if (reservationBytes > this.options.maxEntryBytes) {
            return {
                status: "not_admissible",
                reason: "entry_too_large",
                valueBytes,
                reservedReplayBytes: input.reservedReplayBytes,
                reservationBytes,
                maxEntryBytes: this.options.maxEntryBytes,
            };
        }

        const handle = crypto.randomBytes(24).toString("hex");
        const expiresAtMs = input.nowMs + this.options.ttlMs;
        this.entries.set(handle, {
            value: structuredClone(input.value),
            inspectionWitness: UNINSPECTED_VALUE,
            nextOffset: Math.max(0, Math.floor(input.nextOffset)),
            expiresAtMs,
            reservationBytes,
            reservedReplayBytes: input.reservedReplayBytes,
            lastPage: null,
        });
        this.totalReservationBytes += reservationBytes;
        this.prune(input.nowMs);
        return { status: "stored", handle, expiresAtMs, reservationBytes };
    }

    public lookup(
        handle: string,
        nowMs: number,
        accepts: (value: Readonly<T>) => boolean = () => true,
    ): SearchResultSetLookup<T> {
        return this.lookupValue(handle, nowMs, accepts, false);
    }

    /** Internal continuation-only read; a supported cache-owned value is deeply frozen before borrowing. */
    public lookupForInspection(
        handle: string,
        nowMs: number,
        accepts: (value: Readonly<T>) => boolean = () => true,
    ): SearchResultSetLookup<T> {
        return this.lookupValue(handle, nowMs, accepts, true);
    }

    private lookupValue(
        handle: string,
        nowMs: number,
        accepts: (value: Readonly<T>) => boolean,
        inspect: boolean,
    ): SearchResultSetLookup<T> {
        const entry = this.entries.get(handle);
        if (!entry) return { status: "not_found" };
        if (nowMs >= entry.expiresAtMs) {
            this.delete(handle, entry);
            return { status: "expired" };
        }
        if (!accepts(entry.value)) return { status: "not_found" };
        this.entries.delete(handle);
        this.entries.set(handle, entry);
        let value: T;
        if (!inspect) {
            value = structuredClone(entry.value);
        } else {
            if (entry.inspectionWitness === UNINSPECTED_VALUE) {
                if (isDeeplyFreezable(entry.value)) {
                    freezeDeep(entry.value);
                    entry.inspectionWitness = entry.value;
                } else {
                    entry.inspectionWitness = UNSUPPORTED_VALUE;
                }
            }
            value = entry.inspectionWitness === entry.value
                ? entry.value
                : structuredClone(entry.value);
        }
        return {
            status: "hit",
            entry: value,
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
        accepts?: (value: Readonly<T>) => boolean;
    }): "advanced" | "conflict" | "expired" | "not_found" | "too_large" {
        const entry = this.entries.get(input.handle);
        if (!entry) return "not_found";
        if (input.nowMs >= entry.expiresAtMs) {
            this.delete(input.handle, entry);
            return "expired";
        }
        if (input.accepts && !input.accepts(entry.value)) return "not_found";
        if (entry.nextOffset !== input.expectedOffset) return "conflict";
        const replayBytes = Buffer.byteLength(input.replay.responseText, "utf8");
        if (replayBytes > entry.reservedReplayBytes) return "too_large";
        entry.lastPage = structuredClone(input.replay);
        entry.nextOffset = Math.max(entry.nextOffset, Math.floor(input.nextOffset));
        this.entries.delete(input.handle);
        this.entries.set(input.handle, entry);
        return "advanced";
    }

    public remove(handle: string, accepts: (value: Readonly<T>) => boolean = () => true): void {
        const entry = this.entries.get(handle);
        if (entry && accepts(entry.value)) this.delete(handle, entry);
    }

    public removeWhere(predicate: (value: Readonly<T>) => boolean): void {
        for (const [handle, entry] of this.entries) {
            if (predicate(entry.value)) this.delete(handle, entry);
        }
    }

    public clear(): void {
        this.entries.clear();
        this.totalReservationBytes = 0;
    }

    private prune(nowMs: number): void {
        for (const [handle, entry] of this.entries) {
            if (nowMs >= entry.expiresAtMs) this.delete(handle, entry);
        }
        while (
            this.entries.size > this.options.maxEntries
            || this.totalReservationBytes > this.options.maxCacheBytes
        ) {
            const oldest = this.entries.entries().next().value as [string, CacheEntry<T>] | undefined;
            if (!oldest) break;
            this.delete(oldest[0], oldest[1]);
        }
    }

    private delete(handle: string, entry: CacheEntry<T>): void {
        if (!this.entries.delete(handle)) return;
        this.totalReservationBytes -= entry.reservationBytes;
    }
}

export class SearchResultSetCoordinatorPool<T> {
    private readonly cache: SearchResultSetCache<ScopedOwnedSearchResultSet<T>>;

    constructor(options: Partial<SearchResultSetCacheOptions> = {}) {
        this.cache = new SearchResultSetCache(options);
    }

    public store(input: {
        value: ScopedOwnedSearchResultSet<T>;
        nextOffset: number;
        reservedReplayBytes: number;
        nowMs: number;
    }): SearchResultSetStoreResult {
        return this.cache.store(input);
    }

    public lookup(
        scopeId: string,
        handle: string,
        nowMs: number,
    ): SearchResultSetLookup<ScopedOwnedSearchResultSet<T>> {
        return this.cache.lookup(handle, nowMs, (entry) => entry.scopeId === scopeId);
    }

    /** Internal continuation-only read preserving the same scope and cache policy checks as lookup. */
    public lookupForInspection(
        scopeId: string,
        handle: string,
        nowMs: number,
    ): SearchResultSetLookup<ScopedOwnedSearchResultSet<T>> {
        return this.cache.lookupForInspection(handle, nowMs, (entry) => entry.scopeId === scopeId);
    }

    public advance(scopeId: string, input: {
        handle: string;
        expectedOffset: number;
        nextOffset: number;
        nowMs: number;
        replay: SearchResultSetReplay;
    }): "advanced" | "conflict" | "expired" | "not_found" | "too_large" {
        return this.cache.advance({
            ...input,
            accepts: (entry) => entry.scopeId === scopeId,
        });
    }

    public remove(scopeId: string, handle: string): void {
        this.cache.remove(handle, (entry) => entry.scopeId === scopeId);
    }

    public removeOwner(scopeId: string, ownerId: string): void {
        this.cache.removeWhere((entry) => (
            entry.scopeId === scopeId && entry.ownerId === ownerId
        ));
    }

    public clear(): void {
        this.cache.clear();
    }
}

/**
 * One continuation authority scope over a potentially shared aggregate pool.
 * Sharing capacity never shares handle lookup or owner routing authority.
 */
export class SearchResultSetCoordinator<T, TOwner extends object> {
    private readonly scopeId = crypto.randomBytes(24).toString("hex");
    private readonly owners = new Map<string, TOwner>();
    private readonly ownerIds = new WeakMap<TOwner, string>();

    constructor(
        private readonly pool: SearchResultSetCoordinatorPool<T> =
            new SearchResultSetCoordinatorPool<T>(),
    ) {}

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
        this.pool.removeOwner(this.scopeId, ownerId);
    }

    public store(owner: TOwner, input: {
        value: T;
        nextOffset: number;
        reservedReplayBytes: number;
        nowMs: number;
    }): SearchResultSetStoreResult {
        const ownerId = this.ownerIds.get(owner);
        if (!ownerId || this.owners.get(ownerId) !== owner) {
            throw new Error("Search continuation owner is not registered.");
        }
        return this.pool.store({
            value: { scopeId: this.scopeId, ownerId, value: input.value },
            nextOffset: input.nextOffset,
            reservedReplayBytes: input.reservedReplayBytes,
            nowMs: input.nowMs,
        });
    }

    public lookup(handle: string, nowMs: number): SearchResultSetCoordinatorLookup<T, TOwner> {
        return this.resolveLookup(handle, nowMs, false);
    }

    /** Internal continuation-only read; only a cache-owned deeply frozen value may be borrowed. */
    public lookupForInspection(handle: string, nowMs: number): SearchResultSetCoordinatorLookup<T, TOwner> {
        return this.resolveLookup(handle, nowMs, true);
    }

    private resolveLookup(
        handle: string,
        nowMs: number,
        inspect: boolean,
    ): SearchResultSetCoordinatorLookup<T, TOwner> {
        const lookup = inspect
            ? this.pool.lookupForInspection(this.scopeId, handle, nowMs)
            : this.pool.lookup(this.scopeId, handle, nowMs);
        if (lookup.status !== "hit") return lookup;
        const owner = this.owners.get(lookup.entry.ownerId);
        if (!owner) {
            this.pool.remove(this.scopeId, handle);
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
        return this.pool.advance(this.scopeId, input);
    }

    public remove(handle: string): void {
        this.pool.remove(this.scopeId, handle);
    }
}
