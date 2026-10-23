import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bounded, read-only S1 replay. No production modules or publication bytes change.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const targetId = 'syminst_7f5c7474f60b3f5212f5f28660888d3d';
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/s1-normalization-trace.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = [
    ...['search-symbol-metadata-bm25', 'search-file-symbol-supplement', 'search-definition-discovery',
        'search-query-planning', 'search-ranking-policy', 'search-query-support', 'search-rerank-projection',
        'search-rerank-execution', 'search-request-coordinator', 'current-source-symbols', 'inspectable-source']
        .map(name => `packages/mcp/src/core/${name}.ts`),
    'packages/core/src/symbols/sidecar-reads.ts', 'packages/core/src/symbols/registry.ts',
];
const load = relative => import(pathToFileURL(path.join(repo, relative)).href);
function once(source, anchor, replacement) {
    assert.equal(source.split(anchor).length - 1, 1, `Source drift: ${anchor.slice(0, 90)}`);
    return source.replace(anchor, replacement);
}

// These deliberately small trial rules are not an established English stemmer.
function stem(word, role) {
    let value = word;
    if (value.length > 4 && value.endsWith('ies')) value = value.slice(0, -3) + 'y';
    else if (/(?:ches|shes|xes|zes|sses)$/.test(value)) value = value.slice(0, -2);
    else if (value.length > 3 && value.endsWith('s') && !/(?:ss|us|is)$/.test(value)) value = value.slice(0, -1);
    if (role) {
        if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
        else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
        else if (value.length > 4 && /(?:er|or)$/.test(value)) value = value.slice(0, -2);
        if (value.length > 3 && value.endsWith('e')) value = value.slice(0, -1);
    }
    return value;
}
const supplementTokenizer = `function normalizedTerms(value: string): Set<string> {
    return new Set((value + " " + value.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean)
        .map((term) => term.replace(/(?:ing|ed|s)$/, "")));
}`;

async function main() {
    const args = process.argv.slice(2);
    assert.equal(args.length, 4, 'Use --navigation-root ABS --out ABS');
    assert.equal(args[0], '--navigation-root');
    assert.equal(args[2], '--out');
    const navigationRoot = args[1];
    const out = args[3];
    assert(path.isAbsolute(navigationRoot) && path.isAbsolute(out));
    const fixtureBytes = await fs.readFile(fixturePath);
    const fixture = JSON.parse(fixtureBytes);
    assert.equal(path.basename(navigationRoot), 'navigation');
    assert.equal(fixture.publicationId, path.basename(path.dirname(navigationRoot)), 'Mismatched publication');
    assert.equal(fixture.publicationId, path.basename(path.dirname(await fs.realpath(navigationRoot))), 'Mismatched resolved publication');
    assert.equal(fixture.collection, `hybrid_code_chunks_e7db2afe__gen_${fixture.publicationId.replaceAll('-', '_')}`);
    const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, await fs.readFile(path.join(repo, name), 'utf8')])));
    const result = {
        schemaVersion: 1, workerId: '975de061c229', model: 'gpt-6.1-sol', reasoningEffort: 'medium', query: fixture.query, targetId,
        fixture: { path: fixturePath, sha256: sha256(fixtureBytes) },
        sourceSHA256: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, sha256(text)])),
        scriptSHA256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
        caveats: [
            'Additive aliases change BM25 length and IDF. They do not guarantee exact-match preference.',
            'Role suffix rules are small trial rules, not an established English stemmer. No S1 exceptions.',
            'Frozen fusion windows measure neither grouped output nor end-to-end success.',
            'Runtime scope and no operators/subdirectory are replay assumptions. The predicate is the actual production helper.',
        ],
    };
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'satori-s1-normalization-source-'));
    let connection;
    let table;
    try {
        const sidecars = await load('packages/core/src/symbols/sidecar-reads.ts');
        const state = await sidecars.readSymbolRegistrySidecar({ normalizedRootPath: repo, publicationId: fixture.publicationId, navigationRoot });
        assert.equal(state.status, 'ok', `Sidecar read failed: ${state.reason}`);
        const registry = state.registry;
        assert.equal(await fs.realpath(registry.manifest.normalizedRootPath), await fs.realpath(repo), 'Registry root mismatch');
        const target = registry.symbolsByInstanceId.get(targetId);
        assert(target, 'Target absent from publication');
        result.publication = {
            id: fixture.publicationId, navigationRoot, collection: fixture.collection,
            manifestHash: state.manifestHash,
            manifestSHA256: sha256(await fs.readFile(path.join(navigationRoot, 'manifest.json'))),
            symbols: registry.symbols.length, files: registry.manifest.files.length, warnings: state.warnings,
        };
        const bmPath = 'packages/mcp/src/core/search-symbol-metadata-bm25.ts';
        const supPath = 'packages/mcp/src/core/search-file-symbol-supplement.ts';
        const defPath = 'packages/mcp/src/core/search-definition-discovery.ts';
        const req = createRequire(path.join(repo, 'packages/mcp/package.json'));
        const rewriteImports = (text, original) => text.replace(/(from\s+["'])([^"']+)(["'])/g, (whole, prefix, specifier, suffix) => {
            if (specifier.startsWith('node:')) return whole;
            const resolved = specifier.startsWith('.')
                ? path.resolve(path.dirname(path.join(repo, original)), specifier).replace(/\.js$/, '.ts')
                : req.resolve(specifier);
            return prefix + resolved + suffix;
        });
        const variants = {};
        for (const name of ['baseline', 'plural-additive', 'role-additive']) {
            const role = name === 'role-additive';
            let bm = sources[bmPath];
            let sup = sources[supPath];
            let def = sources[defPath];
            if (name !== 'baseline') {
                bm = once(bm, 'export function tokenizeMetadataField(value: string): string[] {', 'function productionTokenizeMetadataField(value: string): string[] {');
                bm += `\n${stem.toString()}\nexport function tokenizeMetadataField(value: string): string[] {
    const original = productionTokenizeMetadataField(value);
    return [...original, ...original.filter(term => /^[a-z]+$/.test(term) && term.length >= 4)
        .map(term => '~stem:' + stem(term, ${role}))];
}\n`;
                sup = once(sup, supplementTokenizer, `function normalizedTerms(value: string): Set<string> {
    return new Set((value + " " + value.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean).map(term => stem(term, ${role})));
}\n${stem.toString()}`);
            } else assert.equal(sup.split(supplementTokenizer).length - 1, 1, 'Baseline tokenizer drift');
            // Reuse the literal production file-selection block for diagnostics.
            const selectionStart = '    const files = [...new Set(input.candidates.map((candidate) => candidate.relativePath))]';
            const selectionEnd = '    const results: SearchResultLike[] = [];';
            assert.equal(sup.split(selectionStart).length - 1, 1);
            assert.equal(sup.split(selectionEnd).length - 1, 1);
            const selection = sup.slice(sup.indexOf(selectionStart), sup.indexOf(selectionEnd));
            // Extract production prerequisites, eligibility, scores, and sorting unchanged.
            const extract = (start, end) => {
                assert.equal(sup.split(start).length - 1, 1, `Ranking source drift: ${start}`);
                assert.equal(sup.split(end).length - 1, 1, `Ranking source drift: ${end}`);
                assert(sup.indexOf(end) > sup.indexOf(start));
                return sup.slice(sup.indexOf(start), sup.indexOf(end));
            };
            const rankedBlock = extract('        const lines = evidence.source.split(/\\r?\\n/);',
                '        for (const { symbol, content } of ranked.slice(0, MAX_SYMBOLS_PER_FILE)) {');
            const lexicalBlock = extract('            const content = lines.slice(symbol.span.startLine - 1, symbol.span.endLine).join("\\n");',
                '            if (matched.length < 2 || !matched.some((term) => !pathTerms.has(term))) return [];');
            const rowBlock = extract('            return [{ symbol, content, matches: matched.length,', '        }).sort((left, right) => right.matches - left.matches');
            assert(rowBlock.startsWith('            return ') && rowBlock.endsWith(';\n'));
            const rowExpression = rowBlock.slice('            return '.length, -2);
            sup += `\nexport { normalizedTerms };\nexport function experimentSelectedFiles(input: any, queryTerms: Set<string>) {\n${selection}\nreturn files;\n}\n`;
            sup += `\nexport function experimentFileRanking(input: any, file: string, evidence: any, queryTerms: Set<string>, target: any) {
${rankedBlock}
    const describeTarget = (symbol: any) => {
${lexicalBlock}
        const rows = ${rowExpression};
        return { ...rows[0], matched };
    };
    return { ranked, target: describeTarget(target), maxSymbolsPerFile: MAX_SYMBOLS_PER_FILE };
}\n`;
            const bmFile = path.join(scratch, `${name}-bm.ts`);
            const supFile = path.join(scratch, `${name}-supplement.ts`);
            const defFile = path.join(scratch, `${name}-fusion.ts`);
            def = once(def, 'from "./search-symbol-metadata-bm25.js"', `from ${JSON.stringify(bmFile)}`);
            await fs.writeFile(bmFile, rewriteImports(bm, bmPath));
            await fs.writeFile(supFile, rewriteImports(sup, supPath));
            await fs.writeFile(defFile, rewriteImports(def, defPath));
            variants[name] = { bm: await import(pathToFileURL(bmFile).href), sup: await import(pathToFileURL(supFile).href), def: await import(pathToFileURL(defFile).href) };
        }
        const planning = await load('packages/mcp/src/core/search-query-planning.ts');
        const policy = await load('packages/mcp/src/core/search-ranking-policy.ts');
        const { SearchQuerySupport } = await load('packages/mcp/src/core/search-query-support.ts');
        const support = new SearchQuerySupport({ classifyPathCategory: policy.classifyPathCategory, shouldIncludeCategoryInScope: policy.shouldIncludeCategoryInScope });
        const parsedOperators = planning.parseSearchOperators(fixture.query);
        const runtime = support.buildExactRegistrySymbolFilter({ scope: 'runtime', parsedOperators });
        const filters = {
            allSymbols: () => true,
            productionRuntime: runtime,
            packagesNonTestRuntime: symbol => symbol.file.startsWith('packages/') && runtime(symbol) && !policy.isTestPath(policy.normalizeSearchPath(symbol.file)),
        };
        result.filterDefinitions = { allSymbols: 'All named non-file symbols', productionRuntime: 'Production buildExactRegistrySymbolFilter, runtime, parsed original query, no subdirectory', packagesNonTestRuntime: 'Explicit diagnostic filter: productionRuntime AND packages/ prefix AND NOT production isTestPath. Not the request predicate.' };
        result.metadata = {};
        for (const [name, { bm }] of Object.entries(variants)) {
            const queryTerms = [...new Set(bm.tokenizeMetadataField(fixture.query))];
            const targetTerms = new Set([target.name, target.qualifiedName, target.file].flatMap(value => bm.tokenizeMetadataField(value)));
            const report = { queryTerms, targetMatchingUniqueTerms: queryTerms.filter(term => targetTerms.has(term)), filters: {} };
            for (const [filter, accepts] of Object.entries(filters)) {
                const ranked = bm.rankSymbolMetadataBm25({ registry, registryManifestHash: state.manifestHash, query: fixture.query, limit: registry.symbols.length, accepts });
                const index = ranked.findIndex(row => row.symbol.symbolInstanceId === targetId);
                report.filters[filter] = { eligible: registry.symbols.filter(symbol => symbol.kind !== 'file' && symbol.name && accepts(symbol)).length, matching: ranked.length, targetRank: index < 0 ? null : index + 1, top12: ranked.slice(0, 12).map(({ symbol, score }) => ({ name: symbol.name, file: symbol.file, id: symbol.symbolInstanceId, score })) };
            }
            result.metadata[name] = report;
        }
        const observedBaseline = result.metadata.baseline.filters.packagesNonTestRuntime;
        result.earlierBaseline = { expected: { targetRank: 824, matching: 1386 }, observed: { targetRank: observedBaseline.targetRank, matching: observedBaseline.matching }, exact: observedBaseline.targetRank === 824 && observedBaseline.matching === 1386, tuning: false };

        const stage = (capture, name) => {
            const found = capture.stages.filter(item => item.stage === name);
            assert.equal(found.length, 1);
            assert.equal(found[0].total, found[0].candidates.length, 'Truncated capture');
            return found[0].candidates;
        };
        const ids = [...new Set(Object.values(fixture.variants).flatMap(capture => capture.stages.flatMap(item => item.candidates.map(row => row.id))))];
        const persistedIds = ids.filter(id => /^chunk_[a-f0-9]+$/.test(id));
        const coreRequire = createRequire(path.join(repo, 'packages/core/package.json'));
        const lance = coreRequire('@lancedb/lancedb');
        const vectorRoot = path.join(os.homedir(), '.satori/vector/lancedb');
        connection = await lance.connect(vectorRoot);
        table = await connection.openTable(fixture.collection);
        const rows = await table.query().where(`id IN (${persistedIds.map(id => `'${id}'`).join(',')})`)
            .select(['id', 'content', 'relativePath', 'startLine', 'endLine', 'metadataJson', 'contentHash']).limit(persistedIds.length).toArray();
        const candidates = new Map(rows.map(row => [row.id, { ...JSON.parse(row.metadataJson), ...row }]));
        assert.equal(candidates.size, rows.length, 'Duplicated vector rows');
        const { readCurrentSourceEvidence } = await load('packages/mcp/src/core/current-source-symbols.ts');
        result.vector = { root: vectorRoot, fixtureIds: ids.length, requestedIds: persistedIds.length, returnedRows: rows.length, missingPersistedIds: persistedIds.filter(id => !candidates.has(id)), filter: 'Only persisted fixture candidate IDs', candidates: [] };
        for (const id of ids) {
            const descriptor = fixture.candidateDescriptors[id];
            assert(descriptor, `Missing captured descriptor: ${id}`);
            const ownerId = JSON.parse(descriptor.ownerId);
            assert.equal(ownerId[1], descriptor.relativePath);
            assert(['symbol', 'file'].includes(ownerId[0]));
            assert.equal(ownerId.length, ownerId[0] === 'symbol' ? 3 : 2);
            const owner = ownerId[0] === 'symbol'
                ? registry.symbolsByInstanceId.get(ownerId[2])
                : registry.symbolsByFile.get(descriptor.relativePath)?.find(symbol => symbol.kind === 'file');
            assert(owner && owner.file === descriptor.relativePath, `Captured owner missing: ${id}`);
            let candidate = candidates.get(id);
            const lanceOwnerId = candidate?.ownerSymbolInstanceId ?? null;
            let origin = 'lance';
            let sourceHash = null;
            if (candidate) {
                assert.equal(candidate.relativePath, descriptor.relativePath, `Vector path drift: ${id}`);
                assert.equal(candidate.startLine, descriptor.startLine, `Vector span drift: ${id}`);
                assert.equal(candidate.endLine, descriptor.endLine, `Vector span drift: ${id}`);
            } else {
                origin = persistedIds.includes(id) ? 'captured-descriptor-source-missing-vector-row' : 'captured-descriptor-source';
                const evidence = await readCurrentSourceEvidence(repo, descriptor.relativePath);
                assert(evidence, `Source unavailable: ${id}`);
                const manifestFile = registry.manifest.files.find(file => file.path === descriptor.relativePath);
                assert.equal(evidence.observedHash, manifestFile?.hash, `Source hash drift: ${id}`);
                assert.equal(evidence.observedHash, owner.fileHash, `Owner hash drift: ${id}`);
                sourceHash = evidence.observedHash;
                const lines = evidence.source.split(/\r?\n/);
                assert(Number.isInteger(descriptor.startLine) && Number.isInteger(descriptor.endLine)
                    && descriptor.startLine >= 1 && descriptor.endLine >= descriptor.startLine && descriptor.endLine <= lines.length, `Invalid captured span: ${id}`);
                const aligned = descriptor.startLine === owner.span.startLine && descriptor.endLine === owner.span.endLine;
                candidate = { id, relativePath: descriptor.relativePath, startLine: descriptor.startLine, endLine: descriptor.endLine,
                    language: owner.language, content: lines.slice(descriptor.startLine - 1, descriptor.endLine).join('\n'),
                    ...(aligned ? { startByte: owner.span.startByte, endByte: owner.span.endByte } : {}),
                };
            }
            // Trace ownership is authoritative after production owner resolution.
            candidate = { ...candidate, ownerSymbolInstanceId: owner.symbolInstanceId, ownerSymbolKey: owner.symbolKey, symbolKind: owner.kind, symbolLabel: owner.label };
            candidates.set(id, candidate);
            result.vector.candidates.push({ id, origin, file: candidate.relativePath, startLine: candidate.startLine, endLine: candidate.endLine,
                startByte: candidate.startByte, endByte: candidate.endByte, ownerSymbolInstanceId: candidate.ownerSymbolInstanceId,
                ownerSymbolKey: candidate.ownerSymbolKey, symbolLabel: candidate.symbolLabel, lanceOwnerId,
                traceOwnerDiffersFromLance: lanceOwnerId !== null && lanceOwnerId !== owner.symbolInstanceId,
                sourceHash, contentSHA256: sha256(candidate.content), storedContentHash: candidate.contentHash ?? null });
        }
        const baselineCandidates = stage(fixture.variants.baseline, 'mcp_fusion').map(row => candidates.get(row.id));
        const plan = planning.buildSearchQueryPlan(fixture.query, true, parsedOperators);
        result.supplement = { inputStage: 'mcp_fusion', inputCount: baselineCandidates.length, lexicalTerms: plan.lexicalTerms, variants: {} };
        for (const [name, { sup }] of Object.entries(variants)) {
            const reads = [];
            const queryTerms = new Set(plan.lexicalTerms.filter(term => term.kind === 'whole').flatMap(term => [...sup.normalizedTerms(term.value)]));
            const selectedFiles = queryTerms.size < 2 ? [] : sup.experimentSelectedFiles({ candidates: baselineCandidates, registry }, queryTerms);
            const returned = await sup.supplementSearchFileSymbols({ candidates: baselineCandidates, lexicalTerms: plan.lexicalTerms, registry, codebaseRoot: repo,
                readSourceEvidence: async (root, file) => {
                    const evidence = await readCurrentSourceEvidence(root, file);
                    const manifestHash = registry.manifest.files.find(entry => entry.path === file)?.hash;
                    reads.push({ file, observedHash: evidence?.observedHash ?? null, manifestHash, hashAccepted: Boolean(evidence && evidence.relativeFile === file && evidence.observedHash === manifestHash) });
                    return evidence;
                },
            });
            let controlReads = 0;
            const control = await sup.supplementSearchFileSymbols({ candidates: baselineCandidates, lexicalTerms: [{ kind: 'whole', value: 'search' }], registry, codebaseRoot: repo, readSourceEvidence: async () => { controlReads++; throw new Error('Single-term control must not read'); } });
            assert.equal(control.length, 0);
            assert.equal(controlReads, 0);
            const targetEvidence = await readCurrentSourceEvidence(repo, target.file);
            const targetHashAccepted = targetEvidence?.observedHash === target.fileHash && target.fileHash === registry.manifest.files.find(entry => entry.path === target.file)?.hash;
            assert(targetHashAccepted, `Diagnostic source hash rejected: ${target.file}`);
            const diagnostic = sup.experimentFileRanking({ registry }, target.file, targetEvidence, queryTerms, target);
            const targetIndex = diagnostic.ranked.findIndex(row => row.symbol.symbolInstanceId === targetId);
            const targetMatches = diagnostic.target.matched;
            const targetWithinFile = {
                file: target.file, separateFromSupplement: true, eligible: targetIndex >= 0,
                matchedTerms: targetMatches, matches: diagnostic.target.matches, nameMatches: diagnostic.target.nameMatches,
                rankBeforeCut: targetIndex < 0 ? null : targetIndex + 1,
                eligibleSymbolCount: diagnostic.ranked.length, maxSymbolsPerFile: diagnostic.maxSymbolsPerFile,
                excludedBySixSymbolCut: targetIndex >= diagnostic.maxSymbolsPerFile,
                top6: diagnostic.ranked.slice(0, diagnostic.maxSymbolsPerFile).map(row => ({ name: row.symbol.name, id: row.symbol.symbolInstanceId, matches: row.matches, nameMatches: row.nameMatches })),
            };
            result.supplement.variants[name] = { canonicalQueryTerms: [...queryTerms], selectedFiles, sourceReads: reads, handlersSelected: selectedFiles.includes(target.file), handlersRead: reads.some(row => row.file === target.file), targetDiagnosticRead: { file: target.file, hashAccepted: targetHashAccepted, observedHash: targetEvidence?.observedHash ?? null, separateFromSupplement: true }, targetMatches, targetBelowTwoTermThreshold: targetMatches.length < 2, targetWithinFile, targetAdmitted: returned.some(row => row.ownerSymbolInstanceId === targetId), returnedCount: returned.length, perFile: selectedFiles.map(file => ({ file, returned: returned.filter(row => row.relativePath === file).length })), returned: returned.map(row => ({ label: row.symbolLabel, file: row.relativePath, ownerId: row.ownerSymbolInstanceId, startLine: row.startLine, endLine: row.endLine })), singleTermControl: { query: 'search', canonicalTerms: [...sup.normalizedTerms('search')], returned: control.length, reads: controlReads } };
        }
        const { resolveCanonicalOwner } = await load('packages/mcp/src/core/search-rerank-projection.ts');
        const metadataFor = candidate => {
            const owner = resolveCanonicalOwner(candidate, registry);
            if (owner?.file === candidate.relativePath) return owner;
            if (candidate.symbolKind !== 'file') return undefined;
            return registry.symbolsByFile.get(candidate.relativePath)?.find(symbol => symbol.kind === 'file');
        };
        result.fusion = {};
        for (const [captureName, capture] of Object.entries(fixture.variants)) {
            const window = stage(capture, 'reranker_input');
            const positions = new Map(window.map((row, index) => [row.id, index]));
            const provider = stage(capture, 'reranker_provider_output');
            const expected = stage(capture, 'reranker_fusion_output');
            const items = provider.map(row => ({ id: row.id, originalIndex: positions.get(row.id), providerRank: row.rank, relevanceScore: row.score }));
            assert(items.every(row => Number.isInteger(row.originalIndex)));
            const query = [fixture.query, ...capture.callerTerms].join(' ');
            const replay = def => def.fuseDefinitionDiscovery({ items, query, metadata: index => metadataFor(candidates.get(window[index].id)) });
            const baseline = replay(variants.baseline.def);
            const actual = baseline.items.map(row => row.id);
            const exact = JSON.stringify(actual) === JSON.stringify(expected.map(row => row.id)) && baseline.items.every(row => row.relevanceScore === expected.find(item => item.id === row.id)?.score);
            const arm = { query, callerTerms: capture.callerTerms, window: window.length, exactBaselineReproduction: exact, targetPresent: window.some(row => candidates.get(row.id).ownerSymbolInstanceId === targetId), metadataMissing: window.filter(row => !metadataFor(candidates.get(row.id))).length };
            result.fusion[captureName] = arm;
            if (!exact) {
                arm.status = 'failure: baseline capture mismatch; stop this arm';
                arm.firstMismatch = expected.findIndex((row, index) => row.id !== actual[index]);
                continue;
            }
            arm.status = 'ok';
            arm.variants = {};
            const targetRank = ordered => { const index = ordered.findIndex(row => candidates.get(row.id).ownerSymbolInstanceId === targetId); return index < 0 ? null : index + 1; };
            const baselineRank = targetRank(baseline.items);
            for (const [name, { def }] of Object.entries(variants)) {
                const fused = name === 'baseline' ? baseline : replay(def);
                const rank = targetRank(fused.items);
                arm.variants[name] = { targetRank: rank, deltaFromBaseline: rank === null || baselineRank === null ? null : rank - baselineRank, applied: fused.applied, order: fused.items.map(row => ({ id: row.id, originalIndex: row.originalIndex, providerRank: row.providerRank })) };
                if (!arm.targetPresent) assert.equal(rank, null, 'Fusion admitted absent target');
            }
        }
        const groups = ['handler/handle/handlers', 'group/grouped/grouping', 'coordinator/coordinate', 'user/use', 'server/serve', 'buffer/buff', 'bus/buses', 'class/classes', 'process/processes', 'status/statuses', 'business/businesses'];
        result.controls = groups.map(group => ({ group, words: group.split('/').map(word => ({ word, plural: stem(word, false), role: stem(word, true), metadataAliasEligible: /^[a-z]+$/.test(word) && word.length >= 4 })), pluralCollision: new Set(group.split('/').map(word => stem(word, false))).size === 1, roleCollision: new Set(group.split('/').map(word => stem(word, true))).size === 1 }));
        assert.equal(sha256(await fs.readFile(fixturePath)), result.fixture.sha256, 'Fixture changed during replay');
        for (const [name, hash] of Object.entries(result.sourceSHA256)) {
            assert.equal(sha256(await fs.readFile(path.join(repo, name))), hash, `Implementation changed during replay: ${name}`);
        }
        assert.equal(sha256(await fs.readFile(path.join(navigationRoot, 'manifest.json'))), result.publication.manifestSHA256, 'Manifest changed during replay');
        result.inputHashesRechecked = true;
        result.status = Object.values(result.fusion).every(arm => arm.exactBaselineReproduction) ? 'ok' : 'fusion-baseline-reproduction-failure';
        await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ status: result.status, out, metadata: Object.fromEntries(Object.entries(result.metadata).map(([name, report]) => [name, report.filters.packagesNonTestRuntime])), supplement: Object.fromEntries(Object.entries(result.supplement.variants).map(([name, report]) => [name, { targetAdmitted: report.targetAdmitted, returned: report.returnedCount, targetMatches: report.targetMatches, handlersRead: report.handlersRead }])), fusion: Object.fromEntries(Object.entries(result.fusion).map(([name, arm]) => [name, { exact: arm.exactBaselineReproduction, status: arm.status, targetRanks: arm.variants && Object.fromEntries(Object.entries(arm.variants).map(([variant, report]) => [variant, report.targetRank])) }])) }, (key, value) => key === 'top12' ? undefined : value, 2));
    } catch (error) {
        result.status = 'failure';
        result.failure = { message: error.message, stack: error.stack };
        await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
        throw error;
    } finally {
        table?.close();
        connection?.close();
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

await main();
