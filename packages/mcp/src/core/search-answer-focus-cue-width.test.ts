import test from "node:test";
import assert from "node:assert/strict";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { resolveSearchFlags } from "./search-flags.js";
import { buildSearchQueryPlan } from "./search-query-planning.js";

/**
 * The pre-widening cue. Copied verbatim from the regex that was in place before
 * the `where is|does|do|are` widening, so this test pins the default against
 * the historical behavior rather than against the current source.
 *
 *   /\bhow\s+(?:does|do|is|are)\b|\bwhere\s+is\b.*\bimplemented\b|\bwhat\s+(?:blocks|prevents|validates|gates|controls)\b/
 */
const PRE_WIDENING_CUE =
    /\bhow\s+(?:does|do|is|are)\b|\bwhere\s+is\b.*\bimplemented\b|\bwhat\s+(?:blocks|prevents|validates|gates|controls)\b/;

/**
 * Queries the OLD regex and the widened regex classify differently, and which
 * actually reach the cue check. An earlier branch claiming the query first
 * (referenceSeeking, implementationSeeking, a references/configuration route,
 * test/doc seeking) would make the cue unreachable and the test vacuous, so
 * every entry here is verified to reach the cue.
 */
const DISCRIMINATING_QUERIES = [
    "where is an error thrown when a hook is called outside a component body",
    "where are duplicate trades rejected",
    "where is risk computed before an order is accepted",
    "where is the trade veto evaluated",
    "where is the position size clamped",
    "where is the margin requirement enforced",
    "where is a stale read detected",
] as const;

/**
 * Queries the widened cue would match, but where an earlier branch claims the
 * query first. The cue is unreachable for these, so the flag must not change
 * the answer -- this is the guard against the widening leaking into routes it
 * was not measured on.
 */
const CUE_UNREACHABLE_QUERIES = [
    // referenceSeeking wins before the cue.
    "where is useState called when rendering a component",
    // implementationSeeking wins before the cue.
    "where is the order of lifecycle callbacks decided",
] as const;

test("focus_cue_wide is off by default", () => {
    const flags = resolveSearchFlags();
    assert.equal(flags.focus_cue_wide, false);
    assert.equal(resolveSearchFlags({}).focus_cue_wide, false);
    assert.equal(resolveSearchFlags({ focus_cue_wide: false }).focus_cue_wide, false);
});

test("rerank_blend is off by default", () => {
    const flags = resolveSearchFlags();
    assert.equal(flags.rerank_blend, false);
    assert.equal(resolveSearchFlags({}).rerank_blend, false);
    assert.equal(resolveSearchFlags({ rerank_blend: false }).rerank_blend, false);
});

/** True when no branch before the cue claims the query. */
function reachesImplementationCue(plan: ReturnType<typeof buildSearchQueryPlan>): boolean {
    return !plan.testSeeking
        && !plan.documentationSeeking
        && plan.route.kind !== "configuration"
        && plan.route.kind !== "references"
        && !plan.referenceSeeking
        && !plan.implementationSeeking;
}

test("the default cue matches the pre-widening regex on every probe", () => {
    // Probes are exercised through resolveSearchAnswerFocus, so this fails if
    // the live default cue is edited, not merely if it diverges from the
    // copied regex. Queries the old cue claims but an earlier branch also
    // claims are excluded from the reason assertion, because the cue is not the
    // reason that fires for them.
    const probes = [
        ...DISCRIMINATING_QUERIES,
        "how does useState schedule a re-render when the setter is called",
        "what validates the trade veto",
        "where is the trade veto implemented",
        "trading risk management",
        "who calls validate_order",
    ];
    for (const query of probes) {
        const plan = buildSearchQueryPlan(query, true);
        const oldMatches = PRE_WIDENING_CUE.test(plan.semanticQuery.toLowerCase());
        const reaches = reachesImplementationCue(plan);
        if (!reaches) {
            // The cue cannot be the deciding branch; only assert that a
            // cue-matching query still ends up at implementation.
            if (oldMatches) {
                assert.equal(resolveSearchAnswerFocus(plan).focus, "implementation", query);
            }
            continue;
        }
        const resolution = resolveSearchAnswerFocus(plan);
        assert.equal(
            resolution.reasons.includes("implementation_question_cue"),
            oldMatches,
            `${query}: the default cue must match exactly what the pre-widening regex matches`,
        );
        if (oldMatches) {
            assert.deepEqual(resolution.reasons, ["implementation_question_cue"], query);
        }
    }
});

test("at default flags the discriminating queries do not resolve via the implementation cue", () => {
    for (const query of DISCRIMINATING_QUERIES) {
        const plan = buildSearchQueryPlan(query, true);
        const defaultResolution = resolveSearchAnswerFocus(plan);
        assert.equal(
            defaultResolution.reasons.includes("implementation_question_cue"),
            false,
            `${query}: focus_cue_wide is off, so the widened cue must not fire`,
        );
        // The widened flag is the only thing that turns these into
        // implementation questions.
        const wideResolution = resolveSearchAnswerFocus(plan, { focus_cue_wide: true });
        assert.equal(
            wideResolution.reasons.includes("implementation_question_cue"),
            true,
            `${query}: focus_cue_wide must fire the widened cue`,
        );
    }
});

test("queries claimed before the cue are unaffected by the widening", () => {
    for (const query of CUE_UNREACHABLE_QUERIES) {
        const plan = buildSearchQueryPlan(query, true);
        const defaultResolution = resolveSearchAnswerFocus(plan);
        const wideResolution = resolveSearchAnswerFocus(plan, { focus_cue_wide: true });
        assert.equal(
            defaultResolution.reasons.includes("implementation_question_cue"),
            false,
            `${query}: the cue is unreachable here`,
        );
        assert.deepEqual(wideResolution, defaultResolution, query);
    }
});

test("focus_cue_wide is reachable by object key", () => {
    // The array-token form was removed in C2, so this is now the single
    // explicit-flag path; the env path is covered by the test below.
    const query = DISCRIMINATING_QUERIES[0];
    const plan = buildSearchQueryPlan(query, true);
    const flags = resolveSearchFlags({ focus_cue_wide: true });
    assert.equal(flags.focus_cue_wide, true);
    assert.equal(
        resolveSearchAnswerFocus(plan, flags).reasons.includes("implementation_question_cue"),
        true,
    );
});

test("an env-set SATORI_SEARCH_FLAGS reaches resolveSearchAnswerFocus when no flags are passed", () => {
    // run.mjs sets the env var; every other production caller passes an
    // explicit flag object that may omit the key. This is the path where the
    // env string alone has to turn the flag on.
    const query = DISCRIMINATING_QUERIES[0];
    const plan = buildSearchQueryPlan(query, true);
    const previous = process.env.SATORI_SEARCH_FLAGS;
    try {
        delete process.env.SATORI_SEARCH_FLAGS;
        assert.equal(
            resolveSearchAnswerFocus(plan).reasons.includes("implementation_question_cue"),
            false,
        );
        process.env.SATORI_SEARCH_FLAGS = "focus_cue_wide";
        assert.equal(
            resolveSearchAnswerFocus(plan).reasons.includes("implementation_question_cue"),
            true,
        );
        // An explicit object that omits the key still inherits the env value,
        // because the object branch only overwrites keys it names.
        assert.equal(
            resolveSearchAnswerFocus(plan, { rerank_blend: true })
                .reasons.includes("implementation_question_cue"),
            true,
        );
        // An explicit object that names the key wins over the env.
        assert.equal(
            resolveSearchAnswerFocus(plan, { focus_cue_wide: false })
                .reasons.includes("implementation_question_cue"),
            false,
        );
    } finally {
        if (previous === undefined) delete process.env.SATORI_SEARCH_FLAGS;
        else process.env.SATORI_SEARCH_FLAGS = previous;
    }
});

test("the widened cue does not disturb queries the default cue already claims", () => {
    // Enabling the flag must be additive: anything the default already routes
    // to implementation must still route there, for the same or an earlier
    // reason.
    const stable = [
        "how does Shariah compliance checking block trades",
        "where does React throw when a hook is called outside a component",
        "what validates the trade veto",
        "find tests for trade veto behavior",
        "where is trade veto documented",
        "where is the risk threshold configured",
        "who calls validate_order",
    ];
    for (const query of stable) {
        const plan = buildSearchQueryPlan(query, true);
        assert.equal(
            resolveSearchAnswerFocus(plan, { focus_cue_wide: true }).focus,
            resolveSearchAnswerFocus(plan).focus,
            query,
        );
    }
});
