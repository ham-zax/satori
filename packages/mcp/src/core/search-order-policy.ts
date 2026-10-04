export const SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID = "search_native_retrieval_order_v1";
export const SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID = "search_native_reranker_order_v2";
export const SEARCH_DEFINITION_DISCOVERY_ORDER_POLICY_ID = "search_definition_discovery_order_v1";

export type SearchOrderAuthority = "retrieval_order" | "reranker_order" | "definition_fusion_order";

export function resolveSearchRankingPolicyIdentity(input: {
    orderAuthority: SearchOrderAuthority;
}): string {
    if (input.orderAuthority === "definition_fusion_order") return SEARCH_DEFINITION_DISCOVERY_ORDER_POLICY_ID;
    return input.orderAuthority === "reranker_order"
        ? SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID
        : SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID;
}
