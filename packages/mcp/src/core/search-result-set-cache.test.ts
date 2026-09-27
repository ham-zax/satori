import assert from "node:assert/strict";
import test from "node:test";
import { serializeCanonicalJson } from "./canonical-json.js";
import {
    SearchResultSetCache,
    SearchResultSetCoordinator,
    SearchResultSetCoordinatorPool,
    type SearchResultSetStoreResult,
} from "./search-result-set-cache.js";

function requireStored(result: SearchResultSetStoreResult): Extract<
    SearchResultSetStoreResult,
    { status: "stored" }
> {
    assert.equal(result.status, "stored");
    if (result.status !== "stored") throw new Error("Expected stored result set.");
    return result;
}

function valueBytes(value: unknown): number {
    return Buffer.byteLength(serializeCanonicalJson(value), "utf8");
}

test("search result-set cache reserves replay bytes and evicts least-recently-used entries", () => {
    const bytes = valueBytes({ value: "a".repeat(20) });
    const cache = new SearchResultSetCache<{ value: string }>({
        maxEntries: 3,
        maxEntryBytes: bytes,
        maxCacheBytes: bytes * 2,
        ttlMs: 1_000,
    });
    const first = requireStored(cache.store({
        value: { value: "a".repeat(20) },
        nextOffset: 1,
        reservedReplayBytes: 0,
        nowMs: 0,
    }));
    const second = requireStored(cache.store({
        value: { value: "b".repeat(20) },
        nextOffset: 1,
        reservedReplayBytes: 0,
        nowMs: 0,
    }));
    assert.equal(cache.lookup(first.handle, 1).status, "hit");
    const third = requireStored(cache.store({
        value: { value: "c".repeat(20) },
        nextOffset: 1,
        reservedReplayBytes: 0,
        nowMs: 1,
    }));

    assert.equal(cache.lookup(second.handle, 2).status, "not_found");
    assert.equal(cache.lookup(first.handle, 2).status, "hit");
    assert.equal(cache.lookup(third.handle, 2).status, "hit");
});

test("search result-set cache measures optional fields with response JSON semantics", () => {
    const expectedBytes = valueBytes({ value: "result" });
    const cache = new SearchResultSetCache<{ value: string; optional?: string }>({
        maxEntries: 1,
        maxEntryBytes: expectedBytes,
        maxCacheBytes: expectedBytes,
        ttlMs: 1_000,
    });
    const stored = requireStored(cache.store({
        value: { value: "result", optional: undefined },
        nextOffset: 1,
        reservedReplayBytes: 0,
        nowMs: 0,
    }));

    assert.equal(stored.reservationBytes, expectedBytes);
    const lookup = cache.lookup(stored.handle, 1);
    assert.equal(lookup.status, "hit");
    if (lookup.status === "hit") {
        assert.deepEqual(JSON.parse(JSON.stringify(lookup.entry)), { value: "result" });
    }
});

test("search result-set cache distinguishes expiry and concurrent offset conflicts", () => {
    const cache = new SearchResultSetCache<{ value: string }>({
        maxEntries: 2,
        maxEntryBytes: 1_024,
        maxCacheBytes: 2_048,
        ttlMs: 100,
    });
    const stored = requireStored(cache.store({
        value: { value: "result" },
        nextOffset: 2,
        reservedReplayBytes: 100,
        nowMs: 10,
    }));
    assert.equal(cache.advance({
        handle: stored.handle,
        expectedOffset: 1,
        nextOffset: 3,
        nowMs: 20,
        replay: { expectedOffset: 1, pageSize: 1, responseText: "wrong" },
    }), "conflict");
    assert.equal(cache.advance({
        handle: stored.handle,
        expectedOffset: 2,
        nextOffset: 3,
        nowMs: 20,
        replay: { expectedOffset: 2, pageSize: 1, responseText: "page" },
    }), "advanced");
    const advanced = cache.lookup(stored.handle, 20);
    assert.equal(advanced.status, "hit");
    if (advanced.status === "hit") {
        assert.equal(advanced.nextOffset, 3);
        assert.deepEqual(advanced.lastPage, {
            expectedOffset: 2,
            pageSize: 1,
            responseText: "page",
        });
    }
    assert.equal(cache.lookup(stored.handle, 110).status, "expired");
    assert.equal(cache.lookup(stored.handle, 111).status, "not_found");
});

test("search result-set replay overflow leaves admitted state unchanged", () => {
    const value = { value: "result" };
    const bytes = valueBytes(value);
    const cache = new SearchResultSetCache<typeof value>({
        maxEntries: 2,
        maxEntryBytes: bytes + 4,
        maxCacheBytes: (bytes + 4) * 2,
        ttlMs: 100,
    });
    const stored = requireStored(cache.store({
        value,
        nextOffset: 0,
        reservedReplayBytes: 4,
        nowMs: 0,
    }));

    assert.equal(cache.advance({
        handle: stored.handle,
        expectedOffset: 0,
        nextOffset: 1,
        nowMs: 1,
        replay: { expectedOffset: 0, pageSize: 1, responseText: "12345" },
    }), "too_large");
    const unchanged = cache.lookup(stored.handle, 1);
    assert.equal(unchanged.status, "hit");
    if (unchanged.status === "hit") {
        assert.equal(unchanged.nextOffset, 0);
        assert.equal(unchanged.lastPage, null);
    }
});

test("search result-set entry rejection is typed and leaves existing state unchanged", () => {
    const firstValue = { value: "first" };
    const firstBytes = valueBytes(firstValue);
    const cache = new SearchResultSetCache<{ value: string }>({
        maxEntries: 2,
        maxEntryBytes: firstBytes,
        maxCacheBytes: firstBytes * 2,
        ttlMs: 100,
    });
    const first = requireStored(cache.store({
        value: firstValue,
        nextOffset: 0,
        reservedReplayBytes: 0,
        nowMs: 0,
    }));
    const rejected = cache.store({
        value: { value: "too large" },
        nextOffset: 0,
        reservedReplayBytes: firstBytes,
        nowMs: 1,
    });

    assert.deepEqual(rejected, {
        status: "not_admissible",
        reason: "entry_too_large",
        valueBytes: valueBytes({ value: "too large" }),
        reservedReplayBytes: firstBytes,
        reservationBytes: valueBytes({ value: "too large" }) + firstBytes,
        maxEntryBytes: firstBytes,
    });
    assert.equal(cache.lookup(first.handle, 2).status, "hit");
});

test("two maximum reservations coexist and a third evicts the deterministic oldest", () => {
    const value = { value: "maximum" };
    const reservationBytes = valueBytes(value) + 10;
    const cache = new SearchResultSetCache<typeof value>({
        maxEntries: 32,
        maxEntryBytes: reservationBytes,
        maxCacheBytes: reservationBytes * 2,
        ttlMs: 1_000,
    });
    const first = requireStored(cache.store({ value, nextOffset: 0, reservedReplayBytes: 10, nowMs: 0 }));
    const second = requireStored(cache.store({ value, nextOffset: 0, reservedReplayBytes: 10, nowMs: 1 }));
    assert.equal(cache.lookup(first.handle, 2).status, "hit");
    const third = requireStored(cache.store({ value, nextOffset: 0, reservedReplayBytes: 10, nowMs: 3 }));

    assert.equal(cache.lookup(second.handle, 4).status, "not_found");
    assert.equal(cache.lookup(first.handle, 4).status, "hit");
    assert.equal(cache.lookup(third.handle, 4).status, "hit");
});

test("coordinator scopes share aggregate capacity without sharing handle authority", () => {
    const value = { value: "shared" };
    const reservationBytes = valueBytes({ scopeId: "x".repeat(48), ownerId: "x".repeat(48), value }) + 5;
    const pool = new SearchResultSetCoordinatorPool<typeof value>({
        maxEntries: 2,
        maxEntryBytes: reservationBytes,
        maxCacheBytes: reservationBytes * 2,
        ttlMs: 100,
    });
    const firstScope = new SearchResultSetCoordinator<typeof value, object>(pool);
    const secondScope = new SearchResultSetCoordinator<typeof value, object>(pool);
    const firstOwner = {};
    const secondOwner = {};
    firstScope.registerOwner(firstOwner);
    secondScope.registerOwner(secondOwner);

    const first = requireStored(firstScope.store(firstOwner, {
        value,
        nextOffset: 1,
        reservedReplayBytes: 5,
        nowMs: 0,
    }));
    const second = requireStored(secondScope.store(secondOwner, {
        value,
        nextOffset: 2,
        reservedReplayBytes: 5,
        nowMs: 1,
    }));
    assert.equal(secondScope.lookup(first.handle, 2).status, "not_found");
    assert.equal(firstScope.lookup(second.handle, 2).status, "not_found");
    assert.equal(firstScope.lookup(first.handle, 2).status, "hit");

    firstScope.unregisterOwner(firstOwner);
    assert.equal(firstScope.lookup(first.handle, 2).status, "not_found");
    assert.equal(secondScope.lookup(second.handle, 2).status, "hit");
    pool.clear();
    assert.equal(secondScope.lookup(second.handle, 2).status, "not_found");
});

test("coordinator removes expired ownership with the cached entry", () => {
    const pool = new SearchResultSetCoordinatorPool<{ value: string }>({
        maxEntries: 2,
        maxEntryBytes: 4_096,
        maxCacheBytes: 8_192,
        ttlMs: 10,
    });
    const coordinator = new SearchResultSetCoordinator<{ value: string }, object>(pool);
    const owner = {};
    coordinator.registerOwner(owner);
    const stored = requireStored(coordinator.store(owner, {
        value: { value: "result" },
        nextOffset: 1,
        reservedReplayBytes: 100,
        nowMs: 0,
    }));

    assert.equal(coordinator.lookup(stored.handle, 10).status, "expired");
    assert.equal(coordinator.lookup(stored.handle, 11).status, "not_found");
});
