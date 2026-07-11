import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildSymbolRecordsForFile,
    createLanguageAnalysisService,
    type LanguageAnalysisPort,
    type SymbolRecord,
} from "@zokizuan/satori-core";
import { validateCurrentSourceSymbolSpans } from "./current-source-symbols.js";

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
    const delegate = createLanguageAnalysisService();
    const languageAnalyzer: LanguageAnalysisPort = {
        ...delegate,
        analyze: async () => {
            throw new Error("forced parser failure");
        },
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
