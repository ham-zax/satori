import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExecutionPolicyAllowsRuntime } from '../config.js';

test('connected profile preserves existing provider and backend combinations', () => {
    assert.doesNotThrow(() => assertExecutionPolicyAllowsRuntime({
        executionProfile: 'connected',
        encoderProvider: 'Ollama',
        vectorStoreProvider: 'Milvus',
    }));
});

test('offline profile accepts only Ollama with LanceDB', () => {
    assert.doesNotThrow(() => assertExecutionPolicyAllowsRuntime({
        executionProfile: 'offline',
        encoderProvider: 'Ollama',
        vectorStoreProvider: 'LanceDB',
    }));

    assert.throws(
        () => assertExecutionPolicyAllowsRuntime({
            executionProfile: 'offline',
            encoderProvider: 'VoyageAI',
            vectorStoreProvider: 'LanceDB',
        }),
        /offline requires EMBEDDING_PROVIDER=Ollama/,
    );
    assert.throws(
        () => assertExecutionPolicyAllowsRuntime({
            executionProfile: 'offline',
            encoderProvider: 'Ollama',
            vectorStoreProvider: 'Milvus',
        }),
        /offline requires VECTOR_STORE_PROVIDER=LanceDB/,
    );
});
