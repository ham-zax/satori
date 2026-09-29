import assert from "node:assert/strict";
import test from "node:test";
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from "@satori-code/core";
import type { SearchResultLike } from "./search-lexical-scoring.js";
import {
    buildSearchRerankStructuralContext,
    prepareSearchRerankStructuralRelationships,
    type SearchRerankStructuralReference,
} from "./search-rerank-structural-context.js";

function createSymbol(input: {
    file: string;
    name: string;
    qualifiedName?: string;
    label?: string;
    startLine: number;
    endLine: number;
    fileHash: string;
    language?: string;
    kind?: SymbolRecord["kind"];
}): SymbolRecord {
    const qualifiedName = input.qualifiedName || input.name;
    const label = input.label || `function ${input.name}()`;
    const language = input.language || "typescript";
    const kind = input.kind || "function";
    const parentQualifiedNamePath: string[] = [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language,
        kind,
        qualifiedName,
        parentQualifiedNamePath,
    });
    const span = { startLine: input.startLine, endLine: input.endLine };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: "extractor-v1",
        }),
        language,
        kind,
        name: input.name,
        qualifiedName,
        label,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: "extractor-v1",
    };
}

function navigationManifest(files: SymbolRegistryManifest["files"]): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: "/repo",
        rootFingerprint: "root-fingerprint",
        indexPolicyHash: "policy-hash",
        languageRouterVersion: "router-v1",
        extractorVersion: "extractor-v1",
        relationshipVersion: "relationship-v1",
        builtAt: "2026-06-17T00:00:00.000Z",
        files,
    };
}

function buildRegistry(symbols: SymbolRecord[]) {
    return buildSymbolRegistry({
        manifest: navigationManifest(symbols.map((symbol) => ({
            path: symbol.file,
            hash: symbol.fileHash,
            language: symbol.language,
            symbolCount: 1,
            definitionStatus: "definitions_present" as const,
        }))),
        symbols,
    });
}

function candidateFor(symbol: SymbolRecord): SearchResultLike {
    return {
        relativePath: symbol.file,
        startLine: symbol.span.startLine,
        endLine: symbol.span.endLine,
        ownerSymbolInstanceId: symbol.symbolInstanceId,
        ownerSymbolKey: symbol.symbolKey,
        language: symbol.language,
        symbolLabel: symbol.label,
    };
}

function calls(
    source: SymbolRecord,
    target: SymbolRecord,
    confidence: RelationshipRecord["confidence"] = "high",
    resolutionAuthority?: RelationshipRecord["resolutionAuthority"],
): RelationshipRecord {
    return {
        sourceKey: source.symbolKey,
        sourceInstanceId: source.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type: "CALLS",
        file: source.file,
        span: { startLine: source.span.startLine, endLine: source.span.endLine },
        confidence,
        ...(resolutionAuthority === undefined ? {} : { resolutionAuthority }),
    };
}

function tests(source: SymbolRecord, target: SymbolRecord): RelationshipRecord {
    return {
        sourceKey: source.symbolKey,
        sourceInstanceId: source.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type: "TESTS",
        file: source.file,
        span: { startLine: source.span.startLine, endLine: source.span.endLine },
        confidence: "high",
    };
}

function reference(relation: SearchRerankStructuralReference["relation"], symbol: SymbolRecord): SearchRerankStructuralReference {
    return {
        repository_relative_path: symbol.file,
        canonical_symbol_label: symbol.label,
        relation,
    };
}

test("structural context resolves direct callers and callees from exact instance identities", () => {
    const owner = createSymbol({ file: "src/veto.ts", name: "validate_order", startLine: 10, endLine: 20, fileHash: "h-owner" });
    const caller = createSymbol({ file: "src/core.ts", name: "execute", startLine: 1, endLine: 5, fileHash: "h-caller" });
    const callee = createSymbol({ file: "src/checks.ts", name: "check_shariah", startLine: 3, endLine: 8, fileHash: "h-callee" });
    const registry = buildRegistry([owner, caller, callee]);
    const context = buildSearchRerankStructuralContext({
        candidate: candidateFor(owner),
        registry,
        relationships: [
            calls(caller, owner),
            calls(owner, callee),
        ],
    });
    assert.deepEqual(context.directCallers, [reference("caller", caller)]);
    assert.deepEqual(context.directCallees, [reference("callee", callee)]);
    assert.deepEqual(context.supportingTests, []);
});

test("structural context resolves tests that support an implementation", () => {
    const owner = createSymbol({ file: "src/veto.ts", name: "validate_order", startLine: 10, endLine: 20, fileHash: "h-owner" });
    const testSymbol = createSymbol({ file: "tests/veto.test.ts", name: "test_vetoes_trades", startLine: 1, endLine: 9, fileHash: "h-test", kind: "test" });
    const registry = buildRegistry([owner, testSymbol]);
    const context = buildSearchRerankStructuralContext({
        candidate: candidateFor(owner),
        registry,
        relationships: [tests(testSymbol, owner)],
    });
    assert.deepEqual(context.supportingTests, [reference("test_support", testSymbol)]);
    assert.deepEqual(context.directCallers, []);
    assert.deepEqual(context.directCallees, []);
});

test("structural context omits ambiguous, unresolved, and low-confidence references", () => {
    const owner = createSymbol({ file: "src/veto.ts", name: "validate_order", startLine: 10, endLine: 20, fileHash: "h-owner" });
    const resolvedCaller = createSymbol({ file: "src/core.ts", name: "execute", startLine: 1, endLine: 5, fileHash: "h-caller" });
    const registry = buildRegistry([owner, resolvedCaller]);
    const unknownInstanceId = "instance-not-in-registry";
    const context = buildSearchRerankStructuralContext({
        candidate: candidateFor(owner),
        registry,
        relationships: [
            // Caller instance id does not resolve in the registry.
            {
                sourceKey: "key:unknown",
                sourceInstanceId: unknownInstanceId,
                targetKey: owner.symbolKey,
                targetInstanceId: owner.symbolInstanceId,
                type: "CALLS",
                file: "src/unknown.ts",
                span: { startLine: 1, endLine: 1 },
                confidence: "high",
            },
            // Key-only record without instance identity.
            {
                sourceKey: "key:keyonly",
                targetKey: owner.symbolKey,
                type: "CALLS",
                file: "src/keyonly.ts",
                span: { startLine: 1, endLine: 1 },
                confidence: "high",
            },
            // Low-confidence edge with exact identities.
            calls(resolvedCaller, owner, "low"),
            // Fuzzy suffix-only style match on the owner key is never admitted.
            {
                sourceKey: "key:validate_order_suffix",
                sourceInstanceId: "instance-suffix",
                targetKey: owner.symbolKey,
                targetInstanceId: owner.symbolInstanceId,
                type: "CALLS",
                file: "src/suffix.ts",
                span: { startLine: 1, endLine: 1 },
                confidence: "high",
            },
        ],
    });
    assert.deepEqual(context.directCallers, []);
    assert.deepEqual(context.directCallees, []);
    assert.deepEqual(context.supportingTests, []);
});

test("structural context admits the proof-backed cross-module TradingCore constructor caller", () => {
    const constructor = createSymbol({
        file: "src/trading_core.py",
        name: "__init__",
        qualifiedName: "TradingCore.__init__",
        label: "TradingCore.__init__",
        startLine: 12,
        endLine: 20,
        fileHash: "trading-core",
        language: "python",
        kind: "method",
    });
    const veto = createSymbol({
        file: "src/trading_entry_vetoes.py",
        name: "TradingEntryVetoes",
        label: "TradingEntryVetoes",
        startLine: 3,
        endLine: 18,
        fileHash: "trading-entry-vetoes",
        language: "python",
        kind: "class",
    });
    const registry = buildRegistry([constructor, veto]);
    const context = buildSearchRerankStructuralContext({
        candidate: candidateFor(veto),
        registry,
        relationships: [calls(constructor, veto, "low", "direct_binding")],
    });
    assert.deepEqual(context.directCallers, [reference("caller", constructor)]);
    assert.deepEqual(context.directCallees, []);
    assert.deepEqual(context.supportingTests, []);
});

test("structural context reuses a prepared relationship index without changing exact-instance output", () => {
    const owner = createSymbol({ file: "src/owner.ts", name: "owner", startLine: 10, endLine: 20, fileHash: "owner" });
    const caller = createSymbol({ file: "src/caller.ts", name: "caller", startLine: 1, endLine: 5, fileHash: "caller" });
    const registry = buildRegistry([owner, caller]);
    const preparedRelationships = prepareSearchRerankStructuralRelationships([calls(caller, owner)]);
    assert.deepEqual(buildSearchRerankStructuralContext({
        candidate: candidateFor(owner),
        registry,
        preparedRelationships,
    }).directCallers, [reference("caller", caller)]);
});

test("structural context returns empty context without an exact owner or any records", () => {
    const owner = createSymbol({ file: "src/veto.ts", name: "validate_order", startLine: 10, endLine: 20, fileHash: "h-owner" });
    const registry = buildRegistry([owner]);
    assert.deepEqual(buildSearchRerankStructuralContext({
        candidate: { relativePath: "src/veto.ts", startLine: 10, endLine: 20 },
        registry,
        relationships: [],
    }), { directCallers: [], directCallees: [], supportingTests: [] });
    assert.deepEqual(buildSearchRerankStructuralContext({
        candidate: candidateFor(owner),
        registry,
        relationships: [],
    }), { directCallers: [], directCallees: [], supportingTests: [] });
});

test("structural context is deterministically sorted and capped", () => {
    const owner = createSymbol({ file: "src/veto.ts", name: "validate_order", startLine: 10, endLine: 20, fileHash: "h-owner" });
    const callers = [1, 2, 3, 4].map((index) => createSymbol({
        file: `src/caller-${index}.ts`,
        name: `caller_${index}`,
        startLine: index,
        endLine: index + 2,
        fileHash: `h-caller-${index}`,
    }));
    const testSymbols = [1, 2, 3].map((index) => createSymbol({
        file: `tests/veto-${index}.test.ts`,
        name: `test_${index}`,
        startLine: index,
        endLine: index + 2,
        fileHash: `h-test-${index}`,
        kind: "test",
    }));
    const registry = buildRegistry([owner, ...callers, ...testSymbols]);
    const relationships = [
        ...callers.map((caller) => calls(caller, owner)),
        ...testSymbols.map((testSymbol) => tests(testSymbol, owner)),
    ].sort(() => -1); // adversarial order
    const context = buildSearchRerankStructuralContext({
        candidate: candidateFor(owner),
        registry,
        relationships,
    });
    assert.deepEqual(
        context.directCallers.map((entry) => entry.repository_relative_path),
        ["src/caller-1.ts", "src/caller-2.ts", "src/caller-3.ts"],
        "callers are sorted by path and capped at 3",
    );
    assert.deepEqual(
        context.supportingTests.map((entry) => entry.repository_relative_path),
        ["tests/veto-1.test.ts", "tests/veto-2.test.ts"],
        "tests are sorted by path and capped at 2",
    );
});
