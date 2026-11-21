import assert from "node:assert/strict";
import test from "node:test";
import {
    allowsDefinitionDiscovery,
    extractExplicitQueryLanguages,
    fuseDefinitionDiscovery,
    type DefinitionDiscoveryMetadata,
} from "./search-definition-discovery.js";
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

test("an inflected query term reaches its declaration when the exact token is absent", () => {
    const rows = [
        metadata("SupportsUnionUnderlyingType", "include/flatbuffers/idl.h", "flatbuffers.Parser.SupportsUnionUnderlyingType", "method"),
        metadata("add_union_type", "include/flatbuffers/reflection_generated.h", "add_union_type", "method"),
        metadata("ParseAnyValue", "src/idl_parser.cpp", "flatbuffers.Parser.ParseAnyValue", "method"),
    ];
    const control = order(rows, "where does flatc resolve a union type");
    assert.equal(control.items.at(-1)?.originalIndex, 2);
    const result = order(rows, "where does flatc resolve a union type when parsing");
    assert.ok(result.items.findIndex(item => item.originalIndex === 2) < 2);
});

test("an exact query token keeps its own vote and does not trigger the fallback", () => {
    const result = order([
        metadata("parseState", "src/parse-state.ts"),
        metadata("unrelatedHelper", "src/other.ts"),
        metadata("parsingState", "src/parsing-state.ts"),
    ], "parsing");
    assert.deepEqual(result.items.map(item => item.originalIndex), [2, 0, 1]);
});

test("a doubled consonant and a silent e resolve to the document base", () => {
    const running = order([metadata("runState", "src/run.ts"), metadata("other", "src/other.ts")], "running");
    assert.equal(running.items[0]?.originalIndex, 0);
    const handling = order([metadata("other", "src/other.ts"), metadata("handleState", "src/handle.ts")], "handling");
    assert.equal(handling.items[0]?.originalIndex, 1);
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

test("name coverage does not spend a body-relevant implementation's slot on its file's helpers", () => {
    const names = ["recordAssessment", "rebuildWeaknesses", "rebuildObjectives", "loadEvidence", "getLearner", "loadProjection"];
    const result = order(names.map(name => metadata(name, "src/kernel/evidence.ts")),
        "Where does the kernel turn a graded attempt into durable evidence and rebuild learner objectives and weaknesses?");

    assert.equal(result.items[0]?.originalIndex, 0);
    assert.deepEqual(new Set(result.items.map(item => item.originalIndex)), new Set(names.map((_, index) => index)));
});

test("missing name evidence abstains on a behavior description instead of dropping the provider's owner", () => {
    const names = ["applyAsrAttributionPolicy", "error", "product", "transcription", "speech", "learner", "artifact"];
    const result = order(names.map((name, index) => metadata(name,
        index === 0 ? "src/communication/asr-gate.ts" : `src/cli-${index}.ts`)),
    "Where does the product decide whether a speech transcription error is the learner mistake or an artifact?");

    assert.equal(result.items[3]?.originalIndex, 0);
    assert.equal(result.items[3]?.providerRank, 1);
});

const behaviorQuery = "Where does the product decide whether a speech transcription error is the learner mistake or an artifact?";
const namedHelpers = ["error", "product", "transcription", "speech", "learner", "artifact"]
    .map((name, index) => metadata(name, `src/cli-${index}.ts`));

test("configuration declarations and module-level proxies abstain like an unnamed implementation", () => {
    const result = order([
        metadata("project", "pyproject.toml", "project", "class"),
        metadata("request", "src/flask/globals.py", "request", "property"),
        ...namedHelpers,
    ], behaviorQuery);

    assert.deepEqual(result.items.slice(0, 5).map(item => item.originalIndex), [2, 3, 0, 4, 1]);
});

test("narrative paths and file chunks keep only their provider vote", () => {
    const result = order([
        metadata("test_transcription_gate", "tests/test_gate.py"),
        metadata("gate.py", "src/gate.py", "gate.py", "file"),
        ...namedHelpers,
    ], behaviorQuery);

    assert.deepEqual(result.items.slice(-2).map(item => item.originalIndex), [0, 1]);
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

test("polyglot natural-language language affinity boosts the requested runtime without affecting single-language pools", () => {
    assert.deepEqual(extractExplicitQueryLanguages("in the Kotlin runtime where does the builder grow its buffer"), ["kotlin"]);
    assert.deepEqual(extractExplicitQueryLanguages("where does the C++ generator emit code for a table"), ["cpp"]);
    assert.deepEqual(extractExplicitQueryLanguages("where does React flush passive effects"), []);

    const rows = [
        { meta: metadata("growByteBuffer", "go/builder.go"), lang: "go" },
        { meta: metadata("growByteBuffer", "ts/builder.ts"), lang: "typescript" },
        { meta: metadata("requestCapacity", "kotlin/Buffers.kt"), lang: "kotlin" },
    ];
    const polyglot = fuseDefinitionDiscovery({
        items: rows.map((_, index) => ({ originalIndex: index, providerRank: index + 1 })),
        query: "in the Kotlin runtime where does the builder grow its buffer",
        metadata: (index) => rows[index]!.meta,
        candidateLanguage: (index) => rows[index]!.lang,
        candidatePath: (index) => rows[index]!.meta.file,
    });
    assert.equal(polyglot.applied, true);
    assert.equal(polyglot.items[0]?.originalIndex, 2);

    // Single-language pool: language affinity must stay a no-op.
    const monoRows = [
        { meta: metadata("first", "src/a.py"), lang: "python" },
        { meta: metadata("second", "src/b.py"), lang: "python" },
    ];
    const mono = fuseDefinitionDiscovery({
        items: monoRows.map((_, index) => ({ originalIndex: index, providerRank: index + 1 })),
        query: "in the Python module where is unrelated behavior",
        metadata: (index) => monoRows[index]!.meta,
        candidateLanguage: (index) => monoRows[index]!.lang,
        candidatePath: (index) => monoRows[index]!.meta.file,
    });
    assert.equal(mono.applied, false);
    assert.deepEqual(mono.items.map((item) => item.originalIndex), [0, 1]);
});

test("totalWindowSize preserves provider rank spread when supporting candidates were omitted before reranking", () => {
    const rows = [
        metadata("ownerImpl", "src/core/hooks.js"),
        metadata("dispatchSetStateInternal", "src/core/hooks.js"),
        metadata("shim", "src/shim.js"),
        metadata("helper", "src/helper.js"),
        metadata("validateNoSetStateInRender", "compiler/validate_no_set_state_in_render.rs"),
    ];
    const compressed = fuseDefinitionDiscovery({
        items: rows.map((_, index) => ({ originalIndex: index, providerRank: index + 1 })),
        query: "where does useState schedule a re-render when you call the setter",
        metadata: (index) => rows[index],
    });
    const scaled = fuseDefinitionDiscovery({
        items: rows.map((_, index) => ({ originalIndex: index, providerRank: index + 1 })),
        query: "where does useState schedule a re-render when you call the setter",
        metadata: (index) => rows[index],
        totalWindowSize: 128,
    });
    const rankIn = (result: typeof compressed, targetIndex: number) => (
        result.items.findIndex((item) => item.originalIndex === targetIndex)
    );
    assert.ok(
        rankIn(scaled, 1) <= rankIn(compressed, 1),
        "preserving original window rank spread must not demote top provider picks below late BM25 matches",
    );
});

test("minimumMatchedTerms filters incidental single-token definition matches on multi-term queries", () => {
    const rows = [
        metadata("make_response", "src/app.py"),
        metadata("url_value_preprocessor", "src/scaffold.py"),
        metadata("convert_response_value", "src/response.py"),
    ];
    const filtered = fuseDefinitionDiscovery({
        items: rows.map((_, index) => ({ originalIndex: index, providerRank: index + 1 })),
        query: "convert value into a response object",
        metadata: (index) => rows[index],
        minimumMatchedTerms: 2,
    });
    assert.equal(filtered.applied, true);
    // url_value_preprocessor only matched 1 term ("value"), so it must not outrank make_response (#1)
    // while convert_response_value matched 3 terms and remains eligible.
    const idxOf = (orig: number) => filtered.items.findIndex((item) => item.originalIndex === orig);
    assert.ok(idxOf(0) < idxOf(1));
    assert.ok(idxOf(2) < idxOf(1));
});

test("minimumMatchedTerms prevents filtered single-term matches from swapping ahead within the same file", () => {
    const rows = [
        metadata("dispatch_impl", "src/app.py"),
        metadata("value_helper", "src/app.py"),
        metadata("convert_response_value", "src/other.py"),
    ];
    const filtered = fuseDefinitionDiscovery({
        items: rows.map((_, index) => ({ originalIndex: index, providerRank: index + 1 })),
        query: "convert value into a response object",
        metadata: (index) => rows[index],
        minimumMatchedTerms: 2,
    });
    assert.equal(filtered.applied, true);
    const idxOf = (orig: number) => filtered.items.findIndex((item) => item.originalIndex === orig);
    assert.ok(
        idxOf(0) < idxOf(1),
        "single-term same-file helper must not swap ahead of higher-ranked implementation when minimumMatchedTerms=2",
    );
});
