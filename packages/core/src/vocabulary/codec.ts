import { isRepositoryRelativePath } from '../symbols/contracts';
import {
    isVocabularyEvidence, MAX_VOCABULARY_DOCUMENTS, MAX_VOCABULARY_TERMS, VOCABULARY_EVIDENCE_VERSION,
    VOCABULARY_INDEX_VERSION,
    type RepositoryVocabularyIndex, type VocabularyDocument,
} from './contracts';

const VOCABULARY_ENCODING = 'dictionary_v1' as const;
type EncodedTerm = [word: number, kind: 0 | 1, line: number];
type EncodedDocument = Omit<VocabularyDocument, 'terms'> & { terms: EncodedTerm[] };
export type EncodedRepositoryVocabularyIndex = Omit<RepositoryVocabularyIndex, 'documents'> & {
    encoding: typeof VOCABULARY_ENCODING;
    dictionary: string[];
    documents: EncodedDocument[];
};

/** Share exact source words, while retaining every term's kind, line and document order. */
export function encodeRepositoryVocabularyIndex(index: RepositoryVocabularyIndex): EncodedRepositoryVocabularyIndex {
    const uniqueWords = new Set<string>();
    for (const document of index.documents) for (const term of document.terms) uniqueWords.add(term.term);
    const dictionary = [...uniqueWords].sort();
    const words = new Map(dictionary.map((word, position) => [word, position]));
    return { ...index, encoding: VOCABULARY_ENCODING, dictionary,
        documents: index.documents.map(document => ({ ...document,
            terms: document.terms.map(term => [words.get(term.term)!, term.kind === 'identifier' ? 0 : 1, term.line]),
        })) };
}

/** Decode only bounded, validated evidence; callers verify the payload digest first. */
export function decodeRepositoryVocabularyIndex(value: unknown): RepositoryVocabularyIndex | null {
    if (!value || typeof value !== 'object') return null;
    const index = value as EncodedRepositoryVocabularyIndex;
    if (index.version !== VOCABULARY_INDEX_VERSION || typeof index.publicationId !== 'string'
        || typeof index.normalizedRootPath !== 'string' || typeof index.symbolManifestHash !== 'string'
        || typeof index.relationshipManifestHash !== 'string'
        || index.encoding !== VOCABULARY_ENCODING || !Array.isArray(index.dictionary)
        || index.dictionary.length > MAX_VOCABULARY_DOCUMENTS * MAX_VOCABULARY_TERMS
        || !index.dictionary.every(word => isVocabularyEvidence({ version: VOCABULARY_EVIDENCE_VERSION,
            terms: [{ term: word, kind: 'identifier', line: 1 }] }))
        || !Array.isArray(index.documents) || index.documents.length > MAX_VOCABULARY_DOCUMENTS
        || (index.budgetExceeded !== undefined && index.budgetExceeded !== true)) return null;
    const documents: VocabularyDocument[] = [];
    for (const document of index.documents) {
        if (!document || typeof document !== 'object'
            || typeof document.symbolInstanceId !== 'string' || document.symbolInstanceId.length > 256
            || typeof document.qualifiedName !== 'string' || document.qualifiedName.length === 0
            || document.qualifiedName.length > 1024 || !isRepositoryRelativePath(document.file)
            || typeof document.fileHash !== 'string' || document.fileHash.length > 256
            || typeof document.language !== 'string' || document.language.length > 64
            || (document.parentInstanceId !== undefined && typeof document.parentInstanceId !== 'string')
            || !Array.isArray(document.callees) || document.callees.length > 8
            || !document.callees.every(id => typeof id === 'string' && id.length <= 256)
            || !Array.isArray(document.terms) || document.terms.length > MAX_VOCABULARY_TERMS
            || !document.terms.every(term => Array.isArray(term) && term.length === 3
                && Number.isSafeInteger(term[0]) && term[0] >= 0 && term[0] < index.dictionary.length
                && (term[1] === 0 || term[1] === 1) && Number.isSafeInteger(term[2]) && term[2] > 0)) return null;
        documents.push({ ...document, terms: document.terms.map(([word, kind, line]) => ({
            term: index.dictionary[word]!, kind: kind === 0 ? 'identifier' : 'source', line,
        })) });
    }
    const decoded: RepositoryVocabularyIndex & Partial<Pick<EncodedRepositoryVocabularyIndex, 'encoding' | 'dictionary'>> = {
        ...index, documents,
    };
    delete decoded.encoding;
    delete decoded.dictionary;
    return decoded;
}
