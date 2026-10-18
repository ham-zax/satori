import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { RerankerRequestError, VoyageAIReranker } from './voyageai-reranker';
import type { RerankExecutionDiagnostics } from './reranker';

test('VoyageAIReranker retry delay removes its abort listener on normal completion', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const reranker = new VoyageAIReranker({ apiKey: 'test-key', retryDelayMs: 250 });
    let completed = false;
    const delay = reranker['delayBeforeRetry'](controller.signal).then(() => { completed = true; });

    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    t.mock.timers.tick(249);
    await Promise.resolve();
    assert.equal(completed, false, 'the configured delay must elapse');
    t.mock.timers.tick(1);
    await delay;
    assert.equal(completed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(new Error('abort after completion'));
    await delay;
});

test('VoyageAIReranker retry delay preserves cancellation reason and clears its timer and listener', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clearTimer = t.mock.method(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const reason = new Error('cancel retry delay');
    const reranker = new VoyageAIReranker({ apiKey: 'test-key', retryDelayMs: 250 });
    const delay = reranker['delayBeforeRetry'](controller.signal);
    const rejection = assert.rejects(delay, (error: unknown) => error === reason);

    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    t.mock.timers.tick(249);
    controller.abort(reason);
    await rejection;
    assert.equal(clearTimer.mock.callCount(), 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    t.mock.timers.tick(1);
    await assert.rejects(delay, (error: unknown) => error === reason);
});

test('VoyageAIReranker retry delay attaches no listener or timer to a preaborted signal', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const startTimer = t.mock.method(globalThis, 'setTimeout');
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    const addListener = t.mock.method(controller.signal, 'addEventListener');
    const reranker = new VoyageAIReranker({ apiKey: 'test-key', retryDelayMs: 250 });

    await assert.rejects(reranker['delayBeforeRetry'](controller.signal), (error: unknown) => error === reason);
    assert.equal(addListener.mock.callCount(), 0);
    assert.equal(startTimer.mock.callCount(), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('VoyageAIReranker repeated retry delays retain no listeners on the same signal', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const reranker = new VoyageAIReranker({ apiKey: 'test-key', retryDelayMs: 250 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const delay = reranker['delayBeforeRetry'](controller.signal);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
        t.mock.timers.tick(250);
        await delay;
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
});

type MockFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    body?: ReadableStream<Uint8Array> | null;
}>;

async function withMockedFetch<T>(mockFetch: MockFetch, fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const response = await mockFetch(input, init);
        if (response.body !== undefined) return response;
        // Exercise body consumption while preserving each fixture's payload and injected failures.
        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    const text = response.ok ? JSON.stringify(await response.json()) : await response.text();
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            },
        });
        return new Response(body, { status: response.status });
    }) as typeof fetch;
    // A real in-flight fetch holds a socket that keeps the event loop alive; a mocked hung fetch holds nothing,
    // and Node 22.13's unref'd AbortSignal.timeout alone lets the test runner see a drained loop.
    const keepAlive = setInterval(() => undefined, 60_000);
    try {
        return await fn();
    } finally {
        clearInterval(keepAlive);
        globalThis.fetch = originalFetch;
    }
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

test('VoyageAIReranker.rerank sends the Voyage request and preserves returned documents', async () => {
    const calls: Array<{ url: string; init: NonNullable<Parameters<typeof fetch>[1]> }> = [];
    await withMockedFetch(async (url, init) => {
        assert.ok(init);
        calls.push({ url: String(url), init });
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: [
                    { index: 1, relevance_score: 0.75, document: '' },
                    { index: 0, relevance_score: 0.25, document: 'alpha document' },
                ],
            }),
            text: async () => '',
        };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', model: 'rerank-2.5' });

        const results = await reranker.rerank('find auth', ['alpha document', ''], {
            topK: 2,
            returnDocuments: true,
            truncation: false,
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.voyageai.com/v1/rerank');
        assert.equal(calls[0].init.method, 'POST');
        const headers = calls[0].init.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer voyage-test-key');
        assert.equal(headers['Content-Type'], 'application/json');
        const body = calls[0].init.body;
        assert.equal(typeof body, 'string');
        if (typeof body !== 'string') {
            throw new Error('Expected string request body');
        }
        assert.deepEqual(JSON.parse(body), {
            query: 'find auth',
            documents: ['alpha document', ''],
            model: 'rerank-2.5',
            return_documents: true,
            truncation: false,
            top_k: 2,
        });
        assert.deepEqual(results, [
            { index: 1, relevanceScore: 0.75, document: '' },
            { index: 0, relevanceScore: 0.25, document: 'alpha document' },
        ]);
    });
});

test('VoyageAIReranker.rerank rejects malformed response rows', async () => {
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                data: [
                    { index: '0', relevance_score: 0.75 },
                ],
            }),
            text: async () => '',
        }), async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key' });

            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                /invalid response row/
            );
        });
    });
});

test('VoyageAIReranker exposes its stable provider and model identity', () => {
    const reranker = new VoyageAIReranker({
        apiKey: 'voyage-test-key',
        model: 'rerank-2.5',
    });

    assert.deepEqual(reranker.getIdentity(), {
        provider: 'voyage',
        model: 'rerank-2.5',
        profile: 'voyage_reranker_api_v1',
    });
});

test('VoyageAIReranker sends a model name outside its documented table unchanged', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await withMockedFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, relevance_score: 0.5 }] }), text: async () => '' };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', model: 'rerank-9-test' });
        await reranker.rerank('find auth', ['alpha document']);
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].model, 'rerank-9-test');
});

test('VoyageAIReranker defaults to rerank-3-lite when no model is named', () => {
    const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key' });
    assert.equal(reranker.getModel(), 'rerank-3-lite');
});

test('VoyageAIReranker reports a provider 400 as one permanent failure carrying the provider message', async () => {
    const providerBody = JSON.stringify({
        detail: "Model rerank-9-test is not supported. Supported models are ['rerank-3', 'rerank-3-lite'].",
    });
    const calls: string[] = [];
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => {
            calls.push('call');
            return { ok: false, status: 400, json: async () => ({}), text: async () => providerBody };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', model: 'rerank-9-test', retryDelayMs: 0 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError, `expected RerankerRequestError, got ${String(error)}`);
                    assert.equal(error.kind, 'permanent_http');
                    assert.equal(error.status, 400);
                    assert.equal(error.attempts, 1);
                    assert.ok(error.message.includes(providerBody), error.message);
                    return true;
                },
            );
        });
    });
    assert.equal(calls.length, 1);
});

test('VoyageAIReranker retries a transient HTTP failure once and succeeds', async () => {
    const calls: string[] = [];
    await withMockedFetch(async () => {
        calls.push('call');
        if (calls.length === 1) {
            return { ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' };
        }
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, relevance_score: 0.9 }] }), text: async () => '' };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
        const results = await reranker.rerank('find auth', ['alpha document']);
        assert.equal(calls.length, 2);
        assert.equal(results.length, 1);
        assert.equal(results[0].relevanceScore, 0.9);
    });
});

test('VoyageAIReranker reports transient HTTP failure classification after both attempts', async () => {
    const calls: string[] = [];
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => {
            calls.push('call');
            return { ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError, `expected RerankerRequestError, got ${String(error)}`);
                    assert.equal(error.kind, 'transient_http');
                    assert.equal(error.status, 503);
                    assert.equal(error.attempts, 2);
                    return true;
                },
            );
        });
    });
    assert.equal(calls.length, 2);
});

test('VoyageAIReranker does not retry permanent HTTP failures', async () => {
    const calls: string[] = [];
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => {
            calls.push('call');
            return { ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError);
                    assert.equal(error.kind, 'permanent_http');
                    assert.equal(error.status, 401);
                    assert.equal(error.attempts, 1);
                    return true;
                },
            );
        });
    });
    assert.equal(calls.length, 1);
});

test('VoyageAIReranker times out per attempt and reports the timeout kind', async () => {
    const calls: string[] = [];
    await withMutedConsoleError(async () => {
        await withMockedFetch(async (url, init) => {
            calls.push('call');
            return new Promise<never>((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;
                signal?.addEventListener('abort', () => {
                    reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
                });
            });
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0, timeoutMs: 25 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError, `expected RerankerRequestError, got ${String(error)}`);
                    assert.equal(error.kind, 'timeout');
                    assert.equal(error.attempts, 2);
                    return true;
                },
            );
        });
    });
    assert.equal(calls.length, 2);
});

test('VoyageAIReranker retries a transient network failure once and succeeds', async () => {
    const calls: string[] = [];
    await withMockedFetch(async () => {
        calls.push('call');
        if (calls.length === 1) {
            throw Object.assign(new TypeError('fetch failed'), {
                cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
            });
        }
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, relevance_score: 0.8 }] }), text: async () => '' };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
        const results = await reranker.rerank('find auth', ['alpha document']);
        assert.equal(calls.length, 2);
        assert.equal(results[0].relevanceScore, 0.8);
    });
});

test('VoyageAIReranker does not retry other network failures', async () => {
    const calls: string[] = [];
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => {
            calls.push('call');
            throw Object.assign(new TypeError('fetch failed'), {
                cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.voyageai.com'), { code: 'ENOTFOUND' }),
            });
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError);
                    assert.equal(error.kind, 'network');
                    assert.equal(error.status, null);
                    assert.equal(error.attempts, 1);
                    return true;
                },
            );
        });
    });
    assert.equal(calls.length, 1);
});

test('VoyageAIReranker does not retry an invalid successful response', async () => {
    const calls: string[] = [];
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => {
            calls.push('call');
            return { ok: true, status: 200, json: async () => ({ data: 'not-an-array' }), text: async () => '' };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError);
                    assert.equal(error.kind, 'invalid_response');
                    assert.equal(error.status, 200);
                    assert.equal(error.attempts, 1);
                    return true;
                },
            );
        });
    });
    assert.equal(calls.length, 1);
});

test('VoyageAIReranker classifies malformed successful JSON as a terminal invalid response', async () => {
    let calls = 0;
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => {
            calls += 1;
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => '',
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{ malformed json'));
                        controller.close();
                    },
                }),
            };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError);
                    assert.equal(error.kind, 'invalid_response');
                    assert.equal(error.status, 200);
                    assert.equal(error.attempts, 1);
                    return true;
                },
            );
        });
    });
    assert.equal(calls, 1);
});

test('VoyageAIReranker rejects immediately when the caller pre-aborted the signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await withMockedFetch(async () => {
        throw new Error('fetch must not be called for a pre-aborted request');
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
        await assert.rejects(
            () => reranker.rerank('find auth', ['alpha document'], { signal: controller.signal }),
            (error: unknown) => {
                assert.equal((error as { name?: string })?.name, 'AbortError');
                return true;
            },
        );
    });
});

test('VoyageAIReranker aborts a hung request when the caller cancels mid-flight and does not retry', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    await withMutedConsoleError(async () => {
        await withMockedFetch(async (url, init) => {
            calls.push('call');
            return new Promise<never>((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;
                signal?.addEventListener('abort', () => {
                    reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
                });
            });
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0, timeoutMs: 5000 });
            const pending = reranker.rerank('find auth', ['alpha document'], { signal: controller.signal });
            controller.abort();
            await assert.rejects(pending, (error: unknown) => {
                assert.equal((error as { name?: string })?.name, 'AbortError');
                return true;
            });
        });
    });
    assert.equal(calls.length, 1);
});

test('VoyageAIReranker classifies a stalled response body as a timeout, not invalid response', async () => {
    const calls: string[] = [];
    await withMutedConsoleError(async () => {
        await withMockedFetch(async (url, init) => {
            calls.push('call');
            const signal = init?.signal as AbortSignal | undefined;
            return {
                ok: true,
                status: 200,
                json: () => new Promise<never>((_, reject) => {
                    signal?.addEventListener('abort', () => {
                        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
                    });
                }),
                text: async () => '',
            };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0, timeoutMs: 25 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document']),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError);
                    assert.equal(error.kind, 'timeout');
                    assert.equal(error.attempts, 2);
                    return true;
                },
            );
        });
    });
    assert.equal(calls.length, 2);
});

test('VoyageAIReranker retries a connection reset during the response body read', async () => {
    const calls: string[] = [];
    await withMockedFetch(async (_url, _init) => {
        calls.push('call');
        return {
            ok: true,
            status: 200,
            json: async () => {
                if (calls.length === 1) {
                    throw Object.assign(new TypeError('fetch failed'), {
                        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
                    });
                }
                return { data: [{ index: 0, relevance_score: 0.85 }] };
            },
            text: async () => '',
        };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
        const results = await reranker.rerank('find auth', ['alpha document']);
        assert.equal(calls.length, 2);
        assert.equal(results[0].relevanceScore, 0.85);
    });
});

test('VoyageAIReranker reports retry diagnostics when a transient failure is followed by success', async () => {
    const calls: string[] = [];
    const reported: { diagnostics: RerankExecutionDiagnostics | null } = { diagnostics: null };
    await withMockedFetch(async () => {
        calls.push('call');
        if (calls.length === 1) {
            return { ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' };
        }
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, relevance_score: 0.9 }] }), text: async () => '' };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
        await reranker.rerank('find auth', ['alpha document'], {
            onExecutionDiagnostics: (diagnostics) => {
                reported.diagnostics = diagnostics;
            },
        });
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(reported.diagnostics, { attempts: 2, retries: 1, timeouts: 0 });
    assert.ok(reported.diagnostics);
    assert.equal(reported.diagnostics.queueWaitMs, undefined);
    assert.equal(reported.diagnostics.effectiveScoreDeadlineMs, undefined);
    assert.equal(reported.diagnostics.effectiveStageDeadlineMs, undefined);
    assert.equal(reported.diagnostics.observedWallMs, undefined);
    assert.equal(reported.diagnostics.deadlineLatenessMs, undefined);
});

test('VoyageAIReranker reports timeout and retry diagnostics when a timeout is followed by success', async () => {
    const calls: string[] = [];
    const reported: { diagnostics: RerankExecutionDiagnostics | null } = { diagnostics: null };
    await withMockedFetch(async (url, init) => {
        calls.push('call');
        if (calls.length === 1) {
            const signal = init?.signal as AbortSignal | undefined;
            return new Promise<never>((_, reject) => {
                signal?.addEventListener('abort', () => {
                    reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
                });
            });
        }
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, relevance_score: 0.9 }] }), text: async () => '' };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0, timeoutMs: 25 });
        await reranker.rerank('find auth', ['alpha document'], {
            onExecutionDiagnostics: (diagnostics) => {
                reported.diagnostics = diagnostics;
            },
        });
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(reported.diagnostics, { attempts: 2, retries: 1, timeouts: 1 });
});

test('VoyageAIReranker terminates immediately when the caller cancels during the retry delay', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const pending = (async () => {
        await withMutedConsoleError(async () => {
            await withMockedFetch(async () => {
                calls.push('call');
                return { ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' };
            }, async () => {
                const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 60_000 });
                await reranker.rerank('find auth', ['alpha document'], { signal: controller.signal });
            });
        });
    })();
    // Let the first attempt fail and enter the retry delay, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
        assert.equal((error as { name?: string })?.name, 'AbortError');
        return true;
    });
    assert.equal(calls.length, 1);
});

test('VoyageAIReranker ignores a throwing diagnostics callback on success', async () => {
    const calls: string[] = [];
    let callbackFires = 0;
    await withMockedFetch(async () => {
        calls.push('call');
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, relevance_score: 0.9 }] }), text: async () => '' };
    }, async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
        const results = await reranker.rerank('find auth', ['alpha document'], {
            onExecutionDiagnostics: () => {
                callbackFires += 1;
                throw new Error('telemetry exploded');
            },
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].relevanceScore, 0.9);
    });
    assert.equal(calls.length, 1);
    assert.equal(callbackFires, 1);
});

test('VoyageAIReranker preserves the real terminal error when the diagnostics callback throws', async () => {
    let callbackFires = 0;
    await withMutedConsoleError(async () => {
        await withMockedFetch(async () => {
            return { ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0 });
            await assert.rejects(
                () => reranker.rerank('find auth', ['alpha document'], {
                    onExecutionDiagnostics: () => {
                        callbackFires += 1;
                        throw new Error('telemetry exploded');
                    },
                }),
                (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError);
                    assert.equal(error.kind, 'permanent_http');
                    assert.equal(error.status, 401);
                    return true;
                },
            );
        });
    });
    assert.equal(callbackFires, 1);
});

test('VoyageAIReranker classifies a stalled HTTP error body as a timeout and retries', async () => {
    const calls: string[] = [];
    let reported: { attempts: number; retries: number; timeouts: number } | null = null;
    await withMutedConsoleError(async () => {
        await withMockedFetch(async (url, init) => {
            calls.push('call');
            if (calls.length === 1) {
                const signal = init?.signal as AbortSignal | undefined;
                return {
                    ok: false,
                    status: 503,
                    json: async () => ({}),
                    text: () => new Promise<never>((_, reject) => {
                        signal?.addEventListener('abort', () => {
                            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
                        });
                    }),
                };
            }
            return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, relevance_score: 0.9 }] }), text: async () => '' };
        }, async () => {
            const reranker = new VoyageAIReranker({ apiKey: 'voyage-test-key', retryDelayMs: 0, timeoutMs: 25 });
            await reranker.rerank('find auth', ['alpha document'], {
                onExecutionDiagnostics: (diagnostics) => {
                    reported = diagnostics;
                },
            });
        });
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(reported, { attempts: 2, retries: 1, timeouts: 1 });
});


for (const status of [200, 503]) {
    test(`VoyageAIReranker bounds and cancels oversized response bodies at HTTP ${status}`, async () => {
        const limit = 8 * 1024 * 1024;
        let calls = 0;
        let pulls = 0;
        let cancelled = false;
        await withMutedConsoleError(async () => {
            await withMockedFetch(async () => {
                calls += 1;
                const first = new Uint8Array(limit).fill(32);
                first.set(new TextEncoder().encode('{"data":[{"index":0,"relevance_score":0.5}]}'));
                const body = new ReadableStream<Uint8Array>({
                    pull(controller) {
                        pulls += 1;
                        if (pulls === 1) controller.enqueue(first);
                        else if (pulls === 2) controller.enqueue(new Uint8Array([32]));
                        else controller.close();
                    },
                    cancel() { cancelled = true; },
                }, { highWaterMark: 0 });
                return new Response(body, { status });
            }, async () => {
                const reranker = new VoyageAIReranker({ apiKey: 'test-key', retryDelayMs: 0 });
                await assert.rejects(reranker.rerank('query', ['document']), (error: unknown) => {
                    assert.ok(error instanceof RerankerRequestError);
                    assert.equal(error.kind, 'invalid_response');
                    assert.match(error.message, /exceeded.*bytes/);
                    assert.equal(error.attempts, 1);
                    assert.equal(cancelled, true, 'body cancellation must complete before rejection');
                    return true;
                });
            });
        });
        assert.equal(calls, 1);
        assert.equal(pulls, 2, 'the oversized tail must not be consumed');
    });
}

test('VoyageAIReranker accepts a response exactly at the byte limit', async () => {
    const json = '{"data":[{"index":0,"relevance_score":0.5}]}';
    await withMockedFetch(async () => new Response(json.padEnd(8 * 1024 * 1024, ' ')), async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'test-key' });
        assert.deepEqual(await reranker.rerank('query', ['document']), [{ index: 0, relevanceScore: 0.5 }]);
    });
});


test('VoyageAIReranker preserves fetch UTF-8 BOM decoding with bounded body reads', async () => {
    await withMockedFetch(async () => new Response('\uFEFF{"data":[{"index":0,"relevance_score":0.5}]}'), async () => {
        const reranker = new VoyageAIReranker({ apiKey: 'test-key' });
        assert.deepEqual(await reranker.rerank('query', ['document']), [{ index: 0, relevanceScore: 0.5 }]);
    });
});
