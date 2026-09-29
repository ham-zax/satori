import type { SymbolRecord } from "@satori-code/core";
import type {
    CanonicalSymbolIdentity,
    SymbolParentResolution,
} from "./search-types.js";

export type CanonicalSymbolRegistryView = ReadonlyMap<string, readonly SymbolRecord[]>;

export function buildCanonicalSymbolRegistryView(
    symbols: readonly SymbolRecord[],
): CanonicalSymbolRegistryView {
    const symbolsByKey = new Map<string, readonly SymbolRecord[]>();
    for (const symbol of symbols) {
        symbolsByKey.set(symbol.symbolKey, [
            ...(symbolsByKey.get(symbol.symbolKey) || []),
            symbol,
        ]);
    }
    return symbolsByKey;
}

function spanContains(parent: SymbolRecord, child: SymbolRecord): boolean {
    if (parent.file !== child.file) {
        return false;
    }
    if (
        parent.span.startByte !== undefined
        && parent.span.endByte !== undefined
        && child.span.startByte !== undefined
        && child.span.endByte !== undefined
    ) {
        return parent.span.startByte <= child.span.startByte
            && child.span.endByte <= parent.span.endByte;
    }
    return parent.span.startLine <= child.span.startLine
        && child.span.endLine <= parent.span.endLine;
}

function spanSize(symbol: SymbolRecord, useBytes: boolean): number {
    return useBytes
        ? Math.max(0, symbol.span.endByte! - symbol.span.startByte!)
        : Math.max(0, symbol.span.endLine - symbol.span.startLine);
}

function resolveParent(input: {
    symbol: SymbolRecord;
    registry: CanonicalSymbolRegistryView;
}): {
    state: SymbolParentResolution;
    parentSymbolId?: string;
} {
    const { symbol } = input;
    if (!symbol.parentKey) {
        return {
            state: symbol.parentQualifiedNamePath.length === 0
                ? "not_applicable"
                : "missing",
        };
    }

    const containingCandidates = (input.registry.get(symbol.parentKey) || [])
        .filter((candidate) => (
            candidate.symbolInstanceId !== symbol.symbolInstanceId
            && spanContains(candidate, symbol)
        ));
    if (containingCandidates.length === 0) {
        return { state: "missing" };
    }
    const byteCandidates = containingCandidates.filter((candidate) => (
        candidate.span.startByte !== undefined
        && candidate.span.endByte !== undefined
        && symbol.span.startByte !== undefined
        && symbol.span.endByte !== undefined
    ));
    const candidates = byteCandidates.length > 0 ? byteCandidates : containingCandidates;
    const useBytes = byteCandidates.length > 0;
    const innermostSize = Math.min(...candidates.map((candidate) => spanSize(candidate, useBytes)));
    const innermost = candidates.filter((candidate) => spanSize(candidate, useBytes) === innermostSize);
    if (innermost.length !== 1) {
        return { state: "ambiguous" };
    }
    return {
        state: "resolved",
        parentSymbolId: innermost[0].symbolInstanceId,
    };
}

export function projectCanonicalSymbolIdentity(input: {
    symbol: SymbolRecord;
    registry: CanonicalSymbolRegistryView;
}): CanonicalSymbolIdentity {
    const { symbol } = input;
    const parent = resolveParent(input);
    return {
        symbolId: symbol.symbolInstanceId,
        symbolKey: symbol.symbolKey,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        symbolLabel: symbol.label,
        kind: symbol.kind,
        language: symbol.language,
        file: symbol.file,
        span: { ...symbol.span },
        parentQualifiedNamePath: [...symbol.parentQualifiedNamePath],
        parentResolution: parent.state,
        ...(symbol.parentKey ? { parentKey: symbol.parentKey } : {}),
        ...(parent.parentSymbolId ? { parentSymbolId: parent.parentSymbolId } : {}),
        ...(symbol.exported !== undefined ? { exported: symbol.exported } : {}),
        ...(symbol.ontologyTags !== undefined ? { ontologyTags: [...symbol.ontologyTags] } : {}),
    };
}
