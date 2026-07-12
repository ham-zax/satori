import * as path from "path";
import { compareContractStrings } from "@zokizuan/satori-core";
import type { PythonSourceBackedSpanRepair } from "./python-call-fallback.js";
import type {
    CallGraphHint,
    SearchChunkResult,
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchGraphNavigationV2,
    SearchGroupResult,
    SearchNavigationUnavailableReasonV2,
    SearchRecommendedNextAction,
    SearchResponseEnvelope,
    SearchSpan,
    SearchWarningDetail,
} from "./search-types.js";
import { WARNING_CODES } from "./warnings.js";

const SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING = "SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE";

export function buildSearchPassWarning(passId: string): string {
    return `SEARCH_PASS_FAILED:${passId} - ${passId} semantic search pass failed; results may be degraded.`;
}

export function buildSearchWarningDetails(warnings: string[]): SearchWarningDetail[] {
    const byCode = new Map<string, SearchWarningDetail>();
    for (const warning of warnings) {
        const detail = buildSearchWarningDetail(warning);
        byCode.set(detail.code, detail);
    }
    return Array.from(byCode.values()).sort((a, b) => compareContractStrings(a.code, b.code));
}

function buildSearchWarningDetail(warning: string): SearchWarningDetail {
    const [rawCode, rawMessage] = warning.split(/\s+-\s+/, 2);
    const code = rawCode.trim();
    const fallbackMessage = rawMessage?.trim();

    if (code === "SEARCH_SPAN_START_BEFORE_DEF") {
        return {
            code,
            severity: "caution",
            blocksUse: false,
            message: "The stored Python symbol span started before the actual definition; Satori repaired the start from source.",
            action: "Use read_file(open_symbol) or file_outline exact output as the canonical span before relying on graph traversal.",
        };
    }
    if (code === "SEARCH_TRUNCATED_SYMBOL_SPAN") {
        return {
            code,
            severity: "caution",
            blocksUse: false,
            message: "The stored Python symbol span ended before the full body; Satori extended it from source.",
            action: "Prefer the repaired span for reads and treat older sidecar graph edges as suspect until reindexed.",
        };
    }
    if (code === "SEARCH_SYMBOL_SPAN_UNVERIFIED") {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "Source validation could not confirm the stored Python symbol span, so open-symbol precision is degraded.",
            action: "Verify with direct read_file line windows or file_outline before trusting call_graph results for this symbol.",
        };
    }
    if (code === WARNING_CODES.SEARCH_DIRTY_WORKTREE_NOT_SYNCED) {
        return {
            code,
            severity: "caution",
            blocksUse: false,
            message: "Index freshness was checked, but currently dirty or untracked files may have changed after the last sync and may not be represented.",
            action: "Run manage_index sync only if those dirty or untracked files are relevant to the query, then retry the search.",
        };
    }
    if (code === WARNING_CODES.SEARCH_DIRTY_FILE_EVIDENCE_UNAVAILABLE) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "A stale result from a dirty file was suppressed, but bounded current-source search could not replace it.",
            action: "Narrow the query and inspect the file with read_file, or run manage_index sync before relying on results for that file.",
        };
    }
    if (code === WARNING_CODES.SEARCH_CHANGED_FILES_BOOST_SKIPPED) {
        return {
            code,
            severity: "info",
            blocksUse: false,
            message: "Changed-file ranking boost was skipped because the dirty file set is too large for a precise boost.",
            action: "Narrow the query with path: or sync the repo if changed-file recency should affect ranking.",
        };
    }
    if (code === WARNING_CODES.FILTER_MUST_UNSATISFIED) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "The must: filter did not match any retained search result.",
            action: "Check the identifier spelling or remove must: to allow semantic discovery.",
        };
    }
    if (code === WARNING_CODES.RERANKER_FAILED) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "Reranking failed, so results use retrieval ranking only.",
            action: "Open the recommended result before trusting final ordering.",
        };
    }
    if (code.startsWith("SEARCH_PASS_FAILED:")) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: fallbackMessage || "A semantic retrieval pass failed; returned results may be incomplete.",
            action: "Use the recommended action for the best result, or retry with a narrower path:/must: query.",
        };
    }
    if (code.startsWith("SEARCH_RELATIONSHIP_SIDECAR_UNAVAILABLE:")) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "Relationship-backed call graph navigation is unavailable or incompatible for these search results.",
            action: "Open the symbol first; use lexical search or tests to verify inbound impact.",
        };
    }
    if (code === SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "Partial search data may exist, but deterministic navigation sidecars were not published.",
            action: "Use read_file spans for inspection; reindex only if the response asks for requires_reindex.",
        };
    }
    if (code === WARNING_CODES.SEARCH_INVALID_GROUP_TARGET_OMITTED) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "One or more grouped hits were omitted because their path, span, or score was not safe to publish.",
            action: "Use a narrower path: query or debug search evidence to inspect malformed backend metadata.",
        };
    }
    if (code.startsWith("SEARCH_PARTIAL_INDEX:")) {
        return {
            code,
            severity: "degraded",
            blocksUse: false,
            message: "The index was built from a partial indexing run; search results may be incomplete.",
            action: "Treat results as hints and verify with direct reads or tests before editing.",
        };
    }

    return {
        code,
        severity: "caution",
        blocksUse: false,
        message: fallbackMessage || "Search completed with a degraded condition.",
        action: "Inspect the result hints and verify with read_file before relying on this result.",
    };
}

export function buildSearchSpanWarningCodes(repair: PythonSourceBackedSpanRepair | undefined): string[] {
    if (!repair) {
        return [];
    }
    const warnings: string[] = [];
    if (repair.startBeforeDefinition) {
        warnings.push("SEARCH_SPAN_START_BEFORE_DEF");
    }
    if (repair.endTruncated) {
        warnings.push("SEARCH_TRUNCATED_SYMBOL_SPAN");
    }
    if (repair.attempted && !repair.validated) {
        warnings.push("SEARCH_SYMBOL_SPAN_UNVERIFIED");
    }
    return warnings;
}

export function buildOutlineSpanWarningCodes(repair: PythonSourceBackedSpanRepair | undefined): string[] {
    if (!repair) {
        return [];
    }
    const warnings: string[] = [];
    if (repair.startBeforeDefinition) {
        warnings.push("OUTLINE_SPAN_START_BEFORE_DEF");
    }
    if (repair.endTruncated) {
        warnings.push("OUTLINE_TRUNCATED_SYMBOL_SPAN");
    }
    if (repair.attempted && !repair.validated) {
        warnings.push("OUTLINE_SYMBOL_SPAN_UNVERIFIED");
    }
    return warnings;
}

export function buildSearchDebugSummary(
    debugHint: SearchDebugHint | undefined,
    freshnessSummary: SearchFreshnessSummary,
): NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["debugSummary"]> | undefined {
    if (!debugHint) {
        return undefined;
    }
    const passes = new Set(debugHint.passesUsed);
    const retrieval = passes.has("exact_registry")
        ? "exact_registry"
        : passes.has("live_path")
            ? "live_path"
            : passes.has("lexical_files")
                ? "tracked_lexical"
                : debugHint.rankingProvenance.semanticPassesUsed.join("+") || debugHint.retrieval.mode;
    const rerank = debugHint.rerank?.applied
        ? "applied"
        : debugHint.rerank?.skippedByExactPin
            ? "skipped_exact_pin"
            : debugHint.rerank?.skippedByIdentifierIntent
                ? "skipped_identifier_intent"
                : debugHint.rerank?.skippedByScopeDocs
                    ? "skipped_docs_scope"
                    : debugHint.rerank?.enabled === false
                        ? "skipped"
                        : "not_attempted";

    return {
        retrieval,
        freshness: freshnessSummary.syncMode,
        dirtyFiles: freshnessSummary.changedFileCount,
        rerank,
        ...(debugHint.changedCode?.truncated ? { changedCodeTruncated: true } : {}),
    };
}

/** Prefer plain preview reads when full symbol span would open a wall of code (L11/B2). */
export const OVERSIZED_SYMBOL_LINE_THRESHOLD = 200;
export const SEARCH_GROUP_PREVIEW_MAX_BYTES = 768;
export const SEARCH_DISPLAY_LABEL_MAX_BYTES = 160;
export const SEARCH_CALLER_TERM_MAX_BYTES = 96;
export const SEARCH_EVIDENCE_WINDOW_MAX_LINES = 40;

function symbolSpanLineCount(span: SearchSpan | undefined): number | null {
    if (!span || !Number.isFinite(span.startLine) || !Number.isFinite(span.endLine)) {
        return null;
    }
    return Math.max(0, Number(span.endLine) - Number(span.startLine) + 1);
}

function isOversizedSymbolSpan(span: SearchSpan | undefined): boolean {
    const lines = symbolSpanLineCount(span);
    return lines !== null && lines >= OVERSIZED_SYMBOL_LINE_THRESHOLD;
}

export function isValidSearchSpan(span: SearchSpan | undefined): span is SearchSpan {
    return Boolean(span)
        && Number.isSafeInteger(span?.startLine)
        && Number.isSafeInteger(span?.endLine)
        && Number(span?.startLine) > 0
        && Number(span?.endLine) >= Number(span?.startLine);
}

export function searchSpansEqual(left: SearchSpan, right: SearchSpan): boolean {
    return left.startLine === right.startLine && left.endLine === right.endLine;
}

export function searchSpanContains(container: SearchSpan, evidence: SearchSpan): boolean {
    return isValidSearchSpan(container)
        && isValidSearchSpan(evidence)
        && container.startLine <= evidence.startLine
        && evidence.endLine <= container.endLine;
}

export function boundSearchEvidenceSpan(span: SearchSpan): SearchSpan {
    return {
        startLine: span.startLine,
        endLine: Math.min(
            span.endLine,
            span.startLine + SEARCH_EVIDENCE_WINDOW_MAX_LINES - 1,
        ),
    };
}

export function roundSearchScore(score: number): number {
    return Number(score.toFixed(6));
}

function resolveSearchTargetAbsolutePath(
    codebaseRoot: string,
    relativeFile: string,
): string | undefined {
    if (
        !relativeFile
        || relativeFile.includes("\0")
        || path.isAbsolute(relativeFile)
        || path.win32.isAbsolute(relativeFile)
        || /^[A-Za-z]:/.test(relativeFile)
    ) {
        return undefined;
    }

    const normalizedFile = path.posix.normalize(relativeFile.replace(/\\/g, "/"));
    if (
        !normalizedFile
        || normalizedFile === ".."
        || normalizedFile.startsWith("../")
        || path.posix.isAbsolute(normalizedFile)
    ) {
        return undefined;
    }

    const resolvedRoot = path.resolve(codebaseRoot);
    const absolutePath = path.resolve(resolvedRoot, normalizedFile);
    const relativeToRoot = path.relative(resolvedRoot, absolutePath);
    if (
        relativeToRoot === ".."
        || relativeToRoot.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeToRoot)
    ) {
        return undefined;
    }
    return absolutePath;
}

export function buildSearchGroupRecommendedAction(
    codebaseRoot: string,
    result: SearchGroupResult,
    resultIndex?: number,
): SearchRecommendedNextAction | undefined {
    if (!isValidSearchSpan(result.target.span)) {
        return undefined;
    }
    if (
        result.target.symbolId !== undefined
        && (result.target.symbolId.trim().length === 0 || result.target.symbolId !== result.target.symbolId.trim())
    ) {
        return undefined;
    }
    const absolutePath = resolveSearchTargetAbsolutePath(codebaseRoot, result.target.file);
    if (!absolutePath) {
        return undefined;
    }

    if (isOversizedSymbolSpan(result.target.span) && result.evidenceSpan && isValidSearchSpan(result.evidenceSpan)) {
        return {
            ...(resultIndex !== undefined ? { resultIndex } : {}),
            tool: "read_file",
            args: {
                path: absolutePath,
                start_line: result.evidenceSpan.startLine,
                end_line: result.evidenceSpan.endLine,
            },
            reason: "The symbol is large; ground the result in its matched evidence span first.",
        };
    }

    if (typeof result.target.symbolId === "string" && result.target.symbolId.length > 0) {
        return {
            ...(resultIndex !== undefined ? { resultIndex } : {}),
            tool: "read_file",
            args: {
                path: absolutePath,
                open_symbol: { symbolId: result.target.symbolId },
            },
            reason: "Open the highest-ranked concrete symbol before graph traversal or editing.",
        };
    }

    return {
        ...(resultIndex !== undefined ? { resultIndex } : {}),
        tool: "read_file",
        args: {
            path: absolutePath,
            start_line: result.target.span.startLine,
            end_line: result.target.span.endLine,
        },
        reason: "Read the highest-ranked validated span before inferring symbol ownership.",
    };
}

export function buildTopRecommendedSearchAction(
    codebaseRoot: string,
    results: SearchGroupResult[],
): SearchRecommendedNextAction | undefined {
    const firstActionableIndex = results.findIndex(
        (result) => buildSearchGroupRecommendedAction(codebaseRoot, result) !== undefined,
    );
    if (firstActionableIndex < 0) {
        return undefined;
    }
    return buildSearchGroupRecommendedAction(codebaseRoot, results[firstActionableIndex], firstActionableIndex);
}

export function buildTopRecommendedRawSearchAction(
    codebaseRoot: string,
    results: SearchChunkResult[],
): SearchRecommendedNextAction | undefined {
    const first = results[0];
    if (!first) {
        return undefined;
    }
    const absolutePath = resolveSearchTargetAbsolutePath(codebaseRoot, first.file);
    if (!absolutePath || !isValidSearchSpan(first.span)) {
        return undefined;
    }
    return {
        resultIndex: 0,
        tool: "read_file",
        args: {
            path: absolutePath,
            start_line: first.span.startLine,
            end_line: first.span.endLine,
        },
        reason: "Open the top raw chunk before inferring ownership from ungrouped search results.",
    };
}

/**
 * Build a must: identifier query for notes-only inbound graph recovery (M7/C1).
 * Never feeds raw multi-token labels into must: (operator tokenizer is whitespace-based).
 */
export function buildInboundNotesOnlySearchQuery(input: {
    symbolLabel?: string;
    symbolId?: string;
    file?: string;
}): { query: string; pathFilterIncluded: boolean } {
    const identifier =
        extractIdentifierFromSymbolLabel(input.symbolLabel)
        || extractIdentifierFromSymbolLabel(input.symbolId);
    if (!identifier) {
        return { query: "", pathFilterIncluded: false };
    }
    const base = `must:${identifier} ${identifier}`;
    const file = input.file?.trim() ?? "";
    const isSafeRepoRelativePath =
        file.length > 0
        && !file.startsWith("/")
        && !file.includes("://")
        && !file.includes("..")
        && !/\s/.test(file);
    if (isSafeRepoRelativePath) {
        return { query: `${base} path:${file}`, pathFilterIncluded: true };
    }
    return { query: base, pathFilterIncluded: false };
}

export function extractIdentifierFromSymbolLabel(label: string | null | undefined): string | undefined {
    if (!label) {
        return undefined;
    }
    const kindMatch = label.match(/\b(?:(?:export|default|public|private|protected|static|readonly)\s+)*(?:async\s+)?(?:function|method|def|class|const|let|var|interface|type|symbol)\s+([A-Za-z_$][\w$]*)/);
    if (kindMatch) {
        return kindMatch[1];
    }
    const keywordLike = new Set([
        "export",
        "default",
        "public",
        "private",
        "protected",
        "static",
        "readonly",
        "async",
        "function",
        "method",
        "def",
        "class",
        "const",
        "let",
        "var",
        "interface",
        "type",
        "symbol",
    ]);
    const identifiers = label.match(/\b[A-Za-z_$][\w$]*\b/g) || [];
    return identifiers.find((identifier) => !keywordLike.has(identifier));
}

export function buildCallerSearchTerm(candidate: string | null | undefined): string | undefined {
    const normalized = candidate?.trim();
    if (!normalized || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) {
        return undefined;
    }
    return Buffer.byteLength(normalized, "utf8") <= SEARCH_CALLER_TERM_MAX_BYTES
        ? normalized
        : undefined;
}

export function buildSearchGraphNavigation(
    callGraphHint: CallGraphHint,
    callerCandidate?: string,
    unavailableReasonOverride?: SearchNavigationUnavailableReasonV2,
): SearchGraphNavigationV2 {
    if (unavailableReasonOverride) {
        return { graph: unavailableReasonOverride };
    }
    if (!callGraphHint.supported) {
        return { graph: callGraphHint.reason };
    }
    const callerSearchTerm = buildCallerSearchTerm(callerCandidate);
    return {
        graph: "ready",
        inbound: "verify",
        ...(callerSearchTerm ? { callerSearchTerm } : {}),
    };
}

export function truncateSearchUtf8(
    value: string,
    requestedMaxBytes: number,
    marker = "...",
): string {
    const maxBytes = Math.max(0, Math.floor(requestedMaxBytes));
    if (Buffer.byteLength(value, "utf8") <= maxBytes) {
        return value;
    }
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes > maxBytes) {
        return "";
    }
    let result = "";
    let usedBytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (usedBytes + characterBytes + markerBytes > maxBytes) {
            break;
        }
        result += character;
        usedBytes += characterBytes;
    }
    return `${result}${marker}`;
}

export function buildDisplaySymbolLabel(input: {
    symbolLabel?: string | null;
    symbolKind?: string;
    relativePath: string;
    span: SearchSpan;
    content?: string;
}): string {
    const normalizedLabel = normalizeSearchSymbolLabel(input.symbolLabel);
    if (normalizedLabel) {
        return truncateSearchUtf8(normalizedLabel, SEARCH_DISPLAY_LABEL_MAX_BYTES);
    }
    const content = input.content || "";
    const declaration = content.match(/\b(?:async\s+)?(?:function|def|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) {
        return truncateSearchUtf8(
            `${input.symbolKind || "symbol"} ${declaration[1]}`,
            SEARCH_DISPLAY_LABEL_MAX_BYTES,
        );
    }
    return truncateSearchUtf8(
        `${input.symbolKind || "symbol"} ${input.relativePath}:${Math.max(1, input.span.startLine)}`,
        SEARCH_DISPLAY_LABEL_MAX_BYTES,
    );
}

export function normalizeSearchSymbolLabel(label: string | null | undefined): string | undefined {
    if (typeof label !== "string") {
        return undefined;
    }
    let normalized = Array.from(label, (character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 ? " " : character;
    }).join("")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\s*\{\s*$/, "");
    if (normalized.length === 0) {
        return undefined;
    }

    const unmatchedParen = (normalized.match(/\(/g) || []).length > (normalized.match(/\)/g) || []).length;
    if (unmatchedParen) {
        const declaration = normalized.match(/\b((?:async\s+)?(?:function|method|def|class|const|let|var|interface|type))\s+([A-Za-z_$][\w$]*)/);
        if (declaration) {
            return `${declaration[1].replace(/\s+/g, " ")} ${declaration[2]}`;
        }
        normalized = normalized.replace(/\s*\([^)]*$/, "").trim();
    }

    return normalized.length > 0 ? normalized : undefined;
}

export function buildSearchGroupPreview(symbolLabel: string, content: string, previewMaxBytes: number): string {
    const normalizedLabel = normalizeSearchSymbolLabel(symbolLabel) || symbolLabel;
    const labelIdentifier = extractIdentifierFromSymbolLabel(normalizedLabel);
    const previewLines: string[] = [];
    const seen = new Set<string>();
    let skippingSignatureContinuation = false;

    for (const rawLine of content.split(/\r\n?|\n/)) {
        const line = normalizeSearchPreviewLine(rawLine);
        if (!line || isSearchPreviewNoiseLine(line)) {
            continue;
        }
        if (skippingSignatureContinuation) {
            if (isSearchPreviewSignatureContinuationLine(line)) {
                if (isSearchPreviewSignatureContinuationEndLine(line)) {
                    skippingSignatureContinuation = false;
                }
                continue;
            }
            skippingSignatureContinuation = false;
        }
        const key = line.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        const lineIdentifier = extractIdentifierFromSymbolLabel(line);
        if (lineIdentifier && labelIdentifier && lineIdentifier !== labelIdentifier && isSearchPreviewNeighborDeclarationLine(line) && previewLines.length > 0) {
            break;
        }
        if (lineIdentifier && labelIdentifier && lineIdentifier === labelIdentifier && isSearchPreviewPureDuplicateDeclarationLine(line)) {
            if (isSearchPreviewOpenSignatureLine(line)) {
                skippingSignatureContinuation = true;
            }
            seen.add(key);
            continue;
        }

        previewLines.push(line);
        seen.add(key);
        if (previewLines.length >= 5) {
            break;
        }
    }

    return truncateSearchUtf8(
        previewLines.join("\n"),
        Math.min(SEARCH_GROUP_PREVIEW_MAX_BYTES, previewMaxBytes),
    );
}

function normalizeSearchPreviewLine(line: string): string {
    return line
        .replace(/\s+/g, " ")
        .replace(/^\s+|\s+$/g, "")
        .replace(/\s+([,;:)\]}])/g, "$1")
        .replace(/([({\[])\s+/g, "$1");
}

function isSearchPreviewNoiseLine(line: string): boolean {
    return line.length === 0
        || /^[@#]\s*$/.test(line)
        || /^@/.test(line)
        || /^(?:\/\/|\/\*|\*\/|\*|#)\s*$/.test(line)
        || /^[{}()[\],;]+$/.test(line);
}

function isSearchPreviewDeclarationLine(line: string): boolean {
    return /^\s*(?:export\s+)?(?:async\s+)?(?:function|def|class|const|let|var|interface|type)\s+[A-Za-z_$][\w$]*/.test(line)
        || /^\s*(?:(?:public|private|protected)\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/.test(line);
}

function isSearchPreviewOpenSignatureLine(line: string): boolean {
    const openParens = (line.match(/\(/g) || []).length;
    const closeParens = (line.match(/\)/g) || []).length;
    return openParens > closeParens || /\(\s*$/.test(line);
}

function isSearchPreviewSignatureContinuationLine(line: string): boolean {
    return isSearchPreviewSignatureContinuationEndLine(line)
        || /^(?:\.\.\.)?[A-Za-z_$][\w$]*\??(?:\s*:\s*[^,=]+)?(?:\s*=\s*[^,]+)?[,]?$/.test(line)
        || /^\*{1,2}[A-Za-z_$][\w$]*(?:\s*=\s*[^,]+)?[,]?$/.test(line);
}

function isSearchPreviewSignatureContinuationEndLine(line: string): boolean {
    return /^\)\s*(?:(?:->|=>)\s*[^:{]+)?\s*[:{,;]?$/.test(line);
}

function isSearchPreviewNeighborDeclarationLine(line: string): boolean {
    return /^\s*(?:export\s+)?(?:async\s+)?(?:function|def|class|interface|type)\s+[A-Za-z_$][\w$]*/.test(line)
        || /^\s*(?:(?:public|private|protected)\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/.test(line);
}

function isSearchPreviewPureDuplicateDeclarationLine(line: string): boolean {
    if (!isSearchPreviewDeclarationLine(line)) {
        return false;
    }
    return !/\breturn\b/.test(line)
        && !/=>/.test(line)
        && !/=\s*[^=>]/.test(line)
        && !/["'`]/.test(line)
        && !/\b[A-Z][A-Z0-9_]{2,}\b/.test(line);
}
