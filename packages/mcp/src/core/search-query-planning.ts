import { SEARCH_OPERATOR_PREFIX_MAX_CHARS } from "./search-constants.js";
import type {
    SearchIntentConfidence,
    SearchLexicalTerm,
    SearchLexicalTermKind,
    SearchQueryIntent,
    SearchQueryPlan,
} from "./search-lexical-scoring.js";

const SEARCH_OPERATOR_KEYS = new Set(["lang", "path", "-path", "must", "exclude"]);
const SEARCH_QUERY_STOPWORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "find", "for", "from", "how",
    "in", "is", "it", "logic", "of", "or", "the", "to", "used", "uses", "using",
    "what", "where", "which", "who", "why",
]);

export type ParsedSearchOperators = {
    semanticQuery: string;
    prefixBlockChars: number;
    lang: string[];
    path: string[];
    excludePath: string[];
    must: string[];
    exclude: string[];
};

function tokenizeQueryPrefix(prefix: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuotes = false;
    let escaped = false;

    for (let i = 0; i < prefix.length; i += 1) {
        const ch = prefix[i];
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === "\\") {
            current += ch;
            escaped = true;
            continue;
        }

        if (ch === "\"") {
            inQuotes = !inQuotes;
            current += ch;
            continue;
        }

        if (!inQuotes && /\s/.test(ch)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }

        current += ch;
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

function unquoteOperatorValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
        return trimmed;
    }

    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        const inner = trimmed.slice(1, -1);
        return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    }

    return trimmed;
}

function deriveOperatorOnlySemanticQuery(operators: ParsedSearchOperators): string | null {
    if (operators.must.length !== 1) {
        return null;
    }

    const mustValue = operators.must[0].trim();
    if (/\s/.test(mustValue)) {
        return null;
    }

    const symbolInstanceIdLike = /^syminst_[a-f0-9]{32}$/i.test(mustValue);
    const identifierLike = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:[.#:/-]|::)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(mustValue);
    const strongIdentifierSignal = /[A-Z_]/.test(mustValue) || /(?:\.|::|#|\/)/.test(mustValue);
    if (symbolInstanceIdLike || (identifierLike && strongIdentifierSignal)) {
        return mustValue;
    }

    return null;
}

export function parseSearchOperators(query: string): ParsedSearchOperators {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return {
            semanticQuery: "",
            prefixBlockChars: 0,
            lang: [],
            path: [],
            excludePath: [],
            must: [],
            exclude: [],
        };
    }

    const maxPrefixChars = Math.min(SEARCH_OPERATOR_PREFIX_MAX_CHARS, query.length);
    const prefixWindow = query.slice(0, maxPrefixChars);
    const blankLineOffset = prefixWindow.indexOf("\n\n");
    const prefixChars = blankLineOffset >= 0 ? blankLineOffset : maxPrefixChars;
    const prefixBlock = query.slice(0, prefixChars);
    const suffixText = blankLineOffset >= 0
        ? query.slice(blankLineOffset + 2)
        : query.slice(prefixChars);

    const operators: ParsedSearchOperators = {
        semanticQuery: "",
        prefixBlockChars: prefixChars,
        lang: [],
        path: [],
        excludePath: [],
        must: [],
        exclude: [],
    };

    const semanticTokens: string[] = [];
    const tokens = tokenizeQueryPrefix(prefixBlock);
    for (const token of tokens) {
        if (token.startsWith("\\") && token.length > 1) {
            semanticTokens.push(token.slice(1));
            continue;
        }

        const separator = token.indexOf(":");
        if (separator <= 0) {
            semanticTokens.push(token);
            continue;
        }

        const key = token.slice(0, separator);
        if (!SEARCH_OPERATOR_KEYS.has(key)) {
            semanticTokens.push(token);
            continue;
        }

        const rawValue = token.slice(separator + 1);
        const value = unquoteOperatorValue(rawValue);
        if (value.length === 0) {
            continue;
        }

        if (key === "lang") {
            operators.lang.push(value.toLowerCase());
            continue;
        }
        if (key === "path") {
            operators.path.push(value.replace(/\\/g, "/"));
            continue;
        }
        if (key === "-path") {
            operators.excludePath.push(value.replace(/\\/g, "/"));
            continue;
        }
        if (key === "must") {
            operators.must.push(value);
            continue;
        }
        if (key === "exclude") {
            operators.exclude.push(value);
            continue;
        }

        semanticTokens.push(token);
    }

    const semanticFromPrefix = semanticTokens.join(" ").trim();
    const semanticSuffix = suffixText.trim();
    const semanticParts = [semanticFromPrefix, semanticSuffix].filter((part) => part.length > 0);
    operators.semanticQuery = semanticParts.length > 0
        ? semanticParts.join("\n")
        : (deriveOperatorOnlySemanticQuery(operators) || trimmedQuery);
    return operators;
}

function tokenizeLexicalTerms(tokens: string[]): SearchLexicalTerm[] {
    const terms = new Map<string, SearchLexicalTerm>();
    const addTerm = (value: string, kind: SearchLexicalTermKind): void => {
        const normalized = value
            .replace(/^['"`]+|['"`]+$/g, "")
            .replace(/[(){}\[\],;]+/g, " ")
            .trim()
            .toLowerCase();
        if (normalized.length === 0) {
            return;
        }

        const existing = terms.get(normalized);
        if (!existing || (existing.kind === "fragment" && kind === "whole")) {
            terms.set(normalized, { value: normalized, kind });
        }
    };

    for (const token of tokens) {
        const trimmed = token.trim();
        if (trimmed.length === 0) {
            continue;
        }

        addTerm(trimmed, "whole");

        const expanded = trimmed
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[/\\._:-]+/g, " ")
            .replace(/[(){}\[\],;]+/g, " ")
            .toLowerCase();
        for (const part of expanded.split(/\s+/)) {
            const normalizedPart = part.trim();
            if (normalizedPart.length >= 2) {
                addTerm(normalizedPart, "fragment");
            }
        }
    }

    return Array.from(terms.values());
}

function isIdentifierLikeToken(token: string): boolean {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
        return false;
    }

    return /[A-Z]/.test(trimmed)
        || /[_/\\.\-:]/.test(trimmed)
        || /\d/.test(trimmed);
}

function extractQuotedLiteralPhrases(query: string): string[] {
    const phrases = new Set<string>();
    const pattern = /(["'`])([^"'`]+?)\1/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
        const normalized = match[2]
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase();
        if (normalized.length >= 3) {
            phrases.add(normalized);
        }
    }
    return Array.from(phrases.values()).slice(0, 4);
}

export function buildSearchQueryPlan(semanticQuery: string, hybridEnabled: boolean): SearchQueryPlan {
    const tokens = semanticQuery
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    const normalizedQuery = semanticQuery.toLowerCase();
    const normalizedTokens = tokens.map((token) => token.toLowerCase());
    const identifierTokens = tokens.filter((token) => isIdentifierLikeToken(token));
    const naturalLanguageTokens = tokens
        .filter((token) => (
            !isIdentifierLikeToken(token)
            && (SEARCH_QUERY_STOPWORDS.has(token.toLowerCase()) || token.length >= 4)
        ))
        .map((token) => token.toLowerCase());
    const singleBareLookup = tokens.length === 1
        && /^[a-z][a-z0-9]{2,63}$/.test(tokens[0])
        && !SEARCH_QUERY_STOPWORDS.has(normalizedTokens[0] || "");
    const exactPinEligible = identifierTokens.some((token) => /[A-Z_]/.test(token));
    const quotedLiteralPhrases = extractQuotedLiteralPhrases(semanticQuery);
    const quotedLiteralSeeking = quotedLiteralPhrases.length > 0;
    const lexicalSourceTokens = identifierTokens.length > 0 && naturalLanguageTokens.length > 0
        ? tokens
        : (identifierTokens.length > 0 ? identifierTokens : tokens);
    const lexicalTerms = tokenizeLexicalTerms(lexicalSourceTokens)
        .filter((term) => !SEARCH_QUERY_STOPWORDS.has(term.value))
        .slice(0, 8);
    const explicitReferenceSeeking = /\b(used|uses|usage|reference|references|referenced|callers?|called|imports?|imported|instantiat(?:e|ed|ion))\b/.test(normalizedQuery)
        || /\bwho\s+uses\b/.test(normalizedQuery);
    const referenceSeeking = explicitReferenceSeeking
        || /\bwhere\s+is\b/.test(normalizedQuery)
        || /\bwho\s+uses\b/.test(normalizedQuery);
    const testSeeking = /\b(test|tests|tested|testing|spec|specs|coverage|assert|asserts|assertion|assertions|fixture|fixtures|mock|mocks|mocked|stub|stubs)\b/.test(normalizedQuery)
        || /\.test\b/.test(normalizedQuery)
        || /\.spec\b/.test(normalizedQuery);
    const writerSeeking = /\b(writes?|writing|written|updates?|updated|updating|creates?|created|creating|generates?|generated|generating|emits?|emitted|emitting|persists?|persisted|persisting|configures?|configured|configuring|installs?|installed|installing)\b/.test(normalizedQuery);
    const implementationCue = /\b(implement|implements|implemented|implementation|owner|owning|built|build|builds|builder|construct|constructed|create|creates|created|install|installs|installed|emit|emits|emitted|producer|produces|normalize|normalizes|normalized|cap|caps|capped|script|scripts|check|checks|checked|wire|wired|assemble|assembles|assembled|decide|decides|decided|deciding|freshness|reconcile|reconciles|reconciled|reconciliation|control)\b/.test(normalizedQuery);
    const ownerWhereSeeking = !explicitReferenceSeeking && /\bwhere\s+(?:does|is|are)\b/.test(normalizedQuery);
    const implementationSeeking = !testSeeking && (implementationCue || ownerWhereSeeking || writerSeeking);

    let intent: SearchQueryIntent = "uncertain";
    let confidence: SearchIntentConfidence = "low";
    const reasons: string[] = [];

    if (identifierTokens.length > 0 && naturalLanguageTokens.length > 0) {
        intent = "mixed";
        confidence = identifierTokens.length >= 2 ? "high" : "medium";
        reasons.push("identifier_terms_present", "natural_language_terms_present");
    } else if (identifierTokens.length > 0) {
        intent = "identifier";
        confidence = tokens.length === identifierTokens.length ? "high" : "medium";
        reasons.push(tokens.length === 1 ? "single_identifier_token" : "identifier_tokens_present");
    } else if (singleBareLookup) {
        intent = "uncertain";
        confidence = "medium";
        reasons.push("single_term_lookup");
    } else if (naturalLanguageTokens.length >= 2 || tokens.length >= 4) {
        intent = "semantic";
        confidence = "high";
        reasons.push("natural_language_query");
    } else {
        reasons.push("ambiguous_short_query");
    }
    if (referenceSeeking) {
        reasons.push("reference_seeking_query");
    }
    if (quotedLiteralSeeking) {
        reasons.push("quoted_literal_query");
    }
    if (testSeeking) {
        reasons.push("test_seeking_query");
    }
    if (implementationSeeking) {
        reasons.push("implementation_seeking_query");
    }
    if (writerSeeking) {
        reasons.push("writer_seeking_query");
    }

    return {
        semanticQuery,
        intent,
        confidence,
        reasons,
        quotedLiteralPhrases,
        referenceSeeking,
        testSeeking,
        implementationSeeking,
        writerSeeking,
        lexicalTerms,
        retrievalMode: hybridEnabled
            ? (intent === "identifier" ? "lexical" : "hybrid")
            : "dense",
        scorePolicyKind: "topk_only",
        lexicalWeight: quotedLiteralSeeking
            ? 1.35
            : intent === "identifier"
                ? 1.35
                : intent === "mixed"
                    ? (referenceSeeking || implementationSeeking || writerSeeking ? 0.30 : 0.10)
                    : intent === "uncertain"
                        ? 0.60
                        : (referenceSeeking || implementationSeeking || writerSeeking ? 0.18 : 0.00),
        exactMatchPinningEnabled: intent === "identifier"
            || quotedLiteralSeeking
            || (writerSeeking && exactPinEligible),
        rerankAllowed: intent !== "identifier" && !quotedLiteralSeeking,
    };
}
