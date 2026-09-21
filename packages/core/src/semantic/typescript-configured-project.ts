import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export interface TypeScriptConfiguredProjectIdentity {
    readonly compilerVersion: string;
    readonly configPath: string;
    readonly compilerOptionsHash: string;
    readonly rootFilesHash: string;
    readonly projectReferencesHash: string;
    readonly projectHash: string;
}

export interface TypeScriptConfiguredProject {
    readonly configPath: string;
    readonly fileNames: readonly string[];
    readonly options: ts.CompilerOptions;
    readonly projectReferences?: readonly ts.ProjectReference[];
    readonly errors: readonly ts.Diagnostic[];
    readonly identity: TypeScriptConfiguredProjectIdentity;
}

export interface TypeScriptSemanticWalkMeasurement {
    readonly fileName: string;
    readonly callCount: number;
    readonly resolvedSignatureCount: number;
    readonly durationMs: number;
}

function hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedPath(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/');
}

function normalizedCompilerOptions(options: ts.CompilerOptions): Record<string, unknown> {
    const entries = Object.entries(options)
        .filter(([key]) => key !== 'configFilePath')
        .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, value]) => [
        key,
        Array.isArray(value)
            ? [...value]
            : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
                : value,
    ]));
}

function normalizedReferences(
    references: readonly ts.ProjectReference[] | undefined,
): readonly Record<string, unknown>[] {
    return (references ?? [])
        .map((reference) => ({
            path: normalizedPath(reference.path),
            prepend: reference.prepend ?? false,
            circular: reference.circular ?? false,
        }))
        .sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
    return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

export function loadTypeScriptConfiguredProject(configPath: string): TypeScriptConfiguredProject {
    const absoluteConfigPath = normalizedPath(configPath);
    const configRead = ts.readConfigFile(absoluteConfigPath, ts.sys.readFile);
    if (configRead.error) {
        throw new Error(`Unable to read TypeScript config '${absoluteConfigPath}': ${diagnosticText(configRead.error)}`);
    }

    const parsed = ts.parseJsonConfigFileContent(
        configRead.config,
        ts.sys,
        path.dirname(absoluteConfigPath),
        undefined,
        absoluteConfigPath,
    );

    const fileNames = parsed.fileNames.map(normalizedPath).sort();
    const options = {
        ...parsed.options,
        noEmit: true,
    };
    const optionsIdentity = normalizedCompilerOptions(options);
    const referenceIdentity = normalizedReferences(parsed.projectReferences);
    const identityInput = {
        compilerVersion: ts.version,
        configPath: absoluteConfigPath,
        compilerOptions: optionsIdentity,
        rootFiles: fileNames,
        projectReferences: referenceIdentity,
    };

    return {
        configPath: absoluteConfigPath,
        fileNames,
        options,
        ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
        errors: parsed.errors,
        identity: {
            compilerVersion: ts.version,
            configPath: absoluteConfigPath,
            compilerOptionsHash: hash(optionsIdentity),
            rootFilesHash: hash(fileNames),
            projectReferencesHash: hash(referenceIdentity),
            projectHash: hash(identityInput),
        },
    };
}

export class TypeScriptLanguageServiceSession {
    private project: TypeScriptConfiguredProject;
    private languageService: ts.LanguageService;
    private readonly fileVersions = new Map<string, number>();
    private readonly overrides = new Map<string, string>();

    constructor(configPath: string) {
        this.project = loadTypeScriptConfiguredProject(configPath);
        this.languageService = this.createLanguageService();
    }

    get identity(): TypeScriptConfiguredProjectIdentity {
        return this.project.identity;
    }

    get configuredFiles(): readonly string[] {
        return this.project.fileNames;
    }

    get projectReferences(): readonly ts.ProjectReference[] {
        return this.project.projectReferences ?? [];
    }

    get options(): ts.CompilerOptions {
        return this.project.options;
    }

    getProgram(): ts.Program {
        const program = this.languageService.getProgram();
        if (!program) {
            throw new Error(`TypeScript LanguageService did not create a Program for '${this.project.configPath}'.`);
        }
        return program;
    }

    getDefinitionAtPosition(fileName: string, position: number): readonly ts.DefinitionInfo[] {
        return this.languageService.getDefinitionAtPosition(normalizedPath(fileName), position) ?? [];
    }

    updateFile(fileName: string, source: string): void {
        const absoluteFileName = normalizedPath(fileName);
        this.overrides.set(absoluteFileName, source);
        this.fileVersions.set(absoluteFileName, (this.fileVersions.get(absoluteFileName) ?? 0) + 1);
    }

    clearFileOverride(fileName: string): void {
        const absoluteFileName = normalizedPath(fileName);
        if (this.overrides.delete(absoluteFileName)) {
            this.fileVersions.set(absoluteFileName, (this.fileVersions.get(absoluteFileName) ?? 0) + 1);
        }
    }

    refreshConfiguration(): boolean {
        const next = loadTypeScriptConfiguredProject(this.project.configPath);
        if (next.identity.projectHash === this.project.identity.projectHash) {
            return false;
        }
        this.project = next;
        this.languageService.dispose();
        this.languageService = this.createLanguageService();
        return true;
    }

    measureSemanticWalk(fileName: string): TypeScriptSemanticWalkMeasurement {
        const absoluteFileName = normalizedPath(fileName);
        const sourceFile = this.getProgram().getSourceFile(absoluteFileName);
        if (!sourceFile) {
            throw new Error(`File '${absoluteFileName}' is not part of configured project '${this.project.configPath}'.`);
        }

        const checker = this.getProgram().getTypeChecker();
        const startedAt = performance.now();
        let callCount = 0;
        let resolvedSignatureCount = 0;

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                callCount += 1;
                if (checker.getResolvedSignature(node)) {
                    resolvedSignatureCount += 1;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);

        return {
            fileName: absoluteFileName,
            callCount,
            resolvedSignatureCount,
            durationMs: performance.now() - startedAt,
        };
    }

    dispose(): void {
        this.languageService.dispose();
    }

    private createLanguageService(): ts.LanguageService {
        const project = this.project;
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => project.options,
            getCurrentDirectory: () => path.dirname(project.configPath),
            getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
            getProjectReferences: () => project.projectReferences,
            getScriptFileNames: () => [...project.fileNames],
            getScriptSnapshot: (fileName) => {
                const absoluteFileName = normalizedPath(fileName);
                const source = this.overrides.get(absoluteFileName)
                    ?? (fs.existsSync(absoluteFileName) ? fs.readFileSync(absoluteFileName, 'utf8') : undefined);
                return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
            },
            getScriptVersion: (fileName) => String(this.fileVersions.get(normalizedPath(fileName)) ?? 0),
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile,
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
        };
        return ts.createLanguageService(host, ts.createDocumentRegistry());
    }
}
