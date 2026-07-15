import test from "node:test";
import assert from "node:assert/strict";
import type { CallGraphEdge, CallGraphNote } from "./call-graph.js";
import { projectRelationshipEvidence } from "./relationship-evidence.js";

test("relationship evidence preserves graph order and marks static confidence as uncalibrated", () => {
    const edges: CallGraphEdge[] = [{
        srcSymbolId: "caller-b",
        dstSymbolId: "target",
        kind: "call",
        site: { file: "src/b.ts", startLine: 8 },
        confidence: 0.65,
    }, {
        srcSymbolId: "caller-a",
        dstSymbolId: "target",
        kind: "call",
        site: { file: "src/a.ts", startLine: 3, endLine: 4 },
        confidence: 0.95,
    }];

    const projection = projectRelationshipEvidence({
        status: "ok",
        relationship: "caller",
        edges,
        truncated: false,
        availableCount: 2,
        suppressedCount: 0,
        siteStatusByFile: new Map([["src/a.ts", "current_source_validated"]]),
    });

    assert.equal(projection.status, "ok");
    assert.equal(projection.terminal, true);
    assert.equal(projection.projectionPolicyVersion, "relationship_evidence_v1");
    assert.equal(projection.confidencePolicyVersion, "call_graph_score_bands_v1");
    assert.equal(projection.completeness, "bounded_static");
    assert.deepEqual(projection.items.map((item) => item.symbolId), ["caller-b", "caller-a"]);
    assert.deepEqual(projection.items[0], {
        symbolId: "caller-b",
        relationship: "caller",
        source: "relationship_graph",
        confidenceClass: "medium",
        confidenceBasis: "stored_static_relationship",
        rawConfidenceScore: 0.65,
        calibrated: false,
        sites: {
            status: "not_current_source_validated",
            items: [{ file: "src/b.ts", startLine: 8 }],
        },
    });
    assert.equal(projection.items[1]?.confidenceClass, "high");
    assert.equal(projection.items[1]?.sites.status, "current_source_validated");
    assert.deepEqual(projection.limitations, ["dynamic_relationships_unknown"]);
    assert.equal(projection.emptyReason, undefined);
    assert.deepEqual(edges[0]?.site, { file: "src/b.ts", startLine: 8 });
});

test("relationship evidence keeps dynamic fallback provenance and suppresses failed source observations", () => {
    const projection = projectRelationshipEvidence({
        status: "degraded",
        relationship: "callee",
        edges: [{
            srcSymbolId: "target",
            dstSymbolId: "validated-callee",
            kind: "dynamic",
            site: { file: "src/current.py", startLine: 11 },
            confidence: 0.65,
        }, {
            srcSymbolId: "target",
            dstSymbolId: "stale-callee",
            kind: "dynamic",
            site: { file: "src/stale.py", startLine: 17 },
            confidence: 0.65,
        }],
        truncated: false,
        suppressedCount: 0,
        siteStatusByFile: new Map([["src/current.py", "current_source_validated"]]),
        failedDynamicSourceFiles: new Set(["src/stale.py"]),
    });

    assert.equal(projection.status, "degraded");
    assert.equal(projection.returnedCount, 1);
    assert.equal(projection.suppressedCount, 1);
    assert.deepEqual(projection.items[0], {
        symbolId: "validated-callee",
        relationship: "callee",
        source: "source_backed_dynamic",
        confidenceClass: "medium",
        confidenceBasis: "source_backed_dynamic_relationship",
        rawConfidenceScore: 0.65,
        calibrated: false,
        sites: {
            status: "current_source_validated",
            items: [{ file: "src/current.py", startLine: 11 }],
        },
    });
    assert.deepEqual(projection.limitations, [
        "dynamic_relationships_unknown",
        "dynamic_source_observation_failed",
    ]);
});

test("relationship evidence does not mislabel truncated output as an empty traversal", () => {
    const suppressionNotes: CallGraphNote[] = [{
        type: "suppressed_edge",
        file: "src/caller.ts",
        startLine: 20,
        confidence: 0.35,
        detail: "Suppressed low-confidence caller candidate.",
    }];

    const projection = projectRelationshipEvidence({
        status: "ok",
        relationship: "caller",
        edges: [],
        truncated: true,
        suppressedCount: 3,
        suppressionNotes,
    });

    assert.equal(projection.status, "ok");
    assert.equal(projection.emptyReason, undefined);
    assert.equal(projection.truncated, true);
    assert.equal(projection.terminal, false);
    assert.equal(projection.suppressedCount, 3);
    assert.deepEqual(projection.limitations, [
        "dynamic_relationships_unknown",
        "low_confidence_relationships_suppressed",
        "relationship_limit_reached",
    ]);
    assert.deepEqual(projection.suppressionNotes, suppressionNotes);
    assert.notEqual(projection.suppressionNotes, suppressionNotes);
});

test("relationship evidence keeps unavailable, ambiguous, and unsupported outcomes explicit", () => {
    assert.deepEqual(projectRelationshipEvidence({
        status: "unavailable",
        relationship: "caller",
        reason: "missing_relationship_sidecar",
    }), {
        status: "unavailable",
        projectionPolicyVersion: "relationship_evidence_v1",
        confidencePolicyVersion: "call_graph_score_bands_v1",
        relationship: "caller",
        reason: "missing_relationship_sidecar",
        items: [],
        returnedCount: 0,
        truncated: false,
        suppressedCount: 0,
        suppressionNotes: [],
        limitations: [],
    });
    assert.equal(projectRelationshipEvidence({
        status: "ambiguous",
        relationship: "callee",
        reason: "ambiguous_symbol",
    }).status, "ambiguous");
    assert.deepEqual(projectRelationshipEvidence({
        status: "unsupported",
        relationship: "callee",
        reason: "unsupported_relationship_kind",
        unsupportedRelationshipKind: "implementation",
    }), {
        status: "unsupported",
        projectionPolicyVersion: "relationship_evidence_v1",
        confidencePolicyVersion: "call_graph_score_bands_v1",
        relationship: "callee",
        reason: "unsupported_relationship_kind",
        unsupportedRelationshipKind: "implementation",
        items: [],
        returnedCount: 0,
        truncated: false,
        suppressedCount: 0,
        suppressionNotes: [],
        limitations: [],
    });
});

test("relationship evidence rejects inconsistent counts", () => {
    assert.throws(() => projectRelationshipEvidence({
        status: "ok",
        relationship: "caller",
        edges: [{
            srcSymbolId: "caller",
            dstSymbolId: "target",
            kind: "call",
            site: { file: "src/caller.ts", startLine: 1 },
            confidence: 0.95,
        }],
        truncated: false,
        availableCount: 0,
        suppressedCount: 0,
    }), /availableCount/);
    assert.throws(() => projectRelationshipEvidence({
        status: "ok",
        relationship: "caller",
        edges: [],
        truncated: false,
        suppressedCount: -1,
    }), /suppressedCount/);
    assert.throws(() => projectRelationshipEvidence({
        status: "ok",
        relationship: "callee",
        edges: [{
            srcSymbolId: "target",
            dstSymbolId: "callee",
            kind: "call",
            site: { file: "src/callee.ts", startLine: 1 },
            confidence: Number.NaN,
        }],
        truncated: false,
        suppressedCount: 0,
    }), /confidence score/);
});
