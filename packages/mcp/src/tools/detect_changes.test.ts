import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    buildSymbolRegistry,
    type NavigationResolutionEvidenceMatch,
    type PublicationLease,
    type RelationshipRecord,
    type SymbolRecord,
} from "@satori-code/core";
import { ToolHandlers } from "../core/handlers.js";
import { NavigationHandlers } from "../core/navigation-handlers.js";
import { PreparedReadCacheOwner } from "../core/prepared-read-cache-owner.js";
import { RelationshipBackedCallGraph } from "../core/relationship-backed-call-graph.js";
import { createSessionWorkspacePolicy } from "../core/session-workspace-policy.js";
import type { CallGraphResponseEnvelope, FileOutlineResponseEnvelope } from "../core/search-types.js";
import type { ToolContext } from "../tools/types.js";
import { detectChangesTool, readCompleteFileOutline } from "./detect_changes.js";

const symbol = (symbolId: string, startLine: number, endLine: number) => ({
    symbolId, symbolLabel: symbolId, kind: "method", language: "typescript", file: "big.ts", span: { startLine, endLine },
});

test("readCompleteFileOutline follows nextPage so members of a large class reach change seeding", async () => {
    const pages = new Map<number | undefined, FileOutlineResponseEnvelope>([
        [undefined, { status: "ok", path: "/r", file: "big.ts", hasMore: true,
            outline: { symbols: [symbol("Big", 1, 900), symbol("first", 2, 10)] },
            hints: { nextPage: { tool: "file_outline", args: { start_line: 500 } } } } as unknown as FileOutlineResponseEnvelope],
        [500, { status: "ok", path: "/r", file: "big.ts", hasMore: false,
            outline: { symbols: [symbol("Big", 1, 900), symbol("edited", 500, 520)] } } as unknown as FileOutlineResponseEnvelope],
    ]);
    const requested: Array<number | undefined> = [];
    const merged = await readCompleteFileOutline(async startLine => {
        requested.push(startLine);
        return pages.get(startLine)!;
    });

    assert.deepEqual(requested, [undefined, 500]);
    assert.deepEqual(merged.outline?.symbols.map(entry => entry.symbolId), ["Big", "first", "edited"]);
    assert.equal(merged.hasMore, false);
});

test("readCompleteFileOutline stops after cancellation during an outline page", async () => {
    const cancel = new AbortController();
    const reason = new Error("cancel after reading first outline page");
    let requests = 0;
    await assert.rejects(readCompleteFileOutline(async () => {
        requests += 1;
        cancel.abort(reason);
        return { status: "ok", path: "/r", file: "big.ts", hasMore: true,
            outline: { symbols: [] }, hints: { nextPage: { args: { start_line: 500 } } } };
    }, cancel.signal), (error: unknown) => error === reason);
    assert.equal(requests, 1);
});

test("detectChangesTool preserves unprojected uncertainCallReferences and directSeedTestReferences live while public handleCallGraph strips them", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-detect-changes-e2e-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const seedBase = "export function target() {\n  return 1;\n}\n";
    const callerSource = "import { target } from './seed';\nexport function caller() {\n  return target();\n}\n";
    const testSource = "import { target } from './seed';\ntest('calls target', () => {\n  target();\n});\n";
    fs.writeFileSync(path.join(root, "seed.ts"), seedBase);
    fs.writeFileSync(path.join(root, "caller.ts"), callerSource);
    fs.writeFileSync(path.join(root, "seed.test.ts"), testSource);

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });

    // Edit seed.ts in the working tree so detect_changes maps the hunk onto
    // published target() coordinates via baseRef.
    fs.writeFileSync(path.join(root, "seed.ts"), "export function target() {\n  return 2;\n}\n");

    const record = (name: string, file: string, startLine: number, endLine: number, content: string): SymbolRecord => ({
        symbolKey: name,
        symbolInstanceId: name,
        name,
        qualifiedName: name,
        label: `function ${name}()`,
        language: "typescript",
        kind: "function",
        file,
        span: { startLine, endLine, startColumn: 1, endColumn: 1 },
        parentQualifiedNamePath: [],
        fileHash: createHash("sha256").update(content).digest("hex"),
        extractorVersion: "fixture",
    });

    const target = record("target", "seed.ts", 1, 3, seedBase);
    const caller = record("caller", "caller.ts", 2, 4, callerSource);
    const testSym = record("testTarget", "seed.test.ts", 2, 4, testSource);
    const manifest = {
        files: [{ path: "seed.ts" }, { path: "caller.ts" }, { path: "seed.test.ts" }],
        builtAt: "2026-11-23T00:00:00.000Z",
    };
    const registry = buildSymbolRegistry({
        manifest: manifest as never,
        symbols: [target, caller, testSym],
    });
    const relationships: RelationshipRecord[] = [
        {
            sourceKey: caller.symbolKey,
            sourceInstanceId: caller.symbolInstanceId,
            targetKey: target.symbolKey,
            targetInstanceId: target.symbolInstanceId,
            type: "CALLS",
            confidence: "high",
            resolutionAuthority: "direct_binding",
            strategy: "rule",
            file: caller.file,
            span: { startLine: 3, endLine: 3 },
        },
        {
            sourceKey: testSym.symbolKey,
            sourceInstanceId: testSym.symbolInstanceId,
            targetKey: target.symbolKey,
            targetInstanceId: target.symbolInstanceId,
            type: "TESTS",
            confidence: "high",
            resolutionAuthority: "direct_binding",
            strategy: "rule",
            file: testSym.file,
            span: { startLine: 3, endLine: 3 },
        },
    ];
    const evidenceMatches: NavigationResolutionEvidenceMatch[] = [
        {
            matchKind: "candidate_target",
            claim: {
                providerId: "typescript",
                providerVersion: "1.0.0",
                environmentConfigId: "fixture-env",
                sourceFile: "caller.ts",
                sourceInstanceId: "caller",
                callSpan: { startLine: 3, endLine: 3, startByte: 40, endByte: 52, startColumn: 2, endColumn: 14 },
                observation: {
                    kind: "call",
                    calleeName: "target",
                    calleeText: "svc.target()",
                    construct: "typed_member_call",
                    candidates: [],
                },
                decision: "ambiguous",
                relationshipType: "CALLS",
                resolutionAuthority: "origin_flow",
                proofSteps: [],
                dependencyKeys: [],
                flowHops: 0,
            },
        },
    ];
    const relationshipManifest = {
        schemaVersion: "relationship_v3",
        symbolRegistryManifestHash: "registry-hash",
        relationshipVersion: "fixture",
        builtAt: "2026-11-23T00:00:00.000Z",
        files: [],
        providerCoverage: [],
    };
    const verifiedRelationships = {
        status: "ok",
        rootPath: root,
        manifestHash: "relationships-hash",
        manifest: relationshipManifest,
    } as const;
    const navigationStore = {
        verifyRelationships: async () => verifiedRelationships,
        getRelationships: async () => ({
            ...verifiedRelationships,
            records: relationships,
            warnings: [],
        }),
        getResolutionEvidence: async (query: { sourceInstanceId?: string }) => ({
            status: "ok",
            rootPath: root,
            manifestHash: "relationships-hash",
            manifest: relationshipManifest,
            matches: query.sourceInstanceId ? [] : evidenceMatches,
            warnings: [],
        }),
        getSymbols: async () => ({
            status: "ok",
            rootPath: root,
            registry,
            manifestHash: "registry-hash",
        }),
    };
    const graph = new RelationshipBackedCallGraph({ navigationStore: navigationStore as never });
    const lease = {
        id: "pub-1",
        publication: { id: "pub-1", canonicalRoot: root, createdAt: "2026-11-23T00:00:00.000Z" },
        release: () => undefined,
    } as unknown as PublicationLease;
    const host = Object.assign(Object.create(ToolHandlers.prototype), {
        preparedReadCacheOwner: new PreparedReadCacheOwner({
            getCurrentPublication: () => lease,
            getPublicationNavigationAddress: () => ({ publicationId: lease.id, navigationRoot: root }),
            navigationStore: navigationStore as never,
            clock: { now: Date.now },
        }),
        prepareNavigationRead: async () => ({ state: "ready", root: { path: root }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload,
        normalizeRelativeFilePath: (file: string) => file,
        stringifyToolJson: JSON.stringify,
        touchWatchedCodebase: async () => undefined,
        isCallGraphLanguageSupported: () => true,
        getOutlineStatusForLanguage: () => "ok",
        loadPreparedNavigationSymbolsByFile: async (_prepared: unknown, file: string) => ({
            status: "ok",
            registry,
            manifestHash: "registry-hash",
            symbols: registry.symbolsByFile.get(file) ?? [],
        }),
        loadPreparedNavigationCompatibility: async () => ({
            relationships: {
                status: "ok",
                manifestHash: "relationships-hash",
                manifest: relationshipManifest,
                records: relationships,
                warnings: [],
            },
        }),
        loadPreparedNavigationAnalysisEvidence: async () => ({ status: "ok", analysisByFile: new Map() }),
        getPublicationNavigationAddress: () => ({ publicationId: "pub-1", navigationRoot: root }),
        buildRegistrySymbolCallGraphHint: (symbol: SymbolRecord) => ({
            supported: true,
            symbolRef: { file: symbol.file, symbolId: symbol.symbolInstanceId },
        }),
        buildOutlineSpanWarningCodes: () => [],
        buildRelationshipBackedCallGraph: graph.build.bind(graph),
        readFileMaxBytes: 1024 * 1024,
        toolResponseBuilders: {
            buildInvalidFileOutlineRequestPayload: (_root: string, _file: string, message: string) => {
                throw new Error(message);
            },
            buildInvalidCallGraphRequestPayload: (_ctx: unknown, message: string) => {
                throw new Error(message);
            },
        },
    });
    const navigationHandlers = new NavigationHandlers(host);
    const toolHandlers = Object.assign(Object.create(ToolHandlers.prototype), {
        navigationHandlers,
        resolveIndexedRoot: () => root,
    }) as ToolHandlers;
    const workspacePolicy = createSessionWorkspacePolicy({
        roots: [root],
        homeDirectory: os.homedir(),
        stateRoot: path.join(root, "state"),
    });

    // Public handleCallGraph still projects/strips exactReferences & testReferences
    const publicGraphResponse = await toolHandlers.handleCallGraph(
        {
            path: root,
            symbolRef: { file: "seed.ts", symbolId: "target" },
            direction: "callers",
            depth: 1,
            limit: 20,
        },
        workspacePolicy,
        undefined,
        { publishedSource: Buffer.from(seedBase) },
    );
    const publicGraph = JSON.parse(publicGraphResponse.content[0].text) as CallGraphResponseEnvelope;
    assert.equal(publicGraph.status, "ok");
    assert.equal(publicGraph.exactReferences, undefined);
    assert.equal(publicGraph.testReferences, undefined);
    assert.equal(publicGraph.evidenceSummary?.testReferenceCount, 1);
    assert.equal(publicGraph.evidenceSummary?.ambiguousTargetReferenceCount, 1);

    // Live detectChangesTool.execute receives unprojected graph payload and
    // surfaces BOTH uncertainCallReferences and directSeedTestReferences.
    const ctx = {
        workspacePolicy,
        toolHandlers,
        capabilities: { getConfig: () => ({ executionProfile: "local-only" }) },
    } as unknown as ToolContext;
    const response = await detectChangesTool.execute({ path: root, baseRef: "HEAD", depth: 2, limit: 20 }, ctx);
    assert.equal(response.isError, undefined);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.seeds.map((seed: { symbolId: string }) => seed.symbolId), ["target"]);
    assert.deepEqual(result.impacted.map((node: { symbolId: string }) => node.symbolId), ["caller"]);
    assert.equal(result.uncertainCallReferences.length, 1);
    assert.equal(result.uncertainCallReferences[0]?.calleeText, "svc.target()");
    assert.deepEqual(result.directSeedTestReferences, [
        {
            seedSymbolId: "target",
            file: "seed.test.ts",
            symbolId: "testTarget",
            symbolLabel: "function testTarget()",
            span: { startLine: 2, endLine: 4 },
            siteProvenance: "recorded_call_site",
            callSite: { file: "seed.test.ts", startLine: 3, endLine: 3 },
            confidence: 0.95,
        },
    ]);
    assert.equal(result.testReferenceCoverage.scope, "direct_seed_persisted_tests_only");
    assert.equal(result.testReferenceCoverage.exhaustive, false);
    assert.equal(result.testReferenceCoverage.returnedCount, 1);
});
