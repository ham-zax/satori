import test from 'node:test';
import assert from 'node:assert/strict';
import { LangChainCodeSplitter } from './langchain-splitter';

test('LangChainCodeSplitter returns deterministic chunks with source metadata', async () => {
    const splitter = new LangChainCodeSplitter(48, 8);
    const code = [
        'function alpha() {',
        '  return 1;',
        '}',
        '',
        'function beta() {',
        '  return 2;',
        '}',
    ].join('\n');

    const chunks = await splitter.split(code, 'typescript', 'src/example.ts');

    assert.ok(chunks.length > 1);
    assert.equal(chunks[0].metadata.startLine, 1);
    assert.equal(chunks[0].metadata.language, 'typescript');
    assert.equal(chunks[0].metadata.filePath, 'src/example.ts');
    assert.ok(chunks.every((chunk) => chunk.content.length <= 48));
    assert.ok(chunks.some((chunk) => chunk.content.includes('function beta')));
    assert.ok(chunks.every((chunk) => chunk.metadata.startLine <= chunk.metadata.endLine));
});

test('LangChainCodeSplitter overlaps long single-line chunks without exceeding chunk size', async () => {
    const splitter = new LangChainCodeSplitter(10, 3);
    const chunks = await splitter.split('abcdefghijklmnopqrstuvwxyz', 'text');

    assert.deepEqual(chunks.map((chunk) => chunk.content), [
        'abcdefghij',
        'hijklmnopq',
        'opqrstuvwx',
        'vwxyz',
    ]);
    assert.ok(chunks.every((chunk) => chunk.metadata.startLine === 1));
});

test('LangChainCodeSplitter clamps invalid sizing inputs and handles empty content', async () => {
    const splitter = new LangChainCodeSplitter(0, 100);

    assert.deepEqual(await splitter.split('', 'text'), []);
    assert.deepEqual(
        (await splitter.split('abc', 'text')).map((chunk) => chunk.content),
        ['a', 'b', 'c']
    );
});
