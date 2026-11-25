import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    buildSymbolRecordsForFile,
    createLanguageAnalysisService,
    type SymbolRecord,
    type SymbolRegistry,
} from "@satori-code/core";
import { CapabilityResolver } from "./capabilities.js";
import type { ContextMcpConfig } from "../config.js";
import {
    runExactRegistryFastPath,
    type SearchExactFastPathHost,
    type SearchExactFastPathInput,
} from "./search-exact-fast-path.js";
import {
    EXACT_HYDRATION_MAX_LINES,
    EXACT_HYDRATION_MAX_SOURCE_BYTES,
    attachHydratedExactSource,
} from "./search-exact-registry-hit.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { createSessionWorkspacePolicy } from "./session-workspace-policy.js";
import { searchCodebaseTool } from "../tools/search_codebase.js";
import type { ToolContext } from "../tools/types.js";

function sha256(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function makeSupport(): SearchQuerySupport {
    return new SearchQuerySupport({
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
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 1000,
    });
}

function makeRegistry(symbols: SymbolRecord[]): SymbolRegistry {
    const symbolsByInstanceId = new Map<string, SymbolRecord>();
    const symbolsByKey = new Map<string, SymbolRecord[]>();
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    const symbolsByLabel = new Map<string, SymbolRecord[]>();
    const symbolsByQualifiedName = new Map<string, SymbolRecord[]>();
    const symbolsByName = new Map<string, SymbolRecord[]>();
    for (const sym of symbols) {
        symbolsByInstanceId.set(sym.symbolInstanceId, sym);
        symbolsByKey.set(sym.symbolKey, [...(symbolsByKey.get(sym.symbolKey) ?? []), sym]);
        symbolsByFile.set(sym.file, [...(symbolsByFile.get(sym.file) ?? []), sym]);
        symbolsByLabel.set(sym.label, [...(symbolsByLabel.get(sym.label) ?? []), sym]);
        symbolsByQualifiedName.set(sym.qualifiedName, [...(symbolsByQualifiedName.get(sym.qualifiedName) ?? []), sym]);
        symbolsByName.set(sym.name, [...(symbolsByName.get(sym.name) ?? []), sym]);
    }
    return {
        manifest: { builtAt: "2026-11-24T00:00:00.000Z" } as SymbolRegistry["manifest"],
        symbols,
        symbolsByInstanceId,
        symbolsByKey,
        symbolsByFile,
        symbolsByLabel,
        symbolsByQualifiedName,
        symbolsByName,
        warnings: [],
    };
}

function makeHost(
    registry: SymbolRegistry,
    overrides: Partial<SearchExactFastPathHost> = {},
): SearchExactFastPathHost {
    return {
        searchQuerySupport: makeSupport(),
        measureSearchPhase: async (_phase, run) => run(),
        isPublishedSource: (symbol) => registry.symbolsByInstanceId.has(symbol.symbolInstanceId),
        loadRegistryManifest: async () => ({
            status: "ok",
            registry,
            manifestHash: "man-hydration-1",
        }),
        loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: true }),
        buildRelationshipBackedCallGraph: async () => null,
        buildChangedCodeDebug: async () => undefined,
        buildGeneratedArtifactsVerificationHint: () => undefined,
        getSearchNavigationHelpers: () => ({
            now: () => Date.parse("2026-11-24T00:00:00.000Z"),
            sanitizeIndexedRelativeFilePath: (f: string) => f,
            isCallGraphLanguageSupported: () => true,
            getOutlineStatusForLanguage: () => "ok",
        }),
        now: () => Date.parse("2026-11-24T00:00:00.000Z"),
        ...overrides,
    };
}

function makeInput(
    root: string,
    query: string,
    overrides: Partial<SearchExactFastPathInput> = {},
): SearchExactFastPathInput {
    const parsedOperators = parseSearchOperators(query);
    const queryPlan = buildSearchQueryPlan(query, true, parsedOperators);
    return {
        absolutePath: root,
        effectiveRoot: root,
        requestedSubdirectory: null,
        query,
        scope: "runtime",
        groupBy: "symbol",
        resultMode: "grouped",
        limit: 10,
        disclosureLimit: 10,
        includeResultIndex: false,
        debugMode: "none",
        rankingMode: "default",
        semanticQuery: parsedOperators.semanticQuery,
        parsedOperators,
        queryPlan,
        freshnessDecision: {
            mode: "skipped_recent",
            checkedAt: "2026-11-24T00:00:00.000Z",
            thresholdMs: 180_000,
        },
        freshnessSummary: {
            syncMode: "skipped_recent",
            lastSyncAt: null,
            changedFileCount: 0,
            gitDirtyFilesConsidered: true,
            changedFilesBoostApplied: false,
            changedFilesBoostSkippedForLargeChangeSet: false,
        },
        partialIndexSearchWarnings: [],
        phaseTimings: {
            prepareRead: 0,
            trackedRootResolution: 0,
            completionProof: 0,
            collectionProbe: 0,
            ensureFreshness: 0,
            exactRegistry: 0,
            semanticSearch: 0,
            trackedLexical: 0,
            rerank: 0,
            registryLoad: 0,
            grouping: 0,
            navigationValidation: 0,
            freshnessCheckpointProof: 0,
            freshnessExactPathComparison: 0,
            incrementalPublication: 0,
            publicationSourceNavigationLoad: 0,
            publicationFork: 0,
            publicationPayloadDelta: 0,
            publicationNavigationCheckpoint: 0,
            publicationNavigationDelta: 0,
            publicationRelationshipLoad: 0,
            publicationRelationshipDelta: 0,
            publicationSidecarStage: 0,
            publicationCheckpointStage: 0,
            publicationPayloadCount: 0,
            publicationActivation: 0,
            finalSourceValidation: 0,
        },
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
        changedFilesState: { available: true, files: new Set() },
        observedChangedFilesState: { available: true, files: new Set() },
        changedFilesCount: 0,
        changedFilesBoostSkippedForLargeChangeSet: false,
        dirtyFilesNotFreshened: false,
        rankingProvenance: {
            semanticPassesUsed: [],
            lexicalPassesUsed: [],
            livePathSupplementUsed: false,
            lexicalFileScanUsed: false,
            rerankApplied: false,
            exactMatchPinningApplied: false,
            registryRepairGroupCount: 0,
        },
        previewMaxBytes: 768,
        navigationAuthority: "valid",
        ...overrides,
    };
}

function withTempRepo(run: (root: string) => Promise<void>): Promise<void> {
    const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-a5-hydration-"));
    const root = fs.realpathSync(rawRoot);
    return run(root).finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
}

test("default hydrateExact omitted hydrates clean unique exact hits while explicit false disables hydration", async () => {
    await withTempRepo(async (root) => {
        const relFile = "src/service.ts";
        const fileText = [
            "export const HEADER = 1;",
            "export function computeInvoiceTotal(items: number[]): number {",
            "    return items.reduce((sum, item) => sum + item, 0);",
            "}",
        ].join("\n");
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, relFile), fileText, "utf8");

        const sym: SymbolRecord = {
            symbolKey: "src/service.ts:2:4:function:computeInvoiceTotal",
            symbolInstanceId: "syminst_compute_invoice_total",
            name: "computeInvoiceTotal",
            qualifiedName: "computeInvoiceTotal",
            parentQualifiedNamePath: [],
            kind: "function",
            file: relFile,
            label: "function computeInvoiceTotal(items: number[]): number",
            span: { startLine: 2, endLine: 4 },
            language: "typescript",
            fileHash: sha256(fileText),
            extractorVersion: "1.0.0",
        };
        const host = makeHost(makeRegistry([sym]));

        const omitted = await runExactRegistryFastPath(
            makeInput(root, "computeInvoiceTotal"),
            host,
        );
        const explicitTrue = await runExactRegistryFastPath(
            makeInput(root, "computeInvoiceTotal", { hydrateExact: true }),
            host,
        );
        const explicitFalse = await runExactRegistryFastPath(
            makeInput(root, "computeInvoiceTotal", { hydrateExact: false }),
            host,
        );

        assert.equal(omitted.kind, "handled");
        assert.equal(explicitTrue.kind, "handled");
        assert.equal(explicitFalse.kind, "handled");
        if (omitted.kind !== "handled" || explicitTrue.kind !== "handled" || explicitFalse.kind !== "handled") return;
        assert.equal(omitted.finalized.kind, "ok");
        assert.equal(explicitTrue.finalized.kind, "ok");
        assert.equal(explicitFalse.finalized.kind, "ok");
        if (omitted.finalized.kind !== "ok" || explicitTrue.finalized.kind !== "ok" || explicitFalse.finalized.kind !== "ok") return;
        assert.equal(omitted.finalized.envelope.resultMode, "grouped");
        assert.equal(explicitTrue.finalized.envelope.resultMode, "grouped");
        assert.equal(explicitFalse.finalized.envelope.resultMode, "grouped");
        if (omitted.finalized.envelope.resultMode !== "grouped" || explicitTrue.finalized.envelope.resultMode !== "grouped" || explicitFalse.finalized.envelope.resultMode !== "grouped") return;

        assert.deepEqual(omitted.hydratedExactSource, explicitTrue.hydratedExactSource);
        assert.equal(omitted.hydratedExactSource?.completeSymbolReturned, true);
        assert.equal(explicitFalse.hydratedExactSource, undefined);
    });
});

test("clean unique non-oversized exact hit with hydrateExact=true returns complete hydratedExactSource and preserves existing fields", async () => {
    await withTempRepo(async (root) => {
        const relFile = "src/service.ts";
        const bodyLines = [
            "export function resolveBillingPlan(tier: string): number {",
            "    if (tier === 'pro') return 20;",
            "    return 0;",
            "}",
        ];
        const fileText = `// prelude\n${bodyLines.join("\n")}\n// epilogue\n`;
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, relFile), fileText, "utf8");

        const sym: SymbolRecord = {
            symbolKey: "src/service.ts:2:5:function:resolveBillingPlan",
            symbolInstanceId: "syminst_resolve_billing_plan",
            name: "resolveBillingPlan",
            qualifiedName: "resolveBillingPlan",
            parentQualifiedNamePath: [],
            kind: "function",
            file: relFile,
            label: "function resolveBillingPlan(tier: string): number",
            span: { startLine: 2, endLine: 5 },
            language: "typescript",
            fileHash: sha256(fileText),
            extractorVersion: "1.0.0",
        };
        const host = makeHost(makeRegistry([sym]));

        const control = await runExactRegistryFastPath(
            makeInput(root, "resolveBillingPlan"),
            host,
        );
        const hydrated = await runExactRegistryFastPath(
            makeInput(root, "resolveBillingPlan", { hydrateExact: true }),
            host,
        );

        assert.equal(control.kind, "handled");
        assert.equal(hydrated.kind, "handled");
        if (control.kind !== "handled" || hydrated.kind !== "handled") return;
        assert.equal(control.finalized.kind, "ok");
        assert.equal(hydrated.finalized.kind, "ok");
        if (control.finalized.kind !== "ok" || hydrated.finalized.kind !== "ok") return;
        assert.equal(control.finalized.envelope.resultMode, "grouped");
        assert.equal(hydrated.finalized.envelope.resultMode, "grouped");
        if (control.finalized.envelope.resultMode !== "grouped" || hydrated.finalized.envelope.resultMode !== "grouped") return;

        const ctrlEnv = control.finalized.envelope;
        const hydEnv = attachHydratedExactSource(hydrated.finalized.envelope, hydrated.hydratedExactSource, 48 * 1024);

        assert.deepEqual(hydEnv.hydratedExactSource, {
            file: relFile,
            symbolId: sym.symbolInstanceId,
            span: { startLine: 2, endLine: 5 },
            returnedSpan: { startLine: 2, endLine: 5 },
            completeSymbolReturned: true,
            truncated: false,
            content: bodyLines.join("\n"),
            sourceAuthority: "publication_hash_matched",
        });

        // Existing result/count/continuation fields are preserved identically,
        // while recommendedNextAction shifts from redundant source-definition read
        // to source-free call_context when the complete symbol is already hydrated.
        assert.deepEqual(hydEnv.results, ctrlEnv.results);
        assert.deepEqual(hydEnv.resultCounts, ctrlEnv.resultCounts);
        assert.deepEqual(hydEnv.continuation, ctrlEnv.continuation);
        assert.ok(ctrlEnv.recommendedNextAction);
        assert.equal(hydEnv.recommendedNextAction?.tool, "read_file");
        const ctrlActionArgs = ctrlEnv.recommendedNextAction.args as { open_symbol: Record<string, unknown> };
        assert.deepEqual(hydEnv.recommendedNextAction?.args, {
            ...ctrlActionArgs,
            open_symbol: {
                ...ctrlActionArgs.open_symbol,
                context: {
                    preset: "call_context",
                    include: { source: false },
                },
            },
        });
        assert.match(hydEnv.recommendedNextAction?.reason ?? "", /already in hydratedExactSource/);

        // SATORI_HYDRATE_EXACT=0 disables hydration when hydrateExact is omitted,
        // while explicit hydrateExact=true still overrides it.
        const prevEnv = process.env.SATORI_HYDRATE_EXACT;
        process.env.SATORI_HYDRATE_EXACT = "0";
        try {
            const envDisabled = await runExactRegistryFastPath(
                makeInput(root, "resolveBillingPlan"),
                host,
            );
            assert.equal(envDisabled.kind, "handled");
            if (envDisabled.kind === "handled") {
                assert.equal(envDisabled.hydratedExactSource, undefined);
            }
            const explicitTrueOverride = await runExactRegistryFastPath(
                makeInput(root, "resolveBillingPlan", { hydrateExact: true }),
                host,
            );
            assert.equal(explicitTrueOverride.kind, "handled");
            if (explicitTrueOverride.kind === "handled") {
                assert.equal(explicitTrueOverride.hydratedExactSource?.completeSymbolReturned, true);
            }
        } finally {
            if (prevEnv === undefined) delete process.env.SATORI_HYDRATE_EXACT;
            else process.env.SATORI_HYDRATE_EXACT = prevEnv;
        }
    });
});

test("clean unique oversized 434-line exact hit with hydrateExact=true returns bounded excerpt and preserves open_symbol action", async () => {
    await withTempRepo(async (root) => {
        const relFile = "src/search-exact-fast-path.ts";
        const prelude = Array.from({ length: 226 }, (_, i) => `// prelude ${i + 1}`);
        const symbolBody = Array.from({ length: 434 }, (_, i) => (
            i === 0
                ? "export async function runExactRegistryFastPath(): Promise<void> {"
                : i === 433
                    ? "}"
                    : `    const step${i} = ${i};`
        ));
        const fileText = [...prelude, ...symbolBody].join("\n");
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, relFile), fileText, "utf8");

        const sym: SymbolRecord = {
            symbolKey: `${relFile}:227:660:function:runExactRegistryFastPath`,
            symbolInstanceId: "syminst_run_exact_fast_path",
            name: "runExactRegistryFastPath",
            qualifiedName: "runExactRegistryFastPath",
            parentQualifiedNamePath: [],
            kind: "function",
            file: relFile,
            label: "function runExactRegistryFastPath()",
            span: { startLine: 227, endLine: 660 },
            language: "typescript",
            fileHash: sha256(fileText),
            extractorVersion: "1.0.0",
        };
        const host = makeHost(makeRegistry([sym]));

        const outcome = await runExactRegistryFastPath(
            makeInput(root, "runExactRegistryFastPath", { hydrateExact: true }),
            host,
        );

        assert.equal(outcome.kind, "handled");
        if (outcome.kind !== "handled" || outcome.finalized.kind !== "ok") return;
        assert.equal(outcome.finalized.envelope.resultMode, "grouped");
        if (outcome.finalized.envelope.resultMode !== "grouped") return;
        const env = attachHydratedExactSource(outcome.finalized.envelope, outcome.hydratedExactSource, 48 * 1024);

        assert.ok(env.hydratedExactSource);
        assert.equal(env.hydratedExactSource.file, relFile);
        assert.equal(env.hydratedExactSource.symbolId, sym.symbolInstanceId);
        assert.deepEqual(env.hydratedExactSource.span, { startLine: 227, endLine: 660 });
        assert.equal(env.hydratedExactSource.returnedSpan.startLine, 227);
        assert.ok(env.hydratedExactSource.returnedSpan.endLine < 660);
        assert.equal(
            env.hydratedExactSource.returnedSpan.endLine - env.hydratedExactSource.returnedSpan.startLine + 1,
            EXACT_HYDRATION_MAX_LINES,
        );
        assert.equal(env.hydratedExactSource.completeSymbolReturned, false);
        assert.equal(env.hydratedExactSource.truncated, true);
        assert.equal(env.hydratedExactSource.sourceAuthority, "publication_hash_matched");
        assert.ok(Buffer.byteLength(env.hydratedExactSource.content, "utf8") <= EXACT_HYDRATION_MAX_SOURCE_BYTES);
        assert.match(env.hydratedExactSource.content, /^export async function runExactRegistryFastPath/);

        // Preserves open_symbol recommendedNextAction on oversized exact hit
        assert.equal(env.recommendedNextAction?.tool, "read_file");
        assert.deepEqual(env.recommendedNextAction?.args, {
            path: path.join(root, relFile),
            mode: "plain",
            codebaseRoot: root,
            open_symbol: {
                contractVersion: 2,
                symbolId: sym.symbolInstanceId,
                context: { preset: "definition" },
            },
        });
    });
});

test("ambiguous, dirty, stale, hash-mismatched, and reference-pass hits fail closed without hydratedExactSource", async () => {
    await withTempRepo(async (root) => {
        const fileA = "src/alpha.ts";
        const fileB = "src/beta.ts";
        const textA = "export function duplicateHandler(): number {\n    return 1;\n}\n";
        const textB = "export function duplicateHandler(): number {\n    return 2;\n}\n";
        const textClean = "export function cleanSingleTarget(): number {\n    return 3;\n}\n";
        const fileClean = "src/clean.ts";
        const fileCaller = "src/caller.ts";
        const textCaller = "import { cleanSingleTarget } from './clean';\nexport function runCaller() { return cleanSingleTarget(); }\n";

        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, fileA), textA, "utf8");
        fs.writeFileSync(path.join(root, fileB), textB, "utf8");
        fs.writeFileSync(path.join(root, fileClean), textClean, "utf8");
        fs.writeFileSync(path.join(root, fileCaller), textCaller, "utf8");

        const symDupA: SymbolRecord = {
            symbolKey: "src/alpha.ts:1:3:function:duplicateHandler",
            symbolInstanceId: "syminst_dup_a",
            name: "duplicateHandler",
            qualifiedName: "duplicateHandler",
            parentQualifiedNamePath: [],
            kind: "function",
            file: fileA,
            label: "function duplicateHandler()",
            span: { startLine: 1, endLine: 3 },
            language: "typescript",
            fileHash: sha256(textA),
            extractorVersion: "1.0.0",
        };
        const symDupB: SymbolRecord = {
            symbolKey: "src/beta.ts:1:3:function:duplicateHandler",
            symbolInstanceId: "syminst_dup_b",
            name: "duplicateHandler",
            qualifiedName: "duplicateHandler",
            parentQualifiedNamePath: [],
            kind: "function",
            file: fileB,
            label: "function duplicateHandler()",
            span: { startLine: 1, endLine: 3 },
            language: "typescript",
            fileHash: sha256(textB),
            extractorVersion: "1.0.0",
        };
        const analyzer = createLanguageAnalysisService({ chunkSize: 64 * 1024, chunkOverlap: 0 });
        const analysisClean = await analyzer.analyze({
            content: textClean,
            language: "typescript",
            relativePath: fileClean,
        });
        const builtCleanSymbols = buildSymbolRecordsForFile({
            relativePath: fileClean,
            language: "typescript",
            content: textClean,
            fileHash: sha256(textClean),
            extractorVersion: "1.0.0",
            chunks: [...analysisClean.chunks],
            extractedSymbols: analysisClean.symbols,
        });
        const symClean = builtCleanSymbols.find((s) => s.name === "cleanSingleTarget");
        assert.ok(symClean, "expected extracted symbol for cleanSingleTarget");
        const symCaller: SymbolRecord = {
            symbolKey: "src/caller.ts:2:2:function:runCaller",
            symbolInstanceId: "syminst_caller",
            name: "runCaller",
            qualifiedName: "runCaller",
            parentQualifiedNamePath: [],
            kind: "function",
            file: fileCaller,
            label: "function runCaller()",
            span: { startLine: 2, endLine: 2 },
            language: "typescript",
            fileHash: sha256(textCaller),
            extractorVersion: "1.0.0",
        };

        const registry = makeRegistry([symDupA, symDupB, symClean, symCaller]);
        const host = makeHost(registry, {
            buildRelationshipBackedCallGraph: async () => ({
                supported: true,
                direction: "callers",
                depth: 1,
                limit: 10,
                source: "relationship_sidecar",
                nodes: [
                    { symbolId: symClean.symbolInstanceId, label: "cleanSingleTarget", file: fileClean },
                    { symbolId: symCaller.symbolInstanceId, label: "runCaller", file: fileCaller },
                ],
                edges: [
                    { srcSymbolId: symCaller.symbolInstanceId, dstSymbolId: symClean.symbolInstanceId, kind: "CALLS" as const },
                ],
                metrics: { edgeCount: 1, nodeCount: 2, truncated: false },
            } as never),
        });

        // 1. Ambiguous exact hit (>= 2 declarations)
        const ambiguousOutcome = await runExactRegistryFastPath(
            makeInput(root, "duplicateHandler", { hydrateExact: true }),
            host,
        );
        assert.equal(ambiguousOutcome.kind, "handled");
        if (ambiguousOutcome.kind === "handled" && ambiguousOutcome.finalized.kind === "ok") {
            assert.equal(ambiguousOutcome.finalized.envelope.resultMode, "grouped");
            if (ambiguousOutcome.finalized.envelope.resultMode === "grouped") {
                assert.equal(ambiguousOutcome.finalized.envelope.results.length, 2);
                assert.equal(ambiguousOutcome.hydratedExactSource, undefined);
            }
        }

        // 2. Dirty target (exactTargetWasDirty === true, even if content happens to match)
        const dirtyOutcome = await runExactRegistryFastPath(
            makeInput(root, "cleanSingleTarget", {
                hydrateExact: true,
                dirtyFilesNotFreshened: true,
                changedFilesState: { available: true, files: new Set([fileClean]) },
                observedChangedFilesState: { available: true, files: new Set([fileClean]) },
            }),
            host,
        );
        assert.equal(dirtyOutcome.kind, "handled");
        if (dirtyOutcome.kind === "handled" && dirtyOutcome.finalized.kind === "ok") {
            assert.equal(dirtyOutcome.finalized.envelope.resultMode, "grouped");
            if (dirtyOutcome.finalized.envelope.resultMode === "grouped") {
                assert.equal(dirtyOutcome.finalized.envelope.results.length, 1);
                assert.equal(dirtyOutcome.hydratedExactSource, undefined);
            }
        }

        // 3. Stale publication (served_previous_generation)
        const staleOutcome = await runExactRegistryFastPath(
            makeInput(root, "cleanSingleTarget", {
                hydrateExact: true,
                freshnessDecision: {
                    mode: "served_previous_generation",
                    checkedAt: "2026-11-24T00:00:00.000Z",
                    thresholdMs: 0,
                },
            }),
            host,
        );
        assert.equal(staleOutcome.kind, "handled");
        if (staleOutcome.kind === "handled" && staleOutcome.finalized.kind === "ok") {
            assert.equal(staleOutcome.finalized.envelope.resultMode, "grouped");
            if (staleOutcome.finalized.envelope.resultMode === "grouped") {
                assert.equal(staleOutcome.finalized.envelope.results.length, 1);
                assert.equal(staleOutcome.hydratedExactSource, undefined);
            }
        }

        // 4. Reference-seeking query (relationshipPassUsed === true)
        const refOutcome = await runExactRegistryFastPath(
            makeInput(root, "who calls cleanSingleTarget", { hydrateExact: true }),
            host,
        );
        assert.equal(refOutcome.kind, "handled");
        if (refOutcome.kind === "handled" && refOutcome.finalized.kind === "ok") {
            assert.equal(refOutcome.finalized.envelope.resultMode, "grouped");
            if (refOutcome.finalized.envelope.resultMode === "grouped") {
                assert.ok(refOutcome.finalized.envelope.results.length >= 1);
                assert.equal(refOutcome.hydratedExactSource, undefined);
            }
        }

        // 5. Disk file edited after Publication without git dirty flag (hash mismatch)
        fs.writeFileSync(path.join(root, fileClean), "export function cleanSingleTarget(): number {\n    return 999;\n}\n", "utf8");
        const hashMismatchOutcome = await runExactRegistryFastPath(
            makeInput(root, "cleanSingleTarget", { hydrateExact: true }),
            host,
        );
        assert.equal(hashMismatchOutcome.kind, "handled");
        if (hashMismatchOutcome.kind === "handled" && hashMismatchOutcome.finalized.kind === "ok") {
            assert.equal(hashMismatchOutcome.finalized.envelope.resultMode, "grouped");
            if (hashMismatchOutcome.finalized.envelope.resultMode === "grouped") {
                assert.equal(hashMismatchOutcome.finalized.envelope.results.length, 1);
                assert.equal(hashMismatchOutcome.hydratedExactSource, undefined);
            }
        }
    });
});

test("search_codebase tool forwards optional hydrateExact and rejects non-boolean values", async () => {
    const config: ContextMcpConfig = {
        name: "test",
        version: "1.0.0",
        stateRoot: path.join(os.tmpdir(), "satori-test-state-root"),
        executionProfile: "connected",
        networkPolicy: { kind: "remote-allowed" },
        vectorStoreProvider: "Milvus",
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-4-large",
        encoderOutputDimension: 1024,
        voyageKey: "voyage-key",
        milvusEndpoint: "https://example.zilliz.com",
        milvusApiToken: "token",
        rankerModel: "rerank-2.5",
    };
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
        capabilities: new CapabilityResolver(config),
        workspacePolicy: createSessionWorkspacePolicy({
            roots: ["/repo"],
            homeDirectory: os.homedir(),
            stateRoot: path.join(os.tmpdir(), "satori-hydration-tool-test"),
        }),
        toolHandlers: {
            handleSearchCode: async (args: Record<string, unknown>) => {
                calls.push(args);
                return { content: [{ type: "text" as const, text: '{"status":"ok","results":[]}' }] };
            },
        },
    } as unknown as ToolContext;

    const omitted = await searchCodebaseTool.execute({ path: "/repo", query: "computeInvoiceTotal" }, ctx);
    const enabled = await searchCodebaseTool.execute({ path: "/repo", query: "computeInvoiceTotal", hydrateExact: true }, ctx);
    const invalid = await searchCodebaseTool.execute({ path: "/repo", query: "computeInvoiceTotal", hydrateExact: "yes" }, ctx);

    assert.equal(omitted.isError, undefined);
    assert.equal(enabled.isError, undefined);
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0] ?? {}, "hydrateExact"), false);
    assert.equal(calls[1]?.hydrateExact, true);
});
