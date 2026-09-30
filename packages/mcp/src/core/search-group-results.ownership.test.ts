import test from "node:test";
import assert from "node:assert/strict";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import {
    buildGroupedSymbolSearchResult,
    buildExactRegistryGroupResult,
    buildVisibleGroupedSearchResults,
} from "./search-group-results.js";
import { resolveSearchOwnerFromRegistry, type SearchOwnerResolutionInputResult } from "./search-owner-resolution.js";
import { buildSearchGroupRecommendedAction } from "./search-response-helpers.js";
import { projectGroupedResultV2 } from "./search-response-envelopes.js";
import type { SearchResultLike } from "./search-lexical-scoring.js";

const navigationHelpers = {
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    sanitizeIndexedRelativeFilePath: (file: string) => file,
    isCallGraphLanguageSupported: () => true,
    getOutlineStatusForLanguage: () => "ok" as const,
};

function candidate(
    file: string,
    startLine: number,
    endLine: number,
    score: number,
    overrides: Partial<{
        exactLexicalMatch: boolean;
        authoritativeRank: number;
        symbolLabel: string;
    }> = {},
) {
    return {
        result: {
            relativePath: file,
            language: "typescript",
            symbolLabel: overrides.symbolLabel || "function staleOwner()",
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
        exactLexicalMatch: overrides.exactLexicalMatch || false,
        exactMatchPinned: false,
        rerankAdjusted: false,
        retrievalPasses: ["primary"],
        backendScoreKindsSeen: ["dense_similarity" as const],
        entrypointOwnerScoreBoost: 0,
        entrypointOwnerScoreReason: "not_applicable",
        lexicalScore: 0,
        ...(overrides.authoritativeRank !== undefined
            ? { authoritativeRank: overrides.authoritativeRank }
            : {}),
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
    } as unknown as SymbolRegistry;

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
            } as unknown as SearchOwnerResolutionInputResult,
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
            } as unknown as SearchResultLike,
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
        debugMode: 'none',
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: (result) => resolveSearchOwnerFromRegistry({
            result: result as unknown as SearchOwnerResolutionInputResult,
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
        candidateIds: ["broad-service-chunk"],
        semanticMatch: "medium",
        spanValidation: "not_applicable",
        debugMode: 'full',
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
    });

    assert.ok(result);
    assert.equal(result.target.symbolId, undefined);
    assert.deepEqual(result.target.span, { startLine: 1, endLine: 40 });
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
        debugMode: 'full',
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
        assert.equal(group.debug?.symbolAggregation?.evidenceChunkCount, 1);
    }
});

test("native grouping chooses the representative by authoritative rank, not exactness", () => {
    const result = buildVisibleGroupedSearchResults({
        scored: [
            candidate("src/owner.ts", 10, 15, 0.1, {
                authoritativeRank: 1,
                symbolLabel: "function providerOwned()",
            }),
            candidate("src/owner.ts", 20, 25, 0.9, {
                authoritativeRank: 2,
                exactLexicalMatch: true,
                symbolLabel: "function exactButLowerRanked()",
            }),
        ],
        codebaseRoot: "/repo",
        groupBy: "symbol",
        limit: 5,
        queryPlan: {
            intent: "semantic",
            referenceSeeking: false,
            exactMatchPinningEnabled: true,
        },
        mustMatchesFirst: false,
        navigationState: { relationshipReady: false },
        debugMode: "none",
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: () => ({
            ownerSymbolKey: "owner-key",
            ownerSymbolInstanceId: "owner-instance",
            symbolKind: "function",
            ownerSource: "owner_metadata",
        }),
        orderAuthority: "reranker_order",
    });

    assert.equal(result.visibleResults.length, 1);
    assert.equal(result.visibleResults[0]?.displayLabel, "function providerOwned()");
});

test("ordinary grouped evidence publishes a bounded deterministic target", () => {
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
        debugMode: 'none',
        now: navigationHelpers.now,
        previewMaxBytes: 200,
        navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: () => ({}),
    });

    assert.equal(result.visibleResults.length, 1);
    assert.deepEqual(result.visibleResults[0]?.target.span, { startLine: 100, endLine: 139 });
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

test("large declaration search targets matched evidence while retaining exact symbol navigation", () => {
    for (const kind of ["property", "function", "file"] as const) {
        const owner: SymbolRecord = {
            symbolKey: `tests_${kind}`,
            symbolInstanceId: `tests_${kind}_instance`,
            language: "typescript",
            kind,
            name: "tests",
            qualifiedName: "tests",
            label: kind === "property" ? "const tests = [...]" : "tests",
            file: "src/rule-tests.ts",
            span: { startLine: 39, endLine: 7901 },
            parentQualifiedNamePath: [],
            fileHash: "hash",
            extractorVersion: "v1",
        };
        const matched = {
            ...candidate(owner.file, 39, 7901, 0.9),
            result: {
                ...candidate(owner.file, 39, 7901, 0.9).result,
                evidenceStartLine: 409,
                evidenceEndLine: 425,
                evidenceContent: "{ code: 'useEffect(() => { capture(value); }, [])', errors: ['missing dependency'] }",
            },
        };
        const result = buildGroupedSymbolSearchResult({
            representative: matched,
            previewSpan: owner.span,
            indexedAt: null,
            ownerSource: "owner_metadata",
            ownerSymbolKey: owner.symbolKey,
            ownerSymbolInstanceId: owner.symbolInstanceId,
            registrySymbol: owner,
            registryLoaded: true,
            navigationState: { relationshipReady: true },
            chunkCount: 2,
            candidateIds: ["matched-test", "other-test"],
            semanticMatch: "high",
            spanValidation: "not_applicable",
            debugMode: "none",
            now: navigationHelpers.now,
            previewMaxBytes: 200,
            navigationHelpers,
        });
        assert.ok(result);
        assert.deepEqual(result.target.span, { startLine: 409, endLine: 425 });
        assert.deepEqual(result.evidenceSpan, { startLine: 409, endLine: 425 });
        assert.equal(result.target.symbolId, kind === "file" ? undefined : owner.symbolInstanceId);
        assert.equal(result.__symbolInstanceId, owner.symbolInstanceId);
        assert.equal(result.evidenceChunks, 2);
        assert.deepEqual(projectGroupedResultV2(result).target, result.target);
        assert.equal(Object.keys(projectGroupedResultV2(result)).some((key) => key.startsWith("__")), false);
        assert.match(result.preview, /missing dependency/);
        assert.deepEqual(owner.span, { startLine: 39, endLine: 7901 });
        assert.deepEqual(buildSearchGroupRecommendedAction("/repo", result)?.args, {
            path: "/repo/src/rule-tests.ts", start_line: 409, end_line: 425,
        });

        const exact = buildExactRegistryGroupResult({
            symbol: owner,
            indexedAt: null,
            navigationState: { relationshipReady: true },
            debugMode: "none",
            now: navigationHelpers.now,
            previewMaxBytes: 200,
            navigationHelpers,
        });
        assert.deepEqual(exact?.target.span, owner.span);
        assert.equal(exact?.target.symbolId, kind === "file" ? undefined : owner.symbolInstanceId);
    }
});

test("small declaration targets remain exact and multiple large-owner matches choose ranked evidence deterministically", () => {
    const owner: SymbolRecord = {
        symbolKey: "tests", symbolInstanceId: "tests_instance", language: "typescript",
        kind: "property", name: "tests", qualifiedName: "tests", label: "const tests = [...]",
        file: "src/rule-tests.ts", span: { startLine: 39, endLine: 7901 },
        parentQualifiedNamePath: [], fileHash: "hash", extractorVersion: "v1",
    };
    const run = (symbol: SymbolRecord, scored: ReturnType<typeof candidate>[]) => buildVisibleGroupedSearchResults({
        scored,
        codebaseRoot: "/repo", groupBy: "symbol", limit: 5,
        queryPlan: { intent: "semantic", referenceSeeking: false, exactMatchPinningEnabled: false },
        mustMatchesFirst: false,
        registry: { symbolsByInstanceId: new Map([[symbol.symbolInstanceId, symbol]]) } as SymbolRegistry,
        navigationState: { relationshipReady: true }, debugMode: "none",
        now: navigationHelpers.now, previewMaxBytes: 200, navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: () => ({
            ownerSymbolKey: symbol.symbolKey, ownerSymbolInstanceId: symbol.symbolInstanceId,
            symbolKind: symbol.kind, ownerSource: "owner_metadata",
        }),
    }).visibleResults[0]!;
    const first = candidate(owner.file, 409, 425, 0.9, { authoritativeRank: 1 });
    const second = candidate(owner.file, 900, 912, 0.8, { authoritativeRank: 2 });
    for (const scored of [[first, second], [second, first]]) {
        const result = run(owner, scored);
        assert.deepEqual(result.target.span, { startLine: 409, endLine: 425 });
        assert.equal(result.target.symbolId, owner.symbolInstanceId);
        assert.equal(result.evidenceChunks, 2);
    }
    const small = { ...owner, span: { startLine: 400, endLine: 430 } };
    const result = run(small, [first]);
    assert.deepEqual(result.target.span, small.span);
    assert.equal(result.target.symbolId, small.symbolInstanceId);
    assert.deepEqual(buildSearchGroupRecommendedAction("/repo", result)?.args.open_symbol, {
        contractVersion: 2, symbolId: small.symbolInstanceId, context: { preset: "definition" },
    });
});

test("implementation comparison receives complete declaration content before evidence target narrowing", () => {
    const owner: SymbolRecord = {
        symbolKey: "run", symbolInstanceId: "run_instance", language: "typescript",
        kind: "function", name: "run", qualifiedName: "run", label: "function run()",
        file: "src/run.ts", span: { startLine: 10, endLine: 260 },
        parentQualifiedNamePath: [], fileHash: "hash", extractorVersion: "v1",
    };
    const declaration = ["function run() {", ...Array<string>(249).fill("  // context"), "}"].join("\n");
    const build = (content: string) => buildGroupedSymbolSearchResult({
        representative: {
            ...candidate(owner.file, 10, 260, 0.9),
            result: {
                ...candidate(owner.file, 10, 260, 0.9).result,
                content, evidenceStartLine: 120, evidenceEndLine: 125, evidenceContent: "matched evidence",
            },
        },
        previewSpan: owner.span, indexedAt: null, ownerSource: "owner_metadata",
        registrySymbol: owner, registryLoaded: true,
        navigationState: { relationshipReady: true }, chunkCount: 1, candidateIds: ["run-match"],
        semanticMatch: "high", spanValidation: "not_applicable", debugMode: "none",
        now: navigationHelpers.now, previewMaxBytes: 200, navigationHelpers,
    })!;
    const result = build(declaration);
    assert.deepEqual(result.target.span, { startLine: 120, endLine: 125 });
    assert.equal(result.__implementationContent, declaration);
    assert.match(result.preview, /matched evidence/);
    assert.equal("__implementationContent" in projectGroupedResultV2(result), false);
    assert.equal(build("function run() { /* truncated */ }").__implementationContent, undefined);
});

test("grouped disclosure order preserves the visible prefix and global diversity caps", () => {
    const result = buildVisibleGroupedSearchResults({
        scored: [
            candidate("src/a.ts", 1, 3, 0.9),
            candidate("src/a.ts", 1_000, 1_002, 0.8),
            candidate("src/a.ts", 2_000, 2_002, 0.75),
            candidate("src/a.ts", 3_000, 3_002, 0.725),
            candidate("src/b.ts", 1, 3, 0.7),
            candidate("src/c.ts", 1, 3, 0.6),
        ],
        codebaseRoot: "/repo",
        groupBy: "symbol",
        limit: 2,
        queryPlan: {
            intent: "semantic",
            exactMatchPinningEnabled: true,
            referenceSeeking: false,
        },
        mustMatchesFirst: false,
        navigationState: { relationshipReady: false },
        debugMode: "none",
        now: navigationHelpers.now,
        previewMaxBytes: 4096,
        navigationHelpers,
        parseIndexedAtMs: () => undefined,
        resolveOwner: () => ({}),
    });

    assert.deepEqual(
        result.disclosureOrder.slice(0, result.visibleResults.length).map(({ __groupId }) => __groupId),
        result.visibleResults.map(({ __groupId }) => __groupId),
    );
    assert.equal(
        new Set(result.disclosureOrder.map(({ __groupId }) => __groupId)).size,
        result.disclosureOrder.length,
    );
    assert.equal(
        result.disclosureOrder.filter(({ target }) => target.file === "src/a.ts").length,
        3,
    );
    assert.deepEqual(
        result.disclosureOrder.map(({ target }) => `${target.file}:${target.span.startLine}`),
        ["src/a.ts:1", "src/a.ts:1000", "src/a.ts:2000", "src/b.ts:1", "src/c.ts:1"],
    );
    assert.ok(result.disclosureOrder.length < result.rankedResults.length);
});
