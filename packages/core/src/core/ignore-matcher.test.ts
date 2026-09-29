import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexIgnoreMatcher } from './ignore-matcher';

test('user negations cannot re-include built-in denylisted paths', () => {
    const matcher = createIndexIgnoreMatcher([
        'package-lock.json',
        '*.min.js',
        '!package-lock.json',
        '!vendor/x.min.js',
        '!build/',
        '!src/build/keep.ts',
        '!.env',
    ]);
    assert.equal(matcher.ignores('package-lock.json'), true);
    assert.equal(matcher.ignores('vendor/x.min.js'), true);
    assert.equal(matcher.ignores('build/out.ts'), true);
    assert.equal(matcher.ignores('src/build/keep.ts'), true);
    assert.equal(matcher.ignores('.env'), true);
});

test('denylisted directory names match at any depth, including tmp/out/target/logs', () => {
    const matcher = createIndexIgnoreMatcher([]);
    for (const name of ['build', 'out', 'target', 'tmp', 'logs']) {
        assert.equal(matcher.ignores(`${name}/a.ts`), true, name);
        assert.equal(matcher.ignores(`pkg/deep/${name}/a.ts`), true, name);
    }
    assert.equal(matcher.ignores('src/app.ts'), false);
});

test('user patterns still add exclusions and honor their own negations', () => {
    const matcher = createIndexIgnoreMatcher(['*.gen.ts', '!keep.gen.ts']);
    assert.equal(matcher.ignores('a.gen.ts'), true);
    assert.equal(matcher.ignores('keep.gen.ts'), false);
});
