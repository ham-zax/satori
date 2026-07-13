import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";

export type ExactRegistryLookupStatus = "hit" | "miss" | "ambiguous" | "not_applicable";
export type ExactRegistryLookupCandidateSet = "path_exact_file" | "registry_all";
export type ExactRegistryLookupReason =
    | "symbol_instance_id"
    | "symbol_name"
    | "qualified_name"
    | "normalized_identity"
    | "label"
    | "registry_unavailable"
    | "navigation_unavailable"
    | "not_identifier_like"
    | "quoted_literal"
    | "no_match"
    | "ambiguous";

export interface ExactRegistryLookupOperators {
    lang: string[];
    path: string[];
    excludePath: string[];
    must: string[];
    exclude: string[];
}

export interface ExactRegistryLookupInput {
    registry: SymbolRegistry;
    semanticQuery: string;
    intent: "identifier" | "semantic" | "mixed" | "uncertain";
    lexicalTerms: string[];
    quotedLiteralPhrases: string[];
    operators: Pick<ExactRegistryLookupOperators, "path">;
    filterSymbol: (symbol: SymbolRecord) => boolean;
}

export interface ExactRegistryLookupDebug {
    attempted: boolean;
    status: ExactRegistryLookupStatus;
    reason: ExactRegistryLookupReason;
    candidateSet?: ExactRegistryLookupCandidateSet;
    inspectedSymbolCount: number;
    filteredSymbolCount: number;
    ambiguousCount?: number;
    matchedSymbolInstanceId?: string;
    registryUnavailableReason?: string;
}

export type ExactRegistryLookupResult =
    | {
        status: "hit";
        symbol: SymbolRecord;
        reason: ExactRegistryLookupReason;
        candidateSet: ExactRegistryLookupCandidateSet;
        debug: ExactRegistryLookupDebug;
    }
    | {
        status: Exclude<ExactRegistryLookupStatus, "hit">;
        reason: ExactRegistryLookupReason;
        candidateSet?: ExactRegistryLookupCandidateSet;
        debug: ExactRegistryLookupDebug;
    };

type MatchTier = {
    reason: ExactRegistryLookupReason;
    symbols: SymbolRecord[];
};

const IDENTIFIER_QUERY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:[.#:/-]|::)[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const SYMBOL_INSTANCE_ID_PATTERN = /^syminst_[a-f0-9]{32}$/i;
const EXACT_LABEL_QUERY_PATTERN = /^(?:async\s+)?(?:function|method|class|interface|type|enum|struct|def|constructor)\b.+/i;
const QUALIFIED_IDENTIFIER_PATTERN = /(?:\.|::|#|\/)/;
const STRONG_IDENTIFIER_TOKEN_PATTERN = /^(?:[A-Za-z_$][A-Za-z0-9_$]*_[A-Za-z0-9_$]+|[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*|[A-Z][A-Za-z0-9_$]{1,})$/;

function normalizeRelativePath(relativePath: string): string | null {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!normalized || normalized === ".") {
        return null;
    }
    if (normalized.startsWith("..") || normalized.includes("/../") || normalized.startsWith("/")) {
        return null;
    }
    return normalized;
}

function isExactPathFilter(pattern: string): boolean {
    return !/[!*?[\]{}]/.test(pattern) && !pattern.endsWith("/");
}

function splitIdentifierTokens(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.toLowerCase())
        .filter(Boolean);
}

function normalizedIdentifierIdentity(value: string): string {
    return splitIdentifierTokens(value).join(" ");
}

function lastQualifiedSegment(value: string): string {
    const parts = value.split(/[.#:/]+|::/).filter(Boolean);
    return parts[parts.length - 1] || value;
}

function isStrongExactIdentifierQuery(query: string): boolean {
    return SYMBOL_INSTANCE_ID_PATTERN.test(query)
        || QUALIFIED_IDENTIFIER_PATTERN.test(query)
        || STRONG_IDENTIFIER_TOKEN_PATTERN.test(query);
}

function isIdentifierLikeQuery(query: string, input: ExactRegistryLookupInput): boolean {
    if (query.length === 0) {
        return false;
    }
    if (isStrongExactIdentifierQuery(query)) {
        return true;
    }
    if (EXACT_LABEL_QUERY_PATTERN.test(query)) {
        return true;
    }
    if (input.operators.path.length > 0 && IDENTIFIER_QUERY_PATTERN.test(query)) {
        return true;
    }
    if (input.intent === "identifier" && input.lexicalTerms.some(isStrongExactIdentifierQuery)) {
        return true;
    }
    return false;
}

export function shouldAttemptExactRegistryLookup(input: {
    semanticQuery: string;
    intent: ExactRegistryLookupInput["intent"];
    lexicalTerms: string[];
    quotedLiteralPhrases: string[];
    hasExactPathFilter: boolean;
}): boolean {
    const query = input.semanticQuery.trim();
    if (input.quotedLiteralPhrases.length > 0) {
        return false;
    }
    if (query.length === 0) {
        return false;
    }
    if (isStrongExactIdentifierQuery(query)) {
        return true;
    }
    if (EXACT_LABEL_QUERY_PATTERN.test(query)) {
        return true;
    }
    if (input.hasExactPathFilter && IDENTIFIER_QUERY_PATTERN.test(query)) {
        return true;
    }
    return input.intent === "identifier" && input.lexicalTerms.some(isStrongExactIdentifierQuery);
}

function uniqueByInstanceId(symbols: SymbolRecord[]): SymbolRecord[] {
    const seen = new Set<string>();
    const unique: SymbolRecord[] = [];
    for (const symbol of symbols) {
        if (seen.has(symbol.symbolInstanceId)) {
            continue;
        }
        seen.add(symbol.symbolInstanceId);
        unique.push(symbol);
    }
    return unique;
}

function sortSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
    return [...symbols].sort((a, b) => {
        const fileCmp = a.file.localeCompare(b.file);
        if (fileCmp !== 0) return fileCmp;
        const startCmp = a.span.startLine - b.span.startLine;
        if (startCmp !== 0) return startCmp;
        const endCmp = a.span.endLine - b.span.endLine;
        if (endCmp !== 0) return endCmp;
        const labelCmp = a.label.localeCompare(b.label);
        if (labelCmp !== 0) return labelCmp;
        return a.symbolInstanceId.localeCompare(b.symbolInstanceId);
    });
}

function exactPathScopedSymbols(input: ExactRegistryLookupInput): {
    symbols: SymbolRecord[];
    candidateSet: ExactRegistryLookupCandidateSet;
} {
    const exactPaths = input.operators.path
        .map((pattern) => normalizeRelativePath(pattern))
        .filter((pattern): pattern is string => Boolean(pattern && isExactPathFilter(pattern)));

    if (exactPaths.length === 0) {
        return {
            symbols: input.registry.symbols,
            candidateSet: "registry_all",
        };
    }

    const scoped: SymbolRecord[] = [];
    for (const exactPath of exactPaths) {
        scoped.push(...(input.registry.symbolsByFile.get(exactPath) || []));
    }
    return {
        symbols: uniqueByInstanceId(scoped),
        candidateSet: "path_exact_file",
    };
}

function applyDeterministicFilters(symbols: SymbolRecord[], input: ExactRegistryLookupInput): SymbolRecord[] {
    return symbols.filter(input.filterSymbol);
}

function exactMatchTiers(query: string, symbols: SymbolRecord[]): MatchTier[] {
    const queryLower = query.toLowerCase();
    const queryIdentity = normalizedIdentifierIdentity(query);
    const executableSymbols = symbols.filter((symbol) => symbol.kind !== "file");
    const exactName = executableSymbols.filter((symbol) => symbol.name === query);
    const exactQualifiedName = executableSymbols.filter((symbol) => symbol.qualifiedName === query);
    const normalizedIdentity = executableSymbols.filter((symbol) => {
        if (!queryIdentity) {
            return false;
        }
        return normalizedIdentifierIdentity(symbol.name) === queryIdentity
            || normalizedIdentifierIdentity(lastQualifiedSegment(symbol.qualifiedName)) === queryIdentity;
    });
    const exactLabel = executableSymbols.filter((symbol) => symbol.label.toLowerCase() === queryLower);

    return [
        { reason: "symbol_name", symbols: exactName },
        { reason: "qualified_name", symbols: exactQualifiedName },
        { reason: "normalized_identity", symbols: normalizedIdentity },
        { reason: "label", symbols: exactLabel },
    ];
}

export function findExactRegistryMatch(input: ExactRegistryLookupInput): ExactRegistryLookupResult {
    const query = input.semanticQuery.trim();
    const baseDebug = (status: ExactRegistryLookupStatus, reason: ExactRegistryLookupReason, extra: Partial<ExactRegistryLookupDebug> = {}): ExactRegistryLookupDebug => ({
        attempted: status !== "not_applicable",
        status,
        reason,
        inspectedSymbolCount: 0,
        filteredSymbolCount: 0,
        ...extra,
    });

    if (input.quotedLiteralPhrases.length > 0) {
        return {
            status: "not_applicable",
            reason: "quoted_literal",
            debug: baseDebug("not_applicable", "quoted_literal"),
        };
    }

    const symbolIdMatch = query.length > 0
        ? input.registry.symbolsByInstanceId.get(query)
        : undefined;
    if (symbolIdMatch) {
        const filtered = applyDeterministicFilters([symbolIdMatch], input);
        if (filtered.length === 1) {
            return {
                status: "hit",
                symbol: filtered[0],
                reason: "symbol_instance_id",
                candidateSet: "registry_all",
                debug: baseDebug("hit", "symbol_instance_id", {
                    candidateSet: "registry_all",
                    inspectedSymbolCount: 1,
                    filteredSymbolCount: 1,
                    matchedSymbolInstanceId: filtered[0].symbolInstanceId,
                }),
            };
        }
        return {
            status: "miss",
            reason: "no_match",
            candidateSet: "registry_all",
            debug: baseDebug("miss", "no_match", {
                candidateSet: "registry_all",
                inspectedSymbolCount: 1,
                filteredSymbolCount: 0,
            }),
        };
    }

    if (!isIdentifierLikeQuery(query, input)) {
        return {
            status: "not_applicable",
            reason: "not_identifier_like",
            debug: baseDebug("not_applicable", "not_identifier_like"),
        };
    }

    const scoped = exactPathScopedSymbols(input);
    const filteredSymbols = applyDeterministicFilters(scoped.symbols, input);
    const debugBase = {
        candidateSet: scoped.candidateSet,
        inspectedSymbolCount: scoped.symbols.length,
        filteredSymbolCount: filteredSymbols.length,
    };

    for (const tier of exactMatchTiers(query, filteredSymbols)) {
        const matches = sortSymbols(uniqueByInstanceId(tier.symbols));
        if (matches.length === 1) {
            return {
                status: "hit",
                symbol: matches[0],
                reason: tier.reason,
                candidateSet: scoped.candidateSet,
                debug: baseDebug("hit", tier.reason, {
                    ...debugBase,
                    matchedSymbolInstanceId: matches[0].symbolInstanceId,
                }),
            };
        }
        if (matches.length > 1) {
            return {
                status: "ambiguous",
                reason: "ambiguous",
                candidateSet: scoped.candidateSet,
                debug: baseDebug("ambiguous", "ambiguous", {
                    ...debugBase,
                    ambiguousCount: matches.length,
                }),
            };
        }
    }

    return {
        status: "miss",
        reason: "no_match",
        candidateSet: scoped.candidateSet,
        debug: baseDebug("miss", "no_match", debugBase),
    };
}
