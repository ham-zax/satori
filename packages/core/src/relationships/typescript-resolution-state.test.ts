import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { mock } from 'node:test';

import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/contracts';
import { buildSymbolRegistry } from '../symbols/registry';
import { mergeTypeScriptShardEvidence } from './typescript-resolution-shards';
import { TypeScriptSemanticProjectAnalyzer, type TypeScriptSemanticResourceBudget } from './typescript-semantic-analyzer';

const COMPILER_OPTIONS = { module: 'commonjs', target: 'ES2022', strict: true, types: [] };

function registryFor(root: string, files: readonly string[]) {
    return buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: root,
            rootFingerprint: 'root-fingerprint',
            indexPolicyHash: 'policy-hash',
            languageRouterVersion: 'router-v1',
            extractorVersion: 'extractor-v1',
            relationshipVersion: 'relationships-v1',
            builtAt: '2026-09-28T00:00:00.000Z',
            files: files.map((file) => ({
                path: file,
                hash: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
                language: 'typescript',
                symbolCount: 0,
                definitionStatus: 'definitions_present' as const,
            })),
        },
        symbols: [],
    });
}

// A sync runs in a new process, so its analyzer starts empty; only the state
// persisted by the previous analysis can keep the delta small.
test('a fresh analyzer resumes a delta from persisted state, sharded or not', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-state-')));
    const files = ['one/src/a.ts', 'one/src/b.ts', 'two/src/c.ts', 'two/src/d.ts'];
    const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    try {
        for (const project of ['one', 'two']) {
            write(`${project}/tsconfig.json`, JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src'] }));
        }
        write('one/src/a.ts', 'export function a(): number {\n    return 1;\n}\n');
        write('one/src/b.ts', 'import { a } from "./a";\nexport const b = a();\n');
        write('two/src/c.ts', 'export function c(): number {\n    return 3;\n}\n');
        write('two/src/d.ts', 'export const d = 4;\n');
        const before = registryFor(root, files);

        for (const shardCount of [1, 2]) {
            const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
            const analyzers = () => Array.from({ length: shardCount }, (_, index) => (
                new TypeScriptSemanticProjectAnalyzer(4, undefined, 0, {
                    stateDirectory,
                    ...(shardCount > 1 ? { shard: { index, count: shardCount } } : {}),
                })
            ));
            const analyze = async (input: Parameters<TypeScriptSemanticProjectAnalyzer['analyze']>[0]) => {
                const shards = analyzers();
                try {
                    return mergeTypeScriptShardEvidence(await Promise.all(shards.map((shard) => shard.analyzeShard(input))));
                } finally {
                    await Promise.all(shards.map((shard) => shard.dispose()));
                }
            };

            await analyze({ rootPath: root, language: 'typescript', registry: before });
            write('two/src/c.ts', 'export function c(): number {\n    return 30;\n}\n');
            const after = registryFor(root, files);
            const delta = await analyze({
                rootPath: root,
                language: 'typescript',
                registry: after,
                previousRegistry: before,
                changedFiles: new Set(['two/src/c.ts']),
            });
            assert.deepEqual([...delta.affectedSourceFiles ?? []].sort(), ['two/src/c.ts'], `${shardCount} shard(s)`);
            write('two/src/c.ts', 'export function c(): number {\n    return 3;\n}\n');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a require() edge in a TypeScript file keeps its importer in the delta', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-require-')));
    const files = ['src/a.ts', 'src/b.ts'];
    const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    const analyzer = new TypeScriptSemanticProjectAnalyzer(4, undefined, 0, {
        stateDirectory: fs.mkdtempSync(path.join(root, 'state-')),
    });
    try {
        write('tsconfig.json', JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src'] }));
        write('src/a.ts', 'export const a = 1;\n');
        write(
            'src/b.ts',
            'declare const require: (id: string) => { a: number };\nexport const b = require("./a").a;\n',
        );
        const before = registryFor(root, files);

        await analyzer.analyze({ rootPath: root, language: 'typescript', registry: before });
        write('src/a.ts', 'export const a = 2;\n');
        const after = registryFor(root, files);
        const delta = await analyzer.analyze({
            rootPath: root,
            language: 'typescript',
            registry: after,
            previousRegistry: before,
            changedFiles: new Set(['src/a.ts']),
        });
        assert.deepEqual([...(delta.affectedSourceFiles ?? [])].sort(), ['src/a.ts', 'src/b.ts']);
    } finally {
        await analyzer.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an unreadable tsconfig only drops its own project instead of failing the analysis', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-broken-config-')));
    const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    const warn = mock.method(console, 'warn', () => undefined);
    const analyzer = new TypeScriptSemanticProjectAnalyzer(4);
    try {
        write('tsconfig.json', JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src'] }));
        write('src/a.ts', 'export const a = 1;\n');
        write('broken/tsconfig.json', '{ "compilerOptions": { ');
        write('broken/b.ts', 'export const b = 2;\n');
        write('broken/c.ts', 'export const c = 3;\n');
        const registry = registryFor(root, ['src/a.ts', 'broken/b.ts', 'broken/c.ts']);

        const broken = await analyzer.analyze({ rootPath: root, language: 'typescript', registry });
        assert.equal(broken.coverage?.analyzedSourceFileCount, 3);
        const warnings = warn.mock.calls.filter((call) => String(call.arguments[0]).includes('broken/tsconfig.json'));
        assert.equal(warnings.length, 1, 'the unreadable config is reported once, not once per file');

        write('broken/tsconfig.json', JSON.stringify({ compilerOptions: COMPILER_OPTIONS }));
        const fixed = await analyzer.analyze({ rootPath: root, language: 'typescript', registry });
        assert.notEqual(fixed.environmentConfigId, broken.environmentConfigId);
    } finally {
        warn.mock.restore();
        await analyzer.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

const REFERENCE_CACHE_FILE_SUFFIX = '.reference-declarations.json';

function referenceCachePath(stateDirectory: string): string {
    const names = fs.readdirSync(stateDirectory).filter((name) => name.endsWith(REFERENCE_CACHE_FILE_SUFFIX));
    assert.equal(names.length, 1, 'one reference-declaration cache per root');
    return path.join(stateDirectory, names[0]);
}

function backdateCache(stateDirectory: string): Date {
    const cachePath = referenceCachePath(stateDirectory);
    const backdated = new Date('2001-01-01T00:00:00.000Z');
    fs.utimesSync(cachePath, backdated, backdated);
    return backdated;
}

function assertCacheWasRewritten(stateDirectory: string): void {
    const cachePath = referenceCachePath(stateDirectory);
    assert.ok(
        fs.statSync(cachePath).mtimeMs > Date.now() - 86_400_000,
        'a changed witness must rewrite the reference-declaration cache',
    );
}

function assertCacheWasReused(stateDirectory: string, backdated: Date): void {
    const cachePath = referenceCachePath(stateDirectory);
    assert.equal(
        fs.statSync(cachePath).mtimeMs,
        backdated.getTime(),
        'a reusable declaration proof must not rewrite the reference-declaration cache',
    );
}

const DECLARED_COMPILER_OPTIONS = { ...COMPILER_OPTIONS, declaration: true, noLib: true, outDir: 'dist' };

const CONSUMER_FILES = ['app/src/main.ts'];

type WriteFile = (file: string, text: string) => void;

function writerFor(root: string): WriteFile {
    return (file, text) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
}

// A declaration proof only exists for a referenced project, so every
// reference-cache test needs a consumer whose config references a library.
function writeReferencedFixture(write: WriteFile): void {
    write('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    write('lib/tsconfig.json', JSON.stringify({ compilerOptions: DECLARED_COMPILER_OPTIONS, include: ['src'] }));
    write('lib/src/math.ts', 'export function add(a: number, b: number): number {\n    return a + b;\n}\n');
    write('lib/src/index.ts', 'export { add } from "./math";\nexport const version = "1.0.0";\n');
    write(
        'app/tsconfig.json',
        JSON.stringify({
            compilerOptions: DECLARED_COMPILER_OPTIONS,
            include: ['src'],
            references: [{ path: '../lib' }],
        }),
    );
    write('app/src/main.ts', 'import { add } from "../../lib/src/index";\nexport const total = add(1, 2);\n');
}

function emitDeclarations(write: WriteFile): void {
    write('lib/dist/src/index.d.ts', 'export { add } from "./math";\nexport declare const version = "1.0.0";\n');
    write('lib/dist/src/math.d.ts', 'export declare function add(a: number, b: number): number;\n');
}

function consumerRegistry(root: string) {
    return registryFor(root, CONSUMER_FILES);
}

async function analyzeWith(root: string, stateDirectory: string, budget?: TypeScriptSemanticResourceBudget) {
    const analyzer = new TypeScriptSemanticProjectAnalyzer(4, budget, 0, { stateDirectory });
    try {
        return await analyzer.analyze({ rootPath: root, language: 'typescript', registry: consumerRegistry(root) });
    } finally {
        await analyzer.dispose();
    }
}

async function controlsWith(
    root: string,
    stateDirectory: string,
    budget?: TypeScriptSemanticResourceBudget,
): Promise<readonly string[]> {
    const analyzer = new TypeScriptSemanticProjectAnalyzer(4, budget, 0, { stateDirectory });
    try {
        return await analyzer.getSourceControlFiles({
            rootPath: root,
            language: 'typescript',
            sourceFiles: CONSUMER_FILES,
        });
    } finally {
        await analyzer.dispose();
    }
}

function stateDirectoryUnder(root: string, name: string): string {
    return fs.mkdtempSync(path.join(root, `${name}-`));
}

test('a source edit reuses the persisted declaration proof without changing evidence', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-cache-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        emitDeclarations(write);
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const first = await analyzeWith(root, stateDirectory);
        const backdated = backdateCache(stateDirectory);

        // An eligible edit changes source contents only: the config chain,
        // membership and filesystem observation of the proof stay valid.
        write('app/src/main.ts', 'import { add } from "../../lib/src/index";\nexport const total = add(2, 3);\n');
        const reused = await analyzeWith(root, stateDirectory);
        assertCacheWasReused(stateDirectory, backdated);

        const fresh = await analyzeWith(root, stateDirectoryUnder(root, 'fresh'));
        assert.deepEqual(reused, fresh, 'the reused declaration proof must match a fresh proof');
        assert.deepEqual(reused.affectedSourceFiles ?? [], first.affectedSourceFiles ?? []);
        assert.deepEqual(
            await controlsWith(root, stateDirectory),
            await controlsWith(root, stateDirectoryUnder(root, 'fresh-controls')),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the persisted declaration proof invalidates when its witness changes', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-witness-')));
    const scenarios: readonly {
        readonly name: string;
        readonly identity: boolean;
        readonly mutate: (root: string, write: WriteFile) => void;
    }[] = [
        {
            name: 'a referenced tsconfig edit',
            identity: true,
            mutate: (_root, write) =>
                write(
                    'lib/tsconfig.json',
                    JSON.stringify({
                        compilerOptions: { ...DECLARED_COMPILER_OPTIONS, target: 'ES2021' },
                        include: ['src'],
                    }),
                ),
        },
        {
            name: 'an added referenced source file',
            identity: false,
            mutate: (_root, write) => write('lib/src/added.ts', 'export const added = 2;\n'),
        },
        {
            name: 'a deleted referenced source file',
            identity: false,
            mutate: (root) => fs.rmSync(path.join(root, 'lib/src/index.ts')),
        },
    ];
    try {
        for (const [index, scenario] of scenarios.entries()) {
            const root = path.join(base, `case-${index}`);
            fs.mkdirSync(root, { recursive: true });
            const write = writerFor(root);
            writeReferencedFixture(write);
            emitDeclarations(write);
            const stateDirectory = stateDirectoryUnder(root, 'cache');
            const first = await analyzeWith(root, stateDirectory);
            scenario.mutate(root, write);
            backdateCache(stateDirectory);

            const cached = await analyzeWith(root, stateDirectory);
            assertCacheWasRewritten(stateDirectory);
            if (scenario.identity) {
                assert.notEqual(
                    cached.environmentConfigId,
                    first.environmentConfigId,
                    `${scenario.name} changes the environment identity`,
                );
            }
            const fresh = await analyzeWith(root, stateDirectoryUnder(root, 'fresh'));
            assert.deepEqual(cached, fresh, `${scenario.name} must match a fresh proof`);
        }
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('the persisted declaration proof invalidates when an extended config outside the root changes', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-extends-')));
    const write = writerFor(base);
    try {
        write('tsconfig.base.json', JSON.stringify({ compilerOptions: DECLARED_COMPILER_OPTIONS }));
        write('lib/tsconfig.json', JSON.stringify({ extends: '../tsconfig.base.json', include: ['src'] }));
        write('lib/src/math.ts', 'export function add(a: number, b: number): number {\n    return a + b;\n}\n');
        write('lib/src/index.ts', 'export { add } from "./math";\nexport const version = "1.0.0";\n');
        write(
            'app/tsconfig.json',
            JSON.stringify({
                extends: '../tsconfig.base.json',
                include: ['src'],
                references: [{ path: '../lib' }],
            }),
        );
        write('app/src/main.ts', 'import { add } from "../../lib/src/index";\nexport const total = add(1, 2);\n');
        emitDeclarations(write);

        const root = base;
        const stateDirectory = stateDirectoryUnder(base, 'cache');
        const first = await analyzeWith(root, stateDirectory);
        backdateCache(stateDirectory);

        write('tsconfig.base.json', JSON.stringify({ compilerOptions: { ...DECLARED_COMPILER_OPTIONS, target: 'ES2021' } }));
        const cached = await analyzeWith(root, stateDirectory);
        assertCacheWasRewritten(stateDirectory);
        assert.notEqual(cached.environmentConfigId, first.environmentConfigId);
        assert.deepEqual(cached, await analyzeWith(root, stateDirectoryUnder(base, 'fresh')));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('a nested reference that appears after warming matches fresh discovery', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-nested-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        // `lib` points at a config that does not resolve yet, so its saved
        // proof starts with no references.
        write('lib/tsconfig.json', JSON.stringify({
            compilerOptions: DECLARED_COMPILER_OPTIONS,
            include: ['src'],
            references: [{ path: '../base' }],
        }));
        emitDeclarations(write);
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const first = await controlsWith(root, stateDirectory);

        write('base/tsconfig.json', JSON.stringify({ compilerOptions: DECLARED_COMPILER_OPTIONS, include: ['src'] }));
        write('base/src/base.ts', 'export const base = 1;\n');
        write('base/dist/src/base.d.ts', 'export declare const base = 1;\n');

        const cached = await controlsWith(root, stateDirectory);
        assert.notDeepEqual(cached, first, 'the new reference adds its config and output controls');
        assert.deepEqual(cached, await controlsWith(root, stateDirectoryUnder(root, 'fresh')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the persisted declaration proof reuses while package controls still change identity', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-package-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        emitDeclarations(write);
        // Lockfiles are consumer controls, not inputs of the declaration
        // program: they change the environment identity without invalidating
        // the reference proof.
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const first = await analyzeWith(root, stateDirectory);
        const backdated = backdateCache(stateDirectory);

        write('pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
        const reused = await analyzeWith(root, stateDirectory);
        assertCacheWasReused(stateDirectory, backdated);
        assert.notEqual(reused.environmentConfigId, first.environmentConfigId);
        assert.deepEqual(reused, await analyzeWith(root, stateDirectoryUnder(root, 'fresh')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('discovery builds the declaration program on a cold cache and skips it on an eligible hit', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-spawn-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        emitDeclarations(write);
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const original = childProcess.spawn;
        const spawn = t.mock.method(childProcess, 'spawn', original);
        syncBuiltinESMExports();
        try {
            await controlsWith(root, stateDirectory);
            const cold = spawn.mock.callCount();
            await controlsWith(root, stateDirectory);
            const warm = spawn.mock.callCount() - cold;
            await controlsWith(root, stateDirectoryUnder(root, 'fresh'));
            const fresh = spawn.mock.callCount() - cold - warm;

            assert.equal(cold, 3, 'a cold discovery parses both configs and builds the declaration program');
            assert.equal(warm, 2, 'an eligible hit parses the configs and skips the declaration program');
            assert.equal(fresh, 3, 'a fresh state directory builds the declaration program again');
        } finally {
            spawn.mock.restore();
            syncBuiltinESMExports();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a source edit that adds an oversized dependency is not hidden by a saved proof', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-oversized-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        emitDeclarations(write);
        // Outside `include`, so it stays out of the root file list until an
        // edit imports it. A fresh computation then reads it and the source
        // budget rejects its size.
        write('lib/oversized/extra.ts', `export const extra = 1;\n${'// filler\n'.repeat(200)}`);
        const budget = { maxFileBytes: 1024, maxProjectBytes: 64 * 1024 };
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const before = await controlsWith(root, stateDirectory, budget);

        write(
            'lib/src/math.ts',
            'import { extra } from "../oversized/extra";\nexport function add(a: number, b: number): number {\n    return a + b + extra;\n}\n',
        );

        const original = childProcess.spawn;
        const spawn = t.mock.method(childProcess, 'spawn', original);
        syncBuiltinESMExports();
        try {
            const cached = await controlsWith(root, stateDirectory, budget);
            assert.ok(spawn.mock.callCount() > 2, 'a changed read must rebuild the declaration program');
            assert.notDeepEqual(cached, before, 'the unproven reference drops its declaration controls');
            assert.deepEqual(
                cached,
                await controlsWith(root, stateDirectoryUnder(root, 'fresh'), budget),
                'the saved proof must not outlive a resource failure a fresh computation reports',
            );
        } finally {
            spawn.mock.restore();
            syncBuiltinESMExports();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a deleted emitted declaration changes the consumer environment identity', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-deleted-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        emitDeclarations(write);
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const first = await analyzeWith(root, stateDirectory);

        fs.rmSync(path.join(root, 'lib/dist/src/index.d.ts'));
        const after = await analyzeWith(root, stateDirectory);
        assert.notEqual(after.environmentConfigId, first.environmentConfigId);
        assert.deepEqual(after, await analyzeWith(root, stateDirectoryUnder(root, 'fresh')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an edited emitted declaration changes the consumer environment identity', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-edited-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        emitDeclarations(write);
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const first = await analyzeWith(root, stateDirectory);

        write('lib/dist/src/math.d.ts', 'export declare function add(a: number, b: number, c?: number): number;\n');
        const after = await analyzeWith(root, stateDirectory);
        assert.notEqual(after.environmentConfigId, first.environmentConfigId);
        assert.deepEqual(after, await analyzeWith(root, stateDirectoryUnder(root, 'fresh')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sharded discovery reuses the shared declaration proof and matches the unsharded oracle', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-shards-')));
    const write = writerFor(root);
    try {
        writeReferencedFixture(write);
        emitDeclarations(write);
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        const analyzeSharded = async (shardCount: number) => {
            const analyzers = Array.from(
                { length: shardCount },
                (_, index) =>
                    new TypeScriptSemanticProjectAnalyzer(4, undefined, 0, {
                        stateDirectory,
                        ...(shardCount > 1 ? { shard: { index, count: shardCount } } : {}),
                    }),
            );
            try {
                return mergeTypeScriptShardEvidence(
                    await Promise.all(
                        analyzers.map((analyzer) =>
                            analyzer.analyzeShard({
                                rootPath: root,
                                language: 'typescript',
                                registry: consumerRegistry(root),
                            }),
                        ),
                    ),
                );
            } finally {
                await Promise.all(analyzers.map((analyzer) => analyzer.dispose()));
            }
        };

        const unsharded = await analyzeSharded(1);
        const backdated = backdateCache(stateDirectory);
        const sharded = await analyzeSharded(2);
        assertCacheWasReused(stateDirectory, backdated);
        assert.deepEqual(sharded, unsharded);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference metadata is read once per discovery, not once per referenced project', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-once-')));
    const write = writerFor(root);
    try {
        write('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
        for (const name of ['lib-a', 'lib-b']) {
            write(`${name}/tsconfig.json`, JSON.stringify({ compilerOptions: DECLARED_COMPILER_OPTIONS, include: ['src'] }));
            write(`${name}/src/index.ts`, `export const ${name.replace('-', '')} = 1;\n`);
        }
        write(
            'app/tsconfig.json',
            JSON.stringify({
                compilerOptions: DECLARED_COMPILER_OPTIONS,
                include: ['src'],
                references: [{ path: '../lib-a' }, { path: '../lib-b' }],
            }),
        );
        write(
            'app/src/main.ts',
            'import { liba } from "../../lib-a/src/index";\nimport { libb } from "../../lib-b/src/index";\nexport const total = liba + libb;\n',
        );
        const stateDirectory = stateDirectoryUnder(root, 'cache');
        await controlsWith(root, stateDirectory);

        const original = fs.openSync;
        const open = t.mock.method(fs, 'openSync', original);
        try {
            await controlsWith(root, stateDirectory);
            const reads = open.mock.calls.filter((call) =>
                String(call.arguments[0]).endsWith(REFERENCE_CACHE_FILE_SUFFIX),
            );
            assert.equal(reads.length, 1, 'one reference metadata read per discovery');
        } finally {
            open.mock.restore();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
