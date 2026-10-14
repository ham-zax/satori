import assert from "node:assert/strict";
import test from "node:test";
import type {
    PublicationLease,
    PublicationPackageOwnership,
    RelationshipRecord,
    ResolutionClaim,
    SymbolRecord,
} from "@satori-code/core";
import { NavigationHandlers } from "./navigation-handlers.js";
import { architectureOverviewTool } from "../tools/architecture_overview.js";
import type { ToolContext } from "../tools/types.js";
import { createSessionWorkspacePolicy } from "./session-workspace-policy.js";

type NavigationHandlersHost = ConstructorParameters<typeof NavigationHandlers>[0];
type PreparedNavigationState = Awaited<ReturnType<NavigationHandlersHost["prepareNavigationRead"]>>;

function fakeLease(): PublicationLease {
    return {
        id: "publication-1",
        publication: {
            id: "publication-1",
            canonicalRoot: "/repo",
        },
        release: () => undefined,
    } as unknown as PublicationLease;
}

function readyState(): PreparedNavigationState {
    return {
        state: "ready",
        root: {
            path: "/repo",
            info: { status: "indexed" },
        },
        publication: {
            id: "publication-1",
        },
    } as unknown as PreparedNavigationState;
}

function parseResponse(response: Awaited<ReturnType<NavigationHandlers["handleArchitectureOverview"]>>) {
    return JSON.parse(response.content[0]!.text) as {
        status: string;
        reason?: string;
        path?: string;
        message?: string;
    };
}

test("architecture overview loads package ownership from the exact leased Publication and fails closed when missing", async () => {
    const lease = fakeLease();
    let released = false;
    let ownershipPublication: PublicationLease | undefined;
    lease.release = () => {
        released = true;
    };

    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => readyState(),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        getPublicationPackageOwnership: (publication: PublicationLease) => {
            ownershipPublication = publication;
            return null;
        },
        stringifyToolJson: JSON.stringify,
    } as unknown as NavigationHandlersHost);

    const response = await handler.handleArchitectureOverview({
        path: "/repo",
        scope: "all",
        limit: 10,
    });

    assert.equal(ownershipPublication, lease);
    assert.equal(released, true);
    assert.deepEqual(parseResponse(response), {
        status: "not_ready",
        reason: "missing_package_ownership",
        path: "/repo",
        message: "The leased Publication is missing its package ownership snapshot.",
    });
});

test("architecture overview fails closed on package ownership from a mismatched Publication root", async () => {
    const lease = fakeLease();
    const ownership = {
        schemaVersion: "package_ownership_v2",
        canonicalRoot: "/different-repo",
        workspace: null,
        cargoWorkspaces: [],
        packages: [],
        files: [],
        controlFiles: [],
    } as PublicationPackageOwnership;

    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => readyState(),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        getPublicationPackageOwnership: () => ownership,
        stringifyToolJson: JSON.stringify,
    } as unknown as NavigationHandlersHost);

    const response = await handler.handleArchitectureOverview({
        path: "/repo",
        scope: "runtime",
        limit: 10,
    });

    assert.deepEqual(parseResponse(response), {
        status: "not_ready",
        reason: "incompatible_package_ownership",
        path: "/repo",
        message: "The leased Publication package ownership root is incompatible.",
    });
});

test("architecture overview reports indexing while a reindex holds the root, without leasing", async () => {
    let leaseRequests = 0;
    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => ({
            state: "indexing",
            codebasePath: "/repo",
            searchableGenerationAvailable: true,
        }) as PreparedNavigationState,
        acquirePublicationLease: () => {
            leaseRequests += 1;
            return fakeLease();
        },
        stringifyToolJson: JSON.stringify,
    } as unknown as NavigationHandlersHost);

    const response = await handler.handleArchitectureOverview({ path: "/repo", scope: "all", limit: 10 });

    assert.equal(leaseRequests, 0);
    assert.equal(parseResponse(response).reason, "indexing");
});

test("architecture overview limits ancestor Publication evidence to the authorized request directory", async () => {
    const symbols = [
        ["entry", "allowed/src/entry.ts"],
        ["helper", "allowed/src/helper.ts"],
        ["nested", "allowed/nested/other.ts"],
        ["secret", "private/src/secret.ts"],
        ["prefix-sibling", "allowed-extra/src/sibling.ts"],
    ].map(([id, file]) => ({
        symbolKey: id,
        symbolInstanceId: id,
        language: "typescript",
        kind: "function",
        name: id,
        label: `function ${id}()`,
        file,
        span: { startLine: 1, endLine: 3 },
    } as SymbolRecord));
    const relationships = [[0, 1], [0, 3], [3, 4]].map(([from, to]) => ({
        type: "CALLS",
        sourceInstanceId: symbols[from!]!.symbolInstanceId,
        targetInstanceId: symbols[to!]!.symbolInstanceId,
        file: symbols[from!]!.file,
        targetPath: symbols[to!]!.file,
        confidence: "high",
    } as RelationshipRecord));
    const ownership: PublicationPackageOwnership = {
        schemaVersion: "package_ownership_v2",
        canonicalRoot: "/repo",
        workspace: { kind: "pnpm", root: "", manifestPath: "pnpm-workspace.yaml", patterns: ["*"] },
        cargoWorkspaces: [{ kind: "cargo", root: "private", manifestPath: "private/Cargo.toml", patterns: ["*"] }],
        packages: ["allowed", "private", "allowed-extra"].map((root) => ({
            ecosystem: "node",
            root,
            manifestPath: `${root}/package.json`,
            name: root,
            workspaceMember: true,
        })),
        files: symbols.map((symbol) => ({ path: symbol.file, packageRoot: symbol.file.split("/")[0]! })),
        controlFiles: [],
    };
    const lease = fakeLease();
    let releases = 0;
    lease.release = () => { releases += 1; };
    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => readyState(),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        getPublicationPackageOwnership: () => ownership,
        loadPreparedNavigationManifest: async () => ({
            status: "ok", manifestHash: "fixture",
            registry: { manifest: { files: symbols.map((symbol) => ({ path: symbol.file })) }, symbols },
        }),
        loadPreparedNavigationCompatibility: async () => ({ relationships: { status: "ok", records: relationships } }),
        loadPreparedNavigationResolutionClaims: async () => ({
            status: "ok",
            claims: [{
                sourceFile: "private/src/secret.ts", callSpan: { startByte: 0, endByte: 1 },
                observation: { construct: "dynamic_receiver", candidates: [], calleeName: "secret", calleeText: "secret()" },
                decision: "unresolved", resolutionAuthority: "unresolved",
            } as unknown as ResolutionClaim],
        }),
        stringifyToolJson: JSON.stringify,
    } as unknown as NavigationHandlersHost);
    const workspacePolicy = createSessionWorkspacePolicy({
        roots: ["/repo/allowed"], homeDirectory: "/test-home", stateRoot: "/test-state",
    });
    assert.throws(() => workspacePolicy.authorizeRoot("/repo"));
    const ctx = { workspacePolicy, toolHandlers: handler } as unknown as ToolContext;

    for (const subtree of [undefined, "allowed/src", "disjoint"]) {
        const response = await architectureOverviewTool.execute({
            path: "/repo/allowed", scope: "all", ...(subtree ? { subtree } : {}),
        }, ctx);
        const payload = JSON.parse(response.content[0]!.text);
        assert.equal(payload.status, "ok");
        assert.doesNotMatch(JSON.stringify(payload), /private|secret|allowed-extra|prefix-sibling|pnpm-workspace/);
        assert.equal(payload.path, "/repo/allowed");
        assert.equal(payload.coverage.publishedFileCount, 3);
        assert.equal(payload.coverage.symbolCount, 3);
        assert.equal(payload.coverage.relationshipCount, 1);
        assert.equal(payload.coverage.includedSymbolCount, subtree === "disjoint" ? 0 : subtree ? 2 : 3);
        assert.equal(payload.relationshipEvidence.resolutionClaimCount, 0);
        assert.equal(payload.packageArchitecture.coverage.totalPersistedPackageCount, 1);
        assert.equal(payload.packageArchitecture.workspace, null);
        assert.deepEqual(payload.packageArchitecture.cargoWorkspaces, []);
        assert.equal(payload.entryCandidates[0]?.file, subtree === "disjoint" ? undefined : "allowed/src/entry.ts");
    }
    assert.equal(releases, 3);

    const nestedResponse = await architectureOverviewTool.execute({ path: "/repo/allowed/src", scope: "all" }, ctx);
    const nestedPayload = JSON.parse(nestedResponse.content[0]!.text);
    assert.equal(nestedPayload.coverage.publishedFileCount, 2);
    assert.equal(nestedPayload.packageArchitecture.coverage.includedUnownedFileCount, 0);
    assert.deepEqual(nestedPayload.packageArchitecture.packages.map((pkg: { packageRoot: string }) => pkg.packageRoot), ["allowed"]);
    assert.doesNotMatch(JSON.stringify(nestedPayload), /private|secret|allowed-extra|prefix-sibling|pnpm-workspace/);
    assert.equal(releases, 4);
});
