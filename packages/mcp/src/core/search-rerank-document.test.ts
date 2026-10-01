import assert from "node:assert/strict";
import test from "node:test";
import {
    buildSearchRerankDocument,
    SEARCH_RERANK_DOCUMENT_POLICY,
} from "./search-rerank-document.js";
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

test("canonical projection encodes the source once across budget attempts", (t) => {
    const original = Buffer.from;
    let encodings = 0;
    t.mock.method(Buffer, "from", (...args: Parameters<typeof Buffer.from>) => {
        if (args[0] === CONTENT) encodings++;
        return Reflect.apply(original, Buffer, args);
    });
    const result = buildSearchRerankDocument(baseInput());
    assert.ok(result.selectionAttemptCount > 1);
    assert.equal(encodings, 1);
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
    assert.deepEqual(SEARCH_RERANK_DOCUMENT_POLICY.fieldSetDecision, {
        language: "intentionally_omitted_v1",
        documentationExcerpt: "intentionally_removed_v1",
        requiredOwnerSiblings: "superseded_by_structural_context_v1",
    });
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
