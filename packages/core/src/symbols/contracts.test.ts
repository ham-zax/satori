import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    canonicalizeSymbolSpanForHash,
    isRelationshipManifest,
    isSymbolRegistryManifest,
} from './contracts';
import type {
    RelationshipManifest,
    SymbolRecord,
    SymbolRegistryManifest,
} from './contracts';

test('symbol contract exports stable schema versions and validates registry manifests', () => {
    assert.equal(SYMBOL_REGISTRY_SCHEMA_VERSION, 'symbol_registry_v1');

    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root-fp',
        indexPolicyHash: 'policy-hash',
        languageRouterVersion: 'router-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files: [{
            path: 'src/app.ts',
            hash: 'file-hash',
            language: 'typescript',
            symbolCount: 2,
        }],
    };

    assert.equal(isSymbolRegistryManifest(manifest), true);
    assert.equal(isSymbolRegistryManifest({ ...manifest, schemaVersion: 'wrong' }), false);
    assert.equal(isSymbolRegistryManifest({ ...manifest, files: [{ path: 'src/app.ts' }] }), false);
});

test('symbol contract models stable and exact symbol identity separately', () => {
    const symbol: SymbolRecord = {
        symbolKey: 'sym-key',
        symbolInstanceId: 'sym-instance',
        language: 'typescript',
        kind: 'file',
        name: 'app.ts',
        qualifiedName: 'src/app.ts',
        label: 'src/app.ts',
        file: 'src/app.ts',
        span: {
            startLine: 1,
            endLine: 40,
        },
        parentQualifiedNamePath: [],
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    };

    assert.equal(symbol.kind, 'file');
    assert.deepEqual(symbol.parentQualifiedNamePath, []);
});

test('canonicalizeSymbolSpanForHash omits absent optional fields and preserves field order', () => {
    assert.equal(
        canonicalizeSymbolSpanForHash({
            startLine: 1,
            endLine: 2,
            startByte: undefined,
            endByte: 20,
            startColumn: undefined,
            endColumn: 4,
        }),
        '{"startLine":1,"endLine":2,"endByte":20,"endColumn":4}'
    );
});

test('relationship manifest validates compatibility anchor', () => {
    assert.equal(RELATIONSHIP_MANIFEST_SCHEMA_VERSION, 'relationship_v1');

    const manifest: RelationshipManifest = {
        schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
        symbolRegistryManifestHash: 'registry-manifest-hash',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
    };

    assert.equal(isRelationshipManifest(manifest), true);
    assert.equal(isRelationshipManifest({ ...manifest, symbolRegistryManifestHash: '' }), false);
    assert.equal(isRelationshipManifest({ ...manifest, schemaVersion: 'relationship_v2' }), false);
});
