import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
    TYPESCRIPT_COMPILER_PROVIDER_ID,
    TYPESCRIPT_COMPILER_PROVIDER_VERSION,
    analyzeTypeScriptProgram,
    type TypeScriptProjectEvidence,
    type TypeScriptProgramSourceFile,
} from '../semantic/typescript-compiler-provider';
import {
    TypeScriptLanguageServiceSession,
    loadTypeScriptConfiguredProject,
    type TypeScriptConfiguredProject,
} from '../semantic/typescript-configured-project';
import type {
    ResolutionProjectAnalyzer,
    ResolutionProjectEvidence,
    ResolutionProjectInput,
} from './resolution';
import { buildTypeScriptResolutionClaims } from './typescript-resolution';

const TYPESCRIPT_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
const ROOT_MODULE_CONTROL_FILES = [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
] as const;
const DEFAULT_MAX_SESSIONS = 4;

type ProjectMode = 'configured' | 'inferred';

interface ProgramSession {
    getProgram(): ts.Program;
    updateFile(fileName: string, source: string): void;
    dispose(): void;
}

interface ProjectPlan {
    readonly key: string;
    readonly mode: ProjectMode;
    readonly rootPath: string;
    readonly configPath?: string;
    readonly relativeFiles: readonly string[];
    readonly absoluteFiles: readonly string[];
    readonly options: ts.CompilerOptions;
    readonly configErrors: readonly ts.Diagnostic[];
    readonly controlFiles: readonly string[];
    readonly environmentConfigId: string;
    readonly referencedProjectKeys: readonly string[];
}

interface ProjectSnapshot {
    readonly environmentConfigId: string;
    readonly files: ReadonlySet<string>;
    readonly reverseDependencies: ReadonlyMap<string, ReadonlySet<string>>;
    readonly projectGlobalSourceFiles: ReadonlySet<string>;
    readonly referencedProjectKeys: ReadonlySet<string>;
}

interface CachedSession {
    readonly key: string;
    readonly environmentConfigId: string;
    readonly session: ProgramSession;
    lastUsed: number;
}

function normalizeAbsolute(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/');
}

function normalizeRelative(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function isWithinRoot(rootPath: string, absolutePath: string): boolean {
    const relative = path.relative(rootPath, absolutePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeInsideRoot(rootPath: string, absolutePath: string): string | undefined {
    if (!isWithinRoot(rootPath, absolutePath)) return undefined;
    const relative = normalizeRelative(path.relative(rootPath, absolutePath));
    return relative || undefined;
}

function stableHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileContentHash(filePath: string): string {
    try {
        return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return 'missing';
    }
}

function normalizedCompilerOptions(options: ts.CompilerOptions): Record<string, unknown> {
    return Object.fromEntries(Object.entries(options)
        .filter(([key]) => key !== 'configFilePath')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
            key,
            Array.isArray(value)
                ? [...value]
                : value && typeof value === 'object'
                    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
                    : value,
        ]));
}

function inferredCompilerOptions(): ts.CompilerOptions {
    return {
        allowJs: false,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        noLib: false,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
    };
}

function isTypeScriptSourcePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return TYPESCRIPT_SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function configuredProjectKey(configPath: string): string {
    return `config:${normalizeAbsolute(configPath)}`;
}

function inferredProjectKey(rootPath: string): string {
    return `inferred:${normalizeAbsolute(rootPath)}`;
}

function potentialConfigPaths(rootPath: string, absoluteFile: string): string[] {
    const configs: string[] = [];
    let current = path.dirname(absoluteFile);
    const normalizedRoot = normalizeAbsolute(rootPath);
    while (isWithinRoot(normalizedRoot, current)) {
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            configs.push(normalizeAbsolute(path.join(current, name)));
        }
        if (normalizeAbsolute(current) === normalizedRoot) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return configs;
}

function candidateConfigPaths(rootPath: string, absoluteFile: string): string[] {
    return potentialConfigPaths(rootPath, absoluteFile).filter((candidate) => fs.existsSync(candidate));
}

function resolveConfigLike(candidate: string): string | undefined {
    const absolute = normalizeAbsolute(candidate);
    const candidates = [
        absolute,
        absolute.endsWith('.json') ? absolute : `${absolute}.json`,
        path.join(absolute, 'tsconfig.json'),
    ];
    return candidates.find((item) => fs.existsSync(item) && fs.statSync(item).isFile());
}

function resolveExtendsPath(configPath: string, specifier: string): string | undefined {
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        return resolveConfigLike(path.resolve(path.dirname(configPath), specifier));
    }
    try {
        const requireFromConfig = createRequire(configPath);
        return normalizeAbsolute(requireFromConfig.resolve(specifier));
    } catch {
        try {
            const requireFromConfig = createRequire(configPath);
            return normalizeAbsolute(requireFromConfig.resolve(`${specifier}/tsconfig.json`));
        } catch {
            return undefined;
        }
    }
}

function configExtendsSpecifiers(configPath: string): string[] {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error || !read.config) return [];
    const raw = read.config.extends;
    return (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function collectConfigChain(configPath: string, seen = new Set<string>()): string[] {
    const normalized = normalizeAbsolute(configPath);
    if (seen.has(normalized) || !fs.existsSync(normalized)) return [];
    seen.add(normalized);
    const chain = [normalized];
    for (const specifier of configExtendsSpecifiers(normalized)) {
        const resolved = resolveExtendsPath(normalized, specifier);
        if (resolved) chain.push(...collectConfigChain(resolved, seen));
    }
    return chain;
}

function resolveProjectReferenceConfig(referencePath: string): string | undefined {
    return resolveConfigLike(referencePath);
}

function parsedConfig(configPath: string): ts.ParsedCommandLine | undefined {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) return undefined;
    return ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath,
    );
}

function referencedDeclarationOutputs(configPath: string): string[] {
    const parsed = parsedConfig(configPath);
    if (!parsed) return [];
    const outputs = new Set<string>();
    for (const fileName of parsed.fileNames) {
        if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts')) continue;
        try {
            for (const output of ts.getOutputFileNames(parsed, fileName, false)) {
                if (output.endsWith('.d.ts') || output.endsWith('.d.mts') || output.endsWith('.d.cts')) {
                    outputs.add(normalizeAbsolute(output));
                }
            }
        } catch {
            // Invalid/partial reference configuration remains represented by its config identity.
        }
    }
    return [...outputs].sort();
}

function packageControlFiles(rootPath: string, sourceFiles: readonly string[]): string[] {
    const root = normalizeAbsolute(rootPath);
    const controls = new Set<string>();
    for (const sourceFile of sourceFiles) {
        let current = path.dirname(normalizeAbsolute(sourceFile));
        while (isWithinRoot(root, current)) {
            controls.add(normalizeAbsolute(path.join(current, 'package.json')));
            if (normalizeAbsolute(current) === root) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        for (const configPath of potentialConfigPaths(root, sourceFile)) controls.add(configPath);
    }
    for (const name of ROOT_MODULE_CONTROL_FILES) {
        controls.add(normalizeAbsolute(path.join(root, name)));
    }
    return [...controls].sort();
}

function projectControlFiles(
    rootPath: string,
    project: TypeScriptConfiguredProject | undefined,
    sourceFiles: readonly string[],
): { controls: string[]; referencedProjectKeys: string[] } {
    const controls = new Set(packageControlFiles(rootPath, sourceFiles));
    const referencedProjectKeys = new Set<string>();
    if (project) {
        for (const config of collectConfigChain(project.configPath)) controls.add(config);
        for (const reference of project.projectReferences ?? []) {
            const referenceConfig = resolveProjectReferenceConfig(reference.path);
            if (!referenceConfig) continue;
            referencedProjectKeys.add(configuredProjectKey(referenceConfig));
            for (const config of collectConfigChain(referenceConfig)) controls.add(config);
            for (const output of referencedDeclarationOutputs(referenceConfig)) {
                controls.add(output);
            }
        }
    }
    return {
        controls: [...controls]
            .filter((filePath) => isWithinRoot(rootPath, filePath))
            .sort(),
        referencedProjectKeys: [...referencedProjectKeys].sort(),
    };
}

function controlIdentity(rootPath: string, controlFiles: readonly string[]): readonly [string, string][] {
    return controlFiles.map((absolutePath) => [
        relativeInsideRoot(rootPath, absolutePath) ?? normalizeAbsolute(absolutePath),
        fileContentHash(absolutePath),
    ] as const);
}

class InferredLanguageServiceSession implements ProgramSession {
    private readonly versions = new Map<string, number>();
    private readonly overrides = new Map<string, string>();
    private readonly languageService: ts.LanguageService;

    constructor(
        private readonly rootPath: string,
        private readonly fileNames: readonly string[],
        private readonly options: ts.CompilerOptions,
    ) {
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => this.options,
            getCurrentDirectory: () => this.rootPath,
            getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
            getScriptFileNames: () => [...this.fileNames],
            getScriptSnapshot: (fileName) => {
                const normalized = normalizeAbsolute(fileName);
                const source = this.overrides.get(normalized)
                    ?? (fs.existsSync(normalized) ? fs.readFileSync(normalized, 'utf8') : undefined);
                return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
            },
            getScriptVersion: (fileName) => String(this.versions.get(normalizeAbsolute(fileName)) ?? 0),
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile,
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
        };
        this.languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    getProgram(): ts.Program {
        const program = this.languageService.getProgram();
        if (!program) throw new Error(`TypeScript inferred LanguageService did not create a Program for '${this.rootPath}'.`);
        return program;
    }

    updateFile(fileName: string, source: string): void {
        const normalized = normalizeAbsolute(fileName);
        this.overrides.set(normalized, source);
        this.versions.set(normalized, (this.versions.get(normalized) ?? 0) + 1);
    }

    dispose(): void {
        this.languageService.dispose();
    }
}

function sourceFileForProgram(program: ts.Program, absolutePath: string): ts.SourceFile | undefined {
    const normalized = normalizeAbsolute(absolutePath);
    const direct = program.getSourceFile(normalized);
    if (direct) return direct;
    return program.getSourceFiles().find((sourceFile) => normalizeAbsolute(sourceFile.fileName) === normalized);
}

function unionReverseDependencies(
    left: ReadonlyMap<string, ReadonlySet<string>> | undefined,
    right: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
    const combined = new Map<string, Set<string>>();
    for (const source of [left, right]) {
        if (!source) continue;
        for (const [target, dependents] of source) {
            const set = combined.get(target) ?? new Set<string>();
            for (const dependent of dependents) set.add(dependent);
            combined.set(target, set);
        }
    }
    return combined;
}

function transitiveDependents(
    starts: readonly string[],
    reverseDependencies: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
    const affected = new Set(starts);
    const queue = [...starts];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const dependent of reverseDependencies.get(current) ?? []) {
            if (affected.has(dependent)) continue;
            affected.add(dependent);
            queue.push(dependent);
        }
    }
    return affected;
}

function buildReverseDependencies(
    program: ts.Program,
    plan: ProjectPlan,
): Map<string, Set<string>> {
    const relativeByAbsolute = new Map(
        plan.absoluteFiles.map((absolute, index) => [normalizeAbsolute(absolute), plan.relativeFiles[index]]),
    );
    const reverse = new Map<string, Set<string>>();
    for (let index = 0; index < plan.absoluteFiles.length; index += 1) {
        const sourceAbsolute = normalizeAbsolute(plan.absoluteFiles[index]);
        const sourceRelative = plan.relativeFiles[index];
        const sourceFile = sourceFileForProgram(program, sourceAbsolute);
        if (!sourceFile) continue;
        const preprocessed = ts.preProcessFile(sourceFile.text, true, true);
        for (const imported of preprocessed.importedFiles) {
            const resolved = ts.resolveModuleName(
                imported.fileName,
                sourceAbsolute,
                plan.options,
                ts.sys,
            ).resolvedModule?.resolvedFileName;
            if (!resolved) continue;
            const targetRelative = relativeByAbsolute.get(normalizeAbsolute(resolved));
            if (!targetRelative) continue;
            const dependents = reverse.get(targetRelative) ?? new Set<string>();
            dependents.add(sourceRelative);
            reverse.set(targetRelative, dependents);
        }
        for (const referenced of preprocessed.referencedFiles) {
            const targetAbsolute = normalizeAbsolute(path.resolve(path.dirname(sourceAbsolute), referenced.fileName));
            const targetRelative = relativeByAbsolute.get(targetAbsolute);
            if (!targetRelative) continue;
            const dependents = reverse.get(targetRelative) ?? new Set<string>();
            dependents.add(sourceRelative);
            reverse.set(targetRelative, dependents);
        }
    }
    return reverse;
}

function sourceCanAffectProjectGlobals(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile || !ts.isExternalModule(sourceFile)) return true;

    const preprocessed = ts.preProcessFile(sourceFile.text, true, true);
    if (
        preprocessed.typeReferenceDirectives.length > 0
        || preprocessed.libReferenceDirectives.length > 0
    ) {
        return true;
    }

    let hasGlobalAugmentation = false;
    const visit = (node: ts.Node): void => {
        if (hasGlobalAugmentation) return;
        if (
            ts.isModuleDeclaration(node)
            && (
                (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0
                || ts.isStringLiteral(node.name)
            )
        ) {
            hasGlobalAugmentation = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return hasGlobalAugmentation;
}

function projectGlobalSourceFiles(program: ts.Program, plan: ProjectPlan): Set<string> {
    const globalFiles = new Set<string>();
    for (let index = 0; index < plan.absoluteFiles.length; index += 1) {
        const sourceFile = sourceFileForProgram(program, plan.absoluteFiles[index]);
        if (sourceFile && sourceCanAffectProjectGlobals(sourceFile)) {
            globalFiles.add(plan.relativeFiles[index]);
        }
    }
    return globalFiles;
}

function diagnosticIdentity(errors: readonly ts.Diagnostic[]): readonly number[] {
    return errors.map((error) => error.code).sort((left, right) => left - right);
}

export class TypeScriptSemanticProjectAnalyzer implements ResolutionProjectAnalyzer {
    private readonly sessions = new Map<string, CachedSession>();
    private snapshots = new Map<string, ProjectSnapshot>();
    private fileToProject = new Map<string, string>();
    private useCounter = 0;

    constructor(private readonly maxSessions: number = DEFAULT_MAX_SESSIONS) {
        if (!Number.isInteger(maxSessions) || maxSessions < 1) {
            throw new Error('TypeScript semantic session cache bound must be a positive integer.');
        }
    }

    supportsLanguage(language: string): boolean {
        return language.trim().toLowerCase() === 'typescript';
    }

    async getSourceControlFiles(input: {
        readonly rootPath: string;
        readonly language: string;
        readonly sourceFiles: readonly string[];
    }): Promise<readonly string[]> {
        if (!this.supportsLanguage(input.language)) return [];
        const plans = this.discoverPlans(input.rootPath, input.sourceFiles.map(normalizeRelative));
        return [...new Set(plans.flatMap((plan) => plan.controlFiles))].sort();
    }

    async analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        if (!this.supportsLanguage(input.language)) {
            throw new Error(`Unsupported resolution language '${input.language}'.`);
        }
        const rootPath = normalizeAbsolute(input.rootPath);
        const typeScriptFiles = input.registry.manifest.files
            .filter((file) => file.language === 'typescript' && isTypeScriptSourcePath(file.path))
            .map((file) => normalizeRelative(file.path))
            .sort();

        if (typeScriptFiles.length === 0) {
            return {
                language: 'typescript',
                providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
                providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                environmentConfigId: `typescript:${ts.version}:empty`,
                claimsByFile: new Map(),
                affectedSourceFiles: new Set(),
                sourceControlFiles: [],
            };
        }

        const plans = this.discoverPlans(rootPath, typeScriptFiles);
        const currentFileToProject = new Map<string, string>();
        for (const plan of plans) {
            for (const file of plan.relativeFiles) currentFileToProject.set(file, plan.key);
        }

        const changedFiles = input.changedFiles
            ? new Set([...input.changedFiles].map(normalizeRelative))
            : undefined;
        const affectedByProject = new Map<string, Set<string>>();
        const currentSnapshots = new Map<string, ProjectSnapshot>();
        const projectReferenceAuthorityReady = new Map<string, boolean>();
        const projectAuthorityChanged = new Set<string>();
        const projectEnvironmentChanged = new Set<string>();
        const claimsByFile = new Map<string, readonly import('./resolution').ResolutionClaim[]>();

        for (const plan of plans) {
            const previous = this.snapshots.get(plan.key);
            const currentFiles = new Set(plan.relativeFiles);
            const membershipChanged = !previous
                || previous.files.size !== currentFiles.size
                || [...currentFiles].some((file) => !previous.files.has(file));
            const environmentChanged = !previous
                || previous.environmentConfigId !== plan.environmentConfigId;
            if (membershipChanged || environmentChanged) {
                projectAuthorityChanged.add(plan.key);
                projectEnvironmentChanged.add(plan.key);
            }

            const session = this.getOrCreateSession(plan);
            const refreshFiles = changedFiles
                ? plan.relativeFiles.filter((file) => changedFiles.has(file))
                : [...plan.relativeFiles];
            for (const relativeFile of refreshFiles) {
                const absoluteFile = normalizeAbsolute(path.join(rootPath, relativeFile));
                if (fs.existsSync(absoluteFile)) {
                    session.updateFile(absoluteFile, fs.readFileSync(absoluteFile, 'utf8'));
                }
            }

            const program = session.getProgram();
            projectReferenceAuthorityReady.set(
                plan.key,
                plan.referencedProjectKeys.length === 0
                    || !program.getSemanticDiagnostics().some((diagnostic) => diagnostic.code === 6305),
            );
            const reverseDependencies = buildReverseDependencies(program, plan);
            const currentProjectGlobalFiles = projectGlobalSourceFiles(program, plan);
            currentSnapshots.set(plan.key, {
                environmentConfigId: plan.environmentConfigId,
                files: currentFiles,
                reverseDependencies,
                projectGlobalSourceFiles: currentProjectGlobalFiles,
                referencedProjectKeys: new Set(plan.referencedProjectKeys),
            });

            const directlyChanged = new Set<string>();
            if (changedFiles) {
                for (const changed of changedFiles) {
                    if (currentFileToProject.get(changed) === plan.key || this.fileToProject.get(changed) === plan.key) {
                        directlyChanged.add(changed);
                    }
                }
            }
            if (directlyChanged.size > 0) projectAuthorityChanged.add(plan.key);

            let affected: Set<string>;
            if (!changedFiles || !previous || membershipChanged || environmentChanged) {
                affected = new Set(plan.relativeFiles);
            } else if ([...directlyChanged].some((file) => (
                currentProjectGlobalFiles.has(file)
                || previous.projectGlobalSourceFiles.has(file)
            ))) {
                affected = new Set(plan.relativeFiles);
            } else {
                affected = transitiveDependents(
                    [...directlyChanged],
                    unionReverseDependencies(previous.reverseDependencies, reverseDependencies),
                );
            }
            affectedByProject.set(plan.key, affected);
        }

        // A referenced project's source/config/output authority can affect dependents
        // without a direct source import. Rebuild those dependent projects conservatively.
        const referenceInvalidatedProjects = new Set<string>();
        let expanded = true;
        while (expanded) {
            expanded = false;
            for (const plan of plans) {
                if (referenceInvalidatedProjects.has(plan.key)) continue;
                if (plan.referencedProjectKeys.some((key) => projectAuthorityChanged.has(key))) {
                    referenceInvalidatedProjects.add(plan.key);
                    projectAuthorityChanged.add(plan.key);
                    affectedByProject.set(plan.key, new Set(plan.relativeFiles));
                    expanded = true;
                }
            }
        }

        // If referenced source authority changed but no referenced output/control identity
        // changed for this project, declarations may be stale. Fail closed until the
        // observable project-reference boundary changes and the Program can prove readiness.
        for (const plan of plans) {
            if (
                plan.referencedProjectKeys.some((key) => projectAuthorityChanged.has(key))
                && !projectEnvironmentChanged.has(plan.key)
            ) {
                projectReferenceAuthorityReady.set(plan.key, false);
            }
        }

        const manifestByPath = new Map(input.registry.manifest.files.map((file) => [file.path, file]));
        const affectedSourceFiles = new Set<string>();

        for (const plan of plans) {
            const affected = affectedByProject.get(plan.key) ?? new Set<string>();
            for (const file of affected) {
                if (manifestByPath.has(file)) affectedSourceFiles.add(file);
            }
            if (affected.size === 0) continue;

            const session = this.sessions.get(plan.key)?.session;
            if (!session) {
                // The session may have been evicted while processing a large multi-project repo.
                const recreated = this.getOrCreateSession(plan);
                for (const relativeFile of plan.relativeFiles) {
                    const absoluteFile = normalizeAbsolute(path.join(rootPath, relativeFile));
                    if (fs.existsSync(absoluteFile) && (!changedFiles || changedFiles.has(relativeFile))) {
                        recreated.updateFile(absoluteFile, fs.readFileSync(absoluteFile, 'utf8'));
                    }
                }
            }
            const activeSession = this.sessions.get(plan.key)!.session;
            const program = activeSession.getProgram();

            if (plan.configErrors.length > 0 || projectReferenceAuthorityReady.get(plan.key) === false) {
                for (const file of affected) {
                    if (manifestByPath.has(file)) claimsByFile.set(file, []);
                }
                continue;
            }

            const programSources: TypeScriptProgramSourceFile[] = [];
            for (let index = 0; index < plan.relativeFiles.length; index += 1) {
                const relativeFile = plan.relativeFiles[index];
                const sourceFile = sourceFileForProgram(program, plan.absoluteFiles[index]);
                if (!sourceFile) continue;
                programSources.push({ projectPath: relativeFile, sourceFile });
            }
            const evidence = analyzeTypeScriptProgram(program, programSources, {
                sourceFiles: new Set([...affected].filter((file) => manifestByPath.has(file))),
            });
            this.assertEvidenceSourcesCurrent(input, evidence, affected);
            const projectClaims = buildTypeScriptResolutionClaims({
                registry: input.registry,
                environmentConfigId: plan.environmentConfigId,
                providerId: evidence.providerId,
                providerVersion: evidence.providerVersion,
                occurrencesByFile: evidence.occurrencesByFile,
                sourceFiles: affected,
            });
            for (const file of affected) {
                if (!manifestByPath.has(file)) continue;
                claimsByFile.set(file, projectClaims.get(file) ?? []);
            }
        }

        const sourceControlFiles = [...new Set(plans.flatMap((plan) => plan.controlFiles))].sort();
        const evidenceEnvironmentConfigId = `typescript:${ts.version}:project-set:${stableHash(
            plans.map((plan) => [plan.key, plan.environmentConfigId]).sort(([left], [right]) => left.localeCompare(right)),
        )}`;

        this.snapshots = currentSnapshots;
        this.fileToProject = currentFileToProject;

        return {
            language: 'typescript',
            providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
            providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
            environmentConfigId: evidenceEnvironmentConfigId,
            claimsByFile,
            affectedSourceFiles,
            sourceControlFiles,
        };
    }

    getSessionStats(): { readonly active: number; readonly max: number; readonly keys: readonly string[] } {
        return {
            active: this.sessions.size,
            max: this.maxSessions,
            keys: [...this.sessions.keys()].sort(),
        };
    }

    async dispose(): Promise<void> {
        for (const cached of this.sessions.values()) cached.session.dispose();
        this.sessions.clear();
        this.snapshots.clear();
        this.fileToProject.clear();
    }

    private discoverPlans(rootPath: string, relativeFiles: readonly string[]): ProjectPlan[] {
        const normalizedRoot = normalizeAbsolute(rootPath);
        const configCache = new Map<string, TypeScriptConfiguredProject>();
        const configuredGroups = new Map<string, string[]>();
        const inferredFiles: string[] = [];

        const load = (configPath: string): TypeScriptConfiguredProject => {
            const normalized = normalizeAbsolute(configPath);
            const cached = configCache.get(normalized);
            if (cached) return cached;
            const project = loadTypeScriptConfiguredProject(normalized);
            configCache.set(normalized, project);
            return project;
        };

        for (const relativeFile of relativeFiles) {
            const absoluteFile = normalizeAbsolute(path.join(normalizedRoot, relativeFile));
            let selected: TypeScriptConfiguredProject | undefined;
            for (const configPath of candidateConfigPaths(normalizedRoot, absoluteFile)) {
                const project = load(configPath);
                if (project.fileNames.includes(absoluteFile)) {
                    selected = project;
                    break;
                }
            }
            if (!selected) {
                inferredFiles.push(relativeFile);
                continue;
            }
            const group = configuredGroups.get(selected.configPath) ?? [];
            group.push(relativeFile);
            configuredGroups.set(selected.configPath, group);
        }

        const plans: ProjectPlan[] = [];
        for (const [configPath, files] of [...configuredGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            const project = load(configPath);
            const sortedFiles = [...files].sort();
            const absoluteFiles = sortedFiles.map((file) => normalizeAbsolute(path.join(normalizedRoot, file)));
            const control = projectControlFiles(normalizedRoot, project, absoluteFiles);
            const environmentConfigId = `typescript:${ts.version}:configured:${stableHash({
                providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                compilerVersion: ts.version,
                configPath: project.configPath,
                projectHash: project.identity.projectHash,
                compilerOptions: normalizedCompilerOptions(project.options),
                registryFiles: sortedFiles,
                configErrors: diagnosticIdentity(project.errors),
                controls: controlIdentity(normalizedRoot, control.controls),
            })}`;
            plans.push({
                key: configuredProjectKey(project.configPath),
                mode: 'configured',
                rootPath: normalizedRoot,
                configPath: project.configPath,
                relativeFiles: sortedFiles,
                absoluteFiles,
                options: project.options,
                configErrors: project.errors,
                controlFiles: control.controls
                    .map((file) => relativeInsideRoot(normalizedRoot, file))
                    .filter((file): file is string => Boolean(file)),
                environmentConfigId,
                referencedProjectKeys: control.referencedProjectKeys,
            });
        }

        if (inferredFiles.length > 0) {
            const sortedFiles = [...inferredFiles].sort();
            const absoluteFiles = sortedFiles.map((file) => normalizeAbsolute(path.join(normalizedRoot, file)));
            const options = inferredCompilerOptions();
            const controls = packageControlFiles(normalizedRoot, absoluteFiles);
            const environmentConfigId = `typescript:${ts.version}:inferred:${stableHash({
                providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                compilerVersion: ts.version,
                rootPath: normalizedRoot,
                compilerOptions: normalizedCompilerOptions(options),
                registryFiles: sortedFiles,
                controls: controlIdentity(normalizedRoot, controls),
            })}`;
            plans.push({
                key: inferredProjectKey(normalizedRoot),
                mode: 'inferred',
                rootPath: normalizedRoot,
                relativeFiles: sortedFiles,
                absoluteFiles,
                options,
                configErrors: [],
                controlFiles: controls
                    .map((file) => relativeInsideRoot(normalizedRoot, file))
                    .filter((file): file is string => Boolean(file)),
                environmentConfigId,
                referencedProjectKeys: [],
            });
        }

        return plans.sort((left, right) => left.key.localeCompare(right.key));
    }

    private getOrCreateSession(plan: ProjectPlan): ProgramSession {
        const existing = this.sessions.get(plan.key);
        if (existing && existing.environmentConfigId === plan.environmentConfigId) {
            existing.lastUsed = ++this.useCounter;
            return existing.session;
        }
        if (existing) {
            existing.session.dispose();
            this.sessions.delete(plan.key);
        }

        const session: ProgramSession = plan.mode === 'configured'
            ? new TypeScriptLanguageServiceSession(plan.configPath!)
            : new InferredLanguageServiceSession(plan.rootPath, plan.absoluteFiles, plan.options);
        this.sessions.set(plan.key, {
            key: plan.key,
            environmentConfigId: plan.environmentConfigId,
            session,
            lastUsed: ++this.useCounter,
        });
        this.evictSessions();
        return this.sessions.get(plan.key)?.session ?? session;
    }

    private evictSessions(): void {
        while (this.sessions.size > this.maxSessions) {
            const victim = [...this.sessions.values()].sort((left, right) => (
                left.lastUsed - right.lastUsed || left.key.localeCompare(right.key)
            ))[0];
            victim.session.dispose();
            this.sessions.delete(victim.key);
        }
    }

    private assertEvidenceSourcesCurrent(
        input: ResolutionProjectInput,
        evidence: TypeScriptProjectEvidence,
        affected: ReadonlySet<string>,
    ): void {
        const manifestByPath = new Map(input.registry.manifest.files.map((file) => [file.path, file]));
        const filesToVerify = new Set<string>();
        for (const [sourceFile, occurrences] of evidence.occurrencesByFile) {
            if (affected.has(sourceFile)) filesToVerify.add(sourceFile);
            for (const occurrence of occurrences) {
                if (occurrence.target) filesToVerify.add(occurrence.target.file);
                for (const candidate of occurrence.candidates ?? []) filesToVerify.add(candidate.file);
            }
        }
        for (const relativeFile of filesToVerify) {
            const manifest = manifestByPath.get(relativeFile);
            if (!manifest) continue;
            const absolute = normalizeAbsolute(path.join(input.rootPath, relativeFile));
            if (!fs.existsSync(absolute)) {
                throw new Error(`TypeScript semantic source disappeared before claim publication: '${relativeFile}'.`);
            }
            const currentHash = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
            if (currentHash !== manifest.hash) {
                throw new Error(`TypeScript semantic source changed before claim publication: '${relativeFile}'.`);
            }
        }
    }
}
