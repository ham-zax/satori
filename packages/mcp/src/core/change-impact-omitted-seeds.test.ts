import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
    CallGraphResponseEnvelope,
    FileOutlineResponseEnvelope,
} from "./search-types.js";
import { detectChangeImpact } from "./change-impact.js";

test("detect_changes omitted.seeds counts seeds dropped by the seed budget", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "satori-impact-omitted-seeds-"));
    try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
        // 61 candidates in a.ts + 1 in b.ts = 62 candidates for the 50-seed
        // budget, so 12 seeds are dropped by the seed budget.
        const baseLines = Array.from({ length: 183 }, (_, index) => `const x${index} = ${index};`);
        fs.writeFileSync(path.join(repo, "a.ts"), `${baseLines.join("\n")}\n`);
        fs.writeFileSync(path.join(repo, "b.ts"), "export function g() {\n  return 1;\n}\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
        fs.writeFileSync(path.join(repo, "a.ts"), `${baseLines.map((line) => `${line} // changed`).join("\n")}\n`);
        fs.writeFileSync(path.join(repo, "b.ts"), "export function g() {\n  return 2;\n}\n");

        const symbolsA = Array.from({ length: 61 }, (_, index) => ({
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
        assert.deepEqual(result.seedOmittedFiles, [{ file: "a.ts", omittedSeedCount: 12 }]);
        const listedOmitted = result.seedOmittedFiles.reduce((sum, entry) => sum + entry.omittedSeedCount, 0);
        assert.equal(listedOmitted, 12);
        // The count must match the listed omitted seeds; the response fits
        // the byte budget so no byte-budget trimming applies.
        assert.equal(result.omitted.seeds, listedOmitted);
        assert.equal(result.omitted.seeds + result.seeds.length, 62);
        assert.ok(!result.warnings.includes("IMPACT_RESPONSE_BYTE_LIMIT"));
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});
