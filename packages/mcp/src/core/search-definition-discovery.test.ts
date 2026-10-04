import assert from "node:assert/strict";
import test from "node:test";
import { allowsDefinitionDiscovery, fuseDefinitionDiscovery, type DefinitionDiscoveryMetadata } from "./search-definition-discovery.js";
import { parseSearchOperators, buildSearchQueryPlan } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";

const metadata = (name: string, file: string, qualifiedName = name, kind: DefinitionDiscoveryMetadata["kind"] = "function"): DefinitionDiscoveryMetadata => ({ name, qualifiedName, file, kind });
const order = (rows: DefinitionDiscoveryMetadata[], query: string) => fuseDefinitionDiscovery({
    items: rows.map((_row, index) => ({ originalIndex: index, providerRank: index + 1 })),
    query,
    metadata: index => rows[index],
});

test("definition evidence rescues a method from a narrative fixture without erasing provider rank", () => {
    const result = order([
        metadata("state_with_legal_targets", "engine/src/crop6309_fixture.rs"),
        metadata("legal_actions", "engine/src/state.rs", "GameState.legal_actions", "method"),
    ], "legal state target validation");
    assert.equal(result.applied, true);
    assert.deepEqual(result.items.map(item => item.originalIndex), [1, 0]);
    assert.deepEqual(result.items.map(item => item.providerRank), [2, 1]);
});

test("a production path alone cannot displace a relevant test", () => {
    const result = order([
        metadata("recordsRejectedOffers", "tests/trade.test.ts"),
        metadata("formatCurrency", "src/format.ts"),
    ], "trade workflow rejected bundle loop");
    assert.equal(result.applied, false);
    assert.deepEqual(result.items.map(item => item.originalIndex), [0, 1]);
});

test("prose callback labels cannot claim a definition vote", () => {
    const result = order([
        metadata('it("trade workflow rejected bundle loop") callback', "src/specifications.ts"),
        metadata("tradeWorkflow", "src/actions.ts"),
    ], "trade workflow rejected bundle loop");
    assert.deepEqual(result.items.map(item => item.originalIndex), [1, 0]);
});

test("specific owner uses its file's first slot without taking another file's slot", () => {
    const rows = [metadata("startWorkflow", "src/actions.ts"), metadata("unrelatedHelper", "src/other.ts"), metadata("tradeWorkflow", "src/actions.ts")];
    const result = order(rows, "trade workflow rejected bundle loop");
    assert.equal(result.items[0]?.originalIndex, 2);
    assert.equal(result.items[1]?.originalIndex, 0);
    assert.equal(result.items[2]?.originalIndex, 1);
    assert.equal(result.items.length, rows.length);
});

test("whole acronym spelling survives segmentation and file fallback stays a file", () => {
    const file = metadata("depth.rs", "engine/search/depth.rs", "depth.rs", "file");
    const result = order([file, metadata("search_maxn", "engine/search/depth.rs")], "MaxN");
    assert.equal(result.items[0]?.originalIndex, 1);
    assert.equal(file.kind, "file");
});

test("new publication metadata invalidates the identity cache", () => {
    const prior = metadata("tradeWorkflow", "src/actions.ts");
    const changed = metadata("drawWidget", "src/actions.ts");
    assert.equal(order([prior], "trade workflow").applied, true);
    assert.equal(order([changed], "trade workflow").applied, false);
    prior.name = "drawWidget";
    prior.qualifiedName = "drawWidget";
    assert.equal(order([prior], "trade workflow").applied, false);
});

test("explicit evidence intent and constrained queries bypass the engine", () => {
    for (const query of ["tests for trade workflow", "docs for trade workflow", "configuration for trade workflow", "callers of tradeWorkflow", "path:src/actions.ts trade workflow", "must:tradeWorkflow", "tradeWorkflow"]) {
        const parsed = parseSearchOperators(query);
        const queryPlan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
        assert.equal(allowsDefinitionDiscovery({
            enabled: true,
            queryPlan,
            answerFocus: resolveSearchAnswerFocus(queryPlan).focus,
            hasPathConstraint: parsed.path.length > 0,
            hasMustConstraint: parsed.must.length > 0,
            scope: "runtime",
        }), false, query);
    }
    const parsed = parseSearchOperators("trade workflow rejected bundle loop");
    const queryPlan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
    const input = { enabled: true, queryPlan, answerFocus: resolveSearchAnswerFocus(queryPlan).focus, hasPathConstraint: false, hasMustConstraint: false, scope: "runtime" };
    assert.equal(allowsDefinitionDiscovery(input), true);
    assert.equal(allowsDefinitionDiscovery({ ...input, enabled: false }), false);
    assert.equal(allowsDefinitionDiscovery({ ...input, scope: "docs" }), false);
    const ownership = parseSearchOperators("in the Python builder where is a vector started");
    const ownershipPlan = buildSearchQueryPlan(ownership.semanticQuery, true, ownership);
    assert.equal(ownershipPlan.route.kind, "ownership");
    assert.equal(allowsDefinitionDiscovery({ ...input, queryPlan: ownershipPlan, answerFocus: resolveSearchAnswerFocus(ownershipPlan).focus }), true);
});
