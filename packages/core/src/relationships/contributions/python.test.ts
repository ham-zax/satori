import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    buildSymbolRecordsForFile,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from '../../symbols';
import { createLanguageAnalysisService } from '../../language-analysis';
import { resolvePythonRelationships } from '../python-resolution';
import { pythonResolutionContributionEngine } from './python';

test('PythonResolutionContributionEngine produces identical results to direct resolvePythonRelationships', async () => {
    const sources = new Map([
        ['pkg/__init__.py', ''],
        ['pkg/calc.py', 'def add(a: int, b: int) -> int:\n    return a + b\n'],
        ['pkg/main.py', 'from pkg.calc import add\ndef run():\n    return add(1, 2)\n'],
    ]);
    const analyzer = createLanguageAnalysisService();
    const analysisByFile = new Map(await Promise.all([...sources.entries()].map(async ([path, content]) => [
        path,
        await analyzer.analyze({ content, language: 'python', relativePath: path }),
    ] as const)));

    const symbols: SymbolRecord[] = [];
    const files: SymbolRegistryManifest['files'] = [];
    for (const [path, content] of sources.entries()) {
        const analysis = analysisByFile.get(path)!;
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath: path,
            language: 'python',
            content,
            fileHash: `hash-${path}`,
            extractorVersion: 'test-v1',
            chunks: [],
            extractedSymbols: analysis.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path,
            language: 'python',
            hash: `hash-${path}`,
            symbolCount: fileSymbols.length,
            definitionStatus: 'definitions_present',
        });
    }

    const registry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: '/repo',
            rootFingerprint: 'root-fingerprint',
            indexPolicyHash: 'policy-hash',
            languageRouterVersion: 'router-v1',
            extractorVersion: 'test-extractor-v1',
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files,
        },
        symbols,
    });


    const directResult = resolvePythonRelationships({
        registry,
        analysisByFile,
    });

    const wrappedResult = pythonResolutionContributionEngine.resolveCalls({
        registry,
        analysisByFile,
    });

    assert.deepEqual(wrappedResult.records, directResult.records);
    assert.deepEqual(wrappedResult.claimsByFile, directResult.claimsByFile);
});
