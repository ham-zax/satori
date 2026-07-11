import { compareContractStrings, type SymbolRecord } from "@zokizuan/satori-core";
import type { CallGraphHint } from "./search-types.js";
import type { FileOutlineResponseEnvelope, FileOutlineSymbolResult } from "./search-types.js";
import {
    repairSourceBackedPythonSpans,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import { validateCurrentSourceSymbolSpans } from "./current-source-symbols.js";

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
    warnings?: string[];
    buildCallGraphHint: (symbol: SymbolRecord) => CallGraphHint;
    buildOutlineSpanWarningCodes: (repair: PythonSourceBackedSpanRepair | undefined) => string[];
}): Promise<FileOutlineResponseEnvelope> {
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
            symbolId: symbol.symbolInstanceId,
            symbolLabel: symbol.label,
            span: {
                startLine: symbol.span.startLine,
                endLine: symbol.span.endLine,
            },
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
        const hasMoreExact = exactMapped.length > input.limitSymbols;
        return {
            status: exactMapped.length > 1 ? "ambiguous" : "ok",
            path: input.codebaseRoot,
            file: input.file,
            outline: { symbols: exactMapped.slice(0, input.limitSymbols) },
            hasMore: hasMoreExact,
            ...(exactMapped.length > 1
                ? { message: `Multiple exact symbol matches found (${exactMapped.length}). Narrow with symbolIdExact for deterministic selection.` }
                : {}),
            ...(exactWarnings.length > 0 ? { warnings: exactWarnings } : {}),
        };
    }

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
        return [...warningSet].sort(compareContractStrings);
    };

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
