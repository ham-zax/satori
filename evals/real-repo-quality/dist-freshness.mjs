// Dist staleness guard for the real-repo harness.
//
// The harness evaluates packages/*/dist, not src. That is deliberate: it scores
// the artifact a user would install. The cost is that a src edit which was never
// built is invisible -- the harness imports the previous build, records the
// current git SHA in provenance, and produces numbers that belong to neither the
// commit nor the working tree they are labelled with. Nothing in the run
// detected it.
//
// This guard closes that gap at the single choke point: every dist module the
// harness imports is freshness-checked immediately before it is imported, and a
// stale import is a hard failure rather than a silently wrong number.
//
// Ownership: this file owns the dist-freshness decision for the eval harness.
// It deliberately knows nothing about what the imported modules do.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isDefaultNamespaceOnly = (ns) => ns.default && Object.keys(ns).length <= 1;

/**
 * Map a dist module path to the src file it is built from.
 * `packages/<pkg>/dist/<rest>.js` mirrors `packages/<pkg>/src/<rest>.ts`.
 * Returns null for anything outside that shape (a vendored file, a hand-written
 * dist asset), which is then reported rather than silently accepted.
 */
export function srcPathForDistModule(distRelPath) {
    const match = /^(packages\/[^/]+)\/dist\/(.+)\.js$/.exec(distRelPath);
    if (!match) return null;
    const [, pkg, rest] = match;
    return `${pkg}/src/${rest}.ts`;
}

/**
 * One violation per dist module whose build predates the source it was built
 * from. A missing dist file is a violation too: the harness would otherwise
 * fail later with an opaque ERR_MODULE_NOT_FOUND.
 */
export function checkDistFreshness(workspaceRoot, distRelPaths, now = Date.now()) {
    const violations = [];
    for (const distRelPath of distRelPaths) {
        const srcRelPath = srcPathForDistModule(distRelPath);
        if (srcRelPath === null) {
            violations.push({
                distRelPath,
                srcRelPath: null,
                reason: 'not a buildable packages/*/dist/**/*.js path',
            });
            continue;
        }
        const distAbs = path.resolve(workspaceRoot, distRelPath);
        const srcAbs = path.resolve(workspaceRoot, srcRelPath);
        if (!fs.existsSync(distAbs)) {
            violations.push({
                distRelPath,
                srcRelPath,
                reason: 'dist file is missing (build the package)',
                distMtime: null,
                srcMtime: null,
            });
            continue;
        }
        if (!fs.existsSync(srcAbs)) {
            violations.push({
                distRelPath,
                srcRelPath,
                reason: 'src file is missing (cannot prove the build is current)',
                distMtime: fs.statSync(distAbs).mtimeMs,
                srcMtime: null,
            });
            continue;
        }
        const distMtime = fs.statSync(distAbs).mtimeMs;
        const srcMtime = fs.statSync(srcAbs).mtimeMs;
        if (srcMtime > distMtime) {
            violations.push({ distRelPath, srcRelPath, reason: 'src is newer than dist', distMtime, srcMtime });
        }
    }
    return violations;
}

const isoOrNull = (ms) => (ms === null || ms === undefined ? 'missing' : new Date(ms).toISOString());

export function formatViolations(violations) {
    const lines = [
        `stale build: ${violations.length} harness import(s) are older than the source they were built from.`,
        'The harness evaluates packages/*/dist. A src edit that was never built scores',
        'the previous artifact while provenance records the current commit, so the',
        'numbers belong to neither. Rebuild, or commit the build.',
        '',
    ];
    for (const v of violations) {
        lines.push(`  ${v.distRelPath}`);
        lines.push(`    src   ${v.srcRelPath ?? '(unmappable)'}  ${isoOrNull(v.srcMtime)}`);
        lines.push(`    dist  ${v.distRelPath}  ${isoOrNull(v.distMtime)}`);
        lines.push(`    why   ${v.reason}`);
    }
    lines.push('');
    lines.push('  rebuild: pnpm --filter @satori-code/mcp build && pnpm --filter @satori-code/core build');
    return lines.join('\n');
}

/** Distinguishes a stale build from a crash, so run.mjs can report it clearly. */
export class DistStaleError extends Error {
    constructor(violations) {
        super(formatViolations(violations));
        this.name = 'DistStaleError';
        this.violations = violations;
    }
}

/** Throws with the full report when any import is stale. */
export function assertDistFresh(workspaceRoot, distRelPaths, now = Date.now()) {
    const violations = checkDistFreshness(workspaceRoot, distRelPaths, now);
    if (violations.length > 0) throw new DistStaleError(violations);
}

/** Check the runtime packages too: the search server executes in a child process. */
export function assertRuntimeDistFresh(workspaceRoot, packages = ['core', 'mcp', 'cli']) {
    const modules = [];
    for (const pkg of packages) {
        const sourceRoot = path.join(workspaceRoot, 'packages', pkg, 'src');
        const visit = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const absolute = path.join(dir, entry.name);
                if (entry.isDirectory()) visit(absolute);
                else if (entry.isFile() && entry.name.endsWith('.ts')
                    && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
                    modules.push(`packages/${pkg}/dist/${path.relative(sourceRoot, absolute).replace(/\\/g, '/').replace(/\.ts$/, '.js')}`);
                }
            }
        };
        visit(sourceRoot);
    }
    assertDistFresh(workspaceRoot, modules.sort());
}

/**
 * Import a harness dependency from dist, refusing to import a stale build.
 * Freshness is checked per module at the moment of import, so a newly added
 * dist import is covered without updating a list here.
 */
export async function importFreshDist(workspaceRoot, distRelPath, { now = Date.now() } = {}) {
    assertDistFresh(workspaceRoot, [distRelPath], now);
    const ns = await import(pathToFileURL(path.resolve(workspaceRoot, distRelPath)).href);
    return isDefaultNamespaceOnly(ns) ? ns.default : ns;
}

// ------------------------------------------------------------------ CLI
// `node evals/real-repo-quality/dist-freshness.mjs [--workspace DIR] [module ...]`
// Exits non-zero on any violation so a pre-run guard can be scripted.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const root = path.resolve(argv.includes('--workspace') ? argv[argv.indexOf('--workspace') + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    const named = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--workspace'));
    const modules = named.length > 0 ? named : [
        'packages/core/dist/language-analysis/service.js',
        'packages/mcp/dist/core/search-query-planning.js',
        'packages/mcp/dist/core/search-answer-focus.js',
        'packages/mcp/dist/core/search-ranking-policy.js',
        'packages/mcp/dist/core/search-non-production-path.js',
        'packages/mcp/dist/core/search-flags.js',
        'packages/mcp/dist/core/search-constants.js',
        'packages/mcp/dist/core/search-expansion-reservation.js',
    ];
    const violations = checkDistFreshness(root, modules);
    if (violations.length > 0) {
        process.stderr.write(`FATAL: ${formatViolations(violations)}\n`);
        process.exit(1);
    }
    process.stdout.write(`dist freshness OK (${modules.length} harness imports checked against src mtimes)\n`);
}
