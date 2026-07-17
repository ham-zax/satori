import assert from "node:assert/strict";
import test from "node:test";
import { SearchResultSetCache } from "./search-result-set-cache.js";

test("search result-set cache is bounded by bytes and evicts least-recently-used entries", () => {
    const entryBytes = Buffer.byteLength(JSON.stringify({ value: "a".repeat(20) }), "utf8");
    const cache = new SearchResultSetCache<{ value: string }>(3, entryBytes * 2, 1_000);
    const first = cache.store({ value: { value: "a".repeat(20) }, nextOffset: 1, nowMs: 0 });
    const second = cache.store({ value: { value: "b".repeat(20) }, nextOffset: 1, nowMs: 0 });
    assert.equal(cache.lookup(first.handle, 1).status, "hit");
    const third = cache.store({ value: { value: "c".repeat(20) }, nextOffset: 1, nowMs: 1 });

    assert.equal(cache.lookup(second.handle, 2).status, "not_found");
    assert.equal(cache.lookup(first.handle, 2).status, "hit");
    assert.equal(cache.lookup(third.handle, 2).status, "hit");
});

test("search result-set cache distinguishes expiry and concurrent offset conflicts", () => {
    const cache = new SearchResultSetCache<{ value: string }>(2, 1024, 100);
    const stored = cache.store({ value: { value: "result" }, nextOffset: 2, nowMs: 10 });
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

test("search result-set cache charges retry pages against its byte budget", () => {
    const value = { value: "result" };
    const valueBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const cache = new SearchResultSetCache<typeof value>(2, valueBytes + 4, 100);
    const stored = cache.store({ value, nextOffset: 0, nowMs: 0 });

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

test("search result-set cache rejects an entry larger than its total byte budget", () => {
    const cache = new SearchResultSetCache<{ value: string }>(2, 16, 100);
    assert.throws(() => cache.store({
        value: { value: "too large" },
        nextOffset: 0,
        nowMs: 0,
    }), /byte budget/);
});
