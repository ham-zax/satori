import * as path from "path";
import type { SymbolRecord } from "@zokizuan/satori-core";
import type {
    CallGraphHint,
    FileOutlineStatus,
    SearchGroupResult,
    SearchSpan,
} from "./search-types.js";

const NAVIGATION_FALLBACK_MESSAGE = "Call graph not available for this result; use readSpan or fileOutlineWindow to navigate.";

type CallGraphUnavailableReason = Extract<CallGraphHint, { supported: false }>["reason"];

export type SearchNavigationState = {
    relationshipReady: boolean;
    relationshipBuiltAt?: string;
    relationshipUnavailableReason?: CallGraphUnavailableReason;
};

export type SearchNavigationHelpers = {
    now: () => number;
    sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => string | undefined;
    isCallGraphLanguageSupported: (language: string, file: string) => boolean;
    getOutlineStatusForLanguage: (relativeFilePath: string) => FileOutlineStatus;
};

export function buildRelationshipCallGraphHint(input: {
    file: string;
    language: string;
    symbolId: string;
    symbolLabel?: string;
    span: { startLine: number; endLine: number };
    sidecarBuiltAt?: string;
}, helpers: SearchNavigationHelpers): CallGraphHint {
    if (!helpers.isCallGraphLanguageSupported(input.language, input.file)) {
        return { supported: false, reason: "unsupported_language" };
    }

    const normalizedFile = helpers.sanitizeIndexedRelativeFilePath(input.file);
    if (!normalizedFile) {
        return { supported: false, reason: "stale_symbol_ref" };
    }

    const validatedAt = new Date(helpers.now()).toISOString();
    const safeStartLine = Math.max(1, Number(input.span.startLine));
    const safeEndLine = Math.max(safeStartLine, Number(input.span.endLine));

    return {
        supported: true,
        validated: true,
        validatedAt,
        sidecarBuiltAt: input.sidecarBuiltAt || validatedAt,
        symbolRef: {
            file: normalizedFile,
            symbolId: input.symbolId,
            ...(input.symbolLabel ? { symbolLabel: input.symbolLabel } : {}),
            span: {
                startLine: safeStartLine,
                endLine: safeEndLine,
            },
        },
    };
}

export function buildRegistrySymbolCallGraphHint(
    symbol: SymbolRecord,
    file: string,
    navigationState: SearchNavigationState,
    helpers: SearchNavigationHelpers,
): CallGraphHint {
    if (symbol.kind === "file") {
        return { supported: false, reason: "missing_symbol" };
    }

    if (!helpers.isCallGraphLanguageSupported(symbol.language, file)) {
        return { supported: false, reason: "unsupported_language" };
    }

    if (navigationState.relationshipReady) {
        return buildRelationshipCallGraphHint({
            file,
            language: symbol.language,
            symbolId: symbol.symbolInstanceId,
            symbolLabel: symbol.label,
            span: {
                startLine: symbol.span.startLine,
                endLine: symbol.span.endLine,
            },
            sidecarBuiltAt: navigationState.relationshipBuiltAt,
        }, helpers);
    }

    return {
        supported: false,
        reason: navigationState.relationshipUnavailableReason || "missing_relationship_sidecar",
    };
}

export function buildSearchGroupCallGraphHint(input: {
    file: string;
    language: string;
    span: SearchSpan;
    symbolLabel?: string;
    ownerSymbolInstanceId?: string;
    registrySymbol?: SymbolRecord;
    registryLoaded?: boolean;
    registryUnavailableReason?: CallGraphUnavailableReason;
    navigationState: SearchNavigationState;
}, helpers: SearchNavigationHelpers): CallGraphHint {
    if (input.registrySymbol) {
        return buildRegistrySymbolCallGraphHint(
            input.registrySymbol,
            input.registrySymbol.file,
            input.navigationState,
            helpers,
        );
    }

    if (!input.ownerSymbolInstanceId) {
        return { supported: false, reason: "missing_symbol" };
    }

    if (input.registryUnavailableReason) {
        return { supported: false, reason: input.registryUnavailableReason };
    }

    if (input.registryLoaded) {
        return { supported: false, reason: "stale_symbol_ref" };
    }

    if (input.navigationState.relationshipReady) {
        return buildRelationshipCallGraphHint({
            file: input.file,
            language: input.language,
            symbolId: input.ownerSymbolInstanceId,
            symbolLabel: input.symbolLabel,
            span: input.span,
            sidecarBuiltAt: input.navigationState.relationshipBuiltAt,
        }, helpers);
    }

    return {
        supported: false,
        reason: input.navigationState.relationshipUnavailableReason || "missing_relationship_sidecar",
    };
}

function buildSearchOpenSymbolAction(
    codebaseRoot: string,
    registrySymbol: SymbolRecord | undefined,
    helpers: SearchNavigationHelpers,
): NonNullable<NonNullable<SearchGroupResult["nextActions"]>["openSymbol"]> | undefined {
    if (!registrySymbol || registrySymbol.kind === "file") {
        return undefined;
    }

    const normalizedFile = helpers.sanitizeIndexedRelativeFilePath(registrySymbol.file);
    if (!normalizedFile) {
        return undefined;
    }

    return {
        tool: "read_file",
        args: {
            path: path.resolve(codebaseRoot, normalizedFile),
            open_symbol: {
                symbolId: registrySymbol.symbolInstanceId,
                ...(registrySymbol.label ? { symbolLabel: registrySymbol.label } : {}),
            },
        },
    };
}

export function shouldAllowPreviewReadFallback(
    callGraphHint: CallGraphHint,
    hasOpenSymbol: boolean,
): boolean {
    if (callGraphHint.supported || hasOpenSymbol) {
        return false;
    }

    return callGraphHint.reason === "missing_symbol" || callGraphHint.reason === "stale_symbol_ref";
}

export function buildNavigationFallback(
    codebaseRoot: string,
    relativeFilePath: string,
    previewSpan: SearchSpan,
    callGraphHint: CallGraphHint,
    sidecarReadyForOutline: boolean,
    allowPreviewReadFallback: boolean,
    helpers: SearchNavigationHelpers,
): SearchGroupResult["navigationFallback"] | undefined {
    if (callGraphHint.supported || !allowPreviewReadFallback) {
        return undefined;
    }

    const normalizedFile = helpers.sanitizeIndexedRelativeFilePath(relativeFilePath);
    if (!normalizedFile) {
        return undefined;
    }

    const safeStartLine = Number.isFinite(previewSpan.startLine) ? Math.max(1, Number(previewSpan.startLine)) : 1;
    const safeEndLine = Number.isFinite(previewSpan.endLine) ? Math.max(safeStartLine, Number(previewSpan.endLine)) : safeStartLine;
    const absolutePath = path.resolve(codebaseRoot, normalizedFile);

    const fallback: SearchGroupResult["navigationFallback"] = {
        message: NAVIGATION_FALLBACK_MESSAGE,
        context: {
            codebaseRoot,
            relativeFile: normalizedFile,
        },
        readSpan: {
            tool: "read_file",
            args: {
                path: absolutePath,
                start_line: safeStartLine,
                end_line: safeEndLine,
            },
        },
    };

    if (sidecarReadyForOutline && helpers.getOutlineStatusForLanguage(normalizedFile) === "ok") {
        fallback.fileOutlineWindow = {
            tool: "file_outline",
            args: {
                path: codebaseRoot,
                file: normalizedFile,
                start_line: safeStartLine,
                end_line: safeEndLine,
                resolveMode: "outline",
            },
        };
    }

    return fallback;
}

export function buildSearchNextActions(
    codebaseRoot: string,
    relativeFilePath: string,
    span: SearchSpan,
    callGraphHint: CallGraphHint,
    sidecarReadyForOutline: boolean,
    registrySymbol: SymbolRecord | undefined,
    helpers: SearchNavigationHelpers,
): SearchGroupResult["nextActions"] | undefined {
    const openSymbol = buildSearchOpenSymbolAction(codebaseRoot, registrySymbol, helpers);
    const nextActions: NonNullable<SearchGroupResult["nextActions"]> = {};
    if (openSymbol) {
        nextActions.openSymbol = openSymbol;
    }

    if (!callGraphHint.supported) {
        return Object.keys(nextActions).length > 0 ? nextActions : undefined;
    }

    const normalizedFile = helpers.sanitizeIndexedRelativeFilePath(callGraphHint.symbolRef.file || relativeFilePath);
    if (!normalizedFile) {
        return Object.keys(nextActions).length > 0 ? nextActions : undefined;
    }

    const actionSpan = callGraphHint.symbolRef.span || span;
    const safeStartLine = Number.isFinite(actionSpan.startLine) ? Math.max(1, Number(actionSpan.startLine)) : 1;
    const safeEndLine = Number.isFinite(actionSpan.endLine) ? Math.max(safeStartLine, Number(actionSpan.endLine)) : safeStartLine;
    const symbolRef = {
        ...callGraphHint.symbolRef,
        file: normalizedFile,
        span: {
            startLine: safeStartLine,
            endLine: safeEndLine,
        },
    };

    nextActions.callGraph = {
        tool: "call_graph",
        args: {
            path: codebaseRoot,
            symbolRef,
            depth: 1,
            limit: 20,
        },
        directions: ["callers", "callees"],
    };

    if (openSymbol && sidecarReadyForOutline && helpers.getOutlineStatusForLanguage(normalizedFile) === "ok") {
        nextActions.outlineWindow = {
            tool: "file_outline",
            args: {
                path: codebaseRoot,
                file: normalizedFile,
                start_line: safeStartLine,
                end_line: safeEndLine,
                resolveMode: "outline",
            },
        };
    }

    return Object.keys(nextActions).length > 0 ? nextActions : undefined;
}
