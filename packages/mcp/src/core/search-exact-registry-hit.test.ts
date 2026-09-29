import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolRecord } from "@satori-code/core";
import { buildExactRegistryHitEnvelope } from "./search-exact-registry-hit.js";
import { SEARCH_RESULT_SET_DIGEST_PLACEHOLDER } from "./search-constants.js";
import type { SearchNavigationHelpers } from "./search-navigation.js";

const navigationHelpers: SearchNavigationHelpers = {
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    sanitizeIndexedRelativeFilePath: (relativeFilePath) => relativeFilePath.replace(/\\/g, "/"),
    isCallGraphLanguageSupported: () => true,
    getOutlineStatusForLanguage: () => "ok",
};

function symbol(index: number): SymbolRecord {
    return {
        symbolKey: `symbol-key-${index}`,
        symbolInstanceId: `symbol-instance-${index}`,
        language: "typescript",
        kind: "function",
        name: `owner${index}`,
        qualifiedName: `owner${index}`,
        label: `function owner${index}()`,
        file: `src/owner-${index}.ts`,
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: `hash-${index}`,
        extractorVersion: "v1",
    } as SymbolRecord;
}

test("exact registry retains the complete frozen order behind a compact first page", () => {
    const input: Parameters<typeof buildExactRegistryHitEnvelope>[0] = {
        codebaseRoot: "/repo",
        absolutePath: "/repo",
        query: "who calls owner0",
        scope: "runtime",
        groupBy: "symbol",
        limit: 16,
        disclosureLimit: 10,
        includeResultIndex: false,
        maxResponseBytes: 128 * 1024,
        freshnessDecision: {
            mode: "skipped_recent",
            checkedAt: "2026-01-01T00:00:00.000Z",
            thresholdMs: 1,
        },
        freshnessSummary: {
            syncMode: "skipped_recent",
            lastSyncAt: null,
            changedFileCount: 0,
            gitDirtyFilesConsidered: false,
            changedFilesBoostApplied: false,
            changedFilesBoostSkippedForLargeChangeSet: false,
        },
        matches: Array.from({ length: 16 }, (_, index) => ({
            symbol: symbol(index),
            preview: `owner ${index}`,
        })),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: { relationshipReady: true },
        debugMode: "none",
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
        partialIndexSearchWarnings: [],
        dirtyFilesNotFreshened: false,
        changedFilesBoostSkippedForLargeChangeSet: false,
        buildNoiseMitigationHint: () => undefined,
        buildGeneratedArtifactsVerificationHint: () => undefined,
    };
    const built = buildExactRegistryHitEnvelope(input);

    assert.ok(built);
    assert.equal(built.kind, "ok");
    if (built.kind !== "ok") return;
    assert.equal(built.envelope.resultMode, "grouped");
    assert.equal(built.envelope.results.length, 10);
    assert.deepEqual(built.envelope.resultCounts, {
        requestedTotal: 16,
        effectiveFrozenTotal: 16,
        availableGroupCount: 16,
        returnedGroupCount: 10,
        remainingGroupCount: 6,
    });
    assert.equal(built.envelope.continuation?.nextOffset, 10);
    assert.equal(built.envelope.continuation?.remainingGroupCount, 6);
    assert.equal(built.envelope.rankedSetDigest, SEARCH_RESULT_SET_DIGEST_PLACEHOLDER);
    assert.equal(built.resultSet?.orderedResults.length, 16);
    assert.equal(built.resultSet?.initialReturnedCount, 10);

    const completeIndexed = buildExactRegistryHitEnvelope({
        ...input,
        limit: 5,
        disclosureLimit: 5,
        includeResultIndex: true,
        matches: input.matches.slice(0, 1),
    });
    assert.ok(completeIndexed);
    assert.equal(completeIndexed.kind, "ok");
    if (completeIndexed.kind !== "ok") return;
    assert.equal(completeIndexed.envelope.resultMode, "grouped");
    assert.equal(completeIndexed.envelope.continuation, undefined);
    assert.equal(completeIndexed.resultSet?.orderedResults.length, 1);
});
