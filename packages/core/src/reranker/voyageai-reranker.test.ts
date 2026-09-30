import test from 'node:test';
import assert from 'node:assert/strict';
import { RerankerRequestError, VoyageAIReranker } from './voyageai-reranker';
import type { RerankExecutionDiagnostics } from './reranker';

type MockFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}>;

async function withMockedFetch<T>(mockFetch: MockFetch, fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;
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
