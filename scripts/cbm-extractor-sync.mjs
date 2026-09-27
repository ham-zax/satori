#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith('--') && arg !== '--check') || args.filter((arg) => arg !== '--check').length > 1) {
    throw new Error('Usage: node scripts/cbm-extractor-sync.mjs [--check] [<cbm-checkout>]');
}
const checkOnly = args.includes('--check');
const cbmRoot = path.resolve(args.find((arg) => arg !== '--check') ?? '/home/hamza/repo/codebase-memory-mcp');
const outputRoot = path.join(repoRoot, 'third_party/cbm-extractor');
const mapText = readFileSync(path.join(repoRoot, 'packages/core/src/languages/cbm-language-map.ts'), 'utf8');
const pinnedCommit = /CBM_LANGUAGE_MAP_COMMIT = '([0-9a-f]{40})'/.exec(mapText)?.[1];
if (!pinnedCommit) throw new Error('CBM extractor sync: missing pinned language-map commit');
const checkoutCommit = execFileSync('git', ['-C', cbmRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (checkoutCommit !== pinnedCommit) throw new Error(`CBM extractor sync: checkout ${checkoutCommit} is not pinned ${pinnedCommit}`);

const closureFiles = [
    'internal/cbm/arena.h',
    'internal/cbm/cbm.h',
    'internal/cbm/extract_defs.c',
    'internal/cbm/extract_node_stack.h',
    'internal/cbm/helpers.c',
    'internal/cbm/helpers.h',
    'internal/cbm/lang_specs.c',
    'internal/cbm/lang_specs.h',
    'internal/cbm/ts_runtime.c',
    'src/foundation/arena.c',
    'src/foundation/arena.h',
    'src/foundation/compat.h',
    'src/foundation/constants.h',
    'src/foundation/log.h',
    'src/foundation/mem_core.h',
    'src/foundation/mem_events.h',
    'src/foundation/platform.h',
    'src/semantic/ast_profile.c',
    'src/semantic/ast_profile.h',
    'src/simhash/minhash.c',
    'src/simhash/minhash.h',
    'vendored/xxhash/xxhash.h',
];
const runtimeFiles = execFileSync('git', ['-C', cbmRoot, 'ls-tree', '-r', '--name-only', pinnedCommit, '--', 'internal/cbm/vendored/ts_runtime'], { encoding: 'utf8' })
    .trim().split('\n').filter((name) => /\.(?:c|h)$/.test(name));
if (runtimeFiles.length < 30) throw new Error(`CBM extractor sync: incomplete tree-sitter runtime (${runtimeFiles.length} files)`);
const sourceFiles = [...new Set([...closureFiles, ...runtimeFiles, 'LICENSE',
    'internal/cbm/vendored/ts_runtime/LICENSE', 'vendored/xxhash/LICENSE'])].sort();

function source(name) {
    return execFileSync('git', ['-C', cbmRoot, 'show', `${pinnedCommit}:${name}`]);
}
function patchHeader(input) {
    const marker = '    const char *impl_trait;';
    if (input.split(marker).length !== 2) throw new Error('CBM extractor sync: CBMDefinition tail changed');
    const output = input.replace(marker, `${marker}\n    uint32_t start_byte;\n    uint32_t end_byte;`);
    if (!/uint32_t end_byte;\n} CBMDefinition;/.test(output)) throw new Error('CBM extractor sync: span fields are not at CBMDefinition tail');
    return output;
}
function patchDefinitions(input) {
    const starts = [...input.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\.start_line\s*=/g)].length;
    const ends = [...input.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\.end_line\s*=/g)].length;
    let pairs = 0;
    const output = input.replace(
        /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)\.start_line = (ts_node_start_point\(([^)]+)\)\.row \+ TS_LINE_OFFSET|FIRST_LINE);\r?\n\1\2\.end_line = ts_node_end_point\(([^)]+)\)\.row \+ TS_LINE_OFFSET;/gm,
        (_match, indent, variable, startLine, startNode, endNode) => {
            pairs++;
            const startByte = startLine === 'FIRST_LINE' ? '0' : `ts_node_start_byte(${startNode})`;
            return `${indent}${variable}.start_line = ${startLine};\n` +
                `${indent}${variable}.start_byte = ${startByte};\n` +
                `${indent}${variable}.end_line = ts_node_end_point(${endNode}).row + TS_LINE_OFFSET;\n` +
                `${indent}${variable}.end_byte = ts_node_end_byte(${endNode});`;
        },
    );
    const patchedStarts = [...output.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\.start_byte\s*=/g)].length;
    const patchedEnds = [...output.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\.end_byte\s*=/g)].length;
    if (pairs < 20 || pairs !== starts || pairs !== ends || patchedStarts !== starts || patchedEnds !== ends) {
        throw new Error(`CBM extractor sync: incomplete byte-span patch: ${pairs} pairs, ${starts} start_line sites, ${ends} end_line sites`);
    }
    return { output, pairs };
}

const expected = new Map();
let spanSites = 0;
for (const name of sourceFiles) {
    let contents = source(name);
    if (name === 'internal/cbm/cbm.h') contents = Buffer.from(patchHeader(contents.toString('utf8')));
    if (name === 'internal/cbm/extract_defs.c') {
        const patched = patchDefinitions(contents.toString('utf8'));
        contents = Buffer.from(patched.output);
        spanSites = patched.pairs;
    }
    expected.set(name, contents);
}
const upstream = `# CBM definition extractor sources\n\n` +
    `Pinned upstream commit: \`${pinnedCommit}\` ([codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)).\n\n` +
    `These files are copied from that commit. Grammar sources are read from the pinned checkout during the build.\n\n` +
    `## Local patches\n\n` +
    `- \`internal/cbm/cbm.h\`: append \`start_byte\` and \`end_byte\` to \`CBMDefinition\`.\n` +
    `- \`internal/cbm/extract_defs.c\`: set both byte spans at all ${spanSites} definition line-span sites.\n` +
    `- \`satori_extractor.c\` and \`satori_shim.c\` are Satori-owned ABI and link shims.\n\n` +
    `## Vendored files\n\n${sourceFiles.map((name) => `- \`${name}\``).join('\n')}\n`;
expected.set('UPSTREAM.md', Buffer.from(upstream));

const localFiles = new Set(['satori_extractor.c', 'satori_shim.c']);
function existingFiles(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(dir, entry.name);
        return entry.isDirectory() ? existingFiles(absolute) : entry.isFile() ? [path.relative(outputRoot, absolute).split(path.sep).join('/')] : [];
    });
}
const unexpected = existingFiles(outputRoot).filter((name) => !expected.has(name) && !localFiles.has(name));
if (unexpected.length) throw new Error(`CBM extractor sync: unexpected vendored files: ${unexpected.join(', ')}`);
const shimPath = path.join(outputRoot, 'satori_shim.c');
if (checkOnly || existsSync(shimPath)) {
    if (!existsSync(shimPath)) throw new Error('CBM extractor sync: missing Satori shim');
    const upstreamCbm = source('internal/cbm/cbm.c').toString('utf8');
    const shim = readFileSync(shimPath, 'utf8');
    const macroStart = upstreamCbm.indexOf('#define GROW_ARRAY(');
    const macroEnd = upstreamCbm.indexOf('} while (0)', macroStart) + '} while (0)'.length;
    if (macroStart < 0 || macroEnd < macroStart || !shim.includes(upstreamCbm.slice(macroStart, macroEnd))) {
        throw new Error('CBM extractor sync: GROW_ARRAY differs from pinned CBM');
    }
    for (const name of ['cbm_first_line', 'cbm_js_family_path', 'cbm_js_name_is_junk',
        'cbm_defs_push', 'cbm_usages_push', 'cbm_impltrait_push', 'cbm_result_alloc']) {
        const definition = new RegExp(`^[^\\n;]*\\b${name}\\([^;]*\\)\\s*\\{`, 'm').exec(upstreamCbm);
        if (!definition) throw new Error(`CBM extractor sync: missing pinned ${name}`);
        const end = upstreamCbm.indexOf('\n}\n', definition.index) + 2;
        if (end < 2 || !shim.includes(upstreamCbm.slice(definition.index, end))) {
            throw new Error(`CBM extractor sync: ${name} differs from pinned CBM`);
        }
    }
}
for (const [name, contents] of expected) {
    const filename = path.join(outputRoot, name);
    if (checkOnly) {
        if (!existsSync(filename) || !readFileSync(filename).equals(contents)) throw new Error(`CBM extractor sync: stale ${name}`);
    } else {
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, contents);
    }
}
console.log(`${checkOnly ? 'Checked' : 'Vendored'} ${sourceFiles.length} CBM files at ${pinnedCommit}; ${spanSites} byte-span sites`);
