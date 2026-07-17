import assert from "node:assert/strict";
import test from "node:test";

import {
    assertNoEvaluationAuthorityResults,
    assertMeasuredReadiness,
    extractReadinessDiagnostics,
    normalizeResultIdentities,
    resultIdentityKey,
} from "./satori-useful-context-record.mjs";

function searchTask(invocations = 1) {
    return {
        id: "hybrid-install-preflight-owner",
        workload: {
            invocations: Array.from({ length: invocations }, (_, index) => (
                index === 0
                    ? {
                        tool: "search_codebase",
                        args: { path: "/repo", query: "owner", debugMode: "full" },
                    }
                    : {
                        tool: "read_file",
                        args: { path: "/repo/src/owner.ts" },
                    }
            )),
        },
    };
}

function coldReadiness(overrides = {}) {
    return {
        proofMode: "cold",
        invalidationReason: "cache_miss",
        ...overrides,
        operations: {
            preparedCacheLookups: 1,
            preparedCacheHits: 0,
            coldReadinessChecks: 1,
            postFreshnessColdChecks: 0,
            warmReceiptRevalidations: 0,
            exactPayloadRecounts: 1,
            registryLoads: 1,
            navigationValidationRuns: 1,
            ...(overrides.operations || {}),
        },
    };
}

function warmReadiness(overrides = {}) {
    return {
        proofMode: "warm",
        invalidationReason: "none",
        ...overrides,
        operations: {
            preparedCacheLookups: 1,
            preparedCacheHits: 1,
            coldReadinessChecks: 0,
            postFreshnessColdChecks: 0,
            warmReceiptRevalidations: 1,
            exactPayloadRecounts: 0,
            registryLoads: 0,
            navigationValidationRuns: 0,
            ...(overrides.operations || {}),
        },
    };
}

test("result identity keys preserve path and symbol tuple boundaries", () => {
    const pathContainsSeparator = resultIdentityKey({ kind: "symbol", file: "src/a#b.ts", symbol: "c" });
    const symbolContainsSeparator = resultIdentityKey({ kind: "symbol", file: "src/a.ts", symbol: "b#c" });
    const fileIdentity = resultIdentityKey({ kind: "file", file: "src/a.ts" });
    const symbolIdentity = resultIdentityKey({ kind: "symbol", file: "src/a.ts", symbol: "ts" });

    assert.notEqual(pathContainsSeparator, symbolContainsSeparator);
    assert.notEqual(fileIdentity, symbolIdentity);
    assert.equal(pathContainsSeparator, JSON.stringify(["symbol", "src/a#b.ts", "c"]));
    assert.throws(() => resultIdentityKey({ kind: "symbol", file: "src/a.ts" }), /tagged file or symbol/);
    assert.throws(
        () => resultIdentityKey({ kind: "file", file: "src/a.ts", symbol: "ts" }),
        /tagged file or symbol/,
    );
});

test("file-level display labels remain file identities", () => {
    const task = { expected: { ownerSymbol: "handleOwner" } };
    assert.deepEqual(normalizeResultIdentities({
        results: [{
            target: { file: "src/config.ts", span: { startLine: 1, endLine: 4 } },
            displayLabel: "file src/config.ts:1",
        }],
    }, task, "/repo"), [{ kind: "file", file: "src/config.ts" }]);

    assert.deepEqual(normalizeResultIdentities({
        results: [{ file: "src/owner.ts", symbolLabel: "function handleOwner()" }],
    }, task, "/repo"), [{ kind: "symbol", file: "src/owner.ts", symbol: "handleOwner" }]);
});

test("evaluation-authority results fail closed without post-filtering", () => {
    assert.throws(() => assertNoEvaluationAuthorityResults(
        [{ kind: "file", file: "evals/tasks.json" }],
        new Set(["evals/tasks.json"]),
        "owner-task",
    ), /retrieved evaluation-authority artifact.*create a clean publication/i);
});

test("extractReadinessDiagnostics accepts cold and warm proofs", () => {
    const cold = extractReadinessDiagnostics({
        hints: { debugSearch: { readiness: coldReadiness() } },
    });
    const warm = extractReadinessDiagnostics({
        hints: { debugSearch: { readiness: warmReadiness() } },
    });
    assert.equal(cold.proofMode, "cold");
    assert.equal(warm.proofMode, "warm");
    assert.equal(extractReadinessDiagnostics({}), null);
});

test("assertMeasuredReadiness accepts valid cold and warm proofs", () => {
    const task = searchTask();
    const invocation = task.workload.invocations[0];
    assert.doesNotThrow(() => assertMeasuredReadiness(task, "cold", invocation, coldReadiness()));
    assert.doesNotThrow(() => assertMeasuredReadiness(task, "warm", invocation, warmReadiness(), {
        sample: 1,
        invocationIndex: 0,
    }));
});

test("assertMeasuredReadiness reports every failed warm predicate with context", () => {
    const task = searchTask(2);
    const invocation = task.workload.invocations[0];
    let error;
    try {
        assertMeasuredReadiness(task, "warm", invocation, warmReadiness({
            proofMode: "cold",
            invalidationReason: "cache_miss",
            operations: {
                preparedCacheHits: 0,
                warmReceiptRevalidations: 0,
                exactPayloadRecounts: 1,
            },
        }), { sample: 1, invocationIndex: 0 });
    } catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /warm search did not prove receipt revalidation without a payload recount/);
    assert.match(error.message, /proofMode===warm/);
    assert.match(error.message, /preparedCacheHits>=1/);
    assert.match(error.message, /warmReceiptRevalidations>=1/);
    assert.match(error.message, /exactPayloadRecounts===0/);
    assert.match(error.message, /"sample":1/);
    assert.match(error.message, /"nextTool":"read_file"/);
});

test("assertMeasuredReadiness fails closed when readiness is missing", () => {
    const task = searchTask();
    const invocation = task.workload.invocations[0];
    assert.throws(
        () => assertMeasuredReadiness(task, "warm", invocation, null, { sample: 1 }),
        /no structured readiness diagnostics/,
    );
});

test("warm failure context names the prior cold-phase tool when present", () => {
    // Documents the multi-invocation cold→warm sequence the simple probe skips.
    // hybrid-install-preflight-owner currently has only search_codebase, so this
    // is regression coverage for suites that do interleave tools.
    const task = searchTask(2);
    const search = task.workload.invocations[0];
    assert.throws(
        () => assertMeasuredReadiness(task, "warm", search, warmReadiness({
            operations: { exactPayloadRecounts: 1 },
        }), { sample: 1, invocationIndex: 0 }),
        /"nextTool":"read_file"/,
    );
});
