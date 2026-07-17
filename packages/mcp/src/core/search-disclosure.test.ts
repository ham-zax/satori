import assert from "node:assert/strict";
import test from "node:test";
import { projectGroupedDisclosure } from "./search-disclosure.js";
import type {
    SearchDisclosureSummary,
    SearchGroupResult,
    SearchGroupedResponseEnvelope,
} from "./search-types.js";

function result(index: number, preview = `result ${index}`): SearchGroupResult {
    return {
        target: {
            file: `src/result-${index}.ts`,
            span: { startLine: index + 1, endLine: index + 2 },
        },
        displayLabel: `file src/result-${index}.ts:${index + 1}`,
        language: "typescript",
        score: 1 - index / 100,
        quality: { owner: "low", semantic: "medium" },
        preview,
        navigation: { graph: "unsupported_language" },
        __groupId: `group-${index}`,
        __symbolKey: `symbol-${index}`,
        __exactLexicalMatch: false,
    };
}

function buildEnvelope(
    results: readonly SearchGroupResult[],
    disclosure?: SearchDisclosureSummary,
): SearchGroupedResponseEnvelope {
    return {
        formatVersion: 2,
        status: "ok",
        path: "/repo",
        codebaseRoot: "/repo",
        query: "find owner",
        scope: "runtime",
        groupBy: "symbol",
        limit: 10,
        resultMode: "grouped",
        freshnessDecision: { mode: "skipped_recent", checkedAt: "2026-01-01T00:00:00.000Z", thresholdMs: 1 },
        ...(disclosure ? { disclosure } : {}),
        results: results.map((entry) => ({
            target: entry.target,
            displayLabel: entry.displayLabel,
            language: entry.language,
            score: entry.score,
            quality: entry.quality,
            preview: entry.preview,
            navigation: { graph: "unsupported_language" },
        })),
    };
}

test("grouped disclosure preserves the unannotated baseline when no boundary applies", () => {
    const projected = projectGroupedDisclosure({
        orderedResults: [result(0), result(1)],
        callerLimit: 10,
        disclosureLimit: 10,
        maxResponseBytes: 10_000,
        includeSummary: false,
        buildEnvelope,
    });

    assert.equal(projected.envelope.disclosure, undefined);
    assert.equal(projected.results.length, 2);
    assert.equal(projected.responseBytes, Buffer.byteLength(JSON.stringify(projected.envelope), "utf8"));
});

test("grouped disclosure reports an explicit smaller initial budget", () => {
    const projected = projectGroupedDisclosure({
        orderedResults: [result(0), result(1), result(2)],
        callerLimit: 3,
        disclosureLimit: 1,
        maxResponseBytes: 10_000,
        includeSummary: true,
        buildEnvelope,
    });

    assert.deepEqual(projected.envelope.disclosure, {
        policyVersion: "search_disclosure_v1",
        availableGroupCount: 3,
        returnedGroupCount: 1,
        omittedGroupCount: 2,
        truncated: true,
        reasons: ["initial_budget"],
    });
});

test("grouped disclosure distinguishes the caller limit from the initial page budget", () => {
    const projection = projectGroupedDisclosure({
        orderedResults: [result(0), result(1), result(2)],
        callerLimit: 2,
        disclosureLimit: 2,
        maxResponseBytes: 4_096,
        includeSummary: true,
        buildEnvelope,
    });

    assert.equal(projection.results.length, 2);
    assert.equal(projection.results.every((entry) => Number.isFinite(entry.score)), true);
    assert.deepEqual(projection.envelope.disclosure, {
        policyVersion: "search_disclosure_v1",
        availableGroupCount: 3,
        returnedGroupCount: 2,
        omittedGroupCount: 1,
        truncated: true,
        reasons: ["caller_limit"],
    });
});

test("grouped disclosure truncates only the first preview at a UTF-8-safe boundary", () => {
    const oversized = result(0, "🙂".repeat(200));
    const truncatedSummary: SearchDisclosureSummary = {
        policyVersion: "search_disclosure_v1",
        availableGroupCount: 1,
        returnedGroupCount: 1,
        omittedGroupCount: 0,
        truncated: true,
        reasons: ["utf8_byte_budget", "group_content_truncated"],
    };
    const fixedOverhead = Buffer.byteLength(JSON.stringify(buildEnvelope([{
        ...oversized,
        preview: "",
    }], truncatedSummary)), "utf8");
    const maxResponseBytes = fixedOverhead + 31;
    const projected = projectGroupedDisclosure({
        orderedResults: [oversized],
        callerLimit: 1,
        disclosureLimit: 1,
        maxResponseBytes,
        includeSummary: true,
        buildEnvelope,
    });

    assert.equal(projected.results.length, 1);
    assert.equal(Buffer.from(projected.results[0]!.preview, "utf8").toString("utf8"), projected.results[0]!.preview);
    assert.equal(projected.responseBytes <= maxResponseBytes, true);
    assert.deepEqual(projected.envelope.disclosure?.reasons, [
        "utf8_byte_budget",
        "group_content_truncated",
    ]);
});

test("grouped disclosure refuses to drop the authority envelope to satisfy a budget", () => {
    assert.throws(() => projectGroupedDisclosure({
        orderedResults: [],
        callerLimit: 1,
        disclosureLimit: 1,
        maxResponseBytes: 10,
        includeSummary: true,
        buildEnvelope,
    }), /authority envelope/);
});
