import assert from "node:assert/strict";
import test from "node:test";

import {
    InvalidCallGraphEvidenceContinuationError,
    projectCallGraphEvidence,
} from "./call-graph-evidence-projection.js";
import type { CallGraphResponseEnvelope } from "./search-types.js";

function payload(publicationId = "publication-1"): CallGraphResponseEnvelope {
    const exactReferenceOwnerIds = ["caller", "reference-only-owner", undefined] as const;
    const exactReferences = Array.from({ length: 3 }, (_, index) => {
        const sourceSymbolId = exactReferenceOwnerIds[index];
        return {
            relationship: "caller" as const,
            matchKind: "resolved_target" as const,
            decision: "resolved" as const,
            resolutionAuthority: "direct_binding" as const,
            construct: "typed_member_call" as const,
            providerId: "fixture",
            providerVersion: "v1",
            ...(sourceSymbolId ? { sourceSymbolId } : {}),
            targetSymbolId: "target",
            calleeName: "request",
            calleeText: "client.request",
            site: {
                file: `tests/case-${index}.ts`,
                startLine: index + 1,
                startColumn: 0,
                endColumn: 14,
            },
            candidates: [],
        };
    });
    return {
        status: "ok",
        supported: true,
        path: "/repo",
        symbolRef: {
            file: "src/target.ts",
            symbolId: "target",
        },
        nodes: [],
        edges: [{
            srcSymbolId: "caller",
            dstSymbolId: "target",
            kind: "call",
            site: { file: "src/caller.ts", startLine: 10 },
            confidence: 0.95,
            args: ["largeExpression()", "anotherExpression()"],
        }],
        notes: [],
        exactReferences,
        sourceReferences: [{
            relationship: "caller",
            evidenceClass: "published_source_text",
            occurrenceKind: "member",
            matchedText: "client.request",
            member: "request",
            site: {
                file: "tests/source.ts",
                startLine: 20,
                endLine: 20,
                startColumn: 2,
                endColumn: 16,
            },
        }],
        testReferences: [{
            file: "tests/case.ts",
            symbolId: "test-symbol",
            span: { startLine: 1, endLine: 5 },
            site: { file: "tests/case.ts", startLine: 3 },
            targetSymbolId: "target",
            kind: "call",
            confidence: 0.95,
        }],
        constructCoverage: [{
            construct: "typed_member_call",
            status: "partial",
            observedCount: 3,
            resolvedCount: 1,
            ambiguousCount: 0,
            unresolvedCount: 2,
            unsupportedCount: 0,
            providers: [{ providerId: "fixture", providerVersion: "v1" }],
            gapCount: 2,
            gapSpans: [{
                file: "src/caller.ts",
                span: {
                    startLine: 10,
                    endLine: 10,
                    startByte: 100,
                    endByte: 110,
                    startColumn: 0,
                    endColumn: 10,
                },
                decision: "unresolved",
                resolutionAuthority: "unresolved",
                providerId: "fixture",
                providerVersion: "v1",
                calleeName: "request",
                calleeText: "client.request",
            }, {
                file: "src/caller.ts",
                span: {
                    startLine: 11,
                    endLine: 11,
                    startByte: 111,
                    endByte: 121,
                    startColumn: 0,
                    endColumn: 10,
                },
                decision: "unresolved",
                resolutionAuthority: "unresolved",
                providerId: "fixture",
                providerVersion: "v1",
                calleeName: "request",
                calleeText: "other.request",
            }],
            gapsTruncated: false,
        }],
        navigationAuthority: {
            publicationId,
            relationshipManifestSha256: "manifest",
            relationshipBuiltAt: "2026-09-22T00:00:00.000Z",
            publicationCompletedAt: "2026-09-22T00:00:00.000Z",
        },
    };
}

test("call graph defaults to summary-only evidence", () => {
    const projected = projectCallGraphEvidence(payload());

    assert.equal(projected.exactReferences, undefined);
    assert.equal(projected.sourceReferences, undefined);
    assert.equal(projected.testReferences, undefined);
    assert.equal(projected.edges[0]?.args, undefined);
    assert.deepEqual(projected.constructCoverage?.[0]?.gapSpans, []);
    assert.equal(projected.constructCoverage?.[0]?.gapsTruncated, true);
    assert.deepEqual(projected.evidenceSummary, {
        callEdgeCount: 1,
        inboundCallerOwnerCount: 1,
        exactReferenceCount: 3,
        resolvedExactTargetReferenceCount: 3,
        resolvedExactTargetReferenceWithOwnerCount: 2,
        resolvedExactTargetReferenceOwnerCount: 2,
        referenceOnlyOwnerCount: 1,
        ownerlessResolvedExactTargetReferenceCount: 1,
        ambiguousTargetReferenceCount: 0,
        unresolvedTargetReferenceCount: 0,
        sourceReferenceCount: 1,
        testReferenceCount: 1,
        constructGapCount: 2,
        edgeArgumentEdgeCount: 1,
        availableKinds: [
            "exact_references",
            "source_references",
            "test_references",
            "construct_gaps",
            "edge_arguments",
        ],
    });
});

test("call graph summary distinguishes reference-only and ownerless exact target evidence", () => {
    const input = payload();
    input.edges = [];

    const projected = projectCallGraphEvidence(input);

    assert.equal(projected.exactReferences, undefined);
    assert.equal(projected.evidenceSummary?.callEdgeCount, 0);
    assert.equal(projected.evidenceSummary?.inboundCallerOwnerCount, 0);
    assert.equal(projected.evidenceSummary?.resolvedExactTargetReferenceCount, 3);
    assert.equal(projected.evidenceSummary?.resolvedExactTargetReferenceWithOwnerCount, 2);
    assert.equal(projected.evidenceSummary?.resolvedExactTargetReferenceOwnerCount, 2);
    assert.equal(projected.evidenceSummary?.referenceOnlyOwnerCount, 2);
    assert.equal(projected.evidenceSummary?.ownerlessResolvedExactTargetReferenceCount, 1);
    assert.equal(projected.evidenceSummary?.sourceReferenceCount, 1);
});

test("call graph summary keeps ambiguous and unresolved target evidence separate from resolved references", () => {
    const input = payload();
    const resolvedReference = input.exactReferences?.[0];
    assert.ok(resolvedReference);
    input.exactReferences = [
        ...(input.exactReferences ?? []),
        {
            ...resolvedReference,
            matchKind: "candidate_target",
            decision: "ambiguous",
            resolutionAuthority: "ambiguous",
            sourceSymbolId: "ambiguous-owner",
        },
        {
            ...resolvedReference,
            matchKind: "candidate_target",
            decision: "unresolved",
            resolutionAuthority: "unresolved",
            sourceSymbolId: "unresolved-owner",
        },
    ];

    const projected = projectCallGraphEvidence(input);

    assert.equal(projected.evidenceSummary?.resolvedExactTargetReferenceCount, 3);
    assert.equal(projected.evidenceSummary?.ambiguousTargetReferenceCount, 1);
    assert.equal(projected.evidenceSummary?.unresolvedTargetReferenceCount, 1);
    assert.equal(projected.evidenceSummary?.inboundCallerOwnerCount, 1);
    assert.equal(projected.evidenceSummary?.referenceOnlyOwnerCount, 1);
});

test("call graph evidence pages continue within the same publication", () => {
    const first = projectCallGraphEvidence(payload(), {
        kind: "exact_references",
        limit: 2,
    });

    assert.equal(first.evidencePage?.kind, "exact_references");
    assert.equal(first.evidencePage?.availableCount, 3);
    assert.equal(first.evidencePage?.returnedCount, 2);
    assert.ok(first.evidencePage?.nextCursor);
    assert.equal(first.exactReferences, undefined);

    const second = projectCallGraphEvidence(payload(), {
        kind: "exact_references",
        limit: 2,
        cursor: first.evidencePage?.nextCursor,
    });
    assert.equal(second.evidencePage?.returnedCount, 1);
    assert.equal(second.evidencePage?.nextCursor, undefined);
    assert.equal(second.evidencePage?.kind, "exact_references");
    if (second.evidencePage?.kind !== "exact_references") {
        throw new Error("Expected exact-reference evidence page");
    }
    assert.equal(second.evidencePage.items[0]?.site.file, "tests/case-2.ts");

    assert.throws(
        () => projectCallGraphEvidence(payload("publication-2"), {
            kind: "exact_references",
            limit: 2,
            cursor: first.evidencePage?.nextCursor,
        }),
        InvalidCallGraphEvidenceContinuationError,
    );
    assert.throws(
        () => projectCallGraphEvidence({
            ...payload(),
            direction: "callers",
        }, {
            kind: "exact_references",
            limit: 2,
            cursor: first.evidencePage?.nextCursor,
        }),
        InvalidCallGraphEvidenceContinuationError,
    );
});

test("call graph evidence continuations are bound to the requested path scope", () => {
    const scoped = {
        ...payload(),
        path: "/repo/packages/a",
        codebaseRoot: "/repo",
    };
    const first = projectCallGraphEvidence(scoped, {
        kind: "exact_references",
        limit: 1,
    });
    const cursor = first.evidencePage?.nextCursor;
    assert.ok(cursor);

    assert.throws(
        () => projectCallGraphEvidence({
            ...scoped,
            path: "/repo/packages/b",
        }, {
            kind: "exact_references",
            limit: 1,
            cursor,
        }),
        InvalidCallGraphEvidenceContinuationError,
    );
    assert.throws(
        () => projectCallGraphEvidence({
            ...scoped,
            path: "/repo",
        }, {
            kind: "exact_references",
            limit: 1,
            cursor,
        }),
        InvalidCallGraphEvidenceContinuationError,
    );

    const next = projectCallGraphEvidence(scoped, {
        kind: "exact_references",
        limit: 1,
        cursor,
    });
    assert.equal(next.evidencePage?.returnedCount, 1);
});

test("call graph pages construct gaps and edge arguments without duplicating them in the summary", () => {
    const gaps = projectCallGraphEvidence(payload(), {
        kind: "construct_gaps",
        limit: 1,
    });
    assert.equal(gaps.evidencePage?.kind, "construct_gaps");
    assert.equal(gaps.evidencePage?.availableCount, 2);
    assert.equal(gaps.evidencePage?.returnedCount, 1);
    assert.deepEqual(gaps.constructCoverage?.[0]?.gapSpans, []);

    const args = projectCallGraphEvidence(payload(), {
        kind: "edge_arguments",
        limit: 10,
    });
    assert.equal(args.evidencePage?.kind, "edge_arguments");
    assert.equal(args.evidencePage?.returnedCount, 1);
    assert.deepEqual(args.evidencePage?.items[0], {
        srcSymbolId: "caller",
        dstSymbolId: "target",
        site: { file: "src/caller.ts", startLine: 10 },
        args: ["largeExpression()", "anotherExpression()"],
    });
    assert.equal(args.edges[0]?.args, undefined);
});
