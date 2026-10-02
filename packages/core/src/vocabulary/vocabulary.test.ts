import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PublicationRef } from '../generation/contracts';
import { createLanguageAnalysisService } from '../language-analysis/service';
import { buildSymbolRecordsForFile, buildSymbolRegistry } from '../symbols/registry';
import { SYMBOL_REGISTRY_SCHEMA_VERSION, type RelationshipRecord } from '../symbols/contracts';
import { stagePublicationNavigation } from '../symbols/sidecar-lifecycle';
import { readSymbolRegistrySidecar } from '../symbols/sidecar-reads';
import { withSourceVocabulary } from './extract';
import { RepositoryVocabularyService } from './service';
import { MAX_VOCABULARY_BYTES, VOCABULARY_FILE } from './contracts';
import { vocabularyHash } from './storage';

const source = `// A Series represents a single column of values.
class Series {
  // Convert this column to a numerical array.
  to_numpy() { return new Array(); }
}
// Release subscriptions during cleanup.
function releaseSubscription() { destroyBuffer(); }
function destroyBuffer() { return null; }
`;

async function stage(root: string, id: string, content = source, confidence: RelationshipRecord['confidence'] = 'high') {
    const analyzer = createLanguageAnalysisService();
    const analysis = await analyzer.analyze({ content, relativePath: 'effects.ts', language: 'typescript' });
    await analyzer.dispose?.();
    const hash = vocabularyHash(content);
    const symbols = withSourceVocabulary(buildSymbolRecordsForFile({ relativePath: 'effects.ts', content,
        language: 'typescript', fileHash: hash, extractorVersion: 'fixture',
        extractedSymbols: analysis.symbols, chunks: [...analysis.chunks] }), content);
    const registry = buildSymbolRegistry({ manifest: {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: root, rootFingerprint: 'fixture',
        indexPolicyHash: 'policy', languageRouterVersion: 'router', extractorVersion: 'fixture',
        relationshipVersion: 'fixture', builtAt: new Date(0).toISOString(), files: [
            { path: 'effects.ts', hash, language: 'typescript', symbolCount: symbols.length,
                definitionStatus: 'definitions_present' },
        ],
    }, symbols });
    const caller = registry.symbols.find(symbol => symbol.name === 'releaseSubscription')!;
    const callee = registry.symbols.find(symbol => symbol.name === 'destroyBuffer')!;
    const records: RelationshipRecord[] = [{ type: 'CALLS', confidence, file: caller.file,
        sourceKey: caller.symbolKey, sourceInstanceId: caller.symbolInstanceId,
        targetKey: callee.symbolKey, targetInstanceId: callee.symbolInstanceId }];
    const navigationRoot = path.join(root, id, 'navigation');
    await stagePublicationNavigation({ publicationId: id, navigationRoot, registry, records,
        analysisByFile: new Map([['effects.ts', { moduleBindings: analysis.moduleBindings,
            callSites: analysis.callSites, receiverTypeBindings: analysis.receiverTypeBindings }]]) });
    return { registry, navigationRoot, ref: { id, publication: { canonicalRoot: root } } as PublicationRef };
}

function service(root: string) {
    return new RepositoryVocabularyService({ isReadAdmitted: () => true,
        getNavigationAddress: ref => ({ publicationId: ref.id, navigationRoot: path.join(root, ref.id, 'navigation') }) });
}

test('source phrases resolve a member with parent provenance and survive symbol publication', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocab-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await stage(root, 'first');
    const result = await service(root).lookup(fixture.ref, 'convert a single column to a numerical array');
    assert.equal(result.status, 'ok');
    assert.equal(result.matches[0]?.qualifiedName, 'Series.to_numpy');
    assert.ok(result.matches[0]?.evidence.some(link => link.via === 'parent' && link.term === 'single'));
    assert.ok(result.matches[0]?.evidence.every(link => link.fileHash === vocabularyHash(source) && link.line > 0));
    const read = await readSymbolRegistrySidecar({ normalizedRootPath: root, publicationId: fixture.ref.id,
        navigationRoot: fixture.navigationRoot });
    assert.equal(read.status, 'ok');
    if (read.status === 'ok') assert.deepEqual(read.registry.symbols, fixture.registry.symbols);
});

test('resolved high-confidence calls carry caller context; low-confidence calls do not', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocab-call-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const high = await stage(root, 'high');
    const low = await stage(root, 'low', source, 'low');
    const lookup = service(root);
    const strong = await lookup.lookup(high.ref, 'release subscriptions cleanup');
    const weak = await lookup.lookup(low.ref, 'release subscriptions cleanup');
    const callee = strong.matches.find(match => match.qualifiedName === 'destroyBuffer');
    assert.ok(callee?.evidence.some(link => link.via === 'call' && link.symbolInstanceId !== callee.symbolInstanceId));
    assert.ok(!weak.matches.some(match => match.qualifiedName === 'destroyBuffer'));
});

test('cached and cold lookup agree; new generations invalidate changed comment evidence', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocab-generation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = await stage(root, 'first');
    const lookup = service(root);
    const cold = await lookup.lookup(first.ref, 'release subscriptions cleanup');
    assert.deepEqual(await lookup.lookup(first.ref, 'release subscriptions cleanup'), cold);
    assert.deepEqual(await service(root).lookup(first.ref, 'release subscriptions cleanup'), cold);
    const expected = structuredClone(cold);
    const callerOwned = await lookup.lookup(first.ref, 'release subscriptions cleanup');
    callerOwned.matches[0]!.evidence[0]!.term = 'changed_by_consumer';
    assert.deepEqual(await lookup.lookup(first.ref, 'release subscriptions cleanup'), expected,
        'returned provenance must not expose mutable cached evidence');
    const second = await stage(root, 'second', source.replace('Release subscriptions during cleanup.', 'Reconnect sockets during startup.'));
    const fresh = await lookup.lookup(second.ref, 'subscriptions cleanup');
    assert.deepEqual(fresh.matches, [], 'the previous generation comment must not survive');
    assert.notEqual((await lookup.lookup(second.ref, 'reconnect sockets startup')).artifactHash, cold.artifactHash);
    assert.deepEqual(await lookup.lookup(first.ref, 'release subscriptions cleanup'), cold,
        'an older leased generation retains its own vocabulary');
});

test('scope predicates and read admission apply even to a cached generation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocab-scope-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await stage(root, 'first');
    let admitted = true;
    const lookup = new RepositoryVocabularyService({ isReadAdmitted: () => admitted,
        getNavigationAddress: () => ({ publicationId: fixture.ref.id, navigationRoot: fixture.navigationRoot }) });
    const unfiltered = await lookup.lookup(fixture.ref, 'convert single column numerical array');
    const owner = fixture.registry.symbols.find(symbol => symbol.qualifiedName === 'Series.to_numpy')!;
    const filtered = await lookup.lookup(fixture.ref, 'convert single column numerical array', 4,
        symbol => symbol.symbolInstanceId === owner.symbolInstanceId);
    assert.deepEqual(filtered.matches, unfiltered.matches.filter(match => match.symbolInstanceId === owner.symbolInstanceId));
    assert.deepEqual(filtered.terms, ['Series.to_numpy']);
    assert.deepEqual((await lookup.lookup(fixture.ref, 'convert single column numerical array', 4, () => false)).terms, []);
    admitted = false;
    assert.deepEqual(await lookup.lookup(fixture.ref, 'convert single column numerical array'), {
        status: 'incompatible', publicationId: 'first', terms: [], matches: [],
    });
});

test('missing, corrupt, foreign and oversized artifacts fall back without terms', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocab-invalid-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await stage(root, 'first');
    const file = path.join(fixture.navigationRoot, VOCABULARY_FILE);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('payloadHash', 'wrongHash'));
    assert.equal((await service(root).lookup(fixture.ref, 'subscriptions cleanup')).status, 'corrupt');
    const parsed = JSON.parse(original);
    parsed.index.publicationId = 'foreign';
    parsed.payloadHash = vocabularyHash(JSON.stringify(parsed.index));
    fs.writeFileSync(file, JSON.stringify(parsed));
    assert.equal((await service(root).lookup(fixture.ref, 'subscriptions cleanup')).status, 'incompatible');
    fs.truncateSync(file, MAX_VOCABULARY_BYTES + 1);
    assert.equal((await service(root).lookup(fixture.ref, 'subscriptions cleanup')).status, 'budget_exceeded');
    fs.unlinkSync(file);
    assert.deepEqual(await service(root).lookup(fixture.ref, 'subscriptions cleanup'), {
        status: 'missing', publicationId: 'first', terms: [], matches: [],
    });
});

test('synthetic display names are not automatic aliases and do not crowd out valid identifiers', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocab-alias-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const content = [
        'describe("budget dashboard", () => {',
        '  it("renders summary totals", () => {',
        '    expect(renderBudget()).toBeTruthy();',
        '  });',
        '});',
        'function renderBudget() { return summarizeTotals(); }',
        'function summarizeTotals() { return 0; }',
    ].join('\n');
    const analyzer = createLanguageAnalysisService();
    const analysis = await analyzer.analyze({ content, relativePath: 'dashboard.js', language: 'javascript' });
    await analyzer.dispose?.();
    const hash = vocabularyHash(content);
    const symbols = withSourceVocabulary(buildSymbolRecordsForFile({ relativePath: 'dashboard.js', content,
        language: 'javascript', fileHash: hash, extractorVersion: 'fixture',
        extractedSymbols: analysis.symbols, chunks: [...analysis.chunks] }), content);
    assert.ok(symbols.some(symbol => symbol.qualifiedName.includes('callback')),
        'fixture must contain a synthetic callback qualified name');
    const registry = buildSymbolRegistry({ manifest: {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: root, rootFingerprint: 'fixture',
        indexPolicyHash: 'policy', languageRouterVersion: 'router', extractorVersion: 'fixture',
        relationshipVersion: 'fixture', builtAt: new Date(0).toISOString(), files: [
            { path: 'dashboard.js', hash, language: 'javascript', symbolCount: symbols.length,
                definitionStatus: 'definitions_present' },
        ],
    }, symbols });
    const navigationRoot = path.join(root, 'first', 'navigation');
    await stagePublicationNavigation({ publicationId: 'first', navigationRoot, registry, records: [],
        analysisByFile: new Map([['dashboard.js', { moduleBindings: analysis.moduleBindings,
            callSites: analysis.callSites, receiverTypeBindings: analysis.receiverTypeBindings }]]) });
    const ref = { id: 'first', publication: { canonicalRoot: root } } as PublicationRef;
    const result = await service(root).lookup(ref, 'renders summary totals render budget');
    assert.equal(result.status, 'ok');
    assert.ok(result.matches.some(match => match.qualifiedName === 'renderBudget'),
        `valid identifier must survive: ${result.matches.map(match => match.qualifiedName)}`);
    assert.ok(result.matches.every(match => !match.qualifiedName.includes('callback')
        && !match.qualifiedName.includes('"')),
        `display names must not occupy match slots: ${result.matches.map(match => match.qualifiedName)}`);
    assert.ok(result.terms.includes('renderBudget'));
    assert.ok(result.terms.every(term => term.length <= 128 && !/["\s()]/.test(term)),
        `aliases must be usable identifiers: ${result.terms}`);
});

test('a vocabulary write failure cleans staging and cannot publish partial navigation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-vocab-write-failure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = fs.promises.writeFile;
    t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof fs.promises.writeFile>) => {
        if (String(args[0]).endsWith(VOCABULARY_FILE)) throw new Error('injected vocabulary write failure');
        return original(...args);
    });
    await assert.rejects(stage(root, 'failed'), /injected vocabulary write failure/);
    assert.ok(!fs.existsSync(path.join(root, 'failed', 'navigation')));
    assert.deepEqual(fs.existsSync(path.join(root, 'failed')) ? fs.readdirSync(path.join(root, 'failed')) : [], []);
});
