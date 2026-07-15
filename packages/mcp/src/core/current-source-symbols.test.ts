import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildSymbolRecordsForFile,
    createLanguageAnalysisService,
    withSourceMeasurementOperation,
    type LanguageAnalysisPort,
    type SymbolRecord,
} from "@zokizuan/satori-core";
import {
    readHashMatchedCurrentSourceSymbolContent,
    readCurrentSourceEvidence,
    sliceHashMatchedCurrentSourceSymbolContent,
    validateCurrentSourceSymbolSpans,
} from "./current-source-symbols.js";

function testSymbol(file = "src/runtime.ts"): SymbolRecord {
    return {
        symbolKey: "symkey_current_owner",
        symbolInstanceId: "syminst_current_owner",
        language: "typescript",
        kind: "function",
        name: "currentOwner",
        qualifiedName: "currentOwner",
        label: "function currentOwner()",
        file,
        span: { startLine: 1, endLine: 1 },
        parentQualifiedNamePath: [],
        fileHash: "test-file-hash",
        extractorVersion: "test-extractor-v1",
    };
}

test("current-source validation fails closed when the file cannot be opened", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-unavailable-"));
    try {
        const [result] = await validateCurrentSourceSymbolSpans({
            codebaseRoot: root,
            symbols: [testSymbol()],
        });
        assert.equal(result.match, "unavailable");
        assert.equal(result.validated, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source validation fails closed when parsing throws", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-parser-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "runtime.ts"), "function currentOwner() { return true; }\n");
    const ledgerFile = path.join(root, "source-ledger.jsonl");
    const delegate = createLanguageAnalysisService();
    const languageAnalyzer: LanguageAnalysisPort = {
        ...delegate,
        analyze: async () => {
            throw new Error("forced parser failure");
        },
    };
    try {
        const [result] = await withSourceMeasurementOperation({
            operation: "file_outline",
            ledgerFile,
            rootDir: root,
        }, () => validateCurrentSourceSymbolSpans({
            codebaseRoot: root,
            symbols: [testSymbol()],
            languageAnalyzer,
        }));
        assert.equal(result.match, "unavailable");
        assert.equal(result.validated, false);
        const records = fs.readFileSync(ledgerFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const parser = records.find((record) => (
            record.kind === "source_processing" && record.owner === "parser"
        ));
        assert.equal(parser?.outcome, "failed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source validation rejects non-throwing parser fallback evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-fallback-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "runtime.ts"), "function currentOwner() { return true; }\n");
    const delegate = createLanguageAnalysisService();
    const languageAnalyzer: LanguageAnalysisPort = {
        ...delegate,
        analyze: async () => ({
            backend: "oxc",
            structuralStatus: "recovered",
            structuralReason: "syntax_error",
            symbols: [],
            moduleBindings: [],
            callSites: [],
            chunks: [],
        }),
    };
    try {
        const [result] = await validateCurrentSourceSymbolSpans({
            codebaseRoot: root,
            symbols: [testSymbol()],
            languageAnalyzer,
        });
        assert.equal(result.match, "unavailable");
        assert.equal(result.validated, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source validation rejects syntax-error recovery as absence proof", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-syntax-error-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "runtime.ts"), "function currentOwner( {\n");
    try {
        const [result] = await validateCurrentSourceSymbolSpans({ codebaseRoot: root, symbols: [testSymbol()] });
        assert.equal(result.match, "unavailable");
        assert.equal(result.validated, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source validation preserves same-key declarations on one line", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-same-line-"));
    const relativeFile = "src/runtime.ts";
    const source = "function duplicate() {} function duplicate() {}\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);
    try {
        const analysis = await createLanguageAnalysisService({
            chunkSize: Number.MAX_SAFE_INTEGER,
            chunkOverlap: 0,
        }).analyze({ content: source, language: "typescript", relativePath: relativeFile });
        const fileHash = crypto.createHash("sha256").update(source).digest("hex");
        const persisted = buildSymbolRecordsForFile({
            relativePath: relativeFile,
            language: "typescript",
            content: source,
            fileHash,
            extractorVersion: "test-extractor-v1",
            chunks: [...analysis.chunks],
            extractedSymbols: analysis.symbols,
        }).filter((symbol) => symbol.kind !== "file" && symbol.name === "duplicate");
        assert.equal(persisted.length, 2);

        const expectedStartById = new Map(persisted.map((symbol) => [symbol.symbolInstanceId, symbol.span.startByte]));
        const results = await validateCurrentSourceSymbolSpans({ codebaseRoot: root, symbols: [...persisted].reverse() });
        assert.deepEqual(results.map((result) => result.match), ["matched", "matched"]);
        for (const result of results) {
            assert.equal(result.symbol.span.startByte, expectedStartById.get(result.symbol.symbolInstanceId));
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source span repair publishes recomputed byte and column coordinates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-coordinates-"));
    const relativeFile = "src/runtime.ts";
    const indexedSource = "function currentOwner() {\n  return false;\n}\n";
    const currentSource = "// inserted before the symbol\nfunction currentOwner() {\n  return true;\n}\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), currentSource);

    const buildRecords = async (content: string): Promise<SymbolRecord[]> => {
        const analysis = await createLanguageAnalysisService({
            chunkSize: Number.MAX_SAFE_INTEGER,
            chunkOverlap: 0,
        }).analyze({ content, language: "typescript", relativePath: relativeFile });
        return buildSymbolRecordsForFile({
            relativePath: relativeFile,
            language: "typescript",
            content,
            fileHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
            extractorVersion: "test-extractor-v1",
            chunks: [...analysis.chunks],
            extractedSymbols: analysis.symbols,
        });
    };

    try {
        const persisted = (await buildRecords(indexedSource)).find((entry) => entry.name === "currentOwner");
        const expectedCurrent = (await buildRecords(currentSource)).find((entry) => entry.name === "currentOwner");
        assert.ok(persisted);
        assert.ok(expectedCurrent);
        const [result] = await validateCurrentSourceSymbolSpans({
            codebaseRoot: root,
            symbols: [persisted],
        });
        assert.equal(result.match, "matched");
        assert.equal(result.repaired, true);
        assert.deepEqual(result.symbol.span, expectedCurrent.span);
        assert.notEqual(result.symbol.span.startByte, persisted.span.startByte);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source validation bounds exact source reads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-large-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "runtime.ts"), `function currentOwner() {}\n${" ".repeat(256 * 1024)}`);
    try {
        const [result] = await validateCurrentSourceSymbolSpans({ codebaseRoot: root, symbols: [testSymbol()] });
        assert.equal(result.match, "unavailable");
        assert.equal(result.validated, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("hash-matched current-source content is restricted to the exact symbol span", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-preview-"));
    const relativeFile = "src/runtime.ts";
    const source = [
        "const unrelatedBefore = true;",
        "export function currentOwner() {",
        "  return 'current';",
        "}",
        "const unrelatedAfter = true;",
    ].join("\n");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);
    try {
        const content = await readHashMatchedCurrentSourceSymbolContent({
            codebaseRoot: root,
            symbol: {
                ...testSymbol(relativeFile),
                fileHash: crypto.createHash("sha256").update(source, "utf8").digest("hex"),
                span: { startLine: 2, endLine: 4 },
            },
        });
        assert.equal(content, [
            "export function currentOwner() {",
            "  return 'current';",
            "}",
        ].join("\n"));
        assert.doesNotMatch(content || "", /unrelated/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source content is omitted when the durable file hash does not match", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-preview-stale-"));
    const relativeFile = "src/runtime.ts";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), "export function currentOwner() { return false; }\n");
    try {
        const content = await readHashMatchedCurrentSourceSymbolContent({
            codebaseRoot: root,
            symbol: {
                ...testSymbol(relativeFile),
                fileHash: "0".repeat(64),
                span: { startLine: 1, endLine: 1 },
            },
        });
        assert.equal(content, undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("descriptor-bound source evidence can be reused without reopening the file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-evidence-"));
    const relativeFile = "src/runtime.ts";
    const source = "export function currentOwner() {\n  return true;\n}\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);
    try {
        const evidence = await readCurrentSourceEvidence(root, relativeFile);
        assert.ok(evidence);
        fs.rmSync(path.join(root, relativeFile));
        assert.equal(sliceHashMatchedCurrentSourceSymbolContent(evidence, root, {
            ...testSymbol(relativeFile),
            fileHash: evidence.observedHash,
            span: { startLine: 1, endLine: 3 },
        }), "export function currentOwner() {\n  return true;\n}");
        assert.equal(sliceHashMatchedCurrentSourceSymbolContent(evidence, path.join(root, "other-root"), {
            ...testSymbol(relativeFile),
            fileHash: evidence.observedHash,
            span: { startLine: 1, endLine: 3 },
        }), undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source evidence hashes the exact descriptor bytes before UTF-8 decoding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-byte-hash-"));
    const relativeFile = "src/malformed.ts";
    const sourceBytes = Buffer.from([0x66, 0x6f, 0x80, 0x6f, 0x0a]);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), sourceBytes);
    try {
        const evidence = await readCurrentSourceEvidence(root, relativeFile);
        assert.ok(evidence);
        assert.equal(
            evidence.observedHash,
            crypto.createHash("sha256").update(sourceBytes).digest("hex"),
        );
        assert.notEqual(
            evidence.observedHash,
            crypto.createHash("sha256").update(evidence.source, "utf8").digest("hex"),
        );
        assert.deepEqual(Buffer.from(evidence.sourceBytes), sourceBytes);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-source selector records a rejected outcome after consuming an invalid range", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-selector-"));
    const relativeFile = "src/runtime.ts";
    const source = "export function currentOwner() { return true; }\n";
    const ledgerFile = path.join(root, "source-ledger.jsonl");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);

    try {
        await withSourceMeasurementOperation({
            operation: "read_file",
            ledgerFile,
            rootDir: root,
        }, async () => {
            const evidence = await readCurrentSourceEvidence(root, relativeFile);
            assert.ok(evidence);
            assert.equal(sliceHashMatchedCurrentSourceSymbolContent(evidence, root, {
                ...testSymbol(relativeFile),
                fileHash: evidence.observedHash,
                span: { startLine: 1, endLine: 3 },
            }), undefined);
        });

        const records = fs.readFileSync(ledgerFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const selector = records.find((record) => (
            record.kind === "source_processing" && record.owner === "selector"
        ));
        assert.equal(selector?.outcome, "rejected");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
