import type { SemanticSearchResult } from "@zokizuan/satori-core";

export type SearchQueryIntent = "identifier" | "semantic" | "mixed" | "uncertain";
export type SearchIntentConfidence = "high" | "medium" | "low";
export type SearchLexicalTermKind = "whole" | "fragment";
export type SearchReferenceDirection = "callers" | "callees" | "both";
export type SearchRouteKind =
    | "exact_identifier"
    | "exact_path"
    | "literal"
    | "configuration"
    | "ownership"
    | "references"
    | "structural"
    | "conceptual"
    | "mixed";
export type SearchRouteReason =
    | "exact_path_operator"
    | "path_shaped_query"
    | "quoted_literal"
    | "configuration_cue"
    | "reference_cue"
    | "ownership_cue"
    | "structural_cue"
    | "identifier_intent"
    | "mixed_intent"
    | "conceptual_intent"
    | "uncertain_fallback";
export type SearchRetrievalSource =
    | "registry"
    | "tracked_lexical"
    | "live_path"
    | "relationships"
    | "dense"
    | "sparse";

export type SearchRouteContract = {
    kind: SearchRouteKind;
    reason: SearchRouteReason;
    deterministicFirst: boolean;
    navigation: "required" | "preferred" | "not_required";
    allowedSources: SearchRetrievalSource[];
    currentProviderBudget: {
        semanticPassesPerAttempt: 1 | 2;
        rerankCalls: 0 | 1;
    };
};

export type SearchLexicalTerm = {
    value: string;
    kind: SearchLexicalTermKind;
};

export type SearchQueryPlan = {
    semanticQuery: string;
    route: SearchRouteContract;
    exactIdentifierTarget?: string;
    referenceDirection?: SearchReferenceDirection;
    intent: SearchQueryIntent;
    confidence: SearchIntentConfidence;
    reasons: string[];
    quotedLiteralPhrases: string[];
    referenceSeeking: boolean;
    testSeeking: boolean;
    documentationSeeking: boolean;
    implementationSeeking: boolean;
    behavioralOwnerSeeking: boolean;
    writerSeeking: boolean;
    entrypointIntent: EntrypointQueryIntent;
    lexicalTerms: SearchLexicalTerm[];
    retrievalMode: "dense" | "lexical" | "hybrid";
    scorePolicyKind: "dense_similarity_min" | "topk_only";
    exactMatchPinningEnabled: boolean;
    rerankAllowed: boolean;
};

export type EntrypointQueryIntentKind =
    | "installed_command_ownership"
    | "application_startup_ownership"
    | "command_declaration"
    | "development_execution"
    | "test_startup"
    | "post_startup_runtime";

export type EntrypointQueryIntent = Readonly<{
    kinds: readonly EntrypointQueryIntentKind[];
    reasons: readonly string[];
}>;

export type SearchExactLexicalEvidence = Readonly<{
    exactLexicalMatch: boolean;
    matchedWholeTerms: readonly string[];
    matchedQuotedPhrases: readonly string[];
}>;

export type SearchLexicalEvidence = SearchExactLexicalEvidence & Readonly<{
    hasLexicalEvidence: boolean;
}>;

export type SearchResultLike = Partial<SemanticSearchResult> & {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    startByte?: unknown;
    endByte?: unknown;
};

function escapeLexicalRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasTokenBoundaryMatch(field: string, term: string): boolean {
    if (!field || !term) {
        return false;
    }

    const pattern = new RegExp(`(^|[^a-z0-9])${escapeLexicalRegex(term)}([^a-z0-9]|$)`, "i");
    return pattern.test(field);
}

function getReferenceUsageKind(content: string, term: string): "executable" | "import" | null {
    if (!content || !term) {
        return null;
    }

    const escaped = escapeLexicalRegex(term);
    const executablePatterns = [
        new RegExp(`\\bnew\\s+${escaped}\\b`, "i"),
        new RegExp(`\\b${escaped}\\s*\\(`, "i"),
        new RegExp(`\\b${escaped}\\b\\s*=`, "i"),
    ];
    if (executablePatterns.some((pattern) => pattern.test(content))) {
        return "executable";
    }

    const importPatterns = [
        new RegExp(`\\bimport\\s+.*\\b${escaped}\\b`, "i"),
        new RegExp(`\\bfrom\\s+.+\\s+import\\s+.*\\b${escaped}\\b`, "i"),
    ];
    return importPatterns.some((pattern) => pattern.test(content)) ? "import" : null;
}

function hasDeclarationMatch(content: string, term: string): boolean {
    if (!content || !term) {
        return false;
    }

    const escaped = escapeLexicalRegex(term);
    const declarationPatterns = [
        new RegExp(`\\bclass\\s+${escaped}\\b`, "i"),
        new RegExp(`\\bdef\\s+${escaped}\\b`, "i"),
        new RegExp(`\\bfunction\\s+${escaped}\\b`, "i"),
        new RegExp(`\\btype\\s+${escaped}\\b`, "i"),
        new RegExp(`\\binterface\\s+${escaped}\\b`, "i"),
        new RegExp(`\\benum\\s+${escaped}\\b`, "i"),
        new RegExp(`\\bstruct\\s+${escaped}\\b`, "i"),
        new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b\\s*=\\s*(?:async\\s+)?function\\b`, "i"),
        new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-z_$][\\w$]*)\\s*=>`, "i"),
    ];

    return declarationPatterns.some((pattern) => pattern.test(content));
}

function hasPathSegmentTokenMatch(pathSegments: string[], term: string): boolean {
    return pathSegments.some((segment) => hasTokenBoundaryMatch(segment, term));
}

function inspectSearchLexicalEvidence(plan: SearchQueryPlan, result: SearchResultLike): SearchLexicalEvidence {
    if (plan.lexicalTerms.length === 0 && plan.quotedLiteralPhrases.length === 0) {
        return {
            hasLexicalEvidence: false,
            exactLexicalMatch: false,
            matchedWholeTerms: [],
            matchedQuotedPhrases: [],
        };
    }

    const relativePath = typeof result?.relativePath === "string" ? result.relativePath.toLowerCase() : "";
    const symbolLabel = typeof result?.symbolLabel === "string" ? result.symbolLabel.toLowerCase() : "";
    const content = typeof result?.content === "string" ? result.content.toLowerCase() : "";
    const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
    const matchedWholeTerms = new Set<string>();
    const matchedQuotedPhrases = new Set<string>();
    let hasLexicalEvidence = false;
    let exactLexicalMatch = false;

    for (const phrase of plan.quotedLiteralPhrases) {
        const normalizedPhrase = phrase.toLowerCase();
        if (!normalizedPhrase) {
            continue;
        }
        if (
            symbolLabel.includes(normalizedPhrase)
            || pathSegments.some((segment) => segment.includes(normalizedPhrase))
            || content.includes(normalizedPhrase)
        ) {
            hasLexicalEvidence = true;
            exactLexicalMatch = true;
            matchedQuotedPhrases.add(phrase);
        }
    }

    for (const term of plan.lexicalTerms) {
        const normalizedTerm = term.value.toLowerCase();
        if (!normalizedTerm) {
            continue;
        }
        const usageKind = plan.referenceSeeking ? getReferenceUsageKind(content, normalizedTerm) : null;
        const declarationMatch = plan.referenceSeeking && hasDeclarationMatch(content, normalizedTerm);
        if (usageKind !== null && !declarationMatch) {
            hasLexicalEvidence = true;
            continue;
        }

        const symbolMatch = hasTokenBoundaryMatch(symbolLabel, normalizedTerm);
        const pathMatch = hasPathSegmentTokenMatch(pathSegments, normalizedTerm);
        const contentMatch = hasTokenBoundaryMatch(content, normalizedTerm);
        const fragmentMatch = symbolLabel.includes(normalizedTerm)
            || relativePath.includes(normalizedTerm)
            || content.includes(normalizedTerm);

        if (symbolMatch || pathMatch || contentMatch || fragmentMatch) {
            hasLexicalEvidence = true;
        }
        if (term.kind === "whole" && (symbolMatch || pathMatch || contentMatch)) {
            matchedWholeTerms.add(term.value);
            if (!plan.referenceSeeking || plan.writerSeeking) {
                exactLexicalMatch = true;
            }
        }
    }

    return {
        hasLexicalEvidence,
        exactLexicalMatch,
        matchedWholeTerms: [...matchedWholeTerms],
        matchedQuotedPhrases: [...matchedQuotedPhrases],
    };
}

export function detectSearchExactLexicalEvidence(
    plan: SearchQueryPlan,
    result: SearchResultLike,
): SearchExactLexicalEvidence {
    const evidence = inspectSearchLexicalEvidence(plan, result);
    return {
        exactLexicalMatch: evidence.exactLexicalMatch,
        matchedWholeTerms: evidence.matchedWholeTerms,
        matchedQuotedPhrases: evidence.matchedQuotedPhrases,
    };
}

export function detectSearchLexicalEvidence(plan: SearchQueryPlan, result: SearchResultLike): SearchLexicalEvidence {
    return inspectSearchLexicalEvidence(plan, result);
}
