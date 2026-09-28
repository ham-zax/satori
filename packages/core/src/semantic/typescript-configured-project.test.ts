import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import {
    TypeScriptLanguageServiceSession,
    loadTypeScriptConfiguredProject,
} from './typescript-configured-project';
import { unbuiltReferenceImport } from '../relationships/typescript-semantic-analyzer';

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
            // The fast TS6305 decision agrees with the checker without type-checking.
            assert.equal(unbuiltReferenceImport(unbuiltSession.getProgram(), [appSource]), false);
            const aliasDefinition = unbuiltSession.getDefinitionAtPosition(
                appSource,
                appText.indexOf('Shared().run'),
            )[0];
            assert.equal(aliasDefinition?.kind, 'alias');
            assert.equal(aliasDefinition?.fileName.replace(/\\/g, '/'), appSource.replace(/\\/g, '/'));
            assert.equal(unbuiltSession.getProgram().getResolvedProjectReferences()?.length, 1);
        } finally {
            unbuiltSession.dispose();
        }

        const configRead = ts.readConfigFile(libConfig, ts.sys.readFile);
        assert.equal(configRead.error, undefined);
        const parsedLib = ts.parseJsonConfigFileContent(
            configRead.config,
            ts.sys,
            path.dirname(libConfig),
            undefined,
            libConfig,
        );
        const libProgram = ts.createProgram({
            rootNames: parsedLib.fileNames,
            options: parsedLib.options,
            projectReferences: parsedLib.projectReferences,
        });
        assert.equal(libProgram.emit().emitSkipped, false);

        const builtSession = new TypeScriptLanguageServiceSession(appConfig);
        try {
            assert.equal(builtSession.getProgram().getSemanticDiagnostics().length, 0);
            assert.equal(unbuiltReferenceImport(builtSession.getProgram(), [appSource]), true);
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
        const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: () => undefined,
        });
        assert.ok(parsed);
        const program = ts.createProgram({
            rootNames: parsed.fileNames,
            options: parsed.options,
            projectReferences: parsed.projectReferences,
        });
        const reportsTs6305 = program.getSemanticDiagnostics().some((diagnostic) => diagnostic.code === 6305);
        return { fast: unbuiltReferenceImport(program, parsed.fileNames), reportsTs6305 };
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
        assert.notEqual(indirect.fast, true);

        // A bare require() in a TypeScript file is not a module import.
        const requireConfig = path.join(root, 'req/tsconfig.json');
        writeJson(requireConfig, { compilerOptions, include: ['src'], references: [{ path: '../core' }] });
        write(
            path.join(root, 'req/src/r.ts'),
            'declare const require: (id: string) => unknown;\nexport const r = require("../../core/src/c");\n',
        );
        const bareRequire = decide(requireConfig);
        assert.equal(bareRequire.reportsTs6305, false);
        assert.notEqual(bareRequire.fast, false);

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
        assert.notEqual(nodeNext.fast, false);

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
        assert.notEqual(plain.fast, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('disposing a session survives TypeScript releasing a duplicated declaration output twice', () => {
    // This repository's CLI project reproduces the TypeScript double release:
    // it references core directly and through mcp.
    const cliConfig = path.resolve(__dirname, '../../../cli/tsconfig.json');
    const session = new TypeScriptLanguageServiceSession(cliConfig);
    const outputs = session.getProgram().getSourceFiles()
        .map((sourceFile) => sourceFile.fileName)
        .filter((filePath, index, all) => all.indexOf(filePath) !== index);
    assert.ok(outputs.length > 0, 'expected the duplicated declaration output this test guards');
    assert.doesNotThrow(() => session.dispose());
});
