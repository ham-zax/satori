import type { SearchAnswerFocus } from "./search-rerank-context.js";

export const SEARCH_RERANK_QUERY_PROJECTION_IDENTITY = "search_rerank_query_v2" as const;

/**
 * Positive-only answer-type descriptions. The implementation description
 * never names competing artifact classes (tests, documentation, supporting
 * evidence): LateOn scores encoded representations, so mentioning a role
 * can make candidates of that role more similar instead of less.
 */
const ANSWER_TYPE: Record<SearchAnswerFocus, string> = {
    implementation: "production implementation, control flow, and integration path",
    tests: "tests that directly verify the requested behavior",
    documentation: "documentation that directly explains the requested topic",
    configuration: "active configuration declarations and the code that applies them",
    references: "direct callers, callees, references, and integration sites",
    neutral: "the most direct answer to the question",
};

export function buildSearchRerankQuery(input: {
    semanticQuery: string;
    answerFocus: SearchAnswerFocus;
    callerTerms?: readonly string[];
}): string {
    const semanticQuery = input.semanticQuery.trim();
    if (semanticQuery.length === 0) {
        throw new Error("search rerank query v2 requires a non-empty semantic query");
    }
    return [
        "Question:",
        // The caller supplies alternative terminology for this same question.
        // Keep it attached during reranking so an admitted destroy/unmount
        // implementation can be recognized as the answer to a cleanup query.
        input.callerTerms?.length ? `${semanticQuery} (${input.callerTerms.join(", ")})` : semanticQuery,
        "",
        "Requested answer type:",
        ANSWER_TYPE[input.answerFocus],
    ].join("\n");
}
