import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { CapabilityResolver } from "./capabilities.js";
import { parseSearchOperators, buildSearchQueryPlan } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { buildSearchRerankQuery, SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from "./search-rerank-query.js";
import { resolveSearchPolicy } from "./search-policy.js";
import { runSearchExecution, type SearchDiagnostics } from "./search-execution.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { finalizeSearchResults, type SearchResultFinalizationHost } from "./search-result-finalization.js";
import { SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES } from "./search-constants.js";
import { exactSymbolOpenRequestSchema } from "./symbol-context-public-contract.js";
import type { SearchGroupedResponseEnvelope } from "./search-types.js";
import { WARNING_CODES } from "./warnings.js";

async function finalizeRaw(chunkBytes: number, count: number) {
    const parsedOperators = parseSearchOperators("where is the billing implementation");
    const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    const searchQuerySupport = new SearchQuerySupport({
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
        capabilities: { hasReranker: () => false } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 1000,
    });
    const candidates = Array.from({ length: count }, (_, index) => ({
        relativePath: `src/billing${index}.ts`,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content: `export function billing${index}() { return "${"x".repeat(chunkBytes)}"; }`,
        score: 1 - index / 1000,
        symbolLabel: `function billing${index}()`,
    }));
    const execution = await runSearchExecution({
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: "default",
        resultMode: "raw",
        limit: count,
        debugMode: "none",
        semanticQuery: parsedOperators.semanticQuery,
        answerFocus,
        rerankQuery: buildSearchRerankQuery({ semanticQuery: parsedOperators.semanticQuery, answerFocus }),
        rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        parsedOperators,
        queryPlan,
        exactRegistryEligible: false,
        exactRegistryFallbackForTrackedLexical: false,
        freshnessMode: "synced",
        observedChangedFilesState: { available: false, files: new Set() },
        dirtyFilesNotFreshened: false,
        retrievalPolicy: resolveSearchPolicy({ resultLimit: count, hasMustOperators: false }),
        flags: { path_demotion: false },
    }, {
        searchQuerySupport,
        semanticSearch: async () => candidates,
        reranker: null,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    }, {} as SearchDiagnostics);
    assert.equal(execution.kind, "ok");
    return finalizeSearchResults({
        absolutePath: "/repo",
        effectiveRoot: "/repo",
        query: "where is the billing implementation",
        scope: "runtime",
        groupBy: "symbol",
        resultMode: "raw",
        limit: count,
        disclosureLimit: count,
        includeResultIndex: false,
        rerankerResultLimit: count,
        debugMode: "none",
        rankingMode: "default",
        freshnessDecision: { mode: "synced" } as never,
        freshnessSummary: {} as never,
        partialIndexSearchWarnings: [],
        phaseTimings: {} as never,
        readiness: {} as never,
        parsedOperators,
        queryPlan,
        maxAttempts: 1,
        execution,
        navigationAuthority: "unavailable",
    }, {
        searchQuerySupport,
        buildGeneratedArtifactsVerificationHint: () => undefined,
        now: () => Date.now(),
    } as unknown as SearchResultFinalizationHost);
}

test("raw results drop lowest-ranked chunks to fit the response byte budget and disclose it", async () => {
    const finalized = await finalizeRaw(2048, 60);
    assert.equal(finalized.kind, "ok");
    const envelope = finalized.envelope as { results: Array<{ file: string }>; warnings?: Array<{ code: string }> };
    assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES);
    assert.ok(envelope.results.length > 1 && envelope.results.length < 60);
    // Kept chunks are a rank-order prefix.
    assert.deepEqual(
        envelope.results.map((result) => result.file),
        envelope.results.map((_, index) => `src/billing${index}.ts`),
    );
    assert.ok(envelope.warnings?.some((warning) => warning.code === WARNING_CODES.SEARCH_RAW_RESULTS_TRIMMED_TO_BYTE_BUDGET));

    const small = await finalizeRaw(16, 5);
    const smallEnvelope = small.envelope as { results: unknown[]; warnings?: Array<{ code: string }> };
    assert.equal(smallEnvelope.results.length, 5);
    assert.ok(!smallEnvelope.warnings?.some((warning) => warning.code === WARNING_CODES.SEARCH_RAW_RESULTS_TRIMMED_TO_BYTE_BUDGET));
});

test("grouped finalization unifies actionIntent with resolved answerFocus for how-does and configuration queries", async () => {
    const searchQuerySupport = new SearchQuerySupport({
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
        capabilities: { hasReranker: () => false } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 1000,
    });

    const runGroupedForQuery = async (query: string) => {
        const parsedOperators = parseSearchOperators(query);
        const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
        const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
        const candidates = [
            {
                candidateId: "cand_struct",
                relativePath: "src/rolling.rs",
                startLine: 10,
                endLine: 30,
                language: "rust",
                content: "pub struct RollingMeanEngine { window: usize } // compute rolling mean metadata dependencies",
                score: 0.99,
                symbolKind: "type",
                symbolLabel: "struct RollingMeanEngine",
                ownerSymbolInstanceId: "sym_struct",
            },
            {
                candidateId: "cand_fn",
                relativePath: "src/rolling.rs",
                startLine: 35,
                endLine: 60,
                language: "rust",
                content: "pub fn run_window(values: &[f64]) -> f64 { 0.0 }",
                score: 0.40,
                symbolKind: "function",
                symbolLabel: "function run_window",
                ownerSymbolInstanceId: "sym_fn",
            },
        ];
        const execution = await runSearchExecution({
            effectiveRoot: "/repo",
            scope: "runtime",
            rankingMode: "default",
            resultMode: "grouped",
            limit: 10,
            debugMode: "none",
            semanticQuery: parsedOperators.semanticQuery,
            answerFocus,
            rerankQuery: buildSearchRerankQuery({ semanticQuery: parsedOperators.semanticQuery, answerFocus }),
            rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
            parsedOperators,
            queryPlan,
            exactRegistryEligible: false,
            exactRegistryFallbackForTrackedLexical: false,
            freshnessMode: "synced",
            observedChangedFilesState: { available: false, files: new Set() },
            dirtyFilesNotFreshened: false,
            retrievalPolicy: resolveSearchPolicy({ resultLimit: 10, hasMustOperators: false }),
            flags: { path_demotion: false },
        }, {
            searchQuerySupport,
            semanticSearch: async () => candidates,
            reranker: null,
            shouldForceSearchPassFailure: () => false,
            classifyEmbeddingProviderError: () => null,
            classifyVectorBackendError: () => null,
            measureSearchPhase: async (_phase, run) => run(),
        }, {} as SearchDiagnostics);
        assert.equal(execution.kind, "ok");
        const structSymbol: SymbolRecord = {
            symbolKey: "key_struct",
            symbolInstanceId: "sym_struct",
            language: "rust",
            kind: "type",
            name: "RollingMeanEngine",
            qualifiedName: "RollingMeanEngine",
            label: "struct RollingMeanEngine",
            file: "src/rolling.rs",
            span: { startLine: 10, endLine: 30 },
            parentQualifiedNamePath: [],
            fileHash: "hash",
            extractorVersion: "v1",
        };
        const fnSymbol: SymbolRecord = {
            symbolKey: "key_fn",
            symbolInstanceId: "sym_fn",
            language: "rust",
            kind: "function",
            name: "run_window",
            qualifiedName: "run_window",
            label: "function run_window",
            file: "src/rolling.rs",
            span: { startLine: 35, endLine: 60 },
            parentQualifiedNamePath: [],
            fileHash: "hash",
            extractorVersion: "v1",
        };
        const searchSymbolRegistry = {
            manifest: {
                builtAt: "2026-01-01T00:00:00.000Z",
                files: [],
            },
            symbols: [structSymbol, fnSymbol],
            symbolsByInstanceId: new Map([
                [structSymbol.symbolInstanceId, structSymbol],
                [fnSymbol.symbolInstanceId, fnSymbol],
            ]),
            symbolsByFile: new Map([
                ["src/rolling.rs", [structSymbol, fnSymbol]],
            ]),
        } as unknown as SymbolRegistry;
        const finalized = await finalizeSearchResults({
            absolutePath: "/repo",
            effectiveRoot: "/repo",
            query,
            scope: "runtime",
            groupBy: "symbol",
            resultMode: "grouped",
            limit: 10,
            disclosureLimit: 10,
            includeResultIndex: true,
            rerankerResultLimit: 10,
            debugMode: "none",
            rankingMode: "default",
            freshnessDecision: { mode: "synced" } as never,
            freshnessSummary: {} as never,
            partialIndexSearchWarnings: [],
            phaseTimings: {} as never,
            readiness: {} as never,
            parsedOperators,
            queryPlan,
            answerFocus,
            maxAttempts: 1,
            searchSymbolRegistry,
            searchSymbolRegistryManifestHash: "manifest_hash",
            execution,
            navigationAuthority: "valid",
            navigationStatus: "valid",
        }, {
            searchQuerySupport,
            measureSearchPhase: async <T,>(_phase: string, run: () => Promise<T>) => run(),
            loadRegistryManifest: async () => ({
                status: "ok",
                registry: searchSymbolRegistry,
                manifestHash: "manifest_hash",
            }),
            loadRegistryValidatedRelationshipNavigation: async () => ({
                relationshipReady: false,
                relationshipUnavailableReason: "missing_symbol_registry",
            }),
            buildGeneratedArtifactsVerificationHint: () => undefined,
            getSearchNavigationHelpers: () => ({
                now: () => Date.now(),
                sanitizeIndexedRelativeFilePath: (value: string) => value,
                isCallGraphLanguageSupported: () => false,
                getOutlineStatusForLanguage: () => "supported",
            }),
            parseIndexedAtMs: () => undefined,
            resolveSearchOwnerFromRegistry: (result: {
                ownerSymbolInstanceId?: string;
                symbolKind?: string | null;
            }) => ({
                ownerSymbolKey: result.ownerSymbolInstanceId === "sym_struct" ? "key_struct" : "key_fn",
                ownerSymbolInstanceId: result.ownerSymbolInstanceId,
                symbolKind: result.symbolKind ?? undefined,
                ownerSource: "owner_metadata",
            }),
            now: () => Date.now(),
        } as unknown as SearchResultFinalizationHost);
        return { queryPlan, answerFocus, finalized };
    };

    // "how does ..." has queryPlan.implementationSeeking=false, but answerFocus="implementation".
    // Unifying actionIntent with answerFocus must promote the unambiguous same-file executable
    // and emit preset="implementation" on both the top recommendation and resultSet actions.
    const howDoes = await runGroupedForQuery("how does polars compute a rolling mean");
    assert.equal(howDoes.queryPlan.implementationSeeking, false);
    assert.equal(howDoes.answerFocus, "implementation");
    assert.equal(howDoes.finalized.kind, "ok");
    if (howDoes.finalized.kind !== "ok") throw new Error("expected ok");
    const howDoesEnvelope = howDoes.finalized.envelope as SearchGroupedResponseEnvelope;
    assert.equal(howDoesEnvelope.results[0]?.symbolKind, "type");
    assert.equal(howDoesEnvelope.recommendedNextAction?.resultIndex, 1);
    assert.ok(howDoesEnvelope.recommendedNextAction && "open_symbol" in howDoesEnvelope.recommendedNextAction.args);
    const openExec = exactSymbolOpenRequestSchema.parse(howDoesEnvelope.recommendedNextAction.args.open_symbol);
    assert.equal(openExec.symbolId, "sym_fn");
    assert.equal(openExec.context?.preset, "implementation");
    const pageAction0 = howDoes.finalized.resultSet?.recommendedActions[0];
    assert.ok(pageAction0 && "open_symbol" in pageAction0.args);
    assert.equal(exactSymbolOpenRequestSchema.parse(pageAction0.args.open_symbol).context?.preset, "implementation");

    // Manifest declaration query has queryPlan.implementationSeeking=true, but answerFocus="configuration".
    // Unifying actionIntent with answerFocus must keep #1 with preset="definition" (not "implementation").
    const manifest = await runGroupedForQuery("where are the Python build metadata, version, and runtime dependencies declared");
    assert.equal(manifest.queryPlan.implementationSeeking, true);
    assert.equal(manifest.answerFocus, "configuration");
    assert.equal(manifest.finalized.kind, "ok");
    if (manifest.finalized.kind !== "ok") throw new Error("expected ok");
    const manifestEnvelope = manifest.finalized.envelope as SearchGroupedResponseEnvelope;
    assert.equal(manifestEnvelope.recommendedNextAction?.resultIndex, 0);
    assert.ok(manifestEnvelope.recommendedNextAction && "open_symbol" in manifestEnvelope.recommendedNextAction.args);
    const openManifest = exactSymbolOpenRequestSchema.parse(manifestEnvelope.recommendedNextAction.args.open_symbol);
    assert.equal(openManifest.symbolId, "sym_struct");
    assert.equal(openManifest.context?.preset, "definition");
});
