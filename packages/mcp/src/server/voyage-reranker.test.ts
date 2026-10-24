import assert from "node:assert/strict";
import test from "node:test";
import { VoyageAIReranker } from "@satori-code/core";
import { SEARCH_RERANK_DOCUMENT_POLICY } from "../core/search-rerank-document.js";
import { SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from "../core/search-rerank-query.js";
import { VoyageProjectionReranker } from "./voyage-reranker.js";

test("Voyage advertises the canonical rerank projections", () => {
    const reranker = new VoyageProjectionReranker(new VoyageAIReranker({
        apiKey: "test-voyage-key",
        model: "rerank-3-lite",
    }));
    assert.deepEqual(reranker.getIdentity(), {
        provider: "voyage",
        model: "rerank-3-lite",
        profile: "voyage_reranker_api_v1",
    });
    assert.equal(reranker.getDocumentProjectionVersion(), SEARCH_RERANK_DOCUMENT_POLICY.id);
    assert.equal(reranker.getQueryProjectionVersion(), SEARCH_RERANK_QUERY_PROJECTION_IDENTITY);
});
