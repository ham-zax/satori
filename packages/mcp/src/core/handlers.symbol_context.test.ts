import assert from "node:assert/strict";
import test from "node:test";
import type { PublicationLease, SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { ToolHandlers } from "./handlers.js";
import type { PrepareSymbolContextSnapshotResult } from "./symbol-context-composer.js";

type SnapshotAdapterHost = {
    acquirePublicationLease(codebasePath: string): PublicationLease | undefined;
    isPublicationLeaseAdmitted(lease: PublicationLease): Promise<boolean>;
    context: {
        getPublicationNavigationAddress(lease: PublicationLease): {
            publicationId: string;
            navigationRoot: string;
        } | undefined;
    };
    prepareNavigationRead(absolutePath: string): Promise<unknown>;
    loadPreparedNavigationSymbolsByFile(
        preparedRead: unknown,
        relativeFile: string,
    ): Promise<unknown>;
    loadPreparedNavigationCompatibility(
        preparedRead: unknown,
        manifestHash: string,
    ): Promise<unknown>;
};

type SnapshotAdapter = (this: SnapshotAdapterHost, input: {
    codebaseRoot: string;
    relativeFile: string;
    symbolId?: string;
    symbolLabel?: string;
}) => Promise<PrepareSymbolContextSnapshotResult>;

function fixtureSymbol(symbolInstanceId: string, file: string): SymbolRecord {
    return {
        symbolKey: `${symbolInstanceId}-key`,
        symbolInstanceId,
        language: "typescript",
        kind: "function",
        name: symbolInstanceId,
        qualifiedName: symbolInstanceId,
        label: `function ${symbolInstanceId}()`,
        file,
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: "0".repeat(64),
        extractorVersion: "fixture-extractor",
    };
}

test("symbol-context handler adapter binds prepared navigation and relationship manifests", async () => {
    const relationshipManifest = {
        schemaVersion: "relationship_manifest_v1",
        symbolRegistryManifestHash: "registry-manifest",
        relationshipVersion: "relationship-fixture-v1",
        builtAt: "2026-07-15T00:00:00.000Z",
        files: [],
    };
    const target = fixtureSymbol("target", "src/example.ts");
    const caller = fixtureSymbol("caller", "src/caller.ts");
    const callee = fixtureSymbol("callee", "src/callee.ts");
    const symbols = [target, caller, callee];
    const registry = {
        symbols,
        symbolsByInstanceId: new Map(symbols.map((entry) => [entry.symbolInstanceId, entry])),
        symbolsByKey: new Map(symbols.map((entry) => [entry.symbolKey, [entry]])),
        symbolsByFile: new Map([
            [target.file, [target]],
            [caller.file, [caller]],
            [callee.file, [callee]],
        ]),
        symbolsByLabel: new Map(symbols.map((entry) => [entry.label, [entry]])),
        symbolsByQualifiedName: new Map(symbols.map((entry) => [entry.qualifiedName, [entry]])),
    } as unknown as SymbolRegistry;
    const publicationId = "publication-1";
    const preparedRead = {
        state: "ready",
        root: { path: "/repo" },
        publication: { id: publicationId },
        navigationStatus: "valid",
    };
    let leaseAdmitted = true;
    let loadedRelationshipManifestHash = "relationship-manifest";
    const lease = {
        id: publicationId,
        publication: {},
        release: () => undefined,
    } as unknown as PublicationLease;
    const host: SnapshotAdapterHost = {
        acquirePublicationLease: (codebasePath) => {
            assert.equal(codebasePath, "/repo");
            return lease;
        },
        isPublicationLeaseAdmitted: async () => leaseAdmitted,
        context: {
            getPublicationNavigationAddress: () => ({
                publicationId,
                navigationRoot: "/state/publication-1/navigation",
            }),
        },
        prepareNavigationRead: async (absolutePath) => {
            assert.equal(absolutePath, "/repo");
            return preparedRead;
        },
        loadPreparedNavigationSymbolsByFile: async (read, relativeFile) => {
            assert.equal(read, preparedRead);
            assert.equal(relativeFile, "src/example.ts");
            return {
                status: "ok",
                manifestHash: "registry-manifest",
                registry,
            };
        },
        loadPreparedNavigationCompatibility: async (read, manifestHash) => {
            assert.equal(read, preparedRead);
            assert.equal(manifestHash, "registry-manifest");
            return {
                relationships: {
                    status: "ok",
                    manifestHash: loadedRelationshipManifestHash,
                    manifest: relationshipManifest,
                    warnings: [],
                    records: [
                        {
                            sourceInstanceId: "caller",
                            targetInstanceId: "target",
                            sourceKey: "caller-key",
                            targetKey: "target-key",
                            type: "CALLS",
                            file: "src/caller.ts",
                            span: { startLine: 12, endLine: 13 },
                            confidence: "high",
                        },
                        {
                            sourceInstanceId: "target",
                            targetInstanceId: "callee",
                            sourceKey: "target-key",
                            targetKey: "callee-key",
                            type: "CALLS",
                            file: "src/example.ts",
                            span: { startLine: 20, endLine: 20 },
                            confidence: "low",
                        },
                        {
                            sourceInstanceId: "target",
                            targetInstanceId: "ignored",
                            sourceKey: "target-key",
                            targetKey: "ignored-key",
                            type: "REFERENCES",
                            file: "src/example.ts",
                            span: { startLine: 30, endLine: 30 },
                            confidence: "high",
                        },
                    ],
                },
            };
        },
    };
    const prepareSnapshot = (
        ToolHandlers.prototype as unknown as {
            prepareSymbolContextSnapshot: SnapshotAdapter;
        }
    ).prepareSymbolContextSnapshot;

    const result = await prepareSnapshot.call(host, {
        codebaseRoot: "/repo",
        relativeFile: "src/example.ts",
        symbolId: "target",
    });

    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.snapshot.registry, registry);
    assert.equal(result.snapshot.registryManifestIdentity, "registry-manifest");
    assert.equal(result.snapshot.relationships.status, "available");
    if (result.snapshot.relationships.status !== "available") return;
    assert.equal(result.snapshot.relationships.callers.edges.length, 1);
    assert.equal(result.snapshot.relationships.callees.edges.length, 0);
    assert.deepEqual(result.snapshot.relationships.callers.edges[0], {
        srcSymbolId: "caller",
        dstSymbolId: "target",
        kind: "call",
        site: { file: "src/caller.ts", startLine: 12, endLine: 13 },
        confidence: 0.95,
        strategy: "heuristic",
    });
    assert.equal(result.snapshot.relationships.callees.suppressedCount, 1);
    assert.match(
        result.snapshot.relationships.callees.suppressionNotes[0]?.detail || "",
        /low-confidence callee candidate/,
    );
    assert.equal(
        result.snapshot.relationships.manifestIdentity,
        "relationship-manifest",
    );
    assert.equal(await result.snapshot.validateAuthority(), true);

    // The compatibility loader owns relationship-manifest validation now; this
    // adapter consumes only already-validated relationship state.
    loadedRelationshipManifestHash = "different-relationship-manifest";
    leaseAdmitted = false;
    assert.equal(await result.snapshot.validateAuthority(), false);
});
