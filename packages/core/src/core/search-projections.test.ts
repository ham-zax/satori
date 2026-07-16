import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodeChunk } from '../language-analysis';
import {
    buildSearchProjections,
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
} from './search-projections';

test('buildSearchProjections produces byte-stable v1 text from canonical chunk inputs', () => {
    const chunk: CodeChunk = {
        content: 'export function parseHTTPResponse(raw_value: string): ResultType {\n  return decode(raw_value);\n}',
        metadata: {
            startLine: 10,
            endLine: 12,
            language: 'typescript',
            symbolKind: 'function',
            symbolLabel: 'Parser.parseHTTPResponse',
            breadcrumbs: ['Parser', 'parseHTTPResponse'],
            symbolId: 'ignored-identity-field',
            ownerSymbolInstanceId: 'ignored-relationship-field',
        },
    };

    const first = buildSearchProjections({ chunk, relativePath: 'src/http/parser_utils.ts' });
    const second = buildSearchProjections({
        chunk: {
            content: chunk.content,
            metadata: {
                ...chunk.metadata,
                breadcrumbs: [...(chunk.metadata.breadcrumbs ?? [])],
            },
        },
        relativePath: 'src/http/parser_utils.ts',
    });

    assert.deepEqual(first, second);
    assert.equal(first.embeddingVersion, EMBEDDING_PROJECTION_VERSION);
    assert.equal(first.lexicalVersion, LEXICAL_PROJECTION_VERSION);
    const metadata = '{"path":"src/http/parser_utils.ts","language":"typescript","symbolKind":"function","symbolLabel":"Parser.parseHTTPResponse","breadcrumbs":["Parser","parseHTTPResponse"]}';
    assert.equal(first.embeddingText, [
        `metadata:${metadata}`,
        `content:${chunk.content.length}`,
        chunk.content,
    ].join('\n'));
    assert.equal(first.lexicalText, [
        `content:${chunk.content.length}`,
        chunk.content,
        `metadata:${metadata}`,
        'identifier-components:["parser","utils","parse","HTTP","Response","raw","value","Result","Type"]',
    ].join('\n'));
    assert.ok(!first.embeddingText.includes('ignored-identity-field'));
    assert.ok(!first.lexicalText.includes('ignored-relationship-field'));
});

test('buildSearchProjections preserves original source and identifiers in lexical text', () => {
    const content = 'const snake_case = camelCaseIdentifier + HTTPServer2;';
    const projections = buildSearchProjections({
        relativePath: 'src/example.ts',
        chunk: {
            content,
            metadata: { startLine: 1, endLine: 1 },
        },
    });

    assert.ok(projections.lexicalText.startsWith(`content:${content.length}\n${content}\n`));
    assert.ok(projections.lexicalText.includes('snake_case'));
    assert.ok(projections.lexicalText.includes('camelCaseIdentifier'));
    assert.ok(projections.lexicalText.includes('HTTPServer2'));
    assert.ok(projections.lexicalText.endsWith(
        'identifier-components:["snake","case","camel","Case","Identifier","HTTP","Server2"]',
    ));
});

test('buildSearchProjections rejects noncanonical relative paths deterministically', () => {
    const chunk: CodeChunk = {
        content: 'const value = true;',
        metadata: { startLine: 1, endLine: 1 },
    };
    for (const relativePath of [
        '',
        './src/value.ts',
        '../src/value.ts',
        '/src/value.ts',
        'C:/src/value.ts',
        'src\\value.ts',
        'src//value.ts',
    ]) {
        assert.throws(
            () => buildSearchProjections({ chunk, relativePath }),
            /canonical repository-relative path/,
            relativePath,
        );
    }
});

test('buildSearchProjections serializes newline-bearing metadata without collisions', () => {
    const content = 'const value = true;';
    const pathWithHeaderText = buildSearchProjections({
        relativePath: 'a\nlanguage: typescript',
        chunk: { content, metadata: { startLine: 1, endLine: 1 } },
    });
    const separateLanguage = buildSearchProjections({
        relativePath: 'a',
        chunk: {
            content,
            metadata: { startLine: 1, endLine: 1, language: 'typescript' },
        },
    });

    assert.notEqual(pathWithHeaderText.embeddingText, separateLanguage.embeddingText);
    assert.notEqual(pathWithHeaderText.lexicalText, separateLanguage.lexicalText);
    assert.match(pathWithHeaderText.embeddingText, /"path":"a\\nlanguage: typescript"/);
});
