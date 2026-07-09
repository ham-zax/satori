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
    language?: string;
}): SymbolRecord {
    const qualifiedName = input.qualifiedName || input.name;
    const label = input.label || `function ${input.name}()`;
    const language = input.language || 'typescript';
    const parentQualifiedNamePath: string[] = [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language,
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
        language,
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
        assert.deepEqual(neighbors.suppressedLowConfidenceRecords.map((record) => record.targetInstanceId), [issue.symbolInstanceId]);
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

test('getGraphNeighbors upgrades import-backed unique method CALLS without EXPORTS of the method', async () => {
    await withTempDir(async (stateRoot) => {
        const gateContent = [
            'export class Gate {',
            '  checkMutation() {',
            '    return true;',
            '  }',
            '}',
        ].join('\n');
        const handlersContent = [
            'import { Gate } from "./gate";',
            'export class Handlers {',
            '  private gate = new Gate();',
            '  run() {',
            '    return this.gate.checkMutation();',
            '  }',
            '}',
        ].join('\n');
        const gateFile = createSynthesizedFileSymbol({
            relativePath: 'src/gate.ts',
            language: 'typescript',
            content: gateContent,
            fileHash: 'hash-gate',
            extractorVersion: 'extractor-v1',
        });
        const handlersFile = createSynthesizedFileSymbol({
            relativePath: 'src/handlers.ts',
            language: 'typescript',
            content: handlersContent,
            fileHash: 'hash-handlers',
            extractorVersion: 'extractor-v1',
        });
        const checkMutation = createFunctionSymbol({
            file: 'src/gate.ts',
            name: 'checkMutation',
            qualifiedName: 'Gate.checkMutation',
            label: 'method checkMutation()',
            startLine: 2,
            endLine: 4,
            fileHash: 'hash-gate',
        });
        const run = createFunctionSymbol({
            file: 'src/handlers.ts',
            name: 'run',
            qualifiedName: 'Handlers.run',
            label: 'method run()',
            startLine: 4,
            endLine: 6,
            fileHash: 'hash-handlers',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/gate.ts', hash: 'hash-gate', language: 'typescript', symbolCount: 2 },
                { path: 'src/handlers.ts', hash: 'hash-handlers', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [gateFile, checkMutation, handlersFile, run],
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
                    sourceKey: handlersFile.symbolKey,
                    sourceInstanceId: handlersFile.symbolInstanceId,
                    targetKey: gateFile.symbolKey,
                    targetInstanceId: gateFile.symbolInstanceId,
                    targetPath: gateFile.file,
                    type: 'IMPORTS',
                    file: 'src/handlers.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                // Intentionally no EXPORTS of checkMutation — class method case.
                {
                    sourceKey: run.symbolKey,
                    sourceInstanceId: run.symbolInstanceId,
                    targetKey: checkMutation.symbolKey,
                    targetInstanceId: checkMutation.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/handlers.ts',
                    span: { startLine: 5, endLine: 5 },
                    confidence: 'low',
                },
            ],
        });

        const callers = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: checkMutation.symbolInstanceId,
            depth: 1,
            direction: 'callers',
            allowedTypes: ['CALLS'],
        });

        assert.equal(callers.status, 'ok');
        assert.deepEqual(callers.records.map((record) => ({
            sourceInstanceId: record.sourceInstanceId,
            confidence: record.confidence,
        })), [{
            sourceInstanceId: run.symbolInstanceId,
            confidence: 'medium',
        }]);
        assert.deepEqual(callers.suppressedLowConfidenceRecords, []);
    });
});

test('getGraphNeighbors does not upgrade import-unique CALLS for generic names without EXPORTS', async () => {
    await withTempDir(async (stateRoot) => {
        const stackContent = 'export function push(x: number) { return x; }\n';
        const appContent = 'import { push } from "./stack";\nexport function main() { return push(1); }\n';
        const stackFile = createSynthesizedFileSymbol({
            relativePath: 'src/stack.ts',
            language: 'typescript',
            content: stackContent,
            fileHash: 'hash-stack',
            extractorVersion: 'extractor-v1',
        });
        const appFile = createSynthesizedFileSymbol({
            relativePath: 'src/app.ts',
            language: 'typescript',
            content: appContent,
            fileHash: 'hash-app',
            extractorVersion: 'extractor-v1',
        });
        const push = createFunctionSymbol({
            file: 'src/stack.ts',
            name: 'push',
            startLine: 1,
            endLine: 1,
            fileHash: 'hash-stack',
        });
        const main = createFunctionSymbol({
            file: 'src/app.ts',
            name: 'main',
            startLine: 2,
            endLine: 2,
            fileHash: 'hash-app',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/stack.ts', hash: 'hash-stack', language: 'typescript', symbolCount: 2 },
                { path: 'src/app.ts', hash: 'hash-app', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [stackFile, push, appFile, main],
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
                    sourceKey: appFile.symbolKey,
                    sourceInstanceId: appFile.symbolInstanceId,
                    targetKey: stackFile.symbolKey,
                    targetInstanceId: stackFile.symbolInstanceId,
                    targetPath: stackFile.file,
                    type: 'IMPORTS',
                    file: 'src/app.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: main.symbolKey,
                    sourceInstanceId: main.symbolInstanceId,
                    targetKey: push.symbolKey,
                    targetInstanceId: push.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/app.ts',
                    span: { startLine: 2, endLine: 2 },
                    confidence: 'low',
                },
            ],
        });

        const neighbors = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: push.symbolInstanceId,
            depth: 1,
            direction: 'callers',
            allowedTypes: ['CALLS'],
        });

        assert.equal(neighbors.status, 'ok');
        assert.deepEqual(neighbors.records, []);
        assert.deepEqual(neighbors.suppressedLowConfidenceRecords.map((r) => r.targetInstanceId), [push.symbolInstanceId]);
    });
});

test('getGraphNeighbors does not return raw medium CALLS by default (only supported low→medium upgrades)', async () => {
    await withTempDir(async (stateRoot) => {
        const a = createFunctionSymbol({
            file: 'src/a.ts',
            name: 'a',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-a',
        });
        const b = createFunctionSymbol({
            file: 'src/b.ts',
            name: 'b',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-b',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/a.ts', hash: 'hash-a', language: 'typescript', symbolCount: 1 },
                { path: 'src/b.ts', hash: 'hash-b', language: 'typescript', symbolCount: 1 },
            ]),
            symbols: [a, b],
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
                    sourceKey: a.symbolKey,
                    sourceInstanceId: a.symbolInstanceId,
                    targetKey: b.symbolKey,
                    targetInstanceId: b.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/a.ts',
                    span: { startLine: 2, endLine: 2 },
                    confidence: 'medium',
                },
            ],
        });

        const neighbors = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: a.symbolInstanceId,
            depth: 1,
            direction: 'callees',
            allowedTypes: ['CALLS'],
        });

        assert.equal(neighbors.status, 'ok');
        assert.deepEqual(neighbors.records, []);
        assert.deepEqual(neighbors.suppressedLowConfidenceRecords.map((r) => r.targetInstanceId), [b.symbolInstanceId]);
    });
});

test('getGraphNeighbors does not upgrade import-unique CALLS when registry manifest hash mismatches relationship sidecar', async () => {
    await withTempDir(async (stateRoot) => {
        const gateContent = [
            'export class Gate {',
            '  checkMutation() { return true; }',
            '}',
        ].join('\n');
        const handlersContent = [
            'import { Gate } from "./gate";',
            'export function run(gate: Gate) { return gate.checkMutation(); }',
        ].join('\n');
        const gateFile = createSynthesizedFileSymbol({
            relativePath: 'src/gate.ts',
            language: 'typescript',
            content: gateContent,
            fileHash: 'hash-gate',
            extractorVersion: 'extractor-v1',
        });
        const handlersFile = createSynthesizedFileSymbol({
            relativePath: 'src/handlers.ts',
            language: 'typescript',
            content: handlersContent,
            fileHash: 'hash-handlers',
            extractorVersion: 'extractor-v1',
        });
        const checkMutation = createFunctionSymbol({
            file: 'src/gate.ts',
            name: 'checkMutation',
            qualifiedName: 'Gate.checkMutation',
            label: 'method checkMutation()',
            startLine: 2,
            endLine: 2,
            fileHash: 'hash-gate',
        });
        const run = createFunctionSymbol({
            file: 'src/handlers.ts',
            name: 'run',
            startLine: 2,
            endLine: 2,
            fileHash: 'hash-handlers',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/gate.ts', hash: 'hash-gate', language: 'typescript', symbolCount: 2 },
                { path: 'src/handlers.ts', hash: 'hash-handlers', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [gateFile, checkMutation, handlersFile, run],
        });
        const registryResult = await writeSymbolRegistrySidecar({ stateRoot, registry });
        // Relationship claims a different registry generation than the on-disk symbol sidecar.
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: '/repo',
            symbolRegistryManifestHash: `${registryResult.manifestHash}-stale`,
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: registry.manifest.files,
            records: [
                {
                    sourceKey: handlersFile.symbolKey,
                    sourceInstanceId: handlersFile.symbolInstanceId,
                    targetKey: gateFile.symbolKey,
                    targetInstanceId: gateFile.symbolInstanceId,
                    targetPath: gateFile.file,
                    type: 'IMPORTS',
                    file: 'src/handlers.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: run.symbolKey,
                    sourceInstanceId: run.symbolInstanceId,
                    targetKey: checkMutation.symbolKey,
                    targetInstanceId: checkMutation.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/handlers.ts',
                    span: { startLine: 2, endLine: 2 },
                    confidence: 'low',
                },
            ],
        });

        // expectedSymbolRegistryManifestHash must match relationship sidecar for the query to load.
        const neighbors = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: `${registryResult.manifestHash}-stale`,
            symbolInstanceId: checkMutation.symbolInstanceId,
            depth: 1,
            direction: 'callers',
            allowedTypes: ['CALLS'],
        });

        assert.equal(neighbors.status, 'ok');
        assert.deepEqual(neighbors.records, []);
        assert.deepEqual(
            neighbors.suppressedLowConfidenceRecords.map((r) => r.targetInstanceId),
            [checkMutation.symbolInstanceId],
        );
    });
});

test('getGraphNeighbors does not upgrade when imported file has duplicate same-name targets', async () => {
    await withTempDir(async (stateRoot) => {
        const utilContent = [
            'export function helper() { return 1; }',
            'function helperInner() { return 2; }',
        ].join('\n');
        // Two non-file symbols named "helper" in the same file (unique-name Path 2 must fail).
        const utilFile = createSynthesizedFileSymbol({
            relativePath: 'src/util.ts',
            language: 'typescript',
            content: utilContent,
            fileHash: 'hash-util',
            extractorVersion: 'extractor-v1',
        });
        const callerFile = createSynthesizedFileSymbol({
            relativePath: 'src/caller.ts',
            language: 'typescript',
            content: 'import "./util";\nexport function run() { helper(); }\n',
            fileHash: 'hash-caller',
            extractorVersion: 'extractor-v1',
        });
        const helperA = createFunctionSymbol({
            file: 'src/util.ts',
            name: 'helper',
            qualifiedName: 'helper',
            startLine: 1,
            endLine: 1,
            fileHash: 'hash-util',
        });
        const helperB = createFunctionSymbol({
            file: 'src/util.ts',
            name: 'helper',
            qualifiedName: 'helperInner',
            label: 'function helperInner()',
            startLine: 2,
            endLine: 2,
            fileHash: 'hash-util',
        });
        // Force same name key for uniqueness collision (both name "helper").
        (helperB as { name: string }).name = 'helper';
        const run = createFunctionSymbol({
            file: 'src/caller.ts',
            name: 'run',
            startLine: 2,
            endLine: 2,
            fileHash: 'hash-caller',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/util.ts', hash: 'hash-util', language: 'typescript', symbolCount: 3 },
                { path: 'src/caller.ts', hash: 'hash-caller', language: 'typescript', symbolCount: 2 },
            ]),
            symbols: [utilFile, helperA, helperB, callerFile, run],
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
                    sourceKey: callerFile.symbolKey,
                    sourceInstanceId: callerFile.symbolInstanceId,
                    targetKey: utilFile.symbolKey,
                    targetInstanceId: utilFile.symbolInstanceId,
                    targetPath: utilFile.file,
                    type: 'IMPORTS',
                    file: 'src/caller.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: run.symbolKey,
                    sourceInstanceId: run.symbolInstanceId,
                    targetKey: helperA.symbolKey,
                    targetInstanceId: helperA.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/caller.ts',
                    span: { startLine: 2, endLine: 2 },
                    confidence: 'low',
                },
            ],
        });

        const neighbors = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: helperA.symbolInstanceId,
            depth: 1,
            direction: 'callers',
            allowedTypes: ['CALLS'],
        });

        assert.equal(neighbors.status, 'ok');
        assert.deepEqual(neighbors.records, []);
        assert.deepEqual(
            neighbors.suppressedLowConfidenceRecords.map((r) => r.targetInstanceId),
            [helperA.symbolInstanceId],
        );
    });
});

test('getGraphNeighbors does not load symbol registry when only high CALLS edges are present', async () => {
    const records: RelationshipRecord[] = [
        {
            sourceKey: 'symbol-key:login',
            sourceInstanceId: 'symbol-instance:login',
            targetKey: 'symbol-key:normalize',
            targetInstanceId: 'symbol-instance:normalize',
            type: 'CALLS',
            file: 'src/auth.ts',
            span: { startLine: 2, endLine: 2 },
            confidence: 'high',
        },
    ];
    let getManifestCalls = 0;
    const store: NavigationStore = {
        async getManifest(): Promise<NavigationRegistryState> {
            getManifestCalls += 1;
            throw new Error('getManifest should not be called for high-only CALLS traversal');
        },
        async getSymbolsByFile() {
            throw new Error('getSymbolsByFile should not be called');
        },
        async getSymbolByInstanceId() {
            throw new Error('getSymbolByInstanceId should not be called');
        },
        async getSymbolCandidatesByKey() {
            throw new Error('getSymbolCandidatesByKey should not be called');
        },
        async findOwnerForSpan() {
            throw new Error('findOwnerForSpan should not be called');
        },
        async getRelationships(): Promise<NavigationRelationshipsState> {
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
            throw new Error('getCompatibilityState should not be called');
        },
    };

    const neighbors = await getGraphNeighbors({
        normalizedRootPath: '/repo',
        expectedSymbolRegistryManifestHash: 'manifest-hash',
        symbolInstanceId: 'symbol-instance:login',
        depth: 1,
        direction: 'callees',
        allowedTypes: ['CALLS'],
        navigationStore: store,
    });

    assert.equal(neighbors.status, 'ok');
    assert.deepEqual(neighbors.records.map((r) => r.targetInstanceId), ['symbol-instance:normalize']);
    assert.equal(getManifestCalls, 0, 'high-only CALLS must not load symbol registry for Path 2');
});

test('getGraphNeighbors upgrades Python relative-import-backed cross-file CALLS v0 edges for traversal', async () => {
    await withTempDir(async (stateRoot) => {
        const telemetryContent = [
            'def build_entry_telemetry():',
            '    return None',
        ].join('\n');
        const phasesContent = [
            'from .telemetry import build_entry_telemetry',
            '',
            'def _attach_entry_telemetry():',
            '    return build_entry_telemetry()',
        ].join('\n');
        const telemetryFile = createSynthesizedFileSymbol({
            relativePath: 'src/telemetry.py',
            language: 'python',
            content: telemetryContent,
            fileHash: 'hash-telemetry',
            extractorVersion: 'extractor-v1',
        });
        const phasesFile = createSynthesizedFileSymbol({
            relativePath: 'src/phases.py',
            language: 'python',
            content: phasesContent,
            fileHash: 'hash-phases',
            extractorVersion: 'extractor-v1',
        });
        const buildEntryTelemetry = createFunctionSymbol({
            file: 'src/telemetry.py',
            name: 'build_entry_telemetry',
            startLine: 1,
            endLine: 2,
            fileHash: 'hash-telemetry',
            language: 'python',
        });
        const attachEntryTelemetry = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_attach_entry_telemetry',
            startLine: 3,
            endLine: 4,
            fileHash: 'hash-phases',
            language: 'python',
        });
        const registry = buildSymbolRegistry({
            manifest: manifest([
                { path: 'src/phases.py', hash: 'hash-phases', language: 'python', symbolCount: 2 },
                { path: 'src/telemetry.py', hash: 'hash-telemetry', language: 'python', symbolCount: 2 },
            ]),
            symbols: [phasesFile, attachEntryTelemetry, telemetryFile, buildEntryTelemetry],
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
                    sourceKey: phasesFile.symbolKey,
                    sourceInstanceId: phasesFile.symbolInstanceId,
                    targetKey: telemetryFile.symbolKey,
                    targetInstanceId: telemetryFile.symbolInstanceId,
                    targetPath: telemetryFile.file,
                    type: 'IMPORTS',
                    file: 'src/phases.py',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: phasesFile.symbolKey,
                    sourceInstanceId: phasesFile.symbolInstanceId,
                    targetKey: attachEntryTelemetry.symbolKey,
                    targetInstanceId: attachEntryTelemetry.symbolInstanceId,
                    type: 'EXPORTS',
                    file: 'src/phases.py',
                    span: { startLine: 3, endLine: 3 },
                    confidence: 'high',
                },
                {
                    sourceKey: telemetryFile.symbolKey,
                    sourceInstanceId: telemetryFile.symbolInstanceId,
                    targetKey: buildEntryTelemetry.symbolKey,
                    targetInstanceId: buildEntryTelemetry.symbolInstanceId,
                    type: 'EXPORTS',
                    file: 'src/telemetry.py',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: attachEntryTelemetry.symbolKey,
                    sourceInstanceId: attachEntryTelemetry.symbolInstanceId,
                    targetKey: buildEntryTelemetry.symbolKey,
                    targetInstanceId: buildEntryTelemetry.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/phases.py',
                    span: { startLine: 4, endLine: 4 },
                    confidence: 'low',
                },
            ],
        });

        const callees = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: attachEntryTelemetry.symbolInstanceId,
            depth: 2,
            direction: 'callees',
            allowedTypes: ['CALLS'],
        });

        assert.equal(callees.status, 'ok');
        assert.deepEqual(callees.visitedSymbolInstanceIds, [
            attachEntryTelemetry.symbolInstanceId,
            buildEntryTelemetry.symbolInstanceId,
        ]);
        assert.deepEqual(callees.records.map((record) => ({
            targetInstanceId: record.targetInstanceId,
            confidence: record.confidence,
        })), [{
            targetInstanceId: buildEntryTelemetry.symbolInstanceId,
            confidence: 'medium',
        }]);
        assert.deepEqual(callees.warnings, []);

        const callers = await getGraphNeighbors({
            stateRoot,
            normalizedRootPath: '/repo',
            expectedSymbolRegistryManifestHash: registryResult.manifestHash,
            symbolInstanceId: buildEntryTelemetry.symbolInstanceId,
            depth: 2,
            direction: 'callers',
            allowedTypes: ['CALLS'],
        });

        assert.equal(callers.status, 'ok');
        assert.deepEqual(callers.visitedSymbolInstanceIds, [
            buildEntryTelemetry.symbolInstanceId,
            attachEntryTelemetry.symbolInstanceId,
        ]);
        assert.deepEqual(callers.records.map((record) => ({
            sourceInstanceId: record.sourceInstanceId,
            confidence: record.confidence,
        })), [{
            sourceInstanceId: attachEntryTelemetry.symbolInstanceId,
            confidence: 'medium',
        }]);
        assert.deepEqual(callers.warnings, []);
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
