import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    collectDisclosureVariant,
    compareVariants,
    summarizeOperations,
    validateTaskManifest,
} from "./disclosure-pilot.mjs";

function toolResult(payload) {
    return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: {
            ...payload,
            ...(payload.continuation
                ? {
                    continuation: {
                        ...payload.continuation,
                        handle: "b".repeat(48),
                    },
                }
                : {}),
        },
    };
}

function result(file, symbolId, preview) {
    return {
        target: { file, symbolId, span: { startLine: 1, endLine: 2 } },
        displayLabel: `method ${symbolId}`,
        preview,
    };
}

test("mechanical disclosure comparison reconstructs one ranked set and retries exactly", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-disclosure-pilot-"));
    const traceFile = path.join(directory, "trace.jsonl");
    fs.writeFileSync(traceFile, "");
    const ranked = [
        result("one.ts", "one", "one"),
        result("two.ts", "two", "two"),
        result("three.ts", "three", "three"),
    ];
    let continuationCalls = 0;
    const session = {
        async callTool(tool, args) {
            if (tool === "search_codebase") {
                fs.appendFileSync(traceFile, `${JSON.stringify({ operation: "lexical_retrieval" })}\n`);
                if (args.disclosureLimit === 1) {
                    return toolResult({
                        status: "ok",
                        results: ranked.slice(0, 1),
                        continuation: { handle: "a".repeat(48), nextOffset: 1, remainingGroupCount: 2 },
                    });
                }
                return toolResult({ status: "ok", results: ranked });
            }
            assert.equal(tool, "continue_search");
            assert.equal(args.handle, "a".repeat(48));
            assert.equal(args.expectedOffset, 1);
            continuationCalls += 1;
            return toolResult({ status: "ok", results: ranked.slice(1) });
        },
    };
    const common = {
        session,
        traceFile,
        continuationLimit: 3,
        expected: { file: "three.ts", symbolId: "three" },
    };
    const current = await collectDisclosureVariant({
        ...common,
        name: "current",
        searchArgs: { query: "q", limit: 3 },
        requireExactRetry: false,
    });
    const smaller = await collectDisclosureVariant({
        ...common,
        name: "smaller",
        searchArgs: { query: "q", limit: 3, disclosureLimit: 1 },
        requireExactRetry: true,
    });
    const comparison = compareVariants(current, smaller);
    assert.equal(comparison.sameRankedResultSet, true);
    assert.equal(smaller.expectedEvidence.presentInitially, false);
    assert.equal(smaller.expectedEvidence.reached, true);
    assert.equal(smaller.exactRetry.identicalSerializedPage, true);
    assert.equal(continuationCalls, 2);
});

test("mechanical comparison rejects ranked-set drift", () => {
    assert.throws(() => compareVariants(
        {
            groupIdentityDigest: "a",
            rankedResultSetDigest: "a",
            initialResponseBytes: 100,
        },
        {
            groupIdentityDigest: "b",
            rankedResultSetDigest: "b",
            initialResponseBytes: 50,
            expectedEvidence: { reached: true, presentInitially: false },
            continuationPageCount: 1,
            exactRetry: { identicalSerializedPage: true },
        },
    ), /same frozen ranked result set/);
});

test("task authority must be external and explicitly unsealed", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "satori-disclosure-source-"));
    const file = path.join(source, "task.json");
    fs.writeFileSync(file, "{}");
    assert.throws(() => validateTaskManifest({
        schemaVersion: 1,
        kind: "satori_phase3_disclosure_mechanical_pilot",
        sealed: false,
        qualificationEvidence: false,
        baseGitRevision: "1".repeat(40),
        __file: file,
        task: { id: "one", query: "q", expectedEvidence: { file: "a", symbolId: "b" } },
        search: { limit: 3 },
        currentDisclosure: { disclosureLimit: null },
        smallerDisclosure: { disclosureLimit: 1 },
    }, source), /outside the indexed source corpus/);
});

test("operation accounting separates provider work from mutation attempts", () => {
    assert.deepEqual(summarizeOperations([
        { operation: "query_embedding" },
        { operation: "document_embedding", itemCount: 2 },
        { operation: "reranker", candidateCount: 3, documentUtf8Bytes: 120 },
    ]), {
        counts: { query_embedding: 1, document_embedding: 1, reranker: 1 },
        documentEmbeddingItems: 2,
        rerankerCandidates: 3,
        rerankerDocumentUtf8Bytes: 120,
    });
});
