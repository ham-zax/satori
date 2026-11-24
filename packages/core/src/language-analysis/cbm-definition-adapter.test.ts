import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithCbmDefinitions, supportsCbmDefinitions, symbolsFromCbmDefinitions } from './cbm-definition-adapter';
import { detectLanguageId } from '../language/registry';

test('CBM records map to Satori symbols with parents and UTF-8 byte spans', () => {
    const source = '// é\nclass Shop {\n  fun add() {}\n}\n';
    const classStart = Buffer.byteLength('// é\n');
    const methodStart = Buffer.byteLength('// é\nclass Shop {\n  ');
    const symbols = symbolsFromCbmDefinitions([
        { label: 'Module', name: 'shop.kt', qualifiedName: '', parentClass: '', startLine: 1, endLine: 4, startByte: 0, endByte: 30 },
        { label: 'Class', name: 'Shop', qualifiedName: 'Shop', parentClass: '', startLine: 2, endLine: 4, startByte: classStart, endByte: Buffer.byteLength(source) - 1 },
        { label: 'Method', name: 'add', qualifiedName: 'Shop.add', parentClass: 'Shop', startLine: 3, endLine: 3, startByte: methodStart, endByte: methodStart + 'fun add() {}'.length },
        { label: 'Variable', name: 'items', qualifiedName: 'items', parentClass: '', startLine: 3, endLine: 3, startByte: 0, endByte: 1 },
        { label: 'Table', name: 'users', qualifiedName: 'users', parentClass: '', startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
    ], source);

    assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.label, symbol.qualifiedName, symbol.parentQualifiedNamePath]), [
        ['class', 'class Shop', 'Shop', []],
        ['method', 'method add', 'Shop.add', ['Shop']],
    ]);
    assert.equal(symbols[0].span.startLine, 2);
    assert.equal(symbols[0].span.endLine, 4);
    assert.equal(symbols[1].span.startLine, 3);
    assert.equal(symbols[1].span.startByte, methodStart);
});

test('the Kotlin extractor module yields CBM definitions as Satori symbols', async (context) => {
    if (!supportsCbmDefinitions('kotlin')) {
        context.skip('Kotlin CBM extractor module is not built');
        return;
    }
    const content = [
        'package shop',
        '',
        'class Registry {',
        '    fun add(item: String) { println(item) }',
        '}',
        '',
        'fun total(): Int = 1',
        '',
    ].join('\n');
    const symbols = await analyzeWithCbmDefinitions({ content, relativePath: 'src/Registry.kt', language: 'kotlin' });
    assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.qualifiedName, symbol.span.startLine, symbol.span.endLine]), [
        ['class', 'Registry', 3, 5],
        ['method', 'Registry.add', 4, 4],
        ['function', 'total', 7, 7],
    ]);
    const bytes = Buffer.from(content, 'utf8');
    for (const symbol of symbols) {
        assert.ok(bytes.subarray(symbol.span.startByte, symbol.span.endByte).toString('utf8').includes(symbol.name));
    }
});

const DART_HOLDER_SOURCE = [
    'class Holder {',
    '  final int value;',
    '  const Holder(this.value);',
    '}',
    '',
    'extension HolderMath on Holder {',
    '  int doubled() => value + value;',
    '  int tripled() => value + value + value;',
    "  String describeHolder() => 'holder';",
    '}',
    '',
    'int topLevelHelper(int x) => x + 1;',
    '',
    'extension on String {',
    '  bool isShout() => this == toUpperCase();',
    '}',
    '',
].join('\n');

test('Dart extensions and unnamed extension members yield CBM symbols with exact spans', async (context) => {
    if (!supportsCbmDefinitions('dart')) {
        context.skip('Dart CBM extractor module is not built');
        return;
    }
    assert.equal(detectLanguageId('lib/holder.dart', DART_HOLDER_SOURCE), 'dart');
    const symbols = await analyzeWithCbmDefinitions({
        content: DART_HOLDER_SOURCE,
        relativePath: 'lib/holder.dart',
        language: 'dart',
    });
    const expected = new Map([
        ['Holder', { kind: 'class', parents: [], span: [1, 4], text: 'class Holder {\n  final int value;\n  const Holder(this.value);\n}' }],
        ['HolderMath', { kind: 'class', parents: [], span: [6, 10], text: "extension HolderMath on Holder {\n  int doubled() => value + value;\n  int tripled() => value + value + value;\n  String describeHolder() => 'holder';\n}" }],
        ['HolderMath.doubled', { kind: 'method', parents: ['HolderMath'], span: [7, 7], text: 'int doubled() => value + value;' }],
        ['HolderMath.tripled', { kind: 'method', parents: ['HolderMath'], span: [8, 8], text: 'int tripled() => value + value + value;' }],
        ['HolderMath.describeHolder', { kind: 'method', parents: ['HolderMath'], span: [9, 9], text: "String describeHolder() => 'holder';" }],
        ['topLevelHelper', { kind: 'function', parents: [], span: [12, 12], text: 'int topLevelHelper(int x) => x + 1;' }],
        ['isShout', { kind: 'function', parents: [], span: [15, 15], text: 'bool isShout() => this == toUpperCase();' }],
    ]);
    assert.deepEqual(symbols.map((symbol) => symbol.qualifiedName), [...expected.keys()]);
    const bytes = Buffer.from(DART_HOLDER_SOURCE, 'utf8');
    const lines = DART_HOLDER_SOURCE.replace(/\n$/, '').split('\n');
    for (const symbol of symbols) {
        const qualifiedName = symbol.qualifiedName ?? '';
        const want = expected.get(qualifiedName);
        if (!want) assert.fail(`unexpected symbol ${qualifiedName}`);
        assert.equal(symbol.kind, want.kind, qualifiedName);
        assert.deepEqual(symbol.parentQualifiedNamePath, want.parents, qualifiedName);
        assert.deepEqual([symbol.span.startLine, symbol.span.endLine], want.span, qualifiedName);
        assert.notEqual(symbol.span.startByte, undefined, qualifiedName);
        assert.notEqual(symbol.span.endByte, undefined, qualifiedName);
        assert.equal(bytes.subarray(symbol.span.startByte, symbol.span.endByte).toString('utf8'), want.text, qualifiedName);
        const lineText = lines.slice(symbol.span.startLine - 1, symbol.span.endLine).join('\n');
        assert.ok(lineText.trim().startsWith(want.text), qualifiedName);
    }
});

test('Dart multiline block-body named and unnamed extensions capture full method and function bodies', async (context) => {
    if (!supportsCbmDefinitions('dart')) {
        context.skip('Dart CBM extractor module is not built');
        return;
    }
    const source = [
        'extension Accumulator on int {',
        '  int scaled(int factor) {',
        '    final total = this * factor;',
        '    return total;',
        '  }',
        '}',
        '',
        'extension on String {',
        '  String shoutWrapped() {',
        '    final upper = toUpperCase();',
        '    return "[$upper]";',
        '  }',
        '}',
        '',
    ].join('\n');
    const symbols = await analyzeWithCbmDefinitions({
        content: source,
        relativePath: 'lib/multiline_ext.dart',
        language: 'dart',
    });
    const byQn = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
    const bytes = Buffer.from(source, 'utf8');

    const scaled = byQn.get('Accumulator.scaled');
    assert.ok(scaled);
    assert.equal(scaled.kind, 'method');
    assert.deepEqual(scaled.parentQualifiedNamePath, ['Accumulator']);
    assert.deepEqual([scaled.span.startLine, scaled.span.endLine], [2, 5]);
    assert.equal(
        bytes.subarray(scaled.span.startByte, scaled.span.endByte).toString('utf8'),
        'int scaled(int factor) {\n    final total = this * factor;\n    return total;\n  }',
    );

    const shoutWrapped = byQn.get('shoutWrapped');
    assert.ok(shoutWrapped);
    assert.equal(shoutWrapped.kind, 'function');
    assert.deepEqual(shoutWrapped.parentQualifiedNamePath, []);
    assert.deepEqual([shoutWrapped.span.startLine, shoutWrapped.span.endLine], [9, 12]);
    assert.equal(
        bytes.subarray(shoutWrapped.span.startByte, shoutWrapped.span.endByte).toString('utf8'),
        'String shoutWrapped() {\n    final upper = toUpperCase();\n    return "[$upper]";\n  }',
    );
});

test('Dart comment and documentation_comment before body extend spans without crossing declaration boundaries', async (context) => {
    if (!supportsCbmDefinitions('dart')) {
        context.skip('Dart CBM extractor module is not built');
        return;
    }
    const source = [
        'int lineCommented(int x) // comment before body',
        '{',
        '  return x + 1;',
        '}',
        '',
        'int docCommented(int x)',
        '/// doc comment before body',
        '{',
        '  return x + 2;',
        '}',
        '',
        'abstract class Service {',
        '  void abstractStep();',
        '  // comment after abstract declaration',
        '  /// doc after abstract declaration',
        '  int blockCommented(int x) /* block comment before body */ {',
        '    return x * 2;',
        '  }',
        '}',
        '',
        'external int nativeStep(int x);',
        '// comment after external declaration',
        'int concreteAfterExternal(int x) {',
        '  return x - 1;',
        '}',
        '',
    ].join('\n');
    const symbols = await analyzeWithCbmDefinitions({
        content: source,
        relativePath: 'lib/comment_before_body.dart',
        language: 'dart',
    });
    const byQn = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
    const bytes = Buffer.from(source, 'utf8');
    const spanText = (qn: string): string => {
        const symbol = byQn.get(qn);
        assert.ok(symbol, `missing ${qn}`);
        return bytes.subarray(symbol.span.startByte, symbol.span.endByte).toString('utf8');
    };

    assert.equal(spanText('lineCommented'), 'int lineCommented(int x) // comment before body\n{\n  return x + 1;\n}');
    assert.deepEqual([byQn.get('lineCommented')!.span.startLine, byQn.get('lineCommented')!.span.endLine], [1, 4]);

    assert.equal(spanText('docCommented'), 'int docCommented(int x)\n/// doc comment before body\n{\n  return x + 2;\n}');
    assert.deepEqual([byQn.get('docCommented')!.span.startLine, byQn.get('docCommented')!.span.endLine], [6, 10]);

    assert.equal(
        spanText('Service.blockCommented'),
        'int blockCommented(int x) /* block comment before body */ {\n    return x * 2;\n  }',
    );
    assert.deepEqual([byQn.get('Service.blockCommented')!.span.startLine, byQn.get('Service.blockCommented')!.span.endLine], [16, 18]);

    assert.equal(spanText('nativeStep'), 'int nativeStep(int x)');
    assert.deepEqual([byQn.get('nativeStep')!.span.startLine, byQn.get('nativeStep')!.span.endLine], [21, 21]);

    assert.equal(
        spanText('concreteAfterExternal'),
        'int concreteAfterExternal(int x) {\n  return x - 1;\n}',
    );
    assert.deepEqual([byQn.get('concreteAfterExternal')!.span.startLine, byQn.get('concreteAfterExternal')!.span.endLine], [23, 25]);
});

test('Swift class, nested struct, and labeled/typed methods preserve parentQualifiedNamePath', async (context) => {
    const synthetic = symbolsFromCbmDefinitions([
        {
            label: 'Method',
            name: 'run',
            qualifiedName: 'Outer.Inner.run(withLabel:Foundation.URL)',
            parentClass: 'Outer.Inner',
            startLine: 3,
            endLine: 3,
            startByte: 0,
            endByte: 10,
        },
        {
            label: 'Function',
            name: 'helper',
            qualifiedName: 'Outer.helper(x:Swift.Int)',
            parentClass: '',
            startLine: 4,
            endLine: 4,
            startByte: 0,
            endByte: 10,
        },
    ], 'func run()\n\n\n\n');
    assert.deepEqual(synthetic.map((s) => [s.qualifiedName, s.parentQualifiedNamePath]), [
        ['Outer.Inner.run', ['Outer', 'Inner']],
        ['Outer.helper', ['Outer']],
    ]);

    if (!supportsCbmDefinitions('swift')) {
        context.skip('Swift CBM extractor module is not built');
        return;
    }
    const content = [
        'class Outer {',
        '    struct Inner {',
        '        func run(with label: String, count: Int) -> Int {',
        '            return count',
        '        }',
        '    }',
        '    func greet(to name: String) -> String {',
        '        return name',
        '    }',
        '}',
        '',
    ].join('\n');
    const symbols = await analyzeWithCbmDefinitions({
        content,
        relativePath: 'Sources/Outer.swift',
        language: 'swift',
    });
    const byQn = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
    assert.deepEqual(byQn.get('Outer')?.parentQualifiedNamePath, []);
    assert.deepEqual(byQn.get('Outer.Inner')?.parentQualifiedNamePath, ['Outer']);
    assert.deepEqual(byQn.get('Outer.Inner.run')?.parentQualifiedNamePath, ['Outer', 'Inner']);
    assert.deepEqual(byQn.get('Outer.greet')?.parentQualifiedNamePath, ['Outer']);
});
