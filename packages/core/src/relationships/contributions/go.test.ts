import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    goResolutionContributionEngine,
    CBM_GO_PROVIDER_ID,
    CBM_GO_PROVIDER_VERSION,
    CBM_GO_ENVIRONMENT_CONFIG_ID,
} from './go';
import type { SymbolRecord, SymbolRegistry } from '../../symbols';

import type { SemanticProjectEvidence } from '../../semantic';

function createMockRegistry(): SymbolRegistry {
    const callerSpan = { startByte: 50, endByte: 150, startLine: 5, endLine: 10, startColumn: 0, endColumn: 1 };
    const targetSpan = { startByte: 10, endByte: 45, startLine: 1, endLine: 4, startColumn: 0, endColumn: 1 };

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
        {
            symbolKey: 'user.go#Greet',
            symbolInstanceId: 'inst-greet',
            name: 'Greet',
            label: 'Greet',
            qualifiedName: 'User.Greet',
            kind: 'method' as const,
            file: 'user.go',
            language: 'go',
            span: { startByte: 20, endByte: 60, startLine: 2, endLine: 5, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: ['User'],
            fileHash: 'fh-user',
            extractorVersion: 'v1',
        },
    ];

    const symbolsByFile = new Map<string, SymbolRecord[]>();
    symbolsByFile.set('main.go', [symbols[0], symbols[1]]);
    symbolsByFile.set('user.go', [symbols[2]]);

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
                { path: 'main.go', hash: 'h1', language: 'go', symbolCount: 2, definitionStatus: 'definitions_present' },
                { path: 'user.go', hash: 'h2', language: 'go', symbolCount: 1, definitionStatus: 'definitions_present' },
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




test('GoResolutionContributionEngine resolves direct function calls and attaches structured proof', () => {
    const registry = createMockRegistry();

    const semanticEvidence: SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 70, endByte: 85, startLine: 7, endLine: 7, startColumn: 4, endColumn: 15 },
                        targetProvenance: {
                            file: 'main.go',
                            name: 'Process',
                            kind: 'function',
                            span: { startByte: 10, endByte: 45, startLine: 1, endLine: 4, startColumn: 0, endColumn: 1 },
                        },
                        proof: {
                            strategy: 'direct_call',
                        },
                        decision: 'resolved',
                        confidence: 0.95,
                    },
                ],
            ],
        ]),
    };

    const result = goResolutionContributionEngine.resolveCalls({
        registry,
        analysisByFile: new Map(),
        semanticEvidence,
    });

    assert.equal(result.records.length, 1);
    const rec = result.records[0];
    assert.equal(rec.sourceKey, 'main.go#main');
    assert.equal(rec.targetKey, 'main.go#Process');
    assert.equal(rec.type, 'CALLS');
    assert.equal(rec.resolutionAuthority, 'direct_binding');

    const claims = result.claimsByFile?.get('main.go');
    assert.ok(claims && claims.length === 1);
    const claim = claims[0];
    assert.equal(claim.providerId, CBM_GO_PROVIDER_ID);
    assert.equal(claim.providerVersion, CBM_GO_PROVIDER_VERSION);
    assert.equal(claim.environmentConfigId, CBM_GO_ENVIRONMENT_CONFIG_ID);
    assert.equal(claim.decision, 'resolved');
    assert.equal(claim.resolutionAuthority, 'direct_binding');
    assert.ok(claim.proofSteps.some((s) => s.kind === 'call_site'));
    assert.ok(claim.proofSteps.some((s) => s.kind === 'containing_caller'));
    assert.ok(claim.proofSteps.some((s) => s.kind === 'exact_target_definition'));
});


test('GoResolutionContributionEngine resolves method receiver calls across files', () => {
    const registry = createMockRegistry();

    const semanticEvidence: SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 90, endByte: 110, startLine: 8, endLine: 8, startColumn: 4, endColumn: 20 },
                        targetProvenance: {
                            file: 'user.go',
                            name: 'Greet',
                            kind: 'method',
                            ownerName: 'User',
                            span: { startByte: 20, endByte: 60, startLine: 2, endLine: 5, startColumn: 0, endColumn: 1 },
                        },
                        proof: {
                            strategy: 'type_dispatch',
                            receiverBinding: {
                                kind: 'composite_literal',
                                receiverType: 'User',
                            },
                        },
                        decision: 'resolved',
                        confidence: 0.95,
                    },
                ],
            ],
        ]),
    };

    const result = goResolutionContributionEngine.resolveCalls({
        registry,
        analysisByFile: new Map(),
        semanticEvidence,
    });

    assert.equal(result.records.length, 1);
    const rec = result.records[0];
    assert.equal(rec.sourceKey, 'main.go#main');
    assert.equal(rec.targetKey, 'user.go#Greet');
    assert.equal(rec.type, 'CALLS');
    assert.equal(rec.confidence, 'low');

    const claims = result.claimsByFile?.get('main.go');
    assert.ok(claims);
    assert.ok(claims[0].proofSteps.some((s) => s.kind === 'receiver_type_binding'));
});

test('GoResolutionContributionEngine abstains on ambiguous targets and produces no edges', () => {
    const registry = createMockRegistry();

    // Introduce duplicate Greet in user.go
    const userSymbols = registry.symbolsByFile.get('user.go')!;
    userSymbols.push({
        symbolKey: 'user.go#Greet2',
        symbolInstanceId: 'inst-greet2',
        name: 'Greet',
        label: 'Greet',
        qualifiedName: 'User.Greet',
        kind: 'method',
        file: 'user.go',
        language: 'go',
        span: { startByte: 20, endByte: 60, startLine: 2, endLine: 5, startColumn: 0, endColumn: 1 },
        parentQualifiedNamePath: ['User'],
        fileHash: 'fh-user',
        extractorVersion: 'v1',
    });


    const semanticEvidence: SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 90, endByte: 110, startLine: 8, endLine: 8, startColumn: 4, endColumn: 20 },
                        targetProvenance: {
                            file: 'user.go',
                            name: 'Greet',
                            kind: 'method',
                            ownerName: 'User',
                            span: { startByte: 20, endByte: 60, startLine: 2, endLine: 5, startColumn: 0, endColumn: 1 },
                        },
                        proof: {
                            strategy: 'type_dispatch',
                        },
                        decision: 'resolved',
                        confidence: 0.95,
                    },
                ],
            ],
        ]),
    };

    const result = goResolutionContributionEngine.resolveCalls({
        registry,
        analysisByFile: new Map(),
        semanticEvidence,
    });

    assert.equal(result.records.length, 0, 'No relationship records should be emitted for ambiguous calls');
    const claims = result.claimsByFile?.get('main.go');
    assert.ok(claims && claims.length === 1);
    assert.equal(claims[0].decision, 'ambiguous');
});

