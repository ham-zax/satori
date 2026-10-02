export const VOCABULARY_EVIDENCE_VERSION = 'repository_vocabulary_evidence_v1' as const;
export const VOCABULARY_INDEX_VERSION = 'repository_vocabulary_index_v1' as const;
export const VOCABULARY_FILE = 'vocabulary.json';
export const MAX_VOCABULARY_TERMS = 48;
export const MAX_VOCABULARY_BYTES = 64 * 1024 * 1024;
export const MAX_VOCABULARY_DOCUMENTS = 100_000;

export interface VocabularyTerm {
    term: string;
    kind: 'identifier' | 'source';
    line: number;
}

/** File hash and symbol identity come from the containing SymbolRecord. */
export interface RepositoryVocabularyEvidence {
    version: typeof VOCABULARY_EVIDENCE_VERSION;
    terms: VocabularyTerm[];
}

export interface VocabularyLink extends VocabularyTerm {
    file: string;
    fileHash: string;
    symbolInstanceId: string;
    via: 'self' | 'parent' | 'call';
}

export interface VocabularyDocument {
    symbolInstanceId: string;
    qualifiedName: string;
    file: string;
    language: string;
    fileHash: string;
    terms: VocabularyTerm[];
    parentInstanceId?: string;
    callees: string[];
}

export interface RepositoryVocabularyIndex {
    version: typeof VOCABULARY_INDEX_VERSION;
    publicationId: string;
    normalizedRootPath: string;
    symbolManifestHash: string;
    relationshipManifestHash: string;
    budgetExceeded?: true;
    documents: VocabularyDocument[];
}

export interface RepositoryVocabularyMatch {
    symbolInstanceId: string;
    qualifiedName: string;
    file: string;
    language: string;
    score: number;
    evidence: VocabularyLink[];
}

export interface RepositoryVocabularyResult {
    status: 'ok' | 'missing' | 'incompatible' | 'corrupt' | 'budget_exceeded';
    publicationId: string;
    artifactHash?: string;
    terms: string[];
    matches: RepositoryVocabularyMatch[];
}

export type RepositoryVocabularyFilter = (symbol: Pick<VocabularyDocument,
    'symbolInstanceId' | 'file' | 'language'>) => boolean;

export function isVocabularyEvidence(value: unknown): value is RepositoryVocabularyEvidence {
    if (!value || typeof value !== 'object') return false;
    const evidence = value as RepositoryVocabularyEvidence;
    return evidence.version === VOCABULARY_EVIDENCE_VERSION
        && Array.isArray(evidence.terms) && evidence.terms.length <= MAX_VOCABULARY_TERMS
        && evidence.terms.every(term => term && typeof term.term === 'string'
            && /^[\p{L}\p{N}]{2,64}$/u.test(term.term)
            && (term.kind === 'identifier' || term.kind === 'source')
            && Number.isSafeInteger(term.line) && term.line > 0);
}
