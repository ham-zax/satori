import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import ts from 'typescript';

import { Context } from '../core/context';
import { Embedding, EMBEDDING_NORMALIZATION_POLICY_VERSION } from '../embedding';
import { TypeScriptSemanticProjectAnalyzer } from '../relationships/typescript-semantic-analyzer';
import type {
    ResolutionProjectAnalyzer,
    ResolutionProjectEvidence,
    ResolutionProjectInput,
} from '../relationships/resolution';
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
    resolutionAnalyzer?: ResolutionProjectAnalyzer,
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

function emitConfiguredProject(configPath: string): void {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(read.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath,
    );
    const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
    });
    const emitted = program.emit();
    assert.equal(emitted.emitSkipped, false);
}

class CapturingTypeScriptSemanticProjectAnalyzer extends TypeScriptSemanticProjectAnalyzer {
    lastEvidence?: ResolutionProjectEvidence;

    override async analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        const evidence = await super.analyze(input);
        this.lastEvidence = evidence;
        return evidence;
    }
}

test('late TypeScript resolution failure preserves a searchable Publication with unavailable call-graph coverage', async () => {
    const failingAnalyzer: ResolutionProjectAnalyzer = {
        supportsLanguage: (language) => language === 'typescript',
        getProviderMetadata: () => ({
            providerId: 'satori-typescript-compiler',
            providerVersion: 'ts-compiler-v7',
        }),
        analyze: async () => {
            throw new Error('fixture compiler crashed after vector finalization');
        },
    };
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/run.ts': `
export function target(): string { return 'ok'; }
export function run(): string { return target(); }
`,
    }, failingAnalyzer);

    try {
        const result = await fixture.context.indexCodebase(fixture.root);
        assert.equal(result.status, 'completed');
        assert.equal(result.publication.status, 'activated');

        const state = await readNavigation(fixture.context, fixture.root);
        assert.equal(state.current.publication.status, 'complete');
        assert.equal(
            state.relationships.records.some((record) => record.type === 'CALLS'),
            false,
        );
        const coverage = state.relationships.manifest.providerCoverage.find(
            (entry) => entry.providerId === 'satori-typescript-compiler',
        );
        assert.ok(coverage);
        assert.equal(coverage.status, 'unavailable');
        assert.equal(coverage.failureReason, 'provider_failure');
        assert.match(coverage.failureMessage ?? '', /fixture compiler crashed/);
        assert.equal(coverage.sourceFileCount, 1);
        assert.equal(coverage.analyzedSourceFileCount, 0);
    } finally {
        await fixture.close();
    }
});

test('TypeScript semantic resource limits degrade call-graph coverage without failing searchable publication', async () => {
    const analyzer = new TypeScriptSemanticProjectAnalyzer(1, {
        maxFileBytes: 128,
        maxProjectBytes: 256,
    });
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/oversized.ts': `
export function target(): string { return 'ok'; }
export function run(): string {
    const padding = '${'x'.repeat(256)}';
    return padding ? target() : '';
}
`,
    }, analyzer);

    try {
        const result = await fixture.context.indexCodebase(fixture.root);
        assert.equal(result.status, 'completed');
        assert.equal(result.publication.status, 'activated');

        const state = await readNavigation(fixture.context, fixture.root);
        const coverage = state.relationships.manifest.providerCoverage.find(
            (entry) => entry.providerId === 'satori-typescript-compiler',
        );
        assert.ok(coverage);
        assert.equal(coverage.status, 'unavailable');
        assert.equal(coverage.failureReason, 'resource_limit');
        assert.match(coverage.failureMessage ?? '', /per-file budget/);
        assert.equal(coverage.analyzedSourceFileCount, 0);
        assert.equal(
            state.relationships.records.some((record) => record.type === 'CALLS'),
            false,
        );
    } finally {
        await fixture.close();
        await analyzer.dispose();
    }
});

test('TypeScript semantic project byte limits degrade call-graph coverage without failing searchable publication', async () => {
    const analyzer = new TypeScriptSemanticProjectAnalyzer(1, {
        maxFileBytes: 512,
        maxProjectBytes: 300,
    });
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/one.ts': `
export const one = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
`,
        'src/two.ts': `
export const two = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
`,
    }, analyzer);

    try {
        const result = await fixture.context.indexCodebase(fixture.root);
        assert.equal(result.status, 'completed');
        assert.equal(result.publication.status, 'activated');

        const state = await readNavigation(fixture.context, fixture.root);
        const coverage = state.relationships.manifest.providerCoverage.find(
            (entry) => entry.providerId === 'satori-typescript-compiler',
        );
        assert.ok(coverage);
        assert.equal(coverage.status, 'unavailable');
        assert.equal(coverage.failureReason, 'resource_limit');
        assert.match(coverage.failureMessage ?? '', /project budget/);
        assert.equal(coverage.sourceFileCount, 2);
        assert.equal(coverage.analyzedSourceFileCount, 0);
    } finally {
        await fixture.close();
        await analyzer.dispose();
    }
});

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

test('production indexing resolves same-class TypeScript this-member calls', async () => {
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/client.ts': `
export class Client {
    request(): void {
        this.cancelDecision();
        this.pump();
    }

    private cancelDecision(): void {}
    private pump(): void {}
}
`,
    });
    try {
        await fixture.context.indexCodebase(fixture.root);
        const state = await readNavigation(fixture.context, fixture.root);
        const claims = state.relationships.analysisByFile.get('src/client.ts')?.resolutionClaims ?? [];
        const byCallee = new Map(claims.map((claim) => [claim.observation.calleeText, claim]));

        for (const calleeText of ['this.cancelDecision', 'this.pump']) {
            const claim = byCallee.get(calleeText);
            assert.ok(claim, calleeText);
            assert.equal(claim.decision, 'resolved', calleeText);
            assert.equal(claim.relationshipType, 'CALLS', calleeText);
            assert.equal(claim.resolutionAuthority, 'direct_binding', calleeText);
        }
    } finally {
        await fixture.close();
    }
});

test('production indexing preserves exact TypeScript target references without fabricating anonymous caller edges', async () => {
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/worker.ts': `
export class Worker {
    request(): string { return 'worker'; }
}
`,
        'src/cases.test.ts': `
import { Worker } from './worker';

declare function scenario(callback: () => void): void;

scenario(() => {
    const client = new Worker();
    client.request();
});
`,
    });
    try {
        await fixture.context.indexCodebase(fixture.root);
        const state = await readNavigation(fixture.context, fixture.root);
        const claims = state.relationships.analysisByFile.get('src/cases.test.ts')?.resolutionClaims ?? [];
        const requestClaim = claims.find((claim) => claim.observation.calleeText === 'client.request');

        assert.ok(requestClaim);
        assert.equal(requestClaim.decision, 'resolved');
        assert.equal(requestClaim.relationshipType, 'REFERENCES');
        assert.equal(requestClaim.resolutionAuthority, 'direct_binding');
        assert.equal(requestClaim.sourceInstanceId, undefined);
        assert.equal(requestClaim.targetSymbol, 'Worker.request');
        assert.equal(typeof requestClaim.targetInstanceId, 'string');

        const calls = callTargets(state.relationships.records, state.registry.symbolsByInstanceId);
        assert.equal(
            calls.some(({ target, record }) => (
                target.qualifiedName === 'Worker.request'
                && record.file === 'src/cases.test.ts'
            )),
            false,
        );
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

test('project-global TypeScript origin changes invalidate unchanged callers and match a fresh index', async () => {
    const initialFiles = {
        'tsconfig.json': tsconfig({ moduleDetection: 'legacy' }),
        'src/a.ts': `
class A {
    run(): string { return 'a'; }
}
`,
        'src/b.ts': `
class B {
    run(): string { return 'b'; }
}
`,
        'src/globals.ts': 'const service = new A();\n',
        'src/caller.ts': 'function caller(): string { return service.run(); }\n',
    };
    const fixture = await createFixture(initialFiles);
    try {
        await fixture.context.indexCodebase(fixture.root);
        const before = await readNavigation(fixture.context, fixture.root);
        const beforeCalls = callTargets(before.relationships.records, before.registry.symbolsByInstanceId);
        assert.equal(beforeCalls.some(({ source, target }) => (
            source.qualifiedName === 'caller' && target.qualifiedName === 'A.run'
        )), true);

        fs.writeFileSync(path.join(fixture.root, 'src/globals.ts'), 'const service = new B();\n');
        const delta = await fixture.context.reindexByChange(fixture.root);
        assert.deepEqual(delta.changedFiles, ['src/globals.ts']);

        const incremental = await readNavigation(fixture.context, fixture.root);
        const incrementalCalls = callTargets(
            incremental.relationships.records,
            incremental.registry.symbolsByInstanceId,
        ).filter(({ source }) => source.qualifiedName === 'caller');
        assert.deepEqual(
            incrementalCalls.map(({ target }) => target.qualifiedName),
            ['B.run'],
        );
        assert.equal(incrementalCalls.some(({ target }) => target.qualifiedName === 'A.run'), false);

        const freshFixture = await createFixture({
            ...initialFiles,
            'src/globals.ts': 'const service = new B();\n',
        });
        try {
            await freshFixture.context.indexCodebase(freshFixture.root);
            const fresh = await readNavigation(freshFixture.context, freshFixture.root);
            const freshCalls = callTargets(
                fresh.relationships.records,
                fresh.registry.symbolsByInstanceId,
            ).filter(({ source }) => source.qualifiedName === 'caller');
            assert.deepEqual(
                incrementalCalls.map(({ source, target }) => [
                    source.file,
                    source.qualifiedName,
                    target.file,
                    target.qualifiedName,
                    target.symbolInstanceId,
                ]),
                freshCalls.map(({ source, target }) => [
                    source.file,
                    source.qualifiedName,
                    target.file,
                    target.qualifiedName,
                    target.symbolInstanceId,
                ]),
            );
        } finally {
            await freshFixture.close();
        }
    } finally {
        await fixture.close();
    }
});

test('declare global augmentation changes invalidate module callers without import edges', async () => {
    const globalDeclaration = (target: 'A' | 'B') => `
import { ${target} } from './${target.toLowerCase()}';
export {};
declare global {
    const service: ${target};
}
`;
    const fixture = await createFixture({
        'tsconfig.json': tsconfig(),
        'src/a.ts': `export class A { run(): string { return 'a'; } }\n`,
        'src/b.ts': `export class B { run(): string { return 'b'; } }\n`,
        'src/globals.ts': globalDeclaration('A'),
        'src/caller.ts': `export function caller(): string { return service.run(); }\n`,
    });
    try {
        await fixture.context.indexCodebase(fixture.root);
        const before = await readNavigation(fixture.context, fixture.root);
        const beforeManifest = JSON.parse(fs.readFileSync(
            path.join(before.navigation.navigationRoot, 'relationships/manifest.json'),
            'utf8',
        )) as { files: Array<{ path: string; shardPath: string }> };
        const beforeCallerShard = beforeManifest.files.find((file) => file.path === 'src/caller.ts')!;
        const beforeCallerInode = fs.statSync(path.join(
            before.navigation.navigationRoot,
            'relationships',
            beforeCallerShard.shardPath.replace(/^relationships\//, ''),
        )).ino;

        fs.writeFileSync(path.join(fixture.root, 'src/globals.ts'), globalDeclaration('B'));
        const delta = await fixture.context.reindexByChange(fixture.root);
        assert.deepEqual(delta.changedFiles, ['src/globals.ts']);

        const after = await readNavigation(fixture.context, fixture.root);
        const afterManifest = JSON.parse(fs.readFileSync(
            path.join(after.navigation.navigationRoot, 'relationships/manifest.json'),
            'utf8',
        )) as { files: Array<{ path: string; shardPath: string }> };
        const afterCallerShard = afterManifest.files.find((file) => file.path === 'src/caller.ts')!;
        const afterCallerInode = fs.statSync(path.join(
            after.navigation.navigationRoot,
            'relationships',
            afterCallerShard.shardPath.replace(/^relationships\//, ''),
        )).ino;

        assert.notEqual(afterCallerInode, beforeCallerInode);
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

test('project-reference source changes fail closed until output/control authority changes', async () => {
    const analyzer = new CapturingTypeScriptSemanticProjectAnalyzer();
    const sharedCompilerOptions = {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        composite: true,
        declaration: true,
        rootDir: 'src',
        outDir: 'dist',
    };
    const libConfig = (extraCompilerOptions: Record<string, unknown> = {}) => JSON.stringify({
        compilerOptions: {
            ...sharedCompilerOptions,
            ...extraCompilerOptions,
        },
        include: ['src/**/*.ts'],
    }, null, 2);
    const fixture = await createFixture({
        '.gitignore': 'lib/dist/\n',
        'lib/tsconfig.json': libConfig(),
        'lib/src/index.ts': `export class Shared { run(): string { return 'v1'; } }\n`,
        'app/tsconfig.json': JSON.stringify({
            compilerOptions: sharedCompilerOptions,
            references: [{ path: '../lib' }],
            include: ['src/**/*.ts'],
        }, null, 2),
        'app/src/main.ts': `
import { Shared } from '../../lib/src/index';
export function useShared(): string {
    return new Shared().run();
}
`,
    }, analyzer);
    try {
        const libConfigPath = path.join(fixture.root, 'lib/tsconfig.json');
        emitConfiguredProject(libConfigPath);
        await fixture.context.indexCodebase(fixture.root);

        fs.writeFileSync(
            path.join(fixture.root, 'lib/src/index.ts'),
            `export class Shared { run(): number { return 2; } }\n`,
        );
        const sourceDelta = await fixture.context.reindexByChange(fixture.root);
        assert.equal(sourceDelta.changedFiles.includes('lib/src/index.ts'), true);
        assert.ok(analyzer.lastEvidence);
        assert.equal(analyzer.lastEvidence.affectedSourceFiles?.has('app/src/main.ts'), true);
        assert.deepEqual(analyzer.lastEvidence.claimsByFile.get('app/src/main.ts'), []);

        emitConfiguredProject(libConfigPath);
        const outputDelta = await fixture.context.reindexByChange(fixture.root);
        assert.equal(outputDelta.changedFiles.includes('lib/dist/index.d.ts'), true);
        assert.ok(analyzer.lastEvidence);
        assert.equal(analyzer.lastEvidence.affectedSourceFiles?.has('app/src/main.ts'), true);
        assert.equal((analyzer.lastEvidence.claimsByFile.get('app/src/main.ts')?.length ?? 0) > 0, true);

        fs.writeFileSync(libConfigPath, libConfig({ declarationMap: true }));
        const controlDelta = await fixture.context.reindexByChange(fixture.root);
        assert.equal(controlDelta.changedFiles.includes('lib/tsconfig.json'), true);
        assert.ok(analyzer.lastEvidence);
        assert.equal(analyzer.lastEvidence.affectedSourceFiles?.has('app/src/main.ts'), true);
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
