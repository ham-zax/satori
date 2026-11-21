import test from "node:test";
import assert from "node:assert/strict";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { buildSearchQueryPlan } from "./search-query-planning.js";

const cases = [
    ["how does Shariah compliance checking block trades", "implementation"],
    ["how does regime filtering gate entry decisions", "implementation"],
    ["find tests for trade veto behavior", "tests"],
    ["where is trade veto documented", "documentation"],
    ["where is the risk threshold configured", "configuration"],
    ["who calls validate_order", "references"],
    ["where does useState schedule a re-render when you call the setter", "implementation"],
    ["where does React throw when a hook is called outside a component", "implementation"],
    ["how does useState schedule a re-render when the setter is called", "implementation"],
    ["where is useState called when rendering a component", "references"],
    ["trading risk management", "neutral"],
] as const;

for (const [query, expected] of cases) {
    test(`answer-focus classifies "${query}" as ${expected}`, () => {
        const plan = buildSearchQueryPlan(query, true);
        const resolution = resolveSearchAnswerFocus(plan);
        assert.equal(resolution.focus, expected);
    });
}

test("answer-focus reasons are stable and carry no numeric values", () => {
    for (const [query] of cases) {
        const plan = buildSearchQueryPlan(query, true);
        const first = resolveSearchAnswerFocus(plan);
        const second = resolveSearchAnswerFocus(buildSearchQueryPlan(query, true));
        assert.deepEqual(second.reasons, first.reasons);
        assert.ok(first.reasons.length > 0);
        for (const reason of first.reasons) {
            assert.equal(typeof reason, "string");
            assert.equal(/\d/.test(reason), false);
        }
    }
});

test("answer-focus priority prefers tests over documentation and configuration", () => {
    const plan = buildSearchQueryPlan("find tests documenting how config is loaded", true);
    const resolution = resolveSearchAnswerFocus(plan);
    assert.equal(resolution.focus, "tests");
});

test("answer-focus priority prefers documentation over configuration", () => {
    const plan = buildSearchQueryPlan("guide to the configured risk limits", true);
    const resolution = resolveSearchAnswerFocus(plan);
    assert.equal(resolution.focus, "documentation");
});

test("answer-focus classifies package and build manifest declaration queries as configuration without changing route", () => {
    const manifestQueries = [
        "where are the Python build metadata, version, and runtime dependencies declared",
        "where are the module path and dependency versions declared for the Go build",
        "where are the package dependencies and scripts declared",
        "which file specifies the Rust crate metadata and dependencies",
    ];
    for (const query of manifestQueries) {
        const plan = buildSearchQueryPlan(query, true);
        assert.notEqual(plan.route.kind, "configuration", query);
        const resolution = resolveSearchAnswerFocus(plan);
        assert.equal(resolution.focus, "configuration", query);
        assert.deepEqual(resolution.reasons, ["manifest_declaration_query"]);
    }
});

test("answer-focus keeps runtime implementation queries about metadata or dependencies as non-configuration", () => {
    const implementationQueries = [
        "where does the app parse build metadata",
        "how does the loader read package dependencies",
        "how are runtime dependencies resolved",
        "where are useEffect dependencies compared",
    ];
    for (const query of implementationQueries) {
        const plan = buildSearchQueryPlan(query, true);
        const resolution = resolveSearchAnswerFocus(plan);
        assert.equal(resolution.focus, "implementation", query);
    }
    const nonConfigurationRuntimeQueries = [
        "where does the loader read package dependencies",
        "where are package dependencies loaded",
        "where are declared package dependencies loaded",
    ];
    for (const query of nonConfigurationRuntimeQueries) {
        const plan = buildSearchQueryPlan(query, true);
        assert.notEqual(resolveSearchAnswerFocus(plan).focus, "configuration", query);
    }
});
