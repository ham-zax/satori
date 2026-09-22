import test from "node:test";
import assert from "node:assert/strict";
import {
    isTestOrFixturePath,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import {
    RelationshipBackedCallGraph,
    prioritizeInboundSuppressedNotes,
    shouldInspectInboundSourceReferences,
    uniqueInboundCallerSiteFile,
} from "./relationship-backed-call-graph.js";
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
