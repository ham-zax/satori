/**
 * Hard cap on caller-supplied `alt_terms`, in both the array and string forms.
 *
 * The expanded pass is a separate retrieval pass fused by RRF. Every term the
 * caller adds competes with the primary pass for the same candidate budget, so
 * an unbounded list is a silent retrieval-quality lever. One constant owns the
 * cap for the zod schema, the tool description, the runtime slice, and the
 * alt_terms generator script.
 */
export const SEARCH_ALT_TERMS_MAX = 4;
/** Generous per-term character budget, used only to derive the string-form cap. */
export const SEARCH_ALT_TERMS_TERM_MAX_CHARS = 128;
/** Cap on the space- or comma-separated string form: N terms plus N-1 separators. */
export const SEARCH_ALT_TERMS_STRING_MAX_CHARS =
    SEARCH_ALT_TERMS_MAX * SEARCH_ALT_TERMS_TERM_MAX_CHARS + (SEARCH_ALT_TERMS_MAX - 1);

export const SEARCH_RRF_K = 60;
export const SEARCH_MAX_CANDIDATES = 80;
export const SEARCH_MAX_DIAGNOSTIC_CANDIDATES = 160;
export const SEARCH_DEFAULT_DISCLOSURE_LIMIT = 10;
export const SEARCH_MAX_LOGICAL_RESULTS = Number.MAX_SAFE_INTEGER;
export const SEARCH_MAX_FROZEN_RESULTS = 200;
export const SEARCH_MAX_PAGE_SIZE = SEARCH_MAX_FROZEN_RESULTS;
export const SEARCH_MAX_RESULT_INDEX_ENTRIES = SEARCH_MAX_FROZEN_RESULTS;
export const SEARCH_MAX_RESULT_INDEX_UTF8_BYTES = 32 * 1024;
export const SEARCH_PROXIMITY_WINDOW = 25;
export const SEARCH_OPERATOR_PREFIX_MAX_CHARS = 200;
export const SEARCH_MUST_RETRY_ROUNDS = 2;
export const SEARCH_MUST_RETRY_MULTIPLIER = 2;
export const SEARCH_DIVERSITY_MAX_PER_FILE = 2;
export const SEARCH_DIVERSITY_MAX_PER_SYMBOL = 1;
export const SEARCH_DIVERSITY_RELAXED_FILE_CAP = SEARCH_DIVERSITY_MAX_PER_FILE + 1;
export const SEARCH_CHANGED_FILES_CACHE_TTL_MS = 5000;
export const SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES = 50;
export const SEARCH_RERANK_TOP_K = 128;
export const SEARCH_RERANK_DEFAULT_CANDIDATE_DEPTH = 64;
export const SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES = 12;
export const SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT = 4;
export const SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT = 2;
export const SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY = 2;
export const SEARCH_RERANK_DOC_MAX_LINES = 200;
export const SEARCH_RERANK_DOC_MAX_CHARS = 4000;
/** Aggregate UTF-8 bytes of selected reranker document strings; excludes query and transport framing. */
export const SEARCH_RERANK_INPUT_MAX_UTF8_BYTES = 1024 * 1024;
/** Matches the file_outline and detect_changes budgets so one grouped page fits common MCP client limits. */
export const SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES = 48 * 1024;
export const SEARCH_GROUPED_DEBUG_RESPONSE_MAX_UTF8_BYTES = 2 * 1024 * 1024;
export const SEARCH_RESULT_SET_HANDLE_PLACEHOLDER = "0".repeat(48);
export const SEARCH_RESULT_SET_DIGEST_PLACEHOLDER = "0".repeat(64);
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
