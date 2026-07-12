import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    createSynthesizedFileSymbol,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from '../symbols';
import type {
    SymbolRecord,
    SymbolRegistryManifest,
} from '../symbols';
import { JsonNavigationStore } from './store';
import {
    importNavigationToSqlite,
    resolveNavigationSqlitePath,
    SQLiteNavigationStore,
    validateNavigationStoreParity,
} from './sqlite';

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

function createFunctionSymbol(input: {
    file: string;
    name: string;
    qualifiedName?: string;
    startLine: number;
    endLine: number;
    fileHash: string;
}): SymbolRecord {
    const qualifiedName = input.qualifiedName || input.name;
    const parentQualifiedNamePath: string[] = [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language: 'typescript',
        kind: 'function',
        qualifiedName,
        parentQualifiedNamePath,
    });
    const span = { startLine: input.startLine, endLine: input.endLine };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: 'extractor-v1',
        }),
        language: 'typescript',
        kind: 'function',
        name: input.name,
        qualifiedName,
        label: `function ${input.name}()`,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: 'extractor-v1',
    };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'satori-navigation-sqlite-'));
    try {
        await fn(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

test('importNavigationToSqlite mirrors JSON navigation sidecars into a parity-safe SQLite store', async () => {
    await withTempDir(async (stateRoot) => {
        const authFile = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export function login() { return true; }\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const routesFile = createSynthesizedFileSymbol({
            relativePath: 'src/routes.ts',
            language: 'typescript',
            content: 'import { login } from "./auth";\nexport function run() { return login(); }\n',
            fileHash: 'hash-routes',
            extractorVersion: 'extractor-v1',
        });
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            startLine: 1,
            endLine: 1,
            fileHash: 'hash-auth',
        });
        const run = createFunctionSymbol({
            file: 'src/routes.ts',
            name: 'run',
            startLine: 2,
            endLine: 2,
            fileHash: 'hash-routes',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
                { path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [authFile, login, routesFile, run],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: registryResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: registry.manifest.files,
            records: [
                {
                    sourceKey: routesFile.symbolKey,
                    sourceInstanceId: routesFile.symbolInstanceId,
                    targetKey: authFile.symbolKey,
                    targetInstanceId: authFile.symbolInstanceId,
                    targetPath: 'src/auth.ts',
                    type: 'IMPORTS',
                    file: 'src/routes.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: authFile.symbolKey,
                    sourceInstanceId: authFile.symbolInstanceId,
                    targetKey: login.symbolKey,
                    targetInstanceId: login.symbolInstanceId,
                    type: 'EXPORTS',
                    file: 'src/auth.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: run.symbolKey,
                    sourceInstanceId: run.symbolInstanceId,
                    targetKey: login.symbolKey,
                    targetInstanceId: login.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/routes.ts',
                    span: { startLine: 2, endLine: 2 },
                    confidence: 'low',
                },
            ],
        });

        const importResult = await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: '/repo',
        });

        assert.equal(importResult.relationshipStatus, 'ok');
        assert.equal(importResult.symbolCount, 4);
        assert.equal(importResult.relationshipCount, 3);
        assert.equal(fs.existsSync(resolveNavigationSqlitePath(stateRoot, '/repo')), true);

        const sqliteStore = new SQLiteNavigationStore();
        const manifestState = await sqliteStore.getManifest({
            stateRoot,
            normalizedRootPath: '/repo',
        });
        assert.equal(manifestState.status, 'ok');
        assert.equal(manifestState.manifestHash, registryResult.manifestHash);

        const symbolsByFile = await sqliteStore.getSymbolsByFile({
            stateRoot,
            normalizedRootPath: '/repo',
            file: 'src/routes.ts',
        });
        assert.equal(symbolsByFile.status, 'ok');
        assert.deepEqual(symbolsByFile.symbols.map((symbol) => symbol.symbolInstanceId), [
            routesFile.symbolInstanceId,
            run.symbolInstanceId,
        ]);

        const owner = await sqliteStore.findOwnerForSpan({
            stateRoot,
            normalizedRootPath: '/repo',
            file: 'src/routes.ts',
            span: { startLine: 2, endLine: 2 },
        });
        assert.equal(owner.status, 'ok');
        assert.equal(owner.owner?.symbolInstanceId, run.symbolInstanceId);

        const relationships = await sqliteStore.getRelationships({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
        });
        assert.equal(relationships.status, 'ok');
        assert.deepEqual(relationships.records.map((record) => record.type), ['EXPORTS', 'IMPORTS', 'CALLS']);

        const parity = await validateNavigationStoreParity({
            stateRoot,
            normalizedRootPath: '/repo',
            referenceStore: new JsonNavigationStore(),
            candidateStore: sqliteStore,
        });
        assert.equal(parity.ok, true);
        assert.deepEqual(parity.mismatches, []);

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, '/repo');
        {
            const database = new DatabaseSync(sqlitePath);
            database.prepare('UPDATE symbols SET name = ?, label = ? WHERE symbol_instance_id = ?')
                .run('renamedLogin', 'function renamedLogin()', login.symbolInstanceId);
            database.close();
        }
        assert.equal((await sqliteStore.getManifest({ stateRoot, normalizedRootPath: '/repo' })).status, 'incompatible');
        {
            const database = new DatabaseSync(sqlitePath);
            database.prepare('UPDATE symbols SET name = ?, label = ? WHERE symbol_instance_id = ?')
                .run(login.name, login.label, login.symbolInstanceId);
            database.prepare(`
                UPDATE relationships
                SET target_key = ?, target_instance_id = ?
                WHERE type = 'CALLS'
            `).run(authFile.symbolKey, authFile.symbolInstanceId);
            database.close();
        }
        assert.equal((await sqliteStore.getRelationships({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
        })).status, 'incompatible');
        {
            const database = new DatabaseSync(sqlitePath);
            database.prepare(`
                UPDATE relationships
                SET target_key = ?, target_instance_id = ?
                WHERE type = 'CALLS'
            `).run(login.symbolKey, login.symbolInstanceId);
            database.close();
        }
        {
            const database = new DatabaseSync(sqlitePath);
            database.prepare('UPDATE relationships SET type = ? WHERE type = ?').run('INVALID', 'CALLS');
            database.close();
        }
        const corruptRelationships = await sqliteStore.getRelationships({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
        });
        assert.equal(corruptRelationships.status, 'incompatible');

        {
            const database = new DatabaseSync(sqlitePath);
            database.prepare('UPDATE relationships SET type = ? WHERE type = ?').run('CALLS', 'INVALID');
            database.prepare('UPDATE symbols SET kind = ?, file_path = ?, start_line = ? WHERE symbol_instance_id = ?')
                .run('invalid', '../escape.ts', -4, login.symbolInstanceId);
            database.close();
        }
        const corruptSymbols = await sqliteStore.getManifest({
            stateRoot,
            normalizedRootPath: '/repo',
        });
        assert.equal(corruptSymbols.status, 'incompatible');

        {
            const database = new DatabaseSync(sqlitePath);
            database.prepare('DELETE FROM symbols').run();
            database.close();
        }
        const truncatedSymbols = await sqliteStore.getManifest({
            stateRoot,
            normalizedRootPath: '/repo',
        });
        assert.equal(truncatedSymbols.status, 'incompatible');
    });
});

test('importNavigationToSqlite preserves incompatible relationship state from JSON sidecars', async () => {
    await withTempDir(async (stateRoot) => {
        const originalRegistry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [
                createSynthesizedFileSymbol({
                    relativePath: 'src/auth.ts',
                    language: 'typescript',
                    content: 'export const auth = true;\n',
                    fileHash: 'hash-auth',
                    extractorVersion: 'extractor-v1',
                }),
            ],
        });
        const originalResult = await writeSymbolRegistrySidecar({ stateRoot, registry: originalRegistry });
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: originalResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: originalRegistry.manifest.files,
            records: [],
        });

        const nextRegistry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth-next', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [
                createSynthesizedFileSymbol({
                    relativePath: 'src/auth.ts',
                    language: 'typescript',
                    content: 'export const auth = false;\n',
                    fileHash: 'hash-auth-next',
                    extractorVersion: 'extractor-v1',
                }),
            ],
        });
        await writeSymbolRegistrySidecar({ stateRoot, registry: nextRegistry });

        const importResult = await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: '/repo',
        });

        assert.equal(importResult.relationshipStatus, 'incompatible');

        const sqliteStore = new SQLiteNavigationStore();
        const relationships = await sqliteStore.getRelationships({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: importResult.registryManifestHash,
        });
        assert.equal(relationships.status, 'incompatible');
    });
});

test('validateNavigationStoreParity reports deterministic mismatches when SQLite diverges from JSON', async () => {
    await withTempDir(async (stateRoot) => {
        const fileOwner = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export function login() { return true; }\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            startLine: 1,
            endLine: 1,
            fileHash: 'hash-auth',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [fileOwner, login],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: registryResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: registry.manifest.files,
            records: [
                {
                    sourceKey: fileOwner.symbolKey,
                    sourceInstanceId: fileOwner.symbolInstanceId,
                    targetKey: login.symbolKey,
                    targetInstanceId: login.symbolInstanceId,
                    type: 'EXPORTS',
                    file: 'src/auth.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
            ],
        });
        await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: '/repo',
        });

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, '/repo');
        const database = new DatabaseSync(sqlitePath);
        try {
            database.exec('DELETE FROM relationships');
        } finally {
            database.close();
        }

        const parity = await validateNavigationStoreParity({
            stateRoot,
            normalizedRootPath: '/repo',
            referenceStore: new JsonNavigationStore(),
            candidateStore: new SQLiteNavigationStore(),
        });

        assert.equal(parity.ok, false);
        assert.ok(parity.mismatches.includes('relationship_status:ok:incompatible'));
    });
});

test('validateNavigationStoreParity reports a missing SQLite symbol row as a deterministic mismatch instead of throwing', async () => {
    await withTempDir(async (stateRoot) => {
        const fileOwner = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export function login() { return true; }\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            startLine: 1,
            endLine: 1,
            fileHash: 'hash-auth',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [fileOwner, login],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: registryResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: registry.manifest.files,
            records: [],
        });
        await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: '/repo',
        });

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, '/repo');
        const database = new DatabaseSync(sqlitePath);
        try {
            database.prepare('DELETE FROM symbols WHERE symbol_instance_id = ?').run(login.symbolInstanceId);
        } finally {
            database.close();
        }

        const parity = await validateNavigationStoreParity({
            stateRoot,
            normalizedRootPath: '/repo',
            referenceStore: new JsonNavigationStore(),
            candidateStore: new SQLiteNavigationStore(),
        });

        assert.equal(parity.ok, false);
        assert.ok(parity.mismatches.includes('registry_status:ok:incompatible'));
    });
});
