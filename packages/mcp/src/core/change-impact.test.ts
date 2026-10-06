import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
    CallGraphEdgeResult,
    CallGraphNodeResult,
    CallGraphResponseEnvelope,
    FileOutlineResponseEnvelope,
} from "./search-types.js";
import { detectChangeImpact } from "./change-impact.js";

function node(symbolId: string, file: string): CallGraphNodeResult {
    return {
        symbolId,
        symbolLabel: `function ${symbolId}()`,
        file,
        language: "typescript",
        span: { startLine: 1, endLine: 4 },
    };
}

test("detect_changes distinguishes seed/direct/transitive impact and retains causal paths", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-f2-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        fs.mkdirSync(path.join(repo, "packages/core/src"), { recursive: true });
        fs.writeFileSync(path.join(repo, "packages/core/src/seed.ts"), "export function seed() {\n  return 1;\n}\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "packages/core/src/seed.ts"), "export function seed() {\n  return 2;\n}\n");

        const seed = node("seed", "packages/core/src/seed.ts");
        const direct = node("direct", "packages/core/src/direct.ts");
        const transitive = node("transitive", "packages/app/src/transitive.ts");
        const result = await detectChangeImpact({
            path: repo,
            baseRef: "HEAD",
            depth: 3,
            limit: 20,
        }, {
            outline: async () => ({
                status: "ok",
                path: repo,
                file: seed.file,
                outline: {
                    symbols: [{
                        symbolId: seed.symbolId,
                        symbolLabel: seed.symbolLabel!,
                        kind: "function",
                        language: seed.language,
                        file: seed.file,
                        span: seed.span,
                    }],
                },
                hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async () => ({
                status: "ok",
                path: repo,
                symbolRef: { file: seed.file, symbolId: seed.symbolId },
                supported: true,
                direction: "callers",
                depth: 3,
                limit: 20,
                nodes: [seed, direct, transitive],
                edges: [{
                    srcSymbolId: direct.symbolId,
                    dstSymbolId: seed.symbolId,
                    kind: "call",
                    site: { file: direct.file, startLine: 2 },
                    confidence: 1,
                    resolutionAuthority: "direct_binding",
                }, {
                    srcSymbolId: transitive.symbolId,
                    dstSymbolId: direct.symbolId,
                    kind: "call",
                    site: { file: transitive.file, startLine: 2 },
                    confidence: 1,
                    resolutionAuthority: "direct_binding",
                }],
                notes: [],
                exactReferences: [{
                    relationship: "caller",
                    matchKind: "candidate_target",
                    decision: "ambiguous",
                    resolutionAuthority: "origin_flow",
                    construct: "typed_member_call",
                    providerId: "fixture",
                    providerVersion: "1",
                    sourceSymbolId: "uncertain",
                    sourceSymbolLabel: "function uncertain()",
                    calleeName: "seed",
                    calleeText: "service.seed()",
                    site: { file: "packages/other/src/uncertain.ts", startLine: 7, endLine: 7 },
                    candidates: [],
                }],
            } as unknown as CallGraphResponseEnvelope),
        });

        assert.equal(result.seeds[0]?.impactClass, "seed");
        assert.equal(result.seeds[0]?.distance, 0);
        assert.deepEqual(result.impacted.map((item) => [item.symbolId, item.impactClass, item.evidenceClass, item.distance]), [
            ["direct", "direct", "proof_backed", 1],
            ["transitive", "transitive", "proof_backed", 2],
        ]);
        assert.deepEqual(result.impacted[1]?.causalPath.map((edge) => [
            edge.callerSymbolId,
            edge.calleeSymbolId,
            edge.strategy,
            edge.confidence,
            edge.resolutionAuthority,
        ]), [
            ["direct", "seed", "rule", 1, "direct_binding"],
            ["transitive", "direct", "rule", 1, "direct_binding"],
        ]);
        assert.equal(result.uncertainCallReferences.length, 1);
        assert.equal(result.impacted.some((item) => item.symbolId === "uncertain"), false);
        assert.ok(result.areaImpact.some((row) => (
            row.area === "packages/core"
            && row.seedCount === 1
            && row.directCount === 1
            && row.proofBackedDirectCount === 1
            && row.heuristicDirectCount === 0
        )));
        assert.ok(result.areaImpact.some((row) => (
            row.area === "packages/app"
            && row.transitiveCount === 1
            && row.proofBackedTransitiveCount === 1
            && row.heuristicTransitiveCount === 0
        )));
        assert.ok(result.completeness.reasons.includes("depth_bound"));
        assert.ok(result.completeness.reasons.includes("uncertain_references"));
        assert.equal(result.completeness.exhaustive, false);
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test("detect_changes separates proof-backed and heuristic impact and deterministically prefers proof at equal distance", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-r3-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        fs.mkdirSync(path.join(repo, "packages/core/src"), { recursive: true });
        fs.writeFileSync(path.join(repo, "packages/core/src/seed.ts"), "export function seed() {\n  return 1;\n}\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "packages/core/src/seed.ts"), "export function seed() {\n  return 2;\n}\n");

        const seed = node("seed", "packages/core/src/seed.ts");
        const heuristicDirect = node("a-heuristic-direct", "packages/heuristic/src/direct.ts");
        const proofDirect = node("z-proof-direct", "packages/proof/src/direct.ts");
        const heuristicTransitive = node("heuristic-transitive", "packages/heuristic/src/transitive.ts");
        const proofTransitive = node("proof-transitive", "packages/proof/src/transitive.ts");
        const mixed = node("mixed", "packages/mixed/src/mixed.ts");
        const mixedUpstream = node("mixed-upstream", "packages/mixed/src/upstream.ts");
        const edges: CallGraphEdgeResult[] = [{
            srcSymbolId: heuristicDirect.symbolId,
            dstSymbolId: seed.symbolId,
            kind: "call",
            site: { file: heuristicDirect.file, startLine: 2 },
            strategy: "heuristic",
            confidence: 0.95,
        }, {
            srcSymbolId: proofDirect.symbolId,
            dstSymbolId: seed.symbolId,
            kind: "call",
            site: { file: proofDirect.file, startLine: 2 },
            strategy: "rule",
            confidence: 1,
            resolutionAuthority: "direct_binding",
        }, {
            srcSymbolId: heuristicTransitive.symbolId,
            dstSymbolId: heuristicDirect.symbolId,
            kind: "call",
            site: { file: heuristicTransitive.file, startLine: 3 },
            strategy: "heuristic",
            confidence: 0.9,
        }, {
            srcSymbolId: proofTransitive.symbolId,
            dstSymbolId: proofDirect.symbolId,
            kind: "call",
            site: { file: proofTransitive.file, startLine: 3 },
            strategy: "rule",
            confidence: 0.9,
            resolutionAuthority: "origin_flow",
        }, {
            srcSymbolId: mixed.symbolId,
            dstSymbolId: heuristicDirect.symbolId,
            kind: "call",
            site: { file: mixed.file, startLine: 4 },
            strategy: "heuristic",
            confidence: 0.88,
        }, {
            srcSymbolId: mixed.symbolId,
            dstSymbolId: proofDirect.symbolId,
            kind: "call",
            site: { file: mixed.file, startLine: 5 },
            strategy: "rule",
            confidence: 0.99,
            resolutionAuthority: "direct_binding",
        }, {
            srcSymbolId: mixedUpstream.symbolId,
            dstSymbolId: mixed.symbolId,
            kind: "call",
            site: { file: mixedUpstream.file, startLine: 6 },
            strategy: "rule",
            confidence: 1,
            resolutionAuthority: "direct_binding",
        }];
        const runImpact = async (graphEdges: CallGraphEdgeResult[]) => detectChangeImpact({
            path: repo,
            baseRef: "HEAD",
            depth: 3,
            limit: 20,
        }, {
            outline: async () => ({
                status: "ok",
                path: repo,
                file: seed.file,
                outline: {
                    symbols: [{
                        symbolId: seed.symbolId,
                        symbolLabel: seed.symbolLabel!,
                        kind: "function",
                        language: seed.language,
                        file: seed.file,
                        span: seed.span,
                    }],
                },
                hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async () => ({
                status: "ok",
                path: repo,
                symbolRef: { file: seed.file, symbolId: seed.symbolId },
                supported: true,
                direction: "callers",
                depth: 3,
                limit: 20,
                nodes: [seed, heuristicDirect, proofDirect, heuristicTransitive, proofTransitive, mixed, mixedUpstream],
                edges: graphEdges,
                notes: [],
                exactReferences: [{
                    relationship: "caller",
                    matchKind: "candidate_target",
                    decision: "ambiguous",
                    resolutionAuthority: "ambiguous",
                    construct: "typed_member_call",
                    providerId: "fixture",
                    providerVersion: "1",
                    sourceSymbolId: "uncertain",
                    sourceSymbolLabel: "function uncertain()",
                    calleeName: "seed",
                    calleeText: "service.seed()",
                    site: { file: "packages/uncertain/src/caller.ts", startLine: 7, endLine: 7 },
                    candidates: [],
                }],
            } as unknown as CallGraphResponseEnvelope),
        });
        const result = await runImpact(edges);
        const reversedResult = await runImpact([...edges].reverse());

        const byId = new Map(result.impacted.map((item) => [item.symbolId, item]));
        assert.equal(byId.get(proofDirect.symbolId)?.evidenceClass, "proof_backed");
        assert.equal(byId.get(heuristicDirect.symbolId)?.evidenceClass, "heuristic");
        assert.equal(byId.get(proofTransitive.symbolId)?.evidenceClass, "proof_backed");
        assert.equal(byId.get(heuristicTransitive.symbolId)?.evidenceClass, "heuristic");

        const proofPath = byId.get(proofTransitive.symbolId)?.causalPath ?? [];
        assert.deepEqual(proofPath.map((edge) => [edge.strategy, edge.confidence, edge.resolutionAuthority]), [
            ["rule", 1, "direct_binding"],
            ["rule", 0.9, "origin_flow"],
        ]);
        const heuristicPath = byId.get(heuristicTransitive.symbolId)?.causalPath ?? [];
        assert.deepEqual(heuristicPath.map((edge) => [edge.strategy, edge.confidence, edge.resolutionAuthority]), [
            ["heuristic", 0.95, undefined],
            ["heuristic", 0.9, undefined],
        ]);

        const mixedImpact = byId.get(mixed.symbolId);
        assert.equal(mixedImpact?.distance, 2);
        assert.equal(mixedImpact?.evidenceClass, "proof_backed");
        assert.deepEqual(mixedImpact?.causalPath.map((edge) => edge.calleeSymbolId), [
            seed.symbolId,
            proofDirect.symbolId,
        ]);
        const mixedUpstreamImpact = byId.get(mixedUpstream.symbolId);
        assert.equal(mixedUpstreamImpact?.distance, 3);
        assert.equal(mixedUpstreamImpact?.evidenceClass, "proof_backed");
        assert.deepEqual(mixedUpstreamImpact?.causalPath.map((edge) => edge.calleeSymbolId), [
            seed.symbolId,
            proofDirect.symbolId,
            mixed.symbolId,
        ]);
        const reversedMixedUpstream = reversedResult.impacted.find((item) => item.symbolId === mixedUpstream.symbolId);
        assert.equal(reversedMixedUpstream?.evidenceClass, "proof_backed");
        assert.deepEqual(reversedMixedUpstream?.causalPath, mixedUpstreamImpact?.causalPath);

        const proofArea = result.areaImpact.find((row) => row.area === "packages/proof");
        assert.equal(proofArea?.proofBackedDirectCount, 1);
        assert.equal(proofArea?.proofBackedTransitiveCount, 1);
        assert.equal(proofArea?.heuristicDirectCount, 0);
        assert.equal(proofArea?.heuristicTransitiveCount, 0);
        const heuristicArea = result.areaImpact.find((row) => row.area === "packages/heuristic");
        assert.equal(heuristicArea?.heuristicDirectCount, 1);
        assert.equal(heuristicArea?.heuristicTransitiveCount, 1);
        assert.equal(heuristicArea?.proofBackedDirectCount, 0);
        assert.equal(heuristicArea?.proofBackedTransitiveCount, 0);

        assert.ok(result.warnings.includes("IMPACT_HEURISTIC_CALL_PATHS"));
        assert.ok(result.completeness.reasons.includes("heuristic_relationship_paths"));
        assert.equal(result.completeness.heuristicImpactCount, 2);
        assert.equal(result.uncertainCallReferences.length, 1);
        assert.equal(result.impacted.some((item) => item.symbolId === "uncertain"), false);
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test("detect_changes sums per-seed count warnings into one entry per code", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-warnings-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "seed.ts"), "export function a() {\n  return 1;\n}\nexport function b() {\n  return 1;\n}\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "seed.ts"), "export function a() {\n  return 2;\n}\nexport function b() {\n  return 2;\n}\n");

        const seeds = [
            { ...node("a", "seed.ts"), span: { startLine: 1, endLine: 3 } },
            { ...node("b", "seed.ts"), span: { startLine: 4, endLine: 6 } },
        ];
        const counts: Record<string, number> = { a: 3, b: 4 };
        const result = await detectChangeImpact({ path: repo, baseRef: "HEAD", depth: 1, limit: 20 }, {
            outline: async () => ({
                status: "ok",
                path: repo,
                file: "seed.ts",
                outline: {
                    symbols: seeds.map((seed) => ({
                        symbolId: seed.symbolId,
                        symbolLabel: seed.symbolLabel!,
                        kind: "function",
                        language: seed.language,
                        file: seed.file,
                        span: seed.span,
                    })),
                },
                hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async (_root, symbol) => ({
                status: "ok",
                path: repo,
                symbolRef: { file: symbol.file, symbolId: symbol.symbolId },
                supported: true,
                direction: "callers",
                depth: 1,
                limit: 20,
                nodes: [symbol],
                edges: [],
                notes: [],
                warnings: [`CALL_GRAPH_OBSERVATIONAL_SOURCE_REFERENCES:${counts[symbol.symbolId]}`, "SHARED_WARNING"],
            } as unknown as CallGraphResponseEnvelope),
        });

        assert.equal(result.seeds.length, 2);
        assert.deepEqual(
            result.warnings.filter((warning) => warning.startsWith("CALL_GRAPH_OBSERVATIONAL_SOURCE_REFERENCES")),
            ["CALL_GRAPH_OBSERVATIONAL_SOURCE_REFERENCES:7"],
        );
        assert.ok(result.warnings.includes("SHARED_WARNING"));
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test("detect_changes seeds only the innermost edited member and ignores an import-only hunk when other hunks are precise", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-innermost-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        const base = "import x from \"./x\";\nexport class Outer {\n  a() {\n    return 1;\n  }\n  b() {\n    return 2;\n  }\n}\nexport function other() {\n  return 3;\n}\n";
        fs.writeFileSync(path.join(repo, "seed.ts"), base);
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "seed.ts"), base.replace("./x", "./y").replace("return 1;", "return 10;"));

        const symbols = [
            { symbolId: "Outer", symbolLabel: "class Outer", kind: "class", language: "typescript", file: "seed.ts", span: { startLine: 2, endLine: 9 } },
            { symbolId: "a", symbolLabel: "method a()", kind: "method", language: "typescript", file: "seed.ts", span: { startLine: 3, endLine: 5 } },
            { symbolId: "b", symbolLabel: "method b()", kind: "method", language: "typescript", file: "seed.ts", span: { startLine: 6, endLine: 8 } },
            { symbolId: "other", symbolLabel: "function other()", kind: "function", language: "typescript", file: "seed.ts", span: { startLine: 10, endLine: 12 } },
        ];
        const result = await detectChangeImpact({ path: repo, baseRef: "HEAD", depth: 1, limit: 20 }, {
            outline: async () => ({
                status: "ok", path: repo, file: "seed.ts", outline: { symbols }, hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async (_root, symbol) => ({
                status: "ok", path: repo, symbolRef: { file: symbol.file, symbolId: symbol.symbolId }, supported: true,
                direction: "callers", depth: 1, limit: 20,
                nodes: [{ symbolId: symbol.symbolId, symbolLabel: symbol.symbolLabel ?? symbol.symbolId, file: symbol.file,
                    language: symbol.language ?? "typescript", span: symbol.span }],
                edges: [], notes: [], exactReferences: [],
            } as unknown as CallGraphResponseEnvelope),
        });

        assert.deepEqual(result.seeds.map((seed) => seed.symbolId), ["a"]);
        assert.ok(!result.warnings.includes("IMPACT_FILE_LEVEL_SEEDS"));
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test("detect_changes seeds a pure-deletion hunk with only the containing function", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-deletion-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        const base = "export function keep() {\n  return 1;\n}\nexport function target() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
        fs.writeFileSync(path.join(repo, "seed.ts"), base);
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "seed.ts"), base.replace("  const b = 2;\n", ""));

        const symbols = [
            { symbolId: "keep", symbolLabel: "function keep()", kind: "function", language: "typescript", file: "seed.ts", span: { startLine: 1, endLine: 3 } },
            { symbolId: "target", symbolLabel: "function target()", kind: "function", language: "typescript", file: "seed.ts", span: { startLine: 4, endLine: 8 } },
        ];
        const result = await detectChangeImpact({ path: repo, baseRef: "HEAD", depth: 1, limit: 20 }, {
            outline: async () => ({
                status: "ok",
                path: repo,
                file: "seed.ts",
                outline: { symbols },
                hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async (_root, symbol) => ({
                status: "ok",
                path: repo,
                symbolRef: { file: symbol.file, symbolId: symbol.symbolId },
                supported: true,
                direction: "callers",
                depth: 1,
                limit: 20,
                nodes: [{
                    symbolId: symbol.symbolId,
                    symbolLabel: symbol.symbolLabel ?? `function ${symbol.symbolId}()`,
                    file: symbol.file,
                    language: symbol.language ?? "typescript",
                    span: symbol.span,
                }],
                edges: [],
                notes: [],
                exactReferences: [],
            } as unknown as CallGraphResponseEnvelope),
        });

        assert.deepEqual(result.seeds.map((seed) => seed.symbolId), ["target"]);
        assert.ok(!result.warnings.includes("IMPACT_FILE_LEVEL_SEEDS"));
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test("detect_changes allocates seeds fairly across files and reports omitted seeds", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-fair-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        const baseLines = Array.from({ length: 180 }, (_, index) => `const x${index} = ${index};`);
        fs.writeFileSync(path.join(repo, "a.ts"), `${baseLines.join("\n")}\n`);
        fs.writeFileSync(path.join(repo, "b.ts"), "export function g() {\n  return 1;\n}\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "a.ts"), `${baseLines.map((line) => `${line} // changed`).join("\n")}\n`);
        fs.writeFileSync(path.join(repo, "b.ts"), "export function g() {\n  return 2;\n}\n");

        const symbolsA = Array.from({ length: 60 }, (_, index) => ({
            symbolId: `f${index}`,
            symbolLabel: `function f${index}()`,
            kind: "function",
            language: "typescript",
            file: "a.ts",
            span: { startLine: 3 * index + 1, endLine: 3 * index + 3 },
        }));
        const symbolB = {
            symbolId: "g",
            symbolLabel: "function g()",
            kind: "function",
            language: "typescript",
            file: "b.ts",
            span: { startLine: 1, endLine: 3 },
        };
        const result = await detectChangeImpact({ path: repo, baseRef: "HEAD", depth: 1, limit: 20 }, {
            outline: async (file: string) => ({
                status: "ok",
                path: repo,
                file,
                outline: { symbols: file === "a.ts" ? symbolsA : [symbolB] },
                hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async (_root, symbol) => ({
                status: "ok",
                path: repo,
                symbolRef: { file: symbol.file, symbolId: symbol.symbolId },
                supported: true,
                direction: "callers",
                depth: 1,
                limit: 20,
                nodes: [{
                    symbolId: symbol.symbolId,
                    symbolLabel: symbol.symbolLabel ?? `function ${symbol.symbolId}()`,
                    file: symbol.file,
                    language: symbol.language ?? "typescript",
                    span: symbol.span,
                }],
                edges: [],
                notes: [],
                exactReferences: [],
            } as unknown as CallGraphResponseEnvelope),
        });

        assert.equal(result.seeds.length, 50);
        assert.ok(result.seeds.some((seed) => seed.symbolId === "g"));
        assert.equal(result.seeds.filter((seed) => seed.file === "b.ts").length, 1);
        assert.deepEqual(result.seedOmittedFiles, [{ file: "a.ts", omittedSeedCount: 11 }]);
        assert.equal(result.truncated, true);
        assert.ok(result.warnings.includes("IMPACT_LIMIT_REACHED"));
        assert.ok(result.completeness.reasons.includes("seed_limit"));
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test("detect_changes trims impacted output to fit the response byte budget", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-bytes-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "seed.ts"), "export function seed() {\n  return 1;\n}\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "seed.ts"), "export function seed() {\n  return 2;\n}\n");

        const seed = node("seed", "seed.ts");
        const callerCount = 2500;
        const callers = Array.from({ length: callerCount }, (_, index) => node(
            `caller-${index}-with-a-long-suffix-to-inflate-the-response-payload-0123456789`,
            `packages/big/src/caller-${index}.ts`,
        ));
        const result = await detectChangeImpact({ path: repo, baseRef: "HEAD", depth: 1, limit: 5000 }, {
            outline: async () => ({
                status: "ok",
                path: repo,
                file: seed.file,
                outline: {
                    symbols: [{
                        symbolId: seed.symbolId,
                        symbolLabel: seed.symbolLabel!,
                        kind: "function",
                        language: seed.language,
                        file: seed.file,
                        span: seed.span,
                    }],
                },
                hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async () => ({
                status: "ok",
                path: repo,
                symbolRef: { file: seed.file, symbolId: seed.symbolId },
                supported: true,
                direction: "callers",
                depth: 1,
                limit: 5000,
                nodes: [seed, ...callers],
                edges: callers.map((caller) => ({
                    srcSymbolId: caller.symbolId,
                    dstSymbolId: seed.symbolId,
                    kind: "call",
                    site: { file: caller.file, startLine: 2 },
                    confidence: 1,
                    resolutionAuthority: "direct_binding",
                })),
                notes: [],
                exactReferences: [],
            } as unknown as CallGraphResponseEnvelope),
        });

        assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 48 * 1024);
        assert.ok(result.warnings.includes("IMPACT_RESPONSE_BYTE_LIMIT"));
        assert.equal(result.truncated, true);
        assert.ok(result.omitted.impacted > 0);
        assert.equal(result.omitted.impacted + result.impacted.length, callerCount);
        assert.equal(result.omitted.uncertainCallReferences, 0);
        assert.equal(result.areaImpact.reduce((sum, row) => sum + row.directCount, 0), callerCount);
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

type SeedFixtureSymbol = { symbolId: string; kind: string; startLine: number; endLine: number };

async function seedFixture(base: string, edited: string, symbols: SeedFixtureSymbol[], editedFile = "seed.ts") {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-hunks-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "seed.ts"), base);
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        if (editedFile !== "seed.ts") execFileSync("git", ["mv", "seed.ts", editedFile], { cwd: repo });
        fs.writeFileSync(path.join(repo, editedFile), edited);
        const outlineSymbols = symbols.map((symbol) => ({
            symbolId: symbol.symbolId, symbolLabel: symbol.symbolId, kind: symbol.kind, language: "typescript",
            file: editedFile, span: { startLine: symbol.startLine, endLine: symbol.endLine },
        }));
        return await detectChangeImpact({ path: repo, baseRef: "HEAD", depth: 1, limit: 20 }, {
            outline: async () => ({
                status: "ok", path: repo, file: editedFile, outline: { symbols: outlineSymbols }, hasMore: false,
            } as FileOutlineResponseEnvelope),
            callers: async (_root, symbol) => ({
                status: "ok", path: repo, symbolRef: { file: symbol.file, symbolId: symbol.symbolId }, supported: true,
                direction: "callers", depth: 1, limit: 20,
                nodes: [{ symbolId: symbol.symbolId, symbolLabel: symbol.symbolLabel ?? symbol.symbolId, file: symbol.file,
                    language: symbol.language ?? "typescript", span: symbol.span }],
                edges: [], notes: [], exactReferences: [],
            } as unknown as CallGraphResponseEnvelope),
        });
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
}

test("detect_changes seeds an enclosing class whose own lines change in the same hunk as a member", async () => {
    const base = "class C extends A {\n  m() {\n    return 1;\n  }\n}\n";
    const edited = "class C extends B {\n  m(): number {\n    return 2;\n  }\n}\n";
    const result = await seedFixture(base, edited, [
        { symbolId: "C", kind: "class", startLine: 1, endLine: 5 },
        { symbolId: "m", kind: "method", startLine: 2, endLine: 4 },
    ]);
    assert.deepEqual(result.seeds.map((seed) => seed.symbolId), ["C", "m"]);
});

test("detect_changes does not blame a deleted whole symbol on its neighbour and discloses the unmapped hunk", async () => {
    const base = "export function f() {\n  return 1;\n}\nexport function gone() {\n  return 2;\n}\nexport function h() {\n  return 3;\n}\n";
    const edited = "export function f() {\n  return 1;\n}\nexport function h() {\n  return 30;\n}\n";
    const result = await seedFixture(base, edited, [
        { symbolId: "f", kind: "function", startLine: 1, endLine: 3 },
        { symbolId: "h", kind: "function", startLine: 4, endLine: 6 },
    ]);
    assert.deepEqual(result.seeds.map((seed) => seed.symbolId), ["h"]);
    assert.ok(result.warnings.includes("IMPACT_UNMAPPED_HUNKS"));
    assert.ok(result.completeness.reasons.includes("unmapped_hunks"));
});

test("detect_changes diffs a moved file against its source so only edited lines seed", async () => {
    const base = "export function f() {\n  return 1;\n}\nexport function g() {\n  return 2;\n}\nexport function h() {\n  return 3;\n}\n";
    const symbols = [
        { symbolId: "f", kind: "function", startLine: 1, endLine: 3 },
        { symbolId: "g", kind: "function", startLine: 4, endLine: 6 },
        { symbolId: "h", kind: "function", startLine: 7, endLine: 9 },
    ];
    const moved = await seedFixture(base, base, symbols, "helpers.ts");
    assert.deepEqual(moved.changedFiles, ["helpers.ts"]);
    assert.deepEqual(moved.seeds, []);
    assert.ok(!moved.warnings.includes("IMPACT_FILE_LEVEL_SEEDS"));

    const movedAndEdited = await seedFixture(base, base.replace("return 3;", "return 30;"), symbols, "helpers.ts");
    assert.deepEqual(movedAndEdited.changedFiles, ["helpers.ts"]);
    assert.deepEqual(movedAndEdited.seeds.map((seed) => seed.symbolId), ["h"]);
});

test("detect_changes trims changedFiles before seeds so a huge diff still fits the byte budget", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-many-files-"));
    const fileCount = 1500;
    const fileName = (index: number) => `packages/a-fairly-long-package-directory-name/src/module-${String(index).padStart(5, "0")}.ts`;
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        fs.mkdirSync(path.join(repo, path.dirname(fileName(0))), { recursive: true });
        for (let index = 0; index < fileCount; index += 1) fs.writeFileSync(path.join(repo, fileName(index)), "export const v = 1;\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        for (let index = 0; index < fileCount; index += 1) fs.writeFileSync(path.join(repo, fileName(index)), "export const v = 2;\n");
        const result = await detectChangeImpact({ path: repo, baseRef: "HEAD", depth: 1, limit: 20 }, {
            outline: async (file) => ({
                status: "ok", path: repo, file,
                outline: { symbols: [{ symbolId: `v-${file}`, symbolLabel: "const v", kind: "variable", language: "typescript",
                    file, span: { startLine: 1, endLine: 1 } }] },
                hasMore: false,
            } as unknown as FileOutlineResponseEnvelope),
            callers: async (_root, symbol) => ({
                status: "ok", path: repo, symbolRef: { file: symbol.file, symbolId: symbol.symbolId }, supported: true,
                direction: "callers", depth: 1, limit: 20,
                nodes: [{ symbolId: symbol.symbolId, symbolLabel: symbol.symbolLabel ?? symbol.symbolId, file: symbol.file,
                    language: "typescript", span: symbol.span }],
                edges: [], notes: [], exactReferences: [],
            } as unknown as CallGraphResponseEnvelope),
        });

        assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 48 * 1024);
        assert.equal(result.seeds.length, 50);
        assert.equal(result.omitted.seeds, 0);
        assert.ok(result.omitted.changedFiles > 0);
        assert.equal(result.changedFiles.length + result.omitted.changedFiles, fileCount);
        assert.ok(result.warnings.includes("IMPACT_RESPONSE_BYTE_LIMIT"));
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});
