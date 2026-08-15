import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DefaultLanguageResolutionStrategyRegistry,
    defaultResolutionStrategyRegistry,
} from './resolution-strategy-registry';

test('defaultResolutionStrategyRegistry maps canonical languages to their correct strategy', () => {
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('python'), 'python_native');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('py'), 'python_native');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('javascript'), 'syntactic');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('js'), 'syntactic');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('typescript'), 'syntactic');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('ts'), 'syntactic');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('tsx'), 'syntactic');
    
    // In Phase B, Go maps to 'cbm_semantic'
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('go'), 'cbm_semantic');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('rust'), 'none');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('rs'), 'none');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('java'), 'none');
    assert.equal(defaultResolutionStrategyRegistry.strategyForLanguage('unknown-lang'), 'none');
});


test('DefaultLanguageResolutionStrategyRegistry accepts custom strategy overrides', () => {
    const custom = new DefaultLanguageResolutionStrategyRegistry({
        go: 'cbm_semantic',
        python: 'none',
    });
    assert.equal(custom.strategyForLanguage('go'), 'cbm_semantic');
    assert.equal(custom.strategyForLanguage('python'), 'none');
    assert.equal(custom.strategyForLanguage('py'), 'none');
    assert.equal(custom.strategyForLanguage('typescript'), 'syntactic');
    assert.equal(custom.strategyForLanguage('rust'), 'none');
});

import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    buildSymbolRecordsForFile,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from '../symbols';
import { createLanguageAnalysisService } from '../language-analysis';
import type { ResolutionAuthority } from './resolution';
import {
    admitResolvedCallClaims,
    buildCallRelationshipsForRegistry,
} from './builder';


test('custom strategy registry actively controls buildCallRelationshipsForRegistry dispatch', async () => {
    const sources = new Map([
        ['src/math.ts', 'export function add(a: number, b: number): number { return a + b; }\n'],
        ['src/app.ts', 'import { add } from "./math";\nexport function main() { return add(1, 2); }\n'],
    ]);
    const analyzer = createLanguageAnalysisService();
    const analysisByFile = new Map(await Promise.all([...sources.entries()].map(async ([path, content]) => [
        path,
        await analyzer.analyze({ content, language: 'typescript', relativePath: path }),
    ] as const)));

    const symbols: SymbolRecord[] = [];
    const files: SymbolRegistryManifest['files'] = [];
    for (const [path, content] of sources.entries()) {
        const analysis = analysisByFile.get(path)!;
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath: path,
            language: 'typescript',
            content,
            fileHash: `hash-${path}`,
            extractorVersion: 'test-v1',
            chunks: [],
            extractedSymbols: analysis.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path,
            language: 'typescript',
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

    // 1. With default strategy (typescript -> syntactic), calls are resolved
    const defaultRecords = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile,
    });
    assert.equal(defaultRecords.length, 1);
    assert.equal(defaultRecords[0].type, 'CALLS');

    // 2. With custom strategy override (typescript -> none), calls are suppressed even though TS is eligible
    const suppressedRecords = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile,
        strategyRegistry: new DefaultLanguageResolutionStrategyRegistry({
            typescript: 'none',
        }),
    });
    assert.equal(suppressedRecords.length, 0);
});

test('qualification mode bypasses capability eligibility only, never strategy selection', async () => {
    // A Go file with strategy 'none' (or 'cbm_semantic') must NOT be routed through syntactic resolver during qualification
    const sources = new Map([
        ['pkg/calc.go', 'package pkg\nfunc Add(a, b int) int { return a + b }\n'],
        ['pkg/main.go', 'package pkg\nfunc Run() int { return Add(1, 2) }\n'],
    ]);
    const analyzer = createLanguageAnalysisService();
    const analysisByFile = new Map(await Promise.all([...sources.entries()].map(async ([path, content]) => [
        path,
        await analyzer.analyze({ content, language: 'go', relativePath: path }),
    ] as const)));

    const symbols: SymbolRecord[] = [];
    const files: SymbolRegistryManifest['files'] = [];
    for (const [path, content] of sources.entries()) {
        const analysis = analysisByFile.get(path)!;
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath: path,
            language: 'go',
            content,
            fileHash: `hash-${path}`,
            extractorVersion: 'test-v1',
            chunks: [],
            extractedSymbols: analysis.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path,
            language: 'go',
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

    // In qualification mode for Go with default strategy ('none'), zero CALLS records are emitted (not routed to syntactic)
    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile,
        mode: {
            kind: 'qualification',
            enabledUnpromotedCallLanguages: new Set(['go']),
        },
    });
    assert.equal(records.length, 0);
});

test('admitResolvedCallClaims validates authority, symbol existence, source file match, and span containment', () => {
    const sourceSymbol: SymbolRecord = {
        file: 'src/app.ts',
        name: 'main',
        qualifiedName: 'main',
        label: 'function main()',
        symbolKey: 'sym-source',
        symbolInstanceId: 'inst-source',
        kind: 'function',
        language: 'typescript',
        parentQualifiedNamePath: [],
        fileHash: 'hash-app',
        extractorVersion: 'test-v1',
        span: { startLine: 10, endLine: 20 },
    };
    const targetSymbol: SymbolRecord = {
        file: 'src/math.ts',
        name: 'add',
        qualifiedName: 'add',
        label: 'function add()',
        symbolKey: 'sym-target',
        symbolInstanceId: 'inst-target',
        kind: 'function',
        language: 'typescript',
        parentQualifiedNamePath: [],
        fileHash: 'hash-math',
        extractorVersion: 'test-v1',
        span: { startLine: 1, endLine: 5 },
    };


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
            files: [
                { path: 'src/app.ts', language: 'typescript', hash: 'hash-app', symbolCount: 1, definitionStatus: 'definitions_present' },
                { path: 'src/math.ts', language: 'typescript', hash: 'hash-math', symbolCount: 1, definitionStatus: 'definitions_present' },
            ],
        },
        symbols: [sourceSymbol, targetSymbol],
    });

    // 1. Valid claim admits cleanly
    const validClaim = {
        providerId: 'test-provider',
        providerVersion: '1.0.0',
        environmentConfigId: 'test-env',
        sourceFile: 'src/app.ts',
        sourceInstanceId: 'inst-source',
        targetInstanceId: 'inst-target',
        callSpan: { startByte: 100, endByte: 110, startLine: 12, startColumn: 4, endLine: 12, endColumn: 14 },
        decision: 'resolved' as const,
        relationshipType: 'CALLS' as const,
        resolutionAuthority: 'direct_binding' as const,
        proofSteps: [],
        dependencyKeys: [],
        flowHops: 0,
    };
    const admitted = admitResolvedCallClaims({ registry, claims: [validClaim] });
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].sourceInstanceId, 'inst-source');
    assert.equal(admitted[0].targetInstanceId, 'inst-target');
    assert.equal(admitted[0].confidence, 'low'); // cross-file

    // 2. Unknown targetInstanceId is rejected
    assert.equal(admitResolvedCallClaims({
        registry,
        claims: [{ ...validClaim, targetInstanceId: 'unknown-inst' }],
    }).length, 0);

    // 3. Mismatched sourceFile (claim claims src/other.ts but instance is in src/app.ts) is rejected
    assert.equal(admitResolvedCallClaims({
        registry,
        claims: [{ ...validClaim, sourceFile: 'src/other.ts' }],
    }).length, 0);

    // 4. Call span outside source symbol line boundaries (line 25 when symbol is lines 10-20) is rejected
    assert.equal(admitResolvedCallClaims({
        registry,
        claims: [{
            ...validClaim,
            callSpan: { startByte: 300, endByte: 310, startLine: 25, startColumn: 0, endLine: 26, endColumn: 0 },
        }],
    }).length, 0);

    // 5. Unapproved authority (e.g. lexical_heuristic) is rejected
    assert.equal(admitResolvedCallClaims({
        registry,
        claims: [{ ...validClaim, resolutionAuthority: 'lexical_heuristic' as unknown as ResolutionAuthority }],
    }).length, 0);
});



