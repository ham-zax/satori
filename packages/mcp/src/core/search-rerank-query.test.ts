import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchRerankQuery, resolveSearchRerankQuery } from "./search-rerank-query.js";
import type { SearchAnswerFocus } from "./search-rerank-context.js";

const QUESTION = "how does Shariah compliance checking block trades";

test("every answer focus query follows the positive-only Question/Requested answer type shape", () => {
    const expectedDescriptions: Record<SearchAnswerFocus, string> = {
        implementation: "production implementation, control flow, and integration path",
        tests: "tests that directly verify the requested behavior",
        documentation: "documentation that directly explains the requested topic",
        configuration: "active configuration declarations and the code that applies them",
        references: "direct callers, callees, references, and integration sites",
        neutral: "the most direct answer to the question",
    };
    for (const focus of Object.keys(expectedDescriptions) as SearchAnswerFocus[]) {
        const query = buildSearchRerankQuery({ semanticQuery: QUESTION, answerFocus: focus });
        assert.equal(
            query,
            ["Question:", QUESTION, "", "Requested answer type:", expectedDescriptions[focus]].join("\n"),
            focus,
        );
        assert.equal(query.includes("Guidance:"), false, `${focus} must not carry v1 guidance`);
        assert.equal(query.includes(`Answer focus: ${focus}`), false, `${focus} must not carry the v1 focus label`);
    }
});

test("query requires a non-empty semantic query", () => {
    assert.throws(
        () => buildSearchRerankQuery({ semanticQuery: "   ", answerFocus: "neutral" }),
        /non-empty semantic query/,
    );
});

test("caller implementation terminology stays attached to the original question", () => {
    const input = {
        semanticQuery: "where is the cleanup function invoked",
        answerFocus: "implementation" as const,
        callerTerms: ["destroy", "unmount"],
    };
    assert.equal(buildSearchRerankQuery(input), [
        "Question:",
        "where is the cleanup function invoked (destroy, unmount)",
        "",
        "Requested answer type:",
        "production implementation, control flow, and integration path",
    ].join("\n"));
    assert.equal(
        buildSearchRerankQuery({ ...input, callerTerms: [] }),
        buildSearchRerankQuery({ semanticQuery: input.semanticQuery, answerFocus: input.answerFocus }),
    );
});

const FOCUSED_V2 = "Question:\nhow does Shariah compliance checking block trades\n\nRequested answer type:\nproduction implementation, control flow, and integration path";

test("missing, blank, or raw query projection identity receives the raw semantic query", () => {
    for (const projectionIdentity of [undefined, "   ", "semantic_query_raw_v1"]) {
        const resolved = resolveSearchRerankQuery({
            semanticQuery: QUESTION,
            projectionIdentity,
        });
        assert.equal(resolved.query, QUESTION);
        assert.equal(resolved.queryProjectionIdentity, "semantic_query_raw_v1");
    }
});

test("retired search_rerank_query_v1 identity is rejected", () => {
    assert.throws(
        () => resolveSearchRerankQuery({
            semanticQuery: QUESTION,
            projectionIdentity: "search_rerank_query_v1",
        }),
        /search_rerank_query_projection_identity_unknown:search_rerank_query_v1/,
    );
});

test("search_rerank_query_v2 identity receives focused query v2 bytes or fails closed", () => {
    const resolved = resolveSearchRerankQuery({
        semanticQuery: QUESTION,
        focusedQueryV2: FOCUSED_V2,
        projectionIdentity: "search_rerank_query_v2",
    });
    assert.equal(resolved.query, FOCUSED_V2);
    assert.equal(resolved.queryProjectionIdentity, "search_rerank_query_v2");
    assert.throws(
        () => resolveSearchRerankQuery({
            semanticQuery: QUESTION,
            projectionIdentity: "search_rerank_query_v2",
        }),
        /search_rerank_query_v2_projection_unavailable/,
    );
});
