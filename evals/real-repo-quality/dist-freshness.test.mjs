// Proves the dist-staleness failure path. The regression this guards against is
// silent: without the check, an unbuilt src edit produces numbers from the
// previous build while provenance records the current commit. So the test does
// the thing that used to be invisible -- touch a src file -- and asserts the
// harness refuses rather than scoring a stale artifact.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    DistStaleError,
    assertDistFresh,
    assertRuntimeDistFresh,
    checkDistFreshness,
    formatViolations,
    importFreshDist,
    srcPathForDistModule,
} from './dist-freshness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'dist-freshness.mjs');

/** Minimal packages/<pkg>/{src,dist} workspace with one mirrorable module. */
function makeWorkspace({ pkg = 'mcp', name = 'thing' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-dist-freshness-'));
    const distRelPath = `packages/${pkg}/dist/core/${name}.js`;
    const srcRelPath = `packages/${pkg}/src/core/${name}.ts`;
    const distAbs = path.join(root, distRelPath);
    const srcAbs = path.join(root, srcRelPath);
    fs.mkdirSync(path.dirname(distAbs), { recursive: true });
    fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
    fs.writeFileSync(distAbs, `export const built = ${JSON.stringify('v1')};\n`);
    fs.writeFileSync(srcAbs, `export const built = ${JSON.stringify('v1')};\n`);
    // dist strictly newer than src: a current build.
    const t = new Date('2026-01-02T00:00:00Z');
    fs.utimesSync(distAbs, t, t);
    const t0 = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(srcAbs, t0, t0);
    return { root, distRelPath, srcRelPath, distAbs, srcAbs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('srcPathForDistModule maps a dist module to the src file it is built from', () => {
    assert.equal(srcPathForDistModule('packages/mcp/dist/core/search-flags.js'), 'packages/mcp/src/core/search-flags.ts');
    assert.equal(srcPathForDistModule('packages/core/dist/language-analysis/service.js'), 'packages/core/src/language-analysis/service.js'.replace(/\.js$/, '.ts'));
    // Anything outside the buildable shape is reported, not silently accepted.
    assert.equal(srcPathForDistModule('evals/real-repo-quality/run.mjs'), null);
    assert.equal(srcPathForDistModule('packages/mcp/dist/core/search-flags.mjs'), null);
});

test('runtime preflight rejects an unbuilt child-server dependency', () => {
    const ws = makeWorkspace({ pkg: 'mcp', name: 'search-request-coordinator' });
    try {
        assert.doesNotThrow(() => assertRuntimeDistFresh(ws.root, ['mcp']));
        fs.utimesSync(ws.srcAbs, new Date('2026-06-01'), new Date('2026-06-01'));
        assert.throws(() => assertRuntimeDistFresh(ws.root, ['mcp']), /search-request-coordinator/);
    } finally {
        ws.cleanup();
    }
});

test('runtime preflight rejects a newly added source with no built output', () => {
    const ws = makeWorkspace({ pkg: 'mcp' });
    try {
        fs.writeFileSync(path.join(ws.root, 'packages/mcp/src/core/new-service.ts'), 'export const changed = true;');
        assert.throws(() => assertRuntimeDistFresh(ws.root, ['mcp']), /dist file is missing/);
    } finally {
        ws.cleanup();
    }
});

test('a current build produces no violation and imports successfully', async () => {
    const ws = makeWorkspace();
    try {
        assert.deepEqual(checkDistFreshness(ws.root, [ws.distRelPath]), []);
        assert.doesNotThrow(() => assertDistFresh(ws.root, [ws.distRelPath]));
        // The import itself works, so the guard is not refusing valid runs.
        const ns = await importFreshDist(ws.root, ws.distRelPath);
        assert.equal(ns.built, 'v1');
    } finally {
        ws.cleanup();
    }
});

test('touching a src file fails the guard, naming the src, the dist, and the rebuild', () => {
    // This is the failure path the whole guard exists for: the src file changes
    // and the build does not.
    const ws = makeWorkspace();
    try {
        const now = new Date('2026-06-01T00:00:00Z');
        fs.utimesSync(ws.srcAbs, now, now);

        const violations = checkDistFreshness(ws.root, [ws.distRelPath]);
        assert.equal(violations.length, 1);
        assert.equal(violations[0].distRelPath, ws.distRelPath);
        assert.equal(violations[0].srcRelPath, ws.srcRelPath);
        assert.match(violations[0].reason, /src is newer than dist/);

        assert.throws(
            () => assertDistFresh(ws.root, [ws.distRelPath]),
            (err) => {
                assert.ok(err instanceof DistStaleError, 'must be a DistStaleError so run.mjs can report it as a config failure');
                assert.match(err.message, /stale build: 1 harness import\(s\) are older than the source they were built from/);
                assert.match(err.message, /rebuild: pnpm --filter @satori-code\/mcp build/);
                assert.ok(err.message.includes(ws.distRelPath), 'the message must name the stale dist module');
                assert.ok(err.message.includes(ws.srcRelPath), 'the message must name the src file that is newer');
                return true;
            },
        );
    } finally {
        ws.cleanup();
    }
});

test('importFreshDist refuses to import a stale build', async () => {
    const ws = makeWorkspace();
    try {
        const now = new Date('2026-06-01T00:00:00Z');
        fs.utimesSync(ws.srcAbs, now, now);
        await assert.rejects(
            () => importFreshDist(ws.root, ws.distRelPath),
            (err) => {
                assert.ok(err instanceof DistStaleError);
                assert.match(err.message, /src is newer than dist/);
                return true;
            },
            'a stale module must not be imported, because importing it is how the wrong number gets produced',
        );
    } finally {
        ws.cleanup();
    }
});

test('the CLI exits non-zero with a clear message on a stale build', () => {
    const ws = makeWorkspace();
    try {
        const now = new Date('2026-06-01T00:00:00Z');
        fs.utimesSync(ws.srcAbs, now, now);
        const res = (() => {
            try {
                return { code: 0, out: execFileSync(process.execPath, [GUARD, '--workspace', ws.root, ws.distRelPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
            } catch (e) {
                return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
            }
        })();
        assert.equal(res.code, 1, 'a stale build must exit non-zero, not 0 and not a crash');
        assert.match(res.out, /^FATAL: stale build: 1 harness import\(s\)/m);
        assert.ok(res.out.includes(ws.srcRelPath));
    } finally {
        ws.cleanup();
    }
});

test('a missing dist file is a violation, not a later ERR_MODULE_NOT_FOUND', () => {
    const ws = makeWorkspace();
    try {
        fs.rmSync(ws.distAbs);
        const violations = checkDistFreshness(ws.root, [ws.distRelPath]);
        assert.equal(violations.length, 1);
        assert.match(violations[0].reason, /dist file is missing \(build the package\)/);
        assert.throws(() => assertDistFresh(ws.root, [ws.distRelPath]), /dist file is missing/);
    } finally {
        ws.cleanup();
    }
});

test('formatViolations is usable on its own for a pre-run report', () => {
    const text = formatViolations([{ distRelPath: 'packages/mcp/dist/core/x.js', srcRelPath: 'packages/mcp/src/core/x.ts', reason: 'src is newer than dist', distMtime: 1, srcMtime: 2 }]);
    assert.match(text, /packages\/mcp\/dist\/core\/x\.js/);
    assert.match(text, /1970-01-01T00:00:00\.001Z/);
});
