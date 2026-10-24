import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { supplementSearchFileSymbols } from "./search-file-symbol-supplement.js";
import { buildSearchQueryPlan } from "./search-query-planning.js";

function fixture(source: string, names: string[], file = "src/owner.ts") {
    const hash = crypto.createHash("sha256").update(source).digest("hex");
    const lines = source.split("\n");
    const symbols: SymbolRecord[] = names.map((name, index) => ({
        symbolKey: `key-${index}`, symbolInstanceId: `instance-${index}`,
        file, fileHash: hash, name, qualifiedName: name, label: `function ${name}`,
        language: "typescript", kind: "function", parentQualifiedNamePath: [],
        extractorVersion: "fixture", span: { startLine: index + 1, endLine: index + 1 },
    }));
    const registry = {
        manifest: { files: [{ path: file, hash }] },
        symbolsByFile: new Map([[file, symbols]]),
    } as unknown as SymbolRegistry;
    const reader = async (_root: string, relativeFile: string) => ({
        canonicalRoot: "/repo", relativeFile, source,
        sourceBytes: Buffer.from(source), observedHash: hash,
    });
    return { file, symbols, registry, reader, lines };
}

test("retrieved file evidence recovers the comparator and preserves exact registry ownership", async () => {
    const f = fixture([
        "function useEffect() { return updateEffect(); }",
        "function areHookInputsEqual() { if(ignorePreviousDependencies) return false; /* comparing lengths */ return true; }",
    ].join("\n"), ["useEffect", "areHookInputsEqual"]);
    const results = await supplementSearchFileSymbols({
        candidates: [{ relativePath: f.file, ownerSymbolInstanceId: f.symbols[0].symbolInstanceId }],
        lexicalTerms: buildSearchQueryPlan("where are useEffect dependencies compared", true).lexicalTerms,
        registry: f.registry, codebaseRoot: "/repo", readSourceEvidence: f.reader,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].ownerSymbolInstanceId, f.symbols[1].symbolInstanceId);
    assert.equal(results[0].startLine, 2);
    assert.equal(results[0].content, f.lines[1]);
});

test("a whole file candidate supplies PNG implementation symbols rather than becoming a function", async () => {
    const f = fixture([
        "const exportToBlob = () => { const mimeType = MIME_TYPES.png; return canvas.export(); };",
        "const exportToSvg = () => svg.serialize();",
    ].join("\n"), ["exportToBlob", "exportToSvg"], "packages/utils/src/export.ts");
    const original = { relativePath: f.file, startLine: 1, endLine: 2, symbolKind: "file" };
    const results = await supplementSearchFileSymbols({
        candidates: [original], lexicalTerms: buildSearchQueryPlan("where does the drawing export as PNG", true).lexicalTerms,
        registry: f.registry, codebaseRoot: "/repo", readSourceEvidence: f.reader,
    });
    assert.deepEqual(results.map((result) => result.symbolLabel), ["function exportToBlob"]);
    assert.equal(original.symbolKind, "file");
});

test("table emission is recovered independently of a generator declaration", async () => {
    const f = fixture([
        "void RegisterCodeGenerator() { registry.add(generator); }",
        "void GenTable() { code += table; }",
    ].join("\n"), ["RegisterCodeGenerator", "GenTable"], "src/idl_gen_cpp.cpp");
    const results = await supplementSearchFileSymbols({
        candidates: [{ relativePath: f.file }],
        lexicalTerms: buildSearchQueryPlan("where does the C++ generator emit code for a table", true).lexicalTerms,
        registry: f.registry, codebaseRoot: "/repo", readSourceEvidence: f.reader,
    });
    assert.ok(results.some((result) => result.symbolLabel === "function GenTable"));
});

test("source mismatch fails closed and file names alone cannot supply relevance", async () => {
    const f = fixture("function run() { return 1; }", ["run"], "src/table_generator.ts");
    const input = { candidates: [{ relativePath: f.file }], registry: f.registry,
        codebaseRoot: "/repo", lexicalTerms: buildSearchQueryPlan("table generator", true).lexicalTerms };
    assert.deepEqual(await supplementSearchFileSymbols({ ...input, readSourceEvidence: f.reader }), []);
    assert.deepEqual(await supplementSearchFileSymbols({
        ...input, lexicalTerms: buildSearchQueryPlan("run return", true).lexicalTerms,
        readSourceEvidence: async (...args) => ({ ...await f.reader(...args), observedHash: "changed" }),
    }), []);
});

test("partial chunks recover complete evidence and existing complete symbols retain their candidate identity", async () => {
    const f = fixture("function emitTable() {\n  return table.code; }", ["emitTable"]);
    f.symbols[0].span.endLine = 2;
    const input = { registry: f.registry, codebaseRoot: "/repo", readSourceEvidence: f.reader,
        lexicalTerms: buildSearchQueryPlan("emit code for a table", true).lexicalTerms };
    assert.equal((await supplementSearchFileSymbols({ ...input, candidates: [{ relativePath: f.file,
        ownerSymbolInstanceId: f.symbols[0].symbolInstanceId, startLine: 2, endLine: 2 }] })).length, 1);
    const complete = { relativePath: f.file,
        ownerSymbolInstanceId: f.symbols[0].symbolInstanceId, startLine: 1, endLine: 2 };
    const preferred = await supplementSearchFileSymbols({ ...input, candidates: [complete] });
    assert.equal(preferred.length, 1);
    assert.equal(preferred[0], complete);
});

test("repeated wrapper declarations cannot crowd an earlier equally matching implementation file out of refinement", async () => {
    const implementation = fixture("function exportToBlob() { return image.png; }", ["exportToBlob"], "src/export.ts");
    const wrappers = [1, 2, 3].map((index) => fixture([
        "function exportOne() { return image; }",
        "function exportTwo() { return image; }",
    ].join("\n"), ["exportOne", "exportTwo"], `src/wrappers${index}.ts`));
    const files = [implementation, ...wrappers];
    const registry = {
        manifest: { files: files.flatMap((file) => file.registry.manifest.files) },
        symbolsByFile: new Map(files.map((file) => [file.file, file.symbols])),
    } as unknown as SymbolRegistry;
    const reads: string[] = [];
    const results = await supplementSearchFileSymbols({
        candidates: files.map((file) => ({ relativePath: file.file })),
        lexicalTerms: buildSearchQueryPlan("export image as PNG", true).lexicalTerms,
        registry, codebaseRoot: "/repo",
        readSourceEvidence: async (root, file) => {
            reads.push(file);
            return files.find((entry) => entry.file === file)!.reader(root, file);
        },
    });
    assert.equal(reads.length, 4);
    assert.equal(reads[0], implementation.file);
    assert.ok(results.some((result) => result.relativePath === implementation.file));
});

test("the declaration lane retains a generator implementation below the retrieved file window", async () => {
    const noise = Array.from({ length: 16 }, (_, index) => fixture("function run() { return 1; }", ["run"], `src/noise${index}.ts`));
    const generator = fixture("void GenTable() { code += table; }", ["GenTable"], "src/idl_gen_cpp.cpp");
    const files = [...noise, generator];
    const registry = { manifest: { files: files.flatMap((file) => file.registry.manifest.files) },
        symbolsByFile: new Map(files.map((file) => [file.file, file.symbols])) } as unknown as SymbolRegistry;
    const reads: string[] = [];
    const results = await supplementSearchFileSymbols({
        candidates: files.map((file) => ({ relativePath: file.file })),
        lexicalTerms: buildSearchQueryPlan("where does the C++ generator emit code for a table", true).lexicalTerms,
        registry, codebaseRoot: "/repo", readSourceEvidence: async (root, file) => {
            reads.push(file);
            return files.find((entry) => entry.file === file)!.reader(root, file);
        },
    });
    assert.ok(reads.length <= 6);
    assert.ok(results.some((result) => result.relativePath === generator.file && result.symbolLabel === "function GenTable"));
});

async function supplementFixtures(files: ReturnType<typeof fixture>[], query: string,
    candidates = files.map((file) => ({ relativePath: file.file }))) {
    const registry = { manifest: { files: files.flatMap((file) => file.registry.manifest.files) },
        symbolsByFile: new Map(files.map((file) => [file.file, file.symbols])) } as unknown as SymbolRegistry;
    const reads: string[] = [];
    const results = await supplementSearchFileSymbols({
        candidates, lexicalTerms: buildSearchQueryPlan(query, true).lexicalTerms,
        registry, codebaseRoot: "/repo", readSourceEvidence: async (root, file) => {
            reads.push(file);
            return files.find((entry) => entry.file === file)!.reader(root, file);
        },
    });
    return { results, reads };
}

test("path context admits an exact source-only owner below both old file windows", async () => {
    const noise = Array.from({ length: 7 }, (_, index) => fixture(
        "function encodeRecord() { return record; }", ["encodeRecord"], `src/noise${index}.ts`));
    const owner = fixture("function create() { return payload; }", ["create"], "src/record/encoder.ts");
    const { results, reads } = await supplementFixtures([...noise, owner], "record encoder payload");
    assert.deepEqual(reads.slice(0, 3), noise.slice(0, 3).map((file) => file.file));
    assert.ok(reads.length <= 6);
    assert.equal(results.length, 1);
    assert.equal(results[0].ownerSymbolInstanceId, owner.symbols[0].symbolInstanceId);
    assert.equal(results[0].relativePath, owner.file);
    assert.equal(results[0].startLine, 1);
    assert.equal(results[0].endLine, 1);
    assert.deepEqual(owner.symbols[0].parentQualifiedNamePath, []);
});

test("context does not admit one-term name evidence or path-only source evidence", async () => {
    const owner = fixture("return 1;\nreturn record;", ["payload", "create"], "src/record/encoder.ts");
    const { results } = await supplementFixtures([owner], "record encoder payload");
    assert.deepEqual(results, []);
    const withoutContext = fixture("return payload;", ["create"], "src/record.ts");
    assert.deepEqual((await supplementFixtures([withoutContext], "record encoder payload")).results, []);
});

test("stronger symbols precede source-only matches and preserve full-span identity", async () => {
    const names = [...Array.from({ length: 11 }, (_, index) => `entry${index}`), "create"];
    const owner = fixture(names.map((_, index) => index < 11
        ? "return payload + record;" : "return payload;").join("\n"), names, "src/record/encoder.ts");
    const complete = { relativePath: owner.file, ownerSymbolInstanceId: owner.symbols[11].symbolInstanceId,
        startLine: 12, endLine: 12, content: "original payload", symbolLabel: "original label" };
    const { results, reads } = await supplementFixtures([owner], "record encoder payload", [complete]);
    assert.deepEqual(results.slice(0, 6).map((result) => result.startLine), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(results.map((result) => result.startLine), Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal(results[11], complete);
    assert.equal(reads.length, 1);
});

test("recovery returns all eligible symbols without per-file or total count quotas", async () => {
    const names = Array.from({ length: 60 }, (_, index) => `entry${index}`);
    const files = ["src/record/encoder-a.ts", "src/record/encoder-b.ts", "src/plain.ts"]
        .map((file) => fixture(names.map(() => "return payload + record;").join("\n"), names, file));
    const { results, reads } = await supplementFixtures(files, "record encoder payload");
    assert.equal(results.length, 180);
    assert.equal(reads.length, 3);
    assert.deepEqual(results.map((result) => [result.relativePath, result.startLine]),
        files.flatMap((file) => names.map((_, index) => [file.file, index + 1])));
});

test("declaration overlap cannot consume the additional file budget", async () => {
    const retrieved = ["src/emit_code_table.ts", "src/emit_code_table_cache.ts", "src/emit_code_table_writer.ts"]
        .map((file) => fixture("function emitCodeTable() { return code + table; }", ["emitCodeTable"], file));
    const generator = fixture("void GenTable() { code += table; }", ["GenTable"], "src/idl_gen_cpp.cpp");
    const files = [...retrieved, generator];
    for (const file of files) {
        file.symbols.forEach((symbol, index) => {
            symbol.symbolInstanceId = `${file.file}#${index}`;
        });
    }
    const { results, reads } = await supplementFixtures(files, "where does the C++ generator emit code for a table");
    assert.equal(results.length, 1);
    const [table] = results;
    assert.equal(table.relativePath, generator.file);
    assert.equal(table.ownerSymbolInstanceId, generator.symbols[0].symbolInstanceId);
    assert.equal(table.startLine, 1);
    assert.equal(table.endLine, 1);
    assert.equal(table.content, generator.lines[0]);
    assert.deepEqual(reads, files.map((file) => file.file));
    assert.equal(new Set(reads).size, reads.length);
    assert.ok(reads.length <= 6);
});

test("disjoint declaration files keep retrieval-lane selection and output unchanged", async () => {
    const retrieved = [0, 1, 2].map((index) => fixture("function run() { return 1; }", ["run"], `src/retrieved${index}.ts`));
    const declarations = [
        fixture("void GenTable() { code += table; }", ["GenTable"], "src/idl_gen_cpp.cpp"),
        fixture("function emitCode() { return table; }", ["emitCode"], "src/idl_gen_code.ts"),
        fixture("function generateTable() { return code; }", ["generateTable"], "src/table_emitter.ts"),
    ];
    const files = [...retrieved, ...declarations];
    for (const file of files) {
        file.symbols.forEach((symbol, index) => {
            symbol.symbolInstanceId = `${file.file}#${index}`;
        });
    }
    const { results, reads } = await supplementFixtures(files, "where does the C++ generator emit code for a table");
    assert.deepEqual(reads, files.map((file) => file.file));
    assert.equal(new Set(reads).size, reads.length);
    assert.ok(reads.length <= 6);
    assert.deepEqual(results.map((result) => [result.relativePath, result.ownerSymbolInstanceId,
        result.startLine, result.endLine]),
    declarations.map((file) => [file.file, file.symbols[0].symbolInstanceId, 1, 1]));
});
