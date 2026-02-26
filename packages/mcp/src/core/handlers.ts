import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import ignore from "ignore";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    getSupportedExtensionsForCapability,
    isLanguageCapabilitySupportedForExtension,
    isLanguageCapabilitySupportedForLanguage,
} from "@zokizuan/satori-core";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "../utils.js";
import { SyncManager } from "./sync.js";
import { DEFAULT_WATCH_DEBOUNCE_MS, IndexFingerprint } from "../config.js";
import {
    SEARCH_CHANGED_FILES_CACHE_TTL_MS,
    SEARCH_CHANGED_FIRST_MULTIPLIER,
    SEARCH_DIVERSITY_MAX_PER_FILE,
    SEARCH_DIVERSITY_MAX_PER_SYMBOL,
    SEARCH_DIVERSITY_RELAXED_FILE_CAP,
    SEARCH_MAX_CANDIDATES,
    SEARCH_MUST_RETRY_MULTIPLIER,
    SEARCH_MUST_RETRY_ROUNDS,
    SEARCH_NOISE_HINT_PATTERNS,
    SEARCH_NOISE_HINT_THRESHOLD,
    SEARCH_NOISE_HINT_TOP_K,
    SEARCH_OPERATOR_PREFIX_MAX_CHARS,
    SEARCH_PROXIMITY_WINDOW,
    SEARCH_RRF_K,
    SCOPE_PATH_MULTIPLIERS,
    STALENESS_THRESHOLDS_MS,
    PathCategory,
    SearchGroupBy,
    SearchNoiseCategory,
    SearchRankingMode,
    SearchResultMode,
    SearchScope
} from "./search-constants.js";
import {
    CallGraphHint,
    FingerprintCompatibilityDiagnostics,
    FileOutlineInput,
    FileOutlineResponseEnvelope,
    FileOutlineStatus,
    FileOutlineSymbolResult,
    SearchChunkResult,
    SearchDebugHint,
    SearchGroupResult,
    SearchNoiseMitigationHint,
    SearchOperatorSummary,
    SearchRequestInput,
    SearchResponseEnvelope,
    SearchSpan,
    StalenessBucket
} from "./search-types.js";
import { CallGraphDirection, CallGraphSidecarManager, CallGraphSymbolRef } from "./call-graph.js";

const COLLECTION_LIMIT_PATTERNS = [
    /exceeded the limit number of collections/i,
    /collection limit/i,
    /too many collections/i,
    /quota.*collection/i,
];

const SATORI_COLLECTION_PREFIXES = ['code_chunks_', 'hybrid_code_chunks_'];
const ZILLIZ_FREE_TIER_COLLECTION_LIMIT = 5;
const OUTLINE_SUPPORTED_EXTENSIONS = getSupportedExtensionsForCapability('fileOutline');
const MIN_RELIABLE_COLLECTION_CREATED_AT_MS = Date.UTC(2000, 0, 1);
const SEARCH_OPERATOR_KEYS = new Set(['lang', 'path', '-path', 'must', 'exclude']);

type ParsedSearchOperators = {
    semanticQuery: string;
    prefixBlockChars: number;
    lang: string[];
    path: string[];
    excludePath: string[];
    must: string[];
    exclude: string[];
};

type SearchCandidate = {
    result: any;
    baseScore: number;
    fusionScore: number;
    finalScore: number;
    pathCategory: PathCategory;
    pathMultiplier: number;
    changedFilesMultiplier: number;
    passesMatchedMust: boolean;
};

type SearchFilterSummary = {
    removedByScope: number;
    removedByLanguage: number;
    removedByPathInclude: number;
    removedByPathExclude: number;
    removedByMust: number;
    removedByExclude: number;
};

type SearchDiversitySummary = {
    maxPerFile: number;
    maxPerSymbol: number;
    relaxedFileCap: number;
    skippedByFileCap: number;
    skippedBySymbolCap: number;
    usedRelaxedCap: boolean;
};

interface CandidateCollection {
    name: string;
    createdAt?: string;
    codebasePath?: string;
    isTargetCollection: boolean;
    sortTimestampMs?: number;
}

interface CollectionDetailsView {
    name: string;
    createdAt?: string;
}

interface VectorStoreBackendInfoView {
    provider: 'milvus' | 'zilliz';
    transport: 'grpc' | 'rest';
    address?: string;
}

function collectErrorFragments(
    value: unknown,
    output: string[],
    visited: Set<unknown>,
    depth: number = 0
): void {
    if (value === null || value === undefined || depth > 4 || output.length >= 8) {
        return;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            output.push(trimmed);
        }
        return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        output.push(String(value));
        return;
    }

    if (value instanceof Error) {
        collectErrorFragments(value.message, output, visited, depth + 1);
        collectErrorFragments((value as any).cause, output, visited, depth + 1);
        return;
    }

    if (typeof value !== "object") {
        return;
    }

    if (visited.has(value)) {
        return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectErrorFragments(item, output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
        return;
    }

    const record = value as Record<string, unknown>;
    const priorityKeys = ["message", "reason", "detail", "details", "error", "msg", "code", "error_code"];
    for (const key of priorityKeys) {
        if (key in record) {
            collectErrorFragments(record[key], output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
    }

    for (const nestedValue of Object.values(record)) {
        collectErrorFragments(nestedValue, output, visited, depth + 1);
        if (output.length >= 8) {
            return;
        }
    }
}

function formatUnknownError(error: unknown): string {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return COLLECTION_LIMIT_MESSAGE;
    }

    const fragments: string[] = [];
    collectErrorFragments(error, fragments, new Set());
    const deduped = Array.from(new Set(fragments.map((fragment) => fragment.trim()).filter(Boolean)));
    if (deduped.length > 0) {
        return deduped.slice(0, 3).join(" | ");
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function isCollectionLimitError(error: unknown): boolean {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    const message = formatUnknownError(error);
    if (message === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    return COLLECTION_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private runtimeFingerprint: IndexFingerprint;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    private readonly now: () => number;
    private readonly callGraphManager: CallGraphSidecarManager;
    private readonly changedFilesCache = new Map<string, {
        expiresAtMs: number;
        available: boolean;
        files: Set<string>;
    }>();

    constructor(
        context: Context,
        snapshotManager: SnapshotManager,
        syncManager: SyncManager,
        runtimeFingerprint: IndexFingerprint,
        now: () => number = () => Date.now(),
        callGraphManager?: CallGraphSidecarManager
    ) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.syncManager = syncManager;
        this.runtimeFingerprint = runtimeFingerprint;
        this.currentWorkspace = process.cwd();
        this.now = now;
        this.callGraphManager = callGraphManager || new CallGraphSidecarManager(runtimeFingerprint, { now });
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    private buildReindexInstruction(codebasePath: string, detail?: string): string {
        const detailLine = detail ? `${detail}\n\n` : '';
        return `${detailLine}Error: The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt.\nNext step: call manage_index with {\"action\":\"reindex\",\"path\":\"${codebasePath}\"}.`;
    }

    private buildReindexHint(codebasePath: string): { tool: string; args: { action: string; path: string } } {
        return {
            tool: "manage_index",
            args: {
                action: "reindex",
                path: codebasePath
            }
        };
    }

    private summarizeFingerprint(fingerprint: IndexFingerprint): string {
        return `${fingerprint.embeddingProvider}/${fingerprint.embeddingModel}/${fingerprint.embeddingDimension}/${fingerprint.vectorStoreProvider}/${fingerprint.schemaVersion}`;
    }

    private buildCompatibilityDiagnostics(codebasePath: string): FingerprintCompatibilityDiagnostics {
        const info = typeof (this.snapshotManager as any).getCodebaseInfo === 'function'
            ? this.snapshotManager.getCodebaseInfo(codebasePath)
            : undefined;
        const statusAtCheck = info?.status
            || (typeof (this.snapshotManager as any).getCodebaseStatus === 'function'
                ? this.snapshotManager.getCodebaseStatus(codebasePath)
                : 'not_found');
        const diagnostics: FingerprintCompatibilityDiagnostics = {
            runtimeFingerprint: this.runtimeFingerprint,
            statusAtCheck
        };

        if (info?.indexFingerprint) {
            diagnostics.indexedFingerprint = info.indexFingerprint;
        }

        if (info?.fingerprintSource) {
            diagnostics.fingerprintSource = info.fingerprintSource;
        }

        if (info?.reindexReason) {
            diagnostics.reindexReason = info.reindexReason;
        }

        return diagnostics;
    }

    private buildCompatibilityStatusLines(codebasePath: string): string {
        const diagnostics = this.buildCompatibilityDiagnostics(codebasePath);
        let lines = `\n🧬 Runtime fingerprint: ${this.summarizeFingerprint(diagnostics.runtimeFingerprint)}`;
        lines += diagnostics.indexedFingerprint
            ? `\n🧬 Indexed fingerprint: ${this.summarizeFingerprint(diagnostics.indexedFingerprint)}`
            : `\n🧬 Indexed fingerprint: unavailable`;

        if (diagnostics.fingerprintSource) {
            lines += `\n🧬 Fingerprint source: ${diagnostics.fingerprintSource}`;
        }

        if (diagnostics.reindexReason) {
            lines += `\n🧬 Reindex reason: ${diagnostics.reindexReason}`;
        }

        return lines;
    }

    private buildRequiresReindexPayload(
        codebasePath: string,
        detail?: string,
        searchContext?: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        }
    ): Record<string, unknown> {
        const detailLine = detail ? `${detail}\n\n` : '';
        const base = searchContext ? {
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
        } : {};
        return {
            ...base,
            status: "requires_reindex",
            codebasePath,
            results: [],
            freshnessDecision: {
                mode: "skipped_requires_reindex"
            },
            message: `${detailLine}The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {\"action\":\"reindex\",\"path\":\"${codebasePath}\"}.`,
            hints: {
                reindex: this.buildReindexHint(codebasePath)
            },
            compatibility: this.buildCompatibilityDiagnostics(codebasePath)
        };
    }

    private buildRequiresReindexSearchResponse(
        codebasePath: string,
        detail?: string,
        searchContext?: {
            path: string;
            query: string;
            scope: SearchScope;
            groupBy: SearchGroupBy;
            resultMode: SearchResultMode;
            limit: number;
        }
    ): { content: Array<{ type: string; text: string }> } {
        return {
            content: [{
                type: "text",
                text: JSON.stringify(this.buildRequiresReindexPayload(codebasePath, detail, searchContext), null, 2)
            }]
        };
    }

    private buildRequiresReindexCallGraphPayload(
        codebasePath: string,
        detail: string | undefined,
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        }
    ): Record<string, unknown> {
        const detailLine = detail ? `${detail}\n\n` : '';
        return {
            status: "requires_reindex",
            supported: false,
            reason: "requires_reindex",
            path: context.path,
            codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            freshnessDecision: {
                mode: "skipped_requires_reindex"
            },
            message: `${detailLine}The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {"action":"reindex","path":"${codebasePath}"}.`,
            hints: {
                reindex: this.buildReindexHint(codebasePath)
            },
            compatibility: this.buildCompatibilityDiagnostics(codebasePath)
        };
    }

    private getMatchingBlockedRoot(absolutePath: string): { path: string; message?: string } | null {
        const blocked = this.snapshotManager
            .getAllCodebases()
            .filter((entry) => entry.info.status === 'requires_reindex');
        if (blocked.length === 0) {
            return null;
        }

        blocked.sort((a, b) => b.path.length - a.path.length);
        const match = blocked.find((entry) => absolutePath === entry.path || absolutePath.startsWith(`${entry.path}${path.sep}`));
        if (!match) {
            return null;
        }

        const message = 'message' in match.info ? match.info.message : undefined;
        return {
            path: match.path,
            message
        };
    }

    private enforceFingerprintGate(codebasePath: string): { blockedResponse?: any; message?: string } {
        const gate = this.snapshotManager.ensureFingerprintCompatibilityOnAccess(codebasePath);
        if (!gate.allowed) {
            if (gate.changed) {
                this.snapshotManager.saveCodebaseSnapshot();
            }
            return {
                message: gate.message,
                blockedResponse: {
                    content: [{
                        type: "text",
                        text: this.buildReindexInstruction(codebasePath, gate.message)
                    }],
                    isError: true
                }
            };
        }

        if (gate.changed) {
            this.snapshotManager.saveCodebaseSnapshot();
        }

        return {};
    }

    private buildSearchExcludeMatcher(
        excludePatterns: any,
        effectiveRoot: string,
        absoluteSearchPath: string
    ): { matcher?: ReturnType<typeof ignore>; warning?: string } {
        if (!Array.isArray(excludePatterns) || excludePatterns.length === 0) {
            return {};
        }

        const rawPatterns = excludePatterns
            .filter((v: any) => typeof v === 'string')
            .map((v: string) => v.trim())
            .filter((v: string) => v.length > 0);
        if (rawPatterns.length === 0) {
            return {};
        }

        const unique: string[] = [];
        const seen = new Set<string>();
        for (const p of rawPatterns) {
            if (!seen.has(p)) {
                seen.add(p);
                unique.push(p);
            }
        }

        const searchRel = path
            .relative(effectiveRoot, absoluteSearchPath)
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
        const needsSubdirPrefix = searchRel.length > 0 && effectiveRoot !== absoluteSearchPath;
        const normalizedPatterns: string[] = [];
        const invalidPatterns: string[] = [];
        for (const rawPattern of unique) {
            let pattern = rawPattern.replace(/\\/g, '/').trim();
            if (!pattern) {
                continue;
            }

            const isNegation = pattern.startsWith('!');
            if (isNegation) {
                pattern = pattern.slice(1);
            }

            const anchored = pattern.startsWith('/');
            pattern = pattern.replace(/^\.\/+/, '').replace(/^\/+/, '');
            if (!pattern) {
                invalidPatterns.push(rawPattern);
                continue;
            }

            if (needsSubdirPrefix && !anchored) {
                pattern = `${searchRel}/${pattern}`.replace(/\/+/g, '/');
            }

            normalizedPatterns.push(isNegation ? `!${pattern}` : pattern);
        }

        if (normalizedPatterns.length === 0) {
            return {
                warning: invalidPatterns.length > 0
                    ? `Note: excludePatterns ignored (invalid patterns): ${JSON.stringify(invalidPatterns)}.`
                    : undefined
            };
        }

        try {
            const matcher = ignore();
            matcher.add(normalizedPatterns);
            return {
                matcher,
                warning: invalidPatterns.length > 0
                    ? `Note: excludePatterns partially applied. Ignored (invalid patterns): ${JSON.stringify(invalidPatterns)}.`
                    : undefined
            };
        } catch (error: any) {
            const parseError = error?.message || String(error);
            const invalidNote = invalidPatterns.length > 0
                ? ` Ignored patterns: ${JSON.stringify(invalidPatterns)}.`
                : '';
            return {
                warning: `Note: excludePatterns ignored due to invalid pattern syntax: ${parseError}.${invalidNote}`
            };
        }
    }

    private applySearchExcludeMatcher(
        searchResults: any[],
        matcher: ReturnType<typeof ignore> | undefined
    ): any[] {
        if (!matcher || searchResults.length === 0) {
            return searchResults;
        }

        return searchResults.filter((result: any) => {
            if (!result || typeof result.relativePath !== 'string') {
                return true;
            }

            const normalizedPath = result.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!normalizedPath || normalizedPath.startsWith('..')) {
                return true;
            }

            return !matcher.ignores(normalizedPath);
        });
    }

    private normalizeBreadcrumbs(breadcrumbs: unknown): string[] {
        if (!Array.isArray(breadcrumbs)) {
            return [];
        }
        return breadcrumbs
            .filter((crumb): crumb is string => typeof crumb === 'string')
            .map((crumb) => crumb.trim())
            .filter((crumb) => crumb.length > 0)
            .slice(-2);
    }

    private getBreadcrumbMergeKey(breadcrumbs: unknown): string {
        return this.normalizeBreadcrumbs(breadcrumbs).join(' > ');
    }

    private formatScopeLine(breadcrumbs: unknown): string {
        const normalized = this.normalizeBreadcrumbs(breadcrumbs);

        if (normalized.length === 0) {
            return '';
        }

        const joined = normalized.join(' > ');
        const capped = joined.length > 220 ? `${joined.slice(0, 217)}...` : joined;
        return `   🧬 Scope: ${capped}\n`;
    }

    private normalizeSearchPath(relativePath: string): string {
        return relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    }

    private hasPathSegment(normalizedPath: string, segment: string): boolean {
        return normalizedPath === segment
            || normalizedPath.startsWith(`${segment}/`)
            || normalizedPath.includes(`/${segment}/`);
    }

    private isTestPath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'test')
            || this.hasPathSegment(normalizedPath, 'tests')
            || this.hasPathSegment(normalizedPath, '__tests__')
            || /\.test\.[^/]+$/.test(normalizedPath)
            || /\.spec\.[^/]+$/.test(normalizedPath);
    }

    private isDocPath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'docs')
            || this.hasPathSegment(normalizedPath, 'doc')
            || this.hasPathSegment(normalizedPath, 'documentation')
            || this.hasPathSegment(normalizedPath, 'guide')
            || this.hasPathSegment(normalizedPath, 'guides')
            || normalizedPath.endsWith('.md')
            || normalizedPath.endsWith('.mdx')
            || normalizedPath.endsWith('.rst')
            || normalizedPath.endsWith('.adoc')
            || normalizedPath.endsWith('.txt');
    }

    private isGeneratedPath(normalizedPath: string): boolean {
        return normalizedPath.includes('/dist/')
            || normalizedPath.includes('/build/')
            || normalizedPath.includes('/coverage/')
            || normalizedPath.includes('/.next/')
            || normalizedPath.includes('/generated/')
            || normalizedPath.endsWith('.min.js')
            || normalizedPath.endsWith('.min.css');
    }

    private isFixturePath(normalizedPath: string): boolean {
        return this.hasPathSegment(normalizedPath, 'fixtures')
            || this.hasPathSegment(normalizedPath, '__fixtures__');
    }

    private isEntrypointPath(normalizedPath: string): boolean {
        const entryNames = ['main.', 'index.', 'app.', 'server.', 'cli.', 'entry.'];
        const baseName = normalizedPath.split('/').pop() || '';
        return entryNames.some((prefix) => baseName.startsWith(prefix));
    }

    private classifyPathCategory(relativePath: string): PathCategory {
        const normalized = this.normalizeSearchPath(relativePath);
        if (this.isDocPath(normalized)) return 'docs';
        if (this.isTestPath(normalized)) return 'tests';
        if (this.isGeneratedPath(normalized)) return 'generated';
        if (this.isEntrypointPath(normalized)) return 'entrypoint';
        if (normalized.includes('/src/core/') || normalized.includes('/core/')) return 'core';
        if (normalized.includes('/src/')) return 'srcRuntime';
        return 'neutral';
    }

    private classifyNoiseCategory(relativePath: string): SearchNoiseCategory {
        const normalized = this.normalizeSearchPath(relativePath);

        // Deterministic precedence: generated > tests > fixtures > docs > runtime.
        if (this.isGeneratedPath(normalized)
            || this.hasPathSegment(normalized, 'coverage')
            || this.hasPathSegment(normalized, 'dist')
            || this.hasPathSegment(normalized, 'build')) return 'generated';
        if (this.isTestPath(normalized)) return 'tests';
        if (this.isFixturePath(normalized)) return 'fixtures';
        if (this.isDocPath(normalized)) return 'docs';
        return 'runtime';
    }

    private roundRatio(value: number): number {
        return Math.round(value * 100) / 100;
    }

    private buildNoiseMitigationHint(filesInOrder: string[]): SearchNoiseMitigationHint | undefined {
        if (!Array.isArray(filesInOrder) || filesInOrder.length === 0) {
            return undefined;
        }

        const topK = Math.min(SEARCH_NOISE_HINT_TOP_K, filesInOrder.length);
        if (topK <= 0) {
            return undefined;
        }

        const counts: Record<SearchNoiseCategory, number> = {
            tests: 0,
            fixtures: 0,
            docs: 0,
            generated: 0,
            runtime: 0,
        };

        for (let i = 0; i < topK; i++) {
            const category = this.classifyNoiseCategory(filesInOrder[i]);
            counts[category] += 1;
        }

        const noisyRatio = (counts.tests + counts.fixtures + counts.docs + counts.generated) / topK;
        if (noisyRatio < SEARCH_NOISE_HINT_THRESHOLD) {
            return undefined;
        }

        const ratios: Record<SearchNoiseCategory, number> = {
            tests: this.roundRatio(counts.tests / topK),
            fixtures: this.roundRatio(counts.fixtures / topK),
            docs: this.roundRatio(counts.docs / topK),
            generated: this.roundRatio(counts.generated / topK),
            runtime: this.roundRatio(counts.runtime / topK),
        };
        const debounceMs = typeof (this.syncManager as any)?.getWatchDebounceMs === 'function'
            ? this.syncManager.getWatchDebounceMs()
            : DEFAULT_WATCH_DEBOUNCE_MS;

        return {
            reason: 'top_results_noise_dominant',
            topK,
            ratios,
            recommendedScope: 'runtime',
            suggestedIgnorePatterns: [...SEARCH_NOISE_HINT_PATTERNS],
            debounceMs,
            nextStep: 'Use scope="runtime". If you still need docs context, use scope="mixed". Edit repo-root .satoriignore using your host/editor, wait one debounce window, rerun search_codebase, or run manage_index with {"action":"sync","path":"<same path used in search_codebase>"} for immediate convergence.',
        };
    }

    private tokenizeQueryPrefix(prefix: string): string[] {
        const tokens: string[] = [];
        let current = "";
        let inQuotes = false;
        let escaped = false;

        for (let i = 0; i < prefix.length; i++) {
            const ch = prefix[i];
            if (escaped) {
                current += ch;
                escaped = false;
                continue;
            }

            if (ch === "\\") {
                current += ch;
                escaped = true;
                continue;
            }

            if (ch === "\"") {
                inQuotes = !inQuotes;
                current += ch;
                continue;
            }

            if (!inQuotes && /\s/.test(ch)) {
                if (current.length > 0) {
                    tokens.push(current);
                    current = "";
                }
                continue;
            }

            current += ch;
        }

        if (current.length > 0) {
            tokens.push(current);
        }

        return tokens;
    }

    private unquoteOperatorValue(value: string): string {
        const trimmed = value.trim();
        if (trimmed.length < 2) {
            return trimmed;
        }

        if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            const inner = trimmed.slice(1, -1);
            return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
        }

        return trimmed;
    }

    private parseSearchOperators(query: string): ParsedSearchOperators {
        const trimmedQuery = query.trim();
        if (trimmedQuery.length === 0) {
            return {
                semanticQuery: "",
                prefixBlockChars: 0,
                lang: [],
                path: [],
                excludePath: [],
                must: [],
                exclude: [],
            };
        }

        const maxPrefixChars = Math.min(SEARCH_OPERATOR_PREFIX_MAX_CHARS, query.length);
        const prefixWindow = query.slice(0, maxPrefixChars);
        const blankLineOffset = prefixWindow.indexOf("\n\n");
        const prefixChars = blankLineOffset >= 0 ? blankLineOffset : maxPrefixChars;
        const prefixBlock = query.slice(0, prefixChars);
        const suffixText = blankLineOffset >= 0
            ? query.slice(blankLineOffset + 2)
            : query.slice(prefixChars);

        const operators: ParsedSearchOperators = {
            semanticQuery: "",
            prefixBlockChars: prefixChars,
            lang: [],
            path: [],
            excludePath: [],
            must: [],
            exclude: [],
        };

        const semanticTokens: string[] = [];
        const tokens = this.tokenizeQueryPrefix(prefixBlock);
        for (const token of tokens) {
            if (token.startsWith("\\") && token.length > 1) {
                semanticTokens.push(token.slice(1));
                continue;
            }

            const separator = token.indexOf(":");
            if (separator <= 0) {
                semanticTokens.push(token);
                continue;
            }

            const key = token.slice(0, separator);
            if (!SEARCH_OPERATOR_KEYS.has(key)) {
                semanticTokens.push(token);
                continue;
            }

            const rawValue = token.slice(separator + 1);
            const value = this.unquoteOperatorValue(rawValue);
            if (value.length === 0) {
                continue;
            }

            if (key === "lang") {
                operators.lang.push(value.toLowerCase());
                continue;
            }
            if (key === "path") {
                operators.path.push(value.replace(/\\/g, "/"));
                continue;
            }
            if (key === "-path") {
                operators.excludePath.push(value.replace(/\\/g, "/"));
                continue;
            }
            if (key === "must") {
                operators.must.push(value);
                continue;
            }
            if (key === "exclude") {
                operators.exclude.push(value);
                continue;
            }

            semanticTokens.push(token);
        }

        const semanticFromPrefix = semanticTokens.join(" ").trim();
        const semanticSuffix = suffixText.trim();
        const semanticParts = [semanticFromPrefix, semanticSuffix].filter((part) => part.length > 0);
        operators.semanticQuery = semanticParts.length > 0 ? semanticParts.join("\n") : trimmedQuery;
        return operators;
    }

    private pathMatchesAnyPattern(relativePath: string, patterns: string[]): boolean {
        if (patterns.length === 0) return false;
        const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
        for (const pattern of patterns) {
            try {
                const matcher = ignore();
                matcher.add(pattern);
                if (matcher.ignores(normalizedPath)) {
                    return true;
                }
            } catch {
                continue;
            }
        }
        return false;
    }

    private tokenMatchesAnyField(token: string, fields: string[]): boolean {
        for (const field of fields) {
            if (field.includes(token)) {
                return true;
            }
        }
        return false;
    }

    private buildOperatorSummary(operators: ParsedSearchOperators): SearchOperatorSummary {
        return {
            prefixBlockChars: operators.prefixBlockChars,
            lang: [...operators.lang],
            path: [...operators.path],
            excludePath: [...operators.excludePath],
            must: [...operators.must],
            exclude: [...operators.exclude],
        };
    }

    private getChangedFilesForCodebase(codebasePath: string): { available: boolean; files: Set<string> } {
        const cacheKey = path.resolve(codebasePath);
        const nowMs = this.now();
        const cached = this.changedFilesCache.get(cacheKey);
        if (cached && cached.expiresAtMs > nowMs) {
            return { available: cached.available, files: new Set(cached.files) };
        }

        try {
            const stdout = execFileSync(
                "git",
                ["-C", cacheKey, "status", "--porcelain"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
            );

            const files = new Set<string>();
            const lines = stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
            for (const line of lines) {
                if (line.length < 4) {
                    continue;
                }
                let rawPath = line.slice(3).trim();
                if (rawPath.length === 0) {
                    continue;
                }

                if (rawPath.includes(" -> ")) {
                    const parts = rawPath.split(" -> ");
                    rawPath = parts[parts.length - 1].trim();
                }

                if (rawPath.startsWith("\"") && rawPath.endsWith("\"") && rawPath.length >= 2) {
                    rawPath = rawPath.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
                }

                const normalizedPath = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
                if (normalizedPath.length === 0 || normalizedPath.startsWith("..")) {
                    continue;
                }

                files.add(normalizedPath);
            }

            this.changedFilesCache.set(cacheKey, {
                expiresAtMs: nowMs + SEARCH_CHANGED_FILES_CACHE_TTL_MS,
                available: true,
                files,
            });
            return { available: true, files };
        } catch {
            this.changedFilesCache.set(cacheKey, {
                expiresAtMs: nowMs + SEARCH_CHANGED_FILES_CACHE_TTL_MS,
                available: false,
                files: new Set<string>(),
            });
            return { available: false, files: new Set<string>() };
        }
    }

    private applyGroupDiversity(
        grouped: SearchGroupResult[],
        limit: number,
        groupBy: SearchGroupBy
    ): { selected: SearchGroupResult[]; summary: SearchDiversitySummary } {
        const summary: SearchDiversitySummary = {
            maxPerFile: SEARCH_DIVERSITY_MAX_PER_FILE,
            maxPerSymbol: SEARCH_DIVERSITY_MAX_PER_SYMBOL,
            relaxedFileCap: SEARCH_DIVERSITY_RELAXED_FILE_CAP,
            skippedByFileCap: 0,
            skippedBySymbolCap: 0,
            usedRelaxedCap: false,
        };

        const selected: SearchGroupResult[] = [];
        const selectedIds = new Set<string>();
        const fileCounts = new Map<string, number>();
        const symbolCounts = new Map<string, number>();

        const applyPass = (fileCap: number): void => {
            for (const group of grouped) {
                if (selected.length >= limit) {
                    return;
                }
                if (selectedIds.has(group.groupId)) {
                    continue;
                }

                const fileCount = fileCounts.get(group.file) || 0;
                if (fileCount >= fileCap) {
                    summary.skippedByFileCap += 1;
                    continue;
                }

                if (groupBy === "symbol" && typeof group.symbolId === "string") {
                    const symbolCount = symbolCounts.get(group.symbolId) || 0;
                    if (symbolCount >= SEARCH_DIVERSITY_MAX_PER_SYMBOL) {
                        summary.skippedBySymbolCap += 1;
                        continue;
                    }
                    symbolCounts.set(group.symbolId, symbolCount + 1);
                }

                selected.push(group);
                selectedIds.add(group.groupId);
                fileCounts.set(group.file, fileCount + 1);
            }
        };

        applyPass(SEARCH_DIVERSITY_MAX_PER_FILE);
        if (selected.length < Math.min(limit, grouped.length)) {
            summary.usedRelaxedCap = true;
            applyPass(SEARCH_DIVERSITY_RELAXED_FILE_CAP);
        }

        return { selected: selected.slice(0, limit), summary };
    }

    private shouldIncludeCategoryInScope(scope: SearchScope, category: PathCategory): boolean {
        if (scope === 'runtime') {
            return category !== 'docs' && category !== 'tests';
        }
        if (scope === 'docs') {
            return category === 'docs' || category === 'tests';
        }
        return true;
    }

    private parseIndexedAtMs(indexedAt?: string): number | undefined {
        if (!indexedAt) return undefined;
        const parsed = Date.parse(indexedAt);
        if (!Number.isFinite(parsed)) return undefined;
        return parsed;
    }

    private getStalenessBucket(indexedAt?: string): StalenessBucket {
        const indexedAtMs = this.parseIndexedAtMs(indexedAt);
        if (indexedAtMs === undefined) {
            return 'unknown';
        }
        const ageMs = Math.max(0, this.now() - indexedAtMs);
        if (ageMs <= STALENESS_THRESHOLDS_MS.fresh) return 'fresh';
        if (ageMs <= STALENESS_THRESHOLDS_MS.aging) return 'aging';
        return 'stale';
    }

    private compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
        const av = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
        const bv = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
        return av - bv;
    }

    private compareNullableStringsAsc(a?: string | null, b?: string | null): number {
        if (!a && !b) return 0;
        if (!a) return 1;
        if (!b) return -1;
        return a.localeCompare(b);
    }

    private buildFallbackGroupId(relativePath: string, span: SearchSpan): string {
        const payload = `${relativePath}:${span.startLine}-${span.endLine}`;
        const digest = crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 16);
        return `grp_${digest}`;
    }

    private isCallGraphLanguageSupported(language: string, file?: string): boolean {
        if (isLanguageCapabilitySupportedForLanguage(language, 'callGraphQuery')) {
            return true;
        }

        if (typeof file === 'string') {
            const ext = path.extname(file).toLowerCase();
            return isLanguageCapabilitySupportedForExtension(ext, 'callGraphQuery');
        }

        return false;
    }

    private buildCallGraphHint(file: string, span: SearchSpan, language: string, symbolId?: string, symbolLabel?: string): CallGraphHint {
        if (!symbolId) {
            return { supported: false, reason: 'missing_symbol' };
        }
        if (!this.isCallGraphLanguageSupported(language, file)) {
            return { supported: false, reason: 'unsupported_language' };
        }
        return {
            supported: true,
            symbolRef: {
                file,
                symbolId,
                symbolLabel: symbolLabel || undefined,
                span
            }
        };
    }

    private normalizeRelativeFilePath(relativeFilePath: string): string {
        return relativeFilePath.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
    }

    private buildRequiresReindexFileOutlinePayload(
        codebasePath: string,
        input: FileOutlineInput,
        detail?: string
    ): FileOutlineResponseEnvelope {
        const detailLine = detail ? `${detail}\n\n` : '';
        return {
            status: 'requires_reindex',
            path: codebasePath,
            file: input.file,
            outline: null,
            hasMore: false,
            message: `${detailLine}Call graph sidecar is missing or incompatible. Please run manage_index with {"action":"reindex","path":"${codebasePath}"}.`,
            hints: {
                reindex: this.buildReindexHint(codebasePath)
            }
        };
    }

    private getOutlineStatusForLanguage(relativeFilePath: string): FileOutlineStatus {
        if (this.isCallGraphLanguageSupported('unknown', relativeFilePath)) {
            return 'ok';
        }
        return 'unsupported';
    }

    private sortFileOutlineSymbols(symbols: FileOutlineSymbolResult[]): FileOutlineSymbolResult[] {
        return [...symbols].sort((a, b) => {
            const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const endCmp = this.compareNullableNumbersAsc(a.span?.endLine, b.span?.endLine);
            if (endCmp !== 0) return endCmp;
            const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
        });
    }

    private buildSearchPassWarning(passId: string): string {
        return `SEARCH_PASS_FAILED:${passId} - ${passId} semantic search pass failed; results may be degraded.`;
    }

    private isSearchPassFaultInjectionEnabled(): boolean {
        return process.env.NODE_ENV === 'test';
    }

    private getForcedFailedSearchPassId(): 'primary' | 'expanded' | 'both' | undefined {
        if (!this.isSearchPassFaultInjectionEnabled()) {
            return undefined;
        }

        const raw = typeof process.env.SATORI_TEST_FAIL_SEARCH_PASS === 'string'
            ? process.env.SATORI_TEST_FAIL_SEARCH_PASS.trim().toLowerCase()
            : '';
        if (raw === 'primary' || raw === 'expanded' || raw === 'both') {
            return raw;
        }
        return undefined;
    }

    private shouldForceSearchPassFailure(passId: 'primary' | 'expanded'): boolean {
        const forced = this.getForcedFailedSearchPassId();
        if (!forced) {
            return false;
        }
        return forced === 'both' || forced === passId;
    }

    private mapCallGraphStatus(graph: { supported: boolean; reason?: string }): 'ok' | 'not_found' | 'unsupported' | 'not_ready' {
        if (graph.supported) {
            return 'ok';
        }

        if (graph.reason === 'missing_symbol') {
            return 'not_found';
        }

        if (graph.reason === 'unsupported_language') {
            return 'unsupported';
        }

        return 'not_ready';
    }

    private getContextIgnorePatterns(codebasePath: string): string[] {
        if (typeof (this.context as any).getActiveIgnorePatterns === 'function') {
            const patterns = (this.context as any).getActiveIgnorePatterns(codebasePath);
            if (Array.isArray(patterns)) {
                return patterns.filter((pattern) => typeof pattern === 'string');
            }
        }
        return [];
    }

    private async rebuildCallGraphForIndex(codebasePath: string): Promise<void> {
        try {
            const sidecar = await this.callGraphManager.rebuildForCodebase(codebasePath, this.getContextIgnorePatterns(codebasePath));
            this.snapshotManager.setCodebaseCallGraphSidecar(codebasePath, sidecar);
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' (${sidecar.nodeCount} nodes, ${sidecar.edgeCount} edges).`);
        } catch (error) {
            console.warn(`[CALL-GRAPH] Failed to rebuild sidecar after indexing '${codebasePath}': ${formatUnknownError(error)}`);
        }
    }

    private async rebuildCallGraphForSyncDelta(codebasePath: string, changedFiles: string[]): Promise<boolean> {
        try {
            const sidecar = await this.callGraphManager.rebuildIfSupportedDelta(
                codebasePath,
                changedFiles,
                this.getContextIgnorePatterns(codebasePath)
            );
            if (!sidecar) {
                return false;
            }
            this.snapshotManager.setCodebaseCallGraphSidecar(codebasePath, sidecar);
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' from sync delta (${sidecar.nodeCount} nodes, ${sidecar.edgeCount} edges).`);
            return true;
        } catch (error) {
            console.warn(`[CALL-GRAPH] Failed to rebuild sidecar after sync '${codebasePath}': ${formatUnknownError(error)}`);
            return false;
        }
    }

    private getVectorStore(): any {
        return this.context.getVectorStore() as any;
    }

    private isSatoriCodeCollection(collectionName: string): boolean {
        return SATORI_COLLECTION_PREFIXES.some((prefix) => collectionName.startsWith(prefix));
    }

    private getVectorBackendInfo(): VectorStoreBackendInfoView | null {
        const vectorDb = this.getVectorStore();
        if (typeof vectorDb.getBackendInfo !== 'function') {
            return null;
        }

        try {
            const info = vectorDb.getBackendInfo();
            if (!info || typeof info !== 'object') {
                return null;
            }

            if (info.provider !== 'milvus' && info.provider !== 'zilliz') {
                return null;
            }

            if (info.transport !== 'grpc' && info.transport !== 'rest') {
                return null;
            }

            return {
                provider: info.provider,
                transport: info.transport,
                address: typeof info.address === 'string' ? info.address : undefined,
            };
        } catch {
            return null;
        }
    }

    private isZillizBackend(): boolean {
        const backendInfo = this.getVectorBackendInfo();
        return backendInfo?.provider === 'zilliz';
    }

    private async listCollectionDetailsWithFallback(vectorDb: any): Promise<CollectionDetailsView[]> {
        if (typeof vectorDb.listCollectionDetails === 'function') {
            const details = await vectorDb.listCollectionDetails();
            if (Array.isArray(details)) {
                return details
                    .filter((detail): detail is CollectionDetailsView => Boolean(detail && typeof detail.name === 'string' && detail.name.length > 0))
                    .map((detail) => ({
                        name: detail.name,
                        createdAt: detail.createdAt,
                    }));
            }
        }

        const names = await vectorDb.listCollections();
        if (!Array.isArray(names)) {
            return [];
        }

        return names
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
            .map((name) => ({ name }));
    }

    private parseCodebaseFromMetadata(metadataValue: unknown): string | undefined {
        if (typeof metadataValue !== 'string' || metadataValue.trim().length === 0) {
            return undefined;
        }

        try {
            const metadata = JSON.parse(metadataValue);
            const codebasePath = metadata?.codebasePath;
            return typeof codebasePath === 'string' && codebasePath.trim().length > 0
                ? codebasePath
                : undefined;
        } catch {
            return undefined;
        }
    }

    private async resolveCollectionCodebasePath(
        vectorDb: any,
        collectionName: string,
        byCollectionName: Map<string, string>
    ): Promise<string | undefined> {
        const knownPath = byCollectionName.get(collectionName);
        if (knownPath) {
            return knownPath;
        }

        try {
            const results = await vectorDb.query(collectionName, '', ['metadata'], 1);
            if (!Array.isArray(results) || results.length === 0) {
                return undefined;
            }

            return this.parseCodebaseFromMetadata(results[0]?.metadata);
        } catch {
            return undefined;
        }
    }

    private formatCollectionTimestamp(createdAt?: string): string {
        if (!createdAt) {
            return '[unknown]';
        }

        const timestamp = Date.parse(createdAt);
        if (!Number.isFinite(timestamp)) {
            return createdAt;
        }

        return new Date(timestamp).toISOString();
    }

    private parseTimestampMs(timestamp?: string): number | undefined {
        if (!timestamp) {
            return undefined;
        }

        const parsed = Date.parse(timestamp);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private resolveCollectionSortTimestampMs(
        createdAt: string | undefined,
        codebasePath: string | undefined,
        snapshotLastUpdatedByPath: Map<string, number>
    ): number | undefined {
        const createdAtMs = this.parseTimestampMs(createdAt);
        const snapshotMs = codebasePath ? snapshotLastUpdatedByPath.get(codebasePath) : undefined;

        // Prefer collection metadata when it looks reliable.
        if (createdAtMs !== undefined && createdAtMs >= MIN_RELIABLE_COLLECTION_CREATED_AT_MS) {
            return createdAtMs;
        }

        // Fallback to snapshot timestamps when collection metadata is missing or suspicious.
        if (snapshotMs !== undefined) {
            return snapshotMs;
        }

        // Last resort for deterministic ordering when nothing else is available.
        return createdAtMs;
    }

    private async buildZillizCollectionLimitGuidance(targetCodebasePath: string): Promise<string> {
        const targetCollectionName = this.context.resolveCollectionName(targetCodebasePath);
        const vectorDb = this.getVectorStore();
        const collectionDetails = await this.listCollectionDetailsWithFallback(vectorDb);
        const codeCollections = collectionDetails.filter((detail) => this.isSatoriCodeCollection(detail.name));

        const trackedCodebases = this.snapshotManager.getAllCodebases().map((entry) => entry.path);
        const byCollectionName = new Map<string, string>();
        for (const codebasePath of trackedCodebases) {
            byCollectionName.set(this.context.resolveCollectionName(codebasePath), codebasePath);
        }
        const snapshotLastUpdatedByPath = new Map<string, number>();
        for (const entry of this.snapshotManager.getAllCodebases()) {
            const lastUpdatedMs = this.parseTimestampMs(entry.info.lastUpdated);
            if (lastUpdatedMs !== undefined) {
                snapshotLastUpdatedByPath.set(entry.path, lastUpdatedMs);
            }
        }

        const candidates: CandidateCollection[] = [];
        for (const detail of codeCollections) {
            const codebasePath = await this.resolveCollectionCodebasePath(vectorDb, detail.name, byCollectionName);
            candidates.push({
                name: detail.name,
                createdAt: detail.createdAt,
                codebasePath,
                isTargetCollection: detail.name === targetCollectionName,
                sortTimestampMs: this.resolveCollectionSortTimestampMs(
                    detail.createdAt,
                    codebasePath,
                    snapshotLastUpdatedByPath
                ),
            });
        }

        candidates.sort((a, b) => {
            const aValid = Number.isFinite(a.sortTimestampMs);
            const bValid = Number.isFinite(b.sortTimestampMs);
            if (aValid && bValid) {
                return (a.sortTimestampMs as number) - (b.sortTimestampMs as number);
            }
            if (aValid) return -1;
            if (bValid) return 1;
            return a.name.localeCompare(b.name);
        });

        const oldestName = candidates.length > 0 ? candidates[0].name : undefined;
        const newestName = candidates.length > 1 ? candidates[candidates.length - 1].name : oldestName;
        const lines = candidates.map((candidate, index) => {
            const codebaseInfo = candidate.codebasePath ? candidate.codebasePath : '[unknown]';
            const labels: string[] = [];
            if (candidate.name === oldestName) labels.push('oldest');
            if (candidate.name === newestName) labels.push('newest');
            if (candidate.isTargetCollection) labels.push('target');
            const labelText = labels.length > 0 ? ` [${labels.join(', ')}]` : '';
            return `${index + 1}. ${candidate.name}${labelText} | codebase: ${codebaseInfo} | created: ${this.formatCollectionTimestamp(candidate.createdAt)}`;
        });

        const suggestions = lines.length > 0
            ? lines.join('\n')
            : 'No Satori-managed collections were discovered.';

        return `${COLLECTION_LIMIT_MESSAGE}

Reason: Zilliz free-tier clusters are capped at ${ZILLIZ_FREE_TIER_COLLECTION_LIMIT} collections, and this cluster has no remaining collection slots.
Target codebase: '${targetCodebasePath}'
Target collection: '${targetCollectionName}'

Current Satori-managed collections (oldest -> newest):
${suggestions}

To continue, choose one collection from the list and retry:
manage_index {"action":"create","path":"${targetCodebasePath}","zillizDropCollection":"<collection_name>"}

Agent instructions:
1. Show this list to the user and ask which collection to delete.
2. Do not auto-delete without explicit user confirmation.
3. Retry create with zillizDropCollection set to the exact chosen collection name.`;
    }

    private async buildCollectionLimitMessage(targetCodebasePath: string): Promise<string> {
        if (!this.isZillizBackend()) {
            return COLLECTION_LIMIT_MESSAGE;
        }

        try {
            return await this.buildZillizCollectionLimitGuidance(targetCodebasePath);
        } catch (error) {
            console.warn(`[INDEX-VALIDATION] Failed to build Zilliz collection guidance: ${formatUnknownError(error)}`);
            return COLLECTION_LIMIT_MESSAGE;
        }
    }

    private async clearAllCollectionsForForceReindex(codebasePath: string): Promise<string[]> {
        const vectorDb = this.getVectorStore();
        const resolvedCollectionName = this.context.resolveCollectionName(codebasePath);
        const hash = resolvedCollectionName.split('_').pop();

        const candidateNames = new Set<string>();
        if (hash) {
            candidateNames.add(`code_chunks_${hash}`);
            candidateNames.add(`hybrid_code_chunks_${hash}`);
        }
        candidateNames.add(resolvedCollectionName);

        try {
            const cloudCollections = await this.listCollectionDetailsWithFallback(vectorDb);
            for (const collection of cloudCollections) {
                if (!this.isSatoriCodeCollection(collection.name)) {
                    continue;
                }
                if (hash && collection.name.endsWith(`_${hash}`)) {
                    candidateNames.add(collection.name);
                }
            }
        } catch (error) {
            console.warn(`[FORCE-REINDEX] Failed to list cloud collections while preparing cleanup: ${formatUnknownError(error)}`);
        }

        const droppedCollections: string[] = [];
        for (const candidateName of candidateNames) {
            try {
                if (await vectorDb.hasCollection(candidateName)) {
                    await vectorDb.dropCollection(candidateName);
                    droppedCollections.push(candidateName);
                }
            } catch (error) {
                console.warn(`[FORCE-REINDEX] Failed to drop collection '${candidateName}': ${formatUnknownError(error)}`);
            }
        }

        // Ensure local Merkle/snapshot state is cleared for this codebase.
        try {
            await this.context.clearIndex(codebasePath);
        } catch (error) {
            console.warn(`[FORCE-REINDEX] Failed to clear local sync snapshot for '${codebasePath}': ${formatUnknownError(error)}`);
        }

        return droppedCollections;
    }

    private async dropZillizCollectionForCreate(collectionName: string): Promise<{ droppedCodebasePath?: string }> {
        const trimmedName = collectionName.trim();
        if (trimmedName.length === 0) {
            throw new Error('zillizDropCollection must be a non-empty string.');
        }

        if (!this.isSatoriCodeCollection(trimmedName)) {
            throw new Error(`zillizDropCollection '${trimmedName}' is not a Satori-managed collection (expected prefix ${SATORI_COLLECTION_PREFIXES.join(' or ')}).`);
        }

        const vectorDb = this.getVectorStore();
        if (!await vectorDb.hasCollection(trimmedName)) {
            throw new Error(`Collection '${trimmedName}' does not exist in the connected Zilliz cluster.`);
        }

        const droppedCodebasePath = await this.resolveCollectionCodebasePath(vectorDb, trimmedName, new Map());
        await vectorDb.dropCollection(trimmedName);

        if (droppedCodebasePath) {
            this.snapshotManager.removeCodebaseCompletely(droppedCodebasePath);
            this.snapshotManager.saveCodebaseSnapshot();
            try {
                await this.syncManager.unregisterCodebaseWatcher(droppedCodebasePath);
            } catch {
                // Best-effort watcher cleanup; dropping cloud collection remains successful.
            }
        }

        return { droppedCodebasePath };
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * gets the first document from each collection to extract codebasePath from metadata,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorStore();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud`);
                // If no collections in cloud, remove all local codebases
                const localCodebases = this.snapshotManager.getIndexedCodebases();
                if (localCodebases.length > 0) {
                    console.log(`[SYNC-CLOUD] 🧹 Removing ${localCodebases.length} local codebases as cloud has no collections`);
                    for (const codebasePath of localCodebases) {
                        this.snapshotManager.removeIndexedCodebase(codebasePath);
                        console.log(`[SYNC-CLOUD] ➖ Removed local codebase: ${codebasePath}`);
                    }
                    this.snapshotManager.saveCodebaseSnapshot();
                    console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match empty cloud state`);
                }
                return;
            }

            const cloudCodebases = new Set<string>();

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Query the first document to get metadata
                    const results = await vectorDb.query(
                        collectionName,
                        '', // Empty filter to get all results
                        ['metadata'], // Only fetch metadata field
                        1 // Only need one result to extract codebasePath
                    );

                    if (results && results.length > 0) {
                        const firstResult = results[0];
                        const metadataStr = firstResult.metadata;

                        if (metadataStr) {
                            try {
                                const metadata = JSON.parse(metadataStr);
                                const codebasePath = metadata.codebasePath;

                                if (codebasePath && typeof codebasePath === 'string') {
                                    console.log(`[SYNC-CLOUD] 📍 Found codebase path: ${codebasePath} in collection: ${collectionName}`);
                                    cloudCodebases.add(codebasePath);
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                }
                            } catch (parseError) {
                                console.warn(`[SYNC-CLOUD] ⚠️  Failed to parse metadata JSON for collection ${collectionName}:`, parseError);
                            }
                        } else {
                            console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                        }
                    } else {
                        console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud`);

            // Get current local codebases
            const localIndexedCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localIndexedCodebases.size} locally indexed codebases in snapshot`);

            // Get codebases that are currently indexing (might have been interrupted)
            const indexingCodebases = this.snapshotManager.getIndexingCodebases();
            console.log(`[SYNC-CLOUD] 📊 Found ${indexingCodebases.length} codebases currently indexing`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud
            for (const localCodebase of localIndexedCodebases) {
                if (!cloudCodebases.has(localCodebase)) {
                    this.snapshotManager.removeIndexedCodebase(localCodebase);
                    hasChanges = true;
                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // FIX: Mark interrupted indexing codebases as indexed if they exist in cloud
            // This handles the case where indexing was interrupted but cloud index is complete
            for (const codebasePath of indexingCodebases) {
                if (cloudCodebases.has(codebasePath)) {
                    console.log(`[SYNC-CLOUD] 🔄 Marking interrupted indexing codebase as indexed: ${codebasePath}`);
                    // Get the last known stats from the snapshot info
                    const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                    const indexedFiles = (info as any)?.indexedFiles || 0;
                    const totalChunks = (info as any)?.totalChunks || 0;

                    // Mark as indexed with known stats
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles,
                        totalChunks,
                        status: 'completed'
                    }, this.runtimeFingerprint, 'verified');
                    hasChanges = true;
                } else if (await this.context.hasIndexedCollection(codebasePath)) {
                    // Double-check with hasIndexedCollection method
                    console.log(`[SYNC-CLOUD] 🔄 hasIndexedCollection confirms cloud index exists for: ${codebasePath}`);
                    const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                    const indexedFiles = (info as any)?.indexedFiles || 0;
                    const totalChunks = (info as any)?.totalChunks || 0;

                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles,
                        totalChunks,
                        status: 'completed'
                    }, this.runtimeFingerprint, 'verified');
                    hasChanges = true;
                }
            }

            // Note: We don't add cloud codebases that are missing locally (as per user requirement)
            console.log(`[SYNC-CLOUD] ℹ️  Skipping addition of cloud codebases not present locally (per sync policy)`);

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, formatUnknownError(error));
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns, zillizDropCollection } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];
        const requestedDropCollection = typeof zillizDropCollection === 'string' ? zillizDropCollection.trim() : undefined;
        let dropSummaryLine = '';

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (splitterType !== 'ast' && splitterType !== 'langchain') {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${splitterType}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                    }],
                    isError: true
                };
            }

            const existingInfo = this.snapshotManager.getCodebaseInfo(absolutePath);
            if (!forceReindex && existingInfo?.status === 'requires_reindex') {
                return {
                    content: [{
                        type: "text",
                        text: this.buildReindexInstruction(absolutePath, existingInfo.message)
                    }],
                    isError: true
                };
            }

            //Check if the snapshot and cloud index are in sync
            if (this.snapshotManager.getIndexedCodebases().includes(absolutePath) !== await this.context.hasIndexedCollection(absolutePath)) {
                console.warn(`[INDEX-VALIDATION] ❌ Snapshot and cloud index mismatch: ${absolutePath}`);
            }

            // Check if already indexed (unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed.

To update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.
To force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`
                    }],
                    isError: true
                };
            }

            // If force reindex, always clear every previous collection for this codebase hash.
            if (forceReindex) {
                console.log(`[FORCE-REINDEX] 🔄 Preparing force cleanup for '${absolutePath}'`);
                this.snapshotManager.removeCodebaseCompletely(absolutePath);
                this.snapshotManager.saveCodebaseSnapshot();
                try {
                    await this.syncManager.unregisterCodebaseWatcher(absolutePath);
                } catch {
                    // Best-effort watcher cleanup before force rebuild.
                }

                const droppedCollections = await this.clearAllCollectionsForForceReindex(absolutePath);
                if (droppedCollections.length > 0) {
                    const sortedDroppedCollections = [...droppedCollections].sort();
                    dropSummaryLine += `\nForce reindex cleanup dropped ${sortedDroppedCollections.length} prior collection(s) for this codebase hash: ${sortedDroppedCollections.join(', ')}.`;
                } else {
                    dropSummaryLine += `\nForce reindex cleanup found no prior collections for this codebase hash.`;
                }
            }

            if (requestedDropCollection) {
                if (!this.isZillizBackend()) {
                    return {
                        content: [{
                            type: "text",
                            text: "Error: zillizDropCollection is only supported when connected to a Zilliz Cloud backend."
                        }],
                        isError: true
                    };
                }

                const targetCollectionName = this.context.resolveCollectionName(absolutePath);
                if (requestedDropCollection === targetCollectionName) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: zillizDropCollection cannot target '${targetCollectionName}' for this same codebase create flow. Use {"action":"create","path":"${absolutePath}","force":true} for reindexing this codebase.`
                        }],
                        isError: true
                    };
                }

                const dropResult = await this.dropZillizCollectionForCreate(requestedDropCollection);
                dropSummaryLine += dropResult.droppedCodebasePath
                    ? `\nDropped Zilliz collection '${requestedDropCollection}' (mapped codebase: '${dropResult.droppedCodebasePath}').`
                    : `\nDropped Zilliz collection '${requestedDropCollection}'.`;
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorStore().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);
                    const guidanceMessage = await this.buildCollectionLimitMessage(absolutePath);
                    return {
                        content: [{
                            type: "text",
                            text: guidanceMessage
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                if (isCollectionLimitError(validationError)) {
                    const guidanceMessage = await this.buildCollectionLimitMessage(absolutePath);
                    return {
                        content: [{
                            type: "text",
                            text: guidanceMessage
                        }],
                        isError: true
                    };
                }

                const validationMessage = formatUnknownError(validationError);
                return {
                    content: [{
                        type: "text",
                        text: `Error validating collection creation: ${validationMessage}`
                    }],
                    isError: true
                };
            }

            // Add custom extensions if provided
            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`);
                this.context.addCustomExtensions(customFileExtensions);
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed
            this.startBackgroundIndexing(absolutePath, forceReindex, splitterType);

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${dropSummaryLine}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);
            const errorMessage = formatUnknownError(error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, splitterType: string) {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            // Use the existing Context instance for indexing.
            let contextForThisTask = this.context;
            if (splitterType !== 'ast') {
                console.warn(`[BACKGROUND-INDEX] Non-AST splitter '${splitterType}' requested; falling back to AST splitter`);
            }

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            await this.context.loadResolvedIgnorePatterns(absolutePath);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            const { FileSynchronizer } = await import("@zokizuan/satori-core");
            const ignorePatterns = this.context.getActiveIgnorePatterns(absolutePath) || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.ensureCollectionPrepared(absolutePath);
            const collectionName = this.context.resolveCollectionName(absolutePath);
            this.context.registerSynchronizer(collectionName, synchronizer);
            if (contextForThisTask !== this.context) {
                contextForThisTask.registerSynchronizer(collectionName, synchronizer);
            }

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const encoderEngine = this.context.getEmbeddingEngine();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${encoderEngine.getProvider()} with dimension: ${encoderEngine.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            });
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, this.runtimeFingerprint, 'verified');
            if (typeof this.context.getTrackedRelativePaths === 'function') {
                const trackedPaths = this.context.getTrackedRelativePaths(absolutePath);
                if (typeof this.snapshotManager.setCodebaseIndexManifest === 'function') {
                    this.snapshotManager.setCodebaseIndexManifest(absolutePath, trackedPaths);
                }
            }
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();
            await this.rebuildCallGraphForIndex(absolutePath);
            await this.syncManager.registerCodebaseWatcher(absolutePath);

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            let errorMessage = formatUnknownError(error);
            if (isCollectionLimitError(error)) {
                errorMessage = await this.buildCollectionLimitMessage(absolutePath);
            }
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleReindexCodebase(args: any) {
        const { path: codebasePath, splitter, customExtensions, ignorePatterns, zillizDropCollection } = args;
        return this.handleIndexCodebase({
            path: codebasePath,
            force: true,
            splitter,
            customExtensions,
            ignorePatterns,
            zillizDropCollection
        });
    }

    public async handleSearchCode(args: any) {
        const scope = (args?.scope || 'runtime') as SearchScope;
        const resultMode = (args?.resultMode || 'grouped') as SearchResultMode;
        const groupBy = (args?.groupBy || 'symbol') as SearchGroupBy;
        const rankingMode = (args?.rankingMode || 'auto_changed_first') as SearchRankingMode;
        const debug = args?.debug === true;
        const input: SearchRequestInput = {
            path: args?.path,
            query: args?.query,
            scope,
            resultMode,
            groupBy,
            rankingMode,
            limit: Number.isFinite(args?.limit) ? Math.max(1, Number(args.limit)) : 10,
            debug,
        };

        const isScopeValid = input.scope === 'runtime' || input.scope === 'mixed' || input.scope === 'docs';
        const isResultModeValid = input.resultMode === 'grouped' || input.resultMode === 'raw';
        const isGroupByValid = input.groupBy === 'symbol' || input.groupBy === 'file';
        const isRankingModeValid = input.rankingMode === 'default' || input.rankingMode === 'auto_changed_first';

        if (!isScopeValid || !isResultModeValid || !isGroupByValid || !isRankingModeValid || typeof input.query !== 'string' || input.query.trim().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "Error: Invalid search arguments. Required: path, query. Valid scope: runtime|mixed|docs. Valid resultMode: grouped|raw. Valid groupBy: symbol|file. Valid rankingMode: default|auto_changed_first."
                }],
                isError: true
            };
        }

        const searchDiagnostics = {
            queryLength: input.query.length,
            limitRequested: input.limit,
            resultsBeforeFilter: 0,
            resultsAfterFilter: 0,
            excludedByIgnore: 0,
            excludedBySubdirectory: 0,
            filterPass: 'expanded' as 'initial' | 'expanded',
            freshnessMode: undefined as string | undefined,
            searchPassCount: 0,
            searchPassSuccessCount: 0,
            searchPassFailureCount: 0,
        };

        try {
            await this.syncIndexedCodebasesFromCloud();

            const absolutePath = ensureAbsolutePath(input.path);
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${input.path}'`
                    }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            const blockedRoot = this.getMatchingBlockedRoot(absolutePath);
            if (blockedRoot) {
                const payload = this.buildRequiresReindexPayload(blockedRoot.path, blockedRoot.message, {
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                }) as unknown as SearchResponseEnvelope;
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                    meta: { searchDiagnostics }
                };
            }

            let effectiveRoot = absolutePath;
            let isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            let isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                const indexedCodebases = this.snapshotManager.getIndexedCodebases();
                const parents = indexedCodebases.filter(root => absolutePath.startsWith(root) && absolutePath !== root);
                if (parents.length > 0) {
                    parents.sort((a: string, b: string) => b.length - a.length);
                    effectiveRoot = parents[0];
                    isIndexed = true;
                    isIndexing = this.snapshotManager.getIndexingCodebases().includes(effectiveRoot);
                    console.log(`[SEARCH] Auto-resolved subdirectory '${absolutePath}' to indexed root '${effectiveRoot}'`);
                } else {
                    const envelope: SearchResponseEnvelope = {
                        status: "not_indexed",
                        path: absolutePath,
                        query: input.query,
                        scope: input.scope,
                        groupBy: input.groupBy,
                        limit: input.limit,
                        resultMode: input.resultMode,
                        freshnessDecision: null,
                        message: `Codebase '${absolutePath}' (or any parent) is not indexed.`,
                        hints: {
                            create: {
                                tool: "manage_index",
                                args: { action: "create", path: absolutePath }
                            }
                        },
                        results: []
                    };
                    return {
                        content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
                        meta: { searchDiagnostics }
                    };
                }
            }

            const gateResult = this.enforceFingerprintGate(effectiveRoot);
            if (gateResult.blockedResponse) {
                const payload = this.buildRequiresReindexPayload(effectiveRoot, gateResult.message, {
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    resultMode: input.resultMode,
                    limit: input.limit
                }) as unknown as SearchResponseEnvelope;
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                    meta: { searchDiagnostics }
                };
            }

            const freshnessDecision = await this.syncManager.ensureFreshness(effectiveRoot, 3 * 60 * 1000);
            searchDiagnostics.freshnessMode = freshnessDecision.mode;
            const encoderEngine = this.context.getEmbeddingEngine();
            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Query: "${input.query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);
            console.log(`[SEARCH] 🧠 Using embedding provider: ${encoderEngine.getProvider()} for search`);

            const parsedOperators = this.parseSearchOperators(input.query);
            const semanticQuery = parsedOperators.semanticQuery;
            const expandedQuery = `${semanticQuery}\nimplementation runtime source entrypoint`;
            const maxAttempts = parsedOperators.must.length > 0 ? 1 + SEARCH_MUST_RETRY_ROUNDS : 1;
            let candidateLimit = Math.max(1, Math.min(SEARCH_MAX_CANDIDATES, Math.max(input.limit * 8, 32)));
            const operatorSummary = this.buildOperatorSummary(parsedOperators);
            let filterSummary: SearchFilterSummary = {
                removedByScope: 0,
                removedByLanguage: 0,
                removedByPathInclude: 0,
                removedByPathExclude: 0,
                removedByMust: 0,
                removedByExclude: 0,
            };
            const changedFilesState = input.rankingMode === 'auto_changed_first'
                ? this.getChangedFilesForCodebase(effectiveRoot)
                : { available: false, files: new Set<string>() };
            const changedFilesBoostEnabled = changedFilesState.available && changedFilesState.files.size > 0;
            let boostedCandidates = 0;
            let attemptsUsed = 0;
            const searchWarningsSet = new Set<string>();
            const passesUsed = new Set<string>();
            let scored: SearchCandidate[] = [];

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                attemptsUsed = attempt + 1;
                const passDescriptors = [
                    { id: 'primary', query: semanticQuery },
                    { id: 'expanded', query: expandedQuery },
                ] as const;
                searchDiagnostics.searchPassCount += passDescriptors.length;

                const passSettled = await Promise.allSettled(passDescriptors.map(async (pass) => {
                    const passId = pass.id as 'primary' | 'expanded';
                    if (this.shouldForceSearchPassFailure(passId)) {
                        throw new Error(`FORCED_TEST_SEARCH_PASS_FAILURE:${passId}`);
                    }
                    return this.context.semanticSearch(effectiveRoot, pass.query, candidateLimit, 0.3);
                }));

                const successfulPasses: Array<{ id: string; results: any[] }> = [];
                for (let idx = 0; idx < passSettled.length; idx++) {
                    const passResult = passSettled[idx];
                    const passDescriptor = passDescriptors[idx];
                    if (passResult.status === 'fulfilled' && Array.isArray(passResult.value)) {
                        successfulPasses.push({
                            id: passDescriptor.id,
                            results: passResult.value
                        });
                        passesUsed.add(passDescriptor.id);
                        continue;
                    }

                    searchWarningsSet.add(this.buildSearchPassWarning(passDescriptor.id));
                }

                searchDiagnostics.searchPassSuccessCount += successfulPasses.length;
                searchDiagnostics.searchPassFailureCount += passDescriptors.length - successfulPasses.length;

                if (successfulPasses.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: "Error searching code: all semantic search passes failed. Please retry and verify embedding/vector backends are reachable."
                        }],
                        isError: true,
                        meta: { searchDiagnostics }
                    };
                }

                const byChunkKey = new Map<string, SearchCandidate>();
                const attemptFilterSummary: SearchFilterSummary = {
                    removedByScope: 0,
                    removedByLanguage: 0,
                    removedByPathInclude: 0,
                    removedByPathExclude: 0,
                    removedByMust: 0,
                    removedByExclude: 0,
                };
                const addPass = (results: any[], passWeight = 1) => {
                    for (let i = 0; i < results.length; i++) {
                        const result = results[i];
                        if (!result || typeof result.relativePath !== 'string') continue;
                        const key = `${result.relativePath}:${result.startLine}:${result.endLine}:${result.language || 'unknown'}`;
                        const rank = i + 1;
                        const rrf = passWeight * (1 / (SEARCH_RRF_K + rank));
                        const existing = byChunkKey.get(key);
                        if (!existing) {
                            byChunkKey.set(key, {
                                result,
                                baseScore: typeof result.score === 'number' ? result.score : 0,
                                fusionScore: rrf,
                                finalScore: 0,
                                pathCategory: 'neutral',
                                pathMultiplier: 1.0,
                                changedFilesMultiplier: 1.0,
                                passesMatchedMust: false,
                            });
                        } else {
                            existing.fusionScore += rrf;
                            if (typeof result.score === 'number') {
                                existing.baseScore = Math.max(existing.baseScore, result.score);
                            }
                        }
                    }
                };

                for (const pass of successfulPasses) {
                    addPass(pass.results, 1);
                }

                const beforeFilter = byChunkKey.size;
                const scoredAttempt: SearchCandidate[] = [];
                for (const candidate of byChunkKey.values()) {
                    const category = this.classifyPathCategory(candidate.result.relativePath);
                    if (!this.shouldIncludeCategoryInScope(input.scope, category)) {
                        attemptFilterSummary.removedByScope += 1;
                        continue;
                    }

                    const languageValue = typeof candidate.result.language === 'string'
                        ? candidate.result.language.toLowerCase()
                        : 'unknown';
                    if (parsedOperators.lang.length > 0 && !parsedOperators.lang.includes(languageValue)) {
                        attemptFilterSummary.removedByLanguage += 1;
                        continue;
                    }

                    const relativePath = String(candidate.result.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
                    if (parsedOperators.path.length > 0 && !this.pathMatchesAnyPattern(relativePath, parsedOperators.path)) {
                        attemptFilterSummary.removedByPathInclude += 1;
                        continue;
                    }

                    if (parsedOperators.excludePath.length > 0 && this.pathMatchesAnyPattern(relativePath, parsedOperators.excludePath)) {
                        attemptFilterSummary.removedByPathExclude += 1;
                        continue;
                    }

                    const symbolLabel = typeof candidate.result.symbolLabel === 'string' ? candidate.result.symbolLabel : '';
                    const content = typeof candidate.result.content === 'string' ? candidate.result.content : '';
                    const fields = [symbolLabel, relativePath, content];
                    const matchesMust = parsedOperators.must.every((token) => this.tokenMatchesAnyField(token, fields));
                    if (!matchesMust) {
                        attemptFilterSummary.removedByMust += 1;
                        continue;
                    }

                    const matchesExclude = parsedOperators.exclude.some((token) => this.tokenMatchesAnyField(token, fields));
                    if (matchesExclude) {
                        attemptFilterSummary.removedByExclude += 1;
                        continue;
                    }

                    const pathMultiplier = SCOPE_PATH_MULTIPLIERS[input.scope][category];
                    let changedFilesMultiplier = 1.0;
                    if (changedFilesBoostEnabled && changedFilesState.files.has(relativePath)) {
                        changedFilesMultiplier = SEARCH_CHANGED_FIRST_MULTIPLIER;
                        boostedCandidates += 1;
                    }

                    candidate.pathCategory = category;
                    candidate.pathMultiplier = pathMultiplier;
                    candidate.changedFilesMultiplier = changedFilesMultiplier;
                    candidate.passesMatchedMust = matchesMust;
                    candidate.finalScore = candidate.fusionScore * pathMultiplier * changedFilesMultiplier;
                    scoredAttempt.push(candidate);
                }

                searchDiagnostics.resultsBeforeFilter = beforeFilter;
                searchDiagnostics.resultsAfterFilter = scoredAttempt.length;
                filterSummary = attemptFilterSummary;
                scored = scoredAttempt;

                scored.sort((a, b) => {
                    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
                    const fileCmp = a.result.relativePath.localeCompare(b.result.relativePath);
                    if (fileCmp !== 0) return fileCmp;
                    const startCmp = this.compareNullableNumbersAsc(a.result.startLine, b.result.startLine);
                    if (startCmp !== 0) return startCmp;
                    const labelCmp = this.compareNullableStringsAsc(a.result.symbolLabel, b.result.symbolLabel);
                    if (labelCmp !== 0) return labelCmp;
                    return this.compareNullableStringsAsc(a.result.symbolId, b.result.symbolId);
                });

                if (parsedOperators.must.length === 0 || scored.length >= input.limit || attempt === maxAttempts - 1 || candidateLimit >= SEARCH_MAX_CANDIDATES) {
                    break;
                }

                candidateLimit = Math.min(
                    SEARCH_MAX_CANDIDATES,
                    Math.max(candidateLimit + 1, candidateLimit * SEARCH_MUST_RETRY_MULTIPLIER)
                );
            }

            searchDiagnostics.excludedByIgnore = Math.max(0, searchDiagnostics.resultsBeforeFilter - searchDiagnostics.resultsAfterFilter);
            const searchWarnings = Array.from(searchWarningsSet);
            const mustApplied = parsedOperators.must.length > 0;
            const mustSatisfied = !mustApplied || scored.length > 0;
            if (mustApplied && !mustSatisfied) {
                searchWarnings.push('FILTER_MUST_UNSATISFIED');
            }

            const debugHintBase: SearchDebugHint | undefined = input.debug
                ? {
                    passesUsed: Array.from(passesUsed).sort(),
                    candidateLimit,
                    mustRetry: {
                        attempts: attemptsUsed,
                        maxAttempts,
                        applied: mustApplied,
                        satisfied: mustSatisfied,
                        finalCount: scored.length,
                    },
                    operatorSummary,
                    filterSummary,
                    changedFilesBoost: {
                        enabled: input.rankingMode === 'auto_changed_first',
                        available: changedFilesState.available,
                        changedCount: changedFilesState.files.size,
                        multiplier: SEARCH_CHANGED_FIRST_MULTIPLIER,
                        boostedCandidates,
                    }
                }
                : undefined;

            if (input.resultMode === 'raw') {
                const rawResults: SearchChunkResult[] = scored.slice(0, input.limit).map((candidate) => ({
                    kind: "chunk",
                    file: candidate.result.relativePath,
                    span: {
                        startLine: candidate.result.startLine || 0,
                        endLine: candidate.result.endLine || 0,
                    },
                    language: candidate.result.language || "unknown",
                    content: String(candidate.result.content || ""),
                    score: candidate.finalScore,
                    indexedAt: typeof candidate.result.indexedAt === 'string' ? candidate.result.indexedAt : undefined,
                    stalenessBucket: this.getStalenessBucket(candidate.result.indexedAt),
                    symbolId: typeof candidate.result.symbolId === 'string' ? candidate.result.symbolId : undefined,
                    symbolLabel: typeof candidate.result.symbolLabel === 'string' ? candidate.result.symbolLabel : undefined,
                    ...(input.debug ? {
                        debug: {
                            baseScore: candidate.baseScore,
                            fusionScore: candidate.fusionScore,
                            pathMultiplier: candidate.pathMultiplier,
                            pathCategory: candidate.pathCategory,
                            changedFilesMultiplier: candidate.changedFilesMultiplier,
                            matchesMust: candidate.passesMatchedMust
                        }
                    } : {})
                }));
                const noiseMitigationHint = this.buildNoiseMitigationHint(rawResults.map((result) => result.file));
                const responseHints: Record<string, unknown> = {};
                if (noiseMitigationHint || debugHintBase) {
                    responseHints.version = 1 as const;
                }
                if (noiseMitigationHint) {
                    responseHints.noiseMitigation = noiseMitigationHint;
                }
                if (debugHintBase) {
                    responseHints.debugSearch = debugHintBase;
                }

                const envelope: SearchResponseEnvelope = {
                    status: "ok",
                    path: absolutePath,
                    query: input.query,
                    scope: input.scope,
                    groupBy: input.groupBy,
                    limit: input.limit,
                    resultMode: "raw",
                    freshnessDecision,
                    ...(searchWarnings.length > 0 ? { warnings: searchWarnings } : {}),
                    ...(Object.keys(responseHints).length > 0 ? { hints: responseHints } : {}),
                    results: rawResults
                };

                return {
                    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
                    meta: { searchDiagnostics }
                };
            }

            type GroupAccumulator = {
                chunks: SearchCandidate[];
            };

            const groups = new Map<string, GroupAccumulator>();
            for (const candidate of scored) {
                const result = candidate.result;
                let groupKey = '';
                if (input.groupBy === 'file') {
                    groupKey = `file:${result.relativePath}`;
                } else if (result.symbolId) {
                    groupKey = `symbol:${result.symbolId}`;
                } else {
                    const proximityBucket = Math.floor((Math.max(1, result.startLine || 1) - 1) / SEARCH_PROXIMITY_WINDOW);
                    groupKey = `fallback:${result.relativePath}:${proximityBucket}`;
                }

                const existing = groups.get(groupKey);
                if (!existing) {
                    groups.set(groupKey, { chunks: [candidate] });
                } else {
                    existing.chunks.push(candidate);
                }
            }

            const groupedResults: SearchGroupResult[] = [];
            for (const group of groups.values()) {
                group.chunks.sort((a, b) => {
                    if (a.passesMatchedMust !== b.passesMatchedMust) {
                        return a.passesMatchedMust ? -1 : 1;
                    }
                    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
                    const fileCmp = a.result.relativePath.localeCompare(b.result.relativePath);
                    if (fileCmp !== 0) return fileCmp;
                    const startCmp = this.compareNullableNumbersAsc(a.result.startLine, b.result.startLine);
                    if (startCmp !== 0) return startCmp;
                    const labelCmp = this.compareNullableStringsAsc(a.result.symbolLabel, b.result.symbolLabel);
                    if (labelCmp !== 0) return labelCmp;
                    return this.compareNullableStringsAsc(a.result.symbolId, b.result.symbolId);
                });
                const representative = group.chunks[0];
                const spanStart = Math.min(...group.chunks.map((c) => c.result.startLine || 0));
                const spanEnd = Math.max(...group.chunks.map((c) => c.result.endLine || 0));
                const span: SearchSpan = { startLine: spanStart, endLine: spanEnd };

                let indexedAtMax: string | undefined;
                let indexedAtMaxMs = Number.NEGATIVE_INFINITY;
                for (const chunk of group.chunks) {
                    const indexedAt = typeof chunk.result.indexedAt === 'string' ? chunk.result.indexedAt : undefined;
                    const indexedAtMs = this.parseIndexedAtMs(indexedAt);
                    if (indexedAtMs !== undefined && indexedAtMs > indexedAtMaxMs) {
                        indexedAtMaxMs = indexedAtMs;
                        indexedAtMax = indexedAt;
                    }
                }

                const repSymbolId = typeof representative.result.symbolId === 'string' ? representative.result.symbolId : null;
                const repSymbolLabel = typeof representative.result.symbolLabel === 'string' ? representative.result.symbolLabel : null;
                const groupId = repSymbolId || this.buildFallbackGroupId(representative.result.relativePath, span);
                const callGraphHint = this.buildCallGraphHint(
                    representative.result.relativePath,
                    span,
                    representative.result.language || 'unknown',
                    repSymbolId || undefined,
                    repSymbolLabel || undefined
                );

                groupedResults.push({
                    kind: "group",
                    groupId,
                    file: representative.result.relativePath,
                    span,
                    language: representative.result.language || 'unknown',
                    symbolId: repSymbolId,
                    symbolLabel: repSymbolLabel,
                    score: representative.finalScore,
                    indexedAt: indexedAtMax || null,
                    stalenessBucket: this.getStalenessBucket(indexedAtMax),
                    collapsedChunkCount: group.chunks.length,
                    callGraphHint,
                    preview: truncateContent(String(representative.result.content || ''), 4000),
                    ...(input.debug ? {
                        debug: {
                            representativeChunkCount: group.chunks.length,
                            pathCategory: representative.pathCategory,
                            pathMultiplier: representative.pathMultiplier,
                            topChunkScore: representative.finalScore,
                            changedFilesMultiplier: representative.changedFilesMultiplier,
                            matchesMust: representative.passesMatchedMust
                        }
                    } : {})
                });
            }

            groupedResults.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                const fileCmp = a.file.localeCompare(b.file);
                if (fileCmp !== 0) return fileCmp;
                const spanCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
                if (spanCmp !== 0) return spanCmp;
                const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
                if (labelCmp !== 0) return labelCmp;
                return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
            });

            const diversityApplied = this.applyGroupDiversity(groupedResults, input.limit, input.groupBy);
            const visibleGroupedResults = diversityApplied.selected;
            const noiseMitigationHint = this.buildNoiseMitigationHint(visibleGroupedResults.map((result) => result.file));
            const responseHints: Record<string, unknown> = {};
            if (noiseMitigationHint || debugHintBase) {
                responseHints.version = 1 as const;
            }
            if (noiseMitigationHint) {
                responseHints.noiseMitigation = noiseMitigationHint;
            }
            if (debugHintBase) {
                responseHints.debugSearch = {
                    ...debugHintBase,
                    diversitySummary: diversityApplied.summary
                };
            }

            const envelope: SearchResponseEnvelope = {
                status: "ok",
                path: absolutePath,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                limit: input.limit,
                resultMode: "grouped",
                freshnessDecision,
                ...(searchWarnings.length > 0 ? { warnings: searchWarnings } : {}),
                ...(Object.keys(responseHints).length > 0 ? { hints: responseHints } : {}),
                results: visibleGroupedResults
            };

            return {
                content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
                meta: { searchDiagnostics }
            };
        } catch (error) {
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                return {
                    content: [{ type: "text", text: COLLECTION_LIMIT_MESSAGE }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleFileOutline(args: FileOutlineInput) {
        const limitSymbols = Number.isFinite(args?.limitSymbols)
            ? Math.max(1, Number(args.limitSymbols))
            : 500;
        const requestedStartLine = Number.isFinite(args?.start_line) ? Math.max(1, Number(args.start_line)) : undefined;
        const requestedEndLine = Number.isFinite(args?.end_line) ? Math.max(1, Number(args.end_line)) : undefined;
        const resolveMode = args?.resolveMode === 'exact' ? 'exact' : 'outline';
        const symbolIdExact = typeof args?.symbolIdExact === 'string' ? args.symbolIdExact.trim() : undefined;
        const symbolLabelExact = typeof args?.symbolLabelExact === 'string' ? args.symbolLabelExact.trim() : undefined;

        try {
            await this.syncIndexedCodebasesFromCloud();

            const absoluteRoot = ensureAbsolutePath(args.path);
            const normalizedFile = this.normalizeRelativeFilePath(args.file);
            const absoluteFile = path.resolve(absoluteRoot, normalizedFile);
            const relativeToRoot = path.relative(absoluteRoot, absoluteFile);

            if (!fs.existsSync(absoluteRoot)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absoluteRoot}' does not exist.`
                    }],
                    isError: true
                };
            }

            const rootStat = fs.statSync(absoluteRoot);
            if (!rootStat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absoluteRoot}' is not a directory`
                    }],
                    isError: true
                };
            }

            if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: File '${normalizedFile}' must be inside codebase root '${absoluteRoot}'.`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absoluteRoot);

            const blockedRoot = this.getMatchingBlockedRoot(absoluteRoot);
            if (blockedRoot) {
                const payload = this.buildRequiresReindexFileOutlinePayload(blockedRoot.path, {
                    ...args,
                    file: normalizedFile
                }, blockedRoot.message);
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                };
            }

            const gateResult = this.enforceFingerprintGate(absoluteRoot);
            if (gateResult.blockedResponse) {
                const payload = this.buildRequiresReindexFileOutlinePayload(absoluteRoot, {
                    ...args,
                    file: normalizedFile
                }, gateResult.message);
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                };
            }

            const sidecarInfo = this.snapshotManager.getCodebaseCallGraphSidecar(absoluteRoot);
            if (!sidecarInfo || sidecarInfo.version !== 'v3') {
                const payload = this.buildRequiresReindexFileOutlinePayload(absoluteRoot, {
                    ...args,
                    file: normalizedFile
                });
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                };
            }

            if (!fs.existsSync(absoluteFile)) {
                const payload: FileOutlineResponseEnvelope = {
                    status: 'not_found',
                    path: absoluteRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `File '${normalizedFile}' does not exist under codebase root '${absoluteRoot}'.`
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                };
            }

            const fileStat = fs.statSync(absoluteFile);
            if (!fileStat.isFile()) {
                const payload: FileOutlineResponseEnvelope = {
                    status: 'not_found',
                    path: absoluteRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `'${normalizedFile}' is not a file.`
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                };
            }

            const languageStatus = this.getOutlineStatusForLanguage(normalizedFile);
            if (languageStatus !== 'ok') {
                const payload: FileOutlineResponseEnvelope = {
                    status: 'unsupported',
                    path: absoluteRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `File '${normalizedFile}' is not supported for sidecar outline. Supported extensions: ${OUTLINE_SUPPORTED_EXTENSIONS.join(', ')}.`
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                };
            }

            const sidecar = this.callGraphManager.loadSidecar(absoluteRoot);
            if (!sidecar) {
                const payload = this.buildRequiresReindexFileOutlinePayload(absoluteRoot, {
                    ...args,
                    file: normalizedFile
                });
                return {
                    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                };
            }

            const windowStart = requestedStartLine;
            const windowEnd = requestedEndLine && requestedStartLine
                ? Math.max(requestedEndLine, requestedStartLine)
                : requestedEndLine;

            const byFile = sidecar.nodes.filter((node) => this.normalizeRelativeFilePath(node.file) === normalizedFile);
            const windowed = byFile.filter((node) => {
                if (!windowStart && !windowEnd) {
                    return true;
                }

                const startsBeforeWindowEnd = windowEnd === undefined || node.span.startLine <= windowEnd;
                const endsAfterWindowStart = windowStart === undefined || node.span.endLine >= windowStart;
                return startsBeforeWindowEnd && endsAfterWindowStart;
            });

            const symbols = this.sortFileOutlineSymbols(windowed.map((node) => {
                const symbolLabel = (typeof node.symbolLabel === 'string' && node.symbolLabel.trim().length > 0)
                    ? node.symbolLabel
                    : node.symbolId;
                return {
                    symbolId: node.symbolId,
                    symbolLabel,
                    span: {
                        startLine: node.span.startLine,
                        endLine: node.span.endLine
                    },
                    callGraphHint: {
                        supported: true,
                        symbolRef: {
                            file: normalizedFile,
                            symbolId: node.symbolId,
                            symbolLabel,
                            span: {
                                startLine: node.span.startLine,
                                endLine: node.span.endLine
                            }
                        }
                    }
                } as FileOutlineSymbolResult;
            }));

            const missingSymbolMetadataCount = sidecar.notes.filter((note) => {
                return note.type === 'missing_symbol_metadata' && this.normalizeRelativeFilePath(note.file) === normalizedFile;
            }).length;
            const warnings = missingSymbolMetadataCount > 0
                ? [`OUTLINE_MISSING_SYMBOL_METADATA:${missingSymbolMetadataCount}`]
                : undefined;

            if (resolveMode === 'exact') {
                const exactMatches = this.sortFileOutlineSymbols(symbols.filter((symbol) => {
                    if (symbolIdExact && symbol.symbolId !== symbolIdExact) {
                        return false;
                    }
                    if (symbolLabelExact && symbol.symbolLabel !== symbolLabelExact) {
                        return false;
                    }
                    return true;
                }));

                if (exactMatches.length === 0) {
                    const payload: FileOutlineResponseEnvelope = {
                        status: 'not_found',
                        path: absoluteRoot,
                        file: normalizedFile,
                        outline: null,
                        hasMore: false,
                        message: 'No exact symbol match found in file outline.',
                        ...(warnings ? { warnings } : {})
                    };
                    return {
                        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
                    };
                }

                const hasMoreExact = exactMatches.length > limitSymbols;
                const exactPayload: FileOutlineResponseEnvelope = {
                    status: exactMatches.length > 1 ? 'ambiguous' : 'ok',
                    path: absoluteRoot,
                    file: normalizedFile,
                    outline: {
                        symbols: exactMatches.slice(0, limitSymbols)
                    },
                    hasMore: hasMoreExact,
                    ...(exactMatches.length > 1 ? {
                        message: `Multiple exact symbol matches found (${exactMatches.length}). Narrow with symbolIdExact for deterministic selection.`
                    } : {}),
                    ...(warnings ? { warnings } : {})
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(exactPayload, null, 2) }]
                };
            }

            const hasMore = symbols.length > limitSymbols;
            const payload: FileOutlineResponseEnvelope = {
                status: 'ok',
                path: absoluteRoot,
                file: normalizedFile,
                outline: {
                    symbols: symbols.slice(0, limitSymbols)
                },
                hasMore,
                ...(warnings ? { warnings } : {})
            };

            return {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
            };
        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error building file outline: ${error?.message || error}`
                }],
                isError: true
            };
        }
    }

    public async handleCallGraph(args: any) {
        const rawDirection = args?.direction;
        const direction: CallGraphDirection = rawDirection === 'callers' || rawDirection === 'callees' || rawDirection === 'both'
            ? rawDirection
            : 'both';
        const depth = Number.isFinite(args?.depth) ? Math.max(1, Math.min(3, Number(args.depth))) : 1;
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Number(args.limit)) : 20;
        const symbolRef = args?.symbolRef as CallGraphSymbolRef | undefined;

        if (!symbolRef || typeof symbolRef.file !== 'string' || typeof symbolRef.symbolId !== 'string') {
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        supported: false,
                        reason: 'invalid_symbol_ref',
                        hints: {
                            message: "symbolRef with { file, symbolId } is required."
                        }
                    }, null, 2)
                }],
                isError: true
            };
        }

        try {
            await this.syncIndexedCodebasesFromCloud();

            const absolutePath = ensureAbsolutePath(args?.path);
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist.`
                    }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            let effectiveRoot = absolutePath;
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            if (!indexedCodebases.includes(absolutePath)) {
                const blockedMatch = this.getMatchingBlockedRoot(absolutePath);
                if (blockedMatch) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(this.buildRequiresReindexCallGraphPayload(
                                blockedMatch.path,
                                blockedMatch.message,
                                {
                                    path: absolutePath,
                                    symbolRef,
                                    direction,
                                    depth,
                                    limit
                                }
                            ), null, 2)
                        }]
                    };
                }

                const parents = indexedCodebases.filter((root) => absolutePath.startsWith(root) && absolutePath !== root);
                if (parents.length > 0) {
                    parents.sort((a, b) => b.length - a.length);
                    effectiveRoot = parents[0];
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: 'not_indexed',
                                supported: false,
                                reason: 'not_indexed',
                                hints: {
                                    create: {
                                        tool: 'manage_index',
                                        args: { action: 'create', path: absolutePath }
                                    }
                                }
                            }, null, 2)
                        }]
                    };
                }
            }

            const gateResult = this.enforceFingerprintGate(effectiveRoot);
            if (gateResult.blockedResponse) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(this.buildRequiresReindexCallGraphPayload(
                            effectiveRoot,
                            gateResult.message,
                            {
                                path: absolutePath,
                                symbolRef,
                                direction,
                                depth,
                                limit
                            }
                        ), null, 2)
                    }]
                };
            }

            const sidecarInfo = this.snapshotManager.getCodebaseCallGraphSidecar(effectiveRoot);
            if (!sidecarInfo || sidecarInfo.version !== 'v3') {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: 'not_ready',
                            supported: false,
                            reason: 'missing_sidecar',
                            hints: {
                                message: 'Call graph sidecar is unavailable for this codebase. Reindex to rebuild call graph metadata.',
                                reindex: this.buildReindexHint(effectiveRoot)
                            }
                        }, null, 2)
                    }]
                };
            }

            const graph = this.callGraphManager.queryGraph(effectiveRoot, symbolRef, {
                direction,
                depth,
                limit
            });

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: this.mapCallGraphStatus(graph),
                        path: effectiveRoot,
                        symbolRef,
                        ...graph
                    }, null, 2)
                }]
            };
        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error generating call graph: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        if (this.snapshotManager.getAllCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently tracked."
                }]
            };
        }

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);
            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const isRequiresReindex = status === 'requires_reindex';

            if (!isIndexed && !isIndexing && !isRequiresReindex) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();
            await this.syncManager.unregisterCodebaseWatcher(absolutePath);

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check indexing status using new status system
            const statusGate = this.enforceFingerprintGate(absolutePath);
            if (statusGate.blockedResponse) {
                const statusMessage = this.buildReindexInstruction(absolutePath, statusGate.message);
                const compatibilityStatus = this.buildCompatibilityStatusLines(absolutePath);
                const pathInfo = codebasePath !== absolutePath
                    ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                    : '';

                return {
                    content: [{
                        type: "text",
                        text: statusMessage + compatibilityStatus + pathInfo
                    }]
                };
            }

            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const info = this.snapshotManager.getCodebaseInfo(absolutePath);

            let statusMessage = '';

            switch (status) {
                case 'indexed':
                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                    }
                    break;

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 Retry with manage_index action='create'.`;
                    } else {
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'sync_completed':
                    if (info && 'added' in info) {
                        const syncInfo = info as any;
                        statusMessage = `🔄 Codebase '${absolutePath}' sync completed.`;
                        statusMessage += `\n📊 Changes: +${syncInfo.added} added, -${syncInfo.removed} removed, ~${syncInfo.modified} modified`;
                        statusMessage += `\n🕐 Last synced: ${new Date(syncInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${absolutePath}' sync completed.`;
                    }
                    break;

                case 'requires_reindex':
                    statusMessage = this.buildReindexInstruction(absolutePath, info && 'message' in info ? info.message : undefined);
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Call manage_index with {\"action\":\"create\",\"path\":\"${absolutePath}\"} to index it first.`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';
            const compatibilityStatus = this.buildCompatibilityStatusLines(absolutePath);

            return {
                content: [{
                    type: "text",
                    text: statusMessage + compatibilityStatus + pathInfo
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error getting indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * Handle sync request - manually trigger incremental sync for a codebase
     */
    public async handleSyncCodebase(args: any) {
        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed
            const syncGate = this.enforceFingerprintGate(absolutePath);
            if (syncGate.blockedResponse) {
                return syncGate.blockedResponse;
            }

            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            if (!isIndexed) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Call manage_index with {\"action\":\"create\",\"path\":\"${absolutePath}\"} first.`
                    }],
                    isError: true
                };
            }

            console.log(`[SYNC] Manually triggering incremental sync for: ${absolutePath}`);

            // Perform incremental sync
            const syncStats = await this.context.reindexByChange(absolutePath);
            const changedFiles = Array.isArray((syncStats as any).changedFiles)
                ? (syncStats as any).changedFiles.filter((file: unknown): file is string => typeof file === 'string')
                : [];
            const syncTotals = {
                added: syncStats.added,
                removed: syncStats.removed,
                modified: syncStats.modified
            };

            if (typeof this.context.getTrackedRelativePaths === 'function') {
                const trackedPaths = this.context.getTrackedRelativePaths(absolutePath);
                if (typeof this.snapshotManager.setCodebaseIndexManifest === 'function') {
                    this.snapshotManager.setCodebaseIndexManifest(absolutePath, trackedPaths);
                }
            }

            // Store sync result in snapshot
            this.snapshotManager.setCodebaseSyncCompleted(absolutePath, syncTotals, this.runtimeFingerprint, 'verified');
            this.snapshotManager.saveCodebaseSnapshot();
            const rebuiltCallGraph = await this.rebuildCallGraphForSyncDelta(absolutePath, changedFiles);

            const totalChanges = syncStats.added + syncStats.removed + syncStats.modified;

            if (totalChanges === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `✅ No changes detected for codebase '${absolutePath}'. Index is up to date.`
                    }]
                };
            }

            const callGraphLine = rebuiltCallGraph
                ? `\n🕸️ Call graph sidecar rebuilt from supported source changes.`
                : '';
            const resultMessage = `🔄 Incremental sync completed for '${absolutePath}'.\n\n📊 Changes:\n+ ${syncStats.added} file(s) added\n- ${syncStats.removed} file(s) removed\n~ ${syncStats.modified} file(s) modified\n\nTotal changes: ${totalChanges}${callGraphLine}`;

            console.log(`[SYNC] ✅ Sync completed: +${syncStats.added}, -${syncStats.removed}, ~${syncStats.modified}`);

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };

        } catch (error: any) {
            console.error(`[SYNC] Error during sync:`, error);
            return {
                content: [{
                    type: "text",
                    text: `Error syncing codebase: ${error.message || error}`
                }],
                isError: true
            };
        }
    }
    public async handleReadCode(args: any) {
        const { path: filePath } = args;

        try {
            const absolutePath = ensureAbsolutePath(filePath);

            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{ type: "text", text: `Error: File '${absolutePath}' not found.` }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isFile()) {
                return {
                    content: [{ type: "text", text: `Error: '${absolutePath}' is not a file.` }],
                    isError: true
                };
            }

            // Read file
            const content = fs.readFileSync(absolutePath, 'utf-8');

            return {
                content: [{
                    type: "text",
                    text: content
                }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error reading file: ${error.message}` }],
                isError: true
            };
        }
    }
}
