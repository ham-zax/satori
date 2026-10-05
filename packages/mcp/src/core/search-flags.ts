export type SearchFlags = {
    /** Use generation-bound source vocabulary when the caller does not supply alt_terms. */
    repo_vocab?: boolean;
    compound_join?: boolean;
    dealias?: boolean;
    /**
     * Widens the implementation-question cue from
     * `where is ... implemented` to any `where is|does|do|are ...`.
     * Off by default: the widened cue reclassifies ordinary reference and
     * conceptual questions as implementation questions, which changes the
     * answer focus the reranker sees.
     */
    focus_cue_wide?: boolean;
    path_demotion?: boolean;
    prf?: boolean;
    /**
     * Blends the provider rank with the fused-pool rank when ordering
     * reranker results. Off by default: without it the provider order wins
     * outright.
     */
    rerank_blend?: boolean;
    /**
     * Applies the implementation role preference (implementation, then
     * adapters, then tests/docs/fixtures) to reranked results when the answer
     * focus is neutral, which is the default for descriptive discovery
     * queries. Explicit test, documentation, configuration, reference and
     * path-constrained requests keep their own ordering. Off by default until
     * it is compared against the current ordering on the same publication.
     */
    neutral_owner_preference?: boolean;
    /** Adds a bounded published-symbol metadata BM25 arm before reranking. Experimental; off by default. */
    symbol_metadata_bm25?: boolean;
    /** Default definition metadata admission and fusion; disable explicitly for baseline comparison. */
    definition_discovery?: boolean;
    /**
     * Feeds caller alt_terms into definition admission and fusion. On by
     * default; it only acts when the caller supplies alt_terms.
     */
    definition_alt_terms?: boolean;
    /** Attaches caller alt_terms to the reranker question. Experimental switch for the wrong-terms control. */
    rerank_alt_terms?: boolean;
};

/** All flags with their compile-time defaults, before env or explicit overrides. */
export const DEFAULT_SEARCH_FLAGS: Required<SearchFlags> = {
    repo_vocab: false,
    compound_join: true,
    path_demotion: true,
    dealias: false,
    focus_cue_wide: false,
    prf: false,
    rerank_blend: false,
    neutral_owner_preference: false,
    symbol_metadata_bm25: false,
    definition_discovery: true,
    definition_alt_terms: true,
    rerank_alt_terms: true,
};

/**
 * Token table for the SATORI_SEARCH_FLAGS env form. Flag names contain
 * underscores, so the "no-" and "no_" negations must be matched as whole
 * tokens rather than by splitting the token apart.
 */
const FLAG_TOKENS: ReadonlyMap<string, keyof Required<SearchFlags>> = new Map([
    ...Object.keys(DEFAULT_SEARCH_FLAGS).flatMap((name) => [
        [name, name as keyof Required<SearchFlags>] as const,
        [`no-${name}`, name as keyof Required<SearchFlags>] as const,
        [`no_${name}`, name as keyof Required<SearchFlags>] as const,
    ]),
]);

/** Reset token: every flag off, including the ones that default on. */
const BASELINE_TOKENS = new Set(['none', 'baseline']);

function applyFlagToken(flags: Required<SearchFlags>, token: string): void {
    const lower = token.trim().toLowerCase();
    if (!lower) return;
    if (BASELINE_TOKENS.has(lower)) {
        for (const key of Object.keys(DEFAULT_SEARCH_FLAGS) as Array<keyof Required<SearchFlags>>) {
            flags[key] = false;
        }
        return;
    }
    const name = FLAG_TOKENS.get(lower);
    if (name === undefined) return;
    flags[name] = !lower.startsWith('no-') && !lower.startsWith('no_');
}

/**
 * Resolve the effective flag set.
 *
 * Precedence: compile-time defaults, then SATORI_SEARCH_FLAGS, then explicit
 * caller flags. An explicit object only overwrites the keys it names, so a
 * partial object still leaves the remaining defaults in effect -- callers that
 * need the true runtime set must read the returned object, not the input.
 *
 * The only accepted explicit shapes are a record of booleans, or absent
 * (undefined/null). Anything else throws naming the offending type rather than
 * being coerced: a token array or a comma string used to be silently accepted
 * here while the tool schema rejected it, so a caller could not tell from the
 * type whether its input was understood. SATORI_SEARCH_FLAGS remains the one
 * string-encoded path, and it is the harness that sets it.
 */
export function resolveSearchFlags(explicitFlags?: Record<string, boolean> | null): SearchFlags {
    const flags: Required<SearchFlags> = { ...DEFAULT_SEARCH_FLAGS };
    const envStr = (typeof process !== 'undefined' && process.env?.SATORI_SEARCH_FLAGS) || '';
    if (envStr) {
        for (const f of envStr.split(',')) applyFlagToken(flags, f);
    }
    if (explicitFlags !== undefined && explicitFlags !== null) {
        if (typeof explicitFlags !== 'object' || Array.isArray(explicitFlags)) {
            throw new Error(
                `search flags must be a record of flag names to booleans; received ${Array.isArray(explicitFlags) ? 'array' : typeof explicitFlags}`,
            );
        }
        for (const [key, value] of Object.entries(explicitFlags)) {
            if (value === undefined) continue;
            if (typeof value !== 'boolean') {
                throw new Error(
                    `search flag "${key}" must be a boolean; received ${Array.isArray(value) ? 'array' : typeof value}`,
                );
            }
            if (!(key in DEFAULT_SEARCH_FLAGS)) continue;
            flags[key as keyof SearchFlags] = value;
        }
    }
    return flags;
}
