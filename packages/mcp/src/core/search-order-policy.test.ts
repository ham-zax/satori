import assert from "node:assert/strict";
import test from "node:test";
import {
    SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID,
    SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID,
    SEARCH_DEFINITION_DISCOVERY_ORDER_POLICY_ID,
    resolveSearchRankingPolicyIdentity,
} from "./search-order-policy.js";

test("ranking policy identity distinguishes retrieval and provider order", () => {
    assert.equal(
        resolveSearchRankingPolicyIdentity({
            orderAuthority: "retrieval_order",
        }),
        SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID,
    );
    assert.equal(
        resolveSearchRankingPolicyIdentity({
            orderAuthority: "reranker_order",
        }),
        SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID,
    );
});

test("definition fusion has its own frozen ranking identity", () => {
    assert.equal(resolveSearchRankingPolicyIdentity({ orderAuthority: "definition_fusion_order" }), SEARCH_DEFINITION_DISCOVERY_ORDER_POLICY_ID);
});
