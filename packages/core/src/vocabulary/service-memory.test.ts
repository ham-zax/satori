import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PublicationRef } from '../generation/contracts';
import { isRepositoryRelativePath, isSymbolRegistryManifest, SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRegistryManifest } from '../symbols/contracts';
import { computeSymbolRegistryManifestHash } from '../symbols/registry';
import { encodeRepositoryVocabularyIndex,
    type EncodedRepositoryVocabularyIndex } from './codec';
import { isVocabularyEvidence, MAX_VOCABULARY_DOCUMENTS, MAX_VOCABULARY_TERMS, VOCABULARY_EVIDENCE_VERSION,
    VOCABULARY_INDEX_VERSION, type RepositoryVocabularyFilter, type RepositoryVocabularyIndex,
    type RepositoryVocabularyResult, type VocabularyDocument, type VocabularyLink } from './contracts';
import { vocabularyStem, vocabularyTokens } from './extract';
import { readBoundedVocabularyFile, vocabularyHash } from './storage';
import { RepositoryVocabularyService } from './service';

type OldPosting = { document: VocabularyDocument; evidence: VocabularyLink; weight: number };
type OldLoaded = { status: RepositoryVocabularyResult['status']; artifactHash?: string;
    documents: number; postings: Map<string, OldPosting[]> };
interface VocabularyReadPorts {
    isReadAdmitted(publication: PublicationRef): boolean | Promise<boolean>;
    getNavigationAddress(publication: PublicationRef): { publicationId: string; navigationRoot: string } | null;
}

const emptyOld = (status: OldLoaded['status']): OldLoaded => ({ status, documents: 0, postings: new Map() });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function oldAliasEligibility(qualifiedName: string): boolean {
    if (qualifiedName.length === 0 || qualifiedName.length > 128) return false;
    return /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:::[A-Za-z_$][A-Za-z0-9_$]*|\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(qualifiedName);
}

/** Frozen expanded codec decoder from before M03, independent of both current decoders. */
function decodeOldRepositoryVocabularyIndex(value: unknown): RepositoryVocabularyIndex | null {
    if (!value || typeof value !== 'object') return null;
    const index = value as EncodedRepositoryVocabularyIndex;
    if (index.version !== VOCABULARY_INDEX_VERSION || typeof index.publicationId !== 'string'
        || typeof index.normalizedRootPath !== 'string' || typeof index.symbolManifestHash !== 'string'
        || typeof index.relationshipManifestHash !== 'string'
        || index.encoding !== 'dictionary_v1' || !Array.isArray(index.dictionary)
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

/** Frozen copy of service.ts before M03; deliberately does not use compact decoding or preparation. */
function prepareOld(index: RepositoryVocabularyIndex, artifactHash: string): OldLoaded {
    const documents = new Map(index.documents.map(document => [document.symbolInstanceId, document]));
    if (documents.size !== index.documents.length) return emptyOld('corrupt');
    const postings = new Map<string, OldPosting[]>();
    const callers = new Map<string, VocabularyDocument[]>();
    for (const caller of documents.values()) {
        for (const target of caller.callees) {
            const origins = callers.get(target) ?? [];
            if (origins.length <= 8) origins.push(caller);
            callers.set(target, origins);
        }
    }
    for (const document of documents.values()) {
        const linked = new Map<string, OldPosting>();
        const append = (origin: VocabularyDocument, via: VocabularyLink['via'], maximum = 48,
            identifiersOnly = false) => {
            let added = 0;
            for (const term of origin.terms) {
                if (linked.size >= 96 || added >= maximum) break;
                if (identifiersOnly && term.kind !== 'identifier') continue;
                const weight = via === 'self' ? (term.kind === 'identifier' ? 3 : 1)
                    : via === 'parent' ? 0.5 : 0.4;
                const key = vocabularyStem(term.term);
                if (!linked.has(key)) {
                    linked.set(key, { document, weight, evidence: {
                        ...term, via, file: origin.file, fileHash: origin.fileHash,
                        symbolInstanceId: origin.symbolInstanceId,
                    } });
                    added++;
                }
            }
        };
        append(document, 'self');
        const parent = document.parentInstanceId ? documents.get(document.parentInstanceId) : undefined;
        if (parent && parent.file === document.file) append(parent, 'parent', 24);
        for (const id of document.callees) {
            const callee = documents.get(id);
            if (callee) append(callee, 'call', 4, true);
        }
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

/** The original public load, cache, and ranking path kept independent for differential tests. */
class LegacyVocabularyReference {
    private readonly cache = new Map<string, Promise<OldLoaded>>();
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
        const matches = [...scores.values()].filter(match => match.evidence.length >= Math.min(2, queryTerms.length))
            .filter(match => oldAliasEligibility(match.document.qualifiedName))
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

    private async load(publication: PublicationRef, navigationRoot: string): Promise<OldLoaded> {
        try {
            const bytes = await readBoundedVocabularyFile(path.join(navigationRoot, 'vocabulary.json'));
            const parsed = JSON.parse(bytes.toString('utf8')) as {
                payloadHash?: string; index?: EncodedRepositoryVocabularyIndex;
            };
            const encoded = parsed.index;
            if (!encoded || parsed.payloadHash !== vocabularyHash(JSON.stringify(encoded))) return emptyOld('corrupt');
            if (encoded.version !== VOCABULARY_INDEX_VERSION || encoded.publicationId !== publication.id
                || encoded.normalizedRootPath !== publication.publication.canonicalRoot.replace(/\\/g, '/').replace(/\/$/, '')) {
                return emptyOld('incompatible');
            }
            const index = decodeOldRepositoryVocabularyIndex(encoded);
            if (!index) return emptyOld('corrupt');
            if (index.budgetExceeded) return emptyOld('budget_exceeded');
            const manifest = JSON.parse((await readBoundedVocabularyFile(path.join(navigationRoot, 'manifest.json')))
                .toString('utf8'));
            const relationships = await readBoundedVocabularyFile(path.join(navigationRoot, 'relationships', 'manifest.json'));
            if (!isSymbolRegistryManifest(manifest) || computeSymbolRegistryManifestHash(manifest) !== index.symbolManifestHash
                || vocabularyHash(relationships) !== index.relationshipManifestHash) return emptyOld('incompatible');
            return prepareOld(index, vocabularyHash(bytes));
        } catch (error) {
            return emptyOld((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing'
                : error instanceof RangeError ? 'budget_exceeded' : 'corrupt');
        }
    }
}

type InputTerm = string | { term: string; kind?: 'identifier' | 'source'; line?: number };
function document(symbolInstanceId: string, qualifiedName: string, terms: InputTerm[] = [], options: {
    file?: string; parentInstanceId?: string; callees?: string[];
} = {}): VocabularyDocument {
    return {
        symbolInstanceId, qualifiedName, file: options.file ?? 'src/shared.ts', language: 'typescript',
        fileHash: `hash-${symbolInstanceId}`, terms: terms.map(term => typeof term === 'string'
            ? { term, kind: 'identifier', line: 1 }
            : { term: term.term, kind: term.kind ?? 'identifier', line: term.line ?? 1 }),
        ...(options.parentInstanceId !== undefined ? { parentInstanceId: options.parentInstanceId } : {}),
        callees: options.callees ?? [],
    };
}
const sequence = (prefix: string, length: number, kind: 'identifier' | 'source' = 'identifier') =>
    Array.from({ length }, (_, index) => ({ term: `${prefix}${String(index).padStart(2, '0')}`, kind }));

function buildDocuments(): VocabularyDocument[] {
    const docs: VocabularyDocument[] = [
        document('parent-same', 'Container', ['amber', 'cobalt']),
        document('child-parent', 'Container.child', ['amber'], { parentInstanceId: 'parent-same' }),
        document('parent-foreign', 'Foreign', ['cobalt'], { file: 'src/foreign.ts' }),
        document('child-foreign', 'Local.child', ['amber'], { parentInstanceId: 'parent-foreign' }),
        document('stem-duplicate', 'StemDuplicate', ['connect', 'connecting', 'amber',
            { term: 'safeline', line: Number.MAX_SAFE_INTEGER }]),
        document('direct-consumer', 'directConsumer', ['consumerkey'], { callees: ['direct-callee'] }),
        document('direct-callee', 'directCallee', ['callterm00', 'callterm01', { term: 'callsource', kind: 'source' },
            'callterm02', 'callterm03', 'callterm04']),
        document('target-eight', 'targetEight', ['targetbase8']),
        document('target-nine', 'targetNine', ['targetbase9']),
        document('caller-cap-target', 'callerCapTarget', ['callerbase']),
        document('long-caller', 'longCaller', sequence('callerterm', 9), { callees: ['caller-cap-target'] }),
        document('parent-cap', 'ParentCap', sequence('parentcap', 25)),
        document('parent-cap-child', 'ParentCap.child', [], { parentInstanceId: 'parent-cap' }),
    ];
    for (let index = 0; index < 8; index++) {
        docs.push(document(`incoming-eight-${index}`, `incomingEight${index}`, [`caller${String(index).padStart(2, '0')}`],
            { callees: ['target-eight'] }));
    }
    for (let index = 0; index < 9; index++) {
        docs.push(document(`incoming-nine-${index}`, `incomingNine${index}`, [`caller${String(index).padStart(2, '0')}`],
            { callees: ['target-nine'] }));
    }
    const crowdedParent = document('crowded-parent', 'CrowdedParent', sequence('crowdparent', 24));
    docs.push(crowdedParent);
    const crowdedCallees = Array.from({ length: 8 }, (_, caller) => {
        const id = `crowded-callee-${caller}`;
        docs.push(document(id, `crowdedCallee${caller}`, sequence(`crowdcallee${caller}`, 4)));
        return id;
    });
    docs.push(document('crowded', 'Crowded', sequence('crowdself', 48), {
        parentInstanceId: crowdedParent.symbolInstanceId, callees: crowdedCallees,
    }));
    docs.push(document('crowded-caller', 'CrowdedCaller', ['crowdcaller99'], { callees: ['crowded'] }));
    for (const id of ['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e']) {
        docs.push(document(id, `Tie${id.slice(-1).toUpperCase()}`, ['tieamber', 'tiecobalt']));
    }
    docs.push(document('tie-invalid', 'callback("title")', ['tieamber', 'tiecobalt']));
    docs.push(document('tie-too-long', 'A'.repeat(129), ['tieamber', 'tiecobalt']));
    return docs;
}

interface Fixture {
    root: string;
    navigationRoot: string;
    artifactPath: string;
    relationshipPath: string;
    ref: PublicationRef;
    index: RepositoryVocabularyIndex;
    manifest: SymbolRegistryManifest;
    relationshipBytes: Buffer;
}

function writeRawArtifact(fixture: Fixture, rawIndex: unknown, payloadHashOverride?: string): void {
    const payload = JSON.stringify(rawIndex);
    fs.writeFileSync(fixture.artifactPath, JSON.stringify({
        payloadHash: payloadHashOverride ?? vocabularyHash(payload), index: rawIndex,
    }));
}

async function createFixture(t: test.TestContext, documents: VocabularyDocument[] = buildDocuments()): Promise<Fixture> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocabulary-memory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const navigationRoot = path.join(root, 'navigation');
    fs.mkdirSync(path.join(navigationRoot, 'relationships'), { recursive: true });
    const relationshipBytes = Buffer.from('{"schemaVersion":"relationship_v5","files":[]}');
    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: root, rootFingerprint: 'fixture',
        indexPolicyHash: 'policy', languageRouterVersion: 'router', extractorVersion: 'extractor',
        relationshipVersion: 'relationships', builtAt: new Date(0).toISOString(), files: [
            { path: 'src/shared.ts', hash: 'a'.repeat(64), language: 'typescript', symbolCount: 64,
                definitionStatus: 'definitions_present' },
        ],
    };
    const index: RepositoryVocabularyIndex = {
        version: VOCABULARY_INDEX_VERSION, publicationId: 'fixture-publication',
        normalizedRootPath: root.replace(/\\/g, '/').replace(/\/$/, ''),
        symbolManifestHash: computeSymbolRegistryManifestHash(manifest),
        relationshipManifestHash: vocabularyHash(relationshipBytes), documents,
    };
    const fixture: Fixture = { root, navigationRoot, artifactPath: path.join(navigationRoot, 'vocabulary.json'),
        relationshipPath: path.join(navigationRoot, 'relationships', 'manifest.json'),
        ref: { id: index.publicationId, publication: { canonicalRoot: root } } as PublicationRef,
        index, manifest, relationshipBytes };
    fs.writeFileSync(path.join(navigationRoot, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(fixture.relationshipPath, relationshipBytes);
    writeRawArtifact(fixture, encodeRepositoryVocabularyIndex(index));
    return fixture;
}

function ports(fixture: Fixture): VocabularyReadPorts {
    return { isReadAdmitted: () => true,
        getNavigationAddress: ref => ({ publicationId: ref.id, navigationRoot: fixture.navigationRoot }) };
}

function idFilter(ids: string[]): RepositoryVocabularyFilter {
    const allowed = new Set(ids);
    return document => allowed.has(document.symbolInstanceId);
}

test('empty parent instance IDs do not add parent evidence', async t => {
    const fixture = await createFixture(t, [
        document('', 'EmptyParent', ['cobalt']),
        document('empty-parent-child', 'EmptyParent.child', ['amber'], { parentInstanceId: '' }),
    ]);
    assert.equal(fixture.index.documents[1]?.parentInstanceId, '', 'the fixture retains the empty parent ID');
    const current = new RepositoryVocabularyService(ports(fixture));
    const old = new LegacyVocabularyReference(ports(fixture));
    const expected = await old.lookup(fixture.ref, 'amber cobalt');
    const actual = await current.lookup(fixture.ref, 'amber cobalt');
    assert.deepEqual(expected.matches, []);
    assert.deepEqual(actual, expected);
});

test('frozen old lookup agrees for provenance, link caps, stems, aliases, ties and limits', async t => {
    const fixture = await createFixture(t);
    const current = new RepositoryVocabularyService(ports(fixture));
    const old = new LegacyVocabularyReference(ports(fixture));
    const compareLookup = async (query: string, limit = 4, filter?: RepositoryVocabularyFilter) => {
        const expected = await old.lookup(fixture.ref, query, limit, filter);
        const actual = await current.lookup(fixture.ref, query, limit, filter);
        assert.deepEqual(actual, expected, `${query} (limit ${limit})`);
        return actual;
    };

    const parent = await compareLookup('amber cobalt', 4, idFilter(['child-parent']));
    assert.deepEqual(parent.matches[0]?.evidence.map(link => [link.term, link.via]), [
        ['amber', 'self'], ['cobalt', 'parent'],
    ]);
    assert.equal(parent.matches[0]?.evidence[1]?.fileHash, 'hash-parent-same');
    assert.deepEqual((await compareLookup('amber cobalt', 4, idFilter(['child-foreign']))).matches, []);

    const duplicateStem = await compareLookup('connect amber', 4, idFilter(['stem-duplicate']));
    assert.deepEqual(duplicateStem.matches[0]?.evidence.map(link => link.term), ['connect', 'amber']);
    assert.equal(duplicateStem.matches[0]?.evidence[0]?.line, 1);
    assert.equal((await compareLookup('safeline amber', 4, idFilter(['stem-duplicate']))).matches[0]?.evidence[0]?.line,
        Number.MAX_SAFE_INTEGER);

    assert.ok((await compareLookup('consumerkey callterm03', 4, idFilter(['direct-consumer']))).matches[0]?.evidence
        .some(link => link.via === 'call' && link.term === 'callterm03'));
    assert.deepEqual((await compareLookup('consumerkey callterm04', 4, idFilter(['direct-consumer']))).matches, []);
    assert.deepEqual((await compareLookup('consumerkey callsource', 4, idFilter(['direct-consumer']))).matches, []);

    assert.ok((await compareLookup('targetbase8 caller07', 4, idFilter(['target-eight']))).matches.length);
    assert.deepEqual((await compareLookup('targetbase9 caller08', 4, idFilter(['target-nine']))).matches, []);
    assert.ok((await compareLookup('callerbase callerterm07', 4, idFilter(['caller-cap-target']))).matches.length);
    assert.deepEqual((await compareLookup('callerbase callerterm08', 4, idFilter(['caller-cap-target']))).matches, []);
    assert.ok((await compareLookup('parentcap00 parentcap23', 4, idFilter(['parent-cap-child']))).matches.length);
    assert.deepEqual((await compareLookup('parentcap00 parentcap24', 4, idFilter(['parent-cap-child']))).matches, []);

    assert.ok((await compareLookup('crowdparent23 crowdcallee503', 4, idFilter(['crowded']))).matches.length);
    assert.deepEqual((await compareLookup('crowdparent23 crowdcaller99', 4, idFilter(['crowded']))).matches, [],
        'the 96-link total cap excludes incoming caller evidence after 48 self + 24 parent + 32 callee links');

    const tieFilter = idFilter(['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e', 'tie-invalid', 'tie-too-long']);
    assert.deepEqual((await compareLookup('tieamber tiecobalt', 4, tieFilter)).matches
        .map(match => match.symbolInstanceId), ['tie-a', 'tie-b', 'tie-c', 'tie-d']);
    assert.deepEqual((await compareLookup('tieamber tiecobalt', 0, tieFilter)).matches, []);
    assert.deepEqual((await compareLookup('tieamber tiecobalt', 2, tieFilter)).matches
        .map(match => match.symbolInstanceId), ['tie-a', 'tie-b']);
    assert.deepEqual((await compareLookup('tieamber tiecobalt', 9, tieFilter)).matches
        .map(match => match.symbolInstanceId), ['tie-a', 'tie-b', 'tie-c', 'tie-d']);
    assert.deepEqual((await compareLookup('tieamber tiecobalt', Number.NaN, tieFilter)).matches, []);

    const cached = await compareLookup('amber cobalt', 4, idFilter(['child-parent']));
    assert.deepEqual(await current.lookup(fixture.ref, 'amber cobalt', 4, idFilter(['child-parent'])), cached);
    assert.deepEqual(await old.lookup(fixture.ref, 'amber cobalt', 4, idFilter(['child-parent'])), cached);
});

test('accepts receives complete decoded documents in the original per-posting order', async t => {
    const fixture = await createFixture(t);
    const current = new RepositoryVocabularyService(ports(fixture));
    const old = new LegacyVocabularyReference(ports(fixture));
    const record = (which: 'old' | 'current') => {
        const documents: VocabularyDocument[] = [];
        const filter: RepositoryVocabularyFilter = value => {
            documents.push(structuredClone(value as VocabularyDocument));
            return value.symbolInstanceId === 'child-parent' || value.symbolInstanceId === 'stem-duplicate';
        };
        return { documents, filter, which };
    };
    const expectedCall = record('old');
    const actualCall = record('current');
    const expected = await old.lookup(fixture.ref, 'amber cobalt connect', 4, expectedCall.filter);
    const actual = await current.lookup(fixture.ref, 'amber cobalt connect', 4, actualCall.filter);
    assert.deepEqual(actual, expected);
    assert.deepEqual(actualCall.documents, expectedCall.documents);
    assert.ok(actualCall.documents.length > 0);
    assert.ok(actualCall.documents.every(value => Array.isArray(value.terms)
        && value.terms.every(term => typeof term.term === 'string' && Number.isSafeInteger(term.line))));
});

test('cached results isolate returned mutations and malformed artifacts retain old statuses', async t => {
    const fixture = await createFixture(t);
    const current = new RepositoryVocabularyService(ports(fixture));
    const old = new LegacyVocabularyReference(ports(fixture));
    const currentInitial = await current.lookup(fixture.ref, 'amber cobalt', 4);
    const oldInitial = await old.lookup(fixture.ref, 'amber cobalt', 4);
    assert.deepEqual(currentInitial, oldInitial);
    const expected = structuredClone(currentInitial);
    assert.ok(currentInitial.matches.length > 0);
    currentInitial.terms[0] = 'consumer-mutation';
    currentInitial.matches[0]!.qualifiedName = 'consumer-mutation';
    currentInitial.matches[0]!.evidence[0]!.term = 'consumer-mutation';
    oldInitial.terms[0] = 'consumer-mutation';
    oldInitial.matches[0]!.qualifiedName = 'consumer-mutation';
    oldInitial.matches[0]!.evidence[0]!.term = 'consumer-mutation';
    assert.deepEqual(await current.lookup(fixture.ref, 'amber cobalt', 4), expected);
    assert.deepEqual(await old.lookup(fixture.ref, 'amber cobalt', 4), expected);

    const encoded = encodeRepositoryVocabularyIndex(fixture.index);
    writeRawArtifact(fixture, encoded, 'incorrect-hash');
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'corrupt');

    const malformed = structuredClone(encoded) as unknown as { documents: { terms: unknown[] }[] };
    malformed.documents[0]!.terms[0] = [Number.MAX_SAFE_INTEGER, 0, 1];
    writeRawArtifact(fixture, malformed);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'corrupt');

    const foreign = { ...encoded, publicationId: 'foreign-publication' };
    writeRawArtifact(fixture, foreign);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'incompatible');

    const foreignRoot = { ...encoded, normalizedRootPath: '/foreign/root' };
    writeRawArtifact(fixture, foreignRoot);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'incompatible');

    writeRawArtifact(fixture, encoded);
    const changedManifest = structuredClone(fixture.manifest);
    changedManifest.indexPolicyHash = 'changed';
    fs.writeFileSync(path.join(fixture.navigationRoot, 'manifest.json'), JSON.stringify(changedManifest));
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'incompatible');
    fs.writeFileSync(path.join(fixture.navigationRoot, 'manifest.json'), JSON.stringify(fixture.manifest));

    fs.writeFileSync(fixture.relationshipPath, Buffer.from('{"schemaVersion":"relationship_v5","files":["changed"]}'));
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'incompatible');

    fs.unlinkSync(fixture.artifactPath);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'missing');

    const budgeted: EncodedRepositoryVocabularyIndex = {
        ...encoded, budgetExceeded: true, dictionary: [], documents: [],
    };
    writeRawArtifact(fixture, budgeted);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        (await new LegacyVocabularyReference(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status);
    assert.equal((await new RepositoryVocabularyService(ports(fixture)).lookup(fixture.ref, 'amber cobalt')).status,
        'budget_exceeded');
});
