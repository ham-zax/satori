import assert from 'node:assert/strict';
import test from 'node:test';

import { createLanguageAnalysisService } from './service';

test('language analysis routes TypeScript through Oxc with structural evidence', async () => {
    const analyzer = createLanguageAnalysisService({ chunkSize: 2500, chunkOverlap: 300 });
    const source = [
        "import type { Input } from './types';",
        "export { helper } from './helper';",
        'export async function run(input: Input) {',
        '    return helper(input);',
        '}',
    ].join('\n');

    const result = await analyzer.analyze({
        content: source,
        language: 'typescript',
        relativePath: 'src/run.ts',
    });

    assert.equal(result.backend, 'oxc');
    assert.equal(result.structuralStatus, 'complete');
    assert.ok(result.symbols.some((symbol) => symbol.kind === 'function' && symbol.name === 'run'));
    assert.ok(result.moduleBindings.some((binding) => (
        binding.kind === 'import'
        && binding.moduleSpecifier === './types'
        && binding.typeOnly
    )));
    assert.ok(result.moduleBindings.some((binding) => (
        binding.kind === 'reexport'
        && binding.moduleSpecifier === './helper'
    )));
    assert.ok(result.callSites.some((call) => call.calleeName === 'helper'));
    assert.ok(result.chunks.some((chunk) => chunk.metadata.symbolLabel?.includes('run')));
});

test('Oxc callable expressions are navigation symbols and suppress local scalar variables', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: [
            'const run = () => { const temporary = 1; return helper(temporary); };',
            'class Service { execute = function () { return helper(); }; }',
            'const moduleConstant = 1;',
        ].join('\n'),
        language: 'typescript',
        relativePath: 'src/callables.ts',
    });

    assert.ok(result.symbols.some((symbol) => symbol.kind === 'function' && symbol.name === 'run'));
    assert.ok(result.symbols.some((symbol) => (
        symbol.kind === 'method'
        && symbol.name === 'execute'
        && symbol.qualifiedName === 'Service.execute'
    )));
    assert.ok(result.symbols.some((symbol) => symbol.kind === 'variable' && symbol.name === 'moduleConstant'));
    assert.ok(!result.symbols.some((symbol) => symbol.name === 'temporary'));
    assert.equal(result.callSites.filter((call) => call.calleeName === 'helper').length, 2);
});

test('Oxc infrastructure exceptions degrade to searchable recovered text', async () => {
    const analyzer = createLanguageAnalysisService();
    let reads = 0;
    const input = {
        language: 'typescript',
        relativePath: 'src/run.ts',
        get content(): string {
            reads += 1;
            if (reads === 1) throw new Error('injected Oxc failure');
            return 'export function run() { return 1; }';
        },
    };

    const result = await analyzer.analyze(input);

    assert.equal(result.backend, 'oxc');
    assert.equal(result.structuralStatus, 'recovered');
    assert.deepEqual(result.symbols, []);
    assert.ok(result.chunks.some((chunk) => chunk.content.includes('function run')));
});

test('language analysis preserves same-line duplicate TypeScript declarations by byte span', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: 'function duplicate() {} function duplicate() {}',
        language: 'typescript',
        relativePath: 'src/duplicates.ts',
    });

    const duplicates = result.symbols.filter((symbol) => symbol.name === 'duplicate');
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0].span.startByte, duplicates[1].span.startByte);
});

test('Oxc UTF-16 offsets become exact UTF-8 symbol byte spans', async () => {
    const analyzer = createLanguageAnalysisService();
    const source = 'const greeting = "é";\nexport function run() { return "你好"; }\n';
    const result = await analyzer.analyze({
        content: source,
        language: 'typescript',
        relativePath: 'src/unicode.ts',
    });

    const run = result.symbols.find((symbol) => symbol.name === 'run');
    assert.ok(run?.span.startByte !== undefined);
    assert.ok(run?.span.endByte !== undefined);
    const expectedStart = Buffer.byteLength(source.slice(0, source.indexOf('function')));
    const declarationEnd = source.indexOf('\n', source.indexOf('function'));
    const expectedEnd = Buffer.byteLength(source.slice(0, declarationEnd));

    assert.equal(run.span.startByte, expectedStart);
    assert.equal(run.span.endByte, expectedEnd);
    assert.equal(
        Buffer.from(source).subarray(run.span.startByte, run.span.endByte).toString('utf8'),
        'function run() { return "你好"; }',
    );
    assert.ok(result.chunks.some((chunk) => (
        chunk.metadata.symbolLabel === 'function run'
        && chunk.content === 'function run() { return "你好"; }'
    )));
});

test('language analysis keeps imports and module-level text searchable beside symbol chunks', async () => {
    const analyzer = createLanguageAnalysisService({ chunkSize: 40, chunkOverlap: 5 });
    const result = await analyzer.analyze({
        content: "import { helper } from './helper';\n\n// module policy\nexport function run() { return helper(); }\n",
        language: 'typescript',
        relativePath: 'src/run.ts',
    });

    assert.ok(result.chunks.some((chunk) => chunk.content.includes("from './helper'")));
    assert.ok(result.chunks.some((chunk) => chunk.content.includes('module policy')));
    assert.ok(result.chunks.some((chunk) => chunk.metadata.symbolLabel === 'function run'));
});

test('language analysis chunk boundaries preserve UTF-8 text', async () => {
    const analyzer = createLanguageAnalysisService({ chunkSize: 7, chunkOverlap: 2 });
    const source = 'const message = "你好世界";';
    const result = await analyzer.analyze({
        content: source,
        language: 'typescript',
        relativePath: 'src/message.ts',
    });

    assert.ok(result.chunks.length > 1);
    assert.ok(result.chunks.every((chunk) => !chunk.content.includes('\ufffd')));
});

test('Rust impl methods retain their implemented type as qualified ownership', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: 'pub struct Stack;\nimpl Stack { pub fn push(&mut self) {} }\n',
        language: 'rust',
        relativePath: 'src/stack.rs',
    });

    const method = result.symbols.find((symbol) => symbol.kind === 'method' && symbol.name === 'push');
    assert.equal(method?.qualifiedName, 'Stack.push');
    assert.deepEqual(method?.parentQualifiedNamePath, ['Stack']);
});

test('Rust modules, trait methods, and generic impl methods retain structural ownership', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: [
            'mod storage { pub fn load() {} }',
            'trait Runner { fn run(&self); }',
            'struct Boxed<T>(T);',
            'impl<T> Boxed<T> { fn get(&self) {} }',
        ].join('\n'),
        language: 'rust',
        relativePath: 'src/lib.rs',
    });

    assert.ok(result.symbols.some((symbol) => symbol.kind === 'module' && symbol.name === 'storage'));
    assert.ok(result.symbols.some((symbol) => (
        symbol.kind === 'method' && symbol.qualifiedName === 'Runner.run'
    )));
    assert.ok(result.symbols.some((symbol) => (
        symbol.kind === 'method' && symbol.qualifiedName === 'Boxed.get'
    )));
});

test('Go types, interfaces, and receiver methods retain structural ownership', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: [
            'package service',
            'type Service struct {}',
            'type Runner interface { Run() }',
            'func (service *Service) Run() {}',
        ].join('\n'),
        language: 'go',
        relativePath: 'service.go',
    });

    assert.ok(result.symbols.some((symbol) => symbol.kind === 'struct' && symbol.name === 'Service'));
    assert.ok(result.symbols.some((symbol) => symbol.kind === 'interface' && symbol.name === 'Runner'));
    assert.ok(result.symbols.some((symbol) => (
        symbol.kind === 'method' && symbol.qualifiedName === 'Service.Run'
    )));
});

test('Python decorated definitions include their decorators in the symbol span', async () => {
    const analyzer = createLanguageAnalysisService();
    const source = '@registered\ndef run():\n    return 1\n';
    const result = await analyzer.analyze({
        content: source,
        language: 'python',
        relativePath: 'src/service.py',
    });

    const run = result.symbols.find((symbol) => symbol.name === 'run');
    assert.equal(run?.span.startLine, 1);
    assert.equal(run?.span.startByte, 0);
});

test('C++ class member functions are methods owned by their class', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: 'class Service { public: int run() { return 1; } };\n',
        language: 'cpp',
        relativePath: 'src/service.cpp',
    });

    assert.ok(result.symbols.some((symbol) => (
        symbol.kind === 'method' && symbol.qualifiedName === 'Service.run'
    )));
});

test('language analysis parses large TypeScript files without native binding failures', async () => {
    const analyzer = createLanguageAnalysisService();
    const source = Array.from({ length: 5000 }, (_, index) => (
        `export function fn${index}() { return ${index}; }`
    )).join('\n');

    const result = await analyzer.analyze({
        content: source,
        language: 'typescript',
        relativePath: 'src/large.ts',
    });

    assert.equal(result.structuralStatus, 'complete');
    assert.equal(result.symbols.filter((symbol) => symbol.kind === 'function').length, 5000);
});

test('language analysis routes Python through Tree-sitter WASM', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: 'class Service:\n    def run(self):\n        return 1\n',
        language: 'python',
        relativePath: 'src/service.py',
    });

    assert.equal(result.backend, 'tree_sitter_wasm');
    assert.equal(result.structuralStatus, 'complete');
    assert.ok(result.symbols.some((symbol) => symbol.kind === 'class' && symbol.name === 'Service'));
    assert.ok(result.symbols.some((symbol) => symbol.kind === 'method' && symbol.name === 'run'));
});

test('language aliases route through their structural parsers', async () => {
    const analyzer = createLanguageAnalysisService();
    const fixtures = [
        { language: 'py', path: 'service.py', source: 'def run():\n    return 1\n', name: 'run' },
        { language: 'rs', path: 'lib.rs', source: 'fn run() {}\n', name: 'run' },
        { language: 'cs', path: 'Service.cs', source: 'class Service {}\n', name: 'Service' },
        { language: 'c++', path: 'service.cpp', source: 'class Service {};\n', name: 'Service' },
    ];

    for (const fixture of fixtures) {
        const result = await analyzer.analyze({
            content: fixture.source,
            language: fixture.language,
            relativePath: fixture.path,
        });
        assert.equal(result.backend, 'tree_sitter_wasm');
        assert.equal(result.structuralStatus, 'complete');
        assert.ok(result.symbols.some((symbol) => symbol.name === fixture.name));
    }
});

test('missing Tree-sitter assets degrade to searchable recovered text', async () => {
    const analyzer = createLanguageAnalysisService({ assetRoot: '/definitely/missing/satori-assets' });
    const source = 'def run():\n    return 1\n';
    const result = await analyzer.analyze({
        content: source,
        language: 'python',
        relativePath: 'src/service.py',
    });

    assert.equal(result.backend, 'tree_sitter_wasm');
    assert.equal(result.structuralStatus, 'recovered');
    assert.deepEqual(result.symbols, []);
    assert.ok(result.chunks.some((chunk) => chunk.content.includes('def run')));
});

const wasmLanguageFixtures = [
    {
        language: 'go',
        relativePath: 'main.go',
        content: 'package main\nfunc run() int { return 1 }\n',
        expected: { kind: 'function', name: 'run' },
    },
    {
        language: 'rust',
        relativePath: 'src/lib.rs',
        content: 'pub struct Service;\nimpl Service { pub fn run(&self) -> i32 { 1 } }\n',
        expected: { kind: 'struct', name: 'Service' },
    },
    {
        language: 'java',
        relativePath: 'src/Service.java',
        content: 'class Service { int run() { return 1; } }\n',
        expected: { kind: 'class', name: 'Service' },
    },
    {
        language: 'csharp',
        relativePath: 'src/Service.cs',
        content: 'class Service { int Run() { return 1; } }\n',
        expected: { kind: 'class', name: 'Service' },
    },
    {
        language: 'cpp',
        relativePath: 'src/service.cpp',
        content: 'class Service {};\nint run() { return 1; }\n',
        expected: { kind: 'class', name: 'Service' },
    },
    {
        language: 'scala',
        relativePath: 'src/Service.scala',
        content: 'class Service { def run(): Int = 1 }\n',
        expected: { kind: 'class', name: 'Service' },
    },
] as const;

for (const fixture of wasmLanguageFixtures) {
    test(`language analysis extracts ${fixture.language} symbols through Tree-sitter WASM`, async () => {
        const analyzer = createLanguageAnalysisService();
        const result = await analyzer.analyze(fixture);

        assert.equal(result.backend, 'tree_sitter_wasm');
        assert.equal(result.structuralStatus, 'complete');
        assert.ok(result.symbols.some((symbol) => (
            symbol.kind === fixture.expected.kind && symbol.name === fixture.expected.name
        )));
    });
}

test('malformed structural source remains searchable without authoritative symbols', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: 'def broken(:\n    return 1\n',
        language: 'python',
        relativePath: 'src/broken.py',
    });

    assert.equal(result.structuralStatus, 'recovered');
    assert.deepEqual(result.symbols, []);
    assert.ok(result.chunks.length > 0);
});

test('unsupported languages use bounded search-only fallback', async () => {
    const analyzer = createLanguageAnalysisService();
    const result = await analyzer.analyze({
        content: '# Heading\n\nText',
        language: 'markdown',
        relativePath: 'README.md',
    });

    assert.equal(result.backend, 'recursive_text');
    assert.equal(result.structuralStatus, 'unsupported');
    assert.deepEqual(result.symbols, []);
    assert.ok(result.chunks.length > 0);
});
