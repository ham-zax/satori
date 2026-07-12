import type { SymbolRecord } from "@zokizuan/satori-core";
import type {
    CallGraphHint,
    FileOutlineStatus,
    SearchSpan,
} from "./search-types.js";

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

    // Chunk metadata can carry stale or ambiguous IDs. Grouped navigation is
    // published only from a concrete symbol resolved in the current registry.
    return {
        supported: false,
        reason: input.registryUnavailableReason
            || (input.registryLoaded ? "stale_symbol_ref" : "missing_symbol_registry"),
    };
}
