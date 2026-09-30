import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import {
    buildSearchCandidateProvenance,
    classifyPathCategory,
    preferImplementationCandidates,
    shouldIncludeCategoryInScope,
} from "./search-ranking-policy.js";

test("path classification remains an eligibility control, not a relevance score", () => {
    assert.equal(classifyPathCategory("src/core/search.ts"), "core");
    assert.equal(classifyPathCategory("tests/search.test.ts"), "tests");
    assert.equal(classifyPathCategory("docs/search.md"), "docs");
    assert.equal(shouldIncludeCategoryInScope("runtime", "docs"), false);
    assert.equal(shouldIncludeCategoryInScope("docs", "docs"), true);
});

test("candidate provenance reports retrieval and exact evidence without score policy", () => {
    const provenance = buildSearchCandidateProvenance({
        result: { relativePath: "src/search.ts" },
        exactMatchPinned: true,
        exactLexicalMatch: true,
        rerankAdjusted: true,
        retrievalPasses: ["expanded", "primary"],
        backendScoreKindsSeen: ["dense_similarity"],
    });

    assert.deepEqual(provenance, {
        retrievalPasses: ["expanded", "primary"],
        backendScoreKinds: ["dense_similarity"],
        semanticCandidate: true,
        lexicalCandidate: false,
        rerankAdjusted: true,
        exactMatchPinned: true,
        ownerRepairApplied: false,
    });
});


test("named MCP integrations share adapter classification without absorbing arbitrary servers", () => {
    assert.equal(classifyPathCategory("packages/example-mcp-server/src/index.ts"), "adapter");
    assert.equal(classifyPathCategory("packages/example_mcp_client/src/service.ts"), "adapter");
    assert.equal(classifyPathCategory("packages/http-server/src/index.ts"), "entrypoint");
    assert.equal(classifyPathCategory("packages/example-mcp-server/tests/client.test.ts"), "tests");
});

test("implementation preference preserves explicit intent and provider order within each role", () => {
    const candidates = ["tests/a.test.ts", "tools/a.ts", "src/core/b.ts", "src/core/a.ts", "tests/b.test.ts"];
    const prefer = (query: string, hasPathConstraint = false) => {
        const parsed = parseSearchOperators(query);
        const plan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
        return preferImplementationCandidates({
            candidates, relativePath: (path) => path,
            answerFocus: resolveSearchAnswerFocus(plan).focus,
            queryPlan: plan, hasPathConstraint,
        });
    };
    assert.deepEqual(prefer("how does cleanup work"), [
        "src/core/b.ts", "src/core/a.ts", "tools/a.ts", "tests/a.test.ts", "tests/b.test.ts",
    ]);
    assert.deepEqual(prefer("how does tools cleanup work"), [
        "tools/a.ts", "src/core/b.ts", "src/core/a.ts", "tests/a.test.ts", "tests/b.test.ts",
    ]);
    for (const query of ["tests for cleanup", "documentation for cleanup", "configuration for cleanup", "callers of cleanup", "cleanup"]) {
        assert.deepEqual(prefer(query), candidates, query);
    }
    assert.deepEqual(prefer("how does cleanup work", true), candidates);
});
