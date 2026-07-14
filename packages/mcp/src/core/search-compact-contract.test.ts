import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildRawSearchEnvelope,
    buildGroupedSearchEnvelope,
} from "./search-response-envelopes.js";
import { buildVisibleGroupedSearchResults } from "./search-group-results.js";
import type {
    SearchDebugHint,
    SearchChunkResult,
    SearchGroupResult,
    SearchGroupedResultV2,
} from "./search-types.js";
import type { SearchNavigationHelpers } from "./search-navigation.js";
import { callGraphInputSchema, callGraphTool } from "../tools/call_graph.js";
import { readFileInputSchema, readFileTool } from "../tools/read_file.js";
import type { ToolContext } from "../tools/types.js";

const ROOT = "/workspace/repo";
const FRESHNESS_DECISION = {
    mode: "skipped_recent" as const,
    checkedAt: "2026-01-01T00:00:00.000Z",
    thresholdMs: 180000,
};
const FRESHNESS_SUMMARY = {
    syncMode: "skipped_recent" as const,
    lastSyncAt: null,
    changedFileCount: 0,
    gitDirtyFilesConsidered: false,
    changedFilesBoostApplied: false,
    changedFilesBoostSkippedForLargeChangeSet: false,
};

function makeGroup(index: number, options: {
    file?: string;
    symbolId?: string;
    displayLabel?: string;
    preview?: string;
    graph?: SearchGroupedResultV2["navigation"]["graph"];
    debug?: boolean;
    startLine?: number;
} = {}): SearchGroupResult {
    const startLine = options.startLine ?? index + 1;
    const file = options.file ?? `src/result-${index}.ts`;
    const symbolId = options.symbolId === undefined ? `syminst_result_${index}` : options.symbolId;
    const graph = options.graph ?? "ready";
    return {
        target: {
            file,
            span: { startLine, endLine: startLine + 2 },
            ...(symbolId ? { symbolId } : {}),
        },
        displayLabel: options.displayLabel ?? `function result${index}()`,
        language: "typescript",
        symbolKind: "function",
        score: 0.987654321 - index / 10_000,
        quality: { owner: symbolId ? "high" : "low", semantic: "medium" },
        preview: options.preview ?? `function result${index}()\nreturn ${index};`,
        navigation: graph === "ready"
            ? { graph, inbound: "verify", callerSearchTerm: `result${index}` }
            : { graph },
        __groupId: `internal_group_${index}`,
        __symbolKey: `internal_symbol_key_${index}`,
        ...(symbolId ? { __symbolInstanceId: symbolId } : {}),
        __exactLexicalMatch: false,
        ...(options.debug ? {
            debug: {
                representativeChunkCount: 2,
                pathCategory: "core",
                pathMultiplier: 1.1,
                topChunkScore: 0.987654321 - index / 10_000,
                lexicalScore: 0.25,
                changedFilesMultiplier: 1,
                agentFitMultiplier: 1,
                agentFitReason: "implementation_symbol",
                matchesMust: true,
                exactLexicalMatch: false,
                symbolAggregation: {
                    ownerSource: "registry_repair",
                    evidenceChunkCount: 2,
                    supportBoost: 0.01,
                },
                freshness: {
                    newestChunkIndexedAt: "2026-01-01T00:00:00.000Z",
                    ageBucket: "fresh",
                },
                graphEvidence: {
                    validatedAt: "2026-01-01T00:00:00.000Z",
                    sidecarBuiltAt: "2026-01-01T00:00:00.000Z",
                },
                provenance: {
                    retrievalPasses: ["primary", "expanded"],
                    backendScoreKinds: ["rrf_fusion"],
                    semanticCandidate: true,
                    lexicalCandidate: true,
                    rerankAdjusted: false,
                    exactMatchPinned: false,
                    ownerRepairApplied: true,
                },
            },
        } : {}),
    };
}

function buildGroupedEnvelope(results: SearchGroupResult[]) {
    return buildGroupedSearchEnvelope({
        codebaseRoot: ROOT,
        absolutePath: ROOT,
        query: "find result behavior",
        scope: "runtime",
        groupBy: "symbol",
        limit: results.length,
        freshnessDecision: FRESHNESS_DECISION,
        freshnessSummary: FRESHNESS_SUMMARY,
        warnings: [],
        results,
    });
}

function byteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const entry of value) {
            collectKeys(entry, keys);
        }
        return keys;
    }
    if (!value || typeof value !== "object") {
        return keys;
    }
    for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        collectKeys(nested, keys);
    }
    return keys;
}

test("debug modes are projected from explicit source-level whitelists", () => {
    const fullDebug = {
        queryIntent: { classification: "identifier", confidence: "high", reasons: [], lexicalTerms: ["owner"], semanticQuery: "owner" },
        retrieval: { mode: "hybrid", scorePolicyKind: "hybrid", backendScoreKinds: ["rrf"] },
        rankingProvenance: { semanticPassesUsed: ["primary"], lexicalPassesUsed: [], livePathSupplementUsed: false, lexicalFileScanUsed: false, rerankApplied: false, exactMatchPinningApplied: false, registryRepairGroupCount: 0 },
        phaseTimingsMs: { prepareRead: 4 },
        readiness: {
            proofMode: "warm",
            invalidationReason: "none",
            operations: {
                preparedCacheLookups: 1,
                preparedCacheHits: 1,
                coldReadinessChecks: 0,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 1,
                exactPayloadRecounts: 0,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        },
        passesUsed: ["primary"],
        candidateLimit: 32,
        mustRetry: { attempts: 1, maxAttempts: 1, applied: false, satisfied: true, finalCount: 1 },
        operatorSummary: {},
        filterSummary: {},
        changedFilesBoost: { enabled: true, applied: false, available: true, changedCount: 1, maxChangedFilesForBoost: 40, skippedForLargeChangeSet: false, multiplier: 1.1, boostedCandidates: 0 },
        changedCode: { files: ["src/a.ts"], truncated: false },
        rerank: { enabledByPolicy: false, skippedByScopeDocs: false, skippedByIdentifierIntent: true, capabilityPresent: true, rerankerPresent: true, enabled: false, attempted: false, applied: false, exactMatchPinningEnabled: true, exactMatchPinningApplied: false, candidatesIn: 1, candidatesReranked: 0, topK: 10, rankK: 60, weight: 0.5, docMaxLines: 40, docMaxChars: 4000 },
    } as unknown as SearchDebugHint;
    const build = (debugMode: "summary" | "ranking" | "freshness" | "full") => buildGroupedSearchEnvelope({
        codebaseRoot: ROOT,
        absolutePath: ROOT,
        query: "owner",
        scope: "runtime",
        groupBy: "symbol",
        limit: 1,
        freshnessDecision: FRESHNESS_DECISION,
        freshnessSummary: FRESHNESS_SUMMARY,
        warnings: [],
        debugSummary: { retrieval: "primary", freshness: "skipped_recent", dirtyFiles: 0, rerank: "skipped" },
        ...(debugMode === "full" ? { debugSearch: fullDebug } : {}),
        ...(debugMode === "ranking" ? { debugSearch: {
            queryIntent: fullDebug.queryIntent,
            retrieval: fullDebug.retrieval,
            rankingProvenance: fullDebug.rankingProvenance,
            passesUsed: fullDebug.passesUsed,
            candidateLimit: fullDebug.candidateLimit,
            mustRetry: fullDebug.mustRetry,
            operatorSummary: fullDebug.operatorSummary,
            filterSummary: fullDebug.filterSummary,
            changedFilesBoost: fullDebug.changedFilesBoost,
            rerank: fullDebug.rerank,
        } } : {}),
        ...(debugMode === "freshness" ? { debugSearch: {
            phaseTimingsMs: fullDebug.phaseTimingsMs,
            readiness: fullDebug.readiness,
            changedCode: fullDebug.changedCode,
        } } : {}),
        results: [],
    });

    assert.equal(build("summary").hints?.debugSearch, undefined);
    assert.deepEqual(Object.keys(build("freshness").hints?.debugSearch ?? {}).sort(), ["changedCode", "phaseTimingsMs", "readiness"]);
    const rankingKeys = Object.keys(build("ranking").hints?.debugSearch ?? {});
    assert.equal(rankingKeys.includes("phaseTimingsMs"), false);
    assert.equal(rankingKeys.includes("changedCode"), false);
    assert.equal(rankingKeys.includes("rankingProvenance"), true);
    assert.equal((build("full").hints?.debugSearch as SearchDebugHint).changedCode?.files[0], "src/a.ts");
});

test("grouped v2 keeps concrete symbol instances distinct and removes internal grouping identities", () => {
    const envelope = buildGroupedEnvelope([
        makeGroup(0, { file: "src/a.ts", symbolId: "instance_a", displayLabel: "function duplicate()" }),
        makeGroup(1, { file: "src/b.ts", symbolId: "instance_b", displayLabel: "function duplicate()" }),
        makeGroup(2, { file: "src/overloads.ts", symbolId: "instance_overload_a", displayLabel: "function duplicate()", startLine: 10 }),
        makeGroup(3, { file: "src/overloads.ts", symbolId: "instance_overload_b", displayLabel: "function duplicate()", startLine: 20 }),
    ]);

    assert.equal(envelope.formatVersion, 2);
    assert.equal(envelope.resultMode, "grouped");
    assert.deepEqual(
        envelope.results.map((result) => result.target.symbolId),
        ["instance_a", "instance_b", "instance_overload_a", "instance_overload_b"],
    );
    assert.deepEqual(
        envelope.results.slice(2).map((result) => result.target.span.startLine),
        [10, 20],
    );
    assert.equal(JSON.stringify(envelope.results).includes("internal_group_"), false);
    assert.equal(JSON.stringify(envelope.results).includes("internal_symbol_key_"), false);
});

test("grouped v2 projection never serializes newly added internal fields", () => {
    const contaminated = makeGroup(0) as SearchGroupResult & {
        __candidateOwners: string[];
        retrievalVector: number[];
        futureDiagnostic: { rawQuery: string };
    };
    contaminated.__candidateOwners = ["internal_owner"];
    contaminated.retrievalVector = [0.1, 0.2, 0.3];
    contaminated.futureDiagnostic = { rawQuery: "secret query text" };

    const [result] = buildGroupedEnvelope([contaminated]).results;
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("__candidateOwners"), false);
    assert.equal(serialized.includes("retrievalVector"), false);
    assert.equal(serialized.includes("futureDiagnostic"), false);
    assert.equal(serialized.includes("secret query text"), false);
});

test("grouped v2 emits canonical facts only and keeps degraded navigation explicit", () => {
    const envelope = buildGroupedEnvelope([
        makeGroup(0),
        makeGroup(1, { symbolId: "", graph: "missing_symbol" }),
        makeGroup(2, { graph: "unsupported_language" }),
        makeGroup(3, { graph: "partial_index_navigation_unavailable" }),
    ]);
    const resultKeys = collectKeys(envelope.results);

    for (const removed of [
        "callGraphHint",
        "nextActions",
        "navigationFallback",
        "inboundRecovery",
        "fallbacks",
        "capabilities",
        "recommendedNextAction",
        "groupId",
        "symbolKey",
        "symbolInstanceId",
    ]) {
        assert.equal(resultKeys.has(removed), false, removed);
    }
    assert.equal(Array.from(resultKeys).some((key) => key.startsWith("__")), false);
    assert.equal(JSON.stringify(envelope.results).includes(ROOT), false);
    assert.equal(envelope.results[1].target.symbolId, undefined);
    assert.equal(envelope.results[1].navigation.graph, "missing_symbol");
    assert.equal(envelope.results[2].navigation.graph, "unsupported_language");
    assert.equal(envelope.results[3].navigation.graph, "partial_index_navigation_unavailable");
    assert.equal(
        (envelope.results[0].navigation as { inbound?: string }).inbound,
        "verify",
    );
    assert.equal(envelope.recommendedNextAction?.resultIndex, 0);
});

test("raw v2 preserves raw result objects while versioning the envelope", () => {
    const raw: SearchChunkResult = {
        kind: "chunk",
        file: "src/raw.ts",
        span: { startLine: 3, endLine: 5 },
        language: "typescript",
        content: "return rawValue;",
        score: 0.123456789,
        indexedAt: "2026-01-01T00:00:00.000Z",
        stalenessBucket: "fresh",
        symbolId: "legacy_chunk_id",
        symbolLabel: "function rawValue()",
    };
    const envelope = buildRawSearchEnvelope({
        codebaseRoot: ROOT,
        absolutePath: ROOT,
        query: "raw value",
        scope: "runtime",
        groupBy: "symbol",
        limit: 1,
        freshnessDecision: FRESHNESS_DECISION,
        freshnessSummary: FRESHNESS_SUMMARY,
        warnings: [],
        results: [raw],
    });

    assert.equal(envelope.formatVersion, 2);
    assert.equal(envelope.resultMode, "raw");
    assert.strictEqual(envelope.results[0], raw);
    assert.deepEqual(envelope.results[0], raw);
});

test("malformed grouped candidates are omitted with one deterministic warning", () => {
    const helpers: SearchNavigationHelpers = {
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
        sanitizeIndexedRelativeFilePath: (candidate) => {
            const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
            if (
                !normalized
                || normalized.includes("\0")
                || normalized === ".."
                || normalized.startsWith("../")
                || path.posix.isAbsolute(normalized)
                || /^[A-Za-z]:/.test(normalized)
            ) {
                return undefined;
            }
            return normalized;
        },
        isCallGraphLanguageSupported: () => true,
        getOutlineStatusForLanguage: () => "ok",
    };
    const candidate = (relativePath: string, startLine: number, endLine: number, finalScore: number) => ({
        result: {
            relativePath,
            startLine,
            endLine,
            language: "typescript",
            symbolLabel: "function candidate()",
            symbolKind: "function",
            content: "return true;",
            indexedAt: "2026-01-01T00:00:00.000Z",
        },
        finalScore,
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
        lexicalScore: 0.5,
    });

    const stringSpanCandidate = candidate("src/string-span.ts", 1, 3, 0.6);
    (stringSpanCandidate.result as unknown as { startLine: unknown }).startLine = "1";

    const output = buildVisibleGroupedSearchResults({
        scored: [
            candidate("src/valid.ts", 1, 3, 0.9),
            candidate("../escape.ts", 1, 3, 0.8),
            candidate("src/bad-span.ts", 0, 0, 0.7),
            candidate("src/nonfinite.ts", 1, 3, Number.NaN),
            stringSpanCandidate,
        ],
        codebaseRoot: ROOT,
        groupBy: "symbol",
        limit: 10,
        queryPlan: { intent: "semantic", referenceSeeking: false, exactMatchPinningEnabled: false },
        mustMatchesFirst: false,
        navigationState: { relationshipReady: false, relationshipUnavailableReason: "missing_relationship_sidecar" },
        debugMode: "none",
        now: helpers.now,
        previewMaxBytes: 768,
        navigationHelpers: helpers,
        parseIndexedAtMs: (value) => value ? Date.parse(value) : undefined,
        resolveOwner: (result) => {
            assert.equal(result.relativePath, "src/valid.ts");
            return {};
        },
    });

    assert.equal(output.visibleResults.length, 1);
    assert.equal(output.visibleResults[0].target.file, "src/valid.ts");
    assert.deepEqual(output.warnings, ["SEARCH_INVALID_GROUP_TARGET_OMITTED"]);
});

test("documented grouped navigation mappings validate and execute through registered tools", async () => {
    const symbolResult = buildGroupedEnvelope([makeGroup(0)]).results[0];
    const graphInput = {
        path: ROOT,
        symbolRef: symbolResult.target,
        direction: "both" as const,
        depth: 1,
        limit: 20,
    };
    assert.equal(callGraphInputSchema.safeParse(graphInput).success, true);

    let dispatchedGraphInput: unknown;
    const graphResponse = await callGraphTool.execute(graphInput, {
        providerRuntime: {
            requireToolContext: async () => ({
                toolHandlers: {
                    handleCallGraph: async (input: unknown) => {
                        dispatchedGraphInput = input;
                        return { content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] };
                    },
                },
            }),
        },
    } as unknown as ToolContext);
    assert.equal(graphResponse.isError, undefined);
    assert.deepEqual((dispatchedGraphInput as { symbolRef?: unknown })?.symbolRef, symbolResult.target);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-compact-contract-"));
    try {
        const relativeFile = "src/fallback.ts";
        const absoluteFile = path.join(tempRoot, relativeFile);
        fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
        fs.writeFileSync(absoluteFile, "line one\nline two\nline three\n", "utf8");

        const exactResult = makeGroup(0, {
            file: relativeFile,
            symbolId: "syminst_fallback",
            startLine: 1,
        });
        exactResult.target.span.endLine = 2;
        const exactReadInput = {
            path: absoluteFile,
            open_symbol: { symbolId: exactResult.target.symbolId },
        };
        assert.equal(readFileInputSchema.safeParse(exactReadInput).success, true);
        let outlineInput: unknown;
        const exactReadResponse = await readFileTool.execute(exactReadInput, {
            readFileMaxLines: 100,
            snapshotManager: {
                getAllCodebases: () => [{ path: tempRoot, info: { status: "indexed" } }],
            },
            syncManager: { touchWatchedCodebase: async () => undefined },
            toolHandlers: {
                handleFileOutline: async (input: unknown) => {
                    outlineInput = input;
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: "ok",
                                outline: {
                                    symbols: [{
                                        symbolId: exactResult.target.symbolId,
                                        span: exactResult.target.span,
                                    }],
                                },
                            }),
                        }],
                    };
                },
            },
        } as unknown as ToolContext);
        assert.equal(exactReadResponse.isError, undefined);
        assert.equal(exactReadResponse.content[0]?.text, "line one\nline two");
        assert.deepEqual(outlineInput, {
            path: tempRoot,
            file: relativeFile,
            resolveMode: "exact",
            symbolIdExact: exactResult.target.symbolId,
            symbolLabelExact: undefined,
            limitSymbols: 25,
        });

        const spanResult = makeGroup(1, { file: relativeFile, symbolId: "", startLine: 2 });
        spanResult.target.span.endLine = 3;
        const readInput = {
            path: absoluteFile,
            start_line: spanResult.target.span.startLine,
            end_line: spanResult.target.span.endLine,
        };
        assert.equal(readFileInputSchema.safeParse(readInput).success, true);

        const readResponse = await readFileTool.execute(readInput, {
            readFileMaxLines: 100,
            snapshotManager: {
                getAllCodebases: () => [{ path: tempRoot, info: { status: "indexed" } }],
            },
            syncManager: { touchWatchedCodebase: async () => undefined },
            toolHandlers: {},
        } as unknown as ToolContext);
        assert.equal(readResponse.isError, undefined);
        assert.equal(readResponse.content[0]?.text, "line two\nline three");
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test("grouped v2 response budgets bound structural and preview overhead", () => {
    const cases: Array<[number, number]> = [
        [1, 1_500],
        [5, 3_600],
        [20, 12_000],
        [50, 29_000],
    ];
    for (const [count, maximumBytes] of cases) {
        const envelope = buildGroupedEnvelope(Array.from({ length: count }, (_, index) => makeGroup(index)));
        assert.equal(byteLength(envelope) <= maximumBytes, true, `${count} results: ${byteLength(envelope)} bytes`);
    }

    const one = buildGroupedEnvelope([makeGroup(0)]);
    const fixedEnvelopeBytes = byteLength({ ...one, results: [], recommendedNextAction: undefined });
    const resultMetadataBytes = byteLength({
        ...one.results[0],
        target: { file: "", span: one.results[0].target.span },
        displayLabel: "",
        language: "",
        symbolKind: "",
        preview: "",
        navigation: { graph: "ready", inbound: "verify" },
    });
    assert.equal(fixedEnvelopeBytes <= 1_000, true, `${fixedEnvelopeBytes} fixed bytes`);
    assert.equal(resultMetadataBytes <= 350, true, `${resultMetadataBytes} structural metadata bytes`);

    const realisticLongIdentityEnvelope = buildGroupedEnvelope(Array.from(
        { length: 20 },
        (_, index) => makeGroup(index, {
            file: `${"packages/deeply-nested/".repeat(8)}feature-${index}/implementation.ts`,
            symbolId: `syminst_${"a".repeat(112)}_${index}`,
            displayLabel: `function ${"longIdentifier".repeat(8)}${index}()`,
        }),
    ));
    assert.equal(
        byteLength(realisticLongIdentityEnvelope) <= 24_000,
        true,
        `${byteLength(realisticLongIdentityEnvelope)} realistic-long-identity bytes`,
    );

    const maxPreviewEnvelope = buildGroupedEnvelope(Array.from(
        { length: 20 },
        (_, index) => makeGroup(index, { preview: "x".repeat(768) }),
    ));
    assert.equal(byteLength(maxPreviewEnvelope) <= 27_000, true, `${byteLength(maxPreviewEnvelope)} max-preview bytes`);

    const debugEnvelope = buildGroupedEnvelope(Array.from(
        { length: 20 },
        (_, index) => makeGroup(index, { debug: true }),
    ));
    assert.equal(byteLength(debugEnvelope) <= 48_000, true, `${byteLength(debugEnvelope)} debug bytes`);
});
