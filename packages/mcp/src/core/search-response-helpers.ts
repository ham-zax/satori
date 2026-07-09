import * as path from "path";
import { compareContractStrings } from "@zokizuan/satori-core";
import { truncateContent } from "../utils.js";
import type { PythonSourceBackedSpanRepair } from "./python-call-fallback.js";
import type { SearchGroupBy, SearchScope } from "./search-constants.js";
import type {
    CallGraphHint,
    SearchCapabilityConfidence,
    SearchChunkResult,
    SearchDebugHint,
    SearchFreshnessSummary,
    SearchGroupResult,
    SearchRecommendedNextAction,
    SearchResponseEnvelope,
    SearchResultCapabilities,
    SearchSpan,
    SearchWarningDetail,
} from "./search-types.js";
import { WARNING_CODES } from "./warnings.js";

const SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING = "SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE";
type SearchSpanValidation = "verified" | "unverified" | "not_applicable";

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

export function buildSearchResultCapabilities(input: {
    callGraphHint: CallGraphHint;
    confidence?: "high" | "medium" | "low";
    hasOpenSymbol: boolean;
    hasReadFallback: boolean;
    semanticMatch: SearchCapabilityConfidence;
    spanValidation: SearchSpanValidation;
}): SearchResultCapabilities {
    const openSymbol: SearchCapabilityConfidence = input.hasOpenSymbol
        ? input.spanValidation === "unverified"
            ? "low"
            : (input.confidence === "high" ? "high" : "medium")
        : input.hasReadFallback
            ? "medium"
            : "low";
    const graphUnavailableConfidence: SearchCapabilityConfidence = input.callGraphHint.supported
        ? "medium"
        : input.callGraphHint.reason === "unsupported_language"
            ? "unavailable"
            : "low";
    return {
        openSymbol,
        callGraphCallers: input.callGraphHint.supported ? "low" : graphUnavailableConfidence,
        callGraphCallees: input.callGraphHint.supported ? "medium" : graphUnavailableConfidence,
        semanticMatch: input.semanticMatch,
    };
}

/** Prefer plain preview reads when full symbol span would open a wall of code (L11/B2). */
export const OVERSIZED_SYMBOL_LINE_THRESHOLD = 200;

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

function resolveAbsoluteReadPath(result: SearchGroupResult): string | undefined {
    const openPath = result.nextActions?.openSymbol?.args?.path;
    if (typeof openPath === "string" && openPath.length > 0) {
        return openPath;
    }
    const fallbackPath = result.navigationFallback?.readSpan?.args?.path;
    if (typeof fallbackPath === "string" && fallbackPath.length > 0) {
        return fallbackPath;
    }
    return undefined;
}

export function buildSearchGroupRecommendedAction(
    result: SearchGroupResult,
    resultIndex?: number,
): SearchRecommendedNextAction | undefined {
    // Oversized symbols: recommend plain preview read first. Do not smuggle preview into
    // open_symbol (exact open always expands to full resolved span) or shrink primary span.
    if (isOversizedSymbolSpan(result.symbolSpan) && result.previewSpan) {
        const absolutePath = resolveAbsoluteReadPath(result);
        const previewStart = Number(result.previewSpan.startLine);
        const previewEnd = Number(result.previewSpan.endLine);
        if (
            absolutePath
            && Number.isFinite(previewStart)
            && Number.isFinite(previewEnd)
            && previewEnd >= previewStart
        ) {
            return {
                ...(resultIndex !== undefined ? { resultIndex } : {}),
                tool: "read_file",
                args: {
                    path: absolutePath,
                    start_line: Math.max(1, previewStart),
                    end_line: Math.max(1, previewEnd),
                },
                reason: "Symbol span is oversized; read the hit preview first before exact open_symbol.",
            };
        }
    }

    if (result.nextActions?.openSymbol) {
        return {
            ...(resultIndex !== undefined ? { resultIndex } : {}),
            tool: "read_file",
            args: result.nextActions.openSymbol.args,
            reason: result.confidence === "high"
                ? "Open the exact owner before call graph because symbol identity is high confidence."
                : "Open the selected owner before graph traversal so edits are grounded in source.",
        };
    }
    if (result.navigationFallback?.readSpan) {
        return {
            ...(resultIndex !== undefined ? { resultIndex } : {}),
            tool: "read_file",
            args: result.navigationFallback.readSpan.args,
            reason: "Call graph navigation is unavailable; read the result span directly.",
        };
    }
    if (result.nextActions?.outlineWindow) {
        return {
            ...(resultIndex !== undefined ? { resultIndex } : {}),
            tool: "file_outline",
            args: result.nextActions.outlineWindow.args,
            reason: "Open the nearby outline window to resolve the owner before reading code.",
        };
    }
    return undefined;
}

export function buildTopRecommendedSearchAction(results: SearchGroupResult[]): SearchRecommendedNextAction | undefined {
    const firstActionableIndex = results.findIndex((result) => buildSearchGroupRecommendedAction(result) !== undefined);
    if (firstActionableIndex < 0) {
        return undefined;
    }
    return buildSearchGroupRecommendedAction(results[firstActionableIndex], firstActionableIndex);
}

export function buildTopRecommendedRawSearchAction(
    codebaseRoot: string,
    results: SearchChunkResult[],
): SearchRecommendedNextAction | undefined {
    const first = results[0];
    if (!first) {
        return undefined;
    }
    return {
        resultIndex: 0,
        tool: "read_file",
        args: {
            path: path.resolve(codebaseRoot, first.file),
            start_line: Math.max(1, first.span.startLine),
            end_line: Math.max(Math.max(1, first.span.startLine), first.span.endLine),
        },
        reason: "Open the top raw chunk before inferring ownership from ungrouped search results.",
    };
}

export function buildSearchGroupFallbacks(input: {
    codebaseRoot: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    result: SearchGroupResult;
}): SearchGroupResult["fallbacks"] | undefined {
    const fallbacks: NonNullable<SearchGroupResult["fallbacks"]> = [];
    if (input.result.callGraphHint.supported) {
        fallbacks.push({
            when: "call_graph returns no edges or relationship confidence is lower than the edit needs",
            tool: "search_codebase",
            args: {
                path: input.codebaseRoot,
                query: buildExactSymbolFallbackQuery(input.result, input.query),
                scope: input.scope,
                resultMode: "grouped",
                groupBy: input.groupBy,
                limit: 5,
            },
            reason: "Inbound graph coverage can be incomplete; exact lexical search verifies references before impact analysis.",
        });
    } else if (input.result.navigationFallback?.readSpan) {
        fallbacks.push({
            when: `call graph is unavailable: ${input.result.callGraphHint.supported ? "unknown" : input.result.callGraphHint.reason}`,
            tool: "read_file",
            args: input.result.navigationFallback.readSpan.args,
            reason: "Read the indexed span directly because deterministic graph navigation is unavailable.",
        });
    }

    return fallbacks.length > 0 ? fallbacks : undefined;
}

function buildExactSymbolFallbackQuery(result: SearchGroupResult, originalQuery: string): string {
    const identifier = extractIdentifierFromSymbolLabel(result.symbolLabel) || extractIdentifierFromSymbolLabel(result.groupId);
    return identifier ? `must:${identifier} ${identifier}` : originalQuery;
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

export function buildDisplaySymbolLabel(input: {
    symbolLabel?: string | null;
    symbolKind?: string;
    relativePath: string;
    span: SearchSpan;
    content?: string;
}): string {
    const normalizedLabel = normalizeSearchSymbolLabel(input.symbolLabel);
    if (normalizedLabel) {
        return normalizedLabel;
    }
    const content = input.content || "";
    const declaration = content.match(/\b(?:async\s+)?(?:function|def|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) {
        return `${input.symbolKind || "symbol"} ${declaration[1]}`;
    }
    return `${input.symbolKind || "symbol"} ${input.relativePath}:${Math.max(1, input.span.startLine)}`;
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

export function buildSearchGroupPreview(symbolLabel: string, content: string, previewMaxChars: number): string {
    const normalizedLabel = normalizeSearchSymbolLabel(symbolLabel) || symbolLabel;
    const labelIdentifier = extractIdentifierFromSymbolLabel(normalizedLabel);
    const previewLines = [normalizedLabel];
    const seen = new Set([normalizeSearchPreviewLine(normalizedLabel).toLowerCase()]);
    let skippingSignatureContinuation = false;

    for (const rawLine of content.split(/\r?\n/)) {
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
        if (lineIdentifier && labelIdentifier && lineIdentifier !== labelIdentifier && isSearchPreviewNeighborDeclarationLine(line) && previewLines.length > 1) {
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

    return truncateContent(previewLines.join("\n"), previewMaxChars);
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
