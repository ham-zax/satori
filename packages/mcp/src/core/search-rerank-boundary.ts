export type RerankBoundaryDecision =
    | { kind: "skip"; reason: "sole_exact_result" }
    | { kind: "rerank"; startIndex: 0 | 1; reason: "full_set" | "exact_prefix" };

export function resolveRerankBoundary(input: {
    candidates: ReadonlyArray<{
        exactLexicalMatch: boolean;
        passesMatchedMust: boolean;
    }>;
    exactMatchPinningEnabled: boolean;
    mustTokenCount: number;
    /**
     * True when the caller's identifier-shaped alt_terms name the symbol
     * declared by the first-stage #1 candidate. That candidate is the exact
     * owner even when lexical pinning is disabled for the query.
     */
    altTermsNameTopOwner?: boolean;
}): RerankBoundaryDecision {
    if (input.candidates.length === 0) {
        return { kind: "rerank", startIndex: 0, reason: "full_set" };
    }

    const top = input.candidates[0]!;
    const exactOwner = (top.exactLexicalMatch
        && (
            input.exactMatchPinningEnabled
            || (input.mustTokenCount > 0 && top.passesMatchedMust)
        ))
        || input.altTermsNameTopOwner === true;
    if (input.candidates.length === 1 && top.exactLexicalMatch) {
        return { kind: "skip", reason: "sole_exact_result" };
    }
    if (exactOwner) {
        return { kind: "rerank", startIndex: 1, reason: "exact_prefix" };
    }
    return { kind: "rerank", startIndex: 0, reason: "full_set" };
}
