import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { JsonNavigationStore } from './store';

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
    qualifiedName: string;
    startLine: number;
    endLine: number;
    fileHash: string;
}): SymbolRecord {
    const parentQualifiedNamePath: string[] = [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language: 'typescript',
        kind: 'function',
        qualifiedName: input.qualifiedName,
        parentQualifiedNamePath,
    });
    const span = {
        startLine: input.startLine,
        endLine: input.endLine,
    };
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
        qualifiedName: input.qualifiedName,
        label: `function ${input.name}()`,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: 'extractor-v1',
    };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'satori-navigation-store-'));
    try {
        await fn(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

test('JsonNavigationStore reads registry-backed symbols and span ownership', async () => {
    await withTempDir(async (stateRoot) => {
        const fileOwner = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: [
                'export function login() {',
                '  return true;',
                '}',
                '',
            ].join('\n'),
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            qualifiedName: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-auth',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [fileOwner, login],
        });
        await writeSymbolRegistrySidecar({ stateRoot, registry });

        const store = new JsonNavigationStore();
        const manifestState = await store.getManifest({
            normalizedRootPath: '/repo',
            stateRoot,
        });
        assert.equal(manifestState.status, 'ok');
        assert.equal(manifestState.manifestHash, manifestState.registryManifestHash);
        assert.equal(manifestState.registry.symbolsByFile.get('src/auth.ts')?.length, 2);

        const byFile = await store.getSymbolsByFile({
            normalizedRootPath: '/repo',
            stateRoot,
            file: 'src/auth.ts',
        });
        assert.equal(byFile.status, 'ok');
        assert.deepEqual(byFile.symbols.map((symbol) => symbol.symbolInstanceId), [
            fileOwner.symbolInstanceId,
            login.symbolInstanceId,
        ]);

        const byInstance = await store.getSymbolByInstanceId({
            normalizedRootPath: '/repo',
            stateRoot,
            symbolInstanceId: login.symbolInstanceId,
        });
        assert.equal(byInstance.status, 'ok');
        assert.equal(byInstance.symbol?.label, 'function login()');

        const byKey = await store.getSymbolCandidatesByKey({
            normalizedRootPath: '/repo',
            stateRoot,
            symbolKey: login.symbolKey,
        });
        assert.equal(byKey.status, 'ok');
        assert.equal(byKey.symbols.length, 1);
        assert.equal(byKey.symbols[0]?.symbolInstanceId, login.symbolInstanceId);

        const owner = await store.findOwnerForSpan({
            normalizedRootPath: '/repo',
            stateRoot,
            file: 'src/auth.ts',
            span: { startLine: 1, endLine: 2 },
        });
        assert.equal(owner.status, 'ok');
        assert.equal(owner.owner?.symbolInstanceId, login.symbolInstanceId);
    });
});

test('JsonNavigationStore validates compatible relationships against the active registry manifest', async () => {
    await withTempDir(async (stateRoot) => {
        const authOwner = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: 'export function login() { return true; }\n',
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const routesOwner = createSynthesizedFileSymbol({
            relativePath: 'src/routes.ts',
            language: 'typescript',
            content: 'import { login } from \"./auth\";\nlogin();\n',
            fileHash: 'hash-routes',
            extractorVersion: 'extractor-v1',
        });
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            qualifiedName: 'login',
            startLine: 1,
            endLine: 1,
            fileHash: 'hash-auth',
        });
        const run = createFunctionSymbol({
            file: 'src/routes.ts',
            name: 'run',
            qualifiedName: 'run',
            startLine: 1,
            endLine: 2,
            fileHash: 'hash-routes',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
                { path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [authOwner, routesOwner, login, run],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        const records: RelationshipRecord[] = [
            {
                sourceKey: run.symbolKey,
                sourceInstanceId: run.symbolInstanceId,
                targetKey: login.symbolKey,
                targetInstanceId: login.symbolInstanceId,
                type: 'CALLS',
                file: 'src/routes.ts',
                span: { startLine: 2, endLine: 2 },
                confidence: 'high',
            },
            {
                sourceKey: routesOwner.symbolKey,
                sourceInstanceId: routesOwner.symbolInstanceId,
                targetKey: authOwner.symbolKey,
                targetInstanceId: authOwner.symbolInstanceId,
                targetPath: 'src/auth.ts',
                type: 'IMPORTS',
                file: 'src/routes.ts',
                span: { startLine: 1, endLine: 1 },
                confidence: 'medium',
            },
        ];
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: registryResult.manifestHash,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: registry.manifest.files,
            records,
        });

        const store = new JsonNavigationStore();
        const relationships = await store.getRelationships({
            normalizedRootPath: '/repo',
            stateRoot,
            direction: 'callees',
            sourceInstanceId: run.symbolInstanceId,
            types: ['CALLS'],
        });
        assert.equal(relationships.status, 'ok');
        assert.deepEqual(relationships.records.map((record) => record.type), ['CALLS']);
        assert.equal(relationships.records[0]?.targetInstanceId, login.symbolInstanceId);

        const compatibility = await store.getCompatibilityState({
            normalizedRootPath: '/repo',
            stateRoot,
        });
        assert.equal(compatibility.registry.status, 'ok');
        assert.equal(compatibility.relationships.status, 'ok');
        assert.equal(
            compatibility.relationships.manifest?.symbolRegistryManifestHash,
            registryResult.manifestHash
        );

        const nextRegistry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth-next', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [
                createSynthesizedFileSymbol({
                    relativePath: 'src/auth.ts',
                    language: 'typescript',
                    content: 'export const changed = true;\n',
                    fileHash: 'hash-auth-next',
                    extractorVersion: 'extractor-v1',
                }),
            ],
        });
        await writeSymbolRegistrySidecar({ stateRoot, registry: nextRegistry });

        const incompatible = await store.getRelationships({
            normalizedRootPath: '/repo',
            stateRoot,
            direction: 'callees',
            sourceInstanceId: run.symbolInstanceId,
            types: ['CALLS'],
        });
        assert.equal(incompatible.status, 'incompatible');

        const compatibilityAfterChange = await store.getCompatibilityState({
            normalizedRootPath: '/repo',
            stateRoot,
        });
        assert.equal(compatibilityAfterChange.registry.status, 'ok');
        assert.equal(compatibilityAfterChange.relationships.status, 'incompatible');
    });
});
