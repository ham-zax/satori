import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolutionProjectAnalyzer } from '../relationships';
import { discoverPackageOwnership } from '../packages/ownership';
import { collectPublicationSourceControls } from './publication-source-controls';

// Reference implementation retained from the generation workflow for this extraction.
async function previousDiscovery(root: string, sourcePaths: readonly string[], analyzer?: ResolutionProjectAnalyzer) {
    let resolutionSourceControls: string[] = [];
    if (analyzer?.getSourceControlFiles && analyzer.supportsLanguage('typescript')) {
        const files = sourcePaths.map((file) => file.replace(/\\/g, '/').replace(/^\/+/, ''))
            .filter((file) => ['.ts', '.tsx', '.mts', '.cts'].some((extension) => file.toLowerCase().endsWith(extension)));
        if (files.length > 0) {
            resolutionSourceControls = [...new Set(await analyzer.getSourceControlFiles({
                rootPath: root, language: 'typescript', sourceFiles: files,
            }))].sort();
        }
    }
    const packageOwnershipSourceControls = discoverPackageOwnership(root).controlFiles
        .map(([file]) => file).filter((file) => path.posix.basename(file) !== 'Cargo.toml');
    return {
        resolutionSourceControls,
        packageOwnershipSourceControls,
        publicationSourceControls: [...new Set([
            ...resolutionSourceControls, ...packageOwnershipSourceControls,
        ])].sort(),
    };
}

test('shared discovery preserves generation output for every analyzer and source-selection branch', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-source-controls-')));
    try {
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
        fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
        const requests: unknown[] = [];
        const supported: ResolutionProjectAnalyzer = {
            supportsLanguage: (language) => language === 'typescript',
            analyze: async () => { throw new Error('discovery must not analyze sources'); },
            getSourceControlFiles: async (input) => {
                requests.push(input);
                return ['tsconfig.json', 'package.json', 'config/base.json', 'tsconfig.json'];
            },
        };
        const sources = ['/src/a.TS', 'src\\b.tsx', 'c.mts', 'd.cts', 'skip.js', 'skip.ts.bak'];
        for (const [analyzer, paths] of [
            [undefined, sources],
            [{ ...supported, getSourceControlFiles: undefined }, sources],
            [{ ...supported, supportsLanguage: () => false }, sources],
            [supported, ['skip.js']],
            [supported, sources],
        ] as const) {
            requests.length = 0;
            const previous = await previousDiscovery(root, paths, analyzer);
            const previousRequests = [...requests];
            requests.length = 0;
            const current = await collectPublicationSourceControls(root, paths, analyzer);
            assert.deepEqual(current, previous);
            assert.deepEqual(requests, previousRequests);
            assert.deepEqual(current.packageOwnershipSourceControls, ['package.json']);
        }
        assert.deepEqual(requests, [{
            rootPath: root, language: 'typescript', sourceFiles: ['src/a.TS', 'src/b.tsx', 'c.mts', 'd.cts'],
        }]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
