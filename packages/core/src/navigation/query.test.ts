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
import type { RelationshipRecord, SymbolRecord, SymbolRegistryManifest } from '../symbols';
import { getGraphNeighbors, getRelationshipsForSymbol } from './query';
import type {
    NavigationCompatibilityState,
    NavigationRegistryState,
    NavigationRelationshipsState,
    NavigationStore,
} from './store';

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
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'satori-navigation-query-'));
    try {
        await fn(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

function createFunctionSymbol(input: {
    file: string;
    name: string;
    qualifiedName?: string;
    label?: string;
    startLine: number;
    endLine: number;
    fileHash: string;
}): SymbolRecord {
    const qualifiedName = input.qualifiedName || input.name;
    const label = input.label || `function ${input.name}()`;
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
        label,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: 'extractor-v1',
    };
}

test('getRelationshipsForSymbol returns deterministic caller and callee records from relationship sidecars', async () => {
    await withTempDir(async (stateRoot) => {
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            startLine: 4,
            endLine: 8,
            fileHash: 'hash-auth',
        });
        const normalize = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'normalize',
            startLine: 10,
            endLine: 14,
            fileHash: 'hash-auth',
        });
        const issue = createFunctionSymbol({
            file: 'src/session.ts',
            name: 'issue',
            startLine: 3,
            endLine: 7,
            fileHash: 'hash-session',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
                { path: 'src/session.ts', hash: 'hash-session', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [login, normalize, issue],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        const records: RelationshipRecord[] = [
            {
                sourceKey: login.symbolKey,
                sourceInstanceId: login.symbolInstanceId,
                targetKey: normalize.symbolKey,
                targetInstanceId: normalize.symbolInstanceId,
                type: 'CALLS',
                file: 'src/auth.ts',
                span: { startLine: 6, endLine: 6 },
                confidence: 'high',
            },
            {
                sourceKey: login.symbolKey,
                sourceInstanceId: login.symbolInstanceId,
                targetKey: issue.symbolKey,
                targetInstanceId: issue.symbolInstanceId,
                type: 'CALLS',
                file: 'src/auth.ts',
                span: { startLine: 7, endLine: 7 },
                confidence: 'low',
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

        const callees = await getRelationshipsForSymbol({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            sourceInstanceId: login.symbolInstanceId,
            direction: 'callees',
            types: ['CALLS'],
        });
        assert.equal(callees.status, 'ok');
        assert.deepEqual(callees.records.map((record) => record.targetInstanceId), [
            normalize.symbolInstanceId,
            issue.symbolInstanceId,
        ]);

        const callers = await getRelationshipsForSymbol({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            targetInstanceId: normalize.symbolInstanceId,
            direction: 'callers',
            types: ['CALLS'],
        });
        assert.equal(callers.status, 'ok');
        assert.deepEqual(callers.records.map((record) => record.sourceInstanceId), [login.symbolInstanceId]);
    });
});

test('getGraphNeighbors excludes low-confidence relationships by default and reports deterministic warnings', async () => {
    await withTempDir(async (stateRoot) => {
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            startLine: 4,
            endLine: 8,
            fileHash: 'hash-auth',
        });
        const normalize = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'normalize',
            startLine: 10,
            endLine: 14,
            fileHash: 'hash-auth',
        });
        const issue = createFunctionSymbol({
            file: 'src/session.ts',
            name: 'issue',
            startLine: 3,
            endLine: 7,
            fileHash: 'hash-session',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
                { path: 'src/session.ts', hash: 'hash-session', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [login, normalize, issue],
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
                    sourceKey: login.symbolKey,
                    sourceInstanceId: login.symbolInstanceId,
                    targetKey: normalize.symbolKey,
                    targetInstanceId: normalize.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/auth.ts',
                    span: { startLine: 6, endLine: 6 },
                    confidence: 'high',
                },
                {
                    sourceKey: login.symbolKey,
                    sourceInstanceId: login.symbolInstanceId,
                    targetKey: issue.symbolKey,
                    targetInstanceId: issue.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/auth.ts',
                    span: { startLine: 7, endLine: 7 },
                    confidence: 'low',
                },
            ],
        });

        const neighbors = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: login.symbolInstanceId,
            depth: 2,
            direction: 'callees',
            allowedTypes: ['CALLS'],
        });

        assert.equal(neighbors.status, 'ok');
        assert.deepEqual(neighbors.visitedSymbolInstanceIds, [
            login.symbolInstanceId,
            normalize.symbolInstanceId,
        ]);
        assert.deepEqual(neighbors.records.map((record) => record.targetInstanceId), [normalize.symbolInstanceId]);
        assert.deepEqual(neighbors.warnings, ['RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1']);
    });
});

test('getGraphNeighbors upgrades import/export-backed cross-file CALLS v0 edges for traversal', async () => {
    await withTempDir(async (stateRoot) => {
        const authContent = [
            'export function login(token: string) {',
            '  return token;',
            '}',
        ].join('\n');
        const routesContent = [
            'import { login } from "./auth";',
            'export function route(token: string) {',
            '  return login(token);',
            '}',
        ].join('\n');
        const authFile = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: authContent,
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const routesFile = createSynthesizedFileSymbol({
            relativePath: 'src/routes.ts',
            language: 'typescript',
            content: routesContent,
            fileHash: 'hash-routes',
            extractorVersion: 'extractor-v1',
        });
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-auth',
        });
        const route = createFunctionSymbol({
            file: 'src/routes.ts',
            name: 'route',
            startLine: 2,
            endLine: 4,
            fileHash: 'hash-routes',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 },
                { path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [authFile, login, routesFile, route],
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
                    targetPath: authFile.file,
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
                    sourceKey: route.symbolKey,
                    sourceInstanceId: route.symbolInstanceId,
                    targetKey: login.symbolKey,
                    targetInstanceId: login.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/routes.ts',
                    span: { startLine: 3, endLine: 3 },
                    confidence: 'low',
                },
            ],
        });

        const neighbors = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: route.symbolInstanceId,
            depth: 2,
            direction: 'callees',
            allowedTypes: ['CALLS'],
        });

        assert.equal(neighbors.status, 'ok');
        assert.deepEqual(neighbors.visitedSymbolInstanceIds, [
            route.symbolInstanceId,
            login.symbolInstanceId,
        ]);
        assert.deepEqual(neighbors.records.map((record) => ({
            targetInstanceId: record.targetInstanceId,
            confidence: record.confidence,
        })), [{
            targetInstanceId: login.symbolInstanceId,
            confidence: 'medium',
        }]);
        assert.deepEqual(neighbors.warnings, []);
    });
});

test('relationship query helpers honor an injected navigation store', async () => {
    const records: RelationshipRecord[] = [
        {
            sourceKey: 'symbol-key:route',
            sourceInstanceId: 'symbol-instance:route',
            targetKey: 'symbol-key:login',
            targetInstanceId: 'symbol-instance:login',
            type: 'CALLS',
            file: 'src/routes.ts',
            span: { startLine: 3, endLine: 3 },
            confidence: 'high',
        },
    ];
    let getRelationshipsCalls = 0;
    const store: NavigationStore = {
        async getManifest(): Promise<NavigationRegistryState> {
            throw new Error('getManifest should not be called by this helper');
        },
        async getSymbolsByFile() {
            throw new Error('getSymbolsByFile should not be called by this helper');
        },
        async getSymbolByInstanceId() {
            throw new Error('getSymbolByInstanceId should not be called by this helper');
        },
        async getSymbolCandidatesByKey() {
            throw new Error('getSymbolCandidatesByKey should not be called by this helper');
        },
        async findOwnerForSpan() {
            throw new Error('findOwnerForSpan should not be called by this helper');
        },
        async getRelationships(): Promise<NavigationRelationshipsState> {
            getRelationshipsCalls += 1;
            return {
                status: 'ok',
                rootPath: '/virtual/navigation',
                manifest: {
                    schemaVersion: 'relationship_v1',
                    symbolRegistryManifestHash: 'manifest-hash',
                    relationshipVersion: 'relationship-v1',
                    builtAt: '2026-06-17T00:00:00.000Z',
                },
                records,
                warnings: [],
            };
        },
        async getCompatibilityState(): Promise<NavigationCompatibilityState> {
            throw new Error('getCompatibilityState should not be called by this helper');
        },
    };

    const result = await getRelationshipsForSymbol({
        normalizedRootPath: '/repo',
        expectedSymbolRegistryManifestHash: 'manifest-hash',
        navigationStore: store,
        sourceInstanceId: 'symbol-instance:route',
        direction: 'callees',
        types: ['CALLS'],
    });

    assert.equal(getRelationshipsCalls, 1);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.records.map((record) => record.targetInstanceId), ['symbol-instance:login']);
});
