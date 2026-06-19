import test from "node:test";
import assert from "node:assert/strict";
import type {
    CallGraphHint,
    CallGraphResponseEnvelope,
    NavigationUnavailableReason,
    ReadFileAnnotatedResponseEnvelope,
    ReadFileOpenSymbolResponseEnvelope,
} from "./search-types.js";

test("navigation response contracts include call_graph invalid symbol refs", () => {
    const payload: CallGraphResponseEnvelope = {
        status: "not_found",
        supported: false,
        reason: "invalid_symbol_ref",
        path: "/repo",
        symbolRef: { file: "", symbolId: "" },
        nodes: [],
        edges: [],
        notes: [],
        message: "symbolRef with { file, symbolId } is required."
    };

    assert.equal(payload.status, "not_found");
    assert.equal(payload.supported, false);
    assert.equal(payload.reason, "invalid_symbol_ref");
});

test("navigation response contracts expose precise current callGraphHint sidecar reasons", () => {
    const missingRelationshipHint: CallGraphHint = {
        supported: false,
        reason: "missing_relationship_sidecar"
    };
    const incompatibleRelationshipHint: CallGraphHint = {
        supported: false,
        reason: "incompatible_relationship_sidecar"
    };

    assert.equal(missingRelationshipHint.reason, "missing_relationship_sidecar");
    assert.equal(incompatibleRelationshipHint.reason, "incompatible_relationship_sidecar");
});

test("navigation response contracts centralize public unavailable reasons", () => {
    const reasons: NavigationUnavailableReason[] = [
        "missing_symbol",
        "stale_symbol_ref",
        "unsupported_language",
        "missing_symbol_registry",
        "missing_relationship_sidecar",
        "incompatible_symbol_registry",
        "incompatible_relationship_sidecar"
    ];

    assert.deepEqual(reasons.sort(), [
        "incompatible_relationship_sidecar",
        "incompatible_symbol_registry",
        "missing_relationship_sidecar",
        "missing_symbol",
        "missing_symbol_registry",
        "stale_symbol_ref",
        "unsupported_language"
    ]);
});

test("navigation response contracts include call_graph non-ok envelopes", () => {
    const payloads: CallGraphResponseEnvelope[] = [
        {
            status: "unsupported",
            supported: false,
            reason: "unsupported_language",
            path: "/repo",
            symbolRef: { file: "main.go", symbolId: "syminst_go" },
            nodes: [],
            edges: [],
            notes: []
        },
        {
            status: "not_found",
            supported: false,
            reason: "stale_symbol_ref",
            path: "/repo",
            symbolRef: { file: "src/runtime.ts", symbolId: "syminst_old" },
            nodes: [],
            edges: [],
            notes: []
        },
        {
            status: "requires_reindex",
            supported: false,
            reason: "missing_relationship_sidecar",
            path: "/repo",
            symbolRef: { file: "src/runtime.ts", symbolId: "syminst_runtime" },
            nodes: [],
            edges: [],
            notes: [],
            message: "Relationship sidecar is missing.",
            hints: {
                reindex: { tool: "manage_index", args: { action: "reindex", path: "/repo" } }
            }
        },
        {
            status: "not_ready",
            supported: false,
            reason: "indexing",
            path: "/repo",
            symbolRef: { file: "src/runtime.ts", symbolId: "syminst_runtime" },
            nodes: [],
            edges: [],
            notes: []
        },
        {
            status: "not_indexed",
            supported: false,
            reason: "not_indexed",
            path: "/repo",
            symbolRef: { file: "src/runtime.ts", symbolId: "syminst_runtime" },
            nodes: [],
            edges: [],
            notes: []
        }
    ];

    assert.deepEqual(payloads.map((payload) => payload.status), [
        "unsupported",
        "not_found",
        "requires_reindex",
        "not_ready",
        "not_indexed"
    ]);
});

test("navigation response contracts include structured suppressed call_graph edge notes", () => {
    const payload: CallGraphResponseEnvelope = {
        status: "ok",
        supported: true,
        path: "/repo",
        symbolRef: { file: "src/phases.py", symbolId: "syminst_build" },
        direction: "callers",
        depth: 1,
        limit: 20,
        nodes: [],
        edges: [],
        notes: [{
            type: "suppressed_edge",
            file: "src/phases.py",
            startLine: 66,
            symbolId: "syminst_attach",
            symbolLabel: "function _attach_entry_telemetry(",
            confidence: 0.35,
            detail: "Suppressed low-confidence caller candidate from function _attach_entry_telemetry(",
        }],
        notesTruncated: false,
        totalNoteCount: 1,
        returnedNoteCount: 1,
        sidecar: {
            builtAt: "2026-01-01T00:00:00.000Z",
            nodeCount: 0,
            edgeCount: 0,
        }
    };

    assert.equal(payload.notes[0]?.type, "suppressed_edge");
    assert.equal(payload.notes[0]?.symbolId, "syminst_attach");
});

// @ts-expect-error missing_sidecar is a legacy CallGraphSidecarManager reason, not a current public CallGraphHint reason.
const legacyMissingSidecarHint: CallGraphHint = { supported: false, reason: "missing_sidecar" };
void legacyMissingSidecarHint;

test("navigation response contracts include read_file open_symbol failures", () => {
    const payload: ReadFileOpenSymbolResponseEnvelope = {
        status: "requires_reindex",
        reason: "stale_symbol_ref",
        message: "Cannot resolve codebase root for open_symbol.",
        hints: {
            nextSteps: [
                { tool: "list_codebases", args: {} }
            ]
        }
    };

    assert.equal(payload.status, "requires_reindex");
    assert.equal(payload.reason, "stale_symbol_ref");
    assert.equal(Array.isArray(payload.hints?.nextSteps), true);
});

test("navigation response contracts include read_file annotated envelopes", () => {
    const payload: ReadFileAnnotatedResponseEnvelope = {
        path: "/repo/src/runtime.ts",
        mode: "annotated",
        content: "export const value = true;",
        outlineStatus: "requires_reindex",
        outline: null,
        hasMore: false,
        hints: {
            nextSteps: [
                { tool: "manage_index", args: { action: "reindex", path: "/repo" } }
            ]
        }
    };

    assert.equal(payload.mode, "annotated");
    assert.equal(payload.outlineStatus, "requires_reindex");
});
