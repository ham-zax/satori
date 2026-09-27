import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveSearchRerankDocumentProjectionIdentity,
} from "./search-rerank-document-routing.js";

test("missing projection identity resolves to the raw native document identity", () => {
    assert.equal(
        resolveSearchRerankDocumentProjectionIdentity(undefined),
        "semantic_document_raw_v1",
    );
});

test("blank projection identity resolves to the raw native document identity", () => {
    assert.equal(
        resolveSearchRerankDocumentProjectionIdentity("   "),
        "semantic_document_raw_v1",
    );
});

test("explicit semantic_document_raw_v1 identity resolves to the raw native document identity", () => {
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

test("search_rerank_document_v4 identity resolves to the canonical projector identity", () => {
    assert.equal(
        resolveSearchRerankDocumentProjectionIdentity("search_rerank_document_v4"),
        "search_rerank_document_v4",
    );
});
