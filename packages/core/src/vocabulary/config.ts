/** Indexing opt-in is independent of per-request search flags. */
export function resolveRepositoryVocabularyIndexingEnabled(
    value = process.env.SATORI_REPOSITORY_VOCABULARY_INDEX,
): boolean {
    return value === '1';
}
