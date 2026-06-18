import test from "node:test";
import assert from "node:assert/strict";
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
} from "@zokizuan/satori-core";
import type { SymbolRecord, SymbolRegistryManifest } from "@zokizuan/satori-core";
import {
    findExactRegistryMatch,
    shouldAttemptExactRegistryLookup,
} from "./exact-registry.js";

function manifest(files: SymbolRegistryManifest["files"]): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: "/repo",
        rootFingerprint: "test-root",
        indexPolicyHash: "test-policy",
        languageRouterVersion: "test-router",
        extractorVersion: "test-extractor",
        relationshipVersion: "test-relationships",
        builtAt: "2026-01-01T00:00:00.000Z",
        files,
    };
}

function symbol(input: {
    id: string;
    name: string;
    qualifiedName?: string;
    label?: string;
    file?: string;
    language?: string;
    kind?: SymbolRecord["kind"];
    startLine?: number;
    endLine?: number;
}): SymbolRecord {
    const file = input.file || "src/runtime.ts";
    return {
        symbolKey: `${file}:${input.qualifiedName || input.name}`,
        symbolInstanceId: input.id,
        language: input.language || "typescript",
        kind: input.kind || "function",
        name: input.name,
        qualifiedName: input.qualifiedName || input.name,
        label: input.label || `function ${input.name}()`,
        file,
        span: {
            startLine: input.startLine || 1,
            endLine: input.endLine || input.startLine || 1,
        },
        parentQualifiedNamePath: [],
        fileHash: `${file}-hash`,
        extractorVersion: "test-extractor",
    };
}

function registry(symbols: SymbolRecord[]) {
    const files = Array.from(new Set(symbols.map((entry) => entry.file)))
        .sort()
        .map((file) => ({
            path: file,
            hash: `${file}-hash`,
            language: symbols.find((entry) => entry.file === file)?.language || "typescript",
            symbolCount: symbols.filter((entry) => entry.file === file).length,
        }));
    return buildSymbolRegistry({
        manifest: manifest(files),
        symbols,
    });
}

function lookupInput(overrides: Partial<Parameters<typeof findExactRegistryMatch>[0]> & {
    registry: ReturnType<typeof registry>;
    semanticQuery: string;
}): Parameters<typeof findExactRegistryMatch>[0] {
    return {
        intent: "identifier",
        lexicalTerms: [overrides.semanticQuery],
        quotedLiteralPhrases: [],
        operators: {
            path: [],
        },
        filterSymbol: () => true,
        ...overrides,
    };
}

test("findExactRegistryMatch returns exact symbolInstanceId matches from the current registry", () => {
    const target = symbol({ id: "sym-prepare", name: "prepareTrackedRootForRead" });
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([target]),
        semanticQuery: "sym-prepare",
    }));

    assert.equal(result.status, "hit");
    assert.equal(result.reason, "symbol_instance_id");
    if (result.status === "hit") {
        assert.equal(result.symbol.symbolInstanceId, "sym-prepare");
    }
});

test("findExactRegistryMatch matches exact normalized camel and snake identifier identity", () => {
    const target = symbol({ id: "sym-prepare", name: "prepareTrackedRootForRead" });
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([target]),
        semanticQuery: "prepare_tracked_root_for_read",
    }));

    assert.equal(result.status, "hit");
    assert.equal(result.reason, "normalized_identity");
    if (result.status === "hit") {
        assert.equal(result.symbol.name, "prepareTrackedRootForRead");
    }
});

test("shouldAttemptExactRegistryLookup does not hijack vague one-word semantic queries", () => {
    assert.equal(shouldAttemptExactRegistryLookup({
        semanticQuery: "runtime",
        intent: "uncertain",
        lexicalTerms: ["runtime"],
        quotedLiteralPhrases: [],
        hasExactPathFilter: false,
    }), false);
    assert.equal(shouldAttemptExactRegistryLookup({
        semanticQuery: "warning",
        intent: "uncertain",
        lexicalTerms: ["warning"],
        quotedLiteralPhrases: [],
        hasExactPathFilter: false,
    }), false);
});

test("shouldAttemptExactRegistryLookup accepts strong identifiers and exact path-scoped identifiers", () => {
    assert.equal(shouldAttemptExactRegistryLookup({
        semanticQuery: "prepareTrackedRootForRead",
        intent: "identifier",
        lexicalTerms: ["preparetrackedrootforread"],
        quotedLiteralPhrases: [],
        hasExactPathFilter: false,
    }), true);
    assert.equal(shouldAttemptExactRegistryLookup({
        semanticQuery: "run",
        intent: "uncertain",
        lexicalTerms: ["run"],
        quotedLiteralPhrases: [],
        hasExactPathFilter: true,
    }), true);
});

test("findExactRegistryMatch refuses ambiguous normalized matches instead of guessing", () => {
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([
            symbol({ id: "sym-stack-run", name: "runTask", qualifiedName: "Stack.runTask", file: "src/stack.ts" }),
            symbol({ id: "sym-builder-run", name: "runTask", qualifiedName: "Builder.runTask", file: "src/builder.ts" }),
        ]),
        semanticQuery: "run_task",
    }));

    assert.equal(result.status, "ambiguous");
    assert.equal(result.debug.ambiguousCount, 2);
});

test("findExactRegistryMatch accepts exact declaration labels only when unambiguous", () => {
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([
            symbol({
                id: "sym-prepare",
                name: "prepareTrackedRootForRead",
                label: "method prepareTrackedRootForRead(path: string)",
            }),
        ]),
        semanticQuery: "method prepareTrackedRootForRead(path: string)",
    }));

    assert.equal(result.status, "hit");
    assert.equal(result.reason, "label");
    if (result.status === "hit") {
        assert.equal(result.symbol.symbolInstanceId, "sym-prepare");
    }
});

test("findExactRegistryMatch refuses ambiguous exact declaration labels instead of guessing", () => {
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([
            symbol({
                id: "sym-first",
                name: "run",
                qualifiedName: "First.run",
                label: "method run()",
                file: "src/first.ts",
            }),
            symbol({
                id: "sym-second",
                name: "run",
                qualifiedName: "Second.run",
                label: "method run()",
                file: "src/second.ts",
            }),
        ]),
        semanticQuery: "method run()",
    }));

    assert.equal(result.status, "ambiguous");
    assert.equal(result.debug.ambiguousCount, 2);
});

test("findExactRegistryMatch applies deterministic filters before deciding ambiguity", () => {
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([
            symbol({ id: "sym-stack-new", name: "new", qualifiedName: "Stack.new", file: "src/stack.ts" }),
            symbol({ id: "sym-builder-new", name: "new", qualifiedName: "Builder.new", file: "tests/builder.test.ts" }),
        ]),
        semanticQuery: "new",
        operators: {
            path: ["src/stack.ts"],
        },
        filterSymbol: (entry) => entry.file === "src/stack.ts",
    }));

    assert.equal(result.status, "hit");
    assert.equal(result.debug.candidateSet, "path_exact_file");
    assert.equal(result.debug.inspectedSymbolCount, 1);
    if (result.status === "hit") {
        assert.equal(result.symbol.symbolInstanceId, "sym-stack-new");
    }
});

test("findExactRegistryMatch reports a miss for exact path scopes absent from the registry without scanning all symbols", () => {
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([
            symbol({ id: "sym-runtime", name: "prepareTrackedRootForRead", file: "src/runtime.ts" }),
        ]),
        semanticQuery: "prepareTrackedRootForRead",
        operators: {
            path: ["packages/mcp/src/core/handlers.ts"],
        },
        filterSymbol: () => true,
    }));

    assert.equal(result.status, "miss");
    assert.equal(result.debug.candidateSet, "path_exact_file");
    assert.equal(result.debug.inspectedSymbolCount, 0);
});

test("findExactRegistryMatch delegates non-path filtering policy to caller", () => {
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([
            symbol({ id: "sym-docs", name: "prepareTrackedRootForRead", file: "docs/runtime.ts" }),
        ]),
        semanticQuery: "prepareTrackedRootForRead",
        filterSymbol: () => false,
    }));

    assert.equal(result.status, "miss");
    assert.equal(result.debug.filteredSymbolCount, 0);
});

test("findExactRegistryMatch leaves quoted literal queries to lexical fallback", () => {
    const result = findExactRegistryMatch(lookupInput({
        registry: registry([
            symbol({ id: "sym-runtime", name: "warningLiteral" }),
        ]),
        semanticQuery: "partial index search warning",
        quotedLiteralPhrases: ["partial index search warning"],
    }));

    assert.equal(result.status, "not_applicable");
    assert.equal(result.reason, "quoted_literal");
});
