export type NativeRetrievalCandidateLike = {
    result: {
        relativePath: string;
        startLine?: number | null;
        symbolLabel?: string | null;
        symbolId?: string | null;
    };
    fusionScore: number;
    passesMatchedMust: boolean;
    exactLexicalMatch: boolean;
    exactMatchPinned: boolean;
};

function compareOrdinal(a?: string | null, b?: string | null): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    return a < b ? -1 : 1;
}

function compareNullableNumbers(a?: number | null, b?: number | null): number {
    const left = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
    const right = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
    return left - right;
}

function compareNativeRetrievalCandidates<T extends NativeRetrievalCandidateLike>(a: T, b: T, options: {
    exactMatchFirst: boolean;
    mustMatchesFirst: boolean;
}): number {
    if (options.mustMatchesFirst && a.passesMatchedMust !== b.passesMatchedMust) {
        return a.passesMatchedMust ? -1 : 1;
    }
    if (options.exactMatchFirst && a.exactLexicalMatch !== b.exactLexicalMatch) {
        return a.exactLexicalMatch ? -1 : 1;
    }
    if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore;
    // Equal RRF ranks tie often (a lexical-only overlay hit vs a dense hit
    // without the term). Lexical evidence decides before path order does.
    if (a.exactLexicalMatch !== b.exactLexicalMatch) {
        return a.exactLexicalMatch ? -1 : 1;
    }
    const pathOrder = compareOrdinal(a.result.relativePath, b.result.relativePath);
    if (pathOrder !== 0) return pathOrder;
    const lineOrder = compareNullableNumbers(a.result.startLine, b.result.startLine);
    if (lineOrder !== 0) return lineOrder;
    const labelOrder = compareOrdinal(a.result.symbolLabel, b.result.symbolLabel);
    if (labelOrder !== 0) return labelOrder;
    return compareOrdinal(a.result.symbolId, b.result.symbolId);
}

export function sortNativeRetrievalCandidates<T extends NativeRetrievalCandidateLike>(
    candidates: T[],
    options: {
        exactMatchFirst: boolean;
        mustMatchesFirst: boolean;
    },
): { exactMatchPinningApplied: boolean } {
    const originalFirst = candidates[0];
    candidates.sort((a, b) => compareNativeRetrievalCandidates(a, b, options));
    return {
        exactMatchPinningApplied: Boolean(
            options.exactMatchFirst
            && candidates.length > 0
            && candidates[0]!.exactLexicalMatch
            && candidates[0] !== originalFirst,
        ),
    };
}
