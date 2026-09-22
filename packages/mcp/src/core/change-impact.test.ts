import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
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
                nodes: [seed, heuristicDirect, proofDirect, heuristicTransitive, proofTransitive, mixed],
                edges: [{
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
                }],
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
