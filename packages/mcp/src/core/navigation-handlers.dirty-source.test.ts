import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSymbolRegistry, type PublicationLease, type RelationshipRecord, type SymbolRecord } from "@satori-code/core";
import { ToolHandlers } from "./handlers.js";
import { NavigationHandlers, type NavigationSourceOptions } from "./navigation-handlers.js";
import { RelationshipBackedCallGraph, type RelationshipBackedCallGraphInput } from "./relationship-backed-call-graph.js";
import { createSessionWorkspacePolicy } from "./session-workspace-policy.js";
import { detectChangeImpact } from "./change-impact.js";
import { detectChangesTool } from "../tools/detect_changes.js";
import { readFileTool } from "../tools/read_file.js";
import type { ToolContext } from "../tools/types.js";
import type { CallGraphResponseEnvelope, FileOutlineInput, FileOutlineResponseEnvelope } from "./search-types.js";

const published = Buffer.from("def target():\n    return other()\n\ndef other():\n    return 2\n");
const callerSource = "def caller():\n    target()\n";

function fixture(t: { after: (cleanup: () => void) => void }, options: { seedHash?: string } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "navigation-drift-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "seed.py"), published);
    fs.writeFileSync(path.join(root, "caller.py"), callerSource);
    const record = (name: string, file: string, startLine: number, endLine: number, bytes: Buffer | string): SymbolRecord => ({
        symbolKey: name, symbolInstanceId: name, name, qualifiedName: name, label: `function ${name}`,
        language: "python", kind: "function", file, span: { startLine, endLine, startColumn: 1, endColumn: 1 },
        parentQualifiedNamePath: [], fileHash: file === "seed.py" && options.seedHash !== undefined
            ? options.seedHash : createHash("sha256").update(bytes).digest("hex"), extractorVersion: "fixture",
    });
    const target = record("target", "seed.py", 1, 2, published);
    const other = record("other", "seed.py", 4, 5, published);
    const caller = record("caller", "caller.py", 1, 2, callerSource);
    const manifest = { files: [{ path: "seed.py" }, { path: "caller.py" }], builtAt: "2026-10-20" };
    const registry = buildSymbolRegistry({ manifest: manifest as never, symbols: [target, other, caller] });
    const relationships: RelationshipRecord[] = [{ sourceKey: "caller", sourceInstanceId: "caller", targetKey: "target", targetInstanceId: "target",
        type: "CALLS", confidence: "high", resolutionAuthority: "direct_binding", strategy: "rule", file: "caller.py", span: { startLine: 2, endLine: 2 } },
        { sourceKey: "target", sourceInstanceId: "target", targetKey: "other", targetInstanceId: "other", type: "CALLS",
            confidence: "high", resolutionAuthority: "direct_binding", strategy: "rule", file: "seed.py", span: { startLine: 2, endLine: 2 } }];
    const relationshipManifest = { schemaVersion: "relationship_v3", symbolRegistryManifestHash: "registry", relationshipVersion: "fixture",
        builtAt: "2026-10-20", files: [], providerCoverage: [] };
    const navigationStore = {
        getRelationships: async () => ({ status: "ok", rootPath: root, manifestHash: "relationships", manifest: relationshipManifest, records: relationships, warnings: [] }),
        getResolutionEvidence: async () => ({ status: "ok", rootPath: root, manifest: relationshipManifest, matches: [], warnings: [] }),
        getSymbols: async () => ({ status: "ok", rootPath: root, registry, manifestHash: "registry" }),
    };
    const graph = new RelationshipBackedCallGraph({ navigationStore: navigationStore as never });
    let releases = 0;
    const lease = { id: "publication", publication: { id: "publication", canonicalRoot: root, createdAt: "2026-10-20" },
        release: () => { releases += 1; } } as unknown as PublicationLease;
    const host = Object.assign(Object.create(ToolHandlers.prototype), {
        prepareNavigationRead: async () => ({ state: "ready", root: { path: root }, publication: lease }),
        acquirePublicationLease: () => lease, isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid", isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload, normalizeRelativeFilePath: (file: string) => file, stringifyToolJson: JSON.stringify,
        touchWatchedCodebase: async () => undefined, isCallGraphLanguageSupported: () => true, getOutlineStatusForLanguage: () => "ok",
        loadPreparedNavigationSymbolsByFile: async (_prepared: unknown, file: string) => ({ status: "ok", registry, manifestHash: "registry", symbols: registry.symbolsByFile.get(file) ?? [] }),
        loadPreparedNavigationCompatibility: async () => ({ relationships: { status: "ok", manifestHash: "relationships", manifest: relationshipManifest, records: relationships, warnings: [] } }),
        loadPreparedNavigationAnalysisEvidence: async () => ({ status: "ok", analysisByFile: new Map() }),
        getPublicationNavigationAddress: () => ({ publicationId: "publication", navigationRoot: root }),
        loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: true }),
        buildRegistrySymbolCallGraphHint: (symbol: SymbolRecord) => ({ supported: true, symbolRef: { file: symbol.file, symbolId: symbol.symbolInstanceId } }),
        buildOutlineSpanWarningCodes: () => [],
        buildRelationshipBackedCallGraph: graph.build.bind(graph),
        toolResponseBuilders: { buildInvalidFileOutlineRequestPayload: (_root: string, _file: string, message: string) => { throw new Error(message); },
            buildInvalidCallGraphRequestPayload: (_ctx: unknown, message: string) => { throw new Error(message); } },
    });
    const handlers = new NavigationHandlers(host);
    const policy = createSessionWorkspacePolicy({ roots: [root], homeDirectory: os.homedir(), stateRoot: path.join(root, "state") });
    const outline = async (options?: NavigationSourceOptions, args: Partial<FileOutlineInput> = {}) =>
        JSON.parse((await handlers.handleFileOutline({ path: root, file: "seed.py", ...args }, policy, options)).content[0].text) as FileOutlineResponseEnvelope;
    const callGraph = async (options?: NavigationSourceOptions, direction = "callers") => JSON.parse((await handlers.handleCallGraph({ path: root,
        symbolRef: { file: "seed.py", symbolId: "target" }, direction, depth: 1, limit: 20 }, policy, undefined, options)).content[0].text) as CallGraphResponseEnvelope;
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    const commit = () => { git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"); };
    const drift = () => fs.writeFileSync(path.join(root, "seed.py"), "# inserted\n".repeat(10) + published.toString().replace("return other()", "return missing()"));
    return { root, target, other, caller, handlers, host, policy, outline, callGraph, commit, git, drift, registry, relationships,
        releases: () => releases };
}

test("public outline retains published coordinates on readable drift while strict consumers refuse", async t => {
    const f = fixture(t);
    const before = await f.outline();
    assert.equal(before.status, "ok");
    f.drift();
    for (const detail of ["summary", "relationships", "relationship_coverage"] as const) {
        const result = await f.outline(undefined, { detail, resolveMode: "exact", symbolIdExact: "target" });
        assert.equal(result.status, "ok");
        assert.deepEqual(result.outline?.symbols.map(symbol => [symbol.symbolId, symbol.span]), before.outline?.symbols.filter(symbol => symbol.symbolId === "target").map(symbol => [symbol.symbolId, symbol.span]));
        assert.equal(result.freshness?.sourceState, "stale");
        assert.ok(result.warnings?.includes("NAVIGATION_SOURCE_DRIFT_DETECTED"));
        assert.ok(result.warnings?.includes("OUTLINE_PUBLISHED_SPANS"));
    }
    assert.equal((await f.outline({ requireCurrentSource: true })).reason, "stale_symbol_ref");
    assert.equal((await f.outline(undefined, { detail: "analysis", resolveMode: "exact", symbolIdExact: "target" })).reason, "stale_symbol_ref");
    assert.equal((await f.outline({ publishedSource: Buffer.from("wrong") })).reason, "stale_symbol_ref");
    const witnessed = await f.outline({ requireCurrentSource: true, publishedSource: published });
    assert.equal(witnessed.status, "ok");
    assert.equal(witnessed.freshness?.sourceState, "stale");
    assert.deepEqual(witnessed.outline?.symbols.map(symbol => symbol.span), [f.target.span, f.other.span]);
    fs.unlinkSync(path.join(f.root, "seed.py"));
    assert.equal((await f.outline({ publishedSource: published })).status, "not_found");
});

test("stale call graph preserves published seed, edges, authority, and actual freshness", async t => {
    const f = fixture(t);
    const before = await f.callGraph(undefined, "both");
    assert.equal(before.status, "ok");
    assert.equal(before.edges.length, 2);
    f.drift();
    for (const options of [undefined, { publishedSource: published }]) {
        const result = await f.callGraph(options, "both");
        assert.equal(result.status, "ok");
        assert.deepEqual(result.edges, before.edges);
        assert.deepEqual(result.nodes.map(node => [node.symbolId, node.span]), before.nodes.map(node => [node.symbolId, node.span]));
        assert.deepEqual(result.navigationAuthority, before.navigationAuthority);
        assert.equal(result.nodes.find(node => node.symbolId === "target")?.freshness?.sourceState, "stale");
        assert.equal(result.nodes.find(node => node.symbolId === "caller")?.freshness?.sourceState, "fresh");
        for (const warning of ["NAVIGATION_SOURCE_DRIFT_DETECTED", "CALL_GRAPH_PUBLISHED_SPANS", "CALL_GRAPH_SOURCE_FRESHNESS_PARTIAL"]) assert.ok(result.warnings?.includes(warning));
    }
    assert.equal((await f.callGraph({ publishedSource: Buffer.from("wrong") })).reason, "stale_symbol_ref");
    fs.unlinkSync(path.join(f.root, "seed.py"));
    assert.equal((await f.callGraph({ publishedSource: published })).reason, "stale_symbol_ref");
    assert.equal(f.releases(), 5);
});

test("published impact selects old-side symbols after leading insertions and keeps real caller edges", async t => {
    const f = fixture(t);
    f.commit();
    f.drift();
    let accepted: Buffer | undefined;
    const result = await detectChangeImpact({ path: f.root, baseRef: "HEAD", depth: 1, limit: 20 }, {
        outline: async (_file, bytes) => {
            if (bytes) { assert.deepEqual(bytes, published); accepted = bytes; }
            return f.outline({ requireCurrentSource: true, ...(bytes ? { publishedSource: bytes } : {}) });
        },
        callers: async (_root, seed, bytes) => {
            assert.equal(seed.symbolId, "target");
            assert.equal(bytes, accepted);
            return f.callGraph({ publishedSource: bytes });
        },
    });
    assert.deepEqual(result.seeds.map(seed => seed.symbolId), ["target"]);
    assert.equal(result.seeds[0]?.spanBasis, "published");
    assert.deepEqual(result.impacted.map(node => node.symbolId), ["caller"]);
    assert.ok(result.warnings.includes("IMPACT_PUBLISHED_SPANS"));
    assert.equal(result.warnings.includes("IMPACT_CURRENT_SYMBOLS_ONLY"), false);
    assert.equal(result.warnings.includes("IMPACT_MIXED_SYMBOL_SPANS"), false);
    assert.equal(result.impacted[0]?.causalPath[0]?.resolutionAuthority, "direct_binding");
});

test("published impact keeps insertion boundaries and rejects an unpublished base", async t => {
    const f = fixture(t);
    f.commit();
    fs.writeFileSync(path.join(f.root, "seed.py"), published.toString().replace("    return other()", "    x = 3\n    return other()"));
    const ports = { outline: async (_file: string, bytes?: Buffer) => f.outline({ requireCurrentSource: true, publishedSource: bytes }),
        callers: async () => f.callGraph({ publishedSource: published }) };
    const inserted = await detectChangeImpact({ path: f.root, baseRef: "HEAD", depth: 1, limit: 20 }, ports);
    assert.deepEqual(inserted.seeds.map(seed => seed.symbolId), ["target"]);
    f.git("add", ".");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "unpublished");
    fs.appendFileSync(path.join(f.root, "seed.py"), "# change\n");
    const rejected = await detectChangeImpact({ path: f.root, baseRef: "HEAD", depth: 1, limit: 20 }, ports);
    assert.deepEqual(rejected.seeds, []);
    assert.deepEqual(rejected.unavailableFiles, [{ file: "seed.py", reason: "stale_symbol_ref" }]);
    for (const warning of ["IMPACT_CURRENT_SYMBOLS_ONLY", "IMPACT_PUBLISHED_SPANS", "IMPACT_MIXED_SYMBOL_SPANS"]) {
        assert.equal(rejected.warnings.includes(warning), false, "empty results have no span-basis claim");
    }
});

test("detect_changes passes strict options and identical witness bytes on every outline page", async t => {
    const f = fixture(t);
    f.commit();
    f.drift();
    const seen: Array<{ start?: number; options?: NavigationSourceOptions }> = [];
    let witness: Buffer | undefined;
    const ctx = { workspacePolicy: f.policy, toolHandlers: {
        handleFileOutline: async (args: FileOutlineInput, _policy: unknown, options?: NavigationSourceOptions) => {
            seen.push({ start: args.start_line, options });
            assert.equal(options?.requireCurrentSource, true);
            if (!options?.publishedSource) return f.handlers.handleFileOutline(args, f.policy, options);
            if (!witness) witness = options.publishedSource;
            assert.equal(options.publishedSource, witness);
            const envelope = await f.outline(options);
            const first = args.start_line === undefined;
            return { content: [{ type: "text", text: JSON.stringify({ ...envelope, hasMore: first,
                outline: { symbols: envelope.outline!.symbols.slice(first ? 0 : 1, first ? 1 : 2) },
                ...(first ? { hints: { nextPage: { tool: "file_outline", args: { start_line: 4 } } } } : {}) }) }] };
        },
        handleCallGraph: async (_args: unknown, _policy: unknown, _signal: unknown, options?: NavigationSourceOptions) => {
            assert.equal(options?.publishedSource, witness);
            return { content: [{ type: "text", text: JSON.stringify(await f.callGraph(options)) }] };
        },
    } } as unknown as ToolContext;
    const response = await detectChangesTool.execute({ path: f.root, baseRef: "HEAD", depth: 1, limit: 20 }, ctx);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, "ok");
    assert.deepEqual(seen.map(entry => entry.start), [undefined, undefined, 4]);
    assert.deepEqual(result.seeds.map((seed: { symbolId: string }) => seed.symbolId), ["target"]);
});

test("annotated read_file returns dirty text without attaching published spans", async t => {
    const f = fixture(t);
    f.drift();
    const ctx = { workspacePolicy: f.policy, readFileMaxLines: 100, syncManager: { touchWatchedCodebase: async () => undefined },
        mutationRuntime: { listActiveMutations: () => [] },
        context: { listCurrentPublications: () => [{ publication: { canonicalRoot: f.root } }],
            getCurrentPublication: () => ({ publication: { canonicalRoot: f.root } }),
            getPublicationSourceCheckpoint: () => ({ fileHashes: [["seed.py", f.target.fileHash]] }) },
        toolHandlers: { handleFileOutline: async (args: FileOutlineInput, _policy: unknown, options?: NavigationSourceOptions) => {
            assert.equal(options?.requireCurrentSource, true);
            return f.handlers.handleFileOutline(args, f.policy, options);
        } },
    } as unknown as ToolContext;
    const result = JSON.parse((await readFileTool.execute({ path: path.join(f.root, "seed.py"), mode: "annotated" }, ctx)).content[0].text);
    assert.equal(result.outlineStatus, "requires_reindex");
    assert.equal(result.outlineReason, "stale_symbol_ref");
    assert.equal(result.outline, null);
    assert.match(result.content, /# inserted/);
});


test("Python graph readers admit only published hashes for every file and never fall back to dirty paths", async t => {
    const f = fixture(t);
    f.drift();
    fs.writeFileSync(path.join(f.root, "caller.py"), "def renamed():\n    other()\n");
    const build = f.host.buildRelationshipBackedCallGraph;
    let seedRead: string[] | undefined;
    f.host.buildRelationshipBackedCallGraph = async (input: RelationshipBackedCallGraphInput) => {
        seedRead = await input.readAuthorizedSourceLines!(f.root, "seed.py");
        assert.equal(await input.readAuthorizedSourceLines!(f.root, "caller.py"), undefined);
        return build(input);
    };
    const stale = await f.callGraph(undefined, "both");
    assert.equal(stale.status, "ok");
    assert.equal(seedRead, undefined);
    assert.equal(stale.edges.length, 2);
    assert.deepEqual(stale.nodes.find(node => node.symbolId === "target")?.span, { startLine: 1, endLine: 2 });
    const witnessed = await f.callGraph({ publishedSource: published }, "both");
    assert.equal(witnessed.status, "ok");
    assert.deepEqual(seedRead, published.toString().split(/\r?\n/));
    assert.deepEqual(witnessed.edges, stale.edges);
    assert.ok(witnessed.nodes.every(node => node.freshness?.sourceState === "stale"));
});

for (const seedHash of [undefined, "legacy-hash"]) {
    test(`unreadable seed source refuses navigation with ${seedHash ?? "SHA-256"} registry hashes`, async t => {
        const f = fixture(t, { seedHash });
        fs.unlinkSync(path.join(f.root, "seed.py"));
        assert.equal((await f.callGraph()).reason, "stale_symbol_ref");
        assert.equal((await f.callGraph({ publishedSource: published })).reason, "stale_symbol_ref");
        assert.equal(f.releases(), 2, "both unavailable-source reads release their publication lease");
    });
}

test("unknown legacy freshness does not repair Python spans from unverified current bytes", async t => {
    const f = fixture(t, { seedHash: "legacy-hash" });
    f.drift();
    const result = await f.callGraph();
    assert.equal(result.status, "ok");
    const seed = result.nodes.find(node => node.symbolId === "target");
    assert.deepEqual(seed?.span, { startLine: 1, endLine: 2 });
    assert.equal(seed?.freshness?.sourceState, "unknown");
    assert.equal(f.releases(), 1);
});

test("a supplied wrong witness refuses even fresh source and cannot bypass workspace authorization", async t => {
    const f = fixture(t);
    assert.equal((await f.outline({ publishedSource: Buffer.from("wrong") })).reason, "stale_symbol_ref");
    assert.equal((await f.callGraph({ publishedSource: Buffer.from("wrong") })).reason, "stale_symbol_ref");
    const denied = createSessionWorkspacePolicy({ roots: [], homeDirectory: os.homedir(), stateRoot: path.join(f.root, "state") });
    const outline = JSON.parse((await f.handlers.handleFileOutline({ path: f.root, file: "seed.py" }, denied, { publishedSource: published })).content[0].text);
    assert.equal(outline.status, "not_found");
    const graph = JSON.parse((await f.handlers.handleCallGraph({ path: f.root, symbolRef: { file: "seed.py", symbolId: "target" } }, denied, undefined,
        { publishedSource: published })).content[0].text);
    assert.equal(graph.reason, "stale_symbol_ref");
});
