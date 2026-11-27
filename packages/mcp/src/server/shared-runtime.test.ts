import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
    buildRuntimeIndexFingerprint,
    type ContextMcpConfig,
} from "../config.js";
import {
    SearchContinuationCoordinator,
    ToolHandlers,
    type FrozenSearchResultSet,
} from "../core/handlers.js";
import type { SearchRequestCoordinator } from "../core/search-request-coordinator.js";
import { toolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import {
    WorkspaceAuthorizationError,
    createSessionWorkspacePolicy,
} from "../core/session-workspace-policy.js";
import {
    SharedRuntimeHost,
    createSessionWorkspacePolicyFromEnv,
    resolveSessionWorkspaceRoots,
} from "./shared-runtime.js";
import { ContextMcpServer } from "./start-server.js";

function config(): ContextMcpConfig {
    return {
        name: "satori-shared-runtime-test",
        version: "1.0.0",
        stateRoot: path.join(os.tmpdir(), "satori-test-state-root"),
        executionProfile: "connected",
        networkPolicy: { kind: "remote-allowed" },
        vectorStoreProvider: "Milvus",
        milvusEndpoint: "localhost:19530",
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-code-3",
        encoderOutputDimension: 1024,
        readFileMaxLines: 1000,
        watchSyncEnabled: false,
    };
}

async function connectClient(host: SharedRuntimeHost, name: string, stateRoot: string) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = host.createSession(createSessionWorkspacePolicy({
        roots: [path.join(stateRoot, "workspace")],
        homeDirectory: os.homedir(),
        stateRoot,
    }));
    const client = new Client({ name, version: "1.0.0" });
    await session.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, session };
}

test('opted-in workspace indexing starts after handshake without blocking tools/list', async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-auto-index-session-'));
    const runtimeConfig: ContextMcpConfig = {
        ...config(), stateRoot, executionProfile: 'offline', autoIndexWorkspace: true,
    };
    const host = new SharedRuntimeHost(runtimeConfig, buildRuntimeIndexFingerprint(runtimeConfig, 1024), 'cli');
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const roots: string[] = [];
    host.getProviderRuntime().requestWorkspaceIndexing = async (root) => {
        roots.push(root);
        started();
        await completion;
    };
    t.after(async () => {
        finish();
        await host.shutdown();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });
    assert.deepEqual(roots, []);
    const { client, session } = await connectClient(host, 'auto-index', stateRoot);
    t.after(async () => { await client.close(); await session.shutdown(); });
    await startedPromise;
    assert.deepEqual(roots, [path.join(stateRoot, 'workspace')]);
    assert.equal((await client.listTools()).tools.length, Object.keys(toolRegistry).length);
    assert.equal(host.getActivity().operations, 1);
    finish();
});

test("runtime host starts when a tracked root has an incompatible current Publication", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-incompatible-startup-"));
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-incompatible-repo-")));
    // Publication layout owned by core: <state>/publications/<sha256(root)>/generations/<id>.
    const publicationRoot = path.join(stateRoot, "publications", crypto.createHash("sha256").update(repo).digest("hex"));
    const generationRoot = path.join(publicationRoot, "generations", "legacy-publication");
    fs.mkdirSync(generationRoot, { recursive: true });
    fs.writeFileSync(
        path.join(generationRoot, "publication.json"),
        JSON.stringify({ version: 1, id: "legacy-publication", canonicalRoot: repo }),
    );
    fs.writeFileSync(
        path.join(publicationRoot, "current.json"),
        JSON.stringify({ version: 1, publicationId: "legacy-publication" }),
    );
    const runtimeConfig: ContextMcpConfig = { ...config(), stateRoot };
    t.after(() => {
        fs.rmSync(stateRoot, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    });

    const host = new SharedRuntimeHost(runtimeConfig, buildRuntimeIndexFingerprint(runtimeConfig, 1024), "cli");
    await host.shutdown();

    assert.ok(fs.existsSync(path.join(generationRoot, "publication.json")));
});

test("one runtime host serves independent MCP sessions over separate transports", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-runtime-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    t.after(() => {
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });

    const runtimeConfig = config();
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    t.after(() => host.shutdown());

    const first = await connectClient(host, "first", stateRoot);
    const second = await connectClient(host, "second", stateRoot);
    t.after(async () => {
        await first.client.close();
        await first.session.shutdown();
        await second.client.close();
        await second.session.shutdown();
    });

    assert.deepEqual(host.getActivity(), { sessions: 2, operations: 0 });
    assert.equal(host.getProviderRuntime(), host.getProviderRuntime());

    const [firstTools, secondTools] = await Promise.all([
        first.client.listTools(),
        second.client.listTools(),
    ]);
    assert.deepEqual(
        firstTools.tools.map((tool) => tool.name),
        secondTools.tools.map((tool) => tool.name),
    );
    assert.equal(firstTools.tools.length, Object.keys(toolRegistry).length);

    const firstInternals = first.session as unknown as {
        continuationCoordinator: SearchContinuationCoordinator;
        resources: {
            localHandlers: ToolHandlers;
            providerRuntime: {
                providerRuntime: unknown;
                continuationCoordinator: SearchContinuationCoordinator;
            };
            toolContext: {
                context: unknown;
                syncManager: unknown;
                runtimeOwnerGate: unknown;
            };
        };
    };
    const secondInternals = second.session as unknown as {
        continuationCoordinator: SearchContinuationCoordinator;
        resources: typeof firstInternals.resources;
    };
    assert.equal(
        (firstInternals.continuationCoordinator as unknown as { pool: unknown }).pool,
        (secondInternals.continuationCoordinator as unknown as { pool: unknown }).pool,
    );
    assert.equal(
        firstInternals.resources.providerRuntime.continuationCoordinator,
        firstInternals.continuationCoordinator,
    );
    assert.equal(
        secondInternals.resources.providerRuntime.continuationCoordinator,
        secondInternals.continuationCoordinator,
    );
    assert.equal(
        firstInternals.resources.toolContext.context,
        secondInternals.resources.toolContext.context,
    );
    assert.equal(
        firstInternals.resources.toolContext.syncManager,
        secondInternals.resources.toolContext.syncManager,
    );
    assert.equal(
        firstInternals.resources.providerRuntime.providerRuntime,
        host.getProviderRuntime(),
    );
    assert.equal(
        secondInternals.resources.providerRuntime.providerRuntime,
        host.getProviderRuntime(),
    );
    assert.equal(
        firstInternals.resources.toolContext.runtimeOwnerGate,
        secondInternals.resources.toolContext.runtimeOwnerGate,
    );
    assert.equal(
        (firstInternals.resources.localHandlers as unknown as {
            mutationLeaseCoordinator: unknown;
        }).mutationLeaseCoordinator,
        (secondInternals.resources.localHandlers as unknown as {
            mutationLeaseCoordinator: unknown;
        }).mutationLeaseCoordinator,
    );
    const stored = firstInternals.continuationCoordinator.store(
        (
            firstInternals.resources.localHandlers as unknown as {
                searchRequestCoordinator: SearchRequestCoordinator;
            }
        ).searchRequestCoordinator,
        {
            value: {} as FrozenSearchResultSet,
            nextOffset: 1,
            reservedReplayBytes: 0,
            nowMs: 1,
        },
    );
    assert.equal(stored.status, "stored");
    if (stored.status !== "stored") throw new Error("Expected stored result set.");
    assert.equal(
        secondInternals.continuationCoordinator.lookup(stored.handle, 1).status,
        "not_found",
    );

    await first.client.close();
    await first.session.shutdown();
    assert.equal(
        firstInternals.continuationCoordinator.lookup(stored.handle, 1).status,
        "not_found",
    );
    assert.deepEqual(host.getActivity(), { sessions: 1, operations: 0 });

    const stillAvailable = await second.client.listTools();
    assert.equal(stillAvailable.tools.length, Object.keys(toolRegistry).length);
});

test("session shutdown waits for its active operation without stopping the host", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-operation-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const runtimeConfig = config();
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    const connected = await connectClient(host, "operation-owner", stateRoot);
    const originalTool = toolRegistry.manage_index!;
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
        releaseOperation = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
        markAborted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    toolRegistry.manage_index = {
        ...originalTool,
        execute: async (_args, ctx) => {
            observedSignal = ctx.requestSignal;
            ctx.requestSignal?.addEventListener("abort", () => markAborted(), { once: true });
            markStarted();
            await operationGate;
            return { content: [{ type: "text", text: "{}" }] };
        },
    };
    t.after(async () => {
        releaseOperation();
        toolRegistry.manage_index = originalTool;
        await connected.client.close().catch(() => undefined);
        await connected.session.shutdown();
        await host.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });

    const call = connected.client.callTool({
        name: "manage_index",
        arguments: { action: "status", path: stateRoot },
    }).catch(() => undefined);
    await started;
    let shutdownCompleted = false;
    const shutdown = connected.session.shutdown().then(() => {
        shutdownCompleted = true;
    });
    await aborted;
    assert.equal(observedSignal?.aborted, true);
    assert.ok(observedSignal?.reason instanceof SdkError);
    assert.equal(observedSignal.reason.code, SdkErrorCode.ConnectionClosed);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(host.getActivity(), { sessions: 0, operations: 1 });
    assert.equal(shutdownCompleted, false);

    releaseOperation();
    await Promise.all([call, shutdown]);
    assert.deepEqual(host.getActivity(), { sessions: 0, operations: 0 });
    assert.equal(shutdownCompleted, true);
});

test("disconnecting one session does not cancel shared provider bootstrap", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-bootstrap-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const runtimeConfig = {
        ...config(),
        voyageKey: "test-key",
        milvusEndpoint: "http://127.0.0.1:19530",
    };
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    const first = await connectClient(host, "bootstrap-first", stateRoot);
    const second = await connectClient(host, "bootstrap-second", stateRoot);
    const firstInternals = first.session as unknown as {
        resources: { toolContext: ToolContext };
    };
    const providerRuntime = host.getProviderRuntime() as unknown as {
        createRuntime(requireEmbedding: boolean): Promise<ToolContext>;
    };
    const originalCreateRuntime = providerRuntime.createRuntime.bind(providerRuntime);
    const originalSearch = toolRegistry.search_codebase!;
    let releaseBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => {
        releaseBootstrap = resolve;
    });
    let markBootstrapStarted!: () => void;
    const bootstrapStarted = new Promise<void>((resolve) => {
        markBootstrapStarted = resolve;
    });
    let bootstrapCount = 0;
    providerRuntime.createRuntime = async () => {
        bootstrapCount += 1;
        markBootstrapStarted();
        await bootstrapGate;
        return firstInternals.resources.toolContext;
    };
    toolRegistry.search_codebase = {
        ...originalSearch,
        execute: async (_args, context) => {
            const providerContext = await context.providerRuntime!.requireToolContext(
                "embedding_vector",
            );
            if ("code" in providerContext) {
                throw new Error(providerContext.message);
            }
            return { content: [{ type: "text", text: "{}" }] };
        },
    };
    t.after(async () => {
        releaseBootstrap();
        providerRuntime.createRuntime = originalCreateRuntime;
        toolRegistry.search_codebase = originalSearch;
        await first.client.close().catch(() => undefined);
        await first.session.shutdown();
        await second.client.close().catch(() => undefined);
        await second.session.shutdown();
        await host.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });

    const firstCall = first.client.callTool({
        name: "search_codebase",
        arguments: { path: stateRoot, query: "first" },
    }).catch(() => undefined);
    const secondCall = second.client.callTool({
        name: "search_codebase",
        arguments: { path: stateRoot, query: "second" },
    });
    await bootstrapStarted;

    let firstShutdownCompleted = false;
    const firstShutdown = first.session.shutdown().then(() => {
        firstShutdownCompleted = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstShutdownCompleted, false);
    assert.equal(bootstrapCount, 1);

    releaseBootstrap();
    await Promise.all([firstCall, secondCall, firstShutdown]);
    assert.equal(firstShutdownCompleted, true);
    assert.equal(bootstrapCount, 1);
    assert.equal((await second.client.listTools()).tools.length, Object.keys(toolRegistry).length);
    assert.deepEqual(host.getActivity(), { sessions: 1, operations: 0 });
});

test("tool context receives the session policy", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-session-policy-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const runtimeConfig = config();
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    const session = host.createSession(createSessionWorkspacePolicy({
        roots: [path.join(stateRoot, "workspace")],
        homeDirectory: os.homedir(),
        stateRoot,
    }));
    t.after(async () => {
        await session.shutdown();
        await host.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });
    const internals = session as unknown as {
        resources: { toolContext: ToolContext };
    };
    assert.equal(
        internals.resources.toolContext.workspacePolicy.authorizePath(
            path.join(stateRoot, "workspace", "src", "main.ts"),
        ).relativePath,
        "src/main.ts",
    );
    assert.equal(
        internals.resources.toolContext.workspacePolicy.roots.length,
        1,
    );
});

test("published reads retain request policy through session and provider resolution", async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-session-published-")));
    const stateRoot = path.join(base, "state");
    const workspace = path.join(base, "workspace");
    const external = path.join(base, "external");
    const sibling = path.join(base, "unindexed");
    for (const dir of [workspace, external, sibling]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(external, "main.ts"), "export function run() {}\n");
    const publicationRoot = path.join(stateRoot, "publications", crypto.createHash("sha256").update(external).digest("hex"));
    const generation = path.join(publicationRoot, "generations", "pub");
    fs.mkdirSync(generation, { recursive: true });
    fs.writeFileSync(path.join(publicationRoot, "current.json"), JSON.stringify({ version: 1, publicationId: "pub" }));
    fs.writeFileSync(path.join(generation, "publication.json"), JSON.stringify({
        version: 2, id: "pub", canonicalRoot: external, createdAt: "2026-01-01T00:00:00.000Z",
        status: "partial", navigation: null, packageOwnership: false,
        policy: { profile: "default", customExtensions: [], customIgnorePatterns: [], effectiveIgnorePatterns: [], fileBasedIgnorePatterns: [], supportedExtensions: [".ts"], policyHash: "fixture", controlSignature: "fixture" },
        format: { indexFormatVersion: "test", embeddingIdentity: "test", relationshipVersion: "test" },
        vector: { collectionName: "fixture", indexedFiles: 0, totalChunks: 0 },
    }));
    const runtimeConfig = { ...config(), stateRoot };
    const host = new SharedRuntimeHost(runtimeConfig, buildRuntimeIndexFingerprint(runtimeConfig, 1024), "cli");
    const policy = createSessionWorkspacePolicy({ roots: [workspace], homeDirectory: base, stateRoot, allowImplicitBroadContainerRoot: true });
    const session = host.createSession(policy, { autoIndexOnStart: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "published-policy", version: "1" });
    await session.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await session.shutdown(); await host.shutdown(); fs.rmSync(base, { recursive: true, force: true }); });

    const resources = (session as unknown as { resources: { toolContext: ToolContext } }).resources;
    t.mock.method(resources.toolContext.context, "getPublicationSourceCheckpoint", () => ({
        fileHashes: [["main.ts", "fixture"]],
    }) as never);
    const provider = host.getProviderRuntime();
    const sharedProviderContext = {
        context: resources.toolContext.context, syncManager: resources.toolContext.syncManager,
        runtimeFingerprint: resources.toolContext.runtimeFingerprint, capabilities: resources.toolContext.capabilities,
        reranker: null, runtimeOwnerGate: resources.toolContext.runtimeOwnerGate, readFileMaxBytes: resources.toolContext.readFileMaxBytes,
    };
    t.mock.method(provider, "requireToolContext", async () => sharedProviderContext);
    const resolved = await resources.toolContext.providerRuntime!.requireToolContext("vector_only");
    assert.ok("toolHandlers" in resolved);
    const handlers = resolved.toolHandlers;
    const receivedPolicies: Array<typeof policy> = [];
    for (const method of ["handleCallGraph", "handleFileOutline"] as const) {
        const original = handlers[method].bind(handlers);
        t.mock.method(handlers, method, ((args: never, requestPolicy: typeof policy, ...rest: never[]) => {
            receivedPolicies.push(requestPolicy);
            return original(args, requestPolicy, ...rest);
        }) as typeof handlers[typeof method]);
    }
    for (const [name, args] of [
        ["call_graph", { path: external, symbolRef: { file: "main.ts", symbolLabel: "run" } }],
        ["file_outline", { path: external, file: "main.ts" }],
    ] as const) {
        const response = await client.callTool({ name, arguments: args });
        const payload = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
        assert.equal(payload.status, "requires_reindex");
        assert.equal(payload.path, external);
        const received = receivedPolicies.shift();
        assert.ok(received, `${name} reached its provider-backed handler: ${JSON.stringify(response)}`);
        assert.equal(received.authorizePath(path.join(external, "main.ts")).workspaceRoot, external);
        const denied = await client.callTool({ name, arguments: { ...args, path: sibling } });
        assert.equal(JSON.parse((denied.content as Array<{ text: string }>)[0]!.text).code, "ROOT_NOT_AUTHORIZED");
    }
    const source = await client.callTool({ name: "read_file", arguments: { path: path.join(external, "main.ts") } });
    assert.equal(source.isError, undefined, JSON.stringify(source));
    assert.match((source.content as Array<{ text: string }>)[0]!.text, /export function run/);
    const status = await client.callTool({ name: "manage_index", arguments: { action: "status", path: external } });
    const statusPayload = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
    assert.equal(statusPayload.status, "requires_reindex");
    assert.equal(statusPayload.path, external);
    for (const action of ["create", "sync", "reindex", "clear"]) {
        const denied = await client.callTool({ name: "manage_index", arguments: { action, path: external } });
        assert.equal(JSON.parse((denied.content as Array<{ text: string }>)[0]!.text).code, "ROOT_NOT_AUTHORIZED");
    }
    const requests: string[] = [];
    t.mock.method(provider, "requestAutomaticReindex", async (root: string) => { requests.push(root); return { outcome: "unavailable" }; });
    const readiness = (handlers as unknown as { trackedRootReadiness: { host: { requestAutomaticReindex(root: string, reason: "requires_reindex"): Promise<unknown> } } }).trackedRootReadiness;
    assert.deepEqual(await readiness.host.requestAutomaticReindex(external, "requires_reindex"), { outcome: "unavailable" });
    assert.deepEqual(requests, []);
    await readiness.host.requestAutomaticReindex(workspace, "requires_reindex");
    assert.deepEqual(requests, [workspace]);
});

test("two sessions may have different immutable workspace policies", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-session-policies-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const runtimeConfig = config();
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    const policyA = createSessionWorkspacePolicy({
        roots: [path.join(stateRoot, "repo-a")],
        homeDirectory: os.homedir(),
        stateRoot,
    });
    const policyB = createSessionWorkspacePolicy({
        roots: [path.join(stateRoot, "repo-b")],
        homeDirectory: os.homedir(),
        stateRoot,
    });
    const sessionA = host.createSession(policyA);
    const sessionB = host.createSession(policyB);
    t.after(async () => {
        await sessionA.shutdown();
        await sessionB.shutdown();
        await host.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });
    const internalsA = sessionA as unknown as {
        resources: { toolContext: ToolContext };
    };
    const internalsB = sessionB as unknown as {
        resources: { toolContext: ToolContext };
    };
    assert.equal(internalsA.resources.toolContext.workspacePolicy, policyA);
    assert.equal(internalsB.resources.toolContext.workspacePolicy, policyB);
    assert.notEqual(
        internalsA.resources.toolContext.workspacePolicy,
        internalsB.resources.toolContext.workspacePolicy,
    );
    assert.ok(Object.isFrozen(policyA.roots));
    assert.ok(Object.isFrozen(policyB.roots));
    assert.throws(
        () => internalsA.resources.toolContext.workspacePolicy.authorizeRoot(
            path.join(stateRoot, "repo-b"),
        ),
        (error: unknown) => error instanceof WorkspaceAuthorizationError
            && error.code === "ROOT_NOT_AUTHORIZED",
    );
});

test("tool arguments cannot expand the session roots", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-session-immutable-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const runtimeConfig = config();
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    const policy = createSessionWorkspacePolicy({
        roots: [path.join(stateRoot, "workspace")],
        homeDirectory: os.homedir(),
        stateRoot,
    });
    const session = host.createSession(policy);
    t.after(async () => {
        await session.shutdown();
        await host.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });
    const sessionPolicy = (session as unknown as {
        resources: { toolContext: ToolContext };
    }).resources.toolContext.workspacePolicy;
    // A tool-argument-shaped path outside every root stays unauthorized even
    // after the session is live: the policy cannot be mutated or expanded.
    assert.ok(Object.isFrozen(sessionPolicy));
    assert.ok(Object.isFrozen(sessionPolicy.roots));
    assert.throws(
        () => sessionPolicy.authorizePath("/etc/passwd"),
        (error: unknown) => error instanceof WorkspaceAuthorizationError
            && error.code === "ROOT_NOT_AUTHORIZED",
    );
    assert.throws(
        () => (sessionPolicy.roots as string[]).push("/etc"),
        TypeError,
    );
});

test("invalid JSON roots reject startup", () => {
    const invalid: Array<[NodeJS.ProcessEnv, RegExp]> = [
        [{ SATORI_SESSION_ROOTS_JSON: "{not json" }, /SATORI_SESSION_ROOTS_JSON/],
        [{ SATORI_SESSION_ROOTS_JSON: JSON.stringify([17]) }, /absolute/],
        [{ SATORI_SESSION_ROOTS_JSON: JSON.stringify(["relative/path"]) }, /absolute/],
        [{ SATORI_SESSION_ROOTS_JSON: JSON.stringify([]) }, /1-16/],
        [{ SATORI_SESSION_ROOTS_JSON: JSON.stringify(Array.from({ length: 17 }, () => "/tmp")) }, /1-16/],
    ];
    for (const [env, message] of invalid) {
        assert.throws(
            () => createSessionWorkspacePolicyFromEnv(env),
            (error: unknown) => error instanceof WorkspaceAuthorizationError
                && error.code === "INVALID_WORKSPACE_ROOT"
                && message.test(error.message),
        );
    }
});

test("direct stdio binds the environment-derived policy before tool execution", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-stdio-policy-"));
    const workspace = path.join(stateRoot, "workspace");
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const previousRoots = process.env.SATORI_SESSION_ROOTS_JSON;
    process.env.SATORI_STATE_ROOT = stateRoot;
    process.env.SATORI_SESSION_ROOTS_JSON = JSON.stringify([workspace]);
    const runtimeConfig = config();
    const server = new ContextMcpServer(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    t.after(async () => {
        await server.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        if (previousRoots === undefined) delete process.env.SATORI_SESSION_ROOTS_JSON;
        else process.env.SATORI_SESSION_ROOTS_JSON = previousRoots;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });
    const sessionPolicy = (server as unknown as {
        session: { resources: { toolContext: ToolContext } };
    }).session.resources.toolContext.workspacePolicy;
    assert.equal(sessionPolicy.roots.length, 1);
    assert.equal(
        sessionPolicy.authorizePath(path.join(workspace, "src", "main.ts")).relativePath,
        "src/main.ts",
    );
    assert.throws(
        () => sessionPolicy.authorizePath("/etc/passwd"),
        (error: unknown) => error instanceof WorkspaceAuthorizationError
            && error.code === "ROOT_NOT_AUTHORIZED",
    );
});

test("direct stdio and shared runtime resolve roots identically", () => {
    const roots = [
        path.join(os.tmpdir(), "satori-workspace-one"),
        path.join(os.tmpdir(), "satori-workspace-two"),
    ];
    const env = { SATORI_SESSION_ROOTS_JSON: JSON.stringify(roots) };
    assert.deepEqual(resolveSessionWorkspaceRoots(env), roots);
    const policy = createSessionWorkspacePolicyFromEnv(env);
    assert.deepEqual([...policy.roots].sort(), [...roots].sort());
    // No env variable: every session falls back to the process working
    // directory, identical for direct stdio and the shared runtime launcher.
    assert.deepEqual(resolveSessionWorkspaceRoots({}), [process.cwd()]);
});

test("shared-runtime-client warm-attach import graph stays isolated from server, config, and core barrel", () => {
    const serverDir = path.dirname(new URL(import.meta.url).pathname);
    const visited = new Set<string>();
    const queue = [path.join(serverDir, "shared-runtime-client.ts")];
    const externalSpecifiers = new Set<string>();

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const source = fs.readFileSync(current, "utf8");
        for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["'];/gm)) {
            const specifier = match[1]!;
            if (specifier.startsWith(".")) {
                const resolved = path.resolve(path.dirname(current), specifier.replace(/\.js$/, ".ts"));
                queue.push(resolved);
            } else {
                externalSpecifiers.add(specifier);
            }
        }
    }

    const relativeVisited = [...visited].map((file) => path.relative(path.resolve(serverDir, ".."), file));
    assert.equal(relativeVisited.includes("server/shared-runtime.ts"), false);
    assert.equal(relativeVisited.includes("config.ts"), false);
    assert.equal(relativeVisited.includes("core/session-workspace-policy.ts"), false);
    assert.equal(externalSpecifiers.has("@modelcontextprotocol/server"), false);
    assert.equal(externalSpecifiers.has("@satori-code/core"), false);
    assert.equal(externalSpecifiers.has("@satori-code/core/integration"), false);
    assert.equal(externalSpecifiers.has("@satori-code/core/file-lock"), true);
});

test("runtime activity includes local sync lifecycle operations", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-sync-activity-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const runtimeConfig = config();
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    t.after(async () => {
        await host.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });
    const localSyncManager = (host as unknown as {
        localSyncManager: {
            ensureFreshness(
                root: string,
                thresholdMs: number,
                options: { skipIgnoreControlCheck: boolean },
            ): Promise<unknown>;
            getActiveLifecycleOperationCount(): number;
            stopBackgroundSync(): void;
            syncCodebase(root: string): Promise<unknown>;
        };
    }).localSyncManager;
    localSyncManager.stopBackgroundSync();
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    t.mock.method(localSyncManager, "syncCodebase", async () => {
        markStarted();
        await syncGate;
        return { mode: "synced" };
    });

    assert.deepEqual(host.getActivity(), { sessions: 0, operations: 0 });

    const sync = localSyncManager.ensureFreshness("/repo", 0, { skipIgnoreControlCheck: true });
    await started;
    assert.equal(localSyncManager.getActiveLifecycleOperationCount(), 1);
    assert.deepEqual(
        host.getActivity(),
        { sessions: 0, operations: 1 },
        "an in-flight local sync is visible as a runtime operation",
    );

    releaseSync();
    await sync;
    assert.equal(localSyncManager.getActiveLifecycleOperationCount(), 0);
    assert.deepEqual(host.getActivity(), { sessions: 0, operations: 0 });
});

test("session ToolHandlers and localHandlers wire reclaimIdleMemoryForMutation to ProviderRuntime", async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-reclaim-"));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const runtimeConfig = config();
    const host = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, 1024),
        "cli",
    );
    t.after(async () => {
        await host.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });

    let reclaimCalls = 0;
    const providerRuntime = host.getProviderRuntime();
    const resources = host.createSessionResources(
        host.createSearchContinuationCoordinator(),
        createSessionWorkspacePolicy({
            roots: [path.join(stateRoot, "workspace")],
            homeDirectory: os.homedir(),
            stateRoot,
        }),
    );

    t.mock.method(providerRuntime, "requireToolContext", async () => ({
        context: resources.toolContext.context,
        syncManager: resources.toolContext.syncManager,
        runtimeFingerprint: resources.toolContext.runtimeFingerprint,
        capabilities: resources.toolContext.capabilities,
        reranker: null,
        runtimeOwnerGate: resources.toolContext.runtimeOwnerGate,
        readFileMaxBytes: resources.toolContext.readFileMaxBytes,
    }));

    const sessionContext = await resources.providerRuntime.requireToolContext("embedding_vector");
    assert.ok("toolHandlers" in sessionContext);

    for (const handlers of [sessionContext.toolHandlers, resources.localHandlers]) {
        const controller = new AbortController();
        t.mock.method(providerRuntime, "reclaimIdleMemoryForMutation", async () => {
            reclaimCalls += 1;
            controller.abort(new Error("aborted_after_reclaim"));
        });
        const runner = (handlers as unknown as {
            manageIndexingHandlers: {
                createSupervisedCandidateRunner: (
                    execution: { id: string; signal: AbortSignal },
                    action: "create" | "reindex",
                ) => (input: Record<string, unknown>) => Promise<unknown>;
            };
        }).manageIndexingHandlers.createSupervisedCandidateRunner(
            { id: "op-session-reclaim", signal: controller.signal },
            "create",
        );

        await assert.rejects(
            runner({
                codebasePath: path.join(stateRoot, "workspace"),
                forceReindex: false,
                indexPolicy: {},
                deferPartialPublication: false,
                onSourceScanCompleted: () => undefined,
                onProgress: () => undefined,
            }),
            /aborted_after_reclaim/,
        );
    }

    assert.equal(reclaimCalls, 2);
});
