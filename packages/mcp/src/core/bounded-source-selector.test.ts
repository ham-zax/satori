import test from "node:test";
import assert from "node:assert/strict";
import {
    selectBoundedSource,
    type BoundedSourceBudgets,
    type SourceSelectionCapabilities,
} from "./bounded-source-selector.js";

const capabilities: SourceSelectionCapabilities = {
    localLexical: "available",
    lineWindows: "available",
    syntaxBoundaries: "available",
    controlFlowAnchors: "available",
};

function budgets(overrides: Partial<BoundedSourceBudgets> = {}): BoundedSourceBudgets {
    return {
        maxSourceBytes: 12_000,
        maxSourceLines: 200,
        maxExcerpts: 5,
        maxExcerptBytes: 4_000,
        maxExcerptLines: 40,
        contextLines: 0,
        maxSerializedSourceBytes: 24_000,
        ...overrides,
    };
}

test("bounded source selector returns complete UTF-8 source when all caps fit", () => {
    const content = "function café() {\r\n  return \"ok\";\r\n}";
    const result = selectBoundedSource({
        sourceBytes: Buffer.from(content, "utf8"),
        symbolSpan: { startLine: 1, endLine: 3 },
        budgets: budgets(),
        capabilities,
    });

    assert.equal(result.status, "selected");
    if (result.status !== "selected") return;
    assert.equal(result.source.mode, "complete");
    assert.equal(result.source.completeSymbolReturned, true);
    assert.equal(result.source.totalBytes, Buffer.byteLength(content, "utf8"));
    assert.equal(result.source.returnedBytes, result.source.totalBytes);
    assert.equal(result.source.excerpts[0]?.content, content);
    assert.deepEqual(result.source.omittedRanges, []);
    assert.ok(result.serializedSourceBytes <= 24_000);
});

test("bounded source selector returns beginning, query, and terminal evidence instead of first N lines", () => {
    const lines = [
        "function reconcile() {",
        "  const a = 1;",
        "  const b = 2;",
        "  const c = 3;",
        "  const d = 4;",
        "  persistTransaction();",
        "  const e = 5;",
        "  const f = 6;",
        "  const g = 7;",
        "  return done;",
    ];
    const result = selectBoundedSource({
        sourceBytes: Buffer.from(lines.join("\n"), "utf8"),
        symbolSpan: { startLine: 1, endLine: 10 },
        query: "persist transaction",
        budgets: budgets({
            maxSourceLines: 3,
            maxExcerptLines: 1,
            maxExcerpts: 3,
        }),
        capabilities,
    });

    assert.equal(result.status, "selected");
    if (result.status !== "selected") return;
    assert.equal(result.source.mode, "bounded");
    assert.deepEqual(result.source.excerpts.map((excerpt) => excerpt.startLine), [1, 6, 10]);
    assert.deepEqual(result.source.excerpts.map((excerpt) => excerpt.reason), [
        "declaration",
        "query_match",
        "terminal",
    ]);
    assert.deepEqual(result.source.omittedRanges.map(({ startLine, endLine }) => ({ startLine, endLine })), [
        { startLine: 2, endLine: 5 },
        { startLine: 7, endLine: 9 },
    ]);
    assert.equal(result.source.returnedLines, 3);
    assert.equal(result.source.truncated, true);
    assert.equal(
        result.source.returnedBytes
            + result.source.omittedRanges.reduce((total, range) => total + range.endByte - range.startByte, 0),
        result.source.totalBytes,
    );
});

test("bounded source selector ranks exact normalized tokens above misleading substrings", () => {
    const lines = [
        "function authorize() {",
        "  const author = commitmentAuthor;",
        "  const auth = readAuth();",
        "  const commitValue = auth;",
        "  return commitValue;",
    ];
    const authResult = selectBoundedSource({
        sourceBytes: Buffer.from(lines.join("\n"), "utf8"),
        symbolSpan: { startLine: 1, endLine: lines.length },
        query: "auth",
        budgets: budgets({
            maxSourceLines: 3,
            maxExcerptLines: 1,
            maxExcerpts: 3,
        }),
        capabilities,
    });
    assert.equal(authResult.status, "selected");
    if (authResult.status !== "selected") return;
    const authQuery = authResult.source.excerpts.find((excerpt) => excerpt.reason === "query_match");
    assert.equal(authQuery?.startLine, 3);

    for (const query of ["commit value", "commitValue", "commit_value"]) {
        const camelResult = selectBoundedSource({
            sourceBytes: Buffer.from(lines.join("\n"), "utf8"),
            symbolSpan: { startLine: 1, endLine: lines.length },
            query,
            budgets: budgets({
                maxSourceLines: 3,
                maxExcerptLines: 1,
                maxExcerpts: 3,
            }),
            capabilities,
        });
        assert.equal(camelResult.status, "selected", query);
        if (camelResult.status !== "selected") continue;
        const camelQuery = camelResult.source.excerpts.find((excerpt) => excerpt.reason === "query_match");
        assert.equal(camelQuery?.startLine, 4, query);
    }
});

test("bounded source selector merges overlapping evidence and retains selection bases", () => {
    const lines = [
        "function decide() {",
        "  prepare();",
        "  persistTransaction();",
        "  return result;",
        "}",
    ];
    const result = selectBoundedSource({
        sourceBytes: Buffer.from(lines.join("\n"), "utf8"),
        symbolSpan: { startLine: 1, endLine: 5 },
        query: "persist transaction",
        evidenceSpans: [{ startLine: 3, endLine: 3 }],
        budgets: budgets({
            maxSourceLines: 4,
            maxExcerptLines: 3,
            contextLines: 1,
        }),
        capabilities,
    });

    assert.equal(result.status, "selected");
    if (result.status !== "selected") return;
    const queryExcerpt = result.source.excerpts.find((excerpt) => excerpt.startLine <= 3 && excerpt.endLine >= 3);
    assert.ok(queryExcerpt);
    assert.ok(queryExcerpt.selectionBases.includes("validated_evidence_span"));
    assert.ok(queryExcerpt.selectionBases.includes("local_lexical_query"));
    for (let index = 1; index < result.source.excerpts.length; index += 1) {
        assert.ok(result.source.excerpts[index - 1].endLine < result.source.excerpts[index].startLine);
    }
});

test("bounded source selector never splits an oversized physical line", () => {
    const sourceBytes = Buffer.from("x".repeat(8_400), "utf8");
    const result = selectBoundedSource({
        sourceBytes,
        symbolSpan: { startLine: 1, endLine: 1 },
        budgets: budgets({
            maxSourceBytes: 4_000,
            maxExcerptBytes: 4_000,
        }),
        capabilities: {
            ...capabilities,
            syntaxBoundaries: "unavailable_streaming_source",
            controlFlowAnchors: "unavailable_streaming_source",
        },
    });

    assert.equal(result.status, "selected");
    if (result.status !== "selected") return;
    assert.equal(result.source.mode, "bounded");
    assert.equal(result.source.status, "unavailable");
    assert.equal(result.source.emptyReason, "line_exceeds_excerpt_limit");
    assert.deepEqual(result.source.excerpts, []);
    assert.deepEqual(result.source.omittedRanges, [{
        startLine: 1,
        endLine: 1,
        startByte: 0,
        endByte: sourceBytes.length,
    }]);
});

test("bounded source selector marks valid evidence partially available when another line is oversized", () => {
    const content = [
        "function mixed() {",
        "x".repeat(5_000),
        "return done;",
    ].join("\n");
    const result = selectBoundedSource({
        sourceBytes: Buffer.from(content, "utf8"),
        symbolSpan: { startLine: 1, endLine: 3 },
        budgets: budgets({
            maxSourceBytes: 4_000,
            maxSourceLines: 2,
            maxExcerptBytes: 4_000,
            maxExcerptLines: 1,
        }),
        capabilities,
    });

    assert.equal(result.status, "selected");
    if (result.status !== "selected") return;
    assert.equal(result.source.status, "partially_available");
    assert.deepEqual(result.source.excerpts.map((excerpt) => excerpt.startLine), [1, 3]);
    assert.deepEqual(result.source.limitations, ["line_exceeds_excerpt_limit"]);
});

test("bounded source selector reports the minimum projection when the serialized budget cannot fit", () => {
    const result = selectBoundedSource({
        sourceBytes: Buffer.from("function run() {\n  return true;\n}", "utf8"),
        symbolSpan: { startLine: 1, endLine: 3 },
        budgets: budgets({
            maxSourceLines: 1,
            maxExcerptLines: 1,
            maxSerializedSourceBytes: 1,
        }),
        capabilities,
    });

    assert.equal(result.status, "minimum_projection_exceeds_budget");
    if (result.status !== "minimum_projection_exceeds_budget") return;
    assert.ok(result.minimumRequiredSerializedSourceBytes > 1);
});

test("bounded source selector never lets a smaller optional excerpt displace the declaration", () => {
    const content = `${"function longDeclarationName".repeat(20)}\nquery\nreturn done;`;
    const unconstrained = selectBoundedSource({
        sourceBytes: Buffer.from(content, "utf8"),
        symbolSpan: { startLine: 1, endLine: 3 },
        query: "query",
        budgets: budgets({ maxSourceLines: 2, maxExcerptLines: 1 }),
        capabilities,
    });
    assert.equal(unconstrained.status, "selected");
    if (unconstrained.status !== "selected") return;
    const declarationOnlyBytes = Buffer.byteLength(JSON.stringify({
        ...unconstrained.source,
        excerpts: unconstrained.source.excerpts.filter((excerpt) => excerpt.reason === "declaration"),
    }), "utf8");

    const constrained = selectBoundedSource({
        sourceBytes: Buffer.from(content, "utf8"),
        symbolSpan: { startLine: 1, endLine: 3 },
        query: "query",
        budgets: budgets({
            maxSourceLines: 2,
            maxExcerptLines: 1,
            maxSerializedSourceBytes: Math.max(1, declarationOnlyBytes - 1),
        }),
        capabilities,
    });
    assert.equal(constrained.status, "minimum_projection_exceeds_budget");
});

test("bounded source selector is byte-identical across repeated equivalent inputs", () => {
    const input = {
        sourceBytes: Buffer.from("function run() {\n  persist();\n  return true;\n}", "utf8"),
        symbolSpan: { startLine: 1, endLine: 4 },
        query: "persist",
        budgets: budgets({ maxSourceLines: 2, maxExcerptLines: 1 }),
        capabilities,
    };
    const first = selectBoundedSource(input);
    const second = selectBoundedSource(input);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});
