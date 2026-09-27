import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withSourceMeasurementOperation } from '@zokizuan/satori-core';
import type { CapabilityResolver } from './capabilities.js';
import { SearchQuerySupport } from './search-query-support.js';
import type { SearchQuerySupportHost } from './search-query-support.js';
import { buildSearchQueryPlan, parseSearchOperators } from './search-query-planning.js';

function buildTrackedLexicalSupport(trackedPaths: string[]): SearchQuerySupport {
    return new SearchQuerySupport({
        normalizeSearchPath: (value) => value,
        hasPathSegment: () => false,
        isGeneratedPath: () => false,
        isTestPath: () => false,
        isFixturePath: () => false,
        isDocPath: () => false,
        getContextActiveIgnorePatterns: () => [],
        getContextTrackedRelativePaths: () => trackedPaths,
        classifyPathCategory: () => 'srcRuntime',
        shouldIncludeCategoryInScope: () => true,
        capabilities: {} as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 25,
    });
}

test('normalizeRelativePathForIgnoreCheck enforces canonical repo-relative identity', () => {
    const support = new SearchQuerySupport({} as SearchQuerySupportHost);

    assert.equal(support.normalizeRelativePathForIgnoreCheck('/etc/passwd'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('C:\\Windows\\system.ini'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('C:secret.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('\\\\server\\share\\file.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src/secret\0.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src/../../outside.ts'), null);
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src/./service.ts'), 'src/service.ts');
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src//service.ts'), 'src/service.ts');
    assert.equal(support.normalizeRelativePathForIgnoreCheck('src\\service.ts'), 'src/service.ts');
});

test('SearchQuerySupport owns the root gitignore matcher cache', () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-root-gitignore-cache-'));
    try {
        fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), '**/*.test.*\n', 'utf8');

        const support = new SearchQuerySupport({
            normalizeSearchPath: (value) => value,
            hasPathSegment: () => false,
            isGeneratedPath: () => false,
            isTestPath: () => true,
            isFixturePath: () => false,
            isDocPath: () => false,
            getContextActiveIgnorePatterns: () => [],
            getContextTrackedRelativePaths: () => [],
            classifyPathCategory: () => 'srcRuntime',
            shouldIncludeCategoryInScope: () => true,
            capabilities: {} as CapabilityResolver,
            runtimeFingerprint: {} as never,
            reranker: null,
            gitignoreForceReloadEveryN: 25,
        });

        const hint = support.buildNoiseMitigationHint(
            repositoryRoot,
            ['tests/auth.test.ts'],
            'mixed',
            { path: [] },
        );

        assert.ok(hint);
        assert.deepEqual(hint.suggestedIgnorePatterns, []);
        assert.match(hint.nextStep, /already covered by root \.gitignore/i);
    } finally {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
});

test('tracked lexical fallback anchors the window on the first line with lexical evidence', async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-tracked-lexical-'));
    const relativePath = 'src/match.ts';
    try {
        fs.mkdirSync(path.join(repositoryRoot, 'src'), { recursive: true });
        const lines = [
            ...Array.from({ length: 79 }, (_, index) => `const filler${index} = true;`),
            'const TARGETCODE = true;',
            'export const after = TARGETCODE;',
        ];
        fs.writeFileSync(path.join(repositoryRoot, relativePath), lines.join('\n'));

        const parsedOperators = parseSearchOperators('where does TARGETCODE get used');
        const queryPlan = buildSearchQueryPlan(
            parsedOperators.semanticQuery,
            true,
            parsedOperators,
        );
        const support = buildTrackedLexicalSupport([relativePath]);
        const response = await support.buildTrackedLexicalSearchResults({
            effectiveRoot: repositoryRoot,
            parsedOperators,
            queryPlan,
            scope: 'runtime',
            limit: 8,
            exactRegistryFallback: true,
        });

        assert.equal(response.results.length, 1);
        assert.deepEqual(
            [response.results[0]?.startLine, response.results[0]?.endLine],
            [78, 81],
        );
        assert.match(response.results[0]?.content || '', /TARGETCODE/);
    } finally {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
});

test('buildSearchQueryPlan classifies explicit routes without changing legacy retrieval policy', () => {
    const cases = [
        { query: 'writeSourceCheckpoint', route: 'exact_identifier', retrievalMode: 'lexical' },
        { query: 'path:src/search/ranking.ts rankCandidates', route: 'exact_path', retrievalMode: 'lexical' },
        { query: '"SOURCE_CHECKPOINT_MISSING"', route: 'literal', retrievalMode: 'lexical' },
        { query: 'where is RERANK_TOP_K configured', route: 'configuration', retrievalMode: 'lexical' },
        {
            query: 'Which function runs a complete backtest for a configured pair?',
            route: 'mixed',
            retrievalMode: 'hybrid',
        },
        { query: 'owner of rankCandidates', route: 'ownership', retrievalMode: 'hybrid' },
        { query: 'who calls writeSourceCheckpoint', route: 'references', retrievalMode: 'hybrid' },
        { query: 'trace public search architecture', route: 'structural', retrievalMode: 'hybrid' },
        { query: 'decide whether exact or semantic retrieval is needed', route: 'conceptual', retrievalMode: 'hybrid' },
        { query: 'rankCandidates diversity policy', route: 'mixed', retrievalMode: 'hybrid' },
    ] as const;

    for (const row of cases) {
        const parsed = parseSearchOperators(row.query);
        const plan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
        assert.equal(plan.route.kind, row.route, row.query);
        assert.equal(plan.route.currentProviderBudget.semanticPassesPerAttempt >= 1, true);
        assert.equal(plan.retrievalMode, row.retrievalMode, row.query);
    }
});

test('buildSearchQueryPlan retains technical compound terms before bounded natural-language terms', () => {
    const parsed = parseSearchOperators(
        'Where is the final local candidate score composed from fusion, lexical, path, changed-file, agent-fit, and owner evidence?',
    );
    const plan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);

    assert.deepEqual(
        plan.lexicalTerms.map((term) => term.value),
        ['changed-file', 'agent-fit', 'final', 'local', 'candidate', 'score', 'composed', 'fusion'],
    );
});

test('buildSearchQueryPlan distinguishes entrypoint ownership from adjacent CLI intent', () => {
    const cases = [
        {
            query: 'Where does the command-line application start, and which function owns startup?',
            kinds: ['application_startup_ownership'],
        },
        {
            query: 'Find the function that creates and launches the user-facing command line interface.',
            kinds: ['application_startup_ownership'],
        },
        {
            query: 'How does running the qap terminal command enter the application?',
            kinds: ['installed_command_ownership'],
        },
        {
            query: 'Which function is the installed command target?',
            kinds: ['installed_command_ownership'],
        },
        {
            query: 'Where is the qap binary declared?',
            kinds: ['command_declaration'],
        },
        {
            query: 'Where are CLI startup tests?',
            kinds: ['test_startup'],
            testSeeking: true,
        },
        {
            query: 'Where is the development startup test?',
            kinds: ['test_startup'],
            testSeeking: true,
        },
        {
            query: 'Where is the mock CLI startup test?',
            kinds: ['test_startup'],
            testSeeking: true,
        },
        {
            query: 'Where is the mock CLI startup?',
            kinds: ['test_startup'],
            testSeeking: true,
        },
        {
            query: 'Where does the fixture application start?',
            kinds: ['test_startup'],
            testSeeking: true,
        },
        {
            query: 'Find the stub command entrypoint.',
            kinds: ['test_startup'],
            testSeeking: true,
        },
        {
            query: 'Which development script launches the mock application?',
            kinds: ['development_execution'],
            testSeeking: false,
        },
        {
            query: 'Where is the startup configuration parsed?',
            kinds: [],
        },
        {
            query: 'How is the application running?',
            kinds: [],
        },
        {
            query: 'Where is the running application worker?',
            kinds: [],
        },
        {
            query: 'Where is the target application configuration?',
            kinds: [],
        },
        {
            query: 'Find the helper used after the command has already started.',
            kinds: ['post_startup_runtime'],
        },
        {
            query: 'Where is application shutdown handled?',
            kinds: ['post_startup_runtime'],
        },
        {
            query: 'cli_entry_point',
            kinds: [],
        },
    ] as const;

    for (const row of cases) {
        const parsed = parseSearchOperators(row.query);
        const plan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
        assert.deepEqual(plan.entrypointIntent.kinds, row.kinds, row.query);
        if ('testSeeking' in row) {
            assert.equal(plan.testSeeking, row.testSeeking, row.query);
        }
    }
});

test('parseSearchOperators derives clean retrieval text for operator-only requests', () => {
    const cases = [
        {
            query: 'must:spread path:src/python/core -path:scripts',
            semanticQuery: 'spread',
        },
        {
            query: 'must:Kelly must:fractional path:src/python',
            semanticQuery: 'Kelly fractional',
        },
        {
            query: 'must:"position sizing" path:src/python',
            semanticQuery: 'position sizing',
        },
        {
            query: 'path:src/python/core -path:tests',
            semanticQuery: 'src/python/core',
        },
        {
            query: 'lang:python -path:tests',
            semanticQuery: 'python',
        },
        {
            query: 'must:spread path:src/python spread calculation',
            semanticQuery: 'spread calculation',
        },
        {
            query: '\\path:literal',
            semanticQuery: 'path:literal',
        },
        {
            query: 'exclude:legacy -path:tests',
            semanticQuery: '',
        },
    ];

    for (const row of cases) {
        assert.equal(parseSearchOperators(row.query).semanticQuery, row.semanticQuery, row.query);
    }
});

test('buildSearchQueryPlan keeps the accepted baseline while exposing semantic-cue replay', () => {
    const cases = [
        { query: 'src/search/ranking.ts', route: 'exact_path', retrievalMode: 'lexical' },
        { query: 'open src/search/ranking.ts', route: 'exact_path', retrievalMode: 'lexical' },
        { query: 'path:src/search/ranking.ts rankCandidates', route: 'exact_path', retrievalMode: 'lexical' },
        {
            query: 'reconcile ignore rules when .gitignore or satori.toml changes during sync',
            route: 'mixed',
            retrievalMode: 'hybrid',
        },
        { query: 'who calls initialization in src/runtime.ts', route: 'references', retrievalMode: 'hybrid' },
        { query: 'where is src/runtime.ts configured', route: 'configuration', retrievalMode: 'lexical' },
        { query: 'trace the startup pipeline in src/runtime.ts', route: 'structural', retrievalMode: 'hybrid' },
    ] as const;

    for (const row of cases) {
        const parsed = parseSearchOperators(row.query);
        const plan = buildSearchQueryPlan(
            parsed.semanticQuery,
            true,
            parsed,
            'semantic_cues_before_heuristic_path_v1',
        );
        assert.equal(plan.route.kind, row.route, row.query);
        assert.equal(plan.retrievalMode, row.retrievalMode, row.query);
    }

    const parsed = parseSearchOperators(
        'reconcile ignore rules when .gitignore or satori.toml changes during sync',
    );
    const baseline = buildSearchQueryPlan(
        parsed.semanticQuery,
        true,
        parsed,
        'baseline_path_anywhere_v1',
    );
    assert.equal(baseline.route.kind, 'exact_path');
    assert.equal(baseline.retrievalMode, 'lexical');
    assert.equal(baseline.rerankAllowed, false);

    const defaultPlan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
    assert.deepEqual(defaultPlan, baseline);

    const contender = buildSearchQueryPlan(
        parsed.semanticQuery,
        true,
        parsed,
        'semantic_cues_before_heuristic_path_v1',
    );
    assert.equal(contender.route.kind, 'mixed');
    assert.equal(contender.retrievalMode, 'hybrid');
    assert.equal(contender.rerankAllowed, true);
});

test('buildSearchQueryPlan extracts one strong structural target and reference direction', () => {
    const ownership = parseSearchOperators('who owns rankCandidates');
    const ownershipPlan = buildSearchQueryPlan(ownership.semanticQuery, true, ownership);
    assert.equal(ownershipPlan.route.kind, 'ownership');
    assert.equal(ownershipPlan.exactIdentifierTarget, 'rankCandidates');
    assert.equal(ownershipPlan.referenceDirection, undefined);

    const capitalizedOwnership = parseSearchOperators('Who owns rankCandidates?');
    const capitalizedOwnershipPlan = buildSearchQueryPlan(
        capitalizedOwnership.semanticQuery,
        true,
        capitalizedOwnership,
    );
    assert.equal(capitalizedOwnershipPlan.route.kind, 'ownership');
    assert.equal(capitalizedOwnershipPlan.exactIdentifierTarget, 'rankCandidates');

    const callers = parseSearchOperators('Who calls writeSourceCheckpoint?');
    const callerPlan = buildSearchQueryPlan(callers.semanticQuery, true, callers);
    assert.equal(callerPlan.route.kind, 'references');
    assert.equal(callerPlan.exactIdentifierTarget, 'writeSourceCheckpoint');
    assert.equal(callerPlan.referenceDirection, 'callers');

    const conceptual = parseSearchOperators('where is retry policy decided');
    const conceptualPlan = buildSearchQueryPlan(conceptual.semanticQuery, true, conceptual);
    assert.equal(conceptualPlan.exactIdentifierTarget, undefined);
    assert.equal(conceptualPlan.referenceDirection, undefined);
});

test('buildSearchQueryPlan keeps conceptual where-is questions on a semantic route', () => {
    const conceptualQueries = [
        'where is authentication behavior handled',
        'where is retry policy decided',
        'where is search quality enforced',
    ];

    for (const query of conceptualQueries) {
        const parsed = parseSearchOperators(query);
        const plan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
        assert.equal(plan.route.kind, 'conceptual', query);
        assert.equal(plan.referenceSeeking, false, query);
        if (!query.includes('decided')) {
            assert.equal(plan.implementationSeeking, false, query);
        }
    }

    const exactTarget = parseSearchOperators('where is rankCandidates handled');
    assert.equal(
        buildSearchQueryPlan(exactTarget.semanticQuery, true, exactTarget).route.kind,
        'ownership',
    );
});

test('exact live-path recovery rejects substring-only whole-token evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-live-path-'));
    const relativePath = 'src/a.ts';
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const support = new SearchQuerySupport({
        getContextActiveIgnorePatterns: () => [],
    } as unknown as SearchQuerySupportHost);
    const run = async (content: string) => {
        fs.writeFileSync(path.join(root, relativePath), content, 'utf8');
        const parsedOperators = parseSearchOperators(`path:${relativePath} auth`);
        return support.buildLivePathScopedSearchResults({
            effectiveRoot: root,
            parsedOperators,
            queryPlan: buildSearchQueryPlan(parsedOperators.semanticQuery, true),
            changedFiles: new Set([relativePath]),
        });
    };

    try {
        assert.deepEqual(await run('const author = true;\n'), []);
        const positive = await run('const auth = true;\n');
        assert.equal(positive.length, 1);
        assert.match(positive[0]?.content ?? '', /\bauth\b/);

        const ledgerFile = path.join(root, 'source-ledger.jsonl');
        const measured = await withSourceMeasurementOperation({
            operation: 'search_codebase',
            ledgerFile,
            rootDir: root,
        }, () => run('const auth = true;\n'));
        assert.deepEqual(measured, positive);
        const records = fs.readFileSync(ledgerFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        assert.deepEqual(records.map((record) => record.kind), [
            'source_observation',
            'source_io',
            'source_observation_outcome',
            'source_processing',
        ]);
        assert.equal(records[0].owner, 'search_evidence');
        assert.equal(records[1].bytesObtained, Buffer.byteLength('const auth = true;\n'));
        assert.equal(records[2].status, 'completed');
        assert.equal(records[3].owner, 'search_evidence');
        assert.equal(records[3].outcome, 'success');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('exact live-path recovery reads unrecognized extensions and admits them by shebang', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-live-shebang-'));
    fs.mkdirSync(path.join(root, 'cgi'), { recursive: true });
    const support = new SearchQuerySupport({
        getContextActiveIgnorePatterns: () => [],
    } as unknown as SearchQuerySupportHost);
    const run = async (relativePath: string, content: string) => {
        fs.writeFileSync(path.join(root, relativePath), content, 'utf8');
        const parsedOperators = parseSearchOperators(`path:${relativePath} auth`);
        return support.buildLivePathScopedSearchResults({
            effectiveRoot: root,
            parsedOperators,
            queryPlan: buildSearchQueryPlan(parsedOperators.semanticQuery, true),
            changedFiles: new Set([relativePath]),
        });
    };

    try {
        const script = await run('cgi/report.cgi', '#!/usr/bin/env python3\nauth = True\n');
        assert.equal(script.length, 1);
        assert.equal(script[0]?.language, 'python');
        assert.deepEqual(await run('cgi/notes.cgi', 'auth notes\n'), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
