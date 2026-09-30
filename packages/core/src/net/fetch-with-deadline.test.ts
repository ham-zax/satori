import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getEventListeners } from "node:events";
import { ReadableStream } from "node:stream/web";
import { BoundedHttpError, fetchWithDeadline } from "./fetch-with-deadline";

type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

interface TestServer {
    url: string;
    requestCount: () => number;
    connectionCount: () => number;
    closedConnectionCount: () => number;
    close: () => Promise<void>;
}

// Polls until `predicate` holds or `timeoutMs` elapses, so tests can wait for
// deterministic connection release without fixed sleeps. The caller's
// assertion reports the actual values when the wait expires.
// Idle keep-alive connections close on undici's pool timeout: well under 1s on
// Node 24, ~3s on Node 22.13. Closure checks must outlast it; leaked sockets never close.
const IDLE_CONNECTION_CLOSE_MS = 5000;

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function startServer(handler: Handler): Promise<TestServer> {
    const server = createServer(handler);
    let requests = 0;
    let connections = 0;
    let closedConnections = 0;
    server.on("request", () => {
        requests += 1;
    });
    server.on("connection", (connection) => {
        connections += 1;
        connection.on("close", () => {
            closedConnections += 1;
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requestCount: () => requests,
        connectionCount: () => connections,
        closedConnectionCount: () => closedConnections,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function closedPort(): Promise<number> {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

const basePolicy = {
    retryDelayMs: 5,
    maxResponseBytes: 8 * 1024 * 1024,
    retryableStatuses: new Set<number>([503]),
    retryableNetworkCodes: new Set<string>(["ECONNREFUSED"]),
};

test("times out a hung request", async (t) => {
    const server = await startServer(() => {
        // Never respond: the connection stays open until the deadline fires.
    });
    t.after(() => server.close());

    await assert.rejects(
        fetchWithDeadline({
            url: `${server.url}/hang`,
            init: { method: "GET" },
            attemptTimeoutMs: 150,
            maxAttempts: 2,
            ...basePolicy,
        }),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.name, "BoundedHttpError");
            assert.equal(error.kind, "timeout");
            assert.equal(error.status, null);
            assert.equal(error.attempts, 2);
            return true;
        },
    );
});

test("retries one listed transient status", async (t) => {
    let served = 0;
    const server = await startServer((_req, res) => {
        served += 1;
        if (served === 1) {
            res.writeHead(503, { "Content-Type": "text/plain" });
            res.end("unavailable");
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
    });
    t.after(() => server.close());

    const response = await fetchWithDeadline({
        url: `${server.url}/retry`,
        init: { method: "GET" },
        attemptTimeoutMs: 1000,
        maxAttempts: 2,
        ...basePolicy,
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(server.requestCount(), 2);
});

test("does not retry an unlisted 401", async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("denied");
    });
    t.after(() => server.close());

    const response = await fetchWithDeadline({
        url: `${server.url}/denied`,
        init: { method: "GET" },
        attemptTimeoutMs: 1000,
        maxAttempts: 3,
        ...basePolicy,
    });

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "denied");
    assert.equal(server.requestCount(), 1);
});

test("exhausted transient status fails with transient_http and the last status", async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("unavailable");
    });
    t.after(() => server.close());

    await assert.rejects(
        fetchWithDeadline({
            url: `${server.url}/always-503`,
            init: { method: "GET" },
            attemptTimeoutMs: 1000,
            maxAttempts: 2,
            ...basePolicy,
        }),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, "transient_http");
            assert.equal(error.status, 503);
            assert.equal(error.attempts, 2);
            return true;
        },
    );
    assert.equal(server.requestCount(), 2);
});

test("does not retry caller cancellation", async (t) => {
    const server = await startServer(() => {
        // Hang so only cancellation can terminate the attempt.
    });
    t.after(() => server.close());

    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error("caller cancelled"));
    }, 60);

    try {
        await assert.rejects(
            fetchWithDeadline({
                url: `${server.url}/hang`,
                init: { method: "GET" },
                signal: controller.signal,
                attemptTimeoutMs: 10_000,
                maxAttempts: 3,
                ...basePolicy,
            }),
            (error: unknown) => error instanceof Error && error.message === "caller cancelled",
        );
        assert.equal(server.connectionCount(), 1);
    } finally {
        clearTimeout(timer);
    }
});

test("rejects a response body above the byte limit", async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(4096));
    });
    t.after(() => server.close());

    const response = await fetchWithDeadline({
        url: `${server.url}/large`,
        init: { method: "GET" },
        attemptTimeoutMs: 1000,
        maxAttempts: 1,
        ...basePolicy,
        maxResponseBytes: 1024,
    });

    assert.equal(response.status, 200);
    await assert.rejects(
        () => response.text(),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, "response_too_large");
            assert.equal(error.status, null);
            return true;
        },
    );
});

test("preserves response status and headers on success", async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(201, {
            "Content-Type": "application/json",
            "X-Custom": "yes",
        });
        res.end('{"ok":true}');
    });
    t.after(() => server.close());

    const response = await fetchWithDeadline({
        url: `${server.url}/ok`,
        init: { method: "GET" },
        attemptTimeoutMs: 1000,
        maxAttempts: 1,
        ...basePolicy,
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("x-custom"), "yes");
    assert.equal(await response.text(), '{"ok":true}');
});

test("times out a stalled response body after the headers", async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.flushHeaders();
        // Never write the body: the deadline must cover body consumption.
    });
    t.after(() => server.close());

    const response = await fetchWithDeadline({
        url: `${server.url}/stall-body`,
        init: { method: "GET" },
        attemptTimeoutMs: 150,
        maxAttempts: 1,
        ...basePolicy,
    });

    assert.equal(response.status, 200);
    await assert.rejects(
        () => response.text(),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, "timeout");
            return true;
        },
    );
});

test("retries a listed retryable network error up to maxAttempts", async () => {
    // Deterministic injection: a stub fetch that always fails with a listed
    // retryable network code, so the retry count never depends on how the
    // environment classifies a real ECONNREFUSED.
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        const error = new Error("injected deterministic retryable network failure");
        (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
        throw error;
    }) as typeof fetch;

    try {
        await assert.rejects(
            fetchWithDeadline({
                url: "http://injected.test/unused",
                init: { method: "GET" },
                attemptTimeoutMs: 1000,
                maxAttempts: 2,
                ...basePolicy,
            }),
            (error: unknown) => {
                assert.ok(error instanceof BoundedHttpError);
                assert.equal(error.kind, "network");
                assert.equal(error.status, null);
                assert.equal(error.attempts, 2);
                assert.equal(calls, 2);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("does not retry an unlisted network error", async (_t) => {
    const port = await closedPort();

    await assert.rejects(
        fetchWithDeadline({
            url: `http://127.0.0.1:${port}/refused`,
            init: { method: "GET" },
            attemptTimeoutMs: 1000,
            maxAttempts: 3,
            ...basePolicy,
            retryableNetworkCodes: new Set<string>(),
        }),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, "network");
            assert.equal(error.attempts, 1);
            return true;
        },
    );
});

test("releases retry-delay abort listeners from a shared caller signal", async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("unavailable");
    });
    t.after(() => server.close());

    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, "abort").length;

    // maxAttempts=2 with an always-503 server: every call runs one retry
    // delay on the shared caller signal, which is exactly the leak scenario.
    for (let i = 0; i < 5; i += 1) {
        await assert.rejects(
            fetchWithDeadline({
                url: `${server.url}/always-503`,
                init: { method: "GET" },
                signal: controller.signal,
                attemptTimeoutMs: 1000,
                maxAttempts: 2,
                ...basePolicy,
            }),
            (error: unknown) => {
                assert.ok(error instanceof BoundedHttpError);
                assert.equal(error.kind, "transient_http");
                assert.equal(error.status, 503);
                return true;
            },
        );
    }

    // No delay listener may survive completion: the shared signal must be
    // back at its baseline instead of accumulating one closure per retry.
    assert.equal(getEventListeners(controller.signal, "abort").length, baseline);
    assert.equal(server.requestCount(), 10);
});

test("cancels the underlying reader exactly once when the byte limit is exceeded", async (t) => {
    const realFetch = globalThis.fetch;
    const cancelReasons: unknown[] = [];
    const spyBody = new ReadableStream<Uint8Array>({
        start(controller) {
            const chunk = new Uint8Array(1024).fill(0x61);
            controller.enqueue(chunk);
            controller.enqueue(chunk);
            controller.enqueue(chunk);
        },
        cancel(reason) {
            cancelReasons.push(reason);
        },
    });
    globalThis.fetch = (async () => new Response(spyBody, { status: 200 })) as typeof fetch;
    t.after(() => {
        globalThis.fetch = realFetch;
    });

    const response = await fetchWithDeadline({
        url: "http://spy.invalid/large",
        init: { method: "GET" },
        attemptTimeoutMs: 1000,
        maxAttempts: 1,
        ...basePolicy,
        maxResponseBytes: 2048,
    });

    await assert.rejects(
        () => response.text(),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, "response_too_large");
            return true;
        },
    );

    // The wrapped stream must release the original reader (and with it the
    // socket) instead of leaving it parked with unread body data.
    assert.equal(cancelReasons.length, 1);
    assert.ok(cancelReasons[0] instanceof BoundedHttpError);
    assert.equal((cancelReasons[0] as BoundedHttpError).kind, "response_too_large");
});

test("repeated oversized responses release every connection instead of accumulating them", async (t) => {
    const server = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(512 * 1024));
    });
    t.after(() => server.close());

    for (let i = 0; i < 5; i += 1) {
        const response = await fetchWithDeadline({
            url: `${server.url}/large`,
            init: { method: "GET" },
            attemptTimeoutMs: 2000,
            maxAttempts: 1,
            ...basePolicy,
            maxResponseBytes: 4096,
        });
        await assert.rejects(
            () => response.text(),
            (error: unknown) => {
                assert.ok(error instanceof BoundedHttpError);
                assert.equal(error.kind, "response_too_large");
                return true;
            },
        );
    }
    assert.equal(server.requestCount(), 5);

    // A body abandoned above the byte limit must not keep its connection
    // parked with unread data: every connection that was opened must be
    // released deterministically, otherwise the count below accumulates.
    await waitUntil(() => server.closedConnectionCount() === server.connectionCount(), IDLE_CONNECTION_CLOSE_MS);
    assert.ok(server.connectionCount() >= 2, "the storm must have exercised real connections");
    assert.equal(server.closedConnectionCount(), server.connectionCount());
});

test("keeps the caller signal free of abort listeners after success and each terminal error", async (t) => {
    const server = await startServer((req, res) => {
        if (req.url === "/ok") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
            return;
        }
        if (req.url === "/large") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("x".repeat(64 * 1024));
            return;
        }
        // /stall and /hang: headers arrive, the body never does, so body
        // consumption is what ends the attempt.
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.flushHeaders();
    });
    t.after(() => server.close());

    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, "abort").length;

    // Success: fully consumed body.
    const ok = await fetchWithDeadline({
        url: `${server.url}/ok`,
        init: { method: "GET" },
        signal: controller.signal,
        attemptTimeoutMs: 1000,
        maxAttempts: 1,
        ...basePolicy,
    });
    assert.equal(await ok.text(), '{"ok":true}');
    assert.equal(getEventListeners(controller.signal, "abort").length, baseline);

    // Byte-limit exceedance.
    const large = await fetchWithDeadline({
        url: `${server.url}/large`,
        init: { method: "GET" },
        signal: controller.signal,
        attemptTimeoutMs: 1000,
        maxAttempts: 1,
        ...basePolicy,
        maxResponseBytes: 1024,
    });
    await assert.rejects(
        () => large.text(),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, "response_too_large");
            return true;
        },
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, baseline);

    // Attempt timeout while the body is stalled.
    const stalled = await fetchWithDeadline({
        url: `${server.url}/stall`,
        init: { method: "GET" },
        signal: controller.signal,
        attemptTimeoutMs: 150,
        maxAttempts: 1,
        ...basePolicy,
    });
    await assert.rejects(
        () => stalled.text(),
        (error: unknown) => {
            assert.ok(error instanceof BoundedHttpError);
            assert.equal(error.kind, "timeout");
            return true;
        },
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, baseline);

    // Caller cancellation during body consumption, on a fresh signal.
    const cancelController = new AbortController();
    const cancelBaseline = getEventListeners(cancelController.signal, "abort").length;
    const hanging = await fetchWithDeadline({
        url: `${server.url}/hang`,
        init: { method: "GET" },
        signal: cancelController.signal,
        attemptTimeoutMs: 10_000,
        maxAttempts: 1,
        ...basePolicy,
    });
    const timer = setTimeout(() => {
        cancelController.abort(new Error("caller cancelled"));
    }, 60);
    try {
        await assert.rejects(
            () => hanging.text(),
            (error: unknown) => error instanceof Error && error.message === "caller cancelled",
        );
    } finally {
        clearTimeout(timer);
    }
    assert.equal(getEventListeners(cancelController.signal, "abort").length, cancelBaseline);
});

test("reuses one connection across successful responses and closes deterministically after oversized ones", async (t) => {
    let oversized = false;
    const server = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(oversized ? "x".repeat(512 * 1024) : "ok");
    });
    t.after(() => server.close());

    const call = () => fetchWithDeadline({
        url: `${server.url}/mixed`,
        init: { method: "GET" },
        attemptTimeoutMs: 2000,
        maxAttempts: 1,
        ...basePolicy,
        maxResponseBytes: 4096,
    });

    for (let i = 0; i < 3; i += 1) {
        const response = await call();
        assert.equal(await response.text(), "ok");
        // Let the completed connection settle back into the keep-alive pool
        // so the reuse assertion below is deterministic instead of racing
        // the pool's bookkeeping.
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Fully consumed responses must keep reusing the same keep-alive
    // connection instead of churning new ones.
    assert.equal(server.connectionCount(), 1);

    oversized = true;
    for (let i = 0; i < 3; i += 1) {
        const response = await call();
        await assert.rejects(
            () => response.text(),
            (error: unknown) => {
                assert.ok(error instanceof BoundedHttpError);
                assert.equal(error.kind, "response_too_large");
                return true;
            },
        );
    }

    // Service continuity: a normal response still succeeds after the storm.
    oversized = false;
    const response = await call();
    assert.equal(await response.text(), "ok");

    // Deterministic closure: no connection may stay open with unread body
    // data, and the server must shut down without hanging on leaked sockets.
    await waitUntil(() => server.closedConnectionCount() === server.connectionCount(), IDLE_CONNECTION_CLOSE_MS);
    assert.equal(server.closedConnectionCount(), server.connectionCount());
    await Promise.race([
        server.close(),
        new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("server.close() did not complete promptly")), 1000);
        }),
    ]);
});

test("direct response.body.cancel() sets settled state and cleans up abort listener", async (t) => {
    // Spy fetch: the response body is a real ReadableStream whose cancel hook
    // records how often and with which reason it was cancelled. No network is
    // involved, so no HTTP server is needed in this test.
    const realFetch = globalThis.fetch;
    let cancelCount = 0;
    let cancelReasonPassed: unknown;
    const underlyingStream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("partial data"));
        },
        cancel(reason) {
            cancelCount += 1;
            cancelReasonPassed = reason;
            return Promise.resolve();
        },
    });
    globalThis.fetch = (async () => new Response(underlyingStream, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
    })) as typeof fetch;
    t.after(() => {
        globalThis.fetch = realFetch;
    });

    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, "abort").length;

    const response = await fetchWithDeadline({
        url: "http://spy.invalid/direct-cancel",
        init: { method: "GET" },
        signal: controller.signal,
        attemptTimeoutMs: 50,
        maxAttempts: 1,
        ...basePolicy,
    });

    assert.ok(response.body);

    const cancelReason = new Error("direct body cancel");
    await response.body.cancel(cancelReason);

    // The caller's reason must reach the underlying stream's cancel hook
    // exactly once, forwarded verbatim through the wrapper's reader.
    assert.equal(cancelCount, 1);
    assert.equal(cancelReasonPassed, cancelReason);

    // The caller signal must be back at its baseline: no abort listener may
    // survive the direct cancel.
    assert.equal(getEventListeners(controller.signal, "abort").length, baseline);

    // A repeated cancel on the already-settled stream resolves without
    // invoking the underlying cancel hook a second time.
    await assert.doesNotReject(() => response.body!.cancel("second cancel"));
    assert.equal(cancelCount, 1);

    // Wait past the 50ms attempt deadline: its firing must not issue a second
    // reader cancellation now that the stream is settled.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(cancelCount, 1);

    // The settled stream reads as closed.
    const reader = response.body.getReader();
    const chunk = await reader.read();
    assert.equal(chunk.value, undefined);
    assert.equal(chunk.done, true);
});
