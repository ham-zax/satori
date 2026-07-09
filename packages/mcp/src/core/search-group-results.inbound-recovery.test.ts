import test from "node:test";
import assert from "node:assert/strict";
import {
    buildExactRegistryGroupResult,
    buildGroupedSymbolSearchResult,
} from "./search-group-results.js";
import type { SearchNavigationHelpers, SearchNavigationState } from "./search-navigation.js";
import type { SymbolRecord } from "@zokizuan/satori-core";

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

test("exact registry group attaches inboundRecovery when call graph supported (callers low)", () => {
    const result = buildExactRegistryGroupResult({
        codebaseRoot: "/repo",
        query: "checkMutation",
        scope: "runtime",
        groupBy: "symbol",
        symbol: makeSymbol(),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        sidecarReadyForOutline: true,
        debug: false,
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
        previewMaxChars: 200,
        navigationHelpers: helpers,
    });

    assert.equal(result.callGraphHint.supported, true);
    assert.equal(result.capabilities.callGraphCallers, "low");
    assert.ok(result.inboundRecovery);
    assert.equal(result.inboundRecovery?.tool, "search_codebase");
    assert.match(result.inboundRecovery?.args.query || "", /^must:checkMutation checkMutation$/);
    assert.ok(!result.inboundRecovery?.args.query.includes("path:"));
    assert.equal(result.fallbacks?.[0]?.tool, "search_codebase");
    assert.match(result.fallbacks?.[0]?.args.query as string, /must:checkMutation/);
});

test("grouped result omits inboundRecovery when call graph unsupported", () => {
    const result = buildExactRegistryGroupResult({
        codebaseRoot: "/repo",
        query: "checkMutation",
        scope: "runtime",
        groupBy: "symbol",
        symbol: makeSymbol({ language: "go" }),
        indexedAt: "2026-01-01T00:00:00.000Z",
        navigationState: navState,
        sidecarReadyForOutline: true,
        debug: false,
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
        previewMaxChars: 200,
        navigationHelpers: helpers,
    });

    assert.equal(result.callGraphHint.supported, false);
    assert.equal(result.inboundRecovery, undefined);
});

test("buildGroupedSymbolSearchResult includes inboundRecovery for supported low callers", () => {
    const result = buildGroupedSymbolSearchResult({
        codebaseRoot: "/repo",
        query: "checkMutation",
        scope: "runtime",
        groupBy: "symbol",
        representative: {
            result: {
                relativePath: "src/gate.ts",
                language: "typescript",
                symbolLabel: "method checkMutation()",
                symbolKind: "method",
                content: "checkMutation() {}",
            },
            finalScore: 1,
            pathCategory: "core",
            pathMultiplier: 1,
            changedFilesMultiplier: 1,
            agentFitMultiplier: 1,
            agentFitReason: "implementation_symbol",
            passesMatchedMust: true,
            exactLexicalMatch: true,
            exactMatchPinned: false,
            rerankAdjusted: false,
            retrievalPasses: ["primary"],
            backendScoreKindsSeen: ["rrf_fusion"],
            lexicalScore: 1,
        },
        previewSpan: { startLine: 2, endLine: 4 },
        indexedAt: "2026-01-01T00:00:00.000Z",
        ownerSource: "owner_metadata",
        ownerSymbolInstanceId: "syminst_check",
        ownerSymbolKey: "symkey_check",
        ownerSymbolKind: "method",
        registrySymbol: makeSymbol(),
        registryLoaded: true,
        navigationState: navState,
        sidecarReadyForOutline: true,
        chunkCount: 1,
        semanticMatch: "medium",
        spanValidation: "not_applicable",
        debug: false,
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
        previewMaxChars: 200,
        navigationHelpers: helpers,
    });

    assert.ok(result.inboundRecovery);
    assert.match(result.inboundRecovery?.args.query || "", /must:checkMutation/);
    assert.ok(!result.inboundRecovery?.args.query.includes("path:src/gate.ts"));
});
