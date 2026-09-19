export const SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID = "search_native_retrieval_order_v1";
export const SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID = "search_native_reranker_order_v2";

export type SearchOrderAuthority = "retrieval_order" | "reranker_order";

export function resolveSearchRankingPolicyIdentity(input: {
    orderAuthority: SearchOrderAuthority;
}): string {
    return input.orderAuthority === "reranker_order"
        ? SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID
        : SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID;
}
