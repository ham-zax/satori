import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CBM_LANGUAGE_MAP, CBM_LANGUAGE_MAP_COMMIT } from '../languages/cbm-language-map';

interface ModuleEntry {
    cbmLanguage: string;
    satoriLanguageId: string;
    file: string;
    sizeBytes: number;
    sha256: string;
    sourceSha256: string;
    pack: 'core' | 'extended';
}
interface Manifest {
    schemaVersion: number;
    cbmCommit: string;
    emscripten: string;
    glue: { file: string; sha256: string };
    modules: ModuleEntry[];
}
interface ExtractorModule {
    HEAPU8: Uint8Array;
    _malloc(length: number): number;
    _free(pointer: number): void;
    _satori_extract(source: number, length: number, path: number): number;
    _satori_result_ptr(): number;
    _satori_result_len(): number;
}
interface RecordRow {
    label: string;
    name: string;
    qualifiedName: string;
    parentClass: string;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
}

const localRequire = createRequire(__filename);
const repoRoot = fs.existsSync(path.join(process.cwd(), 'packages/core/src/language-analysis'))
    ? process.cwd()
    : path.resolve(process.cwd(), '../..');
const assetRoot = path.join(repoRoot, 'packages/core/assets/cbm-extractor');
const manifest = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8')) as Manifest;
const createExtractor = localRequire(path.join(assetRoot, manifest.glue.file)) as
    (settings: { locateFile: (name: string) => string }) => Promise<ExtractorModule>;
const existingAnalyzers = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'cpp', 'scala']);
const cbmRoot = process.env.CBM_CHECKOUT ?? '/home/hamza/repo/codebase-memory-mcp';

const kotlinSample = [
    'package demo',
    '',
    'interface Priced { fun price(): Int }',
    '',
    'data class Item(val value: Int) : Priced {',
    '    override fun price(): Int = value',
    '}',
    '',
    '// registry',
    '// members',
    '',
    'class Registry {',
    '    val items = mutableListOf<Item>()',
    '    fun add(item: Item) { items.add(item) }',
    '}',
    '',
    'enum class Kind { A, B }',
    '',
    'fun total(items: List<Item>): Int = items.sumOf { it.price() }',
].join('\n');
const luaSample = [
    'local M = {}',
    '',
    'function M.greet(name)',
    '  return "hi " .. name',
    'end',
    '',
    'local function helper() return 1 end',
    '',
    'function top() return helper() end',
].join('\n');

const samples: Readonly<Record<string, string>> = {
    BASH: 'greet() { echo hello; }\n',
    CLOJURE: '(defn greet [] "hello")\n',
    CMAKE: 'function(greet)\nendfunction()\n',
    COMMONLISP: '(defun greet () "hello")\n',
    CSS: '.greet { color: red; }\n',
    DART: 'int greet() => 1;\n',
    DOCKERFILE: 'FROM alpine\nRUN echo hello\n',
    ELIXIR: 'defmodule Greet do\n  def hello, do: :ok\nend\n',
    ELM: 'greet = "hello"\n',
    ERLANG: '-module(greet).\nhello() -> ok.\n',
    FSHARP: 'let greet () = "hello"\n',
    GDSCRIPT: 'func greet():\n    pass\n',
    GLEAM: 'pub fn greet() { 1 }\n',
    GRAPHQL: 'type Query { greet: String }\n',
    GROOVY: 'def greet() { 1 }\n',
    HASKELL: 'greet :: Int\ngreet = 1\n',
    HCL: 'variable "greet" { default = "hello" }\n',
    HTML: '<html><body><h1>hello</h1></body></html>\n',
    JULIA: 'function greet()\n    1\nend\n',
    KOTLIN: kotlinSample,
    LUA: luaSample,
    MAKEFILE: 'greet:\n\t@echo hello\n',
    NIX: '{ greet = "hello"; }\n',
    OCAML: 'let greet () = 1\n',
    PERL: 'sub greet { return 1; }\n',
    PHP: '<?php function greet() { return 1; }\n',
    POWERSHELL: 'function Greet { "hello" }\n',
    PROTOBUF: 'syntax = "proto3";\nmessage Greet { string name = 1; }\n',
    R: 'greet <- function() 1\n',
    RUBY: 'def greet\n  1\nend\n',
    SCSS: '$greet: red;\n.greet { color: $greet; }\n',
    SOLIDITY: 'contract Greet { function hello() public {} }\n',
    SQL: 'CREATE TABLE greet (id INT);\n',
    SVELTE: '<script>let greet = "hello";</script>\n<h1>{greet}</h1>\n',
    SWIFT: 'func greet() -> Int { return 1 }\n',
    TOML: 'greet = "hello"\n',
    VUE: '<script setup>const greet = "hello"</script>\n',
    YAML: 'greet: hello\n',
    ZIG: 'pub fn greet() void {}\n',
};

async function extract(entry: ModuleEntry, source: string, relativePath: string): Promise<RecordRow[]> {
    const root = entry.pack === 'core' ? assetRoot : path.join(assetRoot, 'extended');
    const module = await createExtractor({ locateFile: (name) => {
        assert.equal(name, 'cbm-extractor.wasm');
        return path.join(root, entry.file);
    } });
    const sourceBytes = Buffer.from(source, 'utf8');
    const pathBytes = Buffer.from(`${relativePath}\0`, 'utf8');
    const sourcePointer = module._malloc(sourceBytes.length + 1);
    const pathPointer = module._malloc(pathBytes.length);
    assert.ok(sourcePointer && pathPointer);
    try {
        module.HEAPU8.set(sourceBytes, sourcePointer);
        module.HEAPU8[sourcePointer + sourceBytes.length] = 0;
        module.HEAPU8.set(pathBytes, pathPointer);
        const count = module._satori_extract(sourcePointer, sourceBytes.length, pathPointer);
        assert.ok(count >= 0, `${entry.cbmLanguage}: parse failed`);
        const resultPointer = module._satori_result_ptr();
        const resultLength = module._satori_result_len();
        const result = Buffer.from(module.HEAPU8.subarray(resultPointer, resultPointer + resultLength)).toString('utf8');
        const lines = result.trimEnd().split('\n');
        const records = resultLength === 0 ? [] : lines.map((line) => {
            const fields = line.split('\t');
            assert.equal(fields.length, 8, `${entry.cbmLanguage}: TSV fields`);
            return { label: fields[0], name: fields[1], qualifiedName: fields[2], parentClass: fields[3],
                startLine: Number(fields[4]), endLine: Number(fields[5]),
                startByte: Number(fields[6]), endByte: Number(fields[7]) };
        });
        assert.equal(records.length, count, `${entry.cbmLanguage}: result count`);
        return records;
    } finally {
        module._free(sourcePointer);
        module._free(pathPointer);
    }
}

function checkSpans(records: RecordRow[], source: string): void {
    const bytes = Buffer.from(source, 'utf8');
    const lineAt = (offset: number) => 1 + bytes.subarray(0, offset).filter((byte) => byte === 10).length;
    for (const record of records) {
        assert.ok(Number.isInteger(record.startByte) && Number.isInteger(record.endByte));
        assert.ok(record.startByte >= 0 && record.startByte <= record.endByte && record.endByte <= bytes.length);
        assert.equal(lineAt(record.startByte), record.startLine, `${record.name}: start line`);
        assert.equal(lineAt(record.endByte), record.endLine, `${record.name}: end line`);
        if (record.label !== 'Module') {
            assert.ok(bytes.subarray(record.startByte, record.endByte).toString('utf8').includes(record.name),
                `${record.name}: byte span does not contain name`);
        }
    }
}

test('manifest covers mapped languages outside Satori structural analyzers', () => {
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.cbmCommit, CBM_LANGUAGE_MAP_COMMIT);
    assert.equal(manifest.emscripten, '3.1.64');
    const expected = CBM_LANGUAGE_MAP.filter((row) => row.grammarFactory && row.satoriLanguageId && !existingAnalyzers.has(row.satoriLanguageId))
        .map((row) => row.cbmLanguage).sort();
    assert.deepEqual(manifest.modules.map((row) => row.cbmLanguage), expected);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(assetRoot, manifest.glue.file))).digest('hex'), manifest.glue.sha256);
});

test('every core module loads through shared glue and extracts a definition', async () => {
    for (const entry of manifest.modules.filter((row) => row.pack === 'core')) {
        const filename = path.join(assetRoot, entry.file);
        const bytes = fs.readFileSync(filename);
        assert.equal(bytes.length, entry.sizeBytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
        const sample = samples[entry.cbmLanguage];
        assert.ok(sample, `${entry.cbmLanguage}: missing smoke sample`);
        const records = await extract(entry, sample, `${entry.cbmLanguage.toLowerCase()}.txt`);
        assert.ok(records.length >= 1, `${entry.cbmLanguage}: no definitions`);
        assert.equal(records[0].label, 'Module');
        checkSpans(records, sample);
    }
});

test('Kotlin and Lua definitions match the CBM spike labels, names, and lines', async () => {
    for (const [cbmLanguage, source, filename, expected] of [
        ['KOTLIN', kotlinSample, 'Shop.kt', [
            ['Module', 'Shop.kt', 1], ['Class', 'Priced', 3], ['Method', 'price', 3],
            ['Class', 'Item', 5], ['Method', 'price', 6], ['Class', 'Registry', 12],
            ['Variable', 'items', 13], ['Method', 'add', 14], ['Class', 'Kind', 17],
            ['Function', 'total', 19],
        ]],
        ['LUA', luaSample, 'sample.lua', [
            ['Module', 'sample.lua', 1], ['Variable', 'M', 1], ['Function', 'M.greet', 3],
            ['Function', 'helper', 7], ['Function', 'top', 9],
        ]],
    ] as const) {
        const entry = manifest.modules.find((row) => row.cbmLanguage === cbmLanguage);
        assert.ok(entry);
        const records = await extract(entry, source, filename);
        const byLineAndName = (left: readonly [string, string, number], right: readonly [string, string, number]) =>
            left[2] - right[2] || left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]);
        assert.deepEqual(records.map((row) => [row.label, row.name, row.startLine] as const).sort(byLineAndName),
            [...expected].sort(byLineAndName));
        checkSpans(records, source);
    }
});

test('byte spans account for multibyte UTF-8 before a definition', async () => {
    const source = '// café ☕\nclass Item {}\n';
    const entry = manifest.modules.find((row) => row.cbmLanguage === 'KOTLIN');
    assert.ok(entry);
    const records = await extract(entry, source, 'Unicode.kt');
    const item = records.find((row) => row.name === 'Item');
    assert.ok(item);
    assert.equal(item.startByte, Buffer.byteLength('// café ☕\n', 'utf8'));
    checkSpans(records, source);
});

test('vendored extractor sources are current only at the pinned CBM commit', (context) => {
    const head = spawnSync('git', ['-C', cbmRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== CBM_LANGUAGE_MAP_COMMIT) {
        context.skip(`CBM checkout at ${cbmRoot} is not at ${CBM_LANGUAGE_MAP_COMMIT}`);
        return;
    }
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/cbm-extractor-sync.mjs'), '--check', cbmRoot], {
        cwd: repoRoot, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
});
