import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ignore from 'ignore';
import { createIndexIgnoreMatcher } from './ignore-matcher';
import {
    computeIndexPolicyControlSignature,
    observeFileBasedIgnorePatterns,
    observeIndexPolicyInputs,
} from './index-policy-input-observer';

function createRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'satori-index-policy-inputs-'));
}

test('policy observation preserves root anchoring and cross-file rule order', async () => {
    const root = createRoot();
    try {
        assert.deepEqual((await observeIndexPolicyInputs(root)).fileBasedIgnorePatterns, []);

        fs.writeFileSync(path.join(root, '.satoriignore'), 'data/\n', 'utf8');
        let observed = await observeIndexPolicyInputs(root);
        assert.deepEqual(observed.fileBasedIgnorePatterns, ['data/']);
        assert.equal(ignore().add(observed.fileBasedIgnorePatterns).ignores('src/data/value.ts'), true);

        fs.writeFileSync(path.join(root, '.satoriignore'), '/data/\n', 'utf8');
        observed = await observeIndexPolicyInputs(root);
        const anchoredMatcher = ignore().add(observed.fileBasedIgnorePatterns);
        assert.equal(anchoredMatcher.ignores('data/value.ts'), true);
        assert.equal(anchoredMatcher.ignores('src/data/value.ts'), false);

        fs.writeFileSync(path.join(root, '.satoriignore'), 'data/\n', 'utf8');
        fs.writeFileSync(path.join(root, '.gitignore'), '!data/\n!data/keep.ts\n', 'utf8');
        observed = await observeIndexPolicyInputs(root);
        assert.deepEqual(observed.fileBasedIgnorePatterns, [
            '!data/',
            '!data/keep.ts',
            'data/',
        ]);
        assert.equal(ignore().add(observed.fileBasedIgnorePatterns).ignores('data/keep.ts'), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('control signatures detect same-size replacement and deletion', async () => {
    const root = createRoot();
    const ignorePath = path.join(root, '.satoriignore');
    try {
        fs.writeFileSync(ignorePath, 'data/\n', 'utf8');
        const initial = await computeIndexPolicyControlSignature(root);
        const originalTimes = fs.statSync(ignorePath);

        fs.writeFileSync(ignorePath, '/data\n', 'utf8');
        fs.utimesSync(ignorePath, originalTimes.atime, originalTimes.mtime);
        const replaced = await computeIndexPolicyControlSignature(root);
        assert.notEqual(replaced, initial);

        fs.rmSync(ignorePath);
        const deleted = await computeIndexPolicyControlSignature(root);
        assert.notEqual(deleted, replaced);
        assert.match(deleted, /^v1:\.satoriignore:missing\|/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('policy observation rejects oversized control files', async () => {
    const root = createRoot();
    try {
        fs.writeFileSync(path.join(root, '.satoriignore'), Buffer.alloc(1_048_577, 0x78));
        await assert.rejects(
            () => observeIndexPolicyInputs(root),
            /exceeds the 1048576-byte policy limit/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function write(root: string, relativePath: string, content: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

test('.satoriignore takes precedence over .gitignore in both directions', async () => {
    const root = createRoot();
    try {
        write(root, '.gitignore', '*.gen.ts\n!legacy/\n');
        write(root, '.satoriignore', '!keep.gen.ts\nlegacy/\n');
        const patterns = (await observeIndexPolicyInputs(root)).fileBasedIgnorePatterns;
        const matcher = createIndexIgnoreMatcher(patterns);
        assert.equal(matcher.ignores('src/other.gen.ts'), true);
        assert.equal(matcher.ignores('keep.gen.ts'), false);
        assert.equal(matcher.ignores('legacy/a.ts'), true);
        assert.deepEqual(await observeFileBasedIgnorePatterns(root), patterns);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('nested .gitignore files and .git/info/exclude are ordered by git precedence below .satoriignore', async () => {
    const root = createRoot();
    try {
        write(root, '.git/info/exclude', 'excluded.ts\n');
        write(root, '.gitignore', 'root.ts\n');
        write(root, 'b/.gitignore', '/b-only.ts\n');
        write(root, 'a/.gitignore', '*.tmpfile\n');
        write(root, 'a/deep/.gitignore', '!keep.tmpfile\n');
        write(root, '.satoriignore', 'last.ts\n');
        const observed = await observeIndexPolicyInputs(root);
        assert.deepEqual(observed.fileBasedIgnorePatterns, [
            'excluded.ts',
            'root.ts',
            'a/**/*.tmpfile',
            'b/b-only.ts',
            '!a/deep/**/keep.tmpfile',
            'last.ts',
        ]);
        const matcher = createIndexIgnoreMatcher(observed.fileBasedIgnorePatterns);
        assert.equal(matcher.ignores('a/x/y.tmpfile'), true);
        assert.equal(matcher.ignores('a/deep/keep.tmpfile'), false);
        assert.equal(matcher.ignores('b/b-only.ts'), true);
        assert.equal(matcher.ignores('c/b-only.ts'), false);
        assert.equal(matcher.ignores('excluded.ts'), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('control signature is unchanged without nested ignore inputs and tracks them when present', async () => {
    const root = createRoot();
    try {
        write(root, '.satoriignore', 'data/\n');
        const baseline = await computeIndexPolicyControlSignature(root);
        assert.match(baseline, /^v1:\.satoriignore:sha256:[0-9a-f]{64}:6\|\.gitignore:missing\|satori\.toml:missing$/);

        write(root, 'pkg/.gitignore', 'a\n');
        const withNested = await computeIndexPolicyControlSignature(root);
        assert.equal(withNested.startsWith(`${baseline}|pkg/.gitignore:sha256:`), true);

        write(root, 'pkg/.gitignore', 'b\n');
        const edited = await computeIndexPolicyControlSignature(root);
        assert.notEqual(edited, withNested);

        write(root, '.git/info/exclude', 'x\n');
        const withExclude = await computeIndexPolicyControlSignature(root);
        assert.equal(withExclude.startsWith(`${baseline}|.git/info/exclude:sha256:`), true);
        assert.equal(withExclude.includes('|pkg/.gitignore:sha256:'), true);

        fs.rmSync(path.join(root, 'pkg/.gitignore'));
        fs.rmSync(path.join(root, '.git'), { recursive: true });
        assert.equal(await computeIndexPolicyControlSignature(root), baseline);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('nested discovery prunes ignored directories and never follows symlinks', async () => {
    const root = createRoot();
    const outside = createRoot();
    try {
        // Reading any of these would throw (oversized or symlinked), so a pass proves they were not entered.
        fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules/pkg/.gitignore'), Buffer.alloc(1_048_577, 0x78));
        fs.mkdirSync(path.join(root, 'vendor/x'), { recursive: true });
        fs.writeFileSync(path.join(root, 'vendor/x/.gitignore'), Buffer.alloc(1_048_577, 0x78));
        fs.mkdirSync(path.join(root, 'gen/x'), { recursive: true });
        fs.writeFileSync(path.join(root, 'gen/x/.gitignore'), Buffer.alloc(1_048_577, 0x78));
        write(root, '.gitignore', 'vendor/\n');
        write(root, '.satoriignore', 'gen/\n');
        write(outside, '.gitignore', 'from-outside\n');
        fs.symlinkSync(outside, path.join(root, 'linked'));
        write(root, 'src/.gitignore', 'seen\n');

        const observed = await observeIndexPolicyInputs(root);
        assert.deepEqual(observed.fileBasedIgnorePatterns, ['vendor/', 'src/**/seen', 'gen/']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('a nested .gitignore that is a symlink or oversized is rejected', async () => {
    const root = createRoot();
    try {
        write(root, 'pkg/real.txt', 'x\n');
        fs.symlinkSync(path.join(root, 'pkg/real.txt'), path.join(root, 'pkg/.gitignore'));
        await assert.rejects(() => observeIndexPolicyInputs(root), /pkg\/\.gitignore' must not be a symbolic link/);
        fs.rmSync(path.join(root, 'pkg/.gitignore'));
        fs.writeFileSync(path.join(root, 'pkg/.gitignore'), Buffer.alloc(1_048_577, 0x78));
        await assert.rejects(() => observeIndexPolicyInputs(root), /pkg\/\.gitignore exceeds the 1048576-byte policy limit/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('.git/info/exclude is read only when .git is a directory and the file is regular', async () => {
    const root = createRoot();
    try {
        write(root, '.git', 'gitdir: ../elsewhere\n');
        assert.deepEqual((await observeIndexPolicyInputs(root)).fileBasedIgnorePatterns, []);
        fs.rmSync(path.join(root, '.git'));
        fs.mkdirSync(path.join(root, '.git/info'), { recursive: true });
        write(root, 'target.txt', 'x\n');
        fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, '.git/info/exclude'));
        assert.deepEqual((await observeIndexPolicyInputs(root)).fileBasedIgnorePatterns, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reused control observations match a fresh observation after every kind of control-input change', async (t) => {
    // Freezing the clock ahead makes every write look settled, so observations
    // are cached; a fresh copy of the tree has no cache entry and is the oracle.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 30_000 });
    const root = createRoot();
    const copies: string[] = [];
    const outcome = async (target: string) => {
        try {
            const observed = await observeIndexPolicyInputs(target);
            return { signature: observed.controlSignature, patterns: observed.fileBasedIgnorePatterns };
        } catch (error) {
            return { error: (error as Error).message };
        }
    };
    const expectFresh = async (step: string) => {
        const copy = createRoot();
        copies.push(copy);
        fs.cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
        const expected = await outcome(copy);
        assert.deepEqual(await outcome(root), expected, step);
        assert.deepEqual(await outcome(root), expected, `${step} (reused)`);
    };
    try {
        write(root, '.gitignore', 'node_modules/\n');
        write(root, 'src/.gitignore', 'gen-a/\n');
        write(root, 'src/a/value.ts', 'export {};\n');
        write(root, 'node_modules/pkg/.gitignore', 'hidden/\n');
        await expectFresh('initial');

        write(root, 'src/.gitignore', 'gen-b/\n');
        await expectFresh('nested .gitignore edited in place');
        write(root, 'src/b/.gitignore', 'out/\n');
        await expectFresh('new directory with a .gitignore');
        write(root, 'src/a/.gitignore', '*.log\n');
        await expectFresh('.gitignore added to a walked directory');
        fs.rmSync(path.join(root, 'src/.gitignore'));
        await expectFresh('nested .gitignore deleted');
        fs.mkdirSync(path.join(root, '.git'));
        await expectFresh('.git directory created');
        write(root, '.git/info/exclude', 'secret/\n');
        await expectFresh('.git/info/exclude added');
        write(root, '.git/info/exclude', 'public/\n');
        await expectFresh('.git/info/exclude edited');
        write(root, '.satoriignore', 'data/\n');
        await expectFresh('root .satoriignore added');
        write(root, '.gitignore', 'dist/\n');
        await expectFresh('root .gitignore stops pruning a directory');
        fs.renameSync(path.join(root, 'src/b'), path.join(root, 'src/c'));
        await expectFresh('directory renamed');
        fs.rmSync(path.join(root, 'src/c/.gitignore'));
        fs.symlinkSync(path.join(root, '.gitignore'), path.join(root, 'src/c/.gitignore'));
        await expectFresh('nested .gitignore replaced by a symlink');
        fs.rmSync(path.join(root, 'src/c/.gitignore'));
        await expectFresh('symlink removed');
    } finally {
        for (const directory of [root, ...copies]) fs.rmSync(directory, { recursive: true, force: true });
    }
});
