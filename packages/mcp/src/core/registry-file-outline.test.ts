import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSymbolRecordsForFile, createLanguageAnalysisService } from "@satori-code/core";
import { buildRegistryFileOutlinePayload, fitFileOutlineResponseBudget } from "./registry-file-outline.js";
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
