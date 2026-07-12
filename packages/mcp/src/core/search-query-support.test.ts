import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SearchQuerySupport } from './search-query-support.js';
import type { SearchQuerySupportHost } from './search-query-support.js';
import { buildSearchQueryPlan, parseSearchOperators } from './search-query-planning.js';

test('normalizeRelativePathForIgnoreCheck enforces canonical repo-relative identity', () => {
    const support = new SearchQuerySupport({} as SearchQuerySupportHost);

    assert.equal(support.normalizeRelativePathForIgnoreCheck('/etc/passwd'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('C:\\Windows\\system.ini'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('C:secret.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('\\\\server\\share\\file.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src/secret\0.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src/../../outside.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src/./service.ts'), 'src/service.ts');
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src//service.ts'), 'src/service.ts');
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src\\service.ts'), 'src/service.ts');
});

test('exact live-path recovery rejects substring-only whole-token evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-live-path-'));
    const relativePath = 'src/a.ts';
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const support = new SearchQuerySupport({
        getContextActiveIgnorePatterns: () => [],
    } as unknown as SearchQuerySupportHost);
    const run = async (content: string) => {
        fs.writeFileSync(path.join(root, relativePath), content, 'utf8');
        const parsedOperators = parseSearchOperators(`path:${relativePath} auth`);
        return support.buildLivePathScopedSearchResults({
            effectiveRoot: root,
            parsedOperators,
            queryPlan: buildSearchQueryPlan(parsedOperators.semanticQuery, true),
            changedFiles: new Set([relativePath]),
        });
    };

    try {
        assert.deepEqual(await run('const author = true;\n'), []);
        const positive = await run('const auth = true;\n');
        assert.equal(positive.length, 1);
        assert.match(positive[0]?.content ?? '', /\bauth\b/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
