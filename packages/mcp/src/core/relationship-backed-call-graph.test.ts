import test from "node:test";
import assert from "node:assert/strict";
import {
    buildSymbolRegistry,
    isTestOrFixturePath,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import {
    RelationshipBackedCallGraph,
    prioritizeInboundSuppressedNotes,
    shouldInspectInboundSourceReferences,
    uniqueInboundCallerSiteFile,
} from "./relationship-backed-call-graph.js";
import { projectCallGraphEvidence } from "./call-graph-evidence-projection.js";
import type { CallGraphNoteResult as CallGraphNote } from "./search-types.js";

test("uniqueInboundCallerSiteFile returns sole suppressed caller site, else undefined", () => {
    const one: CallGraphNote[] = [{
        type: "suppressed_edge",
        file: "src/caller.ts",
        startLine: 10,
        detail: "Suppressed low-confidence caller candidate function run() at src/caller.ts:10.",
    }];
    assert.equal(uniqueInboundCallerSiteFile(one), "src/caller.ts");

    const multi: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "src/a.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate function a() at src/a.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/b.ts",
            startLine: 2,
            detail: "Suppressed low-confidence caller candidate function b() at src/b.ts:2.",
        },
    ];
    assert.equal(uniqueInboundCallerSiteFile(multi), undefined);

    const mixedProdAndTest: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "src/core/gate.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate async function <anonymous>() at src/core/gate.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/core/handlers.ts",
            startLine: 20,
            detail: "Suppressed low-confidence caller candidate method run() at src/core/handlers.ts:20.",
        },
        {
            type: "suppressed_edge",
            file: "src/core/gate.spec.ts",
            startLine: 5,
            detail: "Suppressed low-confidence caller candidate function now() at src/core/gate.spec.ts:5.",
        },
    ];
    assert.equal(uniqueInboundCallerSiteFile(mixedProdAndTest), "src/core/handlers.ts");
});

test("isTestOrFixturePath detects test and fixture paths", () => {
    assert.equal(isTestOrFixturePath("packages/mcp/src/core/runtime-owner.test.ts"), true);
    assert.equal(isTestOrFixturePath("packages/mcp/src/core/runtime-owner.ts"), false);
    assert.equal(isTestOrFixturePath("fixtures/navigation/go-basic-symbols/svc.go"), true);
});

test("prioritizeInboundSuppressedNotes puts production callers first and collapses excess tests", () => {
    const notes: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "a.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t1 at a.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "b.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t2 at b.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "c.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t3 at c.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "d.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t4 at d.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/prod.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate method run() at src/prod.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/other.ts",
            startLine: 1,
            detail: "Suppressed low-confidence callee candidate x at src/other.ts:1.",
        },
    ];
    const prioritized = prioritizeInboundSuppressedNotes(notes);
    assert.equal(prioritized[0]?.file, "src/prod.ts");
    const testDetailed = prioritized.filter((n) => n.file && isTestOrFixturePath(n.file));
    assert.equal(testDetailed.length, 3);
    assert.ok(prioritized.some((n) => typeof n.detail === "string" && n.detail.includes("additional low-confidence test/fixture")));
    assert.ok(prioritized.some((n) => n.detail?.includes("callee candidate")));
});

test("exact source fallback is required for absent or bounded inbound coverage, never callee-only traversal", () => {
    assert.equal(shouldInspectInboundSourceReferences({
        direction: "callers",
        hasNoInboundEdges: true,
        suppressedInboundCount: 0,
        warnings: [],
    }), true);
    assert.equal(shouldInspectInboundSourceReferences({
        direction: "both",
        hasNoInboundEdges: false,
        suppressedInboundCount: 0,
        warnings: ["RELATIONSHIP_TRAVERSAL_TRUNCATED"],
    }), true);
    assert.equal(shouldInspectInboundSourceReferences({
        direction: "callers",
        hasNoInboundEdges: false,
        suppressedInboundCount: 1,
        warnings: [],
    }), true);
    assert.equal(shouldInspectInboundSourceReferences({
        direction: "callees",
        hasNoInboundEdges: true,
        suppressedInboundCount: 1,
        warnings: ["RELATIONSHIP_TRAVERSAL_LIMIT_REACHED"],
    }), false);
});

test("uniqueInboundCallerSiteFile ignores callee-only and aggregate notes", () => {
    const ignored: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "src/callee.ts",
            startLine: 5,
            detail: "Suppressed low-confidence callee candidate function helper() at src/callee.ts:5.",
        },
        {
            type: "suppressed_edge",
            file: "(aggregate)",
            startLine: 0,
            detail: "Suppressed 2 additional low-confidence test/fixture caller candidate(s).",
        },
    ];
    assert.equal(uniqueInboundCallerSiteFile(ignored), undefined);
});

test("call graph source fallback propagates partial Publication coverage without fabricating stale references", async () => {
    const target = {
        symbolKey: "target-key",
        symbolInstanceId: "target-id",
        language: "typescript",
        kind: "function",
        qualifiedName: "target",
        name: "target",
        label: "function target()",
        span: { startLine: 1, endLine: 1 },
        parentQualifiedNamePath: [],
        file: "src/target.ts",
        fileHash: "target-hash",
        extractorVersion: "fixture",
    } as SymbolRecord;
    const caller = {
        ...target,
        symbolKey: "caller-key",
        symbolInstanceId: "caller-id",
        qualifiedName: "caller",
        name: "caller",
        label: "function caller()",
        file: "src/caller.ts",
    } as SymbolRecord;
    const registry = {
        manifest: { files: [] },
        symbolsByFile: new Map([
            [target.file, [target]],
            [caller.file, [caller]],
        ]),
        symbolsByInstanceId: new Map([
            [target.symbolInstanceId, target],
            [caller.symbolInstanceId, caller],
        ]),
    } as unknown as SymbolRegistry;
    const relationshipManifest = {
        schemaVersion: "relationship_v3",
        symbolRegistryManifestHash: "registry-hash",
        relationshipVersion: "fixture",
        builtAt: "2026-09-22T00:00:00.000Z",
        files: [],
    };
    const navigationStore = {
        getRelationships: async () => ({
            status: "ok",
            rootPath: "/repo",
            manifest: relationshipManifest,
            records: [],
            analysisByFile: new Map(),
            warnings: [],
        }),
        getResolutionEvidence: async () => ({
            status: "ok",
            rootPath: "/repo",
            manifest: relationshipManifest,
            matches: [],
            warnings: [],
        }),
    };
    const graph = new RelationshipBackedCallGraph({ navigationStore: navigationStore as never });
    const result = await graph.build({
        codebaseRoot: "/repo",
        publicationId: "publication-old",
        navigationRoot: "/state/publication-old/navigation",
        registry,
        registryManifestHash: "registry-hash",
        resolvedSymbol: target,
        direction: "callers",
        depth: 1,
        limit: 20,
        findExactSourceReferences: async () => ({
            target: {
                symbolId: target.symbolInstanceId,
                symbolLabel: target.label,
                name: target.name,
                qualifiedName: target.qualifiedName,
                file: target.file,
                span: target.span,
            },
            references: [{
                file: "src/current.ts",
                span: { startLine: 2, endLine: 2, startColumn: 3, endColumn: 9 },
                owningSymbol: {
                    symbolId: caller.symbolInstanceId,
                    symbolLabel: caller.label,
                    file: caller.file,
                    span: caller.span,
                },
                occurrenceKind: "identifier",
                matchedText: "target",
                evidenceClass: "published_source_text",
            }],
            coverage: {
                status: "partial",
                publishedFileCount: 3,
                eligibleFileCount: 3,
                inspectedFileCount: 2,
                skippedFileCount: 1,
                matchedOccurrenceCount: 1,
                returnedOccurrenceCount: 1,
                reasons: [{ code: "source_changed", file: "src/stale.ts" }],
            },
        }),
    });

    assert.ok(result);
    assert.equal(result!.sourceReferenceCoverage?.status, "partial");
    assert.equal(result!.inboundCoverageEvidence?.sourceReferenceCoverage, "partial");
    assert.ok(result!.warnings?.includes("CALL_GRAPH_SOURCE_REFERENCE_COVERAGE_PARTIAL"));
    assert.deepEqual(result!.sourceReferences?.map((reference) => reference.site.file), ["src/current.ts"]);
    assert.equal(result!.sourceReferences?.some((reference) => reference.site.file === "src/stale.ts"), false);
});

test("call graph retains exact reference evidence beyond the legacy 100-row disclosure ceiling", async () => {
    const target = {
        symbolKey: "target-key",
        symbolInstanceId: "target-id",
        language: "typescript",
        kind: "method",
        qualifiedName: "Target.request",
        name: "request",
        label: "method request()",
        span: { startLine: 1, endLine: 3 },
        parentQualifiedNamePath: ["Target"],
        file: "src/target.ts",
        fileHash: "target-hash",
        extractorVersion: "fixture",
    } as SymbolRecord;
    const registry = {
        manifest: { files: [] },
        symbolsByFile: new Map([[target.file, [target]]]),
        symbolsByInstanceId: new Map([[target.symbolInstanceId, target]]),
    } as unknown as SymbolRegistry;
    const relationshipManifest = {
        schemaVersion: "relationship_v3",
        symbolRegistryManifestHash: "registry-hash",
        relationshipVersion: "fixture",
        builtAt: "2026-09-22T00:00:00.000Z",
        files: [],
    };
    const inboundMatches = Array.from({ length: 125 }, (_, index) => ({
        matchKind: "resolved_target" as const,
        claim: {
            providerId: "fixture",
            providerVersion: "v1",
            environmentConfigId: "fixture-env",
            sourceFile: `tests/case-${String(index).padStart(3, "0")}.ts`,
            targetInstanceId: target.symbolInstanceId,
            targetSymbol: target.qualifiedName,
            callSpan: {
                startLine: index + 1,
                endLine: index + 1,
                startByte: index * 10,
                endByte: index * 10 + 8,
                startColumn: 0,
                endColumn: 8,
            },
            observation: {
                kind: "call" as const,
                calleeName: "request",
                calleeText: "client.request",
                construct: "typed_member_call" as const,
                candidates: [],
            },
            decision: "resolved" as const,
            relationshipType: "REFERENCES" as const,
            resolutionAuthority: "direct_binding" as const,
            proofSteps: [{
                kind: "exact_target_definition" as const,
                subject: target.qualifiedName,
            }],
            dependencyKeys: [],
            flowHops: 0,
        },
    }));
    const navigationStore = {
        getRelationships: async () => ({
            status: "ok",
            rootPath: "/repo",
            manifest: relationshipManifest,
            records: [],
            analysisByFile: new Map(),
            warnings: [],
        }),
        getResolutionEvidence: async (input: { sourceInstanceId?: string }) => ({
            status: "ok",
            rootPath: "/repo",
            manifest: relationshipManifest,
            matches: input.sourceInstanceId ? [] : inboundMatches,
            warnings: [],
        }),
    };
    const graph = new RelationshipBackedCallGraph({ navigationStore: navigationStore as never });
    const result = await graph.build({
        codebaseRoot: "/repo",
        publicationId: "publication-1",
        navigationRoot: "/state/publication-1/navigation",
        registry,
        registryManifestHash: "registry-hash",
        resolvedSymbol: target,
        direction: "callers",
        depth: 1,
        limit: 20,
    });

    assert.ok(result);
    assert.equal(result!.exactReferences?.length, 125);
    assert.equal(result!.exactReferences?.[124]?.site.file, "tests/case-124.ts");
    assert.equal(result!.warnings?.includes("CALL_GRAPH_EXACT_REFERENCES_LIMIT_REACHED"), false);
});

test("call graph path scope excludes sibling graph and semantic evidence before summary and paging", async () => {
    const symbol = (id: string, file: string, name: string): SymbolRecord => ({
        symbolKey: `${id}-key`,
        symbolInstanceId: id,
        language: "typescript",
        kind: "function",
        qualifiedName: name,
        name,
        label: `function ${name}()`,
        span: { startLine: 1, endLine: 3 },
        parentQualifiedNamePath: [],
        file,
        fileHash: `${id}-hash`,
        extractorVersion: "fixture",
    });
    const target = symbol("target-id", "packages/a/src/target.ts", "target");
    const localCaller = symbol("local-caller-id", "packages/a/src/local-caller.ts", "localCaller");
    const siblingCaller = symbol("sibling-caller-id", "packages/b/src/caller.ts", "siblingCaller");
    const localTest = symbol("local-test-id", "packages/a/test/target.test.ts", "localTest");
    const siblingTest = symbol("sibling-test-id", "packages/b/test/target.test.ts", "siblingTest");
    const registry = buildSymbolRegistry({
        manifest: { files: [] } as never,
        symbols: [target, localCaller, siblingCaller, localTest, siblingTest],
    });
    const relationshipManifest = {
        schemaVersion: "relationship_v3",
        symbolRegistryManifestHash: "registry-hash",
        relationshipVersion: "fixture",
        builtAt: "2026-09-22T00:00:00.000Z",
        files: [],
    };
    const callRecord = (source: SymbolRecord): RelationshipRecord => ({
        sourceKey: source.symbolKey,
        sourceInstanceId: source.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type: "CALLS",
        file: source.file,
        span: { startLine: 2, endLine: 2 },
        confidence: "high",
        resolutionAuthority: "direct_binding",
    });
    const testRecord = (source: SymbolRecord): RelationshipRecord => ({
        sourceKey: source.symbolKey,
        sourceInstanceId: source.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type: "TESTS",
        file: source.file,
        span: { startLine: 2, endLine: 2 },
        confidence: "high",
    });
    const resolvedTargetMatch = (sourceFile: string, sourceInstanceId?: string) => ({
        matchKind: "resolved_target" as const,
        claim: {
            providerId: "fixture",
            providerVersion: "v1",
            environmentConfigId: "fixture-env",
            sourceFile,
            ...(sourceInstanceId ? { sourceInstanceId } : {}),
            targetInstanceId: target.symbolInstanceId,
            targetSymbol: target.qualifiedName,
            callSpan: {
                startLine: 2,
                endLine: 2,
                startByte: 10,
                endByte: 20,
                startColumn: 0,
                endColumn: 10,
            },
            observation: {
                kind: "call" as const,
                calleeName: "target",
                calleeText: "target()",
                construct: "direct_call" as const,
                candidates: [],
            },
            decision: "resolved" as const,
            relationshipType: "REFERENCES" as const,
            resolutionAuthority: "direct_binding" as const,
            proofSteps: [],
            dependencyKeys: [],
            flowHops: 0,
        },
    });
    const sourceGapMatch = (sourceFile: string) => ({
        matchKind: "source_call" as const,
        claim: {
            providerId: "fixture",
            providerVersion: "v1",
            environmentConfigId: "fixture-env",
            sourceFile,
            sourceInstanceId: target.symbolInstanceId,
            callSpan: {
                startLine: 2,
                endLine: 2,
                startByte: 30,
                endByte: 40,
                startColumn: 0,
                endColumn: 10,
            },
            observation: {
                kind: "call" as const,
                calleeName: "missing",
                calleeText: "missing()",
                construct: "direct_call" as const,
                candidates: [],
            },
            decision: "unresolved" as const,
            relationshipType: "CALLS" as const,
            resolutionAuthority: "unresolved" as const,
            proofSteps: [],
            dependencyKeys: [],
            flowHops: 0,
        },
    });
    const records = [
        callRecord(localCaller),
        callRecord(siblingCaller),
        testRecord(localTest),
        testRecord(siblingTest),
    ];
    const navigationStore = {
        getManifest: async () => ({
            status: "ok",
            rootPath: "/repo",
            manifestHash: "registry-hash",
            registryManifestHash: "registry-hash",
            registry,
            warnings: [],
        }),
        getRelationships: async () => ({
            status: "ok",
            rootPath: "/repo",
            manifestHash: "relationship-hash",
            manifest: relationshipManifest,
            records,
            analysisByFile: new Map(),
            warnings: [],
        }),
        getResolutionEvidence: async (input: { sourceInstanceId?: string }) => ({
            status: "ok",
            rootPath: "/repo",
            manifestHash: "relationship-hash",
            manifest: relationshipManifest,
            matches: input.sourceInstanceId
                ? [
                    sourceGapMatch(target.file),
                    sourceGapMatch("packages/b/src/foreign-source.ts"),
                ]
                : [
                    resolvedTargetMatch(localCaller.file, localCaller.symbolInstanceId),
                    resolvedTargetMatch(siblingCaller.file, siblingCaller.symbolInstanceId),
                    resolvedTargetMatch("packages/a/src/ownerless.ts"),
                    resolvedTargetMatch("packages/b/src/ownerless.ts"),
                ],
            warnings: [],
        }),
    };
    const graph = new RelationshipBackedCallGraph({ navigationStore: navigationStore as never });
    const result = await graph.build({
        codebaseRoot: "/repo",
        publicationId: "publication-1",
        navigationRoot: "/state/publication-1/navigation",
        registry,
        registryManifestHash: "registry-hash",
        resolvedSymbol: target,
        direction: "callers",
        depth: 2,
        limit: 20,
        pathScope: { subtree: "packages/a" },
    });

    assert.ok(result);
    assert.deepEqual(result!.edges.map((edge) => edge.srcSymbolId), [localCaller.symbolInstanceId]);
    assert.deepEqual(result!.nodes.map((node) => node.symbolId).sort(), [
        localCaller.symbolInstanceId,
        target.symbolInstanceId,
    ].sort());
    assert.deepEqual(result!.exactReferences?.map((reference) => reference.site.file), [
        localCaller.file,
        "packages/a/src/ownerless.ts",
    ]);
    assert.deepEqual(result!.testReferences?.map((reference) => reference.file), [localTest.file]);
    assert.equal(result!.constructCoverage?.[0]?.gapCount, 1);
    assert.equal(result!.constructCoverage?.[0]?.gapSpans[0]?.file, target.file);

    const envelope = {
        status: "ok" as const,
        path: "/repo/packages/a",
        codebaseRoot: "/repo",
        symbolRef: { file: target.file, symbolId: target.symbolInstanceId },
        navigationAuthority: {
            publicationId: "publication-1",
            relationshipManifestSha256: "relationship-hash",
            relationshipBuiltAt: relationshipManifest.builtAt,
            publicationCompletedAt: relationshipManifest.builtAt,
        },
        ...result!,
    };
    const projected = projectCallGraphEvidence(envelope);
    assert.equal(projected.evidenceSummary?.callEdgeCount, 1);
    assert.equal(projected.evidenceSummary?.resolvedExactTargetReferenceCount, 2);
    assert.equal(projected.evidenceSummary?.resolvedExactTargetReferenceOwnerCount, 1);
    assert.equal(projected.evidenceSummary?.referenceOnlyOwnerCount, 0);
    assert.equal(projected.evidenceSummary?.ownerlessResolvedExactTargetReferenceCount, 1);
    assert.equal(projected.evidenceSummary?.testReferenceCount, 1);
    assert.equal(projected.evidenceSummary?.constructGapCount, 1);

    const firstPage = projectCallGraphEvidence(envelope, {
        kind: "exact_references",
        limit: 1,
    });
    assert.equal(firstPage.evidencePage?.availableCount, 2);
    assert.match(
        firstPage.evidencePage?.kind === "exact_references"
            ? firstPage.evidencePage.items[0]?.site.file ?? ""
            : "",
        /^packages\/a\//,
    );
    const secondPage = projectCallGraphEvidence(envelope, {
        kind: "exact_references",
        limit: 1,
        cursor: firstPage.evidencePage?.nextCursor,
    });
    assert.equal(secondPage.evidencePage?.returnedCount, 1);
    assert.match(
        secondPage.evidencePage?.kind === "exact_references"
            ? secondPage.evidencePage.items[0]?.site.file ?? ""
            : "",
        /^packages\/a\//,
    );

    const rootResult = await graph.build({
        codebaseRoot: "/repo",
        publicationId: "publication-1",
        navigationRoot: "/state/publication-1/navigation",
        registry,
        registryManifestHash: "registry-hash",
        resolvedSymbol: target,
        direction: "callers",
        depth: 2,
        limit: 20,
    });
    assert.ok(rootResult);
    assert.deepEqual(rootResult!.edges.map((edge) => edge.srcSymbolId).sort(), [
        localCaller.symbolInstanceId,
        siblingCaller.symbolInstanceId,
    ].sort());
    assert.equal(rootResult!.exactReferences?.length, 4);
    assert.equal(rootResult!.testReferences?.length, 2);
});

test("call graph path scope filters textual fallback references returned by the source floor", async () => {
    const target = {
        symbolKey: "target-key",
        symbolInstanceId: "target-id",
        language: "typescript",
        kind: "function",
        qualifiedName: "target",
        name: "target",
        label: "function target()",
        span: { startLine: 1, endLine: 1 },
        parentQualifiedNamePath: [],
        file: "packages/a/src/target.ts",
        fileHash: "target-hash",
        extractorVersion: "fixture",
    } as SymbolRecord;
    const registry = buildSymbolRegistry({
        manifest: { files: [] } as never,
        symbols: [target],
    });
    const relationshipManifest = {
        schemaVersion: "relationship_v3",
        symbolRegistryManifestHash: "registry-hash",
        relationshipVersion: "fixture",
        builtAt: "2026-09-22T00:00:00.000Z",
        files: [],
    };
    const navigationStore = {
        getRelationships: async () => ({
            status: "ok",
            rootPath: "/repo",
            manifestHash: "relationship-hash",
            manifest: relationshipManifest,
            records: [],
            analysisByFile: new Map(),
            warnings: [],
        }),
        getResolutionEvidence: async () => ({
            status: "ok",
            rootPath: "/repo",
            manifestHash: "relationship-hash",
            manifest: relationshipManifest,
            matches: [],
            warnings: [],
        }),
    };
    const graph = new RelationshipBackedCallGraph({ navigationStore: navigationStore as never });
    const result = await graph.build({
        codebaseRoot: "/repo",
        publicationId: "publication-1",
        navigationRoot: "/state/publication-1/navigation",
        registry,
        registryManifestHash: "registry-hash",
        resolvedSymbol: target,
        direction: "callers",
        depth: 1,
        limit: 20,
        pathScope: { subtree: "packages/a" },
        findExactSourceReferences: async () => ({
            target: {
                symbolId: target.symbolInstanceId,
                symbolLabel: target.label,
                name: target.name,
                qualifiedName: target.qualifiedName,
                file: target.file,
                span: target.span,
            },
            references: [
                {
                    file: "packages/a/src/local.ts",
                    span: { startLine: 2, endLine: 2, startColumn: 0, endColumn: 6 },
                    occurrenceKind: "identifier",
                    matchedText: "target",
                    evidenceClass: "published_source_text",
                },
                {
                    file: "packages/b/src/sibling.ts",
                    span: { startLine: 3, endLine: 3, startColumn: 0, endColumn: 6 },
                    occurrenceKind: "identifier",
                    matchedText: "target",
                    evidenceClass: "published_source_text",
                },
            ],
            coverage: {
                status: "complete",
                publishedFileCount: 2,
                eligibleFileCount: 1,
                inspectedFileCount: 1,
                skippedFileCount: 0,
                matchedOccurrenceCount: 1,
                returnedOccurrenceCount: 1,
                reasons: [],
            },
        }),
    });

    assert.ok(result);
    assert.deepEqual(result!.sourceReferences?.map((reference) => reference.site.file), [
        "packages/a/src/local.ts",
    ]);
    assert.equal(result!.inboundCoverageEvidence?.sourceReferenceCount, 1);
});
