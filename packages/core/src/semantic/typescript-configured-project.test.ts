import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as ts from './typescript-api';

import {
    TypeScriptLanguageServiceSession,
    TypeScriptConfigReadError,
    loadTypeScriptConfiguredProject,
} from './typescript-configured-project';
import { referenceAuthorityReady } from '../relationships/typescript-semantic-analyzer';
import { TypeScriptProgramSession } from './typescript-program-session';

function write(fileName: string, content: string): void {
    fs.mkdirSync(path.dirname(fileName), { recursive: true });
    fs.writeFileSync(fileName, content);
}

function writeJson(fileName: string, value: unknown): void {
    write(fileName, `${JSON.stringify(value, null, 2)}\n`);
}

function definitionFile(
    session: TypeScriptLanguageServiceSession,
    fileName: string,
    source: string,
    needle: string,
): string | undefined {
    const position = source.indexOf(needle);
    assert.notEqual(position, -1, needle);
    return session.getDefinitionAtPosition(fileName, position)?.[0]?.fileName.replace(/\\/g, '/');
}

test('configured TypeScript project honors extends, paths, Node package resolution, TSX, exclusions, and config invalidation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-configured-'));
    try {
        const baseConfig = path.join(root, 'base.json');
        const config = path.join(root, 'tsconfig.json');
        const serviceA = path.join(root, 'src/service-a.ts');
        const serviceB = path.join(root, 'src/service-b.ts');
        const component = path.join(root, 'src/component.tsx');
        const main = path.join(root, 'src/main.ts');
        const excluded = path.join(root, 'src/excluded.ts');
        const packageTypes = path.join(root, 'node_modules/@fixture/pkg/index.d.ts');

        writeJson(baseConfig, {
            compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                strict: true,
                baseUrl: '.',
                paths: {
                    '@svc': ['src/service-a'],
                },
                jsx: 'preserve',
            },
        });
        writeJson(config, {
            extends: './base.json',
            include: ['src/**/*.ts', 'src/**/*.tsx'],
            exclude: ['src/excluded.ts'],
        });
        write(serviceA, 'export class Service { request(): "a" { return "a"; } }\n');
        write(serviceB, 'export class Service { request(): "b" { return "b"; } }\n');
        const componentSource = [
            "import { Service } from '@svc';",
            'export function componentRequest(): string {',
            '    return new Service().request();',
            '}',
            '',
        ].join('\n');
        write(component, componentSource);
        const mainSource = [
            "import { external } from '@fixture/pkg';",
            "export { componentRequest } from './component';",
            'export function packageRequest(): string {',
            '    return external();',
            '}',
            '',
        ].join('\n');
        write(main, mainSource);
        write(excluded, 'const shouldNotBeChecked: number = "excluded";\n');
        writeJson(path.join(root, 'node_modules/@fixture/pkg/package.json'), {
            name: '@fixture/pkg',
            version: '1.0.0',
            types: 'index.d.ts',
        });
        write(packageTypes, 'export declare function external(): string;\n');

        const parsed = loadTypeScriptConfiguredProject(config);
        assert.equal(parsed.errors.length, 0);
        assert.ok(parsed.fileNames.includes(component.replace(/\\/g, '/')));
        assert.ok(parsed.fileNames.includes(main.replace(/\\/g, '/')));
        assert.equal(parsed.fileNames.includes(excluded.replace(/\\/g, '/')), false);
        assert.equal(parsed.options.strict, true);

        const session = new TypeScriptLanguageServiceSession(config);
        try {
            assert.equal(session.getProgram().getSemanticDiagnostics().length, 0);
            assert.equal(
                definitionFile(session, component, componentSource, 'Service().request'),
                serviceA.replace(/\\/g, '/'),
            );
            assert.equal(
                definitionFile(session, main, mainSource, 'external()'),
                packageTypes.replace(/\\/g, '/'),
            );

            const beforeHash = session.identity.projectHash;
            writeJson(baseConfig, {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    strict: true,
                    baseUrl: '.',
                    paths: {
                        '@svc': ['src/service-b'],
                    },
                    jsx: 'preserve',
                },
            });
            assert.equal(session.refreshConfiguration(), true);
            assert.notEqual(session.identity.projectHash, beforeHash);
            assert.equal(
                definitionFile(session, component, componentSource, 'Service().request'),
                serviceB.replace(/\\/g, '/'),
            );
            assert.equal(session.refreshConfiguration(), false);
        } finally {
            session.dispose();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('configured TypeScript project records and resolves a representative project-reference boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-'));
    try {
        const libConfig = path.join(root, 'lib/tsconfig.json');
        const libSource = path.join(root, 'lib/src/index.ts');
        const appConfig = path.join(root, 'app/tsconfig.json');
        const appSource = path.join(root, 'app/src/main.ts');
        const excluded = path.join(root, 'app/src/excluded.ts');

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
        writeJson(libConfig, {
            compilerOptions: sharedCompilerOptions,
            include: ['src/**/*.ts'],
        });
        write(libSource, 'export class Shared { run(): string { return "shared"; } }\n');

        writeJson(appConfig, {
            compilerOptions: sharedCompilerOptions,
            references: [{ path: '../lib' }],
            include: ['src/**/*.ts'],
            exclude: ['src/excluded.ts'],
        });
        const appText = [
            "import { Shared } from '../../lib/src/index';",
            'export function useShared(): string {',
            '    return new Shared().run();',
            '}',
            '',
        ].join('\n');
        write(appSource, appText);
        write(excluded, 'const ignored: number = "excluded";\n');

        const unbuiltSession = new TypeScriptLanguageServiceSession(appConfig);
        try {
            assert.equal(unbuiltSession.projectReferences.length, 1);
            assert.equal(unbuiltSession.configuredFiles.includes(excluded.replace(/\\/g, '/')), false);
            const diagnostics = unbuiltSession.getProgram().getSemanticDiagnostics();
            assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), [6305]);
            // The output check cannot prove readiness when the reference is unbuilt.
            assert.equal(referenceAuthorityReady(appConfig), undefined);
            const aliasDefinition = unbuiltSession.getDefinitionAtPosition(
                appSource,
                appText.indexOf('Shared().run'),
            )[0];
            assert.equal(aliasDefinition?.kind, 'alias');
            assert.equal(aliasDefinition?.fileName.replace(/\\/g, '/'), appSource.replace(/\\/g, '/'));
            assert.equal(unbuiltSession.projectReferences.length, 1);
        } finally {
            unbuiltSession.dispose();
        }

        const api = new ts.API({ runExternalCode: false });
        try {
            const parsedLib = api.parseConfigFile(libConfig);
            const libProgram = api.createProgram(parsedLib.fileNames, parsedLib.options, { projectReferences: parsedLib.projectReferences });
            try {
                const output = libProgram.getDeclarationEmit(parsedLib.fileNames);
                assert.equal(output.emitSkipped, false);
                for (const [fileName, file] of output.outputFiles) write(fileName, file.text);
            } finally { libProgram.dispose(); }
        } finally { api.close(); }

        const builtSession = new TypeScriptLanguageServiceSession(appConfig);
        try {
            assert.equal(builtSession.getProgram().getSemanticDiagnostics().length, 0);
            assert.equal(referenceAuthorityReady(appConfig), true);
            assert.equal(
                definitionFile(builtSession, appSource, appText, 'Shared().run'),
                path.join(root, 'lib/dist/index.d.ts').replace(/\\/g, '/'),
            );
        } finally {
            builtSession.dispose();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the fast TS6305 decision agrees with the checker for indirect references, bare require calls, NodeNext conditions, and references without declarations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-reference-graph-'));
    const compilerOptions = {
        composite: true,
        outDir: 'dist',
        rootDir: 'src',
        module: 'commonjs',
        target: 'ES2022',
        types: [],
    };
    const decide = (config: string) => {
        const api = new ts.API({ runExternalCode: false });
        try {
            const parsed = api.parseConfigFile(config);
            assert.ok(parsed);
            const program = api.createProgram(parsed.fileNames, { ...parsed.options, disableSourceOfProjectReferenceRedirect: true }, { projectReferences: parsed.projectReferences });
            try {
                const reportsTs6305 = program.getSemanticDiagnostics().some((diagnostic) => diagnostic.code === 6305);
                return { fast: referenceAuthorityReady(config), reportsTs6305 };
            } finally { program.dispose(); }
        } finally { api.close(); }
    };
    try {
        writeJson(path.join(root, 'core/tsconfig.json'), { compilerOptions, include: ['src'] });
        write(path.join(root, 'core/src/c.ts'), 'export const c = 1;\n');
        writeJson(path.join(root, 'lib/tsconfig.json'), {
            compilerOptions,
            include: ['src'],
            references: [{ path: '../core' }],
        });
        write(path.join(root, 'lib/src/l.ts'), 'export const l = 2;\n');
        write(path.join(root, 'lib/dist/l.d.ts'), 'export declare const l = 2;\n');

        // app references lib, lib references core; only core is unbuilt.
        const indirectConfig = path.join(root, 'app/tsconfig.json');
        writeJson(indirectConfig, { compilerOptions, include: ['src'], references: [{ path: '../lib' }] });
        write(path.join(root, 'app/src/a.ts'), 'import { c } from "../../core/src/c";\nexport const a = c;\n');
        const indirect = decide(indirectConfig);
        assert.equal(indirect.reportsTs6305, true);
        assert.equal(indirect.fast, undefined);

        // A bare require() in a TypeScript file is not a module import.
        const requireConfig = path.join(root, 'req/tsconfig.json');
        writeJson(requireConfig, { compilerOptions, include: ['src'], references: [{ path: '../core' }] });
        write(
            path.join(root, 'req/src/r.ts'),
            'declare const require: (id: string) => unknown;\nexport const r = require("../../core/src/c");\n',
        );
        const bareRequire = decide(requireConfig);
        assert.equal(bareRequire.reportsTs6305, false);
        assert.equal(bareRequire.fast, undefined);

        // NodeNext: the import condition reaches a built entry, the require
        // condition an unbuilt one. Only the import condition applies here.
        const nodeNextOptions = { ...compilerOptions, module: 'NodeNext', moduleResolution: 'NodeNext' };
        writeJson(path.join(root, 'dual/tsconfig.json'), { compilerOptions: nodeNextOptions, include: ['src'] });
        writeJson(path.join(root, 'dual/package.json'), {
            name: 'dual',
            type: 'module',
            exports: { '.': { import: './src/esm.ts', require: './src/cjs.ts' } },
        });
        write(path.join(root, 'dual/src/esm.ts'), 'export const esm = 1;\n');
        write(path.join(root, 'dual/src/cjs.ts'), 'export const cjs = 1;\n');
        write(path.join(root, 'dual/dist/esm.d.ts'), 'export declare const esm = 1;\n');
        const esmConfig = path.join(root, 'esm-app/tsconfig.json');
        writeJson(esmConfig, { compilerOptions: nodeNextOptions, include: ['src'], references: [{ path: '../dual' }] });
        writeJson(path.join(root, 'esm-app/package.json'), { name: 'esm-app', type: 'module' });
        fs.mkdirSync(path.join(root, 'esm-app/node_modules'), { recursive: true });
        fs.symlinkSync(path.join(root, 'dual'), path.join(root, 'esm-app/node_modules/dual'), 'dir');
        write(path.join(root, 'esm-app/src/a.ts'), 'import { esm } from "dual";\nexport const a = esm;\n');
        const nodeNext = decide(esmConfig);
        assert.equal(nodeNext.reportsTs6305, false);
        assert.equal(nodeNext.fast, undefined);

        // A referenced project that emits no declarations: the checker still
        // expects its declaration output and reports TS6305 without it.
        const plainOptions = { outDir: 'dist', rootDir: 'src', module: 'commonjs', target: 'ES2022', types: [] };
        writeJson(path.join(root, 'plain/tsconfig.json'), { compilerOptions: plainOptions, include: ['src'] });
        write(path.join(root, 'plain/src/p.ts'), 'export const p = 1;\n');
        const plainConfig = path.join(root, 'plain-app/tsconfig.json');
        writeJson(plainConfig, { compilerOptions, include: ['src'], references: [{ path: '../plain' }] });
        write(path.join(root, 'plain-app/src/a.ts'), 'import { p } from "../../plain/src/p";\nexport const a = p;\n');
        const plain = decide(plainConfig);
        assert.equal(plain.reportsTs6305, true);
        assert.equal(plain.fast, undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('disposing a native session with diamond references releases each declaration once', () => {
    // This repository's CLI project reproduces the TypeScript double release:
    // it references core directly and through mcp.
    const cliConfig = path.resolve(__dirname, '../../../cli/tsconfig.json');
    const session = new TypeScriptLanguageServiceSession(cliConfig);
    const outputs = session.getProgram().getSourceFileNames()
        .filter((filePath, index, all) => all.indexOf(filePath) !== index);
    assert.equal(outputs.length, 0, 'native programs must deduplicate declaration outputs');
    assert.doesNotThrow(() => session.dispose());
});


for (const inherited of [false, true]) {
    test(`configured TypeScript project rejects oversized ${inherited ? 'inherited' : 'root'} config through the fallback error`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-config-budget-'));
        try {
            const config = path.join(root, 'tsconfig.json');
            const target = inherited ? path.join(root, 'base.json') : config;
            if (inherited) writeJson(config, { extends: './base.json', files: ['value.ts'] });
            write(path.join(root, 'value.ts'), 'export const value = 1;');
            write(target, '{"files":["value.ts"]}'.padEnd(1024 * 1024 + 1, ' '));
            assert.throws(() => loadTypeScriptConfiguredProject(config), (error: unknown) => {
                assert.ok(error instanceof TypeScriptConfigReadError);
                assert.match(error.message, /byte.*budget/);
                return true;
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('configured TypeScript project bounds extends reads and accepts the read-budget boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-config-depth-'));
    try {
        write(path.join(root, 'value.ts'), 'export const value = 1;');
        for (let index = 0; index < 65; index += 1) {
            writeJson(path.join(root, `config-${index}.json`), {
                ...(index < 64 ? { extends: `./config-${index + 1}.json` } : {}),
                files: ['value.ts'],
            });
        }
        assert.throws(() => loadTypeScriptConfiguredProject(path.join(root, 'config-0.json')), (error: unknown) => {
            assert.ok(error instanceof TypeScriptConfigReadError);
            assert.match(error.message, /read.*budget/);
            return true;
        });
        assert.equal(loadTypeScriptConfiguredProject(path.join(root, 'config-1.json')).errors.length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('configured TypeScript project rejects extends cycles through the fallback error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-config-cycle-'));
    try {
        writeJson(path.join(root, 'tsconfig.json'), { extends: './base.json', files: ['value.ts'] });
        writeJson(path.join(root, 'base.json'), { extends: './tsconfig.json' });
        write(path.join(root, 'value.ts'), 'export const value = 1;');
        assert.throws(() => loadTypeScriptConfiguredProject(path.join(root, 'tsconfig.json')), (error: unknown) => {
            assert.ok(error instanceof TypeScriptConfigReadError);
            assert.match(error.message, /[Cc]ircular/);
            return true;
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('configured TypeScript project accepts the byte boundary and shared extends ancestors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-config-diamond-'));
    try {
        writeJson(path.join(root, 'tsconfig.json'), { extends: ['./left.json', './right.json'], files: ['value.ts'] });
        writeJson(path.join(root, 'left.json'), { extends: './base.json' });
        writeJson(path.join(root, 'right.json'), { extends: './base.json' });
        write(path.join(root, 'base.json'), '{"compilerOptions":{"strict":true}}'.padEnd(1024 * 1024, ' '));
        write(path.join(root, 'value.ts'), 'export const value = 1;');
        const project = loadTypeScriptConfiguredProject(path.join(root, 'tsconfig.json'));
        assert.equal(project.errors.length, 0);
        assert.equal(project.options.strict, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('configured TypeScript project bounds bytes even when a config grows after stat', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-config-growth-'));
    try {
        const config = path.join(root, 'tsconfig.json');
        write(config, '{"files":[]}'.padEnd(1024 * 1024 + 1, ' '));
        const stat = fs.fstatSync;
        t.mock.method(fs, 'fstatSync', (fd: number) => Object.assign(stat(fd), { size: 0 }));
        const read = fs.readSync;
        let bytesRead = 0;
        t.mock.method(fs, 'readSync', (...args: unknown[]) => {
            const bytes = Reflect.apply(read, fs, args) as number;
            bytesRead += bytes;
            return bytes;
        });
        assert.throws(() => loadTypeScriptConfiguredProject(config), TypeScriptConfigReadError);
        assert.equal(bytesRead, 1024 * 1024 + 1, 'the bounded reader stops at the overflow sentinel');
    } finally {
        t.mock.restoreAll();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('configured TypeScript project preserves TypeScript BOM encodings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-config-encoding-'));
    try {
        const config = path.join(root, 'tsconfig.json');
        write(path.join(root, 'value.ts'), 'export const value = 1;');
        const json = '{"files":["value.ts"],"compilerOptions":{"strict":true}}';
        const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
        for (const content of [
            Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
            littleEndian,
            Buffer.from(littleEndian).swap16(),
        ]) {
            fs.writeFileSync(config, content);
            assert.equal(loadTypeScriptConfiguredProject(config).options.strict, true);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('native session closes its process even when snapshot disposal fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-dispose-'));
    const source = path.join(root, 'value.ts');
    write(source, 'export const value = 1;');
    const session = new TypeScriptProgramSession(root, [source], { noEmit: true, types: [] });
    try {
        session.getProgram();
        const internals = session as unknown as {
            snapshot: { dispose(): void };
            api: { close(): void };
        };
        const api = internals.api;
        let closes = 0;
        internals.api = { close() { closes++; api.close(); } };
        internals.snapshot = { dispose() { throw new Error('injected snapshot disposal failure'); } };
        assert.throws(() => session.dispose(), /injected snapshot disposal failure/);
        assert.equal(closes, 1);
        assert.doesNotThrow(() => session.dispose());
        assert.equal(closes, 1);
        assert.throws(() => session.getProgram(), /disposed/);
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
