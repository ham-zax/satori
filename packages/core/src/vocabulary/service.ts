import path from 'node:path';
import type { PublicationRef } from '../generation/contracts';
import { isSymbolRegistryManifest } from '../symbols/contracts';
import { computeSymbolRegistryManifestHash } from '../symbols/registry';
import { VOCABULARY_FILE, VOCABULARY_INDEX_VERSION, type RepositoryVocabularyFilter,
    type RepositoryVocabularyResult, type VocabularyDocument, type VocabularyLink } from './contracts';
import { readBoundedVocabularyFile, vocabularyHash } from './storage';
import { vocabularyTokens, vocabularyStem } from './extract';
import { decodeRepositoryVocabularyIndexCompact, type EncodedRepositoryVocabularyIndex } from './codec';

type EncodedDocument = EncodedRepositoryVocabularyIndex['documents'][number];
type PostingRange = { offset: number; count: number };
type Loaded = { status: RepositoryVocabularyResult['status']; artifactHash?: string;
    documentCount: number; documents: EncodedDocument[]; dictionary: string[]; postings: Map<string, PostingRange>;
    pairs: Uint32Array };
interface VocabularyReadPorts {
    isReadAdmitted(publication: PublicationRef): boolean | Promise<boolean>;
    getNavigationAddress(publication: PublicationRef): { publicationId: string; navigationRoot: string } | null;
}
const empty = (status: Loaded['status']): Loaded => ({ status, documentCount: 0, documents: [], dictionary: [],
    postings: new Map(), pairs: new Uint32Array(0) });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const MAX_PACKED_ORIGIN = 0xffff_ffff;
const ORIGIN_STRIDE = 48 * 3;
const VIA_CODES = ['self', 'parent', 'call'] as const;

/**
 * Automatic aliases must be usable native identifiers: a dot/`::` path of plain
 * identifier segments. Synthetic display strings (callback registrations, test
 * titles with quotes/parens/spaces) are not valid aliases. `Series.to_numpy`,
 * C++ `a::b` paths, and ordinary camel/snake names pass; display titles do not.
 */
function isUsableAlias(qualifiedName: string): boolean {
    if (qualifiedName.length === 0 || qualifiedName.length > 128) return false;
    return /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:::[A-Za-z_$][A-Za-z0-9_$]*|\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(qualifiedName);
}

function prepare(index: EncodedRepositoryVocabularyIndex, artifactHash: string): Loaded {
    const documents = index.documents;
    const documentIndexes = new Map<string, number>();
    for (let documentIndex = 0; documentIndex < documents.length; documentIndex++) {
        const id = documents[documentIndex]!.symbolInstanceId;
        if (documentIndexes.has(id)) return empty('corrupt');
        documentIndexes.set(id, documentIndex);
    }

    const callers = new Map<number, number[]>();
    for (let callerIndex = 0; callerIndex < documents.length; callerIndex++) {
        for (const target of documents[callerIndex]!.callees) {
            const targetIndex = documentIndexes.get(target);
            if (targetIndex === undefined) continue;
            const origins = callers.get(targetIndex) ?? [];
            if (origins.length <= 8) origins.push(callerIndex);
            callers.set(targetIndex, origins);
        }
    }

    // originIndex * (48 terms * 3 via codes) + termIndex * 3 + via fits
    // Uint32: 100,000 documents and at most 48 terms cap this below 14.4M.
    const postingLists = new Map<string, number[]>();
    let packingOverflow = false;
    for (let documentIndex = 0; documentIndex < documents.length; documentIndex++) {
        const document = documents[documentIndex]!;
        const linked = new Map<string, number>();
        const append = (originIndex: number, via: 0 | 1 | 2, maximum = 48, identifiersOnly = false) => {
            const origin = documents[originIndex]!;
            let added = 0;
            for (let termIndex = 0; termIndex < origin.terms.length; termIndex++) {
                if (linked.size >= 96 || added >= maximum) break;
                const [word, kind] = origin.terms[termIndex]!;
                if (identifiersOnly && kind !== 0) continue;
                const stem = vocabularyStem(index.dictionary[word]!);
                if (!linked.has(stem)) {
                    const packedOrigin = originIndex * ORIGIN_STRIDE + termIndex * 3 + via;
                    if (!Number.isSafeInteger(packedOrigin) || packedOrigin < 0 || packedOrigin > MAX_PACKED_ORIGIN) {
                        packingOverflow = true;
                        return;
                    }
                    linked.set(stem, packedOrigin);
                    added++;
                }
            }
        };

        append(documentIndex, 0);
        const parentIndex = document.parentInstanceId
            ? documentIndexes.get(document.parentInstanceId) : undefined;
        if (parentIndex !== undefined && documents[parentIndex]!.file === document.file) append(parentIndex, 1, 24);
        for (const id of document.callees) {
            const calleeIndex = documentIndexes.get(id);
            if (calleeIndex !== undefined) append(calleeIndex, 2, 4, true);
        }
        // High fan-in utilities are not evidence that all their callers share a concept.
        const origins = callers.get(documentIndex) ?? [];
        if (origins.length <= 8) for (const callerIndex of origins) append(callerIndex, 2, 8);

        if (packingOverflow) return empty('corrupt');
        for (const [stem, packedOrigin] of linked) {
            const entries = postingLists.get(stem) ?? [];
            entries.push(documentIndex, packedOrigin);
            postingLists.set(stem, entries);
        }
    }

    let pairCount = 0;
    for (const entries of postingLists.values()) pairCount += entries.length / 2;
    const pairs = new Uint32Array(pairCount * 2);
    const postings = new Map<string, PostingRange>();
    let offset = 0;
    for (const [stem, entries] of postingLists) {
        const count = entries.length / 2;
        postings.set(stem, { offset: offset / 2, count });
        pairs.set(entries, offset);
        offset += entries.length;
    }
    return { status: 'ok', artifactHash, documentCount: documents.length, documents, dictionary: index.dictionary,
        postings, pairs };
}

/** Owns generation-bound vocabulary reads and the bounded cache of immutable artifacts. */
export class RepositoryVocabularyService {
    private readonly cache = new Map<string, Promise<Loaded>>();
    constructor(private readonly ports: VocabularyReadPorts) {}

    async lookup(publication: PublicationRef, query: string, limit = 4,
        accepts?: RepositoryVocabularyFilter): Promise<RepositoryVocabularyResult> {
        const base = { publicationId: publication.id, terms: [], matches: [] };
        const address = this.ports.getNavigationAddress(publication);
        if (!address || address.publicationId !== publication.id || !await this.ports.isReadAdmitted(publication)) {
            return { ...base, status: 'incompatible' };
        }
        const key = `${publication.publication.canonicalRoot}\0${publication.id}\0${address.navigationRoot}`;
        let pending = this.cache.get(key);
        if (!pending) {
            // A held publication read lease protects this immutable artifact from collection.
            pending = this.load(publication, address.navigationRoot);
            this.cache.set(key, pending);
            if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!);
        }
        const loaded = await pending;
        if (loaded.status !== 'ok') return { ...base, status: loaded.status };
        const queryTerms = [...new Set(vocabularyTokens(query.slice(0, 4096)).map(vocabularyStem))].slice(0, 32);
        const scores = new Map<string, { document: EncodedDocument | VocabularyDocument; score: number; evidence: number[] }>();
        const acceptedDocuments = accepts ? new Map<number, VocabularyDocument>() : undefined;
        const getAcceptedDocument = (documentIndex: number): VocabularyDocument => {
            const cached = acceptedDocuments!.get(documentIndex);
            if (cached) return cached;
            const encoded = loaded.documents[documentIndex]!;
            const materialized: VocabularyDocument = { ...encoded,
                terms: encoded.terms.map(([word, kind, line]) => ({ term: loaded.dictionary[word]!,
                    kind: kind === 0 ? 'identifier' : 'source', line })),
            };
            acceptedDocuments!.set(documentIndex, materialized);
            return materialized;
        };
        for (const term of queryTerms) {
            const range = loaded.postings.get(term);
            const idf = Math.log(1 + loaded.documentCount / (1 + (range?.count ?? 0)));
            if (!range) continue;
            for (let postingIndex = 0; postingIndex < range.count; postingIndex++) {
                const pairIndex = (range.offset + postingIndex) * 2;
                const documentIndex = loaded.pairs[pairIndex]!;
                const packedOrigin = loaded.pairs[pairIndex + 1]!;
                const compactDocument = loaded.documents[documentIndex]!;
                const document = accepts ? getAcceptedDocument(documentIndex) : compactDocument;
                if (accepts && !accepts(document as VocabularyDocument)) continue;
                const originIndex = Math.floor(packedOrigin / ORIGIN_STRIDE);
                const termIndex = Math.floor((packedOrigin % ORIGIN_STRIDE) / 3);
                const via = packedOrigin % 3;
                const [, kind] = loaded.documents[originIndex]!.terms[termIndex]!;
                const weight = via === 0 ? (kind === 0 ? 3 : 1) : via === 1 ? 0.5 : 0.4;
                const match = scores.get(document.symbolInstanceId)
                    ?? { document, score: 0, evidence: [] };
                match.score += weight * idf;
                match.evidence.push(packedOrigin);
                scores.set(document.symbolInstanceId, match);
            }
        }
        // Alias eligibility is decided before top4 selection so discarded overlength
        // or display names cannot exhaust the four-term budget and crowd out valid
        // matching identifiers.
        const matches = [...scores.values()].filter(match => match.evidence.length >= Math.min(2, queryTerms.length))
            .filter(match => isUsableAlias(match.document.qualifiedName))
            .sort((a, b) => b.score - a.score || compare(a.document.file, b.document.file)
                || compare(a.document.symbolInstanceId, b.document.symbolInstanceId))
            .slice(0, Math.max(0, Math.min(4, Number.isFinite(limit) ? Math.floor(limit) : 0)))
            .map(match => ({ symbolInstanceId: match.document.symbolInstanceId,
                qualifiedName: match.document.qualifiedName, file: match.document.file,
                language: match.document.language, score: match.score,
                evidence: match.evidence.map(packedOrigin => {
                    const originIndex = Math.floor(packedOrigin / ORIGIN_STRIDE);
                    const termIndex = Math.floor((packedOrigin % ORIGIN_STRIDE) / 3);
                    const via = packedOrigin % 3;
                    const origin = loaded.documents[originIndex]!;
                    const [word, kind, line] = origin.terms[termIndex]!;
                    const evidenceKind: VocabularyLink['kind'] = kind === 0 ? 'identifier' : 'source';
                    return { term: loaded.dictionary[word]!, kind: evidenceKind, line,
                        via: VIA_CODES[via]!, file: origin.file, fileHash: origin.fileHash,
                        symbolInstanceId: origin.symbolInstanceId };
                }) }));
        const terms = [...new Set(matches.map(match => match.qualifiedName))].filter(term => term.length <= 128);
        return { status: 'ok', publicationId: publication.id, artifactHash: loaded.artifactHash, terms, matches };
    }

    private async load(publication: PublicationRef, navigationRoot: string): Promise<Loaded> {
        try {
            const bytes = await readBoundedVocabularyFile(path.join(navigationRoot, VOCABULARY_FILE));
            const parsed = JSON.parse(bytes.toString('utf8')) as { payloadHash?: string; index?: EncodedRepositoryVocabularyIndex };
            const encoded = parsed.index;
            if (!encoded || parsed.payloadHash !== vocabularyHash(JSON.stringify(encoded))) return empty('corrupt');
            if (encoded.version !== VOCABULARY_INDEX_VERSION || encoded.publicationId !== publication.id
                || encoded.normalizedRootPath !== publication.publication.canonicalRoot.replace(/\\/g, '/').replace(/\/$/, '')) {
                return empty('incompatible');
            }
            const index = decodeRepositoryVocabularyIndexCompact(encoded);
            if (!index) return empty('corrupt');
            if (index.budgetExceeded) return empty('budget_exceeded');
            const manifest = JSON.parse((await readBoundedVocabularyFile(path.join(navigationRoot, 'manifest.json'))).toString('utf8'));
            const relationships = await readBoundedVocabularyFile(path.join(navigationRoot, 'relationships', 'manifest.json'));
            if (!isSymbolRegistryManifest(manifest) || computeSymbolRegistryManifestHash(manifest) !== index.symbolManifestHash
                || vocabularyHash(relationships) !== index.relationshipManifestHash) return empty('incompatible');
            return prepare(index, vocabularyHash(bytes));
        } catch (error) {
            return empty((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing'
                : error instanceof RangeError ? 'budget_exceeded' : 'corrupt');
        }
    }
}
