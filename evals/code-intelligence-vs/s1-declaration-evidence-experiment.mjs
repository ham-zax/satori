import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bounded, read-only declaration-evidence ordering experiment. No production
// module, publication, index, documentation, or prior fixture changes.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const experimentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(experimentDir, 'fixtures/s1-declaration-evidence-cases.json');
const priorScriptPath = path.join(experimentDir, 's1-normalization-experiment.mjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sha256Of = async file => sha256(await fs.readFile(file));
const load = relative => import(pathToFileURL(path.join(repo, relative)).href);
const sourcePaths = [
    ...['search-file-symbol-supplement', 'search-lexical-scoring', 'current-source-symbols', 'search-query-planning']
        .map(name => `packages/mcp/src/core/${name}.ts`),
    'packages/core/src/symbols/contracts.ts', 'packages/core/src/symbols/registry.ts',
    'packages/core/src/symbols/sidecar-reads.ts', 'packages/core/src/language-analysis/service.ts',
    'packages/core/src/language-analysis/flow-recovery.ts', 'packages/core/src/language-analysis/versions.ts',
    'packages/core/src/language/registry.ts',
];
const ORDER_BY_KEY = {
    'total-evidence-first': (a, b) => b.matches - a.matches || b.nameMatches - a.nameMatches || a.startLine - b.startLine,
    'name-first': (a, b) => b.nameMatches - a.nameMatches || b.matches - a.matches || a.startLine - b.startLine,
};
const TOKENIZERS = ['baseline', 'role-additive'];
const ORDERS = ['total-evidence-first', 'name-first'];
const callable = symbol => symbol.kind === 'function' || symbol.kind === 'method';
const isTarget = (symbol, id) => symbol.symbolInstanceId === id;
const projectReturned = returned => returned.map(row => ({
    label: row.symbolLabel, file: row.relativePath, ownerId: row.ownerSymbolInstanceId ?? null,
    startLine: row.startLine, endLine: row.endLine,
}));
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const tokenName = name => name === 'role-additive' ? 'role' : name;
const variantKey = (tokenizer, order) => `${tokenName(tokenizer)}/${order}`;

function once(source, anchor, replacement, label) {
    assert.equal(source.split(anchor).length - 1, 1, `Source drift: ${label}`);
    return source.replace(anchor, replacement);
}

function extract(source, start, end, label) {
    assert.equal(source.split(start).length - 1, 1, `Extraction start drift: ${label}`);
    assert.equal(source.split(end).length - 1, 1, `Extraction end drift: ${label}`);
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end);
    assert(endIndex > startIndex, `Extraction order drift: ${label}`);
    return source.slice(startIndex, endIndex);
}

function compileAcceptable(acceptable) {
    return acceptable.map((entry, index) => ({
        index, pathRegex: entry.pathRegex, symbolRegex: entry.symbolRegex,
        path: new RegExp(entry.pathRegex),
        symbol: entry.symbolRegex === null ? null : new RegExp(entry.symbolRegex),
    }));
}

function spanSupport(symbol, content, manifestHash) {
    const lines = content.split(/\r?\n/);
    const { startLine, endLine } = symbol.span;
    const spanValid = Number.isInteger(startLine) && Number.isInteger(endLine)
        && startLine >= 1 && endLine >= startLine && endLine <= lines.length;
    const escaped = symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePresent = spanValid
        && new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(lines.slice(startLine - 1, endLine).join('\n'));
    const fileHashMatches = symbol.fileHash === manifestHash;
    return { spanValid, namePresent, fileHashMatches, sourceSupported: spanValid && namePresent && fileHashMatches };
}

function orderingOutcome(totalPosition, namePosition) {
    if (totalPosition === null && namePosition === null) return 'unchanged';
    if (totalPosition !== null && namePosition === null) return 'loss';
    if (totalPosition === null && namePosition !== null) return 'gain';
    if (namePosition < totalPosition) return 'gain';
    if (namePosition > totalPosition) return 'loss';
    return 'unchanged';
}

async function main() {
    const args = process.argv.slice(2);
    assert.equal(args.length, 2, 'Use --out ABS');
    assert.equal(args[0], '--out');
    const out = args[1];
    assert(path.isAbsolute(out), '--out must be absolute');
    await fs.access(out).then(
        () => assert.fail(`Refusing to overwrite existing output: ${out}`),
        () => {},
    );

    const fixtureBytes = await fs.readFile(fixturePath);
    const fixture = JSON.parse(fixtureBytes);
    const tracePath = path.join(repo, fixture.s1.traceFixture);
    const priorResultPath = path.join(repo, fixture.s1.priorResult);
    const casesPath = path.join(repo, 'evals/real-repo-quality/cases.json');
    const supplementPath = path.join(repo, 'packages/mcp/src/core/search-file-symbol-supplement.ts');
    const supplementSource = await fs.readFile(supplementPath, 'utf8');
    const traceBytes = await fs.readFile(tracePath);
    const trace = JSON.parse(traceBytes);
    const priorResult = JSON.parse(await fs.readFile(priorResultPath, 'utf8'));
    const cases = JSON.parse(await fs.readFile(casesPath, 'utf8'));
    assert.equal(trace.query, fixture.s1.query, 'Frozen S1 query drift');
    const reactQuerySource = cases.repos.find(item => item.name === 'react')?.queries ?? [];
    for (const caseDef of fixture.external.react.cases) {
        const source = reactQuerySource.find(item => item.id === caseDef.id);
        assert(source, `React oracle missing: ${caseDef.id}`);
        assert.equal(caseDef.query, source.query, `React query drift: ${caseDef.id}`);
        assert.deepEqual(caseDef.acceptable, source.acceptable, `React acceptable-owner drift: ${caseDef.id}`);
    }
    assert.equal(priorResult.publication.id, fixture.s1.publicationId, 'Prior publication drift');
    assert.equal(priorResult.publication.navigationRoot, fixture.s1.navigationRoot, 'Prior navigation root drift');
    const navigationRoot = fixture.s1.navigationRoot;
    assert(path.isAbsolute(navigationRoot));
    assert.equal(path.basename(navigationRoot), 'navigation');
    assert.equal(fixture.s1.publicationId, path.basename(path.dirname(await fs.realpath(navigationRoot))), 'Publication root mismatch');

    const result = {
        schemaVersion: 1,
        experiment: fixture.experiment,
        workerId: process.env.CLAIVE_WORKER_ID ?? null,
        model: process.env.PI_MODEL ?? null,
        status: 'running',
        claims: [
            'Compares exactly two supplement tokenizers x two sort orders on deliberately supplied file candidates.',
            'External React and FlatBuffers cases are oracle-assisted file probes, not real retrieval or end-to-end benchmarks.',
            'Role-additive normalization is an experimental prerequisite, not accepted production policy.',
            'No LateOn, fusion, grouped rank, Hit@10, 72-query quality, statistical generalization, index, or production repair is measured.',
            'The shipped order is TOTAL-EVIDENCE-FIRST: matches counts name terms and full source-span terms, including declarations and comments. It is not independent body-only evidence.',
        ],
        identities: {
            script: { path: path.relative(repo, fileURLToPath(import.meta.url)) },
            fixture: { path: path.relative(repo, fixturePath), sha256: sha256(fixtureBytes) },
            sources: Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, await sha256Of(path.join(repo, name))]))),
            inputs: {
                s1Trace: { path: path.relative(repo, tracePath), sha256: sha256(traceBytes) },
                s1PriorResult: { path: path.relative(repo, priorResultPath), sha256: await sha256Of(priorResultPath) },
                realRepoCases: { path: path.relative(repo, casesPath), sha256: await sha256Of(casesPath) },
            },
            publication: {
                id: fixture.s1.publicationId, navigationRoot,
                manifestSHA256: await sha256Of(path.join(navigationRoot, 'manifest.json')),
            },
            checkouts: {},
        },
        oraclesPreserved: {
            s1: 'header query unchanged from the frozen trace; target identity and file asserted against the real publication',
            react: 'r1,r2,r3,r4,r5,r8,r9 queries and all acceptable alternatives checked equal to evals/real-repo-quality/cases.json at runtime',
            flatbuffers: 'three predeclared queries and exact acceptable symbols; source responsibilities validated before scoring',
        },
        design: fixture.design,
        declaredScope: fixture.declaredScope,
        caveats: [
            'The shipped TOTAL-EVIDENCE-FIRST matches field is a union of name and full source-span terms; declaration and comment text counts.',
            'Eligibility and per-owner matches are tokenizer/query determined; the comparator only reorders, and the script asserts selection, hashes, eligibility, and match evidence are preserved across orders.',
            'Supplied React and FlatBuffers files are retrieval candidates by design. They measure the supplement boundary only.',
            'Recovered Flow parses can omit declarations. A target is unscorable only when missing, span-invalid, or unsupported by its source; recovered status alone is reported, not treated as failure.',
            'S1 rank 17 of 37 is a within-file rank before the six-symbol cut, not a grouped or end-to-end rank.',
        ],
    };

    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'satori-s1-declaration-evidence-'));
    let connection;
    let table;
    let written = false;
    const sourceHashes = {};
    const externalHashes = {};
    try {
        const core = await load('packages/core/src/index.ts');
        const planning = await load('packages/mcp/src/core/search-query-planning.ts');
        const { readCurrentSourceEvidence } = await load('packages/mcp/src/core/current-source-symbols.ts');
        const { readSymbolRegistrySidecar } = await load('packages/core/src/symbols/sidecar-reads.ts');
        const { buildSymbolRegistry, buildSymbolRecordsForFile } = core;
        const { computeSymbolRegistryManifestHash } = await load('packages/core/src/symbols/registry.ts');
        const analysisService = core.createLanguageAnalysisService();

        const req = createRequire(path.join(repo, 'packages/mcp/package.json'));
        const rewriteImports = text => text.replace(/(from\s+["'])([^"']+)(["'])/g, (whole, prefix, specifier, suffix) => {
            if (specifier.startsWith('node:')) return whole;
            const resolved = specifier.startsWith('.')
                ? path.resolve(path.dirname(supplementPath), specifier).replace(/\.js$/, '.ts')
                : req.resolve(specifier);
            return prefix + resolved + suffix;
        });

        // Reuse the prior experiment's stem function literally, unchanged.
        const priorScript = await fs.readFile(priorScriptPath, 'utf8');
        const stemMatch = priorScript.match(/function stem\(word, role\) \{[\s\S]*?\n\}/);
        assert(stemMatch, 'Prior stem function missing');
        const stemSource = stemMatch[0];
        const tokenizerAnchor = `function normalizedTerms(value: string): Set<string> {
    return new Set((value + " " + value.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean)
        .map((term) => term.replace(/(?:ing|ed|s)$/, "")));
}`;
        const roleTokenizer = `function normalizedTerms(value: string): Set<string> {
    return new Set((value + " " + value.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean)
        .map((term) => stem(term, true)));
}
${stemSource}`;
        const comparatorAnchor = `        }).sort((left, right) => right.matches - left.matches
            || right.nameMatches - left.nameMatches
            || left.symbol.span.startLine - right.symbol.span.startLine);`;
        const nameFirstComparator = `        }).sort((left, right) => right.nameMatches - left.nameMatches
            || right.matches - left.matches
            || left.symbol.span.startLine - right.symbol.span.startLine);`;

        const variants = [];
        for (const tokenizer of TOKENIZERS) {
            for (const order of ORDERS) {
                let source = supplementSource;
                const transformations = [];
                if (tokenizer === 'role-additive') {
                    source = once(source, tokenizerAnchor, roleTokenizer, 'normalizedTerms');
                    transformations.push('supplement normalizedTerms -> prior role-additive stem(term, true)');
                }
                if (order === 'name-first') {
                    source = once(source, comparatorAnchor, nameFirstComparator, 'shipped comparator');
                    transformations.push('shipped comparator -> nameMatches desc, matches desc, startLine asc');
                }
                const queryBoundSHA256 = sha256(source);
                const rankedBlock = extract(source,
                    '        const lines = evidence.source.split(/\\r?\\n/);',
                    '        for (const { symbol, content } of ranked.slice(0, MAX_SYMBOLS_PER_FILE)) {', 'ranked block');
                const lexicalBlock = extract(source,
                    '            const content = lines.slice(symbol.span.startLine - 1, symbol.span.endLine).join("\\n");',
                    '            if (matched.length < 2 || !matched.some((term) => !pathTerms.has(term))) return [];', 'lexical block');
                const rowBlock = extract(source,
                    '            return [{ symbol, content, matches: matched.length,',
                    '        }).sort((left, right) =>', 'row block');
                assert(rowBlock.endsWith(';\n'), 'Row block shape drift');
                const rowExpression = rowBlock.slice('            return '.length, -2);
                source += `\nexport { normalizedTerms };\nexport function experimentFileRanking(input: any, file: string, evidence: any, queryTerms: Set<string>, target: any) {\n${rankedBlock}\n    const describeTarget = (symbol: any) => {\n${lexicalBlock}\n        const rows = ${rowExpression};\n        return { ...rows[0], matched };\n    };\n    return { ranked, target: describeTarget(target), maxSymbolsPerFile: MAX_SYMBOLS_PER_FILE };\n}\n`;
                const scratchFile = path.join(scratch, `${tokenizer}-${order}.ts`);
                await fs.writeFile(scratchFile, rewriteImports(source));
                const module = await import(pathToFileURL(scratchFile).href);
                variants.push({
                    tokenizer, order, key: variantKey(tokenizer, order), module,
                    sup: module.supplementSearchFileSymbols, normalizedTerms: module.normalizedTerms,
                    experimentFileRanking: module.experimentFileRanking,
                    queryBoundSHA256, moduleSHA256: sha256(await fs.readFile(scratchFile)), transformations,
                });
            }
        }
        const shipped = variants.find(variant => variant.key === 'baseline/total-evidence-first');
        assert.equal(shipped.queryBoundSHA256, sha256(supplementSource), 'Shipped variant must preserve production source');
        assert.equal(shipped.transformations.length, 0, 'Shipped variant must not transform production source');
        result.variantSources = Object.fromEntries(variants.map(variant => [variant.key, {
            queryBoundSHA256: variant.queryBoundSHA256, scratchModuleSHA256: variant.moduleSHA256,
            transformations: variant.transformations,
            tokenizer: variant.tokenizer, order: variant.order,
        }]));

        const makeReader = (registry, reads, options = {}) => async (root, file) => {
            const evidence = await readCurrentSourceEvidence(root, file);
            const manifestHash = registry.manifest.files.find(entry => entry.path === file)?.hash ?? null;
            const observedHash = evidence ? (options.hashMismatch ? '0'.repeat(64) : evidence.observedHash) : null;
            const hashAccepted = Boolean(evidence && !options.hashMismatch
                && evidence.relativeFile === file && evidence.observedHash === manifestHash);
            reads.push({ file, observedHash, manifestHash, hashAccepted });
            if (!evidence) return undefined;
            return options.hashMismatch ? { ...evidence, observedHash } : evidence;
        };

        const runVariant = async (variant, input) => {
            const reads = [];
            const returned = await variant.sup({
                candidates: input.candidates,
                lexicalTerms: input.lexicalTerms,
                registry: input.registry,
                codebaseRoot: input.codebaseRoot,
                readSourceEvidence: makeReader(input.registry, reads, input.readerOptions),
            });
            return { reads, returned };
        };

        const casePlans = new Map();
        const planFor = query => {
            if (!casePlans.has(query)) {
                const plan = planning.buildSearchQueryPlan(query, true, planning.parseSearchOperators(query));
                casePlans.set(query, { plan, lexicalTerms: plan.lexicalTerms, queryTerms: new Map() });
            }
            return casePlans.get(query);
        };
        const queryTermsFor = (variant, query) => {
            const cached = planFor(query);
            const key = variant.tokenizer;
            if (!cached.queryTerms.has(key)) {
                cached.queryTerms.set(key, new Set(cached.lexicalTerms
                    .filter(term => term.kind === 'whole')
                    .flatMap(term => [...variant.normalizedTerms(term.value)])));
            }
            return cached.queryTerms.get(key);
        };

        const diagnosticCache = new Map();
        const diagnoseFile = async ({ variant, registry, root, caseKey, file, queryTerms }) => {
            const key = `${variant.tokenizer}\u0000${caseKey}\u0000${file}\u0000${[...queryTerms].sort().join(',')}`;
            if (diagnosticCache.has(key)) return diagnosticCache.get(key);
            const symbols = registry.symbolsByFile.get(file) ?? [];
            const target = symbols.find(callable);
            if (!target) {
                const empty = { rows: [], eligibleSymbolCount: 0 };
                diagnosticCache.set(key, empty);
                return empty;
            }
            const evidence = await readCurrentSourceEvidence(root, file);
            assert(evidence, `Diagnostic source unavailable: ${file}`);
            const diagnostic = variant.experimentFileRanking({ registry }, file, evidence, queryTerms, target);
            const summary = {
                eligibleSymbolCount: diagnostic.ranked.length,
                rows: diagnostic.ranked.map(row => ({
                    id: row.symbol.symbolInstanceId, name: row.symbol.name, kind: row.symbol.kind,
                    startLine: row.symbol.span.startLine, endLine: row.symbol.span.endLine,
                    matches: row.matches, nameMatches: row.nameMatches,
                })),
                describe: symbol => {
                    const described = variant.experimentFileRanking({ registry }, file, evidence, queryTerms, symbol);
                    return { matched: described.target.matched, matches: described.target.matches, nameMatches: described.target.nameMatches };
                },
            };
            diagnosticCache.set(key, summary);
            return summary;
        };

        const evaluateCase = async ({ caseKey, query, acceptable, registry, candidates, root, suppliedFiles }) => {
            const compiled = compileAcceptable(acceptable);
            const { lexicalTerms } = planFor(query);
            const runs = {};
            for (const variant of variants) {
                const { reads, returned } = await runVariant(variant, { candidates, lexicalTerms, registry, codebaseRoot: root });
                const selectedFiles = [...new Set(reads.map(read => read.file))];
                const top6ByFile = Object.fromEntries(selectedFiles.map(file => [file,
                    returned.filter(row => row.relativePath === file).slice(0, 6).map(row => ({
                        id: row.ownerSymbolInstanceId ?? null, name: registry.symbolsByInstanceId.get(row.ownerSymbolInstanceId)?.name ?? null,
                    })),
                ]));
                runs[variant.key] = { variant, reads, returned, selectedFiles, top6ByFile };
            }

            const evidenceCache = new Map();
            const evidenceFor = async file => {
                if (!evidenceCache.has(file)) evidenceCache.set(file, await readCurrentSourceEvidence(root, file));
                const evidence = evidenceCache.get(file);
                assert(evidence, `Expected-target source unavailable: ${file}`);
                return evidence;
            };
            const requiredFiles = [...new Set(compiled.flatMap(entry => suppliedFiles.filter(file => entry.path.test(file))))];
            const diagnostics = {};
            for (const tokenizer of TOKENIZERS) {
                const files = new Set([...requiredFiles]);
                for (const order of ORDERS) for (const file of runs[variantKey(tokenizer, order)].selectedFiles) files.add(file);
                const byFile = {};
                for (const file of [...files].sort()) {
                    const variant = variants.find(item => item.tokenizer === tokenizer && item.order === 'total-evidence-first');
                    byFile[file] = await diagnoseFile({
                        variant, registry, root, caseKey, file,
                        queryTerms: queryTermsFor(variant, query),
                    });
                }
                diagnostics[tokenizer] = byFile;
            }

            const unscorableEntries = [];
            for (const entry of compiled) {
                const matchingFiles = suppliedFiles.filter(file => entry.path.test(file));
                if (matchingFiles.length === 0) continue;
                for (const file of matchingFiles) {
                    const manifestFile = registry.manifest.files.find(item => item.path === file);
                    const symbols = (registry.symbolsByFile.get(file) ?? []).filter(symbol => entry.symbol === null || entry.symbol.test(symbol.name));
                    if (symbols.length === 0) {
                        unscorableEntries.push({ acceptableIndex: entry.index, file, reason: 'target symbol not represented by production analysis' });
                        continue;
                    }
                    const evidence = await evidenceFor(file);
                    for (const symbol of symbols) {
                        const support = spanSupport(symbol, evidence.source, manifestFile.hash);
                        if (!support.sourceSupported) unscorableEntries.push({ acceptableIndex: entry.index, file, symbol: symbol.name, reason: 'invalid span or insufficient source support', support });
                    }
                }
            }

            const variantRows = {};
            for (const variant of variants) {
                const run = runs[variant.key];
                const rowsById = new Map();
                for (const row of Object.values(diagnostics[variant.tokenizer])) for (const item of row.rows) rowsById.set(item.id, item);
                const returnedRows = run.returned.map((row, index) => {
                    const symbol = row.ownerSymbolInstanceId ? registry.symbolsByInstanceId.get(row.ownerSymbolInstanceId) : undefined;
                    const rankRow = row.ownerSymbolInstanceId ? rowsById.get(row.ownerSymbolInstanceId) : undefined;
                    return {
                        position: index + 1, name: symbol?.name ?? null, kind: symbol?.kind ?? null,
                        label: row.symbolLabel, file: row.relativePath,
                        ownerSymbolInstanceId: row.ownerSymbolInstanceId ?? null,
                        startLine: row.startLine, endLine: row.endLine,
                        matches: rankRow?.matches ?? null, nameMatches: rankRow?.nameMatches ?? null,
                    };
                });
                const firstIndex = run.returned.findIndex(row => {
                    const name = row.ownerSymbolInstanceId ? registry.symbolsByInstanceId.get(row.ownerSymbolInstanceId)?.name ?? null : null;
                    return compiled.some(entry => entry.path.test(row.relativePath)
                        && (entry.symbol === null || (name !== null && entry.symbol.test(name))));
                });
                const first = firstIndex < 0 ? null : run.returned[firstIndex];
                const firstSymbol = first?.ownerSymbolInstanceId ? registry.symbolsByInstanceId.get(first.ownerSymbolInstanceId) : undefined;
                variantRows[variant.key] = {
                    tokenizer: variant.tokenizer, order: variant.order,
                    selectedFiles: run.selectedFiles,
                    sourceReads: run.reads,
                    returned: returnedRows,
                    returnedCount: run.returned.length,
                    acceptableAdmission: firstIndex < 0 ? false : true,
                    firstAcceptablePosition: firstIndex < 0 ? null : firstIndex + 1,
                    firstAcceptable: firstIndex < 0 ? null : {
                        position: firstIndex + 1, name: firstSymbol?.name ?? null,
                        ownerSymbolInstanceId: first.ownerSymbolInstanceId ?? null,
                        file: first.relativePath,
                    },
                    top6ByFile: run.top6ByFile,
                    rawReturnedProjection: projectReturned(run.returned),
                };
            }

            // Ordering must not change selection, reads, hashes, or lexical evidence.
            const orderInvariance = {};
            for (const tokenizer of TOKENIZERS) {
                const total = runs[variantKey(tokenizer, 'total-evidence-first')];
                const nameFirst = runs[variantKey(tokenizer, 'name-first')];
                const readsProjection = run => run.reads.map(read => ({
                    file: read.file, observedHash: read.observedHash, manifestHash: read.manifestHash, hashAccepted: read.hashAccepted,
                }));
                const eligibleOwnerIds = Object.fromEntries(Object.entries(diagnostics[tokenizer])
                    .map(([file, diagnostic]) => [file, diagnostic.rows.map(row => row.id)]));
                const ownerEvidence = Object.fromEntries(Object.entries(diagnostics[tokenizer])
                    .map(([file, diagnostic]) => [file, diagnostic.rows.map(row => ({ id: row.id, matches: row.matches, nameMatches: row.nameMatches }))]));
                const reorder = {};
                for (const order of ORDERS) {
                    const run = runs[variantKey(tokenizer, order)];
                    const variant = variants.find(item => item.tokenizer === tokenizer && item.order === order);
                    assert(variant);
                    reorder[order] = true;
                    for (const file of run.selectedFiles) {
                        const diagnostic = diagnostics[tokenizer][file];
                        const expectedTop6 = [...diagnostic.rows].sort(ORDER_BY_KEY[order]).slice(0, 6).map(row => row.id);
                        const actualTop6 = run.returned.filter(row => row.relativePath === file)
                            .map(row => row.ownerSymbolInstanceId).filter(Boolean);
                        assert.deepEqual(actualTop6, expectedTop6, `Returned order drift: ${caseKey} ${tokenizer} ${order} ${file}`);
                    }
                }
                assert.deepEqual(total.selectedFiles, nameFirst.selectedFiles, `Selection changed by order: ${caseKey} ${tokenizer}`);
                assert.deepEqual(readsProjection(total), readsProjection(nameFirst), `Reads or hashes changed by order: ${caseKey} ${tokenizer}`);
                orderInvariance[tokenizer] = {
                    selectedFilesPreserved: true, readHashesPreserved: true,
                    eligibleOwnerIdSetsPreserved: true, ownerMatchesPreserved: true,
                    top6ReorderedFromSameEligibleSet: reorder,
                    eligibleOwnerIds, ownerEvidence,
                };
            }

            // Expected target eligibility and rank before the six-symbol cut.
            const expectedTargets = {};
            for (const tokenizer of TOKENIZERS) {
                expectedTargets[tokenizer] = {};
                for (const entry of compiled) {
                    const matchingFiles = suppliedFiles.filter(file => entry.path.test(file));
                    if (matchingFiles.length === 0) {
                        expectedTargets[tokenizer][entry.index] = { acceptableIndex: entry.index, pathRegex: entry.pathRegex, symbolRegex: entry.symbolRegex, unsupplied: true, instances: [] };
                        continue;
                    }
                    const instances = [];
                    for (const file of matchingFiles) {
                        const manifestHash = registry.manifest.files.find(item => item.path === file)?.hash;
                        const evidence = await evidenceFor(file);
                        const diagnostic = diagnostics[tokenizer][file];
                        const rows = new Map(diagnostic.rows.map(row => [row.id, row]));
                        const diagnosticVariant = variants.find(item => item.tokenizer === tokenizer && item.order === 'total-evidence-first');
                        const pathTerms = diagnosticVariant.normalizedTerms(file);
                        for (const symbol of (registry.symbolsByFile.get(file) ?? []).filter(symbol => entry.symbol === null || entry.symbol.test(symbol.name))) {
                            const support = spanSupport(symbol, evidence.source, manifestHash);
                            const rankRow = rows.get(symbol.symbolInstanceId);
                            const descriptor = diagnostic.describe(symbol);
                            const ranksByOrder = Object.fromEntries(ORDERS.map(order => [order, rankRow
                                ? [...diagnostic.rows].sort(ORDER_BY_KEY[order]).findIndex(row => row.id === symbol.symbolInstanceId) + 1
                                : null]));
                            instances.push({
                                name: symbol.name, kind: symbol.kind, file: symbol.file,
                                symbolInstanceId: symbol.symbolInstanceId,
                                startLine: symbol.span.startLine, endLine: symbol.span.endLine,
                                support, eligible: Boolean(rankRow),
                                matches: descriptor.matches, nameMatches: descriptor.nameMatches,
                                matchedTerms: descriptor.matched,
                                rankBeforeCut: ranksByOrder['total-evidence-first'],
                                rankBeforeCutByOrder: ranksByOrder,
                                eligibleSymbolCount: diagnostic.eligibleSymbolCount,
                                gates: {
                                    callableKind: callable(symbol),
                                    hashMatches: support.fileHashMatches,
                                    spanWithinSource: support.spanValid,
                                    withinMaxSymbolLines: support.spanValid && (symbol.span.endLine - symbol.span.startLine + 1) <= 400,
                                    belowTwoMatchedConcepts: descriptor.matches < 2,
                                    pathOnlyEvidence: descriptor.matched.length > 0 && descriptor.matched.every(term => pathTerms.has(term)),
                                },
                            });
                        }
                    }
                    const valid = instances.filter(instance => instance.support.sourceSupported);
                    const eligibleRanks = instances.filter(instance => instance.eligible).map(instance => instance.rankBeforeCut);
                    expectedTargets[tokenizer][entry.index] = {
                        acceptableIndex: entry.index, pathRegex: entry.pathRegex, symbolRegex: entry.symbolRegex,
                        instances,
                        represented: instances.length > 0,
                        sourceSupported: valid.length > 0 && valid.length === instances.length,
                        anyEligible: eligibleRanks.length > 0,
                        bestRankBeforeCut: eligibleRanks.length === 0 ? null : Math.min(...eligibleRanks),
                        eligibleSymbolCount: instances[0]?.eligibleSymbolCount ?? null,
                    };
                }
            }
            const unscorable = unscorableEntries.length > 0;
            if (unscorable) {
                for (const row of Object.values(variantRows)) {
                    row.acceptableAdmission = null;
                    row.firstAcceptablePosition = null;
                    row.firstAcceptable = null;
                }
            }

            const callableFiles = new Set(requiredFiles);
            for (const run of Object.values(runs)) for (const file of run.selectedFiles) callableFiles.add(file);
            const callableCounts = Object.fromEntries([...callableFiles].sort().map(file => {
                const symbols = registry.symbolsByFile.get(file) ?? [];
                const manifestFile = registry.manifest.files.find(item => item.path === file);
                return [file, {
                    callableCount: symbols.filter(callable).length,
                    symbolRecords: symbols.length,
                    structuralStatus: manifestFile?.structuralStatus ?? null,
                    structuralReason: manifestFile?.structuralReason ?? null,
                    definitionStatus: manifestFile?.definitionStatus ?? null,
                }];
            }));
            for (const row of Object.values(variantRows)) {
                row.expectedTargets = expectedTargets[row.tokenizer];
                row.expectedTargetRanksBeforeCut = Object.fromEntries(Object.entries(expectedTargets[row.tokenizer]).map(([index, entry]) => [index,
                    entry.instances.map(instance => ({
                        symbolInstanceId: instance.symbolInstanceId, name: instance.name,
                        eligible: instance.eligible, rankBeforeCut: instance.rankBeforeCutByOrder[row.order],
                    }))]));
                row.callableCounts = callableCounts;
            }

            const ordering = {};
            for (const tokenizer of TOKENIZERS) {
                const total = variantRows[variantKey(tokenizer, 'total-evidence-first')];
                const nameFirst = variantRows[variantKey(tokenizer, 'name-first')];
                const totalPosition = total.firstAcceptablePosition;
                const namePosition = nameFirst.firstAcceptablePosition;
                const targetEligible = Object.values(expectedTargets[tokenizer]).some(entry => entry.anyEligible);
                ordering[tokenizer] = {
                    totalEvidenceFirstPosition: totalPosition,
                    nameFirstPosition: namePosition,
                    targetEligible,
                    orderingCanChangeOutcome: totalPosition !== null || namePosition !== null,
                    outcome: unscorable ? 'unscorable' : orderingOutcome(totalPosition, namePosition),
                    orderingOnlyComparison: true,
                };
            }

            const displaced = {};
            for (const tokenizer of TOKENIZERS) {
                const files = new Set([
                    ...Object.keys(runs[variantKey(tokenizer, 'total-evidence-first')].top6ByFile),
                    ...Object.keys(runs[variantKey(tokenizer, 'name-first')].top6ByFile),
                ]);
                displaced[tokenizer] = [...files].sort().map(file => {
                    const total = runs[variantKey(tokenizer, 'total-evidence-first')].top6ByFile[file] ?? null;
                    const nameFirst = runs[variantKey(tokenizer, 'name-first')].top6ByFile[file] ?? null;
                    const totalIds = new Set((total ?? []).map(row => row.id));
                    const nameIds = new Set((nameFirst ?? []).map(row => row.id));
                    return {
                        file,
                        totalEvidenceFirstTop6: total,
                        nameFirstTop6: nameFirst,
                        displacedFromTop6: total === null || nameFirst === null ? null : (total ?? []).filter(row => !nameIds.has(row.id)),
                        addedToTop6: total === null || nameFirst === null ? null : (nameFirst ?? []).filter(row => !totalIds.has(row.id)),
                    };
                });
            }

            return {
                caseKey, query, acceptable: acceptable.map(entry => ({ pathRegex: entry.pathRegex, symbolRegex: entry.symbolRegex, evidence: entry.evidence ?? null })),
                suppliedFiles, lexicalTerms: lexicalTerms.map(term => ({ kind: term.kind, value: term.value })),
                queryTerms: Object.fromEntries(TOKENIZERS.map(tokenizer => [tokenizer, [...queryTermsFor(variants.find(item => item.tokenizer === tokenizer), query)]])),
                unscorable, unscorableEntries, callableCounts,
                variants: variantRows,
                expectedTargets,
                ordering,
                displaced,
                orderInvariance,
            };
        };

        // S1: actual frozen publication and baseline mcp_fusion input.
        const sidecarState = await readSymbolRegistrySidecar({
            normalizedRootPath: repo, publicationId: fixture.s1.publicationId, navigationRoot,
        });
        assert.equal(sidecarState.status, 'ok', `Sidecar read failed: ${sidecarState.reason}`);
        const registry = sidecarState.registry;
        assert.equal(await fs.realpath(registry.manifest.normalizedRootPath), await fs.realpath(repo), 'Registry root mismatch');
        const targetRecord = registry.symbolsByInstanceId.get(fixture.s1.target.symbolInstanceId);
        assert(targetRecord, 'S1 target absent from publication');
        assert.equal(targetRecord.file, fixture.s1.target.file, 'S1 target file drift');
        assert.equal(targetRecord.name, fixture.s1.target.name, 'S1 target name drift');

        const stage = (capture, name) => {
            const found = capture.stages.filter(item => item.stage === name);
            assert.equal(found.length, 1);
            assert.equal(found[0].total, found[0].candidates.length, 'Truncated capture');
            return found[0].candidates;
        };
        const fixtureIds = [...new Set(Object.values(trace.variants).flatMap(capture => capture.stages.flatMap(item => item.candidates.map(row => row.id))))];
        const persistedIds = fixtureIds.filter(id => /^chunk_[a-f0-9]+$/.test(id));
        const coreRequire = createRequire(path.join(repo, 'packages/core/package.json'));
        const lance = coreRequire('@lancedb/lancedb');
        const vectorRoot = path.join(os.homedir(), '.satori/vector/lancedb');
        connection = await lance.connect(vectorRoot);
        table = await connection.openTable(trace.collection);
        const rows = await table.query().where(`id IN (${persistedIds.map(id => `'${id}'`).join(',')})`)
            .select(['id', 'content', 'relativePath', 'startLine', 'endLine', 'metadataJson', 'contentHash'])
            .limit(persistedIds.length).toArray();
        const candidates = new Map(rows.map(row => [row.id, { ...JSON.parse(row.metadataJson), ...row }]));
        assert.equal(candidates.size, rows.length, 'Duplicated vector rows');
        assert.equal(rows.length, persistedIds.length, 'Missing persisted fixture rows');
        let sourceDerived = 0;
        for (const id of fixtureIds) {
            const descriptor = trace.candidateDescriptors[id];
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
                candidate = {
                    id, relativePath: descriptor.relativePath, startLine: descriptor.startLine, endLine: descriptor.endLine,
                    language: owner.language, content: lines.slice(descriptor.startLine - 1, descriptor.endLine).join('\n'),
                    ...(aligned ? { startByte: owner.span.startByte, endByte: owner.span.endByte } : {}),
                };
                sourceDerived++;
            }
            candidate = {
                ...candidate, ownerSymbolInstanceId: owner.symbolInstanceId,
                ownerSymbolKey: owner.symbolKey, symbolKind: owner.kind, symbolLabel: owner.label,
            };
            assert.equal(candidate.ownerSymbolInstanceId, owner.symbolInstanceId, `Owner identity drift: ${id}`);
            candidates.set(id, candidate);
        }
        const baselineCandidates = stage(trace.variants.baseline, 'mcp_fusion').map(row => candidates.get(row.id));
        assert(baselineCandidates.every(Boolean), 'Missing baseline mcp_fusion candidate');
        result.s1 = {
            query: fixture.s1.query,
            target: { ...fixture.s1.target, name: targetRecord.name },
            inputStage: fixture.s1.inputStage,
            inputCount: baselineCandidates.length,
            reconstruction: {
                fixtureCandidates: fixtureIds.length, persistedRows: rows.length,
                sourceDerived, ownersResolved: candidates.size,
            },
            variants: {},
        };
        const s1Case = await evaluateCase({
            caseKey: 's1', query: fixture.s1.query,
            acceptable: [{ pathRegex: `^${fixture.s1.target.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, symbolRegex: `^${fixture.s1.target.name}$`, evidence: 'S1 target' }],
            registry, candidates: baselineCandidates, root: repo,
            suppliedFiles: registry.manifest.files.map(file => file.path),
        });
        result.s1.suppliedFiles = s1Case.suppliedFiles;
        result.s1.lexicalTerms = s1Case.lexicalTerms;
        result.s1.queryTerms = s1Case.queryTerms;
        result.s1.variants = s1Case.variants;
        result.s1.expectedTargets = s1Case.expectedTargets;
        result.s1.ordering = s1Case.ordering;
        result.s1.displaced = s1Case.displaced;
        result.s1.orderInvariance = {
            baseline: s1Case.orderInvariance.baseline,
            'role-additive': s1Case.orderInvariance['role-additive'],
        };

        const priorBaseline = fixture.s1.expectedReproduction.baseline;
        const priorRole = fixture.s1.expectedReproduction.roleAdditive;
        const baselineRun = s1Case.variants['baseline/total-evidence-first'];
        const roleRun = s1Case.variants['role/total-evidence-first'];
        const roleTarget = s1Case.expectedTargets['role-additive']['0'].instances.find(instance => instance.symbolInstanceId === fixture.s1.target.symbolInstanceId);
        const baselineSameSelected = sameJson(baselineRun.selectedFiles, priorBaseline.selectedFiles);
        const baselineSameOrder = sameJson(baselineRun.rawReturnedProjection, priorBaseline.returned);
        const roleSameSelected = sameJson(roleRun.selectedFiles, priorRole.selectedFiles);
        const roleSameOrder = sameJson(roleRun.rawReturnedProjection, priorRole.returned);
        result.s1.reproduction = {
            baseline: {
                expected: { selectedFiles: priorBaseline.selectedFiles, returnedCount: priorBaseline.returnedCount },
                observed: { selectedFiles: baselineRun.selectedFiles, returnedCount: baselineRun.returnedCount },
                selectedFilesMatch: baselineSameSelected, returnedOrderMatch: baselineSameOrder,
                returnedCountMatch: baselineRun.returnedCount === priorBaseline.returnedCount,
            },
            roleAdditive: {
                expected: { selectedFiles: priorRole.selectedFiles, returnedCount: priorRole.returnedCount, targetRankBeforeCut: 17, eligibleSymbolCount: 37, targetAdmitted: false },
                observed: {
                    selectedFiles: roleRun.selectedFiles, returnedCount: roleRun.returnedCount,
                    targetRankBeforeCut: roleTarget?.rankBeforeCut ?? null,
                    eligibleSymbolCount: roleTarget?.eligibleSymbolCount ?? null,
                    targetAdmitted: roleRun.returned.some(row => isTarget({ symbolInstanceId: row.ownerSymbolInstanceId }, fixture.s1.target.symbolInstanceId)),
                },
                selectedFilesMatch: roleSameSelected, returnedOrderMatch: roleSameOrder,
            },
        };
        const reproductionOk = baselineSameSelected && baselineSameOrder
            && roleRun.returnedCount === priorRole.returnedCount
            && roleSameSelected
            && roleTarget?.rankBeforeCut === 17
            && roleTarget?.eligibleSymbolCount === 37
            && roleTarget?.eligible === true
            && !roleRun.returned.some(row => row.ownerSymbolInstanceId === fixture.s1.target.symbolInstanceId);
        result.s1.reproduction.ok = reproductionOk;
        if (!reproductionOk) {
            result.status = 's1-baseline-reproduction-failure';
            result.failure = {
                message: 'S1 baseline or role-additive reproduction failed; comparative claims stopped',
                reproduction: result.s1.reproduction,
            };
            result.identities.script.sha256 = await sha256Of(fileURLToPath(import.meta.url));
            await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
            written = true;
            throw new Error(result.failure.message);
        }

        // External source-backed probes: per-checkout registries from production analysis.
        const react = fixture.external.react;
        const flatbuffers = fixture.external.flatbuffers;
        const buildCheckout = async (checkout, checkoutKey) => {
            const root = await fs.realpath(checkout.root);
            assert.equal(path.basename(checkout.root), path.basename(root));
            let observedCommit = null;
            try {
                observedCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
            } catch {
                observedCommit = null;
            }
            const hashes = {};
            const files = [];
            const records = [];
            const manifestFiles = [];
            for (const relativePath of checkout.suppliedFiles) {
                const absolutePath = path.join(root, relativePath);
                const bytes = await fs.readFile(absolutePath);
                const content = bytes.toString('utf8');
                const hash = sha256(bytes);
                hashes[relativePath] = hash;
                externalHashes[`${checkoutKey}:${relativePath}`] = hash;
                const language = core.detectLanguageId(relativePath, content);
                const analysis = await analysisService.analyze({ content, language, relativePath });
                const symbolic = buildSymbolRecordsForFile({
                    relativePath, language, content, fileHash: hash,
                    extractorVersion: core.SYMBOL_EXTRACTOR_VERSION,
                    extractedSymbols: analysis.symbols, chunks: analysis.chunks,
                });
                records.push(...symbolic);
                const hasDefinitions = symbolic.some(symbol => symbol.kind !== 'file');
                const definitionStatus = hasDefinitions ? 'definitions_present'
                    : analysis.structuralStatus !== 'complete' ? 'structural_unavailable' : 'definition_free';
                manifestFiles.push({
                    path: relativePath, hash, language, symbolCount: symbolic.length, definitionStatus,
                    structuralStatus: analysis.structuralStatus,
                    ...(analysis.structuralReason ? { structuralReason: analysis.structuralReason } : {}),
                });
                const callables = symbolic.filter(callable);
                files.push({
                    file: relativePath, hash, language,
                    structuralStatus: analysis.structuralStatus,
                    structuralReason: analysis.structuralReason ?? null,
                    extractedSymbols: analysis.symbols.length,
                    symbolRecords: symbolic.length,
                    callableCount: callables.length,
                    callableNames: callables.map(symbol => symbol.name),
                });
            }
            const manifest = {
                schemaVersion: core.SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: root,
                rootFingerprint: createHash('md5').update(root).digest('hex'),
                indexPolicyHash: 's1-declaration-evidence-file-probe-no-index-policy',
                languageRouterVersion: 'language-router-v2',
                extractorVersion: core.SYMBOL_EXTRACTOR_VERSION,
                relationshipVersion: core.RELATIONSHIP_BUILDER_VERSION,
                builtAt: '1970-01-01T00:00:00.000Z',
                files: manifestFiles,
            };
            const registry = buildSymbolRegistry({ manifest, symbols: records });
            return {
                root, expectedCommit: checkout.commit, observedCommit, commitMatch: observedCommit === checkout.commit,
                suppliedFiles: [...checkout.suppliedFiles], hashes, files,
                manifestHash: computeSymbolRegistryManifestHash(manifest),
                manifestFileCount: manifestFiles.length, symbolCount: records.length,
                registry,
            };
        };
        const reactCheckout = await buildCheckout(react, 'react');
        const flatbuffersCheckout = await buildCheckout(flatbuffers, 'flatbuffers');
        result.identities.checkouts.react = {
            root: reactCheckout.root, expectedCommit: reactCheckout.expectedCommit, observedCommit: reactCheckout.observedCommit,
            commitMatch: reactCheckout.commitMatch, suppliedFiles: reactCheckout.suppliedFiles,
            manifestHash: reactCheckout.manifestHash, fileHashes: reactCheckout.hashes,
        };
        result.identities.checkouts.flatbuffers = {
            root: flatbuffersCheckout.root, expectedCommit: flatbuffersCheckout.expectedCommit, observedCommit: flatbuffersCheckout.observedCommit,
            commitMatch: flatbuffersCheckout.commitMatch, suppliedFiles: flatbuffersCheckout.suppliedFiles,
            manifestHash: flatbuffersCheckout.manifestHash, fileHashes: flatbuffersCheckout.hashes,
        };
        assert(reactCheckout.commitMatch, `React commit mismatch: ${reactCheckout.observedCommit}`);
        assert(flatbuffersCheckout.commitMatch, `FlatBuffers commit mismatch: ${flatbuffersCheckout.observedCommit}`);

        // Frozen FlatBuffers source responsibilities must hold before scoring.
        for (const caseDef of flatbuffers.cases) {
            const entry = compileAcceptable(caseDef.acceptable)[0];
            const symbols = (flatbuffersCheckout.registry.symbolsByFile.get('ts/builder.ts') ?? []).filter(symbol => entry.symbol.test(symbol.name));
            assert.equal(symbols.length, 1, `FlatBuffers target drift: ${caseDef.id}`);
            const evidence = await readCurrentSourceEvidence(flatbuffersCheckout.root, 'ts/builder.ts');
            const spanText = evidence.source.split(/\r?\n/).slice(symbols[0].span.startLine - 1, symbols[0].span.endLine).join('\n');
            caseDef.sourceResponsibility.forEach(check => {
                assert(new RegExp(check.pattern).test(spanText), `Source responsibility failed: ${caseDef.id} ${check.label}`);
            });
            caseDef.validatedSourceResponsibility = caseDef.sourceResponsibility.map(check => ({ ...check, passed: true }));
            caseDef.validatedSymbol = { name: symbols[0].name, startLine: symbols[0].span.startLine, endLine: symbols[0].span.endLine };
        }

        const external = { registries: { react: null, flatbuffers: null }, cases: {} };
        for (const checkout of [reactCheckout, flatbuffersCheckout]) {
            const key = checkout === reactCheckout ? 'react' : 'flatbuffers';
            external.registries[key] = {
                root: checkout.root, suppliedFiles: checkout.suppliedFiles,
                manifestHash: checkout.manifestHash, commit: checkout.expectedCommit,
                files: checkout.files,
            };
        }
        const runExternalCases = async (checkout, defs) => {
            const candidates = checkout.suppliedFiles.map(relativePath => ({
                relativePath, startLine: 1, endLine: 1,
                language: checkout.files.find(file => file.file === relativePath)?.language,
            }));
            for (const caseDef of defs) {
                const evaluated = await evaluateCase({
                    caseKey: caseDef.id, query: caseDef.query, acceptable: caseDef.acceptable,
                    registry: checkout.registry, candidates, root: checkout.root, suppliedFiles: checkout.suppliedFiles,
                });
                evaluated.tags = caseDef.tags ?? [];
                evaluated.justification = caseDef.justification ?? null;
                if (caseDef.validatedSourceResponsibility) evaluated.validatedSourceResponsibility = caseDef.validatedSourceResponsibility;
                if (caseDef.validatedSymbol) evaluated.validatedSymbol = caseDef.validatedSymbol;
                external.cases[caseDef.id] = evaluated;
            }
        };
        await runExternalCases(reactCheckout, react.cases);
        await runExternalCases(flatbuffersCheckout, flatbuffers.cases);
        result.external = external;

        // Negative checks: these are experiment checks, not product tests.
        const negative = { singleConcept: {}, hashMismatch: {}, identity: {} };
        const flatItems = flatbuffers.cases.find(caseDef => caseDef.id === 'fb-object');
        const flatPlan = planFor(flatItems.query);
        const flatCandidates = flatbuffersCheckout.suppliedFiles.map(relativePath => ({
            relativePath, startLine: 1, endLine: 1,
            language: flatbuffersCheckout.files.find(file => file.file === relativePath)?.language,
        }));
        for (const variant of variants) {
            const controlReads = [];
            const control = await variant.sup({
                candidates: baselineCandidates, lexicalTerms: [{ kind: 'whole', value: 'search' }],
                registry, codebaseRoot: repo,
                readSourceEvidence: async () => { controlReads.push('search'); throw new Error('single-concept search must not read'); },
            });
            const handlerReads = [];
            const handlerControl = await variant.sup({
                candidates: baselineCandidates,
                lexicalTerms: [{ kind: 'whole', value: 'handler' }, { kind: 'whole', value: 'handlers' }],
                registry, codebaseRoot: repo,
                readSourceEvidence: async () => { handlerReads.push('handler-handlers'); throw new Error('single-concept handler/handlers must not read'); },
            });
            assert.equal(control.length, 0, 'Single-concept search returned symbols');
            assert.equal(controlReads.length, 0, 'Single-concept search read source');
            assert.equal(handlerControl.length, 0, 'Single-concept handler/handlers returned symbols');
            assert.equal(handlerReads.length, 0, 'Single-concept handler/handlers read source');
            const canonicalTerms = [...new Set(['handler', 'handlers'].flatMap(term => [...variant.normalizedTerms(term)]))];
            assert.equal(canonicalTerms.length, 1, 'Handler and handlers must collapse to one canonical concept');
            negative.singleConcept[variant.key] = {
                search: { returned: 0, reads: 0 },
                'handler-handlers': { suppliedWholeTerms: ['handler', 'handlers'], returned: 0, reads: 0, canonicalTerms },
            };

            const mismatchReads = [];
            const mismatch = await variant.sup({
                candidates: flatCandidates, lexicalTerms: flatPlan.lexicalTerms,
                registry: flatbuffersCheckout.registry, codebaseRoot: flatbuffersCheckout.root,
                readSourceEvidence: makeReader(flatbuffersCheckout.registry, mismatchReads, { hashMismatch: true }),
            });
            assert.equal(mismatch.length, 0, 'Hash mismatch admitted candidates');
            negative.hashMismatch[variant.key] = {
                fixture: 'fb-object', returned: 0, filesAttempted: mismatchReads.length,
                allRejected: mismatchReads.every(read => read.hashAccepted === false),
            };
        }
        let identityChecked = 0;
        for (const [caseKey, evaluated] of Object.entries({ s1: s1Case, ...external.cases })) {
            for (const [key, row] of Object.entries(evaluated.variants)) {
                const variant = variants.find(item => item.key === key);
                assert(variant);
                const registryForCase = caseKey === 's1' ? registry : (caseKey.startsWith('fb-') ? flatbuffersCheckout.registry : reactCheckout.registry);
                for (const returned of row.returned) {
                    const symbol = registryForCase.symbolsByInstanceId.get(returned.ownerSymbolInstanceId);
                    assert(symbol, `Returned owner missing: ${caseKey} ${key} ${returned.ownerSymbolInstanceId}`);
                    assert.equal(returned.startLine, symbol.span.startLine, `Returned span drift: ${caseKey} ${key}`);
                    assert.equal(returned.endLine, symbol.span.endLine, `Returned span drift: ${caseKey} ${key}`);
                    assert.equal(returned.file, symbol.file, `Returned file drift: ${caseKey} ${key}`);
                    identityChecked++;
                }
            }
        }
        negative.identity = { checkedReturnedRows: identityChecked, passed: true, note: 'Every returned owner id, file, and span matches the registry symbol; existing S1 candidates are returned by identity.' };
        result.negativeChecks = negative;

        // Verdict from measured rows only: admission changes and position changes are separate.
        const s1Total = s1Case.variants['role/total-evidence-first'];
        const s1Name = s1Case.variants['role/name-first'];
        const s1Admitted = s1Name.acceptableAdmission === true;
        const uniqueCaseIds = Object.keys(external.cases);
        const tokenizerComparisons = [];
        const admission = { gains: [], losses: [] };
        const positions = { improvements: [], worsenings: [], unchanged: [], noRecovery: [] };
        const unscorableComparisons = [];
        const uniqueCaseOutcomes = Object.fromEntries(uniqueCaseIds.map(caseKey => [caseKey, {
            caseKey, tokenizers: {},
            anyAdmissionGain: false, anyAdmissionLoss: false,
            anyPositionImprovement: false, anyPositionWorsening: false, anyRecovery: false,
        }]));
        for (const tokenizer of TOKENIZERS) {
            for (const [caseKey, evaluated] of Object.entries(external.cases)) {
                const outcome = evaluated.ordering[tokenizer];
                const comparison = {
                    caseKey, tokenizer,
                    totalEvidenceFirstPosition: outcome.totalEvidenceFirstPosition,
                    nameFirstPosition: outcome.nameFirstPosition,
                    outcome: outcome.outcome,
                    targetEligible: outcome.targetEligible,
                    unscorable: evaluated.unscorable,
                };
                tokenizerComparisons.push(comparison);
                const unique = uniqueCaseOutcomes[caseKey];
                unique.tokenizers[tokenizer] = comparison;
                if (evaluated.unscorable) {
                    unscorableComparisons.push(comparison);
                    continue;
                }
                const total = outcome.totalEvidenceFirstPosition;
                const nameFirst = outcome.nameFirstPosition;
                if (total !== null && nameFirst === null) {
                    admission.losses.push(comparison);
                    unique.anyAdmissionLoss = true;
                } else if (total === null && nameFirst !== null) {
                    admission.gains.push(comparison);
                    unique.anyAdmissionGain = true;
                    unique.anyRecovery = true;
                } else if (total !== null && nameFirst !== null) {
                    unique.anyRecovery = true;
                    if (nameFirst < total) {
                        positions.improvements.push(comparison);
                        unique.anyPositionImprovement = true;
                    } else if (nameFirst > total) {
                        positions.worsenings.push(comparison);
                        unique.anyPositionWorsening = true;
                    } else positions.unchanged.push(comparison);
                } else {
                    // Null/null proves no successful recovery under either order.
                    positions.noRecovery.push(comparison);
                }
            }
        }
        const admissionLossCases = [...new Set(admission.losses.map(comparison => comparison.caseKey))].sort();
        const acceptedEarlier = admission.losses.length > 0;
        const verdict = !s1Admitted
            ? { code: 'insufficient-s1-target-still-excluded', sufficient: false, statement: 'Name-first ordering with role-additive terms still excludes the S1 target; the ordering intervention is insufficient.' }
            : acceptedEarlier
                ? { code: 'rejected-general-ordering-replacement', sufficient: false, statement: `Name-first ordering admits the S1 target, but displaces previously admitted acceptable owners in ${admissionLossCases.join(', ')}. It is rejected as a general ordering replacement, not reported as a successful candidate.` }
                : admission.gains.length === 0
                    ? { code: 'sample-only-no-external-admission-gain', sufficient: false, statement: 'Name-first ordering admits the known S1 target, but no external comparison recovers an acceptable owner; null/null comparisons prove no recovery.' }
                    : { code: 'candidate-requires-heldout-confirmation', sufficient: false, statement: 'Name-first ordering admits S1 and shows external admission gains without displacing an earlier acceptable owner, but this oracle-assisted set is already diagnostic and requires held-out confirmation before any production decision.' };
        result.verdict = {
            ...verdict,
            s1: {
                totalEvidenceFirst: {
                    targetRankBeforeCut: s1Case.expectedTargets['role-additive']['0'].instances[0]?.rankBeforeCutByOrder['total-evidence-first'] ?? null,
                    admitted: s1Total.acceptableAdmission,
                    firstAcceptablePosition: s1Total.firstAcceptablePosition,
                },
                nameFirst: {
                    targetRankBeforeCut: s1Case.expectedTargets['role-additive']['0'].instances[0]?.rankBeforeCutByOrder['name-first'] ?? null,
                    admitted: s1Name.acceptableAdmission,
                    firstAcceptablePosition: s1Name.firstAcceptablePosition,
                },
                baselineTokenizer: {
                    totalEvidenceFirst: s1Case.variants['baseline/total-evidence-first'].acceptableAdmission,
                    nameFirst: s1Case.variants['baseline/name-first'].acceptableAdmission,
                },
                roleNormalization: 'experimental prerequisite, not accepted production policy',
            },
            external: {
                uniqueCases: uniqueCaseIds,
                uniqueCaseCount: uniqueCaseIds.length,
                tokenizerComparisons: tokenizerComparisons.length,
                unscorableComparisons: unscorableComparisons.length,
                admission: {
                    gains: admission.gains,
                    losses: admission.losses,
                    lossCases: admissionLossCases,
                    gainCount: admission.gains.length,
                    lossCount: admission.losses.length,
                },
                positions: {
                    improvements: positions.improvements,
                    worsenings: positions.worsenings,
                    unchanged: positions.unchanged,
                    noRecovery: positions.noRecovery,
                    improvementCount: positions.improvements.length,
                    worseningCount: positions.worsenings.length,
                    unchangedCount: positions.unchanged.length,
                    noRecoveryCount: positions.noRecovery.length,
                    note: 'Null/null is unchanged for ordering but proves no successful recovery.',
                },
                uniqueCaseOutcomes,
            },
        };

        // Recheck every input that informed the result.
        assert.equal(await sha256Of(fixturePath), result.identities.fixture.sha256, 'Fixture changed during experiment');
        assert.equal(await sha256Of(tracePath), result.identities.inputs.s1Trace.sha256, 'S1 trace changed during experiment');
        assert.equal(await sha256Of(priorResultPath), result.identities.inputs.s1PriorResult.sha256, 'Prior result changed during experiment');
        assert.equal(await sha256Of(casesPath), result.identities.inputs.realRepoCases.sha256, 'Real-repo cases changed during experiment');
        for (const [name, hash] of Object.entries(result.identities.sources)) {
            assert.equal(await sha256Of(path.join(repo, name)), hash, `Implementation changed during experiment: ${name}`);
        }
        assert.equal(await sha256Of(path.join(navigationRoot, 'manifest.json')),
            result.identities.publication.manifestSHA256, 'Publication manifest changed during experiment');
        for (const [key, hash] of Object.entries(externalHashes)) {
            const [checkoutKey, ...relativeParts] = key.split(':');
            const relativePath = relativeParts.join(':');
            const root = checkoutKey === 'react' ? reactCheckout.root : flatbuffersCheckout.root;
            assert.equal(sha256(await fs.readFile(path.join(root, relativePath))), hash, `External source changed during experiment: ${key}`);
        }
        result.inputHashesRechecked = true;
        result.status = 'ok';
        result.identities.script.sha256 = await sha256Of(fileURLToPath(import.meta.url));
        const serializable = JSON.parse(JSON.stringify(result, (key, value) => key === 'registry' ? undefined : value));
        await fs.writeFile(out, JSON.stringify(serializable, null, 2) + '\n', { flag: 'wx' });
        written = true;
        console.log(JSON.stringify({
            status: serializable.status, out,
            s1: {
                baselineReproduction: serializable.s1.reproduction.baseline,
                roleRank: serializable.s1.reproduction.roleAdditive.observed,
                variants: Object.fromEntries(Object.entries(serializable.s1.variants).map(([key, row]) => [key,
                    { admitted: row.acceptableAdmission, first: row.firstAcceptablePosition, returned: row.returnedCount, selected: row.selectedFiles }])),
                ordering: serializable.s1.ordering,
            },
            external: Object.fromEntries(Object.entries(serializable.external.cases).map(([key, evaluated]) => [key,
                { unscorable: evaluated.unscorable, ordering: evaluated.ordering,
                    positions: Object.fromEntries(Object.entries(evaluated.variants).map(([variant, row]) => [variant, row.firstAcceptablePosition])) }])),
            verdict: serializable.verdict,
        }, null, 2));
    } catch (error) {
        if (!written) {
            result.status = result.status === 'running' ? 'failure' : result.status;
            result.failure = { ...(result.failure ?? {}), message: error.message, stack: error.stack };
            result.identities.script.sha256 = await sha256Of(fileURLToPath(import.meta.url));
            await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }).catch(() => {});
        }
        throw error;
    } finally {
        table?.close();
        connection?.close();
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

await main();
