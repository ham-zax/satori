import test from 'node:test';
import assert from 'node:assert/strict';
import ignore from 'ignore';
import { translateNestedGitignorePatterns } from './ignore-file-inputs';

function matcherFor(directory: string, patterns: string[]) {
    return ignore().add(translateNestedGitignorePatterns(directory, patterns));
}

test('translation anchors slash-containing and leading-slash patterns to the directory', () => {
    assert.deepEqual(
        translateNestedGitignorePatterns('pkg', ['/dist', 'src/gen', 'a/b/']),
        ['pkg/dist', 'pkg/src/gen', 'pkg/a/b/'],
    );
    const matcher = matcherFor('pkg', ['/dist', 'src/gen']);
    assert.equal(matcher.ignores('pkg/dist'), true);
    assert.equal(matcher.ignores('pkg/deep/dist'), false);
    assert.equal(matcher.ignores('pkg/src/gen'), true);
    assert.equal(matcher.ignores('other/dist'), false);
});

test('translation makes slashless patterns match at any depth below the directory only', () => {
    assert.deepEqual(
        translateNestedGitignorePatterns('pkg', ['*.gen.ts', 'cache']),
        ['pkg/**/*.gen.ts', 'pkg/**/cache'],
    );
    const matcher = matcherFor('pkg', ['*.gen.ts']);
    assert.equal(matcher.ignores('pkg/a.gen.ts'), true);
    assert.equal(matcher.ignores('pkg/x/y/a.gen.ts'), true);
    assert.equal(matcher.ignores('a.gen.ts'), false);
    assert.equal(matcher.ignores('sibling/a.gen.ts'), false);
});

test('translation keeps negation and treats a trailing slash as directory-only', () => {
    assert.deepEqual(
        translateNestedGitignorePatterns('pkg', ['!keep.ts', '!/root.ts', 'foo/', '!a/b']),
        ['!pkg/**/keep.ts', '!pkg/root.ts', 'pkg/**/foo/', '!pkg/a/b'],
    );
    const matcher = matcherFor('pkg', ['*.ts', '!keep.ts']);
    assert.equal(matcher.ignores('pkg/a.ts'), true);
    assert.equal(matcher.ignores('pkg/sub/keep.ts'), false);

    const dirOnly = matcherFor('pkg', ['foo/']);
    assert.equal(dirOnly.ignores('pkg/x/foo/file.ts'), true);
    assert.equal(dirOnly.ignores('pkg/foo'), false);
});

test('translation handles nested directories and literal glob characters in directory names', () => {
    assert.deepEqual(
        translateNestedGitignorePatterns('a/b', ['/x', 'y/z', 'w']),
        ['a/b/x', 'a/b/y/z', 'a/b/**/w'],
    );
    assert.deepEqual(
        translateNestedGitignorePatterns('#odd[dir]', ['w']),
        ['\\#odd\\[dir\\]/**/w'],
    );
    const matcher = matcherFor('#odd[dir]', ['w']);
    assert.equal(matcher.ignores('#odd[dir]/w'), true);
    assert.equal(matcher.ignores('#oddd/w'), false);
});
