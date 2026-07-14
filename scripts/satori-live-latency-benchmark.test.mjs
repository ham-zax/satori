import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
    assertNoChangeSyncPayload,
    buildCurrentVsLast,
    buildCurrentVsNative,
    describeRun,
    parseArgs,
    readPreviousArtifact,
    summarizeSearch,
    writeArtifact,
} from "./satori-live-latency-benchmark.mjs";

test("live latency benchmark expands reproducible defaults", () => {
    const repoRoot = path.resolve("/tmp/satori-benchmark-repo");
    const options = parseArgs(["--repo", repoRoot, "--dry-run"]);

    assert.equal(options.mode, "comparison");
    assert.equal(options.command, process.execPath);
    assert.deepEqual(options.commandArgs, [
        path.join(repoRoot, "packages/mcp/dist/index.js"),
    ]);
    assert.equal(options.sampleCount, 3);
    assert.equal(options.settleMs, 500);
    assert.equal(
        options.outputDir,
        path.join(repoRoot, ".satori", "benchmarks", "live-latency"),
    );

    const run = describeRun(options);
    assert.equal(run.workloads.exact.query, "runExactRegistryFastPath");
    assert.equal(run.workloads.semantic.query, "where is search code behavior handled");
    assert.equal(run.workloads.outline.file, "packages/mcp/src/core/handlers.ts");
});

test("live latency benchmark preserves explicit command arguments", () => {
    const options = parseArgs([
        "--repo", "/repo",
        "--mode", "comparison",
        "--output-dir", "/benchmarks",
        "--compare-last",
        "--label", "release candidate",
        "--command", "/managed/satori-mcp",
        "--command-arg", "--stdio",
        "--samples", "5",
        "--graph-body-range", "10,20",
        "--skip-sync",
    ]);

    assert.equal(options.command, "/managed/satori-mcp");
    assert.deepEqual(options.commandArgs, ["--stdio"]);
    assert.equal(options.sampleCount, 5);
    assert.equal(options.graphBodyRange, "10,20");
    assert.equal(options.skipSync, true);
    assert.equal(options.outputDir, "/benchmarks");
    assert.equal(options.compareLast, true);
    assert.equal(options.label, "release candidate");
});

test("live latency benchmark rejects invalid modes and graph windows", () => {
    assert.throws(
        () => parseArgs(["--repo", "/repo", "--mode", "unknown"]),
        /Unsupported mode/,
    );
    assert.throws(
        () => parseArgs(["--repo", "/repo", "--graph-body-range", "10-20"]),
        /start,end integer syntax/,
    );
});

test("live latency benchmark records bounded search-quality diagnostics", () => {
    const summary = summarizeSearch({
        wallMs: 123,
        responseBytes: 456,
        payload: {
            status: "ok",
            freshnessDecision: { mode: "skipped_recent" },
            warnings: [{ code: "SOURCE_FRESHNESS_UNVERIFIED" }],
            searchPassCount: 2,
            searchPassSuccessCount: 2,
            searchPassFailureCount: 0,
            hints: {
                debugSearch: {
                    route: { kind: "conceptual" },
                    retrieval: { mode: "dense" },
                    readiness: {
                        proofMode: "warm",
                        operations: { warmReceiptRevalidations: 1 },
                    },
                    providerWork: {
                        semanticSearchAttempts: 2,
                        embeddingCallsByCurrentContract: 2,
                        denseQueriesByCurrentContract: 2,
                        sparseQueriesByCurrentContract: 0,
                        rerankerCalls: 1,
                        rerankerCandidates: 8,
                        rerankerInputBytes: 2048,
                    },
                    semanticExpansion: {
                        attempted: true,
                        expand: true,
                        reason: "primary_candidate_pool_small",
                        primaryScopedCandidateCount: 2,
                    },
                    rerank: {
                        attempted: true,
                        applied: true,
                        candidatesIn: 12,
                        candidatesReranked: 8,
                        familyCount: 6,
                        supplementalCandidates: 2,
                        candidatePoolCount: 8,
                        candidateBudget: 8,
                        budgetReason: "multi_family",
                    },
                },
            },
        },
    });

    assert.equal(summary.provider.searchPassCount, 2);
    assert.equal(summary.provider.searchPassFailureCount, 0);
    assert.equal(summary.provider.providerWork.rerankerInputBytes, 2048);
    assert.equal(
        summary.provider.semanticExpansion.reason,
        "primary_candidate_pool_small",
    );
    assert.deepEqual(summary.provider.rerank, {
        attempted: true,
        applied: true,
        candidatesIn: 12,
        candidatesReranked: 8,
        familyCount: 6,
        supplementalCandidates: 2,
        candidatePoolCount: 8,
        candidateBudget: 8,
        budgetReason: "multi_family",
    });
    assert.equal(summary.readiness.operations.warmReceiptRevalidations, 1);
});

test("live latency benchmark requires a proven no-change sync", () => {
    assert.doesNotThrow(() => assertNoChangeSyncPayload({
        status: "ok",
        syncStats: { added: 0, removed: 0, modified: 0 },
    }));
    assert.throws(
        () => assertNoChangeSyncPayload({
            status: "ok",
            syncStats: { added: 0, removed: 0, modified: 1 },
        }),
        /changed the index before measurement/,
    );
    assert.throws(
        () => assertNoChangeSyncPayload({ status: "ok" }),
        /did not return complete non-negative syncStats/,
    );
});

test("live latency benchmark stores artifacts and selects only the newest compatible prior run", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-latency-artifacts-"));
    const result = {
        satori: { semantic: { wallMs: 100, responseBytes: 50 } },
        native: { semantic: { wallMs: 10, responseBytes: 100 } },
        totals: {
            satori: { wallMs: 100, responseBytes: 50 },
            native: { wallMs: 10, responseBytes: 100 },
        },
    };
    try {
        const compatiblePath = writeArtifact(outputDir, {
            formatVersion: 1,
            benchmarkId: "satori-public-read-latency",
            recordedAt: "2026-07-14T00:00:00.000Z",
            mode: "comparison",
            workloadIdentity: "same-suite",
            result,
        }, "compatible");
        writeArtifact(outputDir, {
            formatVersion: 1,
            benchmarkId: "satori-public-read-latency",
            recordedAt: "2026-07-15T00:00:00.000Z",
            mode: "comparison",
            workloadIdentity: "different-suite",
            result,
        }, "incompatible");

        const previous = readPreviousArtifact(outputDir, "same-suite");
        assert.equal(previous?.artifactPath, compatiblePath);
        assert.equal(
            buildCurrentVsNative(result)?.workloads.semantic.wallMs.ratio,
            10,
        );
        assert.equal(
            buildCurrentVsLast("comparison", {
                ...result,
                satori: { semantic: { wallMs: 120, responseBytes: 50 } },
            }, result)?.satori.semantic.wallMs.changePercent,
            20,
        );
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
});
