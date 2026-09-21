import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
    assert.equal((await client.listTools()).tools.length, 10);
    assert.equal(host.getActivity().operations, 1);
    finish();
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
    assert.equal(firstTools.tools.length, 10);

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
    assert.equal(stillAvailable.tools.length, 10);
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
    toolRegistry.manage_index = {
        ...originalTool,
        execute: async () => {
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
    assert.equal((await second.client.listTools()).tools.length, 10);
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
