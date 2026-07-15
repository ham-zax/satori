import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import type { CallGraphEdge } from "./call-graph.js";
import type { CurrentSourceSymbolValidation } from "./current-source-symbols.js";
import type {
    InspectableSourceFinalizationResult,
    PrepareInspectableSourceResult,
} from "./inspectable-source.js";
import {
    composeSymbolContext,
    type ComposeSymbolContextInput,
    type PreparedRelationshipSnapshot,
    type PreparedSymbolContextSnapshot,
    type SymbolContextComposerDependencies,
} from "./symbol-context-composer.js";

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function symbol(input: Partial<SymbolRecord> & Pick<SymbolRecord, "symbolInstanceId" | "name" | "label" | "span">): SymbolRecord {
    return {
        symbolKey: `key:${input.name}`,
        language: "typescript",
        kind: "function",
        qualifiedName: input.name,
        file: "src/example.ts",
        parentQualifiedNamePath: [],
        fileHash: "0".repeat(64),
        extractorVersion: "typescript-extractor-fixture",
        ...input,
    };
}

function registry(symbols: SymbolRecord[]): SymbolRegistry {
    const symbolsByInstanceId = new Map(symbols.map((entry) => [entry.symbolInstanceId, entry]));
    const symbolsByKey = new Map<string, SymbolRecord[]>();
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    const symbolsByLabel = new Map<string, SymbolRecord[]>();
    const symbolsByQualifiedName = new Map<string, SymbolRecord[]>();
    for (const entry of symbols) {
        for (const [map, key] of [
            [symbolsByKey, entry.symbolKey],
            [symbolsByFile, entry.file],
            [symbolsByLabel, entry.label],
            [symbolsByQualifiedName, entry.qualifiedName],
        ] as const) {
            map.set(key, [...(map.get(key) || []), entry]);
        }
    }
    return {
        manifest: {
            schemaVersion: "symbol_registry_v1",
            normalizedRootPath: "/repo",
            rootFingerprint: "root",
            indexPolicyHash: "policy",
            languageRouterVersion: "router",
            extractorVersion: "extractor",
            relationshipVersion: "relationships",
            builtAt: "2026-07-15T00:00:00.000Z",
            files: [],
        },
        symbols,
        symbolsByInstanceId,
        symbolsByKey,
        symbolsByFile,
        symbolsByLabel,
        symbolsByQualifiedName,
        warnings: [],
    };
}

function caller(index: number): CallGraphEdge {
    return {
        srcSymbolId: `caller-${index}`,
        dstSymbolId: "target",
        kind: "call",
        site: { file: `src/caller-${index}.ts`, startLine: 10 + index },
        confidence: 0.95,
    };
}

function callee(index: number): CallGraphEdge {
    return {
        srcSymbolId: "target",
        dstSymbolId: `callee-${index}`,
        kind: "call",
        site: { file: "src/example.ts", startLine: 3 + index },
        confidence: 0.9,
    };
}

function preparedDirection(edges: CallGraphEdge[]): Extract<PreparedRelationshipSnapshot, {
    status: "available";
}>["callers"] {
    return {
        edges,
        availableCount: edges.length,
        suppressedCount: 0,
        suppressionNotes: [],
    };
}

function defaultBudgets(): ComposeSymbolContextInput["budgets"] {
    return {
        source: {
            maxSourceBytes: 8_000,
            maxSourceLines: 200,
            maxExcerpts: 5,
            maxExcerptBytes: 2_000,
            maxExcerptLines: 40,
            contextLines: 1,
            maxSerializedSourceBytes: 12_000,
        },
        maxInspectableBytes: 64_000,
        maxSiblings: 10,
        maxEdgesPerDirection: 2,
        maxSerializedResponseBytes: 30_000,
    };
}

function sourceResult(
    source: string,
    finalObservation?: () => Promise<InspectableSourceFinalizationResult>,
): PrepareInspectableSourceResult {
    const sourceBytes = Buffer.from(source, "utf8");
    return {
        status: "available",
        evidence: {
            canonicalRoot: "/repo",
            relativeFile: "src/example.ts",
            sourceBytes,
            source,
            sourceByteLength: sourceBytes.length,
            observedHash: sha256(sourceBytes),
            identity: {
                platform: "linux",
                stableIdentity: "fixture-identity",
                canonicalRelativePath: "src/example.ts",
                strength: "target_only",
            },
            selectionCapabilities: {
                localLexical: "available",
                lineWindows: "available",
                syntaxBoundaries: "unavailable_streaming_source",
                controlFlowAnchors: "unavailable_streaming_source",
            },
        },
        finalizer: {
            finalize: async (input = {}) => {
                await input.validatePreparedAuthority?.();
                return finalObservation ? finalObservation() : {
                    status: "available",
                    freshness: "current_at_final_observation",
                };
            },
            release: async () => undefined,
        },
    };
}

function matchedCurrentValidation(
    entry: SymbolRecord,
    span: SymbolRecord["span"],
): CurrentSourceSymbolValidation {
    return {
        symbol: { ...entry, span },
        attempted: true,
        validated: true,
        repaired: true,
        startBeforeDefinition: false,
        endTruncated: false,
        match: "matched",
        resolutionEvidence: {
            resolutionDerivation: "exact_registry_rebuild_match",
            currentSpanIdentity: {
                kind: "resolved_symbol_instance",
                symbolInstanceId: entry.symbolInstanceId,
            },
            spanResolutionPolicyVersion: "current_source_span_resolution_v1",
            extractorLanguageImplementationVersion: entry.extractorVersion,
        },
    };
}

function missingCurrentValidation(entry: SymbolRecord): CurrentSourceSymbolValidation {
    return {
        symbol: entry,
        attempted: true,
        validated: false,
        repaired: false,
        startBeforeDefinition: false,
        endTruncated: false,
        match: "missing",
    };
}

function dependencies(input: {
    source: string;
    symbols: SymbolRecord[];
    relationships?: PreparedRelationshipSnapshot;
    validateAuthority?: () => Promise<boolean>;
    onPrepare?: () => void;
    onValidate?: () => void;
    finalSourceObservation?: () => Promise<InspectableSourceFinalizationResult>;
}): SymbolContextComposerDependencies {
    const preparedSource = sourceResult(input.source, input.finalSourceObservation);
    return {
        prepareSnapshot: async (): Promise<{ status: "ready"; snapshot: PreparedSymbolContextSnapshot }> => {
            input.onPrepare?.();
            return {
                status: "ready",
                snapshot: {
                    canonicalRoot: "/repo",
                    registryManifestIdentity: "registry-manifest",
                    registry: registry(input.symbols),
                    navigationAuthority: "remote_generation_proven",
                    relationships: input.relationships || {
                        status: "available",
                        authority: "remote_generation_proven",
                        manifestIdentity: "relationship-manifest",
                        callers: preparedDirection([caller(2), caller(0), caller(1)]),
                        callees: preparedDirection([callee(2), callee(0), callee(1)]),
                    },
                    validateAuthority: async () => {
                        input.onValidate?.();
                        return input.validateAuthority ? input.validateAuthority() : true;
                    },
                },
            };
        },
        prepareSource: async () => preparedSource,
    };
}

function fixture(source: string): { symbols: SymbolRecord[]; target: SymbolRecord } {
    const sourceHash = sha256(Buffer.from(source, "utf8"));
    const parent = symbol({
        symbolInstanceId: "parent",
        name: "Parent",
        label: "class Parent",
        kind: "class",
        span: { startLine: 1, endLine: Math.max(4, source.split("\n").length) },
        symbolKey: "key:Parent",
        qualifiedName: "Parent",
        fileHash: sourceHash,
    });
    const target = symbol({
        symbolInstanceId: "target",
        name: "target",
        label: "function target()",
        span: { startLine: 2, endLine: Math.min(4, source.split("\n").length) },
        symbolKey: "key:target",
        qualifiedName: "Parent.target",
        parentKey: parent.symbolKey,
        parentQualifiedNamePath: ["Parent"],
        fileHash: sourceHash,
    });
    const sibling = symbol({
        symbolInstanceId: "sibling",
        name: "sibling",
        label: "function sibling()",
        span: { startLine: 5, endLine: 5 },
        symbolKey: "key:sibling",
        qualifiedName: "Parent.sibling",
        parentKey: parent.symbolKey,
        parentQualifiedNamePath: ["Parent"],
        fileHash: sourceHash,
    });
    return { symbols: [parent, target, sibling], target };
}

function request(overrides: Partial<ComposeSymbolContextInput> = {}): ComposeSymbolContextInput {
    return {
        codebaseRoot: "/repo",
        relativeFile: "src/example.ts",
        symbolId: "target",
        include: {
            source: true,
            siblings: true,
            callers: true,
            callees: true,
        },
        budgets: defaultBudgets(),
        ...overrides,
    };
}

test("composer uses one prepared snapshot and returns independent bounded domains", async () => {
    const source = [
        "class Parent {",
        "  target() {",
        "    return run();",
        "  }",
        "  sibling() {}",
        "}",
    ].join("\n");
    const data = fixture(source);
    let prepareCount = 0;
    let validationCount = 0;
    const result = await composeSymbolContext(
        request(),
        dependencies({
            source,
            symbols: data.symbols,
            onPrepare: () => { prepareCount += 1; },
            onValidate: () => { validationCount += 1; },
        }),
    );

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(prepareCount, 1);
    assert.equal(validationCount, 1);
    assert.equal(result.context.symbol.parentSymbolId, "parent");
    assert.equal(result.context.outline.siblings.items[0]?.symbolId, "sibling");
    assert.equal(result.context.source.status, "available");
    assert.equal(result.context.authority.source.spanResolution, "index_snapshot_matched");
    assert.equal(result.context.relationships.callers.status, "ok");
    assert.equal(result.context.relationships.callees.status, "ok");
    const callerHandle = result.context.continuations.find((entry) => entry.kind === "caller_page");
    const calleeHandle = result.context.continuations.find((entry) => entry.kind === "callee_page");
    assert.ok(callerHandle);
    assert.ok(calleeHandle);
    assert.notEqual(callerHandle.fingerprint, calleeHandle.fingerprint);
    assert.equal(Object.isFrozen(result.context), true);
});

test("bounded source and traversal fingerprints are deterministic and domain scoped", async () => {
    const source = Array.from({ length: 80 }, (_, index) => (
        index === 55 ? "  return importantCommit();" : `  const value${index} = ${index};`
    )).join("\n");
    const data = fixture(source);
    data.target.span = { startLine: 2, endLine: 78 };
    const sourceHash = sha256(Buffer.from(source, "utf8"));
    data.target.fileHash = sourceHash;
    const budgets = defaultBudgets();
    budgets.source = {
        ...budgets.source,
        maxSourceBytes: 350,
        maxSourceLines: 12,
        maxExcerptBytes: 300,
        maxExcerptLines: 8,
        maxSerializedSourceBytes: 4_000,
    };
    const first = await composeSymbolContext(
        request({ budgets, query: "important commit" }),
        dependencies({ source, symbols: data.symbols }),
    );
    const second = await composeSymbolContext(
        request({ budgets, query: "important commit" }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.equal(first.status, "ok");
    assert.equal(second.status, "ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    assert.equal(JSON.stringify(first.context), JSON.stringify(second.context));
    const sourceHandle = first.context.continuations.find((entry) => entry.kind === "source_range");
    const callerHandle = first.context.continuations.find((entry) => entry.kind === "caller_page");
    assert.ok(sourceHandle);
    assert.ok(callerHandle);

    const changedRelationships = await composeSymbolContext(
        request({ budgets, query: "important commit" }),
        dependencies({
            source,
            symbols: data.symbols,
            relationships: {
                status: "available",
                authority: "remote_generation_proven",
                manifestIdentity: "changed-relationship-manifest",
                callers: preparedDirection([caller(0), caller(1), caller(2)]),
                callees: preparedDirection([callee(0), callee(1), callee(2)]),
            },
        }),
    );
    assert.equal(changedRelationships.status, "ok");
    if (changedRelationships.status !== "ok") return;
    const changedSource = changedRelationships.context.continuations.find(
        (entry) => entry.kind === "source_range",
    );
    const changedCaller = changedRelationships.context.continuations.find(
        (entry) => entry.kind === "caller_page",
    );
    assert.equal(changedSource?.fingerprint, sourceHandle.fingerprint);
    assert.notEqual(changedCaller?.fingerprint, callerHandle.fingerprint);
});

test("source continuations revalidate their fingerprint and return only the requested range", async () => {
    const source = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const data = fixture(source);
    data.target.span = { startLine: 2, endLine: 78 };
    const budgets = defaultBudgets();
    budgets.source = {
        ...budgets.source,
        maxSourceBytes: 120,
        maxSourceLines: 8,
        maxExcerptBytes: 120,
        maxExcerptLines: 8,
        maxSerializedSourceBytes: 4_000,
    };
    const initial = await composeSymbolContext(
        request({ budgets }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.equal(initial.status, "ok");
    if (initial.status !== "ok") return;
    const handle = initial.context.continuations.find((entry) => entry.kind === "source_range");
    assert.ok(handle && handle.kind === "source_range");

    const continued = await composeSymbolContext(
        request({
            budgets,
            include: { source: true, siblings: false, callers: false, callees: false },
            continuation: {
                kind: "source_range",
                fingerprint: handle.fingerprint,
                startLine: handle.startLine,
                endLine: handle.endLine,
            },
        }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.equal(continued.status, "ok");
    if (continued.status !== "ok") return;
    assert.equal(continued.context.source.status, "available");
    if (continued.context.source.status !== "available") return;
    assert.ok(continued.context.source.span.startLine >= handle.startLine);
    assert.ok(continued.context.source.span.endLine <= handle.endLine);
    assert.equal(continued.context.relationships.callers.status, "not_requested");
    assert.equal(continued.context.relationships.callees.status, "not_requested");

    const stale = await composeSymbolContext(
        request({
            budgets,
            include: { source: true, siblings: false, callers: false, callees: false },
            continuation: {
                kind: "source_range",
                fingerprint: `${handle.fingerprint}-stale`,
                startLine: handle.startLine,
                endLine: handle.endLine,
            },
        }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.deepEqual(stale, {
        status: "stale_continuation",
        reason: "continuation_identity_changed",
    });

    const outOfSymbolRange = await composeSymbolContext(
        request({
            budgets,
            include: { source: true, siblings: false, callers: false, callees: false },
            continuation: {
                kind: "source_range",
                fingerprint: handle.fingerprint,
                startLine: data.target.span.endLine + 1,
                endLine: data.target.span.endLine + 10,
            },
        }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.deepEqual(outOfSymbolRange, {
        status: "stale_continuation",
        reason: "continuation_identity_changed",
    });
});

test("relationship continuations resume after canonical cursors and reject cross-direction cursors", async () => {
    const source = "class Parent {\n  target() { return true; }\n}\n";
    const data = fixture(source);
    const initial = await composeSymbolContext(
        request({ include: { source: false, siblings: false, callers: true, callees: true } }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.equal(initial.status, "ok");
    if (initial.status !== "ok") return;
    const callerHandle = initial.context.continuations.find((entry) => entry.kind === "caller_page");
    const calleeHandle = initial.context.continuations.find((entry) => entry.kind === "callee_page");
    assert.ok(callerHandle && callerHandle.kind === "caller_page");
    assert.ok(calleeHandle && calleeHandle.kind === "callee_page");

    const continued = await composeSymbolContext(
        request({
            include: { source: false, siblings: false, callers: true, callees: false },
            continuation: {
                kind: "caller_page",
                fingerprint: callerHandle.fingerprint,
                cursor: callerHandle.cursor,
                pageSize: 1,
            },
        }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.equal(continued.status, "ok");
    if (continued.status !== "ok") return;
    assert.equal(continued.context.relationships.callers.status, "ok");
    if (continued.context.relationships.callers.status !== "ok") return;
    assert.equal(continued.context.relationships.callers.returnedCount, 1);
    assert.equal(continued.context.relationships.callers.items[0]?.symbolId, "caller-2");

    const crossDirection = await composeSymbolContext(
        request({
            include: { source: false, siblings: false, callers: false, callees: true },
            continuation: {
                kind: "callee_page",
                fingerprint: calleeHandle.fingerprint,
                cursor: callerHandle.cursor,
                pageSize: 1,
            },
        }),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.deepEqual(crossDirection, {
        status: "invalid_relationship_continuation",
        reason: "cursor_invalid_for_prepared_traversal",
    });
});

test("composer preserves prepared relationship suppression evidence", async () => {
    const source = "class Parent {\n  target() { return true; }\n}\n";
    const data = fixture(source);
    const suppressedNote = {
        type: "suppressed_edge" as const,
        file: "src/low-confidence.ts",
        startLine: 9,
        symbolId: "low-confidence-caller",
        confidence: 0.35,
        detail: "Suppressed low-confidence caller candidate.",
    };
    const callers = preparedDirection([caller(0)]);
    callers.suppressedCount = 1;
    callers.suppressionNotes = [suppressedNote];
    const result = await composeSymbolContext(
        request({ include: { source: false, siblings: false, callers: true, callees: false } }),
        dependencies({
            source,
            symbols: data.symbols,
            relationships: {
                status: "available",
                authority: "remote_generation_proven",
                manifestIdentity: "relationship-manifest",
                callers,
                callees: preparedDirection([]),
            },
        }),
    );

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.context.relationships.callers.status, "ok");
    if (result.context.relationships.callers.status !== "ok") return;
    assert.equal(result.context.relationships.callers.suppressedCount, 1);
    assert.deepEqual(result.context.relationships.callers.suppressionNotes, [suppressedNote]);
    assert.ok(result.context.relationships.callers.limitations.includes(
        "low_confidence_relationships_suppressed",
    ));
});

test("changed source without structural re-resolution returns no stale span evidence", async () => {
    const indexedSource = "class Parent {\n  target() { return oldValue; }\n}\n";
    const currentSource = "class Parent {\n  inserted() {}\n  target() { return currentValue; }\n}\n";
    const data = fixture(indexedSource);
    const result = await composeSymbolContext(
        request({ include: { source: true, siblings: false, callers: false, callees: false } }),
        {
            ...dependencies({ source: currentSource, symbols: data.symbols }),
            resolveCurrentSpans: async ({ symbols, evidence }) => ({
                evidence,
                validations: symbols.map((entry) => ({
                    symbol: entry,
                    attempted: false,
                    validated: false,
                    repaired: false,
                    startBeforeDefinition: false,
                    endTruncated: false,
                    match: "not_applicable" as const,
                })),
            }),
        },
    );

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.context.source.status, "unavailable");
    assert.equal(
        "emptyReason" in result.context.source ? result.context.source.emptyReason : undefined,
        "current_symbol_span_unavailable",
    );
    assert.equal(result.context.authority.source.freshness, "current_at_final_observation");
    assert.equal(result.context.authority.source.spanResolution, "unavailable");
    assert.equal(
        result.context.continuations.some((entry) => entry.kind === "source_range"),
        false,
    );
});

test("structural re-resolution publishes the current span and binds its continuation", async () => {
    const indexedSource = "class Parent {\n  target() { return oldValue; }\n}\n";
    const currentSource = [
        "class Parent {",
        "  inserted() {}",
        "  target() {",
        "    return currentValue;",
        "  }",
        "}",
    ].join("\n");
    const data = fixture(indexedSource);
    const budgets = defaultBudgets();
    budgets.source = {
        ...budgets.source,
        maxSourceBytes: 100,
        maxSourceLines: 1,
        maxExcerptBytes: 100,
        maxExcerptLines: 1,
    };
    const result = await composeSymbolContext(
        request({
            budgets,
            include: { source: true, siblings: false, callers: false, callees: false },
        }),
        {
            ...dependencies({ source: currentSource, symbols: data.symbols }),
            resolveCurrentSpans: async ({ symbols, evidence }) => ({
                evidence,
                validations: symbols.map((entry) => entry.symbolInstanceId === "target"
                    ? matchedCurrentValidation(entry, { startLine: 3, endLine: 5 })
                    : missingCurrentValidation(entry)),
            }),
        },
    );

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.context.symbol.span, { startLine: 3, endLine: 5 });
    assert.equal(result.context.authority.source.spanResolution, "current_symbol_validated");
    assert.ok(result.context.continuations.some((entry) => (
        entry.kind === "source_range" && entry.fingerprint.startsWith("sha256_source_")
    )));
});

test("structural re-resolution budgets the current identity and reports a representable minimum", async () => {
    const indexedSource = "class Parent {\n  target() { return oldValue; }\n}\n";
    const currentSource = Array.from({ length: 1_100 }, (_, index) => {
        const line = index + 1;
        if (line === 1_000) return "function target() {";
        if (line === 1_040) return "  return importantCommit();";
        if (line === 1_080) return "}";
        return `const value${line} = ${line};`;
    }).join("\n");
    const data = fixture(indexedSource);
    const include = { source: true, siblings: false, callers: false, callees: false };
    const budgets = defaultBudgets();
    budgets.source = {
        ...budgets.source,
        maxSourceBytes: 1_000,
        maxSourceLines: 12,
        maxExcerptBytes: 300,
        maxExcerptLines: 3,
    };
    const currentSpan = { startLine: 1_000, endLine: 1_080 };
    const currentDependencies: SymbolContextComposerDependencies = {
        ...dependencies({ source: currentSource, symbols: data.symbols }),
        resolveCurrentSpans: async ({ symbols, evidence }) => ({
            evidence,
            validations: symbols.map((entry) => entry.symbolInstanceId === "target"
                ? matchedCurrentValidation(entry, currentSpan)
                : missingCurrentValidation(entry)),
        }),
    };
    const wide = await composeSymbolContext(
        request({ budgets, include, query: "important commit" }),
        currentDependencies,
    );
    assert.equal(wide.status, "ok");
    if (wide.status !== "ok") return;
    assert.equal(wide.context.source.status, "available");
    if (!("excerptCount" in wide.context.source)) return;
    assert.ok(wide.context.source.excerptCount >= 2);
    assert.equal(wide.context.symbol.span.startLine, currentSpan.startLine);

    const impossible = await composeSymbolContext(
        request({
            budgets: { ...budgets, maxSerializedResponseBytes: 1 },
            include,
            query: "important commit",
        }),
        currentDependencies,
    );
    assert.equal(impossible.status, "resource_limit");
    if (impossible.status !== "resource_limit") return;
    const minimum = await composeSymbolContext(
        request({
            budgets: {
                ...budgets,
                maxSerializedResponseBytes: impossible.minimumRequiredResponseBytes,
            },
            include,
            query: "important commit",
        }),
        currentDependencies,
    );
    assert.equal(minimum.status, "ok", JSON.stringify({ impossible, minimum }));
    if (minimum.status !== "ok") return;
    assert.ok(
        Buffer.byteLength(JSON.stringify(minimum.context), "utf8")
            <= impossible.minimumRequiredResponseBytes,
    );
});

test("composer rejects a prepared authority change at the final observation", async () => {
    const source = "class Parent {\n  target() { return true; }\n  sibling() {}\n}\n";
    const data = fixture(source);
    let validations = 0;
    const result = await composeSymbolContext(
        request(),
        dependencies({
            source,
            symbols: data.symbols,
            validateAuthority: async () => {
                validations += 1;
                return false;
            },
        }),
    );

    assert.deepEqual(result, {
        status: "stale",
        reason: "prepared_authority_changed",
    });
    assert.equal(validations, 1);
});

test("failed final source observation removes source evidence and current relationship sites", async () => {
    const source = "class Parent {\n  target() { return true; }\n  sibling() {}\n}\n";
    const data = fixture(source);
    const result = await composeSymbolContext(
        request(),
        dependencies({
            source,
            symbols: data.symbols,
            finalSourceObservation: async () => ({
                status: "stale",
                reason: "path_identity_changed_during_inspection",
            }),
        }),
    );

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.context.source.status, "stale");
    assert.equal(result.context.authority.source.freshness, "stale");
    assert.equal(result.context.authority.source.spanResolution, "unavailable");
    assert.equal(
        result.context.continuations.some((entry) => entry.kind === "source_range"),
        false,
    );
    const calleeSites = result.context.relationships.callees.status === "ok"
        ? result.context.relationships.callees.items.flatMap((item) => [item.sites.status])
        : [];
    assert.deepEqual(calleeSites, ["not_current_source_validated", "not_current_source_validated"]);
});

test("mandatory source survives response pressure before optional graph evidence", async () => {
    const source = "class Parent {\n  target() { return true; }\n  sibling() {}\n}\n";
    const data = fixture(source);
    const highBudget = await composeSymbolContext(
        request(),
        dependencies({ source, symbols: data.symbols }),
    );
    assert.equal(highBudget.status, "ok");
    if (highBudget.status !== "ok") return;

    const fullBytes = Buffer.byteLength(JSON.stringify(highBudget.context), "utf8");
    const budgets = defaultBudgets();
    budgets.maxSerializedResponseBytes = fullBytes - 400;
    const pressured = await composeSymbolContext(
        request({ budgets }),
        dependencies({ source, symbols: data.symbols }),
    );

    assert.equal(pressured.status, "ok");
    if (pressured.status !== "ok") return;
    assert.equal(pressured.context.source.status, "available");
    assert.equal(
        "completeSymbolReturned" in pressured.context.source
            ? pressured.context.source.completeSymbolReturned
            : false,
        true,
    );
    assert.ok(
        pressured.context.relationships.callers.returnedCount
        + pressured.context.relationships.callees.returnedCount
        < 4,
    );
});
