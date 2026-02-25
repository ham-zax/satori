export const SEARCH_RRF_K = 60;
export const SEARCH_MAX_CANDIDATES = 80;
export const SEARCH_PROXIMITY_WINDOW = 25;

export const STALENESS_THRESHOLDS_MS = {
    fresh: 30 * 60 * 1000,
    aging: 24 * 60 * 60 * 1000,
} as const;

export type SearchScope = 'runtime' | 'mixed' | 'docs';
export type SearchResultMode = 'grouped' | 'raw';
export type SearchGroupBy = 'symbol' | 'file';

export type PathCategory =
    | 'entrypoint'
    | 'core'
    | 'srcRuntime'
    | 'neutral'
    | 'tests'
    | 'docs'
    | 'generated';

export const SCOPE_PATH_MULTIPLIERS: Record<SearchScope, Record<PathCategory, number>> = {
    runtime: {
        entrypoint: 1.40,
        core: 1.25,
        srcRuntime: 1.10,
        neutral: 1.00,
        tests: 0.65,
        docs: 0.55,
        generated: 0.40,
    },
    mixed: {
        entrypoint: 1.15,
        core: 1.10,
        srcRuntime: 1.05,
        neutral: 1.00,
        tests: 0.90,
        docs: 0.90,
        generated: 0.70,
    },
    docs: {
        entrypoint: 0.50,
        core: 0.50,
        srcRuntime: 0.50,
        neutral: 0.80,
        tests: 1.10,
        docs: 1.20,
        generated: 0.40,
    },
};
