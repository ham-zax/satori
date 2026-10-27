import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/contracts';
import { buildSymbolRegistry } from '../symbols/registry';
import { readRelationshipSidecar, readSymbolRegistrySidecar } from '../symbols/sidecar-reads';
import { writeRelationshipSidecar, writeSymbolRegistrySidecar } from '../symbols/sidecar-writes';
import { IndexGenerationWorkflow, type IndexGenerationWorkflowPorts } from './index-generation-workflow';
import type { SemanticProjectAnalyzer, SemanticProjectInput } from '../semantic';

async function fixture(run: (input: { root: string; publicationId: string; navigationRoot: string }) => Promise<void>,
    sources: ReadonlyArray<{ path: string; language: string; source: string }> = []) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-prewarm-'));
    const publicationId = 'publication';
    const navigationRoot = path.join(root, publicationId, 'navigation');
    try {
        for (const source of sources) fs.writeFileSync(path.join(root, source.path), source.source);
        const registry = buildSymbolRegistry({ manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: root,
            rootFingerprint: 'root', indexPolicyHash: 'policy', languageRouterVersion: 'router',
            extractorVersion: 'extractor', relationshipVersion: 'relationships',
            builtAt: new Date(0).toISOString(), files: sources.map(source => ({
                path: source.path, language: source.language,
                hash: createHash('sha256').update(source.source).digest('hex'),
                symbolCount: 0, definitionStatus: 'definition_free' as const,
            })),
        }, symbols: [] });
        const written = await writeSymbolRegistrySidecar({ navigationRoot, registry });
        await writeRelationshipSidecar({ normalizedRootPath: root, navigationRoot,
            symbolRegistryManifestHash: written.manifestHash, relationshipVersion: 'relationships',
            builtAt: new Date(0).toISOString(), records: [],
            analysisByFile: new Map([['a.ts', { moduleBindings: [], callSites: [], receiverTypeBindings: [] }]]),
            providerCoverage: [{ language: 'rust', providerId: 'fixture', providerVersion: '1',
                status: 'degraded', sourceFileCount: 1, analyzedSourceFileCount: 0,
                skippedFiles: [{ path: 'a.rs', reason: 'source_too_large', bytes: 10 }] }],
        });
        await run({ root, publicationId, navigationRoot });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function workflow(token: () => string | null, semanticAnalyzer?: SemanticProjectAnalyzer) {
    return new IndexGenerationWorkflow({ resolveNavigationObservationToken: token, semanticAnalyzer } as unknown as IndexGenerationWorkflowPorts);
}

const go = { path: 'main.go', language: 'go', source: 'package main\nfunc main() {}\n' };
const rust = { path: 'main.rs', language: 'rust', source: 'fn main() {}\n' };

function semantic(prepare: (input: SemanticProjectInput, signal?: AbortSignal) => Promise<void>): SemanticProjectAnalyzer {
    return {
        supportsLanguage: language => language === 'go' || language === 'rust',
        prepareSourceTrees: prepare,
        analyze: async input => ({ language: input.language, occurrencesByFile: new Map() }),
    };
}

test('prewarm prepares the one supported semantic language', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    const calls: SemanticProjectInput[] = [];
    const instance = workflow(() => 'token', semantic(async input => { calls.push(input); }));
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].language, 'go');
    assert.deepEqual(calls[0].auxiliaryFiles, []);
    assert.deepEqual(calls[0].sourceFiles.map(file => [file.path, file.source]), [[go.path, go.source]]);
    assert.ok(instance.resolveReusableNavigationDeltaState(root, publicationId, navigationRoot));
}, [go]));

test('prewarm skips source preparation for multiple semantic languages', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    let calls = 0;
    const instance = workflow(() => 'token', semantic(async () => { calls++; }));
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), true);
    assert.equal(calls, 0);
}, [go, rust]));

test('changed source bytes skip preparation and keep navigation preload', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    let calls = 0;
    const instance = workflow(() => 'token', semantic(async () => { calls++; }));
    fs.writeFileSync(path.join(root, go.path), `${go.source}// changed\n`);
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), true);
    assert.equal(calls, 0);
    assert.ok(instance.resolveReusableNavigationDeltaState(root, publicationId, navigationRoot));
}, [go]));

test('token change during source preparation retains no navigation preload', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    let token = 'first';
    const instance = workflow(() => token, semantic(async () => { token = 'second'; }));
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), false);
    assert.equal(instance.resolveReusableNavigationDeltaState(root, publicationId, navigationRoot), undefined);
}, [go]));

test('an already-aborted preparation leaves the navigation preload available', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const instance = workflow(() => 'token', semantic(async () => { calls++; }));
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot, controller.signal), true);
    assert.equal(calls, 0);
}, [go]));

test('prewarm matches the cold sidecar reads', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    const instance = workflow(() => 'token');
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), true);
    const state = instance.resolveReusableNavigationDeltaState(root, publicationId, navigationRoot);
    assert.ok(state);
    const input = { normalizedRootPath: root, publicationId, navigationRoot };
    const registry = await readSymbolRegistrySidecar(input);
    const relationships = await readRelationshipSidecar(input);
    assert.equal(registry.status, 'ok');
    assert.equal(relationships.status, 'ok');
    if (registry.status !== 'ok' || relationships.status !== 'ok') throw new Error('sidecar read failed');
    assert.deepEqual(state.registry, registry.registry);
    assert.deepEqual(state.records, relationships.records);
    assert.deepEqual(state.analysisByFile, relationships.analysisByFile);
    assert.deepEqual(state.providerCoverage, relationships.manifest.providerCoverage);
}));

test('a changed observation token invalidates the prewarm', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    let token = 'first';
    const instance = workflow(() => token);
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), true);
    token = 'second';
    assert.equal(instance.resolveReusableNavigationDeltaState(root, publicationId, navigationRoot), undefined);
}));

test('a token change during sidecar reads retains no prewarm', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    let calls = 0;
    const instance = workflow(() => ++calls === 1 ? 'first' : 'second');
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), false);
    assert.equal(instance.resolveReusableNavigationDeltaState(root, publicationId, navigationRoot), undefined);
}));

test('missing and corrupt sidecars cannot be prewarmed', async () => fixture(async ({ root, publicationId, navigationRoot }) => {
    const instance = workflow(() => 'token');
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, path.join(root, 'missing')), false);
    fs.writeFileSync(path.join(navigationRoot, 'manifest.json'), '{');
    assert.equal(await instance.prewarmNavigationDeltaState(root, publicationId, navigationRoot), false);
    assert.equal(instance.resolveReusableNavigationDeltaState(root, publicationId, navigationRoot), undefined);
}));
