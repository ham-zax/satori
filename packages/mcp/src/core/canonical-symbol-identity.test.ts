import test from "node:test";
import assert from "node:assert/strict";
import type { SymbolRecord } from "@zokizuan/satori-core";
import {
    buildCanonicalSymbolRegistryView,
    projectCanonicalSymbolIdentity,
} from "./canonical-symbol-identity.js";

function createSymbol(input: {
    symbolKey: string;
    symbolInstanceId: string;
    name: string;
    qualifiedName: string;
    parentKey?: string;
    parentQualifiedNamePath?: string[];
}): SymbolRecord {
    return {
        symbolKey: input.symbolKey,
        symbolInstanceId: input.symbolInstanceId,
        language: "typescript",
        kind: input.parentKey ? "method" : "class",
        name: input.name,
        qualifiedName: input.qualifiedName,
        label: `${input.parentKey ? "method" : "class"} ${input.name}`,
        file: "src/service.ts",
        span: { startLine: 1, endLine: 3, startByte: 0, endByte: 20 },
        ...(input.parentKey ? { parentKey: input.parentKey } : {}),
        parentQualifiedNamePath: input.parentQualifiedNamePath || [],
        fileHash: "file-hash",
        extractorVersion: "extractor-v1",
    };
}

test("canonical symbol identity projects registry metadata and uniquely resolved parent", () => {
    const parent = createSymbol({
        symbolKey: "parent-key",
        symbolInstanceId: "parent-instance",
        name: "Service",
        qualifiedName: "Service",
    });
    const child: SymbolRecord = {
        ...createSymbol({
            symbolKey: "child-key",
            symbolInstanceId: "child-instance",
            name: "run",
            qualifiedName: "Service.run",
            parentKey: parent.symbolKey,
            parentQualifiedNamePath: ["class Service"],
        }),
        exported: true,
        ontologyTags: ["SERVICE", "API"],
    };
    const registry = buildCanonicalSymbolRegistryView([parent, child]);

    const identity = projectCanonicalSymbolIdentity({ symbol: child, registry });

    assert.deepEqual(identity, {
        symbolId: "child-instance",
        symbolKey: "child-key",
        name: "run",
        qualifiedName: "Service.run",
        symbolLabel: "method run",
        kind: "method",
        language: "typescript",
        file: "src/service.ts",
        span: { startLine: 1, endLine: 3, startByte: 0, endByte: 20 },
        parentQualifiedNamePath: ["class Service"],
        parentResolution: "resolved",
        parentKey: "parent-key",
        parentSymbolId: "parent-instance",
        exported: true,
        ontologyTags: ["SERVICE", "API"],
    });
    assert.notEqual(identity.span, child.span);
    assert.notEqual(identity.parentQualifiedNamePath, child.parentQualifiedNamePath);
    assert.notEqual(identity.ontologyTags, child.ontologyTags);
});

test("canonical symbol identity reports ambiguous, missing, and non-applicable parents", () => {
    const firstParent = createSymbol({
        symbolKey: "parent-key",
        symbolInstanceId: "parent-one",
        name: "Service",
        qualifiedName: "Service",
    });
    const secondParent = {
        ...firstParent,
        symbolInstanceId: "parent-two",
    };
    const child = createSymbol({
        symbolKey: "child-key",
        symbolInstanceId: "child-instance",
        name: "run",
        qualifiedName: "Service.run",
        parentKey: "parent-key",
        parentQualifiedNamePath: ["class Service"],
    });

    assert.equal(projectCanonicalSymbolIdentity({
        symbol: child,
        registry: buildCanonicalSymbolRegistryView([firstParent, secondParent, child]),
    }).parentResolution, "ambiguous");
    assert.equal(projectCanonicalSymbolIdentity({
        symbol: child,
        registry: buildCanonicalSymbolRegistryView([child]),
    }).parentResolution, "missing");
    assert.equal(projectCanonicalSymbolIdentity({
        symbol: { ...child, parentKey: undefined },
        registry: buildCanonicalSymbolRegistryView([child]),
    }).parentResolution, "missing");
    assert.equal(projectCanonicalSymbolIdentity({
        symbol: firstParent,
        registry: buildCanonicalSymbolRegistryView([firstParent]),
    }).parentResolution, "not_applicable");
});

test("canonical symbol identity does not resolve a self-referential parent", () => {
    const symbol = createSymbol({
        symbolKey: "self-key",
        symbolInstanceId: "self-instance",
        name: "run",
        qualifiedName: "run",
        parentKey: "self-key",
        parentQualifiedNamePath: ["function run"],
    });
    const identity = projectCanonicalSymbolIdentity({
        symbol,
        registry: buildCanonicalSymbolRegistryView([symbol]),
    });

    assert.equal(identity.parentResolution, "missing");
    assert.equal(identity.parentSymbolId, undefined);
});

test("canonical identity projection records file-outline envelope growth", () => {
    const representative: SymbolRecord = {
        symbolKey: `symkey_${"b".repeat(64)}`,
        symbolInstanceId: `syminst_${"a".repeat(64)}`,
        language: "typescript",
        kind: "function",
        name: "run",
        qualifiedName: "run",
        label: "function run()",
        file: "src/runtime.ts",
        span: { startLine: 1, endLine: 3 },
        parentQualifiedNamePath: [],
        fileHash: "file-hash",
        extractorVersion: "extractor-v1",
    };
    const representativeCallGraphHint = {
        supported: true,
        validated: true,
        validatedAt: "2026-01-01T01:00:00.000Z",
        sidecarBuiltAt: "2026-01-01T00:00:00.000Z",
        symbolRef: {
            file: representative.file,
            symbolId: representative.symbolInstanceId,
            symbolLabel: representative.label,
            span: { ...representative.span },
        },
    };
    const symbols = Array.from({ length: 500 }, (_, index): SymbolRecord => {
        const name = `run${index}`;
        return {
            symbolKey: `symkey_${String(index).padStart(64, "b")}`,
            symbolInstanceId: `syminst_${String(index).padStart(64, "a")}`,
            language: "typescript",
            kind: "method",
            name,
            qualifiedName: `Service.${name}`,
            label: `function ${name}()`,
            file: "src/runtime.ts",
            span: { startLine: index + 1, endLine: index + 3 },
            parentQualifiedNamePath: ["class Service"],
            fileHash: "file-hash",
            extractorVersion: "extractor-v1",
        };
    });
    const registry = buildCanonicalSymbolRegistryView(symbols);
    const legacySymbols = symbols.map((symbol) => ({
        symbolId: symbol.symbolInstanceId,
        symbolLabel: symbol.label,
        span: { ...symbol.span },
        callGraphHint: { supported: false, reason: "missing_relationship_sidecar" },
    }));
    const enrichedSymbols = symbols.map((symbol) => ({
        ...projectCanonicalSymbolIdentity({ symbol, registry }),
        callGraphHint: { supported: false, reason: "missing_relationship_sidecar" },
    }));
    const envelopeBytes = (outlineSymbols: readonly object[]): number => Buffer.byteLength(JSON.stringify({
        status: "ok",
        path: "/repo",
        file: "src/runtime.ts",
        outline: { symbols: outlineSymbols },
        hasMore: false,
    }), "utf8");

    const representativeRegistry = buildCanonicalSymbolRegistryView([representative]);
    assert.deepEqual({
        legacyBytes: envelopeBytes([{
            symbolId: representative.symbolInstanceId,
            symbolLabel: representative.label,
            span: { ...representative.span },
            callGraphHint: representativeCallGraphHint,
        }]),
        enrichedBytes: envelopeBytes([{
            ...projectCanonicalSymbolIdentity({
                symbol: representative,
                registry: representativeRegistry,
            }),
            callGraphHint: representativeCallGraphHint,
        }]),
    }, {
        legacyBytes: 575,
        enrichedBytes: 827,
    });
    assert.deepEqual({
        legacyBytes: envelopeBytes(legacySymbols),
        enrichedBytes: envelopeBytes(enrichedSymbols),
    }, {
        legacyBytes: 118_272,
        enrichedBytes: 254_052,
    });
});
