import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSymbolRecordsForFile, createLanguageAnalysisService } from "@satori-code/core";
import { buildRegistryFileOutlinePayload, fitFileOutlineResponseBudget } from "./registry-file-outline.js";
import { mapPublishedSymbolsToCurrentSpans } from "./current-source-symbols.js";
import type { FileOutlineResponseEnvelope, FileOutlineSymbolResult } from "./search-types.js";

function outlinePayload(symbolCount: number): FileOutlineResponseEnvelope {
    const symbols = Array.from({ length: symbolCount }, (_, index) => ({
        symbolId: `sym_${index}`,
        symbolLabel: `function f${index}()`,
        span: { startLine: index * 10 + 1, endLine: index * 10 + 9 },
        callGraphHint: { supported: true, symbolRef: { file: "src/a.ts", symbolId: `sym_${index}` } },
        padding: "x".repeat(400),
    })) as unknown as FileOutlineSymbolResult[];
    return { status: "ok", path: "/repo", file: "src/a.ts", outline: { symbols }, hasMore: false };
}

const stringify = (payload: FileOutlineResponseEnvelope) => JSON.stringify(payload);

test("file outline keeps the longest symbol prefix within the byte budget and continues from the first omitted symbol", () => {
    const maxResponseBytes = 8 * 1024;
    const payload = outlinePayload(100);
    assert.ok(Buffer.byteLength(stringify(payload)) > maxResponseBytes);

    const fitted = fitFileOutlineResponseBudget({
        payload,
        maxResponseBytes,
        continuationArgs: { path: "/repo", file: "src/a.ts", detail: "summary" },
        stringify,
    });

    const kept = fitted.outline!.symbols.length;
    assert.ok(kept > 0 && kept < 100);
    assert.ok(Buffer.byteLength(stringify(fitted)) <= maxResponseBytes);
    assert.equal(fitted.hasMore, true);
    assert.deepEqual(fitted.warnings, ["OUTLINE_RESPONSE_BYTE_LIMIT"]);
    assert.deepEqual(fitted.hints?.nextPage, {
        tool: "file_outline",
        args: { path: "/repo", file: "src/a.ts", detail: "summary", start_line: kept * 10 + 1 },
    });

    // One more symbol would exceed the budget, so the prefix is maximal.
    const oneMore = { ...fitted, outline: { symbols: payload.outline!.symbols.slice(0, kept + 1) } };
    assert.ok(Buffer.byteLength(stringify(oneMore)) > maxResponseBytes);

    const unchanged = outlinePayload(3);
    assert.equal(fitFileOutlineResponseBudget({
        payload: unchanged,
        maxResponseBytes,
        continuationArgs: {},
        stringify,
    }), unchanged);
});

function symbolRecord(name: string, kind: string, startLine: number, endLine: number, parentKey?: string) {
    return {
        symbolKey: `key_${name}`,
        symbolInstanceId: `inst_${name}`,
        language: "typescript",
        kind,
        name,
        qualifiedName: parentKey ? `C.${name}` : name,
        label: name,
        file: "src/a.ts",
        span: { startLine, startCol: 1, endLine, endCol: 1 },
        ...(parentKey ? { parentKey } : {}),
        parentQualifiedNamePath: parentKey ? ["C"] : [],
        fileHash: "hash",
        extractorVersion: "test",
    };
}

async function limitedOutline(windowStart?: number) {
    return buildRegistryFileOutlinePayload({
        codebaseRoot: "/repo",
        file: "src/a.ts",
        symbols: [
            symbolRecord("C", "class", 1, 30),
            symbolRecord("first", "method", 5, 9, "key_C"),
            symbolRecord("second", "method", 10, 14, "key_C"),
        ] as never,
        limitSymbols: 1,
        resolveMode: "outline",
        windowStart,
        continuationArgs: { path: "/repo", file: "src/a.ts", limitSymbols: 1 },
        buildCallGraphHint: () => ({ supported: false, reason: "test" }) as never,
        buildOutlineSpanWarningCodes: () => [],
        readSourceLines: async () => undefined,
    });
}

test("a limitSymbols walk reaches every symbol because enclosing repeats are not counted", async () => {
    const firstPage = await limitedOutline();
    assert.deepEqual(firstPage.outline?.symbols.map((symbol) => symbol.name), ["C"]);
    assert.deepEqual(firstPage.hints?.nextPage, {
        tool: "file_outline",
        args: { path: "/repo", file: "src/a.ts", limitSymbols: 1, start_line: 5 },
    });

    const secondPage = await limitedOutline(5);
    assert.deepEqual(secondPage.outline?.symbols.map((symbol) => symbol.name), ["C", "first"]);
    assert.deepEqual(secondPage.hints?.nextPage, {
        tool: "file_outline",
        args: { path: "/repo", file: "src/a.ts", limitSymbols: 1, start_line: 10 },
    });

    const lastPage = await limitedOutline(10);
    assert.deepEqual(lastPage.outline?.symbols.map((symbol) => symbol.name), ["C", "second"]);
    assert.equal(lastPage.hasMore, false);
    assert.equal(lastPage.hints, undefined);
});

test("a byte trim replaces a limitSymbols continuation that would skip trimmed symbols", () => {
    const payload = {
        ...outlinePayload(100),
        hasMore: true,
        hints: { nextPage: { tool: "file_outline", args: { start_line: 1001 } }, other: 1 },
    };
    const fitted = fitFileOutlineResponseBudget({
        payload,
        maxResponseBytes: 8 * 1024,
        continuationArgs: { path: "/repo" },
        requestedStartLine: 1_000_000,
        stringify,
    });
    assert.deepEqual(fitted.hints, { other: 1 });
});

test("exact mode returns every duplicate-label match so each symbolId can be used to narrow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "outline-exact-"));
    try {
        const source = "def dup():\n    return 1\n\n\ndef dup():\n    return 2\n";
        await writeFile(path.join(root, "dup.py"), source);
        const analysis = await createLanguageAnalysisService().analyze({
            content: source,
            language: "python",
            relativePath: "dup.py",
        });
        const records = buildSymbolRecordsForFile({
            relativePath: "dup.py",
            language: "python",
            content: source,
            fileHash: createHash("sha256").update(source).digest("hex"),
            extractorVersion: "test",
            chunks: [...analysis.chunks],
            extractedSymbols: analysis.symbols,
        });
        const payload = await buildRegistryFileOutlinePayload({
            codebaseRoot: root,
            file: "dup.py",
            symbols: records,
            limitSymbols: 1,
            resolveMode: "exact",
            symbolLabelExact: "function dup",
            buildCallGraphHint: () => ({ supported: false, reason: "test" }) as never,
            buildOutlineSpanWarningCodes: () => [],
            readSourceLines: async () => undefined,
        });

        assert.equal(payload.status, "ambiguous");
        assert.equal(payload.hasMore, false);
        assert.equal(payload.outline?.symbols.length, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test("published outline coordinates survive inserted, renamed, and deleted Python source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "outline-published-"));
    try {
        const source = "def target():\n    return 1\n\ndef other():\n    return 2\n";
        const analysis = await createLanguageAnalysisService().analyze({ content: source, language: "python", relativePath: "seed.py" });
        const records = buildSymbolRecordsForFile({ relativePath: "seed.py", language: "python", content: source,
            fileHash: createHash("sha256").update(source).digest("hex"), extractorVersion: "test",
            chunks: [...analysis.chunks], extractedSymbols: analysis.symbols });
        const target = records.find(symbol => symbol.name === "target")!;
        for (const edited of ["# inserted\n".repeat(20) + source, source.replace("target", "renamed"), ""]) {
            await writeFile(path.join(root, "seed.py"), edited);
            for (const resolveMode of ["outline", "exact"] as const) {
                const payload = await buildRegistryFileOutlinePayload({ codebaseRoot: root, file: "seed.py", symbols: records,
                    publishedSpans: true, resolveMode, symbolIdExact: resolveMode === "exact" ? target.symbolInstanceId : undefined,
                    limitSymbols: 500, buildCallGraphHint: symbol => ({ supported: true, symbolRef: { file: symbol.file, symbolId: symbol.symbolInstanceId },
                        validated: true, validatedAt: "2026-10-20", relationshipBuiltAt: "2026-10-20" }),
                    buildOutlineSpanWarningCodes: () => [],
                    readSourceLines: async () => { throw new Error("published projection cannot read source"); } });
                assert.equal(payload.status, "ok");
                assert.deepEqual(payload.outline?.symbols.map(symbol => [symbol.symbolId, symbol.span]),
                    (resolveMode === "exact" ? [target] : records.filter(symbol => symbol.kind !== "file")).map(symbol => [symbol.symbolInstanceId, symbol.span]));
            }
        }
        const missing = await buildRegistryFileOutlinePayload({ codebaseRoot: root, file: "seed.py", symbols: records,
            publishedSpans: true, resolveMode: "exact", symbolIdExact: "missing", limitSymbols: 500,
            buildCallGraphHint: () => ({ supported: false, reason: "missing_symbol" }), buildOutlineSpanWarningCodes: () => [],
            readSourceLines: async () => { throw new Error("published projection cannot read source"); } });
        assert.equal(missing.status, "not_found");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the outline attaches a current span only where a current declaration was proven", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "outline-current-span-"));
    try {
        const publishedSource = "def target():\n    return 1\n\ndef other():\n    return 2\n";
        const currentSource = "# inserted\ndef target():\n    return 1\n\ndef renamed():\n    return 2\n";
        const analysis = await createLanguageAnalysisService().analyze({ content: publishedSource, language: "python", relativePath: "seed.py" });
        const records = buildSymbolRecordsForFile({ relativePath: "seed.py", language: "python", content: publishedSource,
            fileHash: createHash("sha256").update(publishedSource).digest("hex"), extractorVersion: "test",
            chunks: [...analysis.chunks], extractedSymbols: analysis.symbols });
        const target = records.find(symbol => symbol.name === "target")!;
        await writeFile(path.join(root, "seed.py"), currentSource);

        const { mappings } = await mapPublishedSymbolsToCurrentSpans({
            codebaseRoot: root,
            symbols: records.filter(symbol => symbol.kind !== "file"),
        });
        assert.equal(mappings.size, 1);
        const current = mappings.get(target.symbolInstanceId);
        assert.ok(current);
        assert.equal(current.span.startLine, 2);
        assert.equal(current.currentSourceHash, createHash("sha256").update(currentSource).digest("hex"));

        const payload = await buildRegistryFileOutlinePayload({ codebaseRoot: root, file: "seed.py", symbols: records,
            publishedSpans: true, currentSpans: mappings, resolveMode: "outline", limitSymbols: 500,
            buildCallGraphHint: symbol => ({ supported: true, symbolRef: { file: symbol.file, symbolId: symbol.symbolInstanceId },
                validated: true, validatedAt: "2026-10-20", relationshipBuiltAt: "2026-10-20" }),
            buildOutlineSpanWarningCodes: () => [],
            readSourceLines: async () => { throw new Error("published projection cannot read source"); } });

        assert.equal(payload.status, "ok");
        const projected = payload.outline!.symbols;
        const projectedTarget = projected.find(symbol => symbol.symbolId === target.symbolInstanceId);
        assert.ok(projectedTarget);
        // The published span keeps its published meaning and value.
        assert.deepEqual(projectedTarget.span, target.span);
        assert.deepEqual(projectedTarget.currentSpan, {
            startLine: 2,
            endLine: current.span.endLine,
            startByte: current.span.startByte,
            endByte: current.span.endByte,
            startColumn: current.span.startColumn,
            endColumn: current.span.endColumn,
            currentSourceHash: current.currentSourceHash,
            resolution: "current_symbol_validated",
        });
        // A declaration without a proven current counterpart carries no current span.
        const renamed = projected.find(symbol => symbol.name === "other");
        assert.ok(renamed);
        assert.equal(renamed.currentSpan, undefined);
        assert.deepEqual(renamed.span, records.find(symbol => symbol.name === "other")!.span);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a current span does not change the window filter or the page walk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "outline-current-span-window-"));
    try {
        const publishedSource = "def first():\n    return 1\n\ndef second():\n    return 2\n";
        const analysis = await createLanguageAnalysisService().analyze({ content: publishedSource, language: "python", relativePath: "seed.py" });
        const records = buildSymbolRecordsForFile({ relativePath: "seed.py", language: "python", content: publishedSource,
            fileHash: createHash("sha256").update(publishedSource).digest("hex"), extractorVersion: "test",
            chunks: [...analysis.chunks], extractedSymbols: analysis.symbols });
        await writeFile(path.join(root, "seed.py"), publishedSource);
        const { mappings } = await mapPublishedSymbolsToCurrentSpans({
            codebaseRoot: root,
            symbols: records.filter(symbol => symbol.kind !== "file"),
        });
        assert.equal(mappings.size, 2);

        const page = await buildRegistryFileOutlinePayload({ codebaseRoot: root, file: "seed.py", symbols: records,
            publishedSpans: true, currentSpans: mappings, resolveMode: "outline", limitSymbols: 1, windowStart: 4,
            continuationArgs: { path: "/repo", file: "seed.py", limitSymbols: 1 },
            buildCallGraphHint: () => ({ supported: false, reason: "test" }) as never,
            buildOutlineSpanWarningCodes: () => [],
            readSourceLines: async () => undefined });

        assert.deepEqual(page.outline?.symbols.map(symbol => symbol.name), ["second"]);
        assert.ok(page.outline?.symbols[0]?.currentSpan);
        assert.equal(page.outline?.symbols[0]?.currentSpan?.startLine, 4);
        assert.equal(page.hasMore, false);
        assert.equal(page.hints, undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
