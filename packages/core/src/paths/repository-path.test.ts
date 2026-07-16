import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    canonicalizeRepositoryRelativePath,
    isRepositoryRelativePath,
    validateRepositoryRelativePath,
} from './repository-path.js';

test('repository-relative path validation accepts only canonical portable paths', () => {
    assert.equal(isRepositoryRelativePath('src/http/parser.ts'), true);
    for (const invalid of [
        '',
        '/src/http/parser.ts',
        'C:/src/http/parser.ts',
        'src\\http\\parser.ts',
        './src/http/parser.ts',
        'src/../http/parser.ts',
        'src//http/parser.ts',
        'src/\0parser.ts',
    ]) {
        assert.equal(isRepositoryRelativePath(invalid), false, invalid);
        assert.throws(
            () => validateRepositoryRelativePath(invalid),
            /canonical repository-relative path/,
            invalid,
        );
    }
});

test('repository-relative path canonicalization produces one identity for equivalent forms', () => {
    const root = path.resolve('/repo');
    assert.equal(canonicalizeRepositoryRelativePath(root, path.join(root, 'src', 'owner.ts')), 'src/owner.ts');
    assert.equal(canonicalizeRepositoryRelativePath(root, './src//owner.ts'), 'src/owner.ts');
    assert.equal(canonicalizeRepositoryRelativePath(root, 'src/'), 'src');
    assert.equal(canonicalizeRepositoryRelativePath(root, 'src\\owner.ts'), 'src/owner.ts');
    assert.equal(canonicalizeRepositoryRelativePath(root, 'src/../owner.ts'), 'owner.ts');
    assert.equal(
        canonicalizeRepositoryRelativePath(root, path.join(root, 'src', ' spaced.ts ')),
        'src/ spaced.ts ',
    );
});

test('repository-relative path canonicalization rejects roots and outside paths', () => {
    const root = path.resolve('/repo');
    assert.equal(canonicalizeRepositoryRelativePath(root, root), null);
    assert.equal(canonicalizeRepositoryRelativePath(root, path.resolve(root, '..', 'outside.ts')), null);
    if (process.platform !== 'win32') {
        assert.equal(canonicalizeRepositoryRelativePath(root, 'C:\\repo\\owner.ts'), null);
    }
});
