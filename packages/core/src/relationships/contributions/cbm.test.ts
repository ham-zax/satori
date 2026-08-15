import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CbmSemanticContributionEngine } from './cbm';
import type { SymbolRecord, SymbolRegistry } from '../../symbols';
import type { SemanticProjectEvidence } from '../../semantic/contracts';
import { DefaultSemanticLanguageRegistry } from '../../semantic/descriptor';

function createMockRegistryWithDecoy(): SymbolRegistry {
    const callerSpan = { startByte: 50, endByte: 150, startLine: 5, endLine: 10, startColumn: 0, endColumn: 1 };
    const targetSpan = { startByte: 10, endByte: 45, startLine: 1, endLine: 4, startColumn: 0, endColumn: 1 };
    const decoySpan = { startByte: 200, endByte: 245, startLine: 15, endLine: 18, startColumn: 0, endColumn: 1 };

    const symbols: SymbolRecord[] = [
        {
            symbolKey: 'main.go#main',
            symbolInstanceId: 'inst-main',
            name: 'main',
            label: 'main',
            qualifiedName: 'main',
            kind: 'function' as const,
            file: 'main.go',
            language: 'go',
            span: callerSpan,
            parentQualifiedNamePath: [],
            fileHash: 'fh-main',
            extractorVersion: 'v1',
        },
        // Legitimate target at exact span (10..45)
        {
            symbolKey: 'main.go#Process',
            symbolInstanceId: 'inst-process-real',
            name: 'Process',
            label: 'Process',
            qualifiedName: 'Process',
            kind: 'function' as const,
            file: 'main.go',
            language: 'go',
            span: targetSpan,
            parentQualifiedNamePath: [],
            fileHash: 'fh-main',
            extractorVersion: 'v1',
        },
        // Decoy symbol with the exact same name and file, but at a different span (200..245)
        {
            symbolKey: 'main.go#Process$decoy',
            symbolInstanceId: 'inst-process-decoy',
            name: 'Process',
            label: 'Process',
            qualifiedName: 'Process',
            kind: 'function' as const,
            file: 'main.go',
            language: 'go',
            span: decoySpan,
            parentQualifiedNamePath: [],
            fileHash: 'fh-main',
            extractorVersion: 'v1',
        },
    ];

    const symbolsByFile = new Map<string, SymbolRecord[]>();
    symbolsByFile.set('main.go', symbols);

    return {
        manifest: {
            schemaVersion: 'symbol_registry_v3',
            normalizedRootPath: '/repo',
            rootFingerprint: 'rfp',
            indexPolicyHash: 'iph',
            languageRouterVersion: 'lr-v2',
            extractorVersion: 'v1',
            relationshipVersion: 'v1',
            builtAt: '2026-08-14T00:00:00.000Z',
            files: [
                { path: 'main.go', hash: 'h1', language: 'go', symbolCount: 3, definitionStatus: 'definitions_present' },
            ],
        },
        symbols,
        symbolsByFile,
        symbolsByInstanceId: new Map(symbols.map((s) => [s.symbolInstanceId, s])),
        symbolsByKey: new Map(symbols.map((s) => [s.symbolKey, [s]])),
        symbolsByLabel: new Map(symbols.map((s) => [s.label, [s]])),
        symbolsByQualifiedName: new Map(symbols.map((s) => [s.qualifiedName, [s]])),
        warnings: [],
    };
}

test('CbmSemanticContributionEngine binds ONLY to exact span target and rejects same-name decoy', () => {
    const engine = new CbmSemanticContributionEngine('go');
    const registry = createMockRegistryWithDecoy();

    // Semantic evidence points to target at span 10..45
    const semanticEvidence: SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 70, endByte: 85, startLine: 7, endLine: 7, startColumn: 4, endColumn: 19 },
                        targetProvenance: {
                            file: 'main.go',
                            span: { startByte: 10, endByte: 45, startLine: 1, endLine: 4, startColumn: 0, endColumn: 1 },
                            name: 'Process',
                            kind: 'function',
                        },
                        proof: {
                            strategy: 'direct_call',
                            packageBinding: {
                                importPath: 'main',
                            },
                        },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const result = engine.resolveCalls({
        registry,
        analysisByFile: new Map(),
        semanticEvidence,
    });

    // Exactly one CALLS record emitted, bound to inst-process-real (NOT the decoy)
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].sourceKey, 'main.go#main');
    assert.equal(result.records[0].targetKey, 'main.go#Process');
    assert.equal(result.records[0].targetInstanceId, 'inst-process-real');
    assert.equal(result.records[0].type, 'CALLS');

    const claims = result.claimsByFile?.get('main.go');
    assert.ok(claims && claims.length === 1);
    assert.equal(claims[0].targetInstanceId, 'inst-process-real');
    assert.equal(claims[0].resolutionAuthority, 'direct_binding');
});

test('CbmSemanticContributionEngine fails closed when target span does not match any symbol record', () => {
    const engine = new CbmSemanticContributionEngine('go');
    const registry = createMockRegistryWithDecoy();

    // Provenance points to a non-existent span (999..1050)
    const semanticEvidence: SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 70, endByte: 85, startLine: 7, endLine: 7, startColumn: 4, endColumn: 19 },
                        targetProvenance: {
                            file: 'main.go',
                            span: { startByte: 999, endByte: 1050, startLine: 50, endLine: 52, startColumn: 0, endColumn: 1 },
                            name: 'Process',
                            kind: 'function',
                        },
                        proof: { strategy: 'direct_call' },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const result = engine.resolveCalls({
        registry,
        analysisByFile: new Map(),
        semanticEvidence,
    });

    // Zero records admitted because span did not match any symbol
    assert.equal(result.records.length, 0);
    const claims = result.claimsByFile?.get('main.go');
    assert.ok(claims && claims.length === 1);
    assert.equal(claims[0].decision, 'unresolved');
    assert.equal(claims[0].targetInstanceId, undefined);
});

test('CbmSemanticContributionEngine fails closed on unregistered language descriptor', () => {
    const emptyRegistry = new DefaultSemanticLanguageRegistry([]);
    assert.throws(
        () => new CbmSemanticContributionEngine('unregistered_lang', undefined, emptyRegistry),
        /Unregistered semantic language: 'unregistered_lang'/,
    );
});

test('CbmSemanticContributionEngine downgrades resolved occurrence to unresolved when targetProvenance is missing', () => {
    const registry = createMockRegistryWithDecoy();
    const engine = new CbmSemanticContributionEngine('go');

    const semanticEvidence: SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 70, endByte: 85, startLine: 7, endLine: 7, startColumn: 4, endColumn: 19 },
                        // targetProvenance is intentionally undefined
                        targetProvenance: undefined,
                        proof: { strategy: 'direct_call' },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const result = engine.resolveCalls({
        registry,
        analysisByFile: new Map(),
        semanticEvidence,
    });

    assert.equal(result.records.length, 0);
    const claims = result.claimsByFile?.get('main.go');
    assert.ok(claims && claims.length === 1);
    assert.equal(claims[0].decision, 'unresolved');
    assert.equal(claims[0].targetInstanceId, undefined);
    assert.equal(claims[0].relationshipType, 'REFERENCES');
});

test('CbmSemanticContributionEngine abstains when enclosing symbol is non-callable (e.g. interface/class)', () => {
    const callerSpan = { startByte: 50, endByte: 150, startLine: 5, endLine: 10, startColumn: 0, endColumn: 1 };
    const targetSpan = { startByte: 10, endByte: 45, startLine: 1, endLine: 4, startColumn: 0, endColumn: 1 };

    const symbols: SymbolRecord[] = [
        {
            symbolKey: 'main.go#NonCallableInterface',
            symbolInstanceId: 'inst-interface',
            name: 'NonCallableInterface',
            label: 'NonCallableInterface',
            qualifiedName: 'NonCallableInterface',
            kind: 'interface' as const, // non-callable
            file: 'main.go',
            language: 'go',
            span: callerSpan,
            parentQualifiedNamePath: [],
            fileHash: 'fh-main',
            extractorVersion: 'v1',
        },
        {
            symbolKey: 'main.go#Process',
            symbolInstanceId: 'inst-process',
            name: 'Process',
            label: 'Process',
            qualifiedName: 'Process',
            kind: 'function' as const,
            file: 'main.go',
            language: 'go',
            span: targetSpan,
            parentQualifiedNamePath: [],
            fileHash: 'fh-main',
            extractorVersion: 'v1',
        },
    ];

    const registry: SymbolRegistry = {
        manifest: {
            schemaVersion: 'symbol_registry_v3',
            normalizedRootPath: '/repo',
            rootFingerprint: 'rfp',
            indexPolicyHash: 'iph',
            languageRouterVersion: 'lr-v2',
            extractorVersion: 'v1',
            relationshipVersion: 'v1',
            builtAt: '2026-08-14T00:00:00.000Z',
            files: [
                { path: 'main.go', hash: 'h1', language: 'go', symbolCount: 2, definitionStatus: 'definitions_present' },
            ],
        },
        symbols,
        symbolsByFile: new Map([['main.go', symbols]]),
        symbolsByInstanceId: new Map(symbols.map((s) => [s.symbolInstanceId, s])),
        symbolsByKey: new Map(symbols.map((s) => [s.symbolKey, [s]])),
        symbolsByLabel: new Map(symbols.map((s) => [s.label, [s]])),
        symbolsByQualifiedName: new Map(symbols.map((s) => [s.qualifiedName, [s]])),
        warnings: [],
    };

    const engine = new CbmSemanticContributionEngine('go');
    const semanticEvidence: SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 70, endByte: 85, startLine: 7, endLine: 7, startColumn: 4, endColumn: 19 },
                        targetProvenance: {
                            file: 'main.go',
                            span: targetSpan,
                            name: 'Process',
                            kind: 'function',
                        },
                        proof: { strategy: 'direct_call' },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const result = engine.resolveCalls({
        registry,
        analysisByFile: new Map(),
        semanticEvidence,
    });

    // Enclosing symbol is an interface (non-callable), so no claims or records emitted
    assert.equal(result.records.length, 0);
    assert.equal(result.claimsByFile?.get('main.go')?.length ?? 0, 0);
});
