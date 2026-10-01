import test from "node:test";
import assert from "node:assert/strict";
import {
    selectBoundedSource,
    createBoundedSourceSelector,
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

test("prepared source selection matches fresh selection across budgets and evidence", () => {
    const bodies = ["", "function café() {", "  // 😀 dependencies", "  return compare(deps);", "}"];
    for (const newline of ["\n", "\r\n", "\r"]) {
        for (const content of ["", bodies.join(newline), `${bodies.join(newline)}${newline}`,
            `function run() {${newline}${"x".repeat(5_000)}${newline}}`]) {
            const sourceBytes = Buffer.from(content);
            const symbolSpan = { startLine: 1, endLine: content.split(newline).length };
            const select = createBoundedSourceSelector({ sourceBytes, symbolSpan });
            for (const maximum of [1, 40, 200, 4_000, 12_000]) {
                for (const evidence of [false, true]) {
                    const options = {
                        budgets: budgets({ maxSourceBytes: maximum, maxExcerptBytes: maximum,
                            maxSerializedSourceBytes: maximum }),
                        capabilities,
                        query: evidence ? "compare dependencies" : "",
                        ...(evidence ? { evidenceSpans: [{ startLine: 1, endLine: 1 }],
                            structuralAnchors: [{ kind: "declaration" as const, span: { startLine: 1, endLine: 1 } }] } : {}),
                    };
                    assert.deepEqual(select(options), selectBoundedSource({ sourceBytes, symbolSpan, ...options }));
                }
            }
        }
    }
});

test("prepared selection owns its bytes and span rather than retaining mutable inputs", () => {
    const sourceBytes = Buffer.from("function run() { return true; }");
    const symbolSpan = { startLine: 1, endLine: 1 };
    const options = { budgets: budgets(), capabilities };
    const select = createBoundedSourceSelector({ sourceBytes, symbolSpan });
    const expected = selectBoundedSource({ sourceBytes, symbolSpan, ...options });
    sourceBytes.fill(120);
    assert.notDeepEqual(selectBoundedSource({ sourceBytes, symbolSpan, ...options }), expected);
    symbolSpan.startLine = 10;
    assert.deepEqual(select(options), expected);
    const result = select(options);
    if (result.status === "selected") result.source.excerpts[0].content = "changed result";
    assert.deepEqual(select(options), expected);
});

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

test("bounded source selector uses universal physical-line semantics", () => {
    for (const [name, lineEnding] of [
        ["lf", "\n"],
        ["crlf", "\r\n"],
        ["cr", "\r"],
    ] as const) {
        const content = ["function run() {", "  return true;", "}"].join(lineEnding);
        const result = selectBoundedSource({
            sourceBytes: Buffer.from(content, "utf8"),
            symbolSpan: { startLine: 1, endLine: 3 },
            budgets: budgets(),
            capabilities,
        });

        assert.equal(result.status, "selected", name);
        if (result.status !== "selected") continue;
        assert.equal(result.source.mode, "complete", name);
        assert.equal(result.source.totalLines, 3, name);
        assert.equal(result.source.excerpts[0]?.content, content, name);
    }
});

test("bounded source selector rejects unknown runtime policy identities", () => {
    assert.throws(() => selectBoundedSource({
        sourceBytes: Buffer.from("function run() {}", "utf8"),
        symbolSpan: { startLine: 1, endLine: 1 },
        budgets: budgets(),
        capabilities,
        selectionPolicyVersion: "bounded_source_selection_v99" as never,
    }), {
        name: "TypeError",
        message: "Unsupported bounded source selection policy version.",
    });
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

test("bounded source selector ignores lines after the symbol but still validates the whole file", () => {
    const symbol = ["function run() {", "  return deps;", "}"];
    const select = (source: Buffer, endLine = 3) => selectBoundedSource({
        sourceBytes: source,
        symbolSpan: { startLine: 1, endLine },
        query: "deps",
        budgets: budgets({ maxSourceLines: 2, maxExcerptLines: 1 }),
        capabilities,
    });
    const alone = select(Buffer.from(symbol.join("\r\n"), "utf8"));
    for (const trailer of ["\r\n", "\r\nconst after = 1;\rmore\n", "\n\n\n"]) {
        assert.deepEqual(select(Buffer.from(symbol.join("\r\n") + trailer, "utf8")), alone, JSON.stringify(trailer));
    }
    assert.throws(() => select(Buffer.from(symbol.join("\n"), "utf8"), 4), RangeError);
    const invalidAfterSymbol = Buffer.concat([Buffer.from(`${symbol.join("\n")}\n`, "utf8"), Buffer.from([0xff])]);
    assert.throws(() => select(invalidAfterSymbol), TypeError);
});
