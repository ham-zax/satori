import type { RelationshipRecord } from '../symbols/contracts';
import type { SymbolRegistry } from '../symbols/registry';
import {
    isVocabularyEvidence, VOCABULARY_INDEX_VERSION, MAX_VOCABULARY_DOCUMENTS,
    type RepositoryVocabularyIndex, type VocabularyDocument,
} from './contracts';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function buildRepositoryVocabularyIndex(input: {
    registry: SymbolRegistry;
    records: readonly RelationshipRecord[];
    publicationId: string;
    symbolManifestHash: string;
    relationshipManifestHash: string;
}): RepositoryVocabularyIndex {
    const callees = new Map<string, Set<string>>();
    const orderedCalls = input.records.filter(edge => edge.type === 'CALLS' && edge.confidence === 'high'
        && edge.sourceInstanceId && edge.targetInstanceId)
        .sort((a, b) => compare(a.sourceInstanceId!, b.sourceInstanceId!) || compare(a.targetInstanceId!, b.targetInstanceId!));
    for (const edge of orderedCalls) {
        if (edge.type !== 'CALLS' || edge.confidence !== 'high' || !edge.sourceInstanceId || !edge.targetInstanceId) continue;
        const targets = callees.get(edge.sourceInstanceId) ?? new Set<string>();
        if (targets.size < 8) targets.add(edge.targetInstanceId);
        callees.set(edge.sourceInstanceId, targets);
    }
    const documents: VocabularyDocument[] = [];
    for (const symbol of input.registry.symbols) {
        if (!isVocabularyEvidence(symbol.vocabulary) || symbol.kind === 'file' || symbol.kind === 'test') continue;
        const parent = symbol.parentKey ? input.registry.symbolsByKey.get(symbol.parentKey)?.[0] : undefined;
        documents.push({ symbolInstanceId: symbol.symbolInstanceId, qualifiedName: symbol.qualifiedName,
            file: symbol.file, language: symbol.language, fileHash: symbol.fileHash,
            terms: symbol.vocabulary.terms,
            ...(parent && parent.file === symbol.file ? { parentInstanceId: parent.symbolInstanceId } : {}),
            callees: [...(callees.get(symbol.symbolInstanceId) ?? [])].sort(compare) });
        if (documents.length > MAX_VOCABULARY_DOCUMENTS) break;
    }
    const budgetExceeded = documents.length > MAX_VOCABULARY_DOCUMENTS;
    documents.sort((a, b) => compare(a.file, b.file) || compare(a.symbolInstanceId, b.symbolInstanceId));
    return { version: VOCABULARY_INDEX_VERSION, publicationId: input.publicationId,
        normalizedRootPath: input.registry.manifest.normalizedRootPath,
        symbolManifestHash: input.symbolManifestHash, relationshipManifestHash: input.relationshipManifestHash,
        ...(budgetExceeded ? { budgetExceeded: true } : {}), documents: budgetExceeded ? [] : documents };
}
