import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolRegistry, SymbolRecord } from "@satori-code/core";
import { runExactRegistryFastPath, type SearchExactFastPathHost, type SearchExactFastPathInput } from "./search-exact-fast-path.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { SearchQuerySupport } from "./search-query-support.js";
import type { CapabilityResolver } from "./capabilities.js";

const testSymbol: SymbolRecord = {
    symbolKey: "src/target.ts:10:20:function:TargetFunction",
    symbolInstanceId: "sym-1",
    name: "TargetFunction",
    qualifiedName: "TargetFunction",
    parentQualifiedNamePath: [],
    kind: "function",
    file: "src/target.ts",
    label: "function TargetFunction()",
    span: { startLine: 10, endLine: 20 },
    language: "typescript",
    fileHash: "hash-1",
    extractorVersion: "1.0.0",
};

function buildInput(): SearchExactFastPathInput {
    const parsedOperators = parseSearchOperators("TargetFunction");
    const queryPlan = buildSearchQueryPlan("TargetFunction", true, parsedOperators);
    return {
        absolutePath: "/repo/src/target.ts",
        effectiveRoot: "/repo",
        requestedSubdirectory: null,
        query: "TargetFunction",
        scope: "runtime",
        groupBy: "symbol",
        resultMode: "grouped",
        limit: 5,
        disclosureLimit: 10,
        includeResultIndex: false,
        debugMode: "none",
        rankingMode: "default",
        semanticQuery: "TargetFunction",
        parsedOperators,
        queryPlan,
        freshnessDecision: {
            mode: "served_previous_generation",
            checkedAt: new Date().toISOString(),
            thresholdMs: 0,
        },
        freshnessSummary: {
            syncMode: "served_previous_generation",
            lastSyncAt: null,
            changedFileCount: 1,
            gitDirtyFilesConsidered: true,
            changedFilesBoostApplied: false,
            changedFilesBoostSkippedForLargeChangeSet: false,
        },
        partialIndexSearchWarnings: [],
        phaseTimings: {} as any,
        readiness: {
            proofMode: "warm",
            invalidationReason: "none",
            operations: {
                preparedCacheLookups: 0,
                preparedCacheHits: 0,
                coldReadinessChecks: 0,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 0,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        },
        candidateLimit: 10,
        maxAttempts: 1,
        operatorSummary: { prefixBlockChars: 0, lang: [], path: [], excludePath: [], must: [], exclude: [] },
        filterSummary: {
            removedByRequestedSubdirectory: 0,
            removedByScope: 0,
            removedByLanguage: 0,
            removedByPathInclude: 0,
            removedByPathExclude: 0,
            removedByMust: 0,
            removedByExclude: 0,
        },
        changedFilesState: { available: true, files: new Set(["src/target.ts"]) },
        observedChangedFilesState: { available: true, files: new Set(["src/target.ts"]) },
        changedFilesCount: 1,
        changedFilesBoostSkippedForLargeChangeSet: false,
        dirtyFilesNotFreshened: true,
        rankingProvenance: {
            semanticPassesUsed: [],
            lexicalPassesUsed: [],
            livePathSupplementUsed: false,
            lexicalFileScanUsed: false,
            rerankApplied: false,
            exactMatchPinningApplied: false,
            registryRepairGroupCount: 0,
        },
        previewMaxBytes: 1000,
        navigationAuthority: "valid",
    };
}

test("runExactRegistryFastPath uses publication-only symbols without reading current source during served_previous_generation", async () => {
    const mockRegistry: SymbolRegistry = {
        manifest: { builtAt: "2026-08-15T00:00:00Z" } as any,
        symbols: [testSymbol],
        symbolsByInstanceId: new Map([["sym-1", testSymbol]]),
        symbolsByKey: new Map([["src/target.ts:10:20:function:TargetFunction", [testSymbol]]]),
        symbolsByFile: new Map([["src/target.ts", [testSymbol]]]),
        symbolsByLabel: new Map([["function TargetFunction()", [testSymbol]]]),
        symbolsByQualifiedName: new Map([["TargetFunction", [testSymbol]]]),
        warnings: [],
    };

    const support = new SearchQuerySupport({
        normalizeSearchPath: (value) => value,
        hasPathSegment: () => false,
        isGeneratedPath: () => false,
        isTestPath: () => false,
        isFixturePath: () => false,
        isDocPath: () => false,
        getContextActiveIgnorePatterns: () => [],
        getContextTrackedRelativePaths: () => [],
        classifyPathCategory: () => "core",
        shouldIncludeCategoryInScope: () => true,
        capabilities: {
            hasReranker: () => false,
            getDefaultRerankEnabled: () => false,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 1000,
    });

    const host: SearchExactFastPathHost = {
        searchQuerySupport: support,
        measureSearchPhase: async (_phase, run) => run(),
        loadRegistryManifest: async () => ({
            status: "ok",
            registry: mockRegistry,
            manifestHash: "man-1",
        }),
        loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: true }),
        buildRelationshipBackedCallGraph: async () => null,
        buildChangedCodeDebug: async () => undefined,
        buildGeneratedArtifactsVerificationHint: () => undefined,
        getSearchNavigationHelpers: () => ({
            now: () => Date.now(),
            sanitizeIndexedRelativeFilePath: (f: string) => f,
            isCallGraphLanguageSupported: () => false,
            getOutlineStatusForLanguage: () => "valid" as any,
            buildSearchCandidateHierarchy: () => undefined,
            buildSearchCandidateRelationships: () => undefined,
            buildSearchCandidateTestCoverage: () => undefined,
        } as any),
        now: () => Date.now(),
    };

    const outcome = await runExactRegistryFastPath(buildInput(), host);

    assert.equal(outcome.kind, "handled");
    if (outcome.kind === "handled") {
        assert.equal(outcome.finalized.kind, "ok");
        if (outcome.finalized.kind === "ok") {
            const envelope = outcome.finalized.envelope;
            assert.equal(envelope.results.length, 1);
            const group = envelope.results[0] as import("./search-types.js").SearchGroupedResultV2;
            assert.equal(group.target.file, "src/target.ts");
            assert.equal(group.target.symbolId, "sym-1");
            assert.equal(group.displayLabel, "function TargetFunction()");
            // Stale mode must produce empty preview instead of reading disk
            assert.equal(group.preview, "");
        }
    }
});

test("runExactRegistryFastPath preserves dirty relationship peers without reading disk during served_previous_generation", async () => {
    const peerSymbol: SymbolRecord = {
        symbolKey: "src/caller.ts:5:15:function:CallerFunction",
        symbolInstanceId: "sym-peer-1",
        name: "CallerFunction",
        qualifiedName: "CallerFunction",
        parentQualifiedNamePath: [],
        kind: "function",
        file: "src/caller.ts",
        label: "function CallerFunction()",
        span: { startLine: 5, endLine: 15 },
        language: "typescript",
        fileHash: "hash-peer-1",
        extractorVersion: "1.0.0",
    };

    const mockRegistry: SymbolRegistry = {
        manifest: { builtAt: "2026-08-15T00:00:00Z" } as any,
        symbols: [testSymbol, peerSymbol],
        symbolsByInstanceId: new Map([
            ["sym-1", testSymbol],
            ["sym-peer-1", peerSymbol],
        ]),
        symbolsByKey: new Map([
            ["src/target.ts:10:20:function:TargetFunction", [testSymbol]],
            ["src/caller.ts:5:15:function:CallerFunction", [peerSymbol]],
        ]),
        symbolsByFile: new Map([
            ["src/target.ts", [testSymbol]],
            ["src/caller.ts", [peerSymbol]],
        ]),
        symbolsByLabel: new Map([
            ["function TargetFunction()", [testSymbol]],
            ["function CallerFunction()", [peerSymbol]],
        ]),
        symbolsByQualifiedName: new Map([
            ["TargetFunction", [testSymbol]],
            ["CallerFunction", [peerSymbol]],
        ]),
        warnings: [],
    };

    const parsedOperators = parseSearchOperators("who calls TargetFunction");
    const queryPlan = buildSearchQueryPlan("who calls TargetFunction", true, parsedOperators);
    const input: SearchExactFastPathInput = {
        ...buildInput(),
        query: "who calls TargetFunction",
        semanticQuery: "who calls TargetFunction",
        parsedOperators,
        queryPlan,
        // The peer file src/caller.ts is modified in the working tree
        changedFilesState: { available: true, files: new Set(["src/caller.ts"]) },
        observedChangedFilesState: { available: true, files: new Set(["src/caller.ts"]) },
        dirtyFilesNotFreshened: true,
    };

    const support = new SearchQuerySupport({
        normalizeSearchPath: (value) => value,
        hasPathSegment: () => false,
        isGeneratedPath: () => false,
        isTestPath: () => false,
        isFixturePath: () => false,
        isDocPath: () => false,
        getContextActiveIgnorePatterns: () => [],
        getContextTrackedRelativePaths: () => [],
        classifyPathCategory: () => "core",
        shouldIncludeCategoryInScope: () => true,
        capabilities: {
            hasReranker: () => false,
            getDefaultRerankEnabled: () => false,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 1000,
    });

    const host: SearchExactFastPathHost = {
        searchQuerySupport: support,
        measureSearchPhase: async (_phase, run) => run(),
        loadRegistryManifest: async () => ({
            status: "ok",
            registry: mockRegistry,
            manifestHash: "man-1",
        }),
        loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: true }),
        buildRelationshipBackedCallGraph: async () => ({
            supported: true,
            direction: "callers",
            depth: 1,
            limit: 5,
            source: "relationship_sidecar",
            nodes: [
                { symbolId: "sym-1", label: "TargetFunction", file: "src/target.ts" },
                { symbolId: "sym-peer-1", label: "CallerFunction", file: "src/caller.ts" },
            ],
            edges: [
                { srcSymbolId: "sym-peer-1", dstSymbolId: "sym-1", kind: "CALLS" as const },
            ],
            metrics: { edgeCount: 1, nodeCount: 2, truncated: false },
        } as any),
        buildChangedCodeDebug: async () => undefined,
        buildGeneratedArtifactsVerificationHint: () => undefined,
        getSearchNavigationHelpers: () => ({
            now: () => Date.now(),
            sanitizeIndexedRelativeFilePath: (f: string) => f,
            isCallGraphLanguageSupported: () => false,
            getOutlineStatusForLanguage: () => "valid" as any,
            buildSearchCandidateHierarchy: () => undefined,
            buildSearchCandidateRelationships: () => undefined,
            buildSearchCandidateTestCoverage: () => undefined,
        } as any),
        now: () => Date.now(),
    };

    const outcome = await runExactRegistryFastPath(input, host);

    assert.equal(outcome.kind, "handled");
    if (outcome.kind === "handled") {
        assert.equal(outcome.finalized.kind, "ok");
        if (outcome.finalized.kind === "ok") {
            const envelope = outcome.finalized.envelope;
            // Both peer and target returned, despite peer belonging to dirty file
            assert.equal(envelope.results.length, 2);
            const peerResult = envelope.results[0] as import("./search-types.js").SearchGroupedResultV2;
            assert.equal(peerResult.target.file, "src/caller.ts");
            assert.equal(peerResult.target.symbolId, "sym-peer-1");
            assert.equal(peerResult.preview, "");
        }
    }
});

test("runExactRegistryFastPath answers an ambiguous exact name with every declaration, runtime first", async () => {
    const declaration = (id: string, file: string, line: number): SymbolRecord => ({
        symbolKey: `${file}:${line}:${line + 5}:method:scheduleDecisionAnalysis`,
        symbolInstanceId: id,
        name: "scheduleDecisionAnalysis",
        qualifiedName: `Owner.scheduleDecisionAnalysis`,
        parentQualifiedNamePath: ["Owner"],
        kind: "method",
        file,
        label: "method scheduleDecisionAnalysis",
        span: { startLine: line, endLine: line + 5 },
        language: "typescript",
        fileHash: `hash-${id}`,
        extractorVersion: "1.0.0",
    });
    // Registry order puts the runtime declaration last.
    const symbols = [
        declaration("sym-script", "scripts/ui-preview/scenarios.ts", 103),
        declaration("sym-test", "tests/road-building-continuation.test.ts", 28),
        declaration("sym-runtime", "src/content/overlay.ts", 3361),
    ];
    const registry: SymbolRegistry = {
        manifest: { builtAt: "2026-08-15T00:00:00Z" } as any,
        symbols,
        symbolsByInstanceId: new Map(symbols.map((symbol) => [symbol.symbolInstanceId, symbol])),
        symbolsByKey: new Map(symbols.map((symbol) => [symbol.symbolKey, [symbol]])),
        symbolsByFile: new Map(symbols.map((symbol) => [symbol.file, [symbol]])),
        symbolsByLabel: new Map([["method scheduleDecisionAnalysis", symbols]]),
        symbolsByQualifiedName: new Map([["Owner.scheduleDecisionAnalysis", symbols]]),
        symbolsByName: new Map([["scheduleDecisionAnalysis", symbols]]),
        warnings: [],
    };
    const parsedOperators = parseSearchOperators("scheduleDecisionAnalysis");
    const queryPlan = buildSearchQueryPlan("scheduleDecisionAnalysis", true, parsedOperators);
    const input: SearchExactFastPathInput = {
        ...buildInput(),
        query: "scheduleDecisionAnalysis",
        semanticQuery: "scheduleDecisionAnalysis",
        parsedOperators,
        queryPlan,
        changedFilesState: { available: true, files: new Set() },
        observedChangedFilesState: { available: true, files: new Set() },
        dirtyFilesNotFreshened: false,
    };
    const host: SearchExactFastPathHost = {
        searchQuerySupport: new SearchQuerySupport({
            normalizeSearchPath: (value) => value,
            hasPathSegment: () => false,
            isGeneratedPath: () => false,
            isTestPath: () => false,
            isFixturePath: () => false,
            isDocPath: () => false,
            getContextActiveIgnorePatterns: () => [],
            getContextTrackedRelativePaths: () => [],
            classifyPathCategory: () => "core",
            shouldIncludeCategoryInScope: () => true,
            capabilities: {
                hasReranker: () => false,
                getDefaultRerankEnabled: () => false,
            } as unknown as CapabilityResolver,
            runtimeFingerprint: {} as never,
            reranker: null,
            gitignoreForceReloadEveryN: 1000,
        }),
        measureSearchPhase: async (_phase, run) => run(),
        loadRegistryManifest: async () => ({ status: "ok", registry, manifestHash: "man-1" }),
        loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: true }),
        buildRelationshipBackedCallGraph: async () => null,
        buildChangedCodeDebug: async () => undefined,
        buildGeneratedArtifactsVerificationHint: () => undefined,
        getSearchNavigationHelpers: () => ({
            now: () => Date.now(),
            sanitizeIndexedRelativeFilePath: (f: string) => f,
            isCallGraphLanguageSupported: () => false,
            getOutlineStatusForLanguage: () => "valid" as any,
            buildSearchCandidateHierarchy: () => undefined,
            buildSearchCandidateRelationships: () => undefined,
            buildSearchCandidateTestCoverage: () => undefined,
        } as any),
        now: () => Date.now(),
    };

    const outcome = await runExactRegistryFastPath(input, host);
    assert.equal(outcome.kind, "handled");
    assert.equal(outcome.exactRegistryDebug?.status, "ambiguous");
    if (outcome.kind === "handled" && outcome.finalized.kind === "ok") {
        const files = outcome.finalized.envelope.results.map((group) => (
            group as import("./search-types.js").SearchGroupedResultV2
        ).target.file);
        assert.equal(files[0], "src/content/overlay.ts");
        assert.deepEqual([...files].sort(), symbols.map((symbol) => symbol.file).sort());
    } else {
        assert.fail("expected finalized exact results");
    }

    // More declarations than one page can hold fall back to hybrid ranking.
    const overflow = await runExactRegistryFastPath({ ...input, limit: 2 }, host);
    assert.equal(overflow.kind, "continue");
});
