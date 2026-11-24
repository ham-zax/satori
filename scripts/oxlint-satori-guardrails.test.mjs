import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function lintFixture(relativeName, source) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-guardrails-'));
    try {
        const file = path.join(directory, relativeName);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source, 'utf8');
        return spawnSync(process.execPath, [
            path.join(root, 'node_modules/oxlint/bin/oxlint'),
            '--config', path.join(root, '.oxlintrc.json'), '--threads=1', file,
        ], { cwd: root, encoding: 'utf8' });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('satori-guardrails rejects raw git exec in production files but allows tests', () => {
    const bad = lintFixture(
        'src/sample.ts',
        'import { execFileSync } from "node:child_process";\nexport const out = execFileSync("git", ["status"]);\n',
    );
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /no-raw-git-exec/);

    const allowedInTest = lintFixture(
        'src/sample.test.ts',
        'import { execFileSync } from "node:child_process";\nexport const out = execFileSync("git", ["status"]);\n',
    );
    assert.equal(allowedInTest.status, 0, allowedInTest.stdout + allowedInTest.stderr);

    const allowedInScript = lintFixture(
        'scripts/tool.ts',
        'import { execFileSync } from "node:child_process";\nexport const out = execFileSync("git", ["status"]);\n',
    );
    assert.equal(allowedInScript.status, 0, allowedInScript.stdout + allowedInScript.stderr);
});

test('satori-guardrails rejects shell: true in production files', () => {
    const bad = lintFixture(
        'src/sample.ts',
        'import { spawn } from "node:child_process";\nexport const child = spawn("ls", ["-la"], { shell: true });\n',
    );
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /no-shell-true/);
});

test('satori-guardrails rejects JSON.stringify inside shell hook command templates', () => {
    const bad = lintFixture(
        'src/hook.ts',
        'export const entry = { type: "command", command: `${JSON.stringify("/bin/node")} ${JSON.stringify("/tmp/hook.js")}` };\n',
    );
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /no-json-stringify-shell-hook/);
});

test('satori-guardrails rejects raw lock-file unlinks outside lock owners', () => {
    const bad = lintFixture(
        'src/worker.ts',
        'import fs from "node:fs";\nexport function unlock(lockPath: string) { fs.unlinkSync(lockPath); }\n',
    );
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /no-raw-lock-unlink/);

    const okRegularUnlink = lintFixture(
        'src/worker.ts',
        'import fs from "node:fs";\nexport function removeTemp(tempPath: string) { fs.unlinkSync(tempPath); }\n',
    );
    assert.equal(okRegularUnlink.status, 0, okRegularUnlink.stdout + okRegularUnlink.stderr);
});
