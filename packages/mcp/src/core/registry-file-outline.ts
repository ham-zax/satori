import type { SymbolRecord } from "@zokizuan/satori-core";
import type { CallGraphHint } from "./search-types.js";
import type { FileOutlineResponseEnvelope, FileOutlineSymbolResult } from "./search-types.js";
import {
    repairSourceBackedPythonSpans,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";

function compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
    const left = a ?? Number.POSITIVE_INFINITY;
    const right = b ?? Number.POSITIVE_INFINITY;
    return left - right;
}

function compareNullableStringsAsc(a?: string | null, b?: string | null): number {
    const left = a ?? "\uffff";
    const right = b ?? "\uffff";
    return left.localeCompare(right);
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

export function buildRegistryFileOutlinePayload(input: {
    codebaseRoot: string;
    file: string;
    symbols: SymbolRecord[];
    limitSymbols: number;
    resolveMode: "outline" | "exact";
    symbolIdExact?: string;
    symbolLabelExact?: string;
    windowStart?: number;
    windowEnd?: number;
    warnings?: string[];
    buildCallGraphHint: (symbol: SymbolRecord) => CallGraphHint;
    buildOutlineSpanWarningCodes: (repair: PythonSourceBackedSpanRepair | undefined) => string[];
}): FileOutlineResponseEnvelope {
    const repairs = repairSourceBackedPythonSpans({
        codebaseRoot: input.codebaseRoot,
        symbols: input.symbols,
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
        symbolId: symbol.symbolInstanceId,
        symbolLabel: symbol.label,
        span: {
            startLine: symbol.span.startLine,
            endLine: symbol.span.endLine,
        },
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
        return [...warningSet].sort((a, b) => a.localeCompare(b));
    };

    if (input.resolveMode === "exact") {
        const exactMatchIds = new Set(findExactRegistrySymbols({
            symbols: repairedSymbols,
            symbolIdExact: input.symbolIdExact,
            symbolLabelExact: input.symbolLabelExact,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
        }).map((symbol) => symbol.symbolInstanceId));
        const exactMatches = sortFileOutlineSymbols(
            mappedSymbols.filter((symbol) => exactMatchIds.has(symbol.symbolId)),
        );

        if (exactMatches.length === 0) {
            const warnings = collectWarnings(mappedSymbols);
            return {
                status: "not_found",
                reason: "missing_symbol",
                path: input.codebaseRoot,
                file: input.file,
                outline: null,
                hasMore: false,
                message: "No exact symbol match found in file outline.",
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        }

        const hasMoreExact = exactMatches.length > input.limitSymbols;
        const exactWarnings = collectWarnings(exactMatches);
        return {
            status: exactMatches.length > 1 ? "ambiguous" : "ok",
            path: input.codebaseRoot,
            file: input.file,
            outline: {
                symbols: exactMatches.slice(0, input.limitSymbols),
            },
            hasMore: hasMoreExact,
            ...(exactMatches.length > 1
                ? { message: `Multiple exact symbol matches found (${exactMatches.length}). Narrow with symbolIdExact for deterministic selection.` }
                : {}),
            ...(exactWarnings.length > 0 ? { warnings: exactWarnings } : {}),
        };
    }

    const hasMore = mappedSymbols.length > input.limitSymbols;
    const warnings = collectWarnings(mappedSymbols);
    return {
        status: "ok",
        path: input.codebaseRoot,
        file: input.file,
        outline: {
            symbols: mappedSymbols.slice(0, input.limitSymbols),
        },
        hasMore,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}
