import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
    type SymbolRegistryManifest,
} from "@satori-code/core";
import {
    buildSourceBackedPythonCalleeFallback,
    buildSourceBackedPythonCallerFallback,
    repairSourceBackedPythonSpan,
    repairSourceBackedPythonSpans,
} from "./python-call-fallback.js";

function testManifest(files: SymbolRegistryManifest['files']): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root-fingerprint',
        indexPolicyHash: 'policy-hash',
        languageRouterVersion: 'router-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files: files.map((file) => ({ ...file, definitionStatus: 'definitions_present' })),
    };
}

function pythonSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
    return {
        symbolKey: "python:function:target",
        symbolInstanceId: "syminst_python_target",
        language: "python",
        kind: "function",
        name: "target",
        qualifiedName: "target",
        label: "function target()",
        file: "src/example.py",
        span: { startLine: 1, endLine: 1 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
        ...overrides,
    };
}

test("Python source repair fails closed without authorized source lines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-failclosed-"));
    const relativeFile = "src/example.py";
    const sourceFile = path.join(root, relativeFile);
    const source = [
        "@decorator",
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
        span: { startLine: 2, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, source, "utf8");

    try {
        // The file exists on disk, but no authorized source lines were
        // supplied: the repair must fail closed without reading the pathname.
        const repaired = repairSourceBackedPythonSpan({ codebaseRoot: root, symbol });
        assert.equal(repaired.attempted, false);
        assert.equal(repaired.validated, false);
        assert.equal(repaired.repaired, false);
        assert.deepEqual(repaired.symbol.span, { startLine: 2, endLine: 2 });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Python source repair fails closed on a symlink escape even when lines are absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-symlink-"));
    const secretFile = path.join(os.tmpdir(), `satori-python-secret-${process.pid}-${Date.now()}.py`);
    fs.writeFileSync(secretFile, "def target():\n    return 'SECRET-CONTENT'\n", "utf8");
    const relativeFile = "src/example.py";
    const sourceFile = path.join(root, relativeFile);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.symlinkSync(secretFile, sourceFile);
    const symbol: SymbolRecord = {
        symbolKey: "python:function:target",
        symbolInstanceId: "syminst_python_target",
        language: "python",
        kind: "function",
        name: "target",
        qualifiedName: "target",
        label: "function target()",
        file: relativeFile,
        span: { startLine: 1, endLine: 1 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };

    try {
        const repaired = repairSourceBackedPythonSpan({ codebaseRoot: root, symbol });
        assert.equal(repaired.attempted, false);
        assert.equal(repaired.validated, false);
        // No span repair may leak evidence derived from the escaped target.
        assert.deepEqual(repaired.symbol.span, { startLine: 1, endLine: 1 });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(secretFile, { force: true });
    }
});

test("Python source repair works from explicitly supplied authorized lines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-lines-"));
    const relativeFile = "src/example.py";
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

    try {
        const repaired = repairSourceBackedPythonSpan({
            codebaseRoot: root,
            symbol,
            sourceLines: source.split("\n"),
        });
        assert.equal(repaired.validated, true);
        assert.equal(repaired.repaired, true);
        assert.deepEqual(repaired.symbol.span, { startLine: 1, endLine: 3 });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Python source repair preserves stacked multiline decorators without absorbing a sibling", () => {
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
        file: "src/example.py",
        span: { startLine: 9, endLine: 9 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };

    const repaired = repairSourceBackedPythonSpan({
        codebaseRoot: "/repo",
        symbol,
        sourceLines: source.split("\n"),
    });
    assert.equal(repaired.validated, true);
    assert.equal(repaired.repaired, true);
    assert.deepEqual(repaired.symbol.span, { startLine: 4, endLine: 10 });
});

test("Python source repair does not absorb an unrelated decorator or comment", () => {
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
        file: "src/example.py",
        span: { startLine: 6, endLine: 6 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };

    const repaired = repairSourceBackedPythonSpan({
        codebaseRoot: "/repo",
        symbol,
        sourceLines: source.split("\n"),
    });
    assert.equal(repaired.validated, true);
    assert.deepEqual(repaired.symbol.span, { startLine: 6, endLine: 7 });
});

test("Python source repair keeps triple-quoted bodies and their unindented content", () => {
    for (const quote of ['"""', "'''"]) {
        const source = [
            "def target():",
            `    description = ${quote}`,
            "column zero string content",
            "# comment-looking string content",
            `    ${quote}`,
            "    return True",
            "",
            "def next_symbol():",
            "    return False",
        ].join("\n");
        const repaired = repairSourceBackedPythonSpan({
            codebaseRoot: "/repo",
            symbol: pythonSymbol(),
            sourceLines: source.split("\n"),
        });
        assert.equal(repaired.validated, true, quote);
        assert.equal(repaired.repaired, true, quote);
        assert.deepEqual(repaired.symbol.span, { startLine: 1, endLine: 6 }, quote);
    }
});

test("Python source repair ignores triple delimiters inside quotes and comments", () => {
    const source = [
        "def target():",
        `    marker = '"""'`,
        `    other = "'''"`,
        `    # """ and ''' inside a comment`,
        "    return True",
        "",
        "def next_symbol():",
        "    return False",
    ].join("\n");
    const repaired = repairSourceBackedPythonSpan({
        codebaseRoot: "/repo",
        symbol: pythonSymbol(),
        sourceLines: source.split("\n"),
    });
    assert.equal(repaired.validated, true);
    assert.deepEqual(repaired.symbol.span, { startLine: 1, endLine: 5 });
});

test("Python source repair handles escaped quotes without ending the body early", () => {
    const source = [
        "def target():",
        '    text = "a \\"quoted\\" value"',
        "    other = 'it\\'s fine'",
        '    triple = """a \\""" b"""',
        "    return True",
        "",
        "def next_symbol():",
        "    return False",
    ].join("\n");
    const repaired = repairSourceBackedPythonSpan({
        codebaseRoot: "/repo",
        symbol: pythonSymbol(),
        sourceLines: source.split("\n"),
    });
    assert.equal(repaired.validated, true);
    assert.deepEqual(repaired.symbol.span, { startLine: 1, endLine: 5 });
});

test("Python source repair abstains when a body literal is unterminated", () => {
    for (const source of [
        [
            "def target():",
            '    text = "unterminated',
            "    return True",
        ],
        [
            "def target():",
            '    text = """unterminated',
            "    return True",
            "def next_symbol():",
            "    return False",
        ],
    ]) {
        const repaired = repairSourceBackedPythonSpan({
            codebaseRoot: "/repo",
            symbol: pythonSymbol(),
            sourceLines: source,
        });
        assert.equal(repaired.validated, false);
        assert.equal(repaired.repaired, false);
        assert.deepEqual(repaired.symbol.span, { startLine: 1, endLine: 1 });
    }
});

test("callee fallback recognizes a same-file function shadowing a Python built-in", async () => {
    const file = "src/example.py";
    const lines = [
        "def len(values):",
        "    return 7",
        "",
        "def caller():",
        "    return len([1, 2])",
    ];
    const target: SymbolRecord = {
        symbolKey: "python:function:len",
        symbolInstanceId: "syminst_len",
        language: "python",
        kind: "function",
        name: "len",
        qualifiedName: "len",
        label: "function len(values)",
        file,
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    const caller: SymbolRecord = {
        ...target,
        symbolKey: "python:function:caller",
        symbolInstanceId: "syminst_caller",
        name: "caller",
        qualifiedName: "caller",
        label: "function caller()",
        span: { startLine: 4, endLine: 5 },
    };
    const registry = buildSymbolRegistry({
        manifest: testManifest([
            { path: file, hash: "indexed_hash", language: "python", symbolCount: 2, definitionStatus: "definitions_present" },
        ]),
        symbols: [target, caller],
    });

    const result = await buildSourceBackedPythonCalleeFallback({
        codebaseRoot: "/repo",
        registry,
        source: caller,
        sortEdges: (edges) => edges,
        readSourceLines: async () => lines,
    });

    assert.deepEqual(result.edges.map((edge) => [edge.srcSymbolId, edge.dstSymbolId, edge.site.startLine]), [
        [caller.symbolInstanceId, target.symbolInstanceId, 5],
    ]);

    const callerResult = await buildSourceBackedPythonCallerFallback({
        codebaseRoot: "/repo",
        registry,
        resolvedTarget: target,
        suppressedRecords: [{
            sourceKey: caller.symbolKey,
            sourceInstanceId: caller.symbolInstanceId,
            targetKey: target.symbolKey,
            targetInstanceId: target.symbolInstanceId,
            type: "CALLS",
            file,
            span: { startLine: 5, endLine: 5 },
            confidence: "low",
        }],
        sortEdges: (edges) => edges,
        sortNotes: (notes) => notes,
        readSourceLines: async () => lines,
    });
    assert.deepEqual(callerResult.edges.map((edge) => [edge.srcSymbolId, edge.dstSymbolId]), [
        [caller.symbolInstanceId, target.symbolInstanceId],
    ]);

    const memberCallResult = await buildSourceBackedPythonCallerFallback({
        codebaseRoot: "/repo",
        registry,
        resolvedTarget: target,
        suppressedRecords: [{
            sourceKey: caller.symbolKey,
            sourceInstanceId: caller.symbolInstanceId,
            targetKey: target.symbolKey,
            targetInstanceId: target.symbolInstanceId,
            type: "CALLS",
            file,
            span: { startLine: 5, endLine: 5 },
            confidence: "low",
        }],
        sortEdges: (edges) => edges,
        sortNotes: (notes) => notes,
        readSourceLines: async () => [...lines.slice(0, 4), "    return object.len([1, 2])"],
    });
    assert.deepEqual(memberCallResult.edges, []);

    const parameterShadowResult = await buildSourceBackedPythonCalleeFallback({
        codebaseRoot: "/repo",
        registry,
        source: caller,
        sortEdges: (edges) => edges,
        readSourceLines: async () => [...lines.slice(0, 3), "def caller(len):", lines[4]],
    });
    assert.deepEqual(parameterShadowResult.edges, []);

    const localRebindingResult = await buildSourceBackedPythonCalleeFallback({
        codebaseRoot: "/repo",
        registry,
        source: { ...caller, span: { startLine: 4, endLine: 6 } },
        sortEdges: (edges) => edges,
        readSourceLines: async () => [
            ...lines.slice(0, 4),
            "    len = lambda values: 3",
            lines[4],
        ],
    });
    assert.deepEqual(localRebindingResult.edges, []);

    for (const moduleBinding of ["len = lambda values: 3", "from other import len"]) {
        const reboundLines = [...lines];
        reboundLines[2] = moduleBinding;
        const reboundCalleeResult = await buildSourceBackedPythonCalleeFallback({
            codebaseRoot: "/repo",
            registry,
            source: caller,
            sortEdges: (edges) => edges,
            readSourceLines: async () => reboundLines,
        });
        assert.deepEqual(reboundCalleeResult.edges, [], moduleBinding);

        const reboundCallerResult = await buildSourceBackedPythonCallerFallback({
            codebaseRoot: "/repo",
            registry,
            resolvedTarget: target,
            suppressedRecords: [{
                sourceKey: caller.symbolKey,
                sourceInstanceId: caller.symbolInstanceId,
                targetKey: target.symbolKey,
                targetInstanceId: target.symbolInstanceId,
                type: "CALLS",
                file,
                span: { startLine: 5, endLine: 5 },
                confidence: "low",
            }],
            sortEdges: (edges) => edges,
            sortNotes: (notes) => notes,
            readSourceLines: async () => reboundLines,
        });
        assert.deepEqual(reboundCallerResult.edges, [], moduleBinding);
    }
});

test("caller fallback skips records whose authorized source is denied and leaks no call names", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-caller-deny-"));
    const outsideSecret = path.join(os.tmpdir(), `satori-python-outside-secret-${process.pid}-${Date.now()}.py`);
    // The caller file on disk is a symlink to an outside secret. The
    // vulnerable base reads it through the symlink by pathname for span
    // repair; the authorized reader denies it (returns undefined), so the
    // fallback must produce no edges and no symbols derived from unreadable
    // source.
    fs.writeFileSync(outsideSecret, [
        "def caller():",
        "    target()",
        "    return True",
        "",
    ].join("\n"), "utf8");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.symlinkSync(outsideSecret, path.join(root, "src", "caller.py"));
    const target: SymbolRecord = {
        symbolKey: "python:function:target",
        symbolInstanceId: "syminst_target",
        language: "python",
        kind: "function",
        name: "target",
        qualifiedName: "target",
        label: "function target()",
        file: "src/target.py",
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    const caller: SymbolRecord = {
        symbolKey: "python:function:caller",
        symbolInstanceId: "syminst_caller",
        language: "python",
        kind: "function",
        name: "caller",
        qualifiedName: "caller",
        label: "function caller()",
        file: "src/caller.py",
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    const registry = buildSymbolRegistry({
        manifest: testManifest([
            { path: 'src/target.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
            { path: 'src/caller.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
        ]),
        symbols: [target, caller],
    });
    const suppressedRecords: RelationshipRecord[] = [{
        sourceKey: caller.symbolKey,
        sourceInstanceId: caller.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type: 'CALLS',
        file: 'src/caller.py',
        span: { startLine: 2, endLine: 2 },
        confidence: 'low',
    }];

    try {
        // The authorized reader denies every file (symlink escape / unpublished /
        // workspace-denied all surface as `undefined`). The fallback must produce
        // no edges and no symbols derived from unreadable source.
        const result = await buildSourceBackedPythonCallerFallback({
            codebaseRoot: root,
            registry,
            resolvedTarget: target,
            suppressedRecords,
            sortEdges: (edges) => edges,
            sortNotes: (notes) => notes,
            readSourceLines: async () => undefined,
        });
        assert.deepEqual(result.edges, []);
        assert.deepEqual(result.symbols, []);
        assert.deepEqual(result.notes, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outsideSecret, { force: true });
    }
});

test("caller fallback never opens a denied source by pathname (directory target fails closed)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-python-caller-deny-dir-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), `satori-python-outside-dir-${process.pid}-${Date.now()}`));
    // The caller file on disk is a symlink to an outside directory. A
    // pathname read of it throws EISDIR; the vulnerable base reaches that
    // read (rejecting the whole fallback), while the fix skips the record
    // before any filesystem access because the authorized reader denies it.
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(root, "src", "caller.py"));
    const target: SymbolRecord = {
        symbolKey: "python:function:target",
        symbolInstanceId: "syminst_target",
        language: "python",
        kind: "function",
        name: "target",
        qualifiedName: "target",
        label: "function target()",
        file: "src/target.py",
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    const caller: SymbolRecord = {
        symbolKey: "python:function:caller",
        symbolInstanceId: "syminst_caller",
        language: "python",
        kind: "function",
        name: "caller",
        qualifiedName: "caller",
        label: "function caller()",
        file: "src/caller.py",
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "indexed_hash",
        extractorVersion: "test",
    };
    const registry = buildSymbolRegistry({
        manifest: testManifest([
            { path: 'src/target.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
            { path: 'src/caller.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
        ]),
        symbols: [target, caller],
    });
    const suppressedRecords: RelationshipRecord[] = [{
        sourceKey: caller.symbolKey,
        sourceInstanceId: caller.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type: 'CALLS',
        file: 'src/caller.py',
        span: { startLine: 2, endLine: 2 },
        confidence: 'low',
    }];

    try {
        const result = await buildSourceBackedPythonCallerFallback({
            codebaseRoot: root,
            registry,
            resolvedTarget: target,
            suppressedRecords,
            sortEdges: (edges) => edges,
            sortNotes: (notes) => notes,
            readSourceLines: async () => undefined,
        });
        assert.deepEqual(result.edges, []);
        assert.deepEqual(result.symbols, []);
        assert.deepEqual(result.notes, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test("batch Python span repair shares one concurrent read per file", async () => {
    const file = "src/shared.py";
    const lines = [
        "def first():",
        "    return 1",
        "",
        "def second():",
        "    return 2",
        "",
        "def third():",
        "    return 3",
    ];
    const symbols = ["first", "second", "third"].map((name, index) => pythonSymbol({
        symbolKey: `python:function:${name}`,
        symbolInstanceId: `syminst_${name}`,
        name,
        qualifiedName: name,
        label: `function ${name}()`,
        file,
        span: { startLine: index * 3 + 1, endLine: index * 3 + 1 },
    }));
    let reads = 0;
    const repairs = await repairSourceBackedPythonSpans({
        codebaseRoot: "/repo",
        symbols,
        readSourceLines: async () => {
            reads += 1;
            await Promise.resolve();
            return lines;
        },
    });
    assert.equal(reads, 1);
    assert.deepEqual(repairs.map((repair) => repair.validated), [true, true, true]);
    assert.deepEqual(repairs.map((repair) => repair.symbol.span), [
        { startLine: 1, endLine: 2 },
        { startLine: 4, endLine: 5 },
        { startLine: 7, endLine: 8 },
    ]);
});

test("batch Python span repair caches a denied read per file", async () => {
    const file = "src/denied.py";
    const symbols = ["first", "second", "third"].map((name, index) => pythonSymbol({
        symbolKey: `python:function:${name}`,
        symbolInstanceId: `syminst_${name}`,
        name,
        qualifiedName: name,
        label: `function ${name}()`,
        file,
        span: { startLine: index * 3 + 1, endLine: index * 3 + 2 },
    }));
    let reads = 0;
    const repairs = await repairSourceBackedPythonSpans({
        codebaseRoot: "/repo",
        symbols,
        readSourceLines: async () => {
            reads += 1;
            await Promise.resolve();
            return undefined;
        },
    });
    assert.equal(reads, 1);
    assert.deepEqual(repairs.map((repair) => repair.attempted), [false, false, false]);
    assert.deepEqual(repairs.map((repair) => repair.validated), [false, false, false]);
});

test("caller fallback reads a denied source file only once for repeated records", async () => {
    const file = "src/caller.py";
    const target = pythonSymbol({
        file: "src/target.py",
        span: { startLine: 1, endLine: 2 },
    });
    const callers = ["caller_one", "caller_two", "caller_three"].map((name, index) => pythonSymbol({
        symbolKey: `python:function:${name}`,
        symbolInstanceId: `syminst_${name}`,
        name,
        qualifiedName: name,
        label: `function ${name}()`,
        file,
        span: { startLine: index * 3 + 1, endLine: index * 3 + 2 },
    }));
    const registry = buildSymbolRegistry({
        manifest: testManifest([
            { path: 'src/target.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
            { path: file, hash: 'indexed_hash', language: 'python', symbolCount: 3, definitionStatus: 'definitions_present' },
        ]),
        symbols: [target, ...callers],
    });
    const suppressedRecords: RelationshipRecord[] = callers.map((caller) => ({
        sourceKey: caller.symbolKey,
        sourceInstanceId: caller.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type: "CALLS" as const,
        file,
        span: { startLine: caller.span.startLine + 1, endLine: caller.span.startLine + 1 },
        confidence: "low" as const,
    }));
    let reads = 0;
    const result = await buildSourceBackedPythonCallerFallback({
        codebaseRoot: "/repo",
        registry,
        resolvedTarget: target,
        suppressedRecords,
        sortEdges: (edges) => edges,
        sortNotes: (notes) => notes,
        readSourceLines: async () => {
            reads += 1;
            await Promise.resolve();
            return undefined;
        },
    });
    assert.equal(reads, 1);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.symbols, []);
    assert.deepEqual(result.notes, []);
});

test("callee fallback resolves only same-file targets", async () => {
    const localFile = "src/local.py";
    const remoteTarget = pythonSymbol({
        symbolKey: "python:function:helper",
        symbolInstanceId: "syminst_remote_helper",
        name: "helper",
        qualifiedName: "helper",
        label: "function helper()",
        file: "src/target.py",
        span: { startLine: 1, endLine: 2 },
    });
    const localHelper = pythonSymbol({
        ...remoteTarget,
        symbolInstanceId: "syminst_local_helper",
        file: localFile,
    });
    const localCaller = pythonSymbol({
        symbolKey: "python:function:caller",
        symbolInstanceId: "syminst_local_caller",
        name: "caller",
        qualifiedName: "caller",
        label: "function caller()",
        file: localFile,
        span: { startLine: 4, endLine: 5 },
    });
    const remoteCaller = pythonSymbol({
        symbolKey: "python:function:remote_caller",
        symbolInstanceId: "syminst_remote_caller",
        name: "remote_caller",
        qualifiedName: "remote_caller",
        label: "function remote_caller()",
        file: "src/remote.py",
        span: { startLine: 1, endLine: 2 },
    });
    const registry = buildSymbolRegistry({
        manifest: testManifest([
            { path: 'src/target.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
            { path: localFile, hash: 'indexed_hash', language: 'python', symbolCount: 2, definitionStatus: 'definitions_present' },
            { path: 'src/remote.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
        ]),
        symbols: [remoteTarget, localHelper, localCaller, remoteCaller],
    });
    const sameFileOnlyRegistry = new Proxy(registry as SymbolRegistry, {
        get(target, property, receiver) {
            assert.notEqual(property, "symbols", "callee fallback must not index repository-wide symbols");
            return Reflect.get(target, property, receiver);
        },
    });

    const localResult = await buildSourceBackedPythonCalleeFallback({
        codebaseRoot: "/repo",
        registry: sameFileOnlyRegistry,
        source: localCaller,
        sortEdges: (edges) => edges,
        readSourceLines: async () => [
            "def helper():",
            "    return 1",
            "",
            "def caller():",
            "    return helper()",
        ],
    });
    assert.deepEqual(localResult.edges.map((edge) => [edge.srcSymbolId, edge.dstSymbolId]), [
        [localCaller.symbolInstanceId, localHelper.symbolInstanceId],
    ]);

    const remoteResult = await buildSourceBackedPythonCalleeFallback({
        codebaseRoot: "/repo",
        registry,
        source: remoteCaller,
        sortEdges: (edges) => edges,
        readSourceLines: async () => [
            "def remote_caller():",
            "    return helper()",
        ],
    });
    assert.deepEqual(remoteResult.edges, []);
});

test("caller fallback keeps repository-wide candidates", async () => {
    const callerFile = "src/caller.py";
    const target = pythonSymbol({
        file: "src/target.py",
        span: { startLine: 1, endLine: 2 },
    });
    const caller = pythonSymbol({
        symbolKey: "python:function:caller",
        symbolInstanceId: "syminst_caller",
        name: "caller",
        qualifiedName: "caller",
        label: "function caller()",
        file: callerFile,
        span: { startLine: 1, endLine: 2 },
    });
    const registry = buildSymbolRegistry({
        manifest: testManifest([
            { path: 'src/target.py', hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
            { path: callerFile, hash: 'indexed_hash', language: 'python', symbolCount: 1, definitionStatus: 'definitions_present' },
        ]),
        symbols: [target, caller],
    });
    const result = await buildSourceBackedPythonCallerFallback({
        codebaseRoot: "/repo",
        registry,
        resolvedTarget: target,
        suppressedRecords: [{
            sourceKey: caller.symbolKey,
            sourceInstanceId: caller.symbolInstanceId,
            targetKey: target.symbolKey,
            targetInstanceId: target.symbolInstanceId,
            type: "CALLS" as const,
            file: callerFile,
            span: { startLine: 2, endLine: 2 },
            confidence: "low" as const,
        }],
        sortEdges: (edges) => edges,
        sortNotes: (notes) => notes,
        readSourceLines: async () => [
            "def caller():",
            "    target()",
        ],
    });
    assert.deepEqual(result.edges.map((edge) => [edge.srcSymbolId, edge.dstSymbolId]), [
        [caller.symbolInstanceId, target.symbolInstanceId],
    ]);
});
