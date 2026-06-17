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
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistryManifest,
} from '../symbols';
import { importNavigationToSqlite, resolveNavigationSqlitePath } from './sqlite';
import { JsonNavigationStore } from './store';
import type { NavigationStore } from './store';
import {
    RuntimeNavigationStore,
    createRuntimeNavigationStore,
    resetSharedRuntimeNavigationStoreForTests,
} from './runtime';

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
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'satori-navigation-runtime-'));
    try {
        await fn(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

async function withNavigationEnv(
    env: Partial<Record<'SATORI_NAVIGATION_BACKEND' | 'SATORI_NAVIGATION_DUAL_READ', string | undefined>>,
    fn: () => Promise<void>,
): Promise<void> {
    const previousBackend = process.env.SATORI_NAVIGATION_BACKEND;
    const previousDualRead = process.env.SATORI_NAVIGATION_DUAL_READ;
    resetSharedRuntimeNavigationStoreForTests();
    if (env.SATORI_NAVIGATION_BACKEND === undefined) {
        delete process.env.SATORI_NAVIGATION_BACKEND;
    } else {
        process.env.SATORI_NAVIGATION_BACKEND = env.SATORI_NAVIGATION_BACKEND;
    }
    if (env.SATORI_NAVIGATION_DUAL_READ === undefined) {
        delete process.env.SATORI_NAVIGATION_DUAL_READ;
    } else {
        process.env.SATORI_NAVIGATION_DUAL_READ = env.SATORI_NAVIGATION_DUAL_READ;
    }
    try {
        await fn();
    } finally {
        resetSharedRuntimeNavigationStoreForTests();
        if (previousBackend === undefined) {
            delete process.env.SATORI_NAVIGATION_BACKEND;
        } else {
            process.env.SATORI_NAVIGATION_BACKEND = previousBackend;
        }
        if (previousDualRead === undefined) {
            delete process.env.SATORI_NAVIGATION_DUAL_READ;
        } else {
            process.env.SATORI_NAVIGATION_DUAL_READ = previousDualRead;
        }
    }
}

async function writeTestNavigation(stateRoot: string): Promise<{
    fileOwner: SymbolRecord;
    login: SymbolRecord;
    registryManifestHash: string;
}> {
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
    const records: RelationshipRecord[] = [{
        sourceKey: fileOwner.symbolKey,
        sourceInstanceId: fileOwner.symbolInstanceId,
        targetKey: login.symbolKey,
        targetInstanceId: login.symbolInstanceId,
        type: 'EXPORTS',
        file: 'src/auth.ts',
        span: { startLine: 1, endLine: 1 },
        confidence: 'high',
    }];
    await writeRelationshipSidecar({
        stateRoot,
        normalizedRootPath: '/repo',
        symbolRegistryManifestHash: registryResult.manifestHash,
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files: registry.manifest.files,
        records,
    });
    return {
        fileOwner,
        login,
        registryManifestHash: registryResult.manifestHash,
    };
}

test('RuntimeNavigationStore serves JSON sidecars by default when SQLite cache is missing', async () => {
    await withTempDir(async (stateRoot) => {
        const { login, registryManifestHash } = await writeTestNavigation(stateRoot);
        const store = new RuntimeNavigationStore();

        const symbolsByFile = await store.getSymbolsByFile({
            stateRoot,
            normalizedRootPath: '/repo',
            file: 'src/auth.ts',
        });
        assert.equal(symbolsByFile.status, 'ok');
        assert.equal(symbolsByFile.symbols.some((symbol) => symbol.symbolInstanceId === login.symbolInstanceId), true);

        const relationships = await store.getRelationships({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryManifestHash,
        });
        assert.equal(relationships.status, 'ok');
        assert.equal(relationships.records.length, 1);
    });
});

test('RuntimeNavigationStore keeps JSON as the serving backend even when SQLite cache exists', async () => {
    await withTempDir(async (stateRoot) => {
        const { login } = await writeTestNavigation(stateRoot);
        await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: '/repo',
        });

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, '/repo');
        const rootPath = path.dirname(sqlitePath);
        await fs.promises.rm(path.join(rootPath, 'manifest.json'), { force: true });
        await fs.promises.rm(path.join(rootPath, 'symbols'), { recursive: true, force: true });
        await fs.promises.rm(path.join(rootPath, 'relationships'), { recursive: true, force: true });

        const store = new RuntimeNavigationStore();
        const byInstance = await store.getSymbolByInstanceId({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolInstanceId: login.symbolInstanceId,
        });
        assert.equal(byInstance.status, 'missing');
    });
});

test('RuntimeNavigationStore serves SQLite when explicit sqlite backend is selected', async () => {
    await withTempDir(async (stateRoot) => {
        const { login } = await writeTestNavigation(stateRoot);
        await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: '/repo',
        });

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, '/repo');
        const rootPath = path.dirname(sqlitePath);
        await fs.promises.rm(path.join(rootPath, 'manifest.json'), { force: true });
        await fs.promises.rm(path.join(rootPath, 'symbols'), { recursive: true, force: true });
        await fs.promises.rm(path.join(rootPath, 'relationships'), { recursive: true, force: true });

        const store = new RuntimeNavigationStore({
            servingBackend: 'sqlite',
        });
        const byInstance = await store.getSymbolByInstanceId({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolInstanceId: login.symbolInstanceId,
        });
        assert.equal(byInstance.status, 'ok');
        assert.equal(byInstance.symbol?.symbolInstanceId, login.symbolInstanceId);
    });
});

test('RuntimeNavigationStore falls back to JSON and warns when explicit sqlite backend is missing', async () => {
    await withTempDir(async (stateRoot) => {
        const { login } = await writeTestNavigation(stateRoot);
        const warnings: string[] = [];
        const store = new RuntimeNavigationStore({
            servingBackend: 'sqlite',
            logger: {
                warn: (message: string) => {
                    warnings.push(message);
                },
            },
        });

        const byInstance = await store.getSymbolByInstanceId({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolInstanceId: login.symbolInstanceId,
        });
        assert.equal(byInstance.status, 'ok');
        assert.equal(byInstance.symbol?.symbolInstanceId, login.symbolInstanceId);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] || '', /SQLite backend fallback to JSON/);
        assert.match(warnings[0] || '', /navigation sqlite database is missing/);
    });
});

test('RuntimeNavigationStore falls back to JSON and warns when explicit sqlite backend throws', async () => {
    await withTempDir(async (stateRoot) => {
        const { login, registryManifestHash } = await writeTestNavigation(stateRoot);
        const warnings: string[] = [];
        const throwingSqliteStore: NavigationStore = {
            async getManifest() {
                throw new Error('synthetic sqlite failure');
            },
            async getSymbolsByFile() {
                throw new Error('synthetic sqlite failure');
            },
            async getSymbolByInstanceId() {
                throw new Error('synthetic sqlite failure');
            },
            async getSymbolCandidatesByKey() {
                throw new Error('synthetic sqlite failure');
            },
            async findOwnerForSpan() {
                throw new Error('synthetic sqlite failure');
            },
            async getRelationships() {
                throw new Error('synthetic sqlite failure');
            },
            async getCompatibilityState() {
                throw new Error('synthetic sqlite failure');
            },
        };
        const store = new RuntimeNavigationStore({
            servingBackend: 'sqlite',
            servingStore: new JsonNavigationStore(),
            candidateStore: throwingSqliteStore,
            logger: {
                warn: (message: string) => {
                    warnings.push(message);
                },
            },
        });

        const byInstance = await store.getSymbolByInstanceId({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolInstanceId: login.symbolInstanceId,
        });
        assert.equal(byInstance.status, 'ok');
        assert.equal(byInstance.symbol?.symbolInstanceId, login.symbolInstanceId);

        const relationships = await store.getRelationships({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryManifestHash,
        });
        assert.equal(relationships.status, 'ok');
        assert.equal(relationships.records.length, 1);

        assert.equal(warnings.length, 1);
        assert.match(warnings[0] || '', /SQLite backend fallback to JSON/);
        assert.match(warnings[0] || '', /synthetic sqlite failure/);
    });
});

test('RuntimeNavigationStore does not wait for dual-read parity before returning JSON results', async () => {
    await withTempDir(async (stateRoot) => {
        await writeTestNavigation(stateRoot);
        const store = new RuntimeNavigationStore({
            dualReadValidation: 'warn',
            logger: { warn: () => undefined },
            parityValidator: async (_input) => {
                await new Promise((resolve) => setTimeout(resolve, 200));
                return { ok: true, mismatches: [] };
            },
        });

        const startedAt = Date.now();
        const manifestState = await store.getManifest({
            stateRoot,
            normalizedRootPath: '/repo',
        });
        const elapsedMs = Date.now() - startedAt;

        assert.equal(manifestState.status, 'ok');
        assert.ok(elapsedMs < 150, `expected JSON serve to return before parity validation finishes, got ${elapsedMs}ms`);
    });
});

test('RuntimeNavigationStore warns once when dual-read parity detects a SQLite mismatch', async () => {
    await withTempDir(async (stateRoot) => {
        await writeTestNavigation(stateRoot);
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

        const warnings: string[] = [];
        const store = new RuntimeNavigationStore({
            dualReadValidation: 'warn',
            logger: {
                warn: (message: string) => {
                    warnings.push(message);
                },
            },
        });

        const manifestState = await store.getManifest({
            stateRoot,
            normalizedRootPath: '/repo',
        });
        assert.equal(manifestState.status, 'ok');

        const symbolsByFile = await store.getSymbolsByFile({
            stateRoot,
            normalizedRootPath: '/repo',
            file: 'src/auth.ts',
        });
        assert.equal(symbolsByFile.status, 'ok');

        for (let attempt = 0; attempt < 50 && warnings.length === 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] || '', /SQLite\/JSON parity mismatch/);
        assert.match(warnings[0] || '', /relationship_records/);
    });
});

test('RuntimeNavigationStore reruns dual-read parity validation after the previous check settles', async () => {
    await withTempDir(async (stateRoot) => {
        await writeTestNavigation(stateRoot);
        let parityChecks = 0;
        const store = new RuntimeNavigationStore({
            dualReadValidation: 'warn',
            logger: { warn: () => undefined },
            parityValidator: async () => {
                parityChecks += 1;
                return { ok: true, mismatches: [] };
            },
        });

        await store.getManifest({
            stateRoot,
            normalizedRootPath: '/repo',
        });
        for (let attempt = 0; attempt < 50 && parityChecks < 1; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(parityChecks, 1);

        await store.getManifest({
            stateRoot,
            normalizedRootPath: '/repo',
        });
        for (let attempt = 0; attempt < 50 && parityChecks < 2; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(parityChecks, 2);
    });
});

test('createRuntimeNavigationStore honors SATORI_NAVIGATION_DUAL_READ for the shared default JSON-serving store', async () => {
    await withTempDir(async (stateRoot) => {
        await writeTestNavigation(stateRoot);
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

        const warnings: string[] = [];
        const previousWarn = console.warn;
        console.warn = (message?: unknown, ...args: unknown[]) => {
            warnings.push([message, ...args].map((entry) => String(entry)).join(' '));
        };

        try {
            await withNavigationEnv({
                SATORI_NAVIGATION_DUAL_READ: '1',
            }, async () => {
                const store = createRuntimeNavigationStore();
                const manifestState = await store.getManifest({
                    stateRoot,
                    normalizedRootPath: '/repo',
                });
                assert.equal(manifestState.status, 'ok');

                for (let attempt = 0; attempt < 50 && warnings.length === 0; attempt += 1) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert.equal(warnings.length, 1);
                assert.match(warnings[0] || '', /SQLite\/JSON parity mismatch/);
                assert.match(warnings[0] || '', /relationship_records/);
            });
        } finally {
            console.warn = previousWarn;
        }
    });
});

test('createRuntimeNavigationStore honors SATORI_NAVIGATION_BACKEND=sqlite for the shared default runtime store', async () => {
    await withTempDir(async (stateRoot) => {
        const { login } = await writeTestNavigation(stateRoot);
        await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: '/repo',
        });

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, '/repo');
        const rootPath = path.dirname(sqlitePath);
        await fs.promises.rm(path.join(rootPath, 'manifest.json'), { force: true });
        await fs.promises.rm(path.join(rootPath, 'symbols'), { recursive: true, force: true });
        await fs.promises.rm(path.join(rootPath, 'relationships'), { recursive: true, force: true });

        await withNavigationEnv({
            SATORI_NAVIGATION_BACKEND: 'sqlite',
        }, async () => {
            const store = createRuntimeNavigationStore();
            const byInstance = await store.getSymbolByInstanceId({
                stateRoot,
                normalizedRootPath: '/repo',
                symbolInstanceId: login.symbolInstanceId,
            });
            assert.equal(byInstance.status, 'ok');
            assert.equal(byInstance.symbol?.symbolInstanceId, login.symbolInstanceId);
        });
    });
});

test('createRuntimeNavigationStore reuses a shared default instance', () => {
    resetSharedRuntimeNavigationStoreForTests();
    const first = createRuntimeNavigationStore();
    const second = createRuntimeNavigationStore();

    assert.equal(first, second);
    resetSharedRuntimeNavigationStoreForTests();
});
