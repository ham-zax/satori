import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolRecord } from "@satori-code/core";
import {
    EXACT_HYDRATION_MAX_LINES,
    EXACT_HYDRATION_MAX_SOURCE_BYTES,
    attachHydratedExactSource,
    buildExactRegistryHitEnvelope,
    buildHydratedExactSource,
} from "./search-exact-registry-hit.js";
import { SEARCH_RESULT_SET_DIGEST_PLACEHOLDER } from "./search-constants.js";
import { attachCompactSearchResultIndex } from "./search-result-index.js";
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

test("oversized exact-registry hit routes recommendedNextAction to open_symbol instead of a 40-line span", () => {
    const oversized = {
        ...symbol(0),
        span: { startLine: 227, endLine: 660 },
    } as SymbolRecord;
    const built = buildExactRegistryHitEnvelope({
        codebaseRoot: "/repo",
        absolutePath: "/repo",
        query: "owner0",
        scope: "runtime",
        groupBy: "symbol",
        limit: 10,
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
        matches: [{ symbol: oversized, preview: "function owner0()" }],
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
    });

    assert.ok(built);
    assert.equal(built.kind, "ok");
    if (built.kind !== "ok") return;
    assert.equal(built.envelope.resultMode, "grouped");
    if (built.envelope.resultMode !== "grouped") return;
    assert.equal(built.envelope.results[0]?.evidenceSpan, undefined);
    assert.equal(built.envelope.recommendedNextAction?.tool, "read_file");
    assert.deepEqual(built.envelope.recommendedNextAction?.args, {
        path: "/repo/src/owner-0.ts",
        mode: "plain",
        codebaseRoot: "/repo",
        open_symbol: {
            contractVersion: 2,
            symbolId: "symbol-instance-0",
            context: { preset: "definition" },
        },
    });
});

test("buildHydratedExactSource bounds oversized and multi-byte symbols cleanly", () => {
    const smallSymbol = {
        ...symbol(0),
        span: { startLine: 10, endLine: 12 },
    } as SymbolRecord;
    const smallSource = "export function owner0() {\n  return 42;\n}";
    const smallHydrated = buildHydratedExactSource({
        symbol: smallSymbol,
        sourceContent: smallSource,
    });
    assert.deepEqual(smallHydrated, {
        file: "src/owner-0.ts",
        symbolId: "symbol-instance-0",
        span: { startLine: 10, endLine: 12 },
        returnedSpan: { startLine: 10, endLine: 12 },
        completeSymbolReturned: true,
        truncated: false,
        content: smallSource,
        sourceAuthority: "publication_hash_matched",
    });

    const oversizedLines = Array.from({ length: 434 }, (_, i) => `const line${i} = ${i};`);
    const oversizedSymbol = {
        ...symbol(0),
        span: { startLine: 227, endLine: 660 },
    } as SymbolRecord;
    const oversizedHydrated = buildHydratedExactSource({
        symbol: oversizedSymbol,
        sourceContent: oversizedLines.join("\n"),
    });
    assert.ok(oversizedHydrated);
    assert.equal(oversizedHydrated.completeSymbolReturned, false);
    assert.equal(oversizedHydrated.truncated, true);
    assert.deepEqual(oversizedHydrated.span, { startLine: 227, endLine: 660 });
    assert.deepEqual(oversizedHydrated.returnedSpan, {
        startLine: 227,
        endLine: 227 + EXACT_HYDRATION_MAX_LINES - 1,
    });
    assert.ok(Buffer.byteLength(oversizedHydrated.content, "utf8") <= EXACT_HYDRATION_MAX_SOURCE_BYTES);

    const utf8Lines = Array.from({ length: 50 }, () => "漢".repeat(150)); // 450 UTF-8 bytes/line
    const utf8Symbol = {
        ...symbol(0),
        span: { startLine: 1, endLine: 50 },
    } as SymbolRecord;
    const utf8Hydrated = buildHydratedExactSource({
        symbol: utf8Symbol,
        sourceContent: utf8Lines.join("\n"),
    });
    assert.ok(utf8Hydrated);
    assert.equal(utf8Hydrated.completeSymbolReturned, false);
    assert.equal(utf8Hydrated.truncated, true);
    assert.ok(Buffer.byteLength(utf8Hydrated.content, "utf8") <= EXACT_HYDRATION_MAX_SOURCE_BYTES);
    assert.ok(utf8Hydrated.returnedSpan.endLine < 50);

    const singleOversizedLine = buildHydratedExactSource({
        symbol: { ...symbol(0), span: { startLine: 1, endLine: 1 } } as SymbolRecord,
        sourceContent: "x".repeat(EXACT_HYDRATION_MAX_SOURCE_BYTES + 1),
    });
    assert.equal(singleOversizedLine, undefined);
});

test("exact hydration preserves the finalized results, action, and requested result index under tight budgets", () => {
    const targetSymbol = {
        ...symbol(0),
        span: { startLine: 1, endLine: 10 },
    } as SymbolRecord;
    const sourceContent = Array.from({ length: 10 }, (_, i) => `export const row${i} = "${"a".repeat(80)}";`).join("\n");
    const hydrated = buildHydratedExactSource({ symbol: targetSymbol, sourceContent });
    assert.ok(hydrated);

    const baseInput: Parameters<typeof buildExactRegistryHitEnvelope>[0] = {
        codebaseRoot: "/repo",
        absolutePath: "/repo",
        query: "owner0",
        scope: "runtime",
        groupBy: "symbol",
        limit: 10,
        disclosureLimit: 10,
        includeResultIndex: false,
        maxResponseBytes: 48 * 1024,
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
        matches: [{ symbol: targetSymbol, preview: "function owner0()" }],
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

    const unhydrated = buildExactRegistryHitEnvelope(baseInput);
    assert.ok(unhydrated && unhydrated.kind === "ok" && unhydrated.envelope.resultMode === "grouped");
    const unhydratedBytes = Buffer.byteLength(JSON.stringify(unhydrated.envelope), "utf8");

    const tight = attachHydratedExactSource(unhydrated.envelope, hydrated, unhydratedBytes + 64);
    assert.equal(tight.hydratedExactSource, undefined);
    assert.equal(tight.results.length, 1);
    assert.equal(tight.results[0]?.target.symbolId, "symbol-instance-0");
    assert.ok(tight.recommendedNextAction);
    assert.deepEqual(tight, unhydrated.envelope);

    const indexed = attachCompactSearchResultIndex({
        envelope: unhydrated.envelope,
        orderedResults: unhydrated.envelope.results,
        rankedSetDigest: SEARCH_RESULT_SET_DIGEST_PLACEHOLDER,
        maxResponseBytes: baseInput.maxResponseBytes,
    });
    assert.equal(indexed.status, "attached");
    assert.equal(indexed.envelope.resultIndex?.entries.length, 1);
    const indexedBytes = Buffer.byteLength(JSON.stringify(indexed.envelope), "utf8");
    assert.deepEqual(attachHydratedExactSource(indexed.envelope, hydrated, indexedBytes), indexed.envelope);
    const attachedIndexed = attachHydratedExactSource(indexed.envelope, hydrated, baseInput.maxResponseBytes);
    assert.deepEqual(attachedIndexed.hydratedExactSource, hydrated);
    assert.deepEqual(attachedIndexed.resultIndex, indexed.envelope.resultIndex);
    assert.deepEqual(attachedIndexed.results, indexed.envelope.results);
    assert.equal(attachedIndexed.recommendedNextAction?.tool, "read_file");
    assert.deepEqual(
        (attachedIndexed.recommendedNextAction?.args as { open_symbol?: { context?: unknown } } | undefined)?.open_symbol?.context,
        { preset: "call_context", include: { source: false } },
    );
});
