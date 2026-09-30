import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeWithOxc } from './oxc-adapter';
import { recoverFlowSymbols } from './flow-recovery';
import { createLanguageAnalysisService } from './service';

test('JavaScript files accept JSX while retaining ordinary JavaScript evidence', () => {
    const source = 'export function Greeting() { return <div>Hello</div>; }';
    const js = analyzeWithOxc({ content: source, language: 'javascript', relativePath: 'Greeting.js' });
    const jsx = analyzeWithOxc({ content: source, language: 'jsx', relativePath: 'Greeting.jsx' });
    assert.equal(js.complete, true);
    assert.deepEqual(js.symbols, jsx.symbols);
    const plain = analyzeWithOxc({ content: 'export function add(a, b) { return a + b; }', language: 'javascript', relativePath: 'add.js' });
    assert.equal(plain.complete, true);
    assert.equal(plain.symbols[0]?.name, 'add');
});

for (const backend of ['oxc', 'flow'] as const) {
    const extract = (source: string) => backend === 'oxc'
        ? analyzeWithOxc({ content: source, language: 'javascript', relativePath: 'fixture.js' }).symbols
        : recoverFlowSymbols(source, 'fixture.js');

    test(`${backend} extracts assigned callables including conditional implementations`, () => {
        const source = [
            'let warnForMissingKey = () => {};',
            'if (__DEV__) {',
            '  warnForMissingKey = (child) => { warn(child); };',
            '}',
            'module.exports.f = function (value) { return value; };',
            'Foo.prototype.m = () => work();',
        ].join('\n');
        const symbols = extract(source);
        const warnings = symbols.filter((symbol) => symbol.name === 'warnForMissingKey');
        assert.equal(warnings.length, 2);
        assert.deepEqual(warnings.map((symbol) => [symbol.span.startLine, symbol.span.endLine]), [[1, 1], [3, 3]]);
        assert.equal(symbols.find((symbol) => symbol.qualifiedName === 'module.exports.f')?.kind, 'function');
        assert.equal(symbols.find((symbol) => symbol.qualifiedName === 'Foo.prototype.m')?.kind, 'function');
    });

    test(`${backend} extracts nested suite and registration callbacks with precise spans`, () => {
        const source = [
            'describe("children", () => {',
            '  it("warns about keys", () => { warnForMissingKey(child); });',
            '});',
            'server.tool("find-symbol", { description: "Search" }, async (input) => {',
            '  return findSymbol(input);',
            '});',
            'app.get("/health", (request, response) => response.send("ok"));',
            'function ordinary() { values.map((value) => value + 1); }',
        ].join('\n');
        const symbols = extract(source);
        const suite = symbols.find((symbol) => symbol.name === 'describe("children") callback');
        const inner = symbols.find((symbol) => symbol.name === 'it("warns about keys") callback');
        assert.ok(suite);
        assert.ok(inner);
        assert.deepEqual(inner.parentQualifiedNamePath, [suite.name]);
        assert.equal(inner.span.startLine, 2);
        assert.equal(inner.span.endLine, 2);
        const tool = symbols.find((symbol) => symbol.name === 'server.tool("find-symbol") callback');
        assert.ok(tool);
        assert.equal(tool.span.startLine, 4);
        assert.equal(tool.span.endLine, 6);
        assert.equal(Buffer.from(source).subarray(tool.span.startByte, tool.span.endByte).toString(), 'async (input) => {\n  return findSymbol(input);\n}');
        assert.ok(symbols.some((symbol) => symbol.name === 'app.get("/health") callback'));
        assert.ok(!symbols.some((symbol) => symbol.name.includes('map(')));
    });
}

test('JSX and registration bodies become searchable chunks with callable owners', async () => {
    const analyzer = createLanguageAnalysisService({ chunkSize: 2500, chunkOverlap: 300 });
    const result = await analyzer.analyze({
        language: 'javascript', relativePath: 'test.js',
        content: 'describe("rendering", () => {\n  it("renders children", () => {\n    expect(render(<Child />)).toBeTruthy();\n  });\n});',
    });
    assert.equal(result.structuralStatus, 'complete');
    assert.ok(result.chunks.some((chunk) => chunk.metadata.symbolLabel?.includes('it("renders children") callback')));
});
