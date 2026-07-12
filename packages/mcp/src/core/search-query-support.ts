import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";
import {
    compareContractStrings,
    createLanguageAnalysisService,
    getLanguageIdFromFilename,
    isLanguageCapabilitySupportedForFilename,
    openRegularFileInsideRoot,
    type SymbolRecord,
    type VoyageAIReranker,
} from "@zokizuan/satori-core";
import type { CapabilityResolver } from "./capabilities.js";
import type { IndexFingerprint } from "../config.js";
import {
    SEARCH_NOISE_HINT_PATTERNS,
    SEARCH_NOISE_HINT_THRESHOLD,
    SEARCH_NOISE_HINT_TOP_K,
    SEARCH_RERANK_DOC_MAX_CHARS,
    SEARCH_RERANK_DOC_MAX_LINES,
    type PathCategory,
    type SearchNoiseCategory,
    type SearchScope,
} from "./search-constants.js";
import type { SearchNoiseMitigationHint, SearchOperatorSummary } from "./search-types.js";
import type { ExactRegistryLookupDebug } from "./search/exact-registry.js";
import {
    hasTokenBoundaryMatch as hasSearchTokenBoundaryMatch,
    scoreCandidateLexicalEvidence as scoreSearchCandidateLexicalEvidence,
    type SearchLexicalEvidence,
    type SearchLexicalTerm,
    type SearchQueryPlan,
    type SearchResultLike,
} from "./search-lexical-scoring.js";
import {
    buildSearchQueryPlan as buildSearchQueryPlanFromText,
    parseSearchOperators as parseSearchOperatorsFromText,
    type ParsedSearchOperators,
} from "./search-query-planning.js";
const SEARCH_LIVE_PATH_SUPPLEMENT_MAX_BYTES = 256 * 1024;
const SEARCH_LIVE_PATH_SUPPLEMENT_MAX_FILES = 8;
const SEARCH_LIVE_PATH_SUPPLEMENT_MAX_RESULTS = 8;
const SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES = 2;
const SEARCH_DIRTY_OVERLAY_MAX_BYTES = 256 * 1024;
const SEARCH_DIRTY_OVERLAY_MAX_FILES = 16;
const SEARCH_DIRTY_OVERLAY_MAX_RESULTS = 16;
const SEARCH_DIRTY_OVERLAY_TOTAL_BYTES = 2 * 1024 * 1024;
const SEARCH_TRACKED_LEXICAL_MAX_BYTES = 192 * 1024;
const SEARCH_TRACKED_LEXICAL_MAX_FILES = 128;
const SEARCH_TRACKED_LEXICAL_MAX_RESULTS = 16;
const SEARCH_TRACKED_LEXICAL_CONTEXT_LINES = 2;
const SEARCH_TRACKED_LEXICAL_TOTAL_BYTES = 2 * 1024 * 1024;

type GitignoreMatcherCacheState = "ready" | "absent" | "error";

type GitignoreMatcherCacheEntry = {
    state: GitignoreMatcherCacheState;
    mtimeMs: number | null;
    size: number | null;
    matcher: ReturnType<typeof ignore> | null;
    checksSinceReload: number;
};

type TrackedLexicalSearchDebug = {
    enabled: boolean;
    trackedPathCount: number;
    filesConsidered: number;
    filesScanned: number;
    bytesRead: number;
    cappedByFiles: boolean;
    cappedByBytes: boolean;
    returnedResults: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInsideRoot(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function selectBoundedContractPaths(
    paths: Iterable<string>,
    normalize: (relativePath: string) => string | null,
    limit: number,
): string[] {
    const selected: string[] = [];
    for (const candidate of paths) {
        const normalized = normalize(candidate);
        if (!normalized || selected.includes(normalized)) {
            continue;
        }
        let insertionIndex = selected.findIndex((existing) => compareContractStrings(normalized, existing) < 0);
        if (insertionIndex < 0) {
            insertionIndex = selected.length;
        }
        if (insertionIndex >= limit) {
            continue;
        }
        selected.splice(insertionIndex, 0, normalized);
        if (selected.length > limit) {
            selected.pop();
        }
    }
    return selected;
}

export type SearchQuerySupportHost = {
    normalizeSearchPath(relativePath: string): string;
    hasPathSegment(normalizedPath: string, segment: string): boolean;
    isGeneratedPath(relativePath: string): boolean;
    isTestPath(relativePath: string): boolean;
    isFixturePath(relativePath: string): boolean;
    isDocPath(relativePath: string): boolean;
    getContextActiveIgnorePatterns(codebasePath: string): string[];
    getContextTrackedRelativePaths(codebasePath: string): string[];
    classifyPathCategory(relativePath: string): PathCategory;
    shouldIncludeCategoryInScope(scope: SearchScope, category: PathCategory): boolean;
    getSyncWatchDebounceMs(): number;
    capabilities: CapabilityResolver;
    runtimeFingerprint: IndexFingerprint;
    reranker: VoyageAIReranker | null;
    rootGitignoreMatcherCache: Map<string, GitignoreMatcherCacheEntry>;
    gitignoreForceReloadEveryN: number;
};

export class SearchQuerySupport {
    constructor(private readonly host: SearchQuerySupportHost) {}

    private normalizeSearchPath(relativePath: string): string {
        return this.host.normalizeSearchPath(relativePath);
    }

    private hasPathSegment(normalizedPath: string, segment: string): boolean {
        return this.host.hasPathSegment(normalizedPath, segment);
    }

    private isGeneratedPath(relativePath: string): boolean {
        return this.host.isGeneratedPath(relativePath);
    }

    private isTestPath(relativePath: string): boolean {
        return this.host.isTestPath(relativePath);
    }

    private isFixturePath(relativePath: string): boolean {
        return this.host.isFixturePath(relativePath);
    }

    private isDocPath(relativePath: string): boolean {
        return this.host.isDocPath(relativePath);
    }

    private getContextActiveIgnorePatterns(codebasePath: string): string[] {
        return this.host.getContextActiveIgnorePatterns(codebasePath);
    }

    private getContextTrackedRelativePaths(codebasePath: string): string[] {
        return this.host.getContextTrackedRelativePaths(codebasePath);
    }

    private classifyPathCategory(relativePath: string): PathCategory {
        return this.host.classifyPathCategory(relativePath);
    }

    private shouldIncludeCategoryInScope(scope: SearchScope, category: PathCategory): boolean {
        return this.host.shouldIncludeCategoryInScope(scope, category);
    }

    private getSyncWatchDebounceMs(): number {
        return this.host.getSyncWatchDebounceMs();
    }

    private get capabilities(): CapabilityResolver {
        return this.host.capabilities;
    }

    private get runtimeFingerprint(): IndexFingerprint {
        return this.host.runtimeFingerprint;
    }

    private get reranker(): VoyageAIReranker | null {
        return this.host.reranker;
    }

    private get rootGitignoreMatcherCache(): Map<string, GitignoreMatcherCacheEntry> {
        return this.host.rootGitignoreMatcherCache;
    }

    private get gitignoreForceReloadEveryN(): number {
        return this.host.gitignoreForceReloadEveryN;
    }

    public classifyNoiseCategory(relativePath: string): SearchNoiseCategory {
        const normalized = this.normalizeSearchPath(relativePath);

        // Deterministic precedence: generated > tests > fixtures > docs > runtime.
        if (this.isGeneratedPath(normalized)
            || this.hasPathSegment(normalized, 'coverage')
            || this.hasPathSegment(normalized, 'dist')
            || this.hasPathSegment(normalized, 'build')
            || this.hasPathSegment(normalized, '.output')) return 'generated';
        if (this.isTestPath(normalized)) return 'tests';
        if (this.isFixturePath(normalized)) return 'fixtures';
        if (this.isDocPath(normalized)) return 'docs';
        return 'runtime';
    }
    private roundRatio(value: number): number {
        return Math.round(value * 100) / 100;
    }
    public normalizeRelativePathForIgnoreCheck(relativePath: string): string | null {
        if (typeof relativePath !== 'string') {
            return null;
        }
        const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
        if (normalized.length === 0 || normalized === '.') {
            return null;
        }
        if (
            normalized.startsWith('..')
            || normalized.includes('/../')
            || path.posix.isAbsolute(normalized)
            || path.win32.isAbsolute(normalized)
        ) {
            return null;
        }
        return normalized;
    }
    public isExactSearchPathFilter(pattern: string): boolean {
        return !/[!*?[\]{}]/.test(pattern) && !pattern.endsWith('/');
    }
    private buildActiveIgnoreMatcher(codebaseRoot: string): ((relativePath: string) => boolean) | undefined {
        const patterns = this.getContextActiveIgnorePatterns(codebaseRoot);
        if (!Array.isArray(patterns) || patterns.length === 0) {
            return undefined;
        }

        try {
            const matcher = ignore();
            matcher.add(patterns.filter((pattern: unknown) => typeof pattern === 'string'));
            return (relativePath: string) => {
                const normalized = this.normalizeRelativePathForIgnoreCheck(relativePath);
                if (!normalized) {
                    return true;
                }
                if (matcher.ignores(normalized)) {
                    return true;
                }
                const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;
                return matcher.ignores(withSlash);
            };
        } catch {
            return () => true;
        }
    }
    public async buildLivePathScopedSearchResults(input: {
        effectiveRoot: string;
        parsedOperators: ParsedSearchOperators;
        queryPlan: SearchQueryPlan;
        changedFiles: Set<string>;
    }): Promise<SearchResultLike[]> {
        if (input.parsedOperators.path.length === 0 || input.changedFiles.size === 0) {
            return [];
        }

        const activeIgnoreMatcher = this.buildActiveIgnoreMatcher(input.effectiveRoot);
        const results: SearchResultLike[] = [];
        const seenPaths = new Set<string>();
        const lexicalTerms = input.queryPlan.lexicalTerms
            .map((term) => term.value.toLowerCase())
            .filter((term) => term.length > 0);

        for (const pattern of input.parsedOperators.path) {
            if (results.length >= SEARCH_LIVE_PATH_SUPPLEMENT_MAX_RESULTS || seenPaths.size >= SEARCH_LIVE_PATH_SUPPLEMENT_MAX_FILES) {
                break;
            }

            const normalized = this.normalizeRelativePathForIgnoreCheck(pattern);
            if (!normalized || !this.isExactSearchPathFilter(normalized) || seenPaths.has(normalized)) {
                continue;
            }
            seenPaths.add(normalized);

            if (!input.changedFiles.has(normalized)) {
                continue;
            }
            if (!isLanguageCapabilitySupportedForFilename(normalized, 'search')) {
                continue;
            }
            if (activeIgnoreMatcher?.(normalized)) {
                continue;
            }

            const absolutePath = path.resolve(input.effectiveRoot, normalized);
            const rootPrefix = `${path.resolve(input.effectiveRoot)}${path.sep}`;
            if (!absolutePath.startsWith(rootPrefix)) {
                continue;
            }

            let handle: Awaited<ReturnType<typeof openRegularFileInsideRoot>> | undefined;
            let stat: fs.Stats;
            let content: string;
            try {
                handle = await openRegularFileInsideRoot(absolutePath, input.effectiveRoot);
                stat = await handle.stat();
                if (!stat.isFile() || stat.size > SEARCH_LIVE_PATH_SUPPLEMENT_MAX_BYTES) {
                    continue;
                }
                content = await handle.readFile('utf8');
            } catch {
                continue;
            } finally {
                await handle?.close().catch(() => undefined);
            }

            const lowerContent = content.toLowerCase();
            if (lexicalTerms.length > 0 && !lexicalTerms.some((term) => lowerContent.includes(term))) {
                continue;
            }

            const lines = content.split(/\r?\n/);
            const matchingLineIndex = lexicalTerms.length > 0
                ? this.findBestLivePathLexicalLineIndex(lines, input.queryPlan.lexicalTerms)
                : 0;
            const anchorLineIndex = matchingLineIndex >= 0 ? matchingLineIndex : 0;
            const startLine = Math.max(1, anchorLineIndex + 1 - SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES);
            const endLine = Math.min(lines.length, anchorLineIndex + 1 + SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES);
            const windowContent = lines.slice(startLine - 1, endLine).join('\n');

            results.push({
                content: windowContent,
                relativePath: normalized,
                startLine,
                endLine,
                language: getLanguageIdFromFilename(normalized, 'text'),
                score: 1,
                backendScore: 1,
                backendScoreKind: 'lexical_rank',
            });
        }

        return results;
    }
    public async buildDirtyFileSearchResults(input: {
        effectiveRoot: string;
        queryPlan: SearchQueryPlan;
        changedFiles: Set<string>;
    }): Promise<SearchResultLike[]> {
        if (input.changedFiles.size === 0 || input.queryPlan.lexicalTerms.length === 0) {
            return [];
        }

        let canonicalRoot: string;
        try {
            canonicalRoot = fs.realpathSync(input.effectiveRoot);
        } catch {
            return [];
        }
        const activeIgnoreMatcher = this.buildActiveIgnoreMatcher(input.effectiveRoot);
        const analyzer = createLanguageAnalysisService({
            chunkSize: SEARCH_DIRTY_OVERLAY_MAX_BYTES + 1,
            chunkOverlap: 0,
        });
        const results: SearchResultLike[] = [];
        const seen = new Set<string>();
        let bytesRead = 0;

        const changedPaths = selectBoundedContractPaths(
            input.changedFiles,
            (relativePath) => this.normalizeRelativePathForIgnoreCheck(relativePath),
            SEARCH_DIRTY_OVERLAY_MAX_FILES,
        );
        for (const relativePath of changedPaths) {
            if (
                bytesRead >= SEARCH_DIRTY_OVERLAY_TOTAL_BYTES
                || results.length >= SEARCH_DIRTY_OVERLAY_MAX_RESULTS
            ) {
                break;
            }
            if (!isLanguageCapabilitySupportedForFilename(relativePath, "search") || activeIgnoreMatcher?.(relativePath)) {
                continue;
            }
            const logicalPath = path.resolve(canonicalRoot, relativePath);
            if (!isPathInsideRoot(logicalPath, canonicalRoot)) {
                continue;
            }

            let handle: Awaited<ReturnType<typeof openRegularFileInsideRoot>> | undefined;
            let stat: fs.Stats;
            let content: string;
            try {
                handle = await openRegularFileInsideRoot(logicalPath, canonicalRoot);
                stat = await handle.stat();
                if (!stat.isFile() || stat.size > SEARCH_DIRTY_OVERLAY_MAX_BYTES || bytesRead + stat.size > SEARCH_DIRTY_OVERLAY_TOTAL_BYTES) {
                    continue;
                }
                content = await handle.readFile("utf8");
            } catch {
                continue;
            } finally {
                await handle?.close().catch(() => undefined);
            }
            bytesRead += stat.size;
            const language = getLanguageIdFromFilename(relativePath, "text");
            let chunks: Awaited<ReturnType<typeof analyzer.analyze>>["chunks"] = [];
            try {
                chunks = (await analyzer.analyze({ content, language, relativePath })).chunks;
            } catch {
                chunks = [];
            }

            for (const chunk of chunks) {
                if (results.length >= SEARCH_DIRTY_OVERLAY_MAX_RESULTS) {
                    break;
                }
                const candidate: SearchResultLike = {
                    content: chunk.content,
                    relativePath,
                    startLine: chunk.metadata.startLine,
                    endLine: chunk.metadata.endLine,
                    language,
                    ...(chunk.metadata.symbolLabel ? { symbolLabel: chunk.metadata.symbolLabel } : {}),
                    score: 1,
                    backendScore: 1,
                    backendScoreKind: "lexical_rank",
                };
                if (this.scoreCandidateLexicalEvidence(input.queryPlan, candidate).score <= 0) {
                    continue;
                }
                const key = `${relativePath}:${candidate.startLine}:${candidate.endLine}:${candidate.symbolLabel || ""}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                results.push(candidate);
            }

            if (results.some((result) => result.relativePath === relativePath)) {
                continue;
            }
            const exactWindow = this.findExactTrackedLexicalWindowMatch(relativePath, content, input.queryPlan);
            if (exactWindow) {
                results.push({
                    content: exactWindow.windowContent,
                    relativePath,
                    startLine: exactWindow.startLine,
                    endLine: exactWindow.endLine,
                    language,
                    score: 1,
                    backendScore: 1,
                    backendScoreKind: "lexical_rank",
                });
                continue;
            }
            const lines = content.split(/\r?\n/);
            const lineIndex = this.findBestLivePathLexicalLineIndex(lines, input.queryPlan.lexicalTerms);
            if (lineIndex < 0) {
                continue;
            }
            const startLine = Math.max(1, lineIndex + 1 - SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES);
            const endLine = Math.min(lines.length, lineIndex + 1 + SEARCH_LIVE_PATH_SUPPLEMENT_CONTEXT_LINES);
            results.push({
                content: lines.slice(startLine - 1, endLine).join("\n"),
                relativePath,
                startLine,
                endLine,
                language,
                score: 1,
                backendScore: 1,
                backendScoreKind: "lexical_rank",
            });
        }

        return results;
    }
    private shouldRunTrackedLexicalSearch(input: {
        parsedOperators: ParsedSearchOperators;
        queryPlan: SearchQueryPlan;
        exactRegistryFallback: boolean;
    }): boolean {
        if (input.queryPlan.lexicalTerms.length === 0 && input.queryPlan.quotedLiteralPhrases.length === 0) {
            return false;
        }
        if (input.exactRegistryFallback) {
            return true;
        }
        if (input.parsedOperators.path.some((pattern) => {
            const normalized = this.normalizeRelativePathForIgnoreCheck(pattern);
            return Boolean(normalized && this.isExactSearchPathFilter(normalized));
        })) {
            return true;
        }
        if (input.queryPlan.quotedLiteralPhrases.length > 0) {
            return true;
        }
        const semanticQuery = input.queryPlan.semanticQuery.trim();
        if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/.test(semanticQuery)) {
            return true;
        }
        return /\b[A-Z][A-Z0-9_]*(?:WARNING|ERROR|CODE|STATUS|REASON)[A-Z0-9_]*\b/.test(semanticQuery);
    }
    private shouldUseExactTrackedLexicalLineFastPath(queryPlan: SearchQueryPlan): boolean {
        return queryPlan.quotedLiteralPhrases.length > 0
            || queryPlan.intent === 'identifier'
            || queryPlan.exactMatchPinningEnabled;
    }
    private isStrongTrackedLexicalWholeTerm(term: string): boolean {
        return /[0-9_./\\:-]/.test(term);
    }
    private findExactTrackedLexicalWindowMatch(
        relativePath: string,
        content: string,
        queryPlan: SearchQueryPlan,
    ): {
        startLine: number;
        endLine: number;
        windowContent: string;
        lineEvidence: SearchLexicalEvidence;
    } | null {
        if (!this.shouldUseExactTrackedLexicalLineFastPath(queryPlan)) {
            return null;
        }

        const quotedPhrases = queryPlan.quotedLiteralPhrases
            .map((phrase) => phrase.toLowerCase())
            .filter((phrase) => phrase.length > 0);
        const wholeTerms = queryPlan.lexicalTerms
            .filter((term) => term.kind === 'whole')
            .map((term) => term.value.toLowerCase())
            .filter((term) => queryPlan.intent === 'identifier' || this.isStrongTrackedLexicalWholeTerm(term))
            .filter((term) => term.length > 0);
        if (quotedPhrases.length === 0 && wholeTerms.length === 0) {
            return null;
        }

        const recentLineStarts: number[] = [];
        let lineStart = 0;
        let lineIndex = 0;
        while (lineStart <= content.length) {
            recentLineStarts.push(lineStart);
            const newlineIndex = content.indexOf('\n', lineStart);
            const lineEndExclusive = newlineIndex === -1
                ? content.length
                : (
                    newlineIndex > lineStart && content.charCodeAt(newlineIndex - 1) === 13
                        ? newlineIndex - 1
                        : newlineIndex
                );
            const nextLineStart = newlineIndex === -1 ? content.length + 1 : newlineIndex + 1;
            const line = content.slice(lineStart, lineEndExclusive);
            const lowerLine = line.toLowerCase();
            const hasQuotedPhraseMatch = quotedPhrases.some((phrase) => lowerLine.includes(phrase));
            const hasWholeTermMatch = wholeTerms.some((term) => this.hasTokenBoundaryMatch(lowerLine, term));
            if (!hasQuotedPhraseMatch && !hasWholeTermMatch) {
                if (newlineIndex === -1) {
                    break;
                }
                lineStart = nextLineStart;
                lineIndex += 1;
                continue;
            }

            const evidence = this.scoreCandidateLexicalEvidence(queryPlan, {
                relativePath,
                content: line,
                symbolLabel: '',
            });
            if (evidence.score > 0) {
                const startLineIndex = Math.max(0, lineIndex - SEARCH_TRACKED_LEXICAL_CONTEXT_LINES);
                const windowStartOffset = recentLineStarts[startLineIndex] ?? 0;
                let endLineIndex = lineIndex;
                let windowEndExclusive = lineEndExclusive;
                let forwardLineStart = nextLineStart;
                while (
                    endLineIndex - lineIndex < SEARCH_TRACKED_LEXICAL_CONTEXT_LINES
                    && forwardLineStart <= content.length
                    && forwardLineStart < content.length
                ) {
                    const forwardNewlineIndex = content.indexOf('\n', forwardLineStart);
                    const forwardLineEndExclusive = forwardNewlineIndex === -1
                        ? content.length
                        : (
                            forwardNewlineIndex > forwardLineStart && content.charCodeAt(forwardNewlineIndex - 1) === 13
                                ? forwardNewlineIndex - 1
                                : forwardNewlineIndex
                        );
                    windowEndExclusive = forwardLineEndExclusive;
                    endLineIndex += 1;
                    if (forwardNewlineIndex === -1) {
                        break;
                    }
                    forwardLineStart = forwardNewlineIndex + 1;
                }
                return {
                    startLine: startLineIndex + 1,
                    endLine: endLineIndex + 1,
                    windowContent: content.slice(windowStartOffset, windowEndExclusive),
                    lineEvidence: evidence,
                };
            }

            if (newlineIndex === -1) {
                break;
            }
            lineStart = nextLineStart;
            lineIndex += 1;
        }

        return null;
    }
    public async buildTrackedLexicalSearchResults(input: {
        effectiveRoot: string;
        parsedOperators: ParsedSearchOperators;
        queryPlan: SearchQueryPlan;
        scope: SearchScope;
        limit: number;
        exactRegistryFallback: boolean;
    }): Promise<{ results: SearchResultLike[]; debug: TrackedLexicalSearchDebug }> {
        const disabledDebug = (): TrackedLexicalSearchDebug => ({
            enabled: false,
            trackedPathCount: 0,
            filesConsidered: 0,
            filesScanned: 0,
            bytesRead: 0,
            cappedByFiles: false,
            cappedByBytes: false,
            returnedResults: 0,
        });
        if (!this.shouldRunTrackedLexicalSearch(input)) {
            return { results: [], debug: disabledDebug() };
        }

        const trackedRelativePaths = this.getContextTrackedRelativePaths(input.effectiveRoot);
        if (!Array.isArray(trackedRelativePaths) || trackedRelativePaths.length === 0) {
            return { results: [], debug: disabledDebug() };
        }
        const activeIgnoreMatcher = this.buildActiveIgnoreMatcher(input.effectiveRoot);
        const debug: TrackedLexicalSearchDebug = {
            enabled: true,
            trackedPathCount: trackedRelativePaths.length,
            filesConsidered: 0,
            filesScanned: 0,
            bytesRead: 0,
            cappedByFiles: false,
            cappedByBytes: false,
            returnedResults: 0,
        };

        const normalizedExactPathFilters = new Set(
            input.parsedOperators.path
                .map((pattern) => this.normalizeRelativePathForIgnoreCheck(pattern))
                .filter((pattern): pattern is string => Boolean(pattern && this.isExactSearchPathFilter(pattern)))
        );
        const lexicalTerms = input.queryPlan.lexicalTerms
            .map((term) => term.value.toLowerCase())
            .filter((term) => term.length > 0);
        const normalizedPaths = trackedRelativePaths
            .map((relativePath) => this.normalizeRelativePathForIgnoreCheck(relativePath))
            .filter((relativePath): relativePath is string => Boolean(relativePath));
        const uniquePaths = Array.from(new Set(normalizedPaths));
        uniquePaths.sort((a, b) => {
            const aExact = normalizedExactPathFilters.has(a) ? 1 : 0;
            const bExact = normalizedExactPathFilters.has(b) ? 1 : 0;
            if (aExact !== bExact) {
                return bExact - aExact;
            }
            const aPathMatch = lexicalTerms.some((term) => a.toLowerCase().includes(term)) ? 1 : 0;
            const bPathMatch = lexicalTerms.some((term) => b.toLowerCase().includes(term)) ? 1 : 0;
            if (aPathMatch !== bPathMatch) {
                return bPathMatch - aPathMatch;
            }
            return a.localeCompare(b);
        });

        const candidates: Array<{
            relativePath: string;
            score: number;
            exactLexicalMatch: boolean;
            startLine: number;
            endLine: number;
            content: string;
            language: string;
        }> = [];
        let bytesRead = 0;
        let filesScanned = 0;

        for (const relativePath of uniquePaths) {
            if (filesScanned >= SEARCH_TRACKED_LEXICAL_MAX_FILES) {
                debug.cappedByFiles = true;
                break;
            }
            if (bytesRead >= SEARCH_TRACKED_LEXICAL_TOTAL_BYTES) {
                debug.cappedByBytes = true;
                break;
            }
            debug.filesConsidered += 1;
            if (!isLanguageCapabilitySupportedForFilename(relativePath, 'search')) {
                continue;
            }
            if (!this.shouldIncludeCategoryInScope(input.scope, this.classifyPathCategory(relativePath))) {
                continue;
            }
            if (input.parsedOperators.lang.length > 0) {
                const languageValue = getLanguageIdFromFilename(relativePath, 'text').toLowerCase();
                if (!input.parsedOperators.lang.includes(languageValue)) {
                    continue;
                }
            }
            if (input.parsedOperators.path.length > 0 && !this.pathMatchesAnyPattern(relativePath, input.parsedOperators.path)) {
                continue;
            }
            if (input.parsedOperators.excludePath.length > 0 && this.pathMatchesAnyPattern(relativePath, input.parsedOperators.excludePath)) {
                continue;
            }
            if (activeIgnoreMatcher?.(relativePath)) {
                continue;
            }

            const absolutePath = path.resolve(input.effectiveRoot, relativePath);
            const rootPrefix = `${path.resolve(input.effectiveRoot)}${path.sep}`;
            if (!absolutePath.startsWith(rootPrefix)) {
                continue;
            }

            let handle: Awaited<ReturnType<typeof openRegularFileInsideRoot>> | undefined;
            let stat: fs.Stats;
            let content: string;
            try {
                handle = await openRegularFileInsideRoot(absolutePath, input.effectiveRoot);
                stat = await handle.stat();
                if (!stat.isFile() || stat.size > SEARCH_TRACKED_LEXICAL_MAX_BYTES || bytesRead + stat.size > SEARCH_TRACKED_LEXICAL_TOTAL_BYTES) {
                    if (bytesRead + stat.size > SEARCH_TRACKED_LEXICAL_TOTAL_BYTES) {
                        debug.cappedByBytes = true;
                    }
                    continue;
                }
                content = await handle.readFile('utf8');
            } catch {
                continue;
            } finally {
                await handle?.close().catch(() => undefined);
            }
            filesScanned += 1;
            bytesRead += stat.size;
            debug.filesScanned = filesScanned;
            debug.bytesRead = bytesRead;

            const lowerContent = content.toLowerCase();
            const quickMatch = lexicalTerms.length === 0
                || lexicalTerms.some((term) => lowerContent.includes(term) || relativePath.toLowerCase().includes(term));
            if (!quickMatch) {
                continue;
            }

            const exactWindowMatch = this.findExactTrackedLexicalWindowMatch(relativePath, content, input.queryPlan);
            if (exactWindowMatch) {
                const windowEvidence = this.scoreCandidateLexicalEvidence(input.queryPlan, {
                    relativePath,
                    content: exactWindowMatch.windowContent,
                    symbolLabel: '',
                });

                candidates.push({
                    relativePath,
                    score: windowEvidence.score > 0 ? windowEvidence.score : exactWindowMatch.lineEvidence.score,
                    exactLexicalMatch: windowEvidence.exactLexicalMatch || exactWindowMatch.lineEvidence.exactLexicalMatch,
                    startLine: exactWindowMatch.startLine,
                    endLine: exactWindowMatch.endLine,
                    content: exactWindowMatch.windowContent,
                    language: getLanguageIdFromFilename(relativePath, 'text'),
                });
                continue;
            }

            const lines = content.split(/\r?\n/);
            let bestLineIndex = -1;
            let bestScore = 0;
            let bestExactLexicalMatch = false;
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                const evidence = this.scoreCandidateLexicalEvidence(input.queryPlan, {
                    relativePath,
                    content: lines[lineIndex],
                    symbolLabel: '',
                });
                if (
                    evidence.score > bestScore
                    || (evidence.score === bestScore && evidence.exactLexicalMatch && !bestExactLexicalMatch)
                ) {
                    bestScore = evidence.score;
                    bestExactLexicalMatch = evidence.exactLexicalMatch;
                    bestLineIndex = lineIndex;
                }
            }

            if (bestScore <= 0) {
                continue;
            }

            const anchorLineIndex = bestLineIndex >= 0 ? bestLineIndex : 0;
            const startLine = Math.max(1, anchorLineIndex + 1 - SEARCH_TRACKED_LEXICAL_CONTEXT_LINES);
            const endLine = Math.min(lines.length, anchorLineIndex + 1 + SEARCH_TRACKED_LEXICAL_CONTEXT_LINES);
            const windowContent = lines.slice(startLine - 1, endLine).join('\n');
            const windowEvidence = this.scoreCandidateLexicalEvidence(input.queryPlan, {
                relativePath,
                content: windowContent,
                symbolLabel: '',
            });

            candidates.push({
                relativePath,
                score: windowEvidence.score > 0 ? windowEvidence.score : bestScore,
                exactLexicalMatch: windowEvidence.exactLexicalMatch || bestExactLexicalMatch,
                startLine,
                endLine,
                content: windowContent,
                language: getLanguageIdFromFilename(relativePath, 'text'),
            });
        }

        candidates.sort((a, b) => {
            if (a.exactLexicalMatch !== b.exactLexicalMatch) {
                return a.exactLexicalMatch ? -1 : 1;
            }
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            const fileCmp = a.relativePath.localeCompare(b.relativePath);
            if (fileCmp !== 0) {
                return fileCmp;
            }
            return a.startLine - b.startLine;
        });

        const results = candidates.slice(0, Math.min(input.limit, SEARCH_TRACKED_LEXICAL_MAX_RESULTS)).map((candidate) => ({
            content: candidate.content,
            relativePath: candidate.relativePath,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            language: candidate.language,
            score: candidate.score,
            backendScore: candidate.score,
            backendScoreKind: 'lexical_rank' as const,
        }));
        debug.returnedResults = results.length;
        return { results, debug };
    }
    private findBestLivePathLexicalLineIndex(lines: string[], lexicalTerms: SearchLexicalTerm[]): number {
        const orderedTerms = [
            ...lexicalTerms.filter((term) => term.kind === 'whole'),
            ...lexicalTerms.filter((term) => term.kind !== 'whole'),
        ].map((term) => term.value.toLowerCase()).filter((term) => term.length > 0);

        for (const term of orderedTerms) {
            const lineIndex = lines.findIndex((line) => line.toLowerCase().includes(term));
            if (lineIndex >= 0) {
                return lineIndex;
            }
        }

        return -1;
    }
    private trimTrailingSeparators(inputPath: string): string {
        const parsedRoot = path.parse(inputPath).root;
        if (inputPath === parsedRoot) {
            return inputPath;
        }
        return inputPath.replace(/[\\/]+$/, '');
    }
    public canonicalizeCodebasePath(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        try {
            const realPath = typeof fs.realpathSync.native === 'function'
                ? fs.realpathSync.native(resolved)
                : fs.realpathSync(resolved);
            return this.trimTrailingSeparators(path.normalize(realPath));
        } catch {
            return this.trimTrailingSeparators(path.normalize(resolved));
        }
    }
    private loadRootGitignoreMatcher(codebaseRoot: string): GitignoreMatcherCacheEntry {
        const cacheKey = this.canonicalizeCodebasePath(codebaseRoot);
        const gitignorePath = path.join(cacheKey, '.gitignore');
        const existingFromCache = this.rootGitignoreMatcherCache.get(cacheKey);
        const existing = existingFromCache || {
            state: "absent" as GitignoreMatcherCacheState,
            mtimeMs: null,
            size: null,
            matcher: null,
            checksSinceReload: 0,
        };
        const hasExistingEntry = !!existingFromCache;

        const nextChecks = existing.checksSinceReload + 1;
        const forceReload = nextChecks >= this.gitignoreForceReloadEveryN;

        if (!forceReload && existing.state === 'ready') {
            try {
                const stat = fs.statSync(gitignorePath);
                const mtimeMs = Math.trunc(stat.mtimeMs);
                const size = stat.size;
                if (stat.isFile() && existing.mtimeMs === mtimeMs && existing.size === size && existing.matcher) {
                    const retained = { ...existing, checksSinceReload: nextChecks };
                    this.rootGitignoreMatcherCache.set(cacheKey, retained);
                    return retained;
                }
            } catch {
                // Fall through to reload path.
            }
        }

        if (hasExistingEntry && !forceReload && (existing.state === 'absent' || existing.state === 'error')) {
            const retained = { ...existing, checksSinceReload: nextChecks };
            this.rootGitignoreMatcherCache.set(cacheKey, retained);
            return retained;
        }

        try {
            const stat = fs.statSync(gitignorePath);
            if (!stat.isFile()) {
                const absent = {
                    state: "absent" as GitignoreMatcherCacheState,
                    mtimeMs: null,
                    size: null,
                    matcher: null,
                    checksSinceReload: 0,
                };
                this.rootGitignoreMatcherCache.set(cacheKey, absent);
                return absent;
            }

            const mtimeMs = Math.trunc(stat.mtimeMs);
            const size = stat.size;
            const contents = fs.readFileSync(gitignorePath, 'utf8');
            const matcher = ignore();
            matcher.add(contents);

            const ready = {
                state: "ready" as GitignoreMatcherCacheState,
                mtimeMs,
                size,
                matcher,
                checksSinceReload: 0,
            };
            this.rootGitignoreMatcherCache.set(cacheKey, ready);
            return ready;
        } catch (error: unknown) {
            const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                const absent = {
                    state: "absent" as GitignoreMatcherCacheState,
                    mtimeMs: null,
                    size: null,
                    matcher: null,
                    checksSinceReload: 0,
                };
                this.rootGitignoreMatcherCache.set(cacheKey, absent);
                return absent;
            }
            const failed = {
                state: "error" as GitignoreMatcherCacheState,
                mtimeMs: null,
                size: null,
                matcher: null,
                checksSinceReload: 0,
            };
            this.rootGitignoreMatcherCache.set(cacheKey, failed);
            return failed;
        }
    }
    private patternMatchesAnyPath(pattern: string, paths: string[]): boolean {
        if (!Array.isArray(paths) || paths.length === 0) {
            return false;
        }
        try {
            const matcher = ignore();
            matcher.add(pattern);
            return paths.some((filePath) => matcher.ignores(filePath));
        } catch {
            return false;
        }
    }
    private filterNoiseHintPatternsByRootGitignore(
        codebaseRoot: string,
        observedNoisyFiles: string[]
    ): {
        matcherState: GitignoreMatcherCacheState;
        suggestedIgnorePatterns: string[];
        coveredByRootGitignore: boolean;
    } {
        const normalizedObserved = Array.from(
            new Set(
                observedNoisyFiles
                    .map((filePath) => this.normalizeRelativePathForIgnoreCheck(filePath))
                    .filter((filePath): filePath is string => typeof filePath === 'string')
            )
        );

        const baseline = [...SEARCH_NOISE_HINT_PATTERNS];
        const cacheEntry = this.loadRootGitignoreMatcher(codebaseRoot);
        if (cacheEntry.state !== 'ready' || !cacheEntry.matcher) {
            return {
                matcherState: cacheEntry.state,
                suggestedIgnorePatterns: baseline,
                coveredByRootGitignore: false,
            };
        }

        const coveredByRootGitignore = normalizedObserved.some((filePath) => cacheEntry.matcher!.ignores(filePath));
        const noisyFilesNotIgnored = normalizedObserved.filter((filePath) => !cacheEntry.matcher!.ignores(filePath));
        const suggestedIgnorePatterns = SEARCH_NOISE_HINT_PATTERNS.filter((pattern) =>
            this.patternMatchesAnyPath(pattern, noisyFilesNotIgnored)
        );

        return {
            matcherState: cacheEntry.state,
            suggestedIgnorePatterns,
            coveredByRootGitignore,
        };
    }
    public buildNoiseMitigationHint(
        codebaseRoot: string,
        filesInOrder: string[],
        scope: SearchScope
    ): SearchNoiseMitigationHint | undefined {
        if (scope === 'docs') {
            return undefined;
        }
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
        const observedNoisyFiles: string[] = [];

        for (let i = 0; i < topK; i++) {
            const filePath = filesInOrder[i];
            const category = this.classifyNoiseCategory(filePath);
            counts[category] += 1;
            if (category !== 'runtime') {
                const normalized = this.normalizeRelativePathForIgnoreCheck(filePath);
                if (normalized) {
                    observedNoisyFiles.push(normalized);
                }
            }
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
        const debounceMs = this.getSyncWatchDebounceMs();
        const filtered = this.filterNoiseHintPatternsByRootGitignore(codebaseRoot, observedNoisyFiles);
        const isRootCoveredMessageEligible = filtered.matcherState === 'ready' && filtered.coveredByRootGitignore && filtered.suggestedIgnorePatterns.length === 0;
        const nextStepMiddle = filtered.suggestedIgnorePatterns.length > 0
            ? 'If you edit ignores, add only patterns not already ignored by root .gitignore (root-only check), then run manage_index with {"action":"sync","path":"<same path used in search_codebase>"} for immediate convergence.'
            : (isRootCoveredMessageEligible
                ? 'Top noisy files appear already covered by root .gitignore (root-only check); .satoriignore changes may be unnecessary. If you changed ignores, run manage_index with {"action":"sync","path":"<same path used in search_codebase>"} for immediate convergence.'
                : 'If you edit ignores, run manage_index with {"action":"sync","path":"<same path used in search_codebase>"} for immediate convergence.');
        const nextStep = `Use scope="runtime" to reduce noise. ${nextStepMiddle} Reindex is only required when you see requires_reindex (fingerprint mismatch).`;

        return {
            reason: 'top_results_noise_dominant',
            topK,
            ratios,
            recommendedScope: 'runtime',
            suggestedIgnorePatterns: [...filtered.suggestedIgnorePatterns],
            debounceMs,
            nextStep,
        };
    }
    public parseSearchOperators(query: string): ParsedSearchOperators {
        return parseSearchOperatorsFromText(query);
    }
    public buildSearchQueryPlan(semanticQuery: string): SearchQueryPlan {
        return buildSearchQueryPlanFromText(
            semanticQuery,
            this.runtimeFingerprint.schemaVersion.startsWith("hybrid")
        );
    }
    public hasTokenBoundaryMatch(field: string, term: string): boolean {
        return hasSearchTokenBoundaryMatch(field, term);
    }
    public scoreCandidateLexicalEvidence(plan: SearchQueryPlan, result: SearchResultLike): SearchLexicalEvidence {
        return scoreSearchCandidateLexicalEvidence(plan, result);
    }
    public pathMatchesAnyPattern(relativePath: string, patterns: string[]): boolean {
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
    private buildSearchPathMatcher(patterns: string[]): (relativePath: string) => boolean {
        if (patterns.length === 0) {
            return () => false;
        }
        const matchers: Array<ReturnType<typeof ignore>> = [];
        for (const pattern of patterns) {
            try {
                const matcher = ignore();
                matcher.add(pattern);
                matchers.push(matcher);
            } catch {
                continue;
            }
        }
        if (matchers.length === 0) {
            return () => false;
        }
        return (relativePath: string): boolean => {
            const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
            return matchers.some((matcher) => matcher.ignores(normalizedPath));
        };
    }
    public tokenMatchesAnyField(token: string, fields: string[]): boolean {
        for (const field of fields) {
            if (field.includes(token)) {
                return true;
            }
        }
        return false;
    }
    public resolveRerankDecision(scope: SearchScope, plan: SearchQueryPlan): {
        enabledByPolicy: boolean;
        skippedByScopeDocs: boolean;
        skippedByIdentifierIntent: boolean;
        capabilityPresent: boolean;
        rerankerPresent: boolean;
        enabled: boolean;
        exactMatchPinningEnabled: boolean;
    } {
        const capabilityPresent = this.capabilities.hasReranker();
        const enabledByPolicy = capabilityPresent && this.capabilities.getDefaultRerankEnabled();
        const rerankerPresent = this.reranker !== null;
        const skippedByScopeDocs = scope === 'docs';
        const skippedByIdentifierIntent = !plan.rerankAllowed;
        return {
            enabledByPolicy,
            skippedByScopeDocs,
            skippedByIdentifierIntent,
            capabilityPresent,
            rerankerPresent,
            enabled: enabledByPolicy && rerankerPresent && !skippedByScopeDocs && !skippedByIdentifierIntent,
            exactMatchPinningEnabled: plan.exactMatchPinningEnabled,
        };
    }
    public buildExactRegistrySymbolFilter(input: {
        scope: SearchScope;
        parsedOperators: ParsedSearchOperators;
    }): (symbol: SymbolRecord) => boolean {
        const includePathMatcher = this.buildSearchPathMatcher(input.parsedOperators.path);
        const excludePathMatcher = this.buildSearchPathMatcher(input.parsedOperators.excludePath);
        return (symbol: SymbolRecord): boolean => {
            const relativePath = this.normalizeRelativePathForIgnoreCheck(symbol.file);
            if (!relativePath) {
                return false;
            }
            const category = this.classifyPathCategory(relativePath);
            if (!this.shouldIncludeCategoryInScope(input.scope, category)) {
                return false;
            }
            const languageValue = symbol.language.toLowerCase();
            if (input.parsedOperators.lang.length > 0 && !input.parsedOperators.lang.includes(languageValue)) {
                return false;
            }
            if (input.parsedOperators.path.length > 0 && !includePathMatcher(relativePath)) {
                return false;
            }
            if (input.parsedOperators.excludePath.length > 0 && excludePathMatcher(relativePath)) {
                return false;
            }
            const fields = [
                symbol.label,
                relativePath,
                symbol.name,
                symbol.qualifiedName,
                ...symbol.parentQualifiedNamePath,
            ];
            if (!input.parsedOperators.must.every((token) => this.tokenMatchesAnyField(token, fields))) {
                return false;
            }
            return !input.parsedOperators.exclude.some((token) => this.tokenMatchesAnyField(token, fields));
        };
    }
    public buildUnavailableExactRegistryDebug(reason: string): ExactRegistryLookupDebug {
        return {
            attempted: true,
            status: 'miss',
            reason: 'registry_unavailable',
            inspectedSymbolCount: 0,
            filteredSymbolCount: 0,
            registryUnavailableReason: reason,
        };
    }
    public buildRerankDocument(result: SearchResultLike): string {
        const relativePath = typeof result?.relativePath === 'string' ? result.relativePath : '';
        const language = typeof result?.language === 'string' ? result.language : 'unknown';
        const symbolLabel = typeof result?.symbolLabel === 'string' ? result.symbolLabel : '';
        const content = typeof result?.content === 'string' ? result.content : '';
        const contentLines = content.split(/\r?\n/).slice(0, SEARCH_RERANK_DOC_MAX_LINES);
        let normalizedContent = contentLines.join('\n');
        if (normalizedContent.length > SEARCH_RERANK_DOC_MAX_CHARS) {
            normalizedContent = normalizedContent.slice(0, SEARCH_RERANK_DOC_MAX_CHARS);
        }
        return `${relativePath}\n${language}\n${symbolLabel}\n${normalizedContent}`;
    }
    public buildOperatorSummary(operators: ParsedSearchOperators): SearchOperatorSummary {
        return {
            prefixBlockChars: operators.prefixBlockChars,
            lang: [...operators.lang],
            path: [...operators.path],
            excludePath: [...operators.excludePath],
            must: [...operators.must],
            exclude: [...operators.exclude],
        };
    }
}
