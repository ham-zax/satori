#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Extensions CBM routes through a language that Satori deliberately owns
// elsewhere. Razor (.razor/.cshtml) is markup with embedded C#: CBM only
// text-scans it for @page routes, while Satori's C# analyzer would parse the
// markup as C# and degrade C# navigation evidence, so Satori keeps Razor as
// its own search-only language. Any other cross-owner conflict still fails.
const SATORI_EXTENSION_SPLITS = new Map([
    ['.cshtml', 'razor'],
    ['.razor', 'razor'],
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Usage: node scripts/sync-cbm-language-map.mjs [--check] [<path-to-codebase-memory-mcp>]
// --check renders without writing and exits 1 when the committed file differs.
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const cbmRoot = path.resolve(args.find((arg) => arg !== '--check') ?? '/home/hamza/repo/codebase-memory-mcp');
const outputPath = path.join(repoRoot, 'packages/core/src/languages/cbm-language-map.ts');
const commit = execFileSync('git', ['-C', cbmRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`CBM language map: invalid CBM commit ${commit}`);

function fail(message) {
    throw new Error(`CBM language map: ${message}`);
}

function source(relativePath) {
    return execFileSync('git', ['-C', cbmRoot, 'show', `${commit}:${relativePath}`], { encoding: 'utf8' });
}

function withoutComments(input) {
    return input.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
}

function table(input, name) {
    const start = input.search(new RegExp(`\\b${name}\\s*\\[[^\\]]*\\]\\s*=\\s*\\{`));
    if (start < 0) fail(`missing ${name}`);
    const open = input.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < input.length; index++) {
        if (input[index] === '{') depth++;
        if (input[index] === '}' && --depth === 0) return input.slice(open + 1, index);
    }
    fail(`unterminated ${name}`);
}

function parseEntries(body, pattern, label) {
    const entries = [...body.matchAll(pattern)];
    if (entries.length === 0) fail(`no ${label} entries`);
    return entries;
}

function addTo(grouped, language, value) {
    if (!grouped.has(language)) grouped.set(language, new Set());
    grouped.get(language).add(value);
}

function readCbmCatalog() {
    const discovery = withoutComments(source('src/discover/language.c'));
    const names = new Map(parseEntries(
        table(discovery, 'LANG_NAMES'),
        /\[CBM_LANG_([A-Z0-9_]+)\]\s*=\s*"([^"]+)"/g,
        'language name',
    ).map((match) => [match[1], match[2]]));
    const extensions = new Map();
    const filenames = new Map();
    for (const match of parseEntries(table(discovery, 'EXT_TABLE'), /\{\s*"([^"]+)"\s*,\s*CBM_LANG_([A-Z0-9_]+)\s*\}/g, 'extension')) {
        // CBM also repeats a few bare special filenames in EXT_TABLE.
        addTo(match[1].startsWith('.') ? extensions : filenames, match[2], match[1]);
    }
    for (const match of parseEntries(table(discovery, 'FILENAME_TABLE'), /\{\s*"([^"]+)"\s*,\s*CBM_LANG_([A-Z0-9_]+)\s*\}/g, 'filename')) {
        addTo(filenames, match[2], match[1]);
    }

    const specs = table(withoutComments(source('internal/cbm/lang_specs.c')), 'lang_specs');
    const factories = new Map();
    const rowPattern = /\[CBM_LANG_([A-Z0-9_]+)\]\s*=\s*\{/g;
    for (const match of specs.matchAll(rowPattern)) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let end = -1;
        for (let index = open; index < specs.length; index++) {
            if (specs[index] === '{') depth++;
            if (specs[index] === '}' && --depth === 0) {
                end = index;
                break;
            }
        }
        if (end < 0) fail(`unterminated spec row for ${match[1]}`);
        const row = specs.slice(open + 1, end);
        if (!row.trim().startsWith(`CBM_LANG_${match[1]},`)) fail(`invalid spec row for ${match[1]}`);
        const symbols = [...row.matchAll(/\btree_sitter_[A-Za-z0-9_]+\b/g)].map((symbol) => symbol[0]);
        if (symbols.length > 1 || factories.has(match[1])) fail(`ambiguous spec row for ${match[1]}`);
        factories.set(match[1], symbols[0] ?? null);
    }

    for (const language of [...extensions.keys(), ...filenames.keys(), ...factories.keys()]) {
        if (!names.has(language)) fail(`missing name for ${language}`);
    }
    return { names, extensions, filenames, factories };
}

async function readSatoriDeclarations() {
    const filename = path.join(repoRoot, 'packages/core/src/languages/capabilities.ts');
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: filename,
    }).outputText;
    const module = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
    return module.getLanguageCapabilityDeclarations();
}

function sorted(values) {
    return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function makeMap(catalog, declarations) {
    const byExtension = new Map();
    const byFilename = new Map();
    for (const item of declarations) {
        for (const extension of item.extensions) {
            const key = extension.toLowerCase();
            if (byExtension.has(key)) fail(`duplicate Satori extension ${key}`);
            byExtension.set(key, item.languageId);
        }
        for (const filename of item.filenames ?? []) {
            const key = filename.toLowerCase();
            if (byFilename.has(key) && byFilename.get(key) !== item.languageId) fail(`duplicate Satori filename ${key}`);
            byFilename.set(key, item.languageId);
        }
    }

    for (const [extension, owner] of SATORI_EXTENSION_SPLITS) {
        if (byExtension.get(extension) !== owner) fail(`split ${extension} must be owned by Satori language ${owner}`);
    }

    return sorted(catalog.names.keys()).map((cbmLanguage) => {
        const extensions = sorted(catalog.extensions.get(cbmLanguage) ?? []);
        const filenames = sorted(catalog.filenames.get(cbmLanguage) ?? []);
        const matches = new Set([
            ...extensions
                .filter((extension) => !SATORI_EXTENSION_SPLITS.has(extension.toLowerCase()))
                .map((extension) => byExtension.get(extension.toLowerCase())),
            ...filenames.map((filename) => byFilename.get(filename.toLowerCase())),
        ].filter(Boolean));
        if (matches.size > 1) fail(`conflicting Satori matches for ${cbmLanguage}: ${sorted(matches).join(', ')}`);
        return {
            cbmLanguage,
            cbmName: catalog.names.get(cbmLanguage),
            satoriLanguageId: matches.values().next().value ?? null,
            grammarFactory: catalog.factories.get(cbmLanguage) ?? null,
            extensions,
            filenames,
        };
    });
}

function render(commit, rows) {
    const entries = rows.map((row) => `    ${JSON.stringify(row)},`).join('\n');
    return `// Generated by scripts/sync-cbm-language-map.mjs. Do not edit.\n` +
        `// Regenerate: node scripts/sync-cbm-language-map.mjs <path-to-codebase-memory-mcp>\n` +
        `\n` +
        `export const CBM_LANGUAGE_MAP_COMMIT = '${commit}';\n` +
        `\n` +
        `/** Extensions CBM routes through another language that Satori deliberately owns itself. */\n` +
        `export const SATORI_EXTENSION_SPLITS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(Object.fromEntries(SATORI_EXTENSION_SPLITS))});\n` +
        `\n` +
        `export interface CbmLanguageMapEntry {\n` +
        `    readonly cbmLanguage: string;\n` +
        `    readonly cbmName: string;\n` +
        `    readonly satoriLanguageId: string | null;\n` +
        `    readonly grammarFactory: string | null;\n` +
        `    readonly extensions: readonly string[];\n` +
        `    readonly filenames: readonly string[];\n` +
        `}\n` +
        `\n` +
        `const rows: CbmLanguageMapEntry[] = [\n${entries}\n];\n` +
        `\n` +
        `export const CBM_LANGUAGE_MAP: readonly CbmLanguageMapEntry[] = Object.freeze(rows.map((row) =>\n` +
        `    Object.freeze({ ...row, extensions: Object.freeze(row.extensions), filenames: Object.freeze(row.filenames) })\n` +
        `));\n`;
}

const output = render(commit, makeMap(readCbmCatalog(), await readSatoriDeclarations()));
if (checkOnly) {
    if (readFileSync(outputPath, 'utf8') !== output) {
        console.error(`${path.relative(repoRoot, outputPath)} is stale for CBM ${commit}; rerun without --check`);
        process.exit(1);
    }
    console.log(`${path.relative(repoRoot, outputPath)} is current for CBM ${commit}`);
} else {
    writeFileSync(outputPath, output);
    console.log(`Wrote ${path.relative(repoRoot, outputPath)} from CBM ${commit}`);
}
