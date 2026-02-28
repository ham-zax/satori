export const SEARCH_RRF_K = 60;
export const SEARCH_MAX_CANDIDATES = 80;
export const SEARCH_PROXIMITY_WINDOW = 25;
export const SEARCH_OPERATOR_PREFIX_MAX_CHARS = 200;
export const SEARCH_MUST_RETRY_ROUNDS = 2;
export const SEARCH_MUST_RETRY_MULTIPLIER = 2;
export const SEARCH_DIVERSITY_MAX_PER_FILE = 2;
export const SEARCH_DIVERSITY_MAX_PER_SYMBOL = 1;
export const SEARCH_DIVERSITY_RELAXED_FILE_CAP = SEARCH_DIVERSITY_MAX_PER_FILE + 1;
export const SEARCH_CHANGED_FILES_CACHE_TTL_MS = 5000;
export const SEARCH_CHANGED_FIRST_MULTIPLIER = 1.10;
export const SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES = 50;
export const SEARCH_RERANK_TOP_K = 50;
export const SEARCH_RERANK_RRF_K = 10;
export const SEARCH_RERANK_WEIGHT = 1.0;
export const SEARCH_RERANK_DOC_MAX_LINES = 200;
export const SEARCH_RERANK_DOC_MAX_CHARS = 4000;
export const SEARCH_NOISE_HINT_TOP_K = 5;
export const SEARCH_NOISE_HINT_THRESHOLD = 0.60;
export const SEARCH_NOISE_HINT_PATTERNS = [
    '**/*.test.*',
    '**/*.spec.*',
    '**/__tests__/**',
    '**/__fixtures__/**',
    '**/fixtures/**',
    'coverage/**',
] as const;
export const SEARCH_GITIGNORE_FORCE_RELOAD_EVERY_N = 25;

export const STALENESS_THRESHOLDS_MS = {
    fresh: 30 * 60 * 1000,
    aging: 24 * 60 * 60 * 1000,
} as const;

export type SearchScope = 'runtime' | 'mixed' | 'docs';
export type SearchResultMode = 'grouped' | 'raw';
export type SearchGroupBy = 'symbol' | 'file';
export type SearchRankingMode = 'default' | 'auto_changed_first';
export type SearchNoiseCategory = 'tests' | 'fixtures' | 'docs' | 'generated' | 'runtime';

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
