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

export interface TypeScriptSourceBudget {
    readonly maxFileBytes: number;
    readonly maxProjectBytes: number;
}

export class TypeScriptSourceBudgetTracker {
    private readonly admittedBytesByFile = new Map<string, number>();
    private totalBytes = 0;
    private failureMessage?: string;

    constructor(private readonly budget: TypeScriptSourceBudget) {}

    admit(fileName: string, bytes: number): boolean {
        if (this.failureMessage) return false;
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            this.failureMessage = `TypeScript semantic source '${fileName}' has an invalid byte size.`;
            return false;
        }
        if (bytes > this.budget.maxFileBytes) {
            this.failureMessage = `TypeScript semantic source '${fileName}' is ${bytes} bytes, exceeding the ${this.budget.maxFileBytes} byte per-file budget.`;
            return false;
        }
        const previous = this.admittedBytesByFile.get(fileName) ?? 0;
        const nextTotal = this.totalBytes - previous + bytes;
        if (nextTotal > this.budget.maxProjectBytes) {
            this.failureMessage = `TypeScript semantic project source bytes would reach ${nextTotal}, exceeding the ${this.budget.maxProjectBytes} byte project budget while admitting '${fileName}'.`;
            return false;
        }
        this.admittedBytesByFile.set(fileName, bytes);
        this.totalBytes = nextTotal;
        return true;
    }

    getFailureMessage(): string | undefined {
        return this.failureMessage;
    }

    reset(): void {
        this.admittedBytesByFile.clear();
        this.totalBytes = 0;
        this.failureMessage = undefined;
    }
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

    private readonly sourceBudget?: TypeScriptSourceBudgetTracker;

    constructor(configPath: string, resourceBudget?: TypeScriptSourceBudget) {
        this.project = loadTypeScriptConfiguredProject(configPath);
        this.sourceBudget = resourceBudget
            ? new TypeScriptSourceBudgetTracker(resourceBudget)
            : undefined;
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

    getResourceLimitFailure(): string | undefined {
        return this.sourceBudget?.getFailureMessage();
    }

    getDefinitionAtPosition(fileName: string, position: number): readonly ts.DefinitionInfo[] {
        return this.languageService.getDefinitionAtPosition(normalizedPath(fileName), position) ?? [];
    }

    updateFile(fileName: string, source: string): void {
        const absoluteFileName = normalizedPath(fileName);
        const sourceBytes = Buffer.byteLength(source, 'utf8');
        if (this.sourceBudget && !this.sourceBudget.admit(absoluteFileName, sourceBytes)) {
            return;
        }
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
        this.sourceBudget?.reset();
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
                const override = this.overrides.get(absoluteFileName);
                if (override !== undefined) {
                    return ts.ScriptSnapshot.fromString(override);
                }
                if (!fs.existsSync(absoluteFileName)) return undefined;
                if (this.sourceBudget) {
                    let stat: fs.Stats;
                    try {
                        stat = fs.statSync(absoluteFileName);
                    } catch {
                        return undefined;
                    }
                    if (!stat.isFile() || !this.sourceBudget.admit(absoluteFileName, stat.size)) {
                        return undefined;
                    }
                }
                return ts.ScriptSnapshot.fromString(fs.readFileSync(absoluteFileName, 'utf8'));
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
