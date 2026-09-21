import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

import ts from 'typescript';

import { TypeScriptLanguageServiceSession } from '../packages/core/src/semantic/typescript-configured-project.ts';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
    const options = {
        config: path.resolve('packages/core/tsconfig.json'),
        target: path.resolve('packages/core/src/semantic/typescript-compiler-provider.ts'),
        out: undefined,
        repeats: 5,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--config') options.config = path.resolve(argv[++index]);
        else if (arg === '--target') options.target = path.resolve(argv[++index]);
        else if (arg === '--out') options.out = path.resolve(argv[++index]);
        else if (arg === '--repeats') options.repeats = Number(argv[++index]);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!options.out) throw new Error('--out is required');
    if (!Number.isInteger(options.repeats) || options.repeats < 1) {
        throw new Error('--repeats must be a positive integer');
    }
    return options;
}

function elapsed(start) {
    return Number((performance.now() - start).toFixed(3));
}

function rss() {
    return process.memoryUsage().rss;
}

function directoryBytes(directory) {
    let total = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fileName = path.join(directory, entry.name);
        if (entry.isDirectory()) total += directoryBytes(fileName);
        else if (entry.isFile()) total += fs.statSync(fileName).size;
    }
    return total;
}

function measureFullProjectSemanticWalk(session) {
    const configuredFiles = new Set(session.configuredFiles.map((fileName) => path.resolve(fileName)));
    const program = session.getProgram();
    const checker = program.getTypeChecker();
    const startedAt = performance.now();
    let fileCount = 0;
    let callCount = 0;
    let resolvedSignatureCount = 0;

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile || !configuredFiles.has(path.resolve(sourceFile.fileName))) continue;
        fileCount += 1;
        const visit = (node) => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                callCount += 1;
                if (checker.getResolvedSignature(node)) resolvedSignatureCount += 1;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return {
        fileCount,
        callCount,
        resolvedSignatureCount,
        durationMs: elapsed(startedAt),
    };
}

function builderAffectedCharacterization() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-affected-'));
    try {
        const dependency = path.join(root, 'dependency.ts');
        const consumer = path.join(root, 'consumer.ts');
        fs.writeFileSync(
            dependency,
            'export function value(): string { return "before"; }\n',
        );
        fs.writeFileSync(
            consumer,
            'import { value } from "./dependency"; export const result: string = value();\n',
        );

        const options = {
            strict: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            incremental: true,
            noEmit: true,
        };
        const createBuilder = (oldProgram) => {
            const host = ts.createIncrementalCompilerHost(options);
            return ts.createSemanticDiagnosticsBuilderProgram(
                [dependency, consumer],
                options,
                host,
                oldProgram,
            );
        };
        const drain = (builder) => {
            const affected = [];
            let result;
            while ((result = builder.getSemanticDiagnosticsOfNextAffectedFile())) {
                if (result.affected.kind === ts.SyntaxKind.SourceFile) {
                    const fileName = result.affected.fileName;
                    if (fileName.startsWith(root)) {
                        affected.push(path.basename(fileName));
                    }
                }
            }
            return affected;
        };

        let builder = createBuilder(undefined);
        const initialAffected = drain(builder);
        fs.writeFileSync(
            dependency,
            'export function value(): number { return 1; }\n',
        );
        const startedAt = performance.now();
        builder = createBuilder(builder);
        const affectedAfterDependencyEdit = drain(builder);
        return {
            refreshMs: elapsed(startedAt),
            initialAffected,
            affectedAfterDependencyEdit,
        };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const source = fs.readFileSync(options.target, 'utf8');
    const rssBefore = rss();

    let startedAt = performance.now();
    const session = new TypeScriptLanguageServiceSession(options.config);
    const constructMs = elapsed(startedAt);

    startedAt = performance.now();
    const initialProgram = session.getProgram();
    initialProgram.getTypeChecker();
    const coldProgramMs = elapsed(startedAt);
    const rssAfterCold = rss();

    const unchangedWalks = [];
    for (let index = 0; index < options.repeats; index += 1) {
        unchangedWalks.push(session.measureSemanticWalk(options.target));
    }
    const fullProjectFirstWalk = measureFullProjectSemanticWalk(session);
    const fullProjectWarmWalk = measureFullProjectSemanticWalk(session);

    startedAt = performance.now();
    const unchangedProgram = session.getProgram();
    unchangedProgram.getTypeChecker();
    const unchangedProgramMs = elapsed(startedAt);

    const changedSource = `${source}\n// semantic-characterization-edit\n`;
    startedAt = performance.now();
    session.updateFile(options.target, changedSource);
    const updatedProgram = session.getProgram();
    updatedProgram.getTypeChecker();
    const oneFileUpdateProgramMs = elapsed(startedAt);
    const rssAfterEdit = rss();
    const changedFileWalk = session.measureSemanticWalk(options.target);
    const fullProjectAfterEditWalk = measureFullProjectSemanticWalk(session);

    startedAt = performance.now();
    const configChanged = session.refreshConfiguration();
    const unchangedConfigRefreshMs = elapsed(startedAt);

    session.dispose();

    const typescriptRoot = path.dirname(require.resolve('typescript/package.json'));
    const artifact = {
        version: 1,
        compilerVersion: ts.version,
        project: {
            configPath: options.config,
            configuredFileCount: initialProgram.getRootFileNames().length,
            identity: session.identity,
        },
        languageService: {
            constructMs,
            coldProgramMs,
            coldTotalMs: Number((constructMs + coldProgramMs).toFixed(3)),
            unchangedProgramMs,
            unchangedWalks,
            fullProjectFirstWalk,
            fullProjectWarmWalk,
            oneFileUpdateProgramMs,
            changedFileWalk,
            fullProjectAfterEditWalk,
            unchangedConfigRefreshMs,
            unchangedConfigRefreshChangedProject: configChanged,
        },
        memory: {
            rssBeforeBytes: rssBefore,
            rssAfterColdBytes: rssAfterCold,
            rssAfterEditBytes: rssAfterEdit,
            coldDeltaBytes: Math.max(0, rssAfterCold - rssBefore),
            editDeltaBytes: Math.max(0, rssAfterEdit - rssAfterCold),
        },
        affectedFiles: builderAffectedCharacterization(),
        packaging: {
            typescriptPackageRoot: typescriptRoot,
            installedBytes: directoryBytes(typescriptRoot),
        },
    };

    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`Wrote TypeScript production characterization: ${options.out}\n`);
}

main();
