export const SEARCH_RRF_K = 60;
export const SEARCH_MAX_CANDIDATES = 80;
export const SEARCH_MAX_DIAGNOSTIC_CANDIDATES = 160;
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
export const SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES = 12;
export const SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT = 4;
export const SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT = 2;
export const SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY = 2;
export const SEARCH_RERANK_DOC_MAX_LINES = 200;
export const SEARCH_RERANK_DOC_MAX_CHARS = 4000;
/** Aggregate UTF-8 bytes of selected reranker document strings; excludes query and transport framing. */
export const SEARCH_RERANK_INPUT_MAX_UTF8_BYTES = 1024 * 1024;
export const SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES = 128 * 1024;
export const SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES = 2 * 1024 * 1024;
export const SEARCH_RESULT_SET_HANDLE_PLACEHOLDER = "0".repeat(48);
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
    | 'scriptRuntime'
    | 'adapter'
    | 'example'
    | 'fixture'
    | 'artifact'
    | 'landing'
    | 'neutral'
    | 'tests'
    | 'docs'
    | 'generated';

export const SCOPE_PATH_MULTIPLIERS: Record<SearchScope, Record<PathCategory, number>> = {
    runtime: {
        entrypoint: 1.20,
        core: 1.35,
        srcRuntime: 1.10,
        scriptRuntime: 1.15,
        adapter: 0.70,
        example: 0.60,
        fixture: 0.35,
        artifact: 0.30,
        landing: 0.30,
        neutral: 0.95,
        tests: 0.90,
        docs: 0.45,
        generated: 0.30,
    },
    mixed: {
        entrypoint: 1.15,
        core: 1.10,
        srcRuntime: 1.05,
        scriptRuntime: 1.05,
        adapter: 0.90,
        example: 0.85,
        fixture: 0.65,
        artifact: 0.65,
        landing: 0.65,
        neutral: 1.00,
        tests: 0.90,
        docs: 0.90,
        generated: 0.70,
    },
    docs: {
        entrypoint: 0.50,
        core: 0.50,
        srcRuntime: 0.50,
        scriptRuntime: 0.50,
        adapter: 0.50,
        example: 0.70,
        fixture: 0.60,
        artifact: 0.50,
        landing: 0.40,
        neutral: 0.80,
        tests: 1.10,
        docs: 1.20,
        generated: 0.40,
    },
};
