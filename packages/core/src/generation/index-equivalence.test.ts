import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Context } from '../core/context';
import { IndexingPipeline } from '../core/indexing-pipeline';
import { Embedding, EMBEDDING_NORMALIZATION_POLICY_VERSION } from '../embedding';
import { LazyTypeScriptSemanticProjectAnalyzer } from '../relationships/lazy-typescript-semantic-analyzer';
import { TypeScriptSemanticProjectAnalyzer } from '../relationships/typescript-semantic-analyzer';
import { readRelationshipSidecar, readSymbolRegistrySidecar } from '../symbols';
import { LanceDbVectorDatabase } from '../vectordb/lancedb-vectordb';

/**
 * Equivalence harness for changes that promise unchanged results. Each fixture
 * is indexed under every execution toggle and everything published (chunk
 * rows, embedded texts, symbols, relationships, resolution claims, coverage)
 * must be identical; a sync after scripted edits must publish the same state
 * as a full index of the edited tree.
 */

/** Vectors are a pure function of the embedded text, which is recorded. */
class RecordingEmbedding extends Embedding {
    protected maxTokens = 8192;
    readonly embeddedTexts: string[] = [];
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
    async embedQuery(text: string) {
        const digest = crypto.createHash('sha256').update(text).digest();
        return { vector: [0, 1, 2, 3].map((index) => digest[index] / 255 + 0.01), dimension: 4 };
    }
    async embedDocuments(texts: string[]) {
        this.embeddedTexts.push(...texts);
        return Promise.all(texts.map((text) => this.embedQuery(text)));
    }
}

type Files = Readonly<Record<string, string>>;

type ToggleSetting = Readonly<{
    env: Readonly<Record<'SATORI_ANALYSIS_WORKERS', string>>;
    /**
     * The execution order before the payload overlap and the resolution worker:
     * the file loop returns only after embedding and vector writes settle, and
     * TypeScript resolution runs in-process. Installed by prototype patches.
     */
    serialInProcess?: true;
}>;

/** In-process, serial execution is the baseline; every other setting must publish the same. */
const BASELINE: ToggleSetting = { env: { SATORI_ANALYSIS_WORKERS: '0' }, serialInProcess: true };
const SETTINGS: readonly ToggleSetting[] = [
    BASELINE,
    { env: { SATORI_ANALYSIS_WORKERS: '0' } },
    { env: { SATORI_ANALYSIS_WORKERS: '2' } },
];

async function withSetting<T>(setting: ToggleSetting, run: () => Promise<T>): Promise<T> {
    if (!setting.serialInProcess) return withEnv(setting.env, run);
    const pipeline = IndexingPipeline.prototype;
    const originalProcessFileList = pipeline.processFileList;
    pipeline.processFileList = async function (...args) {
        const processed = await originalProcessFileList.apply(this, args);
        await processed.payloadSettled;
        return processed;
    };
    const lazy = LazyTypeScriptSemanticProjectAnalyzer.prototype as unknown as {
        loadAnalyzer(this: { analyzerPromise?: Promise<unknown>; maxSessions: number; stateDirectory?: string }): Promise<unknown>;
    };
    const originalLoadAnalyzer = lazy.loadAnalyzer;
    lazy.loadAnalyzer = function () {
        // One unsharded analyzer: the worker path shards projects across threads.
        this.analyzerPromise ??= Promise.resolve(new TypeScriptSemanticProjectAnalyzer(
            this.maxSessions,
            undefined,
            undefined,
            { stateDirectory: this.stateDirectory },
        ));
        return this.analyzerPromise;
    };
    try {
        return await withEnv(setting.env, run);
    } finally {
        pipeline.processFileList = originalProcessFileList;
        lazy.loadAnalyzer = originalLoadAnalyzer;
    }
}

function writeTree(root: string, files: Files): void {
    for (const [relativePath, source] of Object.entries(files)) {
        const absolutePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, source);
    }
}

async function withEnv<T>(values: Readonly<Record<string, string>>, run: () => Promise<T>): Promise<T> {
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    Object.assign(process.env, values);
    try {
        return await run();
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

function stableJson(value: unknown): unknown {
    if (value instanceof Map) {
        return [...value.entries()]
            .map(([key, entry]) => [stableJson(key), stableJson(entry)])
            .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
    }
    if (value instanceof Set) return [...value].map(stableJson).sort();
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, stableJson(entry)]));
    }
    return value;
}

/** Everything a publication exposes, with run-specific identities replaced. */
async function snapshotPublication(context: Context, database: LanceDbVectorDatabase, root: string) {
    const current = context.getCurrentPublication(root);
    assert.ok(current, 'expected a publication');
    const navigation = context.getPublicationNavigationAddress(current);
    assert.ok(navigation);
    const registry = await readSymbolRegistrySidecar({ normalizedRootPath: root, ...navigation });
    assert.equal(registry.status, 'ok');
    const relationships = await readRelationshipSidecar({ normalizedRootPath: root, ...navigation });
    assert.equal(relationships.status, 'ok');
    if (registry.status !== 'ok' || relationships.status !== 'ok') throw new Error('missing navigation sidecars');
    const rows = await database.queryDocuments(current.publication.vector.collectionName, {
        fields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
    });
    const snapshot = JSON.stringify(stableJson({
        totalChunks: current.publication.vector.totalChunks,
        rows,
        symbols: registry.registry.symbols,
        symbolManifest: registry.registry.manifest,
        relationshipManifest: relationships.manifest,
        relationships: relationships.records,
        analysisByFile: relationships.analysisByFile,
    }), null, 1);
    const volatile = [
        current.publication.vector.collectionName,
        ...Object.values(navigation).filter((value): value is string => typeof value === 'string'),
        root,
    ];
    let normalized = snapshot;
    for (const value of volatile.sort((left, right) => right.length - left.length)) {
        normalized = normalized.split(value).join('<volatile>');
    }
    return normalized.replace(/"(\w*(?:At|Ms))": "?[^",\n]*"?/g, '"$1": "<time>"');
}

async function withContext<T>(
    tempRoot: string,
    run: (context: Context, database: LanceDbVectorDatabase, embedding: RecordingEmbedding) => Promise<T>,
    databasePath = fs.mkdtempSync(path.join(tempRoot, 'vectors-')),
): Promise<T> {
    const embedding = new RecordingEmbedding();
    const database = new LanceDbVectorDatabase({ databasePath });
    const context = new Context({ embedding, vectorDatabase: database });
    try {
        return await run(context, database, embedding);
    } finally {
        await context.dispose();
        await database.close();
    }
}

async function fullIndexSnapshot(tempRoot: string, root: string, setting: ToggleSetting) {
    return withSetting(setting, () => withContext(tempRoot, async (context, database, embedding) => {
        await context.indexCodebase(root);
        return {
            publication: await snapshotPublication(context, database, root),
            embeddedTexts: [...embedding.embeddedTexts].sort(),
        };
    }));
}

function describeSetting(setting: ToggleSetting): string {
    return [
        ...Object.entries(setting.env).map(([name, value]) => `${name}=${value}`),
        setting.serialInProcess ? 'serial in-process' : 'overlap + resolution worker',
    ].join(' ');
}

function firstDifference(expected: string, actual: string): string {
    const expectedLines = expected.split('\n');
    const actualLines = actual.split('\n');
    const index = expectedLines.findIndex((line, lineIndex) => line !== actualLines[lineIndex]);
    const at = index < 0 ? expectedLines.length : index;
    return `line ${at}: expected ${JSON.stringify(expectedLines[at])}, got ${JSON.stringify(actualLines[at])}`;
}

async function assertToggleEquivalence(name: string, files: Files): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `satori-equivalence-${name}-`));
    const root = path.join(tempRoot, 'repo');
    writeTree(root, files);
    try {
        const baseline = await fullIndexSnapshot(tempRoot, root, BASELINE);
        for (const setting of SETTINGS.slice(1)) {
            const candidate = await fullIndexSnapshot(tempRoot, root, setting);
            assert.ok(
                candidate.publication === baseline.publication,
                `${name}: publication differs with ${describeSetting(setting)}: ${firstDifference(baseline.publication, candidate.publication)}`,
            );
            assert.deepEqual(candidate.embeddedTexts, baseline.embeddedTexts, `${name}: embedded texts differ with ${describeSetting(setting)}`);
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

const POLYGLOT: Files = {
    'go.mod': 'module example.com/poly\n\ngo 1.22\n',
    'cmd/app/main.go': 'package main\n\nimport "example.com/poly/pkg/greet"\n\nfunc main() {\n\tgreet.Hello("world")\n}\n',
    'pkg/greet/greet.go': 'package greet\n\nimport "fmt"\n\nfunc Hello(name string) {\n\tfmt.Println(format(name))\n}\n\nfunc format(name string) string {\n\treturn "hello " + name\n}\n',
    'Cargo.toml': '[package]\nname = "poly"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/main.rs': 'mod util;\n\nfn main() {\n    let total = util::add(1, 2);\n    println!("{}", total);\n}\n',
    'src/util.rs': 'pub fn add(left: i32, right: i32) -> i32 {\n    double(left) + right\n}\n\nfn double(value: i32) -> i32 {\n    value * 2\n}\n',
    'py/app.py': 'from py.helpers import greet\n\n\ndef main():\n    return greet("x")\n',
    'py/helpers.py': 'def greet(name):\n    return shout(name)\n\n\ndef shout(name):\n    return name.upper()\n',
    'py/__init__.py': '',
};

const COMPOSITE = {
    composite: true,
    rootDir: 'src',
    outDir: 'dist',
    module: 'commonjs',
    target: 'ES2022',
    strict: true,
    types: [],
};

function tsMonorepo(builtProjects: readonly ('core' | 'lib')[]): Files {
    const files: Record<string, string> = {
        'packages/core/tsconfig.json': JSON.stringify({ compilerOptions: COMPOSITE, include: ['src'] }),
        'packages/core/src/core.ts': 'export function coreValue(): number {\n    return 1;\n}\n',
        'packages/lib/tsconfig.json': JSON.stringify({
            compilerOptions: COMPOSITE,
            include: ['src'],
            references: [{ path: '../core' }],
        }),
        'packages/lib/src/lib.ts': 'import { coreValue } from "../../core/src/core";\n\nexport function libValue(): number {\n    return coreValue() + 1;\n}\n',
        'packages/app/tsconfig.json': JSON.stringify({
            compilerOptions: COMPOSITE,
            include: ['src'],
            references: [{ path: '../lib' }],
        }),
        // Imports lib (a direct reference) and core (an indirect one).
        'packages/app/src/app.ts': 'import { libValue } from "../../lib/src/lib";\nimport { coreValue } from "../../core/src/core";\n\nexport function appValue(): number {\n    return libValue() + coreValue();\n}\n',
        'packages/app/src/dynamic.ts': 'declare const require: (id: string) => unknown;\n\nexport function load(): unknown {\n    return require("../../core/src/core");\n}\n',
        'scripts/load.js': 'const core = require("../packages/core/src/core");\n\nfunction run() {\n    return core.coreValue();\n}\n\nmodule.exports = { run };\n',
    };
    if (builtProjects.includes('core')) {
        files['packages/core/dist/core.d.ts'] = 'export declare function coreValue(): number;\n';
    }
    if (builtProjects.includes('lib')) {
        files['packages/lib/dist/lib.d.ts'] = 'export declare function libValue(): number;\n';
    }
    return files;
}

test('execution toggles publish identical results for Go, Rust, and Python', { timeout: 300_000 }, async () => {
    await assertToggleEquivalence('polyglot', POLYGLOT);
});

for (const [state, built] of [
    ['built', ['core', 'lib']],
    ['unbuilt', []],
    ['partly built', ['core']],
    ['indirect chain unbuilt', ['lib']],
] as const) {
    test(`execution toggles publish identical results for a TypeScript monorepo (${state})`, { timeout: 300_000 }, async () => {
        await assertToggleEquivalence(`ts-${state.replace(/\s+/g, '-')}`, tsMonorepo(built));
    });
}

type Edit = (root: string) => void;

const SCRIPTED_EDITS: ReadonlyArray<readonly [string, Edit]> = [
    ['add a file', (root) => writeTree(root, { 'py/extra.py': 'from py.helpers import shout\n\n\ndef extra():\n    return shout("e")\n' })],
    ['delete a file', (root) => fs.rmSync(path.join(root, 'scripts/load.js'))],
    ['rename a file', (root) => fs.renameSync(path.join(root, 'src/util.rs'), path.join(root, 'src/helpers.rs'))],
    ['retarget a cross-package import', (root) => writeTree(root, {
        'packages/app/src/app.ts': 'import { libValue } from "../../lib/src/lib";\n\nexport function appValue(): number {\n    return libValue() * 2;\n}\n',
    })],
    ['change a tsconfig', (root) => writeTree(root, {
        'packages/app/tsconfig.json': JSON.stringify({
            compilerOptions: { ...COMPOSITE, strict: false },
            include: ['src'],
            references: [{ path: '../lib' }, { path: '../core' }],
        }),
    })],
];

/**
 * TypeScript edits whose effect crosses a project boundary: through a project
 * reference, through a relative import without one, and through globals.
 */
function tsCrossProject(): Files {
    return {
        ...tsMonorepo(['core', 'lib']),
        // Imports another project's source without a project reference.
        'packages/tool/tsconfig.json': JSON.stringify({
            compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, types: [] },
            include: ['src'],
        }),
        'packages/tool/src/tool.ts': 'import { coreValue } from "../../core/src/core";\n\nexport function toolValue(): number {\n    return coreValue() * 3;\n}\n',
        // A script file: its declarations are global to the project.
        'packages/tool/src/globals.ts': 'function globalHelper(): number {\n    return 7;\n}\n',
        'packages/tool/src/use-global.ts': 'export function useGlobal(): number {\n    return globalHelper();\n}\n',
    };
}

const TS_CROSS_PROJECT_EDITS: ReadonlyArray<readonly [string, Edit]> = [
    ['edit a referenced project source while its output is built', (root) => writeTree(root, {
        'packages/lib/src/lib.ts': '// lib header\nimport { coreValue } from "../../core/src/core";\n\nexport function libValue(): number {\n    return coreValue() + 2;\n}\n',
    })],
    ['shift a symbol imported across projects without a reference', (root) => writeTree(root, {
        'packages/core/src/core.ts': '// moved\n// down\nexport function coreValue(): number {\n    return 1;\n}\n',
    })],
    ['rename a global', (root) => writeTree(root, {
        'packages/tool/src/globals.ts': 'function renamedHelper(): number {\n    return 7;\n}\n',
    })],
    ['rebuild a referenced output', (root) => writeTree(root, {
        'packages/lib/dist/lib.d.ts': 'export declare function libValue(): number;\nexport declare const libVersion: string;\n',
    })],
    ['remove a referenced output', (root) => fs.rmSync(path.join(root, 'packages/core/dist/core.d.ts'))],
    ['delete an imported file', (root) => fs.rmSync(path.join(root, 'packages/core/src/core.ts'))],
];

/**
 * Indexes `initial`, applies each edit, syncs, and requires the synced
 * publication to equal a full index of the edited tree. `cold` syncs through a
 * fresh Context each time, as the per-operation sync worker process does, so
 * nothing but persisted state carries over between syncs.
 */
async function assertSyncMatchesFullIndex(
    name: string,
    initial: Files,
    edits: ReadonlyArray<readonly [string, Edit]>,
    cold: boolean,
): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `satori-equivalence-sync-${name}-`));
    const root = path.join(tempRoot, 'repo');
    try {
        for (const setting of [BASELINE, SETTINGS[SETTINGS.length - 1]]) {
            writeTree(root, initial);
            const databasePath = fs.mkdtempSync(path.join(tempRoot, 'vectors-'));
            const open = <T>(run: (context: Context, database: LanceDbVectorDatabase) => Promise<T>) => (
                withContext(tempRoot, run, databasePath)
            );
            const assertMatchesFullIndex = async (description: string, synced: string) => {
                // Same path (identities hash absolute paths), separate state
                // root, so the full index does not replace the synced publication.
                const full = await withEnv(
                    { SATORI_STATE_ROOT: fs.mkdtempSync(path.join(tempRoot, 'full-state-')) },
                    () => withContext(tempRoot, async (fullContext, fullDatabase) => {
                        await fullContext.indexCodebase(root);
                        return snapshotPublication(fullContext, fullDatabase, root);
                    }),
                );
                if (process.env.EQUIVALENCE_DUMP && synced !== full) {
                    fs.writeFileSync(path.join(process.env.EQUIVALENCE_DUMP, 'synced.json'), synced);
                    fs.writeFileSync(path.join(process.env.EQUIVALENCE_DUMP, 'full.json'), full);
                }
                assert.ok(
                    synced === full,
                    `${cold ? 'cold' : 'warm'} sync after "${description}" with ${describeSetting(setting)} differs from a full index: ${firstDifference(full, synced)}`,
                );
            };
            await withSetting(setting, async () => {
                if (cold) {
                    await open((context) => context.indexCodebase(root));
                    for (const [description, edit] of edits) {
                        edit(root);
                        await assertMatchesFullIndex(description, await open(async (context, database) => {
                            await context.reindexByChange(root);
                            return snapshotPublication(context, database, root);
                        }));
                    }
                    return;
                }
                await open(async (context, database) => {
                    await context.indexCodebase(root);
                    for (const [description, edit] of edits) {
                        edit(root);
                        await context.reindexByChange(root);
                        await assertMatchesFullIndex(description, await snapshotPublication(context, database, root));
                    }
                });
            });
            fs.rmSync(root, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

for (const cold of [false, true]) {
    const mode = cold ? 'cold' : 'warm';
    test(`${mode} sync after scripted edits publishes the same state as a full index of the edited tree`, { timeout: 300_000 }, async () => {
        await assertSyncMatchesFullIndex(`scripted-${mode}`, { ...POLYGLOT, ...tsMonorepo(['lib']) }, SCRIPTED_EDITS, cold);
    });
    test(`${mode} sync after cross-project TypeScript edits publishes the same state as a full index`, { timeout: 300_000 }, async () => {
        await assertSyncMatchesFullIndex(`typescript-${mode}`, tsCrossProject(), TS_CROSS_PROJECT_EDITS, cold);
    });
}
