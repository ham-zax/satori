import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRelationshipSidecar } from './sidecar-reads';
import { writeRelationshipSidecar } from './sidecar-writes';

test('relationship sidecar preserves skipped semantic source files in provider coverage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-skipped-coverage-'));
    const publicationId = 'fixture-publication';
    const navigationRoot = path.join(root, publicationId, 'navigation');
    const symbolRegistryManifestHash = 'fixture-symbol-hash';
    try {
        await writeRelationshipSidecar({
            normalizedRootPath: root,
            navigationRoot,
            symbolRegistryManifestHash,
            relationshipVersion: 'fixture-version',
            builtAt: new Date(0).toISOString(),
            records: [],
            providerCoverage: [{
                language: 'rust',
                providerId: 'fixture',
                providerVersion: '1',
                status: 'degraded',
                sourceFileCount: 2,
                analyzedSourceFileCount: 1,
                skippedFiles: [
                    { path: 'z.rs', reason: 'source_too_large', bytes: 10 },
                    { path: 'a.rs', reason: 'source_too_large', bytes: 20 },
                ],
            }],
        });
        const read = await readRelationshipSidecar({
            normalizedRootPath: root,
            expectedSymbolRegistryManifestHash: symbolRegistryManifestHash,
            navigationRoot,
            publicationId,
        });
        assert.equal(read.status, 'ok', read.status === 'ok' ? undefined : read.reason);
        assert.deepEqual(read.manifest.providerCoverage[0]?.skippedFiles, [
            { path: 'a.rs', reason: 'source_too_large', bytes: 20 },
            { path: 'z.rs', reason: 'source_too_large', bytes: 10 },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('symbol publication roundtrip preserves parser reasons and legacy unknown evidence', async () => {
    const { buildSymbolRegistry, computeSymbolRegistryManifestHash } = await import('./registry.js');
    const { SYMBOL_REGISTRY_SCHEMA_VERSION } = await import('./contracts.js');
    const { writeSymbolRegistrySidecar } = await import('./sidecar-writes.js');
    const { readSymbolRegistrySidecar } = await import('./sidecar-reads.js');
    const { computeSymbolQualitySummaryFromSidecarRead } = await import('./symbol-quality.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-parser-outcomes-'));
    const navigationRoot = path.join(root, 'fixture', 'navigation');
    try {
        const registry = buildSymbolRegistry({ manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: root, rootFingerprint: 'root',
            indexPolicyHash: 'policy', languageRouterVersion: 'router', extractorVersion: 'extractor',
            relationshipVersion: 'relationship', builtAt: new Date(0).toISOString(),
            files: [
                { path: 'a.ts', hash: 'a', language: 'typescript', symbolCount: 0, definitionStatus: 'structural_unavailable', structuralStatus: 'recovered', structuralReason: 'syntax_error' },
                { path: 'legacy.ts', hash: 'b', language: 'typescript', symbolCount: 0, definitionStatus: 'structural_unavailable' },
            ],
        }, symbols: [] });
        const changed = { ...registry.manifest, files: registry.manifest.files.map(file => ({ ...file, structuralReason: file.structuralReason ? 'parser_unavailable' as const : undefined })) };
        assert.notEqual(computeSymbolRegistryManifestHash(registry.manifest), computeSymbolRegistryManifestHash(changed));
        await writeSymbolRegistrySidecar({ registry, navigationRoot });
        const read = await readSymbolRegistrySidecar({ normalizedRootPath: root, publicationId: 'fixture', navigationRoot });
        assert.equal(read.status, 'ok', read.status === 'ok' ? undefined : read.reason);
        assert.deepEqual(computeSymbolQualitySummaryFromSidecarRead(read).structuralAnalysis, {
            completeFiles: 0, recoveredFiles: 1, unsupportedFiles: 0, unknownFiles: 1,
            reasons: [{ reason: 'syntax_error', files: 1 }],
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
