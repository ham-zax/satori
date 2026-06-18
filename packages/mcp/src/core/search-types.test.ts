import test from "node:test";
import assert from "node:assert/strict";
import type {
    CallGraphHint,
    CallGraphResponseEnvelope,
    ReadFileAnnotatedResponseEnvelope,
    ReadFileOpenSymbolResponseEnvelope,
} from "./search-types.js";

test("navigation response contracts include call_graph invalid symbol refs", () => {
    const payload: CallGraphResponseEnvelope = {
        supported: false,
        reason: "invalid_symbol_ref",
        hints: {
            message: "symbolRef with { file, symbolId } is required."
        }
    };

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

// @ts-expect-error missing_sidecar is a legacy CallGraphSidecarManager reason, not a current public CallGraphHint reason.
const legacyMissingSidecarHint: CallGraphHint = { supported: false, reason: "missing_sidecar" };
void legacyMissingSidecarHint;

test("navigation response contracts include read_file open_symbol failures", () => {
    const payload: ReadFileOpenSymbolResponseEnvelope = {
        status: "requires_reindex",
        message: "Cannot resolve codebase root for open_symbol.",
        hints: {
            nextSteps: [
                { tool: "list_codebases", args: {} }
            ]
        }
    };

    assert.equal(payload.status, "requires_reindex");
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
