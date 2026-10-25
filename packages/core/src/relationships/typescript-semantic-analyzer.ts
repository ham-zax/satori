import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import * as ts from '../semantic/typescript-api';
import { TypeScriptProgramSession } from '../semantic/typescript-program-session';

import {
    TYPESCRIPT_COMPILER_PROVIDER_ID,
    TYPESCRIPT_COMPILER_PROVIDER_VERSION,
    analyzeTypeScriptProgram,
    type TypeScriptProjectEvidence,
    type TypeScriptProgramSourceFile,
} from '../semantic/typescript-compiler-provider';
import {
    TypeScriptLanguageServiceSession,
    TypeScriptSourceBudgetTracker,
    loadTypeScriptConfiguredProject,
    TypeScriptConfigReadError,
    type TypeScriptConfiguredProject,
    type TypeScriptSourceBudget,
} from '../semantic/typescript-configured-project';
import type {
    ResolutionProjectAnalyzer,
    ResolutionProjectEvidence,
    ResolutionProjectInput,
} from './resolution';
import { buildTypeScriptResolutionClaims } from './typescript-resolution';
import type { TypeScriptResourceFailureRank, TypeScriptShardEvidence } from './typescript-resolution-shards';
import { perfTrace } from '../utils/perf-trace';

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
// Warm LanguageServices make back-to-back syncs cheap but hold hundreds of MB;
// release them once syncs stop.
const DEFAULT_SESSION_IDLE_RELEASE_MS = 2 * 60_000;
export const DEFAULT_MAX_TYPESCRIPT_SEMANTIC_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_TYPESCRIPT_SEMANTIC_PROJECT_BYTES = 64 * 1024 * 1024;

export type TypeScriptSemanticResourceBudget = TypeScriptSourceBudget;

const DEFAULT_TYPESCRIPT_SEMANTIC_RESOURCE_BUDGET: TypeScriptSemanticResourceBudget = Object.freeze({
    maxFileBytes: DEFAULT_MAX_TYPESCRIPT_SEMANTIC_SOURCE_FILE_BYTES,
    maxProjectBytes: DEFAULT_MAX_TYPESCRIPT_SEMANTIC_PROJECT_BYTES,
});

type ProjectMode = 'configured' | 'inferred';

interface ProgramSession {
    getProgram(): ts.Program;
    getResourceLimitFailure(): string | undefined;
    resolveModuleName(containingFile: string, specifier: string, mode: ts.ResolutionMode): string | undefined;
    updateFile(fileName: string, source: string): void;
    /** Makes the next Program re-read `fileName` from disk. */
    invalidateFile(fileName: string): void;
    dispose(): void;
}

interface ProjectPlan {
    readonly key: string;
    readonly mode: ProjectMode;
    readonly rootPath: string;
    readonly configPath?: string;
    readonly relativeFiles: readonly string[];
    readonly absoluteFiles: readonly string[];
    /** Compiler root files that the configured/inferred LanguageService can load. */
    readonly compilerRootFiles: readonly string[];
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
    /** Effective reference authority; when false every project file is unavailable. */
    readonly referenceAuthorityReady?: boolean;
    /** Some import did not resolve, so an added file can change what it resolves to. */
    readonly unresolvedImports: boolean;
}

/**
 * What one analysis of a root leaves for the next delta. It is valid only as
 * the base of a delta from the exact registry it was computed for.
 */
interface RootResolutionState {
    readonly registryDigest: string;
    readonly snapshots: ReadonlyMap<string, ProjectSnapshot>;
    readonly fileToProject: ReadonlyMap<string, string>;
}

const ROOT_RESOLUTION_STATE_FORMAT = 1;

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

function registryDigest(registry: ResolutionProjectInput['registry']): string {
    return stableHash(registry.manifest.files.map((file) => `${normalizeRelative(file.path)}\0${file.hash}`).sort());
}

function serializeRootState(rootPath: string, state: RootResolutionState): string {
    return JSON.stringify({
        format: ROOT_RESOLUTION_STATE_FORMAT,
        providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
        compilerVersion: ts.version,
        rootPath,
        registryDigest: state.registryDigest,
        fileToProject: [...state.fileToProject],
        snapshots: [...state.snapshots].map(([key, snapshot]) => [key, {
            environmentConfigId: snapshot.environmentConfigId,
            files: [...snapshot.files],
            reverseDependencies: [...snapshot.reverseDependencies].map(([target, dependents]) => [target, [...dependents]]),
            projectGlobalSourceFiles: [...snapshot.projectGlobalSourceFiles],
            referencedProjectKeys: [...snapshot.referencedProjectKeys],
            referenceAuthorityReady: snapshot.referenceAuthorityReady,
            unresolvedImports: snapshot.unresolvedImports,
        }]),
    });
}

/** Parses persisted state; anything unexpected yields undefined (a full analysis). */
function parseRootState(text: string, rootPath: string): RootResolutionState | undefined {
    const strings = (value: unknown): string[] => {
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error('shape');
        return value;
    };
    const pairs = (value: unknown): unknown[][] => {
        if (!Array.isArray(value) || !value.every((entry) => Array.isArray(entry) && entry.length === 2)) throw new Error('shape');
        return value;
    };
    try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        if (
            raw.format !== ROOT_RESOLUTION_STATE_FORMAT
            || raw.providerVersion !== TYPESCRIPT_COMPILER_PROVIDER_VERSION
            || raw.compilerVersion !== ts.version
            || raw.rootPath !== rootPath
            || typeof raw.registryDigest !== 'string'
        ) {
            return undefined;
        }
        const fileToProject = new Map(pairs(raw.fileToProject).map(([file, key]) => strings([file, key]) as [string, string]));
        const snapshots = new Map<string, ProjectSnapshot>();
        for (const [key, value] of pairs(raw.snapshots)) {
            const snapshot = value as Record<string, unknown>;
            // Readiness is absent for projects another shard analyzes.
            if (
                typeof key !== 'string'
                || typeof snapshot.environmentConfigId !== 'string'
                || (snapshot.referenceAuthorityReady !== undefined && typeof snapshot.referenceAuthorityReady !== 'boolean')
                || typeof snapshot.unresolvedImports !== 'boolean'
            ) {
                return undefined;
            }
            snapshots.set(key, {
                environmentConfigId: snapshot.environmentConfigId,
                files: new Set(strings(snapshot.files)),
                reverseDependencies: new Map(pairs(snapshot.reverseDependencies).map(([target, dependents]) => (
                    [strings([target])[0], new Set(strings(dependents))]
                ))),
                projectGlobalSourceFiles: new Set(strings(snapshot.projectGlobalSourceFiles)),
                referencedProjectKeys: new Set(strings(snapshot.referencedProjectKeys)),
                ...(snapshot.referenceAuthorityReady === undefined
                    ? {}
                    : { referenceAuthorityReady: snapshot.referenceAuthorityReady as boolean }),
                unresolvedImports: snapshot.unresolvedImports,
            });
        }
        return { registryDigest: raw.registryDigest, snapshots, fileToProject };
    } catch {
        return undefined;
    }
}

function fileContentHash(filePath: string): string {
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r');
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
            if (bytesRead <= 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        return hash.digest('hex');
    } catch {
        return 'missing';
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
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
    const api = new ts.API({ runExternalCode: false });
    try {
        const read = api.readConfigFile(configPath);
        if (read.error || !read.config || typeof read.config !== 'object') return [];
        const raw = (read.config as { extends?: unknown }).extends;
        return (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
            .filter((value): value is string => typeof value === 'string' && value.length > 0);
    } finally { api.close(); }
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

interface ReferenceDeclarationState {
    /** Declaration outputs this config expects, normalized. */
    readonly outputs: readonly string[];
    /** Project references of this config, resolved to config paths. */
    readonly references: readonly string[];
    /** Outputs alone cannot prove readiness for this config. */
    readonly unproven: boolean;
}

interface CachedReferenceDeclarationState {
    readonly fingerprint: string;
    readonly state: ReferenceDeclarationState;
}

// Emitting declarations builds the reference's whole program, which costs about
// a second on a large project. Repeat analyses of the same reference reuse the
// output list; the fingerprint covers the config chain and the file list, while
// output existence is checked per analysis.
const referenceDeclarationStates = new Map<string, CachedReferenceDeclarationState>();

function projectReferenceConfigs(configPath: string): readonly string[] {
    const api = new ts.API({ runExternalCode: false });
    try {
        const parsed = api.parseConfigFile(normalizeAbsolute(configPath));
        return (parsed.projectReferences ?? [])
            .map(reference => resolveProjectReferenceConfig(reference.path))
            .filter((value): value is string => value !== undefined);
    } finally { api.close(); }
}

function referenceDeclarationState(configPath: string): ReferenceDeclarationState {
    const normalized = normalizeAbsolute(configPath);
    const api = new ts.API({ runExternalCode: false });
    try {
        const parsed = api.parseConfigFile(normalized);
        const references = (parsed.projectReferences ?? [])
            .map(reference => resolveProjectReferenceConfig(reference.path))
            .filter((value): value is string => value !== undefined);
        const fingerprint = createHash('sha256').update(JSON.stringify({
            chain: collectConfigChain(normalized).map(file => [file, fileContentHash(file)]),
            files: parsed.fileNames,
        })).digest('hex');
        const cached = referenceDeclarationStates.get(normalized);
        if (cached?.fingerprint === fingerprint) return cached.state;
        let state: ReferenceDeclarationState;
        if (!parsed.options.declaration && !parsed.options.composite) {
            // A reference that emits no declarations cannot prove readiness: the
            // checker still expects an output and reports TS6305 without it.
            state = { outputs: [], references, unproven: true };
        } else {
            const program = api.createProgram(
                parsed.fileNames,
                { ...parsed.options, noEmit: false },
                { projectReferences: parsed.projectReferences },
            );
            try {
                // The compiler computes output paths, including declarationDir,
                // outDir and bundled declarations. Never duplicate those rules.
                state = {
                    outputs: [...program.getDeclarationEmit(parsed.fileNames).outputFiles.keys()]
                        .filter(file => /\.d\.[cm]?ts$/.test(file)).map(normalizeAbsolute).sort(),
                    references,
                    unproven: false,
                };
            } finally { program.dispose(); }
        }
        referenceDeclarationStates.set(normalized, { fingerprint, state });
        return state;
    } finally { api.close(); }
}

/**
 * Proves that the checker cannot report TS6305 ("Output file has not been built
 * from source file") for a configured project: every declaration output of
 * every referenced project exists on disk. Native diagnostics stay
 * authoritative, so this returns `undefined` whenever outputs alone cannot
 * prove readiness: a missing output, a reference without declaration emit, or
 * an unreadable config. A `true` result means no TS6305 is possible.
 */
export function referenceAuthorityReady(projectConfigPath: string): true | undefined {
    const visited = new Set<string>();
    const pending = [...projectReferenceConfigs(projectConfigPath)];
    while (pending.length > 0) {
        const configPath = pending.pop()!;
        if (visited.has(configPath)) continue;
        visited.add(configPath);
        const state = referenceDeclarationState(configPath);
        if (state.unproven) return undefined;
        for (const output of state.outputs) {
            if (!fs.existsSync(output)) return undefined;
        }
        pending.push(...state.references);
    }
    return true;
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
            for (const output of referenceDeclarationState(referenceConfig).outputs) {
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

function projectSetEnvironmentConfigId(
    plans: readonly ProjectPlan[],
    resourceBudget: TypeScriptSemanticResourceBudget,
): string {
    return `typescript:${ts.version}:project-set:${stableHash({
        providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
        resourceBudget,
        projects: plans
            .map((plan) => [plan.key, plan.environmentConfigId] as const)
            .sort(([left], [right]) => left.localeCompare(right)),
    })}`;
}

function compilerRootResourceFailure(
    plans: readonly ProjectPlan[],
    resourceBudget: TypeScriptSemanticResourceBudget,
): string | undefined {
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const plan of plans) {
        for (const compilerRootFile of plan.compilerRootFiles) {
            const absoluteFile = normalizeAbsolute(compilerRootFile);
            if (seen.has(absoluteFile)) continue;
            seen.add(absoluteFile);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(absoluteFile);
            } catch {
                continue;
            }
            if (!stat.isFile()) continue;
            if (stat.size > resourceBudget.maxFileBytes) {
                return `TypeScript semantic source '${absoluteFile}' is ${stat.size} bytes, exceeding the ${resourceBudget.maxFileBytes} byte per-file budget.`;
            }
            totalBytes += stat.size;
            if (totalBytes > resourceBudget.maxProjectBytes) {
                return `TypeScript semantic root source bytes reached ${totalBytes}, exceeding the ${resourceBudget.maxProjectBytes} byte project budget.`;
            }
        }
    }
    return undefined;
}

class InferredLanguageServiceSession extends TypeScriptProgramSession implements ProgramSession {
    constructor(rootPath: string, fileNames: readonly string[], options: ts.CompilerOptions, resourceBudget: TypeScriptSourceBudget) {
        super(rootPath, fileNames, options, new TypeScriptSourceBudgetTracker(resourceBudget));
    }
}

function sourceFileForProgram(program: ts.Program, absolutePath: string): ts.SourceFile | undefined {
    const normalized = normalizeAbsolute(absolutePath);
    const direct = program.getSourceFile(normalized);
    if (direct) return direct;
    return program.getSourceFileNames().map(name => program.getSourceFile(name)!).find((sourceFile) => normalizeAbsolute(sourceFile.fileName) === normalized);
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

/**
 * `require()` argument literals. The native `SourceFile.imports` omits them for
 * TypeScript files, while the retired `preProcessFile(..., true, true)` scan
 * included them. A missing edge here leaves an importer stale after the
 * required target changes.
 */
function requireCallSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteralLikeNode[] {
    const specifiers: ts.StringLiteralLikeNode[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node)
            && node.arguments.length > 0
            && ts.isIdentifier(node.expression)
            && node.expression.text === 'require'
        ) {
            const argument = node.arguments[0];
            if (ts.isStringLiteralLikeNode(argument)) specifiers.push(argument);
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    return specifiers;
}

/**
 * Import edges from this project's files, keyed by the imported file. Targets
 * include indexed files outside the project (a relative import into another
 * project's source), since a change there can change the importer's claims.
 */
function buildReverseDependencies(
    program: ts.Program,
    plan: ProjectPlan,
    manifestPaths: ReadonlySet<string>,
    session: ProgramSession,
): { reverse: Map<string, Set<string>>; unresolvedImports: boolean } {
    const relativeByAbsolute = new Map(
        plan.absoluteFiles.map((absolute, index) => [normalizeAbsolute(absolute), plan.relativeFiles[index]]),
    );
    const targetOf = (absolute: string): string | undefined => {
        const normalized = normalizeAbsolute(absolute);
        const own = relativeByAbsolute.get(normalized);
        if (own) return own;
        const relative = relativeInsideRoot(plan.rootPath, normalized);
        return relative && manifestPaths.has(relative) ? relative : undefined;
    };
    const reverse = new Map<string, Set<string>>();
    const addEdge = (targetRelative: string, sourceRelative: string) => {
        const dependents = reverse.get(targetRelative) ?? new Set<string>();
        dependents.add(sourceRelative);
        reverse.set(targetRelative, dependents);
    };
    let unresolvedImports = false;
    for (let index = 0; index < plan.absoluteFiles.length; index += 1) {
        const sourceAbsolute = normalizeAbsolute(plan.absoluteFiles[index]);
        const sourceRelative = plan.relativeFiles[index];
        const sourceFile = sourceFileForProgram(program, sourceAbsolute);
        if (!sourceFile) continue;
        const required = requireCallSpecifiers(sourceFile);
        const requiredSpecifiers = new Set<ts.Node>(required);
        const specifiers = new Set<ts.Node>(sourceFile.imports);
        for (const requiredLiteral of required) specifiers.add(requiredLiteral);
        for (const imported of specifiers) {
            if (!ts.isStringLiteralLikeNode(imported)) continue;
            const mode = program.getModeForUsageLocation(sourceFile.fileName, imported);
            // The program resolves import sites only, so a require() argument
            // needs the session's resolver to become an edge.
            const resolved = program.getResolvedModule(sourceFile.fileName, imported.text, mode)?.resolvedFileName
                ?? (requiredSpecifiers.has(imported)
                    ? session.resolveModuleName(sourceFile.fileName, imported.text, mode as ts.ResolutionMode)
                    : undefined);
            if (!resolved) {
                unresolvedImports = true;
                continue;
            }
            const targetRelative = targetOf(resolved);
            if (targetRelative) addEdge(targetRelative, sourceRelative);
        }
        for (const referenced of sourceFile.referencedFiles) {
            const targetAbsolute = normalizeAbsolute(path.resolve(path.dirname(sourceAbsolute), referenced.fileName));
            if (!sourceFileForProgram(program, targetAbsolute)) unresolvedImports = true;
            const targetRelative = targetOf(targetAbsolute);
            if (targetRelative) addEdge(targetRelative, sourceRelative);
        }
    }
    return { reverse, unresolvedImports };
}

function sourceCanAffectProjectGlobals(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile || !ts.isExternalModule(sourceFile)) return true;

    if (
        sourceFile.typeReferenceDirectives.length > 0
        || sourceFile.libReferenceDirectives.length > 0
    ) {
        return true;
    }

    let hasGlobalAugmentation = false;
    const visit = (node: ts.Node): void => {
        if (hasGlobalAugmentation) return;
        if (
            ts.isModuleDeclaration(node)
            && (
                (ts.isIdentifier(node.name) && node.name.text === 'global')
                || ts.isStringLiteral(node.name)
            )
        ) {
            hasGlobalAugmentation = true;
            return;
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    return hasGlobalAugmentation;
}

/** Files in the Program, this project's or other indexed ones, that can declare globals. */
function projectGlobalSourceFiles(
    program: ts.Program,
    plan: ProjectPlan,
    manifestPaths: ReadonlySet<string>,
): Set<string> {
    const globalFiles = new Set<string>();
    for (let index = 0; index < plan.absoluteFiles.length; index += 1) {
        const sourceFile = sourceFileForProgram(program, plan.absoluteFiles[index]);
        if (sourceFile && sourceCanAffectProjectGlobals(sourceFile)) {
            globalFiles.add(plan.relativeFiles[index]);
        }
    }
    for (const sourceFile of program.getSourceFileNames().map(name => program.getSourceFile(name)!)) {
        const relative = relativeInsideRoot(plan.rootPath, normalizeAbsolute(sourceFile.fileName));
        if (!relative || globalFiles.has(relative) || !manifestPaths.has(relative)) continue;
        if (sourceCanAffectProjectGlobals(sourceFile)) globalFiles.add(relative);
    }
    return globalFiles;
}

function diagnosticIdentity(errors: readonly ts.Diagnostic[]): readonly number[] {
    return errors.map((error) => error.code).sort((left, right) => left - right);
}


export interface TypeScriptSemanticAnalyzerOptions {
    /**
     * Where each root's last state is kept, so a delta in a new process (the
     * sync worker is one per operation) does not re-analyze every file.
     */
    readonly stateDirectory?: string;
    /**
     * Analyze only the projects this shard owns; other shards analyze the rest
     * and their evidence is merged (see typescript-resolution-shards).
     */
    readonly shard?: Readonly<{ index: number; count: number }>;
    /** A full-index job owns one intact project, including its import closure. */
    readonly projectKey?: string;
}

/**
 * Largest projects first, each to the least-loaded shard. Deterministic for a
 * given plan set, so every shard derives the same assignment.
 */
function assignProjectShards(plans: readonly ProjectPlan[], count: number): Map<string, number> {
    const loads = new Array<number>(count).fill(0);
    const owner = new Map<string, number>();
    const bySize = [...plans].sort((left, right) => (
        right.relativeFiles.length - left.relativeFiles.length || left.key.localeCompare(right.key)
    ));
    for (const plan of bySize) {
        let target = 0;
        for (let index = 1; index < count; index += 1) {
            if (loads[index] < loads[target]) target = index;
        }
        owner.set(plan.key, target);
        loads[target] += plan.relativeFiles.length;
    }
    return owner;
}

export class TypeScriptSemanticProjectAnalyzer implements ResolutionProjectAnalyzer {
    private readonly sessions = new Map<string, CachedSession>();
    private readonly rootStates = new Map<string, RootResolutionState>();
    private useCounter = 0;
    private activeAnalyses = 0;
    private projectFailureRank: TypeScriptResourceFailureRank = [0, 0];
    private idleReleaseTimer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
        private readonly resourceBudget: TypeScriptSemanticResourceBudget =
            DEFAULT_TYPESCRIPT_SEMANTIC_RESOURCE_BUDGET,
        private readonly idleReleaseMs: number = DEFAULT_SESSION_IDLE_RELEASE_MS,
        private readonly options: TypeScriptSemanticAnalyzerOptions = {},
    ) {
        if (!Number.isInteger(maxSessions) || maxSessions < 1) {
            throw new Error('TypeScript semantic session cache bound must be a positive integer.');
        }
        if (
            !Number.isSafeInteger(resourceBudget.maxFileBytes)
            || resourceBudget.maxFileBytes <= 0
            || !Number.isSafeInteger(resourceBudget.maxProjectBytes)
            || resourceBudget.maxProjectBytes <= 0
        ) {
            throw new Error('TypeScript semantic resource budgets must be positive safe integers.');
        }
    }

    supportsLanguage(language: string): boolean {
        return language.trim().toLowerCase() === 'typescript';
    }

    getProviderMetadata(language: string) {
        if (!this.supportsLanguage(language)) return undefined;
        return {
            providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
            providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
        };
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
        return (await this.analyzeShard(input)).evidence;
    }

    /** Discovery does not construct a compiler Program. Preserve legacy failure order. */
    getProjectJobs(input: ResolutionProjectInput, shardCount: number): readonly { key: string; shardIndex: number }[] {
        const files = input.registry.manifest.files
            .filter((file) => file.language === 'typescript' && isTypeScriptSourcePath(file.path))
            .map((file) => normalizeRelative(file.path)).sort();
        const plans = this.discoverPlans(input.rootPath, files);
        const owners = assignProjectShards(plans, shardCount);
        return plans.map((plan) => ({ key: plan.key, shardIndex: owners.get(plan.key)! }))
            .sort((left, right) => left.shardIndex - right.shardIndex);
    }

    exportRootState(rootPath: string): string | undefined {
        const root = normalizeAbsolute(rootPath);
        const state = this.rootStates.get(root);
        return state ? serializeRootState(root, state) : undefined;
    }

    getProjectFailureRank(): TypeScriptResourceFailureRank {
        return this.projectFailureRank;
    }

    /** Seed the existing delta owner with compact snapshots, never compiler objects. */
    importProjectStates(rootPath: string, states: readonly string[]): void {
        const root = normalizeAbsolute(rootPath);
        let merged: RootResolutionState | undefined;
        const snapshots = new Map<string, ProjectSnapshot>();
        for (const text of states) {
            const state = parseRootState(text, root);
            if (!state || (merged && state.registryDigest !== merged.registryDigest)) {
                throw new Error('Inconsistent TypeScript project job state.');
            }
            merged = state;
            for (const [key, snapshot] of state.snapshots) {
                if (!snapshots.has(key) || snapshot.referenceAuthorityReady !== undefined) snapshots.set(key, snapshot);
            }
        }
        if (!merged) return;
        const state = { ...merged, snapshots };
        this.rootStates.set(root, state);
        this.persistRootState(root, state);
    }

    /** `analyze`, plus where a resource-limit failure was met, for merging shards. */
    async analyzeShard(input: ResolutionProjectInput): Promise<TypeScriptShardEvidence> {
        clearTimeout(this.idleReleaseTimer);
        this.activeAnalyses += 1;
        this.projectFailureRank = [0, 0];
        try {
            return await this.analyzeProjects(input);
        } finally {
            this.activeAnalyses -= 1;
            this.scheduleIdleRelease();
        }
    }

    private scheduleIdleRelease(): void {
        if (this.activeAnalyses > 0 || this.idleReleaseMs <= 0 || this.sessions.size === 0) return;
        this.idleReleaseTimer = setTimeout(() => {
            if (this.activeAnalyses === 0) this.clearSessionState();
        }, this.idleReleaseMs);
        this.idleReleaseTimer.unref?.();
    }

    private async analyzeProjects(input: ResolutionProjectInput): Promise<TypeScriptShardEvidence> {
        if (!this.supportsLanguage(input.language)) {
            throw new Error(`Unsupported resolution language '${input.language}'.`);
        }
        const rootPath = normalizeAbsolute(input.rootPath);
        const typeScriptFiles = input.registry.manifest.files
            .filter((file) => file.language === 'typescript' && isTypeScriptSourcePath(file.path))
            .map((file) => normalizeRelative(file.path))
            .sort();

        if (typeScriptFiles.length === 0) {
            return { evidence: {
                language: 'typescript',
                providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
                providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                environmentConfigId: `typescript:${ts.version}:empty`,
                claimsByFile: new Map(),
                affectedSourceFiles: new Set(),
                sourceControlFiles: [],
                coverage: {
                    language: 'typescript',
                    providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
                    providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                    environmentConfigId: `typescript:${ts.version}:empty`,
                    status: 'complete',
                    sourceFileCount: 0,
                    analyzedSourceFileCount: 0,
                },
            } };
        }

        const plans = this.discoverPlans(rootPath, typeScriptFiles);
        const shard = this.options.shard;
        const shardOwner = shard ? assignProjectShards(plans, shard.count) : undefined;
        const owns = (plan: ProjectPlan) => this.options.projectKey !== undefined
            ? plan.key === this.options.projectKey
            : !shard || shardOwner!.get(plan.key) === shard.index;
        const planIndex = new Map(plans.map((plan, index) => [plan.key, index]));
        const currentFileToProject = new Map<string, string>();
        for (const plan of plans) {
            for (const file of plan.relativeFiles) currentFileToProject.set(file, plan.key);
        }
        const sourceControlFiles = [...new Set(plans.flatMap((plan) => plan.controlFiles))].sort();
        const evidenceEnvironmentConfigId = projectSetEnvironmentConfigId(plans, this.resourceBudget);
        const resourceLimitEvidence = (
            failureMessage: string,
            resourceFailure: TypeScriptResourceFailureRank,
        ): TypeScriptShardEvidence => {
            this.clearSessionState();
            return { resourceFailure, evidence: {
                language: 'typescript',
                providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
                providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                environmentConfigId: evidenceEnvironmentConfigId,
                claimsByFile: new Map(),
                affectedSourceFiles: new Set(typeScriptFiles),
                sourceControlFiles,
                coverage: {
                    language: 'typescript',
                    providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
                    providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                    environmentConfigId: evidenceEnvironmentConfigId,
                    status: 'unavailable',
                    sourceFileCount: typeScriptFiles.length,
                    analyzedSourceFileCount: 0,
                    failureReason: 'resource_limit',
                    failureMessage,
                },
            } };
        };
        const rootResourceFailure = compilerRootResourceFailure(plans, this.resourceBudget);
        if (rootResourceFailure) {
            return resourceLimitEvidence(rootResourceFailure, [0, 0]);
        }

        const changedFiles = input.changedFiles
            ? new Set([...input.changedFiles].map(normalizeRelative))
            : undefined;
        const previousState = changedFiles ? this.previousRootState(rootPath, input.previousRegistry) : undefined;
        const manifestPaths = new Set(input.registry.manifest.files.map((file) => normalizeRelative(file.path)));
        const previousManifestPaths = new Set(
            input.previousRegistry?.manifest.files.map((file) => normalizeRelative(file.path)) ?? [],
        );
        const filesAdded = changedFiles !== undefined
            && [...changedFiles].some((file) => !previousManifestPaths.has(file));
        const affectedByProject = new Map<string, Set<string>>();
        const currentSnapshots = new Map<string, ProjectSnapshot>();
        const projectReferenceAuthorityReady = new Map<string, boolean>();
        const projectEnvironmentChanged = new Set<string>();
        const claimsByFile = new Map<string, readonly import('./resolution').ResolutionClaim[]>();

        // Without a validated base, a warm session may hold files that changed
        // since it last analyzed; start this root's sessions fresh.
        if (!previousState) {
            for (const plan of plans) this.releaseSession(plan.key);
        }

        for (const plan of plans) {
            const previous = previousState?.snapshots.get(plan.key);
            if (
                !previous
                || previous.environmentConfigId !== plan.environmentConfigId
                || previous.files.size !== plan.relativeFiles.length
                || plan.relativeFiles.some((file) => !previous.files.has(file))
            ) {
                projectEnvironmentChanged.add(plan.key);
            }
        }

        // A referenced project's configuration, membership, or outputs can change
        // how dependents resolve it (and whether they are ready) without a changed
        // import. Rebuild those dependents whole. A source edit alone reaches
        // dependents only through their Programs, which see the referenced
        // outputs, or through the import edges below.
        const referenceInvalidated = new Set(projectEnvironmentChanged);
        let expanded = true;
        while (expanded) {
            expanded = false;
            for (const plan of plans) {
                if (referenceInvalidated.has(plan.key)) continue;
                if (plan.referencedProjectKeys.some((key) => referenceInvalidated.has(key))) {
                    referenceInvalidated.add(plan.key);
                    expanded = true;
                }
            }
        }

        for (const plan of plans) {
            const currentFiles = new Set(plan.relativeFiles);
            if (!owns(plan)) {
                // Another shard analyzes this project; keep only what reference
                // propagation needs next time.
                currentSnapshots.set(plan.key, {
                    environmentConfigId: plan.environmentConfigId,
                    files: currentFiles,
                    reverseDependencies: new Map(),
                    projectGlobalSourceFiles: new Set(),
                    referencedProjectKeys: new Set(plan.referencedProjectKeys),
                    unresolvedImports: false,
                });
                continue;
            }
            this.projectFailureRank = [1, planIndex.get(plan.key)!];
            // A snapshot without readiness was kept for another shard's project.
            const kept = previousState?.snapshots.get(plan.key);
            const previous = kept?.referenceAuthorityReady === undefined ? undefined : kept;
            const environmentChanged = referenceInvalidated.has(plan.key);

            // Changed files the previous analysis of this project depended on:
            // its own, and indexed files elsewhere that it imported or took globals from.
            const directlyChanged = new Set<string>();
            if (changedFiles) {
                for (const changed of changedFiles) {
                    if (
                        currentFileToProject.get(changed) === plan.key
                        || previousState?.fileToProject.get(changed) === plan.key
                        || previous?.reverseDependencies.has(changed)
                        || previous?.projectGlobalSourceFiles.has(changed)
                    ) {
                        directlyChanged.add(changed);
                    }
                }
            }

            const existingSession = this.sessions.get(plan.key);
            if (changedFiles && existingSession?.environmentConfigId === plan.environmentConfigId) {
                for (const changed of changedFiles) {
                    if (!currentFiles.has(changed)) {
                        existingSession.session.invalidateFile(normalizeAbsolute(path.join(rootPath, changed)));
                    }
                }
            }

            // Nothing this project's claims depend on changed: keep its snapshot
            // and skip its Program. An added file can satisfy an import that did
            // not resolve before, which the snapshot cannot rule out.
            if (
                changedFiles
                && previous?.referenceAuthorityReady !== undefined
                && !environmentChanged
                && directlyChanged.size === 0
                && !(filesAdded && previous.unresolvedImports)
            ) {
                currentSnapshots.set(plan.key, previous);
                projectReferenceAuthorityReady.set(plan.key, previous.referenceAuthorityReady);
                affectedByProject.set(plan.key, new Set());
                continue;
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
            const updateResourceFailure = session.getResourceLimitFailure();
            if (updateResourceFailure) {
                return resourceLimitEvidence(updateResourceFailure, [1, planIndex.get(plan.key)!]);
            }

            const programStartedAt = performance.now();
            const program = session.getProgram();
            perfTrace('typescript.program', performance.now() - programStartedAt, { project: plan.key, files: plan.relativeFiles.length });
            const programResourceFailure = session.getResourceLimitFailure();
            if (programResourceFailure) {
                return resourceLimitEvidence(programResourceFailure, [1, planIndex.get(plan.key)!]);
            }
            let referenceReady = true;
            if (plan.referencedProjectKeys.length > 0) {
                const referenceStartedAt = performance.now();
                const proven = plan.configPath ? referenceAuthorityReady(plan.configPath) : undefined;
                referenceReady = proven
                    ?? !program.getSemanticDiagnostics().some((diagnostic) => diagnostic.code === 6305);
                perfTrace('typescript.reference_authority', performance.now() - referenceStartedAt, {
                    project: plan.key,
                    decision: proven === undefined ? 'diagnostics' : 'outputs',
                    ready: referenceReady,
                });
                const diagnosticResourceFailure = session.getResourceLimitFailure();
                if (diagnosticResourceFailure) {
                    return resourceLimitEvidence(diagnosticResourceFailure, [1, planIndex.get(plan.key)!]);
                }
            }
            projectReferenceAuthorityReady.set(plan.key, referenceReady);
            const dependencies = buildReverseDependencies(program, plan, manifestPaths, session);
            const currentProjectGlobalFiles = projectGlobalSourceFiles(program, plan, manifestPaths);
            currentSnapshots.set(plan.key, {
                environmentConfigId: plan.environmentConfigId,
                files: currentFiles,
                reverseDependencies: dependencies.reverse,
                projectGlobalSourceFiles: currentProjectGlobalFiles,
                referencedProjectKeys: new Set(plan.referencedProjectKeys),
                unresolvedImports: dependencies.unresolvedImports,
            });
            if (changedFiles) {
                for (const changed of changedFiles) {
                    if (dependencies.reverse.has(changed) || currentProjectGlobalFiles.has(changed)) {
                        directlyChanged.add(changed);
                    }
                }
            }

            let affected: Set<string>;
            if (!changedFiles || !previous || environmentChanged) {
                affected = new Set(plan.relativeFiles);
            } else if ([...directlyChanged].some((file) => (
                currentProjectGlobalFiles.has(file)
                || previous.projectGlobalSourceFiles.has(file)
            ))) {
                affected = new Set(plan.relativeFiles);
            } else {
                const dependents = transitiveDependents(
                    [...directlyChanged],
                    unionReverseDependencies(previous.reverseDependencies, dependencies.reverse),
                );
                affected = new Set([...dependents].filter((file) => currentFiles.has(file)));
            }
            affectedByProject.set(plan.key, affected);
        }

        // Readiness decides whether every file of a project is available, so a
        // change in it affects the whole project, not only the changed files.
        for (const plan of plans) {
            const snapshot = currentSnapshots.get(plan.key);
            if (!snapshot || !owns(plan)) continue;
            const ready = projectReferenceAuthorityReady.get(plan.key) ?? true;
            const previousReady = previousState?.snapshots.get(plan.key)?.referenceAuthorityReady;
            if (previousReady !== undefined && previousReady !== ready) {
                affectedByProject.set(plan.key, new Set(plan.relativeFiles));
            }
            currentSnapshots.set(plan.key, { ...snapshot, referenceAuthorityReady: ready });
        }

        const unavailableSourceFiles = new Set<string>();
        let ownedSourceFileCount = 0;
        for (const plan of plans) {
            if (!owns(plan)) continue;
            ownedSourceFileCount += plan.relativeFiles.length;
            if (plan.configErrors.length > 0 || projectReferenceAuthorityReady.get(plan.key) === false) {
                for (const file of plan.relativeFiles) unavailableSourceFiles.add(file);
            }
        }

        const manifestByPath = new Map(input.registry.manifest.files.map((file) => [file.path, file]));
        const affectedSourceFiles = new Set<string>();

        for (const plan of plans) {
            if (!owns(plan)) continue;
            const affected = affectedByProject.get(plan.key) ?? new Set<string>();
            this.projectFailureRank = [2, planIndex.get(plan.key)!];
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
            const activeResourceFailure = activeSession.getResourceLimitFailure();
            if (activeResourceFailure) {
                return resourceLimitEvidence(activeResourceFailure, [2, planIndex.get(plan.key)!]);
            }
            const program = activeSession.getProgram();
            const activeProgramResourceFailure = activeSession.getResourceLimitFailure();
            if (activeProgramResourceFailure) {
                return resourceLimitEvidence(activeProgramResourceFailure, [2, planIndex.get(plan.key)!]);
            }

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
            const claimsStartedAt = performance.now();
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
            perfTrace('typescript.claims', performance.now() - claimsStartedAt, { project: plan.key, files: affected.size });
            for (const file of affected) {
                if (!manifestByPath.has(file)) continue;
                claimsByFile.set(file, projectClaims.get(file) ?? []);
            }
        }

        const state: RootResolutionState = {
            registryDigest: registryDigest(input.registry),
            snapshots: currentSnapshots,
            fileToProject: currentFileToProject,
        };
        this.rootStates.set(rootPath, state);
        this.persistRootState(rootPath, state);

        // Unsharded, every TypeScript file belongs to one of the plans.
        const sourceFileCount = shard || this.options.projectKey !== undefined ? ownedSourceFileCount : typeScriptFiles.length;
        return { evidence: {
            language: 'typescript',
            providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
            providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
            environmentConfigId: evidenceEnvironmentConfigId,
            claimsByFile,
            affectedSourceFiles,
            sourceControlFiles,
            coverage: {
                language: 'typescript',
                providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
                providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
                environmentConfigId: evidenceEnvironmentConfigId,
                status: unavailableSourceFiles.size === 0
                    ? 'complete'
                    : unavailableSourceFiles.size === sourceFileCount
                        ? 'unavailable'
                        : 'degraded',
                sourceFileCount,
                analyzedSourceFileCount: Math.max(
                    0,
                    sourceFileCount - unavailableSourceFiles.size,
                ),
            },
        } };
    }

    getSessionStats(): { readonly active: number; readonly max: number; readonly keys: readonly string[] } {
        return {
            active: this.sessions.size,
            max: this.maxSessions,
            keys: [...this.sessions.keys()].sort(),
        };
    }

    async dispose(): Promise<void> {
        clearTimeout(this.idleReleaseTimer);
        this.clearSessionState();
    }

    private clearSessionState(): void {
        for (const cached of this.sessions.values()) this.disposeCachedSession(cached);
        this.sessions.clear();
        this.rootStates.clear();
    }

    /**
     * Native disposal can fail after the client closes. Every caller keeps its
     * maps consistent, so one failure must not skip the remaining disposals or
     * leave a disposed session cached, and the idle timer must not throw.
     */
    private disposeCachedSession(cached: CachedSession): void {
        try {
            cached.session.dispose();
        } catch (error) {
            console.warn(
                `[TypeScriptResolution] Failed to dispose the session for ${cached.key}: `
                + `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * The state of the analysis that produced `previousRegistry`, from memory
     * or disk. A state from any other registry (a failed publication, an older
     * index) is not a valid delta base and yields a full analysis.
     */
    private previousRootState(
        rootPath: string,
        previousRegistry: ResolutionProjectInput['previousRegistry'],
    ): RootResolutionState | undefined {
        if (!previousRegistry) return undefined;
        const digest = registryDigest(previousRegistry);
        const inMemory = this.rootStates.get(rootPath);
        if (inMemory?.registryDigest === digest) return inMemory;
        if (!this.options.stateDirectory) return undefined;
        let text: string;
        try {
            text = fs.readFileSync(this.rootStatePath(rootPath), 'utf8');
        } catch {
            return undefined;
        }
        const persisted = parseRootState(text, rootPath);
        return persisted?.registryDigest === digest ? persisted : undefined;
    }

    /** Best effort: a missing or unreadable state only costs a full analysis. */
    private persistRootState(rootPath: string, state: RootResolutionState): void {
        if (!this.options.stateDirectory) return;
        const target = this.rootStatePath(rootPath);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
            fs.mkdirSync(this.options.stateDirectory, { recursive: true });
            fs.writeFileSync(temporary, serializeRootState(rootPath, state));
            fs.renameSync(temporary, target);
        } catch (error) {
            fs.rmSync(temporary, { force: true });
            console.warn(`[TypeScriptResolution] Could not persist resolution state for '${rootPath}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private rootStatePath(rootPath: string): string {
        const shard = this.options.shard;
        const suffix = shard ? `.shard-${shard.index}-of-${shard.count}` : '';
        return path.join(this.options.stateDirectory!, `${createHash('sha256').update(rootPath).digest('hex')}${suffix}.json`);
    }

    private releaseSession(key: string): void {
        const cached = this.sessions.get(key);
        if (!cached) return;
        this.disposeCachedSession(cached);
        this.sessions.delete(key);
    }

    private discoverPlans(rootPath: string, relativeFiles: readonly string[]): ProjectPlan[] {
        const normalizedRoot = normalizeAbsolute(rootPath);
        const configCache = new Map<string, TypeScriptConfiguredProject>();
        const configuredGroups = new Map<string, string[]>();
        const inferredFiles: string[] = [];

        // An unreadable config is not a usable candidate: files it would have covered fall through to
        // the next candidate or the inferred group. It stays a control file of those plans, so fixing
        // it changes their environment identity.
        const unreadableConfigs = new Set<string>();
        const load = (configPath: string): TypeScriptConfiguredProject | undefined => {
            const normalized = normalizeAbsolute(configPath);
            const cached = configCache.get(normalized);
            if (cached) return cached;
            if (unreadableConfigs.has(normalized)) return undefined;
            try {
                const project = loadTypeScriptConfiguredProject(normalized);
                configCache.set(normalized, project);
                return project;
            } catch (error) {
                if (!(error instanceof TypeScriptConfigReadError)) throw error;
                unreadableConfigs.add(normalized);
                console.warn(`[TypeScriptResolution] Skipping unreadable TypeScript config: ${error.message}`);
                return undefined;
            }
        };

        for (const relativeFile of relativeFiles) {
            const absoluteFile = normalizeAbsolute(path.join(normalizedRoot, relativeFile));
            let selected: TypeScriptConfiguredProject | undefined;
            for (const configPath of candidateConfigPaths(normalizedRoot, absoluteFile)) {
                const project = load(configPath);
                if (project?.fileNames.includes(absoluteFile)) {
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
            if (!project) continue;
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
                semanticResourceBudget: this.resourceBudget,
            })}`;
            plans.push({
                key: configuredProjectKey(project.configPath),
                mode: 'configured',
                rootPath: normalizedRoot,
                configPath: project.configPath,
                relativeFiles: sortedFiles,
                absoluteFiles,
                compilerRootFiles: project.fileNames,
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
                semanticResourceBudget: this.resourceBudget,
            })}`;
            plans.push({
                key: inferredProjectKey(normalizedRoot),
                mode: 'inferred',
                rootPath: normalizedRoot,
                relativeFiles: sortedFiles,
                absoluteFiles,
                compilerRootFiles: absoluteFiles,
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
            this.disposeCachedSession(existing);
            this.sessions.delete(plan.key);
        }

        const session: ProgramSession = plan.mode === 'configured'
            ? new TypeScriptLanguageServiceSession(plan.configPath!, this.resourceBudget)
            : new InferredLanguageServiceSession(
                plan.rootPath,
                plan.absoluteFiles,
                plan.options,
                this.resourceBudget,
            );
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
            this.disposeCachedSession(victim);
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
            const currentHash = fileContentHash(absolute);
            if (currentHash !== manifest.hash) {
                throw new Error(`TypeScript semantic source changed before claim publication: '${relativeFile}'.`);
            }
        }
    }
}
