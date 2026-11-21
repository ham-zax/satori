import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TypeScriptSemanticProjectAnalyzer } from '../relationships/typescript-semantic-analyzer';
import { buildSymbolRegistry, SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols';
import { readTypeScriptFileBytes } from './typescript-bounded-reader';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function buildRegistry(rootPath: string, files: Record<string, string>) {
    for (const [relativePath, content] of Object.entries(files)) {
        writeFile(path.join(rootPath, relativePath), content);
    }
    return buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: rootPath,
            rootFingerprint: 'test',
            indexPolicyHash: 'test',
            languageRouterVersion: 'test',
            extractorVersion: 'test',
            relationshipVersion: 'test',
            builtAt: '2026-11-21T00:00:00.000Z',
            files: Object.keys(files).map((file) => ({
                path: file,
                hash: createHash('sha256').update(fs.readFileSync(path.join(rootPath, file))).digest('hex'),
                language: 'typescript',
                symbolCount: 0,
                definitionStatus: 'definitions_present' as const,
            })),
        },
        symbols: [],
    });
}

test('TypeScript semantic analysis never reads or resolves files outside the repository root (P4-1)', async (t) => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-boundary-'));
    t.after(() => fs.rmSync(outer, { recursive: true, force: true }));

    const outsideSecretConfig = path.join(outer, 'outside-base.json');
    const outsideSecretSource = path.join(outer, 'outside-secret.ts');
    const outsideRefDir = path.join(outer, 'outside-ref');
    const repo = path.join(outer, 'repo');
    const stateDirectory = path.join(outer, 'ts-state');

    writeFile(outsideSecretConfig, JSON.stringify({
        compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
        },
    }));
    writeFile(outsideSecretSource, 'export function secretOutside(): number { return 42; }\n');
    writeFile(path.join(outsideRefDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            composite: true,
            declaration: true,
            outDir: 'dist',
            rootDir: 'src',
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
        },
        include: ['src/**/*.ts'],
    }));
    writeFile(path.join(outsideRefDir, 'src/ref.ts'), 'export function outsideRefFn(): number { return 7; }\n');

    writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
        extends: '../outside-base.json',
        compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
        },
        files: ['src/main.ts', '../outside-secret.ts'],
        references: [{ path: '../outside-ref' }],
    }));

    // Symlink inside repo escaping to outsideSecretSource.
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.symlinkSync(outsideSecretSource, path.join(repo, 'src/escape.ts'));

    const registry = buildRegistry(repo, {
        'src/main.ts': [
            'import { secretOutside } from "../outside-secret";',
            'import { secretOutside as escaped } from "./escape";',
            'export function run(): number { return secretOutside() + escaped(); }',
            '',
        ].join('\n'),
    });

    // Observe every OS read of outside paths during analysis.
    const outsideReads: string[] = [];
    const originalOpenSync = fs.openSync;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        const target = String(args[0]);
        if (
            target.includes('outside-base.json')
            || target.includes('outside-secret.ts')
            || target.includes('outside-ref')
        ) {
            outsideReads.push(target);
        }
        return originalOpenSync(...args);
    });

    const analyzer = new TypeScriptSemanticProjectAnalyzer(2, undefined, undefined, { stateDirectory });
    try {
        await analyzer.analyze({ rootPath: repo, language: 'typescript', registry });
    } finally {
        await analyzer.dispose();
    }

    assert.deepEqual(
        outsideReads,
        [],
        `TypeScript semantic analysis must not open files outside repository root; opened: ${outsideReads.join(', ')}`,
    );

    // Persisted reference cache must not record out-of-root paths either.
    if (fs.existsSync(stateDirectory)) {
        for (const entry of fs.readdirSync(stateDirectory)) {
            const content = fs.readFileSync(path.join(stateDirectory, entry), 'utf8');
            assert.equal(content.includes('outside-ref'), false, 'state cache must not persist out-of-root reference paths');
            assert.equal(content.includes('outside-base.json'), false, 'state cache must not persist out-of-root config paths');
            assert.equal(content.includes('outside-secret.ts'), false, 'state cache must not persist out-of-root source paths');
        }
    }
});

test('readTypeScriptFileBytes rejects a FIFO without hanging (P4-1)', {
    skip: process.platform !== 'linux',
}, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-fifo-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fifoPath = path.join(dir, 'hang.ts');
    execFileSync('mkfifo', [fifoPath]);

    // Run in a short-timeout child process so a broken blocking openSync fails
    // deterministically instead of hanging the test runner.
    const readerModule = path.resolve(__dirname, 'typescript-bounded-reader.ts');
    const result = spawnSync(
        process.execPath,
        [
            '--import',
            'tsx',
            '-e',
            `const { readTypeScriptFileBytes } = require(${JSON.stringify(readerModule)}); try { readTypeScriptFileBytes(${JSON.stringify(fifoPath)}, 1024); process.exit(0); } catch (e) { console.error(e.message); process.exit(42); }`,
        ],
        { encoding: 'utf8', timeout: 2_000 },
    );

    assert.equal(
        result.signal,
        null,
        `readTypeScriptFileBytes must not hang on a FIFO (timed out with signal ${result.signal})`,
    );
    assert.equal(result.status, 42, `expected regular-file rejection exit 42, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /not a regular file/i);
    assert.equal(typeof readTypeScriptFileBytes, 'function');
});
