import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSymbolRegistry } from '../symbols/registry';
import { writeRelationshipSidecar, writeSymbolRegistrySidecar } from '../symbols/sidecar';
import { SYMBOL_REGISTRY_SCHEMA_VERSION, type SymbolRecord } from '../symbols/contracts';
import { computeLanguageCapabilityEvidence, resolveLanguageCapabilityEvidence } from './evidence';

test('language capability evidence combines declarations with observed registry and relationship state', () => {
    const summary = computeLanguageCapabilityEvidence({
        searchable: true,
        registryStatus: 'compatible',
        relationshipStatus: 'compatible',
        files: [
            { language: 'typescript', definitionStatus: 'definitions_present' },
            { language: 'typescript', definitionStatus: 'definition_free' },
            { language: 'go', definitionStatus: 'definitions_present' },
            { language: 'markdown', definitionStatus: 'definition_free' },
        ],
        symbols: [
            { language: 'typescript', kind: 'file', file: 'src/a.ts' },
            { language: 'typescript', kind: 'function', file: 'src/a.ts' },
            { language: 'go', kind: 'function', file: 'main.go' },
        ],
    });

    assert.equal(summary.basis, 'language_declarations_and_navigation_sidecars');
    assert.equal(summary.registryEvidence, 'compatible');
    assert.equal(summary.relationshipEvidence, 'compatible');
    assert.deepEqual(summary.languages.map((entry) => entry.language), ['go', 'text', 'typescript']);

    const typescript = summary.languages[2];
    assert.equal(typescript.declaredClaim, 'type_receiver_aware');
    assert.equal(typescript.indexedFileCount, 2);
    assert.deepEqual(typescript.symbolEvidence, {
        eligibleFiles: 1,
        filesWithNonFileSymbols: 1,
        definitionBearingFiles: 1,
        definitionFreeFiles: 1,
        structurallyUnavailableFiles: 0,
        status: 'symbol_rich',
    });
    assert.deepEqual(typescript.capabilities, {
        semanticSearch: 'ready',
        exactSymbol: 'ready',
        outline: 'ready',
        callGraph: 'ready',
    });
    assert.deepEqual(typescript.degradationReasons, []);

    const go = summary.languages[0];
    assert.equal(go.declaredClaim, 'calls_v0');
    assert.equal(go.capabilities.exactSymbol, 'ready');
    assert.equal(go.capabilities.outline, 'ready');
    assert.equal(go.capabilities.callGraph, 'ready');
    assert.equal(go.relationshipEvidence, 'compatible');
    assert.deepEqual(go.degradationReasons, []);

    const text = summary.languages[1];
    assert.equal(text.declaredClaim, 'search_only');
    assert.deepEqual(text.symbolEvidence, {
        eligibleFiles: 0,
        filesWithNonFileSymbols: 0,
        definitionBearingFiles: 0,
        definitionFreeFiles: 0,
        structurallyUnavailableFiles: 0,
        status: 'search_only',
    });
    assert.equal(text.capabilities.semanticSearch, 'ready');
    assert.equal(text.capabilities.exactSymbol, 'not_applicable');
    assert.equal(text.capabilities.outline, 'not_applicable');
    assert.equal(text.capabilities.callGraph, 'not_applicable');
});

test('Go call graph evidence requires compatible Publication relationship navigation', () => {
    const summary = computeLanguageCapabilityEvidence({
        searchable: true,
        registryStatus: 'compatible',
        relationshipStatus: 'missing',
        files: [{ language: 'go', definitionStatus: 'definitions_present' }],
        symbols: [{ language: 'go', kind: 'function', file: 'main.go' }],
    });

    const go = summary.languages[0];
    assert.equal(go.declaredClaim, 'calls_v0');
    assert.equal(go.relationshipEvidence, 'missing');
    assert.equal(go.capabilities.callGraph, 'unavailable');
    assert.deepEqual(go.degradationReasons, ['relationship_sidecar_missing']);
});

test('language capability evidence fails closed for unavailable sidecars and non-searchable lifecycle state', () => {
    const summary = computeLanguageCapabilityEvidence({
        searchable: false,
        registryStatus: 'compatible',
        relationshipStatus: 'incompatible',
        files: [{ language: 'python', definitionStatus: 'definitions_present' }],
        symbols: [{ language: 'python', kind: 'function' }],
    });

    assert.deepEqual(summary.languages[0].capabilities, {
        semanticSearch: 'unavailable',
        exactSymbol: 'unavailable',
        outline: 'unavailable',
        callGraph: 'unavailable',
    });
    assert.equal(summary.languages[0].relationshipEvidence, 'incompatible');
    assert.deepEqual(summary.languages[0].degradationReasons, [
        'index_not_searchable',
        'relationship_sidecar_incompatible',
    ]);
});

test('language capability evidence keeps recovered structural analysis degraded', () => {
    const summary = computeLanguageCapabilityEvidence({
        searchable: true,
        registryStatus: 'compatible',
        relationshipStatus: 'compatible',
        files: [
            { language: 'python', definitionStatus: 'definitions_present' },
            { language: 'python', definitionStatus: 'structural_unavailable' },
        ],
        symbols: [{ language: 'python', kind: 'function', file: 'src/healthy.py' }],
    });

    assert.deepEqual(summary.languages[0].symbolEvidence, {
        eligibleFiles: 2,
        filesWithNonFileSymbols: 1,
        definitionBearingFiles: 1,
        definitionFreeFiles: 0,
        structurallyUnavailableFiles: 1,
        status: 'mixed',
    });
    assert.equal(summary.languages[0].capabilities.exactSymbol, 'degraded');
    assert.equal(summary.languages[0].capabilities.callGraph, 'degraded');
    assert.deepEqual(summary.languages[0].degradationReasons, ['structural_evidence_unavailable']);
});

test('language capability evidence does not manufacture readiness without definitions or relationships', () => {
    const summary = computeLanguageCapabilityEvidence({
        searchable: true,
        registryStatus: 'compatible',
        relationshipStatus: 'missing',
        files: [
            { language: 'python', definitionStatus: 'definition_free' },
            { language: 'python', definitionStatus: 'definition_free' },
        ],
        symbols: [],
    });

    assert.deepEqual(summary.languages[0].symbolEvidence, {
        eligibleFiles: 0,
        filesWithNonFileSymbols: 0,
        definitionBearingFiles: 0,
        definitionFreeFiles: 2,
        structurallyUnavailableFiles: 0,
        status: 'unknown',
    });
    assert.equal(summary.languages[0].capabilities.exactSymbol, 'unavailable');
    assert.equal(summary.languages[0].capabilities.outline, 'unavailable');
    assert.equal(summary.languages[0].capabilities.callGraph, 'unavailable');
    assert.deepEqual(summary.languages[0].degradationReasons, [
        'definition_evidence_missing',
        'relationship_sidecar_missing',
    ]);
});

test('language capability evidence returns bounded global evidence when registry is unavailable', () => {
    const summary = computeLanguageCapabilityEvidence({
        searchable: false,
        registryStatus: 'missing',
        relationshipStatus: 'not_checked',
        files: [],
        symbols: [],
    });

    assert.equal(summary.registryEvidence, 'missing');
    assert.equal(summary.relationshipEvidence, 'not_checked');
    assert.deepEqual(summary.languages, []);
});

test('resolveLanguageCapabilityEvidence binds relationship evidence to the compatible registry generation', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-language-evidence-'));
    const normalizedRootPath = '/repo';
    const common = {
        language: 'typescript',
        file: 'src/run.ts',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        parentQualifiedNamePath: [],
    };
    const symbols: SymbolRecord[] = [{
        ...common,
        symbolKey: 'file-key',
        symbolInstanceId: 'file-instance',
        kind: 'file',
        name: 'run.ts',
        qualifiedName: 'src/run.ts',
        label: 'src/run.ts',
        span: { startLine: 1, endLine: 3 },
    }, {
        ...common,
        symbolKey: 'run-key',
        symbolInstanceId: 'run-instance',
        kind: 'function',
        name: 'run',
        qualifiedName: 'run',
        label: 'function run',
        span: { startLine: 1, endLine: 3 },
    }];
    const files = [{
        path: 'src/run.ts',
        hash: 'file-hash',
        language: 'typescript',
        symbolCount: 2,
        definitionStatus: 'definitions_present' as const,
    }];
    const registry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath,
            rootFingerprint: 'root-fingerprint',
            indexPolicyHash: 'policy-hash',
            languageRouterVersion: 'router-v1',
            extractorVersion: 'extractor-v1',
            relationshipVersion: 'relationships-v1',
            builtAt: '2026-07-11T00:00:00.000Z',
            files,
        },
        symbols,
    });

    try {
        const publicationId = 'publication-test';
        const navigationRoot = path.join(stateRoot, publicationId, 'navigation');
        const written = await writeSymbolRegistrySidecar({ navigationRoot, registry });
        await writeRelationshipSidecar({
            navigationRoot,
            normalizedRootPath,
            symbolRegistryManifestHash: written.manifestHash,
            relationshipVersion: 'relationships-v1',
            builtAt: '2026-07-11T00:00:00.000Z',
            files,
            records: [],
        });

        const summary = await resolveLanguageCapabilityEvidence({
            normalizedRootPath,
            publicationId,
            navigationRoot,
            searchable: true,
        });
        assert.equal(summary.relationshipEvidence, 'compatible');
        assert.equal(summary.languages[0].language, 'typescript');
        assert.equal(summary.languages[0].capabilities.callGraph, 'ready');
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});
