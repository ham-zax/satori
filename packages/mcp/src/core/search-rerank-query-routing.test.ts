import assert from "node:assert/strict";
import test from "node:test";
import { resolveSearchRerankQuery } from "./search-rerank-query-routing.js";

const RAW_QUERY = "how does Shariah compliance checking block trades";
const FOCUSED_V2 = "Question:\nhow does Shariah compliance checking block trades\n\nRequested answer type:\nproduction implementation, control flow, and integration path";

test("missing projection identity receives the raw semantic query exactly", () => {
    const resolved = resolveSearchRerankQuery({
        semanticQuery: RAW_QUERY,
        projectionIdentity: undefined,
    });
    assert.equal(resolved.query, RAW_QUERY);
    assert.equal(resolved.queryProjectionIdentity, "semantic_query_raw_v1");
});

test("blank projection identity receives the raw semantic query exactly", () => {
    const resolved = resolveSearchRerankQuery({
        semanticQuery: RAW_QUERY,
        projectionIdentity: "   ",
    });
    assert.equal(resolved.query, RAW_QUERY);
    assert.equal(resolved.queryProjectionIdentity, "semantic_query_raw_v1");
});

test("explicit semantic_query_raw_v1 identity receives the raw semantic query exactly", () => {
    const resolved = resolveSearchRerankQuery({
        semanticQuery: RAW_QUERY,
        projectionIdentity: "semantic_query_raw_v1",
    });
    assert.equal(resolved.query, RAW_QUERY);
    assert.equal(resolved.queryProjectionIdentity, "semantic_query_raw_v1");
});

test("retired search_rerank_query_v1 identity is rejected", () => {
    assert.throws(
        () => resolveSearchRerankQuery({
            semanticQuery: RAW_QUERY,
            projectionIdentity: "search_rerank_query_v1",
        }),
        /search_rerank_query_projection_identity_unknown:search_rerank_query_v1/,
    );
});

test("search_rerank_query_v2 identity receives focused query v2 bytes", () => {
    const resolved = resolveSearchRerankQuery({
        semanticQuery: RAW_QUERY,
        focusedQueryV2: FOCUSED_V2,
        projectionIdentity: "search_rerank_query_v2",
    });
    assert.equal(resolved.query, FOCUSED_V2);
    assert.equal(resolved.queryProjectionIdentity, "search_rerank_query_v2");
});

test("search_rerank_query_v2 identity fails closed when the v2 projection is unavailable", () => {
    assert.throws(
        () => resolveSearchRerankQuery({
            semanticQuery: RAW_QUERY,
            projectionIdentity: "search_rerank_query_v2",
        }),
        /search_rerank_query_v2_projection_unavailable/,
    );
});
