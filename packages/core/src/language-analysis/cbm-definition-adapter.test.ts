import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithCbmDefinitions, supportsCbmDefinitions, symbolsFromCbmDefinitions } from './cbm-definition-adapter';

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
