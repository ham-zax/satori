import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

test('Packed @zokizuan/satori-core contains semantic engine assets and executes WASM Go analysis in clean temp dir', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-packed-core-test-'));
    try {
        const corePkgDir = path.resolve(__dirname, '../../..');

        // Ensure core is built so packed tarball contains compiled dist
        if (!fs.existsSync(path.join(corePkgDir, 'dist', 'index.js')) || !fs.existsSync(path.join(corePkgDir, 'dist', 'semantic', 'wasm', 'wasm-analyzer.js'))) {
            execFileSync('pnpm', ['run', 'build'], {
                cwd: corePkgDir,
                encoding: 'utf8',
                env: process.env,
            });
        }

        // Pack @zokizuan/satori-core to temp dir
        const packOutput = execFileSync('pnpm', ['pack', '--pack-destination', tempDir], {
            cwd: corePkgDir,
            encoding: 'utf8',
            env: process.env,
        });

        const tarballName = packOutput.trim().split('\n').pop()?.trim();
        assert.ok(tarballName, 'pnpm pack should output tarball name');
        const tarballPath = path.isAbsolute(tarballName) ? tarballName : path.join(tempDir, tarballName);
        assert.ok(fs.existsSync(tarballPath), `Tarball must exist at ${tarballPath}`);

        // Extract tarball into an isolated test app directory
        const appDir = path.join(tempDir, 'test-app');
        fs.mkdirSync(appDir, { recursive: true });
        execFileSync('tar', ['-xzf', tarballPath, '-C', appDir], { encoding: 'utf8' });

        const packageRoot = path.join(appDir, 'package');
        assert.ok(fs.existsSync(path.join(packageRoot, 'package.json')));
        assert.ok(fs.existsSync(path.join(packageRoot, 'assets', 'semantic-engine', 'semantic-engine.manifest.json')));
        assert.ok(fs.existsSync(path.join(packageRoot, 'assets', 'semantic-engine', 'satori-semantic-engine.js')));

        // Link core's node_modules so packed require can resolve production dependencies
        fs.symlinkSync(path.join(corePkgDir, 'node_modules'), path.join(packageRoot, 'node_modules'), 'junction');

        // Load the packed semantic analyzer
        const packedRequire = createRequire(path.join(packageRoot, 'dist', 'index.js'));
        const { WasmSemanticProjectAnalyzer } = packedRequire('./semantic/wasm/wasm-analyzer');
        assert.ok(WasmSemanticProjectAnalyzer, 'WasmSemanticProjectAnalyzer must be exported');

        const analyzer = new WasmSemanticProjectAnalyzer();
        assert.equal(analyzer.supportsLanguage('go'), true);

        const evidence = await analyzer.analyze({
            language: 'go',
            auxiliaryFiles: [],
            sourceFiles: [
                {
                    path: 'main.go',
                    source: `package main

type Engine struct{}
func (e *Engine) Start() {}

func main() {
    e := &Engine{}
    e.Start()
}
`,
                    sourceHash: 'sha-main',
                },
            ],
        });

        assert.equal(evidence.language, 'go');
        const occurrences = evidence.occurrencesByFile.get('main.go');
        assert.ok(occurrences && occurrences.length === 1);
        assert.equal(occurrences[0].targetProvenance?.name, 'Start');
        assert.equal(occurrences[0].targetProvenance?.kind, 'method');
        assert.equal(occurrences[0].targetProvenance?.ownerName, 'Engine');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
