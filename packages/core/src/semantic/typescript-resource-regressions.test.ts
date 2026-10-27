import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as ts from './typescript-api';
import { TypeScriptProgramSession } from './typescript-program-session';
import { TypeScriptSourceBudgetTracker, loadTypeScriptConfiguredProject } from './typescript-configured-project';
import { TypeScriptReferenceDeclarationCache } from './typescript-reference-cache';
import { referenceAuthorityReady, TypeScriptSemanticProjectAnalyzer } from '../relationships/typescript-semantic-analyzer';
import { buildSymbolRegistry, SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols';
import { analyzeTypeScriptProgram } from './typescript-compiler-provider';

function fixture(t: { after(fn: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-resource-regression-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function write(root: string, file: string, text: string): string {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
    return absolute;
}

function registry(root: string, files: string[]) {
    return buildSymbolRegistry({ manifest: {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: root, rootFingerprint: 'test', indexPolicyHash: 'test',
        languageRouterVersion: 'test', extractorVersion: 'test', relationshipVersion: 'test',
        builtAt: '2026-10-25T00:00:00.000Z',
        files: files.map(file => ({ path: file,
            hash: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
            language: 'typescript', symbolCount: 0, definitionStatus: 'definitions_present' as const,
        })),
    }, symbols: [] });
}

test('warm snapshots charge only active JSON and TypeScript sources, matching cold snapshots', t => {
    const root = fixture(t);
    for (const extension of ['json', 'ts']) {
        const source = (name: string) => `import data from './${name}.${extension}'; function use(value: unknown) {} use(data);`;
        const main = write(root, 'main.ts', source('a'));
        for (const name of ['a', 'b', 'c', 'd']) {
            write(root, `${name}.${extension}`, extension === 'json'
                ? JSON.stringify({ value: 'x'.repeat(290) })
                : `export default '${'x'.repeat(290)}';`);
        }
        const options = { noEmit: true, noLib: true, types: [], resolveJsonModule: true,
            allowImportingTsExtensions: true,
            module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
        const budget = { maxFileBytes: 2000, maxProjectBytes: 800 };
        for (const mode of ['override', 'disk']) {
            const tracker = new TypeScriptSourceBudgetTracker(budget);
            const session = new TypeScriptProgramSession(root, [main], options, tracker);
            try {
                for (const name of ['a', 'b', 'c', 'd']) {
                    write(root, 'main.ts', source(name));
                    if (mode === 'override') session.updateFile(main, source(name));
                    else session.invalidateFile(main);
                    const warm = session.getProgram();
                    const warmFiles = [...warm.getSourceFileNames()].sort();
                    assert.equal(session.getResourceLimitFailure(), undefined, `${extension}/${mode}/${name}`);
                    if (extension === 'json') {
                        const reads = (session as unknown as { jsonReadBytes: Map<string, number> }).jsonReadBytes;
                        for (const old of ['a', 'b', 'c', 'd'].filter(candidate => candidate !== name)) {
                            assert.equal(reads.has(path.join(root, `${old}.json`)), false);
                        }
                    }
                    const cold = new TypeScriptProgramSession(root, [main], options, new TypeScriptSourceBudgetTracker(budget));
                    try {
                        const coldProgram = cold.getProgram();
                        assert.deepEqual(warmFiles, [...coldProgram.getSourceFileNames()].sort());
                        assert.equal(cold.getResourceLimitFailure(), undefined);
                        const evidence = (program: ts.Program) => analyzeTypeScriptProgram(program,
                            [{ projectPath: 'main.ts', sourceFile: program.getSourceFile(main)! }]).occurrencesByFile;
                        const warmEvidence = evidence(warm);
                        assert.ok(warmEvidence.get('main.ts')?.some(call => call.decision === 'resolved'));
                        assert.deepEqual(warmEvidence, evidence(coldProgram));
                    } finally { cold.dispose(); }
                }
            } finally { session.dispose(); }
        }
    }
});

test('disk-backed analyzer sessions retain no source overrides on full or incremental analysis', async t => {
    const root = fixture(t);
    write(root, 'main.ts', 'export function value() { return 1; }');
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { noLib: true, types: [] }, files: ['main.ts'] }));
    const analyzer = new TypeScriptSemanticProjectAnalyzer();
    try {
        const before = registry(root, ['main.ts']);
        assert.equal((await analyzer.analyze({ rootPath: root, language: 'typescript', registry: before })).coverage?.status, 'complete');
        write(root, 'main.ts', 'export function value() { return 2; }');
        assert.equal((await analyzer.analyze({ rootPath: root, language: 'typescript', registry: registry(root, ['main.ts']),
            previousRegistry: before, changedFiles: new Set(['main.ts']) })).coverage?.status, 'complete');
        const internals = analyzer as unknown as { sessions: Map<string, { session: { session: { overrides: Map<string, string> } } }> };
        assert.equal(internals.sessions.size, 1);
        for (const cached of internals.sessions.values()) assert.equal(cached.session.session.overrides.size, 0);
    } finally { await analyzer.dispose(); }
});

test('snapshot refresh still charges unchanged cached sources', t => {
    const root = fixture(t);
    const main = write(root, 'main.ts', "import data from './data.json'; export const value = data;");
    write(root, 'data.json', JSON.stringify({ value: 'x'.repeat(290) }));
    const session = new TypeScriptProgramSession(root, [main], {
        noEmit: true, noLib: true, types: [], resolveJsonModule: true,
        module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }, new TypeScriptSourceBudgetTracker({ maxFileBytes: 1024, maxProjectBytes: 500 }));
    try {
        session.getProgram();
        assert.equal(session.getResourceLimitFailure(), undefined);
        session.updateFile(main, "import data from './data.json'; export const value = data;" + `/*${'x'.repeat(250)}*/`);
        session.getProgram();
        assert.match(session.getResourceLimitFailure() ?? '', /project budget/);
    } finally { session.dispose(); }
});

test('returning native-cached imports cannot bypass the project budget', t => {
    const root = fixture(t);
    for (const extension of ['json', 'ts']) {
        const source = (names: string[]) => names.map(name => `import ${name} from './${name}.${extension}';`).join('\n')
            + `\nexport const value = [${names.join(',')}];`;
        const main = write(root, 'main.ts', source(['a']));
        for (const name of ['a', 'b']) write(root, `${name}.${extension}`, extension === 'json'
            ? JSON.stringify({ value: 'x'.repeat(290) }) : `export default '${'x'.repeat(290)}';`);
        const options = { noEmit: true, noLib: true, types: [], resolveJsonModule: true,
            allowImportingTsExtensions: true,
            module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
        const budget = { maxFileBytes: 2000, maxProjectBytes: 600 };
        const warm = new TypeScriptProgramSession(root, [main], options, new TypeScriptSourceBudgetTracker(budget));
        try {
            for (const names of [['a'], ['b']]) {
                warm.updateFile(main, source(names));
                warm.getProgram();
                assert.equal(warm.getResourceLimitFailure(), undefined);
            }
            write(root, 'main.ts', source(['a', 'b']));
            warm.updateFile(main, source(['a', 'b']));
            warm.getProgram();
            const cold = new TypeScriptProgramSession(root, [main], options, new TypeScriptSourceBudgetTracker(budget));
            try {
                cold.getProgram();
                assert.match(cold.getResourceLimitFailure() ?? '', /project budget/);
                assert.match(warm.getResourceLimitFailure() ?? '', /project budget/);
            } finally { cold.dispose(); }
        } finally { warm.dispose(); }
    }
});

test('native source reads stay bounded when a file grows after stat', t => {
    const root = fixture(t);
    const main = write(root, 'main.ts', `export const value = '${'x'.repeat(4096)}';`);
    const originalStat = fs.statSync;
    const originalFstat = fs.fstatSync;
    t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
        const stat = originalStat(...args);
        return args[0] === main ? Object.assign(stat!, { size: 1 }) : stat;
    });
    t.mock.method(fs, 'fstatSync', (fd: number) => Object.assign(originalFstat(fd), { size: 1 }));
    const session = new TypeScriptProgramSession(root, [main], { noEmit: true, noLib: true, types: [] },
        new TypeScriptSourceBudgetTracker({ maxFileBytes: 1024, maxProjectBytes: 8192 }));
    try {
        const program = session.getProgram();
        assert.match(session.getResourceLimitFailure() ?? '', /per-file budget/);
        assert.equal(program.getSourceFileNames().some(file => file === main), false);
    } finally { session.dispose(); }
});

test('referenced configs and declaration programs obey config and source budgets', async t => {
    const root = fixture(t);
    const options = { composite: true, declaration: true, noLib: true, types: [], outDir: 'dist' };
    const lib = write(root, 'lib/tsconfig.json', JSON.stringify({ compilerOptions: options, files: ['main.ts'] }));
    const app = write(root, 'app/tsconfig.json', JSON.stringify({ compilerOptions: options, files: ['main.ts'], references: [{ path: '../lib' }] }));
    write(root, 'app/main.ts', 'export const value = 1;');
    write(root, 'lib/main.ts', 'export const value = 1;');
    write(root, 'lib/dist/main.d.ts', 'export declare const value = 1;');
    assert.equal(referenceAuthorityReady(app), true);
    fs.appendFileSync(lib, `\n/*${'x'.repeat(1024 * 1024)}*/`);
    assert.throws(() => loadTypeScriptConfiguredProject(lib), /byte budget/);
    assert.equal(referenceAuthorityReady(app), undefined);
    const configAnalyzer = new TypeScriptSemanticProjectAnalyzer();
    try {
        const rejected = await configAnalyzer.analyze({ rootPath: root, language: 'typescript', registry: registry(root, ['app/main.ts']) });
        assert.equal(rejected.coverage?.failureReason, 'resource_limit');
    } finally { await configAnalyzer.dispose(); }
    write(root, 'lib/tsconfig.json', JSON.stringify({ compilerOptions: options, files: ['main.ts'] }));
    write(root, 'lib/main.ts', `export const value = 1;\n/*${'x'.repeat(2048)}*/`);
    const analyzer = new TypeScriptSemanticProjectAnalyzer(4, { maxFileBytes: 1024, maxProjectBytes: 8192 });
    try {
        const result = await analyzer.analyze({ rootPath: root, language: 'typescript', registry: registry(root, ['app/main.ts']) });
        assert.equal(result.coverage?.failureReason, 'resource_limit');
        assert.match(result.coverage?.failureMessage ?? '', /lib\/main.ts/);
    } finally { await analyzer.dispose(); }
});

test('warm reference proofs parse each config once and preserve declaration output decisions', t => {
    const root = fixture(t);
    const options = { composite: true, declaration: true, noLib: true, types: [], outDir: 'dist' };
    const app = write(root, 'app/tsconfig.json', JSON.stringify({ compilerOptions: options, files: ['main.ts'], references: [{ path: '../lib' }] }));
    write(root, 'app/main.ts', 'export const value = 1;');
    write(root, 'lib/tsconfig.json', JSON.stringify({ compilerOptions: options, files: ['main.ts'] }));
    write(root, 'lib/main.ts', 'export const value = 1;');
    const output = write(root, 'lib/dist/main.d.ts', 'export declare const value = 1;');
    const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
        resourceBudget: {
            maxFileBytes: 4 * 1024 * 1024,
            maxProjectBytes: 64 * 1024 * 1024,
        },
    });
    assert.equal(referenceAuthorityReady(app, cache), referenceAuthorityReady(app));
    const original = childProcess.spawn;
    const spawn = t.mock.method(childProcess, 'spawn', original);
    syncBuiltinESMExports();
    try {
        assert.equal(referenceAuthorityReady(app, cache), true);
        assert.equal(spawn.mock.callCount(), 2);
        assert.equal(cache.size, 1);
        fs.unlinkSync(output);
        assert.equal(referenceAuthorityReady(app, cache), undefined);
    } finally {
        spawn.mock.restore();
        syncBuiltinESMExports();
    }
});
