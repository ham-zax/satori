import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const workspaceRoot = path.resolve(path.dirname(runner), '../..');
const commit = 'a'.repeat(40);
const query = id => ({ id, query: 'find owner', tags: [], acceptable: [
    { pathRegex: '^src/owner\\.ts$', symbolRegex: '^owner$', evidence: 'src/owner.ts:1' },
] });

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-harness-run-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outDir = path.join(root, 'out');
    const stateRoot = path.join(root, 'state');
    const repos = ['react', 'polars'].map(name => ({
        name, commit, url: `https://example.invalid/${name}`, queries: [query(`${name}1`)],
    }));
    for (const repo of repos) {
        fs.mkdirSync(path.join(root, 'home/.cache/satori-eval-repos', `${repo.name}@${commit}`, '.git'), { recursive: true });
    }
    const casesFile = path.join(root, 'cases.json');
    const writeCases = () => fs.writeFileSync(casesFile, JSON.stringify({ topK: 10, repos }));
    writeCases();

    // Replace external I/O at the CLI boundary; keep the runner, scorer, logger,
    // JSON writes, and target resolution against a real temporary LanceDB.
    fs.writeFileSync(path.join(root, 'os.mjs'), `export default { homedir: () => ${JSON.stringify(path.join(root, 'home'))} };`);
    fs.writeFileSync(path.join(root, 'git.mjs'), `
        export function execFileSync(command, args) {
            if (command !== 'git') throw new Error('unexpected command: ' + command);
            if (args.includes('rev-parse')) return ${JSON.stringify(commit)};
            if (args.includes('status') || args.includes('diff') || args.includes('ls-files')) return '';
            throw new Error('unexpected git operation: ' + args.join(' '));
        }
    `);
    fs.writeFileSync(path.join(root, 'dist.mjs'), `
        export class DistStaleError extends Error {}
        export function assertRuntimeDistFresh() {}
        export async function importFreshDist() {
            return {
                buildSearchQueryPlan: query => ({ semanticQuery: query }),
                resolveSearchAnswerFocus: () => ({ focus: 'neutral', reasons: [] }),
                classifyPathCategory: () => 'srcRuntime',
                isNonProductionDistractor: () => false,
                resolveSearchFlags: () => ({ compound_join: true, path_demotion: true }),
                SEARCH_ALT_TERMS_MAX: 4,
                reservationCapForPolicy: () => 55,
            };
        }
    `);
    const lanceUrl = pathToFileURL(path.join(workspaceRoot, 'packages/core/node_modules/@lancedb/lancedb/dist/index.js')).href;
    fs.writeFileSync(path.join(root, 'session.mjs'), `
        import * as lancedb from ${JSON.stringify(lanceUrl)};
        import path from 'node:path';
        export async function openLocalSession({ stateRoot }) {
            const db = await lancedb.connect(path.join(stateRoot, 'vector/lancedb'));
            return {
                stderr: [], protocolErrors: [], async close() {},
                async call(tool, args) {
                    if (tool === 'list_codebases') return { text: '[]' };
                    const repo = path.basename(args.path).split('@')[0];
                    const id = 'chunk-' + repo;
                    if (tool === 'manage_index') {
                        if (args.action === 'clear') await db.dropTable(repo);
                        if (args.action === 'create') await db.createTable(repo, [{
                            id, relativePath: 'src/owner.ts', startLine: 1, endLine: 10,
                            metadataJson: JSON.stringify({ codebasePath: args.path, symbolLabel: 'function owner' }),
                        }]);
                        const status = (await db.tableNames()).includes(repo) ? 'ok' : 'not_indexed';
                        return { text: JSON.stringify({ status }), json: { status }, isError: false };
                    }
                    if (tool !== 'search_codebase') throw new Error('unexpected tool: ' + tool);
                    const candidate = { candidateId: id, relativePath: 'src/owner.ts', startLine: 1, endLine: 10, rank: 1, score: 0.9 };
                    const json = {
                        status: 'ok', fixtureRevision: process.env.SATORI_HARNESS_TEST_REVISION,
                        results: [{ target: { file: 'src/owner.ts', span: { startLine: 1, endLine: 10 } }, displayLabel: 'function owner', symbolKind: 'function' }],
                        hints: { debugSearch: {
                            phaseTimingsMs: { semanticSearch: 19.6, rerank: 4.4 },
                            candidateSurvival: { stages: [
                                { stage: 'mcp_pass', passId: 'attempt:1/primary', candidates: [candidate] },
                                { stage: 'mcp_fusion', candidates: [candidate] },
                                { stage: 'grouped', candidates: [{ ...candidate, groupReplay: { displayLabel: 'function owner' } }] },
                            ] },
                        } },
                    };
                    return { text: JSON.stringify(json), json, isError: false };
                },
            };
        }
    `);
    fs.writeFileSync(path.join(root, 'loader.mjs'), `
        import { pathToFileURL } from 'node:url';
        const runner = ${JSON.stringify(pathToFileURL(runner).href)};
        const replacements = {
            'node:os': 'os.mjs', 'node:child_process': 'git.mjs',
            './session.mjs': 'session.mjs', './dist-freshness.mjs': 'dist.mjs',
        };
        export function resolve(specifier, context, nextResolve) {
            if (context.parentURL === runner && replacements[specifier]) {
                return { url: pathToFileURL(${JSON.stringify(root)} + '/' + replacements[specifier]).href, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        }
    `);
    const preload = path.join(root, 'preload.mjs');
    fs.writeFileSync(preload, `import { register } from 'node:module'; register('./loader.mjs', import.meta.url);`);

    return {
        repos, writeCases,
        run(names, revision = '1') {
            execFileSync(process.execPath, ['--import', preload, runner,
                '--cases', casesFile, '--repos', names, '--state-root', stateRoot, '--out', outDir], {
                cwd: workspaceRoot, encoding: 'utf8', timeout: 30_000,
                env: { ...process.env, SATORI_HARNESS_TEST_REVISION: revision },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return Object.fromEntries(['result', 'harness-log', 'fused-pool'].map(name =>
                [name, JSON.parse(fs.readFileSync(path.join(outDir, `${name}.json`), 'utf8'))]));
        },
    };
}

test('a fresh state indexes before resolving targets and searching', t => {
    const output = fixture(t).run('react');
    const repo = output.result.repos[0];
    assert.equal(repo.indexing.succeeded, true);
    assert.ok(repo.indexing.events.some(event => event.args.action === 'create'));
    assert.deepEqual(output['harness-log'][0].targets, ['chunk-react']);
    assert.equal(repo.queries[0].responseStatus, 'ok');
});

test('sequential React and Polars runs retain both repositories in all JSON outputs', t => {
    const f = fixture(t);
    const react = f.run('react');
    const both = f.run('polars');
    assert.deepEqual(both.result.repos.map(repo => repo.name), ['react', 'polars']);
    assert.deepEqual(both['harness-log'].map(record => record.repo), ['react', 'polars']);
    assert.deepEqual(Object.values(both['fused-pool'].queries).map(record => record.repo), ['react', 'polars']);
    assert.deepEqual(both.result.repos[0], react.result.repos[0]);
    assert.deepEqual(both['harness-log'][0], react['harness-log'][0]);
    assert.deepEqual(both['fused-pool'].queries.react1, react['fused-pool'].queries.react1);
});

test('rerunning React replaces its records and preserves Polars in all JSON outputs', t => {
    const f = fixture(t);
    const before = f.run('react,polars');
    f.repos[0].queries = [query('react2')];
    f.writeCases();
    const after = f.run('react', '2');
    assert.deepEqual(after.result.repos.map(repo => repo.name), ['polars', 'react']);
    assert.deepEqual(after.result.repos.find(repo => repo.name === 'react').queries.map(q => q.id), ['react2']);
    assert.equal(after.result.repos.find(repo => repo.name === 'react').queries[0].response.fixtureRevision, '2');
    assert.deepEqual(after['harness-log'].map(record => record.query_id), ['polars1', 'react2']);
    assert.deepEqual(Object.keys(after['fused-pool'].queries), ['polars1', 'react2']);
    assert.deepEqual(after.result.repos[0], before.result.repos[1]);
    assert.deepEqual(after['harness-log'][0], before['harness-log'][1]);
    assert.deepEqual(after['fused-pool'].queries.polars1, before['fused-pool'].queries.polars1);
});
