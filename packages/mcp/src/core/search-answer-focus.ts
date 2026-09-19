import type { SearchQueryPlan } from "./search-lexical-scoring.js";
import type { SearchAnswerFocus } from "./search-rerank-context.js";
export type { SearchAnswerFocus } from "./search-rerank-context.js";

export type SearchAnswerFocusResolution = Readonly<{
    focus: SearchAnswerFocus;
    reasons: readonly string[];
}>;

const IMPLEMENTATION_QUESTION_CUE = /\bhow\s+(?:does|do|is|are)\b|\bwhere\s+is\b.*\bimplemented\b|\bwhat\s+(?:blocks|prevents|validates|gates|controls)\b/;

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
): SearchAnswerFocusResolution {
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
    if (plan.implementationSeeking) {
        return { focus: "implementation", reasons: ["implementation_seeking_query"] };
    }
    if (IMPLEMENTATION_QUESTION_CUE.test(plan.semanticQuery.toLowerCase())) {
        return { focus: "implementation", reasons: ["implementation_question_cue"] };
    }
    if (hasSearchMechanismImplementationCue(plan.semanticQuery.toLowerCase())) {
        return { focus: "implementation", reasons: ["search_mechanism_query"] };
    }
    return { focus: "neutral", reasons: ["no_focus_signal"] };
}
