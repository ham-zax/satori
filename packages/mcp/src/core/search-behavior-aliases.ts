import type { SearchRouteKind } from "./search-lexical-scoring.js";
import { resolveSearchAltTerms, type ResolvedSearchAltTerms } from "./search-expansion-terms.js";

/**
 * Curated behavior words mapped to the code vocabulary that names them.
 * The table is deliberately small: every entry must be measured. `cleanup`
 * maps to `destroy` because the React effect owner calls the cleanup function
 * `destroy` and keeps no `cleanup` token of its own.
 */
export const BEHAVIOR_ALIASES: Readonly<Record<"cleanup", readonly string[]>> = Object.freeze({
    cleanup: Object.freeze(["destroy"]),
});

/** Bridge a measured behavior word in a query to at most one code term. */
export function resolveBehaviorAliases(query: string): string[] {
    for (const token of query.match(/[a-z0-9]+/gi) ?? []) {
        const aliases = BEHAVIOR_ALIASES[token.toLowerCase() as keyof typeof BEHAVIOR_ALIASES];
        if (aliases !== undefined) return [...aliases];
    }
    return [];
}

/**
 * Resolve the alt terms for one search request. Behavior aliases fire only on
 * an automatic path: the caller supplied no terms, the experiment is enabled,
 * and the route is conceptual or mixed. Every other request keeps exactly the
 * caller-only result.
 */
export function resolveBehaviorSearchTerms(input: {
    query: string;
    callerTerms?: string[] | string;
    enabled: boolean;
    routeKind: SearchRouteKind;
}): ResolvedSearchAltTerms {
    if (input.enabled !== true || input.callerTerms !== undefined) {
        return resolveSearchAltTerms(input.callerTerms);
    }
    if (input.routeKind !== "conceptual" && input.routeKind !== "mixed") {
        return resolveSearchAltTerms(input.callerTerms);
    }
    return resolveSearchAltTerms(resolveBehaviorAliases(input.query));
}
