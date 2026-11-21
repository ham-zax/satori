import type { SearchQueryPlan } from "./search-lexical-scoring.js";
import type { SearchAnswerFocus } from "./search-rerank-context.js";
import { resolveSearchFlags, type SearchFlags } from "./search-flags.js";
export type { SearchAnswerFocus } from "./search-rerank-context.js";

export type SearchAnswerFocusResolution = Readonly<{
    focus: SearchAnswerFocus;
    reasons: readonly string[];
}>;

/**
 * Default implementation-question cue. Requires the question to name the
 * implementation, so an ordinary "where is X called" reference question is not
 * reclassified as an implementation question.
 */
const IMPLEMENTATION_QUESTION_CUE =
    /\bhow\s+(?:does|do|is|are)\b|\bwhere\s+is\b.*\bimplemented\b|\bwhat\s+(?:blocks|prevents|validates|gates|controls)\b/;

/**
 * Widened implementation-question cue, behind the `focus_cue_wide` flag.
 * Any "where is|does|do|are" question fires, which also captures reference and
 * conceptual questions. Off by default.
 */
const IMPLEMENTATION_QUESTION_CUE_WIDE =
    /\bhow\s+(?:does|do|is|are)\b|\bwhere\s+(?:does|do|is|are)\b|\bwhat\s+(?:blocks|prevents|validates|gates|controls)\b/;

const SEARCH_MECHANISM_CUES = [
    /\bcandidates?\b/,
    /\b(?:rerank(?:er|ing)?|ranking|ranked)\b/,
    /\bfusion\b/,
    /\b(?:scores?|scored|scoring)\b/,
    /\b(?:lexical|dense|sparse)\b/,
    /\bsemantic\s+search\b/,
    /\bquery\s+plan\b/,
    /\bdisclosure\b/,
] as const;

const MANIFEST_LOCATION_CUE = /\b(?:where\s+(?:is|are)|which\s+file)\b/;
const MANIFEST_SUBJECT_CUE =
    /\b(?:build\s+metadata|package\s+metadata|project\s+metadata|module\s+path|runtime\s+dependencies|dependency\s+versions?|dependencies|devdependencies|peerdependencies)\b/;
const MANIFEST_DECLARATION_CUE = /\b(?:declared|declares|specified|specifies|listed|lists|pinned|defined|defines)\b/;
const MANIFEST_RUNTIME_EXCLUSION =
    /\b(?:how\s+(?:does|do|is|are)|where\s+(?:does|do)|parse[sd]?|parsing|load(?:s|ed)?|loading|resolv(?:e|es|ed|ing)|comput(?:e|es|ed|ing)|compar(?:e|es|ed|ing)|check(?:s|ed|ing)?|validat(?:e|es|ed|ing))\b/;

function isManifestDeclarationQuery(query: string): boolean {
    return MANIFEST_LOCATION_CUE.test(query)
        && MANIFEST_SUBJECT_CUE.test(query)
        && MANIFEST_DECLARATION_CUE.test(query)
        && !MANIFEST_RUNTIME_EXCLUSION.test(query);
}

function hasSearchMechanismImplementationCue(query: string): boolean {
    let matches = 0;
    for (const cue of SEARCH_MECHANISM_CUES) {
        if (!cue.test(query)) continue;
        matches += 1;
        if (matches >= 2) return true;
    }
    return false;
}

export function resolveSearchAnswerFocus(
    plan: SearchQueryPlan,
    flags?: Record<string, boolean> | null,
): SearchAnswerFocusResolution {
    const resolved: SearchFlags = resolveSearchFlags(flags);
    const implementationCue = resolved.focus_cue_wide
        ? IMPLEMENTATION_QUESTION_CUE_WIDE
        : IMPLEMENTATION_QUESTION_CUE;
    if (plan.testSeeking) {
        return { focus: "tests", reasons: ["test_seeking_query"] };
    }
    if (plan.documentationSeeking) {
        return { focus: "documentation", reasons: ["documentation_seeking_query"] };
    }
    if (plan.route.kind === "configuration") {
        return { focus: "configuration", reasons: ["configuration_route"] };
    }
    if (plan.route.kind === "references") {
        return { focus: "references", reasons: ["reference_route"] };
    }
    if (plan.referenceSeeking) {
        return { focus: "references", reasons: ["reference_seeking_query"] };
    }
    const normalizedQuery = plan.semanticQuery.toLowerCase();
    if (isManifestDeclarationQuery(normalizedQuery)) {
        return { focus: "configuration", reasons: ["manifest_declaration_query"] };
    }
    if (plan.implementationSeeking) {
        return { focus: "implementation", reasons: ["implementation_seeking_query"] };
    }
    if (implementationCue.test(normalizedQuery)) {
        return { focus: "implementation", reasons: ["implementation_question_cue"] };
    }
    if (hasSearchMechanismImplementationCue(normalizedQuery)) {
        return { focus: "implementation", reasons: ["search_mechanism_query"] };
    }
    return { focus: "neutral", reasons: ["no_focus_signal"] };
}
