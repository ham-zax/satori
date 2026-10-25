import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/sync';
import { createFileSystemWithLib } from 'typescript/fs';
import { ScriptTarget } from 'typescript/ast';

const root = fileURLToPath(new URL('../', import.meta.url));

function lint(source) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lint-'));
    try {
        const file = path.join(directory, 'fixture.ts');
        fs.writeFileSync(file, source);
        return spawnSync(process.execPath, [
            path.join(root, 'node_modules/oxlint/bin/oxlint'),
            '--config', path.join(root, '.oxlintrc.json'), '--threads=1', file,
        ], { cwd: root, encoding: 'utf8' });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('native lint accepts TypeScript syntax and ignored parameter names', () => {
    const result = lint('export interface Value { value: number }\nexport function value(_unused: Value): number { return 1; }');
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('native lint retains unused-variable errors in TypeScript', () => {
    const result = lint('export function value(): number { const unused: number = 2; return 1; }');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /no-unused-vars/);
});

test('native lint retains unsafe optional-chain errors', () => {
    const result = lint('export function value(input?: { values: number[] }): number[] { return [...input?.values]; }');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /no-unsafe-optional-chaining/);
});

test('native compiler covers the retired duplicate-parameter and legacy-octal lint rules', () => {
    const api = new API({ runExternalCode: false });
    try {
        const file = path.join(os.tmpdir(), 'satori-lint-compiler-fixture.ts');
        const snapshot = api.createSnapshot({
            fileSystem: createFileSystemWithLib([[file,
                'export function duplicate(value: number, value: number): number { return value; }\nexport const octal = 0123;',
            ]]),
            createPrograms: [{ rootFiles: [file], compilerOptions: {
                target: ScriptTarget.ES2022, strict: true, noEmit: true, types: [],
            } }],
        });
        try {
            const program = snapshot.operation.createdPrograms[0];
            const codes = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(d => d.code);
            assert.ok(codes.includes(2300), `duplicate parameters: ${codes}`);
            assert.ok(codes.includes(1121), `legacy octal: ${codes}`);
        } finally { snapshot.dispose(); }
    } finally { api.close(); }
});
