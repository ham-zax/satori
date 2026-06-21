import type { SemanticSearchResult } from "@zokizuan/satori-core";

const SEARCH_SIBLING_STRUCTURAL_ANCHOR_PENALTY_PRE_WEIGHT_MIXED = 0.80;
const SEARCH_SIBLING_STRUCTURAL_ANCHOR_PENALTY_PRE_WEIGHT_SEMANTIC = 0.55;

export type SearchQueryIntent = "identifier" | "semantic" | "mixed" | "uncertain";
export type SearchIntentConfidence = "high" | "medium" | "low";
export type SearchLexicalTermKind = "whole" | "fragment";

export type SearchLexicalTerm = {
    value: string;
    kind: SearchLexicalTermKind;
};

export type SearchQueryPlan = {
    semanticQuery: string;
    intent: SearchQueryIntent;
    confidence: SearchIntentConfidence;
    reasons: string[];
    quotedLiteralPhrases: string[];
    referenceSeeking: boolean;
    testSeeking: boolean;
    implementationSeeking: boolean;
    writerSeeking: boolean;
    lexicalTerms: SearchLexicalTerm[];
    retrievalMode: "dense" | "lexical" | "hybrid";
    scorePolicyKind: "dense_similarity_min" | "topk_only";
    lexicalWeight: number;
    exactMatchPinningEnabled: boolean;
    rerankAllowed: boolean;
};

export type SearchLexicalEvidence = {
    score: number;
    exactLexicalMatch: boolean;
};

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

function getLexicalTermFactor(plan: SearchQueryPlan, term: SearchLexicalTerm): number {
    if (term.kind === "whole") {
        return 1;
    }
    if (plan.referenceSeeking) {
        return 0.18;
    }
    if (plan.intent === "identifier") {
        return 0.18;
    }
    return 0.35;
}

function isHighSignalStructuralAnchorTerm(term: SearchLexicalTerm): boolean {
    if (term.kind !== "whole") {
        return false;
    }
    return (
        (/[a-z]/.test(term.value) && /\d/.test(term.value))
        || /[_/\\.\-:]/.test(term.value)
    );
}

function extractNormalizedCandidateTokens(fields: string[]): string[] {
    const tokens = new Set<string>();
    for (const field of fields) {
        for (const match of field.toLowerCase().matchAll(/[a-z0-9]+/g)) {
            const token = match[0] || "";
            if (token.length > 0) {
                tokens.add(token);
            }
        }
    }
    return Array.from(tokens.values());
}

function splitStructuralAnchorSegments(value: string): string[] {
    return value.toLowerCase().match(/[a-z]+|\d+/g) || [];
}

function isSiblingStructuralAnchorNearMiss(queryAnchor: string, candidateToken: string): boolean {
    const querySegments = splitStructuralAnchorSegments(queryAnchor);
    const candidateSegments = splitStructuralAnchorSegments(candidateToken);
    if (querySegments.length < 2 || querySegments.length !== candidateSegments.length) {
        return false;
    }

    for (let index = 0; index < querySegments.length - 1; index += 1) {
        if (querySegments[index] !== candidateSegments[index]) {
            return false;
        }
    }

    const queryLast = querySegments[querySegments.length - 1] || "";
    const candidateLast = candidateSegments[candidateSegments.length - 1] || "";
    if (queryLast === candidateLast || queryLast.length !== candidateLast.length) {
        return false;
    }

    const queryLastIsDigits = /^\d+$/.test(queryLast);
    const candidateLastIsDigits = /^\d+$/.test(candidateLast);
    if (queryLastIsDigits !== candidateLastIsDigits) {
        return false;
    }

    const queryLastIsLetters = /^[a-z]+$/.test(queryLast);
    const candidateLastIsLetters = /^[a-z]+$/.test(candidateLast);
    return queryLastIsLetters === candidateLastIsLetters;
}

export function scoreCandidateLexicalEvidence(plan: SearchQueryPlan, result: SearchResultLike): SearchLexicalEvidence {
    if (plan.lexicalTerms.length === 0 && plan.quotedLiteralPhrases.length === 0) {
        return { score: 0, exactLexicalMatch: false };
    }

    const relativePath = typeof result?.relativePath === "string" ? result.relativePath.toLowerCase() : "";
    const symbolLabel = typeof result?.symbolLabel === "string" ? result.symbolLabel.toLowerCase() : "";
    const content = typeof result?.content === "string" ? result.content.toLowerCase() : "";
    const pathSegments = relativePath.split("/").filter((segment: string) => segment.length > 0);
    const candidateTokens = extractNormalizedCandidateTokens([
        symbolLabel,
        relativePath,
        content,
    ]);

    let score = 0;
    let exactLexicalMatch = false;
    const matchedWholeTerms = new Set<string>();
    const matchedStructuralAnchorTerms = new Set<string>();
    const matchedExactStructuralAnchorTerms = new Set<string>();

    for (const phrase of plan.quotedLiteralPhrases) {
        if (symbolLabel.includes(phrase)) {
            score = Math.max(score, 1.75);
            exactLexicalMatch = true;
            continue;
        }
        if (pathSegments.some((segment: string) => segment.includes(phrase))) {
            score = Math.max(score, 1.60);
            exactLexicalMatch = true;
            continue;
        }
        if (content.includes(phrase)) {
            score = Math.max(score, 1.70);
            exactLexicalMatch = true;
        }
    }

    for (const term of plan.lexicalTerms) {
        const usageKind = plan.referenceSeeking ? getReferenceUsageKind(content, term.value) : null;
        const declarationMatch = plan.referenceSeeking && hasDeclarationMatch(content, term.value);
        const termFactor = getLexicalTermFactor(plan, term);

        if (usageKind === "executable" && !declarationMatch) {
            score = Math.max(score, 1.60 * termFactor);
            continue;
        }

        if (usageKind === "import" && !declarationMatch) {
            score = Math.max(score, 0.75 * termFactor);
            continue;
        }

        if (hasTokenBoundaryMatch(symbolLabel, term.value)) {
            score = Math.max(score, (plan.referenceSeeking ? 0.02 : 1.30) * termFactor);
            if (term.kind === "whole") {
                matchedWholeTerms.add(term.value);
                if (isHighSignalStructuralAnchorTerm(term)) {
                    matchedStructuralAnchorTerms.add(term.value);
                    matchedExactStructuralAnchorTerms.add(term.value);
                }
            }
            if ((!plan.referenceSeeking || plan.writerSeeking) && term.kind === "whole") {
                exactLexicalMatch = true;
            }
            continue;
        }

        if (pathSegments.some((segment: string) => hasTokenBoundaryMatch(segment, term.value))) {
            score = Math.max(score, (plan.referenceSeeking ? 0.02 : 1.20) * termFactor);
            if (term.kind === "whole") {
                matchedWholeTerms.add(term.value);
                if (isHighSignalStructuralAnchorTerm(term)) {
                    matchedStructuralAnchorTerms.add(term.value);
                    matchedExactStructuralAnchorTerms.add(term.value);
                }
            }
            if ((!plan.referenceSeeking || plan.writerSeeking) && term.kind === "whole") {
                exactLexicalMatch = true;
            }
            continue;
        }

        if (hasTokenBoundaryMatch(content, term.value)) {
            score = Math.max(score, (plan.referenceSeeking ? (declarationMatch ? 0.10 : 1.25) : 0.90) * termFactor);
            if (term.kind === "whole") {
                matchedWholeTerms.add(term.value);
                if (isHighSignalStructuralAnchorTerm(term)) {
                    matchedExactStructuralAnchorTerms.add(term.value);
                }
            }
            if ((!plan.referenceSeeking || plan.writerSeeking) && term.kind === "whole") {
                exactLexicalMatch = true;
            }
            continue;
        }

        if (symbolLabel.includes(term.value)) {
            score = Math.max(score, (plan.referenceSeeking ? 0.04 : 0.55) * termFactor);
            if (term.kind === "whole") {
                matchedWholeTerms.add(term.value);
            }
            continue;
        }

        if (relativePath.includes(term.value)) {
            score = Math.max(score, (plan.referenceSeeking ? 0.04 : 0.45) * termFactor);
            if (term.kind === "whole") {
                matchedWholeTerms.add(term.value);
            }
            continue;
        }

        if (content.includes(term.value)) {
            score = Math.max(score, (plan.referenceSeeking ? (declarationMatch ? 0.08 : 0.30) : 0.25) * termFactor);
            if (term.kind === "whole") {
                matchedWholeTerms.add(term.value);
            }
        }
    }

    const coverageBoost = Math.min(
        matchedWholeTerms.size * (plan.implementationSeeking || plan.writerSeeking ? 0.18 : 0.08),
        plan.implementationSeeking || plan.writerSeeking ? 0.54 : 0.24
    );
    const structuralAnchorBoost = matchedStructuralAnchorTerms.size > 0
        && !plan.referenceSeeking
        && !plan.writerSeeking
        && (plan.intent === "mixed" || plan.intent === "semantic")
        ? (plan.intent === "mixed" ? 0.80 : 0.55)
        : 0;
    const structuralAnchorNearMissPenalty = !plan.referenceSeeking
        && !plan.writerSeeking
        && (plan.intent === "mixed" || plan.intent === "semantic")
        && plan.lexicalTerms.some((term) => (
            term.kind === "whole"
            && isHighSignalStructuralAnchorTerm(term)
            && !matchedExactStructuralAnchorTerms.has(term.value)
            && candidateTokens.some((candidateToken) => isSiblingStructuralAnchorNearMiss(term.value, candidateToken))
        ))
        ? (plan.intent === "mixed"
            ? SEARCH_SIBLING_STRUCTURAL_ANCHOR_PENALTY_PRE_WEIGHT_MIXED
            : SEARCH_SIBLING_STRUCTURAL_ANCHOR_PENALTY_PRE_WEIGHT_SEMANTIC)
        : 0;

    return {
        // Penalty is applied in the same pre-weight lexical stage as the structural-anchor boost.
        score: (score + coverageBoost + structuralAnchorBoost - structuralAnchorNearMissPenalty) * plan.lexicalWeight,
        exactLexicalMatch,
    };
}
