import test from "node:test";
import assert from "node:assert/strict";
import { isTestOrFixturePath } from "@zokizuan/satori-core";
import {
    prioritizeInboundSuppressedNotes,
    uniqueInboundCallerSiteFile,
} from "./relationship-backed-call-graph.js";
import type { CallGraphNote } from "./call-graph.js";

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

test("isTestOrFixturePath detects test and fixture paths", () => {
    assert.equal(isTestOrFixturePath("packages/mcp/src/core/runtime-owner.test.ts"), true);
    assert.equal(isTestOrFixturePath("packages/mcp/src/core/runtime-owner.ts"), false);
    assert.equal(isTestOrFixturePath("fixtures/navigation/go-basic-symbols/svc.go"), true);
});

test("prioritizeInboundSuppressedNotes puts production callers first and collapses excess tests", () => {
    const notes: CallGraphNote[] = [
        {
            type: "suppressed_edge",
            file: "a.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t1 at a.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "b.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t2 at b.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "c.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t3 at c.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "d.test.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate t4 at d.test.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/prod.ts",
            startLine: 1,
            detail: "Suppressed low-confidence caller candidate method run() at src/prod.ts:1.",
        },
        {
            type: "suppressed_edge",
            file: "src/other.ts",
            startLine: 1,
            detail: "Suppressed low-confidence callee candidate x at src/other.ts:1.",
        },
    ];
    const prioritized = prioritizeInboundSuppressedNotes(notes);
    assert.equal(prioritized[0]?.file, "src/prod.ts");
    const testDetailed = prioritized.filter((n) => n.file && isTestOrFixturePath(n.file));
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
