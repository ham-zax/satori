import assert from "node:assert/strict";
import test from "node:test";
import { resolveSearchAltTerms } from "./search-expansion-terms.js";
import { buildSearchRerankQuery } from "./search-rerank-query.js";

test("array and string vocabulary resolve once to the same retrieval and reranking terms", () => {
    const expected = { termsEmitted: ["destroy", "unmount", "effect", "teardown"],
        termsDropped: ["dispose"], query: "destroy unmount effect teardown" };
    for (const input of [[" destroy ", "", "unmount", "effect", "teardown", "dispose"],
        " destroy, unmount\n effect teardown, dispose "]) {
        const resolved = resolveSearchAltTerms(input);
        assert.deepEqual(resolved, expected);
        const query = buildSearchRerankQuery({ semanticQuery: "where is cleanup invoked",
            answerFocus: "implementation", callerTerms: resolved.termsEmitted });
        assert.ok(query.includes("where is cleanup invoked (destroy, unmount, effect, teardown)"));
        assert.ok(!query.includes("dispose"), "dropped terms must not change reranking");
    }
});

test("absent and blank terms preserve the exact no-expansion question", () => {
    const base = { semanticQuery: "where is cleanup invoked", answerFocus: "implementation" as const };
    for (const input of [undefined, "", " , \t\n", [], ["", " "]]) {
        const resolved = resolveSearchAltTerms(input);
        assert.deepEqual(resolved, { termsEmitted: [], termsDropped: [], query: null });
        assert.equal(buildSearchRerankQuery({ ...base, callerTerms: resolved.termsEmitted }),
            buildSearchRerankQuery(base));
    }
});

test("array phrases and repeated terms retain established retrieval semantics", () => {
    assert.deepEqual(resolveSearchAltTerms(["  release resources  ", "destroy", "destroy"]), {
        termsEmitted: ["release resources", "destroy", "destroy"], termsDropped: [],
        query: "release resources destroy destroy",
    });
});
