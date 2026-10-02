import path from 'node:path';
import type { PublicationRef } from '../generation/contracts';
import { isSymbolRegistryManifest } from '../symbols/contracts';
import { computeSymbolRegistryManifestHash } from '../symbols/registry';
import { VOCABULARY_FILE, VOCABULARY_INDEX_VERSION, type RepositoryVocabularyIndex, type RepositoryVocabularyFilter,
    type RepositoryVocabularyResult, type VocabularyDocument, type VocabularyLink } from './contracts';
import { readBoundedVocabularyFile, vocabularyHash } from './storage';
import { vocabularyTokens, vocabularyStem } from './extract';
import { decodeRepositoryVocabularyIndex, type EncodedRepositoryVocabularyIndex } from './codec';

type Posting = { document: VocabularyDocument; evidence: VocabularyLink; weight: number };
type Loaded = { status: RepositoryVocabularyResult['status']; artifactHash?: string;
    documents: number; postings: Map<string, Posting[]> };
interface VocabularyReadPorts {
    isReadAdmitted(publication: PublicationRef): boolean | Promise<boolean>;
    getNavigationAddress(publication: PublicationRef): { publicationId: string; navigationRoot: string } | null;
}
const empty = (status: Loaded['status']): Loaded => ({ status, documents: 0, postings: new Map() });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

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

function prepare(index: RepositoryVocabularyIndex, artifactHash: string): Loaded {
    const documents = new Map(index.documents.map(document => [document.symbolInstanceId, document]));
    if (documents.size !== index.documents.length) return empty('corrupt');
    const postings = new Map<string, Posting[]>();
    const callers = new Map<string, VocabularyDocument[]>();
    for (const caller of documents.values()) {
        for (const target of caller.callees) {
            const origins = callers.get(target) ?? [];
            if (origins.length <= 8) origins.push(caller);
            callers.set(target, origins);
        }
    }
    for (const document of documents.values()) {
        const linked = new Map<string, Posting>();
        const append = (origin: VocabularyDocument, via: VocabularyLink['via'], maximum = 48, identifiersOnly = false) => {
            let added = 0;
            for (const term of origin.terms) {
                if (linked.size >= 96 || added >= maximum) break;
                if (identifiersOnly && term.kind !== 'identifier') continue;
                const weight = via === 'self' ? (term.kind === 'identifier' ? 3 : 1) : via === 'parent' ? 0.5 : 0.4;
                const key = vocabularyStem(term.term);
                if (!linked.has(key)) { linked.set(key, { document, weight, evidence: {
                    ...term, via, file: origin.file, fileHash: origin.fileHash, symbolInstanceId: origin.symbolInstanceId,
                } }); added++; }
            }
        };
        append(document, 'self');
        const parent = document.parentInstanceId ? documents.get(document.parentInstanceId) : undefined;
        if (parent && parent.file === document.file) append(parent, 'parent', 24);
        for (const id of document.callees) {
            const callee = documents.get(id);
            if (callee) append(callee, 'call', 4, true);
        }
        // High fan-in utilities are not evidence that all their callers share a concept.
        const origins = callers.get(document.symbolInstanceId) ?? [];
        if (origins.length <= 8) for (const caller of origins) append(caller, 'call', 8);
        for (const [term, posting] of linked) {
            const entries = postings.get(term) ?? [];
            entries.push(posting);
            postings.set(term, entries);
        }
    }
    return { status: 'ok', artifactHash, documents: documents.size, postings };
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
        const scores = new Map<string, { document: VocabularyDocument; score: number; evidence: VocabularyLink[] }>();
        for (const term of queryTerms) {
            const postings = loaded.postings.get(term) ?? [];
            const idf = Math.log(1 + loaded.documents / (1 + postings.length));
            for (const posting of postings) {
                if (accepts && !accepts(posting.document)) continue;
                const match = scores.get(posting.document.symbolInstanceId)
                    ?? { document: posting.document, score: 0, evidence: [] };
                match.score += posting.weight * idf;
                match.evidence.push(posting.evidence);
                scores.set(posting.document.symbolInstanceId, match);
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
                evidence: match.evidence.map(link => ({ ...link })) }));
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
            const index = decodeRepositoryVocabularyIndex(encoded);
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
