import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { resolveSearchOwnerFromRegistry } from "./search-owner-resolution.js";
import {
    SYMBOL_METADATA_BM25_LIMIT,
    rankSymbolMetadataBm25,
    retrieveSymbolMetadataBm25Candidates,
} from "./search-symbol-metadata-bm25.js";

type SymbolDef = {
    name: string;
    qualifiedName?: string;
    kind?: SymbolRecord["kind"];
    startLine?: number;
    endLine?: number;
};

type FileDef = {
    path: string;
    source: string;
    symbols: SymbolDef[];
};

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function buildFixture(files: FileDef[]): {
    registry: SymbolRegistry;
    sources: Map<string, { source: string; hash: string }>;
    reads: string[];
    readSourceEvidence: (codebaseRoot: string, relativeFile: string) => Promise<{
        canonicalRoot: string;
        relativeFile: string;
        sourceBytes: Uint8Array;
        source: string;
        observedHash: string;
    } | undefined>;
} {
    const symbols: SymbolRecord[] = [];
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    const manifestFiles: SymbolRegistry["manifest"]["files"] = [];
    const sources = new Map<string, { source: string; hash: string }>();
    files.forEach((file, fileIndex) => {
        const hash = sha256(file.source);
        sources.set(file.path, { source: file.source, hash });
        manifestFiles.push({
            path: file.path,
            hash,
            language: "typescript",
            symbolCount: file.symbols.length,
            definitionStatus: "definitions_present",
        });
        const records = file.symbols.map((def, symbolIndex): SymbolRecord => ({
            symbolKey: `key-${fileIndex}-${symbolIndex}`,
            symbolInstanceId: `instance-${fileIndex}-${symbolIndex}`,
            language: "typescript",
            kind: def.kind ?? "function",
            name: def.name,
            qualifiedName: def.qualifiedName ?? def.name,
            label: `function ${def.name}`,
            file: file.path,
            span: { startLine: def.startLine ?? 1, endLine: def.endLine ?? 1 },
            parentQualifiedNamePath: [],
            fileHash: hash,
            extractorVersion: "fixture",
        }));
        symbols.push(...records);
        symbolsByFile.set(file.path, records);
    });
    const registry = {
        manifest: {
            schemaVersion: "symbol_registry_v3",
            normalizedRootPath: "/repo",
            rootFingerprint: "fixture",
            indexPolicyHash: "fixture",
            languageRouterVersion: "fixture",
            extractorVersion: "fixture",
            relationshipVersion: "fixture",
            builtAt: "2026-01-01T00:00:00Z",
            files: manifestFiles,
        },
        symbols,
        symbolsByInstanceId: new Map(symbols.map((symbol) => [symbol.symbolInstanceId, symbol])),
        symbolsByKey: new Map(symbols.map((symbol) => [symbol.symbolKey, [symbol]])),
        symbolsByFile,
        symbolsByLabel: new Map<string, SymbolRecord[]>(),
        symbolsByQualifiedName: new Map<string, SymbolRecord[]>(),
        warnings: [],
    } as unknown as SymbolRegistry;
    const reads: string[] = [];
    const readSourceEvidence = async (_codebaseRoot: string, relativeFile: string) => {
        reads.push(relativeFile);
        const entry = sources.get(relativeFile);
        if (!entry) {
            return undefined;
        }
        return {
            canonicalRoot: "/repo",
            relativeFile,
            sourceBytes: Buffer.from(entry.source),
            source: entry.source,
            observedHash: entry.hash,
        };
    };
    return { registry, sources, reads, readSourceEvidence };
}

const acceptAll = (): boolean => true;

test("split-name metadata query finds legality owners and the execution guard", () => {
    const { registry } = buildFixture([
        { path: "src/legality.ts", source: "export {};", symbols: [{ name: "checkLegality" }] },
        { path: "src/review.ts", source: "export {};", symbols: [{ name: "verifyLegality" }] },
        {
            path: "src/guard.ts",
            source: "export {};",
            symbols: [{ name: "enforceExecutionGuard", qualifiedName: "policy.enforceExecutionGuard" }],
        },
        { path: "src/widgets.ts", source: "export {};", symbols: [{ name: "renderButton" }] },
    ]);
    const names = rankSymbolMetadataBm25({
        registry,
        registryManifestHash: "manifest-a",
        query: "legality execution guard check",
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: acceptAll,
    }).map(({ symbol }) => symbol.name);
    assert.ok(names.includes("checkLegality"));
    assert.ok(names.includes("verifyLegality"));
    assert.ok(names.includes("enforceExecutionGuard"));
    assert.ok(!names.includes("renderButton"));
});

test("body-only vocabulary cannot affect the metadata rank", () => {
    const { registry } = buildFixture([
        {
            path: "src/alpha.ts",
            source: "function alpha() { return zebra + quantumFluxCapacitor; }",
            symbols: [{ name: "alpha" }],
        },
        { path: "src/beta.ts", source: "function beta() { return 1; }", symbols: [{ name: "beta" }] },
    ]);
    const ranked = rankSymbolMetadataBm25({
        registry,
        registryManifestHash: "manifest-a",
        query: "zebra quantum flux capacitor",
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: acceptAll,
    });
    assert.deepEqual(ranked, []);
});

test("the accepts filter applies before the bounded selection", () => {
    const files: FileDef[] = Array.from({ length: 15 }, (_, index) => ({
        path: `src/handlers/handler${index}.ts`,
        source: `export function requestHandler${index}() { return ${index}; }`,
        symbols: [{ name: `requestHandler${index}` }],
    }));
    const { registry } = buildFixture(files);
    const ranked = rankSymbolMetadataBm25({
        registry,
        registryManifestHash: "manifest-a",
        query: "request handler",
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: acceptAll,
    });
    assert.equal(ranked.length, SYMBOL_METADATA_BM25_LIMIT);
    const evenOnly = rankSymbolMetadataBm25({
        registry,
        registryManifestHash: "manifest-a",
        query: "request handler",
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: (symbol) => Number(symbol.name.replace("requestHandler", "")) % 2 === 0,
    });
    assert.equal(evenOnly.length, 8);
    assert.ok(evenOnly.every(({ symbol }) => Number(symbol.name.replace("requestHandler", "")) % 2 === 0));
});

test("uppercase acronym boundaries split for metadata matching", () => {
    const { registry } = buildFixture([
        {
            path: "src/net.ts",
            source: "export {};",
            symbols: [{ name: "HTTPServer", qualifiedName: "net.HTTPServer" }],
        },
        { path: "src/widgets.ts", source: "export {};", symbols: [{ name: "renderButton" }] },
    ]);
    const names = rankSymbolMetadataBm25({
        registry,
        registryManifestHash: "manifest-a",
        query: "http server",
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: acceptAll,
    }).map(({ symbol }) => symbol.name);
    assert.deepEqual(names, ["HTTPServer"]);
});

test("materialization preserves BM25 rank across interleaved files with score evidence", async () => {
    const fixture = buildFixture([
        {
            path: "src/a.ts",
            source: "function paymentRefundProcessor() { return 1; }\nfunction payment() { return 2; }",
            symbols: [
                { name: "paymentRefundProcessor", startLine: 1, endLine: 1 },
                { name: "payment", startLine: 2, endLine: 2 },
            ],
        },
        {
            path: "src/b.ts",
            source: "function paymentRefund() { return 3; }",
            symbols: [{ name: "paymentRefund", startLine: 1, endLine: 1 }],
        },
    ]);
    const query = "payment refund processor";
    const expected = rankSymbolMetadataBm25({
        registry: fixture.registry,
        registryManifestHash: "manifest-a",
        query,
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: acceptAll,
    });
    assert.deepEqual(
        expected.map(({ symbol }) => symbol.symbolInstanceId),
        ["instance-0-0", "instance-1-0", "instance-0-1"],
    );
    const results = await retrieveSymbolMetadataBm25Candidates({
        registry: fixture.registry,
        registryManifestHash: "manifest-a",
        query,
        codebaseRoot: "/repo",
        accepts: acceptAll,
        readSourceEvidence: fixture.readSourceEvidence,
    });
    assert.deepEqual(
        results.map((result) => result.ownerSymbolInstanceId),
        ["instance-0-0", "instance-1-0", "instance-0-1"],
    );
    assert.deepEqual(
        results.map((result) => result.relativePath),
        ["src/a.ts", "src/b.ts", "src/a.ts"],
    );
    for (const [index, result] of results.entries()) {
        assert.equal(result.backendScoreKind, "lexical_rank");
        assert.equal(result.score, expected[index]?.score);
    }
});

test("evidence from another root is rejected even when its file hash matches", async () => {
    const fixture = buildFixture([
        {
            path: "src/a.ts",
            source: "function checkLegality() { return true; }",
            symbols: [{ name: "checkLegality", startLine: 1, endLine: 1 }],
        },
    ]);
    const input = {
        registry: fixture.registry,
        registryManifestHash: "manifest-a",
        query: "legality",
        accepts: acceptAll,
    };
    const foreignRootReader = async (codebaseRoot: string, relativeFile: string) => {
        const evidence = await fixture.readSourceEvidence(codebaseRoot, relativeFile);
        if (!evidence) {
            return undefined;
        }
        return { ...evidence, canonicalRoot: "/elsewhere" };
    };
    assert.deepEqual(
        await retrieveSymbolMetadataBm25Candidates({
            ...input,
            codebaseRoot: "/repo",
            readSourceEvidence: foreignRootReader,
        }),
        [],
    );
    const admitted = await retrieveSymbolMetadataBm25Candidates({
        ...input,
        codebaseRoot: "/repo",
        readSourceEvidence: fixture.readSourceEvidence,
    });
    assert.equal(admitted.length, 1);
});

test("identical metadata scores tie-break deterministically on symbol instance id", () => {
    const { registry } = buildFixture([
        {
            path: "src/overloads.ts",
            source: "function run(a: number) { return a; }\nfunction run(a: string) { return a; }",
            symbols: [
                { name: "run", qualifiedName: "run", startLine: 1, endLine: 1 },
                { name: "run", qualifiedName: "run", startLine: 2, endLine: 2 },
            ],
        },
    ]);
    const input = {
        registry,
        registryManifestHash: "manifest-a",
        query: "run",
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: acceptAll,
    };
    const first = rankSymbolMetadataBm25(input);
    const second = rankSymbolMetadataBm25(input);
    assert.equal(first.length, 2);
    assert.equal(first[0]?.score, first[1]?.score);
    assert.deepEqual(
        first.map(({ symbol }) => symbol.symbolInstanceId),
        [...first.map(({ symbol }) => symbol.symbolInstanceId)].sort(),
    );
    assert.deepEqual(
        second.map(({ symbol }) => symbol.symbolInstanceId),
        first.map(({ symbol }) => symbol.symbolInstanceId),
    );
});

test("hash mismatches and invalid spans are never admitted", async () => {
    const source = "function good() { return 1; }\nfunction bad() { return 2; }\nfunction ugly() { return 3; }";
    const { registry, sources } = buildFixture([
        {
            path: "src/mixed.ts",
            source,
            symbols: [
                { name: "good", startLine: 1, endLine: 1 },
                { name: "bad", startLine: 99, endLine: 100 },
                { name: "ugly", startLine: 0, endLine: 0 },
            ],
        },
    ]);
    const entry = sources.get("src/mixed.ts");
    assert.ok(entry);
    const staleReader = async (_codebaseRoot: string, relativeFile: string) => ({
        canonicalRoot: "/repo",
        relativeFile,
        sourceBytes: Buffer.from(entry.source),
        source: entry.source,
        observedHash: "0".repeat(64),
    });
    assert.deepEqual(
        await retrieveSymbolMetadataBm25Candidates({
            registry,
            registryManifestHash: "manifest-a",
            query: "good bad ugly",
            codebaseRoot: "/repo",
            accepts: acceptAll,
            readSourceEvidence: staleReader,
        }),
        [],
    );
    const admitted = await retrieveSymbolMetadataBm25Candidates({
        registry,
        registryManifestHash: "manifest-a",
        query: "good bad ugly",
        codebaseRoot: "/repo",
        accepts: acceptAll,
        readSourceEvidence: buildFixture([
            {
                path: "src/mixed.ts",
                source,
                symbols: [
                    { name: "good", startLine: 1, endLine: 1 },
                    { name: "bad", startLine: 99, endLine: 100 },
                    { name: "ugly", startLine: 0, endLine: 0 },
                ],
            },
        ]).readSourceEvidence,
    });
    assert.deepEqual(
        admitted.map((result) => result.ownerSymbolInstanceId),
        ["instance-0-0"],
    );
});

test("one file is read once, excerpts are bounded, and owner conventions match the supplement", async () => {
    const lineCount = 200;
    const source = Array.from({ length: lineCount }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
    const { registry, reads, readSourceEvidence } = buildFixture([
        {
            path: "src/big.ts",
            source,
            symbols: [
                { name: "firstDeclaration", startLine: 1, endLine: lineCount },
                { name: "secondDeclaration", startLine: 50, endLine: 60 },
            ],
        },
    ]);
    const results = await retrieveSymbolMetadataBm25Candidates({
        registry,
        registryManifestHash: "manifest-a",
        query: "firstDeclaration secondDeclaration",
        codebaseRoot: "/repo",
        accepts: acceptAll,
        readSourceEvidence,
    });
    assert.equal(reads.length, 1);
    assert.equal(results.length, 2);
    const [first] = results;
    assert.ok(first);
    assert.equal(first.relativePath, "src/big.ts");
    assert.equal(first.symbolKind, "function");
    assert.equal(first.symbolLabel, "function firstDeclaration");
    assert.equal(first.symbolId, "key-0-0");
    assert.equal(first.ownerSymbolKey, "key-0-0");
    assert.equal(first.ownerSymbolInstanceId, "instance-0-0");
    assert.equal(first.startLine, 1);
    assert.equal(first.endLine, 80);
    assert.equal(first.content?.split("\n").length, 80);
    assert.ok(!("startByte" in first) && !("endByte" in first));
});

test("bounded Unicode and CRLF byte excerpts retain canonical ownership through grouping resolution", async () => {
    const prefix = "// π\r\n  ";
    const ownerContent = ["function legalValidation() {",
        ...Array.from({ length: 100 }, () => "  const value = 'é';"), "}"].join("\r\n");
    const source = `${prefix}${ownerContent}\r\n// tail`;
    const fixture = buildFixture([{
        path: "src/validation.ts", source,
        symbols: [{ name: "legalValidation", startLine: 2, endLine: 103 }],
    }]);
    const symbol = fixture.registry.symbols[0]!;
    symbol.span.startByte = Buffer.byteLength(prefix);
    symbol.span.endByte = symbol.span.startByte + Buffer.byteLength(ownerContent);
    const [result] = await retrieveSymbolMetadataBm25Candidates({
        registry: fixture.registry, registryManifestHash: "manifest-a",
        query: "legal validation", codebaseRoot: "/repo", accepts: acceptAll,
        readSourceEvidence: fixture.readSourceEvidence,
    });
    assert.ok(result);
    assert.equal(result.startByte, symbol.span.startByte);
    assert.equal(result.endLine, 81);
    assert.equal(result.content?.split(/\r\n/).length, 80);
    assert.ok(Number(result.endByte) < symbol.span.endByte);
    assert.equal(Buffer.from(source).subarray(Number(result.startByte), Number(result.endByte)).toString("utf8"), result.content);
    const resolution = resolveSearchOwnerFromRegistry({
        result, registry: fixture.registry,
        sanitizeIndexedRelativeFilePath: file => file,
        hasTokenBoundaryMatch: (text, term) => text.includes(term),
        isWriterActionTerm: () => false,
    });
    assert.equal(resolution.ownerSymbolInstanceId, symbol.symbolInstanceId);
    assert.deepEqual(resolution.ownerProof, { symbolInstanceId: symbol.symbolInstanceId, basis: "bytes" });
});

test("incomplete, out-of-file and split UTF8 byte spans fail closed", async () => {
    for (const span of [{ startByte: 0 }, { startByte: 0, endByte: 1000 },
        { startByte: 1, endByte: 2 }]) {
        const fixture = buildFixture([{
            path: "src/validation.ts", source: "é legalValidation",
            symbols: [{ name: "legalValidation" }],
        }]);
        Object.assign(fixture.registry.symbols[0]!.span, span);
        assert.deepEqual(await retrieveSymbolMetadataBm25Candidates({
            registry: fixture.registry, registryManifestHash: "manifest-a",
            query: "legal validation", codebaseRoot: "/repo", accepts: acceptAll,
            readSourceEvidence: fixture.readSourceEvidence,
        }), []);
    }
});

test("cached postings do not leak across manifest hashes or publications", () => {
    const fixture = buildFixture([
        { path: "src/a.ts", source: "export {};", symbols: [{ name: "checkLegality" }] },
    ]);
    const rankNames = (registry: SymbolRegistry, registryManifestHash: string): string[] =>
        rankSymbolMetadataBm25({
            registry,
            registryManifestHash,
            query: "legality",
            limit: SYMBOL_METADATA_BM25_LIMIT,
            accepts: acceptAll,
        }).map(({ symbol }) => symbol.name);
    assert.deepEqual(rankNames(fixture.registry, "manifest-a"), ["checkLegality"]);
    const request = {
        registry: fixture.registry, registryManifestHash: "manifest-a", query: "legality",
        limit: SYMBOL_METADATA_BM25_LIMIT, accepts: acceptAll,
    };
    assert.deepEqual(rankSymbolMetadataBm25(request),
        rankSymbolMetadataBm25({ ...request, registry: { ...fixture.registry } }));

    // Publish onto the same registry object: a new symbol and its manifest
    // entry. A missing manifest-hash check would keep serving the stale
    // corpus built for the old hash and hide the new symbol.
    const reportSource = "export function legalityReport() { return 1; }";
    const reportHash = sha256(reportSource);
    fixture.registry.manifest.files.push({
        path: "src/b.ts",
        hash: reportHash,
        language: "typescript",
        symbolCount: 1,
        definitionStatus: "definitions_present",
    });
    fixture.registry.symbols.push({
        symbolKey: "key-new",
        symbolInstanceId: "instance-new",
        language: "typescript",
        kind: "function",
        name: "legalityReport",
        qualifiedName: "legalityReport",
        label: "function legalityReport",
        file: "src/b.ts",
        span: { startLine: 1, endLine: 1 },
        parentQualifiedNamePath: [],
        fileHash: reportHash,
        extractorVersion: "fixture",
    });
    assert.deepEqual(rankNames(fixture.registry, "manifest-b"), ["checkLegality", "legalityReport"]);

    // Object identity still isolates publications: a different registry
    // object under its own hash never sees the mutated object's symbols.
    const other = buildFixture([
        { path: "src/a.ts", source: "export {};", symbols: [{ name: "checkLegality" }] },
    ]);
    assert.deepEqual(rankNames(other.registry, "manifest-b"), ["checkLegality"]);
});

test("cancellation propagates instead of returning an empty success", async () => {
    const { registry, readSourceEvidence } = buildFixture([
        { path: "src/a.ts", source: "function checkLegality() { return true; }", symbols: [{ name: "checkLegality" }] },
    ]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        retrieveSymbolMetadataBm25Candidates({
            registry,
            registryManifestHash: "manifest-a",
            query: "legality",
            codebaseRoot: "/repo",
            accepts: acceptAll,
            signal: controller.signal,
            readSourceEvidence,
        }),
    );
});
