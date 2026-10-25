import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

import * as ts from 'typescript/ast';
import { API, ModuleKind, ModuleResolutionKind } from 'typescript/sync';
import { version } from 'typescript';

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
    const checker = program.getProject().checker;
    const startedAt = performance.now();
    let fileCount = 0;
    let callCount = 0;
    let resolvedSignatureCount = 0;

    for (const sourceFile of program.getSourceFileNames().map(name => program.getSourceFile(name))) {
        if (sourceFile.isDeclarationFile || !configuredFiles.has(path.resolve(sourceFile.fileName))) continue;
        fileCount += 1;
        const visit = (node) => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                callCount += 1;
                if (!checker.isUnknownSignature(checker.getResolvedSignature(node))) resolvedSignatureCount += 1;
            }
            node.forEachChild(visit);
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

function snapshotDiagnosticCharacterization() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-snapshot-'));
    const api = new API({ runExternalCode: false });
    try {
        const dependency = path.join(root, 'dependency.ts');
        const consumer = path.join(root, 'consumer.ts');
        fs.writeFileSync(dependency, 'export function value(): string { return "before"; }');
        fs.writeFileSync(consumer, 'import { value } from "./dependency"; export const result: string = value();');
        const before = api.createSnapshot({ createPrograms: [{ rootFiles: [dependency, consumer], compilerOptions: {
            strict: true, target: ts.ScriptTarget.ES2022, module: ModuleKind.NodeNext,
            moduleResolution: ModuleResolutionKind.NodeNext, noEmit: true,
        } }] });
        try {
            const program = before.operation.createdPrograms[0];
            const initialDiagnostics = program.getSemanticDiagnostics().map(d => d.code);
            fs.writeFileSync(dependency, 'export function value(): number { return 1; }');
            const startedAt = performance.now();
            const after = before.update({ fileNotifications: { changed: [dependency] }, ensurePrograms: [program.id] });
            try {
                return { refreshMs: elapsed(startedAt), initialDiagnostics,
                    diagnosticsAfterDependencyEdit: after.getProgram(program.id).getSemanticDiagnostics().map(d => d.code) };
            } finally { after.dispose(); }
        } finally { before.dispose(); }
    } finally {
        api.close();
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
    initialProgram.getProject().checker;
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
    unchangedProgram.getProject().checker;
    const unchangedProgramMs = elapsed(startedAt);

    const changedSource = `${source}\n// semantic-characterization-edit\n`;
    startedAt = performance.now();
    session.updateFile(options.target, changedSource);
    const updatedProgram = session.getProgram();
    updatedProgram.getProject().checker;
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
        version: 2,
        compilerVersion: version,
        project: {
            configPath: options.config,
            configuredFileCount: session.configuredFiles.length,
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
            scope: "node-client-only; excludes the native compiler process",
            rssBeforeBytes: rssBefore,
            rssAfterColdBytes: rssAfterCold,
            rssAfterEditBytes: rssAfterEdit,
            coldDeltaBytes: Math.max(0, rssAfterCold - rssBefore),
            editDeltaBytes: Math.max(0, rssAfterEdit - rssAfterCold),
        },
        snapshotDiagnostics: snapshotDiagnosticCharacterization(),
        packaging: {
            typescriptPackageRoot: typescriptRoot,
            includesPlatformBinary: false,
            installedBytes: directoryBytes(typescriptRoot),
        },
    };

    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`Wrote TypeScript production characterization: ${options.out}\n`);
}

main();
