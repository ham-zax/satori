// CBM parity harness (ticket 05): measures how closely Satori's CBM-definition
// adapter matches the codebase-memory-mcp binary on the same files.
//
//   node --import tsx scripts/language-parity.ts [--languages a,b]
//        [--max-files-per-language N] [--date YYYY-MM-DD] [--no-repos]
//
// Corpus: one fixture per grammar from CBM's own test table
// (tests/test_grammar_regression.c at the pinned commit) plus the pinned repos
// in scripts/language-parity-corpus.json, cloned into the scratch directory.
// Every heavy step runs in a memory-capped systemd scope, one at a time.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageId } from '../packages/core/src/language/registry';
import { analyzeWithCbmDefinitions, supportsCbmDefinitions } from '../packages/core/src/language-analysis/cbm-definition-adapter';
import { CBM_LANGUAGE_MAP_COMMIT } from '../packages/core/src/languages/cbm-language-map';

const __filename = fileURLToPath(import.meta.url);
const SATORI_ROOT = path.resolve(path.dirname(__filename), '..');
const CBM_ROOT = process.env.CBM_ROOT ?? path.resolve(SATORI_ROOT, '../codebase-memory-mcp');
const WORK_ROOT = process.env.SATORI_PARITY_WORK ?? path.join(os.tmpdir(), 'satori-language-parity');
const MEMORY_MAX = process.env.SATORI_PARITY_MEMORY_MAX ?? '2G';
const EVIDENCE_DIR = path.join(SATORI_ROOT, 'docs/evidence/language-parity');
const CORPUS_FILE = path.join(SATORI_ROOT, 'scripts/language-parity-corpus.json');
// Labels the adapter maps to Satori kinds (cbm-definition-adapter.ts); every
// other CBM label is outside the parity metric by design.
const LABELS = ['Class', 'Enum', 'Function', 'Interface', 'Macro', 'Method', 'Struct', 'Trait', 'Type'] as const;
const PASS_THRESHOLD = 0.95;
const SAMPLE_LIMIT = 3;
const LANGUAGES_PER_WORKER = 12;

interface CorpusRepo { readonly repo: string; readonly rev: string }
interface Root { readonly id: string; readonly dir: string; readonly corpus: CorpusRepo }
interface FileJob { readonly root: string; readonly relativePath: string; readonly language: string }
interface Definition { readonly relativePath: string; readonly name: string; readonly startLine: number }
interface LanguageResult {
    files: number; cbmDefinitions: number; satoriDefinitions: number; matched: number;
    recall: number; precision: number; pass: boolean;
    missing: string[]; extra: string[]; errors: number;
}

function fail(message: string): never {
    throw new Error(`language-parity: ${message}`);
}

function run(command: string, args: readonly string[], options: { cwd?: string; capped?: boolean } = {}): string {
    const [file, argv] = options.capped
        ? ['systemd-run', ['--user', '--scope', '--quiet', '-p', `MemoryMax=${MEMORY_MAX}`, '-p', 'MemorySwapMax=0', command, ...args]]
        : [command, [...args]];
    const result = spawnSync(file, argv, { cwd: options.cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) {
        fail(`${command} ${args.slice(0, 3).join(' ')} failed (${result.status ?? result.signal}): ${(result.error?.message ?? result.stderr).trim().slice(-2000)}`);
    }
    return result.stdout;
}

// ── CBM fixture table ──────────────────────────────────────────────────────

function decodeCString(body: string): string {
    return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, escape: string) => {
        if (escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
        if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
        return ({ n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' } as Record<string, string>)[escape] ?? escape;
    });
}

/** Parses CBM_GRAMMAR_CASES into {name, path, src}; adjacent literals concatenate. */
function parseGrammarCases(source: string): { name: string; path: string; src: string }[] {
    const start = source.indexOf('CBM_GRAMMAR_CASES[] = {');
    if (start < 0) fail('CBM_GRAMMAR_CASES table not found');
    const tokens: string[] = [];
    const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"((?:[^"\\]|\\.)*)"|[{},]|[A-Za-z_0-9]+|\S/g;
    pattern.lastIndex = source.indexOf('{', start);
    let depth = 0;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const token = match[0];
        if (token.startsWith('/*') || token.startsWith('//')) continue;
        if (token === '{') depth++;
        if (token === '}') depth--;
        if (match[1] !== undefined && tokens.length > 0 && tokens[tokens.length - 1].startsWith('"')) {
            tokens[tokens.length - 1] += match[1];
        } else {
            tokens.push(match[1] !== undefined ? `"${match[1]}` : token);
        }
        if (depth === 0) break;
    }
    const cases: { name: string; path: string; src: string }[] = [];
    for (let index = 1; index < tokens.length; index++) {
        if (tokens[index] !== '{' || !tokens[index + 1]?.startsWith('"')) continue;
        const fields = [tokens[index + 1], tokens[index + 3], tokens[index + 5], tokens[index + 7]];
        if (tokens[index + 2] !== ',' || !fields[2]?.startsWith('"') || !fields[3]?.startsWith('"')) continue;
        const [name, , file, src] = fields.map((field) => decodeCString(field.slice(1)));
        cases.push({ name, path: file, src });
    }
    if (cases.length < 50) fail(`parsed only ${cases.length} grammar cases`);
    return cases;
}

function materializeFixtures(): Root {
    const cbmHead = run('git', ['rev-parse', 'HEAD'], { cwd: CBM_ROOT }).trim();
    if (cbmHead !== CBM_LANGUAGE_MAP_COMMIT) fail(`CBM checkout ${CBM_ROOT} is at ${cbmHead}, expected ${CBM_LANGUAGE_MAP_COMMIT}`);
    const cases = parseGrammarCases(fs.readFileSync(path.join(CBM_ROOT, 'tests/test_grammar_regression.c'), 'utf8'));
    const dir = path.join(WORK_ROOT, 'fixtures');
    fs.rmSync(dir, { recursive: true, force: true });
    for (const fixture of cases) {
        const target = path.join(dir, fixture.name, fixture.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fixture.src);
    }
    run('git', ['init', '-q', '.'], { cwd: dir });
    return { id: 'cbm-grammar-fixtures', dir, corpus: { repo: `${CBM_ROOT.split(path.sep).pop()}:tests/test_grammar_regression.c`, rev: cbmHead } };
}

function cloneRepo(entry: CorpusRepo): Root {
    const id = entry.repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/[^A-Za-z0-9]+/g, '-');
    const dir = path.join(WORK_ROOT, 'repos', id);
    const head = fs.existsSync(path.join(dir, '.git')) ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim() : '';
    if (head !== entry.rev) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        run('git', ['init', '-q', '.'], { cwd: dir });
        run('git', ['fetch', '-q', '--depth', '1', entry.repo, entry.rev], { cwd: dir, capped: true });
        run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: dir });
    }
    return { id, dir, corpus: entry };
}

// ── CBM oracle ─────────────────────────────────────────────────────────────

interface CbmQueryPage {
    readonly rows: [string, string, string][];
    readonly has_more?: boolean;
    readonly truncated?: boolean;
    readonly truncation_reason?: string;
    readonly next_cursor?: string;
}

function cbmDefinitions(root: Root): Definition[] {
    const indexed = JSON.parse(run('codebase-memory-mcp', ['cli', '--quiet', 'index_repository', JSON.stringify({ repo_path: root.dir })], { capped: true })) as { project?: string };
    const project = indexed.project ?? fail(`CBM did not report a project for ${root.dir}`);
    const definitions: Definition[] = [];
    try {
        for (const label of LABELS) {
            const query = `MATCH (n:${label}) RETURN n.file_path, n.start_line, n.name ORDER BY n.file_path, n.start_line, n.name`;
            let cursor: string | undefined;
            do {
                // format:json gives direct strings (the default tree format may
                // abbreviate shared path prefixes); pages continue via next_cursor.
                const request = cursor ? { project, query, cursor, format: 'json', max_rows: 5000, max_output_tokens: 1_000_000 }
                    : { project, query, format: 'json', max_rows: 5000, max_output_tokens: 1_000_000 };
                const page = JSON.parse(run('codebase-memory-mcp', ['cli', '--quiet', 'query_graph', JSON.stringify(request)])) as CbmQueryPage;
                if (!Array.isArray(page.rows)) fail(`unexpected CBM query output for ${label} in ${root.id}`);
                if (page.truncated && page.truncation_reason !== 'page_limit') fail(`CBM truncated ${label} rows for ${root.id}: ${page.truncation_reason}`);
                for (const [relativePath, line, name] of page.rows) {
                    definitions.push({ relativePath, name, startLine: Number(line) });
                }
                cursor = page.has_more ? page.next_cursor ?? fail(`CBM reported more ${label} rows without a cursor`) : undefined;
            } while (cursor);
        }
    } finally {
        run('codebase-memory-mcp', ['cli', '--quiet', 'delete_project', JSON.stringify({ project })]);
    }
    return definitions;
}

// ── Satori adapter (runs in capped worker processes) ───────────────────────

function listFiles(root: Root): string[] {
    return run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root.dir })
        .split('\0').filter(Boolean).sort();
}

async function workerMain(jobFile: string, outFile: string): Promise<void> {
    const jobs = JSON.parse(fs.readFileSync(jobFile, 'utf8')) as FileJob[];
    const results: { job: FileJob; definitions: Definition[] | null }[] = [];
    for (const job of jobs) {
        const content = fs.readFileSync(path.join(job.root, job.relativePath), 'utf8');
        try {
            const symbols = await analyzeWithCbmDefinitions({ content, relativePath: job.relativePath, language: job.language });
            results.push({ job, definitions: symbols.map((symbol) => ({ relativePath: job.relativePath, name: symbol.name, startLine: symbol.span.startLine })) });
        } catch {
            results.push({ job, definitions: null });
        }
    }
    fs.writeFileSync(outFile, JSON.stringify(results));
}

function satoriDefinitions(jobs: readonly FileJob[]): { job: FileJob; definitions: Definition[] | null }[] {
    const languages = [...new Set(jobs.map((job) => job.language))].sort();
    const results: { job: FileJob; definitions: Definition[] | null }[] = [];
    const scratch = fs.mkdtempSync(path.join(WORK_ROOT, 'worker-'));
    try {
        for (let index = 0; index < languages.length; index += LANGUAGES_PER_WORKER) {
            const batch = new Set(languages.slice(index, index + LANGUAGES_PER_WORKER));
            const jobFile = path.join(scratch, `jobs-${index}.json`);
            const outFile = path.join(scratch, `out-${index}.json`);
            fs.writeFileSync(jobFile, JSON.stringify(jobs.filter((job) => batch.has(job.language))));
            run(process.execPath, ['--import', 'tsx', __filename, '--worker', jobFile, outFile], { cwd: SATORI_ROOT, capped: true });
            results.push(...JSON.parse(fs.readFileSync(outFile, 'utf8')) as typeof results);
        }
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    return results;
}

// ── Comparison ─────────────────────────────────────────────────────────────

function key(root: string, definition: Definition): string {
    return `${root}:${definition.relativePath}:${definition.startLine}:${definition.name}`;
}

function ratio(numerator: number, denominator: number): number {
    return denominator === 0 ? 1 : Math.round((numerator / denominator) * 10000) / 10000;
}

function parseArgs(argv: readonly string[]) {
    const options = { languages: null as Set<string> | null, maxFiles: 200, date: new Date().toISOString().slice(0, 10), repos: true };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--languages') options.languages = new Set(argv[++index].split(',').filter(Boolean));
        else if (arg === '--max-files-per-language') options.maxFiles = Number(argv[++index]);
        else if (arg === '--date') options.date = argv[++index];
        else if (arg === '--no-repos') options.repos = false;
        else fail(`unknown argument ${arg}`);
    }
    if (!Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1) fail('--max-files-per-language must be a positive integer');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) fail('--date must be YYYY-MM-DD');
    return options;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as CorpusRepo[];
    const roots = [materializeFixtures(), ...(options.repos ? corpus.map(cloneRepo) : [])];

    const results = new Map<string, LanguageResult>();
    const resultFor = (language: string) => {
        let result = results.get(language);
        if (!result) {
            result = { files: 0, cbmDefinitions: 0, satoriDefinitions: 0, matched: 0, recall: 0, precision: 0, pass: false, missing: [], extra: [], errors: 0 };
            results.set(language, result);
        }
        return result;
    };

    for (const root of roots) {
        const perLanguage = new Map<string, string[]>();
        for (const relativePath of listFiles(root)) {
            const absolute = path.join(root.dir, relativePath);
            if (!fs.statSync(absolute).isFile()) continue;
            const language = detectLanguageId(relativePath, fs.readFileSync(absolute, 'utf8'));
            if (options.languages && !options.languages.has(language)) continue;
            if (!supportsCbmDefinitions(language)) continue;
            const files = perLanguage.get(language) ?? [];
            if (files.length < options.maxFiles) files.push(relativePath);
            perLanguage.set(language, files);
        }
        if (perLanguage.size === 0) continue;
        const languageOf = new Map<string, string>();
        for (const [language, files] of perLanguage) for (const file of files) languageOf.set(file, language);

        const expected = new Map<string, number>();
        for (const definition of cbmDefinitions(root)) {
            const language = languageOf.get(definition.relativePath);
            if (!language) continue;
            resultFor(language).cbmDefinitions++;
            const id = key(root.id, definition);
            expected.set(id, (expected.get(id) ?? 0) + 1);
        }
        const jobs = [...languageOf].map(([relativePath, language]) => ({ root: root.dir, relativePath, language }));
        const extracted = satoriDefinitions(jobs);
        for (const { job, definitions } of extracted) {
            const result = resultFor(job.language);
            result.files++;
            if (!definitions) {
                result.errors++;
                continue;
            }
            for (const definition of definitions) {
                result.satoriDefinitions++;
                const id = key(root.id, definition);
                const remaining = expected.get(id) ?? 0;
                if (remaining > 0) {
                    result.matched++;
                    expected.set(id, remaining - 1);
                } else {
                    result.extra.push(id);
                }
            }
        }
        for (const [id, remaining] of expected) {
            const relativePath = id.slice(root.id.length + 1).split(':')[0];
            for (let count = 0; count < remaining; count++) resultFor(languageOf.get(relativePath)!).missing.push(id);
        }
    }

    const languages: Record<string, unknown> = {};
    for (const language of [...results.keys()].sort()) {
        const result = results.get(language)!;
        result.recall = ratio(result.matched, result.cbmDefinitions);
        result.precision = ratio(result.matched, result.satoriDefinitions);
        result.pass = result.errors === 0 && result.recall >= PASS_THRESHOLD && result.precision >= PASS_THRESHOLD;
        languages[language] = {
            files: result.files, cbmDefinitions: result.cbmDefinitions, satoriDefinitions: result.satoriDefinitions,
            matched: result.matched, recall: result.recall, precision: result.precision, pass: result.pass,
            ...(result.errors ? { extractorErrors: result.errors } : {}),
            ...(result.missing.length ? { sampleMissing: result.missing.sort().slice(0, SAMPLE_LIMIT) } : {}),
            ...(result.extra.length ? { sampleExtra: result.extra.sort().slice(0, SAMPLE_LIMIT) } : {}),
        };
    }
    const cbmVersion = run('codebase-memory-mcp', ['--version']).trim().split(/\s+/).pop();
    const manifest = fs.readFileSync(path.join(SATORI_ROOT, 'packages/core/assets/cbm-extractor/manifest.json'));
    const evidence = {
        cbmVersion,
        cbmCommit: CBM_LANGUAGE_MAP_COMMIT,
        extractorManifestSha256: createHash('sha256').update(manifest).digest('hex'),
        satoriCommit: run('git', ['describe', '--always', '--dirty', '--abbrev=40'], { cwd: SATORI_ROOT }).trim(),
        maxFilesPerLanguage: options.maxFiles,
        corpus: roots.map((root) => root.corpus),
        languages,
    };
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${options.date}.json`), `${JSON.stringify(evidence, null, 2)}\n`);

    const table = [
        '| Language | Files | CBM defs | Satori defs | Matched | Recall | Precision | Pass |',
        '|---|---:|---:|---:|---:|---:|---:|---|',
        ...Object.entries(languages).map(([language, value]) => {
            const row = value as LanguageResult;
            return `| ${language} | ${row.files} | ${row.cbmDefinitions} | ${row.satoriDefinitions} | ${row.matched} | ${row.recall.toFixed(4)} | ${row.precision.toFixed(4)} | ${row.pass ? 'yes' : 'no'} |`;
        }),
    ];
    const passing = Object.values(languages).filter((value) => (value as LanguageResult).pass).length;
    const markdown = [
        `# CBM definition parity — ${options.date}`,
        '',
        `CBM ${cbmVersion} (${CBM_LANGUAGE_MAP_COMMIT.slice(0, 8)}) vs Satori ${evidence.satoriCommit.slice(0, 8)}; `
            + `match key (path, name, start line); pass = recall and precision ≥ ${PASS_THRESHOLD}. `
            + `${passing}/${Object.keys(languages).length} languages pass. Raw data: [${options.date}.json](${options.date}.json).`,
        '',
        ...table,
        '',
    ].join('\n');
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${options.date}.md`), markdown);
    console.log(markdown);
}

if (process.argv[2] === '--worker') {
    await workerMain(process.argv[3], process.argv[4]);
} else {
    await main();
}
