import fs from 'node:fs';
import path from 'node:path';

import { API, type CompilerOptions, type ModuleResolver, type Program, type ProjectReference, type RawCompilerOptions, type ResolutionMode, type Snapshot } from './typescript-api';
import { serverFS } from './typescript-api';
import {
    readTypeScriptFileBytes, TypeScriptReadLimitError,
    TYPESCRIPT_METADATA_FILE_BYTES, TYPESCRIPT_METADATA_TOTAL_BYTES,
} from './typescript-bounded-reader';
import type { TypeScriptFsObservationRecorder } from './typescript-fs-observation';

export interface TypeScriptSourceReader {
    readonly maxFileBytes: number;
    readonly maxProjectBytes: number;
    admit(fileName: string, bytes: number): boolean;
    forget(fileName: string): void;
    reset(): void;
    getFailureMessage(): string | undefined;
}

/** Owns the native process and every snapshot created for one semantic project. */
export class TypeScriptProgramSession {
    private readonly api: InstanceType<typeof API>;
    private snapshot?: Snapshot;
    private program?: Program;
    private moduleResolver?: ModuleResolver;
    private readonly overrides = new Map<string, string>();
    private readonly changed = new Set<string>();
    private readonly jsonReadBytes = new Map<string, number>();
    private readonly sourceReadBytes = new Map<string, number>();
    private jsonBytes = 0;
    private jsonReadFailure?: string;
    private disposed = false;

    constructor(
        rootPath: string,
        private readonly fileNames: readonly string[],
        private readonly options: CompilerOptions,
        private readonly sourceBudget?: TypeScriptSourceReader,
        private readonly references?: readonly ProjectReference[],
        /**
         * Optional witness hook: records which paths the compiler asked about
         * so a caller can prove later that the same inputs still hold. Observed
         * callbacks return the recorded answer. Native-only answers make the
         * computation ineligible for caching.
         */
        private readonly observation?: TypeScriptFsObservationRecorder,
    ) {
        // The sentinel lets the native layer answer from the OS directly. A
        // recording session must route each call through JS, so only that
        // session pays the callback; every other session keeps the sentinel.
        const recorder = this.observation;
        this.api = new API({
            cwd: rootPath,
            runExternalCode: false,
            fs: {
                directoryExists: recorder
                    ? (directoryName) => {
                        const kind = recorder.recordPath(directoryName);
                        if (kind === 'other') { recorder.invalidate(); return serverFS.useOS; }
                        return kind === 'directory';
                    }
                    : serverFS.useOS,
                fileExists: recorder
                    ? (fileName) => {
                        const kind = recorder.recordPath(fileName);
                        if (kind === 'other') { recorder.invalidate(); return serverFS.useOS; }
                        return kind === 'file';
                    }
                    : serverFS.useOS,
                getAccessibleEntries: recorder
                    ? () => {
                        // The native listing distinguishes files, directories
                        // and symlinks. Names alone cannot witness its answer.
                        recorder.invalidate();
                        return serverFS.useOS;
                    }
                    : serverFS.useOS,
                realpath: recorder
                    ? (pathName) => {
                        return recorder.recordRealpath(pathName) || serverFS.useOS;
                    }
                    : serverFS.useOS,
                stat: recorder
                    ? () => {
                        // Path kind alone cannot witness native stat metadata.
                        recorder.invalidate();
                        return serverFS.useOS;
                    }
                    : serverFS.useOS,
                writeFile: serverFS.noop,
                removeFile: serverFS.noop,
                readFile: (fileName) => {
                    if (this.getResourceLimitFailure()) return undefined;
                    const override = this.overrides.get(path.resolve(fileName));
                    if (override !== undefined) {
                        if (!this.admitRead(fileName, Buffer.byteLength(override, 'utf8'))) return undefined;
                        this.observation?.recordRead(fileName, override);
                        return override;
                    }
                    try {
                        if (path.extname(fileName).toLowerCase() === '.json') {
                            const content = readTypeScriptFileBytes(fileName, this.jsonReadLimit(fileName));
                            if (!this.admitRead(fileName, content.length)) return undefined;
                            this.observation?.recordRead(fileName, content);
                            return content.toString('utf8');
                        }
                        const stat = fs.statSync(fileName);
                        if (!stat.isFile() || !this.admitRead(fileName, stat.size)) return undefined;
                        const content = readTypeScriptFileBytes(fileName, Math.min(
                            this.sourceBudget?.maxFileBytes ?? Number.MAX_SAFE_INTEGER,
                            this.sourceBudget?.maxProjectBytes ?? Number.MAX_SAFE_INTEGER,
                        ));
                        if (!this.admitRead(fileName, content.length)) return undefined;
                        this.observation?.recordRead(fileName, content);
                        return content.toString('utf8');
                    } catch (error) {
                        if (error instanceof TypeScriptReadLimitError) {
                            if (path.extname(fileName).toLowerCase() === '.json') this.rejectJsonRead(fileName, error.bytes);
                            else this.sourceBudget?.admit(fileName, error.bytes);
                        }
                        return undefined;
                    }
                },
            },
        });
    }

    getProgram(): Program {
        if (this.disposed) throw new Error('TypeScript program session is disposed.');
        const refreshed = !this.snapshot || this.changed.size > 0;
        const previousJsonReads = refreshed ? new Map(this.jsonReadBytes) : undefined;
        if (refreshed) {
            // Each snapshot owns its quota. Cached compiler files are charged
            // again below, while files removed from the program lose their charge.
            if (!this.sourceBudget?.getFailureMessage()) this.sourceBudget?.reset();
            this.jsonReadBytes.clear();
            this.jsonBytes = 0;
        }
        if (!this.snapshot) {
            const snapshot = this.api.createSnapshot({
                createPrograms: [{
                    rootFiles: this.fileNames,
                    // Semantic authority comes from built declarations, just as
                    // in the former language-service host's default behavior.
                    compilerOptions: { ...this.options, disableSourceOfProjectReferenceRedirect: true },
                    options: { projectReferences: this.references },
                }],
            });
            this.snapshot = snapshot;
            this.program = snapshot.operation.createdPrograms[0];
        } else if (this.changed.size) {
            const previous = this.snapshot;
            const next = previous.update({
                fileNotifications: { changed: [...this.changed] },
                ensurePrograms: [this.program!.id],
            });
            const program = next.getProgram(this.program!.id);
            if (!program) {
                next.dispose();
                throw new Error('TypeScript snapshot lost the semantic program.');
            }
            this.snapshot = next;
            this.program = program;
            previous.dispose();
        }
        this.changed.clear();
        if (!this.program) throw new Error('TypeScript did not create a semantic program.');
        if (refreshed) {
            // A read callback cannot distinguish JSON metadata from an imported
            // JSON source. The native program's file list supplies that proof.
            const active = new Set(this.program.getSourceFileNames().map(file => path.resolve(file)));
            for (const fileName of active) {
                const isJson = path.extname(fileName).toLowerCase() === '.json';
                let bytes = isJson
                    ? this.jsonReadBytes.get(fileName) ?? previousJsonReads?.get(fileName)
                    : this.sourceReadBytes.get(fileName);
                if (bytes === undefined && (this.sourceBudget || isJson)) {
                    // Native snapshots can reuse a formerly inactive file without
                    // calling readFile. Its current snapshot text is the witness.
                    const sourceFile = this.program.getSourceFile(fileName);
                    if (!sourceFile) throw new Error(`TypeScript snapshot lost source bytes for '${fileName}'.`);
                    bytes = Buffer.byteLength(sourceFile.text, 'utf8');
                    this.observation?.recordRead(fileName, sourceFile.text);
                }
                if (isJson && bytes !== undefined && !this.jsonReadBytes.has(fileName)) this.admitRead(fileName, bytes);
                if (!isJson && bytes !== undefined) this.sourceReadBytes.set(fileName, bytes);
                if (bytes !== undefined && !this.admitSource(fileName, bytes)) break;
            }
            for (const file of this.sourceReadBytes.keys()) {
                if (!active.has(file)) this.sourceReadBytes.delete(file);
            }
        }
        return this.program;
    }

    private admitRead(fileName: string, bytes: number): boolean {
        if (this.jsonReadFailure) return false;
        if (path.extname(fileName).toLowerCase() === '.json') {
            if (bytes > this.jsonReadLimit(fileName)) {
                this.rejectJsonRead(fileName, bytes);
                return false;
            }
            const absolute = path.resolve(fileName);
            this.jsonBytes += bytes - (this.jsonReadBytes.get(absolute) ?? 0);
            this.jsonReadBytes.set(absolute, bytes);
            return true;
        }
        if (this.sourceBudget && !this.sourceBudget.admit(fileName, bytes)) return false;
        this.sourceReadBytes.set(path.resolve(fileName), bytes);
        this.observation?.recordSourceRead(fileName);
        return true;
    }

    private admitSource(fileName: string, bytes: number): boolean {
        if (this.sourceBudget && !this.sourceBudget.admit(fileName, bytes)) return false;
        this.observation?.recordSourceRead(fileName);
        return true;
    }

    private jsonReadLimit(fileName: string): number {
        // JSON roles are unknown until the compiler builds its program. Bound
        // transport bytes independently so metadata stays outside source quotas.
        const fileLimit = Math.max(this.sourceBudget?.maxFileBytes ?? 0, TYPESCRIPT_METADATA_FILE_BYTES);
        const totalLimit = Math.min(Number.MAX_SAFE_INTEGER,
            (this.sourceBudget?.maxProjectBytes ?? 0) + TYPESCRIPT_METADATA_TOTAL_BYTES);
        return Math.min(fileLimit, Math.max(0,
            totalLimit - this.jsonBytes + (this.jsonReadBytes.get(path.resolve(fileName)) ?? 0)));
    }

    private rejectJsonRead(fileName: string, bytes: number): void {
        this.jsonReadFailure ??= `TypeScript semantic JSON input '${fileName}' is ${bytes} bytes, exceeding the ${this.jsonReadLimit(fileName)} byte native-read budget.`;
    }

    getResourceLimitFailure(): string | undefined {
        return this.jsonReadFailure ?? this.sourceBudget?.getFailureMessage();
    }

    /**
     * Resolves a specifier the program did not resolve itself, such as a
     * `require()` argument in a TypeScript file. Uses the program's compiler
     * options and the session's file overrides.
     */
    resolveModuleName(containingFile: string, specifier: string, mode: ResolutionMode): string | undefined {
        if (this.disposed) throw new Error('TypeScript program session is disposed.');
        this.moduleResolver ??= this.api.createModuleResolver(this.options as RawCompilerOptions);
        const result = this.moduleResolver.resolveModuleName(specifier, path.dirname(path.resolve(containingFile)), mode);
        return result.resolvedModule?.resolvedFileName;
    }

    updateFile(fileName: string, source: string): void {
        const absolute = path.resolve(fileName);
        if (this.snapshot && this.changed.size === 0 && !this.sourceBudget?.getFailureMessage()) this.sourceBudget?.reset();
        if (!this.admitRead(absolute, Buffer.byteLength(source, 'utf8'))) return;
        this.overrides.set(absolute, source);
        this.changed.add(absolute);
    }

    invalidateFile(fileName: string): void {
        const absolute = path.resolve(fileName);
        if (this.snapshot && this.changed.size === 0 && !this.sourceBudget?.getFailureMessage()) this.sourceBudget?.reset();
        this.sourceBudget?.forget(absolute);
        this.sourceReadBytes.delete(absolute);
        this.jsonBytes -= this.jsonReadBytes.get(absolute) ?? 0;
        this.jsonReadBytes.delete(absolute);
        this.overrides.delete(absolute);
        this.changed.add(absolute);
    }

    clearFileOverride(fileName: string): void {
        if (this.overrides.has(path.resolve(fileName))) this.invalidateFile(fileName);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try {
            this.snapshot?.dispose();
        } finally {
            this.api.close();
        }
    }
}
