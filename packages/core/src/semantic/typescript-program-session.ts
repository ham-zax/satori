import fs from 'node:fs';
import path from 'node:path';

import { API, type CompilerOptions, type Program, type ProjectReference, type Snapshot } from './typescript-api';
import { serverFS } from './typescript-api';

export interface TypeScriptSourceReader {
    admit(fileName: string, bytes: number): boolean;
    getFailureMessage(): string | undefined;
}

/** Owns the native process and every snapshot created for one semantic project. */
export class TypeScriptProgramSession {
    private readonly api: InstanceType<typeof API>;
    private snapshot?: Snapshot;
    private program?: Program;
    private readonly overrides = new Map<string, string>();
    private readonly changed = new Set<string>();
    private disposed = false;

    constructor(
        rootPath: string,
        private readonly fileNames: readonly string[],
        private readonly options: CompilerOptions,
        private readonly sourceBudget?: TypeScriptSourceReader,
        private readonly references?: readonly ProjectReference[],
    ) {
        this.api = new API({
            cwd: rootPath,
            runExternalCode: false,
            fs: {
                directoryExists: serverFS.useOS,
                fileExists: serverFS.useOS,
                getAccessibleEntries: serverFS.useOS,
                realpath: serverFS.useOS,
                stat: serverFS.useOS,
                writeFile: serverFS.noop,
                removeFile: serverFS.noop,
                readFile: (fileName) => {
                    const override = this.overrides.get(path.resolve(fileName));
                    if (override !== undefined) return override;
                    try {
                        const stat = fs.statSync(fileName);
                        if (!stat.isFile() || this.sourceBudget && !this.sourceBudget.admit(fileName, stat.size)) return undefined;
                        const content = fs.readFileSync(fileName, 'utf8');
                        if (this.sourceBudget && !this.sourceBudget.admit(fileName, Buffer.byteLength(content, 'utf8'))) return undefined;
                        return content;
                    } catch {
                        return undefined;
                    }
                },
            },
        });
    }

    getProgram(): Program {
        if (this.disposed) throw new Error('TypeScript program session is disposed.');
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
        return this.program;
    }

    getResourceLimitFailure(): string | undefined {
        return this.sourceBudget?.getFailureMessage();
    }

    updateFile(fileName: string, source: string): void {
        const absolute = path.resolve(fileName);
        if (this.sourceBudget && !this.sourceBudget.admit(absolute, Buffer.byteLength(source, 'utf8'))) return;
        this.overrides.set(absolute, source);
        this.changed.add(absolute);
    }

    invalidateFile(fileName: string): void {
        const absolute = path.resolve(fileName);
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
