import test from "node:test";
import assert from "node:assert/strict";
import type { SymbolRecord } from "@zokizuan/satori-core";
import {
    buildExactRegistryGroupResult,
    buildGroupedSymbolSearchResult,
} from "./search-group-results.js";
import { buildSearchGroupRecommendedAction } from "./search-response-helpers.js";
import type { SearchNavigationHelpers, SearchNavigationState } from "./search-navigation.js";

const helpers: SearchNavigationHelpers = {
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    sanitizeIndexedRelativeFilePath: (relativeFilePath) => relativeFilePath.replace(/\\/g, "/"),
    isCallGraphLanguageSupported: (language) => language === "typescript" || language === "javascript",
    getOutlineStatusForLanguage: () => "ok",
};

const navState: SearchNavigationState = {
    relationshipReady: true,
    relationshipBuiltAt: "2026-01-01T00:00:00.000Z",
};

function makeSymbol(overrides?: Partial<SymbolRecord>): SymbolRecord {
    return {
        symbolKey: "symkey_check",
        symbolInstanceId: "syminst_check",
        language: "typescript",
        kind: "method",
        name: "checkMutation",
        qualifiedName: "Gate.checkMutation",
        label: "method checkMutation()",
        file: "src/gate.ts",
        span: { startLine: 2, endLine: 4 },
        parentQualifiedNamePath: ["Gate"],
        fileHash: "hash",
        extractorVersion: "v1",
        ...overrides,
    } as SymbolRecord;
}

function groupedCandidate() {
    return {
        result: {
            relativePath: "src/gate.ts",
            language: "typescript",
            symbolLabel: "method checkMutation()",
            symbolKind: "method",
            content: "checkMutation() {}",
        },
        finalScore: 1,
        pathCategory: "core" as const,
        pathMultiplier: 1,
        changedFilesMultiplier: 1,
        agentFitMultiplier: 1,
        agentFitReason: "implementation_symbol",
        passesMatchedMust: true,
        exactLexicalMatch: true,
        exactMatchPinned: false,
        rerankAdjusted: false,
        retrievalPasses: ["primary"],
        backendScoreKindsSeen: ["rrf_fusion" as const],
        lexicalScore: 1,
    };
}

test("ranking result diagnostics omit freshness and graph evidence until full mode", () => {
    const build = (debugMode: "ranking" | "full") => buildExactRegistryGroupResult({
        symbol: makeSymbol(),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        debugMode,
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });
    const ranking = build("ranking");
    const full = build("full");
    assert.ok(ranking?.debug);
    assert.equal(ranking.debug.freshness, undefined);
    assert.equal(ranking.debug.graphEvidence, undefined);
    assert.ok(full?.debug?.freshness);
    assert.ok(full?.debug?.graphEvidence);
});

test("exact registry result publishes one concrete target and compact graph verification term", () => {
    const result = buildExactRegistryGroupResult({
        symbol: makeSymbol(),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        debugMode: 'none',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.deepEqual(result.target, {
        file: "src/gate.ts",
        span: { startLine: 2, endLine: 4 },
        symbolId: "syminst_check",
    });
    assert.deepEqual(result.navigation, {
        graph: "ready",
        inbound: "verify",
        callerSearchTerm: "checkMutation",
    });
    const serialized = JSON.stringify(result);
    for (const removed of [
        "callGraphHint",
        "nextActions",
        "navigationFallback",
        "inboundRecovery",
        "fallbacks",
        "capabilities",
        "recommendedNextAction",
    ]) {
        assert.equal(serialized.includes(`\"${removed}\"`), false, removed);
    }
});

test("unsupported graph language keeps exact read identity without a caller term", () => {
    const result = buildExactRegistryGroupResult({
        symbol: makeSymbol({ language: "go" }),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        debugMode: 'none',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.equal(result.target.symbolId, "syminst_check");
    assert.deepEqual(result.navigation, { graph: "unsupported_language" });
});

test("stale chunk metadata identity is not promoted into the public target", () => {
    const result = buildGroupedSymbolSearchResult({
        representative: groupedCandidate(),
        previewSpan: { startLine: 2, endLine: 4 },
        indexedAt: "2026-01-01T00:00:00.000Z",
        ownerSource: "owner_metadata",
        ownerSymbolInstanceId: "stale_chunk_identity",
        ownerSymbolKey: "stale_symbol_key",
        ownerSymbolKind: "method",
        registryLoaded: true,
        navigationState: navState,
        chunkCount: 1,
        semanticMatch: "medium",
        spanValidation: "not_applicable",
        debugMode: 'none',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.deepEqual(result.target, {
        file: "src/gate.ts",
        span: { startLine: 2, endLine: 4 },
    });
    assert.deepEqual(result.navigation, { graph: "stale_symbol_ref" });
});

test("cross-file registry ownership is demoted to the representative span", () => {
    const result = buildGroupedSymbolSearchResult({
        representative: groupedCandidate(),
        previewSpan: { startLine: 2, endLine: 4 },
        indexedAt: "2026-01-01T00:00:00.000Z",
        ownerSource: "owner_metadata",
        ownerSymbolInstanceId: "syminst_other",
        ownerSymbolKey: "symkey_other",
        ownerSymbolKind: "method",
        registrySymbol: makeSymbol({
            file: "src/other.ts",
            symbolKey: "symkey_other",
            symbolInstanceId: "syminst_other",
        }),
        registryLoaded: true,
        navigationState: navState,
        chunkCount: 1,
        semanticMatch: "medium",
        spanValidation: "not_applicable",
        debugMode: 'none',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.deepEqual(result.target, {
        file: "src/gate.ts",
        span: { startLine: 2, endLine: 4 },
    });
    assert.equal(result.quality.owner, "low");
    assert.deepEqual(result.navigation, { graph: "stale_symbol_ref" });
});

test("same-file registry ownership is demoted when the symbol does not own the evidence span", () => {
    const result = buildGroupedSymbolSearchResult({
        representative: groupedCandidate(),
        previewSpan: { startLine: 20, endLine: 24 },
        indexedAt: "2026-01-01T00:00:00.000Z",
        ownerSource: "owner_metadata",
        ownerSymbolInstanceId: "syminst_unrelated",
        ownerSymbolKey: "symkey_unrelated",
        ownerSymbolKind: "method",
        registrySymbol: makeSymbol({
            span: { startLine: 2, endLine: 4 },
            symbolKey: "symkey_unrelated",
            symbolInstanceId: "syminst_unrelated",
        }),
        registryLoaded: true,
        navigationState: navState,
        chunkCount: 1,
        semanticMatch: "medium",
        spanValidation: "not_applicable",
        debugMode: 'none',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.deepEqual(result.target, {
        file: "src/gate.ts",
        span: { startLine: 20, endLine: 24 },
    });
    assert.equal(result.quality.owner, "low");
    assert.deepEqual(result.navigation, { graph: "stale_symbol_ref" });
});

test("oversized exact registry symbols publish a bounded first-read window", () => {
    const result = buildExactRegistryGroupResult({
        symbol: makeSymbol({ span: { startLine: 10, endLine: 2000 } }),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        debugMode: 'none',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.deepEqual(result.evidenceSpan, { startLine: 10, endLine: 49 });
    assert.deepEqual(
        buildSearchGroupRecommendedAction("/repo", result)?.args,
        {
            path: "/repo/src/gate.ts",
            start_line: 10,
            end_line: 49,
        },
    );
});

test("exact registry previews use only caller-supplied current source evidence", () => {
    const result = buildExactRegistryGroupResult({
        symbol: makeSymbol({ qualifiedName: "Gate.checkMutation" }),
        preview: "return currentSource;",
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        debugMode: 'none',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.equal(result.preview, "return currentSource;");
    assert.doesNotMatch(result.preview, /Gate\.checkMutation/);
});

test("debug graph evidence is omitted when navigation is explicitly suppressed", () => {
    const result = buildExactRegistryGroupResult({
        symbol: makeSymbol(),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        graphUnavailableReasonOverride: "partial_index_navigation_unavailable",
        debugMode: 'full',
        now: helpers.now,
        previewMaxBytes: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result);
    assert.deepEqual(result.navigation, {
        graph: "partial_index_navigation_unavailable",
    });
    assert.equal(result.debug?.graphEvidence, undefined);
});
