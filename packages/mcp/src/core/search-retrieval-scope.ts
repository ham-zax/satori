import type { SemanticSearchRequest } from "@satori-code/core";
import type { SearchScope } from "./search-constants.js";
import type { ParsedSearchOperators } from "./search-query-planning.js";
import { classifyPathCategory, shouldIncludeCategoryInScope } from "./search-ranking-policy.js";
import { candidateWithinRequestedSubdirectory, type RequestedSearchSubdirectory } from "./search-requested-scope.js";

/** Restrict every retrieval arm using file identities from the pinned Publication. */
export function buildSearchRetrievalScope(input: {
    files: readonly { path: string; language: string }[];
    scope: SearchScope;
    parsedOperators: ParsedSearchOperators;
    requestedSubdirectory?: RequestedSearchSubdirectory | null;
    matchesPath: (relativePath: string, patterns: string[]) => boolean;
}): SemanticSearchRequest["filter"] {
    const { parsedOperators: operators } = input;
    const eligible = input.files.filter((file) => (
        shouldIncludeCategoryInScope(input.scope, classifyPathCategory(file.path))
        && candidateWithinRequestedSubdirectory(file.path, input.requestedSubdirectory ?? null)
        && (operators.lang.length === 0 || operators.lang.includes(file.language.toLowerCase()))
        && (operators.path.length === 0 || input.matchesPath(file.path, operators.path))
        && (operators.excludePath.length === 0 || !input.matchesPath(file.path, operators.excludePath))
    ));
    if (eligible.length === input.files.length && eligible.length > 0) return undefined;
    const paths = [...new Set(eligible.map((file) => file.path))].sort();
    // Published relative paths are non-empty. Equality to the empty path is a
    // backend-neutral empty set; an empty `in` filter is deliberately invalid.
    return paths.length === 0
        ? { kind: "comparison", field: "relativePath", operator: "eq", value: "" }
        : { kind: "in", field: "relativePath", values: paths };
}
