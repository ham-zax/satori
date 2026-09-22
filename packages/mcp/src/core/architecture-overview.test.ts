import assert from "node:assert/strict";
import test from "node:test";
import type {
    PackageOwnershipPackage,
    PublicationPackageOwnership,
    RelationshipRecord,
    ResolutionClaim,
    SymbolRecord,
    SymbolRegistryManifest,
} from "@zokizuan/satori-core";
import {
    ArchitecturePackageOwnershipError,
    buildArchitectureOverview,
} from "./architecture-overview.js";

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

function relationship(
    type: "CALLS" | "IMPORTS",
    source: SymbolRecord,
    target: SymbolRecord,
    confidence: RelationshipRecord["confidence"] = "high",
): RelationshipRecord {
    return {
        type,
        sourceInstanceId: source.symbolInstanceId,
        targetInstanceId: target.symbolInstanceId,
        sourceKey: source.symbolKey,
        targetKey: target.symbolKey,
        file: source.file,
        targetPath: target.file,
        confidence,
        span: { startLine: 2, endLine: 2 },
    } as RelationshipRecord;
}

function call(source: SymbolRecord, target: SymbolRecord): RelationshipRecord {
    return relationship("CALLS", source, target);
}

function rootOwnership(files: readonly string[]): PublicationPackageOwnership {
    return {
        schemaVersion: "package_ownership_v1",
        canonicalRoot: "/repo",
        workspace: null,
        packages: [{
            ecosystem: "node",
            root: "",
            manifestPath: "package.json",
            name: "fixture-root",
            workspaceMember: false,
        }],
        files: files.map((file) => ({ path: file, packageRoot: "" })),
        controlFiles: [],
    };
}

function pkg(
    root: string,
    name: string,
    workspaceMember = root !== "",
): PackageOwnershipPackage {
    return {
        ecosystem: "node",
        root,
        manifestPath: root === "" ? "package.json" : `${root}/package.json`,
        name,
        workspaceMember,
    };
}

function ownershipFixture(input: {
    packages: readonly PackageOwnershipPackage[];
    files: readonly { path: string; packageRoot: string | null }[];
    workspace?: PublicationPackageOwnership["workspace"];
}): PublicationPackageOwnership {
    return {
        schemaVersion: "package_ownership_v1",
        canonicalRoot: "/repo",
        workspace: input.workspace ?? null,
        packages: input.packages,
        files: input.files,
        controlFiles: [],
    };
}

test("architecture overview reports bounded cross-area fan-in and fan-out", () => {
    const a = sym("a", "packages/a/src/a.ts");
    const b = sym("b", "packages/b/src/b.ts");
    const c = sym("c", "packages/c/src/c.ts");
    const symbols = [a, b, c];
    const manifest = {
        files: symbols.map((symbol) => ({ path: symbol.file })),
    } as unknown as SymbolRegistryManifest;

    const result = buildArchitectureOverview({
        manifest,
        packageOwnership: rootOwnership(manifest.files.map((file) => file.path)),
        symbols,
        relationships: [
            call(b, a),
            call(c, a),
            call(a, b),
        ],
        scope: "all",
        limit: 10,
    });

    assert.deepEqual(result.fanIn[0], {
        area: "packages/a",
        counterpartAreaCount: 2,
        calls: 2,
        imports: 0,
        evidenceCount: 2,
        highConfidenceEvidenceCount: 2,
    });
    assert.deepEqual(result.fanOut[0], {
        area: "packages/a",
        counterpartAreaCount: 1,
        calls: 1,
        imports: 0,
        evidenceCount: 1,
        highConfidenceEvidenceCount: 1,
    });
    assert.equal(result.fanInRule, "cross_area_incoming_calls_and_imports");
    assert.equal(result.fanOutRule, "cross_area_outgoing_calls_and_imports");
});

test("architecture overview does not reconcile scoped claims with out-of-scope call evidence", () => {
    const a = sym("a", "packages/a/src/a.ts");
    const b = sym("b", "packages/b/src/b.ts");
    const span = {
        startLine: 2,
        endLine: 2,
        startByte: 10,
        endByte: 21,
        startColumn: 4,
        endColumn: 15,
    };
    const relationship = {
        ...call(a, b),
        span,
        resolutionAuthority: "direct_binding",
    } as RelationshipRecord;
    const claim = {
        providerId: "fixture-provider",
        providerVersion: "fixture-v1",
        sourceFile: a.file,
        sourceInstanceId: a.symbolInstanceId,
        callSpan: span,
        observation: {
            kind: "call",
            construct: "direct_call",
            calleeName: "b",
            calleeText: "b()",
            candidates: [],
        },
        decision: "unresolved",
        relationshipType: "REFERENCES",
        resolutionAuthority: "unresolved",
    } as unknown as ResolutionClaim;
    const manifest = {
        files: [{ path: a.file }, { path: b.file }],
    } as unknown as SymbolRegistryManifest;

    const result = buildArchitectureOverview({
        manifest,
        packageOwnership: rootOwnership(manifest.files.map((file) => file.path)),
        symbols: [a, b],
        relationships: [relationship],
        resolutionClaims: [claim],
        scope: "all",
        limit: 10,
        subtree: "packages/a",
    });

    assert.equal(result.coverage.includedRelationshipCount, 0);
    assert.deepEqual(result.boundaries, []);
    assert.equal(result.relationshipEvidence.resolutionClaimCount, 1);
    assert.deepEqual(result.relationshipEvidence.constructCoverage.map((coverage) => ({
        construct: coverage.construct,
        status: coverage.status,
        resolvedCount: coverage.resolvedCount,
        unresolvedCount: coverage.unresolvedCount,
        gapCount: coverage.gapCount,
    })), [{
        construct: "direct_call",
        status: "partial",
        resolvedCount: 0,
        unresolvedCount: 1,
        gapCount: 1,
    }]);
});

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
        packageOwnership: rootOwnership(manifest.files.map((file) => file.path)),
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

test("architecture overview projects factual package summaries, boundaries, flows, cycles, root, and unowned files", () => {
    const root = sym("root", "src/root.ts");
    const a = sym("a", "packages/a/src/a.ts");
    const aLocal = sym("a-local", "packages/a/src/local.ts");
    const b = sym("b", "packages/b/src/b.ts");
    const loose = sym("loose", "misc/loose.ts");
    const symbols = [root, a, aLocal, b, loose];
    const manifest = {
        files: symbols.map((symbol) => ({ path: symbol.file })),
    } as unknown as SymbolRegistryManifest;
    const packageOwnership = ownershipFixture({
        workspace: {
            kind: "pnpm",
            root: "",
            manifestPath: "pnpm-workspace.yaml",
            patterns: ["packages/*"],
        },
        packages: [
            pkg("", "fixture-root", false),
            pkg("packages/a", "@fixture/a"),
            pkg("packages/b", "@fixture/b"),
        ],
        files: [
            { path: root.file, packageRoot: "" },
            { path: a.file, packageRoot: "packages/a" },
            { path: aLocal.file, packageRoot: "packages/a" },
            { path: b.file, packageRoot: "packages/b" },
            { path: loose.file, packageRoot: null },
        ],
    });

    const result = buildArchitectureOverview({
        manifest,
        packageOwnership,
        symbols,
        relationships: [
            call(a, b),
            relationship("IMPORTS", aLocal, b, "medium"),
            call(b, a),
            call(a, aLocal),
            call(root, a),
            call(loose, a),
        ],
        scope: "all",
        limit: 10,
    });

    assert.deepEqual(result.packageArchitecture.workspace, {
        kind: "pnpm",
        manifestPath: "pnpm-workspace.yaml",
    });
    assert.deepEqual(result.packageArchitecture.coverage, {
        totalPersistedPackageCount: 3,
        includedPackageCount: 3,
        includedPackageOwnedFileCount: 4,
        includedUnownedFileCount: 1,
        includedRelationshipCount: 6,
        boundaryRelationshipCount: 5,
    });
    assert.deepEqual(
        result.packageArchitecture.packages
            .map((row) => ({
                packageRoot: row.packageRoot,
                name: row.name,
                fileCount: row.fileCount,
                symbolCount: row.symbolCount,
            }))
            .sort((left, right) => left.packageRoot.localeCompare(right.packageRoot)),
        [
            { packageRoot: "", name: "fixture-root", fileCount: 1, symbolCount: 1 },
            { packageRoot: "packages/a", name: "@fixture/a", fileCount: 2, symbolCount: 2 },
            { packageRoot: "packages/b", name: "@fixture/b", fileCount: 1, symbolCount: 1 },
        ],
    );

    const aToB = result.packageArchitecture.boundaries.find((row) => (
        row.fromPackageRoot === "packages/a" && row.toPackageRoot === "packages/b"
    ));
    assert.deepEqual(aToB, {
        fromPackageRoot: "packages/a",
        fromPackageName: "@fixture/a",
        toPackageRoot: "packages/b",
        toPackageName: "@fixture/b",
        calls: 1,
        highConfidenceCalls: 1,
        imports: 1,
        highConfidenceImports: 0,
        evidenceCount: 2,
        highConfidenceEvidenceCount: 1,
    });
    assert.equal(result.packageArchitecture.boundaries.some((row) => (
        row.fromPackageRoot === "packages/a" && row.toPackageRoot === "packages/a"
    )), false);
    assert.equal(result.packageArchitecture.boundaries.some((row) => (
        row.fromPackageRoot === null && row.toPackageRoot === "packages/a"
    )), true);

    const aFanIn = result.packageArchitecture.fanIn.find((row) => row.packageRoot === "packages/a");
    assert.deepEqual(aFanIn, {
        packageRoot: "packages/a",
        packageName: "@fixture/a",
        counterpartPackageCount: 3,
        calls: 3,
        imports: 0,
        evidenceCount: 3,
        highConfidenceEvidenceCount: 3,
    });
    const aFanOut = result.packageArchitecture.fanOut.find((row) => row.packageRoot === "packages/a");
    assert.deepEqual(aFanOut, {
        packageRoot: "packages/a",
        packageName: "@fixture/a",
        counterpartPackageCount: 1,
        calls: 1,
        imports: 1,
        evidenceCount: 2,
        highConfidenceEvidenceCount: 1,
    });
    assert.deepEqual(
        result.packageArchitecture.cycles.map((cycle) => cycle.packageRoots),
        [["packages/a", "packages/b"]],
    );
    assert.equal(
        result.packageArchitecture.cycleRule,
        "strongly_connected_owned_package_boundary_graph_excluding_unowned",
    );
});

test("package architecture filters evidence before aggregation for subtree scope", () => {
    const a = sym("a", "packages/a/src/a.ts");
    const b = sym("b", "packages/b/src/b.ts");
    const manifest = {
        files: [{ path: a.file }, { path: b.file }],
    } as unknown as SymbolRegistryManifest;
    const packageOwnership = ownershipFixture({
        packages: [pkg("packages/a", "@fixture/a"), pkg("packages/b", "@fixture/b")],
        files: [
            { path: a.file, packageRoot: "packages/a" },
            { path: b.file, packageRoot: "packages/b" },
        ],
    });

    const result = buildArchitectureOverview({
        manifest,
        packageOwnership,
        symbols: [a, b],
        relationships: [call(a, b)],
        scope: "all",
        limit: 10,
        subtree: "packages/a",
    });

    assert.equal(result.packageArchitecture.coverage.totalPersistedPackageCount, 2);
    assert.equal(result.packageArchitecture.coverage.includedPackageCount, 1);
    assert.equal(result.packageArchitecture.coverage.includedRelationshipCount, 0);
    assert.deepEqual(
        result.packageArchitecture.packages.map((row) => row.packageRoot),
        ["packages/a"],
    );
    assert.deepEqual(result.packageArchitecture.boundaries, []);
});

test("package architecture runtime scope reuses architecture file eligibility", () => {
    const runtime = sym("runtime", "packages/a/src/runtime.ts");
    const testSymbol = sym("test", "packages/a/tests/runtime.test.ts");
    const docs = sym("docs", "packages/b/docs/example.ts");
    const manifest = {
        files: [runtime, testSymbol, docs].map((symbol) => ({ path: symbol.file })),
    } as unknown as SymbolRegistryManifest;
    const packageOwnership = ownershipFixture({
        packages: [pkg("packages/a", "@fixture/a"), pkg("packages/b", "@fixture/b")],
        files: [
            { path: runtime.file, packageRoot: "packages/a" },
            { path: testSymbol.file, packageRoot: "packages/a" },
            { path: docs.file, packageRoot: "packages/b" },
        ],
    });

    const result = buildArchitectureOverview({
        manifest,
        packageOwnership,
        symbols: [runtime, testSymbol, docs],
        relationships: [
            call(testSymbol, runtime),
            call(docs, runtime),
        ],
        scope: "runtime",
        limit: 10,
    });

    assert.equal(result.packageArchitecture.coverage.includedPackageOwnedFileCount, 1);
    assert.equal(result.packageArchitecture.coverage.includedPackageCount, 1);
    assert.equal(result.packageArchitecture.coverage.includedRelationshipCount, 0);
    assert.deepEqual(result.packageArchitecture.packages.map((row) => row.packageRoot), ["packages/a"]);
});

test("package architecture consumes persisted nested ownership and preserves root versus null", () => {
    const root = sym("root", "src/root.ts");
    const parent = sym("parent", "packages/a/src/parent.ts");
    const nested = sym("nested", "packages/a/nested/src/value.ts");
    const loose = sym("loose", "misc/loose.ts");
    const manifest = {
        files: [root, parent, nested, loose].map((symbol) => ({ path: symbol.file })),
    } as unknown as SymbolRegistryManifest;
    const packageOwnership = ownershipFixture({
        packages: [
            pkg("", "fixture-root", false),
            pkg("packages/a", "@fixture/a"),
            pkg("packages/a/nested", "@fixture/nested"),
        ],
        files: [
            { path: root.file, packageRoot: "" },
            { path: parent.file, packageRoot: "packages/a" },
            { path: nested.file, packageRoot: "packages/a/nested" },
            { path: loose.file, packageRoot: null },
        ],
    });

    const result = buildArchitectureOverview({
        manifest,
        packageOwnership,
        symbols: [root, parent, nested, loose],
        relationships: [call(loose, root)],
        scope: "all",
        limit: 10,
    });

    assert.equal(
        result.packageArchitecture.packages.find((row) => row.packageRoot === "packages/a")?.symbolCount,
        1,
    );
    assert.equal(
        result.packageArchitecture.packages.find((row) => row.packageRoot === "packages/a/nested")?.symbolCount,
        1,
    );
    assert.equal(
        result.packageArchitecture.packages.find((row) => row.packageRoot === "")?.symbolCount,
        1,
    );
    assert.equal(result.packageArchitecture.coverage.includedUnownedFileCount, 1);
    assert.equal(result.packageArchitecture.boundaries[0]?.fromPackageRoot, null);
    assert.equal(result.packageArchitecture.boundaries[0]?.toPackageRoot, "");
});

test("package architecture rejects ownership that does not match the Publication file set", () => {
    const root = sym("root", "src/root.ts");
    const manifest = {
        files: [{ path: root.file }],
    } as unknown as SymbolRegistryManifest;
    const packageOwnership = ownershipFixture({
        packages: [pkg("", "fixture-root", false)],
        files: [],
    });

    assert.throws(
        () => buildArchitectureOverview({
            manifest,
            packageOwnership,
            symbols: [root],
            relationships: [],
            scope: "all",
            limit: 10,
        }),
        ArchitecturePackageOwnershipError,
    );
});
