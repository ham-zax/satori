/**
 * Identity of the LanceDB FTS analyzer. Lexical terms reach the index lowercased
 * (canonical fallback terms) or mixed-case (raw queries), so the analyzer must
 * fold case. Stemming lets word forms in natural-language queries ("renders")
 * match source text ("rendering"); LanceDB applies the same analyzer to query
 * text. A published index built by another analyzer requires a reindex.
 *
 * Kept free of the native LanceDB module: every Context derives the Publication
 * format from the configured provider, including contexts that never open LanceDB.
 */
export const LANCEDB_LEXICAL_ANALYZER_VERSION = 'lancedb_fts_simple_lowercase_stem_v1';
