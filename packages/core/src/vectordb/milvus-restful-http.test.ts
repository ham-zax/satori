import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb.js';
import { BoundedHttpError } from '../net/fetch-with-deadline.js';

type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

interface TestServer {
    url: string;
    requestCount: () => number;
    close: () => Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
    const server: Server = createServer(handler);
    let requests = 0;
    server.on('request', () => {
        requests += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requestCount: () => requests,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function okJson(res: import('node:http').ServerResponse, payload: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * Test subclass: keeps the real REST transport (including the private
 * makeRequest choke point) but skips the load-state round trip so each test
 * drives exactly the HTTP behavior under test.
 */
class HttpTestMilvusRest extends MilvusRestfulVectorDatabase {
    protected override async ensureLoaded(_collectionName: string): Promise<void> {
        // no-op: the transport layer is what these tests exercise.
    }
}

function makeDb(server: TestServer, overrides: Record<string, number> = {}): HttpTestMilvusRest {
    return new HttpTestMilvusRest({
        address: server.url,
        database: 'default',
        ...overrides,
    });
}

test('Milvus search times out', async (t) => {
    const server = await startServer(() => {
        // Never respond: the connection stays open until the deadline fires.
    });
    t.after(() => server.close());
    const db = makeDb(server, { requestTimeoutMs: 150, retryDelayMs: 5 });

    await assert.rejects(
        db.retrieveDense('collection-v1', { vector: [0.1, 0.2, 0.3, 0.4], limit: 3 }),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, 'timeout');
            assert.equal(error.status, null);
            assert.equal(error.attempts, 2);
            return true;
        },
    );
    // The bounded error records both attempts. Under scheduler pressure an
    // attempt may expire before the local server accepts its socket, so the
    // server-side request count is not a reliable retry oracle here.
});

test('Milvus read retries one 503', async (t) => {
    let searchRequests = 0;
    const server = await startServer((_req, res) => {
        searchRequests += 1;
        if (searchRequests === 1) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end('{"code":1,"message":"temporarily unavailable"}');
            return;
        }
        okJson(res, { code: 0, data: [] });
    });
    t.after(() => server.close());
    const db = makeDb(server, { retryDelayMs: 5 });

    const results = await db.retrieveDense('collection-v1', { vector: [0.1, 0.2, 0.3, 0.4], limit: 3 });
    assert.deepEqual(results, []);
    assert.equal(searchRequests, 2);
});

test('Milvus create does not retry after an ambiguous network failure', async (t) => {
    const server = await startServer((_req, res) => {
        // Ambiguous network failure: the connection dies before any HTTP status.
        res.socket?.destroy();
    });
    t.after(() => server.close());
    const db = makeDb(server, { retryDelayMs: 5 });

    await assert.rejects(
        db.createCollection('collection-v1', 4),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, 'network');
            assert.equal(error.attempts, 1);
            return true;
        },
    );
    // A create mutation must not retry an ambiguous network failure.
    assert.equal(server.requestCount(), 1);
});

test('Milvus rejects an oversized JSON response', async (t) => {
    const server = await startServer((_req, res) => {
        okJson(res, { code: 0, data: [{ id: 'x'.repeat(600) }] });
    });
    t.after(() => server.close());
    const db = makeDb(server, { maxResponseBytes: 512 });

    await assert.rejects(
        db.retrieveDense('collection-v1', { vector: [0.1, 0.2, 0.3, 0.4], limit: 3 }),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, 'response_too_large');
            return true;
        },
    );
});
