import test from "node:test";
import assert from "node:assert/strict";
import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import {
    buildGroupedSymbolSearchResult,
    buildVisibleGroupedSearchResults,
} from "./search-group-results.js";
import { resolveSearchOwnerFromRegistry } from "./search-owner-resolution.js";
import { buildSearchGroupRecommendedAction } from "./search-response-helpers.js";

const navigationHelpers = {
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    sanitizeIndexedRelativeFilePath: (file: string) => file,
    isCallGraphLanguageSupported: () => true,
    getOutlineStatusForLanguage: () => "ok" as const,
};

function candidate(file: string, startLine: number, endLine: number, score: number) {
    return {
        result: {
            relativePath: file,
            language: "typescript",
            symbolLabel: "function staleOwner()",
            symbolKind: "function",
            content: `return ${file};`,
            startLine,
            endLine,
        },
        finalScore: score,
        pathCategory: "core" as const,
        pathMultiplier: 1,
        changedFilesMultiplier: 1,
        agentFitMultiplier: 1,
        agentFitReason: "implementation_symbol",
        passesMatchedMust: true,
        exactLexicalMatch: false,
        exactMatchPinned: false,
        rerankAdjusted: false,
        retrievalPasses: ["primary"],
        backendScoreKindsSeen: ["dense_similarity" as const],
        lexicalScore: 0,
    };
}

test("registry owner metadata is rejected when its symbol is in another evidence file", () => {
    const staleOwner = {
        symbolKey: "stale_owner_key",
        symbolInstanceId: "stale_owner_instance",
        language: "typescript",
        kind: "function",
        name: "staleOwner",
        qualifiedName: "staleOwner",
        label: "function staleOwner()",
        file: "src/b.ts",
        span: { startLine: 20, endLine: 25 },
        parentQualifiedNamePath: [],
        fileHash: "hash",
        extractorVersion: "v1",
    } satisfies SymbolRecord;
    const registry = {
        symbolsByInstanceId: new Map([[staleOwner.symbolInstanceId, staleOwner]]),
        symbolsByFile: new Map<string, SymbolRecord[]>([["src/a.ts", []]]),
    } as SymbolRegistry;

    const resolved = resolveSearchOwnerFromRegistry({
        result: {
            relativePath: "src/a.ts",
            startLine: 10,
            endLine: 15,
            language: "typescript",
            content: "return true;",
            ownerSymbolKey: staleOwner.symbolKey,
            ownerSymbolInstanceId: staleOwner.symbolInstanceId,
        },
        registry,
        sanitizeIndexedRelativeFilePath: (file) => file,
        hasTokenBoundaryMatch: () => false,
        isWriterActionTerm: () => false,
    });

    assert.deepEqual(resolved, {});
});

test("registry owner metadata requires full evidence containment", () => {
    const owner = {
        symbolKey: "owner_key",
        symbolInstanceId: "owner_instance",
        language: "typescript",
        kind: "method",
        name: "run",
        qualifiedName: "Service.run",
        label: "method run()",
        file: "src/service.ts",
        span: { startLine: 250, endLine: 260 },
        parentQualifiedNamePath: ["Service"],
        fileHash: "hash",
        extractorVersion: "v1",
    } satisfies SymbolRecord;
    const registry = {
        symbolsByInstanceId: new Map([[owner.symbolInstanceId, owner]]),
        symbolsByFile: new Map<string, SymbolRecord[]>([[owner.file, [owner]]]),
    } as SymbolRegistry;
    const resolve = (startLine: number, endLine: number) => resolveSearchOwnerFromRegistry({
        result: {
            relativePath: owner.file,
            startLine,
            endLine,
            language: "typescript",
            content: "run();",
            ownerSymbolKey: owner.symbolKey,
            ownerSymbolInstanceId: owner.symbolInstanceId,
        },
        registry,
        sanitizeIndexedRelativeFilePath: (file) => file,
        hasTokenBoundaryMatch: () => false,
        isWriterActionTerm: () => false,
    });

    assert.deepEqual(resolve(1, 300), {});
    assert.deepEqual(resolve(240, 250), {});
    assert.deepEqual(resolve(255, 270), {});
    assert.deepEqual(resolve(252, 258), {
        ownerSymbolKey: owner.symbolKey,
        ownerSymbolInstanceId: owner.symbolInstanceId,
        symbolKind: owner.kind,
        ownerSource: "owner_metadata",
        ownerProof: {
            symbolInstanceId: owner.symbolInstanceId,
            basis: "lines",
        },
    });
});

test("registry owner byte evidence fails closed unless both ordered safe pairs prove containment", () => {
    const baseOwner = {
        symbolKey: "byte_owner_key",
        symbolInstanceId: "byte_owner_instance",
        language: "typescript",
        kind: "method",
        name: "run",
        qualifiedName: "Service.run",
        label: "method run()",
        file: "src/service.ts",
        span: { startLine: 10, endLine: 20, startByte: 100, endByte: 200 },
        parentQualifiedNamePath: ["Service"],
        fileHash: "hash",
        extractorVersion: "v1",
    } satisfies SymbolRecord;
    const resolve = (
        resultBytes: { startByte?: unknown; endByte?: unknown },
        ownerSpan: SymbolRecord["span"] = baseOwner.span,
    ) => {
        const owner = { ...baseOwner, span: ownerSpan } satisfies SymbolRecord;
        const registry = {
            symbolsByInstanceId: new Map([[owner.symbolInstanceId, owner]]),
            symbolsByFile: new Map<string, SymbolRecord[]>([[owner.file, [owner]]]),
        } as SymbolRegistry;
        return resolveSearchOwnerFromRegistry({
            result: {
                relativePath: owner.file,
                startLine: 12,
                endLine: 18,
                ...resultBytes,
                language: "typescript",
                content: "run();",
                ownerSymbolKey: owner.symbolKey,
                ownerSymbolInstanceId: owner.symbolInstanceId,
            },
            registry,
            sanitizeIndexedRelativeFilePath: (file) => file,
            hasTokenBoundaryMatch: () => false,
            isWriterActionTerm: () => false,
        });
    };

    const expectedOwner = {
        ownerSymbolKey: baseOwner.symbolKey,
        ownerSymbolInstanceId: baseOwner.symbolInstanceId,
        symbolKind: baseOwner.kind,
        ownerSource: "owner_metadata",
        ownerProof: {
            symbolInstanceId: baseOwner.symbolInstanceId,
            basis: "bytes",
        },
    };
    assert.deepEqual(resolve({ startByte: 120, endByte: 150 }), expectedOwner);
    assert.deepEqual(
        resolve(
            { startByte: 120, endByte: 150 },
            { startLine: 30, endLine: 40, startByte: 100, endByte: 200 },
        ),
        expectedOwner,
        "valid byte containment is authoritative even when line spans disagree",
    );
    assert.deepEqual(
        resolve({ startByte: 50, endByte: 250 }),
        {},
        "valid non-contained bytes cannot fall back to contained lines",
    );

    const invalidCases: Array<{
        name: string;
        resultBytes: { startByte?: unknown; endByte?: unknown };
        ownerSpan?: SymbolRecord["span"];
    }> = [
        { name: "partial chunk bytes", resultBytes: { startByte: 120 } },
        { name: "malformed chunk bytes", resultBytes: { startByte: "120", endByte: 150 } },
        { name: "negative chunk bytes", resultBytes: { startByte: -1, endByte: 150 } },
        { name: "unsafe chunk bytes", resultBytes: { startByte: 120, endByte: Number.MAX_SAFE_INTEGER + 1 } },
        { name: "reversed chunk bytes", resultBytes: { startByte: 150, endByte: 120 } },
        {
            name: "partial owner bytes",
            resultBytes: { startByte: 120, endByte: 150 },
            ownerSpan: { startLine: 10, endLine: 20, startByte: 100 },
        },
        {
            name: "negative owner bytes",
            resultBytes: { startByte: 120, endByte: 150 },
            ownerSpan: { startLine: 10, endLine: 20, startByte: -1, endByte: 200 },
        },
        {
            name: "unsafe owner bytes",
            resultBytes: { startByte: 120, endByte: 150 },
            ownerSpan: { startLine: 10, endLine: 20, startByte: 100, endByte: Number.MAX_SAFE_INTEGER + 1 },
        },
        {
            name: "reversed owner bytes",
            resultBytes: { startByte: 120, endByte: 150 },
            ownerSpan: { startLine: 10, endLine: 20, startByte: 200, endByte: 100 },
        },
        {
            name: "chunk bytes without owner bytes",
            resultBytes: { startByte: 120, endByte: 150 },
            ownerSpan: { startLine: 10, endLine: 20 },
        },
        {
            name: "owner bytes without chunk bytes",
            resultBytes: {},
        },
    ];
    for (const invalidCase of invalidCases) {
        assert.deepEqual(
            resolve(invalidCase.resultBytes, invalidCase.ownerSpan),
            {},
            invalidCase.name,
        );
    }
});

test("grouped target publication preserves byte-authoritative ownership and rejects contradictory bytes", () => {
    const owner = {
        symbolKey: "byte_group_owner_key",
        symbolInstanceId: "byte_group_owner_instance",
        language: "typescript",
        kind: "method",
        name: "run",
        qualifiedName: "Service.run",
        label: "method run()",
        file: "src/service.ts",
        span: { startLine: 30, endLine: 40, startByte: 100, endByte: 200 },
        parentQualifiedNamePath: ["Service"],
        fileHash: "hash",
        extractorVersion: "v1",
    } satisfies SymbolRecord;
    const registry = {
        symbolsByInstanceId: new Map([[owner.symbolInstanceId, owner]]),
        symbolsByFile: new Map<string, SymbolRecord[]>([[owner.file, [owner]]]),
    } as SymbolRegistry;
    const build = (startByte: number, endByte: number) => buildVisibleGroupedSearchResults({
        scored: [{
            ...candidate(owner.file, 12, 18, 0.9),
            result: {
                ...candidate(owner.file, 12, 18, 0.9).result,
                startByte,
                endByte,
                ownerSymbolKey: owner.symbolKey,
                ownerSymbolInstanceId: owner.symbolInstanceId,
            },
        }],
        codebaseRoot: "/repo",
        groupBy: "symbol",
        limit: 5,
        queryPlan: {
            intent: "semantic",
            referenceSeeking: false,
            exactMatchPinningEnabled: false,
        },
        mustMatchesFirst: false,
        registry,
        navigationState: { relationshipReady: false },
        debug: false,
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: (result) => resolveSearchOwnerFromRegistry({
            result,
            registry,
            sanitizeIndexedRelativeFilePath: (file) => file,
            hasTokenBoundaryMatch: () => false,
            isWriterActionTerm: () => false,
        }),
    });

    const contained = build(120, 150);
    assert.equal(contained.visibleResults[0]?.target.symbolId, owner.symbolInstanceId);
    const notContained = build(50, 250);
    assert.equal(notContained.visibleResults[0]?.target.symbolId, undefined);
});

test("a broad same-file chunk cannot publish a nested registry symbol target", () => {
    const nested = {
        symbolKey: "nested_key",
        symbolInstanceId: "nested_instance",
        language: "typescript",
        kind: "method",
        name: "run",
        qualifiedName: "Service.run",
        label: "method run()",
        file: "src/service.ts",
        span: { startLine: 250, endLine: 260 },
        parentQualifiedNamePath: ["Service"],
        fileHash: "hash",
        extractorVersion: "v1",
    } satisfies SymbolRecord;
    const result = buildGroupedSymbolSearchResult({
        representative: candidate("src/service.ts", 1, 300, 0.9),
        previewSpan: { startLine: 1, endLine: 300 },
        indexedAt: null,
        ownerSource: "owner_metadata",
        ownerSymbolKey: nested.symbolKey,
        ownerSymbolInstanceId: nested.symbolInstanceId,
        ownerSymbolKind: nested.kind,
        registrySymbol: nested,
        registryLoaded: true,
        navigationState: { relationshipReady: false },
        chunkCount: 1,
        semanticMatch: "medium",
        spanValidation: "not_applicable",
        debug: true,
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
    });

    assert.ok(result);
    assert.equal(result.target.symbolId, undefined);
    assert.deepEqual(result.target.span, { startLine: 1, endLine: 300 });
});

test("cross-file stale owner metadata cannot merge evidence before scoring", () => {
    const result = buildVisibleGroupedSearchResults({
        scored: [
            candidate("src/a.ts", 10, 15, 0.9),
            candidate("src/b.ts", 20, 25, 0.8),
        ],
        codebaseRoot: "/repo",
        groupBy: "symbol",
        limit: 5,
        queryPlan: {
            intent: "semantic",
            referenceSeeking: false,
            exactMatchPinningEnabled: false,
        },
        mustMatchesFirst: false,
        navigationState: { relationshipReady: false },
        debug: true,
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: () => ({
            ownerSymbolKey: "stale_owner_key",
            ownerSymbolInstanceId: "stale_owner_instance",
            symbolKind: "function",
            ownerSource: "owner_metadata",
        }),
    });

    assert.equal(result.visibleResults.length, 2);
    assert.deepEqual(
        result.visibleResults.map((group) => group.target.file).sort(),
        ["src/a.ts", "src/b.ts"],
    );
    for (const group of result.visibleResults) {
        assert.equal(group.evidenceChunks, undefined);
        assert.equal(group.debug?.representativeChunkCount, 1);
        assert.equal(group.debug?.symbolAggregation?.supportBoost, Math.min(Math.log1p(1) * 0.01, 0.03));
    }
});

test("ordinary grouped evidence publishes a bounded deterministic window", () => {
    const result = buildVisibleGroupedSearchResults({
        scored: [candidate("src/large.ts", 100, 900, 0.9)],
        codebaseRoot: "/repo",
        groupBy: "symbol",
        limit: 5,
        queryPlan: {
            intent: "semantic",
            referenceSeeking: false,
            exactMatchPinningEnabled: false,
        },
        mustMatchesFirst: false,
        navigationState: { relationshipReady: false },
        debug: false,
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: () => ({}),
    });

    assert.equal(result.visibleResults.length, 1);
    assert.deepEqual(result.visibleResults[0]?.target.span, { startLine: 100, endLine: 900 });
    assert.deepEqual(result.visibleResults[0]?.evidenceSpan, { startLine: 100, endLine: 139 });
    assert.deepEqual(
        buildSearchGroupRecommendedAction("/repo", result.visibleResults[0]!)?.args,
        {
            path: "/repo/src/large.ts",
            start_line: 100,
            end_line: 139,
        },
    );
});
