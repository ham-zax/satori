import assert from "node:assert/strict";
import test from "node:test";
import {
    SEARCH_MAX_RESULT_INDEX_ENTRIES,
    SEARCH_MAX_RESULT_INDEX_UTF8_BYTES,
} from "./search-constants.js";
import { attachCompactSearchResultIndex } from "./search-result-index.js";
import type {
    SearchGroupedResponseEnvelope,
    SearchGroupedResultV2,
} from "./search-types.js";

const RANKED_SET_DIGEST = "a".repeat(64);

function groupedResult(input: {
    index: number;
    displayLabel?: string;
    owner?: "high" | "medium" | "low";
    semantic?: "high" | "medium" | "low" | "unavailable";
    symbol?: boolean;
}): SearchGroupedResultV2 {
    const file = `src/result-${input.index}.ts`;
    return {
        target: input.symbol === false
            ? { file, span: { startLine: 1, endLine: 2 } }
            : {
                file,
                span: { startLine: 1, endLine: 2 },
                symbolId: `symbol-${input.index}`,
            },
        displayLabel: input.displayLabel ?? `result ${input.index}`,
        language: "typescript",
        quality: {
            owner: input.owner ?? "low",
            semantic: input.semantic ?? "low",
        },
        preview: `preview ${input.index}`,
        navigation: { graph: "unsupported_language" },
    };
}

function baseEnvelope(results: SearchGroupedResultV2[]): SearchGroupedResponseEnvelope {
    return {
        formatVersion: 3,
        status: "ok",
        path: "/repo",
        codebaseRoot: "/repo",
        query: "find owner",
        scope: "runtime",
        groupBy: "symbol",
        limit: 200,
        resultMode: "grouped",
        results,
    };
}

test("compact result index projects the complete ordered prefix with bounded evidence labels", () => {
    const orderedResults = [
        groupedResult({ index: 0, owner: "high", semantic: "high" }),
        groupedResult({ index: 1, owner: "medium", semantic: "high", symbol: false }),
        groupedResult({ index: 2, semantic: "high" }),
        groupedResult({ index: 3, semantic: "medium" }),
        groupedResult({ index: 4 }),
    ];
    const envelope = baseEnvelope(orderedResults.slice(0, 1));

    const attached = attachCompactSearchResultIndex({
        envelope,
        orderedResults,
        rankedSetDigest: RANKED_SET_DIGEST,
        maxResponseBytes: 128 * 1024,
    });

    assert.equal(attached.status, "attached");
    if (attached.status !== "attached") return;
    assert.deepEqual(attached.resultIndex, {
        contractVersion: "search_result_index_v1",
        rankedSetDigest: RANKED_SET_DIGEST,
        disclosurePolicyVersion: "search_disclosure_v1",
        availableEntryCount: 5,
        returnedEntryCount: 5,
        complete: true,
        entries: [
            {
                rank: 1,
                kind: "symbol",
                target: { file: "src/result-0.ts", symbolId: "symbol-0" },
                displayLabel: "result 0",
                evidenceLabel: "high_owner_confidence",
            },
            {
                rank: 2,
                kind: "file",
                target: { file: "src/result-1.ts" },
                displayLabel: "result 1",
                evidenceLabel: "medium_owner_confidence",
            },
            {
                rank: 3,
                kind: "symbol",
                target: { file: "src/result-2.ts", symbolId: "symbol-2" },
                displayLabel: "result 2",
                evidenceLabel: "high_semantic_confidence",
            },
            {
                rank: 4,
                kind: "symbol",
                target: { file: "src/result-3.ts", symbolId: "symbol-3" },
                displayLabel: "result 3",
                evidenceLabel: "medium_semantic_confidence",
            },
            {
                rank: 5,
                kind: "symbol",
                target: { file: "src/result-4.ts", symbolId: "symbol-4" },
                displayLabel: "result 4",
                evidenceLabel: "ranked_candidate",
            },
        ],
    });
});

test("compact result index truncates at the frozen entry cap without changing order", () => {
    const orderedResults = Array.from(
        { length: SEARCH_MAX_RESULT_INDEX_ENTRIES + 1 },
        (_, index) => groupedResult({ index }),
    );
    const attached = attachCompactSearchResultIndex({
        envelope: baseEnvelope([]),
        orderedResults,
        rankedSetDigest: RANKED_SET_DIGEST,
        maxResponseBytes: 256 * 1024,
    });

    assert.equal(attached.status, "attached");
    if (attached.status !== "attached") return;
    assert.equal(attached.resultIndex.availableEntryCount, SEARCH_MAX_RESULT_INDEX_ENTRIES + 1);
    assert.equal(attached.resultIndex.returnedEntryCount, SEARCH_MAX_RESULT_INDEX_ENTRIES);
    assert.equal(attached.resultIndex.complete, false);
    assert.deepEqual(
        attached.resultIndex.entries.map((entry) => entry.rank),
        Array.from({ length: SEARCH_MAX_RESULT_INDEX_ENTRIES }, (_, index) => index + 1),
    );
});

test("compact result index truncates only between UTF-8 entries", () => {
    const orderedResults = Array.from({ length: 20 }, (_, index) => groupedResult({
        index,
        displayLabel: `${index}-${"🙂".repeat(1_000)}`,
    }));
    const attached = attachCompactSearchResultIndex({
        envelope: baseEnvelope([]),
        orderedResults,
        rankedSetDigest: RANKED_SET_DIGEST,
        maxResponseBytes: 128 * 1024,
    });

    assert.equal(attached.status, "attached");
    if (attached.status !== "attached") return;
    assert.equal(attached.resultIndex.returnedEntryCount > 0, true);
    assert.equal(attached.resultIndex.returnedEntryCount < orderedResults.length, true);
    assert.equal(attached.resultIndex.complete, false);
    assert.equal(
        Buffer.byteLength(JSON.stringify(attached.resultIndex), "utf8")
            <= SEARCH_MAX_RESULT_INDEX_UTF8_BYTES,
        true,
    );
    for (const [index, entry] of attached.resultIndex.entries.entries()) {
        assert.equal(entry.displayLabel, orderedResults[index]!.displayLabel);
        assert.equal(Buffer.from(entry.displayLabel, "utf8").toString("utf8"), entry.displayLabel);
    }
});

test("compact result index obeys the remaining complete-response budget", () => {
    const orderedResults = [
        groupedResult({ index: 0, displayLabel: "first" }),
        groupedResult({ index: 1, displayLabel: "second" }),
    ];
    const envelope = baseEnvelope([]);
    const complete = attachCompactSearchResultIndex({
        envelope,
        orderedResults,
        rankedSetDigest: RANKED_SET_DIGEST,
        maxResponseBytes: 128 * 1024,
    });
    assert.equal(complete.status, "attached");
    if (complete.status !== "attached") return;
    const oneEntryIndex = {
        ...complete.resultIndex,
        returnedEntryCount: 1,
        complete: false,
        entries: complete.resultIndex.entries.slice(0, 1),
    };
    const oneEntryBytes = Buffer.byteLength(JSON.stringify({
        ...envelope,
        resultIndex: oneEntryIndex,
    }), "utf8");

    const attached = attachCompactSearchResultIndex({
        envelope,
        orderedResults,
        rankedSetDigest: RANKED_SET_DIGEST,
        maxResponseBytes: oneEntryBytes,
    });

    assert.equal(attached.status, "attached");
    if (attached.status !== "attached") return;
    assert.equal(attached.resultIndex.returnedEntryCount, 1);
    assert.equal(attached.resultIndex.complete, false);
    assert.equal(Buffer.byteLength(JSON.stringify(attached.envelope), "utf8") <= oneEntryBytes, true);
});

test("compact result index preserves the base result page and fails closed when metadata cannot fit", () => {
    const initialResults = [groupedResult({ index: 0 })];
    const envelope = baseEnvelope(initialResults);
    const before = JSON.stringify(envelope);

    const attached = attachCompactSearchResultIndex({
        envelope,
        orderedResults: [groupedResult({ index: 1 }), groupedResult({ index: 2 })],
        rankedSetDigest: RANKED_SET_DIGEST,
        maxResponseBytes: 128 * 1024,
    });
    assert.equal(attached.status, "attached");
    if (attached.status !== "attached") return;
    assert.strictEqual(attached.envelope.results, envelope.results);
    assert.equal(JSON.stringify(envelope), before);

    const notAdmissible = attachCompactSearchResultIndex({
        envelope,
        orderedResults: [groupedResult({ index: 1 })],
        rankedSetDigest: RANKED_SET_DIGEST,
        maxResponseBytes: Buffer.byteLength(before, "utf8"),
    });
    assert.equal(notAdmissible.status, "not_admissible");
    assert.strictEqual(notAdmissible.envelope, envelope);
    assert.equal(JSON.stringify(envelope), before);
});
