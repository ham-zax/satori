import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchRerankQuery } from "./search-rerank-query.js";
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
