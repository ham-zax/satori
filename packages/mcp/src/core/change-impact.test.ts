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
        assert.deepEqual(result.impacted.map((item) => [item.symbolId, item.impactClass, item.distance]), [
            ["direct", "direct", 1],
            ["transitive", "transitive", 2],
        ]);
        assert.deepEqual(result.impacted[1]?.causalPath.map((edge) => [
            edge.callerSymbolId,
            edge.calleeSymbolId,
        ]), [
            ["direct", "seed"],
            ["transitive", "direct"],
        ]);
        assert.equal(result.uncertainCallReferences.length, 1);
        assert.equal(result.impacted.some((item) => item.symbolId === "uncertain"), false);
        assert.ok(result.areaImpact.some((row) => (
            row.area === "packages/core" && row.seedCount === 1 && row.directCount === 1
        )));
        assert.ok(result.areaImpact.some((row) => (
            row.area === "packages/app" && row.transitiveCount === 1
        )));
        assert.ok(result.completeness.reasons.includes("depth_bound"));
        assert.ok(result.completeness.reasons.includes("uncertain_references"));
        assert.equal(result.completeness.exhaustive, false);
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});
