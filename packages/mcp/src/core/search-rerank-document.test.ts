import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedSourceSelector } from "./bounded-source-selector.js";
import {
    buildSearchRerankDocument,
    resolveSearchRerankDocumentProjectionIdentity,
    SEARCH_RERANK_DOCUMENT_POLICY,
} from "./search-rerank-document.js";
import {
    MAXIMUM_SELECTION_ATTEMPTS,
    MAXIMUM_UTF8_BYTES,
    selectedExcerptText,
    selectRerankSourceWithinBudget,
    selectSource,
    type NormalizedProjectionInput,
} from "./search-rerank-projection-primitives.js";
import type { SearchRerankStructuralReference } from "./search-rerank-structural-context.js";

const CONTENT = [
    "function validate_order(order) {",
    "    // shariah gate",
    "    return check_shariah_compliance(order);",
    "}",
    "",
    "function check_shariah_compliance(order) {",
    "    return order.risk_score > 0.8;",
    "}",
].join("\n");

function baseInput(overrides: Record<string, unknown> = {}) {
    return {
        relativePath: "src/veto.ts",
        language: "typescript",
        candidateRole: "implementation",
        symbolKind: "function",
        canonicalSymbolLabel: "validate_order",
        symbolSpan: { startLine: 1, endLine: 4 },
        content: CONTENT,
        query: "how does shariah compliance checking block trades",
        ...overrides,
    };
}

function ref(relation: SearchRerankStructuralReference["relation"], index: number): SearchRerankStructuralReference {
    return {
        repository_relative_path: `src/ref-${index}.ts`,
        canonical_symbol_label: `ref_symbol_${index}`,
        relation,
    };
}

test("canonical policy carries the frozen v5 contract identity", () => {
    assert.equal(SEARCH_RERANK_DOCUMENT_POLICY.id, "search_rerank_document_v5");
});

test("Swift attributes do not replace the callable declaration in the rerank signature", () => {
    const declaration = "mutating public func create(string str: String?) -> Offset {";
    const content = [
        "  @inline(__always)",
        `  ${declaration}`,
        "    guard let str = str else { return Offset() }",
        "    return Offset(offset: str.utf8.count)",
        "  }",
    ].join("\n");
    const result = buildSearchRerankDocument(baseInput({
        relativePath: "swift/Sources/FlatBuffers/FlatBufferBuilder.swift",
        language: "swift",
        canonicalSymbolLabel: "function create",
        content,
        symbolSpan: { startLine: 1, endLine: 5 },
        query: "in the Swift library where does the builder add a string",
    }));
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.signature_or_declaration, declaration);
    assert.ok(parsed.query_relevant_source_excerpt.includes("@inline(__always)"));
    assert.ok(parsed.query_relevant_source_excerpt.includes(declaration));
    assert.equal(result.utf8Bytes <= SEARCH_RERANK_DOCUMENT_POLICY.maximumUtf8Bytes, true);
});

test("Swift declaration selection handles stacked attributes and preserves uncertain or mixed syntax", () => {
    const declaration = "public func load() -> String {";
    const fixtures = [
        { language: "swift", lines: ["@MainActor", "@available(iOS 13.0, *)", declaration, "}"], expected: declaration },
        { language: "swift", lines: [`@inline(__always) ${declaration}`, "}"], expected: `@inline(__always) ${declaration}` },
        { language: "swift", lines: ["@available(", "iOS 13.0, *)", declaration, "}"], expected: "@available(" },
        { language: "swift", lines: ["@SomeAttribute(nested())", declaration, "}"], expected: "@SomeAttribute(nested())" },
        { language: "csharp", lines: ["@Result", "Create() { return result; }"], expected: "@Result" },
    ];
    for (const fixture of fixtures) {
        const result = buildSearchRerankDocument(baseInput({
            language: fixture.language,
            content: fixture.lines.join("\n"),
            symbolSpan: { startLine: 1, endLine: fixture.lines.length },
        }));
        assert.equal(JSON.parse(result.text).signature_or_declaration, fixture.expected);
    }
    assert.throws(() => buildSearchRerankDocument(baseInput({
        language: "swift", content: "@MainActor\n@inline(__always)", symbolSpan: { startLine: 1, endLine: 2 },
    })), /inferred signatureOrDeclaration must be a non-empty string/);
});

test("canonical projection encodes the source once across budget attempts", (t) => {
    const oversizedLines = [
        "function validate_order(order) {",
        ...Array.from({ length: 120 }, (_, i) => `    const check_${i} = check_shariah_compliance(order, "${"x".repeat(40)}_${i}");`),
        "    return check_0;",
        "}",
    ];
    const oversizedContent = oversizedLines.join("\n");
    const original = Buffer.from;
    let encodings = 0;
    t.mock.method(Buffer, "from", (...args: Parameters<typeof Buffer.from>) => {
        if (args[0] === oversizedContent) encodings++;
        return Reflect.apply(original, Buffer, args);
    });
    const result = buildSearchRerankDocument(baseInput({
        content: oversizedContent,
        symbolSpan: { startLine: 1, endLine: oversizedLines.length },
    }));
    assert.ok(result.selectionAttemptCount > 1);
    assert.equal(encodings, 1);

    // Complete symbols resolve in one shot while still encoding source once.
    let completeEncodings = 0;
    t.mock.method(Buffer, "from", (...args: Parameters<typeof Buffer.from>) => {
        if (args[0] === CONTENT) completeEncodings++;
        return Reflect.apply(original, Buffer, args);
    });
    const completeResult = buildSearchRerankDocument(baseInput());
    assert.equal(completeResult.selectionAttemptCount, 1);
    assert.equal(completeEncodings, 1);
});

test("selectRerankSourceWithinBudget fast path is bit-identical to reference binary search across edge fixtures", () => {
    const referenceBinarySearch = (input: {
        normalized: NormalizedProjectionInput;
        minimumText: string;
        buildProjectionText: (excerpt: string) => string;
    }) => {
        const minimumBytes = Buffer.byteLength(input.minimumText, "utf8");
        let lowerBudget = 1;
        let upperBudget = Math.max(1, MAXIMUM_UTF8_BYTES - minimumBytes);
        let selectedSource: ReturnType<typeof selectRerankSourceWithinBudget>["selectedSource"];
        let text = input.minimumText;
        const select = createBoundedSourceSelector({
            sourceBytes: Buffer.from(input.normalized.content, "utf8"),
            symbolSpan: input.normalized.symbolSpan,
        });
        for (
            let attempt = 0;
            attempt < MAXIMUM_SELECTION_ATTEMPTS && lowerBudget <= upperBudget;
            attempt += 1
        ) {
            const sourceBudget = Math.floor((lowerBudget + upperBudget) / 2);
            const selection = selectSource(input.normalized, sourceBudget, undefined, select);
            if (selection.status !== "selected") {
                lowerBudget = sourceBudget + 1;
                continue;
            }
            const candidateText = input.buildProjectionText(selectedExcerptText(selection.source));
            if (Buffer.byteLength(candidateText, "utf8") <= MAXIMUM_UTF8_BYTES) {
                selectedSource = selection.source;
                text = candidateText;
                lowerBudget = sourceBudget + 1;
                continue;
            }
            upperBudget = sourceBudget - 1;
        }
        return { text, selectedSource };
    };

    const makeFixture = (name: string, content: string, query: string): {
        name: string;
        normalized: NormalizedProjectionInput;
        expectFastHit: boolean;
    } => {
        const lineCount = content.split("\n").length;
        return {
            name,
            normalized: {
                relativePath: "src/fixture.ts",
                language: "typescript",
                symbolKind: "function",
                canonicalSymbolLabel: "fixture",
                signatureOrDeclaration: content.split("\n")[0] ?? "function fixture()",
                documentationExcerpt: "",
                requiredOwnerSiblings: [],
                content,
                query,
                symbolSpan: { startLine: 1, endLine: lineCount },
                evidenceSpans: [],
            },
            expectFastHit: false,
        };
    };

    // 1. Small complete symbol -> fast hit (1 attempt)
    const smallComplete = { ...makeFixture("small_complete", CONTENT, "shariah compliance"), expectFastHit: true };
    // 2. Heavy JSON-escaping near 4000-byte boundary: raw bytes fit in upperBudget (~2500 B),
    //    but JSON escaping (\u001b -> 6 B, \" -> 2 B, \\ -> 2 B) pushes outer candidateText > 4000 B!
    const heavyEscapeLines = [
        "function escapeBoundary() {",
        ...Array.from({ length: 45 }, (_, i) => `  const s${i} = "\\\\" + "\\"" + "\u001b[31m\u001b[0m" + "你好🚀_${i}";`),
        "  return s0;",
        "}",
    ];
    const heavyEscape = makeFixture("heavy_json_escape_over_4000", heavyEscapeLines.join("\n"), "escapeBoundary");
    // 3. Complete symbol with CJK/emoji that stays just under 4000 B after escaping
    const utf8UnderLines = [
        "function utf8UnderLimit() {",
        ...Array.from({ length: 25 }, (_, i) => `  const msg${i} = "こんにちは世界_${i}_🚀";`),
        "  return msg0;",
        "}",
    ];
    const utf8Under = { ...makeFixture("utf8_complete_under_4000", utf8UnderLines.join("\n"), "utf8UnderLimit"), expectFastHit: true };
    // 4. Truncated symbol > 4000 bytes
    const largeBytesLines = [
        "function largeFunction(input) {",
        ...Array.from({ length: 120 }, (_, i) => `  const item_${i} = processValue(input, "payload_${"a".repeat(36)}_${i}");`),
        "  return item_99;",
        "}",
    ];
    const largeBytes = makeFixture("truncated_over_4000_bytes", largeBytesLines.join("\n"), "processValue item_99");
    // 5. Truncated symbol > 200 lines (short lines so raw bytes < 3000, but lines > 200 forces bounded excerpt!)
    const over200Lines = [
        "function manyShortLines() {",
        ...Array.from({ length: 215 }, (_, i) => `  a(${i});`),
        "  return 1;",
        "}",
    ];
    const manyLines = makeFixture("truncated_over_200_lines", over200Lines.join("\n"), "manyShortLines");

    for (const fixture of [smallComplete, heavyEscape, utf8Under, largeBytes, manyLines]) {
        const buildProjectionText = (excerpt: string) => JSON.stringify({
            repository_relative_path: fixture.normalized.relativePath,
            canonical_symbol_label: fixture.normalized.canonicalSymbolLabel,
            query_relevant_source_excerpt: excerpt,
        });
        const minimumText = buildProjectionText("");
        const expected = referenceBinarySearch({
            normalized: fixture.normalized,
            minimumText,
            buildProjectionText,
        });
        const actual = selectRerankSourceWithinBudget({
            normalized: fixture.normalized,
            minimumText,
            buildProjectionText,
        });
        assert.equal(actual.text, expected.text, `${fixture.name}: projection text must be bit-identical`);
        assert.deepEqual(actual.selectedSource, expected.selectedSource, `${fixture.name}: selectedSource must match`);
        assert.ok(Buffer.byteLength(actual.text, "utf8") <= MAXIMUM_UTF8_BYTES, `${fixture.name}: must respect byte budget`);
        if (fixture.expectFastHit) {
            assert.equal(actual.selectionAttemptCount, 1, `${fixture.name}: expected 1-shot fast path`);
        } else {
            assert.ok(actual.selectionAttemptCount > 1, `${fixture.name}: expected binary search fallback`);
        }
    }

    // 6. Custom buildProjectionText whose non-empty excerpt pushes outer bytes > 4000
    //    even when selectPreparedBoundedSource returns completeSymbolReturned === true.
    //    Directly exercises the probeBytes <= MAXIMUM_UTF8_BYTES guard.
    const outerOverflowFixture = makeFixture(
        "complete_symbol_outer_projection_overflow",
        [
            "function overflowOuter() {",
            ...Array.from({ length: 18 }, (_, i) => `  const v${i} = "${"z".repeat(40)}_${i}";`),
            "  return v0;",
            "}",
        ].join("\n"),
        "overflowOuter",
    );
    const buildExpandingProjectionText = (excerpt: string) => JSON.stringify({
        repository_relative_path: outerOverflowFixture.normalized.relativePath,
        canonical_symbol_label: outerOverflowFixture.normalized.canonicalSymbolLabel,
        query_relevant_source_excerpt: excerpt,
        ...(excerpt.length > 0 ? { extra_framing: "f".repeat(3_200) } : {}),
    });
    const expandingMinimumText = buildExpandingProjectionText("");
    const expectedExpanding = referenceBinarySearch({
        normalized: outerOverflowFixture.normalized,
        minimumText: expandingMinimumText,
        buildProjectionText: buildExpandingProjectionText,
    });
    const actualExpanding = selectRerankSourceWithinBudget({
        normalized: outerOverflowFixture.normalized,
        minimumText: expandingMinimumText,
        buildProjectionText: buildExpandingProjectionText,
    });
    assert.equal(actualExpanding.text, expectedExpanding.text);
    assert.deepEqual(actualExpanding.selectedSource, expectedExpanding.selectedSource);
    assert.ok(Buffer.byteLength(actualExpanding.text, "utf8") <= MAXIMUM_UTF8_BYTES);
    assert.ok(actualExpanding.selectionAttemptCount > 1);
});

test("v5 keeps textual source references distinct from trusted structural relationships", () => {
    const sourceReference = { repository_relative_path: "src/veto.ts", containing_symbol_label: "function useEffect",
        source_line: 7, reference_source_excerpt: "return validate_order(order);" };
    const result = buildSearchRerankDocument(baseInput({ sourceReferences: [sourceReference] }));
    const parsed = JSON.parse(result.text);
    assert.deepEqual(parsed.source_references, [sourceReference]);
    assert.deepEqual(parsed.structural_context.direct_callers, []);
    assert.equal(result.sourceReferencesTruncated, false);
    assert.throws(() => buildSearchRerankDocument(baseInput({ sourceReferences: [{ ...sourceReference,
        reference_source_excerpt: "x".repeat(401) }] })), /reference_source_excerpt/);
});

test("textual references never displace primary source when the document budget is full", () => {
    const baseline = buildSearchRerankDocument(baseInput());
    const result = buildSearchRerankDocument(baseInput({ sourceReferences: [1, 2, 3].map((line) => ({
        repository_relative_path: "src/veto.ts", containing_symbol_label: "x".repeat(4_000),
        source_line: line, reference_source_excerpt: "validate_order(order);",
    })) }));
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.query_relevant_source_excerpt, JSON.parse(baseline.text).query_relevant_source_excerpt);
    assert.deepEqual(parsed.source_references, []);
    assert.equal(result.sourceReferencesTruncated, true);
    assert.ok(result.utf8Bytes <= 4_000);
});

test("canonical projection carries the answer-packet shape with bounded structural context", () => {
    const result = buildSearchRerankDocument(baseInput({
        structuralContext: {
            directCallers: [ref("caller", 1), ref("caller", 2)],
            directCallees: [ref("callee", 3)],
            supportingTests: [ref("test_support", 4)],
        },
    }));
    assert.equal(result.version, "search_rerank_document_v5");
    assert.equal(result.utf8Bytes <= 4_000, true);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.repository_relative_path, "src/veto.ts");
    assert.equal(parsed.candidate_role, "implementation");
    assert.equal(parsed.symbol_kind, "function");
    assert.equal(parsed.canonical_symbol_label, "validate_order");
    assert.ok(parsed.signature_or_declaration.includes("function validate_order(order)"));
    assert.deepEqual(parsed.structural_context.direct_callers, [
        { repository_relative_path: "src/ref-1.ts", canonical_symbol_label: "ref_symbol_1", relation: "caller" },
        { repository_relative_path: "src/ref-2.ts", canonical_symbol_label: "ref_symbol_2", relation: "caller" },
    ]);
    assert.deepEqual(parsed.structural_context.direct_callees, [
        { repository_relative_path: "src/ref-3.ts", canonical_symbol_label: "ref_symbol_3", relation: "callee" },
    ]);
    assert.deepEqual(parsed.structural_context.supporting_tests, [
        { repository_relative_path: "src/ref-4.ts", canonical_symbol_label: "ref_symbol_4", relation: "test_support" },
    ]);
    assert.ok(parsed.query_relevant_source_excerpt.includes("check_shariah_compliance"));
});

test("canonical projection with empty structural context keeps declaration and primary source selection", () => {
    const result = buildSearchRerankDocument(baseInput());
    assert.equal(result.version, SEARCH_RERANK_DOCUMENT_POLICY.id);
    const parsed = JSON.parse(result.text);
    assert.ok(
        parsed.signature_or_declaration.includes("function validate_order(order)"),
        "declaration selection must survive an empty structural context",
    );
    assert.ok(
        parsed.query_relevant_source_excerpt.length > 0,
        "primary source selection must still run when structural context is empty",
    );
    assert.deepEqual(parsed.structural_context, {
        direct_callers: [],
        direct_callees: [],
        supporting_tests: [],
    });
    assert.equal("language" in parsed, false);
    assert.equal("documentation_excerpt" in parsed, false);
    assert.equal("required_owner_siblings" in parsed, false);
});

test("canonical projection stays within 4,000 UTF-8 bytes under a full structural context and truncates references before source", () => {
    const longLabel = "very_long_qualified_symbol_name_for_trade_veto_validation_flow_".repeat(8);
    const structuralContext = {
        directCallers: [1, 2, 3].map((index) => ({
            repository_relative_path: `src/deeply/nested/implementation/caller-${index}.ts`,
            canonical_symbol_label: `caller_${index}_${longLabel}`,
            relation: "caller" as const,
        })),
        directCallees: [4, 5, 6].map((index) => ({
            repository_relative_path: `src/deeply/nested/implementation/callee-${index}.ts`,
            canonical_symbol_label: `callee_${index}_${longLabel}`,
            relation: "callee" as const,
        })),
        supportingTests: [7, 8].map((index) => ({
            repository_relative_path: `tests/deeply/nested/supporting/test-${index}.test.ts`,
            canonical_symbol_label: `test_${index}_${longLabel}`,
            relation: "test_support" as const,
        })),
    };
    const result = buildSearchRerankDocument(baseInput({
        structuralContext,
        content: Array.from({ length: 60 }, (_, index) => `line ${index}: export function worker_${index}() { return ${index}; }`).join("\n"),
        symbolSpan: { startLine: 1, endLine: 3 },
        canonicalSymbolLabel: "worker",
        query: "worker dispatch routing",
    }));
    assert.equal(result.utf8Bytes <= 4_000, true, `projection exceeded 4000 bytes: ${result.utf8Bytes}`);
    const parsed = JSON.parse(result.text);
    assert.ok(parsed.signature_or_declaration.length > 0, "mandatory declaration must survive truncation");
    const totalReferences = parsed.structural_context.direct_callers.length
        + parsed.structural_context.direct_callees.length
        + parsed.structural_context.supporting_tests.length;
    assert.ok(
        totalReferences <= 8,
        `reference lists must be truncatable (kept ${totalReferences} of 8)`,
    );
    assert.ok(
        result.structuralContextTruncated === true,
        "the stress fixture must have forced reference truncation",
    );
});

test("canonical projection rejects a mandatory projection that exceeds the byte budget even with zero references", () => {
    assert.throws(
        () => buildSearchRerankDocument(baseInput({
            canonicalSymbolLabel: "x".repeat(4_000),
        })),
        /base projection exceeds/,
    );
});

test("canonical projection keeps the same primary source excerpt when optional structural references fit beside it", () => {
    const content = Array.from(
        { length: 120 },
        (_, index) => `line ${index}: dispatch_trade_for_exact_question(${index});`,
    ).join("\n");
    const input = baseInput({
        content,
        symbolSpan: { startLine: 1, endLine: 120 },
        canonicalSymbolLabel: "dispatch_trade_for_exact_question",
        query: "dispatch trade exact question",
    });
    const withoutReferences = JSON.parse(buildSearchRerankDocument(input).text);
    const longLabel = "proof_backed_call_path_".repeat(10);
    const withReferences = JSON.parse(buildSearchRerankDocument({
        ...input,
        structuralContext: {
            directCallers: [1, 2, 3].map((index) => ({
                repository_relative_path: `src/callers/caller-${index}.ts`,
                canonical_symbol_label: `${longLabel}${index}`,
                relation: "caller" as const,
            })),
            directCallees: [1, 2, 3].map((index) => ({
                repository_relative_path: `src/callees/callee-${index}.ts`,
                canonical_symbol_label: `${longLabel}${index}`,
                relation: "callee" as const,
            })),
            supportingTests: [1, 2].map((index) => ({
                repository_relative_path: `tests/support-${index}.test.ts`,
                canonical_symbol_label: `${longLabel}${index}`,
                relation: "test_support" as const,
            })),
        },
    }).text);
    assert.equal(
        withReferences.query_relevant_source_excerpt,
        withoutReferences.query_relevant_source_excerpt,
        "optional references must never shrink a valid source-first excerpt",
    );
});

test("canonical projection normalizes only role-valid, relation-aligned, bounded structural references", () => {
    assert.throws(
        () => buildSearchRerankDocument(baseInput({ candidateRole: "preference" })),
        /candidateRole must be a valid SearchCandidateRole/,
    );
    assert.throws(
        () => buildSearchRerankDocument(baseInput({
            structuralContext: {
                directCallers: [ref("callee", 1)],
            },
        })),
        /directCallers\[0\]\.relation must be caller/,
    );
    assert.throws(
        () => buildSearchRerankDocument(baseInput({ unexpected: true })),
        /unknown key unexpected/,
    );
    const parsed = JSON.parse(buildSearchRerankDocument(baseInput({
        structuralContext: {
            directCallers: [4, 1, 2, 3].map((index) => ref("caller", index)),
        },
    })).text);
    assert.deepEqual(
        parsed.structural_context.direct_callers.map((entry: { repository_relative_path: string }) => entry.repository_relative_path),
        ["src/ref-1.ts", "src/ref-2.ts", "src/ref-3.ts"],
        "direct callers are sorted and capped by the projection contract",
    );
});

test("canonical projection requires a trusted non-empty declaration", () => {
    assert.throws(
        () => buildSearchRerankDocument(baseInput({
            content: "",
            symbolSpan: { startLine: 1, endLine: 1 },
            symbolKind: "function",
        })),
        /inferred signatureOrDeclaration must be a non-empty string/,
    );
    assert.throws(
        () => buildSearchRerankDocument(baseInput({ signatureOrDeclaration: "" })),
        /signatureOrDeclaration must be a non-empty string/,
    );
});

test("canonical projection carries no ranking or score state", () => {
    const result = buildSearchRerankDocument(baseInput());
    for (const field of [
        "pathMultiplier",
        "changedFilesMultiplier",
        "agentFitMultiplier",
        "lexicalScore",
        "fusionScore",
        "finalScore",
        "rerankerScore",
        "authoritativeRank",
    ]) {
        assert.ok(!result.text.includes(field), `document must not leak ${field}`);
    }
});

test("missing or blank projection identity resolves to raw native document identity", () => {
    assert.equal(resolveSearchRerankDocumentProjectionIdentity(undefined), "semantic_document_raw_v1");
    assert.equal(resolveSearchRerankDocumentProjectionIdentity("   "), "semantic_document_raw_v1");
    assert.equal(
        resolveSearchRerankDocumentProjectionIdentity("semantic_document_raw_v1"),
        "semantic_document_raw_v1",
    );
});

test("retired search_rerank_document_v1 identity is rejected", () => {
    assert.throws(
        () => resolveSearchRerankDocumentProjectionIdentity("search_rerank_document_v1"),
        /search_rerank_document_projection_identity_unknown:search_rerank_document_v1/,
    );
});

test("search_rerank_document_v5 identity resolves to canonical projector identity", () => {
    assert.equal(
        resolveSearchRerankDocumentProjectionIdentity("search_rerank_document_v5"),
        "search_rerank_document_v5",
    );
});
