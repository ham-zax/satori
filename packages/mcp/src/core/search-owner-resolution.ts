import {
    resolveOwnerSymbolForChunk,
    type CodeChunk,
    type SemanticSearchResult,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";

export type SearchOwnerResolutionLexicalTerm = {
    value: string;
    kind: "whole" | "fragment";
};

export type SearchOwnerResolutionResult = {
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    symbolKind?: string;
    ownerSource?: "owner_metadata" | "registry_repair";
    ownerProof?: {
        symbolInstanceId: string;
        basis: "bytes" | "lines";
    };
};

export type SearchOwnerResolutionInputResult = Partial<SemanticSearchResult> & {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    startByte?: unknown;
    endByte?: unknown;
};

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

function buildSearchOwnerChunk(result: SearchOwnerResolutionInputResult): CodeChunk | null {
    const startLine = Number(result?.startLine);
    const endLine = Number(result?.endLine);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return null;
    }

    const hasStartByte = result.startByte !== undefined;
    const hasEndByte = result.endByte !== undefined;
    if (hasStartByte || hasEndByte) {
        if (
            !Number.isSafeInteger(result.startByte)
            || !Number.isSafeInteger(result.endByte)
            || Number(result.startByte) < 0
            || Number(result.endByte) < Number(result.startByte)
        ) {
            return null;
        }
    }

    const metadata: CodeChunk["metadata"] = {
        startLine: Math.max(1, startLine),
        endLine: Math.max(Math.max(1, startLine), endLine),
        language: typeof result?.language === "string" ? result.language : undefined,
        filePath: typeof result?.relativePath === "string" ? result.relativePath : undefined,
        symbolId: typeof result?.symbolId === "string" ? result.symbolId : undefined,
        symbolLabel: typeof result?.symbolLabel === "string" ? result.symbolLabel : undefined,
        symbolKind: typeof result?.symbolKind === "string" ? result.symbolKind : undefined,
    };
    if (hasStartByte) {
        metadata.startByte = Number(result.startByte);
    }
    if (hasEndByte) {
        metadata.endByte = Number(result.endByte);
    }

    return {
        content: String(result?.content || ""),
        metadata,
    };
}

type SearchChunkContainment = "contains" | "not_contained" | "invalid_byte_evidence";

function resolveSearchChunkContainment(symbol: SymbolRecord, chunk: CodeChunk): SearchChunkContainment {
    const chunkStartByte = chunk.metadata.startByte;
    const chunkEndByte = chunk.metadata.endByte;
    const symbolStartByte = symbol.span.startByte;
    const symbolEndByte = symbol.span.endByte;
    const byteValues = [chunkStartByte, chunkEndByte, symbolStartByte, symbolEndByte];
    if (byteValues.some((value) => value !== undefined)) {
        if (
            !byteValues.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
            || Number(chunkEndByte) < Number(chunkStartByte)
            || Number(symbolEndByte) < Number(symbolStartByte)
        ) {
            return "invalid_byte_evidence";
        }
        return Number(symbolStartByte) <= Number(chunkStartByte)
            && Number(chunkEndByte) <= Number(symbolEndByte)
            ? "contains"
            : "not_contained";
    }
    return symbol.span.startLine <= chunk.metadata.startLine
        && chunk.metadata.endLine <= symbol.span.endLine
        ? "contains"
        : "not_contained";
}

function buildSearchOwnerProof(symbol: SymbolRecord, chunk: CodeChunk): SearchOwnerResolutionResult["ownerProof"] {
    if (resolveSearchChunkContainment(symbol, chunk) !== "contains") return undefined;
    return {
        symbolInstanceId: symbol.symbolInstanceId,
        basis: chunk.metadata.startByte !== undefined ? "bytes" : "lines",
    };
}

function resolveSafeSearchOwnerSymbolForChunk(
    chunk: CodeChunk,
    symbols: SymbolRecord[],
): SymbolRecord | undefined {
    const fileOwner = symbols.find((symbol) => symbol.kind === "file");
    if (!fileOwner || resolveSearchChunkContainment(fileOwner, chunk) !== "contains") {
        return undefined;
    }
    const containedSymbols = symbols.filter((symbol) => (
        symbol.kind !== "file"
        && resolveSearchChunkContainment(symbol, chunk) === "contains"
    ));
    return resolveOwnerSymbolForChunk({ chunk, symbols: [fileOwner, ...containedSymbols] });
}

function resolveBestOverlappingSearchSymbol(input: {
    fileSymbols: SymbolRecord[];
    ownerChunk: CodeChunk;
    lexicalTerms: SearchOwnerResolutionLexicalTerm[];
    hasTokenBoundaryMatch: (haystack: string, needle: string) => boolean;
    isWriterActionTerm: (value: string) => boolean;
}): SymbolRecord | undefined {
    const chunkStart = Math.max(1, Number(input.ownerChunk.metadata.startLine || 1));
    const chunkLines = input.ownerChunk.content.split(/\r?\n/);
    const normalizeSymbolEvidence = (value: string): string => value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[/\\._:-]+/g, " ")
        .toLowerCase();
    const scored = input.fileSymbols
        .filter((symbol) => symbol.kind !== "file")
        .filter((symbol) => resolveSearchChunkContainment(symbol, input.ownerChunk) === "contains")
        .map((symbol) => {
            const symbolName = normalizeSymbolEvidence(symbol.name);
            const symbolIdentityEvidence = normalizeSymbolEvidence([
                symbol.name,
                symbol.qualifiedName,
                symbol.label,
            ].join("\n"));
            const symbolParentEvidence = normalizeSymbolEvidence(symbol.parentQualifiedNamePath.join("\n"));
            const symbolRelativeStart = Math.max(0, symbol.span.startLine - chunkStart);
            const symbolRelativeEnd = Math.max(symbolRelativeStart, symbol.span.endLine - chunkStart);
            const symbolContent = chunkLines
                .slice(symbolRelativeStart, symbolRelativeEnd + 1)
                .join("\n")
                .toLowerCase();
            const matchedDomainTerms = new Set<string>();
            let symbolNameMatches = 0;
            let identityMatches = 0;
            let contentMatches = 0;
            let strongIdentifierMatches = 0;
            for (const term of input.lexicalTerms) {
                if (term.kind !== "whole" || input.isWriterActionTerm(term.value)) {
                    continue;
                }
                const nameMatch = input.hasTokenBoundaryMatch(symbolName, term.value);
                const identityMatch = input.hasTokenBoundaryMatch(symbolIdentityEvidence, term.value);
                const parentMatch = input.hasTokenBoundaryMatch(symbolParentEvidence, term.value);
                const contentMatch = input.hasTokenBoundaryMatch(symbolContent, term.value);
                if (nameMatch) {
                    symbolNameMatches += 1;
                }
                if (identityMatch || parentMatch) {
                    identityMatches += 1;
                }
                if (contentMatch) {
                    contentMatches += 1;
                }
                if (identityMatch || parentMatch || contentMatch) {
                    matchedDomainTerms.add(term.value);
                }
                if (identityMatch && /[_/\\.:]/.test(term.value)) {
                    strongIdentifierMatches += 1;
                }
            }
            return {
                symbol,
                lexicalMatches: matchedDomainTerms.size,
                symbolNameMatches,
                identityMatches,
                contentMatches,
                strongIdentifierMatches,
            };
        })
        .filter((entry) => (
            entry.lexicalMatches >= 2
            || entry.symbolNameMatches > 0
            || entry.strongIdentifierMatches > 0
        ))
        .sort((a, b) => {
            if (b.lexicalMatches !== a.lexicalMatches) return b.lexicalMatches - a.lexicalMatches;
            if (b.symbolNameMatches !== a.symbolNameMatches) return b.symbolNameMatches - a.symbolNameMatches;
            if (b.identityMatches !== a.identityMatches) return b.identityMatches - a.identityMatches;
            if (b.strongIdentifierMatches !== a.strongIdentifierMatches) return b.strongIdentifierMatches - a.strongIdentifierMatches;
            if (b.contentMatches !== a.contentMatches) return b.contentMatches - a.contentMatches;
            const aLines = a.symbol.span.endLine - a.symbol.span.startLine;
            const bLines = b.symbol.span.endLine - b.symbol.span.startLine;
            if (aLines !== bLines) return aLines - bLines;
            const aDepth = a.symbol.parentQualifiedNamePath.length;
            const bDepth = b.symbol.parentQualifiedNamePath.length;
            if (aDepth !== bDepth) return bDepth - aDepth;
            const startCmp = compareNullableNumbersAsc(a.symbol.span.startLine, b.symbol.span.startLine);
            if (startCmp !== 0) return startCmp;
            return compareNullableStringsAsc(a.symbol.symbolInstanceId, b.symbol.symbolInstanceId);
        });

    const [best, second] = scored;
    if (best && second
        && best.lexicalMatches === second.lexicalMatches
        && best.symbolNameMatches === second.symbolNameMatches
        && best.identityMatches === second.identityMatches
        && best.strongIdentifierMatches === second.strongIdentifierMatches
        && best.contentMatches === second.contentMatches) {
        return undefined;
    }
    return scored[0]?.symbol;
}

export function resolveSearchOwnerFromRegistry(input: {
    result: SearchOwnerResolutionInputResult;
    registry?: SymbolRegistry;
    lexicalTerms?: SearchOwnerResolutionLexicalTerm[];
    sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => string | undefined;
    hasTokenBoundaryMatch: (haystack: string, needle: string) => boolean;
    isWriterActionTerm: (value: string) => boolean;
}): SearchOwnerResolutionResult {
    const metadataOwnerKey = typeof input.result?.ownerSymbolKey === "string" && input.result.ownerSymbolKey.length > 0
        ? input.result.ownerSymbolKey
        : undefined;
    const metadataOwnerInstanceId = typeof input.result?.ownerSymbolInstanceId === "string" && input.result.ownerSymbolInstanceId.length > 0
        ? input.result.ownerSymbolInstanceId
        : undefined;
    const metadataSymbolKind = typeof input.result?.symbolKind === "string" && input.result.symbolKind.length > 0
        ? input.result.symbolKind
        : undefined;

    if (!input.registry) {
        return metadataOwnerKey
            ? {
                ownerSymbolKey: metadataOwnerKey,
                ownerSymbolInstanceId: metadataOwnerInstanceId,
                symbolKind: metadataSymbolKind,
                ownerSource: "owner_metadata",
            }
            : {};
    }

    const normalizedFile = typeof input.result?.relativePath === "string"
        ? input.sanitizeIndexedRelativeFilePath(input.result.relativePath)
        : undefined;
    const fileSymbols = normalizedFile ? input.registry.symbolsByFile.get(normalizedFile) : undefined;
    const ownerChunk = buildSearchOwnerChunk(input.result);
    let metadataIdentityRejected = false;

    if (
        metadataOwnerKey
        && metadataOwnerInstanceId
        && input.registry.symbolsByInstanceId.has(metadataOwnerInstanceId)
    ) {
        const owner = input.registry.symbolsByInstanceId.get(metadataOwnerInstanceId);
        const ownerFile = owner
            ? input.sanitizeIndexedRelativeFilePath(owner.file)
            : undefined;
        const ownerContainment = owner && ownerChunk
            ? resolveSearchChunkContainment(owner, ownerChunk)
            : "not_contained";
        if (ownerContainment === "invalid_byte_evidence") {
            return {};
        }
        const ownerContainsEvidence = Boolean(
            owner
            && ownerFile
            && normalizedFile
            && ownerFile === normalizedFile
            && ownerContainment === "contains"
        );
        if (!ownerContainsEvidence) {
            metadataIdentityRejected = true;
        } else {
            if (owner?.kind === "file" && fileSymbols && ownerChunk && input.lexicalTerms) {
                const tighterOwner = resolveBestOverlappingSearchSymbol({
                    fileSymbols,
                    ownerChunk,
                    lexicalTerms: input.lexicalTerms,
                    hasTokenBoundaryMatch: input.hasTokenBoundaryMatch,
                    isWriterActionTerm: input.isWriterActionTerm,
                });
                if (tighterOwner && tighterOwner.symbolInstanceId !== metadataOwnerInstanceId) {
                    return {
                        ownerSymbolKey: tighterOwner.symbolKey,
                        ownerSymbolInstanceId: tighterOwner.symbolInstanceId,
                        symbolKind: tighterOwner.kind,
                        ownerSource: "registry_repair",
                        ownerProof: buildSearchOwnerProof(tighterOwner, ownerChunk),
                    };
                }
            }
            return {
                ownerSymbolKey: metadataOwnerKey,
                ownerSymbolInstanceId: metadataOwnerInstanceId,
                symbolKind: owner?.kind || metadataSymbolKind,
                ownerSource: "owner_metadata",
                ownerProof: owner && ownerChunk ? buildSearchOwnerProof(owner, ownerChunk) : undefined,
            };
        }
    }

    if (fileSymbols && ownerChunk) {
        try {
            if (input.lexicalTerms) {
                const overlappingOwner = resolveBestOverlappingSearchSymbol({
                    fileSymbols,
                    ownerChunk,
                    lexicalTerms: input.lexicalTerms,
                    hasTokenBoundaryMatch: input.hasTokenBoundaryMatch,
                    isWriterActionTerm: input.isWriterActionTerm,
                });
                if (overlappingOwner) {
                    return {
                        ownerSymbolKey: overlappingOwner.symbolKey,
                        ownerSymbolInstanceId: overlappingOwner.symbolInstanceId,
                        symbolKind: overlappingOwner.kind,
                        ownerSource: "registry_repair",
                        ownerProof: buildSearchOwnerProof(overlappingOwner, ownerChunk),
                    };
                }
            }
            if (metadataOwnerKey) {
                const keyCandidates = fileSymbols.filter((symbol) => symbol.symbolKey === metadataOwnerKey);
                if (keyCandidates.length > 0) {
                    const owner = resolveSafeSearchOwnerSymbolForChunk(
                        ownerChunk,
                        keyCandidates.some((symbol) => symbol.kind === "file") ? keyCandidates : [
                            ...fileSymbols.filter((symbol) => symbol.kind === "file"),
                            ...keyCandidates,
                        ],
                    );
                    if (owner?.symbolKey === metadataOwnerKey) {
                        return {
                            ownerSymbolKey: owner.symbolKey,
                            ownerSymbolInstanceId: owner.symbolInstanceId,
                            symbolKind: owner.kind,
                            ownerSource: "registry_repair",
                            ownerProof: buildSearchOwnerProof(owner, ownerChunk),
                        };
                    }
                }
            }

            const owner = resolveSafeSearchOwnerSymbolForChunk(ownerChunk, fileSymbols);
            if (!owner) {
                return {};
            }
            return {
                ownerSymbolKey: owner.symbolKey,
                ownerSymbolInstanceId: owner.symbolInstanceId,
                symbolKind: owner.kind,
                ownerSource: "registry_repair",
                ownerProof: buildSearchOwnerProof(owner, ownerChunk),
            };
        } catch {
            // Registry repair is a compatibility aid; fallback paths below preserve search usability.
        }
    }

    return metadataOwnerKey && !metadataIdentityRejected
        ? {
            ownerSymbolKey: metadataOwnerKey,
            ownerSymbolInstanceId: metadataOwnerInstanceId,
            symbolKind: metadataSymbolKind,
            ownerSource: "owner_metadata",
        }
        : {};
}
