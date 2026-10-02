/**
 * Single owner of "this path is a test/doc/fixture artifact, not production
 * code" classification.
 *
 * Production (`search-execution.ts` path demotion) and the real-repo quality
 * harness (`evals/real-repo-quality/harness-logger.mjs`) must agree on this
 * predicate, otherwise the harness measures a different distractor rate than
 * the ranking policy actually applies. The harness receives this function by
 * injection from `run.mjs`; it must not keep its own copy.
 *
 * Rules are deliberately segment- and filename-shaped rather than
 * extension-shaped. A substring/regex-over-the-whole-path rule cannot tell
 * `src/test-utils/helpers.ts` from `src/test/helpers.ts`, nor `README.md` from
 * code, and both distinctions matter: the first is production code that a
 * blanket `test` match would demote out of contention.
 */

/** Exact directory segments that mark non-production trees. */
const NON_PRODUCTION_SEGMENTS: ReadonlySet<string> = new Set([
    "__tests__",
    "__mocks__",
    "test",
    "tests",
    "spec",
    "specs",
    "fixtures",
    "docs",
    "examples",
    "benchmarks",
]);

/**
 * Basename patterns, anchored so they cannot match a directory component.
 * Case-insensitive, because the ecosystems these paths come from are not
 * consistent about `CHANGELOG` vs `Changelog`.
 */
const NON_PRODUCTION_FILENAME_PATTERNS: readonly RegExp[] = [
    /\.test\.[^/]+$/i, // foo.test.ts
    /\.spec\.[^/]+$/i, // foo.spec.ts
    /_test\.[^/]+$/i, // monster_test.fbs
    /_spec\.[^/]+$/i, // monster_spec.fbs
    /^CHANGELOG/i, // CHANGELOG.md, CHANGELOG-v2.txt
];

export function isNonProductionDistractor(relativePath?: string | null): boolean {
    if (!relativePath || typeof relativePath !== "string") return false;
    const normalized = relativePath.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0) return false;
    for (const segment of segments.slice(0, -1)) {
        if (NON_PRODUCTION_SEGMENTS.has(segment)) return true;
    }
    const filename = segments[segments.length - 1]!;
    return NON_PRODUCTION_FILENAME_PATTERNS.some((pattern) => pattern.test(filename));
}
