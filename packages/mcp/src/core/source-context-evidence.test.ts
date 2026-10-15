import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLanguageAnalysisService, type LanguageAnalysisPort } from "@satori-code/core";
import { SourceContextEvidenceOwner } from "./source-context-evidence.js";
import type { InspectableSourceEvidence } from "./inspectable-source.js";

function evidence(source: string, relativeFile = "src/guard.ts"): InspectableSourceEvidence {
    return {
        canonicalRoot: "/repo", relativeFile, source, sourceBytes: Buffer.from(source),
        sourceByteLength: Buffer.byteLength(source),
        observedHash: createHash("sha256").update(source).digest("hex"),
        identity: { platform: "linux", stableIdentity: "fixture", canonicalRelativePath: relativeFile, strength: "target_only" },
        selectionCapabilities: { localLexical: "available", lineWindows: "available",
            syntaxBoundaries: "unavailable_streaming_source", controlFlowAnchors: "unavailable_streaming_source" },
    };
}

test("syntax context cache matches uncached analysis and invalidates on source, file, and language changes", async () => {
    const analyzer = createLanguageAnalysisService();
    let calls = 0;
    const owner = new SourceContextEvidenceOwner({ ...analyzer, analyze: async input => {
        calls += 1;
        return analyzer.analyze(input);
    } });
    const original = evidence("function settle(stale: boolean) {\n  if (stale) return;\n}");
    for (const input of [original, evidence("// 😀\n" + original.source),
        evidence(original.source, "src/other.ts")]) {
        const raw = await analyzer.analyze({ content: input.source, relativePath: input.relativeFile,
            language: "typescript", includeEarlyExitSpans: true });
        const expected = raw.earlyExitSpans?.map(({ startLine, endLine }) => ({ startLine, endLine }));
        const actual = await owner.collect(input, "typescript");
        assert.deepEqual(actual, expected);
        const before = calls;
        assert.equal(await owner.collect({ ...input }, "typescript"), actual);
        assert.equal(calls, before, "same inspected hash reuses syntax evidence");
        assert.ok(Object.isFrozen(actual));
        assert.ok(actual?.every(Object.isFrozen));
    }
    assert.equal(calls, 3);
    await owner.collect(original, "javascript");
    assert.equal(calls, 4, "language is part of the analysis witness");
    assert.equal(await owner.collect(original, "python"), undefined);
    assert.equal(calls, 4, "unsupported context languages retain the existing source selector");
});

test("concurrent context requests await one analysis and a failed analysis is not cached", async () => {
    const analyzer = createLanguageAnalysisService();
    let finish!: (value: Awaited<ReturnType<LanguageAnalysisPort["analyze"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<LanguageAnalysisPort["analyze"]>>>(resolve => { finish = resolve; });
    let calls = 0;
    const owner = new SourceContextEvidenceOwner({ ...analyzer, analyze: async () => { calls += 1; return pending; } });
    const input = evidence("function settle(stale: boolean) { if (stale) return; }");
    const first = owner.collect(input, "typescript");
    const second = owner.collect(input, "typescript");
    assert.equal(calls, 1);
    finish(await analyzer.analyze({ content: input.source, language: "typescript",
        relativePath: input.relativeFile, includeEarlyExitSpans: true }));
    assert.deepEqual(await first, await second);

    let attempts = 0;
    const failing = new SourceContextEvidenceOwner({ ...analyzer, analyze: async arg => {
        if (++attempts === 1) throw new Error("injected analysis failure");
        return analyzer.analyze(arg);
    } });
    assert.deepEqual(await Promise.all([
        failing.collect(input, "typescript"),
        failing.collect(input, "typescript"),
    ]), [undefined, undefined]);
    assert.ok(await failing.collect(input, "typescript"));
    assert.equal(attempts, 2);
});

test("a failed analysis does not clear another file's pending cache entry", async () => {
    const analyzer = createLanguageAnalysisService();
    const rejectors: Array<(error: Error) => void> = [];
    const owner = new SourceContextEvidenceOwner({ ...analyzer,
        analyze: async () => new Promise((_resolve, reject) => { rejectors.push(reject); }) });
    const source = "function settle() { if (stale) return; }";
    const first = owner.collect(evidence(source, "src/first.ts"), "typescript");
    const secondInput = evidence(source, "src/second.ts");
    const second = owner.collect(secondInput, "typescript");
    rejectors[0](new Error("first analysis failure"));
    assert.equal(await first, undefined);
    const cachedSecond = owner.collect(secondInput, "typescript");
    assert.equal(rejectors.length, 2, "the older failure preserves the newer pending analysis");
    rejectors[1](new Error("second analysis failure"));
    assert.deepEqual(await Promise.all([second, cachedSecond]), [undefined, undefined]);
});

test("synchronous analysis failures also leave no failed cache entry", async () => {
    const analyzer = createLanguageAnalysisService();
    const input = evidence("function settle() { if (stale) return; }");
    let attempts = 0;
    const owner = new SourceContextEvidenceOwner({ ...analyzer, analyze: arg => {
        if (++attempts === 1) throw new Error("injected synchronous analysis failure");
        return analyzer.analyze(arg);
    } });
    assert.equal(await owner.collect(input, "typescript"), undefined);
    assert.ok(await owner.collect(input, "typescript"));
    assert.equal(attempts, 2);
});
