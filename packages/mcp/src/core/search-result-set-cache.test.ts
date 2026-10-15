import assert from "node:assert/strict";
import test from "node:test";
import { serializeCanonicalJson } from "./canonical-json.js";
import { SEARCH_DISCLOSURE_POLICY_VERSION } from "./search-disclosure.js";
import { resolveSearchRankingPolicyIdentity } from "./search-order-policy.js";
import {
    SearchContinuationCoordinator,
    SearchRequestCoordinator,
    type FrozenSearchResultSet,
    type SearchRequestCoordinatorCollaborators,
} from "./search-request-coordinator.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { buildSearchRankedSetBinding } from "./search-result-set-identity.js";
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

function legacyValueBytes(value: unknown): number {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new TypeError("Search result-set cache values must be JSON-serializable.");
    }
    return Buffer.byteLength(serializeCanonicalJson(JSON.parse(json)), "utf8");
}

function captureThrown(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    assert.fail("Expected the operation to throw.");
}

function compareStoreWithLegacyCount(value: unknown): void {
    const expectedBytes = legacyValueBytes(value);
    const reservedReplayBytes = 17;
    for (const admitted of [true, false]) {
        const maxEntryBytes = expectedBytes + reservedReplayBytes - (admitted ? 0 : 1);
        const cache = new SearchResultSetCache<unknown>({
            maxEntries: 2,
            maxEntryBytes,
            maxCacheBytes: maxEntryBytes,
            ttlMs: 100,
        });
        if (!admitted) {
            assert.deepEqual(cache.store({ value, nextOffset: 3, reservedReplayBytes, nowMs: 10 }), {
                status: "not_admissible",
                reason: "entry_too_large",
                valueBytes: expectedBytes,
                reservedReplayBytes,
                reservationBytes: expectedBytes + reservedReplayBytes,
                maxEntryBytes,
            });
            continue;
        }

        let expectedClone: unknown;
        let cloneError: unknown;
        try {
            expectedClone = structuredClone(value);
        } catch (error) {
            cloneError = error;
        }
        if (cloneError !== undefined) {
            assert.throws(
                () => cache.store({ value, nextOffset: 3, reservedReplayBytes, nowMs: 10 }),
                (error: unknown) => error instanceof Error
                    && cloneError instanceof Error
                    && error.name === cloneError.name
                    && error.message === cloneError.message,
            );
            continue;
        }

        const stored = requireStored(cache.store({ value, nextOffset: 3, reservedReplayBytes, nowMs: 10 }));
        assert.equal(stored.reservationBytes, expectedBytes + reservedReplayBytes);
        assert.equal(stored.expiresAtMs, 110);
        const lookup = cache.lookup(stored.handle, 11);
        assert.equal(lookup.status, "hit");
        if (lookup.status === "hit") assert.deepEqual(lookup.entry, expectedClone);
    }
}

test("byte accounting matches the legacy canonical count for JSON and rawJSON values", () => {
    const sparse: unknown[] = [];
    sparse.length = 6;
    sparse[2] = "line\nquote\" slash\\";
    sparse[4] = Number.POSITIVE_INFINITY;
    sparse[5] = Number.NaN;
    const inheritedToJSON = Object.assign(Object.create({
        toJSON: () => ({ z: "é漢🙂", a: "quote\" slash\\" }),
    }), { ignoredByJSON: "original object is cloned after accounting" });
    const values: unknown[] = [
        { z: "é漢🙂\u2028\u2029", a: ["/", "\\", "\u0000"] },
        { a: { nested: true }, z: [3, 2, 1] },
        { sparse, z: Number.NEGATIVE_INFINITY },
        new Date("2025-02-03T04:05:06.000Z"),
        inheritedToJSON,
    ];
    const jsonWithRaw = JSON as typeof JSON & {
        rawJSON?: (rawText: string) => unknown;
        isRawJSON?: (value: unknown) => boolean;
    };
    assert.equal(typeof jsonWithRaw.rawJSON, "function", "the supported Node runtime exposes JSON.rawJSON");
    assert.equal(typeof jsonWithRaw.isRawJSON, "function");
    const rawNumber = jsonWithRaw.rawJSON!("1e3");
    const rawEscapedString = jsonWithRaw.rawJSON!('"\\u0061"');
    const rawJSONToJSON = Object.assign(Object.create({ toJSON: () => rawNumber }), { ignored: true });
    values.push(rawNumber, { rawNumber, rawEscapedString }, rawJSONToJSON);

    assert.notEqual(Buffer.byteLength(JSON.stringify(rawNumber)!, "utf8"), legacyValueBytes(rawNumber));
    assert.notEqual(
        Buffer.byteLength(JSON.stringify(rawEscapedString)!, "utf8"),
        legacyValueBytes(rawEscapedString),
    );
    for (const value of values) compareStoreWithLegacyCount(value);
});

test("byte accounting keeps undefined, cyclic, and throwing serialization errors", () => {
    const cache = new SearchResultSetCache<unknown>();
    const store = (value: unknown) => cache.store({ value, nextOffset: 0, reservedReplayBytes: 0, nowMs: 0 });
    assert.throws(() => store(undefined), {
        name: "TypeError",
        message: "Search result-set cache values must be JSON-serializable.",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const legacyCycleError = captureThrown(() => legacyValueBytes(cyclic));
    const actualCycleError = captureThrown(() => store(cyclic));
    assert.ok(legacyCycleError instanceof Error);
    assert.ok(actualCycleError instanceof Error);
    assert.equal(actualCycleError.name, legacyCycleError.name);
    assert.equal(actualCycleError.message, legacyCycleError.message);
    const sentinel = new Error("toJSON sentinel");
    const throwing = Object.create({ toJSON: () => { throw sentinel; } });
    assert.throws(() => store(throwing), error => error === sentinel);
});

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
    assert.equal(cache.lookupForInspection(first.handle, 1).status, "hit");
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

test("inspection preserves scope, owner, expiry, advance, and replay metadata", () => {
    const value = { nested: { names: ["first", "second"] } };
    const replayReservation = 128;
    const pool = new SearchResultSetCoordinatorPool<typeof value>({
        maxEntries: 4,
        maxEntryBytes: 4_096,
        maxCacheBytes: 8_192,
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
        reservedReplayBytes: replayReservation,
        nowMs: 0,
    }));
    const second = requireStored(secondScope.store(secondOwner, {
        value,
        nextOffset: 5,
        reservedReplayBytes: replayReservation,
        nowMs: 0,
    }));

    assert.equal(secondScope.lookupForInspection(first.handle, 1).status, "not_found");
    assert.equal(firstScope.lookupForInspection(second.handle, 1).status, "not_found");
    const firstRead = firstScope.lookupForInspection(first.handle, 1);
    assert.equal(firstRead.status, "hit");
    if (firstRead.status !== "hit") throw new Error("Expected the owning scope inspection to hit.");
    assert.equal(firstRead.owner, firstOwner);
    assert.ok(Object.isFrozen(firstRead.entry));
    assert.ok(Object.isFrozen(firstRead.entry.nested));
    assert.ok(Object.isFrozen(firstRead.entry.nested.names));

    assert.equal(firstScope.advance({
        handle: first.handle,
        expectedOffset: 1,
        nextOffset: 3,
        nowMs: 2,
        replay: { expectedOffset: 1, pageSize: 2, responseText: "page one" },
    }), "advanced");
    const replayRead = firstScope.lookupForInspection(first.handle, 3);
    assert.equal(replayRead.status, "hit");
    if (replayRead.status === "hit") {
        assert.equal(replayRead.nextOffset, 3);
        assert.deepEqual(replayRead.lastPage, { expectedOffset: 1, pageSize: 2, responseText: "page one" });
        replayRead.lastPage!.responseText = "caller mutation";
    }
    const replayRetry = firstScope.lookupForInspection(first.handle, 4);
    assert.equal(replayRetry.status, "hit");
    if (replayRetry.status === "hit") {
        assert.deepEqual(replayRetry.lastPage, { expectedOffset: 1, pageSize: 2, responseText: "page one" });
    }

    const expired = requireStored(firstScope.store(firstOwner, {
        value,
        nextOffset: 0,
        reservedReplayBytes: 0,
        nowMs: 5,
    }));
    assert.equal(firstScope.lookupForInspection(expired.handle, 105).status, "expired");
    firstScope.unregisterOwner(firstOwner);
    assert.equal(firstScope.lookupForInspection(first.handle, 6).status, "not_found");
    assert.equal(secondScope.lookupForInspection(second.handle, 6).status, "hit");
    pool.clear();
    assert.equal(secondScope.lookupForInspection(second.handle, 7).status, "not_found");
});

test("inspection borrows one frozen snapshot while ordinary lookup keeps mutable copies", () => {
    const value = { orderedResults: [{ target: { file: "src/original.ts" } }], nested: { values: [1, 2] } };
    const coordinator = new SearchResultSetCoordinator<typeof value, object>();
    const owner = {};
    coordinator.registerOwner(owner);
    const stored = requireStored(coordinator.store(owner, {
        value,
        nextOffset: 2,
        reservedReplayBytes: 128,
        nowMs: 0,
    }));
    const warmed = coordinator.lookupForInspection(stored.handle, 1);
    assert.equal(warmed.status, "hit");
    if (warmed.status !== "hit") throw new Error("Expected inspection to hit.");
    assert.throws(() => {
        (warmed.entry.orderedResults[0]!.target as { file: string }).file = "src/mutated.ts";
    }, TypeError);
    assert.throws(() => warmed.entry.nested.values.push(3), TypeError);
    assert.equal(coordinator.advance({
        handle: stored.handle,
        expectedOffset: 2,
        nextOffset: 4,
        nowMs: 2,
        replay: { expectedOffset: 2, pageSize: 2, responseText: "page two" },
    }), "advanced");

    const originalStructuredClone = globalThis.structuredClone;
    let fullSnapshotClones = 0;
    globalThis.structuredClone = ((candidate: unknown) => {
        const owned = candidate as { value?: { orderedResults?: unknown[] } } | null;
        if (owned?.value && Array.isArray(owned.value.orderedResults)) fullSnapshotClones++;
        return originalStructuredClone(candidate);
    }) as typeof structuredClone;
    try {
        for (let index = 0; index < 4; index++) {
            const validCursor = coordinator.lookupForInspection(stored.handle, 2 + index);
            assert.equal(validCursor.status, "hit");
            if (validCursor.status !== "hit") throw new Error("Expected valid-cursor inspection to hit.");
            assert.equal(validCursor.nextOffset, 4);

            const staleCursor = coordinator.lookupForInspection(stored.handle, 2 + index);
            assert.equal(staleCursor.status, "hit");
            if (staleCursor.status !== "hit") throw new Error("Expected stale-cursor inspection to retain cache semantics.");
            assert.notEqual(staleCursor.nextOffset, 99);
            assert.deepEqual(staleCursor.lastPage, { expectedOffset: 2, pageSize: 2, responseText: "page two" });
            if (staleCursor.lastPage) {
                (staleCursor.lastPage as { responseText: string }).responseText = "caller mutation";
            }
            const replayRetry = coordinator.lookupForInspection(stored.handle, 2 + index);
            assert.equal(replayRetry.status, "hit");
            if (replayRetry.status === "hit") {
                assert.deepEqual(replayRetry.lastPage, { expectedOffset: 2, pageSize: 2, responseText: "page two" });
            }
        }
    } finally {
        globalThis.structuredClone = originalStructuredClone;
    }
    assert.equal(fullSnapshotClones, 0);

    const mutableFirst = coordinator.lookup(stored.handle, 7);
    assert.equal(mutableFirst.status, "hit");
    if (mutableFirst.status !== "hit") throw new Error("Expected ordinary lookup to hit.");
    assert.equal(mutableFirst.nextOffset, 4);
    assert.equal(Object.isFrozen(mutableFirst.entry), false);
    mutableFirst.entry.orderedResults[0]!.target.file = "src/mutated.ts";
    mutableFirst.entry.nested.values.push(3);
    const mutableSecond = coordinator.lookup(stored.handle, 8);
    assert.equal(mutableSecond.status, "hit");
    if (mutableSecond.status === "hit") {
        assert.notEqual(mutableSecond.entry, mutableFirst.entry);
        assert.equal(mutableSecond.entry.orderedResults[0]!.target.file, "src/original.ts");
        assert.deepEqual(mutableSecond.entry.nested.values, [1, 2]);
    }
});

test("continuation uses borrowed reads for cursor, replay, and concurrent replay decisions", async t => {
    const publication = {
        id: "publication-1",
        publication: {
            vector: { collectionName: "collection-1" },
            policy: { policyHash: "policy-1" },
        },
    } as unknown as FrozenSearchResultSet["publication"];
    const queryPolicyDigest = "c".repeat(64);
    const orderedResults = [{
        target: { file: "src/result.ts", span: { startLine: 1, endLine: 2 }, symbolId: "result-1" },
        displayLabel: "src/result.ts",
        language: "typescript",
        symbolKind: "function",
        quality: { owner: "high", semantic: "high" },
        evidenceChunks: 1,
        preview: "export function result() {}",
    }] as unknown as FrozenSearchResultSet["orderedResults"];
    const recommendedActions: FrozenSearchResultSet["recommendedActions"] = [null];
    const rankedSetBinding = buildSearchRankedSetBinding({
        queryPolicyDigest,
        rankingPolicyIdentity: resolveSearchRankingPolicyIdentity({ orderAuthority: "retrieval_order" }),
        disclosurePolicyVersion: SEARCH_DISCLOSURE_POLICY_VERSION,
        publicationIdentity: {
            publicationId: publication.id,
            collectionName: publication.publication.vector.collectionName,
            policyHash: publication.publication.policy.policyHash,
            navigation: publication.publication.navigation ? { status: "bound" } : { status: "not_bound" },
        },
        rerankerIdentity: { kind: "deterministic_baseline", policy: "B" },
        rerankerProjectionIdentity: "not_applicable",
        rerankerRequestIdentity: null,
        orderedResults,
        recommendedActions,
    });
    const snapshot: FrozenSearchResultSet = {
        canonicalRoot: "/repo",
        publication,
        queryPolicyDigest,
        rankedSetBinding,
        responseByteLimit: 32_000,
        pageSize: 2,
        baseEnvelope: {
            query: "result",
            scope: "repository",
            rankedSetDigest: rankedSetBinding.rankedSetDigest,
        } as unknown as FrozenSearchResultSet["baseEnvelope"],
        orderedResults,
        recommendedActions,
    };

    let admissionChecks = 0;
    const collaborators = {
        readiness: {},
        hints: {
            stringifyToolJson: (payload: unknown) => JSON.stringify(payload),
            buildGeneratedArtifactsVerificationHint: () => undefined,
        },
        preparedRead: {
            isPublicationAdmitted: async () => { admissionChecks++; return true; },
        },
        freshness: {},
        environment: {
            now: () => 10,
            getCapabilities: () => ({ getMaxFrozenSearchResults: () => 100 }),
        },
    } as unknown as SearchRequestCoordinatorCollaborators;
    const searchQuerySupport = {
        parseSearchOperators: () => ({ path: [] }),
        buildNoiseMitigationHint: () => undefined,
    } as unknown as SearchQuerySupport;
    const continuationCoordinator = new SearchContinuationCoordinator();
    const owner = new SearchRequestCoordinator(collaborators, searchQuerySupport, null, continuationCoordinator);
    t.after(() => owner.releaseContinuationOwnership());
    const stored = requireStored(continuationCoordinator.store(owner, {
        value: snapshot,
        nextOffset: 0,
        reservedReplayBytes: 4_096,
        nowMs: 0,
    }));

    const originalAdvance = continuationCoordinator.advance.bind(continuationCoordinator);
    continuationCoordinator.advance = input => {
        assert.equal(originalAdvance(input), "advanced", "the concurrent request advances the shared cursor first");
        return "conflict";
    };

    const originalStructuredClone = globalThis.structuredClone;
    let fullSnapshotClones = 0;
    globalThis.structuredClone = ((candidate: unknown) => {
        const owned = candidate as { value?: { orderedResults?: unknown[] } } | null;
        if (owned?.value && Array.isArray(owned.value.orderedResults)) fullSnapshotClones++;
        return originalStructuredClone(candidate);
    }) as typeof structuredClone;
    try {
        const staleCursor = await owner.continueOwned({ handle: stored.handle, expectedOffset: 9 });
        assert.equal(JSON.parse(staleCursor.content[0]!.text).code, "SEARCH_RESULT_SET_CONFLICT");
        assert.equal(admissionChecks, 1, "publication admission still precedes a cursor error");

        const racedPage = await owner.continueOwned({ handle: stored.handle, expectedOffset: 0 });
        assert.equal(racedPage.isError, undefined);
        assert.equal(admissionChecks, 3, "both admission gates still run before the concurrent replay check");

        const replayedPage = await owner.continueOwned({ handle: stored.handle, expectedOffset: 0 });
        assert.equal(replayedPage.content[0]?.text, racedPage.content[0]?.text);
        assert.equal(admissionChecks, 4, "publication admission still precedes the replay result");

        const consumedCursor = await owner.continueOwned({ handle: stored.handle, expectedOffset: 1 });
        assert.equal(JSON.parse(consumedCursor.content[0]!.text).code, "SEARCH_RESULT_SET_CONSUMED");
        assert.equal(admissionChecks, 5, "publication admission still precedes the consumed-cursor result");
    } finally {
        globalThis.structuredClone = originalStructuredClone;
    }
    assert.equal(fullSnapshotClones, 0, "valid, stale, replay, and concurrent replay reads borrow the frozen snapshot");
});

test("inspection falls back to defensive copies for structured-clone exotic values", () => {
    const values: unknown[] = [
        new Date("2025-01-02T03:04:05.000Z"),
        new Map([["key", { value: 1 }]]),
        new Set(["value"]),
        new Uint8Array([1, 2, 3]),
    ];
    for (const value of values) {
        const cache = new SearchResultSetCache<unknown>({ maxEntries: 2, maxEntryBytes: 4_096, maxCacheBytes: 8_192, ttlMs: 100 });
        const stored = requireStored(cache.store({ value, nextOffset: 0, reservedReplayBytes: 0, nowMs: 0 }));
        const first = cache.lookupForInspection(stored.handle, 1);
        assert.equal(first.status, "hit");
        if (first.status !== "hit") throw new Error("Expected exotic value inspection to hit.");
        assert.equal(Object.isFrozen(first.entry), false);
        const second = cache.lookupForInspection(stored.handle, 2);
        assert.equal(second.status, "hit");
        if (second.status === "hit") assert.notEqual(second.entry, first.entry);
    }

    const mixed = { exotic: new Map([["key", "value"]]), safe: { nested: { value: 1 } } };
    const mixedCache = new SearchResultSetCache<typeof mixed>({ maxEntries: 2, maxEntryBytes: 4_096, maxCacheBytes: 8_192, ttlMs: 100 });
    const mixedStored = requireStored(mixedCache.store({ value: mixed, nextOffset: 0, reservedReplayBytes: 0, nowMs: 0 }));
    const mixedRead = mixedCache.lookupForInspection(mixedStored.handle, 1);
    assert.equal(mixedRead.status, "hit");
    if (mixedRead.status === "hit") {
        assert.equal(Object.isFrozen(mixedRead.entry.safe), false, "unsupported graphs are not partially frozen");
        assert.equal(Object.isFrozen(mixedRead.entry.safe.nested), false);
    }

    const custom = Object.assign(Object.create({ kind: "custom" }), { nested: { value: 1 } });
    Object.defineProperty(custom, "accessed", { enumerable: true, get: () => "read once by structuredClone" });
    const cache = new SearchResultSetCache<typeof custom>({ maxEntries: 2, maxEntryBytes: 4_096, maxCacheBytes: 8_192, ttlMs: 100 });
    const stored = requireStored(cache.store({ value: custom, nextOffset: 0, reservedReplayBytes: 0, nowMs: 0 }));
    const normalized = cache.lookupForInspection(stored.handle, 1);
    assert.equal(normalized.status, "hit");
    if (normalized.status === "hit") {
        assert.equal(Object.getPrototypeOf(normalized.entry), Object.prototype);
        assert.equal(normalized.entry.accessed, "read once by structuredClone");
        assert.ok(Object.isFrozen(normalized.entry), "only the normalized cache-owned graph is frozen");
    }
});
