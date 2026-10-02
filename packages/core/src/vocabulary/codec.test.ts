import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRepositoryVocabularyIndex, encodeRepositoryVocabularyIndex } from './codec';
import { MAX_VOCABULARY_TERMS, VOCABULARY_INDEX_VERSION, type RepositoryVocabularyIndex } from './contracts';
import { vocabularyTokens } from './extract';

function fixture(): RepositoryVocabularyIndex {
    const comment = '// Release subscriptions during cleanup; disconnect sockets after requests complete. Résumé 42.';
    return {
        version: VOCABULARY_INDEX_VERSION, publicationId: 'publication', normalizedRootPath: '/repository',
        symbolManifestHash: 'symbols', relationshipManifestHash: 'relationships',
        documents: Array.from({ length: 24 }, (_, index) => {
            const name = `releaseSubscription${index}`;
            const identifiers = vocabularyTokens(name);
            const startLine = index * 3 + 2;
            return {
                symbolInstanceId: `instance:${index}`, qualifiedName: name, file: 'effects.ts', language: 'typescript',
                fileHash: 'a'.repeat(64), ...(index ? { parentInstanceId: 'instance:0' } : {}),
                callees: index ? [`instance:${index - 1}`] : [],
                terms: [
                    ...identifiers.map(term => ({ term, kind: 'identifier' as const, line: startLine })),
                    ...vocabularyTokens(comment).filter(term => !identifiers.includes(term))
                        .map(term => ({ term, kind: 'source' as const, line: startLine - 1 })),
                ],
            };
        }),
    };
}

test('dictionary encoding round trips exact source words, provenance and ordering deterministically', () => {
    const index = fixture();
    const encoded = encodeRepositoryVocabularyIndex(index);
    assert.deepEqual(decodeRepositoryVocabularyIndex(JSON.parse(JSON.stringify(encoded))), index);
    assert.deepEqual(encoded.dictionary, [...new Set(index.documents.flatMap(document => document.terms.map(term => term.term)))].sort());
    assert.equal(encoded.dictionary.filter(word => word === 'subscriptions').length, 1);
    assert.ok(index.documents.some(document => document.terms.some(term => term.term === 'résumé'
        && term.kind === 'source' && term.line === 1)));
    assert.equal(JSON.stringify(encodeRepositoryVocabularyIndex(index)), JSON.stringify(encoded));
    assert.deepEqual(fixture(), index, 'encoding must preserve its input');
});

test('repeated words in ordinary source comments reduce the artifact without dropping evidence', () => {
    const index = fixture();
    const rawBytes = Buffer.byteLength(JSON.stringify(index));
    const encoded = encodeRepositoryVocabularyIndex(index);
    const encodedBytes = Buffer.byteLength(JSON.stringify(encoded));
    assert.ok(encodedBytes < rawBytes * 0.8, `${encodedBytes} encoded bytes versus ${rawBytes} raw bytes`);
    assert.equal(encoded.documents.reduce((sum, document) => sum + document.terms.length, 0),
        index.documents.reduce((sum, document) => sum + document.terms.length, 0));
    assert.deepEqual(decodeRepositoryVocabularyIndex(encoded), index);
});

test('malformed dictionary references, kinds, lines and word evidence are rejected', () => {
    const encoded = encodeRepositoryVocabularyIndex(fixture());
    for (const term of [
        [-1, 0, 1], [encoded.dictionary.length, 0, 1], [0.5, 0, 1], ['0', 0, 1],
        [0, 2, 1], [0, 'identifier', 1], [0, 0, 0], [0, 0, -1], [0, 0, 1.5],
        [0, 0, Number.MAX_SAFE_INTEGER + 1], [0, 0], [0, 0, 1, 2], null,
    ]) {
        const invalid = structuredClone(encoded) as unknown as { documents: { terms: unknown[] }[] };
        invalid.documents[0]!.terms[0] = term;
        assert.equal(decodeRepositoryVocabularyIndex(invalid), null, JSON.stringify(term));
    }
    for (const word of ['x', 'has spaces', 'x'.repeat(65), 42, null]) {
        const invalid = structuredClone(encoded) as unknown as { dictionary: unknown[] };
        invalid.dictionary[0] = word;
        assert.equal(decodeRepositoryVocabularyIndex(invalid), null, JSON.stringify(word));
    }
});

test('decoding retains document and evidence bounds and empty budget-exceeded artifacts', () => {
    const index = fixture();
    const encoded = encodeRepositoryVocabularyIndex(index);
    const invalid = structuredClone(encoded);
    invalid.documents[0]!.terms = Array.from({ length: MAX_VOCABULARY_TERMS + 1 }, () => [0, 0, 1]);
    assert.equal(decodeRepositoryVocabularyIndex(invalid), null);
    invalid.documents[0]!.terms = [[0, 0, 1]];
    invalid.documents[0]!.file = '../foreign.ts';
    assert.equal(decodeRepositoryVocabularyIndex(invalid), null);
    const empty: RepositoryVocabularyIndex = { ...index, budgetExceeded: true, documents: [] };
    assert.deepEqual(decodeRepositoryVocabularyIndex(encodeRepositoryVocabularyIndex(empty)), empty);
    assert.equal(decodeRepositoryVocabularyIndex(index), null, 'unreleased object-term artifacts use the old fallback');
});
