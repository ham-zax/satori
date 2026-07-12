import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
    stageNavigationSidecarGeneration,
    publishNavigationSidecarGeneration,
    writeNavigationSidecarGeneration,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from './sidecar';
import type { RelationshipRecord, SymbolRecord, SymbolRegistryManifest } from './contracts';

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

async function readJsonFile<T>(filePath: string): Promise<T> {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function resealSymbolShard(shardPath: string): Promise<void> {
    const serialized = await fs.promises.readFile(shardPath, 'utf8');
    const indexPath = path.join(path.dirname(path.dirname(shardPath)), 'index.json');
    const index = await readJsonFile<{ files: Array<{ shardPath: string; shardHash: string }> }>(indexPath);
    const entry = index.files.find((file) => path.basename(file.shardPath) === path.basename(shardPath));
    assert.ok(entry);
    entry.shardHash = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
    await writeJsonFile(indexPath, index);
}

async function writeSingleSymbolRegistryFixture(stateRoot: string): Promise<{
    symbol: SymbolRecord;
    result: Awaited<ReturnType<typeof writeSymbolRegistrySidecar>>;
    shardPath: string;
}> {
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
    const result = await writeSymbolRegistrySidecar({ stateRoot, registry });
    const index = await readJsonFile<{ files: Array<{ path: string; shardPath: string }> }>(
        path.join(result.rootPath, 'symbols', 'index.json')
    );
    const shardPath = path.join(
        result.rootPath,
        index.files.find((file) => file.path === 'src/auth.ts')?.shardPath || ''
    );
    return { symbol, result, shardPath };
}

async function writeSingleRelationshipFixture(stateRoot: string): Promise<{
    registryResult: Awaited<ReturnType<typeof writeSymbolRegistrySidecar>>;
    record: RelationshipRecord;
    shardPath: string;
}> {
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
        symbols: [auth, routes],
    });
    const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
    const record: RelationshipRecord = {
        sourceKey: routes.symbolKey,
        sourceInstanceId: routes.symbolInstanceId,
        targetKey: auth.symbolKey,
        targetInstanceId: auth.symbolInstanceId,
        type: 'CALLS',
        file: 'src/routes.ts',
        span: { startLine: 1, endLine: 1 },
        confidence: 'high',
    };
    await writeRelationshipSidecar({
        stateRoot,
        normalizedRootPath: '/repo',
        symbolRegistryManifestHash: registryResult.manifestHash,
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files: registry.manifest.files,
        records: [record],
    });
    const relationshipManifest = await readJsonFile<{ files: Array<{ path: string; shardPath: string }> }>(
        path.join(registryResult.rootPath, 'relationships', 'manifest.json'),
    );
    const shardFile = relationshipManifest.files.find((file) => file.path === record.file)?.shardPath;
    assert.ok(shardFile);
    return {
        registryResult,
        record,
        shardPath: path.join(registryResult.rootPath, shardFile),
    };
}

test('resolveNavigationSidecarRoot is deterministic and rooted under navigation state', () => {
    const first = resolveNavigationSidecarRoot('/tmp/state', '/repo');
    const second = resolveNavigationSidecarRoot('/tmp/state', '/repo/');
    const moved = resolveNavigationSidecarRoot('/tmp/state', '/other/repo');

    assert.equal(first, second);
    assert.ok(first.startsWith(path.join('/tmp/state', 'navigation')));
    assert.notEqual(first, moved);
});

test('writeSymbolRegistrySidecar does not publish after the mutation guard fails', async () => {
    await withTempDir(async (stateRoot) => {
        const registry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 0 }]),
            symbols: [],
        });
        let guardCalls = 0;

        await assert.rejects(
            () => writeSymbolRegistrySidecar({
                stateRoot,
                registry,
                beforePublish: () => {
                    guardCalls += 1;
                    if (guardCalls === 2) {
                        throw new Error('mutation lease lost');
                    }
                },
            }),
            /mutation lease lost/,
        );

        assert.equal(guardCalls, 2);
        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        assert.notEqual(sidecar.status, 'ok');
    });
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
        const relationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: result.manifestHash,
        });

        assert.equal(relationships.status, 'missing');

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
                schemaVersion: 'relationship_v2',
                symbolRegistryManifestHash: 'other-manifest-hash',
                relationshipVersion: 'relationship-v1',
                builtAt: '2026-06-17T00:00:00.000Z',
                files: [],
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
            analysisByFile: new Map([
                ['src/routes.ts', {
                    moduleBindings: [],
                    callSites: [{
                        calleeName: 'auth',
                        span: {
                            startLine: 1,
                            endLine: 1,
                            startByte: 0,
                            endByte: 6,
                            startColumn: 0,
                            endColumn: 6,
                        },
                    }],
                }],
            ]),
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
        assert.deepEqual(loaded.analysisByFile?.get('src/routes.ts')?.callSites, [{
            calleeName: 'auth',
            span: {
                startLine: 1,
                endLine: 1,
                startByte: 0,
                endByte: 6,
                startColumn: 0,
                endColumn: 6,
            },
        }]);
    });
});

test('writeRelationshipSidecar preserves evidence-only files when manifest files are omitted', async () => {
    await withTempDir(async (stateRoot) => {
        const analysisEvidence = {
            moduleBindings: [],
            callSites: [],
        };
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: 'manifest-hash',
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            records: [],
            analysisByFile: new Map([['src/unrelated.ts', analysisEvidence]]),
        });

        const loaded = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: 'manifest-hash',
        });

        assert.equal(loaded.status, 'ok');
        assert.deepEqual(loaded.analysisByFile?.get('src/unrelated.ts'), analysisEvidence);
    });
});

test('writeRelationshipSidecar filters evidence to supplied manifest files', async () => {
    await withTempDir(async (stateRoot) => {
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: 'manifest-hash',
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            records: [],
            files: [{ path: 'src/tracked.ts', hash: 'file-hash', language: 'typescript', symbolCount: 0 }],
            analysisByFile: new Map([
                ['src/tracked.ts', { moduleBindings: [], callSites: [] }],
                ['src/untracked.ts', { moduleBindings: [], callSites: [] }],
            ]),
        });

        const loaded = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: 'manifest-hash',
        });

        assert.equal(loaded.status, 'ok');
        assert.deepEqual([...loaded.analysisByFile?.keys() ?? []], ['src/tracked.ts']);
    });
});

test('readRelationshipSidecar rejects duplicate shard paths', async () => {
    await withTempDir(async (stateRoot) => {
        const result = await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: 'manifest-hash',
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            records: [],
            files: [{ path: 'src/unrelated.ts', hash: 'file-hash', language: 'typescript', symbolCount: 0 }],
            analysisByFile: new Map([['src/unrelated.ts', { moduleBindings: [], callSites: [] }]]),
        });
        const byFileDir = path.join(result.rootPath, 'relationships', 'by-file');
        const [shardName] = await fs.promises.readdir(byFileDir);
        assert.ok(shardName);
        await fs.promises.copyFile(
            path.join(byFileDir, shardName),
            path.join(byFileDir, `duplicate-${shardName}`),
        );

        const loaded = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: 'manifest-hash',
        });

        assert.equal(loaded.status, 'incompatible');
        assert.match(loaded.reason || '', /shard set.*manifest/);
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

test('clearSymbolRegistrySidecar checks the mutation fence immediately before deletion', async () => {
    await withTempDir(async (stateRoot) => {
        await writeSingleSymbolRegistryFixture(stateRoot);
        const rootPath = resolveNavigationSidecarRoot(stateRoot, '/repo');

        await assert.rejects(
            () => clearSymbolRegistrySidecar({
                stateRoot,
                normalizedRootPath: '/repo',
                beforeDelete: () => {
                    throw new Error('lease lost before delete');
                },
            }),
            /lease lost before delete/,
        );
        assert.equal(fs.existsSync(rootPath), true);
    });
});

test('clearSymbolRegistrySidecar atomically detaches only the generation owned by the caller', async () => {
    await withTempDir(async (stateRoot) => {
        await writeSingleSymbolRegistryFixture(stateRoot);
        const rootPath = resolveNavigationSidecarRoot(stateRoot, '/repo');
        let publicationCalls = 0;

        await clearSymbolRegistrySidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            publishMutation: (publish) => {
                publicationCalls += 1;
                publish();
                fs.mkdirSync(rootPath, { recursive: true });
                fs.writeFileSync(path.join(rootPath, 'new-generation'), 'new', 'utf8');
            },
        });

        assert.equal(publicationCalls, 1);
        assert.equal(fs.readFileSync(path.join(rootPath, 'new-generation'), 'utf8'), 'new');
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

test('readSymbolRegistrySidecar rejects malformed symbol shard records', async () => {
    const cases: Array<{
        name: string;
        mutate: (symbol: SymbolRecord) => unknown;
    }> = [
        {
            name: 'missing symbolInstanceId',
            mutate: (symbol) => {
                const withoutInstanceId: Partial<SymbolRecord> = { ...symbol };
                delete withoutInstanceId.symbolInstanceId;
                return withoutInstanceId;
            },
        },
        {
            name: 'missing symbolKey',
            mutate: (symbol) => {
                const withoutSymbolKey: Partial<SymbolRecord> = { ...symbol };
                delete withoutSymbolKey.symbolKey;
                return withoutSymbolKey;
            },
        },
        {
            name: 'invalid span',
            mutate: (symbol) => ({
                ...symbol,
                span: { startLine: 3, endLine: 2 },
            }),
        },
        {
            name: 'invalid kind',
            mutate: (symbol) => ({
                ...symbol,
                kind: 'procedure',
            }),
        },
        {
            name: 'mismatched file hash',
            mutate: (symbol) => ({
                ...symbol,
                fileHash: 'different-hash',
            }),
        },
        {
            name: 'mismatched language',
            mutate: (symbol) => ({
                ...symbol,
                language: 'javascript',
            }),
        },
    ];

    for (const item of cases) {
        await withTempDir(async (stateRoot) => {
            const { symbol, shardPath } = await writeSingleSymbolRegistryFixture(stateRoot);
            const shard = await readJsonFile<{ manifestHash: string; symbols: unknown[] }>(shardPath);
            await writeJsonFile(shardPath, {
                ...shard,
                symbols: [item.mutate(symbol)],
            });

            const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

            assert.equal(loaded.status, 'incompatible', item.name);
            assert.match(loaded.reason || '', /symbol registry shard (?:hash does not match index|record is invalid)/);
        });
    }
});

test('readSymbolRegistrySidecar accepts multi-line spans whose end column precedes the start column', async () => {
    await withTempDir(async (stateRoot) => {
        const { symbol, shardPath } = await writeSingleSymbolRegistryFixture(stateRoot);
        const shard = await readJsonFile<{ manifestHash: string; symbols: unknown[] }>(shardPath);
        await writeJsonFile(shardPath, {
            ...shard,
            symbols: [{
                ...symbol,
                span: {
                    startLine: 3,
                    endLine: 5,
                    startByte: 18,
                    endByte: 47,
                    startColumn: 5,
                    endColumn: 1,
                },
            }],
        });
        await resealSymbolShard(shardPath);

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        assert.equal(loaded.status, 'ok');
        assert.equal(loaded.registry?.symbolsByInstanceId.has(symbol.symbolInstanceId), true);
    });
});

test('readSymbolRegistrySidecar rejects malformed symbol shard metadata', async () => {
    const cases: Array<{
        name: string;
        mutate: (shard: Record<string, unknown>) => Record<string, unknown>;
    }> = [
        {
            name: 'mismatched shard path',
            mutate: (shard) => ({ ...shard, path: 'src/other.ts' }),
        },
        {
            name: 'mismatched shard hash',
            mutate: (shard) => ({ ...shard, hash: 'different-hash' }),
        },
        {
            name: 'mismatched shard language',
            mutate: (shard) => ({ ...shard, language: 'javascript' }),
        },
    ];

    for (const item of cases) {
        await withTempDir(async (stateRoot) => {
            const { shardPath } = await writeSingleSymbolRegistryFixture(stateRoot);
            const shard = await readJsonFile<Record<string, unknown>>(shardPath);
            await writeJsonFile(shardPath, item.mutate(shard));

            const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

            assert.equal(loaded.status, 'incompatible', item.name);
            assert.match(loaded.reason || '', /symbol registry shard (?:hash does not match index|is invalid)/);
        });
    }
});

test('readRelationshipSidecar rejects malformed relationship shard records', async () => {
    const cases: Array<{
        name: string;
        mutate: (record: RelationshipRecord) => unknown;
    }> = [
        {
            name: 'missing source id',
            mutate: (record) => {
                const withoutSource: Partial<RelationshipRecord> = { ...record };
                delete withoutSource.sourceKey;
                return withoutSource;
            },
        },
        {
            name: 'missing target id/path',
            mutate: (record) => {
                const withoutTarget: Partial<RelationshipRecord> = { ...record };
                delete withoutTarget.targetKey;
                delete withoutTarget.targetInstanceId;
                delete withoutTarget.targetPath;
                return withoutTarget;
            },
        },
        {
            name: 'invalid target id',
            mutate: (record) => ({ ...record, targetInstanceId: '' }),
        },
        {
            name: 'invalid relationship kind',
            mutate: (record) => ({ ...record, type: 'INVOKES' }),
        },
        {
            name: 'invalid confidence',
            mutate: (record) => ({ ...record, confidence: 'certain' }),
        },
        {
            name: 'invalid span',
            mutate: (record) => ({
                ...record,
                span: { startLine: 4, endLine: 3 },
            }),
        },
        {
            name: 'mismatched file',
            mutate: (record) => ({ ...record, file: 'src/other.ts' }),
        },
    ];

    for (const item of cases) {
        await withTempDir(async (stateRoot) => {
            const { registryResult, record, shardPath } = await writeSingleRelationshipFixture(stateRoot);
            const shard = await readJsonFile<{ manifestHash: string; relationships: unknown[] }>(shardPath);
            await writeJsonFile(shardPath, {
                ...shard,
                relationships: [item.mutate(record)],
            });

            const loaded = await readRelationshipSidecar({
                stateRoot,
                normalizedRootPath: '/repo',
                expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            });

            assert.equal(loaded.status, 'incompatible', item.name);
            assert.match(loaded.reason || '', /relationship shard record is invalid/);
        });
    }
});

test('readRelationshipSidecar rejects malformed relationship shard metadata', async () => {
    const cases: Array<{
        name: string;
        mutate: (shard: Record<string, unknown>) => Record<string, unknown>;
        expectedReason: RegExp;
    }> = [
        {
            name: 'mismatched shard hash',
            mutate: (shard) => ({ ...shard, manifestHash: 'other-manifest-hash' }),
            expectedReason: /relationship shard hash does not match/,
        },
        {
            name: 'missing shard path',
            mutate: (shard) => {
                const withoutPath = { ...shard };
                delete withoutPath.path;
                return withoutPath;
            },
            expectedReason: /relationship shard metadata is invalid/,
        },
    ];

    for (const item of cases) {
        await withTempDir(async (stateRoot) => {
            const { registryResult, shardPath } = await writeSingleRelationshipFixture(stateRoot);
            const shard = await readJsonFile<Record<string, unknown>>(shardPath);
            await writeJsonFile(shardPath, item.mutate(shard));

            const loaded = await readRelationshipSidecar({
                stateRoot,
                normalizedRootPath: '/repo',
                expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            });

            assert.equal(loaded.status, 'incompatible', item.name);
            assert.match(loaded.reason || '', item.expectedReason);
        });
    }
});

test('sidecar readers tolerate unknown extra fields in valid shard records', async () => {
    await withTempDir(async (stateRoot) => {
        const { symbol, shardPath: symbolShardPath } = await writeSingleSymbolRegistryFixture(stateRoot);
        const symbolShard = await readJsonFile<{ manifestHash: string; symbols: unknown[] }>(symbolShardPath);
        await writeJsonFile(symbolShardPath, {
            ...symbolShard,
            symbols: [{ ...symbol, extraContractField: 'ignored' }],
        });
        await resealSymbolShard(symbolShardPath);

        const loadedRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });

        assert.equal(loadedRegistry.status, 'ok');
        assert.equal(loadedRegistry.registry?.symbolsByInstanceId.has(symbol.symbolInstanceId), true);

        const { registryResult, record, shardPath: relationshipShardPath } = await writeSingleRelationshipFixture(stateRoot);
        const relationshipShard = await readJsonFile<{ manifestHash: string; relationships: unknown[] }>(relationshipShardPath);
        const updatedRelationshipShard = {
            ...relationshipShard,
            relationships: [{ ...record, extraContractField: 'ignored' }],
        };
        await writeJsonFile(relationshipShardPath, updatedRelationshipShard);
        const relationshipManifestPath = path.join(registryResult.rootPath, 'relationships', 'manifest.json');
        const relationshipManifest = await readJsonFile<{
            files: Array<{ path: string; shardHash: string }>;
        }>(relationshipManifestPath);
        const relationshipManifestFile = relationshipManifest.files.find((file) => file.path === record.file);
        assert.ok(relationshipManifestFile);
        relationshipManifestFile.shardHash = crypto
            .createHash('sha256')
            .update(`${JSON.stringify(updatedRelationshipShard, null, 2)}\n`, 'utf8')
            .digest('hex');
        await writeJsonFile(relationshipManifestPath, relationshipManifest);

        const loadedRelationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
        });

        assert.equal(loadedRelationships.status, 'ok');
        assert.equal(loadedRelationships.records?.length, 1);
    });
});

test('writeSymbolRegistrySidecar keeps manifest hash stable across deterministic rewrites', async () => {
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

        const first = await writeSymbolRegistrySidecar({ stateRoot, registry });
        const second = await writeSymbolRegistrySidecar({ stateRoot, registry });

        assert.equal(first.manifestHash, second.manifestHash);
        assert.equal(first.fileShardCount, second.fileShardCount);
        assert.equal(first.symbolCount, second.symbolCount);
    });
});

test('readSymbolRegistrySidecar rejects an index that does not exactly match the manifest', async () => {
    await withTempDir(async (stateRoot) => {
        const { result } = await writeSingleSymbolRegistryFixture(stateRoot);
        const indexPath = path.join(result.rootPath, 'symbols', 'index.json');
        const index = await readJsonFile<{ files: Array<Record<string, unknown>> }>(indexPath);
        index.files[0].shardPath = '../outside.json';
        await writeJsonFile(indexPath, index);

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        assert.equal(loaded.status, 'incompatible');
        assert.match(loaded.reason || '', /index.*(?:manifest|invalid|incompatible)|deterministic shard/i);
    });
});

test('readSymbolRegistrySidecar verifies actual shard symbol counts', async () => {
    await withTempDir(async (stateRoot) => {
        const { shardPath } = await writeSingleSymbolRegistryFixture(stateRoot);
        const shard = await readJsonFile<Record<string, unknown>>(shardPath);
        await writeJsonFile(shardPath, { ...shard, symbols: [] });

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        assert.equal(loaded.status, 'incompatible');
        assert.match(loaded.reason || '', /symbol count|shard hash/i);
    });
});

test('relationship manifest proves every expected shard exists', async () => {
    await withTempDir(async (stateRoot) => {
        const { registryResult } = await writeSingleRelationshipFixture(stateRoot);
        const manifestPath = path.join(registryResult.rootPath, 'relationships', 'manifest.json');
        const relationshipManifest = await readJsonFile<{ files: Array<{ shardPath: string }> }>(manifestPath);
        assert.ok(relationshipManifest.files.length > 0);
        await fs.promises.rm(path.join(registryResult.rootPath, relationshipManifest.files[0].shardPath));

        const loaded = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
        });
        assert.equal(loaded.status, 'incompatible');
        assert.match(loaded.reason || '', /relationship shard.*(?:missing|set)|ENOENT/i);
    });
});

test('writeRelationshipSidecar rejects records outside the supplied registry manifest', async () => {
    await withTempDir(async (stateRoot) => {
        await assert.rejects(
            () => writeRelationshipSidecar({
                stateRoot,
                normalizedRootPath: '/repo',
                symbolRegistryManifestHash: 'manifest-hash',
                relationshipVersion: 'relationship-v1',
                builtAt: '2026-06-17T00:00:00.000Z',
                files: [{ path: 'src/tracked.ts', hash: 'tracked-hash', language: 'typescript', symbolCount: 0 }],
                records: [{
                    sourceKey: 'source',
                    targetPath: 'src/target.ts',
                    type: 'IMPORTS',
                    file: 'src/foreign.ts',
                    confidence: 'high',
                }],
            }),
            /outside the supplied symbol manifest/i,
        );
    });
});

test('writeNavigationSidecarGeneration publishes symbols and relationships through one generation pointer', async () => {
    await withTempDir(async (stateRoot) => {
        const firstSymbol = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = true;\n',
            fileHash: 'hash-auth-v1',
            extractorVersion: 'extractor-v1',
        });
        const firstRegistry = buildSymbolRegistry({
            manifest: manifest([{ path: 'src/auth.ts', hash: 'hash-auth-v1', language: 'typescript', symbolCount: 1 }]),
            symbols: [firstSymbol],
        });
        const first = await writeNavigationSidecarGeneration({
            stateRoot,
            registry: firstRegistry,
            records: [],
            analysisByFile: new Map([['src/auth.ts', { moduleBindings: [], callSites: [] }]]),
        });

        const secondSymbol = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export const auth = false;\n',
            fileHash: 'hash-auth-v2',
            extractorVersion: 'extractor-v1',
        });
        const secondRegistry = buildSymbolRegistry({
            manifest: { ...firstRegistry.manifest, builtAt: '2026-06-18T00:00:00.000Z', files: [{ path: 'src/auth.ts', hash: 'hash-auth-v2', language: 'typescript', symbolCount: 1 }] },
            symbols: [secondSymbol],
        });
        await assert.rejects(
            () => writeNavigationSidecarGeneration({
                stateRoot,
                registry: secondRegistry,
                records: [],
                analysisByFile: new Map([['src/auth.ts', { moduleBindings: [], callSites: [] }]]),
                publishMutation: () => {
                    throw new Error('lease lost before generation publication');
                },
            }),
            /lease lost before generation publication/,
        );

        const loaded = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        assert.equal(loaded.status, 'ok');
        assert.equal(loaded.manifestHash, first.manifestHash);
        assert.equal(loaded.registry?.manifest.files[0].hash, 'hash-auth-v1');
    });
});

test('staged navigation remains unreadable until its generation pointer is published', async () => {
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

        const candidate = await stageNavigationSidecarGeneration({
            stateRoot,
            registry,
            records: [],
            analysisByFile: new Map([['src/auth.ts', { moduleBindings: [], callSites: [] }]]),
        });

        assert.equal((await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' })).status, 'missing');
        await publishNavigationSidecarGeneration(candidate);
        const published = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: '/repo' });
        assert.equal(published.status, 'ok');
        assert.equal(published.manifestHash, candidate.manifestHash);
    });
});
