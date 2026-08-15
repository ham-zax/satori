import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultSemanticLanguageRegistry, type SemanticLanguageDescriptor } from '../semantic/descriptor';
import { DefaultLanguageResolutionStrategyRegistry } from './resolution-strategy-registry';
import { buildRelationshipsForRegistry } from './builder';
import type { SymbolRecord, SymbolRegistry } from '../symbols';
import type { SemanticProjectEvidence } from '../semantic/contracts';

test('TypeScript Layer Acceptance: Adding a second CBM language requires zero modifications to builder.ts or dispatch logic', () => {
    // 1. Declarative descriptor for a new language ("rust")
    const rustDescriptor: SemanticLanguageDescriptor = {
        language: 'rust',
        canonicalLanguage: 'rust',
        extensions: ['.rs'],
        strategy: 'cbm_semantic',
        semanticRevision: 'rust-v1',
        grammar: 'tree-sitter-rust',
        auxiliaryFiles: [
            { pattern: '**/Cargo.toml', role: 'manifest' },
            { pattern: '**/Cargo.lock', role: 'lockfile' },
        ],
        providerId: 'satori-cbm-semantic-rust',
        providerVersion: 'cbm-rust-v1',
        environmentConfigId: 'cbm-rust-config-v1',
    };

    // 2. Custom semantic registry with Go and Rust
    const semanticRegistry = new DefaultSemanticLanguageRegistry([
        {
            language: 'go',
            canonicalLanguage: 'go',
            extensions: ['.go'],
            strategy: 'cbm_semantic',
            semanticRevision: 'go-v1',
            grammar: 'tree-sitter-go',
            auxiliaryFiles: [{ pattern: '**/go.mod', role: 'manifest' }],
            providerId: 'satori-cbm-semantic-go',
            providerVersion: 'cbm-go-v1',
            environmentConfigId: 'cbm-go-config-v1',
        },
        rustDescriptor,
    ]);

    // 3. Strategy registry automatically resolves rust -> 'cbm_semantic' from descriptor (NO TS branch needed)
    const strategyRegistry = new DefaultLanguageResolutionStrategyRegistry(undefined, semanticRegistry);
    assert.equal(strategyRegistry.strategyForLanguage('rust'), 'cbm_semantic');
    assert.equal(strategyRegistry.strategyForLanguage('go'), 'cbm_semantic');

    // 4. Create mock SymbolRegistry with a real target and a same-name decoy
    const symbols: SymbolRecord[] = [
        {
            symbolKey: 'src/lib.rs#run_pipeline',
            symbolInstanceId: 'inst-rust-caller',
            name: 'run_pipeline',
            label: 'run_pipeline',
            qualifiedName: 'run_pipeline',
            kind: 'function',
            file: 'src/lib.rs',
            language: 'rust',
            span: { startByte: 0, endByte: 100, startLine: 1, endLine: 10, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: 'fh-rust-lib',
            extractorVersion: 'v1',
        },
        // Legitimate target symbol at byte span 110..180
        {
            symbolKey: 'src/engine.rs#execute',
            symbolInstanceId: 'inst-rust-target-real',
            name: 'execute',
            label: 'execute',
            qualifiedName: 'Engine.execute',
            kind: 'method',
            file: 'src/engine.rs',
            language: 'rust',
            span: { startByte: 110, endByte: 180, startLine: 12, endLine: 20, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: ['Engine'],
            fileHash: 'fh-rust-eng',
            extractorVersion: 'v1',
        },
        // Same-name decoy at a different byte span (300..380) in the same file
        {
            symbolKey: 'src/engine.rs#execute$decoy',
            symbolInstanceId: 'inst-rust-target-decoy',
            name: 'execute',
            label: 'execute',
            qualifiedName: 'Engine.execute',
            kind: 'method',
            file: 'src/engine.rs',
            language: 'rust',
            span: { startByte: 300, endByte: 380, startLine: 30, endLine: 38, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: ['Engine'],
            fileHash: 'fh-rust-eng',
            extractorVersion: 'v1',
        },
    ];

    const symbolsByFile = new Map<string, SymbolRecord[]>();
    symbolsByFile.set('src/lib.rs', [symbols[0]]);
    symbolsByFile.set('src/engine.rs', [symbols[1], symbols[2]]);

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
                { path: 'src/lib.rs', hash: 'h1', language: 'rust', symbolCount: 1, definitionStatus: 'definitions_present' },
                { path: 'src/engine.rs', hash: 'h2', language: 'rust', symbolCount: 2, definitionStatus: 'definitions_present' },
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

    // 5. CBM Semantic Project Evidence with exact target byte span (110..180)
    const rustSemanticEvidence: SemanticProjectEvidence = {
        language: 'rust',
        occurrencesByFile: new Map([
            [
                'src/lib.rs',
                [
                    {
                        sourceFile: 'src/lib.rs',
                        callSpan: { startByte: 30, endByte: 45, startLine: 3, endLine: 3, startColumn: 4, endColumn: 19 },
                        targetProvenance: {
                            file: 'src/engine.rs',
                            span: { startByte: 110, endByte: 180, startLine: 12, endLine: 20, startColumn: 0, endColumn: 1 },
                            name: 'execute',
                            ownerName: 'Engine',
                            kind: 'method',
                        },
                        proof: { strategy: 'direct_call' },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const analysisByFile = new Map();
    analysisByFile.set('src/lib.rs', { moduleBindings: [], callSites: [] });
    analysisByFile.set('src/engine.rs', { moduleBindings: [], callSites: [] });

    // 6. Generic dispatch through buildRelationshipsForRegistry
    const records = buildRelationshipsForRegistry({
        registry,
        analysisByFile,
        mode: {
            kind: 'qualification',
            enabledUnpromotedCallLanguages: new Set(['rust']),
        },
        strategyRegistry,
        semanticRegistry,
        semanticEvidenceByLanguage: new Map([['rust', rustSemanticEvidence]]),
    });

    // 7. Verify exact outcome:
    // - Exactly 1 CALLS edge emitted
    // - Bound to inst-rust-target-real (NOT inst-rust-target-decoy)
    // - Central admission enforced direct_binding
    // - Zero TESTS edges emitted for CBM language
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceKey, 'src/lib.rs#run_pipeline');
    assert.equal(records[0].targetKey, 'src/engine.rs#execute');
    assert.equal(records[0].targetInstanceId, 'inst-rust-target-real');
    assert.equal(records[0].type, 'CALLS');
    assert.equal(records[0].resolutionAuthority, 'direct_binding');

    const claims = analysisByFile.get('src/lib.rs')?.resolutionClaims;
    assert.ok(claims && claims.length === 1);
    assert.equal(claims[0].providerId, 'satori-cbm-semantic-rust');
    assert.equal(claims[0].targetInstanceId, 'inst-rust-target-real');
    assert.equal(claims[0].decision, 'resolved');
});

test('TypeScript Layer Acceptance: Caller binding fails closed and abstains when call span is outside any callable symbol', () => {
    const rustDescriptor: SemanticLanguageDescriptor = {
        language: 'rust',
        canonicalLanguage: 'rust',
        extensions: ['.rs'],
        strategy: 'cbm_semantic',
        semanticRevision: 'rust-v1',
        grammar: 'tree-sitter-rust',
        auxiliaryFiles: [],
        providerId: 'satori-cbm-semantic-rust',
        providerVersion: 'cbm-rust-v1',
        environmentConfigId: 'cbm-rust-config-v1',
    };
    const semanticRegistry = new DefaultSemanticLanguageRegistry([rustDescriptor]);

    const symbols: SymbolRecord[] = [
        {
            symbolKey: 'src/lib.rs#run_pipeline',
            symbolInstanceId: 'inst-rust-caller',
            name: 'run_pipeline',
            label: 'run_pipeline',
            qualifiedName: 'run_pipeline',
            kind: 'function',
            file: 'src/lib.rs',
            language: 'rust',
            span: { startByte: 0, endByte: 100, startLine: 1, endLine: 10, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: 'fh-rust-lib',
            extractorVersion: 'v1',
        },
        {
            symbolKey: 'src/engine.rs#execute',
            symbolInstanceId: 'inst-rust-target',
            name: 'execute',
            label: 'execute',
            qualifiedName: 'Engine.execute',
            kind: 'method',
            file: 'src/engine.rs',
            language: 'rust',
            span: { startByte: 110, endByte: 180, startLine: 12, endLine: 20, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: ['Engine'],
            fileHash: 'fh-rust-eng',
            extractorVersion: 'v1',
        },
    ];

    const symbolsByFile = new Map<string, SymbolRecord[]>();
    symbolsByFile.set('src/lib.rs', [symbols[0]]);
    symbolsByFile.set('src/engine.rs', [symbols[1]]);

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
                { path: 'src/lib.rs', hash: 'h1', language: 'rust', symbolCount: 1, definitionStatus: 'definitions_present' },
                { path: 'src/engine.rs', hash: 'h2', language: 'rust', symbolCount: 1, definitionStatus: 'definitions_present' },
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

    // Call span is at 500..550, which is outside the caller symbol span (0..100)
    const outOfBoundsEvidence: SemanticProjectEvidence = {
        language: 'rust',
        occurrencesByFile: new Map([
            [
                'src/lib.rs',
                [
                    {
                        sourceFile: 'src/lib.rs',
                        callSpan: { startByte: 500, endByte: 550, startLine: 50, endLine: 55, startColumn: 4, endColumn: 19 },
                        targetProvenance: {
                            file: 'src/engine.rs',
                            span: { startByte: 110, endByte: 180, startLine: 12, endLine: 20, startColumn: 0, endColumn: 1 },
                            name: 'execute',
                            kind: 'method',
                        },
                        proof: { strategy: 'direct_call' },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const analysisByFile = new Map();
    analysisByFile.set('src/lib.rs', { moduleBindings: [], callSites: [] });
    analysisByFile.set('src/engine.rs', { moduleBindings: [], callSites: [] });

    const records = buildRelationshipsForRegistry({
        registry,
        analysisByFile,
        mode: {
            kind: 'qualification',
            enabledUnpromotedCallLanguages: new Set(['rust']),
        },
        semanticRegistry,
        semanticEvidenceByLanguage: new Map([['rust', outOfBoundsEvidence]]),
    });

    // Zero records admitted because caller binding failed closed (did not fall back to an arbitrary symbol)
    assert.equal(records.length, 0);
});
