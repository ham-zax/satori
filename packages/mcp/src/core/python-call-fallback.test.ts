import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    withSourceMeasurementOperation,
    type SymbolRecord,
} from "@zokizuan/satori-core";
import { repairSourceBackedPythonSpan } from "./python-call-fallback.js";

test("Python source repair instrumentation preserves output and records outline acquisition", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-measurement-"));
    const relativeFile = "src/example.py";
    const sourceFile = path.join(root, relativeFile);
    const ledgerFile = path.join(root, "source-ledger.jsonl");
    const source = [
        "@decorator",
        "def target():",
        "    return True",
        "",
        "def next_symbol():",
        "    return False",
        "",
    ].join("\n");
    const symbol: SymbolRecord = {
        symbolKey: "python:function:target",
        symbolInstanceId: "syminst_python_target",
        language: "python",
        kind: "function",
        name: "target",
        qualifiedName: "target",
        label: "function target()",
        file: relativeFile,
        span: { startLine: 2, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, source, "utf8");

    try {
        const unmeasured = repairSourceBackedPythonSpan({ codebaseRoot: root, symbol });
        const measured = await withSourceMeasurementOperation({
            operation: "file_outline",
            ledgerFile,
            rootDir: root,
        }, () => repairSourceBackedPythonSpan({ codebaseRoot: root, symbol }));

        assert.deepEqual(measured, unmeasured);
        assert.deepEqual(measured.symbol.span, { startLine: 1, endLine: 3 });
        const records = fs.readFileSync(ledgerFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        assert.deepEqual(records.map((record) => record.kind), [
            "source_observation",
            "source_io",
            "source_observation_outcome",
            "source_processing",
        ]);
        assert.equal(records[0].owner, "outline");
        assert.equal(records[1].bytesObtained, Buffer.byteLength(source));
        assert.equal(records[1].basis, "path_read");
        assert.equal(records[2].status, "completed");
        assert.equal(records[3].owner, "selector");
        assert.equal(records[3].outcome, "success");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Python source repair preserves stacked multiline decorators without absorbing a sibling", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-decorator-"));
    const relativeFile = "src/example.py";
    const sourceFile = path.join(root, relativeFile);
    const source = [
        "def previous():",
        "    return False",
        "",
        "@outer(",
        "    value=\"closing ) stays in the string\",",
        "    options={\"opening\": \"(\"},",
        ")",
        "@inner",
        "def target():",
        "    return True",
        "",
        "def next_symbol():",
        "    return False",
        "",
    ].join("\n");
    const symbol: SymbolRecord = {
        symbolKey: "python:function:target",
        symbolInstanceId: "syminst_python_target",
        language: "python",
        kind: "function",
        name: "target",
        qualifiedName: "target",
        label: "function target()",
        file: relativeFile,
        span: { startLine: 9, endLine: 9 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, source, "utf8");

    try {
        const repaired = repairSourceBackedPythonSpan({ codebaseRoot: root, symbol });
        assert.equal(repaired.validated, true);
        assert.equal(repaired.repaired, true);
        assert.deepEqual(repaired.symbol.span, { startLine: 4, endLine: 10 });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Python source repair does not absorb an unrelated decorator or comment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-decorator-boundary-"));
    const relativeFile = "src/example.py";
    const sourceFile = path.join(root, relativeFile);
    const source = [
        "@decorator",
        "def previous():",
        "    return False",
        "",
        "# target remains undecorated",
        "def target():",
        "    return True",
        "",
    ].join("\n");
    const symbol: SymbolRecord = {
        symbolKey: "python:function:target",
        symbolInstanceId: "syminst_python_target",
        language: "python",
        kind: "function",
        name: "target",
        qualifiedName: "target",
        label: "function target()",
        file: relativeFile,
        span: { startLine: 6, endLine: 6 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, source, "utf8");

    try {
        const repaired = repairSourceBackedPythonSpan({ codebaseRoot: root, symbol });
        assert.equal(repaired.validated, true);
        assert.deepEqual(repaired.symbol.span, { startLine: 6, endLine: 7 });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
