import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import * as ts from './typescript-api';
import { serverFS } from './typescript-api';
import { TypeScriptProgramSession } from './typescript-program-session';
import { readTypeScriptFileBytes, TypeScriptReadLimitError, TYPESCRIPT_METADATA_FILE_BYTES } from './typescript-bounded-reader';

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
    /** Config and metadata paths read by the compiler, including missing candidates. */
    readonly configFiles: readonly string[];
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

    get maxFileBytes(): number { return this.budget.maxFileBytes; }
    get maxProjectBytes(): number { return this.budget.maxProjectBytes; }

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

    forget(fileName: string): void {
        this.totalBytes -= this.admittedBytesByFile.get(fileName) ?? 0;
        this.admittedBytesByFile.delete(fileName);
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
            circular: reference.circular ?? false,
        }))
        .sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
    return diagnostic.text;
}

/** A tsconfig/jsconfig that cannot be read or parsed as JSON; callers may skip that config. */
export class TypeScriptConfigReadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TypeScriptConfigReadError';
    }
}

const MAX_TYPESCRIPT_CONFIG_BYTES = TYPESCRIPT_METADATA_FILE_BYTES;
const MAX_TYPESCRIPT_CONFIG_READS = 64;

export function loadTypeScriptConfiguredProject(configPath: string): TypeScriptConfiguredProject {
    const absoluteConfigPath = normalizedPath(configPath);
    let reads = 0;
    let readFailure: string | undefined;
    const configReads = new Map<string, string | undefined>();
    // Bound all config/metadata reads through TypeScript's own resolver. The total
    // read budget also bounds extends depth without copying compiler resolution rules.
    const readFile = (fileName: string): string | undefined => {
        if (readFailure) return undefined;
        if (configReads.has(fileName)) return configReads.get(fileName);
        if (++reads > MAX_TYPESCRIPT_CONFIG_READS) {
            readFailure = `TypeScript config read budget exceeded ${MAX_TYPESCRIPT_CONFIG_READS} files.`;
            return undefined;
        }
        try {
            const content = readTypeScriptFileBytes(fileName, MAX_TYPESCRIPT_CONFIG_BYTES);
            // Match the compiler's UTF-8 and UTF-16 BOM support.
            const encoding = content[0] === 0xff && content[1] === 0xfe ? 'utf-16le'
                : content[0] === 0xfe && content[1] === 0xff ? 'utf-16be' : 'utf-8';
            const text = new TextDecoder(encoding).decode(content);
            configReads.set(fileName, text);
            return text;
        } catch (error) {
            if (error instanceof TypeScriptReadLimitError) {
                readFailure = `TypeScript config '${fileName}' exceeds the ${MAX_TYPESCRIPT_CONFIG_BYTES} byte budget.`;
            }
            configReads.set(fileName, undefined);
            return undefined;
        }
    };
    readFile(absoluteConfigPath);
    if (readFailure) throw new TypeScriptConfigReadError(readFailure);
    const api = new ts.API({
        runExternalCode: false,
        fs: {
            directoryExists: serverFS.useOS, fileExists: serverFS.useOS,
            getAccessibleEntries: serverFS.useOS, realpath: serverFS.useOS,
            stat: serverFS.useOS, writeFile: serverFS.noop, removeFile: serverFS.noop,
            readFile,
        },
    });
    try {
        const configRead = api.readConfigFile(absoluteConfigPath);
        if (readFailure) throw new TypeScriptConfigReadError(readFailure);
        if (configRead.error) {
            throw new TypeScriptConfigReadError(`Unable to read TypeScript config '${absoluteConfigPath}': ${diagnosticText(configRead.error)}`);
        }
        const parsed = api.parseConfigFile(absoluteConfigPath);
        if (readFailure) throw new TypeScriptConfigReadError(readFailure);
        // TypeScript owns cycle detection; callers already skip configs with this error type.
        const cycle = parsed.errors.find(error => error.code === 18000);
        if (cycle) throw new TypeScriptConfigReadError(diagnosticText(cycle));

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
            configFiles: [...configReads.keys()].map(normalizedPath).sort(),
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
    } finally { api.close(); }
}

export class TypeScriptLanguageServiceSession {
    private project: TypeScriptConfiguredProject;
    private session: TypeScriptProgramSession;
    private readonly sourceBudget?: TypeScriptSourceBudgetTracker;

    constructor(configPath: string, resourceBudget?: TypeScriptSourceBudget) {
        this.project = loadTypeScriptConfiguredProject(configPath);
        this.sourceBudget = resourceBudget ? new TypeScriptSourceBudgetTracker(resourceBudget) : undefined;
        this.session = this.createSession();
    }

    get identity(): TypeScriptConfiguredProjectIdentity { return this.project.identity; }
    get configuredFiles(): readonly string[] { return this.project.fileNames; }
    get projectReferences(): readonly ts.ProjectReference[] { return this.project.projectReferences ?? []; }
    get options(): ts.CompilerOptions { return this.project.options; }
    getProgram(): ts.Program { return this.session.getProgram(); }
    getResourceLimitFailure(): string | undefined { return this.session.getResourceLimitFailure(); }
    resolveModuleName(containingFile: string, specifier: string, mode: ts.ResolutionMode): string | undefined {
        return this.session.resolveModuleName(containingFile, specifier, mode);
    }

    getDefinitionAtPosition(fileName: string, position: number): readonly { fileName: string; kind: string }[] {
        const program = this.getProgram();
        const source = program.getSourceFile(normalizedPath(fileName));
        if (!source) return [];
        const checker = program.getProject().checker;
        const node = ts.getTokenAtPosition(source, position);
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol) return [];
        const alias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
        const target = alias ? checker.getAliasedSymbol(symbol) : symbol;
        const declarations = checker.isUnknownSymbol(target) ? symbol.declarations : target.declarations;
        return declarations.flatMap(handle => {
            const declaration = handle.resolve();
            return declaration ? [{ fileName: declaration.getSourceFile().fileName, kind: checker.isUnknownSymbol(target) && alias ? 'alias' : 'unknown' }] : [];
        });
    }

    updateFile(fileName: string, source: string): void { this.session.updateFile(fileName, source); }
    invalidateFile(fileName: string): void { this.session.invalidateFile(fileName); }
    clearFileOverride(fileName: string): void { this.session.clearFileOverride(fileName); }

    refreshConfiguration(): boolean {
        const next = loadTypeScriptConfiguredProject(this.project.configPath);
        if (next.identity.projectHash === this.project.identity.projectHash) return false;
        this.session.dispose();
        this.project = next;
        this.sourceBudget?.reset();
        this.session = this.createSession();
        return true;
    }

    measureSemanticWalk(fileName: string): TypeScriptSemanticWalkMeasurement {
        const absoluteFileName = normalizedPath(fileName);
        const program = this.getProgram();
        const sourceFile = program.getSourceFile(absoluteFileName);
        if (!sourceFile) throw new Error(`TypeScript source '${absoluteFileName}' is not in the configured program.`);
        const checker = program.getProject().checker;
        const startedAt = performance.now();
        let callCount = 0;
        let resolvedSignatureCount = 0;
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                callCount++;
                if (!checker.isUnknownSignature(checker.getResolvedSignature(node))) resolvedSignatureCount++;
            }
            node.forEachChild(visit);
        };
        visit(sourceFile);
        return { fileName: absoluteFileName, callCount, resolvedSignatureCount, durationMs: performance.now() - startedAt };
    }

    dispose(): void { this.session.dispose(); }

    private createSession(): TypeScriptProgramSession {
        return new TypeScriptProgramSession(path.dirname(this.project.configPath), this.project.fileNames,
            this.project.options, this.sourceBudget, this.project.projectReferences);
    }
}
