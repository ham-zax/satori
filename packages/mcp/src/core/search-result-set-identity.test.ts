import assert from "node:assert/strict";
import test from "node:test";
import {
    buildSearchRankedSetBinding,
    verifySearchRankedSetBinding,
    type SearchRankedSetBindingInput,
} from "./search-result-set-identity.js";
import { SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID } from "./search-order-policy.js";

function input(): SearchRankedSetBindingInput {
    return {
        queryPolicyDigest: "a".repeat(64),
        rankingPolicyIdentity: SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID,
        disclosurePolicyVersion: "search_disclosure_v1",
        publicationIdentity: {
            publicationId: "publication-1",
            collectionName: "repo-generation",
            policyHash: "b".repeat(64),
            navigation: { status: "bound" },
        },
        rerankerIdentity: {
            kind: "provider",
            provider: "lateon",
            model: "lightonai/LateOn-Code-edge@revision-1",
            profile: "e".repeat(64),
        },
        rerankerProjectionIdentity: "search_rerank_document_v1",
        rerankerRequestIdentity: {
            provider: "lateon",
            model: "lightonai/LateOn-Code-edge@revision-1",
            profile: "e".repeat(64),
            queryProjectionIdentity: "search_rerank_query_v1",
            documentProjectionIdentity: "search_rerank_document_v1",
            requestContractSha256: "f".repeat(64),
        },
        orderedResults: [{
            target: {
                file: "src/owner.ts",
                span: { startLine: 10, endLine: 20 },
                symbolId: "owner-symbol",
            },
            displayLabel: "owner",
            language: "typescript",
            symbolKind: "function",
            quality: { owner: "high", semantic: "high" },
            evidenceChunks: 2,
            preview: "export function owner() {}",
            evidenceSpan: { startLine: 12, endLine: 14 },
            navigation: {
                graph: "ready",
                inbound: "verify",
                callerSearchTerm: "owner",
            },
            debug: {
                representativeChunkCount: 2,
                pathCategory: "srcRuntime",
                pathMultiplier: 1.1,
                topChunkScore: 0.7,
                lexicalScore: 0.2,
                exactLexicalMatch: false,
            },
        }, {
            target: {
                file: "src/helper.ts",
                span: { startLine: 1, endLine: 4 },
            },
            displayLabel: "src/helper.ts",
            language: "typescript",
            quality: { owner: "low", semantic: "medium" },
            preview: "export const helper = true;",
            navigation: { graph: "missing_symbol" },
        }],
        recommendedActions: [{
            tool: "read_file",
            args: {
                path: "/repo/src/owner.ts",
                open_symbol: { contractVersion: 2, symbolId: "owner-symbol" },
            },
            reason: "Read the canonical owner.",
        }, null],
    };
}

function withMutation(
    mutate: (value: SearchRankedSetBindingInput) => SearchRankedSetBindingInput,
): SearchRankedSetBindingInput {
    return mutate(structuredClone(input()));
}

test("ranked-set binding is canonical across equivalent object key order", () => {
    const baseline = buildSearchRankedSetBinding(input());
    const reordered = withMutation((value) => ({
        ...value,
        publicationIdentity: {
            navigation: { status: "bound" },
            policyHash: "b".repeat(64),
            collectionName: "repo-generation",
            publicationId: "publication-1",
        },
    }));

    assert.deepEqual(buildSearchRankedSetBinding(reordered), baseline);
    assert.match(baseline.rankedSetDigest, /^[a-f0-9]{64}$/);
    assert.equal(baseline.orderedGroups.length, 2);
    assert.equal(verifySearchRankedSetBinding(baseline, reordered), true);
});

test("ranked-set digest binds every pageable group field and complete order", () => {
    const baseline = buildSearchRankedSetBinding(input()).rankedSetDigest;
    const variants = [
        withMutation((value) => {
            value.orderedResults[0]!.target.file = "src/other.ts";
            return value;
        }),
        withMutation((value) => {
            value.orderedResults[0]!.evidenceSpan = { startLine: 13, endLine: 14 };
            return value;
        }),
        withMutation((value) => {
            value.orderedResults[0]!.navigation = { graph: "missing_relationship_navigation" };
            return value;
        }),
        withMutation((value) => ({
            ...value,
            recommendedActions: value.recommendedActions.map((action, index) => (
                index === 0 && action ? { ...action, reason: "Different action." } : action
            )),
        })),
        withMutation((value) => ({
            ...value,
            orderedResults: [...value.orderedResults].reverse(),
            recommendedActions: [...value.recommendedActions].reverse(),
        })),
    ];

    for (const variant of variants) {
        assert.notEqual(buildSearchRankedSetBinding(variant).rankedSetDigest, baseline);
    }
});

test("ranked-set digest binds publication, policies, model, and projection", () => {
    const baseline = buildSearchRankedSetBinding(input()).rankedSetDigest;
    const variants = [
        withMutation((value) => ({
            ...value,
            publicationIdentity: { ...value.publicationIdentity, collectionName: "other" },
        })),
        withMutation((value) => ({ ...value, queryPolicyDigest: "f".repeat(64) })),
        withMutation((value) => ({ ...value, rankingPolicyIdentity: "ranking-v2" })),
        withMutation((value) => ({ ...value, disclosurePolicyVersion: "disclosure-v2" })),
        withMutation((value) => ({
            ...value,
            rerankerIdentity: { ...value.rerankerIdentity, model: "other-model" },
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                model: "other-model",
            },
        })),
        withMutation((value) => ({
            ...value,
            rerankerProjectionIdentity: "projection-v2",
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                documentProjectionIdentity: "projection-v2",
            },
        })),
    ];

    for (const variant of variants) {
        const binding = buildSearchRankedSetBinding(variant);
        assert.notEqual(binding.rankedSetDigest, baseline);
        assert.equal(verifySearchRankedSetBinding(binding, input()), false);
    }
});

test("ranked-set binding rejects unpaired result and action sequences", () => {
    assert.throws(() => buildSearchRankedSetBinding({
        ...input(),
        recommendedActions: [],
    }), /paired/);
});

test("ranked-set binding rejects incomplete publication authority", () => {
    assert.throws(() => buildSearchRankedSetBinding({
        ...input(),
        publicationIdentity: {
            ...input().publicationIdentity,
            publicationId: "",
        },
    }), /publication identity must be complete/);
    assert.throws(() => buildSearchRankedSetBinding({
        ...input(),
        rerankerIdentity: {
            kind: "provider",
            provider: "lateon",
            model: "",
            profile: "e".repeat(64),
        },
    }), /reranker model identity must be non-empty/);
});

test("ranked-set digest binds the complete rerank request identity", () => {
    const baseline = buildSearchRankedSetBinding(input()).rankedSetDigest;
    const variants = [
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                queryProjectionIdentity: "search_rerank_query_v2",
            },
        })),
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                requestContractSha256: "0".repeat(64),
            },
        })),
        withMutation((value) => ({
            ...value,
            rerankerProjectionIdentity: "semantic_document_raw_v1",
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                documentProjectionIdentity: "semantic_document_raw_v1",
            },
        })),
    ];

    for (const variant of variants) {
        const binding = buildSearchRankedSetBinding(variant);
        assert.notEqual(binding.rankedSetDigest, baseline);
        assert.equal(verifySearchRankedSetBinding(binding, input()), false);
    }
});

test("applied reranking requires a complete request identity; baselines reject one", () => {
    assert.throws(() => buildSearchRankedSetBinding(
        withMutation((value) => ({ ...value, rerankerRequestIdentity: null })),
    ), /requires a complete rerank request identity/);
    assert.throws(() => buildSearchRankedSetBinding(
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                requestContractSha256: "",
            },
        })),
    ), /rerank request contract digest identity must be non-empty/);
    assert.throws(() => buildSearchRankedSetBinding(
        withMutation((value) => ({
            ...value,
            rerankerIdentity: { kind: "deterministic_baseline", policy: "B" },
        })),
    ), /must not carry a rerank request identity/);
});

test("ranked-set binding rejects contradictory duplicated reranker identities", () => {
    for (const variant of [
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: { ...value.rerankerRequestIdentity!, provider: "other" },
        })),
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: { ...value.rerankerRequestIdentity!, model: "other-model" },
        })),
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: { ...value.rerankerRequestIdentity!, profile: "other-profile" },
        })),
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                documentProjectionIdentity: "semantic_document_raw_v1",
            },
        })),
        withMutation((value) => ({
            ...value,
            rerankerRequestIdentity: {
                ...value.rerankerRequestIdentity!,
                requestContractSha256: "not-a-sha256",
            },
        })),
    ]) {
        assert.throws(
            () => buildSearchRankedSetBinding(variant),
            /rerank request.*must match|contract digest must be a SHA-256/,
        );
    }
});
