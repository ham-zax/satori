import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanguageAnalysisService } from '@zokizuan/satori-core';

test('language analysis emits TS class/method breadcrumbs', async () => {
    const analyzer = createLanguageAnalysisService();
    const code = [
        'export class AuthManager {',
        '  async validateSession(token: string) {',
        '    return token.length > 0;',
        '  }',
        '}'
    ].join('\n');

    const { chunks } = await analyzer.analyze({ content: code, language: 'typescript', relativePath: 'auth.ts' });
    const target = chunks.find(
        (chunk) =>
            chunk.content.includes('return token.length > 0;')
            && Array.isArray(chunk.metadata.breadcrumbs)
            && chunk.metadata.symbolLabel === 'method validateSession'
    );
    assert.ok(target);
    assert.deepEqual(target?.metadata.breadcrumbs, ['AuthManager']);
});

test('language analysis emits Python class/function breadcrumbs', async () => {
    const analyzer = createLanguageAnalysisService();
    const code = [
        'class SessionManager:',
        '    async def validate(self, token: str):',
        '        return token',
        ''
    ].join('\n');

    const { chunks } = await analyzer.analyze({ content: code, language: 'python', relativePath: 'auth.py' });
    const target = chunks.find(
        (chunk) =>
            chunk.content.includes('return token')
            && Array.isArray(chunk.metadata.breadcrumbs)
            && chunk.metadata.symbolLabel === 'method validate'
    );
    assert.ok(target);
    assert.deepEqual(target?.metadata.breadcrumbs, ['SessionManager']);
});

test('language analysis emits bounded declaration ancestry', async () => {
    const analyzer = createLanguageAnalysisService();
    const code = [
        'class A {',
        '  outer() {',
        '    const inner = () => {',
        '      return 1;',
        '    };',
        '    return inner();',
        '  }',
        '}'
    ].join('\n');

    const { chunks } = await analyzer.analyze({ content: code, language: 'typescript', relativePath: 'depth.ts' });
    for (const chunk of chunks) {
        if (Array.isArray(chunk.metadata.breadcrumbs)) {
            assert.ok(chunk.metadata.breadcrumbs.length <= 2);
        }
    }
});

test('language analysis preserves breadcrumbs when splitting large chunks', async () => {
    const analyzer = createLanguageAnalysisService({ chunkSize: 80, chunkOverlap: 0 });
    const repeatedBody = Array.from({ length: 30 }, (_, i) => `    const v${i} = token + ${i};`).join('\n');
    const code = [
        'class LargeAuth {',
        '  validate(token: string) {',
        repeatedBody,
        '    return token;',
        '  }',
        '}'
    ].join('\n');

    const { chunks } = await analyzer.analyze({ content: code, language: 'typescript', relativePath: 'large.ts' });
    const methodChunks = chunks.filter((chunk) => chunk.metadata.symbolLabel === 'method validate');
    assert.ok(methodChunks.length > 1);
    for (const chunk of methodChunks) {
        assert.deepEqual(chunk.metadata.breadcrumbs, ['LargeAuth']);
    }
});
