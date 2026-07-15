import type { SymbolRecord } from "@zokizuan/satori-core";
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

    const candidates = (input.registry.get(symbol.parentKey) || [])
        .filter((candidate) => candidate.symbolInstanceId !== symbol.symbolInstanceId);
    if (candidates.length === 0) {
        return { state: "missing" };
    }
    if (candidates.length > 1) {
        return { state: "ambiguous" };
    }
    return {
        state: "resolved",
        parentSymbolId: candidates[0].symbolInstanceId,
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
