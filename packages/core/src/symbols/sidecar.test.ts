import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    computeSymbolRegistryManifestHash,
    createSynthesizedFileSymbol,
} from './registry';
import {
    clearSymbolRegistrySidecar,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveNavigationSidecarRoot,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from './sidecar';
import type { RelationshipRecord, SymbolRegistryManifest } from './contracts';

function manifest(files: SymbolRegistryManifest['files']): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root-fingerprint',
        indexPolicyHash: 'policy-hash',
        languageRouterVersion: 'router-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files,
    };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'satori-symbol-sidecar-'));
    try {
        await fn(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

test('resolveNavigationSidecarRoot is deterministic and rooted under navigation state', () => {
    const first = resolveNavigationSidecarRoot('/tmp/state', '/repo');
    const second = resolveNavigationSidecarRoot('/tmp/state', '/repo/');
    const moved = resolveNavigationSidecarRoot('/tmp/state', '/other/repo');

    assert.equal(first, second);
    assert.ok(first.startsWith(path.join('/tmp/state', 'navigation')));
    assert.notEqual(first, moved);
});

test('writeSymbolRegistrySidecar writes sharding-ready registry files and read restores indexes', async () => {
    await withTempDir(async (stateRoot) => {
        const auth = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const routes = createSynthesizedFileSymbol({
            relativePath: 'src/routes.ts',
            language: 'typescript',
            content: 'export const routes = true;\n',
            fileHash: 'hash-routes',
            extractorVersion: 'extractor-v1',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 },
                { path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [routes, auth],
        });

        const result = await writeSymbolRegistrySidecar({
            stateRoot,
            registry,
        });

        assert.equal(result.manifestHash, computeSymbolRegistryManifestHash(registry.manifest));
        assert.equal(result.fileShardCount, 2);
        assert.equal(result.symbolCount, 2);

        const manifestPath = path.join(result.rootPath, 'manifest.json');
        const indexPath = path.join(result.rootPath, 'symbols', 'index.json');

        assert.equal(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')).schemaVersion, 'symbol_registry_v1');
        const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
        assert.equal(index.manifestHash, result.manifestHash);
        const authShardPath = path.join(result.rootPath, index.files.find((file: { path: string }) => file.path === 'src/auth.ts').shardPath);
        assert.equal(JSON.parse(await fs.promises.readFile(authShardPath, 'utf8')).symbols[0].file, 'src/auth.ts');
        assert.equal(await fs.promises.stat(path.join(result.rootPath, 'relationships', 'by-file')).then((stat) => stat.isDirectory()), true);

        const relationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: result.manifestHash,
        });

        assert.equal(relationships.status, 'ok');
        assert.equal(relationships.manifest?.symbolRegistryManifestHash, result.manifestHash);
        assert.deepEqual(relationships.records, []);

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        assert.equal(loaded.status, 'ok');
        assert.equal(loaded.registry?.symbols.length, 2);
        assert.deepEqual(loaded.registry?.symbolsByFile.get('src/auth.ts')?.map((symbol) => symbol.kind), ['file']);
        assert.deepEqual(loaded.warnings, []);
    });
});

test('readRelationshipSidecar reports missing and incompatible relationship states', async () => {
    await withTempDir(async (stateRoot) => {
        const missing = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: 'manifest-hash',
        });
        assert.equal(missing.status, 'missing');

        const rootPath = resolveNavigationSidecarRoot(stateRoot, '/repo');
        await fs.promises.mkdir(path.join(rootPath, 'relationships'), { recursive: true });
        await fs.promises.writeFile(
            path.join(rootPath, 'relationships', 'manifest.json'),
            JSON.stringify({
                schemaVersion: 'relationship_v1',
                symbolRegistryManifestHash: 'other-manifest-hash',
                relationshipVersion: 'relationship-v1',
                builtAt: '2026-06-17T00:00:00.000Z',
            }),
            'utf8'
        );

        const incompatibleHash = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: 'manifest-hash',
        });
        assert.equal(incompatibleHash.status, 'incompatible');
        assert.match(incompatibleHash.reason || '', /manifest hash/);

        await fs.promises.writeFile(
            path.join(rootPath, 'relationships', 'manifest.json'),
            JSON.stringify({ schemaVersion: 'wrong' }),
            'utf8'
        );

        const incompatibleManifest = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: 'manifest-hash',
        });
        assert.equal(incompatibleManifest.status, 'incompatible');
        assert.match(incompatibleManifest.reason || '', /manifest/);
    });
});

test('writeRelationshipSidecar writes deterministic per-file relationship shards', async () => {
    await withTempDir(async (stateRoot) => {
        const auth = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const routes = createSynthesizedFileSymbol({
            relativePath: 'src/routes.ts',
            language: 'typescript',
            content: 'export const routes = true;\n',
            fileHash: 'hash-routes',
            extractorVersion: 'extractor-v1',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 },
                { path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [routes, auth],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        const records: RelationshipRecord[] = [
            {
                sourceKey: routes.symbolKey,
                sourceInstanceId: routes.symbolInstanceId,
                targetKey: auth.symbolKey,
                targetInstanceId: auth.symbolInstanceId,
                type: 'CALLS',
                file: 'src/routes.ts',
                span: { startLine: 1, endLine: 1 },
                confidence: 'high',
            },
            {
                sourceKey: auth.symbolKey,
                sourceInstanceId: auth.symbolInstanceId,
                targetPath: 'src/routes.ts',
                type: 'IMPORTS',
                file: 'src/auth.ts',
                span: { startLine: 1, endLine: 1 },
                confidence: 'medium',
            },
        ];

        const relationshipResult = await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: registryResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: registry.manifest.files,
            records,
        });

        assert.equal(relationshipResult.relationshipCount, 2);
        assert.equal(relationshipResult.fileShardCount, 2);

        const loaded = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
        });

        assert.equal(loaded.status, 'ok');
        assert.deepEqual(loaded.records?.map((record) => `${record.file}:${record.type}`), [
            'src/auth.ts:IMPORTS',
            'src/routes.ts:CALLS',
        ]);
        assert.deepEqual(loaded.warnings, []);
    });
});

test('writeSymbolRegistrySidecar preserves existing relationships for compatibility-gated reads', async () => {
    await withTempDir(async (stateRoot) => {
        const auth = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const firstRegistry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 }]),
            symbols: [auth],
        });
        const firstResult = await writeSymbolRegistrySidecar({ stateRoot, registry: firstRegistry });
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: firstResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: firstRegistry.manifest.files,
            records: [{
                sourceKey: auth.symbolKey,
                sourceInstanceId: auth.symbolInstanceId,
                targetPath: 'src/routes.ts',
                type: 'IMPORTS',
                file: 'src/auth.ts',
                span: { startLine: 1, endLine: 1 },
                confidence: 'medium',
            }],
        });

        const changedAuth = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = false;\n',
            fileHash: 'hash-auth-next',
            extractorVersion: 'extractor-v1',
        });
        const nextRegistry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth-next', language: 'typescript', symbolCount: 1 }]),
            symbols: [changedAuth],
        });
        const nextResult = await writeSymbolRegistrySidecar({ stateRoot, registry: nextRegistry });

        const relationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: nextResult.manifestHash,
        });

        assert.equal(relationships.status, 'incompatible');
        assert.match(relationships.reason || '', /manifest hash/);
    });
});

test('writeSymbolRegistrySidecar rolls back the previous registry when subtree commit fails', async () => {
    await withTempDir(async (stateRoot) => {
        const original = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const originalRegistry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 }]),
            symbols: [original],
        });
        const originalResult = await writeSymbolRegistrySidecar({ stateRoot, registry: originalRegistry });
        const rootPath = originalResult.rootPath;

        const changed = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = false;\n',
            fileHash: 'hash-auth-next',
            extractorVersion: 'extractor-v1',
        });
        const changedRegistry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth-next', language: 'typescript', symbolCount: 1 }]),
            symbols: [changed],
        });

        const realRename = fs.promises.rename;
        fs.promises.rename = (async (source: fs.PathLike, destination: fs.PathLike) => {
            if (String(destination) === path.join(rootPath, 'symbols') && path.basename(String(source)).startsWith('.satori-tmp-')) {
                throw new Error('forced symbol commit failure');
            }
            return realRename(source, destination);
        }) as typeof fs.promises.rename;

        try {
            await assert.rejects(
                writeSymbolRegistrySidecar({ stateRoot, registry: changedRegistry }),
                /forced symbol commit failure/
            );
        } finally {
            fs.promises.rename = realRename;
        }

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        assert.equal(loaded.status, 'ok');
        assert.equal(loaded.manifestHash, originalResult.manifestHash);
        assert.deepEqual(loaded.registry?.manifest.files.map((file) => file.hash), ['hash-auth']);
    });
});

test('writeSymbolRegistrySidecar rolls back the previous registry when manifest commit fails after subtree replacement', async () => {
    await withTempDir(async (stateRoot) => {
        const original = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const originalRegistry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 }]),
            symbols: [original],
        });
        const originalResult = await writeSymbolRegistrySidecar({ stateRoot, registry: originalRegistry });
        const rootPath = originalResult.rootPath;

        const changed = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = false;\n',
            fileHash: 'hash-auth-next',
            extractorVersion: 'extractor-v1',
        });
        const changedRegistry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth-next', language: 'typescript', symbolCount: 1 }]),
            symbols: [changed],
        });

        const realRename = fs.promises.rename;
        fs.promises.rename = (async (source: fs.PathLike, destination: fs.PathLike) => {
            if (
                String(destination) === path.join(rootPath, 'manifest.json')
                && path.basename(String(source)).startsWith('.satori-tmp-')
            ) {
                throw new Error('forced manifest commit failure');
            }
            return realRename(source, destination);
        }) as typeof fs.promises.rename;

        try {
            await assert.rejects(
                writeSymbolRegistrySidecar({ stateRoot, registry: changedRegistry }),
                /forced manifest commit failure/
            );
        } finally {
            fs.promises.rename = realRename;
        }

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        assert.equal(loaded.status, 'ok');
        assert.equal(loaded.manifestHash, originalResult.manifestHash);
        assert.deepEqual(loaded.registry?.manifest.files.map((file) => file.hash), ['hash-auth']);
    });
});

test('writeSymbolRegistrySidecar does not create relationship placeholder when initial registry commit fails', async () => {
    await withTempDir(async (stateRoot) => {
        const symbol = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 }]),
            symbols: [symbol],
        });
        const rootPath = resolveNavigationSidecarRoot(stateRoot, '/repo');

        const realRename = fs.promises.rename;
        fs.promises.rename = (async (source: fs.PathLike, destination: fs.PathLike) => {
            if (String(destination) === path.join(rootPath, 'symbols') && path.basename(String(source)).startsWith('.satori-tmp-')) {
                throw new Error('forced initial symbol commit failure');
            }
            return realRename(source, destination);
        }) as typeof fs.promises.rename;

        try {
            await assert.rejects(
                writeSymbolRegistrySidecar({ stateRoot, registry }),
                /forced initial symbol commit failure/
            );
        } finally {
            fs.promises.rename = realRename;
        }

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        const relationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: computeSymbolRegistryManifestHash(registry.manifest),
        });

        assert.equal(loaded.status, 'missing');
        assert.equal(relationships.status, 'missing');
    });
});

test('writeSymbolRegistrySidecar uses per-path shards for files with identical content hashes', async () => {
    await withTempDir(async (stateRoot) => {
        const first = createSynthesizedFileSymbol({
            relativePath: 'src/a.ts',
            language: 'typescript',
            content: 'export const same = true;\n',
            fileHash: 'same-hash',
            extractorVersion: 'extractor-v1',
        });
        const second = createSynthesizedFileSymbol({
            relativePath: 'src/b.ts',
            language: 'typescript',
            content: 'export const same = true;\n',
            fileHash: 'same-hash',
            extractorVersion: 'extractor-v1',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/a.ts', hash: 'same-hash', language: 'typescript', symbolCount: 1 },
                { path: 'src/b.ts', hash: 'same-hash', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [first, second],
        });

        const result = await writeSymbolRegistrySidecar({ stateRoot, registry });
        const index = JSON.parse(await fs.promises.readFile(path.join(result.rootPath, 'symbols', 'index.json'), 'utf8'));

        assert.notEqual(index.files[0].shardPath, index.files[1].shardPath);

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        assert.equal(loaded.status, 'ok');
        assert.equal(loaded.registry?.symbolsByFile.get('src/a.ts')?.length, 1);
        assert.equal(loaded.registry?.symbolsByFile.get('src/b.ts')?.length, 1);
    });
});

test('writeRelationshipSidecar rolls back the previous relationships when subtree commit fails', async () => {
    await withTempDir(async (stateRoot) => {
        const auth = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const routes = createSynthesizedFileSymbol({
            relativePath: 'src/routes.ts',
            language: 'typescript',
            content: 'export const routes = true;\n',
            fileHash: 'hash-routes',
            extractorVersion: 'extractor-v1',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 },
                { path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [routes, auth],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: registryResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: registry.manifest.files,
            records: [{
                sourceKey: routes.symbolKey,
                sourceInstanceId: routes.symbolInstanceId,
                targetKey: auth.symbolKey,
                targetInstanceId: auth.symbolInstanceId,
                type: 'CALLS',
                file: 'src/routes.ts',
                span: { startLine: 1, endLine: 1 },
                confidence: 'high',
            }],
        });

        const rootPath = registryResult.rootPath;
        const realRename = fs.promises.rename;
        fs.promises.rename = (async (source: fs.PathLike, destination: fs.PathLike) => {
            if (String(destination) === path.join(rootPath, 'relationships') && path.basename(String(source)).startsWith('.satori-tmp-')) {
                throw new Error('forced relationship commit failure');
            }
            return realRename(source, destination);
        }) as typeof fs.promises.rename;

        try {
            await assert.rejects(
                writeRelationshipSidecar({
                    stateRoot,
                    normalizedRootPath: '/repo',
                    symbolRegistryManifestHash: registryResult.manifestHash,
                    relationshipVersion: 'relationship-v1',
                    builtAt: '2026-06-17T00:00:00.000Z',
                    files: registry.manifest.files,
                    records: [{
                        sourceKey: auth.symbolKey,
                        sourceInstanceId: auth.symbolInstanceId,
                        targetPath: 'src/routes.ts',
                        type: 'IMPORTS',
                        file: 'src/auth.ts',
                        span: { startLine: 1, endLine: 1 },
                        confidence: 'medium',
                    }],
                }),
                /forced relationship commit failure/
            );
        } finally {
            fs.promises.rename = realRename;
        }

        const loaded = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
        });

        assert.equal(loaded.status, 'ok');
        assert.deepEqual(loaded.records?.map((record) => `${record.file}:${record.type}`), ['src/routes.ts:CALLS']);
    });
});

test('clearSymbolRegistrySidecar removes stale navigation state', async () => {
    await withTempDir(async (stateRoot) => {
        const symbol = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 }]),
            symbols: [symbol],
        });
        await writeSymbolRegistrySidecar({ stateRoot, registry });
        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        assert.equal(loaded.status, 'missing');
    });
});

test('readSymbolRegistrySidecar reports missing and incompatible registry states without retrieval chunks', async () => {
    await withTempDir(async (stateRoot) => {
        const missing = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        assert.equal(missing.status, 'missing');

        const rootPath = resolveNavigationSidecarRoot(stateRoot, '/repo');
        await fs.promises.mkdir(rootPath, { recursive: true });
        await fs.promises.writeFile(path.join(rootPath, 'manifest.json'), JSON.stringify({ schemaVersion: 'wrong' }), 'utf8');

        const incompatible = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        assert.equal(incompatible.status, 'incompatible');
        assert.match(incompatible.reason || '', /manifest/);
    });
});
