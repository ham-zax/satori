import assert from "node:assert/strict";
import test from "node:test";
import type { CallGraphEdge } from "./call-graph.js";
import {
    InvalidRelationshipContinuationError,
    buildRelationshipEdgeKey,
    buildRelationshipTraversalFingerprint,
    paginateRelationshipEdges,
    parseRelationshipCursor,
    serializeRelationshipCursor,
} from "./relationship-continuation.js";

function edge(index: number): CallGraphEdge {
    return {
        srcSymbolId: `caller_${index}`,
        dstSymbolId: "target",
        kind: "call",
        site: {
            file: `src/caller-${index}.ts`,
            startLine: index + 1,
        },
        confidence: 0.95,
    };
}

function fingerprint(relationship: "caller" | "callee" = "caller") {
    return buildRelationshipTraversalFingerprint({
        canonicalRoot: "/repo",
        targetSymbolInstanceId: "target",
        registryManifestIdentity: "registry-manifest",
        relationshipManifestIdentity: "relationship-manifest",
        relationship,
        depth: 1,
    });
}

test("relationship traversal fingerprints bind direction and manifests but not page size", () => {
    const callers = fingerprint("caller");
    const sameCallers = fingerprint("caller");
    const callees = fingerprint("callee");
    const changedManifest = buildRelationshipTraversalFingerprint({
        canonicalRoot: "/repo",
        targetSymbolInstanceId: "target",
        registryManifestIdentity: "registry-manifest",
        relationshipManifestIdentity: "changed-relationship-manifest",
        relationship: "caller",
        depth: 1,
    });

    assert.deepEqual(callers, sameCallers);
    assert.notEqual(callers.fingerprint, callees.fingerprint);
    assert.notEqual(callers.fingerprint, changedManifest.fingerprint);
});

test("relationship pages are deterministic, gap-free, and allow page-size changes", () => {
    const traversal = fingerprint();
    const edges = [edge(3), edge(1), edge(2), edge(0)];
    const first = paginateRelationshipEdges({
        edges,
        traversalFingerprint: traversal.fingerprint,
        pageSize: 2,
    });
    assert.equal(first.terminal, false);
    assert.ok(first.nextCursor);

    const second = paginateRelationshipEdges({
        edges,
        traversalFingerprint: traversal.fingerprint,
        pageSize: 3,
        cursor: first.nextCursor,
    });
    assert.equal(second.terminal, true);
    assert.deepEqual(
        [...first.edges, ...second.edges].map((item) => item.srcSymbolId),
        ["caller_0", "caller_1", "caller_2", "caller_3"],
    );
});

test("relationship pagination counts real duplicate edges once", () => {
    const traversal = fingerprint();
    const repeated = edge(0);
    const page = paginateRelationshipEdges({
        edges: [repeated, { ...repeated, site: { ...repeated.site } }, edge(1)],
        traversalFingerprint: traversal.fingerprint,
        pageSize: 10,
    });

    assert.equal(page.availableCount, 2);
    assert.equal(page.duplicateCount, 1);
    assert.equal(page.edges.length, 2);
});

test("relationship cursors reject malformed, cross-scope, non-canonical, and terminal input", () => {
    const callers = fingerprint("caller");
    const callees = fingerprint("callee");
    const first = paginateRelationshipEdges({
        edges: [edge(0), edge(1)],
        traversalFingerprint: callers.fingerprint,
        pageSize: 1,
    });
    assert.ok(first.nextCursor);

    assert.throws(
        () => parseRelationshipCursor(first.nextCursor as string, callees.fingerprint),
        InvalidRelationshipContinuationError,
    );
    assert.throws(
        () => parseRelationshipCursor(` ${first.nextCursor}`, callers.fingerprint),
        InvalidRelationshipContinuationError,
    );
    assert.throws(
        () => parseRelationshipCursor("not-json", callers.fingerprint),
        InvalidRelationshipContinuationError,
    );

    const lastPage = paginateRelationshipEdges({
        edges: [edge(0), edge(1)],
        traversalFingerprint: callers.fingerprint,
        pageSize: 1,
        cursor: first.nextCursor,
    });
    assert.equal(lastPage.terminal, true);
    const lastKeyCursor = serializeRelationshipCursor({
        formatVersion: 1,
        traversalFingerprint: callers.fingerprint,
        lastEdgeKey: buildRelationshipEdgeKey(edge(1)),
    });
    assert.throws(() => paginateRelationshipEdges({
        edges: [edge(0), edge(1)],
        traversalFingerprint: callers.fingerprint,
        pageSize: 1,
        cursor: lastKeyCursor,
    }), InvalidRelationshipContinuationError);
});
