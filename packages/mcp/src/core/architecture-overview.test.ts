import assert from "node:assert/strict";
import test from "node:test";
import type {
    RelationshipRecord,
    ResolutionClaim,
    SymbolRecord,
    SymbolRegistryManifest,
} from "@zokizuan/satori-core";
import { buildArchitectureOverview } from "./architecture-overview.js";

function sym(id: string, file: string, name = id): SymbolRecord {
    return {
        symbolKey: id,
        symbolInstanceId: id,
        language: "typescript",
        kind: "function",
        name,
        qualifiedName: name,
        label: `function ${name}()`,
        file,
        span: { startLine: 1, endLine: 3 },
        parentQualifiedNamePath: [],
        fileHash: "fixture",
        extractorVersion: "fixture",
    } as SymbolRecord;
}

function call(source: SymbolRecord, target: SymbolRecord): RelationshipRecord {
    return {
        type: "CALLS",
        sourceInstanceId: source.symbolInstanceId,
        targetInstanceId: target.symbolInstanceId,
        sourceKey: source.symbolKey,
        targetKey: target.symbolKey,
        file: source.file,
        targetPath: target.file,
        confidence: "high",
        span: { startLine: 2, endLine: 2 },
    } as RelationshipRecord;
}

test("architecture overview applies subtree/exclusions to entries, cycles, and claims", () => {
    const a = sym("a", "packages/a/src/a.ts");
    const b = sym("b", "packages/b/src/b.ts");
    const root = sym("root", "packages/a/src/root.ts");
    const excluded = sym("excluded", "packages/a/generated/ignored.ts");
    const symbols = [a, b, root, excluded];
    const relationships = [
        call(a, b),
        call(b, a),
        call(root, a),
        call(excluded, a),
    ];
    const claims = [{
        sourceFile: excluded.file,
        decision: "unresolved",
        observation: { kind: "call", construct: "direct_call", calleeName: "a", calleeText: "a()", candidates: [] },
    }, {
        sourceFile: root.file,
        decision: "unresolved",
        observation: { kind: "call", construct: "direct_call", calleeName: "a", calleeText: "a()", candidates: [] },
    }] as unknown as ResolutionClaim[];
    const manifest = {
        files: symbols.map((symbol) => ({ path: symbol.file })),
    } as unknown as SymbolRegistryManifest;

    const result = buildArchitectureOverview({
        manifest,
        symbols,
        relationships,
        resolutionClaims: claims,
        scope: "all",
        limit: 10,
        subtree: "packages",
        excludePaths: ["packages/a/generated"],
    });

    assert.equal(result.coverage.excludedPublishedFileCountByPathScope, 1);
    assert.equal(result.coverage.includedSymbolCount, 3);
    assert.equal(result.relationshipEvidence.resolutionClaimCount, 1);
    assert.deepEqual(result.entryCandidates.map((candidate) => candidate.symbolId), ["root"]);
    assert.equal(result.entryCandidateRule, "outgoing_calls_and_no_incoming_calls_within_scope");
    assert.deepEqual(result.cycles.map((cycle) => cycle.areas), [["packages/a", "packages/b"]]);
    assert.equal(result.cycleRule, "strongly_connected_area_boundary_graph");
    assert.equal(result.boundaries.some((boundary) => boundary.from.includes("generated")), false);
});
