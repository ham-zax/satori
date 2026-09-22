import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEventListeners } from 'node:events';
import { ClusterManager, type CreateFreeClusterRequest, type DescribeClusterResponse } from './zilliz-utils';

type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

interface TestServer {
    url: string;
    close: () => Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function withMutedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
        return await fn();
    } finally {
        console.error = originalConsoleError;
    }
}

// Deterministic construction: env vars take priority in ClusterManager, so pin
// them to known values regardless of the host environment.
const originalBaseUrl = process.env.ZILLIZ_BASE_URL;
const originalToken = process.env.MILVUS_TOKEN;
process.env.ZILLIZ_BASE_URL = '';
process.env.MILVUS_TOKEN = 'test-token';

after(() => {
    if (originalBaseUrl === undefined) {
        delete process.env.ZILLIZ_BASE_URL;
    } else {
        process.env.ZILLIZ_BASE_URL = originalBaseUrl;
    }
    if (originalToken === undefined) {
        delete process.env.MILVUS_TOKEN;
    } else {
        process.env.MILVUS_TOKEN = originalToken;
    }
});

const DESCRIBE_RUNNING: DescribeClusterResponse = {
    clusterId: 'cluster-1',
    clusterName: 'demo',
    projectId: 'project-1',
    description: 'demo cluster',
    regionId: 'gcp-us-west1',
    cuType: 'Standard',
    plan: 'Free',
    status: 'RUNNING',
    connectAddress: 'https://demo.example.zillizcloud.com',
    privateLinkAddress: '',
    createTime: '2026-01-01T00:00:00Z',
    cuSize: 1,
    storageSize: 1,
    snapshotNumber: 0,
    createProgress: 100,
};

const DESCRIBE_INITIALIZING: DescribeClusterResponse = {
    ...DESCRIBE_RUNNING,
    status: 'INITIALIZING',
    createProgress: 40,
};

const CREATE_REQUEST: CreateFreeClusterRequest = {
    clusterName: 'demo',
    projectId: 'project-1',
    regionId: 'gcp-us-west1',
};

test('listProjects times out', { timeout: 5000 }, async (t) => {
    const server = await startServer(() => {
        // Never respond: the connection stays open until the attempt deadline fires.
    });
    t.after(() => server.close());

    const manager = new ClusterManager({
        baseUrl: server.url,
        token: 'test-token',
        httpPolicy: { attemptTimeoutMs: 100, maxAttempts: 1, retryDelayMs: 5 },
    });

    await withMutedConsoleError(async () => {
        await assert.rejects(manager.listProjects(), (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, /timed out/i);
            assert.ok(!message.includes('test-token'), 'error message must not leak the token');
            return true;
        });
    });
});

test('describeCluster retries one transient failure', async (t) => {
    let served = 0;
    const server = await startServer((_req, res) => {
        served += 1;
        if (served === 1) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('unavailable');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: DESCRIBE_RUNNING }));
    });
    t.after(() => server.close());

    const manager = new ClusterManager({
        baseUrl: server.url,
        token: 'test-token',
        httpPolicy: { retryDelayMs: 5 },
    });

    const cluster = await manager.describeCluster('cluster-1');
    assert.equal(cluster.status, 'RUNNING');
    assert.equal(served, 2, 'one transient failure must be retried once');
});

test('createFreeCluster does not duplicate the create request', async (t) => {
    let createCount = 0;
    const server = await startServer((req, res) => {
        if (req.url?.includes('/createFree')) {
            createCount += 1;
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end('{"message":"temporarily unavailable"}');
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });
    t.after(() => server.close());

    const manager = new ClusterManager({
        baseUrl: server.url,
        token: 'test-token',
        httpPolicy: { retryDelayMs: 5, maxAttempts: 2 },
    });

    await withMutedConsoleError(async () => {
        await assert.rejects(manager.createFreeCluster(CREATE_REQUEST), /Zilliz API request failed/);
    });
    assert.equal(createCount, 1, 'the create request must never be duplicated by a retry');
});

test('polling cancellation stops future describe calls', { timeout: 5000 }, async (t) => {
    let describeCount = 0;
    let resolveFirstDescribe: () => void = () => undefined;
    const firstDescribe = new Promise<void>((resolve) => {
        resolveFirstDescribe = resolve;
    });

    const server = await startServer((req, res) => {
        if (req.url?.includes('/createFree')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                code: 0,
                data: { clusterId: 'cluster-1', username: 'u', password: 'p', prompt: 'pr' },
            }));
            return;
        }
        if (req.url?.startsWith('/v2/clusters/')) {
            describeCount += 1;
            resolveFirstDescribe();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0, data: DESCRIBE_INITIALIZING }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });
    t.after(() => server.close());

    const manager = new ClusterManager({ baseUrl: server.url, token: 'test-token' });
    const controller = new AbortController();

    const polling = withMutedConsoleError(() => manager.createFreeCluster(
        CREATE_REQUEST,
        5000,
        1000,
        controller.signal,
    ));

    await firstDescribe;
    controller.abort(new Error('cancelled by test'));

    await assert.rejects(polling, /cancelled by test/);
    assert.equal(describeCount, 1, 'no further describe calls may run after cancellation');
});

test('oversized management response is rejected', async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            code: 0,
            data: [
                { projectId: 'p1', projectName: 'big', instanceCount: 1, createTime: 't', padding: 'x'.repeat(10_000) },
            ],
        }));
    });
    t.after(() => server.close());

    const manager = new ClusterManager({
        baseUrl: server.url,
        token: 'test-token',
        httpPolicy: { maxResponseBytes: 256 },
    });

    await withMutedConsoleError(async () => {
        await assert.rejects(manager.listProjects(), (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, /exceeded/i);
            assert.ok(!message.includes('test-token'), 'error message must not leak the token');
            return true;
        });
    });
});

test('polling releases abort listeners from a shared caller signal', { timeout: 5000 }, async (t) => {
    let describeCount = 0;
    const server = await startServer((req, res) => {
        if (req.url?.includes('/createFree')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                code: 0,
                data: { clusterId: 'cluster-1', username: 'u', password: 'p', prompt: 'pr' },
            }));
            return;
        }
        if (req.url?.startsWith('/v2/clusters/')) {
            describeCount += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0, data: describeCount < 3 ? DESCRIBE_INITIALIZING : DESCRIBE_RUNNING }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });
    t.after(() => server.close());

    const manager = new ClusterManager({
        baseUrl: server.url,
        token: 'test-token',
        httpPolicy: { attemptTimeoutMs: 1000, maxAttempts: 1, retryDelayMs: 5 },
    });
    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, 'abort').length;

    // Two poll cycles run abortableDelay on the shared signal (describes 1-2
    // report INITIALIZING), then the third describe reports RUNNING.
    const created = await withMutedConsoleError(() => manager.createFreeCluster(
        CREATE_REQUEST,
        5000,
        5,
        controller.signal,
    ));
    assert.equal(created.clusterId, 'cluster-1');
    assert.ok(describeCount >= 3, `expected at least 3 describes, saw ${describeCount}`);

    // No poll-delay listener may survive completion: the shared signal must
    // be back at its baseline instead of accumulating one closure per cycle.
    assert.equal(getEventListeners(controller.signal, 'abort').length, baseline);
});
