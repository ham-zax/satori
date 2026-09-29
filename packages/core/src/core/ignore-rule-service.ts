import * as fs from 'fs';
import * as path from 'path';
import { envManager } from '../utils/env-manager';
import { createIndexIgnoreMatcher, type IndexIgnoreMatcher } from './ignore-matcher';
import { parseIgnorePatterns } from './ignore-file-inputs';
import { observeFileBasedIgnorePatterns } from './index-policy-input-observer';

export { parseIgnorePatterns };

type IgnoreMatcher = IndexIgnoreMatcher;

type CodebaseIgnoreState = {
    canonicalRoot: string;
    fileBasedPatterns: string[];
    effectivePatterns: string[];
    matcher: IgnoreMatcher | null;
};

export type IgnoreRuleStateSnapshot = Readonly<{
    canonicalRoot: string;
    fileBasedPatterns: readonly string[];
    effectivePatterns: readonly string[];
    matcher: IgnoreMatcher | null;
}>;

type IgnoreRuleServiceConfig = Readonly<{
    basePatterns: readonly string[];
    canonicalizeCodebasePath: (codebasePath: string) => string;
    resolveCollectionName: (codebasePath: string) => string;
    ensureRuntimePolicyLoaded: (canonicalRoot: string) => void;
}>;

export async function readIgnorePatternsFile(filePath: string): Promise<string[]> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return parseIgnorePatterns(content);
    } catch (error) {
        console.warn(`[Context] ⚠️  Could not read ignore file ${filePath}: ${error}`);
        return [];
    }
}

export function getCustomExtensionsFromEnvironment(): string[] {
    const configured = envManager.get('CUSTOM_EXTENSIONS');
    if (!configured) return [];
    try {
        return configured
            .split(',')
            .map((extension) => extension.trim())
            .filter((extension) => extension.length > 0)
            .map((extension) => (
                extension.startsWith('.') ? extension : `.${extension}`
            ));
    } catch (error) {
        console.warn(`[Context] ⚠️  Failed to parse CUSTOM_EXTENSIONS: ${error}`);
        return [];
    }
}

export function getCustomIgnorePatternsFromEnvironment(): string[] {
    const configured = envManager.get('CUSTOM_IGNORE_PATTERNS');
    if (!configured) return [];
    try {
        return configured
            .split(',')
            .map((pattern) => pattern.trim())
            .filter((pattern) => pattern.length > 0);
    } catch (error) {
        console.warn(`[Context] ⚠️  Failed to parse CUSTOM_IGNORE_PATTERNS: ${error}`);
        return [];
    }
}

export class IgnoreRuleService {
    private basePatterns: string[];
    private readonly runtimeCustomPatternsByCodebase = new Map<string, string[]>();
    private readonly stateByCollection = new Map<string, CodebaseIgnoreState>();
    private readonly canonicalizeCodebasePath: (
        codebasePath: string,
    ) => string;
    private readonly resolveCollectionName: (codebasePath: string) => string;
    private readonly ensureRuntimePolicyLoaded: (canonicalRoot: string) => void;

    constructor(config: IgnoreRuleServiceConfig) {
        this.basePatterns = [...config.basePatterns];
        this.canonicalizeCodebasePath = config.canonicalizeCodebasePath;
        this.resolveCollectionName = config.resolveCollectionName;
        this.ensureRuntimePolicyLoaded = config.ensureRuntimePolicyLoaded;
    }

    getBasePatterns(): string[] {
        return [...this.basePatterns];
    }

    setBasePatterns(patterns: readonly string[]): void {
        this.basePatterns = [...patterns];
        this.rebuildAllStates();
    }

    hasRuntimeCustomPatterns(canonicalRoot: string): boolean {
        return this.runtimeCustomPatternsByCodebase.has(canonicalRoot);
    }

    getRuntimeCustomPatterns(canonicalRoot: string): string[] {
        return [
            ...(this.runtimeCustomPatternsByCodebase.get(canonicalRoot) ?? []),
        ];
    }

    setRuntimeCustomPatterns(
        canonicalRoot: string,
        patterns: readonly string[],
    ): void {
        this.runtimeCustomPatternsByCodebase.set(canonicalRoot, [...patterns]);
    }

    deleteRuntimeCustomPatterns(canonicalRoot: string): void {
        this.runtimeCustomPatternsByCodebase.delete(canonicalRoot);
    }

    getActivePatterns(codebasePath?: string): string[] {
        if (!codebasePath) return this.getBasePatterns();
        return [...this.getOrCreateState(codebasePath).effectivePatterns];
    }

    deleteCodebaseState(codebasePath: string): void {
        this.stateByCollection.delete(this.resolveCollectionName(codebasePath));
    }

    captureCodebaseState(
        codebasePath: string,
    ): IgnoreRuleStateSnapshot | null {
        const state = this.stateByCollection.get(
            this.resolveCollectionName(codebasePath),
        );
        if (!state) return null;
        return {
            ...state,
            fileBasedPatterns: [...state.fileBasedPatterns],
            effectivePatterns: [...state.effectivePatterns],
        };
    }

    restoreCodebaseState(
        codebasePath: string,
        snapshot: IgnoreRuleStateSnapshot | null,
    ): void {
        const collectionName = this.resolveCollectionName(codebasePath);
        if (!snapshot) {
            this.stateByCollection.delete(collectionName);
            return;
        }
        this.stateByCollection.set(collectionName, {
            ...snapshot,
            fileBasedPatterns: [...snapshot.fileBasedPatterns],
            effectivePatterns: [...snapshot.effectivePatterns],
        });
    }

    setFileBasedPatterns(
        codebasePath: string,
        fileBasedPatterns: readonly string[],
    ): void {
        const normalizedFileBased = fileBasedPatterns
            .filter((pattern): pattern is string => typeof pattern === 'string')
            .filter((pattern) => pattern.length > 0);
        this.stateByCollection.set(this.resolveCollectionName(codebasePath), {
            canonicalRoot: this.canonicalizeCodebasePath(codebasePath),
            fileBasedPatterns: normalizedFileBased,
            effectivePatterns: this.buildEffectivePatterns(
                codebasePath,
                normalizedFileBased,
            ),
            matcher: null,
        });
    }

    getMatcher(codebasePath: string): IgnoreMatcher {
        const collectionName = this.resolveCollectionName(codebasePath);
        const state = this.getOrCreateState(codebasePath);
        if (state.matcher) return state.matcher;
        const matcher = createIndexIgnoreMatcher(state.effectivePatterns);
        this.stateByCollection.set(collectionName, { ...state, matcher });
        return matcher;
    }

    /**
     * Reload file-based patterns through the policy input observer, the single
     * owner of ignore file discovery, ordering, and precedence.
     */
    async loadIgnorePatterns(codebasePath: string): Promise<void> {
        try {
            const fileBasedPatterns = await observeFileBasedIgnorePatterns(
                this.canonicalizeCodebasePath(codebasePath),
            );
            this.setFileBasedPatterns(codebasePath, fileBasedPatterns);
            if (fileBasedPatterns.length > 0) {
                console.log(
                    `[Context] 🚫 Loaded total ${fileBasedPatterns.length} ignore patterns from ignore files`,
                );
            } else {
                console.log(
                    '📄 No ignore files found; effective rules reset to base + runtime custom',
                );
            }
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to load ignore patterns: ${error}`);
            // Existing patterns remain authoritative when observation fails.
        }
    }

    matchesIgnorePattern(
        filePath: string,
        codebasePath: string,
        isDirectory: boolean = false,
        matcherOverride?: IgnoreMatcher,
    ): boolean {
        if (
            !matcherOverride
            && this.getActivePatterns(codebasePath).length === 0
        ) {
            return false;
        }
        const relativePath = path.relative(codebasePath, filePath)
            .replace(/\\/g, '/')
            .replace(/^\/+/, '');
        if (!relativePath || relativePath.startsWith('..')) return false;
        const matcher = matcherOverride ?? this.getMatcher(codebasePath);
        if (isDirectory) {
            const withSlash = relativePath.endsWith('/')
                ? relativePath
                : `${relativePath}/`;
            return matcher.ignores(relativePath) || matcher.ignores(withSlash);
        }
        return matcher.ignores(relativePath);
    }

    private buildEffectivePatterns(
        codebasePath: string,
        fileBasedPatterns: readonly string[],
    ): string[] {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        return [
            ...this.basePatterns,
            ...this.getRuntimeCustomPatterns(canonicalRoot),
            ...fileBasedPatterns,
        ];
    }

    private rebuildAllStates(): void {
        for (const [collectionName, state] of this.stateByCollection.entries()) {
            this.stateByCollection.set(collectionName, {
                ...state,
                effectivePatterns: this.buildEffectivePatterns(
                    state.canonicalRoot,
                    state.fileBasedPatterns,
                ),
                matcher: null,
            });
        }
    }

    private getOrCreateState(codebasePath: string): CodebaseIgnoreState {
        const collectionName = this.resolveCollectionName(codebasePath);
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.ensureRuntimePolicyLoaded(canonicalRoot);
        const existing = this.stateByCollection.get(collectionName);
        if (existing) return existing;
        const initial: CodebaseIgnoreState = {
            canonicalRoot,
            fileBasedPatterns: [],
            effectivePatterns: this.buildEffectivePatterns(canonicalRoot, []),
            matcher: null,
        };
        this.stateByCollection.set(collectionName, initial);
        return initial;
    }
}
