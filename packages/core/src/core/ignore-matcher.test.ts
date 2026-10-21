import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexIgnoreMatcher } from './ignore-matcher';
import { DEFAULT_IGNORE_PATTERNS } from '../config/defaults';

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

test('overridable defaults exclude nested artifacts until a user rule re-includes them', () => {
    const defaults = createIndexIgnoreMatcher(DEFAULT_IGNORE_PATTERNS);
    for (const artifact of ['.venv/lib/x.py', 'svc/venv/lib/x.py', 'vendor/a/b.go', 'apps/web/.next/x.js',
        'web/.turbo/x.js', 'android/.gradle/x.java', 'ios/Pods/x.m', 'infra/.terraform/x.tf', 'pkg/a.egg-info/x.py']) {
        assert.equal(defaults.ignores(artifact), true, artifact);
    }
    assert.equal(defaults.ignores('src/vendor.ts'), false);
    assert.equal(defaults.ignores('src/venv_utils.py'), false);
    const reincluded = createIndexIgnoreMatcher([...DEFAULT_IGNORE_PATTERNS, '!vendor']);
    assert.equal(reincluded.ignores('vendor/a/b.go'), false);
    assert.equal(reincluded.ignores('node_modules/a/i.js'), true);
});

test('defaults exclude agent worktrees, codegen and secrets but keep other generated code', () => {
    const defaults = createIndexIgnoreMatcher(DEFAULT_IGNORE_PATTERNS);
    for (const artifact of ['.claude/worktrees/w/src/a.ts', 'tools/.claude/worktrees/w/a.ts', '.worktrees/w/a.ts',
        'web/cypress/videos/a.json', 'third_party/lib/a.c', 'api/user.pb.go', 'infra/prod.tfvars', 'infra/terraform.tfstate']) {
        assert.equal(defaults.ignores(artifact), true, artifact);
    }
    // Search ranks generated code down instead; the search-quality fixture expects it indexed.
    assert.equal(defaults.ignores('src/generated/client.generated.ts'), false);
    assert.equal(defaults.ignores('.claude/skills/a.md'), false);
    const reincluded = createIndexIgnoreMatcher([...DEFAULT_IGNORE_PATTERNS, '!*.tfvars', '!third_party']);
    assert.equal(reincluded.ignores('third_party/lib/a.c'), false);
    assert.equal(reincluded.ignores('infra/prod.tfvars'), true);
});
