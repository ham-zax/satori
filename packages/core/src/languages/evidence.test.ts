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
            { language: 'typescript' },
            { language: 'typescript' },
            { language: 'go' },
            { language: 'markdown' },
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
    assert.equal(typescript.declaredClaim, 'calls_v0');
    assert.equal(typescript.indexedFileCount, 2);
    assert.deepEqual(typescript.symbolEvidence, {
        eligibleFiles: 2,
        filesWithNonFileSymbols: 1,
        status: 'mixed',
    });
    assert.deepEqual(typescript.capabilities, {
        semanticSearch: 'ready',
        exactSymbol: 'degraded',
        outline: 'degraded',
        callGraph: 'degraded',
    });
    assert.deepEqual(typescript.degradationReasons, ['symbol_evidence_partial']);

    const go = summary.languages[0];
    assert.equal(go.declaredClaim, 'symbol_only');
    assert.equal(go.capabilities.exactSymbol, 'ready');
    assert.equal(go.capabilities.outline, 'ready');
    assert.equal(go.capabilities.callGraph, 'not_applicable');
    assert.equal(go.relationshipEvidence, 'not_applicable');

    const text = summary.languages[1];
    assert.equal(text.declaredClaim, 'search_only');
    assert.equal(text.capabilities.semanticSearch, 'ready');
    assert.equal(text.capabilities.exactSymbol, 'not_applicable');
    assert.equal(text.capabilities.outline, 'not_applicable');
    assert.equal(text.capabilities.callGraph, 'not_applicable');
});

test('language capability evidence fails closed for unavailable sidecars and non-searchable lifecycle state', () => {
    const summary = computeLanguageCapabilityEvidence({
        searchable: false,
        registryStatus: 'compatible',
        relationshipStatus: 'incompatible',
        files: [{ language: 'python' }],
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
    const files = [{ path: 'src/run.ts', hash: 'file-hash', language: 'typescript', symbolCount: 2 }];
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
        const written = await writeSymbolRegistrySidecar({ stateRoot, registry });
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath,
            symbolRegistryManifestHash: written.manifestHash,
            relationshipVersion: 'relationships-v1',
            builtAt: '2026-07-11T00:00:00.000Z',
            files,
            records: [],
        });

        const summary = await resolveLanguageCapabilityEvidence({
            normalizedRootPath,
            stateRoot,
            searchable: true,
        });
        assert.equal(summary.relationshipEvidence, 'compatible');
        assert.equal(summary.languages[0].language, 'typescript');
        assert.equal(summary.languages[0].capabilities.callGraph, 'ready');
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});
