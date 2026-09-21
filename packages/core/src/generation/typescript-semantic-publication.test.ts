import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import ts from 'typescript';

import { Context } from '../core/context';
import { Embedding, EMBEDDING_NORMALIZATION_POLICY_VERSION } from '../embedding';
import { TypeScriptSemanticProjectAnalyzer } from '../relationships/typescript-semantic-analyzer';
import {
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    type RelationshipRecord,
    type SymbolRecord,
} from '../symbols';
import { LanceDbVectorDatabase } from '../vectordb/lancedb-vectordb';

class FixtureEmbedding extends Embedding {
    protected maxTokens = 8192;
    getDimension() { return 4; }
    getProvider() { return 'fixture'; }
    getIdentity() {
        return {
            provider: 'fixture',
            model: 'fixture',
            dimension: 4,
            artifactDigest: null,
            normalizationPolicy: EMBEDDING_NORMALIZATION_POLICY_VERSION,
        };
    }
    async detectDimension() { return 4; }
    async embedQuery() { return { vector: [1, 0, 0, 0], dimension: 4 }; }
    async embedDocuments(texts: string[]) { return Promise.all(texts.map(() => this.embedQuery())); }
}

async function createFixture(
    files: Readonly<Record<string, string>>,
    resolutionAnalyzer?: TypeScriptSemanticProjectAnalyzer,
) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-semantic-publication-'));
    const root = path.join(tempRoot, 'repo');
    fs.mkdirSync(root, { recursive: true });
    for (const [relativePath, source] of Object.entries(files)) {
        const absolutePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, source);
    }
    const database = new LanceDbVectorDatabase({ databasePath: path.join(tempRoot, 'vectors') });
    const context = new Context({
        embedding: new FixtureEmbedding(),
        vectorDatabase: database,
        semanticAnalyzer: {
            supportsLanguage: () => false,
            analyze: async (input) => ({ language: input.language, occurrencesByFile: new Map() }),
        },
        ...(resolutionAnalyzer ? { resolutionAnalyzer } : {}),
    });
    return {
        root,
        context,
        database,
        async close() {
            await context.dispose();
            await database.close();
            fs.rmSync(tempRoot, { recursive: true, force: true });
        },
    };
}

async function readNavigation(context: Context, root: string) {
    const current = context.getCurrentPublication(root);
    assert.ok(current);
    const navigation = context.getPublicationNavigationAddress(current);
    assert.ok(navigation);
    const registry = await readSymbolRegistrySidecar({
        normalizedRootPath: root,
        ...navigation,
    });
    assert.equal(registry.status, 'ok');
    if (registry.status !== 'ok') throw new Error('Missing symbol registry');
    const relationships = await readRelationshipSidecar({
        normalizedRootPath: root,
        ...navigation,
        expectedSymbolRegistryManifestHash: registry.manifestHash,
    });
    assert.equal(relationships.status, 'ok');
    if (relationships.status !== 'ok') throw new Error('Missing relationship sidecar');
    return { current, navigation, registry: registry.registry, relationships };
}

function callTargets(
    records: readonly RelationshipRecord[],
    symbolsByInstanceId: ReadonlyMap<string, SymbolRecord>,
): Array<{ source: SymbolRecord; target: SymbolRecord; record: RelationshipRecord }> {
    const calls: Array<{ source: SymbolRecord; target: SymbolRecord; record: RelationshipRecord }> = [];
    for (const record of records) {
        if (record.type !== 'CALLS' || !record.sourceInstanceId || !record.targetInstanceId) continue;
        const source = symbolsByInstanceId.get(record.sourceInstanceId);
        const target = symbolsByInstanceId.get(record.targetInstanceId);
        if (source && target) calls.push({ source, target, record });
    }
    return calls;
}

function tsconfig(extraCompilerOptions: Record<string, unknown> = {}): string {
    return JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            ...extraCompilerOptions,
        },
        include: ['src/**/*.ts'],
    }, null, 2);
}

test('production indexing publishes proof-backed TypeScript CALLS and abstains on open-world interface dispatch', async () => {
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/cases.ts': `
export class Worker {
    request(): string { return 'worker'; }
}
export class Decoy {
    request(count: number): string { return String(count); }
}
export class FieldService {
    worker: Worker = new Worker();
    run(): string { return this.worker.request(); }
}
export class ParamService {
    constructor(public worker: Worker) {}
    run(): string { return this.worker.request(); }
}
export class AssignedService {
    worker: Worker;
    constructor(worker: Worker) { this.worker = worker; }
    run(): string { return this.worker.request(); }
}
const baseWorker = new Worker();
const aliasWorker = baseWorker;
export function aliasCall(): string { return aliasWorker.request(); }

export interface WorkerLike {
    request(): string;
}
export function interfaceCall(worker: WorkerLike): string {
    return worker.request();
}
`,
    });
    try {
        await fixture.context.indexCodebase(fixture.root);
        const state = await readNavigation(fixture.context, fixture.root);
        const calls = callTargets(state.relationships.records, state.registry.symbolsByInstanceId);
        const workerCalls = calls.filter(({ target }) => target.qualifiedName === 'Worker.request');
        assert.deepEqual(
            workerCalls.map(({ source }) => source.qualifiedName).sort(),
            ['AssignedService.run', 'FieldService.run', 'ParamService.run', 'aliasCall'],
        );
        assert.equal(calls.some(({ target }) => target.qualifiedName === 'Decoy.request'), false);
        assert.equal(calls.some(({ source }) => source.qualifiedName === 'interfaceCall'), false);
        for (const { record } of workerCalls) {
            assert.equal(record.resolutionAuthority === 'direct_binding' || record.resolutionAuthority === 'origin_flow', true);
        }

        const claims = state.relationships.analysisByFile.get('src/cases.ts')?.resolutionClaims ?? [];
        assert.equal(claims.some((claim) => claim.providerId === 'satori-typescript-compiler'), true);
        assert.equal(
            claims.some((claim) => claim.environmentConfigId.startsWith(`typescript:${ts.version}:configured:`)),
            true,
        );
        const interfaceClaim = claims.find((claim) => (
            claim.callSpan
            && claim.decision !== 'resolved'
            && claim.proofSteps.some((step) => step.subject === 'worker.request')
        ));
        assert.ok(interfaceClaim);

        const checkpoint = fixture.context.getPublicationSourceCheckpoint(state.current);
        assert.ok(checkpoint);
        assert.equal(checkpoint.fileHashes.some(([file]) => file === 'tsconfig.json'), true);
        assert.equal(state.registry.manifest.files.some((file) => file.path === 'tsconfig.json'), false);
    } finally {
        await fixture.close();
    }
});

test('one TypeScript source edit rewrites an unchanged dependent caller but shares unrelated relationship owners', async () => {
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/service.ts': `
export class Service {
    work(): number { return 1; }
}
`,
        'src/caller.ts': `
import { Service } from './service';
export function run(): number {
    const service = new Service();
    return service.work();
}
`,
        'src/unrelated.ts': `
export function untouched(): number { return 7; }
`,
    });
    try {
        await fixture.context.indexCodebase(fixture.root);
        const before = await readNavigation(fixture.context, fixture.root);
        const beforeCalls = callTargets(before.relationships.records, before.registry.symbolsByInstanceId);
        const beforeWork = beforeCalls.find(({ source, target }) => (
            source.qualifiedName === 'run' && target.qualifiedName === 'Service.work'
        ));
        assert.ok(beforeWork);

        const beforeManifest = JSON.parse(fs.readFileSync(
            path.join(before.navigation.navigationRoot, 'relationships/manifest.json'),
            'utf8',
        )) as { files: Array<{ path: string; shardPath: string }> };
        const beforeCallerShard = beforeManifest.files.find((file) => file.path === 'src/caller.ts')!;
        const beforeUnrelatedShard = beforeManifest.files.find((file) => file.path === 'src/unrelated.ts')!;
        const beforeCallerInode = fs.statSync(path.join(
            before.navigation.navigationRoot,
            'relationships',
            beforeCallerShard.shardPath.replace(/^relationships\//, ''),
        )).ino;
        const beforeUnrelatedInode = fs.statSync(path.join(
            before.navigation.navigationRoot,
            'relationships',
            beforeUnrelatedShard.shardPath.replace(/^relationships\//, ''),
        )).ino;

        fs.writeFileSync(path.join(fixture.root, 'src/service.ts'), `
export class Service {
    work(): number { return 2; }
}
`);
        const delta = await fixture.context.reindexByChange(fixture.root);
        assert.deepEqual(delta.changedFiles, ['src/service.ts']);

        const after = await readNavigation(fixture.context, fixture.root);
        const afterCalls = callTargets(after.relationships.records, after.registry.symbolsByInstanceId);
        const afterWork = afterCalls.find(({ source, target }) => (
            source.qualifiedName === 'run' && target.qualifiedName === 'Service.work'
        ));
        assert.ok(afterWork);
        assert.notEqual(afterWork.record.targetInstanceId, beforeWork.record.targetInstanceId);

        const afterManifest = JSON.parse(fs.readFileSync(
            path.join(after.navigation.navigationRoot, 'relationships/manifest.json'),
            'utf8',
        )) as { files: Array<{ path: string; shardPath: string }> };
        const afterCallerShard = afterManifest.files.find((file) => file.path === 'src/caller.ts')!;
        const afterUnrelatedShard = afterManifest.files.find((file) => file.path === 'src/unrelated.ts')!;
        const afterCallerInode = fs.statSync(path.join(
            after.navigation.navigationRoot,
            'relationships',
            afterCallerShard.shardPath.replace(/^relationships\//, ''),
        )).ino;
        const afterUnrelatedInode = fs.statSync(path.join(
            after.navigation.navigationRoot,
            'relationships',
            afterUnrelatedShard.shardPath.replace(/^relationships\//, ''),
        )).ino;

        assert.notEqual(afterCallerInode, beforeCallerInode);
        assert.equal(afterUnrelatedInode, beforeUnrelatedInode);
    } finally {
        await fixture.close();
    }
});

test('tsconfig path mapping is checkpoint authority and config-only changes retarget TypeScript CALLS', async () => {
    const config = (target: 'a' | 'b') => tsconfig({
        baseUrl: '.',
        paths: { '@svc': [`src/${target}.ts`] },
    });
    const fixture = await createFixture({
        'tsconfig.json': config('a'),
        'src/a.ts': `export class Service { work(): string { return 'a'; } }\n`,
        'src/b.ts': `export class Service { work(): string { return 'b'; } }\n`,
        'src/caller.ts': `
import { Service } from '@svc';
export function run(): string {
    const service = new Service();
    return service.work();
}
`,
    });
    try {
        await fixture.context.indexCodebase(fixture.root);
        const before = await readNavigation(fixture.context, fixture.root);
        const beforeCall = callTargets(before.relationships.records, before.registry.symbolsByInstanceId)
            .find(({ source, target }) => source.qualifiedName === 'run' && target.qualifiedName === 'Service.work');
        assert.ok(beforeCall);
        assert.equal(beforeCall.target.file, 'src/a.ts');

        fs.writeFileSync(path.join(fixture.root, 'tsconfig.json'), config('b'));
        const delta = await fixture.context.reindexByChange(fixture.root);
        assert.deepEqual(delta.changedFiles, ['tsconfig.json']);

        const after = await readNavigation(fixture.context, fixture.root);
        const afterCall = callTargets(after.relationships.records, after.registry.symbolsByInstanceId)
            .find(({ source, target }) => source.qualifiedName === 'run' && target.qualifiedName === 'Service.work');
        assert.ok(afterCall);
        assert.equal(afterCall.target.file, 'src/b.ts');
        assert.notEqual(afterCall.record.targetInstanceId, beforeCall.record.targetInstanceId);
    } finally {
        await fixture.close();
    }
});

test('TypeScript files outside configured projects use a deterministic inferred-project identity', async () => {
    const fixture = await createFixture({
        'src/app.ts': `
export function helper(): number { return 1; }
export function run(): number { return helper(); }
`,
    });
    try {
        await fixture.context.indexCodebase(fixture.root);
        const state = await readNavigation(fixture.context, fixture.root);
        const calls = callTargets(state.relationships.records, state.registry.symbolsByInstanceId);
        assert.equal(calls.some(({ source, target }) => (
            source.qualifiedName === 'run' && target.qualifiedName === 'helper'
        )), true);
        const claims = state.relationships.analysisByFile.get('src/app.ts')?.resolutionClaims ?? [];
        assert.equal(
            claims.some((claim) => claim.environmentConfigId.startsWith(`typescript:${ts.version}:inferred:`)),
            true,
        );
    } finally {
        await fixture.close();
    }
});

test('TypeScript LanguageService sessions obey the configured LRU bound and dispose with Context', async () => {
    const analyzer = new TypeScriptSemanticProjectAnalyzer(2);
    const fixture = await createFixture({
        'a/tsconfig.json': tsconfig(),
        'a/src/a.ts': 'export function a(): number { return 1; }\n',
        'b/tsconfig.json': tsconfig(),
        'b/src/b.ts': 'export function b(): number { return 2; }\n',
        'c/tsconfig.json': tsconfig(),
        'c/src/c.ts': 'export function c(): number { return 3; }\n',
    }, analyzer);
    try {
        await fixture.context.indexCodebase(fixture.root);
        const stats = analyzer.getSessionStats();
        assert.equal(stats.max, 2);
        assert.equal(stats.active <= 2, true);
    } finally {
        await fixture.close();
    }
    assert.equal(analyzer.getSessionStats().active, 0);
});
