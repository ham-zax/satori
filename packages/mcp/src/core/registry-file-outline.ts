import { compareContractStrings, type SymbolRecord } from "@satori-code/core";
import type { CallGraphHint } from "./search-types.js";
import type { FileOutlineResponseEnvelope, FileOutlineSymbolResult } from "./search-types.js";
import {
    repairSourceBackedPythonSpans,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import { validateCurrentSourceSymbolSpans } from "./current-source-symbols.js";
import {
    buildCanonicalSymbolRegistryView,
    projectCanonicalSymbolIdentity,
} from "./canonical-symbol-identity.js";

function compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
    const left = a ?? Number.POSITIVE_INFINITY;
    const right = b ?? Number.POSITIVE_INFINITY;
    return left - right;
}

function compareNullableStringsAsc(a?: string | null, b?: string | null): number {
    const left = a ?? "\uffff";
    const right = b ?? "\uffff";
    return compareContractStrings(left, right);
}

function sortFileOutlineSymbols(symbols: FileOutlineSymbolResult[]): FileOutlineSymbolResult[] {
    return [...symbols].sort((a, b) => {
        const startCmp = compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
        if (startCmp !== 0) return startCmp;
        const endCmp = compareNullableNumbersAsc(a.span?.endLine, b.span?.endLine);
        if (endCmp !== 0) return endCmp;
        const labelCmp = compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
        if (labelCmp !== 0) return labelCmp;
        return compareNullableStringsAsc(a.symbolId, b.symbolId);
    });
}

function sortRegistrySymbols(symbols: SymbolRecord[]): SymbolRecord[] {
    return [...symbols].sort((a, b) => {
        const startCmp = compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
        if (startCmp !== 0) return startCmp;
        const endCmp = compareNullableNumbersAsc(a.span?.endLine, b.span?.endLine);
        if (endCmp !== 0) return endCmp;
        const labelCmp = compareNullableStringsAsc(a.label, b.label);
        if (labelCmp !== 0) return labelCmp;
        return compareNullableStringsAsc(a.symbolInstanceId, b.symbolInstanceId);
    });
}

function buildVisibleRegistrySymbolState(input: {
    symbols: SymbolRecord[];
    windowStart?: number;
    windowEnd?: number;
}): {
    hasExtractedSymbols: boolean;
    visibleSymbols: SymbolRecord[];
} {
    const hasExtractedSymbols = input.symbols.some((symbol) => symbol.kind !== "file");
    const visibleSymbols = input.symbols.filter((symbol) => {
        if (hasExtractedSymbols && symbol.kind === "file") {
            return false;
        }
        if (!input.windowStart && !input.windowEnd) {
            return true;
        }
        const startsBeforeWindowEnd = input.windowEnd === undefined || symbol.span.startLine <= input.windowEnd;
        const endsAfterWindowStart = input.windowStart === undefined || symbol.span.endLine >= input.windowStart;
        return startsBeforeWindowEnd && endsAfterWindowStart;
    });

    return {
        hasExtractedSymbols,
        visibleSymbols,
    };
}

export function findExactRegistrySymbols(input: {
    symbols: SymbolRecord[];
    symbolIdExact?: string;
    symbolLabelExact?: string;
    windowStart?: number;
    windowEnd?: number;
}): SymbolRecord[] {
    const visibleState = buildVisibleRegistrySymbolState(input);
    const exactMatches = visibleState.visibleSymbols.filter((symbol) => {
        if (input.symbolIdExact && symbol.symbolInstanceId !== input.symbolIdExact) {
            return false;
        }
        if (input.symbolLabelExact && symbol.label !== input.symbolLabelExact) {
            return false;
        }
        return true;
    });
    return sortRegistrySymbols(exactMatches);
}

export async function buildRegistryFileOutlinePayload(input: {
    codebaseRoot: string;
    file: string;
    symbols: SymbolRecord[];
    limitSymbols: number;
    resolveMode: "outline" | "exact";
    symbolIdExact?: string;
    symbolLabelExact?: string;
    windowStart?: number;
    windowEnd?: number;
    continuationArgs?: Record<string, unknown>;
    warnings?: string[];
    buildCallGraphHint: (symbol: SymbolRecord) => CallGraphHint;
    buildOutlineSpanWarningCodes: (repair: PythonSourceBackedSpanRepair | undefined) => string[];
    readSourceLines: (codebaseRoot: string, relativeFilePath: string) => Promise<string[] | undefined>;
}): Promise<FileOutlineResponseEnvelope> {
    // Symbol keys bind the repo-relative file, so this complete file-scoped
    // registry view contains every possible parent-key candidate.
    const registry = buildCanonicalSymbolRegistryView(input.symbols);
    const mapSymbol = (symbol: SymbolRecord): Omit<FileOutlineSymbolResult, "callGraphHint"> => (
        projectCanonicalSymbolIdentity({ symbol, registry })
    );

    if (input.resolveMode === "exact") {
        const persistedExactMatches = findExactRegistrySymbols({
            symbols: input.symbols,
            symbolIdExact: input.symbolIdExact,
            symbolLabelExact: input.symbolLabelExact,
        });
        const exactSymbolIds = new Set(persistedExactMatches.map((symbol) => symbol.symbolInstanceId));
        const exactSymbolKeys = new Set(persistedExactMatches.map((symbol) => symbol.symbolKey));
        const validationCohort = input.symbols.filter((symbol) => exactSymbolKeys.has(symbol.symbolKey));
        const cohortValidations = await validateCurrentSourceSymbolSpans({
            codebaseRoot: input.codebaseRoot,
            symbols: validationCohort,
        });
        const validations = cohortValidations.filter((validation) => exactSymbolIds.has(validation.symbol.symbolInstanceId));
        const validatedExactMatches = validations
            .filter((validation) => validation.match === "matched" || validation.match === "not_applicable")
            .map((validation) => validation.symbol)
            .filter((symbol) => {
                const startsBeforeWindowEnd = input.windowEnd === undefined || symbol.span.startLine <= input.windowEnd;
                const endsAfterWindowStart = input.windowStart === undefined || symbol.span.endLine >= input.windowStart;
                return startsBeforeWindowEnd && endsAfterWindowStart;
            });
        const exactRepairBySymbolId = new Map(validations.map((validation) => [validation.symbol.symbolInstanceId, validation]));
        const exactMapped = sortFileOutlineSymbols(validatedExactMatches.map((symbol) => ({
            ...mapSymbol(symbol),
            callGraphHint: input.buildCallGraphHint(symbol),
        } satisfies FileOutlineSymbolResult)));
        const exactWarningSet = new Set(input.warnings || []);
        for (const symbol of exactMapped) {
            for (const warning of input.buildOutlineSpanWarningCodes(exactRepairBySymbolId.get(symbol.symbolId))) {
                exactWarningSet.add(warning);
            }
        }
        if (exactMapped.some((symbol) => !symbol.callGraphHint.supported)) {
            const firstUnsupported = exactMapped.find((symbol) => !symbol.callGraphHint.supported)?.callGraphHint;
            if (firstUnsupported && !firstUnsupported.supported) {
                exactWarningSet.add(`OUTLINE_CALL_GRAPH_UNAVAILABLE:${firstUnsupported.reason}`);
            }
        }
        const hasAmbiguousValidation = validations.some((validation) => validation.match === "ambiguous");
        const hasUnavailableValidation = validations.some((validation) => validation.match === "unavailable");
        if (hasUnavailableValidation) {
            exactWarningSet.add("OUTLINE_SYMBOL_SPAN_UNVERIFIED");
        }
        const exactWarnings = [...exactWarningSet].sort(compareContractStrings);
        if (hasAmbiguousValidation) {
            return {
                status: "ambiguous",
                path: input.codebaseRoot,
                file: input.file,
                outline: null,
                hasMore: false,
                message: "The persisted symbol identity matches multiple current source symbols; narrow after synchronizing the index.",
                ...(exactWarnings.length > 0 ? { warnings: exactWarnings } : {}),
            };
        }
        if (hasUnavailableValidation) {
            return {
                status: "not_ready",
                path: input.codebaseRoot,
                file: input.file,
                outline: null,
                hasMore: false,
                message: "The exact symbol span could not be verified against current source.",
                warnings: exactWarnings,
            };
        }
        if (exactMapped.length === 0) {
            return {
                status: "not_found",
                reason: "missing_symbol",
                path: input.codebaseRoot,
                file: input.file,
                outline: null,
                hasMore: false,
                message: "No exact symbol match found in file outline.",
                ...(exactWarnings.length > 0 ? { warnings: exactWarnings } : {}),
            };
        }
        // Exact mode selects rather than pages: every match is returned so an
        // ambiguous caller can see each symbolId to narrow with. Matches share
        // one label in one file, so the set stays small.
        return {
            status: exactMapped.length > 1 ? "ambiguous" : "ok",
            path: input.codebaseRoot,
            file: input.file,
            outline: { symbols: exactMapped },
            hasMore: false,
            ...(exactMapped.length > 1
                ? { message: `Multiple exact symbol matches found (${exactMapped.length}). Narrow with symbolIdExact for deterministic selection.` }
                : {}),
            ...(exactWarnings.length > 0 ? { warnings: exactWarnings } : {}),
        };
    }

    const repairs = await repairSourceBackedPythonSpans({
        codebaseRoot: input.codebaseRoot,
        symbols: input.symbols,
        readSourceLines: input.readSourceLines,
    });
    const repairedSymbols = repairs.map((repair) => repair.symbol);
    const repairBySymbolId = new Map(repairs.map((repair) => [repair.symbol.symbolInstanceId, repair]));
    const visibleState = buildVisibleRegistrySymbolState({
        symbols: repairedSymbols,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
    });
    const visibleSymbols = visibleState.visibleSymbols;

    const mappedSymbols = sortFileOutlineSymbols(visibleSymbols.map((symbol) => ({
        ...mapSymbol(symbol),
        callGraphHint: input.buildCallGraphHint(symbol),
    } satisfies FileOutlineSymbolResult)));

    const collectWarnings = (symbols: FileOutlineSymbolResult[]): string[] => {
        const warningSet = new Set(input.warnings || []);
        for (const symbol of symbols) {
            for (const warning of input.buildOutlineSpanWarningCodes(repairBySymbolId.get(symbol.symbolId))) {
                warningSet.add(warning);
            }
        }
        if (symbols.some((symbol) => !symbol.callGraphHint.supported)) {
            const firstUnsupported = symbols.find((symbol) => !symbol.callGraphHint.supported)?.callGraphHint;
            if (firstUnsupported && !firstUnsupported.supported) {
                warningSet.add(`OUTLINE_CALL_GRAPH_UNAVAILABLE:${firstUnsupported.reason}`);
            }
        }
        if (!visibleState.hasExtractedSymbols && symbols.length > 0) {
            warningSet.add("OUTLINE_SYNTHESIZED_FILE_SYMBOL");
        }
        return [...warningSet].sort(compareContractStrings);
    };

    // Enclosing symbols that start before the window repeat on every page of a
    // walk; counting them would let them fill the page so it never advances.
    // Symbols are sorted by start line, so they form a prefix.
    const windowStart = input.windowStart;
    const enclosingCount = windowStart === undefined
        ? 0
        : mappedSymbols.findIndex((symbol) => (symbol.span?.startLine ?? windowStart) >= windowStart);
    const pageSize = (enclosingCount < 0 ? mappedSymbols.length : enclosingCount) + input.limitSymbols;
    const hasMore = mappedSymbols.length > pageSize;
    const warnings = collectWarnings(mappedSymbols);
    const nextPage = hasMore
        ? outlineNextPageHint(input.continuationArgs, mappedSymbols[pageSize]?.span?.startLine, input.windowStart)
        : undefined;
    return {
        status: "ok",
        path: input.codebaseRoot,
        file: input.file,
        outline: {
            symbols: mappedSymbols.slice(0, pageSize),
        },
        hasMore,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(nextPage ? { hints: { nextPage } } : {}),
    };
}

/**
 * Continuation for an outline cut short. Omitted when it would not advance
 * past the requested start line, so paging cannot repeat the same page.
 */
function outlineNextPageHint(
    continuationArgs: Record<string, unknown> | undefined,
    nextStartLine: number | undefined,
    requestedStartLine: number | undefined,
): { tool: "file_outline"; args: Record<string, unknown> } | undefined {
    if (!continuationArgs || nextStartLine === undefined) return undefined;
    if (requestedStartLine !== undefined && nextStartLine <= requestedStartLine) return undefined;
    return { tool: "file_outline", args: { ...continuationArgs, start_line: nextStartLine } };
}

/**
 * MCP hosts cap tool output (Claude Code defaults to 25k tokens). A response
 * near this many UTF-8 bytes of dense JSON stays under that cap.
 */
export const FILE_OUTLINE_RESPONSE_MAX_UTF8_BYTES = 48 * 1024;

/**
 * Keeps the longest leading run of outline symbols whose serialized response
 * fits the byte budget. Symbols are sorted by start line, so every omitted
 * symbol starts at or after the first omitted one; the continuation reissues
 * the request from that line. Enclosing symbols may repeat on the next page.
 */
export function fitFileOutlineResponseBudget<T extends FileOutlineResponseEnvelope>(input: {
    payload: T;
    maxResponseBytes: number;
    continuationArgs: Record<string, unknown>;
    requestedStartLine?: number;
    stringify: (payload: T) => string;
}): T {
    const fits = (candidate: T) => Buffer.byteLength(input.stringify(candidate), "utf8") <= input.maxResponseBytes;
    const symbols = input.payload.outline?.symbols;
    if (!symbols || symbols.length === 0 || fits(input.payload)) return input.payload;

    // A limitSymbols continuation would skip the symbols trimmed here.
    const remainingHints = { ...input.payload.hints };
    delete remainingHints.nextPage;
    const otherHints = Object.keys(remainingHints).length > 0 ? remainingHints : undefined;
    const truncate = (count: number): T => {
        const nextPage = outlineNextPageHint(
            input.continuationArgs,
            symbols[count]?.span?.startLine,
            input.requestedStartLine,
        );
        return {
            ...input.payload,
            outline: { symbols: symbols.slice(0, count) },
            hasMore: true,
            warnings: [...new Set([...(input.payload.warnings ?? []), "OUTLINE_RESPONSE_BYTE_LIMIT"])]
                .sort(compareContractStrings),
            ...(nextPage || otherHints ? { hints: { ...otherHints, ...(nextPage ? { nextPage } : {}) } } : {}),
        };
    };

    let low = 0;
    let high = symbols.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(truncate(mid))) low = mid;
        else high = mid - 1;
    }
    return truncate(low);
}
