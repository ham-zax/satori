import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtractedSymbol } from '../languages';

import { analyzeWithOxc } from './oxc-adapter';
import { recoverFlowSymbols } from './flow-recovery';
import { createLanguageAnalysisService } from './service';

test('early-exit context includes only an adjacent const for a direct identifier test', async () => {
    const source = [
        'function settle(items: Item[], response: Response) {',
        '  const stale = response.id !== expectedId;',
        '  if (stale) { return; }',
        '  if (items.some((stale) => stale.bad)) { throw new Error(); }',
        '  {',
        '    const stale = response.generation !== generation;',
        '    if (stale) { return undefined; }',
        '  }',
        '  if (response.invalid) return;',
        '}',
    ].join('\n');
    const result = await createLanguageAnalysisService().analyze({
        content: source, language: 'typescript', relativePath: 'settle.ts', includeEarlyExitSpans: true,
    });
    assert.equal(result.structuralStatus, 'complete');
    assert.deepEqual(result.earlyExitSpans?.map(span => [span.startLine, span.endLine]), [
        [2, 3], [4, 4], [6, 7], [9, 9],
    ]);
    const { earlyExitSpans: _spans, ...ordinaryEvidence } = result;
    assert.deepEqual(ordinaryEvidence, await createLanguageAnalysisService().analyze({
        content: source, language: 'typescript', relativePath: 'settle.ts',
    }), 'collecting context preserves every ordinary analysis field');
    for (const span of _spans ?? []) {
        assert.equal(Buffer.from(source).subarray(span.startByte, span.endByte).toString(),
            source.slice(0, source.length).split('\n').slice(span.startLine - 1, span.endLine).join('\n').trim());
    }
});

test('early-exit context respects adjacent statements within a switch case', () => {
    const content = [
        'function settle(state: string, response: Response) {',
        '  switch (state) {',
        '    case "done":',
        '      const stale = response.id !== expectedId;',
        '      if (stale) { return; }',
        '      break;',
        '    default:',
        '      if (response.invalid) throw new Error();',
        '  }',
        '}',
    ].join('\n');
    const result = analyzeWithOxc({ content, language: 'typescript', relativePath: 'settle.ts', includeEarlyExitSpans: true });
    assert.deepEqual(result.earlyExitSpans?.map(span => [span.startLine, span.endLine]), [[4, 5], [8, 8]]);
});

test('early-exit context is opt-in and uses UTF-8 spans for non-ASCII source', () => {
    const content = '// 😀 café\r\nfunction settle(stale: boolean) {\r\n  if (stale) {\r\n    return;\r\n  }\r\n}';
    const input = { content, language: 'typescript', relativePath: 'settle.ts' };
    assert.equal(analyzeWithOxc(input).earlyExitSpans, undefined);
    const result = analyzeWithOxc({ ...input, includeEarlyExitSpans: true });
    assert.equal(result.complete, true);
    assert.deepEqual(result.earlyExitSpans?.map(span => [span.startLine, span.endLine]), [[3, 5]]);
    const span = result.earlyExitSpans?.[0];
    assert.ok(span);
    assert.equal(Buffer.from(content).subarray(span.startByte, span.endByte).toString(), 'if (stale) {\r\n    return;\r\n  }');
});

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


test('module object callable properties have static owners and UTF-8 source spans', () => {
    const properties = [
        'execute: async (value: string) => { return "café " + value; }',
        '"function-key": function implementation() { return "😀"; }',
        'method() { return "méthod"; }',
        '["literal-key"]: () => { return "clé"; }',
    ];
    const content = '// 😀 café\nexport const tool = {\n' + properties.join(',\n') + '\n};\n'
        + 'const other = { execute() { return 2; } };\n'
        + 'function run() { return 1; }';
    const result = analyzeWithOxc({ content, language: 'typescript', relativePath: 'tool.ts' });
    assert.equal(result.complete, true);
    assert.equal(result.symbols.find(symbol => symbol.name === 'tool')?.kind, 'variable');
    for (const [index, name] of ['execute', 'function-key', 'method', 'literal-key'].entries()) {
        const propertySymbol: ExtractedSymbol | undefined = result.symbols.find(candidate => candidate.qualifiedName === `tool.${name}`);
        assert.ok(propertySymbol, name);
        assert.equal(propertySymbol.name, name);
        assert.equal(propertySymbol.kind, 'method');
        assert.deepEqual(propertySymbol.parentQualifiedNamePath, ['tool']);
        assert.equal(propertySymbol.span.startLine, index + 3);
        assert.equal(propertySymbol.span.endLine, index + 3);
        assert.equal(Buffer.from(content).subarray(propertySymbol.span.startByte, propertySymbol.span.endByte).toString(), properties[index]);
    }
    assert.deepEqual(result.symbols.find(symbol => symbol.qualifiedName === 'other.execute')?.parentQualifiedNamePath, ['other']);
    assert.deepEqual(result.symbols.find(symbol => symbol.name === 'run')?.parentQualifiedNamePath, []);
});

test('object ownership does not cross nested, anonymous, local or dynamic property scopes', () => {
    const content = `
const key = "dynamic";
const tool = {
    [key]: () => { dynamicBody(); },
    get getter() { return 1; },
    set setter(value: number) { void value; },
    nested: { hidden: () => { nestedBody(); } },
    execute: () => {
        consume({ anonymous: () => { anonymousBody(); } });
        function helper() { return 1; }
    },
};
consume({ unbound() { return 1; } });
export default { defaultAnonymous: () => 1 };
function run() { const local = { localMethod() { return 1; } }; }
{ const block = { blockMethod() { return 1; } }; }
`;
    const result = analyzeWithOxc({ content, language: 'typescript', relativePath: 'tool.ts' });
    assert.equal(result.complete, true);
    assert.deepEqual(result.symbols.filter(symbol => symbol.kind === 'method').map(symbol => symbol.qualifiedName), ['tool.execute']);
    assert.deepEqual(result.symbols.find(symbol => symbol.name === 'helper')?.parentQualifiedNamePath, []);
    assert.ok(!result.symbols.some(symbol => ['dynamic', 'hidden', 'anonymous', 'unbound', 'defaultAnonymous', 'localMethod', 'blockMethod'].includes(symbol.name)));
});
