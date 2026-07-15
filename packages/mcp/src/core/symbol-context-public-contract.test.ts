import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
    SYMBOL_CONTEXT_LIMITS,
    composePublicSymbolContextEnvelope,
    exactSymbolOpenRequestSchema,
    openSymbolRequestSchema,
    resolveSymbolContextOperation,
} from "./symbol-context-public-contract.js";
import type { ComposedSymbolContext } from "./symbol-context-composer.js";

const phase0Contract = JSON.parse(fs.readFileSync(new URL(
    "../../../../evals/agent-discovery/bounded-symbol-context-phase-0.json",
    import.meta.url,
), "utf8"));

test("public symbol-context limits remain identical to the frozen Phase 0 vectors", () => {
    assert.deepEqual(SYMBOL_CONTEXT_LIMITS, {
        defaultSourceBytes: phase0Contract.limits.defaultSourceBytes,
        maxSourceBytes: phase0Contract.limits.maxSourceBytes,
        defaultSourceLines: phase0Contract.limits.defaultSourceLines,
        maxSourceLines: phase0Contract.limits.maxSourceLines,
        defaultExcerpts: phase0Contract.limits.defaultExcerpts,
        maxExcerpts: phase0Contract.limits.maxExcerpts,
        maxExcerptBytes: phase0Contract.limits.maxExcerptBytes,
        defaultSiblings: phase0Contract.limits.defaultSiblings,
        maxSiblings: phase0Contract.limits.maxSiblings,
        defaultEdgesPerDirection: phase0Contract.limits.defaultEdgesPerDirection,
        maxEdgesPerDirection: phase0Contract.limits.maxEdgesPerDirection,
        defaultTotalResponseBytes: phase0Contract.limits.defaultTotalResponseBytes,
        hardResponseLimitBytes: phase0Contract.limits.hardResponseLimitBytes,
        maxInspectableSourceBytes: phase0Contract.limits.maxInspectableSourceBytes,
        emergencyErrorLimitBytes: phase0Contract.limits.emergencyErrorLimitBytes,
        acceptedErrorLimitBytes: phase0Contract.limits.v2ErrorLimitBytes,
    });
});

test("exact and direct-span schemas implement every frozen discrimination vector", () => {
    for (const fixture of phase0Contract.wireContract.schemaCases) {
        const parsed = openSymbolRequestSchema.safeParse(fixture.openSymbol);
        assert.equal(parsed.success, fixture.acceptedVariant !== null, fixture.id);
        if (fixture.acceptedVariant === "exact_symbol_v2") {
            assert.equal(exactSymbolOpenRequestSchema.safeParse(fixture.openSymbol).success, true, fixture.id);
        }
    }
});

test("exact request strings are trimmed and blank identity or continuation values are rejected", () => {
    const trimmed = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "  sym_target  ",
        continuation: {
            kind: "caller_page",
            fingerprint: "  sha256_callers_fixture  ",
            cursor: "  canonical-cursor  ",
        },
    });
    assert.equal(trimmed.symbolId, "sym_target");
    assert.equal(trimmed.continuation?.kind, "caller_page");
    if (trimmed.continuation?.kind !== "caller_page") return;
    assert.equal(trimmed.continuation.fingerprint, "sha256_callers_fixture");
    assert.equal(trimmed.continuation.cursor, "canonical-cursor");

    const invalidRequests = [
        {
            contractVersion: 2,
            symbolId: " ",
            context: { preset: "definition" },
        },
        {
            contractVersion: 2,
            symbolId: "sym_target",
            continuation: {
                kind: "source_range",
                fingerprint: " ",
                startLine: 1,
                endLine: 1,
            },
        },
        {
            contractVersion: 2,
            symbolId: "sym_target",
            continuation: {
                kind: "caller_page",
                fingerprint: "sha256_callers_fixture",
                cursor: " ",
            },
        },
        {
            contractVersion: 2,
            symbolId: "sym_target",
            context: {
                preset: "definition",
                budgets: { totalResponseBytes: 1 },
            },
        },
    ];
    for (const request of invalidRequests) {
        assert.equal(exactSymbolOpenRequestSchema.safeParse(request).success, false);
    }
});

test("preset resolution applies explicit overrides and clamps every public budget", () => {
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        context: {
            preset: "call_context",
            query: "where is the transaction committed",
            include: {
                source: false,
                lexicalContext: true,
                callers: false,
            },
            budgets: {
                sourceBytes: 99_999,
                sourceLines: 99_999,
                excerpts: 99,
                siblings: 99,
                edgesPerDirection: 99,
                totalResponseBytes: 99_999,
            },
        },
    });
    const resolved = resolveSymbolContextOperation({ mode: "annotated", request });
    assert.equal(resolved.kind, "context");
    if (resolved.kind !== "context") return;
    assert.deepEqual(resolved.effectiveRequest.include, {
        source: false,
        siblings: true,
        callers: false,
        callees: true,
        lexicalContext: true,
    });
    assert.deepEqual(resolved.effectiveRequest.budgets, {
        sourceBytes: 16_384,
        sourceLines: 250,
        excerpts: 6,
        siblings: 20,
        edgesPerDirection: 20,
        totalResponseBytes: 32_768,
    });
    assert.equal(resolved.query, "where is the transaction committed");
    assert.ok(resolved.budgets.maxSerializedResponseBytes < 32_768);
});

test("continuation resolution scopes evidence and does not echo its fingerprint or cursor", () => {
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        continuation: {
            kind: "caller_page",
            fingerprint: "sha256_callers_fixture",
            cursor: "canonical-cursor",
            pageSize: 999,
        },
    });
    const resolved = resolveSymbolContextOperation({ mode: "plain", request });
    assert.equal(resolved.kind, "continuation");
    if (resolved.kind !== "continuation") return;
    assert.deepEqual(resolved.include, {
        source: false,
        siblings: false,
        callers: true,
        callees: false,
    });
    assert.equal(resolved.continuation.kind, "caller_page");
    if (resolved.continuation.kind !== "caller_page") return;
    assert.equal(resolved.continuation.pageSize, 20);
    assert.deepEqual(resolved.effectiveRequest.continuation, { kind: "caller_page" });
    assert.equal(JSON.stringify(resolved.effectiveRequest).includes("sha256_callers_fixture"), false);
    assert.equal(JSON.stringify(resolved.effectiveRequest).includes("canonical-cursor"), false);
});

test("public envelope reserves its prefix inside the caller-clamped total response budget", () => {
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        context: { preset: "definition" },
    });
    const resolved = resolveSymbolContextOperation({ mode: "plain", request });
    assert.equal(resolved.kind, "context");
    if (resolved.kind !== "context") return;
    const context = {
        status: "ok",
        symbol: { symbolId: "sym_target" },
        source: { status: "not_requested" },
    };
    const envelope = composePublicSymbolContextEnvelope({
        effectiveRequest: resolved.effectiveRequest,
        context: context as unknown as ComposedSymbolContext,
    });
    const prefixBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8")
        - Buffer.byteLength(JSON.stringify(context), "utf8");
    assert.equal(
        resolved.budgets.maxSerializedResponseBytes + prefixBytes,
        resolved.effectiveRequest.budgets.totalResponseBytes,
    );
});

test("public envelope projects only frozen fields and cannot be overwritten by internal keys", () => {
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        context: { preset: "definition" },
    });
    const resolved = resolveSymbolContextOperation({ mode: "plain", request });
    assert.equal(resolved.kind, "context");
    if (resolved.kind !== "context") return;

    const envelope = composePublicSymbolContextEnvelope({
        effectiveRequest: resolved.effectiveRequest,
        context: {
            status: "ok",
            symbol: { symbolId: "sym_target" },
            outline: { siblings: { items: [], returnedCount: 0, availableCount: 0, truncated: false } },
            source: { status: "not_requested" },
            relationships: {
                callers: { status: "not_requested", relationship: "caller" },
                callees: { status: "not_requested", relationship: "callee" },
            },
            authority: {
                vector: "not_required",
                navigation: "remote_generation_proven",
                source: { freshness: "not_requested", spanResolution: "not_requested" },
                relationships: "not_requested",
            },
            continuations: [],
            limitations: [],
            formatVersion: 999,
            kind: "internal_kind",
            effectiveRequest: { callerControlled: true },
            internalOnly: "must_not_escape",
        } as unknown as ComposedSymbolContext,
    });

    assert.equal(envelope.formatVersion, 2);
    assert.equal(envelope.kind, "symbol_context");
    assert.equal(envelope.effectiveRequest, resolved.effectiveRequest);
    assert.equal(Object.hasOwn(envelope, "internalOnly"), false);
});
