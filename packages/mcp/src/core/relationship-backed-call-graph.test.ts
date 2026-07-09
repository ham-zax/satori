import test from "node:test";
import assert from "node:assert/strict";
import {
    collapseRegistryDuplicateKeyWarnings,
    isTestOrFixtureCallerFile,
    prioritizeInboundSuppressedNotes,
    uniqueInboundCallerSiteFile,
} from "./relationship-backed-call-graph.js";
import type { CallGraphNote } from "./call-graph.js";

test("collapseRegistryDuplicateKeyWarnings collapses duplicate keys to count + top samples", () => {
    const warnings = [
        "Duplicate symbolKey 'zeta' has 2 candidates",
        "Duplicate symbolKey 'alpha' has 3 candidates",
        "RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1",
        "Duplicate symbolKey 'beta' has 2 candidates",
        "Duplicate symbolKey 'gamma' has 4 candidates",
    ];

    const collapsed = collapseRegistryDuplicateKeyWarnings(warnings);
    assert.deepEqual(
        collapsed.filter((warning) => warning.includes("Duplicate symbolKey")),
        [],
    );
    const summary = collapsed.find((warning) => warning.startsWith("DUPLICATE_SYMBOL_KEY:"));
    assert.equal(summary, "DUPLICATE_SYMBOL_KEY:4 sample=alpha,beta,gamma");
    assert.ok(collapsed.includes("RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1"));
});

test("collapseRegistryDuplicateKeyWarnings is stable under localeCompare poison", () => {
    const warnings = [
        "Duplicate symbolKey 'b' has 2 candidates",
        "Duplicate symbolKey 'a' has 2 candidates",
        "Duplicate symbolKey 'c' has 2 candidates",
    ];
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = function patchedLocaleCompare(this: string): number {
        // Reverse order to poison any remaining localeCompare-based sort.
        return -original.call(this, arguments[0] as string);
    };
    try {
        const first = collapseRegistryDuplicateKeyWarnings(warnings);
        const second = collapseRegistryDuplicateKeyWarnings([...warnings].reverse());
        assert.equal(first[0], "DUPLICATE_SYMBOL_KEY:3 sample=a,b,c");
        assert.equal(second[0], "DUPLICATE_SYMBOL_KEY:3 sample=a,b,c");
    } finally {
        String.prototype.localeCompare = original;
    }
});

test("collapseRegistryDuplicateKeyWarnings leaves non-duplicate warnings alone", () => {
    assert.deepEqual(
        collapseRegistryDuplicateKeyWarnings(["SOURCE_BACKED_DYNAMIC_CALLEES:2"]),
        ["SOURCE_BACKED_DYNAMIC_CALLEES:2"],
    );
    assert.deepEqual(collapseRegistryDuplicateKeyWarnings([]), []);
});

test("uniqueInboundCallerSiteFile returns sole suppressed caller site, else undefined", () => {
    const one: CallGraphNote[] = [{
        type: "suppressed_edge",
        file: "src/caller.ts",
        startLine: 10,
        detail: "Suppressed low-confidence caller candidate function run() at src/caller.ts:10.",
    }];
    assert.equal(uniqueInboundCallerSiteFile(one), "src/caller.ts");

    const multi: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "src/a.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate function a() at src/a.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/b.ts",
            startLine: 2,
            detail: "Suppressed low-confidence caller candidate function b() at src/b.ts:2.",
        },
    ];
    assert.equal(uniqueInboundCallerSiteFile(multi), undefined);

    const mixedProdAndTest: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "src/core/gate.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate async function <anonymous>() at src/core/gate.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/core/handlers.ts",
            startLine: 20,
            detail: "Suppressed low-confidence caller candidate method run() at src/core/handlers.ts:20.",
        },
        {
            type: "suppressed_edge",
            file: "src/core/gate.spec.ts",
            startLine: 5,
            detail: "Suppressed low-confidence caller candidate function now() at src/core/gate.spec.ts:5.",
        },
    ];
    assert.equal(uniqueInboundCallerSiteFile(mixedProdAndTest), "src/core/handlers.ts");
});

test("isTestOrFixtureCallerFile detects test and fixture paths", () => {
    assert.equal(isTestOrFixtureCallerFile("packages/mcp/src/core/runtime-owner.test.ts"), true);
    assert.equal(isTestOrFixtureCallerFile("packages/mcp/src/core/runtime-owner.ts"), false);
    assert.equal(isTestOrFixtureCallerFile("fixtures/navigation/go-basic-symbols/svc.go"), true);
});

test("prioritizeInboundSuppressedNotes puts production callers first and collapses excess tests", () => {
    const notes: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "a.test.ts",
            detail: "Suppressed low-confidence caller candidate t1 at a.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "b.test.ts",
            detail: "Suppressed low-confidence caller candidate t2 at b.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "c.test.ts",
            detail: "Suppressed low-confidence caller candidate t3 at c.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "d.test.ts",
            detail: "Suppressed low-confidence caller candidate t4 at d.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/prod.ts",
            detail: "Suppressed low-confidence caller candidate method run() at src/prod.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/other.ts",
            detail: "Suppressed low-confidence callee candidate x at src/other.ts:1.",
        },
    ];
    const prioritized = prioritizeInboundSuppressedNotes(notes);
    assert.equal(prioritized[0]?.file, "src/prod.ts");
    const testDetailed = prioritized.filter((n) => n.file && isTestOrFixtureCallerFile(n.file));
    assert.equal(testDetailed.length, 3);
    assert.ok(prioritized.some((n) => typeof n.detail === "string" && n.detail.includes("additional low-confidence test/fixture")));
    assert.ok(prioritized.some((n) => n.detail?.includes("callee candidate")));
});

test("uniqueInboundCallerSiteFile ignores callee-only suppressed notes", () => {
    const calleeOnly: CallGraphNote[] = [{
        type: "suppressed_edge",
        file: "src/callee.ts",
        startLine: 5,
        detail: "Suppressed low-confidence callee candidate function helper() at src/callee.ts:5.",
    }];
    assert.equal(uniqueInboundCallerSiteFile(calleeOnly), undefined);
});
