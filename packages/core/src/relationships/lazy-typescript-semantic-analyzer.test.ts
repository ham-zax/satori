import assert from 'node:assert/strict';
import test from 'node:test';
import type { Worker } from 'node:worker_threads';

import { LazyTypeScriptSemanticProjectAnalyzer } from './lazy-typescript-semantic-analyzer';

test('the TypeScript resolution worker is replaced after it dies', { timeout: 30_000 }, async () => {
    const analyzer = new LazyTypeScriptSemanticProjectAnalyzer();
    try {
        const before = await analyzer.getProviderMetadata('typescript');
        assert.ok(before?.providerId);

        const inner = await (analyzer as unknown as { analyzerPromise: Promise<{ worker?: Worker }> }).analyzerPromise;
        assert.ok(inner.worker, 'expected the worker-backed analyzer');
        await inner.worker.terminate();

        assert.deepEqual(await analyzer.getProviderMetadata('typescript'), before);
    } finally {
        await analyzer.dispose();
    }
});
