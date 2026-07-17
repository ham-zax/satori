import { SEARCH_OPERATOR_PREFIX_MAX_CHARS } from "./search-constants.js";
import type {
    SearchIntentConfidence,
    SearchLexicalTerm,
    SearchLexicalTermKind,
    SearchQueryIntent,
    SearchQueryPlan,
    SearchReferenceDirection,
    SearchRouteContract,
    SearchRouteKind,
    SearchRouteReason,
} from "./search-lexical-scoring.js";

const SEARCH_OPERATOR_KEYS = new Set(["lang", "path", "-path", "must", "exclude"]);
const SEARCH_QUERY_STOPWORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "find", "for", "from", "how",
    "in", "is", "it", "logic", "of", "or", "the", "to", "used", "uses", "using",
    "what", "where", "which", "who", "why",
]);
const SEARCH_STRUCTURAL_CUE_WORDS = new Set([
    "call", "calls", "caller", "callers", "callee", "callees",
    "own", "owns", "owner", "owners", "owning", "reference", "references",
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

function normalizeExactIdentifierTarget(token: string): string | null {
    const normalized = token
        .trim()
        .replace(/^[('"`\[{]+/, "")
        .replace(/[?'"`)\]},;]+$/, "");
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|#|\/|::)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(normalized)) {
        return null;
    }
    if (!/[A-Z_]/.test(normalized) && !/(?:\.|#|\/|::)/.test(normalized)) {
        return null;
    }
    return normalized;
}

function extractExactIdentifierTarget(tokens: string[]): string | undefined {
    const targets = [...new Set(tokens
        .map((token) => normalizeExactIdentifierTarget(token))
        .filter((target): target is string => target !== null)
        .filter((target) => {
            const normalized = target.toLowerCase();
            return !SEARCH_QUERY_STOPWORDS.has(normalized)
                && !SEARCH_STRUCTURAL_CUE_WORDS.has(normalized);
        }))];
    return targets.length === 1 ? targets[0] : undefined;
}

function resolveReferenceDirection(query: string): SearchReferenceDirection {
    const normalized = query.toLowerCase();
    if (/\b(?:callees?|what\s+(?:does|do)\b.*\bcall)\b/.test(normalized)) {
        return "callees";
    }
    if (/\b(?:callers?|who\s+calls?|who\s+uses?|references?\s+(?:to|of))\b/.test(normalized)) {
        return "callers";
    }
    return "both";
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

function buildRouteContract(kind: SearchRouteKind, reason: SearchRouteReason): SearchRouteContract {
    if (kind === "exact_identifier") {
        return {
            kind,
            reason,
            deterministicFirst: true,
            navigation: "required",
            allowedSources: ["registry", "tracked_lexical", "dense", "sparse"],
            currentProviderBudget: { semanticPassesPerAttempt: 1, rerankCalls: 0 },
        };
    }
    if (kind === "exact_path") {
        return {
            kind,
            reason,
            deterministicFirst: true,
            navigation: "preferred",
            allowedSources: ["registry", "live_path", "tracked_lexical", "dense", "sparse"],
            currentProviderBudget: { semanticPassesPerAttempt: 1, rerankCalls: 0 },
        };
    }
    if (kind === "literal") {
        return {
            kind,
            reason,
            deterministicFirst: true,
            navigation: "not_required",
            allowedSources: ["tracked_lexical", "sparse", "dense"],
            currentProviderBudget: { semanticPassesPerAttempt: 1, rerankCalls: 0 },
        };
    }
    if (kind === "references") {
        return {
            kind,
            reason,
            deterministicFirst: true,
            navigation: "preferred",
            allowedSources: ["registry", "relationships", "tracked_lexical", "dense", "sparse"],
            currentProviderBudget: { semanticPassesPerAttempt: 2, rerankCalls: 1 },
        };
    }
    if (kind === "ownership") {
        return {
            kind,
            reason,
            deterministicFirst: true,
            navigation: "preferred",
            allowedSources: ["registry", "tracked_lexical", "dense", "sparse"],
            currentProviderBudget: { semanticPassesPerAttempt: 2, rerankCalls: 1 },
        };
    }
    if (kind === "structural") {
        return {
            kind,
            reason,
            deterministicFirst: true,
            navigation: "preferred",
            allowedSources: ["registry", "relationships", "dense", "sparse"],
            currentProviderBudget: { semanticPassesPerAttempt: 2, rerankCalls: 1 },
        };
    }
    if (kind === "configuration") {
        return {
            kind,
            reason,
            deterministicFirst: true,
            navigation: "not_required",
            allowedSources: ["tracked_lexical", "registry", "sparse", "dense"],
            currentProviderBudget: { semanticPassesPerAttempt: 1, rerankCalls: 0 },
        };
    }
    return {
        kind,
        reason,
        deterministicFirst: false,
        navigation: "not_required",
        allowedSources: ["dense", "sparse", "tracked_lexical"],
        currentProviderBudget: { semanticPassesPerAttempt: 2, rerankCalls: 1 },
    };
}

export type SearchRoutePolicy =
    | "baseline_path_anywhere_v1"
    | "semantic_cues_before_heuristic_path_v1";

export const DEFAULT_SEARCH_ROUTE_POLICY: SearchRoutePolicy =
    "baseline_path_anywhere_v1";

function classifySearchRoute(input: {
    semanticQuery: string;
    intent: SearchQueryIntent;
    identifierTargetPresent: boolean;
    quotedLiteralSeeking: boolean;
    referenceSeeking: boolean;
    implementationSeeking: boolean;
    routePolicy: SearchRoutePolicy;
    parsedOperators?: ParsedSearchOperators;
}): SearchRouteContract {
    const normalizedQuery = input.semanticQuery.toLowerCase();
    const pathOperatorPresent = (input.parsedOperators?.path.length ?? 0) > 0;
    const pathShapedQuery = /(?:^|\s)(?:\.?\.?\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[a-z0-9]+(?:$|\s)/i.test(input.semanticQuery)
        || /\b[\w@.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|json|ya?ml|toml)\b/i.test(input.semanticQuery);
    if (pathOperatorPresent) {
        return buildRouteContract("exact_path", "exact_path_operator");
    }
    if (pathShapedQuery && input.routePolicy === "baseline_path_anywhere_v1") {
        return buildRouteContract("exact_path", "path_shaped_query");
    }
    if (input.quotedLiteralSeeking) {
        return buildRouteContract("literal", "quoted_literal");
    }
    if (/\b(config|configuration|configured|setting|settings|constant|constants|environment|env|flag|flags)\b/.test(normalizedQuery)) {
        return buildRouteContract("configuration", "configuration_cue");
    }
    if (input.referenceSeeking || /\b(calls?|callers?|callees?|references?|imports?|uses?)\b/.test(normalizedQuery)) {
        return buildRouteContract("references", "reference_cue");
    }
    const explicitOwnershipCue = /\b(who\s+owns?|owner|owning)\b/.test(normalizedQuery);
    const exactWhereIsCue = input.identifierTargetPresent
        && /\bwhere\s+is\b/.test(normalizedQuery);
    if (explicitOwnershipCue || exactWhereIsCue) {
        return buildRouteContract("ownership", "ownership_cue");
    }
    if (/\b(architecture|architectural|trace|pipeline|flow|entrypoint|call\s+graph|structure|structural)\b/.test(normalizedQuery)) {
        return buildRouteContract("structural", "structural_cue");
    }
    if (pathShapedQuery && !input.implementationSeeking) {
        return buildRouteContract("exact_path", "path_shaped_query");
    }
    if (input.intent === "identifier") {
        return buildRouteContract("exact_identifier", "identifier_intent");
    }
    if (input.intent === "mixed") {
        return buildRouteContract("mixed", "mixed_intent");
    }
    if (input.intent === "semantic") {
        return buildRouteContract("conceptual", "conceptual_intent");
    }
    return buildRouteContract("conceptual", "uncertain_fallback");
}

export function buildSearchQueryPlan(
    semanticQuery: string,
    hybridEnabled: boolean,
    parsedOperators?: ParsedSearchOperators,
    routePolicy: SearchRoutePolicy = DEFAULT_SEARCH_ROUTE_POLICY,
): SearchQueryPlan {
    const tokens = semanticQuery
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    const normalizedQuery = semanticQuery.toLowerCase();
    const normalizedTokens = tokens.map((token) => token.toLowerCase());
    const identifierTokens = tokens.filter((token) => isIdentifierLikeToken(token));
    const exactIdentifierTarget = extractExactIdentifierTarget(tokens);
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
    const referenceSeeking = explicitReferenceSeeking;
    const testSeeking = /\b(test|tests|tested|testing|spec|specs|coverage|assert|asserts|assertion|assertions|fixture|fixtures|mock|mocks|mocked|stub|stubs)\b/.test(normalizedQuery)
        || /\.test\b/.test(normalizedQuery)
        || /\.spec\b/.test(normalizedQuery);
    const writerSeeking = /\b(writes?|writing|written|updates?|updated|updating|creates?|created|creating|generates?|generated|generating|emits?|emitted|emitting|persists?|persisted|persisting|configures?|configured|configuring|installs?|installed|installing)\b/.test(normalizedQuery);
    const implementationCue = /\b(implement|implements|implemented|implementation|owner|owning|built|build|builds|builder|construct|constructed|create|creates|created|install|installs|installed|emit|emits|emitted|producer|produces|normalize|normalizes|normalized|cap|caps|capped|script|scripts|check|checks|checked|wire|wired|assemble|assembles|assembled|decide|decides|decided|deciding|freshness|reconcile|reconciles|reconciled|reconciliation|control)\b/.test(normalizedQuery);
    const ownerWhereSeeking = identifierTokens.length > 0
        && !explicitReferenceSeeking
        && /\bwhere\s+(?:does|is|are)\b/.test(normalizedQuery);
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
    const route = classifySearchRoute({
        semanticQuery,
        intent,
        identifierTargetPresent: exactIdentifierTarget !== undefined,
        quotedLiteralSeeking,
        referenceSeeking,
        implementationSeeking,
        routePolicy,
        parsedOperators,
    });
    const sparseOnlyRoute = route.kind === "exact_identifier"
        || route.kind === "exact_path"
        || route.kind === "literal"
        || route.kind === "configuration";

    return {
        semanticQuery,
        route,
        ...(exactIdentifierTarget ? { exactIdentifierTarget } : {}),
        ...(route.kind === "references" && exactIdentifierTarget
            ? { referenceDirection: resolveReferenceDirection(semanticQuery) }
            : {}),
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
            ? (sparseOnlyRoute ? "lexical" : "hybrid")
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
        rerankAllowed: !sparseOnlyRoute && intent !== "identifier" && !quotedLiteralSeeking,
    };
}
