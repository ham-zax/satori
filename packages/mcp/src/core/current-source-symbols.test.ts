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
} from "@satori-code/core";
import {
    mapPublishedSymbolsToCurrentSpans,
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

async function buildRegistryRecords(input: {
    relativeFile: string;
    language: string;
    content: string;
    extractorVersion?: string;
}): Promise<SymbolRecord[]> {
    const analysis = await createLanguageAnalysisService({
        chunkSize: Number.MAX_SAFE_INTEGER,
        chunkOverlap: 0,
    }).analyze({ content: input.content, language: input.language, relativePath: input.relativeFile });
    return buildSymbolRecordsForFile({
        relativePath: input.relativeFile,
        language: input.language,
        content: input.content,
        fileHash: crypto.createHash("sha256").update(Buffer.from(input.content, "utf8")).digest("hex"),
        extractorVersion: input.extractorVersion ?? "test-extractor-v1",
        chunks: [...analysis.chunks],
        extractedSymbols: analysis.symbols,
    });
}

function rawBytesHash(content: string): string {
    return crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
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
            receiverTypeBindings: [],
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

test("current-source validation matches symbols from a CBM-extracted language", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-source-kotlin-"));
    const relativeFile = "src/Registry.kt";
    const source = "package shop\n\nclass Registry {\n    fun add(item: String) { println(item) }\n}\n\nfun total(): Int = 1\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);
    try {
        const analysis = await createLanguageAnalysisService().analyze({ content: source, language: "kotlin", relativePath: relativeFile });
        assert.equal(analysis.backend, "cbm_definitions");
        const persisted = buildSymbolRecordsForFile({
            relativePath: relativeFile,
            language: "kotlin",
            content: source,
            fileHash: crypto.createHash("sha256").update(source).digest("hex"),
            extractorVersion: "test-extractor-v1",
            chunks: [...analysis.chunks],
            extractedSymbols: analysis.symbols,
        }).filter((symbol) => symbol.kind !== "file");
        assert.deepEqual(persisted.map((symbol) => symbol.qualifiedName), ["Registry", "Registry.add", "total"]);
        const results = await validateCurrentSourceSymbolSpans({ codebaseRoot: root, symbols: persisted });
        assert.deepEqual(results.map((result) => result.match), ["matched", "matched", "matched"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-span mapping publishes a span only for a matched declaration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-span-match-"));
    const relativeFile = "src/runtime.py";
    const source = "def target():\n    return 1\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);
    try {
        const persisted = (await buildRegistryRecords({ relativeFile, language: "python", content: source }))
            .filter((symbol) => symbol.kind !== "file");
        const target = persisted.find((symbol) => symbol.name === "target");
        assert.ok(target);

        const matched = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        assert.equal(matched.mappings.size, 1);
        const mapping = matched.mappings.get(target.symbolInstanceId);
        assert.ok(mapping);
        assert.deepEqual(mapping.span, target.span);
        assert.equal(mapping.currentSourceHash, rawBytesHash(source));
        assert.equal(matched.currentSourceHash, mapping.currentSourceHash);
        assert.equal(mapping.resolutionEvidence.resolutionDerivation, "exact_registry_rebuild_match");

        // A renamed declaration has no current counterpart.
        fs.writeFileSync(path.join(root, relativeFile), "def renamed():\n    return 1\n");
        const missing = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        assert.equal(missing.mappings.size, 0);

        // A second same-key declaration leaves the correspondence ambiguous.
        fs.writeFileSync(path.join(root, relativeFile), "def target():\n    return 1\n\n\ndef target():\n    return 2\n");
        const ambiguous = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        assert.equal(ambiguous.mappings.size, 0);

        // A syntax error leaves the current declaration unverified.
        fs.writeFileSync(path.join(root, relativeFile), "def target(:\n    return 1\n");
        const unavailable = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        assert.equal(unavailable.mappings.size, 0);

        // A language without a structural strategy has no current declaration.
        const textFile = "src/notes.txt";
        fs.writeFileSync(path.join(root, textFile), "plain text\n");
        const notApplicable = await mapPublishedSymbolsToCurrentSpans({
            codebaseRoot: root,
            symbols: [{
                ...target,
                symbolKey: "text_key",
                symbolInstanceId: "text_instance",
                language: "text",
                file: textFile,
            }],
        });
        assert.equal(notApplicable.mappings.size, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a second edit invalidates the current-span mapping", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-span-second-edit-"));
    const relativeFile = "src/runtime.py";
    const publishedSource = "def target():\n    return 1\n";
    const firstEdit = "# first edit\n" + publishedSource;
    const secondEdit = "# first edit\n# second edit\n" + publishedSource;
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), publishedSource);
    try {
        const persisted = (await buildRegistryRecords({ relativeFile, language: "python", content: publishedSource }))
            .filter((symbol) => symbol.kind !== "file");
        const target = persisted.find((symbol) => symbol.name === "target");
        assert.ok(target);

        fs.writeFileSync(path.join(root, relativeFile), firstEdit);
        const first = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        const firstMapping = first.mappings.get(target.symbolInstanceId);
        assert.ok(firstMapping);
        assert.equal(firstMapping.span.startLine, 2);
        assert.equal(firstMapping.currentSourceHash, rawBytesHash(firstEdit));

        fs.writeFileSync(path.join(root, relativeFile), secondEdit);
        const second = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        const secondMapping = second.mappings.get(target.symbolInstanceId);
        assert.ok(secondMapping);
        assert.notEqual(secondMapping.currentSourceHash, firstMapping.currentSourceHash);
        assert.equal(secondMapping.currentSourceHash, rawBytesHash(secondEdit));
        assert.equal(secondMapping.span.startLine, 3);
        assert.notDeepEqual(secondMapping.span, firstMapping.span);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a renamed or deleted declaration yields no current span", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-span-renamed-"));
    const relativeFile = "src/runtime.py";
    const source = "def target():\n    return 1\n\ndef other():\n    return 2\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);
    try {
        const persisted = (await buildRegistryRecords({ relativeFile, language: "python", content: source }))
            .filter((symbol) => symbol.kind !== "file");
        const target = persisted.find((symbol) => symbol.name === "target");
        assert.ok(target);

        fs.writeFileSync(path.join(root, relativeFile), source.replace("target", "renamed"));
        const renamed = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        assert.equal(renamed.mappings.size, 0);
        assert.equal(renamed.mappings.has(target.symbolInstanceId), false);

        fs.writeFileSync(path.join(root, relativeFile), "def other():\n    return 2\n");
        const deleted = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        assert.equal(deleted.mappings.size, 0);
        assert.equal(deleted.mappings.has(target.symbolInstanceId), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("current-span mapping proves a TypeScript declaration in the current bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-current-span-typescript-"));
    const relativeFile = "src/runtime.ts";
    const publishedSource = "export function target() {\n  return 1;\n}\n";
    const currentSource = "// inserted\nexport function target() {\n  return 2;\n}\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), currentSource);
    try {
        const persisted = (await buildRegistryRecords({ relativeFile, language: "typescript", content: publishedSource }))
            .filter((symbol) => symbol.kind !== "file");
        const target = persisted.find((symbol) => symbol.name === "target");
        assert.ok(target);
        assert.equal(target.span.startLine, 1);

        const mapping = await mapPublishedSymbolsToCurrentSpans({ codebaseRoot: root, symbols: [target] });
        assert.equal(mapping.mappings.size, 1);
        const current = mapping.mappings.get(target.symbolInstanceId);
        assert.ok(current);
        assert.equal(current.span.startLine, 2);
        assert.equal(current.currentSourceHash, rawBytesHash(currentSource));
        assert.equal(current.span.endLine, 4);
        assert.notEqual(current.span.startByte, target.span.startByte);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
