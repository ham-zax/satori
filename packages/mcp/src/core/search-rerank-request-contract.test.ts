import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { Reranker } from "@satori-code/core";
import { SEARCH_CANDIDATE_ROLES } from "./search-rerank-context.js";
import {
    SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY,
    buildSearchRerankRequestContractFixtures,
    buildSearchRerankRequestContractManifest,
    computeSearchRerankRequestContractSha256,
    loadSearchRerankRequestContract,
    parseSearchRerankRequestContract,
    resolveSearchRerankRequestContractAssetPath,
    resolveSearchRerankRequestIdentity,
} from "./search-rerank-request-contract.js";

function fakeReranker(overrides: Partial<Reranker> = {}): Reranker {
    return {
        getIdentity: () => ({ provider: "lateon", model: "LateOn-Code-edge", profile: "lateon_offline_quality_projection_v3_d32_v1" }),
        rerank: async () => [],
        ...overrides,
    };
}

test("committed rerank request contract matches runtime fixture recomputation", () => {
    const manifest = loadSearchRerankRequestContract();
    const recomputed = buildSearchRerankRequestContractManifest();
    assert.equal(manifest.contractSha256, recomputed.contractSha256);
    assert.deepEqual(manifest.fixtures, recomputed.fixtures);
    assert.equal(manifest.contractSha256, computeSearchRerankRequestContractSha256(manifest.fixtures));
});

test("request contract fixtures bind focus, query, role, and document projection behavior", () => {
    const fixtures = buildSearchRerankRequestContractFixtures();
    assert.equal(
        fixtures.answerFocusResolution["how does Shariah compliance checking block trades"],
        "implementation",
    );
    assert.equal(
        fixtures.queryProjectionV2.implementation,
        [
            "Question:",
            "how does Shariah compliance checking block trades",
            "",
            "Requested answer type:",
            "production implementation, control flow, and integration path",
        ].join("\n"),
    );
    assert.equal(
        fixtures.queryProjectionV2.implementation?.toLowerCase().includes("test"),
        false,
        "contract fixture must keep the implementation projection positive-only",
    );
    assert.equal(fixtures.candidateRoleClassification["tests/veto.test.ts|typescript"], "test");
    assert.deepEqual(
        [...new Set(Object.values(fixtures.candidateRoleClassification))].sort(),
        [...SEARCH_CANDIDATE_ROLES].sort(),
        "every runtime candidate role must be behaviorally bound",
    );
    assert.ok(fixtures.documentProjectionV4.includes('"candidate_role":"implementation"'));
    assert.ok(
        fixtures.documentProjectionV4.includes(
            '"structural_context":{"direct_callees":[],"direct_callers":[],"supporting_tests":[]}',
        ),
        "v4 fixture must carry the empty answer-packet structural context",
    );
    assert.ok(fixtures.documentProjectionV4Structural.includes('"TradingCore.__init__"'));
    assert.ok(fixtures.documentProjectionV4Structural.includes('"relation":"test_support"'));
    assert.ok(fixtures.documentProjectionV4SourceFirst.includes('validate_order_for_exact_question'));
    assert.ok(fixtures.sourceSelectionPolicyIdentity.includes("search_rerank_document_v4"));
    assert.ok(fixtures.sourceSelectionPolicyIdentity.includes("bounded_source_selection_v2"));
    assert.ok(fixtures.sourceSelectionPolicyIdentity.includes("source_before_references_v1"));
    assert.equal(
        fixtures.structuralContext.callAdmission,
        "high_confidence_or_proof_backed_authoritative_call_v1",
    );
    assert.deepEqual(fixtures.structuralContext.proofBackedAuthorities, ["direct_binding", "origin_flow"]);
    assert.equal(fixtures.structuralContext.exactInstanceIdentityRequired, true);
    assert.equal(fixtures.structuralContext.maxDirectCallers, 3);
    assert.equal(fixtures.structuralContext.maxDirectCallees, 3);
    assert.equal(fixtures.structuralContext.maxSupportingTests, 2);
    assert.equal(fixtures.structuralContext.referenceSourceText, false);
    assert.deepEqual(fixtures.structuralContextBehavior.lowConfidenceAdmission, {
        directCallers: [{
            repository_relative_path: "src/core/trading_core.ts",
            canonical_symbol_label: "method TradingCore.__init__",
            relation: "caller",
        }],
        directCallees: [],
        supportingTests: [],
    });
    assert.deepEqual(fixtures.partialProjectionSemantics.warnings, [
        "RERANKER_INPUT_DEGRADED",
        "RERANKER_SKIPPED_INPUT",
        "RERANKER_FAILED",
    ]);
    assert.equal(fixtures.partialProjectionSemantics.minimumProjectedCandidatesForProviderCall, 2);
    assert.deepEqual(fixtures.partialProjectionBehavior.providerCallByProjectedCandidateCount, {
        zero: false,
        one: false,
        two: true,
    });
    assert.deepEqual(
        fixtures.partialProjectionBehavior.failedCandidateSlotPreservation.finalOrder,
        ["d", "b", "c", "a"],
    );
    assert.deepEqual(fixtures.partialProjectionBehavior.byteBudgetOmission, {
        selectedCandidateIds: ["a", "b"],
        inputBytes: 7,
        omittedCandidateCount: 1,
    });
    assert.deepEqual(fixtures.partialProjectionBehavior.candidateAdmission.providerCapacityBound, {
        selectedCandidateIds: Array.from({ length: 32 }, (_, index) => `candidate-${index + 1}`),
        budget: 32,
        reason: "provider_limit",
    });
    assert.deepEqual(fixtures.partialProjectionBehavior.candidateAdmission.globalCapacityBound, {
        selectedCandidateIds: Array.from({ length: 50 }, (_, index) => `candidate-${index + 1}`),
        budget: 50,
        reason: "global_limit",
    });
    assert.deepEqual(fixtures.partialProjectionBehavior.candidateAdmission.invalidProviderCapacity, {
        selectedCandidateIds: Array.from({ length: 12 }, (_, index) => `candidate-${index + 1}`),
        budget: 12,
        reason: "family_ambiguity",
    });
});

test("any fixture behavior change moves the request contract digest", () => {
    const baseline = buildSearchRerankRequestContractFixtures();
    const mutatedQuery = {
        ...baseline,
        queryProjectionV2: { ...baseline.queryProjectionV2, implementation: `${baseline.queryProjectionV2.implementation}\nextra` },
    };
    const mutatedRole = {
        ...baseline,
        candidateRoleClassification: { ...baseline.candidateRoleClassification, "tests/veto.test.ts|typescript": "implementation" },
    };
    const mutatedDocument = { ...baseline, documentProjectionV4: `${baseline.documentProjectionV4}x` };
    const mutatedV4Structural = {
        ...baseline,
        documentProjectionV4Structural: `${baseline.documentProjectionV4Structural}x`,
    };
    const mutatedStructuralBehavior = {
        ...baseline,
        structuralContextBehavior: {
            lowConfidenceAdmission: {
                ...baseline.structuralContextBehavior.lowConfidenceAdmission,
                directCallers: [],
            },
        },
    };
    const mutatedPartialBehavior = {
        ...baseline,
        partialProjectionBehavior: {
            ...baseline.partialProjectionBehavior,
            providerCallByProjectedCandidateCount: {
                ...baseline.partialProjectionBehavior.providerCallByProjectedCandidateCount,
                one: true,
            },
        },
    };
    const baselineDigest = computeSearchRerankRequestContractSha256(baseline);
    assert.notEqual(computeSearchRerankRequestContractSha256(mutatedQuery), baselineDigest);
    assert.notEqual(computeSearchRerankRequestContractSha256(mutatedRole), baselineDigest);
    assert.notEqual(computeSearchRerankRequestContractSha256(mutatedDocument), baselineDigest);
    assert.notEqual(computeSearchRerankRequestContractSha256(mutatedV4Structural), baselineDigest);
    assert.notEqual(computeSearchRerankRequestContractSha256(mutatedStructuralBehavior), baselineDigest);
    assert.notEqual(computeSearchRerankRequestContractSha256(mutatedPartialBehavior), baselineDigest);
});

test("contract parser rejects malformed and drifted manifests", () => {
    const manifest = buildSearchRerankRequestContractManifest();
    assert.throws(() => parseSearchRerankRequestContract({ ...manifest, extraKey: 1 }), /unexpected keys/);
    assert.throws(() => parseSearchRerankRequestContract({ ...manifest, schemaVersion: "other" }), /unsupported/);
    assert.throws(
        () => parseSearchRerankRequestContract({ ...manifest, contractSha256: "f".repeat(64) }),
        /does not match/,
    );
    const driftedStructuralContext = {
        ...manifest.fixtures.structuralContext,
        maxDirectCallers: 9,
    } as unknown as typeof SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY;
    assert.throws(
        () => parseSearchRerankRequestContract({
            ...manifest,
            fixtures: { ...manifest.fixtures, structuralContext: driftedStructuralContext },
            contractSha256: computeSearchRerankRequestContractSha256({
                ...manifest.fixtures,
                structuralContext: driftedStructuralContext,
            }),
        }),
        /drifted from the runtime policy/,
    );
    const driftedBehavior = {
        lowConfidenceAdmission: {
            ...manifest.fixtures.structuralContextBehavior.lowConfidenceAdmission,
            directCallers: [],
        },
    };
    assert.throws(
        () => parseSearchRerankRequestContract({
            ...manifest,
            fixtures: { ...manifest.fixtures, structuralContextBehavior: driftedBehavior },
            contractSha256: computeSearchRerankRequestContractSha256({
                ...manifest.fixtures,
                structuralContextBehavior: driftedBehavior,
            }),
        }),
        /behavior drifted from runtime owners/,
    );
});

test("resolveSearchRerankRequestIdentity binds current provider projections and the contract digest", () => {
    const identity = resolveSearchRerankRequestIdentity(fakeReranker({
        getQueryProjectionVersion: () => "search_rerank_query_v2",
        getDocumentProjectionVersion: () => "search_rerank_document_v4",
    }));
    assert.deepEqual(
        { provider: identity.provider, model: identity.model, profile: identity.profile },
        { provider: "lateon", model: "LateOn-Code-edge", profile: "lateon_offline_quality_projection_v3_d32_v1" },
    );
    assert.equal(identity.queryProjectionIdentity, "search_rerank_query_v2");
    assert.equal(identity.documentProjectionIdentity, "search_rerank_document_v4");
    assert.equal(identity.requestContractSha256, loadSearchRerankRequestContract().contractSha256);
});

test("resolveSearchRerankRequestIdentity fails closed on retired document projection identities", () => {
    assert.throws(
        () => resolveSearchRerankRequestIdentity(fakeReranker({
            getDocumentProjectionVersion: () => "search_rerank_document_v3",
        })),
        /search_rerank_document_projection_identity_unknown:search_rerank_document_v3/,
    );
});

test("providers without advertised projections fall back to raw identities", () => {
    const identity = resolveSearchRerankRequestIdentity(fakeReranker());
    assert.equal(identity.queryProjectionIdentity, "semantic_query_raw_v1");
    assert.equal(identity.documentProjectionIdentity, "semantic_document_raw_v1");
});

test("contract asset round-trips through disk", () => {
    const raw = JSON.parse(fs.readFileSync(resolveSearchRerankRequestContractAssetPath(), "utf8"));
    const parsed = parseSearchRerankRequestContract(raw);
    assert.equal(parsed.contractSha256, loadSearchRerankRequestContract().contractSha256);
});
